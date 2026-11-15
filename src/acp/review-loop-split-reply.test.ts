import { describe, expect, it } from 'vitest';
import { HarnessReviewLoopController } from './harness-review-loop-controller';
import type { HarnessReviewLoopHost, ReviewSubjectResult } from './harness-view-host';
import type { HarnessLane } from './harness-view-types';
import { InterLaneCoordinator, type LaneHost } from './inter-lane';
import { LaneBus } from './lane-bus';
import type { ReviewerVerdict } from './review-loop';
import type { HarnessLaneStatus } from './types';

// spec 276: a reviewer's reply over the production peer path —
// peer_send → InterLaneCoordinator.deliver → drain → onHarnessReply → loop —
// instead of calling the controller's onHarnessReply by hand.

interface FakeLane {
  id: string;
  displayName: string;
  status: HarnessLaneStatus;
  client: object | null;
  activeSystemLabel: string | null;
}

interface RoundRecord {
  blockers: number;
  verdicts: Array<ReviewerVerdict | null>;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function diffResult(text: string): ReviewSubjectResult {
  return {
    subject: {
      kind: 'diff',
      repoRoot: '/r',
      isUnbornHead: false,
      diffstat: [{ path: 'src/a.ts', status: 'M', added: 1, removed: 0 }],
      diff: text,
      untracked: [],
    },
  };
}

/** The real coordinator and the real loop controller on one lane bus, in the
 *  order AcpHarnessView builds them (coordinator first, then the controller). */
function setup() {
  const bus = new LaneBus();
  const author: FakeLane = { id: 'claude-1', displayName: 'Claude-1', status: 'idle', client: {}, activeSystemLabel: null };
  const reviewer: FakeLane = { id: 'grok-1', displayName: 'Grok-1', status: 'idle', client: {}, activeSystemLabel: null };
  const fakes = [author, reviewer];
  const lanes = fakes as unknown as HarnessLane[];
  const find = (id: string): FakeLane | undefined => fakes.find((l) => l.id === id);
  const setStatus = (lane: FakeLane, next: HarnessLaneStatus): void => {
    const prev = lane.status;
    if (prev === next) return;
    lane.status = next;
    if (next !== 'busy' && next !== 'needs_permission') lane.activeSystemLabel = null;
    bus.emit({ type: 'lane:status', payload: { laneId: lane.id, prev, next, at: Date.now() } });
  };

  /** Turns the coordinator composed from drained peer envelopes. */
  const peerPrompts: Array<{ laneId: string; text: string }> = [];
  /** Labels of the loop's own system turns (fix / summary). */
  const turns: Array<string | undefined> = [];
  /** One entry per completed round, with each reviewer's parsed verdict. */
  const rounds: RoundRecord[] = [];
  let ctl: HarnessReviewLoopController | null = null;
  /** Ends the author's running system turn; a turn lasts until the test ends it. */
  let endTurn: (() => void) | null = null;

  const laneHost: LaneHost = {
    listLanes: () => [],
    getLane: (id) => {
      const lane = find(id);
      return lane ? { status: lane.status, displayName: lane.displayName } : null;
    },
    setLaneStatus: (id, next) => {
      const lane = find(id);
      if (lane) setStatus(lane, next);
    },
    // A drained peer prompt starts a turn on that lane.
    enqueueSystemPrompt: (id, text) => {
      peerPrompts.push({ laneId: id, text });
      const lane = find(id);
      if (lane) setStatus(lane, 'busy');
    },
    appendInterLaneRow: () => {},
    appendSystemNotice: () => {},
    onHarnessReply: (id, reply) => ctl?.onHarnessReply(id, reply) ?? 'complete',
    holdsPeerReplies: (id, fromLaneId) => ctl?.holdsReplies(id, fromLaneId) ?? false,
  };
  const coordinator = new InterLaneCoordinator(bus, laneHost);

  const subjects = [diffResult('+a'), diffResult('+b'), diffResult('+c')];
  let subjectIndex = 0;
  const host: HarnessReviewLoopHost = {
    element: {} as HTMLElement,
    lanes,
    activeLaneId: author.id,
    projectDir: '/r',
    flashChip: () => {},
    subscribeLaneBus: (handler) => bus.subscribe(handler),
    invalidate: () => {},
    appendNotice: () => {},
    reserveCommandTurn: (lane, label) => {
      const fake = lane as unknown as FakeLane;
      setStatus(fake, 'busy');
      fake.activeSystemLabel = label;
    },
    releaseReservedTurn: (lane, next) => setStatus(lane as unknown as FakeLane, next ?? 'idle'),
    enqueueSystemPrompt: async (lane, _text, _drain, label) => {
      const fake = lane as unknown as FakeLane;
      if (fake.status !== 'idle' && fake.status !== 'awaiting_peer') return false;
      turns.push(label);
      setStatus(fake, 'busy');
      await new Promise<void>((resolve) => {
        endTurn = resolve;
      });
      // A turn's end goes through the coordinator, as the view's does.
      setStatus(fake, 'idle');
      coordinator.recomputePeerStatus(fake.id);
      return true;
    },
    resolveReviewers: (lane) => ({ reviewers: lanes.filter((l) => l.id !== lane.id), skipped: [] }),
    collectReviewSubject: async () => subjects[Math.min(subjectIndex++, subjects.length - 1)] as ReviewSubjectResult,
    collectReviewIntent: () => 'intent',
    fanOutReview: (lane, targets, body) =>
      coordinator.deliverMentionFanOut(lane.id, lane.displayName, targets, body, undefined, { replyConsumer: 'harness' }),
    cancelPeerConversations: (lane) => {
      coordinator.cancelConversationsFor(lane.id, { consumer: 'harness' });
      coordinator.recomputePeerStatus(lane.id);
    },
    settleReviewRequest: (lane, reviewerLaneId) => coordinator.settleHarnessRequest(lane.id, reviewerLaneId),
    pendingPeerCount: (lane) => coordinator.pendingPeersFor(lane.id).length,
    loopChanged: () => {},
    recordReviewOutcome: (lane, outcome) => {
      rounds.push({
        blockers: outcome.blockers,
        verdicts: ctl?.telemetry(lane.id)?.reviewers.map((r) => r.verdict) ?? [],
      });
    },
  };
  const controller = new HarnessReviewLoopController(host);
  ctl = controller;
  controller.subscribe();

  let envelopes = 0;
  /** One peer_send from the reviewer to the author. Each tool call is its own
   *  request, so the loop's microtasks run before the next one arrives. */
  const reviewerSends = async (message: string): Promise<void> => {
    envelopes += 1;
    const result = coordinator.deliver({
      id: `env-review-${envelopes}`,
      fromLaneId: reviewer.id,
      toLaneId: author.id,
      message,
      done: false,
      sentAt: envelopes,
    });
    expect(result.delivered).toBe(true);
    await flush();
  };
  const reviewerEndsTurn = async (): Promise<void> => {
    setStatus(reviewer, 'idle');
    await flush();
  };
  const authorEndsTurn = async (): Promise<void> => {
    const end = endTurn;
    endTurn = null;
    end?.();
    await flush();
  };
  /** A user prompt on the author mid-round, and its end. */
  const authorTurn = async (next: 'busy' | 'idle'): Promise<void> => {
    setStatus(author, next);
    if (next === 'idle') coordinator.recomputePeerStatus(author.id);
    await flush();
  };

  return {
    ctl: controller,
    coordinator,
    author: author as unknown as HarnessLane,
    authorFake: author,
    peerPrompts,
    turns,
    rounds,
    reviewerSends,
    reviewerEndsTurn,
    authorEndsTurn,
    authorTurn,
    authorPrompts: () => peerPrompts.filter((p) => p.laneId === author.id),
    reviewerPrompts: () => peerPrompts.filter((p) => p.laneId === reviewer.id),
  };
}

// A reviewer that writes its overview first and its findings second.
const OVERVIEW = '## Summary\nOne defect in the loop bound; details in my next message.\n\n### Warnings\n- src/a.ts:9 — vague name';
const FINDINGS = '### Blockers\n- src/a.ts:3 — off by one\n\nVERDICT: FAIL';

describe('#review pass — reviewer reply over the real peer path (spec 276)', () => {
  it('reads a one-message reply as FAIL and starts a fix turn', async () => {
    const t = setup();
    expect(await t.ctl.start(t.author, [])).toBe(true);
    // The [mention] request reached the reviewer and started its turn.
    expect(t.reviewerPrompts()).toHaveLength(1);

    await t.reviewerSends(`${OVERVIEW}\n\n${FINDINGS}`);
    await t.reviewerEndsTurn();

    expect(t.rounds[0]).toEqual({ blockers: 1, verdicts: ['fail'] });
    expect(t.turns).toEqual(['fixing 1/3']);
    expect(t.authorPrompts()).toEqual([]);
    t.ctl.dispose();
  });

  it('reads a reply split over two peer_send calls as one FAIL', async () => {
    const t = setup();
    expect(await t.ctl.start(t.author, [])).toBe(true);

    await t.reviewerSends(OVERVIEW);
    // Not whole yet: the request stays pending and the round waits.
    expect(t.rounds).toEqual([]);
    expect(t.coordinator.pendingPeersFor('claude-1').map((p) => p.toLaneId)).toEqual(['grok-1']);
    expect(t.authorFake.status).toBe('awaiting_peer');

    await t.reviewerSends(FINDINGS);
    await t.reviewerEndsTurn();

    expect(t.rounds[0]).toEqual({ blockers: 1, verdicts: ['fail'] });
    expect(t.ctl.telemetry(t.author.id)?.stopReason ?? null).toBeNull();
    expect(t.turns).toEqual(['fixing 1/3']);
    expect(t.authorPrompts()).toEqual([]);
    expect(t.coordinator.pendingPeersFor('claude-1')).toEqual([]);
    t.ctl.dispose();
  });

  it('keeps a message sent after the VERDICT line out of the author lane', async () => {
    const t = setup();
    expect(await t.ctl.start(t.author, [])).toBe(true);

    await t.reviewerSends(`${OVERVIEW}\n\n${FINDINGS}`);
    expect(t.turns).toEqual(['fixing 1/3']);
    // The author is in its fix turn when the reviewer's afterthought arrives.
    await t.reviewerSends('One more thing: the loop bound is also off in the test.');
    await t.reviewerEndsTurn();
    await t.authorEndsTurn();

    expect(t.authorPrompts()).toEqual([]);
    // Read as a reply: the reviewer is not left waiting on the author.
    expect(t.coordinator.pendingPeersFor('grok-1')).toEqual([]);
    // Round 2 went out, and the afterthought did not count toward it.
    expect(t.reviewerPrompts()).toHaveLength(2);
    expect(t.ctl.telemetry(t.author.id)?.reviewers).toMatchObject([{ state: 'pending', verdict: null }]);
    t.ctl.dispose();
  });

  it('reads what a reviewer sent as its whole reply once its turn ends without a VERDICT line', async () => {
    const t = setup();
    expect(await t.ctl.start(t.author, [])).toBe(true);

    await t.reviewerSends(OVERVIEW);
    expect(t.rounds).toEqual([]);
    await t.reviewerEndsTurn();

    expect(t.rounds[0]).toEqual({ blockers: 0, verdicts: ['missing'] });
    expect(t.ctl.telemetry(t.author.id)?.stopReason).toBe('inconclusive');
    expect(t.turns).toEqual(['review pass summary']);
    // Settled, not withdrawn: no cancellation notice reached the reviewer.
    expect(t.coordinator.pendingPeersFor('claude-1')).toEqual([]);
    expect(t.reviewerPrompts()).toHaveLength(1);
    expect(t.authorPrompts()).toEqual([]);
    t.ctl.dispose();
  });

  it('waits for a busy author to drain the rest of the reply before reading it', async () => {
    const t = setup();
    expect(await t.ctl.start(t.author, [])).toBe(true);

    await t.reviewerSends(OVERVIEW);
    // A user prompt on the author: the second part waits in the author's inbox.
    await t.authorTurn('busy');
    await t.reviewerSends(FINDINGS);
    await t.reviewerEndsTurn();
    expect(t.rounds).toEqual([]);

    await t.authorTurn('idle');

    expect(t.rounds[0]).toEqual({ blockers: 1, verdicts: ['fail'] });
    expect(t.turns).toEqual(['fixing 1/3']);
    expect(t.authorPrompts()).toEqual([]);
    t.ctl.dispose();
  });
});
