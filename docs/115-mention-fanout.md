# Mention Fan-Out — Implementation Spec

> Status: Implemented
> Date: 2026-05-22
> **Depends on:** `docs/116-soft-awaiting-peer.md` (land first, or same PR)
> Milestone: M-ACP — Harness Multi-Agent

## Problem

Users want to `@Claude-1 @Gemini-1 …` in the harness composer and fan out one question without remembering `#broadcast` syntax or calling `peer_send` N times manually. They **do not** want to block processing until every mentioned lane has replied — each answer should **inject into the requester as soon as it arrives** (same as 1:1 peering today).

## Solution

Add **mention fan-out** from the composer:

1. Parse `@DisplayName` tokens against the live lane roster.
2. Deliver the same body to each target via existing inbox + `deliver()` (`kind: 'mention_request'`).
3. **Do not batch inject.** Each target reply uses the normal `drain()` → `enqueueSystemPrompt()` path on the requester as soon as the requester is `idle`.
4. Shared `mentionPacketId` on outbound envelopes for transcript labels only — **no** `mentionPackets` map in V0.
5. Fix **`clearPendingFromPeer`** and **`trackPending`** lifecycle (see Pending lifecycle below).

No new MCP tools in V0. No `#command`. No wait-for-all gate.

## Research

- `submitActiveLane()` (`acp-harness-view.ts`) branches `#…`, `!shell`, then normal prompt.
- `InterLaneCoordinator.drain()` already injects per inbox flush when lane → `idle`.
- Prior draft of this spec proposed batched inject — **rejected by user**: incremental inject is required.
- **Pending bugs (Codex-1 review):**
  1. *Premature clear:* `A→B` creates `pending[A]={to:B}`. When **B drains the request**, `clearPendingFromPeer(B, A)` clears `pending[A]` today — so `awaiting_peer` means “peer consumed the message,” not “peer replied.”
  2. *Wrong map on reply:* When **A drains B’s reply**, the helper should clear `pending[A]`, but today it clears `pending[B]`.
  3. *Reply creates pending on responder:* `deliver()` always `trackPending(fromLaneId, …)` — a one-shot reply makes the **responder** `awaiting_peer` after its turn ends.

## Prior Art

| Product | Pattern |
|---------|---------|
| Slack | `@user` notifies; replies appear as they arrive |
| Krypton `peer_send` × N | One inject per reply — familiar behavior |

**Krypton delta** — single composer action fans out; inject semantics unchanged (per-reply).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/mention-parse.ts` | **New.** Parse `@Lane`, strip body |
| `src/acp/inter-lane.ts` | `deliverMentionFanOut()`; `expectsReply` gating on `trackPending`; fix `clearPendingFromPeer`; drain rules |
| `src/acp/types.ts` | `kind: 'mention_request'` on outbound envelopes |
| `src/acp/acp-harness-view.ts` | Mention branch in `submitActiveLane`; `@` palette; transcript prefix |
| `src/acp/inter-lane.test.ts` | Fan-out delivery + per-reply inject + pending clear |
| `docs/106-inter-lane-messaging.md` | Cross-reference |

No Rust changes in V0.

## Design

### Composer syntax

```
@Claude-1 @Gemini-1 Should this API be sync or async?
```

- **Token boundaries:** Leading mention run only — scan from start of draft; each token is `@` + `[A-Za-z][A-Za-z0-9_-]*`; longest match against roster (case-sensitive display names). Stop at first non-mention token. Body = remainder trimmed. Do **not** scan mid-body for `@` (avoids emails / accidental mentions).
- **All-or-nothing (V0):** If any token fails roster match or resolves to self, **abort entire submit** and flash the bad token — no partial fan-out to valid lanes.
- No mentions → normal submit.

### Fan-out delivery

On submit with ≥1 valid mention:

1. `deliverMentionFanOut(requester, targets, body)` loops `deliver()` per target.
2. Each envelope: `kind: 'mention_request'`, shared `mentionPacketId` (ULID) for UI only.
3. `trackPending(requester, …)` per target with `expectsReply: true` (see Pending lifecycle).
4. Requester **does not** run a local turn (no body sent to requester’s ACP session).
5. Transcript on requester: `mention · → Claude-1, Gemini-1 · <body preview>`.

Target drain prompt:

```
[mention] From Cursor-1:

<body>

