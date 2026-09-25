import { describe, expect, it, vi } from 'vitest';

import { createTicketSync, formatTicketBytes, githubIssueUrl } from './ticket-sync.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('popup ticket sync', () => {
  it('keeps a late response from the previous lane off the current ticket', async () => {
    const first = deferred();
    const second = deferred();
    const states = [];
    const request = vi.fn((lane) => lane === 'Claude-1' ? first.promise : second.promise);
    const sync = createTicketSync(request, (state) => states.push(state));

    const oldLoad = sync.selectLane('Claude-1');
    const newLoad = sync.selectLane('Codex-1');
    second.resolve({ ok: true, snapshot: { ticket: { id: 'codex-ticket' } } });
    await newLoad;
    first.resolve({ ok: true, snapshot: { ticket: { id: 'claude-ticket' } } });
    await oldLoad;

    expect(states.at(-1)).toEqual({ kind: 'ready', ticket: { id: 'codex-ticket' } });
    expect(states).not.toContainEqual({ kind: 'ready', ticket: { id: 'claude-ticket' } });
  });

  it('coalesces refreshes, then shows clear and recovery without a cached ticket', async () => {
    const first = deferred();
    const request = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true, snapshot: { ticket: null } })
      .mockResolvedValueOnce({ ok: false, error: 'unavailable' })
      .mockResolvedValueOnce({ ok: true, snapshot: { ticket: { id: 'restored' } } });
    const states = [];
    const sync = createTicketSync(request, (state) => states.push(state));

    const initial = sync.selectLane('Codex-1');
    await sync.refresh();
    expect(request).toHaveBeenCalledTimes(1);
    first.resolve({ ok: true, snapshot: { ticket: { id: 'first' } } });
    await initial;
    await sync.refresh();
    await sync.refresh();
    await sync.refresh();
    expect(states.slice(-4)).toEqual([
      { kind: 'ready', ticket: { id: 'first' } },
      { kind: 'ready', ticket: null },
      { kind: 'error', error: 'unavailable' },
      { kind: 'ready', ticket: { id: 'restored' } },
    ]);
  });

  it('accepts only canonical GitHub issue links and formats resource sizes', () => {
    expect(githubIssueUrl('https://github.com/acme/terminal/issues/42'))
      .toBe('https://github.com/acme/terminal/issues/42');
    expect(githubIssueUrl('https://github.com.evil.example/acme/terminal/issues/42')).toBeNull();
    expect(githubIssueUrl('javascript:alert(1)')).toBeNull();
    expect(formatTicketBytes(1536)).toBe('1.5 KiB');
  });
});
