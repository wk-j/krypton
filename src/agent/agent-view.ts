// Krypton — AI Agent View
// ContentView implementation that renders a keyboard-driven coding agent panel.
// Uses manual input handling (no contenteditable) for full keyboard control.

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { AgentController, type AgentEventType, type ImageContent } from './agent';
import type { ContentView, PaneContentType } from '../types';
import { invoke } from '../profiler/ipc';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const MAX_MENTION_RESULTS = 8;
const FILE_INDEX_TTL_MS = 10_000;

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
    const ch = escHtml(text[i]);
    out += set.has(i) ? `<span class="agent-view__mention-hl">${ch}</span>` : ch;
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
    console.error('[AgentView] search_files failed:', e);
    return [];
  }
}

function truncateArgs(args: string, maxLen = 120): string {
  if (args.length <= maxLen) return args;
  return args.slice(0, maxLen) + '…';
}

// Shared markdown renderer with syntax highlighting
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

export class AgentView implements ContentView {
  readonly type: PaneContentType = 'agent';
  readonly element: HTMLElement;

  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;
  private promptGlyphEl!: HTMLElement;
  private inputDisplayEl!: HTMLElement;
  private stateHintEl!: HTMLElement;
  private statusLineEl!: HTMLElement;
  private logoEl!: HTMLElement;

  private state: 'input' | 'scroll' = 'input';
  private inputText = '';
  private cursorPos = 0;
  private promptHistory: string[] = [];
  private historyIdx = -1;

  private controller: AgentController;

  // Current streaming elements
  private currentAssistantTextEl: HTMLElement | null = null;
  private currentAssistantBuffer = '';
  private currentToolRowEl: HTMLElement | null = null;

  // Spinner & timer
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private promptStartTime = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  // Streaming render throttle
  private streamRenderRaf: ReturnType<typeof requestAnimationFrame> | null = null;

  // Project scoping
  private projectDir: string | null = null;

  // Close callback registered by compositor (called when user presses q)
  private closeCallback: (() => void) | null = null;

  // Context window callback (compositor opens a dedicated ContextView)
  private contextCallback: ((controller: AgentController) => void) | null = null;

  // Diff view callback (compositor opens DiffContentView in new tab)
  private diffCallback: ((diff: string, title: string) => void) | null = null;

  // Autocomplete state (slash commands)
  private autocompleteEl!: HTMLElement;
  private acMatches: string[] = [];
  private acSelectedIdx = -1;

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

  // Scroll position preservation across tab switches
  private savedScrollTop = 0;
  private pendingScrollToBottom = false;

  // Staged images (pending attachment for next submit)
  private stagedImages: ImageContent[] = [];
  private stagingAreaEl!: HTMLElement;

  // Message virtualization — collapse off-screen messages to reduce DOM complexity
  private virtualObserver: IntersectionObserver | null = null;
  private collapsedMessages = new Map<HTMLElement, { html: string; height: number }>();

  constructor() {
    this.controller = new AgentController();

    this.element = document.createElement('div');
    this.element.className = 'agent-view';
    this.element.tabIndex = 0;

    this.buildDom();
  }

