// Krypton — bounded, read-only OMP execution snapshots (spec 315).

import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { ExecutionActivity, ExecutionPayload, ExecutionState, ExecutionView } from './harness-view-types';
import type { ToolCall, ToolCallUpdate } from './types';

const loose = <T extends Record<string, TSchema>>(props: T): TObject<T> =>
  Type.Object(props, { additionalProperties: true });
const maybe = Type.Optional(Type.Unknown());
const Input = loose({ language: Type.Union([Type.Literal('py'), Type.Literal('js')]), code: Type.String(), title: maybe });
const Cell = loose({
  language: Type.Union([Type.Literal('py'), Type.Literal('python'), Type.Literal('js')]),
  code: Type.String(), title: maybe, output: maybe, status: maybe,
  durationMs: maybe, exitCode: maybe, statusEvents: maybe, views: maybe,
});
const Output = loose({ details: loose({ cells: maybe, isError: maybe, async: maybe }) });
const Event = loose({ op: Type.String(), title: maybe, message: maybe });
const View = loose({ text: Type.String(), view: loose({ kind: Type.String(), value: maybe, columns: maybe, rows: maybe }) });
const Column = loose({ head: Type.String(), numeric: maybe });
const Async = loose({ state: Type.String(), jobId: Type.String() });
const Content = loose({ content: Type.Array(Type.Unknown()) });
const Text = loose({ type: Type.Literal('text'), text: Type.String() });

const CODE_LIMIT = 16 * 1024;
const OUTPUT_LIMIT = 24 * 1024;
const ACTIVITY_LIMIT = 4 * 1024;
const VIEW_LIMIT = 16 * 1024;
const TOTAL_LIMIT = 64 * 1024;
const MARKER = '\n… truncated …\n';
type Truncation = ExecutionPayload['truncated'][number];

function bounded(value: string, limit: number, tail: boolean = false): string {
  if (value.length <= limit) return value;
  if (limit <= MARKER.length) return MARKER.slice(0, limit);
  const keep = limit - MARKER.length;
  return tail ? MARKER + value.slice(value.length - keep) : value.slice(0, keep) + MARKER;
}

function title(value: unknown): string {
  return typeof value === 'string' ? bounded(value.trim(), 256) : '';
}

function serialized(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2) ?? null;
  } catch {
    return null;
  }
}

function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function exitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function cellStatus(value: unknown): ExecutionPayload['cellStatus'] {
  return value === 'pending' || value === 'running' || value === 'complete' || value === 'error' ? value : null;
}

function sameActivity(a: ExecutionActivity, b: ExecutionActivity): boolean {
  return a.op === b.op && a.text === b.text && a.detail === b.detail;
}

function sameView(a: ExecutionView, b: ExecutionView): boolean {
  if (a.kind !== b.kind || a.text !== b.text) return false;
  if (a.kind === 'json') return b.kind === 'json' && a.json === b.json;
  return b.kind === 'table' && a.columns.length === b.columns.length &&
    a.columns.every((column, index) => column.head === b.columns[index].head && column.numeric === b.columns[index].numeric) &&
    a.rows.length === b.rows.length && a.rows.every((row, index) =>
      row.length === b.rows[index].length && row.every((value, cell) => value === b.rows[index][cell]));
}

function stableArray<T>(next: readonly T[], previous: readonly T[] | undefined, equal: (a: T, b: T) => boolean): readonly T[] {
  if (!previous) return next;
  if (next.length === previous.length && next.every((item, index) => equal(item, previous[index]))) return previous;
  return next.map((item, index) => previous[index] !== undefined && equal(item, previous[index]) ? previous[index] : item);
}

function activityStrings(events: readonly ExecutionActivity[]): number {
  return events.reduce((size, event) => size + event.op.length + event.text.length + event.detail.length, 0);
}

function viewStrings(views: readonly ExecutionView[]): number {
  return views.reduce((size, view) => size + view.kind.length + view.text.length + (view.kind === 'json'
    ? view.json.length
    : view.columns.reduce((sum, column) => sum + column.head.length, 0) +
      view.rows.reduce((sum, row) => sum + row.reduce((cells, value) => cells + value.length, 0), 0)), 0);
}