Reply with peer_send({ to_lane: "Cursor-1", message, done: true }).
Use done:true for one-shot mention answers so the responder does not enter awaiting_peer.
```

### Incremental inject (required)

When target replies (`peer_send` with `done:true` → requester inbox):

1. Reply envelope is normal `kind: 'peer'` but carries optional **`mentionPacketId`** (copied from target prompt or correlated in `deliver()` when `cancelledPairs` / open fan-out state matches).
2. `drain(requester)` when `canDrainInbound` (Spec 116).
3. In `composePrompt()`, branch: if `env.mentionPacketId` set, prefix `[mention reply] From <displayName>:` instead of generic `[inter-lane] From … (id: …)` — same drain path, different label.
4. `clearPendingFromPeer(requesterId, replierId, correlatedEnvelopeId)` — one fan-out slot only.

3. Requester agent may process **immediately** — no hold for siblings.
4. On requester drain of a reply envelope (`expectsReply` was true on the original outbound): `clearPendingFromPeer(requesterId, replierId)` — **do not** clear on the target draining the *outbound request*.
5. When pending empty → recompute status (`idle` if not `busy`; see Spec 116).

**Important:** If reply 1 triggers a long agent turn, reply 2 queues in inbox until that turn ends and lane is `idle` again — same as stacked `peer_send` today.

### `awaiting_peer` semantics

Depends on **`docs/116-soft-awaiting-peer.md`** (user-approved direction):

- Enter when requester has outstanding pending peers (fan-out or `peer_send`).
- Composer **not blocked** while `awaiting_peer` — user may send another prompt (Spec 116).
- Inject on each reply when lane is `idle` or `awaiting_peer` (not only when fully idle).
- Chip: `awaiting mentions · 1/3 · #cancel` (informational).

### `#cancel`

- **V0:** `#cancel` on requester clears **all** `pending[requester]` entries and tombstones `(requester, peer)` pairs for every peer that had an outstanding wait — not packet-scoped (pair tombstone cannot scope by `mentionPacketId` alone). Mention batch + concurrent 1:1 peer wait: cancel drops all requester pending.
- Does not unsend in-flight target turns; peers get synthesized cancellation notice.
- Recompute requester status after cancel (`idle` if not `busy`).

### Out of scope (V0)

- Batched “Replies (N/N)” single inject
- `#proceed` partial batch
- `@?` optional mentions
- MCP `mention_send`
- Spec 113 brainstorm

### Pending lifecycle (required for V0 — Codex-1 blocker)

**`trackPending(sender, envelopeId, toLaneId, sentAt)` only when the envelope expects a reply:**

| Envelope | `expectsReply` | `trackPending` |
|----------|----------------|----------------|
| Outbound consult / `mention_request` | yes | on **sender** (requester) |
| Inbound reply (`peer_send` answer) | no | skip |
| `done: true` close / ack | no | skip; if sender had pending to that peer, clear on deliver |
| `review_request` | yes (existing review path) | requester, until `review_reply` |

Implementation: add `expectsReply?: boolean` on `InterLaneEnvelope` (default: infer — `mention_request` and non-`done` outbound from requester fan-out = true; replies = false).

**`PendingSend` shape** — extend with `envelopeId: string` (already stored). **`clearPendingFromPeer(requesterId, replierId, envelopeId?)`**:

- If `envelopeId` provided: remove only that pending entry (fixes duplicate `toLaneId` when 1:1 + fan-out both target B).
- Else (legacy): remove all pending entries where `toLaneId === replierId` — document as fallback only.

Call **only** when the **requester** drains an inbound reply (pass the correlated outbound `envelopeId` when known via `mentionPacketId` / review `packetId`), **never** when the target drains the original outbound request.

**`deliverReviewReply` (blocker — Claude-1):** today `inter-lane.ts:301` calls `clearPendingFromPeer(payload.fromLaneId, payload.toLaneId)` relying on swapped buggy semantics. After helper fix, **must** be:

```ts
this.clearPendingFromPeer(payload.toLaneId, payload.fromLaneId, packet.packetId);
```

Delete/update the comment at lines 296–300 that describes the old argument order.

**`appendReviewCard`:** do not unconditionally `awaiting_peer → idle`; call `recomputePeerStatus(requesterId)` — `idle` only if `pendingPeersFor` empty and no `inFlightReviews`.

```ts
function recomputePeerStatus(laneId: string): void {
  const pending = coordinator.pendingPeersFor(laneId).length;
  const lane = host.getLane(laneId);
  if (!lane || lane.status === 'busy' || lane.status === 'needs_permission') return;
  host.setLaneStatus(laneId, pending > 0 ? 'awaiting_peer' : 'idle');
}
```

## Types (V0)

```ts
// types.ts — extend InterLaneEnvelope.kind
kind?: 'peer' | 'review_request' | 'mention_request';
mentionPacketId?: string; // on outbound mention_request and correlated inbound replies
```

## Test Plan

- Parse: two mentions; `@Claude-1 @Typo` aborts with no deliver (all-or-nothing)
- Parse: `@Cursor-1 @Claude-1` with requester Cursor-1 → self filtered / abort (no self in targets)
- A→B request: B drains request — `pending[A]` **still** has B
- B replies `done:true`: A drains — `pending[A]` cleared; B **not** `awaiting_peer`
- Fan-out: two pending on requester; two incremental injects
- `done:true` close does not leave spurious pending
- Review reply clears requester pending; status recomputed when another peer still pending

## Resources

- `docs/106-inter-lane-messaging.md`
- `src/acp/inter-lane.ts`, `src/acp/acp-harness-view.ts`
