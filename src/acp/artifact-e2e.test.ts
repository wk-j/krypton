// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spec 329: run the real page script against a mocked loopback API.
const html = readFileSync(join(__dirname, 'artifact-e2e.html'), 'utf8');
const markup = /<body>([\s\S]*?)<script>/.exec(html)?.[1] ?? '';
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

interface Call { url: string; init?: RequestInit }

const run = (caseId: string, runId: string, verdict: string, extra: Record<string, unknown> = {}) => ({
  caseId, code: null, runId, origin: 'krypton', launchId: `L-${runId}`, verdict,
  startedAt: '2026-10-24T01:00:00Z', finishedAt: '2026-10-24T01:00:05Z',
  counts: { pass: 1, fail: 1, skip: 0, blocked: 0, info: 1 }, failed: [], versions: {}, params: {},
  git: null, caseHash: 'h1', exitCode: 0, resultPath: null, logPath: null, message: null, argv: null,
  ...extra,
});

function statusFixture(overrides: Record<string, unknown> = {}) {
  return {
    projectName: 'krypton', initialized: true,
    manifest: { name: 'Krypton e2e', history: true, issueLabel: null, createPrompt: null, reportPrompt: null },
    errors: [], issues: null, issuesError: null, activeLaunch: null,
    cases: [
      { id: 'a', title: '<b>bold</b> title', code: 'S1', issue: null, params: {}, fresh: {}, files: ['e2e/cases/a.ts'], caseHash: 'h2', uncommitted: true },
      { id: 'b', title: 'B', code: null, issue: null, params: {}, fresh: {}, files: [], caseHash: null, uncommitted: false },
    ],
    runs: [run('a', 'r2', 'FAIL'), run('a', 'r1', 'PASS'), run('b', 'r3', 'BLOCKED')],
    ...overrides,
  };
}

const detailFixture = (caseId: string, runId: string) => ({
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
const cleanups: Array<() => void> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function defaultResponder(status = statusFixture()) {
  return (url: URL): Response => {
    if (url.pathname.endsWith('/status')) return json(status);
    if (url.pathname.endsWith('/run')) return json(detailFixture(url.searchParams.get('case') ?? '', url.searchParams.get('run') ?? ''));
    if (url.pathname.endsWith('/active')) return json({ activeLaunch: null });
    return new Response('text body', { status: 200 });
  };
}

/** Listeners the page adds, so each test starts with a page of its own. */
function track(target: Document | Window): void {
  const add = target.addEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    cleanups.push(() => target.removeEventListener(type, listener, options));
    add(type, listener, options);
  });
}

function boot(hash = ''): void {
  history.replaceState(null, '', `/e2e/tok${hash}`);
  document.body.innerHTML = markup;
  new Function(script)();
}

const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
const texts = (selector: string) => Array.from(document.querySelectorAll(selector), (node) => node.textContent ?? '');
const requested = (fragment: string) => calls.some((call) => call.url.includes(fragment));
const caseHeadId = () => document.querySelector('#case-head dd')?.textContent;

/** Hold every `/run` answer until the test releases it; other routes answer at once. */
function holdRuns(): Array<() => void> {
  const held: Array<() => void> = [];
  const base = respond;
  respond = (url) => (url.pathname.endsWith('/run')
    ? new Promise((resolve) => { held.push(() => resolve(base(url))); })
    : base(url));
  return held;
}

beforeEach(() => {
  calls = [];
  respond = defaultResponder();
  track(document);
  track(window);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    return respond(new URL(input, 'http://127.0.0.1:8765'));
  }));
});

