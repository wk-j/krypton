// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExplainChange, ExplainJob, ExplainStep } from './commit-explainer';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import {
  CommitBrowserView,
  isCandidate,
  type CommitSummary,
  type ExplainerPort,
  type GitLogPage,
  type KnowledgeIndex,
} from './commit-browser-view';

/** In-memory jobs keyed by sha; the test settles them by hand. */
class FakeExplainer implements ExplainerPort {
  readonly jobs = new Map<string, ExplainJob>();
  readonly started: string[] = [];
  private readonly listeners = new Set<(change: ExplainChange) => void>();

  start(root: string, repoName: string, sha: string): ExplainJob {
    const job: ExplainJob = {
      root, repoName, sha, state: 'queued', startedAt: null, backend: null, model: null,
      phase: null, steps: [], stepCount: 0, continuations: 0,
    };
    this.jobs.set(sha, job);
    this.started.push(sha);
    this.emit({ kind: 'update', job });
    return job;
  }
  cancel(_root: string, sha: string): boolean {
    const job = this.jobs.get(sha);
    if (!job) return false;
    this.jobs.delete(sha);
    this.emit({ kind: 'cancelled', job });
    return true;
  }
  job(_root: string, sha: string): ExplainJob | null { return this.jobs.get(sha) ?? null; }
  queuedAhead(): number { return 0; }
  subscribe(listener: (change: ExplainChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(change: ExplainChange): void {
    for (const listener of this.listeners) listener(change);
  }
  /** End a job the way the runner does: drop it, then report. */
  settle(sha: string, outcome: { kind: 'ready'; path: string } | { kind: 'failed'; message: string }): void {
    const job = this.jobs.get(sha);
    if (!job) throw new Error(`no job for ${sha}`);
    this.jobs.delete(sha);
    this.emit({ ...outcome, job });
  }
}

function commit(n: number, over: Partial<CommitSummary> = {}): CommitSummary {
  const sha = String(n).padStart(7, '0') + 'f'.repeat(33);
  return {
    sha,
    shortSha: sha.slice(0, 12),
    author: `author${n}`,
    at: 1_700_000_000,
    subject: `feat: change ${n}`,
    body: '',
    isMerge: false,
    files: 1,
    added: 1,
    removed: 1,
    ...over,
  };
}

function page(commits: CommitSummary[], hasMore = false): GitLogPage {
  return { repoRoot: '/repo', repoName: 'repo', branch: 'main', commits, hasMore };
}

const state: { knowledge: KnowledgeIndex; pages: GitLogPage[]; diff: string } = {
  knowledge: { dir: '/k', docs: [] },
  pages: [],
  diff: '',
};

let view: CommitBrowserView | null = null;
let notes: string[] = [];
let explainer: FakeExplainer;

function mount(first: GitLogPage): CommitBrowserView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  view = new CommitBrowserView(first, container, explainer);
  view.setNotifier((message) => notes.push(message));
  return view;
}

function press(v: CommitBrowserView, key: string): boolean {
  return v.onKeyDown(new KeyboardEvent('keydown', { key }));
}

function row(v: CommitBrowserView, c: CommitSummary): HTMLElement {
  const node = v.element.querySelector<HTMLElement>(`.commit-browser__row[data-sha="${c.sha}"]`);
  if (!node) throw new Error(`no row for ${c.sha}`);
  return node;
}

function rows(v: CommitBrowserView): HTMLElement[] {
  return [...v.element.querySelectorAll<HTMLElement>('.commit-browser__row')];
}

/** Drain the mocked IPC promise chains (every await in the view is a resolved mock). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function knowledgeLoaded(): Promise<void> {
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('knowledge_list'));
  await settle();
}

/** Move a job into the running state the way the runner reports it. */
function running(job: ExplainJob, over: Partial<ExplainJob> = {}): void {
  Object.assign(job, {
    state: 'running', startedAt: Date.now(), backend: 'codex', model: 'gpt-6.1-sol[high]', phase: 'thinking', ...over,
  });
  explainer.emit({ kind: 'update', job });
}

function strip(v: CommitBrowserView): { now: string; trail: string[]; meta: string } {
  const text = (node: Element | null): string => node?.textContent ?? '';
  const now = v.element.querySelector('.commit-browser__step--now');
  return {
    now: [...(now?.children ?? [])].map(text).filter(Boolean).join(' '),
    trail: [...v.element.querySelectorAll('.commit-browser__step:not(.commit-browser__step--now)')]
      .map((node) => [...node.children].map(text).filter(Boolean).join(' ')),
    meta: text(v.element.querySelector('.commit-browser__job-meta')),
  };
}

beforeEach(() => {
  notes = [];
  explainer = new FakeExplainer();
  state.knowledge = { dir: '/k', docs: [] };
  state.pages = [];
  state.diff = '';
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'knowledge_list') return state.knowledge;
    if (cmd === 'git_commit_diff') return state.diff;
    if (cmd === 'git_log_page') {
      const next = state.pages.shift();
      if (!next) throw new Error('no page');
      return next;
    }
    throw new Error(`unexpected ${cmd}`);
  });
});

