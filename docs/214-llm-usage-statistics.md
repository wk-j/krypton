# LLM Usage Statistics — Implementation Spec

> Status: Implemented
> Date: 2026-08-09
> Milestone: M-ACP — Harness convergence (new axis: per-project LLM accounting)
> Builds on: 212 (Xenon server — auth, projects, transport) · 213 + ADR-0017 (backend link) ·
> 91 (lane resource metrics) · 69/127 (ACP lanes + model selection) ·
> 153/187/193 (subscription meters — a *different* dataset)
> Revised 2026-08-09 (user direction): turns stream to Xenon **live, one row per turn**. The earlier
> draft published a daily `turns.jsonl` as a spec-212 resource and required a manual `#push`; both are
> superseded. See Open Questions 2 and 3.
>
> **Implementation deviations (2026-08-09)** — everything else landed as written:
> 1. **`hostname` is stamped in Rust, not the frontend.** The TS row omits it; `usage_log::record`
>    fills it before the append. Which machine this is was never the view's business.
> 2. **The rollup lives only in Rust.** The spec listed `rollup(rows)` in `usage-log.ts` too; two
>    implementations of the same arithmetic is exactly the divergence this feature is meant to
>    detect. TypeScript keeps the row shape, the per-turn/context discrimination, and the formatting.
> 3. **A `401` backs off to the maximum interval instead of stopping.** "Stops retrying" would need
>    an explicit re-arm after `#xenon token`; a 5-minute retry is not hammering and drains the
>    backlog by itself once the credential is fixed.
> 4. **Xenon ships no real prices.** `assets/prices.example.json` carries the patterns with zeroed
>    rates and a link to each provider's price page, and `PriceTable::estimate` treats an all-zero
>    entry as *unfilled* rather than free. Shipping invented rates that render as a confident total
>    is the one failure mode worse than a blank column.
> 5. **The Xenon schema step is v4, not v5** — the database was at v3, not v4.
> 6. **The retention pass runs on the sender's first cycle**, not at app start: the project
>    directory is not known until the harness reports one.
> 7. **`#usage flush` replaces `#push usage`.** `usage` never became a `#push` kind, because it
>    never became a resource kind.

## Problem

A project's LLM spend is invisible. The harness shows a live token chip per lane, but the numbers are
transient in-memory state: close the lane and the turn is gone. Nobody can answer "how many tokens did
this project burn last week, on which model, in which lane, and what did it cost" — across twelve
different agent backends whose only common ground is that they all charge by the token.

## Solution

Post one **turn** row to Xenon the moment the turn ends, into a real `usage_turn` table.

- **The unit is a turn**, because that is the unit ACP reports: the `session/prompt` response carries
  `usage` for that turn, so the row is transcribed, never differenced or estimated.
- **Numbers only.** A row holds timestamps, lane, backend, model, stop reason, token counts, context
  level and — when the adapter volunteers one — cost. No prompt text, no response text, no file paths,
  no tool arguments. This is what makes a live stream safe to send at all.
- **Live, automatic, and unattended.** `finishTurn` hands the row to Rust, which posts it within
  a second. Nobody runs a command; there is no daily bundle and no manual `#push`.
- **Not a spec-212 resource.** The resource envelope is content-addressed files with revisions — right
  for a review bundle, wrong for a 300-byte numeric row: appending one turn would mean re-uploading and
  re-sealing the whole day. Usage gets its own ingest endpoint and its own table (ADR-0019).
- **Durable through an outbox.** Every row is appended to a local write-ahead log first and only marked
  sent once Xenon acknowledges it, so a dead link or a closed laptop costs nothing.
- **Idempotent by row id**, so a retry after an ambiguous failure can never double-count spend.
- **Xenon prices it, Krypton doesn't.** Xenon holds a per-model rate table and estimates cost at read
  time for rows whose adapter reported none, keeping reported and estimated in separate columns.

## Research

