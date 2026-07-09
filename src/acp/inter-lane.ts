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
import { harnessEntry, resolveDisplayName, type HarnessEntrySnapshot } from './harness-directory';

export type DeliveryResult =
  | { delivered: true; envelopeId: string; queuedDepth: number; hint: string }
  | {
      delivered: false;
      reason:
        | 'self_send'
        | 'unknown_lane'
        | 'unknown_sender'
        | 'lane_stopped'
        | 'conversation_cancelled'
        | 'peer_in_flight'
        // spec 141: the target lane's harness view is gone or disposing — a
        // deterministic cross-view failure (no Rust-oneshot timeout).
        | 'harness_closed';
    };

/** spec 141: the recipient-side outcome of an inbound envelope, computed on the
 *  TARGET coordinator (where the pending state that classifies the sender lives)
 *  and handed back to the sender's coordinator so it can record its outbound
 *  side with the correct replier/done semantics. */
export interface AcceptInboundResult {
  result: DeliveryResult;
  /** Computed on the target: the sender is replying to a pending request, so it
   *  must NOT acquire its own pending / awaiting_peer. */
  senderIsReplier: boolean;
  /** done after replier-side coercion (a replier can never close the pair). */
  effectiveDone: boolean;
}

/** spec 120: metadata for assistant provenance after coordinator drain. */
export interface CoordinatorDrainContext {
  envelopeIds: string[];
  primaryPeerDisplayName: string | null;
  envelopeCount: number;
  /** spec 143: arm lane.peerAutoAcceptForTurn for this injected turn. Set only
   *  when EVERY mail envelope in the drained batch is local and carries
   *  `autoAccept` — otherwise a single delegated envelope would grant autonomy to
   *  work caused by other (or foreign) envelopes sharing the composed turn. */
  autoAcceptPermissions?: boolean;
}

export type InterLaneRowChannel = 'peer' | 'mention';

export interface LaneHost {
  /** Enumerate all live (non-stopped) lanes. */
  listLanes(): LaneSummary[];
  /** Resolve a lane id; returns null when unknown or stopped. */
  getLane(laneId: string): { status: HarnessLaneStatus; displayName: string } | null;
  /** Mutate the lane's status and emit a lane:status event. */
  setLaneStatus(laneId: string, next: HarnessLaneStatus): void;
  /** Inject a programmatic user-turn into the target lane's session. */
  enqueueSystemPrompt(laneId: string, text: string, drain?: CoordinatorDrainContext): void;
  /** Append an `inter_lane` transcript row to the lane's transcript. */
  appendInterLaneRow(
    laneId: string,
    direction: 'in' | 'out',
    peer: { id: string; displayName: string },
    message: string,
    done: boolean,
    meta?: { envelopeId?: string; channel?: InterLaneRowChannel },
  ): void;
  /** Surface a synthesized notice (e.g. "peer cancelled") to the user. */
  appendSystemNotice(laneId: string, text: string): void;
}

interface PendingSend {
  envelopeId: string;
  toLaneId: string;
  sentAt: number;
  mentionPacketId?: string;
}

export interface PendingPeerSummary {
  toLaneId: string;
  toDisplayName: string;
  envelopeId: string;
  sentAt: number;
}

const REPLY_HINT =
  'End your turn now. The reply (if any) will arrive as a new user message.';

// Codex defers ALL MCP tools behind its tool_search once the combined tool
// count crosses its direct-exposure threshold (codex-rs
// DIRECT_MCP_TOOL_EXPOSURE_THRESHOLD = 100); the model then answers
// "peer_send is not available in this lane" without ever searching. Appended
// to every drained reply instruction (and the lane-context peering line) so a
// deferred-tool backend searches instead of denying. Harmless elsewhere: the
// sentence is conditional on the tool being absent from the visible list.
export const PEER_SEND_DEFERRED_TOOL_HINT =
  'peer_send IS available in this lane: if it is not in your visible tool list, ' +
  'it is deferred behind your tool-search mechanism — search for "peer_send" ' +
  'rather than concluding it is unavailable.';

/** spec 116: inbound peer mail may drain while visually awaiting. */
export function canDrainInbound(status: HarnessLaneStatus): boolean {
  return status === 'idle' || status === 'awaiting_peer';
}

function shouldTrackPending(env: InterLaneEnvelope): boolean {
  if (env.done || env.fromLaneId === '__harness__') return false;
  return true;
}

