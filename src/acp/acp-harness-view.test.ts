import { describe, expect, it } from 'vitest';

import {
  backendLogoId,
  buildComposerPeerStrip,
  buildLanePeekCandidates,
  deriveLanePairHeat,
  deriveRailPeerHint,
  directiveRole,
  directiveTagLabel,
  harnessAutoAllowToolName,
  hashBucket,
  isDirectPeerPeekReasonKey,
  laneAccent,
  laneAccentForLabel,
  formatLaneMailMetaLine,
  formatLaneMailProvenanceLine,
  selectLanePeekCandidate,
  shouldPreemptPeekDismissal,
  trimBackendPrefix,
  type LanePeekHeatLaneInput,
  type LanePeekSnapshot,
} from './acp-harness-view';

import type { PermissionOption, ToolCall } from './types';

function permissionFor(toolCall: Partial<ToolCall>, options: PermissionOption[] = []): { toolCall: ToolCall; options: PermissionOption[] } {
  return {
    toolCall: {
      toolCallId: 't1',
      ...toolCall,
    },
    options,
  };
}

function laneSnapshot(partial: Partial<LanePeekSnapshot> & { laneId: string }): LanePeekSnapshot {
  return {
    laneId: partial.laneId,
    displayName: partial.displayName ?? partial.laneId,
    status: partial.status ?? 'idle',
    active: partial.active ?? false,
    stopped: partial.stopped ?? false,
    visualIndex: partial.visualIndex ?? 0,
    inboxDepth: partial.inboxDepth ?? 0,
    pendingPeers: partial.pendingPeers ?? [],
    latestInterLane: partial.latestInterLane ?? null,
    latestPermission: partial.latestPermission ?? null,
    latestMeaningful: partial.latestMeaningful ?? null,
    error: partial.error ?? null,
  };
}

describe('ACP harness auto-allow permission detection', () => {
  it('accepts Codex-style namespaced built-in memory tool names', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'mcp__krypton_harness_memory__memory_set',
      rawInput: {
        toolName: 'mcp__krypton_harness_memory__memory_set',
        arguments: { summary: 'done', detail: 'details' },
      },
    }))).toBe('memory_set');
  });

  it('accepts built-in memory endpoint markers with plain tool names', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'memory_get',
      rawInput: {
        name: 'memory_get',
        serverUrl: 'http://127.0.0.1:34123/mcp/harness/H1/lane/Codex-1',
      },
    }))).toBe('memory_get');
  });

  it('accepts rendered ACP memory tool labels from permission content', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'MEMORY_SET',
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: 'Tool: krypton-harness-memory/memory_set',
        },
      }],
      rawInput: {
        summary: 'done',
        detail: 'details',
      },
    }))).toBe('memory_set');
  });

  it('rejects memory-like tool names without a built-in memory marker', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'memory_set',
      rawInput: {
        name: 'memory_set',
        server: 'third-party-memory',
      },
    }))).toBeNull();
  });

  it('rejects non-memory tools even when the built-in marker is present', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'mcp__krypton_harness_memory__shell_run',
      rawInput: {
        name: 'shell_run',
        server: 'krypton_harness_memory',
      },
    }))).toBeNull();
  });

  it('accepts Codex-style underscored bus namespace for peer_send', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'mcp__krypton_harness_bus__peer_send',
      rawInput: {
        toolName: 'mcp__krypton_harness_bus__peer_send',
        arguments: { to_lane: 'Claude-1', message: 'hi', done: false },
      },
    }))).toBe('peer_send');
  });

  it('accepts peer_list under the hyphenated bus marker', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'peer_list',
      rawInput: {
        name: 'peer_list',
        server: 'krypton-harness-bus',
      },
    }))).toBe('peer_list');
  });

  it('accepts peer_send detected via fallback regex on content text', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'PEER_SEND',
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: 'Tool: krypton-harness-bus/peer_send',
        },
      }],
      rawInput: {
        to_lane: 'Codex-1',
        message: 'hi',
      },
    }))).toBe('peer_send');
  });

  it('accepts Junie-style permission where server + tool name appear only in option labels', () => {
    expect(harnessAutoAllowToolName(permissionFor(
      { title: 'Allow running MCP?', kind: 'other' },
      [
        { optionId: 'Yes', name: 'Yes', kind: 'allow_once' },
        { optionId: 'No', name: 'No', kind: 'reject_once' },
        { optionId: 'always-peer', name: 'Always allow ("krypton-harness-memory:peer_send")', kind: 'allow_always' },
        { optionId: 'always-all', name: 'Always allow ("krypton-harness-memory:*")', kind: 'allow_always' },
      ],
    ))).toBe('peer_send');
  });

  it('rejects Junie-style permission when option labels reference a third-party server', () => {
    expect(harnessAutoAllowToolName(permissionFor(
      { title: 'Allow running MCP?', kind: 'other' },
      [
        { optionId: 'a', name: 'Always allow ("third-party-memory:peer_send")', kind: 'allow_always' },
      ],
    ))).toBeNull();
  });

  it('rejects Junie-style permission when option labels carry only the server marker without a known tool', () => {
    expect(harnessAutoAllowToolName(permissionFor(
      { title: 'Allow running MCP?', kind: 'other' },
      [
        { optionId: 'a', name: 'Always allow ("krypton-harness-memory:shell_run")', kind: 'allow_always' },
      ],
    ))).toBeNull();
  });
});

