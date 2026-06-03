// spec 141 — cross-harness peering. Exercises the directory + the coordinator's
// acceptInbound/recordOutbound split across two coordinators, mirroring the
// bridge logic in acp-harness-view.ts exactly (resolve once at the boundary,
// run the recipient side on the target, the sender side on the sender).

import { beforeEach, describe, expect, it } from 'vitest';
import { InterLaneCoordinator, type LaneHost } from './inter-lane';
import { LaneBus } from './lane-bus';
import {
  __resetHarnessDirectoryForTests,
  harnessEntry,
  nextLaneNumber,
  notifyForeignLaneClosed,
  registerHarness,
  resolveDisplayName,
  type HarnessEntry,
} from './harness-directory';
import type { HarnessLaneStatus, InterLaneEnvelope, LaneSummary } from './types';

interface TestView {
  harnessId: string;
  cwd: string | null;
  coordinator: InterLaneCoordinator;
  bus: LaneBus;
  statuses: Map<string, HarnessLaneStatus>;
  names: Map<string, string>; // laneId → displayName
  prompts: Array<{ laneId: string; text: string }>;
  notices: Array<{ laneId: string; text: string }>;
  entry: HarnessEntry;
}

/** Drive a lane idle and emit the bus event so the coordinator drains its inbox
 *  (the harness does this on every busy→idle stop). */
function goIdle(view: TestView, laneId: string): void {
  const prev = view.statuses.get(laneId) ?? 'busy';
  view.statuses.set(laneId, 'idle');
  view.bus.emit({ type: 'lane:status', payload: { laneId, prev, next: 'idle', at: Date.now() } });
}

function makeView(
  harnessId: string,
  cwd: string | null,
  lanes: Array<{ laneId: string; displayName: string; status: HarnessLaneStatus }>,
): TestView {
  const statuses = new Map(lanes.map((l) => [l.laneId, l.status]));
  const names = new Map(lanes.map((l) => [l.laneId, l.displayName]));
  const prompts: Array<{ laneId: string; text: string }> = [];
  const notices: Array<{ laneId: string; text: string }> = [];
  const host: LaneHost = {
    listLanes: (): LaneSummary[] =>
      [...statuses.entries()].map(([laneId, status]) => ({
        laneId,
        status,
        displayName: names.get(laneId) ?? laneId,
        backendId: 'test',
        modelName: null,
        inboxDepth: 0,
        activeDirective: null,
      })),
    getLane: (laneId) => {
      const status = statuses.get(laneId);
      if (!status) return null;
      return { status, displayName: names.get(laneId) ?? laneId };
    },
    setLaneStatus: (laneId, next) => statuses.set(laneId, next),
    enqueueSystemPrompt: (laneId, text) => prompts.push({ laneId, text }),
    appendInterLaneRow: () => {},
    appendSystemNotice: (laneId, text) => notices.push({ laneId, text }),
  };
  const bus = new LaneBus();
  const coordinator = new InterLaneCoordinator(bus, host);
  const view: TestView = {
    harnessId,
    cwd,
    coordinator,
    bus,
    statuses,
    names,
    prompts,
    notices,
    entry: undefined as unknown as HarnessEntry,
  };
  const entry: HarnessEntry = {
    harnessId,
    cwd,
    alive: true,
    listLanes: () => coordinator.listLanes(),
    resolveLocalDisplayName: (name) => {
      for (const [laneId, displayName] of names) {
        if (displayName === name && statuses.get(laneId) !== 'stopped') return { laneId, displayName };
      }
      return null;
    },
    acceptInbound: (env) =>
      entry.alive
        ? coordinator.acceptInbound(env)
        : { result: { delivered: false, reason: 'harness_closed' }, senderIsReplier: false, effectiveDone: env.done },
    acceptForeignCancellation: (targetLaneId, cancellerDisplayName) => {
      if (entry.alive) coordinator.acceptForeignCancellation(targetLaneId, cancellerDisplayName);
    },
    clearCancellationTombstone: (cancellerLaneId, peerDisplayName) =>
      coordinator.clearForeignCancellationTombstone(cancellerLaneId, peerDisplayName),
    onForeignHarnessClosed: (snapshot) => coordinator.onForeignHarnessClosed(snapshot),
  };
  view.entry = entry;
  registerHarness(entry);
  return view;
}

