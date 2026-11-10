// Spec 380 — Oh My Pi (`omp acp`, backend id `omp`).

import { jobsPayload } from '../harness-subagents';
import { cleanToolTitle } from '../harness-tool-render';
import { UNVERIFIED_SUPPLIES } from './generic';
import { parseExecutionPayload } from './omp-execution';
import { isOmpBackgroundUpdate, parseOmpJobs } from './subagents';
import { applySubagentCard, clearSections, isTerminalState } from './tool';
import type { LaneAdapter, ToolState, ToolStep } from './types';

export const ompAdapter: LaneAdapter = {
  id: 'omp',
  // No `turnState` hook: Krypton reads thread state from codex-acp only.
  supplies: { ...UNVERIFIED_SUPPLIES, turnState: 'no' },
  // spec 370: a background spawn keeps reporting on its own call after it
  // returned. Those `in_progress` frames refresh the card; they never reopen it.
  toolStatus(step: ToolStep, wire: ToolState): ToolState {
    const prior = step.prior?.status;
    return prior && isTerminalState(prior) && !isTerminalState(wire) && isOmpBackgroundUpdate(step.call.rawOutput)
      ? prior
      : wire;
  },
  tool(step: ToolStep): void {
    const { draft, merged, call, prior } = step;
    if (applySubagentCard(step)) return;
    // spec 315: a code cell, decoded from the update before compaction drops it.
    const execution = parseExecutionPayload('omp', call, prior?.execution);
    if (execution) {
      draft.execution = execution;
      return;
    }
    // spec 370: a `wait` paints its structured job snapshot, never the model-facing text.
    const parsed = parseOmpJobs(merged.rawOutput);
    const jobs = parsed ? jobsPayload(parsed) : prior?.jobs;
    if (!jobs) return;
    draft.jobs = jobs;
    draft.kind = 'wait';
    draft.subject = cleanToolTitle(merged.title, 'wait') || draft.subject;
    clearSections(draft);
    // Only a frame that carried the snapshot is news for the other cards.
    if (parsed && call.rawOutput !== undefined) step.jobsReport = parsed.jobs;
  },
};
