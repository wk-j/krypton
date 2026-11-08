// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

interface FakeLane {
  laneId: string;
  displayName: string;
  backendId: string;
  status: string;
}

interface FakeHarness {
  harnessId: string;
  cwd: string | null;
  workspaceKey?: string;
  alive: boolean;
  lanes: FakeLane[];
  listLanes(): FakeLane[];
  control: Mock;
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  harnesses: [] as FakeHarness[],
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./acp/harness-directory', () => ({
  listHarnessEntries: () => mocks.harnesses,
  harnessEntry: (id: string) => mocks.harnesses.find((h) => h.harnessId === id) ?? null,
}));

import {
  CommitBrowserView,
  NOTIFY_EXPLAINER_READY,
  NOTIFY_NO_IDLE_LANE,
  NOTIFY_OPEN_HARNESS,
  isCandidate,
  type CommitSummary,
  type GitLogPage,
  type KnowledgeIndex,
} from './commit-browser-view';

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

function harness(id: string, cwd: string, lanes: Array<[string, string]>, workspaceKey?: string): FakeHarness {
  const fake: FakeHarness = {
    harnessId: id,
    cwd,
    workspaceKey,
    alive: true,
    lanes: lanes.map(([displayName, status], i) => ({ laneId: `${id}-${i}`, displayName, backendId: 'claude', status })),
    listLanes: () => fake.lanes,
    control: vi.fn(),
  };
  return fake;
}

const state: { knowledge: KnowledgeIndex; pages: GitLogPage[]; diff: string } = {
  knowledge: { dir: '/k', docs: [] },
  pages: [],
  diff: '',
};

let view: CommitBrowserView | null = null;
let notes: string[] = [];

function mount(first: GitLogPage): CommitBrowserView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  view = new CommitBrowserView(first, container);
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

