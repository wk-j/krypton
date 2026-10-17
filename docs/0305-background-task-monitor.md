# Background Task Monitor — Implementation Spec

> Status: Implemented (2026-10-16)
> Date: 2026-10-16
> Milestone: ACP Harness observability
> Related: `docs/0199-cancel-escalation-force-restart.md`, `docs/0231-lane-peek-action-hud.md` (removed HUD), `docs/0302-harness-component-catalog.md`
>
> Deviations from the approved draft, all narrower or more precise:
> 1. State logic lives in its own module `src/acp/harness-background-tasks.ts`
>    (parse / register / prune / `applyTaskStatus` / `subtreeUsage`) instead of
>    inside `acp-harness-view.ts`; the view keeps capture, the poll and `#bg`.
> 2. The row gained one cell the draft markup omitted,
>    `.acp-harness__bg-task-status`: live CPU·RSS while running, `exit N` once
>    finished, `no process` / `output gone` for the degraded states. CPU/RSS is
>    the matched shell's WHOLE SUBTREE — the wrapper burns nothing, its `java`
>    children are the cost.
> 3. The `bg N` chip carries no spinner (`Chip` owns its markup and has no
>    spinner slot), so the widened `updateSpinnerTicker()` gate is scoped to
>    `metricsPanelOpen` — the only surface where a task spinner is mounted.
>    Closed overlay + idle lanes = no interval, as before.
> 4. `BackgroundTask` lives in `src/acp/harness-view-types.ts` (where every other
>    lane-state type lives); only the IPC mirror `AcpBackgroundTaskStatus` went
>    into `src/types.ts`.

## Problem

A Claude lane launches shell work with `run_in_background`. The launch tool call completes in well under a second, the turn ends, and the lane goes `idle` while a multi-minute build keeps running — with nothing in the UI naming the job, its elapsed time, its output size, or its exit code.

Measured on `Claude-1`, 2026-10-16 (`kryptonctl acp lanes` polled once a second):

```
22:29:18 → 22:29:31  busy      prompt → launch `sleep 40; echo SLEEP_DONE` → narration text
22:29:32 → 22:31:48  idle      job still running; CLI resumed at 22:30:08 and appended rows while idle
```

So the one signal the user has (the lane spinner, which is gated on `status === 'busy'` — `acp-harness-view.ts:12339`, `:12361`, `components/lane-symbol/index.ts:80`) is off for the entire life of the job.

## Solution

A per-lane registry of background tasks, captured from the launch tool call itself — the adapter already hands Krypton the task ID and the absolute output path in the tool result. Status is refreshed on the **existing** 2 s metrics poll by stat-ing/tailing that file and matching the lane's process tree. Rendered as a `BACKGROUND TASKS` section inside the existing `=` *Lane Metrics* overlay, plus a `bg N` chip on the lane head and a `#bg` transcript snapshot.

Read-only observer: no protocol change, no new timer, no process control.

## Research

Findings that shaped the design (each verified in this repo or measured live):

- **ACP terminals are off.** `clientCapabilities.terminal = false` (`src-tauri/src/acp.rs:2023`), so `terminal/wait_for_exit` and friends are unavailable and the CLI owns the process. An unknown inbound method is answered `-32601` (`acp.rs:1617-1624`).
- **The launch tool result carries everything needed.** Verbatim content Krypton receives: `Command running in background with ID: bxs80otkx. Output is being written to: /private/tmp/claude-501/-Users-wk-Project-tli-api-service/38bb8953-…/tasks/bxs80otkx.output`. Parsing it means Krypton never has to guess the CLI's private tmp layout.
- **The output file is self-describing.** Both files from today end with `[exited with code 0]` as their last line (`bwwz4dpnm.output`, `bxs80otkx.output`); while running the marker is absent and mtime advances.
- **Completion cannot be inferred from the turn.** The CLI self-resumes: its session log shows `user <task-notification><task-id>bxs80otkx</task-id>` at `22:30:08`, entirely outside Krypton's turn lifecycle, and Krypton's lane status never leaves `idle`.
- **The process is already in the lane tree.** `acp_get_lane_metrics` returns every descendant with full argv, CPU and RSS (`acp.rs:2620-2655`, `process_metrics.rs:14-30`); a child spawned inside a lane tool call is a descendant of the adapter (measured ancestry `sleep → python → omp → /Applications/Krypton.app/Contents/MacOS/app`).
- **The frontend cannot touch the filesystem.** No `@tauri-apps/plugin-fs` in `package.json`, so a Rust command is required; `read_mcp_config_file` (`acp.rs:2662`) is the precedent for a narrow, path-scoped reader.
- **The host surface exists.** `MetricsOverlay` already renders a per-lane process tree on the 2 s poll (`components/metrics-overlay/index.ts`), opened with `=` *Lane Metrics* (`acp-harness-view.ts:4088-4092`).
- **`BashOutput` is not exposed on ACP lanes.** The agent stated so itself in-transcript ("lane นี้ไม่มีเครื่องมือ BashOutput ให้ poll"), which is why the agent reads the log file and why the user has no in-app equivalent of `/tasks`.

