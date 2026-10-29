// Spec 227 / 237 — the Hurl web client: file roster, read-only highlighted
// source, run with live SSE output, Pretty / Raw / Headers response views,
// copy as curl / hurl command. Per-cwd state round-trips through `/state`.

import { hurlCliCommand, hurlToCurl } from '../../../hurl-curl';
import { highlightHurl } from '../../../hurl-highlight';
import { collapsedCover, revealDir, revealFile } from '../../../hurl-tree';
import { DisposableBag } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import {
  Banner,
  button,
  copyText,
  dot,
  kbdHints,
  keymap,
  RosterList,
  SearchFilter,
  setPressed,
  StatBar,
  Tabs,
} from '../../kit';
import type { Stat } from '../../kit';
import { copyableBody, renderResponse } from './response';
import type { ResponseView } from './response';
import { Splits } from './splits';
import { fileRows, renderRow, runRows } from './tree';
import type { HurlFile, RunRecord, TreeRow } from './tree';

import './hurl.css';

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

const VIEWS: readonly { id: ResponseView; label: string }[] = [
  { id: 'pretty', label: 'Pretty' },
  { id: 'raw', label: 'Raw' },
  { id: 'headers', label: 'Headers' },
];

/** `/hurl/<token>` → `<token>`. */
export function hurlToken(pathname: string): string {
  return pathname.split('/').filter(Boolean)[1] ?? '';
}

function relOf(path: string, list: readonly HurlFile[]): string {
  return list.find((f) => f.path === path)?.rel_path || path;
}

export class HurlView {
  readonly el: HTMLElement;
  private readonly api: string;
  private readonly bag = new DisposableBag();
  private readonly banner = new Banner();
  private readonly stats = new StatBar();
  private readonly runDot = el('span', { class: 'lb-hurl__run-state' });
  private readonly cwdEl = el('span', { class: 'lb-hurl__cwd', text: 'connecting' });
  private readonly envEl = el('select', { class: ['lb-input', 'lb-hurl__env'], attrs: { 'aria-label': 'Variables file' } });
  private readonly verboseBtn: HTMLButtonElement;
  private readonly veryBtn: HTMLButtonElement;
  private readonly curlBtn: HTMLButtonElement;
  private readonly hurlBtn: HTMLButtonElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly reloadBtn: HTMLButtonElement;
  private readonly rosterTitle = el('h2', { class: 'lb-h2', text: 'Files' });
  private readonly countEl = el('span', { class: 'lb-hurl__count', text: '0' });
  private readonly modeTabs: Tabs;
  private readonly viewTabs: Tabs;
  private readonly filter: SearchFilter;
  private readonly roster: RosterList<TreeRow>;
  private readonly treeEmpty = el('div', { class: 'lb-hurl__tree-empty', attrs: { hidden: true } });
  private readonly crumbEl = el('div', { class: 'lb-hurl__crumb', text: 'select a .hurl file' });
  private readonly sourceEl = el('pre', { class: ['lb-hurl__code', 'lb-hurl__source'], attrs: { tabindex: '0' } });
  private readonly viewportEl = el('div', { class: ['lb-hurl__code', 'lb-hurl__viewport'], attrs: { tabindex: '0' } });
  private readonly splits: Splits;

  private files: HurlFile[] = [];
  private envFiles: HurlFile[] = [];
  private envVars: Record<string, string> = {};
  private expanded = new Set<string>();
  private selected: string | null = null;
  private rows: TreeRow[] = [];
  private resolvedView = false;
  private sourceText = '';
  private stdout = '';
  private stderr = '';
  private lastExit: number | null = null;
  private lastMs: number | null = null;
  private mode: 'files' | 'runs' = 'files';
  private view: ResponseView = 'pretty';
  private running = false;
  private runId: string | null = null;
  private events: EventSource | null = null;
  /** This session's finished runs, newest first (max 20). */
  private runHistory: RunRecord[] = [];
  private available = true;
  private persistTimer: number | undefined;
  private reloading = false;
  private stateReady = false;
  private focusPane: 'source' | 'response' = 'source';
  private cwdPath = '';

