import type { RemoteCommandPayload } from './harness-view-types';

export type RemoteCommandState = 'pending' | 'running' | 'done' | 'completed' | 'failed' | 'unknown' | 'cancelled' | 'not-run';
export interface RemoteCommandStateView {
  readonly state: RemoteCommandState;
  readonly label: string;
}

const STATES = {
  pending: { state: 'pending', label: 'Pending' },
  running: { state: 'running', label: 'In progress' },
  completed: { state: 'completed', label: 'Completed · exit not reported' },
  done: { state: 'done', label: 'Done · exit 0' },
  failed: { state: 'failed', label: 'Tool failed' },
  unknown: { state: 'unknown', label: 'Outcome unknown' },
  cancelled: { state: 'cancelled', label: 'Cancelled · remote outcome unconfirmed' },
  'not-run': { state: 'not-run', label: 'Not run' },
} as const satisfies Record<RemoteCommandState, RemoteCommandStateView>;

export function remoteCommandState(payload: RemoteCommandPayload, status: string): RemoteCommandStateView {
  if (payload.outcomeUnknown || payload.result?.outcome === 'unknown') return STATES.unknown;
  if (payload.error === 'Remote command declined or approval expired') return STATES['not-run'];
  const result = payload.result;
  if (result && result.exitCode !== null && result.exitCode !== 0) {
    return { state: 'failed', label: `Failed · exit ${result.exitCode}` };
  }
  // The transport can fail after an earlier successful result snapshot.
  if (status === 'failed' || payload.error) return STATES.failed;
  if (result) return result.exitCode === 0 ? STATES.done : STATES.completed;
  if (status === 'cancelled' || status === 'canceled') return STATES.cancelled;
  if (status === 'completed') return { state: 'completed', label: 'Remote result not reported' };
  return status === 'pending' ? STATES.pending : STATES.running;
}

/** A stale in-flight replay frame cannot reopen a settled owning component. */
export function remoteCommandStatus(previous: string | null, next: string): string {
  return previous !== null && previous !== 'pending' && previous !== 'in_progress'
    && (next === 'pending' || next === 'in_progress') ? previous : next;
}

export interface RemoteCommandPreview {
  readonly streams: readonly { readonly stream: 'stdout' | 'stderr'; readonly text: string }[];
  readonly more: boolean;
}

export function remoteCommandPreview(payload: RemoteCommandPayload, status: string): RemoteCommandPreview {
  const result = payload.result;
  if (!result) return { streams: [], more: false };
  const state = remoteCommandState(payload, status).state;
  const order = state === 'failed' || state === 'unknown' ? ['stderr', 'stdout'] as const : ['stdout', 'stderr'] as const;
  let remaining = 4;
  let more = false;
  const streams: { stream: 'stdout' | 'stderr'; text: string }[] = [];
  for (const stream of order) {
    if (!result[stream]) continue;
    const lines = result[stream].split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length > remaining) more = true;
    if (remaining > 0) streams.push({ stream, text: lines.slice(0, remaining).join('\n') });
    remaining = Math.max(0, remaining - lines.length);
  }
  return { streams, more };
}

export function remoteCommandLimitNotes(payload: RemoteCommandPayload): string {
  const notes: string[] = [];
  if (payload.result?.truncated) notes.push('Backend output limit reached.');
  if (payload.displayTruncated.length) notes.push(`Display limit reached: ${payload.displayTruncated.join(', ')}.`);
  return notes.join(' ');
}
