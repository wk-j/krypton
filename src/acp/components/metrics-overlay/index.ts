// Spec 302 §7.13 — `MetricsOverlay`.
//
// The per-lane process tree (`acp-harness-view.ts:13603-13643` `renderMetricsPanel`
// / `renderMetricsLaneBlock` + `harness-lane-chrome.ts:146-303` `renderProcessTree`).
//
// Today a 2 s poll rebuilds the whole overlay with `innerHTML`, which re-parses
// every process row of every lane twice a second. Here each lane block and each
// process row is a component keyed by lane id / pid, and each CPU and RSS cell
// is a `Meter` whose deps are the ROUNDED width — so a sample that moves inside
// the same whole percent writes nothing at all.

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { formatCpu, formatRss } from '../../harness-format';
import { describeProc, metricPercent } from '../../harness-lane-chrome';
import type { AcpLaneMetrics, AcpLaneProcMetric } from '../../../types';
import type { BackgroundTask } from '../../harness-view-types';
import { BackgroundTasks } from '../background-tasks';
import { Meter } from '../meter';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './metrics-overlay.css';

/** One lane's slot in the overlay. `metrics` is null until the poll answers. */
export interface MetricsLane {
  readonly id: string;
  readonly displayName: string;
  readonly metrics: AcpLaneMetrics | null;
  /** spec 305: the lane's detached shell jobs, rendered under its tree. */
  readonly tasks: readonly BackgroundTask[];
  /** spec 305: poll timestamp, so a task row's elapsed is a dependency. */
  readonly now: number;
}

export interface MetricsOverlayProps {
  readonly open: boolean;
  readonly lanes: readonly MetricsLane[];
  /** Poll period, for the head hint: `refreshes every 2s`. */
  readonly pollMs: number;
  onAutoClose?(): void;
}

/** A process row: tree prefix + name + label, pid, and the two meters. */
interface ProcRowProps {
  readonly proc: AcpLaneProcMetric;
  /** `│  ├─ ` — the prefix and branch the walk computed for this row. */
  readonly tree: string;
  readonly root: boolean;
  /** Denominator of the RSS meter: the lane's total resident size. */
  readonly totalRss: number;
}

class ProcRow extends Component<ProcRowProps> {
  private readonly tree: HTMLElement;
  private readonly name: HTMLElement;
  private readonly cpu = new Meter('track');
  private readonly rss = new Meter('track');
  private detail: HTMLElement | null = null;
  private role: HTMLElement | null = null;
  private readonly process: HTMLElement;
  private readonly pid: HTMLElement;

  constructor() {
    super(el('div'));
    this.tree = el('span', { class: 'acp-harness__metrics-tree' });
    this.name = el('span', { class: 'acp-harness__metrics-name' });
    this.process = el('span', { class: 'acp-harness__metrics-process' }, this.tree, this.name);
    this.pid = el('span', { class: 'acp-harness__metrics-pid' });
    this.el.append(this.process, this.pid, this.cpu.el, this.rss.el);
  }

  protected readDeps(next: ProcRowProps): readonly unknown[] {
    const { label, command } = describeProc(next.proc);
    return [
      next.proc.pid,
      next.proc.name,
      label,
      command,
      next.tree,
      next.root,
      formatCpu(next.proc.cpu_percent),
      metricPercent(next.proc.cpu_percent, 100).toFixed(0),
      formatRss(next.proc.rss_mb),
      metricPercent(next.proc.rss_mb, next.totalRss).toFixed(0),
    ];
  }

  protected syncClasses(next: ProcRowProps): void {
    this.el.className = 'acp-harness__metrics-row'
      + (next.root ? ' acp-harness__metrics-row--root' : '');
  }

  protected paint(next: ProcRowProps): void {
    this.syncClasses(next);
    const { label, command } = describeProc(next.proc);
    setAttr(this.el, 'title', command);
    this.tree.textContent = next.tree;
    this.name.textContent = next.proc.name;
    this.syncDetail(label);
    this.syncRole(next.root);
    this.pid.textContent = String(next.proc.pid);
    this.cpu.update({
      mode: 'track',
      tone: 'cpu',
      value: metricPercent(next.proc.cpu_percent, 100),
      max: 100,
      valueText: formatCpu(next.proc.cpu_percent),
    });
    this.rss.update({
      mode: 'track',
      tone: 'rss',
      value: metricPercent(next.proc.rss_mb, next.totalRss),
      max: 100,
      valueText: formatRss(next.proc.rss_mb),
    });
  }

