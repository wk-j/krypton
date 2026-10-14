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
  /** `timeline` plus the automatic-suggestions setting. */
  timelineSuggest: boolean;
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
  if (gates.timeline) names.push('timeline_record', 'timeline_merge');
  if (gates.timelineSuggest) names.push('timeline_suggest');
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
      '- timeline_record / timeline_merge: ONLY when the current human message explicitly asks to record or merge timeline items — that request is the confirmation. Call timeline_list first.',
    );
  }
  if (gates.timelineSuggest) {
    lines.push(
      '- timeline_suggest: at most once per turn, only for an explicit durable decision, requirement, or outcome.',
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