afterEach(() => {
  cleanups.splice(0).forEach((remove) => remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('e2e explorer page', () => {
  it('lists every case with its latest verdict, recent verdicts and marks, as text', async () => {
    boot();
    await vi.waitFor(() => expect(texts('.check-label')).toHaveLength(3));
    expect(texts('#case-list .case-id')).toEqual(['a', 'b']);
    const first = document.querySelector('#case-list .item');
    expect(first?.querySelector('.pill')?.textContent).toBe('FAIL');
    expect(first?.querySelector('.strip')?.textContent).toBe('FP');
    expect(texts('#case-list .item:first-child .mark')).toEqual(['uncommitted', 'edited']);
    expect(first?.querySelector('.case-title')?.textContent).toBe('<b>bold</b> title');
    // Project text never becomes markup.
    expect(document.querySelector('#case-list b')).toBeNull();
    expect(document.querySelector('#pane-run img')).toBeNull();
    // The newest run of the first case is loaded.
    expect(requested('/e2e/api/tok/run?case=a&run=r2')).toBe(true);
  });

  it('opens the case and run named in the URL and keeps the URL in sync', async () => {
    boot('#case=a&run=r1');
    await vi.waitFor(() => expect(requested('/run?case=a&run=r1')).toBe(true));
    expect(document.querySelector('#run-list [aria-selected="true"]')?.getAttribute('data-run-id')).toBe('r1');
    press('j');
    await vi.waitFor(() => expect(requested('/run?case=b&run=r3')).toBe(true));
    expect(location.hash).toBe('#case=b&run=r3');
  });

  it('narrows the checks to failed and blocked ones with f', async () => {
    boot();
    await vi.waitFor(() => expect(texts('.check-label')).toHaveLength(3));
    press('f');
    expect(texts('.check-label')).toEqual(['bad<img src=x onerror=alert(1)>']);
    press('f');
    expect(texts('.check-label')).toHaveLength(3);
  });

  it('keeps the shown case and run until the next run arrives, then swaps both in one step', async () => {
    boot();
    await vi.waitFor(() => expect(texts('.check-label')).toHaveLength(3));
    const held = holdRuns();
    press('j');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // No empty or half-built frame while case b loads.
    expect(caseHeadId()).toBe('a');
    expect(texts('#pane-run .check-label')).toHaveLength(3);
    expect(document.querySelector('#pane-run .empty')).toBeNull();
    held[0]();
    await vi.waitFor(() => expect(caseHeadId()).toBe('b'));
    expect(document.querySelector('#pane-run .case-id')?.textContent).toBe('r3');
    expect(document.querySelector('#run-list [aria-selected="true"]')?.getAttribute('data-run-id')).toBe('r3');
  });

  it('shows the loading line only once a run is slow to arrive', async () => {
    vi.useFakeTimers();
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts('.check-label')).toHaveLength(3);
    const held = holdRuns();
    press('j');
    await vi.advanceTimersByTimeAsync(249);
    expect(caseHeadId()).toBe('a');
    expect(texts('#pane-run .empty')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(caseHeadId()).toBe('b');
    expect(texts('#pane-run .empty')).toEqual(['loading run…']);
    held[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('#pane-run .case-id')?.textContent).toBe('r3');
  });

  it('tells the user to reopen the page when the link expired', async () => {
    respond = () => new Response('', { status: 404 });
    boot();
    await vi.waitFor(() => expect(texts('#errors .chip').join(' ')).toContain('#e2e open'));
  });

  it('only reads: every request it makes is a GET', async () => {
    boot();
    await vi.waitFor(() => expect(texts('.check-label')).toHaveLength(3));
    press('l');
    press('Tab');
    press('Tab');
    press('Enter');
    press('y');
    press('r');
    await vi.waitFor(() => expect(requested('/log?launch=L-r2') && requested('/artifact?case=a&run=r2&index=0')).toBe(true));
    for (const call of calls) expect(call.init?.method ?? 'GET', call.url).toBe('GET');
  });

  it('polls only the cheap active endpoint during a run and reloads once it ends', async () => {
    vi.useFakeTimers();
    let active: unknown = { launchId: 'L9', caseId: 'a', startedAt: '2026-10-24T01:00:00Z' };
    const base = defaultResponder(statusFixture({ activeLaunch: active }));
    respond = (url) => (url.pathname.endsWith('/active') ? json({ activeLaunch: active }) : base(url));
    boot();
    await vi.advanceTimersByTimeAsync(0);
    const statusLoads = () => calls.filter((call) => call.url.endsWith('/status')).length;
    expect(statusLoads()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.filter((call) => call.url.endsWith('/active'))).toHaveLength(1);
    expect(statusLoads()).toBe(1);
    active = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusLoads()).toBe(2);
  });
});
