# ACP Lane Resource Metrics — Implementation Spec

> Status: Implemented
> Date: 2026-05-07
> Milestone: ACP Harness — observability
> Updated: 2026-11-04 — shared sampling and process-identity contract from spec 357

## Problem

The harness shows lane state (status, mode, MCP, model) but no resource cost.
Users running multiple ACP adapters concurrently (Claude + Codex + Gemini +
OpenCode + Pi + Droid) have no way to tell which lane is hot, leaking memory,
or stuck in a CPU spin without dropping out to `top`/Activity Monitor.

## Solution

Track CPU% and RSS for each ACP adapter subprocess **and its descendants**
(MCP servers and tool subprocesses still parented under the adapter) using
the existing `sysinfo` infrastructure. Surface aggregates in the lane header
and a process-tree breakdown behind contextual Leader `=`.

One app-scoped frontend feed samples all registered local ACP roots every
2000 ms (0.5 Hz), including helpers and probes, not just Harness lanes.
Each cycle performs one shared process refresh; tree walks scale with the
roots and descendants. Remote transports are absent from local resource
samples, not from the separate assistant inventory (spec 357).

## Research

**Existing infrastructure (reuse, do not duplicate):**
- `sysinfo` crate already a dep — used in `pty.rs:619` (PTY foreground proc),
  `pty.rs:711` (`get_process_metrics`), `ssh.rs:251` (SSH detection).
- `pty.rs:642` (`find_deepest_leaf_native`) is the working pattern for
  walking children via `sysinfo::Process::parent()`. We need a *collect-all*
  variant rather than deepest-leaf.
- `ProcessStats` type (`src/types.ts:427` — `cpu_percent`, `rss_mb`) and the
  Java extension's chip rendering pattern (`src/extensions/java.ts:48-52`)
  are the visual precedent.

**ACP child handling (`src-tauri/src/acp.rs`):**
- Each successful local launch captures the child PID and its process start
  identity. A numeric ACP session identifies the transport epoch; the string
  conversation ID may change without another process.
- Process-group setup allows existing teardown to target adapter descendants.
  Resource collection follows actual parent links until children reparent.
- `AcpRegistry::snapshot_pids` reads registered local process identities under
  a short registry lock. OS sampling happens after that lock is released.

**sysinfo cost / accuracy notes:**
- `cpu_usage()` returns 0 on the first refresh. The Java path
  (`pty.rs:715-720`) does two refreshes 200 ms apart per call. For a polling
  command we keep a long-lived `System` instead and refresh once per tick;
  the *previous* tick provides the delta, no synthetic sleep needed.
- `refresh_processes(All, true)` is ~1–3 ms on a typical macOS workload
  (5–600 procs). One call per poll covers every lane and its descendants.
- Memory is `proc.memory()` in bytes on sysinfo ≥ 0.30 (used elsewhere in
  the codebase as `/ (1024*1024)` to MB — match that convention).

**Polling cadence and demand (spec 357):**
- `assistantInstanceStore` owns one non-overlapping 2 s cycle across all
  Harness views and monitor panels.
- Existing Harness metrics consumers subscribe at construction and release
  at disposal; switching the active dashboard does not remove that demand.
- The Assistants monitor adds inventory/metrics demand only while its tab is
  actually shown and the document is visible. With no consumers, timers stop.

**Alternatives considered & rejected:**
- *Per-lane Tauri command (`acp_get_metrics(session_id)`)* — N round-trips
  and N sysinfo refreshes per tick. Rejected.
- *Pushing metrics from Rust as `pty-progress`-style events* — adds a timer
  thread and event plumbing for data the frontend only consumes when the
  view is open. Pull is simpler.
- *Using `ps` / shelling out* — `sysinfo` is already loaded. No reason.

## Prior Art

At the original May 2026 design, the researched analogues were dev tools and
supervisors:

