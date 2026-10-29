import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { CONFLICT_SR_TEXT, TimelineView } from '.';
import type { TimelinePayload } from '.';

const payload: TimelinePayload = {
  events: [
    {
      id: 'e1',
      topicId: 't1',
      topicTitle: 'Storage',
      occurredAt: '2026-10-01T09:00:00Z',
      summary: 'Use SQLite for the index — a long summary that must wrap rather than be cut off',
      madeBy: 'user (wk)',
      recordedBy: 'claude',
      recorderLane: 'lane-1',
      evidenceKind: 'user_statement',
      evidenceExcerpt: '<img src=x onerror=alert(1)>',
      instructionExcerpt: '<b>record this</b>',
    },
    {
      id: 'e2',
      topicId: 't1',
      topicTitle: 'Storage',
      occurredAt: '2026-10-02T09:00:00Z',
      summary: 'Use Postgres instead',
      madeBy: 'agent:codex',
      recordedBy: 'codex',
      recorderLane: 'lane-2',
      rationale: 'scale',
    },
    {
      id: 'e0',
      topicId: 't1',
      topicTitle: 'Storage',
      occurredAt: '2026-09-30T09:00:00Z',
      summary: 'Old superseded plan',
      madeBy: 'user',
      recordedBy: 'claude',
      recorderLane: 'lane-1',
      superseded: true,
    },
    {
      id: 'e3',
      topicId: 't2',
      topicTitle: 'UI',
      occurredAt: '2026-10-03T09:00:00Z',
      summary: 'Dark theme default',
      madeBy: 'user',
      recordedBy: 'claude',
      recorderLane: 'lane-1',
    },
  ],
  diagnostics: [],
  conflictPairs: [{ pairId: 'p1', eventA: 'e1', eventB: 'e2', state: 'unreviewed', basis: 'same topic' }],
};

function press(key: string, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function row(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.lb-timeline__event[data-event-id="${id}"]`);
}

describe('TimelineView', () => {
  let view: TimelineView;
  let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

  beforeEach(async () => {
    history.replaceState(null, '', '/timeline?harness=h1');
    fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    view = new TimelineView('h1', new URLSearchParams(location.search));
    document.body.append(view.el);
    view.start();
    await vi.waitFor(() => expect(row('e1')).not.toBeNull());
  });

  afterEach(() => {
    view.dispose();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('only issues GET requests to the timeline JSON', async () => {
    // Focus refreshes are gated to one per second; step the clock past the gap.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2000);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('/timeline.json?harness=h1');
      expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
    }
  });

  it('shows the local-only chip and hides superseded rows by default', () => {
    expect(view.el.textContent).toContain('เฉพาะเครื่องนี้');
    expect(row('e0')).toBeNull();
    expect(row('e1')).not.toBeNull();
    press('h');
    expect(row('e0')).not.toBeNull();
  });

  it('shows made_by as recorded', () => {
    expect(row('e1')?.querySelector('.lb-timeline__who')?.textContent).toBe('user (wk)');
    expect(row('e2')?.querySelector('.lb-timeline__who')?.textContent).toBe('agent:codex');
  });

  it('marks only the time cell of an event in an open conflict pair', () => {
    const conflicted = row('e1')!;
    const time = conflicted.querySelector('.lb-timeline__time')!;
    expect(time.classList.contains('conflict')).toBe(true);
    expect(time.textContent).toContain(CONFLICT_SR_TEXT);
    expect(CONFLICT_SR_TEXT).toBe('มีบันทึกอีกข้อที่ให้คำสั่งต่างกัน');
    expect(conflicted.querySelectorAll('.conflict')).toHaveLength(1);
    expect(row('e3')!.querySelector('.conflict')).toBeNull();
    expect(row('e3')!.textContent).not.toContain(CONFLICT_SR_TEXT);
  });

  it('toggles detail with Space and i, reflected in aria-expanded', () => {
    const toggle = row('e1')!.querySelector('.lb-timeline__toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    press(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(row('e1')!.querySelector('.lb-timeline__detail--context')).not.toBeNull();
    press(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(row('e1')!.querySelector('.lb-timeline__detail')).toBeNull();
    press('i');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(row('e1')!.querySelector('.lb-timeline__detail--audit')).not.toBeNull();
    press('i');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders evidence and instruction excerpts as text', () => {
    press('i');
    const detail = row('e1')!.querySelector('.lb-timeline__detail')!;
    expect(detail.querySelector('img')).toBeNull();
    expect(detail.querySelector('b')).toBeNull();
    expect(detail.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(detail.textContent).toContain('<b>record this</b>');
  });

  it('j moves selection and p jumps to the conflict partner, updating the URL', () => {
    press('p');
    expect(row('e2')!.classList.contains('lb-timeline__event--selected')).toBe(true);
    expect(new URLSearchParams(location.search).get('event')).toBe('e2');
    press('j');
    expect(row('e3')!.classList.contains('lb-timeline__event--selected')).toBe(true);
  });

  it('[ and ] switch topics', () => {
    press(']');
    expect(view.el.querySelector('.lb-timeline__title')?.textContent).toBe('UI');
    expect(row('e1')).toBeNull();
    press('[');
    expect(view.el.querySelector('.lb-timeline__title')?.textContent).toBe('ลำดับเหตุการณ์');
  });

  it('never truncates collapsed titles with an ellipsis', () => {
    const css = readFileSync(resolve(__dirname, 'timeline.css'), 'utf8');
    const rule = css.match(/^\s*\.lb-timeline__text \{([^}]*)\}/m)?.[1] ?? '';
    expect(rule).not.toMatch(/ellipsis|nowrap/);
    expect(rule).toMatch(/overflow-wrap: anywhere/);
  });
});
