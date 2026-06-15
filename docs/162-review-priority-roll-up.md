# Review Priority Roll-up — footer indicator + summon overlay — Implementation Spec

> Status: Implemented
> Date: 2026-06-15
> Milestone: ACP harness — attention & review surfaces

## Problem

`mark_review_priority` (spec 160) data is currently visible **only inside the Diff Window**: a lane self-reports `high`/`routine` line ranges, and the Window folds routine hunks and marks/navigates high ones. There is no harness-level awareness — the human cannot see, without opening each lane's diff one by one, that "Claude-1 flagged 3 high spots, MiMo-1 flagged 1." The user wants the same harness-level treatment the other two self-report surfaces already have: a quiet footer indicator plus a summon-on-demand overlay.

## Solution

Mirror the **review quality matrix** (spec 146) surfacing pattern exactly, applied to the review-priority reports that already arrive and are already stored harness-wide (`reviewPriorityReports`). Add (1) a neutral footer depth indicator showing the count of `high` ranges across all lanes, published over a new `review:priority` ViewBus signal, and (2) a read-only summon overlay (`Leader /`) that rolls up each lane's reported ranges grouped by lane, with `j`/`k` to switch lanes — identical interaction to the review matrix. The overlay is an **awareness roll-up, not an action queue**: it lists `file:line` ranges the lane marked for reading attention; acting on a range still happens in that lane's Diff Window (`p`). Silence (no reports) hides both surfaces, same as spec 146/160.

## Research

Internal only. Three existing self-report surfaces establish the pattern (mapped during research):

- **`attention_flag` (spec 128/138):** `AttentionTriageStore` → `system:attention` ViewBus signal → coloured footer gauge + `Leader ;` overlay (`renderTriageOverlay`, `handleTriageKey`). Footer is *coloured by tier* because each item is an actionable decision.
- **`review_outcome` (spec 146):** `ReviewQualityStore` emits a `review:quality` LaneBus event → `publishReviews()` → `review:quality` ViewBus signal → **neutral** count footer + `Leader '` read-only overlay (`renderReviewMatrixOverlayEl`, `handleReviewMatrixKey`, `j`/`k` switch lane). This is an *observation, not a score* (ADR-0004).
- **`mark_review_priority` (spec 160):** stored in `reviewPriorityReports: Map<laneId, ReviewPriorityReport>` on the view (set/cleared in `handleReviewPriority`, cleared on lane close at ~4905 and dispose at ~2891). **Emits no LaneBus event and has no footer/overlay** — diff-window-only by design (ADR-0009, advisory).

This spec follows the **spec 146 (neutral)** branch, not the spec 128 (coloured/actionable) branch: review priority is an advisory reading-order hint, so the surface must read as a *neutral roll-up*, never a queue demanding action. To get the live-refresh + centralized count + lane-close cleanup that spec 146 enjoys, the bare `Map` is promoted to a small `ReviewPriorityStore` mirroring `ReviewQualityStore` (owns the map, emits a `review:priority` LaneBus event).

## Prior Art

No external/market equivalent — this is a roll-up of an in-house agent self-report signal. The closest analogues are this codebase's own attention-triage and review-quality surfaces (above). **Krypton delta:** purely keyboard-driven summon (`Leader /`), read-only, neutral styling; no mouse affordance; reuses the exact `j`/`k` lane-switch idiom of the review matrix so the muscle memory transfers.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/review-priority-store.ts` | **New.** `ReviewPriorityStore` — owns `Map<laneId, ReviewPriorityReport>`, `record`/`clear`/`onLaneClosed`, `highCount()`, `lanesWithReports()`, `reportFor()`, `allRanges()` (for the existing diff control op); emits `review:priority` LaneBus event. |
| `src/acp/review-priority.ts` (or inline in view) | Pure DOM builder `renderReviewPriorityOverlay(panel, vm)` for the roll-up overlay (mirrors `attention-overlay.ts`). |
| `src/acp/acp-harness-view.ts` | Replace the inline `reviewPriorityReports` Map with the store; route `handleReviewPriority`, lane-close, dispose, and the `diff.review-priority` control op through it; add `publishReviewPriority()`, `openReviewPriorityOverlay()`/`closeReviewPriorityOverlay()`/`renderReviewPriorityOverlayEl()`/`handleReviewPriorityKey()`; add `Leader /` command + overlay DOM els + key dispatch in `onKeyDown`; handle the `review:priority` LaneBus event. |
| `src/workspace-footer.ts` | New `review:priority` signal subscription + `priorityBySource` map + `renderPriority()` segment (neutral, mirrors `renderReviews()`); add `priorityEl` to the right cluster. |
| `src/acp/lane-bus.ts` (types) | Add `review:priority` to the LaneBus event union; add `review:priority` ViewBus signal kind. |
| `src/styles/agent.css` (or footer/overlay CSS) | `.acp-priority__*` overlay styles + `.krypton-workspace-footer__segment--priority`, reusing review-matrix tokens. |

## Design

### Data Structures

