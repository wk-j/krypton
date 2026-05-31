# ACP Harness Prompt Queue — Implementation Spec

> Status: Implemented (after Codex-1 ×2 + Grok-1 + Claude-2 adversarial reviews, 2026-05-31)
> Date: 2026-05-31
> Milestone: M-ACP — Harness convergence

## Problem

When a harness lane is busy (`busy` / `needs_permission`), pressing Enter on a typed prompt does nothing useful — `submitActiveLane()` flashes `lane busy` and **discards** the draft (`acp-harness-view.ts:3252`). The user must watch the turn, wait for it to finish, then type. There is no way to line up the next instruction while the agent is working.

## Solution

Add a per-lane FIFO **prompt queue**. When the user submits a prompt while the lane is busy, capture it into `lane.queuedPrompts` (text + a snapshot of staged images) instead of discarding it. When the turn ends and the lane settles back to `idle`, drain **one** queued prompt and submit it as a normal user turn. Queued prompts surface in a non-blocking composer strip (mirroring the existing peer strip) and a depth count in the status chip. This reuses the harness's established "queue, drain-on-idle" pattern (`InterLaneCoordinator` / `LaneInbox`) and the `enqueueSystemPrompt` lifecycle, just sourced from the user's composer instead of a peer lane.

## Research

Findings from the codebase that shape the design:

