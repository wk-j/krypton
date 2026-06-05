import { describe, expect, it } from 'vitest';
import {
  canDrainInbound,
  InterLaneCoordinator,
  type CoordinatorDrainContext,
  type LaneHost,
} from './inter-lane';
import { LaneBus } from './lane-bus';
import type { HarnessLaneStatus, LaneSummary } from './types';

function peerHost(): LaneHost & {
  prompts: Array<{ laneId: string; text: string; drain?: CoordinatorDrainContext }>;
  statuses: Map<string, HarnessLaneStatus>;
} {
  const statuses = new Map<string, HarnessLaneStatus>([
    ['a', 'idle'],
    ['b', 'idle'],
  ]);
  const prompts: Array<{ laneId: string; text: string; drain?: CoordinatorDrainContext }> = [];
  return {
    prompts,
    statuses,
    listLanes: (): LaneSummary[] =>
      [...statuses.entries()].map(([laneId, status]) => ({
        laneId,
        status,
        displayName: laneId === 'a' ? 'A' : 'B',
        backendId: 'test',
        modelName: null,
        inboxDepth: 0,
        activeDirective: null,
      })),
    getLane: (laneId) => {
      const status = statuses.get(laneId);
      if (!status) return null;
      return { status, displayName: laneId === 'a' ? 'A' : 'B' };
    },
    setLaneStatus: (laneId, next) => {
      statuses.set(laneId, next);
    },
    enqueueSystemPrompt: (laneId, text, drain) => {
      prompts.push({ laneId, text, drain });
    },
    appendInterLaneRow: () => {},
    appendSystemNotice: () => {},
  };
}

describe('canDrainInbound', () => {
  it('allows idle and awaiting_peer', () => {
    expect(canDrainInbound('idle')).toBe(true);
    expect(canDrainInbound('awaiting_peer')).toBe(true);
    expect(canDrainInbound('busy')).toBe(false);
  });
});

describe('InterLaneCoordinator peer pending', () => {
  it('keeps requester pending when target drains consult, clears on reply', () => {
    const host = peerHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    const consult = coordinator.deliver({
      id: 'env-out',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'please review',
      done: false,
      sentAt: 1,
    });
    expect(consult.delivered).toBe(true);
    expect(coordinator.pendingPeersFor('a')).toHaveLength(1);
    host.statuses.set('a', 'awaiting_peer');
    expect(coordinator.pendingPeersFor('a')).toHaveLength(1);
    const reply = coordinator.deliver({
      id: 'env-in',
      fromLaneId: 'b',
      toLaneId: 'a',
      message: 'feedback',
      done: false,
      sentAt: 2,
    });
    expect(reply.delivered).toBe(true);
    expect(coordinator.pendingPeersFor('a')).toHaveLength(0);
    expect(host.prompts.some((p) => p.laneId === 'a')).toBe(true);
  });

  it("coerces a replier's done:true to false (initiator owns lifecycle)", () => {
    const host = peerHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    // a initiates → a has pending toward b.
    coordinator.deliver({
      id: 'env-out',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'q',
      done: false,
      sentAt: 1,
    });
    // b replies with done:true; coordinator must coerce it to false.
    const reply = coordinator.deliver({
      id: 'env-in',
      fromLaneId: 'b',
      toLaneId: 'a',
      message: 'answer',
      done: true,
      sentAt: 2,
    });
    expect(reply.delivered).toBe(true);
    const aPrompt = host.prompts.find((p) => p.laneId === 'a');
    expect(aPrompt).toBeDefined();
    // The "closed the conversation" hint must NOT appear — replier-done was coerced.
    expect(aPrompt!.text).not.toContain('closed the conversation');
    // Initiator (a) keeps close authority — drain hint should mention done:true.
    expect(aPrompt!.text).toContain('done: true');
  });

  it("honors initiator's closing ack with done:true", () => {
    const host = peerHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    // a initiates, b replies — exchange now complete, no pending in either direction.
    coordinator.deliver({
      id: 'env-1',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'q',
      done: false,
      sentAt: 1,
    });
    coordinator.deliver({
      id: 'env-2',
      fromLaneId: 'b',
      toLaneId: 'a',
      message: 'answer',
      done: false,
      sentAt: 2,
    });
    expect(coordinator.pendingPeersFor('a')).toHaveLength(0);
    // a closes with done:true (no pending exists → a is acting as initiator).
    const close = coordinator.deliver({
      id: 'env-3',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'thanks',
      done: true,
      sentAt: 3,
    });
    expect(close.delivered).toBe(true);
    const bPrompts = host.prompts.filter((p) => p.laneId === 'b');
    const bClosePrompt = bPrompts[bPrompts.length - 1];
    expect(bClosePrompt).toBeDefined();
    expect(bClosePrompt.text).toContain('closed the conversation');
  });

  it('honors initiator one-shot fire-and-forget with done:true on first send', () => {
    const host = peerHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    const oneShot = coordinator.deliver({
      id: 'env-fire',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'fyi',
      done: true,
      sentAt: 1,
    });
    expect(oneShot.delivered).toBe(true);
    // Recipient prompt should show "closed the conversation".
    const bPrompt = host.prompts.find((p) => p.laneId === 'b');
    expect(bPrompt).toBeDefined();
    expect(bPrompt!.text).toContain('closed the conversation');
    // No pending tracked (done:true skips pending).
    expect(coordinator.pendingPeersFor('a')).toHaveLength(0);
  });

  it('rejects a second pending send to the same peer', () => {
    const host = peerHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    const first = coordinator.deliver({
      id: 'env-1',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'first',
      done: false,
      sentAt: 1,
    });
    expect(first.delivered).toBe(true);
    const second = coordinator.deliver({
      id: 'env-2',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'second',
      done: false,
      sentAt: 2,
    });
    expect(second).toEqual({ delivered: false, reason: 'peer_in_flight' });
    expect(coordinator.pendingPeersFor('a')).toHaveLength(1);
  });
});

describe('spec 143 — peer auto_accept arming (drain context)', () => {
  function drainOf(host: ReturnType<typeof peerHost>, laneId: string): CoordinatorDrainContext | undefined {
    return host.prompts.find((p) => p.laneId === laneId)?.drain;
  }

  it('arms autoAcceptPermissions for a local initiation carrying auto_accept', () => {
    const host = peerHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    coordinator.deliver({
      id: 'env-1',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'do the thing',
      done: false,
      autoAccept: true,
      sentAt: 1,
    });
    expect(drainOf(host, 'b')?.autoAcceptPermissions).toBe(true);
  });

  it('does not arm when auto_accept is absent', () => {
    const host = peerHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    coordinator.deliver({
      id: 'env-1',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'do the thing',
      done: false,
      sentAt: 1,
    });
    expect(drainOf(host, 'b')?.autoAcceptPermissions).toBe(false);
  });

  it('does not arm on a reply (recipient was the initiator)', () => {
    const host = peerHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    // a initiates → a is the initiator, b will reply.
    coordinator.deliver({
      id: 'env-out',
      fromLaneId: 'a',
      toLaneId: 'b',
      message: 'please review',
      done: false,
      sentAt: 1,
    });
    host.statuses.set('a', 'awaiting_peer');
    // b replies WITH auto_accept set — must NOT arm a's turn (reply-side grant).
    coordinator.deliver({
      id: 'env-in',
      fromLaneId: 'b',
      toLaneId: 'a',
      message: 'feedback',
      done: false,
      autoAccept: true,
      sentAt: 2,
    });
    expect(drainOf(host, 'a')?.autoAcceptPermissions).toBe(false);
  });
});