let seq = 0;
/** Mirror of the cross-view bridge in acp-harness-view.ts. */
function crossSend(
  sender: TestView,
  fromLaneId: string,
  toName: string,
  message: string,
  done = false,
): { delivered: boolean; reason?: string } {
  const fromDisplayName = sender.names.get(fromLaneId)!;
  const base: InterLaneEnvelope = {
    id: `env-${seq++}`,
    fromLaneId: fromDisplayName, // Rust addresses by display name
    toLaneId: toName,
    message,
    done,
    sentAt: Date.now(),
  };
  const resolved = resolveDisplayName(toName);
  if (!resolved) return { delivered: false, reason: 'unknown_lane' };
  const target = harnessEntry(resolved.harnessId);
  if (!target) return { delivered: false, reason: 'harness_closed' };
  const senderEnv: InterLaneEnvelope = { ...base, fromLaneId, toLaneId: resolved.displayName };
  if (sender.coordinator.isPeerInFlight(senderEnv, resolved.displayName)) {
    return { delivered: false, reason: 'peer_in_flight' };
  }
  const inboundEnv: InterLaneEnvelope = {
    ...base,
    fromLaneId: fromDisplayName,
    fromDisplayName,
    toLaneId: resolved.laneId,
  };
  const inbound = target.acceptInbound(inboundEnv);
  if (inbound.result.delivered) {
    sender.coordinator.recordOutbound(
      fromLaneId,
      { key: resolved.displayName, displayName: resolved.displayName },
      senderEnv,
      inbound,
    );
  }
  return inbound.result.delivered
    ? { delivered: true }
    : { delivered: false, reason: inbound.result.reason };
}

beforeEach(() => __resetHarnessDirectoryForTests());

describe('nextLaneNumber', () => {
  it('is monotonic per prefix and never recycled', () => {
    expect(nextLaneNumber('Claude')).toBe(1);
    expect(nextLaneNumber('Claude')).toBe(2);
    expect(nextLaneNumber('Codex')).toBe(1);
    expect(nextLaneNumber('Claude')).toBe(3);
    expect(nextLaneNumber('Codex')).toBe(2);
  });
});

describe('directory routing', () => {
  it('resolves a foreign displayName to its owning live harness, and peersFor excludes self', () => {
    const a = makeView('hm-1', '/project-a', [{ laneId: 'a1', displayName: 'Claude-1', status: 'idle' }]);
    makeView('hm-2', '/project-b', [{ laneId: 'b1', displayName: 'Pi-7', status: 'idle' }]);
    const r = resolveDisplayName('Pi-7');
    expect(r).toMatchObject({ harnessId: 'hm-2', laneId: 'b1', displayName: 'Pi-7', cwd: '/project-b' });

    const peers = a.coordinator.listLanes(); // local only
    expect(peers.map((p) => p.displayName)).toEqual(['Claude-1']);
  });
});

describe('cross-view round trip', () => {
  it('tracks pending on the initiator, clears on the reply, and never makes the replier await', () => {
    const a = makeView('hm-1', '/project-a', [{ laneId: 'a1', displayName: 'Claude-1', status: 'busy' }]);
    const b = makeView('hm-2', '/project-b', [{ laneId: 'b1', displayName: 'Pi-7', status: 'idle' }]);

    // Claude-1 asks Pi-7.
    const sent = crossSend(a, 'a1', 'Pi-7', 'please review');
    expect(sent.delivered).toBe(true);
    expect(a.coordinator.pendingPeersFor('a1')).toHaveLength(1);
    expect(a.coordinator.pendingPeersFor('a1')[0].toDisplayName).toBe('Pi-7');
    // Pi-7 (idle) drained the prompt.
    expect(b.prompts.some((p) => p.laneId === 'b1')).toBe(true);

    // Claude-1's turn ends → awaiting_peer (pending outstanding).
    a.statuses.set('a1', 'idle');
    a.coordinator.recomputePeerStatus('a1');
    expect(a.statuses.get('a1')).toBe('awaiting_peer');

    // Pi-7 replies. Claude-1 had pending toward Pi-7, so Pi-7 is the replier.
    b.statuses.set('b1', 'busy');
    const reply = crossSend(b, 'b1', 'Claude-1', 'looks good');
    expect(reply.delivered).toBe(true);
    // Initiator pending cleared; Claude-1 settles back to idle.
    expect(a.coordinator.pendingPeersFor('a1')).toHaveLength(0);
    expect(a.statuses.get('a1')).toBe('idle');
    // Replier (Pi-7) acquired NO pending → does not enter awaiting_peer.
    expect(b.coordinator.pendingPeersFor('b1')).toHaveLength(0);
    b.statuses.set('b1', 'idle');
    b.coordinator.recomputePeerStatus('b1');
    expect(b.statuses.get('b1')).toBe('idle');
  });

  it('rejects a second outstanding send to the same foreign peer', () => {
    const a = makeView('hm-1', '/a', [{ laneId: 'a1', displayName: 'Claude-1', status: 'busy' }]);
    makeView('hm-2', '/b', [{ laneId: 'b1', displayName: 'Pi-7', status: 'busy' }]);
    const first = crossSend(a, 'a1', 'Pi-7', 'first');
    expect(first.delivered).toBe(true);
    const second = crossSend(a, 'a1', 'Pi-7', 'second');
    expect(second).toEqual({ delivered: false, reason: 'peer_in_flight' });
  });

  it('returns harness_closed when the target view is disposing', () => {
    const a = makeView('hm-1', '/a', [{ laneId: 'a1', displayName: 'Claude-1', status: 'busy' }]);
    const b = makeView('hm-2', '/b', [{ laneId: 'b1', displayName: 'Pi-7', status: 'idle' }]);
    b.entry.alive = false; // dispose() flips this before teardown
    const sent = crossSend(a, 'a1', 'Pi-7', 'hello');
    // Not registered-removed yet, but alive=false → deterministic failure.
    expect(sent.delivered).toBe(false);
  });
});

