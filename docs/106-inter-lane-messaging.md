# Peering — Inter-Lane Messaging — Implementation Spec

> Feature name: **Peering**. MCP tools: `peer_send`, `peer_list`. Server: `krypton-harness-bus`.

> Status: Approved
> Date: 2026-05-19
> Milestone: M-ACP — Harness Multi-Agent

## Problem

The ACP harness runs multiple lanes (Claude, Codex, Pi, Droid, Gemini…) side-by-side over a shared codebase, but each lane is an isolated island. To make lane A consult lane B, the user must copy A's output, switch lanes, paste into B, then ferry the reply back. Two agents cannot hold a conversation directly.

We want **user-directed peer review**: the user tells lane A in plain language "ask Claude-2 to review this," A messages B, B replies, A revises, the exchange ends. No background autonomy, no auto-budgets, no watchdogs — the user stays in control and can `#cancel` at any time.

## Solution

Add four small, orthogonal primitives:

1. **LaneBus** — internal event emitter over per-lane status transitions (already-tracked state, just unwrapped as events).
2. **LaneInbox** — per-lane FIFO message queue, drained into a single ACP `session/prompt` on the next `idle` transition.
3. **Programmatic prompt path** — `enqueueSystemPrompt(text)` injects a user-turn that bypasses the UI composer. The composer remains the only path for the human.
4. **MCP tools `peer_send` + `peer_list`** — exposed via the existing harness MCP server (renamed `krypton-harness-bus`), auto-allowed like memory tools.

A new lane status `awaiting_peer` appears when A has sent an envelope and is waiting for the reply. The user is *blocked* from prompting A while it's `awaiting_peer`; cancel via `#cancel`. The ACP server inside each lane keeps full session context server-side — the harness only ferries one envelope at a time.

**No bounded budgets, no inbox capacity, no time-based watchdogs, no enabled flag.** User-directed flow + serial back-and-forth makes them unnecessary; the user is the safety net.

## Research

Key findings from `src/acp/acp-harness-view.ts`, `src/acp/client.ts`, `src-tauri/src/acp.rs`, `src-tauri/src/hook_server.rs`, and Specs 83 / 92 / 96 / 98:

- **Lane status enum already exists** (`acp-harness-view.ts:51`): `'starting' | 'idle' | 'busy' | 'needs_permission' | 'error' | 'stopped'`. We add `'awaiting_peer'`. Transitions today happen in `spawnLane()` and `onLaneEvent()` (line 971) but emit nothing; we add a `LaneBus.emit('lane:status', …)` at each transition.
- **Prompts only flow from UI composer** (`acp-harness-view.ts:1086`, `client.prompt(blocks)`). There is no programmatic entrypoint. We add one that respects the same turn-start bookkeeping (`activeTurnStartedAt`, `pendingTurnExtractions`, `acceptAllForTurn`/`rejectAllForTurn` reset semantics).
- **"Lane busy" today = hard reject** (`flashChip('lane busy')` at line 1070). Same pattern reused for `awaiting_peer`: composer rejects with `"lane awaiting peer — #cancel first"`. Programmatic enqueue (inbox drain) does not flow through the composer and is unaffected.
- **MCP host already runs** at `hook_server.rs:215+` on localhost. The memory tools live at `/mcp/harness/<harnessId>/lane/<laneLabel>` (`hook_server.rs:490`). We add two more tools to the same endpoint and rename the server `krypton-harness-bus`. No new transport.
- **Auto-allow precedent**: Spec 96 silently approves `memory_set` / `memory_get` / `memory_list` via `HARNESS_MEMORY_TOOL_NAMES` (`acp-harness-view.ts:128`). `peer_send` and `peer_list` join the same set (renamed `HARNESS_BUS_TOOL_NAMES`).
- **`#cancel` exists** as the current cancel-active-turn affordance (line 1661). We hook into the same path so cancelling a lane in `awaiting_peer` clears the bus state and notifies the peer.
- **Per-project isolation**: harness state is keyed by project-dir hash (`hook_server.rs:258`). Inter-lane messages share the same scope — lanes in different projects never see each other, by construction.

