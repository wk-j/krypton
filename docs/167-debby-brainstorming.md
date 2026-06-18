# `#debby` — Two-Headed Brainstorming Orchestration — Implementation Spec

> Status: Implemented (slice 1 core module + slice 2 harness wiring landed)
> Date: 2026-06-18
> Milestone: M-ACP — Harness Multi-Agent
> Builds on: `docs/164-polly-orchestration.md`, `docs/106-inter-lane-messaging.md`
> Behavioral reference: Omnigent `examples/debby` (`config.yaml` + `skills/debate/SKILL.md`)

## Problem

Users want **`#debby <question>`** to brainstorm a question against **two
independent models at once** — a Claude voice and a Codex voice — instead of a
single model's answer. The triggering lane is the orchestrator (Debby's "brain");
it fans every question to both heads, lays out the two perspectives side by side,
and optionally has them debate. Debby is **not a coding agent**: the heads are
plain responders, not implementers.

This is a sibling of `#polly` (spec 164) but differs in three ways:

1. **Heads are fixed and always both** — `claude` + `codex`, never excluding the
   orchestrator's backend (Polly excludes it to cap workers).
2. **Heads are responders, not implementers** — no source/test edits, no bypass
   permission.
3. **Output is a synthesis of perspectives**, not integrated code — Debby never
   commits or merges.

## Solution

Add **`#debby <question>`**:

1. **Orchestrator** — the **active lane** that typed `#debby` (any `backendId`).
   Gets `debbyBuiltinRole = 'orchestrator'`. Pure moderator — never answers from
   its own model.

2. **Heads** — **always** `claude` + `codex`, as **distinct lanes from the
   orchestrator**. Each gets `debbyBuiltinRole = 'head'`. A Debby run uses **three
   lanes total** (orchestrator + 2 heads).

3. **`ensureDebbyHeads()`** (slice 2) — before dispatch:
   - Use `debbyHeadBackendsFor()` → always `['claude', 'codex']`.
   - For each head backend: find a live lane in this view + same `projectDir`
     **whose id ≠ the orchestrator lane**, or `addLane(backend)` if installed, or
     record as `missing`.
   - Apply head role overlay on the two head lanes (no bypass permission).
   - Apply orchestrator role on the active lane.
   - Bail if any head backend is not installed / errored.

4. **`debbyRequestPrompt`** on the active (orchestrator) lane — fan-out to both
   heads via `peer_send`, side-by-side presentation, inline debate procedure.

**Shared worktree**, **no PR/worktree automation** — unchanged from Polly.

### Duplicate-backend head (orchestrator shares a head backend)

The key divergence from Polly. If the orchestrator runs on `claude` or `codex`,
Debby does **not** exclude that backend — both heads are part of Debby's identity.
Instead it ensures a **separate head lane on that backend, distinct from the
orchestrator** (a duplicate-backend lane). E.g. a Claude orchestrator (Claude-1)
spawns a second Claude head (Claude-2) plus a Codex head. This keeps both
perspectives present and the orchestrator a pure moderator.

> This duplicate-backend spawn is the harness-wiring concern flagged in attention
> item `jdg-1781791426202-0c107488` and is resolved in slice 2 (`ensureDebbyHeads`
> must scan for a head lane `id !== orchestratorLane.id`, then `addLane` a fresh
> same-backend lane when the only candidate is the orchestrator itself).

## Design

### Command syntax

```
#debby <question>
```

- Question required; empty → `#debby: no question`.
- Active lane `status === 'idle'` (same as `#polly` / `#review`).
- **No backend restriction** on the orchestrator lane.

### Head backends (spawn target)

```ts
/** The fixed head pool #debby always fans out to. */
export const DEBBY_HEAD_BACKENDS = ['claude', 'codex'] as const;
export type DebbyHeadBackend = (typeof DEBBY_HEAD_BACKENDS)[number];

/** Always both heads, regardless of orchestrator backend. */
export function debbyHeadBackendsFor(): DebbyHeadBackend[] {
  return [...DEBBY_HEAD_BACKENDS];
}
```

### Role prompts

```ts
export const DEBBY_ROLE_PROMPTS: Record<'orchestrator' | 'head', string> = {
  orchestrator: `You are Debby, a two-headed brainstorming partner — NOT a coding agent … fan EVERY substantive question to BOTH head lanes (claude + codex) via peer_send, present the two perspectives side by side, attribute each view … On request / #debate run the debate procedure (default 1 round) then converge on an even-handed synthesis … brainstorming/synthesis only, do not edit files or write code, never commit.`,
  head: `You are a Debby head (Claude or Codex) — a plain brainstorming responder, NOT a coding agent. ANSWER mode: answer on the merits. CRITIQUE mode: critique the OTHER head's answer then give your own updated answer. Do not edit files/write code unless explicitly asked. Reply via peer_send without done:true.`,
};
```

- **Orchestrator lane** (active): `debbyBuiltinRole = 'orchestrator'`.
- **Head lanes** (claude/codex): `debbyBuiltinRole = 'head'`.

### Permission mode — heads do NOT get bypass

Unlike Polly implementers (spec 164 rev 7, which switches workers to `bypass`),
Debby heads are pure responders that should not be editing files or running
shells. They keep their current permission mode; Debby applies **no permission
escalation** to any lane. If a head is asked to read reference material the
normal permission flow applies.

### `ensureDebbyHeads(orchestratorLane)` (slice 2)

```ts
export interface DebbyRoster {
  orchestrator: { displayName: string; laneId: string; backendId: string };
  heads: Array<{ displayName: string; laneId: string; backendId: DebbyHeadBackend }>;
  spawned: DebbyHeadBackend[];
  missing: DebbyHeadBackend[];  // backend not in listBackends()
  errored: DebbyHeadBackend[];  // installed but spawn ended error / client null
}
```

Algorithm:

```
applyDebbyRole(orchestratorLane, 'orchestrator')
for backend in debbyHeadBackendsFor():           // always [claude, codex]
  lane ← first live lane where backendId === backend && same projectDir
         && lane.id !== orchestratorLane.id       // never reuse orchestrator as a head
  if !lane:
    if backend not in listBackends(): missing.push(backend); continue
    await view.addDebbyHeadLane(backend)          // duplicate-backend spawn is fine
    lane ← re-scan: first live lane for backend where id !== orchestratorLane.id
  if !lane || lane.status === 'error' || !lane.client:
    errored.push(backend); continue
  applyDebbyRole(lane, 'head')                     // NO bypass permission
  heads.push(lane)