beforeEach(() => {
  notes = [];
  state.knowledge = { dir: '/k', docs: [] };
  state.pages = [];
  state.diff = '';
  mocks.harnesses = [];
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

  it('e with no local Harness in the repo asks to open one', async () => {
    mocks.harnesses = [
      harness('hm-1', '/repo2', [['claude-1', 'idle']]),
      harness('hm-2', '/repo', [['claude-2', 'idle']], 'ssh:me@host:22:/repo'),
    ];
    const v = mount(page([commit(1)]));
    await knowledgeLoaded();
    press(v, 'e');
    expect(notes).toEqual([NOTIFY_OPEN_HARNESS]);
    expect(mocks.harnesses[0].control).not.toHaveBeenCalled();
    expect(mocks.harnesses[1].control).not.toHaveBeenCalled();
  });

  it('e with a Harness but no idle lane says so', async () => {
    mocks.harnesses = [harness('hm-1', '/repo', [['claude-1', 'busy']])];
    const v = mount(page([commit(1)]));
    await knowledgeLoaded();
    press(v, 'e');
    expect(notes).toEqual([NOTIFY_NO_IDLE_LANE]);
  });

  it('e with one idle lane sends lane.learn directly and lights pending', async () => {
    const c = commit(1);
    const h = harness('hm-1', '/repo/sub', [['claude-1', 'idle'], ['claude-2', 'busy']], 'local:/repo/sub');
    h.control.mockResolvedValue({ status: 'started', lane: 'claude-1', path: '/k/repo-0000001.md' });
    mocks.harnesses = [h];
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    expect(h.control).toHaveBeenCalledWith('lane.learn', { lane: 'claude-1', sha: c.sha }, { source: 'commit_browser' });
    await vi.waitFor(() => expect(row(v, c).dataset.lamp).toBe('pending'));
    expect(v.element.querySelector('.commit-browser__picker')?.hasAttribute('hidden')).toBe(true);
  });

  it('e with two idle lanes opens the picker and Enter sends the selected lane', async () => {
    const c = commit(1);
    const h = harness('hm-1', '/repo', [['claude-1', 'idle'], ['codex-1', 'idle']]);
    h.control.mockResolvedValue({ status: 'started', lane: 'codex-1', path: '/k/repo-0000001.md' });
    mocks.harnesses = [h];
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    const picker = v.element.querySelector<HTMLElement>('.commit-browser__picker')!;
    expect(picker.hidden).toBe(false);
    expect(h.control).not.toHaveBeenCalled();
    press(v, 'j');
    press(v, 'Enter');
    expect(picker.hidden).toBe(true);
    expect(h.control).toHaveBeenCalledTimes(1);
    expect(h.control).toHaveBeenCalledWith('lane.learn', { lane: 'codex-1', sha: c.sha }, { source: 'commit_browser' });
  });

  it('a control error notifies its message and leaves the lamp unlit', async () => {
    const c = commit(1);
    const h = harness('hm-1', '/repo', [['claude-1', 'idle']]);
    h.control.mockRejectedValue(Object.assign(new Error('claude-1 is busy'), { code: 'lane_busy' }));
    mocks.harnesses = [h];
    const v = mount(page([c]));
    await knowledgeLoaded();
    press(v, 'e');
    await vi.waitFor(() => expect(notes).toEqual(['claude-1 is busy']));
    expect(row(v, c).dataset.lamp).toBe('none');
  });

  describe('onHarnessLaneIdle', () => {
    async function pendingView(): Promise<{ v: CommitBrowserView; c: CommitSummary; h: FakeHarness }> {
      const c = commit(1);
      const h = harness('hm-1', '/repo', [['claude-1', 'idle']]);
      h.control.mockImplementation(async () => {
        h.lanes[0].status = 'busy';
        return { status: 'started', lane: 'claude-1', path: '/k/repo-0000001.md' };
      });
      mocks.harnesses = [h];
      const v = mount(page([c]));
      await knowledgeLoaded();
      press(v, 'e');
      await vi.waitFor(() => expect(row(v, c).dataset.lamp).toBe('pending'));
      return { v, c, h };
    }

    it('turns pending into ready when its lane is idle and the doc exists', async () => {
      const { v, c, h } = await pendingView();
      state.knowledge = { dir: '/k', docs: [{ repo: 'repo', shortSha: c.sha.slice(0, 7), path: '/k/repo-0000001.md' }] };
      h.lanes[0].status = 'idle';
      void v.onHarnessLaneIdle();
      await vi.waitFor(() => expect(row(v, c).dataset.lamp).toBe('ready'));
      expect(notes).toEqual([NOTIFY_EXPLAINER_READY]);
    });

    it('keeps pending while its lane still works, even when the doc already exists', async () => {
      // A regenerate overwrites an existing doc; another lane's idle signal must
      // not report it ready while the explaining lane is still writing.
      const { v, c } = await pendingView();
      state.knowledge = { dir: '/k', docs: [{ repo: 'repo', shortSha: c.sha.slice(0, 7), path: '/k/repo-0000001.md' }] };
      const calls = mocks.invoke.mock.calls.length;
      void v.onHarnessLaneIdle();
      await vi.waitFor(() => expect(mocks.invoke.mock.calls.length).toBe(calls + 1));
      await settle();
      expect(row(v, c).dataset.lamp).toBe('pending');
      expect(notes).toEqual([]);
    });

    it('turns pending into none when the lane went idle without a doc', async () => {
      const { v, c, h } = await pendingView();
      h.lanes[0].status = 'idle';
      void v.onHarnessLaneIdle();
      await vi.waitFor(() => expect(row(v, c).dataset.lamp).toBe('none'));
      expect(notes).toEqual(['claude-1 finished without writing repo-0000001.md']);
    });

    it('keeps pending while the lane is still busy', async () => {
      const { v, c } = await pendingView();
      const calls = mocks.invoke.mock.calls.length;
      void v.onHarnessLaneIdle();
      await vi.waitFor(() => expect(mocks.invoke.mock.calls.length).toBe(calls + 1));
      await settle();
      expect(row(v, c).dataset.lamp).toBe('pending');
      expect(notes).toEqual([]);
    });
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
