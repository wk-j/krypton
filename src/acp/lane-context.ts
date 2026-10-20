// Krypton — ACP Harness lane-context delivery (spec 289).
//
// The leading block of every `sendUserPrompt` turn is split in two:
//   - a small turn header (identity + tool-name line + per-turn provenance),
//     sent every turn, and
//   - the lane policy (tool index, peering, ticket pin, directive/role block),
//     sent only when the current agent session has not seen this exact text.
// Tool descriptions carry each tool's full contract; the policy is an index.

/** Header-only turns between policy sends are capped so a silent compaction
 *  loses the rules for at most `POLICY_REFRESH_TURNS - 1` turns. */
export const POLICY_REFRESH_TURNS = 20;

/** A `usage_update` whose `used` falls by at least this fraction marks the
 *  policy stale: the adapter almost certainly compacted the history. */
export const COMPACTION_DROP_RATIO = 0.4;

/** Below this many used tokens a drop is ordinary noise, not a compaction. */
export const COMPACTION_MIN_USED = 20_000;

export interface PolicyDelivery {
  /** FNV-1a of the exact policy text last sent to this agent session. */
  hash: string;
  /** Header-only turns sent since that policy send. */
  turnsSince: number;
  /** Set when compaction may have dropped the policy from the agent's history. */
  stale: boolean;
}

export interface PolicyPlan {
  send: boolean;
  next: PolicyDelivery;
}

/** Gates shared by the tool index (policy) and the tool-name line (header). */
export interface LaneToolGates {
  /** Local workspace and a backend that supports the timeline tools. */
  timeline: boolean;
  /** New automatic intake; legacy resolution remains available when disabled. */
  timelineAutomaticRecording: boolean;
  /** Internal migration count, included in policy text so delivery hashes change. */
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

/** Decide whether this turn carries the policy, and the delivery state after it. */
export function planPolicyDelivery(prev: PolicyDelivery | null, hash: string): PolicyPlan {
  if (!prev || prev.hash !== hash || prev.stale || prev.turnsSince >= POLICY_REFRESH_TURNS - 1) {
    return { send: true, next: { hash, turnsSince: 0, stale: false } };
  }
  return { send: false, next: { ...prev, turnsSince: prev.turnsSince + 1 } };
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
    lines.push(
      '- Timeline ownership supersedes older human-approval guidance: manage durable project history yourself with timeline_record, timeline_list, timeline_merge, timeline_pending_resolve, timeline_conflict_list, timeline_conflict_record and timeline_conflict_checked. Never send Timeline decisions to attention_flag, ask-user, a form, or a human approval queue.',
      '- Respect explicit read-only scope (including trace): do not record, merge, resolve legacy intake, or write conflict verdicts/checkpoints as a side effect. Defer maintenance to an ordinary working turn that permits writes; never start another model turn.',
      gates.timelineAutomaticRecording
        ? '- Automatic recording is on: select evidence-backed durable requirements, decisions and observed outcomes during this working turn. Read timeline_list before the first record for a subject, reuse topic IDs, inspect event details for duplicates, and group related topics with timeline_merge when justified. Preserve exact evidence quotes and actors; skip routine status/tests and secrets. There is no once-per-turn recording cap.'
        : '- Automatic recording is off: do not record new intake. Legacy candidates still belong to you and may be recorded through timeline_pending_resolve.',
      `- Legacy pending count: ${gates.timelinePendingCount}. ` + (gates.timelinePendingCount > 0
        ? 'During this ordinary working turn, read timeline_list { pending: true }, inspect each candidate and supporting evidence, then resolve each ID with timeline_pending_resolve as record, duplicate (after reading the canonical event detail), or discard with a reason. Continue reading batches while actionable candidates remain until remaining_pending is zero; the conflict topic budget and policy refresh cadence do not cap migration. If only unreadable diagnostics remain, stop retrying, report the technical diagnostic and defer repair without claiming completion or asking the human to judge/approve items. Then continue the user task.'
        : 'No legacy intake currently reported; do not rescan the whole project each turn.'),
      '- After a record, follow its conflict_check continuation, compare only unchecked events, and record verdicts/checkpoints. A superseding policy needs an evidence-backed event; unresolved evidence gets insufficient_evidence, not a question to the human.',
    );
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