**Alternatives ruled out:**
- *Hard-cancel A's turn after `peer_send` returns* — requires calling `session/cancel`, surfaces as `stop_reason: cancelled`, looks like an error. Rejected in favour of soft guidance via tool description + return-message hint.
- *Synchronous send-and-await* — A would block on B's reply within a single turn; deadlocks on `needs_permission`. Async + `awaiting_peer` status is the only safe shape.
- *Shared context window between lanes* — defeats the design; ACP servers already maintain session state.

## Prior Art

| App | Inter-agent communication |
|-----|---------------------------|
| Claude Code (Anthropic) | `Task` tool spawns sub-agent with isolated context, returns one synthesized reply. Hierarchical, not peer-to-peer. |
| OpenAI Swarm | `handoff()` returns the next Agent. Single-active-speaker, no concurrent lanes. |
| Microsoft AutoGen | `GroupChat` + `GroupChatManager` orchestrator selects next speaker. Shared message history, heavyweight. |
| CrewAI / LangGraph | Task graphs / state machines — agents communicate via task outputs or graph edges, not free-form chat. |
| tmux / Zellij | Panes don't talk; humans copy-paste. |

**Krypton delta** — Swarm/AutoGen run in-process with a shared scheduler. Krypton's lanes are independent OS subprocesses with no shared scheduler. The design is closer to two chat clients connected by a mailbox: each lane keeps its own session context (ACP server-side), the harness ferries one envelope at a time, and the user is the only orchestrator. No prior terminal emulator implements this — it's novel at this layer.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/lane-bus.ts` | **New.** Typed event emitter. |
| `src/acp/lane-inbox.ts` | **New.** Per-lane FIFO queue. |
| `src/acp/inter-lane.ts` | **New.** Coordinator: deliver, listLanes, drain-on-idle, awaiting_peer state. |
| `src/acp/acp-harness-view.ts` | Add `'awaiting_peer'` to status enum; emit LaneBus events at every status mutation; add `enqueueSystemPrompt()`; render lane-row indicator + inbox badge; render `inter_lane` transcript rows; reject composer submit in `awaiting_peer`; rename `HARNESS_MEMORY_TOOL_NAMES` → `HARNESS_BUS_TOOL_NAMES` and add `peer_send`, `peer_list`. |
| `src/acp/acp-harness-memory.ts` | Listen for `acp-inter-lane-message` event; route into coordinator. |
| `src/acp/types.ts` | Add `InterLaneEnvelope`, `LaneSummary`, `LaneStatusEvent`; extend `HarnessLaneStatus`. |
| `src-tauri/src/hook_server.rs` | Add `peer_send` + `peer_list` tools next to memory tools; rename server `krypton-harness-bus`; emit `acp-inter-lane-message` Tauri event on `peer_send`. |
| `docs/04-architecture.md` | New "Inter-Lane Messaging" subsection under ACP harness. |
| `docs/PROGRESS.md` | Milestone entry. |
| `CLAUDE.md` | Note inter-lane messaging in harness architecture. |

## Design

### Data Structures

```ts
// src/acp/types.ts
export type HarnessLaneStatus =
  | 'starting' | 'idle' | 'busy'
  | 'needs_permission' | 'awaiting_peer'
  | 'error' | 'stopped';

export interface InterLaneEnvelope {
  id: string;             // ULID, for dedup
  fromLaneId: string;
  toLaneId: string;
  message: string;
  done: boolean;          // sender signals end-of-conversation
  sentAt: number;
}

export interface LaneSummary {
  laneId: string;
  displayName: string;
  backendId: string;
  status: HarnessLaneStatus;
  modelName: string | null;
  inboxDepth: number;
}

export interface LaneStatusEvent {
  laneId: string;
  prev: HarnessLaneStatus;
  next: HarnessLaneStatus;
  at: number;
}
```

### LaneBus

```ts
// src/acp/lane-bus.ts
type LaneEvent =
  | { type: 'lane:status'; payload: LaneStatusEvent }
  | { type: 'lane:spawned'; payload: { laneId: string } }
  | { type: 'lane:closed';  payload: { laneId: string } };

export class LaneBus {
  subscribe(handler: (e: LaneEvent) => void): () => void;
  emit(e: LaneEvent): void;
}
```

One global `laneBus` owned by `AcpHarnessView`. Initial subscribers: the inter-lane coordinator and the lane-row indicator renderer.

### LaneInbox

```ts
// src/acp/lane-inbox.ts
export class LaneInbox {
  constructor(readonly laneId: string);
  push(env: InterLaneEnvelope): void;
  drain(): InterLaneEnvelope[];
  depth(): number;
}
```

No capacity limit — user-directed serial flow means depth is normally 0 or 1.

### InterLaneCoordinator

```ts
// src/acp/inter-lane.ts
export class InterLaneCoordinator {
  constructor(bus: LaneBus, getLane: (id: string) => HarnessLane | null);

