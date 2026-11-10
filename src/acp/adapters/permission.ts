// Spec 380 phase 2b — permission requests, decoded once.
//
// The policy facts below use the exact functions that decided them before
// spec 380 (spec 96 built-in identity, spec 143 high-risk gating), now called
// here instead of by the view, so no surface reads the request's wire call.
// The spec 96 identity rules and the args preview moved here from
// `harness-permission-scan.ts` in phase 4; the tool-name sets stay there.

import { truncate } from '../harness-format';
import { HARNESS_AUTO_ALLOW_TOOL_NAMES } from '../harness-permission-scan';
import type { PermissionOption, ToolCall } from '../types';
import { permissionCommandIsHighRisk } from './generic';
import type { ToolCallDecoder } from './tool';
import type { PermissionRequest, ToolView } from './types';

// ─── Built-in harness tool identity (spec 96) ─────────────────────────────

const HARNESS_SERVER_NAMES: Record<string, true> = {
  'krypton-harness-bus': true,
  krypton_harness_bus: true,
  'krypton-harness-memory': true,
  krypton_harness_memory: true,
};
const HARNESS_SERVER_KEYS = ['server', 'serverName', 'server_name', 'serverUrl', 'server_url'] as const;
/** spec 359: fx qualifies MCP tools as `mcp_<server>_<tool>` (single
 *  underscores) in the permission request's toolCall `name`/`title`. */
const FX_QUALIFIED_HARNESS_TOOL = /^mcp_(?:krypton-harness-(?:bus|memory)|krypton_harness_(?:bus|memory))_([a-z_]+)$/;

