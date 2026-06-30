# Orchestrator Console — Prompt the Seat — Implementation Spec

> Status: Implemented
> Date: 2026-06-30
> Milestone: M-ACP — Harness Multi-Agent
> Decision record: `docs/adr/0011-orchestrator-privileged-lane-and-acting-console.md` (extends)
> Terms: see `CONTEXT.md` → **Orchestrator**, **Orchestrator console**, **Dispatch**
> Related: `docs/180-orchestrator-console.md`, `docs/181-orchestrator-console-permission-action.md`, `docs/106-inter-lane-messaging.md`, spec 136 (prompt queue)

## Problem

From the Orchestrator console the human can dispatch work to *other* lanes (`d` → `peer_send`), interrupt/kill/restart, and answer permissions — but **cannot type a normal prompt to the orchestrator lane itself** (the seat). Dispatch is deliberately blocked for the seat ("cannot dispatch to the seat"), so the only way to talk to the orchestrator is to `Enter` out of the console into its transcript. The operator wants to **send a prompt to the seat without leaving the console** — e.g. "fan this out with #polly", "summarize where each worker is".

## Solution

Add a **seat prompt** input to the console: press **`i`** to open a one-line composer (symmetric with `d` dispatch) that sends a **normal user turn to the orchestrator seat** — not a `peer_send`. Crucially this is the *same* send path as the lane composer (`#`-commands, `!`-shell, mention fan-out, and the spec-136 busy-queue all behave identically), achieved by extracting the queue-or-send tail of `submitActiveLane` into a shared `submitLanePrompt(lane, text, images)` helper that both the composer and the console call. The seat prompt always targets the **seat** (the lane you are seated on), independent of the `j/k` card selection that dispatch/override use. No new send mechanism, no new Rust command, no new MCP tool.

## Research

