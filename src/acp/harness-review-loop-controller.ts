// Krypton — ACP Harness View: `#review pass` loop controller (spec 276).
//
// Sequences review → fix → re-review rounds on one authoring lane. Each round
// the harness fans the request out itself over the spec-115 mention path with
// harness-consumed replies, reads every reviewer's VERDICT line, and either
// stops or hands the Blockers back to the lane as one fix turn. A loop that
// completed at least one round ends with one summary turn that writes a single
// Review Board. Parsing, evaluation, and prompts live in `review-loop.ts`.
// spec 277: `telemetry()` projects the loop onto the lane-monitor dashboard.

import type { HarnessLaneStatus } from './types';
import type { HarnessLane } from './harness-view-types';
import type { HarnessReviewLoopHost } from './harness-view-host';
import type { HarnessConsumedReply } from './inter-lane';
import type { TelemetryReviewLoop } from './harness-telemetry';
import {
  blockerCount,
  evaluateRound,
  parseReviewPassArgs,
  parseReviewerReply,
  reviewLoopFixPrompt,
  reviewLoopRequestBody,
  reviewLoopStopLabel,
  reviewLoopSummaryPrompt,
  roundFindings,
  roundResultLine,
  roundVerdict,
  subjectFingerprint,
  subjectLabel,
  warningCount,
  type ReviewLoopStop,
  type ReviewRoundSummary,
  type ReviewerResult,
} from './review-loop';

type ReviewLoopPhase = 'collecting' | 'reviewing' | 'fixing' | 'summarizing';

interface ReviewLoop {
  laneId: string;
  reviewers: { laneId: string; displayName: string }[];
  maxRounds: number;
  /** Doc path or focus note, as typed after `--`. */
  tail: string;
  phase: ReviewLoopPhase;
  round: number;
  packetId: string | null;
  /** Current round, keyed by reviewer displayName. */
  replies: Map<string, ReviewerResult>;
  history: ReviewRoundSummary[];
  /** `#review stop`. */
  stopRequested: boolean;
  /** Checked after every await; set when the loop is dropped. */
  cancelled: boolean;
  /** Subject of the round under review. */
  fingerprint: string;
  subjectLabel: string;
  startedAt: number;
  phaseSince: number;
  /** Current round's reply times, keyed by reviewer displayName. */
  replyTimes: Map<string, number>;
  /** Set when the loop starts to stop; a drop without one is `lane_lost`. */
  stopReason: ReviewLoopStop | null;
}

function isLive(lane: HarnessLane | undefined): lane is HarnessLane {
  return !!lane && lane.status !== 'stopped' && lane.status !== 'error';
}

/** Read status afresh — TS would otherwise keep a narrowing across awaits. */
function statusOf(lane: HarnessLane): HarnessLaneStatus {
  return lane.status;
}