Alternatives ruled out:

- **Advertise `terminal: true`.** Krypton would then own every shell the agent runs: implement `terminal/create`, `output`, `wait_for_exit`, `kill`, `release`, plus PTY lifecycle and output byte limits, affecting every lane and backend. [INFERENCE] It is also unverified that `@agentclientprotocol/claude-agent-acp` routes `run_in_background` through client terminals at all, so the cost may buy nothing for this specific case. Kept as a separate future spec.
- **Derive the tasks directory from `lane.sessionId` + a cwd slug.** Works today (`/tmp/claude-$UID/<slug>/<session>/tasks/<id>.output`) but hard-codes a private layout; parsing the path out of the tool result needs no such knowledge.
- **A filesystem watcher.** New Rust dependency and a wakeup per write on a file a build appends to thousands of times. A 2 s `stat` + 4 KiB tail on ≤20 paths is cheaper and already scheduled.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code CLI | `Ctrl+B` backgrounds a suggested command; `/tasks` lists the session's background work; `BashOutput` / `KillShell` read or stop a shell | The in-CLI equivalent. Neither `/tasks` nor `BashOutput` reaches an ACP lane, so Krypton users lose it |
| Zed (ACP client) | Implements ACP `terminal/*`; a terminal tool call embeds a live output card with exit status, kept after `terminal/release` | The "do it properly" path — requires the capability this spec declines to enable |
| Warp | Each command is a block with its own status: spinner while running, exit-code badge when done, collapsible output | Closest match to the row vocabulary chosen here *(general knowledge, docs not consulted)* |
| VS Code | Tasks run inside the Terminal panel; "Tasks: Show Running Tasks" opens a separate list | Separate surface, mouse-first *(general knowledge, docs not consulted)* |
| tmux | `monitor-activity` marks a window with an activity flag in the status line | Status-flag precedent for the lane-head chip *(general knowledge, docs not consulted)* |

**Krypton delta** — keyboard-only (`=` overlay, `#bg` command, no mouse affordance) and deliberately *status-only*: Krypton cannot read or kill the process, so a row never pretends to be an interactive terminal. The badge vocabulary follows Warp; the placement diverges from VS Code by extending the existing lane-metrics overlay instead of adding a panel.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | New `acp_background_task_status` command + `BgTaskQuery` / `BgTaskStatus` types: metadata + 4 KiB tail + sentinel parse |
| `src-tauri/src/lib.rs` | Register the command in `generate_handler![…]` |
| `src/types.ts` | `AcpBackgroundTaskStatus` mirror type |
| `src/acp/harness-view-types.ts` | `BackgroundTask` + `backgroundTasks: BackgroundTask[]` on `HarnessLane` |
| `src/acp/harness-background-tasks.ts`, `.test.ts` | New: launch parsing, registry + cap, status folding, process-subtree usage |
| `src/acp/acp-harness-view.ts` | `captureBackgroundLaunch` on `tool_call` / `tool_call_update`; `refreshBackgroundTasks` inside `pollMetrics()`; widened `updateSpinnerTicker()` gate; `#bg` → `printBackgroundTasks`; overlay + lane-head props |
| `src/acp/components/background-tasks/{index.ts,background-tasks.css,background-tasks.test.ts}` | New section component (one directory per surface, per spec 301/302) |
| `src/acp/components/metrics-overlay/index.ts`, `.test.ts` | `MetricsLane` gains `tasks` + `now`; one `BackgroundTasks` per lane block, mounted for the block's life |
| `src/acp/components/lane-head/index.ts`, `lane-head.css` | `bg N` chip in `headChips()` + the `acp-harness__lane-bg` pill |
| `src/acp/components/registry.ts` | Register the new `def` |
| `src/acp/components/help-overlay/index.ts` | `#bg` help row |

