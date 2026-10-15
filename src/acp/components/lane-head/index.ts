// Spec 302 §4.2 — `LaneHead`.
//
// The lane's first row: status symbol, name + backend logo, status word, the
// chip strip (inbox / orchestrator / model / mode / mcp / sandbox / bypass /
// metrics) and the activity tail. Ported from `harness-lane-chrome.ts:86-130`
// (`renderLaneHead`) plus every chip builder it calls (`:132-144`, `:318-400`).
//
// This also replaces the per-head `innerHTML` the 2 s metrics poll ran
// (`acp-harness-view.ts:13571-13590`, `refreshMetricsRender`). That is the
// reason the dependency tuple is built out of the *rendered* chip values
// rather than the raw metric floats: `total_cpu_percent` wobbles in the
// seventh decimal every poll while `formatCpu()` of it does not, so a tick
// whose displayed numbers did not move performs zero DOM writes — and the
// busy spinner, which is a child component with its own node, keeps its frame.
//
// The head element is NOT wiped on paint: the timeline badge is appended after
// the component's own children by the view, so this component owns a fixed set
// of five child nodes and only reorders chips inside the strip.

import './lane-head.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { formatCpu, formatRss } from '../../harness-format';
import { harnessSymbolEl } from '../../harness-icons';
import { isPollyImplementerBypass, isSaltyExecutorBypass, laneActivity, metricsBucket } from '../../harness-lane-chrome';
import { backendLogoId } from '../../harness-lane-identity';
import type { HarnessLane } from '../../harness-view-types';
import type { PendingPeerSummary } from '../../inter-lane';
import type { HarnessMcpLaneStats } from '../../types';
import type { AcpLaneMetrics } from '../../../types';
import { Chip, type ChipProps } from '../chip';
import { LaneSymbol, statusLabel } from '../lane-symbol';
import type { ComponentDef } from '../types';

export interface LaneHeadProps {
  readonly lane: HarnessLane;
  readonly active: boolean;
  readonly mcp: HarnessMcpLaneStats | null;
  readonly metrics: AcpLaneMetrics | null;
  readonly inboxDepth: number;
  readonly pendingPeers: PendingPeerSummary[];
  readonly isOrchestrator: boolean;
}

interface HeadChip {
  readonly key: string;
  readonly props: ChipProps;
}

/** What `renderMetricsChip` paints, already formatted. `null` when the lane has
 *  no live process tree, which is also when the chip is absent entirely. */
interface MetricsChipProps {
  readonly bucket: 'idle' | 'warm' | 'hot' | 'crit';
  readonly cpu: string;
  readonly rss: string;
  readonly title: string;
}

function metricsChipProps(metrics: AcpLaneMetrics | null): MetricsChipProps | null {
  if (!metrics || !metrics.root_alive || metrics.proc_count === 0) return null;
  return {
    bucket: metricsBucket(metrics.total_cpu_percent),
    cpu: formatCpu(metrics.total_cpu_percent),
    rss: formatRss(metrics.total_rss_mb),
    title: `pid ${metrics.root_pid} · adapter + ${metrics.proc_count - 1} children · ⌘P m for breakdown`,
  };
}

/** The two-cell CPU/RSS pill. Not a `Chip` — it has element children, and
 *  `.acp-harness__lane-metrics-cpu` is tinted per bucket by its own rule. */
class MetricsChip extends Component<MetricsChipProps> {
  private readonly cpuEl = el('span', { class: 'acp-harness__lane-metrics-cpu' });
  private readonly rssEl = el('span', { class: 'acp-harness__lane-metrics-rss' });

  constructor() {
    super(el('span'));
    this.el.append(this.cpuEl, this.rssEl);
  }

  protected readDeps(next: MetricsChipProps): readonly unknown[] {
    return [next.bucket, next.cpu, next.rss, next.title];
  }

  protected syncClasses(next: MetricsChipProps): void {
    this.el.className = `acp-harness__lane-metrics acp-harness__lane-metrics--${next.bucket}`;
  }

  protected paint(next: MetricsChipProps): void {
    this.syncClasses(next);
    this.el.setAttribute('title', next.title);
    this.cpuEl.textContent = next.cpu;
    this.rssEl.textContent = next.rss;
  }
}

const WARN_ICON = { id: 'warn', cls: 'acp-harness__icon--dot' } as const;

/**
 * Every chip except the metrics pill, in the order `renderLaneHead` emitted
 * them. Pure, so `readDeps()` and `paint()` agree by construction.
 */
