// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyChord, NORMAL_KEYMAP, dispatchNormalKey, type KeyCtx } from './keymap';
import { createState } from './state';
import { entry, key } from './test-fixtures';

type Call = [string, ...unknown[]];

function fakeCtx(): { ctx: KeyCtx; calls: Call[] } {
  const calls: Call[] = [];
  const state = createState('/r');
  state.filtered = [entry('a'), entry('b'), entry('c')];
  state.visibleRows = 10;
  const ctx = new Proxy({ state, chord: new KeyChord() } as unknown as KeyCtx, {
    get(target, prop: string) {
      if (prop in target) return (target as unknown as Record<string, unknown>)[prop];
      return (...args: unknown[]) => { calls.push([prop, ...args]); };
    },
  });
  return { ctx, calls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('NORMAL_KEYMAP', () => {
  it('binds no key twice and has unique ids', () => {
    const keys = NORMAL_KEYMAP.flatMap((b) => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = NORMAL_KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each<[string, { ctrl?: boolean; shift?: boolean }, Call]>([
    ['j', {}, ['moveCursor', 1]],
    ['ArrowDown', {}, ['moveCursor', 1]],
    ['k', {}, ['moveCursor', -1]],
    ['ArrowUp', {}, ['moveCursor', -1]],
    ['l', {}, ['enterSelected']],
    ['Enter', {}, ['enterSelected']],
    ['h', {}, ['goParent']],
    ['Backspace', {}, ['goParent']],
    ['G', {}, ['jumpTo', 2, 'clamp']],
    ['J', {}, ['scrollPreview', 80]],
    ['K', {}, ['scrollPreview', -80]],
    ['H', {}, ['resizeSplit', -5]],
    ['L', {}, ['resizeSplit', 5]],
    ['d', { ctrl: true }, ['moveCursor', 5]],
    ['u', { ctrl: true }, ['moveCursor', -5]],
    ['/', {}, ['startFilter']],
    ['q', {}, ['close']],
    ['Escape', {}, ['clearMarks']],
    ['.', {}, ['toggleHidden']],
    ['s', {}, ['cycleSort']],
    ['s', { shift: true }, ['reverseSort']],
    [' ', {}, ['toggleMark']],
    ['v', {}, ['toggleMarkAll']],
    ['y', {}, ['yank', 'copy']],
    ['x', {}, ['yank', 'cut']],
    ['D', {}, ['deleteSelection']],
    ['r', {}, ['rename']],
    ['A', {}, ['promptCreateFile']],
    ['M', {}, ['promptCreateDir']],
    ['~', {}, ['goHome']],
    ['-', {}, ['goBack']],
    ['p', {}, ['paste']],
    ['o', {}, ['openPreview']],
    ['w', {}, ['togglePreview']],
    ['Y', {}, ['copyPath']],
    ['i', {}, ['openAI']],
    ['t', {}, ['track']],
    ['T', {}, ['openTrackedDiff']],
    ['f', {}, ['startSearch']],
  ])('%s %o → %o', (k, mods, call) => {
    const { ctx, calls } = fakeCtx();
    expect(dispatchNormalKey(NORMAL_KEYMAP, ctx, key(k, mods))).toBe(true);
    expect(calls).toEqual([call]);
  });

  it('d / u without ctrl are unhandled; S is unbound (P4)', () => {
    const { ctx, calls } = fakeCtx();
    expect(dispatchNormalKey(NORMAL_KEYMAP, ctx, key('d'))).toBe(false);
    expect(dispatchNormalKey(NORMAL_KEYMAP, ctx, key('u'))).toBe(false);
    expect(dispatchNormalKey(NORMAL_KEYMAP, ctx, key('S', { shift: true }))).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('gg chord', () => {
  it('fires within 500 ms, not after', () => {
    const { ctx, calls } = fakeCtx();
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('g'));
    vi.setSystemTime(499);
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('g'));
    expect(calls).toEqual([['jumpTo', 0, 'reset-scroll']]);
    calls.length = 0;
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('g'));
    vi.setSystemTime(1100);
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('g'));
    expect(calls).toEqual([]);
  });

  it('an unbound key clears the chord, a bound one does not (P3)', () => {
    const { ctx, calls } = fakeCtx();
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('g'));
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('Z'));
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('g'));
    expect(calls).toEqual([]);
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('d'));
    dispatchNormalKey(NORMAL_KEYMAP, ctx, key('g'));
    expect(calls).toEqual([['jumpTo', 0, 'reset-scroll']]);
  });
});