describe('ACP contextual lane peek ranking', () => {
  it('selects the pending peer recipient when the active lane is awaiting a reply', () => {
    const now = 10_000;
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        displayName: 'Codex-1',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [{ toLaneId: 'claude', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: 1_000 }],
      }),
      laneSnapshot({ laneId: 'claude', displayName: 'Claude-1', visualIndex: 1, status: 'busy' }),
    ], now);
    expect(candidates[0]?.laneId).toBe('claude');
    expect(candidates[0]?.reasonKey).toBe('awaiting-peer');
  });

  it('selects an inbound peer sender over unrelated lane errors', () => {
    const now = 20_000;
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        latestInterLane: {
          direction: 'in',
          peerId: 'claude',
          peerDisplayName: 'Claude-1',
          at: 19_000,
          message: 'please review',
        },
      }),
      laneSnapshot({ laneId: 'claude', displayName: 'Claude-1', visualIndex: 1, status: 'idle' }),
      laneSnapshot({ laneId: 'gemini', displayName: 'Gemini-1', visualIndex: 2, status: 'error', error: 'failed' }),
    ], now);
    expect(candidates[0]?.laneId).toBe('claude');
    expect(candidates[0]?.reasonKey).toBe('inbound-peer');
  });

  it('keeps the current candidate during dwell unless a much higher priority candidate appears', () => {
    const now = 30_000;
    const current = laneSnapshot({ laneId: 'gemini', visualIndex: 2, status: 'error', error: 'failed' });
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [{ toLaneId: 'claude', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: 29_000 }],
      }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1, status: 'busy' }),
      current,
    ], now);
    expect(selectLanePeekCandidate(candidates, {
      currentLaneId: 'gemini',
      lockedLaneId: null,
      selectedAt: now - 1_000,
      dismissedAt: null,
      dismissedPriority: null,
    }, now)?.laneId).toBe('claude');
  });

  it('keeps a similar-priority current candidate until dwell expires', () => {
    const now = 35_000;
    const candidates = buildLanePeekCandidates([
      laneSnapshot({ laneId: 'codex', active: true }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1, status: 'error', error: 'newer' }),
      laneSnapshot({ laneId: 'gemini', visualIndex: 2, status: 'error', error: 'older' }),
    ], now);
    expect(selectLanePeekCandidate(candidates, {
      currentLaneId: 'gemini',
      lockedLaneId: null,
      selectedAt: now - 1_000,
      dismissedAt: null,
      dismissedPriority: null,
    }, now)?.laneId).toBe('gemini');
    expect(selectLanePeekCandidate(candidates, {
      currentLaneId: 'gemini',
      lockedLaneId: null,
      selectedAt: now - 9_000,
      dismissedAt: null,
      dismissedPriority: null,
    }, now)?.laneId).toBe('claude');
  });

  it('honors manual locked lane while it remains eligible', () => {
    const now = 40_000;
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [{ toLaneId: 'claude', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: 39_000 }],
      }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1, status: 'busy' }),
      laneSnapshot({ laneId: 'gemini', visualIndex: 2, status: 'error', error: 'failed' }),
    ], now);
    expect(selectLanePeekCandidate(candidates, {
      currentLaneId: 'claude',
      lockedLaneId: 'gemini',
      selectedAt: now,
      dismissedAt: null,
      dismissedPriority: null,
    }, now)?.laneId).toBe('gemini');
  });

  it('suppresses same-or-lower priority candidates after dismissal even when the old lane is gone', () => {
    const now = 50_000;
    const candidates = buildLanePeekCandidates([
      laneSnapshot({ laneId: 'codex', active: true }),
      laneSnapshot({ laneId: 'gemini', visualIndex: 2, status: 'error', error: 'failed' }),
    ], now);
    expect(selectLanePeekCandidate(candidates, {
      currentLaneId: 'claude',
      lockedLaneId: null,
      selectedAt: now - 9_000,
      dismissedAt: now - 1_000,
      dismissedPriority: 50,
    }, now)).toBeNull();
  });

  it('allows a higher priority candidate to re-open after dismissal', () => {
    const now = 60_000;
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [{ toLaneId: 'claude', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: 59_000 }],
      }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1, status: 'busy' }),
    ], now);
    expect(selectLanePeekCandidate(candidates, {
      currentLaneId: 'gemini',
      lockedLaneId: null,
      selectedAt: now - 9_000,
      dismissedAt: now - 1_000,
      dismissedPriority: 50,
    }, now)?.laneId).toBe('claude');
  });

  it('uses the oldest pending peer when multiple peers are awaiting replies', () => {
    const now = 70_000;
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [
          { toLaneId: 'newer', toDisplayName: 'Newer-1', envelopeId: 'e2', sentAt: 69_000 },
          { toLaneId: 'older', toDisplayName: 'Older-1', envelopeId: 'e1', sentAt: 50_000 },
        ],
      }),
      laneSnapshot({ laneId: 'newer', visualIndex: 1, status: 'busy' }),
      laneSnapshot({ laneId: 'older', visualIndex: 2, status: 'busy' }),
    ], now);
    expect(candidates[0]?.laneId).toBe('older');
  });

  it('returns no candidates when there is no active lane or no qualifying non-active lane', () => {
    expect(buildLanePeekCandidates([], 1_000)).toEqual([]);
    expect(buildLanePeekCandidates([
      laneSnapshot({ laneId: 'codex', active: true }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1 }),
    ], 1_000)).toEqual([]);
  });
});

