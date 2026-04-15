// Krypton — Smart Prompt Dialog
// Global modal (Cmd+Shift+K) that composes a prompt and dispatches it to
// the active Claude Code tab via write_to_pty. Supports @path autocomplete
// (passed through for Claude to expand) and @selection (expanded inline to
// the xterm selection from the source tab before send).
// See docs/61-smart-prompt-dialog.md for the full spec.

import { invoke } from './profiler/ipc';
import { listen } from '@tauri-apps/api/event';
import { Compositor } from './compositor';
import type {
  ProcessCandidate,
  ProcessChangedEvent,
  SessionId,
  WindowId,
} from './types';
import { getCaretCoordinates } from './caret-position';

const TARGET_PROCESS = 'claude';
const FILE_INDEX_TTL_MS = 10_000;
const MAX_MENTION_RESULTS = 8;

// ─── Fuzzy match (adapted from command-palette.ts) ────────────────

interface FuzzyResult {
  score: number;
  matchIndices: number[];
}

function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const ql = query.toLowerCase();
  const tl = target.toLowerCase();
  if (ql.length === 0) return { score: 0, matchIndices: [] };
  if (ql.length > tl.length) return null;

  const matchIndices: number[] = [];
  let qi = 0;
  let score = 0;
  let lastIdx = -2;

  for (let ti = 0; ti < tl.length && qi < ql.length; ti++) {
    if (tl[ti] === ql[qi]) {
      matchIndices.push(ti);
      if (ti === lastIdx + 1) score += 10;
      if (ti === 0 || /[\s_\-/.]/.test(target[ti - 1])) score += 8;
      score += Math.max(0, 5 - ti);
      if (target[ti] === query[qi]) score += 1;
      lastIdx = ti;
      qi++;
    }
  }
  if (qi < ql.length) return null;
  return { score, matchIndices };
}

