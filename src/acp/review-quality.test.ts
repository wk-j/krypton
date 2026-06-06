import { describe, expect, it } from 'vitest';
import { ReviewQualityStore } from './review-quality';
import { LaneBus } from './lane-bus';
import type { LaneBusEvent, ReviewOutcome } from './types';

function outcome(
  authoringLaneId: string,
  blockers: number,
  warnings: number,
  at: number,
  subjectLabel = `subj-${at}`,
  reviewerCount = 2,
): Omit<ReviewOutcome, 'at'> & { at?: number } {
  return {
    authoringLaneId,
    authoringLaneName: authoringLaneId,
    subjectLabel,
    reviewerCount,
    blockers,
    warnings,
    at,
  };
}

describe('ReviewQualityStore', () => {
  it('keeps per-lane history newest-first', () => {
    const store = new ReviewQualityStore();
    store.record(outcome('lane-1', 5, 6, 100));
    store.record(outcome('lane-1', 2, 4, 200));
    store.record(outcome('lane-1', 0, 3, 300));
    const history = store.historyFor('lane-1');
    expect(history.map((o) => o.at)).toEqual([300, 200, 100]);
    expect(history.map((o) => o.blockers)).toEqual([0, 2, 5]);
  });

  it('isolates history per lane', () => {
    const store = new ReviewQualityStore();
    store.record(outcome('lane-1', 1, 1, 100));
    store.record(outcome('lane-2', 9, 9, 110));
    expect(store.historyFor('lane-1')).toHaveLength(1);
    expect(store.historyFor('lane-2')).toHaveLength(1);
    expect(store.historyFor('lane-2')[0].blockers).toBe(9);
    expect(store.lanesWithHistory().sort()).toEqual(['lane-1', 'lane-2']);
  });

  it('returns an empty array for a lane with no history', () => {
    const store = new ReviewQualityStore();
    expect(store.historyFor('nobody')).toEqual([]);
  });

  it('stamps `at` when the caller omits it', () => {
    const store = new ReviewQualityStore();
    const before = Date.now();
    const rec = store.record({
      authoringLaneId: 'lane-1',
      authoringLaneName: 'Claude-1',
      subjectLabel: 'x',
      reviewerCount: 1,
      blockers: 0,
      warnings: 0,
    });
    expect(rec.at).toBeGreaterThanOrEqual(before);
    expect(rec.authoringLaneName).toBe('Claude-1');
  });

  it('totalReviews sums across lanes', () => {
    const store = new ReviewQualityStore();
    expect(store.totalReviews()).toBe(0);
    store.record(outcome('lane-1', 0, 0, 1));
    store.record(outcome('lane-1', 0, 0, 2));
    store.record(outcome('lane-2', 0, 0, 3));
    expect(store.totalReviews()).toBe(3);
  });

  it('drops a closed lane and re-emits the count', () => {
    const bus = new LaneBus();
    const events: LaneBusEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new ReviewQualityStore(bus);
    store.record(outcome('lane-1', 1, 1, 1));
    store.record(outcome('lane-2', 1, 1, 2));
    store.onLaneClosed('lane-1');
    expect(store.historyFor('lane-1')).toEqual([]);
    expect(store.totalReviews()).toBe(1);
    // onLaneClosed for an unknown lane is a no-op (no extra emit).
    store.onLaneClosed('lane-1');
    const counts = events
      .filter((e): e is Extract<LaneBusEvent, { type: 'review:quality' }> => e.type === 'review:quality')
      .map((e) => e.payload.totalReviews);
    expect(counts).toEqual([1, 2, 1]); // two records, one close
  });

  it('emits review:quality on each record', () => {
    const bus = new LaneBus();
    const events: LaneBusEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new ReviewQualityStore(bus);
    store.record(outcome('lane-1', 0, 0, 1));
    const changes = events.filter((e) => e.type === 'review:quality');
    expect(changes).toHaveLength(1);
  });
});