describe('ACP peer activity UI (spec 118)', () => {
  const now = 100_000;

  it('deriveRailPeerHint awaiting', () => {
    const hint = deriveRailPeerHint({
      pendingPeers: [{ toLaneId: 'b', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: now - 30_000 }],
      inboxDepth: 0,
      latestInterLane: null,
    }, () => null, now);
    expect(hint.awaitingSuffix).toBe('⇆');
    expect(hint.kind).toBe('awaiting');
    expect(hint.title).toContain('Claude-1');
  });

  it('deriveRailPeerHint inbox only', () => {
    const hint = deriveRailPeerHint({
      pendingPeers: [],
      inboxDepth: 2,
      latestInterLane: null,
    }, () => null, now);
    expect(hint.inboxSuffix).toBe('▼2');
    expect(hint.kind).toBe('inbox');
  });

  it('deriveRailPeerHint pending + inbox', () => {
    const hint = deriveRailPeerHint({
      pendingPeers: [{ toLaneId: 'b', toDisplayName: 'B', envelopeId: 'e1', sentAt: now - 1_000 }],
      inboxDepth: 1,
      latestInterLane: null,
    }, () => null, now);
    expect(hint.awaitingSuffix).toBe('⇆');
    expect(hint.inboxSuffix).toBe('▼1');
    expect(hint.title).toContain('peer message');
    expect(hint.title).toContain('awaiting');
  });

  it('deriveRailPeerHint inbound traffic', () => {
    const hint = deriveRailPeerHint({
      pendingPeers: [],
      inboxDepth: 0,
      latestInterLane: {
        direction: 'in',
        peerId: 'claude',
        peerDisplayName: 'Claude-1',
        at: now - 1_000,
        message: 'hi',
      },
    }, () => null, now);
    expect(hint.trafficSuffix).toBe('←');
    expect(hint.kind).toBe('traffic');
  });

  it('deriveRailPeerHint outbound when counterpart busy', () => {
    const hint = deriveRailPeerHint({
      pendingPeers: [],
      inboxDepth: 0,
      latestInterLane: {
        direction: 'out',
        peerId: 'claude',
        peerDisplayName: 'Claude-1',
        at: now - 2_000,
        message: 'review this',
      },
    }, (id) => (id === 'claude' ? 'busy' : null), now);
    expect(hint.trafficSuffix).toBe('→');
    expect(hint.kind).toBe('traffic');
  });

  it('deriveRailPeerHint multi-peer title', () => {
    const hint = deriveRailPeerHint({
      pendingPeers: [
        { toLaneId: 'a', toDisplayName: 'A', envelopeId: 'e1', sentAt: now - 90_000 },
        { toLaneId: 'b', toDisplayName: 'B', envelopeId: 'e2', sentAt: now - 120_000 },
      ],
      inboxDepth: 0,
      latestInterLane: null,
    }, () => null, now);
    expect(hint.title).toContain('2 peers');
  });

  it('shouldPreemptPeekDismissal fires when a peer event arrives after dismissal', () => {
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [{ toLaneId: 'claude', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: now - 500 }],
      }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1, status: 'busy' }),
    ], now);
    // candidate.at = sentAt = now - 500; dismissedAt = now - 1_000 → peer is newer → preempt
    expect(shouldPreemptPeekDismissal(candidates, now - 1_000)).toBe(true);
  });

  it('shouldPreemptPeekDismissal does NOT fire when the peer candidate predates the dismissal', () => {
    // Regression: Esc-hide must stick when the visible peer candidate was
    // already there at dismissal time — otherwise hide is useless while any
    // peer candidate sits in the snapshot.
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [{ toLaneId: 'claude', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: now - 5_000 }],
      }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1, status: 'busy' }),
    ], now);
    expect(shouldPreemptPeekDismissal(candidates, now - 1_000)).toBe(false);
  });

  it('shouldPreemptPeekDismissal does NOT fire when no dismissal is active', () => {
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [{ toLaneId: 'claude', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: now - 500 }],
      }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1, status: 'busy' }),
    ], now);
    expect(shouldPreemptPeekDismissal(candidates, null)).toBe(false);
  });

  it('shouldPreemptPeekDismissal false for recent-activity tier', () => {
    const candidates = buildLanePeekCandidates([
      laneSnapshot({ laneId: 'codex', active: true }),
      laneSnapshot({
        laneId: 'claude',
        visualIndex: 1,
        latestMeaningful: { kind: 'tool', label: 'grep', at: now - 1_000 },
      }),
    ], now);
    expect(shouldPreemptPeekDismissal(candidates, now - 5_000)).toBe(false);
  });

  it('selectLanePeekCandidate returns peer after preempt clears dismiss', () => {
    const candidates = buildLanePeekCandidates([
      laneSnapshot({
        laneId: 'codex',
        active: true,
        status: 'awaiting_peer',
        pendingPeers: [{ toLaneId: 'claude', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: now - 500 }],
      }),
      laneSnapshot({ laneId: 'claude', visualIndex: 1, status: 'busy' }),
    ], now);
    expect(shouldPreemptPeekDismissal(candidates, now - 1_000)).toBe(true);
    expect(candidates[0]?.priority).toBe(10);
    const dismissed = {
      currentLaneId: null,
      lockedLaneId: null,
      selectedAt: now,
      dismissedAt: now - 1_000,
      dismissedPriority: 10,
    };
    expect(selectLanePeekCandidate(candidates, dismissed, now)).toBeNull();
    expect(selectLanePeekCandidate(candidates, {
      ...dismissed,
      dismissedAt: null,
      dismissedPriority: null,
    }, now)?.laneId).toBe('claude');
  });

  it('buildComposerPeerStrip emits strip for pending peer with cancel hint', () => {
    expect(buildComposerPeerStrip('awaiting_peer', [
      { toLaneId: 'b', toDisplayName: 'Claude-1', envelopeId: 'e1', sentAt: now - 60_000 },
    ], 0)).toContain('drops pending lane-mail wait');
  });

  it('buildComposerPeerStrip emits awaiting strip with no pending peer', () => {
    expect(buildComposerPeerStrip('awaiting_peer', [], 0)).toContain('awaiting lane mail');
  });

  it('buildComposerPeerStrip emits inbox-only strip on an idle lane', () => {
    const strip = buildComposerPeerStrip('idle', [], 2);
    expect(strip).toContain('▼2');
    expect(strip).not.toContain('awaiting');
  });

  it('buildComposerPeerStrip returns empty for idle + no inbox + no pending', () => {
    expect(buildComposerPeerStrip('idle', [], 0)).toBe('');
    expect(buildComposerPeerStrip('busy', [], 0)).toBe('');
  });
});

