# TypeSafe API Call Metrics — Implementation Spec

> Status: Implemented
> Date: 2026-09-20
> Milestone: M8 — Observability

## Problem

Krypton can call TypeSafe from the Rust backend, but the UI does not show how many outbound API
requests it has made. The existing in-memory counters record completed semantic outcomes, so one
logical operation with a retry is currently counted once even though TypeSafe received two HTTP
requests.

## Solution

Count every outbound `POST /v1/systemone` attempt at the shared Rust transport boundary, including
retries, and emit a read-only aggregate snapshot whenever the counters change. Show `⚡ TS N` in the
Workspace Footer immediately before Xenon for real-time visibility, with the existing Profiler HUD
providing the full requests/operations/retries/outcomes/latency matrix. Metrics remain aggregate and
in memory: both surfaces report activity since launch, while restarting Krypton resets the values.

## Research

- TypeSafe has one evaluation endpoint, `POST /v1/systemone`; one request may carry several typed
  questions. The metric therefore counts HTTP attempts, not questions or returned answers.
- TypeSafe rate limits include requests per minute, so exact attempt count matters. A retry is a new
  request for rate-limit purposes and must increase both `apiRequests` and `retries`.
- TypeSafe charges Jev by input token rather than by request. This feature is an operational counter,
  not a billing estimate; cost and persisted account history stay out of scope.
- Krypton's `TypeSafeState` already owns one shared client plus in-memory `suggestions`, `fallbacks`,
  and total latency. Extending this state avoids duplicate frontend inference and automatically
  covers future TypeSafe callers that reuse the shared transport.
- `record_metrics()` currently runs once after a logical result and cannot count retries. The new
  attempt counters must update inside `call_with_retries()` immediately before each `call_once()`.
- The Workspace Footer's global right cluster already carries machine-wide Xenon, review-priority,
  and attention signals. TypeSafe belongs there rather than in ACP Lane Metrics, which describes
  CPU/RSS for one adapter process tree and would imply unsupported per-lane attribution.
- The footer can update from a Tauri event on counter changes, so real-time visibility adds no idle
  polling. The Profiler requests one current snapshot when opened, then consumes the same events.

Alternatives considered:

- **Count frontend `timeline_topic_suggest` invocations** — rejected because disabled, missing-key,
  cooldown, cancellation, and retry paths make frontend command count differ from outbound calls.
- **Profiler only** — rejected after visual review because the request count should remain visible
  while working. The footer segment stays hidden when TypeSafe is disabled or the count is zero.
- **Persist daily/monthly totals** — rejected for this narrow feature. Provider/account history has
  different retention, reconciliation, and reset semantics and should be designed separately.

## Prior Art

| Product | Implementation | Krypton lesson |
|---------|----------------|----------------|
| OpenAI Usage Dashboard | Historical activity is filtered by organization/project and reporting period; individual responses also carry token usage | Label local scope explicitly; do not imply billing reconciliation |
| Helicone | Observability dashboard exposes organization-level total requests and detailed request logs | Lead with an unambiguous total request count |
| LangSmith | Monitoring dashboards show trace count, errors, latency, and token usage | Keep logical operations distinct from raw HTTP attempts |
| VS Code Process Explorer | On-demand diagnostic surface rather than permanent editor chrome | Reuse Krypton's summonable Profiler HUD |
| iTerm2 / WezTerm / Kitty | No built-in app-specific AI-provider request counter | This is Krypton integration telemetry, not a terminal convention |

