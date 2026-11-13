import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContentView } from '../types';
import { PermissionBackgroundController } from './permission-controller';

function harness() {
  let count = 0;
  const listeners = new Set<() => void>();
  const view = {
    getPendingPermissionCount: () => count,
    onPendingPermissionCountChange: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  } as ContentView;
  return { view, listeners, set: (n: number) => { count = n; for (const cb of listeners) cb(); } };
}
const tick = async () => { await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('permission background controller', () => {
  it('requires 150ms, coalesces auto-policy churn and emits no runtime persistence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const changed = vi.fn();
    const ctl = new PermissionBackgroundController(changed);
    const a = harness(); ctl.register(a.view);
    a.set(1); a.set(0); await tick(); await vi.advanceTimersByTimeAsync(200);
    expect(changed).not.toHaveBeenCalled();
    a.set(1); await tick(); await vi.advanceTimersByTimeAsync(149);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenLastCalledWith(true);
    a.set(2); await tick(); await vi.advanceTimersByTimeAsync(300);
    expect(changed).toHaveBeenCalledTimes(1);
    a.set(0); await tick(); expect(changed).toHaveBeenLastCalledWith(false);
    ctl.dispose();
  });
  it('aggregates hidden views, keeps an override until the last queue clears, and drops disposal contributions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const changed = vi.fn(); const ctl = new PermissionBackgroundController(changed);
    const a = harness(); const b = harness();
    a.set(1); b.set(2); ctl.register(a.view); ctl.register(b.view); ctl.register(b.view);
    await tick(); await vi.advanceTimersByTimeAsync(150);
    expect(changed).toHaveBeenCalledTimes(1);
    a.set(0); b.set(1); await tick(); expect(changed).toHaveBeenCalledTimes(1);
    ctl.unregister(b.view); await tick(); expect(changed).toHaveBeenLastCalledWith(false);
    expect(b.listeners.size).toBe(0);
    ctl.dispose(); expect(a.listeners.size).toBe(0);
  });
  it('does not count status words, questions, OSC or other approval surfaces', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const changed = vi.fn(); const ctl = new PermissionBackgroundController(changed);
    ctl.register({ type: 'agent' } as ContentView);
    const a = harness(); Object.assign(a.view, { status: 'needs_permission', pendingQuestions: [{}], pendingCommandApprovals: [{}] });
    ctl.register(a.view); await tick(); await vi.advanceTimersByTimeAsync(200);
    expect(changed).not.toHaveBeenCalled(); ctl.dispose();
  });
  it('cancels short waits and all queued callbacks/timers on teardown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const changed = vi.fn(); const ctl = new PermissionBackgroundController(changed); const a = harness();
    ctl.register(a.view); a.set(1); await tick(); await vi.advanceTimersByTimeAsync(100);
    a.set(0); await tick(); await vi.advanceTimersByTimeAsync(100);
    expect(changed).not.toHaveBeenCalled();
    a.set(1); await tick(); ctl.dispose(); await vi.advanceTimersByTimeAsync(300);
    a.set(2); await tick(); expect(changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