- **Two distinct verbs.** Dispatch is `coordinator.deliverMentionFanOut(seat → [worker], body)` — a `peer_send` (inbox drop, drained on the worker's idle turn; `dispatchFromConsole`, `acp-harness-view.ts`). Prompting the seat is a **normal turn**: `lane.client.prompt([{type:'text', text}])` via the composer path. They must stay separate — a self-`peer_send` is nonsensical (and already blocked by `dispatchDisabledReason`).
- **The composer tail is reusable but inline today.** `submitActiveLane` (`:5934`) does: history push → `#` → `runHashCommand`; `!` → `runShellCommand`; lane not-ready guard; **busy/needs_permission → queue (spec 136, `PROMPT_QUEUE_MAX`)**; else `sendUserPrompt(lane, text, images)` (`:6000`, which itself handles mention fan-out). The branch from the `#`/`!` checks down through queue/send is lane-generic — only the leading `lane.draft`/history/`activeLane()` bits are composer-specific. Extracting that tail as `submitLanePrompt(lane, text, images)` gives the console full parity (commands, shell, queue, mentions) with zero new logic.
- **Seat resolution + live render already exist.** `this.orchestratorLane()` returns the live seat (or null if closed/stopped; `:4516`); the console already holds a `LaneBus` subscription while open, so the seat's busy/idle/queued transitions re-render the panel with no new wiring.
- **`i` is free.** Console keys today: `j k Enter d c x r o Esc q` + contextual `a/A/r/R` (spec 181). `i` ("input to the seat") is unused and mnemonic; it mirrors `d`'s one-line-input sub-mode (`orchestratorDispatch` → a parallel `orchestratorSeatPrompt` draft state).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| k9s | `:`-command bar acts on the cluster you're focused on | a command line seated on the current context — closest analogue |
| tmux command-prompt (`prefix :`) | one-line input that acts on the current session | seat-scoped input, not pane-targeted |
| VS Code / Zed agent panels | the composer is always the *current* agent thread | prompting "the agent you're on" is the default; Krypton's console adds it back for the seat |

**Krypton delta** — The console's primary verb is *delegate to a worker* (`d`), so talking to the seat is a deliberate, separate affordance (`i`) rather than the default, keeping the two cross-lane intents unambiguous. Seat-scoped (like tmux `prefix :` / k9s `:`), not selection-scoped.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Extract `submitLanePrompt(lane, text, images)` from `submitActiveLane` (the `#`/`!`/ready-guard/queue/`sendUserPrompt` tail) and call it from both. New `orchestratorSeatPrompt: { draft: string } \| null` state + `i` key → open input; `handleOrchestratorSeatPromptKey` (Enter send / Esc cancel / Backspace / char) mirroring `handleOrchestratorDispatchKey`; `renderOrchestratorSeatPrompt()` line below dispatch; footer/legend note. Send → `submitLanePrompt(seat, text, [])`. |
| `src/styles/orchestrator-console.css` | Reuse `.acp-orchestrator__dispatch*` classes (a `--seat` variant for the label) — no new structural CSS, flat chrome. |
| `src/acp/acp-harness-view.test.ts` | The extracted helper needs a DOM; assert via the existing pure surface where possible. Add a guard test for `seatPromptDisabledReason()` (no seat / seat stopped) — the one new pure helper. |
| `docs/180-orchestrator-console.md`, `docs/adr/0011-…md` | Cross-link: the seat is now promptable in-console (normal turn), distinct from dispatch (`peer_send`). |
| `docs/PROGRESS.md` | Landing note. |

## Design

### State + helper

```ts
private orchestratorSeatPrompt: { draft: string } | null = null;   // null = closed, like orchestratorDispatch

/** spec 182: why the seat cannot be prompted, or null when it can. */
export function seatPromptDisabledReason(seat: { status: string } | null): string | null {
  if (!seat) return 'no orchestrator seat';
  if (seat.status === 'starting' || seat.status === 'error' || seat.status === 'stopped') return `seat ${seat.status}`;
  return null;   // idle/busy/needs_permission/awaiting_peer all OK — busy queues (spec 136)
}
```

### Shared send (refactor — parity, not new behavior)

```
submitActiveLane(): … history/draft bookkeeping … → submitLanePrompt(activeLane, text, images)
submitLanePrompt(lane, text, images):
  #cmd  → runHashCommand(lane, text)
  !cmd  → runShellCommand(lane, …)
  not-ready (no client / starting / error / stopped) → flashChip
  busy | needs_permission → queue (PROMPT_QUEUE_MAX, spec 136)
  else  → sendUserPrompt(lane, text, images)
```

### Keys (console)

| Key | Context | Action |
|-----|---------|--------|
| `i` | console (seat exists & ready) | open the seat-prompt input |
| `Enter` | seat-prompt input | send the normal turn to the seat (queues if busy) |
| `Esc` | seat-prompt input | cancel (input only — does not close console) |

`d` (dispatch to selected worker) and `i` (prompt the seat) are the two send verbs; the seat-prompt ignores the `j/k` selection.

### Flow

```
1. In console, press i → orchestratorSeatPrompt = { draft: '' }; input opens (disabled-noticed if seatPromptDisabledReason).
2. Type, Enter → submitLanePrompt(seat, draft, []).
3. seat idle → sendUserPrompt starts a normal turn; seat busy → queued (spec 136), drains on idle.
4. LaneBus re-renders the console (seat card status / queue depth). Input closes on send.
```

## Edge Cases

- **No seat / seat stopped/starting/error:** `i` flashes `seatPromptDisabledReason` and does not open the input.
- **Seat busy / needs_permission:** prompt is **queued** (spec 136), not dropped — same as the composer; `(queued N)` flash.
- **Empty draft on Enter:** closes the input, sends nothing (mirrors dispatch).
- **`#…` / `!…` typed into the seat prompt:** routed exactly as in the composer (hash command / shell) via the shared helper.
- **Seat closes while input open:** next LaneBus render + send-time `seatPromptDisabledReason` guard both no-op safely.

## Resolved Decisions

1. **Keybinding `i`** — *Resolved (implemented):* `i` ("input to seat"), parallel to `d` dispatch; the seat-prompt input is a sub-mode like dispatch.
2. **`#`/`!` from the seat prompt** — *Resolved (implemented):* supported — the seat prompt routes through the shared `submitLanePrompt`, so `#polly`/`#review`/`!shell` and the spec-136 busy-queue behave exactly as in the lane composer.

## Out of Scope

- **Prompting an arbitrary selected worker as a normal turn** — workers receive *dispatched* `peer_send` (spec 180); a direct normal turn to a non-seat lane is not added (would blur dispatch vs. prompt). Seat-only.
- New Rust command, MCP tool, telemetry channel, or new lane state.
- Image staging / paste in the console seat prompt (text-only in v1; the lane composer remains the rich path).

## Resources

- `src/acp/acp-harness-view.ts:5934` (`submitActiveLane`), `:6000` (`sendUserPrompt`), `:2175` (`dispatchTurn`), `:4516` (`orchestratorLane`) — the reused send machinery.
- `docs/180-orchestrator-console.md` (dispatch model), `docs/181-…md` (the prior console mutation), `docs/106` (peer_send vs. normal turn), spec 136 (prompt queue).
- N/A external — purely internal change over existing composer + console code.
