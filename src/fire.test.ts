import { describe, expect, it } from 'vitest';

import type { FireConfig } from './config';
import {
  FIRE,
  FIRE_LOOK_LIMITS,
  fireBand,
  fireEmbers,
  fireLookState,
  resolveFireLooks,
  stepHeat,
  stepLook,
  type FireLook,
  type FireState,
  type LiveLook,
  workspaceFireState,
} from './fire';

const EMBER_FLOATS = FIRE.embers * 8;

describe('fireEmbers', () => {
  const band = fireBand(900, 600, 1);

  it('is deterministic, so redrawing the same instant never jitters', () => {
    const a = new Float32Array(EMBER_FLOATS);
    const b = new Float32Array(EMBER_FLOATS);
    for (const t of [0, 0.37, 12.5, 599.9]) {
      const na = fireEmbers(t, 0xdeadbeef, band, 8, 90, a);
      const nb = fireEmbers(t, 0xdeadbeef, band, 8, 90, b);
      expect(nb).toBe(na);
      expect(Array.from(b.subarray(0, nb * 8))).toEqual(Array.from(a.subarray(0, na * 8)));
    }
  });

  it('never exceeds the uniform array and culls cooled embers', () => {
    const out = new Float32Array(EMBER_FLOATS);
    for (let i = 0; i < 400; i++) {
      const n = fireEmbers(i * 0.173, Math.imul(i, 2654435761) >>> 0, band, 8, 120, out);
      expect(n).toBeLessThanOrEqual(FIRE.embers);
      for (let k = 0; k < n; k++) {
        expect(out[k * 8 + 4]).toBeGreaterThan(0); // size
        expect(out[k * 8 + 5]).toBeGreaterThanOrEqual(0.004); // temperature
      }
    }
  });
});

describe('stepHeat', () => {
  const run = (heat: number, target: 0 | 1, seconds: number): number => {
    let h = heat;
    for (let i = 0; i < Math.round(seconds * 60); i++) h = stepHeat(h, target, 1 / 60);
    return h;
  };

  it('puts the fire out (heat < 0.01) within 2.5 s, so the frame loop stops', () => {
    expect(run(1, 0, 2.5)).toBeLessThan(0.01);
  });

  it('is fully lit within 0.75 s of igniting', () => {
    expect(run(0, 1, 0.75)).toBeGreaterThan(0.95);
  });

  it('a stalled frame jumps toward the target without overshooting', () => {
    expect(stepHeat(0.2, 1, 10)).toBeLessThanOrEqual(1);
    expect(stepHeat(0.8, 0, 10)).toBeGreaterThanOrEqual(0);
  });
});

describe('fireBand', () => {
  it('never extends past the content area, however tall the look', () => {
    for (const h of [0, 30, 90, 180, 400, 2000]) {
      expect(fireBand(800, h, 1).cssHeight).toBeLessThanOrEqual(h);
      expect(fireBand(800, h, FIRE_LOOK_LIMITS.height.max).cssHeight).toBeLessThanOrEqual(h);
    }
  });

  it('keeps the built-in flame height within 40–120 px', () => {
    expect(fireBand(800, 100, 1).flameMax).toBe(40);
    expect(fireBand(800, 400, 1).flameMax).toBeCloseTo(88);
    expect(fireBand(800, 2000, 1).flameMax).toBe(120);
  });

  it('scales the flame and its band by the look height', () => {
    expect(fireBand(800, 2000, 2).flameMax).toBe(240);
    expect(fireBand(800, 2000, 2).cssHeight).toBe(2 * fireBand(800, 2000, 1).cssHeight);
    expect(fireBand(800, 400, 0.5).flameMax).toBeCloseTo(44);
  });
});

