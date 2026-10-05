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

describe('harness-consumed review replies (spec 276)', () => {
  function makeHost(): LaneHost & {
    prompts: Array<{ laneId: string; text: string }>;
    rows: Array<{ laneId: string; direction: 'in' | 'out'; message: string }>;
    replies: Array<{ laneId: string; packetId: string | null; fromLaneId: string; message: string }>;
    statuses: Map<string, HarnessLaneStatus>;
  } {
    const statuses = new Map<string, HarnessLaneStatus>([
      ['claude-1', 'idle'],
      ['grok-1', 'idle'],
    ]);
    const names = new Map([
      ['claude-1', 'Claude-1'],
      ['grok-1', 'Grok-1'],
    ]);
    const prompts: Array<{ laneId: string; text: string }> = [];
    const rows: Array<{ laneId: string; direction: 'in' | 'out'; message: string }> = [];
    const replies: Array<{ laneId: string; packetId: string | null; fromLaneId: string; message: string }> = [];
    return {
      prompts,
      rows,
      replies,
      statuses,
      listLanes: () => [],
      getLane: (laneId) => {
        const status = statuses.get(laneId);
        return status ? { status, displayName: names.get(laneId) ?? laneId } : null;
      },
      setLaneStatus: (laneId, next) => {
        statuses.set(laneId, next);
      },
      enqueueSystemPrompt: (laneId, text) => {
        prompts.push({ laneId, text });
      },
      appendInterLaneRow: (laneId, direction, _peer, message) => {
        rows.push({ laneId, direction, message });
      },
      appendSystemNotice: () => {},
      onHarnessReply: (laneId, reply) => {
        replies.push({ laneId, packetId: reply.packetId, fromLaneId: reply.fromLaneId, message: reply.message });
      },
    };
  }

  function reply(message: string) {
    return { id: `env-${message}`, fromLaneId: 'grok-1', toLaneId: 'claude-1', message, done: false, sentAt: 2 };
  }

  it('routes the reply to the harness and injects no turn into the requester', () => {
    const host = makeHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    const fanOut = coordinator.deliverMentionFanOut(
      'claude-1',
      'Claude-1',
      [{ laneId: 'grok-1', displayName: 'Grok-1' }],
      'review this',
      undefined,
      { replyConsumer: 'harness' },
    );
    expect(fanOut.delivered).toEqual(['Grok-1']);
    host.statuses.set('claude-1', 'awaiting_peer');
    host.prompts.length = 0;

    coordinator.deliver(reply('VERDICT: PASS'));

    expect(host.replies).toEqual([
      { laneId: 'claude-1', packetId: fanOut.packetId, fromLaneId: 'grok-1', message: 'VERDICT: PASS' },
    ]);
    expect(host.prompts.filter((p) => p.laneId === 'claude-1')).toEqual([]);
    expect(host.rows.some((r) => r.laneId === 'claude-1' && r.direction === 'in')).toBe(true);
    expect(coordinator.pendingPeersFor('claude-1')).toEqual([]);
    expect(host.statuses.get('claude-1')).toBe('idle');
  });

  it('withdraws only the harness-consumed requests and keeps the lane\'s own peer waits', () => {
    const host = makeHost();
    host.statuses.set('codex-1', 'idle');
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    coordinator.deliverMentionFanOut(
      'claude-1',
      'Claude-1',
      [{ laneId: 'grok-1', displayName: 'Grok-1' }],
      'review this',
      undefined,
      { replyConsumer: 'harness' },
    );
    coordinator.deliver({ id: 'env-own', fromLaneId: 'claude-1', toLaneId: 'codex-1', message: 'q', done: false, sentAt: 1 });
    host.statuses.set('claude-1', 'busy');
    // Still reviewing, so the cancellation notice waits in its inbox.
    host.statuses.set('grok-1', 'busy');

    coordinator.cancelConversationsFor('claude-1', { consumer: 'harness' });

    expect(coordinator.pendingPeersFor('claude-1').map((p) => p.toLaneId)).toEqual(['codex-1']);
    expect(host.statuses.get('claude-1')).toBe('busy');
    // The withdrawn reviewer's late reply is dropped.
    expect(coordinator.deliver(reply('VERDICT: PASS'))).toMatchObject({ delivered: false, reason: 'conversation_cancelled' });
    expect(host.replies).toEqual([]);
  });

  it('clears the requests of an errored requester without reviving it to idle', () => {
    const host = makeHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    coordinator.deliverMentionFanOut(
      'claude-1',
      'Claude-1',
      [{ laneId: 'grok-1', displayName: 'Grok-1' }],
      'review this',
      undefined,
      { replyConsumer: 'harness' },
    );
    host.statuses.set('claude-1', 'error');

    coordinator.cancelConversationsFor('claude-1', { consumer: 'harness' });

    expect(coordinator.pendingPeersFor('claude-1')).toEqual([]);
    expect(host.statuses.get('claude-1')).toBe('error');
  });

  it('still composes a turn for an ordinary mention reply', () => {
    const host = makeHost();
    const coordinator = new InterLaneCoordinator(new LaneBus(), host);
    coordinator.deliverMentionFanOut('claude-1', 'Claude-1', [{ laneId: 'grok-1', displayName: 'Grok-1' }], 'q');
    host.statuses.set('claude-1', 'awaiting_peer');
    host.prompts.length = 0;

    coordinator.deliver(reply('answer'));

    expect(host.replies).toEqual([]);
    expect(host.prompts.filter((p) => p.laneId === 'claude-1')).toHaveLength(1);
  });
});
