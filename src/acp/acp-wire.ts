// Krypton — ACP wire profiler opener (spec 288), shared by the command
// palette and the harness `#profiler` command.

import { invoke } from '@tauri-apps/api/core';

import { loopbackPath, openLoopback } from '../loopback-open';

export type AcpWireMode = 'off' | 'meta' | 'full';

/**
 * Open the capability-gated profiler page in the OS browser. Opening it is the
 * request to profile, so capture is switched to `meta` when it is off.
 * Returns the page URL and whether capture was enabled. Throws on failure.
 */
export async function openAcpWireProfiler(): Promise<{ url: string; enabledMeta: boolean }> {
  const target = await invoke<{ url: string; mode: AcpWireMode }>('get_acp_wire_url');
  const enabledMeta = target.mode === 'off';
  if (enabledMeta) await invoke<string>('acp_wire_set_mode', { mode: 'meta' });
  const url = await openLoopback(loopbackPath(target.url));
  return { url, enabledMeta };
}
