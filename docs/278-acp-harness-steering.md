# ACP Harness Mid-Turn Steering — Implementation Spec

> Status: Implemented (unit-tested; not yet exercised against a live adapter in the running app)
> Date: 2026-10-05
> Milestone: M-ACP — Harness convergence
> Builds on: specs 72, 106, 136, 199, 275 · inspired by Empryo steering

## Problem

When a lane is busy, `Enter` queues the prompt (spec 136), and the queue sends it only after the whole turn ends. A correction like "stop, do the middleware first" arrives after the agent has already done the wrong work. The only way to act on a running turn today is to cancel it, which throws away its progress.

## Solution

For lanes whose adapter advertises the `_session/steering` ACP extension (claude-agent-acp, codex-acp), `Enter` on a busy lane **steers**. The message goes into the running turn through `_session/steering`, and the agent adjusts at its next step without a cancel. `Cmd+Enter` on a busy lane keeps today's behavior: it queues the message as a follow-up. Lanes without the extension work exactly as they do now.

If a steer does not land, the message goes to the head of the queue. That happens when the turn ended first, the adapter refused, or the turn type can't be steered. The message is never lost and never sent twice.

## Research

**Standard ACP has no steering.**
- v1 offers `session/prompt`, which blocks until the turn ends, and `session/cancel`. That is all.
- Krypton keeps one `session/prompt` in flight per session (`docs/72-acp-harness-view.md:50`). The Rust side has no guard of its own; only the TS status gates enforce this.
- An RFD for mid-turn input (`session/inject`) is still open and is not in the SDK 1.7.0 schema.
- The v2 draft answers `session/prompt` on acceptance. claude-agent-acp deliberately does **not** advertise steering on its v2 surface (PR #1254).

**`_session/steering`** is a vendor extension that both adapters implement identically on the wire.
- **Advertised** in the top-level `_meta.steering.supported` of the initialize response, as a sibling of `agentCapabilities`, not inside it.
- **Request:** `{sessionId, prompt: ContentBlock[], _meta?}`.
- **Result:** `{outcome: "injected" | "startedNewTurn" | "failed" | "promptRequired"}`.

**claude-agent-acp 0.86.0** (`dist/acp-agent.js:2242-2342`)
- Pushes the message into the Claude SDK input stream with `priority: "now"`.
  - This aborts the current generation. The model answers the steer as a new cycle inside the same ACP turn.
  - A foreground tool that is running (Bash, Agent, MCP) is moved to the background.
- If a permission or question is pending, it uses `"later"` instead.
- The original `session/prompt` settles only after the steer is answered, so the lane stays one turn.
- Opt-in `_meta.steering.idleBehavior: "promptRequired"`: if no turn is running, it returns `promptRequired` instead of starting a turn the client never sees.

**codex-acp 1.13.0** (`dist/index.js:38739-38922`)
- Calls Codex app-server `turn/steer {threadId, expectedTurnId, input}`.
- Review and compact turns can't be steered. That error comes back as a JSON-RPC error.
- There is no `idleBehavior`; unknown `_meta` is ignored.
- If the turn already ended, it waits for the previous prompt to finish and starts a **detached turn** (`startedNewTurn`). No `session/prompt` of ours ever resolves that turn.
- The only end signal for a detached turn is `session_info_update` with `_meta.codex.threadStatus.type` going `active` → `idle` (`index.js:30094`).
- A plain second `session/prompt` supersedes and interrupts the active one. That is not steering.

**pi-acp 0.0.26** has no steering extension. It queues a second prompt inside the adapter.

**Krypton today**
- `submitLanePrompt` queues on `busy`/`needs_permission` (`acp-harness-view.ts:8048`).
- `finishTurn` flips the lane idle. That synchronously drains peer mail (spec 106), then drains one queued prompt in a microtask.
- `request()` in `acp.rs:419` accepts any method name.
- `acp_initialize` keeps only `agentCapabilities` (`acp.rs:1759`), so the top-level `_meta` is dropped.
- `client.ts` drops `session_info_update`.

**Alternatives ruled out**
- **Cancel and resend** (Zed's "Send Now") throws away the turn's work.
- **A cooperative MCP inbox tool** only works if the model remembers to poll it.
- **A second `session/prompt`** queues as a new turn on Claude and interrupts the turn on Codex.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Empryo | Typing while busy queues (max 5). Before each LLM step, `prepareStep` drains the whole queue into one `<steering>` user message. Ctrl+X clears the queue. | The message waits for running tools. A queue left over at turn end becomes the next prompt. |
| Codex CLI | `Enter` while running = steer. `Tab` = queue for the next turn. | Steer is the default since 0.157. |
| Claude Code / pi | Messages sent while working are added to the running turn. pi: `Enter` steers, `Alt+Enter` queues a follow-up. | pi-agent-core `steer()` / `followUp()`. |
| Zed | Send while generating queues. Native agent "Steer" ends the turn at the next tool boundary, then sends the message. External ACP agents only get queue or "Send Now" (cancel + resend). | Zed does not use `_session/steering`. |
| yaac / screenplay (ACP clients) | Use `_session/steering`. Only `injected`/`startedNewTurn` count as taken; anything else queues. A Codex `startedNewTurn` is tracked through `threadStatus` until `idle`. | Same outcome handling as this spec. |

**Krypton delta**
- Matches the Codex, pi and Empryo convention: `Enter` steers.
- The queue key is `Cmd+Enter`, because `Tab` is taken by the composer palettes and `Alt` does not work in Krypton.
- Unlike Empryo, delivery timing belongs to the adapter. Claude aborts the current generation; it does not wait for the next step.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | `AgentInitInfo.steering_supported` (from top-level `_meta.steering.supported`). New `acp_steer` command. `session/prompt` and `_session/steering` go through `request_marked`: the reader emits an ordered `turn_marker` event for their replies, and the result carries `_kryptonRequestId`. |
| `src-tauri/src/lib.rs` | Register `acp::acp_steer`. |
| `src/acp/types.ts` | `steering_supported` on `AgentInfo`/`AgentInitInfo`. `SteerOutcome`. New `turn_state` and `turn_marker` AcpEvents. |
| `src/acp/client.ts` | `steer(blocks)` → `{ outcome, requestId }`. Map Codex `session_info_update` `threadStatus` to `turn_state`, and the reader's `turn_marker`. |
| `src/acp/harness-view-types.ts` | `HarnessLane.supportsSteering`. `HarnessTranscriptItem.steer?: 'pending' \| 'injected'`. `PromptDelivery`. |
| `src/acp/harness-view-host.ts` | `HarnessSteerHost` contract (spec 275 pattern). |
| `src/acp/harness-steer-controller.ts` | **New.** Per-lane steers in flight, outcome handling, the held turn-end stop, steer-started Codex turns. |
| `src/acp/acp-harness-view.ts` | `Enter`/`Cmd+Enter` routing. `submitLanePrompt` delivery mode. `stop` / `turn_state` / `turn_marker` routed through the controller. Capability wiring. |
| `src/acp/harness-transcript-render.ts`, `src/styles/acp-harness.css` | `· steer` label suffix and its modifier class. |
| `src/acp/harness-steer-controller.test.ts` | **New.** Outcome, ordering and detached-turn tests, plus `codexThreadState`. |
| `src/acp/acp-harness-view.test.ts` | Busy-lane routing (steer vs. queue); the `stop` / `turn_state` / `turn_marker` events route through the controller. |
| `docs/72`, `docs/136`, `docs/05-data-flow.md`, `docs/README.md` | Busy-`Enter` semantics, the new flow, and the index entry. |

## Design

### Data Structures

```ts
// types.ts
type SteerOutcome = 'injected' | 'startedNewTurn' | 'promptRequired' | 'failed';
// AcpEvent addition: emitted only from Codex session_info_update._meta.codex.threadStatus.type
| { type: 'turn_state'; state: 'active' | 'idle' }

// harness-steer-controller.ts: per-lane state, owned by the controller
// AcpEvent addition: the Rust reader announces a session/prompt or
// _session/steering reply in stdout order with the session updates around it
| { type: 'turn_marker'; kind: 'prompt' | 'steer'; requestId: number; outcome: SteerOutcome | null }

interface LaneSteerState {
  inFlight: number;                 // steers whose invoke reply is not handled yet
  stop: { stopReason; reason? } | null;  // the prompt's stop, held while steer work is outstanding
  continued: boolean;               // a steer-started turn ran inside this turn
  cancelSeq: number;                // bumped by Ctrl+C / #cancel
  // stream order (turn markers + Codex thread state):
  started: number;                  // startedNewTurn markers since the last prompt marker
  ended: number;                    // active → idle pairs whose active followed that marker
  activeSincePrompt: boolean;
  startedMarkers: Set<number>;      // startedNewTurn marker ids not yet matched to a reply
  awaitingMarkers: Set<number>;     // startedNewTurn replies whose marker has not arrived
}
// Missed steers carry their typing sequence (a WeakMap on the QueuedPrompt) so
// several misses re-queue in the order they were typed, not the order they resolved.
```

### API / Commands

```rust
#[tauri::command]
pub async fn acp_steer(session: u64, blocks: Value, registry: State<'_, Arc<AcpRegistry>>) -> Result<Value, String>
// request("_session/steering", { sessionId, prompt: blocks,
//   _meta: { steering: { idleBehavior: "promptRequired" } } })
```

- `client.steer(blocks): Promise<{ outcome: SteerOutcome; requestId }>` maps any unknown outcome string to `'failed'`. JSON-RPC errors are rethrown.
- **Why markers:** an invoke result reaches the frontend in no fixed order relative to events, so the prompt reply, the steer replies and Codex's thread status could be seen out of the order codex-acp wrote them. `acp_prompt` and `acp_steer` register their request id; when the reader meets that reply it emits `turn_marker` on the lane's event channel before resolving the invoke, so markers and thread status arrive in stdout order.
- Steer blocks contain only the user images and text (the `tail` of `buildPromptBlocks`). The lane-context packet and directive are already in the turn.

### Data Flow

```
1. Composer Enter. The lane is busy, supportsSteering is set, the text is not #/!, and it has no @mention.
   submitLanePrompt(lane, text, images, clear, 'steer') → steerCtl.steer(...)
2. The controller:
   - seals the streaming assistant row
   - appends a user row {steer:'pending'}
   - sets pendingUserEcho to that row (so an adapter echo merges into it)
   - clears the composer, increments inFlight, records the typing seq
   - calls client.steer(blocks)
3a. injected        → row.steer = 'injected'; flash "steered"
3b. startedNewTurn  → row.steer = 'injected'; if its marker has not arrived yet, the
                      reply's requestId waits in awaitingMarkers. After a cancel the
                      started turn is cancelled at once (session/cancel).
3c. promptRequired | failed | error
                    → remove the row; insert at the queue head, behind missed steers typed
                      earlier; flash "steer missed — queued (N)". After a cancel: a
                      "steer not delivered" line instead. A "method not found" error also
                      sets supportsSteering = false.
4. Stream order. codex-acp starts a steer's turn only after the previous prompt completed
   and its reply was written, so every steer-started turn goes active → idle AFTER the
   prompt marker. The prompt marker resets started/ended; each startedNewTurn marker adds
   to started; each active → idle pair whose active came after the prompt marker adds to
   ended (the old turn's own late idle has no such active, so it never counts).
5. The `stop` event goes to steerCtl.onStop, not finishTurn. The stop is held until
   inFlight == 0, awaitingMarkers is empty, and ended >= started. Then finishTurn runs —
   whole. Turn-end cleanup therefore never runs
   over a newer turn's permissions, echo or streaming rows, and the lane stays busy, so
   neither peer mail nor the queue can send a colliding session/prompt. A chain a cancel
   cut short ends 'cancelled'.
6. A harness-synthesized stop (subprocess exit), an `error` event or a failed
   session/prompt drops the held state, so it cannot swallow a later turn's stop.
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Enter` | Composer, lane `busy`, adapter supports steering | Steer into the running turn |
| `Cmd+Enter` | Composer, lane `busy`/`needs_permission` | Queue as a follow-up (spec 136 behavior) |
| `Enter` | Composer, lane `busy`, no steering support | Queue (unchanged) |
| `Enter` / `Cmd+Enter` | Lane idle / `awaiting_peer` | Send (unchanged) |

The orchestrator console seat prompt (spec 182) always passes `'queue'`.

### UI Changes

- A steered user row's label reads `steer…` while pending and `steer` once taken, in place of `user`. The modifiers are `.acp-harness__msg-label--steer` and `--steer-pending` (dimmed): text colour and opacity only, no border and no rail. `item.steer` is part of the row render signature, so the label updates in place.
- Flash chips: `steered`, `queued (N)`, `steer missed — queued (N)`.
- The harness help key list gains `⌘Enter queue follow-up`.

## Edge Cases

- **Steer races the turn end (Claude):** `promptRequired` → re-queued at the head. The held stop then ends the turn and the drain sends it as a normal turn. Nothing is lost or doubled.
- **Steer races the turn end (Codex):** `startedNewTurn`. The held stop keeps the lane busy until the started turn's idle, so no drain fires a `session/prompt` that would supersede it.
- **Codex starts the steer's turn before the old stop reaches Krypton:** the old stop is held like any other, so its `finishTurn` cleanup never clears the new turn's permissions, questions, echo or streaming rows.
- **Short steer-started turn ends before the `startedNewTurn` reply:** its active → idle is already counted in `ended`, so the held stop ends the turn when the reply lands.
- **Old `idle` arrives late (after the prompt marker):** it has no active after the marker, so it does not count as a started turn's end.
- **Enter pressed before any thread status arrived:** nothing depends on the state at send time; counting starts at the prompt marker.
- **Concurrent steers that each start a turn:** `started` counts every `startedNewTurn`, and the held stop waits until as many turns went idle. One turn's idle can never satisfy another's.
- **A `startedNewTurn` reply seen before its marker:** it waits in `awaitingMarkers`, so the turn it started is counted before the stop can be released.
- **No thread status seen yet:** still waits. A lane's first prompt can be a command codex-acp answers without a native turn (`/status`, `/skills`, `/mcp`), so the first status may be the steer-started turn's own.
- **Only an idle ends a steer-started turn.** `session/cancel` is a notification that does not wait for the turn to stop, so Ctrl+C does not release the held stop by itself — the interrupted turn's idle does, and the turn ends `cancelled`. An adapter whose idle never comes leaves the lane busy, which is the spec 199 case: Ctrl+C, then Ctrl+C again past the 10 s window force-restarts the lane (a new `spawnEpoch` drops the held state).
- **Ctrl+C on a steer-started turn:** `cancelLane` sends `session/cancel`. Codex emits `idle` and the turn finishes `cancelled`. If it never does, spec 199 escalates to a force-restart.
- **Ctrl+C while a steer is in flight:** a non-injected outcome after the cancel is **not** re-queued. It becomes a system line `steer not delivered: <text>`, matching how spec 136 reports a queued prompt it could not send. A `startedNewTurn` after the cancel is cancelled at once (`steer cancelled`), because Codex's cancel only stopped the turn running at the time.
- **Lane restart / new session while in flight:** a `spawnEpoch` mismatch makes the late outcome a no-op.
- **Codex review/compact turn:** the JSON-RPC error → re-queued.
- **Images on a lane without image support:** the same `supportsImages` guard as a normal prompt runs before the steer.
- **Several steers before one settles:** each gets its own row. `inFlight` counts them all, and the turn end waits for the last one. Misses re-queue in typing order even when their replies arrive reversed. Codex serializes them per session.
- **Steer while a permission is pending:** not reachable. The composer is owned by the permission keys during `needs_permission`, and Claude's `later` priority covers any remote path.
- **Stale capability** (an adapter downgraded mid-session): a method-not-found error turns steering off for that lane, so later `Enter` presses queue.

## Open Questions

None.

## Out of Scope

- The native Agent view (`src/agent/`), which uses pi-agent-core `steer()`.
- Steering from Telegram / controller `lane.send`, the Raycast API, live-assist, or the orchestrator console.
- Delivering peer mail or attention-triage redirects by steering. They still drain on idle (spec 106, ADR-0001).
- Promoting an already-queued item into a steer.
- The ACP v2 surface, and adapters without `_meta.steering.supported`. These pick it up automatically once advertised.

## Resources

- [Empryo — Steering](https://empryo.com/docs/agents/steering) and the [Empryo source](https://github.com/proxysoul/Empryo) (`src/core/agents/forge.ts:433`, `src/hooks/useChat.ts:2272`) — queue-and-inject at the next step. Stop clears the queue.
- [claude-agent-acp PR #1254](https://github.com/agentclientprotocol/claude-agent-acp/pull/1254) — steering not advertised on v2. No steering RFD yet.
- [yaac PR #285](https://github.com/bsklaroff/yaac/pull/285) — which outcomes count as taken. Codex `threadStatus` tracking. Fallback to the queue.
- [screenplay PR #1304](https://github.com/zschiller/screenplay/pull/1304) — `startedNewTurn` followed through `threadStatus` until idle. Failed steers return to the queue.
- [Codex CLI shortcuts reference](https://codex.danielvaughan.com/2026/04/08/codex-cli-tui-shortcuts-slash-commands/) — `Enter` steers and `Tab` queues while running.
- Local: `@agentclientprotocol/claude-agent-acp` 0.86.0 `dist/acp-agent.js`, `@agentclientprotocol/codex-acp` 1.13.0 `dist/index.js`, `pi-acp` 0.0.26, ACP SDK 1.7.0 `schema.json` / `v2/schema.unstable.json`, Zed `crates/agent_ui/src/conversation_view/message_queue.rs` and `crates/agent/src/thread.rs:3074`.
