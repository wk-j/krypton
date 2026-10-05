# Review Pass on the Lane Monitor — Implementation Spec

> Status: Implemented
> Date: 2026-10-05
> Milestone: ACP Harness — observability

## Problem

A `#review pass` loop (spec 276) runs for many minutes across several lanes, but its state is
visible only inside the authoring lane's transcript: system rows, inter-lane rows, and the composer
chip. From the lane monitor dashboard (spec 168) the user sees only `rev 3` tick up, so they cannot
tell which round the loop is in, who is still reviewing, or whether the Blocker count is falling.

## Solution

Add a read-only `reviewLoop` object to each lane in the telemetry snapshot and render it as a flat
section of that lane's dashboard card: round k/N with the phase and how long it has been in that
phase, one row per reviewer (pending with elapsed time / replied with verdict), and a round strip
that shows the Blocker count per round. The controller already holds all of this state; it only gains
timestamps, a stop reason, and a `telemetry(laneId)` reader, and it asks the publisher to republish
on every change. The snapshot is pass-through JSON in Rust, so there is no backend change. The page
and the publisher bump the schema version together (v3 → v4).

## Research

- **The state already exists.** `HarnessReviewLoopController` keeps `phase`, `round`, `maxRounds`,
  `reviewers`, this round's `replies` (parsed `ReviewerResult`s), and `history`
  (`ReviewRoundSummary[]`) per loop. It lacks timestamps, a stop reason after `finish()`, and any
  state once the loop is dropped.
- **Telemetry transport** (`harness-telemetry.ts`): `HarnessTelemetryPublisher` rebuilds the snapshot
  300 ms after any LaneBus event and calls `acp_publish_telemetry`. `hook_server.rs` stores it as
  `serde_json::Value` behind a version guard (`store_telemetry`) and `GET /telemetry` returns every
  harness snapshot, so new fields need no Rust change. Per-lane extras come from option callbacks
  (`metricsFor`, spec 169). `schedule()` is public and already called directly
  (`acp-harness-view.ts:8420`, `:12753`).
- **Republish trigger.** Most loop transitions coincide with an author status change (reserve →
  `busy`, fan-out → `awaiting_peer`, fix turn → `busy`/`idle`), but a reply from one of several
  reviewers changes no status. The controller must call `schedule()` itself.
- **Schema rule (spec 169):** the page filters snapshots on an exact `SCHEMA_VERSION` match, so the
  constant moves in lockstep in the same patch; a stale open tab shows "refresh the dashboard". Raycast
  only probes `/telemetry` for liveness (`raycast/src/krypton.ts:322`) and does not read lanes.
- **Feed.** `appendLaneDiffEvents` derives the recent-events feed by diffing consecutive snapshots,
  so loop milestones can be added there without new plumbing.
- **Visual rules** (`DESIGN.binance.md`): no nested containers and no left accent rails. Green and red
  are semantic only (green = success/live, red = error/alert), and yellow is the single accent. Mono
  for all data. Row state highlights one element, not the row.
- **Alternative — a separate dashboard page or panel for loops.** Rejected: a loop belongs to one lane,
  and the lane card is where the user already looks for that lane's state.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Empryo v3 (review-till-pass) | A status line per phase: `Round {round}/{max}: fixing what the reviewer flagged` / `Round {round}/{max}: judging with fresh eyes`, and one sentence per stop reason (`loop-no-progress`, `loop-no-findings`, …) | Single reviewer; progress is text, with no per-round trend |
| GitHub Actions run graph | Every run has a real-time graph; each job carries a status icon next to its name, and the graph updates while the run is in progress | Per-unit status at a glance is the convention we follow for reviewers |