export class HarnessReviewLoopController {
  private readonly loops = new Map<string, ReviewLoop>();
  /** One idle waiter per lane — a loop runs one step at a time. */
  private readonly idleWaiters = new Map<string, () => boolean>();
  /** spec 277: each lane's last ended loop, kept for the dashboard until the
   *  next loop starts or the lane closes. */
  private readonly ended = new Map<string, TelemetryReviewLoop>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly host: HarnessReviewLoopHost) {}

  subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.host.subscribeLaneBus((event) => {
      if (event.type === 'lane:status') this.onLaneStatus(event.payload.laneId, event.payload.next);
      else if (event.type === 'lane:closed') this.onLaneClosed(event.payload.laneId);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const loop of [...this.loops.values()]) this.drop(loop);
    this.ended.clear();
  }

  isRunning(laneId: string): boolean {
    return this.loops.has(laneId);
  }

  /** Composer chip prefix: `review pass 2/3`. */
  chipPrefix(laneId: string): string | null {
    const loop = this.loops.get(laneId);
    return loop ? `review pass ${loop.round}/${loop.maxRounds}` : null;
  }

  /** spec 277: the lane's running loop, else its last ended one, for the dashboard. */
  telemetry(laneId: string): TelemetryReviewLoop | null {
    const loop = this.loops.get(laneId);
    return loop ? this.view(loop, null) : (this.ended.get(laneId) ?? null);
  }

  /** `#review pass [N] [<lane> …] [-- <docpath | note>]` — `rest` is after `pass`. */
  async start(lane: HarnessLane, rest: string[]): Promise<void> {
    const args = parseReviewPassArgs(rest);
    if ('error' in args) {
      this.host.flashChip(args.error);
      return;
    }
    if (!this.host.projectDir) {
      this.host.flashChip('#review: no project dir');
      return;
    }
    if (this.loops.has(lane.id)) {
      this.host.flashChip('#review: loop already running — #review stop');
      return;
    }
    if (lane.status !== 'idle') {
      this.host.flashChip('lane busy - #cancel first');
      return;
    }
    if (!lane.client) {
      this.host.flashChip('#review: lane not ready');
      return;
    }
    // A pending peer to a reviewer would fail the fan-out with peer_in_flight.
    if (this.host.pendingPeerCount(lane) > 0) {
      this.host.flashChip('#review: lane is waiting on a peer - #cancel first');
      return;
    }
    const { reviewers, skipped } = this.host.resolveReviewers(lane, args.nameTokens);
    if (reviewers.length === 0) {
      this.host.flashChip('#review: no reviewable lanes');
      return;
    }
    const loop: ReviewLoop = {
      laneId: lane.id,
      reviewers: reviewers.map((r) => ({ laneId: r.id, displayName: r.displayName })),
      maxRounds: args.maxRounds,
      tail: args.tail,
      phase: 'collecting',
      round: 0,
      packetId: null,
      replies: new Map(),
      history: [],
      stopRequested: false,
      cancelled: false,
      fingerprint: '',
      subjectLabel: '',
      startedAt: Date.now(),
      phaseSince: Date.now(),
      replyTimes: new Map(),
      stopReason: null,
    };
    this.loops.set(lane.id, loop);
    this.ended.delete(lane.id);
    this.host.loopChanged();
    const names = loop.reviewers.map((r) => r.displayName).join(', ');
    this.host.appendTranscript(
      lane,
      'system',
      `review pass → ${names} · up to ${args.maxRounds} round${args.maxRounds === 1 ? '' : 's'}${
        skipped.length > 0 ? ` · skipped: ${skipped.join(', ')}` : ''
      }`,
    );
    await this.startRound(loop);
  }

  /** `#review stop` — graceful: end at the next step and write the summary. */
  stop(lane: HarnessLane): void {
    const loop = this.loops.get(lane.id);
    if (!loop) {
      this.host.flashChip('#review: no review pass running');
      return;
    }
    if (loop.phase === 'summarizing') {
      this.host.flashChip('#review: review pass already finishing');
      return;
    }
    loop.stopRequested = true;
    if (loop.phase === 'reviewing') {
      void this.finish(loop, 'stopped');
      return;
    }
    this.host.flashChip('#review: review pass stops after this step');
  }

  /** `#cancel` / Ctrl+C on the authoring lane — hard stop, no summary. */
  onLaneCancelled(laneId: string): void {
    const loop = this.loops.get(laneId);
    if (!loop) return;
    loop.stopReason = 'cancelled';
    const lane = this.laneFor(loop);
    // A busy cancel keeps the lane's peer waits (spec 116), so withdraw this
    // round's requests here — otherwise they stay live with no loop to read them.
    this.withdrawRequests(loop, lane);
    this.drop(loop);
    if (lane) this.host.appendTranscript(lane, 'system', 'review pass · cancelled');
    this.host.render();
  }

  /** A reviewer's reply to this round's request (spec 276 harness-consumed). */
  onHarnessReply(laneId: string, reply: HarnessConsumedReply): void {
    const loop = this.loops.get(laneId);
    if (!loop || loop.phase !== 'reviewing') return;
    if (reply.packetId !== null && reply.packetId !== loop.packetId) return;
    const reviewer = loop.reviewers.find((r) => r.laneId === reply.fromLaneId);
    if (!reviewer || loop.replies.has(reviewer.displayName)) return;
    loop.replies.set(reviewer.displayName, parseReviewerReply(reviewer.displayName, reply.message));
    loop.replyTimes.set(reviewer.displayName, Date.now());
    this.host.loopChanged();
    if (loop.replies.size === loop.reviewers.length) {
      // Called from inside the coordinator's drain — evaluate once it unwinds.
      queueMicrotask(() => {
        void this.completeRound(loop);
      });
    }
  }

  private async startRound(loop: ReviewLoop): Promise<void> {
    const lane = this.laneFor(loop);
    if (!lane) {
      this.drop(loop);
      return;
    }
    // Reserve only from a synchronous idle: another queue can claim the lane
    // between a resolved idle wait and this continuation.
    while (statusOf(lane) !== 'idle') {
      if (!(await this.whenIdle(loop))) return;
    }
    if (!this.isCurrent(loop)) return;
    loop.round += 1;
    loop.replies = new Map();
    loop.replyTimes = new Map();
    loop.packetId = null;
    this.setPhase(loop, 'collecting');
    const reserveLabel = `review pass ${loop.round}/${loop.maxRounds}`;
    this.host.reserveCommandTurn(lane, reserveLabel);
    const collected = await this.host.collectReviewSubject(lane, loop.tail);
    // Every exit below releases the reservation first, so the lane never stays busy.
    if (!this.isCurrent(loop)) {
      // Only undo our own reservation — a lane that errored meanwhile keeps its status.
      if (this.laneFor(loop) === lane && statusOf(lane) === 'busy' && lane.activeSystemLabel === reserveLabel) {
        this.host.releaseReservedTurn(lane);
      }
      return;
    }
    if ('error' in collected) {
      this.host.releaseReservedTurn(lane);
      this.host.flashChip(collected.error);
      await this.finish(loop, 'subject_error');
      return;
    }
    if (loop.stopRequested) {
      this.host.releaseReservedTurn(lane);
      await this.finish(loop, 'stopped');
      return;
    }
    const allLive = loop.reviewers.every((r) => isLive(this.host.lanes.find((l) => l.id === r.laneId)));
    if (!allLive) {
      this.host.releaseReservedTurn(lane);
      await this.finish(loop, 'reviewer_lost');
      return;
    }
    const fingerprint = subjectFingerprint(collected.subject, collected.docMtime);
    const previous = loop.history[loop.history.length - 1];
    if (previous && previous.fingerprint === fingerprint) {
      this.host.releaseReservedTurn(lane);
      await this.finish(loop, 'no_change');
      return;
    }
    loop.fingerprint = fingerprint;
    loop.subjectLabel = subjectLabel(collected.subject);
    const body = reviewLoopRequestBody({
      author: lane.displayName,
      round: loop.round,
      maxRounds: loop.maxRounds,
      reviewers: loop.reviewers.map((r) => r.displayName),
      subject: collected.subject,
      intent: this.host.collectReviewIntent(lane),
      note: collected.note,
      previous,
    });
    const result = this.host.fanOutReview(lane, loop.reviewers, body);
    if (result.failed.length > 0) {
      this.host.releaseReservedTurn(lane);
      if (result.delivered.length > 0) this.host.cancelPeerConversations(lane);
      this.host.flashChip(
        `#review pass: could not reach ${result.failed.map((f) => `${f.displayName} (${f.reason})`).join(', ')}`,
      );
      await this.finish(loop, 'reviewer_lost');
      return;
    }
    loop.packetId = result.packetId;
    this.setPhase(loop, 'reviewing');
    this.host.releaseReservedTurn(lane, 'awaiting_peer');
    this.host.appendTranscript(
      lane,
      'system',
      `review pass · round ${loop.round}/${loop.maxRounds} → ${loop.reviewers.map((r) => r.displayName).join(', ')}`,
    );
    this.host.render();
  }

  private async completeRound(loop: ReviewLoop): Promise<void> {
    if (!this.isCurrent(loop) || loop.phase !== 'reviewing') return;
    const lane = this.laneFor(loop);
    if (!lane) {
      this.drop(loop);
      return;
    }
    const results = loop.reviewers
      .map((r) => loop.replies.get(r.displayName))
      .filter((r): r is ReviewerResult => r !== undefined);
    const summary: ReviewRoundSummary = {
      round: loop.round,
      fingerprint: loop.fingerprint,
      results,
      at: Date.now(),
    };
    const previous = loop.history[loop.history.length - 1];
    loop.history.push(summary);
    this.host.loopChanged();
    const findings = roundFindings(summary);
    this.host.recordReviewOutcome(lane, {
      subjectLabel: `${loop.subjectLabel} · pass ${loop.round}/${loop.maxRounds}`,
      reviewerCount: results.length,
      blockers: blockerCount(summary),
      warnings: warningCount(summary),
      findings: findings.length > 0 ? findings : undefined,
    });
    this.host.appendTranscript(lane, 'system', roundResultLine(summary, loop.maxRounds));
    this.host.render();
    const decision = evaluateRound(summary, previous, loop.maxRounds);
    if (decision.kind === 'stop') {
      await this.finish(loop, decision.reason);
      return;
    }
    if (loop.stopRequested) {
      await this.finish(loop, 'stopped');
      return;
    }
    this.setPhase(loop, 'fixing');
    const ran = await this.runTurn(
      loop,
      reviewLoopFixPrompt({ round: loop.round, maxRounds: loop.maxRounds, summary }),
      `fixing ${loop.round}/${loop.maxRounds}`,
    );
    if (!ran) return;
    if (!isLive(this.laneFor(loop))) {
      await this.finish(loop, 'lane_lost');
      return;
    }
    if (loop.stopRequested) {
      await this.finish(loop, 'stopped');
      return;
    }
    if (!(await this.whenIdle(loop))) return;
    await this.startRound(loop);
  }

  /** End the loop. A loop with a completed round writes one summary Board. */
  private async finish(loop: ReviewLoop, reason: ReviewLoopStop): Promise<void> {
    if (!this.isCurrent(loop) || loop.phase === 'summarizing') return;
    loop.stopReason = reason;
    const lane = this.laneFor(loop);
    // Every stop — including `lane_lost` on an errored author — clears the
    // round's requests, so they never outlive the loop or block the next one.
    this.withdrawRequests(loop, lane);
    const rounds = loop.history.length;
    const label = reviewLoopStopLabel(reason);
    if (!lane || reason === 'cancelled' || reason === 'lane_lost' || rounds === 0) {
      this.drop(loop);
      if (lane) this.host.appendTranscript(lane, 'system', `review pass · ended: ${label}`);
      this.host.flashChip(`review pass: ${label}`);
      this.host.render();
      return;
    }
    this.setPhase(loop, 'summarizing');
    this.host.appendTranscript(
      lane,
      'system',
      `review pass · stopped: ${label} (round ${rounds}/${loop.maxRounds}) — writing the summary`,
    );
    this.host.render();
    const prompt = reviewLoopSummaryPrompt({
      reason,
      maxRounds: loop.maxRounds,
      subjectLabel: loop.subjectLabel,
      history: loop.history,
    });
    await this.runTurn(loop, prompt, 'review pass summary');
    if (this.isCurrent(loop)) this.drop(loop);
    this.host.render();
  }

  /** Wait for the lane to go idle, then run one system turn to completion. */
  private async runTurn(loop: ReviewLoop, text: string, label: string): Promise<boolean> {
    for (;;) {
      if (!(await this.whenIdle(loop))) return false;
      const lane = this.laneFor(loop);
      if (!lane?.client) {
        this.drop(loop);
        return false;
      }
      if (await this.host.enqueueSystemPrompt(lane, text, undefined, label)) return this.isCurrent(loop);
      // Refused while idle means the turn can never start; anything else means
      // another queue claimed the lane first — wait for the next idle.
      if (lane.status === 'idle') {
        this.drop(loop);
        return false;
      }
    }
  }

  /** Resolves true once the lane is idle, false when the loop ends first. */
  private whenIdle(loop: ReviewLoop): Promise<boolean> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        const lane = this.laneFor(loop);
        if (!this.isCurrent(loop) || !isLive(lane)) {
          resolve(false);
          return true;
        }
        if (lane.status !== 'idle') return false;
        resolve(true);
        return true;
      };
      if (!check()) this.idleWaiters.set(loop.laneId, check);
    });
  }

  private onLaneStatus(laneId: string, next: HarnessLaneStatus): void {
    if (next === 'stopped' || next === 'error') {
      const own = this.loops.get(laneId);
      if (own) void this.finish(own, 'lane_lost');
      this.onReviewerGone(laneId);
    }
    if (this.idleWaiters.has(laneId)) {
      // Another drain-on-idle queue may claim the lane in this same emit;
      // check once every subscriber has run.
      queueMicrotask(() => {
        const waiter = this.idleWaiters.get(laneId);
        if (waiter?.()) this.idleWaiters.delete(laneId);
      });
    }
  }

  private onLaneClosed(laneId: string): void {
    const own = this.loops.get(laneId);
    if (own) this.drop(own);
    this.ended.delete(laneId);
    this.onReviewerGone(laneId);
  }

  /** A reviewer that has not replied yet stopped or closed mid-round. */
  private onReviewerGone(laneId: string): void {
    for (const loop of [...this.loops.values()]) {
      if (loop.phase !== 'reviewing') continue;
      const reviewer = loop.reviewers.find((r) => r.laneId === laneId);
      if (!reviewer || loop.replies.has(reviewer.displayName)) continue;
      void this.finish(loop, 'reviewer_lost');
    }
  }

  /** Cancel the round's unanswered review requests. Only a `reviewing` loop
   *  still waiting on a reviewer has any. */
  private withdrawRequests(loop: ReviewLoop, lane: HarnessLane | undefined): void {
    if (!lane || loop.phase !== 'reviewing' || loop.replies.size >= loop.reviewers.length) return;
    this.host.cancelPeerConversations(lane);
  }

  private drop(loop: ReviewLoop): void {
    loop.cancelled = true;
    if (this.loops.get(loop.laneId) === loop) {
      this.loops.delete(loop.laneId);
      if (this.laneFor(loop)) this.ended.set(loop.laneId, this.view(loop, Date.now()));
      this.host.loopChanged();
    }
    const waiter = this.idleWaiters.get(loop.laneId);
    if (waiter) {
      this.idleWaiters.delete(loop.laneId);
      waiter();
    }
  }

  private setPhase(loop: ReviewLoop, phase: ReviewLoopPhase): void {
    loop.phase = phase;
    loop.phaseSince = Date.now();
    this.host.loopChanged();
  }

  /** spec 277 dashboard projection. `endedAt` null means the loop is running. */
  private view(loop: ReviewLoop, endedAt: number | null): TelemetryReviewLoop {
    const running = endedAt === null;
    const stopReason = running ? loop.stopReason : (loop.stopReason ?? 'lane_lost');
    return {
      running,
      phase: running ? loop.phase : null,
      round: loop.round,
      maxRounds: loop.maxRounds,
      subjectLabel: loop.subjectLabel,
      startedAt: loop.startedAt,
      phaseSince: loop.phaseSince,
      reviewers: loop.reviewers.map((r) => {
        const result = loop.replies.get(r.displayName);
        return {
          name: r.displayName,
          state: result ? 'replied' : loop.phase === 'collecting' ? 'not_sent' : 'pending',
          verdict: result?.verdict ?? null,
          blockers: result?.blockers.length ?? 0,
          repliedAt: loop.replyTimes.get(r.displayName) ?? null,
        };
      }),
      rounds: loop.history.map((s) => ({
        round: s.round,
        verdict: roundVerdict(s),
        blockers: blockerCount(s),
        warnings: warningCount(s),
      })),
      stopReason,
      stopLabel: stopReason ? reviewLoopStopLabel(stopReason) : null,
      endedAt,
    };
  }

  private isCurrent(loop: ReviewLoop): boolean {
    return !loop.cancelled && this.loops.get(loop.laneId) === loop;
  }

  private laneFor(loop: ReviewLoop): HarnessLane | undefined {
    return this.host.lanes.find((l) => l.id === loop.laneId);
  }
}