  constructor(private readonly token: string) {
    this.api = `/hurl/api/${token}`;
    this.verboseBtn = button('v', { variant: 'toggle', title: 'Toggle --verbose', onClick: () => this.toggleVerbose('v') });
    this.veryBtn = button('VV', { variant: 'toggle', title: 'Toggle --very-verbose', onClick: () => this.toggleVerbose('vv') });
    this.curlBtn = button('curl', { title: 'Copy as curl (c)', onClick: () => void this.copyCurl() });
    this.hurlBtn = button('hurl', { title: 'Copy hurl command (H)', onClick: () => void this.copyHurlCli() });
    this.runBtn = button('Run', { variant: 'primary', onClick: () => void this.runSelected() });
    this.reloadBtn = button('reload', { variant: 'ghost', title: 'Reload listing and source', onClick: () => void this.reloadFiles() });
    this.envEl.append(el('option', { attrs: { value: '' }, text: 'env: (none)' }));
    this.bag.listen(this.envEl, 'change', () => void this.loadEnv());

    this.modeTabs = new Tabs(
      { label: 'Roster', onSelect: (id) => this.setMode(id === 'runs' ? 'runs' : 'files') },
      { tabs: [{ id: 'files', label: 'Files' }, { id: 'runs', label: 'History' }], active: 'files' },
    );
    this.viewTabs = new Tabs({ label: 'Response view', onSelect: (id) => this.setView(id as ResponseView) }, { tabs: VIEWS, active: 'pretty' });
    this.filter = new SearchFilter({
      placeholder: '/  filter .hurl',
      label: 'Filter files',
      escape: 'clear-and-leave',
      onInput: () => this.renderTree(),
    });
    this.roster = new RosterList<TreeRow>({
      label: 'Hurl files',
      key: (row) => row.key,
      render: renderRow,
      deps: (row) => [row.name, row.depth, row.open, row.exit, row.ms],
      keys: false,
      onSelect: (row) => {
        if (row.kind !== 'dir' && row.path !== this.selected) void this.selectFile(row.path);
        else this.schedulePersist();
      },
      onOpen: (row) => {
        if (row.kind === 'dir') this.toggleFolder(row.rel, !row.open);
      },
    });

    const workspace = el('section', { class: 'lb-hurl__workspace' });
    const panes = el('div', { class: 'lb-hurl__panes' });
    this.bindKeys();
    // After the page keys: a focused separator's arrows must win over j/k/↑/↓.
    this.splits = new Splits(workspace, panes);

    panes.append(
      el(
        'section',
        { class: 'lb-hurl__pane' },
        el(
          'div',
          { class: 'lb-hurl__pane-head' },
          el('div', { class: 'lb-hurl__pane-title' }, el('strong', { text: 'Source' }), this.crumbEl),
          el('span', { class: ['lb-hurl__crumb', 'lb-hurl__note'], text: 'read only · e opens $EDITOR in Krypton' }),
        ),
        this.sourceEl,
      ),
      this.splits.source,
      el(
        'section',
        { class: 'lb-hurl__pane' },
        el('div', { class: 'lb-hurl__pane-head' }, el('strong', { text: 'Response' }), this.viewTabs.el),
        this.viewportEl,
      ),
    );
    workspace.append(
      el(
        'aside',
        { class: 'lb-hurl__roster', attrs: { 'aria-label': 'Hurl files' } },
        el(
          'div',
          { class: 'lb-hurl__roster-head' },
          el('div', { class: 'lb-hurl__roster-title' }, this.rosterTitle, el('span', { class: 'lb-hurl__tools' }, this.countEl, this.reloadBtn)),
          this.modeTabs.el,
          this.filter.el,
        ),
        el('div', { class: 'lb-hurl__tree' }, this.roster.el, this.treeEmpty),
      ),
      this.splits.roster,
      panes,
    );

    this.el = el(
      'div',
      { class: ['lb-page', 'lb-page--fill', 'lb-hurl'] },
      el(
        'div',
        { class: 'lb-hurl__toolbar' },
        el('div', { class: 'lb-hurl__where' }, this.runDot, this.cwdEl),
        el('div', { class: 'lb-hurl__actions' }, this.envEl, this.verboseBtn, this.veryBtn, this.curlBtn, this.hurlBtn, this.runBtn),
      ),
      this.banner.el,
      this.stats.el,
      workspace,
      kbdHints([
        ['j k', 'move'],
        ['h l Enter', 'fold'],
        ['r', 'run'],
        ['x', 'cancel'],
        ['1 2 3', 'pretty / raw / headers'],
        ['v', 'verbose'],
        ['E', 'env'],
        ['/', 'filter'],
        ['.', 'reload'],
        ['[ ]', 'files'],
        ['- =', 'source'],
        ['y', 'copy body'],
        ['c', 'curl'],
        ['H', 'hurl'],
      ]),
    );

    const flush = (): void => this.flushPersist();
    this.bag.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    this.bag.listen(window, 'pagehide', flush);
    this.bag.listen(window, 'beforeunload', flush);
    this.renderStats();
    this.renderResponse();
    this.setRunEnabled();
  }

