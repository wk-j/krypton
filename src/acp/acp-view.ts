// Krypton — ACP Agent View.
// ContentView that drives an external ACP agent subprocess (Claude Code, Gemini CLI).
// Standalone — does NOT share code with src/agent/agent-view.ts on purpose.

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { invoke } from '../profiler/ipc';
import { AcpClient } from './client';
import type {
  AcpEvent,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  UsageInfo,
} from './types';
import type { ContentView, PaneContentType, QuickSearchHit, QuickSearchResponse } from '../types';

// ─── Fuzzy file search (@ mention) ─────────────────────────────────

const MAX_MENTION_RESULTS = 8;
const FILE_INDEX_TTL_MS = 10_000;

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

function highlightMentionMatches(text: string, indices: number[]): string {
  const set = new Set(indices);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = esc(text[i]);
    out += set.has(i) ? `<span class="acp-view__mention-hl">${ch}</span>` : ch;
  }
  return out;
}

interface CachedFileIndex {
  files: string[];
  fetchedAt: number;
}

const fileIndexCache = new Map<string, CachedFileIndex>();

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
    console.error('[AcpView] search_files failed:', e);
    return [];
  }
}

const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface ToolBlock {
  el: HTMLElement;
  call: ToolCall;
  diffString: string | null;
  diffPath: string | null;
}

interface PermissionBlock {
  el: HTMLElement;
  requestId: number;
  options: PermissionOption[];
}

interface StagedImage {
  data: string;
  mimeType: string;
}

