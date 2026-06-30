# Orchestrator Console — Permission Action — Implementation Spec

> Status: Implemented
> Date: 2026-06-30
> Milestone: M-ACP — Harness Multi-Agent
> Decision record: `docs/adr/0011-orchestrator-privileged-lane-and-acting-console.md` (extends)
> Terms: see `CONTEXT.md` → **Orchestrator**, **Orchestrator console**, **Dispatch**
> Related: `docs/180-orchestrator-console.md`, `docs/184-orchestrator-console-global-permission-queue.md`, `docs/106-inter-lane-messaging.md`, spec 140/143 (permission classifier)
>
> **Superseded surface (spec 184):** the *selected-card* answer strip below is now a **global pending-permission queue** band — answering targets the focused queue item (not the card selection) and never switches the active lane. The decision helper, `resolvePermission` reuse, accept/reject-all parity, and high-risk full-command review described here are unchanged and carried into spec 184. Read this for the permission-answer mechanics; read 184 for the surface.

## Problem

A worker lane that pauses on `needs_permission` is invisible-to-act-on from the Orchestrator console: the human sees the lane is busy but must press `Enter` to jump into that lane, read the prompt, and answer there — then come back. The console already badges fleet state and *acts* (dispatch / interrupt / kill / restart) but cannot clear the single most common blocker. The operator wants to **answer a worker's pending permission from the console**, without leaving it.

## Solution

Surface each lane's pending permission in the console and let the human **accept / reject it in place**, reusing the existing `resolvePermission(lane, action, auto)` primitive (no new permission path). A lane in `needs_permission` gets a `⚠ perm` card tag; the **selected** card shows the pending tool + subject (the same compact label the lane view shows) and a contextual key hint. Permission keys take **precedence on the selected card** exactly as they do in the lane view (`handleKey` runs `handlePermissionKey` first): `a`/`A` accept (and accept-all-for-turn), `r`/`R` reject (and reject-all). **High-risk handling (revised — see Resolved Decisions):** a **high-risk** command (spec 140/143 classifier — `rm`, force-push, network/script/unparseable) is **also accepted inline** from the console; the selected-card strip surfaces the **full, untruncated command** (`extractCommandLineRaw`, never the 48-char label, which could hide a destructive tail) plus a `⚠ high-risk` marker so the human reviews it in the console — no jump to the lane required. No new state, no new Rust command, no new MCP tool.

## Research

