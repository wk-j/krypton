import { describe, expect, it } from 'vitest';

import {
  CHAR_TO_CODE,
  FINGER_MAP,
  KEY_UNITS_TALL,
  KEY_UNITS_WIDE,
  KEY_UNITS_WIDE_MOUSE,
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
    const { width, height } = overlaySize(2000, 0.36, false);
    expect(width).toBe(720);
    expect(height).toBe(Math.round((720 / 15.4) * 8.1));
  });

  it('clamps width_ratio to 0.2–0.8 and the key unit to 12px', () => {
    expect(overlaySize(1000, 5, false).width).toBe(overlaySize(1000, 0.8, false).width);
    expect(overlaySize(1000, 0, false).width).toBe(overlaySize(1000, 0.2, false).width);
    expect(overlaySize(100, 0.36, false).width).toBe(Math.round(12 * 15.4));
  });

  it('adds the mouse pad to the right at the same key size and height', () => {
    const unit = (2000 * 0.36) / KEY_UNITS_WIDE;
    const { width, height } = overlaySize(2000, 0.36, true);
    expect(width).toBe(Math.round(unit * KEY_UNITS_WIDE_MOUSE));
    expect(height).toBe(overlaySize(2000, 0.36, false).height);
    expect(height).toBe(Math.round(unit * KEY_UNITS_TALL));
  });

  it('never lets the mouse overlay outgrow the workspace', () => {
    expect(overlaySize(1000, 0.8, true).width).toBeLessThanOrEqual(1000);
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

describe('keyboard overlay mouse', () => {
  function mouseRenderer(): { r: KeyboardOverlayRenderer; ctx: CanvasRenderingContext2D } {
    const r = new KeyboardOverlayRenderer();
    const ctx = stubContext();
    r.setMouse(true);
    r.resize(800, 300);
    framesUntilIdle(r, ctx, 0);
    return { r, ctx };
  }

  it('moves the right hand onto the mouse when the pointer moves, then stops the loop', () => {
    const { r, ctx } = mouseRenderer();
    r.movePointer(0.2, 0.8, 1000);
    const settle = framesUntilIdle(r, ctx, 1000);
    expect(settle).toBeLessThan(300);
    expect(r.mouseGrip).toBeGreaterThan(0.9);
    expect(r.frame(ctx, 20_000)).toBe(false);
  });

  it('waits 0.7 s after the last key before reaching for the mouse', () => {
    const { r, ctx } = mouseRenderer();
    r.press('KeyA', false, 1000);
    r.movePointer(0.5, 0.5, 1100);
    r.frame(ctx, 1200);
    expect(r.mouseGrip).toBe(0);
    framesUntilIdle(r, ctx, 1200);
    expect(r.mouseGrip).toBeGreaterThan(0.9);
  });

  it('returns the right hand to the keys on a right-hand key', () => {
    const { r, ctx } = mouseRenderer();
    r.movePointer(0.5, 0.5, 1000);
    framesUntilIdle(r, ctx, 1000);
    r.press('KeyJ', false, 10_000);
    framesUntilIdle(r, ctx, 10_000);
    expect(r.mouseGrip).toBeLessThan(0.1);
  });

  it('animates a click and settles after release', () => {
    const { r, ctx } = mouseRenderer();
    r.movePointer(0.5, 0.5, 1000);
    framesUntilIdle(r, ctx, 1000);
    r.pressButton('left', true, 10_000);
    r.pressButton('left', false, 10_050);
    const settle = framesUntilIdle(r, ctx, 10_050);
    expect(settle).toBeGreaterThan(1);
    expect(settle).toBeLessThan(300);
  });

  it('ignores the pointer when the mouse is off', () => {
    const r = new KeyboardOverlayRenderer();
    const ctx = stubContext();
    r.resize(560, 305);
    framesUntilIdle(r, ctx, 0);
    r.movePointer(0.5, 0.5, 1000);
    r.pressButton('left', true, 1000);
    expect(r.frame(ctx, 1016)).toBe(false);
    expect(r.mouseGrip).toBe(0);
  });
});
