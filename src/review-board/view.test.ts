import { describe, expect, it } from 'vitest';

import {
  nextReviewScrollTarget,
  reconcileOpenCursor,
  reviewMapRows,
  sectionEntryBlock,
  smoothReviewScrollStep,
  stepVisibleCursor,
  visibleBlockIndices,
} from './view';

describe('Review Board smooth scrolling', () => {
  it('approaches a target monotonically and lands exactly', () => {
    let scrollTop = 0;
    let done = false;

    for (let frame = 0; frame < 100; frame++) {
      const next = smoothReviewScrollStep(scrollTop, 180, 500);
      expect(next.scrollTop).toBeGreaterThanOrEqual(scrollTop);
      expect(next.scrollTop).toBeLessThanOrEqual(180);
      scrollTop = next.scrollTop;
      done = next.done;
      if (done) break;
    }

    expect(done).toBe(true);
    expect(scrollTop).toBe(180);
  });

  it('re-clamps an active target when the scroll geometry shrinks', () => {
    let scrollTop = 160;
    let target = 500;
    let done = false;

    for (let frame = 0; frame < 100; frame++) {
      const next = smoothReviewScrollStep(scrollTop, target, 220);
      scrollTop = next.scrollTop;
      target = next.target;
      done = next.done;
      if (done) break;
    }

    expect(done).toBe(true);
    expect(target).toBe(220);
    expect(scrollTop).toBe(220);
  });

  it('extends repeated input, reverses from the viewport, and clamps bounds', () => {
    expect(nextReviewScrollTarget(20, 80, 60, 500)).toBe(140);
    expect(nextReviewScrollTarget(20, 140, -60, 500)).toBe(0);
    expect(nextReviewScrollTarget(480, null, 60, 500)).toBe(500);
    expect(nextReviewScrollTarget(20, null, -60, 500)).toBe(0);
  });
});

// spec 244 — the chapter navigation rules, decided in pure functions so they are
// testable without a webview.

describe('visibleBlockIndices', () => {
  const section = { startBlock: 2, endBlock: 5 };

  it('renders one chapter, the open items, everything, or nothing', () => {
    const base = { blockCount: 7, section, openIndices: [1, 4, 6] };
    expect(visibleBlockIndices({ ...base, mode: 'section' })).toEqual([2, 3, 4]);
    expect(visibleBlockIndices({ ...base, mode: 'open' })).toEqual([1, 4, 6]);
    expect(visibleBlockIndices({ ...base, mode: 'document' })).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Overview renders no authored block at all — that is what keeps it from
    // being able to reorder or hide the lane's narrative.
    expect(visibleBlockIndices({ ...base, mode: 'overview' })).toEqual([]);
  });

  it('shows the whole document when there is no chapter, and clamps a stale range', () => {
    expect(
      visibleBlockIndices({ mode: 'section', blockCount: 3, section: null, openIndices: [] }),
    ).toEqual([0, 1, 2]);
    expect(
      visibleBlockIndices({
        mode: 'section',
        blockCount: 3,
        section: { startBlock: 1, endBlock: 9 },
        openIndices: [],
      }),
    ).toEqual([1, 2]);
  });
});

describe('stepVisibleCursor', () => {
  const visible = [4, 5, 6];

  it('moves inside the visible set', () => {
    expect(stepVisibleCursor(visible, 5, 1, true)).toEqual({ block: 6, section: 0 });
    expect(stepVisibleCursor(visible, 5, -1, true)).toEqual({ block: 4, section: 0 });
  });

  it('turns a chapter edge into a chapter step instead of a dead end', () => {
    expect(stepVisibleCursor(visible, 6, 1, true)).toEqual({ block: null, section: 1 });
    expect(stepVisibleCursor(visible, 4, -1, true)).toEqual({ block: null, section: -1 });
  });

  it('clamps when there is no chapter to continue into', () => {
    expect(stepVisibleCursor(visible, 6, 1, false)).toEqual({ block: null, section: 0 });
    expect(stepVisibleCursor([], 0, 1, true)).toEqual({ block: null, section: 0 });
  });

  it('enters from the near end when the cursor is outside the visible set', () => {
    expect(stepVisibleCursor(visible, 99, 1, true)).toEqual({ block: 4, section: 0 });
    expect(stepVisibleCursor(visible, 99, -1, true)).toEqual({ block: 6, section: 0 });
  });
});

describe('sectionEntryBlock', () => {
  it('opens a chapter on its first unanswered block, else its first block', () => {
    const section = { startBlock: 3, endBlock: 8 };
    expect(sectionEntryBlock(section, [1, 5, 9])).toBe(5);
    expect(sectionEntryBlock(section, [1, 9])).toBe(3);
    expect(sectionEntryBlock(section, [])).toBe(3);
  });
});

describe('reconcileOpenCursor', () => {
  it('advances to the next open item, then falls back to the previous one', () => {
    // The answered block (4) has already left the visible set.
    expect(reconcileOpenCursor([2, 7], 4)).toBe(7);
    expect(reconcileOpenCursor([2], 4)).toBe(2);
    expect(reconcileOpenCursor([], 4)).toBeNull();
  });
});

describe('reviewMapRows', () => {
  it('puts Overview first and the cross-document views last', () => {
    expect(reviewMapRows(2)).toEqual([
      { kind: 'overview' },
      { kind: 'section', index: 0 },
      { kind: 'section', index: 1 },
      { kind: 'open' },
      { kind: 'document' },
    ]);
    // A document with no chapters keeps the map: the smart views still help.
    expect(reviewMapRows(0)).toHaveLength(3);
  });
});