const MAX_STAGED_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class AcpView implements ContentView {
  readonly type: PaneContentType = 'acp';
  readonly element: HTMLElement;

  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;
  private inputDisplayEl!: HTMLElement;
  private statusLineEl!: HTMLElement;
  private stagingAreaEl!: HTMLElement;
  private stagedImages: StagedImage[] = [];

  private backendId: string;
  private displayName: string;
  private projectDir: string | null = null;

  private client: AcpClient | null = null;
  private spawning = true;
  private turnActive = false;
  private inputText = '';
  private cursorPos = 0;
  private supportsImages = false;
  private usage: UsageInfo | null = null;
  private sessionId: string | null = null;

  private currentAssistant: { container: HTMLElement; rendered: HTMLElement; raw: string } | null = null;
  private currentThought: { container: HTMLElement; rendered: HTMLElement; raw: string } | null = null;
  private toolBlocks = new Map<string, ToolBlock>();
  private permissionBlocks = new Map<number, PermissionBlock>();
  private focusedPermissionId: number | null = null;
  private focusedToolId: string | null = null;

  private rafQueued = false;

  // @-mention fuzzy file search state
  private mentionPopupEl!: HTMLElement;
  private mention: {
    active: boolean;
    start: number;
    query: string;
    items: { path: string; indices: number[] }[];
    selectedIndex: number;
  } = { active: false, start: -1, query: '', items: [], selectedIndex: 0 };
  private mentionFiles: string[] = [];

  private openDiffCb: ((unifiedDiff: string, title: string) => void) | null = null;
  private closeCb: (() => void) | null = null;

  constructor(backendId: string, displayName: string, projectDir: string | null = null) {
    this.backendId = backendId;
    this.displayName = displayName;
    this.projectDir = projectDir;
    this.element = document.createElement('div');
    this.element.className = 'acp-view';
    this.element.tabIndex = 0;
    this.buildDOM();

    this.start().catch((e) => {
      this.appendSystemMessage(`Failed to start ${this.displayName}: ${e}`);
      this.spawning = false;
      this.updateStatus();
    });
  }

  setProjectDir(dir: string | null): void {
    this.projectDir = dir;
    if (dir) {
      void this.refreshMentionFiles();
    } else {
      this.mentionFiles = [];
    }
    if (!this.spawning) this.updateStatus();
  }

  getWorkingDirectory(): string | null {
    return this.projectDir;
  }

  onOpenDiff(cb: (unifiedDiff: string, title: string) => void): void {
    this.openDiffCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  // ─── DOM ────────────────────────────────────────────────────────

  private buildDOM(): void {
    const header = document.createElement('div');
    header.className = 'acp-view__header';
    header.innerHTML = `<span class="acp-view__brand">[ ACP // ${esc(this.displayName)} ]</span>`;
    this.element.appendChild(header);

    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'acp-view__messages';
    this.element.appendChild(this.messagesEl);

    this.statusLineEl = document.createElement('div');
    this.statusLineEl.className = 'acp-view__status';
    this.element.appendChild(this.statusLineEl);

    this.mentionPopupEl = document.createElement('div');
    this.mentionPopupEl.className = 'acp-view__mention-popup';
    this.element.appendChild(this.mentionPopupEl);

    this.stagingAreaEl = document.createElement('div');
    this.stagingAreaEl.className = 'acp-view__staging';
    this.stagingAreaEl.style.display = 'none';
    this.element.appendChild(this.stagingAreaEl);

    this.element.addEventListener('paste', (e: ClipboardEvent) => {
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
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        this.insertAtCursor(text);
      }
    });

    this.element.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const hasFile = Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file');
      if (!hasFile) return;
      e.preventDefault();
      this.element.classList.add('acp-view--drag-over');
    });
    this.element.addEventListener('dragleave', (e: DragEvent) => {
      if (e.target === this.element) this.element.classList.remove('acp-view--drag-over');
    });
    this.element.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.element.classList.remove('acp-view--drag-over');
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          this.stageImageFile(file);
          break;
        }
      }
    });

    this.inputRowEl = document.createElement('div');
    this.inputRowEl.className = 'acp-view__input-row';
    const prompt = document.createElement('span');
    prompt.className = 'acp-view__prompt';
    prompt.textContent = '›';
    this.inputDisplayEl = document.createElement('span');
    this.inputDisplayEl.className = 'acp-view__input';
    this.inputDisplayEl.innerHTML = '<span class="acp-view__caret">█</span>';
    this.inputRowEl.appendChild(prompt);
    this.inputRowEl.appendChild(this.inputDisplayEl);
    this.element.appendChild(this.inputRowEl);

    this.updateStatus();
  }

  private updateStatus(): void {
    this.element.classList.toggle('acp-view--loading', this.spawning);
    if (this.spawning) {
      this.statusLineEl.innerHTML =
        `<span class="acp-view__spinner" aria-hidden="true"></span>` +
        `starting ${esc(this.displayName)}<span class="acp-view__dots"><span>.</span><span>.</span><span>.</span></span>`;
      return;
    }
    const stateClass = this.turnActive ? 'acp-view__state--active' : 'acp-view__state--idle';
    const stateGlyph = this.turnActive ? '●' : '○';
    const stateLabel = this.turnActive ? 'streaming' : 'ready';
    const segments: string[] = [];
    segments.push(
      `<span class="acp-view__state ${stateClass}">${stateGlyph} ${esc(stateLabel)}</span>`,
    );
    segments.push(`<span class="acp-view__session-agent">${esc(this.displayName)}</span>`);
    if (this.projectDir) {
      segments.push(
        `<span class="acp-view__session-cwd" title="${esc(this.projectDir)}">${esc(abbreviatePath(this.projectDir))}</span>`,
      );
    }
    if (this.sessionId) {
      segments.push(
        `<span class="acp-view__session-id" title="${esc(this.sessionId)}">#${esc(shortSessionId(this.sessionId))}</span>`,
      );
    }
    const hint = this.turnActive ? 'Ctrl+C to cancel' : 'Enter to send';
    segments.push(`<span class="acp-view__status-hint">${esc(hint)}</span>`);
    const usageHtml = this.renderUsage();
    this.statusLineEl.innerHTML =
      `<span class="acp-view__status-left">${segments.join('<span class="acp-view__status-sep">·</span>')}</span>${usageHtml}`;
  }

  private renderUsage(): string {
    const u = this.usage;
    if (!u) return '';
    const parts: string[] = [];
    if (typeof u.used === 'number') {
      const usedStr = formatTokens(u.used);
      if (typeof u.size === 'number' && u.size > 0) {
        const pct = Math.min(100, Math.round((u.used / u.size) * 100));
        const cls = pct >= 80 ? ' acp-view__usage--high' : pct >= 50 ? ' acp-view__usage--mid' : '';
        parts.push(
          `<span class="acp-view__usage-tokens${cls}">${usedStr} / ${formatTokens(u.size)} · ${pct}%</span>`,
        );
      } else {
        parts.push(`<span class="acp-view__usage-tokens">${usedStr}</span>`);
      }
    } else if (typeof u.inputTokens === 'number' || typeof u.outputTokens === 'number') {
      const i = u.inputTokens ?? 0;
      const o = u.outputTokens ?? 0;
      parts.push(`<span class="acp-view__usage-tokens">↑${formatTokens(i)} ↓${formatTokens(o)}</span>`);
    }
    if (u.cost && typeof u.cost.amount === 'number') {
      parts.push(`<span class="acp-view__usage-cost">${formatCost(u.cost.amount, u.cost.currency)}</span>`);
    }
    if (parts.length === 0) return '';
    return `<span class="acp-view__usage">${parts.join(' · ')}</span>`;
  }

  private appendSystemMessage(text: string): void {
    const el = document.createElement('div');
    el.className = 'acp-view__msg acp-view__msg--system';
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private appendUserMessage(text: string, images: StagedImage[] = []): void {
    const el = document.createElement('div');
    el.className = 'acp-view__msg acp-view__msg--user';
    const label = document.createElement('div');
    label.className = 'acp-view__msg-label';
    label.textContent = 'you';
    el.appendChild(label);
    if (images.length > 0) {
      const thumbs = document.createElement('div');
      thumbs.className = 'acp-view__msg-thumbs';
      for (const img of images) {
        const t = document.createElement('img');
        t.className = 'acp-view__msg-thumb';
        t.src = `data:${img.mimeType};base64,${img.data}`;
        thumbs.appendChild(t);
      }
      el.appendChild(thumbs);
    }
    if (text) {
      const body = document.createElement('div');
      body.className = 'acp-view__msg-body';
      body.textContent = text;
      el.appendChild(body);
    }
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  // ─── Image staging ──────────────────────────────────────────────

  private stageImageFile(file: File): void {
    if (this.stagedImages.length >= MAX_STAGED_IMAGES) {
      this.appendSystemMessage(`max ${MAX_STAGED_IMAGES} images per message.`);
      return;
    }
    if (!this.supportsImages) {
      this.appendSystemMessage(`${this.displayName} did not advertise image support; sending anyway.`);
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      if (base64.length > MAX_IMAGE_BYTES * 1.34) {
        this.appendSystemMessage('image too large (max 5MB).');
        return;
      }
      this.stagedImages.push({ data: base64, mimeType: file.type });
      this.renderStagingArea();
    };
    reader.readAsDataURL(file);
  }

  private renderStagingArea(): void {
    if (this.stagedImages.length === 0) {
      this.stagingAreaEl.style.display = 'none';
      this.stagingAreaEl.innerHTML = '';
      return;
    }
    this.stagingAreaEl.style.display = 'flex';
    this.stagingAreaEl.innerHTML = '';
    for (const img of this.stagedImages) {
      const thumb = document.createElement('img');
      thumb.className = 'acp-view__staged-thumb';
      thumb.src = `data:${img.mimeType};base64,${img.data}`;
      this.stagingAreaEl.appendChild(thumb);
    }
    const hint = document.createElement('span');
    hint.className = 'acp-view__staging-hint';
    hint.textContent = `${this.stagedImages.length} image${this.stagedImages.length === 1 ? '' : 's'} · Esc to clear`;
    this.stagingAreaEl.appendChild(hint);
  }

  private clearStagedImages(): void {
    if (this.stagedImages.length === 0) return;
    this.stagedImages = [];
    this.renderStagingArea();
  }

  private ensureAssistantBlock(): { rendered: HTMLElement } {
    if (this.currentAssistant) return this.currentAssistant;
    const container = document.createElement('div');
    container.className = 'acp-view__msg acp-view__msg--assistant';
    const label = document.createElement('div');
    label.className = 'acp-view__msg-label';
    label.textContent = this.displayName;
    const body = document.createElement('div');
    body.className = 'acp-view__msg-body acp-view__msg-body--markdown';
    container.appendChild(label);
    container.appendChild(body);
    this.messagesEl.appendChild(container);
    this.currentAssistant = { container, rendered: body, raw: '' };
    return this.currentAssistant;
  }

  private ensureThoughtBlock(): { rendered: HTMLElement } {
    if (this.currentThought) return this.currentThought;
    const container = document.createElement('div');
    container.className = 'acp-view__msg acp-view__msg--thought';
    const label = document.createElement('div');
    label.className = 'acp-view__msg-label';
    label.textContent = '· thinking ·';
    const body = document.createElement('div');
    body.className = 'acp-view__msg-body acp-view__msg-body--thought';
    container.appendChild(label);
    container.appendChild(body);
    this.messagesEl.appendChild(container);
    this.currentThought = { container, rendered: body, raw: '' };
    return this.currentThought;
  }

  private flushMarkdown(streaming = true): void {
    if (this.currentAssistant) {
      try {
        this.currentAssistant.rendered.innerHTML = md.parse(this.currentAssistant.raw, { async: false }) as string;
      } catch {
        this.currentAssistant.rendered.textContent = this.currentAssistant.raw;
      }
      if (streaming) this.appendInlineCursor(this.currentAssistant.rendered);
    }
    if (this.currentThought) {
      this.currentThought.rendered.textContent = this.currentThought.raw;
      if (streaming) this.appendInlineCursor(this.currentThought.rendered);
    }
    this.scrollToBottom();
  }

  /** Place a blinking cursor inline at the end of the last text node. */
  private appendInlineCursor(container: HTMLElement): void {
    const cursor = document.createElement('span');
    cursor.className = 'acp-view__stream-cursor';
    cursor.textContent = '▋';
    let target: Node = container;
    while (target.lastChild) {
      const last = target.lastChild;
      if (last.nodeType === Node.TEXT_NODE && !last.textContent?.trim()) {
        if (last.previousSibling) {
          target = last.previousSibling;
          continue;
        }
        break;
      }
      target = last;
    }
    if (target.nodeType === Node.TEXT_NODE && target.parentNode) {
      target.parentNode.insertBefore(cursor, target.nextSibling);
    } else if (target instanceof HTMLElement) {
      target.appendChild(cursor);
    } else {
      container.appendChild(cursor);
    }
  }

  private scheduleFlush(): void {
    if (this.rafQueued) return;
    this.rafQueued = true;
    requestAnimationFrame(() => {
      this.rafQueued = false;
      this.flushMarkdown();
    });
  }

  private isAtBottom(): boolean {
    const el = this.messagesEl;
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 24;
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private sealStreamingBlocks(): void {
    if (this.currentAssistant || this.currentThought) this.flushMarkdown(false);
    this.currentAssistant = null;
    this.currentThought = null;
  }

  // ─── Tool calls ──────────────────────────────────────────────────

  private renderToolBlock(call: ToolCall, isUpdate: boolean): void {
    const id = call.toolCallId;
    if (!id) return;
    let entry = this.toolBlocks.get(id);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'acp-view__tool';
      el.tabIndex = -1;
      const callId = id;
      el.dataset.acpToolId = callId;
      el.addEventListener('click', () => {
        this.focusedToolId = this.focusedToolId === callId ? null : callId;
        this.focusedPermissionId = null;
        this.repaintFocus();
      });
      this.messagesEl.appendChild(el);
      entry = { el, call, diffString: null, diffPath: null };
      this.toolBlocks.set(id, entry);
    } else {
      entry.call = mergeToolCall(entry.call, call) as ToolCall;
    }
    // Extract diff if present.
    const diff = extractDiff(entry.call.content);
    if (diff) {
      entry.diffString = unifiedDiff(diff.path, diff.oldText ?? '', diff.newText ?? '');
      entry.diffPath = diff.path;
    }
    const wasAtBottom = this.isAtBottom();
    this.paintToolBlock(entry);
    if (!isUpdate || wasAtBottom) this.scrollToBottom();
  }

  private paintToolBlock(entry: ToolBlock): void {
    const c = entry.call;
    const kind = c.kind ?? 'other';
    const status = c.status ?? 'pending';
    const title = c.title ?? kind;
    const focused = this.focusedToolId === c.toolCallId;
    const diff = extractDiff(c.content);
    let summary: string;
    if (diff) {
      const counts = countDiff(diff.oldText ?? '', diff.newText ?? '');
      summary = `<span class="acp-view__tool-kind">edit</span> ${esc(diff.path)} <span class="acp-view__tool-counts"><span class="acp-view__tool-add">+${counts.added}</span> <span class="acp-view__tool-del">−${counts.removed}</span></span>`;
    } else {
      summary = `<span class="acp-view__tool-kind">${esc(kind)}</span> ${esc(title)}`;
    }
    entry.el.className = `acp-view__tool acp-view__tool--${status}${focused ? ' acp-view__tool--focused' : ''}`;
    const statusGlyph = status === 'completed' ? '✓' : status === 'failed' ? '✗' : status === 'in_progress' ? '⟳' : '·';
    const body = renderToolBody(c.content, diff);
    entry.el.innerHTML =
      `<div class="acp-view__tool-header">` +
        `<span class="acp-view__tool-status">${statusGlyph}</span>` +
        `<span class="acp-view__tool-summary">${summary}</span>` +
        (entry.diffString ? '<span class="acp-view__tool-hint">[o] open</span>' : '') +
      `</div>` +
      body;
  }

  private repaintFocus(): void {
    for (const [, t] of this.toolBlocks) this.paintToolBlock(t);
    for (const [, p] of this.permissionBlocks) {
      p.el.classList.toggle('acp-view__perm--focused', this.focusedPermissionId === p.requestId);
    }
    const focusedEl =
      (this.focusedToolId && this.toolBlocks.get(this.focusedToolId)?.el) ||
      (this.focusedPermissionId !== null && this.permissionBlocks.get(this.focusedPermissionId)?.el) ||
      null;
    if (focusedEl) focusedEl.scrollIntoView({ block: 'nearest' });
  }

  private navigableItems(): Array<{ kind: 'tool' | 'perm'; id: string | number }> {
    const els = this.messagesEl.querySelectorAll<HTMLElement>('.acp-view__tool, .acp-view__perm');
    const out: Array<{ kind: 'tool' | 'perm'; id: string | number }> = [];
    els.forEach((el) => {
      if (el.dataset.acpToolId) out.push({ kind: 'tool', id: el.dataset.acpToolId });
      else if (el.dataset.acpPermId) out.push({ kind: 'perm', id: Number(el.dataset.acpPermId) });
    });
    return out;
  }

  private moveFocus(delta: number): void {
    const items = this.navigableItems();
    if (items.length === 0) return;
    let idx = items.findIndex((it) =>
      it.kind === 'tool' ? it.id === this.focusedToolId : it.id === this.focusedPermissionId,
    );
    if (idx === -1) idx = delta > 0 ? -1 : items.length;
    const next = items[Math.max(0, Math.min(items.length - 1, idx + delta))];
    if (next.kind === 'tool') {
      this.focusedToolId = next.id as string;
      this.focusedPermissionId = null;
    } else {
      this.focusedPermissionId = next.id as number;
      this.focusedToolId = null;
    }
    this.repaintFocus();
  }

  // ─── Plans ───────────────────────────────────────────────────────

  private renderPlan(entries: PlanEntry[]): void {
    let plan = this.element.querySelector('.acp-view__plan') as HTMLElement | null;
    if (!plan) {
      plan = document.createElement('div');
      plan.className = 'acp-view__plan';
      this.messagesEl.appendChild(plan);
    }
    const lines = entries
      .map((e) => {
        const box = e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]';
        return `<div class="acp-view__plan-row">${box} ${esc(e.content)}</div>`;
      })
      .join('');
    plan.innerHTML = `<div class="acp-view__plan-title">// plan</div>${lines}`;
    this.scrollToBottom();
  }

  // ─── Permission prompt ──────────────────────────────────────────

  private renderPermissionRequest(requestId: number, toolCall: ToolCall, options: PermissionOption[]): void {
    const el = document.createElement('div');
    el.className = 'acp-view__perm';
    const kind = toolCall.kind ?? 'tool';
    const target =
      toolCall.locations?.[0]?.path ?? toolCall.title ?? '';
    const optsHtml = options
      .map((opt) => {
        const key = keyForPermissionKind(opt.kind);
        return `<span class="acp-view__perm-opt"><kbd>${key}</kbd> ${esc(opt.name)}</span>`;
      })
      .join(' ');
    el.dataset.acpPermId = String(requestId);
    el.innerHTML = `
      <div class="acp-view__perm-title">⏵ permission: ${esc(kind)}  ${esc(target)}</div>
      <div class="acp-view__perm-opts">${optsHtml}<span class="acp-view__perm-opt"><kbd>Esc</kbd> cancel</span></div>
    `;
    this.messagesEl.appendChild(el);
    this.permissionBlocks.set(requestId, { el, requestId, options });
    this.focusedPermissionId = requestId;
    this.focusedToolId = null;
    this.repaintFocus();
    this.scrollToBottom();
  }

  private async resolvePermission(requestId: number, optionId: string | null): Promise<void> {
    const block = this.permissionBlocks.get(requestId);
    if (!block) return;
    this.permissionBlocks.delete(requestId);
    if (this.focusedPermissionId === requestId) this.focusedPermissionId = null;
    const label = optionId ? block.options.find((o) => o.optionId === optionId)?.name ?? optionId : 'cancelled';
    block.el.classList.add('acp-view__perm--resolved');
    block.el.innerHTML = `<div class="acp-view__perm-title">⏵ ${esc(label)}</div>`;
    if (this.client) {
      try {
        await this.client.respondPermission(requestId, optionId);
      } catch (e) {
        this.appendSystemMessage(`permission reply failed: ${e}`);
      }
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  private async start(): Promise<void> {
    this.client = await AcpClient.spawn(this.backendId, this.projectDir);
    this.client.onEvent((e) => this.onAcpEvent(e));
    try {
      const info = await this.client.initialize();
      this.supportsImages = !!info.agent_capabilities?.promptCapabilities?.image;
      this.sessionId = info.session_id ?? null;
    } catch (e) {
      this.appendSystemMessage(`initialize failed: ${e}`);
      this.spawning = false;
      this.updateStatus();
      return;
    }
    this.spawning = false;
    this.updateStatus();
    this.appendSystemMessage(`connected to ${this.displayName}.`);
  }

  private onAcpEvent(e: AcpEvent): void {
    switch (e.type) {
      case 'message_chunk': {
        if (this.currentThought) {
          this.currentThought.rendered.querySelector('.acp-view__stream-cursor')?.remove();
          this.currentThought = null;
        }
        this.ensureAssistantBlock();
        this.currentAssistant!.raw += e.text;
        this.scheduleFlush();
        break;
      }
      case 'thought_chunk': {
        if (this.currentAssistant) {
          this.currentAssistant.rendered.querySelector('.acp-view__stream-cursor')?.remove();
          this.currentAssistant = null;
        }
        this.ensureThoughtBlock();
        this.currentThought!.raw += e.text;
        this.scheduleFlush();
        break;
      }
      case 'tool_call':
        this.sealStreamingBlocks();
        this.renderToolBlock(e.call, false);
        break;
      case 'tool_call_update':
        this.renderToolBlock(e.update as ToolCall, true);
        break;
      case 'plan':
        this.sealStreamingBlocks();
        this.renderPlan(e.entries);
        break;
      case 'permission_request':
        this.sealStreamingBlocks();
        this.renderPermissionRequest(e.requestId, e.toolCall, e.options);
        break;
      case 'usage':
        this.usage = mergeUsage(this.usage, e.usage);
        this.updateStatus();
        break;
      case 'stop':
        this.turnActive = false;
        this.currentAssistant = null;
        this.currentThought = null;
        this.updateStatus();
        if (e.stopReason !== 'end_turn') {
          this.appendSystemMessage(`turn ended: ${e.stopReason}`);
        }
        break;
      case 'error':
        this.appendSystemMessage(`error: ${e.message}`);
        this.turnActive = false;
        this.updateStatus();
        break;
    }
  }

  // ─── Input handling ──────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    // Ctrl+P / Ctrl+N — walk focusable items (tool calls + permission prompts).
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'p' || e.key === 'n')) {
      e.preventDefault();
      this.moveFocus(e.key === 'n' ? 1 : -1);
      return true;
    }

    // Escape — dismiss mention popup first, then clear item focus,
    // then clear staged images.
    if (e.key === 'Escape') {
      if (this.mention.active) {
        e.preventDefault();
        this.hideMention();
        return true;
      }
      if (this.focusedToolId !== null && this.focusedPermissionId === null) {
        e.preventDefault();
        this.focusedToolId = null;
        this.repaintFocus();
        return true;
      }
      if (this.stagedImages.length > 0) {
        e.preventDefault();
        this.clearStagedImages();
        return true;
      }
    }

    // Cmd+W / Ctrl+W — close this ACP tab.
    // Handled before the input buffer swallows printable keys.
    if (e.key === 'w' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.closeCb?.();
      return true;
    }

    // Permission prompt focused: single-key resolution.
    if (this.focusedPermissionId !== null) {
      const block = this.permissionBlocks.get(this.focusedPermissionId);
      if (block) {
        if (e.key === 'Escape') {
          e.preventDefault();
          void this.resolvePermission(block.requestId, null);
          return true;
        }
        const optId = pickPermissionOption(block.options, e.key);
        if (optId) {
          e.preventDefault();
          void this.resolvePermission(block.requestId, optId);
          return true;
        }
      }
    }

    // Cancel turn / clear input. Image staging clears via Esc.
    if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (this.turnActive && this.client) {
        void this.client.cancel();
      } else if (this.inputText) {
        this.setInput('', 0);
      }
      return true;
    }

    // Cmd+V / Ctrl+V — don't consume; let the native paste event on
    // this.element fire (handled in buildDOM). The paste event exposes
    // clipboardData.items including images, with no permission prompt.
    if (e.key === 'v' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      return false;
    }

    // Tool block: open diff via 'o' or 'Enter'.
    if (this.focusedToolId !== null && (e.key === 'o' || e.key === 'Enter')) {
      const t = this.toolBlocks.get(this.focusedToolId);
      if (t?.diffString && this.openDiffCb) {
        e.preventDefault();
        this.openDiffCb(t.diffString, `diff: ${t.diffPath ?? this.focusedToolId}`);
        return true;
      }
    }

    // Mention popup — Tab/Shift+Tab and arrow keys navigate; Tab/Enter accept.
    if (this.mention.active && this.mention.items.length > 0) {
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          this.mention.selectedIndex =
            (this.mention.selectedIndex - 1 + this.mention.items.length) % this.mention.items.length;
          this.renderMentionPopup();
        } else {
          this.acceptMention();
        }
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.mention.selectedIndex =
          (this.mention.selectedIndex - 1 + this.mention.items.length) % this.mention.items.length;
        this.renderMentionPopup();
        return true;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.mention.selectedIndex = (this.mention.selectedIndex + 1) % this.mention.items.length;
        this.renderMentionPopup();
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.acceptMention();
        return true;
      }
    }

    // Submit.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = this.inputText.trim();
      const hasImages = this.stagedImages.length > 0;
      if ((text || hasImages) && !this.spawning && !this.turnActive) {
        const images = this.stagedImages.slice();
        this.setInput('', 0);
        this.clearStagedImages();
        this.appendUserMessage(text, images);
        this.sendPrompt(text, images);
      }
      return true;
    }

    // Readline-style editing.
    if (this.handleEditingKey(e)) return true;

    // Printable insertion.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.insertAtCursor(e.key);
      return true;
    }
    return false;
  }

  private handleEditingKey(e: KeyboardEvent): boolean {
    const len = this.inputText.length;
    const pos = this.cursorPos;
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;
    const cmdOnly = e.metaKey && !e.ctrlKey && !e.altKey;
    const noMod = !e.ctrlKey && !e.metaKey && !e.altKey;

    // Cursor movement.
    if (e.key === 'ArrowLeft' && noMod) { e.preventDefault(); this.setCursor(pos - 1); return true; }
    if (e.key === 'ArrowRight' && noMod) { e.preventDefault(); this.setCursor(pos + 1); return true; }
    if (e.key === 'Home' || (ctrlOnly && e.key === 'a') || (cmdOnly && e.key === 'ArrowLeft')) {
      e.preventDefault(); this.setCursor(0); return true;
    }
    if (e.key === 'End' || (ctrlOnly && e.key === 'e') || (cmdOnly && e.key === 'ArrowRight')) {
      e.preventDefault(); this.setCursor(len); return true;
    }
    if (ctrlOnly && e.key === 'b') { e.preventDefault(); this.setCursor(pos - 1); return true; }
    if (ctrlOnly && e.key === 'f') { e.preventDefault(); this.setCursor(pos + 1); return true; }

    // Deletion.
    if (e.key === 'Backspace' && noMod) {
      e.preventDefault();
      if (pos > 0) this.setInput(this.inputText.slice(0, pos - 1) + this.inputText.slice(pos), pos - 1);
      return true;
    }
    if (ctrlOnly && e.key === 'h') {
      e.preventDefault();
      if (pos > 0) this.setInput(this.inputText.slice(0, pos - 1) + this.inputText.slice(pos), pos - 1);
      return true;
    }
    if (e.key === 'Delete' && noMod) {
      e.preventDefault();
      if (pos < len) this.setInput(this.inputText.slice(0, pos) + this.inputText.slice(pos + 1), pos);
      return true;
    }
    if (ctrlOnly && e.key === 'd') {
      e.preventDefault();
      if (pos < len) this.setInput(this.inputText.slice(0, pos) + this.inputText.slice(pos + 1), pos);
      return true;
    }
    if (ctrlOnly && e.key === 'u') {
      e.preventDefault();
      this.setInput(this.inputText.slice(pos), 0);
      return true;
    }
    if (ctrlOnly && e.key === 'k') {
      e.preventDefault();
      this.setInput(this.inputText.slice(0, pos), pos);
      return true;
    }
    if (cmdOnly && e.key === 'Backspace') {
      e.preventDefault();
      this.setInput(this.inputText.slice(pos), 0);
      return true;
    }

    // Transpose: swap char before cursor with char at cursor (or last two if at end).
    if (ctrlOnly && e.key === 't') {
      e.preventDefault();
      if (len < 2) return true;
      const t = this.inputText;
      if (pos === 0) return true;
      if (pos === len) {
        this.setInput(t.slice(0, len - 2) + t[len - 1] + t[len - 2], len);
      } else {
        this.setInput(t.slice(0, pos - 1) + t[pos] + t[pos - 1] + t.slice(pos + 1), pos + 1);
      }
      return true;
    }

    return false;
  }

  private insertAtCursor(s: string): void {
    const pos = this.cursorPos;
    this.setInput(this.inputText.slice(0, pos) + s + this.inputText.slice(pos), pos + s.length);
  }

  private setInput(text: string, cursor: number): void {
    this.inputText = text;
    this.cursorPos = Math.max(0, Math.min(cursor, text.length));
    this.renderInput();
  }

  private setCursor(pos: number): void {
    this.cursorPos = Math.max(0, Math.min(pos, this.inputText.length));
    this.renderInput();
  }

  private renderInput(): void {
    const before = this.inputText.slice(0, this.cursorPos);
    const after = this.inputText.slice(this.cursorPos);
    this.inputDisplayEl.innerHTML = `${esc(before)}<span class="acp-view__caret">█</span>${esc(after)}`;
    this.updateMentionState();
  }

  // ─── @ mention — fuzzy file search ──────────────────────────────

  private updateMentionState(): void {
    const text = this.inputText;
    const caret = this.cursorPos;
    let atIdx = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '@') {
        const prev = i === 0 ? ' ' : text[i - 1];
        if (/\s/.test(prev) || i === 0) atIdx = i;
        break;
      }
      if (/\s/.test(ch)) break;
    }

    if (atIdx < 0 || !this.projectDir) {
      this.hideMention();
      return;
    }

    const query = text.substring(atIdx + 1, caret);
    const wasActive = this.mention.active;
    this.mention.active = true;
    this.mention.start = atIdx;
    this.mention.query = query;
    if (!wasActive) this.mention.selectedIndex = 0;

    if (this.mentionFiles.length === 0) {
      void this.refreshMentionFiles();
    }
    this.rankMentionFiles();
    if (this.mention.selectedIndex >= this.mention.items.length) {
      this.mention.selectedIndex = 0;
    }
    this.renderMentionPopup();
  }

  private rankMentionFiles(): void {
    const q = this.mention.query;
    const items: { path: string; indices: number[] }[] = [];
    if (q.length === 0) {
      for (const path of this.mentionFiles.slice(0, MAX_MENTION_RESULTS)) {
        items.push({ path, indices: [] });
      }
    } else {
      const ranked: { path: string; score: number; indices: number[] }[] = [];
      for (const path of this.mentionFiles) {
        const res = fuzzyMatch(q, path);
        if (res) ranked.push({ path, score: res.score, indices: res.matchIndices });
      }
      ranked.sort((a, b) => b.score - a.score);
      for (const r of ranked.slice(0, MAX_MENTION_RESULTS)) {
        items.push({ path: r.path, indices: r.indices });
      }
    }
    this.mention.items = items;
  }

  private renderMentionPopup(): void {
    if (!this.mention.active || this.mention.items.length === 0) {
      this.mentionPopupEl.classList.remove('acp-view__mention-popup--visible');
      this.mentionPopupEl.innerHTML = '';
      return;
    }
    this.mentionPopupEl.innerHTML = '';
    for (let i = 0; i < this.mention.items.length; i++) {
      const item = this.mention.items[i];
      const row = document.createElement('div');
      row.className = 'acp-view__mention-row';
      if (i === this.mention.selectedIndex) row.classList.add('acp-view__mention-row--selected');
      row.innerHTML = highlightMentionMatches(item.path, item.indices);
      this.mentionPopupEl.appendChild(row);
    }
    this.mentionPopupEl.classList.add('acp-view__mention-popup--visible');
  }

  private hideMention(): void {
    if (!this.mention.active && this.mentionPopupEl.innerHTML === '') return;
    this.mention.active = false;
    this.mention.items = [];
    this.mention.selectedIndex = 0;
    this.mentionPopupEl.classList.remove('acp-view__mention-popup--visible');
    this.mentionPopupEl.innerHTML = '';
  }

  private acceptMention(): boolean {
    if (!this.mention.active || this.mention.items.length === 0) return false;
    const item = this.mention.items[this.mention.selectedIndex];
    const before = this.inputText.slice(0, this.mention.start);
    const after = this.inputText.slice(this.cursorPos);
    const insert = `@${item.path} `;
    this.inputText = before + insert + after;
    this.cursorPos = before.length + insert.length;
    this.hideMention();
    this.renderInput();
    return true;
  }

  private async refreshMentionFiles(): Promise<void> {
    if (!this.projectDir) return;
    this.mentionFiles = await loadFileIndex(this.projectDir);
    if (this.mention.active) {
      this.rankMentionFiles();
      this.renderMentionPopup();
    }
  }

  private async sendPrompt(text: string, images: StagedImage[] = []): Promise<void> {
    if (!this.client) return;
    this.turnActive = true;
    this.updateStatus();
    const blocks: ContentBlock[] = [];
    for (const img of images) {
      blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    }
    if (text) blocks.push({ type: 'text', text });
    try {
      await this.client.prompt(blocks);
    } catch (e) {
      this.appendSystemMessage(`prompt failed: ${e}`);
      this.turnActive = false;
      this.updateStatus();
    }
  }

  onResize(_w: number, _h: number): void {
    this.scrollToBottom();
  }

  dispose(): void {
    if (this.client) {
      void this.client.dispose();
      this.client = null;
    }
    this.toolBlocks.clear();
    this.permissionBlocks.clear();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function mergeToolCall(prev: ToolCall, next: ToolCall | ToolCallUpdate): ToolCall {
  return {
    ...prev,
    ...next,
    content: next.content ?? prev.content,
    locations: next.locations ?? prev.locations,
  };
}

function extractDiff(content: ToolCallContent[] | undefined): { path: string; oldText: string | null; newText: string } | null {
  if (!content) return null;
  for (const c of content) {
    if (c.type === 'diff' && typeof c.path === 'string') {
      return { path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? '' };
    }
  }
  return null;
}

function countDiff(oldText: string, newText: string): { added: number; removed: number } {
  const oldLines = oldText ? oldText.split('\n').length : 0;
  const newLines = newText ? newText.split('\n').length : 0;
  return { added: Math.max(0, newLines - oldLines), removed: Math.max(0, oldLines - newLines) };
}

function unifiedDiff(path: string, oldText: string, newText: string): string {
  // Minimal unified diff envelope; the diff viewer handles parsing.
  return `--- a/${path}\n+++ b/${path}\n${diffBody(oldText, newText)}`;
}

function diffBody(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out: string[] = [`@@ -1,${oldLines.length} +1,${newLines.length} @@`];
  for (const l of oldLines) out.push('-' + l);
  for (const l of newLines) out.push('+' + l);
  return out.join('\n');
}

const TOOL_BODY_LINE_CAP = 16;

function renderToolBody(
  content: ToolCallContent[] | undefined,
  diff: { path: string; oldText: string | null; newText: string } | null,
): string {
  if (diff) return renderDiffPreview(diff.oldText ?? '', diff.newText ?? '');
  if (!content || content.length === 0) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === 'content' && c.content) {
      const text = contentBlockText(c.content);
      if (text) parts.push(renderTextPreview(text));
    } else if (c.type === 'terminal' && c.terminalId) {
      parts.push(`<div class="acp-view__tool-meta">terminal · ${esc(c.terminalId)}</div>`);
    }
  }
  return parts.join('');
}

function contentBlockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource' && block.resource.text) return block.resource.text;
  if (block.type === 'resource_link') return block.uri;
  return '';
}

function renderTextPreview(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  const visible = lines.slice(0, TOOL_BODY_LINE_CAP);
  const hidden = lines.length - visible.length;
  const more = hidden > 0 ? `\n<span class="acp-view__tool-more">… ${hidden} more line${hidden === 1 ? '' : 's'}</span>` : '';
  return `<pre class="acp-view__tool-body">${esc(visible.join('\n'))}${more}</pre>`;
}

function renderDiffPreview(oldText: string, newText: string): string {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const rows: string[] = [];
  let budget = TOOL_BODY_LINE_CAP;
  for (const l of oldLines) {
    if (budget-- <= 0) break;
    rows.push(`<span class="acp-view__diff-line acp-view__diff-line--del">−${esc(l)}</span>`);
  }
  for (const l of newLines) {
    if (budget-- <= 0) break;
    rows.push(`<span class="acp-view__diff-line acp-view__diff-line--add">+${esc(l)}</span>`);
  }
  const total = oldLines.length + newLines.length;
  const shown = rows.length;
  const more = total > shown ? `<span class="acp-view__tool-more">… ${total - shown} more line${total - shown === 1 ? '' : 's'} · [o] open</span>` : '';
  return `<pre class="acp-view__tool-body acp-view__tool-body--diff">${rows.join('\n')}${more ? '\n' + more : ''}</pre>`;
}

