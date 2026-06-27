import { describe, expect, it } from 'vitest';
import { ReviewPriorityStore } from './review-priority-store';
import { LaneBus } from './lane-bus';
import type { LaneBusEvent, ReviewPriorityRange } from './types';

function range(
  file: string,
  lineStart: number,
  lineEnd: number,
  level: 'high' | 'routine',
  reason?: string,
): ReviewPriorityRange {
  return { file, lineStart, lineEnd, level, reason };
}

describe('ReviewPriorityStore', () => {
  it('counts only `high` ranges across lanes', () => {
    const store = new ReviewPriorityStore();
    expect(store.highCount()).toBe(0);
    store.record('lane-1', [range('a.ts', 1, 5, 'high'), range('a.ts', 9, 9, 'routine')]);
    store.record('lane-2', [range('b.ts', 2, 4, 'high'), range('b.ts', 6, 8, 'high')]);
    expect(store.highCount()).toBe(3);
    expect(store.lanesWithReports().sort()).toEqual(['lane-1', 'lane-2']);
  });

  it('highCountFor returns one lane\'s high count (0 for an unknown lane)', () => {
    const store = new ReviewPriorityStore();
    store.record('lane-1', [range('a.ts', 1, 5, 'high'), range('a.ts', 9, 9, 'routine')]);
    store.record('lane-2', [range('b.ts', 2, 4, 'high'), range('b.ts', 6, 8, 'high')]);
    expect(store.highCountFor('lane-1')).toBe(1);
    expect(store.highCountFor('lane-2')).toBe(2);
    expect(store.highCountFor('nobody')).toBe(0);
  });

  it('latest report per lane wins (replaces, not appends)', () => {
    const store = new ReviewPriorityStore();
    store.record('lane-1', [range('a.ts', 1, 5, 'high')]);
    store.record('lane-1', [range('a.ts', 1, 5, 'routine'), range('a.ts', 7, 9, 'high')]);
    expect(store.reportFor('lane-1')?.ranges).toHaveLength(2);
    expect(store.highCount()).toBe(1);
  });

  it('an empty report clears the lane', () => {
    const store = new ReviewPriorityStore();
    store.record('lane-1', [range('a.ts', 1, 5, 'high')]);
    store.record('lane-1', []);
    expect(store.reportFor('lane-1')).toBeUndefined();
    expect(store.lanesWithReports()).toEqual([]);
  });

  it('allRanges merges every lane for the diff pull', () => {
    const store = new ReviewPriorityStore();
    store.record('lane-1', [range('a.ts', 1, 5, 'high')]);
    store.record('lane-2', [range('b.ts', 2, 4, 'routine')]);
    expect(store.allRanges()).toHaveLength(2);
  });

  it('preserves optional reasons for overlay and diff panel rendering', () => {
    const store = new ReviewPriorityStore();
    store.record('lane-1', [
      range('a.ts', 1, 5, 'high', 'Core routing path for peer mail.'),
    ]);
    expect(store.reportFor('lane-1')?.ranges[0].reason).toBe('Core routing path for peer mail.');
    expect(store.allRanges()[0].reason).toBe('Core routing path for peer mail.');
  });

  it('drops a closed lane and re-emits the high count', () => {
    const bus = new LaneBus();
    const events: LaneBusEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new ReviewPriorityStore(bus);
    store.record('lane-1', [range('a.ts', 1, 5, 'high')]);
    store.record('lane-2', [range('b.ts', 2, 4, 'high')]);
    store.onLaneClosed('lane-1');
    expect(store.highCount()).toBe(1);
    // onLaneClosed for an unknown lane is a no-op (no extra emit).
    store.onLaneClosed('lane-1');
    const counts = events
      .filter(
        (e): e is Extract<LaneBusEvent, { type: 'review:priority' }> => e.type === 'review:priority',
      )
      .map((e) => e.payload.highCount);
    expect(counts).toEqual([1, 2, 1]); // two records, one close
  });

  it('emits review:priority on each effective change, not on a no-op clear', () => {
    const bus = new LaneBus();
    const events: LaneBusEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new ReviewPriorityStore(bus);
    store.record('lane-1', [range('a.ts', 1, 5, 'high')]);
    store.record('lane-2', []); // clearing a lane that never reported — no emit
    const changes = events.filter((e) => e.type === 'review:priority');
    expect(changes).toHaveLength(1);
  });
});
