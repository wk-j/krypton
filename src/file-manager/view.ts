// Krypton — File Manager View (spec 317).
// Keyboard-driven file browser as a ContentView pane. This class is the thin
// orchestrator: it owns the state object, the timers and the components, and
// calls `ops.ts` for every Tauri call. The render hooks are called from exactly
// the sites the pre-317 view called them from; components only change *how* a
// region paints.

import type { ContentView, PaneContentType } from '../types';
import type { FileManagerAI } from '../file-manager-ai';
import { el } from '../ui/dom';
import { Breadcrumb } from './components/breadcrumb';
import { FileList } from './components/file-list';
import { PreviewPane } from './components/preview-pane';
import { SearchList } from './components/search-list';
import { StatusBar } from './components/status-bar';
import { filterEntries } from './filter';
import { rankSearch } from './fuzzy';
import { KeyChord, NORMAL_KEYMAP, dispatchNormalKey, type KeyCtx } from './keymap';
import { handleConfirmKey, handleFilterKey, handlePromptKey, handleSearchKey, resetSearch, type ModeCtx } from './modes';
import * as ops from './ops';
import { PreviewController } from './preview/controller';
import type { PreviewTarget } from './preview/registry';
import { ListGlide } from './smooth-scroll';
import { sortEntries } from './sort';
import {
  SEARCH_POOL_CAP,
  aiContext,
  clampScroll,
  createState,
  currentEntry,
  markedOrCurrentFiles,
  marksOrCurrent,
  parentDir,
  restoreSelection,
  selectBreadcrumb,
  selectFileList,
  selectSearchList,
  selectStatus,
  uniqueCopyPath,
  wrapCursor,
  type FileManagerState,
} from './state';
import type { PreviewOutput, SortField, StatusTone } from './types';

const SORT_FIELDS: readonly SortField[] = ['name', 'size', 'modified'];

/** The output the freshly built preview DOM already shows (an empty `<pre>`). */
const INITIAL_PREVIEW: PreviewOutput = { kind: 'text', text: '' };

export class FileManagerView implements ContentView {
  readonly type: PaneContentType = 'file_manager';
  readonly element: HTMLElement;

  private readonly state: FileManagerState;
  private readonly chord = new KeyChord();
  private closeCallback: (() => void) | null = null;
  private openDiffCallback: ((diff: string, title: string) => void) | null = null;
  private aiOverlay: FileManagerAI | null = null;

  private statusResetTimer: ReturnType<typeof setTimeout> | null = null;
  // Coalesces bursts of keystrokes in search mode into one re-filter per frame
  private searchUpdateRaf: number | null = null;

  // Components / DOM
  private readonly breadcrumb = new Breadcrumb();
  private readonly bodyEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly fileList: FileList;
  private readonly searchList: SearchList;
  private activeList: FileList | SearchList;
  // Smooth scrolling: each list's animated top row. Every frame re-renders the
  // overscanned window around it (see smooth-scroll.ts).
  private readonly fileGlide = new ListGlide(() => this.renderList());
  private readonly searchGlide = new ListGlide(() => this.renderList());
  /** The row array the active glide last scrolled; a new array (listing, filter, search pass) snaps. */
  private glideSource: readonly unknown[] | null = null;
  private readonly preview: PreviewPane;
  private previewOutput: PreviewOutput = INITIAL_PREVIEW;
  private readonly previewCtl: PreviewController;
  private readonly status = new StatusBar();

  private readonly keyCtx: KeyCtx;
  private readonly modeCtx: ModeCtx;

