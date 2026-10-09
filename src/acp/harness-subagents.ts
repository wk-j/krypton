// Krypton — ACP Harness subagent cards (spec 282).
// Detects subagent-spawning tool calls from adapter data (never titles) and
// renders them as a live per-agent card:
//   OMP    — rawInput.tasks[] + rawOutput.details.{progress,results,async}
//   Claude — _meta.claudeCode.toolName ∈ {Task, Agent}; children stamped with
//            _meta.claudeCode.parentToolUseId are absorbed by the view
//   Codex  — _meta.codex.collaboration.tool === 'spawnAgent'
// Adapter payloads are untrusted: each shape is checked once with a loose
// TypeBox schema, and every leaf is read through text()/count().

import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { ToolCall, ToolCallUpdate } from './types';
import type { SubagentEntry, SubagentPayload, SubagentStatus } from './harness-view-types';
import { formatToolElapsed } from './harness-tool-render';

const MAX_AGENTS = 16;
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
  return finishPayload('omp', background, entries, previous);
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
    const settled = toolStatusToSubagent(status);
    for (const entry of payload.agents) {
      if (entry.status === 'pending' || entry.status === 'running') entry.status = settled;
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

// ─── Signatures ───────────────────────────────────────────────────────────

/** Structural: changes here rebuild the whole tool row. */
export function subagentStructureSignature(payload: SubagentPayload | undefined, expanded: readonly string[]): string {
  if (!payload) return '';
  const agents = payload.agents.map((a) => `${a.id}:${a.status}:${a.hintLabel ?? ''}`).join(',');
  return `${payload.source}|${payload.background ? 1 : 0}|${payload.overflow}|${agents}|${expanded.join(',')}`;
}

/** Live fields patched in place while the tool is in flight. */
export function subagentLiveSignature(payload: SubagentPayload): string {
  return payload.agents
    .map((a) => [a.activity, a.recentTools.join('·'), a.toolCount ?? '', a.tokens ?? '', a.durationMs ?? '', a.output.length].join('\u001f'))
    .join('\u001e');
}

// ─── Rendering ────────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<SubagentStatus, string> = {
  pending: '○',
  running: '●',
  completed: '✓',
  failed: '✗',
  cancelled: '–',
};

export function subagentSummary(payload: SubagentPayload): string {
  const total = payload.agents.length + payload.overflow;
  const done = payload.agents.filter((a) => a.status !== 'pending' && a.status !== 'running').length;
  return `${done}/${total} done${payload.background ? ' · background' : ''}`;
}

function span(className: string, value: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = value;
  return el;
}

export function renderSubagentCard(payload: SubagentPayload, expanded: readonly string[]): HTMLElement {
  const card = document.createElement('div');
  card.className = 'acp-harness__subagents';
  card.dataset.background = payload.background ? '1' : '0';
  for (const agent of payload.agents) {
    const row = document.createElement('div');
    row.className = `acp-harness__subagent acp-harness__subagent--${agent.status}`;
    if (agent.hintLabel) row.classList.add('acp-harness__subagent--hinted');
    row.dataset.subagentId = agent.id;
    const line = document.createElement('div');
    line.className = 'acp-harness__subagent-line';
    if (agent.hintLabel) line.appendChild(span('acp-harness__subagent-hint', agent.hintLabel));
    line.appendChild(span('acp-harness__subagent-glyph', STATUS_GLYPH[agent.status]));
    line.appendChild(span('acp-harness__subagent-name', agent.id));
    if (agent.agent) line.appendChild(span('acp-harness__subagent-agent', agent.agent));
    line.appendChild(span('acp-harness__subagent-activity', agent.activity));
    const stats = [
      agent.toolCount !== null ? `${agent.toolCount} tools` : '',
      agent.tokens === null ? '' : agent.tokens >= 1000 ? `${Math.round(agent.tokens / 1000)}k tok` : `${agent.tokens} tok`,
      agent.durationMs !== null && agent.durationMs > 0 ? formatToolElapsed(agent.durationMs) : '',
    ].filter(Boolean).join(' · ');
    line.appendChild(span('acp-harness__subagent-stats', stats));
    row.appendChild(line);
    if (agent.recentTools.length > 0 && (agent.status === 'running' || agent.status === 'pending')) {
      row.appendChild(span('acp-harness__subagent-tools', `↳ ${agent.recentTools.join(' · ')}`));
    }
    if (expanded.includes(agent.id)) {
      const detail = document.createElement('div');
      detail.className = 'acp-harness__subagent-detail';
      for (const [label, value] of [['TASK', agent.task], ['OUTPUT', agent.output]] as const) {
        if (!value) continue;
        detail.appendChild(span('acp-harness__subagent-detail-label', label));
        const body = document.createElement('pre');
        body.className = 'acp-harness__subagent-detail-text';
        body.textContent = value;
        detail.appendChild(body);
      }
      if (!agent.task && !agent.output) detail.appendChild(span('acp-harness__subagent-detail-label', 'no task or output yet'));
      row.appendChild(detail);
    }
    card.appendChild(row);
  }
  if (payload.overflow > 0) {
    card.appendChild(span('acp-harness__subagent-more', `+${payload.overflow} more`));
  }
  return card;
}