afterEach(() => {
  view?.dispose();
  view = null;
  mocks.invoke.mockReset();
  document.body.replaceChildren();
});

describe('isCandidate', () => {
  const fix = commit(1, { subject: 'fix(term): stop the leak', body: 'why it leaked\nhow it is fixed', added: 150, removed: 50 });

  it('accepts a fix with two body lines at exactly 200 changed lines', () => {
    expect(isCandidate(fix)).toBe(true);
  });

  it('rejects 201 changed lines', () => {
    expect(isCandidate({ ...fix, removed: 51 })).toBe(false);
  });

  it('needs two non-empty body lines', () => {
    expect(isCandidate({ ...fix, body: 'only one line\n\n  \n' })).toBe(false);
    expect(isCandidate({ ...fix, body: 'one\n\ntwo' })).toBe(true);
  });

  it('never marks a merge', () => {
    expect(isCandidate({ ...fix, isMerge: true })).toBe(false);
  });

  it('accepts perf with scope and breaking marker, rejects other types', () => {
    expect(isCandidate({ ...fix, subject: 'perf(x)!: faster scan' })).toBe(true);
    expect(isCandidate({ ...fix, subject: 'feat: new thing' })).toBe(false);
    expect(isCandidate({ ...fix, subject: 'stop the leak' })).toBe(false);
  });
});

