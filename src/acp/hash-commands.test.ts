import { describe, expect, it } from 'vitest';
import {
  HASH_COMMANDS,
  filteredHashCommands,
  hashPaletteVisible,
} from './hash-commands';

describe('hashPaletteVisible', () => {
  it('shows on a bare # at the start', () => {
    expect(hashPaletteVisible('#', false)).toBe(true);
  });

  it('shows while typing a command token', () => {
    expect(hashPaletteVisible('#rev', false)).toBe(true);
    expect(hashPaletteVisible('#new!', false)).toBe(true);
  });

  it('hides once a space (arguments) is typed', () => {
    expect(hashPaletteVisible('#review ', false)).toBe(false);
    expect(hashPaletteVisible('#recall what', false)).toBe(false);
  });

  it('hides when # is not at the start', () => {
    expect(hashPaletteVisible('see #review', false)).toBe(false);
    expect(hashPaletteVisible('', false)).toBe(false);
  });

  it('stays hidden when dismissed', () => {
    expect(hashPaletteVisible('#rev', true)).toBe(false);
  });
});

describe('filteredHashCommands', () => {
  it('returns every command for a bare #', () => {
    expect(filteredHashCommands('#')).toEqual(HASH_COMMANDS);
  });

  it('filters by case-insensitive prefix', () => {
    expect(filteredHashCommands('#RE').map((c) => c.name)).toEqual([
      'restart',
      'resume',
      'recall',
      'review',
    ]);
  });

  it('matches the bang variant', () => {
    expect(filteredHashCommands('#new').map((c) => c.name)).toEqual(['new', 'new!']);
  });

  it('returns nothing for an unknown prefix or non-palette draft', () => {
    expect(filteredHashCommands('#zzz')).toEqual([]);
    expect(filteredHashCommands('not a command')).toEqual([]);
  });
});
