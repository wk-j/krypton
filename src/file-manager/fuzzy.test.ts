// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { fuzzyScore, matchRuns, rankSearch } from './fuzzy';

describe('fuzzyScore', () => {
  it('is 0 on a miss or when the query is longer than the target', () => {
    expect(fuzzyScore('xyz', 'a')).toBe(0);
    expect(fuzzyScore('a', 'ab')).toBe(0);
  });

  it('scores consecutive, boundary, basename and prefix bonuses exactly', () => {
    // a: 1 + 5 (start); b: 1 + 2 (consecutive); +10 basename; +15 prefix
    expect(fuzzyScore('ab', 'ab')).toBe(34);
    // after '/': same total, the boundary bonus replaces the start bonus
    expect(fuzzyScore('x/ab', 'ab')).toBe(34);
    // '_' boundary, not consecutive, no prefix
    expect(fuzzyScore('a_b', 'ab')).toBe(22);
    expect(fuzzyScore('abc', 'ac')).toBe(17);
  });
});

describe('rankSearch', () => {
  it('orders by score desc, then length asc, and drops zero scores', () => {
    expect(rankSearch(['zz', 'b/ab', 'ab', 'xaxb'], ['zz', 'b/ab', 'ab', 'xaxb'], 'ab')).toEqual(['ab', 'b/ab', 'xaxb']);
  });

  it('caps at 500 and returns the pool head for an empty query', () => {
    const pool = Array.from({ length: 600 }, (_, i) => `a${i}`);
    expect(rankSearch(pool, pool, '')).toEqual(pool.slice(0, 500));
    expect(rankSearch(pool, pool, 'a')).toHaveLength(500);
  });

  it('lower-cases the query', () => {
    expect(rankSearch(['Main.ts'], ['main.ts'], 'MT')).toEqual(['Main.ts']);
  });
});

describe('matchRuns', () => {
  it('splits a path into matched / unmatched runs', () => {
    expect(matchRuns('src/main.ts', 'smt')).toEqual([
      { text: 's', matched: true },
      { text: 'rc/', matched: false },
      { text: 'm', matched: true },
      { text: 'ain.', matched: false },
      { text: 't', matched: true },
      { text: 's', matched: false },
    ]);
  });

  it('handles an unmatched first character and keeps original case', () => {
    expect(matchRuns('aBc', 'b')).toEqual([
      { text: 'a', matched: false },
      { text: 'B', matched: true },
      { text: 'c', matched: false },
    ]);
  });

  it('returns no runs for empty text', () => {
    expect(matchRuns('', 'a')).toEqual([]);
  });
});
