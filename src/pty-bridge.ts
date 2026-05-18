// PTY → ViewBus bridge.
// Translates existing Tauri events (pty-output, pty-exit, pty-progress, process-changed)
// into bus signals. Applies a 5 Hz rate budget for throughput.
// See docs/105-view-protocol.md § Rust → Bus.

import { listen as tauriListen } from '@tauri-apps/api/event';

import type { ViewBus } from './view-bus';
import type { ViewAddress } from './view-bus-types';
import type {
  ProcessChangedEvent,
  ProgressEvent,
  SessionId,
} from './types';

export interface AddressResolver {
  addressFromSession(sid: SessionId): ViewAddress | null;
}

export interface PtyBridgeDeps {
  /** Event-listen function. Defaults to Tauri's `listen`. */
  listen?: <T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ) => Promise<() => void>;
  /** Monotonic clock in ms. Defaults to `performance.now`. */
  now?: () => number;
}

const THROUGHPUT_INTERVAL_MS = 200; // 5 Hz
const EMA_ALPHA = 0.3;

interface ThroughputState {
  bytesSinceLastEmit: number;
  lastEmitMs: number;
  emaBytesPerSec: number;
}

export interface PtyBridgeHandle {
  stop(): Promise<void>;
}

export async function startPtyBridge(
  bus: ViewBus,
  resolver: AddressResolver,
  deps: PtyBridgeDeps = {},
): Promise<PtyBridgeHandle> {
  const listen = deps.listen ?? defaultListen;
  const now = deps.now ?? (() => performance.now());

  const throughput = new Map<SessionId, ThroughputState>();

  const offOutput = await listen<[SessionId, number[]]>('pty-output', (event) => {
    const [sid, data] = event.payload;
    const addr = resolver.addressFromSession(sid);
    if (!addr) return;

    const state = throughput.get(sid) ?? {
      bytesSinceLastEmit: 0,
      lastEmitMs: now(),
      emaBytesPerSec: 0,
    };
    state.bytesSinceLastEmit += data.length;
    const elapsed = now() - state.lastEmitMs;
    if (elapsed >= THROUGHPUT_INTERVAL_MS) {
      const instantaneous = (state.bytesSinceLastEmit * 1000) / elapsed;
      state.emaBytesPerSec =
        EMA_ALPHA * instantaneous + (1 - EMA_ALPHA) * state.emaBytesPerSec;
      bus.publishSignal({
        kind: 'view:throughput',
        source: addr,
        value: Math.round(state.emaBytesPerSec),
      });
      state.bytesSinceLastEmit = 0;
      state.lastEmitMs = now();
    }
    throughput.set(sid, state);
  });

  const offExit = await listen<SessionId>('pty-exit', (event) => {
    const sid = event.payload;
    const addr = resolver.addressFromSession(sid);
    throughput.delete(sid);
    if (!addr) return;
    // The Rust backend does not currently carry the exit code through `pty-exit`;
    // it only signals process termination. Surface as code: null until the
    // backend payload is extended.
    bus.publishSignal({
      kind: 'view:exit',
      source: addr,
      value: { code: null },
    });
  });

  const offProgress = await listen<ProgressEvent>('pty-progress', (event) => {
    const { session_id: sid, state, progress } = event.payload;
    const addr = resolver.addressFromSession(sid);
    if (!addr) return;
    bus.publishSignal({
      kind: 'view:progress',
      source: addr,
      value: { state, pct: state === 1 || state === 2 || state === 4 ? progress : null },
    });
  });

  const offProcess = await listen<ProcessChangedEvent>('process-changed', (event) => {
    const { session_id: sid, process } = event.payload;
    const addr = resolver.addressFromSession(sid);
    if (!addr || !process) return;
    bus.publishSignal({
      kind: 'view:metrics',
      source: addr,
      value: {
        pid: process.pid,
        name: process.name,
        cmd: process.cmdline.join(' '),
      },
    });
  });

  return {
    async stop() {
      offOutput();
      offExit();
      offProgress();
      offProcess();
    },
  };
}

const defaultListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> => tauriListen<T>(event, handler);