  /** The "which node is this?" answer, present only when there is one. */
  private syncDetail(label: string): void {
    if (!label) {
      this.detail?.remove();
      this.detail = null;
      return;
    }
    const node = this.detail ?? el('span', { class: 'acp-harness__metrics-detail' });
    this.detail = node;
    node.textContent = label;
    if (node.parentNode !== this.process) this.process.appendChild(node);
  }

  private syncRole(root: boolean): void {
    if (!root) {
      this.role?.remove();
      this.role = null;
      return;
    }
    const node = this.role ?? el('span', { class: 'acp-harness__metrics-role', text: 'adapter' });
    this.role = node;
    if (node.parentNode !== this.process) this.process.appendChild(node);
  }

  protected onDispose(): void {
    this.cpu.dispose();
    this.rss.dispose();
  }
}

/** A process in walk order, with the tree prefix its depth earned. */
interface WalkedProc {
  readonly proc: AcpLaneProcMetric;
  readonly tree: string;
  readonly root: boolean;
}

/** Depth-first walk from the root pid, children ordered by CPU descending. */
function walkProcesses(metrics: AcpLaneMetrics): WalkedProc[] {
  const childrenByParent = new Map<number, number[]>();
  const byPid = new Map<number, AcpLaneProcMetric>();
  for (const proc of metrics.processes) {
    byPid.set(proc.pid, proc);
    if (proc.parent_pid === null || proc.parent_pid === undefined) continue;
    const siblings = childrenByParent.get(proc.parent_pid) ?? [];
    siblings.push(proc.pid);
    childrenByParent.set(proc.parent_pid, siblings);
  }
  const out: WalkedProc[] = [];
  const walk = (pid: number, depth: number, isLast: boolean, prefix: string): void => {
    const proc = byPid.get(pid);
    if (!proc) return;
    const branch = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
    out.push({ proc, tree: prefix + branch, root: depth === 0 });
    const kids = [...(childrenByParent.get(pid) ?? [])]
      .filter((kid) => byPid.has(kid))
      .sort((a, b) => (byPid.get(b)?.cpu_percent ?? 0) - (byPid.get(a)?.cpu_percent ?? 0));
    kids.forEach((kid, index) => {
      const nextPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
      walk(kid, depth + 1, index === kids.length - 1, nextPrefix);
    });
  };
  walk(metrics.root_pid, 0, true, '');
  return out;
}

class MetricsLaneBlock extends Component<MetricsLane> {
  private readonly name: HTMLElement;
  private readonly totals: HTMLElement;
  /** spec 305: always mounted, hidden by its own sheet while the lane has no
   *  tasks — a lane can have a live job and a dead adapter at the same time. */
  private readonly tasks = new BackgroundTasks();
  private treeBlock: HTMLElement | null = null;
  private rows: HTMLElement | null = null;

  constructor() {
    super(el('section', { class: 'acp-harness__metrics-lane' }));
    this.name = el('span', { class: 'acp-harness__metrics-lane-name' });
    this.totals = el('span', { class: 'acp-harness__metrics-lane-totals' });
    this.el.appendChild(el('div', { class: 'acp-harness__metrics-lane-head' }, this.name, this.totals));
    this.el.appendChild(this.tasks.el);
  }

  protected readDeps(next: MetricsLane): readonly unknown[] {
    const metrics = next.metrics;
    return [
      next.displayName,
      metrics?.root_alive ?? false,
      metrics?.proc_count ?? 0,
      metrics ? formatCpu(metrics.total_cpu_percent) : null,
      metrics ? formatRss(metrics.total_rss_mb) : null,
      metrics?.processes,
      metrics?.processes.map((proc) => `${proc.pid}:${proc.cpu_percent}:${proc.rss_mb}`).join('|') ?? '',
      // Tasks move on their own cadence; `now` only counts while rows exist, so
      // a harness with no background job still repaints nothing per poll.
      next.tasks.length,
      next.tasks.length === 0
        ? ''
        : `${next.now}|${next.tasks.map((task) => `${task.id}:${task.state}:${task.bytes}`).join('|')}`,
    ];
  }

