// Krypton — ACP Harness View: permission & artifact-path scanning.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Decides whether a
// permission request is a built-in harness-bus tool call (auto-allowed), builds
// the human-readable args preview, and matches tool-call paths against the
// artifact registry / scratch dir.

import type { PermissionOption, ToolCall, ToolCallUpdate } from './types';
import type {
  HarnessPermission,
  HarnessToolFamily,
  PermissionPayload,
} from './harness-view-types';
import { truncate } from './harness-format';
import { extractModifiedPath } from './acp-harness-memory';

const MEMORY_PERMISSION_SCAN_DEPTH = 8;
/** specs 133/206 — alphabet shared by artifact and response-reference hints. */
export const ARTIFACT_HINT_ALPHABET = 'asdfghjklqweruiop';

const HARNESS_MEMORY_TOOL_NAMES = new Set(['handoff_set', 'handoff_get', 'handoff_list']);
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
// spec 178: issue_progress is default-on built-in harness-bus tooling — the lane
// reports github issue-fixing progress to refresh the live status card. It must
// auto-allow like the others; a permission prompt on every progress report would
// defeat the live-overlay story (and the report is advisory, never destructive).
const HARNESS_ISSUE_TOOL_NAMES = new Set(['issue_progress']);
const HARNESS_AUTO_ALLOW_TOOL_NAMES = new Set([
  ...HARNESS_MEMORY_TOOL_NAMES,
  ...HARNESS_PEER_TOOL_NAMES,
  ...HARNESS_ATTENTION_TOOL_NAMES,
  ...HARNESS_REVIEW_TOOL_NAMES,
  ...HARNESS_ISSUE_TOOL_NAMES,
]);
const HARNESS_SERVER_MARKERS = ['krypton-harness-bus', 'krypton_harness_bus', 'krypton-harness-memory', 'krypton_harness_memory', '/mcp/harness/'];

export function pickPermissionOption(options: PermissionOption[], action: 'accept' | 'reject'): PermissionOption | null {
  if (action === 'accept') {
    return options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always') ?? null;
  }
  return options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always') ?? null;
}

export function harnessAutoAllowToolName(permission: Pick<HarnessPermission, 'toolCall' | 'options'>): string | null {
  const call = permission.toolCall;
  const optionNames = (permission.options ?? [])
    .map((option) => option.name)
    .filter((name): name is string => typeof name === 'string');
  const hasServerMarker = containsHarnessServerMarker(call)
    || optionNames.some((name) => HARNESS_SERVER_MARKERS.some((marker) => name.includes(marker)));
  if (!hasServerMarker) return null;
  return structuredHarnessToolNameFromUnknown(call.rawInput)
    ?? harnessToolNameFromUnknown(call.rawInput)
    ?? harnessToolNameFromString(call.title)
    ?? harnessToolNameFromUnknown(call.content)
    ?? harnessToolNameFromOptionLabels(optionNames)
    ?? null;
}

export function harnessToolNameFromOptionLabels(names: string[]): string | null {
  for (const name of names) {
    const match = harnessToolNameFromString(name);
    if (match) return match;
  }
  return null;
}

export function structuredHarnessToolNameFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return null;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = structuredHarnessToolNameFromUnknown(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'toolName', 'tool_name', 'tool']) {
    const value = record[key];
    if (typeof value === 'string') {
      const match = harnessToolNameFromString(value);
      if (match) return match;
    }
  }
  for (const item of Object.values(record)) {
    const match = structuredHarnessToolNameFromUnknown(item, depth + 1);
    if (match) return match;
  }
  return null;
}

export function harnessToolNameFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return null;
  if (typeof value === 'string') return harnessToolNameFromString(value);
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = harnessToolNameFromUnknown(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'toolName', 'tool_name', 'tool', 'title', 'text']) {
    const match = harnessToolNameFromUnknown(record[key], depth + 1);
    if (match) return match;
  }
  const content = record.content;
  if (typeof content === 'string') return harnessToolNameFromString(content);
  if (content && typeof content === 'object') {
    const match = harnessToolNameFromUnknown(content, depth + 1);
    if (match) return match;
  }
  return null;
}

export function harnessToolNameFromString(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  for (const toolName of HARNESS_AUTO_ALLOW_TOOL_NAMES) {
    if (normalized === toolName || normalized.endsWith(`__${toolName}`)) return toolName;
  }
  const match = normalized.match(/(?:^|[^a-z0-9_])(handoff_set|handoff_get|handoff_list|peer_send|peer_list|attention_flag|attention_resolve|review_outcome)(?:$|[^a-z0-9_])/);
  return match && HARNESS_AUTO_ALLOW_TOOL_NAMES.has(match[1]) ? match[1] : null;
}

export function harnessToolFamily(toolName: string): HarnessToolFamily | null {
  if (HARNESS_MEMORY_TOOL_NAMES.has(toolName)) return 'memory';
  if (HARNESS_PEER_TOOL_NAMES.has(toolName)) return 'peer';
  if (HARNESS_ATTENTION_TOOL_NAMES.has(toolName)) return 'attention';
  if (HARNESS_REVIEW_TOOL_NAMES.has(toolName)) return 'review';
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

export function containsHarnessServerMarker(value: unknown, depth = 0): boolean {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return false;
  if (typeof value === 'string') return HARNESS_SERVER_MARKERS.some((marker) => value.includes(marker));
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsHarnessServerMarker(item, depth + 1));
  return Object.values(value as Record<string, unknown>).some((item) => containsHarnessServerMarker(item, depth + 1));
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
