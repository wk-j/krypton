import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { poll } from './poll';
import type { PollStatus } from './poll';

describe('poll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never runs two loads at once and skips an unchanged value', async () => {
    let resolve: (value: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const apply = vi.fn();
    const poller = poll({ load, apply, signature: (v) => v });
    const again = poller.refresh();
    expect(load).toHaveBeenCalledOnce();
    resolve('a');
    await again;
    expect(apply).toHaveBeenCalledWith('a');

    void poller.refresh();
    resolve('a');
    await poller.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledOnce();
    poller.dispose();
  });

  it('reports reconnecting on a failure and ok once a load succeeds again', async () => {
    const statuses: PollStatus[] = [];
    let fail = true;
    const poller = poll({
      load: async () => {
        if (fail) throw new Error('down');
        return 1;
      },
      apply: () => {},
      onStatus: (status) => statuses.push(status),
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses).toEqual(['loading', 'reconnecting', 'ok']);
    poller.dispose();
  });

  it('stops polling while the tab is hidden and loads again on return', async () => {
    const load = vi.fn(async () => 1);
    const poller = poll({ load, apply: () => {}, intervalMs: 1000, minGapMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    poller.dispose();
  });
});
