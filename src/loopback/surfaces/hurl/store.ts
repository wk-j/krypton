// Spec 227 / 237 — the Hurl web client's state and flows: listing, saved
// per-cwd state (`/state`), source and cached response, run with live SSE
// output and cancel, copy as curl / hurl command.
// Spec 361: the old `HurlView` class minus its DOM. Its async flows read the
// current state after every await, so they live in this store; what the page
// shows is the `HurlSnapshot` the flows paint (at the same moments the old
// view repainted), read with `useSyncExternalStore`.

import { hurlCliCommand, hurlToCurl } from '../../../hurl-curl';
import { collapsedCover, revealDir, revealFile } from '../../../hurl-tree';
import { copyText } from '../../kit';
import type { BannerTone, DotState, Stat } from '../../kit';
import { copyableBody } from './response';
import type { ResponseState, ResponseView } from './response';
import { fileRows, runRows } from './tree';
import type { HurlFile, RunRecord, TreeRow } from './tree';

interface Listing {
  readonly available?: boolean;
  readonly cwd?: string;
  readonly error?: string | null;
  readonly hurl_files?: HurlFile[];
  readonly env_files?: HurlFile[];
}

interface CacheEntry {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit_code: number | null;
  readonly duration_ms: number | null;
}

interface SavedState {
  readonly expanded?: string[];
  readonly selected_rel_path?: string | null;
  readonly view_mode?: string;
  readonly verbose?: boolean;
  readonly very_verbose?: boolean;
  readonly active_env_file?: string | null;
  readonly resolved_view?: boolean;
}

export const VIEWS: readonly { id: ResponseView; label: string }[] = [
  { id: 'pretty', label: 'Pretty' },
  { id: 'raw', label: 'Raw' },
  { id: 'headers', label: 'Headers' },
];

/** What the source pane shows: highlighted code, or a plain note. */
export type SourceShown =
  | {
      readonly kind: 'code';
      readonly text: string;
      readonly vars: Record<string, string> | undefined;
      readonly substitute: boolean;
    }
  | { readonly kind: 'note'; readonly text: string };

export interface HurlSnapshot {
  readonly cwdLabel: string;
  /** Unset until the listing loaded. */
  readonly cwdTitle: string | undefined;
  readonly envFiles: readonly HurlFile[];
  /** The variables `<select>` value; `''` is `env: (none)`. */
  readonly envValue: string;
  readonly verbose: boolean;
  readonly veryVerbose: boolean;
  /** Run button `data-state`: unset until the first run, then `running` / `''`. */
  readonly runState: 'running' | '' | undefined;
  readonly runDisabled: boolean;
  readonly copyDisabled: boolean;
  readonly reloading: boolean;
  readonly dot: DotState;
  readonly stats: readonly Stat[];
  readonly mode: 'files' | 'runs';
  readonly rosterTitle: string;
  readonly count: string;
  readonly query: string;
  readonly rows: readonly TreeRow[];
  /** Key of the roster's selected row. */
  readonly cursor: string | null;
  readonly treeEmpty: string;
  readonly crumb: string;
  readonly source: SourceShown;
  readonly view: ResponseView;
  readonly response: ResponseState;
  /** Saved state applied (the old `start()` re-measured the splits here). */
  readonly ready: boolean;
}

export interface BannerPort {
  show(text: string, tone?: BannerTone, ms?: number): void;
  hide(): void;
}

