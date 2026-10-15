// Spec 302 §5.3 — `HeatPanel`.
//
// `heat [tools][5m] · active ████████ peek ███░░░░░ 0.62`, plus the collapsed
// detail table. Ported from `AcpHarnessView.mountLanePeekHeat`
// (src/acp/acp-harness-view.ts:12427-12545 in spec 302's numbering; the method
// today starts at `private mountLanePeekHeat`).
//
// **The listener leak this fixes.** `mountLanePeekHeat` opened with
// `root.replaceChildren()` and then rebuilt every node — including three
// `addEventListener` calls — on EVERY peek pass, even though `renderLanePeek`
// deliberately reuses the card when the lane and reason are unchanged
// (`sameCard`). The nodes were thrown away so the listeners went with them, but
// a 1 Hz rail refresh still meant a full teardown and re-attach of the whole
// control strip every second for as long as a peek was on screen. Here the
// tree and its three listeners are built ONCE in the constructor, through
// `this.bag`, and `paint()` only writes text, widths and the two custom
// properties. `dispose()` detaches them.
//
// The callbacks are deliberately NOT dependencies: the view builds a fresh
// closure per pass, so including them would force a repaint every time. The
// single listener is retargeted instead (the `ActionButton` precedent).
//
// `null` props mean "no heat for this pair" — the mount point stays an empty
// `.acp-harness__lane-peek-heat-root`, which is exactly what the card showed
// when either lane was missing from `this.lanes`.

import './heat-panel.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { formatHeatTokenSuffix } from '../../lane-peek';
import type {
  LaneHeatSide,
  LanePairHeatSummary,
  LanePeekHeatMetric,
  LanePeekHeatWindow,
} from '../../harness-view-types';
import type { ComponentDef } from '../types';

export interface HeatPanelProps {
  readonly summary: LanePairHeatSummary;
  /** The raw setting, so the button reads `auto` when the metric is derived. */
  readonly metric: LanePeekHeatMetric;
  /** The EFFECTIVE window — `30s` for a direct peer peek, else the setting. */
  readonly window: LanePeekHeatWindow;
  readonly activeName: string;
  readonly peekName: string;
  readonly activeAccent: string;
  readonly peekAccent: string;
  readonly expanded: boolean;
  readonly onCycleMetric?: () => void;
  readonly onCycleWindow?: () => void;
  readonly onToggleDetail?: () => void;
}

/** One `active` / `peek` column: tag, track, fill, score. */
interface HeatSideNodes {
  readonly col: HTMLElement;
  readonly fill: HTMLElement;
  readonly score: HTMLElement;
}

/** One detail-table row: the two value cells are all that ever change. */
interface HeatDetailRow {
  readonly active: HTMLElement;
  readonly peek: HTMLElement;
}

function buildSide(which: 'active' | 'peek'): HeatSideNodes {
  const tag = el('span', {
    class: `acp-harness__lane-peek-heat-tag acp-harness__lane-peek-heat-tag--${which}`,
    text: which,
  });
  const fill = el('div', {
    class: `acp-harness__lane-peek-heat-fill acp-harness__lane-peek-heat-fill--${which}`,
  });
  const track = el('div', { class: 'acp-harness__lane-peek-heat-track' }, fill);
  const score = el('span', { class: 'acp-harness__lane-peek-heat-score' });
  const row = el('div', { class: 'acp-harness__lane-peek-heat-bar-row' }, track, score);
  return { col: el('div', { class: 'acp-harness__lane-peek-heat-side' }, tag, row), fill, score };
}

function buildDetailRow(key: string): { tr: HTMLElement; cells: HeatDetailRow } {
  const head = el('th', { attrs: { scope: 'row' }, text: key });
  const active = el('td');
  const peek = el('td');
  return { tr: el('tr', {}, head, active, peek), cells: { active, peek } };
}

export class HeatPanel extends Component<HeatPanelProps | null> {
  private readonly section = el('section', { class: 'acp-harness__lane-peek-heat' });
  private readonly compact = el('div', { class: 'acp-harness__lane-peek-heat-compact' });
  private readonly metricBtn = el('button', {
    class: 'acp-harness__lane-peek-heat-cmd',
    attrs: { type: 'button' },
    title: 'Cycle peek heat metric (click or command palette)',
  });
  private readonly windowBtn = el('button', {
    class: 'acp-harness__lane-peek-heat-cmd',
    attrs: { type: 'button' },
    title: 'Cycle peek heat time window (click or command palette)',
  });
  private readonly delta = el('div', { class: 'acp-harness__lane-peek-heat-delta' });
  private readonly expandedEl = el('div', { class: 'acp-harness__lane-peek-heat-expanded' });
  private readonly activeSide = buildSide('active');
  private readonly peekSide = buildSide('peek');
  private readonly detail: Readonly<Record<'tools' | 'tokens' | 'peer' | 'cpu', HeatDetailRow>>;
  private cycleMetric: (() => void) | null = null;
  private cycleWindow: (() => void) | null = null;
  private toggleDetail: (() => void) | null = null;

