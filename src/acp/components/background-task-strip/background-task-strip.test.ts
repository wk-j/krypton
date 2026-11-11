import { describe, expect, it, vi } from 'vitest';

import { listComponent } from '../../../ui/list';
import type { BackgroundTask } from '../../harness-view-types';
import { BACKGROUND_DONE_LINGER_MS, BackgroundTaskStrip } from './index';

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

    job.state = 'orphaned';
    strip.update({ tasks, now: 3_000 });
    expect(cell(strip, 'state').textContent).toBe('NO PROCESS MATCH');

    job.state = 'exited';
    job.exitCode = 7;
    job.endedAt = 4_000;
    strip.update({ tasks, now: 5_000 });
    expect(cell(strip, 'row')).toBe(row);
    expect(cell(strip, 'state').textContent).toBe('FAILED · exit 7');
    expect(cell(strip, 'elapsed').textContent).toBe('0:03');
    expect(strip.el.hidden).toBe(false);

    job.exitCode = 0;
    strip.update({ tasks, now: 6_000 });
    expect(cell(strip, 'state').textContent).toBe('DONE · exit 0');
    expect(cell(strip, 'row')).toBe(row);
    strip.dispose();
  });

  it('keeps a terminal task without an exit code, never calling it successful', () => {
    const strip = new BackgroundTaskStrip();
    const tasks = [task({ id: 'a', state: 'exited', endedAt: 2_000 })];
    strip.update({ tasks, now: 3_000 });
    expect(cell(strip, 'state').textContent).toBe('OUTPUT UNAVAILABLE');
    expect(strip.el.textContent).not.toContain('DONE');
    strip.update({ tasks, now: 2_000 + 10 * BACKGROUND_DONE_LINGER_MS });
    expect(strip.el.hidden).toBe(false);
    expect(rowIds(strip)).toEqual(['a']);
    strip.dispose();
  });

  it('clears a successful result once its linger window passes, but keeps a failure', () => {
    const strip = new BackgroundTaskStrip();
    const done = task({ id: 'done', state: 'exited', exitCode: 0, endedAt: 10_000, lastLine: 'UP after 54s' });
    strip.update({ tasks: [done], now: 10_000 });
    expect(cell(strip, 'state').textContent).toBe('DONE · exit 0');
    strip.update({ tasks: [done], now: 10_000 + BACKGROUND_DONE_LINGER_MS - 1 });
    expect(strip.el.hidden).toBe(false);
    strip.update({ tasks: [done], now: 10_000 + BACKGROUND_DONE_LINGER_MS });
    expect(strip.el.hidden).toBe(true);
    expect(rowIds(strip)).toEqual([]);

    const failed = task({ id: 'failed', state: 'exited', exitCode: 2, endedAt: 10_000 });
    strip.update({ tasks: [failed], now: 1_000_000 });
    expect(strip.el.hidden).toBe(false);
    expect(rowIds(strip)).toEqual(['failed']);
    expect(cell(strip, 'state').textContent).toBe('FAILED · exit 2');
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
    ]);
    strip.update({ tasks, now: 10_000 });
    expect(rowIds(strip)).toEqual(['new', 'unknown', 'orphaned']);
    expect(cell(strip, 'more').hidden).toBe(false);
    expect(cell(strip, 'more').textContent).toBe('+2 more · ⌘P then = Lane Metrics');
    expect(Array.from(cell(strip, 'more').querySelectorAll('kbd'), (key) => key.textContent)).toEqual(['⌘P', '=']);
    expect(tasks.map((job) => job.id)).toEqual(['old', 'completed', 'unknown', 'orphaned', 'new', 'older']);

    tasks[0].startedAt = 6_000;
    strip.update({ tasks, now: 10_000 });
    expect(rowIds(strip)).toEqual(['old', 'new', 'unknown']);
    strip.dispose();
  });

  it('keeps a failure beside an earlier-started job until a job starts after it ended', () => {
    const strip = new BackgroundTaskStrip();
    const earlier = task({ id: 'earlier', startedAt: 1_000 });
    const tasks = [
      earlier,
      task({ id: 'failed', startedAt: 2_000, endedAt: 3_000, state: 'exited', exitCode: 1 }),
    ];
    strip.update({ tasks, now: 3_500 });
    expect(rowIds(strip)).toEqual(['failed', 'earlier']);

    earlier.state = 'exited';
    earlier.exitCode = 0;
    earlier.endedAt = 4_000;
    strip.update({ tasks, now: 4_500 });
    expect(rowIds(strip)).toEqual(['failed', 'earlier']);
    strip.update({ tasks, now: 4_000 + BACKGROUND_DONE_LINGER_MS });
    expect(rowIds(strip)).toEqual(['failed']);
    expect(cell(strip, 'elapsed').textContent).toBe('0:01');

    const next = task({ id: 'next', startedAt: 20_000 });
    tasks.push(next);
    strip.update({ tasks, now: 21_000 });
    expect(rowIds(strip)).toEqual(['next']);
    next.state = 'exited';
    next.exitCode = 0;
    next.endedAt = 22_000;
    strip.update({ tasks, now: 22_000 + BACKGROUND_DONE_LINGER_MS });
    expect(strip.el.hidden).toBe(true);
    expect(rowIds(strip)).toEqual([]);
    strip.update({ tasks: [], now: 30_000 });
    expect(strip.el.hidden).toBe(true);
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

  it('repaints only the changed cell of a row', () => {
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