**Krypton delta:** this design follows Empryo's `Round k/N · phase` wording and the CI convention of
one status mark per unit (here, per reviewer). It adds a per-round Blocker strip, because the
question the user asks of a loop is "is it converging?", and neither tool shows that. The page stays
read-only, as all loopback surfaces are.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/review-loop.ts` | Factor `roundVerdict(summary)` out of `roundResultLine` and export it |
| `src/acp/harness-review-loop-controller.ts` | `startedAt`, `phaseSince`, `replyTimes`, `stopReason` on `ReviewLoop`; `setPhase()`; retained `ended` views; `telemetry(laneId)`; `host.loopChanged()` on every change |
| `src/acp/harness-view-host.ts` | `HarnessReviewLoopHost.loopChanged(): void` |
| `src/acp/harness-telemetry.ts` | `TelemetryReviewLoop` types, `reviewLoopFor` option, `TelemetryLane.reviewLoop`, `'loop'` feed events, schema v4 |
| `src/acp/acp-harness-view.ts` | Wire `reviewLoopFor` and `loopChanged → telemetryPublisher?.schedule()` |
| `src/acp/artifact-dashboard.html` | `SCHEMA_VERSION = 4`; loop section in the lane card; `'loop'` feed label; elapsed tick in `frame()` |
| `src/acp/harness-telemetry.test.ts`, `src/acp/harness-review-loop-controller.test.ts` | Snapshot field, feed events, retained/cleared ended view, notifications |
| `docs/168-harness-lane-monitor.md`, `docs/276-review-till-pass.md`, `docs/04-architecture.md`, `docs/README.md` | Snapshot contract, UI section, index |

## Design

### Data Structures (`harness-telemetry.ts`)

```ts
export interface TelemetryReviewLoopReviewer {
  name: string;
  /** This round: not asked yet (subject still collecting), waiting, or answered. */
  state: 'not_sent' | 'pending' | 'replied';
  verdict: ReviewerVerdict | null;     // null unless replied
  blockers: number;
  repliedAt: number | null;
}

export interface TelemetryReviewLoopRound {
  round: number;
  verdict: 'pass' | 'fail' | 'partial'; // roundVerdict() — same rule as the transcript line
  blockers: number;
  warnings: number;
}

export interface TelemetryReviewLoop {
  running: boolean;
  phase: 'collecting' | 'reviewing' | 'fixing' | 'summarizing' | null; // null once ended
  round: number;
  maxRounds: number;
  subjectLabel: string;                // diffstat headline or doc path; '' before round 1 collects
  startedAt: number;
  phaseSince: number;
  reviewers: TelemetryReviewLoopReviewer[]; // current round (final round once ended)
  rounds: TelemetryReviewLoopRound[];       // completed rounds, oldest first
  stopReason: ReviewLoopStop | null;        // set from finish() on; null while running normally
  stopLabel: string | null;                 // reviewLoopStopLabel(stopReason)
  endedAt: number | null;
}

// TelemetryLane gains:
reviewLoop: TelemetryReviewLoop | null;    // only on the authoring lane
```

`EventKind` gains `'loop'`. `TELEMETRY_SCHEMA_VERSION` 3 → 4.

### API

- Controller: `telemetry(laneId: string): TelemetryReviewLoop | null`. It returns the running loop,
  else the lane's retained ended view, else `null`.
- Host: `loopChanged(): void`, which the view maps to `this.telemetryPublisher?.schedule()`.
- Publisher option: `reviewLoopFor: (laneId: string) => TelemetryReviewLoop | null`.

### Controller rules

- `phase` changes go through `setPhase(loop, phase)`, which also stamps `phaseSince` and calls
  `loopChanged()`. `loopChanged()` is also called on loop start, on each recorded reply (with
  `replyTimes.set(name, Date.now())`), on each pushed round, and on drop.
- `finish(reason)` and `onLaneCancelled` (`'cancelled'`) record `stopReason` before anything else.
  A drop without a reason (lane missing, turn refused) records `'lane_lost'`.
- On drop, if the lane still exists, the final view (`running: false`, `phase: null`, `endedAt`) is
  kept in `ended.set(laneId, view)`. A new loop on that lane replaces it; `lane:closed` deletes it.

### Data Flow

```
1. #review pass → controller.start() → loop created → loopChanged()
2. loopChanged → telemetryPublisher.schedule() → (300 ms debounce) buildLanes()
3. buildLanes → reviewLoopFor(lane.id) → controller.telemetry(lane.id)
4. invoke acp_publish_telemetry → hook_server caches the Value → GET /telemetry
5. Dashboard polls /telemetry every 1 s → new version → updateLaneCard renders the loop section
6. frame() re-renders the elapsed text from phaseSince / repliedAt (no republish needed)
7. A reviewer reply → onHarnessReply → replyTimes + loopChanged → steps 2–5
8. Round completes → history push → loopChanged; the publisher's diff adds feed event
   'loop' "round 2/3 FAIL · 1 blocker"
