# `#salty` — Model-Tiered Orchestration Workflow — Implementation Spec

> Status: Implemented
> Date: 2026-07-16
> Milestone: ACP Harness — orchestration family (sibling of specs 164 `#polly` / 167 `#debby`)

## Problem

SaltyAom's orchestrator workflow (the gist the user wants built in) runs one planning-only
orchestrator that routes each task to a model-tiered executor — Fable for second opinions on
the hardest problems, Sonnet for fast mechanical work, Opus for reasoning-heavy verification,
Codex (gpt-5.6-sol) as a peer engineer/reviewer — with a mandatory plan-pushback step before
execution and cross-review after. Krypton's existing orchestrations can't express this:
`#polly` picks workers by *backend* (cursor/claude/codex) with whatever single model
`lane_models.<backend>.active` configures, so two concurrent Claude lanes can never be
Sonnet and Opus at once, and no built-in role prompt encodes the tiered routing rules or the
plan-verify loop.

## Solution

A third built-in orchestration command, **`#salty <task>`** (named for the gist's author),
following the `#polly`/`#debby` shape exactly: the active lane becomes the Salty
orchestrator (plans/decides only, never implements), and the harness ensures a fixed
executor roster — **mechanical** (Claude @ sonnet), **thinker** (Claude @ opus), and
**codex-peer** (Codex) by default, plus **fellow** (Claude @ fable) only when invoked as
`#salty +fellow <task>`. Role prompts are injected via the existing
`composeLeadingContext` overlay seam; the plan → pushback → dispatch → gate → cross-review
→ synthesize loop lives entirely in the orchestrator's role/request prompt (model-driven,
per ADR-0012 — no harness workflow runner). The one new mechanism is a small
**per-lane spawn-time model override**: after `session/new`, the harness applies a
requested model alias through the same `session/set_model` path the spec-127 live picker
already uses — config semantics of spec 126 (`lane_models`, load-time, per-backend) are
untouched.

The gist's final "merge all worktrees into one unstaged tree" step is resolved by
Krypton's standing shared-worktree model: all lanes already edit one worktree, so work
lands as a single unstaged set by construction; the orchestrator's synthesis step reports
the combined diffstat instead of performing a merge. Worktree-per-executor stays out of
scope (see below).

## Research

- **Per-lane models are the only real gap.** `acp_spawn` applies
  `lane_models.<backend>.active` per *backend* (`acp.rs:1033-1044`); two Claude lanes share
  it. But the live model picker (spec 127) already switches one live lane via
  `session/set_model` sourced from the agent-advertised `availableModels`
  (`acp-harness-view.ts:590`), and aliases (`sonnet`, `opus`) resolve adapter-side
  (spec 126). So a frontend-only `applyLaneModel(lane, alias)` called right after the
  executor lane's session is ready gives role→model binding with zero Rust changes and
  zero config-semantics changes. Failure is non-fatal and already surfaces as the
  `modelApplyFailed` amber chip.
- **The loop must be prompt-driven.** ADR-0012 rejects any multi-turn workflow runner;
  `#polly` (spec 164) is the sanctioned precedent: `ensurePollyWorkers` roster builder +
  `pollyBuiltinRole` prompt overlays + one `pollyRequestPrompt` that scripts the whole
  fan-out/review/synthesize loop as best-effort model behavior over `peer_send`.
  `#debby` (spec 167) confirms the reusable pattern for responder (non-implementer) roles.
- **Constraints inherited from ADRs/specs** (all respected by this design):
  memory is handoff-only — the orchestrator tracks task state in its own context, never
  `memory_set` (spec 165); peering is async/cooperative, initiator owns `done:true`
  (spec 106); unattended executors use Polly-style temporary `permissionMode: bypass`
  with snapshot/restore, high-risk still gated (specs 164/143/140); genuine forks route to
  the human via `attention_flag`, non-blocking (ADR-0001); live progress rides the ACP
  Plan panel (spec 166); at most one *console* Orchestrator seat exists (ADR-0011) — the
  Salty orchestrator is a role prompt like Polly's, not a seat, no conflict.
