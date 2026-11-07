// Krypton — ACP Harness subagent payloads (spec 282).
// Detects subagent-spawning tool calls from adapter data (never titles) and
// parses them into the payload `SubagentCard` (spec 302) paints:
//   OMP    — rawInput.tasks[] + rawOutput.details.{progress,results,async};
//            background jobs also report through `wait` snapshots
//            (rawOutput.details.jobs[], spec 370), routed to the card by agent id
//   Claude — _meta.claudeCode.toolName ∈ {Task, Agent}; children stamped with
//            _meta.claudeCode.parentToolUseId are absorbed by the view
//   Codex  — _meta.codex.collaboration.tool === 'spawnAgent'
// Adapter payloads are untrusted: each shape is checked once with a loose
// TypeBox schema, and every leaf is read through text()/count().

import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { ToolCall, ToolCallUpdate } from './types';
import type {
  JobLine,
  JobsPayload,
  SubagentEntry,
  SubagentPayload,
  SubagentStatus,
} from './harness-view-types';

const MAX_AGENTS = 16;
const MAX_JOBS = 16;
const ACTIVITY_LIMIT = 160;
const TASK_LIMIT = 2 * 1024;
const OUTPUT_LIMIT = 4 * 1024;
const RECENT_TOOLS = 3;

// ─── Boundary schemas (extra adapter fields allowed) ──────────────────────

const loose = <T extends Record<string, TSchema>>(props: T) => Type.Object(props, { additionalProperties: true });
const maybe = Type.Optional(Type.Unknown());