  private buildDom(): void {
    // Messages area
    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'agent-view__messages';

    // State hint (scroll mode indicator)
    this.stateHintEl = document.createElement('div');
    this.stateHintEl.className = 'agent-view__state-hint';
    this.stateHintEl.textContent = 'SCROLL  g/G top/bot  j/k lines  y yank  c context  i insert';

    // Input row
    this.inputRowEl = document.createElement('div');
    this.inputRowEl.className = 'agent-view__input-row';

    this.promptGlyphEl = document.createElement('span');
    this.promptGlyphEl.className = 'agent-view__prompt-glyph';
    this.promptGlyphEl.textContent = '❯';

    this.inputDisplayEl = document.createElement('div');
    this.inputDisplayEl.className = 'agent-view__input-display';

    this.autocompleteEl = document.createElement('div');
    this.autocompleteEl.className = 'agent-view__autocomplete';

    this.mentionPopupEl = document.createElement('div');
    this.mentionPopupEl.className = 'agent-view__mention-popup';

    // Status line (token usage)
    this.statusLineEl = document.createElement('div');
    this.statusLineEl.className = 'agent-view__status-line';

    // Staging area (hidden until images are staged)
    this.stagingAreaEl = document.createElement('div');
    this.stagingAreaEl.className = 'agent-view__staging';
    this.stagingAreaEl.style.display = 'none';

    this.inputRowEl.appendChild(this.promptGlyphEl);
    this.inputRowEl.appendChild(this.inputDisplayEl);

    // Handle paste from native macOS Edit menu (Cmd+V triggers menu before JS keydown)
    this.element.addEventListener('paste', (e: ClipboardEvent) => {
      e.preventDefault();
      if (this.state !== 'input') return;

      // Check for image items first
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) this.stageImageFile(file);
            return;
          }
        }
      }

      // Fall through to text paste
      const text = e.clipboardData?.getData('text');
      if (text) this.insert(text);
    });

    // Drag-drop image support
    this.element.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      this.element.classList.add('agent-view--drag-over');
    });
    this.element.addEventListener('dragleave', () => {
      this.element.classList.remove('agent-view--drag-over');
    });
    this.element.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.element.classList.remove('agent-view--drag-over');
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          this.stageImageFile(file);
          break; // one image per drop event
        }
      }
    });

    // Track scroll position so it can be restored after tab switch
    this.messagesEl.addEventListener('scroll', () => {
      this.savedScrollTop = this.messagesEl.scrollTop;
    }, { passive: true });

    // Logo header (shown when conversation is empty)
    this.logoEl = document.createElement('div');
    this.logoEl.className = 'agent-view__logo';
    this.logoEl.innerHTML =
      '<div class="agent-view__logo-frame">' +
        '<span class="agent-view__logo-corner agent-view__logo-corner--tl"></span>' +
        '<span class="agent-view__logo-corner agent-view__logo-corner--tr"></span>' +
        '<span class="agent-view__logo-corner agent-view__logo-corner--bl"></span>' +
        '<span class="agent-view__logo-corner agent-view__logo-corner--br"></span>' +
        '<span class="agent-view__logo-ring"></span>' +
        '<span class="agent-view__logo-ring agent-view__logo-ring--inner"></span>' +
        '<div class="agent-view__logo-glyph">⬡</div>' +
      '</div>' +
      '<div class="agent-view__logo-title">KRYPTON <span class="agent-view__logo-accent">AI</span></div>' +
      '<div class="agent-view__logo-rule"><span>cognition online</span></div>' +
      '<div class="agent-view__logo-sub">awaiting directive</div>';

    this.element.appendChild(this.logoEl);
    this.element.appendChild(this.messagesEl);
    this.element.appendChild(this.stateHintEl);
    this.element.appendChild(this.autocompleteEl);
    this.element.appendChild(this.mentionPopupEl);
    this.element.appendChild(this.statusLineEl);
    this.element.appendChild(this.stagingAreaEl);
    this.element.appendChild(this.inputRowEl);

    this.renderInput();
    this.initVirtualization();
  }

  // ─── Message virtualization ─────────────────────────────────────

  /** Set up IntersectionObserver to collapse off-screen messages, reducing DOM weight.
   *  Messages within 800px of the viewport stay expanded; distant ones are replaced
   *  with a fixed-height placeholder to avoid layout shift. */
  private initVirtualization(): void {
    this.virtualObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) {
            // Restore collapsed message
            const saved = this.collapsedMessages.get(el);
            if (saved) {
              el.innerHTML = saved.html;
              el.style.minHeight = '';
              el.classList.remove('agent-view__msg--collapsed');
              this.collapsedMessages.delete(el);
            }
          } else {
            // Collapse off-screen message (only if it has substantial content)
            if (!this.collapsedMessages.has(el) && el.children.length > 0) {
              const height = el.offsetHeight;
              if (height > 0) {
                this.collapsedMessages.set(el, { html: el.innerHTML, height });
                el.innerHTML = '';
                el.style.minHeight = `${height}px`;
                el.classList.add('agent-view__msg--collapsed');
              }
            }
          }
        }
      },
      {
        root: this.messagesEl,
        rootMargin: '800px 0px',  // 800px buffer above/below viewport
      },
    );
  }

  /** Start observing a message element for virtualization */
  private observeMessage(el: HTMLElement): void {
    this.virtualObserver?.observe(el);
  }

  // ─── Image staging ───────────────────────────────────────────────

  private stageImageFile(file: File): void {
    const MAX_IMAGES = 4;
    const MAX_BYTES = 5 * 1024 * 1024; // 5MB

    if (this.stagedImages.length >= MAX_IMAGES) {
      this.showSystemMessage(`Max ${MAX_IMAGES} images per message.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip "data:<mime>;base64," prefix
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;

      if (base64.length > MAX_BYTES * 1.34) { // base64 is ~4/3 of raw size
        this.showSystemMessage('Image too large (max 5MB).');
        return;
      }

      this.stagedImages.push({ type: 'image', data: base64, mimeType: file.type });
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
      thumb.className = 'agent-view__staged-thumb';
      thumb.src = `data:${img.mimeType};base64,${img.data}`;
      this.stagingAreaEl.appendChild(thumb);
    }

    const hint = document.createElement('span');
    hint.className = 'agent-view__staging-hint';
    hint.textContent = 'Ctrl+C to clear';
    this.stagingAreaEl.appendChild(hint);
  }

  // ─── Session ──────────────────────────────────────────────────────

  private async restoreSession(): Promise<void> {
    await this.controller.initSession();
    const entries = await this.controller.restoreFromSession();
    for (const { role, message } of entries) {
      if (role === 'user') {
        const text = typeof message.content === 'string'
          ? message.content
          : this.extractTextFromContent(message.content);
        this.appendUserMessageDom(text);
      } else if (role === 'assistant') {
        const text = this.extractTextFromContent(message.content);
        const el = this.appendAssistantMessageDom();
        el.querySelector('.agent-view__stream-cursor')?.remove();
        try {
          el.innerHTML = md.parse(text) as string;
          el.classList.add('agent-view__msg-body--markdown');
        } catch {
          el.textContent = text;
        }
      } else if (role === 'toolResult') {
        const name = (message.toolName as string) ?? 'tool';
        const isError = Boolean(message.isError);
        const text = this.extractTextFromContent(message.content);
        const row = this.appendToolRowDom(name, '');
        this.finalizeToolRow(row, isError, text);
      }
    }
    if (entries.length > 0) this.scrollToBottom();
  }

  /** Extract plain text from pi-agent-core content blocks (string | Array<{type, text}>). */
  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string')
      .map((b: Record<string, unknown>) => b.text as string)
      .join('');
  }

  // ─── DOM helpers ─────────────────────────────────────────────────

  private appendUserMessageDom(text: string, images?: ImageContent[]): void {
    this.logoEl.classList.add('agent-view__logo--hidden');

    const msg = document.createElement('div');
    msg.className = 'agent-view__msg agent-view__msg--user';

    const label = document.createElement('span');
    label.className = 'agent-view__msg-label';
    label.textContent = 'YOU';

    const body = document.createElement('div');
    body.className = 'agent-view__msg-body';

    // Render image thumbnails before text
    if (images && images.length > 0) {
      const thumbRow = document.createElement('div');
      thumbRow.className = 'agent-view__msg-thumbs';
      for (const img of images) {
        const thumb = document.createElement('img');
        thumb.className = 'agent-view__msg-thumb';
        thumb.src = `data:${img.mimeType};base64,${img.data}`;
        thumbRow.appendChild(thumb);
      }
      body.appendChild(thumbRow);
    }

    if (text) {
      const textEl = document.createElement('div');
      textEl.textContent = text;
      body.appendChild(textEl);
    }

    msg.appendChild(label);
    msg.appendChild(body);
    this.messagesEl.appendChild(msg);
    this.observeMessage(msg);
  }

  private appendAssistantMessageDom(): HTMLElement {
    const msg = document.createElement('div');
    msg.className = 'agent-view__msg agent-view__msg--assistant';

    const label = document.createElement('span');
    label.className = 'agent-view__msg-label';
    label.textContent = 'AI';

    const body = document.createElement('div');
    body.className = 'agent-view__msg-body';

    const cursor = document.createElement('span');
    cursor.className = 'agent-view__stream-cursor';
    cursor.textContent = '▋';

    msg.appendChild(label);
    msg.appendChild(body);
    body.appendChild(cursor);
    this.messagesEl.appendChild(msg);
    this.observeMessage(msg);
    return body;
  }

  /** Final markdown render — remove cursor, cancel pending RAF. */
  private finalizeAssistantMessage(): void {
    if (!this.currentAssistantTextEl) return;
    if (this.streamRenderRaf !== null) {
      cancelAnimationFrame(this.streamRenderRaf);
      this.streamRenderRaf = null;
    }
    if (this.currentAssistantBuffer) {
      try {
        this.currentAssistantTextEl.innerHTML = md.parse(this.currentAssistantBuffer) as string;
      } catch {
        // leave as-is
      }
    }
    this.currentAssistantTextEl.querySelector('.agent-view__stream-cursor')?.remove();
    this.currentAssistantBuffer = '';
    this.currentAssistantTextEl = null;
  }

  private appendToolRowDom(name: string, args: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'agent-view__tool-row';

    // Header line: icon + tool name + brief args
    const header = document.createElement('div');
    header.className = 'agent-view__tool-header';

    const icon = document.createElement('span');
    icon.className = 'agent-view__tool-icon';
    icon.textContent = SPINNER_FRAMES[0];

    const nameEl = document.createElement('span');
    nameEl.className = 'agent-view__tool-name';
    nameEl.textContent = name;

    header.appendChild(icon);
    header.appendChild(nameEl);

    // Extract a human-readable command line for known tools
    const command = this.extractToolCommand(name, args);
    if (command) {
      const cmdEl = document.createElement('div');
      cmdEl.className = 'agent-view__tool-command';
      cmdEl.textContent = command;
      row.appendChild(header);
      row.appendChild(cmdEl);
    } else {
      const argsEl = document.createElement('span');
      argsEl.className = 'agent-view__tool-args';
      argsEl.textContent = truncateArgs(args);
      header.appendChild(argsEl);
      row.appendChild(header);
    }

    this.messagesEl.appendChild(row);
    this.observeMessage(row);
    return row;
  }

  /** Extract a readable command string from tool args for display. */
  private extractToolCommand(name: string, args: string): string | null {
    try {
      const parsed = JSON.parse(args);
      switch (name) {
        case 'bash':
          return parsed.command || null;
        case 'read_file':
          return parsed.path || parsed.file_path || null;
        case 'write_file':
          return parsed.path || parsed.file_path || null;
        case 'edit_file':
          return parsed.path || parsed.file_path || null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private finalizeToolRow(row: HTMLElement, isError: boolean, resultText?: string, diff?: string, filePath?: string): void {
    const icon = row.querySelector('.agent-view__tool-icon');
    if (icon) icon.textContent = isError ? '✗' : '✓';
    row.classList.add(isError ? 'agent-view__tool-row--error' : 'agent-view__tool-row--done');

    if (resultText) {
      const existing = row.querySelector('.agent-view__tool-result');
      if (!existing) {
        const result = document.createElement('div');
        result.className = 'agent-view__tool-result';
        const lines = resultText.split('\n');
        const MAX_LINES = 10;
        if (lines.length > MAX_LINES) {
          result.textContent = lines.slice(0, MAX_LINES).join('\n');
          const more = document.createElement('span');
          more.className = 'agent-view__tool-more';
          more.textContent = ` … ${lines.length - MAX_LINES} more lines`;
          result.appendChild(more);
        } else {
          result.textContent = resultText;
        }
        row.appendChild(result);
      }
    }

    // Render inline diff preview for write_file
    if (diff && filePath) {
      row.dataset.diff = diff;
      row.dataset.filePath = filePath;
      row.classList.add('agent-view__tool-row--has-diff');
      this.renderDiffPreview(row, diff);
    }
  }

  private renderDiffPreview(row: HTMLElement, diff: string): void {
    const preview = document.createElement('div');
    preview.className = 'agent-view__diff-preview';

    const diffLines = diff.split('\n');
    // Collect changed lines (skip unified diff headers)
    const changedLines: { type: 'added' | 'removed' | 'context'; text: string }[] = [];
    let inHunk = false;
    for (const line of diffLines) {
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+')) {
        changedLines.push({ type: 'added', text: line.slice(1) });
      } else if (line.startsWith('-')) {
        changedLines.push({ type: 'removed', text: line.slice(1) });
      } else if (line.startsWith(' ')) {
        changedLines.push({ type: 'context', text: line.slice(1) });
      }
    }

    // Count additions and deletions
    const additions = changedLines.filter((l) => l.type === 'added').length;
    const deletions = changedLines.filter((l) => l.type === 'removed').length;

    if (additions === 0 && deletions === 0) {
      const noChange = document.createElement('div');
      noChange.className = 'agent-view__diff-line agent-view__diff-line--context';
      noChange.textContent = '(no changes)';
      preview.appendChild(noChange);
      row.appendChild(preview);
      return;
    }

    // Show only changed lines (additions + deletions), limited to 8
    const MAX_PREVIEW = 8;
    const significant = changedLines.filter((l) => l.type !== 'context');
    const showing = significant.slice(0, MAX_PREVIEW);

    for (const line of showing) {
      const el = document.createElement('div');
      el.className = `agent-view__diff-line agent-view__diff-line--${line.type}`;
      el.textContent = (line.type === 'added' ? '+' : '-') + line.text;
      preview.appendChild(el);
    }

    // Summary line
    const remaining = significant.length - showing.length;
    const summary = document.createElement('div');
    summary.className = 'agent-view__diff-summary';
    const stats = `+${additions} -${deletions}`;
    if (remaining > 0) {
      summary.textContent = `${stats}  … ${remaining} more lines  Enter → full diff`;
    } else {
      summary.textContent = `${stats}  Enter → full diff`;
    }
    preview.appendChild(summary);

    row.appendChild(preview);
  }

  private appendShellCommandDom(command: string): HTMLElement {
    const msg = document.createElement('div');
    msg.className = 'agent-view__msg agent-view__msg--shell';

    const label = document.createElement('span');
    label.className = 'agent-view__msg-label agent-view__msg-label--shell';
    label.textContent = 'SH';

    const body = document.createElement('div');
    body.className = 'agent-view__msg-body';
    body.textContent = `$ ${command}`;

    msg.appendChild(label);
    msg.appendChild(body);
    this.messagesEl.appendChild(msg);
    return body;
  }

  private appendShellResultDom(output: string, isError: boolean): void {
    const result = document.createElement('div');
    result.className = 'agent-view__shell-result';
    if (isError) result.classList.add('agent-view__shell-result--error');
    
    const lines = output.split('\n');
    const MAX_LINES = 20;
    if (lines.length > MAX_LINES) {
      result.textContent = lines.slice(0, MAX_LINES).join('\n');
      const more = document.createElement('span');
      more.className = 'agent-view__shell-more';
      more.textContent = `\n… ${lines.length - MAX_LINES} more lines`;
      result.appendChild(more);
    } else {
      result.textContent = output || '(no output)';
    }
    
    this.messagesEl.appendChild(result);
    this.scrollToBottom();
  }

  // ─── Input rendering ─────────────────────────────────────────────

  private renderInput(): void {
    const before = escHtml(this.inputText.slice(0, this.cursorPos));
    const after = escHtml(this.inputText.slice(this.cursorPos));
    // Preserve newlines in display
    const toDisplay = (s: string) => s.replace(/\n/g, '<br>');
    this.inputDisplayEl.innerHTML =
      `${toDisplay(before)}<span class="agent-view__input-cursor">▋</span>${toDisplay(after)}`;

    const isBash = this.inputText.startsWith('!');
    this.inputRowEl.classList.toggle('agent-view__input-row--bash', isBash);
    this.promptGlyphEl.textContent = isBash ? '$' : '❯';

    this.updateSuggestions();
  }

  // @-mention takes precedence over slash-command autocomplete; they're
  // mutually exclusive by trigger (slash at BOS vs. @ mid-token) but we
  // enforce the priority here so only one popup shows at a time.
  private updateSuggestions(): void {
    this.updateMentionState();
    if (this.mention.active) {
      this.hideAutocomplete();
      return;
    }
    this.hideMention();
    this.updateAutocomplete();
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
      this.mentionPopupEl.classList.remove('agent-view__mention-popup--visible');
      this.mentionPopupEl.innerHTML = '';
      return;
    }
    this.mentionPopupEl.innerHTML = '';
    for (let i = 0; i < this.mention.items.length; i++) {
      const item = this.mention.items[i];
      const row = document.createElement('div');
      row.className = 'agent-view__mention-row';
      if (i === this.mention.selectedIndex) row.classList.add('agent-view__mention-row--selected');
      row.innerHTML = highlightMatches(item.path, item.indices);
      this.mentionPopupEl.appendChild(row);
    }
    this.mentionPopupEl.classList.add('agent-view__mention-popup--visible');
  }

  private hideMention(): void {
    if (!this.mention.active && this.mentionPopupEl.innerHTML === '') return;
    this.mention.active = false;
    this.mention.items = [];
    this.mention.selectedIndex = 0;
    this.mentionPopupEl.classList.remove('agent-view__mention-popup--visible');
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

  // ─── Autocomplete ───────────────────────────────────────────────

  /** Get all slash commands: built-in + custom commands from .claude/commands/. */
  private getAllCommands(): Record<string, { description: string; usage?: string }> {
    const cmds: Record<string, { description: string; usage?: string }> = { ...AgentView.COMMANDS };
    for (const cmd of this.controller.getCommands()) {
      const key = `/${cmd.name}`;
      if (!cmds[key]) {
        cmds[key] = { description: cmd.description, usage: `/${cmd.name} [args]` };
      }
    }
    return cmds;
  }

  private updateAutocomplete(): void {
    const text = this.inputText.trim();

    // Only show when input starts with / and has no spaces (still typing the command)
    if (!text.startsWith('/') || text.includes(' ')) {
      this.hideAutocomplete();
      return;
    }

    const prefix = text.toLowerCase();
    const allCmds = Object.keys(this.getAllCommands());
    this.acMatches = allCmds.filter((cmd) => cmd.startsWith(prefix) && cmd !== prefix);

    if (this.acMatches.length === 0) {
      this.hideAutocomplete();
      return;
    }

    // Clamp selection
    if (this.acSelectedIdx >= this.acMatches.length) this.acSelectedIdx = this.acMatches.length - 1;
    if (this.acSelectedIdx < 0) this.acSelectedIdx = 0;

    const allCmdInfo = this.getAllCommands();
    this.autocompleteEl.innerHTML = '';
    for (let i = 0; i < this.acMatches.length; i++) {
      const cmd = this.acMatches[i];
      const info = allCmdInfo[cmd];
      const row = document.createElement('div');
      row.className = 'agent-view__ac-row';
      if (i === this.acSelectedIdx) row.classList.add('agent-view__ac-row--selected');

      const cmdEl = document.createElement('span');
      cmdEl.className = 'agent-view__ac-cmd';
      cmdEl.textContent = cmd;

      const descEl = document.createElement('span');
      descEl.className = 'agent-view__ac-desc';
      descEl.textContent = info.description;

      row.appendChild(cmdEl);
      row.appendChild(descEl);
      this.autocompleteEl.appendChild(row);
    }
    this.autocompleteEl.classList.add('agent-view__autocomplete--visible');
  }

  private hideAutocomplete(): void {
    this.acMatches = [];
    this.acSelectedIdx = -1;
    this.autocompleteEl.classList.remove('agent-view__autocomplete--visible');
    this.autocompleteEl.innerHTML = '';
  }

  private acceptAutocomplete(): boolean {
    if (this.acMatches.length === 0) return false;
    const idx = Math.max(0, this.acSelectedIdx);
    const cmd = this.acMatches[idx];
    if (!cmd) return false;
    this.inputText = cmd;
    this.cursorPos = cmd.length;
    this.hideAutocomplete();
    this.renderInput();
    return true;
  }

  // ─── Agent event handling ────────────────────────────────────────

  private handleAgentEvent(e: AgentEventType): void {
    switch (e.type) {
      case 'agent_start':
        this.startSpinner();
        this.promptGlyphEl.textContent = SPINNER_FRAMES[0];
        this.inputRowEl.classList.add('agent-view__input-row--busy');
        // Input row collapsed to height:0 — messages viewport grew, re-anchor to bottom
        requestAnimationFrame(() => this.scrollToBottom());
        break;

      case 'agent_end':
        this.stopSpinner();
        this.stopTimer();
        this.promptGlyphEl.textContent = '❯';
        this.inputRowEl.classList.remove('agent-view__input-row--busy');
        // Render accumulated text as markdown
        this.finalizeAssistantMessage();
        this.currentToolRowEl = null;
        if (e.usage) this.renderStatusLine(e.usage);
        // Input row restored + status line appeared — messages viewport shrank,
        // re-anchor to bottom so the final message isn't hidden behind the status line
        requestAnimationFrame(() => this.scrollToBottom());
        break;

      case 'message_update':
        if (!this.currentAssistantTextEl) {
          this.currentAssistantTextEl = this.appendAssistantMessageDom();
          this.currentAssistantBuffer = '';
          this.currentAssistantTextEl.classList.add('agent-view__msg-body--markdown');
          // Show active skills in the label
          const activeSkills = this.controller.getLastActiveSkills();
          if (activeSkills.length > 0) {
            const msgEl = this.currentAssistantTextEl.closest('.agent-view__msg');
            const labelEl = msgEl?.querySelector('.agent-view__msg-label');
            if (labelEl) labelEl.textContent = `AI [${activeSkills.join(', ')}]`;
          }
        }
        // Accumulate raw text and render markdown on next animation frame
        this.currentAssistantBuffer += e.delta;
        if (this.streamRenderRaf === null) {
          this.streamRenderRaf = requestAnimationFrame(() => {
            this.streamRenderRaf = null;
            if (this.currentAssistantTextEl && this.currentAssistantBuffer) {
              try {
                const html = md.parse(this.currentAssistantBuffer) as string;
                this.currentAssistantTextEl.innerHTML = html;
                // Place cursor inline at the end of the last text node
                this.appendInlineCursor(this.currentAssistantTextEl);
              } catch {
                this.currentAssistantTextEl.textContent = this.currentAssistantBuffer;
              }
              this.scrollToBottom();
            }
          });
        }
        break;

      case 'tool_start':
        // Finalize any pending assistant text as markdown before showing tool row
        this.finalizeAssistantMessage();
        this.currentToolRowEl = this.appendToolRowDom(e.name, e.args);
        this.scrollToBottom();
        break;

      case 'tool_end':
        if (this.currentToolRowEl) {
          this.finalizeToolRow(this.currentToolRowEl, e.isError, e.result, e.diff, e.filePath);
          this.currentToolRowEl = null;
        }
        this.scrollToBottom();
        break;

      case 'usage_update':
        this.renderStatusLine(e.usage);
        break;

      case 'message_usage': {
        // Annotate the current assistant message with token count + response time (top-right)
        const msgEl = this.currentAssistantTextEl?.closest('.agent-view__msg');
        if (msgEl) {
          const badge = document.createElement('span');
          badge.className = 'agent-view__msg-tokens';
          const n = e.outputTokens;
          const tokStr = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          const elapsed = this.promptStartTime > 0 ? (Date.now() - this.promptStartTime) / 1000 : 0;
          const timeStr = elapsed >= 60
            ? `${Math.floor(elapsed / 60)}m${Math.floor(elapsed % 60).toString().padStart(2, '0')}s`
            : `${elapsed.toFixed(1)}s`;
          badge.textContent = `${tokStr} tok · ${timeStr}`;
          msgEl.appendChild(badge);
        }
        break;
      }

      case 'error':
        this.stopSpinner();
        this.stopTimer();
        this.promptGlyphEl.textContent = '❯';
        this.inputRowEl.classList.remove('agent-view__input-row--busy');
        {
          const errEl = document.createElement('div');
          errEl.className = 'agent-view__error';
          errEl.textContent = e.message;
          this.messagesEl.appendChild(errEl);
          this.scrollToBottom();
        }
        break;
    }
  }

  // ─── Shell command execution (! prefix) ─────────────────────────────

  private async executeShellCommand(command: string): Promise<void> {
    // Display the command being executed
    this.appendShellCommandDom(command);
    this.scrollToBottom();

    try {
      const [program, shellArgs] = await invoke<[string, string[]]>('get_default_shell');
      const output = await invoke<string>('run_command', {
        program,
        args: [...shellArgs, '-c', command],
        cwd: this.projectDir ?? null,
      });
      this.appendShellResultDom(output, false);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.appendShellResultDom(`Error: ${errorMsg}`, true);
    }
  }

  // ─── Slash commands ──────────────────────────────────────────────

  private static readonly COMMANDS: Record<string, { description: string; usage?: string }> = {
    '/help':    { description: 'Show available commands' },
    '/new':     { description: 'Clear conversation and start a new session' },
    '/skills':  { description: 'List discovered skills' },
    '/skill':   { description: 'Force-activate a skill for the next prompt', usage: '/skill <name>' },
    '/context': { description: 'Open context inspector (view LLM messages, system prompt, tools)' },
    '/model':   { description: 'Show current model or switch preset', usage: '/model [name]' },
    '/system':  { description: 'Show current system prompt' },
    '/tools':   { description: 'List registered tools' },
    '/yank':    { description: 'Copy last assistant response to clipboard' },
    '/yankall': { description: 'Copy entire conversation to clipboard' },
    '/abort':   { description: 'Abort the current agent run' },
    '/quit':    { description: 'Close the agent tab' },
    '/clear':   { description: 'Clear conversation display (alias for /new)' },
  };

  private handleSlashCommand(text: string): boolean {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/help':
        this.showSystemMessage(this.formatHelp());
        return true;

      case '/new':
      case '/clear':
        this.newSession();
        this.showSystemMessage('Session cleared.');
        return true;

      case '/context':
        this.contextCallback?.(this.controller);
        return true;

      case '/skills': {
        const skills = this.controller.getSkills();
        if (skills.length === 0) {
          this.showSystemMessage('No skills discovered.\nPlace SKILL.md files in .claude/skills/ or .agents/skills/\nOr add commands in .claude/commands/*.md');
        } else {
          const hasCommands = skills.some((s) => s.isCommand);
          const nameWidth = Math.max(...skills.map((s) => s.name.length)) + 1;
          const colWidth = nameWidth + (hasCommands ? 6 : 0); // room for ' [cmd]'
          const lines = skills.map((s) => {
            const tag = s.isCommand ? ' [cmd]' : '';
            const nameCol = (s.name + tag).padEnd(colWidth);
            const raw = s.description || '—';
            const desc = raw.length > 68 ? raw.slice(0, 67) + '…' : raw;
            return `  ${nameCol}  ${desc}`;
          });
          const active = this.controller.getLastActiveSkills();
          const activeNote = active.length > 0 ? `\n\nLast active: ${active.join(', ')}` : '';
          this.showSystemMessage(`Discovered skills (${skills.length}):\n\n${lines.join('\n')}${activeNote}`);
        }
        return true;
      }

      case '/skill': {
        const skillName = parts[1];
        if (!skillName) {
          this.showSystemMessage('Usage: /skill <name>\nUse /skills to list available skills.');
          return true;
        }
        const ok = this.controller.setForcedSkill(skillName);
        if (ok) {
          this.showSystemMessage(`Skill "${skillName}" will be active for the next prompt.`);
        } else {
          const available = this.controller.getSkills().map((s) => s.name).join(', ');
          this.showSystemMessage(`Skill "${skillName}" not found.\nAvailable: ${available || 'none'}`);
        }
        return true;
      }

      case '/model': {
        const modelArg = parts[1];
        if (modelArg) {
          // Switch to a different preset
          this.showSystemMessage(`Switching to "${modelArg}"…`);
          this.controller.switchModel(modelArg).then(async (result) => {
            if (result.ok) {
              // Persist to config file
              try {
                await invoke('set_agent_active', { name: modelArg });
              } catch (e) {
                console.warn('[agent] failed to persist model switch:', e);
              }
              this.showSystemMessage(`Switched to "${modelArg}". Next prompt will use the new model.`);
            } else {
              this.showSystemMessage(`Failed to switch: ${result.error}`);
            }
          });
        } else {
          // Show current model + available presets
          const active = this.controller.getActivePresetName() ?? 'default';
          const ctx = this.controller.getContext();
          const modelInfo = ctx
            ? `Current: ${active} (${ctx.model})\nMessages: ${ctx.messageCount}`
            : `Current: ${active} (not initialized yet)`;
          this.controller.getAvailablePresets().then((presets) => {
            const list = presets.map((p) => {
              const marker = p.name === active ? ' ←' : '';
              return `  ${p.name.padEnd(24)} ${p.provider}/${p.model}${marker}`;
            }).join('\n');
            const presetsInfo = presets.length > 0
              ? `\n\nAvailable presets:\n${list}\n\nSwitch with: /model <name>`
              : '';
            this.showSystemMessage(modelInfo + presetsInfo);
          });
        }
        return true;
      }

      case '/system': {
        const ctx = this.controller.getContext();
        if (ctx) {
          this.showSystemMessage(ctx.systemPrompt);
        } else {
          this.showSystemMessage('Agent not initialized — submit a prompt first.');
        }
        return true;
      }

      case '/tools': {
        const ctx = this.controller.getContext();
        if (ctx && ctx.tools.length > 0) {
          const lines = ctx.tools.map((t) => `  ${t.name} — ${t.description}`);
          this.showSystemMessage(`Registered tools (${ctx.tools.length}):\n${lines.join('\n')}`);
        } else if (ctx) {
          this.showSystemMessage('No tools registered.');
        } else {
          this.showSystemMessage('Agent not initialized — submit a prompt first.');
        }
        return true;
      }

      case '/yank':
        this.yankLastAssistant();
        this.showSystemMessage('Last assistant response copied to clipboard.');
        return true;

      case '/yankall':
        this.yankAll();
        this.showSystemMessage('Full conversation copied to clipboard.');
        return true;

      case '/abort':
        if (this.controller.isRunning) {
          this.controller.abort();
          this.stopSpinner();
          this.promptGlyphEl.textContent = '❯';
          this.inputRowEl.classList.remove('agent-view__input-row--busy');
          this.showSystemMessage('Agent run aborted.');
        } else {
          this.showSystemMessage('Nothing running.');
        }
        return true;

      case '/quit':
        this.closeCallback?.();
        return true;

      default:
        return false;
    }
  }

  /**
   * Handle a custom command from .claude/commands/.
   * Force-activates the command skill, then sends args as a prompt to the agent.
   */
  private async handleCustomCommand(text: string): Promise<boolean> {
    const parts = text.split(/\s+/);
    const cmdName = parts[0].slice(1); // strip leading /
    const cmd = this.controller.findCommand(cmdName);
    if (!cmd) return false;

    const args = parts.slice(1).join(' ');

    // Force-activate the command skill with args
    this.controller.setForcedSkill(cmdName);

    if (this.controller.isRunning) return true;

    // Show the command invocation as a user message and start spinner immediately
    this.appendUserMessageDom(text);
    this.scrollToBottom();
    this.startSpinner();
    this.startTimer();
    this.inputRowEl.classList.add('agent-view__input-row--busy');

    try {
      await this.controller.prompt(args || cmdName, (e) => this.handleAgentEvent(e), args);
    } catch (e) {
      this.handleAgentEvent({ type: 'error', message: `Unexpected error: ${e}` });
    }
    return true;
  }

  private formatHelp(): string {
    const lines: string[] = ['Available commands:'];
    for (const [cmd, info] of Object.entries(AgentView.COMMANDS)) {
      lines.push(`  ${cmd.padEnd(12)} ${info.description}`);
    }

    // Include custom commands from .claude/commands/
    const customCmds = this.controller.getCommands();
    if (customCmds.length > 0) {
      lines.push('');
      lines.push('Custom commands (.claude/commands/):');
      for (const cmd of customCmds) {
        lines.push(`  /${cmd.name.padEnd(11)} ${cmd.description}`);
      }
    }

    lines.push('');
    lines.push('Quick shell commands:');
    lines.push('  !<command>    Execute shell command directly');
    lines.push('                 Example: !ls -la, !git status');
    lines.push('');
    lines.push('Keyboard shortcuts (scroll mode — Escape with empty input):');
    lines.push('  j/k          Scroll lines');
    lines.push('  g/G          Top/bottom');
    lines.push('  y/Y          Yank last/all');
    lines.push('  c            Context inspector');
    lines.push('  q            Close tab');
    lines.push('  i/Escape     Back to input');
    return lines.join('\n');
  }

  private showSystemMessage(text: string): void {
    const msg = document.createElement('div');
    msg.className = 'agent-view__msg agent-view__msg--system';

    const label = document.createElement('span');
    label.className = 'agent-view__msg-label agent-view__msg-label--system';
    label.textContent = 'SYS';

    const body = document.createElement('div');
    body.className = 'agent-view__msg-body agent-view__msg-body--system';
    body.textContent = text;

    msg.appendChild(label);
    msg.appendChild(body);
    this.messagesEl.appendChild(msg);
    this.scrollToBottom();
  }

  // ─── Submit ──────────────────────────────────────────────────────

  private async submit(): Promise<void> {
    const text = this.inputText.trim();
    const hasImages = this.stagedImages.length > 0;

    // Require at least text or images
    if (!text && !hasImages) return;

    // Save to history (text only)
    if (text && this.promptHistory[this.promptHistory.length - 1] !== text) {
      this.promptHistory.push(text);
    }
    this.historyIdx = -1;

    // Clear input
    this.inputText = '';
    this.cursorPos = 0;
    this.renderInput();

    // Shell and slash commands don't support image context — clear images and handle normally
    if (text.startsWith('!')) {
      const images = this.stagedImages.splice(0);
      this.renderStagingArea();
      void images; // images discarded for shell commands
      const command = text.slice(1).trim();
      if (!command) {
        this.showSystemMessage('Usage: !<command>\nExecute shell command directly.\nExample: !ls -la');
      } else {
        await this.executeShellCommand(command);
      }
      return;
    }

    if (text.startsWith('/')) {
      this.stagedImages = [];
      this.renderStagingArea();
      if (this.handleSlashCommand(text)) return;
      if (await this.handleCustomCommand(text)) return;
      this.showSystemMessage(`Unknown command: ${text.split(/\s+/)[0]}\nType /help for available commands.`);
      return;
    }

    if (this.controller.isRunning) return;

    // Warn if images staged but model doesn't support vision
    if (hasImages && !this.controller.supportsVision()) {
      this.showSystemMessage(
        'Current model doesn\'t support vision — images will be ignored.\nSwitch to a vision model with /model.',
      );
    }

    // Snapshot and clear staged images before async work
    const images = this.stagedImages.splice(0);
    this.renderStagingArea();

    // Render user message and show processing indicator immediately
    this.appendUserMessageDom(text, images);
    this.scrollToBottom();
    this.startSpinner();
    this.startTimer();
    this.inputRowEl.classList.add('agent-view__input-row--busy');

    try {
      await this.controller.prompt(text, (e) => this.handleAgentEvent(e), undefined, images);
    } catch (e) {
      this.handleAgentEvent({ type: 'error', message: `Unexpected error: ${e}` });
    }
  }

  // ─── Keyboard ────────────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.state === 'input') {
      return this.handleInputKey(e);
    }
    return this.handleScrollKey(e);
  }

  private handleInputKey(e: KeyboardEvent): boolean {
    // Escape — dismiss mention popup first, then slash ac, then scroll state
    if (e.key === 'Escape') {
      if (this.mention.active) {
        this.hideMention();
        return true;
      }
      if (this.acMatches.length > 0) {
        this.hideAutocomplete();
        return true;
      }
      if (this.inputText === '') {
        this.enterScrollState();
        return true;
      }
      return true;
    }

    // Mention popup — Tab/Shift+Tab and arrow keys navigate; Tab/Enter accept
    if (this.mention.active && this.mention.items.length > 0) {
      if (e.key === 'Tab') {
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
        this.mention.selectedIndex =
          (this.mention.selectedIndex - 1 + this.mention.items.length) % this.mention.items.length;
        this.renderMentionPopup();
        return true;
      }
      if (e.key === 'ArrowDown') {
        this.mention.selectedIndex = (this.mention.selectedIndex + 1) % this.mention.items.length;
        this.renderMentionPopup();
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this.acceptMention();
        return true;
      }
    }

    // Tab — accept autocomplete or cycle
    if (e.key === 'Tab' && this.acMatches.length > 0) {
      if (e.shiftKey) {
        this.acSelectedIdx = (this.acSelectedIdx - 1 + this.acMatches.length) % this.acMatches.length;
        this.updateAutocomplete();
      } else {
        this.acceptAutocomplete();
      }
      return true;
    }

    // Arrow Up/Down navigate autocomplete when visible
    if (e.key === 'ArrowUp' && this.acMatches.length > 0) {
      this.acSelectedIdx = Math.max(0, this.acSelectedIdx - 1);
      this.updateAutocomplete();
      return true;
    }
    if (e.key === 'ArrowDown' && this.acMatches.length > 0) {
      this.acSelectedIdx = Math.min(this.acMatches.length - 1, this.acSelectedIdx + 1);
      this.updateAutocomplete();
      return true;
    }

    // Submit — accept autocomplete if visible, otherwise submit prompt
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (this.acMatches.length > 0) {
        this.acceptAutocomplete();
        return true;
      }
      this.submit();
      return true;
    }

    // Newline
    if (e.key === 'Enter' && e.shiftKey) {
      this.insert('\n');
      return true;
    }

    // Abort (Ctrl+C) — clear input + staged images if idle, abort if running
    if (e.code === 'KeyC' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.controller.isRunning) {
        this.controller.abort();
        this.stopSpinner();
        this.promptGlyphEl.textContent = '❯';
        this.inputRowEl.classList.remove('agent-view__input-row--busy');
        // Input row restored — re-anchor scroll so last content isn't hidden
        requestAnimationFrame(() => this.scrollToBottom());
      } else {
        this.inputText = '';
        this.cursorPos = 0;
        this.stagedImages = [];
        this.renderStagingArea();
        this.renderInput();
      }
      return true;
    }

    // Readline: Ctrl+U — kill line before cursor
    if (e.code === 'KeyU' && e.ctrlKey && !e.metaKey && !e.altKey) {
      this.inputText = this.inputText.slice(this.cursorPos);
      this.cursorPos = 0;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+K — kill line after cursor
    if (e.code === 'KeyK' && e.ctrlKey && !e.metaKey && !e.altKey) {
      this.inputText = this.inputText.slice(0, this.cursorPos);
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+A — move to beginning of line
    if (e.code === 'KeyA' && e.ctrlKey && !e.metaKey && !e.altKey) {
      this.cursorPos = 0;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+E — move to end of line
    if (e.code === 'KeyE' && e.ctrlKey && !e.metaKey && !e.altKey) {
      this.cursorPos = this.inputText.length;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+B — move back one char
    if (e.code === 'KeyB' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos > 0) this.cursorPos--;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+F — move forward one char
    if (e.code === 'KeyF' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos < this.inputText.length) this.cursorPos++;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+D — delete char under cursor
    if (e.code === 'KeyD' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos < this.inputText.length) {
        this.inputText = this.inputText.slice(0, this.cursorPos) + this.inputText.slice(this.cursorPos + 1);
        this.renderInput();
      }
      return true;
    }

    // Readline: Ctrl+H — backspace
    if (e.code === 'KeyH' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos > 0) {
        this.inputText = this.inputText.slice(0, this.cursorPos - 1) + this.inputText.slice(this.cursorPos);
        this.cursorPos--;
        this.renderInput();
      }
      return true;
    }

    // Readline: Ctrl+T — transpose chars
    if (e.code === 'KeyT' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos > 0 && this.cursorPos < this.inputText.length) {
        const chars = this.inputText.split('');
        [chars[this.cursorPos - 1], chars[this.cursorPos]] = [chars[this.cursorPos], chars[this.cursorPos - 1]];
        this.inputText = chars.join('');
        this.cursorPos++;
        this.renderInput();
      }
      return true;
    }

    // Readline: Ctrl+W — delete word backward
    if (e.code === 'KeyW' && e.ctrlKey && !e.metaKey && !e.altKey) {
      const before = this.inputText.slice(0, this.cursorPos);
      const trimmed = before.replace(/\S+\s*$/, '');
      this.inputText = trimmed + this.inputText.slice(this.cursorPos);
      this.cursorPos = trimmed.length;
      this.renderInput();
      return true;
    }

    // Readline: Alt+B — move back one word
    if (e.code === 'KeyB' && e.altKey && !e.ctrlKey && !e.metaKey) {
      const before = this.inputText.slice(0, this.cursorPos);
      const match = before.match(/(?:\S+\s*|\s+)$/);
      this.cursorPos -= match ? match[0].length : 0;
      this.renderInput();
      return true;
    }

    // Readline: Alt+F — move forward one word
    if (e.code === 'KeyF' && e.altKey && !e.ctrlKey && !e.metaKey) {
      const after = this.inputText.slice(this.cursorPos);
      const match = after.match(/^(?:\s*\S+|\s+)/);
      this.cursorPos += match ? match[0].length : 0;
      this.renderInput();
      return true;
    }

    // Readline: Alt+D — delete word forward
    if (e.code === 'KeyD' && e.altKey && !e.ctrlKey && !e.metaKey) {
      const after = this.inputText.slice(this.cursorPos);
      const match = after.match(/^\s*\S+/);
      if (match) {
        this.inputText = this.inputText.slice(0, this.cursorPos) + after.slice(match[0].length);
        this.renderInput();
      }
      return true;
    }

    // Readline: Alt+Backspace — delete word backward
    if (e.key === 'Backspace' && e.altKey && !e.ctrlKey && !e.metaKey) {
      const before = this.inputText.slice(0, this.cursorPos);
      const trimmed = before.replace(/\S+\s*$/, '');
      this.inputText = trimmed + this.inputText.slice(this.cursorPos);
      this.cursorPos = trimmed.length;
      this.renderInput();
      return true;
    }

    // Backspace
    if (e.key === 'Backspace') {
      if (this.cursorPos > 0) {
        this.inputText = this.inputText.slice(0, this.cursorPos - 1) + this.inputText.slice(this.cursorPos);
        this.cursorPos--;
        this.renderInput();
      }
      return true;
    }

    // Delete
    if (e.key === 'Delete') {
      if (this.cursorPos < this.inputText.length) {
        this.inputText = this.inputText.slice(0, this.cursorPos) + this.inputText.slice(this.cursorPos + 1);
        this.renderInput();
      }
      return true;
    }

    // Cursor movement
    if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) {
      if (this.cursorPos > 0) this.cursorPos--;
      this.renderInput();
      return true;
    }
    if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) {
      if (this.cursorPos < this.inputText.length) this.cursorPos++;
      this.renderInput();
      return true;
    }
    if (e.key === 'Home' || (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey))) {
      this.cursorPos = 0;
      this.renderInput();
      return true;
    }
    if (e.key === 'End' || (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey))) {
      this.cursorPos = this.inputText.length;
      this.renderInput();
      return true;
    }

    // History navigation (only when input is empty)
    if (e.key === 'ArrowUp' && this.inputText === '') {
      this.historyBack();
      return true;
    }
    if (e.key === 'ArrowDown' && this.inputText === '') {
      this.historyForward();
      return true;
    }

    // Scroll message list without leaving input state
    if (e.key === 'PageUp') {
      this.scrollMessagesFraction(-0.4);
      return true;
    }
    if (e.key === 'PageDown') {
      this.scrollMessagesFraction(0.4);
      return true;
    }

    // Paste (Cmd+V / Ctrl+V) — let the native paste event handle insertion
    // (macOS Edit menu intercepts Cmd+V before JS keydown; the paste event
    // listener on this.element picks up the clipboard data reliably)
    if (e.code === 'KeyV' && (e.metaKey || e.ctrlKey) && !e.altKey) {
      return false; // don't consume — allow native paste event to fire
    }

    // Select all (Cmd+A)
    if (e.code === 'KeyA' && e.metaKey && !e.ctrlKey && !e.altKey) {
      return true; // consume — no text selection in manual input
    }

    // Printable character
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.insert(e.key);
      return true;
    }

    return false;
  }

  private handleScrollKey(e: KeyboardEvent): boolean {
    // Return to input state
    if (e.key === 'Escape' || (e.key === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      this.exitScrollState();
      return true;
    }

    // Line scrolling
    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.messagesEl.scrollBy({ top: 24, behavior: 'instant' });
      return true;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      this.messagesEl.scrollBy({ top: -24, behavior: 'instant' });
      return true;
    }

    // Half-page scrolling
    if (e.key === 'PageDown' || (e.code === 'KeyD' && e.ctrlKey && !e.metaKey)) {
      this.scrollMessagesFraction(0.4);
      return true;
    }
    if (e.key === 'PageUp' || (e.code === 'KeyU' && e.ctrlKey && !e.metaKey)) {
      this.scrollMessagesFraction(-0.4);
      return true;
    }

    // Top / bottom
    if (e.key === 'g' && !e.shiftKey) {
      this.messagesEl.scrollTop = 0;
      return true;
    }
    if (e.key === 'G' || (e.key === 'g' && e.shiftKey)) {
      this.scrollToBottom();
      return true;
    }

    // Yank
    if (e.key === 'y' && !e.shiftKey) {
      this.yankLastAssistant();
      return true;
    }
    if (e.key === 'Y' || (e.key === 'y' && e.shiftKey)) {
      this.yankAll();
      return true;
    }

    // Enter — open full diff for nearest tool row with diff data
    if (e.key === 'Enter') {
      this.openNearestDiff();
      return true;
    }

    // c — open dedicated context window
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.contextCallback?.(this.controller);
      return true;
    }

    // q — close tab (same convention as diff/markdown viewers)
    if (e.key === 'q') {
      this.closeCallback?.();
      return true;
    }

    return false;
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  onOpenContext(cb: (controller: AgentController) => void): void {
    this.contextCallback = cb;
  }

  onOpenDiff(cb: (diff: string, title: string) => void): void {
    this.diffCallback = cb;
  }

  getController(): AgentController {
    return this.controller;
  }

  /** Find the tool row closest to the current scroll position that has diff data, and open it. */
  private openNearestDiff(): void {
    if (!this.diffCallback) return;
    const rows = this.messagesEl.querySelectorAll<HTMLElement>('.agent-view__tool-row--has-diff');
    if (rows.length === 0) return;

    // Find row closest to viewport center
    const viewCenter = this.messagesEl.scrollTop + this.messagesEl.clientHeight / 2;
    let closest: HTMLElement | null = null;
    let closestDist = Infinity;
    for (const row of rows) {
      const rowCenter = row.offsetTop + row.offsetHeight / 2;
      const dist = Math.abs(rowCenter - viewCenter);
      if (dist < closestDist) {
        closestDist = dist;
        closest = row;
      }
    }

    if (closest?.dataset.diff && closest.dataset.filePath) {
      this.diffCallback(closest.dataset.diff, `DIFF // ${closest.dataset.filePath}`);
    }
  }

  private insert(char: string): void {
    this.inputText = this.inputText.slice(0, this.cursorPos) + char + this.inputText.slice(this.cursorPos);
    this.cursorPos += char.length;
    this.renderInput();
  }

  private historyBack(): void {
    if (this.promptHistory.length === 0) return;
    if (this.historyIdx === -1) this.historyIdx = this.promptHistory.length - 1;
    else if (this.historyIdx > 0) this.historyIdx--;
    this.inputText = this.promptHistory[this.historyIdx] ?? '';
    this.cursorPos = this.inputText.length;
    this.renderInput();
  }

  private historyForward(): void {
    if (this.historyIdx === -1) return;
    this.historyIdx++;
    if (this.historyIdx >= this.promptHistory.length) {
      this.historyIdx = -1;
      this.inputText = '';
    } else {
      this.inputText = this.promptHistory[this.historyIdx] ?? '';
    }
    this.cursorPos = this.inputText.length;
    this.renderInput();
  }

  // ─── Scroll state ─────────────────────────────────────────────────

  private enterScrollState(): void {
    this.state = 'scroll';
    this.element.classList.add('agent-view--scroll');
    this.inputRowEl.classList.add('agent-view__input-row--hidden');
    this.stateHintEl.classList.add('agent-view__state-hint--visible');
  }

  private exitScrollState(): void {
    this.state = 'input';
    this.element.classList.remove('agent-view--scroll');
    this.inputRowEl.classList.remove('agent-view__input-row--hidden');
    this.stateHintEl.classList.remove('agent-view__state-hint--visible');
  }

  // ─── Status line ──────────────────────────────────────────────────

  private renderStatusLine(usage: import('./agent').TokenUsage): void {
    const fmt = (n: number): string => {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
      return String(n);
    };

    const parts: string[] = [];
    const modelName = this.controller.getActivePresetName();
    if (modelName) parts.push(modelName);
    parts.push(`IN ${fmt(usage.input)}`);
    parts.push(`OUT ${fmt(usage.output)}`);
    if (usage.cacheRead > 0) parts.push(`CACHE ${fmt(usage.cacheRead)}`);
    parts.push(`Σ ${fmt(usage.totalTokens)}`);
    if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
    if (usage.contextWindow > 0) parts.push(`CTX ${usage.contextPercent}%`);
    const skillCount = this.controller.getSkills().length;
    if (skillCount > 0) parts.push(`SKILLS ${skillCount}`);

    this.statusLineEl.textContent = parts.join('  ·  ');
    this.statusLineEl.classList.add('agent-view__status-line--visible');

    // Visual warning when context is getting full
    this.statusLineEl.classList.toggle('agent-view__status-line--warn', usage.contextPercent >= 70);
    this.statusLineEl.classList.toggle('agent-view__status-line--critical', usage.contextPercent >= 90);
  }

  private scrollToBottom(): void {
    if (!this.messagesEl.offsetParent) {
      // Element is detached from DOM (tab not visible) — defer scroll
      this.pendingScrollToBottom = true;
      return;
    }
    this.pendingScrollToBottom = false;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private scrollMessagesFraction(fraction: number): void {
    const delta = this.messagesEl.clientHeight * fraction;
    this.messagesEl.scrollBy({ top: delta, behavior: 'instant' });
  }

  // ─── Yank ─────────────────────────────────────────────────────────

  private yankLastAssistant(): void {
    const msgs = Array.from(this.messagesEl.querySelectorAll('.agent-view__msg--assistant'));
    const last = msgs[msgs.length - 1];
    if (last) {
      navigator.clipboard.writeText(last.querySelector('.agent-view__msg-body')?.textContent ?? '');
    }
  }

  private yankAll(): void {
    const parts: string[] = [];
    for (const el of Array.from(this.messagesEl.children)) {
      if (el.classList.contains('agent-view__msg--user')) {
        parts.push(`YOU: ${el.querySelector('.agent-view__msg-body')?.textContent ?? ''}`);
      } else if (el.classList.contains('agent-view__msg--assistant')) {
        parts.push(`AI: ${el.querySelector('.agent-view__msg-body')?.textContent ?? ''}`);
      }
    }
    navigator.clipboard.writeText(parts.join('\n\n'));
  }

  // ─── Spinner ──────────────────────────────────────────────────────

  private startSpinner(): void {
    if (this.spinnerInterval !== null) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.promptGlyphEl.textContent = SPINNER_FRAMES[this.spinnerFrame];
      if (this.currentToolRowEl) {
        const icon = this.currentToolRowEl.querySelector('.agent-view__tool-icon');
        if (icon) icon.textContent = SPINNER_FRAMES[this.spinnerFrame];
      }
      const statusSpinner = this.statusLineEl.querySelector('.agent-view__status-spinner');
      if (statusSpinner) statusSpinner.textContent = SPINNER_FRAMES[this.spinnerFrame];
    }, 80);
    let spinner = this.statusLineEl.querySelector('.agent-view__status-spinner');
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'agent-view__status-spinner';
      this.statusLineEl.prepend(spinner);
    }
  }

  private stopSpinner(): void {
    if (this.spinnerInterval !== null) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    this.spinnerFrame = 0;
    this.statusLineEl.querySelector('.agent-view__status-spinner')?.remove();
  }

  // ─── Timer ────────────────────────────────────────────────────────

  private startTimer(): void {
    this.stopTimer();
    this.promptStartTime = Date.now();
    this.statusLineEl.classList.add('agent-view__status-line--visible');
    this.timerInterval = setInterval(() => {
      const elapsed = (Date.now() - this.promptStartTime) / 1000;
      const timeStr = elapsed >= 60
        ? `${Math.floor(elapsed / 60)}:${Math.floor(elapsed % 60).toString().padStart(2, '0')}`
        : `${elapsed.toFixed(1)}s`;
      // Update or create the timer segment in the status line
      const existing = this.statusLineEl.querySelector('.agent-view__timer');
      if (existing) {
        existing.textContent = timeStr;
      } else {
        const timer = document.createElement('span');
        timer.className = 'agent-view__timer';
        timer.textContent = timeStr;
        this.statusLineEl.prepend(timer);
      }
    }, 100);
  }

  private stopTimer(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    // Remove the live timer element
    this.statusLineEl.querySelector('.agent-view__timer')?.remove();
  }

  // ─── Inline cursor ────────────────────────────────────────────────

  /** Place the blinking cursor inline at the end of the last text node. */
  private appendInlineCursor(container: HTMLElement): void {
    const cursor = document.createElement('span');
    cursor.className = 'agent-view__stream-cursor';
    cursor.textContent = '▋';

    // Walk backwards to find the deepest last element that contains text
    let target: Node = container;
    while (target.lastChild) {
      const last = target.lastChild;
      // Skip empty text nodes
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
      // Insert cursor right after the last text node
      target.parentNode.insertBefore(cursor, target.nextSibling);
    } else if (target instanceof HTMLElement) {
      target.appendChild(cursor);
    } else {
      container.appendChild(cursor);
    }
  }

  // ─── New session ──────────────────────────────────────────────────

  async newSession(): Promise<void> {
    await this.controller.reset();
    this.messagesEl.innerHTML = '';
    this.inputText = '';
    this.cursorPos = 0;
    this.promptHistory = [];
    this.historyIdx = -1;
    this.statusLineEl.textContent = '';
    this.statusLineEl.classList.remove('agent-view__status-line--visible');
    if (this.streamRenderRaf !== null) {
      cancelAnimationFrame(this.streamRenderRaf);
      this.streamRenderRaf = null;
    }
    this.logoEl.classList.remove('agent-view__logo--hidden');
    this.renderInput();
  }

  // ─── Set context ──────────────────────────────────────────────────

  /** Set the project directory for per-project session scoping and tool CWD. Restores the matching session. */
  setProjectDir(dir: string | null): void {
    console.log('[agent] setProjectDir:', dir);
    this.projectDir = dir;
    this.controller.setProjectDir(dir);
    this.restoreSession();
    if (dir) {
      void this.refreshMentionFiles();
    } else {
      this.mentionFiles = [];
    }
  }

  private async refreshMentionFiles(): Promise<void> {
    if (!this.projectDir) return;
    this.mentionFiles = await loadFileIndex(this.projectDir);
    if (this.mention.active) {
      this.rankMentionFiles();
      this.renderMentionPopup();
    }
  }

  // ─── ContentView interface ────────────────────────────────────────

  getWorkingDirectory(): string | null {
    return this.projectDir;
  }

  onResize(_w: number, _h: number): void {
    // After tab switch, DOM reflow resets scrollTop to 0.
    // If new content arrived while detached, scroll to bottom; otherwise restore.
    if (this.pendingScrollToBottom) {
      this.pendingScrollToBottom = false;
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    } else if (this.savedScrollTop > 0) {
      this.messagesEl.scrollTop = this.savedScrollTop;
    }
  }

  dispose(): void {
    this.controller.abort();
    this.stopSpinner();
    this.virtualObserver?.disconnect();
    this.collapsedMessages.clear();
  }
}