**Krypton delta** — match observability tools by leading with total requests and scope, but remain
local-first: no proxy, external telemetry service, request log, prompt content, or credential leaves
the existing TypeSafe integration.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/typesafe.rs` | Count outbound attempts/retries, expose a serializable snapshot and `typesafe_metrics` command, and add unit coverage |
| `src-tauri/src/lib.rs` | Bind the TypeSafe event emitter and register `typesafe_metrics` |
| `src/typesafe-metrics.ts` | Define the shared frontend contract and pure footer/Profiler formatters |
| `src/typesafe-metrics.test.ts` | Verify zero, active, retry, in-flight, and detail labels |
| `src/main.ts`, `src/view-bus-types.ts` | Bridge TypeSafe Tauri events into the global typed ViewBus |
| `src/workspace-footer.ts` | Render the event-driven `⚡ TS N` global segment before Xenon |
| `src/profiler/profiler-hud.ts` | Read the current snapshot when opened and render the live full matrix |
| `src/styles/workspace-footer.css`, `src/styles/profiler.css` | Style static tabular footer and matrix readouts |
| `docs/47-profiler-panel.md` | Document the TypeSafe section and sampling exception |
| `docs/121-workspace-status-bar.md` | Document the new global right-cluster segment |
| `docs/257-typesafe-timeline-topic-suggestions.md` | Replace the hidden-only metrics note with a cross-reference to visible aggregate telemetry |
| `docs/04-architecture.md` | Record the shared TypeSafe metrics snapshot seam |
| `docs/05-data-flow.md` | Add attempt-count and Profiler read flow |
| `docs/02-functional-requirements.md` | Add the visible operational-count requirement |
| `docs/README.md` | Index this spec |

## Design

### Data Structures

```rust
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypeSafeMetricsSnapshot {
    pub api_requests: u64,       // every started HTTP attempt, including retries
    pub logical_operations: u64, // one eligible semantic operation entering transport
    pub retries: u64,            // attempts whose zero-based index is > 0
    pub suggestions: u64,        // completed visible-suggestion outcomes
    pub fallbacks: u64,          // completed non-suggestion outcomes
    pub average_latency_ms: Option<u64>,
}
```

`TypeSafeMetrics` keeps the raw counters plus `latency_ms_total`. Snapshot derivation computes
`completed = suggestions + fallbacks` and returns no average when completed is zero. All increments
use `saturating_add`; a poisoned metrics lock skips telemetry rather than breaking TypeSafe behavior.

```ts
export interface TypeSafeMetricsSnapshot {
  apiRequests: number;
  logicalOperations: number;
  retries: number;
  suggestions: number;
  fallbacks: number;
  averageLatencyMs: number | null;
}
```

### API / Commands

```rust
#[tauri::command]
pub fn typesafe_metrics(
    typesafe: tauri::State<'_, Arc<TypeSafeState>>,
) -> Result<TypeSafeMetricsSnapshot, String>;
```

This command reads aggregate counters only. It does not read config, resolve the API key, trigger a
network request, reset metrics, or expose request/response bodies.

Every successful counter mutation emits the same snapshot as `typesafe-metrics-changed`. The event
contains aggregate numbers only and is emitted before each HTTP attempt plus after each completed
logical operation.

### Counting Contract

1. When an enabled operation has passed validation, credential, and cooldown checks and enters
   `call_with_retries`, increment `logical_operations` once.
2. Immediately before each `call_once`, increment `api_requests`.
3. For attempt index `1..`, also increment `retries`.
4. Preserve the existing result-level accounting after the operation completes: increment exactly
   one of `suggestions` or `fallbacks` and add its end-to-end latency.
5. Disabled, locally invalid, missing-key, and circuit-open paths make no outbound request and do not
   increment `api_requests` or `logical_operations`.
6. An attempt cancelled or timed out after `.send()` starts still counts as an API request. No metric
   claims that the provider processed or billed it.

The primary invariant after all operations settle is:

```text
api_requests = logical_operations + retries
completed = suggestions + fallbacks
```

`completed` may temporarily trail `logical_operations` while a call is in flight.

### Data Flow

```text
1. Eligible TypeSafe operation enters call_with_retries().
2. Rust records one logical operation.
3. Each outbound attempt records apiRequests; later attempts also record retries.
4. Completion records suggestion/fallback and total end-to-end latency.
5. Rust emits `typesafe-metrics-changed`; `main.ts` publishes it as a global ViewBus signal.
6. WorkspaceFooter updates `⚡ TS N` immediately before the Xenon segment.
7. User opens the Profiler with Cmd+P, then Shift+P; it requests one current snapshot to cover any
   missed pre-listener event and consumes subsequent events for live updates.
