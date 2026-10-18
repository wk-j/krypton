// Krypton — Connected Computer command approval (spec 311), presented as a
// harness permission row instead of a modal dialog.
//
// The gate itself is in Rust: `connected_computers.rs::exec` parks a oneshot,
// emits `computer-command-approval`, and opens SSH only after the human answers
// (or declines it after 120s). This module is presentation only — it turns that
// request into the SAME `PermissionPayload` the ACP permission rows use, so a
// remote command reads in the transcript exactly like every other decision the
// lane is waiting on.
//
// The shared SHAPE must not become a shared QUEUE. `lane.pendingPermissions` is
// drained automatically by `permissionMode: 'bypass'`, `acceptEdits` on edits,
// `acceptAllForTurn`, a Telegram turn, and the Polly/Salty roles that stamp
// `bypass` onto a lane (acp-harness-view.ts:8891-8913). This gate exists
// precisely because the agent-side permission for `computer_exec` is already
// auto-allowed (harness-permission-scan.ts:69), so routing it there would let a
// mode toggle run commands as the user's SSH identity with no prompt at all.
// `lane.pendingComputerCommands` is resolved by an explicit keystroke only.

import type { PermissionPayload } from './harness-view-types';

/** Payload of the `computer-command-approval` event emitted by Rust. */
export interface ComputerApprovalRequest {
  requestId: string;
  harnessId: string;
  laneLabel: string;
  spawnEpoch: number;
  computerId: string;
  target: string;
  command: string;
  cwd: string | null;
}

/** The composer prompt. No `A`/`R` blanket variants: spec 311 §90 approves one
 *  command, once — a remote command never inherits a previous answer. */
export const COMPUTER_APPROVAL_HINT = 'a approve once · r decline';

/** Spec 311 §90 display contract: resolved SSH identity, remote directory and
 *  the exact command, in the requesting lane's own transcript.
 *
 *  `id` is negative by construction (see `computerApprovalSeq`) so a remote
 *  approval can never collide with an ACP permission's `requestId`. */
export function computerApprovalPayload(
  request: ComputerApprovalRequest,
  id: number,
): PermissionPayload {
  return {
    id,
    toolName: 'remote command',
    toolFamily: 'shell',
    serverName: null,
    kind: 'remote',
    subject: `${request.computerId} · ${request.target}`,
    suffix: `· ${request.cwd ?? 'login home'} · approval applies once`,
    // The exact bytes Rust will feed to the remote `sh -s`, never a summary:
    // spec 311 edge case "a caller submits shell syntax or a destructive
    // command" rests on the human reading this line.
    argsPreview: request.command,
    options: [
      { optionId: 'approve-once', name: 'approve once', action: 'accept' },
      { optionId: 'decline', name: 'decline', action: 'reject' },
    ],
    decision: 'pending',
  };
}
