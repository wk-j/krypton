# OMP Background Subagent Jobs — Implementation Spec

> Status: Implemented (approved 2026-11-07: "Yes go")
> Date: 2026-11-07
> Milestone: ACP Harness
> Builds on: 282 (subagent cards) · 301 (component kernel, constraint 10) · 302 §3.4–3.5 (`ToolRow`, `SubagentCard`) · 315 ("last reported" background snapshot)

## Implementation Deviations

- **Last-reported marking runs on every way a turn ends without more OMP frames.** Besides
  `finishTurn` and the session-picker load, it runs when `session/prompt` itself fails
  (`sendUserPrompt`) and when a force restart reconnects, because the killed process took its jobs
  with it. It only replaces payloads and calls `scheduleStreamingBodyOnly`, the same pass
  `sealStreaming` schedules. No direct `rowFor().update()` is needed.
- **Only a frame that carried `rawOutput` routes jobs to cards.** A status-only update re-parses the
  retained snapshot for the `wait` row itself, but sending it to cards again would clear
  `lastReported` with stale data. A `wait` row whose retained snapshot was compacted away keeps its
  previous `jobs`.
- **`background` also closes inside `parseOmp`** once no visible agent is pending or running, so a late
  `async.state: "running"` frame cannot reopen a settled card.
- **`output` falls back to the `<error>` body** when an envelope has no `<output>` or `<preview>`. This
  covers a failed job's `errorText`.
- **The `wait` row is recognised from its first snapshot.** The initial `tool_call` frame carries no
  `rawOutput`, so for one frame (about 50 ms on the wire) the row still shows the intent as its chip.
- **The job list uses the subagent card's well and LEDs** (spec 366 faceplate materials), not a 1px
  border.

## Problem

OMP 18.x spawns subagents asynchronously: `task` returns at once, the agents run as background jobs,
and the parent follows them with `wait`. The harness shows this badly:

- **The spawn card lies.** It drops back to `○ pending` right after spawning. While the agents run, the
  stats stay at `0 tools · 0 tok`. The OUTPUT detail never fills in. If the parent ends its turn
  before the jobs finish, the card stays `● running · background` forever.
- **The `wait` row is raw text.** The two content blocks are joined with a space, so
  `<system-notice>` ends up glued to the job line. Markdown (`##`, backticks) is shown literally.
  Blank lines are removed, and the output is cut at 6 lines and 140 cells.

## Solution

Read the job state from OMP's structured `rawOutput.details` and ignore the prose meant for the
model. This touches the spawn card, the `wait` row, and the turn boundary:

1. **Spawn card.** Merge OMP updates monotonically, so status and counters never go backwards. Keep the
   card live while its agents run in the background, even after the spawn row is sealed. The head
   keeps the spawn's terminal glyph.
2. **Job snapshots feed the cards.** Every `wait` update has a `details.jobs[]` snapshot. Each `task`
   job is matched to its card entry by agent id. The snapshot supplies status, duration, and the
   result text for the OUTPUT detail.
3. **The `wait` row** becomes a compact job list (`JobList`). The `content` text is never rendered.
4. **Turn end.** When a turn ends with agents still running, the card is marked **last reported** and
   sealed, following spec 315. OMP sends nothing after the turn, so the card says so instead of
   pretending to be live.

OMP Bash monitoring is separate under [spec 398](./0398-omp-async-bash-monitor.md). Capable lanes use idle read-only snapshots to settle the composer task strip without changing this subagent-card or `wait`-row contract. Matching Bash entries in `wait` snapshots also update already-known task state when a job ID is unambiguous; absence never means completion.

## Research

**Wire capture.** I drove `omp acp` 18.17.0 directly with a throwaway ACP client: one async
`task` (`sleep 20`) plus `wait`.

- **The spawn call keeps updating after it returns.** Frames: `in_progress` (pending) at 2207 ms,
  `in_progress` (running) at 2208 ms, `completed` at 2208 ms, then more `in_progress` at
  2441–25627 ms, and a final `completed` with `async.state: "completed"` at 25628 ms.
  - The first `completed` frame carries the spawn-time snapshot, so progress is back at `pending`.
  - Late frames report `durationMs: 0` until the end.
  - The final frame has `results: []` and content `Background task Probe complete.`, so it never
    carries the agent's output.
- **`wait`** sends an `in_progress` frame every 500 ms with `details: {op:"wait", jobs}` and empty
  content. Its terminal frame adds the `## Still Running` / `## Completed` text, plus the
  `<system-notice>` block on idle back-off.
  - A completed `task` job carries `resultText`: the `<task-result>` envelope followed by a follow-up
    hint.
  - A job leaves later snapshots once its result has been consumed. Absence means nothing.
