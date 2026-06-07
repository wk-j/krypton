# Persistent Permission Mode (incl. full Bypass) — Implementation Spec

> Status: Implemented
> Date: 2026-06-07
> Milestone: Agent View hardening
> Implementation: `src/agent/permission-mode.ts` (pure decision logic + tests in
> `permission-mode.test.ts`), wired into `src/agent/agent-view.ts` (field, two gates,
> `Shift+Tab` cycle, `renderArmedIndicator`, `Esc`/`disarmTurnApprovals`); status-line
> variants in `src/styles/agent.css`. The pinned-panel UI relocation (§Design > UI) is
> deferred as a separate follow-up — the mode feature is complete in the existing
> in-transcript gate.

## Problem

In the single-agent **Agent view** (`src/agent/agent-view.ts`, amber theme) the user is asked to
approve essentially every tool call, turn after turn, with no durable escape. The per-turn `A`
(accept-all) arming resets on every `agent_start` (`:1287`), and for command-heavy workflows the
accept-all affordance rarely even appears (the spec-140 classifier flags scripts/network/unknown as
high-risk). The user's explicit requirement: **flow work without a blocking permission dialog** —
they accept the risk and want a durable "stop asking" mode.

## Solution

A **per-lane persistent permission mode** cycled with `Shift+Tab`, surviving turn boundaries:

- `normal` — every gate prompts (default; classifier unchanged).
- `acceptEdits` — auto-accept all `write_file` approvals; commands still gate.
- `bypass` — **auto-accept everything**: writes and all commands, including high-risk. No dialog.

Design decision (user-directed): `bypass` removes the safety floor **by deliberate user choice**.
It is therefore made *safe to live with* the spec-140 way — never a hidden default: it is entered
only by an explicit `Shift+Tab`, shown persistently and loudly in the status line, and disarmed
instantly with `Esc` or by cycling back. We do **not** touch `classifyBashCommand` at all — the
conservative classifier stays exactly as spec-140 designed it; `bypass` simply skips the gate, so
there is no fragile "narrowed risk" surface for arbitrary-code/wrapper commands to slip through.

## Research

- **Earlier "narrow the classifier" approach was dropped.** Peer review (Codex-1, architecture lens)
  showed that demoting scripts/network/unknown to `!highRisk` and then trusting `!highRisk` for
  auto-accept created an unattended denylist bypass (`node -e`, `bash -c`, `npm`/`git` hooks,
  `FOO=1 rm`, `cmd && rm -rf` via first-segment-only classification). A full, *opt-in* `bypass` makes
  the risk explicit and visible instead of smuggling it through classifier edits — and leaves the
  classifier (and `normal`/`acceptEdits` safety) untouched. Codex blockers 1–3 are thereby moot.
- **spec 140 machinery is reused** — armed status segment `renderArmedIndicator()` (`:2412`) on
  `statusArmedEl` (`:262`), `Esc` disarm `disarmTurnApprovals()` (`:2400`) wired early in
  `onKeyDown` (`:1870`), per-turn flags (`:204-210`). The persistent field is added near them and
  **deliberately not** reset on `agent_start` (`:1287`).
- **Two gates, both honour the mode** — `requestWriteApproval` (`:735`) and `requestCommandApproval`
  (`:857`). The mode check goes at the top of each, **after** any armed per-turn *reject-all*
  (Codex blocker 4: reject must win over an accept-mode), before the prompt path.
- **`Shift+Tab` collisions** (Codex warning 1) — `Tab`/`Shift+Tab` drive autocomplete reverse-cycle
  only while `acMatches.length > 0` (`:1914,:1942`); a separate mention popup uses `mention.active`.
  The mode-cycle is gated on *both* being inactive, and works in `input` and `scroll` state.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code | `Shift+Tab` cycles normal → auto-accept edits → plan; `--dangerously-skip-permissions` / bypassPermissions mode for full skip. Always-visible, reversible. | We mirror the cycle + a `bypass` state equivalent to bypassPermissions. |
| Cursor (YOLO) | Full auto-run toggle, visible. | Same intent: explicit opt-in, shown. |
| Aider | `--yes-always`; `/undo`. | Undo path; Krypton relies on VCS. |

**Krypton delta** — `bypass` = Claude Code's bypassPermissions, but keyboard-cycled and shown in the
amber status line. Diverge: no `plan` state; `Esc` stops all auto-approval (reuses spec 140).

## Affected Files

