// Krypton — ACP Harness View: permission & artifact-path scanning.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Decides whether a
// permission request is a built-in harness-bus tool call (auto-allowed), builds
// the human-readable args preview, and matches tool-call paths against the
// artifact registry / scratch dir.

import type { ToolView } from './adapters/types';
import type { PermissionOption, ToolCall, ToolCallUpdate } from './types';
import type {
  HarnessPermission,
  HarnessToolFamily,
  PermissionPayload,
} from './harness-view-types';
import { truncate } from './harness-format';
import { extractModifiedPath } from './acp-harness-memory';

/** specs 133/206 — alphabet shared by artifact and response-reference hints. */
export const ARTIFACT_HINT_ALPHABET = 'asdfghjklqweruiop';

const HARNESS_MEMORY_TOOL_NAMES = new Set(['handoff_set']);
const HARNESS_PEER_TOOL_NAMES = new Set(['peer_send', 'peer_list']);
// spec 130: attention triage is default-on built-in harness-bus tooling, so its
// calls must auto-allow like memory/peer — a permission prompt here also
// breaks the non-blocking contract (the lane proceeds with `chosen`, never waits).
const HARNESS_ATTENTION_TOOL_NAMES = new Set(['attention_flag', 'attention_resolve']);
// spec 146: review_outcome is default-on built-in harness-bus tooling (the
// authoring lane self-reports a #review summary), so it must auto-allow like
// the others — a permission prompt mid-synthesis would derail the round.
// spec 160: mark_review_priority is likewise default-on — the authoring lane
// reports diff reading-order hints at end-of-turn; a permission prompt there
// would interrupt the turn boundary for a purely-advisory signal.
const HARNESS_REVIEW_TOOL_NAMES = new Set(['review_outcome', 'mark_review_priority']);
// Timeline decisions belong to the lane agent, including grouping and legacy
// intake. Only these exact built-in tool names bypass human permissions.
const HARNESS_TIMELINE_TOOL_NAMES = new Set([
  'timeline_record',
  'timeline_list',
  'timeline_merge',
  'timeline_pending_resolve',
  'timeline_conflict_list',
  'timeline_conflict_record',
  'timeline_conflict_checked',
]);
// specs 178/238/239: progress and ticket tools are default-on built-in
// harness-bus tooling. Backend validation confines every write to the active
// ticket bundle: `ticket_progress`/`ticket_link` require (or first-claim) the
// worker binding, `ticket_note`/`ticket_add_resource` are append-only and open
// to every lane.
const HARNESS_ISSUE_TOOL_NAMES = new Set([
  'issue_progress',
  'ticket_progress',
  'ticket_note',
  'ticket_add_resource',
  'ticket_link',
]);
// spec 298: lessons are written at correction moments and are visible in the
// transcript; a prompt on every write would hand the work back to the human.
// Backend validation caps size and count; the store is plain files a human can edit.
const HARNESS_LESSON_TOOL_NAMES = new Set(['lesson_record', 'lesson_retire']);
// spec 311: auto-allow only the authenticated built-in routing call. Rust
// still waits for the separate, exact-command approval before opening SSH.
const HARNESS_COMPUTER_TOOL_NAMES = new Set(['computer_list', 'computer_exec']);
const HARNESS_AUTO_ALLOW_TOOL_NAMES = new Set([
  ...HARNESS_MEMORY_TOOL_NAMES,
  ...HARNESS_LESSON_TOOL_NAMES,
  ...HARNESS_PEER_TOOL_NAMES,
  ...HARNESS_ATTENTION_TOOL_NAMES,
  ...HARNESS_REVIEW_TOOL_NAMES,
  ...HARNESS_TIMELINE_TOOL_NAMES,
  ...HARNESS_ISSUE_TOOL_NAMES,
  ...HARNESS_COMPUTER_TOOL_NAMES,
]);
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

export function pickPermissionOption(options: PermissionOption[], action: 'accept' | 'reject'): PermissionOption | null {
  if (action === 'accept') {
    return options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always') ?? null;
  }
  return options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always') ?? null;
}

/** The built-in harness tool a wire permission request is for (spec 96). The
 *  lane decoder calls this once per request (spec 380); the view reads the result. */
export function harnessAutoAllowToolName(permission: { toolCall: ToolCall; options?: PermissionOption[] }): string | null {
  const optionNames = (permission.options ?? [])
    .map((option) => option.name)
    .filter((name): name is string => typeof name === 'string');
  return builtInPermissionToolName(permission.toolCall, optionNames);
}

export function harnessToolFamily(toolName: string): HarnessToolFamily | null {
  if (HARNESS_MEMORY_TOOL_NAMES.has(toolName)) return 'memory';
  if (HARNESS_PEER_TOOL_NAMES.has(toolName)) return 'peer';
  if (HARNESS_ATTENTION_TOOL_NAMES.has(toolName)) return 'attention';
  if (HARNESS_REVIEW_TOOL_NAMES.has(toolName)) return 'review';
  if (HARNESS_TIMELINE_TOOL_NAMES.has(toolName)) return 'timeline';
  if (HARNESS_LESSON_TOOL_NAMES.has(toolName)) return 'lessons';
  return null;
}

