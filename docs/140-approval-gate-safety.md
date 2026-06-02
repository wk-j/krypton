# Approval Gate Safety — Implementation Spec

> Status: Implemented (option A — blanket writes + low-risk command stay armed-able; revised after Cursor-1 peer review)
> Date: 2026-06-02
> Milestone: Agent View hardening (ACP harness)

## Problem

When the agent requests a file write or bash command, the gate offers `a`/`r` (this one) and `A`/`R` (whole turn). A single Shift keypress arms `acceptAllWritesForTurn` / `acceptAllCommandsForTurn`, after which every subsequent write/command auto-resolves silently (`agent-view.ts:718`, `:839`). There is **no visible armed state, no disarm, and no severity gating** — the only differentiator between the safe and the turn-wide choice is a 6px hint (`agent-view.ts:940`). A reflexive Shift-A can authorize unbounded writes/commands (including `rm`, currently classified the same as `touch`) for the rest of the turn, with no undo.

## Solution

Keep one-keystroke whole-turn approval (power users want it) but make it **safe and legible**, mirroring Claude Code's "auto-accept edits" model (always-visible mode, toggle off anytime, bash never blanket-approved):

1. **Armed-state indicator** — a persistent segment in the existing status line whenever a turn-wide flag is armed (`⚠ AUTO-RUN · esc to stop`). Reuses the view's strongest surface (telemetry) as the safety surface.
2. **Disarm key** — `Esc` clears any armed turn-wide flag (without aborting the agent), takes precedence over other Esc behaviors when armed.
3. **High-risk gating** — destructive / unparseable commands are excluded from whole-turn accept and from armed auto-run; they always prompt individually. Conservative by default (unknown ⇒ high-risk), per the Cursor denylist-bypass lesson.

## Research

- **Current code.** `tools.ts:22` `BashRisk = 'write' | 'git' | 'network' | 'script' | 'unknown'` — a category, **not** a severity. `rm`/`rmdir` are classified `write` (`tools.ts:207`), identical to `touch`. `WriteApprovalRequest` (`tools.ts:11`) carries no risk at all. Turn flags reset on `agent_start` (`agent-view.ts:1241-1244`), so "turn" = one agent run. Approvals resolve oldest-first (`resolveOldestWriteApproval`, `:796`). The status line renders from `TokenUsage` in `renderStatusLine` (`:2306`). Esc is already handled at `:1842`.
- **Reversibility.** Writes show a diff before approval and are recoverable via VCS — lower stakes for blanket accept. Bash commands are the unbounded surface; this is why the gating focuses on commands (matching Claude Code, which auto-accepts edits but never blanket-approves bash).
- **Status-line DOM is destructive (verified).** `renderStatusLine` (`agent-view.ts:2325`) sets `this.statusLineEl.textContent = …` on every `usage_update`, wiping all child nodes. Timer and spinner are `prepend`ed child spans (`:2388`, `:2413`) and silently get clobbered + recreated each tick — a latent bug. An armed-indicator child added the naive way would not survive. The status line must become a **stable set of child segments** with only the telemetry text rewritten.
- **Key routing (verified).** `onKeyDown` (`agent-view.ts:1819`) runs approval handlers → input/scroll. `a`/`r`/`A`/`R` reach the approval handlers regardless of `state` (they run first), but `Esc` does not — it is consumed by `handleInputKey` (`:1842`) or `handleScrollKey`. So disarm cannot live in the approval handlers; it must be an early check in `onKeyDown` gated on `isAnyTurnApprovalArmed()`.
- **Classification source (verified).** `classifyBashCommand` (`tools.ts:154`) already returns `{ needsApproval, risk, reason }` in one parse; `alwaysWrite` lumps `rm`/`dd`/`truncate`/`mv`/`cp`/`chmod`/`chown`/`ln`/`rsync`/`sed` all as `risk: 'write'`. High-risk must be computed there as a 4th field (one parser, one source of truth, unit-testable), not re-derived in the view.

### Peer review (Cursor-1)

Cursor-1 reviewed the draft adversarially; all load-bearing findings were re-verified against source and folded in: (1) status-line segment refactor is the big-ticket item, not a CSS add-on; (2) disarm routing must cover all states + the no-pending-rows case; (3) the destructive substring list is the fragile half and low-risk `write` bash stays blanket-able — an explicit product call, below; (4) compute `highRisk` in the classifier with table-driven tests.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code | `Shift+Tab` cycles normal → "auto-accept edits" → plan. Mode shown persistently in the UI; toggle off anytime. acceptEdits covers file edits + basic fs commands; **all other bash still prompts**. | Gold standard: armed state always visible + instantly reversible; bash never blanket-approved. |
| Cursor (YOLO / auto-run) | Allowlist + denylist of commands; auto-runs matching commands. Denylist shown bypassable (e.g. base64-encoded `curl`); Cursor deprecating denylist in favor of allowlist. | Lesson: blocking "dangerous" commands by pattern is fragile — be conservative, treat unknown as high-risk. |
| Aider | `--yes-always` for blanket yes; `/undo` reverts the last change; still confirms shell commands by default. | Provides an undo path; Krypton relies on VCS instead. |
| Zed agent | Per-tool "always allow" toggles; tool calls confirmed inline. | Per-tool granularity rather than per-turn. |