  /** Listing → saved state → first paint. Resolves once the page is interactive. */
  async start(): Promise<void> {
    try {
      if (!(await this.loadListing(true))) return;
      const cursor = await this.restoreState();
      this.renderTree(cursor);
      this.stateReady = true;
      this.splits.apply();
      if (cursor === undefined && !this.selected && this.files[0]) await this.selectFile(this.files[0].path);
    } catch (error) {
      this.banner.show(String(error), 'error');
    }
  }

  dispose(): void {
    window.clearTimeout(this.persistTimer);
    this.closeStream();
    this.bag.dispose();
    this.splits.dispose();
    this.roster.dispose();
    this.filter.dispose();
    this.modeTabs.dispose();
    this.viewTabs.dispose();
    this.banner.dispose();
  }

  private bindKeys(): void {
    const files = (): boolean => this.rows.length > 0;
    this.bag.add(
      keymap().bindAll([
        { key: '.', label: 'Reload listing and source', run: () => void this.reloadFiles() },
        { key: ['j', 'ArrowDown'], label: 'Next row', when: files, run: () => this.roster.move(1) },
        { key: ['k', 'ArrowUp'], label: 'Previous row', when: files, run: () => this.roster.move(-1) },
        { key: 'h', label: 'Collapse folder', run: () => this.collapseAtCursor() },
        { key: 'l', label: 'Expand folder', run: () => this.expandAtCursor() },
        {
          key: 'Enter',
          label: 'Toggle folder / run file',
          run: () => {
            const row = this.roster.selected();
            if (row?.kind === 'dir') this.toggleFolder(row.rel, !row.open);
            else void this.runSelected();
          },
        },
        { key: 'r', label: 'Run', run: () => void this.runSelected() },
        { key: 'x', label: 'Cancel the run', run: () => void this.cancelRun() },
        {
          key: ['1', '2', '3'],
          display: '1 / 2 / 3',
          label: 'Pretty / raw / headers',
          run: (event) => this.setView(VIEWS[Number(event.key) - 1].id),
        },
        { key: 'o', label: 'Switch focus source / response', run: () => this.switchFocus() },
        { key: 'v', label: 'Toggle --verbose', run: () => this.toggleVerbose('v') },
        { key: 'V', label: 'Toggle --very-verbose', run: () => this.toggleVerbose('vv') },
        { key: 'E', label: 'Next variables file', run: () => this.cycleEnv() },
        { key: 'c', label: 'Copy as curl', run: () => void this.copyCurl() },
        { key: 'H', label: 'Copy hurl command', run: () => void this.copyHurlCli() },
        { key: 'y', label: 'Copy response body', run: () => void copyText(copyableBody(this.responseState())) },
      ]),
    );
  }

  // ---- roster ---------------------------------------------------------------

  private setMode(mode: 'files' | 'runs'): void {
    this.mode = mode;
    this.modeTabs.update({ tabs: [{ id: 'files', label: 'Files' }, { id: 'runs', label: 'History' }], active: mode });
    this.renderTree();
  }

