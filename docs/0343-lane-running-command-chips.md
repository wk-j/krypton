# Lane Running-Command Chips — Implementation Spec

> Status: Implemented (2026-10-29)
>
> Deviations from the approved draft, all narrower or more precise:
> 1. The view regression test lives in `src/acp/components/harness-integration.test.ts`, not
>    `acp-harness-view.test.ts`. It drives the real `AcpHarnessView`: `#push` with a pending
>    `xenon_push` shows no chip before 500 ms, then `#push review · 0:00`. The 1 Hz clock moves
>    that same chip to `0:01`, the Zen meta line reads `#push review`, and both clear once the
>    push settles.
> 2. `CommandRunTracker` also has `hasLane()` (the 1 Hz tick skips lanes with no run) and
>    `clear()` (view dispose). Its clock reads `Date.now()` per call, so a fake clock reaches it.
> 3. Regression tests were added to the controllers:
>    - `#rails now` settles only once its run is recorded (`harness-rails-controller.test.ts`).
>    - `start` reports a refusal, and `whenDone` settles only at the loop's end
>      (`harness-review-loop-controller.test.ts`).
>
> Amended 2026-10-31: a dock action button is a command run too. That covers the Rails Actions bar
> (spec 344), the Ticket Panel's issue actions (spec 342) and the Rails dock's `r` key. Each one
> enters at `trackCommandRun`, the same wrap `submitLanePrompt` uses, so a click shows the chip of
> its typed command. See §Dock action buttons.
> Date: 2026-10-29
> Milestone: ACP Harness — lane chrome
> Amends: [0302](./0302-harness-component-catalog.md) §4.2 `LaneHead`, §4.5 `RailEntry`

## Problem

A built-in `#` command that does its work in the harness, not in an agent turn, leaves its lane
reading `idle` while it runs: `#e2e run` (minutes), `#push` (Xenon upload), `#resume list`
(~5 s Xenon listing), `#dispatch-github-issue` (`gh` fetch + lane spawn), the `#daily` evidence
build, the `#e2e status` / `case` / `report` gather, `#rails now`, and the dispose window of `#new`
/ `#restart`. The only feedback is a composer flash that clears after 2 s. Commands that do flip the
lane to `busy` with a label (`#review`, `#handoff`, `#wiki`, …) show that label only in the
**active** lane's composer chip; every lane head, collapsed row and Zen rail entry says `busy`.

## Solution

Treat each `#` command invocation as a **command run** that lives from the moment
`runHashCommand` starts until the work it started has settled. Show a lane's runs as chips at the
front of its head chip strip — `#e2e run login · 2:14` — on every lane, active or collapsed, and
as the meta line of its Zen rail entry. One wrap point, around the `runHashCommand` call in
`submitLanePrompt`, covers every command and leaves `runHashCommand` itself unchanged. A
command that ends in an agent turn awaits that turn already (`client.prompt` resolves at turn
end), so its chip stays up for the whole turn. The two commands whose work outlives their branch,
`#rails now` and `#review pass`, await that work inside the branch. A run is shown only after
500 ms, so instant commands (opening a page, toggling a mode) never flicker.

Lane status does not change. An idle lane running `#push` still takes prompts and drains peer
mail. The status word says what the agent is doing; the chip says what the harness is doing for
this lane.

## Research

- **Reproduced.** A throwaway vitest called `runHashCommand` with `#push` on a prototype double
  whose `runXenonPush` never resolved. Mid-upload, `lane.status` was `idle`,
  `lane.activeSystemLabel` was `null`, and a `LaneHead` for that lane read `idle` with no
  `#push` anywhere in its text.
- **Dispatch.** Every `#` command reaches `AcpHarnessView.runHashCommand`
  (`acp-harness-view.ts:11703`) through `submitLanePrompt` (`:8450`). That method has three
  callers: the composer (`:8426`), the orchestrator console seat (`:6226`) and the follow-up `run`
  action (`:10006`). There is no submit lock, so commands can overlap.
- **Existing label.** `lane.activeSystemLabel` is set by `beginSystemTurn` (`:2505`) via
  `enqueueSystemPrompt` / `reserveCommandTurn`, and cleared when the lane leaves `busy` (`:1772`).
  Its only renderer is the busy chip built in `composerStatusChip` (`:13668-13676`). It is one
  string per lane and exists only while the lane is `busy`, so it cannot describe `#e2e run`
  running beside an ordinary turn.
