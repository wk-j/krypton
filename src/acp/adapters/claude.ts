// Spec 380 — Claude (`@agentclientprotocol/claude-agent-acp`, backend id `claude`).

import { launchCommand, parseBackgroundLaunch } from '../harness-background-tasks';
import { applySubagentCard } from './tool';
import type { LaneAdapter, ToolStep } from './types';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Claude subagent output and child tool calls carry their Task call id in `_meta.claudeCode`. */
export function claudeParentToolUseId(meta: unknown): string | null {
  const id = record(record(meta)?.claudeCode)?.parentToolUseId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The title names the MCP tool; `_meta.claudeCode` restates it. Metadata that
 * names a different tool or server voids the identity rather than picking one.
 *
 * A permission request is held to the paired rule (spec 336): when Claude sent
 * `claudeCode`, it must restate both the qualified tool name and the server.
 * Tool calls carry `toolName` but no `mcpServer`, so for them only a stated
 * value has to agree.
 */
function crossCheckIdentity(step: ToolStep): void {
  const { draft } = step;
  const claudeCode = record(record(step.call._meta)?.claudeCode);
  if (!draft.mcp || !claudeCode) return;
  const toolName = claudeCode.toolName;
  const server = record(claudeCode.mcpServer)?.name;
  const title = step.merged.title?.trim();
  if (step.permission) {
    if (toolName !== title || server !== draft.mcp.server) draft.mcp = null;
    return;
  }
  if (typeof toolName === 'string' && toolName !== title) draft.mcp = null;
  else if (typeof server === 'string' && server !== draft.mcp.server) draft.mcp = null;
}

export const claudeAdapter: LaneAdapter = {
  id: 'claude',
  chunkParent: claudeParentToolUseId,
  tool(step: ToolStep): void {
    const { draft, merged } = step;
    draft.parentId = claudeParentToolUseId(step.call._meta) ?? draft.parentId;
    crossCheckIdentity(step);
    // spec 305: `run_in_background` launches name the task id and its output file.
    const launch = parseBackgroundLaunch(merged);
    if (launch) draft.background = { ...launch, command: launchCommand(merged) };
    applySubagentCard(step);
  },
};
