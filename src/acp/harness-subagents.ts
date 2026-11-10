// Krypton — ACP Harness subagent cards (spec 282) and OMP job lists (spec 370).
// The card payload `SubagentCard` (spec 302) paints, and the state changes the
// view applies to it: child tool calls, streamed output, `wait` job snapshots.
// The wire readers that build the payload live in `adapters/subagents.ts`
// (spec 380); this module reads only decoded payloads.

import type {
  JobLine,
  JobsPayload,
  SubagentEntry,
  SubagentPayload,
  SubagentStatus,
} from './harness-view-types';

const MAX_JOBS = 16;
/** Longest activity line or agent label a card keeps. Shared with the decoder. */
export const SUBAGENT_ACTIVITY_LIMIT = 160;
/** Output tail a card keeps per agent. Shared with the decoder. */
export const SUBAGENT_OUTPUT_LIMIT = 4 * 1024;
/** Recent tool names a card lists per agent. Shared with the decoder. */
export const SUBAGENT_RECENT_TOOLS = 3;

/** Keep the newest `limit` characters (a streaming output tail). */
export function outputTail(value: string, limit: number): string {
  return value.length > limit ? `…${value.slice(value.length - limit)}` : value;
}

// ─── Card state ───────────────────────────────────────────────────────────

export function mapSubagentStatus(value: unknown): SubagentStatus {
  switch (value) {
    case 'pending':
    case 'pendingInit':
      return 'pending';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'failed':
    case 'error':
    case 'errored':
    case 'aborted':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'shutdown':
    case 'interrupted':
      return 'cancelled';
    default:
      return 'running';
  }
}

const STATUS_RANK: Readonly<Record<SubagentStatus, number>> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

