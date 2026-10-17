// Krypton — background task registry (spec 305).
//
// A Claude lane detaches shell work with `run_in_background`: the launch tool
// call completes in well under a second, the turn ends, and the lane goes idle
// while the job keeps running. ACP's terminal capability is off
// (`src-tauri/src/acp.rs:2023`), so Krypton never owns that process — what it
// does have is the adapter's own launch result, which names the task id and the
// absolute output file, plus the lane process tree it already polls.
//
// This module is the pure half: parse a launch, fold a file status in, find the
// job in the tree, bound the list. The view owns the lane state and the IPC.

import { formatElapsed, truncateInline } from './harness-format';
import type { AcpBackgroundTaskStatus, AcpLaneMetrics, AcpLaneProcMetric } from '../types';
import type { BackgroundTask } from './harness-view-types';
import type { ToolCall, ToolCallUpdate } from './types';

/** Per-lane cap. Exited rows are dropped oldest-first; a running one never is. */
export const BACKGROUND_TASK_MAX = 20;

/** Polls with neither an exit marker nor a live process before a task is called
 *  orphaned. Two polls (~4 s) so one sampling miss cannot flip a live job. */
const ORPHAN_MISS_LIMIT = 2;

/** The adapter's launch result, verbatim:
 *  `Command running in background with ID: bxs80otkx. Output is being written to: /private/tmp/…` */
const LAUNCH_RE =
  /Command running in background with ID:\s*(\S+?)\.\s+Output is being written to:\s*(\S+)/;

export interface BackgroundLaunch {
  readonly id: string;
  readonly outputPath: string;
}

/** The launch id + output path, or null when this tool call is not one. */
export function parseBackgroundLaunch(call: ToolCall | ToolCallUpdate): BackgroundLaunch | null {
  for (const item of call.content ?? []) {
    if (item.type !== 'content') continue;
    const block = item.content;
    if (!block || block.type !== 'text') continue;
    const match = LAUNCH_RE.exec(block.text);
    if (!match) continue;
    const outputPath = match[2].replace(/[.,]$/, '');
    if (!outputPath.startsWith('/')) continue;
    return { id: match[1], outputPath };
  }
  return null;
}

/** The launched command line, for the row label and the process match. */
export function launchCommand(call: ToolCall | ToolCallUpdate): string {
  const raw = call.rawInput;
  if (raw && typeof raw === 'object' && 'command' in raw) {
    const command = raw.command;
    if (typeof command === 'string' && command.trim()) return command.trim();
  }
  return call.title?.trim() ?? '';
}

/**
 * Register a launch on a lane. Returns the task when it is new, null when this
 * id is already tracked — `tool_call` and `tool_call_update` both carry the
 * launch text, so the same job arrives at least twice.
 */
export function registerBackgroundTask(
  tasks: BackgroundTask[],
  call: ToolCall | ToolCallUpdate,
  now: number,
): BackgroundTask | null {
  const launch = parseBackgroundLaunch(call);
  if (!launch) return null;
  if (tasks.some((task) => task.id === launch.id)) return null;
  const task: BackgroundTask = {
    id: launch.id,
    toolCallId: call.toolCallId,
    command: launchCommand(call),
    outputPath: launch.outputPath,
    startedAt: now,
    state: 'running',
    exitCode: null,
    endedAt: null,
    bytes: 0,
    lastLine: '',
    pid: null,
    cpuPercent: null,
    rssMb: null,
    missStreak: 0,
  };
  tasks.push(task);
  pruneBackgroundTasks(tasks);
  return task;
}

/** Drop finished rows oldest-first once over the cap. A `running` task is kept
 *  even past the cap: dropping it would silently stop watching live work. */
export function pruneBackgroundTasks(tasks: BackgroundTask[]): void {
  while (tasks.length > BACKGROUND_TASK_MAX) {
    const index = tasks.findIndex((task) => task.state !== 'running');
    if (index === -1) return;
    tasks.splice(index, 1);
  }
}

