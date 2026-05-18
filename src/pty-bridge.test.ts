import { beforeEach, describe, expect, it } from 'vitest';

import { startPtyBridge, type AddressResolver } from './pty-bridge';
import { ViewBus } from './view-bus';
import type { SessionId } from './types';
import { ProgressState } from './types';
import type { ViewAddress } from './view-bus-types';

class FakeListener {
  private handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();

  listen = async <T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void> => {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (event: { payload: unknown }) => void);
    this.handlers.set(event, list);
    return () => {
      const current = this.handlers.get(event);
      if (!current) return;
      this.handlers.set(
        event,
        current.filter((h) => h !== (handler as unknown)),
      );
    };
  };

  fire(event: string, payload: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h({ payload });
  }
}

class FakeResolver implements AddressResolver {
  private map = new Map<SessionId, ViewAddress>();

  set(sid: SessionId, addr: ViewAddress): void {
    this.map.set(sid, addr);
  }

  addressFromSession(sid: SessionId): ViewAddress | null {
    return this.map.get(sid) ?? null;
  }
}

const addr = (sid: number): ViewAddress => ({
  viewId: `v${sid}`,
  role: 'terminal',
  windowId: `w${sid}`,
  tabId: `t${sid}`,
  paneId: `p${sid}`,
});

describe('pty-bridge', () => {
  let bus: ViewBus;
  let listener: FakeListener;
  let resolver: FakeResolver;
  let nowMs: number;

  beforeEach(() => {
    bus = new ViewBus({ isDev: false }); // release mode for less noise on bugs
    listener = new FakeListener();
    resolver = new FakeResolver();
    nowMs = 0;
  });

  const now = () => nowMs;

  it('drops events for unknown sessions', async () => {
    await startPtyBridge(bus, resolver, { listen: listener.listen, now });
    listener.fire('pty-output', [42, [1, 2, 3]]);
    listener.fire('pty-exit', 42);
    expect(bus.snapshot().signals).toHaveLength(0);
  });

  it('emits view:throughput at most once per 200ms window', async () => {
    resolver.set(1, addr(1));
    await startPtyBridge(bus, resolver, { listen: listener.listen, now });

    // First emit initializes lastEmitMs — won't fire until 200ms elapsed.
    listener.fire('pty-output', [1, new Array(100).fill(0)]);
    expect(bus.snapshot().signals).toHaveLength(0);

    nowMs = 250; // 250ms elapsed → emit
    listener.fire('pty-output', [1, new Array(50).fill(0)]);
    let snap = bus.snapshot().signals;
    expect(snap).toHaveLength(1);
    expect(snap[0].kind).toBe('view:throughput');
    // 150 bytes / 0.25s = 600 bytes/sec instantaneous, EMA α=0.3 of 600 = 180
    expect(snap[0].value).toBe(180);

    // Immediate second event → no emit (window not elapsed)
    nowMs = 300;
    listener.fire('pty-output', [1, new Array(200).fill(0)]);
    expect(bus.snapshot().signals).toHaveLength(1);

    nowMs = 500;
    listener.fire('pty-output', [1, [9]]);
    snap = bus.snapshot().signals;
    expect(snap).toHaveLength(2);
  });

  it('emits view:exit with null code on pty-exit', async () => {
    resolver.set(7, addr(7));
    await startPtyBridge(bus, resolver, { listen: listener.listen, now });
    listener.fire('pty-exit', 7);
    const snap = bus.snapshot().signals;
    expect(snap).toHaveLength(1);
    expect(snap[0].kind).toBe('view:exit');
    expect(snap[0].value).toEqual({ code: null });
  });

  it('emits view:progress with pct for Normal state', async () => {
    resolver.set(3, addr(3));
    await startPtyBridge(bus, resolver, { listen: listener.listen, now });
    listener.fire('pty-progress', { session_id: 3, state: ProgressState.Normal, progress: 42 });
    const snap = bus.snapshot().signals;
    expect(snap).toHaveLength(1);
    expect(snap[0].kind).toBe('view:progress');
    expect(snap[0].value).toEqual({ state: ProgressState.Normal, pct: 42 });
  });

  it('emits view:progress with null pct for Hidden state', async () => {
    resolver.set(3, addr(3));
    await startPtyBridge(bus, resolver, { listen: listener.listen, now });
    listener.fire('pty-progress', { session_id: 3, state: ProgressState.Hidden, progress: 0 });
    const snap = bus.snapshot().signals;
    expect(snap[0].value).toEqual({ state: ProgressState.Hidden, pct: null });
  });

  it('emits view:metrics on process-changed', async () => {
    resolver.set(9, addr(9));
    await startPtyBridge(bus, resolver, { listen: listener.listen, now });
    listener.fire('process-changed', {
      session_id: 9,
      process: { pid: 1234, name: 'zsh', cmdline: ['zsh', '-i'] },
      previous: null,
    });
    const snap = bus.snapshot().signals;
    expect(snap).toHaveLength(1);
    expect(snap[0].kind).toBe('view:metrics');
    expect(snap[0].value).toEqual({ pid: 1234, name: 'zsh', cmd: 'zsh -i' });
  });

  it('drops process-changed when process is null', async () => {
    resolver.set(9, addr(9));
    await startPtyBridge(bus, resolver, { listen: listener.listen, now });
    listener.fire('process-changed', { session_id: 9, process: null, previous: 'zsh' });
    expect(bus.snapshot().signals).toHaveLength(0);
  });

  it('stop() unsubscribes all listeners', async () => {
    resolver.set(1, addr(1));
    const handle = await startPtyBridge(bus, resolver, { listen: listener.listen, now });
    await handle.stop();
    nowMs = 1000;
    listener.fire('pty-output', [1, new Array(100).fill(0)]);
    listener.fire('pty-exit', 1);
    listener.fire('pty-progress', { session_id: 1, state: ProgressState.Normal, progress: 50 });
    expect(bus.snapshot().signals).toHaveLength(0);
  });
});
