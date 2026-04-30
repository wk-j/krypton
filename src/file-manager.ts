// Krypton — File Manager View
// Keyboard-driven file browser as a ContentView pane.

import { invoke } from '@tauri-apps/api/core';
import hljs from 'highlight.js';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

import type { ContentView, PaneContentType } from './types';
import type { FileManagerAI, FileManagerContext, FileContextEntry } from './file-manager-ai';

/** Marked instance for rendering markdown previews */
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

/** A file/directory entry returned by the backend list_directory command */
interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: number;
  permissions: string;
  symlink_target: string | null;
}

type SortField = 'name' | 'size' | 'modified';
type SortOrder = 'asc' | 'desc';

/** Prompt state for inline status-bar input (rename, mkdir, etc.) */
interface PromptState {
  label: string;
  value: string;
  onSubmit: (value: string) => void;
}

const PREVIEW_MAX_BYTES = 65536;

/** Resolve the user's home directory from env or heuristic */
let cachedHome: string | null = null;
async function getHome(): Promise<string> {
  if (cachedHome) return cachedHome;
  try {
    const home = await invoke<string | null>('get_env_var', { name: 'HOME' });
    if (home) {
      cachedHome = home;
      return home;
    }
  } catch { /* fall through */ }
  cachedHome = '/';
  return cachedHome;
}

// ─── Claude Code Skill Detection & Rendering ────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse YAML frontmatter. Supports simple `key: value`, `key: >` (folded), `key: |` (literal). */
function parseSkillFrontmatter(content: string): { frontmatter: Record<string, string> | null; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };

  const fm: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  let key: string | null = null;
  let mode: 'folded' | 'literal' | null = null;
  let buffer: string[] = [];

  const commit = (): void => {
    if (!(key && mode)) return;
    fm[key] = mode === 'folded'
      ? buffer.map((l) => l.trim()).filter(Boolean).join(' ')
      : buffer.join('\n');
    buffer = [];
    mode = null;
  };

  for (const line of lines) {
    if (mode && (/^\s+\S/.test(line) || /^\s*$/.test(line))) {
      if (!(buffer.length === 0 && /^\s*$/.test(line))) buffer.push(line);
      continue;
    }
    commit();
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const value = kv[2];
    if (value === '>') mode = 'folded';
    else if (value === '|') mode = 'literal';
    else fm[key] = value;
  }
  commit();

  return { frontmatter: fm, body: match[2] };
}

/** Canonical skill file paths: anything inside `.claude/skills/` or named `SKILL.md`. */
function isSkillPath(path: string): boolean {
  if (/[/\\]\.claude[/\\]skills[/\\]/.test(path)) return true;
  const basename = path.split(/[/\\]/).pop() ?? '';
  return basename.toUpperCase() === 'SKILL.MD';
}

