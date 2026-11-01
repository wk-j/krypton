import { describe, expect, it } from 'vitest';

import { remoteTitlebarStatus, shortRemoteHost } from './harness-remote-status';
import type { WorkspaceRef } from '../types';

type SshWorkspace = Extract<WorkspaceRef, { kind: 'ssh' }>;

function ssh(over: Partial<SshWorkspace> = {}): SshWorkspace {
  return {
    kind: 'ssh',
    source: 'focused_ssh',
    profile: null,
    user: 'wk',
    host: 'wks-mac-mini.tail0fc908.ts.net',
    port: 22,
    path: '/Users/wk/Source/test',
    runtimeId: 'rt-1',
    ...over,
  };
}

describe('shortRemoteHost', () => {
  it('keeps only the first DNS label of a hostname', () => {
    expect(shortRemoteHost('wks-mac-mini.tail0fc908.ts.net')).toBe('wks-mac-mini');
    expect(shortRemoteHost('devbox')).toBe('devbox');
  });

  it('never cuts an IP literal', () => {
    expect(shortRemoteHost('192.168.1.20')).toBe('192.168.1.20');
    expect(shortRemoteHost('fe80::1')).toBe('fe80::1');
  });
});

describe('remoteTitlebarStatus', () => {
  it('names the machine by short host, with the port only when it is not 22', () => {
    expect(remoteTitlebarStatus(ssh(), 'connected', null).text).toBe('wks-mac-mini');
    expect(remoteTitlebarStatus(ssh({ port: 2222 }), 'connected', null).text).toBe('wks-mac-mini:2222');
  });

  it('prefers the profile name and keeps the resolved target in the tooltip', () => {
    const status = remoteTitlebarStatus(ssh({ source: 'profile', profile: 'studio' }), 'connected', null);
    expect(status.text).toBe('studio');
    expect(status.title).toContain('wk@wks-mac-mini.tail0fc908.ts.net:22');
    expect(status.title).toContain('/Users/wk/Source/test');
  });

  it('is a quiet, non-actionable badge while connected', () => {
    const status = remoteTitlebarStatus(ssh(), 'connected', null);
    expect(status.tone).toBe('ok');
    expect(status.actionable).not.toBe(true);
  });

  it('marks connecting and closing as pending, never actionable', () => {
    for (const state of ['connecting', 'closing'] as const) {
      const status = remoteTitlebarStatus(ssh(), state, null);
      expect(status.tone).toBe('pending');
      expect(status.actionable).not.toBe(true);
      expect(status.text).toContain(state);
    }
  });

  it('turns red and actionable only when disconnected, with the reason in the tooltip', () => {
    const status = remoteTitlebarStatus(ssh(), 'disconnected', 'Connection reset by peer');
    expect(status.tone).toBe('error');
    expect(status.actionable).toBe(true);
    expect(status.text.startsWith('wks-mac-mini')).toBe(true);
    expect(status.title).toContain('Connection reset by peer');
  });
});
