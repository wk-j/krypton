// Krypton — Inter-Lane Coordinator (Peering, spec 106).
//
// Routes envelopes between ACP lanes in the same harness.
// - peer_send → coordinator.deliver()
// - lane:status idle (with non-empty inbox) → drain → enqueue system prompt
// - lane stop_event with outstanding sends → transition lane → awaiting_peer
//
// The coordinator owns no DOM; it talks to the harness through a small
// `LaneHost` port. This keeps the rendering side free to evolve without
// touching transport logic.

import type {
  HarnessLaneStatus,
  InterLaneEnvelope,
  LaneBusEvent,
  LaneSummary,
} from './types';
import { LaneBus } from './lane-bus';
import { LaneInbox } from './lane-inbox';

export type DeliveryResult =
  | { delivered: true; envelopeId: string; queuedDepth: number; hint: string }
  | {
      delivered: false;
      reason:
        | 'self_send'
        | 'unknown_lane'
        | 'unknown_sender'
        | 'lane_stopped'
        | 'conversation_cancelled';
    };

export interface LaneHost {
  /** Enumerate all live (non-stopped) lanes. */
  listLanes(): LaneSummary[];
  /** Resolve a lane id; returns null when unknown or stopped. */
  getLane(laneId: string): { status: HarnessLaneStatus; displayName: string } | null;
  /** Mutate the lane's status and emit a lane:status event. */
  setLaneStatus(laneId: string, next: HarnessLaneStatus): void;
  /** Inject a programmatic user-turn into the target lane's session. */
  enqueueSystemPrompt(laneId: string, text: string): void;
  /** Append an `inter_lane` transcript row to the lane's transcript. */
  appendInterLaneRow(
    laneId: string,
    direction: 'in' | 'out',
    peer: { id: string; displayName: string },
    message: string,
    done: boolean,
  ): void;
  /** Surface a synthesized notice (e.g. "peer cancelled") to the user. */
  appendSystemNotice(laneId: string, text: string): void;
}

interface PendingSend {
  envelopeId: string;
  toLaneId: string;
  sentAt: number;
}

export interface PendingPeerSummary {
  toLaneId: string;
  toDisplayName: string;
  envelopeId: string;
  sentAt: number;
}

const REPLY_HINT =
  'End your turn now. The reply (if any) will arrive as a new user message.';

export class InterLaneCoordinator {
  private inboxes = new Map<string, LaneInbox>();
  /** Per-sender list of envelopes awaiting a reply. */
  private pending = new Map<string, PendingSend[]>();
  /**
   * Cancelled conversations awaiting acknowledgement by the peer.
   * Key: `${cancellerLaneId}::${peerLaneId}` — drops any future envelope
   * from peer to canceller until the peer drains its cancellation notice.
   * Without this, a peer that was busy when the canceller ran #cancel can
   * still deliver a late reply back into the cancelled lane.
   */
  private cancelledPairs = new Set<string>();

  constructor(
    private readonly bus: LaneBus,
    private readonly host: LaneHost,
  ) {
    this.bus.subscribe((e) => this.onBus(e));
  }

  // ──────────────────────────────────────────────────────────────────
  // Public surface

  listLanes(): LaneSummary[] {
    return this.host.listLanes().map((s) => ({
      ...s,
      inboxDepth: this.inbox(s.laneId).depth(),
    }));
  }

  inboxDepth(laneId: string): number {
    return this.inbox(laneId).depth();
  }

  pendingPeersFor(laneId: string): PendingPeerSummary[] {
    const pending = this.pending.get(laneId) ?? [];
    return pending.map((p) => ({
      toLaneId: p.toLaneId,
      toDisplayName: this.host.getLane(p.toLaneId)?.displayName ?? p.toLaneId,
      envelopeId: p.envelopeId,
      sentAt: p.sentAt,
    }));
  }

