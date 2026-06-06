# ACP Brainstorm Lane Mode — Implementation Spec

> Status: Draft (V0.5 scope, revised after Cursor-1 + Codex-1 review)
> Date: 2026-05-21
> Milestone: M-ACP — Harness Multi-Agent
>
> **Stale-premise note (2026-06-06):** this unimplemented draft mirrors the
> spec-112 review machinery — the `review_request`/`review_reply` MCP tools, the
> `review` envelope `kind`, and the per-requester `inFlightReviews` /
> `openReviewPackets` mutex it proposes to mutex against. That machinery was
> removed by `docs/145-harness-design-review-panel.md`; `#review` no longer holds
> any coordinator-side in-flight review state. If brainstorm mode is ever built,
> drop the `inFlightReviews`/`review_in_flight` mutex references and model it on
> the spec-145 agent-orchestrated `peer_send` fan-out instead.

## Problem

Krypton's ACP harness can fan-out chat via repeated `peer_send` calls, but there is no first-class flow for **idea brainstorming across lanes**. Today a user who wants three lanes to weigh in on a design question must:

1. `peer_send` the same prompt to each lane individually (lossy: easy to drift between sends, easy to miss replies),
2. wait for free-form chat replies that arrive interleaved with other peer traffic,
3. mentally aggregate the answers, compare them, and decide who to follow up with.

The result: multi-lane *thinking* is not yet materially better than asking one lane carefully. There is no structured channel for "lane A wants N other lanes to propose ideas on topic X, then optionally critique each other's ideas." The lanes also tend to converge prematurely when they can see each other's drafts — i.e. groupthink — which the current chat-only path cannot prevent.

## Solution

Add **Brainstorm Lane Mode**: a user-directed flow where one lane fans out a single prompt to a set of lanes, collects **structured ideas** back, and (optionally) runs a second *convergent* round where each lane critiques the consolidated list.

The flow has two phases:

1. **Divergent phase** — harness sends the same prompt to every target lane in parallel. Each lane is **blind** to the others' replies. Each lane replies via `brainstorm_reply` with a list of `Idea { title, body, tags?, confidence? }`.
2. **Convergent phase (optional)** — once all divergent replies arrive (or the partial-aggregate timeout fires), harness sends every lane the **consolidated, anonymised idea list** and asks for ranking + critique. Each lane replies via `brainstorm_critique` with `{ rankings, critiques, addedIdeas? }`.

The harness — not the agent — assembles the consolidated list, anonymises authorship before round 2, and renders a **brainstorm card** in the requester lane that aggregates ideas grouped by tag (or by source lane, toggleable).

Two new MCP tools (`brainstorm_request`, `brainstorm_reply`) — plus `brainstorm_critique` for round 2 — sit next to `peer_send` and `review_request` on the existing `krypton-harness-bus` server. Transport reuses the peer envelope + inbox path from Spec 106. A new transcript item kind `brainstorm` renders the aggregated card.

**V0.5 scope** (this spec): user-triggered `#brainstorm <lane1,lane2,…> -- <topic>` chat command, divergent phase only, structured ideas list with tags + confidence, brainstorm card in requester lane grouped by tag with **source-lane attribution visible**. Per-target envelope addressing uses lane **IDs** (not display names) end-to-end; the parser is the only place display names are resolved. **`brainstorm_request` is not exposed as an agent-callable MCP tool in V0.5** — the flow is `#brainstorm`-only, mirroring `#review`. `brainstorm_reply` is the only new MCP tool. **Deferred to V1+**: convergent critique round, idea-merge UI, persisting brainstorm transcripts across restart, palette action, mirrored card in each contributor lane, "promote idea to spec" action, partial-aggregate timeout heuristics, agent-callable `brainstorm_request`.

## Research