if missing.any || errored.any: return null
view.activateLane(orchestratorLane.id)
return roster
```

### `debbyRequestPrompt`

Fan-out to both heads + side-by-side presentation + inline debate procedure
(default 1 round), mirroring the Omnigent Debby prompt + debate skill so the
debate procedure travels with the dispatch (no bespoke harness skill). Steps:

1. **Fan out** — peer_send the question to both heads (ANSWER mode), `done: false`.
2. **Collect** — present both even-handedly (`## 🟠 Claude` / `## 🔵 Codex` /
   `## Where they agree / differ`) once both are in hand; attribute, never merge.
3. **Debate (optional, default 1 round)** — relay each head's answer to the other
   for critique (CRITIQUE mode, reuse thread), loop N rounds, always cross the
   answers, then converge (`final` / `How the debate moved them` / `Synthesis`).
4. **Stay even-handed** — moderator not third debater; never commit; track head
   status in working context (not `memory_set` — handoff-only, spec 165).

### Debate is inline, not a standalone command

There is **no `#debate` hash command**. The debate procedure (default **1
round**, honor an explicit count like "debate this for 3 rounds") lives entirely
inside `debbyRequestPrompt`, gated on the user asking for it. A user triggers a
debate by asking for it in natural language — either in the original `#debby`
message ("…and have them debate it") or as a plain follow-up turn after the
side-by-side answers land. Keeping it inline avoids a second hash command whose
only job is to re-enter a procedure the orchestrator already carries.

> **Future work (deferred):** a dedicated `#debate [rounds]` shortcut could
> re-enter the debate loop without retyping the question. Out of scope for this
> spec — revisit only if the natural-language path proves insufficient.

### Data Flow

```
1. User on ANY lane: #debby Should we use SQLite or Postgres?
2. runDebbyCommand(activeLane):           // slice 2
   a. Guard: status idle
   b. reserveCommandTurn(activeLane, 'orchestrating')
   c. roster ← await ensureDebbyHeads(activeLane)   // spawns claude + codex heads
   d. if roster null → flash missing/errored backend, release, return
   e. dispatchTurn(activeLane, debbyRequestPrompt(...))
3. Orchestrator peer_send → both heads → present side by side → (debate) → synthesize
```

### UI Changes (slice 2)

- Help: `#debby <question>` — brainstorm against a Claude head + a Codex head
  (ask for a debate in the message or a follow-up to run the critique loop)
- Flash: `#debby: no question`, `#debby: codex not installed`, `#debby: spawned …`

## Edge Cases

| Case | Handling |
|------|----------|
| Any orchestrator backend | Allowed |
| Head backend not installed | `missing` → `#debby: <backend> not installed` |
| Head spawn failed | `errored` → `#debby: <backend> failed to start` |
| Orchestrator shares a head backend | Spawn a SEPARATE same-backend head lane; orchestrator stays moderator |
| Reused head busy | Inbox queues; drains on idle (same as `#polly` / `#review`) |
| Orchestrator lane busy | `#cancel first` |
| Head returns empty/unclear | Orchestrator asks it to retry before dropping its voice |
| `#cancel` | Aborts pending peers |

## Affected Files

| File | Change |
|------|--------|
| `src/acp/debby.ts` | **New (slice 1).** Backends, role prompts, `parseDebbyTask`, `debbyHeadBackendsFor`, `debbyRequestPrompt`, types |
| `src/acp/debby.test.ts` | **New (slice 1).** Parse, fixed heads, prompt shape, duplicate-backend roster |
| `src/acp/hash-commands.ts` | **Slice 2.** Add `#debby` (no `#debate` command — debate is inline) |
| `src/acp/acp-harness-view.ts` | **Slice 2.** `debbyBuiltinRole`, `runDebbyCommand`, `ensureDebbyHeads`, head spawn (no bypass) |
| `docs/05-data-flow.md`, `docs/72-acp-harness-view.md`, `docs/PROGRESS.md` | **Slice 2.** Sync |
| `docs/167-debby-brainstorming.md` | This spec |

No Rust changes.

## Out of Scope

- Coding/implementation by the heads (Debby is brainstorming only)
- Bypass permission on heads
- More than two heads / configurable head backends
- Git worktrees / PR automation
- Cross-harness `#debby`

## Resources

- [Omnigent Debby](https://github.com/omnigent-ai/omnigent/tree/main/examples/debby) — `config.yaml`, `skills/debate/SKILL.md`
- Krypton `docs/164-polly-orchestration.md`
- Krypton `docs/106-inter-lane-messaging.md`
