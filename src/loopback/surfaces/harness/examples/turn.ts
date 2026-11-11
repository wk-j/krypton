// Spec 381 — Turn: how a turn ends, what it cost, and how it failed.

import { noticeText } from '../../../../acp/harness-notice';
import type { HarnessNotice } from '../../../../acp/harness-notice';
import { classifyProviderError } from '../../../../acp/provider-error';
import type { ProviderErrorPayload } from '../../../../acp/types';
import { describeUsage } from '../../../../acp/usage-log';
import type { UsageRollup } from '../../../../acp/usage-log';
import { item } from './fixtures';
import type { GalleryEntry, GalleryInput } from './types';

const ROLLUP: UsageRollup = {
  date: '2026-11-11',
  turns: 14,
  turnsWithoutTokens: 1,
  inputTokens: 182_000,
  outputTokens: 24_100,
  cachedReadTokens: 950_000,
  cachedWriteTokens: 61_000,
  reportedCost: 4.82,
  reportedCostTurns: 12,
  currency: 'USD',
  byModel: [
    { key: 'claude-opus-5-5', turns: 9, inputTokens: 141_000, outputTokens: 19_800, cachedReadTokens: 802_000, cachedWriteTokens: 50_000, reportedCost: 4.1 },
    { key: 'gpt-6-sol', turns: 5, inputTokens: 41_000, outputTokens: 4_300, cachedReadTokens: 148_000, cachedWriteTokens: 11_000, reportedCost: 0.72 },
  ],
  byLane: [
    { key: 'Claude-1', turns: 9, inputTokens: 141_000, outputTokens: 19_800, cachedReadTokens: 802_000, cachedWriteTokens: 50_000, reportedCost: 4.1 },
    { key: 'Codex-1', turns: 5, inputTokens: 41_000, outputTokens: 4_300, cachedReadTokens: 148_000, cachedWriteTokens: 11_000, reportedCost: 0.72 },
  ],
  unsent: 0,
  recording: true,
};

/** As the view's `#usage`: a usage notice, and the rollup when there is one to draw. */
function usage(rollup: UsageRollup): GalleryInput {
  const notice: HarnessNotice = { source: 'usage', tone: 'info', subject: describeUsage(rollup) };
  return item({
    kind: 'system',
    text: noticeText(notice),
    notice,
    ...(rollup.recording && rollup.turns > 0 ? { usage: rollup } : {}),
  });
}

/** The production classifier, as `appendClassifiedError` runs it. */
function providerError(raw: string): GalleryInput {
  const payload: ProviderErrorPayload | null = classifyProviderError(raw);
  if (payload === null) throw new Error(`Gallery provider-error example does not classify: ${raw}`);
  return item({ kind: 'provider_error', text: payload.headline, providerError: payload });
}

function system(text: string): GalleryInput {
  return item({ kind: 'system', text });
}

