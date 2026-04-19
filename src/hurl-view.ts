// Krypton — Hurl Client View
// Two-pane keyboard-driven HTTP request browser / runner.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { ContentView, PaneContentType } from './types';
import { ansiToHtml } from './hurl-ansi';
import { highlightHurl } from './hurl-highlight';

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface HurlFile {
  path: string;
  rel_path: string;
  name: string;
}

interface HurlListing {
  hurl_files: HurlFile[];
  env_files: HurlFile[];
}

interface HurlTreeNode {
  kind: 'dir' | 'file';
  name: string;
  relPath: string;
  absPath?: string;
  children?: HurlTreeNode[];
  depth: number;
}

interface HurlVisibleRow {
  node: HurlTreeNode;
  indent: number;
}

interface HurlRun {
  id: number;
  filePath: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  status: 'running' | 'ok' | 'failed' | 'cancelled';
}

interface HurlCachedRun {
  version: number;
  file_path: string;
  file_mtime_ms: number;
  started_at: number;
  finished_at: number;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  verbose: boolean;
  very_verbose: boolean;
}

interface HurlSidebarState {
  version: number;
  cwd: string;
  expanded: string[];
  selected_rel_path: string | null;
  view_mode: string;
  verbose: boolean;
  very_verbose: boolean;
  active_env_file: string | null;
  resolved_view?: boolean;
  updated_at: number;
}

interface HurlOutputPayload {
  run_id: number;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

interface HurlFinishedPayload {
  run_id: number;
  exit_code: number;
  duration_ms: number;
}

type ViewMode = 'source' | 'response';

const IN_MEMORY_CAP = 5 * 1024 * 1024;

export class HurlContentView implements ContentView {
  readonly type: PaneContentType = 'hurl';
  readonly element: HTMLElement;

  private cwd: string;
  private files: HurlFile[] = [];
  private envFiles: HurlFile[] = [];
  private tree: HurlTreeNode;
  private expanded = new Set<string>();
  private visible: HurlVisibleRow[] = [];
  private filterText = '';
  private filterActive = false;
  private selectedIndex = 0;
  private viewMode: ViewMode = 'source';
  private verbose = false;
  private veryVerbose = false;
  private activeEnvFile: string | null = null;
  private envVars: Record<string, string> | null = null;
  private resolvedView = false;
  private activeRun: HurlRun | null = null;
  private lastRun: HurlRun | null = null;
  private sourceCache = new Map<string, string>();
  private cachedBadge = '';

  private outputUnlisten: UnlistenFn | null = null;
  private finishedUnlisten: UnlistenFn | null = null;
  private saveTimer: number | null = null;
  private renderRaf: number | null = null;
  private elapsedTimer: number | null = null;

  private closeCb: (() => void) | null = null;
  private editorCb: ((fileDir: string, editor: string, filePath: string) => void) | null = null;

  private sidebarEl: HTMLElement;
  private sidebarTitleEl: HTMLElement;
  private filterEl: HTMLElement;
  private filterInputEl: HTMLInputElement;
  private treeEl: HTMLElement;
  private mainEl: HTMLElement;
  private breadcrumbEl: HTMLElement;
  private toolbarEl: HTMLElement;
  private viewportEl: HTMLElement;
  private statusBarEl: HTMLElement;
  private pickerEl: HTMLElement | null = null;
  private helpEl: HTMLElement | null = null;

