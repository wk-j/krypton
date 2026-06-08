# Lane Goal — Focus Scope — Implementation Spec

> Status: Implemented
> Date: 2026-06-07
> Milestone: ACP Harness — focus & scoping
> Implementation: `#goal` command + `lane.goal` state in
> `src/acp/acp-harness-view.ts` — `LaneGoal` type + `goal?` field; `goalSeedPrompt()`;
> `runGoalCommand()` + `#goal` branch in `runHashCommand()`; `newLaneSession()` now
> returns `Promise<boolean>`; `insertGoalLine()` injects the pin at the packet head in both return paths of
> `renderPromptMemoryPacket()`; `renderGoalBar()` above the composer meta row;
> help-drawer entries. Styling: `.acp-harness__goal-bar` in `src/styles/acp-harness.css`.
> No new MCP tools, no Rust changes. 191 harness tests green.
>
> Revised across two review rounds — design (Codex-1) and code (Codex-1 + Claude-2). The
> code round + a human redirect **narrowed the pin to the owning lane only** (the goal no
> longer rides other lanes' or programmatic/peer turns). See *Review-driven revisions*.

## Problem

A lane in the ACP harness accumulates context across a long session. Two things degrade
focus on a single task:

1. **The agent drifts.** As the ACP session grows, the original task fades in context and
   the agent wanders onto tangentially-related work the user did not ask for on *this* task.
2. **The human loses the thread.** With several lanes running, it is easy to forget which
   concrete task a given lane is currently on, and to accidentally type unrelated work into
   a lane mid-task.

The user wants a way to **declare the current task as a focus scope** for a lane, refocus the
lane cleanly when switching tasks, and keep that scope visible and in-context until the task
changes.

## Solution

A per-lane **Goal**: a short statement of what the lane is currently working on, set with a
`#goal` composer command.

- **`#goal <text>`** — set a new goal. This **clears the lane** (fresh ACP session + empty
  transcript, exactly like `#new`) so it refocuses with nothing from before bleeding in, then
  starts the first turn on the goal. Harness `memory_*` state and the peer inbox/pending sends
  are **left untouched**.
- **`#goal`** (no argument) — show the current goal and how long it has been active.
- **`#goal clear`** — remove the scope. Does **not** clear the session (see *Clear semantics*).

While a goal is active it is (a) injected as one line into the per-turn `lane-context.md`
packet so the agent stays anchored to the task, and (c) shown as a static goal-bar above the
composer meta row so the human always sees which task the lane is on.

**This deliberately is NOT Claude Code's `/goal`.** It borrows the *name* and the
*clear-on-new* behaviour, but **not** the autonomy loop or the evaluator. There is no
"keep working until a condition is met", no completion condition, no independent evaluator
model, and no self-reported "done". A Krypton goal is a *scope label*, not a *termination
condition*. It persists, purely as scope, until the human replaces it (a new goal) or clears
it. See `CONTEXT.md` › *Goal*.

## Research

### Claude Code `/goal` (the feature that prompted this)

`code.claude.com/docs/en/goal`: `/goal <condition>` keeps the session running turn-after-turn
until a **small fast model (Haiku) evaluator** confirms the condition holds; it is a wrapper
around a session-scoped prompt-based Stop hook. The whole point is *autonomy* — removing the
per-turn human prompt — decided by a *fresh model* rather than the working one.

### Why Krypton's version diverges

The user's stated purpose is **scoping and focus**, not autonomy: "scope the specific task…
without interrupt with unrelated task… when we start a new goal we clear everything to focus."
That is a different feature, so we keep only the parts that serve it.

Two existing decisions make the evaluator the wrong fit even if we wanted autonomy:

- **ADR-0001 (attention triage)** and **ADR-0004 (review matrix)** both explicitly rejected an
  "independent observer LLM" in favour of self-report, on the grounds that an observer is extra
  orchestration to maintain, adds latency, and mis-judges just like the working agent. An
  evaluator-driven goal would re-introduce exactly that rejected shape.
- **Krypton has no primitive to call a model outside an ACP lane.** Every model interaction is
  an ACP session. A Haiku-style second evaluator would mean building an entirely new
  model-calling subsystem. Out of scope and unjustified for a focus feature.

So Krypton's goal drops the loop and the evaluator entirely and keeps focus-scoping.

### Existing machinery this reuses (verified in source)

- **`#new` / `#new!`** (`acp-harness-view.ts:5236`) → `newLaneSession(lane, { clearMemory })`.
  "Clear the lane" on goal-set is exactly `#new` semantics (`clearMemory: false`).
- **Per-turn context packet** — `renderPromptMemoryPacket()` (`:3740`) builds the
  `lane-context.md` block that rides on *every* turn via `buildPromptBlocks()` /
  `composeLeadingContext()` (`:3694`, `:3728`). Inserting one `Active goal: …` line here is the
  pin mechanism (a) — cheap, one line, already on the per-turn path. The line goes at the packet
  **head** (right after the identity line), not the tail: buried under the memory/attention/artifact
  blocks the agent treated it as background and often drifted off-goal; up top it reads as a
  standing instruction.
- **Composer meta row** — `.acp-harness__composer-meta` (flat telemetry deck, middot-separated).
  The goal-bar sits just above it.

### Pin-mechanism options considered

- **One-shot seed** (inject goal only on the first turn after clear) — rejected: the goal fades
  as the session grows, so it fails the primary purpose (a) of keeping the agent anchored.
- **Persistent per-turn line** (chosen) — one line in the already-present `lane-context.md`
  packet. Anchors the agent every turn at one-line cost.
- **Reuse the directive system (spec 124)** — rejected: a directive is a persistent *role*; a
  goal is the current *task*. Conflating them corrupts both terms (see `CONTEXT.md` _Avoid_).

## Design

### State

One optional field on the lane:

```ts
interface LaneGoal {
  text: string;      // the goal statement, user-typed (NOT uppercased)
  setAt: number;     // epoch ms, for the age display
}
// on HarnessLane:
goal?: LaneGoal;
```

Per-lane (lane = ACP session), at most one goal at a time. Not persisted across harness
restart in v1 (session-only, like the rest of lane runtime state).

### Commands (composer `#` family, alongside `#new` / `#cancel`)

| Command            | Behaviour                                                        | Session |
| :----------------- | :-------------------------------------------------------------- | :------ |
| `#goal <text>`     | clear the lane (`newLaneSession`, keep memory) **first**; only if it reports success, set `lane.goal` and seed the first turn directly to this lane (see sequence) | cleared (= `#new`) |
| `#goal`            | flash/print the current goal + age; if none, hint the usage     | untouched |
| `#goal clear`      | delete `lane.goal`; goal-bar disappears                          | untouched |

Aliases for clear, mirroring Claude Code tolerance: `stop`, `off`, `none`, `reset`.

`#goal <text>` is allowed **only when `lane.status === 'idle'`** — the same precondition
`newLaneSession` enforces (it rejects `busy | needs_permission | awaiting_peer | starting`).
Any other status flashes `lane busy - #cancel first` and is a no-op. Bare `#goal` (view) and
`#goal clear` are allowed in any status — they never touch the session. (This corrects an
earlier draft that allowed setting from `awaiting_peer`, which `newLaneSession` would have
silently refused — Codex-1 Blocker 1.)

### Clear semantics (resolved during grill)

`#goal clear` removes the **scope only** and never clears the session. Rationale: clearing the
session is a heavy, irreversible act that belongs to *starting* a goal (the deliberate
refocus), not to *ending* one — if `clear` also wiped the session, a human could lose the work
they just did by removing a label. A user who wants a clean slate already has `#new` / `#new!`.

### Setting a goal — exact sequence

1. Parse `#goal <text>`; trim. Empty text with no existing goal → usage hint, no-op.
2. Status precondition: if `lane.status !== 'idle'` → flash `lane busy - #cancel first`, no-op.
3. `setDraft(lane, '', 0)` (clear the composer input, like other `#` commands).
4. **`const ok = await newLaneSession(lane, { clearMemory: false });`** — fresh ACP session +
   empty transcript, memory preserved. `newLaneSession` returns `Promise<boolean>`: `true` once
   the lane was disposed + respawned, `false` if it bailed (wrong status, memory-clear failure)
   **or the respawn errored** (`lane.status === 'error'` after `spawnLane`). If `!ok`, **abort**:
   leave the lane goal-free.
5. **Now** set `lane.goal = { text, setAt: Date.now() }` — *after* the confirmed respawn, not
   before (Codex-1 code-round Blocker 1). Setting it earlier opens a window: `newLaneSession`
   awaits `client.dispose()` while the lane is still `idle`, and a peer message arriving in that
   window would start a turn on the about-to-be-disposed session carrying the new goal.
6. `flashChip('goal set · …')`; `render()`.
7. **Seed the first turn with a direct, self-contained `enqueueSystemPrompt(goalSeedPrompt(text))`
   to this lane** — `goalSeedPrompt` embeds the goal text, so the first turn carries it even
   though `enqueueSystemPrompt` sends raw text. This does **not** go through the inter-lane
   coordinator, so no synthetic envelope is involved (Codex-1 code-round Blocker 3 — see below).

(Re-setting a goal while one is active is the same path — it replaces and re-clears. This is the
"start a new goal = clear everything" case.)

### Pin mechanism (a) — per-turn injection

The goal text lives in the leading-context packet built by `renderPromptMemoryPacket()`. When
`lane.goal` is set, the packet carries, **at its head — right after the identity line, before the
memory/attention/artifact blocks**:

```
Active goal: <text>.
Stay scoped to this; if a turn pulls you off it, say so before continuing.
```

One line of intent + one line of guard (the goal `text` has internal newlines collapsed to
spaces). Present while the goal lives; gone the moment it is cleared. `insertGoalLine()` splices it
at index 1 rather than appending: tail placement left it buried beneath the other context blocks,
where the agent read it as background and drifted off-goal.

**Scope of the pin — this lane only (human redirect, code round).** The pin rides only the turns
that go through `buildPromptBlocks` — i.e. this lane's own user-typed turns (`sendUserPrompt`,
`:3621`) — plus the goal seed, which embeds the text directly. It is **not** injected into
`enqueueSystemPrompt` turns (peer mail, handoff, coordinator drains). An earlier draft routed
`enqueueSystemPrompt` through `buildPromptBlocks` so the goal rode those turns too, but the code
review showed that path is shared by every lane and entangled with other subsystems (see
*Review-driven revisions* B2/B3); the human resolved the fork by **confining the goal to the lane
that set it and not touching other lanes' or programmatic turns**. Accepted cost: when the goal
lane is pulled into a peer turn, that single turn is not goal-anchored; the goal re-anchors on the
lane's next normal turn.

