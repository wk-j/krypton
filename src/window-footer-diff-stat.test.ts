import { describe, expect, it } from 'vitest';

import { diffStatBadge, type WorkingDiffStat } from './window-footer-diff-stat';

const stat = (over: Partial<WorkingDiffStat> = {}): WorkingDiffStat => ({
  repoRoot: '/Users/wk/Source/krypton',
  files: 1,
  added: 0,
  removed: 0,
  truncated: false,
  ...over,
});

describe('diffStatBadge', () => {
  it('says nothing when there is nothing to report', () => {
    expect(diffStatBadge(null)).toBeNull();
    expect(diffStatBadge(undefined)).toBeNull();
    expect(diffStatBadge(stat({ files: 0 }))).toBeNull();
  });

  it('renders both tokens and a file count', () => {
    expect(diffStatBadge(stat({ files: 9, added: 214, removed: 37 }))).toEqual({
      added: '+214',
      removed: '-37',
      title: 'working tree vs HEAD: +214 -37 across 9 files',
    });
  });

  it('keeps a zero half so the pair still reads as a diff', () => {
    expect(diffStatBadge(stat({ added: 0, removed: 37 }))?.added).toBe('+0');
    expect(diffStatBadge(stat({ added: 214, removed: 0 }))?.removed).toBe('-0');
  });

  it('singularizes a one-file change', () => {
    expect(diffStatBadge(stat({ files: 1, added: 2 }))?.title).toContain('across 1 file');
  });

  it('abbreviates past a thousand, bounding each token at five characters', () => {
    expect(diffStatBadge(stat({ added: 999, removed: 1000 }))).toMatchObject({
      added: '+999',
      removed: '-1.0k',
    });
    expect(diffStatBadge(stat({ added: 1234, removed: 9999 }))).toMatchObject({
      added: '+1.2k',
      removed: '-9.9k',
    });
    expect(diffStatBadge(stat({ added: 12_345, removed: 987_654 }))).toMatchObject({
      added: '+12k',
      removed: '-987k',
    });
  });

  it('never rounds a lower bound upward', () => {
    expect(diffStatBadge(stat({ added: 1990 }))?.added).toBe('+1.9k');
    expect(diffStatBadge(stat({ added: 9999 }))?.added).toBe('+9.9k');
  });

  it('keeps the exact counts in the tooltip when the display is abbreviated', () => {
    expect(diffStatBadge(stat({ files: 3, added: 12_345, removed: 6789 }))?.title).toBe(
      'working tree vs HEAD: +12345 -6789 across 3 files',
    );
  });

  it('admits in the tooltip when counts are a lower bound', () => {
    expect(diffStatBadge(stat({ added: 5, truncated: true }))?.title).toContain(
      'partial — large or binary files skipped',
    );
  });

  it('tolerates a malformed payload rather than rendering NaN', () => {
    expect(diffStatBadge(stat({ added: -4, removed: 2.7 }))).toMatchObject({
      added: '+0',
      removed: '-2',
    });
  });
});