**Turn usage is already on the wire — verified, not assumed.** The ACP SDK's `Usage` type is documented
as *"Token usage information for a prompt turn"* (marked UNSTABLE/experimental):
`totalTokens`, `inputTokens`, `outputTokens`, `thoughtTokens?`, `cachedReadTokens?`, `cachedWriteTokens?`
(`@agentclientprotocol/sdk/dist/schema/zod.gen.d.ts:5639`). `codex-acp` fills it from
`sessionState.lastTokenUsage` (`dist/index.js:28870`, `28941`, `28962` → `buildPromptUsage`), i.e. the
**last** model request of the turn — per-turn, not cumulative.

**Krypton already receives it and throws it away.** `AcpClient.prompt` reads `result.usage ?? result._meta.usage`
and emits `{ type: 'usage' }` immediately before `{ type: 'stop' }` (`src/acp/client.ts:188-201`);
`acp-harness-view.ts:6898` folds it into `lane.usage` via last-wins `mergeUsage`, which is a *display*
aggregate — each turn's own numbers are overwritten and never persisted. `finishTurn`
(`acp-harness-view.ts:7375`) is the exact seam where a row can be emitted, and `lane.activeTurnStartedAt`
gives the duration.

**Two different shapes arrive on the same event.** The `session/update` variant `usage_update`
(`client.ts:271`) only ever carries `used`/`size`/`cost` — a context *level*, not a turn's spend. Only
the prompt-response variant carries `inputTokens`/`outputTokens`. Presence of a token field is therefore
the discriminator, and the only safe one.

**Coverage is partial and must stay visible.** Twelve backends are built in (`acp.rs:37`) — claude,
gemini, codex, opencode, pi-acp, droid, cursor, junie, omp, grok, copilot, mimo, cline — and not all
emit usage; `docs/109` already tells surfaces to render `tokens --` when absent. A missing counter must
produce a row marked unreported, never a zero, or the totals lie.

**What spec 212 gives this feature and what it does not.** Reusable as-is: project identity
(`derive_project`), the keychain-held bearer token, the `reqwest` client, and the retry queue's
backoff shape. Not reusable: the resource/revision/blob model. A revision is *sealed* and a resource's
history is a chain of whole snapshots — appending 128 turns a day would mean 128 re-uploads of a
growing file, or one push a day and a ledger that is stale by up to 24 hours. Xenon's other table,
`event` (the activity feed), is also wrong: it is audience-scoped human-readable activity with frozen
display strings, not numeric telemetry to aggregate.

**Volume is small.** ~130 turns/day/project observed here → ~47k rows/year/project, a few MB in
SQLite. No partitioning, no GC, no retention policy needed on the server.

**This is not the subscription meter.** Specs 153/187/193 poll plan utilization (5-hour windows, weekly
buckets, quota percentages) from vendor APIs. That answers "how close am I to the cap"; this answers
"what did this project consume". Same noun, different dataset, no shared storage.

**Alternatives ruled out.** *Derive spend from the transcript* — the transcript has no token counts.
*Count tokens locally with a tokenizer* — every provider tokenizes differently and Krypton would be
inventing numbers the biller disagrees with. *Ship a price table in Krypton* — prices change on the
provider's schedule; a table baked into a desktop build is stale the week after release (ADR-0018).
*Publish a daily JSONL as a resource* — see Open Question 2.

## Prior Art

