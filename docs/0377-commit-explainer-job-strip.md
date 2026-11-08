# Commit Explainer Job Strip — Implementation Spec

> Status: Implemented
> Date: 2026-11-08
> Milestone: Git — learning from history
> Builds on: 0375 (Commit Browser) · 0376 (Commit Explainer Background Job)

## Problem

The Commit Browser preview shows a running explainer job as one sentence in the status lamp window
(`EXPLAINING · CODEX · GPT-6.1-SOL[HIGH] · SINCE 19:24 · READ FILE '/USERS/WK/.AGENTS/…/SKILL.MD'`).
The window uppercases every word, so a case-sensitive path prints wrong. It wraps to two lines of
glowing glass above the commit subject, and each tool call changes its height and moves the subject.
It shows only the latest tool title, which stays on screen after that tool has finished, and it gives
no sense of how far the job has got.

## Solution

The lamp window keeps the state word only (`queued`, `explaining`). Everything else about the job
moves into an **explainer strip**: a fixed part of the preview between the commit message and the
key foot. The strip has an engraved `EXPLAINER` label with the backend, model, start time and step
count, a "now" line saying what the agent is doing (a steady lit LED, the tool kind, the path or
command in its own case), and the three steps before it. `CommitExplainer` records
steps from `tool_call` / `tool_call_update` and a phase from the thought and message chunks. A job
update repaints only the strip, never the commit message.

## Research

- **Cause.** `jobStatus()` (`commit-browser-view.ts:748-756`) joins state, backend, model, start time
  and `job.activity` into `.commit-browser__status`, a lamp window set in 11px/700 with
  `text-transform: uppercase` (`commit-browser.css:295-316`). DESIGN.md: a lamp window holds a
  **status word** ("uppercase for a state word"). A sentence with a path does not belong there.
- **Activity is the raw title.** `fence()` sets `job.activity = event.call.title`
  (`commit-explainer.ts:361-363`). `tool_call_update` is ignored, so a finished tool still reads as
  current; thought and message chunks are ignored, so after the first tool the line never returns
  to `thinking`.
- **Every update rebuilds the whole preview.** `onExplainChange` → `renderPreview()` →
  `previewEl.replaceChildren(...)` (`commit-browser-view.ts:298-305, 806`): subject, meta and body
  are rebuilt on each tool call.
- **In-repo vocabulary to reuse.** `inferToolLabel` + `toolChipKind` (kind: read · edit · search ·
  execute · fetch · move · delete · other) and `buildToolPayload`'s subject rule (`command || path ||
  title`, `harness-tool-render.ts:475-484`); `extractModifiedPath` reads diff paths and
  `locations`. `loadHomeDir()` (`harness-format.ts:60`) gives HOME. The Harness `SubagentCard`
  already shows a background agent as an activity line, its last three tools (`RECENT_TOOLS = 3`,
  `harness-subagents.ts:30`) and a tool count.
- **DESIGN.md rules that apply.** "Indeterminate work shows a steady lit lamp and a label saying
  what is running." Tool kind labels are flat ink. No shadow, text-shadow or gradient on a repeated
  row; only a lamp glows. No infinite animation. Every changing digit is tabular-nums. The preview
  is one screen well with no nested panel (spec 0375), so the strip is set off by a groove, like
  the foot.
- **Ruled out:**
  - *A longer lamp window with `text-transform: none`:* it is still a sentence in a status
    window, still wraps, and still glows across the preview.
  - *The strip above the subject:* the subject moves whenever the strip changes height.
  - *The strip inside the scroll area:* a long commit body pushes it out of view.
  - *A full step log:* the job runs for minutes and calls dozens of tools; a log needs scrolling
    and the transcript already lives in the ACP process. Four steps and a count tell the user that
    it is moving and where it is.
  - *An elapsed timer:* spec 0376 chose a start time so nothing repaints on its own.
  - *`abbreviatePath` (`~/.../humanize-thai/SKILL.md`):* it hides directories; the strip keeps the
    whole path and lets CSS cut the end, with the full text in `title`.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| GitHub Copilot cloud agent | The agents panel lists sessions; a session log shows the agent's reasoning and the tools it used. Stop is a button in the log viewer. | Full log, web page. |
| agent-pulse (Claude Code mod) | One card per subagent: a status word in a border of the state colour, elapsed time, and `Using Grep` / `Last tool: Read`. | Status word apart from the activity line. |
| Krypton `SubagentCard` (spec 282/302) | Activity line, `↳` last three tools, tool count. | Same shape, inside a Harness row. |
| Krypton `ToolRow` | Flat-ink kind label, then the command, path or title. | Kind + subject vocabulary. |

**Krypton delta:** like agent-pulse, the state word and the activity are separate parts. Like
`SubagentCard`, a few recent steps and a count stand in for the full log. The strip stays a few
fixed lines in the preview, shows a start time instead of a ticking timer, and keeps paths in their
own case.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-tool-render.ts` | Export `toolSubject(call): { kind, command, subject }` taken out of `buildToolPayload`, which calls it |
| `src/commit-explainer.ts` + `.test.ts` | `ExplainJob.activity` → `phase`, `steps`, `stepCount`, `continuations`; the fence records `tool_call`, `tool_call_update`, `thought_chunk`, `message_chunk`; subject shortening |
| `src/commit-browser-view.ts` + `.test.ts` | Status word only; the explainer strip; a job update repaints only the strip; `jobStatus()` removed |
| `src/styles/commit-browser.css` | Preview split into scroll area + strip + foot; strip, step and fault-lens rules |
| `docs/0376-…`, `docs/0375-…`, `docs/0004-architecture.md`, `docs/README.md` | Amend the job model and UI; index row |

