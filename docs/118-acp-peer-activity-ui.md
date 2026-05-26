# ACP Peer Activity UI — Implementation Spec

> Status: Implemented
> Date: 2026-05-23
> Milestone: Post-M-current polish (ACP harness)
> Related: `docs/106-inter-lane-messaging.md`, `docs/109-acp-contextual-lane-peek.md`, `docs/111-harness-right-rail.md`, `docs/116-soft-awaiting-peer.md`, `docs/108-overall-ui-improvements.md`

## Problem

Multi-lane peering (`peer_send`, `#review`, mention fan-out) already updates lane status, inbox depth, transcript rows, and the contextual lane peek — but users in **zen mode** (the common focused layout) see a left rail with only a dot, lane name, and tool/context counts. Peer state is invisible on non-active lanes until the user switches lanes or discovers the peek card.

The active lane header shows `awaiting peer` and activity text in non-zen collapsed mode, but during `starting` / early `busy` the UI still feels static. Users cannot scan the rail and answer: *who is talking to whom, who is waiting, who has mail?*

## Solution

Add a **peer activity surface** on three existing UI layers — no new panels, no global mixed-lane dashboard:

1. **Zen rail hints** — extend `renderRailEntry()` so every lane row exposes status + peer relation in ≤2 compact glyphs (dot + optional suffix).
2. **Composer peer strip** — persistent one-line hint above the composer when the active lane has outstanding peer sends (`pendingPeersFor`), queued inbound peer mail (`inboxDepth > 0`), or `awaiting_peer` with no pending summary (e.g. in-flight review wait).
3. **Peek peer preempt** — when a direct peer candidate appears (priority ≤30), clear peek dismissal and show the peek even if the user hid it earlier in the session.

All data comes from existing coordinator + transcript helpers (`pendingPeersFor`, `inboxDepth`, `latestInterLaneForPeek`). No Rust changes. No new MCP tools.

## Research

- **Spec 106** defined lane-head `⇆`, `▼N` inbox chip, `inter_lane` rows, and contextual peek; zen rail was added later (spec 80) and never wired to peering visuals.
- **`renderRailEntry()`** (`acp-harness-view.ts` ~3493) sets `acp-harness__rail-entry--${lane.status}` on the row but CSS only styles `busy`, `needs_permission`, and `error` on the dot — not `awaiting_peer` or inbox.
- **`buildLanePeekCandidates()`** already ranks peer relations (awaiting recipient, inbound sender, busy counterpart). Peek can be hidden via `lanePeek.dismissedAt` / `dismissedPriority`; peer events should preempt dismissal.
- **Spec 116 (soft awaiting)** — composer no longer blocks on `awaiting_peer`; the strip must not imply "cannot type" — copy is informational (`⇆ awaiting Claude-1 · 1m · #cancel drops pending peer wait`). Composer input stays visually enabled.
- **Spec 111 (right rail)** — peek slot placement is stable; this spec does not move peek, only visibility rules.
- **`InterLaneCoordinator`** exposes `pendingPeersFor(laneId)` and `inboxDepth(laneId)`; per-lane inbound/outbound peer identity is derived from transcript via `latestInterLaneForPeek()` (same 5-minute window as peek).

**Alternatives ruled out:**

- *Global peer graph panel* — violates spec 106/109 "no mixed-lane overview"; high noise in 3+ lane harnesses.
- *Stuff full `laneActivity()` into zen rail* — unreadable; rail stays one line.
- *Animated SVG links between rails* — decorative, costly, fails keyboard-first density goal; defer.
- *Coordinator `peerEdges` map* — duplicate of transcript + pending maps; derive at render time in v1.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Zed Agent Panel | Sidebar threads show status icons; switching threads is explicit. | Multi-agent but no cross-thread "waiting on B" on A's row. |
| VS Code Peek | Inline peek without switching editor focus. | Krypton peek already matches; this spec improves discoverability. |
| Slack / Discord | Unread badges + "typing" on channels. | Rail inbox `▼N` + busy dot borrow the badge mental model. |
| tmux | Pane titles show command name only. | No cross-pane messaging; Krypton adds peer suffix as pane-title equivalent. |