- **Settling.** `AcpClient.prompt` awaits `acp_prompt`, which returns the turn's `stopReason`
  (`client.ts:207`). A subprocess exit clears the pending map (`acp.rs:1723-1733`), so a disposed
  lane's prompt rejects instead of hanging. `#review`, `#polly`, `#debby` and `#salty` await
  `dispatchTurn`. `#dispatch-github-issue` sends to the new lane with `void` (`:7449`), so its run
  ends once the lane is spawned.
- **Background work.** `#rails now` starts `startRun` and returns (`harness-rails-controller.ts:241,381`).
  `#review pass` returns after round 1 starts; the loop leaves `loops` only in `drop`
  (`harness-review-loop-controller.ts:505`). `#e2e run` / `run all` / `rerun` await `e2e_run`
  (`harness-e2e-controller.ts:112-155`), so the wrap point covers them as they are.
- **Precedent.** Spec 342 keeps per-lane `runningActions` for Ticket Panel buttons
  (`harness-ticket-controller.ts:74-79`). It answers a different question (which button is running)
  and stays as is.
- **Alternatives rejected.**
  - *Reserve the lane* (`reserveCommandTurn`) for every harness-side command. That flips `busy`,
    which blocks peer drain and queues the user's prompts for the minutes `#e2e run` takes, and it
    claims the agent is working when it is not.
  - *A right-rail "actions" panel* like the queue card. The rail exists only on the active lane, so
    collapsed lanes would still read `idle`, and a status signal would need `#panels` and titlebar
    plumbing.
  - *Show it in the activity tail* (head column 5, `1fr`). That track is the first to shrink to
    zero on a narrow window or a chip-heavy active head, which would hide the one signal being
    added.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| VS Code | Background progress is a status-bar item: a loading icon (optionally spinning) plus short text. Progress that needs attention moves to a notification. | Short labels; one item per operation. |
| Zed | `activity_indicator` shows one spinner item. Its message is the work title, then `: message`, then ` + N more` for the other pending work (`activity_indicator.rs:409-437`). Git jobs are shown only after `GIT_OPERATION_DELAY`. | First item plus a count, and a reveal delay. |
| Krypton (today) | The busy chip names a labelled turn (`reviewing · 0:41`) in the active composer only; `!shell` sets `pendingShellId`, which the peek card shows as "shell running". | Per-command, active lane only. |

**Krypton delta.** Same pattern as VS Code and Zed: short label, live elapsed time, first items
plus `+N`, a reveal delay. The difference is placement: it is per lane, not per window, because a
harness is many independent agents and the question is *which* lane is running *what*. It is
display-only. Each command keeps its own cancel (`#cancel`, `#e2e cancel`, `#review stop`).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-command-runs.ts` (new) | `CommandRunTracker`, `commandRunText`, `COMMAND_RUN_REVEAL_MS` |
| `src/acp/harness-command-runs.test.ts` (new) | reveal threshold, ordering, `end()` visibility, `dropLane`, redaction, truncation |
| `src/acp/acp-harness-view.ts` | wrap the `runHashCommand` call in `submitLanePrompt`; tracker + reveal timers; `runs` in `laneShellProps` / `railEntryProps`; 1 Hz tick; drop on lane close; clear timers on dispose; `#rails now` / `#review pass` branches await their work |
| `src/acp/components/lane-shell/index.ts` | `runs` prop forwarded to `LaneHead` |
| `src/acp/components/lane-head/index.ts`, `lane-head.css`, `lane-head.test.ts` | run chips lead the chip strip; `acp-harness__lane-run` block |
| `src/acp/components/rail-entry/index.ts`, `rail-entry.css`, `rail-entry.test.ts` | meta line shows the run in place of the status word; `acp-harness__rail-meta__run` element |
| `src/acp/harness-rails-controller.ts` | `requestRun` returns the started run's promise or `null`; `#rails now` awaits it |
| `src/acp/harness-review-loop-controller.ts` | `start` returns whether a loop started; `whenDone(laneId)` resolves in `drop` |
| `src/acp/components/harness-integration.test.ts` | a pending `#push` shows its chip after 500 ms, ticks in place, shows on the Zen meta line, and loses both when it settles |
| `src/acp/harness-rails-controller.test.ts`, `src/acp/harness-review-loop-controller.test.ts` | `#rails now` lasts until its run is recorded; `whenDone` settles only at the loop's end |
| `docs/0302-harness-component-catalog.md`, `docs/0072-acp-harness-view.md`, `docs/0005-data-flow.md`, `docs/README.md` | props, example UI, lane-head description, data flow, index row |

## Design

