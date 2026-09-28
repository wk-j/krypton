import { describe, expect, it } from 'vitest';

import {
  CHAR_TO_CODE,
  FINGER_MAP,
  KeyboardOverlayRenderer,
  LABELS,
  detectLayout,
  initialLayout,
  overlaySize,
  resolveCode,
} from './keyboard-overlay-model';

/** A 2D context that accepts every draw call and remembers assigned properties. */
function stubContext(): CanvasRenderingContext2D {
  const props: Record<string | symbol, unknown> = {};
  return new Proxy(props, {
    get: (target, prop) => (prop in target ? target[prop] : () => undefined),
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** Run frames at 60 fps from `start` until the renderer asks to stop. */
function framesUntilIdle(r: KeyboardOverlayRenderer, ctx: CanvasRenderingContext2D, start: number): number {
  let now = start;
  for (let n = 1; n <= 600; n++) {
    now += 1000 / 60;
    if (!r.frame(ctx, now)) return n;
  }
  return Infinity;
}

describe('keyboard overlay key resolution', () => {
  it('prefers the physical e.code over the typed character', () => {
    expect(resolveCode('KeyA', 'ฟ', 'us')).toBe('KeyA');
    expect(resolveCode('Space', ' ', 'th')).toBe('Space');
  });

  it('falls back to the label table when e.code is missing', () => {
    expect(resolveCode('', ' ', 'us')).toBe('Space');
    expect(resolveCode('', 'ก', 'th')).toBe('KeyD');
    expect(resolveCode('', 'Q', 'us')).toBe('KeyQ');
  });

  it('ignores keys the overlay does not draw', () => {
    expect(resolveCode('ArrowUp', 'ArrowUp', 'us')).toBeNull();
    expect(resolveCode('Tab', 'Tab', 'us')).toBeNull();
    expect(resolveCode('MetaLeft', 'Meta', 'us')).toBeNull();
  });

  it('maps and draws Kedmanee combining marks without the dotted circle', () => {
    expect(CHAR_TO_CODE.th['ั']).toBe('KeyY');
    expect(CHAR_TO_CODE.th['◌ั']).toBeUndefined();
    expect(LABELS.th.KeyY).toBe('ั');
    expect(LABELS.th.KeyE).toBe('ำ');
  });
});

describe('keyboard overlay auto layout', () => {
  it('switches to Kedmanee on Thai input and back on ASCII letters', () => {
    expect(detectLayout('ส', 'us')).toBe('th');
    expect(detectLayout('a', 'th')).toBe('us');
  });

  it('keeps the current layout for digits, punctuation and named keys', () => {
    expect(detectLayout('1', 'th')).toBe('th');
    expect(detectLayout('Enter', 'th')).toBe('th');
    expect(detectLayout('-', 'us')).toBe('us');
  });

  it('resolves the configured setting to a drawable layout', () => {
    expect(initialLayout('de')).toBe('de');
    expect(initialLayout('auto')).toBe('us');
    expect(initialLayout('dvorak')).toBe('us');
  });
});

describe('keyboard overlay geometry', () => {
  it('sizes from the workspace width at a 15.4 × 8.1 key-unit aspect', () => {
    const { width, height } = overlaySize(2000, 0.36);
    expect(width).toBe(720);
    expect(height).toBe(Math.round((720 / 15.4) * 8.1));
  });

  it('clamps width_ratio to 0.2–0.8 and the key unit to 12px', () => {
    expect(overlaySize(1000, 5).width).toBe(overlaySize(1000, 0.8).width);
    expect(overlaySize(1000, 0).width).toBe(overlaySize(1000, 0.2).width);
    expect(overlaySize(100, 0.36).width).toBe(Math.round(12 * 15.4));
  });

  it('uses the touch-typing finger map from the artifact', () => {
    expect(FINGER_MAP.KeyF).toEqual(['L', 1]);
    expect(FINGER_MAP.KeyJ).toEqual(['R', 1]);
    expect(FINGER_MAP.Enter).toEqual(['R', 4]);
    expect(FINGER_MAP.ShiftLeft).toEqual(['L', 4]);
  });
});

describe('keyboard overlay renderer loop', () => {
  it('stops requesting frames once the hands settle, and wakes on a key', () => {
    const r = new KeyboardOverlayRenderer();
    const ctx = stubContext();
    r.resize(560, 305);

    expect(framesUntilIdle(r, ctx, 0)).toBeLessThan(10);

    r.press('KeyG', false, 1000);
    const settle = framesUntilIdle(r, ctx, 1000);
    expect(settle).toBeGreaterThan(20);
    expect(settle).toBeLessThan(240);
    expect(r.frame(ctx, 9000)).toBe(false);
  });

  it('keeps the loop off while the idle ghost is disabled', () => {
    const r = new KeyboardOverlayRenderer();
    const ctx = stubContext();
    r.resize(560, 305);
    framesUntilIdle(r, ctx, 0);
    expect(r.msUntilGhost(60_000)).toBeNull();
    expect(r.frame(ctx, 60_000)).toBe(false);
  });

  it('schedules the idle ghost 5 s after the last key and then keeps animating', () => {
    const r = new KeyboardOverlayRenderer();
    const ctx = stubContext();
    r.resize(560, 305);
    r.setGhost(true, 0);
    r.press('KeyA', false, 100);
    framesUntilIdle(r, ctx, 100);
    expect(r.msUntilGhost(2100)).toBe(3000);
    expect(r.frame(ctx, 5200)).toBe(true);
    expect(r.msUntilGhost(5300)).toBeNull();
  });
});
