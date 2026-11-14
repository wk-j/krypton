// Spec 398 — OMP Bash observations are independent of transcript/tool retention.
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { stripAnsi } from '../provider-error';
import type { ToolCall, ToolCallUpdate } from '../types';
import type {
  LaneEvent, OmpBackgroundActivity, OmpBackgroundIdentity, OmpBackgroundStatus,
} from './types';

const identity = Type.String({ minLength: 1, maxLength: 512, pattern: '\\S' });
const encoder = new TextEncoder();
const state = Type.Union([
  Type.Literal('running'), Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled'),
]);
const nullableTime = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const nullableExit = Type.Union([Type.Integer(), Type.Null()]);
const nullablePid = Type.Union([Type.Integer({ minimum: 1, maximum: 0x3fffffff }), Type.Null()]);
const updateSchema = Type.Object({
  details: Type.Object({
    async: Type.Object({ type: Type.Literal('bash'), jobId: identity, state }),
  }),
});
const snapshotSchema = Type.Object({
  jobs: Type.Array(Type.Object({
    id: identity,
    toolCallId: identity,
    state: Type.Union([state, Type.Literal('unavailable')]),
    startedAt: nullableTime,
    endedAt: nullableTime,
    exitCode: nullableExit,
    pid: nullablePid,
    lastLine: Type.String({ maxLength: 800 }),
  }), { maxItems: 20 }),
});

/** A bounded, single-line plain-text observation, never HTML or terminal control. */
function lastLine(value: string): string {
  const clean = stripAnsi(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  const lines = clean.split(/[\r\n]/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && !line.startsWith('Backgrounded as job ')) return Array.from(line).slice(0, 200).join('');
  }
  return '';
}

function outputLine(rawOutput: Record<string, unknown>): string {
  if (!Array.isArray(rawOutput.content)) return '';
  return lastLine(rawOutput.content.flatMap((block: unknown) => {
    if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'text' ||
        !('text' in block) || typeof block.text !== 'string') return [];
    return [block.text];
  }).join('\n'));
}

interface Launch {
  readonly id: string;
  readonly toolCallId: string;
  readonly command: string;
  terminal: boolean;
}

/** Holds unresolved launch identities even after the generic tool-state cap evicts a row. */
export class OmpBackgroundDecoder {
  private readonly launches = new Map<string, Launch>();

  reset(): void {
    this.launches.clear();
  }

  event(call: ToolCall | ToolCallUpdate, tool: LaneEvent | null): OmpBackgroundActivity | null {
    if (!Value.Check(updateSchema, call.rawOutput) || !Value.Check(identity, call.toolCallId) ||
        encoder.encode(call.toolCallId).length > 512 || encoder.encode(call.rawOutput.details.async.jobId).length > 512) return null;
    const async = call.rawOutput.details.async;
    let launch = this.launches.get(call.toolCallId);
    if (launch && launch.id !== async.jobId) return null;
    if (!launch) {
      // A quoted result or an orphan update is not a launch. The ordinary decoder
      // must know the real call and its full input command before we remember it.
      if (tool?.type !== 'tool' || tool.view.mcp || !tool.view.commandLine) return null;
      launch = { id: async.jobId, toolCallId: call.toolCallId, command: tool.view.commandLine, terminal: false };
      this.launches.set(call.toolCallId, launch);
    }
    const details = call.rawOutput.details as Record<string, unknown>;
    const exitCode = typeof details.exitCode === 'number' && Number.isSafeInteger(details.exitCode)
      ? details.exitCode : null;
    const status: OmpBackgroundStatus = {
      id: launch.id, toolCallId: launch.toolCallId, state: async.state,
      startedAt: null, endedAt: null, exitCode, pid: null,
      lastLine: outputLine(call.rawOutput),
    };
    if (async.state !== 'running') launch.terminal = true;
    this.prune();
    return { command: launch.command, status };
  }

  snapshot(raw: unknown, requested: readonly OmpBackgroundIdentity[]): readonly OmpBackgroundStatus[] {
    if (!Value.Check(snapshotSchema, raw) || raw.jobs.length !== requested.length) {
      throw new Error('Invalid OMP background job snapshot');
    }
    const remaining = new Map(requested.map((job) => [job.toolCallId, job.id]));
    const jobs: OmpBackgroundStatus[] = [];
    for (const job of raw.jobs) {
      if (encoder.encode(job.id).length > 512 || encoder.encode(job.toolCallId).length > 512) {
        throw new Error('Invalid OMP background job identity');
      }
      if (remaining.get(job.toolCallId) !== job.id ||
          (job.state === 'unavailable' && (job.startedAt !== null || job.endedAt !== null ||
            job.exitCode !== null || job.pid !== null || job.lastLine !== '')) ||
          (job.state !== 'unavailable' && job.startedAt === null) ||
          (job.state !== 'running' && job.pid !== null)) {
        throw new Error('Mismatched OMP background job snapshot');
      }
      remaining.delete(job.toolCallId);
      jobs.push({ ...job, lastLine: lastLine(job.lastLine) });
    }
    // Only after validating the complete answer may it change retention state.
    for (const job of jobs) {
      const launch = this.launches.get(job.toolCallId);
      if (launch?.id === job.id && job.state !== 'running' && job.state !== 'unavailable') launch.terminal = true;
    }
    this.prune();
    return jobs;
  }

  private prune(): void {
    if (this.launches.size <= 512) return;
    for (const [id, launch] of this.launches) {
      if (this.launches.size <= 512) break;
      if (launch.terminal) this.launches.delete(id);
    }
  }
}
