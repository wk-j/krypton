# Visible Background Task Strip — Implementation Spec

> Status: Implemented — approved and implemented 2026-11-11; presentation amended by [spec 397](./0397-active-background-task-strip.md) on 2026-11-14
> Date: 2026-11-11
> Builds on: [305](./0305-background-task-monitor.md), [301](./0301-harness-ui-components.md), [302](./0302-harness-component-catalog.md), [380](./0380-acp-lane-adapters.md)

## Problem

The user cannot tell that Claude is still running a detached command from the main conversation surface. A task registry, a `bg N` header badge, an optional metrics overlay and `#bg` are not a persistent, named activity indicator beside the prompt. A completed launch tool call must not make ongoing work appear finished.

## Solution

Add a compact, automatically visible background-task strip at the top of the active lane's composer. It shows running jobs with their command, matched PID when known, and latest reported output without opening another surface. Keep it visible after the agent turn ends, during later turns, in Zen/concise layouts and while a permission/question owns the composer. A job leaves the strip when its registry state changes from `running`; the registry and detail surfaces retain its history. Each job costs one line; there is no separate head line. This is the current presentation contract after spec 397.

Reuse the task registry and source-specific observer: Claude's existing log reader, or OMP's capability-gated read-only snapshots from [spec 398](./0398-omp-async-bash-monitor.md). Do not create a second process monitor or mutate a completed launch row. Claude launch capture accepts generic `rawOutput` text sections as well as content and terminal output; OMP capture requires structured Bash job metadata, never prose.

## Research

- Live `lane.transcript` inspection showed a completed Maven launch, background narration and later log-reading calls. This API exposes portable text/status, not the raw tool result or the lane task registry; it does not establish which launch shape that specific call used.
- Before this change, `claude.ts` read launch content and terminal output only. Browser reproduction through the real decoder and `BackgroundTasks` showed a visible section for both, but no registered task for the same launch line in `rawOutput.stdout`.
- `captureBackgroundLaunch()` registers tasks; `refreshBackgroundTasks()` folds log status through the existing metrics subscription. `BackgroundTasks` hides itself when the registry is empty.
- `Composer` owns persistent children and separately updates them. Its draft and decision branches can both include one strip without touching transcript DOM or draft state.
- `BackgroundTask` already carries command, start/end time, bytes, last line and running/exited/orphaned/unknown state. The existing reader reads at most 4 KiB per file and treats the trailing exit marker as authoritative.
- Spec 377 places a live job strip outside its reader's scroll area. Use that placement principle, not its unrelated commit-explainer model.

## Prior Art

| Surface | Existing behavior | Decision here |
| --- | --- | --- |
| Claude Code CLI | `Ctrl+B` backgrounds work; `/tasks` lists running shells/subagents. `Ctrl+T` is the to-do checklist, not background execution. | Do not require a command to discover that work is still running. |
| Krypton Commit Explainer (377) | A bounded job strip stays outside the scrolled message and updates independently. | Apply the same always-visible placement beside the prompt. |
| Krypton Lane Metrics (305) | Detailed tasks, resource usage and log tails in an optional overlay. | Retain as detail, not the primary activity signal. |

The original Claude strip needs no new task protocol or UI dependency. OMP support requires the versioned snapshot extension defined in spec 398; OMP 18.20.0 does not advertise it.

## Design

### Component and props

Add `BackgroundTaskStrip` under `src/acp/components/background-task-strip/`, registered in `components/registry.ts` and documented in the component catalog.

```ts
interface BackgroundTaskStripProps {
  readonly tasks: readonly BackgroundTask[];
  readonly now: number;
}
```

`ComposerDraftProps` and `ComposerDecisionProps` gain a required `background: BackgroundTaskStripProps`. The empty composer has no strip. `Composer.patchBackgroundTasks(props)` forwards metrics/capture updates directly to this child, like `patchLiveVoice()`, without repainting the draft, palettes or meta.

### Placement and content