- **Placement before the memory-unavailable early return (Warning 4).**
  `renderPromptMemoryPacket()` `return`s early on the no-memory branch. `insertGoalLine()` is called
  in **both** return paths so a lane without harness memory still carries its goal.

### UI (c) — the goal-bar

A static, single-line bar rendered **above** `.acp-harness__composer-meta`, only when
`lane.goal` is set:

- Label `◎ goal` (uppercase chrome label, letter-spaced, dimmed lane-accent).
- The goal text in the harness text colour, single line, ellipsised if long (it is user-typed
  prose — **not** uppercased, per the path-casing rule).
- A right-aligned age (`2m`, `1h`) in muted text.
- Background: a faint `color-mix(lane-accent 8%, transparent)` tint — **flat**, no border, no
  left rail, no nested box (consistent with the meta-row telemetry surface and the project's
  flat-chrome rules).

Reads like the backpressure gauge: a quiet depth/state indicator, never blinking, never an
alert. Mockup: `docs/prototypes/` (the registered artifact from the grill — to be committed as
`docs/prototypes/lane-goal.html` if we keep it).

### Scope

- **Per-lane, harness-lane runtime scope (Warning 5).** Each lane carries its own goal; lanes are
  independent. `lane.goal` is session-only runtime state on the harness lane — **not** tied to ACP
  session identity. Note the lane model is not "lane = ACP session": `#new` replaces the ACP
  session *inside* the same harness lane (the goal deliberately survives that — see Edge cases),
  while a resume (spec 97) creates a *new* harness lane (so the goal does not, and need not, carry
  over). Session-only state is therefore coherent: no persistence is the correct behaviour, not a
  gap.
