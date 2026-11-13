import type { ContentView } from '../types';

/** Read-only count aggregation. No status labels, polling, or permission actions. */
export class PermissionBackgroundController {
  private views = new Map<ContentView, () => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued = false;
  private disposed = false;
  private active = false;
  constructor(private readonly changed: (active: boolean) => void) {}

  register(view: ContentView): void {
    if (this.disposed || this.views.has(view) || !view.getPendingPermissionCount || !view.onPendingPermissionCountChange) return;
    // Subscribe first, then read (in a microtask after synchronous policy dispatch).
    this.views.set(view, view.onPendingPermissionCountChange(() => this.schedule()));
    this.schedule();
  }
  unregister(view: ContentView): void {
    this.views.get(view)?.();
    this.views.delete(view);
    this.schedule();
  }
  private schedule(): void {
    if (this.queued || this.disposed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed) return;
      const positive = [...this.views.keys()].some((view) => (view.getPendingPermissionCount?.() ?? 0) > 0);
      if (!positive) {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.setActive(false);
      } else if (!this.active && this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.disposed && [...this.views.keys()].some((view) => (view.getPendingPermissionCount?.() ?? 0) > 0)) this.setActive(true);
        }, 150);
      }
    });
  }
  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.changed(active);
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const unsubscribe of this.views.values()) unsubscribe();
    this.views.clear();
    this.setActive(false);
  }
}
