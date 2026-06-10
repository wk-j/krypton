import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  UsageStore,
  providerForBackend,
  summarizeUsage,
  type ClaudeUsage,
  type ProviderUsageState,
} from './usage-store';

const claudeUsage: ClaudeUsage = {
  fiveHour: { utilization: 27, resetsAt: null },
  sevenDay: { utilization: 84, resetsAt: null },
  sevenDayOpus: { utilization: 101, resetsAt: null },
  sevenDaySonnet: null,
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

  it('maps only providers with existing authoritative usage sources', () => {
    expect(providerForBackend('claude')).toBe('claude');
    expect(providerForBackend('codex')).toBe('codex');
    expect(providerForBackend('cursor')).toBe('cursor');
    expect(providerForBackend('copilot')).toBe('copilot');
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
