import { describe, expect, it } from 'vitest';
import { canDrainInbound, InterLaneCoordinator, type LaneHost } from './inter-lane';
import { LaneBus } from './lane-bus';
import type { HarnessLaneStatus, LaneSummary } from './types';

function peerHost(): LaneHost & {
  prompts: Array<{ laneId: string; text: string }>;
  statuses: Map<string, HarnessLaneStatus>;
} {
  const statuses = new Map<string, HarnessLaneStatus>([
    ['a', 'idle'],
    ['b', 'idle'],
  ]);
  const prompts: Array<{ laneId: string; text: string }> = [];
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
      })),
    getLane: (laneId) => {
      const status = statuses.get(laneId);
      if (!status) return null;
      return { status, displayName: laneId === 'a' ? 'A' : 'B' };
    },
    setLaneStatus: (laneId, next) => {
      statuses.set(laneId, next);
    },
    enqueueSystemPrompt: (laneId, text) => {
      prompts.push({ laneId, text });
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
      done: true,
      sentAt: 2,
    });
    expect(reply.delivered).toBe(true);
    expect(coordinator.pendingPeersFor('a')).toHaveLength(0);
    expect(host.prompts.some((p) => p.laneId === 'a')).toBe(true);
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
