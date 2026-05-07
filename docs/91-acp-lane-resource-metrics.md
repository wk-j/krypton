# ACP Lane Resource Metrics — Implementation Spec

> Status: Implemented
> Date: 2026-05-07
> Milestone: ACP Harness — observability

## Problem

The harness shows lane state (status, mode, MCP, model) but no resource cost.
Users running multiple ACP adapters concurrently (Claude + Codex + Gemini +
OpenCode + Pi + Droid) have no way to tell which lane is hot, leaking memory,
or stuck in a CPU spin without dropping out to `top`/Activity Monitor.

## Solution

Track CPU% and RSS for each ACP adapter subprocess **and its descendants**
(the MCP servers it spawns are reparented under it via `setsid`, so a tree
walk captures them) using the existing `sysinfo` infrastructure already used
by `pty.rs::get_process_metrics` and the Java extension. Surface aggregate
numbers as a compact chip in the lane header; expose a tree breakdown via a
new contextual leader key for users who want to see which MCP server is the
heavy one. Frontend polls a single Rust command for *all* lanes at ~2 Hz;
backend does one `sysinfo::System::refresh_all` per call so cost stays flat
regardless of lane count.

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
- `AcpClient.child: Mutex<Option<Child>>` (`acp.rs:154`) holds the
  `tokio::process::Child`. `child.id()` is read at `acp.rs:1184` to send
  SIGTERM, so the PID is recoverable on demand.
- `setsid` is used so MCP grandchildren inherit the process group
  (`acp.rs:809-810`). They will appear as descendants in the sysinfo tree
  rooted at the adapter's PID until they reparent on adapter death.
- `AcpRegistry` (`acp.rs:699`) holds `RwLock<HashMap<u64, Arc<AcpClient>>>` —
  iterable for a single batched metrics call.

**sysinfo cost / accuracy notes:**
- `cpu_usage()` returns 0 on the first refresh. The Java path
  (`pty.rs:715-720`) does two refreshes 200 ms apart per call. For a polling
  command we keep a long-lived `System` instead and refresh once per tick;
  the *previous* tick provides the delta, no synthetic sleep needed.
- `refresh_processes(All, true)` is ~1–3 ms on a typical macOS workload
  (5–600 procs). One call per poll covers every lane and its descendants.
- Memory is `proc.memory()` in bytes on sysinfo ≥ 0.30 (used elsewhere in
  the codebase as `/ (1024*1024)` to MB — match that convention).

**Polling cadence:**
- Java extension polls per terminal at its own rate. The harness has
  ≤ 6 lanes today and the chip is decorative, so 2 s (0.5 Hz) is plenty.
- Pause polling when the harness view is not the active dashboard
  (`acp-harness-view.ts` already tracks active state) to keep idle CPU
  near zero.

**Alternatives considered & rejected:**
- *Per-lane Tauri command (`acp_get_metrics(session_id)`)* — N round-trips
  and N sysinfo refreshes per tick. Rejected.
- *Pushing metrics from Rust as `pty-progress`-style events* — adds a timer
  thread and event plumbing for data the frontend only consumes when the
  view is open. Pull is simpler.
- *Using `ps` / shelling out* — `sysinfo` is already loaded. No reason.

## Prior Art

Resource per-agent surfacing in agent UIs is fairly novel; the closest
analogues are dev tools and supervisors:

| App | Implementation | Notes |
|-----|---------------|-------|
| Activity Monitor / `htop` | One row per process, CPU% + RSS columns, tree view via indent. | Heavy-handed for "which lane is hot?". |
| VS Code Process Explorer (`Developer: Open Process Explorer`) | Tree of extension host + workers + terminals, CPU/mem refreshed every ~1 s. | Tree model is the right one — extensions and their child procs. |
| Zed | No per-agent resource UI. | — |
| Cursor | No per-agent resource UI. | — |
| Claude Code (CLI) | No resource UI. | — |
| tmux | `display-message '#{pane_pid}'` then user runs `top` themselves. | Nothing built-in. |
| Warp | No per-agent metrics surfaced in the agent panel. | — |

