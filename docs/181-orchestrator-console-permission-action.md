# Orchestrator Console — Permission Action — Implementation Spec

> Status: Implemented
> Date: 2026-06-30
> Milestone: M-ACP — Harness Multi-Agent
> Decision record: `docs/adr/0011-orchestrator-privileged-lane-and-acting-console.md` (extends)
> Terms: see `CONTEXT.md` → **Orchestrator**, **Orchestrator console**, **Dispatch**
> Related: `docs/180-orchestrator-console.md`, `docs/106-inter-lane-messaging.md`, spec 140/143 (permission classifier)

## Problem

A worker lane that pauses on `needs_permission` is invisible-to-act-on from the Orchestrator console: the human sees the lane is busy but must press `Enter` to jump into that lane, read the prompt, and answer there — then come back. The console already badges fleet state and *acts* (dispatch / interrupt / kill / restart) but cannot clear the single most common blocker. The operator wants to **answer a worker's pending permission from the console**, without leaving it.

## Solution

Surface each lane's pending permission in the console and let the human **accept / reject it in place**, reusing the existing `resolvePermission(lane, action, auto)` primitive (no new permission path). A lane in `needs_permission` gets a `⚠ perm` card tag; the **selected** card shows the pending tool + subject (the same compact label the lane view shows) and a contextual key hint. Permission keys take **precedence on the selected card** exactly as they do in the lane view (`handleKey` runs `handlePermissionKey` first): `a`/`A` accept (and accept-all-for-turn), `r`/`R` reject (and reject-all). **Safety carve-out:** a **high-risk** command (spec 140/143 classifier — `rm`, force-push, network/script/unparseable) cannot be *accepted* from the compact card — the console shows "⚠ high-risk — Enter to review in lane" and only reject is inline; you must jump to the lane (full tool detail / diff) to accept. No new state, no new Rust command, no new MCP tool.

## Research