- A goal does **not** touch the peer inbox or pending sends, does **not** block `peer_send` /
  `@mention` drains, and does **not** change lane status. It is orthogonal to inter-lane
  messaging (specs 106/116/141) by design — the user explicitly did not want goal to gate peer
  traffic.

## Edge cases

- **`#goal <text>` while not idle** — setting a goal clears the session via `newLaneSession`,
  which only accepts `idle`. So `#goal <text>` requires `lane.status === 'idle'`; any other status
  (`busy`/`needs_permission`/`awaiting_peer`/`starting`) flashes `lane busy - #cancel first` and
  no-ops. (Bare `#goal` view and `#goal clear` are allowed any time — they do not touch the
  session.) This is stricter than an earlier draft that allowed `awaiting_peer` (Blocker 1).
- **`#goal clear` with no active goal** — flash `no active goal`, no-op.
- **Goal text with newlines / very long** — store as-is; the goal-bar ellipsises, the packet
  line is single-line (collapse internal newlines to spaces for the injected line only).
- **`#new` / `#new!` while a goal is active** — leave the goal in place (the agent refocuses on
  the same task with a fresh session). The goal-bar persists; the next turn re-injects the pin.
  (Only `#goal clear` or a new `#goal` removes/replaces it.) *Author's default; confirm with the
  user if `#new` should instead clear the goal.*
