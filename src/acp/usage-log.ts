// Krypton — per-turn LLM usage rows (spec 214).
//
// One row per completed prompt turn, built from the `usage` the adapter returns
// on the `session/prompt` response. The row carries counts and identifiers ONLY
// — no prompt text, no response text, no file paths, no tool arguments. That is
// what makes it safe to stream to a server without asking each time.
//
// Kept free of Tauri and DOM so the row shape, the per-turn/context
// discrimination, and the summary line are testable without a running harness.

import type { UsageInfo } from './types';

/** Who drove the turn. Best-effort: it is what the lane state can prove. */
export type TurnOrigin = 'user' | 'telegram' | 'system';

export interface TurnTokens {
  input: number;
  output: number;
  cachedRead?: number;
  cachedWrite?: number;
  thought?: number;
  total?: number;
}

export interface TurnUsageRecord {
  v: 1;
  /** Idempotency key. Generated once, here — a retry after an ambiguous POST
   *  re-sends this id and the server counts it as a duplicate, never as spend. */
  id: string;
  /** Turn END, epoch ms. */
  at: number;
  durationMs: number | null;
  harnessId: string;
  lane: string;
  backend: string;
  model: string | null;
  /** True when the agent confirmed the model id; false when only the configured
   *  intent is known (spec 127) and the row should not be trusted as exact. */
  modelConfirmed: boolean;
  sessionId: string | null;
  turn: number;
  stopReason: string;
  origin: TurnOrigin;
  /** null when the adapter reported no token counters. NEVER zeros — a zero
   *  would silently understate the project; an absence is visible as one. */
  tokens: TurnTokens | null;
  context: { used: number | null; size: number | null } | null;
  /** Adapter-reported only. Estimates are computed by Xenon at read time so a
   *  rate-table fix re-prices history (ADR-0018). */
  cost: { amount: number; currency: string } | null;
}

/**
 * Does this `usage` event describe a TURN, or just the context level?
 *
 * Both arrive as `{ type: 'usage' }`. The `session/update` variant
 * (`usage_update`) only ever carries `used`/`size`/`cost` — a level, not a
 * turn's spend — while the prompt-response variant carries the token counters.
 * Presence of a token field is the only safe discriminator, so a context
 * refresh mid-turn can never be mistaken for a completed turn.
 */
export function isTurnUsage(usage: UsageInfo | null | undefined): boolean {
  if (!usage) return false;
  return typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number';
}

/** A turn longer than this is a slept laptop or a skewed clock, not work. */
const MAX_PLAUSIBLE_TURN_MS = 24 * 60 * 60 * 1000;

export interface TurnRecordInput {
  at: number;
  startedAt: number | null;
  harnessId: string;
  lane: string;
  backend: string;
  model: string | null;
  modelConfirmed: boolean;
  sessionId: string | null;
  turn: number;
  stopReason: string;
  origin: TurnOrigin;
  /** The raw per-turn usage, as received. Non-token-bearing input yields a row
   *  with `tokens: null` rather than no row: a turn that ran is a fact. */
  usage: UsageInfo | null;
  /** The lane's merged usage, used only for the context level. */
  context: UsageInfo | null;
}

export function buildTurnRecord(input: TurnRecordInput, idSuffix?: string): TurnUsageRecord {
  const duration =
    input.startedAt !== null && input.at >= input.startedAt ? input.at - input.startedAt : null;

  return {
    v: 1,
    id: `usg-${input.at}-${idSuffix ?? randomSuffix()}`,
    at: input.at,
    durationMs: duration !== null && duration <= MAX_PLAUSIBLE_TURN_MS ? duration : null,
    harnessId: input.harnessId,
    lane: input.lane,
    backend: input.backend,
    model: input.model,
    modelConfirmed: input.modelConfirmed,
    sessionId: input.sessionId,
    turn: input.turn,
    stopReason: input.stopReason,
    origin: input.origin,
    tokens: extractTokens(input.usage),
    context: extractContext(input.context ?? input.usage),
    cost: extractCost(input.usage ?? input.context),
  };
}

function extractTokens(usage: UsageInfo | null): TurnTokens | null {
  if (!isTurnUsage(usage) || !usage) return null;
  const tokens: TurnTokens = {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
  };
  if (typeof usage.cachedReadTokens === 'number') tokens.cachedRead = usage.cachedReadTokens;
  if (typeof usage.cachedWriteTokens === 'number') tokens.cachedWrite = usage.cachedWriteTokens;
  return tokens;
}

function extractContext(usage: UsageInfo | null): { used: number | null; size: number | null } | null {
  if (!usage) return null;
  const used = typeof usage.used === 'number' ? usage.used : null;
  const size = typeof usage.size === 'number' ? usage.size : null;
  return used === null && size === null ? null : { used, size };
}

function extractCost(usage: UsageInfo | null): { amount: number; currency: string } | null {
  if (!usage?.cost || typeof usage.cost.amount !== 'number') return null;
  return { amount: usage.cost.amount, currency: usage.cost.currency || 'USD' };
}

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------- rollup presentation

/** Mirrors `usage_log::UsageRollup` in Rust, which owns the arithmetic because
 *  it owns the log file. This side only formats. */
export interface UsageRollup {
  date: string;
  turns: number;
  turnsWithoutTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  reportedCost: number;
  reportedCostTurns: number;
  currency: string;
  byModel: UsageGroup[];
  byLane: UsageGroup[];
  /** Rows recorded but not yet acknowledged by Xenon. */
  unsent: number;
  /** False when `[usage_log].enabled = false` — the caller must say so rather
   *  than render a legitimate-looking row of zeros. */
  recording: boolean;
}

export interface UsageGroup {
  key: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  reportedCost: number;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Multi-line transcript read-out for `#usage`.
 *
 * Reports "no turns" and "recording off" as themselves. Unreported turns and
 * unsent rows are named whenever non-zero, because a total that silently
 * excludes them is the failure mode this whole feature exists to avoid.
 */
export function describeUsage(rollup: UsageRollup): string {
  if (!rollup.recording) {
    return 'usage recording is off — set [usage_log].enabled = true';
  }
  if (rollup.turns === 0) {
    return `No turns recorded for ${rollup.date}.`;
  }

  const head = [`${rollup.date}: ${rollup.turns} turns`];
  head.push(
    `↑${formatTokenCount(rollup.inputTokens)} ↓${formatTokenCount(rollup.outputTokens)}`,
  );
  if (rollup.cachedReadTokens > 0 || rollup.cachedWriteTokens > 0) {
    head.push(
      `cache r${formatTokenCount(rollup.cachedReadTokens)} w${formatTokenCount(rollup.cachedWriteTokens)}`,
    );
  }
  if (rollup.reportedCostTurns > 0) {
    head.push(`${rollup.currency} ${rollup.reportedCost.toFixed(4)} reported (${rollup.reportedCostTurns} turns)`);
  }

  const lines = [head.join(' · ')];
  for (const g of rollup.byModel) {
    lines.push(
      `  ${g.key}  ${g.turns} turns · ↑${formatTokenCount(g.inputTokens)} ↓${formatTokenCount(g.outputTokens)}`,
    );
  }
  if (rollup.turnsWithoutTokens > 0) {
    lines.push(`  ${rollup.turnsWithoutTokens} turns reported no token counters`);
  }
  if (rollup.unsent > 0) {
    lines.push(`  ${rollup.unsent} rows not yet accepted by Xenon (will retry)`);
  }
  return lines.join('\n');
}
