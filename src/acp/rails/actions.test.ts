import { describe, expect, it } from 'vitest';

import { railsDockActions, type RailsDockActionsInput } from './actions';
import type { RailsRunRecord, RailsSnapshot } from './types';

// Spec 344 §State rules for the Rails dock's action buttons.

const NOW = new Date(2026, 9, 29, 16, 30).getTime();
const AT_1402 = new Date(2026, 9, 29, 14, 2).getTime();

const SNAPSHOT = {
  present: true,
  trust: 'trusted',
  checks: [
    { name: 'typecheck', argv: ['npx', 'tsc'], timeoutS: 300 },
    { name: 'arch', argv: ['npx', 'vitest'], timeoutS: 300 },
  ],
} as unknown as RailsSnapshot;

function run(runId: string, open: number): RailsRunRecord {
  return { runId, open: Array.from({ length: open }, (_unused, i) => ({ key: `k${i}` })) } as unknown as RailsRunRecord;
}

const IDLE_LANE = { displayName: 'codex-1', status: 'idle', hasClient: true };

function input(over: Partial<RailsDockActionsInput> = {}): RailsDockActionsInput {
  return {
    snapshot: SNAPSHOT,
    mode: 'auto',
    progress: { kind: 'idle' },
    running: false,
    latest: run('r2', 3),
    lastSend: null,
    activeLane: IDLE_LANE,
    updateLane: null,
    now: NOW,
    ...over,
  };
}

describe('railsDockActions', () => {
  it('shows the check in progress on a running Run and keeps it disabled', () => {
    const checking = railsDockActions(input({
      running: true,
      progress: { kind: 'checking', index: 2, total: 3, name: 'typecheck' },
    })).states.now;
    expect(checking.state).toMatchObject({ kind: 'running', badge: 'check 2/3 typecheck' });
    expect(checking.disabledReason).toBe('a run is already in progress');

    // Before the first check a held/cooling line is stale, not progress.
    const probing = railsDockActions(input({ running: true, progress: { kind: 'held', until: NOW } })).states.now;
    expect(probing.state).toMatchObject({ kind: 'running', badge: 'running' });
  });

  it('disables Run while rails is off and says a run without trust is judge only', () => {
    const off = railsDockActions(input({ mode: 'off' })).states.now;
    expect(off.disabledReason).toBe('rails is off · #rails manual');

    const untrusted = railsDockActions(input({ snapshot: { ...SNAPSHOT, trust: 'untrusted' } })).states.now;
    expect(untrusted.state).toEqual({ kind: 'idle', detail: 'Judge only — checks wait for trust (#rails now · r)' });
    expect(untrusted.disabledReason).toBeNull();
  });

  it('marks Send done only for the run whose findings were sent', () => {
    const mark = { runId: 'r2', laneName: 'claude-1', count: 3, at: AT_1402 };
    const sent = railsDockActions(input({ lastSend: mark })).states.send;
    expect(sent.state).toEqual({
      kind: 'done',
      badge: '✓ 14:02',
      detail: '3 findings sent to claude-1 2026-10-29 14:02',
    });
    expect(sent.disabledReason).toBeNull();

    const newer = railsDockActions(input({ lastSend: mark, latest: run('r3', 3) })).states.send;
    expect(newer.state).toEqual({
      kind: 'idle',
      detail: 'Send 3 open findings to codex-1 (#rails send · s on the head row)',
    });
  });

  it('disables Send without an open finding or without a lane', () => {
    expect(railsDockActions(input({ latest: run('r2', 0) })).states.send.disabledReason).toBe('no open findings');
    expect(railsDockActions(input({ latest: null })).states.send.disabledReason).toBe('no open findings');
    expect(railsDockActions(input({ activeLane: null })).states.send.disabledReason).toBe('no active lane');
  });

  it('shows Trust done when trusted and names a changed manifest otherwise', () => {
    expect(railsDockActions(input()).states.trust.state).toEqual({
      kind: 'done',
      badge: '✓ trusted',
      detail: 'rails.toml is trusted · 2 checks may run',
    });
    expect(railsDockActions(input({ snapshot: { ...SNAPSHOT, trust: 'changed' } })).states.trust.state).toEqual({
      kind: 'idle',
      detail: 'rails.toml changed since trust — allow the 2 checks listed above (#rails trust)',
    });
  });

  it('runs Update in the labelled lane and gates a new one on the active lane', () => {
    const elsewhere = railsDockActions(input({ updateLane: 'claude-1' })).states.update;
    expect(elsewhere.state).toMatchObject({ kind: 'running', badge: 'running · claude-1' });
    expect(elsewhere.disabledReason).toBeNull();

    const busy = railsDockActions(input({ activeLane: { ...IDLE_LANE, status: 'busy' } }));
    expect(busy.states.update.disabledReason).toBe('codex-1 is busy');
    expect(busy.laneLine).toBe('lane codex-1 · busy');
    // Send queues on the lane's next idle, so a busy lane does not block it.
    expect(busy.states.send.disabledReason).toBeNull();

    expect(railsDockActions(input({ activeLane: null })).laneLine).toBe('no active lane');
  });
});
