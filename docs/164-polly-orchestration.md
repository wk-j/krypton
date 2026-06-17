# `#polly` — Any-Lane Orchestrator + Two-Worker Cap — Implementation Spec

> Status: Implemented (rev 7)
> Date: 2026-06-16
> Milestone: M-ACP — Harness Multi-Agent
> Builds on: `docs/145-harness-design-review-panel.md`, `docs/106-inter-lane-messaging.md`

## Problem

Users want **`#polly <task>`** with zero setup: type it from **whatever lane they
are on**, and the harness ensures a small fixed worker pool without exploding
lane count. The triggering lane is the orchestrator; at most **two worker lanes**
join it, so a Polly run uses **three lanes total**.

## Solution

Add **`#polly <task description>`**:

1. **Orchestrator** — the **active lane** that typed `#polly` (any `backendId`:
   Grok, Pi, Cursor, Claude, Codex, …). Gets `pollyBuiltinRole = 'orchestrator'`.

2. **Workers** — selected from the fixed pool **`cursor`, `claude`, `codex`**.
   If the orchestrator backend is in that pool, workers are the other two. If
   the orchestrator is outside that pool (Grok, Pi, …), workers are
   **`cursor` + `claude`**. Each worker gets `pollyBuiltinRole = 'implementer'`.

3. **`ensurePollyWorkers()`** — before dispatch:
   - Compute `pollyWorkerBackendsFor(orchestrator.backendId)`.
   - For each selected backend:
     find a live lane in this view + same `projectDir`, or `addLane(backend)` if
     installed, or record as `missing`.
   - Apply implementer role overlay on the two worker lanes.
   - Apply orchestrator role on the active lane.
   - Bail if any worker backend is not installed.

4. **`pollyRequestPrompt`** on the active (orchestrator) lane — fan-out to the
   two workers via `peer_send`; cross-review between workers.

**Shared worktree**, **no PR/worktree automation** — unchanged.

## Research

### User feedback timeline

| Rev | Orchestrator | Workers |
|-----|--------------|---------|
| 1 | directive inference | directive inference |
| 2 | cursor only | claude + codex |
| 3 | trigger lane ∈ {cursor, claude, codex} | the other two in pool |
| **4** | **any active lane** | **always spawn cursor + claude + codex** |
| **5** | **any active lane** | **fixed trio, with duplicate same-backend worker** |
| **6** | **any active lane** | **two workers; three lanes total** |
| **7** | **any active lane** | **two workers; implementers run in bypass permission mode** |

Rev 4 matches: "No any lane can start #polly but app will spawn only cursor,
claude and codex."

Rev 6 caps each run at two workers plus the orchestrator. The fixed worker pool
remains `cursor`, `claude`, `codex`, but the orchestrator's backend is excluded
when it is in the pool; outside-pool orchestrators use `cursor` + `claude`.

### Cross-review with two workers

Both workers are implementers. Default pairing (prompt):
- Worker A implements → Worker B reviews.
- If both workers implement disjoint slices, they cross-review each other.
- Orchestrator never implements

### Spawn scope

`#polly` is the **only** harness path that auto-spawns lanes, and it spawns
**only** selected workers from `cursor`, `claude`, `codex` — never
pi/grok/etc. If the orchestrator *is* e.g. Claude-1, that lane is orchestrator
for this run and the selected workers are Cursor + Codex. No duplicate
same-backend worker is spawned for the orchestrator.

## Prior Art

| App | Pattern |
|-----|---------|
| Omnigent Polly | Fixed worker roster + separate orchestrator brain |
| Krypton `#review` | Convening lane = whoever typed the command |

**Krypton delta** — orchestrator = any lane; workers = two lanes selected from
the fixed pool.

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
/** The fixed backend pool #polly may auto-spawn from. */
export const POLLY_WORKER_BACKENDS = ['cursor', 'claude', 'codex'] as const;
export type PollyWorkerBackend = (typeof POLLY_WORKER_BACKENDS)[number];

