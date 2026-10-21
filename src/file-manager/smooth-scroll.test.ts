// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextScrollTarget, SmoothScroller, smoothScrollStep } from './smooth-scroll';

describe('smoothScrollStep', () => {
  it('snaps when within half a pixel', () => {
    expect(smoothScrollStep(99.6, 100)).toEqual({ value: 100, done: true });
    expect(smoothScrollStep(100.5, 100)).toEqual({ value: 100, done: true });
  });

  it('travels a fraction of the distance, at least 1px', () => {
    expect(smoothScrollStep(0, 100)).toEqual({ value: 24, done: false });
    expect(smoothScrollStep(100, 0)).toEqual({ value: 76, done: false });
    expect(smoothScrollStep(0, 2)).toEqual({ value: 1, done: false });
  });

  it('never overshoots', () => {
    expect(smoothScrollStep(0, 1.2)).toEqual({ value: 1.2, done: true });
    let v = 0;
    for (let i = 0; i < 200; i++) {
      const s = smoothScrollStep(v, 80);
      expect(s.value).toBeLessThanOrEqual(80);
      v = s.value;
      if (s.done) break;
    }
    expect(v).toBe(80);
  });

  it('honours custom lerp / snap', () => {
    expect(smoothScrollStep(0, 100, 0.5)).toEqual({ value: 50, done: false });
    expect(smoothScrollStep(95, 100, 0.24, 5)).toEqual({ value: 100, done: true });
  });
});

describe('nextScrollTarget', () => {
  it('starts from the current position when idle', () => {
    expect(nextScrollTarget(10, null, 80, 1000)).toBe(90);
  });

  it('extends the active target when continuing in the same direction', () => {
    expect(nextScrollTarget(10, 90, 80, 1000)).toBe(170);
    expect(nextScrollTarget(500, 420, -80, 1000)).toBe(340);
  });

  it('reverses from the current position', () => {
    expect(nextScrollTarget(50, 90, -80, 1000)).toBe(0);
    expect(nextScrollTarget(200, 90, 80, 1000)).toBe(280);
  });

  it('clamps to [0, max]', () => {
    expect(nextScrollTarget(10, null, -80, 1000)).toBe(0);
    expect(nextScrollTarget(950, null, 80, 1000)).toBe(1000);
    expect(nextScrollTarget(0, null, 80, -5)).toBe(0);
  });
});

describe('SmoothScroller', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextId: number;
  let reduced: boolean;

  const flush = (n = 1000): void => {
    for (let i = 0; i < n && frames.size > 0; i++) {
      const [id, cb] = frames.entries().next().value as [number, FrameRequestCallback];
      frames.delete(id);
      cb(0);
    }
  };

  beforeEach(() => {
    frames = new Map();
    nextId = 1;
    reduced = false;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: reduced && q.includes('reduce') }) as MediaQueryList,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const make = (max = 1000) => {
    const pos = { v: 0 };
    const s = new SmoothScroller(() => pos.v, (v) => { pos.v = v; }, () => max);
    return { pos, s };
  };

  it('glides to the target over several frames', () => {
    const { pos, s } = make();
    s.by(80);
    expect(pos.v).toBe(0);
    expect(s.active).toBe(true);
    flush(1);
    expect(pos.v).toBeGreaterThan(0);
    expect(pos.v).toBeLessThan(80);
    flush();
    expect(pos.v).toBe(80);
    expect(s.active).toBe(false);
  });

  it('runs a single rAF loop and extends the target on repeat', () => {
    const { pos, s } = make();
    s.by(80);
    s.by(80);
    s.by(80);
    expect(frames.size).toBe(1);
    flush();
    expect(pos.v).toBe(240);
  });

  it('clamps to max', () => {
    const { pos, s } = make(100);
    s.by(80);
    s.by(80);
    flush();
    expect(pos.v).toBe(100);
    s.to(-50);
    flush();
    expect(pos.v).toBe(0);
  });

  it('cancel stops the animation', () => {
    const { pos, s } = make();
    s.by(80);
    flush(1);
    const at = pos.v;
    s.cancel();
    expect(s.active).toBe(false);
    expect(frames.size).toBe(0);
    flush();
    expect(pos.v).toBe(at);
  });

  it('jumps straight to the target under prefers-reduced-motion', () => {
    reduced = true;
    const { pos, s } = make();
    s.by(80);
    expect(pos.v).toBe(80);
    expect(s.active).toBe(false);
    expect(frames.size).toBe(0);
  });
});
