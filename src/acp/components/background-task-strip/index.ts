// Spec 384 — persistent background activity beside the prompt.
import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { keyHint } from '../../../ui/kbd';
import { disposeList, reconcile } from '../../../ui/list';
import { formatElapsed } from '../../harness-format';
import type { BackgroundTask } from '../../harness-view-types';
import type { ComponentDef } from '../types';
import './background-task-strip.css';

export interface BackgroundTaskStripProps {
  readonly tasks: readonly BackgroundTask[];
  readonly now: number;
}

interface RowProps {
  readonly id: string;
  readonly state: string;
  readonly label: string;
  readonly command: string;
  readonly elapsed: string;
  readonly lastLine: string;
}

const block = 'acp-harness__background-strip';

/** A successful job's final row leaves the strip this long after it ended. */
export const BACKGROUND_DONE_LINGER_MS = 5_000;

/** No live clock: an unsettled row carries no elapsed time, so a poll that
 *  learns nothing new writes nothing. A settled row shows its final duration. */
function rowProps(task: BackgroundTask): RowProps {
  let state: string = task.state;
  let label: string;
  switch (task.state) {
    case 'running':
      label = 'RUNNING';
      break;
    case 'unknown':
      label = 'OUTPUT UNAVAILABLE';
      break;
    case 'orphaned':
      label = 'NO PROCESS MATCH';
      break;
    case 'exited':
      state = task.exitCode === null ? 'unknown' : task.exitCode === 0 ? 'done' : 'failed';
      label = task.exitCode === null
        ? 'OUTPUT UNAVAILABLE'
        : `${task.exitCode === 0 ? 'DONE' : 'FAILED'} · exit ${task.exitCode}`;
      break;
  }
  return {
    id: task.id,
    state,
    label,
    command: task.command,
    elapsed: task.state === 'exited' && task.endedAt !== null ? formatElapsed(task.endedAt - task.startedAt) : '',
    lastLine: task.lastLine,
  };
}

const MAX_ROWS = 3;

/**
 * Unsettled jobs always qualify. A final result qualifies until a job is started
 * after it ended; an `exit 0` additionally drops out once its linger window
 * passes, while a failure (or an exit without a code) stays.
 */
function visibleTasks(
  tasks: readonly BackgroundTask[],
  now: number,
): { shown: BackgroundTask[]; overflow: number } {
  const latestStart = tasks.reduce((latest, task) => Math.max(latest, task.startedAt), -Infinity);
  const qualifying = tasks.filter((task) => {
    if (task.state !== 'exited') return true;
    const endedAt = task.endedAt ?? task.startedAt;
    if (latestStart > endedAt) return false;
    return task.exitCode !== 0 || now - endedAt < BACKGROUND_DONE_LINGER_MS;
  });
  qualifying.sort((a, b) => b.startedAt - a.startedAt);
  return { shown: qualifying.slice(0, MAX_ROWS), overflow: Math.max(0, qualifying.length - MAX_ROWS) };
}

/** Write only a cell whose text changed, so one changed field re-lays out one cell. */
function setText(node: HTMLElement, text: string, withTitle = false): void {
  if (node.textContent !== text) node.textContent = text;
  if (withTitle && node.title !== text) node.title = text;
}

class TaskRow extends Component<RowProps> {
  private readonly state = el('span', { class: `${block}-state` });
  private readonly command = el('span', { class: `${block}-command` });
  private readonly elapsed = el('span', { class: `${block}-elapsed` });
  private readonly tail = el('span', { class: `${block}-tail` });

  constructor() {
    super(el('div', { class: `${block}-row` }));
    this.el.append(
      el('span', { class: `${block}-led`, attrs: { 'aria-hidden': 'true' } }),
      this.state,
      this.command,
      this.elapsed,
      this.tail,
    );
  }

  protected readDeps(next: RowProps): readonly unknown[] {
    return [next.id, next.state, next.label, next.command, next.elapsed, next.lastLine];
  }

  protected syncClasses(next: RowProps): void {
    const className = `${block}-row ${block}-row--${next.state}`;
    if (this.el.className !== className) this.el.className = className;
  }

  protected paint(next: RowProps): void {
    this.syncClasses(next);
    if (this.el.dataset.taskId !== next.id) this.el.dataset.taskId = next.id;
    setText(this.state, next.label);
    setText(this.command, next.command, true);
    setText(this.elapsed, next.elapsed);
    setText(this.tail, next.lastLine, true);
  }
}

export class BackgroundTaskStrip extends Component<BackgroundTaskStripProps> {
  private readonly rows = el('div', { class: `${block}-rows` });
  private readonly moreCount = el('span', { class: `${block}-more-count` });
  private readonly more = el('div', { class: `${block}-more` });

  constructor() {
    super(el('section', { class: block, attrs: { 'aria-label': 'Background tasks', hidden: true } }));
    this.more.hidden = true;
    this.more.append(this.moreCount, ' · ', keyHint({
      keys: ['⌘P', '='], keySeparator: ' then ', label: 'Lane Metrics',
    }));
    this.el.append(
      el('span', { class: `${block}-label`, text: 'BACKGROUND' }),
      el('div', { class: `${block}-body` }, this.rows, this.more),
    );
  }

  protected readDeps(next: BackgroundTaskStripProps): readonly unknown[] {
    const { shown, overflow } = visibleTasks(next.tasks, next.now);
    // Snapshot displayed scalars, never mutable task/array identities or raw poll time.
    return [overflow, ...shown.flatMap((task) => {
      const row = rowProps(task);
      return [row.id, row.state, row.label, row.command, row.elapsed, row.lastLine];
    })];
  }

  protected syncClasses(next: BackgroundTaskStripProps): void {
    const hidden = visibleTasks(next.tasks, next.now).shown.length === 0;
    if (this.el.hidden !== hidden) this.el.hidden = hidden;
  }

  protected paint(next: BackgroundTaskStripProps): void {
    this.syncClasses(next);
    const { shown, overflow } = visibleTasks(next.tasks, next.now);
    const moreText = overflow > 0 ? `+${overflow} more` : '';
    if (this.moreCount.textContent !== moreText) this.moreCount.textContent = moreText;
    if (this.more.hidden !== !moreText) this.more.hidden = !moreText;
    reconcile<RowProps, TaskRow>(this.rows, shown.map((task) => rowProps(task)), {
      key: (task) => task.id,
      create: (task) => {
        const row = new TaskRow();
        row.update(task);
        return row;
      },
      update: (row, task) => row.update(task),
    });
  }

  protected onDispose(): void {
    disposeList(this.rows);
  }
}

export const def: ComponentDef = {
  id: 'background-task-strip',
  blocks: [block],
};