**Krypton delta** — Peer hints stay lane-local and keyboard-addressable. No hover-only tooltips as the only signal; `title` attributes are supplementary. No `backdrop-filter`. Purple peering accent (`#b8a6ff`) matches spec 106.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | `deriveRailPeerHint()`, extend `renderRailEntry()`, composer peer strip in `renderComposer()`, peek dismissal preempt in `bestLanePeekCandidate()` **before** `selectLanePeekCandidate()`. |
| `src/styles/acp-harness.css` | Zen rail styles for `awaiting_peer`, inbox badge, peer suffix; composer strip styles. |
| `src/acp/acp-harness-view.test.ts` | Unit tests for `deriveRailPeerHint()` and `shouldPreemptPeekDismissal()` (+ selection after preempt). |
| `docs/106-inter-lane-messaging.md` | Cross-reference zen rail + composer strip. |
| `docs/109-acp-contextual-lane-peek.md` | Note peer-dismissal preempt. |
| `docs/72-acp-harness-view.md` | Document new surfaces. |
| `docs/108-overall-ui-improvements.md` | Move item from backlog → shipped when done. |
| `docs/PROGRESS.md` | Landing note after implementation. |

## Design

### Data Structures

View-local helper return type (not exported unless tests need it):

```ts
interface RailPeerHint {
  /** '⇆' when pendingPeers.length > 0, else ''. */
  awaitingSuffix: string;
  /** '▼N' when inboxDepth > 0, else ''. Independent of awaiting — both may render. */
  inboxSuffix: string;
  /** '←' or '→' for recent peer traffic when no awaiting/inbox suffixes, else ''. */
  trafficSuffix: string;
  /** Full phrase for title/tooltip (may combine clauses). */
  title: string;
  /** Primary CSS modifier: awaiting > inbox > traffic > none. */
  kind: 'none' | 'awaiting' | 'inbox' | 'traffic';
}
```

### `deriveRailPeerHint(lane, coordinator, now)`

**Awaiting and inbox are independent** (not first-match-wins). Render up to two `.acp-harness__rail-peer` spans: `[awaitingSuffix][inboxSuffix]`. Traffic suffix is a third span only when both awaiting and inbox are empty.

| Condition | Field | Value |
|-----------|-------|-------|
| `pendingPeers.length > 0` | `awaitingSuffix` | `⇆` |
| `pendingPeers.length > 0` | `title` (clause) | `awaiting {oldest.toDisplayName} · {age}`; multi: `awaiting {N} peers · {age}` |
| `inboxDepth > 0` | `inboxSuffix` | `▼{n}` |
| `inboxDepth > 0` | `title` (clause) | `{n} peer message(s) queued` |
| both clauses | `title` | join with ` · ` |
| `kind` | | `awaiting` if `pendingPeers.length > 0`, else `inbox` if `inboxDepth > 0`, else see traffic |
| no awaiting/inbox, `latestInterLane.direction === 'in'` within `LANE_PEEK_RECENT_MS` | `trafficSuffix` | `←` |
| no awaiting/inbox, outbound within window and counterpart `busy` or `awaiting_peer` | `trafficSuffix` | `→` |
| traffic | `kind` | `traffic` |
| none of the above | all suffixes | `''`, `kind` = `none` |

Use `coordinator.pendingPeersFor(lane.id)`, `coordinator.inboxDepth(lane.id)`, `latestInterLaneForPeek(lane)`, and `getLane(counterpartId)?.status` for outbound counterpart check.

### Zen rail rendering

Update `renderRailEntry()`:

```html
<span class="acp-harness__rail-dot"></span>
<span class="acp-harness__rail-name">{displayName}</span>
<span class="acp-harness__rail-peer">{awaitingSuffix}</span>  <!-- omitted when '' -->
<span class="acp-harness__rail-peer">{inboxSuffix}</span>
<span class="acp-harness__rail-peer">{trafficSuffix}</span>
{toolHtml}{ctxHtml}
```

