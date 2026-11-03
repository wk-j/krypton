import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MermaidFence from '../../../acp/harness-mermaid-fence';

import { E2eView } from '.';

// Spec 329: the explorer against a mocked loopback API. Spec 355: the system
// map, with mermaid replaced by a recorder (map.test.ts covers the source).

const mermaid = vi.hoisted(() => ({ sources: [] as string[] }));
vi.mock('../../../acp/harness-mermaid-fence', async (importOriginal) => ({
  ...(await importOriginal<typeof MermaidFence>()),
  renderMermaid: async (source: string): Promise<{ ok: true; svg: string; diagramType: string }> => {
    mermaid.sources.push(source);
    return { ok: true, svg: '<svg viewBox="0 0 10 10"></svg>', diagramType: 'flowchart' };
  },
}));

interface Call {
  url: string;
  init?: RequestInit;
}

const run = (caseId: string, runId: string, verdict: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  caseId,
  code: null,
  runId,
  origin: 'krypton',
  launchId: `L-${runId}`,
  verdict,
  startedAt: '2026-10-24T01:00:00Z',
  finishedAt: '2026-10-24T01:00:05Z',
  counts: { pass: 1, fail: 1, skip: 0, blocked: 0, info: 1 },
  failed: [],
  versions: {},
  params: {},
  git: null,
  caseHash: 'h1',
  exitCode: 0,
  resultPath: null,
  logPath: null,
  message: null,
  argv: null,
  ...extra,
});

function statusFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectName: 'krypton',
    initialized: true,
    manifest: { name: 'Krypton e2e', history: true, issueLabel: null, createPrompt: null, reportPrompt: null },
    errors: [],
    issues: null,
    issuesError: null,
    activeLaunch: null,
    cases: [
      { id: 'a', title: '<b>bold</b> title', code: 'S1', issue: null, params: {}, fresh: {}, files: ['e2e/cases/a.ts'], caseHash: 'h2', uncommitted: true },
      { id: 'b', title: 'B', code: null, issue: null, params: {}, fresh: {}, files: [], caseHash: null, uncommitted: false },
    ],
    runs: [run('a', 'r2', 'FAIL'), run('a', 'r1', 'PASS'), run('b', 'r3', 'BLOCKED')],
    ...overrides,
  };
}

const detailFixture = (caseId: string, runId: string): Record<string, unknown> => ({
  info: run(caseId, runId, 'FAIL'),
  result: {
    checks: [
      { group: 'g1', label: 'ok', status: 'pass' },
      { group: 'g1', label: 'bad', status: 'fail', detail: '<img src=x onerror=alert(1)>' },
      { label: 'note', status: 'info' },
    ],
  },
  log: true,
  artifacts: [{ label: 'resp', path: 'e2e/runs/x.json', size: 10, problem: null }],
});

let calls: Call[] = [];
let respond: (url: URL) => Response | Promise<Response>;
let view: E2eView | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function defaultResponder(status = statusFixture()): (url: URL) => Response {
  return (url) => {
    if (url.pathname.endsWith('/status')) return json(status);
    if (url.pathname.endsWith('/run')) return json(detailFixture(url.searchParams.get('case') ?? '', url.searchParams.get('run') ?? ''));
    if (url.pathname.endsWith('/active')) return json({ activeLaunch: null });
    return new Response('text body', { status: 200 });
  };
}

function boot(hash = ''): void {
  history.replaceState(null, '', `/e2e/tok${hash}`);
  view = new E2eView({ token: 'tok' });
  document.body.replaceChildren(view.el);
}

const press = (key: string, shiftKey = false): void => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
};
const texts = (selector: string): string[] => Array.from(document.querySelectorAll(selector), (node) => node.textContent ?? '');
const requested = (fragment: string): boolean => calls.some((call) => call.url.includes(fragment));
const caseHeadId = (): string | null | undefined => document.querySelector('.lb-e2e__case-head dd')?.textContent;
const runList = (): Element | null => document.querySelector('[aria-label="Runs of the selected case"]');

/** Hold every `/run` answer until the test releases it; other routes answer at once. */
function holdRuns(): Array<() => void> {
  const held: Array<() => void> = [];
  const base = respond;
  // The tsconfig lib predates `Promise.withResolvers`.
  respond = (url) =>
    url.pathname.endsWith('/run') ? new Promise((resolve) => held.push(() => resolve(base(url)))) : base(url);
  return held;
}

beforeEach(() => {
  calls = [];
  respond = defaultResponder();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init });
      return respond(new URL(input, 'http://127.0.0.1:8765'));
    }),
  );
});

