# Dashboard Resource Status — Implementation Spec

> Status: Approved (rev 2 — chart / option A-hybrid)
> Date: 2026-06-20
> Milestone: ACP Harness — observability

## Problem

The live web lane monitor (`#dashboard`, spec 168) shows status, attention, review, priority, and peer depth per lane — but **not how much each lane is actually consuming**. Krypton already samples per-lane CPU%/RSS (spec 91) and shows it in-app (lane chips + the "Lane Resource Usage" overlay), yet that signal never reaches the browser dashboard. The user wants resource status on `#dashboard`, rendered as a **live chart** (CPU sparkline + memory bar), not a static number.

## Solution

Surface per-lane CPU%/RSS on the dashboard as a **live CPU sparkline + memory bar**, reusing the metrics Krypton already samples (spec 91) and the telemetry pipeline already built (spec 168). Because a chart is only honest if its numbers actually move, the snapshot must refresh at the metrics cadence — so the existing 2 s `pollMetrics()` also nudges the `HarnessTelemetryPublisher` to publish, **but only while ≥1 lane is active** (busy / needs_permission / awaiting_peer). An idle harness makes **zero** periodic pushes, preserving spec 168's idle-CPU < 1% guarantee (this is "option A-hybrid": periodic-while-active, silent-while-idle). The snapshot carries only the **current** CPU/RSS sample (a point, not a series); the **time-series history lives client-side** in the dashboard, accumulated from successive polls into the existing per-lane canvas. The Rust loopback server stores the snapshot as an opaque `serde_json::Value`, so the new fields pass through untouched — **no Rust changes**.

> **Decision (human, this session):** chart over chips. Option B (fold metrics only on LaneBus events, no periodic publish) was specced first and rejected because the resulting chart would freeze to a flat line between events — a graph that looks live but isn't. Recorded here so the rejected branch isn't re-litigated.

## Research

- **Metrics already exist and are already polled.** `process_metrics.rs::MetricsSampler` (spec 91) walks each lane's process tree → `TreeMetrics { total_cpu_percent, total_rss_mb, proc_count, processes[], root_alive }` via command `acp_get_lane_metrics`. `AcpHarnessView.pollMetrics()` runs every `METRICS_POLL_MS = 2000` into `metricsBySession: Map<number, AcpLaneMetrics>` (keyed by the **ACP client numeric session**, `lane.client?.sessionId`), driving in-app chips + the metrics overlay (`acp-harness-view.ts:8048`). The sampling cost is therefore already paid; this spec only adds shipping it.
- **Telemetry transport is value-opaque on the Rust side.** `acp_publish_telemetry(harnessId, version, snapshot: serde_json::Value)` → `hook_server.store_telemetry()` caches the raw `Value`; `/telemetry` returns `{ harnesses: all_telemetry_snapshots() }`. Adding TS fields to the snapshot requires **no Rust struct change** (`commands.rs:267`, `hook_server.rs:581`) — confirmed in review (Codex-2).
- **The publisher rebuilds on `schedule()` (300 ms debounce).** Today only LaneBus events call it (no periodic timer). Option A-hybrid adds **one** extra caller: `pollMetrics()` calls `telemetryPublisher?.schedule()` after refreshing `metricsBySession`, **gated on `anyLaneActive()`**. Spaced 2 s apart, each nudge collapses to one publish → ~2 s cadence while active, none while idle.
- **History stays client-side.** The dashboard already polls `/telemetry` ~1 s and keeps per-lane `runtimes[key]` (a ring buffer + a `pulse` canvas, currently a *synthetic* activity heartbeat). We repurpose that canvas into a **real CPU sparkline**: each poll pushes the latest `cpuPercent` into the ring. The snapshot stays O(lanes) — no series in the payload (addresses the "no history in snapshot" concern while still giving a chart).
- **Key mapping wrinkle (Codex-2):** the accessor must map `lane.id → lane.client?.sessionId → metricsBySession`. `lane.sessionId` is the ACP *logical* session **string** and will not key the numeric `Map<number, …>`. The accessor lives in `AcpHarnessView` (owns both) so the publisher never sees the dual key.
- **Schema constant must move in lockstep (Codex-2):** `artifact-dashboard.html` filters snapshots on an **exact** `SCHEMA_VERSION` match. Bumping `TELEMETRY_SCHEMA_VERSION` 1→2 without bumping the page constant in the same patch makes the page drop every new snapshot as a mismatch. Both change together.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| k9s | live TUI dashboard with per-pod CPU/MEM columns polled ~2 s | per-row resource columns + poll cadence mirror this design |
| Datadog/Grafana | browser dashboards plotting CPU/mem off a metrics endpoint | the "poll JSON, render a moving chart" model adopted here |
| htop / btop | per-process CPU%/RSS tree + per-core history meters | the meter/sparkline idiom; Krypton shows the per-lane aggregate, not per-process, in the browser |
| Krypton spec 91 | in-app lane CPU/RSS chips + process-tree overlay | this spec reuses the exact same numbers, surfaced live in the web view |
| Krypton spec 168 | dashboard activity *pulse* (synthetic heartbeat on active lanes) | the canvas slot we repurpose into a **real** CPU sparkline |

