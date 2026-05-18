import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewBus } from './view-bus';
import { SYSTEM_SOURCE, type ViewAddress } from './view-bus-types';

const addr = (overrides: Partial<ViewAddress> = {}): ViewAddress => ({
  viewId: 'v1',
  role: 'terminal',
  windowId: 'w1',
  tabId: 't1',
  paneId: 'p1',
  ...overrides,
});

const devBus = () => new ViewBus({ isDev: true });
const releaseBus = () => new ViewBus({ isDev: false });

describe('ViewBus signals', () => {
  let bus: ViewBus;
  beforeEach(() => {
    bus = devBus();
  });

  it('delivers signals to matching kind handlers synchronously', () => {
    const cb = vi.fn();
    bus.onSignal({ kind: 'view:state' }, cb);
    bus.publishSignal({ kind: 'view:state', source: addr(), value: 'busy' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].value).toBe('busy');
  });

  it('does not deliver to handlers of other kinds', () => {
    const cb = vi.fn();
    bus.onSignal({ kind: 'view:throughput' }, cb);
    bus.publishSignal({ kind: 'view:state', source: addr(), value: 'ok' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('filters by sourceRole', () => {
    const cb = vi.fn();
    bus.onSignal({ kind: 'view:state', sourceRole: 'agent' }, cb);
    bus.publishSignal({ kind: 'view:state', source: addr({ role: 'terminal' }), value: 'busy' });
    bus.publishSignal({ kind: 'view:state', source: addr({ role: 'agent' }), value: 'busy' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('filters by sourceViewId', () => {
    const cb = vi.fn();
    bus.onSignal({ kind: 'view:state', sourceViewId: 'v2' }, cb);
    bus.publishSignal({ kind: 'view:state', source: addr({ viewId: 'v1' }), value: 'busy' });
    bus.publishSignal({ kind: 'view:state', source: addr({ viewId: 'v2' }), value: 'busy' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].source.viewId).toBe('v2');
  });

  it('skips role/viewId-filtered handlers when source is the system', () => {
    const cb = vi.fn();
    bus.onSignal({ kind: 'system:focus-change', sourceRole: 'terminal' }, cb);
    bus.publishSignal({
      kind: 'system:focus-change',
      source: SYSTEM_SOURCE,
      value: { windowId: 'w1' },
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly', () => {
    const cb = vi.fn();
    const off = bus.onSignal({ kind: 'view:state' }, cb);
    off();
    bus.publishSignal({ kind: 'view:state', source: addr(), value: 'ok' });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('ViewBus intents', () => {
  let bus: ViewBus;
  beforeEach(() => {
    bus = devBus();
  });

  it('returns false when no handler consumes', () => {
    bus.onIntent({ kind: 'diff:open-file' }, () => {
      /* no return */
    });
    const consumed = bus.publishIntent({
      kind: 'diff:open-file',
      source: addr(),
      payload: { path: 'foo.ts' },
    });
    expect(consumed).toBe(false);
  });

  it('returns true when any handler returns consumed', () => {
    bus.onIntent({ kind: 'diff:open-file' }, () => ({ consumed: true }));
    const consumed = bus.publishIntent({
      kind: 'diff:open-file',
      source: addr(),
      payload: { path: 'foo.ts' },
    });
    expect(consumed).toBe(true);
  });

  it('returns false when no subscribers exist at all', () => {
    const consumed = bus.publishIntent({
      kind: 'webview:navigate',
      source: addr(),
      payload: { url: 'https://x' },
    });
    expect(consumed).toBe(false);
  });

  it('delivers to all subscribers regardless of consumed result', () => {
    const a = vi.fn(() => ({ consumed: false }));
    const b = vi.fn(() => ({ consumed: true }));
    const c = vi.fn();
    bus.onIntent({ kind: 'agent:add-context' }, a);
    bus.onIntent({ kind: 'agent:add-context' }, b);
    bus.onIntent({ kind: 'agent:add-context' }, c);
    const consumed = bus.publishIntent({
      kind: 'agent:add-context',
      source: addr(),
      payload: { text: 'hi' },
    });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(c).toHaveBeenCalled();
    expect(consumed).toBe(true);
  });
});

describe('ViewBus error handling', () => {
  it('continues calling handlers when one throws (release mode)', () => {
    const bus = releaseBus();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = vi.fn();
    bus.onSignal({ kind: 'view:state' }, () => {
      throw new Error('boom');
    });
    bus.onSignal({ kind: 'view:state' }, b);
    bus.publishSignal({ kind: 'view:state', source: addr(), value: 'ok' });
    expect(b).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('intent consumed=false when the only handler throws (release mode)', () => {
    const bus = releaseBus();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.onIntent({ kind: 'diff:open-file' }, () => {
      throw new Error('boom');
    });
    const consumed = bus.publishIntent({
      kind: 'diff:open-file',
      source: addr(),
      payload: { path: 'x' },
    });
    expect(consumed).toBe(false);
    consoleError.mockRestore();
  });

  it('rethrows handler errors in dev mode', () => {
    const bus = devBus();
    bus.onSignal({ kind: 'view:state' }, () => {
      throw new Error('boom');
    });
    expect(() =>
      bus.publishSignal({ kind: 'view:state', source: addr(), value: 'ok' }),
    ).toThrow('boom');
  });
});

describe('ViewBus re-entrance guard', () => {
  it('throws on direct re-entrant publish of the same kind (dev)', () => {
    const bus = devBus();
    bus.onSignal({ kind: 'view:state' }, () => {
      bus.publishSignal({ kind: 'view:state', source: addr(), value: 'busy' });
    });
    expect(() =>
      bus.publishSignal({ kind: 'view:state', source: addr(), value: 'ok' }),
    ).toThrow(/re-entrant publish of "view:state"/);
  });

  it('throws on indirect re-entrant publish across two kinds (dev)', () => {
    const bus = devBus();
    bus.onSignal({ kind: 'view:state' }, () => {
      bus.publishSignal({
        kind: 'view:metrics',
        source: addr(),
        value: { foo: 1 },
      });
    });
    bus.onSignal({ kind: 'view:metrics' }, () => {
      bus.publishSignal({ kind: 'view:state', source: addr(), value: 'ok' });
    });
    expect(() =>
      bus.publishSignal({ kind: 'view:state', source: addr(), value: 'busy' }),
    ).toThrow(/re-entrant publish of "view:state"/);
  });

  it('allows microtask-escape chained publish of the same kind', async () => {
    const bus = devBus();
    const ok = vi.fn();
    let firstCall = true;
    bus.onSignal({ kind: 'view:state' }, (s) => {
      if (firstCall) {
        firstCall = false;
        queueMicrotask(() =>
          bus.publishSignal({ kind: 'view:state', source: addr(), value: 'ok' }),
        );
      } else {
        ok(s.value);
      }
    });
    bus.publishSignal({ kind: 'view:state', source: addr(), value: 'busy' });
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(ok).toHaveBeenCalledWith('ok');
  });
});

describe('ViewBus snapshot', () => {
  it('records published signals and intents in ring buffers', () => {
    const bus = devBus();
    bus.publishSignal({ kind: 'view:state', source: addr(), value: 'busy' });
    bus.publishIntent({
      kind: 'diff:open-file',
      source: addr(),
      payload: { path: 'a.ts' },
    });
    const snap = bus.snapshot();
    expect(snap.signals).toHaveLength(1);
    expect(snap.intents).toHaveLength(1);
    expect(snap.signals[0].kind).toBe('view:state');
    expect(snap.intents[0].kind).toBe('diff:open-file');
  });
});