function keyForPermissionKind(kind: PermissionOption['kind']): string {
  switch (kind) {
    case 'allow_once': return 'a';
    case 'allow_always': return 'A';
    case 'reject_once': return 'r';
    case 'reject_always': return 'R';
  }
}

function pickPermissionOption(options: PermissionOption[], key: string): string | null {
  const match = options.find((o) => keyForPermissionKind(o.kind) === key);
  return match?.optionId ?? null;
}

function abbreviatePath(fullPath: string): string {
  let p = fullPath;
  const homeMatch = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (homeMatch) p = '~' + p.slice(homeMatch[1].length);
  const MAX = 32;
  if (p.length <= MAX) return p;
  const parts = p.split('/');
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join('/');
    return tail.length <= MAX - 4 ? `…/${tail}` : `…/${parts[parts.length - 1]}`;
  }
  return '…' + p.slice(p.length - MAX + 1);
}

function shortSessionId(id: string): string {
  const trimmed = id.replace(/^sess(ion)?[-_]?/i, '');
  return trimmed.length > 8 ? trimmed.slice(-8) : trimmed;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(amount: number, currency: string): string {
  const sym = currency === 'USD' ? '$' : `${currency} `;
  if (amount < 0.01) return `${sym}${amount.toFixed(4)}`;
  return `${sym}${amount.toFixed(2)}`;
}

function mergeUsage(prev: UsageInfo | null, next: UsageInfo): UsageInfo {
  if (!prev) return next;
  return {
    used: next.used ?? prev.used,
    size: next.size ?? prev.size,
    cost: next.cost ?? prev.cost,
    inputTokens: next.inputTokens ?? prev.inputTokens,
    outputTokens: next.outputTokens ?? prev.outputTokens,
    cachedReadTokens: next.cachedReadTokens ?? prev.cachedReadTokens,
    cachedWriteTokens: next.cachedWriteTokens ?? prev.cachedWriteTokens,
  };
}