- First child of the composer in both draft and decision branches, outside transcript scrolling. Never mount it inside a sealed transcript row, optional side panel or metrics overlay.
- Hide when the active lane has no task that qualifies for a row (below). Reserve no height while hidden; explicitly author the block's `[hidden]` rule.
- No head line. An engraved `BACKGROUND` label sits at the start of the first row; there is no count readout and no always-visible detail hint. No new focusable control or shortcut is introduced; `#bg` remains available.
- One flat line per running job: state LED, `RUNNING` label with `· PID N` only when the source knows an OS PID, command in its original case and latest output as plain text. The OMP 16.3.11 source implementation supplies no PID.
- No live clock or final duration. A poll that changes no displayed field writes no DOM; a PID or output change rewrites only its cell.
- Only registry state `running` qualifies. `unknown`, `orphaned`, `exited`, `failed` and `cancelled` leave when observed, regardless of exit code. Retained history remains in Lane Metrics and `#bg`; the lane-head chip counts running jobs.
- Show up to three running jobs, newest-started first. Only when more qualify does an extra `+N more` line appear, carrying the semantic keycaps for `⌘P` then `=` Lane Metrics.
- At narrow widths (strip container ≤ 480px), keep the state visible and drop the `BACKGROUND` label so the command keeps its room; ellipsize command and tail with full strings in `title`. Move the tail to a second line only if needed; no horizontal page overflow or fixed-width table.
- Use existing material/ink tokens and flat rows separated by a groove. No nested cards, colored outlines, infinite spinner/animation or new theme token. Only LEDs may glow. Changing numbers use tabular-nums.

### Data flow and lifecycle

1. Claude adapter checks existing content, then accumulated terminal output, then generic raw-output sections for the existing validated launch marker. The marker must start a line (leading spaces/tabs allowed): the adapter prints it as a line of its own, followed on that line by a notice that it will report completion. Output from a foreground command that only quotes the marker mid-line — for example `grep -n` of a test fixture or `sed` of an indented test — must not register a job. Such a false launch would point at a file that never exists. Retain the absolute-path requirement and exact Claude adapter scope. Do not infer jobs from assistant prose or `run_in_background` alone.
2. Existing `captureBackgroundLaunch()` registers the job once by task ID and immediately patches the shown lane's strip.
3. Existing metrics subscription reads/folds job state and patches the strip even when the lane is idle and the metrics overlay is closed. No new polling interval or timer; a row leaves on the poll that changes its state away from `running`.
4. Switching lanes updates the strip from the selected lane only. Other lanes retain the existing `bg N` header signal; cross-harness/project aggregation is not part of this change.
5. Completion changes only the strip's owning keyed row and existing task chrome. Never unseal/repaint the original tool or assistant message.
6. Lane reset/close and view disposal clear/dispose the strip with their existing owners. Permission/question pre-emption never suppresses it. No change to prompt routing, input focus or actual lane status.
7. OMP Bash launches and direct updates are decoded independently of bounded transcript/tool retention. Capable lanes query scoped job snapshots on the same shared metrics cadence, including idle. Terminal observations are sticky; timeout/disconnect/unavailable observations hide the row without claiming success and remain retryable. Existing subagent cards are unchanged.

`readDeps()` snapshots displayed task scalars/formatted strings, not only the mutable tasks array reference. A poll that changes nothing visible writes no DOM. The component owns attached listeners and disposes keyed children.

## Affected Files

| Files | Change |
| --- | --- |
| `src/acp/components/background-task-strip/` | Compact strip, layered styles and focused behavior coverage |
| `src/acp/components/composer/index.ts` and existing composer tests | Own the child in draft/decision layouts; direct update method |
| `src/acp/acp-harness-view.ts` | Supply active-lane props and patch on launch, metrics and lane switch |
| `src/acp/adapters/claude.ts` and existing decoder tests | Capture launch markers in generic raw-output sections before output display trimming |
| `src/acp/components/registry.ts` | Register owned block |
| `docs/{0004,0005,0302,0305}-*.md`, `docs/README.md` | Document visible placement and amended capture sources; keep overlay/history behavior accurate |

## Acceptance and Verification

