// Spec 375 — Commit Browser.
//
// A keyboard-driven list of the focused repo's commits with a preview pane.
// `d` hands a commit's diff to the Diff View; `e` asks an idle lane of a local
// Harness in this repo to write a learning explainer (`lane.learn`), whose
// state the row's lamp shows: pending (amber) → ready (green). Explainers are
// found by `(repoName, sha7)` in the knowledge index (`knowledge_list`).

import { invoke } from '@tauri-apps/api/core';

import { harnessEntry, listHarnessEntries, type HarnessEntry } from './acp/harness-directory';
import type { ContentView, PaneContentType } from './types';
import { el } from './ui/dom';
import { keyCap, keyHint, keyHintNodes, type KeyHint } from './ui/kbd';
import { reconcile, type ListNode } from './ui/list';

export interface CommitSummary {
  sha: string;
  shortSha: string;
  author: string;
  /** Unix seconds. */
  at: number;
  subject: string;
  /** Message body, trailers stripped. */
  body: string;
  isMerge: boolean;
  files: number;
  added: number;
  removed: number;
}

export interface GitLogPage {
  repoRoot: string;
  repoName: string;
  branch: string | null;
  commits: CommitSummary[];
  hasMore: boolean;
}

export interface KnowledgeDoc {
  repo: string;
  /** Always 7 chars. */
  shortSha: string;
  path: string;
}

export interface KnowledgeIndex {
  dir: string;
  docs: KnowledgeDoc[];
}

type RowLamp = 'none' | 'pending' | 'ready';
/** What a row's one lamp shows: pending > ready > candidate > none. */
type LampState = RowLamp | 'candidate';

interface PendingLearn {
  harnessId: string;
  lane: string;
  path: string;
}

interface LaneChoice {
  harnessId: string;
  lane: string;
  backendId: string;
  cwd: string | null;
}

interface PickerState {
  sha: string;
  choices: LaneChoice[];
  index: number;
}

interface RowNode extends ListNode {
  readonly sha: string;
  readonly lamp: HTMLElement;
  readonly age: HTMLElement;
}

interface ParsedSubject {
  type: string | null;
  scope: string | null;
  breaking: boolean;
  description: string;
}

const PAGE_SIZE = 200;
/** `git_log_page` clamps `limit` to this. */
const MAX_PAGE = 500;
const CANDIDATE_MAX_LINES = 200;

export const NOTIFY_OPEN_HARNESS = 'Open an ACP Harness in this repo (Leader Y), then press e';
export const NOTIFY_NO_IDLE_LANE = "No idle lane in this repo's Harness — wait for one or #cancel";
export const NOTIFY_ALREADY_EXPLAINED = 'already explained — o open · E regenerate';
export const NOTIFY_EXPLAINER_READY = 'Explainer ready — o to open';

const CONVENTIONAL_SUBJECT = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/;

function parseSubject(subject: string): ParsedSubject {
  const match = CONVENTIONAL_SUBJECT.exec(subject);
  if (!match) return { type: null, scope: null, breaking: false, description: subject };
  return {
    type: match[1].toLowerCase(),
    scope: match[2] ?? null,
    breaking: match[3] === '!',
    description: match[4],
  };
}

/** A hint lamp, not a judgement: a small fix/perf commit that explains itself. */
export function isCandidate(c: CommitSummary): boolean {
  if (c.isMerge) return false;
  if (c.added + c.removed > CANDIDATE_MAX_LINES) return false;
  const { type } = parseSubject(c.subject);
  if (type !== 'fix' && type !== 'perf') return false;
  return c.body.split('\n').filter((line) => line.trim() !== '').length >= 2;
}

function sha7(sha: string): string {
  return sha.slice(0, 7);
}

function formatAge(at: number, now: number): string {
  const seconds = Math.max(0, now - at);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 365 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return `${Math.floor(seconds / (365 * 86_400))}y`;
}