/** The shell the agent detached, found by its command line in the lane tree.
 *  The root (the adapter itself) is never a match. */
export function findTaskProcess(
  command: string,
  metrics: AcpLaneMetrics | null,
): AcpLaneProcMetric | null {
  if (!metrics || !metrics.root_alive || !command) return null;
  for (const proc of metrics.processes) {
    if (proc.pid === metrics.root_pid) continue;
    if (proc.cmd.some((arg) => arg.includes(command))) return proc;
  }
  return null;
}

/** CPU/RSS of a process *and its descendants* — the wrapper shell burns nothing,
 *  the `mvn`/`java` children it spawned are the real cost. */
export function subtreeUsage(
  metrics: AcpLaneMetrics,
  pid: number,
): { cpuPercent: number; rssMb: number } {
  let cpuPercent = 0;
  let rssMb = 0;
  for (const proc of metrics.processes) {
    let cursor: AcpLaneProcMetric | undefined = proc;
    // Bounded climb — a chain longer than this is a cycle, not a process tree.
    for (let hops = 0; cursor && hops < 32; hops += 1) {
      if (cursor.pid === pid) {
        cpuPercent += proc.cpu_percent;
        rssMb += proc.rss_mb;
        break;
      }
      const parentPid: number | null = cursor.parent_pid;
      cursor = parentPid === null ? undefined : metrics.processes.find((p) => p.pid === parentPid);
    }
  }
  return { cpuPercent, rssMb };
}

/**
 * Fold one poll answer into a task. The exit marker in the output file is the
 * authority; the process tree only decides between "still running" and
 * "gone without a marker" (killed, or the CLI died).
 */
export function applyTaskStatus(
  task: BackgroundTask,
  status: AcpBackgroundTaskStatus,
  metrics: AcpLaneMetrics | null,
  now: number,
): void {
  if (!status.exists) {
    task.state = 'unknown';
    task.pid = null;
    task.cpuPercent = null;
    task.rssMb = null;
    return;
  }
  task.bytes = status.bytes;
  task.lastLine = status.last_line;
  if (status.exit_code !== null) {
    task.state = 'exited';
    task.exitCode = status.exit_code;
    task.endedAt = status.modified_ms ?? now;
    task.pid = null;
    task.cpuPercent = null;
    task.rssMb = null;
    task.missStreak = 0;
    return;
  }
  const proc = findTaskProcess(task.command, metrics);
  if (proc && metrics) {
    const usage = subtreeUsage(metrics, proc.pid);
    task.state = 'running';
    task.pid = proc.pid;
    task.cpuPercent = usage.cpuPercent;
    task.rssMb = usage.rssMb;
    task.missStreak = 0;
    return;
  }
  task.pid = null;
  task.cpuPercent = null;
  task.rssMb = null;
  task.missStreak += 1;
  task.state = task.missStreak >= ORPHAN_MISS_LIMIT ? 'orphaned' : 'running';
}

/** `182 KB`, `1.4 MB` — output written so far. */
export function formatTaskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The `#bg` table: the same facts as the overlay section, as transcript text. */
export function formatBackgroundTaskLines(
  tasks: readonly BackgroundTask[],
  now: number,
): string[] {
  if (tasks.length === 0) return ['bg: no background tasks on this lane.'];
  const lines = ['task        state     elapsed   output   command'];
  for (const task of tasks) {
    const state = task.state === 'exited' ? `exit ${task.exitCode ?? '?'}` : task.state;
    lines.push(
      `${task.id.padEnd(11).slice(0, 11)} ${state.padEnd(9).slice(0, 9)} ` +
        `${formatElapsed((task.endedAt ?? now) - task.startedAt).padStart(7)}  ` +
        `${formatTaskBytes(task.bytes).padStart(7)}  ${truncateInline(task.command, 72)}`,
    );
  }
  lines.push('');
  lines.push(`output files: ${tasks.map((task) => task.outputPath).join(', ')}`);
  return lines;
}