/** A larger count wins; unknown (null) never erases a known one. */
function maxCount(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * spec 370: OMP entries only move forward. The spawn's own `completed` frame
 * repeats the spawn-time snapshot (`pending`, zero counters) after later
 * frames reported `running`, and background frames report `durationMs: 0`
 * until the end. Status climbs pending → running → terminal and a terminal
 * entry keeps its first terminal status; counters never drop; an empty field
 * never erases a reported one.
 */
export function forwardSubagentEntry(prev: SubagentEntry, next: SubagentEntry): SubagentEntry {
  return {
    ...next,
    status: STATUS_RANK[next.status] > STATUS_RANK[prev.status] ? next.status : prev.status,
    activity: next.activity || prev.activity,
    recentTools: next.recentTools.length > 0 ? next.recentTools : prev.recentTools,
    toolCount: maxCount(prev.toolCount, next.toolCount),
    tokens: maxCount(prev.tokens, next.tokens),
    durationMs: maxCount(prev.durationMs, next.durationMs),
    task: next.task || prev.task,
    output: next.output || prev.output,
  };
}

/** Pending or running — the agent can still report. */
export function isLiveSubagent(entry: SubagentEntry): boolean {
  return entry.status === 'pending' || entry.status === 'running';
}

/** Claude: a child tool call ran inside the Task — record it on the card.
 *  `isNew` counts the call once; a later titled update only refreshes activity. */
export function absorbChildToolCall(payload: SubagentPayload, title: string, isNew: boolean): void {
  const entry = payload.agents[0];
  if (!entry) return;
  if (title) entry.activity = title.slice(0, SUBAGENT_ACTIVITY_LIMIT);
  if (!isNew) return;
  if (title) entry.recentTools = [...entry.recentTools, title.slice(0, 40)].slice(-SUBAGENT_RECENT_TOOLS);
  entry.toolCount = (entry.toolCount ?? 0) + 1;
}

/** Claude: subagent text streams into the card's output tail. */
export function appendChildOutput(payload: SubagentPayload, chunk: string): void {
  const entry = payload.agents[0];
  if (!entry || !chunk) return;
  entry.output = outputTail(entry.output + chunk, SUBAGENT_OUTPUT_LIMIT);
}

// ─── OMP background jobs (spec 370) ───────────────────────────────────────

/** One `wait` job. `agentId` and `output` route a task job into its card. */
export interface OmpJob extends JobLine {
  /** The card entry key: `agentUrlId` (the agent id), else the job id. */
  agentId: string;
  /** Task result body (`resultText`, else `errorText`), last 4 KB. */
  output: string;
}

export interface OmpJobs {
  jobs: OmpJob[];
  interrupted: boolean;
}

/** What the `wait` row paints: the display fields, capped. */
export function jobsPayload(parsed: OmpJobs): JobsPayload {
  return {
    jobs: parsed.jobs
      .slice(0, MAX_JOBS)
      .map(({ id, type, status, label, durationMs, exitCode }) => ({ id, type, status, label, durationMs, exitCode })),
    overflow: Math.max(0, parsed.jobs.length - MAX_JOBS),
    interrupted: parsed.interrupted,
  };
}

/**
 * spec 370: fold a snapshot's task jobs into an OMP card. Returns a new
 * payload, or null when no job names one of its agents or nothing moved. A job
 * missing from the snapshot changes nothing: OMP drops a job from later
 * snapshots once its result was consumed. Fresh data clears `lastReported`.
 */
export function applyOmpJobs(payload: SubagentPayload, jobs: readonly OmpJob[]): SubagentPayload | null {
  if (payload.source !== 'omp') return null;
  let matched = false;
  let changed = false;
  const agents = payload.agents.map((entry) => {
    const job = jobs.find((candidate) => candidate.type === 'task' && candidate.agentId === entry.id);
    if (!job) return entry;
    matched = true;
    const next = forwardSubagentEntry(entry, {
      ...entry,
      status: mapSubagentStatus(job.status),
      durationMs: job.durationMs,
      output: job.output,
    });
    if (next.status === entry.status && next.durationMs === entry.durationMs && next.output === entry.output) {
      return entry;
    }
    changed = true;
    return next;
  });
  if (!matched || (!changed && !payload.lastReported)) return null;
  return { ...payload, background: payload.background && agents.some(isLiveSubagent), lastReported: false, agents };
}

/** spec 370: the turn ended while the card's agents still run in the
 *  background. Null when there is nothing to mark. */
export function markLastReported(payload: SubagentPayload): SubagentPayload | null {
  if (payload.source !== 'omp' || !payload.background || payload.lastReported) return null;
  return { ...payload, lastReported: true };
}

/** spec 370: the `wait` head summary — counts per status, running first. */
export function jobsSummary(payload: JobsPayload): string {
  const labels: ReadonlyArray<readonly [JobLine['status'], string]> = [
    ['running', 'running'],
    ['completed', 'done'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ];
  const parts: string[] = [];
  for (const [status, label] of labels) {
    const n = payload.jobs.filter((job) => job.status === status).length;
    if (n > 0) parts.push(`${n} ${label}`);
  }
  if (payload.interrupted) parts.push('interrupted');
  return parts.length > 0 ? parts.join(' \u00b7 ') : 'no jobs';
}

// ─── Signature ────────────────────────────────────────────────────────────

/** Structural: changes here rebuild the subagent card. */
export function subagentStructureSignature(payload: SubagentPayload | undefined, expanded: readonly string[]): string {
  if (!payload) return '';
  const agents = payload.agents.map((a) => `${a.id}:${a.status}:${a.hintLabel ?? ''}`).join(',');
  const flags = `${payload.background ? 1 : 0}${payload.lastReported ? 1 : 0}`;
  return `${payload.source}|${flags}|${payload.overflow}|${agents}|${expanded.join(',')}`;
}

export function subagentSummary(payload: SubagentPayload): string {
  const total = payload.agents.length + payload.overflow;
  const done = payload.agents.filter((a) => !isLiveSubagent(a)).length;
  const background = payload.background ? ' \u00b7 background' : '';
  return `${done}/${total} done${background}${payload.lastReported ? ' \u00b7 last reported' : ''}`;
}
