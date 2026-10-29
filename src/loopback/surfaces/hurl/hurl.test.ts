import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HurlView, hurlToken } from '.';
import { SPLIT_KEY } from './splits';

const API = '/hurl/api/tok';

const LISTING = {
  available: true,
  cwd: '/work/proj',
  error: null,
  hurl_files: [
    { path: '/work/proj/a.hurl', rel_path: 'a.hurl', name: 'a.hurl' },
    { path: '/work/proj/api/b.hurl', rel_path: 'api/b.hurl', name: 'b.hurl' },
  ],
  env_files: [{ path: '/work/proj/dev.env', rel_path: 'dev.env', name: 'dev.env' }],
};

interface Call {
  url: string;
  init?: RequestInit;
}

class StubEventSource {
  static last: StubEventSource | null = null;
  readonly listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    StubEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, fn);
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close(): void {
    this.closed = true;
  }
}

let calls: Call[] = [];
let view: HurlView | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function route(url: string): Response {
  if (url === `${API}/listing`) return json(LISTING);
  if (url === `${API}/state`) return json(null);
  if (url.startsWith(`${API}/source`)) {
    const path = decodeURIComponent(url.split('path=')[1]);
    return json({ source: `GET https://example.test/${path.endsWith('b.hurl') ? 'b' : 'a'}\nHTTP 200\n` });
  }
  if (url.startsWith(`${API}/cache`)) return json(null);
  if (url === `${API}/run`) return json({ runId: 'r1' });
  return json({});
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(): Promise<HurlView> {
  view = new HurlView('tok');
  document.body.replaceChildren(view.el);
  await view.start();
  await settle();
  return view;
}

function press(key: string): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.lb-btn')].find(
    (b) => b.querySelector('.lb-btn__label')?.textContent === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

beforeEach(() => {
  calls = [];
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  StubEventSource.last = null;
  vi.stubGlobal('EventSource', StubEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return route(url);
    }),
  );
});

afterEach(() => {
  view?.dispose();
  view = null;
  vi.unstubAllGlobals();
});

describe('hurl surface', () => {
  it('takes the token from the path', () => {
    expect(hurlToken('/hurl/abc123')).toBe('abc123');
  });

  it('renders the listing as a collapsed-by-default tree and loads the first file', async () => {
    await mount();
    const names = [...document.querySelectorAll('.lb-hurl__name')].map((n) => n.textContent);
    expect(names).toEqual(['api', 'a.hurl']);
    expect(document.querySelector('.lb-hurl__count')?.textContent).toBe('1 files');
    expect(document.querySelector('.lb-hurl__source')?.textContent).toContain('https://example.test/a');
    expect(document.querySelector('.lb-hurl__cwd')?.textContent).toBe('proj');
  });

  it('expands a folder and loads the source of the file the cursor lands on', async () => {
    await mount();
    press('k'); // cursor onto the `api` folder
    press('l');
    expect([...document.querySelectorAll('.lb-hurl__name')].map((n) => n.textContent)).toEqual(['api', 'b.hurl', 'a.hurl']);
    press('j');
    await settle();
    expect(calls.some((c) => c.url === `${API}/source?path=${encodeURIComponent('/work/proj/api/b.hurl')}`)).toBe(true);
    expect(document.querySelector('.lb-hurl__source')?.textContent).toContain('https://example.test/b');
    expect(document.querySelector('.lb-hurl__crumb')?.textContent).toBe('api/b.hurl');
  });

  it('toggles flip aria-pressed exclusively and feed the run body', async () => {
    await mount();
    const v = button('v');
    const vv = button('VV');
    press('v');
    expect(v.getAttribute('aria-pressed')).toBe('true');
    vv.click();
    expect(vv.getAttribute('aria-pressed')).toBe('true');
    expect(v.getAttribute('aria-pressed')).toBe('false');

    press('r');
    await settle();
    const run = calls.find((c) => c.url === `${API}/run`);
    expect(run?.init?.method).toBe('POST');
    expect(JSON.parse(String(run?.init?.body))).toEqual({
      path: '/work/proj/a.hurl',
      verbose: false,
      veryVerbose: true,
      variablesFile: null,
    });
  });

  it('streams SSE events into the exchange view', async () => {
    await mount();
    button('Run').click();
    await settle();
    const es = StubEventSource.last;
    expect(es?.url).toBe(`${API}/events/r1`);
    expect(button('Cancel').dataset.state).toBe('running');
    expect(document.querySelector('.lb-hurl__run-state .lb-dot--live')).not.toBeNull();

    press('2');
    es?.emit('output', { stream: 'stdout', chunk: 'HTTP/1.1 200 OK\nx: 1\n\n' });
    expect(document.querySelector('.lb-hurl__raw')?.textContent).toContain('HTTP/1.1 200 OK');

    press('1');
    es?.emit('finished', {
      stdout: 'HTTP/1.1 200 OK\ncontent-type: application/json\n\n{"ok":true}',
      stderr: '',
      exitCode: 0,
      durationMs: 12,
    });
    expect(es?.closed).toBe(true);
    expect(document.querySelector('.lb-hurl__status--ok')?.textContent).toBe('HTTP/1.1 200');
    expect(document.querySelector('.lb-hurl__body')?.textContent).toBe('{\n  "ok": true\n}');
    expect(button('Run').dataset.state).toBe('');
    expect(document.querySelector('.lb-hurl__run-state .lb-dot--live')).toBeNull();
  });

  it('persists split sizes to localStorage', async () => {
    await mount();
    press(']');
    press('-');
    const saved = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? '{}') as Record<string, number>;
    expect(saved.rosterPx).toBe(304);
    expect(saved.sourceRatio).toBeCloseTo(0.35);
    expect(document.querySelector<HTMLElement>('.lb-hurl__workspace')?.style.getPropertyValue('--roster')).toBe('304px');
  });

  it('restores saved split sizes', async () => {
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ rosterPx: 400, rosterH: 180, sourceRatio: 0.5 }));
    await mount();
    expect(document.querySelector<HTMLElement>('.lb-hurl__panes')?.style.getPropertyValue('--source')).toBe('50%');
  });
});
