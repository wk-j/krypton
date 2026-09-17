# Harness Prompt-Cache Hit Rate — Implementation Spec

> Status: Implemented
> Date: 2026-09-16
> Milestone: Post-M-current polish
> Builds on: 214 (LLM usage log) · 72 (harness view) · 221 (status-line density)

## Problem

The harness already receives prompt-cache counters (`cachedReadTokens` / `cachedWriteTokens`) and prints them as raw `cache r↓ w↑` on the lane-stats row and as `cache r… w…` in `#usage`. That is not a metric you can check. You cannot tell whether this turn reused context (90%+ is normal for a long coding session) or broke the prefix and paid full price. The live cell is also the last-wins `lane.usage` merge, so a later turn that omits cache fields keeps the previous turn's counts next to the new turn's input — a mixed tuple that would lie if shown as a percentage.

## Solution

Compute a **hit rate from one coherent turn tuple**, never from the merged display aggregate. Show that percentage on the existing lane-stats cache cell (last reported turn) and on the `#usage` / `#daily` rollups (day totals). No new chip, no composer segment, no rail metric, no Xenon change.

## Research

**The fields are already on the wire.** ACP `Usage` (UNSTABLE) carries `inputTokens`, `outputTokens`, `cachedReadTokens?`, `cachedWriteTokens?` on the `session/prompt` response. Krypton already folds that into `lane.lastTurnUsage` when `isTurnUsage` (token fields present) and persists it in the spec-214 log. Mid-turn `usage_update` only carries context `used`/`size`/`cost` — it must not enter the rate.

**Krypton's own fixture proves the counters are disjoint.** `usage-log.test.ts` uses `inputTokens: 1200` with `cachedReadTokens: 90_000`. That is Anthropic's split (`input_tokens` = uncached, `cache_read_input_tokens` / `cache_creation_input_tokens` separate). A naive `cached / input` would print 7500%. Claude Code's official `prompt_cache.hit_ratio` is `cache_read / (cache_read + cache_write + uncached_input)`. Use that.

**Last-wins `mergeUsage` is the wrong source.** Spec 214 already warns that `lane.usage` is a display aggregate: each field independently keeps the last non-undefined value. Rate arithmetic needs the last *token-bearing* snapshot as a set. `lane.lastTurnUsage` is that snapshot during the turn, then `recordTurnUsage` clears it. A new `lane.lastTurnTokens` holds `extractCacheTokens(...)` from each token-bearing usage event and survives `finishTurn` until `#new` / respawn nulls `lane.usage`.

**Coverage stays honest.** Not every backend emits cache fields. Missing cache → no cell (today). Cache without `inputTokens` → keep today's raw counts, no invented %. Zero denom → no %.

**Density.** Spec 221 deleted token duplicates from the composer because the stats row already prints them. The cache cell is that row; replacing `r↓ w↑` with `99%` (counts in the tooltip) adds no width class. The stats row already wraps.

**Alternatives ruled out.**
- *Composer / rail chip* — spec 221: the stats row is visible in every layout, including Zen.
- *Unicode bar* — Claude Code statuslines use `████░░░░ 60%`. Krypton's context cell already speaks `%` as `N/N (32%)`; match that, no new glyph language.
- *Dollar savings* — ADR-0018: Krypton does not price. Xenon does, at read time.
- *Session rate on the live cell* — more stable, but hides a cache break until `#usage`. Last-turn % is the check; day % is the rollup.
- *Miss-cause attribution* (Claude Code `last_miss_cause`) — needs agent-side prefix diffs we do not have.
- *Xenon page column* — server repo, not this change.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| Claude Code | `/usage` `Prompt cache (main)` line; statusline `prompt_cache.hit_ratio` = read / (read + write + uncached). Warm/expire metadata. | Formula to copy. Miss-cause and TTL are out of reach. |
| cc-usage-monitor | Statusline cache bar (higher = greener) plus **this turn** and **session** rates after every task. | Confirms last-turn % is the live check; session/day belongs in a summary. |
| ccusage | Session table columns Cache Create / Cache Read, no ratio. | Counts without a rate — what Krypton does today. |
| Requesty | Industry `cached_tokens / input_tokens`. | Only valid when `input` already includes cache. Our fixture is the other convention. |
| Zed ACP thread | Context-window ratio (normal / warning / exceeded). No cache hit. | Closest ACP client; does not show this metric. |
| OpenCode dashboard (Krypton) | Aggregate Cache Read count. | Same raw counter, no rate. |

**Krypton delta** — same formula as Claude Code, on the existing stats cell rather than a statusline script or a second HUD. Keyboard-first: `#usage` remains the typed readout; no new key.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/usage-log.ts` | Export `cacheHitRate` and `formatCacheHitPercent`. `describeUsage` includes the day rate. |
| `src/acp/usage-log.test.ts` | Formula cases + `#usage` line. |
| `src/acp/harness-view-types.ts` | `lane.lastTurnTokens: CacheTokenTuple \| null`. |
| `src/acp/acp-harness-view.ts` | Set `lastTurnTokens` on token-bearing usage; clear with `usage` on respawn. |
| `src/acp/harness-lane-chrome.ts` | Cache cell shows `%` from `lastTurnTokens`; tooltip keeps counts. |
| `src/acp/harness-lane-chrome.test.ts` | Cell / tooltip / fallback. |
| `src/acp/daily-note.ts` | Lane table gains a Hit column. |
| `src/acp/daily-note.test.ts` | Hit cell. |
| `src/acp/hash-commands.ts` | `#usage` blurb names cache hit. |
| `docs/72-acp-harness-view.md` | Stats-row cache cell. |
| `docs/214-llm-usage-statistics.md` | Rate + coherent-tuple rule. |
| `docs/04-architecture.md` | One sentence on the live cell. |
| `docs/02-functional-requirements.md` | FR-ACP-024. |
| `docs/README.md` | Index this spec. |