describe('resolveFireLooks', () => {
  const resolve = (cfg: FireConfig, isColor: (v: string) => boolean = () => true): {
    looks: Record<FireState, FireLook>;
    warnings: string[];
  } => {
    const warnings: string[] = [];
    return { looks: resolveFireLooks(cfg, (m) => warnings.push(m), isColor), warnings };
  };

  it('takes each key from [fire.<state>], then [fire], then the built-in value', () => {
    const { looks } = resolve({
      on: ['working', 'blocked'],
      height: 2,
      speed: 1.5,
      mid: '#111111',
      blocked: { speed: 3, hot: '#222222' },
    });
    expect(looks.blocked).toEqual({ height: 2, intensity: 1, speed: 3, low: null, mid: '#111111', hot: '#222222' });
    expect(looks.working).toEqual({ height: 2, intensity: 1, speed: 1.5, low: null, mid: '#111111', hot: null });
    expect(looks.done).toEqual({ height: 2, intensity: 1, speed: 1.5, low: null, mid: '#111111', hot: null });
  });

  it('clamps out-of-range numbers to the limits and says so', () => {
    const { looks, warnings } = resolve({ on: [], height: 10, error: { intensity: 0, speed: -1 } });
    expect(looks.working.height).toBe(FIRE_LOOK_LIMITS.height.max);
    expect(looks.error.intensity).toBe(FIRE_LOOK_LIMITS.intensity.min);
    expect(looks.error.speed).toBe(FIRE_LOOK_LIMITS.speed.min);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('[fire] height = 10'),
      expect.stringContaining('[fire.error] intensity = 0'),
      expect.stringContaining('[fire.error] speed = -1'),
    ]));
  });

  it('treats null (inf/nan in TOML) as unset, so the next table decides', () => {
    const { looks, warnings } = resolve({ on: [], speed: 2, blocked: { speed: null, mid: null } });
    expect(looks.blocked.speed).toBe(2);
    expect(looks.blocked.mid).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('skips an invalid colour with a warning and falls through to [fire]', () => {
    const isHex = (v: string): boolean => /^#[0-9a-f]{6}$/i.test(v);
    const { looks, warnings } = resolve({ on: [], mid: '#111111', blocked: { mid: 'orangey', low: 'nope' } }, isHex);
    expect(looks.blocked.mid).toBe('#111111');
    expect(looks.blocked.low).toBeNull();
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('[fire.blocked] mid = "orangey"'),
      expect.stringContaining('[fire.blocked] low = "nope"'),
    ]));
  });
});

describe('stepLook', () => {
  const look = (height: number, intensity: number, speed: number, rgb: number): LiveLook => ({
    height, intensity, speed, low: [rgb, 0, 0], mid: [0, rgb, 0], hot: [0, 0, rgb],
  });

  it('reaches the target within 0.01 in 1.5 s at 60 fps and then reports settled', () => {
    const live = look(FIRE_LOOK_LIMITS.height.min, 0.1, 0.25, 0);
    const target = look(FIRE_LOOK_LIMITS.height.max, 2, 4, 1);
    let settledAt = -1;
    for (let i = 0; i < 150; i++) {
      if (stepLook(live, target, 1 / 60) && settledAt < 0) settledAt = i;
      if (i === 89) {
        expect(Math.abs(live.height - target.height)).toBeLessThan(0.01);
        expect(Math.abs(live.speed - target.speed)).toBeLessThan(0.01);
        expect(Math.abs(live.hot[2] - 1)).toBeLessThan(0.01);
      }
    }
    expect(settledAt).toBeGreaterThan(0);
    expect(live).toEqual(target);
  });

  it('a stalled frame lands on the target without overshooting', () => {
    const live = look(1, 1, 1, 0.2);
    const target = look(3, 2, 4, 0.9);
    stepLook(live, target, 10);
    expect(live.height).toBeLessThanOrEqual(3);
    expect(live.mid[1]).toBeLessThanOrEqual(0.9);
    expect(live).toEqual(target);
  });
});

describe('fireLookState (spec 0365)', () => {
  const on = (...values: Array<FireState | 'tool_error'>): ReadonlySet<FireState | 'tool_error'> => new Set(values);

  it('burns a Harness tool error with the error look only when on lists tool_error', () => {
    expect(fireLookState(null, 'tool_error', on('tool_error'))).toBe('error');
    expect(fireLookState(null, 'tool_error', on('error', 'working'))).toBeNull();
  });

  it('ranks tool_error as error against the window program state', () => {
    expect(fireLookState('working', 'tool_error', on('working', 'tool_error'))).toBe('error');
    expect(fireLookState('done', 'tool_error', on('done', 'tool_error'))).toBe('error');
    expect(fireLookState('blocked', 'tool_error', on('blocked', 'tool_error'))).toBe('blocked');
  });

  it('keeps a listed program state burning when the trigger is not listed or absent', () => {
    expect(fireLookState('working', 'tool_error', on('working'))).toBe('working');
    expect(fireLookState('working', null, on('working', 'tool_error'))).toBe('working');
    expect(fireLookState('idle', null, on('working', 'tool_error'))).toBeNull();
  });
});

describe('workspaceFireState (spec 0391)', () => {
  it('is null while no window burns, so the workspace fire goes out', () => {
    expect(workspaceFireState([])).toBeNull();
    expect(workspaceFireState(new Map<number, FireState>().values())).toBeNull();
  });

  it('burns with the most urgent window state: blocked > error > done > working', () => {
    expect(workspaceFireState(['working', 'done'])).toBe('done');
    expect(workspaceFireState(['done', 'error', 'working'])).toBe('error');
    expect(workspaceFireState(['working', 'blocked', 'error'])).toBe('blocked');
  });

  it('does not depend on window order', () => {
    expect(workspaceFireState(['blocked', 'working'])).toBe('blocked');
    expect(workspaceFireState(['working', 'blocked'])).toBe('blocked');
  });
});