9. Loop ends → stopReason + drop → ended view retained → feed event "ended: every reviewer passed"
```

Feed events (`appendLaneDiffEvents`, kind `'loop'`), one per transition:
`started → Codex-1, Grok-1` (a running loop with a new `startedAt`), `round k/N <VERDICT> · n
blockers` (when `rounds.length` grows), and `ended: <stopLabel>` (`running` true → false). The page
labels them `review pass …`.

### UI Changes (`artifact-dashboard.html`)

A `.loop` section is appended to the lane card and hidden when `reviewLoop` is `null`. It sits flat
on the card: a hairline `border-top` separator, the same treatment as the card's existing rows, with
no inner box or fill.

```
review pass                                    2/3
reviewing · 3m 12s
[2] [▢] [ ]                       ← round strip
Codex-1    replied 40s ago                  FAIL 1
Grok-1     pending 3m 12s
20 files changed, +525 / -131
```

Mock: artifact `art-100-37f539d0` (`.krypton/artifacts/hm-1/Claude-1/`), a live round plus six
loop states.

- **Header:** `review pass` in `.res-lbl` style (no wrap) on the left and `k/N` in mono on the right.
  The next line holds the phase word in accent, then `· <elapsed>` — or `ended <age>` once ended.
  A 248 px card has no room for all of this on one line. Phase words: `collecting`, `reviewing`,
  `fixing`, `writing summary`.
- **Round strip:** `maxRounds` cells (`.loop-rounds > i`, 18 px, 5 px radius, `--code-bg` fill,
  1 px `--border`). A completed round shows its Blocker count in mono; only its numeral is colored —
  green `pass`, red `fail`, yellow `partial`. The current round's cell has a 1 px accent border. The
  strip shows round progress and the trend together.
- **Reviewer rows:** name (mono, `--fg`), state text (muted: `not sent` / `pending <elapsed>` /
  `replied <age>`), and a right-aligned verdict chip (`.chip`) once replied. Only the chip numeral
  carries color (`PASS` green, `FAIL n` red, `PARTIAL` / `no verdict` yellow). The row background
  never changes.
- **Subject line:** `subjectLabel` in muted mono, with its case kept as typed (paths are never
  uppercased); omitted while empty. Once `stopReason` is set (writing summary, or ended), the subject
  line is replaced by the stop line in `--fg`: `stop: <stopLabel>` while writing the summary, plain
  `<stopLabel>` once ended.
- **No reply:** a reviewer still `pending` outside the `reviewing` phase (requests withdrawn while
  writing the summary, or the loop ended) shows `no reply`, so no elapsed counter keeps ticking.
- `frame()` updates only the header elapsed text and the pending/replied age text, the same way it
  already refreshes `.turn`.

No in-app DOM or CSS changes. No keybindings: the dashboard already opens with `Leader Shift+L` /
`#dashboard`.

## Edge Cases

- **Dashboard opened mid-loop:** the snapshot carries the full loop state (rounds + current reviewers),
  so nothing is lost. Feed events exist only from when the publisher saw them.
- **Loop ends before round 1 completes** (`subject_error`, `reviewer_lost`, `cancelled`): the ended view
  has an empty strip and shows the stop label.
- **Author lane closed:** the card disappears with the lane, and the ended view is deleted.
  `#restart` keeps the lane id, so the ended view stays until the next loop.
- **No telemetry publisher** (no harness memory id): `loopChanged()` is a no-op through `?.`.
- **Several reviewers reply inside one debounce window:** one publish carries all replies. Reply
  times are stamped in the controller, not at publish time.
- **Stale open tab after an update:** schema v3 page vs v4 snapshot → the existing "refresh the
  dashboard (schema mismatch)" notice.
- **Cost:** `telemetry()` is O(reviewers + rounds), at most 8 rounds; building runs only on publish.

## Open Questions

None.

## Out of Scope

- Per-Blocker text or fixed/new status on the dashboard; this spec shows counts only.
- Projecting the loop to the control API (spec 175), Telegram (spec 200), or Raycast.
- Keeping ended loops across an app restart.

## Resources

- [GitHub Docs — Using the visualization graph](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph) — real-time run graph with a per-job status icon; the model for one status mark per reviewer.
- `~/Source/empryo/locales/en.json:972-975, 4928-4929` (local Empryo source) — `Round {round}/{max}` phase wording and per-stop-reason sentences.
- `docs/168-harness-lane-monitor.md`, `docs/169-dashboard-resource-status.md` — snapshot transport, option-callback pattern, schema lockstep rule.
- `DESIGN.binance.md` — card, chip, and semantic-color rules for the loop section.
