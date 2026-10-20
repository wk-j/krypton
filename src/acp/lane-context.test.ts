import { describe, expect, it } from 'vitest';

import {
  COMPACTION_MIN_USED,
  POLICY_REFRESH_TURNS,
  hashPolicy,
  isCompactionDrop,
  planPolicyDelivery,
  renderToolIndex,
  renderToolNameLine,
  type PolicyDelivery,
} from './lane-context';

/** Run `turns` consecutive turns with an unchanged policy; returns which turns sent it (1-based). */
function sendTurns(turns: number, hash = hashPolicy('policy')): number[] {
  let state: PolicyDelivery | null = null;
  const sent: number[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const plan = planPolicyDelivery(state, hash);
    if (plan.send) sent.push(turn);
    state = plan.next;
  }
  return sent;
}

describe('planPolicyDelivery', () => {
  it('sends on turn 1, stays header-only through turn 20, refreshes on turn 21', () => {
    expect(POLICY_REFRESH_TURNS).toBe(20);
    expect(sendTurns(41)).toEqual([1, 21, 41]);
  });

  it('resends immediately when the policy text changes, and restarts the refresh count', () => {
    const a = hashPolicy('roster: A');
    const b = hashPolicy('roster: A, B');
    let state = planPolicyDelivery(null, a).next;
    state = planPolicyDelivery(state, a).next;
    const changed = planPolicyDelivery(state, b);
    expect(changed.send).toBe(true);
    expect(changed.next).toEqual({ hash: b, turnsSince: 0, stale: false });
  });

  it('resends a stale policy even when its text is unchanged', () => {
    const h = hashPolicy('policy');
    const sent = planPolicyDelivery(null, h).next;
    expect(planPolicyDelivery(sent, h).send).toBe(false);
    expect(planPolicyDelivery({ ...sent, stale: true }, h).send).toBe(true);
  });
});

describe('isCompactionDrop', () => {
  it('flags a fall of at least 40% from a substantial context', () => {
    expect(isCompactionDrop(100_000, 60_000)).toBe(true);
    expect(isCompactionDrop(100_000, 61_000)).toBe(false);
  });

  it('ignores small contexts, growth, and missing readings', () => {
    expect(isCompactionDrop(COMPACTION_MIN_USED - 1, 0)).toBe(false);
    expect(isCompactionDrop(50_000, 80_000)).toBe(false);
    expect(isCompactionDrop(null, 1_000)).toBe(false);
    expect(isCompactionDrop(100_000, null)).toBe(false);
  });
});

describe('tool advertising follows the tool gates', () => {
  it('names only the tools a solo local lane can call', () => {
    const gates = { timeline: true, timelineAutomaticRecording: true, timelinePendingCount: 0, peers: false, lessons: false };
    const names = renderToolNameLine(gates);
    expect(names).toContain('attention_flag');
    expect(names.split(': ').pop()?.replace(/\.$/, '').split(', ')).toEqual([
      'attention_flag', 'attention_resolve', 'mark_review_priority', 'artifact_new',
      'timeline_record', 'timeline_list', 'timeline_merge', 'timeline_pending_resolve',
      'timeline_conflict_list', 'timeline_conflict_record', 'timeline_conflict_checked',
    ]);
    expect(names).not.toContain('peer_send');
    expect(renderToolIndex(gates)).not.toContain('review_outcome');
  });

  it('keeps legacy tools advertised when new automatic intake is disabled', () => {
    const gates = { timeline: true, timelineAutomaticRecording: false, timelinePendingCount: 24, peers: true, lessons: false };
    expect(renderToolNameLine(gates)).toContain('timeline_pending_resolve');
    expect(renderToolNameLine(gates)).toContain('peer_send, peer_list, review_outcome');
    expect(renderToolIndex(gates)).toContain('review_outcome');
  });

  it('advertises the lesson tools only when the lessons gate is open', () => {
    const closed = { timeline: false, timelineAutomaticRecording: false, timelinePendingCount: 24, peers: false, lessons: false };
    expect(renderToolNameLine(closed)).not.toContain('lesson_record');
    expect(renderToolIndex(closed)).not.toContain('lesson_record');
    const open = { ...closed, lessons: true };
    expect(renderToolNameLine(open)).toContain('lesson_record, lesson_retire');
    expect(renderToolIndex(open)).toContain('- lesson_record / lesson_retire:');
  });

  it('delivers changed legacy counts on the next ordinary policy delivery', () => {
    const gates = { timeline: true, timelineAutomaticRecording: false, timelinePendingCount: 24, peers: false, lessons: false };
    const initial = hashPolicy(renderToolIndex(gates));
    const sent = planPolicyDelivery(null, initial).next;
    expect(planPolicyDelivery(sent, initial).send).toBe(false);
    const remaining = hashPolicy(renderToolIndex({ ...gates, timelinePendingCount: 23 }));
    expect(planPolicyDelivery(sent, remaining).send).toBe(true);
    expect(planPolicyDelivery(sent, hashPolicy(renderToolIndex({ ...gates, timelineAutomaticRecording: true }))).send).toBe(true);
  });

  it('does not deliver local Timeline maintenance to incapable lanes', () => {
    const gates = { timeline: false, timelineAutomaticRecording: false, timelinePendingCount: 24, peers: false, lessons: false };
    expect(renderToolNameLine(gates)).not.toContain('timeline_');
    expect(renderToolIndex(gates)).not.toContain('timeline_');
    expect(hashPolicy(renderToolIndex(gates))).toBe(hashPolicy(renderToolIndex({ ...gates, timelinePendingCount: 0 })));
  });
});
