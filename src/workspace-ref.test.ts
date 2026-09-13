import { describe, expect, it } from 'vitest';

import { workspaceKey, type WorkspaceRef } from './types';

describe('workspaceKey', () => {
  it('qualifies equal remote paths by host and user', () => {
    const first: WorkspaceRef = {
      kind: 'ssh',
      source: 'profile',
      profile: 'one',
      user: 'alice',
      host: 'build-a',
      port: 22,
      path: '/srv/repo',
      runtimeId: 'rh-1',
    };
    const second: WorkspaceRef = { ...first, host: 'build-b', runtimeId: 'rh-2' };

    expect(workspaceKey(first)).not.toBe(workspaceKey(second));
    expect(workspaceKey(first)).not.toContain('rh-1');
  });
});