- **Peer review:** draft reviewed by lane Codex-2 (lens: architecture & correctness) —
  5 blockers + 4 warnings, all folded into this revision: the `applyLaneModel`
  resolution contract, reuse/mutual-exclusion rules, busy-lane model apply, role
  teardown/permission restore, codex-peer model divergence note, partial-roster
  contract, best-effort wording, and explicit role-clear.
- **Gist deltas that cannot map 1:1:** Codex effort selection (high vs xhigh) is
  adapter-internal — encoded as prompt guidance to the codex-peer lane, not harness
  state. "Ask for clarification, never assume intent" maps to ending the orchestrator's
  turn with a question (blocking, normal ACP) for true blockers, `attention_flag` for
  non-blocking forks.

## Prior Art

| System | Implementation | Notes |
|--------|---------------|-------|
| SaltyAom gist | Claude Code system prompt: orchestrator + named executors (Fable/Sonnet/Opus/Codex via `/codex:rescue`), plan-pushback, worktree merge | The source workflow; relies on Claude Code subagents with per-agent models + worktree isolation |
| Claude Code subagents | `Agent` tool with per-agent-definition model + optional git-worktree isolation | Per-call model override is native; Krypton lanes are long-lived ACP sessions instead |
| Krypton `#polly` (164) | Backend-diverse worker pool, bypass implementers, cross-review, shared worktree | Model tier per role is impossible; routing rules absent |
| Krypton `#debby` (167) | Two fixed debate heads (Claude+Codex), responders only | The pushback/verify shape `#salty` reuses for thinker/fellow |
| Omnigent Polly | Sub-agent registry, worktree + PR per task | Explicitly rejected for Krypton (spec 164 out-of-scope) |

**Krypton delta** — matches the gist's role taxonomy and loop order; diverges on worktree
isolation (shared worktree + disjoint file scopes, per standing decision) and on
clarification style (attention triage instead of always-blocking questions).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/salty.ts` | **New.** `SALTY_ROLE_PROMPTS` (orchestrator / fellow / mechanical / thinker / codex-peer), `saltyExecutorPlan()` roster builder, `saltyRequestPrompt(task)` |
| `src/acp/acp-harness-view.ts` | `#salty` dispatch: `ensureSaltyExecutors()` (spawn + role stamp + bypass for mechanical/codex-peer + `applyLaneModel`), `saltyBuiltinRole` lane field wired into `composeLeadingContext`; extract `applyLaneModel(lane, alias)` from the spec-127 picker path |
| `src/acp/hash-commands.ts` | Register `#salty` (palette + manifest, workflow badge, lane-cost note) |
| `src/acp/salty.test.ts` | **New.** Prompt/roster unit tests (mirror `polly.test.ts`) plus lifecycle tests: session-ready timing, alias resolution/rejection, busy-lane reuse, model drift revalidation, invocation from a stamped executor, Salty↔Polly/Debby transitions, partial rosters, `+fellow` then default run |
| `docs/PROGRESS.md`, `docs/195-…md` | Progress entry + this spec |

## Design

### Roles & roster

```ts
type SaltyRole = 'orchestrator' | 'fellow' | 'mechanical' | 'thinker' | 'codexPeer';
interface SaltyExecutorSpec {
  role: Exclude<SaltyRole, 'orchestrator'>;
  backendId: 'claude' | 'codex';
  modelAlias?: string;          // 'sonnet' | 'opus' | 'fable'; undefined = backend default
  bypass: boolean;              // Polly-style temporary permissionMode
}
interface SaltyModelApply {     // per-executor outcome, fed into saltyRequestPrompt
  requested?: string;           // the alias, when one was requested
  effective?: string;           // the exact model_id sent (resolved), or current model
  applied: boolean;             // false = degraded tier (default model in use)
}
```

Default roster (3 executors + orchestrator = 4 lanes): mechanical (claude/sonnet,
bypass), thinker (claude/opus, responder), codex-peer (codex, bypass).
`+fellow` adds fellow (claude/fable, responder). The orchestrator lane is whatever
lane runs the command, any backend.