  // Called by the MCP bridge on incoming peer_send.
  deliver(env: InterLaneEnvelope): DeliveryResult;

  // Called by the MCP bridge on peer_list.
  listLanes(): LaneSummary[];

  // Called by harness when user runs #cancel on a lane.
  cancelConversationsFor(laneId: string): void;

  // Internal: on lane:status → idle, drain that lane's inbox.
  // Internal: tracks pending senders for awaiting_peer transitions.
}

type DeliveryResult =
  | { delivered: true;  envelopeId: string; queuedDepth: number }
  | { delivered: false; reason: 'self_send' | 'unknown_lane' | 'lane_stopped' };
```

### Drain Rule

When a lane transitions to `idle` *and* its inbox is non-empty, the coordinator builds **one** ACP user-turn message that concatenates all queued envelopes:

```
[inter-lane] From Claude-1 (id: <env-id>):

  <message text>

[inter-lane] Reply by calling peer_send({ to_lane: "Claude-1", message, done }).
Set done:true if you have nothing substantive to add; the conversation ends silently.
```

The trailing instruction is injected by the coordinator — it survives even if the sender forgets to include it.

If `done: true` was set on the incoming envelope, the trailing line becomes:

```
[inter-lane] Claude-1 closed the conversation (done:true).
Do NOT call peer_send again. End your turn.
```

### awaiting_peer transitions

- **Enter:** when a lane's turn ends (`stop_reason: end_turn`) *and* the coordinator records that the lane sent at least one envelope during that turn that has not yet been replied to.
- **Exit (normal):** the peer's reply arrives, gets drained into the inbox, and the next user-turn starts — status goes `awaiting_peer → busy`.
- **Exit (cancel):** user runs `#cancel` on the lane. Coordinator clears pending sends + notifies peers (synthesized inbox entry: `harness: peer cancelled`). Status goes `awaiting_peer → idle`.
- **Exit (done received):** peer sent `done: true`. After A processes the closing message its turn ends normally → `idle`.

### MCP Tools

Added to `hook_server.rs` next to memory tools. Server identity renamed to `krypton-harness-bus` (the memory tools live on the same endpoint — renaming is cosmetic).

**`peer_list`** → returns `LaneSummary[]`.

```json
{
  "name": "peer_list",
  "description": "List sibling lanes in this harness (peers you can message via peer_send).",
  "inputSchema": { "type": "object", "properties": {} }
}
```

**`peer_send`** → enqueue an envelope.

```json
{
  "name": "peer_send",
  "description": "Send one message to another lane in this harness. Async — the recipient processes it on its next idle turn. After calling this tool, end your turn; the reply (if any) will arrive as a new user message. Set done:true when you have nothing more to say.",
  "inputSchema": {
    "type": "object",
    "required": ["to_lane", "message"],
    "properties": {
      "to_lane": { "type": "string" },
      "message": { "type": "string" },
      "done":    { "type": "boolean", "default": false }
    }
  }
}
```

Tool return on success:

```json
{
  "delivered": true,
  "envelopeId": "01HX…",
  "queuedDepth": 1,
  "hint": "End your turn now. The reply will arrive as a new user message."
}
```

Tool return on failure: `{ delivered: false, reason: "self_send" | "unknown_lane" | "lane_stopped" }`.

Both tool names join `HARNESS_BUS_TOOL_NAMES` and auto-allow alongside the memory tools (`acp-harness-view.ts:128`, `hook_server.rs:572`).

### Data Flow

