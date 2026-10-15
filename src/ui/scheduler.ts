// Spec 301 — region invalidation.
//
// Replaces "call render() and hope": a mutation says which region it dirtied,
// the scheduler coalesces every invalidation in a frame and commits regions in
// a fixed order. A seal invalidates nothing, which is CLAUDE.md constraint 10's
// third sub-rule made structural.

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const rafScheduler: FrameScheduler = {
  request: (callback) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => callback())
      : (setTimeout(callback, 0) as unknown as number),
  cancel: (handle) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    else clearTimeout(handle);
  },
};

export class RenderScheduler<R extends string> {
  private readonly pending = new Set<R>();
  private readonly order: readonly R[];
  private readonly commit: (region: R) => void;
  private readonly frames: FrameScheduler;
  private frame: number | null = null;
  private disposed = false;

  constructor(order: readonly R[], commit: (region: R) => void, frames: FrameScheduler = rafScheduler) {
    this.order = order;
    this.commit = commit;
    this.frames = frames;
  }

  /** Coalesced into one frame, committed in the constructor's region order. */
  invalidate(region: R): void {
    if (this.disposed) return;
    this.pending.add(region);
    this.schedule();
  }

  invalidateAll(): void {
    if (this.disposed) return;
    for (const region of this.order) this.pending.add(region);
    this.schedule();
  }

  /**
   * Commit ONE region now and leave the rest pending.
   *
   * Scoped on purpose: a keystroke must not synchronously drag a pending
   * 'transcript' commit — a full tail-window reconcile — into the same frame.
   * That is the common case while a lane is busy, and exactly when the
   * keypress-to-render budget (constraint 8) matters.
   */
  flushSync(region: R): void {
    if (this.disposed) return;
    this.pending.delete(region);
    this.commit(region);
  }

  /** True while any region is waiting for its frame. Test/diagnostic seam. */
  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingRegions(): readonly R[] {
    return this.order.filter((region) => this.pending.has(region));
  }

  /** Commit everything pending right now, in region order. */
  flushAll(): void {
    if (this.disposed) return;
    this.cancelFrame();
    for (const region of this.order) {
      if (!this.pending.delete(region)) continue;
      this.commit(region);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFrame();
    this.pending.clear();
  }

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = this.frames.request(() => {
      this.frame = null;
      // A commit may dirty a region that already passed in this sweep; because
      // `frame` is cleared first, its invalidate() books the next frame.
      for (const region of this.order) {
        if (!this.pending.delete(region)) continue;
        this.commit(region);
      }
    });
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    this.frames.cancel(this.frame);
    this.frame = null;
  }
}
