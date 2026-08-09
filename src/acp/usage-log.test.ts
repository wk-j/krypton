import { describe, expect, it } from 'vitest';

import {
  buildTurnRecord,
  describeUsage,
  isTurnUsage,
  type TurnRecordInput,
  type UsageRollup,
} from './usage-log';

function input(overrides: Partial<TurnRecordInput> = {}): TurnRecordInput {
  return {
    at: 1_786_233_600_000,
    startedAt: 1_786_233_580_000,
    harnessId: 'hm-1',
    lane: 'Claude-1',
    backend: 'claude',
    model: 'claude-opus-5',
    modelConfirmed: true,
    sessionId: 'sess-1',
    turn: 3,
    stopReason: 'end_turn',
    origin: 'user',
    usage: { inputTokens: 1200, outputTokens: 340, cachedReadTokens: 90_000 },
    context: { used: 132_000, size: 1_000_000 },
    ...overrides,
  };
}

function rollup(overrides: Partial<UsageRollup> = {}): UsageRollup {
  return {
    date: '2026-08-09',
    turns: 0,
    turnsWithoutTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reportedCost: 0,
    reportedCostTurns: 0,
    currency: 'USD',
    byModel: [],
    byLane: [],
    unsent: 0,
    recording: true,
    ...overrides,
  };
}

describe('isTurnUsage', () => {
  it('accepts the prompt-response shape, which carries token counters', () => {
    expect(isTurnUsage({ inputTokens: 10, outputTokens: 2 })).toBe(true);
    expect(isTurnUsage({ outputTokens: 2 })).toBe(true);
  });

  // The `usage_update` notification reports the context LEVEL mid-turn. Treating
  // one as a completed turn would invent turns that never ended.
  it('rejects a context-level update, however much else it carries', () => {
    expect(isTurnUsage({ used: 132_000, size: 1_000_000 })).toBe(false);
    expect(isTurnUsage({ used: 5, cost: { amount: 0.2, currency: 'USD' } })).toBe(false);
    expect(isTurnUsage(null)).toBe(false);
    expect(isTurnUsage(undefined)).toBe(false);
  });
});

describe('buildTurnRecord', () => {
  it('transcribes the reported counters without differencing them', () => {
    const record = buildTurnRecord(input(), 'deadbeef');
    expect(record.tokens).toEqual({ input: 1200, output: 340, cachedRead: 90_000 });
    expect(record.context).toEqual({ used: 132_000, size: 1_000_000 });
    expect(record.durationMs).toBe(20_000);
    expect(record.id).toBe('usg-1786233600000-deadbeef');
  });

  // A zero would be indistinguishable from a genuinely free turn and would drag
  // every average down silently; an absence is visible in the rollup.
  it('records no tokens at all when the adapter reported none', () => {
    const record = buildTurnRecord(input({ usage: { used: 90, size: 1000 } }), 'a');
    expect(record.tokens).toBeNull();
    expect(record.context).toEqual({ used: 132_000, size: 1_000_000 });
  });

  it('keeps a turn that ran but reported nothing at all', () => {
    const record = buildTurnRecord(input({ usage: null, context: null }), 'a');
    expect(record.tokens).toBeNull();
    expect(record.context).toBeNull();
    expect(record.turn).toBe(3);
  });

  // A slept laptop yields a "turn" of many hours. Recording it would poison any
  // duration statistic, and there is no way to recover the real value.
  it('drops an implausible duration rather than recording a lie', () => {
    const at = 1_786_233_600_000;
    expect(buildTurnRecord(input({ at, startedAt: at - 25 * 3600 * 1000 }), 'a').durationMs).toBeNull();
    expect(buildTurnRecord(input({ at, startedAt: at + 5000 }), 'a').durationMs).toBeNull();
    expect(buildTurnRecord(input({ at, startedAt: null }), 'a').durationMs).toBeNull();
  });

  it('flags an unconfirmed model so a report can tell intent from fact', () => {
    const record = buildTurnRecord(input({ model: 'gpt-5', modelConfirmed: false }), 'a');
    expect(record.model).toBe('gpt-5');
    expect(record.modelConfirmed).toBe(false);
  });

  it('carries adapter-reported cost through and defaults the currency', () => {
    const withCost = buildTurnRecord(
      input({ usage: { inputTokens: 1, outputTokens: 1, cost: { amount: 0.42, currency: '' } } }),
      'a',
    );
    expect(withCost.cost).toEqual({ amount: 0.42, currency: 'USD' });
    expect(buildTurnRecord(input(), 'a').cost).toBeNull();
  });

  it('generates a distinct id per turn so retries dedupe but turns do not', () => {
    const a = buildTurnRecord(input());
    const b = buildTurnRecord(input());
    expect(a.id).not.toBe(b.id);
  });

  // The row is the thing that leaves the machine unattended. Anything beyond
  // counts and identifiers would make that unsafe.
  it('carries no free text beyond identifiers', () => {
    const serialized = JSON.stringify(buildTurnRecord(input(), 'a'));
    const keys = Object.keys(buildTurnRecord(input(), 'a'));
    expect(keys).toEqual([
      'v', 'id', 'at', 'durationMs', 'harnessId', 'lane', 'backend', 'model',
      'modelConfirmed', 'sessionId', 'turn', 'stopReason', 'origin', 'tokens',
      'context', 'cost',
    ]);
    expect(serialized).not.toContain('prompt');
  });
});

describe('describeUsage', () => {
  it('says recording is off rather than showing a row of zeros', () => {
    expect(describeUsage(rollup({ recording: false }))).toContain('recording is off');
  });

  it('reports an empty day as empty', () => {
    expect(describeUsage(rollup())).toBe('No turns recorded for 2026-08-09.');
  });

  it('names unreported turns and undelivered rows instead of hiding them', () => {
    const text = describeUsage(
      rollup({ turns: 10, turnsWithoutTokens: 3, unsent: 4, inputTokens: 2_500_000, outputTokens: 4200 }),
    );
    expect(text).toContain('10 turns');
    expect(text).toContain('↑2.5M');
    expect(text).toContain('3 turns reported no token counters');
    expect(text).toContain('4 rows not yet accepted');
  });

  it('omits the cost segment when no adapter reported one', () => {
    expect(describeUsage(rollup({ turns: 1 }))).not.toContain('reported (');
  });
});
