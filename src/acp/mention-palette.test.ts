import { describe, expect, it } from 'vitest';
import {
  applyMentionSelection,
  filteredMentionTargets,
  mentionPaletteContext,
  mentionPaletteVisible,
} from './mention-palette';

describe('mentionPaletteContext', () => {
  it('detects partial token at start', () => {
    expect(mentionPaletteContext('@Cl', 3)).toEqual({ atIndex: 0, prefix: 'Cl' });
  });

  it('detects second mention token', () => {
    expect(mentionPaletteContext('@Claude-1 @Co', 13)).toEqual({ atIndex: 10, prefix: 'Co' });
  });

  it('rejects @ in body after message text', () => {
    expect(mentionPaletteContext('hello @cl', 9)).toBeNull();
  });
});

describe('filteredMentionTargets', () => {
  it('filters by prefix and excludes self', () => {
    const names = filteredMentionTargets(
      ['Cursor-1', 'Claude-1', 'Codex-1'],
      'Cursor-1',
      'Cl',
    );
    expect(names).toEqual(['Claude-1']);
  });
});

describe('applyMentionSelection', () => {
  it('inserts display name and trailing space', () => {
    const r = applyMentionSelection('@Cl', 3, 'Claude-1');
    expect(r).toEqual({ draft: '@Claude-1 ', cursor: 10 });
  });
});

describe('mentionPaletteVisible', () => {
  it('requires non-dismissed roster', () => {
    expect(mentionPaletteVisible('@', 1, false, 2)).toBe(true);
    expect(mentionPaletteVisible('@', 1, true, 2)).toBe(false);
  });
});
