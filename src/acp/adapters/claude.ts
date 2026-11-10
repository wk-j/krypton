// Spec 380 — Claude (`@agentclientprotocol/claude-agent-acp`, backend id `claude`).

import type { ToolCall, ToolCallUpdate } from '../types';
import { UNVERIFIED_SUPPLIES } from './generic';
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

// ─── Background launches (spec 305) ───────────────────────────────────────
// Moved from `harness-background-tasks.ts` (spec 380 phase 4).

/** The adapter's launch result, verbatim:
 *  `Command running in background with ID: bxs80otkx. Output is being written to: /private/tmp/…` */
const LAUNCH_RE =
  /Command running in background with ID:\s*(\S+?)\.\s+Output is being written to:\s*(\S+)/;

export interface BackgroundLaunch {
  readonly id: string;
  readonly outputPath: string;
}

/** The launch id + output path, or null when this tool call is not one. */
export function parseBackgroundLaunch(call: ToolCall | ToolCallUpdate): BackgroundLaunch | null {
  for (const item of call.content ?? []) {
    if (item.type !== 'content') continue;
    const block = item.content;
    if (!block || block.type !== 'text') continue;
    const launch = parseBackgroundLaunchText(block.text);
    if (launch) return launch;
  }
  return null;
}

/**
 * The launch line in one output text. Under the terminal convention (spec 380
 * phase 3) Claude sends it as the command's terminal output instead of a
 * `content` block.
 */
export function parseBackgroundLaunchText(text: string | null): BackgroundLaunch | null {
  const match = text ? LAUNCH_RE.exec(text) : null;
  if (!match) return null;
  const outputPath = match[2].replace(/[.,]$/, '');
  return outputPath.startsWith('/') ? { id: match[1], outputPath } : null;
}

/** The launched command line, for the row label and the process match. */
export function launchCommand(call: ToolCall | ToolCallUpdate): string {
  const raw = call.rawInput;
  if (raw && typeof raw === 'object' && 'command' in raw) {
    const command = raw.command;
    if (typeof command === 'string' && command.trim()) return command.trim();
  }
  return call.title?.trim() ?? '';
}

// ─── Identity ─────────────────────────────────────────────────────────────

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
  // No `turnState` hook: Krypton reads thread state from codex-acp only.
  supplies: { ...UNVERIFIED_SUPPLIES, turnState: 'no' },
  // A failed Bash call's output starts with `Exit code N`, in the terminal
  // output or in `content` text. The head result already shows N.
  exitLine: /^Exit code (-?\d+)[ \t]*(?:\r?\n|$)/,
  chunkParent: claudeParentToolUseId,
  tool(step: ToolStep): void {
    const { draft, merged } = step;
    draft.parentId = claudeParentToolUseId(step.call._meta) ?? draft.parentId;
    crossCheckIdentity(step);
    // spec 305: `run_in_background` launches name the task id and its output file.
    const launch = parseBackgroundLaunch(merged) ?? parseBackgroundLaunchText(step.terminalOutput);
    if (launch) draft.background = { ...launch, command: launchCommand(merged) };
    applySubagentCard(step);
  },
};