**Krypton delta** — Unlike k9s/Grafana, no new scrape loop: piggybacks on metrics already sampled for the in-app view, and ships them only while a lane is active (idle = zero pushes). The chart's history is accumulated by the browser, not stored server-side. Per-lane aggregate only (the per-process tree stays in the in-app overlay), read-only — consistent with spec 168's "observation, raw numbers, no grades" stance.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-telemetry.ts` | Add `cpuPercent`/`rssMb`/`procCount`/`rootAlive` to `TelemetryLane`; add `metricsFor(laneId)` to options; populate in `buildLanes()`; bump `TELEMETRY_SCHEMA_VERSION` 1→2. No metrics diff→event ring entries (CPU churns every sample; would flood the feed). |
| `src/acp/acp-harness-view.ts` | Pass `metricsFor: (laneId) => …` into the publisher options (map `lane.id → lane.client?.sessionId → metricsBySession`); in `pollMetrics()`, after refreshing metrics, call `this.telemetryPublisher?.schedule()` **iff `anyLaneActive()`**; add the small `anyLaneActive()` helper. |
| `src/acp/artifact-dashboard.html` | Bump `SCHEMA_VERSION` 1→2 (lockstep). Repurpose the per-lane `pulse` canvas into a **CPU sparkline** fed from a client-side ring buffer of `cpuPercent`; add a **memory bar** + `cpu`/`mem` value labels. `rootAlive:false` → flat baseline + "—". Colour by heat (green/yellow/red). |
| `docs/PROGRESS.md`, `docs/168-harness-lane-monitor.md`, `CLAUDE.md` | Document the resource sparkline + the active-gated periodic publish (the one deliberate change to spec 168's "no periodic tick" rule) + the schema bump. |

> The working-tree `src/styles/acp-harness.css` change (permission-options readability) is **unrelated** to this feature (it styles the in-app permission card) and will be committed separately — not part of this spec (OpenCode-2).

## Design

### Data Structures (TS)

```ts
interface TelemetryLane {
  // …existing fields…
  cpuPercent: number | null;  // total_cpu_percent (summed over the process tree; can exceed 100 on multi-core)
  rssMb: number | null;       // total_rss_mb
  procCount: number;          // proc_count (0 when no live process)
  rootAlive: boolean;         // false → render "—" + flat baseline, never "0%"
}

// publisher options gain:
metricsFor(laneId: string): { cpuPercent: number; rssMb: number; procCount: number; rootAlive: boolean } | null;
// returns null when the lane has no client session yet → snapshot fields null
```

The **series** is not in the snapshot. The dashboard keeps, per lane, a ring buffer (`runtimes[key].buf`, ~60 samples) it pushes `cpuPercent` into on each poll.

### Data Flow

```
1. AcpHarnessView.pollMetrics() (every 2s, spec 91) refreshes metricsBySession (in-app view) — as today.
2. NEW: if anyLaneActive() → this.telemetryPublisher?.schedule().  (idle harness → skipped → no periodic push)
3. schedule() (300ms debounce) → buildLanes() calls metricsFor(laneId) and writes
   cpuPercent/rssMb/procCount/rootAlive into each TelemetryLane (latest sample, "as of" generatedAt).
