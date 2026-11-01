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
    }, null);

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
    }, null);

    expect(rows[0].needsPath).toBe(true);
    expect(rows[0].pathPrefill).toBe('');
  });

  it('prefills the last path used for the destination, but the live OSC 7 cwd wins', () => {
    const ssh = { terminalSessionId: 7, user: 'root', host: 'host', port: 2222 };
    const remembered = remoteHarnessPickerRows({ focusedSsh: { ...ssh, projectDir: null }, profiles: [] }, '/srv/app');
    expect(remembered[0]).toMatchObject({
      needsPath: true,
      pathPrefill: '/srv/app',
      detail: 'root@host:2222 · last used /srv/app',
    });
    expect(remembered[0].launch).toEqual({ kind: 'focused_ssh', terminalSessionId: 7 });

    const live = remoteHarnessPickerRows({ focusedSsh: { ...ssh, projectDir: '/srv/other' }, profiles: [] }, '/srv/app');
    expect(live[0]).toMatchObject({ needsPath: false, detail: 'root@host:2222 · /srv/other' });
    expect(live[0].launch).toEqual({ kind: 'focused_ssh', terminalSessionId: 7, projectDir: '/srv/other' });
  });
});
