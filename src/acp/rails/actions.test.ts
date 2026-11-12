import { describe, expect, it } from 'vitest';

import { railsDockActions, type RailsDockActionsInput } from './actions';
import type { RailsSendSet } from './envelope';
import type { RailsSnapshot } from './types';

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

/** Only `keys` and `label` reach the Send button. */
function sendSet(keys: readonly string[], label: string): RailsSendSet {
  return { run: null, manual: [], keys, label };
}

const OPEN_3 = sendSet(['run:r2'], '3 open findings');

const IDLE_LANE = { displayName: 'codex-1', status: 'idle', hasClient: true };

function input(over: Partial<RailsDockActionsInput> = {}): RailsDockActionsInput {
  return {
    snapshot: SNAPSHOT,
    mode: 'auto',
    progress: { kind: 'idle' },
    running: false,
    checkInFlight: null,
    sendSet: OPEN_3,
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

  it('names the auto checks on Run, and holds Run and every RUN key while a manual check runs (spec 368)', () => {
    const idle = railsDockActions(input());
    expect(idle.states.now.state).toEqual({ kind: 'idle', detail: 'Run the auto checks and the judge now (#rails now · r)' });
    expect(idle.checkDisabledReason).toBeNull();

    const checking = railsDockActions(input({ checkInFlight: 'osv' }));
    expect(checking.states.now.state.kind).toBe('idle');
    expect(checking.states.now.disabledReason).toBe('a run is already in progress');
    expect(checking.checkDisabledReason).toBe('a run is already in progress');

    expect(railsDockActions(input({ running: true })).checkDisabledReason).toBe('a run is already in progress');
    expect(railsDockActions(input({ mode: 'off' })).checkDisabledReason).toBe('rails is off · #rails manual');
    expect(railsDockActions(input({ snapshot: { ...SNAPSHOT, trust: 'changed' } })).checkDisabledReason)
      .toBe('not trusted · #rails trust');
  });

  it('marks Send done while the set holds nothing unsent (spec 368 amendment A)', () => {
    const mark = { keys: ['run:r2', 'check:osv@t1'], label: '3 open findings and failed osv', laneName: 'claude-1', at: AT_1402 };
    const done = {
      kind: 'done',
      badge: '✓ 14:02',
      detail: '3 open findings and failed osv sent to claude-1 2026-10-29 14:02',
    };
    const sent = railsDockActions(input({ lastSend: mark, sendSet: sendSet(mark.keys, mark.label) })).states.send;
    expect(sent.state).toEqual(done);
    expect(sent.disabledReason).toBeNull();

    // A clean run after the send leaves only osv, which was sent: still done.
    expect(railsDockActions(input({ lastSend: mark, sendSet: sendSet(['check:osv@t1'], 'failed osv') })).states.send.state)
      .toEqual(done);

    // A newer run's findings, or a newer osv failure, are unsent.
    expect(railsDockActions(input({ lastSend: mark, sendSet: sendSet(['run:r3', 'check:osv@t1'], '3 open findings and failed osv') }))
      .states.send.state).toEqual({
      kind: 'idle',
      detail: 'Send 3 open findings and failed osv to codex-1 (#rails send · s on the head row)',
    });
    expect(railsDockActions(input({ lastSend: mark, sendSet: sendSet(['check:osv@t2'], 'failed osv') })).states.send.state)
      .toEqual({ kind: 'idle', detail: 'Send failed osv to codex-1 (#rails send · s on the head row)' });
  });

  it('disables Send with nothing to send or without a lane', () => {
    const mark = { keys: ['run:r2'], label: '3 open findings', laneName: 'claude-1', at: AT_1402 };
    const empty = railsDockActions(input({ lastSend: mark, sendSet: sendSet([], '') })).states.send;
    expect(empty.disabledReason).toBe('no open findings or failed checks');
    expect(empty.state.kind).toBe('idle');
    expect(railsDockActions(input({ activeLane: null })).states.send.disabledReason).toBe('no active lane');
  });

  // Spec 368 amendment B: a failed auto check with no open finding is something to send.
  it('enables Send for a run whose only fault is a failed check', () => {
    const send = railsDockActions(input({ sendSet: sendSet(['run:r4'], 'failed typecheck') })).states.send;
    expect(send.disabledReason).toBeNull();
    expect(send.state).toEqual({ kind: 'idle', detail: 'Send failed typecheck to codex-1 (#rails send · s on the head row)' });
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
