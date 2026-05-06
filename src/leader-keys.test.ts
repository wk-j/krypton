import { describe, expect, it } from 'vitest';

import { GLOBAL_LEADER_RESERVED_KEYS, validateLocalLeaderKeys } from './leader-keys';
import { MARKDOWN_LEADER_KEYS } from './markdown-view';

import type { LeaderKeyConflictGroup } from './leader-keys';

const LOCAL_LEADER_KEY_GROUPS: readonly LeaderKeyConflictGroup[] = [
  { owner: 'markdown', keys: MARKDOWN_LEADER_KEYS },
];

describe('leader key metadata', () => {
  it('keeps local leader keys conflict-free against global and other local keys', () => {
    expect(validateLocalLeaderKeys(LOCAL_LEADER_KEY_GROUPS)).toEqual([]);
  });

  it('reserves existing global compositor keys', () => {
    for (const key of ['o', 'O', 'h', 'H', 'Alt+h', 'Alt+x', '1', '9']) {
      expect(GLOBAL_LEADER_RESERVED_KEYS.has(key)).toBe(true);
    }
  });
});
