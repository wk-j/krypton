// Krypton — ACP Harness View: permission & artifact-path scanning.
//
// Extracted from acp-harness-view.ts (spec 204). Names the built-in harness
// tools and their families, picks permission options, and matches decoded
// tool paths against the artifact registry / scratch dir. Matching a wire
// permission request to a built-in tool (spec 96) and its args preview live in
// `adapters/permission.ts` (spec 380).

import type { ToolView } from './adapters/types';
import type { PermissionOption } from './types';
import type { HarnessToolFamily, PermissionPayload } from './harness-view-types';

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
// applies the computer profile's bypass/read-only policy before asking for
// separate exact-command approval (specs 318/385).
const HARNESS_COMPUTER_TOOL_NAMES = new Set(['computer_list', 'computer_exec']);
/** Every built-in harness tool that auto-allows. The lane decoder matches a
 *  permission request against this set by exact identity (spec 96). */
export const HARNESS_AUTO_ALLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...HARNESS_MEMORY_TOOL_NAMES,
  ...HARNESS_LESSON_TOOL_NAMES,
  ...HARNESS_PEER_TOOL_NAMES,
  ...HARNESS_ATTENTION_TOOL_NAMES,
  ...HARNESS_REVIEW_TOOL_NAMES,
  ...HARNESS_TIMELINE_TOOL_NAMES,
  ...HARNESS_ISSUE_TOOL_NAMES,
  ...HARNESS_COMPUTER_TOOL_NAMES,
]);
export function pickPermissionOption(options: PermissionOption[], action: 'accept' | 'reject'): PermissionOption | null {
  if (action === 'accept') {
    return options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always') ?? null;
  }
  return options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always') ?? null;
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

/** spec 133 — does a decoded tool view name a lane artifact scratch path? */
export function viewTargetsArtifactScratch(view: Pick<ToolView, 'modifiedPath' | 'locations' | 'inputPaths'>): boolean {
  return [view.modifiedPath, ...view.locations, ...view.inputPaths].some((path) => isArtifactScratchPath(path));
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
