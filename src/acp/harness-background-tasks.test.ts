import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_TASK_MAX,
  applyTaskStatus,
  formatBackgroundTaskLines,
  parseBackgroundLaunch,
  pruneBackgroundTasks,
  registerBackgroundTask,
  subtreeUsage,
} from './harness-background-tasks';
import type { BackgroundTask } from './harness-view-types';
import type { ToolCall } from './types';
import type { AcpBackgroundTaskStatus, AcpLaneMetrics, AcpLaneProcMetric } from '../types';

const OUTPUT = '/private/tmp/claude-501/-Users-wk-Project-tli/38bb8953/tasks/bxs80otkx.output';

const launchCall = (over: Partial<ToolCall> = {}): ToolCall => ({
  toolCallId: 'call-1',
  title: 'Terminal',
  kind: 'execute',
  status: 'completed',
  rawInput: { command: 'mvn clean install > /tmp/release.log 2>&1' },
  content: [
    {
      type: 'content',
      content: {
        type: 'text',
        text: `Command running in background with ID: bxs80otkx. Output is being written to: ${OUTPUT}`,
      },
    },
  ],
  ...over,
});

const status = (over: Partial<AcpBackgroundTaskStatus> = {}): AcpBackgroundTaskStatus => ({
  id: 'bxs80otkx',
  exists: true,
  bytes: 1024,
  modified_ms: 5_000,
  exit_code: null,
  last_line: 'compiling',
  ...over,
});

const proc = (over: Partial<AcpLaneProcMetric> & { pid: number }): AcpLaneProcMetric => ({
  parent_pid: null,
  name: 'node',
  cmd: ['node', 'adapter.js'],
  exe: null,
  cpu_percent: 0,
  rss_mb: 0,
  ...over,
});

const metrics = (processes: AcpLaneProcMetric[]): AcpLaneMetrics => ({
  session: 1,
  root_pid: 100,
  root_alive: true,
  total_cpu_percent: 0,
  total_rss_mb: 0,
  proc_count: processes.length,
  processes,
});

/** The adapter's shell wrapper plus the build it spawned. */
const liveTree = (command: string): AcpLaneMetrics =>
  metrics([
    proc({ pid: 100 }),
    proc({ pid: 200, parent_pid: 100, name: 'bash', cmd: ['/bin/bash', '-c', command], cpu_percent: 0.2, rss_mb: 4 }),
    proc({ pid: 201, parent_pid: 200, name: 'java', cmd: ['java', '-jar', 'maven'], cpu_percent: 182, rss_mb: 1532 }),
  ]);

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 'bxs80otkx',
  toolCallId: 'call-1',
  command: 'mvn clean install > /tmp/release.log 2>&1',
  outputPath: OUTPUT,
  startedAt: 1_000,
  state: 'running',
  exitCode: null,
  endedAt: null,
  bytes: 0,
  lastLine: '',
  pid: null,
  cpuPercent: null,
  rssMb: null,
  missStreak: 0,
  ...over,
});

