import { describe, expect, it } from 'vitest';

import {
  HEADER_SCOPE_EPS,
  HEADER_SCOPE_MIN_KICK,
  headerScopeEnergyBump,
} from './header-scope';

describe('headerScopeEnergyBump', () => {
  it('a 4-char model chunk exceeds the silence floor (the harness-stream bug)', () => {
    // Pre-fix: 4 / 512 = 0.0078, which is below EPS 0.02, so the rAF loop
    // drew one idle hairline and stopped — streaming looked like a dead band.
    const energy = headerScopeEnergyBump(0, 4);
    expect(4 / 512).toBeLessThan(HEADER_SCOPE_EPS);
    expect(energy).toBeGreaterThan(HEADER_SCOPE_EPS);
    expect(energy).toBe(HEADER_SCOPE_MIN_KICK);
  });

  it('zero bytes does not raise energy or fake a kick', () => {
    expect(headerScopeEnergyBump(0.2, 0)).toBe(0.2);
    expect(headerScopeEnergyBump(0, -1)).toBe(0);
  });

  it('large PTY bursts still scale with byte count and cap at 1', () => {
    expect(headerScopeEnergyBump(0, 256)).toBeCloseTo(0.5, 5);
    expect(headerScopeEnergyBump(0, 512)).toBe(1);
    expect(headerScopeEnergyBump(0.7, 512)).toBe(1);
  });

  it('sustained token chunks accumulate instead of resetting', () => {
    const once = headerScopeEnergyBump(0, 8);
    const twice = headerScopeEnergyBump(once, 8);
    expect(twice).toBeCloseTo(Math.min(1, HEADER_SCOPE_MIN_KICK * 2), 5);
  });
});
