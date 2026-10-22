// Krypton — ACP backend update check (spec 322).
// Module-level snapshot of the Grok/OMP backends whose installed CLI is behind
// (Claude/Codex spawn via `npx -y <adapter>@latest`, so they are never listed).
// The check runs once per launch from main.ts and again when an update tab
// exits. Harness views subscribe and show a titlebar button while the
// snapshot is non-empty; the button opens a terminal tab running each
// backend's own updater.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** One backend that is behind. Mirrors Rust `acp_updates::BackendUpdate`. */
export interface BackendUpdate {
  backend_id: string;
  display_name: string;
  installed: string;
  latest: string;
  update_command: string;
}

/** Opens a terminal tab in the focused window; resolves to its PTY session id,
 *  or `null` when no tab could be opened. */
export type OpenTerminalTab = (options: { title: string; shell: string; shellArgs: string[] }) => Promise<number | null>;

let snapshot: readonly BackendUpdate[] = [];
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Backends currently known to be behind. Empty until the first check lands. */
export function backendUpdates(): readonly BackendUpdate[] {
  return snapshot;
}

/** Subscribe to snapshot replacements. Returns an unsubscribe function. */
export function onBackendUpdatesChange(cb: () => void): () => void {
  listeners.add(cb);
  return (): void => {
    listeners.delete(cb);
  };
}

/** Ask the backend which CLIs are behind. Single-flight: concurrent calls
 *  share one in-flight request. A failure keeps the previous snapshot. */
export function checkBackendUpdates(): Promise<void> {
  if (inFlight !== null) return inFlight;
  inFlight = (async (): Promise<void> => {
    try {
      const updates = await invoke<BackendUpdate[]>('acp_backend_updates');
      snapshot = updates;
      for (const cb of [...listeners]) cb();
    } catch (err) {
      console.warn('[backend-updates] acp_backend_updates failed:', err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** `OMP 18.12.6 → 18.13.0, Grok 1.0.67 → 1.0.70` */
export function describeBackendUpdates(updates: readonly BackendUpdate[]): string {
  return updates.map((u) => `${u.display_name} ${u.installed} → ${u.latest}`).join(', ');
}

/** Single-quote `s` for POSIX sh. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** `/bin/sh -c` script that runs every update (one failure does not stop the
 *  rest), then waits for Enter so the tab stays open. Printed data is always a
 *  quoted `printf '%s\n'` argument, never the format string. */
export function buildUpdateScript(updates: readonly BackendUpdate[]): string {
  const blocks = updates.map(
    (u) =>
      `printf '%s\\n' '' ${shq(`[krypton] ${u.display_name} ${u.installed} -> ${u.latest}`)} ${shq(`$ ${u.update_command}`)}; ${u.update_command}`,
  );
  return (
    blocks.join('; ') +
    "; printf '%s\\n' '' '[krypton] Running lanes keep the old version until restarted' '(palette: Restart Lane Session). Press Enter to close.'; read _"
  );
}

/** Open a terminal tab running every pending update, then re-check once its
 *  PTY exits. No lock: a tab closed without Enter never emits `pty-exit`. */
export async function runBackendUpdates(openTab: OpenTerminalTab): Promise<void> {
  const updates = snapshot;
  if (updates.length === 0) return;

  const exited = new Set<number>();
  let sid: number | null = null;
  let done = false;
  let unlisten: () => void = (): void => {};

  const finish = (): void => {
    if (done) return;
    done = true;
    unlisten();
    void checkBackendUpdates();
  };

  try {
    unlisten = await listen<number>('pty-exit', (e) => {
      if (sid === null) {
        exited.add(e.payload);
        return;
      }
      if (e.payload === sid) finish();
    });
  } catch (err) {
    console.warn('[backend-updates] pty-exit listen failed:', err);
    return;
  }

  let opened: number | null = null;
  try {
    opened = await openTab({ title: 'ACP // update', shell: '/bin/sh', shellArgs: ['-c', buildUpdateScript(updates)] });
  } catch (err) {
    console.warn('[backend-updates] could not open the update tab:', err);
  }
  if (opened === null) {
    unlisten();
    return;
  }
  sid = opened;
  if (exited.has(sid)) finish();
}
