import { describe, expect, it } from 'vitest';

import { nextReviewScrollTarget, smoothReviewScrollStep } from './view';

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