| App | Implementation | Notes |
|-----|---------------|-------|
| Activity Monitor / `htop` | One row per process, CPU% + RSS columns, tree view via indent. | Heavy-handed for "which lane is hot?". |
| VS Code Process Explorer (`Developer: Open Process Explorer`) | Tree of extension host + workers + terminals, CPU/mem refreshed every ~1 s. | Tree model is the right one — extensions and their child procs. |
| Zed | No per-agent resource UI. | — |
| Cursor | No per-agent resource UI. | — |
| Claude Code (CLI) | No resource UI. | — |
| tmux | `display-message '#{pane_pid}'` then user runs `top` themselves. | Nothing built-in. |
| Warp | No per-agent metrics surfaced in the agent panel. | — |

**Krypton delta** — collapse the adapter tree into a lane-header chip,
with an opt-in breakdown behind a leader key. Aggregates answer "what is
this lane costing me?" rather than just the adapter binary's cost.
The separate spec-357 Assistants dock answers app-wide instance ownership
and counting; it deliberately does not duplicate this process-tree overlay.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Capture local process identity, snapshot all registered roots, expose `acp_get_lane_metrics`. |
| `src-tauri/src/process_metrics.rs` | Long-lived `MetricsSampler`: one process refresh, identity-checked tree walk, aggregate and CPU-baseline readiness per root. |
| `src-tauri/src/lib.rs` | Register `acp_get_lane_metrics` and manage the sampler. |
| `src/types.ts` | `AcpLaneMetrics`, `AcpLaneProcMetric`, including required `cpu_ready`. |
| `src/assistant-instance-store.ts` | App-scoped demand, one shared metrics cycle, inventory join and stale-result protection (spec 357). |
| `src/acp/acp-harness-view.ts` | Subscribe from construction to disposal; route samples to own lanes, chrome/background-task updates and overlay. `ACP_HARNESS_LEADER_KEYS` declares contextual Leader `=`. |
| `src/acp/components/lane-head/`, `src/acp/components/metrics-overlay/` | Current component-owned chip and process-tree rendering/styles. |
| `docs/0004-architecture.md` | Note metrics IPC under ACP harness section. |
| `docs/0072-acp-harness-view.md` | Cross-reference this spec. |

## Design

### Data Structures

**Rust (`process_metrics.rs`):**

```rust
pub struct TreeMetrics {
    pub root_pid: u32,
    pub root_alive: bool,
    pub cpu_ready: bool,         // a fresh delta exists for this exact process identity
    pub total_cpu_percent: f64,   // sum across tree, capped at NCPU*100 by sysinfo
    pub total_rss_mb: f64,        // sum across tree
    pub proc_count: u32,
    pub processes: Vec<ProcMetric>, // root first, then descendants in tree order
}

pub struct ProcMetric {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,             // bare process name: "node", "python3", etc.
    pub cmd: Vec<String>,         // full argv (bounded) — the frontend derives
                                  // a label from this; "node" alone is useless
    pub exe: Option<String>,      // resolved exe path; fallback label source
    pub cpu_percent: f64,
    pub rss_mb: f64,
}
```

> **`cmd` capture (implementation note).** `sysinfo`'s default
> `refresh_processes` kind omits the command line, so `Process::cmd()` would be
> empty. The sampler uses `refresh_processes_specifics` with the default kind
> plus `.with_cmd(UpdateKind::OnlyIfNotSet)` — cmd/exe are read once per
> process and cached, keeping the per-tick cost flat. argv is bounded
> (`MAX_CMD_ARGS = 48`, `MAX_ARG_LEN = 1024`, char-boundary safe) so a
> pathological `node -e '<blob>'` can't bloat the 2 s payload.

A long-lived `Mutex<sysinfo::System>` lives in Tauri state
(`MetricsSampler`). Each call:
1. Refresh all processes once.
2. Build a `parent -> Vec<child>` map once.
3. Validate each root against its captured `ProcessIdentity` (PID, start
   time and OS birth token), then collect the matching process tree.
4. Sum CPU/RSS and expose `cpu_ready` only after a genuine CPU baseline.

The previous refresh supplies the CPU delta; no synthetic sleep or second
refresh is added per call. New/reused identities cannot inherit readiness
or resource values from an earlier process. Assistants displays **warming up**
until `cpu_ready`; the legacy chip/overlay still receives the raw baseline.