  /** Repaint the roster; the cursor lands on `preferRel`, else the open file, else stays put. */
  private renderTree(preferRel?: string): void {
    const before = this.rows.findIndex((r) => r.key === this.roster.selected()?.key);
    let empty = '';
    if (this.mode === 'runs') {
      this.rows = runRows(this.runHistory);
      if (this.rows.length === 0) empty = 'No runs this session.';
      this.countEl.textContent = `${this.runHistory.length} runs`;
      this.rosterTitle.textContent = 'History';
    } else {
      this.rows = fileRows(this.files, this.filter.query, this.expanded, this.runHistory);
      if (this.rows.length === 0) {
        empty = this.files.length ? 'No .hurl files match.' : 'No .hurl files under this directory. Add one and press .';
      }
      this.countEl.textContent = this.rows.length ? `${this.rows.filter((r) => r.kind === 'file').length} files` : '0';
      this.rosterTitle.textContent = 'Files';
    }
    this.treeEmpty.textContent = empty;
    this.treeEmpty.hidden = !empty;
    this.roster.setItems(this.rows);
    if (this.rows.length === 0) return;
    const target =
      (preferRel !== undefined ? this.rows.find((r) => r.rel === preferRel) : undefined) ??
      this.rows.find((r) => r.kind !== 'dir' && r.path === this.selected) ??
      this.rows[Math.max(0, Math.min(before < 0 ? 0 : before, this.rows.length - 1))];
    this.roster.select(target.key, false);
  }

  private toggleFolder(rel: string, open: boolean): void {
    if (open) revealDir(this.expanded, rel);
    else this.expanded.delete(rel);
    this.renderTree(rel);
    this.flushPersist();
  }

  private collapseAtCursor(): void {
    const row = this.roster.selected();
    if (!row || row.kind === 'run') return;
    if (row.kind === 'dir' && row.open) {
      this.toggleFolder(row.rel, false);
      return;
    }
    const parent = row.rel.includes('/') ? row.rel.split('/').slice(0, -1).join('/') : '';
    if (parent) this.toggleFolder(parent, false);
  }

  private expandAtCursor(): void {
    const row = this.roster.selected();
    if (row?.kind === 'dir' && !row.open) this.toggleFolder(row.rel, true);
  }

  // ---- loading ----------------------------------------------------------------

  private async loadListing(skipRender: boolean): Promise<boolean> {
    const res = await fetch(`${this.api}/listing`);
    if (res.status === 404) {
      this.banner.show('Unknown or expired Hurl session. Re-open from Krypton.', 'error');
      return false;
    }
    const data = (await res.json()) as Listing;
    this.available = data.available === true;
    this.cwdPath = data.cwd ?? '';
    const slash = Math.max(this.cwdPath.lastIndexOf('/'), this.cwdPath.lastIndexOf('\\'));
    this.cwdEl.textContent = slash >= 0 ? this.cwdPath.slice(slash + 1) : this.cwdPath;
    this.cwdEl.title = this.cwdPath;
    this.files = data.hurl_files ?? [];
    this.envFiles = data.env_files ?? [];
    const keep = this.envEl.value;
    setChildren(this.envEl, [
      el('option', { attrs: { value: '' }, text: 'env: (none)' }),
      ...this.envFiles.map((f) => el('option', { attrs: { value: f.path }, text: `env: ${f.rel_path || f.name}` })),
    ]);
    if (keep) this.envEl.value = keep;
    if (data.error && !this.available) this.banner.show(data.error, 'error');
    else this.banner.hide();
    if (!skipRender) this.renderTree();
    this.setRunEnabled();
    return true;
  }

  /** Returns the folder the cursor should land on when the saved file sits in a collapsed one. */
  private async restoreState(): Promise<string | undefined> {
    const res = await fetch(`${this.api}/state`);
    const st = res.ok ? ((await res.json()) as SavedState | null) : null;
    if (!st) {
      this.expanded = new Set();
      if (this.files[0]?.rel_path) revealFile(this.expanded, this.files[0].rel_path);
      return undefined;
    }
    this.expanded = new Set(st.expanded ?? []);
    this.resolvedView = st.resolved_view === true;
    if (st.verbose) setPressed(this.verboseBtn, true);
    if (st.very_verbose) setPressed(this.veryBtn, true);
    if (st.view_mode === 'raw' || st.view_mode === 'headers' || st.view_mode === 'pretty') {
      this.view = st.view_mode;
      this.viewTabs.update({ tabs: VIEWS, active: this.view });
    }
    if (st.active_env_file) this.envEl.value = st.active_env_file;
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
    const res = await fetch(`${this.api}/source?path=${encodeURIComponent(path)}`);
    if (res.status === 415) {
      this.sourceText = '';
      this.sourceEl.textContent = 'binary or invalid UTF-8';
      return;
    }
    if (!res.ok) return;
    const src = (await res.json()) as { source?: string };
    this.sourceText = src.source ?? '';
    this.renderSource();
  }

