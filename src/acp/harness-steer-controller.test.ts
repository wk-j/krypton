import { describe, expect, it } from 'vitest';

import { codexThreadState } from './client';
import { HarnessSteerController } from './harness-steer-controller';
import type { HarnessSteerHost } from './harness-view-host';
import type { HarnessLane, HarnessTranscriptItem, QueuedPrompt } from './harness-view-types';
import type { SteerOutcome, StopReason } from './types';

interface FakeLane {
  id: string;
  status: string;
  spawnEpoch: number;
  supportsSteering: boolean;
  client: FakeClient['client'] | null;
  transcript: HarnessTranscriptItem[];
  queuedPrompts: QueuedPrompt[];
  pendingUserEcho: { itemId: string; text: string; received: string } | null;
  cancelRequestedAt: number | null;
}

type SteerReply = { outcome: SteerOutcome; requestId: number | null };
type FakeClient = ReturnType<typeof fakeClient>;

/** A client whose steer() replies the test settles by hand, in any order. */
function fakeClient() {
  const pending: Array<{ resolve: (r: SteerReply) => void; reject: (e: unknown) => void }> = [];
  let cancels = 0;
  const client = {
    steer: () => new Promise<SteerReply>((resolve, reject) => { pending.push({ resolve, reject }); }),
    cancel: async () => { cancels++; },
  };
  return { client, pending, cancels: () => cancels };
}