No Rust, no IPC, no CSS class, no config, no Xenon.

## Design

### Formula

```ts
/** `cachedRead / (cachedRead + cachedWrite + input)`. Null when the
 *  percentage would be invented: missing input, missing cache-read, or denom 0.
 *  `cachedWrite` defaults to 0 when omitted. Thought tokens are not in the denom. */
export function cacheHitRate(tokens: {
  input?: number;
  cachedRead?: number;
  cachedWrite?: number;
}): number | null;

export function formatCacheHitPercent(rate: number): string; // `0%`–`100%`, rounded
```

Krypton's fixture `{ input: 1200, cachedRead: 90_000 }` → `99%`.
A first-turn write `{ input: 8000, cachedRead: 0, cachedWrite: 8000 }` → `0%`.
`{ cachedRead: 90_000 }` with no input → `null` (show counts, not a %).

### Data

```ts
// HarnessLane
lastTurnTokens: CacheTokenTuple | null; // coherent last token-bearing snapshot
```

```
1. session/prompt response (or _meta.usage) → AcpClient emits { type: 'usage', usage }
2. isTurnUsage? yes → lane.lastTurnUsage = usage
                 lane.lastTurnTokens = extractCacheTokens(usage)   // new
3. mergeUsage still updates lane.usage for context / in / out / cost (unchanged)
4. finishTurn → recordTurnUsage copies lastTurnUsage into the log, then
   lastTurnUsage = null. lastTurnTokens stays until the next token-bearing
   usage or a respawn (`lane.usage = null` also sets lastTurnTokens = null).
5. renderLaneStats reads lastTurnTokens, never lane.usage, for the cache cell.
```

A mid-turn `usage_update` without token fields does not touch `lastTurnTokens`.

`CacheTokenTuple` is intentionally separate from the persisted `TurnTokens` record. The log
schema requires numeric input/output fields for backward compatibility, while the live cache-rate
snapshot must preserve a missing input counter as missing. Reusing `TurnTokens` would turn absence
into zero and could display a false percentage.

### UI

Lane stats cache cell, in this order:

1. `lastTurnTokens` and `cacheHitRate(...) !== null` → visible `cache 99%`. Tooltip: `this turn 99% · read 90.0k · write 0 · input 1.2k`.
2. Else if `cachedRead` or `cachedWrite` is a number → today's `cache r↓ w↑` (cannot compute a rate).
3. Else omit the cell.

`#usage` head segment when any cache counter is non-zero:

```
cache 99% r90.0k w0
```

Per-model lines stay as they are (turns · in · out). Day rate is the headline.

`#daily` lane table: add `Hit` after `Cached read`, formatted by the same helper, or `—` when the rate is null.

### Keybindings / Configuration

None. `#usage` already exists.

## Edge Cases

- Adapter reports no cache fields → cell absent, `#usage` omits the cache segment (today).
- Cache fields without `inputTokens` → counts only, no %.
- All three zero → no % (denom 0); counts stay hidden by the existing `> 0` guard on `#usage`.
- `cachedRead > input + write` is legal under disjoint accounting and can round to `100%`.
- Remote harness: usage events still arrive; `lastTurnTokens` is display-only and does not depend on `usage_record`.
- Respawn / `#new` / `#new!` clears `lastTurnTokens` with `usage`.
- Several token-bearing usage events in one agentic turn: last one wins (same as `lastTurnUsage` / spec 214 last API call).

## Open Questions

None — last-turn % on the live cell vs session % as the headline is resolved above (last-turn live, day rollup in `#usage`).

## Out of Scope

- Composer, zen-rail, or peek chips
- Colour / bar for high vs low hit rate
- Estimated dollars saved
- Cache miss cause, TTL, warm/cold
- Xenon `/usage` table
- Changing how backends populate ACP `Usage`
- Thought tokens in the denominator

## Resources

- [ACP End-Turn Token Usage RFD](https://agentclientprotocol.com/rfds/end-turn-token-usage.md) — `Usage` shape (`cachedReadTokens` / `cachedWriteTokens` optional)
- [ACP Usage schema (draft)](https://agentclientprotocol.com/protocol/draft/schema) — field names; comments say "across all turns" but adapters (and spec 214) treat the prompt-response object as **per-turn**
- [Claude Code statusline `prompt_cache`](https://code.claude.com/docs/en/statusline.md) — official hit-ratio formula and denominator
- [Strake on cache hit rate](https://strake.dev/blog/read-your-coding-agent-token-usage) — Anthropic disjoint counters; `hit_rate = cache_read / (cache_read + cache_creation + uncached_input)`
- [ccusage session reports](https://ccusage.com/guide/session-reports) — Cache Create / Cache Read columns, no ratio
- [cc-usage-monitor](https://github.com/harveyxiacn/cc-usage-monitor) — this-turn vs session cache % after each task
- [Requesty coding-agent cache hit rates](https://www.requesty.ai/data/coding-agent-cache-hit-rate-apr-2026) — industry `cached / input`; rejected because our counters are disjoint
- Zed `crates/agent_ui` `TokenUsageTooltip` — context-window ratio only; no cache hit
