// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entry } from '../test-fixtures';
import type { PreviewOutput } from '../types';
import { PreviewController } from './controller';
import type { PreviewRenderer, PreviewTarget } from './registry';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup() {
  const shown: PreviewOutput[] = [];
  const resets = { n: 0 };
  const pending: Array<{ path: string; resolve: () => void }> = [];
  const slow: PreviewRenderer = {
    id: 'slow',
    sources: ['cursor', 'search'],
    matches: () => true,
    render: (t) => new Promise((resolve) => {
      pending.push({ path: t.path, resolve: () => resolve({ kind: 'text', text: t.path }) });
    }),
  };
  const ctl = new PreviewController(
    { show: (o) => shown.push(o), resetScroll: () => { resets.n++; } },
    () => ({ readText: async () => '', listDirectory: async () => [] }),
    [slow],
  );
  return { ctl, shown, resets, pending };
}

const target = (name: string, source: 'cursor' | 'search' = 'cursor'): PreviewTarget => {
  const e = entry(name);
  return { source, path: e.path, name, entry: source === 'cursor' ? e : null, showHidden: false };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PreviewController', () => {
  it('coalesces requests within the 80 ms debounce and reads the target late', async () => {
    const { ctl, pending } = setup();
    let current = 'a';
    ctl.requestCursor(() => target(current));
    vi.advanceTimersByTime(50);
    ctl.requestCursor(() => target(current));
    current = 'b';
    vi.advanceTimersByTime(79);
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await settle();
    expect(pending.map((p) => p.path)).toEqual(['/r/b']);
  });

  it('discards a stale generation', async () => {
    const { ctl, shown, pending } = setup();
    ctl.requestCursor(() => target('a'));
    vi.advanceTimersByTime(80);
    await settle();
    ctl.requestSearch(target('b', 'search'));
    vi.advanceTimersByTime(80);
    await settle();
    pending[0].resolve();
    pending[1].resolve();
    await settle();
    expect(shown).toEqual([{ kind: 'text', text: '/r/b' }]);
  });

  it('skips the same cursor path but never a search path', async () => {
    const { ctl, pending, resets } = setup();
    for (let i = 0; i < 2; i++) {
      ctl.requestCursor(() => target('a'));
      vi.advanceTimersByTime(80);
      await settle();
    }
    expect(pending).toHaveLength(1);
    expect(resets.n).toBe(1);
    for (let i = 0; i < 2; i++) {
      ctl.requestSearch(target('a', 'search'));
      vi.advanceTimersByTime(80);
      await settle();
    }
    expect(pending).toHaveLength(3);
    expect(resets.n).toBe(1);
  });

  it('paints blank with no entry under the cursor', async () => {
    const { ctl, shown } = setup();
    ctl.requestCursor(() => null);
    vi.advanceTimersByTime(80);
    await settle();
    expect(shown).toEqual([{ kind: 'text', text: '' }]);
  });

  it('clear() blanks the pane but does not bump the generation (P9)', async () => {
    const { ctl, shown, pending } = setup();
    ctl.requestCursor(() => target('a'));
    vi.advanceTimersByTime(80);
    await settle();
    ctl.clear();
    pending[0].resolve();
    await settle();
    expect(shown).toEqual([{ kind: 'text', text: '' }, { kind: 'text', text: '/r/a' }]);
  });

  it('dispose() cancels the debounce', () => {
    const { ctl } = setup();
    ctl.requestCursor(() => target('a'));
    expect(vi.getTimerCount()).toBe(1);
    ctl.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