afterEach(() => {
  view?.dispose();
  view = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('e2e explorer', () => {
  it('lists every case with its latest verdict, recent verdicts and marks, as text', async () => {
    boot();
    await vi.waitFor(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
    expect(texts('.lb-e2e__cases .lb-e2e__case-id')).toEqual(['a', 'b']);
    const first = document.querySelector('.lb-e2e__cases .lb-roster__item');
    expect(first?.querySelector('.lb-pill')?.textContent).toBe('FAIL');
    expect(first?.querySelector('.lb-e2e__strip')?.textContent).toBe('FP');
    expect(Array.from(first?.querySelectorAll('.lb-e2e__mark') ?? [], (n) => n.textContent)).toEqual(['uncommitted', 'edited']);
    expect(first?.querySelector('.lb-e2e__case-title')?.textContent).toBe('<b>bold</b> title');
    // Project text never becomes markup.
    expect(document.querySelector('.lb-e2e__cases b')).toBeNull();
    expect(document.querySelector('.lb-e2e__run img')).toBeNull();
    // The newest run of the first case is loaded.
    expect(requested('/e2e/api/tok/run?case=a&run=r2')).toBe(true);
  });

  it('opens the case and run named in the URL and keeps the URL in sync', async () => {
    boot('#case=a&run=r1');
    await vi.waitFor(() => expect(requested('/run?case=a&run=r1')).toBe(true));
    await vi.waitFor(() => expect(runList()?.querySelector('[aria-selected="true"]')?.getAttribute('data-key')).toBe('r1'));
    press('j');
    await vi.waitFor(() => expect(requested('/run?case=b&run=r3')).toBe(true));
    expect(location.hash).toBe('#case=b&run=r3');
  });

  it('narrows the checks to failed and blocked ones with f', async () => {
    boot();
    await vi.waitFor(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
    press('f');
    expect(texts('.lb-e2e__check-label')).toEqual(['bad<img src=x onerror=alert(1)>']);
    press('f');
    expect(texts('.lb-e2e__check-label')).toHaveLength(3);
  });

  it('keeps the shown case and run until the next run arrives, then swaps both in one step', async () => {
    boot();
    await vi.waitFor(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
    const held = holdRuns();
    press('j');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // No empty or half-built frame while case b loads.
    expect(caseHeadId()).toBe('a');
    expect(texts('.lb-e2e__run .lb-e2e__check-label')).toHaveLength(3);
    expect(document.querySelector('.lb-e2e__run .lb-empty')).toBeNull();
    held[0]();
    await vi.waitFor(() => expect(caseHeadId()).toBe('b'));
    expect(document.querySelector('.lb-e2e__run .lb-e2e__run-id')?.textContent).toBe('r3');
    expect(runList()?.querySelector('[aria-selected="true"]')?.getAttribute('data-key')).toBe('r3');
  });

  it('shows the loading line only once a run is slow to arrive', async () => {
    vi.useFakeTimers();
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts('.lb-e2e__check-label')).toHaveLength(3);
    const held = holdRuns();
    press('j');
    await vi.advanceTimersByTimeAsync(249);
    expect(caseHeadId()).toBe('a');
    expect(texts('.lb-e2e__run .lb-empty')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(caseHeadId()).toBe('b');
    expect(texts('.lb-e2e__run .lb-empty')).toEqual(['loading run…']);
    held[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.lb-e2e__run .lb-e2e__run-id')?.textContent).toBe('r3');
  });

  it('tells the user to reopen the page when the link expired', async () => {
    respond = () => new Response('', { status: 404 });
    boot();
    await vi.waitFor(() => expect(texts('.lb-e2e__errors .lb-banner--error').join(' ')).toContain('#e2e open'));
  });

  it('only reads: every request it makes is a GET', async () => {
    boot();
    await vi.waitFor(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
    press('l');
    press('Tab');
    press('Tab');
    press('Enter');
    press('y');
    press('r');
    await vi.waitFor(() =>
      expect(requested('/log?launch=L-r2') && requested('/artifact?case=a&run=r2&index=0')).toBe(true),
    );
    for (const call of calls) expect(call.init?.method ?? 'GET', call.url).toBe('GET');
  });

  it('polls only the cheap active endpoint during a run and reloads once it ends', async () => {
    vi.useFakeTimers();
    let active: unknown = { launchId: 'L9', caseId: 'a', startedAt: '2026-10-24T01:00:00Z' };
    const base = defaultResponder(statusFixture({ activeLaunch: active }));
    respond = (url) => (url.pathname.endsWith('/active') ? json({ activeLaunch: active }) : base(url));
    boot();
    await vi.advanceTimersByTimeAsync(0);
    const statusLoads = (): number => calls.filter((call) => call.url.endsWith('/status')).length;
    expect(statusLoads()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.filter((call) => call.url.endsWith('/active'))).toHaveLength(1);
    expect(statusLoads()).toBe(1);
    active = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusLoads()).toBe(2);
  });
});

describe('system map (spec 355)', () => {
  const MAP_PATH = 'e2e/maps/a.toml';
  const smallMap = {
    direction: 'LR',
    groups: [],
    nodes: [
      { id: 'who', label: 'caller', group: null, shape: 'actor', source: null },
      { id: 'api', label: 'API\nhandler', group: null, shape: 'box', source: 'src/api.ts' },
    ],
    edges: [{ from: 'who', to: 'api', label: null, kind: 'flow' }],
  };

  function mapStatus(entry: unknown = { map: smallMap, errors: [], warnings: [] }): Record<string, unknown> {
    const base = statusFixture();
    const cases = (base.cases as Array<Record<string, unknown>>).map((c) => (c.id === 'a' ? { ...c, map: MAP_PATH } : c));
    return { ...base, cases, maps: { [MAP_PATH]: entry } };
  }

  /** r2 FAILs on g2; r1 is the earlier PASS. */
  const mapDetail = (caseId: string, runId: string): Record<string, unknown> => {
    const failing = runId === 'r2';
    return {
      info: run(caseId, runId, failing ? 'FAIL' : 'PASS'),
      result: {
        checks: [
          { group: 'g1', label: 'ok', status: 'pass', at: 'api' },
          { group: 'g2', label: 'reach', status: failing ? 'fail' : 'pass', detail: 'status 504', at: 'api' },
          { label: 'note', status: 'info' },
          { group: 'g1', label: 'lost', status: 'pass', at: 'gone' },
        ],
      },
      log: true,
      artifacts: [],
    };
  };

  function mapResponder(status: Record<string, unknown> = mapStatus()): (url: URL) => Response {
    const base = defaultResponder(status);
    return (url) =>
      url.pathname.endsWith('/run')
        ? json(mapDetail(url.searchParams.get('case') ?? '', url.searchParams.get('run') ?? ''))
        : base(url);
  }

  const mapImg = (): Element | null => document.querySelector('.lb-e2e__run .lb-e2e__map-img');

  beforeEach(() => {
    mermaid.sources = [];
  });

  it('draws the run on its case map by default, lists checks per pin, and m toggles the check list', async () => {
    respond = mapResponder();
    boot();
    await vi.waitFor(() => expect(mapImg()).not.toBeNull());
    expect(mapImg()?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(texts('.lb-e2e__pin-head strong')).toEqual(['P1', 'P2', 'not on the map']);
    expect(texts('.lb-e2e__pin-head')[0]).toContain('API handler');
    expect(texts('.lb-e2e__pin-head .lb-e2e__pin-source')).toEqual(['src/api.ts', 'src/api.ts']);
    expect(texts('.lb-e2e__pin-note.lb-e2e__problem')).toEqual(['"gone" is not a node of the map']);
    press('m');
    expect(mapImg()).toBeNull();
    expect(texts('.lb-e2e__group-name')).toEqual(['g1', 'g2']);
    press('m');
    expect(mapImg()).not.toBeNull();
  });

  it('loads the newest earlier PASS for a failing run and marks only the pin that changed', async () => {
    respond = mapResponder();
    boot();
    await vi.waitFor(() => expect(mapImg()).not.toBeNull());
    expect(requested('/run?case=a&run=r1')).toBe(true);
    expect(texts('.lb-e2e__pin-note:not(.lb-e2e__problem)')).toEqual(['PASS r1: ✓×1']);
    expect(mermaid.sources[mermaid.sources.length - 1]).toContain('P2 · g2<br/>✗×1<br/>PASS r1: ✓×1');
  });

  it('asks for no earlier run when the shown run passed', async () => {
    respond = mapResponder();
    boot('#case=a&run=r1');
    await vi.waitFor(() => expect(mapImg()).not.toBeNull());
    expect(calls.filter((call) => call.url.includes('/run?'))).toHaveLength(1);
    expect(texts('.lb-e2e__pin-note:not(.lb-e2e__problem)')).toEqual([]);
  });

  it('narrows the pin list to failures with f and keeps the picture whole', async () => {
    respond = mapResponder();
    boot();
    await vi.waitFor(() => expect(mapImg()).not.toBeNull());
    press('f');
    expect(mapImg()).not.toBeNull();
    expect(texts('.lb-e2e__pin-head strong')).toEqual(['P2']);
    expect(texts('.lb-e2e__pins .lb-e2e__check-label')).toEqual(['reachstatus 504']);
  });

  it('shows a broken map as an error in the run pane and falls back to the check list', async () => {
    respond = mapResponder(mapStatus({ map: null, errors: ['nodes[0].id: duplicate "x"'], warnings: [] }));
    boot();
    await vi.waitFor(() => expect(texts('.lb-e2e__run .lb-e2e__check-label')).toHaveLength(4));
    expect(texts('.lb-e2e__run .lb-banner--error')).toEqual(['map e2e/maps/a.toml: nodes[0].id: duplicate "x"']);
    expect(mapImg()).toBeNull();
    expect(mermaid.sources).toEqual([]);
  });
});