| File | Change |
|------|--------|
| `src/agent/agent-view.ts` | Add `permissionMode: 'normal' \| 'acceptEdits' \| 'bypass'` (default `'normal'`). `requestWriteApproval` (`:735`): after reject-all check, if mode ∈ {acceptEdits, bypass} auto-accept. `requestCommandApproval` (`:857`): after reject-all check, if mode === bypass auto-accept (any risk). `Shift+Tab` cycle in `onKeyDown` (gated: `!mention.active && acMatches.length===0`; both states). Extend `renderArmedIndicator` to fold in the mode; extend `disarmTurnApprovals`/`Esc` to clear it. **Not** reset on `agent_start`. |
| `src/styles/agent.css` | Mode label variants on `.agent-view__armed` (`:980`): `acceptEdits` gold `◆`, `bypass` red/loud `⚠ BYPASS`. Flat, no new container. |
| `src/agent/agent-view.test.ts` | Tests: normal prompts; acceptEdits auto-accepts writes / gates commands; bypass auto-accepts writes + high-risk commands; mode survives a simulated `agent_start`; per-turn reject-all wins over an accept-mode; `Esc` clears mode. |
| `docs/PROGRESS.md` | Note on implementation. |
| `CLAUDE.md` | One line: Agent view `Shift+Tab` permission mode (normal/auto-edit/bypass). |
| `docs/140-approval-gate-safety.md` | Cross-reference note: 147 adds an opt-in `bypass` that skips the gate (classifier unchanged). |

> **Not changed:** `src/agent/tools.ts` / `classifyBashCommand` — intentionally untouched.

## Design

### Data Structures

```ts
type PermissionMode = 'normal' | 'acceptEdits' | 'bypass';   // agent-view.ts field, default 'normal'
```

### Data Flow

`requestWriteApproval` (`:735`):
```
1. if rejectAllWritesForTurn  -> reject  (existing; wins over mode)
2. if mode === acceptEdits || mode === bypass -> auto-accept
3. if acceptAllWritesForTurn  -> accept  (existing)
4. else prompt (pinned panel)
```
`requestCommandApproval` (`:857`):
```
1. if rejectAllCommandsForTurn -> reject (existing; wins over mode)
2. if mode === bypass          -> auto-accept (ANY risk, incl high)
3. existing acceptAllCommandsForTurn && !highRisk / prompt
```
Cycle (`onKeyDown`, after approval-key routing, before state dispatch):
`if (e.key==='Tab' && e.shiftKey && !mention.active && acMatches.length===0) → mode = next(); renderArmedIndicator(); showSystemMessage('permission mode: <mode>'); preventDefault`.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Shift+Tab` | Agent view, autocomplete + mention popup closed | Cycle normal → acceptEdits → bypass → normal |
| `Esc` | mode ≠ normal or a per-turn flag armed | Clear persistent mode **and** per-turn flags |

### UI — pinned permission panel (when a gate DOES appear: normal / acceptEdits)

Per the live pivot, the gate renders in a **pinned panel above the input row** (not in the scrolling
transcript). To address Codex warnings 2–3:

- **Unified pending queue.** Writes and commands today live in separate arrays resolved write-first.
  Introduce a single ordered `pendingApprovals` sequence (or a shared monotonic seq key) so the
  panel's `▸` oldest-first marker always matches what `a`/`r` act on.
- **History model.** On resolve, the panel row clears and a compact transcript line is appended that
  **retains the request payload** (path/diff/command) so the existing Enter-to-open-diff/audit still
  works — it is a real (collapsed) record, not a lossy string. In `bypass` no panel/gate appears;
  auto-accepted actions still append their compact record for auditability.
- **Composer** is blocked (read-only hint) while approvals are pending, as today.

### Status-line indicator

Reuse the single `statusArmedEl` segment. `acceptEdits` → `◆ auto-edit · ⇧⇥/esc` (gold);
`bypass` → `⚠ BYPASS · ⇧⇥/esc` (red, loud — it is the no-safety state); per-turn flags keep their
existing `⚠ AUTO-RUN …/AUTO-BLOCK · esc`. Precedence: bypass label wins when set.

### Configuration

None. In-memory, session-only, per lane.

## Edge Cases

- **`rm -rf /` under `bypass`** → auto-runs, no prompt. This is the explicit user contract; the red
  `⚠ BYPASS` indicator is always visible and `Esc` stops it. (VCS remains the only undo.)
- **Per-turn `R` (reject-all) while bypass armed** → reject-all wins for that turn (step 1).
- **Mode set, then `agent_start`** → mode unchanged; per-turn flags still reset.
- **Autocomplete / mention popup open + `Shift+Tab`** → drives the popup, not the mode cycle.
- **`Esc`** → clears mode + per-turn flags; "auto-approval disarmed". Re-arm via `Shift+Tab`.

## Open Questions

None. (User directive: full `bypass` auto-accepts everything incl. high-risk; classifier untouched.)

## Out of Scope

- Persisted / across-restart permission settings (mode resets when the lane/app restarts).
- A configurable per-command allowlist (the earlier narrow-classifier path is abandoned).
- A `plan` mode in the cycle.
- The ACP harness view (`src/acp/`).

## Resources

N/A — purely internal change. Builds on `docs/99-agent-write-approval.md`,
`docs/100-agent-bash-approval.md`, `docs/140-approval-gate-safety.md`. Prior art: Claude Code
`Shift+Tab` cycle and `bypassPermissions`. Peer review: Codex-1 (architecture & correctness) —
blockers 1–3 resolved by abandoning the classifier change; blocker 4 (reject-all precedence) and
warnings 1–3 (Shift+Tab gating, unified queue, history model) folded into this design.
