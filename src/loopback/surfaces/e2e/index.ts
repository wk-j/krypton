// Spec 329 / 341 — the e2e explorer: a read-only browser over the project's
// e2e cases, their runs, each run's checks, log and artifacts. Ported from the
// self-contained `src/acp/artifact-e2e.html` into the loopback app.

import { DisposableBag } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';
import {
  Banner,
  button,
  copyText,
  dot,
  emptyState,
  fetchJson,
  fetchText,
  formatBytes,
  HttpError,
  kbdHints,
  keymap,
  keyValue,
  pad2,
  pill,
  poll,
  RosterList,
  SearchFilter,
  StatBar,
} from '../../kit';
import type { Poller, Tone } from '../../kit';

import './e2e.css';

const FOCUS_RELOAD_MS = 10000;
const ACTIVE_POLL_MS = 2000;
const LOADING_DELAY_MS = 250;
const EXPIRED = 'This link has expired: Krypton restarted. Run #e2e open again.';
const TEXT_EXT = ['json', 'txt', 'log', 'md', 'csv', 'xml', 'yaml', 'yml', 'html', 'htm', 'svg'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const LETTER: Readonly<Record<string, string>> = {
  PASS: 'P',
  FAIL: 'F',
  ERROR: 'E',
  BLOCKED: 'B',
  CANCELLED: 'C',
  'NO RESULT': '!',
  'INVALID RESULT': '!',
  INTERRUPTED: '!',
};

export interface E2eCase {
  readonly id: string;
  readonly title: string;
  readonly code: string | null;
  readonly issue: number | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly fresh: Readonly<Record<string, unknown>>;
  readonly files: readonly string[];
  readonly caseHash: string | null;
  readonly uncommitted: boolean;
}

export interface E2eRun {
  readonly caseId: string;
  readonly runId: string;
  readonly origin: string;
  readonly launchId: string | null;
  readonly verdict: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly counts: { pass: number; fail: number; skip: number; blocked: number; info: number };
  readonly versions: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly git: { sha: string; dirty: boolean; branch: string } | null;
  readonly caseHash: string | null;
  readonly exitCode: number | null;
  readonly resultPath: string | null;
  readonly message: string | null;
  readonly argv: readonly string[] | null;
}

interface E2eIssue {
  readonly number: number;
  readonly state: string;
  readonly url: string;
  readonly reportedRunIds: readonly string[];
}

interface ActiveLaunch {
  readonly launchId: string;
  readonly caseId: string;
  readonly startedAt: string;
}

export interface E2eStatus {
  readonly projectName: string;
  readonly initialized: boolean;
  readonly manifest: { readonly name: string } | null;
  readonly errors: readonly string[];
  readonly issues: readonly E2eIssue[] | null;
  readonly issuesError: string | null;
  readonly activeLaunch: ActiveLaunch | null;
  readonly cases: readonly E2eCase[];
  readonly runs: readonly E2eRun[];
}

interface Check {
  readonly group?: string;
  readonly label: string;
  readonly status: string;
  readonly detail?: string;
}

interface Artifact {
  readonly label: string;
  readonly path: string;
  readonly size: number | null;
  readonly problem: string | null;
  readonly index: number;
}

interface RunDetail {
  readonly info: E2eRun;
  readonly result: { readonly checks?: readonly Check[]; readonly env?: string } | null;
  readonly log: boolean;
  readonly artifacts: readonly Omit<Artifact, 'index'>[];
}

type Pane = 'cases' | 'runs' | 'artifacts';

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function duration(run: E2eRun): string {
  const a = Date.parse(run.startedAt ?? '');
  const b = Date.parse(run.finishedAt ?? '');
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return '—';
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
}

function verdictTone(verdict: string): Tone {
  if (verdict === 'PASS') return 'add';
  if (verdict === 'BLOCKED') return 'accent';
  if (verdict === 'CANCELLED') return 'muted';
  return 'del';
}

function checkTone(status: string): Tone {
  if (status === 'pass') return 'add';
  if (status === 'fail') return 'del';
  if (status === 'blocked') return 'accent';
  return 'muted';
}

function pairs(record: Readonly<Record<string, unknown>> | null, sep: string): string {
  return record ? Object.keys(record).map((k) => `${k}${sep}${String(record[k])}`).join('  ') : '';
}

/** `keyValue` rows, dropping empty values as the old page did. */
function kv(rows: readonly (readonly [string, string | null | undefined])[]): HTMLDListElement {
  return keyValue(rows.filter((row): row is readonly [string, string] => row[1] !== null && row[1] !== undefined && row[1] !== ''));
}

/** The route's `{"error"}` text, or its plain body, or the status. */
function failureText(error: unknown): string {
  if (error instanceof HttpError) {
    try {
      const parsed = JSON.parse(error.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* plain text */
    }
    return error.body || `status ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface E2eViewOptions {
  readonly token: string;
  readonly setTitle?: (title: string) => void;
}

export class E2eView {
  readonly el: HTMLElement;
  private readonly api: string;
  private readonly bag = new DisposableBag();
  private readonly stats = new StatBar([]);
  private readonly activeDot = el('span', { class: 'lb-e2e__dot' });
  private readonly activeText = el('span', { text: 'nothing' });
  private readonly titleNode = el('h1', { class: 'lb-e2e__title', text: 'E2E Explorer' });
  private readonly projectNode = el('span', { class: 'lb-e2e__project lb-muted', text: 'loading' });
  private readonly errors = el('div', { class: 'lb-e2e__errors' });
  private readonly flash = new Banner();
  private readonly filter: SearchFilter;
  private readonly cases: RosterList<E2eCase>;
  private readonly casesEmpty = el('div', { class: 'lb-e2e__cases-empty' });
  private readonly runs: RosterList<E2eRun>;
  private readonly artifacts: RosterList<Artifact>;
  private readonly casePane: HTMLElement;
  private readonly runsPane: HTMLElement;
  private readonly caseHead = el('div', { class: 'lb-e2e__section lb-e2e__case-head' });
  private readonly runCount = el('span', { class: 'lb-e2e__count', text: '0' });
  private readonly runBox = el('div', { class: 'lb-e2e__section lb-e2e__run' });
  private readonly viewer = el('div', { class: 'lb-e2e__viewer', attrs: { hidden: true } });
  private readonly poller: Poller;

  private status: E2eStatus | null = null;
  private detail: RunDetail | null = null;
  private selectedCase: string | null = null;
  private selectedRun: string | null = null;
  private selectedArtifact = 0;
  private pane: Pane = 'cases';
  private failuresOnly = false;
  private loadedAt = 0;
  private activeTimer: number | undefined;
  private loadingTimer: number | undefined;
  private detailRequest = 0;
  private retriedMissingRun = false;

  constructor(private readonly options: E2eViewOptions) {
    this.api = `/e2e/api/${encodeURIComponent(options.token)}`;
    this.filter = new SearchFilter({
      placeholder: 'Filter cases',
      onInput: () => this.renderCases(),
      onSubmit: () => this.leaveFilter(),
    });
    this.cases = new RosterList<E2eCase>({
      label: 'E2E cases',
      key: (c) => c.id,
      render: (c) => this.caseRow(c),
      deps: (c) => [c, this.status],
      when: () => this.pane === 'cases',
      onSelect: (c) => this.selectCase(c.id, null),
    });
    this.runs = new RosterList<E2eRun>({
      label: 'Runs of the selected case',
      key: (r) => r.runId,
      render: (r) => this.runRow(r),
      empty: 'No runs yet',
      when: () => this.pane === 'runs',
      onSelect: (r) => this.selectRun(r.runId),
    });
    this.artifacts = new RosterList<Artifact>({
      label: 'Artifacts',
      key: (a) => String(a.index),
      render: (a) =>
        el(
          'span',
          { class: 'lb-e2e__artifact' },
          el('span', { text: a.label }),
          el('span', { class: 'lb-muted', text: a.path }),
          el('span', { class: a.problem ? 'lb-e2e__problem' : 'lb-muted', text: a.problem ?? (a.size === null ? '' : formatBytes(a.size)) }),
        ),
      when: () => this.pane === 'artifacts',
      onSelect: (a) => {
        this.selectedArtifact = a.index;
      },
      onOpen: (a) => {
        this.setPane('artifacts');
        this.openArtifact(a.index);
      },
    });
    this.bag.add(() => this.filter.dispose());
    this.bag.add(() => this.cases.dispose());
    this.bag.add(() => this.runs.dispose());
    this.bag.add(() => this.artifacts.dispose());
    this.bag.add(() => this.flash.dispose());
    this.bag.listen(this.cases.el, 'click', () => this.setPane('cases'));
    this.bag.listen(this.runs.el, 'click', () => this.setPane('runs'));

    this.casePane = el(
      'aside',
      { class: 'lb-e2e__cases', attrs: { 'aria-label': 'Cases' } },
      el('div', { class: 'lb-e2e__pane-head' }, el('h2', { class: 'lb-h3', text: 'Cases' }), this.filter.el),
      el('div', { class: 'lb-e2e__list' }, this.cases.el, this.casesEmpty),
    );
    this.runsPane = el(
      'div',
      { class: 'lb-e2e__section' },
      el('div', { class: 'lb-e2e__pane-title' }, el('h2', { class: 'lb-h3', text: 'Runs' }), this.runCount),
      el(
        'div',
        { class: 'lb-e2e__run-row lb-e2e__run-head' },
        ...['verdict', 'run', 'origin', 'started', 'time', 'checks', 'commit · versions'].map((t) => el('span', { text: t })),
      ),
      el('div', { class: 'lb-e2e__runs' }, this.runs.el),
    );
    setChildren(this.caseHead, [emptyState('Select a case')]);
    setChildren(this.runBox, [emptyState('Select a run')]);

    this.el = el(
      'div',
      { class: 'lb-page lb-page--split lb-e2e' },
      el(
        'header',
        { class: 'lb-e2e__head' },
        el('div', {}, this.titleNode, this.projectNode),
        el('span', { class: 'lb-e2e__active' }, this.activeDot, this.activeText),
        el('span', { class: 'lb-e2e__readonly', text: 'read only' }),
      ),
      this.stats.el,
      this.errors,
      this.flash.el,
      el(
        'section',
        { class: 'lb-e2e__layout' },
        this.casePane,
        el('article', { class: 'lb-e2e__detail', attrs: { 'aria-live': 'polite' } }, this.caseHead, this.runsPane, this.runBox),
      ),
      kbdHints(
        [
          ['/', 'filter'],
          ['j / k', 'move'],
          ['Tab', 'next pane'],
          ['Enter', 'open'],
          ['f', 'failures only'],
          ['l', 'log'],
          ['y', 'copy run command'],
          ['r', 'reload'],
          ['Esc', 'close'],
        ],
        'read-only · refreshes on focus · run with #e2e run <case>',
      ),
    );
    this.bindKeys();
    this.setPane('cases');
    this.renderActive();

    this.poller = poll<E2eStatus>({
      load: (signal) => this.loadStatus(signal),
      apply: (next) => this.applyStatus(next),
      onStatus: (state, error) => {
        if (state === 'reconnecting') this.renderFatal(failureText(error));
      },
      refreshOnFocus: true,
      minGapMs: FOCUS_RELOAD_MS,
    });
    this.bag.add(() => this.poller.dispose());
    this.bag.add(() => {
      window.clearTimeout(this.activeTimer);
      window.clearTimeout(this.loadingTimer);
      this.detailRequest += 1;
    });
  }

  dispose(): void {
    this.bag.dispose();
  }

  // ── keys ──

  private bindKeys(): void {
    this.bag.add(
      keymap().bindAll([
        {
          key: 'ArrowDown',
          inInput: true,
          when: () => document.activeElement === this.filter.input,
          label: 'Leave the filter',
          run: () => this.leaveFilter(),
        },
        { key: 'Tab', shift: false, label: 'Next pane', run: () => this.cyclePane(false) },
        { key: 'Tab', shift: true, label: 'Previous pane', display: '⇧Tab', run: () => this.cyclePane(true) },
        { key: 'Enter', label: 'Open: runs, artifacts, then the artifact', run: () => this.enter() },
        { key: 'f', label: 'Failed and blocked checks only', run: () => this.toggleFailures() },
        { key: 'l', label: 'Open the run log', run: () => this.openLog() },
        { key: 'y', label: 'Copy the run command', run: () => void this.copyCommand() },
        { key: 'r', label: 'Reload', run: () => void this.poller.refresh() },
        {
          key: 'Escape',
          label: 'Close the viewer / clear the filter',
          run: () => {
            if (this.closeViewer()) return;
            if (!this.filter.query) return false;
            this.filter.query = '';
          },
        },
      ]),
    );
  }

  private leaveFilter(): void {
    this.filter.input.blur();
    this.setPane('cases');
  }

  private enter(): void {
    if (this.pane === 'cases') this.setPane('runs');
    else if (this.pane === 'runs') {
      if (this.detail && this.detail.artifacts.length) this.setPane('artifacts');
    } else this.openArtifact(this.selectedArtifact);
  }

  private cyclePane(back: boolean): void {
    const order: Pane[] = ['cases', 'runs', 'artifacts'];
    if (!this.detail || !this.detail.artifacts.length) order.pop();
    const i = Math.max(0, order.indexOf(this.pane));
    this.setPane(order[(i + (back ? order.length - 1 : 1)) % order.length]);
  }

  private setPane(next: Pane): void {
    this.pane = next;
    this.casePane.classList.toggle('lb-e2e__pane--focused', next === 'cases');
    this.runsPane.classList.toggle('lb-e2e__pane--focused', next === 'runs');
    this.runBox.classList.toggle('lb-e2e__pane--focused', next === 'artifacts');
  }

  // ── loading ──

  private async loadStatus(signal: AbortSignal): Promise<E2eStatus> {
    this.renderStats('loading…');
    try {
      return await fetchJson<E2eStatus>(`${this.api}/status`, { signal });
    } catch (error) {
      if (error instanceof HttpError) throw new Error(error.status === 404 ? EXPIRED : `status ${error.status}`);
      throw error;
    }
  }

  private applyStatus(next: E2eStatus): void {
    this.status = next;
    this.loadedAt = Date.now();
    this.retriedMissingRun = false;
    this.renderStatus();
  }

  private scheduleActivePoll(): void {
    window.clearTimeout(this.activeTimer);
    if (!this.status?.activeLaunch) return;
    this.activeTimer = window.setTimeout(() => void this.pollActive(), ACTIVE_POLL_MS);
  }

  /** Only the cheap `/active` route while a launch runs; a change reloads `/status`. */
  private async pollActive(): Promise<void> {
    if (document.visibilityState === 'hidden') {
      this.scheduleActivePoll();
      return;
    }
    const known = this.status?.activeLaunch?.launchId ?? null;
    try {
      const next = await fetchJson<{ activeLaunch: ActiveLaunch | null }>(`${this.api}/active`);
      const now = next.activeLaunch?.launchId ?? null;
      if (now !== known) void this.poller.refresh();
      else this.scheduleActivePoll();
    } catch {
      this.scheduleActivePoll();
    }
  }

  // ── rendering ──

  private renderStats(loaded: string): void {
    const status = this.status;
    const tally = new Map<string, number>();
    for (const c of status?.cases ?? []) {
      const key = this.runsOf(c.id)[0]?.verdict ?? 'never run';
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    this.stats.update([
      { key: 'cases', label: 'Cases', value: status ? status.cases.length : '—' },
      { key: 'latest', label: 'Latest runs', value: [...tally].map(([k, n]) => `${n} ${k}`).join(' · ') || '—' },
      { key: 'loaded', label: 'Loaded', value: loaded, tone: 'muted' },
    ]);
  }

  private renderActive(): void {
    const active = this.status?.activeLaunch ?? null;
    this.activeDot.replaceChildren(dot(active ? 'live' : 'idle'));
    this.activeText.textContent = active ? `${active.caseId} since ${when(active.startedAt)}` : 'nothing';
  }

  private renderFatal(message: string): void {
    this.renderStats('failed');
    this.errors.replaceChildren(this.errorBlock(message));
  }

  private errorBlock(message: string): HTMLElement {
    const banner = new Banner();
    banner.show(message, 'error');
    return banner.el;
  }

  private renderStatus(): void {
    const status = this.status;
    if (!status) return;
    const name = status.manifest ? status.manifest.name : 'E2E Explorer';
    this.titleNode.textContent = name;
    this.projectNode.textContent = `${status.projectName} · e2e explorer`;
    this.options.setTitle?.(status.manifest ? status.manifest.name : status.projectName);
    this.renderStats(when(new Date(this.loadedAt).toISOString()));

    const messages: string[] = [];
    if (!status.initialized) messages.push("not initialized — run #e2e init in this project's harness");
    messages.push(...status.errors);
    if (status.issuesError) messages.push(`issues unavailable: ${status.issuesError}`);
    this.errors.replaceChildren(...messages.map((m) => this.errorBlock(m)));
    this.renderActive();

    const wanted = new URLSearchParams(location.hash.slice(1));
    if (!this.selectedCase) this.selectedCase = wanted.get('case');
    if (!this.selectedRun) this.selectedRun = wanted.get('run');
    if (!status.cases.some((c) => c.id === this.selectedCase)) {
      this.selectedCase = status.cases[0]?.id ?? null;
      this.selectedRun = null;
    }
    this.renderCases();
    this.selectCase(this.selectedCase, this.selectedRun);
    this.scheduleActivePoll();
  }

  private runsOf(caseId: string | null): E2eRun[] {
    return this.status ? this.status.runs.filter((r) => r.caseId === caseId) : [];
  }

  private issueOf(c: E2eCase): E2eIssue | null {
    if (!this.status?.issues || c.issue === null || c.issue === undefined) return null;
    return this.status.issues.find((i) => i.number === c.issue) ?? null;
  }

  // Spec 0328 marks, as `e2eCaseMarks` computes them for `#e2e status`.
  private marksOf(c: E2eCase, runs: readonly E2eRun[]): string[] {
    const marks: string[] = [];
    if (c.uncommitted) marks.push('uncommitted');
    const lastPass = runs.find((r) => r.origin === 'krypton' && r.verdict === 'PASS');
    if (c.caseHash && lastPass?.caseHash && lastPass.caseHash !== c.caseHash) marks.push('edited');
    const issue = this.issueOf(c);
    if (issue) {
      const judged = runs.find((r) => r.verdict === 'PASS' || r.verdict === 'FAIL');
      if (judged && !issue.reportedRunIds.includes(judged.runId)) marks.push('unreported');
    }
    return marks;
  }

  private visibleCases(): E2eCase[] {
    if (!this.status) return [];
    const q = this.filter.query.trim().toLowerCase();
    return this.status.cases.filter(
      (c) => !q || [c.id, c.title, c.code ?? '', c.issue ? `#${c.issue}` : ''].join(' ').toLowerCase().includes(q),
    );
  }

  private renderCases(): void {
    const cases = this.visibleCases();
    const total = this.status ? this.status.cases.length : 0;
    this.filter.setCount(`${cases.length} / ${total}`);
    this.cases.setItems(cases);
    this.cases.select(this.selectedCase, false);
    this.casesEmpty.hidden = cases.length > 0;
    setChildren(this.casesEmpty, [emptyState(!this.status ? 'loading' : total ? 'No case matches the filter' : 'No cases')]);
  }

  private caseRow(c: E2eCase): HTMLElement {
    const runs = this.runsOf(c.id);
    const latest = runs[0];
    const marks = this.marksOf(c, runs);
    return el(
      'span',
      { class: 'lb-e2e__case' },
      el(
        'span',
        { class: 'lb-e2e__row' },
        el('span', { class: 'lb-e2e__case-id', text: c.id }),
        pill(latest ? latest.verdict : 'NEVER RUN', latest ? verdictTone(latest.verdict) : 'muted'),
      ),
      el('span', { class: 'lb-e2e__case-title', text: c.title }),
      el(
        'span',
        { class: 'lb-e2e__row' },
        el(
          'span',
          { class: 'lb-e2e__strip' },
          ...runs.slice(0, 10).map((r) => {
            const letter = LETTER[r.verdict] ?? '!';
            return el('span', { class: `lb-e2e__strip--${letter === '!' ? 'X' : letter}`, text: letter });
          }),
        ),
        el('span', { class: 'lb-muted lb-e2e__meta', text: [c.code, c.issue ? `#${c.issue}` : null].filter(Boolean).join(' · ') }),
      ),
      marks.length ? el('span', { class: 'lb-e2e__marks' }, ...marks.map((m) => el('span', { class: 'lb-e2e__mark', text: m }))) : null,
    );
  }

  private runRow(r: E2eRun): HTMLElement {
    const commit = r.git ? `${r.git.sha.slice(0, 8)}${r.git.dirty ? '*' : ''} ${r.git.branch}` : '';
    const versions = Object.keys(r.versions)
      .map((k) => `${k} ${r.versions[k]}`)
      .join(' · ');
    return el(
      'span',
      { class: 'lb-e2e__run-row' },
      el('span', {}, pill(r.verdict, verdictTone(r.verdict))),
      el('span', { text: r.runId }),
      el('span', { class: 'lb-muted', text: r.origin }),
      el('span', { text: when(r.startedAt) }),
      el('span', { text: duration(r) }),
      el('span', { text: `${r.counts.pass}✓ ${r.counts.fail + r.counts.blocked}✗` }),
      el('span', { class: 'lb-muted', text: [commit, versions].filter(Boolean).join(' · ') }),
    );
  }

  private selectCase(caseId: string | null, runId: string | null): void {
    this.selectedCase = caseId;
    const c = this.status?.cases.find((x) => x.id === caseId) ?? null;
    this.cases.select(caseId, false);
    const runs = c ? this.runsOf(c.id) : [];
    const run = runs.some((r) => r.runId === runId) ? runId : (runs[0]?.runId ?? null);
    this.selectRun(run, () => {
      this.renderCaseHead(c);
      this.runCount.textContent = String(runs.length);
      this.runs.setItems(runs);
    });
  }

  private renderCaseHead(c: E2eCase | null): void {
    if (!c) {
      setChildren(this.caseHead, [
        emptyState(this.status && !this.status.cases.length ? 'No cases — the adapter listed none' : 'Select a case'),
      ]);
      return;
    }
    const issue = this.issueOf(c);
    setChildren(this.caseHead, [
      el(
        'div',
        { class: 'lb-e2e__row' },
        el('h2', { class: 'lb-h2', text: c.title }),
        issue
          ? el('a', {
              text: `#${issue.number} ${issue.state.toLowerCase()}`,
              attrs: { href: issue.url, target: '_blank', rel: 'noreferrer noopener' },
            })
          : null,
      ),
      kv([
        ['id', c.id],
        ['code', c.code],
        ['issue', c.issue && !issue ? `#${c.issue}` : null],
        ['files', c.files.join('  ')],
        ['params', pairs(c.params, '=')],
        ['fresh', pairs(c.fresh, '=')],
        ['marks', this.marksOf(c, this.runsOf(c.id)).join('  ')],
      ]),
      el(
        'div',
        { class: 'lb-e2e__command' },
        el('code', { class: 'lb-code', text: `#e2e run ${c.id}` }),
        button('copy', { kbd: 'y', onClick: () => void this.copyCommand() }),
      ),
    ]);
  }

  /**
   * Select a run and fetch its detail. The run highlight moves now; the
   * previous detail stays on screen until `/run` answers, then the pending
   * case switch (`paintCase`) and the run pane render in one task, so a switch
   * never paints an empty or half-built detail. Only an answer slower than
   * LOADING_DELAY_MS shows `loading run…`.
   */
  private selectRun(runId: string | null, paintCase?: () => void): void {
    this.selectedRun = runId;
    this.selectedArtifact = 0;
    // The old detail's log and artifacts must not open under the new run id.
    this.detail = null;
    this.writeHash();
    window.clearTimeout(this.loadingTimer);
    const request = ++this.detailRequest;
    let pending = paintCase ?? null;
    const paint = (fill: () => void): void => {
      if (pending) {
        pending();
        pending = null;
        this.runs.select(runId, false);
      }
      fill();
    };
    if (!pending) this.runs.select(runId, false);
    const caseId = this.selectedCase;
    if (!runId || !caseId) {
      paint(() => setChildren(this.runBox, [emptyState('Select a run')]));
      return;
    }
    this.loadingTimer = window.setTimeout(() => {
      paint(() => setChildren(this.runBox, [emptyState('loading run…')]));
    }, LOADING_DELAY_MS);
    const url = `${this.api}/run?case=${encodeURIComponent(caseId)}&run=${encodeURIComponent(runId)}`;
    fetchJson<RunDetail>(url).then(
      (next) => {
        if (request !== this.detailRequest) return;
        window.clearTimeout(this.loadingTimer);
        this.detail = next;
        paint(() => this.renderRun());
      },
      (error: unknown) => {
        if (request !== this.detailRequest) return;
        if (error instanceof HttpError && error.status === 404 && !this.retriedMissingRun) {
          window.clearTimeout(this.loadingTimer);
          this.retriedMissingRun = true;
          void this.poller.refresh();
          return;
        }
        window.clearTimeout(this.loadingTimer);
        paint(() => setChildren(this.runBox, [emptyState(failureText(error))]));
      },
    );
  }

  private writeHash(): void {
    const params = new URLSearchParams();
    if (this.selectedCase) params.set('case', this.selectedCase);
    if (this.selectedRun) params.set('run', this.selectedRun);
    const hash = params.toString();
    history.replaceState(null, '', location.pathname + location.search + (hash ? `#${hash}` : ''));
  }

  private renderRun(): void {
    const detail = this.detail;
    if (!detail) return;
    const info = detail.info;
    const c = info.counts;
    const children: ElChild[] = [
      el(
        'div',
        { class: 'lb-e2e__row' },
        el('span', { class: 'lb-e2e__row' }, pill(info.verdict, verdictTone(info.verdict)), el('strong', { class: 'lb-e2e__run-id', text: info.runId })),
        el('span', { class: 'lb-muted lb-e2e__meta', text: info.origin + (info.launchId ? ` · launch ${info.launchId}` : '') }),
      ),
      kv([
        ['started', when(info.startedAt)],
        ['finished', `${when(info.finishedAt)} (${duration(info)})`],
        ['commit', info.git ? `${info.git.sha}${info.git.dirty ? ' (dirty)' : ''} on ${info.git.branch}` : null],
        ['env', detail.result?.env],
        ['versions', pairs(info.versions, ' ')],
        ['params', info.params ? pairs(info.params, '=') : null],
        ['exit', info.exitCode === null || info.exitCode === undefined ? null : String(info.exitCode)],
        ['argv', info.argv ? info.argv.join(' ') : null],
        ['result', info.resultPath],
      ]),
      info.message ? el('div', { class: 'lb-e2e__message', text: info.message }) : null,
      el(
        'div',
        { class: 'lb-e2e__toolbar' },
        button('failures only', {
          variant: 'toggle',
          pressed: this.failuresOnly,
          kbd: 'f',
          onClick: () => this.toggleFailures(),
        }),
        detail.log ? button('log', { kbd: 'l', onClick: () => this.openLog() }) : null,
        el('span', {
          class: 'lb-muted lb-e2e__meta',
          text: `${c.pass} pass · ${c.fail} fail · ${c.blocked} blocked · ${c.skip} skip · ${c.info} info`,
        }),
      ),
      this.renderChecks(detail),
    ];
    if (detail.artifacts.length) {
      this.artifacts.setItems(detail.artifacts.map((a, index) => ({ ...a, index })));
      this.artifacts.select(String(this.selectedArtifact), false);
      children.push(el('div', { class: 'lb-e2e__group' }, el('div', { class: 'lb-e2e__group-name', text: 'Artifacts' }), this.artifacts.el));
    }
    this.closeViewer();
    children.push(this.viewer);
    setChildren(this.runBox, children);
  }

  private renderChecks(detail: RunDetail): HTMLElement {
    if (!detail.result) return emptyState('No Result for this run — see the message and the log');
    const checks = Array.isArray(detail.result.checks) ? detail.result.checks : [];
    const shown = checks.filter((c) => !this.failuresOnly || c.status === 'fail' || c.status === 'blocked');
    if (!shown.length) return emptyState(this.failuresOnly ? 'No failed or blocked checks' : 'No checks');
    const groups = new Map<string, Check[]>();
    for (const check of shown) {
      const name = check.group ?? '';
      groups.set(name, [...(groups.get(name) ?? []), check]);
    }
    return el(
      'div',
      { class: 'lb-e2e__checks' },
      ...[...groups].map(([name, list]) =>
        el(
          'div',
          { class: 'lb-e2e__group' },
          name ? el('div', { class: 'lb-e2e__group-name', text: name }) : null,
          ...list.map((check) =>
            el(
              'div',
              { class: 'lb-e2e__check' },
              el('span', {}, pill(check.status, checkTone(check.status))),
              el(
                'span',
                { class: 'lb-e2e__check-label' },
                check.label,
                check.detail ? el('span', { class: 'lb-e2e__check-detail', text: check.detail }) : null,
              ),
            ),
          ),
        ),
      ),
    );
  }

  private toggleFailures(): void {
    this.failuresOnly = !this.failuresOnly;
    if (this.detail) this.renderRun();
  }

  // ── viewer ──

  private showViewer(title: string, content: HTMLElement): void {
    this.viewer.hidden = false;
    setChildren(this.viewer, [
      el(
        'div',
        { class: 'lb-e2e__viewer-head' },
        el('span', { text: title }),
        button('close', { variant: 'ghost', kbd: 'Esc', onClick: () => this.closeViewer() }),
      ),
      content,
    ]);
    this.viewer.scrollIntoView?.({ block: 'nearest' });
  }

  private closeViewer(): boolean {
    if (this.viewer.hidden) return false;
    this.viewer.hidden = true;
    this.viewer.replaceChildren();
    return true;
  }

  private showText(title: string, url: string): void {
    const pre = el('pre', { class: 'lb-e2e__viewer-text', text: 'loading…' });
    this.showViewer(title, pre);
    fetchText(url).then(
      (text) => {
        pre.textContent = text || '(empty)';
      },
      (error: unknown) => {
        pre.textContent = failureText(error);
      },
    );
  }

  private openLog(): void {
    const detail = this.detail;
    if (!detail || !detail.log || !detail.info.launchId) return;
    this.showText(`log · ${detail.info.launchId}`, `${this.api}/log?launch=${encodeURIComponent(detail.info.launchId)}`);
  }

  private openArtifact(index: number): void {
    const a = this.detail?.artifacts[index];
    if (!a || !this.selectedCase || !this.selectedRun) return;
    if (a.problem) {
      this.flash.show(`${a.path}: ${a.problem}`, 'error', 4000);
      return;
    }
    const url = `${this.api}/artifact?case=${encodeURIComponent(this.selectedCase)}&run=${encodeURIComponent(this.selectedRun)}&index=${index}`;
    const ext = (a.path.split('.').pop() ?? '').toLowerCase();
    const title = `${a.label} · ${a.path}`;
    if (IMAGE_EXT.includes(ext)) {
      this.showViewer(title, el('img', { class: 'lb-e2e__viewer-img', attrs: { alt: a.label, src: url } }));
    } else if (TEXT_EXT.includes(ext)) {
      this.showText(title, url);
    } else {
      this.showViewer(title, el('pre', { class: 'lb-e2e__viewer-text' }, el('a', { text: `download ${a.path}`, attrs: { href: url } })));
    }
  }

  private async copyCommand(): Promise<void> {
    if (!this.selectedCase) return;
    const text = `#e2e run ${this.selectedCase}`;
    const ok = await copyText(text);
    this.flash.show(ok ? `copied: ${text}` : text, ok ? 'ok' : 'info', 4000);
  }
}