## Design

### Data Structures

```ts
// src/acp/types.ts
export interface BackgroundTask {
  readonly id: string;              // 'bxs80otkx', from the launch result
  readonly toolCallId: string;      // the launch tool call, for transcript cross-reference
  readonly command: string;         // rawInput.command of the launch call
  readonly outputPath: string;      // absolute, parsed from the launch result
  readonly startedAt: number;       // Date.now() at capture
  state: 'running' | 'exited' | 'orphaned' | 'unknown';
  exitCode: number | null;          // from `[exited with code N]`
  endedAt: number | null;           // file mtime at the poll that first saw the marker
  bytes: number;                    // output file length
  lastLine: string;                 // last non-empty line of the tail, clamped to 200 chars
  pid: number | null;               // matched from the lane process tree
  cpuPercent: number | null;        // from that process row
  rssMb: number | null;
  missStreak: number;               // consecutive polls with no marker and no live pid
}
```

```rust
// src-tauri/src/acp.rs
#[derive(Debug, Deserialize)]
pub struct BgTaskQuery { pub id: String, pub path: String }

#[derive(Debug, Serialize)]
pub struct BgTaskStatus {
    pub id: String,
    pub exists: bool,
    pub bytes: u64,
    pub modified_ms: Option<u64>,
    pub exit_code: Option<i32>,   // Some(_) only when the LAST line matches the marker
    pub last_line: String,        // last non-empty line of the tail, trimmed
}
```

### API / Commands

```rust
#[tauri::command]
pub async fn acp_background_task_status(
    queries: Vec<BgTaskQuery>,
) -> Result<Vec<BgTaskStatus>, String>
```

- At most `TAIL_BYTES = 4096` read per task, seeked from the end — a multi-megabyte `mvn` log is never read whole.
- Marker regex applied to the **last non-empty line only**: `^\[exited with code (-?\d+)\]$`. A line of build output that happens to contain the same text mid-file is ignored.
- A missing file is `exists: false`, never an `Err` — only permission/IO failures reject (same contract as `read_mcp_config_file`).
- Paths are accepted as given (they come from the adapter, not the user) but must be absolute; a relative path is rejected.

### Data Flow

```
1. Agent calls Bash with run_in_background; adapter emits tool_call / tool_call_update
2. View matches content text `Command running in background with ID: (\S+)\. Output is being written to: (\S+)`
   → pushes a BackgroundTask onto lane.backgroundTasks (state 'running')
3. Existing 2 s pollMetrics() tick: collect every non-terminal task across lanes
4. invoke('acp_background_task_status', { queries })  — one IPC round trip for all lanes
5. For each answer: bytes/lastLine updated; exit_code present → state 'exited', endedAt = modified_ms
6. No marker: match lane metrics processes by argv == task.command → pid/cpu/rss;
   no match twice in a row (missStreak >= 2) → state 'orphaned'
7. Lane head chip + overlay section update through the component kernel (deps = formatted values,
   so a poll that moves nothing writes nothing)
```

### UI Changes

**Lane head chip** (`headChips()`, grid column 4): `bg 2` when ≥1 task is `running`, title `2 background tasks: <commands> — ⌘P = for detail`. Plain `Chip`, tone `on`, no spinner — `Chip` owns its own markup and the count is the signal, not an animation.

**Spinner ticker gate.** `updateSpinnerTicker()` starts its interval only while a lane is `busy` — and the whole point of this spec is that no lane is busy then, so a task row's glyph would sit frozen on frame 0. The gate becomes `anyBusy || (metricsPanelOpen && anyRunningBackgroundTask)`; `toggleMetricsPanel()` re-evaluates it. With the overlay closed no task spinner is mounted, so the interval would tick an empty set — hence the `metricsPanelOpen` term.

**Overlay section**, one per lane block, below the process tree, hidden by attribute when the lane has no tasks (its own sheet re-states `[hidden] { display: none }`, which an author `display:` would otherwise outrank). As built, with the status cell:

```html
<section class="acp-harness__bg-tasks" data-count="1">
  <div class="acp-harness__bg-tasks-head">BACKGROUND TASKS</div>
  <div class="acp-harness__bg-tasks-rows">
    <div class="acp-harness__bg-task acp-harness__bg-task--running" title="<output path> · pid 200">
      <span class="acp-harness__bg-task-glyph"><span class="acp-harness__spinner">⠋</span></span>
      <span class="acp-harness__bg-task-id">bwwz4dpnm</span>
      <span class="acp-harness__bg-task-cmd" title="<full command>">mvn clean install &gt; /tmp/release-1286-b…</span>
      <span class="acp-harness__bg-task-elapsed">1:14</span>
      <span class="acp-harness__bg-task-bytes">182 KB</span>
      <span class="acp-harness__bg-task-status">182% · 1.5G</span>
      <span class="acp-harness__bg-task-tail">[INFO] Building TLI Entity 1.0.0</span>
    </div>
  </div>
</section>
```

Once the job exits, the same row becomes `--exited` (or `--failed`): the spinner span goes static `✓` / `✗`, elapsed freezes at `endedAt`, and the status cell reads `exit 0`.

Glyph vocabulary matches the tool rows: `⠋` running (shared ticker), `✓` exit 0, `✗` non-zero, `·` orphaned/unknown. State modifiers `--running | --exited | --failed | --orphaned`. Full 1px borders or none — no corner brackets (constraint 9). Styles live in the component's own `@layer krypton.component` block.

**`#bg`** prints a plain-text snapshot into the transcript (same shape as `#mcp`), so the information is reachable without the overlay.

### Keybindings

None new — `=` *Lane Metrics* already opens the host overlay; `#bg` is a composer command.

### Configuration

None.

## Edge Cases

| Case | Handling |
|------|----------|
| Launch text format changes upstream | Regex misses → no task captured, section stays hidden, one `debug!` log. Nothing else breaks |
| Output file deleted or on a gone volume | `exists: false` → state `unknown`, last known bytes retained, row dimmed |
| Job killed by a signal (no marker written) | Marker never appears; pid leaves the tree → `orphaned` after 2 polls (~4 s) |
| Build output contains `[exited with code 0]` mid-log | Only the last non-empty line is matched |
| Multi-megabyte log | 4 KiB tail only; `bytes` comes from file metadata |
| App restarted while a job runs | Registry is in-memory and starts empty — running jobs are invisible until re-mentioned (see Out of Scope) |
| Lane closed / `#new` / restart | Tasks are cleared with the lane state they live on |
| More than 20 tasks on one lane | Drop oldest `exited`/`orphaned` first; a `running` task is never dropped |
| Two lanes in the same repo | Output paths contain the ACP session id, so IDs never collide across lanes |
| Non-Claude backend (Codex, Gemini, omp) | No launch text → no tasks → chip and section absent |
| argv match ambiguity (two identical commands) | First unmatched process row wins; pid/CPU are advisory, never the liveness source of truth when a marker exists |

## Out of Scope

- Killing, pausing or re-reading a background task from Krypton (no control channel; `KillShell` is not exposed to ACP lanes).
- Streaming the output file into the transcript or a terminal card.
- Waking the lane when a task finishes — the CLI already self-resumes via `<task-notification>`; Krypton must not inject a second prompt into a session that may be mid-continuation.
- Fixing the lane status lying `idle` during a CLI self-resumed turn. Real, measured, and worth its own spec; this one only makes the work visible.
- Recovering tasks after an app restart (would require scanning the CLI's private tmp layout).
- Enabling the ACP `terminal` capability.
- Background work from non-Claude backends.

## Resources

- [Terminals — Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/terminals) — the `terminal/create|output|wait_for_exit|kill|release` surface Krypton would have to implement, and the `terminal: false` gate that rules it out today.
- [Commands — Claude Code Docs](https://code.claude.com/docs/en/commands) — `/tasks` as the CLI's own background-work list, the behaviour this spec restores inside the harness.
- [claude-flow wiki: background commands](https://github.com/optimy-ai/claude-flow/blob/main/docs/wiki/background-commands.md) — documents `Ctrl+B` and `run_in_background` as the two ways a command is detached.
- Local evidence: `~/.claude/projects/-Users-wk-Project-tli-api-service/38bb8953-….jsonl` (`<task-notification>` entries at 21:49:33 and 22:30:08) and `/private/tmp/claude-501/…/tasks/*.output` (`[exited with code 0]` sentinel).