  private async selectFile(path: string): Promise<void> {
    this.selected = path;
    const file = this.files.find((f) => f.path === path);
    this.crumbEl.textContent = file?.rel_path || path;
    this.renderTree();
    this.sourceText = '';
    this.stdout = '';
    this.stderr = '';
    this.lastExit = null;
    this.lastMs = null;
    await this.fetchSource(path);
    const cacheRes = await fetch(`${this.api}/cache?path=${encodeURIComponent(path)}`);
    if (cacheRes.ok) {
      const cache = (await cacheRes.json()) as CacheEntry | null;
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

  private async reloadFiles(): Promise<void> {
    if (this.reloading) return;
    this.reloading = true;
    this.reloadBtn.disabled = true;
    try {
      const prev = new Set(this.files.map((f) => f.path));
      const keep = this.selected;
      if (!(await this.loadListing(true))) return;
      const added = this.files.filter((f) => !prev.has(f.path));
      for (const f of added) if (f.rel_path) revealFile(this.expanded, f.rel_path);
      if (added.length) this.flushPersist();
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
      this.reloading = false;
      this.reloadBtn.disabled = false;
    }
  }

  private async loadEnv(): Promise<void> {
    this.envVars = {};
    if (this.envEl.value) {
      const res = await fetch(`${this.api}/env?path=${encodeURIComponent(this.envEl.value)}`);
      if (res.ok) this.envVars = (await res.json()) as Record<string, string>;
    }
    this.renderSource();
    this.renderStats();
    if (this.envEl.value) this.schedulePersist();
  }

  private cycleEnv(): void {
    const count = this.envEl.options.length;
    if (count === 0) return;
    this.envEl.selectedIndex = (this.envEl.selectedIndex + 1) % count;
    this.envEl.dispatchEvent(new Event('change'));
  }

  // ---- run ----------------------------------------------------------------------

  private async runSelected(): Promise<void> {
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
    const res = await fetch(`${this.api}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: this.selected,
        verbose: this.pressed(this.verboseBtn),
        veryVerbose: this.pressed(this.veryBtn),
        variablesFile: this.envEl.value || null,
      }),
    });
    if (!res.ok) {
      this.setRunning(false);
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      this.banner.show(err.error || 'run failed', 'error');
      this.renderStats();
      return;
    }
    const payload = (await res.json()) as { runId: string };
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

  private async cancelRun(): Promise<void> {
    if (this.runId === null) return;
    await fetch(`${this.api}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: this.runId }),
    });
  }

  private closeStream(): void {
    this.events?.close();
    this.events = null;
  }

  private setRunning(running: boolean): void {
    this.running = running;
    const label = this.runBtn.querySelector('.lb-btn__label');
    if (label) label.textContent = running ? 'Cancel' : 'Run';
    this.runBtn.dataset.state = running ? 'running' : '';
    this.runBtn.classList.toggle('lb-btn--primary', !running);
    this.runBtn.classList.toggle('lb-btn--secondary', running);
  }

  // ---- toggles and copy -----------------------------------------------------------

  private pressed(node: HTMLButtonElement): boolean {
    return node.getAttribute('aria-pressed') === 'true';
  }

  /** `--verbose` and `--very-verbose` are exclusive: turning one on turns the other off. */
  private toggleVerbose(which: 'v' | 'vv'): void {
    const [own, other] = which === 'v' ? [this.verboseBtn, this.veryBtn] : [this.veryBtn, this.verboseBtn];
    const on = !this.pressed(own);
    setPressed(own, on);
    if (on) setPressed(other, false);
    this.schedulePersist();
  }

  private envLabel(): string | null {
    const opt = this.envEl.options[this.envEl.selectedIndex];
    return opt && opt.value ? (opt.textContent ?? '').replace(/^env: /, '') : null;
  }

  private async copyCurl(): Promise<void> {
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
    if (!(await copyText(result.curl))) {
      this.banner.show('Copy failed', 'error');
      return;
    }
    let msg = `Copied curl · ${this.envLabel() ? `env: ${this.envLabel()}` : '(none)'}`;
    if (result.unresolved.length) msg += ` · ${result.unresolved.length} unresolved: ${result.unresolved.join(', ')}`;
    this.banner.show(msg, 'ok', 2500);
  }

  private async copyHurlCli(): Promise<void> {
    if (!this.selected) {
      this.banner.show('Select a .hurl file', 'error');
      return;
    }
    const envRel = this.envEl.value ? relOf(this.envEl.value, this.envFiles) : '';
    const cmd = hurlCliCommand(relOf(this.selected, this.files), envRel || null, {
      verbose: this.pressed(this.verboseBtn),
      veryVerbose: this.pressed(this.veryBtn),
    });
    if (!(await copyText(cmd))) {
      this.banner.show('Copy failed', 'error');
      return;
    }
    this.banner.show(`Copied hurl · ${this.envLabel() ? `env: ${this.envLabel()}` : '(none)'}`, 'ok', 2500);
  }

  // ---- paint --------------------------------------------------------------------------

  private setView(view: ResponseView): void {
    this.view = view;
    this.viewTabs.update({ tabs: VIEWS, active: view });
    this.renderResponse();
    this.schedulePersist();
  }

  private switchFocus(): void {
    this.focusPane = this.focusPane === 'source' ? 'response' : 'source';
    (this.focusPane === 'source' ? this.sourceEl : this.viewportEl).focus();
  }

  private responseState(): { running: boolean; stdout: string; stderr: string; view: ResponseView } {
    return { running: this.running, stdout: this.stdout, stderr: this.stderr, view: this.view };
  }

  private renderSource(): void {
    const vars = Object.keys(this.envVars).length ? this.envVars : undefined;
    // highlightHurl escapes every source character it emits.
    this.sourceEl.innerHTML = this.sourceText ? highlightHurl(this.sourceText, vars, { substitute: this.resolvedView }) : '';
  }

  private renderResponse(): void {
    setChildren(this.viewportEl, renderResponse(this.responseState()));
  }

  private renderStats(): void {
    setChildren(this.runDot, [
      dot(this.running ? 'live' : this.lastExit === null ? 'idle' : this.lastExit === 0 ? 'add' : 'del'),
    ]);
    const size = this.stdout.length + this.stderr.length;
    const status: Stat = this.running
      ? { key: 'status', label: 'Status', value: 'RUNNING' }
      : this.lastExit === null
        ? { key: 'status', label: 'Status', value: '—', tone: 'muted' }
        : { key: 'status', label: 'Status', value: `EXIT ${this.lastExit}`, tone: this.lastExit === 0 ? 'add' : 'del' };
    this.stats.update([
      status,
      {
        key: 'ms',
        label: 'Duration',
        value: !this.running && this.lastExit !== null && this.lastMs !== null ? `${this.lastMs} ms` : '—',
        tone: 'muted',
      },
      { key: 'bytes', label: 'Body', value: size ? bytesLabel(size) : '—', tone: 'muted' },
      { key: 'env', label: 'Variables', value: this.envLabel() ?? '(none)', tone: 'muted' },
    ]);
  }

  private setRunEnabled(): void {
    this.runBtn.disabled = !this.available || !this.selected;
    this.curlBtn.disabled = !this.selected;
    this.hurlBtn.disabled = !this.selected;
  }

  // ---- persistence -----------------------------------------------------------------------

  private schedulePersist(): void {
    if (!this.stateReady) return;
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persist(), 300);
  }

  private flushPersist(): void {
    window.clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.persist();
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
        verbose: this.pressed(this.verboseBtn),
        very_verbose: this.pressed(this.veryBtn),
        active_env_file: this.envEl.value || null,
        resolved_view: this.resolvedView,
        updated_at: Date.now(),
      }),
    }).catch(() => undefined);
  }
}

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