function parseActivity(value: unknown, truncated: Set<Truncation>): readonly ExecutionActivity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: ExecutionActivity[] = [];
  let remaining = ACTIVITY_LIMIT;
  if (value.length > 16) truncated.add('activity');
  // Work backwards so the last reported activity survives the byte budget.
  for (let index = value.length - 1; index >= Math.max(0, value.length - 16); index--) {
    const event: unknown = value[index];
    if (!Value.Check(Event, event)) continue;
    const op = bounded(event.op, 32);
    const text = event.op === 'phase' && typeof event.title === 'string' ? event.title
      : event.op === 'log' && typeof event.message === 'string' ? event.message : '';
    const detail = event.op === 'phase' || event.op === 'log' ? '' : serialized(event) ?? '';
    if (remaining < op.length + MARKER.length) {
      truncated.add('activity');
      break;
    }
    const keptText = bounded(text, remaining - op.length, true);
    const keptDetail = bounded(detail, remaining - op.length - keptText.length, true);
    if (op !== event.op || keptText !== text || keptDetail !== detail) truncated.add('activity');
    const normalized = { op, text: keptText, detail: keptDetail };
    events.unshift(normalized);
    remaining -= op.length + keptText.length + keptDetail.length;
  }
  // A dropped tail-prefix needs a visible marker even if every retained event fit.
  if (truncated.has('activity') && events.length > 0 && !events.some((event) => event.text.includes(MARKER) || event.detail.includes(MARKER))) {
    const first = events[0];
    const room = ACTIVITY_LIMIT - activityStrings(events) + first.text.length;
    events[0] = { ...first, text: bounded(MARKER + first.text, room) };
  }
  return events;
}

function parseViews(value: unknown, truncated: Set<Truncation>): readonly ExecutionView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const views: ExecutionView[] = [];
  let remaining = VIEW_LIMIT;
  if (value.length > 8) truncated.add('views');
  for (const entry of value.slice(0, 8)) {
    if (!Value.Check(View, entry)) continue;
    let normalized: ExecutionView;
    if (entry.view.kind === 'json') {
      const json = serialized(entry.view.value);
      if (json === null) continue;
      if (entry.text.length + 'json'.length + MARKER.length > remaining) {
        truncated.add('views');
        continue;
      }
      const keptJson = bounded(json, remaining - entry.text.length - 'json'.length);
      if (keptJson !== json) truncated.add('views');
      normalized = { kind: 'json', text: entry.text, json: keptJson };
    } else if (entry.view.kind === 'table') {
      if (!Array.isArray(entry.view.columns) || !Array.isArray(entry.view.rows)) continue;
      const columns: { head: string; numeric?: boolean }[] = [];
      let malformed = false;
      for (const column of entry.view.columns) {
        if (!Value.Check(Column, column) || (column.numeric !== undefined && typeof column.numeric !== 'boolean')) {
          malformed = true;
          break;
        }
        if (columns.length < 20) {
          const head = bounded(column.head, 256);
          if (head !== column.head) truncated.add('views');
          columns.push(column.numeric === undefined ? { head } : { head, numeric: column.numeric });
        }
      }
      const rows: string[][] = [];
      for (const row of entry.view.rows) {
        if (!Array.isArray(row) || row.length !== entry.view.columns.length || !row.every((cell: unknown) => typeof cell === 'string')) {
          malformed = true;
          break;
        }
        if (rows.length < 100) {
          rows.push(row.slice(0, 20).map((cell: string) => {
            const kept = bounded(cell, 256);
            if (kept !== cell) truncated.add('views');
            return kept;
          }));
        }
      }
      if (malformed || columns.length === 0) continue;
      if (entry.view.columns.length > 20 || entry.view.rows.length > 100) truncated.add('views');
      normalized = { kind: 'table', text: entry.text, columns, rows };
      if (viewStrings([normalized]) > remaining) {
        truncated.add('views');
        continue;
      }
    } else {
      continue;
    }
    remaining -= viewStrings([normalized]);
    views.push(normalized);
  }
  return views;
}

/** Only raw output is eligible: ACP content can be an echo of the source. */
function genericOutput(raw: unknown): string | null {
  if (typeof raw === 'string') return bounded(raw, OUTPUT_LIMIT, true);
  if (Value.Check(Content, raw)) {
    const parts: string[] = [];
    let remaining = OUTPUT_LIMIT;
    for (let index = raw.content.length - 1; index >= 0 && remaining > 0; index--) {
      const part: unknown = raw.content[index];
      if (!Value.Check(Text, part)) continue;
      if (parts.length > 0) {
        if (remaining <= 1) break;
        parts.unshift('\n');
        remaining--;
      }
      const text = bounded(part.text, remaining, true);
      parts.unshift(text);
      remaining -= text.length;
    }
    return parts.join('');
  }
  const text = serialized(raw);
  return text === null ? null : bounded(text, OUTPUT_LIMIT, true);
}

