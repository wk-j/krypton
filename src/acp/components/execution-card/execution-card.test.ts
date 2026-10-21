import { afterEach, describe, expect, it } from 'vitest';

import type { ExecutionPayload } from '../../harness-view-types';
import { tickAllSpinners } from '../spinner';
import { ExecutionCard } from './index';

const cards: ExecutionCard[] = [];
const payload: ExecutionPayload = {
  source: 'omp', language: 'py', title: 'Compute totals', code: 'print(1)', output: null,
  observedLive: true, cellStatus: 'running', durationMs: null, exitCode: null, isError: false,
  activity: [], views: [], detached: null, truncated: [],
};

function card(data: ExecutionPayload = payload, status = 'in_progress'): ExecutionCard {
  const result = new ExecutionCard();
  cards.push(result);
  document.body.append(result.el);
  result.update({ payload: data, status, startedAt: 10, hintLabel: null });
  return result;
}

afterEach(() => {
  for (const item of cards.splice(0)) item.dispose();
});

describe('ExecutionCard', () => {
  it('keeps one summary node and its dialog trigger through stream and terminal updates', () => {
    const item = card();
    const button = item.el.querySelector('button')!;
    item.setHint('a');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    item.update({ payload: { ...payload, output: 'one', activity: [{ op: 'log', text: 'Real log', detail: '' }] }, status: 'in_progress', startedAt: 10, hintLabel: 'a' });
    item.update({ payload: { ...payload, output: 'one\ntwo', cellStatus: 'complete', durationMs: 42 }, status: 'completed', startedAt: 10, endedAt: 99, hintLabel: 'a' });
    expect(item.el.querySelector('button')).toBe(button);
    expect(button.textContent).toContain('a');
    expect(item.el.textContent).not.toContain('one\ntwo');
  });

  it('uses only real activity and keeps code out of the compact summary', () => {
    const item = card({ ...payload, activity: [
      { op: 'phase', text: 'Read files', detail: '' },
      { op: 'log', text: '<img src=x onerror=alert(1)>', detail: '' },
    ] });
    expect(item.el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(item.el.textContent).not.toContain('Read files');
    expect(item.el.textContent).not.toContain(payload.code);
    expect(item.el.querySelector('img')).toBeNull();
  });

  it('stops live glyph and elapsed updates on a terminal transition', () => {
    const item = card();
    const timer = item.el.querySelector<HTMLElement>('[data-started-at]')!;
    expect(timer.dataset.endedAt).toBeUndefined();
    item.update({ payload: { ...payload, cellStatus: 'complete', durationMs: 50 }, status: 'completed', startedAt: 10, endedAt: 100, hintLabel: null });
    expect(timer.dataset.endedAt).toBeDefined();
    expect(timer.title).toMatch(/runtime/i);
    const before = item.el.textContent;
    tickAllSpinners();
    expect(item.el.textContent).toBe(before);
  });

  it('never leaves a ticking timer or spinner on background snapshots', () => {
    const item = card({ ...payload, detached: { jobId: 'job-7', state: 'running' } }, 'completed');
    expect(item.el.querySelector('[data-started-at]')).toBeNull();
    const before = item.el.textContent;
    tickAllSpinners();
    expect(item.el.textContent).toBe(before);
    expect(item.el.querySelector('[title*="job-7"]')).not.toBeNull();
  });

  it('does not invent elapsed time for a terminal-only replay', () => {
    const item = card({ ...payload, observedLive: false, cellStatus: 'complete' }, 'completed');
    expect(item.el.querySelector('[data-started-at]')).toBeNull();
    expect(item.el.querySelector<HTMLElement>('.acp-harness__tool-timer')?.hidden).toBe(true);
    item.update({ payload: { ...payload, observedLive: false, cellStatus: 'complete', durationMs: 1500 }, status: 'completed', hintLabel: null });
    const timer = item.el.querySelector<HTMLElement>('.acp-harness__tool-timer')!;
    expect(timer.hidden).toBe(false);
    expect(timer.title).toMatch(/runtime/i);
    expect(timer.dataset.endedAt).toBeDefined();
  });

  it('distinguishes observed terminal elapsed from runtime timing', () => {
    const item = card();
    item.update({ payload: { ...payload, cellStatus: 'complete' }, status: 'completed', startedAt: 10, endedAt: 120, hintLabel: null });
    expect(item.el.querySelector<HTMLElement>('.acp-harness__tool-timer')?.title).toMatch(/observed/i);
  });
});