8. Rust counters continue collecting until app exit whether either surface is visible or not.
```

### Keybindings

No new keybinding. The existing Profiler HUD path remains `Cmd+P`, then `Shift+P`.

### UI Changes

Add one static global segment before Xenon in the Workspace Footer:

```text
⚡ TS 12   ⇄ xenon   ▤ 2 priority   1 attention
```

Compact mode shows `⚡ TS 12`; detail mode shows `⚡ TS 12 · 10 op · 2 retry`. Its tooltip includes
requests, operations, retries, completed outcomes, average latency, the `this app run` scope, and the
Profiler shortcut. The segment is hidden when `[typesafe].enabled = false` or `apiRequests = 0`.
It is static—no pulse or remount-triggered animation.

The Profiler adds one section below `IPC` and above `PTY`:

```text
TYPESAFE · THIS APP RUN
requests       12    operations     10
retries         2    completed      10
suggestions     4    fallbacks       6
avg latency  412ms
```

Zero is explicit (`requests 0`) in the Profiler rather than `n/a`. While the local metrics command is
unavailable, show `metrics unavailable` and keep the rest of the Profiler working. All changing
values use tabular numerics. Neither surface adds a focus target, mouse interaction, animation,
semantic alarm color, or L-shaped/left-only border treatment.

### Configuration

No new configuration. Existing `[typesafe]` opt-in behavior is unchanged.

## Edge Cases

- **Retry after `429`, `529`, or transient failure** — each actual attempt increments requests; only
  later attempts increment retries.
- **Missing key / disabled / cooldown** — zero new API requests because no transport starts.
- **Cancellation during an attempt** — the started attempt remains counted; the completed outcome
  lands when the operation resolves its fallback.
- **HUD opens during an in-flight call** — operations may exceed completed by one; no fake fallback
  is synthesized.
- **Counter overflow** — saturates at `u64::MAX` rather than wrapping.
- **App restart** — all values reset to zero and the label makes that boundary visible.
- **TypeSafe disabled after earlier calls** — hide the footer segment while preserving the in-memory
  snapshot; re-enabling reveals the same app-run total.
- **Frontend reload / missed event** — the startup/open snapshot command restores the current total.
- **Frontend/backend version skew** — a failed command renders `metrics unavailable` without affecting
  TypeSafe calls or other Profiler sections.

## Validation

- Rust unit tests prove first-attempt, retry, disabled/missing-key, result, snapshot-average, and
  saturating-counter behavior without live network access.
- Frontend tests prove exact matrix labels and values for zero, retry, active/incomplete, and command-
  unavailable states.
- Run `cargo fmt -- --check`, focused Rust tests, `cargo clippy`, `npm test -- --run`,
  `npm run check`, `npm run build`, and `git diff --check`.
- Manual smoke: enable TypeSafe shadow mode, trigger one successful topic operation, open the Profiler,
  and verify `requests 1`; separately force one transient retry and verify `requests 2`, `operations 1`,
  `retries 1` without exposing request content or credentials.

## Open Questions

None. The approved scope is process-lifetime operational telemetry in the Workspace Footer plus the
existing Profiler HUD; persisted/provider-account usage requires a separate design.

## Out of Scope

- Billing, price, spend, quotas, or provider-account reconciliation
- Persistence across app launches, daily charts, exports, or reset controls
- Per-project, per-lane, per-topic, prompt, question, or response logging
- Request/response bodies, criteria, topic text, API keys, headers, or error bodies
- Changing retry, timeout, cooldown, model, or TypeSafe enablement behavior
- TypeSafe-hosted usage APIs or an external telemetry/observability service

## Resources

- [TypeSafe API reference](https://docs.typesafe.ai/api) — one System One endpoint, response shape,
  standard errors, and retry guidance.
- [TypeSafe Models](https://docs.typesafe.ai/models) — request-per-minute limits and input-token pricing.
- [OpenAI: Reviewing API usage and costs](https://help.openai.com/en/articles/10478918) — explicit
  reporting scope and the separation between dashboard history and per-response usage.
- [Helicone: Get Total Requests](https://docs.helicone.ai/rest/pi/post-v1pitotal_requests) — total
  requests as a primary observability metric.
- [LangSmith dashboards](https://docs.langchain.com/langsmith/dashboards) — trace/error/latency/token
  monitoring and the distinction between root traces and nested work.
- Internal: `src-tauri/src/typesafe.rs`, `src/profiler/profiler-hud.ts`, `docs/47-profiler-panel.md`,
  and `docs/257-typesafe-timeline-topic-suggestions.md`.