  protected syncClasses(_next: MetricsLane): void {
    this.el.className = 'acp-harness__metrics-lane';
  }

  protected paint(next: MetricsLane): void {
    this.syncClasses(next);
    this.tasks.update({ tasks: next.tasks, now: next.now });
    this.name.textContent = next.displayName;
    const metrics = next.metrics;
    if (metrics && metrics.root_alive) {
      this.totals.replaceChildren(
        el('span', {
          class: 'acp-harness__metrics-total acp-harness__metrics-total--cpu',
          text: `CPU ${formatCpu(metrics.total_cpu_percent)}`,
        }),
        el('span', { class: 'acp-harness__metrics-total', text: `MEM ${formatRss(metrics.total_rss_mb)}` }),
        el('span', {
          class: 'acp-harness__metrics-total',
          text: `${metrics.proc_count} proc${metrics.proc_count === 1 ? '' : 's'}`,
        }),
      );
    } else {
      this.totals.replaceChildren(el('span', {
        class: 'acp-harness__metrics-total acp-harness__metrics-total--dim',
        text: 'no live process',
      }));
    }

    if (!metrics || !metrics.root_alive || metrics.proc_count === 0) {
      this.dropTree();
      return;
    }
    this.paintTree(metrics);
  }

  private paintTree(metrics: AcpLaneMetrics): void {
    if (this.treeBlock === null || this.rows === null) {
      // `reconcile` makes its container's children EXACTLY the list, so the
      // header row cannot share a container with the process rows.
      this.rows = el('div', { class: 'acp-harness__metrics-rows' });
      this.treeBlock = el(
        'div',
        { class: 'acp-harness__metrics-tree-block' },
        el(
          'div',
          { class: 'acp-harness__metrics-row acp-harness__metrics-row--header' },
          el('span', { text: 'Process' }),
          el('span', { text: 'PID' }),
          el('span', { text: 'CPU' }),
          el('span', { text: 'Mem' }),
        ),
        this.rows,
      );
      // spec 305: the tree goes above the task section, which is mounted for
      // the block's whole life.
      this.el.insertBefore(this.treeBlock, this.tasks.el);
    }
    reconcile<WalkedProc, ProcRow>(this.rows, walkProcesses(metrics), {
      key: (walked) => String(walked.proc.pid),
      create: (walked) => {
        const row = new ProcRow();
        row.update({ ...walked, totalRss: metrics.total_rss_mb });
        return row;
      },
      update: (row, walked) => row.update({ ...walked, totalRss: metrics.total_rss_mb }),
    });
  }

  private dropTree(): void {
    if (this.rows !== null) disposeList(this.rows);
    this.treeBlock?.remove();
    this.treeBlock = null;
    this.rows = null;
  }

  protected onDispose(): void {
    this.tasks.dispose();
    this.dropTree();
  }
}

export class MetricsOverlay extends Component<MetricsOverlayProps> {
  private readonly shell: OverlayShell;
  private readonly body: HTMLElement;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.body = el('div', { class: 'acp-harness__metrics-lanes' });
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  protected readDeps(next: MetricsOverlayProps): readonly unknown[] {
    return [
      next.open,
      next.lanes,
      next.lanes.length,
      next.lanes.map((lane) => lane.id).join('\u0001'),
      next.pollMs,
    ];
  }

  protected syncClasses(_next: MetricsOverlayProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: MetricsOverlayProps): void {
    reconcile<MetricsLane, MetricsLaneBlock>(this.body, next.lanes, {
      key: (lane) => lane.id,
      create: (lane) => {
        const block = new MetricsLaneBlock();
        block.update(lane);
        return block;
      },
      update: (block, lane) => block.update(lane),
    });
    this.shell.update({
      open: next.open,
      name: 'metrics',
      block: 'acp-harness__metrics',
      title: 'Lane Resource Usage',
      sub: `Esc to close · refreshes every ${(next.pollMs / 1000).toFixed(0)}s`,
      body: this.body,
      onAutoClose: next.onAutoClose,
    });
  }

  protected onDispose(): void {
    disposeList(this.body);
    this.shell.dispose();
  }
}

export const def: ComponentDef = {
  id: 'metrics-overlay',
  blocks: ['acp-harness__metrics-overlay', 'acp-harness__metrics'],
};
