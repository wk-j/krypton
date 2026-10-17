import { describe, expect, it } from 'vitest';

import type { BackgroundTask } from '../../harness-view-types';
import { BackgroundTasks } from './index';

const task = (over: Partial<BackgroundTask> & { id: string }): BackgroundTask => ({
  toolCallId: 'call-1',
  command: 'mvn clean install > /tmp/release-1286-build.log 2>&1',
  outputPath: '/private/tmp/claude-501/proj/sess/tasks/bxs80otkx.output',
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

const cell = (section: BackgroundTasks, suffix: string): string | null =>
  section.el.querySelector(`.acp-harness__bg-task-${suffix}`)?.textContent ?? null;

describe('BackgroundTasks', () => {
  it('hides itself when the lane has no tasks', () => {
    const section = new BackgroundTasks();
    section.update({ tasks: [], now: 2_000 });

    expect(section.el.hidden).toBe(true);
    expect(section.el.querySelectorAll('.acp-harness__bg-task')).toHaveLength(0);
    section.dispose();
  });

  it('renders a running job with elapsed time, output size and live usage', () => {
    const section = new BackgroundTasks();
    section.update({
      tasks: [task({ id: 'bxs80otkx', bytes: 186_368, lastLine: '[INFO] Building TLI Entity', pid: 4242, cpuPercent: 182, rssMb: 1536 })],
      now: 135_000,
    });

    expect(section.el.hidden).toBe(false);
    expect(cell(section, 'id')).toBe('bxs80otkx');
    expect(cell(section, 'elapsed')).toBe('2:14');
    expect(cell(section, 'bytes')).toBe('182 KB');
    expect(cell(section, 'status')).toBe('182% · 1.5G');
    expect(cell(section, 'tail')).toBe('[INFO] Building TLI Entity');
    // The running glyph is the shared spinner, so the frame ticker owns it.
    expect(section.el.querySelector('.acp-harness__bg-task-glyph > .acp-harness__spinner'))
      .not.toBeNull();
    section.dispose();
  });

  it('seals a finished job: exit code replaces usage and the spinner stops', () => {
    const section = new BackgroundTasks();
    const row = () => section.el.querySelector('.acp-harness__bg-task');
    section.update({ tasks: [task({ id: 'bwwz4dpnm' })], now: 2_000 });
    const before = row();

    section.update({
      tasks: [task({ id: 'bwwz4dpnm', state: 'exited', exitCode: 0, endedAt: 61_000, bytes: 1335, lastLine: 'MVN_EXIT=0' })],
      now: 90_000,
    });

    expect(row()).toBe(before); // one row, patched in place
    expect(row()?.className).toBe('acp-harness__bg-task acp-harness__bg-task--exited');
    expect(cell(section, 'status')).toBe('exit 0');
    expect(cell(section, 'elapsed')).toBe('1:00'); // frozen at endedAt, not `now`
    expect(cell(section, 'glyph')).toBe('✓');
    expect(section.el.querySelector('.acp-harness__spinner')).toBeNull();
    section.dispose();
  });

  it('marks a non-zero exit as failed and a vanished process as orphaned', () => {
    const section = new BackgroundTasks();
    section.update({
      tasks: [
        task({ id: 'a', state: 'exited', exitCode: 137, endedAt: 5_000, lastLine: 'Killed' }),
        task({ id: 'b', state: 'orphaned', missStreak: 2 }),
        task({ id: 'c', state: 'unknown' }),
      ],
      now: 9_000,
    });

    const rows = [...section.el.querySelectorAll('.acp-harness__bg-task')];
    expect(rows.map((r) => r.className.split(' ')[1])).toEqual([
      'acp-harness__bg-task--failed',
      'acp-harness__bg-task--orphaned',
      'acp-harness__bg-task--unknown',
    ]);
    expect(rows.map((r) => r.querySelector('.acp-harness__bg-task-status')?.textContent)).toEqual([
      'exit 137',
      'no process',
      'output gone',
    ]);
    section.dispose();
  });

  it('drops the row of a task that leaves the list', () => {
    const section = new BackgroundTasks();
    section.update({ tasks: [task({ id: 'a' }), task({ id: 'b' })], now: 2_000 });
    expect(section.el.querySelectorAll('.acp-harness__bg-task')).toHaveLength(2);

    section.update({ tasks: [task({ id: 'b' })], now: 2_000 });

    const ids = [...section.el.querySelectorAll('.acp-harness__bg-task-id')].map((n) => n.textContent);
    expect(ids).toEqual(['b']);
    section.dispose();
  });

  it('writes nothing to the DOM while every displayed value holds', () => {
    const section = new BackgroundTasks();
    const tasks = [task({ id: 'a', bytes: 1024, lastLine: 'compiling' })];
    section.update({ tasks, now: 2_000 });
    const observer = new MutationObserver(() => undefined);
    observer.observe(section.el, { childList: true, subtree: true, attributes: true, characterData: true });

    section.update({ tasks, now: 2_000 });

    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
    section.dispose();
  });
});