**Krypton delta** — no agent harness today exposes per-agent CPU/RSS in the
header. The closest paradigm is VS Code's Process Explorer, but as a
dedicated window. Krypton's twist: collapse the tree into a single chip
inline with model/mode/MCP chips (familiar location), with an opt-in
breakdown popover behind a leader key. Aggregate numbers (adapter +
descendants) match the user's mental model: "what is *this lane*
costing me?", not "what is the adapter binary itself doing?".

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Store `child_pid: AtomicU32` on `AcpClient`; expose getter. |
| `src-tauri/src/process_metrics.rs` *(new)* | `collect_tree_metrics(roots: &[u32]) -> Vec<TreeMetrics>` — single sysinfo refresh, tree walk, aggregate per root. |
| `src-tauri/src/lib.rs` | Register new command `acp_get_lane_metrics`. |
| `src/types.ts` | Add `AcpLaneMetrics`, `AcpLaneProcMetric` types. |
| `src/acp/acp-harness-view.ts` | Poll loop (start/stop on view show/hide), store metrics on lane, render chip in `renderLaneHead`, toggle breakdown panel. |
| `src/styles/acp-harness.css` | Style `.acp-harness__lane-metrics` chip + `.acp-harness__metrics-panel` breakdown. |
| `src/input-router.ts` | Wire contextual leader key `m` (harness mode) to toggle breakdown. |
| `docs/PROGRESS.md` | Append entry. |
| `docs/04-architecture.md` | Note metrics IPC under ACP harness section. |
| `docs/72-acp-harness-view.md` | Cross-reference this spec. |

## Design

### Data Structures

**Rust (`process_metrics.rs`):**

```rust
pub struct TreeMetrics {
    pub root_pid: u32,
    pub root_alive: bool,
    pub total_cpu_percent: f64,   // sum across tree, capped at NCPU*100 by sysinfo
    pub total_rss_mb: f64,        // sum across tree
    pub proc_count: u32,
    pub processes: Vec<ProcMetric>, // root first, then descendants in tree order
}

pub struct ProcMetric {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,             // "claude-code-acp", "node", etc.
    pub cpu_percent: f64,
    pub rss_mb: f64,
}
```

A long-lived `Mutex<sysinfo::System>` lives in Tauri state
(`AcpMetricsSampler`). Each call:
1. `sys.refresh_processes(ProcessesToUpdate::All, true)`
2. Build a `parent -> Vec<child>` map once.
3. For each root PID, BFS the map collecting `ProcMetric`s; sum CPU/RSS.

Two refreshes are *not* needed because the sampler is long-lived: the
previous poll's snapshot is the baseline for `cpu_usage()`. On the first
call after app start the chip shows `--%` for one tick.

**TypeScript (`src/types.ts`):**

```ts
export interface AcpLaneProcMetric {
  pid: number;
  parent_pid: number | null;
  name: string;
  cpu_percent: number;
  rss_mb: number;
}

export interface AcpLaneMetrics {
  session: number;            // krypton_session id
  root_pid: number;
  root_alive: boolean;
  total_cpu_percent: number;
  total_rss_mb: number;
  proc_count: number;
  processes: AcpLaneProcMetric[];
}
```

### API / Commands

**New Tauri command:**

```rust
#[tauri::command]
pub async fn acp_get_lane_metrics(
    registry: State<'_, Arc<AcpRegistry>>,
    sampler: State<'_, Arc<AcpMetricsSampler>>,
) -> Result<Vec<AcpLaneMetrics>, String>
```

Returns one entry per live lane. Lanes whose child PID is `None` (dispose
in flight, spawn failed) are omitted. Lanes whose root PID is no longer in
the sysinfo snapshot return with `root_alive: false` and zeros — the UI
shows that state for one tick before the lane transitions to `error` or
the entry vanishes on next poll.

**`AcpClient` change** (`acp.rs:131`):

```rust
child_pid: AtomicU32,  // 0 = unset
```

Set in `acp_spawn` immediately after `cmd.spawn()` from `child.id()`
(`acp.rs:817`). Cleared (set to 0) in `acp_dispose`.

### Data Flow

```
1. Harness view becomes active → starts pollMetrics() at 2 s interval.
2. Frontend invokes `acp_get_lane_metrics` (one call, all lanes).
3. Rust: sampler.refresh_all_processes() once.
4. For each lane in registry: read child_pid; if non-zero, collect tree.
5. Return Vec<AcpLaneMetrics>.
6. Frontend updates lane.metrics map keyed by session id.
7. renderLaneHead() includes a metrics chip from lane.metrics if present.
8. View becomes inactive (workspace switch / harness closed) → poll stops.
```

