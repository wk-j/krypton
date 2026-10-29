import { describe, expect, it } from 'vitest';

import { RAILS_LIMITS, railsAssistConfig, resolveRailsConfig } from './config';

function blob(rails: Record<string, unknown>): unknown {
  return { acp_harness: { rails } };
}

describe('resolveRailsConfig', () => {
  it('defaults to auto, claude, haiku and the fallbacks', () => {
    expect(resolveRailsConfig(undefined)).toEqual({
      mode: 'auto',
      backendId: 'claude',
      modelId: 'haiku',
      timeoutMs: RAILS_LIMITS.timeoutMs.fallback,
      maxInputChars: RAILS_LIMITS.maxInputChars.fallback,
      debounceMs: RAILS_LIMITS.debounceMs.fallback,
      minIntervalMs: 0,
    });
    expect(resolveRailsConfig({ acp_harness: {} }).mode).toBe('auto');
  });

  it('reads valid values', () => {
    expect(resolveRailsConfig(blob({
      mode: 'manual', backend: 'codex', model: 'gpt-5-mini', timeout_ms: 30_000, max_input_chars: 10_000, debounce_ms: 2_000,
      min_interval_ms: 600_000,
    }))).toEqual({
      mode: 'manual', backendId: 'codex', modelId: 'gpt-5-mini', timeoutMs: 30_000, maxInputChars: 10_000, debounceMs: 2_000,
      minIntervalMs: 600_000,
    });
  });

  it('fails closed to off on a present but invalid mode', () => {
    expect(resolveRailsConfig(blob({ mode: 'always' })).mode).toBe('off');
    expect(resolveRailsConfig(blob({ mode: 3 })).mode).toBe('off');
    expect(resolveRailsConfig(blob({ mode: '' })).mode).toBe('off');
  });

  it('maps an empty model to the backend default and an empty backend to claude', () => {
    const cfg = resolveRailsConfig(blob({ model: '  ', backend: '' }));
    expect(cfg.modelId).toBeUndefined();
    expect(cfg.backendId).toBe('claude');
  });

  it('clamps and rounds numbers, ignoring non-numbers', () => {
    const low = resolveRailsConfig(blob({ timeout_ms: 1, max_input_chars: 10, debounce_ms: 0, min_interval_ms: -5 }));
    expect([low.timeoutMs, low.maxInputChars, low.debounceMs, low.minIntervalMs]).toEqual([10_000, 4_000, 1_000, 0]);
    const high = resolveRailsConfig(blob({ timeout_ms: 1e9, max_input_chars: 1e9, debounce_ms: 1e9, min_interval_ms: 1e9 }));
    expect([high.timeoutMs, high.maxInputChars, high.debounceMs, high.minIntervalMs])
      .toEqual([180_000, 80_000, 60_000, 3_600_000]);
    const odd = resolveRailsConfig(blob({ timeout_ms: '5', max_input_chars: Number.NaN, debounce_ms: 1_500.6, min_interval_ms: '600000' }));
    expect([odd.timeoutMs, odd.maxInputChars, odd.debounceMs, odd.minIntervalMs]).toEqual([60_000, 32_000, 1_501, 0]);
  });
});

describe('railsAssistConfig', () => {
  it('projects the judge budget for the engine', () => {
    const cfg = resolveRailsConfig(blob({ mode: 'manual', model: '' }));
    expect(railsAssistConfig(cfg)).toEqual({
      mode: 'manual', backendId: 'claude', modelId: undefined, timeoutMs: 60_000, maxInputChars: 32_000, options: {},
    });
  });
});