export function pollyWorkerBackendsFor(orchestratorBackendId: string): PollyWorkerBackend[] {
  if (orchestratorBackendId === 'cursor') return ['claude', 'codex'];
  if (orchestratorBackendId === 'claude') return ['cursor', 'codex'];
  if (orchestratorBackendId === 'codex') return ['cursor', 'claude'];
  return ['cursor', 'claude'];
}
```

### Role prompts

```ts
export const POLLY_ROLE_PROMPTS: Record<'orchestrator' | 'implementer', string> = {
  orchestrator: `You are the Polly tech lead. You do NOT write source code or tests — delegate to the two worker lanes via peer_send. You MAY edit docs/Markdown and your lane memory. Integrate results; never commit or merge.`,
  implementer: `You are a Polly worker (Cursor, Claude, or Codex). Execute only the scoped task in the peer message. Run tests for touched code. Report file:line evidence. When asked to review another worker's diff, judge ONLY the diff + contract — ### Blockers / ### Warnings, no edits.`,
};
```

- **Orchestrator lane** (active): `pollyBuiltinRole = 'orchestrator'`.
- **Worker lanes** (cursor/claude/codex): `pollyBuiltinRole = 'implementer'`.

### Polly implementer permission mode

Polly worker lanes are meant to run unattended once the orchestrator delegates
scoped work to them. When a lane is stamped with `pollyBuiltinRole =
'implementer'`, the harness also switches that lane's `permissionMode` to
`bypass` for the duration of the Polly role. This auto-accepts normal edit and
shell permissions so implementers do not stall on routine work. The orchestrator
lane does **not** receive bypass from Polly; it keeps its current permission
mode.

The permission escalation is tied to the role overlay, not to the backend or the
lane forever:

- Stamping an implementer snapshots the lane's previous permission mode before
  switching to `bypass`.
- Clearing the Polly role restores that previous mode.
- Lane close and `#new` clear the role and restore/drop the temporary bypass
  state as part of lane teardown or fresh-session reset.
- Manual permission-mode changes outside Polly remain lane-local; Polly should
  not leave a worker permanently in bypass after the role is cleared.

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
for backend in pollyWorkerBackendsFor(orchestratorLane.backendId):
  lane ← first live lane where backendId === backend && same projectDir
         && lane.id !== orchestratorLane.id
  if !lane:
    if backend not in listBackends(): missing.push(backend); continue
    await view.addPollyWorkerLane(backend)   // thin wrapper — see below
    lane ← re-scan: first live lane for backend where id !== orchestratorLane.id
  if !lane || lane.status === 'error' || !lane.client:
    errored.push(backend); continue
  applyPollyRole(lane, 'implementer')  // also sets permissionMode='bypass'
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

**Orchestrator same backend as a pool backend** (e.g. Claude-1 runs `#polly`):
- Claude-1 = orchestrator only (`pollyBuiltinRole = 'orchestrator'`).
- Worker selection excludes `claude`, so the run uses Cursor + Codex workers.
- Never assign implementer role to the orchestrator lane.

**Reused busy worker** — a pre-existing worker lane may be `busy` or
`awaiting_peer` when found. That is **tolerable**: `InterLaneCoordinator` queues
the `peer_send` to its inbox and drains on the next `idle` transition (same as
`#review`). Only freshly spawned lanes are awaited to `idle` before dispatch so
`spawnLane` has finished.

**Spawn ceiling** — each run is capped to two workers plus the orchestrator
(three lanes total). Steady-state reuses prior workers.

### `pollyRequestPrompt`

```
Orchestrator: <active displayName> (you, backend: <backendId>)
Workers: <worker-1>, <worker-2>
Cross-review: workers review each other; orchestrator synthesizes
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
      → spawns the two selected workers if missing; re-activates orchestrator
   d. if roster null → flash missing/errored backend, release, return
   e. dispatchTurn(activeLane, pollyRequestPrompt(...))
3. Orchestrator peer_send → workers → cross-review → synthesize
4. Human commits when satisfied
```

### UI Changes

- Help: `#polly <task>` — start Polly from this lane; spawns up to two selected workers
- Flash: `#polly: no task`, `#polly: cursor not installed` (etc.), `#polly: spawned …`

## Edge Cases

| Case | Handling |
|------|----------|
| Any orchestrator backend | Allowed |
| Worker backend not installed | `missing` → `#polly: <backend> not installed` |
| Worker spawn failed | `errored` → `#polly: <backend> failed to start` |
| Orchestrator shares pool backend | Exclude orchestrator backend; orchestrator never a worker |
| Only spawns selected cursor/claude/codex workers | Never spawns grok/pi/etc. |
| Duplicate worker lanes | First non-orchestrator live lane; else spawn |
| Reused worker busy | Inbox queues; drains on idle (no extra guard) |
| Orchestrator lane busy | `#cancel first` |
| `#cancel` | Aborts pending peers |

## Open Questions

None:

- **Q1 Orchestrator:** any lane. ✓
- **Q2 Spawn pool:** cursor + claude + codex only; two selected per run. ✓
- **Q3 Same-backend orchestrator:** exclude orchestrator backend; no duplicate worker for it. ✓

## Out of Scope

- Spawning backends outside cursor/claude/codex
- Git worktrees / PR-per-task
- Cross-harness `#polly`

## Resources

- [Omnigent Polly](https://github.com/omnigent-ai/omnigent/tree/main/examples/polly)
- Krypton `docs/145-harness-design-review-panel.md`
- Krypton `acp-harness-view.ts` — `addLane`
