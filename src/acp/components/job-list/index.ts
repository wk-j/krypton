// Spec 370 — `JobList`.
//
// The body of an OMP `wait` row: one line per background job, read from the
// structured `rawOutput.details.jobs[]` snapshot. The `content` text OMP writes
// for the model — `## Still Running` markdown plus `<system-notice>` nudges —
// is never rendered, the same choice OMP's own TUI makes.
//
// `wait` sends a progress frame every 500 ms. Lines are keyed by job id and
// each line's dep tuple decides whether it writes, so a frame that only moved
// a duration rewrites one time span and nothing else.

import './job-list.css';

import { Component } from '../../../ui/component';
import { classes, el } from '../../../ui/dom';
import { reconcile, syncOrder, type ListNode } from '../../../ui/list';
import { formatToolElapsed } from '../../harness-tool-render';
import type { JobLine, JobStatus, JobsPayload } from '../../harness-view-types';
import type { ComponentDef } from '../types';

/** The subagent card's glyph set, so the two surfaces read the same. */
const STATUS_GLYPH: Readonly<Record<JobStatus, string>> = {
  running: '\u25cf',
  completed: '\u2713',
  failed: '\u2717',
  cancelled: '\u2013',
};

/** Guarded so a frame that changed nothing writes nothing. */
function setText(node: Node, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** `exit N` for a failed job with a code, then the elapsed time. */
export function jobStats(job: JobLine): string {
  return [
    job.status === 'failed' && job.exitCode !== null && job.exitCode !== 0 ? `exit ${job.exitCode}` : '',
    job.durationMs > 0 ? formatToolElapsed(job.durationMs) : '',
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
}

interface ListItem {
  readonly key: string;
  /** Null for the overflow tail. */
  readonly job: JobLine | null;
  readonly overflow: number;
}

interface ListChild extends ListNode {
  sync(item: ListItem): void;
}

class JobRow extends Component<JobLine> implements ListChild {
  private readonly glyph = el('span', { class: 'acp-harness__job-glyph' });
  private readonly name = el('span', { class: 'acp-harness__job-name' });
  private readonly type = el('span', { class: 'acp-harness__job-type' });
  private readonly label = el('span', { class: 'acp-harness__job-label' });
  private readonly stats = el('span', { class: 'acp-harness__job-stats' });

  constructor() {
    super(el('div'));
  }

  sync(item: ListItem): void {
    if (item.job) this.update(item.job);
  }

  protected readDeps(next: JobLine): readonly unknown[] {
    return [next.id, next.type, next.status, next.label, next.durationMs, next.exitCode];
  }

  protected syncClasses(next: JobLine): void {
    this.el.className = classes('acp-harness__job', `acp-harness__job--${next.status}`);
  }

  protected paint(next: JobLine): void {
    this.syncClasses(next);
    setText(this.glyph, STATUS_GLYPH[next.status]);
    setText(this.name, next.id);
    setText(this.type, next.type);
    const labelled = next.label.length > 0 && next.label !== next.id;
    if (labelled) setText(this.label, next.label);
    setText(this.stats, jobStats(next));
    syncOrder(this.el, [this.glyph, this.name, this.type, ...(labelled ? [this.label] : []), this.stats]);
  }
}

/** The `+N more` tail — a reconciled child so the list owns every node. */
class MoreRow extends Component<{ readonly count: number }> implements ListChild {
  constructor() {
    super(el('span'));
  }

  sync(item: ListItem): void {
    this.update({ count: item.overflow });
  }

  protected readDeps(next: { readonly count: number }): readonly unknown[] {
    return [next.count];
  }

  protected syncClasses(_next: { readonly count: number }): void {
    this.el.className = 'acp-harness__job-more';
  }

  protected paint(next: { readonly count: number }): void {
    this.syncClasses(next);
    setText(this.el, `+${next.count} more`);
  }
}

export interface JobListProps {
  readonly payload: JobsPayload;
}

export class JobList extends Component<JobListProps> {
  constructor() {
    super(el('div'));
  }

  /** The lane decoder builds a fresh jobs payload per frame, so identity is the diff. */
  protected readDeps(next: JobListProps): readonly unknown[] {
    return [next.payload];
  }

  protected syncClasses(next: JobListProps): void {
    this.el.className = 'acp-harness__jobs';
    // `no jobs` / `interrupted` live in the head summary; an empty well says nothing.
    this.el.hidden = next.payload.jobs.length === 0 && next.payload.overflow === 0;
  }

  protected paint(next: JobListProps): void {
    this.syncClasses(next);
    const items: ListItem[] = next.payload.jobs.map((job) => ({ key: `job:${job.id}`, job, overflow: 0 }));
    if (next.payload.overflow > 0) items.push({ key: 'more', job: null, overflow: next.payload.overflow });
    reconcile<ListItem, ListChild>(this.el, items, {
      key: (item) => item.key,
      create: (item) => {
        const child: ListChild = item.job ? new JobRow() : new MoreRow();
        child.sync(item);
        return child;
      },
      update: (child, item) => child.sync(item),
    });
  }
}

export const def: ComponentDef = {
  id: 'job-list',
  blocks: [
    'acp-harness__jobs',
    'acp-harness__job',
    'acp-harness__job-glyph',
    'acp-harness__job-name',
    'acp-harness__job-type',
    'acp-harness__job-label',
    'acp-harness__job-stats',
    'acp-harness__job-more',
  ],
};
