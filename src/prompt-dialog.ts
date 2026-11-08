// Krypton — Smart Prompt Dialog
// Global modal (Cmd+Shift+K) that composes a prompt and dispatches it to a
// Claude Code terminal tab (write_to_pty) or, since spec 372, to an ACP Harness
// lane (control op `lane.send`). Supports @path autocomplete (passed through as
// text) and @selection (expanded inline to the xterm selection from the source
// tab before send).
// See docs/0061-smart-prompt-dialog.md and docs/0372-prompt-dialog-harness-lanes.md.

import { invoke } from './profiler/ipc';
import { listen } from '@tauri-apps/api/event';
import { Compositor } from './compositor';
import type {
  ProcessChangedEvent,
  SessionId,
  WindowId,
} from './types';
import {
  harnessEntry,
  listHarnessEntries,
  resolveDisplayName,
  type HarnessEntry,
} from './acp/harness-directory';
import type { HarnessLaneStatus } from './acp/types';
import { getCaretCoordinates } from './caret-position';
import { CARRIAGE_CLEARANCE, Typewriter } from './prompt-dialog-typewriter';
import { applyReadlineKey, type KillBuffer } from './textarea-readline';
import { keyHint, type KeyHint } from './ui/kbd';

const TARGET_PROCESS = 'claude';
const FILE_INDEX_TTL_MS = 10_000;
const MAX_MENTION_RESULTS = 8;

/** Every lane status, so `isLaneStatus` breaks the build when the union grows. */
const LANE_STATUSES: Record<HarnessLaneStatus, true> = {
  starting: true,
  idle: true,
  busy: true,
  needs_permission: true,
  awaiting_peer: true,
  error: true,
  stopped: true,
};

/** Lane statuses where `lane.send` queues the prompt instead of starting a turn. */
const QUEUEING_STATUSES: Partial<Record<HarnessLaneStatus, true>> = {
  busy: true,
  needs_permission: true,
  awaiting_peer: true,
};

interface CaptureResult {
  path: string;
  data: string;
}

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

interface PtyTarget {
  kind: 'pty';
  key: `pty:${SessionId}`;
  sessionId: SessionId;
  windowId: WindowId;
  pid: number;
  cwd: string | null;
}

/** spec 372: one live ACP Harness lane, addressed by its globally unique display name. */
interface LaneTarget {
  kind: 'lane';
  key: `lane:${string}`;
  harnessId: string;
  displayName: string;
  backendId: string;
  status: HarnessLaneStatus;
  cwd: string | null;
  remote: boolean;
  queueDepth: number;
  active: boolean;
}

type DialogTarget = PtyTarget | LaneTarget;

interface DialogImage {
  data: string;
  mimeType: string;
  path: string;
}

interface MentionItem {
  kind: 'file' | 'selection';
  path: string; // 'selection' for the special entry, relative path for files
  indices: number[];
  hint?: string; // right-aligned label (e.g. "12 lines")
}

interface MentionState {
  active: boolean;
  start: number;
  query: string;
  items: MentionItem[];
  selectedIndex: number;
}

// Session-scoped memory — persists across dialog opens within the app run.
let lastUsedTargetKey: string | null = null;

// ─── PromptDialog ─────────────────────────────────────────────────

export class PromptDialog {
  private compositor: Compositor;
  private onClose: () => void;

  private overlay: HTMLElement;
  private panel: HTMLElement;
  private chipEl: HTMLElement;
  private textareaEl: HTMLTextAreaElement;
  private mentionPopupEl: HTMLElement;
  private footerEl: HTMLElement;
  private stagingEl: HTMLElement;
  // spec 373: the draft is a typewriter slip — kicker readouts and the machine.
  private slipNameEl: HTMLElement;
  private slipLinesEl: HTMLElement;
  private typewriter: Typewriter;
  /** ⌃W ⌃U ⌃K fill it, ⌃Y yanks it; it outlives a close, as a shell's does. */
  private readonly killBuffer: KillBuffer = { text: '' };