**TypeScript (`src/types.ts`):**

```ts
export interface AcpLaneProcMetric {
  pid: number;
  parent_pid: number | null;
  name: string;
  cmd: string[];          // full argv; source for the derived label
  exe: string | null;     // resolved exe path; fallback label source
  cpu_percent: number;
  rss_mb: number;
}

export interface AcpLaneMetrics {
  session: number;            // krypton_session id
  root_pid: number;
  root_alive: boolean;
  cpu_ready: boolean;         // fresh CPU delta for this exact root identity
  total_cpu_percent: number;
  total_rss_mb: number;
  proc_count: number;
  processes: AcpLaneProcMetric[];
}
```

### API / Commands

**Tauri command:**

```rust
#[tauri::command]
pub fn acp_get_lane_metrics(
    registry: State<'_, Arc<AcpRegistry>>,
    sampler: State<'_, Arc<crate::process_metrics::MetricsSampler>>,
) -> Result<Vec<AcpLaneMetrics>, String>
```

Returns one entry per registered local ACP root with a captured process
identity, including non-lane helpers. Remote transports and unavailable
local identities are omitted. A root absent from the process snapshot or
failing identity validation yields `root_alive: false`, `cpu_ready: false`
and empty/zero resource fields; these are unavailable observations, not
proof that the owned assistant exited.

`AcpClient` captures its PID/start identity after a successful local spawn.
The registry retains terminating clients until teardown completes, so a
still-running stopping process can remain observable. Inventory liveness
comes from separate actual process/remote exit observations, not this API.

### Data Flow

```
1. Harness construction subscribes to the shared metrics feed.
2. A visible Assistants monitor adds demand to that same feed.
3. assistantInstanceStore invokes acp_get_lane_metrics once per cycle.
4. Rust snapshots local process identities, releases registry lock, samples.
5. Return Vec<AcpLaneMetrics>; the store publishes one shared result.
6. Each Harness filters by its numeric ACP handles and updates lane metrics,
   background-task observations, chrome and its open Lane Metrics overlay.
7. The monitor joins aggregate metrics to app-wide inventory (no process argv).
8. Disposal/hidden monitor releases demand; no consumers stops the timer.
```

The store starts immediately and repeats after 2000 ms, never overlapping
cycles. Subscription generations reject late responses after close/reopen;
failed refreshes preserve last-good monitor rows and label stale resources.

### Keybindings

Contextual leader key, Harness-only, declared by `ACP_HARNESS_LEADER_KEYS` in `acp-harness-view.ts`.
No new global chord is added.

| Key | Context | Action |
|-----|---------|--------|
| `=` | Harness leader (`Cmd+P → =`) | Toggle Lane Metrics breakdown for this Harness |

Esc closes the panel.

### UI Changes

**Lane header chip** — slotted into `renderLaneHead` between `sandboxChip`
and `lane-activity`:

```html
<span class="acp-harness__lane-metrics" title="adapter + 3 children — ⌘P = for breakdown">
  <span class="acp-harness__lane-metrics-cpu">12%</span>
  <span class="acp-harness__lane-metrics-rss">184M</span>
</span>
```

Color-coded by CPU bucket using the same gauge palette as
`src/extensions/java.ts::gaugeColor` (≤60 cyan, 60–80 cyan-bright,
80–95 amber `#fac863`, >95 red `#ec5f67`). RSS does not get a color —
absolute MB has no universal "high".

**Breakdown panel** — overlay (similar pattern to existing harness help
panel at `acp-harness-view.ts:1502`), one row per process:

```
node  @agentclientprotocol/claude-agent-acp  [adapter]   pid 8421   cpu 12%   rss 184M
├ node  @modelcontextprotocol/server-filesystem          pid 8443   cpu  3%   rss  62M
├ python3  mcp_server_git                                pid 8455   cpu  0%   rss  41M
└ rg                                                     pid 8470   cpu  9%   rss  12M
```

Shows process trees for this Harness's lanes, not all app-wide helpers.
It receives the same shared samples as the header chips and Assistants dock.

