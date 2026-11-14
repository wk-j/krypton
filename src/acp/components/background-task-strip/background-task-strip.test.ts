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
  it('hides empty lanes, then shows a named running task on one line with no detail hint', () => {
    const strip = new BackgroundTaskStrip();
    strip.update({ tasks: [], now: 2_000 });
    expect(strip.el.hidden).toBe(true);
    expect(rowIds(strip)).toEqual([]);

    strip.update({ tasks: [task({ id: 'a', lastLine: 'Compiling sources' })], now: 62_000 });
    expect(strip.el.hidden).toBe(false);
    expect(cell(strip, 'label').textContent).toBe('BACKGROUND');
    expect(strip.el.querySelector(`.${block}-head, .${block}-count`)).toBeNull();
    expect(cell(strip, 'state').textContent).toBe('RUNNING');
    expect(cell(strip, 'command').textContent).toBe('MAVEN_OPTS=-Xmx2g mvn clean install');
    expect(cell(strip, 'elapsed').textContent).toBe('');
    expect(cell(strip, 'tail').textContent).toBe('Compiling sources');
    expect(cell(strip, 'more').hidden).toBe(true);
    expect(strip.el.querySelector('button, a, input, [tabindex]')).toBeNull();
    strip.dispose();
  });

  it('shows the matched PID, updates it in place, and removes a settled row', () => {
    const strip = new BackgroundTaskStrip();
    const job = task({ id: 'a' });
    const tasks = [job];
    strip.update({ tasks, now: 2_000 });
    const row = cell(strip, 'row');

    job.pid = 1234;
    strip.update({ tasks, now: 2_000 });
    expect(cell(strip, 'row')).toBe(row);
    expect(cell(strip, 'state').textContent).toBe('RUNNING · PID 1234');

    job.pid = 5678;
    strip.update({ tasks, now: 3_000 });
    expect(cell(strip, 'row')).toBe(row);
    expect(cell(strip, 'state').textContent).toBe('RUNNING · PID 5678');

    job.pid = null;
    strip.update({ tasks, now: 3_500 });
    expect(cell(strip, 'state').textContent).toBe('RUNNING');

    job.state = 'exited';
    job.exitCode = 7;
    job.endedAt = 4_000;
    strip.update({ tasks, now: 5_000 });
    expect(rowIds(strip)).toEqual([]);
    expect(strip.el.hidden).toBe(true);
    strip.dispose();
  });

  it('hides unknown, orphaned, successful and failed tasks immediately', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = [
      task({ id: 'unknown', state: 'unknown' }),
      task({ id: 'orphaned', state: 'orphaned' }),
      task({ id: 'done', state: 'exited', exitCode: 0, endedAt: 2_000 }),
      task({ id: 'failed', state: 'exited', exitCode: 2, endedAt: 2_000 }),
      task({ id: 'no-code', state: 'exited', endedAt: 2_000 }),
    ];
    strip.update({ tasks, now: 3_000 });
    expect(strip.el.hidden).toBe(true);
    expect(rowIds(strip)).toEqual([]);
    strip.dispose();
  });

  it('shows the three newest qualifying tasks and the overflow with keycaps, without sorting input', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = Object.freeze([
      task({ id: 'old', startedAt: 1_000 }),
      task({ id: 'completed', startedAt: 500, endedAt: 800, state: 'exited', exitCode: 0 }),
      task({ id: 'unknown', startedAt: 4_000, state: 'unknown' }),
      task({ id: 'orphaned', startedAt: 3_000, state: 'orphaned' }),
      task({ id: 'new', startedAt: 5_000 }),
      task({ id: 'older', startedAt: 2_000 }),
      task({ id: 'newest', startedAt: 6_000 }),
    ]);
    strip.update({ tasks, now: 10_000 });
    expect(rowIds(strip)).toEqual(['newest', 'new', 'older']);
    expect(cell(strip, 'more').hidden).toBe(false);
    expect(cell(strip, 'more').textContent).toBe('+1 more · ⌘P then = Lane Metrics');
    expect(Array.from(cell(strip, 'more').querySelectorAll('kbd'), (key) => key.textContent)).toEqual(['⌘P', '=']);
    expect(tasks.map((job) => job.id)).toEqual(['old', 'completed', 'unknown', 'orphaned', 'new', 'older', 'newest']);

    tasks[0].startedAt = 7_000;
    strip.update({ tasks, now: 10_000 });
    expect(rowIds(strip)).toEqual(['old', 'newest', 'new']);
    strip.dispose();
  });

  it('keeps another running job when a sibling exits', () => {
    const strip = new BackgroundTaskStrip();
    const earlier = task({ id: 'earlier', startedAt: 1_000 });
    const tasks = [
      earlier,
      task({ id: 'later', startedAt: 2_000 }),
    ];
    strip.update({ tasks, now: 3_500 });
    expect(rowIds(strip)).toEqual(['later', 'earlier']);

    tasks[1].state = 'exited';
    tasks[1].exitCode = 1;
    tasks[1].endedAt = 4_000;
    strip.update({ tasks, now: 4_500 });
    expect(rowIds(strip)).toEqual(['earlier']);
    expect(strip.el.hidden).toBe(false);

    earlier.state = 'exited';
    earlier.exitCode = 0;
    earlier.endedAt = 5_000;
    strip.update({ tasks, now: 5_000 });
    expect(strip.el.hidden).toBe(true);
    expect(rowIds(strip)).toEqual([]);
    strip.dispose();
  });

  it('writes no DOM for equal display, fresh equivalent objects, invisible task changes, or passing time', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = [
      task({ id: 'a', lastLine: 'Compiling' }),
      task({ id: 'b', startedAt: 1_500, state: 'unknown' }),
      task({ id: 'c', startedAt: 1_200, state: 'exited', exitCode: 4, endedAt: 1_900 }),
    ];
    strip.update({ tasks, now: 2_000 });
    const observer = observe(strip.el);
    strip.update({ tasks, now: 2_000 });
    tasks[0].bytes = 4096;
    tasks[0].cpuPercent = 50;
    strip.update({ tasks, now: 2_500 });
    strip.update({ tasks: tasks.map((job) => ({ ...job })), now: 2_999 });
    // No live clock: a poll minutes later that learned nothing writes nothing.
    strip.update({ tasks, now: 2_000 + 10 * 60_000 });
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    strip.dispose();
  });

  it('repaints only the changed output or PID cell of a row', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = [task({ id: 'a', lastLine: 'Compiling' })];
    strip.update({ tasks, now: 2_000 });
    const observer = observe(strip.el);
    tasks[0].lastLine = 'Linking';
    strip.update({ tasks, now: 4_000 });
    const targets = new Set(observer.takeRecords().map((record) =>
      (record.target instanceof HTMLElement ? record.target : record.target.parentElement)?.className));
    expect(targets).toEqual(new Set([`${block}-tail`]));
    observer.disconnect();

    const pidObserver = observe(strip.el);
    tasks[0].pid = 2468;
    strip.update({ tasks, now: 5_000 });
    const pidTargets = new Set(pidObserver.takeRecords().map((record) =>
      (record.target instanceof HTMLElement ? record.target : record.target.parentElement)?.className));
    expect(pidTargets).toEqual(new Set([`${block}-state`]));
    pidObserver.disconnect();
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
