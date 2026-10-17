// Spec 305 §UI changes — `BackgroundTasks`.
//
// One lane's detached shell jobs, rendered under its process tree in the `=`
// Lane Metrics overlay. The lane itself is `idle` while these run — its turn
// ended the moment the agent detached the command — so this section is the only
// place the work is named, timed and given an exit code.
//
// Rows are keyed by task id so a status change patches one row in place; the
// running glyph is the shared `Spinner`, which the widened `updateSpinnerTicker()`
// gate keeps advancing while no lane is busy.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { formatTaskBytes } from '../../harness-background-tasks';
import { formatCpu, formatElapsed, formatRss, truncateInline } from '../../harness-format';
import type { BackgroundTask } from '../../harness-view-types';
import { Spinner } from '../spinner';
import type { ComponentDef } from '../types';
import './background-tasks.css';

export interface BackgroundTasksProps {
  readonly tasks: readonly BackgroundTask[];
  /** Poll timestamp, so elapsed is a dependency and never read inside `paint`. */
  readonly now: number;
}

interface TaskRowProps {
  readonly task: BackgroundTask;
  readonly now: number;
}

/** `exit 0` / `18% · 420M` / `no process` — the one status cell. */
function statusText(task: BackgroundTask): string {
  if (task.state === 'exited') return `exit ${task.exitCode ?? '?'}`;
  if (task.state === 'orphaned') return 'no process';
  if (task.state === 'unknown') return 'output gone';
  if (task.cpuPercent === null || task.rssMb === null) return 'starting';
  return `${formatCpu(task.cpuPercent)} · ${formatRss(task.rssMb)}`;
}

function stateModifier(task: BackgroundTask): string {
  if (task.state === 'exited') return task.exitCode === 0 ? 'exited' : 'failed';
  return task.state;
}

function stateGlyph(task: BackgroundTask): string {
  if (task.state === 'exited') return task.exitCode === 0 ? '✓' : '✗';
  if (task.state === 'running') return '';
  return '·';
}

class TaskRow extends Component<TaskRowProps> {
  /** `Spinner` re-derives its own `class` on every paint (it drops the
   *  attribute entirely once static), so the grid cell has to be a span this
   *  row owns, with the spinner living inside it. */
  private readonly glyph = new Spinner();
  private readonly glyphCell: HTMLElement;
  private readonly id = el('span', { class: 'acp-harness__bg-task-id' });
  private readonly command = el('span', { class: 'acp-harness__bg-task-cmd' });
  private readonly elapsed = el('span', { class: 'acp-harness__bg-task-elapsed' });
  private readonly bytes = el('span', { class: 'acp-harness__bg-task-bytes' });
  private readonly status = el('span', { class: 'acp-harness__bg-task-status' });
  private readonly tail = el('span', { class: 'acp-harness__bg-task-tail' });

  constructor() {
    super(el('div'));
    this.glyphCell = el('span', { class: 'acp-harness__bg-task-glyph' }, this.glyph.el);
    this.el.append(
      this.glyphCell,
      this.id,
      this.command,
      this.elapsed,
      this.bytes,
      this.status,
      this.tail,
    );
  }

  protected readDeps(next: TaskRowProps): readonly unknown[] {
    const task = next.task;
    return [
      task.id,
      task.state,
      task.exitCode,
      task.command,
      formatElapsed((task.endedAt ?? next.now) - task.startedAt),
      formatTaskBytes(task.bytes),
      statusText(task),
      task.lastLine,
    ];
  }

  protected syncClasses(next: TaskRowProps): void {
    this.el.className = `acp-harness__bg-task acp-harness__bg-task--${stateModifier(next.task)}`;
  }

  protected paint(next: TaskRowProps): void {
    const task = next.task;
    this.syncClasses(next);
    this.glyph.update({ running: task.state === 'running', terminalGlyph: stateGlyph(task) });
    this.id.textContent = task.id;
    this.command.textContent = truncateInline(task.command, 96);
    this.command.setAttribute('title', task.command);
    this.elapsed.textContent = formatElapsed((task.endedAt ?? next.now) - task.startedAt);
    this.bytes.textContent = formatTaskBytes(task.bytes);
    this.status.textContent = statusText(task);
    this.tail.textContent = truncateInline(task.lastLine, 72);
    this.el.setAttribute('title', `${task.outputPath}${task.pid === null ? '' : ` · pid ${task.pid}`}`);
  }

  protected onDispose(): void {
    this.glyph.dispose();
  }
}

export class BackgroundTasks extends Component<BackgroundTasksProps> {
  private readonly rows = el('div', { class: 'acp-harness__bg-tasks-rows' });

  constructor() {
    super(el('section', { class: 'acp-harness__bg-tasks' }));
    // `reconcile` makes its container's children EXACTLY the list, so the
    // heading cannot share a container with the rows.
    this.el.append(
      el('div', { class: 'acp-harness__bg-tasks-head', text: 'BACKGROUND TASKS' }),
      this.rows,
    );
  }

  protected readDeps(next: BackgroundTasksProps): readonly unknown[] {
    return [
      next.tasks.length,
      next.tasks
        .map((task) => `${task.id}:${task.state}:${task.exitCode}:${task.bytes}:${task.lastLine}`)
        .join('\u0001'),
      next.now,
    ];
  }

  protected syncClasses(next: BackgroundTasksProps): void {
    this.el.className = 'acp-harness__bg-tasks';
    this.el.toggleAttribute('hidden', next.tasks.length === 0);
    this.el.setAttribute('data-count', String(next.tasks.length));
  }

  protected paint(next: BackgroundTasksProps): void {
    this.syncClasses(next);
    reconcile<BackgroundTask, TaskRow>(this.rows, next.tasks, {
      key: (task) => task.id,
      create: (task) => {
        const row = new TaskRow();
        row.update({ task, now: next.now });
        return row;
      },
      update: (row, task) => row.update({ task, now: next.now }),
    });
  }

  protected onDispose(): void {
    disposeList(this.rows);
  }
}

export const def: ComponentDef = {
  id: 'background-tasks',
  blocks: ['acp-harness__bg-tasks', 'acp-harness__bg-task'],
};
