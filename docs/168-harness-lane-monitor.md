# Harness Lane Monitor (Live Web Dashboard) — Implementation Spec

> Status: Implemented (rev 4 — attention flag details in dashboard)
> Date: 2026-06-19
> Milestone: ACP Harness — observability
> Extended by: `docs/169-dashboard-resource-status.md` — adds per-lane CPU sparkline + memory bar; repurposes the activity-pulse canvas into a real CPU chart and adds a metrics-driven publish that fires only while a lane is active.

## Final architecture (rev 3 — supersedes the artifact/token transport below)

The dashboard is a **fixed page served by the built-in loopback HTTP server**, opened in an external browser at a **stable, bookmarkable URL** — NOT a per-lane artifact and NOT an in-app view:

- `GET /dashboard` — serves a standalone HTML page (`src/acp/artifact-dashboard.html`, embedded via `include_str!`). No token, no auth, loopback-only.
- `GET /telemetry` — token-free JSON `{ harnesses: [ <snapshot>, ... ] }` (all cached harness snapshots via `all_telemetry_snapshots()`). The page polls this relative URL ~1 s.
- **Stable URL:** `HooksConfig.port` defaults to **8765** (`config.rs`), so the dashboard lives at `http://127.0.0.1:8765/dashboard`. `start()` binds the configured port and falls back to an ephemeral port on conflict (never hard-fails the server); the actual bound port is emitted so the command always builds a working URL.
- **Open commands** — an **app-level command**: command palette `Open Lane Monitor Dashboard` + keybinding **`Leader Shift+L`** → `compositor.openDashboard()` (opens from anywhere, like the Usage view's `Leader $`); plus the harness **`#dashboard`** composer command. Both build the URL from `get_hook_server_port` + `open_url` (independent of the memory session).
- **Kept** from the original design: the `HarnessTelemetryPublisher` (`src/acp/harness-telemetry.ts`) → `acp_publish_telemetry` → per-harness Rust cache pipeline. **Dropped:** the token-gated `/artifact/telemetry/:token` route, `viewerLane`, and the artifact-packaging/open-via-card flow.

The sections below are the original artifact/token design, retained as history.

## Problem

The harness exposes lane activity only through small in-app surfaces (footer gauges, the spec-156 activity ticker, summon-on-demand overlays). There is no single, glanceable, *live* view that shows every lane's status, attention queue, review depth, peer traffic, and turn throughput at once. The user wants a creative, browser-opened **dashboard** that monitors harness lane activity in real time.

## Solution

Ship a **live HTML artifact dashboard** that reuses the existing artifact + loopback-HTTP infrastructure (spec 133/149) plus one new read-only telemetry channel. The TypeScript `AcpHarnessView` already owns every signal (LaneBus, the triage/review stores, lane list); a new `HarnessTelemetryPublisher` folds those into a small harness-wide snapshot and pushes it to the Rust loopback server on change. The server caches the snapshot per-harness and serves it from a new `GET /artifact/telemetry/:token` route. The dashboard artifact (attention gauge + per-lane cards with an activity pulse + a live event stream) polls that route ~1 s and renders **real** data — replacing the simulated telemetry in the proof-of-concept.

Chosen because an external-browser artifact can reach Krypton *only* through the loopback server, so a dedicated read-only endpoint is the minimum viable transport. Polling (not SSE) matches the existing `/artifact/state` live-reload poll and avoids per-connection channel lifecycle.

## Research

- **All telemetry lives in the TS frontend.** `LaneBus` emits `lane:status | lane:spawned | lane:closed | triage:changed | review:quality | review:priority` (`src/acp/types.ts:538`). `AcpHarnessView` owns `triageStore` (`openCount()`, `allStats()`), `reviewQualityStore` (`totalReviews()`, `historyFor()`), `reviewPriorityStore` (`highCount()`, `highCountFor()`), `coordinator` (`listLanes()` → `LaneSummary` with `inboxDepth`, `status`, `displayName`, `backendId`, `modelName`), and `lanes[]` (`activeTurnStartedAt`). `HarnessDirectory.peersFor(harnessId)` gives foreign lanes.
- **Per-lane turns** are not tracked directly, but `triageStore.statsFor(laneId)` exposes `flaggedCount + silentTurnCount` — a faithful turn proxy with no new instrumentation. **Token throughput is not aggregated** (`UsageInfo` flows per ACP event but is never summed) → out of scope; the EKG renders a status-derived *activity* heartbeat, not literal token rate.
- **The loopback server** (`src-tauri/src/hook_server.rs`, axum) already serves `/artifact/:token`, `/artifact/state/:token` (poll), `/artifact/feedback/:token` (POST). Tokens are 128-bit, keyed `token → {harness_id, lane_label, artifact_id, revoked}` (`feedback_tokens` map); `lookup_feedback_token()` returns `Unknown` (404) / `Revoked` (410) / `Found`. Adding a route is a one-line router change + handler; the `acp_bus_reply` Tauri command (`src-tauri/src/commands.rs:246`) shows the `State<Arc<HookServer>>` → method-call pattern for TS→Rust pushes.
- **Why not bake data into the HTML + live-reload?** The `/artifact/state` hash-poll triggers a full page reload, which kills the canvas animation every tick. A separate JSON poll (no reload) is required.
- **Alternative — native in-app view (no browser, no Rust).** A Krypton DOM view (like the Vault/Agent views) could read the buses directly. Rejected for *this* spec because the user explicitly asked for "web" and approved a browser artifact; see Open Questions / attention flag.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| tmux | `tmux ls` / status-line; no live dashboard | text only, no per-pane telemetry |
| Zellij | status bar + `session-manager` plugin | in-TUI, not browser |
| k9s | live TUI dashboard polling kube API ~2s | poll cadence + per-row status mirrors this design |
| Datadog/Grafana | browser dashboards over a metrics endpoint | the canonical "poll a JSON endpoint, render live" pattern adopted here |
| Krypton spec 156 | in-app lane activity ticker | the in-window equivalent; this is the at-a-glance, full-screen web counterpart |

**Krypton delta** — Unlike the in-app ticker/overlays, this is a standalone browser surface (keyboard navigation is the *browser's*, not Krypton's mode system, so it stays outside the keyboard-first constraint by design). It deliberately reuses the artifact token model (no new auth) and the poll transport (no new streaming stack). It is **read-only** observation, consistent with the review-quality/priority "observation not score" principle (ADR-0004/0009): raw counts, never grades.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Add `telemetry: Mutex<HashMap<String, TelemetrySnapshot>>` field; `store_telemetry()` + `take_telemetry()` methods; `handle_artifact_telemetry(token)` handler; `GET /artifact/telemetry/{token}` route; clear harness entry in `dispose_harness_artifacts()` |
| `src-tauri/src/commands.rs` | New `acp_publish_telemetry(harness_id, version, snapshot, hook_server)` command (mirrors `acp_bus_reply`) |
| `src-tauri/src/lib.rs` | Register `commands::acp_publish_telemetry` in `invoke_handler!` |
| `src/acp/harness-telemetry.ts` | **New.** `HarnessTelemetryPublisher` + snapshot types + builder + per-lane diff→event ring |
| `src/acp/acp-harness-view.ts` | Instantiate publisher in `start()`, dispose in `dispose()`, subscribe it to `laneBus` + stores |
| `src/acp/artifact-dashboard.html` | **New (reference template).** The live dashboard the lane copies into an artifact; polls the telemetry endpoint |
| `docs/PROGRESS.md`, `CLAUDE.md` | Document the monitor + new endpoint |

## Design

### Data Structures (TS, serialized to JSON)

```ts
// Serialized status is EXACTLY HarnessLaneStatus (src/acp/types.ts:238) — no invented
// vocabulary (the PoC's "working" was a tell). The dashboard maps it through a TOTAL
// lookup with an `unknown` fallback, so a future status renders as a neutral chip,
// never a blank or mis-coloured node. [Codex B1]
type LaneStatus = 'starting'|'idle'|'busy'|'needs_permission'|'awaiting_peer'|'error'|'stopped';

interface TelemetryLane {
  id: string; displayName: string; backendId: string; modelName: string | null;
  status: LaneStatus; turnActiveSince: number | null;  // activeTurnStartedAt; client derives elapsed
  observedTurns: number; // flaggedCount + silentTurnCount — attention-audit proxy, labelled
                         // "observed turns", NOT throughput (no completed-turn counter exists)
  inboxDepth: number;    // queued peer envelopes
  attnOpen: number; reviews: number; highPriority: number;  // per-lane store reads (shown once, on chips)
}
// kind is a closed enum; the dashboard templates the human-readable text client-side from
// the structured fields — keeps the feed a clean status strip, not an open log console. [Codex W/S3]
type EventKind = 'status'|'attention'|'review'|'priority'|'peer'|'lane';
interface TelemetryEvent { at: number; laneName: string; kind: EventKind; detail?: string }

interface TelemetrySnapshot {
  schemaVersion: number;  // contract version — old dashboards fail gracefully on a bump [Codex S5]
  version: number;        // monotonic freshness counter (staleness guard)
  harnessId: string; projectDir: string | null; generatedAt: number;
  attention: {
    openCount: number;
    maxReversibility: 'reversible'|'costly'|'irreversible'|null;
    items: {
      id: string; laneId: string; laneName: string; createdAt: number;
      question: string; chosen: string; rationale: string;
      tradedOff: string[]; uncertainty: string;
      reversibility: 'reversible'|'costly'|'irreversible';
    }[];
  };
  reviewTotal: number; highPriorityTotal: number;
  lanes: TelemetryLane[];
  foreignPeers: { displayName: string; backendId: string; status: string; cwd: string | null }[];
  recentEvents: TelemetryEvent[];  // ring buffer, last 14 (visual cap)
}
```

> `backendId`/`modelName` are KEPT (against Codex S2): they are the agent vendor + model
> (`claude`/`codex`/`opus`), already surfaced everywhere in the harness (peer_list, lane
> chrome) and not identity-sensitive — they earn a place as the per-lane "which agent" tag.
> Rendered lowercase, as-is (never uppercased). `foreignPeers` is retained but renders as a
> plain secondary list ONLY, so the UI never implies cross-harness telemetry the snapshot
> does not carry. [Codex W]

### API / Commands

- **Tauri command** `acp_publish_telemetry(harnessId: string, version: number, snapshot: TelemetrySnapshot) -> Result<(), String>` → `hook_server.store_telemetry(harness_id, version, json)` (last-writer-wins; ignores stale `version`).
- **HTTP** `GET /artifact/telemetry/{token}` →
  - `404` unknown token, `410` revoked token, both via existing `lookup_feedback_token`.
  - `200 { "snapshot": <TelemetrySnapshot|null>, "viewerLane": "<lane_label>", "version": <n> }` — `snapshot:null` before the first publish (dashboard shows "connecting…"). `viewerLane` lets the dashboard highlight the artifact's owning lane.
  - `Cache-Control: no-store` (same as state poll).

### Data Flow

```
1. Lane status/attention/review/peer changes → LaneBus.emit(...)
2. HarnessTelemetryPublisher (subscribed) schedules a rebuild (debounced 300ms) ONLY on a
   real source change — NO periodic tick. The browser derives elapsed turn time locally from
   turnActiveSince + generatedAt and animates the activity pulse client-side. [Codex S4]
3. rebuild(): read lanes[] + coordinator.listLanes() + the three stores + directory.peersFor();
   diff per-lane fields vs the previous snapshot → append TelemetryEvent rows to the ring;
   bump version; invoke('acp_publish_telemetry', { harnessId, version, snapshot }).
4. Rust store_telemetry() caches it under harness_id (drops if version < cached).
5. Dashboard artifact polls GET /artifact/telemetry/{token} every ~1s.
6. Browser diffs version → updates DOM (lane cards, gauge value, event feed);
   canvas (gauge arc + per-lane activity pulse on active lanes) animates off the latest snapshot.
```

### UI Changes

The dashboard (Binance-dark scaffold + cyberpunk layer; **flat chrome** — no card-in-card nesting, no left-border rails). Revised for the <2 s "who needs me?" grok after review:

- **Primary glance zone** — the **attention triage** half-gauge + the **active-lane cards** are the focal answer. The gauge column now includes the open `attention_flag` details (lane, reversibility, question, rationale, chosen path, uncertainty, trade-offs) so the browser dashboard can answer *what needs judgement*, not only *how many*. Each lane card: a status pill + attn/rev/pri/peer chips (owning lane ringed), plus an **activity pulse** canvas rendered ONLY for active lanes (`busy`/`needs_permission`/`awaiting_peer`); idle/stopped lanes show a flat muted line (cuts ~3–4 always-on animators). [Cursor B3/S4]
- **History** — the **event stream** (≤14 rows) fed by `recentEvents`, text templated client-side from each `kind`; peer traffic is read here (and on the per-lane `peer` chip) rather than as a separate visual. [radar removed — human decision]

**Each metric is surfaced exactly once** [Cursor B2]: rev/pri/peer live on the lane chips only (the duplicate "signals" bars are removed); attention lives in the gauge (+ per-lane chip). Top bar = one derived triage line (e.g. `2 busy · 1 awaiting · 3 flags`) + uptime — **no `tok/s`** (out of scope; false signal). [Cursor B1, Codex W6]

**Casing** [Cursor B4]: sentence-case section headers (`Active lanes`, `Attention triage`); `displayName`/`backendId`/`modelName`/`status` rendered as-is (`Claude-4`, `claude`, `opus`, `awaiting peer`) — never uppercased. One persistent footer line replaces the banner essay: `read-only observation · polls /artifact/telemetry · pulse = lane activity, not token rate`. [Cursor W4/S5]

### Configuration

None. The endpoint inherits the existing loopback port and token model.

## Edge Cases

- **No dashboard open / idle harness:** publisher pushes only on real source changes — no periodic timer, near-zero idle CPU (meets idle <1%).
- **Token invalid — one documented rule** [Codex B2]: an explicit lane revoke (`#new`/close) keeps the token row but marks it revoked → **410**; a harness dispose sweeps the token entirely (matching today's `dispose_harness_artifacts()`, which *removes* rather than revokes) → **404**, and also clears the telemetry cache entry. The dashboard treats **404, 410, and snapshot-loss identically** ("no longer live"), so the exact code never affects UX — documented here only so the spec is honest about which code occurs when.
- **First poll before first publish:** `snapshot:null` → "connecting…" state; `schemaVersion` still present so the client can gate.
- **schemaVersion mismatch:** dashboard shows a "refresh the artifact" notice instead of mis-rendering an old contract.
- **Cross-view tokens:** snapshot is harness-scoped; a token from any lane in the harness sees the whole harness (token authorizes, does not partition). Foreign harnesses appear only as minimal `foreignPeers`.
- **Stale/out-of-order publish:** version guard in `store_telemetry`.
- **Large lane count:** snapshot is O(lanes); event ring capped at 24; payload stays small.

## Review Round 1 (Polly: Cursor-2 UI + Codex-4 data) — disposition

| Finding | Source | Disposition |
|---|---|---|
| Drop `tok/s` (out-of-scope false signal) | both | **Accepted** — removed from top bar |
| Same metric rendered 2–3× (gauge+bars+chips) | Cursor B2 | **Accepted** — rev/pri/peer on chips only; "signals" bars removed |
| Always-on motion budget (sweep/flare/5 EKGs/beacon) | Cursor B3 | **Accepted** — pulse only on active lanes; radar removed entirely |
| Uppercased identity/status strings | Cursor B4 | **Accepted** — casing pass; render as-is |
| `status` enum must match `HarnessLaneStatus` + total mapper | Codex B1 | **Accepted** — exact enum + `unknown` fallback |
| Revoke 410 vs dispose 404 inconsistency | Codex B2 | **Accepted** — one documented rule; client treats both as "not live" |
| Rename `turns`→`observedTurns`, EKG→activity pulse | both | **Accepted** |
| `TelemetryEvent.kind` open-ended → enum, cap rows | Codex W/S3 | **Accepted** — closed enum, ≤14 rows, client-templated text |
| Add `schemaVersion` distinct from `version` | Codex S5 | **Accepted** |
| Drop `backendId`/`projectDir` (leak/clutter) | Codex S2 | **Declined** — kept (vendor/model are non-sensitive, already shown, earn the tag) |
| Cut the radar entirely (gimmick risk) | Cursor W1 | **Accepted (human decision)** — radar removed; dashboard is gauge + lane cards + event stream |

## Open Questions

None. (Radar keep-vs-cut was flagged and **resolved by the human: remove it** — the dashboard is the attention gauge + lane cards + event stream.)

## Out of Scope

- True token/throughput metering (no aggregated source today).
- SSE/WebSocket push (poll is sufficient; revisit if cadence proves too coarse).
- Full cross-harness "mission control" telemetry (only minimal foreign-peer listing).
- Transcript/prompt text in the snapshot (status + derived activity only; avoids leaking turn content to the browser).
- Mutating controls from the dashboard (read-only by design).

## Resources

- `src-tauri/src/hook_server.rs` — axum router, `lookup_feedback_token`, artifact/state/feedback handlers (transport prior art).
- `src-tauri/src/commands.rs:246` `acp_bus_reply` — TS→Rust `State<Arc<HookServer>>` push pattern.
- `src/acp/types.ts:238,414,478,538` — `HarnessLaneStatus`, `LaneSummary`, attention/judgement types, `LaneBusEvent`.
- `src/view-bus-types.ts` — `SignalValueMap` (`system:attention`, `review:quality`, `review:priority`).
- `docs/149-artifact-inline-feedback.md`, `docs/156-lane-activity-ticker.md` — artifact channel + in-app ticker prior art.
- axum SSE/`Sse` docs — surveyed and deferred (poll chosen).
</content>
</invoke>