function headChips(next: LaneHeadProps): HeadChip[] {
  const lane = next.lane;
  const out: HeadChip[] = [];

  // Inbox rides inside the chips span (grid column 4). As a loose head-grid
  // sibling it has no `grid-column` and stretches across the 1fr activity track.
  if (next.inboxDepth > 0) {
    out.push({
      key: 'inbox',
      props: {
        block: 'acp-harness__lane-inbox',
        text: '',
        icon: { id: 'inbox', cls: 'acp-harness__icon--dot' },
        trailing: String(next.inboxDepth),
        title: `${next.inboxDepth} pending peer message${next.inboxDepth === 1 ? '' : 's'}`,
      },
    });
  }

  // spec 180: behavior-neutral orchestrator-seat badge (≤1 per harness).
  if (next.isOrchestrator) {
    out.push({
      key: 'orchestrator',
      props: {
        block: 'acp-harness__lane-orchestrator',
        text: '◆ orch',
        title: 'orchestrator seat (#orchestrator)',
      },
    });
  }

  if (lane.modelName) {
    out.push(lane.modelApplyFailed
      ? {
        key: 'model',
        props: {
          block: 'acp-harness__lane-model',
          tone: 'warn',
          text: '',
          icon: WARN_ICON,
          trailing: ` ${lane.modelName}`,
          title: `requested model ${lane.modelName} not applied — agent is using its default or prior model (model selection request failed)`,
        },
      }
      : {
        key: 'model',
        props: {
          block: 'acp-harness__lane-model',
          text: lane.modelName,
          title: `model ${lane.modelName}`,
        },
      });
  }

  if (lane.currentMode) {
    out.push({
      key: 'mode',
      props: {
        block: 'acp-harness__lane-mode',
        text: lane.currentMode.name,
        title: lane.currentMode.description
          ? `${lane.currentMode.name} — ${lane.currentMode.description}`
          : `mode ${lane.currentMode.id}`,
      },
    });
  }

  const mcp = next.mcp;
  if (!mcp || mcp.toolsListCount === 0) {
    out.push({
      key: 'mcp',
      props: {
        block: 'acp-harness__lane-mcp',
        tone: 'off',
        text: 'mcp —',
        title: mcp
          ? `MCP descriptor sent; adapter has not called tools/list. init=${mcp.initializeCount}`
          : 'MCP descriptor sent; adapter has not contacted the server.',
      },
    });
  } else {
    out.push({
      key: 'mcp',
      props: {
        block: 'acp-harness__lane-mcp',
        tone: 'on',
        text: 'mcp ',
        icon: { id: 'check', cls: 'acp-harness__icon--dot' },
        trailing: mcp.toolsCallCount > 0 ? ` ${mcp.toolsCallCount}` : '',
        title: `tools/list ${mcp.toolsListCount} · tools/call ${mcp.toolsCallCount}`
          + (mcp.lastMethod ? ` · last ${mcp.lastMethod}` : ''),
      },
    });
  }

  // Backend-specific safety caveats: Pi is known to bypass the permission rail;
  // Junie still needs manual verification of ACP write-permission semantics.
  if (lane.backendId === 'pi-acp') {
    out.push({
      key: 'sandbox',
      props: {
        block: 'acp-harness__lane-sandbox',
        text: '',
        icon: WARN_ICON,
        trailing: ' unsandboxed',
        title: 'No permission gate — Pi runs edits and shell commands immediately. Use a sandboxed cwd or container if untrusted.',
      },
    });
  } else if (lane.backendId === 'junie') {
    out.push({
      key: 'sandbox',
      props: {
        block: 'acp-harness__lane-sandbox',
        text: '',
        icon: WARN_ICON,
        trailing: ' permissions unverified',
        title: 'Junie ACP write-permission behavior has not been verified yet. Krypton does not pass force/yolo/brave flags, but use a trusted cwd until verified.',
      },
    });
  }

  // spec 164 / spec 195 — Polly implementers and Salty mechanical/codex-peer
  // executors run with permissionMode bypass; surface it in the chrome.
  if (isPollyImplementerBypass(lane)) {
    out.push({
      key: 'polly',
      props: {
        block: 'acp-harness__lane-sandbox',
        text: 'polly-bypass',
        title: 'Polly worker — all tool permissions auto-accepted for this lane until the Polly role clears',
      },
    });
  }
  if (isSaltyExecutorBypass(lane)) {
    out.push({
      key: 'salty',
      props: {
        block: 'acp-harness__lane-sandbox',
        text: 'salty-bypass',
        title: 'Salty executor — all tool permissions auto-accepted for this lane until the Salty role clears (#salty clear)',
      },
    });
  }

  return out;
}

