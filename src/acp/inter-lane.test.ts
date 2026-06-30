import { describe, expect, it } from 'vitest';
import { InterLaneCoordinator, type LaneHost } from './inter-lane';
import { LaneBus } from './lane-bus';
import type { HarnessLaneStatus, LaneSummary } from './types';

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
          activeDirective: null,
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

describe('InterLaneCoordinator.deliverAcknowledge (spec 183)', () => {
  function makeHost(initial: Record<string, HarnessLaneStatus>): LaneHost & {
    prompts: Array<{ laneId: string; text: string }>;
  } {
    const statuses = new Map<string, HarnessLaneStatus>(Object.entries(initial));
    const names = new Map<string, string>([['claude-1', 'Claude-1']]);
    const prompts: Array<{ laneId: string; text: string }> = [];
    return {
      prompts,
      listLanes: () =>
        [...statuses.entries()].map(([laneId, status]) => ({
          laneId, status, displayName: names.get(laneId) ?? laneId,
          backendId: laneId.split('-')[0], modelName: null, inboxDepth: 0, activeDirective: null,
        })),
      getLane: (laneId) => {
        const status = statuses.get(laneId);
        return status ? { status, displayName: names.get(laneId) ?? laneId } : null;
      },
      setLaneStatus: (laneId, next) => { statuses.set(laneId, next); },
      enqueueSystemPrompt: (laneId, text) => { prompts.push({ laneId, text }); },
      appendInterLaneRow: () => {},
      appendSystemNotice: () => {},
    };
  }

  it('delivers an approve-and-proceed, no-op-friendly envelope to a live lane', () => {
    const host = makeHost({ 'claude-1': 'idle' });
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);

    const result = coordinator.deliverAcknowledge('claude-1');

    expect(result).toEqual({ delivered: true });
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]?.laneId).toBe('claude-1');
    expect(host.prompts[0]?.text).toContain('approved');
    // no-op-friendly: a completed lane is told it need not reply / start new work.
    expect(host.prompts[0]?.text).toContain('no reply or new');
  });

  it('reports lane_stopped for a stopped lane and notifies nothing', () => {
    const host = makeHost({ 'claude-1': 'stopped' });
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);

    expect(coordinator.deliverAcknowledge('claude-1')).toEqual({ delivered: false, reason: 'lane_stopped' });
    expect(host.prompts).toHaveLength(0);
  });

  it('reports unknown_lane for a missing lane', () => {
    const host = makeHost({ 'claude-1': 'idle' });
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);

    expect(coordinator.deliverAcknowledge('ghost-9')).toEqual({ delivered: false, reason: 'unknown_lane' });
  });
});