The poll task is `setInterval`-based and stored on the harness view as
`metricsTimer: number | null`. Started in the existing `onActivate`
hook, cleared in `onDeactivate` and `dispose`.

### Keybindings

Contextual leader key, harness-only (registered in `input-router.ts`
alongside the existing harness leader keys). Per memory rule, no Alt.

| Key | Context | Action |
|-----|---------|--------|
| `m` | Harness leader (`Cmd+P → m`) | Toggle metrics breakdown panel for active lane |

Esc closes the panel.

### UI Changes

**Lane header chip** — slotted into `renderLaneHead` between `sandboxChip`
and `lane-activity`:

```html
<span class="acp-harness__lane-metrics" title="adapter + 3 children — click ⌘P m for breakdown">
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
ADAPTER         pid 8421    cpu 12%    rss 184M
├ node          pid 8443    cpu  3%    rss  62M    [@modelcontextprotocol/server-filesystem]
├ python3       pid 8455    cpu  0%    rss  41M    [mcp-server-git]
└ rg            pid 8470    cpu  9%    rss  12M
```

Shows tree from the active lane only. Updated live by the same poll loop.

### Configuration

```toml
[acp_harness.metrics]
enabled = true               # default true; set false to skip polling entirely
poll_interval_ms = 2000      # 500..=10000; clamped
```

Both keys optional; defaults applied if missing. Disabling at runtime via
hot-reload stops the timer immediately and clears chips.

## Edge Cases

- **Lane spawn fails** → `child_pid == 0`, lane omitted from metrics
  response; chip not rendered. Existing error UI handles the failure.
- **Adapter dies (zombie)** → root PID gone from sysinfo snapshot. Return
  `root_alive: false, total_*: 0, processes: []`. Chip dims; one tick
  later the lane transitions to `error` via existing path and the chip
  disappears with the lane.
- **MCP child reparents** (adapter SIGKILL'd, child still alive briefly) →
  not our problem; once the adapter root dies, the lane is gone.
- **Frontend invokes during a `dispose`** → registry returns the (now
  removed) lane's `Option<Arc<AcpClient>>` as `None`; metrics omits it.
  Race-safe.
- **First tick after spawn** → `cpu_usage()` returns 0 because there is
  no prior snapshot. UI shows `0%` rather than `--`; acceptable.
- **>100% CPU on multi-core** → sysinfo reports per-core (e.g. 380% on a
  4-thread spin). Chip renders the raw number; gauge color clamps at
  the >95 bucket — anything above is red regardless.
- **Hot-reload of `poll_interval_ms`** → on next config-changed event,
  clear timer and restart with new interval.

## Open Questions

None — all decisions resolved above.

## Out of Scope

- Historical graphs / sparklines (could come later as an extension to the
  breakdown panel; not required for the "which lane is hot?" use case).
- Per-MCP-server metrics in the chip itself — only in the breakdown.
- Disk / network IO. sysinfo can report disk read/write but the use case
  is CPU/memory; adding columns now is feature creep.
- Alerting / threshold notifications. The color bucket is the only signal.
- Windows support for the tree walk — current code paths in `pty.rs`
  already use `sysinfo` cross-platform; no extra work expected, but
  validation is a follow-up.

## Resources

- [sysinfo crate docs](https://docs.rs/sysinfo/latest/sysinfo/) — `Process::cpu_usage`, `Process::memory`, `refresh_processes` semantics; long-lived `System` instance reuse.
- `src-tauri/src/pty.rs:642-700` — existing tree-walk pattern (`find_deepest_leaf_native`) used as the structural reference for the new collect-all walk.
- `src-tauri/src/pty.rs:711-777` — existing `get_process_metrics` showing the cpu/rss extraction we mirror.
- `src/extensions/java.ts:14-52` — UI precedent for CPU%/RSS rendering and gauge color buckets.
- [VS Code Process Explorer source](https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-browser/processExplorer/processExplorerMain.ts) — tree-of-procs UI inspiration for the breakdown panel.
