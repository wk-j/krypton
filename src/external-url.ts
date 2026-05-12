// Routes external URL clicks from content views to either an in-app webview
// pane (default once the compositor wires it up) or the system browser.
// Views call `openExternalUrl(href, opts)` instead of inlining `invoke('open_url')`
// so the routing target can change without per-view edits.

import { invoke } from './profiler/ipc';

export type ExternalUrlHandler = (url: string) => void | Promise<void>;

export interface OpenExternalOptions {
  /** Force the system browser regardless of the registered handler. */
  external?: boolean;
}

let registered: ExternalUrlHandler | null = null;

/** Compositor installs its handler at startup. */
export function registerExternalUrlHandler(handler: ExternalUrlHandler): void {
  registered = handler;
}

export function openExternalUrl(url: string, opts: OpenExternalOptions = {}): void {
  if (opts.external || registered === null) {
    invoke('open_url', { url }).catch((e) => console.error('open_url failed:', e));
    return;
  }
  void registered(url);
}