function setup(over: Partial<FakeLane> = {}) {
  const fc = fakeClient();
  const lane: FakeLane = {
    id: 'lane-1',
    status: 'busy',
    spawnEpoch: 1,
    supportsSteering: true,
    client: fc.client,
    transcript: [],
    queuedPrompts: [],
    pendingUserEcho: null,
    cancelRequestedAt: null,
    ...over,
  };
  const chips: string[] = [];
  const finished: StopReason[] = [];
  const drains: string[] = [];
  let nextId = 0;
  const host: HarnessSteerHost = {
    element: {} as HTMLElement,
    lanes: [lane as unknown as HarnessLane],
    activeLaneId: lane.id,
    flashChip: (text) => chips.push(text),
    render: () => {},
    sealStreaming: () => {},
    appendTranscript: (l, kind, text, metadata = {}) => {
      const item = { id: `row-${nextId++}`, kind, text, ...metadata } as HarnessTranscriptItem;
      l.transcript.push(item);
      return item;
    },
    removeTranscriptItem: (l, itemId) => {
      l.transcript = l.transcript.filter((entry) => entry.id !== itemId);
    },
    steerBlocks: (text) => [{ type: 'text', text }],
    finishTurn: (_l, stopReason) => finished.push(stopReason),
    drainPromptQueue: (l) => drains.push(l.id),
  };
  const ctl = new HarnessSteerController(host);
  const asLane = lane as unknown as HarnessLane;
  // Stream-order helpers: what the Rust reader / codex-acp emit.
  const stream = {
    active: () => ctl.onTurnState(asLane, 'active'),
    idle: () => ctl.onTurnState(asLane, 'idle'),
    promptReply: (id = 100) => ctl.onTurnMarker(asLane, 'prompt', id, null),
    steerReply: (id: number, outcome: SteerOutcome) => ctl.onTurnMarker(asLane, 'steer', id, outcome),
  };
  return { lane, asLane, ctl, fc, chips, finished, drains, stream };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('HarnessSteerController (spec 278)', () => {
  it('steers only a busy lane whose adapter advertised steering', () => {
    const { asLane, lane, ctl } = setup();
    expect(ctl.canSteer(asLane)).toBe(true);
    lane.supportsSteering = false;
    expect(ctl.canSteer(asLane)).toBe(false);
    lane.supportsSteering = true;
    lane.status = 'needs_permission';
    expect(ctl.canSteer(asLane)).toBe(false);
    lane.status = 'busy';
    lane.client = null;
    expect(ctl.canSteer(asLane)).toBe(false);
  });

  it('shows a pending steer row that settles to taken on injected', async () => {
    const { asLane, lane, ctl, fc, chips } = setup();
    const done = ctl.steer(asLane, 'do the middleware first', []);
    expect(lane.transcript[0]).toMatchObject({ kind: 'user', text: 'do the middleware first', steer: 'pending' });
    expect(lane.pendingUserEcho?.itemId).toBe(lane.transcript[0].id);
    fc.pending[0].resolve({ outcome: 'injected', requestId: 1 });
    await done;
    expect(lane.transcript[0].steer).toBe('injected');
    expect(lane.queuedPrompts).toEqual([]);
    expect(chips).toContain('steered');
  });

  it('re-queues a missed steer at the head of the queue and drops its row', async () => {
    const { asLane, lane, ctl, fc, chips } = setup();
    lane.queuedPrompts.push({ text: 'later', images: [], mentionTargets: [] });
    const done = ctl.steer(asLane, 'now', []);
    fc.pending[0].resolve({ outcome: 'promptRequired', requestId: 1 });
    await done;
    expect(lane.transcript).toEqual([]);
    expect(lane.pendingUserEcho).toBeNull();
    expect(lane.queuedPrompts.map((q) => q.text)).toEqual(['now', 'later']);
    expect(chips).toContain('steer missed — queued (2)');
  });

  it('keeps typing order when missed steers resolve in reverse', async () => {
    const { asLane, lane, ctl, fc } = setup();
    lane.queuedPrompts.push({ text: 'follow-up', images: [], mentionTargets: [] });
    const a = ctl.steer(asLane, 'A', []);
    const b = ctl.steer(asLane, 'B', []);
    fc.pending[1].resolve({ outcome: 'failed', requestId: 2 });
    await b;
    fc.pending[0].resolve({ outcome: 'failed', requestId: 1 });
    await a;
    expect(lane.queuedPrompts.map((q) => q.text)).toEqual(['A', 'B', 'follow-up']);
  });

  it('drains the re-queued steer at once when the lane is already idle', async () => {
    const { asLane, lane, ctl, fc, drains } = setup();
    const done = ctl.steer(asLane, 'now', []);
    lane.status = 'idle';
    fc.pending[0].resolve({ outcome: 'failed', requestId: 1 });
    await done;
    expect(drains).toEqual(['lane-1']);
  });

  it('turns steering off when the adapter no longer knows the method', async () => {
    const { asLane, lane, ctl, fc } = setup();
    const done = ctl.steer(asLane, 'now', []);
    fc.pending[0].reject('_session/steering failed: {"code":-32601,"message":"Method not found"}');
    await done;
    expect(lane.supportsSteering).toBe(false);
    expect(lane.queuedPrompts.map((q) => q.text)).toEqual(['now']);
  });

  it('ends a turn at once when no steer work is outstanding', () => {
    const { asLane, ctl, finished, stream } = setup();
    stream.active();
    ctl.onStop(asLane, 'end_turn');
    expect(finished).toEqual(['end_turn']);
  });

  it('holds the whole turn end until the in-flight steer is answered', async () => {
    const { asLane, ctl, fc, finished } = setup();
    const done = ctl.steer(asLane, 'now', []);
    ctl.onStop(asLane, 'end_turn');
    expect(finished).toEqual([]);
    fc.pending[0].resolve({ outcome: 'injected', requestId: 1 });
    await done;
    expect(finished).toEqual(['end_turn']);
  });

  it('runs no turn-end cleanup until a Codex steer-started turn goes idle', async () => {
    const { asLane, ctl, fc, finished, stream } = setup();
    stream.active(); // the prompt's turn runs
    const done = ctl.steer(asLane, 'now', []);
    stream.idle(); // it ends
    stream.promptReply();
    stream.active(); // the steer's turn starts
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    ctl.onStop(asLane, 'end_turn'); // the prompt's invoke result, late
    expect(finished).toEqual([]);
    stream.idle();
    expect(finished).toEqual(['end_turn']);
  });

  it('follows the started turn when Enter came before any thread status', async () => {
    // Blocker: an early steer must not take the old turn's idle as the new turn's.
    const { asLane, ctl, fc, finished, stream } = setup();
    const done = ctl.steer(asLane, 'now', []); // no status seen yet
    stream.active(); // the old turn's status only now
    stream.idle();
    stream.promptReply();
    ctl.onStop(asLane, 'end_turn');
    stream.active();
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    expect(finished).toEqual([]);
    stream.idle();
    expect(finished).toEqual(['end_turn']);
  });

  it('waits for the marker of a startedNewTurn reply that arrived first', async () => {
    const { asLane, ctl, fc, finished, stream } = setup();
    stream.active();
    const done = ctl.steer(asLane, 'now', []);
    ctl.onStop(asLane, 'end_turn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    expect(finished).toEqual([]); // the stream has not caught up yet
    stream.idle();
    stream.promptReply();
    stream.active();
    stream.steerReply(1, 'startedNewTurn');
    expect(finished).toEqual([]);
    stream.idle();
    expect(finished).toEqual(['end_turn']);
  });

  it('does not wait on a steer-started turn that already went idle before the reply', async () => {
    const { asLane, ctl, fc, finished, stream } = setup();
    stream.active();
    const done = ctl.steer(asLane, 'now', []);
    ctl.onStop(asLane, 'end_turn');
    stream.idle();
    stream.promptReply();
    stream.active(); // short steer turn …
    stream.idle(); // … already done
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    expect(finished).toEqual(['end_turn']);
  });

  it('ignores the old turn idle that arrives after the prompt reply', async () => {
    const { asLane, ctl, fc, finished, stream } = setup();
    stream.active();
    const done = ctl.steer(asLane, 'now', []);
    ctl.onStop(asLane, 'end_turn');
    stream.promptReply();
    stream.idle(); // the old turn's idle, written after its reply
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    expect(finished).toEqual([]);
    stream.active();
    stream.idle();
    expect(finished).toEqual(['end_turn']);
  });

  it('waits for every turn concurrent steers started', async () => {
    // Blocker: A's turn ending must not satisfy B's.
    const { asLane, ctl, fc, finished, stream } = setup();
    stream.active();
    const a = ctl.steer(asLane, 'A', []);
    const b = ctl.steer(asLane, 'B', []);
    ctl.onStop(asLane, 'end_turn');
    stream.idle();
    stream.promptReply();
    stream.active(); // A's turn
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await a;
    stream.idle(); // A's turn ends; B still waits in Codex's queue
    expect(finished).toEqual([]);
    stream.active(); // B's turn
    stream.steerReply(2, 'startedNewTurn');
    fc.pending[1].resolve({ outcome: 'startedNewTurn', requestId: 2 });
    await b;
    expect(finished).toEqual([]);
    stream.idle();
    expect(finished).toEqual(['end_turn']);
  });

  it('cancels a turn a steer starts after the user cancelled', async () => {
    const { asLane, lane, ctl, fc, finished, stream } = setup();
    stream.active();
    const done = ctl.steer(asLane, 'now', []);
    ctl.onCancel(asLane);
    lane.cancelRequestedAt = Date.now();
    ctl.onStop(asLane, 'cancelled');
    stream.idle();
    stream.promptReply();
    stream.active();
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    await tick();
    expect(fc.cancels()).toBe(1);
    expect(lane.transcript.map((t) => t.text)).toContain('steer cancelled');
    stream.idle();
    expect(finished).toEqual(['cancelled']);
  });

  it('does not re-queue a steer that misses after a cancel', async () => {
    const { asLane, lane, ctl, fc } = setup();
    const done = ctl.steer(asLane, 'now', []);
    ctl.onCancel(asLane);
    fc.pending[0].resolve({ outcome: 'promptRequired', requestId: 1 });
    await done;
    expect(lane.queuedPrompts).toEqual([]);
    expect(lane.transcript.map((t) => t.text)).toEqual(['steer not delivered: now']);
  });

  it('holds for a steer-started turn when the first prompt was a command with no thread status', async () => {
    // Blocker: codex-acp answers /status without a native turn, so the first
    // thread status the lane ever sees is the steer-started turn's own.
    const { asLane, ctl, fc, finished, stream } = setup();
    const done = ctl.steer(asLane, 'now', []); // the lane is busy on `/status`
    stream.promptReply();
    ctl.onStop(asLane, 'end_turn');
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    expect(finished).toEqual([]); // no status yet — still waiting
    stream.active();
    expect(finished).toEqual([]);
    stream.idle();
    expect(finished).toEqual(['end_turn']);
  });

  it('does not end a steer-started turn on Ctrl+C before its idle, even with no status seen yet', async () => {
    // Blocker: session/cancel is a notification — the turn may still be running.
    const { asLane, lane, ctl, fc, finished, stream } = setup();
    const done = ctl.steer(asLane, 'now', []); // the lane is busy on `/status`
    stream.promptReply();
    ctl.onStop(asLane, 'end_turn');
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    ctl.onCancel(asLane);
    lane.cancelRequestedAt = Date.now();
    expect(finished).toEqual([]);
    stream.active(); // the interrupted turn's own status, late
    stream.idle();
    expect(finished).toEqual(['cancelled']);
  });

  it('drops a held turn when a force-restart replaces the session', async () => {
    const { asLane, lane, ctl, fc, finished, stream } = setup();
    const done = ctl.steer(asLane, 'now', []);
    stream.promptReply();
    ctl.onStop(asLane, 'end_turn');
    stream.steerReply(1, 'startedNewTurn');
    fc.pending[0].resolve({ outcome: 'startedNewTurn', requestId: 1 });
    await done;
    lane.spawnEpoch += 1; // spec 199 force-restart
    ctl.onStop(asLane, 'end_turn'); // the fresh session's first turn
    expect(finished).toEqual(['end_turn']);
  });

  it('ends a held turn on a harness-synthesized stop', () => {
    const { asLane, ctl, finished } = setup();
    void ctl.steer(asLane, 'now', []);
    ctl.onStop(asLane, 'cancelled', 'agent exited');
    expect(finished).toEqual(['cancelled']);
  });

  it('ignores the outcome of a steer sent to a session that was replaced', async () => {
    const { asLane, lane, ctl, fc, chips, finished } = setup();
    const done = ctl.steer(asLane, 'now', []);
    lane.client = fakeClient().client;
    lane.spawnEpoch += 1;
    ctl.resetLane(lane.id);
    fc.pending[0].resolve({ outcome: 'promptRequired', requestId: 1 });
    await done;
    expect(lane.queuedPrompts).toEqual([]);
    expect(chips).toEqual([]);
    ctl.onStop(asLane, 'end_turn');
    expect(finished).toEqual(['end_turn']);
  });
});

describe('codexThreadState (spec 278)', () => {
  it('reads codex-acp thread status from session_info_update _meta', () => {
    expect(codexThreadState({ codex: { threadStatus: { type: 'active', activeFlags: [] } } })).toBe('active');
    expect(codexThreadState({ codex: { threadStatus: { type: 'idle' } } })).toBe('idle');
    expect(codexThreadState({ codex: { threadStatus: { type: 'systemError' } } })).toBeNull();
    expect(codexThreadState({ codex: { archived: true } })).toBeNull();
    expect(codexThreadState(undefined)).toBeNull();
  });
});