  private targets: DialogTarget[] = [];
  private selectedTargetIdx = 0;
  // Tab is ignored until open() has listed this open's targets, so it never
  // steps through the previous open's rows.
  private targetsLoaded = false;
  // spec 372: the Harness that held focus when the dialog opened; its active
  // lane is the default target. Frozen like selectionSnapshot.
  private focusedHarnessId: string | null = null;
  // spec 372: why the last lane send failed. Replaces the footer hints until the
  // next input or target change.
  private errorText: string | null = null;
  // Maps temp file path → base64 data URL for thumbnail rendering.
  // Entries are added when images are pasted/dropped and the @path is inserted inline.
  private imageThumbs = new Map<string, string>();
  // Captures queued while the dialog is closed (via global Ctrl+Shift+S shortcut).
  // Drained into imageThumbs when open() is called.
  private captureQueue: Array<{ path: string; dataUrl: string }> = [];
  private mention: MentionState = {
    active: false,
    start: -1,
    query: '',
    items: [],
    selectedIndex: 0,
  };
  private files: string[] = [];
  private visible = false;
  // Selection text captured from the focused terminal pane when the dialog opens.
  // Frozen for the dialog's lifetime so @selection always expands to what the user
  // saw highlighted at the moment they pressed Cmd+Shift+K.
  private selectionSnapshot: string | null = null;

  private processUnlisten: (() => void) | null = null;

  constructor(compositor: Compositor, onClose: () => void) {
    this.compositor = compositor;
    this.onClose = onClose;
    this.overlay = this.buildDom();
    this.panel = this.overlay.querySelector('.krypton-prompt-dialog__panel')!;
    this.chipEl = this.overlay.querySelector('.krypton-prompt-dialog__target-chip')!;
    this.textareaEl = this.overlay.querySelector('.krypton-prompt-dialog__textarea')!;
    this.mentionPopupEl = this.overlay.querySelector('.krypton-prompt-dialog__mention-popup')!;
    this.footerEl = this.overlay.querySelector('.krypton-prompt-dialog__footer')!;
    this.stagingEl = this.overlay.querySelector('.krypton-prompt-dialog__staging')!;
    this.slipNameEl = this.overlay.querySelector('.krypton-prompt-dialog__slip-name')!;
    this.slipLinesEl = this.overlay.querySelector('.krypton-prompt-dialog__slip-lines')!;
    this.typewriter = new Typewriter(
      this.panel,
      this.overlay.querySelector('.krypton-prompt-dialog__slip')!,
      this.textareaEl,
      () => this.compositor.soundEngine.play('terminal.bell'),
    );
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
    this.errorText = null;
    this.imageThumbs.clear();
    // Drain any captures queued while the dialog was closed.
    const queued = this.captureQueue.splice(0, 4);
    if (queued.length > 0) {
      const text = queued.map(item => `@${item.path}`).join(' ') + ' ';
      this.textareaEl.value = text;
      this.textareaEl.setSelectionRange(text.length, text.length);
      for (const item of queued) this.imageThumbs.set(item.path, item.dataUrl);
    }
    this.renderStaging();
    this.mention.active = false;
    this.mentionPopupEl.classList.remove('krypton-prompt-dialog__mention-popup--visible');
    // Capture the terminal selection and the focused Harness NOW, before the
    // dialog's overlay steals any focus and before the user can change them.
    this.selectionSnapshot = this.compositor.getFocusedSelection();
    this.focusedHarnessId = listHarnessEntries().find((entry) => entry.isFocused?.() === true)?.harnessId ?? null;
    this.overlay.classList.add('krypton-prompt-dialog--visible');
    this.typewriter.show();
    this.refitDraft();

    this.targetsLoaded = false;
    await this.refreshTargets();
    this.pickInitialTarget();
    this.targetsLoaded = true;
    this.subscribeToProcessChanges();
    this.renderTargets();
    requestAnimationFrame(() => this.textareaEl.focus());

    if (this.currentTarget()) {
      void this.loadFilesForCurrentTarget();
    }
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.overlay.classList.remove('krypton-prompt-dialog--visible');
    this.mentionPopupEl.classList.remove('krypton-prompt-dialog__mention-popup--visible');
    this.targetsLoaded = false;
    this.selectionSnapshot = null;
    this.typewriter.hide();
    this.focusedHarnessId = null;
    if (this.processUnlisten) {
      this.processUnlisten();
      this.processUnlisten = null;
    }
    this.onClose();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (!this.visible) return false;
    if (this.mention.active) return this.handleMentionKey(e);
    return this.handleTextareaKey(e);
  }

