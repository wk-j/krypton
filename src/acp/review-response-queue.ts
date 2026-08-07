// Krypton — Review Response Queue (spec 211).
//
// A per-lane queue of Review Board responses, drained into a system turn on the
// lane's next idle transition. Third instance of the same drain-on-`lane:status`
// primitive as spec 149's ArtifactFeedbackQueue and spec 158's DiffReviewQueue
// (human→lane review, not lane↔lane mail) — deliberately NOT the peer LaneInbox.
// Unifying the three is a follow-up refactor, explicitly out of scope here.
//
// One difference worth naming: unlike a diff comment, a review response is
// already fully recorded on disk before it reaches this queue. So a response the
// queue drops (lane close / `#new`) is not lost work — the bundle still holds it,
// and a later lane can read it back. That is why the whole response, not each
// answer, is the unit of idempotency.

import type {
  HarnessLaneStatus,
  LaneBusEvent,
  ReviewResponseEnvelope,
} from './types';
import type { LaneBus } from './lane-bus';

import { composeResponsePrompt } from '../review-board/response';

/** spec 116 parity: a response may drain while a lane is idle OR awaiting_peer. */
function canDrain(status: HarnessLaneStatus): boolean {
  return status === 'idle' || status === 'awaiting_peer';
}

export interface ReviewResponseHost {
  getLaneStatus(laneId: string): HarnessLaneStatus | null;
  /** Inject the composed response prompt as a programmatic user-turn. */
  injectResponseTurn(laneId: string, text: string): void;
}

export type ReviewResponseAccept = 'accepted' | 'duplicate';

export class ReviewResponseQueue {
  private queues = new Map<string, ReviewResponseEnvelope[]>();
  /** Idempotency is per BATCH, marked at drain rather than at accept — a batch
   *  queued but dropped before it reached a turn is re-sendable, exactly like
   *  the diff-review queue's per-comment rule. */
  private delivered = new Set<string>();
  private unsubscribe: () => void;

  constructor(
    bus: LaneBus,
    private host: ReviewResponseHost,
  ) {
    this.unsubscribe = bus.subscribe((e) => this.onBus(e));
  }

  dispose(): void {
    this.unsubscribe();
    this.queues.clear();
    this.delivered.clear();
  }

  /** Queue a response for a lane. Drains immediately when the lane is idle. */
  accept(laneId: string, envelope: ReviewResponseEnvelope): ReviewResponseAccept {
    if (this.delivered.has(envelope.batchId)) return 'duplicate';
    const queue = this.queues.get(laneId) ?? [];
    // A re-send of a batch still sitting in the queue replaces it rather than
    // stacking a second copy: the response is a whole-document snapshot, so the
    // newest one supersedes anything older for the same batch.
    const existing = queue.findIndex((e) => e.batchId === envelope.batchId);
    if (existing >= 0) queue[existing] = envelope;
    else queue.push(envelope);
    this.queues.set(laneId, queue);
    const status = this.host.getLaneStatus(laneId);
    if (status && canDrain(status)) this.drain(laneId);
    return 'accepted';
  }

  depth(laneId: string): number {
    return this.queues.get(laneId)?.length ?? 0;
  }

  /** Drop a lane's queued-but-undrained responses (lane closed / `#new`). The
   *  `delivered` set is untouched, so what did drain stays de-duped. The bundle
   *  on disk is NOT affected — the answers survive the lane by design. */
  dropLane(laneId: string): void {
    this.queues.delete(laneId);
  }

  private onBus(event: LaneBusEvent): void {
    if (event.type === 'lane:status') {
      if (canDrain(event.payload.next)) this.drain(event.payload.laneId);
    } else if (event.type === 'lane:closed') {
      this.dropLane(event.payload.laneId);
    }
  }

  private drain(laneId: string): void {
    const queue = this.queues.get(laneId);
    if (!queue || queue.length === 0) return;
    const status = this.host.getLaneStatus(laneId);
    // Re-check: the coordinator (peer mail) and the two sibling feedback queues
    // run on this same idle event and may have flipped the lane to busy. If so,
    // wait for the next idle. Construction order in AcpHarnessView puts this
    // queue last, so it always sees a contested idle as already busy.
    if (!status || !canDrain(status)) return;
    this.queues.set(laneId, []);
    const envelopes = queue.filter((e) => !this.delivered.has(e.batchId));
    if (envelopes.length === 0) return;
    for (const envelope of envelopes) this.delivered.add(envelope.batchId);
    this.host.injectResponseTurn(laneId, composeResponsePrompt(envelopes));
  }
}
