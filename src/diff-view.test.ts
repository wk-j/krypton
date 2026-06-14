import { describe, expect, it } from 'vitest';

import { priorityForLineRange } from './diff-view';
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