function formatStamp(at: number): string {
  const d = new Date(at * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FOOT_HINTS: readonly KeyHint[] = [
  { keys: ['j', 'k'], keySeparator: '/', label: 'select' },
  { keys: ['/'], label: 'filter' },
  { keys: ['c'], label: 'candidates' },
  { keys: ['d'], label: 'diff' },
  { keys: ['e'], label: 'explain' },
  { keys: ['o'], label: 'open' },
  { keys: ['?'], label: 'help' },
  { keys: ['q'], label: 'close' },
];

const HELP_SECTIONS: readonly { title: string; rows: readonly [readonly string[], string][] }[] = [
  {
    title: 'Move',
    rows: [
      [['j', 'k'], 'down / up'],
      [['g', 'G'], 'top / bottom (G at the end loads 200 more)'],
    ],
  },
  {
    title: 'Filter',
    rows: [
      [['/'], 'filter by subject, author or sha (Esc clears)'],
      [['c'], 'candidates only'],
    ],
  },
  {
    title: 'Commit',
    rows: [
      [['d', 'Enter'], 'open the diff'],
      [['y'], 'copy the full sha'],
    ],
  },
  {
    title: 'Explain',
    rows: [
      [['e'], 'explain on an idle lane'],
      [['E'], 'regenerate the explainer'],
      [['o'], 'open the explainer'],
      [['L'], 'open the knowledge library'],
    ],
  },
  {
    title: 'General',
    rows: [
      [['r'], 'reload'],
      [['?'], 'this help'],
      [['q', 'Esc'], 'close'],
    ],
  },
];

export class CommitBrowserView implements ContentView {
  readonly type: PaneContentType = 'commit_browser';
  readonly element: HTMLElement;
  /** The foot legend is a plate strip; the window footer continues it. */
  readonly platedFoot = true;

  private readonly root: string;
  private readonly repoName: string;
  private branch: string | null;
  private commits: CommitSummary[];
  private hasMore: boolean;
  private readonly candidates = new Map<string, boolean>();
  private readonly rows = new Map<string, RowNode>();
  private readonly pending = new Map<string, PendingLearn>();
  private knowledge: KnowledgeIndex | null = null;
  private docs = new Map<string, string>();
  private selectedSha: string | null = null;
  private candidatesOnly = false;
  private picker: PickerState | null = null;
  private helpOpen = false;
  private loading = false;
  private disposed = false;

  private readonly branchEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly filterEl: HTMLInputElement;
  private readonly modeEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private readonly pickerEl: HTMLElement;
  private readonly helpEl: HTMLElement;
  private readonly events = new AbortController();

  private closeCallback: (() => void) | null = null;
  private openDiffCallback: ((diff: string, title: string) => void | Promise<void>) | null = null;
  private openKnowledgeCallback: ((dir: string, file: string | null) => void | Promise<void>) | null = null;
  private notifyCallback: ((message: string) => void) | null = null;
  private readonly disposeListeners: (() => void)[] = [];

  constructor(page: GitLogPage, container: HTMLElement) {
    this.root = page.repoRoot;
    this.repoName = page.repoName;
    this.branch = page.branch;
    this.commits = page.commits;
    this.hasMore = page.hasMore;
    this.selectedSha = page.commits[0]?.sha ?? null;

    this.element = el('div', { class: 'commit-browser', attrs: { tabindex: 0 } });
    container.appendChild(this.element);

    this.branchEl = el('span', { class: 'commit-browser__branch' });
    this.countEl = el('span', { class: 'commit-browser__count' });
    this.filterEl = el('input', {
      class: 'commit-browser__filter-input',
      attrs: { type: 'text', spellcheck: 'false', placeholder: 'subject, author or sha', 'aria-label': 'Filter commits' },
    });
    this.modeEl = el('span', { class: 'commit-browser__mode', text: 'candidates only' });
    this.modeEl.hidden = true;
    const head = el(
      'header',
      { class: 'commit-browser__head' },
      el('span', { class: 'commit-browser__repo', text: this.repoName }),
      this.branchEl,
      this.countEl,
      el('label', { class: 'commit-browser__filter' }, keyCap('/'), this.filterEl),
      this.modeEl,
    );

    this.listEl = el('div', { class: 'commit-browser__list', attrs: { role: 'listbox', 'aria-label': 'Commits' } });
    this.emptyEl = el('p', { class: 'commit-browser__empty', text: 'No commits match.' });
    this.emptyEl.hidden = true;
    this.previewEl = el('section', { class: 'commit-browser__preview', attrs: { 'aria-live': 'polite' } });
    const body = el(
      'div',
      { class: 'commit-browser__body' },
      el('div', { class: 'commit-browser__column' }, this.listEl, this.emptyEl),
      this.previewEl,
    );

    const foot = el('footer', { class: 'commit-browser__foot' }, ...keyHintNodes(FOOT_HINTS));

    this.pickerEl = el('div', { class: 'commit-browser__picker', attrs: { role: 'dialog' } });
    this.pickerEl.hidden = true;
    this.helpEl = el('div', { class: 'commit-browser__help', attrs: { role: 'dialog' } });
    this.helpEl.hidden = true;

    this.element.append(head, body, foot, this.pickerEl, this.helpEl);

    const signal = this.events.signal;
    this.filterEl.addEventListener('input', () => this.applyVisibility(), { signal });
    this.listEl.addEventListener('click', (event) => {
      const row = (event.target as Element | null)?.closest<HTMLElement>('.commit-browser__row');
      const sha = row?.dataset.sha;
      if (sha) this.select(sha);
    }, { signal });

    this.renderHead();
    this.renderRows();
    this.applyVisibility();
    void this.loadKnowledge();
  }

  // ─── Wiring ───

  onClose(callback: () => void): void { this.closeCallback = callback; }
  onOpenDiff(callback: (diff: string, title: string) => void | Promise<void>): void { this.openDiffCallback = callback; }
  onOpenKnowledge(callback: (dir: string, file: string | null) => void | Promise<void>): void {
    this.openKnowledgeCallback = callback;
  }
  setNotifier(callback: (message: string) => void): void { this.notifyCallback = callback; }
  /** Cleanup hook run from dispose() — e.g. the compositor's bus unsubscribe. */
  addDisposeListener(callback: () => void): void { this.disposeListeners.push(callback); }

  repoRoot(): string { return this.root; }
  getWorkingDirectory(): string | null { return this.root; }
  focusView(): void { this.element.focus(); }

  /** A Harness lane in this repo went idle: re-read the index and settle pending lamps. */
  async onHarnessLaneIdle(): Promise<void> {
    const index = await this.fetchKnowledge();
    if (this.disposed || !index) return;
    this.setKnowledge(index);
    this.settlePending(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.events.abort();
    for (const listener of this.disposeListeners.splice(0)) listener();
    this.rows.clear();
    this.pending.clear();
    this.closeCallback = null;
    this.openDiffCallback = null;
    this.openKnowledgeCallback = null;
    this.notifyCallback = null;
    this.element.remove();
  }

  // ─── Keys ───

  onKeyDown(event: KeyboardEvent): boolean {
    if (this.helpOpen) {
      if (event.key === '?' || event.key === 'q' || event.key === 'Escape') this.closeHelp();
      return true;
    }
    if (this.picker) return this.onPickerKey(event);
    if (event.target === this.filterEl || document.activeElement === this.filterEl) return this.onFilterKey(event);
    if (event.metaKey || event.ctrlKey || event.altKey) return false;

    switch (event.key) {
      case 'q':
        this.closeCallback?.();
        return true;
      case 'Escape':
        if (this.filterEl.value) {
          this.filterEl.value = '';
          this.applyVisibility();
        } else {
          this.closeCallback?.();
        }
        return true;
      case 'j':
      case 'ArrowDown':
        this.move(1);
        return true;
      case 'k':
      case 'ArrowUp':
        this.move(-1);
        return true;
      case 'g':
        this.selectEdge('first');
        return true;
      case 'G':
        this.onBottom();
        return true;
      case '/':
        this.filterEl.focus();
        return true;
      case 'c':
        this.candidatesOnly = !this.candidatesOnly;
        this.modeEl.hidden = !this.candidatesOnly;
        this.applyVisibility();
        return true;
      case 'd':
      case 'Enter':
        void this.openDiff();
        return true;
      case 'e':
        this.explain(false);
        return true;
      case 'E':
        this.explain(true);
        return true;
      case 'o':
        this.openExplainer();
        return true;
      case 'L':
        this.openLibrary();
        return true;
      case 'y':
        this.copySha();
        return true;
      case 'r':
        void this.reload();
        return true;
      case '?':
        this.openHelp();
        return true;
      default:
        return false;
    }
  }

  /** In the filter field: Esc clears and returns to the list, Enter keeps the filter. */
  private onFilterKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.filterEl.value = '';
      this.applyVisibility();
      this.filterEl.blur();
      this.element.focus();
      return true;
    }
    if (event.key === 'Enter') {
      this.filterEl.blur();
      this.element.focus();
      return true;
    }
    return false;
  }

  // ─── Rows ───

  private renderRows(): void {
    const now = Math.floor(Date.now() / 1000);
    reconcile<CommitSummary, RowNode>(this.listEl, this.commits, {
      key: (c) => c.sha,
      create: (c) => this.createRow(c, now),
      update: (row, c) => { row.age.textContent = formatAge(c.at, now); },
    });
  }

  private createRow(c: CommitSummary, now: number): RowNode {
    const parsed = parseSubject(c.subject);
    const chip = c.isMerge ? 'merge' : parsed.type ? parsed.type + (parsed.breaking ? '!' : '') : '';
    const lamp = el('span', { class: 'commit-browser__lamp' });
    const age = el('span', { class: 'commit-browser__age', text: formatAge(c.at, now) });
    const subject = el(
      'span',
      { class: 'commit-browser__subject' },
      parsed.scope ? el('span', { class: 'commit-browser__scope', text: parsed.scope }) : null,
      parsed.scope ? ' ' : null,
      parsed.type ? parsed.description : c.subject,
    );
    const row = el(
      'div',
      { class: 'commit-browser__row', data: { sha: c.sha }, attrs: { role: 'option', 'aria-selected': 'false' } },
      lamp,
      el('span', { class: 'commit-browser__sha', text: sha7(c.sha) }),
      age,
      el('span', { class: ['commit-browser__type', !chip && 'commit-browser__type--empty'], text: chip }),
      subject,
      el(
        'span',
        { class: 'commit-browser__stat' },
        el('span', { class: 'commit-browser__added', text: `+${c.added}` }),
        ' ',
        el('span', { class: 'commit-browser__removed', text: `−${c.removed}` }),
      ),
    );
    this.candidates.set(c.sha, isCandidate(c));
    const node: RowNode = {
      sha: c.sha,
      el: row,
      lamp,
      age,
      dispose: () => {
        if (this.rows.get(c.sha) === node) this.rows.delete(c.sha);
        this.candidates.delete(c.sha);
      },
    };
    this.rows.set(c.sha, node);
    this.paintLamp(node);
    return node;
  }

  private rowLamp(sha: string): RowLamp {
    if (this.pending.has(sha)) return 'pending';
    if (this.docPath(sha)) return 'ready';
    return 'none';
  }

  private lampState(sha: string): LampState {
    const lamp = this.rowLamp(sha);
    if (lamp !== 'none') return lamp;
    return this.candidates.get(sha) ? 'candidate' : 'none';
  }

  private paintLamp(node: RowNode): void {
    const state = this.lampState(node.sha);
    node.el.dataset.lamp = state;
    node.lamp.className = `commit-browser__lamp commit-browser__lamp--${state}`;
  }

  private paintLamps(): void {
    for (const node of this.rows.values()) this.paintLamp(node);
    this.renderPreview();
  }

  private matches(c: CommitSummary, query: string): boolean {
    if (this.candidatesOnly && !this.candidates.get(c.sha)) return false;
    if (!query) return true;
    return c.subject.toLowerCase().includes(query)
      || c.author.toLowerCase().includes(query)
      || c.sha.startsWith(query);
  }

  private visibleCommits(): CommitSummary[] {
    return this.commits.filter((c) => !this.rows.get(c.sha)?.el.hidden);
  }

  /** Filter and candidates toggle `hidden` on the existing rows; nothing is rebuilt. */
  private applyVisibility(): void {
    const query = this.filterEl.value.trim().toLowerCase();
    let visible = 0;
    let firstVisible: string | null = null;
    let selectedVisible = false;
    for (const c of this.commits) {
      const node = this.rows.get(c.sha);
      if (!node) continue;
      const shown = this.matches(c, query);
      node.el.hidden = !shown;
      if (!shown) continue;
      visible++;
      firstVisible ??= c.sha;
      if (c.sha === this.selectedSha) selectedVisible = true;
    }
    this.countEl.textContent = `${visible}/${this.commits.length}`;
    this.listEl.hidden = visible === 0;
    this.emptyEl.hidden = visible !== 0;
    this.emptyEl.textContent = this.commits.length === 0 ? 'No commits.' : 'No commits match.';
    if (!selectedVisible) this.selectedSha = firstVisible;
    this.paintSelection();
  }

  private renderHead(): void {
    this.branchEl.textContent = this.branch ?? 'detached';
  }

  // ─── Selection ───

  private selected(): CommitSummary | null {
    return this.commits.find((c) => c.sha === this.selectedSha) ?? null;
  }

  private select(sha: string): void {
    this.selectedSha = sha;
    this.paintSelection();
  }

  private paintSelection(): void {
    for (const node of this.rows.values()) {
      node.el.setAttribute('aria-selected', String(node.sha === this.selectedSha));
    }
    const row = this.selectedSha ? this.rows.get(this.selectedSha) : undefined;
    if (row && typeof row.el.scrollIntoView === 'function') row.el.scrollIntoView({ block: 'nearest' });
    this.renderPreview();
  }

  private move(delta: number): void {
    const visible = this.visibleCommits();
    if (!visible.length) return;
    const at = visible.findIndex((c) => c.sha === this.selectedSha);
    const next = Math.min(visible.length - 1, Math.max(0, at + delta));
    this.select(visible[next].sha);
  }

  private selectEdge(edge: 'first' | 'last'): void {
    const visible = this.visibleCommits();
    if (!visible.length) return;
    this.select(edge === 'first' ? visible[0].sha : visible[visible.length - 1].sha);
  }

  /** `G`: jump to the last row; already there with more history → load the next page. */
  private onBottom(): void {
    const visible = this.visibleCommits();
    const last = visible[visible.length - 1];
    if (last && last.sha !== this.selectedSha) {
      this.select(last.sha);
      return;
    }
    if (this.hasMore) void this.loadMore();
  }

  private async loadMore(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const page = await invoke<GitLogPage>('git_log_page', {
        cwd: this.root,
        skip: this.commits.length,
        limit: PAGE_SIZE,
      });
      if (this.disposed) return;
      const known = new Set(this.commits.map((c) => c.sha));
      const added = page.commits.filter((c) => !known.has(c.sha));
      this.commits = [...this.commits, ...added];
      this.hasMore = page.hasMore;
      this.branch = page.branch;
      this.renderHead();
      this.renderRows();
      this.applyVisibility();
      const firstNew = added.find((c) => !this.rows.get(c.sha)?.el.hidden);
      if (firstNew) this.select(firstNew.sha);
    } catch (error) {
      if (!this.disposed) this.notify(errorMessage(error));
    } finally {
      this.loading = false;
    }
  }

  /** `r`: page 0 again with the same loaded count, plus the knowledge index. */
  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    const knowledge = this.fetchKnowledge();
    try {
      const target = Math.max(this.commits.length, 1);
      const commits: CommitSummary[] = [];
      const seen = new Set<string>();
      let hasMore = true;
      let branch = this.branch;
      while (commits.length < target && hasMore) {
        const page = await invoke<GitLogPage>('git_log_page', {
          cwd: this.root,
          skip: commits.length,
          limit: Math.min(MAX_PAGE, target - commits.length),
        });
        if (this.disposed) return;
        for (const c of page.commits) {
          if (seen.has(c.sha)) continue;
          seen.add(c.sha);
          commits.push(c);
        }
        hasMore = page.hasMore;
        branch = page.branch;
        if (page.commits.length === 0) break;
      }
      this.commits = commits;
      this.hasMore = hasMore;
      this.branch = branch;
      this.renderHead();
      this.renderRows();
      this.applyVisibility();
    } catch (error) {
      if (!this.disposed) this.notify(errorMessage(error));
    } finally {
      this.loading = false;
    }
    const index = await knowledge;
    if (this.disposed || !index) return;
    this.setKnowledge(index);
    this.settlePending(true);
  }

  // ─── Knowledge ───

  private async fetchKnowledge(): Promise<KnowledgeIndex | null> {
    try {
      return await invoke<KnowledgeIndex>('knowledge_list');
    } catch (error) {
      if (!this.disposed) this.notify(`Knowledge index: ${errorMessage(error)}`);
      return null;
    }
  }

  private async loadKnowledge(): Promise<void> {
    const index = await this.fetchKnowledge();
    if (this.disposed || !index) return;
    this.setKnowledge(index);
    this.paintLamps();
  }

  private setKnowledge(index: KnowledgeIndex): void {
    this.knowledge = index;
    this.docs = new Map(index.docs.map((doc) => [`${doc.repo}\u0000${doc.shortSha}`, doc.path]));
  }

  private docPath(sha: string): string | null {
    return this.docs.get(`${this.repoName}\u0000${sha7(sha)}`) ?? null;
  }

  /** Settle each pending explainer whose lane is done with it. A lane still
   *  working keeps its lamp amber even when the file already exists (a
   *  regenerate overwrites an existing doc). A closed Harness is settled only
   *  by `r` (`manual`), from whatever the index holds then. */
  private settlePending(manual: boolean): void {
    for (const [sha, learn] of [...this.pending]) {
      const lane = harnessEntry(learn.harnessId)?.listLanes().find((l) => l.displayName === learn.lane);
      if (lane ? lane.status !== 'idle' : !manual) continue;
      this.pending.delete(sha);
      if (this.docPath(sha)) {
        this.notify(NOTIFY_EXPLAINER_READY);
      } else if (lane) {
        const file = learn.path.split('/').pop() || `${this.repoName}-${sha7(sha)}.md`;
        this.notify(`${learn.lane} finished without writing ${file}`);
      }
    }
    this.paintLamps();
  }

  private openExplainer(): void {
    const c = this.selected();
    if (!c) return;
    const path = this.docPath(c.sha);
    if (!path || !this.knowledge || this.pending.has(c.sha)) {
      this.notify(`No explainer for ${sha7(c.sha)} yet — e explain`);
      return;
    }
    void this.openKnowledgeCallback?.(this.knowledge.dir, path);
  }

  private openLibrary(): void {
    if (!this.knowledge) {
      this.notify('Knowledge index unavailable — r reload');
      return;
    }
    void this.openKnowledgeCallback?.(this.knowledge.dir, null);
  }

  // ─── Commit actions ───

  private async openDiff(): Promise<void> {
    const c = this.selected();
    if (!c) return;
    try {
      const diff = await invoke<string>('git_commit_diff', { cwd: this.root, sha: c.sha });
      if (this.disposed) return;
      await this.openDiffCallback?.(diff, `COMMIT // ${sha7(c.sha)}`);
    } catch (error) {
      if (!this.disposed) this.notify(errorMessage(error));
    }
  }

  private copySha(): void {
    const c = this.selected();
    if (!c) return;
    navigator.clipboard
      .writeText(c.sha)
      .then(() => this.notify(`Copied ${sha7(c.sha)}`))
      .catch(() => this.notify('Copy failed'));
  }

  // ─── Explain ───

  /** Live local Harnesses whose project dir is this repo or inside it. */
  private repoHarnesses(): HarnessEntry[] {
    const root = this.root.replace(/\/+$/, '');
    return listHarnessEntries().filter((entry) => {
      if (entry.workspaceKey && !entry.workspaceKey.startsWith('local:')) return false;
      if (!entry.control || !entry.cwd) return false;
      const cwd = entry.cwd.replace(/\/+$/, '');
      return cwd === root || cwd.startsWith(root + '/');
    });
  }

  private explain(regenerate: boolean): void {
    const c = this.selected();
    if (!c) return;
    const learning = this.pending.get(c.sha);
    if (learning) {
      this.notify(`${sha7(c.sha)} is already learning on ${learning.lane}`);
      return;
    }
    if (!regenerate && this.docPath(c.sha)) {
      this.notify(NOTIFY_ALREADY_EXPLAINED);
      return;
    }
    const harnesses = this.repoHarnesses();
    if (!harnesses.length) {
      this.notify(NOTIFY_OPEN_HARNESS);
      return;
    }
    const choices: LaneChoice[] = harnesses.flatMap((entry) =>
      entry.listLanes()
        .filter((lane) => lane.status === 'idle')
        .map((lane) => ({ harnessId: entry.harnessId, lane: lane.displayName, backendId: lane.backendId, cwd: entry.cwd })));
    if (!choices.length) {
      this.notify(NOTIFY_NO_IDLE_LANE);
      return;
    }
    if (choices.length === 1) {
      void this.sendLearn(c.sha, choices[0]);
      return;
    }
    this.openPicker(c.sha, choices);
  }

  private async sendLearn(sha: string, choice: LaneChoice): Promise<void> {
    const entry = harnessEntry(choice.harnessId);
    if (!entry?.control) {
      this.notify(NOTIFY_OPEN_HARNESS);
      return;
    }
    try {
      const result = await entry.control('lane.learn', { lane: choice.lane, sha }, { source: 'commit_browser' });
      if (this.disposed) return;
      const started = (result ?? {}) as { lane?: unknown; path?: unknown };
      this.pending.set(sha, {
        harnessId: choice.harnessId,
        lane: typeof started.lane === 'string' ? started.lane : choice.lane,
        path: typeof started.path === 'string' ? started.path : '',
      });
      this.paintLamps();
    } catch (error) {
      if (!this.disposed) this.notify(errorMessage(error));
    }
  }

  // ─── Lane picker ───

  private openPicker(sha: string, choices: LaneChoice[]): void {
    this.picker = { sha, choices, index: 0 };
    this.pickerEl.hidden = false;
    this.renderPicker();
  }

  private closePicker(): void {
    this.picker = null;
    this.pickerEl.hidden = true;
    this.pickerEl.replaceChildren();
  }

  /** Keys while the picker is open: swallowed so the list underneath never moves. */
  private onPickerKey(event: KeyboardEvent): boolean {
    const picker = this.picker;
    if (!picker) return false;
    if (event.key === 'Escape' || event.key === 'q') {
      this.closePicker();
    } else if (event.key === 'j' || event.key === 'ArrowDown') {
      picker.index = Math.min(picker.choices.length - 1, picker.index + 1);
      this.renderPicker();
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      picker.index = Math.max(0, picker.index - 1);
      this.renderPicker();
    } else if (event.key === 'Enter') {
      const choice = picker.choices[picker.index];
      this.closePicker();
      void this.sendLearn(picker.sha, choice);
    }
    return true;
  }

  private renderPicker(): void {
    const picker = this.picker;
    if (!picker) return;
    const manyHarnesses = new Set(picker.choices.map((choice) => choice.harnessId)).size > 1;
    const rows = picker.choices.map((choice, index) => el(
      'div',
      {
        class: ['commit-browser__picker-row', index === picker.index && 'commit-browser__picker-row--selected'],
        attrs: { role: 'option', 'aria-selected': String(index === picker.index) },
      },
      el('span', { class: 'commit-browser__picker-lane', text: choice.lane }),
      el('span', {
        class: 'commit-browser__picker-meta',
        text: manyHarnesses && choice.cwd ? `${choice.backendId} · ${choice.cwd}` : choice.backendId,
      }),
    ));
    this.pickerEl.replaceChildren(
      el('div', { class: 'commit-browser__overlay-head', text: `Explain ${sha7(picker.sha)} on` }),
      el('div', { class: 'commit-browser__picker-list', attrs: { role: 'listbox' } }, ...rows),
      el(
        'div',
        { class: 'commit-browser__overlay-foot' },
        ...keyHintNodes([
          { keys: ['j', 'k'], keySeparator: '/', label: 'select' },
          { keys: ['Enter'], label: 'send' },
          { keys: ['Esc'], label: 'cancel' },
        ]),
      ),
    );
  }

  // ─── Help ───

  private openHelp(): void {
    this.helpOpen = true;
    this.helpEl.hidden = false;
    const body = el('div', { class: 'commit-browser__help-body' });
    for (const section of HELP_SECTIONS) {
      body.append(el('div', { class: 'commit-browser__help-section', text: section.title }));
      for (const [keys, desc] of section.rows) {
        body.append(el(
          'div',
          { class: 'commit-browser__help-row' },
          el('span', { class: 'commit-browser__help-keys' }, keyHint({ keys, label: '', keySeparator: '/' })),
          el('span', { class: 'commit-browser__help-desc', text: desc }),
        ));
      }
    }
    this.helpEl.replaceChildren(
      el('div', { class: 'commit-browser__overlay-head', text: 'Keybindings' }),
      body,
      el('div', { class: 'commit-browser__overlay-foot' }, keyCap('?'), ' or ', keyCap('Esc'), ' to close'),
    );
  }

  private closeHelp(): void {
    this.helpOpen = false;
    this.helpEl.hidden = true;
  }

  // ─── Preview ───

  private renderPreview(): void {
    const c = this.selected();
    if (!c) {
      this.previewEl.replaceChildren(el('p', { class: 'commit-browser__preview-empty', text: 'No commit selected.' }));
      return;
    }
    const lamp = this.rowLamp(c.sha);
    const learning = this.pending.get(c.sha);
    const status = lamp === 'pending'
      ? `learning · ${learning?.lane ?? ''}`
      : lamp === 'ready' ? 'explained' : 'not explained';
    const path = learning?.path || this.docPath(c.sha);
    const actions: KeyHint[] = lamp === 'ready'
      ? [{ keys: ['o'], label: 'open' }, { keys: ['E'], label: 'regenerate' }, { keys: ['d'], label: 'diff' }]
      : lamp === 'pending'
        ? [{ keys: ['d'], label: 'diff' }, { keys: ['y'], label: 'copy sha' }]
        : [{ keys: ['e'], label: 'explain' }, { keys: ['d'], label: 'diff' }, { keys: ['y'], label: 'copy sha' }];
    const files = `${c.files} file${c.files === 1 ? '' : 's'}`;

    this.previewEl.replaceChildren(
      el(
        'div',
        { class: 'commit-browser__preview-top' },
        el('span', { class: 'commit-browser__preview-sha', text: c.sha }),
        el('span', { class: `commit-browser__status commit-browser__status--${lamp}`, text: status }),
        this.candidates.get(c.sha) ? el('span', { class: 'commit-browser__tag', text: 'candidate' }) : null,
      ),
      el('h2', { class: 'commit-browser__preview-subject', text: c.subject }),
      el('p', {
        class: 'commit-browser__preview-meta',
        text: `${c.author} · ${formatStamp(c.at)} · ${files} · +${c.added} −${c.removed}`,
      }),
      ...(c.body.trim() ? [el('div', { class: 'commit-browser__preview-body', text: c.body.trim() })] : []),
      el(
        'div',
        { class: 'commit-browser__preview-foot' },
        path && lamp !== 'none' ? el('p', { class: 'commit-browser__preview-path', text: path }) : null,
        el('p', { class: 'commit-browser__preview-keys' }, ...keyHintNodes(actions)),
      ),
    );
  }

  private notify(message: string): void {
    this.notifyCallback?.(message);
  }
}