export function permissionToolFamily(kind: string): PermissionPayload['toolFamily'] {
  if (kind === 'execute') return 'shell';
  if (kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'write') return 'file';
  if (kind === 'read' || kind === 'search') return 'file';
  if (kind === 'think' || kind === 'fetch') return 'agent';
  return 'other';
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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** spec 133 — normalize a path for artifact registry matching (forward slashes). */
export function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** spec 133 — does a file-write target match an issued artifact path? An
 * ABSOLUTE target must equal the issued path exactly — never a mere suffix
 * match, or an attacker-controlled parent (`/evil/<tail>`) sharing the tail
 * would be auto-approved. A RELATIVE target (adapter reports relative to the
 * lane cwd) matches when it is a suffix of the *trusted* issued path. Empty
 * tail never matches. */
export function artifactWritePathMatches(target: string, recordPath: string, recordTail: string): boolean {
  if (!recordTail) return false;
  const t = normalizeArtifactPath(target);
  const p = normalizeArtifactPath(recordPath);
  if (t === p) return true;
  if (t.startsWith('/')) return false; // absolute, non-equal → reject
  const rel = t.replace(/^\.\//, '');
  return rel.length > 0 && (p === rel || p.endsWith('/' + rel));
}

/** spec 133 — tool kinds eligible for artifact-write auto-approval. A path
 * match alone must NOT grant: only a file *write* is auto-approved, never a
 * read/search/execute/delete that merely names the artifact in `locations`. */
export function isArtifactWriteGrantKind(kind: string): boolean {
  return kind === 'edit' || kind === 'write' || kind === 'create';
}

/** spec 211 — does a file-write target sit INSIDE an issued review bundle? Same
 * absolute/relative asymmetry as `artifactWritePathMatches` and for the same
 * reason (an attacker-controlled `/evil/<tail>` sharing the tail must not be
 * auto-approved), but the grant covers a DIRECTORY rather than one file, because
 * a lane legitimately writes `review.md` and `assets/diagram.png` into the same
 * bundle. `recordDir` is the trusted absolute bundle path; `recordTail` is its
 * project-relative form and must end in `/` so a sibling directory sharing a name
 * prefix (`…/reviews/guard-2/` vs `…/reviews/guard/`) can never match. */
export function reviewWritePathMatches(
  target: string,
  recordDir: string,
  recordTail: string,
): boolean {
  if (!recordTail || !recordDir) return false;
  const t = normalizeArtifactPath(target);
  if (t.length === 0) return false;
  // `normalizeArtifactPath` strips trailing slashes, so re-add the boundary that
  // stops `…/guard-2/x` matching a grant issued for `…/guard/`.
  const dir = `${normalizeArtifactPath(recordDir)}/`;
  if (t.startsWith('/')) return t.startsWith(dir);
  // Relative targets are reported against the lane cwd, which is the project
  // root — so they must carry the project-relative bundle prefix. Anything else
  // fails closed into a normal permission prompt rather than being guessed at.
  const tail = `${normalizeArtifactPath(recordTail)}/`;
  return t.replace(/^\.\//, '').startsWith(tail);
}

/** spec 133 — does a path sit under any harness artifact scratch root? Used for
 * transcript REDACTION only (never for grant): redacting is always safe, so a
 * broad `.krypton/artifacts/` pattern closes the window where the registry
 * pending event has not yet arrived when a write card first renders. Grant
 * stays strictly registry-keyed (see `artifactWritePathMatches`). */
export function isArtifactScratchPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return normalizeArtifactPath(path).includes('/.krypton/artifacts/');
}

/** spec 133 — does a tool call target a scratch path anywhere (modified-path,
 * locations, or a path-bearing rawInput field)? Used for REDACTION only, so it
 * is deliberately broad: it closes the gap where an adapter reports the artifact
 * path only inside rawInput (not as a diff/location), which `extractModifiedPath`
 * would miss — leaking HTML during the registry-event race. Only path-ish keys
 * are inspected, never large content blobs. */
/** spec 133 — does a decoded tool view name a lane artifact scratch path? */
export function viewTargetsArtifactScratch(view: Pick<ToolView, 'modifiedPath' | 'locations' | 'inputPaths'>): boolean {
  return [view.modifiedPath, ...view.locations, ...view.inputPaths].some((path) => isArtifactScratchPath(path));
}

export function callTargetsArtifactScratch(call: ToolCall | ToolCallUpdate): boolean {
  if (isArtifactScratchPath(extractModifiedPath(call))) return true;
  for (const loc of call.locations ?? []) {
    if (isArtifactScratchPath(loc.path)) return true;
  }
  return rawInputPathMentionsScratch(call.rawInput, 0);
}

export function rawInputPathMentionsScratch(value: unknown, depth: number): boolean {
  if (depth > 4 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => rawInputPathMentionsScratch(v, depth + 1));
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string') {
      if (/path|file|target|dest|location/i.test(key) && isArtifactScratchPath(val)) return true;
    } else if (val && typeof val === 'object') {
      if (rawInputPathMentionsScratch(val, depth + 1)) return true;
    }
  }
  return false;
}

/** spec 133 — prefix-free hint labels from the same alphabet as the `f` mode. */
export function generateArtifactHintLabels(count: number): string[] {
  const chars = [...ARTIFACT_HINT_ALPHABET];
  if (count <= 0 || chars.length === 0) return [];
  let width = 1;
  let capacity = chars.length;
  while (capacity < count) {
    width += 1;
    capacity *= chars.length;
  }
  const labels: string[] = [];
  for (let index = 0; index < count; index++) {
    let value = index;
    let label = '';
    for (let digit = 0; digit < width; digit++) {
      label = chars[value % chars.length] + label;
      value = Math.floor(value / chars.length);
    }
    labels.push(label);
  }
  return labels;
}
