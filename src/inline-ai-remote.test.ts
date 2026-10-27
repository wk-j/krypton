import { describe, expect, it } from 'vitest';

import { hostExecCommand, inlineRemoteMcpServers, remoteHostBlock, remoteLabel, type InlineRemote } from './inline-ai-remote';

const ON: InlineRemote = {
  kind: 'on',
  port: 4123,
  info: { token: 'tok', display: 'deploy@web-01', host: 'web-01', shell: 'bash', cwd: '/srv/app' },
};
const OFF: InlineRemote = { kind: 'off', target: 'deploy@web-01', reason: 'ssh to deploy@web-01 failed: Permission denied (publickey,password).' };

describe('remoteHostBlock', () => {
  it('tells the agent where commands run, how to check the host, and its shell and cwd', () => {
    const block = remoteHostBlock(ON);
    expect(block).toContain('SSH session on deploy@web-01');
    expect(block).toContain('Your own Bash tool runs on this Mac. To check anything on web-01, call the host_exec tool.');
    expect(block).toContain('no git, globs, redirects, $VAR, ~, cd');
    expect(block).toContain('shell: bash (web-01 $SHELL)');
    expect(block).toContain('cwd: /srv/app (web-01, from OSC 7)');
  });

  it('says the cwd is unknown when OSC 7 did not report one for this host', () => {
    const block = remoteHostBlock({ ...ON, info: { ...ON.info, cwd: null, shell: null } });
    expect(block).toContain('cwd on web-01: unknown (host_exec runs in $HOME; use absolute paths)');
    expect(block).toContain('shell: unknown (web-01 $SHELL)');
  });

  it('says checks are unavailable, and why, when the channel did not open', () => {
    const block = remoteHostBlock(OFF);
    expect(block).toContain('Remote checks are unavailable: ssh to deploy@web-01 failed: Permission denied (publickey,password).');
    expect(block).not.toContain('host_exec');
  });
});

describe('inlineRemoteMcpServers', () => {
  it('serves host_exec over the hook server with the capability header', () => {
    expect(inlineRemoteMcpServers(ON)).toEqual([{
      name: 'krypton_inline',
      type: 'http',
      url: 'http://127.0.0.1:4123/mcp/inline',
      headers: [{ name: 'x-krypton-inline-capability', value: 'tok' }],
    }]);
  });

  it('gives no server when the channel is down or the pane is local', () => {
    expect(inlineRemoteMcpServers(OFF)).toEqual([]);
    expect(inlineRemoteMcpServers(null)).toEqual([]);
  });
});

describe('hostExecCommand', () => {
  it('reads the command of a host_exec call only', () => {
    expect(hostExecCommand('mcp__krypton_inline__host_exec', { command: 'df -h' })).toBe('df -h');
    expect(hostExecCommand('mcp__other__host_exec', { command: 'df -h' })).toBeNull();
    expect(hostExecCommand('mcp__krypton_inline__host_exec', {})).toBeNull();
  });
});

describe('remoteLabel', () => {
  it('names the host or says checks are off', () => {
    expect(remoteLabel(ON)).toBe('checks on web-01');
    expect(remoteLabel(OFF)).toBe('no remote checks');
  });
});