describe('parseBackgroundLaunch', () => {
  it('reads the id and absolute path out of the adapter launch result', () => {
    expect(parseBackgroundLaunch(launchCall())).toEqual({ id: 'bxs80otkx', outputPath: OUTPUT });
  });

  it('ignores an ordinary tool call', () => {
    expect(
      parseBackgroundLaunch(
        launchCall({ content: [{ type: 'content', content: { type: 'text', text: 'BUILD SUCCESS' } }] }),
      ),
    ).toBeNull();
    expect(parseBackgroundLaunch(launchCall({ content: undefined }))).toBeNull();
    // A terminal-shaped content item carries no text block to match.
    expect(parseBackgroundLaunch(launchCall({ content: [{ type: 'terminal', terminalId: 't1' }] }))).toBeNull();
  });

  it('refuses a relative path — the poll command only accepts absolute ones', () => {
    expect(
      parseBackgroundLaunch(
        launchCall({
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Command running in background with ID: x1. Output is being written to: tasks/x1.output',
              },
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe('registerBackgroundTask', () => {
  it('registers a launch once, however many events repeat it', () => {
    const tasks: BackgroundTask[] = [];

    const first = registerBackgroundTask(tasks, launchCall(), 1_000);
    const second = registerBackgroundTask(tasks, launchCall(), 1_200);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'bxs80otkx',
      command: 'mvn clean install > /tmp/release.log 2>&1',
      outputPath: OUTPUT,
      state: 'running',
      startedAt: 1_000,
    });
  });

  it('falls back to the tool title when the adapter sent no command', () => {
    const tasks: BackgroundTask[] = [];
    registerBackgroundTask(tasks, launchCall({ rawInput: undefined }), 1_000);
    expect(tasks[0].command).toBe('Terminal');
  });
});

describe('pruneBackgroundTasks', () => {
  it('drops finished rows oldest-first and never a running one', () => {
    const tasks: BackgroundTask[] = [];
    for (let i = 0; i < BACKGROUND_TASK_MAX; i += 1) {
      tasks.push(task({ id: `done-${i}`, state: 'exited', exitCode: 0 }));
    }
    tasks.push(task({ id: 'live' }));

    pruneBackgroundTasks(tasks);

    expect(tasks).toHaveLength(BACKGROUND_TASK_MAX);
    expect(tasks.map((t) => t.id)).not.toContain('done-0');
    expect(tasks.map((t) => t.id)).toContain('live');
  });

  it('keeps every row when they are all still running, cap or not', () => {
    const tasks = Array.from({ length: BACKGROUND_TASK_MAX + 3 }, (_, i) => task({ id: `live-${i}` }));

    pruneBackgroundTasks(tasks);

    expect(tasks).toHaveLength(BACKGROUND_TASK_MAX + 3);
  });
});

describe('applyTaskStatus', () => {
  it('reports a live job with the usage of the whole subtree it spawned', () => {
    const t = task();

    applyTaskStatus(t, status({ bytes: 186_368, last_line: '[INFO] Building' }), liveTree(t.command), 9_000);

    expect(t.state).toBe('running');
    expect(t.pid).toBe(200);
    // The wrapper shell burns nothing; its `java` child is the real cost.
    expect(t.cpuPercent).toBeCloseTo(182.2);
    expect(t.rssMb).toBeCloseTo(1536);
    expect(t.bytes).toBe(186_368);
    expect(t.lastLine).toBe('[INFO] Building');
  });

  it('seals the task when the exit marker lands, dating it from the file', () => {
    const t = task({ pid: 200, cpuPercent: 180, rssMb: 1500 });

    applyTaskStatus(t, status({ exit_code: 0, modified_ms: 61_000, last_line: 'MVN_EXIT=0' }), null, 90_000);

    expect(t).toMatchObject({ state: 'exited', exitCode: 0, endedAt: 61_000, pid: null, cpuPercent: null });
  });

  it('calls the task orphaned only after two polls with no marker and no process', () => {
    const t = task();
    const gone = metrics([proc({ pid: 100 })]);

    applyTaskStatus(t, status(), gone, 9_000);
    expect(t).toMatchObject({ state: 'running', missStreak: 1 });

    applyTaskStatus(t, status(), gone, 11_000);
    expect(t).toMatchObject({ state: 'orphaned', missStreak: 2 });
  });

  it('resets the miss streak when the process shows up again', () => {
    const t = task({ missStreak: 1 });

    applyTaskStatus(t, status(), liveTree(t.command), 9_000);

    expect(t).toMatchObject({ state: 'running', missStreak: 0 });
  });

  it('marks a vanished output file unknown without losing what it showed', () => {
    const t = task({ bytes: 4096, lastLine: 'compiling', pid: 200 });

    applyTaskStatus(t, status({ exists: false, bytes: 0, last_line: '', modified_ms: null }), null, 9_000);

    expect(t).toMatchObject({ state: 'unknown', bytes: 4096, lastLine: 'compiling', pid: null });
  });
});

describe('subtreeUsage', () => {
  it('sums a pid and its descendants, not the whole lane', () => {
    const tree = liveTree('cmd');

    expect(subtreeUsage(tree, 200)).toEqual({ cpuPercent: 182.2, rssMb: 1536 });
    expect(subtreeUsage(tree, 201)).toEqual({ cpuPercent: 182, rssMb: 1532 });
    expect(subtreeUsage(tree, 999)).toEqual({ cpuPercent: 0, rssMb: 0 });
  });

  it('terminates on a parent cycle instead of hanging the poll', () => {
    const cyclic = metrics([
      proc({ pid: 300, parent_pid: 301, cpu_percent: 1, rss_mb: 1 }),
      proc({ pid: 301, parent_pid: 300, cpu_percent: 2, rss_mb: 2 }),
    ]);

    expect(subtreeUsage(cyclic, 300)).toEqual({ cpuPercent: 3, rssMb: 3 });
  });
});

describe('formatBackgroundTaskLines', () => {
  it('tabulates every task, freezing a finished one at its end time', () => {
    const lines = formatBackgroundTaskLines(
      [
        task({ bytes: 186_368 }),
        task({ id: 'q3f1k2m9', state: 'exited', exitCode: 137, endedAt: 241_000, bytes: 4_194_304 }),
      ],
      305_000,
    );

    expect(lines[0]).toBe('task        state     elapsed   output   command');
    expect(lines[1]).toContain('bxs80otkx   running      5:04   182 KB  mvn clean install');
    expect(lines[2]).toContain('q3f1k2m9    exit 137     4:00   4.0 MB  mvn clean install');
    expect(lines[lines.length - 1]).toContain('output files: ');
  });

  it('says so when the lane has none', () => {
    expect(formatBackgroundTaskLines([], 1_000)).toEqual(['bg: no background tasks on this lane.']);
  });
});
