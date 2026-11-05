import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MermaidFence from '../../../acp/harness-mermaid-fence';
import { act, flush, press, render } from '../../kit/test-utils';
import type { Rendered } from '../../kit/test-utils';

import { E2ePage } from '.';
import tli1368 from './fixtures/d-tli-api-1368-rev5.json';

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
let view: Rendered | null = null;

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
  view = render(<E2ePage />, { shell: { surfaceId: 'e2e' } });
}

/** `vi.waitFor`, letting stubbed fetches settle and their renders commit inside `act` on every try. */
async function until(check: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await flush(1);
    check();
  });
}

/** Fake-timer advance whose renders commit inside `act`. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

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
  view?.unmount();
  view = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('e2e explorer', () => {
  it('lists every case with its latest verdict, recent verdicts and marks, as text', async () => {
    boot();
    await until(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
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
    await until(() => expect(requested('/run?case=a&run=r1')).toBe(true));
    await until(() => expect(runList()?.querySelector('[aria-selected="true"]')?.getAttribute('data-key')).toBe('r1'));
    press('j');
    await until(() => expect(requested('/run?case=b&run=r3')).toBe(true));
    expect(location.hash).toBe('#case=b&run=r3');
  });

  it('narrows the checks to failed and blocked ones with f', async () => {
    boot();
    await until(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
    press('f');
    expect(texts('.lb-e2e__check-label')).toEqual(['bad<img src=x onerror=alert(1)>']);
    press('f');
    expect(texts('.lb-e2e__check-label')).toHaveLength(3);
  });

  it('keeps the shown case and run until the next run arrives, then swaps both in one step', async () => {
    boot();
    await until(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
    const held = holdRuns();
    press('j');
    await until(() => expect(held).toHaveLength(1));
    // No empty or half-built frame while case b loads.
    expect(caseHeadId()).toBe('a');
    expect(texts('.lb-e2e__run .lb-e2e__check-label')).toHaveLength(3);
    expect(document.querySelector('.lb-e2e__run .lb-empty')).toBeNull();
    held[0]();
    await until(() => expect(caseHeadId()).toBe('b'));
    expect(document.querySelector('.lb-e2e__run .lb-e2e__run-id')?.textContent).toBe('r3');
    expect(runList()?.querySelector('[aria-selected="true"]')?.getAttribute('data-key')).toBe('r3');
  });

  it('shows the loading line only once a run is slow to arrive', async () => {
    vi.useFakeTimers();
    boot();
    await advance(0);
    expect(texts('.lb-e2e__check-label')).toHaveLength(3);
    const held = holdRuns();
    press('j');
    await advance(249);
    expect(caseHeadId()).toBe('a');
    expect(texts('.lb-e2e__run .lb-empty')).toEqual([]);
    await advance(1);
    expect(caseHeadId()).toBe('b');
    expect(texts('.lb-e2e__run .lb-empty')).toEqual(['loading run…']);
    held[0]();
    await advance(0);
    expect(document.querySelector('.lb-e2e__run .lb-e2e__run-id')?.textContent).toBe('r3');
  });

  it('tells the user to reopen the page when the link expired', async () => {
    respond = () => new Response('', { status: 404 });
    boot();
    await until(() => expect(texts('.lb-e2e__errors .lb-banner--error').join(' ')).toContain('#e2e open'));
  });

  it('only reads: every request it makes is a GET', async () => {
    boot();
    await until(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
    press('l');
    press('Tab');
    press('Tab');
    press('Enter');
    press('y');
    press('r');
    await until(() =>
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
    await advance(0);
    const statusLoads = (): number => calls.filter((call) => call.url.endsWith('/status')).length;
    expect(statusLoads()).toBe(1);
    await advance(2000);
    expect(calls.filter((call) => call.url.endsWith('/active'))).toHaveLength(1);
    expect(statusLoads()).toBe(1);
    active = null;
    await advance(2000);
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
    await until(() => expect(mapImg()).not.toBeNull());
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
    await until(() => expect(mapImg()).not.toBeNull());
    expect(requested('/run?case=a&run=r1')).toBe(true);
    expect(texts('.lb-e2e__pin-note:not(.lb-e2e__problem)')).toEqual(['PASS r1: ✓×1']);
    expect(mermaid.sources[mermaid.sources.length - 1]).toContain('P2 · g2<br/>✗×1<br/>PASS r1: ✓×1');
  });

  it('asks for no earlier run when the shown run passed', async () => {
    respond = mapResponder();
    boot('#case=a&run=r1');
    await until(() => expect(mapImg()).not.toBeNull());
    expect(calls.filter((call) => call.url.includes('/run?'))).toHaveLength(1);
    expect(texts('.lb-e2e__pin-note:not(.lb-e2e__problem)')).toEqual([]);
  });

  it('narrows the pin list to failures with f and keeps the picture whole', async () => {
    respond = mapResponder();
    boot();
    await until(() => expect(mapImg()).not.toBeNull());
    press('f');
    expect(mapImg()).not.toBeNull();
    expect(texts('.lb-e2e__pin-head strong')).toEqual(['P2']);
    expect(texts('.lb-e2e__pins .lb-e2e__check-label')).toEqual(['reachstatus 504']);
  });

  it('shows a broken map as an error in the run pane and falls back to the check list', async () => {
    respond = mapResponder(mapStatus({ map: null, errors: ['nodes[0].id: duplicate "x"'], warnings: [] }));
    boot();
    await until(() => expect(texts('.lb-e2e__run .lb-e2e__check-label')).toHaveLength(4));
    expect(texts('.lb-e2e__run .lb-banner--error')).toEqual(['map e2e/maps/a.toml: nodes[0].id: duplicate "x"']);
    expect(mapImg()).toBeNull();
    expect(mermaid.sources).toEqual([]);
  });
});

describe('check fields (spec 0328 rev 5)', () => {
  /** The served `evidence.json`: one call is in it, the upload is not. */
  const EVIDENCE_DOC = { evidence: { 'checkList/POS New': { status: 200, body: { scan_no: '20261103161034290' } } } };
  type FixtureCheck = Record<string, unknown>;

  function rev5Responder(checks: readonly FixtureCheck[] = tli1368.checks): (url: URL) => Response {
    const base = defaultResponder();
    return (url) => {
      if (url.pathname.endsWith('/run')) {
        return json({
          info: run('a', 'r2', 'PASS'),
          result: { checks },
          log: false,
          artifacts: [
            { label: 'report', path: 'e2e/reports/1368/x/report.md', size: 10, problem: null },
            { label: 'evidence', path: 'e2e/reports/1368/x/evidence.json', size: 10, problem: null },
          ],
        });
      }
      if (url.pathname.endsWith('/artifact')) {
        return url.searchParams.get('index') === '1' ? json(EVIDENCE_DOC) : new Response('# report', { status: 200 });
      }
      return base(url);
    };
  }

  const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.lb-e2e__run .lb-e2e__check'));
  /** The row's own label: the label span's first text node (the kind tag and the field lines are elements). */
  const labelOf = (row: Element): string | null =>
    Array.from(row.querySelector('.lb-e2e__check-label')?.childNodes ?? []).find((n) => n.nodeType === Node.TEXT_NODE)?.textContent ?? null;
  const rowOf = (label: string, nth = 0): HTMLElement | undefined => rows().filter((row) => labelOf(row) === label)[nth];
  const viewerText = (): string => document.querySelector('.lb-e2e__viewer .lb-e2e__viewer-text')?.textContent ?? '';

  async function bootRev5(checks?: readonly FixtureCheck[]): Promise<void> {
    respond = rev5Responder(checks);
    boot();
    await until(() => expect(rows()).toHaveLength((checks ?? tli1368.checks).length));
  }

  it('m lays the run out by step: preconditions, each call with the checks about it, then the rest', async () => {
    await bootRev5();
    expect(document.querySelector('.lb-e2e__step')).toBeNull();
    press('m');
    expect(texts('.lb-e2e__checks > .lb-e2e__group > .lb-e2e__group-name')).toEqual(['Preconditions', 'Other checks']);
    expect(document.querySelectorAll('.lb-e2e__checks > .lb-e2e__group')[0].querySelectorAll('.lb-e2e__check')).toHaveLength(7);
    const steps = Array.from(document.querySelectorAll('.lb-e2e__step'));
    // checkList and upload set the job up and have no checks of their own; each getWIPDocuments call carries its own.
    expect(steps.map((step) => step.querySelectorAll('.lb-e2e__check').length)).toEqual([1, 1, 10, 4, 3]);
    expect(steps.map((step) => step.querySelector('.lb-e2e__check--head .lb-e2e__check-target')?.textContent)).toEqual([
      'http · POST /tli-online/checkList/POS',
      'http · POST /tli-online/uploadNewDocument/POS',
      'http · POST /tli/getWIPDocuments/POS',
      'http · POST /tli/getWIPDocuments/POS',
      'http · POST /tli/getWIPDocuments/POS',
    ]);
    expect(Array.from(steps[3].querySelectorAll('.lb-e2e__check-target'), (n) => n.textContent)).toEqual([
      'http · POST /tli/getWIPDocuments/POS',
      'http · POST /tli/getWIPDocuments/POS',
      'db · dim.tr_log',
    ]);
    // A step row repeats no "← step" link inside its own block.
    expect(document.querySelector('.lb-e2e__step .lb-e2e__check-link')).toBeNull();
    press('m');
    expect(document.querySelector('.lb-e2e__step')).toBeNull();
  });

  it('shows what each row called, sent and saw, and names its step in the group layout', async () => {
    await bootRev5();
    const call = rowOf('CE date: tli-api answered');
    expect(call?.querySelector('.lb-e2e__check-kind')?.textContent).toBe('step');
    expect(call?.querySelector('.lb-e2e__check-params')?.textContent).toBe(
      'po_request_date=20261103 · po_tr_type=CJ · policy_no=83697031 · user_name=9003684',
    );
    expect(call?.querySelector('.lb-e2e__check-evidence')?.textContent).toBe('evidence: evidence /evidence/getWIPDocuments~1POS CE date (20261103)');
    const status = rowOf('HTTP status', 1);
    expect(status?.querySelector('.lb-e2e__check-kind')?.textContent).toBe('expect');
    expect(status?.querySelector('.lb-e2e__check-link')?.textContent).toBe('← CE date: tli-api answered');
    expect(Array.from(status?.querySelectorAll('.lb-e2e__check-value') ?? [], (n) => n.textContent)).toEqual(['expected 204', 'actual 204']);
    // A row without the fields reads exactly as before.
    const note = rowOf('tli-api image');
    expect(note?.querySelector('.lb-e2e__check-label')?.textContent).toBe('tli-api imagereg.bcecm.com/tli/tli-api:fast-7f662dba');
  });

  it('f keeps a failing check with its step head, and colours the actual value', async () => {
    const checks = tli1368.checks.map((check, index) =>
      index === tli1368.checks.findIndex((c) => c.label === 'HTTP status' && c.step === 'call-ce') ? { ...check, status: 'fail', actual: '200' } : check,
    );
    await bootRev5(checks);
    press('m');
    press('f');
    const steps = Array.from(document.querySelectorAll('.lb-e2e__step'));
    expect(steps).toHaveLength(1);
    expect(Array.from(steps[0].querySelectorAll('.lb-e2e__check'), labelOf)).toEqual([
      'CE date: tli-api answered',
      'HTTP status',
    ]);
    expect(steps[0].querySelector('.lb-e2e__check-value--fail')?.textContent).toBe('actual 200');
    expect(texts('.lb-e2e__checks .lb-e2e__group-name')).toEqual([]);
  });

  it('walks the rows with evidence in a checks pane and opens each at its pointer', async () => {
    await bootRev5();
    press('Tab');
    press('Tab');
    expect(document.querySelector('.lb-e2e__run')?.classList.contains('lb-e2e__run--checks')).toBe(true);
    expect(document.querySelector('.lb-e2e__check--cursor')?.textContent).toContain('checkList/POS New');
    press('Enter');
    await until(() => expect(viewerText()).toBe(JSON.stringify(EVIDENCE_DOC.evidence['checkList/POS New'], null, 2)));
    expect(document.querySelector('.lb-e2e__viewer-head')?.textContent).toContain('evidence · e2e/reports/1368/x/evidence.json · /evidence/checkList~1POS New');
    expect(requested('/artifact?case=a&run=r2&index=1')).toBe(true);
    press('j');
    expect(document.querySelector('.lb-e2e__check--cursor')?.textContent).toContain('uploadNewDocument/POS');
    press('Enter');
    await until(() => expect(viewerText()).toBe(JSON.stringify(EVIDENCE_DOC)));
    expect(texts('.lb-e2e__viewer .lb-banner--info')).toEqual(['pointer /evidence/uploadNewDocument~1POS not found — whole file']);
    press('Escape');
    expect(document.querySelector<HTMLElement>('.lb-e2e__viewer')?.hidden).toBe(true);
  });

  it('opens a non-JSON artifact whole under a note, and flags links and evidence that point nowhere', async () => {
    await bootRev5([
      { kind: 'step', step: 'call', label: 'call', status: 'pass', evidence: { artifact: 'report', pointer: '/x' } },
      { kind: 'expect', step: 'nope', label: 'orphan', status: 'pass', evidence: { artifact: 'missing' } },
    ]);
    expect(texts('.lb-e2e__run .lb-e2e__problem')).toEqual([' — no artifact "missing"', 'no step "nope"']);
    press('Tab');
    press('Tab');
    press('Enter');
    await until(() => expect(viewerText()).toBe('# report'));
    expect(texts('.lb-e2e__viewer .lb-banner--info')).toEqual(['pointer /x not found — whole file']);
    press('j');
    press('Enter');
    expect(texts('.lb-banner--error')).toContain('no artifact "missing"');
  });

  it('offers no step layout or checks pane for a run without the fields', async () => {
    boot();
    await until(() => expect(texts('.lb-e2e__check-label')).toHaveLength(3));
    expect(document.querySelector('.lb-e2e__toolbar')?.textContent).not.toContain('view:');
    press('m');
    expect(document.querySelector('.lb-e2e__step')).toBeNull();
    press('Tab');
    press('Tab');
    expect(document.querySelector('.lb-e2e__run')?.classList.contains('lb-e2e__run--checks')).toBe(false);
  });
});