## Design

### Data Structures

```ts
export type ExplainPhase = 'starting' | 'thinking' | 'replying' | 'continuing';
export type ExplainStepState = 'running' | 'done' | 'failed';
export interface ExplainStep {
  readonly id: string;     // toolCallId
  kind: string;            // toolChipKind(inferToolLabel(call))
  subject: string;         // shortened command / path / title, own case, first line, ≤ 200 chars
  state: ExplainStepState; // pending | in_progress → running; completed → done; failed → failed
}
export interface ExplainJob {
  readonly root: string; readonly repoName: string; readonly sha: string;
  state: ExplainState; startedAt: number | null; backend: string | null; model: string | null;
  phase: ExplainPhase | null;  // null while queued
  steps: readonly ExplainStep[]; // the last EXPLAIN_STEPS_KEPT, oldest first; replaced, never mutated
  stepCount: number;           // every tool call since the job started
  continuations: number;       // continuation turns after a declined approval (0–3)
}
export const EXPLAIN_STEPS_KEPT = 4;
```

**Subject shortening** (`jobSubject(text, { root, scratch, home })`, pure): a path under the repo
root becomes repo-relative (`src/a.ts`), a path under the scratch dir becomes scratch-relative
(`explainer.md`; macOS also reports the temp dir as `/private/var/…`, which counts too), and HOME
becomes `~` in paths and commands. Nothing is lowercased.

### Data Flow

```
1. run(): phase 'starting' → setup done → phase 'thinking' → emit
2. tool_call      → step by toolCallId (new: push, stepCount += 1, drop the oldest past 4; phase
                    'thinking', the state once that tool ends; a kept id merges as in 3) → emit
3. tool_call_update for a kept step → merge (mergeToolCall), new kind / subject / state → emit if changed
4. thought_chunk  → phase 'thinking';  message_chunk → phase 'replying'  → emit only when it changes
   (a chunk with parentToolUseId belongs to a subagent and is ignored)
5. declined approval ends the turn → continuations += 1, phase 'continuing' → emit
6. view, any non-ready change in its repo:
   the shown commit's job appeared, changed state or ended → renderPreview(); else, when the
   shown commit has a job → paintStrip() only (another job's change can move its queue position)
```

### UI Changes

