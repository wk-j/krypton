# #polly Always Emits a Live Plan — Implementation Spec

> Status: Implemented
> Date: 2026-06-18
> Milestone: M-ACP — Harness
> Extends: `docs/164-polly-orchestration.md` (spec 164)

## Problem

A `#polly` run fans work out to worker lanes and synthesizes their replies, but the human had no glanceable, live view of *what the run is doing right now / what happened* — only the orchestrator's scrolling turn text. Spec 165 just removed the `## Polly tasks` scratchpad from `memory_set` (memory is handoff-only), which was an agent-facing note anyway, not a human observability surface. The user wants `#polly` to **always** surface a todo/progress list the human can watch while it runs.

## Solution

Reuse the harness's existing **Plan panel** — no new UI, store, or MCP tool. The harness already renders any ACP `plan` `session/update` a lane emits: `renderPlan()` → `renderPlanPanel()` (`src/acp/acp-harness-view.ts:8374`, `:8379`) draws a live progress bar, `step N of M` / `done/total` counters, and a per-entry list with `pending`/`in_progress`/`completed` status + `low/med/high` priority, collapsible, and mirrored in the lane peek. All three Polly backends (cursor/claude/codex) stream ACP plan updates through this path (`docs/113-acp-cursor-lane.md:131`).

The only gap was that `#polly` never *told* the orchestrator to emit and maintain a plan. So the change is **prompt-only**, in `src/acp/polly.ts`:

- **Orchestrator role prompt** (`POLLY_ROLE_PROMPTS.orchestrator`): add "Always keep a live plan/todo list with one entry per task slice and update its statuses as the run proceeds, so the human can observe progress in the Plan panel."
- **`pollyRequestPrompt` step 1 (Plan gate):** after decomposing the task into slices, **emit a plan/todo list with ONE entry per slice** (the harness renders it live for the human).
- **`pollyRequestPrompt` step 5 (Synthesize):** keep the plan current as slices land — flip each entry `pending → in_progress → completed`.

This maps cleanly onto the orchestration loop: a task slice = a plan entry; its progress = the entry status. The plan persists in `lane.plan` until the lane is restarted / `#new`, so after the run the completed plan remains visible as a record of "what happened."

### Honest limitations

- **Agent-emitted, not enforced.** ACP plans are produced by the agent; the harness cannot *force* a model to emit one — the prompt instructs it as strongly as possible (best-effort, not a hard guarantee). There is no harness lint/guard that flags a missing plan; silence simply yields an empty Plan panel.
- **Backend-dependent for the orchestrator.** The Polly *workers* are always cursor/claude/codex, which all stream ACP `plan` updates (`docs/113-acp-cursor-lane.md:131`) — but workers do not own the panel. The *orchestrator* is whatever lane ran `#polly` (spec 164: the active lane), which can be **any** backend, including ones that do not emit ACP plan updates. A non-plan-emitting orchestrator backend yields an empty panel regardless of the instruction.
- **Plan panel is active-lane-scoped.** `renderPlanPanel(this.activeLane())` rebinds on every `render()` / lane switch (`src/acp/acp-harness-view.ts:6531`; `docs/90-acp-plan-tracking.md:58`). `#polly` re-activates the orchestrator after spawning workers, so by default the human sees the orchestrator's plan — but if they switch the main view to a worker lane mid-run, the orchestrator's plan leaves the main panel until they switch back (the lane-peek mirror is a partial, not full, substitute). Aggregating the run into one always-visible surface is out of scope (below).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/polly.ts` | Orchestrator role prompt + `pollyRequestPrompt` steps 1 & 5 instruct the orchestrator to emit and maintain a live ACP plan (one entry per slice, statuses kept current). No new tools/state. |
| `src/acp/polly.test.ts` | `pollyRequestPrompt` test asserts the plan instruction (`Plan panel`, `one entry per`). |
| `docs/164-polly-orchestration.md` | Note the always-on live plan in the role-prompt / steps section. |
| `docs/166-polly-live-plan.md` | This spec. |
| `docs/PROGRESS.md` | Spec 166 entry. |

## Out of Scope

- A bespoke `#polly`-only todo panel aggregating every worker's status into one view (the orchestrator's own plan is the single source the human watches). That would be a larger feature warranting its own design pass.
- Any harness-side enforcement that a plan was actually emitted (no lint/guard; silence simply yields an empty Plan panel).

## Resources

- `src/acp/acp-harness-view.ts:8374` / `:8379` — `renderPlan` / `renderPlanPanel` (existing Plan panel; no change).
- `src/acp/acp-harness-view.ts:4426` — ACP `plan` `session/update` handler.
- `docs/113-acp-cursor-lane.md:131` — Cursor streams ACP plan/mode updates through existing harness code.
- `docs/164-polly-orchestration.md` — the `#polly` orchestration this extends.
