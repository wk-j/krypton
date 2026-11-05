import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { act, flush, press, render } from '../../kit/test-utils';
import type { Rendered } from '../../kit/test-utils';

import { AcpWirePage } from '.';
import type { WireEvent, WireSummary } from './model';

const BASE = '/acp-wire/tok';

const summary: WireSummary = {
  mode: 'full',
  events: 3,
  evicted: 0,
  payloadBytes: 0,
  payloadCapBytes: 64 * 1048576,
  nowMs: 1_000_000,
  nowMonoUs: 50_000_000,
  inFlight: 0,
  dirs: { to_agent: { bytes: 2048 }, from_agent: { bytes: 300 } },
  lanes: [{ lane: 'claude-1', backend: 'claude' }],
  methods: [{ method: 'session/new', count: 2, bytes: 400, p50Us: 1500, p95Us: 1500, maxUs: 1500, errors: 0 }],
};

function ev(seq: number, extra: Partial<WireEvent>): WireEvent {
  return {
    seq,
    tsMs: 999_000 + seq,
    monoUs: 40_000_000 + seq * 1000,
    lane: 'claude-1',
    backend: 'claude',
    session: 's1',
    dir: 'to_agent',
    kind: 'request',
    method: 'session/new',
    id: 1,
    bytes: 200,
    hasPayload: true,
    ...extra,
  };
}

const events: WireEvent[] = [
  ev(1, {}),
  ev(2, { dir: 'from_agent', kind: 'response', pairSeq: 1, latencyUs: 1500 }),
  ev(3, { dir: 'from_agent', kind: 'notification', method: 'session/update', id: null }),
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: Mock;
let currentSummary: WireSummary = summary;
let view: Rendered | null = null;

beforeEach(() => {
  currentSummary = summary;
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/summary')) return json(currentSummary);
    if (url.includes('/events?')) return json({ events, nextSeq: 4 });
    const m = /\/event\/(\d+)$/.exec(url);
    if (m) {
      const seq = Number(m[1]);
      const found = events.find((e) => e.seq === seq);
      return found ? json({ ...found, payload: '{"jsonrpc":"2.0","method":"session/new"}' }) : json({}, 404);
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const setTitle = vi.fn();

function mount(pathname: string): HTMLElement {
  view = render(<AcpWirePage pathname={pathname} />, { shell: { setTitle }, strict: true });
  return view.container;
}

describe('acp-wire dashboard', () => {
  it('renders fixture events into the table and stats', async () => {
    const root = mount(BASE);
    await flush();
    const rows = [...root.querySelectorAll<HTMLElement>('tbody tr[data-key]')].map((r) => r.dataset.key);
    expect(rows).toEqual(['e1', 'e2', 'e3']);
    expect(root.textContent).toContain('session/update');
    const stats = root.querySelector('.lb-stats')?.textContent ?? '';
    expect(stats).toContain('2.0 KB');
    expect(stats).toContain('1.5 ms / 1.5 ms');
    expect(root.textContent).toContain('capture: full');
    // The request was patched with its response's latency.
    expect(root.querySelector('tr[data-key="e1"]')?.textContent).toContain('1.5 ms');
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/events?since=0&limit=2000`, expect.anything());
  });

  it('shows the capture-off banner', async () => {
    currentSummary = { ...summary, mode: 'off' };
    const root = mount(BASE);
    await flush();
    const banner = root.querySelector<HTMLElement>('.lb-banner');
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toContain('Capture is off');
  });

  it('k walks up from the tail and Enter jumps to the pair', async () => {
    const root = mount(BASE);
    await flush();
    expect(root.querySelectorAll('tr[data-key]').length).toBe(3);
    press('k');
    press('k');
    expect(root.querySelector('.lb-acp-wire__row--selected')?.getAttribute('data-key')).toBe('e2');
    press('Enter');
    expect(root.querySelector('.lb-acp-wire__row--selected')?.getAttribute('data-key')).toBe('e1');
    await flush();
  });

  it('Space pauses polling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const root = mount(BASE);
    const advance = (ms: number): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    await advance(0);
    const afterFirst = fetchMock.mock.calls.length;
    await advance(1000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
    press(' ');
    expect(root.textContent).toContain('paused');
    await advance(0);
    const paused = fetchMock.mock.calls.length;
    await advance(5000);
    expect(fetchMock.mock.calls.length).toBe(paused);
  });
});

describe('acp-wire message page', () => {
  const seqPill = (root: HTMLElement): string => root.querySelector('.lb-pill')?.textContent ?? '';

  it('opens on /message/<seq> and walks seqs with [ and ]', async () => {
    history.replaceState(null, '', `${BASE}/message/2`);
    const root = mount(`${BASE}/message/2`);
    await flush();
    expect(root.textContent).toContain('response');
    expect(seqPill(root)).toBe('seq 2');
    expect(root.textContent).toContain('seq 1 ↵');
    press(']');
    expect(seqPill(root)).toBe('seq 3');
    expect(location.pathname).toBe(`${BASE}/message/3`);
    await flush();
    expect(root.textContent).toContain('session/update');
    press('[');
    press('[');
    expect(seqPill(root)).toBe('seq 1');
    expect(location.pathname).toBe(`${BASE}/message/1`);
    await flush();
  });

  it('reports a seq that is not in the ring', async () => {
    const root = mount(`${BASE}/message/99`);
    await flush();
    expect(root.textContent).toContain('seq 99 is not in the ring');
  });
});