- **A detached turn goes silent.** I ended the turn right after spawning and kept listening for 45 s,
  then sent a second prompt. No frame for the spawn call arrived after the turn ended, and none during
  the next prompt. The job had finished at about 25 s. OMP delivers the result as an `async-result`
  custom message, which ACP mode never forwards live (`acp-agent.ts`: no client forwarder outside a
  prompt). On `session/load` it comes back as a `user_message_chunk`.

**Krypton replay.** I replayed the captured frames through `renderTool`'s pipeline
(`mergeToolCall` → `buildToolPayload` → `mergeToolPayloadForUpdate` → `parseSubagentPayload` →
`ToolRow`):

- **Status flicker:** the card goes `● running` → `○ pending` (the first `completed` frame) →
  `● running`.
- **The head re-spins:** the late `in_progress` frames set the head glyph back to a spinner on the
  sealed row.
- **Stats freeze:** they stay at `0 tools · 0 tok` while the wire reports 5747 tokens. The reason:
  after `seal()`, `SubagentCard` repaints only when `subagentStructureSignature` changes
  (`subagent-card/index.ts:237`).
- **No OUTPUT:** settlement paints `✓ … 1 tools · 6k tok · 23s`, but OUTPUT stays empty.
- **The `wait` row:** `rawOutputSections` takes `rawOutput.content`, `stringifyToolValue` joins the
  blocks with `' '` (`harness-tool-render.ts:423`), and `boundedOutputLines` drops blank lines and
  caps the result at 6 lines (`:448`).

**OMP shapes** (tag `v18.17.0`, `tui/tools/wait.ts:46-160`, `async/job-control.ts`):

- **`JobSnapshot`** is `{ id, type: bash|task|eval, status: running|completed|failed|cancelled,
  label, durationMs, exitCode?, resultText?, errorText?, agentUrlId?, … }`. `agentUrlId` is the agent
  id. The job id gets a `-N` suffix only when it collides with a live job row.
- **Other `op:"wait"` results:**
  - `jobs: []`, possibly with `interrupted: true`.
  - IRC peer waits carry `waited` and no `jobs`.
  - `vibe_wait` reuses `op:"wait"` with a different `details` shape.
- **Agent ids are unique per session** (`Reviewer`, `Reviewer-2`, …). In a batch, `details.async.jobId`
  names only the first job, so matching goes through `progress[].id`.
- **OMP's own TUI** renders `wait` from `details.jobs` and reads content only when there are no jobs,
  so the notice is never displayed.

**Alternatives rejected.**

- *Matching on the ACP `name` field* (`"task"` / `"wait"`, sent since OMP 18.13.2). It is not part of
  ACP, `mergeToolCall` drops it, and spec 282 detects by shape.
- *Joining content blocks with `\n` and keeping the generic row.* The row would still show `##` markup
  and the model-facing notice.
- *A lane map from agent id to row.* A scan of at most 300 transcript items per update is cheap and
  needs no eviction bookkeeping.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| OMP TUI | `waitToolRenderer` draws from `details.jobs`. The header reads "waiting on N jobs" or "N jobs settled". Rows are sorted running → failed → cancelled → completed, and show icon, id, status, duration and label. Previews strip the `<task-result>` wrapper. | The `wait` row design follows this. |
| Zed | One card per spawn call, updated only by the same `toolCallId` (`acp_thread.rs:5520-5559`). There is no `wait` and no background agent (`spawn_agent_tool.rs:216` blocks). Each content block is its own Markdown block, with HTML shown literally, so a `<system-notice>` would show. | Nothing links a later call to an earlier card. |
| codex-acp 2.5.0 | `wait` is a separate tool call. The only link to the spawn is the thread ids in `rawInput`. | Linking happens on the client side, by agent identity. |
| claude-agent-acp | Background task frames carry `tool_use_id`, but they are only forwarded to clients that advertise the subagent or async-task capabilities. Krypton advertises neither. | The same agent-identity link. |

**Krypton delta:** same as the OMP TUI, the job state comes from structured details and never from
prose. Unlike any of these apps, a later snapshot updates the earlier spawn card, so one place shows
each agent's state and result.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-view-types.ts` | `SubagentPayload.lastReported`; `JobLine`, `JobsPayload`; `ToolPayload.jobs?`. |
| `src/acp/harness-subagents.ts` | Monotonic OMP merge; `parseOmpJobs`, `applyOmpJobs`, `jobsPayload`; `lastReported` in the signature and summary. |
| `src/acp/acp-harness-view.ts` | `renderTool`: sticky terminal status, the jobs payload, routing jobs to cards. Last-reported marking in `finishTurn` and after both `loadSession` sites. |
| `src/acp/components/tool-row/index.ts` | The card stays live while it runs in the background. A `jobs` render branch and deps. |
| `src/acp/components/job-list/` (new) | `JobList` component, stylesheet, test; registered in `components/registry.ts`. |
| `src/acp/harness-subagents.test.ts`, `components/tool-row/tool-row.test.ts` | The cases listed under Verification. |
| `docs/0282-harness-subagent-cards.md` | Deviations line 13, edge case line 188, Out of Scope line 205 → point to this spec. |
| `docs/0302-harness-component-catalog.md`, `docs/0005-data-flow.md`, `docs/0072-acp-harness-view.md`, `docs/README.md` | `JobList` entry; render precedence gains `jobs`; index row. |