function heatLane(partial: Partial<LanePeekHeatLaneInput> & Pick<LanePeekHeatLaneInput, 'id'>): LanePeekHeatLaneInput {
  return {
    displayName: partial.displayName ?? partial.id,
    status: partial.status ?? 'idle',
    transcript: partial.transcript ?? [],
    usage: partial.usage ?? null,
    pendingShell: partial.pendingShell ?? false,
    pendingPeerCount: partial.pendingPeerCount ?? 0,
    metricHistory: partial.metricHistory ?? [],
    ...partial,
  };
}

function heatTx(
  items: Array<{ kind: 'tool' | 'inter_lane' | 'permission' | 'provider_error'; createdAt: number }>,
): LanePeekHeatLaneInput['transcript'] {
  return items.map((x, i) => ({
    id: `tx-${i}`,
    kind: x.kind,
    text: '',
    createdAt: x.createdAt,
  })) as LanePeekHeatLaneInput['transcript'];
}

describe('lane peek heat (slice 109)', () => {
  const now = 1_720_000_000_000;

  it('isDirectPeerPeekReasonKey marks peer tiers', () => {
    expect(isDirectPeerPeekReasonKey('awaiting-peer')).toBe(true);
    expect(isDirectPeerPeekReasonKey('inbound-peer')).toBe(true);
    expect(isDirectPeerPeekReasonKey('peer-counterpart')).toBe(true);
    expect(isDirectPeerPeekReasonKey('lane-inbox')).toBe(false);
  });

  it('deriveLanePairHeat counts tools in 5m window', () => {
    const active = heatLane({
      id: 'a',
      transcript: heatTx([
        { kind: 'tool', createdAt: now - 1_000 },
        { kind: 'tool', createdAt: now - 2_000 },
      ]),
    });
    const peeked = heatLane({
      id: 'b',
      displayName: 'B',
      transcript: heatTx([{ kind: 'tool', createdAt: now - 3_000 }]),
    });
    const s = deriveLanePairHeat(active, peeked, now, '5m', 'tools');
    expect(s.active.toolDelta).toBe(2);
    expect(s.peeked.toolDelta).toBe(1);
    expect(s.deltaLine).toMatch(/2 vs 1/);
  });

  it('deriveLanePairHeat tools mode ignores tools older than window', () => {
    const active = heatLane({
      id: 'a',
      transcript: heatTx([{ kind: 'tool', createdAt: now - 400_000 }]),
    });
    const peeked = heatLane({ id: 'b', transcript: heatTx([]) });
    const s = deriveLanePairHeat(active, peeked, now, '5m', 'tools');
    expect(s.active.toolDelta).toBe(0);
    expect(s.peeked.toolDelta).toBe(0);
  });

  it('deriveLanePairHeat peer mode includes pending peer weight in scores', () => {
    const active = heatLane({
      id: 'a',
      pendingPeerCount: 1,
      transcript: heatTx([]),
    });
    const peeked = heatLane({ id: 'b', transcript: heatTx([]) });
    const s = deriveLanePairHeat(active, peeked, now, '30s', 'peer');
    expect(s.metric).toBe('peer');
    expect(s.active.score).toBeGreaterThan(0);
    expect(s.deltaLine).toMatch(/peer 0 vs 0/);
  });

  it('deriveLanePairHeat tokens reports unavailable when no usage history', () => {
    const active = heatLane({ id: 'a', transcript: heatTx([]) });
    const peeked = heatLane({ id: 'b', transcript: heatTx([]) });
    const s = deriveLanePairHeat(active, peeked, now, '5m', 'tokens');
    expect(s.unavailableReason).toContain('usage');
    expect(s.deltaLine).toBe('tokens --');
  });
});