  deliver(env: InterLaneEnvelope): DeliveryResult {
    if (env.fromLaneId === env.toLaneId) {
      return { delivered: false, reason: 'self_send' };
    }
    const recipient = this.host.getLane(env.toLaneId);
    if (!recipient) return { delivered: false, reason: 'unknown_lane' };
    if (recipient.status === 'stopped' || recipient.status === 'error') {
      return { delivered: false, reason: 'lane_stopped' };
    }
    // Drop late replies from a peer whose cancellation we have already
    // queued. The cancellation envelope is still in the peer's inbox waiting
    // to drain; envelopes from that peer back to the canceller are no-ops
    // until the peer acknowledges the cancellation.
    if (this.cancelledPairs.has(this.pairKey(env.toLaneId, env.fromLaneId))) {
      return { delivered: false, reason: 'conversation_cancelled' };
    }

    this.inbox(env.toLaneId).push(env);
    this.trackPending(env.fromLaneId, env.id, env.toLaneId, env.sentAt);

    const sender = this.host.getLane(env.fromLaneId);
    if (sender) {
      this.host.appendInterLaneRow(
        env.fromLaneId,
        'out',
        { id: env.toLaneId, displayName: recipient.displayName },
        env.message,
        env.done,
      );
    }

    // If the recipient is already idle, drain right away.
    if (recipient.status === 'idle') {
      this.drain(env.toLaneId);
    }

    return {
      delivered: true,
      envelopeId: env.id,
      queuedDepth: this.inbox(env.toLaneId).depth(),
      hint: REPLY_HINT,
    };
  }

  /**
   * Called by the harness when a lane finishes a turn (stop event).
   * If the lane has pending sends, transition to awaiting_peer.
   * Returns the suggested next status, or null to leave it untouched.
   */
  onLaneStop(laneId: string): HarnessLaneStatus | null {
    const pending = this.pending.get(laneId);
    if (pending && pending.length > 0) return 'awaiting_peer';
    return null;
  }

  /** User ran #cancel on a lane in awaiting_peer (or any lane mid-conversation). */
  cancelConversationsFor(laneId: string): void {
    const pending = this.pending.get(laneId);
    if (!pending || pending.length === 0) return;
    const peers = new Set(pending.map((p) => p.toLaneId));
    this.pending.delete(laneId);
    const senderInfo = this.host.getLane(laneId);
    const senderName = senderInfo?.displayName ?? laneId;
    for (const peerId of peers) {
      const peer = this.host.getLane(peerId);
      if (!peer) continue;
      // Tombstone the (canceller → peer) pair so any late reply from the
      // peer is dropped until it has consumed the cancellation notice.
      this.cancelledPairs.add(this.pairKey(laneId, peerId));
      this.host.appendSystemNotice(peerId, `peer ${senderName} cancelled`);
      this.notifyPeerOfTermination(peerId, senderName, 'cancelled');
    }
  }

  private pairKey(cancellerLaneId: string, peerLaneId: string): string {
    return `${cancellerLaneId}::${peerLaneId}`;
  }

  /**
   * A lane was closed (stopped). Clean up its inbox + pending bookkeeping.
   * `displayName` must be passed in by the caller — by the time we get here,
   * the lane has already been removed from the host registry, so
   * `host.getLane(laneId)` would return null and we'd fall back to raw ids.
   */
  onLaneClosed(laneId: string, displayName: string): void {
    this.inboxes.delete(laneId);
    // Drop any tombstones referencing this lane in either position.
    for (const key of this.cancelledPairs) {
      const [a, b] = key.split('::');
      if (a === laneId || b === laneId) this.cancelledPairs.delete(key);
    }
    // Anyone who had pending sends *to* this lane: notify them.
    for (const [senderId, sends] of this.pending.entries()) {
      const remaining = sends.filter((s) => s.toLaneId !== laneId);
      if (remaining.length !== sends.length) {
        if (remaining.length === 0) this.pending.delete(senderId);
        else this.pending.set(senderId, remaining);
        this.host.appendSystemNotice(senderId, `peer ${displayName} closed`);
        // Inject a synthesized prompt into the peer's session so the agent
        // learns of the closure in-context (not just as a transcript row).
        this.notifyPeerOfTermination(senderId, displayName, 'closed');
        // Bring sender out of awaiting_peer if they were stuck on this peer.
        const senderInfo = this.host.getLane(senderId);
        if (senderInfo?.status === 'awaiting_peer' && remaining.length === 0) {
          this.host.setLaneStatus(senderId, 'idle');
        }
      }
    }
  }

