import { describe, expect, it } from 'vitest';

import { remoteHarnessPickerRows } from './remote-harness-picker';

describe('remoteHarnessPickerRows', () => {
  it('places the focused SSH session before configured profiles', () => {
    const rows = remoteHarnessPickerRows({
      focusedSsh: {
        terminalSessionId: 4,
        user: 'wk',
        host: 'buildbox',
        port: 22,
        projectDir: '/srv/krypton',
      },
      profiles: [{
        name: 'staging',
        host: 'staging',
        project_dir: '/work/krypton',
        connect_timeout_seconds: 15,
      }],
    });

    expect(rows.map((row) => row.label)).toEqual(['Current SSH', 'staging']);
    expect(rows[0].needsPath).toBe(false);
  });

  it('marks a focused SSH session without passive CWD as needing a path', () => {
    const rows = remoteHarnessPickerRows({
      focusedSsh: {
        terminalSessionId: 7,
        user: 'root',
        host: 'host',
        port: 2222,
        projectDir: null,
      },
      profiles: [],
    });

    expect(rows[0].needsPath).toBe(true);
  });
});
