// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { sortEntries } from './sort';
import { dir, entry } from './test-fixtures';

const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name);

describe('sortEntries', () => {
  const list = [
    entry('b.txt', { size: 5, modified: 3 }),
    dir('Zed', { modified: 1 }),
    entry('A.txt', { size: 50, modified: 1 }),
    dir('alpha', { modified: 9 }),
    entry('c.txt', { size: 1, modified: 2 }),
  ];

  it('puts directories first under every field and order', () => {
    for (const field of ['name', 'size', 'modified'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const out = sortEntries(list, field, order);
        expect(out.slice(0, 2).every((e) => e.is_dir)).toBe(true);
      }
    }
  });

  it('sorts names case-insensitively and reverses on desc', () => {
    expect(names(sortEntries(list, 'name', 'asc'))).toEqual(['alpha', 'Zed', 'A.txt', 'b.txt', 'c.txt']);
    expect(names(sortEntries(list, 'name', 'desc'))).toEqual(['Zed', 'alpha', 'c.txt', 'b.txt', 'A.txt']);
  });

  it('sorts by size and modified', () => {
    expect(names(sortEntries(list, 'size', 'asc')).slice(2)).toEqual(['c.txt', 'b.txt', 'A.txt']);
    expect(names(sortEntries(list, 'modified', 'desc')).slice(2)).toEqual(['b.txt', 'c.txt', 'A.txt']);
  });

  it('is stable: ties keep the input order, and the input is not mutated', () => {
    const ties = [entry('x', { size: 1 }), entry('y', { size: 1 }), entry('z', { size: 1 })];
    expect(names(sortEntries(ties, 'size', 'desc'))).toEqual(['x', 'y', 'z']);
    const copy = [...list];
    sortEntries(list, 'name', 'asc');
    expect(list).toEqual(copy);
  });
});