**Krypton delta** — Match Claude Code's persistent-visible-armed-state + easy-disarm, and its "never blanket-approve bash" stance (here generalized to "never blanket-approve high-risk commands"). Diverge: arming happens via `Shift` at the gate (no separate pre-arm mode toggle), and disarm is `Esc` (keyboard-first, no mouse). We do not implement a configurable allowlist (out of scope).

## Affected Files

| File | Change |
|------|--------|
| `src/agent/tools.ts` | `classifyBashCommand` returns a 4th field `highRisk`; set it for destructive verbs (`rm`, `rmdir`, `dd`, `mkfs*`, `shred`, `truncate`, `sed -i`, `chmod`, `chown`, `mv`, `cp`, `ln`, `rsync`) and dangerous git (`reset --hard`, `clean -fd`, `checkout .`, `push --force`), plus `risk ∈ {script, network, unknown}`. Carry `highRisk` onto `BashApprovalRequest`. No new `BashRisk` value, no `isHighRisk` passthrough. |
| `src/agent/tools.test.ts` (new) | Table-driven tests for `classifyBashCommand`: `rm -rf`, `touch x`, `mkdir`, `dd`, `git push --force`, `git status`, `git reset --hard`, `foo && rm bar`, `bash -c '…'`, redirection/heredoc, unparseable, read-only allowlisted. |
| `src/agent/agent-view.ts` | **Refactor status line into stable child segments** (`[spinner][timer][armed][telemetry]`); `renderStatusLine` rewrites only the telemetry span. Add `disarmTurnApprovals()` / `isAnyTurnApprovalArmed()` / `renderArmedIndicator()`; early Esc-disarm check in `onKeyDown` (all states). Gate command `A` by `highRisk` in both `handleCommandApprovalKey` and `resolveOldestCommandApproval` (coerce `applyToTurn=false`); keep the guard in `requestCommandApproval` so armed auto-run still prompts high-risk. Store `dataset.highRisk` on command rows; dim/hide `[A] all` when high-risk. Wire `renderArmedIndicator()` into the `agent_start` flag reset (`:1241`). |
| `src/styles/agent.css` | `.agent-view__armed` segment + `.agent-view__msg-review-risk` chip (worded LOW/HIGH + color); distinct turn-wide affordance. Static (reduced-motion safe). |
| `docs/PROGRESS.md` | Note the feature on implementation. |

## Design

### Data Structures

```ts
// tools.ts — computed once in the existing parser, no second pass
function classifyBashCommand(command: string):
  { needsApproval: boolean; risk: BashRisk; reason: string; highRisk: boolean };

export interface BashApprovalRequest {
  id: string; command: string; cwd: string | null;
  risk: BashRisk; reason: string;
  highRisk: boolean;            // NEW — additive; category (risk) stays honest for telemetry
}
```

`highRisk = true` when a segment's verb is destructive (see Affected Files list) OR `risk ∈ {script, network, unknown}`. `category = write` and `policy = highRisk` are **separate axes** — do not assume `highRisk === (risk === 'unknown')`. Writes (`WriteApprovalRequest`) are never auto-classified high-risk (diff shown + VCS-recoverable).

### State & Methods (`agent-view.ts`)

```ts
private disarmTurnApprovals(): boolean;  // clears the 4 *ForTurn flags; returns true if any was set
private isAnyTurnApprovalArmed(): boolean;
private renderArmedIndicator(): void;    // shows/hides the dedicated armed child segment

// onKeyDown — NEW first branch, before approval/input/scroll routing:
if (e.key === 'Escape' && this.isAnyTurnApprovalArmed()) {
  this.disarmTurnApprovals();             // works in any state, even with no pending rows
  return true;
}
```

**Status-line refactor (prerequisite).** Build the status line once as stable child spans `[spinner?][timer?][armed?][telemetry]`; `renderStatusLine` rewrites only the `.agent-view__telemetry` text. Spinner/timer/armed are managed by their own helpers. This also fixes the existing clobber/recreate churn so the armed segment survives every `usage_update`.

- `renderArmedIndicator()`: shows/hides `.agent-view__armed`, naming **what** is armed — `AUTO-RUN FILES` / `CMDS` / `FILES+CMDS` / `AUTO-BLOCK`, suffixed `· esc`. Called after any arm/disarm and from the `agent_start` reset (`:1241`).
- `handleCommandApprovalKey`: `A` while the oldest pending is `highRisk` → resolve that ONE as accept (no arming) + hint "high-risk · per-command only".
- `resolveOldestCommandApproval`: coerce `applyToTurn=false` when the resolved pending is `highRisk` (defense in depth, not only the key handler).
- `requestCommandApproval`: armed `acceptAllCommandsForTurn` but incoming request is `highRisk` → still prompt individually.

### Data Flow (arm → safety → disarm)

