# Cross-Harness Peering — `peer_send` Across Harness Views — Implementation Spec

> Status: Ready for implementation (rev. 3 — global lane naming replaces qualified handles; all Open Questions resolved by user 2026-06-04)
> Date: 2026-06-04
> Milestone: M-ACP — Harness Multi-Agent
> Extends: `docs/106-inter-lane-messaging.md` (lifts its "cross-harness messaging" Out-of-Scope item)
> Reviewed by: Grok-1, Codex-1 (independent). **Re-reviewed by Codex-1 on rev. 3** — folded High 1 (counter must key on the rendered display-label prefix, not raw `backendId`), High 2 (cross-view `#cancel` needs explicit foreign-peer cancellation plumbing — `acceptForeignCancellation`), the cross-view envelope-keying invariant, and removed the last rev.2 "handle" wording residue.
> **Rev. 3 (user direction):** make lane `displayName` **globally unique at spawn** via a process-wide monotonic counter (`Claude-1`, `Claude-2`, … never duplicated, never recycled across all tabs/windows). This dissolves the cross-view name collision at the source, so addressing stays the bare `displayName` everywhere — no `@H#` qualified handle, no per-harness label, no generation token, no label-recycle hazard. The directory remains purely as a cross-view *router* keyed by `displayName`.
> Rev. 2 hardened identity stability, sender/replier classification across split coordinators, dispose/in-flight semantics, and the security boundary — all of which carry forward except the now-obsolete handle/label machinery.

## Problem

`peer_send` / `peer_list` only reach lanes inside the **same** `AcpHarnessView`. If the user opens a second harness view (another content tab, or another DOM window), its lanes are invisible to the first view's lanes — they cannot message each other. The user wants a lane in harness view #1 to peer with a lane in harness view #2, **including when the two views are open on different projects** — so a lane working in `/project-a` can consult a lane working in `/project-b`. To make that legible, each lane must **expose its working directory** when it registers, so peers (and the user) can tell which project a lane belongs to.

## Solution

Two pieces:

1. **Globally-unique lane names.** Lane `displayName` numbering moves from a per-view sequence to a **process-wide monotonic counter per backend type** (`Claude-1`, `Claude-2`, `Codex-1`, …). The number is vended when a lane spawns and is **never duplicated and never recycled** for the app's lifetime, so a name uniquely and permanently identifies one lane regardless of which tab/window it lives in. This removes the only reason cross-view addressing was hard (two views minting the same `Claude-1`).

2. **An in-process `HarnessDirectory` singleton** that every `AcpHarnessView` registers into on start (and removes itself from on dispose). Because all harness views share one webview / JS runtime, the directory sees every lane across every view and routes a `displayName` to its owning view's coordinator. Each registration carries the harness's **working directory (`cwd`)**; `peer_list` surfaces it per lane so an agent knows which project a peer is in.

Keep each view's `InterLaneCoordinator` as the authority for **its own** lanes. `peer_send`'s cross-view hop happens **entirely in-process** — no new Rust routing. The sender's view still consumes its own `acp-inter-lane-message` event (the `harnessId` filter is unchanged); when the target `displayName` is not one of its own lanes, the view resolves it through the directory and hands the recipient-side work to the target view's coordinator. `peer_list` enumerates lanes across the directory. Addressing is the **bare `displayName`** for local and foreign peers alike — identical to spec 106, no new handle syntax.

Cross-harness reach is **global across all open harness views, regardless of project** — the working directory is exposed as descriptive context, not a wall. (Cross-*process* — separate OS windows — remains impossible; Krypton is single-window by design.)

## Research

Findings from `src/acp/acp-harness-view.ts`, `src/acp/inter-lane.ts`, `src-tauri/src/hook_server.rs`, `src/compositor.ts`:

- **Harness identity is a sequence, not a project hash.** `hook_server.rs:291` `create_harness_memory` returns `format!("hm-{seq}")` from an `AtomicU64`. Every `AcpHarnessView.initializeHarnessMemory()` (`acp-harness-view.ts:2901`) gets a brand-new unique `harnessId`, even for the same project. (Spec 106's "keyed by project-dir hash" note is stale.)
- **The `harnessId` filter is the wall.** Rust tags every `peer_send` envelope with the *sender's* `harnessId` (`hook_server.rs:1076`) and emits `acp-inter-lane-message`. Each frontend listener drops envelopes whose `harnessId !== this.harnessMemoryId` (`acp-harness-view.ts:1320`). So only the sender's own view ever sees the event — and its coordinator only knows its own lanes.
- **Single JS runtime.** `compositor.openAcpHarnessView()` (`compositor.ts:2913`) does `new AcpHarnessView(...)` inside the one webview. There is already a process-global `getViewBus()` singleton (`view-bus.ts:204`) — precedent for a module-level singleton. So an in-process directory is the natural cross-view channel; the cross-harness hop never needs to leave JS.
- **`deliver()` is single-coordinator.** `inter-lane.ts:195` does sender-side bookkeeping (outbound transcript row + `trackPending` keyed by sender) *and* recipient-side work (push inbox + `drain`) against one `LaneHost`. Cross-view splits these across two coordinators, so `deliver()` must be factored into a sender half and a recipient half.
- **Reply clears pending in the recipient's coordinator.** `drain()` calls `clearPendingFromPeer(laneId, env.fromLaneId, …)` (`inter-lane.ts:762`) — pending is cleared by the coordinator that owns the draining lane, matched on `toLaneId`/`fromLaneId`. For this to work cross-view, the foreign lane must be keyed by its **stable globally-unique `displayName`/address** used consistently on both the send (track) and reply (clear) sides.
- **Addressing collides across views — fixed at the source.** Lane `id` is `${backendId}-${index}` (`acp-harness-view.ts:3046`) and `displayName` is e.g. `Claude-1`; today both are numbered **per-view**, so two views independently mint identical `Claude-1`. Rev. 3 moves the `index` to a **process-wide monotonic counter per backend** so names never collide and never recycle. With unique names there is no disambiguator to invent — the directory routes the bare `displayName` directly.

**Alternatives ruled out:**
- *One global coordinator replacing per-view coordinators (full merge).* Cleanest conceptually but the coordinator is wired into each view's status machine, review-lane mode (spec 112), mentions (spec 115), directives (spec 124). A composite `LaneHost` dispatching by lane key/name is a large blast radius for the gain. Rejected.
- *Make `create_harness_memory` return a project-keyed shared id so two views share one harnessId.* Then both views' listeners consume the same event and both coordinators race the single `acp_bus_reply` oneshot (Rust keeps the first reply). Breaks delivery. Rejected.
- *Route the cross-view hop through Rust (broadcast to all frontends).* Unnecessary — both views are in the same JS runtime; an in-process directory is simpler and avoids new Tauri surface.

## Prior Art

Cross-agent messaging prior art is already catalogued in spec 106 (OpenAI Swarm, AutoGen GroupChat, CrewAI/LangGraph, Claude Code `Task`). This spec adds nothing new on that axis. The novel bit here is **cross-*surface* addressing within one app** — and rev. 3 deliberately makes it boring: a flat, globally-unique namespace (like IRC nicks being unique server-wide, not per-channel) rather than a qualified `user@room` handle. tmux/Zellij have no equivalent — panes in different sessions never talk.

**Krypton delta** — every lane, in any harness, is addressed by its bare globally-unique `displayName` (`Claude-1`, `Codex-7`). Local and foreign peers look identical to the agent; the directory hides which view a peer lives in. There is no project boundary on peering: a `/project-a` lane can address a `/project-b` lane. The `cwd` exposed in `peer_list` is descriptive context (which repo a peer is in), not a wall — see [Security & Trust](#security--trust).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-directory.ts` | **New.** Module-level singleton with two jobs: (a) **vend globally-unique lane numbers** — `nextLaneNumber(labelPrefix): number` from a monotonic counter keyed by the rendered display-label prefix (not the raw `backendId` — see naming section, Codex-1 re-review High 1), never recycled; (b) **route** — register each view's entry (`harnessId`, `cwd`, `alive`, `listLanes()`, `resolveLocalDisplayName()`, `acceptInbound()`, `onForeignHarnessClosed()`), `resolveDisplayName(name)` finds the owning live harness across all views, and `onForeignHarnessClosed(snapshot)` fans out to peers on dispose. Strong refs; idempotent `unregisterHarness`. No labels, no qualified handles, no generation token. |
| `src/acp/inter-lane.ts` | Factor `deliver()` into `acceptInbound()` (recipient side: push inbox + `drain`, returns `{ result, senderIsReplier, effectiveDone }` classified against this coordinator's pending table) and `recordOutbound()` (sender side: outbound row + conditional `trackPending`/`awaiting_peer` driven by the passed classification + `recomputePeerStatus`). Keep `deliver()` as the same-view convenience that calls `acceptInbound` then `recordOutbound`. Add `pendingToward(snapshot)` + reuse `notifyPeerOfTermination` for foreign close. **`cancelConversationsFor()` gains a cross-view branch (Codex-1 re-review, High 2):** today it does `const peer = host.getLane(peerId); if (!peer) continue;` (`inter-lane.ts:545-546`), so a foreign pending peer (`Pi-7`, null locally) gets its tombstone/notice **silently skipped** — the canceller clears its own pending but the foreign peer keeps running and can still reply, breaking byte-for-byte `#cancel`. Fix: for each pending peer key that is not a local lane, resolve it via `directory.resolveDisplayName` and route the cancellation onto the **target** coordinator (inject the `peer X cancelled` notice + `notifyPeerOfTermination` on the foreign lane, and tombstone the pair there) instead of `continue`. Accept a foreign lane's `displayName` so transcript rows / pending tracking resolve names (pending is keyed by the unique `displayName`, same on send and reply). `deliverReviewRequest` gains a `cross_project_review` reject when the reviewer's normalized `cwd` differs from the requester's. |
| `src/acp/acp-harness-view.ts` | Number new lanes via `directory.nextLaneNumber(backendLabel(backendId))` (the rendered prefix) instead of a per-view index. Register with the directory in `start()` (paired with `try/finally` cleanup); in `dispose()` set `alive=false` + capture snapshot + `unregisterHarness` **before** tearing down lanes/clients/listeners. Bridge listener: when `toLane` is not a local `displayName`, `resolveDisplayName` (alive-checked → deterministic `harness_closed` on miss), call `acceptInbound` on the target view first, then `recordOutbound` locally with the returned classification; reply with the combined `DeliveryResult`. Implement `onForeignHarnessClosed` → coordinator `pendingToward`/termination notice, and `acceptForeignCancellation` → delegate to the coordinator's cancellation path on the named local lane. `coordinator.listLanes()` path extended to fold in directory peers (tagged `local:false`, carrying `cwd`). |
| `src/acp/types.ts` | Extend `LaneSummary` with `harnessId`, `local`, `cwd`. Add optional `fromDisplayName` to `InterLaneEnvelope` for cross-view rows. (No `address`/`harnessLabel` field — `displayName` is the address.) |
| `src-tauri/src/hook_server.rs` | Tool-description text only: explain that `peer_list` may return cross-harness peers (possibly in a different project), that each carries a `cwd`, and that their `address` field is the value to pass to `peer_send` `to_lane`. No routing change. |
| `docs/106-inter-lane-messaging.md` | Note that cross-harness messaging is now in scope via spec 141; update the stale "project-dir hash" line. |
| `docs/04-architecture.md`, `docs/PROGRESS.md`, `CLAUDE.md` | Doc sync. |

## Design

### Global lane naming & addressing

Every lane is addressed by its **bare `displayName`** — `Claude-1`, `Codex-7` — local or foreign, exactly as in spec 106. There is no qualified-handle syntax.

The name is unique because the number is vended from a **process-wide monotonic counter keyed by the rendered display-label prefix** (the exact string used to build the `displayName`), not a per-view index:

```
directory.nextLaneNumber('Claude') → 1, 2, 3, …   (shared across every tab/window)
directory.nextLaneNumber('Codex')  → 1, 2, 3, …
```

**Key by the rendered prefix, not the raw `backendId` (Codex-1 re-review, High 1).** `displayName` is built as `backendLabel(backendId) + '-' + n` (`acp-harness-view.ts:657`), and `backendLabel` falls back to capitalizing an unknown/custom `backendId` (`return BACKEND_LABELS[id] ?? id[0].toUpperCase() + id.slice(1)`). So two *distinct* backend ids can render the **same** prefix (e.g. a custom `backendId='Codex'` capitalizes to `Codex`, colliding with the table's `codex → 'Codex'`). If the counter were keyed by the raw `backendId`, each would get its own sequence and both could mint `Codex-1` — a routing collision under bare-`displayName` addressing. The fix: `nextLaneNumber` is keyed by the **canonical display-label prefix** that actually appears in the name. Equivalently, require `backendId → prefix` to be bijective and reject a collision at spawn; keying the counter by the prefix achieves that for free, since same-prefix lanes then share one monotonic sequence and can never produce duplicate names.

The counter is **never recycled** for the app's lifetime: when `Claude-3` closes, the next Claude lane is `Claude-4`, never a reused `Claude-3`. This is what makes a bare name safe to cache and route — a name maps to at most one lane, ever, so a stale reference to a closed lane resolves to `unknown_lane` and can never silently reach a different live lane. (This is the same safety property rev. 2 chased with a generation token, obtained for free by not recycling the visible name — so the token, the `@H#` label, and the parse step all go away.)

Cosmetic consequences the user accepted: numbers grow unbounded over a long session, and the lanes inside one view may be non-contiguous (`Claude-1` next to `Claude-5`). Counters are in-memory and reset on app restart.

`peer_send({ to_lane })` resolution:
1. Exact match against a **local** `displayName` → same-view path (`coordinator.deliver`), unchanged.
2. Else `directory.resolveDisplayName(name)` across all live harnesses → cross-view path.
3. Else `unknown_lane`.

The peer's **`cwd`** travels in `peer_list` so an agent can see which project each peer is in before messaging it.

### HarnessDirectory (new)

```ts
// src/acp/harness-directory.ts

// (a) name allocator — monotonic per rendered display-label prefix, never recycled, process-wide.
// Keyed by the prefix that actually appears in the displayName (backendLabel(backendId)),
// NOT the raw backendId, so two backend ids that capitalize to the same prefix can never
// mint the same displayName (Codex-1 re-review, High 1).
export function nextLaneNumber(labelPrefix: string): number;

// (b) router
export interface HarnessEntry {
  harnessId: string;                   // 'hm-42' — identity only, not part of any address
  cwd: string | null;                  // the view's working directory, exposed on registration
  alive: boolean;                      // flipped false at the start of dispose(), before teardown
  listLanes(): LaneSummary[];          // delegates to the view's coordinator
  resolveLocalDisplayName(name: string): { laneId: string; displayName: string } | null;
  acceptInbound(env: InterLaneEnvelope): /* see Coordinator factoring */;  // rejects if !alive
  // cross-view #cancel (Codex-1 re-review, High 2): canceller's coordinator routes a
  // cancellation onto the target view that owns the foreign pending peer, so the foreign
  // lane gets the same notice + tombstone + termination prompt as a local cancel.
  acceptForeignCancellation(targetLaneId: string, cancellerDisplayName: string): void;  // no-op if !alive
  // close notification: directory calls this on every *other* registered harness
  // when some harness disposes, handing it a snapshot taken *before* removal.
  onForeignHarnessClosed(closed: HarnessEntrySnapshot): void;
}

export interface HarnessEntrySnapshot {  // captured before unregister so cwd/names survive
  harnessId: string;
  cwd: string | null;
  displayNames: string[];              // foreign lanes that may have pending toward them
}

export function registerHarness(entry: HarnessEntry): void;
export function unregisterHarness(harnessId: string): void;  // idempotent — safe to call twice
export function peersFor(harnessId: string): LaneSummary[];  // every other live harness, any project, tagged local:false (carries cwd)
export function resolveDisplayName(name: string):
  | { harnessId: string; laneId: string; displayName: string }
  | null;       // finds the owning live harness (entry.alive) for a unique displayName
```

**Reference & lifecycle semantics (Codex-1 / Grok-1, Medium):** the directory holds **strong references** to each live view through the closures above (closures over an `AcpHarnessView` are strong refs in JS — the earlier "weak reference" wording was wrong). Liveness is therefore guaranteed *only* by paired register/unregister, so:

- `unregisterHarness` is **idempotent** (no-op if already gone) and must be safe to call from a failed `start()`.
- Registration is paired with cleanup via `try/finally`: if `start()` throws after `registerHarness`, the `finally` unregisters, so a half-initialised view can never be retained forever.
- `dispose()` **unregisters from the directory first**, then tears down lanes/clients/listeners — so no new delivery can enter a half-disposed view. `entry.alive` is set `false` at the very top of `dispose()` as a belt-and-suspenders guard for any delivery already past `resolveDisplayName`.
- The name counter is **not** cleared on unregister — only the routing entry is removed. That is what keeps numbers non-recycled even as views come and go.

### Coordinator factoring

```ts
// inter-lane.ts — new public surface
acceptInbound(env: InterLaneEnvelope): {
  result: DeliveryResult;
  senderIsReplier: boolean;   // computed on the TARGET coordinator, where the pending state lives
  effectiveDone: boolean;     // done after replier-side coercion (a replier can never close)
};

recordOutbound(
  fromLaneId: string,
  target: { displayName: string },   // foreign target — the unique displayName is the key
  env: InterLaneEnvelope,
  classification: { senderIsReplier: boolean; effectiveDone: boolean },  // from acceptInbound
): void;            // append outbound row on sender, conditionally trackPending, recomputePeerStatus
```

**Why classification must come from the target (Codex-1, High 1):** today's single-coordinator `deliver()` decides whether the sender is a *replier* by inspecting the **recipient-side** pending table (`hasPendingTo(env.toLaneId, env.fromLaneId)`, `inter-lane.ts:220-229`) *before* it tracks pending. A replier must **not** acquire pending / `awaiting_peer` — only the initiator owns the lifecycle. In cross-view that recipient-side state lives in the *target* coordinator, which the sender cannot see. So the order is inverted for the cross-view path:

- Same-view: `deliver()` = `acceptInbound` (returns classification) → `recordOutbound` (local target). Net behaviour byte-for-byte identical to today.
- **Cross-view:** the bridge calls `targetEntry.acceptInbound(env)` **first** to get `{ result, senderIsReplier, effectiveDone }`, *then* `senderCoord.recordOutbound(..., classification)`. `recordOutbound` only calls `trackPending` / flips `awaiting_peer` when `senderIsReplier === false`. The replier-side `done:true → false` coercion (a replier may never close the pair) happens inside `acceptInbound`, so `effectiveDone` is already correct before the sender's transcript row renders.

Pending is tracked keyed by the foreign lane's **unique `displayName`** (`Pi-7`), and the reply envelope carries that same name, so `clearPendingFromPeer` matches on the reply path. `host.getLane(name)` returns null for a foreign lane, so name resolution for transcript rows / `pendingPeersFor` falls back to `env.fromDisplayName` (added) rather than a local lookup.

**Cross-view envelope-keying invariant (Codex-1 re-review, point c).** On the *target* coordinator the inbound envelope must carry `env.fromLaneId` = the **sender's globally-unique `displayName`** (e.g. `Claude-1`) and `env.toLaneId` = the **target's local lane id** (`Pi-7`'s `${backendId}-${index}` within view B). With this, `hasPendingTo`, `clearPendingFromPeer`, the cancelled-pair tombstone, and the `env.fromDisplayName` transcript fallback all match on the **same foreign key** across the send and reply legs. The hazard to avoid: translating the foreign sender to a *sender-local* lane id on the target side — that would desync the track/clear keys and silently break replies. The bridge therefore resolves names exactly once, at the view boundary, before handing the envelope to `acceptInbound`.

### Data Flow (cross-view round trip)

Names: view A holds Claude-1 (cwd /project-a); view B holds Pi-7 (cwd /project-b). Numbers are globally unique, so no `@` qualifier.

```
1. User prompts Claude-1: "ask the Pi lane working on /project-b to review this".
   Agent calls peer_list → sees { displayName:'Pi-7', cwd:'/project-b', local:false }.
2. Agent calls peer_send({ to_lane: 'Pi-7', message }).
3. Rust emits acp-inter-lane-message tagged harnessId = view A's id.
4. View A's bridge consumes it (harnessId matches). toLane 'Pi-7' is not one of A's local displayNames.
5. directory.resolveDisplayName('Pi-7') → { harnessId: B, laneId, displayName:'Pi-7' }.
   entry.alive checked; if B is gone/disposing → bridge returns harness_closed now (no timeout).
6. Bentry.acceptInbound(env w/ fromDisplayName:'Claude-1', toLaneId=Pi-7's local id)
   → returns { result, senderIsReplier:false, effectiveDone } (classified on B, where pending lives)
   → Pi-7's inbox push + drain on B's next idle → Pi-7 runs the prompt.
7. A.coordinator.recordOutbound(claudeLaneId, {displayName:'Pi-7'}, env, classification)
   → outbound row in Claude-1's transcript; because senderIsReplier===false, pending(Claude-1 → 'Pi-7'),
     Claude-1 → awaiting_peer on stop. (A replier would skip pending — no false awaiting_peer.)
8. Reply: Pi-7 calls peer_send({ to_lane: 'Claude-1', message }). B bridge mirrors steps 4–7
   back toward A; on A, acceptInbound classifies Pi-7 as the replier (Claude-1 had pending toward it),
   clears Claude-1's pending('Pi-7') → Claude-1 idle → drains reply; Pi-7 does NOT enter awaiting_peer.
9. Loop until done:true (initiator = Claude-1 owns the lifecycle, unchanged from spec 106).
```

### peer_list

`peer_list` (requested via `acp-peer-list-requested`, still answered by the requester's own view) returns local lanes **plus** `directory.peersFor(harnessId)` (every other harness, any project). Each entry carries `displayName` (the address — bare for local and foreign alike), `cwd` (the lane's working directory), and `local:boolean`. Agents read `cwd` to pick the right peer across projects and pass `displayName` to `peer_send`.

### UI Changes

- Foreign peers in transcript `inter_lane` rows show the bare `displayName` (`Pi-7`) as the peer name — same rendering as a local peer; otherwise the existing single flat row (no nested boxes, per `feedback_no_nested_container`).
- No new panels, modals, or keybindings. `awaiting_peer` indicator, inbox chip, and `#cancel` behave exactly as spec 106 — each lane's own view renders its own side.

### Configuration

**No new config.** Always on. There is **no project isolation** for peering — `cwd` is disclosed as context, not enforced as a boundary (see below).

### Security & Trust

Both reviewers flagged that the v1 wording implied a project boundary that does not exist. Stating it plainly:

- **No structural isolation.** An auto-allowed `peer_send` can ferry arbitrary message text — including pasted file contents — between lanes in *different* projects, and `peer_list` discloses every open harness's full `cwd` to every lane. This is intended (the user explicitly asked for cross-project consultation), but it **is** a trust surface, so it must be legible rather than silent:
  - The `peer_send` / `peer_list` tool descriptions (`hook_server.rs`, text-only) state that peers may live in a **different repository** and that a message can cross a project trust boundary — the agent should not assume a foreign peer shares its files or its confidentiality expectations.
  - `peer_list` always surfaces each foreign peer's `cwd` so the agent (and, through the transcript, the user) can see the repo a message is about to leave for.
- **`review_request` is the one place we keep a hard boundary** — review packets carry a worktree fingerprint + diffstat that only make sense within one repo, so `review_request` / `review_reply` reject a foreign-`cwd` target with `cross_project_review` (a `/project-a` diff must not be shipped to a `/project-b` reviewer). Plain `peer_send` carrying a hand-pasted diff stays allowed — the agent owns that choice.
- **cwd normalization.** Comparisons that decide `cross_project_review` (and the same-repo grouping in `peer_list`) normalize `cwd` — resolve symlinks and trailing slashes — so two views opened on the same repo via different symlinked paths are treated as one project.
- A user-visible allow/deny prompt for foreign-project peers is deliberately **out of scope for v1** (always-on, matching spec 106's auto-delivery); it is noted as a future option if the disclosure above proves insufficient.

## Edge Cases

- **Foreign harness closed mid-conversation** — `dispose()` sets `entry.alive = false`, captures a `HarnessEntrySnapshot` (cwd + lane displayNames — taken *before* removal, since the metadata is gone afterward), calls `unregisterHarness`, then tears down lanes/listeners. The directory invokes `onForeignHarnessClosed(snapshot)` on every other registered harness; each coordinator checks `pendingToward(snapshot)` and, for any match, fires the existing `notifyPeerOfTermination` path — a synthetic "peer closed" notice into the waiting sender (same UX as a local lane closing). This needs new directory→coordinator plumbing because pending tables are private to each `InterLaneCoordinator`; the public `register/unregister/peers/resolve` surface alone cannot reach them (Codex-1, Medium 4).
- **Target disposes while a send is in flight** — the cross-view hop is a synchronous in-process call, but the *outer* `peer_send` still waits on a 2500ms Rust oneshot. If the target view disposes after `resolveDisplayName` but before/during `acceptInbound`, the bridge must return a **deterministic failure** (`harness_closed` / `lane_stopped`) immediately rather than relying on the close-notification side effect or letting the oneshot time out. The `entry.alive` flag (set at the top of `dispose()`) plus an `acceptInbound` guard that rejects when `!alive` give that deterministic result (Codex-1, High 3).
- **Colliding displayName across views** — **cannot happen by construction in rev. 3.** Names are vended from a process-wide non-recycled counter, so no two lanes (in any view, any project) ever share a `displayName`. This is the simplification that retires the entire `@H#` qualified-handle scheme.
- **Cross-project peers** — fully supported and the point of this spec; the foreign lane's `cwd` is exposed so the agent knows it is messaging a lane in a *different* repo (and should not assume shared files).
- **Stale name reference after a lane closes** — names are **never recycled**, so a cached `Pi-7` for a closed lane resolves to `unknown_lane` and can never silently land on a different live lane (the safety property rev. 2 needed a generation token for; rev. 3 gets it from the non-recycled visible name). `peer_list` remains the source of truth; agents re-query rather than caching (covers Codex-1, High 2).
- **`acp_bus_reply` race** — unchanged: only the sender's view consumes the event and owns the oneshot reply. The cross-view hop is a synchronous in-process call, so the combined `DeliveryResult` is ready before the bridge replies.
- **`#cancel` with a foreign pending peer** (Codex-1 re-review, High 2) — `cancelConversationsFor()` today skips any pending peer that isn't a local lane (`getLane(peerId)` is null → `continue`), so a foreign peer would keep running after the canceller cleared its own pending — a late foreign reply could still arrive, violating the byte-for-byte `#cancel` claim. Fix: for each foreign pending displayName, `directory.resolveDisplayName` → `targetEntry.acceptForeignCancellation(targetLaneId, cancellerDisplayName)`, which on the target coordinator injects the `peer … cancelled` notice, fires `notifyPeerOfTermination`, and tombstones the pair — identical UX to a local cancel. The canceller still tombstones its own side keyed by the foreign `displayName` so a late reply is dropped there too.
- **Self-send to own name** (`Claude-1` from Claude-1) — resolves locally to the sender → existing `self_send` guard, unchanged.
- **`review_request` (spec 112) across projects** — review packets carry a worktree fingerprint + diffstat that only make sense within one repo. `peer_send` (plain messages) works cross-project; `review_request`/`review_reply` reject a foreign-`cwd` target with a clear reason (`cross_project_review`) so an agent doesn't ship a `/project-a` diff to a `/project-b` reviewer. (Plain `peer_send` carrying a pasted diff is still allowed — the agent owns that choice.)

## Open Questions — all resolved by the user

1. ~~**Scope = same project only?**~~ **Resolved: cross-project is the goal.** Directory is global; each lane exposes its `cwd` so peers know which project they're talking to. No project scope guard.
2. ~~**Addressing format `displayName@H#`?**~~ **Resolved (rev. 3): no qualified handle.** Make `displayName` globally unique at spawn via a process-wide non-recycled counter; address every lane by the bare name. This dissolves the collision the handle existed to solve and removes the label, the generation token, and the parse step. *Sub-decision **confirmed by the user**: freed numbers are **not** recycled — the counter only moves forward — to preserve "one name = one lane, ever." Accepted cost: unbounded growth and non-contiguous numbering within a view.*
3. ~~**`peer_list` shows foreign peers by default?**~~ **Resolved: yes — show all peers.** Foreign peers are surfaced by default, tagged `local:false` and carrying `cwd` so the agent decides.
4. ~~**awaiting_peer / #cancel / done semantics identical cross-view?**~~ **Resolved: yes — keep it.** Byte-for-byte the same as spec 106 (each view owns its own side).

## Out of Scope

- Merging per-view coordinators into one global coordinator (the rejected full-merge alternative).
- Cross-**process** messaging (separate native windows / OS processes — Krypton is single-window by design).
- Acting on a foreign lane's files (e.g. reading `/project-b` from a `/project-a` lane). Peering ferries *messages* only; each lane still operates in its own `cwd`. `review_request` (spec 112), which depends on a shared worktree, stays same-project — see below.
- Persisting cross-harness conversations across restart (in-memory, like spec 106).
- A unified multi-harness overview panel.
- Group fan-out (`@mention`, spec 115) extended across harnesses — point-to-point only in v1.

## Resources

- `src/acp/inter-lane.ts:195` — `deliver()` to be factored into sender/recipient halves.
- `src/acp/acp-harness-view.ts:1309,1320,2901,3046` — bridge listener, `harnessId` filter, harness init, per-view lane numbering (moves to the directory's global counter).
- `src-tauri/src/hook_server.rs:291,1050,1076` — sequence-based `harnessId`, `peer_send`, envelope tagging.
- `src/compositor.ts:2913` — `openAcpHarnessView()`, the per-tab view factory.
- `src/view-bus.ts:204` — existing `getViewBus()` singleton (precedent for the directory).
- `docs/106-inter-lane-messaging.md` — base transport this spec extends.
- N/A — no external research; this is an internal architecture extension of an existing, documented subsystem.
