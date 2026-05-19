// Krypton — LaneInbox.
// Per-lane FIFO queue of inter-lane envelopes. Drained by the coordinator
// on the lane's next idle transition. Spec 106.

import type { InterLaneEnvelope } from './types';

export class LaneInbox {
  private queue: InterLaneEnvelope[] = [];

  constructor(readonly laneId: string) {}

  push(env: InterLaneEnvelope): void {
    this.queue.push(env);
  }

  drain(): InterLaneEnvelope[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  depth(): number {
    return this.queue.length;
  }
}