  // ─── Target handling ──────────────────────────────────────────

  /** Re-list targets, keeping the selected one while it is still present. */
  private async refreshTargets(): Promise<void> {
    const prevCwd = new Map<SessionId, string | null>();
    for (const t of this.targets) {
      if (t.kind === 'pty') prevCwd.set(t.sessionId, t.cwd);
    }
    const ptyTargets: PtyTarget[] = this.compositor.findSessionsByProcess(TARGET_PROCESS).map((c) => ({
      kind: 'pty',
      key: `pty:${c.sessionId}`,
      sessionId: c.sessionId,
      windowId: c.windowId,
      pid: c.pid,
      cwd: prevCwd.get(c.sessionId) ?? null,
    }));

    // Resolve PTY CWDs (cached on the target entry) while the Harnesses list lanes.
    const [, laneTargets] = await Promise.all([
      Promise.all(
        ptyTargets.map(async (t) => {
          if (t.cwd !== null) return;
          try {
            t.cwd = await invoke<string | null>('get_pty_cwd', { sessionId: t.sessionId });
          } catch {
            t.cwd = null;
          }
        }),
      ),
      listLaneTargets(),
    ]);

    // Read the selection only now: a Tab during the awaits above moved it.
    const prevKey = this.currentTarget()?.key ?? null;
    this.targets = [...ptyTargets, ...laneTargets];
    const kept = prevKey === null ? -1 : this.targets.findIndex((t) => t.key === prevKey);
    if (kept >= 0) this.selectedTargetIdx = kept;
    else this.pickInitialTarget();
  }

  /** spec 372: the focused Harness's active lane, then the last-used target,
   *  then the first row. */
  private pickInitialTarget(): void {
    if (this.targets.length === 0) {
      this.selectedTargetIdx = -1;
      return;
    }
    const focused = this.focusedHarnessId === null
      ? -1
      : this.targets.findIndex((t) => t.kind === 'lane' && t.active && t.harnessId === this.focusedHarnessId);
    if (focused >= 0) {
      this.selectedTargetIdx = focused;
      return;
    }
    const last = this.targets.findIndex((t) => t.key === lastUsedTargetKey);
    this.selectedTargetIdx = last >= 0 ? last : 0;
  }

  private currentTarget(): DialogTarget | null {
    if (this.selectedTargetIdx < 0 || this.selectedTargetIdx >= this.targets.length) {
      return null;
    }
    return this.targets[this.selectedTargetIdx];
  }

  private renderTargets(): void {
    this.renderChip();
    this.renderFooter();
  }

  /** Tab / ⇧Tab step the chip to the next / previous target, wrapping; the
   *  draft and caret stay. Lane status is not evented to the dialog, so every
   *  step also re-lists the targets. */
  private cycleTarget(delta: 1 | -1): void {
    if (!this.targetsLoaded) return;
    if (this.targets.length > 1) {
      this.selectedTargetIdx =
        (this.selectedTargetIdx + delta + this.targets.length) % this.targets.length;
      this.errorText = null;
      this.renderTargets();
      void this.loadFilesForCurrentTarget();
    }
    void this.refreshTargets().then(() => {
      if (this.visible) this.renderTargets();
    });
  }

  private subscribeToProcessChanges(): void {
    if (this.processUnlisten) return;
    void listen<ProcessChangedEvent>('process-changed', async () => {
      if (!this.visible) return;
      await this.refreshTargets();
      if (this.visible) this.renderTargets();
    }).then((fn) => {
      this.processUnlisten = fn;
    });
  }

  private async loadFilesForCurrentTarget(): Promise<void> {
    const t = this.currentTarget();
    // A remote Harness cwd is a path on another host; indexing it locally would
    // list the wrong files (spec 372).
    if (!t || !t.cwd || (t.kind === 'lane' && t.remote)) {
      this.files = [];
      return;
    }
    const files = await loadFileIndex(t.cwd);
    // A later Tab may have moved on while this index loaded.
    if (this.currentTarget()?.key === t.key) this.files = files;
  }

  // ─── Chip rendering ────────────────────────────────────────────

