// Krypton — remote (ssh) Harness connection badge (spec 247).
//
// The Harness reports its SSH connection through the window titlebar (the
// spec 247 `TitlebarStatus` hook) instead of a full-width strip inside the
// view: a quiet host badge while connected, a red clickable one while
// disconnected. Pure, so what each state reads is testable without a view or
// a DOM.

import type { TitlebarStatus, WorkspaceRef } from '../types';

export type RemoteConnectionState = 'connecting' | 'connected' | 'disconnected' | 'closing';

type SshWorkspace = Extract<WorkspaceRef, { kind: 'ssh' }>;

/** Symbol injected by `ensureHarnessSymbolDefs()` (`harness-icons.ts`). */
export const REMOTE_ICON_ID = 'krypton-icon-remote';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The first DNS label — `wks-mac-mini` for `wks-mac-mini.tail0fc908.ts.net`.
 *  IP literals stay whole: their first octet or group names nothing. */
export function shortRemoteHost(host: string): string {
  if (host.includes(':') || IPV4.test(host)) return host;
  const dot = host.indexOf('.');
  return dot > 0 ? host.slice(0, dot) : host;
}

/**
 * The titlebar badge for one connection state. The badge names the machine —
 * the profile when the user named one, else the short host plus any
 * non-default port. Everything it drops (user, full host, port, remote path,
 * state, the last error) is in the tooltip.
 */
export function remoteTitlebarStatus(
  workspace: SshWorkspace,
  state: RemoteConnectionState,
  message: string | null,
): TitlebarStatus {
  const target = `${workspace.user}@${workspace.host}:${workspace.port}`;
  const name = workspace.profile
    ?? `${shortRemoteHost(workspace.host)}${workspace.port === 22 ? '' : `:${workspace.port}`}`;
  const detail = [
    `SSH ${workspace.profile ? `${workspace.profile} (${target})` : target}`,
    workspace.path,
    state,
  ];
  if (message) detail.push(message);

  if (state === 'disconnected') {
    detail.push('click or palette “Reconnect Remote Harness” to reconnect');
    return {
      icon: REMOTE_ICON_ID,
      text: `${name} · offline · reconnect`,
      tone: 'error',
      title: detail.join(' · '),
      actionable: true,
    };
  }
  const pending = state === 'connecting' || state === 'closing';
  return {
    icon: REMOTE_ICON_ID,
    text: pending ? `${name} · ${state}` : name,
    tone: pending ? 'pending' : 'ok',
    title: detail.join(' · '),
  };
}
