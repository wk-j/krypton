import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedbackOverlay } from '.';

interface Call {
  url: string;
  init?: RequestInit;
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('FeedbackOverlay', () => {
  let scope: HTMLElement;
  let overlay: FeedbackOverlay | null;
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
    overlay?.dispose();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    sessionStorage.clear();
  });

  const make = (pollMs = 60_000): FeedbackOverlay =>
    new FeedbackOverlay({ harness: 'hm-1', path: 'docs/guide.md', scope, pollMs, reload });
  const commentPill = (): string => document.querySelectorAll('.lb-feedback__pill')[1]?.textContent ?? '';
  const box = (): HTMLElement => document.querySelector('.lb-feedback__box') as HTMLElement;
  const textarea = (): HTMLTextAreaElement => document.querySelector('.lb-feedback__text') as HTMLTextAreaElement;
  const posts = (prefix: string): Call[] => calls.filter((call) => call.url.startsWith(prefix) && call.init?.method === 'POST');

  function pinPassage(body: string): void {
    press(document.body, { key: 'c' });
    document.getElementById('target')?.click();
    textarea().value = body;
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    press(textarea(), { key: 'Enter', metaKey: true });
  }

  it('arms on c, anchors the clicked passage with its heading trail, and saves on ⌘Enter', () => {
    overlay = make();
    expect(commentPill()).toContain('doc comments (0)');
    press(document.body, { key: 'c' });
    expect(commentPill()).toContain('click a passage');

    const target = document.getElementById('target') as HTMLElement;
    const followed = vi.fn();
    target.addEventListener('click', followed);
    target.click();
    // The anchoring click never reaches the document.
    expect(followed).not.toHaveBeenCalled();
    expect(box().hidden).toBe(false);
    expect(document.querySelector('.lb-feedback__target')?.textContent).toBe(
      'Guide › Setup › Install  “Run the installer first.”',
    );
    expect(document.activeElement).toBe(textarea());

    // Page keys pause while the composer is open.
    press(textarea(), { key: 's' });
    expect(posts('/doc-feedback')).toHaveLength(0);

    textarea().value = 'say which installer';
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    press(textarea(), { key: 'Enter', metaKey: true });
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
    press(document.body, { key: 'c' });
    press(document.body, { key: 'Escape' });
    expect(commentPill()).toContain('doc comments (0)');
    press(document.body, { key: 'c' });
    document.getElementById('target')?.click();
    press(textarea(), { key: 'Escape' });
    expect(box().hidden).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('kdf:hm-1:docs/guide.md') ?? 'null').draft).toBeNull();
  });

  it('s posts the unsent batch to /doc-feedback in the same JSON shape', async () => {
    overlay = make();
    pinPassage('first');
    press(document.body, { key: 's' });
    await vi.waitFor(() => expect(commentPill()).toContain('queued 1 ✓'));

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
    press(document.body, { key: 's' });
    await vi.waitFor(() => expect(commentPill()).toContain('no active lane'));
    const firstBatch = JSON.parse(String(posts('/doc-feedback')[0].init?.body)).batchId;
    press(document.body, { key: 's' });
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
    press(document.body, { key: 'j' });
    expect(commentPill()).toContain('pin #1: a');
  });

  it('a requests an artifact with the doc title, but not while picking', async () => {
    overlay = make();
    press(document.body, { key: 'c' });
    press(document.body, { key: 'a' });
    expect(posts('/doc-artifact')).toHaveLength(0);
    press(document.body, { key: 'Escape' });

    press(document.body, { key: 'a' });
    await vi.waitFor(() => expect(document.querySelector('.lb-feedback__pill')?.textContent).toContain('queued'));
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
      press(document.body, { key: 'c' });
      document.getElementById('target')?.click();
      // The third load starts only after the second (moved hash) was applied.
      await vi.waitFor(() => expect(calls.filter((c) => c.url.startsWith('/doc-state')).length).toBeGreaterThan(2));
      expect(reload).not.toHaveBeenCalled();
      press(textarea(), { key: 'Escape' });
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