```
1. User prompts Claude-1 (A): "ask Claude-2 to review this patch"
2. A's turn starts (status busy). A calls tool peer_send({to:"Claude-2", message:"…"}).
3. hook_server.rs receives MCP call → emits acp-inter-lane-message Tauri event with envelope.
4. Frontend bridge (acp-harness-memory.ts listener) calls coordinator.deliver(env).
5. Coordinator: B exists, B.status === 'busy' or 'idle' → push to B.inbox. Records (A,envelopeId) as pending. Returns {delivered:true,...}.
6. Tool return reaches A; A may say a word or two and then end its turn.
7. On A's stop event: coordinator sees A has pending sends without reply → transitions A to 'awaiting_peer'.
8. B's current activity completes; B.status → 'idle'. LaneBus emits lane:status.
9. Coordinator hears event, drains B.inbox, builds the [inter-lane] prompt, calls B.enqueueSystemPrompt(text). B.status → 'busy'.
10. B runs its turn, calls peer_send({to:"Claude-1", message:"feedback:…"}).
11. Same as 3–7 in reverse: envelope lands in A.inbox; A's status was 'awaiting_peer' → 'idle' (LaneBus event) → drain → A's status → 'busy' for the new prompt.
12. Loop until one side sends done:true. After processing the closing message, the closing recipient's turn ends naturally → idle. No further drain unless the user (or that agent on a new user prompt) starts a new exchange.
```

### UI Changes

All changes appear **only** when a conversation is active. Lane sidebar is vertical.

- **Lane-row status icon** (left side, vertical sidebar): the existing dot/spinner is replaced when status is `awaiting_peer`. Same accent colour as the lane to stay flat; just a different glyph (e.g. `⏳`). No layered effects (per `feedback_no_layered_ui`).
- **Inbox depth chip** (right side of lane row): `▼N` rendered when `inbox.depth() > 0`. Hidden otherwise. One flat chip, no glow.
- **Composer reject in `awaiting_peer`**: flash chip `"lane awaiting peer — #cancel first"`. Reuses existing `flashChip()` path.
- **`inter_lane` transcript rows** in *both* lanes when an envelope is delivered/received. Payload: `{ direction: 'in'|'out', peer: laneId, peerDisplayName, message, done }`. Single flat row, distinct accent on the left edge (no nested boxes).
- **No new keybindings.** Conversation is initiated by user prompting one lane in plain language; cancellation is the existing `#cancel`.
- **No new panels, modals, or dashboards.**

### Configuration

**No new config.** Feature is always on. No TOML keys added.

## Edge Cases

- **Self-send** (`to_lane === fromLaneId`) → reject `self_send`. Sender sees the failure in its transcript.
- **Unknown lane id** → reject `unknown_lane`. Sender can call `peer_list` to discover valid ids.
- **Target lane stopped/errored** when `peer_send` arrives → reject `lane_stopped`. Sender sees the failure.
- **Target lane closed mid-conversation** (user closes B while A is `awaiting_peer`) → coordinator pushes a synthesized inbox entry to A: `harness: peer Claude-2 closed`. A's status: `awaiting_peer → idle` (so user can prompt again). The synthesized entry drains as a normal user-turn next time A is prompted, or is consumed immediately if A was already due to drain.
- **Sender lane closed before reply arrives** → reply envelope is dropped; recipient sees no error (its `peer_send` already returned `delivered:true` at queue time).
- **Recipient stuck in `needs_permission`** → no auto-timeout. User sees both UIs (their own permission prompt for the recipient, the `awaiting_peer` indicator on the sender). User decides — either resolve permission, or `#cancel` the sender.
- **User runs `#cancel` on lane in `awaiting_peer`** → coordinator clears the pending send-tracking for that lane, notifies the peer with a synthesized `harness: peer cancelled` inbox entry, lane goes `idle`.
- **User prompts a lane while its inbox is non-empty but status is idle** — happens only if the lane was already busy with something else when the envelope arrived. The user prompt wins (UI composer path); the inbox drains on the *next* idle, after the user's turn completes. User always wins the race.
- **Agent calls `peer_send` multiple times in one turn** — each becomes its own envelope, all enter the same target inbox FIFO. Drain combines them into one [inter-lane] prompt.

## Out of Scope

- **Visualization UI** — a dedicated "conversation thread" panel showing A↔B messages in one view. Foundation lands first; visualize later if raw transcript rows are insufficient.
- **Group chats** (>2 lanes in one conversation). Data model is point-to-point.
- **Persisting conversations across harness restart.** Inbox + bus state are in-memory.
- **Streaming partial replies.** Lanes exchange complete turns, not token streams.
- **Cross-project / cross-harness messaging.**
- **Auto-spawn missing peer.** Unknown lane = reject.
- **Agent-initiated peer review** (agent decides on its own to consult another lane). User-directed only in this spec.
- **Telemetry / token-cost tracking** for inter-lane traffic.