| System | Implementation | Notes |
|---|---|---|
| Langfuse ingestion | Batched `POST /api/public/ingestion` of per-generation events, each with a client-supplied **id** so retries are idempotent; cost computed at ingestion when usage is present and a regex-matched model definition exists; ingested cost beats computed cost. | The direct model for this design: per-event rows, client-generated ids, idempotent upsert. Krypton diverges on *when* pricing happens (read time, so a rate-table fix re-prices history) and captures no prompt/response. |
| OpenTelemetry GenAI semconv | `gen_ai.usage.input_tokens` / `output_tokens` on a span with `gen_ai.request.model` and `gen_ai.provider.name`; exported continuously over OTLP with client-side batching. | Field naming and the input/output split are conventional, so the row mirrors them. Rejected as the transport: it needs a collector the user does not run, and per-*request* granularity no ACP adapter exposes. |
| ccusage | TypeScript CLI parsing Claude Code's local JSONL logs into daily/session tables; groups by project; prices offline from a cached copy of LiteLLM's table; tracks cache tokens as their own column. | Source of the separate cached-token columns and the per-project grain. Diverges: ccusage reconstructs one vendor's history after the fact; Krypton emits its own rows live, across every backend. |
| LiteLLM `model_prices_and_context_window.json` | One JSON file keyed by model id with input/output/cached rates per million tokens, updated by CI, fetched at runtime; a backup copy ships in-tree. | The shape of Xenon's `prices.json` and the argument for keeping it server-side and replaceable without a client release. |
| Claude Code `/cost` + OTEL export | In-session totals for the current session; org-level telemetry via an OpenTelemetry exporter. | Confirms per-session totals are the accepted floor. Krypton's grain is finer (per turn) and the scope is a project, not a session. |
| Cursor / Copilot dashboards | Vendor-hosted per-account spend and request counts in a web UI. | Confirms the browse-in-a-browser surface. Diverges: they are per-vendor and per-account; nobody can put a Cursor turn and a Claude turn in one project ledger. |

**Krypton delta.** No terminal, multiplexer, or agent harness streams per-turn spend for a project —
the market equivalent is per-vendor billing dashboards, single-vendor log scrapers, and LLM-observability
SaaS you point your own application code at. Krypton diverges in three ways: **one live ledger spans
twelve vendors' agents**, so a project's number is the real number and not one vendor's slice; the row is
**content-free by construction**, unlike observability products that exist to capture prompts; and it
lands in a server **the user runs**, with the local write-ahead log as the authority if that server is
down.

## Affected Files

### Krypton

| File | Change |
|---|---|
| `src/acp/usage-log.ts` | **new** — `TurnUsageRecord`, `buildTurnRecord(lane, usage, stopReason)`, local `rollup(rows)`; DOM- and Tauri-free so the shape and the arithmetic are unit-testable |
| `src/acp/usage-log.test.ts` | **new** — per-turn vs context-level discrimination, missing counters, rollup grouping, id stability |
| `src/acp/acp-harness-view.ts` | stash the raw token-bearing usage on the lane in `case 'usage'`; emit the row in `finishTurn`; `#usage` handler |
| `src/acp/harness-view-types.ts` | `lane.lastTurnUsage: UsageInfo \| null`, `lane.turnSeq: number` |
| `src/acp/hash-commands.ts` | register `#usage` |
| `src-tauri/src/usage_log.rs` | **new** — the outbox: append to `.krypton/usage/<date>.jsonl`, an ack cursor, the live sender task (immediate POST, backoff, batch drain), local rollup for `#usage`, prune past `retain_days` |
| `src-tauri/src/xenon.rs` | expose `base_url` / project / keychain-token resolution and the shared `reqwest` client to `usage_log.rs`; feed push outcomes into the spec-213 link state as today |
| `src-tauri/src/commands.rs`, `lib.rs` | `usage_record`, `usage_today`, `usage_flush` commands + registration; start the sender task; drain the outbox at startup and best-effort on exit |
| `src-tauri/src/config.rs` | `[usage_log]` section |
| `docs/06-configuration.md`, `docs/04-architecture.md`, `docs/PROGRESS.md` | doc updates |
| `docs/adr/0018-llm-usage-is-priced-by-xenon-not-krypton.md` | **new** ADR |
| `docs/adr/0019-usage-is-telemetry-not-a-published-resource.md` | **new** ADR — why usage sits outside the resource envelope and therefore outside ADR-0016's explicit-push rule |

### Xenon (`~/Source/xenon`)