### Data Structures

```ts
// src/acp/harness-command-runs.ts
export const COMMAND_RUN_REVEAL_MS = 500;

export interface CommandRunView {
  readonly id: number;
  readonly text: string;    // '#e2e run login' — redacted, ≤ 28 chars
  readonly elapsed: string; // formatElapsed(now - startedAt): '2:14'
}

/** `#xenon token <secret>` → `#xenon token`; anything else is the trimmed
 *  command text, whitespace collapsed, cut to 28 chars with `…`. */
export function commandRunText(commandText: string): string;

export class CommandRunTracker {
  constructor(now?: () => number);
  begin(laneId: string, commandText: string): number;
  /** Removes the run. True when it was past the reveal delay (caller re-renders). */
  end(id: number): boolean;
  dropLane(laneId: string): void;
  /** Runs at least COMMAND_RUN_REVEAL_MS old, oldest first. */
  visible(laneId: string): CommandRunView[];
  readonly size: number;
}
```

Redaction is an allowlist of argument-bearing secrets: today only `#xenon token`. Its draft is
already cleared before the async work so a pasted token never lingers (`acp-harness-view.ts:11870-11872`);
the chip must not undo that.

### Data Flow

```
1. Enter on `#push` → submitLanePrompt(lane, '#push')
2. submitLanePrompt: id = beginCommandRun(lane, text) → commandRuns.begin(lane.id, text);
   arm a 500 ms reveal timer; updateComposerTick() (the 1 Hz clock now also runs while any
   run exists)
3. try { await runHashCommand(lane, text) }   // unchanged, so its existing tests still call it directly
   finally { endCommandRun(id) }
4. Reveal timer fires (run still live) → invalidate('rail') → renderDashboard →
   laneShellProps(lane).runs = commandRuns.visible(lane.id) → LaneHead paints the chip;
   Zen: railEntryProps(lane).runs → RailEntry writes the run into its meta line
5. Each 1 Hz tick: for every lane with runs, shell.update(laneShellProps(lane)) (the
   refreshMetricsRender path). LaneHead's chip deps include the elapsed string, so a tick
   writes one chip and nothing else.
6. endCommandRun: clear the reveal timer; if end() returned true → invalidate('rail');
   updateComposerTick()
```

`#rails now` branch: `const run = this.requestRun(lane); if (run) await run;`. `run` is the
`startRun` chain, which already catches, so it always resolves. If a run is already in progress,
`requestRun` returns `null` and the invocation ends at once.

`#review pass` branch: `if (await reviewLoopCtl.start(lane, args)) { this.render(); await
reviewLoopCtl.whenDone(lane.id); }`. `start` returns `false` on every bail, including "loop
already running", so a second invocation never attaches to the first loop. `whenDone` is a
promise created with the loop and resolved in `drop`, the loop's single exit.

#### Dock action buttons

`trackCommandRun(lane, text, work)` holds steps 2, 3 and 6: begin the run, `await work()`, then
end it in `finally`. `submitLanePrompt` calls it with `runHashCommand`. The Rails and Ticket hosts
expose it too, so a button runs inside the same run as its typed command:

| Trigger | Run text | `work` |
|---------|----------|--------|
| Rails Actions bar button, Rails dock `r` | `#rails <verb>` (`now`, `send`, `trust`, `update`) | `runCommand(lane, [verb], text)`: the typed sub-command, so `#rails now` lasts until its run is recorded |
| Ticket Panel issue action | `#<verb>` (`#analyze-github-issue`, …), the verb typed with no reference | `runGithubIssuePromptVerb(lane, verb, [issueUrl])` |

The lane is the active lane. With no active lane, Rails Run and Trust still act and no chip is
shown, because a run has no lane to show on. A click never goes through `runHashCommand`, which
would clear the lane's composer draft.

### UI Changes

- **Lane head.** Run chips lead `.acp-harness__lane-chips`, in front of the inbox chip. At most
  2 chips are shown. Further runs fold into a `+N` chip, whose title lists their texts. Chip text
  is `#e2e run login · 2:14`, and its title is `running #e2e run login · 2:14`. Chip keys are
  `run:<id>` and `run-more`. No head grid change: column 4 is `max-content`, so the chips are never
  squeezed out; the `1fr` activity tail gives way first.