- **Lane close** — goal is session-only runtime state, dropped with the lane.

## Out of scope (v1)

- No evaluator, no auto-continue, no completion condition (the whole Claude Code autonomy half).
- No persistence across harness restart / resume (spec 97) — goal is session-only. Per Warning 5
  this is coherent, not a gap: resume creates a *new* harness lane, so there is no prior goal to
  carry. Revisit only if resume gains true lane-identity continuity.
- No leader-key chord or palette entry — composer `#goal` only. (Can add later if wanted.)
- No cross-lane / view-wide goal.

## Files

- `src/acp/acp-harness-view.ts` —
  - `LaneGoal` type + `goal?` field on `HarnessLane`.
  - `#goal` command branch + `runGoalCommand()`, with the `idle`-only guard; respawn-then-publish
    ordering; direct self-contained seed via `enqueueSystemPrompt(goalSeedPrompt(text))`.
  - `newLaneSession`: return type `void → Promise<boolean>`, `false` on a bailed/errored respawn.
  - `insertGoalLine()` called in **both** return paths of `renderPromptMemoryPacket` (Warning 4).
  - `enqueueSystemPrompt` left **raw** (the round-1 `buildPromptBlocks` routing was reverted in
    the code round — see revisions).
  - `goalSeedPrompt(text)` helper (embeds the goal); `renderGoalBar()` in the composer markup;
    help-drawer entries.
- `src/styles/acp-harness.css` — `.acp-harness__goal-bar` (+ label/text/age) flat styling.
- `CONTEXT.md` — *Goal* term (added during grill).
- `docs/PROGRESS.md` — Recent Landing entry; harness command help-drawer lists `#goal`.

## Decisions log (from the grill)