describe('cross-view #cancel', () => {
  it('routes a cancellation onto the foreign peer (notice + termination prompt) and drops its late reply', () => {
    const a = makeView('hm-1', '/a', [{ laneId: 'a1', displayName: 'Claude-1', status: 'busy' }]);
    const b = makeView('hm-2', '/b', [{ laneId: 'b1', displayName: 'Pi-7', status: 'busy' }]);

    crossSend(a, 'a1', 'Pi-7', 'long task please');
    expect(a.coordinator.pendingPeersFor('a1')).toHaveLength(1);

    // Claude-1 #cancel. Pi-7 is still busy, so its termination notice is queued
    // (not yet drained) and the tombstone is live.
    a.coordinator.cancelConversationsFor('a1');
    expect(a.coordinator.pendingPeersFor('a1')).toHaveLength(0);
    expect(b.notices.some((n) => n.laneId === 'b1' && /Claude-1 cancelled/.test(n.text))).toBe(true);

    // A late reply from Pi-7's in-flight turn (before it drains the notice) is
    // dropped at the canceller — the tombstone is still live.
    const late = crossSend(b, 'b1', 'Claude-1', 'too-late reply');
    expect(late).toEqual({ delivered: false, reason: 'conversation_cancelled' });

    // Pi-7 finishes its turn and drains the notice → termination prompt appears
    // AND the ack callback clears the canceller-side tombstone.
    goIdle(b, 'b1');
    expect(b.prompts.some((p) => p.laneId === 'b1' && /cancelled the conversation/.test(p.text))).toBe(true);

    // With the tombstone cleared on acknowledgement, a fresh conversation in
    // either direction is no longer poisoned (Codex-1 review, High).
    b.statuses.set('b1', 'busy');
    const fresh = crossSend(b, 'b1', 'Claude-1', 'unrelated new question');
    expect(fresh.delivered).toBe(true);
  });
});

describe('individual foreign lane close', () => {
  it('notifies a cross-view initiator when a single foreign lane stops (harness stays open)', () => {
    const a = makeView('hm-1', '/a', [{ laneId: 'a1', displayName: 'Claude-1', status: 'busy' }]);
    const b = makeView('hm-2', '/b', [
      { laneId: 'b1', displayName: 'Pi-7', status: 'busy' },
      { laneId: 'b2', displayName: 'Pi-8', status: 'idle' },
    ]);
    crossSend(a, 'a1', 'Pi-7', 'working?');
    expect(a.coordinator.pendingPeersFor('a1')).toHaveLength(1);

    // Pi-7 stops; the harness stays alive (Pi-8 remains). The view's lane-close
    // path fans a single-name snapshot to other harnesses via the directory.
    b.statuses.set('b1', 'stopped');
    notifyForeignLaneClosed('hm-2', 'Pi-7', '/b');

    expect(a.coordinator.pendingPeersFor('a1')).toHaveLength(0);
    expect(a.notices.some((n) => n.laneId === 'a1' && /Pi-7 closed/.test(n.text))).toBe(true);
  });
});

describe('foreign harness close', () => {
  it('notifies a waiting initiator when the peer harness disposes', () => {
    const a = makeView('hm-1', '/a', [{ laneId: 'a1', displayName: 'Claude-1', status: 'busy' }]);
    const b = makeView('hm-2', '/b', [{ laneId: 'b1', displayName: 'Pi-7', status: 'busy' }]);
    crossSend(a, 'a1', 'Pi-7', 'are you there?');
    expect(a.coordinator.pendingPeersFor('a1')).toHaveLength(1);

    // View B disposes: alive=false, then the directory fans the snapshot out.
    b.entry.alive = false;
    a.coordinator.onForeignHarnessClosed({ harnessId: 'hm-2', cwd: '/b', displayNames: ['Pi-7'] });

    expect(a.coordinator.pendingPeersFor('a1')).toHaveLength(0);
    expect(a.notices.some((n) => n.laneId === 'a1' && /Pi-7 closed/.test(n.text))).toBe(true);
    // Termination prompt drains when Claude-1's current turn ends.
    goIdle(a, 'a1');
    expect(a.prompts.some((p) => p.laneId === 'a1' && /closed \(lane stopped\)/.test(p.text))).toBe(true);
  });
});
