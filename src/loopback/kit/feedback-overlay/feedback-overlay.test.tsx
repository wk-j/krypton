import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, flush, press, render } from '../test-utils';
import type { Rendered } from '../test-utils';
import { FeedbackOverlay } from '.';

interface Call {
  url: string;
  init?: RequestInit;
}

describe('FeedbackOverlay', () => {
  let scope: HTMLElement;
  let overlay: Rendered | null;
  let calls: Call[];
  let hashes: string[];
  let postStatus: number;
  const reload = vi.fn();

  beforeEach(() => {
    calls = [];
    hashes = ['h1'];
    postStatus = 200;
    reload.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.startsWith('/doc-state')) {
          const hash = hashes.length > 1 ? hashes.shift() : hashes[0];
          return new Response(JSON.stringify({ hash }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: postStatus === 200 ? 'accepted' : 'no-live-lane' }), {
          status: postStatus,
        });
      }),
    );
    scope = document.createElement('article');
    scope.innerHTML =
      '<h1>Guide</h1><p>Intro text.</p><h2>Setup</h2><h3>Install</h3><p id="target">Run the installer first.</p><h2>Usage</h2><p>Other.</p>';
    document.body.append(scope);
    overlay = null;
  });

  afterEach(() => {
    overlay?.unmount();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    sessionStorage.clear();
  });

  const make = (pollMs = 60_000): Rendered =>
    render(<FeedbackOverlay harness="hm-1" path="docs/guide.md" scope={scope} pollMs={pollMs} reload={reload} />);
  const commentPill = (): string => document.querySelectorAll('.lb-feedback__pill')[1]?.textContent ?? '';
  const box = (): HTMLElement => document.querySelector('.lb-feedback__box') as HTMLElement;
  const textarea = (): HTMLTextAreaElement => document.querySelector('.lb-feedback__text') as HTMLTextAreaElement;
  const posts = (prefix: string): Call[] => calls.filter((call) => call.url.startsWith(prefix) && call.init?.method === 'POST');
  const clickTarget = (): void => act(() => document.getElementById('target')?.click());

  /** Type into the composer the way a browser does (past React's value tracker). */
  function type(value: string): void {
    const node = textarea();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function pinPassage(body: string): void {
    press('c');
    clickTarget();
    type(body);
    press('Enter', { metaKey: true }, textarea());
  }

  it('arms on c, anchors the clicked passage with its heading trail, and saves on ⌘Enter', () => {
    overlay = make();
    expect(commentPill()).toContain('doc comments (0)');
    press('c');
    expect(commentPill()).toContain('click a passage');

    const target = document.getElementById('target') as HTMLElement;
    const followed = vi.fn();
    target.addEventListener('click', followed);
    clickTarget();
    // The anchoring click never reaches the document.
    expect(followed).not.toHaveBeenCalled();
    expect(box().hidden).toBe(false);
    expect(document.querySelector('.lb-feedback__target')?.textContent).toBe(
      'Guide › Setup › Install  “Run the installer first.”',
    );
    expect(document.activeElement).toBe(textarea());

    // Page keys pause while the composer is open.
    press('s', {}, textarea());
    expect(posts('/doc-feedback')).toHaveLength(0);

    type('say which installer');
    press('Enter', { metaKey: true }, textarea());
    expect(box().hidden).toBe(true);
    expect(commentPill()).toContain('doc comments (1)');
    expect(commentPill()).toContain('s send 1');

    const saved = JSON.parse(sessionStorage.getItem('kdf:hm-1:docs/guide.md') ?? 'null');
    expect(saved.pins).toHaveLength(1);
    expect(saved.pins[0]).toMatchObject({
      pinNumber: 1,
      body: 'say which installer',
      quote: 'Run the installer first.',
      headingPath: ['Guide', 'Setup', 'Install'],
      sent: false,
    });
  });

  it('Esc cancels the composer and Esc disarms the picker', () => {
    overlay = make();
    press('c');
    press('Escape');
    expect(commentPill()).toContain('doc comments (0)');
    press('c');
    clickTarget();
    press('Escape', {}, textarea());
    expect(box().hidden).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('kdf:hm-1:docs/guide.md') ?? 'null').draft).toBeNull();
  });

  it('s posts the unsent batch to /doc-feedback in the same JSON shape', async () => {
    overlay = make();
    pinPassage('first');
    press('s');
    await flush();
    expect(commentPill()).toContain('queued 1 ✓');

    const [post] = posts('/doc-feedback');
    expect(post.url).toBe('/doc-feedback?harness=hm-1&path=docs%2Fguide.md');
    const headers = new Headers(post.init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    const payload = JSON.parse(String(post.init?.body));
    expect(Object.keys(payload).sort()).toEqual(['batchId', 'comments']);
    expect(payload.batchId).toMatch(/^b-\d+-[0-9a-f]+$/);
    expect(payload.comments).toHaveLength(1);
    expect(Object.keys(payload.comments[0]).sort()).toEqual(
      ['body', 'createdAt', 'headingPath', 'id', 'pinNumber', 'quote'].sort(),
    );
    expect(payload.comments[0]).toMatchObject({
      pinNumber: 1,
      body: 'first',
      quote: 'Run the installer first.',
      headingPath: ['Guide', 'Setup', 'Install'],
    });
    const saved = JSON.parse(sessionStorage.getItem('kdf:hm-1:docs/guide.md') ?? 'null');
    expect(saved.batchId).toBeNull();
    expect(saved.pins[0].sent).toBe(true);
  });

  it('keeps the batch id for a retry when no lane is live', async () => {
    postStatus = 409;
    overlay = make();
    pinPassage('first');
    press('s');
    await flush();
    expect(commentPill()).toContain('no active lane');
    const firstBatch = JSON.parse(String(posts('/doc-feedback')[0].init?.body)).batchId;
    press('s');
    expect(JSON.parse(String(posts('/doc-feedback')[1].init?.body)).batchId).toBe(firstBatch);
  });

  it('restores unsent pins from sessionStorage and marks a pin whose quote is gone as drifted', () => {
    sessionStorage.setItem(
      'kdf:hm-1:docs/guide.md',
      JSON.stringify({
        pins: [
          { id: 'd-1', pinNumber: 1, body: 'a', quote: 'Intro text.', headingPath: ['Guide'], createdAt: 1, sent: false, drifted: false },
          { id: 'd-2', pinNumber: 2, body: 'b', quote: 'deleted line', headingPath: [], createdAt: 2, sent: false, drifted: false },
          { id: 'd-3', pinNumber: 3, body: 'c', quote: 'Other.', headingPath: [], createdAt: 3, sent: true, drifted: false },
        ],
        pinSeq: 3,
        draft: null,
        batchId: null,
      }),
    );
    overlay = make();
    expect(commentPill()).toContain('doc comments (2)');
    expect(commentPill()).toContain('1 drifted');
    press('j');
    expect(commentPill()).toContain('pin #1: a');
  });

  it('a requests an artifact with the doc title, but not while picking', async () => {
    overlay = make();
    press('c');
    press('a');
    expect(posts('/doc-artifact')).toHaveLength(0);
    press('Escape');

    press('a');
    await flush();
    expect(document.querySelector('.lb-feedback__pill')?.textContent).toContain('queued');
    const [post] = posts('/doc-artifact');
    expect(post.url).toBe('/doc-artifact?harness=hm-1&path=docs%2Fguide.md');
    const payload = JSON.parse(String(post.init?.body));
    expect(payload.batchId).toMatch(/^da-/);
    expect(payload.title).toBe('Docs artifact · guide.md');
  });

  it('reloads when /doc-state moves, deferred while the composer is open', async () => {
    // Fake only the poll's timers: the stubbed Response body still resolves.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      hashes = ['h1', 'h2'];
      // vi.waitFor advances fake time on every check, so a short cadence ticks.
      overlay = make(10);
      press('c');
      clickTarget();
      // The third load starts only after the second (moved hash) was applied.
      await act(async () => {
        await vi.waitFor(() => expect(calls.filter((c) => c.url.startsWith('/doc-state')).length).toBeGreaterThan(2));
      });
      expect(reload).not.toHaveBeenCalled();
      press('Escape', {}, textarea());
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