export const TURN_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'turn-usage',
    title: 'Usage',
    group: 'turn',
    summary: "The day's token and cost rollup, as `#usage` draws it.",
    components: ['usage-row', 'system-row'],
    scenario: null,
    states: [
      { label: 'summary', inputs: [usage(ROLLUP)] },
      { label: 'recording off', inputs: [usage({ ...ROLLUP, recording: false })] },
    ],
  },
  {
    id: 'turn-mcp-status',
    title: 'Harness MCP status',
    group: 'turn',
    summary: 'The endpoint and per-lane activity printed by #mcp.',
    components: ['system-command-row'],
    scenario: null,
    states: [
      {
        label: 'connected lanes',
        inputs: [item({
          kind: 'system',
          text: 'mcp endpoint: http://127.0.0.1:64732/mcp/harness/hm-2/lane/<laneLabel>\n\nlane                  init  list  call  last\n✓ OMP-2                   1     1     6  23m ago\n✓ Claude-1                1     1     2  2m ago\n— a-very-long-lane-nam    0     0     0  —\n\n✓ = adapter listed tools at least once. — = adapter never queried this lane.',
          systemCommand: {
            command: 'mcp',
            endpoint: 'http://127.0.0.1:64732/mcp/harness/hm-2/lane/<laneLabel>',
            warning: null,
            lanes: [
              { name: 'OMP-2', initialized: 1, listed: 1, called: 6, lastSeenAt: Date.now() - 23 * 60_000 },
              { name: 'Claude-1', initialized: 1, listed: 1, called: 2, lastSeenAt: Date.now() - 2 * 60_000 },
              { name: 'a-very-long-lane-name-without-a-cutoff', initialized: 0, listed: 0, called: 0, lastSeenAt: null },
            ],
          },
        })],
      },
      {
        label: 'server unavailable',
        inputs: [item({
          kind: 'system',
          text: 'mcp: harness memory unavailable - hook server offline\nlanes continue without the krypton-harness-memory MCP server',
          systemCommand: { command: 'mcp', endpoint: null, warning: 'hook server offline', lanes: [] },
        })],
      },
    ],
  },
  {
    id: 'turn-background-tasks',
    title: 'Background tasks',
    group: 'turn',
    summary: 'A point-in-time #bg task table and its empty state.',
    components: ['system-command-row'],
    scenario: null,
    states: [
      {
        label: 'running and exited',
        inputs: [item({
          kind: 'system',
          text: 'task        state     elapsed   output   command\nbg-1        running      2m     18 KB  npm run build\nbg-2        exit 1       6s      1 KB  cargo test\n\noutput files: /tmp/bg-1.log, /tmp/bg-2.log',
          systemCommand: {
            command: 'bg', capturedAt: 120_000,
            tasks: [
              { id: 'bg-1', state: 'running', startedAt: 0, endedAt: null, bytes: 18_432, command: 'npm run build', outputPath: '/tmp/bg-1.log' },
              { id: 'bg-2', state: 'exit 1', startedAt: 40_000, endedAt: 46_000, bytes: 1_024, command: 'cargo test', outputPath: '/tmp/bg-2.log' },
            ],
          },
        })],
      },
      {
        label: 'empty',
        inputs: [item({
          kind: 'system',
          text: 'bg: no background tasks on this lane.',
          systemCommand: { command: 'bg', capturedAt: 120_000, tasks: [] },
        })],
      },
    ],
  },
  {
    id: 'turn-assist-status',
    title: 'Assist status',
    group: 'turn',
    summary: 'One system row per registered #assist task, with mode and pause state.',
    components: ['system-command-row'],
    scenario: null,
    states: [
      {
        label: 'manual',
        inputs: [item({
          kind: 'system',
          text: '#assist grammar · manual — Grammar suggestions',
          systemCommand: { command: 'assist', task: { id: 'grammar', mode: 'manual', summary: 'Grammar suggestions', pausedUntil: null } },
        })],
      },
      {
        label: 'paused',
        inputs: [item({
          kind: 'system',
          text: '#assist follow-up · auto · paused 2m — Follow-up suggestions',
          createdAt: 60_000,
          systemCommand: { command: 'assist', task: { id: 'follow-up', mode: 'auto', summary: 'Follow-up suggestions', pausedUntil: 180_000 } },
        })],
      },
    ],
  },
  {
    id: 'turn-stop',
    title: 'Stop and cancel notices',
    group: 'turn',
    summary: 'The line a turn leaves when it does not end normally.',
    components: ['system-row'],
    scenario: null,
    states: [
      { label: 'cancelled', inputs: [system('turn cancelled')] },
      { label: 'agent exited', inputs: [system('turn ended — the agent process exited (code 1)')] },
      { label: 'max tokens', inputs: [system('turn ended: max_tokens')] },
      { label: 'refusal', inputs: [system('turn ended: refusal')] },
    ],
  },
  {
    id: 'turn-error',
    title: 'Error',
    group: 'turn',
    summary: 'A turn error no provider rule recognises, as plain text.',
    components: ['system-row'],
    scenario: null,
    states: [{ label: 'unclassified', inputs: [system('error: session/prompt failed: no session 7f3a')] }],
  },
  {
    id: 'turn-provider-error',
    title: 'Provider error',
    group: 'turn',
    summary: 'A provider failure the classifier recognised, with its hint.',
    components: ['provider-error-row'],
    scenario: null,
    states: [
      { label: 'rate limit', inputs: [providerError('429 Too Many Requests: rate_limit_error — retry after 20s')] },
      { label: 'auth', inputs: [providerError('authentication_error: invalid x-api-key')] },
      { label: 'overloaded', inputs: [providerError('overloaded_error: Overloaded')] },
    ],
  },
];