function highlightMatches(text: string, indices: number[]): string {
  const set = new Set(indices);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    out += set.has(i) ? `<span class="hl">${ch}</span>` : ch;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── File index cache ─────────────────────────────────────────────

interface CachedIndex {
  files: string[];
  fetchedAt: number;
}

const fileIndexCache = new Map<string, CachedIndex>();

async function loadFileIndex(cwd: string): Promise<string[]> {
  const cached = fileIndexCache.get(cwd);
  if (cached && Date.now() - cached.fetchedAt < FILE_INDEX_TTL_MS) {
    return cached.files;
  }
  try {
    const files = await invoke<string[]>('search_files', { root: cwd, showHidden: false });
    fileIndexCache.set(cwd, { files, fetchedAt: Date.now() });
    return files;
  } catch (e) {
    console.error('[PromptDialog] search_files failed:', e);
    return [];
  }
}

// ─── Dialog types ─────────────────────────────────────────────────

interface TargetEntry extends ProcessCandidate {
  cwd: string | null;
}

interface MentionState {
  active: boolean;
  start: number;
  query: string;
  items: { path: string; indices: number[] }[];
  selectedIndex: number;
}

// Session-scoped memory — persists across dialog opens within the app run.
let lastUsedSessionId: SessionId | null = null;

// ─── PromptDialog ─────────────────────────────────────────────────

export class PromptDialog {
  private compositor: Compositor;
  private onClose: () => void;

  private overlay: HTMLElement;
  private panel: HTMLElement;
  private chipEl: HTMLElement;
  private pickerEl: HTMLElement;
  private textareaEl: HTMLTextAreaElement;
  private mentionPopupEl: HTMLElement;
  private footerEl: HTMLElement;

  private targets: TargetEntry[] = [];
  private selectedTargetIdx = 0;
  private pickerOpen = false;
  private mention: MentionState = {
    active: false,
    start: -1,
    query: '',
    items: [],
    selectedIndex: 0,
  };
  private files: string[] = [];
  private visible = false;

  private processUnlisten: (() => void) | null = null;

  constructor(compositor: Compositor, onClose: () => void) {
    this.compositor = compositor;
    this.onClose = onClose;
    this.overlay = this.buildDom();
    this.panel = this.overlay.querySelector('.krypton-prompt-dialog__panel')!;
    this.chipEl = this.overlay.querySelector('.krypton-prompt-dialog__target-chip')!;
    this.pickerEl = this.overlay.querySelector('.krypton-prompt-dialog__picker')!;
    this.textareaEl = this.overlay.querySelector('.krypton-prompt-dialog__textarea')!;
    this.mentionPopupEl = this.overlay.querySelector('.krypton-prompt-dialog__mention-popup')!;
    this.footerEl = this.overlay.querySelector('.krypton-prompt-dialog__footer')!;
    this.wireEvents();
    document.body.appendChild(this.overlay);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  async open(): Promise<void> {
    if (this.visible) return;
    this.visible = true;
    this.textareaEl.value = '';
    this.mention.active = false;
    this.mentionPopupEl.classList.remove('krypton-prompt-dialog__mention-popup--visible');
    this.overlay.classList.add('krypton-prompt-dialog--visible');

    await this.refreshTargets();
    this.subscribeToProcessChanges();

    if (this.targets.length >= 2) {
      this.openPicker();
    } else {
      this.pickerOpen = false;
      this.renderChip();
      this.renderFooter();
      requestAnimationFrame(() => this.textareaEl.focus());
    }

    if (this.currentTarget()) {
      void this.loadFilesForCurrentTarget();
    }
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.overlay.classList.remove('krypton-prompt-dialog--visible');
    this.mentionPopupEl.classList.remove('krypton-prompt-dialog__mention-popup--visible');
    this.pickerOpen = false;
    if (this.processUnlisten) {
      this.processUnlisten();
      this.processUnlisten = null;
    }
    this.onClose();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (!this.visible) return false;

    // Cmd+, toggles picker in any state
    if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.code === 'Comma') {
      e.preventDefault();
      if (this.pickerOpen) this.closePicker();
      else this.openPicker();
      return true;
    }

    if (this.pickerOpen) return this.handlePickerKey(e);
    if (this.mention.active) return this.handleMentionKey(e);
    return this.handleTextareaKey(e);
  }

  // ─── Target handling ──────────────────────────────────────────

  private async refreshTargets(): Promise<void> {
    const candidates = this.compositor.findSessionsByProcess(TARGET_PROCESS);
    const prevTargets = new Map(this.targets.map((t) => [t.sessionId, t]));
    this.targets = candidates.map((c) => ({
      ...c,
      cwd: prevTargets.get(c.sessionId)?.cwd ?? null,
    }));

    // Resolve CWDs in parallel (cached on the target entry)
    await Promise.all(
      this.targets.map(async (t) => {
        if (t.cwd !== null) return;
        try {
          t.cwd = await invoke<string | null>('get_pty_cwd', { sessionId: t.sessionId });
        } catch {
          t.cwd = null;
        }
      }),
    );

    // Pick initial target
    if (this.targets.length === 0) {
      this.selectedTargetIdx = -1;
    } else {
      const lastIdx = this.targets.findIndex((t) => t.sessionId === lastUsedSessionId);
      this.selectedTargetIdx = lastIdx >= 0 ? lastIdx : 0;
    }
  }

  private currentTarget(): TargetEntry | null {
    if (this.selectedTargetIdx < 0 || this.selectedTargetIdx >= this.targets.length) {
      return null;
    }
    return this.targets[this.selectedTargetIdx];
  }

  private subscribeToProcessChanges(): void {
    if (this.processUnlisten) return;
    void listen<ProcessChangedEvent>('process-changed', async () => {
      if (!this.visible) return;
      const prevTargetId = this.currentTarget()?.sessionId ?? null;
      await this.refreshTargets();
      // Preserve user's explicit target if it's still alive
      if (prevTargetId !== null) {
        const stillThere = this.targets.findIndex((t) => t.sessionId === prevTargetId);
        if (stillThere >= 0) this.selectedTargetIdx = stillThere;
      }
      if (this.pickerOpen) this.renderPicker();
      else this.renderChip();
      this.renderFooter();
    }).then((fn) => {
      this.processUnlisten = fn;
    });
  }

  private async loadFilesForCurrentTarget(): Promise<void> {
    const t = this.currentTarget();
    if (!t || !t.cwd) {
      this.files = [];
      return;
    }
    this.files = await loadFileIndex(t.cwd);
  }

  // ─── Picker ────────────────────────────────────────────────────

  private openPicker(): void {
    this.pickerOpen = true;
    this.chipEl.style.display = 'none';
    this.pickerEl.style.display = '';
    this.renderPicker();
    this.renderFooter();
    this.textareaEl.blur();
  }

  private closePicker(): void {
    this.pickerOpen = false;
    this.pickerEl.style.display = 'none';
    this.chipEl.style.display = '';
    this.renderChip();
    this.renderFooter();
    requestAnimationFrame(() => this.textareaEl.focus());
    // Re-load files in case target changed
    void this.loadFilesForCurrentTarget();
  }

  private renderPicker(): void {
    if (this.targets.length === 0) {
      this.pickerEl.innerHTML = `
        <div class="krypton-prompt-dialog__picker-header">No Claude sessions found</div>
        <div class="krypton-prompt-dialog__picker-empty">
          Start <code>claude</code> in a tab, then reopen this dialog.
        </div>
      `;
      return;
    }
    const header = `<div class="krypton-prompt-dialog__picker-header">Select target Claude session</div>`;
    const rows = this.targets
      .map((t, i) => {
        const isSel = i === this.selectedTargetIdx;
        const isLast = lastUsedSessionId === t.sessionId;
        const cwd = t.cwd ?? '…';
        return `
          <div class="krypton-prompt-dialog__picker-row${isSel ? ' is-selected' : ''}" data-idx="${i}">
            <span class="krypton-prompt-dialog__picker-hotkey">${i < 9 ? i + 1 : ' '}</span>
            <span class="krypton-prompt-dialog__picker-proc">claude</span>
            <span class="krypton-prompt-dialog__picker-cwd">${escapeHtml(abbreviatePath(cwd))}</span>
            <span class="krypton-prompt-dialog__picker-pid">pid ${t.pid}</span>
            ${isLast ? '<span class="krypton-prompt-dialog__picker-last">(last)</span>' : ''}
          </div>
        `;
      })
      .join('');
    this.pickerEl.innerHTML = header + rows;

    this.pickerEl.querySelectorAll<HTMLElement>('.krypton-prompt-dialog__picker-row').forEach((row) => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx ?? '-1', 10);
        if (idx >= 0) {
          this.selectedTargetIdx = idx;
          this.closePicker();
        }
      });
    });
  }

  private handlePickerKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.targets.length === 0) {
        this.close();
      } else {
        this.closePicker();
      }
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.targets.length > 0) this.closePicker();
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.targets.length === 0) return true;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      this.selectedTargetIdx =
        (this.selectedTargetIdx + delta + this.targets.length) % this.targets.length;
      this.renderPicker();
      return true;
    }
    if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      if (idx < this.targets.length) {
        e.preventDefault();
        this.selectedTargetIdx = idx;
        this.closePicker();
        return true;
      }
    }
    return true;
  }

  // ─── Chip rendering ────────────────────────────────────────────

  private renderChip(): void {
    const t = this.currentTarget();
    this.chipEl.classList.remove(
      'krypton-prompt-dialog__target-chip--empty',
      'krypton-prompt-dialog__target-chip--loading',
    );
    if (!t) {
      this.chipEl.classList.add('krypton-prompt-dialog__target-chip--empty');
      this.chipEl.innerHTML = `
        <span class="krypton-prompt-dialog__chip-warn">⚠</span>
        <span class="krypton-prompt-dialog__chip-label">no Claude session</span>
        <span class="krypton-prompt-dialog__chip-spacer"></span>
        <button class="krypton-prompt-dialog__chip-switch" title="Switch target (Cmd+,)">⇅</button>
      `;
    } else {
      const cwd = t.cwd ?? '…';
      if (!t.cwd) this.chipEl.classList.add('krypton-prompt-dialog__target-chip--loading');
      const badge = this.targets.length > 1 ? `<span class="krypton-prompt-dialog__chip-count">${this.targets.length} avail</span>` : '';
      this.chipEl.innerHTML = `
        <span class="krypton-prompt-dialog__chip-arrow">→</span>
        <span class="krypton-prompt-dialog__chip-label">Claude</span>
        <span class="krypton-prompt-dialog__chip-cwd">${escapeHtml(abbreviatePath(cwd))}</span>
        <span class="krypton-prompt-dialog__chip-pid">pid ${t.pid}</span>
        ${badge}
        <span class="krypton-prompt-dialog__chip-spacer"></span>
        <button class="krypton-prompt-dialog__chip-switch" title="Switch target (Cmd+,)">⇅</button>
      `;
    }
    const btn = this.chipEl.querySelector<HTMLButtonElement>('.krypton-prompt-dialog__chip-switch');
    btn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openPicker();
    });
  }

  private renderFooter(): void {
    const t = this.currentTarget();
    if (this.pickerOpen) {
      this.footerEl.innerHTML = `<span>↑↓ nav</span><span>1–9 jump</span><span>⏎ select</span><span>esc close</span>`;
    } else if (!t) {
      this.footerEl.innerHTML = `<span>⌘, switch target</span><span>esc close</span>`;
    } else {
      this.footerEl.innerHTML = `<span>⏎ send</span><span>⇧⏎ newline</span><span>⌘, switch target</span><span>esc close</span>`;
    }
  }

  // ─── Textarea & mention handling ───────────────────────────────

  private handleTextareaKey(e: KeyboardEvent): boolean {
    // Cmd+Enter: force-submit regardless of mention popup
    if (e.metaKey && e.key === 'Enter') {
      e.preventDefault();
      void this.submit();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.submit();
      return true;
    }
    // Let textarea handle all other keys (including Shift+Enter for newline)
    return false;
  }

  private handleMentionKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeMention();
      return true;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.mention.items.length > 0) {
        this.mention.selectedIndex =
          (this.mention.selectedIndex + 1) % this.mention.items.length;
        this.renderMentionPopup();
      }
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.mention.items.length > 0) {
        this.mention.selectedIndex =
          (this.mention.selectedIndex - 1 + this.mention.items.length) %
          this.mention.items.length;
        this.renderMentionPopup();
      }
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && this.mention.items.length > 0) {
      e.preventDefault();
      this.acceptMention();
      return true;
    }
    // All other keys fall through to the textarea for typing
    return false;
  }

  private onInput(): void {
    this.autoGrow();
    this.updateMentionState();
  }

  private autoGrow(): void {
    const ta = this.textareaEl;
    ta.style.height = 'auto';
    const cs = window.getComputedStyle(ta);
    const lineH = parseFloat(cs.lineHeight);
    const paddingV =
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const min = lineH * 3 + paddingV;
    const max = lineH * 12 + paddingV;
    const h = Math.max(min, Math.min(max, ta.scrollHeight));
    ta.style.height = `${h}px`;
  }

  private updateMentionState(): void {
    const ta = this.textareaEl;
    const caret = ta.selectionStart;
    const value = ta.value;

    // Walk backward from caret to find an unbroken token starting with '@'
    // that is either at start-of-string or preceded by whitespace.
    let atIdx = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === '@') {
        const prev = i === 0 ? ' ' : value[i - 1];
        if (/\s/.test(prev) || i === 0) atIdx = i;
        break;
      }
      if (/\s/.test(ch)) break;
    }

    if (atIdx < 0) {
      if (this.mention.active) this.closeMention();
      return;
    }

    const query = value.substring(atIdx + 1, caret);
    this.mention.active = true;
    this.mention.start = atIdx;
    this.mention.query = query;
    this.rankFiles();
    this.mention.selectedIndex = 0;
    this.renderMentionPopup();
    this.positionMentionPopup();
  }

  private rankFiles(): void {
    const q = this.mention.query;
    if (q.length === 0) {
      this.mention.items = this.files
        .slice(0, MAX_MENTION_RESULTS)
        .map((path) => ({ path, indices: [] }));
      return;
    }
    const ranked: { path: string; score: number; indices: number[] }[] = [];
    for (const path of this.files) {
      const res = fuzzyMatch(q, path);
      if (res) ranked.push({ path, score: res.score, indices: res.matchIndices });
    }
    ranked.sort((a, b) => b.score - a.score);
    this.mention.items = ranked
      .slice(0, MAX_MENTION_RESULTS)
      .map(({ path, indices }) => ({ path, indices }));
  }

  private renderMentionPopup(): void {
    if (!this.mention.active || this.mention.items.length === 0) {
      this.mentionPopupEl.classList.remove('krypton-prompt-dialog__mention-popup--visible');
      return;
    }
    this.mentionPopupEl.innerHTML = this.mention.items
      .map((item, i) => {
        const cls = i === this.mention.selectedIndex ? ' is-selected' : '';
        return `<div class="krypton-prompt-dialog__mention-row${cls}" data-idx="${i}">${highlightMatches(item.path, item.indices)}</div>`;
      })
      .join('');
    this.mentionPopupEl.classList.add('krypton-prompt-dialog__mention-popup--visible');
    this.mentionPopupEl.querySelectorAll<HTMLElement>('.krypton-prompt-dialog__mention-row').forEach((row) => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = parseInt(row.dataset.idx ?? '-1', 10);
        if (idx >= 0) {
          this.mention.selectedIndex = idx;
          this.acceptMention();
        }
      });
    });
  }

  private positionMentionPopup(): void {
    const coords = getCaretCoordinates(this.textareaEl, this.mention.start);
    const taRect = this.textareaEl.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    const topOffset = taRect.top - panelRect.top + coords.top + coords.height + 4;
    const leftOffset = taRect.left - panelRect.left + coords.left;
    this.mentionPopupEl.style.top = `${topOffset}px`;
    this.mentionPopupEl.style.left = `${leftOffset}px`;
  }

  private acceptMention(): void {
    if (!this.mention.active || this.mention.items.length === 0) return;
    const item = this.mention.items[this.mention.selectedIndex];
    const ta = this.textareaEl;
    const caret = ta.selectionStart;
    const before = ta.value.substring(0, this.mention.start);
    const after = ta.value.substring(caret);
    const insert = `@${item.path} `;
    ta.value = before + insert + after;
    const newCaret = before.length + insert.length;
    ta.setSelectionRange(newCaret, newCaret);
    this.closeMention();
    this.autoGrow();
  }

  private closeMention(): void {
    this.mention.active = false;
    this.mention.items = [];
    this.mentionPopupEl.classList.remove('krypton-prompt-dialog__mention-popup--visible');
  }

  // ─── Submit ────────────────────────────────────────────────────

  private async submit(): Promise<void> {
    const target = this.currentTarget();
    if (!target) {
      this.shakePanel();
      return;
    }
    const raw = this.textareaEl.value;
    if (raw.trim().length === 0) {
      this.shakePanel();
      return;
    }

    // Expand @selection inline (snapshot of the source pane's xterm selection)
    let prompt = raw;
    if (/(^|\s)@selection\b/.test(prompt)) {
      const sel = this.compositor.getFocusedSelection() ?? '';
      const block = sel.length > 0 ? '\n```\n' + sel + '\n```\n' : '';
      prompt = prompt.replace(/(^|\s)@selection\b/g, (_m, lead) => `${lead}${block}`);
    }

    const bytes = Array.from(new TextEncoder().encode(prompt + '\r'));
    try {
      await invoke('write_to_pty', { sessionId: target.sessionId, data: bytes });
      lastUsedSessionId = target.sessionId;
      this.compositor.flashWindow(target.windowId as WindowId);
      this.close();
    } catch (e) {
      console.error('[PromptDialog] write_to_pty failed:', e);
      this.shakePanel();
    }
  }

  private shakePanel(): void {
    this.panel.classList.remove('krypton-prompt-dialog__panel--shake');
    void this.panel.offsetWidth;
    this.panel.classList.add('krypton-prompt-dialog__panel--shake');
    window.setTimeout(() => {
      this.panel.classList.remove('krypton-prompt-dialog__panel--shake');
    }, 400);
  }

  // ─── DOM construction ──────────────────────────────────────────

  private buildDom(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'krypton-prompt-dialog';
    overlay.innerHTML = `
      <div class="krypton-prompt-dialog__panel">
        <div class="krypton-prompt-dialog__target-chip"></div>
        <div class="krypton-prompt-dialog__picker" style="display: none"></div>
        <textarea class="krypton-prompt-dialog__textarea"
                  rows="3"
                  spellcheck="false"
                  placeholder="Type your prompt. Use @path for files, @selection for current terminal selection."></textarea>
        <div class="krypton-prompt-dialog__mention-popup"></div>
        <div class="krypton-prompt-dialog__footer"></div>
      </div>
    `;
    return overlay;
  }

  private wireEvents(): void {
    this.textareaEl.addEventListener('input', () => this.onInput());
    this.textareaEl.addEventListener('click', () => this.updateMentionState());
    this.textareaEl.addEventListener('keyup', (e) => {
      // Arrow keys move the caret — re-evaluate mention state
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        this.updateMentionState();
      }
    });
    this.overlay.addEventListener('mousedown', (e) => {
      // Click outside the panel closes the dialog
      if (e.target === this.overlay) {
        this.close();
      }
    });
  }
}

// ─── Utilities ────────────────────────────────────────────────────

function abbreviatePath(p: string): string {
  const home = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  let s = p;
  if (home) s = '~' + p.slice(home[1].length);
  if (s.length > 48) s = '…' + s.slice(s.length - 45);
  return s;
}