## Design

### Data Structures

```ts
// SubagentPayload gains:
lastReported: boolean;   // turn ended (or replay finished) with agents still pending/running

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export interface JobLine {
  id: string;            // job id, shown
  type: 'task' | 'bash' | 'eval';
  status: JobStatus;
  label: string;         // shown when ≠ id, ≤ 160 chars
  durationMs: number;
  exitCode: number | null;
}
export interface JobsPayload { jobs: JobLine[]; overflow: number; interrupted: boolean } // ≤ 16 jobs
// ToolPayload.jobs?: JobsPayload

// harness-subagents.ts (internal to routing; output never reaches the wait row)
interface OmpJob extends JobLine { agentId: string; output: string } // agentId = agentUrlId ?? id
export function parseOmpJobs(rawOutput: unknown): { jobs: OmpJob[]; interrupted: boolean } | null;
export function applyOmpJobs(payload: SubagentPayload, jobs: readonly OmpJob[]): SubagentPayload | null; // null = unchanged
export function jobsPayload(parsed: { jobs: OmpJob[]; interrupted: boolean }): JobsPayload;
```

`parseOmpJobs` uses a loose TypeBox schema, the same way as spec 282. It accepts
`details.op === 'wait'` with an array `details.jobs`, and each element needs a string `id`, a known
`type` and `status`, and a numeric `durationMs`. Elements that fail are dropped. If none pass and
`jobs` is not empty, it returns `null`, so `vibe_wait` and IRC waits fall back to the generic row.
`output` is the body of `<output>` or `<preview>` inside the `resultText` (or `errorText`) envelope,
else the body of `<error>`, else the raw text. It is bounded like `results[].output` (last 4 KB).

### Rules

- **Monotonic merge for OMP entries.** Applies in `parseOmp` (with a carried card) and in
  `applyOmpJobs`. Status rank is pending < running < terminal, and an entry never moves down. A
  terminal entry keeps its first terminal status. `toolCount`, `tokens` and `durationMs` never
  decrease. `output` is replaced only by a non-empty value.
- **Sticky terminal status.** In `renderTool`, if the row is already terminal and the update's
  `rawOutput.details.async` is present, the row keeps its terminal status. The card payload is still
  re-parsed. No row is reopened, and `toolEndedAt` and `activeToolCount` are unchanged.
- **Settling.** `background` becomes `false` once no entry is pending or running, whether a snapshot or
  `async.state` settled it. Any fresh data clears `lastReported`.
- **Last reported.** In `finishTurn`, after `sealStreaming`, every OMP card in the lane with
  `background && !lastReported` gets a new payload with `lastReported: true`, and a transcript pass is
  scheduled. This does not call `render()`. The same marking runs after a failed prompt, after a force
  restart reconnects, and after `loadSession` resolves in the session picker.

### Data Flow

```
1. tool_call / tool_call_update → renderTool(lane, call)
2. status := sticky terminal (rule above); parseSubagentPayload → monotonic card merge
3. backend omp, no subagents, no redaction:
     parsed = parseOmpJobs(merged.rawOutput)
     tool.jobs = jobsPayload(parsed); tool.kind = 'wait'
     tool.subject = cleanToolTitle(title,'wait'); tool.sections = []
     for each task job: newest transcript item whose tool.subagents (source omp)
       has an entry id === job.agentId → item.tool = { ...item.tool, subagents: applyOmpJobs(...) }
4. scheduleToolRender → commitRegion('transcript') → row.update() per mounted row
5. ToolRow precedence: redaction → subagents → execution → jobs → generic
6. finishTurn / failed prompt / restart / loadSession resolved → mark unsettled OMP cards lastReported
```

### UI Changes

The spawn row (head sealed with `✓`; the card stays live while it runs in the background):
```
✓ [agents] Surveying keyboard hint text surfaces   0/1 done · background
    ● KeyHintInventory  scout  reading tool-row/index.ts   41 tools · 172k tok · 2m 44s
```
After a turn ends unsettled, the summary reads `0/1 done · background · last reported`.

The `wait` row (`JobList`, block `acp-harness__jobs`):
```
✓ [wait]  Waiting for keyboard hint inventory      1 running
    ● KeyHintInventory   task   2m 44s
```

