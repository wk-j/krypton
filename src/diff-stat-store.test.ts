import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { DIFF_STAT_POLL_MS, DiffStatStore } from './diff-stat-store';
import type { WorkingDiffStat } from './window-footer-diff-stat';

const ROOT = '/Users/wk/Source/krypton';
const OTHER = '/Users/wk/Source/pi-mono';

const stat = (added: number, repoRoot = ROOT): WorkingDiffStat => ({
  repoRoot,
  files: 1,
  added,
  removed: 0,
  truncated: false,
});

/** Let queued microtasks (the awaited `invoke`) settle. */
const settle = (): Promise<void> => Promise.resolve().then(() => undefined);

describe('DiffStatStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    invoke.mockResolvedValue(stat(1));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches immediately on the first subscriber and notifies with the snapshot', async () => {
    const store = new DiffStatStore();
    const seen: (WorkingDiffStat | null)[] = [];
    store.subscribe(ROOT, () => seen.push(store.snapshot(ROOT)));

    expect(invoke).toHaveBeenCalledWith('working_diff_stat', { cwd: ROOT });
    await settle();
    expect(seen).toEqual([stat(1)]);
  });

  it('polls on an interval while subscribed, and stops with the last subscriber', async () => {
    const store = new DiffStatStore();
    const unsubscribe = store.subscribe(ROOT, () => undefined);
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DIFF_STAT_POLL_MS * 2);
    expect(invoke).toHaveBeenCalledTimes(3);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(DIFF_STAT_POLL_MS * 3);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('shares one timer across windows on the same repo', async () => {
    const store = new DiffStatStore();
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = store.subscribe(ROOT, first);
    store.subscribe(ROOT, second);
    await settle();

    // The second subscriber rides the first one's fetch — no extra git call.
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DIFF_STAT_POLL_MS);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();

    // One window closing leaves the other's poll running.
    unsubFirst();
    await vi.advanceTimersByTimeAsync(DIFF_STAT_POLL_MS);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('keeps repos independent', async () => {
    const store = new DiffStatStore();
    invoke.mockImplementation((_cmd: string, args: { cwd: string }) =>
      Promise.resolve(stat(args.cwd === ROOT ? 10 : 20, args.cwd)),
    );
    store.subscribe(ROOT, () => undefined);
    store.subscribe(OTHER, () => undefined);
    await settle();
    await settle();

    expect(store.snapshot(ROOT)?.added).toBe(10);
    expect(store.snapshot(OTHER)?.added).toBe(20);
  });

  it('single-flights concurrent fetches and runs exactly one trailing refresh', async () => {
    const store = new DiffStatStore();
    let resolveFirst: (value: WorkingDiffStat) => void = () => undefined;
    invoke.mockImplementationOnce(
      () => new Promise<WorkingDiffStat>((resolve) => (resolveFirst = resolve)),
    );

    store.subscribe(ROOT, () => undefined);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Two lane-idle signals land mid-flight: they coalesce into one follow-up.
    store.refresh(ROOT);
    store.refresh(ROOT);
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveFirst(stat(5));
    await settle();
    await settle();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('ignores a refresh for a repo nobody is watching', () => {
    const store = new DiffStatStore();
    store.refresh(ROOT);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('drops the readout when the git call fails, without throwing', async () => {
    const store = new DiffStatStore();
    const notified = vi.fn();
    store.subscribe(ROOT, notified);
    await settle();
    expect(store.snapshot(ROOT)).not.toBeNull();

    invoke.mockRejectedValueOnce(new Error('not a git repository'));
    store.refresh(ROOT);
    await settle();
    await settle();
    expect(store.snapshot(ROOT)).toBeNull();
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it('keeps the last snapshot after the final unsubscribe', async () => {
    const store = new DiffStatStore();
    const unsubscribe = store.subscribe(ROOT, () => undefined);
    await settle();
    unsubscribe();
    expect(store.snapshot(ROOT)).toEqual(stat(1));
  });

  it('stops polling while the app is hidden and refetches on return', async () => {
    let hidden = false;
    let notify: () => void = () => undefined;
    const store = new DiffStatStore({
      hidden: () => hidden,
      onChange: (listener) => (notify = listener),
    });
    store.subscribe(ROOT, () => undefined);
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);

    hidden = true;
    notify();
    await vi.advanceTimersByTimeAsync(DIFF_STAT_POLL_MS * 3);
    expect(invoke).toHaveBeenCalledTimes(1);

    hidden = false;
    notify();
    await settle();
    expect(invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DIFF_STAT_POLL_MS);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('does not start a poll for a window opened while the app is hidden', async () => {
    const store = new DiffStatStore({ hidden: () => true, onChange: () => undefined });
    store.subscribe(ROOT, () => undefined);
    await settle();

    // The initial fetch still runs — the window needs *a* number to render —
    // but no interval is armed behind a hidden app.
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DIFF_STAT_POLL_MS * 3);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