  /**
   * Inject a synthesized system prompt into the peer's session so the agent
   * learns of cancellation/closure in-context (not just as a transcript row).
   * Drained on the peer's next idle transition.
   */
  private notifyPeerOfTermination(
    peerLaneId: string,
    senderName: string,
    kind: 'cancelled' | 'closed',
  ): void {
    const peer = this.host.getLane(peerLaneId);
    if (!peer) return;
    if (peer.status === 'stopped' || peer.status === 'error') return;
    const verb = kind === 'cancelled' ? 'cancelled the conversation' : 'closed (lane stopped)';
    const text =
      `[inter-lane] harness: peer ${senderName} ${verb}. ` +
      'Do NOT call peer_send to that lane again for this exchange. End your turn after acknowledging.';
    // Queue as a synthetic envelope so it drains via the normal idle path
    // and merges with any other queued envelopes into a single user-turn.
    this.inbox(peerLaneId).push({
      id: `env-synth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromLaneId: '__harness__',
      toLaneId: peerLaneId,
      message: text,
      done: true,
      sentAt: Date.now(),
      harnessId: '__harness__',
    });
    if (peer.status === 'idle') this.drain(peerLaneId);
  }

  // ──────────────────────────────────────────────────────────────────
  // Internals

  private inbox(laneId: string): LaneInbox {
    let inbox = this.inboxes.get(laneId);
    if (!inbox) {
      inbox = new LaneInbox(laneId);
      this.inboxes.set(laneId, inbox);
    }
    return inbox;
  }

  private trackPending(senderId: string, envelopeId: string, toLaneId: string, sentAt: number): void {
    const list = this.pending.get(senderId) ?? [];
    list.push({ envelopeId, toLaneId, sentAt });
    this.pending.set(senderId, list);
  }

  private clearPendingFromPeer(receiverId: string, fromLaneId: string): void {
    // When `receiverId` receives a reply from `fromLaneId`, fromLaneId's
    // pending entry (which targeted receiverId) is satisfied.
    const sends = this.pending.get(fromLaneId);
    if (!sends) return;
    const remaining = sends.filter((s) => s.toLaneId !== receiverId);
    if (remaining.length === 0) this.pending.delete(fromLaneId);
    else this.pending.set(fromLaneId, remaining);

    const senderInfo = this.host.getLane(fromLaneId);
    if (senderInfo?.status === 'awaiting_peer' && remaining.length === 0) {
      // The reply isn't drained into fromLaneId yet — it goes into fromLaneId's
      // *inbox*. The lane:status → idle drain step will then pick it up.
      this.host.setLaneStatus(fromLaneId, 'idle');
    }
  }

  private onBus(event: LaneBusEvent): void {
    if (event.type === 'lane:status') {
      const { laneId, next } = event.payload;
      if (next === 'idle') this.drain(laneId);
    } else if (event.type === 'lane:closed') {
      this.onLaneClosed(event.payload.laneId, event.payload.displayName);
    }
  }

  private drain(laneId: string): void {
    const inbox = this.inbox(laneId);
    if (inbox.depth() === 0) return;
    const envelopes = inbox.drain();
    const recipient = this.host.getLane(laneId);
    if (!recipient) return;

    // Render the inbound rows in the recipient's transcript first.
    let drainedHarnessNotice = false;
    for (const env of envelopes) {
      if (env.fromLaneId === '__harness__') {
        // Synthetic — notice already rendered as a system row. Mark that the
        // peer has now seen the cancellation/closure prompt.
        drainedHarnessNotice = true;
        continue;
      }
      const sender = this.host.getLane(env.fromLaneId);
      const senderName = sender?.displayName ?? env.fromLaneId;
      this.host.appendInterLaneRow(
        laneId,
        'in',
        { id: env.fromLaneId, displayName: senderName },
        env.message,
        env.done,
      );
      // The reply satisfies the sender's pending entry.
      this.clearPendingFromPeer(laneId, env.fromLaneId);
    }
    if (drainedHarnessNotice) {
      // Any cancelled-pair tombstones targeting this lane are now obsolete —
      // the peer (us) has acknowledged the cancellation notice.
      const suffix = `::${laneId}`;
      for (const key of this.cancelledPairs) {
        if (key.endsWith(suffix)) this.cancelledPairs.delete(key);
      }
    }

    const text = this.composePrompt(envelopes);
    this.host.enqueueSystemPrompt(laneId, text);
  }

  private composePrompt(envelopes: InterLaneEnvelope[]): string {
    const parts: string[] = [];
    for (const env of envelopes) {
      if (env.fromLaneId === '__harness__') {
        // Synthetic notice — message is already self-describing.
        parts.push(env.message);
        continue;
      }
      const sender = this.host.getLane(env.fromLaneId);
      const senderName = sender?.displayName ?? env.fromLaneId;
      parts.push(`[inter-lane] From ${senderName} (id: ${env.id}):\n\n${env.message}`);
      if (env.done) {
        parts.push(
          `[inter-lane] ${senderName} closed the conversation (done:true). ` +
            'Do NOT call peer_send again. End your turn.',
        );
      } else {
        parts.push(
          `[inter-lane] Reply by calling peer_send({ to_lane: "${senderName}", message, done }). ` +
            'Set done:true if you have nothing substantive to add; the conversation ends silently.',
        );
      }
    }
    return parts.join('\n\n');
  }
}
