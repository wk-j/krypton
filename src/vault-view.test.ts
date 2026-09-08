import { describe, expect, it } from 'vitest';

import { nextVaultScrollTarget, smoothVaultScrollStep } from './vault-view';

describe('smoothVaultScrollStep', () => {
  it('approaches a lower target monotonically and lands exactly', () => {
    let scrollTop = 0;
    const positions: number[] = [];

    for (let frame = 0; frame < 100; frame++) {
      const next = smoothVaultScrollStep(scrollTop, 180);
      expect(next.scrollTop).toBeGreaterThanOrEqual(scrollTop);
      expect(next.scrollTop).toBeLessThanOrEqual(180);
      scrollTop = next.scrollTop;
      positions.push(scrollTop);
      if (next.done) break;
    }

    expect(positions.length).toBeGreaterThan(1);
    expect(scrollTop).toBe(180);
  });

  it('reverses smoothly without overshooting an upper target', () => {
    let scrollTop = 180;

    for (let frame = 0; frame < 100; frame++) {
      const next = smoothVaultScrollStep(scrollTop, 60);
      expect(next.scrollTop).toBeLessThanOrEqual(scrollTop);
      expect(next.scrollTop).toBeGreaterThanOrEqual(60);
      scrollTop = next.scrollTop;
      if (next.done) break;
    }

    expect(scrollTop).toBe(60);
  });

  it('snaps subpixel remainders to avoid an idle animation loop', () => {
    expect(smoothVaultScrollStep(59.75, 60)).toEqual({ scrollTop: 60, done: true });
  });

  it('extends repeated input but reverses from the visible position', () => {
    expect(nextVaultScrollTarget(20, 60, 60, 500)).toBe(120);
    expect(nextVaultScrollTarget(20, 120, -60, 500)).toBe(0);
  });
});
