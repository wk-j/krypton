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
