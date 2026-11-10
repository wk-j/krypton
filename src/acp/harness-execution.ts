// Krypton — bounded, read-only OMP execution snapshots (spec 315): the card's
// state, timing and output split. `adapters/omp-execution.ts` builds the
// payload from the wire (spec 380).

import type { ExecutionPayload, ExecutionState, ExecutionView } from './harness-view-types';

/** ACP cancellation and execution errors outrank terminal success/background. */
export function executionState(payload: ExecutionPayload, status: string): ExecutionState {
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (payload.cellStatus === 'error' || payload.isError || (payload.exitCode !== null && payload.exitCode !== 0) || status === 'failed') return 'error';
  if (payload.detached?.state === 'running') return 'background';
  if (status === 'pending') return 'pending';
  if (status === 'completed') return 'complete';
  if (status === 'in_progress' || payload.cellStatus === 'running') return 'running';
  return payload.cellStatus === 'complete' ? 'complete' : 'running';
}

export const EXECUTION_STATE_LABEL: Readonly<Record<ExecutionState, string>> = {
  pending: 'Pending', running: 'Running', complete: 'Done', error: 'Error',
  cancelled: 'Cancelled', background: 'Background · last reported',
};

/** The call is in flight AND this client watched it start (not a replay). */
export function isExecutionLive(payload: ExecutionPayload, state: ExecutionState): boolean {
  return payload.observedLive && (state === 'pending' || state === 'running');
}

export interface ExecutionTiming {
  readonly visible: boolean;
  /** Advanced by the shared tool ticker from `startedAt`; frozen otherwise. */
  readonly live: boolean;
  readonly durationMs: number;
  readonly source: 'runtime' | 'observed';
}

const HIDDEN_TIMING: ExecutionTiming = { visible: false, live: false, durationMs: 0, source: 'observed' };

/**
 * Reported runtime wins once the call settles; otherwise the client's own
 * observation, and only for a call it saw live. A replay or a background
 * snapshot shows nothing rather than an invented zero.
 */
export function executionTiming(payload: ExecutionPayload, status: string, startedAt?: number, endedAt?: number): ExecutionTiming {
  const state = executionState(payload, status);
  const live = isExecutionLive(payload, state);
  const reported = !live && payload.durationMs !== null;
  if (state === 'background') return HIDDEN_TIMING;
  if (reported) return { visible: true, live: false, durationMs: payload.durationMs!, source: 'runtime' };
  if (!payload.observedLive || startedAt === undefined) return HIDDEN_TIMING;
  if (live) return { visible: true, live: true, durationMs: performance.now() - startedAt, source: 'observed' };
  return endedAt === undefined ? HIDDEN_TIMING : { visible: true, live: false, durationMs: endedAt - startedAt, source: 'observed' };
}

export type ExecutionOutputPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'view'; readonly view: ExecutionView };

/** Replace only unique, non-overlapping exact spans; otherwise keep raw text. */
export function executionOutputParts(payload: ExecutionPayload): readonly ExecutionOutputPart[] {
  const output = payload.output;
  if (output === null || output === '') return [];
  if (payload.truncated.includes('output') || payload.truncated.includes('views')) return [{ kind: 'text', text: output }];
  const matches: { start: number; end: number; view: ExecutionView }[] = [];
  for (const view of payload.views) {
    if (view.text === '') continue;
    const start = output.indexOf(view.text);
    if (start < 0 || output.indexOf(view.text, start + 1) !== -1) continue;
    matches.push({ start, end: start + view.text.length, view });
  }
  const safe = matches.filter((match) => !matches.some((other) => other !== match && match.start < other.end && other.start < match.end))
    .sort((a, b) => a.start - b.start);
  const parts: ExecutionOutputPart[] = [];
  let offset = 0;
  for (const match of safe) {
    if (match.start > offset) parts.push({ kind: 'text', text: output.slice(offset, match.start) });
    parts.push({ kind: 'view', view: match.view });
    offset = match.end;
  }
  if (offset < output.length) parts.push({ kind: 'text', text: output.slice(offset) });
  return parts;
}