function isHarnessServer(value: string): boolean {
  if (HARNESS_SERVER_NAMES[value.trim().toLowerCase()] === true) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && /^\/mcp\/harness\/[^/]+\/lane\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** `krypton-harness-memory/peer_send`, `mcp__krypton_harness_bus__peer_send`,
 *  `Tool: krypton-harness-bus:timeline_list` or fx's `mcp_<server>_<tool>`. The whole
 *  string must be the qualified name; a built-in name anywhere else never counts. */
function qualifiedHarnessTool(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const match = /^(?:tool:\s*)?(?:mcp__)?(?:krypton-harness-(?:bus|memory)|krypton_harness_(?:bus|memory))(?:__|\/|:)([a-z_]+)$/.exec(trimmed);
  const name = match?.[1] ?? FX_QUALIFIED_HARNESS_TOOL.exec(trimmed)?.[1];
  return name && HARNESS_AUTO_ALLOW_TOOL_NAMES.has(name) ? name : null;
}

/**
 * The built-in harness tool a permission request is for, or null.
 *
 * Identity comes only from what the adapter states about the call: a qualified
 * title, top-level server metadata paired with an exact bare title, a whole
 * qualified `Tool:` content line, or the Junie option-label wrapper. `rawInput`
 * is the tool's argument payload, which the agent writes freely, so it is never
 * identity evidence. A shell command never qualifies, and an explicitly foreign
 * qualified title cannot be overridden by content or option labels.
 */
function builtInPermissionToolName(call: ToolCall, optionNames: string[]): string | null {
  if (call.kind === 'execute') return null;
  const metadata = call as unknown as Record<string, unknown>;
  for (const key of HARNESS_SERVER_KEYS) {
    const server = metadata[key];
    if (typeof server === 'string' && !isHarnessServer(server)) return null;
  }
  const title = call.title?.trim().toLowerCase();
  const qualified = qualifiedHarnessTool(title);
  if (qualified) return qualified;
  // `mcp_` also covers fx's single-underscore `mcp_<server>_<tool>` form.
  if (title && (/^mcp_/.test(title) || /^(?:tool:\s*)?[^\s/:]+[/:][^\s]+$/.test(title))) return null;
  const hasServer = HARNESS_SERVER_KEYS.some((key) => {
    const server = metadata[key];
    return typeof server === 'string' && isHarnessServer(server);
  });
  if (hasServer && title && HARNESS_AUTO_ALLOW_TOOL_NAMES.has(title)) return title;
  for (const block of call.content ?? []) {
    const content = block.content;
    if (block.type !== 'content' || content?.type !== 'text') continue;
    const name = qualifiedHarnessTool(content.text);
    if (name) return name;
  }
  for (const label of optionNames) {
    const match = /^Always allow\s*\(\s*["']([^"']+)["']\s*\)$/i.exec(label.trim());
    const name = qualifiedHarnessTool(match?.[1]);
    if (name) return name;
  }
  return null;
}

/** The built-in harness tool a wire permission request is for (spec 96). The
 *  lane decoder calls this once per request (spec 380); the view reads the result. */
export function harnessAutoAllowToolName(permission: { toolCall: ToolCall; options?: PermissionOption[] }): string | null {
  const optionNames = (permission.options ?? [])
    .map((option) => option.name)
    .filter((name): name is string => typeof name === 'string');
  return builtInPermissionToolName(permission.toolCall, optionNames);
}

export function extractHarnessServerName(call: ToolCall): string | null {
  return stringValueForKeys(call.rawInput, ['server', 'serverName', 'server_name', 'serverUrl', 'server_url'])
    ?? stringValueForKeys(call, ['server', 'serverName', 'server_name'])
    ?? null;
}

export function stringValueForKeys(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 4 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = stringValueForKeys(item, keys, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const item of Object.values(record)) {
    const match = stringValueForKeys(item, keys, depth + 1);
    if (match) return match;
  }
  return null;
}

// spec 167: tightened limits — the pending card shows this on one compact line,
// so favour a short scannable head over an exhaustive arg dump.
const PERMISSION_SAFETY_KEYS = new Set([
  'command', 'cmd', 'path', 'file', 'file_path', 'filepath', 'cwd', 'url', 'target',
]);
export function permissionArgsPreview(value: unknown, subject?: string): string {
  const args = extractToolArguments(value);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return boundedInlineValue(args ?? value, 90);
  // Drop any arg that merely echoes the subject line — an execute permission's
  // `command` is already shown in full as the subject, so repeating it in the
  // preview just prints the command twice. Keeps signal-carrying args (e.g.
  // `description`) so the preview still earns its line.
  const subjectNorm = subject ? subject.replace(/\s+/g, ' ').trim() : '';
  // The 3-part cap can drop a safety-critical arg (the command/path being run) if
  // it sits late in the object, so surface those keys first before the cap bites.
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, raw]) => !(subjectNorm && typeof raw === 'string' && raw.replace(/\s+/g, ' ').trim() === subjectNorm),
  );
  entries.sort(([a], [b]) => {
    const aSafe = PERMISSION_SAFETY_KEYS.has(a.toLowerCase()) ? 0 : 1;
    const bSafe = PERMISSION_SAFETY_KEYS.has(b.toLowerCase()) ? 0 : 1;
    return aSafe - bSafe;
  });
  const parts: string[] = [];
  for (const [key, raw] of entries) {
    if (parts.length >= 3) break;
    parts.push(`${key}: ${boundedInlineValue(raw, 30)}`);
  }
  return truncate(parts.join(' · '), 96);
}

export function extractToolArguments(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.arguments ?? record.args ?? record.input ?? value;
}

export function boundedInlineValue(value: unknown, max = 140): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim(), max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(value).replace(/\s+/g, ' '), max);
  } catch {
    return truncate(String(value), max);
  }
}

// ─── Decode ───────────────────────────────────────────────────────────────

/** The file a permission is about, else its title (what the card's subject shows). */
export function permissionSubject(view: Pick<ToolView, 'modifiedPath' | 'locations' | 'title'>): string {
  return view.modifiedPath ?? view.locations[0] ?? (view.title || 'unknown target');
}

export function decodePermission(
  tools: ToolCallDecoder,
  requestId: number,
  toolCall: ToolCall,
  options: PermissionOption[],
): PermissionRequest {
  const view = tools.view(toolCall);
  return {
    requestId,
    view,
    options,
    harnessTool: harnessAutoAllowToolName({ toolCall, options }),
    highRisk: permissionCommandIsHighRisk(toolCall),
    argsPreview: permissionArgsPreview(toolCall.rawInput, permissionSubject(view)),
    serverName: extractHarnessServerName(toolCall),
  };
}