| File | Change |
|---|---|
| `src/db.rs` | schema v5: `usage_turn` table + indexes (below) |
| `src/usage.rs` | **new** — ingest handler, validation, idempotent upsert, aggregation queries |
| `src/price.rs` | **new** — `prices.json` loader (regex match → per-million rates), `estimate(model, tokens) -> Option<Money>` |
| `src/api.rs` | `POST /v1/projects/{p}/usage/turns` · `GET /v1/projects/{p}/usage` |
| `src/web.rs` | `GET /p/{project}/usage` — Binance-dark totals + by-model / by-lane tables |
| `assets/prices.json`, `docs/01-protocol.md`, `README.md` | seeded rate table + protocol extract |

## Design

### Data Structures

```ts
// src/acp/usage-log.ts — one completed prompt turn. Counts and identifiers only.
export interface TurnUsageRecord {
  v: 1;
  id: string;                 // "usg-<epochMs>-<8 hex>" — the idempotency key, generated once
  at: number;                 // turn END, epoch ms
  durationMs: number | null;  // null when unknown or implausible (>24h: sleep/clock skew)
  hostname: string;
  harnessId: string;
  lane: string;               // display label, e.g. "Claude-3"
  backend: string;            // "claude" | "codex" | … (acp.rs backend id)
  model: string | null;
  modelConfirmed: boolean;    // true = agent-confirmed currentModelId; false = configured intent
  sessionId: string | null;
  turn: number;               // 1-based within the session; resets on respawn
  stopReason: string;         // end_turn | cancelled | max_tokens | refusal | …
  origin: 'user' | 'telegram' | 'system';
  tokens: TurnTokens | null;  // null => the adapter reported none. NEVER zeros.
  context: { used: number | null; size: number | null } | null;
  cost: { amount: number; currency: string } | null;  // adapter-reported only
}

export interface TurnTokens {
  input: number; output: number;
  cachedRead?: number; cachedWrite?: number; thought?: number; total?: number;
}
```

```sql
-- Xenon schema v5. One row per turn; `id` is the client's key, so re-delivery is free.
CREATE TABLE IF NOT EXISTS usage_turn (
    id             TEXT NOT NULL,              -- TurnUsageRecord.id
    project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    at             INTEGER NOT NULL,           -- turn end, epoch ms
    duration_ms    INTEGER,
    hostname       TEXT NOT NULL,
    harness_id     TEXT NOT NULL,
    lane           TEXT NOT NULL,
    backend        TEXT NOT NULL,
    model          TEXT,
    model_confirmed INTEGER NOT NULL DEFAULT 0,
    session_id     TEXT,
    turn_seq       INTEGER,
    stop_reason    TEXT NOT NULL,
    origin         TEXT NOT NULL,
    has_tokens     INTEGER NOT NULL,           -- 0 => the adapter reported none; columns below are NULL
    input_tokens   INTEGER, output_tokens INTEGER,
    cached_read    INTEGER, cached_write  INTEGER, thought_tokens INTEGER, total_tokens INTEGER,
    context_used   INTEGER, context_size  INTEGER,
    cost_amount    REAL, cost_currency TEXT,   -- adapter-reported only; estimates are computed on read
    received_at    INTEGER NOT NULL,           -- server clock, so client skew is detectable
    uploaded_by    TEXT REFERENCES user(id) ON DELETE SET NULL,
    PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS usage_turn_time_idx  ON usage_turn(project_id, at DESC);
CREATE INDEX IF NOT EXISTS usage_turn_model_idx ON usage_turn(project_id, model, at DESC);
CREATE INDEX IF NOT EXISTS usage_turn_lane_idx  ON usage_turn(project_id, lane, at DESC);
```

### API / Commands

**Ingest** — `POST /v1/projects/{project}/usage/turns`, `Authorization: Bearer <token>` with
`resource:write`:

```jsonc
// request                                  // response
{ "turns": [ TurnUsageRecord, … ] }         { "accepted": 3, "duplicates": 1, "rejected": [] }
```