- Add class `acp-harness__rail-entry--peer-{kind}` when `kind !== 'none'`.
- Set `entry.title` from hint title + status.
- Call `deriveRailPeerHint` from `refreshZenRail()` and initial `renderDashboard()` zen branch.

**CSS** (`acp-harness.css` zen section):

- `.acp-harness__rail-entry--awaiting_peer .acp-harness__rail-dot` — purple fill, subtle pulse (reuse `@keyframes acp-harness-zen-attention` at lower scale).
- `.acp-harness__rail-entry--busy .acp-harness__rail-dot` — unchanged cyan.
- `.acp-harness__rail-peer` — monospace, `0.72em`, purple tint, max-width `4ch`, no wrap.
- Inbox suffix uses existing `.acp-harness__lane-inbox` border colors for consistency.

### Composer peer strip

Show when the **active** lane has any of:

- `pendingPeers.length > 0` — primary copy from `awaitingPeerText(pendingPeers)` plus footer suffix `· #cancel drops pending peer wait` (spec 116).
- `inboxDepth > 0` and no pending — `▼N peer message(s) queued`.
- `status === 'awaiting_peer'` with empty `pendingPeers` (reachable when review/mention tracking holds awaiting without a chat pending row) — `awaiting peer · #cancel drops pending peer wait`.

**Not in v1:** generic “recent outbound/inbound” strip without pending/inbox/awaiting_peer (rail traffic suffix covers scan-only cases on non-active lanes).

Insert before composer input:

```html
<div class="acp-harness__composer-peer" role="status">
  ⇆ awaiting Claude-1 · 1m · #cancel drops pending peer wait
</div>
```

- Does not disable composer or add `composer--blocked` styling (spec 116).
- `renderComposer()` and `refreshLaneHeads()` paths must both update it.

### Peek peer preempt

**Problem (Codex-1):** `selectLanePeekCandidate()` returns `null` when `best.priority >= dismissedPriority` (`acp-harness-view.ts:6449`). Clearing dismissal *after* selection never runs for suppressed peer candidates.

**Fix:** In `bestLanePeekCandidate()`, after `buildLanePeekCandidates()` sorts candidates and **before** `selectLanePeekCandidate()`, only preempt when a **new** peer event arrived after the dismissal — otherwise `Esc` is useless whenever a peer candidate sits in the snapshot:

```ts
const PEER_PREEMPT_MAX_PRIORITY = 30; // peer tiers: 10 awaiting, 20 inbound, 30 counterpart
if (shouldPreemptPeekDismissal(candidates, this.lanePeek.dismissedAt)) {
  this.lanePeek.visible = true;
  this.lanePeek.dismissedAt = null;
  this.lanePeek.dismissedPriority = null;
}
return selectLanePeekCandidate(candidates, { ... }, now);
```

`shouldPreemptPeekDismissal(candidates, dismissedAt)` returns true only when **all** of:

- `dismissedAt !== null` (an active dismissal exists),
- the top candidate is `peer` kind at priority ≤30, **and**
- the candidate's `at` timestamp is strictly greater than `dismissedAt` (event arrived *after* the user dismissed).

Exported for unit tests.

**Priority semantics (lower number = stronger):** Peer candidates are 10–30; permission 40–60; recent activity 80 (`buildLanePeekCandidates`). Peer preempt therefore **outranks** permission for peek *visibility* when the user dismissed at priority 30 — intentional: direct peer work trumps a stale dismiss. This does **not** change permission UI: when the **active** lane is `needs_permission`, the permission banner and `Esc` path are unchanged; preempt only clears dismiss state so a non-active peer lane can appear in the peek slot. If the sorted `candidates[0]` is permission (40) because no peer qualifies, preempt does not run (`kind !== 'peer'`).

Also call `renderLanePeek()` when `setLaneStatus` → `awaiting_peer` or inbox depth increases (existing render tick).

### Data Flow