  constructor() {
    super(el('div', { class: 'acp-harness__lane-peek-heat-root' }));

    const bars = el(
      'div',
      { class: 'acp-harness__lane-peek-heat-bars' },
      this.activeSide.col,
      this.peekSide.col,
    );
    this.compact.append(
      el('span', { class: 'acp-harness__lane-peek-heat-prefix', text: 'heat' }),
      this.metricBtn,
      el('span', { class: 'acp-harness__lane-peek-heat-sep', text: '·' }),
      this.windowBtn,
      bars,
      this.delta,
    );

    const table = el('table', { class: 'acp-harness__lane-peek-heat-table' });
    table.append(
      el('caption', { class: 'acp-harness__lane-peek-heat-caption', text: 'Heat detail' }),
      el(
        'tr',
        {},
        el('th', { attrs: { scope: 'col' }, text: '' }),
        el('th', { attrs: { scope: 'col' }, text: 'active' }),
        el('th', { attrs: { scope: 'col' }, text: 'peek' }),
      ),
    );
    const tools = buildDetailRow('tools');
    const tokens = buildDetailRow('tokens');
    const peer = buildDetailRow('peer');
    const cpu = buildDetailRow('cpu');
    table.append(tools.tr, tokens.tr, peer.tr, cpu.tr);
    this.detail = {
      tools: tools.cells,
      tokens: tokens.cells,
      peer: peer.cells,
      cpu: cpu.cells,
    };
    this.expandedEl.appendChild(table);
    this.section.append(this.compact, this.expandedEl);

    // ONE attach, for the component's whole life. This is the fix.
    this.bag.listen(this.metricBtn, 'click', (ev: Event) => {
      ev.stopPropagation();
      this.cycleMetric?.();
    });
    this.bag.listen(this.windowBtn, 'click', (ev: Event) => {
      ev.stopPropagation();
      this.cycleWindow?.();
    });
    this.bag.listen(this.compact, 'click', () => {
      this.toggleDetail?.();
    });
  }

  update(next: HeatPanelProps | null): void {
    this.cycleMetric = next?.onCycleMetric ?? null;
    this.cycleWindow = next?.onCycleWindow ?? null;
    this.toggleDetail = next?.onToggleDetail ?? null;
    super.update(next);
  }

  protected readDeps(next: HeatPanelProps | null): readonly unknown[] {
    if (!next) return [null];
    const { active, peeked } = next.summary;
    return [
      active.score,
      peeked.score,
      active.toolDelta,
      peeked.toolDelta,
      active.tokenDelta,
      peeked.tokenDelta,
      active.peerDelta,
      peeked.peerDelta,
      active.cpuPeak,
      peeked.cpuPeak,
      next.summary.deltaLine,
      next.summary.unavailableReason,
      next.metric,
      next.window,
      next.expanded,
      next.activeName,
      next.peekName,
      next.activeAccent,
      next.peekAccent,
    ];
  }

  protected syncClasses(_next: HeatPanelProps | null): void {
    this.el.className = 'acp-harness__lane-peek-heat-root';
  }

  protected paint(next: HeatPanelProps | null): void {
    this.syncClasses(next);
    if (!next) {
      this.section.remove();
      this.el.style.removeProperty('--acp-peek-heat-active');
      this.el.style.removeProperty('--acp-peek-heat-peek');
      return;
    }
    this.el.style.setProperty('--acp-peek-heat-active', next.activeAccent);
    this.el.style.setProperty('--acp-peek-heat-peek', next.peekAccent);
    setAttr(this.section, 'title', next.summary.unavailableReason ?? undefined);
    this.metricBtn.textContent = next.metric;
    this.windowBtn.textContent = next.window;
    this.paintSide(this.activeSide, next.summary.active, `Active: ${next.activeName}`);
    this.paintSide(this.peekSide, next.summary.peeked, `Peeked: ${next.peekName}`);
    this.delta.textContent = next.summary.deltaLine;
    this.expandedEl.hidden = !next.expanded;
    this.paintDetail(next.summary);
    if (this.section.parentNode !== this.el) this.el.appendChild(this.section);
  }

  private paintSide(nodes: HeatSideNodes, side: LaneHeatSide, title: string): void {
    nodes.col.title = title;
    nodes.fill.style.width = `${Math.min(100, Math.max(0, side.score))}%`;
    nodes.score.textContent = String(side.score);
  }

  private paintDetail(summary: LanePairHeatSummary): void {
    const { active, peeked } = summary;
    this.detail.tools.active.textContent = String(active.toolDelta);
    this.detail.tools.peek.textContent = String(peeked.toolDelta);
    this.detail.tokens.active.textContent = tokenCell(active);
    this.detail.tokens.peek.textContent = tokenCell(peeked);
    this.detail.peer.active.textContent = String(active.peerDelta);
    this.detail.peer.peek.textContent = String(peeked.peerDelta);
    this.detail.cpu.active.textContent = cpuCell(active);
    this.detail.cpu.peek.textContent = cpuCell(peeked);
  }
}

function tokenCell(side: LaneHeatSide): string {
  if (side.tokenDelta === null) return '—';
  return `+${formatHeatTokenSuffix(side.tokenDelta)}`;
}

function cpuCell(side: LaneHeatSide): string {
  if (side.cpuPeak === null) return '—';
  return `${Math.round(side.cpuPeak)}%`;
}

export const def: ComponentDef = { id: 'heat-panel', blocks: ['acp-harness__lane-peek-heat'] };
