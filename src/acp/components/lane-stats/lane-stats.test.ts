import { describe, expect, it } from 'vitest';

import type { HarnessLane } from '../../harness-view-types';
import { LaneStats } from './index';

function makeLane(over: Partial<HarnessLane> = {}): HarnessLane {
  return {
    id: 'lane-1',
    backendId: 'claude',
    displayName: 'Claude-1',
    status: 'idle',
    sessionId: null,
    usage: null,
    lastTurnTokens: null,
    toolCalls: new Map(),
    transcript: [],
    pendingPermissions: [],
    pendingQuestions: [],
    acceptAllForTurn: false,
    rejectAllForTurn: false,
    peerAutoAcceptForTurn: false,
    permissionMode: 'normal',
    pollyBuiltinRole: null,
    error: null,
    ...over,
  } as unknown as HarnessLane;
}

const cells = (stats: LaneStats): string[] => [...stats.el.children].map((node) => node.textContent ?? '');

describe('LaneStats', () => {
  it('emits bare sibling spans — the inline stats line, unchanged', () => {
    const stats = new LaneStats();
    stats.update({ lane: makeLane({ sessionId: '4f2a9c' }), projectDir: '/Users/wk/Source/krypton' });

    expect(stats.el.className).toBe('acp-harness__lane-stats');
    expect([...stats.el.children].every((node) => node.tagName === 'SPAN')).toBe(true);
    expect([...stats.el.children].every((node) => !node.hasAttribute('class'))).toBe(true);
    expect(cells(stats)).toEqual(['sess 4f2a9c', 'krypton', '0']);
    stats.dispose();
  });

  it('renders the context, cache, io, cost, tool and row cells with their titles', () => {
    const stats = new LaneStats();
    stats.update({
      lane: makeLane({
        sessionId: '4f2a9c',
        usage: { used: 128_400, size: 200_000, inputTokens: 12_400, outputTokens: 3_100, cost: { amount: 0.4412, currency: 'USD' } },
        lastTurnTokens: { input: 1_000, cachedRead: 9_000, cachedWrite: 300 },
        toolCalls: new Map([['a', {}], ['b', {}]]),
        transcript: [{}, {}, {}],
      } as unknown as Partial<HarnessLane>),
      projectDir: null,
    });

    const texts = cells(stats);
    expect(texts[0]).toBe('sess 4f2a9c');
    expect(texts[1]).toBe('128.4k/200.0k (64%)');
    expect(texts[2]).toMatch(/^cache \d/);
    expect(texts[3]).toBe('in 12.4k out 3.1k');
    expect(texts[4]).toBe('$0.4412 USD');
    expect(texts[5]).toBe('2');
    expect(texts[6]).toBe('3');
    expect(stats.el.children[1].getAttribute('title')).toBe('context 128.4k/200.0k (64%)');
    expect(stats.el.children[1].querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-gauge');
    expect(stats.el.children[5].querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-tool');
    expect(stats.el.children[6].querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-list');
    stats.dispose();
  });

  it('falls back to the raw read/write cache cell with its two arrow icons', () => {
    const stats = new LaneStats();
    stats.update({
      lane: makeLane({ usage: { used: 10, cachedReadTokens: 9_000, cachedWriteTokens: 300 } } as unknown as Partial<HarnessLane>),
      projectDir: null,
    });

    const cache = [...stats.el.children].find((node) => node.textContent?.startsWith('cache '));
    expect(cache?.getAttribute('title')).toBe('cache read 9.0k, write 300');
    expect([...(cache?.querySelectorAll('use') ?? [])].map((use) => use.getAttribute('href')))
      .toEqual(['#krypton-icon-dl', '#krypton-icon-ul']);
    expect(cache?.textContent).toBe('cache 9.0k300');
    stats.dispose();
  });

  it('appends the turn flags and the truncated error cell', () => {
    const stats = new LaneStats();
    stats.update({
      lane: makeLane({
        pendingPermissions: [{}] as unknown as HarnessLane['pendingPermissions'],
        pendingQuestions: [{}, {}] as unknown as HarnessLane['pendingQuestions'],
        acceptAllForTurn: true,
        peerAutoAcceptForTurn: true,
        pollyBuiltinRole: 'implementer',
        permissionMode: 'bypass',
        error: 'spawn failed',
      }),
      projectDir: null,
    });

    expect(cells(stats)).toEqual([
      'sess pending', '0', '1 perm', '2 ask', 'accept-all', 'peer-auto', 'polly-bypass', 'err: spawn failed',
    ]);
    stats.dispose();
  });

  it('writes nothing when no stat moved', () => {
    const stats = new LaneStats();
    const lane = makeLane({ sessionId: 'ses_1', usage: { used: 10, size: 100 } } as unknown as Partial<HarnessLane>);
    stats.update({ lane, projectDir: '/tmp/proj' });

    const first = stats.el.children[0];
    first.textContent = 'SENTINEL';
    stats.update({ lane, projectDir: '/tmp/proj' });
    expect(first.textContent).toBe('SENTINEL');
    stats.dispose();
  });

  it('keeps each cell node when a later cell changes', () => {
    const stats = new LaneStats();
    const lane = makeLane({ sessionId: 'ses_1', transcript: [{}] as unknown as HarnessLane['transcript'] });
    stats.update({ lane, projectDir: null });
    const sess = stats.el.children[0];
    const rows = stats.el.children[1];

    lane.transcript = [{}, {}] as unknown as HarnessLane['transcript'];
    stats.update({ lane, projectDir: null });
    expect(stats.el.children[0]).toBe(sess);
    expect(stats.el.children[1]).toBe(rows);
    expect(rows.textContent).toBe('2');
    stats.dispose();
  });

  it('removes the cells that fell away instead of leaving stale ones', () => {
    const stats = new LaneStats();
    const lane = makeLane({ error: 'boom' });
    stats.update({ lane, projectDir: null });
    expect(cells(stats)).toContain('err: boom');

    lane.error = null;
    stats.update({ lane, projectDir: null });
    expect(cells(stats)).toEqual(['sess pending', '0']);
    stats.dispose();
  });
});

// Spec 249, moved from `harness-lane-chrome.test.ts`, where it was asserted
// against `renderLaneStats`'s HTML string.
describe('LaneStats prompt-cache hit rate', () => {
  const cache = (stats: LaneStats): Element | undefined =>
    [...stats.el.children].find((node) => node.textContent?.startsWith('cache '));

  it('shows the coherent last-turn rate and keeps the counts in the tooltip', () => {
    const stats = new LaneStats();
    stats.update({
      lane: makeLane({
        sessionId: 'session-123',
        usage: { inputTokens: 1_200, outputTokens: 340, cachedReadTokens: 90_000 },
        lastTurnTokens: { input: 1_200, cachedRead: 90_000 },
      } as unknown as Partial<HarnessLane>),
      projectDir: '/Users/wk/Source/krypton',
    });

    expect(cache(stats)?.textContent).toBe('cache 99%');
    expect(cache(stats)?.getAttribute('title')).toBe('this turn 99% · read 90.0k · write 0 · input 1.2k');
    stats.dispose();
  });

  it('does not revive stale cache counts when the latest turn omitted them', () => {
    const stats = new LaneStats();
    stats.update({
      lane: makeLane({
        usage: { inputTokens: 1_200, outputTokens: 340, cachedReadTokens: 90_000 },
        lastTurnTokens: { input: 1_200 },
      } as unknown as Partial<HarnessLane>),
      projectDir: null,
    });

    expect(cache(stats)).toBeUndefined();
    stats.dispose();
  });
});