- **Card liveness.** `ToolRow.onSeal` seals the card only when `!background || lastReported`.
  Otherwise `paintBody` keeps calling `card.update()`, which repaints row-level fields while the card
  is live. It seals the card the first time the payload settles or turns `lastReported`. A card mounted
  in an already-sealed row is sealed at creation unless its payload is still live in the background.
- **Head summary.** Counts per status: `N running`, then `N done`, `N failed`, `N cancelled`, joined
  with ` · `. It reads `no jobs` for an empty list and `interrupted` when `interrupted` is set.
- **Job lines.** Glyphs `● ✓ ✗ –` with the same lamp styling as the card. Each line shows the id, the
  type, the label (when it differs from the id), `exit N` for a failed job that reports a non-zero
  code, and the elapsed time. The list is keyed by job id with `reconcile()`; past 16 jobs a
  `+N more` line closes it. A ticking duration repaints only that job's line. The row seals with its
  own terminal status.
- **Styles.** Authored in `@layer krypton.component`, using the subagent card's well and LED parts, no
  corner brackets, `[hidden] { display: none }`, and `--mat-*` tokens only. Text is set via `textContent`.

## Edge Cases

- **A job missing from a later snapshot** (its result was consumed): nothing changes.
- **Job id with a `-N` suffix:** matched through `agentUrlId`. A `bash` or `eval` job, or a task with no
  card in the transcript (evicted or from an earlier session), appears only in the `wait` row.
- **Failed job:** the status comes from the snapshot, and `errorText` becomes the OUTPUT.
- **Cancelled through `write proc://…/kill`:** not routed (see Out of Scope). The card settles if OMP
  sends the spawn call's final `async` frame within the turn. Otherwise it ends as last reported.
- **Late data after last reported:** it clears the flag, but the card is already sealed, so it repaints
  only on a structural change (status, `background`, `lastReported`). The final stats land when the
  card settles.
- **Background lane:** payloads update in memory and paint when the lane is activated.
  Non-OMP backends are untouched.
- **Artifact redaction:** still takes precedence over everything else.

## Verification

- **Unit (`harness-subagents.test.ts`):**
  - The spawn's own `completed` frame with `pending` progress does not regress a running entry.
  - A late `durationMs: 0` does not erase a reported duration.
  - `parseOmpJobs` accepts the captured snapshot and rejects the IRC and `vibe_wait` shapes.
  - `applyOmpJobs` matches by `agentUrlId`, strips the envelope into `output`, settles `background`,
    and ignores absent jobs.
- **Component (`tool-row.test.ts`):**
  - A background card in a sealed row still paints stats.
  - Settling seals the card.
  - A `lastReported` card writes nothing on stats-only updates.
  - The `jobs` branch renders no `<system-notice>` text.
- **Component (`job-list`):** keyed updates touch only the moved line.
- **Smoke:** replay both captured scenarios (wait in turn; detached turn) through the pipeline, then run
  an OMP lane in Krypton that spawns a background agent and waits for it.

## Open Questions

None.

## Out of Scope

- Generic tool rows joining multiple text blocks with `' '` (`stringifyToolValue`). After this spec,
  the `wait` row no longer goes through that path.
- `write proc://<id>/kill` cancel snapshots (`details.proc.op: "cancel"`). They have not been observed
  on the wire.
- Recovering results that OMP delivers as `async-result` messages outside a prompt turn. ACP never
  forwards them live.
- Showing a subagent's result text in the `wait` row. It lives in the card's OUTPUT detail.
- Codex cards: codex-acp 2.5.0 no longer sends the `_meta.codex.collaboration` that spec 282 detects.
  That needs its own spec.
- Steering or cancelling a job from the card or the row.

## Resources

- `omp acp` 18.17.0 wire capture and Krypton pipeline replay (throwaway client, not committed), 2026-11-07.
- [oh-my-pi v18.17.0](https://github.com/can1357/oh-my-pi/tree/v18.17.0/packages): `coding-agent/src/tools/wait.ts`, `async/job-control.ts`, `async/job-manager.ts`, `task/index.ts`, `session/async-job-delivery.ts`, `modes/acp/acp-event-mapper.ts`, `modes/acp/acp-agent.ts`; `tui/src/tools/wait.ts` (types, TUI renderer).
- Zed `crates/acp_thread/src/acp_thread.rs:1580-1594, 1719-1722, 5520-5559`; `crates/agent/src/tools/spawn_agent_tool.rs:205-235`; `crates/agent_ui/src/conversation_view/thread_view.rs:11186-11229, 11368-11386`.
- codex-acp 2.5.0 `dist/index.js:34917-34951, 35240-35311`; claude-agent-acp `dist/acp-agent.js:4659-4795`, `dist/async-tasks.js:568-580`.
- Specs [282](./0282-harness-subagent-cards.md), [301](./0301-harness-ui-components.md), [302](./0302-harness-component-catalog.md), [315](./0315-harness-execution-inspector.md).
