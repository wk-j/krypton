import { describe, expect, it } from 'vitest';
import { parseMentionFanOut } from './mention-parse';

describe('parseMentionFanOut', () => {
  const roster = ['Cursor-1', 'Claude-1', 'Codex-1'];

  it('parses leading mentions and body', () => {
    const r = parseMentionFanOut('@Claude-1 @Codex-1 sync or async?', 'Cursor-1', roster);
    expect(r).toEqual({ targets: ['Claude-1', 'Codex-1'], body: 'sync or async?' });
  });

  it('rejects unknown lane all-or-nothing', () => {
    const r = parseMentionFanOut('@Claude-1 @Typo question', 'Cursor-1', roster);
    expect(r).toEqual({ kind: 'unknown_lane', token: '@Typo' });
  });

  it('rejects self-only targets', () => {
    const r = parseMentionFanOut('@Cursor-1 alone', 'Cursor-1', roster);
    expect(r).toEqual({ kind: 'self_only' });
  });
});
