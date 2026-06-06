// Krypton — Review Quality Matrix store (spec 146).
//
// A per-session, in-memory accumulation of a *summary* per #review round,
// keyed by authoring lane. Under the "one lane edits, the others review"
// workflow, the user wants to observe whether a lane keeps producing
// bugs/bad design across successive reviews. The authoring lane self-reports
// the blocker/warning totals (plus a subject label + reviewer count) at
// synthesis time via the `review_outcome` MCP tool.
//
// Per ADR-0004 this is an **observation, not a score**: it keeps only the
// summary — no stored diff size, no jump-back-to-transcript anchor, no verdict
// — and never blends the counts into a quality number or ranks lanes. The real
// reviewer replies live in the authoring lane's scrollback as the evidence.
//
// Mirrors AttentionTriageStore: owns no DOM and no transport, holds the history
// + emits a single `review:quality` LaneBusEvent so the view can refresh the
// neutral footer indicator. Session-only — dropped on view dispose.

import type { ReviewOutcome } from './types';
import type { LaneBus } from './lane-bus';

export class ReviewQualityStore {
  /** authoringLaneId → outcomes, newest-first. Presence = lane has review history. */
  private history = new Map<string, ReviewOutcome[]>();

  constructor(private readonly bus?: LaneBus) {}

  /**
   * Record one completed review round against an authoring lane. `at` is stamped
   * here unless the caller supplies one (tests). Returns the stored outcome.
   */
  record(outcome: Omit<ReviewOutcome, 'at'> & { at?: number }): ReviewOutcome {
    const entry: ReviewOutcome = {
      authoringLaneId: outcome.authoringLaneId,
      authoringLaneName: outcome.authoringLaneName,
      subjectLabel: outcome.subjectLabel,
      reviewerCount: outcome.reviewerCount,
      blockers: outcome.blockers,
      warnings: outcome.warnings,
      at: outcome.at ?? Date.now(),
    };
    const list = this.history.get(entry.authoringLaneId);
    if (list) list.unshift(entry);
    else this.history.set(entry.authoringLaneId, [entry]);
    this.emitChanged();
    return entry;
  }

  /** A lane's review history, newest-first. Empty array if none. */
  historyFor(laneId: string): ReviewOutcome[] {
    return this.history.get(laneId) ?? [];
  }

  /** Lanes that have at least one recorded round (for the overlay's lane switch). */
  lanesWithHistory(): string[] {
    return [...this.history.keys()];
  }

  /** Total recorded rounds across all lanes — the footer's depth count. */
  totalReviews(): number {
    let n = 0;
    for (const list of this.history.values()) n += list.length;
    return n;
  }

  /** Drop a closed lane's history (session-only, keyed by lane instance). */
  onLaneClosed(laneId: string): void {
    if (this.history.delete(laneId)) this.emitChanged();
  }

  private emitChanged(): void {
    this.bus?.emit({ type: 'review:quality', payload: { totalReviews: this.totalReviews() } });
  }
}