  constructor(initialCwd: string, container: HTMLElement) {
    this.state = createState(initialCwd);
    // The list's pixel offset must match the CSS row height even before onResize.
    this.state.cellHeight = this.getCellHeight();

    this.listEl = el('div', { class: 'krypton-file-manager__list' });
    this.fileList = new FileList(this.listEl);
    this.searchList = new SearchList(this.listEl);
    this.activeList = this.fileList;
    this.preview = new PreviewPane(INITIAL_PREVIEW);
    this.bodyEl = el('div', { class: 'krypton-file-manager__body' }, this.listEl, this.preview.el);
    this.element = el('div', { class: 'krypton-file-manager' }, this.breadcrumb.el, this.bodyEl, this.status.el);

    this.previewCtl = new PreviewController(
      {
        show: (output) => {
          this.previewOutput = output;
          this.renderPreview();
        },
        resetScroll: () => this.preview.resetScroll(),
      },
      (t) => ({
        readText: () => ops.readFile(t.path),
        listDirectory: (path) => ops.listDirectory(path, t.showHidden),
      }),
    );

    this.keyCtx = this.createKeyCtx();
    this.modeCtx = this.createModeCtx();

    container.appendChild(this.element);

    ops.getHome().then((h) => { this.state.homeDir = h; });
    void this.loadDirectory(this.state.cwd);
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  onOpenDiff(cb: (diff: string, title: string) => void): void {
    this.openDiffCallback = cb;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    // AI overlay active — delegate all keys to it
    if (this.aiOverlay) return this.aiOverlay.onKeyDown(e);
    if (this.state.confirmAction) return handleConfirmKey(this.modeCtx, e);
    if (this.state.prompt) return handlePromptKey(this.modeCtx, e);
    if (this.state.search.active) return handleSearchKey(this.modeCtx, e);
    if (this.state.filterMode) return handleFilterKey(this.modeCtx, e);
    return dispatchNormalKey(NORMAL_KEYMAP, this.keyCtx, e);
  }

  dispose(): void {
    this.previewCtl.dispose();
    if (this.statusResetTimer !== null) {
      clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
    }
    this.closeAI();
    const s = this.state;
    s.entries = [];
    s.filtered = [];
    s.search.pool = [];
    s.search.poolLower = [];
    s.search.results = [];
    this.cancelSearchUpdate();
    s.marked.clear();
    s.clipboard = null;
    s.prompt = null;
    s.confirmAction = null;
    // Components only free listeners / row maps; the element stays where the
    // compositor put it, as before.
    this.breadcrumb.dispose();
    this.fileGlide.dispose();
    this.searchGlide.dispose();
    this.fileList.dispose();
    this.searchList.dispose();
    this.preview.dispose();
    this.status.dispose();
  }

  onResize(_width: number, height: number): void {
    const s = this.state;
    s.cellHeight = this.getCellHeight();
    const chromeH = this.breadcrumb.el.offsetHeight + this.status.el.offsetHeight;
    const available = height - chromeH;
    s.visibleRows = Math.max(1, Math.floor(available / s.cellHeight));
    s.scrollOffset = clampScroll(s.cursor, s.scrollOffset, s.visibleRows);
    this.renderList();
  }

  getWorkingDirectory(): string | null {
    return this.state.cwd;
  }

  // ─── Context objects for the keymap and modes ───────────────────

  private createKeyCtx(): KeyCtx {
    const s = this.state;
    return {
      state: s,
      chord: this.chord,
      moveCursor: (d) => this.moveCursor(d),
      jumpTo: (index, mode) => {
        s.cursor = index;
        s.scrollOffset = mode === 'reset-scroll' ? 0 : clampScroll(s.cursor, s.scrollOffset, s.visibleRows);
        this.renderList();
      },
      enterSelected: () => this.enterSelected(),
      goParent: () => this.goParent(),
      goHome: () => { ops.getHome().then((home) => this.loadDirectory(home)); },
      goBack: () => {
        if (s.history.length > 0) {
          const prev = s.history.pop()!;
          void this.loadDirectory(prev);
        }
      },
      scrollPreview: (d) => this.preview.scrollBy(d),
      resizeSplit: (d) => this.resizeSplit(d),
      openPreview: () => {
        const entry = currentEntry(s);
        if (entry && !entry.is_dir) {
          s.previewHidden = false;
          this.renderPreview();
          this.loadPreview();
        }
      },
      togglePreview: () => {
        s.previewHidden = !s.previewHidden;
        this.renderPreview();
      },
      startFilter: () => {
        s.filterMode = true;
        s.filterText = '';
        this.renderStatus();
      },
      startSearch: () => { void this.enterSearchMode(); },
      close: () => this.closeCallback?.(),
      clearMarks: () => {
        if (s.marked.size > 0) {
          s.marked.clear();
          this.renderList();
          this.renderStatus();
        }
      },
      toggleMark: () => this.toggleMark(),
      toggleMarkAll: () => {
        if (s.marked.size === s.filtered.length) {
          s.marked.clear();
        } else {
          for (const entry of s.filtered) s.marked.add(entry.path);
        }
        this.renderList();
        this.renderStatus();
      },
      toggleHidden: () => {
        s.showHidden = !s.showHidden;
        void this.loadDirectory(s.cwd);
      },
      cycleSort: () => {
        s.sortField = SORT_FIELDS[(SORT_FIELDS.indexOf(s.sortField) + 1) % SORT_FIELDS.length];
        this.resort();
      },
      reverseSort: () => {
        s.sortOrder = s.sortOrder === 'asc' ? 'desc' : 'asc';
        this.resort();
      },
      yank: (op) => this.yankToClipboard(op),
      paste: () => { void this.pasteFromClipboard(); },
      deleteSelection: () => this.deleteMarkedOrCurrent(),
      rename: () => this.renameCurrentEntry(),
      promptCreateFile: () => this.startPrompt('New file:', '', (name) => this.createFile(name)),
      promptCreateDir: () => this.startPrompt('New directory:', '', (name) => this.createDirectory(name)),
      copyPath: () => this.copyPathToClipboard(),
      track: () => { void this.trackMarkedOrCurrent(); },
      openTrackedDiff: () => { void this.openTrackedDiff(); },
      openAI: () => { void this.openAI(); },
    };
  }

  private createModeCtx(): ModeCtx {
    return {
      state: this.state,
      refilter: () => this.applyFilter(),
      renderList: () => this.renderList(),
      renderStatus: () => this.renderStatus(),
      renderBreadcrumb: () => this.renderBreadcrumb(),
      moveSearchCursor: (d) => this.moveSearchCursor(d),
      selectSearchResult: () => this.selectSearchResult(),
      scheduleSearchUpdate: () => this.scheduleSearchUpdate(),
      cancelSearchUpdate: () => this.cancelSearchUpdate(),
    };
  }

  // ─── Navigation ────────────────────────────────────────────────

  private moveCursor(delta: number): void {
    const s = this.state;
    if (s.filtered.length === 0) return;
    s.cursor = wrapCursor(s.cursor, delta, s.filtered.length);
    s.scrollOffset = clampScroll(s.cursor, s.scrollOffset, s.visibleRows);
    // Keyed rows: a plain cursor move repaints only the two rows whose
    // `isCursor` flipped (what the old patchCursor() did by hand).
    this.renderList();
  }

  private enterSelected(): void {
    const s = this.state;
    const entry = currentEntry(s);
    if (!entry) return;

    if (entry.is_dir) {
      s.history.push(s.cwd);
      void this.loadDirectory(entry.path);
    } else {
      s.previewHidden = false;
      this.renderPreview();
      this.loadPreview();
    }
  }

  private goParent(): void {
    const s = this.state;
    const parent = parentDir(s.cwd);
    if (parent !== s.cwd) {
      s.history.push(s.cwd);
      void this.loadDirectory(parent);
    }
  }

  private toggleMark(): void {
    const s = this.state;
    const entry = currentEntry(s);
    if (!entry) return;
    if (s.marked.has(entry.path)) {
      s.marked.delete(entry.path);
    } else {
      s.marked.add(entry.path);
    }
    this.moveCursor(1);
  }

  // ─── Directory Loading ─────────────────────────────────────────

  /** Load a directory under `initialCwd`, resetting cursor, scroll and marks. */
  private async loadDirectory(path: string): Promise<void> {
    const s = this.state;
    if (!path.startsWith(s.initialCwd)) return;
    await this.fetchEntries(path);

    s.cwd = path;
    this.applySort();
    this.applyFilter();
    s.cursor = 0;
    s.scrollOffset = 0;
    s.marked.clear();
    this.previewCtl.forgetPath();
    this.renderBreadcrumb();
    this.renderList();
    this.renderStatus();
    this.previewCtl.clear();
  }

  /** Reload current directory without resetting cursor position or marks. */
  private async refreshDirectory(): Promise<void> {
    const s = this.state;
    const prevName = currentEntry(s)?.name ?? null;
    const prevMarked = new Set(s.marked);

    await this.fetchEntries(s.cwd);
    this.applySort();
    this.applyFilter();

    const restored = restoreSelection(prevName, s.cursor, prevMarked, s.filtered);
    s.marked.clear();
    for (const p of restored.marked) s.marked.add(p);
    s.cursor = restored.cursor;

    s.scrollOffset = clampScroll(s.cursor, s.scrollOffset, s.visibleRows);
    this.previewCtl.forgetPath();
    this.renderBreadcrumb();
    this.renderList();
    this.renderStatus();
    this.previewCtl.clear();
  }

  /** Load a directory and set cursor to the entry matching `selectName` (no initialCwd guard). */
  private async loadDirectoryAndSelect(path: string, selectName: string): Promise<void> {
    const s = this.state;
    await this.fetchEntries(path);

    s.cwd = path;
    this.applySort();
    this.applyFilter();
    s.marked.clear();
    this.previewCtl.forgetPath();

    const idx = s.filtered.findIndex((e) => e.name === selectName);
    s.cursor = idx >= 0 ? idx : 0;
    s.scrollOffset = clampScroll(s.cursor, 0, s.visibleRows);

    this.renderBreadcrumb();
    this.renderList();
    this.renderStatus();

    // Auto-open preview for the selected file
    if (idx >= 0 && !s.filtered[idx].is_dir) {
      s.previewHidden = false;
      this.renderPreview();
    }
    this.loadPreview();
  }

  private async fetchEntries(path: string): Promise<void> {
    try {
      this.state.entries = await ops.listDirectory(path, this.state.showHidden);
    } catch (err) {
      this.state.entries = [];
      this.setStatusError(`${err}`);
    }
  }

  // ─── Sorting & Filtering ───────────────────────────────────────

  private applySort(): void {
    const s = this.state;
    s.entries = sortEntries(s.entries, s.sortField, s.sortOrder);
  }

  private applyFilter(): void {
    const s = this.state;
    s.filtered = filterEntries(s.entries, s.filterText);
  }

  private resort(): void {
    const s = this.state;
    this.applySort();
    this.applyFilter();
    s.cursor = 0;
    s.scrollOffset = 0;
    this.renderList();
    this.renderStatus();
  }

  // ─── Preview ───────────────────────────────────────────────────

  private resizeSplit(delta: number): void {
    const s = this.state;
    const bodyWidth = this.bodyEl.clientWidth || 1200;
    const minWidth = Math.round(bodyWidth * 0.15);
    const maxWidth = Math.round(bodyWidth * 0.85);
    const stepPx = Math.max(24, Math.round(bodyWidth * Math.abs(delta) / 100));
    const direction = delta < 0 ? -1 : 1;
    s.listWidthPx = Math.max(minWidth, Math.min(maxWidth, s.listWidthPx + direction * stepPx));
    this.listEl.style.flex = `0 0 ${s.listWidthPx}px`;
    this.preview.setFlex('1 1 0');
  }

  private loadPreview(): void {
    this.previewCtl.requestCursor(() => {
      const s = this.state;
      const entry = currentEntry(s);
      if (!entry) return null;
      return { source: 'cursor', path: entry.path, name: entry.name, entry, showHidden: s.showHidden };
    });
  }

  private loadSearchPreview(): void {
    const { search, showHidden } = this.state;
    const relPath = search.results[search.cursor];
    if (!relPath) return;
    const target: PreviewTarget = {
      source: 'search',
      path: search.root + '/' + relPath,
      name: relPath.split('/').pop() ?? relPath,
      entry: null,
      showHidden,
    };
    this.previewCtl.requestSearch(target);
  }

  // ─── File Operations ───────────────────────────────────────────

  private copyPathToClipboard(): void {
    const entry = currentEntry(this.state);
    if (!entry) return;
    navigator.clipboard.writeText(entry.path).then(() => {
      // quirk P7: text only, className untouched
      this.flashStatus(`Copied: ${entry.path}`, null, 2000);
    });
  }

  private async trackMarkedOrCurrent(): Promise<void> {
    const files = markedOrCurrentFiles(this.state);
    if (files.length === 0) {
      this.setStatusError('No file selected to track');
      return;
    }

    let tracked = 0;
    for (const file of files) {
      try {
        const content = await ops.readFile(file.path);
        this.state.tracked.set(file.path, content);
        tracked++;
      } catch (err) {
        this.setStatusError(`Track failed: ${err}`);
        return;
      }
    }

    this.flashStatus(`Tracking ${tracked} file${tracked === 1 ? '' : 's'}`, 'normal', 2000);
  }

  private async openTrackedDiff(): Promise<void> {
    if (!this.openDiffCallback) return;
    const s = this.state;

    const selected = markedOrCurrentFiles(s);
    const paths = selected.length > 0
      ? selected.map((entry) => entry.path)
      : Array.from(s.tracked.keys());
    const trackedPaths = paths.filter((path) => s.tracked.has(path));

    if (trackedPaths.length === 0) {
      this.setStatusError('No tracked baseline for selected file');
      return;
    }

    const { createTwoFilesPatch } = await import('diff');
    const patches: string[] = [];
    for (const path of trackedPaths) {
      const oldContent = s.tracked.get(path);
      if (oldContent === undefined) continue;
      try {
        const newContent = await ops.readFile(path);
        patches.push(createTwoFilesPatch(path, path, oldContent, newContent, 'tracked', 'current'));
      } catch (err) {
        patches.push(createTwoFilesPatch(path, '/dev/null', oldContent, '', 'tracked', 'deleted'));
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
    const s = this.state;
    const paths = marksOrCurrent(s);
    if (paths.length === 0) return;

    const names = paths.map((p) => p.split('/').pop()).join(', ');
    const label = paths.length === 1 ? `Delete ${names}?` : `Delete ${paths.length} items?`;

    this.flashStatus(`${label} [y/N]`, 'confirm');
    s.confirmAction = async () => {
      for (const p of paths) {
        try {
          await ops.removePath(p);
        } catch (err) {
          this.setStatusError(`Delete failed: ${err}`);
          return;
        }
      }
      s.marked.clear();
      await this.loadDirectory(s.cwd);
    };
  }

  private renameCurrentEntry(): void {
    const s = this.state;
    const entry = currentEntry(s);
    if (!entry) return;
    this.startPrompt('Rename to:', entry.name, async (newName) => {
      if (!newName || newName === entry.name) return;
      try {
        await ops.movePath(entry.path, `${s.cwd}/${newName}`);
        await this.loadDirectory(s.cwd);
      } catch (err) {
        this.setStatusError(`Rename failed: ${err}`);
      }
    });
  }

  private async createFile(name: string): Promise<void> {
    if (!name) return;
    try {
      await ops.writeFile(`${this.state.cwd}/${name}`, '');
      await this.loadDirectory(this.state.cwd);
    } catch (err) {
      this.setStatusError(`Create file failed: ${err}`);
    }
  }

  private async createDirectory(name: string): Promise<void> {
    if (!name) return;
    try {
      await ops.makeDir(`${this.state.cwd}/${name}`);
      await this.loadDirectory(this.state.cwd);
    } catch (err) {
      this.setStatusError(`mkdir failed: ${err}`);
    }
  }

  private yankToClipboard(op: 'copy' | 'cut'): void {
    const paths = marksOrCurrent(this.state);
    if (paths.length === 0) return;
    this.state.clipboard = { paths, op };
    const label = op === 'copy' ? 'Yanked' : 'Cut';
    this.flashStatus(`${label} ${paths.length} item${paths.length > 1 ? 's' : ''}`, 'normal', 2000);
  }

  private async pasteFromClipboard(): Promise<void> {
    const s = this.state;
    if (!s.clipboard) {
      this.setStatusError('Nothing in clipboard');
      return;
    }

    const { paths, op } = s.clipboard;

    for (const p of paths) {
      const name = p.split('/').pop()!;
      const srcDir = p.slice(0, p.length - name.length - 1) || '/';
      const sameDir = srcDir === s.cwd;
      let destPath = `${s.cwd}/${name}`;

      if (sameDir && op === 'copy') {
        destPath = uniqueCopyPath(s.cwd, name, new Set(s.entries.map((e) => e.name)));
      }

      try {
        if (op === 'copy') await ops.copyPath(p, destPath);
        else await ops.movePath(p, s.cwd);
      } catch (err) {
        this.setStatusError(`Paste failed: ${err}`);
        return;
      }
    }

    if (op === 'cut') s.clipboard = null;
    s.marked.clear();
    await this.refreshDirectory();
  }

  // ─── Rendering ─────────────────────────────────────────────────

  private renderBreadcrumb(): void {
    this.breadcrumb.update(selectBreadcrumb(this.state));
  }

  private renderList(): void {
    const s = this.state;
    const next = s.search.active ? this.searchList : this.fileList;
    if (next !== this.activeList) {
      this.activeList.release();
      this.activeList = next;
      this.fileGlide.snapNext();
      this.searchGlide.snapNext();
    }

    const hasRows = s.search.active ? s.search.results.length > 0 : s.filtered.length > 0;
    // Calculate visible rows from actual DOM height if not yet set by onResize
    if (hasRows && s.visibleRows <= 0) {
      const h = this.listEl.clientHeight || this.bodyEl.clientHeight || 600;
      s.visibleRows = Math.max(1, Math.floor(h / s.cellHeight));
    }

    // Only the scroll position animates; the cursor highlight is instant.
    const glide = s.search.active ? this.searchGlide : this.fileGlide;
    const source = s.search.active ? s.search.results : s.filtered;
    if (source !== this.glideSource) {
      this.glideSource = source;
      glide.snapNext();
    }
    glide.sync(s.search.active ? s.search.scrollOffset : s.scrollOffset, s.visibleRows, s.cellHeight);

    if (s.search.active) this.searchList.update(selectSearchList(s, glide.position));
    else this.fileList.update(selectFileList(s, glide.position));
  }

  private renderStatus(): void {
    const props = selectStatus(this.state);
    // null: a confirm prompt owns the bar (already set by deleteMarkedOrCurrent)
    if (props) this.status.update(props);
  }

  private renderPreview(): void {
    this.preview.update({ hidden: this.state.previewHidden, output: this.previewOutput });
  }

  /** Write a transient status; `resetMs` schedules a normal re-render. */
  private flashStatus(text: string, tone: StatusTone, resetMs?: number): void {
    this.status.update({ text, tone });
    if (resetMs !== undefined) this.scheduleStatusReset(resetMs);
  }

  private setStatusError(msg: string): void {
    this.flashStatus(msg, 'error', 3000);
  }

  /** Schedule a status-bar reset, cancelling any previously scheduled reset. */
  private scheduleStatusReset(ms: number): void {
    if (this.statusResetTimer !== null) clearTimeout(this.statusResetTimer);
    this.statusResetTimer = setTimeout(() => {
      this.statusResetTimer = null;
      this.renderStatus();
    }, ms);
  }

  private startPrompt(label: string, initial: string, onSubmit: (value: string) => void): void {
    this.state.prompt = { label, value: initial, onSubmit };
    this.renderStatus();
  }

  // ─── Fuzzy File Search ──────────────────────────────────────────

  private async enterSearchMode(): Promise<void> {
    const s = this.state;
    const { search } = s;
    search.active = true;
    search.text = '';
    search.cursor = 0;
    search.scrollOffset = 0;
    search.root = s.initialCwd;
    search.results = [];
    search.capped = false;
    this.renderBreadcrumb();
    this.renderStatus();
    this.renderList();

    try {
      const files = await ops.searchFiles(s.initialCwd, s.showHidden);
      search.capped = files.length >= SEARCH_POOL_CAP;
      search.pool = files;
      search.poolLower = files.map((f) => f.toLowerCase());
    } catch (err) {
      search.pool = [];
      search.poolLower = [];
      this.setStatusError(`${err}`);
    }

    this.applySearch();
    this.renderList();
    this.renderStatus();
  }

  private applySearch(): void {
    const { search } = this.state;
    search.results = rankSearch(search.pool, search.poolLower, search.text);
  }

  private scheduleSearchUpdate(): void {
    if (this.searchUpdateRaf !== null) return;
    this.searchUpdateRaf = requestAnimationFrame(() => {
      this.searchUpdateRaf = null;
      const { search } = this.state;
      if (!search.active) return;
      this.applySearch();
      search.cursor = 0;
      search.scrollOffset = 0;
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

  private moveSearchCursor(delta: number): void {
    const s = this.state;
    const { search } = s;
    if (search.results.length === 0) return;
    search.cursor = wrapCursor(search.cursor, delta, search.results.length);
    search.scrollOffset = clampScroll(search.cursor, search.scrollOffset, s.visibleRows);
    this.renderList();
    this.loadSearchPreview();
  }

  private selectSearchResult(): void {
    const s = this.state;
    const relPath = s.search.results[s.search.cursor];
    if (!relPath) return;

    const absPath = s.search.root + '/' + relPath;
    const lastSlash = absPath.lastIndexOf('/');
    const dir = lastSlash > 0 ? absPath.slice(0, lastSlash) : '/';
    const fileName = absPath.slice(lastSlash + 1);

    resetSearch(this.modeCtx);

    // Navigate to the file's directory, then highlight the file
    s.history.push(s.cwd);
    void this.loadDirectoryAndSelect(dir, fileName);
  }

  // ─── AI Overlay ────────────────────────────────────────────────

  private async openAI(): Promise<void> {
    if (this.aiOverlay) return;

    const { FileManagerAI } = await import('../file-manager-ai');

    this.aiOverlay = new FileManagerAI({
      cwd: this.state.cwd,
      getContext: () => aiContext(this.state),
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

  // ─── Helpers ───────────────────────────────────────────────────

  /** Read the terminal cell height from the CSS variable, fallback to 20px */
  private getCellHeight(): number {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue('--krypton-terminal-cell-height')
      .trim();
    const px = parseFloat(val);
    return px > 0 ? px : 20;
  }
}
