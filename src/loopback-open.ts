// Krypton — open a loopback page in the OS browser (spec 341).
//
// Every opener goes through the session landing (`/app/session/<token>?next=`),
// which hands the page's shell the capability it needs to link Terminal
// Control, ACP wire, Hurl and E2E from any page.

import { invoke } from '@tauri-apps/api/core';

/** Path + query + fragment of a full loopback URL (`http://127.0.0.1:<port>/termctrl/<t>`). */
export function loopbackPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Open `path` (e.g. `/docs?harness=hm-2`) in the OS browser. Resolves to the
 * page URL without the session token, for notifications; rejects with the
 * server's reason when the loopback server is not running.
 */
export async function openLoopback(path: string): Promise<string> {
  const url = await invoke<string>('loopback_url', { path });
  await invoke('open_url', { url });
  return `${new URL(url).origin}${path}`;
}