  /** The plate's head: lamp, target, and its place in the Tab cycle. */
  private renderChip(): void {
    const t = this.currentTarget();
    this.renderKicker();
    this.chipEl.classList.remove(
      'krypton-prompt-dialog__target-chip--empty',
      'krypton-prompt-dialog__target-chip--loading',
    );
    const cycles = this.targets.length > 1;
    this.chipEl.classList.toggle('krypton-prompt-dialog__target-chip--cycles', cycles);
    const position = cycles
      ? `<span class="krypton-prompt-dialog__chip-count">${this.selectedTargetIdx + 1}/${this.targets.length}</span>`
      : '';
    if (!t) {
      this.chipEl.classList.add('krypton-prompt-dialog__target-chip--empty');
      this.chipEl.innerHTML = `
        <span class="krypton-prompt-dialog__chip-warn">⚠</span>
        <span class="krypton-prompt-dialog__chip-label">no target</span>
        <span class="krypton-prompt-dialog__chip-meta">start claude in a tab or open an ACP Harness, then reopen this dialog</span>
      `;
    } else if (t.kind === 'lane') {
      this.chipEl.innerHTML = `
        <span class="krypton-prompt-dialog__chip-arrow">→</span>
        <span class="krypton-prompt-dialog__chip-label">${escapeHtml(t.displayName)}</span>
        <span class="krypton-prompt-dialog__chip-meta">${escapeHtml(t.backendId)}</span>
        <span class="krypton-prompt-dialog__chip-cwd">${escapeHtml(abbreviatePath(t.cwd ?? '…'))}</span>
        <span class="krypton-prompt-dialog__chip-meta">${escapeHtml(laneStatusLabel(t))}</span>
        <span class="krypton-prompt-dialog__chip-spacer"></span>
        ${position}
      `;
    } else {
      const cwd = t.cwd ?? '…';
      if (!t.cwd) this.chipEl.classList.add('krypton-prompt-dialog__target-chip--loading');
      this.chipEl.innerHTML = `
        <span class="krypton-prompt-dialog__chip-arrow">→</span>
        <span class="krypton-prompt-dialog__chip-label">Claude</span>
        <span class="krypton-prompt-dialog__chip-cwd">${escapeHtml(abbreviatePath(cwd))}</span>
        <span class="krypton-prompt-dialog__chip-pid">pid ${t.pid}</span>
        <span class="krypton-prompt-dialog__chip-spacer"></span>
        ${position}
      `;
    }
    this.typewriter.relight();
  }

  private renderFooter(): void {
    const t = this.currentTarget();
    const queues = t?.kind === 'lane' && QUEUEING_STATUSES[t.status] === true;
    // spec 373: the carriage LEDs read the same state the foot prints, and
    // the foot's new print is inked for the lamplight.
    this.typewriter.setLeds({ queue: queues, error: this.errorText !== null });
    this.typewriter.relight();
    if (this.errorText !== null) {
      const error = document.createElement('span');
      error.className = 'krypton-prompt-dialog__error';
      error.textContent = this.errorText;
      this.footerEl.replaceChildren(error);
      return;
    }
    // spec 372: a busy lane queues the prompt; spec 373: ⌘Enter sends, Enter feeds a line.
    const hints: KeyHint[] = t
      ? [{ keys: ['⌘Enter'], label: queues ? 'queue' : 'send' }, { keys: ['Enter'], label: 'newline' }]
      : [];
    if (this.targets.length > 1) hints.push({ keys: ['Tab', '⇧Tab'], label: 'target', keySeparator: '/' });
    hints.push({ keys: ['Esc'], label: 'close' });
    this.footerEl.replaceChildren(...hints.map((hint) => keyHint(hint)));
  }

  // ─── Textarea & mention handling ───────────────────────────────

