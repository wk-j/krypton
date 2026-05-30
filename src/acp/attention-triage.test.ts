import { describe, expect, it } from 'vitest';
import { AttentionTriageStore, compareJudgement } from './attention-triage';
import { LaneBus } from './lane-bus';
import type { JudgementItem, LaneBusEvent, Reversibility } from './types';

function makeItem(
  id: string,
  laneId: string,
  reversibility: Reversibility,
  createdAt: number,
): JudgementItem {
  return {
    id,
    laneId,
    question: `q-${id}`,
    chosen: 'chose A',
    rationale: 'because A',
    tradedOff: ['B: slower'],
    uncertainty: 'unsure about C',
    reversibility,
    packetId: null,
    diffstat: [],
    createdAt,
    status: 'open',
  };
}

describe('AttentionTriageStore ranking', () => {
  it('ranks irreversible > costly > reversible, ties oldest-first', () => {
    const store = new AttentionTriageStore();
    store.equip('lane-1');
    store.insert(makeItem('a', 'lane-1', 'reversible', 100));
    store.insert(makeItem('b', 'lane-1', 'irreversible', 200));
    store.insert(makeItem('c', 'lane-1', 'costly', 150));
    store.insert(makeItem('d', 'lane-1', 'irreversible', 50)); // older irreversible
    const ids = store.openItems().map((i) => i.id);
    expect(ids).toEqual(['d', 'b', 'c', 'a']);
  });

  it('compareJudgement is a stable total order', () => {
    const older = makeItem('x', 'l', 'costly', 1);
    const newer = makeItem('y', 'l', 'costly', 2);
    expect(compareJudgement(older, newer)).toBeLessThan(0);
  });
});

describe('AttentionTriageStore lifecycle', () => {
  it('accept/redirect dequeue; only open items transition', () => {
    const store = new AttentionTriageStore();
    store.equip('l');
    store.insert(makeItem('a', 'l', 'costly', 1));
    expect(store.accept('a')).toBe(true);
    expect(store.openCount()).toBe(0);
    expect(store.accept('a')).toBe(false); // already terminal
    expect(store.silentPile().map((i) => i.id)).toEqual(['a']);
  });

  it('self-resolve is a no-op once the human has discharged the item', () => {
    const store = new AttentionTriageStore();
    store.equip('l');
    store.insert(makeItem('a', 'l', 'costly', 1));
    store.accept('a');
    const res = store.selfResolve('a');
    expect(res).toEqual({ ok: true, dropped: true }); // terminal status wins
    expect(store.get('a')?.status).toBe('accepted');
  });

  it('self-resolve demotes an open item to the silent pile', () => {
    const store = new AttentionTriageStore();
    store.equip('l');
    store.insert(makeItem('a', 'l', 'costly', 1));
    expect(store.selfResolve('a')).toEqual({ ok: true, dropped: false });
    expect(store.openCount()).toBe(0);
    expect(store.get('a')?.status).toBe('self_resolved');
  });

  it('rejects a cross-lane self-resolve (only the owner lane may resolve)', () => {
    const store = new AttentionTriageStore();
    store.equip('owner');
    store.insert(makeItem('a', 'owner', 'costly', 1));
    const res = store.selfResolve('a', 'intruder');
    expect(res).toEqual({ ok: false, reason: 'not_owner', dropped: false });
    expect(store.get('a')?.status).toBe('open'); // untouched
    expect(store.selfResolve('a', 'owner').ok).toBe(true);
  });

  it('unknown item resolves to unknown_item', () => {
    const store = new AttentionTriageStore();
    expect(store.selfResolve('nope', 'l')).toEqual({
      ok: false,
      reason: 'unknown_item',
      dropped: true,
    });
  });

  it('setDiffstat late-binds blast-radius onto an open item', () => {
    const store = new AttentionTriageStore();
    store.equip('l');
    store.insert(makeItem('a', 'l', 'costly', 1));
    store.setDiffstat('a', [{ path: 'x.ts', status: 'M', added: 3, removed: 1 }], 'jpk-a');
    expect(store.get('a')?.diffstat).toHaveLength(1);
    expect(store.get('a')?.packetId).toBe('jpk-a');
  });
});

describe('AttentionTriageStore audit + bus', () => {
  it('counts flagged vs silent turns per equipped lane', () => {
    const store = new AttentionTriageStore();
    store.equip('l');
    store.insert(makeItem('a', 'l', 'costly', 1)); // flaggedCount→1
    store.recordTurnEnd('l', true); // flagged turn — no silent bump
    store.recordTurnEnd('l', false); // silent turn
    store.recordTurnEnd('l', false); // silent turn
    const stats = store.statsFor('l');
    expect(stats?.flaggedCount).toBe(1);
    expect(stats?.silentTurnCount).toBe(2);
  });

  it('does not track turns for unequipped lanes', () => {
    const store = new AttentionTriageStore();
    store.recordTurnEnd('ghost', false);
    expect(store.statsFor('ghost')).toBeNull();
  });

  it('emits triage:changed on insert and resolve', () => {
    const bus = new LaneBus();
    const events: LaneBusEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new AttentionTriageStore(bus);
    store.equip('l');
    store.insert(makeItem('a', 'l', 'costly', 1));
    store.accept('a');
    const changes = events.filter((e) => e.type === 'triage:changed');
    expect(changes.length).toBe(2);
    expect((changes[1] as { payload: { openCount: number } }).payload.openCount).toBe(0);
  });

  it('onLaneClosed drops the lane queue + audit row', () => {
    const store = new AttentionTriageStore();
    store.equip('l');
    store.insert(makeItem('a', 'l', 'costly', 1));
    store.onLaneClosed('l');
    expect(store.openCount()).toBe(0);
    expect(store.statsFor('l')).toBeNull();
    expect(store.isEquipped('l')).toBe(false);
  });
});