describe('CommitBrowserView', () => {
  it('lights lamps from knowledge_list by repo name and the 7-char sha', async () => {
    const explained = commit(1);
    const otherRepo = commit(2);
    const candidate = commit(3, { subject: 'fix: guard', body: 'a\nb' });
    state.knowledge = {
      dir: '/k',
      docs: [
        { repo: 'repo', shortSha: explained.sha.slice(0, 7), path: '/k/repo-0000001.md' },
        { repo: 'other', shortSha: otherRepo.sha.slice(0, 7), path: '/k/other-0000002.md' },
      ],
    };
    const v = mount(page([explained, otherRepo, candidate]));
    await vi.waitFor(() => expect(row(v, explained).dataset.lamp).toBe('ready'));
    expect(row(v, otherRepo).dataset.lamp).toBe('none');
    expect(row(v, candidate).dataset.lamp).toBe('candidate');
  });

  it('filters by subject, author or sha prefix by hiding the same row nodes', async () => {
    const a = commit(1, { subject: 'fix: Socket timeout' });
    const b = commit(2, { author: 'Grace' });
    const c = commit(3);
    const v = mount(page([a, b, c]));
    await knowledgeLoaded();
    const before = rows(v);
    const input = v.element.querySelector<HTMLInputElement>('.commit-browser__filter-input')!;

    input.value = 'socket';
    input.dispatchEvent(new Event('input'));
    expect(before.map((r) => r.hidden)).toEqual([false, true, true]);

    input.value = 'grace';
    input.dispatchEvent(new Event('input'));
    expect(before.map((r) => r.hidden)).toEqual([true, false, true]);

    input.value = c.sha.slice(0, 7);
    input.dispatchEvent(new Event('input'));
    expect(before.map((r) => r.hidden)).toEqual([true, true, false]);
    expect(v.element.querySelector('.commit-browser__count')?.textContent).toBe('1/3');

    const after = rows(v);
    expect(after).toHaveLength(3);
    after.forEach((node, i) => expect(node).toBe(before[i]));
  });

  it('e queues a background job for the selected commit and lights pending, no Harness needed', async () => {
    const c = commit(1);
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    expect(explainer.started).toEqual([c.sha]);
    expect(row(v, c).dataset.lamp).toBe('pending');
    expect(v.element.querySelector('.commit-browser__status')?.textContent).toBe('queued');
    expect(strip(v).now).toBe('waiting for a free slot · next in line');
  });

  it('e on a row that is already explaining starts nothing new', async () => {
    const c = commit(1);
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    press(v, 'e');
    expect(explainer.started).toEqual([c.sha]);
    expect(notes).toEqual(['0000001 is already explaining — x cancel']);
  });

  it('shows a job that started before the browser opened', async () => {
    const c = commit(1);
    explainer.start('/repo', 'repo', c.sha);
    const v = mount(page([c]));
    expect(row(v, c).dataset.lamp).toBe('pending');
  });

  it('keeps the lamp window to the state word and shows the newest running step first, case kept', async () => {
    const c = commit(1);
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    const steps: ExplainStep[] = [
      { id: 'a', kind: 'read', subject: 'src/App.ts', state: 'done' },
      { id: 'b', kind: 'search', subject: 'rg -n Done src', state: 'failed' },
      { id: 'c', kind: 'read', subject: '~/.agents/skills/X/SKILL.md', state: 'running' },
      { id: 'd', kind: 'execute', subject: 'git show --stat', state: 'done' },
    ];
    running(explainer.jobs.get(c.sha)!, { steps, stepCount: 9 });

    expect(v.element.querySelector('.commit-browser__status')?.textContent).toBe('explaining');
    expect(strip(v)).toEqual({
      now: 'read ~/.agents/skills/X/SKILL.md',
      trail: ['execute git show --stat', 'search rg -n Done src', 'read src/App.ts'],
      meta: expect.stringMatching(/^codex · gpt-6\.1-sol\[high\] · since \d\d:\d\d · 9 steps$/),
    });
    const failed = v.element.querySelector('.commit-browser__step--failed .commit-browser__lamp');
    expect(failed?.classList.contains('commit-browser__lamp--fault')).toBe(true);
  });

  it('shows the phase on the now line while no tool runs', async () => {
    const c = commit(1);
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    running(explainer.jobs.get(c.sha)!, { phase: 'continuing', continuations: 1 });
    expect(strip(v).now).toBe('approval declined · continuing (1 of 3)');
  });

  it('repaints only the strip when a running job reports a step', async () => {
    const c = commit(1, { body: 'why it changed' });
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    const job = explainer.jobs.get(c.sha)!;
    running(job);
    const subject = v.element.querySelector('.commit-browser__preview-subject');
    const body = v.element.querySelector('.commit-browser__preview-body');

    job.steps = [{ id: 'a', kind: 'read', subject: 'src/App.ts', state: 'running' }];
    explainer.emit({ kind: 'update', job });

    expect(strip(v).now).toBe('read src/App.ts');
    expect(v.element.querySelector('.commit-browser__preview-subject')).toBe(subject);
    expect(v.element.querySelector('.commit-browser__preview-body')).toBe(body);
  });

  it('a ready job re-reads the index and turns the lamp green', async () => {
    const c = commit(1);
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    state.knowledge = { dir: '/k', docs: [{ repo: 'repo', shortSha: c.sha.slice(0, 7), path: '/k/repo-0000001.md' }] };
    explainer.settle(c.sha, { kind: 'ready', path: '/k/repo-0000001.md' });
    await vi.waitFor(() => expect(row(v, c).dataset.lamp).toBe('ready'));
  });

  it('a failed job turns the lamp back off', async () => {
    const c = commit(1);
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    explainer.settle(c.sha, { kind: 'failed', message: 'codex did not start' });
    expect(row(v, c).dataset.lamp).toBe('none');
  });

  it('x cancels the selected row\'s job', async () => {
    const c = commit(1);
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'x');
    press(v, 'e');
    press(v, 'x');
    expect(explainer.jobs.size).toBe(0);
    expect(row(v, c).dataset.lamp).toBe('none');
    expect(notes).toEqual(['No explainer running for 0000001', 'Cancelled explainer for 0000001']);
  });

  it('G at the end appends the next page when hasMore', async () => {
    const first = [commit(1), commit(2)];
    const next = [commit(3), commit(4)];
    state.pages = [page(next, false)];
    const v = mount(page(first, true));
    await knowledgeLoaded();
    press(v, 'G');
    expect(mocks.invoke).not.toHaveBeenCalledWith('git_log_page', expect.anything());
    press(v, 'G');
    await vi.waitFor(() => expect(rows(v)).toHaveLength(4));
    expect(mocks.invoke).toHaveBeenCalledWith('git_log_page', { cwd: '/repo', skip: 2, limit: 200 });
    expect(rows(v).map((r) => r.dataset.sha)).toEqual([...first, ...next].map((c) => c.sha));
  });

  it('G at the end does not load when there is no more history', async () => {
    const v = mount(page([commit(1), commit(2)], false));
    await knowledgeLoaded();
    press(v, 'G');
    press(v, 'G');
    await settle();
    expect(mocks.invoke).not.toHaveBeenCalledWith('git_log_page', expect.anything());
    expect(rows(v)).toHaveLength(2);
  });

  it('d opens the commit diff titled COMMIT // <sha7>', async () => {
    const c = commit(1);
    state.diff = 'diff --git a/x b/x\n';
    const v = mount(page([c]));
    const onOpenDiff = vi.fn();
    v.onOpenDiff(onOpenDiff);
    await knowledgeLoaded();
    press(v, 'd');
    await vi.waitFor(() => expect(onOpenDiff).toHaveBeenCalledWith('diff --git a/x b/x\n', 'COMMIT // 0000001'));
    expect(mocks.invoke).toHaveBeenCalledWith('git_commit_diff', { cwd: '/repo', sha: c.sha });
  });

  it('o opens a ready explainer and notifies on a row without one', async () => {
    const ready = commit(1);
    const none = commit(2);
    state.knowledge = { dir: '/k', docs: [{ repo: 'repo', shortSha: ready.sha.slice(0, 7), path: '/k/repo-0000001.md' }] };
    const v = mount(page([ready, none]));
    const onOpenKnowledge = vi.fn();
    v.onOpenKnowledge(onOpenKnowledge);
    await vi.waitFor(() => expect(row(v, ready).dataset.lamp).toBe('ready'));
    press(v, 'o');
    expect(onOpenKnowledge).toHaveBeenCalledWith('/k', '/k/repo-0000001.md');
    press(v, 'j');
    press(v, 'o');
    expect(onOpenKnowledge).toHaveBeenCalledTimes(1);
    expect(notes).toEqual(['No explainer for 0000002 yet — e explain']);
  });
});
