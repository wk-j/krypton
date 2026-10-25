// Krypton — ACP Harness lane-context delivery (spec 289, trimmed by spec 332).
//
// The leading block of every `sendUserPrompt` turn is split in two:
//   - a small turn header (identity, tool-name line, volatile state, lesson
//     deltas, per-turn provenance), sent every turn, and
//   - the lane policy (tool index, peering, ticket pin, lessons, directive/role
//     block), sent only when the current agent session has not seen this exact
//     text. Lessons are tracked by content, not by the policy hash: a lesson
//     change after the policy went out rides the header as a delta.
// Tool descriptions carry each tool's full contract; the policy is an index.

/** Header-only turns between policy sends are capped so a silent compaction
 *  loses the rules for at most `POLICY_REFRESH_TURNS - 1` turns. */
export const POLICY_REFRESH_TURNS = 20;

/** A `usage_update` whose `used` falls by at least this fraction marks the
 *  policy stale: the adapter almost certainly compacted the history. */
export const COMPACTION_DROP_RATIO = 0.4;

/** Below this many used tokens a drop is ordinary noise, not a compaction. */
export const COMPACTION_MIN_USED = 20_000;

/** One lesson as the policy renders it: `- [slug] rule`. */
export interface LessonLine {
  slug: string;
  rule: string;
}

export interface PolicyDelivery {
  /** FNV-1a of the hashed policy text (lessons reduced to a marker) last sent. */
  hash: string;
  /** Header-only turns sent since that policy send. */
  turnsSince: number;
  /** Set when compaction may have dropped the policy from the agent's history. */
  stale: boolean;
  /** spec 332: slug → rule of every lesson this agent session has seen, through
   *  the policy block or a later header `Lessons update`. */
  lessons: ReadonlyMap<string, string>;
}

/** Lessons that differ from what the agent session has seen. */
export interface LessonsDelta {
  /** New slugs and slugs whose rule text changed. */
  changed: LessonLine[];
  /** Seen slugs that are no longer injected. */
  retired: string[];
}

export interface PolicyPlan {
  send: boolean;
  next: PolicyDelivery;
  /** Header-only turn whose lessons moved since the last delivery; null otherwise. */
  lessons: LessonsDelta | null;
}

/** Gates shared by the tool index (policy) and the tool-name line (header). */
export interface LaneToolGates {
  /** Local workspace and a backend that supports the timeline tools. */
  timeline: boolean;
  /** New automatic intake; legacy resolution remains available when disabled. */
  timelineAutomaticRecording: boolean;
  /** Legacy Timeline backlog. Rendered in the turn header while above 0 and
   *  never in the hashed policy, so a changing count does not resend it (spec 332). */
  timelinePendingCount: number;
  /** More than one lane in the harness. */
  peers: boolean;
  /** spec 298: `[acp_harness] lessons` on and a backend that can call tools. */
  lessons: boolean;
}