- Launch a real harmless detached command in a Claude lane. Without opening an overlay, observe the named running job after its launch call and agent turn have completed; observe log/PID updates and the row leaving after its exit marker. Do not use assistant narration as evidence of job state.
- Browser smoke production components in draft/decision, Zen/normal and concise modes, dark/light, 320px and wide layouts. Exercise running with/without a PID, missing output, no process match, exit 0/nonzero, multiple jobs, lane switching and reset.
- A success or failure leaves the strip on the poll that reads its exit marker; unknown and orphaned jobs leave when their states change. Another running job remains visible beside any task that has ended.
- A poll that learns nothing new writes no DOM, however much time has passed; a changed output line rewrites only that row's output cell.
- Decoder regression: launch text quoted mid-line in content, terminal output or raw output registers nothing; the adapter's real launch line, including its trailing notice, and a fenced launch still register.
- Confirm draft focus/text and transcript scroll/node identity survive updates. Repeated equal updates write no DOM; in-place task-field changes update the strip.
- Decoder regression covers raw-output launch capture, existing content/terminal paths, deduplication and another backend's identical text staying outside Claude capture. Permanent tests cover behavior/state transitions, not CSS-source or markup snapshots.
- Keep native-runtime proof distinct from browser smoke. If the running app has not loaded this code, report that limit instead of claiming the user's native surface was verified.

### Historical verification (2026-11-11, before spec 397)

The observations in this section describe the earlier presentation; the current active-only contract is above and in spec 397.

- Frontend type-check and six focused suites passed (101 tests). After correcting per-lane registry ownership, the final Harness integration suite passed (17 tests), including deduplication, idle completion, lane isolation, reset visibility and sealed-row protection.
- Browser smoke mounted the production `AcpHarnessView` and real decoder. A harmless detached `/bin/sh` process wrote a real local log; a temporary browser IPC bridge supplied its file status and observed process metadata to the existing metrics path. The idle Claude-shaped lane showed `RUNNING`, then `DONE · exit 0` and `Build complete`, with no overlay.
- During that run the sealed row had zero observed mutations, its node and scroll position stayed unchanged, and draft text, input node and focus were preserved.
- 72 browser layout combinations covered dark/light material schemes, 14px/24px body fonts, 320px/1100px widths, normal/Zen/concise styling and draft/permission/question branches. The strip remained visible, contained its width and capped unsettled rows at three with an explicit remaining count.
- Additional browser transitions covered failure exit 7, switching to an empty lane and back, and clearing the lane registry. Component regressions cover missing output/no process match and in-place state changes.
- Inspection found `LANE_DEFAULTS.backgroundTasks` was shared by newly created lanes. `createLane()` now allocates a fresh registry alongside its other per-lane mutable containers. Restart/fresh-session paths clear their registry; no task-liveness heuristic changed.
- This is browser/runtime-log proof, not a relaunched native Tauri app or a fresh live Claude SDK launch. The running installed app was not restarted or replaced.

### Historical revision verification (2026-11-11, before spec 397)

- Trigger: the strip kept a `DONE · exit 0` row indefinitely and a head line above it, and showed rows that never settled. Those rows were foreground `grep`/`sed` calls whose output quoted the launch text from a fixture or test mid-line; their "output file" never existed, so they stayed `OUTPUT UNAVAILABLE` with an elapsed clock that changed on every poll.
- A real Claude Code background launch was observed to return the marker as the start of its own line, followed by a completion notice on the same line; the anchored pattern reads it, and the trailing `.` is still stripped from the path.
- Three new decoder cases (mid-line quotes in content, terminal output and raw output) fail against the previous unanchored pattern and pass against the anchored one. Full frontend suite and type-check pass.
- Browser smoke mounted the production `Composer` with the real stylesheets at 1100px and 320px: one job takes 25px of height (previously about 55px with the head line), the overflow line appears only past three rows, nothing overflows horizontally, and at 320px the label is dropped so commands stay legible.
- A capture of the installed app's window showed the strip's text changing on each ~2 s poll while the transcript's pixels stayed identical across all 43 frames. The window was off-screen, so this proves the poll rewrote the strip, not that the user-visible flicker came from it; with no live clock and per-cell writes, an unchanged job now writes no DOM at all. The installed app has not loaded this code; native confirmation needs a rebuild.

## Open Questions

None. Placement is the persistent composer strip, not a live transcript card.

## Out of Scope

Stopping/restarting jobs, a full log viewer, native notifications, app-restart recovery, a new ACP terminal capability, backends other than Claude and spec-398 OMP Bash, cross-harness aggregation, guessed jobs from prose, changing Claude liveness heuristics, and unrelated header restyling. OMP subagent/eval cards remain unchanged.

## Resources

- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) — background controls and distinction between `/tasks` and the to-do checklist.
- Specs 305/301/302/380/377 and the existing implementations named above — registry, log reader, component ownership, adapter boundary and persistent-strip precedent.