- **The primitive is already lane-agnostic.** `resolvePermission(lane, 'accept'|'reject', auto, reason)` (`acp-harness-view.ts:6264`) operates on `lane.pendingPermissions[0]`, calls `lane.client.respondPermission(...)`, flips `needs_permission`→`busy` when the queue drains, and rolls back on transport failure. It takes *any* lane — the console can call it on the selected card with zero changes to the permission machinery.
- **Precedence is the established pattern.** In the lane view, `handleKey` checks `if (lane.pendingPermissions.length > 0) return this.handlePermissionKey(...)` **before** any other lane key (`acp-harness-view.ts:3458`), so a pending permission shadows everything (incl. restart) until answered. The console mirrors this: when the *selected* lane has a pending permission, `a/A/r/R` are permission keys and the restart `r` is shadowed for that lane while pending — same mental model, no new convention.
- **Keys `a` is free; `r` collides.** Console keys today: `j/k Enter d c x r o Esc` (`renderOrchestratorConsoleEl` footer, `handleOrchestratorKey` `:4716+`). `a` is unused. `r` is restart — resolved by precedence above (reject wins only while the selected card is awaiting permission), not by a new key.
- **Compact label already exists.** `compactPermissionLabel(permission, 'compact')` (`:13629`) and `compactPermissionMeta` (`:13636`, the lane head's `… · a/r/Esc` line) render the tool + subject; the console reuses `compactPermissionLabel`. High-risk test: `permissionCommandIsHighRisk(toolCall)` via `this.isHighRiskPermission(permission)` (`:6260`).
- **Accept/reject-all parity.** Lane view sets `lane.acceptAllForTurn`/`rejectAllForTurn` on `A`/`R` (`:9951`); the console sets the same flags so a console answer behaves identically to an in-lane one (later same-turn requests auto-resolve).
- **Live re-render is free.** The console already subscribes `LaneBus` while open (`:4555`); `resolvePermission` → `setLaneStatus` emits, so the card refreshes with no extra wiring.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| k9s | `:`-command / hotkey acts on the selected row; confirm dialogs for destructive ops | closest model — act on the selected live row, guard the dangerous verbs |
| tmux / Zellij | no cross-pane approval concept | n/a — no per-pane gated actions |
| VS Code / Zed agent panels | approve tool calls inline in the agent thread, in-context | Krypton's lane view already does this; the console is the *fleet-level* sibling |

**Krypton delta** — No terminal multiplexer has a fleet-level "approve another pane's gated action" surface; the nearest analogue is k9s acting on a selected resource row with confirm-guards on destructive ops. Krypton matches that (act on selection; high-risk needs the full-context view) and stays keyboard-first. It deliberately keeps the lane view's `a/r/Esc` muscle memory, differing only in that `Esc` stays "close console" (reject is `r`), so the operator never closes the console by reflexively rejecting.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Card render: `⚠ perm` tag for any `needs_permission` lane; selected card shows `compactPermissionLabel` + contextual hint (or high-risk notice). `handleOrchestratorKey`: when `selected.pendingPermissions.length > 0`, route `a/A/r/R` to a new `resolveSelectedConsolePermission(action, all)` **before** the `r`-restart branch; block inline accept when `isHighRiskPermission` (flash + hint to press Enter). Footer shows the permission keys while a selected permission is pending. |
| `src/styles/orchestrator-console.css` | `.acp-orchestrator__perm` (selected-card permission strip) + `.acp-orchestrator__tag--perm` (the `⚠ perm` card tag) + `--highrisk` modifier. Flat chrome, no left-border rails, no nested boxes (project constraints). |
| `src/acp/acp-harness-view.test.ts` | Unit-test the exported eligibility helper `consolePermissionAction({ pending, highRisk, action })` → `'accept' | 'reject' | 'blocked_highrisk' | 'none'` (the view needs a DOM, so the decision logic is extracted, per the file convention). |
| `docs/180-orchestrator-console.md` | Cross-link this follow-up (override table + keybindings note). |
| `docs/adr/0011-…md` | Note: per-request permission answering added to the console; persistent permission-*mode* setting stays out of scope. |
| `docs/PROGRESS.md` | Landing note **+ correct the stale spec-180 entry**: `:41-42` still says "No leader key … the command is the entry", but `` Leader ` `` shipped (docs/180:42, `acp-harness-view.ts:3335-3349`). Fix it in this same doc pass so the milestone index matches the implemented command surface. |

## Design

### Decision helper (pure, tested)

```ts
/** spec 181: what answering the selected card does. Accept of a high-risk
 *  command is blocked from the compact card (must open the lane); reject is
 *  always allowed inline; no pending permission → none. */
export function consolePermissionAction(opts: {
  pending: boolean;
  highRisk: boolean;
  action: 'accept' | 'reject';
}): 'accept' | 'reject' | 'blocked_highrisk' | 'none' {
  if (!opts.pending) return 'none';
  if (opts.action === 'reject') return 'reject';
  return opts.highRisk ? 'blocked_highrisk' : 'accept';
}
```

### Keys (console, while the SELECTED card has a pending permission)

| Key | Action | Calls |
|-----|--------|-------|
| `a` | accept the pending request | `resolvePermission(selected, 'accept', false)` |
| `A` | accept + accept-all-for-turn | accept, with `acceptAllForTurn` set **only if not blocked** (see below) |
| `r` | reject (shadows restart while pending) | `resolvePermission(selected, 'reject', false)` |
| `R` | reject + reject-all-for-turn | sets `rejectAllForTurn`, then reject |
| `Enter` | jump to the lane (full detail — required to accept high-risk) | existing jump |
| `Esc` | close console (unchanged — does NOT reject) | existing close |

When no permission is pending on the selected card, `r` is restart and `a` is unbound, exactly as today.

**`A`/`R` flag ordering (must be exact).** Compute `consolePermissionAction(...)` **first**, before touching any all-for-turn flag. On `blocked_highrisk` (an `A` on a high-risk command), **do not** mutate `acceptAllForTurn` — otherwise a blocked accept would silently arm accept-all for later same-turn non-high-risk requests. Set `acceptAllForTurn`/`rejectAllForTurn` only once the action has resolved to `accept`/`reject`, immediately before the `resolvePermission(...)` call:

```ts
const decision = consolePermissionAction({ pending, highRisk, action }); // 'accept'|'reject'|'blocked_highrisk'|'none'
if (decision === 'none') return;
if (decision === 'blocked_highrisk') { this.flashChip('high-risk — Enter to review in lane'); return; } // no flag mutation
if (all && decision === 'accept') selected.acceptAllForTurn = true;
if (all && decision === 'reject') selected.rejectAllForTurn = true;
void this.resolvePermission(selected, decision, all);
```

### Display

- **Every** `needs_permission` lane card gets a `<span class="acp-orchestrator__tag acp-orchestrator__tag--perm">⚠ perm</span>` (next to inbox/diff tags) so the operator sees which lanes need them and `j/k`s over.
- The **selected** card appends a permission strip: `compactPermissionLabel(p, 'compact')` + hint — `a accept · r reject` normally, or `⚠ high-risk · Enter to review · r reject` when `isHighRiskPermission`.
- `pendingPermissions.length > 1` shows `(+N more)` so the operator knows answering reveals the next.

### Data flow

```
1. Worker lane W emits permission_request → W.pendingPermissions.push; status needs_permission.
2. LaneBus fires → console re-renders: W card gets ⚠ perm; if W is selected, the strip shows the tool.
3. Human j/k to W, presses a (or r).
4. handleOrchestratorKey: pending>0 → consolePermissionAction(...). 'accept' on high-risk → flash
   "high-risk — Enter to review", no-op. Otherwise → resolvePermission(W, action, all).
5. resolvePermission answers via W.client.respondPermission; queue drains → status busy; LaneBus → re-render.
   Transport failure rolls back to needs_permission (existing behavior), flashed.
```

## Edge Cases

- **Selected card has no permission:** `a` unbound (ignored); `r` = restart (today's behavior).
- **High-risk accept from console:** blocked — flash + "Enter to review in lane"; reject still inline.
- **Multiple pending on one lane:** answering the head reveals the next immediately; `(+N more)` shown. The `LaneBus` subscription only fires on status *transitions*, and a queue mutation that keeps the lane `needs_permission` (answer-head-with-queue, a new request while already paused, or a transport rollback) emits nothing — so the console is refreshed **directly** at every permission-queue mutation via a guarded `refreshOrchestratorConsole()` (in the request-enqueue path and in `resolvePermission`'s shift / rollback), not via the bus. Without this the strip/`(+N more)`/legend would go stale while `a`/`r` act on the real new head (review follow-up).
- **Permission resolved in the lane (or auto) while console open:** LaneBus re-render drops the tag/strip; a stale `a` becomes a no-op (`pendingPermissions[0]` is gone — `resolvePermission` early-returns).
- **Selected lane goes `stopped` mid-answer:** `resolvePermission` returns on missing `lane.client`; no crash.
- **Seat lane itself awaiting permission:** allowed — the seat is a normal card too; answering it is the same path.

## Resolved Decisions

1. **High-risk inline accept** — *Resolved (implemented):* blocked — reject is inline, but accepting a high-risk command requires jumping to the lane (`Enter`) for the full detail/diff, per ADR-0011's "human keeps judgement." (A non-high-risk **edit/write** is still inline-acceptable from the compact strip without the diff — VCS-recoverable per spec 180/181; whether to also gate that behind the lane view is an open design question routed to the human, not part of this spec.)
2. **`Esc` semantics** — *Resolved (implemented):* `Esc` = close console (NOT reject), diverging from the lane view, so a reflexive `Esc` never silently denies a worker; reject is the explicit `r`/`R`.

## Out of Scope

- **Setting another lane's persistent permission *mode*** (`normal`/`acceptEdits`/`bypass`) — still deferred (spec 180 Out of Scope; would need its own ADR).
- **fs-write review prompts** (`fs_write_review`) — a separate gate from `pendingPermissions`; not actioned here in v1.
- **Autonomous/AI approval of worker permissions** — explicitly excluded (human-only).
- New Rust command, MCP tool, telemetry channel, or new lane state.

## Resources

- `src/acp/acp-harness-view.ts:6264` (`resolvePermission`), `:3458`/`:9947` (lane-view precedence + `handlePermissionKey`), `:13629`/`:13636` (compact label), `:6260`/`:13820` (high-risk classifier) — the reused machinery.
- `docs/180-orchestrator-console.md` — the console this extends.
- `docs/adr/0011-…md` — the governing decision (behavior-neutral role; human keeps judgement + kill switch).
- N/A external — purely internal change over existing permission + console code.