```
1. Agent requests write/command → gate row appended (oldest-first).
2. User presses A (non-high-risk) → acceptAll*ForTurn = true.
3. renderArmedIndicator() shows "⚠ AUTO-RUN · esc to stop" in the status line.
4. Subsequent non-high-risk requests auto-resolve; high-risk ones still prompt.
5. User presses Esc → disarmTurnApprovals() clears flags, indicator hidden,
   system message "auto-approval disarmed". (No agent abort.)
6. agent_start (next turn) resets flags anyway (existing behavior).
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `a` / `r` | pending approval | accept / reject this one (unchanged) |
| `A` / `R` | pending approval, not high-risk | arm accept-all / reject-all for turn |
| `A` | pending approval, **high-risk** | accept this one only; no arm; show hint |
| `Esc` | any turn flag armed (any `state`, even with no pending rows) | disarm; takes precedence over mention/autocomplete/scroll dismiss |

### UI Changes (`agent.css`)

- `.agent-view__armed` — status-line segment, amber/red, `tabular-nums`, no infinite animation (reduced-motion safe).
- `.agent-view__msg-review-risk` — risk chip (worded LOW/HIGH + color), replaces the flat `[risk]` string.
- Turn-wide keys rendered distinctly (e.g. `[A] all` on its own, dimmer/separated from `[a]`), not just a 6px hint.

### Configuration

None. (Allowlist config is out of scope.)

## Edge Cases

- **Esc with nothing armed** → falls through to existing Esc behavior (mention/ac dismiss, scroll exit). Disarm only intercepts when `isAnyTurnApprovalArmed()`.
- **Esc precedence vs mention/autocomplete** → when armed, Esc disarms first (safety > dismiss). Rare: a user who `Shift-A`'d then opens `@` mention and hits Esc gets a disarm instead of a popup close. Acceptable; one keystroke recovers.
- **Esc in scroll state while armed** → handled, because the disarm check is the first branch of `onKeyDown`, before `handleScrollKey`.
- **Approval keys in scroll state** → `a`/`r`/`A`/`R` already route through the approval handlers (which run before the state branch), so no change needed there.
- **Mixed pending (some high-risk)** → `A` arms for non-high-risk; high-risk rows stay pending and must be resolved individually.
- **Armed + high-risk arrives** → individual prompt despite armed flag (guarded in `requestCommandApproval`).
- **Reject-all (`R`)** → also shows an armed indicator (`AUTO-BLOCK`) and is disarmable (safe direction, but state must stay legible).
- **Ctrl+C abort** → existing behavior; rejects pending + ends turn (flags reset on next `agent_start`).
- **Reduced motion** → armed indicator is static; no new `@media (prefers-reduced-motion)` entry needed.
- **50KB+ write** → diff is skipped (`tools.ts:258`) but the row still auto-approves when `acceptAllWritesForTurn` is armed — consistent with the product call below.

## Product Decision — blanket writes & low-risk write-bash stay armed-able

Per Cursor-1 review: this design intentionally keeps `acceptAllWritesForTurn` (file writes) and low-risk `write`-category bash (`touch`, `mkdir`, `mv`, `chmod`, …) **blanket-approvable** under an armed flag — weaker than Claude Code, which blanket-approves edits but never any bash. Rationale: writes show a diff + are VCS-recoverable, and the armed indicator now names exactly what is live (`FILES` / `CMDS`). Only genuinely destructive / unparseable commands are excluded. **If the user prefers the stricter Claude-Code stance (no blanket bash at all), say so at approval** and the spec drops whole-turn accept for all command rows, keeping it for writes only.

## Open Questions

None blocking. Resolved: (1) `highRisk` computed in `classifyBashCommand` as a 4th field rather than a new `BashRisk` enum value, keeping `risk` category honest for telemetry; (2) blanket-write stance is a stated product call (above) the user confirms at approval.

## Out of Scope

- Configurable per-command allowlist / persistent cross-session policy (Cursor-style).
- Changing the pi-agent-core approval protocol or the `WriteApprovalRequest` shape.
- The `--agent-gold-rgb` token bug and the `layout-transition` (logo `max-height`) finding — tracked separately.
- An `/undo` for already-applied writes (we rely on VCS).

## Resources

- [Claude Code — Permission modes](https://code.claude.com/docs/en/permission-modes) — acceptEdits scope; bash still prompts; Shift+Tab cycle.
- [Boris Cherny — auto-accept mode (Shift+Tab, tab in/out anytime)](https://www.threads.com/@boris_cherny/post/DHWS57syYez/) — persistent toggle + easy reversal pattern.
- [Backslash — Cursor auto-run denylist bypass](https://www.backslash.security/blog/cursor-ai-security-flaw-autorun-denylist) — denylist fragility (base64 `curl`); argues for conservative/allowlist stance.
- [The Register — Cursor YOLO safeguards bypassed](https://www.theregister.com/2025/07/21/cursor_ai_safeguards_easily_bypassed/) — corroborates the bypass; treat unknown commands as high-risk.