`INSERT … ON CONFLICT(project_id, id) DO NOTHING` per row, all in one transaction: re-delivering a row
Krypton was unsure about is counted as a duplicate, never as new spend. A malformed row is named in
`rejected[]` and the rest still land — one bad row must not block a fleet's ledger. Batch cap 500;
body cap 1 MB. The project is created on first post exactly as it is on first resource push, and the
existing `resource:write` scope is reused so every token already minted for Krypton keeps working.

**Read** — `GET /v1/projects/{p}/usage?from=&to=&group=day|model|lane|backend` → totals plus grouped
rows, each with `reportedCost` and `estimatedCost` as separate fields, and `unpriced[]` naming models
no rate matched. Bearer with `resource:read`, a session cookie, or public if the project is.

Tauri: `usage_record(cwd, record)` (append to the outbox and wake the sender) · `usage_today(cwd)`
(local rollup for `#usage`, works offline) · `usage_flush(cwd)` (drain now; for `#usage flush`).

### Data Flow

```
1. Turn ends. AcpClient emits { type:'usage', usage } then { type:'stop' }  (client.ts:196-198).
2. The 'usage' case stores it on lane.lastTurnUsage ONLY when a token field is present; a
   context-only usage_update updates lane.usage as today and is not mistaken for a turn.
3. finishTurn builds a TurnUsageRecord (id generated here, once) and calls usage_record without
   awaiting — recording never delays the UI.
4. Rust appends the row to <project>/.krypton/usage/<YYYY-MM-DD>.jsonl (O_APPEND, one write per
   line) — this happens BEFORE any network call, so the row survives a crash mid-post.
5. The sender task wakes, takes every row after the ack cursor, and POSTs them (usually one).
6. On 2xx the ack cursor advances past those ids. On failure it does not move, and the next attempt
   re-sends the same rows — safe, because the server deduplicates on id.
7. Xenon inserts the rows. Cost is NOT stored for unreported rows; it is computed on read from
   prices.json, so editing a rate re-prices all history.
```

### Delivery and durability

- **Latency** — the sender wakes on every append, so a turn is normally on the server within a second.
  There is no batching window on the happy path; batching exists only to drain a backlog.
- **Backoff** — on transport failure or 5xx: 2s, 4s, 8s … capped at 5 min, with jitter. On `401`
  (revoked/expired token) it stops retrying and marks the link unauthorized for spec 213 rather than
  hammering; recording continues and the backlog drains once the token is fixed.
- **Ack cursor** — `.krypton/usage/.cursor.json` holds `{ file, lineOffset }` for the last acked row.
  A cursor pointing into a pruned file resets forward, never backward, so pruning cannot resurrect
  already-sent rows.
- **Backlog cap** — the outbox drains oldest-first in batches of 500. Rows older than `retain_days`
  are pruned whether or not they were sent; a two-month-old unsent row is not worth an unbounded
  queue, and its absence is visible as a gap rather than as wrong totals.
- **Failure is silent by design** — no transcript line on a failed send. A background ledger that
  interrupts the human every time a server blips gets switched off within a day. The workspace footer's
  backend-link segment (spec 213) already shows a dead link, and `#usage` reports the unsent count.

### Keybindings

No new leader key, and **no command is required to publish**. `#usage` is a read-out.

| Command | Action |
|---|---|
| `#usage` | today's totals from the local log: turns, in/out, cached, reported cost, per-model split, plus the unsent count when non-zero |
| `#usage <YYYY-MM-DD>` | the same for one past day still on disk |
| `#usage flush` | drain the outbox now instead of waiting for backoff — for after fixing a token or URL |
| `#usage open` | open `<base_url>/p/<project>/usage` in the OS browser |

### UI Changes

Krypton: transcript system lines only — no new DOM, no chip, no panel. The live per-lane token chip
(spec 156) is unchanged and remains the in-the-moment view.

