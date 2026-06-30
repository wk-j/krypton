# Orchestrator Console — Global Permission Queue — Implementation Spec

> Status: Implemented
> Date: 2026-06-30
> Milestone: M-ACP — Harness Multi-Agent
> Decision record: `docs/adr/0011-orchestrator-privileged-lane-and-acting-console.md` (extends)
> Terms: see `CONTEXT.md` → **Orchestrator**, **Orchestrator console**
> Related: `docs/180-orchestrator-console.md`, `docs/181-orchestrator-console-permission-action.md`, `docs/106-inter-lane-messaging.md`, spec 140/143 (permission classifier)

## Problem

Spec 181 let the human answer a worker lane's pending `needs_permission` from the console — but only on the **selected** card: the operator had to `j/k` onto the paused lane first, and `selectOrchestratorCard` calls `activateLane`, so reaching a permission **switches the active lane in the background** (the transcript behind the console follows the selection). With several lanes paused at once there was no single fleet view of *what is waiting*, and confirming any one of them meant navigating to it — i.e. switching lane to confirm. The operator wants pending permissions surfaced as **global fleet state** and answerable **without switching lane**.

## Solution

Render a **global pending-permission queue** as a band above the console body, shown whenever any live lane is awaiting a permission. One row per awaiting lane (its head request), in grid order, with the **focused** row marked as the `a`/`r` target. `a`/`A` accept (+accept-all), `r`/`R` reject (+reject-all) answer the **focused queue item** — **not** the card selection — and **do not call `activateLane`**, so confirming never moves the operator's vantage. `Tab` / `Shift+Tab` step the focus through the queue when more than one lane is paused. The per-card selected-strip from spec 181 is **replaced** by this single global surface (the `⚠ perm` card tag stays for at-a-glance). High-risk handling from the spec-181 follow-up is preserved per row: the row shows the **full, untruncated command** + a `⚠ high-risk` marker so the dangerous accept is reviewed in place. No new state beyond a focus cursor, no new Rust command, no new MCP tool.

## Research

- **The queue is derivable, not stored.** Every lane already owns `pendingPermissions[]`; the fleet queue is just `orchestratorCards().filter(l => l.pendingPermissions.length > 0)` in grid order. `pendingPermissionLanes()` / `orchestratorPermFocusLane()` derive it on each render — nothing persisted but the focus id.
- **`resolvePermission` is already lane-agnostic (spec 181).** `resolvePermission(lane, action, auto, reason)` takes *any* lane; the global queue calls it on the focused lane with zero changes to the permission machinery.
- **Answering must not switch lanes.** `selectOrchestratorCard` → `activateLane` (spec 180) re-points the background active lane. The global path deliberately does **not** select/activate — it answers `orchestratorPermFocusLane()` directly, so the active lane is untouched.
- **Precedence mirrors the lane view, now globally.** In a lane, a pending permission shadows other keys (`handleKey` runs `handlePermissionKey` first). The console now does this **fleet-wide**: while any lane is paused, `a/A/r/R` and `Tab` are permission keys (so `r` is reject, shadowing restart); `j/k` still select cards beneath the queue, `c`/`x` still act on the selection.
- **Live re-render is already wired.** The console subscribes `LaneBus` while open and `refreshOrchestratorConsole()` runs on every permission-queue mutation (spec 181 review follow-up), so the band, focus fallback, and `(+N more)` stay current with no extra wiring.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| k9s | a single live table of resources; hotkeys act on the focused row | the queue is the same idea narrowed to "things awaiting my decision" |
| CI dashboards (approvals) | a global list of pending approvals, each actioned in place | closest analogue — approve/deny from one list, no per-item navigation |
| Krypton lane view | per-lane inline permission prompt | the console queue is the fleet-level aggregate of exactly these |

**Krypton delta** — A terminal multiplexer has no fleet-wide "things awaiting my approval" surface; Krypton aggregates every lane's pending permission into one queue, answerable without focusing each pane, and keeps the lane view's `a/r` muscle memory.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | New `orchestratorPermFocusId` (queue cursor). `pendingPermissionLanes()` + `orchestratorPermFocusLane()` derive the fleet queue + focus (with head fallback). `renderOrchestratorPermQueue()` renders the band (replaces the per-card `renderOrchestratorPermission`); inserted between `__head` and `__body`; summary gains `· N perm`. `handleOrchestratorKey`: while the queue is non-empty, `a/A/r/R` answer the focused lane via `answerConsolePermission` (no `activateLane`) and `Tab`/`Shift+Tab` step the focus — both **before** the card-dependent keys. Legend updated. The per-card strip is removed (the `⚠ perm` tag stays). |
| `src/styles/orchestrator-console.css` | `.acp-orchestrator__permq` (the band) + `.acp-orchestrator__perm--focus` (ring on the target row) + `.acp-orchestrator__perm-lane` (lane name); the existing `.acp-orchestrator__perm*` rules are reused as queue rows. Flat chrome, no left-border rails, no nested boxes. |
| `docs/180/181`, `docs/adr/0011-…md`, `docs/PROGRESS.md` | Cross-links + landing note; spec 181's selected-card answer surface is superseded by this global queue. |