## Implementation Addendum — Round-Trip Protocol (2026-05-19)

Initial implementation made `peer_send` / `peer_list` **fire-and-forget**: Rust emitted a Tauri event and returned `delivered: true` immediately, ignoring the frontend coordinator's actual outcome. This silently masked `self_send`, `unknown_lane`, `lane_stopped`, and cross-harness leakage failures and was identified during peer review. It is replaced by a synchronous round-trip:

**peer_send (Rust → Frontend → Rust)**

1. `hook_server.rs::peer_send` builds the envelope, **registers a `oneshot::Sender` keyed by `envelopeId`** in `HookServer::pending_bus_replies`.
2. Emits `acp-inter-lane-message` with `requestId === envelopeId` in the payload.
3. Awaits the oneshot with a `BUS_REPLY_TIMEOUT` of 2500ms.
4. `acp-harness-view.ts::subscribeInterLaneBridge` listener:
   - Drops envelopes where `env.harnessId !== this.harnessMemoryId` (cross-harness filter).
   - Translates display names → internal lane ids.
   - Calls `coordinator.deliver(translated)` and obtains a real `DeliveryResult`.
   - Invokes Tauri command `acp_bus_reply({ requestId, result })` to complete the oneshot.
5. Rust receives the `DeliveryResult` and returns it to the MCP client. Non-`delivered:true` results become MCP tool errors with the reason string.

**peer_list (Rust → Frontend → Rust)**

Same shape: Rust generates a `plist-<ts>-<rand>` requestId, emits `acp-peer-list-requested`, awaits the oneshot. Frontend listener (`peerListUnlisten`) calls `coordinator.listLanes()` and replies with `{ lanes: LaneSummary[], count }`.

**Tauri surface**

- New command `commands::acp_bus_reply { request_id, result }` (registered in `lib.rs`) → `HookServer::complete_bus_reply()`.
- `HookServer::pending_bus_replies: Mutex<HashMap<String, oneshot::Sender<Value>>>` holds the in-flight registry.
- `register_bus_reply` / `drop_bus_reply` / `complete_bus_reply` are the only access points.

**Other corrections in the same pass**

- **#cancel / peer close**: `InterLaneCoordinator.cancelConversationsFor` and `onLaneClosed` now synthesize an envelope with `fromLaneId: '__harness__'` into the peer's inbox so the peer agent learns of termination in-context. `composePrompt` and `drain` special-case `__harness__` envelopes to skip the standard `[inter-lane] From X` framing and `inter_lane` transcript row (the system notice already handles the UI side).
- **awaiting_peer cancel path**: `cancelLane` returns after `setLaneStatus(idle)` for an `awaiting_peer` lane — no ACP `session/cancel` call (there is no active prompt).
- **Prompt context**: `renderPromptMemoryPacket` advertises `peer_send` / `peer_list` when `hasPeers`.
- **`InterLaneEnvelope.harnessId`**: added as optional field on the TS type to match the Rust-side scope tag.

## Resources

- `src/acp/acp-harness-view.ts:51,128,876–971,1070,1086,1661` — lane state machine, auto-allow constants, prompt dispatch, cancel.
- `src/acp/client.ts:78–177` — `AcpClient.spawn`, `initialize`, `prompt` flow.
- `src-tauri/src/hook_server.rs:215–328,490–725` — harness MCP server, tool dispatch.
- `src-tauri/src/acp.rs:586–614` — `session/request_permission` oneshot pattern.
- `docs/83-acp-shared-mcp-config.md` — `.mcp.json` bridge precedent.
- `docs/96-acp-built-in-memory-auto-approval.md` — auto-allow pattern this spec mirrors.
- `docs/98-acp-harness-memory-on-demand.md` — per-project memory scoping.
- [OpenAI Swarm — handoff](https://github.com/openai/swarm) — single-active-speaker contrast.
- [Microsoft AutoGen — GroupChat](https://microsoft.github.io/autogen/docs/Use-Cases/agent_chat#group-chat) — in-process orchestrator contrast.
- [Agent Communication Protocol (ACP) — Zed](https://zed.dev/blog/agent-client-protocol) — confirms ACP is per-process; harness layer is the right place for inter-agent.
