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

export class FileManagerView implements ContentView {
  readonly type: PaneContentType = 'file_manager';
  readonly element: HTMLElement;

  private cwd = '';
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
  private showHidden = false;
  private history: string[] = [];
  private prompt: PromptState | null = null;
  private confirmAction: (() => void) | null = null;
  private closeCallback: (() => void) | null = null;
  private lastPreviewPath: string | null = null;
  private aiOverlay: FileManagerAI | null = null;

  // Vim-style gg detection
  private lastKey = '';
  private lastKeyTime = 0;

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

    this.loadDirectory(this.cwd);
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
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

    // Filter mode — typing into filter
    if (this.filterMode) {
      return this.handleFilterKey(e);
    }

    return this.handleNormalKey(e);
  }

  dispose(): void {
    // No persistent resources to clean up
  }

  onResize(_width: number, height: number): void {
    const cellH = this.getCellHeight();
    // Subtract breadcrumb + status bar (each one cell-height row)
    const available = height - cellH * 2;
    this.visibleRows = Math.max(1, Math.floor(available / cellH));
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
          this.loadPreview();
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

      case 'G':
        this.cursor = Math.max(0, this.filteredEntries.length - 1);
        this.clampScroll();
        this.renderList();
        this.loadPreview();
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
        this.loadPreview();
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
        if (this.marked.size > 0) {
          this.startPrompt('Copy to:', '', (dest) => this.doBatchOp('cp', dest));
        }
        return true;

      case 'm':
        if (this.marked.size > 0) {
          this.startPrompt('Move to:', '', (dest) => this.doBatchOp('mv', dest));
        }
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
        this.previewEl.classList.toggle('krypton-file-manager__preview--hidden');
        return true;

      case 'o': {
        const entry = this.filteredEntries[this.cursor];
        if (entry && !entry.is_dir) {
          this.previewEl.classList.remove('krypton-file-manager__preview--hidden');
          this.loadPreview();
        }
        return true;
      }

      case 'i':
        this.openAI();
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
      this.loadPreview();
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
    this.loadPreview();
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
    this.cursor = Math.max(0, Math.min(this.filteredEntries.length - 1, this.cursor + delta));
    this.clampScroll();
    this.renderList();
    this.loadPreview();
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
    this.loadPreview();
  }

  private async loadDirectoryNoHistory(path: string): Promise<void> {
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
    this.loadPreview();
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
    this.loadPreview();
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
    target.scrollBy({ top: delta });
  }

  /** Show the <pre> element and hide the markdown <div> */
  private showPreText(text: string): void {
    this.previewContentEl.style.display = '';
    this.previewMarkdownEl.style.display = 'none';
    this.previewContentEl.textContent = text;
  }

  private async loadPreview(): Promise<void> {
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

    if (entry.is_dir) {
      try {
        const children = await invoke<FileEntry[]>('list_directory', {
          path: entry.path,
          showHidden: this.showHidden,
        });
        const dirs = children.filter((c) => c.is_dir).length;
        const files = children.length - dirs;
        this.showPreText(`Directory: ${entry.name}/\n\n${dirs} directories, ${files} files`);
      } catch {
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
      const lines = content.split('\n');
      const truncated = lines.length > 200;
      const text = truncated ? lines.slice(0, 200).join('\n') : content;

      // Render markdown files
      if (this.isMarkdownFile(entry.name)) {
        const rendered = md.parse(text) as string;
        this.previewContentEl.style.display = 'none';
        this.previewMarkdownEl.style.display = '';
        this.previewMarkdownEl.innerHTML = rendered
          + (truncated ? '<p style="opacity:0.4">... (truncated)</p>' : '');
        return;
      }

      // Syntax highlight using file extension
      this.previewContentEl.style.display = '';
      this.previewMarkdownEl.style.display = 'none';
      const lang = this.extToLang(entry.name);
      if (lang && hljs.getLanguage(lang)) {
        const result = hljs.highlight(text, { language: lang });
        this.previewContentEl.innerHTML = result.value
          + (truncated ? '\n\n<span style="opacity:0.4">... (truncated)</span>' : '');
      } else {
        // Auto-detect language
        const result = hljs.highlightAuto(text);
        this.previewContentEl.innerHTML = result.value
          + (truncated ? '\n\n<span style="opacity:0.4">... (truncated)</span>' : '');
      }
    } catch {
      this.previewContentEl.style.display = '';
      this.previewMarkdownEl.style.display = 'none';
      this.previewContentEl.textContent = `Cannot read file\n${this.formatSize(entry.size)}`;
    }
  }

  // ─── File Operations ───────────────────────────────────────────

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

  private async doBatchOp(op: 'cp' | 'mv', dest: string): Promise<void> {
    const paths = this.getMarkedOrCurrent();
    if (paths.length === 0 || !dest) return;

    // Resolve relative paths against cwd
    const destPath = dest.startsWith('/') ? dest : `${this.cwd}/${dest}`;

    for (const p of paths) {
      const args = op === 'cp' ? ['-r', p, destPath] : [p, destPath];
      try {
        await invoke<string>('run_command', {
          program: op,
          args,
          cwd: null,
        });
      } catch (err) {
        this.setStatusError(`${op} failed: ${err}`);
        return;
      }
    }

    this.marked.clear();
    await this.loadDirectory(this.cwd);
  }

  // ─── Rendering ─────────────────────────────────────────────────

  private async renderBreadcrumb(): Promise<void> {
    const home = await getHome();
    let display = this.cwd;
    if (home !== '/' && display.startsWith(home)) {
      display = '~' + display.slice(home.length);
    }
    this.breadcrumbEl.textContent = display;
  }

  private renderList(): void {
    this.listEl.innerHTML = '';

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
      this.visibleRows = Math.max(1, Math.floor(h / this.getCellHeight()));
    }

    const end = Math.min(this.scrollOffset + this.visibleRows, this.filteredEntries.length);

    // Top spacer for virtual scrolling
    if (this.scrollOffset > 0) {
      const spacer = document.createElement('div');
      spacer.style.height = `${this.scrollOffset * this.getCellHeight()}px`;
      this.listEl.appendChild(spacer);
    }

    for (let i = this.scrollOffset; i < end; i++) {
      const entry = this.filteredEntries[i];
      const row = document.createElement('div');
      row.className = 'krypton-file-manager__item';

      if (i === this.cursor) row.classList.add('krypton-file-manager__item--cursor');
      if (entry.is_dir) row.classList.add('krypton-file-manager__item--dir');
      if (entry.is_symlink) row.classList.add('krypton-file-manager__item--symlink');
      if (this.marked.has(entry.path)) row.classList.add('krypton-file-manager__item--marked');

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

      // Size (right-aligned, files only)
      if (!entry.is_dir) {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'krypton-file-manager__size';
        sizeSpan.textContent = this.formatSize(entry.size);
        row.appendChild(sizeSpan);
      }

      this.listEl.appendChild(row);
    }

    // Bottom spacer
    const remaining = this.filteredEntries.length - end;
    if (remaining > 0) {
      const spacer = document.createElement('div');
      spacer.style.height = `${remaining * this.getCellHeight()}px`;
      this.listEl.appendChild(spacer);
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

    const sortArrow = this.sortOrder === 'asc' ? '\u2191' : '\u2193';
    parts.push(`sort: ${this.sortField} ${sortArrow}`);

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
    setTimeout(() => this.renderStatus(), 3000);
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
