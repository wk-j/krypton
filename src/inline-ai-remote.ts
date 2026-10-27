// Krypton — Inline AI checks on the pane's SSH host (spec 336).
//
// In an SSH pane the inline agent still runs on the Mac, so its own Bash tool
// reads the Mac. Krypton opens a separate, non-PTY SSH channel to the pane's
// host (`inline_remote_open`) and gives the session one MCP tool, `host_exec`,
// that runs a command there only when Krypton's read-only classifier (spec
// 318) accepts it. The fence approves that exact tool and nothing else.

import { invoke } from '@tauri-apps/api/core';

import type { FencedTool } from './acp/headless-fence';
import type { AcpMcpServerHttp } from './acp/types';

export const INLINE_HOST_EXEC: FencedTool = { server: 'krypton_inline', tool: 'host_exec' };
/** How the agent names the tool in `tool_call` and permission titles. */
export const INLINE_HOST_EXEC_TITLE = `mcp__${INLINE_HOST_EXEC.server}__${INLINE_HOST_EXEC.tool}`;

/** `inline_remote_open`'s result (Rust `InlineRemoteInfo`). */
export interface InlineRemoteInfo {
  /** The MCP capability; revoked by `inline_remote_close`. */
  token: string;
  /** `user@host`, from `ssh -G` and the probed `hostname -s`. */
  display: string;
  /** The probed `hostname -s`. */
  host: string;
  /** Basename of the host's `$SHELL`. */
  shell: string | null;
  /** The pane's OSC 7 cwd, only when its host is this host. */
  cwd: string | null;
}

/** What an SSH pane's Cmd+K could set up on its host. */
export type InlineRemote =
  | { kind: 'on'; info: InlineRemoteInfo; port: number }
  | { kind: 'off'; target: string; reason: string };

export interface Osc7Report {
  host: string;
  cwd: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Connect to the host behind `sessionId`'s ssh. Never rejects: a failure is an `off` with its reason. */
export async function openInlineRemote(sessionId: number, target: string, osc7: Osc7Report | null): Promise<InlineRemote> {
  try {
    const [info, port] = await Promise.all([
      invoke<InlineRemoteInfo>('inline_remote_open', { sessionId, osc7Host: osc7?.host ?? null, osc7Cwd: osc7?.cwd ?? null }),
      invoke<number>('get_hook_server_port'),
    ]);
    if (!port) {
      closeInlineRemote(info.token);
      return { kind: 'off', target, reason: 'the Krypton hook server is not running' };
    }
    return { kind: 'on', info, port };
  } catch (e) {
    return { kind: 'off', target, reason: errorText(e) };
  }
}

export function closeInlineRemote(token: string): void {
  invoke('inline_remote_close', { token }).catch(() => undefined);
}

/** The session's MCP servers: `host_exec` when the channel is up, else none. */
export function inlineRemoteMcpServers(remote: InlineRemote | null): AcpMcpServerHttp[] {
  if (remote?.kind !== 'on') return [];
  return [{
    name: INLINE_HOST_EXEC.server,
    type: 'http',
    url: `http://127.0.0.1:${remote.port}/mcp/inline`,
    headers: [{ name: 'x-krypton-inline-capability', value: remote.info.token }],
  }];
}

/** The `host_exec` command in a tool call's input, if any. */
export function hostExecCommand(title: string | undefined, rawInput: unknown): string | null {
  if (title !== INLINE_HOST_EXEC_TITLE || rawInput === null || typeof rawInput !== 'object') return null;
  const command = (rawInput as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim() !== '' ? command : null;
}

/**
 * The `<pane_host>` block sent with the conversation's first prompt: where the
 * user's commands run, where the agent's own tools run, and what it can check.
 */
export function remoteHostBlock(remote: InlineRemote): string {
  const lines = ['<pane_host>'];
  if (remote.kind === 'on') {
    const { display, host, shell, cwd } = remote.info;
    lines.push(
      `This terminal pane is an SSH session on ${display}. Commands the user runs from your answer execute on ${host}, not on this Mac.`,
      `Your own Bash tool runs on this Mac. To check anything on ${host}, call the host_exec tool. It runs only Krypton's read-only commands (no git, globs, redirects, $VAR, ~, cd); pipes and && are fine.`,
      `shell: ${shell ?? 'unknown'} (${host} $SHELL)`,
      cwd ? `cwd: ${cwd} (${host}, from OSC 7)` : `cwd on ${host}: unknown (host_exec runs in $HOME; use absolute paths)`,
    );
  } else {
    lines.push(
      `This terminal pane is an SSH session on ${remote.target}. Commands the user runs from your answer execute there, not on this Mac; your own Bash tool runs on this Mac.`,
      `Remote checks are unavailable: ${remote.reason}. Answer from the terminal context and say what you could not check.`,
    );
  }
  lines.push('</pane_host>');
  return lines.join('\n');
}

/** The overlay label's suffix for the remote state. */
export function remoteLabel(remote: InlineRemote): string {
  return remote.kind === 'on' ? `checks on ${remote.info.host}` : 'no remote checks';
}
