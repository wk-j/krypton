# `#polly` — Any-Lane Orchestrator + Fixed Worker Trio — Implementation Spec

> Status: Approved (rev 5 — review fixes from Claude-1 2026-06-16)
> Date: 2026-06-16
> Milestone: M-ACP — Harness Multi-Agent
> Builds on: `docs/145-harness-design-review-panel.md`, `docs/106-inter-lane-messaging.md`

## Problem

Users want **`#polly <task>`** with zero setup: type it from **whatever lane they
are on**, and the harness spawns the **fixed worker trio** (`cursor`, `claude`,
`codex`) automatically. The triggering lane is the orchestrator; workers are
always those three backends — never inferred from directives, never expanded to
other backends.

## Solution

Add **`#polly <task description>`**:

1. **Orchestrator** — the **active lane** that typed `#polly` (any `backendId`:
   Grok, Pi, Cursor, Claude, Codex, …). Gets `pollyBuiltinRole = 'orchestrator'`.

2. **Workers** — always exactly **`cursor`, `claude`, `codex`**. The harness
   **only ever auto-spawns these three** backends. Each gets
   `pollyBuiltinRole = 'implementer'`.

3. **`ensurePollyWorkers()`** — before dispatch:
   - For each backend in `POLLY_WORKER_BACKENDS` (`cursor`, `claude`, `codex`):
     find a live lane in this view + same `projectDir`, or `addLane(backend)` if
     installed, or record as `missing`.
   - Apply implementer role overlay on all three worker lanes.
   - Apply orchestrator role on the active lane.
   - Bail if any worker backend is not installed.

4. **`pollyRequestPrompt`** on the active (orchestrator) lane — fan-out to the
   three workers via `peer_send`; cross-review between workers (prompt-enforced:
   Claude built → Codex reviews, Codex built → Claude reviews; Cursor implements
   like the others).

**Shared worktree**, **no PR/worktree automation** — unchanged.

## Research

### User feedback timeline

| Rev | Orchestrator | Workers |
|-----|--------------|---------|
| 1 | directive inference | directive inference |
| 2 | cursor only | claude + codex |
| 3 | trigger lane ∈ {cursor, claude, codex} | the other two in pool |
| **4** | **any active lane** | **always spawn cursor + claude + codex** |

Rev 4 matches: "No any lane can start #polly but app will spawn only cursor,
claude and codex."

### Cross-review with three workers

All three are implementers. Default pairing (prompt):
- Claude ↔ Codex cross-review (different vendors)
- Cursor work reviewed by Claude or Codex (orchestrator picks by slice)
- Orchestrator never implements

### Spawn scope

`#polly` is the **only** harness path that auto-spawns lanes, and it spawns
**only** `cursor`, `claude`, `codex` — never the orchestrator's backend, never
pi/grok/etc. If the orchestrator *is* e.g. Claude-1, that lane is orchestrator
for this run; `ensurePollyWorkers` still ensures a **separate** Claude worker lane
only when no *other* Claude lane exists — see duplicate handling below.

## Prior Art

| App | Pattern |
|-----|---------|
| Omnigent Polly | Fixed worker roster + separate orchestrator brain |
| Krypton `#review` | Convening lane = whoever typed the command |

**Krypton delta** — orchestrator = any lane; workers = fixed trio auto-spawned.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/polly.ts` | **New.** `POLLY_WORKER_BACKENDS`, `ensurePollyWorkers`, `pollyRequestPrompt` |
| `src/acp/polly.test.ts` | **New.** Worker ensure, orchestrator-any-backend |
| `src/acp/hash-commands.ts` | Add `#polly` |
| `src/acp/acp-harness-view.ts` | `pollyBuiltinRole`, `runPollyCommand`, worker spawn |
| `docs/05-data-flow.md`, `docs/72-acp-harness-view.md`, `docs/PROGRESS.md` | Sync |
| `docs/164-polly-orchestration.md` | This spec |

No Rust changes.

## Design

### Command syntax

```
#polly <task description>
```

- Task required; empty → `#polly: no task`.
- Active lane `status === 'idle'` (same as `#review`).
- **No backend restriction** on the orchestrator lane.

### Worker backends (spawn target)

```ts
/** The only backends #polly ever auto-spawns. */
export const POLLY_WORKER_BACKENDS = ['cursor', 'claude', 'codex'] as const;
export type PollyWorkerBackend = (typeof POLLY_WORKER_BACKENDS)[number];
```

### Role prompts