describe('laneAccentForLabel', () => {
  it('routes Junie-N labels to the 8th palette slot, not the numeric fallback', () => {
    // Regression for the spec-119 must-fix: without the explicit /junie/i arm
    // ordered before the -(\d+)$ fallback, 'Junie-1' would match the numeric
    // tail and resolve to laneAccent(1) — the Codex blue — colliding visually
    // with Codex-1.
    expect(laneAccentForLabel('Junie-1')).toBe(laneAccent(8));
    expect(laneAccentForLabel('Junie-2')).toBe(laneAccent(8));
    expect(laneAccentForLabel('Junie-1')).not.toBe(laneAccent(1));
  });

  it('keeps the 8-color palette wider than the 7 named lanes', () => {
    // Junie occupies slot 8, so the palette must have at least 8 distinct
    // entries — otherwise laneAccent(8) wraps modulo to Codex blue.
    const slots = [1, 2, 3, 4, 5, 6, 7, 8].map(laneAccent);
    expect(new Set(slots).size).toBe(8);
  });
});

describe('spec 120 lane mail copy', () => {
  it('formats flat meta lines without nested chrome', () => {
    expect(formatLaneMailMetaLine('in', 'Codex-1', false)).toBe('← from codex-1 · lane mail');
    expect(formatLaneMailMetaLine('out', 'Claude-1', true, 'mention')).toBe(
      '→ to claude-1 · lane mail · mention · closed',
    );
  });

  it('formats provenance for multi-envelope drains', () => {
    expect(
      formatLaneMailProvenanceLine({
        envelopeId: 'e1',
        peerDisplayName: 'Cursor-1',
        envelopeCount: 2,
      }),
    ).toBe('↩ replying to lane mail (2 messages) from cursor-1');
  });
});

