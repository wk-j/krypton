import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flush, press, render } from '../../kit/test-utils';
import type { Rendered } from '../../kit/test-utils';

import { TrailPage } from '.';
import fixture from './fixtures/1364.json';

// Spec 400: the trail page against a stubbed `/trail.json`. The map is
// inline SVG from React elements (layout.test.ts covers the geometry).

interface Call {
  url: string;
  init?: RequestInit;
}

let calls: Call[] = [];
let respond: (url: URL) => Response;
let view: Rendered | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function boot(): Promise<void> {
  history.replaceState(null, '', '/trail?project=p1&issue=bcircle/tli-api-service/1364');
  view = render(<TrailPage />, { shell: { surfaceId: 'trail' } });
  await until(() => expect(document.querySelector('.lb-sysmap')).not.toBeNull());
}

async function until(check: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await flush(1);
    check();
  });
}

const current = (): string | null | undefined => document.querySelector('.lb-trail__step--current .lb-trail__num')?.textContent;
const pathEdges = (): number => document.querySelectorAll('.lb-sysmap__edge--path').length;
const futurePins = (): number => document.querySelectorAll('.lb-sysmap__pin--dim').length;
const text = (selector: string): string => document.querySelector(selector)?.textContent ?? '';

beforeEach(() => {
  calls = [];
  respond = (url) => (url.pathname === '/trail.json' ? json(fixture) : new Response('', { status: 404 }));
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bug trail page', () => {
  it('loads the trail for the page query and opens at the last step', async () => {
    await boot();
    expect(calls.map((c) => c.url)).toEqual(['/trail.json?project=p1&issue=bcircle/tli-api-service/1364']);
    expect(calls.every((c) => (c.init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(text('.lb-trail__title')).toBe('เอกสาร CL เข้า Storage ไปอยู่ใต้เลขกรมธรรม์แทนเลขเคลม');
    expect(text('.lb-trail__state')).toBe('analysis @ b420e805 · tree clean at start');
    expect(Array.from(document.querySelectorAll('.lb-trail__pills .lb-pill'), (p) => p.textContent)).toEqual([
      'root cause cited',
      '2 decisions open',
    ]);
    expect(current()).toBe('?10');
    expect(text('.lb-trail__progress')).toBe('step 10 of 10');
    expect(text('.lb-trail__caption')).toContain('6 of 26 nodes shown');
    // Inline SVG at its own size: 9 pins (step 2 is off the map), 2 dotted path edges.
    const svg = document.querySelector('.lb-sysmap');
    expect(svg?.getAttribute('width')).toBe(svg?.getAttribute('viewBox')?.split(' ')[2]);
    expect(document.querySelectorAll('.lb-sysmap__pin')).toHaveLength(9);
    expect(futurePins()).toBe(0);
    expect(pathEdges()).toBe(2);
    expect(document.querySelectorAll('.lb-sysmap__edge--proven')).toHaveLength(0);
    expect(document.querySelectorAll('.lb-sysmap__node--muted')).toHaveLength(1);
    // Lane text stays text: titles carry the notes, nothing is parsed as markup.
    expect(document.querySelector('.lb-sysmap__pin title')?.textContent).toContain('1 symptom: ');
  });

  it('shows the not-reproduced gap and the off-map step', async () => {
    await boot();
    expect(text('.lb-trail__gap')).toBe('not reproduced on b420e805');
    expect(text('.lb-trail__offmap')).toBe('not on the map (e2e/maps/tli-online.toml): step 2 "watch-folder"');
  });

  it('steps with j / k / g / G and restyles the same map for each frame', async () => {
    await boot();
    press('k');
    await until(() => expect(current()).toBe('9'));
    press('g');
    await until(() => expect(current()).toBe('1'));
    expect(document.querySelector('.lb-trail__gap')).toBeNull();
    expect(document.querySelector('.lb-trail__offmap')).toBeNull();
    const before = document.querySelector('.lb-sysmap')?.getAttribute('viewBox');
    expect(pathEdges()).toBe(0);
    expect(futurePins()).toBe(8);
    expect(document.querySelector('.lb-sysmap')?.getAttribute('viewBox')).toBe(before);
    press('k');
    expect(current()).toBe('1');
    press('j');
    press('ArrowDown');
    await until(() => expect(current()).toBe('3'));
    expect(text('.lb-trail__offmap')).toContain('step 2 "watch-folder"');
    press('G');
    await until(() => expect(current()).toBe('?10'));
    expect(document.querySelectorAll('.lb-trail__step--future')).toHaveLength(0);
    press('g');
    await until(() => expect(document.querySelectorAll('.lb-trail__step--future')).toHaveLength(9));
  });

  it('adds up keys pressed faster than a render', async () => {
    await boot();
    press('g');
    press('j');
    press('j');
    press('j');
    await until(() => expect(current()).toBe('4'));
  });

  it('swaps the involved nodes for the whole map with a', async () => {
    await boot();
    press('a');
    await until(() => expect(text('.lb-trail__caption')).toContain('26 of 26 nodes shown'));
    expect(document.querySelectorAll('.lb-sysmap__node--idle').length).toBe(20);
    press('a');
    await until(() => expect(text('.lb-trail__caption')).toContain('6 of 26 nodes shown'));
  });

  it('renders lane text as text and shows every evidence status', async () => {
    await boot();
    const statuses = Array.from(document.querySelectorAll('.lb-trail__status'), (n) => n.textContent);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('unchecked');
    expect(statuses).toContain('not-run');
    expect(text('.lb-trail__step[data-index="6"] .lb-trail__question')).toContain('แก้ตาม #363');
    expect(document.querySelectorAll('.lb-trail__step[data-index="6"] .lb-trail__options li')).toHaveLength(2);
    expect(text('.lb-trail__step[data-index="4"] .lb-trail__evidence')).toContain('TliClService.java:1688-1689');
  });

  it('keeps the steps when the map fails and says why', async () => {
    respond = () => json({ ...fixture, map: { ...fixture.map, map: null, errors: ['nodes[3].group: unknown group "x"'] } });
    history.replaceState(null, '', '/trail?project=p1&issue=bcircle/tli-api-service/1364');
    view = render(<TrailPage />, { shell: { surfaceId: 'trail' } });
    await until(() => expect(document.querySelectorAll('.lb-trail__step')).toHaveLength(10));
    expect(text('.lb-trail__errors')).toContain('map e2e/maps/tli-online.toml: nodes[3].group: unknown group "x"');
    expect(document.querySelector('.lb-trail__map')).toBeNull();
  });

  it('names a missing trail', async () => {
    respond = () => new Response('', { status: 404 });
    history.replaceState(null, '', '/trail?project=p1&issue=o/r/1');
    view = render(<TrailPage />, { shell: { surfaceId: 'trail' } });
    await until(() => expect(text('.lb-banner')).toBe('This issue has no bug trail. Analyze it in Krypton first.'));
  });
});

describe('bug trail index', () => {
  const second = {
    ...fixture,
    issue: 'bcircle/tli-api-service#1400',
    title: 'second',
    steps: fixture.steps.slice(0, 3),
    errors: ['commit: commit 0123abcd not found'],
  };

  it('lists every trail with the issue view\'s status and opens one', async () => {
    respond = (url) =>
      url.pathname === '/trail.json' && !url.searchParams.has('issue')
        ? json({ projectId: 'p1', projectName: 'tli-api-service', trails: [second, fixture] })
        : new Response('', { status: 404 });
    history.replaceState(null, '', '/trail?project=p1');
    view = render(<TrailPage />, { shell: { surfaceId: 'trail' } });
    await until(() => expect(document.querySelectorAll('.lb-trail__entry')).toHaveLength(2));
    expect(calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([['/trail.json?project=p1', 'GET']]);
    expect(text('.lb-trail__meta')).toContain('2 trails');
    const rows = [...document.querySelectorAll('.lb-trail__entry')];
    expect(rows[1].textContent).toContain('root cause cited');
    expect(rows[1].textContent).toContain('2 decisions open');
    expect(rows[1].textContent).toContain('not reproduced');
    expect(rows[0].textContent).toContain('1 failing check');
    expect(rows[1].querySelector('a')?.getAttribute('href')).toBe('/trail?project=p1&issue=bcircle%2Ftli-api-service%2F1364');
    expect(document.querySelector('.lb-trail__entry--current')).toBe(rows[0]);
    press('j');
    await until(() => expect(document.querySelector('.lb-trail__entry--current')).toBe(rows[1]));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...location, search: '?project=p1', assign });
    press('Enter');
    expect(assign).toHaveBeenCalledWith('/trail?project=p1&issue=bcircle%2Ftli-api-service%2F1364');
  });

  it('says how to get a trail when the project has none', async () => {
    respond = () => json({ projectId: 'p1', projectName: 'empty', trails: [] });
    history.replaceState(null, '', '/trail?project=p1');
    view = render(<TrailPage />, { shell: { surfaceId: 'trail' } });
    await until(() => expect(document.body.textContent).toContain('No bug trails yet'));
  });

  it('links the issue view back to the index', async () => {
    await boot();
    expect(document.querySelector('.lb-trail__back')?.getAttribute('href')).toBe('/trail?project=p1');
  });
});