```
cb570c27faf6291283229f51393fb0825dbeb7df  [● EXPLAINING]
style(harness): drop the green edge from done dock-action keys
wk · 2026-11-08 00:00 · 1 file · +0 −2
A done key keeps its green backlight and legend on the plain key edge.
                                     ↑ scroll area: only this part scrolls
─────────────────────────────────────────────────────────── groove
EXPLAINER    codex · gpt-6.1-sol[high] · since 19:24 · 14 steps
● read       ~/.agents/skills/humanize-thai/SKILL.md
○ execute    git -C ~/Source/krypton show --stat cb570c2
○ read       src/styles/commit-browser.css
● search     rg -n "dock-action" src/acp              (red lens: failed)
─────────────────────────────────────────────────────────── groove
x cancel   d diff   y copy sha
```

- **Lamp window** (`.commit-browser__status`): `queued` or `explaining`, amber; `explained` and
  `not explained` unchanged. It never holds anything but the state word.
- **Preview** becomes a column: `__preview-scroll` (sha row, subject, meta, body; `overflow: auto`)
  · `__job` (the strip, only while the selected commit has a job) · `__preview-foot`. The strip and
  the foot never scroll, so a long commit body cannot hide them, and the strip growing from two to
  five lines shrinks the scroll area without moving the message.
- **Strip** (`.commit-browser__job`): a groove on top, no well or plate of its own.
  - Head: the engraved label `EXPLAINER` (11px/600/`0.13em`, silk), then the meta in ink-3,
    tabular-nums, cut with an ellipsis first: `codex · gpt-6.1-sol[high] · since 19:24 · 14 steps`.
  - Now line (`__step--now`): the newest running step, or the phase when none is running —
    `starting codex`, `thinking`, `writing the reply`, `approval declined · continuing (1 of 3)`.
    LED lit amber; kind in `--mat-lit`; subject in `--krypton-fg`.
  - Trail: the other kept steps, newest first, at most three. LED unlit when done, lit amber when
    still running (parallel calls), a red lens when failed. Kind and subject in ink-3.
  - Queued: the head and one now line, LED unlit: `waiting for a free slot · 2 ahead` (or
    `next in line`).
  - A step row is a grid `6px 8ch minmax(0, 1fr)`; the subject is one line with an ellipsis and
    its full text in `title`. Rows have no shadow or gradient; only the LEDs glow.
- LEDs reuse `.commit-browser__lamp` (unlit) and `--pending` (amber); `--fault` is new, from
  `--krypton-danger-rgb`.

## Edge Cases

- **Parallel tool calls:** the now line is the newest running step; the others stay in the trail
  with lit LEDs until their updates arrive.
- **Update for a dropped step** (older than the last four): ignored; the count is unchanged.
- **Huge subject** (a heredoc command): first line, cut at 200 characters when recorded.
- **Title with no command or location** (`Read file '/Users/…/SKILL.md'`): shown as given, HOME →
  `~`, case kept.
- **Turn cancelled after a declined approval:** codex fails its open tool calls, so those steps show
  red, and the now line reads `approval declined · continuing (n of 3)`.
- **Browser opened mid-job:** the job carries its steps, so the strip shows them at once.
- **Cancel (`x`) or finish:** the job leaves `jobs`, the next `renderPreview()` drops the strip.
- **Narrow preview (260px minimum):** the meta and subjects cut with an ellipsis; the label, LEDs
  and kinds keep their width.

## Open Questions

None. Decisions taken: the strip sits under the message and above the foot; four steps are kept
(the now line plus three); the meta keeps the start time, not a timer.

## Out of Scope

Keeping a failed job's message in the preview after the toast, a full step log or opening the
job's transcript, an elapsed timer, the Assistants dock row, and `#learn` lanes (they run in a
Harness lane with its own transcript).

## Resources

- [GitHub Docs — Managing agent sessions](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/track-copilot-sessions) — session list plus a log of reasoning and tools; stop from the log viewer
- [agent-pulse](https://claude-mods.com/agent-pulse/) — status word kept apart from the `Using Grep` / `Last tool: Read` activity line
- [codex-acp dev readme](https://github.com/agentclientprotocol/codex-acp/blob/main/readme-dev.md) — a stopped prompt marks its open tool calls failed
