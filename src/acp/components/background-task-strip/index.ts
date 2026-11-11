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

function rowProps(task: BackgroundTask, now: number): RowProps {
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
    elapsed: formatElapsed((task.endedAt ?? now) - task.startedAt),
    lastLine: task.lastLine,
  };
}

function visibleTasks(tasks: readonly BackgroundTask[]): { count: number; shown: BackgroundTask[] } {
  const unsettled = tasks.filter((task) => task.state !== 'exited');
  const candidates = unsettled.length > 0 ? unsettled : [...tasks];
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  return { count: unsettled.length, shown: candidates.slice(0, unsettled.length > 0 ? 3 : 1) };
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
    this.el.className = `${block}-row ${block}-row--${next.state}`;
  }

  protected paint(next: RowProps): void {
    this.syncClasses(next);
    this.el.dataset.taskId = next.id;
    this.state.textContent = next.label;
    this.command.textContent = next.command;
    this.command.title = next.command;
    this.elapsed.textContent = next.elapsed;
    this.tail.textContent = next.lastLine;
    this.tail.title = next.lastLine;
  }
}

export class BackgroundTaskStrip extends Component<BackgroundTaskStripProps> {
  private readonly count = el('span', { class: `${block}-count` });
  private readonly rows = el('div', { class: `${block}-rows` });
  private readonly more = el('div', { class: `${block}-more` });

  constructor() {
    super(el('section', { class: block, attrs: { 'aria-label': 'Background tasks', hidden: true } }));
    this.more.hidden = true;
    this.el.append(
      el('div', { class: `${block}-head` },
        el('span', { class: `${block}-label`, text: 'BACKGROUND' }),
        this.count,
        el('span', { class: `${block}-hint` }, keyHint({
          keys: ['⌘P', '='], keySeparator: ' then ', label: 'Lane Metrics',
        })),
      ),
      this.rows,
      this.more,
    );
  }

  protected readDeps(next: BackgroundTaskStripProps): readonly unknown[] {
    const { count, shown } = visibleTasks(next.tasks);
    // Snapshot displayed scalars, never mutable task/array identities or raw poll time.
    return [next.tasks.length === 0, count, ...shown.flatMap((task) => {
      const row = rowProps(task, next.now);
      return [row.id, row.state, row.label, row.command, row.elapsed, row.lastLine];
    })];
  }

  protected syncClasses(next: BackgroundTaskStripProps): void {
    const hidden = next.tasks.length === 0;
    if (this.el.hidden !== hidden) this.el.hidden = hidden;
  }

  protected paint(next: BackgroundTaskStripProps): void {
    this.syncClasses(next);
    const { count, shown } = visibleTasks(next.tasks);
    const countText = String(count);
    if (this.count.textContent !== countText) this.count.textContent = countText;
    const moreText = count > shown.length ? `+${count - shown.length} more · Lane Metrics` : '';
    if (this.more.textContent !== moreText) this.more.textContent = moreText;
    if (this.more.hidden !== !moreText) this.more.hidden = !moreText;
    reconcile<RowProps, TaskRow>(this.rows, shown.map((task) => rowProps(task, next.now)), {
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