**codex-peer model is an intentional divergence from the gist:** the harness never
hard-codes an OpenAI model id — codex-peer inherits `lane_models.codex.active` (the
user pins `gpt-5.6-sol` there); its `SaltyModelApply` reports whatever the lane
actually runs so the orchestrator sees the real tier.

**Reuse & mutual exclusion rules** (Codex-2 review findings):
- An executor candidate must satisfy `lane.id !== orchestratorLane.id` — invoking
  `#salty` from a previously stamped executor promotes it to orchestrator and its old
  executor role is cleared (permission snapshot restored) before the roster is built.
- Only **idle** lanes with a matching `saltyBuiltinRole` are reused; a busy/awaiting
  stamped lane is left untouched and a fresh lane is spawned instead (never
  `session/set_model` mid-turn).
- On every run the tier is **revalidated**: a reused lane whose model drifted (live
  picker, spec 127) gets `applyLaneModel` re-applied while idle.
- Built-in roles are mutually exclusive per lane: stamping `saltyBuiltinRole` clears
  `pollyBuiltinRole`/`debbyBuiltinRole` (and vice versa in their ensure paths),
  restoring any permission snapshot the outgoing role held, so
  `composeLeadingContext` can never select a stale overlay or leak bypass.
- Role/bypass persistence is explicit: `saltyBuiltinRole` + bypass survive until role
  replacement, `#salty clear`, `#new`, restart, or close — each of which restores the
  saved permission mode. There is no automatic "workflow finished" clear (the loop is
  prompt-driven; the harness cannot detect completion).

**Partial-roster contract** (minimum viable): the run **aborts** with a composer
notice if the **thinker** cannot spawn (the plan-pushback step is the workflow's
spine) or if **no implementer** (mechanical/codex-peer) is available. With exactly one
implementer it proceeds degraded — cross-review of that implementer's diff falls to
the thinker — and the orchestrator prompt states the gap.

### Role prompt content (condensed from the gist)

All loop steps below are **prompt-required, best-effort** — per ADR-0012 the harness
never enforces pushback/gates/review; they are model behavior scripted by the prompt
(same trust posture as `#polly`).

- **orchestrator** — think/design/plan only; write essential specs and reasoning; never
  write code unless all executors fail; route by tier (mechanical = small redundant tasks
  with detailed conclusion + key diffs; thinker = reasoning/verification; codex-peer =
  peer engineer, second opinion, code review, debugging, security investigation;
  fellow = hardest architectural calls only); before executing, send the plan to thinker
  (and codex-peer for high-stakes/security work) for pushback and revise; everything else
  single executor, no fan-out; bias caution over speed; after execution re-read the plan,
  run deterministic gates, cross-review diffs between executors (`#review`-style
  `peer_send`), synthesize with `file:line` citations; keep a live ACP plan
  (spec 166); track all state in working context (never `memory_set`); genuine forks →
  `attention_flag`; true blockers → end turn asking the user.
- **executor roles** — scoped responder/implementer prompts mirroring `POLLY_ROLE_PROMPTS`
  / `DEBBY_ROLE_PROMPTS`; codex-peer told to use maximum reasoning effort for review/debug
  requests and standard effort for implementation.

### Per-lane model application

The spec-127 picker sends an **exact agent-advertised `model_id`**, while spec-126
aliases are sent verbatim and may not appear in `availableModels` — so
`applyLaneModel(lane, alias): Promise<SaltyModelApply>` is a picker-*shaped* helper
with one explicit resolution contract, not a raw extraction:

```
1. ensureSaltyExecutors(): for each missing executor → addLane(backendId)
2. wait for session ready (session/new returned, availableModels captured)
3. resolve alias → an advertised model_id: exact id match, else unique
   case-insensitive substring match over id/displayName ('opus' → the one
   advertised Opus entry)
4. resolved   → send session/set_model with that exact model_id
   unresolved (no availableModels, no match, ambiguous, or set_model fails)
             → NO send; degrade
5. return { requested, effective, applied } — degraded lanes keep the backend
   default; the existing modelApplyFailed amber chip warns the human, and the
   outcome row is embedded in saltyRequestPrompt so the ORCHESTRATOR (not just
   the human) can note the degraded tier and route around it
```