- **The primitive is already lane-agnostic.** `resolvePermission(lane, 'accept'|'reject', auto, reason)` (`acp-harness-view.ts:6264`) operates on `lane.pendingPermissions[0]`, calls `lane.client.respondPermission(...)`, flips `needs_permission`→`busy` when the queue drains, and rolls back on transport failure. It takes *any* lane — the console can call it on the selected card with zero changes to the permission machinery.
- **Precedence is the established pattern.** In the lane view, `handleKey` checks `if (lane.pendingPermissions.length > 0) return this.handlePermissionKey(...)` **before** any other lane key (`acp-harness-view.ts:3458`), so a pending permission shadows everything (incl. restart) until answered. The console mirrors this: when the *selected* lane has a pending permission, `a/A/r/R` are permission keys and the restart `r` is shadowed for that lane while pending — same mental model, no new convention.
- **Keys `a` is free; `r` collides.** Console keys today: `j/k Enter d c x r o Esc` (`renderOrchestratorConsoleEl` footer, `handleOrchestratorKey` `:4716+`). `a` is unused. `r` is restart — resolved by precedence above (reject wins only while the selected card is awaiting permission), not by a new key.
- **Compact label already exists.** `compactPermissionLabel(permission, 'compact')` (`:13629`) and `compactPermissionMeta` (`:13636`, the lane head's `… · a/r/Esc` line) render the tool + subject; the console reuses `compactPermissionLabel`. High-risk test: `permissionCommandIsHighRisk(toolCall)` via `this.isHighRiskPermission(permission)` (`:6260`). The **full untruncated command** for high-risk review comes from `extractCommandLineRaw(toolCall.rawInput)` — the same source the spec-143 classifier reads, so the strip can never show a shorter string than the classifier judged.
- **Accept/reject-all parity.** Lane view sets `lane.acceptAllForTurn`/`rejectAllForTurn` on `A`/`R` (`:9951`); the console sets the same flags so a console answer behaves identically to an in-lane one (later same-turn requests auto-resolve).
- **Live re-render is free.** The console already subscribes `LaneBus` while open (`:4555`); `resolvePermission` → `setLaneStatus` emits, so the card refreshes with no extra wiring.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| k9s | `:`-command / hotkey acts on the selected row; confirm dialogs for destructive ops | closest model — act on the selected live row, guard the dangerous verbs |
| tmux / Zellij | no cross-pane approval concept | n/a — no per-pane gated actions |
| VS Code / Zed agent panels | approve tool calls inline in the agent thread, in-context | Krypton's lane view already does this; the console is the *fleet-level* sibling |

**Krypton delta** — No terminal multiplexer has a fleet-level "approve another pane's gated action" surface; the nearest analogue is k9s acting on a selected resource row with confirm-guards on destructive ops. Krypton matches that (act on selection) and stays keyboard-first — but rather than guard a destructive verb behind a separate view, it **inlines the review**: the full command renders on the strip so the dangerous accept is informed, not deferred. It deliberately keeps the lane view's `a/r/Esc` muscle memory, differing only in that `Esc` stays "close console" (reject is `r`), so the operator never closes the console by reflexively rejecting.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Card render: `⚠ perm` tag for any `needs_permission` lane; selected card shows `compactPermissionLabel` + contextual hint, and for a high-risk request the **full untruncated command** (`extractCommandLineRaw`) for in-console review. `handleOrchestratorKey`: when `selected.pendingPermissions.length > 0`, route `a/A/r/R` to `answerSelectedConsolePermission(...)` **before** the `r`-restart branch (high-risk accepted inline too). Footer shows the permission keys while a selected permission is pending. |
| `src/styles/orchestrator-console.css` | `.acp-orchestrator__perm` (selected-card permission strip) + `.acp-orchestrator__tag--perm` (the `⚠ perm` card tag) + `--highrisk` modifier (danger tint, no rail) + `.acp-orchestrator__perm-command` (full command, monospace, wraps). Flat chrome, no left-border rails, no nested boxes (project constraints). |
| `src/acp/acp-harness-view.test.ts` | Unit-test the exported helper `consolePermissionAction({ pending, action })` → `'accept' | 'reject' | 'none'` (the view needs a DOM, so the decision logic is extracted, per the file convention). |
| `docs/180-orchestrator-console.md` | Cross-link this follow-up (override table + keybindings note). |
| `docs/adr/0011-…md` | Note: per-request permission answering added to the console; persistent permission-*mode* setting stays out of scope. |
| `docs/PROGRESS.md` | Landing note **+ correct the stale spec-180 entry**: `:41-42` still says "No leader key … the command is the entry", but `` Leader ` `` shipped (docs/180:42, `acp-harness-view.ts:3335-3349`). Fix it in this same doc pass so the milestone index matches the implemented command surface. |

## Design

### Decision helper (pure, tested)

```ts
/** spec 181 (+ follow-up): a pending request resolves to its action inline —
 *  high-risk included (the strip shows its full command for review). No pending
 *  permission → none. */
export function consolePermissionAction(opts: {
  pending: boolean;
  action: 'accept' | 'reject';
}): 'accept' | 'reject' | 'none' {
  if (!opts.pending) return 'none';
  return opts.action;
}
```

### Keys (console, while the SELECTED card has a pending permission)

| Key | Action | Calls |
|-----|--------|-------|
| `a` | accept the pending request (high-risk included) | `resolvePermission(selected, 'accept', false)` |
| `A` | accept + accept-all-for-turn | sets `acceptAllForTurn`, then accept |
| `r` | reject (shadows restart while pending) | `resolvePermission(selected, 'reject', false)` |
| `R` | reject + reject-all-for-turn | sets `rejectAllForTurn`, then reject |
| `Enter` | jump to the lane (optional — for the full transcript/diff context) | existing jump |
| `Esc` | close console (unchanged — does NOT reject) | existing close |

When no permission is pending on the selected card, `r` is restart and `a` is unbound, exactly as today.

**`A`/`R` flag ordering.** Compute `consolePermissionAction(...)` **first**; a `none` decision returns before touching any all-for-turn flag. Set `acceptAllForTurn`/`rejectAllForTurn` only once the action has resolved, immediately before the `resolvePermission(...)` call:

```ts
const decision = consolePermissionAction({ pending, action }); // 'accept'|'reject'|'none'
if (decision === 'none') return;
const flags = armConsolePermissionFlags(key, decision);
if (flags.acceptAll) selected.acceptAllForTurn = true;
if (flags.rejectAll) selected.rejectAllForTurn = true;
void this.resolvePermission(selected, decision, flags.acceptAll || flags.rejectAll);
```

### Display

- **Every** `needs_permission` lane card gets a `<span class="acp-orchestrator__tag acp-orchestrator__tag--perm">⚠ perm</span>` (next to inbox/diff tags) so the operator sees which lanes need them and `j/k`s over.
- The **selected** card appends a permission strip: `compactPermissionLabel(p, 'compact')` + hint — `a accept · r reject` normally; for a high-risk request it also renders the **full untruncated command** on its own line (`.acp-orchestrator__perm-command`) and a `⚠ high-risk · a accept · r reject` hint, so the destructive tail is always visible before the human accepts.
- `pendingPermissions.length > 1` shows `(+N more)` so the operator knows answering reveals the next.

### Data flow

```
1. Worker lane W emits permission_request → W.pendingPermissions.push; status needs_permission.
2. LaneBus fires → console re-renders: W card gets ⚠ perm; if W is selected, the strip shows the tool.
3. Human j/k to W; for a high-risk request the strip shows the full command; presses a (or r).
4. handleOrchestratorKey: pending>0 → consolePermissionAction(...) → resolvePermission(W, action, all).
5. resolvePermission answers via W.client.respondPermission; queue drains → status busy; LaneBus → re-render.
   Transport failure rolls back to needs_permission (existing behavior), flashed.
```

## Edge Cases

- **Selected card has no permission:** `a` unbound (ignored); `r` = restart (today's behavior).
- **High-risk accept from console:** allowed inline — the strip first surfaces the full untruncated command + a `⚠ high-risk` marker so the human reviews it in place; reject is the same `r`.
- **High-risk with no extractable command** (unparseable execute surface): the marker still shows but there is no command line to render — the operator sees `⚠ high-risk` on the compact label and decides (reject is the conservative default, but accept is theirs to make).
- **Multiple pending on one lane:** answering the head reveals the next immediately; `(+N more)` shown. The `LaneBus` subscription only fires on status *transitions*, and a queue mutation that keeps the lane `needs_permission` (answer-head-with-queue, a new request while already paused, or a transport rollback) emits nothing — so the console is refreshed **directly** at every permission-queue mutation via a guarded `refreshOrchestratorConsole()` (in the request-enqueue path and in `resolvePermission`'s shift / rollback), not via the bus. Without this the strip/`(+N more)`/legend would go stale while `a`/`r` act on the real new head (review follow-up).
- **Permission resolved in the lane (or auto) while console open:** LaneBus re-render drops the tag/strip; a stale `a` becomes a no-op (`pendingPermissions[0]` is gone — `resolvePermission` early-returns).
- **Selected lane goes `stopped` mid-answer:** `resolvePermission` returns on missing `lane.client`; no crash.
- **Seat lane itself awaiting permission:** allowed — the seat is a normal card too; answering it is the same path.

## Resolved Decisions

1. **High-risk inline accept** — *Revised (implemented):* high-risk commands are now **accepted inline from the console**, no lane jump required. The first cut blocked them (accept needed `Enter` into the lane for the full detail/diff), but the operator wanted the whole confirm to live in the console. ADR-0011's "human keeps judgement" is preserved differently: rather than forcing the lane view, the console **brings the review to the console** — the selected-card strip renders the **full, untruncated command** (via `extractCommandLineRaw`, the same source the spec-143 classifier reads, so a destructive tail past the 48-char label is never hidden) under a `⚠ high-risk` marker. The human reads the real command and decides in place. Jumping to the lane (`Enter`) is still available for the full transcript/diff but is no longer mandatory.
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
