// Spec 375 — Commit Browser.
//
// A keyboard-driven list of the focused repo's commits with a preview pane.
// `d` hands a commit's diff to the Diff View; `e` queues a background
// explainer job on the app's `CommitExplainer` (spec 376), whose state the
// row's lamp shows: pending (amber) → ready (green). A pending commit's
// preview carries the explainer strip (spec 377). Explainers are found by
// `(repoName, sha7)` in the knowledge index (`knowledge_list`).

import { invoke } from '@tauri-apps/api/core';

import {
  EXPLAIN_MAX_CONTINUATIONS,
  EXPLAIN_STEPS_KEPT,
  type ExplainChange,
  type ExplainJob,
  type ExplainState,
  type ExplainStepState,
} from './commit-explainer';
import type { ContentView, PaneContentType } from './types';
import { el, setChildren, type ClassSpec } from './ui/dom';
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

/** The slice of `CommitExplainer` the view drives; jobs outlive the view. */
export interface ExplainerPort {
  start(root: string, repoName: string, sha: string): ExplainJob;
  cancel(root: string, sha: string): boolean;
  job(root: string, sha: string): ExplainJob | null;
  queuedAhead(job: ExplainJob): number;
  subscribe(listener: (change: ExplainChange) => void): () => void;
}

export const NOTIFY_ALREADY_EXPLAINED = 'already explained — o open · E regenerate';

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

/** A step's LED: lit amber while it runs, unlit once done, a fault lens when it failed. */
const STEP_LAMP: Readonly<Record<ExplainStepState, string | null>> = {
  running: 'commit-browser__lamp--pending',
  done: null,
  failed: 'commit-browser__lamp--fault',
};
const NOW_PHASE = 'commit-browser__step--now commit-browser__step--phase';

/** One strip line: its LED, the flat-ink kind (a phase line has none), and
 *  the subject, whole in the tooltip. */
function stripRow(lamp: string | null, kind: string | null, subject: string, mods: ClassSpec): HTMLElement {
  return el(
    'div',
    { class: ['commit-browser__step', mods] },
    el('span', { class: ['commit-browser__lamp', lamp] }),
    kind === null ? null : el('span', { class: 'commit-browser__step-kind', text: kind }),
    el('span', { class: 'commit-browser__step-subject', text: subject, title: subject }),
  );
}

function phaseText(job: ExplainJob): string {
  switch (job.phase) {
    case 'starting':
      return `starting ${job.backend ?? 'the agent'}`;
    case 'replying':
      return 'writing the reply';
    case 'continuing':
      return `approval declined · continuing (${job.continuations} of ${EXPLAIN_MAX_CONTINUATIONS})`;
    default:
      return 'thinking';
  }
}

