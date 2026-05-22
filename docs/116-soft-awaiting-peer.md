# Soft Awaiting Peer — Implementation Spec

> Status: Draft (Codex-1 + Claude-1 review incorporated). **Land before 115** (or same PR).
> Date: 2026-05-22
> Milestone: M-ACP — Harness Multi-Agent
> Related: `docs/106-inter-lane-messaging.md`, `docs/115-mention-fanout.md`

## Problem

Spec 106 sets `awaiting_peer` after a lane sends `peer_send` / fan-out and **rejects composer submit** (`acp-harness-view.ts` ~1904). Users cannot continue working on the same lane while waiting for peer replies.

Peer replies also fail to inject promptly because `enqueueSystemPrompt()` and `deliver()` only drain when the recipient is `idle` — not `awaiting_peer` — so replies queue until `#cancel` unless `clearPendingFromPeer` happens to clear status (today it clears the wrong lane’s pending map; see `docs/115-mention-fanout.md`).

## Solution

**Soft awaiting:** keep `awaiting_peer` as a **visual / bookkeeping status** (lane chip, sidebar ⇆, `#cancel` target) but treat it like `idle` for:

1. **Composer submit** — user may send a new prompt while peers are outstanding.
2. **Inbox drain + programmatic inject** — peer replies still inject as they arrive when the lane is not `busy` / `needs_permission`.

Interleave rule (unchanged from Spec 106): if the user is `busy`, peer mail stays in the inbox and drains on the **next** `idle`/`awaiting_peer` transition after the user’s turn ends.

## Design

### Status semantics (revised)

| Status | Composer submit | Peer inbox drain |
|--------|-----------------|------------------|
| `starting` | no | no |
| `idle` | yes | yes |
| `awaiting_peer` | **yes** (new) | **yes** (new) |
| `busy` | no | no (queue) |
| `needs_permission` | no | no |

`onLaneStop()` may still return `awaiting_peer` when `pending` non-empty — for UI only.

### Inject status mutation (Codex-1 blocker)

When draining into a lane in `awaiting_peer`:

1. Do **not** `setLaneStatus(idle)` before inject (that retriggers `onBus` drain).
2. `enqueueSystemPrompt`: if `awaiting_peer`, transition **`awaiting_peer → busy`** directly, then `client.prompt`.
3. After inject turn ends, `onLaneStop` → `awaiting_peer` again if `pending` still non-empty, else `idle`.

While `needs_permission`, never drain (unchanged).

### Code changes

| Location | Change |
|----------|--------|
| `acp-harness-view.ts` `submitActiveLane` | Remove block at `awaiting_peer` (~1904–1907) |
| `acp-harness-view.ts` `enqueueSystemPrompt` | Allow inject from `awaiting_peer`; set `busy` directly (do not emit `idle` first — avoids double drain) |
| `inter-lane.ts` `deliver()` | Drain when `canDrainInbound()` |
| `inter-lane.ts` | Pending lifecycle + `clearPendingFromPeer` per **115** |
| `inter-lane.ts` | `recomputePeerStatus()` instead of unconditional `idle` in `appendReviewCard` |
| `docs/106-inter-lane-messaging.md` | Amend “composer rejects awaiting_peer” in same PR |

Optional helper:

```ts
function canDrainInbound(lane: { status: HarnessLaneStatus }): boolean {
  return lane.status === 'idle' || lane.status === 'awaiting_peer';
}
```

### Composer chip (idle + pending)

When `pendingPeersFor(lane).length > 0` and status is `idle` or `awaiting_peer`:

```
memory: … · awaiting Claude-1 (1/2) · #cancel drops pending
```

Show the same pending summary on **composer footer** (not only sidebar lane row) so soft-awaiting is visible while typing.

### `#cancel` behavior (Claude-1 warning #3)

| Lane state | `#cancel` / Ctrl+C |
|------------|-------------------|
| `busy` (user turn, pending peers may exist) | Cancel **ACP turn only** — pending peers **remain** |
| `awaiting_peer` or `idle` with pending | `cancelConversationsFor()` — clear **all** requester pending + notify peers |
| `needs_permission` | Existing permission cancel path |

Avoid accidental wipe of mention/review waits when user only meant to stop a local turn.

### Status flapping (warning #4)

Single reply drain may sequence: `busy → awaiting_peer → idle → busy` (inject). Inbox is empty after first drain — no infinite loop. UI layer should treat `LaneBus` updates idempotently; debounce composer/sidebar chip text if needed.

### Edge cases

| Case | Behavior |
|------|----------|
| User submits while 2 peers pending | Lane `busy`; replies queue FIFO; after user turn → drain queued replies in order; no drain during `needs_permission` |
| User submits, all peers already replied | `pending` empty on stop → `idle`; no `awaiting_peer` |
| Peer reply while `awaiting_peer`, user idle | Drain immediately → inject → `busy` |
| `#review` requester | Same soft composer rule; `appendReviewCard` must `recomputePeerStatus` not blind `idle` |

### Out of scope

- Global queue of multiple user prompts while `busy` (still one turn at a time)
- Auto `#cancel` when user sends unrelated prompt
- Config toggle to restore hard block (could add later)

## Test Plan

- Requester `awaiting_peer`, `submitActiveLane` succeeds → `busy`
- Reply delivered while `awaiting_peer` → `enqueueSystemPrompt` called
- Reply while requester `busy` → inbox depth 1 until user turn ends
- `clearPendingFromPeer` clears requester pending; last reply → `idle`

## Implementation order (Claude-1 + Codex-1)

1. **116** — soft awaiting, `canDrainInbound`, inject `awaiting_peer → busy`, `clearPendingFromPeer` fix + **`deliverReviewReply` call site** + `recomputePeerStatus`.
2. **115** — mention parse + fan-out on top (requires 116 drain semantics).

Same PR is fine; do not ship 115 without 116’s pending/call-site fixes.

## Resources

- `docs/106-inter-lane-messaging.md` (amend “Composer reject in awaiting_peer” when implemented)
- `src/acp/acp-harness-view.ts`, `src/acp/inter-lane.ts`
