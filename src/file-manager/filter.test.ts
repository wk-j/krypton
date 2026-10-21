// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { filterEntries } from './filter';
import { entry } from './test-fixtures';

describe('filterEntries', () => {
  const list = [entry('main.ts'), entry('README.md'), entry('notes.txt')];

  it('returns a new array for empty text', () => {
    const out = filterEntries(list, '');
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
  });

  it('matches an in-order subsequence, case-insensitively (P5)', () => {
    expect(filterEntries(list, 'mts').map((e) => e.name)).toEqual(['main.ts']);
    expect(filterEntries(list, 'RMD').map((e) => e.name)).toEqual(['README.md']);
    expect(filterEntries(list, 'tn')).toEqual([]); // out of order
  });

  it('returns [] when nothing matches', () => {
    expect(filterEntries(list, 'zzz')).toEqual([]);
  });
});
