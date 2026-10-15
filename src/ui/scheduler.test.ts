import { beforeEach, describe, expect, it } from 'vitest';

import { RenderScheduler, type FrameScheduler } from './scheduler';

type Region = 'rail' | 'transcript' | 'composer';
const ORDER: readonly Region[] = ['rail', 'transcript', 'composer'];

/** Manual frame pump: nothing commits until `frames.run()` is called. */
class ManualFrames implements FrameScheduler {
  private queue = new Map<number, () => void>();
  private next = 1;
  requested = 0;

  request(callback: () => void): number {
    this.requested += 1;
    const handle = this.next++;
    this.queue.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.queue.delete(handle);
  }

  run(): void {
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const callback of due) callback();
  }

  get depth(): number {
    return this.queue.size;
  }
}

let frames: ManualFrames;
let committed: Region[];

beforeEach(() => {
  frames = new ManualFrames();
  committed = [];
});

const make = (commit?: (region: Region) => void): RenderScheduler<Region> =>
  new RenderScheduler<Region>(
    ORDER,
    (region) => {
      committed.push(region);
      commit?.(region);
    },
    frames,
  );

describe('RenderScheduler', () => {
  it('coalesces repeated invalidations of a region into one commit', () => {
    const scheduler = make();
    scheduler.invalidate('transcript');
    scheduler.invalidate('transcript');
    scheduler.invalidate('transcript');

    expect(committed).toEqual([]);
    expect(frames.requested).toBe(1);

    frames.run();
    expect(committed).toEqual(['transcript']);
  });

  it('commits in the declared region order, not invalidation order', () => {
    const scheduler = make();
    scheduler.invalidate('composer');
    scheduler.invalidate('rail');
    scheduler.invalidate('transcript');

    frames.run();
    expect(committed).toEqual(['rail', 'transcript', 'composer']);
  });

  it('flushSync commits one region and leaves the rest pending', () => {
    const scheduler = make();
    scheduler.invalidate('transcript');
    scheduler.invalidate('composer');

    scheduler.flushSync('composer');

    expect(committed).toEqual(['composer']);
    expect(scheduler.pendingRegions()).toEqual(['transcript']);

    frames.run();
    expect(committed).toEqual(['composer', 'transcript']);
  });

  it('flushSync commits a region nobody invalidated', () => {
    const scheduler = make();
    scheduler.flushSync('composer');
    expect(committed).toEqual(['composer']);
    expect(scheduler.hasPending).toBe(false);
  });

  it('books a new frame when a commit dirties a region the sweep already passed', () => {
    const scheduler = make((region) => {
      if (region === 'composer') scheduler.invalidate('rail');
    });
    scheduler.invalidate('composer');

    frames.run();
    expect(committed).toEqual(['composer']);
    expect(scheduler.pendingRegions()).toEqual(['rail']);

    frames.run();
    expect(committed).toEqual(['composer', 'rail']);
  });

  it('dispose drops the pending frame and ignores later invalidations', () => {
    const scheduler = make();
    scheduler.invalidate('transcript');
    scheduler.dispose();

    frames.run();
    scheduler.invalidate('rail');
    frames.run();

    expect(committed).toEqual([]);
    expect(frames.depth).toBe(0);
  });

  it('invalidateAll queues every region exactly once', () => {
    const scheduler = make();
    scheduler.invalidateAll();
    scheduler.invalidate('rail');

    frames.run();
    expect(committed).toEqual(['rail', 'transcript', 'composer']);
  });
});
