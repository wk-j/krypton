// Spec 380 — Codex (`@agentclientprotocol/codex-acp`, backend id `codex`).

import { isCodexGuardianReview, parseGuardianReview } from './codex-guardian';
import { codexSubagentName } from './subagents';
import { UNVERIFIED_SUPPLIES } from './generic';
import { applySubagentCard, clearSections } from './tool';
import type { LaneAdapter, ToolStep } from './types';

/** spec 278: `_meta.codex.threadStatus.type` → turn state; anything else → null. */
export function codexThreadState(meta: unknown): 'active' | 'idle' | null {
  if (!meta || typeof meta !== 'object') return null;
  const codex = (meta as { codex?: unknown }).codex;
  if (!codex || typeof codex !== 'object') return null;
  const status = (codex as { threadStatus?: unknown }).threadStatus;
  if (!status || typeof status !== 'object') return null;
  const type = (status as { type?: unknown }).type;
  return type === 'active' || type === 'idle' ? type : null;
}

export const codexAdapter: LaneAdapter = {
  id: 'codex',
  supplies: UNVERIFIED_SUPPLIES,
  // spec 278: only codex-acp's thread status is consumed from `session_info_update`.
  turnState: (update) => codexThreadState(update._meta),
  tool(step: ToolStep): void {
    const { draft, merged } = step;
    // spec 378: the dedicated row owns the bounded assessment; no output copy.
    if (isCodexGuardianReview('codex', merged)) {
      draft.guardianReview = parseGuardianReview(merged, step.prior?.guardianReview, draft.status);
      clearSections(draft);
      draft.diffs = [];
    }
    // spec 282: `subAgentActivity` rows name a thread; the name outlives the call.
    const named = codexSubagentName(step.call._meta);
    if (named) step.agentNames.set(named.threadId, named.name);
    applySubagentCard(step);
  },
};
