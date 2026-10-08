// Krypton — ACP Harness View: mid-turn steering controller (spec 278).
//
// Sends a busy lane's composer prompt into the running turn through the
// `_session/steering` extension and owns what can go wrong around it: a steer
// that misses goes back to the head of the prompt queue (in the order it was
// typed), and the turn does not end — finishTurn does not run — while a steer
// is unanswered or a Codex turn a steer started on its own (`startedNewTurn`)
// still runs. No `session/prompt` of ours resolves such a turn.
//
// Following those turns relies on stream order, not on invoke results (which
// reach the frontend in no fixed order relative to events). The Rust reader
// announces every `session/prompt` and `_session/steering` reply as a
// `turn_marker` event in stdout order with Codex's thread-status updates.
// codex-acp only starts a steer's turn after the previous prompt completed and
// its reply was written, so every steer-started turn goes active → idle AFTER
// the prompt marker: the turn is over once as many such active → idle pairs
// followed that marker as `startedNewTurn` markers did.

import { truncate } from './harness-format';
import type { HarnessSteerHost } from './harness-view-host';
import type { HarnessLane, QueuedPrompt, StagedImage } from './harness-view-types';
import type { SteerOutcome, StopReason } from './types';

interface LaneSteerState {
  /** `lane.spawnEpoch` this state belongs to — a restart starts a fresh one. */
  epoch: number;
  /** Steers whose reply the controller has not handled yet. */
  inFlight: number;
  /** The turn's `session/prompt` stop, held until no steer work is outstanding. */
  stop: { stopReason: StopReason; reason?: string } | null;
  /** A steer-started turn ran inside this turn (its cancel ends it 'cancelled'). */
  continued: boolean;
  /** Bumped by a cancel; a steer sent before it must not run or be re-queued. */
  cancelSeq: number;
  // — stream order (turn markers + Codex thread state) —
  /** `startedNewTurn` markers since the last prompt marker. */
  started: number;
  /** Codex active → idle pairs whose active followed the last prompt marker. */
  ended: number;
  activeSincePrompt: boolean;
  /** `startedNewTurn` marker ids not yet matched with their reply. */
  startedMarkers: Set<number>;
  /** `startedNewTurn` replies whose marker has not crossed the stream yet. */
  awaitingMarkers: Set<number>;
}

/** JSON-RPC -32601: the adapter stopped knowing `_session/steering`. */
function isMethodNotFound(error: unknown): boolean {
  return error !== null && String(error).includes('-32601');
}

export class HarnessSteerController {
  private readonly states = new Map<string, LaneSteerState>();
  /** Typing order of re-queued steers, so misses that resolve out of order
   *  still drain in the order they were sent. */
  private readonly requeuedSeq = new WeakMap<QueuedPrompt, number>();
  private nextSteerSeq = 0;

  constructor(private readonly host: HarnessSteerHost) {}

  /** Enter on this lane steers instead of queueing. */
  canSteer(lane: HarnessLane): boolean {
    return lane.supportsSteering && lane.status === 'busy' && lane.client !== null;
  }

  /** `liveDelegationId` (spec 280): a voice delegation; a missed steer keeps it
   *  on the re-queued prompt so the turn that finally runs it reports back. */
  async steer(lane: HarnessLane, text: string, images: StagedImage[], liveDelegationId?: string): Promise<void> {
    const client = lane.client;
    if (!client) return;
    const state = this.stateFor(lane);
    const seq = this.nextSteerSeq++;
    const cancelSeq = state.cancelSeq;
    // Seal the streaming agent row so the steer sits after what was already said.
    this.host.sealStreaming(lane);
    const item = this.host.appendTranscript(lane, 'user', text, {
      imageCount: images.length,
      steer: 'pending',
      ...(liveDelegationId ? { voice: true as const } : {}),
    });
    lane.pendingUserEcho = { itemId: item.id, text, received: '' };
    state.inFlight += 1;
    this.host.render();
    let outcome: SteerOutcome;
    let requestId: number | null = null;
    let error: unknown = null;
    try {
      ({ outcome, requestId } = await client.steer(this.host.steerBlocks(text, images)));
    } catch (e) {
      outcome = 'failed';
      error = e;
    }
    // A restart or new session replaced the session this steer went to.
    if (lane.client !== client || this.states.get(lane.id) !== state) return;
    state.inFlight -= 1;
    const cancelled = state.cancelSeq !== cancelSeq;
    if (outcome === 'injected' || outcome === 'startedNewTurn') {
      item.steer = 'injected';
      if (outcome === 'startedNewTurn') {
        state.continued = true;
        // Wait for its ordered marker so the started turn is counted.
        if (requestId !== null && !state.startedMarkers.delete(requestId)) {
          state.awaitingMarkers.add(requestId);
        }
        if (cancelled) {
          // The user cancelled while this steer waited for the old turn to end;
          // stop the turn it started instead of letting it run.
          this.host.appendTranscript(lane, 'system', 'steer cancelled');
          void client.cancel().catch((e: unknown) => console.warn('[acp-harness] steer cancel failed', e));
        }
      }
      if (!cancelled) this.host.flashChip('steered');
    } else {
      if (error) console.warn('[acp-harness] steer failed', error);
      this.requeue(lane, item.id, text, images, seq, cancelled, error, liveDelegationId);
    }
    this.maybeFinish(lane, state);
    this.host.render();
  }

