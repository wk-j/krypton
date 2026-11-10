// Krypton — the fence every headless ACP caller puts around its session
// (assist sidecar, spec 306; Inline AI, spec 333).
//
// Nobody sits behind a headless session to answer the agent, so every request
// it can raise is answered here: permissions declined, file writes refused,
// questions cancelled. Declining is not politeness — an unanswered request
// parks the agent (`acp.rs` holds it with no timeout) and `session/prompt`
// would never resolve.
//
// One exception exists (spec 336): a caller may name ONE MCP tool it serves
// itself, and a permission request for exactly that tool is approved once.
// The tool's own server is the real gate; the fence only stops the agent from
// parking on it.

import type { LaneEvent, ToolView } from './adapters/types';
import type { AcpClient } from './client';

/** An MCP tool, as the agent names it: `mcp__<server>__<tool>`. */
export interface FencedTool {
  server: string;
  tool: string;
}

/**
 * True only for `tool` on `server`, matched exactly on the adapter identity
 * (spec 380): the title is `mcp__<server>__<tool>`, and on a Claude lane
 * `_meta.claudeCode` restates the same tool on the same server — the Claude
 * adapter voids the identity otherwise. Arguments (`rawInput`) are never
 * evidence, and conflicting labels decline.
 */
export function isExactMcpTool(view: Pick<ToolView, 'mcp'>, { server, tool }: FencedTool): boolean {
  return view.mcp !== null && view.mcp.server === server && view.mcp.tool === tool;
}

/** Answer `event` if it is a request the fence owns. True when it was one. */
export function answerFencedRequest(client: AcpClient, event: LaneEvent, allow?: FencedTool): boolean {
  switch (event.type) {
    case 'permission_request': {
      const once = allow && isExactMcpTool(event.view, allow)
        ? event.options.find((option) => option.kind === 'allow_once')
        : undefined;
      void client.respondPermission(event.requestId, once?.optionId ?? null).catch(() => undefined);
      return true;
    }
    case 'fs_write_pending':
      void client.respondFsWrite(event.requestId, false).catch(() => undefined);
      return true;
    case 'ask_user_question':
    case 'elicitation_request':
      void client.cancel().catch(() => undefined);
      return true;
    default:
      return false;
  }
}