Xenon `/p/<project>/usage`: a date-range header, a totals row, and two tables (by model, by lane) with
columns *turns · input · output · cached read · cached write · reported · estimated*. Per
`DESIGN.binance.md`; tables, no charts, no left accent rails. The page renders on load — Xenon does not
push to browsers (spec 212 keeps SSE out of scope), so "realtime" here means Krypton→Xenon, and the
page is current as of its last reload.

A usage turn writes **no** activity-feed `event` row. 130 rows a day would bury every human-meaningful
event in the feed.

### Configuration

```toml
[usage_log]
enabled     = true   # bool — record turn statistics at all
publish     = true   # bool — stream to Xenon; needs [xenon].enabled + a stored token
retain_days = 90     # int  — local .jsonl day files older than this are pruned at start
```

No `[xenon].auto_push` entry: that list is for resource kinds whose default is manual and whose
automation is a per-user opt-in. Usage inverts that — it is live by definition and `publish = false`
is the opt-*out*. Two switches for one behaviour would only create a state where one says yes and the
other says no.

## Edge Cases

- **Adapter reports no tokens** — the row is sent with `tokens: null` / `has_tokens = 0` and counted
  separately. A zero would silently understate the project.
- **Codex multi-request turn** — `lastTokenUsage` is the turn's *last* model request, so a long
  multi-request turn under-reports. Recorded as reported; Krypton does not reconstruct what the
  adapter did not send.
- **Cancelled turn** — still recorded, with `stopReason: "cancelled"`. Tokens spent before a cancel are
  spent; hiding them would make cancels look free.
- **Ambiguous POST** (timeout after the server committed) — retried, deduplicated on `id`, reported as
  `duplicates`. This is the whole reason the id is generated client-side, once, before the first send.
- **Xenon unreachable / laptop closed** — rows keep appending locally and the cursor stays put; the
  backlog drains when the link returns. Nothing is lost inside `retain_days`.
- **Xenon disabled or no token** — nothing is sent and nothing retried; recording continues, so
  configuring Xenon later uploads the whole retained backlog on the next drain.
- **Token revoked mid-stream** — `401` stops the retry loop and flags the link unauthorized rather than
  looping; the backlog is intact and drains after `#xenon token`.
- **Crash between append and POST** — the append happens first, so the row is in the log and the
  cursor did not move: it is sent at next startup.
- **Two harnesses in one project** — both append to the same day file; one `write` per line under
  `O_APPEND` is atomic at these sizes, and rows carry `harnessId`. The sender is one task per app.
- **Two machines, same project** — both post to the same table; `hostname` distinguishes them and ids
  cannot collide (epoch ms + 8 random hex per machine).
- **Clock skew** — `received_at` is the server's own clock, so a client with a wrong clock is
  detectable rather than silently mis-bucketed; `at` is still what the reports group by.
- **Turn crosses midnight** — filed by its end timestamp. Grouping is a server-side query, so there is
  no day-boundary artefact to reconcile.
- **Model switched mid-turn** — the model at turn end is recorded. When only configured intent is known
  (`currentModelId` null, spec 127), `model_confirmed = 0` marks the row as unverified.
- **Lane respawn / new session** — `turn` restarts at 1; `sessionId` disambiguates. Rows are immutable
  once accepted; a correction would be a new row, and v1 never corrects.
- **Unknown model at read time** — no regex matches → `estimatedCost` is blank and the model is listed
  in `unpriced[]`, so a wrong rate is never presented as a number.
- **Reported and estimated both present** — both shown, never summed; reported wins any single total.
- **Malformed or future-version row** — rejected by name in `rejected[]`, acked anyway (a row the
  server will never accept must not wedge the queue), and logged locally.
- **`enabled = false`** — nothing is recorded; `#usage` says recording is off rather than showing zeros.
- **`publish = false`** — rows are recorded locally and `#usage` works; only the network step is off.

## Open Questions

Each has a recommendation; approving this spec accepts them as written.