/** Decode the fresh incoming update before wire retention compacts it. */
export function parseExecutionPayload(
  backendId: string,
  update: ToolCall | ToolCallUpdate,
  previous?: ExecutionPayload,
): ExecutionPayload | undefined {
  if (backendId !== 'omp') return undefined;
  const input = (update.kind === 'execute' || (previous !== undefined && update.kind === undefined)) &&
    Value.Check(Input, update.rawInput) ? update.rawInput : null;
  const details = Value.Check(Output, update.rawOutput) ? update.rawOutput.details : null;
  const cells = details?.cells;
  const cell = Array.isArray(cells) && cells.length === 1 && Value.Check(Cell, cells[0]) ? cells[0] : null;
  if (!previous && (!input && (!cell || (update.kind !== undefined && update.kind !== 'execute')))) return undefined;

  const truncated = new Set<Truncation>(previous?.truncated);
  const language = input?.language ?? (cell?.language === 'python' ? 'py' : cell?.language) ?? previous?.language;
  if (!language) return undefined;
  const source = input?.code ?? cell?.code;
  const code = source === undefined ? previous?.code ?? '' : bounded(source, CODE_LIMIT);
  if (source !== undefined) {
    truncated.delete('code');
    if (code !== source) truncated.add('code');
  }
  const label = title(input?.title) || title(cell?.title) || previous?.title ||
    (language === 'py' ? 'Python execution' : 'JavaScript execution');
  let output = previous?.output ?? null;
  let activity = previous?.activity ?? [];
  let views = previous?.views ?? [];
  if (typeof cell?.output === 'string') {
    output = bounded(cell.output, OUTPUT_LIMIT, true);
    truncated.delete('output');
    if (output !== cell.output) truncated.add('output');
  }
  if (Array.isArray(cell?.statusEvents)) {
    truncated.delete('activity');
    activity = parseActivity(cell.statusEvents, truncated) ?? activity;
  }
  if (Array.isArray(cell?.views)) {
    truncated.delete('views');
    views = parseViews(cell.views, truncated) ?? views;
  }
  const isError = typeof details?.isError === 'boolean' ? details.isError : previous?.isError ?? false;
  if (!cell && update.rawOutput !== undefined && (update.status === 'failed' || isError)) {
    output = genericOutput(update.rawOutput);
    activity = [];
    views = [];
    truncated.delete('activity');
    truncated.delete('views');
    truncated.delete('output');
    if (output?.includes(MARKER)) truncated.add('output');
  }
  let detached = previous?.detached ?? null;
  if (details?.async === null) detached = null;
  else if (Value.Check(Async, details?.async) && details.async.jobId.trim() && details.async.state.trim()) {
    const next = { jobId: bounded(details.async.jobId.trim(), 128), state: bounded(details.async.state.trim(), 32) };
    detached = previous?.detached?.jobId === next.jobId && previous.detached.state === next.state ? previous.detached : next;
  }

  // The category caps total 60K, leaving room for scalar labels and markers.
  // Still compute the remaining budget explicitly so every retained string counts.
  const scalarSize = 'omp'.length + language.length + label.length + code.length + (output?.length ?? 0) +
    (detached ? detached.jobId.length + detached.state.length : 0) + 128;
  while (views.length > 0 && scalarSize + activityStrings(activity) + viewStrings(views) > TOTAL_LIMIT) {
    views = views.slice(0, -1);
    truncated.add('views');
  }
  while (activity.length > 0 && scalarSize + activityStrings(activity) > TOTAL_LIMIT) {
    activity = activity.slice(1);
    truncated.add('activity');
  }
  activity = stableArray(activity, previous?.activity, sameActivity);
  views = stableArray(views, previous?.views, sameView);
  const flags = stableArray<Truncation>(
    (['code', 'output', 'activity', 'views'] as const).filter((flag) => truncated.has(flag)),
    previous?.truncated, (a, b) => a === b,
  );
  const next: ExecutionPayload = {
    source: 'omp', language, title: label, code, output,
    observedLive: previous?.observedLive === true || update.status === 'pending' || update.status === 'in_progress',
    cellStatus: cellStatus(cell?.status) ?? previous?.cellStatus ?? null,
    durationMs: duration(cell?.durationMs) ?? previous?.durationMs ?? null,
    exitCode: exitCode(cell?.exitCode) ?? previous?.exitCode ?? null,
    isError, activity, views, detached, truncated: flags,
  };
  if (previous && next.language === previous.language && next.title === previous.title && next.code === previous.code &&
    next.output === previous.output && next.observedLive === previous.observedLive && next.cellStatus === previous.cellStatus &&
    next.durationMs === previous.durationMs && next.exitCode === previous.exitCode && next.isError === previous.isError &&
    next.activity === previous.activity && next.views === previous.views && next.detached === previous.detached && next.truncated === previous.truncated) {
    return previous;
  }
  return next;
}

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
