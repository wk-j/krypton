import { describe, expect, it } from 'vitest';

import {
  buildLanePeekCandidates,
  harnessAutoAllowToolName,
  selectLanePeekCandidate,
  type LanePeekSnapshot,
} from './acp-harness-view';

import type { ToolCall } from './types';

function permissionFor(toolCall: Partial<ToolCall>): { toolCall: ToolCall } {
  return {
    toolCall: {
      toolCallId: 't1',
      ...toolCall,
    },
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
