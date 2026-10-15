// Spec 302 §5.2 — `ReviewLoopRows`.
//
//   review   pass 2/4 · reviewing
//   replies  codex PASS · salty pending
//   rounds   3 → 0
//
// Ports `renderLanePeekReviewLoop` + the private `peekReviewerState`
// (src/acp/lane-peek.ts:440-475) and `patchPeekReviewLoop` (:477-497). The
// patch function existed only because a reviewer reply changes no lane status
// and must not remount the peek card or its heat ring; it compared `innerHTML`
// to decide whether to swap the wrapper. That comparison is this component's
// dependency tuple, and the three rows keep their nodes either way.
//
// The wrapper is `display: contents`, so the rows are grid children of the peek
// card; it exists only to group them under one `data-peek-row` marker.
//
// The row markup (`-row > -prefix + -value`) is the peek card's, so the row
// component comes from there rather than being copied — this directory's sheet
// declares only the two selectors it owns.

import './review-loop-rows.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { truncateInline } from '../../harness-format';
import type { TelemetryReviewLoop, TelemetryReviewLoopReviewer } from '../../harness-telemetry';
import { PeekRow, type PeekRowProps, type PeekSegment } from '../peek-card/row';
import type { ComponentDef } from '../types';

export interface ReviewLoopRowsProps {
  readonly loop: TelemetryReviewLoop;
}

/** Phase vocabulary, unchanged from `PEEK_LOOP_PHASE` (lane-peek.ts:56-61). */
const PEEK_LOOP_PHASE: Record<NonNullable<TelemetryReviewLoop['phase']>, string> = {
  collecting: 'collecting',
  reviewing: 'reviewing',
  fixing: 'fixing',
  summarizing: 'writing summary',
};

/** One reviewer's answer: a coloured verdict, or plain text for the states that
 *  have no verdict yet. Withdrawn or never answered is only "pending" while the
 *  round is still running. */
function reviewerSegments(loop: TelemetryReviewLoop, rv: TelemetryReviewLoopReviewer): PeekSegment[] {
  if (rv.state === 'replied') {
    const word = rv.verdict === 'fail'
      ? `FAIL${rv.blockers ? ` ${rv.blockers}` : ''}`
      : rv.verdict === 'missing' ? 'no verdict' : String(rv.verdict ?? '').toUpperCase();
    const verdict = rv.verdict === 'pass' || rv.verdict === 'fail' ? rv.verdict : 'partial';
    return [{ kind: 'verdict', text: word, verdict }];
  }
  if (rv.state === 'not_sent') return [{ kind: 'text', text: 'not sent' }];
  return [{ kind: 'text', text: loop.phase === 'reviewing' ? 'pending' : 'no reply' }];
}

function loopRows(loop: TelemetryReviewLoop): PeekRowProps[] {
  const state = loop.running
    ? (loop.phase ? PEEK_LOOP_PHASE[loop.phase] : '')
    : `ended · ${truncateInline(loop.stopLabel ?? 'ended', 28)}`;
  const rows: PeekRowProps[] = [{
    prefix: 'review',
    segments: [
      { kind: 'text', text: 'pass ' },
      { kind: 'strong', text: `${loop.round}/${loop.maxRounds}` },
      { kind: 'text', text: ` · ${state}` },
    ],
  }];
  if (loop.reviewers.length > 0) {
    const segments: PeekSegment[] = [];
    loop.reviewers.forEach((rv, index) => {
      if (index > 0) segments.push({ kind: 'text', text: ' · ' });
      segments.push({ kind: 'text', text: `${rv.name} ` });
      segments.push(...reviewerSegments(loop, rv));
    });
    rows.push({ prefix: 'replies', segments });
  }
  if (loop.rounds.length > 0) {
    const segments: PeekSegment[] = [];
    loop.rounds.forEach((round, index) => {
      if (index > 0) segments.push({ kind: 'text', text: ' → ' });
      segments.push({ kind: 'verdict', text: String(round.blockers), verdict: round.verdict });
    });
    rows.push({ prefix: 'rounds', segments });
  }
  return rows;
}

export class ReviewLoopRows extends Component<ReviewLoopRowsProps> {
  constructor() {
    super(el('div', { data: { 'peek-row': 'review-loop' } }));
  }

  protected readDeps(next: ReviewLoopRowsProps): readonly unknown[] {
    const loop = next.loop;
    return [
      loop.running,
      loop.phase,
      loop.round,
      loop.maxRounds,
      loop.stopLabel,
      loop.reviewers
        .map((rv) => `${rv.name}\u001f${rv.state}\u001f${rv.verdict ?? ''}\u001f${rv.blockers}`)
        .join('\u001e'),
      loop.rounds.map((round) => `${round.verdict}\u001f${round.blockers}`).join('\u001e'),
    ];
  }

  protected syncClasses(_next: ReviewLoopRowsProps): void {
    this.el.className = 'acp-harness__lane-peek-loop';
  }

  protected paint(next: ReviewLoopRowsProps): void {
    this.syncClasses(next);
    reconcile(this.el, loopRows(next.loop), {
      key: (row: PeekRowProps): string => row.prefix,
      create: (row: PeekRowProps): PeekRow => {
        const cmp = new PeekRow();
        cmp.update(row);
        return cmp;
      },
      update: (cmp: PeekRow, row: PeekRowProps): void => cmp.update(row),
    });
  }

  protected onDispose(): void {
    disposeList(this.el);
  }
}

export const def: ComponentDef = {
  id: 'review-loop-rows',
  blocks: ['acp-harness__lane-peek-loop', 'acp-harness__lane-peek-verdict'],
};