1. **Focus scope, not autonomy** — drop the evaluator + auto-loop; keep clear-on-new.
2. **Interruption guarded against = (a) agent drift + (c) human reminder**, explicitly *not*
   (b) peer/inbox gating.
3. **Clear on set = `#new` semantics** (session + transcript), keep memory, don't touch inbox.
4. **Pin via persistent per-turn line** in `lane-context.md` (not one-shot, not directive).
5. **`#goal clear` removes scope only**, never clears the session.
6. **Per-lane**, goal-bar above the meta row, flat.

## Review-driven revisions

### Round 1 — design review (Codex-1, architecture & correctness)

Five findings folded into the spec before coding: B1 status contract (`idle`-only +
`Promise<boolean>`); B2 seed ordering race; B3 pin coverage (then resolved as "route programmatic
turns through `buildPromptBlocks`", option A); W4 emit the pin in both packet return paths; W5
"harness-lane runtime scope" terminology.

### Round 2 — code review (Codex-1 architecture/correctness + Claude-2 requirements-fit)

Claude-2 found **0 blockers** (requirements met). Codex-1 found **3 blockers + 2 warnings**, all
verified against source. They showed the round-1 option-A pin (routing *every* programmatic turn
through `buildPromptBlocks`) had costs not visible at design time:

- **Code-B2 — directive lifecycle bypass.** `buildPromptBlocks` reads the effective directive, but
  the promote-`pendingDirectiveChange` / consume-`turnDirectiveOverride` lifecycle lives only in
  `sendUserPrompt` (`:3636-3648`). Routing `enqueueSystemPrompt` through `buildPromptBlocks` would
  carry directives onto peer/handoff turns *without* that lifecycle — dropping a queued next-turn
  change and leaking a one-shot override across turns.
- **Code-B3 — tombstone clear.** The goal seed used `injectHarnessEnvelope` (`__harness__`), but
  `InterLaneCoordinator.drain()` treats *any* `__harness__` envelope as a drained
  cancellation/closure notice and clears all `cancelledPairs` tombstones for the lane
  (`inter-lane.ts:646-692`) — so setting a goal could re-enable late replies from a `#cancel`-ed
  peer.
- **Code-B1 — stale-goal window.** Setting `lane.goal` before the respawn's `await dispose()` (lane
  still `idle`) let a peer message start an old-session turn carrying the new goal.

**Human redirect:** *"inject goal only in the lane that set it, not other lanes."* Resolution
(supersedes round-1 B2/B3 / fork `jdg-…28528a50` and the new fork `jdg-…14acd0f0`):

- **Reverted** `enqueueSystemPrompt` to raw text → directive lifecycle and all other lanes'
  programmatic turns are untouched (kills Code-B2 and the "touch other lanes" concern).
- **Seed directly** with `enqueueSystemPrompt(goalSeedPrompt(text))` to this lane, the goal text
  **embedded** in the prompt (no `injectHarnessEnvelope`) → no tombstone is ever cleared (kills
  Code-B3). The narrow spawn-idle drain race is acceptable: an `idle` lane's inbox is normally
  already drained, and if the seed is dropped the goal still rides the next normal turn.
- **Publish `lane.goal` after** the confirmed respawn, not before (kills Code-B1).
- **W1** — `newLaneSession` returns `false` when `spawnLane` left the lane in `error`.
- **W2** — goal-bar age is a render-snapshot, documented as such (no perpetual 1s ticker, to keep
  idle CPU low).
- Claude-2 polish: unified empty-state copy (`no active goal`); the seed embeds the goal so the
  "shown in your context above" wording concern (W-d) is moot. Accepted as-is: a background lane's
  goal is only visible when focused (W-a), and a one-word goal equal to a clear-alias clears
  instead of setting (W-b) — both minor, documented.

Net effect of the redirect: the goal is a **per-lane** pin on that lane's own turns — simpler, with
no new coupling to the inter-lane or directive subsystems.