- **Zen rail entry.** The run goes on the **meta line**, not the head line. The head line has no
  room: the rail is `clamp(180px, 14vw, 240px)` (`harness-shared.css:1350`), which leaves a body
  column of 110–170 px after the entry's margins, padding, dot and logo (`rail-entry.css:20-27`).
  Name + tool count + context count already take about 111 px. A `#e2e run login` chip needs about
  106 px with its gap. (Widths are estimated at a 0.6 em monospace advance and 13 px base.) The
  meta line holds only the status word (`idle`, about 26 px), so it has 84–144 px to spare.
  - While a run is visible, the run text **replaces the status word**: `#e2e run login`, or
    `#e2e run login +1` with more. The status dot still shows busy/idle (`rail-entry.css:235-238`).
  - Plain text in the lane accent, with no pill and no elapsed time. A pill's padding would
    change the meta row height, which spec 125 keeps constant across lanes. The run is
    `flex: 0 1 auto; min-width: 6ch` with an ellipsis, so it shrinks first but never vanishes.
    Anything past the meta width is clipped, as the meta row does today.
  - The permission/question hint of a `needs_permission` lane wins over a run, because the lane
    needs the user.
  - On a directive-bound lane the run replaces the directive **title**. The role tag and the
    `· next send` / `· clear next send` hint stay.
  - It updates only on `rail` renders, which reveal and end already trigger.
- **CSS.** New `.acp-harness__lane-run` in `lane-head.css` (block added to the lane-head `def`) and
  `.acp-harness__rail-meta__run` in `rail-entry.css`, both in `@layer krypton.component`. The head
  chips follow the head's flat chip language (`lane-head.css:110-112`: "a faint tinted pill, no
  border"). They use the same pill as the spec-305 `bg N` chip, which already marks detached work
  on an idle lane: `padding: 1px 6px`, `0.72em`, radius `var(--krypton-border-radius)`. Tint and
  text are the lane accent (`--acp-lane-ink`, falling back to `--acp-lane-accent`), so a run reads
  as this lane's own work, not a warning. There is no animation: the ticking clock is the liveness
  cue, and the head's status symbol keeps the only spinner.

### Covered commands (examples)

| Typed | Chip shows while | Ends at |
|-------|------------------|---------|
| `#push review` | `xenon_push` upload | upload result |
| `#e2e run login` | adapter run | verdict row |
| `#resume list` | `xenon_handoff_list` | picker opens (the picker itself is user-paced, no chip) |
| `#handoff` | the handoff turn | turn end |
| `#review pass 3` | every round, fix and summary | loop `drop` |
| `#rails now` | checks + judge | run recorded |
| `#home`, `#panels hide plan` | — (settles < 500 ms) | — |

### Keybindings

None. The chip is a status readout, like the busy symbol. Each command keeps its own cancel.

## Edge Cases

- **Overlapping commands** on one lane: each has its own run, ordered oldest first.
- **Guarded rejections** (`lane busy - #cancel first`) settle in milliseconds and are never shown.
- **User-paced modals awaited inside a branch** (`#review-thread` base picker): the chip counts
  the picker time too. The modal covers the lane, and the run is genuinely in progress.
- **Lane closed mid-run:** `dropLane` on `lane:closed`; the later `end(id)` is a no-op.
- **Restart mid-turn:** the old prompt rejects on subprocess exit (see Research), so the branch
  settles and the run ends.
- **View disposed:** reveal timers are cleared; the 1 Hz interval already stops in dispose.
- **Throw inside a branch:** `finally` ends the run; the error path is unchanged.

## Out of Scope

- `!shell` commands. They are not built-ins, and the peek card already shows "shell running".
- Telemetry, the loopback lane monitor, Telegram, live-assist and the control API `lane.status`.
  None of them show `activeSystemLabel` today either.
- `flashChip` hiding the busy verb for 2 s (`composerMetaProps`, `acp-harness-view.ts:13431`).
- Detached work started without awaiting: `#assist now` (has its panel), `#ticket <ref>` GitHub
  enrichment, `#usage flush` outbox, `#live` after connect (has its strip).
- Per-run progress detail (`checking 2/5 lint`) and cancel-from-chip.

## Resources

- [VS Code UX Guidelines — Status Bar](https://code.visualstudio.com/api/ux-guidelines/status-bar) — the discreet progress item: loading icon plus short text; notification only when progress needs attention.
- Zed `crates/activity_indicator/src/activity_indicator.rs` (local `/Users/wk/Source/zed`, lines 28, 385-473) — one spinner item, ` + N more` folding, and a reveal-delay constant for git jobs.
- Internal: specs 156 (lane activity), 221 (status-line density), 301/302 (component kernel and catalog), 342 (Ticket Panel `runningActions`).