- **Spec 106 (`peer_send`)** already provides the per-lane inbox, the `awaiting_peer` blocking status, and the `#cancel` lifecycle. Brainstorm reuses all of it — the only delta is "many at once" instead of point-to-point.
- **Spec 112 (Review Lane Mode)** introduced the pattern of *harness-built packet → structured tool reply → typed transcript card*. Brainstorm is the multi-recipient generalisation: same shape, fan-out target set, aggregate the replies.
- **`HookServer::pending_bus_replies`** maps `envelopeId → oneshot::Sender` per **MCP round-trip**. That is the right layer for *one* `brainstorm_reply` call → its own `requestId` (same as `review_reply` today via `acp_bus_reply`). The **multi-reply aggregate is NOT a Rust concern** — keeping a long-lived collection in `pending_bus_replies` would conflate single-reply transport with multi-target session state. The aggregate belongs in `InterLaneCoordinator` (frontend), parallel to how `inFlightReviews` + `openReviewPackets` + `cancelledPacketIds` already live there for review mode.
- **`InterLaneCoordinator`** already drains envelopes on `idle` transitions per lane. The existing drain logic **does need brainstorm-aware branches** (corrected from initial draft) — `composePrompt`, `clearPendingFromPeer`, and `drain` all dispatch on envelope `kind`, so a new `'brainstorm_request'` kind needs its own branch in each (mirrors `review_request` precedent).
- **Anonymisation matters for round 2**: if lanes see "Cursor-1 said X", they anchor on identity instead of judging the idea. Round 2 prompts strip lane names and re-label ideas as `Idea-A`, `Idea-B`, …

**Alternatives ruled out:**

