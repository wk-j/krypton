import { describe, expect, it } from 'vitest';

import {
  nextDiffScrollTarget,
  priorityForLineRange,
  smoothDiffScrollStep,
} from './diff-view';
import type { ReviewPriorityRange } from './acp/types';

// spec 160 — the fold/mark authority: a hunk takes the HIGHEST priority of any
// reported range overlapping its new-side lines; a hunk no range touches stays
// `normal`. The failure mode is always under-collapse (show more), never
// over-collapse (ADR-0009).
describe('priorityForLineRange (spec 160)', () => {
  const r = (lineStart: number, lineEnd: number, level: 'high' | 'routine'): ReviewPriorityRange => ({
    file: 'src/foo.ts',
    lineStart,
    lineEnd,
    level,
  });

  it('returns normal when no range overlaps the hunk', () => {
    expect(priorityForLineRange(10, 20, [r(30, 40, 'routine')])).toBe('normal');
    expect(priorityForLineRange(10, 20, [])).toBe('normal');
  });

  it('folds a hunk a routine range overlaps', () => {
    expect(priorityForLineRange(10, 20, [r(12, 14, 'routine')])).toBe('routine');
  });

  it('marks a hunk a high range overlaps', () => {
    expect(priorityForLineRange(10, 20, [r(18, 25, 'high')])).toBe('high');
  });

  it('lets a single high range win over routine in the same hunk', () => {
    // One high line inside an otherwise-routine hunk keeps the whole hunk visible.
    expect(
      priorityForLineRange(10, 20, [r(10, 19, 'routine'), r(15, 15, 'high')]),
    ).toBe('high');
    // Order-independent: high wins regardless of which range is seen first.
    expect(
      priorityForLineRange(10, 20, [r(15, 15, 'high'), r(10, 19, 'routine')]),
    ).toBe('high');
  });

  it('treats edge-touching ranges as overlapping (inclusive bounds)', () => {
    expect(priorityForLineRange(10, 20, [r(20, 30, 'routine')])).toBe('routine');
    expect(priorityForLineRange(10, 20, [r(1, 10, 'high')])).toBe('high');
    // Just-past the edge is not an overlap.
    expect(priorityForLineRange(10, 20, [r(21, 30, 'routine')])).toBe('normal');
    expect(priorityForLineRange(10, 20, [r(1, 9, 'routine')])).toBe('normal');
  });
});

describe('Diff view smooth scrolling (spec 243)', () => {
  it('approaches a lower target monotonically and lands exactly', () => {
    let scrollTop = 0;
    const positions: number[] = [];

    for (let frame = 0; frame < 100; frame++) {
      const next = smoothDiffScrollStep(scrollTop, 180);
      expect(next.scrollTop).toBeGreaterThanOrEqual(scrollTop);
      expect(next.scrollTop).toBeLessThanOrEqual(180);
      scrollTop = next.scrollTop;
      positions.push(scrollTop);
      if (next.done) break;
    }

    expect(positions.length).toBeGreaterThan(1);
    expect(scrollTop).toBe(180);
  });

  it('reverses without overshooting and snaps subpixel remainders', () => {
    let scrollTop = 180;

    for (let frame = 0; frame < 100; frame++) {
      const next = smoothDiffScrollStep(scrollTop, 60);
      expect(next.scrollTop).toBeLessThanOrEqual(scrollTop);
      expect(next.scrollTop).toBeGreaterThanOrEqual(60);
      scrollTop = next.scrollTop;
      if (next.done) break;
    }

    expect(scrollTop).toBe(60);
    expect(smoothDiffScrollStep(59.75, 60)).toEqual({ scrollTop: 60, done: true });
  });

  it('extends repeated input, reverses from the viewport, and clamps bounds', () => {
    expect(nextDiffScrollTarget(20, 60, 40, 500)).toBe(100);
    expect(nextDiffScrollTarget(20, 100, -40, 500)).toBe(0);
    expect(nextDiffScrollTarget(480, null, 40, 500)).toBe(500);
    expect(nextDiffScrollTarget(20, null, -40, 500)).toBe(0);
  });
});