- **Discard point is precise.** `submitActiveLane()` (`acp-harness-view.ts:3221`) parses `#`/`!` commands (lines 3233–3247) **before** the busy check, then at lines 3252–3255 short-circuits `busy`/`needs_permission` with `flashChip('lane busy')`. The queue branch slots in exactly here; control commands keep running immediately for free.
- **Drain-on-idle already exists.** `finishTurn()` (`:3398`) resolves the post-turn status via `coordinator.onLaneStop(lane.id)` then `setLaneStatus(lane, suggested ?? 'idle')` (`:3422`). `setLaneStatus` emits `lane:status`, and `InterLaneCoordinator.onBus` (`inter-lane.ts:701`) synchronously drains queued **peer mail** for that lane via `enqueueSystemPrompt`, flipping it back to `busy`. So by the time `finishTurn` continues past `setLaneStatus`, peer mail (if any) has already claimed the lane. A user-queue drain that gates on `lane.status === 'idle'` therefore naturally lets peer mail win and avoids a double-submit.
- **`finishTurn` re-entrancy hazard (Codex-1 #1, confirmed).** Because the peer-mail drain runs *re-entrantly inside* `setLaneStatus` at `:3423`, `enqueueSystemPrompt` sets the **new** turn's `pendingCoordinatorDrain` / `activeTurnStartedAt` / `currentAssistantId` / `currentThoughtId` (`:1201-1208`) *before* `finishTurn` resumes and nulls those same fields at `:3438-3442`. This is a pre-existing latent bug (it already corrupts peer provenance + elapsed-time UI for back-to-back peer turns), independent of this feature. Consequence for the prompt queue: a drain hook must **not** run synchronously inside `finishTurn` and read fields the resuming `finishTurn` will clobber. The design therefore (a) defers the user-queue drain to a `queueMicrotask` so it observes the fully settled lane state, and (b) recommends the proper fix — moving the old-turn cleanup (`:3438-3442`) *before* the draining status transition (`:3422-3423`) so re-entrant peer state survives. See Open Questions for the scope decision on (b).
- **`tryMentionFanOut` clears the draft (Codex-1 #2, confirmed).** On successful delivery it calls `this.setDraft(lane, '', 0)` (`:1169`), and several rejection branches (`:1140-1145`, `:1148-1150`, `:1158-1160`) `return true` (handled) *without* appending any transcript row. So routing a queued `@lane …` prompt through the mention path on drain would (i) erase the user's unrelated live draft and (ii) silently lose the queued item if the mention is rejected. The fix is a `clearDraftOnDeliver` flag on the mention helper (queued drains pass `false`) and a returned delivery result so a rejected queued mention surfaces a system row instead of vanishing.
- **`enqueueSystemPrompt` is the template** (`:1194`): gates on `idle`/`awaiting_peer`, sets `busy`, stamps `activeTurnStartedAt`, resets per-turn state, calls `lane.client.prompt([...])` with try/catch → `error`. The user-queue send path needs the same lifecycle but must also run mention fan-out, append the user transcript row, build the directive/context packet, and handle staged images — i.e. the back half of `submitActiveLane`.
- **`LaneInbox` (`lane-inbox.ts:7`)** is the FIFO prior art: `push`/`drain`/`depth`. The user queue is simpler (no envelope provenance, single-lane), so an inline `QueuedPrompt[]` array on `HarnessLane` is enough — no new class.
- **Draft-clearing hazard.** `submitActiveLane` clears the draft + staged images on send. A queued prompt drains *while the user may be typing a new draft*, so the drain path must **not** touch the live `lane.draft` / `lane.stagedImages`. This forces extracting the agent-dispatch core into a helper that takes `(text, images)` explicitly and leaves draft management to the caller.
- **`finishTurn:3447`** already flashes `lane idle - Enter to send` when an unsent draft survives a turn — adjacent UX the queue strip complements (queued items vs. an un-queued live draft are distinct).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code (CLI) | Messages typed while a turn runs are queued and sent one-at-a-time as separate turns when the model finishes; Esc clears the queue. | Closest match. One-per-turn drain, explicit clear gesture. |
| Cursor / Windsurf chat | "Send" while generating queues the message; it dispatches after the current response. | Single follow-up emphasis; minimal queue surfacing. |
| ChatGPT / Claude.ai web | Composer is disabled (greyed) during generation — **no** type-ahead queue. | The thing we're deliberately improving on. |
| Warp AI | Type-ahead allowed; commands buffer. | Terminal-native precedent for buffering input while busy. |
| tmux / Zellij | N/A — multiplexers have no turn/agent concept. | No equivalent. |

**Krypton delta** — match Claude Code's model: FIFO, **one prompt drained per idle transition** (each queued prompt becomes its own agent turn, not a concatenated blob), and a clear gesture. Diverge on surfacing: instead of greying the composer, Krypton keeps the composer fully live (keyboard-first — the user can keep typing the *next* item) and shows queued items in a compact cyberpunk strip above the input line, reusing the peer-strip visual language. Clearing folds into the existing `#cancel` gesture rather than a separate Esc binding (Esc is already overloaded for staged-image clear / permission cancel).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add `queuedPrompts: QueuedPrompt[]` to `HarnessLane`; init `[]` in `createLane`. Add `queueSlotEl` to the rail in the constructor (after `peekSlotEl`, `:2653`). Add the busy→enqueue branch in `submitActiveLane`. Extract `sendUserPrompt(lane, text, images, opts?)` from `submitActiveLane`'s back half. Change `tryMentionFanOut` to take `opts?: { clearDraftOnDeliver?: boolean }` and return `{ handled, delivered }` (callers updated). Add `maybeDrainPromptQueue(lane)`, scheduled via `queueMicrotask` from `finishTurn`'s tail. Guard the `:3447` idle-draft flash on an empty queue. Clear the queue at the **top** of `cancelLane` (explicit stop); for `newLaneSession` / `restartLane` clear it only **after** the busy/starting guards pass (on the real reset path — `:4720-4727` / `:4695-4699` reject early; a rejected op must not silently drop the queue — Grok-1). Add `queueSlotEl` in the ctor (after `peekSlotEl`, `:2653`). Add `renderActiveLaneQueue()` (numbered `<ol>` rows, `▸` head marker, `→lane`/`img×N` tags, header state suffix) and call it from **both** `render()` (`:4924`) **and** `renderActiveLane()` (`:4986`); early-return when `zenMode`. Add the `#unqueue [N]` / `#queue clear` / `#queue edit N` handlers to `runHashCommand` (`:4796`) — strict `/^[1-9]\d*$/` index parse, command text consumed on every branch, `edit` guards `stagedImages.length > 0`. Resolve `QueuedPrompt.mentionTargets` at enqueue via `parseMentionFanOut` (`mention-parse.ts`). Add the ` · N queued` count in `composerStatusChip` (`:6034`). **Optionally (Open Q2):** reorder the `:3438-3442` old-turn cleanup before the `:3422-3423` status transition. |
| `src/styles/acp-harness.css` | New `.acp-harness__lane-rail__slot[data-slot="queue"]` — `flex-shrink: 0; max-height: clamp(72px, 30%, 160px); margin-top: auto` (bottom-anchored, never crushed). New `.acp-harness__lane-queue` block/item/preview classes — flat lane-accent-bordered list with `overflow-y: auto`, deliberately distinct from the peek `<aside>` card. |
| `src/acp/acp-harness-view.test.ts` | Tests: enqueue-while-busy; FIFO one-per-idle drain; peer-mail-wins precedence + repeated-preemption hold; draft preserved across drain (incl. queued `@mention` with `clearDraftOnDeliver:false`); rejected-queued-mention surfaces a system row (not lost); frozen staged-image snapshot isolated from later removal/mutation; cap behavior; clear-at-top on `cancelLane` (incl. awaiting_peer / no-client early branches); rejected `#new`/`#restart` (busy) keeps the queue; queue hidden in zen; `#unqueue` (last / `N` / out-of-range), strict `N` parse (reject `0`/`-1`/`1.5`/`1foo`), command text consumed on the error branch; `#queue clear` (queue emptied, turn still running); `#queue edit N` (pops to composer, refused when `stagedImages` present, re-enqueues at tail on re-send); row tag derivation from stored `mentionTargets` (`→lane`, `→lane +K` multi-target, `img×N`); **stalled-drain re-arm** — a queued mention whose target closed before drain emits the system row *and* the following item still drains (Claude-2 H1). **Test seams (Claude-2 L4):** use a deterministic microtask+promise flush helper (a single `await Promise.resolve()` won't settle the `queueMicrotask` → async `sendUserPrompt` → awaited `prompt()` chain); the peer-mail-wins test must wire the **real** `InterLaneCoordinator`+`LaneBus` (precedence depends on the *synchronous* drain inside `setLaneStatus`), not a stub. |
| `src/styles/acp-harness.css` (visual/manual) | Layout stress check: (a) plan `--primary` + peek + 10-item queue — queue bottom-anchored, fully visible, not clipped/zero-height; (b) queue-only (no plan/peek) — still anchors near the composer. |
| `docs/PROGRESS.md` | Record under "Recent Landings". |
| `docs/72-acp-harness-view.md` | Document the prompt queue + `#queue`/`#unqueue` commands in the harness view reference. |
| `docs/05-data-flow.md` | Add the enqueue → drain-on-idle path to the input-flow description (Claude-2 M2). |
| `docs/106-inter-lane-messaging.md` | Cross-reference the peer-mail-vs-user-queue precedence (the new interaction with `awaiting_peer` / the coordinator drain) (Claude-2 M2). |

No Rust changes. No new Tauri commands. No config.

## Design

### Data Structures

```ts
interface QueuedPrompt {
  text: string;            // trimmed prompt text as the user submitted it
  images: StagedImage[];   // frozen snapshot of staged images at enqueue time
  mentionTargets: string[];// lane display names resolved via parseMentionFanOut AT ENQUEUE (empty if not a mention); drives the →lane row tag — render never re-parses (Codex-1 R2 #6)
}
```

On `HarnessLane`:

```ts
queuedPrompts: QueuedPrompt[];   // FIFO; head drains first. Cap PROMPT_QUEUE_MAX (10).
```

### Control Flow

`submitActiveLane()` (Enter handler) — revised order:

```
1. trim draft; empty + no images → return
2. push to promptHistory (unchanged — recall works at enqueue time)
3. text starts with '#'  → runHashCommand; return     (unchanged, pre-queue)
4. text starts with '!'  → runShellCommand; return     (unchanged, pre-queue)
5. starting/error/stopped → flashChip(`lane <status>`); return  (cannot queue a dead lane)
6. busy | needs_permission → ENQUEUE:
     if queuedPrompts.length >= PROMPT_QUEUE_MAX → flashChip('queue full (10)'); return
     images = stagedImages.slice().map((img) => Object.freeze({ ...img }))  // isolate snapshot (Grok-1)
     mentionTargets = resolveMentionTargets(text)   // parseMentionFanOut at enqueue (Codex-1 R2 #6); [] if not a mention
     queuedPrompts.push({ text, images, mentionTargets })
     setDraft('', 0); stagedImages = []          // capture: draft moves into the queue
     flashChip(`queued (${queuedPrompts.length})`)
     render(); return
7. idle | awaiting_peer →
     images = stagedImages.slice()
     setDraft('', 0); stagedImages = []
     await sendUserPrompt(lane, text, images)
```

`sendUserPrompt(lane, text, images, opts?: { clearDraft?: boolean })` — extracted agent-dispatch core. It does **not** clear the live draft/staged images itself; the immediate caller clears them *before* calling (the typed prompt has already been captured), and the drain caller leaves them alone so an in-progress next draft survives. `clearDraft` (default `false`) is forwarded to the mention helper:

```
1. if !lane.client → return { handled: false }
2. result = tryMentionFanOut(lane, text, images.length > 0, { clearDraftOnDeliver: opts?.clearDraft })
     if result.handled → return result   // delivered or rejected; caller decides what to surface
3. appendTranscript(lane, 'user', text, { imageCount: images.length })
4. setLaneStatus(lane, 'busy'); stamp activeTurnStartedAt; reset per-turn state
5. promote pendingDirectiveChange; blocks = buildPromptBlocks(lane, text, images)
6. consume turnDirectiveOverride; updateComposerTick(); render()
7. try { await lane.client.prompt(blocks) } catch → use **submitActiveLane's** catch, NOT enqueueSystemPrompt's leaner one (Claude-2 M1): setLaneStatus('error'), `lane.error = msg`, `activeTurnStartedAt = null`, `pendingTurnExtractions = []`, `updateComposerTick()`, `appendClassifiedError(...)`. (enqueueSystemPrompt's catch at `:1213` skips the timer/extraction cleanup — inheriting it would regress the live composer's error path.)
8. return { handled: true, delivered: true }
```

`tryMentionFanOut` gains `(lane, text, hasImages, opts?: { clearDraftOnDeliver?: boolean })` and returns `{ handled: boolean; delivered: boolean }` instead of a bare boolean. Its internal `setDraft(lane, '', 0)` at `:1169` becomes conditional on `opts?.clearDraftOnDeliver !== false`. The existing immediate composer path passes `{ clearDraftOnDeliver: true }` (current behavior preserved); the drain path passes `false`.

`maybeDrainPromptQueue(lane)` — **deferred via `queueMicrotask`** from the tail of `finishTurn` so it reads the settled lane state (after any synchronous peer-mail drain has run and the resuming `finishTurn` has finished its cleanup), never racing it:

```ts
// in finishTurn tail:  queueMicrotask(() => this.maybeDrainPromptQueue(lane));

private maybeDrainPromptQueue(lane: HarnessLane): void {
  if (lane.status !== 'idle') return;        // busy (peer mail) / awaiting_peer / error / stopped → hold
  if (lane.queuedPrompts.length === 0) return;
  const next = lane.queuedPrompts.shift()!;
  void this.sendUserPrompt(lane, next.text, next.images, { clearDraft: false }).then((r) => {
    if (r.delivered) return;                  // turn started; the next finishTurn drains the rest
    // Consumed but NOT delivered — e.g. a queued @mention whose target closed or
    // was renamed between enqueue and drain (tryMentionFanOut re-parses the CURRENT
    // roster, :1136). sendUserPrompt bailed before setLaneStatus('busy'), so the lane
    // is still idle and finishTurn will NOT fire again. Surface the drop AND re-arm
    // the drain ourselves, or the rest of the queue stalls behind an idle lane with
    // no running turn to trigger the next drain (Claude-2 H1).
    if (r.handled) {
      this.appendTranscript(lane, 'system', `queued prompt not sent: ${truncate(next.text, 80)}`);
      this.render();
      if (lane.queuedPrompts.length > 0) queueMicrotask(() => this.maybeDrainPromptQueue(lane));
    }
    // r.handled === false means !lane.client (a dead lane) — it won't be `idle`
    // anyway, so we neither re-arm nor discard the remaining queue here.
  });
}
```

**Queue clearing (Codex-1 #5).** `lane.queuedPrompts = []` is assigned at the **very top** of `cancelLane` — *before* its early returns at `:4675-4679` (awaiting_peer / idle-with-pending-peer) and `:4681-4683` (no client) and before the awaited `lane.client.cancel()`. This guarantees the explicit clear gesture takes effect on every cancel branch and can't be left half-done by a `cancel()` failure. `newLaneSession` and `restartLane` clear it likewise, early.

**Idle-draft flash guard (Codex-1 #6).** `finishTurn`'s existing `if (lane.draft.trim()) flashChip('lane idle - Enter to send')` (`:3447`) is tightened to `if (lane.draft.trim() && lane.queuedPrompts.length === 0)`, so it doesn't flash "idle, send your draft" in the same tick a queued prompt is about to drain the lane back to busy.

### Data Flow (primary use case)

```
1. Lane Claude-1 is busy. User types "run the tests" + Enter.
2. submitActiveLane: status busy → queuedPrompts=[{ "run the tests" }]; draft cleared; chip "queued (1)".
3. User types "then commit" + Enter → queuedPrompts=[…,"then commit"]; chip "queued (2)".
4. Agent turn ends → finishTurn: coordinator.onLaneStop → no peer mail → setLaneStatus(idle).
5. finishTurn tail → maybeDrainPromptQueue: status idle → shift "run the tests" → sendUserPrompt → lane busy.
6. That turn ends → finishTurn → maybeDrainPromptQueue → shift "then commit" → sendUserPrompt.
7. Queue empty; lane idle.
```

Peer-mail precedence (step 4 variant): if `onLaneStop` returns a status that drives a peer-mail drain, `setLaneStatus(idle)` synchronously flips the lane to `busy` before `maybeDrainPromptQueue` runs; the guard `status !== 'idle'` holds the user queue until the *next* idle. Peer mail wins; the user queue is never lost, only deferred.

### UI Changes

The queued-prompt **list** lives at the **bottom of the right-rail (lane-peek position)**, per user direction — not as a strip above the composer.

**Design constraint (researched):** the contextual lane peek (`renderLanePeek`, `:9511`) only ever renders a **non-active** lane (`laneCanPeek = !lane.active && !lane.stopped`, `:9765`). The prompt queue, however, belongs to the **active** lane (the one the user composes into). So the queue is **not** appended inside the peek `<aside>` (that element shows someone else's lane); instead it is a **new, third rail slot** anchored at the bottom of the same `.acp-harness__lane-rail` overlay that hosts the plan and peek slots. "Bottom of the lane-peek position" = the bottom of that rail region, showing the active lane's queue. See Open Questions for the interpretation note.

- **New rail slot** `queueSlotEl` (`data-slot="queue"`), appended to `.acp-harness__lane-rail` *after* `peekSlotEl` in the constructor (`:2653`). It bottom-anchors via `margin-top: auto` within the rail's `flex-direction: column` layout. Toggled purely on `activeLane.queuedPrompts.length > 0` (independent of peek, per the user redirect).

- **Slot layout — must not be crushed/clipped (Grok-1 Q1, HIGH).** The rail is `overflow: hidden` with slots `flex: 0 1 auto; max-height: 50%` (plan can be `--primary` 70%, `css:745`). Three live slots (70% + 50% + queue + gaps) overflow the rail, and `margin-top: auto` on the *last* child of an `overflow: hidden` flex column otherwise gets clipped below the fold. Fix: the queue slot is `flex-shrink: 0` with `max-height: clamp(72px, 30%, 160px)`, and its inner list scrolls (`overflow-y: auto`). Plan and peek stay shrinkable (`flex-shrink: 1`, content already clips), so the browser squeezes *them* first and the actionable queue is always fully visible, pinned to the bottom near the composer. Ship with an explicit **layout stress check**: (a) 3 slots at once (plan `--primary` + peek + a 10-item queue) — queue neither clipped nor zero-height; (b) **queue-only** (no plan, no peek — a reachable state since slots toggle individually and `laneRailEl` is always attached) — `margin-top: auto` must still anchor it near the composer, not float mid-rail or collapse (Claude-2 L3).

- **`renderActiveLaneQueue()`** — new method that reads the **active** lane's `queuedPrompts`; if empty (or zen, below), `queueSlotEl.hidden = true` and return; otherwise renders a `.acp-harness__lane-queue` block:
  - **header** with a self tag + count: `⏎ queue (N)`. State suffix mirrors *why* it isn't draining: `· held` when `awaiting_peer` (peer mail preempts — Codex-1 #4), `· paused` when the lane is in `error`.
  - **numbered, ordered rows** (`<ol>`, drain order, oldest first). The head row — the next item to drain — is marked `▸1` in the lane accent so "what runs next" is unmistakable; the rest are plain `2`, `3`, …. When `held`/`paused`, the head marker dims (nothing is draining right now). Rows truncate with ellipsis and the list scrolls within the slot cap.
  - **per-item tags**: a queued mention shows `→<lane>` (or `→<lane> +K` for multi-target), driven by `QueuedPrompt.mentionTargets` which is resolved **at enqueue via the real `parseMentionFanOut`** (`mention-parse.ts`), never an ad-hoc `@token` regex at render (Codex-1 R2 #6); an item with staged images shows `img×N` from `images.length`.
  - **footer** keyboard hints: `#unqueue` · `#queue clear` (per-item management, below).

- **Distinct chrome, not a second peek card (Grok-1 Q2, MEDIUM).** The rail otherwise hosts a peek card for a *non-active* (foreign) lane; the queue is the *active* (self) lane. To avoid "which card is me?" confusion, the queue block uses **deliberately lighter, distinct chrome** — a flat lane-accent-bordered list with the unmistakable `⏎ queue` self-header, **not** the full peek `<aside>` grid/gradient. Same accent system, clearly different shape.

- **Render call sites (Grok-1 Q3, MEDIUM-HIGH) — corrected.** `render()` (`:4916`) does **not** call `renderLanePeek` (it does `renderPlanPanel` `:4924` + `renderComposer` `:4931`); the peek lives only in `renderActiveLane()` (`:4986`) and ~8 direct call sites. `renderActiveLaneQueue()` is therefore called from **both** `render()` (next to `renderPlanPanel`, `:4924`) **and** `renderActiveLane()` (next to `renderLanePeek`, `:4986`), so a full render (focus/zen/memory toggle, command results, initial paint) keeps the rail queue and the composer chip in sync. It is intentionally **not** added to the streaming fast path `scheduleStreamingBodyOnly()` (`:4957`) — the queue is immutable during a turn (enqueue happens on a user Enter via `render()`; drain happens at `finishTurn`), so the fast path can skip it. Cost is negligible (active lane only, ≤10 items). Document this in `docs/72`.

- **Zen mode (Grok-1 finding).** `laneRailEl` is re-parented into the active lane card on every `renderLanes` (`:5773-5774`) regardless of zen, and there is no zen rule repositioning `.acp-harness__lane-rail`. `renderActiveLaneQueue()` early-returns (slot hidden) when `this.zenMode` — zen has its own left rail (`refreshZenRail`); the queue is not shown there in v1. (Existing plan/peek zen behavior is out of scope; verify at implementation.)

- **Status chip** (`composerStatusChip`, `:6034`): append ` · ${n} queued` whenever the queue is non-empty in **both** the `busy` and `needs_permission` states (both can hold a queue, Claude-2 L1) — not just the `busy` branch, which `return`s early. The count is correct on every render (it changes at enqueue/drain, each of which renders); the 1s `updateComposerTick` merely re-renders while busy and is not relied on for correctness.

- Composer stays fully interactive while busy — no disabling. No queue strip above the input line.

### Keybindings & queue management

No new modal bindings (a dedicated queue-focus mode is out of scope). Enter enqueues when busy (was: discard). The queue is managed by **chat commands** in the existing `#…` family (`runHashCommand`, `:4796`), which is keyboard-native and runs even while the lane is busy (they are parsed *before* the busy gate at `submitActiveLane:3252`):

| Command | Action |
|---------|--------|
| `#unqueue` | Remove the **last** queued item (fast path; no `N` needed). |
| `#unqueue N` | Remove item `N` (1-indexed, drain order — matches the rail's `▸1`/`2`/`3`). |
| `#queue clear` | Drop the **whole** queue **without** cancelling the running turn. |
| `#queue edit N` | Pop item `N` out of the queue and into the composer (`setDraft(item.text)` + restore `item.images`) to edit and re-send. |
| `#cancel` / `Ctrl+C` | Unchanged "stop": cancels the active turn **and** clears the queue (routes through `cancelLane`). |

Three parsing/lifecycle rules every queue-management command obeys (Codex-1 R2):

- **`N` is parsed strictly** as `/^[1-9]\d*$/` — `0`, negatives, decimals, and `1foo` are rejected with a flash; they never silently address the wrong row (#5).
- **The command text is always consumed** — recognized queue commands call `setDraft(lane, '', 0)` + `render()` on *every* branch, including no-op/error (`nothing queued`, `no item N`), exactly like `#new`/`#cancel`. Otherwise `#unqueue 99` would linger in the composer and re-fail on the next Enter (#4).
- **`#queue edit N` guards staged images, not draft text** (#1, #2). The command text *is* the current draft (the user typed `#queue edit N`), so there is no other text payload to protect — overwriting it with `item.text` is the whole point. The real clobber risk is an **image-only live draft**: refuse with a flash when `lane.stagedImages.length > 0`; otherwise pop the item, `setDraft(item.text)`, and set `lane.stagedImages = item.images`. A `lane.draft.trim()` empty-check would be wrong — it always sees the command itself and would make `edit` permanently unusable.
- **Bare `#queue` and unknown subcommands are defined** (Claude-2 L2): `#queue` alone or `#queue bogus` flash a usage hint (`#queue clear | edit N`) and still consume the command text + render, like every other branch. (Root split — removal under `#unqueue [N]`, mutation under `#queue {clear,edit}` — keeps `#unqueue` as a one-token remove-last fast path; documented so the two roots aren't read as an inconsistency.)

**`#queue edit N` re-send ordering** (#3): edit *removes* item N from the queue and loads it into the composer; pressing Enter while still busy re-enqueues it at the **tail** (not back at slot N). This is the documented v1 behavior — no insertion-target bookkeeping. The user sees it leave its slot and rejoin at the end.

`#queue` / `#unqueue` are the per-item complement to `#cancel`'s clear-all, so the user no longer has to abort the running turn just to fix the queue.

### Configuration

None. `PROMPT_QUEUE_MAX = 10` is a module constant.

## Edge Cases

- **Live draft vs. drain:** user queues "A", then types "B" without sending; turn ends → "A" drains via `sendUserPrompt` which never touches `lane.draft`, so "B" stays in the composer. ✔
- **Turn ends in error:** status → `error`, not `idle`; queue is held (not fired at a dead lane). The user can `#restart` (clears queue) or `#cancel`. ✔
- **`needs_permission`:** queue holds; on resolve→`busy`→ eventual `idle` it drains. ✔
- **Cancel / new session:** `cancelLane`, `newLaneSession`, `restartLane` clear `queuedPrompts` (queued prompts were written for the old context). ✔
- **Queued mention (`@lane …`):** drains through `sendUserPrompt` → `tryMentionFanOut` with `clearDraftOnDeliver: false`, so the user's live draft is preserved (Codex-1 #2). ✔
- **Queued mention rejected on drain** (self-only / unknown lane / no valid target / images-not-supported): `tryMentionFanOut` returns `{ handled: true, delivered: false }`; `maybeDrainPromptQueue` appends a `queued prompt not sent: …` system row instead of silently dropping it (Codex-1 #3). ✔
- **Staged-image removal after enqueue:** `images` is captured with `stagedImages.slice()` then each entry `Object.freeze({ ...img })` at enqueue, so neither removing an image from the live composer nor a future in-place mutation of a `StagedImage` corrupts the queued snapshot (Grok-1 hardening) — covered by an isolation test. Shallow freeze is sufficient only because `StagedImage` is **flat** (`data`/`mimeType`/`path`, all primitives, `:240-244`); a future nested field would need a deep clone (note the assumption in the test, Claude-2 L5). ✔
- **Zen mode:** `renderActiveLaneQueue()` early-returns (slot hidden) when `zenMode`; the queue is not shown on the zen surface in v1 (zen uses its own left rail). ✔
- **Rejected `#new` / `#restart` (lane busy/starting):** these flash and return early *without* resetting; the queue is cleared only on the real reset path past those guards, so a rejected op leaves the queue intact (Grok-1). `#cancel` (the explicit stop gesture) clears at the top of `cancelLane`. ✔
- **Cap reached:** 11th enqueue flashes `queue full (10)` and is dropped (not silently). ✔
- **Lane switch while queued:** the queue is per-lane; switching lanes leaves each lane's queue intact and drains independently. ✔
- **`#`/`!` while busy:** unchanged — they run immediately (parsed before the queue branch). The new `#unqueue` / `#queue …` commands ride the same pre-busy path, so the queue is manageable mid-turn. ✔
- **`#unqueue N` out of range / empty queue / bad `N`:** flash (`no item N` / `nothing queued` / `bad index`), **consume the command text**, no mutation. ✔
- **`#queue edit N` with an image-only live draft (`stagedImages.length > 0`):** flash `clear staged image first`, leave the queue untouched — restoring the item's images would clobber the user's staged image (Codex-1 R2 #2). Text-only live drafts need no guard: the command text *is* the draft. ✔
- **`#queue edit N` re-send:** the popped item re-enqueues at the tail on the next Enter, not back at slot N (documented v1 behavior, Codex-1 R2 #3). ✔
- **Repeated peer preemption:** a lane that receives one peer envelope before each idle keeps the user queue held; this is the documented peer-first tradeoff (Codex-1 #4) — surfaced via the "held behind lane mail" strip, covered by a test. ✔

## Open Questions

1. **Drain precedence between peer mail and the user queue** — the design gives **peer mail precedence** (it drains synchronously inside `setLaneStatus`; the user queue checks `status === 'idle'` afterward). This is the least invasive option (coordinator untouched), and peer mail is part of an active inter-lane exchange that should usually preempt local type-ahead. It is **not** starvation-proof, however: a lane that receives one envelope before every idle transition can defer the user queue indefinitely (Codex-1 #4). The design ships peer-first as a deliberate policy, surfaces the "held behind lane mail" state so it's visible, and adds a repeated-preemption test; an aging rule is left for later. **Named v1 limitation (Claude-2 M3):** there is *no* "drain my queue next / pause peer mail" user override — the only escapes are `#cancel` (kills the turn too) and `#queue clear` (the intended abandon-the-queue-**without**-killing-the-turn path). **Proposed resolution: ship peer-first, documented + tested**, with that limitation stated next to the deferred-aging note. Confirm, or state a preference for user-first (more invasive).

2. **Scope of the pre-existing `finishTurn` re-entrancy fix** — moving old-turn cleanup before the draining status transition (Research note / Codex-1 #1) fixes a latent peer-provenance + elapsed-time bug that exists *today*, independent of this feature. The prompt queue itself is made correct purely by the `queueMicrotask` deferral, so this reorder is not coupled to the queue. **Revised proposed resolution (Claude-2 Q2): split it — land the cleanup-reorder as its own small fix FIRST (with its own back-to-back-peer-turns test), then build the queue on top.** Rationale: it's an independent bug, co-landing would mix orthogonal peer-provenance assertions into the queue PR and make a bisect ambiguous, and there's no coupling forcing co-land. This spec stays scoped to the queue and references the reorder as a prerequisite. Confirm.

3. **Interpretation of "bottom of the lane-peek position" — RESOLVED** (user redirect: "show in right rail, not depend on other"). The active lane's queue renders in a **new bottom-anchored rail slot** within the `.acp-harness__lane-rail` overlay, shown **independently** of the lane peek: `queueSlotEl` toggles purely on `activeLane.queuedPrompts.length > 0`, never gated on whether a (non-active) peek candidate is visible. The rail overlay therefore appears whenever there is a plan, a peek, **or** a non-empty active-lane queue — any combination. Rejected: (a) appending the queue inside the peek `<aside>` (it shows a *different* lane's card); (b) a composer strip; (c) coupling queue visibility to peek visibility.

## Out of Scope

- **Reordering** queued items (move N to front / swap). `#unqueue`, `#queue clear`, and `#queue edit N` are in scope; promote/reorder is not.
- A dedicated modal **queue-focus mode** (`j`/`k`/`d` over rows). The `#…` command family covers management without a new input mode.
- Persisting the queue across app restart or session reset.
- Concatenating multiple queued prompts into one turn (one-per-idle is intentional).
- Queueing `#`/`!` control commands (they run immediately by design).
- Cross-lane / broadcast queueing.

## Resources

- `src/acp/acp-harness-view.ts:3221` `submitActiveLane`, `:1194` `enqueueSystemPrompt`, `:3398` `finishTurn`, `:5940` `renderComposer`, `:6031` `composerStatusChip` — the integration points.
- `src/acp/lane-inbox.ts:7` `LaneInbox` / `src/acp/inter-lane.ts` `InterLaneCoordinator.onBus` drain-on-idle — the queue/drain prior art this mirrors.
- `docs/106-inter-lane-messaging.md` — the peer-mail queue + `awaiting_peer` lifecycle this design composes with.
- `docs/72-acp-harness-view.md` — harness view reference to update.
- Claude Code message-queue behavior (typed-while-busy → sequential drain, Esc clears) — UX reference for one-per-turn drain + explicit clear.