const OmpTask = loose({ task: Type.String(), name: maybe, agent: maybe });
const OmpInput = loose({ tasks: Type.Array(Type.Unknown()) });
const OmpProgress = loose({
  id: Type.String(),
  status: Type.String(),
  recentTools: Type.Array(Type.Unknown()),
  index: maybe,
  agent: maybe,
  lastIntent: maybe,
  description: maybe,
  task: maybe,
  assignment: maybe,
  toolCount: maybe,
  tokens: maybe,
  durationMs: maybe,
});
const OmpResult = loose({
  id: maybe,
  index: maybe,
  error: maybe,
  aborted: maybe,
  exitCode: maybe,
  output: maybe,
  tokens: maybe,
  durationMs: maybe,
});
const OmpRecentTool = loose({ tool: maybe, name: maybe, title: maybe });
const OmpOutput = loose({
  details: loose({
    progress: Type.Optional(Type.Array(Type.Unknown())),
    results: Type.Optional(Type.Array(Type.Unknown())),
    async: Type.Optional(loose({ state: maybe })),
  }),
});
const ClaudeMeta = loose({ claudeCode: loose({ toolName: maybe, parentToolUseId: maybe }) });
const ClaudeInput = loose({ description: maybe, subagent_type: maybe, prompt: maybe });
const CodexCollabMeta = loose({
  codex: loose({ collaboration: loose({ tool: maybe, receiverThreadIds: Type.Optional(Type.Array(Type.Unknown())) }) }),
});
const CodexSubagentMeta = loose({ codex: loose({ subagent: loose({ threadId: Type.String(), path: Type.String() }) }) });
const CodexInput = loose({ prompt: maybe, agentsStates: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
const CodexAgentState = loose({ status: maybe, message: maybe });
// spec 370: OMP `wait` result. `vibe_wait` reuses `op: "wait"` with another
// shape and IRC waits carry `waited` without `jobs`, so the job elements are
// what identify a background-jobs snapshot.
const OmpWaitOutput = loose({
  details: loose({ op: Type.Literal('wait'), jobs: Type.Array(Type.Unknown()), interrupted: maybe }),
});
const OmpJobSnapshot = loose({
  id: Type.String({ minLength: 1 }),
  type: Type.Union([Type.Literal('task'), Type.Literal('bash'), Type.Literal('eval')]),
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  durationMs: Type.Number(),
  label: maybe,
  exitCode: maybe,
  resultText: maybe,
  errorText: maybe,
  agentUrlId: maybe,
});

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Keep the newest `limit` characters (a streaming output tail). */
function tail(value: string, limit: number): string {
  return value.length > limit ? `…${value.slice(value.length - limit)}` : value;
}

// ─── Meta readers ─────────────────────────────────────────────────────────

/** Claude subagent output / child tool calls carry their Task call id here. */
export function claudeParentToolUseId(meta: unknown): string | null {
  if (!Value.Check(ClaudeMeta, meta)) return null;
  const id = meta.claudeCode.parentToolUseId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Codex `subAgentActivity` rows name a thread: `{ threadId, path }`. */
export function codexSubagentName(meta: unknown): { threadId: string; name: string } | null {
  if (!Value.Check(CodexSubagentMeta, meta)) return null;
  const { threadId, path } = meta.codex.subagent;
  const segments = path.split('/').filter(Boolean);
  const name = segments[segments.length - 1];
  return name ? { threadId, name } : null;
}

// ─── Parsing ──────────────────────────────────────────────────────────────

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

function blankEntry(id: string): SubagentEntry {
  return {
    id,
    agent: '',
    status: 'pending',
    activity: '',
    recentTools: [],
    toolCount: null,
    tokens: null,
    durationMs: null,
    task: '',
    output: '',
    hintLabel: null,
  };
}

function toolStatusToSubagent(status: string): SubagentStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'canceled' || status === 'cancelled') return 'cancelled';
  return status === 'pending' ? 'pending' : 'running';
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
function forwardEntry(prev: SubagentEntry, next: SubagentEntry): SubagentEntry {
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
function isLive(entry: SubagentEntry): boolean {
  return entry.status === 'pending' || entry.status === 'running';
}

function parseOmp(call: ToolCall | ToolCallUpdate, previous: SubagentPayload | undefined): SubagentPayload | null {
  const details = Value.Check(OmpOutput, call.rawOutput) ? call.rawOutput.details : null;
  const progress = (details?.progress ?? []).filter((p) => Value.Check(OmpProgress, p));
  const results = (details?.results ?? []).filter((r) => Value.Check(OmpResult, r));
  const tasks = Value.Check(OmpInput, call.rawInput)
    ? call.rawInput.tasks.filter((t) => Value.Check(OmpTask, t))
    : [];
  const carried = previous?.source === 'omp' ? previous : undefined;
  if (progress.length === 0 && tasks.length === 0 && results.length === 0) return carried ?? null;
  if (progress.length === 0 && tasks.length === 0 && !carried) return null;

  // Index-addressed: tasks[i] → progress.index === i → results by id/index.
  // A status-only / results-only update (no progress) builds on the previous
  // card — compaction may have dropped rawInput, and re-reading tasks would
  // reset every agent to pending.
  const byIndex = new Map<number, SubagentEntry>();
  if (progress.length === 0 && carried) {
    carried.agents.forEach((agent, i) => byIndex.set(i, { ...agent, recentTools: [...agent.recentTools] }));
  } else {
    tasks.forEach((task, i) => {
      const entry = blankEntry(text(task.name, ACTIVITY_LIMIT) || `task ${i + 1}`);
      entry.agent = text(task.agent, ACTIVITY_LIMIT);
      entry.task = text(task.task, TASK_LIMIT);
      byIndex.set(i, entry);
    });
  }
  progress.forEach((p, i) => {
    const index = count(p.index) ?? i;
    const entry = byIndex.get(index) ?? blankEntry(p.id);
    entry.id = p.id;
    entry.agent = text(p.agent, ACTIVITY_LIMIT) || entry.agent;
    entry.status = mapSubagentStatus(p.status);
    entry.activity = text(p.lastIntent, ACTIVITY_LIMIT) || text(p.description, ACTIVITY_LIMIT) || text(p.task, ACTIVITY_LIMIT);
    entry.recentTools = p.recentTools
      .map((tool) => (Value.Check(OmpRecentTool, tool) ? text(tool.tool ?? tool.name ?? tool.title, 40) : text(tool, 40)))
      .filter((name) => name.length > 0)
      .slice(-RECENT_TOOLS);
    entry.toolCount = count(p.toolCount);
    entry.tokens = count(p.tokens);
    entry.durationMs = count(p.durationMs);
    entry.task = text(p.assignment, TASK_LIMIT) || entry.task;
    byIndex.set(index, entry);
  });
  const entries = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  results.forEach((result, i) => {
    const entry = entries.find((e) => e.id === result.id) ?? entries[count(result.index) ?? i];
    if (!entry) return;
    const failed = typeof result.error === 'string' || result.aborted === true ||
      (typeof result.exitCode === 'number' && result.exitCode !== 0);
    entry.status = failed ? 'failed' : 'completed';
    entry.output = tail(text(result.output, Number.POSITIVE_INFINITY) || text(result.error, OUTPUT_LIMIT), OUTPUT_LIMIT);
    entry.tokens = count(result.tokens) ?? entry.tokens;
    entry.durationMs = count(result.durationMs) ?? entry.durationMs;
  });
  const background = details?.async ? details.async.state === 'running' : (carried?.background ?? false);
  const payload = finishPayload('omp', background, entries, previous);
  if (carried) {
    payload.agents = payload.agents.map((entry) => {
      const prev = carried.agents.find((old) => old.id === entry.id);
      return prev ? forwardEntry(prev, entry) : entry;
    });
  }
  // Background means agents still running; a late `async.state: running`
  // frame cannot reopen a card whose agents all settled.
  payload.background = payload.background && payload.agents.some(isLive);
  return payload;
}

function parseClaude(
  call: ToolCall | ToolCallUpdate,
  status: string,
  previous: SubagentPayload | undefined,
): SubagentPayload | null {
  const toolName = Value.Check(ClaudeMeta, call._meta) ? call._meta.claudeCode.toolName : undefined;
  if (toolName !== 'Task' && toolName !== 'Agent' && previous?.source !== 'claude') return null;
  const input = Value.Check(ClaudeInput, call.rawInput) ? call.rawInput : null;
  const prev = previous?.agents[0];
  const entry: SubagentEntry = {
    ...(prev ?? blankEntry('agent')),
    id: text(input?.description, ACTIVITY_LIMIT) || prev?.id || 'agent',
    agent: text(input?.subagent_type, ACTIVITY_LIMIT) || prev?.agent || '',
    task: text(input?.prompt, TASK_LIMIT) || prev?.task || '',
    status: toolStatusToSubagent(status),
  };
  const final = (call.content ?? [])
    .map((item) => (item.type === 'content' && item.content?.type === 'text' ? item.content.text : ''))
    .filter((value) => value.length > 0)
    .join('\n');
  if (final && (status === 'completed' || status === 'failed')) entry.output = tail(final, OUTPUT_LIMIT);
  return finishPayload('claude', false, [entry], previous);
}

function parseCodex(
  call: ToolCall | ToolCallUpdate,
  previous: SubagentPayload | undefined,
  names: ReadonlyMap<string, string>,
): SubagentPayload | null {
  if (!Value.Check(CodexCollabMeta, call._meta)) return previous?.source === 'codex' ? previous : null;
  const collab = call._meta.codex.collaboration;
  if (collab.tool !== 'spawnAgent') return null;
  const input = Value.Check(CodexInput, call.rawInput) ? call.rawInput : null;
  const receivers = (collab.receiverThreadIds ?? [])
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const entries = receivers.map((threadId) => {
    const entry = blankEntry(names.get(threadId) ?? `agent-${threadId.slice(-6)}`);
    const state = input?.agentsStates?.[threadId];
    if (Value.Check(CodexAgentState, state)) {
      entry.status = mapSubagentStatus(state.status);
      entry.output = tail(text(state.message, Number.POSITIVE_INFINITY), OUTPUT_LIMIT);
    } else {
      entry.status = 'running';
    }
    entry.task = text(input?.prompt, TASK_LIMIT);
    return entry;
  });
  return finishPayload('codex', false, entries, previous);
}

/** Unique ids, cap, and carry transient hint labels across rebuilds. */
function finishPayload(
  source: SubagentPayload['source'],
  background: boolean,
  entries: SubagentEntry[],
  previous: SubagentPayload | undefined,
): SubagentPayload {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const n = (seen.get(entry.id) ?? 0) + 1;
    seen.set(entry.id, n);
    if (n > 1) entry.id = `${entry.id}#${n}`;
    entry.hintLabel = previous?.agents.find((old) => old.id === entry.id)?.hintLabel ?? null;
  }
  return {
    source,
    background,
    agents: entries.slice(0, MAX_AGENTS),
    overflow: Math.max(0, entries.length - MAX_AGENTS),
  };
}

/** Build (or carry forward) the card payload for one merged tool call.
 *  Returns undefined when the call is not a subagent spawn. */
export function parseSubagentPayload(
  call: ToolCall | ToolCallUpdate,
  status: string,
  previous: SubagentPayload | undefined,
  codexNames: ReadonlyMap<string, string>,
): SubagentPayload | undefined {
  const payload = parseOmp(call, previous) ?? parseClaude(call, status, previous) ?? parseCodex(call, previous, codexNames);
  if (!payload) return undefined;
  // A finished foreground spawn settles every agent still marked live.
  const terminal = status === 'completed' || status === 'failed' || status === 'canceled';
  if (terminal && !payload.background) {
    // Rejected before any agent started (e.g. invalid input): nothing was
    // spawned, so the row stays a plain failed tool and shows its error.
    if (status === 'failed' && payload.agents.every((entry) => entry.status === 'pending')) return undefined;
    const settled = toolStatusToSubagent(status);
    for (const entry of payload.agents) {
      if (entry.status === 'running') entry.status = settled;
      // An agent that never started did not fail — it did not run.
      else if (entry.status === 'pending') entry.status = status === 'completed' ? 'completed' : 'cancelled';
    }
  }
  return payload;
}

/** Claude: a child tool call ran inside the Task — record it on the card.
 *  `isNew` counts the call once; a later titled update only refreshes activity. */
export function absorbChildToolCall(payload: SubagentPayload, title: string, isNew: boolean): void {
  const entry = payload.agents[0];
  if (!entry) return;
  if (title) entry.activity = title.slice(0, ACTIVITY_LIMIT);
  if (!isNew) return;
  if (title) entry.recentTools = [...entry.recentTools, title.slice(0, 40)].slice(-RECENT_TOOLS);
  entry.toolCount = (entry.toolCount ?? 0) + 1;
}

/** Claude: subagent text streams into the card's output tail. */
export function appendChildOutput(payload: SubagentPayload, chunk: string): void {
  const entry = payload.agents[0];
  if (!entry || !chunk) return;
  entry.output = tail(entry.output + chunk, OUTPUT_LIMIT);
}

/** spec 370: an OMP update carrying `details.async` — a background spawn
 *  reporting on its own call after the call already returned. */
export function isOmpBackgroundUpdate(rawOutput: unknown): boolean {
  return Value.Check(OmpOutput, rawOutput) && rawOutput.details.async !== undefined;
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

/** `<task-result>` envelope → the body of its `<output>` / `<preview>`, else
 *  `<error>`; text without an envelope is returned as is. */
function taskResultBody(value: string): string {
  for (const tag of ['output', 'preview', 'error']) {
    const open = new RegExp(`<${tag}\\b[^>]*>`).exec(value);
    if (!open) continue;
    const start = open.index + open[0].length;
    const end = value.lastIndexOf(`</${tag}>`);
    return end > start ? value.slice(start, end) : value.slice(start);
  }
  return value;
}

/** spec 370: the background-jobs snapshot of an OMP `wait` result, or null
 *  for any other shape (`vibe_wait`, IRC waits, ordinary tools). */
export function parseOmpJobs(rawOutput: unknown): OmpJobs | null {
  if (!Value.Check(OmpWaitOutput, rawOutput)) return null;
  const { jobs: raw, interrupted } = rawOutput.details;
  const jobs: OmpJob[] = [];
  for (const job of raw) {
    if (!Value.Check(OmpJobSnapshot, job)) continue;
    const result = job.type === 'task'
      ? text(job.resultText, Number.POSITIVE_INFINITY) || text(job.errorText, Number.POSITIVE_INFINITY)
      : '';
    jobs.push({
      id: job.id,
      type: job.type,
      status: job.status,
      label: text(job.label, ACTIVITY_LIMIT),
      durationMs: Math.max(0, job.durationMs),
      exitCode: count(job.exitCode),
      agentId: text(job.agentUrlId, ACTIVITY_LIMIT) || job.id,
      output: result ? tail(taskResultBody(result).trim(), OUTPUT_LIMIT) : '',
    });
  }
  if (jobs.length === 0 && raw.length > 0) return null;
  return { jobs, interrupted: interrupted === true };
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
    const next = forwardEntry(entry, {
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
  return { ...payload, background: payload.background && agents.some(isLive), lastReported: false, agents };
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
  const done = payload.agents.filter((a) => !isLive(a)).length;
  const background = payload.background ? ' \u00b7 background' : '';
  return `${done}/${total} done${background}${payload.lastReported ? ' \u00b7 last reported' : ''}`;
}

