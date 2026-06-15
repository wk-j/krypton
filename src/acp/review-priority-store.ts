// Krypton — Review Priority Store (spec 162).
//
// A per-session, in-memory roll-up of the latest `mark_review_priority` (spec
// 160) report per authoring lane. The bare `Map` that previously lived inline
// on the harness view is promoted here so the footer publish, the summon
// overlay refresh, and the lane-close cleanup all flow through one place — and
// so a single `review:priority` LaneBusEvent fires on every mutation, exactly
// like ReviewQualityStore.
//
// The data is an *advisory reading-order hint* (ADR-0009), not an action queue:
// the store keeps the raw reported ranges and exposes a `high` count for the
// neutral footer depth indicator. Session-only — dropped on lane close / view
// dispose. The Diff Window still pulls a merged snapshot on demand via the
// `diff.review-priority` control op (now reading `allRanges()`).

import type { ReviewPriorityRange, ReviewPriorityReport } from './types';
import type { LaneBus } from './lane-bus';

export class ReviewPriorityStore {
  /** authoringLaneId → latest report. Presence = lane has a live report. */
  private reports = new Map<string, ReviewPriorityReport>();

  constructor(private readonly bus?: LaneBus) {}

  /**
   * Record (or replace) one authoring lane's report. The latest call wins — the
   * working diff is cumulative state, so the freshest read is what the Window
   * triages by. An empty `ranges` array clears the lane's report. Emits on any
   * effective change.
   */
  record(laneId: string, ranges: ReviewPriorityRange[]): void {
    if (ranges.length === 0) {
      if (this.reports.delete(laneId)) this.emitChanged();
      return;
    }
    this.reports.set(laneId, { laneId, ranges, reportedAt: Date.now() });
    this.emitChanged();
  }

  /** Drop a closed lane's report (session-only, keyed by lane instance). */
  onLaneClosed(laneId: string): void {
    if (this.reports.delete(laneId)) this.emitChanged();
  }

  /** `high`-level ranges in one lane's report — the per-lane tab count. */
  highCountFor(laneId: string): number {
    const report = this.reports.get(laneId);
    if (!report) return 0;
    let n = 0;
    for (const r of report.ranges) if (r.level === 'high') n++;
    return n;
  }

  /** Total `high`-level ranges across all lanes — the footer's depth count. */
  highCount(): number {
    let n = 0;
    for (const laneId of this.reports.keys()) n += this.highCountFor(laneId);
    return n;
  }

  /** Lanes with at least one reported range (for the overlay's lane switch). */
  lanesWithReports(): string[] {
    return [...this.reports.keys()];
  }

  /** One lane's latest report, or undefined. */
  reportFor(laneId: string): ReviewPriorityReport | undefined {
    return this.reports.get(laneId);
  }

  /** Merged ranges across every lane — for the `diff.review-priority` pull. */
  allRanges(): ReviewPriorityRange[] {
    const ranges: ReviewPriorityRange[] = [];
    for (const report of this.reports.values()) ranges.push(...report.ranges);
    return ranges;
  }

  private emitChanged(): void {
    this.bus?.emit({ type: 'review:priority', payload: { highCount: this.highCount() } });
  }
}