/** 32-bit FNV-1a, hex. Identity check only — never a security boundary. */
export function hashPolicy(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Decide whether this turn carries the policy, and the delivery state after it.
 *  `lessons` is the injectable set this turn would render. */
export function planPolicyDelivery(
  prev: PolicyDelivery | null,
  hash: string,
  lessons: readonly LessonLine[],
): PolicyPlan {
  const seen = new Map(lessons.map((lesson) => [lesson.slug, lesson.rule]));
  if (!prev || prev.hash !== hash || prev.stale || prev.turnsSince >= POLICY_REFRESH_TURNS - 1) {
    return { send: true, next: { hash, turnsSince: 0, stale: false, lessons: seen }, lessons: null };
  }
  const delta = diffLessons(prev.lessons, lessons);
  const moved = delta.changed.length > 0 || delta.retired.length > 0;
  return {
    send: false,
    next: { ...prev, turnsSince: prev.turnsSince + 1, lessons: seen },
    lessons: moved ? delta : null,
  };
}

export function diffLessons(seen: ReadonlyMap<string, string>, current: readonly LessonLine[]): LessonsDelta {
  const live = new Set(current.map((lesson) => lesson.slug));
  return {
    changed: current.filter((lesson) => seen.get(lesson.slug) !== lesson.rule),
    retired: [...seen.keys()].filter((slug) => !live.has(slug)),
  };
}

/** spec 332: backends whose system prompt names every mounted MCP tool on every
 *  request (OMP's `MCP Tool Routes`), so the header's tool-name line only repeats
 *  it. Spec 130's naming guarantee holds there without the line. */
const BACKENDS_LISTING_MCP_TOOLS: Record<string, true> = { omp: true };

export function backendListsMcpTools(backendId: string): boolean {
  return BACKENDS_LISTING_MCP_TOOLS[backendId] === true;
}

/** True when a context-usage reading fell sharply enough to mean compaction. */
export function isCompactionDrop(prevUsed: number | null, nextUsed: number | null): boolean {
  if (prevUsed === null || nextUsed === null) return false;
  if (prevUsed < COMPACTION_MIN_USED) return false;
  return nextUsed <= prevUsed * (1 - COMPACTION_DROP_RATIO);
}

/** Header line naming every Krypton tool the lane may need, so capped or
 *  deferred tool search can still target them by exact name (spec 130). */
export function renderToolNameLine(gates: LaneToolGates): string {
  const names = ['attention_flag', 'attention_resolve', 'mark_review_priority', 'artifact_new'];
  if (gates.timeline) names.push(
    'timeline_record', 'timeline_list', 'timeline_merge', 'timeline_pending_resolve',
    'timeline_conflict_list', 'timeline_conflict_record', 'timeline_conflict_checked',
  );
  if (gates.peers) names.push('peer_send', 'peer_list', 'review_outcome');
  if (gates.lessons) names.push('lesson_record', 'lesson_retire');
  return `Krypton tools (if not visible, search by exact name; rules are in each description): ${names.join(', ')}.`;
}

/** spec 332: the legacy Timeline backlog rides the header while it is above 0.
 *  The count changes as the lane resolves it, so it stays out of the hashed policy. */
export function renderTimelinePendingLine(gates: LaneToolGates): string | null {
  if (!gates.timeline || gates.timelinePendingCount <= 0) return null;
  return `Timeline legacy pending: ${gates.timelinePendingCount}. In this working turn read timeline_list { pending: true } and resolve each ID with timeline_pending_resolve (record / duplicate / discard), then continue the user's task; if only unreadable diagnostics remain, report them and stop retrying.`;
}

/** Policy-side index: when to reach for each tool. The full contract stays in
 *  the MCP tool descriptions. The attention line keeps spec 134's
 *  positive-trigger-first wording. */
export function renderToolIndex(gates: LaneToolGates): string {
  const lines = [
    "Krypton tools — each tool's description is its full contract; read it before the first call.",
    '- attention_flag: at the end of a turn where you hit a real fork — picked between viable approaches the user could decide differently on, guessed a consequential ambiguity in their intent, or did something costly or hard to undo — flag ONE decision, then keep working. Skip routine, reversible, machine-verifiable choices; never flag to cover yourself. attention_resolve if you settle it later.',
    '- mark_review_priority: optional, at most once, at the end of a turn where you edited files.',
  ];
  if (gates.timeline) {
    // spec 332: a trigger, not the contract. The descriptors carry the full rules
    // (spec 316:33) and the timeline_record result carries the conflict check.
    lines.push(gates.timelineAutomaticRecording
      ? '- timeline_*: you own durable project history — in ordinary working turns record evidence-backed requirements, decisions and observed outcomes yourself; this replaces older human-approval guidance (no approval queue, never attention_flag). Never write Timeline state in a read-only turn.'
      : '- timeline_*: automatic recording is off — record no new intake; legacy resolution and conflict verdicts stay yours, never a human approval queue. Never write Timeline state in a read-only turn.');
  }
  if (gates.peers) {
    lines.push('- review_outcome: once, after synthesizing a #review round you convened.');
  }
  if (gates.lessons) {
    lines.push(
      '- lesson_record / lesson_retire: when the human corrects you or a reviewer reports a blocker you caused, and the rule would hold in any project — update a listed lesson before adding one; retire one the human contradicts.',
    );
  }
  lines.push(
    '- artifact_new: ONLY when the user asks for a visual or interactive view.',
    "Write these tools' free-text fields in natural Thai for a reader who does not read code; keep technical terms, IDs, paths, and quoted source verbatim.",
  );
  return lines.join('\n');
}
