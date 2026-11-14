// Krypton — source-aware shell observations (specs 305/398).
// Claude jobs use their output file and process tree; OMP jobs use scoped ACP
// snapshots. Neither source owns execution or consumes the agent's result.

import { formatElapsed, truncateInline } from './harness-format';
import type { AcpBackgroundTaskStatus, AcpLaneMetrics, AcpLaneProcMetric } from '../types';
import type { BackgroundTask } from './harness-view-types';
import type { OmpBackgroundActivity, OmpBackgroundStatus } from './adapters/types';

/** Per-lane cap. Exited rows are dropped oldest-first; a running one never is. */
export const BACKGROUND_TASK_MAX = 20;

/** Polls with neither an exit marker nor a live process before a task is called
 *  orphaned. Two polls (~4 s) so one sampling miss cannot flip a live job. */
const ORPHAN_MISS_LIMIT = 2;

/**
 * Register a launch on a lane. Returns the task when it is new, null when this
 * id is already tracked — `tool_call` and `tool_call_update` both carry the
 * launch text, so the same job arrives at least twice. The Claude adapter reads
 * the launch from the wire (spec 380); this takes the decoded launch.
 */
export function registerBackgroundTask(
  tasks: BackgroundTask[],
  toolCallId: string,
  launch: { readonly id: string; readonly outputPath: string; readonly command: string },
  now: number,
): BackgroundTask | null {
  if (tasks.some((task) => task.id === launch.id)) return null;
  const task: BackgroundTask = {
    id: launch.id,
    toolCallId,
    command: launch.command,
    observation: { kind: 'claude-output', outputPath: launch.outputPath },
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

/** Capture an OMP launch exactly once; job IDs may be reused by a later call. */
export function registerOmpBackgroundTask(
  tasks: BackgroundTask[],
  activity: OmpBackgroundActivity,
  now: number,
): BackgroundTask {
  const { status } = activity;
  let task = tasks.find((entry) => entry.observation.kind === 'omp-job' &&
    entry.id === status.id && entry.toolCallId === status.toolCallId);
  if (!task) {
    task = {
      id: status.id, toolCallId: status.toolCallId, command: activity.command,
      observation: { kind: 'omp-job', toolCallId: status.toolCallId },
      startedAt: now, state: 'running', exitCode: null, endedAt: null,
      bytes: null, lastLine: '', pid: null, cpuPercent: null, rssMb: null, missStreak: 0,
    };
    tasks.push(task);
  }
  applyOmpBackgroundStatus(task, status, now);
  pruneBackgroundTasks(tasks);
  return task;
}

/** A launch's terminal state cannot be reopened by delayed wire/poll frames. */
export function applyOmpBackgroundStatus(task: BackgroundTask, status: OmpBackgroundStatus, now: number): void {
  if (task.observation.kind !== 'omp-job' || task.id !== status.id || task.toolCallId !== status.toolCallId ||
      (task.state !== 'running' && task.state !== 'unknown')) return;
  task.state = status.state === 'completed' ? 'exited' : status.state === 'unavailable' ? 'unknown' : status.state;
  if (status.startedAt !== null) task.startedAt = status.startedAt;
  task.endedAt = task.state === 'running' || task.state === 'unknown' ? null : status.endedAt ?? now;
  task.exitCode = status.exitCode;
  task.pid = task.state === 'running' ? status.pid : null;
  task.cpuPercent = null;
  task.rssMb = null;
  if (status.lastLine) task.lastLine = status.lastLine;
}

export function markOmpBackgroundUnavailable(task: BackgroundTask): void {
  applyOmpBackgroundStatus(task, {
    id: task.id, toolCallId: task.toolCallId, state: 'unavailable',
    startedAt: null, endedAt: null, exitCode: null, pid: null, lastLine: '',
  }, Date.now());
}

/** A detail label must not invent an exit code or confuse absent status with a missing log. */
export function backgroundTaskState(task: BackgroundTask): string {
  if (task.state === 'exited') return task.exitCode === null ? 'completed' : `exit ${task.exitCode}`;
  if (task.state === 'failed') return task.exitCode === null ? 'failed' : `failed · exit ${task.exitCode}`;
  if (task.state === 'unknown' && task.observation.kind === 'omp-job') return 'status unavailable';
  return task.state;
}

/** Drop finished rows oldest-first once over the cap. A `running` task is kept
 *  even past the cap: dropping it would silently stop watching live work. */
export function pruneBackgroundTasks(tasks: BackgroundTask[]): void {
  while (tasks.length > BACKGROUND_TASK_MAX) {
    const index = tasks.findIndex((task) => task.state !== 'running' &&
      !(task.observation.kind === 'omp-job' && task.state === 'unknown'));
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
  if (task.observation.kind !== 'claude-output') return;
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
export function formatTaskBytes(bytes: number | null): string {
  if (bytes === null) return '—';
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
    const state = backgroundTaskState(task);
    lines.push(
      `${task.id.padEnd(11)} ${state.padEnd(9)} ` +
        `${formatElapsed((task.endedAt ?? now) - task.startedAt).padStart(7)}  ` +
        `${formatTaskBytes(task.bytes).padStart(7)}  ${truncateInline(task.command, 72)}`,
    );
  }
  lines.push('');
  const paths = tasks.flatMap((task) => task.observation.kind === 'claude-output' ? [task.observation.outputPath] : []);
  if (paths.length > 0) lines.push(`output files: ${paths.join(', ')}`);
  return lines;
}
