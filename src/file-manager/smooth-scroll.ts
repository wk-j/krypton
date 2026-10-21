// Krypton — File Manager smooth scrolling.
//
// Same easing as the diff view (docs/0243-diff-view-smooth-scrolling.md):
// each frame travels a fixed fraction of the remaining distance, snapping
// once within half a pixel. Held keys extend the active target instead of
// restarting the animation, so key repeat glides rather than stutters.

export const SCROLL_LERP = 0.24;
export const SCROLL_SNAP_PX = 0.5;

/** Advance one frame toward `target` without overshooting. */
export function smoothScrollStep(
  current: number,
  target: number,
  lerp: number = SCROLL_LERP,
  snapPx: number = SCROLL_SNAP_PX,
): { value: number; done: boolean } {
  const delta = target - current;
  const distance = Math.abs(delta);
  if (distance <= snapPx) return { value: target, done: true };

  const travel = Math.min(distance, Math.max(1, distance * lerp));
  const next = current + Math.sign(delta) * travel;
  if (Math.abs(target - next) <= snapPx) return { value: target, done: true };
  return { value: next, done: false };
}

/** Extend repeated movement in the same direction; reverse from the current position. Clamped to [0, max]. */
export function nextScrollTarget(
  current: number,
  activeTarget: number | null,
  delta: number,
  max: number,
): number {
  const activeDelta = activeTarget === null ? 0 : activeTarget - current;
  const continuing = activeDelta !== 0 && Math.sign(activeDelta) === Math.sign(delta);
  const base = continuing && activeTarget !== null ? activeTarget : current;
  return Math.max(0, Math.min(base + delta, Math.max(0, max)));
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Drives one rAF loop over a numeric scroll position. */
export class SmoothScroller {
  private target: number | null = null;
  private raf = 0;

  constructor(
    private readonly read: () => number,
    private readonly write: (v: number) => void,
    private readonly max: () => number,
  ) {}

  get active(): boolean {
    return this.target !== null;
  }

  by(delta: number): void {
    this.to(nextScrollTarget(this.read(), this.target, delta, this.max()));
  }

  to(target: number): void {
    const clamped = Math.max(0, Math.min(target, Math.max(0, this.max())));
    if (Math.abs(clamped - this.read()) <= SCROLL_SNAP_PX || prefersReducedMotion()) {
      this.cancel();
      this.write(clamped);
      return;
    }
    this.target = clamped;
    if (this.raf !== 0) return;
    this.raf = requestAnimationFrame(this.step);
  }

  cancel(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.target = null;
  }

  private readonly step = (): void => {
    this.raf = 0;
    if (this.target === null) return;
    const next = smoothScrollStep(this.read(), this.target);
    this.write(next.value);
    if (next.done) {
      this.target = null;
      return;
    }
    this.raf = requestAnimationFrame(this.step);
  };
}

// ─── virtual list glide ─────────────────────────────────────────────

/** Rows rendered beyond each edge of the viewport so a glide never shows blanks. */
export const LIST_OVERSCAN = 3;

/**
 * `[start, end)` of the rows to render around a (possibly fractional) top row.
 * `start` is even so `:nth-child(even)` striping stays fixed to the entry, not
 * the window, while the list glides.
 */
export function overscanRange(position: number, rows: number, len: number): [number, number] {
  let start = Math.max(0, Math.floor(position) - LIST_OVERSCAN);
  start -= start % 2;
  const end = Math.min(len, Math.ceil(position) + Math.max(0, rows) + LIST_OVERSCAN);
  return [Math.min(start, end), end];
}

/**
 * The animated top edge of a virtual list. The view owns one per list and calls
 * `sync()` with the logical `scrollOffset` on every render; `position` is the
 * fractional row the viewport currently shows. Each animation frame calls
 * `onFrame` (the view re-renders the window around the new position).
 *
 * Jumps further than one viewport, a cell-height change and `snapNext()` (new
 * listing / filter / mode switch) land immediately; `SmoothScroller` already
 * snaps under `prefers-reduced-motion`.
 */
export class ListGlide {
  private posPx = 0;
  private targetPx = 0;
  private cellPx = 0;
  private snapPending = true;
  private syncing = false;
  private readonly scroller: SmoothScroller;

  constructor(private readonly onFrame: () => void) {
    this.scroller = new SmoothScroller(
      () => this.posPx,
      (v) => {
        this.posPx = v;
        if (!this.syncing) this.onFrame();
      },
      () => Number.MAX_SAFE_INTEGER,
    );
  }

  /** Fractional top row currently on screen. */
  get position(): number {
    return this.cellPx > 0 ? this.posPx / this.cellPx : 0;
  }

  get active(): boolean {
    return this.scroller.active;
  }

  /** Cancel any glide; the next `sync()` lands without animating. */
  snapNext(): void {
    this.scroller.cancel();
    this.snapPending = true;
  }

  sync(row: number, visibleRows: number, cellPx: number): void {
    const targetPx = row * cellPx;
    if (this.snapPending || cellPx !== this.cellPx || Math.abs(row - this.position) > visibleRows) {
      this.scroller.cancel();
      this.snapPending = false;
      this.cellPx = cellPx;
      this.posPx = targetPx;
      this.targetPx = targetPx;
      return;
    }
    if (targetPx === this.targetPx) return;
    this.targetPx = targetPx;
    this.syncing = true;
    try {
      this.scroller.to(targetPx);
    } finally {
      this.syncing = false;
    }
  }

  dispose(): void {
    this.scroller.cancel();
  }
}