```
1. peer_send delivers → coordinator records pending on sender; target inbox++
2. setLaneStatus(sender, awaiting_peer) → LaneBus event → render()/refreshZenRail
3. deriveRailPeerHint(sender) → rail shows ⇆; deriveRailPeerHint(target) → ▼1
4. bestLanePeekCandidate → peer candidate priority 10–30 → preempt dismiss → peek visible
5. Recipient drains → busy → rail target dot cyan; sender still ⇆ until reply
6. Reply peer_send → clear pending → sender idle; rails reset; composer strip hides
```

### Keybindings

No new keybindings. Existing: `#cancel`, peek palette actions, lane switch.

### UI Changes

- Zen rail: peer suffix column between name and metrics.
- Composer: optional `acp-harness__composer-peer` status strip.
- Non-zen collapsed lane heads: **no change** (already have inbox + activity).
- Peek: auto-reopen on peer events; user can still hide with palette until next peer preempt.

### Configuration

None. Always on.

## Edge Cases

- **Lane stopped** — rail entry removed with lane; hints not shown.
- **Multiple pending peers** — `awaitingSuffix` `⇆`, title `awaiting N peers · {age}`; peek still shows oldest (existing behavior).
- **Pending + inbox** — rail shows `⇆` and `▼N` as two spans; title combines both clauses.
- **Synthetic `__harness__` notices** — never produce `←`/`→` hints (peek already excludes).
- **Review / mention envelopes** — `pendingPeersFor` includes them; suffix `⇆` is correct (waiting on reviewer). Title may say "awaiting Codex-1" without distinguishing review vs chat in v1.
- **Dismissed peek + permission** — lower priority number wins peek selection; peer (10–30) ranks above permission (40–60). Preempt clears dismiss only for `kind === 'peer'` at priority ≤30. Active-lane `needs_permission` banner and `Esc` behavior are unchanged (spec 107).
- **Narrow width** — peer suffix truncates with ellipsis; `title` carries full text.
- **Reduced motion** — pulse animation disabled via `prefers-reduced-motion: reduce` (dot static purple).

## Open Questions

None. (Reviewer may suggest deferring composer strip to v1.1 — acceptable to split if scope pressure.)

## Out of Scope

- Multi-lane peer link diagram or animated edges.
- Brainstorm multi-target aggregate rail badge (spec 113).
- Changes to MCP tools, coordinator transport, or `awaiting_peer` semantics.
- Titlebar HUD peer summary (docs 104).
- Non-zen collapsed row redesign.

## Testing

| Test | Expect |
|------|--------|
| `deriveRailPeerHint` awaiting | pendingPeers → `awaitingSuffix` `⇆`, kind `awaiting` |
| `deriveRailPeerHint` inbox only | inboxDepth 2 → `inboxSuffix` `▼2`, kind `inbox` |
| `deriveRailPeerHint` pending + inbox | both suffixes; title has two clauses |
| `deriveRailPeerHint` inbound | no pending/inbox, recent `inter_lane` in → `trafficSuffix` `←` |
| `deriveRailPeerHint` outbound busy | out + counterpart busy → `trafficSuffix` `→` |
| `deriveRailPeerHint` multi-peer title | 2 pending → title contains `2 peers` and oldest age |
| `deriveRailPeerHint` awaiting_peer no pending | status-only path not used on rail (rail uses coordinator); composer strip shows awaiting copy when `status === awaiting_peer` && pending empty |
| `shouldPreemptPeekDismissal` | `candidates[0]` peer priority 20 → true |
| `selectLanePeekCandidate` after preempt | dismissedPriority 30, peer at 20 → returns peer (not null) |
| peek no preempt | dismissed + top candidate recent-activity 80 → preempt false, selection may return null |

Manual:

1. Zen mode with A active: from A, call `peer_send` to B — rail shows `⇆` on A's row, `▼1` on B's row, composer strip appears on A, and A's peek slot shows B (no lane switch required).
2. Soft awaiting (spec 116): A `awaiting_peer`, submit a new user prompt — input stays enabled; strip remains informational; `#cancel` copy says drops pending peer wait.

## Resources

- N/A — purely internal change; prior art from existing specs 106, 109, 111, 116, 80.
