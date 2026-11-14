# Active Background Task Strip — Implementation Spec

> Status: Implemented — approved 2026-11-14; implemented 2026-11-14
> Date: 2026-11-14
> Milestone: M8 — Polish
> Builds on: [305](./0305-background-task-monitor.md), [384](./0384-visible-background-task-strip.md)

## Problem

Before this change, the composer `BACKGROUND` strip retained completed and failed jobs, and displayed `NO PROCESS MATCH` and `OUTPUT UNAVAILABLE` rows. The user wants that strip to show only work still considered active and to show a PID when one has been found. `#bg` and Lane Metrics should retain their existing task history.

## Solution

Qualify only tasks whose registry state is `running` for the composer strip. Remove a row on the first metrics update that changes its state to `exited`, `unknown` or `orphaned`; hide the strip and release its height when no running rows remain. Show `RUNNING · PID <number>` when the existing lane process-tree match has set `task.pid`, otherwise show `RUNNING` without a guessed number. Do not change registry retention, polling, `#bg`, Lane Metrics or the lane-head count.

## Research

- `registerBackgroundTask()` creates a `running` task with `pid: null`. The existing 2 s metrics feed updates `pid` from a process-tree command match, clears it when the output file is missing or the process no longer matches, and marks an exit when the output file contains the final exit marker.
- Before this change, `BackgroundTaskStrip` treated every non-exited state as visible, retained failures without a time limit, and kept a successful exit for 5 s. Its keyed `TaskRow` already tracked the state label in `readDeps()`, so a PID change can patch that one cell without repainting transcript rows.
- `pid` is an advisory match for the detached shell in the lane process tree. It may be absent while a just-launched task is still `running`, or change on a later sample. The exit marker remains authoritative for completion.
- Filtering only at the composer component preserves the history in the shared per-lane registry. Filtering or deleting tasks in the registry would also alter `#bg`, Lane Metrics and the lane head.

## Prior Art

| Surface | Existing behavior | Decision here |
| --- | --- | --- |
| Claude Code CLI | Background Bash immediately returns a task ID; `/tasks` manages running tasks. | Keep the task ID and full state in the existing detail surfaces. |
| VS Code Tasks | Run/Terminate Task operate on running task instances; background problem matchers distinguish active periods. | Make this compact strip a current-activity view. |
| Krypton Lane Metrics | Shows detailed task status and process metrics, including process PID. | Reuse its sampled PID, without adding a second monitor. |

Krypton keeps the current keyboard path (`⌘P` then `=` for Lane Metrics and `#bg` for a snapshot). The strip remains passive, with the existing faceplate LED and no new controls.

## Affected Files

| File | Change |
| --- | --- |
| `src/acp/components/background-task-strip/index.ts` | Filter to `running` tasks and render the known PID in the state label. |
| `src/acp/components/background-task-strip/background-task-strip.test.ts` | Cover active-only visibility, PID arrival/change/removal, overflow and equal-poll DOM behavior. |
| `src/acp/components/harness-integration.test.ts` | Verify the composer hides on exit without changing a sealed transcript row. |
| `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0302-harness-component-catalog.md`, `docs/0305-background-task-monitor.md`, `docs/0384-visible-background-task-strip.md` | Update prior contract language and point to this revision. |
| `docs/README.md` | Index this spec. |

## Design

### Data and API

Keep `BackgroundTaskStripProps` and the 2 s cadence. The source-aware registry and capability-gated OMP status command are defined in [spec 398](./0398-omp-async-bash-monitor.md); this active-only presentation applies to both sources. No new strip timer or configuration. The `now` prop does not decide visibility.

### Data Flow

1. A validated supported launch registers a `running` task; show `RUNNING` immediately. Unknown OS PID stays absent.
2. The shared metrics poll folds Claude file/process status or OMP job snapshots into the task. Show `RUNNING · PID <pid>` only when known, updating only the affected cell.
3. Any non-running state (`exited`, `failed`, `cancelled`, `unknown`, `orphaned`) removes its keyed row. Hide the strip when none remain. Retained detail history stays in `#bg` and Lane Metrics; unresolved OMP observations remain eligible for later snapshots.
4. Show at most three running jobs, newest first. `+N more` counts only remaining running jobs and keeps the existing Lane Metrics key hint.

### UI and Keyboard

Keep the current row, LED, command, latest output and responsive layout. Running rows have no elapsed duration, as before. The PID is plain text in the state label and has no action attached. No new shortcut: existing `⌘P` then `=` opens Lane Metrics, and `#bg` prints the history snapshot.

## Edge Cases and Verification

- A newly launched task and the first missed process sample can still be `running` with no PID; show `RUNNING` until the registry changes state. Never display a stale PID.
- For Claude, missing output becomes `unknown`, a second process miss becomes `orphaned`, and an exit marker settles the job. For OMP, snapshots report completion/failure/cancellation or unavailable status without file/process heuristics. Every non-running state leaves the strip immediately.
- A later running task remains visible when another task exits. The strip hides and reserves no height when its last running task leaves.
- Test in-place task mutations, PID label updates, filtering, overflow and no DOM writes for an unchanged poll; run frontend type-check and focused tests. Verify native visual behavior only after the running app has loaded the new build.

## Implementation Verification

- Component, composer and harness integration suites pass (32 tests). The integration case verifies that the exit poll hides the strip while the task remains in the lane registry and the sealed transcript row is untouched.
- `npm run check`, `npm run build` and `git diff --check` pass. The installed Tauri app was not restarted, so its native window has not been visually verified with this build.

## Open Questions

None. The user specified that the active-only filter applies to the `BACKGROUND` strip, while `#bg` and Lane Metrics retain history.

## Out of Scope

Changing process matching, exit detection, task registry retention, task controls, notification behavior, Lane Metrics, `#bg`, the lane-head count or unrelated harness UI.

## Resources

- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) — background Bash returns a task ID and provides `/tasks` for task management.
- [VS Code Tasks](https://code.visualstudio.com/docs/debugtest/tasks) — running task controls and active periods for background tasks.
- Krypton specs [305](./0305-background-task-monitor.md) and [384](./0384-visible-background-task-strip.md) — current registry, status and strip contracts.