1. **Where is cost computed — Krypton or Xenon?** *Recommend Xenon, at read time.* Provider prices
   change on the provider's schedule; a table baked into a desktop app is stale until the next release,
   and every already-sent row would keep its wrong number. Server-side read-time pricing re-prices all
   history the moment the table is edited — which also rules out Langfuse's ingest-time pricing, since
   that freezes the number at insert. Cost: `#usage` in the composer can only show *reported* cost,
   never an estimate. Proposed as ADR-0018.
2. **Ingest shape — a `usage_turn` table, or a spec-212 resource?** **Settled 2026-08-09 by user
   direction — a table, streamed per turn.** The resource envelope seals whole snapshots, so appending
   one turn means re-uploading the day; and a once-a-day push leaves the ledger up to 24 hours stale.
   A table also makes "spend by hour", "by lane", and per-turn drilldown ordinary SQL instead of JSON
   parsing. Accepted cost: a schema migration, a second ingest surface in Xenon, and usage rows do not
   get resource permalinks or revision history. Proposed as ADR-0019.
3. **Manual `#push`?** **Settled 2026-08-09 by user direction — none.** Streaming is the only path;
   `#usage flush` exists solely to skip a backoff wait. ADR-0016 makes *resource* publishing explicit
   because a bundle can contain source, paths, and secrets; a usage row is content-free by construction,
   which is the same reasoning that already lets attention flags publish on their own. Accepted cost:
   usage leaves the machine without a per-row human decision, so the row shape itself — counts and
   identifiers, no free text — is the safeguard.

## Out of Scope

Per-tool, per-message, or per-request attribution · local tokenization for adapters that report nothing ·
budgets, alerts, or quota enforcement · charts (tables only in v1) · live push from Xenon to a browser
(SSE/WebSocket) · pulling usage back into Krypton · merging this with the subscription meters of specs
153/187/193 · exporting to OpenTelemetry or an external observability backend · pricing tiers
(long-context surcharges) beyond one flat rate set per model · editing or deleting accepted rows ·
server-side retention/GC of `usage_turn` · any capture of prompt or response content.

## Resources

- [Token & Cost Tracking — Langfuse](https://langfuse.com/docs/observability/features/token-and-cost-tracking) — per-event ingestion with client-supplied ids, and cost computed when usage plus a matching model definition exist; ingested cost beats computed cost.
- [Models & Pricing — langfuse/langfuse (DeepWiki)](https://deepwiki.com/langfuse/langfuse/9.6-models-and-pricing) — regex `match_pattern` model matching and custom-definition precedence, copied by `price.rs`.
- [litellm/model_prices_and_context_window.json](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) — the shape of the seeded rate table, including separate cached-token rates.
- [Semantic Conventions for GenAI — OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) — `gen_ai.usage.input_tokens` / `output_tokens` naming and the input/output split adopted for `TurnTokens`.
- [Inside the LLM Call: GenAI Observability with OpenTelemetry](https://opentelemetry.io/blog/2026/genai-observability/) — why per-request spans need a collector, which ruled OTLP out as the transport.
- [ccusage — Claude Code usage analysis](https://dev.to/stevengonsalvez/ccusage-finally-know-how-much-claude-code-is-actually-costing-you-1873) — per-project grouping and separate cache-token columns.
- [Manage costs effectively — Claude Code Docs](https://code.claude.com/docs/en/costs) — `/cost` per-session totals as the accepted floor this spec goes finer than.
- In-tree/local: `@agentclientprotocol/sdk` `zod.gen.d.ts:5639` (`Usage` = "for a prompt turn", UNSTABLE) ·
  `@agentclientprotocol/codex-acp` `dist/index.js:21938,28870` (`lastTokenUsage` → `toPromptUsage`) ·
  `src/acp/client.ts:188-201` · `src/acp/acp-harness-view.ts:6898,7375` · `src-tauri/src/xenon.rs` ·
  `~/Source/xenon/src/db.rs` (schema versions + `event` table) · `docs/212-xenon-resource-server.md` ·
  `docs/109-acp-contextual-lane-peek.md` (missing-usage degradation rule).