No new Rust command, no `lane_models` config write, no hot-reload (spec-126 semantics
untouched). Apply runs only while the lane is idle (see reuse rules above).

### Data flow (happy path)

```
1. User (on any lane): #salty implement X
2. Harness ensures roster, stamps saltyBuiltinRole overlays, re-activates orchestrator
3. Harness injects saltyRequestPrompt(task) into the orchestrator
4. Orchestrator drafts plan → peer_send to thinker (+codex-peer if high-stakes) → revises
5. Orchestrator dispatches slices via structured peer_send (Polly heading template);
   parallel implementers only with disjoint file scopes (shared worktree)
6. Executors reply (initiator-owns-done lifecycle); orchestrator runs gates
7. Cross-review: each implementer's diff peer_sent to a different executor
8. Orchestrator synthesizes: combined diffstat + reasoning + file:line citations,
   flips plan entries to completed, restores executor permission modes on role clear
```

### Commands

| Command | Action |
|---------|--------|
| `#salty <task>` | Run workflow with default roster (4 lanes) |
| `#salty +fellow <task>` | Include the fellow (Fable) lane (5 lanes) |
| `#salty clear` | Clear all Salty roles in the harness, restore saved permission modes |

No new keybinding; rides the `#` palette like `#polly`.

## Edge Cases

- **Model alias unavailable** (e.g. no Fable access): non-fatal; lane runs backend
  default; amber chip + prompt note. Roster never blocks on model apply.
- **Backend missing** (codex CLI not installed): spawn fails as today; orchestrator prompt
  says to proceed with remaining tiers and note the gap in synthesis.
- **Orchestrator is a claude lane**: fine — executors are separate lanes; globally-unique
  display names (spec 141) keep addressing unambiguous.
- **Re-invocation while roster live**: idle stamped lanes reused with tier revalidated;
  busy stamped lanes skipped (fresh spawn); permission modes re-snapshotted only if not
  already overridden (never snapshot a bypass installed by a previous run).
- **Invocation from a stamped executor**: that lane becomes orchestrator — its executor
  role is cleared and its permission snapshot restored first (no double role).
- **Salty ↔ Polly/Debby transition**: the incoming ensure path clears the other
  family's roles + restores their snapshots before stamping its own.
- **`#cancel`**: existing pending-pair cancellation applies per peer; it does NOT clear
  roles — `#salty clear` / `#new` / restart / close do (each restores permission modes).

## Open Questions

None — the two real forks were resolved during design: (1) worktree merge dropped in
favor of the standing shared-worktree model (flagged to the human queue); (2) fellow is
opt-in (`+fellow`) to keep the default lane cost at 4, matching Polly+Debby scale.
Codex-2's review blockers (model-apply contract, reuse/teardown rules, partial-roster
behavior) are resolved in the Design section above, not open.

## Out of Scope

- Git worktree-per-executor and any merge/PR automation (contradicts specs 164/167
  standing decisions; would need its own ADR).
- Codex reasoning-effort as harness state (adapter-internal; prompt-level only).
- Cross-harness rosters; changing `lane_models` config semantics or hot-reload (spec 126
  decision stands); any orchestrator-console (spec 180) coupling.
- A harness-enforced loop/state machine (ADR-0012).

## Resources

- [SaltyAom orchestrator gist](https://gist.github.com/SaltyAom/b6cb30b417573c80efda431dbff1dfb3) — the source workflow this spec adapts.
- `docs/164-polly-orchestration.md`, `docs/167-debby-brainstorming.md` — roster/role-prompt pattern reused wholesale.
- `docs/126-acp-lane-model-selection.md`, `docs/127-acp-lane-model-picker.md` — `session/set_model` path powering per-lane tiering.
- `docs/adr/0011…` (orchestrator bounds), `docs/adr/0012…` (no workflow runner), `docs/165-memory-handoff-only.md`, `docs/adr/0001…` (triage router) — binding constraints.
