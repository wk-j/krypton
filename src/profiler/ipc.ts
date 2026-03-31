// Krypton — Instrumented IPC wrapper
// Drop-in replacement for Tauri's invoke(). Times every call and feeds
// the MetricsCollector so the profiler HUD can display IPC stats.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import { collector } from './metrics';

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await tauriInvoke<T>(cmd, args);
    collector.recordIpc(cmd, performance.now() - t0, false);
    return result;
  } catch (e) {
    collector.recordIpc(cmd, performance.now() - t0, true);
    throw e;
  }
}