/** Frontmatter shape matching the Claude Code skill spec (name + description + allowed-tools). */
function isSkillFrontmatter(fm: Record<string, string> | null): boolean {
  if (!fm) return false;
  const hasTools = 'allowed-tools' in fm || 'allowedTools' in fm;
  return 'name' in fm && 'description' in fm && hasTools;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Split an `allowed-tools` value into entries, respecting parenthesised argument patterns. */
function parseAllowedTools(str: string): string[] {
  const tools: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if ((ch === ' ' || ch === ',' || ch === '\n' || ch === '\t') && depth === 0) {
      if (current.trim()) tools.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tools.push(current.trim());
  return tools;
}

function renderSkillSpec(fm: Record<string, string>): string {
  const name = fm['name'] ?? '';
  const description = fm['description'] ?? '';
  const allowedToolsRaw = fm['allowed-tools'] ?? fm['allowedTools'] ?? '';
  const tools = parseAllowedTools(allowedToolsRaw);

  const known = new Set(['name', 'description', 'allowed-tools', 'allowedTools']);
  const extras = Object.entries(fm).filter(([k]) => !known.has(k));

  const toolsRow = tools.length > 0
    ? `<div class="krypton-skill-spec__row">`
      + `<div class="krypton-skill-spec__label">Allowed Tools</div>`
      + `<div class="krypton-skill-spec__tools">${tools.map((t) => `<span class="krypton-skill-spec__tool">${escapeHtml(t)}</span>`).join('')}</div>`
      + `</div>`
    : '';

  const extraRows = extras.map(([k, v]) =>
    `<div class="krypton-skill-spec__row">`
    + `<div class="krypton-skill-spec__label">${escapeHtml(k)}</div>`
    + `<div class="krypton-skill-spec__value">${escapeHtml(v)}</div>`
    + `</div>`,
  ).join('');

  return `<div class="krypton-skill-spec">`
    + `<div class="krypton-skill-spec__header">`
    + `<span class="krypton-skill-spec__tag">Claude Code Skill</span>`
    + (name ? `<span class="krypton-skill-spec__name">${escapeHtml(name)}</span>` : '')
    + `</div>`
    + (description ? `<div class="krypton-skill-spec__description">${escapeHtml(description)}</div>` : '')
    + toolsRow
    + extraRows
    + `</div>`;
}

/** Render a generic frontmatter card for non-skill markdown files using the same spec-card style. */
function renderFrontmatterCard(fm: Record<string, string>): string {
  const titleKey = ['title', 'name'].find((k) => k in fm);
  const title = titleKey ? fm[titleKey] : '';
  const description = fm['description'] ?? '';
  const promoted = new Set<string>();
  if (titleKey) promoted.add(titleKey);
  if (description) promoted.add('description');

  const rows = Object.entries(fm)
    .filter(([k, v]) => !promoted.has(k) && v !== '')
    .map(([k, v]) =>
      `<div class="krypton-skill-spec__row">`
      + `<div class="krypton-skill-spec__label">${escapeHtml(k)}</div>`
      + `<div class="krypton-skill-spec__value">${escapeHtml(v)}</div>`
      + `</div>`,
    ).join('');

  return `<div class="krypton-skill-spec">`
    + `<div class="krypton-skill-spec__header">`
    + `<span class="krypton-skill-spec__tag">Frontmatter</span>`
    + (title ? `<span class="krypton-skill-spec__name">${escapeHtml(title)}</span>` : '')
    + `</div>`
    + (description ? `<div class="krypton-skill-spec__description">${escapeHtml(description)}</div>` : '')
    + rows
    + `</div>`;
}

export class FileManagerView implements ContentView {
  readonly type: PaneContentType = 'file_manager';
  readonly element: HTMLElement;

  private cwd = '';
  private initialCwd = '';
  private entries: FileEntry[] = [];
  private filteredEntries: FileEntry[] = [];
  private cursor = 0;
  private scrollOffset = 0;
  private visibleRows = 30; // sensible default until onResize is called
  private sortField: SortField = 'name';
  private sortOrder: SortOrder = 'asc';
  private filterMode = false;
  private filterText = '';
  private marked = new Set<string>();
  private trackedFiles = new Map<string, string>();
  private clipboard: { paths: string[]; op: 'copy' | 'cut' } | null = null;
  private showHidden = false;
  private history: string[] = [];
  private prompt: PromptState | null = null;
  private confirmAction: (() => void) | null = null;
  private closeCallback: (() => void) | null = null;
  private openDiffCallback: ((diff: string, title: string) => void) | null = null;
  private lastPreviewPath: string | null = null;
  private aiOverlay: FileManagerAI | null = null;

  // Fuzzy file search state
  private searchMode = false;
  private searchText = '';
  private searchPool: string[] = [];
  private searchPoolLower: string[] = [];
  private searchResults: string[] = [];
  private searchCursor = 0;
  private searchScrollOffset = 0;
  private searchRoot = '';
  private searchCapped = false;

  // Vim-style gg detection
  private lastKey = '';
  private lastKeyTime = 0;

  // Preview generation counter to discard stale async results
  private previewGeneration = 0;
  private previewDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private statusResetTimer: ReturnType<typeof setTimeout> | null = null;
  // Coalesces bursts of keystrokes in search mode into one re-filter per frame
  private searchUpdateRaf: number | null = null;

  private homeDir = '/';
  private listFlex = 30;
  private cellHeight = 20;

  // DOM elements
  private breadcrumbEl: HTMLElement;
  private listEl: HTMLElement;
  private previewEl: HTMLElement;
  private previewContentEl: HTMLPreElement;
  private previewMarkdownEl!: HTMLDivElement;
  private statusEl: HTMLElement;
  private bodyEl: HTMLElement;

  constructor(initialCwd: string, container: HTMLElement) {
    this.cwd = initialCwd;
    this.initialCwd = initialCwd;

    this.element = document.createElement('div');
    this.element.className = 'krypton-file-manager';

    // Breadcrumb
    this.breadcrumbEl = document.createElement('div');
    this.breadcrumbEl.className = 'krypton-file-manager__breadcrumb';
    this.element.appendChild(this.breadcrumbEl);

    // Body (list + preview)
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'krypton-file-manager__body';
    this.element.appendChild(this.bodyEl);

    // File list
    this.listEl = document.createElement('div');
    this.listEl.className = 'krypton-file-manager__list';
    this.bodyEl.appendChild(this.listEl);

    // Preview panel
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'krypton-file-manager__preview';
    this.previewContentEl = document.createElement('pre');
    this.previewContentEl.className = 'krypton-file-manager__preview-content';
    this.previewEl.appendChild(this.previewContentEl);
    this.previewMarkdownEl = document.createElement('div');
    this.previewMarkdownEl.className = 'krypton-file-manager__preview-markdown';
    this.previewMarkdownEl.style.display = 'none';
    this.previewEl.appendChild(this.previewMarkdownEl);
    this.bodyEl.appendChild(this.previewEl);

    // Status bar
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'krypton-file-manager__status';
    this.element.appendChild(this.statusEl);

    container.appendChild(this.element);

    getHome().then((h) => { this.homeDir = h; });
    this.loadDirectory(this.cwd);
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  onOpenDiff(cb: (diff: string, title: string) => void): void {
    this.openDiffCallback = cb;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    // AI overlay active — delegate all keys to it
    if (this.aiOverlay) {
      return this.aiOverlay.onKeyDown(e);
    }

    // Confirmation mode — only y/n/Escape
    if (this.confirmAction) {
      if (e.key === 'y') {
        const action = this.confirmAction;
        this.confirmAction = null;
        action();
      } else {
        this.confirmAction = null;
        this.renderStatus();
      }
      return true;
    }

    // Prompt mode — typing into status bar input
    if (this.prompt) {
      return this.handlePromptKey(e);
    }

    // Search mode — fuzzy file search
    if (this.searchMode) {
      return this.handleSearchKey(e);
    }

    // Filter mode — typing into filter
    if (this.filterMode) {
      return this.handleFilterKey(e);
    }

    return this.handleNormalKey(e);
  }

  dispose(): void {
    if (this.previewDebounceTimer !== null) {
      clearTimeout(this.previewDebounceTimer);
      this.previewDebounceTimer = null;
    }
    if (this.statusResetTimer !== null) {
      clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
    }
    this.closeAI();
    this.entries = [];
    this.filteredEntries = [];
    this.searchPool = [];
    this.searchPoolLower = [];
    this.searchResults = [];
    this.cancelSearchUpdate();
    this.marked.clear();
    this.clipboard = null;
    this.prompt = null;
    this.confirmAction = null;
  }

  /** Schedule a status-bar reset, cancelling any previously scheduled reset. */
  private scheduleStatusReset(ms: number): void {
    if (this.statusResetTimer !== null) {
      clearTimeout(this.statusResetTimer);
    }
    this.statusResetTimer = setTimeout(() => {
      this.statusResetTimer = null;
      this.renderStatus();
    }, ms);
  }

  onResize(_width: number, height: number): void {
    this.cellHeight = this.getCellHeight();
    const chromeH = this.breadcrumbEl.offsetHeight + this.statusEl.offsetHeight;
    const available = height - chromeH;
    this.visibleRows = Math.max(1, Math.floor(available / this.cellHeight));
    this.clampScroll();
    this.renderList();
  }

  getWorkingDirectory(): string | null {
    return this.cwd;
  }

  // ─── Key Handlers ──────────────────────────────────────────────

  private handleNormalKey(e: KeyboardEvent): boolean {
    const now = Date.now();
    const key = e.key;

    switch (key) {
      case 'j':
      case 'ArrowDown':
        this.moveCursor(1);
        return true;

      case 'k':
      case 'ArrowUp':
        this.moveCursor(-1);
        return true;

      case 'l':
      case 'Enter':
        this.enterSelected();
        return true;

      case 'h':
      case 'Backspace':
        this.goParent();
        return true;

      case 'g':
        if (this.lastKey === 'g' && now - this.lastKeyTime < 500) {
          this.cursor = 0;
          this.scrollOffset = 0;
          this.renderList();
          this.lastKey = '';
          return true;
        }
        this.lastKey = 'g';
        this.lastKeyTime = now;
        return true;

      case 'J':
        this.scrollPreview(80);
        return true;

      case 'K':
        this.scrollPreview(-80);
        return true;

      case 'H':
        this.resizeSplit(-5);
        return true;

      case 'L':
        this.resizeSplit(5);
        return true;

      case 'G':
        this.cursor = Math.max(0, this.filteredEntries.length - 1);
        this.clampScroll();
        this.renderList();
        return true;

      case 'd':
        if (e.ctrlKey) {
          this.moveCursor(Math.floor(this.visibleRows / 2));
          return true;
        }
        return false;

      case 'u':
        if (e.ctrlKey) {
          this.moveCursor(-Math.floor(this.visibleRows / 2));
          return true;
        }
        return false;

      case '/':
        this.filterMode = true;
        this.filterText = '';
        this.renderStatus();
        return true;

      case 'q':
        this.closeCallback?.();
        return true;

      case 'Escape':
        if (this.marked.size > 0) {
          this.marked.clear();
          this.renderList();
          this.renderStatus();
        }
        return true;

      case '.':
        this.showHidden = !this.showHidden;
        this.loadDirectory(this.cwd);
        return true;

      case 's':
        if (e.shiftKey) {
          // S — reverse sort
          this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          // s — cycle sort field
          const fields: SortField[] = ['name', 'size', 'modified'];
          const idx = fields.indexOf(this.sortField);
          this.sortField = fields[(idx + 1) % fields.length];
        }
        this.applySort();
        this.applyFilter();
        this.cursor = 0;
        this.scrollOffset = 0;
        this.renderList();
        this.renderStatus();
        return true;

      case ' ':
        this.toggleMark();
        return true;

      case 'v':
        if (this.marked.size === this.filteredEntries.length) {
          this.marked.clear();
        } else {
          for (const entry of this.filteredEntries) {
            this.marked.add(entry.path);
          }
        }
        this.renderList();
        this.renderStatus();
        return true;

      case 'y':
        this.yankToClipboard('copy');
        return true;

      case 'x':
        this.yankToClipboard('cut');
        return true;

      case 'D':
        this.deleteMarkedOrCurrent();
        return true;

      case 'r':
        this.renameCurrentEntry();
        return true;

      case 'A':
        this.startPrompt('New file:', '', (name) => this.createFile(name));
        return true;

      case 'M':
        this.startPrompt('New directory:', '', (name) => this.createDirectory(name));
        return true;

      case '~':
        getHome().then((home) => this.loadDirectory(home));
        return true;

      case '-':
        if (this.history.length > 0) {
          const prev = this.history.pop()!;
          this.loadDirectoryNoHistory(prev);
        }
        return true;

      case 'p':
        this.pasteFromClipboard();
        return true;

      case 'o': {
        const entry = this.filteredEntries[this.cursor];
        if (entry && !entry.is_dir) {
          this.previewEl.classList.remove('krypton-file-manager__preview--hidden');
          this.loadPreview();
        }
        return true;
      }

      case 'w':
        this.previewEl.classList.toggle('krypton-file-manager__preview--hidden');
        return true;

      case 'Y':
        this.copyPathToClipboard();
        return true;

      case 'i':
        this.openAI();
        return true;

      case 't':
        void this.trackMarkedOrCurrent();
        return true;

      case 'T':
        void this.openTrackedDiff();
        return true;

      case 'f':
        this.enterSearchMode();
        return true;
    }

    // Didn't match 'g' continuation — reset
    if (key !== 'g') {
      this.lastKey = '';
    }

    return false;
  }

  private handleFilterKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.filterMode = false;
      this.filterText = '';
      this.applyFilter();
      this.cursor = 0;
      this.scrollOffset = 0;
      this.renderList();
      this.renderStatus();
      return true;
    }

    if (e.key === 'Enter') {
      this.filterMode = false;
      this.renderStatus();
      return true;
    }

    if (e.key === 'Backspace') {
      this.filterText = this.filterText.slice(0, -1);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      this.filterText += e.key;
    } else {
      return true;
    }

    this.applyFilter();
    this.cursor = 0;
    this.scrollOffset = 0;
    this.renderList();
    this.renderStatus();
    return true;
  }

  private handlePromptKey(e: KeyboardEvent): boolean {
    if (!this.prompt) return false;

    if (e.key === 'Escape') {
      this.prompt = null;
      this.renderStatus();
      return true;
    }

    if (e.key === 'Enter') {
      const p = this.prompt;
      this.prompt = null;
      p.onSubmit(p.value);
      return true;
    }

    if (e.key === 'Backspace') {
      this.prompt.value = this.prompt.value.slice(0, -1);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      this.prompt.value += e.key;
    }

    this.renderStatus();
    return true;
  }

  // ─── Navigation ────────────────────────────────────────────────

  private moveCursor(delta: number): void {
    if (this.filteredEntries.length === 0) return;
    const len = this.filteredEntries.length;
    const prevCursor = this.cursor;
    const prevScroll = this.scrollOffset;
    this.cursor = ((this.cursor + delta) % len + len) % len;
    this.clampScroll();

    if (!this.searchMode && this.scrollOffset === prevScroll) {
      this.patchCursor(prevCursor, this.cursor);
    } else {
      this.renderList();
    }
  }

  private patchCursor(prev: number, next: number): void {
    const base = this.scrollOffset;
    const items = this.listEl.children;

    const prevIdx = prev - base;
    const nextIdx = next - base;

    if (prevIdx >= 0 && prevIdx < items.length) {
      items[prevIdx].classList.remove('krypton-file-manager__item--cursor');
      (items[prevIdx] as HTMLElement).querySelector('.krypton-file-manager__mark')?.remove();
      const markSpan = document.createElement('span');
      markSpan.className = 'krypton-file-manager__mark';
      const entry = this.filteredEntries[prev];
      markSpan.textContent = entry && this.marked.has(entry.path) ? '\u25cf ' : '  ';
      items[prevIdx].insertBefore(markSpan, items[prevIdx].firstChild);
    }

    if (nextIdx >= 0 && nextIdx < items.length) {
      items[nextIdx].classList.add('krypton-file-manager__item--cursor');
      (items[nextIdx] as HTMLElement).querySelector('.krypton-file-manager__mark')?.remove();
      const markSpan = document.createElement('span');
      markSpan.className = 'krypton-file-manager__mark';
      const entry = this.filteredEntries[next];
      markSpan.textContent = entry && this.marked.has(entry.path) ? '\u25cf ' : '  ';
      items[nextIdx].insertBefore(markSpan, items[nextIdx].firstChild);
    }
  }

  private clampScroll(): void {
    if (this.visibleRows <= 0) return;
    if (this.cursor < this.scrollOffset) {
      this.scrollOffset = this.cursor;
    } else if (this.cursor >= this.scrollOffset + this.visibleRows) {
      this.scrollOffset = this.cursor - this.visibleRows + 1;
    }
    this.scrollOffset = Math.max(0, this.scrollOffset);
  }

  private enterSelected(): void {
    const entry = this.filteredEntries[this.cursor];
    if (!entry) return;

    if (entry.is_dir) {
      this.history.push(this.cwd);
      this.loadDirectory(entry.path);
    } else {
      this.previewEl.classList.remove('krypton-file-manager__preview--hidden');
      this.loadPreview();
    }
  }

  private goParent(): void {
    const parent = this.cwd.replace(/\/[^/]+\/?$/, '') || '/';
    if (parent !== this.cwd) {
      this.history.push(this.cwd);
      this.loadDirectory(parent);
    }
  }

  private toggleMark(): void {
    const entry = this.filteredEntries[this.cursor];
    if (!entry) return;
    if (this.marked.has(entry.path)) {
      this.marked.delete(entry.path);
    } else {
      this.marked.add(entry.path);
    }
    this.moveCursor(1);
  }

  // ─── Directory Loading ─────────────────────────────────────────

  private async loadDirectory(path: string): Promise<void> {
    if (!path.startsWith(this.initialCwd)) return;
    try {
      this.entries = await invoke<FileEntry[]>('list_directory', {
        path,
        showHidden: this.showHidden,
      });
    } catch (err) {
      this.entries = [];
      this.setStatusError(`${err}`);
    }

    this.cwd = path;
    this.applySort();
    this.applyFilter();
    this.cursor = 0;
    this.scrollOffset = 0;
    this.marked.clear();
    this.lastPreviewPath = null;
    this.renderBreadcrumb();
    this.renderList();
    this.renderStatus();
    this.clearPreview();
  }

  private async loadDirectoryNoHistory(path: string): Promise<void> {
    if (!path.startsWith(this.initialCwd)) return;
    try {
      this.entries = await invoke<FileEntry[]>('list_directory', {
        path,
        showHidden: this.showHidden,
      });
    } catch (err) {
      this.entries = [];
      this.setStatusError(`${err}`);
    }

    this.cwd = path;
    this.applySort();
    this.applyFilter();
    this.cursor = 0;
    this.scrollOffset = 0;
    this.marked.clear();
    this.lastPreviewPath = null;
    this.renderBreadcrumb();
    this.renderList();
    this.renderStatus();
    this.clearPreview();
  }

  /** Reload current directory without resetting cursor position or marks. */
  private async refreshDirectory(): Promise<void> {
    const prevName = this.filteredEntries[this.cursor]?.name ?? null;
    const prevMarked = new Set(this.marked);

    try {
      this.entries = await invoke<FileEntry[]>('list_directory', {
        path: this.cwd,
        showHidden: this.showHidden,
      });
    } catch (err) {
      this.entries = [];
      this.setStatusError(`${err}`);
    }

    this.applySort();
    this.applyFilter();

    // Restore marks for entries that still exist
    this.marked.clear();
    for (const entry of this.filteredEntries) {
      if (prevMarked.has(entry.path)) {
        this.marked.add(entry.path);
      }
    }

    // Restore cursor to same file name, or clamp
    if (prevName) {
      const idx = this.filteredEntries.findIndex((e) => e.name === prevName);
      if (idx >= 0) {
        this.cursor = idx;
      } else {
        this.cursor = Math.min(this.cursor, Math.max(0, this.filteredEntries.length - 1));
      }
    } else {
      this.cursor = 0;
    }

    this.clampScroll();
    this.lastPreviewPath = null;
    this.renderBreadcrumb();
    this.renderList();
    this.renderStatus();
    this.clearPreview();
  }

  // ─── Sorting & Filtering ───────────────────────────────────────

  private applySort(): void {
    const dir = this.sortOrder === 'asc' ? 1 : -1;
    this.entries.sort((a, b) => {
      // Directories always first
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

      switch (this.sortField) {
        case 'name':
          return dir * a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        case 'size':
          return dir * (a.size - b.size);
        case 'modified':
          return dir * (a.modified - b.modified);
        default:
          return 0;
      }
    });
  }

  private applyFilter(): void {
    if (!this.filterText) {
      this.filteredEntries = [...this.entries];
      return;
    }
    const lower = this.filterText.toLowerCase();
    this.filteredEntries = this.entries.filter((e) => {
      // Fuzzy match: all chars must appear in order
      let fi = 0;
      const name = e.name.toLowerCase();
      for (let ni = 0; ni < name.length && fi < lower.length; ni++) {
        if (name[ni] === lower[fi]) fi++;
      }
      return fi === lower.length;
    });
  }

  // ─── Preview ───────────────────────────────────────────────────

  private scrollPreview(delta: number): void {
    const target = this.previewMarkdownEl.style.display !== 'none'
      ? this.previewMarkdownEl
      : this.previewContentEl;
    target.scrollBy({ top: delta, behavior: 'smooth' });
  }

  private resizeSplit(delta: number): void {
    this.listFlex = Math.max(15, Math.min(85, this.listFlex + delta));
    this.listEl.style.flex = String(this.listFlex);
    this.previewEl.style.flex = String(100 - this.listFlex);
  }

  private clearPreview(): void {
    this.lastPreviewPath = null;
    this.previewContentEl.style.display = '';
    this.previewMarkdownEl.style.display = 'none';
    this.previewContentEl.textContent = '';
  }

  /** Show the <pre> element and hide the markdown <div> */
  private showPreText(text: string): void {
    this.previewContentEl.style.display = '';
    this.previewMarkdownEl.style.display = 'none';
    this.previewContentEl.textContent = text;
  }

  /** Render markdown into the preview panel; prepend a skill spec card when applicable. */
  private renderMarkdownPreview(content: string, absPath: string): void {
    const { frontmatter, body } = parseSkillFrontmatter(content);
    const isSkill = isSkillPath(absPath) || isSkillFrontmatter(frontmatter);

    let html = '';
    if (isSkill && frontmatter) {
      html = renderSkillSpec(frontmatter) + (md.parse(body, { gfm: true, breaks: true }) as string);
    } else if (frontmatter && Object.keys(frontmatter).length > 0) {
      html = renderFrontmatterCard(frontmatter) + (md.parse(body, { gfm: true, breaks: true }) as string);
    } else {
      html = md.parse(content, { gfm: true, breaks: true }) as string;
    }

    this.previewContentEl.style.display = 'none';
    this.previewMarkdownEl.style.display = '';
    this.previewMarkdownEl.innerHTML = html;

    for (const img of this.previewMarkdownEl.querySelectorAll('img')) {
      (img as HTMLElement).style.maxWidth = '100%';
    }
  }

  private loadPreview(): void {
    if (this.previewDebounceTimer !== null) {
      clearTimeout(this.previewDebounceTimer);
    }
    this.previewDebounceTimer = setTimeout(() => {
      this.previewDebounceTimer = null;
      this.loadPreviewNow();
    }, 80);
  }

  private async loadPreviewNow(): Promise<void> {
    const entry = this.filteredEntries[this.cursor];
    if (!entry) {
      this.showPreText('');
      this.lastPreviewPath = null;
      return;
    }

    // Skip if we already previewed this exact path
    if (entry.path === this.lastPreviewPath) return;
    this.lastPreviewPath = entry.path;
    this.previewEl.scrollTop = 0;

    // Bump generation so any in-flight async preview is discarded
    const gen = ++this.previewGeneration;

    if (entry.is_dir) {
      try {
        const children = await invoke<FileEntry[]>('list_directory', {
          path: entry.path,
          showHidden: this.showHidden,
        });
        if (gen !== this.previewGeneration) return;
        const dirs = children.filter((c) => c.is_dir).length;
        const files = children.length - dirs;
        this.showPreText(`Directory: ${entry.name}/\n\n${dirs} directories, ${files} files`);
      } catch {
        if (gen !== this.previewGeneration) return;
        this.showPreText(`Directory: ${entry.name}/\n\n(cannot read)`);
      }
      return;
    }

    if (entry.size > PREVIEW_MAX_BYTES) {
      this.showPreText(`File too large for preview\n${this.formatSize(entry.size)}`);
      return;
    }

    if (this.isBinaryExtension(entry.name)) {
      this.showPreText(`Binary file\n${this.formatSize(entry.size)}`);
      return;
    }

    try {
      const content = await invoke<string>('read_file', { path: entry.path });
      // Discard result if cursor moved while we were reading
      if (gen !== this.previewGeneration) return;

      // Render markdown files
      if (this.isMarkdownFile(entry.name)) {
        this.renderMarkdownPreview(content, entry.path);
        return;
      }

      // Syntax highlight using file extension
      this.previewContentEl.style.display = '';
      this.previewMarkdownEl.style.display = 'none';
      const lang = this.extToLang(entry.name);
      if (lang && hljs.getLanguage(lang)) {
        const result = hljs.highlight(content, { language: lang });
        this.previewContentEl.innerHTML = result.value;
      } else {
        const result = hljs.highlightAuto(content);
        this.previewContentEl.innerHTML = result.value;
      }
    } catch {
      if (gen !== this.previewGeneration) return;
      this.previewContentEl.style.display = '';
      this.previewMarkdownEl.style.display = 'none';
      this.previewContentEl.textContent = `Cannot read file\n${this.formatSize(entry.size)}`;
    }
  }

  // ─── File Operations ───────────────────────────────────────────

  private copyPathToClipboard(): void {
    const entry = this.filteredEntries[this.cursor];
    if (!entry) return;
    navigator.clipboard.writeText(entry.path).then(() => {
      this.statusEl.textContent = `Copied: ${entry.path}`;
      this.scheduleStatusReset(2000);
    });
  }

  private getMarkedOrCurrentFiles(): FileEntry[] {
    if (this.marked.size > 0) {
      return this.filteredEntries.filter((entry) => !entry.is_dir && this.marked.has(entry.path));
    }
    const entry = this.filteredEntries[this.cursor];
    return entry && !entry.is_dir ? [entry] : [];
  }

  private async trackMarkedOrCurrent(): Promise<void> {
    const files = this.getMarkedOrCurrentFiles();
    if (files.length === 0) {
      this.setStatusError('No file selected to track');
      return;
    }

    let tracked = 0;
    for (const file of files) {
      try {
        const content = await invoke<string>('read_file', { path: file.path });
        this.trackedFiles.set(file.path, content);
        tracked++;
      } catch (err) {
        this.setStatusError(`Track failed: ${err}`);
        return;
      }
    }

    this.statusEl.textContent = `Tracking ${tracked} file${tracked === 1 ? '' : 's'}`;
    this.statusEl.className = 'krypton-file-manager__status';
    this.scheduleStatusReset(2000);
  }

  private async openTrackedDiff(): Promise<void> {
    if (!this.openDiffCallback) return;

    const selected = this.getMarkedOrCurrentFiles();
    const paths = selected.length > 0
      ? selected.map((entry) => entry.path)
      : Array.from(this.trackedFiles.keys());
    const trackedPaths = paths.filter((path) => this.trackedFiles.has(path));

    if (trackedPaths.length === 0) {
      this.setStatusError('No tracked baseline for selected file');
      return;
    }

    const { createTwoFilesPatch } = await import('diff');
    const patches: string[] = [];
    for (const path of trackedPaths) {
      const oldContent = this.trackedFiles.get(path);
      if (oldContent === undefined) continue;
      try {
        const newContent = await invoke<string>('read_file', { path });
        const patch = createTwoFilesPatch(path, path, oldContent, newContent, 'tracked', 'current');
        patches.push(patch);
      } catch (err) {
        const patch = createTwoFilesPatch(path, '/dev/null', oldContent, '', 'tracked', 'deleted');
        patches.push(patch);
        this.setStatusError(`Read failed, showing deleted diff: ${err}`);
      }
    }

    if (patches.length === 0) {
      this.setStatusError('No tracked files to diff');
      return;
    }

    this.openDiffCallback(patches.join('\n'), `TRACKED DIFF // ${patches.length} file${patches.length === 1 ? '' : 's'}`);
  }

  private deleteMarkedOrCurrent(): void {
    const paths = this.getMarkedOrCurrent();
    if (paths.length === 0) return;

    const names = paths.map((p) => p.split('/').pop()).join(', ');
    const label = paths.length === 1 ? `Delete ${names}?` : `Delete ${paths.length} items?`;

    this.setStatusConfirm(`${label} [y/N]`);
    this.confirmAction = async () => {
      for (const p of paths) {
        try {
          await invoke<string>('run_command', {
            program: 'rm',
            args: ['-rf', p],
            cwd: null,
          });
        } catch (err) {
          this.setStatusError(`Delete failed: ${err}`);
          return;
        }
      }
      this.marked.clear();
      await this.loadDirectory(this.cwd);
    };
  }

  private renameCurrentEntry(): void {
    const entry = this.filteredEntries[this.cursor];
    if (!entry) return;
    this.startPrompt('Rename to:', entry.name, async (newName) => {
      if (!newName || newName === entry.name) return;
      try {
        await invoke<string>('run_command', {
          program: 'mv',
          args: [entry.path, `${this.cwd}/${newName}`],
          cwd: null,
        });
        await this.loadDirectory(this.cwd);
      } catch (err) {
        this.setStatusError(`Rename failed: ${err}`);
      }
    });
  }

  private async createFile(name: string): Promise<void> {
    if (!name) return;
    try {
      await invoke('write_file', { path: `${this.cwd}/${name}`, content: '' });
      await this.loadDirectory(this.cwd);
    } catch (err) {
      this.setStatusError(`Create file failed: ${err}`);
    }
  }

  private async createDirectory(name: string): Promise<void> {
    if (!name) return;
    try {
      await invoke<string>('run_command', {
        program: 'mkdir',
        args: ['-p', `${this.cwd}/${name}`],
        cwd: null,
      });
      await this.loadDirectory(this.cwd);
    } catch (err) {
      this.setStatusError(`mkdir failed: ${err}`);
    }
  }

  private yankToClipboard(op: 'copy' | 'cut'): void {
    const paths = this.getMarkedOrCurrent();
    if (paths.length === 0) return;
    this.clipboard = { paths, op };
    const label = op === 'copy' ? 'Yanked' : 'Cut';
    this.statusEl.textContent = `${label} ${paths.length} item${paths.length > 1 ? 's' : ''}`;
    this.statusEl.className = 'krypton-file-manager__status';
    this.scheduleStatusReset(2000);
  }

  private async pasteFromClipboard(): Promise<void> {
    if (!this.clipboard) {
      this.setStatusError('Nothing in clipboard');
      return;
    }

    const { paths, op } = this.clipboard;

    for (const p of paths) {
      const name = p.split('/').pop()!;
      const srcDir = p.slice(0, p.length - name.length - 1) || '/';
      const sameDir = srcDir === this.cwd;
      let destPath = `${this.cwd}/${name}`;

      if (sameDir && op === 'copy') {
        destPath = this.findUniqueName(name);
      }

      const args = op === 'copy'
        ? ['-r', p, destPath]
        : [p, this.cwd];
      try {
        await invoke<string>('run_command', { program: op === 'copy' ? 'cp' : 'mv', args, cwd: null });
      } catch (err) {
        this.setStatusError(`Paste failed: ${err}`);
        return;
      }
    }

    if (op === 'cut') this.clipboard = null;
    this.marked.clear();
    await this.refreshDirectory();
  }

  private findUniqueName(name: string): string {
    const existing = new Set(this.entries.map((e) => e.name));
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';

    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem} ${i}${ext}`;
      if (!existing.has(candidate)) return `${this.cwd}/${candidate}`;
    }
    return `${this.cwd}/${stem} copy${ext}`;
  }

  // ─── Rendering ─────────────────────────────────────────────────

  private renderBreadcrumb(): void {
    if (this.searchMode) {
      this.breadcrumbEl.classList.add('krypton-file-manager__breadcrumb--search');
      this.breadcrumbEl.textContent = `SEARCH // ${this.searchText}\u2588`;
      return;
    }
    this.breadcrumbEl.classList.remove('krypton-file-manager__breadcrumb--search');
    let display = this.cwd;
    if (this.homeDir !== '/' && display.startsWith(this.homeDir)) {
      display = '~' + display.slice(this.homeDir.length);
    }
    this.breadcrumbEl.textContent = display;
  }

  private renderList(): void {
    this.listEl.innerHTML = '';

    if (this.searchMode) {
      this.renderSearchList();
      return;
    }

    if (this.filteredEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'krypton-file-manager__empty';
      empty.textContent = this.filterText ? 'No matches' : 'Empty directory';
      this.listEl.appendChild(empty);
      return;
    }

    // Calculate visible rows from actual DOM height if not yet set by onResize
    if (this.visibleRows <= 0) {
      const h = this.listEl.clientHeight || this.bodyEl.clientHeight || 600;
      this.visibleRows = Math.max(1, Math.floor(h / this.cellHeight));
    }

    const end = Math.min(this.scrollOffset + this.visibleRows, this.filteredEntries.length);

    const recencyByPath = new Map<string, number>();
    {
      const withMod = this.filteredEntries.filter((e) => e.modified > 0);
      const sorted = [...withMod].sort((a, b) => a.modified - b.modified);
      const n = sorted.length;
      for (let idx = 0; idx < n; idx++) {
        recencyByPath.set(sorted[idx].path, n > 1 ? idx / (n - 1) : 0.5);
      }
    }

    for (let i = this.scrollOffset; i < end; i++) {
      const entry = this.filteredEntries[i];
      const row = document.createElement('div');
      row.className = 'krypton-file-manager__item';

      if (i === this.cursor) row.classList.add('krypton-file-manager__item--cursor');
      if (entry.is_dir) row.classList.add('krypton-file-manager__item--dir');
      if (entry.is_symlink) row.classList.add('krypton-file-manager__item--symlink');
      if (this.marked.has(entry.path)) row.classList.add('krypton-file-manager__item--marked');
      const typeClass = this.fileTypeClass(entry);
      if (typeClass) row.classList.add(typeClass);

      // Mark indicator
      const markSpan = document.createElement('span');
      markSpan.className = 'krypton-file-manager__mark';
      markSpan.textContent = this.marked.has(entry.path) ? '\u25cf ' : '  ';
      row.appendChild(markSpan);

      // Icon
      const iconSpan = document.createElement('span');
      iconSpan.className = 'krypton-file-manager__icon';
      iconSpan.textContent = entry.is_dir ? '\u25b8 ' : '  ';
      row.appendChild(iconSpan);

      // Name
      const nameSpan = document.createElement('span');
      nameSpan.className = 'krypton-file-manager__name';
      let nameText = entry.name;
      if (entry.is_dir) nameText += '/';
      if (entry.is_symlink && entry.symlink_target) {
        nameText += ` \u2192 ${entry.symlink_target}`;
      }
      nameSpan.textContent = nameText;
      row.appendChild(nameSpan);

      // Age bar
      const ageBar = document.createElement('span');
      ageBar.className = 'krypton-file-manager__age-bar';
      const recency = recencyByPath.get(entry.path);
      if (recency !== undefined) {
        const fill = document.createElement('span');
        fill.className = 'krypton-file-manager__age-fill';
        fill.style.width = `${15 + recency * 85}%`;
        // Color ramp: newest → hot amber, middle → orange, oldest → dim red
        const hue = 50 - (1 - recency) * 40; // 50 (yellow) → 10 (red)
        const sat = 85 + recency * 15;       // 85% → 100%
        const light = 35 + recency * 25;     // 35% → 60%
        fill.style.background = `hsl(${hue}, ${sat}%, ${light}%)`;
        fill.style.opacity = `${0.4 + recency * 0.6}`;
        ageBar.appendChild(fill);
      }
      row.appendChild(ageBar);

      // Size (right-aligned, always present for alignment)
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'krypton-file-manager__size';
      if (!entry.is_dir) {
        if (entry.size >= 1024 * 1024) {
          sizeSpan.classList.add('krypton-file-manager__size--mega');
        } else if (entry.size >= 100 * 1024) {
          sizeSpan.classList.add('krypton-file-manager__size--large');
        }
        sizeSpan.textContent = this.formatSize(entry.size);
      }
      row.appendChild(sizeSpan);

      this.listEl.appendChild(row);
    }
  }

  private renderSearchList(): void {
    if (this.searchResults.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'krypton-file-manager__empty';
      empty.textContent = this.searchText ? 'No matches' : 'Loading...';
      this.listEl.appendChild(empty);
      return;
    }

    if (this.visibleRows <= 0) {
      const h = this.listEl.clientHeight || this.bodyEl.clientHeight || 600;
      this.visibleRows = Math.max(1, Math.floor(h / this.cellHeight));
    }

    const end = Math.min(this.searchScrollOffset + this.visibleRows, this.searchResults.length);

    const query = this.searchText.toLowerCase();

    for (let i = this.searchScrollOffset; i < end; i++) {
      const relPath = this.searchResults[i];
      const row = document.createElement('div');
      row.className = 'krypton-file-manager__item';
      if (i === this.searchCursor) row.classList.add('krypton-file-manager__item--cursor');

      // Icon — file icon
      const iconSpan = document.createElement('span');
      iconSpan.className = 'krypton-file-manager__icon';
      iconSpan.textContent = '  ';
      row.appendChild(iconSpan);

      // Name with fuzzy match highlighting
      const nameSpan = document.createElement('span');
      nameSpan.className = 'krypton-file-manager__name';

      if (query && relPath.length > 0) {
        const lower = relPath.toLowerCase();
        let qi = 0;
        let runStart = 0;
        let runMatching = qi < query.length && lower[0] === query[0];
        if (runMatching) qi++;

        for (let ci = 1; ci < relPath.length; ci++) {
          const isMatch = qi < query.length && lower[ci] === query[qi];
          if (isMatch !== runMatching) {
            this.appendNameRun(nameSpan, relPath.slice(runStart, ci), runMatching);
            runStart = ci;
            runMatching = isMatch;
          }
          if (isMatch) qi++;
        }
        this.appendNameRun(nameSpan, relPath.slice(runStart), runMatching);
      } else {
        nameSpan.textContent = relPath;
      }

      row.appendChild(nameSpan);
      this.listEl.appendChild(row);
    }

  }

  private appendNameRun(parent: HTMLElement, text: string, matched: boolean): void {
    if (!text) return;
    if (matched) {
      const mark = document.createElement('span');
      mark.className = 'krypton-file-manager__match';
      mark.textContent = text;
      parent.appendChild(mark);
    } else {
      parent.appendChild(document.createTextNode(text));
    }
  }

  private renderStatus(): void {
    if (this.confirmAction) {
      // Already set by setStatusConfirm
      return;
    }

    if (this.prompt) {
      this.statusEl.textContent = `${this.prompt.label} ${this.prompt.value}\u2588`;
      this.statusEl.className = 'krypton-file-manager__status krypton-file-manager__status--prompt';
      return;
    }

    if (this.searchMode) {
      let text = `${this.searchResults.length} matches`;
      if (this.searchCapped) text += ' (capped)';
      text += ` \u2502 ${this.searchPool.length} files indexed`;
      this.statusEl.textContent = text;
      this.statusEl.className = 'krypton-file-manager__status krypton-file-manager__status--filter';
      return;
    }

    if (this.filterMode) {
      this.statusEl.textContent = `/${this.filterText}\u2588  (${this.filteredEntries.length} matches)`;
      this.statusEl.className = 'krypton-file-manager__status krypton-file-manager__status--filter';
      return;
    }

    this.statusEl.className = 'krypton-file-manager__status';

    const parts: string[] = [];
    parts.push(`${this.filteredEntries.length} items`);
    if (this.marked.size > 0) {
      parts.push(`${this.marked.size} marked`);
    }
    if (this.trackedFiles.size > 0) {
      parts.push(`${this.trackedFiles.size} tracked`);
    }

    const sortArrow = this.sortOrder === 'asc' ? '\u2191' : '\u2193';
    parts.push(`sort: ${this.sortField} ${sortArrow}`);

    if (this.clipboard) {
      const icon = this.clipboard.op === 'copy' ? '\u2398' : '\u2702';
      parts.push(`${icon} ${this.clipboard.paths.length}`);
    }

    if (this.showHidden) {
      parts.push('hidden: on');
    }

    // Current entry info
    const entry = this.filteredEntries[this.cursor];
    if (entry) {
      parts.push(entry.permissions);
      if (!entry.is_dir) {
        parts.push(this.formatSize(entry.size));
      }
    }

    this.statusEl.textContent = parts.join(' \u2502 ');
  }

  // ─── Fuzzy File Search ──────────────────────────────────────────

  private async enterSearchMode(): Promise<void> {
    this.searchMode = true;
    this.searchText = '';
    this.searchCursor = 0;
    this.searchScrollOffset = 0;
    this.searchRoot = this.initialCwd;
    this.searchResults = [];
    this.searchCapped = false;
    this.renderBreadcrumb();
    this.renderStatus();
    this.renderList();

    try {
      const files = await invoke<string[]>('search_files', {
        root: this.initialCwd,
        showHidden: this.showHidden,
      });
      this.searchCapped = files.length >= 50_000;
      this.searchPool = files;
      this.searchPoolLower = files.map((f) => f.toLowerCase());
    } catch (err) {
      this.searchPool = [];
      this.searchPoolLower = [];
      this.setStatusError(`${err}`);
    }

    this.applySearch();
    this.renderList();
    this.renderStatus();
  }

  private handleSearchKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.searchMode = false;
      this.searchText = '';
      this.searchPool = [];
      this.searchPoolLower = [];
      this.searchResults = [];
      this.cancelSearchUpdate();
      this.renderBreadcrumb();
      this.renderList();
      this.renderStatus();
      return true;
    }

    if (e.key === 'Enter') {
      this.selectSearchResult();
      return true;
    }

    if (e.key === 'ArrowDown' || (e.key === 'j' && e.ctrlKey)) {
      this.moveSearchCursor(1);
      return true;
    }

    if (e.key === 'ArrowUp' || (e.key === 'k' && e.ctrlKey)) {
      this.moveSearchCursor(-1);
      return true;
    }

    if (e.key === 'u' && e.ctrlKey) {
      this.searchText = '';
      this.renderBreadcrumb();
      this.scheduleSearchUpdate();
      return true;
    }

    if (e.key === 'Backspace') {
      this.searchText = this.searchText.slice(0, -1);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      this.searchText += e.key;
    } else {
      return true;
    }

    // Synchronous: render the typed character immediately so the user sees feedback.
    this.renderBreadcrumb();
    // Asynchronous: coalesce burst keystrokes into one filter+render per frame.
    this.scheduleSearchUpdate();
    return true;
  }

  private scheduleSearchUpdate(): void {
    if (this.searchUpdateRaf !== null) return;
    this.searchUpdateRaf = requestAnimationFrame(() => {
      this.searchUpdateRaf = null;
      if (!this.searchMode) return;
      this.applySearch();
      this.searchCursor = 0;
      this.searchScrollOffset = 0;
      this.renderList();
      this.renderStatus();
      this.loadSearchPreview();
    });
  }

  private cancelSearchUpdate(): void {
    if (this.searchUpdateRaf !== null) {
      cancelAnimationFrame(this.searchUpdateRaf);
      this.searchUpdateRaf = null;
    }
  }

  private applySearch(): void {
    if (!this.searchText) {
      this.searchResults = this.searchPool.slice(0, 500);
      return;
    }

    const query = this.searchText.toLowerCase();
    const scored: { path: string; score: number }[] = [];
    const pool = this.searchPool;
    const poolLower = this.searchPoolLower;

    for (let i = 0; i < pool.length; i++) {
      const score = this.fuzzyScore(poolLower[i], query);
      if (score > 0) {
        scored.push({ path: pool[i], score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    this.searchResults = scored.slice(0, 500).map((s) => s.path);
  }

  /** Fuzzy score: higher is better, 0 means no match */
  private fuzzyScore(target: string, query: string): number {
    const qLen = query.length;
    const tLen = target.length;
    if (qLen > tLen) return 0;

    let qi = 0;
    let score = 0;
    let consecutive = 0;
    let prevMatchIdx = -2;
    let qChar = query.charCodeAt(0);

    for (let ti = 0; ti < tLen; ti++) {
      // Early exit: remaining target chars can't cover remaining query chars.
      if (tLen - ti < qLen - qi) return 0;

      if (target.charCodeAt(ti) === qChar) {
        score += 1;

        if (ti === prevMatchIdx + 1) {
          consecutive++;
          score += consecutive * 2;
        } else {
          consecutive = 0;
        }

        // Word boundary bonus: after / . _ -
        if (ti === 0) {
          score += 5;
        } else {
          const prev = target.charCodeAt(ti - 1);
          // / . _ -  →  47 46 95 45
          if (prev === 47 || prev === 46 || prev === 95 || prev === 45) {
            score += 5;
          }
        }

        prevMatchIdx = ti;
        qi++;
        if (qi >= qLen) break;
        qChar = query.charCodeAt(qi);
      }
    }

    if (qi < qLen) return 0;

    // Basename match bonus: if all query chars matched within the filename portion
    const lastSlash = target.lastIndexOf('/');
    const basenameStart = lastSlash >= 0 ? lastSlash + 1 : 0;
    let bi = 0;
    for (let ci = basenameStart; ci < tLen && bi < qLen; ci++) {
      if (target.charCodeAt(ci) === query.charCodeAt(bi)) bi++;
    }
    if (bi === qLen) {
      score += 10;
      // Exact basename prefix bonus
      if (tLen - basenameStart >= qLen) {
        let prefix = true;
        for (let k = 0; k < qLen; k++) {
          if (target.charCodeAt(basenameStart + k) !== query.charCodeAt(k)) {
            prefix = false;
            break;
          }
        }
        if (prefix) score += 15;
      }
    }

    return score;
  }

  private moveSearchCursor(delta: number): void {
    if (this.searchResults.length === 0) return;
    const len = this.searchResults.length;
    this.searchCursor = ((this.searchCursor + delta) % len + len) % len;
    this.clampSearchScroll();
    this.renderList();
    this.loadSearchPreview();
  }

  private clampSearchScroll(): void {
    if (this.visibleRows <= 0) return;
    if (this.searchCursor < this.searchScrollOffset) {
      this.searchScrollOffset = this.searchCursor;
    } else if (this.searchCursor >= this.searchScrollOffset + this.visibleRows) {
      this.searchScrollOffset = this.searchCursor - this.visibleRows + 1;
    }
    this.searchScrollOffset = Math.max(0, this.searchScrollOffset);
  }

  private selectSearchResult(): void {
    const relPath = this.searchResults[this.searchCursor];
    if (!relPath) return;

    const absPath = this.searchRoot + '/' + relPath;
    const lastSlash = absPath.lastIndexOf('/');
    const dir = lastSlash > 0 ? absPath.slice(0, lastSlash) : '/';
    const fileName = absPath.slice(lastSlash + 1);

    // Exit search mode
    this.searchMode = false;
    this.searchText = '';
    this.searchPool = [];
    this.searchPoolLower = [];
    this.searchResults = [];
    this.cancelSearchUpdate();

    // Navigate to the file's directory, then highlight the file
    this.history.push(this.cwd);
    this.loadDirectoryAndSelect(dir, fileName);
  }

  /** Load a directory and set cursor to the entry matching `selectName`. */
  private async loadDirectoryAndSelect(path: string, selectName: string): Promise<void> {
    try {
      this.entries = await invoke<FileEntry[]>('list_directory', {
        path,
        showHidden: this.showHidden,
      });
    } catch (err) {
      this.entries = [];
      this.setStatusError(`${err}`);
    }

    this.cwd = path;
    this.applySort();
    this.applyFilter();
    this.marked.clear();
    this.lastPreviewPath = null;

    // Find the file in the listing
    const idx = this.filteredEntries.findIndex((e) => e.name === selectName);
    this.cursor = idx >= 0 ? idx : 0;
    this.scrollOffset = 0;
    this.clampScroll();

    this.renderBreadcrumb();
    this.renderList();
    this.renderStatus();

    // Auto-open preview for the selected file
    if (idx >= 0 && !this.filteredEntries[idx].is_dir) {
      this.previewEl.classList.remove('krypton-file-manager__preview--hidden');
    }
    this.loadPreview();
  }

  private loadSearchPreview(): void {
    const relPath = this.searchResults[this.searchCursor];
    if (!relPath) return;
    const absPath = this.searchRoot + '/' + relPath;
    // Reuse the preview system — temporarily set lastPreviewPath to force reload
    this.lastPreviewPath = null;
    this.loadPreviewForPath(absPath, relPath.split('/').pop() ?? relPath);
  }

  /** Load preview for an arbitrary absolute path (used by search mode). */
  private loadPreviewForPath(absPath: string, displayName: string): void {
    if (this.previewDebounceTimer !== null) {
      clearTimeout(this.previewDebounceTimer);
    }
    this.previewDebounceTimer = setTimeout(async () => {
      this.previewDebounceTimer = null;
      const gen = ++this.previewGeneration;

      if (this.isBinaryExtension(displayName)) {
        if (gen !== this.previewGeneration) return;
        this.showPreText(`[binary file]`);
        return;
      }

      try {
        const content = await invoke<string>('read_file', { path: absPath });
        if (gen !== this.previewGeneration) return;

        if (this.isMarkdownFile(displayName)) {
          this.renderMarkdownPreview(content, absPath);
        } else {
          const lang = this.extToLang(displayName);
          const lines = content.split('\n');
          const truncated = lines.length > 200
            ? lines.slice(0, 200).join('\n') + '\n\n... (truncated)'
            : content;
          if (lang) {
            this.previewContentEl.style.display = '';
            this.previewMarkdownEl.style.display = 'none';
            this.previewContentEl.innerHTML = hljs.highlight(truncated, { language: lang }).value;
          } else {
            this.showPreText(truncated);
          }
        }
      } catch {
        if (gen !== this.previewGeneration) return;
        this.showPreText('[cannot read file]');
      }
    }, 80);
  }

  // ─── AI Overlay ────────────────────────────────────────────────

  private async openAI(): Promise<void> {
    if (this.aiOverlay) return;

    const { FileManagerAI } = await import('./file-manager-ai');

    this.aiOverlay = new FileManagerAI({
      cwd: this.cwd,
      getContext: () => this.getAIContext(),
      onDone: () => this.refreshDirectory(),
      onClose: () => this.closeAI(),
    });

    this.aiOverlay.open(this.element);
  }

  private closeAI(): void {
    if (!this.aiOverlay) return;
    this.aiOverlay.close();
    this.aiOverlay = null;
  }

  private getAIContext(): FileManagerContext {
    const cursorEntry = this.filteredEntries[this.cursor] ?? null;
    const cursorFile: FileContextEntry | null = cursorEntry
      ? { name: cursorEntry.name, path: cursorEntry.path, is_dir: cursorEntry.is_dir, size: cursorEntry.size }
      : null;

    const markedFiles: FileContextEntry[] = [];
    for (const entry of this.filteredEntries) {
      if (this.marked.has(entry.path)) {
        markedFiles.push({ name: entry.name, path: entry.path, is_dir: entry.is_dir, size: entry.size });
      }
    }

    return {
      cwd: this.cwd,
      cursorFile,
      markedFiles,
      totalEntries: this.filteredEntries.length,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /** Read the terminal cell height from the CSS variable, fallback to 20px */
  private getCellHeight(): number {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue('--krypton-terminal-cell-height')
      .trim();
    const px = parseFloat(val);
    return px > 0 ? px : 20;
  }

  private getMarkedOrCurrent(): string[] {
    if (this.marked.size > 0) {
      return [...this.marked];
    }
    const entry = this.filteredEntries[this.cursor];
    return entry ? [entry.path] : [];
  }

  private startPrompt(label: string, initial: string, onSubmit: (value: string) => void): void {
    this.prompt = { label, value: initial, onSubmit };
    this.renderStatus();
  }

  private setStatusError(msg: string): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = 'krypton-file-manager__status krypton-file-manager__status--error';
    this.scheduleStatusReset(3000);
  }

  private setStatusConfirm(msg: string): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = 'krypton-file-manager__status krypton-file-manager__status--confirm';
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
  }

  /** Map file extension to highlight.js language name */
  private extToLang(name: string): string | null {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      rs: 'rust', py: 'python', rb: 'ruby', go: 'go', java: 'java',
      c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
      cs: 'csharp', swift: 'swift', kt: 'kotlin', scala: 'scala',
      sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
      html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
      xml: 'xml', sql: 'sql', graphql: 'graphql',
      dockerfile: 'dockerfile', makefile: 'makefile',
      lua: 'lua', r: 'r', dart: 'dart', zig: 'zig',
      ex: 'elixir', exs: 'elixir', erl: 'erlang',
      hs: 'haskell', ml: 'ocaml', clj: 'clojure',
      vim: 'vim', el: 'lisp', lisp: 'lisp',
      php: 'php', pl: 'perl', pm: 'perl',
    };
    // Handle dotfiles like Makefile, Dockerfile
    const basename = name.toLowerCase();
    if (basename === 'makefile' || basename === 'gnumakefile') return 'makefile';
    if (basename === 'dockerfile') return 'dockerfile';
    return map[ext] ?? null;
  }

  /** Return a CSS modifier class for file type colouring, or '' for unknown types. */
  private fileTypeClass(entry: FileEntry): string {
    if (entry.is_dir || entry.is_symlink) return '';
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
    const base = entry.name.toLowerCase();
    if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'].includes(ext)) return 'krypton-file-manager__item--ft-script';
    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go',
         'c', 'cpp', 'cc', 'h', 'hpp', 'java', 'kt', 'swift', 'rb', 'php',
         'lua', 'zig', 'cs', 'scala', 'r', 'dart', 'ex', 'exs', 'erl',
         'hs', 'ml', 'clj', 'el', 'lisp', 'pl', 'pm', 'vim'].includes(ext)
        || base === 'makefile' || base === 'gnumakefile' || base === 'dockerfile') return 'krypton-file-manager__item--ft-code';
    if (['json', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'lock', 'env'].includes(ext)
        || base.startsWith('.') && ['gitignore', 'editorconfig', 'eslintrc', 'prettierrc',
           'babelrc', 'npmrc', 'env', 'envrc'].some(s => base.endsWith(s))) return 'krypton-file-manager__item--ft-config';
    if (['html', 'htm', 'css', 'scss', 'less', 'xml', 'svg', 'graphql', 'gql'].includes(ext)) return 'krypton-file-manager__item--ft-markup';
    if (['md', 'markdown', 'txt', 'rst', 'pdf', 'doc', 'docx'].includes(ext)) return 'krypton-file-manager__item--ft-doc';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'avif', 'tiff', 'tif'].includes(ext)) return 'krypton-file-manager__item--ft-image';
    if (['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv'].includes(ext)) return 'krypton-file-manager__item--ft-media';
    if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst'].includes(ext)) return 'krypton-file-manager__item--ft-archive';
    if (['csv', 'sql', 'db', 'sqlite', 'sqlite3', 'parquet'].includes(ext)) return 'krypton-file-manager__item--ft-data';
    return '';
  }

  private isMarkdownFile(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'md' || ext === 'markdown';
  }

  private isBinaryExtension(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const binary = new Set([
      'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
      'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
      'mp4', 'avi', 'mkv', 'mov', 'webm',
      'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class',
      'wasm', 'ttf', 'otf', 'woff', 'woff2', 'eot',
    ]);
    return binary.has(ext);
  }
}