```ts
export const POLLY_ROLE_PROMPTS: Record<'orchestrator' | 'implementer', string> = {
  orchestrator: `You are the Polly tech lead. You do NOT write source code or tests — delegate to the Cursor, Claude, and Codex worker lanes via peer_send. You MAY edit docs/Markdown and your lane memory. Integrate results; never commit or merge.`,
  implementer: `You are a Polly worker (Cursor, Claude, or Codex). Execute only the scoped task in the peer message. Run tests for touched code. Report file:line evidence. When asked to review another worker's diff, judge ONLY the diff + contract — ### Blockers / ### Warnings, no edits.`,
};
```

- **Orchestrator lane** (active): `pollyBuiltinRole = 'orchestrator'`.
- **Worker lanes** (cursor/claude/codex): `pollyBuiltinRole = 'implementer'`.

### `ensurePollyWorkers(orchestratorLane)`

```ts
export interface PollyRoster {
  orchestrator: { displayName: string; laneId: string; backendId: string };
  workers: Array<{ displayName: string; laneId: string; backendId: PollyWorkerBackend }>;
  spawned: PollyWorkerBackend[];
  /** Backend not in AcpClient.listBackends() */
  missing: PollyWorkerBackend[];
  /** Backend installed but spawnLane ended status==='error' / client===null */
  errored: PollyWorkerBackend[];
}
```

Algorithm:

```
applyPollyRole(orchestratorLane, 'orchestrator')
for backend in POLLY_WORKER_BACKENDS:
  lane ← first live lane where backendId === backend && same projectDir
         && lane.id !== orchestratorLane.id   // dedicated worker only
  if !lane:
    if backend not in listBackends(): missing.push(backend); continue
    await view.addPollyWorkerLane(backend)   // thin wrapper — see below
    lane ← re-scan: first live lane for backend where id !== orchestratorLane.id
  if !lane || lane.status === 'error' || !lane.client:
    errored.push(backend); continue
  applyPollyRole(lane, 'implementer')
  workers.push(lane)
if missing.any || errored.any: return null
view.activateLane(orchestratorLane.id)   // addLane activates last spawn — undo that
return roster
```

**`addPollyWorkerLane(backend)`** — wraps `addLane(backend)` (which returns
`Promise<void>` today). After `await`, the view **re-scans** `this.lanes` for the
newest live lane with that `backendId` whose `id !== orchestratorLane.id` (or
extends `addLane` to return the created `HarnessLane` — either is fine; re-scan is
the no-signature-change option). Do **not** treat the orchestrator lane as the
worker for its own backend.

**Orchestrator same backend as a worker** (e.g. Claude-1 runs `#polly`):
- Claude-1 = orchestrator only (`pollyBuiltinRole = 'orchestrator'`).
- No dedicated Claude worker exists → **always `addPollyWorkerLane('claude')`**
  (duplicate backend allowed; `nextLaneNumber` gives a globally-unique displayName).
- Never assign implementer role to the orchestrator lane.

**Reused busy worker** — a pre-existing worker lane may be `busy` or
`awaiting_peer` when found. That is **tolerable**: `InterLaneCoordinator` queues
the `peer_send` to its inbox and drains on the next `idle` transition (same as
`#review`). Only freshly spawned lanes are awaited to `idle` before dispatch so
`spawnLane` has finished.

**Spawn ceiling** — no `MAX_LANES` cap in the view. Steady-state reuses prior
workers; a same-backend orchestrator run spawns a 2nd worker lane only when no
other live lane exists for that backend. Tier B accepts unbounded duplicate spawns
across repeated runs if the user keeps closing worker lanes.

### `pollyRequestPrompt`

```
Orchestrator: <active displayName> (you, backend: <backendId>)
Workers: Cursor-1, Claude-1, Codex-1
Cross-review: Claude ↔ Codex; Cursor reviewed by Claude or Codex
```

Plus fan-out, synthesize, `review_outcome`, `attention_flag`, ephemeral task
memory, peer reply contract (workers omit `done: true`).

### Data Flow

```
1. User on ANY lane (e.g. Grok-1): #polly Fix auth module
2. runPollyCommand(activeLane):
   a. Guard: status idle
   b. reserveCommandTurn(activeLane, 'orchestrating')
   c. roster ← await ensurePollyWorkers(activeLane)
      → spawns cursor/claude/codex if missing; re-activates orchestrator
   d. if roster null → flash missing/errored backend, release, return
   e. dispatchTurn(activeLane, pollyRequestPrompt(...))
3. Orchestrator peer_send → workers → cross-review → synthesize
4. Human commits when satisfied
```

### UI Changes

- Help: `#polly <task>` — start Polly from this lane; spawns Cursor + Claude + Codex workers
- Flash: `#polly: no task`, `#polly: cursor not installed` (etc.), `#polly: spawned …`

## Edge Cases

| Case | Handling |
|------|----------|
| Any orchestrator backend | Allowed |
| Worker backend not installed | `missing` → `#polly: <backend> not installed` |
| Worker spawn failed | `errored` → `#polly: <backend> failed to start` |
| Orchestrator shares worker backend | Spawn dedicated worker via `addPollyWorkerLane`; orchestrator never a worker |
| Only spawns cursor/claude/codex | Never spawns grok/pi/etc. |
| Duplicate worker lanes | First non-orchestrator live lane; else spawn |
| Reused worker busy | Inbox queues; drains on idle (no extra guard) |
| Orchestrator lane busy | `#cancel first` |
| `#cancel` | Aborts pending peers |

## Open Questions

None:

- **Q1 Orchestrator:** any lane. ✓
- **Q2 Spawn set:** cursor + claude + codex only. ✓
- **Q3 Same-backend orchestrator:** auto-spawn second lane for worker. ✓

## Out of Scope

- Spawning backends outside cursor/claude/codex
- Git worktrees / PR-per-task
- Cross-harness `#polly`

## Resources

- [Omnigent Polly](https://github.com/omnigent-ai/omnigent/tree/main/examples/polly)
- Krypton `docs/145-harness-design-review-panel.md`
- Krypton `acp-harness-view.ts` — `addLane`