  /** The `session/prompt` stop. Ends the turn now, or holds it while a steer is
   *  unanswered or a turn a steer started still runs — so turn-end cleanup never
   *  runs over that newer turn's state and no drain can collide with it. */
  onStop(lane: HarnessLane, stopReason: StopReason, reason?: string): void {
    const state = this.live(lane);
    // `reason` marks a harness-synthesized stop (the subprocess exited):
    // nothing is coming back, so end now.
    if (!state || reason !== undefined) {
      if (state) this.clearTurn(state);
      this.host.finishTurn(lane, stopReason, reason);
      return;
    }
    state.stop = { stopReason, reason };
    this.maybeFinish(lane, state);
  }

  /** A reply's place in the stream (Rust `turn_marker`). */
  onTurnMarker(
    lane: HarnessLane,
    kind: 'prompt' | 'steer',
    requestId: number,
    outcome: SteerOutcome | null,
  ): void {
    const state = this.stateFor(lane);
    if (kind === 'prompt') {
      // Count from here: the prompt's own turn is over in the stream.
      state.started = 0;
      state.ended = 0;
      state.activeSincePrompt = false;
    } else if (outcome === 'startedNewTurn') {
      state.started += 1;
      if (!state.awaitingMarkers.delete(requestId)) state.startedMarkers.add(requestId);
    }
    this.maybeFinish(lane, state);
  }

  /** Codex thread state; ends a steer-started turn at its idle. */
  onTurnState(lane: HarnessLane, next: 'active' | 'idle'): void {
    const state = this.stateFor(lane);
    if (next === 'active') {
      state.activeSincePrompt = true;
    } else if (state.activeSincePrompt) {
      state.activeSincePrompt = false;
      state.ended += 1;
    }
    this.maybeFinish(lane, state);
  }

  /** Ctrl+C / #cancel: a steer already sent must not run or be re-queued. */
  onCancel(lane: HarnessLane): void {
    const state = this.live(lane);
    if (state) state.cancelSeq += 1;
  }

  /** The turn's `session/prompt` failed without a stop: no held stop may
   *  outlive it and swallow a later turn's stop. */
  onPromptFailed(lane: HarnessLane): void {
    const state = this.live(lane);
    if (state) this.clearTurn(state);
  }

  /** Fresh session, restart or close — forget the lane's steering state. */
  resetLane(laneId: string): void {
    this.states.delete(laneId);
  }

  private requeue(
    lane: HarnessLane,
    itemId: string,
    text: string,
    images: StagedImage[],
    seq: number,
    cancelled: boolean,
    error: unknown,
    liveDelegationId: string | undefined,
  ): void {
    this.host.removeTranscriptItem(lane, itemId);
    if (lane.pendingUserEcho?.itemId === itemId) lane.pendingUserEcho = null;
    if (isMethodNotFound(error)) lane.supportsSteering = false;
    if (cancelled) {
      this.host.appendTranscript(lane, 'system', `steer not delivered: ${truncate(text, 80)}`);
      return;
    }
    // Head of the queue, behind missed steers typed earlier. The cap (spec 136)
    // is not applied — a missed steer is never dropped.
    const prompt: QueuedPrompt = { text, images, mentionTargets: [], ...(liveDelegationId ? { liveDelegationId } : {}) };
    let at = 0;
    while (at < lane.queuedPrompts.length) {
      const earlier = this.requeuedSeq.get(lane.queuedPrompts[at]);
      if (earlier === undefined || earlier > seq) break;
      at += 1;
    }
    lane.queuedPrompts.splice(at, 0, prompt);
    this.requeuedSeq.set(prompt, seq);
    this.host.flashChip(`steer missed — queued (${lane.queuedPrompts.length})`);
    if (lane.status === 'idle') this.host.drainPromptQueue(lane);
  }

  /** End the held turn once every steer is answered and counted and every
   *  turn a steer started has gone idle — only its idle proves it stopped.
   *  Not having seen thread state yet is no reason to stop waiting: a lane's
   *  first turn can be a command codex-acp answers without a native turn
   *  (`/status`), so the first status may be the steer-started turn's own, and
   *  `session/cancel` is a notification that does not wait for the turn to
   *  stop. The lane stays busy meanwhile, so an idle that never comes is the
   *  spec 199 case: Ctrl+C, then Ctrl+C again past the window force-restarts. */
  private maybeFinish(lane: HarnessLane, state: LaneSteerState): void {
    if (!state.stop || state.inFlight > 0 || state.awaitingMarkers.size > 0) return;
    if (state.ended < state.started) return;
    const { stopReason, reason } = state.stop;
    const cancelled = state.continued && lane.cancelRequestedAt !== null;
    this.clearTurn(state);
    this.host.finishTurn(lane, cancelled ? 'cancelled' : stopReason, reason);
  }

  private clearTurn(state: LaneSteerState): void {
    state.stop = null;
    state.continued = false;
    state.started = 0;
    state.ended = 0;
    state.startedMarkers.clear();
    state.awaitingMarkers.clear();
  }

  private stateFor(lane: HarnessLane): LaneSteerState {
    const existing = this.live(lane);
    if (existing) return existing;
    const state: LaneSteerState = {
      epoch: lane.spawnEpoch,
      inFlight: 0,
      stop: null,
      continued: false,
      cancelSeq: 0,
      started: 0,
      ended: 0,
      activeSincePrompt: false,
      startedMarkers: new Set(),
      awaitingMarkers: new Set(),
    };
    this.states.set(lane.id, state);
    return state;
  }

  private live(lane: HarnessLane): LaneSteerState | null {
    const state = this.states.get(lane.id);
    return state && state.epoch === lane.spawnEpoch ? state : null;
  }
}
