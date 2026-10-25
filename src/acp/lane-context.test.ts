import { describe, expect, it } from 'vitest';

import {
  COMPACTION_MIN_USED,
  POLICY_REFRESH_TURNS,
  backendListsMcpTools,
  hashPolicy,
  isCompactionDrop,
  planPolicyDelivery,
  renderTimelinePendingLine,
  renderToolIndex,
  renderToolNameLine,
  type PolicyDelivery,
} from './lane-context';

/** Run `turns` consecutive turns with an unchanged policy; returns which turns sent it (1-based). */
function sendTurns(turns: number, hash = hashPolicy('policy')): number[] {
  let state: PolicyDelivery | null = null;
  const sent: number[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    const plan = planPolicyDelivery(state, hash, []);
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
    let state = planPolicyDelivery(null, a, []).next;
    state = planPolicyDelivery(state, a, []).next;
    const changed = planPolicyDelivery(state, b, []);
    expect(changed.send).toBe(true);
    expect(changed.next).toEqual({ hash: b, turnsSince: 0, stale: false, lessons: new Map() });
  });

  it('resends a stale policy even when its text is unchanged', () => {
    const h = hashPolicy('policy');
    const sent = planPolicyDelivery(null, h, []).next;
    expect(planPolicyDelivery(sent, h, []).send).toBe(false);
    expect(planPolicyDelivery({ ...sent, stale: true }, h, []).send).toBe(true);
  });

  it('turns a lesson change after the policy went out into a header delta (spec 332)', () => {
    const h = hashPolicy('policy');
    const a = { slug: 'a', rule: 'rule a' };
    const b = { slug: 'b', rule: 'rule b' };
    const added = planPolicyDelivery(planPolicyDelivery(null, h, [a]).next, h, [a, b]);
    expect(added.send).toBe(false);
    expect(added.lessons).toEqual({ changed: [b], retired: [] });
    expect(planPolicyDelivery(added.next, h, [a, b]).lessons).toBeNull();
    const edited = planPolicyDelivery(added.next, h, [{ slug: 'a', rule: 'rule a2' }]);
    expect(edited.send).toBe(false);
    expect(edited.lessons).toEqual({ changed: [{ slug: 'a', rule: 'rule a2' }], retired: ['b'] });
    expect(edited.next.turnsSince).toBe(2);
  });

  it('carries the current lessons on a full send, so no delta follows it', () => {
    const h = hashPolicy('policy');
    const a = { slug: 'a', rule: 'rule a' };
    const stale = { ...planPolicyDelivery(null, h, []).next, stale: true };
    const resent = planPolicyDelivery(stale, h, [a]);
    expect(resent.send).toBe(true);
    expect(resent.lessons).toBeNull();
    expect(planPolicyDelivery(resent.next, h, [a]).lessons).toBeNull();
  });
});

describe('backendListsMcpTools (spec 332)', () => {
  it('holds only for backends whose system prompt lists every MCP tool', () => {
    expect(backendListsMcpTools('omp')).toBe(true);
    for (const backend of ['claude', 'codex', 'pi-acp', 'cursor']) {
      expect(backendListsMcpTools(backend)).toBe(false);
    }
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

  it('keeps the legacy count out of the hashed policy and in a header line while above 0 (spec 332)', () => {
    const gates = { timeline: true, timelineAutomaticRecording: false, timelinePendingCount: 24, peers: false, lessons: false };
    const initial = hashPolicy(renderToolIndex(gates));
    const sent = planPolicyDelivery(null, initial, []).next;
    expect(planPolicyDelivery(sent, hashPolicy(renderToolIndex({ ...gates, timelinePendingCount: 23 })), []).send).toBe(false);
    expect(renderTimelinePendingLine(gates)).toContain('Timeline legacy pending: 24.');
    expect(renderTimelinePendingLine({ ...gates, timelinePendingCount: 23 })).toContain('Timeline legacy pending: 23.');
    expect(renderTimelinePendingLine({ ...gates, timelinePendingCount: 0 })).toBeNull();
    expect(planPolicyDelivery(sent, hashPolicy(renderToolIndex({ ...gates, timelineAutomaticRecording: true })), []).send).toBe(true);
  });

  it('does not deliver local Timeline maintenance to incapable lanes', () => {
    const gates = { timeline: false, timelineAutomaticRecording: false, timelinePendingCount: 24, peers: false, lessons: false };
    expect(renderToolNameLine(gates)).not.toContain('timeline_');
    expect(renderToolIndex(gates)).not.toContain('timeline_');
    expect(renderTimelinePendingLine(gates)).toBeNull();
  });
});