describe('spec 125 lane rail disambiguation', () => {
  describe('directiveRole', () => {
    it('routes empty task into a stable hash bucket', () => {
      const first = directiveRole('');
      expect(first).toMatch(/^hash-[123]$/);
      // Determinism: same input always lands in the same bucket.
      expect(directiveRole('')).toBe(first);
    });

    it('matches canonical role keywords', () => {
      expect(directiveRole('analysis')).toBe('analysis');
      expect(directiveRole('diagnose-flow')).toBe('analysis');
      expect(directiveRole('review')).toBe('review');
      expect(directiveRole('implementation')).toBe('impl');
      expect(directiveRole('impl')).toBe('impl');
      expect(directiveRole('bug-fix')).toBe('impl');
      expect(directiveRole('plan')).toBe('plan');
      expect(directiveRole('design')).toBe('plan');
      expect(directiveRole('spec')).toBe('plan');
      expect(directiveRole('explore')).toBe('explore');
      expect(directiveRole('survey')).toBe('explore');
      expect(directiveRole('map')).toBe('explore');
      expect(directiveRole('research')).toBe('explore');
      expect(directiveRole('investigate')).toBe('explore');
    });

    it('resolves overlap by declaration order', () => {
      // analysis → review → impl → plan → explore: "review" appears in both
      // review and impl patterns when a string like "review-implementation"
      // hits both. Declaration order wins.
      expect(directiveRole('review-implementation')).toBe('review');
    });

    it('falls back to a stable hash bucket for unmatched values', () => {
      const first = directiveRole('refactor');
      expect(first).toMatch(/^hash-[123]$/);
      expect(directiveRole('refactor')).toBe(first);
      expect(directiveRole('REFACTOR')).toBe(first); // case-insensitive
      // Different unmatched values can land in different buckets; we only
      // assert that each is itself stable.
      const obs = directiveRole('observability');
      expect(obs).toMatch(/^hash-[123]$/);
      expect(directiveRole('observability')).toBe(obs);
    });
  });

  describe('directiveTagLabel', () => {
    it('returns the literal "custom" for empty task', () => {
      expect(directiveTagLabel('')).toBe('custom');
      expect(directiveTagLabel('   ')).toBe('custom');
    });

    it('returns the canonical slug for matched roles', () => {
      expect(directiveTagLabel('analysis')).toBe('analysis');
      expect(directiveTagLabel('diagnose-flow')).toBe('analysis');
      expect(directiveTagLabel('Review')).toBe('review');
      expect(directiveTagLabel('implementation')).toBe('impl');
      expect(directiveTagLabel('bug-fix')).toBe('impl');
      expect(directiveTagLabel('design')).toBe('plan');
      expect(directiveTagLabel('investigate')).toBe('explore');
    });

    it('returns the raw lowercased task for unmatched non-empty values', () => {
      expect(directiveTagLabel('refactor')).toBe('refactor');
      expect(directiveTagLabel('REFACTOR')).toBe('refactor');
      expect(directiveTagLabel('  chore  ')).toBe('chore');
    });

    it('does not truncate long values (CSS handles ellipsis)', () => {
      const long = 'super-long-custom-task-name';
      expect(directiveTagLabel(long)).toBe(long);
    });
  });

  describe('trimBackendPrefix', () => {
    it('strips a single leading "<Label> " prefix', () => {
      expect(trimBackendPrefix('Claude Issue Analysis', 'claude')).toBe('Issue Analysis');
      expect(trimBackendPrefix('Codex Review Changed Code', 'codex')).toBe('Review Changed Code');
      expect(trimBackendPrefix('OpenCode Plan Design', 'opencode')).toBe('Plan Design');
    });

    it('requires the trailing space — does not strip a bare label match', () => {
      expect(trimBackendPrefix('Claude', 'claude')).toBe('Claude');
      expect(trimBackendPrefix('ClaudeFoo', 'claude')).toBe('ClaudeFoo');
    });

    it('leaves titles without the matching prefix untouched', () => {
      expect(trimBackendPrefix('Issue Analysis', 'claude')).toBe('Issue Analysis');
      // Different backend label: "Codex" prefix doesn't match a claude lane.
      expect(trimBackendPrefix('Codex Review', 'claude')).toBe('Codex Review');
    });

    it('no-ops for unknown backend ids', () => {
      expect(trimBackendPrefix('Whatever Title', 'made-up')).toBe('Whatever Title');
    });
  });

  describe('hashBucket', () => {
    it('is deterministic for the same input', () => {
      const a = hashBucket('refactor');
      expect(hashBucket('refactor')).toBe(a);
      const b = hashBucket('');
      expect(hashBucket('')).toBe(b);
    });

    it('returns one of the three bucket ids', () => {
      const corpus = [
        '', 'a', 'refactor', 'observability', 'chore', 'cleanup', 'tracing',
        'auth', 'session', 'pty', 'compositor', 'rail', 'directive', 'logo',
        'sound', 'theme', 'workspace', 'lane', 'inbox', 'review', 'impl',
        'plan', 'analyze', 'survey', 'research', 'tests', 'docs', 'ci',
        'flag', 'config',
      ];
      const seen = new Set<string>();
      for (const s of corpus) {
        const bucket = hashBucket(s);
        expect(['hash-1', 'hash-2', 'hash-3']).toContain(bucket);
        seen.add(bucket);
      }
      // Distribution sanity: a 30-string corpus must reach at least 2
      // buckets. (Exactly-1 would imply the hash collapsed.)
      expect(seen.size).toBeGreaterThan(1);
    });
  });

  describe('backendLogoId', () => {
    it('maps the nine built-in backends to their krypton-logo-* ids', () => {
      expect(backendLogoId('claude')).toBe('krypton-logo-claude');
      expect(backendLogoId('codex')).toBe('krypton-logo-codex');
      expect(backendLogoId('gemini')).toBe('krypton-logo-gemini');
      expect(backendLogoId('opencode')).toBe('krypton-logo-opencode');
      expect(backendLogoId('pi-acp')).toBe('krypton-logo-pi');
      expect(backendLogoId('droid')).toBe('krypton-logo-droid');
      expect(backendLogoId('cursor')).toBe('krypton-logo-cursor');
      expect(backendLogoId('junie')).toBe('krypton-logo-junie');
      expect(backendLogoId('omp')).toBe('krypton-logo-omp');
    });

    it('falls back to the neutral OMP mark for unknown backends', () => {
      expect(backendLogoId('made-up-backend')).toBe('krypton-logo-omp');
    });
  });
});