function isInboundRequestEnvelope(env: InterLaneEnvelope): boolean {
  return env.kind === 'mention_request';
}

export interface MentionFanOutTarget {
  laneId: string;
  displayName: string;
}

export interface MentionFanOutResult {
  packetId: string;
  delivered: string[];
  failed: Array<{ displayName: string; reason: string }>;
}

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

  /**
   * Same-view delivery. Validates against THIS coordinator's tables (which owns
   * both the sender and the recipient), then runs the recipient side
   * (`acceptInbound`) and the sender side (`recordOutbound`). Cross-view delivery
   * (spec 141) calls the two halves separately across two coordinators.
   */
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
    // One outstanding message per target (sender-side). Checked here, before
    // any side effect, to preserve the pre-factor ordering of failure reasons.
    if (this.isPeerInFlight(env, env.toLaneId)) {
      return { delivered: false, reason: 'peer_in_flight' };
    }

    const inbound = this.acceptInbound(env);
    if (!inbound.result.delivered) return inbound.result;
    this.recordOutbound(
      env.fromLaneId,
      { key: env.toLaneId, displayName: recipient.displayName },
      env,
      inbound,
    );
    return inbound.result;
  }

  /** spec 141: the "one outstanding message per target" guard, exposed so the
   *  cross-view bridge can run it against the sender's coordinator before
   *  handing the envelope to the target. `toKey` is the pending key — a local
   *  lane id for same-view, the foreign displayName for cross-view. */
  isPeerInFlight(env: InterLaneEnvelope, toKey: string): boolean {
    return shouldTrackPending(env) && this.hasPendingTo(env.fromLaneId, toKey);
  }

  /**
   * spec 141 — recipient side of delivery, run on the coordinator that OWNS the
   * recipient lane. Classifies the sender as initiator-vs-replier against THIS
   * coordinator's pending table (the only place that state lives), coerces a
   * replier's done flag, pushes the inbox, and drains. Returns the classification
   * so the sender's coordinator can record its outbound side consistently.
   *
   * For cross-view delivery `env.fromLaneId` carries the sender's globally-unique
   * displayName (the foreign pending key) and `env.toLaneId` is this view's local
   * lane id — see the cross-view envelope-keying invariant in spec 141.
   */
  acceptInbound(env: InterLaneEnvelope): AcceptInboundResult {
    const fail = (reason: Extract<DeliveryResult, { delivered: false }>['reason']): AcceptInboundResult => ({
      result: { delivered: false, reason },
      senderIsReplier: false,
      effectiveDone: env.done,
    });
    const recipient = this.host.getLane(env.toLaneId);
    if (!recipient) return fail('unknown_lane');
    if (recipient.status === 'stopped' || recipient.status === 'error') {
      return fail('lane_stopped');
    }
    if (this.cancelledPairs.has(this.pairKey(env.toLaneId, env.fromLaneId))) {
      return fail('conversation_cancelled');
    }

    // Initiator-owns-lifecycle: only the initiator of a pair may set done:true.
    // If the recipient already has a pending send toward this sender, the sender
    // is a replier — coerce their done flag to false (a reply is not a new
    // initiation). Harness-injected envelopes bypass this rule.
    const senderIsReplier =
      env.fromLaneId !== '__harness__' && this.hasPendingTo(env.toLaneId, env.fromLaneId);
    let effective = env;
    if (senderIsReplier && env.done) {
      effective = { ...env, done: false };
    }

    this.inbox(effective.toLaneId).push(effective);
    if (canDrainInbound(recipient.status)) {
      this.drain(effective.toLaneId);
    }

    return {
      result: {
        delivered: true,
        envelopeId: effective.id,
        queuedDepth: this.inbox(effective.toLaneId).depth(),
        hint: REPLY_HINT,
      },
      senderIsReplier,
      effectiveDone: effective.done,
    };
  }

  /**
   * spec 141 — sender side of delivery, run on the coordinator that owns the
   * sender lane. Appends the outbound transcript row and, when the sender is the
   * initiator (not a replier), tracks pending so the lane goes to awaiting_peer
   * on stop. `target.key` is the pending key (local lane id same-view, foreign
   * displayName cross-view); `classification` comes from `acceptInbound`.
   */
  recordOutbound(
    fromLaneId: string,
    target: { key: string; displayName: string },
    env: InterLaneEnvelope,
    classification: { senderIsReplier: boolean; effectiveDone: boolean },
  ): void {
    const sender = this.host.getLane(fromLaneId);
    if (sender) {
      this.host.appendInterLaneRow(
        fromLaneId,
        'out',
        { id: target.key, displayName: target.displayName },
        env.message,
        classification.effectiveDone,
        { envelopeId: env.id, channel: interLaneRowChannel(env) },
      );
    }
    if (shouldTrackPending(env) && !classification.senderIsReplier) {
      this.trackPending(fromLaneId, env.id, target.key, env.sentAt, env.mentionPacketId);
    }
    this.recomputePeerStatus(fromLaneId);
  }

  /**
   * spec 115: fan-out one body to multiple lanes from the composer (@mention).
   */
  deliverMentionFanOut(
    requesterId: string,
    requesterDisplayName: string,
    targets: MentionFanOutTarget[],
    body: string,
    harnessId?: string,
  ): MentionFanOutResult {
    const packetId = `mnt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const delivered: string[] = [];
    const failed: Array<{ displayName: string; reason: string }> = [];
    for (const target of targets) {
      const prompt =
        `[mention] From ${requesterDisplayName} (packet: ${packetId}):\n\n${body}\n\n` +
        `Reply with peer_send({ to_lane: "${requesterDisplayName}", message }). ` +
        'Omit `done` — only the requester may close the conversation.';
      const env: InterLaneEnvelope = {
        id: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fromLaneId: requesterId,
        toLaneId: target.laneId,
        message: prompt,
        done: false,
        sentAt: Date.now(),
        harnessId,
        kind: 'mention_request',
        mentionPacketId: packetId,
      };
      const result = this.deliver(env);
      if (result.delivered) {
        delivered.push(target.displayName);
      } else {
        failed.push({ displayName: target.displayName, reason: result.reason });
      }
    }
    return { packetId, delivered, failed };
  }

  /** spec 116: set idle vs awaiting_peer from outstanding pending peers. */
  recomputePeerStatus(laneId: string): void {
    const lane = this.host.getLane(laneId);
    if (!lane || lane.status === 'busy' || lane.status === 'needs_permission') return;
    const pending = this.pendingPeersFor(laneId).length;
    this.host.setLaneStatus(laneId, pending > 0 ? 'awaiting_peer' : 'idle');
  }

  /**
   * Inject a synthetic harness envelope into a lane's inbox (used by the
   * attention-redirect path). Drains immediately if the lane is idle.
   */
  injectHarnessEnvelope(laneId: string, message: string): void {
    const lane = this.host.getLane(laneId);
    if (!lane) return;
    this.inbox(laneId).push({
      id: `env-synth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromLaneId: '__harness__',
      toLaneId: laneId,
      message,
      done: false,
      sentAt: Date.now(),
      harnessId: '__harness__',
    });
    if (canDrainInbound(lane.status)) this.drain(laneId);
  }

  /**
   * spec 128: deliver a human redirect for a flagged judgement item. The text
   * is injected as a synthetic harness user-turn on the lane's NEXT idle
   * (`canDrainInbound`) — late-arrival rework is accepted (ADR-0001). Rejects a
   * stopped/cancelled lane so the caller can keep the item open.
   */
  deliverRedirect(
    laneId: string,
    text: string,
  ): { delivered: boolean; reason?: 'unknown_lane' | 'lane_stopped' } {
    const lane = this.host.getLane(laneId);
    if (!lane) return { delivered: false, reason: 'unknown_lane' };
    if (lane.status === 'stopped' || lane.status === 'error') {
      return { delivered: false, reason: 'lane_stopped' };
    }
    const message =
      '[attention] The human reviewed a decision you flagged and is redirecting you:\n\n' +
      `${text}\n\n` +
      'Adjust course accordingly on this turn. You do not need to re-flag unless a new judgement call arises.';
    this.injectHarnessEnvelope(laneId, message);
    return { delivered: true };
  }

  /**
   * spec 183: the human acknowledged a decision the lane flagged — approving the
   * `chosen` path. Unlike redirect (a typed steer), this is a fixed approve-and-
   * proceed confirmation, and it is deliberately no-op-friendly: a lane whose
   * flagged work is already complete is told it need not reply or start new work,
   * so a confirmation never forces a vacuous turn. Same delivery as deliverRedirect.
   */
  deliverAcknowledge(
    laneId: string,
  ): { delivered: boolean; reason?: 'unknown_lane' | 'lane_stopped' } {
    const lane = this.host.getLane(laneId);
    if (!lane) return { delivered: false, reason: 'unknown_lane' };
    if (lane.status === 'stopped' || lane.status === 'error') {
      return { delivered: false, reason: 'lane_stopped' };
    }
    const message =
      '[attention] The human reviewed the decision you flagged and acknowledged it — ' +
      'your chosen approach is approved; no course change is needed.\n\n' +
      'This is a confirmation only: if the flagged work is already complete, no reply or new ' +
      'work is required. Continue only if there is remaining work on this task.';
    this.injectHarnessEnvelope(laneId, message);
    return { delivered: true };
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
    for (const peerKey of peers) {
      // Tombstone the (canceller → peer) pair so any late reply from the peer is
      // dropped until it has consumed the cancellation notice. For a foreign peer
      // the late reply arrives back through the bridge into THIS coordinator
      // (env.fromLaneId = the foreign displayName = peerKey), so the same tombstone
      // catches it.
      this.cancelledPairs.add(this.pairKey(laneId, peerKey));
      const peer = this.host.getLane(peerKey);
      if (peer) {
        // Local peer — notify directly.
        this.host.appendSystemNotice(peerKey, `peer ${senderName} cancelled`);
        this.notifyPeerOfTermination(peerKey, senderName, 'cancelled');
        continue;
      }
      // spec 141: foreign pending peer — peerKey is a globally-unique displayName
      // owned by another harness view. Route the cancellation onto the target
      // coordinator so the foreign lane gets the same notice + tombstone +
      // termination prompt a local cancel would produce (Codex-1 re-review High 2).
      // Without this, the foreign peer keeps running and could still reply,
      // breaking byte-for-byte #cancel.
      const resolved = resolveDisplayName(peerKey);
      if (resolved) {
        harnessEntry(resolved.harnessId)?.acceptForeignCancellation(resolved.laneId, senderName);
      }
    }
    this.recomputePeerStatus(laneId);
  }

  /**
   * spec 141 — a FOREIGN lane (`cancellerDisplayName`, owned by another harness
   * view) ran #cancel on its conversation with our local lane `targetLaneId`.
   * Give `targetLaneId` the same treatment a local peer cancel produces: drop any
   * pending it held toward the canceller, surface the notice, and inject the
   * termination prompt so the agent stops replying.
   */
  acceptForeignCancellation(targetLaneId: string, cancellerDisplayName: string): void {
    const target = this.host.getLane(targetLaneId);
    if (!target) return;
    // The canceller is foreign, so its key in our pending table (if any) is its
    // displayName. Clear any pending our lane held toward it.
    this.clearPendingFromPeer(targetLaneId, cancellerDisplayName);
    this.host.appendSystemNotice(targetLaneId, `peer ${cancellerDisplayName} cancelled`);
    // Carry ack metadata: when this lane drains the notice, it routes a callback
    // to the canceller's coordinator to clear the cross-view tombstone (so the
    // tombstone lives until acknowledgement, not until the canceller re-sends).
    this.notifyPeerOfTermination(targetLaneId, cancellerDisplayName, 'cancelled', {
      cancellerDisplayName,
      peerDisplayName: target.displayName,
    });
    this.recomputePeerStatus(targetLaneId);
  }

  /** spec 141 — clear a cross-view cancellation tombstone on THIS (canceller's)
   *  coordinator, invoked when the foreign peer acknowledges the cancellation by
   *  draining its notice. */
  clearForeignCancellationTombstone(cancellerLaneId: string, peerDisplayName: string): void {
    this.cancelledPairs.delete(this.pairKey(cancellerLaneId, peerDisplayName));
  }

  /**
   * spec 141 — a foreign harness view closed. For any local lane with a pending
   * send toward one of the closed harness's lanes (keyed by displayName in the
   * snapshot), surface a "peer closed" notice + termination prompt, exactly like
   * a local lane closing. Pending tables are private to each coordinator, so this
   * is the directory→coordinator bridge for the close path.
   */
  onForeignHarnessClosed(snapshot: HarnessEntrySnapshot): void {
    const names = new Set(snapshot.displayNames);
    for (const [senderId, sends] of [...this.pending.entries()]) {
      const closing = sends.filter((s) => names.has(s.toLaneId));
      if (closing.length === 0) continue;
      const remaining = sends.filter((s) => !names.has(s.toLaneId));
      if (remaining.length === 0) this.pending.delete(senderId);
      else this.pending.set(senderId, remaining);
      const notified = new Set<string>();
      for (const s of closing) {
        if (notified.has(s.toLaneId)) continue;
        notified.add(s.toLaneId);
        this.host.appendSystemNotice(senderId, `peer ${s.toLaneId} closed`);
        this.notifyPeerOfTermination(senderId, s.toLaneId, 'closed');
      }
      this.recomputePeerStatus(senderId);
    }
    // Drop any cancellation tombstones referencing the closed foreign names.
    for (const key of this.cancelledPairs) {
      const peerKey = key.split('::')[1];
      if (names.has(peerKey)) this.cancelledPairs.delete(key);
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
        this.recomputePeerStatus(senderId);
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
    foreignCancelAck?: { cancellerDisplayName: string; peerDisplayName: string },
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
      foreignCancelAck,
    });
    if (canDrainInbound(peer.status)) this.drain(peerLaneId);
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

  private hasPendingTo(senderId: string, toLaneId: string): boolean {
    const sends = this.pending.get(senderId);
    return sends?.some((s) => s.toLaneId === toLaneId) ?? false;
  }

  private trackPending(
    senderId: string,
    envelopeId: string,
    toLaneId: string,
    sentAt: number,
    mentionPacketId?: string,
  ): void {
    const list = this.pending.get(senderId) ?? [];
    list.push({ envelopeId, toLaneId, sentAt, mentionPacketId });
    this.pending.set(senderId, list);
  }

  /** Clear requester pending when an inbound reply is drained (spec 115/116). */
  private clearPendingFromPeer(
    requesterId: string,
    replierId: string,
    envelopeId?: string,
  ): void {
    const sends = this.pending.get(requesterId);
    if (!sends) return;
    let remaining: PendingSend[];
    if (!envelopeId) {
      const idx = sends.findIndex((s) => s.toLaneId === replierId);
      if (idx === -1) return;
      remaining = sends.filter((_, i) => i !== idx);
    } else {
      remaining = sends.filter((s) => {
        if (s.toLaneId !== replierId) return true;
        return s.envelopeId !== envelopeId && s.mentionPacketId !== envelopeId;
      });
    }
    if (remaining.length === 0) this.pending.delete(requesterId);
    else this.pending.set(requesterId, remaining);
    this.recomputePeerStatus(requesterId);
  }

  private onBus(event: LaneBusEvent): void {
    if (event.type === 'lane:status') {
      const { laneId, next } = event.payload;
      if (canDrainInbound(next)) this.drain(laneId);
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
    if (envelopes.length === 0) return;

    // Capture initiator-vs-callee role per envelope before clearing pending,
    // so the prompt hint can address the recipient correctly.
    const recipientWasInitiator = new Map<string, boolean>();
    for (const env of envelopes) {
      if (env.fromLaneId === '__harness__') continue;
      recipientWasInitiator.set(env.id, this.hasPendingTo(laneId, env.fromLaneId));
    }

    // Render the inbound rows in the recipient's transcript first.
    let drainedHarnessNotice = false;
    for (const env of envelopes) {
      if (env.fromLaneId === '__harness__') {
        // Synthetic — notice already rendered as a system row. Mark that the
        // peer has now seen the cancellation/closure prompt.
        drainedHarnessNotice = true;
        // spec 141: a foreign cancellation notice carries ack metadata. Draining
        // it is this peer's acknowledgement, so clear the tombstone on the
        // canceller's (foreign) coordinator — the cross-coordinator analogue of
        // the local suffix-clear below.
        if (env.foreignCancelAck) {
          const ack = env.foreignCancelAck;
          const canceller = resolveDisplayName(ack.cancellerDisplayName);
          if (canceller) {
            harnessEntry(canceller.harnessId)?.clearCancellationTombstone(
              canceller.laneId,
              ack.peerDisplayName,
            );
          }
        }
        continue;
      }
      const sender = this.host.getLane(env.fromLaneId);
      // spec 141: a foreign sender has no local lane, so fall back to the
      // displayName carried on the cross-view envelope.
      const senderName = sender?.displayName ?? env.fromDisplayName ?? env.fromLaneId;
      this.host.appendInterLaneRow(
        laneId,
        'in',
        { id: env.fromLaneId, displayName: senderName },
        env.message,
        env.done,
        { envelopeId: env.id, channel: interLaneRowChannel(env) },
      );
      // Clear requester pending only on inbound replies — not when draining an
      // outbound consult the target received (spec 115/116).
      if (!isInboundRequestEnvelope(env)) {
        this.clearPendingFromPeer(laneId, env.fromLaneId, env.mentionPacketId);
      }
    }
    if (drainedHarnessNotice) {
      // Any cancelled-pair tombstones targeting this lane are now obsolete —
      // the peer (us) has acknowledged the cancellation notice.
      const suffix = `::${laneId}`;
      for (const key of this.cancelledPairs) {
        if (key.endsWith(suffix)) this.cancelledPairs.delete(key);
      }
    }

    const mailEnvelopes = envelopes.filter((env) => env.fromLaneId !== '__harness__');
    const firstMail = mailEnvelopes[0];
    const primaryPeerDisplayName = firstMail
      ? (this.host.getLane(firstMail.fromLaneId)?.displayName ??
        firstMail.fromDisplayName ??
        firstMail.fromLaneId)
      : null;
    // spec 143: arm peer auto-accept only when EVERY mail envelope in this
    // composed turn is a local sibling's request/initiation carrying autoAccept.
    // A foreign sender (getLane → null), a reply (recipient was the initiator),
    // or one non-delegated envelope in the batch all veto the grant — otherwise
    // a single delegated message would auto-accept work caused by the others.
    const autoAcceptPermissions =
      mailEnvelopes.length > 0 &&
      mailEnvelopes.every(
        (env) =>
          env.autoAccept === true &&
          !recipientWasInitiator.get(env.id) &&
          this.host.getLane(env.fromLaneId) !== null,
      );
    const text = this.composePrompt(envelopes, recipientWasInitiator);
    this.host.enqueueSystemPrompt(laneId, text, {
      envelopeIds: mailEnvelopes.map((env) => env.id),
      primaryPeerDisplayName,
      envelopeCount: mailEnvelopes.length,
      autoAcceptPermissions,
    });
  }

  private composePrompt(
    envelopes: InterLaneEnvelope[],
    recipientWasInitiator: Map<string, boolean>,
  ): string {
    const parts: string[] = [];
    for (const env of envelopes) {
      if (env.fromLaneId === '__harness__') {
        // Synthetic notice — message is already self-describing.
        parts.push(env.message);
        continue;
      }
      if (env.kind === 'mention_request') {
        parts.push(env.message);
        continue;
      }
      const sender = this.host.getLane(env.fromLaneId);
      const senderName = sender?.displayName ?? env.fromDisplayName ?? env.fromLaneId;
      if (env.mentionPacketId) {
        parts.push(
          `[mention reply] From ${senderName}:\n\n${env.message}\n\n` +
            '(Other mentions may still reply separately.)',
        );
      } else {
        parts.push(`[inter-lane] From ${senderName} (id: ${env.id}):\n\n${env.message}`);
      }
      if (env.done) {
        // Initiator closed the conversation (the only way done:true survives
        // delivery — replier dones are coerced to false in deliver()).
        parts.push(
          `[inter-lane] ${senderName} closed the conversation (done:true). ` +
            'Do NOT call peer_send again. End your turn.',
        );
      } else if (recipientWasInitiator.get(env.id)) {
        // We started this exchange; the peer just replied. We own the close.
        parts.push(
          `[inter-lane] Reply with peer_send({ to_lane: "${senderName}", message }) to continue, ` +
            `or peer_send({ to_lane: "${senderName}", message, done: true }) to close the conversation. ` +
            'Only the original initiator (you) may set done:true. ' +
            PEER_SEND_DEFERRED_TOOL_HINT,
        );
      } else {
        // Peer initiated; we are the callee. Reply without done — only the
        // initiator can close.
        parts.push(
          `[inter-lane] Reply by calling peer_send({ to_lane: "${senderName}", message }). ` +
            'Omit `done` — only the original initiator may close the conversation with done:true. ' +
            PEER_SEND_DEFERRED_TOOL_HINT,
        );
      }
    }
    return parts.join('\n\n');
  }
}

function interLaneRowChannel(env: InterLaneEnvelope): InterLaneRowChannel {
  if (env.kind === 'mention_request') return 'mention';
  return 'peer';
}
