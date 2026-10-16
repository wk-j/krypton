import { describe, expect, it } from 'vitest';

import { linkLabel, linkTooltip, type BackendLinkEntry } from './workspace-footer-link';

const base: BackendLinkEntry = {
  label: 'xenon',
  baseUrl: 'https://x.example',
  project: 'krypton',
  state: 'linked',
  detail: null,
  latencyMs: 42,
  checkedAt: 0,
};

describe('linkLabel', () => {
  it('shows latency only in detail density', () => {
    expect(linkLabel(base, false)).toBe('xenon');
    expect(linkLabel(base, true)).toBe('xenon 42ms');
    expect(linkLabel({ ...base, latencyMs: null }, true)).toBe('xenon');
  });

  it('shows the fault word for faulted states', () => {
    expect(linkLabel({ ...base, state: 'unauthorized' }, true)).toBe('xenon auth');
    expect(linkLabel({ ...base, state: 'offline' }, true)).toBe('xenon offline');
  });
});

describe('linkTooltip', () => {
  it('names the server and the fix', () => {
    expect(linkTooltip(base)).toBe('xenon: linked\nhttps://x.example · project krypton\nnot yet checked');
    const offline = linkTooltip({ ...base, state: 'offline', detail: 'ECONNREFUSED' }).split('\n');
    expect(offline[3]).toBe('ECONNREFUSED');
    expect(offline[4]).toBe('server unreachable at https://x.example — press ⌘P X to re-probe');
    const auth = linkTooltip({ ...base, state: 'unauthorized', baseUrl: '', project: '' }).split('\n');
    expect(auth[1]).toBe('(no base_url) · project (none)');
    expect(auth[3]).toBe('token rejected — store a new one with #xenon token <token>');
  });
});
