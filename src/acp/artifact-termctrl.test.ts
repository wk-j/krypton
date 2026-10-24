// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Specs 198/330: run the real page scripts against a mocked loopback API.
const html = readFileSync(join(__dirname, 'artifact-termctrl.html'), 'utf8');
const markup = /<body>([\s\S]*?)<script>/.exec(html)?.[1] ?? '';
const [decoderScript = '', pageScript = ''] = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const encoder = new TextEncoder();
const HIDDEN = '⟨full-screen app output hidden⟩';

interface AnsiText {
  push(bytes: Uint8Array): { lines: string[]; open: string };
}

function decode(chunks: ReadonlyArray<string | Uint8Array>, options?: { dropFirstLine?: boolean }): { lines: string[]; open: string } {
  const root: { createTermctrlAnsiText?: (options?: { dropFirstLine?: boolean }) => AnsiText } = {};
  new Function('window', decoderScript)(root);
  const text = root.createTermctrlAnsiText!(options);
  const lines: string[] = [];
  let open = '';
  for (const chunk of chunks) {
    const result = text.push(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    lines.push(...result.lines);
    open = result.open;
  }
  return { lines, open };
}

describe('Log view ANSI text decoder', () => {
  it('keeps what a terminal would leave on each line', () => {
    expect(decode(['plain\r\n', '10%\r55%\r100%\r\n', 'abcdef\x1b[3D\x1b[K\r\n', 'ab\bX\r\n', 'a\tb\r\n', 'open'])).toEqual({
      lines: ['plain', '100%', 'abc', 'aX', 'a       b'],
      open: 'open',
    });
  });

  it('drops colours, titles and hyperlinks but keeps their text', () => {
    const result = decode(['\x1b[1;31mred\x1b[0m \x1b]0;root@host: ~\x07\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\\n']);
    expect(result.lines).toEqual(['red link']);
  });

  it('decodes escapes and UTF-8 split anywhere across reads', () => {
    const bytes = encoder.encode('ok \x1b[32mศูนย์\x1b[0m\n');
    for (let at = 0; at <= bytes.length; at++) {
      expect(decode([bytes.slice(0, at), bytes.slice(at)]).lines, `split at ${at}`).toEqual(['ok ศูนย์']);
    }
  });

  it('replaces full-screen app output with one marker line', () => {
    const result = decode(['before\n\x1b[?1049h\x1b[2J\x1b[5;10Hbtop frame\n\x1b[?1049lafter\n']);
    expect(result.lines).toEqual(['before', HIDDEN, 'after']);
  });

  it('starts at the first whole line once the ring has dropped its head', () => {
    expect(decode(['ial line\nwhole\nopen'], { dropFirstLine: true })).toEqual({ lines: ['whole'], open: 'open' });
  });
});

interface Call {
  url: string;
  init?: RequestInit;
}

const session = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  state: 'running',
  command: ['ssh', `root@${name}.test`],
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  recording: false,
  logsTruncated: false,
  idleForMs: 0,
  hasVisibleContent: true,
  error: null,
  ...extra,
});

let calls: Call[] = [];
let sessionsPayload: Record<string, unknown>;
let logReplies: Response[] = [];
const cleanups: Array<() => void> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function logReply(text: string, mode: 'reset' | 'append', length: number, truncated = false): Response {
  return new Response(encoder.encode(text), {
    status: 200,
    headers: {
      'x-termctrl-log-mode': mode,
      'x-termctrl-log-length': String(length),
      'x-termctrl-log-truncated': String(truncated),
    },
  });
}

function respond(url: URL): Response {
  if (url.pathname === '/termctrl/api/tok/sessions') return json(sessionsPayload);
  if (url.pathname.startsWith('/termctrl/api/tok/screen/')) return json({ text: '┌─┐\n│<b>x</b>│\n└─┘' });
  if (url.pathname.startsWith('/termctrl/api/tok/log/')) return logReplies.shift() ?? json({ error: 'session log unavailable' }, 503);
  return new Response('', { status: 404 });
}

/** Listeners and timers the page adds, so each test starts with a page of its own. */
function track(target: Document | Window): void {
  const add = target.addEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    cleanups.push(() => target.removeEventListener(type, listener, options));
    add(type, listener, options);
  });
}

function boot(): void {
  history.replaceState(null, '', '/termctrl/tok');
  document.body.innerHTML = markup;
  new Function(decoderScript)();
  new Function(pageScript)();
}

const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
const logText = () => document.getElementById('log')?.textContent ?? '';
const logCalls = () => calls.filter((call) => call.url.includes('/log/'));