- *Use `peer_send` repeatedly and let the user aggregate* — exactly the status quo this spec is solving. No structure, no anonymisation, no convergent round.
- *Single tool with `to_lanes: string[]`* — works for fan-out but conflates "ask a peer something" with "brainstorm". Hard to render distinct UI later. Separate tool is clearer.
- *Auto-trigger brainstorm at start of every new task* — same groupthink + noise problem as auto-review. User-directed only.
- *Real-time shared-canvas brainstorming (lanes see each other's drafts as they type)* — high-cost UI for low marginal value over phase-1 blind + phase-2 critique. Out of scope.
- *Vote-only convergent phase (each lane picks a winner with no critique)* — loses the dissent-capturing value of brainstorm. Critique is the point.

## Prior Art

| Approach | Implementation | Notes |
|---|---|---|
| Delphi method (decision research) | Anonymous expert opinions → consolidated summary → rounds of refinement until convergence. | Direct intellectual ancestor; phase-1-blind + phase-2-critique mirrors this. |
| AutoGen / CrewAI multi-agent debates | Multiple agents take turns reacting to each other in a shared thread. | Sequential, conversation-style; suffers from anchoring and length blow-up. Krypton's parallel-then-aggregate avoids both. |
| Anthropic constitutional-AI / Self-critique | One model produces, then critiques its own output. | Single-author; brainstorm is multi-author. |
| Cursor Compose multi-edit | Same agent edits multiple files in one turn. | Not a brainstorm pattern — listed only to disambiguate. |
| GitHub Discussions / Linear "ask the team" | Human-team async brainstorm with threaded replies. | The interaction model brainstorm imitates, but bot-driven. |

**Krypton delta** — Krypton's lanes are live, user-visible ACP sessions running independently. The harness sits *between* them and can enforce phase-1 blindness, anonymise round 2, and present the aggregate as a single card the user actually scans. This is fundamentally cheaper than spawning subagents (lanes already exist) and fundamentally less noisy than multi-agent debate frameworks (no interleaved chatter).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Register **`brainstorm_reply` only** on `krypton-harness-bus` (auto-allowed alongside memory/peer/review). New Tauri event `acp-brainstorm-reply-requested`. **No new long-lived collection in Rust** — each `brainstorm_reply` is a single-shot MCP call resolved via the existing `pending_bus_replies` + `acp_bus_reply` path. `brainstorm_request` is **not** an MCP tool in V0.5; `#brainstorm` builds the packet entirely on the frontend. |
| `src-tauri/src/commands.rs` | **No new command.** Reuse `acp_bus_reply` with a `requestId`, exactly as `review_reply` does. |
| `src/acp/inter-lane.ts` | **Coordinator owns the multi-reply aggregate.** Add `inFlightBrainstorms: requesterId → packetId`, `openBrainstormPackets: packetId → { packet, targetLanes, replies: Map<laneId, BrainstormIdea[]>, missingLanes: Set<laneId>, status }`, `cancelledBrainstormPacketIds: Set` tombstone. New methods `deliverBrainstormRequest()`, `deliverBrainstormReply()`, `cancelBrainstormPacket()`. Extend `drain` / `composePrompt` / `clearPendingFromPeer` with `'brainstorm_request'` envelope kind branches. Add `onLaneClosed` branch that auto-fills missing slot and allows packet to complete if remaining targets have replied. |
| `src/acp/brainstorm.ts` | **New.** Pure helpers: parse `#brainstorm` chat command (split on first ` -- `, comma-split lanes, validate against live lane registry, resolve display names → lane IDs); build prompt from topic + requester context; aggregate replies into grouped-by-tag list (V0.5 keeps attribution visible); validate idea shape. Anonymisation helper added but unused until V1 convergent round. |
| `src/acp/acp-harness-view.ts` | Add `BrainstormPayload` + `brainstorm` transcript kind; render brainstorm card (grouped by tag, **lane attribution chip on each idea row** — no toggle in V0.5); new chat command `#brainstorm <lanes> -- <topic>`; route `acp-brainstorm-reply-requested` event into coordinator's `deliverBrainstormReply`; reject second `#brainstorm` while one is in flight **or** `inFlightReviews[requester]` is set (mutex with review). On packet `complete`, mirror `appendReviewCard`'s post-complete behavior (set requester `idle`). |
| `src/acp/types.ts` | Export `BrainstormPacket`, `BrainstormIdea`, `BrainstormReply`, `BrainstormPayload`. |
| `src/styles/acp-harness.css` | Brainstorm card styles: idea list, tag chips, source-lane attribution, confidence indicator; no `backdrop-filter`. |
| `docs/106-inter-lane-messaging.md` | Cross-reference Brainstorm Mode in inbox/awaiting_peer lifecycle (multi-target case). |
| `docs/108-overall-ui-improvements.md` | Add Brainstorm Mode under Shipped after implementation. |
| `docs/PROGRESS.md` | Landing note after implementation. |

## Design

### Data Structures

```ts
// src/acp/types.ts

export interface BrainstormIdea {
  title: string;          // ≤ 80 chars
  body: string;           // ≤ 600 chars
  tags?: string[];        // ≤ 5 tags, free-form; harness groups by tag
  confidence?: 'low' | 'med' | 'high';
}

export interface BrainstormPacket {
  packetId: string;            // ULID
  topic: string;               // verbatim user prompt
  context?: string;            // optional intent paragraph from requester transcript
  fromLaneId: string;          // requester lane ID (not display name)
  fromDisplayName: string;     // requester display name (for prompts)
  targetLaneIds: string[];     // recipient lane IDs — addressing key end-to-end
  targetDisplayNames: Record<string, string>; // laneId → displayName, for prompt rendering only
  phase: 'divergent';          // V1 adds 'convergent'
  createdAt: number;
}

export interface BrainstormReply {
  packetId: string;
  fromLaneId: string;          // reviewer lane ID (matched against packet.targetLaneIds)
  fromDisplayName: string;
  toLaneId: string;            // requester lane ID
  ideas: BrainstormIdea[];
  notes?: string;              // ≤ 300 chars free-form remark
  sentAt: number;
}

export interface BrainstormPayload {
  packetId: string;
  topic: string;
  targetLaneIds: string[];                          // addressing key
  targetDisplayNames: Record<string, string>;       // laneId → displayName, render only
  ideasByLaneId: Record<string, BrainstormIdea[]>;  // raw replies, attributed by laneId
  // groupedByTag is computed at render time, not stored
  arrivedLaneIds: string[];
  missingLaneIds: string[];                         // lanes cancelled/closed/un-replied at cancel time
  status: 'collecting' | 'complete' | 'cancelled';
}
```

### Chat Command

`#brainstorm <lane1>,<lane2>[,…] -- <topic>`

- **Mandatory `--` separator** between the lane list and the topic. The lane list is the literal string before the first ` -- ` (space-dash-dash-space); the topic is the rest of the line, verbatim (commas, newlines, anything). This avoids ambiguity for topics that contain commas, which was an open gap in the initial draft.
- Lane list is comma-separated display names, no spaces (e.g. `Cursor-1,Codex-1`). Display names are resolved to lane IDs by the parser; if a display name is ambiguous (two lanes share a name) the command is rejected with the disambiguation hint.
- Lane list must contain ≥ 1 lane **other than the requester**. Self-include is silently dropped.
- Unknown lane names: command rejected with an error transcript row listing live lane display names.
- **Mutex with `#review`**: command rejected with `brainstorm_in_flight` if `openBrainstormPackets` has any packet from this requester, or with `review_in_flight` if `inFlightReviews[requester]` is set. The user must `#cancel` first.
- Reuses existing `#`-command parser registration alongside `#review` and `#cancel`.

### Flow

1. **Requester invokes `#brainstorm Cursor-1,Codex-1 -- should we split the auth module?`**
   Harness:
   - parses the command (display-name → laneId resolution; mutex check against open brainstorm/review),
   - builds a `BrainstormPacket` with `packetId` + verbatim topic + `fromLaneId` + `targetLaneIds`,
   - optionally appends an intent paragraph from requester's recent transcript (last user-turn intent, capped 300 chars),
   - inserts a `brainstorm` transcript row in the requester lane with `status: 'collecting'`,
   - calls `coordinator.deliverBrainstormRequest(packet, …)` which:
     - registers `openBrainstormPackets[packetId]`, sets `inFlightBrainstorms[requesterId] = packetId`,
     - calls `trackPending()` **once per target lane** (so `awaitingPeerText()` reads "awaiting 2 peers · …"),
     - enqueues one envelope per target via the existing inter-lane inbox path with envelope `kind: 'brainstorm_request'` and embedded packet.
   - **Critical drain rule (mirrors review)**: `clearPendingFromPeer` is NOT called when the **request** envelope drains into the target. Only an arriving `brainstorm_reply` clears that target's pending slot.

2. **Each target lane drains on next `idle`** and receives a programmatic user-turn wrapped in `[brainstorm-request]` framing (parallel to `[inter-lane]` from Spec 106). The framing instructs the lane to reply via the `brainstorm_reply` MCP tool with structured ideas. An inbound short row is appended to the target's transcript (parallel to `[review request →]`).

3. **As `brainstorm_reply` arrives** (one Rust → frontend round-trip per reply, resolved via existing `acp_bus_reply` + `requestId`):
   - `coordinator.deliverBrainstormReply(reply)` validates `packetId` against `openBrainstormPackets` (drop if `cancelledBrainstormPacketIds` has it),
   - **rejects** replies whose `fromLaneId` is not in `packet.targetLaneIds` (non-target lane attempting to inject — return `{ delivered: false, reason: 'not_a_target' }`),
   - overwrites that lane's slot (`ideasByLaneId[fromLaneId] = ideas`) — duplicate replies from same lane replace,
   - clears the pending slot for that target via `clearPendingFromPeer(replierId, requesterId)`,
   - re-renders the brainstorm card in-place; `arrivedLaneIds` updates,
   - if `arrivedLaneIds.length === targetLaneIds.length` (or all remaining targets are in `missingLaneIds`): flip to `status: 'complete'`, delete `inFlightBrainstorms[requesterId]`, set requester lane `idle`.

4. **Lane closed mid-brainstorm** (`bus.on('lane:closed')`): if the closed lane is in any open packet's `targetLaneIds` and hasn't replied, add it to `missingLaneIds` and append a system notice. If remaining targets have all replied, the packet completes immediately with partial data. Mirrors review's `onLaneClosed` precedent.

4. **Render** — card groups ideas by tag (default) or by source lane (toggleable via a future palette action; V0.5 ships grouped-by-tag only). Each idea shows title, body, confidence pip, and the lane(s) that proposed it (when grouped by tag, multiple lanes can land on the same idea — harness merges by title-prefix similarity in V1; V0.5 just lists each idea once per lane).

### Reviewer Prompt Format

The drain coordinator wraps the packet into one ACP user-turn message:

```
[brainstorm-request from Claude-1 — packetId=01J…]
The requester lane wants you to brainstorm ideas on the topic below.

Topic: should we split the auth module?

Context: (optional intent paragraph)

Reply by calling the brainstorm_reply MCP tool with:
  - packetId: "01J…"
  - ideas: array of { title, body, tags?, confidence? }
  - notes: optional one-line remark

Do not reply to other lanes about this topic. You are answering blind —
other lanes are answering the same prompt independently.
```

The blind-reply instruction is the key phase-1 invariant.

### Cancellation & Timeouts

- `#cancel` on the requester lane invokes `coordinator.cancelBrainstormPacket(packetId)`, which:
  - moves `packetId` to `cancelledBrainstormPacketIds` (tombstone — late replies are dropped silently),
  - deletes the packet from `openBrainstormPackets` and clears `inFlightBrainstorms[requesterId]`,
  - clears **all** pending slots for the requester (`clearPendingFromPeer` for each unreplied target),
  - notifies still-pending target lanes with a one-line `[brainstorm cancelled]` system notice (so they don't waste a turn drafting a reply for a dead packet),
  - marks the requester's card `status: 'cancelled'` with unreplied targets in `missingLaneIds`,
  - sets requester lane back to `idle`.
- V0.5 has **no timeout** — slowest lane bottlenecks the whole brainstorm. The user can `#cancel` if a lane stalls. (`onLaneClosed` partial-completion above is the only auto-progress path.)
- V1+: partial-aggregate timeout (`completeWhen: ≥ N replies` or `≥ T seconds`), implemented in `openBrainstormPackets` collector with a `setTimeout` per packet.

### Edge Cases & Validations

- **Self in target list** — silently dropped (`targetLaneIds = targetLaneIds.filter(id => id !== fromLaneId)`).
- **Single target** — allowed; brainstorm with one peer is just a structured `peer_send`. Don't reject.
- **Duplicate `brainstorm_reply` from same lane** — second reply replaces the first (lanes sometimes self-correct mid-turn).
- **Empty `ideas` array** — accepted; renders as "Lane X had no ideas" row.
- **Missing required fields** (`title` or `body`) — that idea is omitted per-idea by the harness validator; remaining ideas keep. Mirrors review-mode's lenient cleanup. Optional cap: max 8 ideas per lane (drop excess from the tail) to keep cards scannable.
- **`brainstorm_reply` from non-target lane** — rejected with `reason: 'not_a_target'` at `deliverBrainstormReply` (does not crash; the calling agent gets the error and can retry-with-correction or move on).
- **Late `brainstorm_reply` after cancel/complete** — tombstoned in `cancelledBrainstormPacketIds` (cancel) or dropped as `unknown_packet` (complete already removed from `openBrainstormPackets`). Mirrors review precedent.
- **Lane closed while in flight** — `onLaneClosed` moves that target to `missingLaneIds`; packet completes if remaining targets have replied, otherwise stays `collecting` for the rest.
- **Concurrent brainstorm/review from same requester** — V0.5 allows only one open packet (brainstorm OR review) per requester; second command returns an error row with `brainstorm_in_flight` or `review_in_flight` reason. Mutex avoids ambiguous `awaiting_peer` state.
- **Same idea title from multiple lanes** — V0.5 lists each separately with source-lane attribution; V1 merges and tags as "consensus".
- **Envelope `id` per target vs shared `packetId`** — each fan-out envelope gets its own `id` (so `clearPendingFromPeer` keying on `toLaneId` is unambiguous); all envelopes share the `packetId` for collector lookup.

## Open Questions

1. **How wide should `targetLaneIds` go in practice?** With 4+ contributors the card gets dense; we may want pagination or a "top N by confidence" view at render time. **V0.5 resolution:** ship as-is; each idea row carries a lane-attribution chip so density is scannable. Pagination/top-N is V1+.
2. **Free-form vs templated topic** (e.g. "design / debug / critique")? **V0.5 resolution:** free-form. Revisit if reply quality is inconsistent.
3. **V1 convergent round: anonymise lane identity in the card too**, not just in the prompt? **V0.5 resolution:** V0.5 divergent card **shows** attribution (needed for "promote to spec"). V1 critique **prompt** anonymises ideas as `Idea-A`/`Idea-B`/…; the card itself stays attributed.
4. **`brainstorm_reply` overwrite vs append on duplicate from same lane?** **V0.5 resolution:** overwrite (simplest; MCP tool calls aren't streamed today).
5. **NEW after review feedback — strict mutex vs allow brainstorm + review in flight simultaneously?** V0.5 picks strict mutex (one user-directed multi-lane packet at a time per requester). Re-evaluate if users hit it often.
6. **NEW — should the parser also accept lane IDs (not just display names)?** Display-name-only matches `#review` UX. Lane IDs would let power users disambiguate clashing display names without a rename. V0.5 stays display-name-only; revisit only if clashes happen.

## Non-goals (V0.5)

- **Convergent / critique round 2** — deferred to V1.
- **Persisting brainstorm cards across harness restart** — current transcript persistence already covers visible rows; the `pending_brainstorm` collector is in-memory and resets on restart.
- **"Promote idea to spec" action** — V2; would generate a `docs/<NN>-*.md` stub from a selected idea.
- **Auto-trigger brainstorm on stuck lanes** — out of scope; user-directed only.
- **Tag taxonomy / synonym merging** — V0.5 groups by exact tag string. V1 may add a simple normaliser (lowercase, trim, alias map).
- **Voting / ranking UI** — depends on V1 critique round.
