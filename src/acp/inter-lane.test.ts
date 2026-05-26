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
  statuses: Map<string, HarnessLaneStatus>;
} {
  const statuses = new Map<string, HarnessLaneStatus>([
    ['codex-1', 'idle'],
    ['claude-1', 'busy'],
  ]);
  const names = new Map<string, string>([
    ['codex-1', 'Codex-1'],
    ['claude-1', 'Claude-1'],
  ]);
  const prompts: Array<{ laneId: string; text: string; drain?: unknown }> = [];
  const reviewCards: Array<{ laneId: string; payload: ReviewCardPayload }> = [];
  return {
    prompts,
    reviewCards,
    statuses,
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
    enqueueSystemPrompt: (laneId, text, drain) => {
      prompts.push({ laneId, text, drain });
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

  it('queues review inject while requester is busy, drains on awaiting_peer', () => {
    const host = makeHost();
    const bus = new LaneBus();
    const coordinator = new InterLaneCoordinator(bus, host);
    const packet = makePacket();
    coordinator.deliverReviewRequest(packet, 'review prompt');
    host.statuses.set('codex-1', 'busy');

    const result = coordinator.deliverReviewReply({
      packetId: packet.packetId,
      fromLaneId: packet.toLaneId,
      toLaneId: packet.fromLaneId,
      fromDisplayName: 'Claude-1',
      toDisplayName: 'Codex-1',
      findings: [],
      summary: 'Looks good.',
      worktreeMatchAtReceipt: true,
      sentAt: 200,
    });

    expect(result.delivered).toBe(true);
    expect(host.reviewCards).toHaveLength(1);
    expect(host.prompts).toHaveLength(0);

    host.statuses.set('codex-1', 'awaiting_peer');
    bus.emit({
      type: 'lane:status',
      payload: { laneId: 'codex-1', prev: 'busy', next: 'awaiting_peer', at: 201 },
    });
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]?.text).toContain('[review reply] From Claude-1');
  });

  it('still injects a prompt when the reviewer returns zero findings (clean review)', () => {
    const host = makeHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    const packet = makePacket();
    coordinator.deliverReviewRequest(packet, 'review prompt');

    const result = coordinator.deliverReviewReply({
      packetId: packet.packetId,
      fromLaneId: packet.toLaneId,
      toLaneId: packet.fromLaneId,
      fromDisplayName: 'Claude-1',
      toDisplayName: 'Codex-1',
      findings: [],
      summary: 'Solid direction, but two implementation-facing concerns in the spec.',
      worktreeMatchAtReceipt: true,
      sentAt: 200,
    });

    expect(result.delivered).toBe(true);
    expect(host.reviewCards).toHaveLength(1);
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]?.text).toContain('[review reply] From Claude-1');
    expect(host.prompts[0]?.text).toContain('Solid direction');
    expect(host.prompts[0]?.text).toContain('no anchored findings');
    expect(host.prompts[0]?.text).not.toContain('Findings:');
  });
});

describe('InterLaneCoordinator transcript dedup (spec 120 phase 0)', () => {
  function makeTrackingHost(initial: Record<string, HarnessLaneStatus> = {
    'codex-1': 'awaiting_peer',
    'claude-1': 'idle',
  }): LaneHost & {
    interLaneRows: Array<{ laneId: string; direction: 'in' | 'out'; message: string }>;
    systemNotices: Array<{ laneId: string; text: string }>;
    prompts: Array<{ laneId: string; text: string }>;
    statuses: Map<string, HarnessLaneStatus>;
  } {
    const statuses = new Map<string, HarnessLaneStatus>(Object.entries(initial));
    const names = new Map<string, string>([
      ['codex-1', 'Codex-1'],
      ['claude-1', 'Claude-1'],
    ]);
    const interLaneRows: Array<{ laneId: string; direction: 'in' | 'out'; message: string }> = [];
    const systemNotices: Array<{ laneId: string; text: string }> = [];
    const prompts: Array<{ laneId: string; text: string; drain?: unknown }> = [];
    return {
      interLaneRows,
      systemNotices,
      prompts,
      statuses,
      listLanes: () =>
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
      appendInterLaneRow: (laneId, direction, _peer, message) => {
        interLaneRows.push({ laneId, direction, message });
      },
      appendSystemNotice: (laneId, text) => {
        systemNotices.push({ laneId, text });
      },
    };
  }

  it('does not append a second inbound inter_lane row when draining a harness cancellation notice', () => {
    const host = makeTrackingHost({ 'codex-1': 'idle', 'claude-1': 'idle' });
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    coordinator.deliver({
      id: 'env-1',
      fromLaneId: 'codex-1',
      toLaneId: 'claude-1',
      message: 'please review',
      done: false,
      sentAt: 1,
    });
    const inboundOnClaude = () =>
      host.interLaneRows.filter((r) => r.laneId === 'claude-1' && r.direction === 'in');
    expect(inboundOnClaude()).toHaveLength(1);

    coordinator.cancelConversationsFor('codex-1');

    expect(host.systemNotices).toHaveLength(1);
    expect(host.systemNotices[0]?.laneId).toBe('claude-1');
    expect(host.systemNotices[0]?.text).toContain('cancelled');
    // Harness synthetic drain goes to ACP only — no extra inter_lane inbox card.
    expect(inboundOnClaude()).toHaveLength(1);
    expect(host.prompts.some((p) => p.text.includes('harness: peer'))).toBe(true);
  });

  it('records one inbound inter_lane row per peer envelope on drain (no duplicate mail cards)', () => {
    const host = makeTrackingHost({ 'codex-1': 'idle', 'claude-1': 'idle' });
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    coordinator.deliver({
      id: 'env-2',
      fromLaneId: 'codex-1',
      toLaneId: 'claude-1',
      message: 'hello claude',
      done: false,
      sentAt: 2,
    });

    const inbound = host.interLaneRows.filter((r) => r.laneId === 'claude-1' && r.direction === 'in');
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.message).toBe('hello claude');
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]?.text).toContain('hello claude');
    expect(host.prompts[0]?.text).toContain('[inter-lane] From');
    // enqueueSystemPrompt text is session-only — not a second inter_lane row.
    expect(inbound.length).toBe(1);
  });
});