export class LaneHead extends Component<LaneHeadProps> {
  private readonly symbol = new LaneSymbol();
  private readonly nameEl = el('span', { class: 'acp-harness__lane-name' });
  private readonly statusEl = el('span', { class: 'acp-harness__lane-status' });
  private readonly chipsEl = el('span', { class: 'acp-harness__lane-chips' });
  private readonly activityEl = el('span', { class: 'acp-harness__lane-activity' });
  private readonly nameText = document.createTextNode('');
  private readonly chips = new Map<string, Chip>();
  private metricsChip: MetricsChip | null = null;
  private logoId: string | null = null;
  /** Computed by `readDeps()` and consumed by the `paint()` it guards, so the
   *  chip set is derived exactly once per update. */
  private nextChips: HeadChip[] = [];
  private nextMetrics: MetricsChipProps | null = null;
  private nextActivity = '';

  constructor() {
    super(el('header', { class: 'acp-harness__lane-head' }));
    this.nameEl.appendChild(this.nameText);
    this.el.append(this.symbol.el, this.nameEl, this.statusEl, this.chipsEl, this.activityEl);
  }

  protected readDeps(next: LaneHeadProps): readonly unknown[] {
    const lane = next.lane;
    this.nextChips = headChips(next);
    this.nextMetrics = metricsChipProps(next.metrics);
    this.nextActivity = laneActivity(lane, next.pendingPeers);
    const deps: unknown[] = [
      lane.status,
      next.active,
      lane.displayName,
      lane.backendId,
      this.nextActivity,
      this.nextMetrics?.bucket,
      this.nextMetrics?.cpu,
      this.nextMetrics?.rss,
      this.nextMetrics?.title,
      this.nextChips.length,
    ];
    for (const chip of this.nextChips) {
      deps.push(
        chip.key,
        chip.props.text,
        chip.props.trailing,
        chip.props.title,
        chip.props.tone,
        chip.props.icon?.id,
        chip.props.icon?.cls,
      );
    }
    return deps;
  }

  protected syncClasses(next: LaneHeadProps): void {
    this.el.className = 'acp-harness__lane-head';
    this.symbol.update({ status: next.lane.status });
  }

  protected paint(next: LaneHeadProps): void {
    const lane = next.lane;
    this.syncClasses(next);

    // spec 215: the backend logo rides inside the name span (no head-grid
    // column change) and inherits the name's color, so it dims with the
    // collapsed name.
    const logoId = backendLogoId(lane.backendId);
    if (logoId !== this.logoId) {
      this.logoId = logoId;
      this.nameEl.replaceChildren(harnessSymbolEl(logoId), this.nameText);
    }
    this.nameText.data = lane.displayName;

    this.statusEl.textContent = !next.active && lane.status === 'needs_permission'
      ? 'perm'
      : statusLabel(lane.status);
    this.activityEl.textContent = this.nextActivity;

    this.paintChips();
  }

  private paintChips(): void {
    const nodes: HTMLElement[] = [];
    const live = new Set<string>();
    for (const spec of this.nextChips) {
      live.add(spec.key);
      let chip = this.chips.get(spec.key);
      if (!chip) {
        chip = new Chip();
        this.chips.set(spec.key, chip);
      }
      chip.update(spec.props);
      nodes.push(chip.el);
    }
    for (const [key, chip] of this.chips) {
      if (live.has(key)) continue;
      chip.dispose();
      this.chips.delete(key);
    }

    const metrics = this.nextMetrics;
    if (metrics) {
      if (!this.metricsChip) this.metricsChip = new MetricsChip();
      this.metricsChip.update(metrics);
      nodes.push(this.metricsChip.el);
    } else if (this.metricsChip) {
      this.metricsChip.dispose();
      this.metricsChip = null;
    }

    syncOrder(this.chipsEl, nodes);
  }

  protected onDispose(): void {
    this.symbol.dispose();
    for (const chip of this.chips.values()) chip.dispose();
    this.chips.clear();
    this.metricsChip?.dispose();
    this.metricsChip = null;
  }
}

export const def: ComponentDef = {
  id: 'lane-head',
  blocks: [
    'acp-harness__lane-head',
    'acp-harness__lane-name',
    'acp-harness__lane-status',
    'acp-harness__lane-chips',
    'acp-harness__lane-activity',
    'acp-harness__lane-inbox',
    'acp-harness__lane-orchestrator',
    'acp-harness__lane-model',
    'acp-harness__lane-mode',
    'acp-harness__lane-sandbox',
    'acp-harness__lane-mcp',
    'acp-harness__lane-metrics',
    'acp-harness__lane-metrics-cpu',
    'acp-harness__lane-metrics-rss',
  ],
};
