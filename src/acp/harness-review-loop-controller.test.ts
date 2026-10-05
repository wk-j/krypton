import { describe, expect, it } from 'vitest';
import { HarnessReviewLoopController } from './harness-review-loop-controller';
import type { HarnessReviewLoopHost, ReviewSubjectResult } from './harness-view-host';
import type { HarnessLane } from './harness-view-types';
import { LaneBus } from './lane-bus';
import type { HarnessLaneStatus } from './types';

interface FakeLane {
  id: string;
  displayName: string;
  status: HarnessLaneStatus;
  client: object | null;
  activeSystemLabel: string | null;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const last = (items: string[]): string | undefined => items[items.length - 1];

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

function setup(subjects: ReviewSubjectResult[] = [diffResult('+a'), diffResult('+b'), diffResult('+c')]) {
  const bus = new LaneBus();
  const author: FakeLane = { id: 'claude-1', displayName: 'Claude-1', status: 'idle', client: {}, activeSystemLabel: null };
  const reviewer: FakeLane = { id: 'grok-1', displayName: 'Grok-1', status: 'idle', client: {}, activeSystemLabel: null };
  const lanes = [author, reviewer] as unknown as HarnessLane[];
  const setStatus = (lane: FakeLane, next: HarnessLaneStatus): void => {
    const prev = lane.status;
    lane.status = next;
    if (next !== 'busy' && next !== 'needs_permission') lane.activeSystemLabel = null;
    bus.emit({ type: 'lane:status', payload: { laneId: lane.id, prev, next, at: Date.now() } });
  };
  const rows: string[] = [];
  const flashes: string[] = [];
  const bodies: string[] = [];
  const turns: Array<{ label: string | undefined; text: string }> = [];
  const outcomes: Array<{ blockers: number; subjectLabel: string }> = [];
  let cancels = 0;
  let changes = 0;
  let packet = 0;
  let subjectIndex = 0;
  const host: HarnessReviewLoopHost = {
    element: {} as HTMLElement,
    lanes,
    activeLaneId: author.id,
    projectDir: '/r',
    flashChip: (text) => flashes.push(text),
    subscribeLaneBus: (handler) => bus.subscribe(handler),
    render: () => {},
    appendTranscript: (_lane, _kind, text) => rows.push(text),
    reserveCommandTurn: (lane, label) => {
      (lane as unknown as FakeLane).activeSystemLabel = label;
      setStatus(lane as unknown as FakeLane, 'busy');
      (lane as unknown as FakeLane).activeSystemLabel = label;
    },
    releaseReservedTurn: (lane, next) => setStatus(lane as unknown as FakeLane, next ?? 'idle'),
    enqueueSystemPrompt: async (lane, text, _drain, label) => {
      const fake = lane as unknown as FakeLane;
      if (fake.status !== 'idle' && fake.status !== 'awaiting_peer') return false;
      turns.push({ label, text });
      setStatus(fake, 'busy');
      await Promise.resolve();
      setStatus(fake, 'idle');
      return true;
    },
    resolveReviewers: (lane) => ({ reviewers: lanes.filter((l) => l.id !== lane.id), skipped: [] }),
    collectReviewSubject: async () => subjects[Math.min(subjectIndex++, subjects.length - 1)] as ReviewSubjectResult,
    collectReviewIntent: () => 'intent',
    fanOutReview: (_lane, targets, body) => {
      bodies.push(body);
      packet += 1;
      return { packetId: `p${packet}`, delivered: targets.map((t) => t.displayName), failed: [] };
    },
    cancelPeerConversations: (lane) => {
      cancels += 1;
      if ((lane as unknown as FakeLane).status === 'awaiting_peer') setStatus(lane as unknown as FakeLane, 'idle');
    },
    pendingPeerCount: () => 0,
    loopChanged: () => {
      changes += 1;
    },
    recordReviewOutcome: (_lane, outcome) => outcomes.push({ blockers: outcome.blockers, subjectLabel: outcome.subjectLabel }),
  };
  const ctl = new HarnessReviewLoopController(host);
  ctl.subscribe();
  /** The reviewer answers the current round; the coordinator settles the author to idle. */
  const answer = async (message: string): Promise<void> => {
    setStatus(author, 'idle');
    ctl.onHarnessReply(author.id, { packetId: `p${packet}`, fromLaneId: reviewer.id, fromDisplayName: 'Grok-1', message });
    await flush();
  };
  return {
    ctl,
    author: author as unknown as HarnessLane,
    authorFake: author,
    reviewer,
    setStatus,
    rows,
    flashes,
    bodies,
    turns,
    outcomes,
    answer,
    cancels: () => cancels,
    changes: () => changes,
    bus,
  };
}

const FAIL = '### Blockers\n- src/a.ts:3 — off by one\nVERDICT: FAIL';
const PASS = 'VERDICT: PASS';

describe('HarnessReviewLoopController (spec 276)', () => {
  it('fans out, passes in one round, and writes one summary', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    expect(t.bodies).toHaveLength(1);
    expect(t.authorFake.status).toBe('awaiting_peer');
    expect(t.ctl.chipPrefix(t.author.id)).toBe('review pass 1/3');

    await t.answer(PASS);

    expect(t.outcomes).toEqual([{ blockers: 0, subjectLabel: '1 file changed, +1 / -0 · pass 1/3' }]);
    expect(t.turns.map((turn) => turn.label)).toEqual(['review pass summary']);
    expect(t.turns[0]?.text).toContain('every reviewer passed in round 1 of 3');
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('sends Blockers to a fix turn, re-reviews with the previous round, then passes', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    await t.answer(FAIL);

    expect(t.turns.map((turn) => turn.label)).toEqual(['fixing 1/3']);
    expect(t.turns[0]?.text).toContain('src/a.ts:3 — off by one');
    expect(t.bodies).toHaveLength(2);
    expect(t.bodies[1]).toContain("Previous round's Blockers (round 1)");

    await t.answer(PASS);

    expect(t.outcomes.map((o) => o.blockers)).toEqual([1, 0]);
    expect(t.turns.map((turn) => turn.label)).toEqual(['fixing 1/3', 'review pass summary']);
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('stops with no_change when the fix left the subject identical', async () => {
    const t = setup([diffResult('+a'), diffResult('+a')]);
    await t.ctl.start(t.author, []);
    await t.answer(FAIL);
    await flush();

    expect(t.bodies).toHaveLength(1);
    expect(t.turns.map((turn) => turn.label)).toEqual(['fixing 1/3', 'review pass summary']);
    expect(t.turns[1]?.text).toContain('`no_change`');
    expect(t.authorFake.status).toBe('idle');
  });

  it('#review stop before any round completes cancels the requests and writes no summary', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    t.ctl.stop(t.author);
    await flush();

    expect(t.cancels()).toBe(1);
    expect(t.turns).toEqual([]);
    expect(last(t.rows)).toBe('review pass · ended: stopped by #review stop');
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('#cancel ends the loop with no summary and ignores late replies', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    t.ctl.onLaneCancelled(t.author.id);
    await t.answer(PASS);

    expect(t.cancels()).toBe(1);
    expect(t.turns).toEqual([]);
    expect(t.outcomes).toEqual([]);
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('#cancel withdraws the review requests even when a user prompt made the lane busy', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    t.setStatus(t.authorFake, 'busy');
    t.ctl.onLaneCancelled(t.author.id);

    expect(t.cancels()).toBe(1);
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('#cancel while waiting to fix has no review requests to withdraw', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    // The round is complete, but the author is not idle yet — the fix turn waits.
    t.ctl.onHarnessReply(t.author.id, { packetId: 'p1', fromLaneId: t.reviewer.id, fromDisplayName: 'Grok-1', message: FAIL });
    await flush();
    t.ctl.onLaneCancelled(t.author.id);
    await flush();

    expect(t.cancels()).toBe(0);
    expect(t.turns).toEqual([]);
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('withdraws the review requests when the authoring lane errors mid-round', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    t.setStatus(t.authorFake, 'error');
    await flush();

    expect(t.cancels()).toBe(1);
    expect(t.authorFake.status).toBe('error');
    expect(t.turns).toEqual([]);
    expect(last(t.rows)).toBe('review pass · ended: the lane stopped');
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('has nothing to withdraw once every reviewer replied', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    await t.answer(PASS);

    expect(t.cancels()).toBe(0);
  });

  it('ends with reviewer_lost when a reviewer stops mid-round', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    t.setStatus(t.reviewer, 'stopped');
    await flush();

    expect(t.cancels()).toBe(1);
    expect(last(t.rows)).toBe('review pass · ended: a reviewer is no longer available');
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('releases the reserved lane when the subject cannot be collected', async () => {
    const t = setup([{ error: '#review: no git repo in lane cwd' }]);
    await t.ctl.start(t.author, []);

    expect(t.authorFake.status).toBe('idle');
    expect(t.flashes).toContain('#review: no git repo in lane cwd');
    expect(t.ctl.isRunning(t.author.id)).toBe(false);
  });

  it('refuses a second loop on the same lane and a bad round limit', async () => {
    const t = setup();
    await t.ctl.start(t.author, ['9']);
    expect(last(t.flashes)).toBe('#review pass: rounds must be 1–8');
    await t.ctl.start(t.author, []);
    t.setStatus(t.authorFake, 'idle');
    await t.ctl.start(t.author, []);
    expect(last(t.flashes)).toBe('#review: loop already running — #review stop');
  });
});

describe('HarnessReviewLoopController telemetry (spec 277)', () => {
  it('projects the running loop: phase, pending and replied reviewers', async () => {
    const t = setup();
    expect(t.ctl.telemetry(t.author.id)).toBeNull();
    await t.ctl.start(t.author, []);

    const reviewing = t.ctl.telemetry(t.author.id);
    expect(reviewing).toMatchObject({ running: true, phase: 'reviewing', round: 1, maxRounds: 3, rounds: [] });
    expect(reviewing?.reviewers).toEqual([
      { name: 'Grok-1', state: 'pending', verdict: null, blockers: 0, repliedAt: null },
    ]);

    const before = t.changes();
    t.ctl.onHarnessReply(t.author.id, { packetId: 'p1', fromLaneId: t.reviewer.id, fromDisplayName: 'Grok-1', message: FAIL });
    expect(t.changes()).toBeGreaterThan(before);
    await flush();

    const fixing = t.ctl.telemetry(t.author.id);
    expect(fixing?.phase).toBe('fixing');
    expect(fixing?.reviewers[0]).toMatchObject({ state: 'replied', verdict: 'fail', blockers: 1 });
    expect(fixing?.reviewers[0]?.repliedAt).toEqual(expect.any(Number));
    expect(fixing?.rounds).toEqual([{ round: 1, verdict: 'fail', blockers: 1, warnings: 0 }]);
  });

  it('keeps the ended loop until the next one starts, and drops it when the lane closes', async () => {
    const t = setup();
    await t.ctl.start(t.author, []);
    await t.answer(PASS);

    const ended = t.ctl.telemetry(t.author.id);
    expect(ended).toMatchObject({
      running: false,
      phase: null,
      stopReason: 'pass',
      stopLabel: 'every reviewer passed',
      rounds: [{ round: 1, verdict: 'pass', blockers: 0, warnings: 0 }],
    });
    expect(ended?.endedAt).toEqual(expect.any(Number));

    await t.ctl.start(t.author, []);
    expect(t.ctl.telemetry(t.author.id)?.running).toBe(true);
    t.ctl.onLaneCancelled(t.author.id);
    expect(t.ctl.telemetry(t.author.id)).toMatchObject({ running: false, stopReason: 'cancelled', rounds: [] });
    // Cancelled mid-round: the reviewer never replied.
    expect(t.ctl.telemetry(t.author.id)?.reviewers[0]?.state).toBe('pending');

    t.bus.emit({ type: 'lane:closed', payload: { laneId: t.author.id, displayName: 'Claude-1' } });
    expect(t.ctl.telemetry(t.author.id)).toBeNull();
  });
});