  constructor(cwd: string, container: HTMLElement) {
    this.cwd = cwd;
    this.tree = { kind: 'dir', name: '', relPath: '', depth: -1, children: [] };

    this.element = document.createElement('div');
    this.element.className = 'krypton-hurl';
    this.element.tabIndex = 0;

    this.sidebarEl = document.createElement('div');
    this.sidebarEl.className = 'krypton-hurl__sidebar';

    const header = document.createElement('div');
    header.className = 'krypton-hurl__sidebar-header';

    this.sidebarTitleEl = document.createElement('div');
    this.sidebarTitleEl.className = 'krypton-hurl__sidebar-title';
    const base = cwd.split('/').filter(Boolean).pop() ?? 'hurl';
    this.sidebarTitleEl.textContent = `HURL · ${base}`;
    header.appendChild(this.sidebarTitleEl);

    this.filterEl = document.createElement('div');
    this.filterEl.className = 'krypton-hurl__filter';
    this.filterEl.style.display = 'none';

    this.filterInputEl = document.createElement('input');
    this.filterInputEl.className = 'krypton-hurl__filter-input';
    this.filterInputEl.type = 'text';
    this.filterInputEl.placeholder = '/ filter';
    this.filterInputEl.addEventListener('input', () => {
      this.filterText = this.filterInputEl.value;
      this.selectedIndex = 0;
      this.rebuildVisible();
      this.renderTree();
    });
    this.filterInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeFilter();
        e.stopPropagation();
      } else if (e.key === 'Enter') {
        this.filterActive = false;
        this.filterEl.style.display = 'none';
        this.element.focus();
        this.openSelected();
        e.stopPropagation();
      }
    });
    this.filterEl.appendChild(this.filterInputEl);

    this.treeEl = document.createElement('div');
    this.treeEl.className = 'krypton-hurl__tree';

    this.sidebarEl.appendChild(header);
    this.sidebarEl.appendChild(this.filterEl);
    this.sidebarEl.appendChild(this.treeEl);

    this.mainEl = document.createElement('div');
    this.mainEl.className = 'krypton-hurl__main';

    this.breadcrumbEl = document.createElement('div');
    this.breadcrumbEl.className = 'krypton-hurl__breadcrumb';

    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'krypton-hurl__toolbar';

    this.viewportEl = document.createElement('div');
    this.viewportEl.className = 'krypton-hurl__viewport';

    this.statusBarEl = document.createElement('div');
    this.statusBarEl.className = 'krypton-hurl__statusbar';

    this.mainEl.appendChild(this.breadcrumbEl);
    this.mainEl.appendChild(this.toolbarEl);
    this.mainEl.appendChild(this.viewportEl);
    this.mainEl.appendChild(this.statusBarEl);

    this.element.appendChild(this.sidebarEl);
    this.element.appendChild(this.mainEl);
    container.appendChild(this.element);

    this.init();
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  setEditorHandler(cb: (fileDir: string, editor: string, filePath: string) => void): void {
    this.editorCb = cb;
  }

  getWorkingDirectory(): string {
    return this.cwd;
  }

  private async init(): Promise<void> {
    this.statusBarEl.textContent = 'INDEXING...';
    try {
      const [listing, state] = await Promise.all([
        invoke<HurlListing>('list_hurl_files', { cwd: this.cwd }),
        invoke<HurlSidebarState | null>('hurl_load_sidebar_state', { cwd: this.cwd }),
      ]);
      this.files = listing.hurl_files;
      this.envFiles = listing.env_files;
      this.buildTree();

      if (state) {
        for (const p of state.expanded) this.expanded.add(p);
        this.viewMode = state.view_mode === 'response' ? 'response' : 'source';
        this.verbose = state.verbose;
        this.veryVerbose = state.very_verbose;
        this.activeEnvFile = state.active_env_file;
        this.resolvedView = state.resolved_view ?? false;
      } else {
        for (const f of this.files) {
          const segs = f.rel_path.split('/');
          segs.pop();
          if (segs.length > 0) this.expanded.add(segs.join('/'));
        }
      }

      this.rebuildVisible();

      if (state?.selected_rel_path) {
        const idx = this.visible.findIndex((v) => v.node.relPath === state.selected_rel_path);
        if (idx >= 0) this.selectedIndex = idx;
      }

      this.renderTree();
      this.renderToolbar();
      this.updateStatusBar();

      await this.loadEnvVars();

      if (this.files.length > 0) {
        this.openSelectedFile();
      } else {
        this.viewportEl.innerHTML = '<div class="krypton-hurl__empty">No .hurl files under this directory.</div>';
      }

      this.outputUnlisten = await listen<HurlOutputPayload>('hurl-output', (ev) => {
        this.handleOutput(ev.payload);
      });
      this.finishedUnlisten = await listen<HurlFinishedPayload>('hurl-finished', (ev) => {
        this.handleFinished(ev.payload);
      });
    } catch (e) {
      this.statusBarEl.textContent = `ERROR: ${String(e)}`;
    }
  }

  // ─── Tree construction ─────────────────────────────────────────

  private buildTree(): void {
    const root: HurlTreeNode = { kind: 'dir', name: '', relPath: '', depth: -1, children: [] };
    for (const f of this.files) {
      const segs = f.rel_path.split('/');
      let cursor = root;
      let acc = '';
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        acc = acc ? `${acc}/${s}` : s;
        let dir = cursor.children?.find((c) => c.kind === 'dir' && c.name === s);
        if (!dir) {
          dir = { kind: 'dir', name: s, relPath: acc, depth: i, children: [] };
          cursor.children?.push(dir);
        }
        cursor = dir;
      }
      cursor.children?.push({
        kind: 'file',
        name: segs[segs.length - 1],
        relPath: f.rel_path,
        absPath: f.path,
        depth: segs.length - 1,
      });
    }
    this.sortTree(root);
    this.tree = root;
  }

  private sortTree(node: HurlTreeNode): void {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) this.sortTree(c);
  }

  private rebuildVisible(): void {
    this.visible = [];
    if (this.filterText.trim().length > 0) {
      const q = this.filterText.toLowerCase();
      for (const f of this.files) {
        if (f.rel_path.toLowerCase().includes(q)) {
          this.visible.push({
            node: {
              kind: 'file',
              name: f.name,
              relPath: f.rel_path,
              absPath: f.path,
              depth: 0,
            },
            indent: 0,
          });
        }
      }
      return;
    }
    const walk = (node: HurlTreeNode): void => {
      if (!node.children) return;
      for (const c of node.children) {
        this.visible.push({ node: c, indent: c.depth });
        if (c.kind === 'dir' && this.expanded.has(c.relPath)) {
          walk(c);
        }
      }
    };
    walk(this.tree);
  }

  // ─── Rendering ─────────────────────────────────────────────────

  private renderTree(): void {
    this.treeEl.innerHTML = '';
    if (this.visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'krypton-hurl__empty';
      empty.textContent = this.filterText ? 'No matches' : 'No .hurl files';
      this.treeEl.appendChild(empty);
      return;
    }

    if (this.selectedIndex >= this.visible.length) {
      this.selectedIndex = this.visible.length - 1;
    }

    for (let i = 0; i < this.visible.length; i++) {
      const row = this.visible[i];
      const el = document.createElement('div');
      el.className = 'krypton-hurl__tree-row';
      el.classList.add(
        row.node.kind === 'dir'
          ? 'krypton-hurl__tree-row--dir'
          : 'krypton-hurl__tree-row--file',
      );
      if (i === this.selectedIndex) {
        el.classList.add('krypton-hurl__tree-row--selected');
      }
      if (
        this.activeRun &&
        row.node.kind === 'file' &&
        row.node.absPath === this.activeRun.filePath
      ) {
        el.classList.add('krypton-hurl__tree-row--running');
      }
      el.style.paddingLeft = `${8 + row.indent * 12}px`;

      if (row.node.kind === 'dir') {
        const chevron = document.createElement('span');
        chevron.className = 'krypton-hurl__chevron';
        chevron.textContent = this.expanded.has(row.node.relPath) ? '▾' : '▸';
        el.appendChild(chevron);
      } else {
        const dot = document.createElement('span');
        dot.className = 'krypton-hurl__chevron';
        dot.textContent = '·';
        el.appendChild(dot);
      }

      const label = document.createElement('span');
      label.className = 'krypton-hurl__tree-label';
      label.textContent = row.node.name;
      el.appendChild(label);

      this.treeEl.appendChild(el);

      if (i === this.selectedIndex) {
        requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
      }
    }
  }

  private renderToolbar(): void {
    this.toolbarEl.innerHTML = '';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'krypton-hurl__toolbar-item';
    modeLabel.textContent =
      this.viewMode === 'source'
        ? this.resolvedView
          ? 'SOURCE · RESOLVED'
          : 'SOURCE'
        : 'RESPONSE';
    this.toolbarEl.appendChild(modeLabel);

    if (this.verbose) {
      const v = document.createElement('span');
      v.className = 'krypton-hurl__toolbar-flag';
      v.textContent = '[v]';
      this.toolbarEl.appendChild(v);
    }
    if (this.veryVerbose) {
      const vv = document.createElement('span');
      vv.className = 'krypton-hurl__toolbar-flag';
      vv.textContent = '[VV]';
      this.toolbarEl.appendChild(vv);
    }
    if (this.cachedBadge) {
      const c = document.createElement('span');
      c.className = 'krypton-hurl__toolbar-item krypton-hurl__toolbar-cached';
      c.textContent = this.cachedBadge;
      this.toolbarEl.appendChild(c);
    }
  }

  private updateStatusBar(): void {
    this.statusBarEl.innerHTML = '';

    const exitChip = document.createElement('span');
    exitChip.className = 'krypton-hurl__exit';
    if (this.activeRun && this.activeRun.status === 'running') {
      exitChip.classList.add('krypton-hurl__exit--running');
      exitChip.textContent = 'RUN';
    } else if (this.lastRun) {
      if (this.lastRun.exitCode === 0) {
        exitChip.classList.add('krypton-hurl__exit--ok');
        exitChip.textContent = `EXIT 0`;
      } else if (this.lastRun.status === 'cancelled') {
        exitChip.classList.add('krypton-hurl__exit--failed');
        exitChip.textContent = 'CANCELLED';
      } else {
        exitChip.classList.add('krypton-hurl__exit--failed');
        exitChip.textContent = `EXIT ${this.lastRun.exitCode ?? '?'}`;
      }
    } else {
      exitChip.textContent = 'IDLE';
    }
    this.statusBarEl.appendChild(exitChip);

    if (this.lastRun && this.lastRun.finishedAt) {
      const dur = document.createElement('span');
      dur.className = 'krypton-hurl__stat';
      dur.textContent = `${this.lastRun.finishedAt - this.lastRun.startedAt}ms`;
      this.statusBarEl.appendChild(dur);
    } else if (this.activeRun) {
      const dur = document.createElement('span');
      dur.className = 'krypton-hurl__stat';
      dur.textContent = `${Date.now() - this.activeRun.startedAt}ms`;
      this.statusBarEl.appendChild(dur);
    }

    const env = document.createElement('span');
    env.className = 'krypton-hurl__env-badge';
    const name = this.activeEnvFile
      ? this.activeEnvFile.split('/').pop() ?? this.activeEnvFile
      : 'none';
    env.textContent = `env: ${name} ▾`;
    this.statusBarEl.appendChild(env);

    const help = document.createElement('span');
    help.className = 'krypton-hurl__help-cue';
    help.textContent = '? for help';
    this.statusBarEl.appendChild(help);
  }

  // ─── Selection / viewport ─────────────────────────────────────

  private get currentFileNode(): HurlTreeNode | null {
    const row = this.visible[this.selectedIndex];
    if (!row || row.node.kind !== 'file') return null;
    return row.node;
  }

  private async openSelectedFile(): Promise<void> {
    const node = this.currentFileNode;
    if (!node || !node.absPath) return;

    this.breadcrumbEl.textContent = node.relPath;

    if (this.activeRun && this.activeRun.filePath === node.absPath) {
      this.renderViewport();
      return;
    }

    if (this.viewMode === 'source') {
      await this.renderSource(node.absPath);
    } else {
      await this.loadAndRenderCached(node.absPath);
    }
    this.renderToolbar();
    this.updateStatusBar();
  }

  private async renderSource(absPath: string): Promise<void> {
    let source = this.sourceCache.get(absPath);
    if (source === undefined) {
      try {
        source = await invoke<string>('read_file', { path: absPath });
      } catch (e) {
        this.viewportEl.innerHTML =
          `<div class="krypton-hurl__empty krypton-hurl__empty--error">Failed to read file: ${escapeHtmlText(String(e))}</div>`;
        return;
      }
      this.sourceCache.set(absPath, source);
    }
    const vars = this.resolvedView && this.envVars ? this.envVars : undefined;
    this.viewportEl.innerHTML = `<pre class="krypton-hurl__source">${highlightHurl(source, vars)}</pre>`;
  }

  private async loadEnvVars(): Promise<void> {
    if (!this.activeEnvFile) {
      this.envVars = null;
      return;
    }
    try {
      this.envVars = await invoke<Record<string, string>>('hurl_read_env_file', {
        path: this.activeEnvFile,
      });
    } catch (e) {
      this.envVars = null;
      this.statusBarEl.textContent = `ENV PARSE ERROR: ${String(e)}`;
      console.error('hurl_read_env_file failed:', e);
    }
  }

  private async loadAndRenderCached(absPath: string): Promise<void> {
    try {
      const cached = await invoke<HurlCachedRun | null>('hurl_load_cached', {
        filePath: absPath,
      });
      if (cached) {
        const combined = cached.stderr + cached.stdout;
        this.viewportEl.innerHTML = `<pre class="krypton-hurl__response">${ansiToHtml(combined)}</pre>`;
        const ts = new Date(cached.finished_at).toLocaleTimeString();
        const currentMtime = cached.file_mtime_ms;
        this.cachedBadge = `cached · ${ts}${currentMtime ? '' : ' · stale'}`;
        this.lastRun = {
          id: -1,
          filePath: cached.file_path,
          startedAt: cached.started_at,
          finishedAt: cached.finished_at,
          exitCode: cached.exit_code,
          stdout: cached.stdout,
          stderr: cached.stderr,
          status: cached.exit_code === 0 ? 'ok' : 'failed',
        };
      } else {
        this.viewportEl.innerHTML = '<div class="krypton-hurl__empty">No response cached — press Enter to run.</div>';
        this.cachedBadge = '';
      }
    } catch (e) {
      this.viewportEl.innerHTML =
        `<div class="krypton-hurl__empty krypton-hurl__empty--error">Failed to load cache: ${escapeHtmlText(String(e))}</div>`;
    }
  }

  private renderViewport(): void {
    if (this.renderRaf !== null) return;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = null;
      if (this.viewMode === 'source') {
        const node = this.currentFileNode;
        if (node?.absPath) void this.renderSource(node.absPath);
        return;
      }
      const run = this.activeRun ?? this.lastRun;
      if (!run) {
        this.viewportEl.innerHTML = '<div class="krypton-hurl__empty">No run yet.</div>';
        return;
      }
      const combined = run.stderr + run.stdout;
      this.viewportEl.innerHTML = `<pre class="krypton-hurl__response">${ansiToHtml(combined)}</pre>`;
    });
  }

  // ─── Running ───────────────────────────────────────────────────

  private async runSelected(): Promise<void> {
    const node = this.currentFileNode;
    if (!node || !node.absPath) return;

    if (this.activeRun) {
      await this.cancelActive();
    }

    this.viewMode = 'response';
    this.cachedBadge = '';

    try {
      const run_id = await invoke<number>('hurl_run', {
        args: {
          file: node.absPath,
          cwd: this.cwd,
          verbose: this.verbose,
          very_verbose: this.veryVerbose,
          variables_file: this.activeEnvFile,
          extra_args: [],
        },
      });
      this.activeRun = {
        id: run_id,
        filePath: node.absPath,
        startedAt: Date.now(),
        finishedAt: null,
        exitCode: null,
        stdout: '',
        stderr: '',
        status: 'running',
      };
      this.renderTree();
      this.renderToolbar();
      this.updateStatusBar();
      this.renderViewport();
      this.startElapsedTimer();
    } catch (e) {
      this.viewportEl.innerHTML = `<div class="krypton-hurl__empty krypton-hurl__empty--error">${String(e)}</div>`;
    }
  }

  private async cancelActive(): Promise<void> {
    if (!this.activeRun) return;
    try {
      await invoke('hurl_cancel', { runId: this.activeRun.id });
    } catch {
      /* ignore */
    }
    this.activeRun.status = 'cancelled';
  }

  private handleOutput(p: HurlOutputPayload): void {
    if (!this.activeRun || this.activeRun.id !== p.run_id) return;
    if (p.stream === 'stdout') {
      this.activeRun.stdout += p.chunk;
      if (this.activeRun.stdout.length > IN_MEMORY_CAP) {
        this.activeRun.stdout = this.activeRun.stdout.slice(-IN_MEMORY_CAP);
      }
    } else {
      this.activeRun.stderr += p.chunk;
      if (this.activeRun.stderr.length > IN_MEMORY_CAP) {
        this.activeRun.stderr = this.activeRun.stderr.slice(-IN_MEMORY_CAP);
      }
    }
    this.renderViewport();
  }

  private handleFinished(p: HurlFinishedPayload): void {
    if (!this.activeRun || this.activeRun.id !== p.run_id) return;
    const run = this.activeRun;
    run.finishedAt = run.startedAt + p.duration_ms;
    run.exitCode = p.exit_code;
    if (run.status !== 'cancelled') {
      run.status = p.exit_code === 0 ? 'ok' : 'failed';
    }
    this.activeRun = null;
    this.lastRun = run;
    this.stopElapsedTimer();
    this.renderTree();
    this.renderToolbar();
    this.updateStatusBar();
    this.renderViewport();

    if (run.status !== 'cancelled') {
      void invoke('hurl_save_cache', {
        args: {
          file_path: run.filePath,
          started_at: run.startedAt,
          finished_at: run.finishedAt,
          exit_code: run.exitCode ?? 0,
          duration_ms: p.duration_ms,
          stdout: run.stdout,
          stderr: run.stderr,
          verbose: this.verbose,
          very_verbose: this.veryVerbose,
        },
      }).catch((e) => {
        console.warn('hurl_save_cache failed:', e);
      });
    }

    if (run.status === 'failed' && this.viewMode !== 'response') {
      this.viewMode = 'response';
      this.renderToolbar();
      this.renderViewport();
    }
  }

  private startElapsedTimer(): void {
    this.stopElapsedTimer();
    this.elapsedTimer = window.setInterval(() => this.updateStatusBar(), 200);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  // ─── Keyboard ─────────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.helpEl) {
      if (e.key === 'Escape' || e.key === '?' || e.key === 'q' || e.key === 'Enter') {
        this.closeHelp();
      }
      return true;
    }
    if (this.pickerEl) return false;
    if (this.filterActive) return false;

    const key = e.key;
    switch (key) {
      case 'j': {
        if (this.visible.length === 0) return true;
        this.selectedIndex = (this.selectedIndex + 1) % this.visible.length;
        this.renderTree();
        void this.openSelectedFile();
        this.saveStateDebounced();
        return true;
      }
      case 'k': {
        if (this.visible.length === 0) return true;
        this.selectedIndex = (this.selectedIndex - 1 + this.visible.length) % this.visible.length;
        this.renderTree();
        void this.openSelectedFile();
        this.saveStateDebounced();
        return true;
      }
      case 'h': {
        const row = this.visible[this.selectedIndex];
        if (row?.node.kind === 'dir' && this.expanded.has(row.node.relPath)) {
          this.expanded.delete(row.node.relPath);
          this.rebuildVisible();
          this.renderTree();
        }
        this.saveStateDebounced();
        return true;
      }
      case 'l': {
        const row = this.visible[this.selectedIndex];
        if (row?.node.kind === 'dir' && !this.expanded.has(row.node.relPath)) {
          this.expanded.add(row.node.relPath);
          this.rebuildVisible();
          this.renderTree();
        }
        this.saveStateDebounced();
        return true;
      }
      case 'Enter': {
        this.openSelected();
        return true;
      }
      case 'r':
        void this.runSelected();
        return true;
      case 'R':
        if (this.lastRun) {
          const idx = this.visible.findIndex(
            (v) => v.node.kind === 'file' && v.node.absPath === this.lastRun?.filePath,
          );
          if (idx >= 0) {
            this.selectedIndex = idx;
            this.renderTree();
          }
          void this.runSelected();
        }
        return true;
      case 'x':
        if (this.activeRun) {
          void this.cancelActive();
        }
        return true;
      case 'o':
        this.viewMode = this.viewMode === 'source' ? 'response' : 'source';
        this.renderToolbar();
        this.renderViewport();
        void this.openSelectedFile();
        this.saveStateDebounced();
        return true;
      case 'v':
        this.verbose = !this.verbose;
        if (this.verbose) this.veryVerbose = false;
        this.renderToolbar();
        this.saveStateDebounced();
        return true;
      case 'V':
        this.veryVerbose = !this.veryVerbose;
        if (this.veryVerbose) this.verbose = false;
        this.renderToolbar();
        this.saveStateDebounced();
        return true;
      case 'e': {
        const node = this.currentFileNode;
        if (node?.absPath && this.editorCb) {
          const dir = node.absPath.substring(0, node.absPath.lastIndexOf('/')) || '/';
          void this.launchEditor(dir, node.absPath);
        }
        return true;
      }
      case 'E':
        this.openEnvPicker();
        return true;
      case '/':
        this.openFilter();
        return true;
      case '.':
        void this.refresh();
        return true;
      case 'i':
        this.resolvedView = !this.resolvedView;
        if (this.viewMode !== 'source') {
          this.viewMode = 'source';
          this.renderToolbar();
        }
        this.renderViewport();
        this.updateStatusBar();
        this.saveStateDebounced();
        return true;
      case '?':
      case 'F1':
        this.openHelp();
        return true;
      case 'g':
        this.viewportEl.scrollTo(0, 0);
        return true;
      case 'G':
        this.viewportEl.scrollTo(0, this.viewportEl.scrollHeight);
        return true;
      case 'J':
        this.viewportEl.scrollBy(0, this.viewportEl.clientHeight * 0.9);
        return true;
      case 'K':
        this.viewportEl.scrollBy(0, -this.viewportEl.clientHeight * 0.9);
        return true;
      case 'y': {
        const run = this.activeRun ?? this.lastRun;
        if (run) {
          void navigator.clipboard.writeText(run.stderr + run.stdout);
        }
        return true;
      }
      case 'Escape':
      case 'q':
        if (this.closeCb) this.closeCb();
        return true;
      default:
        return false;
    }
  }

  private openSelected(): void {
    const row = this.visible[this.selectedIndex];
    if (!row) return;
    if (row.node.kind === 'dir') {
      if (this.expanded.has(row.node.relPath)) {
        this.expanded.delete(row.node.relPath);
      } else {
        this.expanded.add(row.node.relPath);
      }
      this.rebuildVisible();
      this.renderTree();
      this.saveStateDebounced();
    } else {
      void this.runSelected();
    }
  }

  private openFilter(): void {
    this.filterActive = true;
    this.filterEl.style.display = '';
    this.filterInputEl.value = this.filterText;
    this.filterInputEl.focus();
  }

  private closeFilter(): void {
    this.filterActive = false;
    this.filterText = '';
    this.filterEl.style.display = 'none';
    this.filterInputEl.value = '';
    this.rebuildVisible();
    this.renderTree();
    this.element.focus();
  }

  private async refresh(): Promise<void> {
    try {
      const listing = await invoke<HurlListing>('list_hurl_files', { cwd: this.cwd });
      this.files = listing.hurl_files;
      this.envFiles = listing.env_files;
      this.sourceCache.clear();
      this.buildTree();
      this.rebuildVisible();
      this.renderTree();
    } catch (e) {
      this.statusBarEl.textContent = `REFRESH ERROR: ${String(e)}`;
      console.error('hurl refresh failed:', e);
    }
  }

  // ─── Env picker ───────────────────────────────────────────────

  private openEnvPicker(): void {
    if (this.pickerEl) return;

    const overlay = document.createElement('div');
    overlay.className = 'krypton-hurl__picker';

    const title = document.createElement('div');
    title.className = 'krypton-hurl__picker-title';
    title.textContent = 'VARIABLES FILE';
    overlay.appendChild(title);

    const list = document.createElement('div');
    list.className = 'krypton-hurl__picker-list';
    overlay.appendChild(list);

    const items: Array<{ label: string; path: string | null }> = [
      { label: '(none)', path: null },
      ...this.envFiles.map((f) => ({ label: f.rel_path, path: f.path })),
    ];
    let sel = Math.max(0, items.findIndex((i) => i.path === this.activeEnvFile));
    if (sel < 0) sel = 0;

    const render = (): void => {
      list.innerHTML = '';
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'krypton-hurl__picker-item';
        if (i === sel) row.classList.add('krypton-hurl__picker-item--selected');
        row.textContent = it.label;
        list.appendChild(row);
      });
    };
    render();

    this.element.appendChild(overlay);
    this.pickerEl = overlay;

    const close = (): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      this.pickerEl = null;
      this.element.focus();
    };

    const onKey = (ev: KeyboardEvent): void => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || ev.key === 'q') {
        ev.preventDefault();
        close();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const pick = items[sel];
        this.activeEnvFile = pick.path;
        void this.loadEnvVars().then(() => {
          this.updateStatusBar();
          if (this.viewMode === 'source') this.renderViewport();
        });
        this.updateStatusBar();
        this.saveStateDebounced();
        close();
      } else if (ev.key === 'j' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        sel = Math.min(sel + 1, items.length - 1);
        render();
      } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        sel = Math.max(sel - 1, 0);
        render();
      }
    };
    document.addEventListener('keydown', onKey, true);
  }

  // ─── Help overlay ─────────────────────────────────────────────

  private openHelp(): void {
    if (this.helpEl) return;

    const overlay = document.createElement('div');
    overlay.className = 'krypton-hurl__help';

    const title = document.createElement('div');
    title.className = 'krypton-hurl__help-title';
    title.textContent = 'HURL CLIENT — HELP';
    overlay.appendChild(title);

    const sections: Array<{ heading: string; rows: Array<[string, string]> }> = [
      {
        heading: 'Navigation',
        rows: [
          ['j / k', 'Move selection down / up'],
          ['h / l', 'Collapse / expand folder'],
          ['Enter', 'Toggle folder, or run selected file'],
          ['/', 'Filter files'],
          ['Esc', 'Clear filter (or close view)'],
          ['.', 'Refresh file list'],
        ],
      },
      {
        heading: 'Running requests',
        rows: [
          ['r', 'Run selected file'],
          ['R', 'Re-run last file'],
          ['x', 'Cancel active run'],
          ['v', 'Toggle --verbose'],
          ['V', 'Toggle --very-verbose'],
        ],
      },
      {
        heading: 'Output',
        rows: [
          ['o', 'Toggle source / response view'],
          ['i', 'Inspect: show resolved env values in source'],
          ['g / G', 'Scroll top / bottom'],
          ['J / K', 'Page down / up'],
          ['y', 'Copy full response to clipboard'],
        ],
      },
      {
        heading: 'Environment & editing',
        rows: [
          ['E', 'Pick *.env file for --variables-file'],
          ['e', 'Open selected .hurl in $EDITOR'],
        ],
      },
      {
        heading: 'This dialog',
        rows: [
          ['?  /  F1', 'Show this help'],
          ['Esc  /  Enter  /  ?', 'Close help'],
        ],
      },
    ];

    const body = document.createElement('div');
    body.className = 'krypton-hurl__help-body';

    for (const section of sections) {
      const h = document.createElement('div');
      h.className = 'krypton-hurl__help-heading';
      h.textContent = section.heading;
      body.appendChild(h);

      const table = document.createElement('div');
      table.className = 'krypton-hurl__help-table';
      for (const [keyLabel, desc] of section.rows) {
        const row = document.createElement('div');
        row.className = 'krypton-hurl__help-row';
        const k = document.createElement('span');
        k.className = 'krypton-hurl__help-key';
        k.textContent = keyLabel;
        const d = document.createElement('span');
        d.className = 'krypton-hurl__help-desc';
        d.textContent = desc;
        row.appendChild(k);
        row.appendChild(d);
        table.appendChild(row);
      }
      body.appendChild(table);
    }

    overlay.appendChild(body);

    const hint = document.createElement('div');
    hint.className = 'krypton-hurl__help-hint';
    hint.textContent = 'Press Esc to close';
    overlay.appendChild(hint);

    this.element.appendChild(overlay);
    this.helpEl = overlay;
  }

  private closeHelp(): void {
    if (!this.helpEl) return;
    this.helpEl.remove();
    this.helpEl = null;
    this.element.focus();
  }

  // ─── Editor launch ────────────────────────────────────────────

  private async launchEditor(fileDir: string, filePath: string): Promise<void> {
    if (!this.editorCb) return;
    let editor = 'vi';
    try {
      const val = await invoke<string | null>('get_env_var', { name: 'EDITOR' });
      if (val && val.length > 0) editor = val;
    } catch { /* fall through */ }
    this.editorCb(fileDir, editor, filePath);
  }

  // ─── State persistence ───────────────────────────────────────

  private saveStateDebounced(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushState();
    }, 300);
  }

  private async flushState(): Promise<void> {
    const row = this.visible[this.selectedIndex];
    const state: HurlSidebarState = {
      version: 1,
      cwd: this.cwd,
      expanded: [...this.expanded],
      selected_rel_path: row?.node.kind === 'file' ? row.node.relPath : null,
      view_mode: this.viewMode,
      verbose: this.verbose,
      very_verbose: this.veryVerbose,
      active_env_file: this.activeEnvFile,
      resolved_view: this.resolvedView,
      updated_at: Date.now(),
    };
    try {
      await invoke('hurl_save_sidebar_state', { state });
    } catch { /* ignore */ }
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  onResize(_w: number, _h: number): void {
    /* no-op */
  }

  dispose(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.flushState();
    }
    if (this.renderRaf !== null) {
      cancelAnimationFrame(this.renderRaf);
      this.renderRaf = null;
    }
    this.stopElapsedTimer();
    if (this.outputUnlisten) {
      this.outputUnlisten();
      this.outputUnlisten = null;
    }
    if (this.finishedUnlisten) {
      this.finishedUnlisten();
      this.finishedUnlisten = null;
    }
    if (this.activeRun) {
      void this.cancelActive();
    }
    if (this.pickerEl) {
      this.pickerEl.remove();
      this.pickerEl = null;
    }
    if (this.helpEl) {
      this.helpEl.remove();
      this.helpEl = null;
    }
    this.element.remove();
  }
}
