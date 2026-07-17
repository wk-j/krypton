import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  UsageStore,
  codexWindowLabel,
  providerForBackend,
  summarizeUsage,
  type ClaudeUsage,
  type CodexUsage,
  type GrokUsage,
  type ProviderUsageState,
} from './usage-store';

const claudeUsage: ClaudeUsage = {
  fiveHour: { utilization: 27, resetsAt: null },
  sevenDay: { utilization: 84, resetsAt: null },
  sevenDayOpus: { utilization: 101, resetsAt: null },
  sevenDaySonnet: null,
  weeklyScoped: [{ name: 'Fable', utilization: 79, resetsAt: '2026-07-07T16:00:00Z' }],
  extraUsage: null,
  subscriptionType: 'max',
  rateLimitTier: null,
  fetchedAt: 1,
};

describe('usage summaries', () => {
  it('keeps provider quota order, clamps values, and picks the highest usage', () => {
    const state: ProviderUsageState<'claude'> = {
      provider: 'claude',
      data: claudeUsage,
      error: null,
      pending: false,
    };

    const summary = summarizeUsage(state);
    expect(summary.quotas).toEqual([
      { label: '5h', usedPercent: 27 },
      { label: 'week', usedPercent: 84 },
      { label: 'opus', usedPercent: 100 },
      { label: 'fable', usedPercent: 79 },
    ]);
    expect(summary.mostConstrained).toEqual({ label: 'opus', usedPercent: 100 });
    expect(summary.freshness).toBe('live');
  });

  it('marks a last-good payload stale and an unavailable provider off', () => {
    expect(summarizeUsage({
      provider: 'claude',
      data: claudeUsage,
      error: 'network-error',
      pending: false,
    }).freshness).toBe('stale');

    expect(summarizeUsage({
      provider: 'cursor',
      data: null,
      error: 'not-connected',
      pending: false,
    }).freshness).toBe('off');
  });

  it('summarizes grok as a single credits gauge, and emits none without a limit', () => {
    const grok: GrokUsage = {
      used: 14,
      monthlyLimit: 4000,
      onDemandCap: 0,
      onDemandUsed: null,
      periodStart: null,
      periodEnd: null,
      tier: 'tier 3',
      email: 'a@b.co',
      fetchedAt: 1,
    };
    const grokQuotas = summarizeUsage({ provider: 'grok', data: grok, error: null, pending: false }).quotas;
    expect(grokQuotas).toHaveLength(1);
    expect(grokQuotas[0].label).toBe('credits');
    expect(grokQuotas[0].usedPercent).toBeCloseTo(0.35, 5);
    expect(
      summarizeUsage({
        provider: 'grok',
        data: { ...grok, monthlyLimit: null },
        error: null,
        pending: false,
      }).quotas,
    ).toEqual([]);
  });

  it('labels codex windows by their actual duration, not a fixed 5h/week slot', () => {
    // Post-mid-2026 Codex payload: primary IS the weekly window, no secondary.
    const weeklyOnly: CodexUsage = {
      primary: { usedPercent: 19, windowMinutes: 10080, resetsAt: 1784783452 },
      secondary: null,
      planType: 'plus',
      observedAt: '2026-07-16T17:11:11Z',
      sessionFile: '/tmp/rollout.jsonl',
    };
    expect(
      summarizeUsage({ provider: 'codex', data: weeklyOnly, error: null, pending: false }).quotas,
    ).toEqual([{ label: 'week', usedPercent: 19 }]);

    // Legacy dual-window payload keeps its old labels.
    const legacy: CodexUsage = {
      ...weeklyOnly,
      primary: { usedPercent: 3, windowMinutes: 300, resetsAt: 1781076474 },
      secondary: { usedPercent: 34, windowMinutes: 10080, resetsAt: 1781141354 },
    };
    expect(
      summarizeUsage({ provider: 'codex', data: legacy, error: null, pending: false }).quotas,
    ).toEqual([
      { label: '5h', usedPercent: 3 },
      { label: 'week', usedPercent: 34 },
    ]);
  });

  it('derives codex window labels from minutes', () => {
    expect(codexWindowLabel(300)).toBe('5h');
    expect(codexWindowLabel(10080)).toBe('week');
    expect(codexWindowLabel(20160)).toBe('2w');
    expect(codexWindowLabel(1440)).toBe('1d');
    expect(codexWindowLabel(90)).toBe('90m');
    expect(codexWindowLabel(0)).toBe('window');
  });

  it('maps only providers with existing authoritative usage sources', () => {
    expect(providerForBackend('claude')).toBe('claude');
    expect(providerForBackend('codex')).toBe('codex');
    expect(providerForBackend('cursor')).toBe('cursor');
    expect(providerForBackend('copilot')).toBe('copilot');
    expect(providerForBackend('grok')).toBe('grok');
    expect(providerForBackend('gemini')).toBeNull();
    expect(providerForBackend('opencode')).toBeNull();
  });
});

describe('UsageStore subscriptions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    invoke.mockResolvedValue(claudeUsage);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deduplicates providers and shares one poll timer until the final subscriber leaves', async () => {
    const store = new UsageStore();
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = store.subscribe(['claude', 'claude'], first);
    const unsubscribeSecond = store.subscribe(['claude'], second);
    await vi.runAllTicks();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.get('claude').data).toEqual(claudeUsage);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(invoke).toHaveBeenCalledTimes(2);

    unsubscribeSecond();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