function relOf(path: string, list: readonly HurlFile[]): string {
  return list.find((f) => f.path === path)?.rel_path || path;
}

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export class HurlStore {
  private readonly api: string;
  private readonly listeners = new Set<() => void>();
  private snapshot: HurlSnapshot;
  /** Bumped on unmount; a flow awaiting across it never resumes. */
  private session = 0;

  private files: HurlFile[] = [];
  private envFiles: HurlFile[] = [];
  private envPath = '';
  private envVars: Record<string, string> = {};
  private expanded = new Set<string>();
  private selected: string | null = null;
  private rows: TreeRow[] = [];
  private cursor: string | null = null;
  private query = '';
  private resolvedView = false;
  private sourceText = '';
  private stdout = '';
  private stderr = '';
  private lastExit: number | null = null;
  private lastMs: number | null = null;
  private mode: 'files' | 'runs' = 'files';
  private view: ResponseView = 'pretty';
  private verbose = false;
  private veryVerbose = false;
  private running = false;
  private runId: string | null = null;
  private events: EventSource | null = null;
  /** This session's finished runs, newest first (max 20). */
  private runHistory: RunRecord[] = [];
  private available = true;
  private persistTimer: number | undefined;
  private reloading = false;
  private stateReady = false;
  private cwdPath = '';

  constructor(
    token: string,
    private readonly banner: BannerPort,
  ) {
    this.api = `/hurl/api/${token}`;
    this.snapshot = {
      cwdLabel: 'connecting',
      cwdTitle: undefined,
      envFiles: [],
      envValue: '',
      verbose: false,
      veryVerbose: false,
      runState: undefined,
      runDisabled: true,
      copyDisabled: true,
      reloading: false,
      dot: 'idle',
      stats: [],
      mode: 'files',
      rosterTitle: 'Files',
      count: '0',
      query: '',
      rows: [],
      cursor: null,
      treeEmpty: '',
      crumb: 'select a .hurl file',
      source: { kind: 'code', text: '', vars: undefined, substitute: false },
      view: 'pretty',
      response: this.responseState(),
      ready: false,
    };
    this.renderStats();
    this.setRunEnabled();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): HurlSnapshot => this.snapshot;

  /** Listing → saved state → first paint. The returned cleanup stops the stream, the timer and every pending flow. */
  mount(): () => void {
    void this.start();
    return () => {
      this.session += 1;
      window.clearTimeout(this.persistTimer);
      this.closeStream();
    };
  }

  // ---- intents (keys, buttons, roster) --------------------------------------------

  setMode(mode: 'files' | 'runs'): void {
    this.mode = mode;
    this.paint({ mode });
    this.renderTree();
  }

  setQuery(query: string): void {
    this.query = query;
    this.paint({ query });
    this.renderTree();
  }

  /** The roster moved its selection onto `row`. */
  selectRow(row: TreeRow): void {
    this.cursor = row.key;
    this.paint({ cursor: row.key });
    if (row.kind !== 'dir' && row.path !== this.selected) void this.selectFile(row.path);
    else this.schedulePersist();
  }

  /** A roster row was clicked (after `selectRow`). */
  openRow(row: TreeRow): void {
    if (row.kind === 'dir') this.toggleFolder(row.rel, !row.open);
  }

  hasRows(): boolean {
    return this.rows.length > 0;
  }

  collapseAtCursor(): void {
    const row = this.cursorRow();
    if (!row || row.kind === 'run') return;
    if (row.kind === 'dir' && row.open) {
      this.toggleFolder(row.rel, false);
      return;
    }
    const parent = row.rel.includes('/') ? row.rel.split('/').slice(0, -1).join('/') : '';
    if (parent) this.toggleFolder(parent, false);
  }

  expandAtCursor(): void {
    const row = this.cursorRow();
    if (row?.kind === 'dir' && !row.open) this.toggleFolder(row.rel, true);
  }

  /** Enter: toggle the folder under the cursor, else run the open file. */
  enter(): void {
    const row = this.cursorRow();
    if (row?.kind === 'dir') this.toggleFolder(row.rel, !row.open);
    else void this.runSelected();
  }

  setEnv(path: string): void {
    this.envPath = path;
    this.paint({ envValue: path });
    void this.loadEnv();
  }

  cycleEnv(): void {
    const values = ['', ...this.envFiles.map((f) => f.path)];
    this.setEnv(values[(values.indexOf(this.envPath) + 1) % values.length]);
  }

  /** `--verbose` and `--very-verbose` are exclusive: turning one on turns the other off. */
  toggleVerbose(which: 'v' | 'vv'): void {
    if (which === 'v') {
      this.verbose = !this.verbose;
      if (this.verbose) this.veryVerbose = false;
    } else {
      this.veryVerbose = !this.veryVerbose;
      if (this.veryVerbose) this.verbose = false;
    }
    this.paint({ verbose: this.verbose, veryVerbose: this.veryVerbose });
    this.schedulePersist();
  }

  setView(view: ResponseView): void {
    this.view = view;
    this.paint({ view });
    this.renderResponse();
    this.schedulePersist();
  }

  copyBody(): Promise<boolean> {
    return copyText(copyableBody(this.responseState()));
  }

  async reloadFiles(): Promise<void> {
    if (this.reloading) return;
    this.setReloading(true);
    try {
      const prev = new Set(this.files.map((f) => f.path));
      const keep = this.selected;
      if (!(await this.loadListing(true))) return;
      const added = this.files.filter((f) => !prev.has(f.path));
      if (added.length) {
        const expanded = new Set(this.expanded);
        for (const f of added) if (f.rel_path) revealFile(expanded, f.rel_path);
        this.expanded = expanded;
        this.flushPersist();
      }
      if (added.length && this.mode !== 'files') this.setMode('files');
      if (added.length === 1 && !this.running) {
        this.banner.show(`New file: ${added[0].rel_path || added[0].name}`, 'ok', 2500);
        await this.selectFile(added[0].path);
        return;
      }
      if (added.length > 1) this.banner.show(`${added.length} new .hurl files`, 'ok', 2500);
      if (!keep || !this.files.some((f) => f.path === keep)) {
        if (this.files[0] && !this.running) await this.selectFile(this.files[0].path);
        else {
          this.selected = null;
          this.renderTree();
          this.setRunEnabled();
        }
        return;
      }
      this.renderTree();
      if (!this.running) await this.fetchSource(keep);
    } catch (error) {
      this.banner.show(String(error), 'error');
    } finally {
      this.setReloading(false);
    }
  }

  async runSelected(): Promise<void> {
    if (!this.selected || !this.available) return;
    if (this.running) {
      await this.cancelRun();
      return;
    }
    this.setRunning(true);
    this.stdout = '';
    this.stderr = '';
    this.renderResponse();
    this.renderStats();
    const res = await this.live(
      fetch(`${this.api}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: this.selected,
          verbose: this.verbose,
          veryVerbose: this.veryVerbose,
          variablesFile: this.envPath || null,
        }),
      }),
    );
    if (!res.ok) {
      this.setRunning(false);
      const err = await this.live(res.json().catch(() => ({ error: res.statusText })) as Promise<{ error?: string }>);
      this.banner.show(err.error || 'run failed', 'error');
      this.renderStats();
      return;
    }
    const payload = await this.live(res.json() as Promise<{ runId: string }>);
    this.runId = payload.runId;
    this.closeStream();
    const events = new EventSource(`${this.api}/events/${payload.runId}`);
    this.events = events;
    events.addEventListener('output', (ev) => {
      const data = JSON.parse((ev as MessageEvent<string>).data) as { stream?: string; chunk?: string };
      if (data.stream === 'stderr') this.stderr += data.chunk ?? '';
      else this.stdout += data.chunk ?? '';
      if (this.view === 'raw') this.renderResponse();
    });
    events.addEventListener('finished', (ev) => {
      const data = JSON.parse((ev as MessageEvent<string>).data) as {
        stdout?: string | null;
        stderr?: string | null;
        exitCode: number | null;
        durationMs: number | null;
        truncated?: boolean;
      };
      this.stdout = data.stdout ?? this.stdout;
      this.stderr = data.stderr ?? this.stderr;
      this.lastExit = data.exitCode;
      this.lastMs = data.durationMs;
      if (data.truncated) this.banner.show('Output truncated at 1 MB.', 'error');
      this.finishRun();
    });
    events.onerror = (): void => {
      if (this.running) this.finishRun();
    };
  }

  async cancelRun(): Promise<void> {
    if (this.runId === null) return;
    await this.live(
      fetch(`${this.api}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: this.runId }),
      }),
    );
  }

  async copyCurl(): Promise<void> {
    if (!this.selected || !this.sourceText) {
      this.banner.show('Select a .hurl file', 'error');
      return;
    }
    const slash = Math.max(this.selected.lastIndexOf('/'), this.selected.lastIndexOf('\\'));
    const result = hurlToCurl(this.sourceText, this.envVars, { fileDir: slash >= 0 ? this.selected.slice(0, slash) : '' });
    if (!result.curl) {
      this.banner.show('Select a .hurl file', 'error');
      return;
    }
    if (!(await this.live(copyText(result.curl)))) {
      this.banner.show('Copy failed', 'error');
      return;
    }
    const env = this.envLabel();
    let msg = `Copied curl · ${env ? `env: ${env}` : '(none)'}`;
    if (result.unresolved.length) msg += ` · ${result.unresolved.length} unresolved: ${result.unresolved.join(', ')}`;
    this.banner.show(msg, 'ok', 2500);
  }

  async copyHurlCli(): Promise<void> {
    if (!this.selected) {
      this.banner.show('Select a .hurl file', 'error');
      return;
    }
    const envRel = this.envPath ? relOf(this.envPath, this.envFiles) : '';
    const cmd = hurlCliCommand(relOf(this.selected, this.files), envRel || null, {
      verbose: this.verbose,
      veryVerbose: this.veryVerbose,
    });
    if (!(await this.live(copyText(cmd)))) {
      this.banner.show('Copy failed', 'error');
      return;
    }
    const env = this.envLabel();
    this.banner.show(`Copied hurl · ${env ? `env: ${env}` : '(none)'}`, 'ok', 2500);
  }

  flushPersist(): void {
    window.clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.persist();
  }

  // ---- flows ------------------------------------------------------------------------

  private async start(): Promise<void> {
    try {
      if (!(await this.loadListing(true))) return;
      const cursor = await this.restoreState();
      this.renderTree(cursor);
      this.stateReady = true;
      this.paint({ ready: true });
      if (cursor === undefined && !this.selected && this.files[0]) await this.selectFile(this.files[0].path);
    } catch (error) {
      this.banner.show(String(error), 'error');
    }
  }

  private async loadListing(skipRender: boolean): Promise<boolean> {
    const res = await this.live(fetch(`${this.api}/listing`));
    if (res.status === 404) {
      this.banner.show('Unknown or expired Hurl session. Re-open from Krypton.', 'error');
      return false;
    }
    const data = await this.live(res.json() as Promise<Listing>);
    this.available = data.available === true;
    this.cwdPath = data.cwd ?? '';
    const slash = Math.max(this.cwdPath.lastIndexOf('/'), this.cwdPath.lastIndexOf('\\'));
    this.files = data.hurl_files ?? [];
    this.envFiles = data.env_files ?? [];
    // A variables file that left the listing leaves the select on no option, i.e. ''.
    if (!this.envFiles.some((f) => f.path === this.envPath)) this.envPath = '';
    this.paint({
      cwdLabel: slash >= 0 ? this.cwdPath.slice(slash + 1) : this.cwdPath,
      cwdTitle: this.cwdPath,
      envFiles: this.envFiles,
      envValue: this.envPath,
    });
    if (data.error && !this.available) this.banner.show(data.error, 'error');
    else this.banner.hide();
    if (!skipRender) this.renderTree();
    this.setRunEnabled();
    return true;
  }

  /** Returns the folder the cursor should land on when the saved file sits in a collapsed one. */
  private async restoreState(): Promise<string | undefined> {
    const res = await this.live(fetch(`${this.api}/state`));
    const st = res.ok ? await this.live(res.json() as Promise<SavedState | null>) : null;
    if (!st) {
      const expanded = new Set<string>();
      if (this.files[0]?.rel_path) revealFile(expanded, this.files[0].rel_path);
      this.expanded = expanded;
      return undefined;
    }
    this.expanded = new Set(st.expanded ?? []);
    this.resolvedView = st.resolved_view === true;
    if (st.verbose) this.verbose = true;
    if (st.very_verbose) this.veryVerbose = true;
    this.paint({ verbose: this.verbose, veryVerbose: this.veryVerbose });
    if (st.view_mode === 'raw' || st.view_mode === 'headers' || st.view_mode === 'pretty') {
      this.view = st.view_mode;
      this.paint({ view: this.view });
    }
    if (st.active_env_file) {
      const saved = st.active_env_file;
      this.envPath = this.envFiles.some((f) => f.path === saved) ? saved : '';
      this.paint({ envValue: this.envPath });
    }
    await this.loadEnv();
    if (st.selected_rel_path) {
      const cover = collapsedCover(this.expanded, st.selected_rel_path);
      if (cover) return cover;
      const match = this.files.find((f) => f.rel_path === st.selected_rel_path);
      if (match) await this.selectFile(match.path);
    }
    return '';
  }

  private async fetchSource(path: string): Promise<void> {
    const res = await this.live(fetch(`${this.api}/source?path=${encodeURIComponent(path)}`));
    if (res.status === 415) {
      this.sourceText = '';
      this.paint({ source: { kind: 'note', text: 'binary or invalid UTF-8' } });
      return;
    }
    if (!res.ok) return;
    const src = await this.live(res.json() as Promise<{ source?: string }>);
    this.sourceText = src.source ?? '';
    this.renderSource();
  }

  private async selectFile(path: string): Promise<void> {
    this.selected = path;
    const file = this.files.find((f) => f.path === path);
    this.paint({ crumb: file?.rel_path || path });
    this.renderTree();
    this.sourceText = '';
    this.stdout = '';
    this.stderr = '';
    this.lastExit = null;
    this.lastMs = null;
    await this.fetchSource(path);
    const cacheRes = await this.live(fetch(`${this.api}/cache?path=${encodeURIComponent(path)}`));
    if (cacheRes.ok) {
      const cache = await this.live(cacheRes.json() as Promise<CacheEntry | null>);
      if (cache) {
        this.stdout = cache.stdout ?? '';
        this.stderr = cache.stderr ?? '';
        this.lastExit = cache.exit_code;
        this.lastMs = cache.duration_ms;
      }
    }
    this.renderResponse();
    this.renderStats();
    this.setRunEnabled();
    this.schedulePersist();
  }

  private async loadEnv(): Promise<void> {
    this.envVars = {};
    if (this.envPath) {
      const res = await this.live(fetch(`${this.api}/env?path=${encodeURIComponent(this.envPath)}`));
      if (res.ok) this.envVars = await this.live(res.json() as Promise<Record<string, string>>);
    }
    this.renderSource();
    this.renderStats();
    if (this.envPath) this.schedulePersist();
  }

  private finishRun(): void {
    this.setRunning(false);
    this.closeStream();
    if (this.selected && this.lastExit !== null) {
      this.runHistory.unshift({ path: this.selected, exit: this.lastExit, ms: this.lastMs ?? 0 });
      if (this.runHistory.length > 20) this.runHistory.pop();
    }
    this.renderResponse();
    this.renderStats();
    this.renderTree();
  }

  private closeStream(): void {
    this.events?.close();
    this.events = null;
  }

  // ---- roster -----------------------------------------------------------------------

  private cursorRow(): TreeRow | null {
    return this.rows.find((r) => r.key === this.cursor) ?? null;
  }

  private toggleFolder(rel: string, open: boolean): void {
    const expanded = new Set(this.expanded);
    if (open) revealDir(expanded, rel);
    else expanded.delete(rel);
    this.expanded = expanded;
    this.renderTree(rel);
    this.flushPersist();
  }

  /** Repaint the roster; the cursor lands on `preferRel`, else the open file, else stays put. */
  private renderTree(preferRel?: string): void {
    const before = this.rows.findIndex((r) => r.key === this.cursor);
    let empty = '';
    let count: string;
    let title: string;
    if (this.mode === 'runs') {
      this.rows = runRows(this.runHistory);
      if (this.rows.length === 0) empty = 'No runs this session.';
      count = `${this.runHistory.length} runs`;
      title = 'History';
    } else {
      this.rows = fileRows(this.files, this.query, this.expanded, this.runHistory);
      if (this.rows.length === 0) {
        empty = this.files.length ? 'No .hurl files match.' : 'No .hurl files under this directory. Add one and press .';
      }
      count = this.rows.length ? `${this.rows.filter((r) => r.kind === 'file').length} files` : '0';
      title = 'Files';
    }
    const rows = this.rows;
    if (!rows.some((r) => r.key === this.cursor)) this.cursor = null;
    if (rows.length > 0) {
      const target =
        (preferRel !== undefined ? rows.find((r) => r.rel === preferRel) : undefined) ??
        rows.find((r) => r.kind !== 'dir' && r.path === this.selected) ??
        rows[Math.max(0, Math.min(before < 0 ? 0 : before, rows.length - 1))];
      this.cursor = target.key;
    }
    this.paint({ rows, cursor: this.cursor, treeEmpty: empty, count, rosterTitle: title });
  }

  // ---- paint ------------------------------------------------------------------------

  private paint(patch: Partial<HurlSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Resolve `work` only while the page that started it is still mounted; else never settle. */
  private live<T>(work: Promise<T>): Promise<T> {
    const session = this.session;
    return work.then(
      (value) => (session === this.session ? value : new Promise<T>(() => undefined)),
      (error: unknown) => (session === this.session ? Promise.reject(error) : new Promise<T>(() => undefined)),
    );
  }

  private responseState(): ResponseState {
    return { running: this.running, stdout: this.stdout, stderr: this.stderr, view: this.view };
  }

  private renderSource(): void {
    const vars = Object.keys(this.envVars).length ? this.envVars : undefined;
    this.paint({ source: { kind: 'code', text: this.sourceText, vars, substitute: this.resolvedView } });
  }

  private renderResponse(): void {
    this.paint({ response: this.responseState() });
  }

  private envLabel(): string | null {
    const file = this.envPath ? this.envFiles.find((f) => f.path === this.envPath) : undefined;
    return file ? file.rel_path || file.name : null;
  }

  private renderStats(): void {
    const size = this.stdout.length + this.stderr.length;
    const status: Stat = this.running
      ? { key: 'status', label: 'Status', value: 'RUNNING' }
      : this.lastExit === null
        ? { key: 'status', label: 'Status', value: '—', tone: 'muted' }
        : { key: 'status', label: 'Status', value: `EXIT ${this.lastExit}`, tone: this.lastExit === 0 ? 'add' : 'del' };
    this.paint({
      dot: this.running ? 'live' : this.lastExit === null ? 'idle' : this.lastExit === 0 ? 'add' : 'del',
      stats: [
        status,
        {
          key: 'ms',
          label: 'Duration',
          value: !this.running && this.lastExit !== null && this.lastMs !== null ? `${this.lastMs} ms` : '—',
          tone: 'muted',
        },
        { key: 'bytes', label: 'Body', value: size ? bytesLabel(size) : '—', tone: 'muted' },
        { key: 'env', label: 'Variables', value: this.envLabel() ?? '(none)', tone: 'muted' },
      ],
    });
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.paint({ runState: running ? 'running' : '' });
  }

  private setReloading(reloading: boolean): void {
    this.reloading = reloading;
    this.paint({ reloading });
  }

  private setRunEnabled(): void {
    this.paint({ runDisabled: !this.available || !this.selected, copyDisabled: !this.selected });
  }

  // ---- persistence ----------------------------------------------------------------------

  private schedulePersist(): void {
    if (!this.stateReady) return;
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persist(), 300);
  }

  private persist(): void {
    if (!this.stateReady || !this.cwdPath) return;
    const file = this.files.find((f) => f.path === this.selected);
    fetch(`${this.api}/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        version: 1,
        cwd: this.cwdPath,
        expanded: [...this.expanded],
        selected_rel_path: file?.rel_path ?? null,
        view_mode: this.view,
        verbose: this.verbose,
        very_verbose: this.veryVerbose,
        active_env_file: this.envPath || null,
        resolved_view: this.resolvedView,
        updated_at: Date.now(),
      }),
    }).catch(() => undefined);
  }
}