beforeEach(() => {
  calls = [];
  logReplies = [];
  sessionsPayload = { available: true, terminalControlVersion: '1.2.1', fetchedAt: Date.now(), sessions: [session('web')], error: null };
  track(document);
  track(window);
  const setInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, timeout?: number) => {
    const id = setInterval(handler, timeout);
    cleanups.push(() => clearInterval(id));
    return id;
  }) as typeof globalThis.setInterval);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    return respond(new URL(input, 'http://127.0.0.1:8765'));
  }));
});

afterEach(() => {
  cleanups.splice(0).forEach((remove) => remove());
  delete window.KryptonCellGrid;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Terminal Control monitor page', () => {
  it('shows the retained log as text and then asks only for what follows its copy', async () => {
    const first = 'one\n\x1b[31m<img src=x onerror=alert(1)>\x1b[0m\npartial';
    logReplies.push(logReply(first, 'reset', first.length));
    boot();
    await vi.waitFor(() => expect(document.querySelector('[data-session-name="web"]')).not.toBeNull());
    press('v');
    await vi.waitFor(() => expect(logText()).toBe('one\n<img src=x onerror=alert(1)>\npartial'));
    expect(document.querySelector('#log img')).toBeNull();
    expect(document.getElementById('log-wrap')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('screen-wrap')?.classList.contains('hidden')).toBe(true);
    expect(logCalls()[0].url).toBe('/termctrl/api/tok/log/web');

    logReplies.push(logReply(' line\nthree\n', 'append', first.length + 12));
    press('r');
    await vi.waitFor(() => expect(logText()).toBe('one\n<img src=x onerror=alert(1)>\npartial line\nthree\n'));
    const cursor = new URL(logCalls()[1].url, 'http://127.0.0.1:8765').searchParams;
    expect(cursor.get('length')).toBe(String(first.length));
    expect(cursor.get('anchor')).toBe(Buffer.from(first.slice(-64)).toString('hex'));

    // Read-only: every request is a plain GET of a monitor read route.
    for (const call of calls) {
      expect(call.init?.method ?? 'GET').toBe('GET');
      expect(call.url).toMatch(/^\/termctrl\/api\/tok\/(sessions|screen\/web|log\/web)(\?|$)/);
    }
  });

  it('starts a reset after a dropped ring head at the first whole line', async () => {
    logReplies.push(logReply('ial line\nwhole\n', 'reset', 16_777_216, true));
    boot();
    await vi.waitFor(() => expect(document.querySelector('[data-session-name="web"]')).not.toBeNull());
    press('v');
    await vi.waitFor(() => expect(logText()).toBe('whole\n'));
    expect(document.getElementById('log-state')?.textContent).toContain('older output dropped');
  });

  it('keeps the selection when a list poll fails', async () => {
    sessionsPayload = { ...sessionsPayload, sessions: [session('web'), session('api')] };
    boot();
    await vi.waitFor(() => expect(document.querySelector('[data-session-name="api"]')).not.toBeNull());
    press('j');
    await vi.waitFor(() => expect(document.querySelector('[aria-selected="true"]')?.getAttribute('data-session-name')).toBe('api'));
    sessionsPayload = { available: true, terminalControlVersion: '1.2.1', fetchedAt: Date.now(), sessions: [], error: 'termctrl command timed out' };
    press('r');
    await vi.waitFor(() => expect(document.getElementById('connection')?.textContent).toBe('CLI response error'));
    expect(document.querySelector('[aria-selected="true"]')?.getAttribute('data-session-name')).toBe('api');
  });

  it('shows the screen as text and lays it on the cell grid once that loads', async () => {
    boot();
    await vi.waitFor(() => expect(document.getElementById('screen')?.textContent).toBe('┌─┐\n│<b>x</b>│\n└─┘'));
    expect(document.querySelector('#screen b')).toBeNull();
    const gridifyText = vi.fn((host: HTMLElement) => {
      const code = document.createElement('code');
      code.append(...host.childNodes);
      host.append(code);
      return true;
    });
    window.KryptonCellGrid = { gridifyText };
    window.dispatchEvent(new Event('krypton-cell-grid-ready'));
    expect(gridifyText).toHaveBeenCalledWith(document.getElementById('screen'));
    expect(document.querySelector('#screen > code')?.textContent).toBe('┌─┐\n│<b>x</b>│\n└─┘');
  });

  it('uses full selection borders and no accent rails', () => {
    expect(html).toContain('.session[aria-selected="true"] { border-color: var(--accent)');
    expect(html).not.toContain('border-left:');
  });
});