4. invoke('acp_publish_telemetry', …) → Rust caches the opaque Value → /telemetry.   (no Rust change)
5. Dashboard poll (~1s): on each snapshot, push lane.cpuPercent into the per-lane ring buffer.
6. Repurposed pulse canvas draws the CPU sparkline (area + line, heat-coloured); mem bar + value labels update.
   Active lanes animate; idle/stopped lanes show the last series flat + muted.
```

### UI Changes

> **Follow-up (post-merge, this session):** the spec-168 **synthetic activity heartbeat was restored as a *separate* canvas** rather than overwritten. The user wanted the at-a-glance "is this lane alive / what's it doing" rhythm back *and* the real CPU chart. The card now has two stacked visuals: a thin `.beat` (22px, status-coloured heartbeat via `drawBeat`/`beatBuf`, synthetic — not data) above the `.pulse` (40px, real CPU sparkline via `drawCpuSpark`/`buf`). The heartbeat answers "active?", the sparkline answers "how loaded?". They use independent client-side buffers.

- Per active lane card: the `pulse` canvas is a **CPU sparkline** (last ~60 samples, area fill + line, 100% reference line, head dot). Colour: `cpu ≥ 90` red, `≥ 50` yellow, else green (dashboard palette).
- A **memory bar** (thin horizontal fill, full-scale ~2 GB) + `cpu N%` / `mem N MB|GB` value labels.
- `rootAlive:false` (or null metrics) → "no live process · cpu — · mem —", flat baseline, no fake motion.
- Flat chrome only — no new card, no nested container, no per-process tree in the browser (stays in the in-app overlay).

### Configuration

None.

## Edge Cases

- **All lanes idle/stopped** → `anyLaneActive()` false → no periodic publish → chart holds the last series (lanes are idle; nothing to show). The final busy→idle status event still fires one last publish capturing the wind-down.
- **No live process / dead root** (`rootAlive:false`) → "—" + flat baseline, never a misleading `0%`.
- **Lane with no client session yet** → `metricsFor` returns `null` → "—".
- **CPU > 100%** (multi-core tree sum) → shown as-is; the sparkline auto-scales (`peak = max(100, observed) × 1.1`).
- **Cold start of the ring** → buffer pre-filled with the first sample so the line doesn't sweep in from zero.
- **schemaVersion 1 page vs 2 snapshot (or vice-versa)** → page and snapshot are co-deployed (`include_str!`), so this is only transient; the exact-match filter then hides stale snapshots until reload — acceptable.

## Open Questions

None. (Chips-vs-chart resolved by the human: chart. Periodic-publish-while-active accepted as the one deliberate deviation from spec 168's "no periodic tick", scoped to active lanes only.)

## Out of Scope

- Per-process tree in the browser (stays in the in-app overlay).
- Server-side metric history / time-series in the snapshot (history is client-accumulated).
- Memory sparkline (mem is a bar; only CPU gets the line — revisit if requested).
- Token/throughput metering (still no aggregated source; spec 168 Out of Scope).
- The unrelated `acp-harness.css` permission-options restyle (separate commit).

## Resources

- `docs/91-acp-lane-resource-metrics.md` — the existing per-lane CPU/RSS sampler this reuses.
- `docs/168-harness-lane-monitor.md` — the dashboard/telemetry pipeline + the `pulse` canvas being repurposed.
- `src-tauri/src/process_metrics.rs`, `src-tauri/src/commands.rs:263`, `src-tauri/src/hook_server.rs:581` — metrics sampler + value-opaque telemetry transport (confirmed needs no change).
- `src/acp/acp-harness-view.ts:8048` (`startMetricsTick`/`pollMetrics`/`metricsBySession`), `src/acp/harness-telemetry.ts`, `src/acp/artifact-dashboard.html` (`SCHEMA_VERSION`, `runtimes`, `pulse`) — touch points.
- Review round 1 (Codex-2 architecture+correctness, OpenCode-2 requirements-fit): drove the option-B→chart pivot, the schema-constant lockstep catch, the `lane.id→client.sessionId` mapping, and the CSS-split-out.
</content>