  private handleTextareaKey(e: KeyboardEvent): boolean {
    // spec 373: ⌘Enter sends; Return and Shift+Return feed a line (the
    // textarea's own newline), as on a typewriter slip.
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
    // Tab / ⇧Tab step the target; the textarea keeps focus. An IME composing
    // text keeps its own Tab.
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      this.cycleTarget(e.shiftKey ? -1 : 1);
      return true;
    }
    return this.handleReadlineKey(e);
  }

  /** The harness composer's bash keys on the textarea. An edit fires the
   *  textarea's `input` event, which plays the sound and moves the carriage;
   *  a caret move does not, so it moves the carriage here. */
  private handleReadlineKey(e: KeyboardEvent): boolean {
    const action = applyReadlineKey(e, this.textareaEl, this.killBuffer);
    if (!action) return false;
    if (action.kind === 'move') {
      this.updateMentionState();
      this.typewriter.sync();
    }
    return true;
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
    // No completion to accept (the popup is hidden): Tab still steps the target.
    if (e.key === 'Tab') return this.handleTextareaKey(e);
    // All other keys: the bash keys, else the textarea's own typing
    return this.handleReadlineKey(e);
  }

  private onInput(e: Event): void {
    this.refitDraft();
    this.updateMentionState();
    if (this.imageThumbs.size > 0) this.renderStaging();
    if (this.errorText !== null) {
      this.errorText = null;
      this.renderFooter();
    }
    this.typeFeedback(e);
  }

  /** spec 373: a typed key strikes the typebar and sounds; Return is a carriage
   *  return; a deletion steps back. Pastes and token inserts only move the
   *  carriage — no strike per pasted character. */
  private typeFeedback(e: Event): void {
    const inputType = e instanceof InputEvent ? e.inputType : '';
    const data = e instanceof InputEvent ? e.data : null;
    const sound = this.compositor.soundEngine;
    if (inputType === 'insertText' && data && data.length <= 2) {
      this.typewriter.strike(this.textareaEl.selectionStart - data.length, data);
      sound.playKeypress('press', data);
      this.typewriter.sync('type');
    } else if (inputType === 'insertLineBreak') {
      sound.playKeypress('press', 'Enter');
      this.typewriter.sync('cr');
    } else if (inputType.startsWith('delete')) {
      sound.playKeypress('press', 'Backspace');
      this.typewriter.sync('back');
    }
  }

  /** The draft changed: fit the sheet to it, update the kicker, move the carriage. */
  private refitDraft(): void {
    const ta = this.textareaEl;
    ta.style.height = 'auto';
    const cs = window.getComputedStyle(ta);
    const lineH = parseFloat(cs.lineHeight);
    const paddingV =
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // spec 373: a sheet of 10 lines that grows to 18, or to what keeps the plate
    // inside 86vh (everything on the plate but the textarea is `chrome`).
    const min = lineH * 10 + paddingV;
    const chrome = this.panel.offsetHeight - ta.offsetHeight;
    const fit = window.innerHeight * 0.86 - chrome;
    const max = Math.max(min, Math.min(lineH * 18 + paddingV, fit));
    const h = Math.max(min, Math.min(max, ta.scrollHeight));
    ta.style.height = `${h}px`;
    this.renderKicker();
    this.typewriter.sync();
  }

  /** Slip kicker: `prompt · <target> · N lines`. */
  private renderKicker(): void {
    const t = this.currentTarget();
    this.slipNameEl.textContent = !t ? 'untitled' : t.kind === 'lane' ? t.displayName : 'claude';
    const lines = this.textareaEl.value.split('\n').length;
    this.slipLinesEl.textContent = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
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
    const items: MentionItem[] = [];

    // Pin @selection at the top when there's a captured selection and the
    // query is empty or fuzzy-matches "selection". Keeps the placeholder
    // discoverable without forcing the user to memorize the magic keyword.
    const selectionItem = this.buildSelectionItem(q);
    if (selectionItem) items.push(selectionItem);

    const remaining = MAX_MENTION_RESULTS - items.length;
    if (q.length === 0) {
      for (const path of this.files.slice(0, remaining)) {
        items.push({ kind: 'file', path, indices: [] });
      }
    } else {
      const ranked: { path: string; score: number; indices: number[] }[] = [];
      for (const path of this.files) {
        const res = fuzzyMatch(q, path);
        if (res) ranked.push({ path, score: res.score, indices: res.matchIndices });
      }
      ranked.sort((a, b) => b.score - a.score);
      for (const r of ranked.slice(0, remaining)) {
        items.push({ kind: 'file', path: r.path, indices: r.indices });
      }
    }

    this.mention.items = items;
  }

  private buildSelectionItem(query: string): MentionItem | null {
    const snap = this.selectionSnapshot;
    if (!snap || snap.length === 0) return null;
    let indices: number[] = [];
    if (query.length > 0) {
      const m = fuzzyMatch(query, 'selection');
      if (!m) return null;
      indices = m.matchIndices;
    }
    const lines = snap.split('\n').length;
    const hint = lines === 1 ? `${snap.length} chars` : `${lines} lines`;
    return { kind: 'selection', path: 'selection', indices, hint };
  }

  private renderMentionPopup(): void {
    if (!this.mention.active || this.mention.items.length === 0) {
      this.mentionPopupEl.classList.remove('krypton-prompt-dialog__mention-popup--visible');
      return;
    }
    this.mentionPopupEl.innerHTML = this.mention.items
      .map((item, i) => {
        const selCls = i === this.mention.selectedIndex ? ' is-selected' : '';
        const kindCls =
          item.kind === 'selection' ? ' krypton-prompt-dialog__mention-row--selection' : '';
        const label = highlightMatches(item.path, item.indices);
        const hint = item.hint
          ? `<span class="krypton-prompt-dialog__mention-hint">${escapeHtml(item.hint)}</span>`
          : '';
        return `<div class="krypton-prompt-dialog__mention-row${kindCls}${selCls}" data-idx="${i}">${label}${hint}</div>`;
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

  /** spec 373 B: the popup opens below the carriage, or above the caret's line
   *  when the screen has no room below, so it never covers the typewriter. */
  private positionMentionPopup(): void {
    const coords = getCaretCoordinates(this.textareaEl, this.mention.start);
    const taRect = this.textareaEl.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    const lineTop = taRect.top - panelRect.top + coords.top;
    const below = lineTop + coords.height + CARRIAGE_CLEARANCE + 4;
    const popupH = this.mentionPopupEl.offsetHeight;
    const fitsBelow = panelRect.top + below + popupH <= window.innerHeight;
    const topOffset = fitsBelow ? below : lineTop - popupH - 4;
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
    this.refitDraft();
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

    // Image @paths are already inline at the cursor positions where the user
    // pasted/dropped them — no reordering needed.
    let prompt = raw;
    if (/(^|\s)@selection\b/.test(prompt)) {
      const sel = this.selectionSnapshot ?? '';
      const block = sel.length > 0 ? '\n```\n' + sel + '\n```\n' : '';
      prompt = prompt.replace(/(^|\s)@selection\b/g, (_m, lead) => `${lead}${block}`);
    }

    if (target.kind === 'lane') {
      await this.submitToLane(target, prompt);
      return;
    }

    // Wrap in bracketed paste so embedded newlines land as a single paste event
    // in Claude's input buffer instead of submitting each line as its own message.
    // Strip any literal end-marker to prevent prompt content from escaping the paste.
    const safe = prompt.replace(/\x1b\[201~/g, '');
    const pasteBytes = Array.from(new TextEncoder().encode(`\x1b[200~${safe}\x1b[201~`));
    const submitBytes = Array.from(new TextEncoder().encode('\r'));
    try {
      // Split paste and submit into two writes with a frame of delay so Ink's
      // stdin reader sees them as separate events — otherwise the `\r` is
      // swallowed as the paste's tail byte and never fires onSubmit.
      await invoke('write_to_pty', { sessionId: target.sessionId, data: pasteBytes });
      await new Promise((r) => setTimeout(r, 30));
      await invoke('write_to_pty', { sessionId: target.sessionId, data: submitBytes });
      lastUsedTargetKey = target.key;
      this.compositor.flashWindow(target.windowId);
      this.close();
    } catch (e) {
      console.error('[PromptDialog] write_to_pty failed:', e);
      this.shakePanel();
    }
  }

  /** spec 372: deliver to a Harness lane through `lane.send`. Images travel as
   *  ACP image blocks, so their `@path` tokens leave the text; the rest of the
   *  text is literal (a leading `@path` is never read as a lane mention). */
  private async submitToLane(target: LaneTarget, prompt: string): Promise<void> {
    const { text, images } = this.extractImages(prompt);
    const resolved = resolveDisplayName(target.displayName);
    const entry = resolved ? harnessEntry(resolved.harnessId) : null;
    try {
      if (!entry?.control) throw new Error(`${target.displayName} is no longer open`);
      await entry.control(
        'lane.send',
        { lane: target.displayName, text, images },
        { source: 'prompt_dialog' },
      );
    } catch (e) {
      this.errorText = e instanceof Error ? e.message : String(e);
      this.shakePanel();
      await this.refreshTargets();
      if (this.visible) this.renderTargets();
      return;
    }
    lastUsedTargetKey = target.key;
    const windowId = this.compositor.findWindowIdForLane(target.displayName);
    if (windowId) this.compositor.flashWindow(windowId);
    this.close();
  }

  /** Staged images whose `@path` token is still in the text, with the tokens removed. */
  private extractImages(prompt: string): { text: string; images: DialogImage[] } {
    let text = prompt;
    const images: DialogImage[] = [];
    for (const [path, dataUrl] of this.imageThumbs) {
      const token = `@${path}`;
      if (!text.includes(token)) continue;
      text = text.split(`${token} `).join('').split(token).join('');
      const parsed = parseBase64DataUrl(dataUrl);
      if (parsed) images.push({ ...parsed, path });
    }
    return { text: text.trim(), images };
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
        <div class="krypton-prompt-dialog__slip">
          <div class="krypton-prompt-dialog__slip-kicker">
            <span>prompt</span>
            <span class="krypton-prompt-dialog__slip-name">untitled</span>
            <span class="krypton-prompt-dialog__slip-lines">1 line</span>
          </div>
          <textarea class="krypton-prompt-dialog__textarea"
                    rows="10"
                    spellcheck="false"
                    placeholder="Type your prompt. Use @path for files, @selection for current terminal selection."></textarea>
        </div>
        <div class="krypton-prompt-dialog__mention-popup"></div>
        <div class="krypton-prompt-dialog__staging"></div>
        <div class="krypton-prompt-dialog__footer"></div>
      </div>
    `;
    return overlay;
  }

  private wireEvents(): void {
    this.textareaEl.addEventListener('input', (e) => this.onInput(e));
    this.textareaEl.addEventListener('click', () => {
      this.updateMentionState();
      this.typewriter.sync('still');
    });
    this.textareaEl.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        this.updateMentionState();
      }
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) {
        this.typewriter.sync();
      }
    });
    this.textareaEl.addEventListener('scroll', () => this.typewriter.sync('still'));
    // Mouse is secondary: a press on the chip steps it like Tab, and the
    // textarea keeps focus and caret.
    this.chipEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.cycleTarget(1);
    });
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // Paste: intercept image clipboard items
    this.panel.addEventListener('paste', (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) this.stageImageFile(file);
          return;
        }
      }
    });

    // Drag-drop images onto the panel
    this.panel.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      this.panel.classList.add('krypton-prompt-dialog__panel--drag-over');
    });
    this.panel.addEventListener('dragleave', () => {
      this.panel.classList.remove('krypton-prompt-dialog__panel--drag-over');
    });
    this.panel.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.panel.classList.remove('krypton-prompt-dialog__panel--drag-over');
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          this.stageImageFile(file);
          break;
        }
      }
    });
  }

  // ─── Image staging ──────────────────────────────────────────────

  private stageImageFile(file: File): void {
    const MAX_IMAGES = 4;
    const MAX_BYTES = 5 * 1024 * 1024;

    if (this.imageThumbs.size >= MAX_IMAGES) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;

      if (base64.length > MAX_BYTES * 1.34) return;

      try {
        const path = await invoke<string>('save_temp_image', {
          data: base64,
          mimeType: file.type,
        });
        this.imageThumbs.set(path, `data:${file.type};base64,${base64}`);
        this.insertAtCursor(`@${path} `);
        this.renderStaging();
        this.refitDraft();
      } catch (e) {
        console.error('[PromptDialog] save_temp_image failed:', e);
      }
    };
    reader.readAsDataURL(file);
  }

  // Called by the global Ctrl+Shift+S shortcut listener in main.ts.
  // If the dialog is open, stages the capture immediately; otherwise queues it.
  async captureAndStage(): Promise<void> {
    try {
      const result = await invoke<CaptureResult | null>('capture_screen');
      if (result === null) return;
      const dataUrl = `data:image/png;base64,${result.data}`;
      if (this.visible) {
        this.stageDiskImage(result.path, dataUrl);
        this.renderStaging();
        this.refitDraft();
      } else if (this.captureQueue.length < 4) {
        this.captureQueue.push({ path: result.path, dataUrl });
      }
    } catch (e) {
      console.error('[PromptDialog] capture_screen failed:', e);
    }
  }

  private stageDiskImage(path: string, dataUrl: string): void {
    if (this.imageThumbs.size >= 4) return;
    this.imageThumbs.set(path, dataUrl);
    this.insertAtCursor(`@${path} `);
  }

  private insertAtCursor(text: string): void {
    const ta = this.textareaEl;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
    const newPos = start + text.length;
    ta.setSelectionRange(newPos, newPos);
    ta.focus();
  }

  private renderStaging(): void {
    // Scan textarea text for image paths that are still referenced
    const text = this.textareaEl.value;
    const active: string[] = [];
    for (const path of this.imageThumbs.keys()) {
      if (text.includes(`@${path}`)) {
        active.push(path);
      }
    }

    if (active.length === 0) {
      this.stagingEl.style.display = 'none';
      this.stagingEl.innerHTML = '';
      return;
    }

    this.stagingEl.style.display = 'flex';
    this.stagingEl.innerHTML = '';

    for (const path of active) {
      const dataUrl = this.imageThumbs.get(path)!;
      const wrap = document.createElement('div');
      wrap.className = 'krypton-prompt-dialog__staged-thumb-wrap';

      const thumb = document.createElement('img');
      thumb.className = 'krypton-prompt-dialog__staged-thumb';
      thumb.src = dataUrl;

      const remove = document.createElement('button');
      remove.className = 'krypton-prompt-dialog__staged-remove';
      remove.textContent = '×';
      remove.addEventListener('click', (e) => {
        e.preventDefault();
        // Remove the @path reference from the textarea text
        this.textareaEl.value = this.textareaEl.value.replace(`@${path} `, '').replace(`@${path}`, '');
        this.imageThumbs.delete(path);
        this.renderStaging();
        this.refitDraft();
        this.textareaEl.focus();
      });

      wrap.appendChild(thumb);
      wrap.appendChild(remove);
      this.stagingEl.appendChild(wrap);
    }
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

function isLaneStatus(value: unknown): value is HarnessLaneStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LANE_STATUSES, value);
}

/** One `lane.list` row as a dialog target; null for a malformed or stopped lane. */
function laneTargetFromRow(row: unknown, entry: HarnessEntry): LaneTarget | null {
  if (typeof row !== 'object' || row === null) return null;
  const displayName = 'displayName' in row ? row.displayName : undefined;
  const status = 'status' in row ? row.status : undefined;
  if (typeof displayName !== 'string' || !isLaneStatus(status) || status === 'stopped') return null;
  return {
    kind: 'lane',
    key: `lane:${displayName}`,
    harnessId: entry.harnessId,
    displayName,
    backendId: 'backendId' in row && typeof row.backendId === 'string' ? row.backendId : '',
    status,
    cwd: entry.cwd,
    remote: 'remote' in row && row.remote === true,
    queueDepth: 'queueDepth' in row && typeof row.queueDepth === 'number' ? row.queueDepth : 0,
    active: 'active' in row && row.active === true,
  };
}

/** spec 372: every non-stopped lane of every live Harness, in registration order. */
async function listLaneTargets(): Promise<LaneTarget[]> {
  const out: LaneTarget[] = [];
  for (const entry of listHarnessEntries()) {
    if (!entry.control) continue;
    let rows: unknown;
    try {
      rows = await entry.control('lane.list', {});
    } catch (e) {
      console.warn('[PromptDialog] lane.list failed:', e);
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const target = laneTargetFromRow(row, entry);
      if (target) out.push(target);
    }
  }
  return out;
}

/** `idle`, `needs permission · queue 2 · remote`. */
function laneStatusLabel(t: LaneTarget): string {
  const parts = [t.status.replace(/_/g, ' ')];
  if (t.queueDepth > 0) parts.push(`queue ${t.queueDepth}`);
  if (t.remote) parts.push('remote');
  return parts.join(' · ');
}

function parseBase64DataUrl(url: string): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  return match ? { mimeType: match[1], data: match[2] } : null;
}
