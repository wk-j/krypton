import { describe, expect, it, vi } from 'vitest';

import { listComponent } from '../../../ui/list';
import type { BackgroundTask } from '../../harness-view-types';
import { BackgroundTaskStrip } from './index';

const block = 'acp-harness__background-strip';
const task = (over: Partial<BackgroundTask> & { id: string }): BackgroundTask => ({
  toolCallId: 'call-1',
  command: 'MAVEN_OPTS=-Xmx2g mvn clean install',
  outputPath: '/tmp/build.output',
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
const cell = (strip: BackgroundTaskStrip, suffix: string): HTMLElement =>
  strip.el.querySelector<HTMLElement>(`.${block}-${suffix}`)!;
const rowIds = (strip: BackgroundTaskStrip): (string | undefined)[] =>
  Array.from(strip.el.querySelectorAll<HTMLElement>(`.${block}-row`), (row) => row.dataset.taskId);

function observe(node: Node): MutationObserver {
  const observer = new MutationObserver(() => undefined);
  observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
  return observer;
}

describe('BackgroundTaskStrip', () => {
  it('hides empty lanes, then shows a named running task and detail keycaps', () => {
    const strip = new BackgroundTaskStrip();
    strip.update({ tasks: [], now: 2_000 });
    expect(strip.el.hidden).toBe(true);
    expect(rowIds(strip)).toEqual([]);

    strip.update({ tasks: [task({ id: 'a', lastLine: 'Compiling sources' })], now: 62_000 });
    expect(strip.el.hidden).toBe(false);
    expect(cell(strip, 'label').textContent).toBe('BACKGROUND');
    expect(cell(strip, 'count').textContent).toBe('1');
    expect(cell(strip, 'state').textContent).toBe('RUNNING');
    expect(cell(strip, 'command').textContent).toBe('MAVEN_OPTS=-Xmx2g mvn clean install');
    expect(cell(strip, 'elapsed').textContent).toBe('1:01');
    expect(cell(strip, 'tail').textContent).toBe('Compiling sources');
    expect(Array.from(strip.el.querySelectorAll('kbd'), (key) => key.textContent)).toEqual(['⌘P', '=']);
    expect(strip.el.querySelector('button, a, input, [tabindex]')).toBeNull();
    strip.dispose();
  });

  it('patches the same keyed row through in-place uncertain and terminal transitions', () => {
    const strip = new BackgroundTaskStrip();
    const job = task({ id: 'a' });
    const tasks = [job];
    strip.update({ tasks, now: 2_000 });
    const row = cell(strip, 'row');

    job.state = 'unknown';
    job.command = 'Build Case Preserved';
    job.lastLine = 'Output no longer readable';
    strip.update({ tasks, now: 2_000 });
    expect(cell(strip, 'row')).toBe(row);
    expect(cell(strip, 'state').textContent).toBe('OUTPUT UNAVAILABLE');
    expect(cell(strip, 'command').textContent).toBe(job.command);
    expect(cell(strip, 'tail').textContent).toBe(job.lastLine);
    expect(cell(strip, 'count').textContent).toBe('1');

    job.state = 'orphaned';
    strip.update({ tasks, now: 3_000 });
    expect(cell(strip, 'state').textContent).toBe('NO PROCESS MATCH');
    expect(cell(strip, 'count').textContent).toBe('1');

    job.state = 'exited';
    job.exitCode = 7;
    job.endedAt = 4_000;
    strip.update({ tasks, now: 5_000 });
    expect(cell(strip, 'row')).toBe(row);
    expect(cell(strip, 'state').textContent).toBe('FAILED · exit 7');
    expect(cell(strip, 'elapsed').textContent).toBe('0:03');
    expect(cell(strip, 'count').textContent).toBe('0');
    expect(strip.el.hidden).toBe(false);

    job.exitCode = 0;
    strip.update({ tasks, now: 6_000 });
    expect(cell(strip, 'state').textContent).toBe('DONE · exit 0');
    expect(cell(strip, 'row')).toBe(row);
    strip.dispose();
  });

  it('does not call a terminal task without an exit code successful', () => {
    const strip = new BackgroundTaskStrip();
    strip.update({ tasks: [task({ id: 'a', state: 'exited', endedAt: 2_000 })], now: 3_000 });
    expect(cell(strip, 'state').textContent).toBe('OUTPUT UNAVAILABLE');
    expect(strip.el.textContent).not.toContain('DONE');
    strip.dispose();
  });

  it('shows the three newest unsettled tasks and an accurate remaining count without sorting input', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = Object.freeze([
      task({ id: 'old', startedAt: 1_000 }),
      task({ id: 'completed', startedAt: 9_000, state: 'exited', exitCode: 0 }),
      task({ id: 'unknown', startedAt: 4_000, state: 'unknown' }),
      task({ id: 'orphaned', startedAt: 3_000, state: 'orphaned' }),
      task({ id: 'new', startedAt: 5_000 }),
      task({ id: 'older', startedAt: 2_000 }),
    ]);
    strip.update({ tasks, now: 10_000 });
    expect(rowIds(strip)).toEqual(['new', 'unknown', 'orphaned']);
    expect(cell(strip, 'count').textContent).toBe('5');
    expect(cell(strip, 'more').hidden).toBe(false);
    expect(cell(strip, 'more').textContent).toBe('+2 more · Lane Metrics');
    expect(tasks.map((job) => job.id)).toEqual(['old', 'completed', 'unknown', 'orphaned', 'new', 'older']);

    tasks[0].startedAt = 6_000;
    strip.update({ tasks, now: 10_000 });
    expect(rowIds(strip)).toEqual(['old', 'new', 'unknown']);
    strip.dispose();
  });

  it('retains the latest-started final result, not the latest-ended one, until another job starts or the lane clears', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = [
      task({ id: 'later-end', startedAt: 1_000, endedAt: 9_000, state: 'exited', exitCode: 0 }),
      task({ id: 'later-start', startedAt: 3_000, endedAt: 5_000, state: 'exited', exitCode: 2 }),
    ];
    strip.update({ tasks, now: 10_000 });
    const finalRow = cell(strip, 'row');
    expect(rowIds(strip)).toEqual(['later-start']);
    expect(cell(strip, 'state').textContent).toBe('FAILED · exit 2');
    expect(cell(strip, 'more').hidden).toBe(true);
    strip.update({ tasks, now: 20_000 });
    expect(cell(strip, 'row')).toBe(finalRow);
    expect(cell(strip, 'elapsed').textContent).toBe('0:02');

    tasks.push(task({ id: 'next', startedAt: 21_000 }));
    strip.update({ tasks, now: 22_000 });
    expect(rowIds(strip)).toEqual(['next']);
    strip.update({ tasks: [], now: 23_000 });
    expect(strip.el.hidden).toBe(true);
    expect(rowIds(strip)).toEqual([]);
    strip.dispose();
  });

  it('writes no DOM for equal display, fresh equivalent objects, or invisible task changes', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = [task({ id: 'a', lastLine: 'Compiling' })];
    strip.update({ tasks, now: 2_000 });
    const observer = observe(strip.el);
    strip.update({ tasks, now: 2_000 });
    tasks[0].bytes = 4096;
    tasks[0].cpuPercent = 50;
    strip.update({ tasks, now: 2_500 });
    strip.update({ tasks: tasks.map((job) => ({ ...job })), now: 2_999 });
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    strip.dispose();
  });

  it('only patches the changed row and disposes dropped and owned keyed children', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = [task({ id: 'a' }), task({ id: 'b', startedAt: 1_500 })];
    strip.update({ tasks, now: 2_000 });
    const rows = cell(strip, 'rows');
    const a = listComponent(rows, 'a')!;
    const b = listComponent(rows, 'b')!;
    const disposeA = vi.spyOn(a, 'dispose');
    const disposeB = vi.spyOn(b, 'dispose');
    const observer = observe(b.el);
    tasks[0].lastLine = 'Changed output';
    strip.update({ tasks, now: 2_000 });
    expect(observer.takeRecords()).toEqual([]);
    expect(listComponent(rows, 'a')).toBe(a);
    observer.disconnect();

    tasks.shift();
    strip.update({ tasks, now: 2_000 });
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(rowIds(strip)).toEqual(['b']);
    strip.dispose();
    strip.dispose();
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(rows.childElementCount).toBe(0);
  });

  it('renders untrusted long command and output literally with complete titles', () => {
    const strip = new BackgroundTaskStrip();
    const command = `<img src=x onerror=alert(1)> ${'VeryLongCommand'.repeat(100)}`;
    const lastLine = `<script>alert('output')</script> ${'long output '.repeat(100)}`;
    strip.update({ tasks: [task({ id: 'safe', command, lastLine })], now: 2_000 });
    expect(cell(strip, 'command').textContent).toBe(command);
    expect(cell(strip, 'command').title).toBe(command);
    expect(cell(strip, 'tail').textContent).toBe(lastLine);
    expect(cell(strip, 'tail').title).toBe(lastLine);
    expect(strip.el.querySelector('script, img')).toBeNull();
    strip.dispose();
  });
});