**Process labelling (`describeProc`).** A bare process tree is mostly
indistinguishable `node` rows (the adapter wrapper, each MCP server, tool
subprocesses), so each row carries a derived label answering "which `node` is
this?" plus the full command on hover (`title`). Derivation
(`acp-harness-view.ts`):

- **Interpreters** (`node`, `python*`, `deno`, `bun`, `ruby`, …) → the first
  non-flag argv token (the script / `-m` module), prettified: an npm package
  when under `node_modules/` (`@scope/name`, `.bin/<name>` shims handled),
  else the file basename.
- **npx / npm-exec launchers** → the package being run, scanned further along
  argv and version-stripped (`@scope/pkg@1.2.3` → `@scope/pkg`, `@latest` the
  same way). The Claude and Codex lanes' `npx -y <adapter>@latest` resolve here.
- **Other binaries** (`claude`, `rg`, `git`…) → a path operand's basename, or a
  short bareword subcommand.
- **No argv** (restricted process) → exe basename when it adds something the
  name doesn't.

The label never echoes the process name back at itself.

### Configuration

There are no runtime `[acp_harness.metrics]` configuration keys.
The shared cycle is fixed at 2000 ms and controlled by subscriber demand;
the Assistants panel adds no TOML configuration (spec 357).

## Edge Cases

- **Spawn/identity unavailable** → no local root entry; no invented metrics.
- **Root disappears or PID is reused** → `root_alive: false`, `cpu_ready: false`,
  empty process tree and unavailable measurements. Do not infer lifecycle
  from this result; inventory separately observes the owned process.
- **MCP child reparents** → it is no longer in the adapter's descendant tree
  and does not belong in that root's aggregate.
- **Dispose in progress** → the registry keeps its stopping client until
  teardown ends; a matching live root may still have a sample.
- **First sample for an identity** → `cpu_ready: false`; Assistants says
  warming up, never a measured zero. The next valid delta enables CPU display.
- **Remote/embedded** → not local ACP roots. Spec 357 inventories them with
  explicit unavailable resources; embedded agents share the WebView process.
- **Poll failure or late response** → retain last-good monitor data with an
  error/freshness indicator; reject superseded subscription generations.
- **>100% CPU on multi-core** → sysinfo reports per-core (e.g. 380% on a
  4-thread spin). Chip renders the raw number; gauge color clamps at
  the >95 bucket — anything above is red regardless.

## Open Questions

None — all decisions resolved above.

## Out of Scope

- Historical graphs / sparklines (could come later as an extension to the
  breakdown panel; not required for the "which lane is hot?" use case).
- Per-MCP-server metrics in the chip itself — only in the breakdown.
- Disk / network IO. sysinfo can report disk read/write but the use case
  is CPU/memory; adding columns now is feature creep.
- Alerting / threshold notifications. The color bucket is the only signal.
- Remote PID/CPU/RSS protocol extensions. Remote instances are inventoried
  separately by spec 357 with unknown/unavailable measurements when needed.

## Resources

- [sysinfo crate docs](https://docs.rs/sysinfo/latest/sysinfo/) — `Process::cpu_usage`, `Process::memory`, `refresh_processes` semantics; long-lived `System` instance reuse.
- `src-tauri/src/pty.rs:642-700` — existing tree-walk pattern (`find_deepest_leaf_native`) used as the structural reference for the new collect-all walk.
- `src-tauri/src/pty.rs:711-777` — existing `get_process_metrics` showing the cpu/rss extraction we mirror.
- `src/extensions/java.ts:14-52` — UI precedent for CPU%/RSS rendering and gauge color buckets.
- [VS Code Process Explorer source](https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-browser/processExplorer/processExplorerMain.ts) — tree-of-procs UI inspiration for the breakdown panel.
- [Assistant Instance Monitor](./0357-assistant-instance-monitor.md) — app-wide ownership, shared sampling, unknown liveness and CPU readiness.
- [Windows GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) — creation FILETIME for exact Windows birth identity; macOS uses microseconds and Linux `/proc` start ticks. Windows/Linux runtime validation was not available in the macOS implementation environment.