/** A running job's meta: a start time, not a timer, so nothing repaints on its own. */
function jobMeta(job: ExplainJob): string {
  const since = job.startedAt === null ? null : `since ${formatStamp(job.startedAt / 1000).slice(11)}`;
  const steps = `${job.stepCount} step${job.stepCount === 1 ? '' : 's'}`;
  return [job.backend, job.model, since, steps].filter(Boolean).join(' · ');
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
      [['e'], 'explain in the background'],
      [['E'], 'regenerate the explainer'],
      [['x'], 'cancel a queued or running explainer'],
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
  private readonly explainer: ExplainerPort;
  private knowledge: KnowledgeIndex | null = null;
  private docs = new Map<string, string>();
  private selectedSha: string | null = null;
  private candidatesOnly = false;
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
  /** The shown preview's explainer strip, while its commit has a job. */
  private stripEl: HTMLElement | null = null;
  /** What the shown preview was painted for: its commit and that commit's job state. */
  private shown: { sha: string; job: ExplainState | null } | null = null;
  private readonly helpEl: HTMLElement;
  private readonly events = new AbortController();

  private closeCallback: (() => void) | null = null;
  private openDiffCallback: ((diff: string, title: string) => void | Promise<void>) | null = null;
  private openKnowledgeCallback: ((dir: string, file: string | null) => void | Promise<void>) | null = null;
  private notifyCallback: ((message: string) => void) | null = null;
  private readonly disposeListeners: (() => void)[] = [];

  constructor(page: GitLogPage, container: HTMLElement, explainer: ExplainerPort) {
    this.explainer = explainer;
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

    this.helpEl = el('div', { class: 'commit-browser__help', attrs: { role: 'dialog' } });
    this.helpEl.hidden = true;

    this.element.append(head, body, foot, this.helpEl);

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
    this.disposeListeners.push(explainer.subscribe((change) => this.onExplainChange(change)));
    void this.loadKnowledge();
  }

  // ─── Wiring ───

  onClose(callback: () => void): void { this.closeCallback = callback; }
  onOpenDiff(callback: (diff: string, title: string) => void | Promise<void>): void { this.openDiffCallback = callback; }
  onOpenKnowledge(callback: (dir: string, file: string | null) => void | Promise<void>): void {
    this.openKnowledgeCallback = callback;
  }
  setNotifier(callback: (message: string) => void): void { this.notifyCallback = callback; }

  repoRoot(): string { return this.root; }
  getWorkingDirectory(): string | null { return this.root; }
  focusView(): void { this.element.focus(); }

  /** A job changed. Only this repo's jobs matter; `ready` re-reads the index
   *  so the lamp turns green from the stored doc, not from the event. */
  private onExplainChange(change: ExplainChange): void {
    if (this.disposed || change.job.root !== this.root) return;
    if (change.kind !== 'ready') {
      const node = this.rows.get(change.job.sha);
      if (node) this.paintLamp(node);
      // Any change can move the selected job's queue position.
      this.refreshPreviewJob();
      return;
    }
    void this.loadKnowledge().then(() => {
      if (!this.disposed) this.paintLamps();
    });
  }

  /** Repaint only the strip while the shown commit's job keeps its state; a
   *  job that appears, changes state or ends re-renders the whole preview. */
  private refreshPreviewJob(): void {
    const c = this.selected();
    const job = c ? this.explainer.job(this.root, c.sha) : null;
    if (c && this.shown?.sha === c.sha && this.shown.job === (job?.state ?? null)) {
      if (job && this.stripEl) this.paintStrip(this.stripEl, job);
      return;
    }
    this.renderPreview();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.events.abort();
    for (const listener of this.disposeListeners.splice(0)) listener();
    this.rows.clear();
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
      case 'x':
        this.cancelExplain();
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
    if (this.explainer.job(this.root, sha)) return 'pending';
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
    this.paintLamps();
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

  private openExplainer(): void {
    const c = this.selected();
    if (!c) return;
    const path = this.docPath(c.sha);
    if (!path || !this.knowledge || this.explainer.job(this.root, c.sha)) {
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

  private explain(regenerate: boolean): void {
    const c = this.selected();
    if (!c) return;
    if (this.explainer.job(this.root, c.sha)) {
      this.notify(`${sha7(c.sha)} is already explaining — x cancel`);
      return;
    }
    if (!regenerate && this.docPath(c.sha)) {
      this.notify(NOTIFY_ALREADY_EXPLAINED);
      return;
    }
    // The lamp turns pending from the job's own `update` event.
    this.explainer.start(this.root, this.repoName, c.sha);
  }

  private cancelExplain(): void {
    const c = this.selected();
    if (!c) return;
    this.notify(this.explainer.cancel(this.root, c.sha)
      ? `Cancelled explainer for ${sha7(c.sha)}`
      : `No explainer running for ${sha7(c.sha)}`);
  }

  /** The explainer strip (spec 377): label and meta, the now line, then the
   *  earlier steps, newest first. */
  private paintStrip(strip: HTMLElement, job: ExplainJob): void {
    const head = el(
      'div',
      { class: 'commit-browser__job-head' },
      el('span', { class: 'commit-browser__job-label', text: 'explainer' }),
      job.state === 'running' ? el('span', { class: 'commit-browser__job-meta', text: jobMeta(job) }) : null,
    );
    if (job.state === 'queued') {
      const ahead = this.explainer.queuedAhead(job);
      const queue = `waiting for a free slot · ${ahead > 0 ? `${ahead} ahead` : 'next in line'}`;
      setChildren(strip, [head, stripRow(null, null, queue, NOW_PHASE)]);
      return;
    }
    const newest = [...job.steps].reverse();
    const now = newest.find((step) => step.state === 'running') ?? null;
    const trail = newest.filter((step) => step !== now).slice(0, EXPLAIN_STEPS_KEPT - 1);
    setChildren(strip, [
      head,
      now
        ? stripRow(STEP_LAMP.running, now.kind, now.subject, 'commit-browser__step--now commit-browser__step--running')
        : stripRow(STEP_LAMP.running, null, phaseText(job), NOW_PHASE),
      ...trail.map((step) => stripRow(STEP_LAMP[step.state], step.kind, step.subject, `commit-browser__step--${step.state}`)),
    ]);
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
    this.stripEl = null;
    if (!c) {
      this.shown = null;
      this.previewEl.replaceChildren(el(
        'div',
        { class: 'commit-browser__preview-scroll' },
        el('p', { class: 'commit-browser__preview-empty', text: 'No commit selected.' }),
      ));
      return;
    }
    const lamp = this.rowLamp(c.sha);
    const job = this.explainer.job(this.root, c.sha);
    this.shown = { sha: c.sha, job: job?.state ?? null };
    // The lamp window holds the state word only; the strip says the rest.
    const status = job ? (job.state === 'running' ? 'explaining' : 'queued') : lamp === 'ready' ? 'explained' : 'not explained';
    const path = this.docPath(c.sha);
    const actions: KeyHint[] = job
      ? [{ keys: ['x'], label: 'cancel' }, { keys: ['d'], label: 'diff' }, { keys: ['y'], label: 'copy sha' }]
      : lamp === 'ready'
        ? [{ keys: ['o'], label: 'open' }, { keys: ['E'], label: 'regenerate' }, { keys: ['d'], label: 'diff' }]
        : [{ keys: ['e'], label: 'explain' }, { keys: ['d'], label: 'diff' }, { keys: ['y'], label: 'copy sha' }];
    const files = `${c.files} file${c.files === 1 ? '' : 's'}`;
    if (job) {
      this.stripEl = el('div', { class: 'commit-browser__job' });
      this.paintStrip(this.stripEl, job);
    }

    // Only the message scrolls: the strip and the foot stay put under it.
    setChildren(this.previewEl, [
      el(
        'div',
        { class: 'commit-browser__preview-scroll' },
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
        c.body.trim() ? el('div', { class: 'commit-browser__preview-body', text: c.body.trim() }) : null,
      ),
      this.stripEl,
      el(
        'div',
        { class: 'commit-browser__preview-foot' },
        path && lamp !== 'none' ? el('p', { class: 'commit-browser__preview-path', text: path }) : null,
        el('p', { class: 'commit-browser__preview-keys' }, ...keyHintNodes(actions)),
      ),
    ]);
  }

  private notify(message: string): void {
    this.notifyCallback?.(message);
  }
}
