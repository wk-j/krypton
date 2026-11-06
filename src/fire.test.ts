import { describe, expect, it } from 'vitest';

import { FIRE, fireBand, fireEmbers, stepHeat } from './fire';

const EMBER_FLOATS = FIRE.embers * 8;

describe('fireEmbers', () => {
  const band = fireBand(900, 600);

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
  it('never extends past the content area', () => {
    for (const h of [0, 30, 90, 180, 400, 2000]) {
      expect(fireBand(800, h).cssHeight).toBeLessThanOrEqual(h);
    }
  });

  it('keeps flame height within 40–120 px', () => {
    expect(fireBand(800, 100).flameMax).toBe(40);
    expect(fireBand(800, 400).flameMax).toBeCloseTo(88);
    expect(fireBand(800, 2000).flameMax).toBe(120);
  });
});