## Design

### State

```ts
private orchestratorPermFocusId: string | null = null; // laneId of the focused queue item; falls back to the head
```

### Queue + focus (derived)

```ts
pendingPermissionLanes(): HarnessLane[]  // orchestratorCards() with a pending permission, grid order
orchestratorPermFocusLane(): HarnessLane | null  // focus id while still pending, else queue head
```

The focus is a *soft* pointer: when the focused lane drains (answered, or resolved in-lane/auto), `orchestratorPermFocusLane()` falls back to the new head, so hammering `a` clears the fleet backlog top-down without re-aiming.

### Region (band above the body)

```
.acp-orchestrator__head        seat · summary "3 lanes · 1 busy · … · 2 perm"
.acp-orchestrator__permq       ← shown only when ≥1 lane is awaiting (this spec)
│   └─ .acp-orchestrator__perm[ --focus ][ --highrisk ]   (one row per awaiting lane)
│        lane name · compact tool label · (+N more) · [full command if high-risk] · hint
.acp-orchestrator__body        lanes · feed · reserved (unchanged)
…dispatch · seat-prompt · keys
```

### Keys (console, while ≥1 lane is awaiting permission)

| Key | Action | Calls |
|-----|--------|-------|
| `a` | accept the focused queue item (high-risk included) | `resolvePermission(focus, 'accept', false)` |
| `A` | accept + accept-all-for-turn | sets `acceptAllForTurn`, then accept |
| `r` | reject the focused item (shadows restart while any pending) | `resolvePermission(focus, 'reject', false)` |
| `R` | reject + reject-all-for-turn | sets `rejectAllForTurn`, then reject |
| `Tab` / `Shift+Tab` | step the focus to the next / prev awaiting lane | focus id only |
| `j` / `k` | still select cards beneath the queue (activates lane) | unchanged |
| `c` / `x` | interrupt / kill the selected card | unchanged |
| `Esc` / `q` | close console (never rejects) | unchanged |

`answerConsolePermission` is the spec-181 `answerSelectedConsolePermission` generalized to any lane (the focused one); flag ordering (`consolePermissionAction` → `armConsolePermissionFlags`) is unchanged.

### Display

- The band renders only when ≥1 lane is awaiting; the head summary always shows `· N perm` while pending, so a glance (even with the band scrolled) reports fleet permission state.
- The **focused** row is ringed and carries the `a accept · r reject` hint; non-focused rows show their label (and a `⚠ high-risk` marker if applicable) but no hint.
- High-risk rows render the **full untruncated command** (`extractCommandLineRaw`) on its own line — the destructive tail is never hidden behind the 48-char label.

## Edge Cases

- **No lanes awaiting:** the band is absent; `a` is unbound and `r` is restart, exactly as spec 180.
- **Focused lane resolved elsewhere (in-lane / auto) while open:** the `LaneBus`/`refreshOrchestratorConsole` re-render drops its row and the focus falls back to the new head; a stale `a` is a no-op (`resolvePermission` early-returns on a drained head).
- **One lane, multiple queued:** one row with `(+N more)`; answering the head reveals the next (same lane stays the focus until its queue empties).
- **Focused lane goes `stopped` mid-answer:** `resolvePermission` returns on the missing `lane.client`; no crash; the row drops on re-render.
- **`Tab` with a single awaiting lane:** no-op (wraps to itself).

## Resolved Decisions

1. **Answer target = focused queue item, not card selection** — *Resolved (implemented):* decoupling the answer from `j/k` is the whole point ("confirm without switching lane"); `j/k` selection still activates the background lane (its existing job), but `a/r` never do.
2. **FIFO/grid-ordered queue with `Tab` to retarget** — *Resolved (implemented):* the default target is the grid-order head; `Tab` reaches any specific item (e.g. to reject a high-risk one first) without `j/k`-activating its lane.
3. **Per-card strip removed** — *Resolved (implemented):* a single global surface avoids two answer paths with different targets (selected card vs. queue head) and matches the "global state" ask; the `⚠ perm` card tag remains for at-a-glance.

## Out of Scope

- **Setting another lane's persistent permission *mode*** (`normal`/`acceptEdits`/`bypass`) — still deferred (spec 180/181; needs its own ADR).
- **fs-write review prompts** (`fs_write_review`) — a separate gate; not actioned here.
- **Autonomous/AI approval of worker permissions** — human-only.
- New Rust command, MCP tool, telemetry channel, or new lane state (only the focus cursor is added).

## Resources

- `docs/181-orchestrator-console-permission-action.md` — the per-card answer surface this generalizes.
- `docs/180-orchestrator-console.md` — the console + `selectOrchestratorCard`/`activateLane` it deliberately bypasses.
- `src/acp/acp-harness-view.ts` — `resolvePermission` (reused), `isHighRiskPermission`, `extractCommandLineRaw`.
- `docs/adr/0011-…md` — the governing decision (human keeps judgement + kill switch).