```ts
// ReviewPriorityReport already exists (types.ts:401). New store:
export class ReviewPriorityStore {
  private reports = new Map<string, ReviewPriorityReport>();
  constructor(private readonly bus?: LaneBus) {}
  record(laneId: string, ranges: ReviewPriorityRange[]): void; // empty ranges ⇒ delete; emits review:priority
  onLaneClosed(laneId: string): void;                           // delete + emit if present
  highCountFor(laneId: string): number;      // one lane's `high` count — the per-lane overlay tab number
  highCount(): number;                       // total `high` ranges across lanes — the footer depth
  lanesWithReports(): string[];              // lanes with ≥1 reported range — overlay lane switch
  reportFor(laneId: string): ReviewPriorityReport | undefined;
  allRanges(): ReviewPriorityRange[];        // merged, for the existing diff.review-priority control op
}
// (No clearAll — the store is GC'd with the view, which re-publishes highCount:0
//  to the footer on dispose; mirrors ReviewQualityStore. OpenCode-1 review W2.)
```

ViewBus signal value: `{ sourceId: string; highCount: number }`. LaneBus event: `{ type: 'review:priority'; payload: { highCount: number } }`.

### Overlay view-model

```ts
interface ReviewPriorityOverlayVM {
  lanes: string[];                 // lanes with reports, stable order
  selectedIndex: number;
  laneName: (laneId: string) => string;
  report: ReviewPriorityReport | null;   // selected lane's report
}
```

Per selected lane, render `high` ranges first then `routine`, each row = `file:lineStart–lineEnd` + a `high`/`routine` tag (full border / background tint for the tag — **no left-accent rail**, per house style). routine rows may be shown dimmed; if a lane has only routine ranges its `high` group is omitted. Header shows `Review priority` + `selectedLane · N high`. Empty state ("No reading priority reported.") when no lanes.

### Data Flow

```
1. Lane calls mark_review_priority { ranges }  (turn end, spec 160)
2. acp-review-priority event → handleReviewPriority → store.record(laneId, ranges)
3. store emits LaneBus 'review:priority' { highCount }
4. view's LaneBus handler → publishReviewPriority(highCount) → ViewBus 'review:priority' signal
   → workspace-footer renderPriority(): show "N priority" (hidden at 0); if overlay open, re-render it
5. Human presses Leader / → openReviewPriorityOverlay() (gated on highCount()/lanesWithReports() > 0)
6. j/k switch lane · Esc/q close.  Diff control op (diff.review-priority) now reads store.allRanges() — unchanged behaviour.
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `/` | Harness leader (`Cmd+P` then `/`) | Open review-priority roll-up overlay (disabled when nothing reported) |
| `j` / `k` | Inside overlay | Switch selected lane (≥2 lanes) |
| `Esc` / `q` | Inside overlay | Close |

`Leader /` is a new entry in the command palette list (group `Harness`), `isEnabled: () => store.lanesWithReports().length > 0`, `disabledReason: 'no reading priority reported'`. Overlay is mutually exclusive with the triage and review-matrix overlays (closes them on open, same as those close each other).

### UI Changes

- Footer: new `priorityEl` segment in the right cluster (beside `reviewsEl`), neutral styling, glyph (e.g. `▤`) + `N priority`, `title` hints `⌘P /`. Hidden at zero.
- Overlay: new `reviewPriorityOverlayEl` + `reviewPriorityPanelEl` built in `buildDOM`, hidden by default; `.acp-priority__*` classes parallel to `.acp-review__*`.

### Configuration

None.

## Edge Cases

- **Only `routine` reported (no `high`):** `highCount()` = 0 ⇒ footer hidden, but `lanesWithReports()` > 0 ⇒ overlay still openable via palette and shows the routine rows. (Footer counts the *first-read* signal; the overlay shows the full roll-up.)
- **Report replaced/cleared mid-session** (lane re-reports, or empty `ranges`): store.record overwrites/deletes and re-emits; footer + open overlay refresh; selectedIndex clamped if a lane drops out.
- **Lane closes / view disposes:** `onLaneClosed` / `clearAll` drop the lane and re-emit (footer ticks down). Same hook already exists at view ~4905 / ~2891.
- **Cross-harness:** scoped to the local view's lanes only (review priority is per-repo working diff); foreign peers are not folded in.

## Open Questions

None.

## Out of Scope

- Jumping from the overlay into a lane's Diff Window (overlay stays read-only for v1, like the review matrix). Acting on a range remains the Diff Window `p` panel.
- Coloured/severity styling — neutral only (this is advisory, not a queue; mirrors ADR-0004's stance for the sibling surface).
- Persisting reports across sessions (session-only, like spec 160).
- Any change to how `mark_review_priority` is reported or how the Diff Window folds/marks (spec 160 untouched).

## Resources

N/A — purely internal change; pattern sourced from `docs/146-review-quality-matrix.md`, `docs/160-diff-review-priority.md`, `docs/128`/`138` attention triage, and `docs/adr/0009`.
