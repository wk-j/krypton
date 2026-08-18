import { describe, expect, it } from 'vitest';

import {
  THOUGHT_TELETYPE_FRESH,
  THOUGHT_TELETYPE_MAX_BEHIND,
  nextCodePointIndex,
  prefersReducedMotion,
  splitTeletypePaint,
  stepThoughtTeletype,
} from './harness-thought-teletype';

const delta = { reducedMotion: false, phase: 'delta' as const };

describe('nextCodePointIndex', () => {
  it('advances one code unit for BMP characters', () => {
    expect(nextCodePointIndex('abc', 0)).toBe(1);
    expect(nextCodePointIndex('abc', 2)).toBe(3);
    expect(nextCodePointIndex('abc', 3)).toBe(3);
  });

  it('does not split a surrogate pair', () => {
    const source = 'ok👍!';
    const at = source.indexOf('👍');
    expect(nextCodePointIndex(source, at)).toBe(at + 2);
  });
});

describe('stepThoughtTeletype', () => {
  it('ticks one code point when the gap is within MAX_BEHIND', () => {
    const source = 'hello world';
    const next = stepThoughtTeletype({ source, shown: 3 }, delta);
    expect(next).toEqual({ source, shown: 4 });
  });

  it('bursts to source.length - FRESH when the gap exceeds MAX_BEHIND', () => {
    const source = 'x'.repeat(THOUGHT_TELETYPE_MAX_BEHIND + THOUGHT_TELETYPE_FRESH + 8);
    const next = stepThoughtTeletype({ source, shown: 0 }, delta);
    expect(next.shown).toBe(source.length - THOUGHT_TELETYPE_FRESH);
    expect(source.length - next.shown).toBeLessThanOrEqual(THOUGHT_TELETYPE_MAX_BEHIND);
  });

  it('snaps when the source shrinks', () => {
    const next = stepThoughtTeletype({ source: 'hi', shown: 8 }, delta);
    expect(next).toEqual({ source: 'hi', shown: 2 });
  });

  it('snaps on seal, veil, and reduced motion', () => {
    const source = 'streaming now';
    expect(stepThoughtTeletype({ source, shown: 2 }, { reducedMotion: false, phase: 'seal' }).shown)
      .toBe(source.length);
    expect(stepThoughtTeletype({ source, shown: 2 }, { reducedMotion: false, phase: 'veil' }).shown)
      .toBe(source.length);
    expect(stepThoughtTeletype({ source, shown: 2 }, { reducedMotion: true, phase: 'delta' }).shown)
      .toBe(source.length);
  });
});

describe('splitTeletypePaint', () => {
  it('keeps the last FRESH glyphs in the fresh window', () => {
    const source = 'abcdefghijklmnop';
    expect(splitTeletypePaint(source, 12)).toEqual({
      ghost: 'ab',
      fresh: 'cdefghijkl',
    });
  });

  it('clamps shown to the source and treats a short string as all-fresh', () => {
    expect(splitTeletypePaint('hey', 99)).toEqual({ ghost: '', fresh: 'hey' });
    expect(splitTeletypePaint('hey', 0)).toEqual({ ghost: '', fresh: '' });
  });
});

describe('prefersReducedMotion', () => {
  it('is false when matchMedia is missing or does not match', () => {
    expect(prefersReducedMotion({})).toBe(false);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: true }) })).toBe(true);
  });
});
