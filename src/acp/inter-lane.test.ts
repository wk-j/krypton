import { describe, expect, it } from 'vitest';
import { InterLaneCoordinator, type LaneHost, type ReviewCardPayload } from './inter-lane';
import { LaneBus } from './lane-bus';
import type { HarnessLaneStatus, LaneSummary, ReviewPacket } from './types';

function makePacket(): ReviewPacket {
  return {
    packetId: 'pkt-1',
    fromLaneId: 'codex-1',
    toLaneId: 'claude-1',
    intent: 'Fix review routing.',
    repoRoot: '/repo',
    patchBase: 'head',
    hasStagedChanges: false,
    hasUnstagedChanges: true,
    partialStagingDetected: false,
    worktreeFingerprint: 'fp-1',
    diffstat: [{ path: 'src/acp/inter-lane.ts', status: 'M', added: 4, removed: 0 }],
    patchHunks: [],
    untrackedExcerpts: [],
    commands: [],
    toolSummary: [],
    sentAt: 100,
  };
}

function makeHost(): LaneHost & {
  prompts: Array<{ laneId: string; text: string }>;
  reviewCards: Array<{ laneId: string; payload: ReviewCardPayload }>;
} {
  const statuses = new Map<string, HarnessLaneStatus>([
    ['codex-1', 'idle'],
    ['claude-1', 'busy'],
  ]);
  const names = new Map<string, string>([
    ['codex-1', 'Codex-1'],
    ['claude-1', 'Claude-1'],
  ]);
  const prompts: Array<{ laneId: string; text: string }> = [];
  const reviewCards: Array<{ laneId: string; payload: ReviewCardPayload }> = [];
  return {
    prompts,
    reviewCards,
    listLanes: (): LaneSummary[] =>
      [...statuses.entries()].map(([laneId, status]) => ({
        laneId,
        status,
        displayName: names.get(laneId) ?? laneId,
        backendId: laneId.split('-')[0],
        modelName: null,
        inboxDepth: 0,
      })),
    getLane: (laneId) => {
      const status = statuses.get(laneId);
      if (!status) return null;
      return { status, displayName: names.get(laneId) ?? laneId };
    },
    setLaneStatus: (laneId, next) => {
      statuses.set(laneId, next);
    },
    enqueueSystemPrompt: (laneId, text) => {
      prompts.push({ laneId, text });
    },
    appendInterLaneRow: () => {},
    appendSystemNotice: () => {},
    appendReviewCard: (laneId, payload) => {
      reviewCards.push({ laneId, payload });
    },
  };
}

describe('InterLaneCoordinator review replies', () => {
  it('injects delivered review findings into the requester lane context', () => {
    const host = makeHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    const packet = makePacket();
    const request = coordinator.deliverReviewRequest(packet, 'review prompt');
    expect(request.delivered).toBe(true);

    const result = coordinator.deliverReviewReply({
      packetId: packet.packetId,
      fromLaneId: packet.toLaneId,
      toLaneId: packet.fromLaneId,
      fromDisplayName: 'Claude-1',
      toDisplayName: 'Codex-1',
      findings: [
        {
          file: 'src/acp/inter-lane.ts',
          line: 312,
          severity: 'warn',
          concern: 'Review card was visible but not sent back to the requester model.',
          suggestedCheck: 'Run npm test -- src/acp/inter-lane.test.ts',
        },
      ],
      summary: 'Requester should act on review findings.',
      worktreeMatchAtReceipt: false,
      sentAt: 200,
    });

    expect(result.delivered).toBe(true);
    expect(host.reviewCards).toHaveLength(1);
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]?.laneId).toBe('codex-1');
    expect(host.prompts[0]?.text).toContain('[review reply] From Claude-1');
    expect(host.prompts[0]?.text).toContain('WARN src/acp/inter-lane.ts:312');
    expect(host.prompts[0]?.text).toContain('Address these findings directly now');
  });

  it('delivers an interrupted review card when the reviewer lane closes mid-review', () => {
    const host = makeHost();
    const bus = new LaneBus();
    const coordinator = new InterLaneCoordinator(bus, host);
    const packet = makePacket();
    const request = coordinator.deliverReviewRequest(packet, 'review prompt');
    expect(request.delivered).toBe(true);

    bus.emit({
      type: 'lane:closed',
      payload: { laneId: packet.toLaneId, displayName: 'Claude-1' },
    });

    expect(host.reviewCards).toHaveLength(1);
    expect(host.reviewCards[0]?.laneId).toBe(packet.fromLaneId);
    expect(host.reviewCards[0]?.payload.interruptedReason).toBe('reviewer lane closed');
    expect(host.reviewCards[0]?.payload.findings).toEqual([]);
    expect(host.prompts.some((p) => p.text.includes('[review reply]'))).toBe(false);

    const lateReply = coordinator.deliverReviewReply({
      packetId: packet.packetId,
      fromLaneId: packet.toLaneId,
      toLaneId: packet.fromLaneId,
      fromDisplayName: 'Claude-1',
      toDisplayName: 'Codex-1',
      findings: [],
      summary: 'late',
      worktreeMatchAtReceipt: true,
      sentAt: 300,
    });
    expect(lateReply).toEqual({ delivered: false, reason: 'unknown_packet' });
  });
});
