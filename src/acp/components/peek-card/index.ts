// Spec 302 §5.1 — `PeekCard`.
//
//   codex-1            awaiting peer · locked      5m+
//   ▸ approve Bash                     git push origin main
//   plan   4/9  wire composer meta segments
//   tool   Edit · lane-peek.ts
//   review pass 2/4 · reviewing
//   heat   [tools][5m] · active ████████ peek ███░░░░░
//   sonnet-4-6  128.4k/200.0k  92% 1.4G  mcp 14
//
// Ports `renderLanePeek` (src/acp/lane-peek.ts:549-605) together with the
// builders it called — `renderLanePeekToolRow`, `renderLanePeekEventRow`,
// `renderLanePeekRow`, `renderLanePeekPlanRow`, `renderLanePeekStatChips`,
// `lanePeekAgeLabel` — and `patchPeekActiveTool` (:363-390).
//
// **The patch function is gone.** It existed because a tool delta must not
// remount the card or its heat ring, so it reached into the finished card,
// found `[data-peek-row="tool"]`, rebuilt that one row through a throwaway
// `innerHTML` wrapper and `replaceWith`-ed it. Here every child of the card is
// a keyed list entry, so a tool tick is `update()` on the tool row and every
// other node — head, event, plan, loop, heat, chips — keeps its identity
// without anyone writing code to protect it.
//
// Two call-order details from the old code are deliberately resolved rather
// than reproduced:
//   * `patchPeekActiveTool` inserted a NEW tool row right after the event row
//     (or the head), i.e. ABOVE `plan` and `shell`, while `renderLanePeek`
//     emitted it BELOW them. The two disagreed; the initial-render order is the
//     canonical one and is what this component always emits.
//   * `patchPeekActiveTool` removed the event row when the event had become a
//     duplicate of the tool row. That is `peekEventRowDuplicatesTool` deciding
//     whether the `event` part exists at all, which is the same rule applied
//     once instead of twice.

import './peek-card.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import {
  basename,
  formatCoarseAge,
  formatCount,
  formatElapsed,
  truncateInline,
} from '../../harness-format';
import { statusLabel } from '../../harness-lane-chrome';
import {
  lanePeekPriorityClass,
  peekEventRowDuplicatesTool,
  peekReviewLoop,
} from '../../lane-peek';
import type { LanePeekCandidate, LanePeekSnapshot } from '../../harness-view-types';
import { HeatPanel, type HeatPanelProps } from '../heat-panel';
import { ReviewLoopRows, type ReviewLoopRowsProps } from '../review-loop-rows';
import type { ComponentDef } from '../types';
import { PeekRow, segmentNodes, segmentSignature, type PeekRowProps, type PeekSegment } from './row';

export { PeekRow, segmentNodes, segmentSignature } from './row';
export type { PeekRowProps, PeekSegment } from './row';

export interface PeekCardProps {
  readonly candidate: LanePeekCandidate;
  readonly snapshot: LanePeekSnapshot | null;
  readonly locked: boolean;
  /** The pass clock — drives the age label and the ended-loop window. */
  readonly now: number;
  /**
   * Heat needs both lanes' metric histories, which only the view holds, so it
   * arrives as a prop. `null` leaves the mount point empty, exactly as the card
   * did when either lane was missing from `this.lanes`.
   */
  readonly heat: HeatPanelProps | null;
}

interface PeekHeadProps {
  readonly name: string;
  readonly status: string;
  readonly age: string;
}

interface PeekEventProps {
  readonly segments: readonly PeekSegment[];
  readonly meta: string;
}

interface PeekPlanProps {
  readonly count: string;
  readonly text: string;
}

interface PeekChipProps {
  readonly hot: boolean;
  readonly segments: readonly PeekSegment[];
}

interface PeekFootProps {
  readonly chips: readonly PeekChipProps[];
}

type PeekPart =
  | { readonly kind: 'head'; readonly key: string; readonly head: PeekHeadProps }
  | { readonly kind: 'event'; readonly key: string; readonly event: PeekEventProps }
  | { readonly kind: 'row'; readonly key: string; readonly row: PeekRowProps }
  | { readonly kind: 'plan'; readonly key: string; readonly plan: PeekPlanProps }
  | { readonly kind: 'loop'; readonly key: string; readonly loop: ReviewLoopRowsProps }
  | { readonly kind: 'heat'; readonly key: string; readonly heat: HeatPanelProps | null }
  | { readonly kind: 'foot'; readonly key: string; readonly foot: PeekFootProps };

type PeekChild = PeekHead | PeekEvent | PeekRow | PeekPlanRow | ReviewLoopRows | HeatPanel | PeekFoot;

class PeekHead extends Component<PeekHeadProps> {
  private readonly nameEl = el('span', { class: 'acp-harness__lane-peek-name' });
  private readonly statusEl = el('span', { class: 'acp-harness__lane-peek-status' });
  private readonly ageEl = el('span', { class: 'acp-harness__lane-peek-age' });

  constructor() {
    super(el('header'));
    this.el.append(this.nameEl, this.statusEl);
  }

  protected readDeps(next: PeekHeadProps): readonly unknown[] {
    return [next.name, next.status, next.age];
  }

  protected syncClasses(_next: PeekHeadProps): void {
    this.el.className = 'acp-harness__lane-peek-head';
  }

  protected paint(next: PeekHeadProps): void {
    this.syncClasses(next);
    this.nameEl.textContent = next.name;
    this.statusEl.textContent = next.status;
    // No age, no node — the header emitted two spans when the lane had no age.
    if (next.age) {
      this.ageEl.textContent = next.age;
      if (this.ageEl.parentNode !== this.el) this.el.appendChild(this.ageEl);
    } else {
      this.ageEl.remove();
    }
  }
}

class PeekEvent extends Component<PeekEventProps> {
  private readonly textEl = el('span', { class: 'acp-harness__lane-peek-event-text' });
  private readonly metaEl = el('span', { class: 'acp-harness__lane-peek-event-meta' });

  constructor() {
    super(el('div'));
    this.el.appendChild(this.textEl);
  }

  protected readDeps(next: PeekEventProps): readonly unknown[] {
    return [segmentSignature(next.segments), next.meta];
  }

  protected syncClasses(_next: PeekEventProps): void {
    this.el.className = 'acp-harness__lane-peek-event';
  }

  protected paint(next: PeekEventProps): void {
    this.syncClasses(next);
    this.textEl.replaceChildren(...segmentNodes(next.segments));
    if (next.meta) {
      this.metaEl.textContent = next.meta;
      if (this.metaEl.parentNode !== this.el) this.el.appendChild(this.metaEl);
    } else {
      this.metaEl.remove();
    }
  }
}

class PeekPlanRow extends Component<PeekPlanProps> {
  private readonly countEl = el('span', { class: 'acp-harness__lane-peek-plan-count' });
  private readonly textEl = el('span', { class: 'acp-harness__lane-peek-plan-text' });

  constructor() {
    super(el('div'));
    this.el.append(
      el('span', { class: 'acp-harness__lane-peek-prefix', text: 'plan' }),
      el('span', { class: 'acp-harness__lane-peek-plan' }, this.countEl, this.textEl),
    );
  }

  protected readDeps(next: PeekPlanProps): readonly unknown[] {
    return [next.count, next.text];
  }

  protected syncClasses(_next: PeekPlanProps): void {
    this.el.className = 'acp-harness__lane-peek-row';
  }

  protected paint(next: PeekPlanProps): void {
    this.syncClasses(next);
    this.countEl.textContent = next.count;
    this.textEl.textContent = next.text;
  }
}

class PeekChip extends Component<PeekChipProps> {
  constructor() {
    super(el('span'));
  }

  protected readDeps(next: PeekChipProps): readonly unknown[] {
    return [next.hot, segmentSignature(next.segments)];
  }

  protected syncClasses(next: PeekChipProps): void {
    this.el.className = next.hot
      ? 'acp-harness__lane-peek-chip acp-harness__lane-peek-chip--hot'
      : 'acp-harness__lane-peek-chip';
  }

  protected paint(next: PeekChipProps): void {
    this.syncClasses(next);
    this.el.replaceChildren(...segmentNodes(next.segments));
  }
}

class PeekFoot extends Component<PeekFootProps> {
  constructor() {
    super(el('footer'));
  }

  protected readDeps(next: PeekFootProps): readonly unknown[] {
    return [next.chips.map((chip) => `${chip.hot ? 'h' : ''}${segmentSignature(chip.segments)}`).join('\u001d')];
  }

  protected syncClasses(_next: PeekFootProps): void {
    this.el.className = 'acp-harness__lane-peek-foot';
  }

  protected paint(next: PeekFootProps): void {
    this.syncClasses(next);
    reconcile(this.el, next.chips, {
      key: (_chip: PeekChipProps, index: number): string => `#${index}`,
      create: (chip: PeekChipProps): PeekChip => {
        const cmp = new PeekChip();
        cmp.update(chip);
        return cmp;
      },
      update: (cmp: PeekChip, chip: PeekChipProps): void => cmp.update(chip),
    });
  }

  protected onDispose(): void {
    disposeList(this.el);
  }
}

/** Busy lanes show the running turn's elapsed time; everything else shows how
 *  long ago the peeked event happened. */
export function peekAgeLabel(
  snapshot: LanePeekSnapshot,
  candidate: LanePeekCandidate,
  now: number,
): string {
  if (snapshot.status === 'busy' && snapshot.activeTurnStartedAt) {
    return formatElapsed(now - snapshot.activeTurnStartedAt);
  }
  if (!candidate.at) return '';
  return formatCoarseAge(now - candidate.at);
}

/** The `▸ …` activity line. One shape per payload kind, reason label as fallback. */
function eventProps(candidate: LanePeekCandidate): PeekEventProps {
  const payload = candidate.summary.payload;
  if (payload?.kind === 'permission') {
    return {
      segments: [{ kind: 'text', text: '▸ approve ' }, { kind: 'strong', text: payload.toolName }],
      meta: truncateInline(payload.subject, 36),
    };
  }
  if (payload?.kind === 'peer') {
    const verb = payload.direction === 'in'
      ? 'message from'
      : payload.direction === 'out' ? 'sent to' : 'awaiting';
    return {
      segments: [
        { kind: 'text', text: `▸ ${verb} ` },
        { kind: 'strong', text: payload.peerDisplayName },
      ],
      meta: payload.ageLabel,
    };
  }
  if (payload?.kind === 'error') {
    return {
      segments: [
        { kind: 'text', text: '▸ ' },
        { kind: 'strong', text: truncateInline(payload.message, 32) },
      ],
      meta: '',
    };
  }
  if (payload?.kind === 'activity') {
    return {
      segments: [{ kind: 'text', text: `▸ ${truncateInline(payload.label, 36)}` }],
      meta: payload.ageLabel,
    };
  }
  return { segments: [{ kind: 'text', text: `▸ ${candidate.reasonLabel}` }], meta: '' };
}

/** The footer chips: model · context · process · mcp. Empty means no footer. */
function statChips(snapshot: LanePeekSnapshot): PeekChipProps[] {
  const chips: PeekChipProps[] = [];
  if (snapshot.modelName) {
    chips.push({ hot: false, segments: [{ kind: 'text', text: snapshot.modelName }] });
  }
  const usage = snapshot.usage;
  if (usage && typeof usage.used === 'number') {
    const used = formatCount(usage.used);
    chips.push(typeof usage.size === 'number' && usage.size > 0
      ? {
        hot: false,
        segments: [
          { kind: 'strong', text: used },
          { kind: 'text', text: `/${formatCount(usage.size)}` },
        ],
      }
      : { hot: false, segments: [{ kind: 'strong', text: used }, { kind: 'text', text: ' ctx' }] });
  }
  const metrics = snapshot.metrics;
  if (metrics && metrics.proc_count > 0) {
    const memory = metrics.total_rss_mb >= 1024
      ? `${(metrics.total_rss_mb / 1024).toFixed(1)}G`
      : `${Math.round(metrics.total_rss_mb)}M`;
    chips.push({
      hot: metrics.total_cpu_percent >= 80 || metrics.total_rss_mb >= 1500,
      segments: [
        { kind: 'strong', text: `${Math.round(metrics.total_cpu_percent)}%` },
        { kind: 'text', text: ` ${memory}` },
      ],
    });
  }
  const mcp = snapshot.mcp;
  if (mcp && mcp.toolsCallCount > 0) {
    chips.push({
      hot: false,
      segments: [
        { kind: 'text', text: 'mcp ' },
        { kind: 'strong', text: String(mcp.toolsCallCount) },
      ],
    });
  }
  return chips;
}

/** Every child of the card, in emission order, as one keyed list. */
function peekParts(next: PeekCardProps): PeekPart[] {
  const { candidate, snapshot, now } = next;
  const statusText = `${statusLabel(candidate.summary.status)}${next.locked ? ' · locked' : ''}`;
  const parts: PeekPart[] = [{
    kind: 'head',
    key: 'head',
    head: {
      name: candidate.displayName,
      status: statusText,
      age: snapshot ? peekAgeLabel(snapshot, candidate, now) : '',
    },
  }];

  const loop = peekReviewLoop(snapshot, now);
  // A `lane-review-pass` peek's reason IS the loop; its rows say more.
  if (!peekEventRowDuplicatesTool(candidate, snapshot) && !(loop && candidate.reasonKey === 'lane-review-pass')) {
    parts.push({ kind: 'event', key: 'event', event: eventProps(candidate) });
  }

  if (snapshot?.plan) {
    parts.push({
      kind: 'plan',
      key: 'plan',
      plan: {
        count: `${snapshot.plan.done}/${snapshot.plan.total}`,
        text: snapshot.plan.activeText ? truncateInline(snapshot.plan.activeText, 32) : 'all done',
      },
    });
  }

  if (snapshot?.pendingShell && candidate.reasonKey !== 'lane-shell') {
    parts.push({
      kind: 'row',
      key: 'shell',
      row: { prefix: 'shell', segments: [{ kind: 'strong', text: 'running' }] },
    });
  }

  if (snapshot?.activeTool && snapshot.status === 'busy') {
    const tool = snapshot.activeTool;
    const segments: PeekSegment[] = [{ kind: 'strong', text: tool.name }];
    if (tool.subject) segments.push({ kind: 'text', text: ` · ${truncateInline(tool.subject, 36)}` });
    parts.push({ kind: 'row', key: 'tool', row: { prefix: 'tool', dataRow: 'tool', segments } });
  } else if (snapshot?.latestMeaningful && candidate.summary.payload?.kind !== 'activity') {
    parts.push({
      kind: 'row',
      key: 'last',
      row: {
        prefix: 'last',
        segments: [{ kind: 'text', text: truncateInline(snapshot.latestMeaningful.label, 40) }],
      },
    });
  }

  if (snapshot?.recentFiles && snapshot.recentFiles.length > 0) {
    const files = snapshot.recentFiles.map(basename).join(', ');
    parts.push({
      kind: 'row',
      key: 'files',
      row: { prefix: 'files', segments: [{ kind: 'text', text: truncateInline(files, 40) }] },
    });
  }

  if (snapshot && snapshot.inboxDepth > 0) {
    parts.push({
      kind: 'row',
      key: 'inbox',
      row: {
        prefix: 'inbox',
        segments: [
          { kind: 'strong', text: String(snapshot.inboxDepth) },
          { kind: 'text', text: ' pending' },
        ],
      },
    });
  }

  if (loop) parts.push({ kind: 'loop', key: 'loop', loop: { loop } });

  if (snapshot) {
    parts.push({ kind: 'heat', key: 'heat', heat: next.heat });
    const chips = statChips(snapshot);
    if (chips.length > 0) parts.push({ kind: 'foot', key: 'foot', foot: { chips } });
  }
  return parts;
}

function createPart(part: PeekPart): PeekChild {
  switch (part.kind) {
    case 'head': {
      const cmp = new PeekHead();
      cmp.update(part.head);
      return cmp;
    }
    case 'event': {
      const cmp = new PeekEvent();
      cmp.update(part.event);
      return cmp;
    }
    case 'row': {
      const cmp = new PeekRow();
      cmp.update(part.row);
      return cmp;
    }
    case 'plan': {
      const cmp = new PeekPlanRow();
      cmp.update(part.plan);
      return cmp;
    }
    case 'loop': {
      const cmp = new ReviewLoopRows();
      cmp.update(part.loop);
      return cmp;
    }
    case 'heat': {
      const cmp = new HeatPanel();
      cmp.update(part.heat);
      return cmp;
    }
    case 'foot': {
      const cmp = new PeekFoot();
      cmp.update(part.foot);
      return cmp;
    }
  }
}

function updatePart(cmp: PeekChild, part: PeekPart): void {
  if (part.kind === 'head' && cmp instanceof PeekHead) cmp.update(part.head);
  else if (part.kind === 'event' && cmp instanceof PeekEvent) cmp.update(part.event);
  else if (part.kind === 'row' && cmp instanceof PeekRow) cmp.update(part.row);
  else if (part.kind === 'plan' && cmp instanceof PeekPlanRow) cmp.update(part.plan);
  else if (part.kind === 'loop' && cmp instanceof ReviewLoopRows) cmp.update(part.loop);
  else if (part.kind === 'heat' && cmp instanceof HeatPanel) cmp.update(part.heat);
  else if (part.kind === 'foot' && cmp instanceof PeekFoot) cmp.update(part.foot);
}

export class PeekCard extends Component<PeekCardProps> {
  constructor() {
    super(el('aside'));
  }

  protected readDeps(next: PeekCardProps): readonly unknown[] {
    // The view rebuilds `candidate` and `snapshot` every pass, so these are the
    // props themselves: identity here, real diffing one level down where each
    // child owns a comparable tuple. A caller that hands back the same props
    // object gets zero DOM writes.
    return [next.candidate, next.snapshot, next.locked, next.now, next.heat];
  }

  protected syncClasses(_next: PeekCardProps): void {
    this.el.className = 'acp-harness__lane-peek';
  }

  protected paint(next: PeekCardProps): void {
    this.syncClasses(next);
    setAttr(this.el, 'data-reason', next.candidate.reasonKey);
    setAttr(this.el, 'data-lane-id', next.candidate.laneId);
    setAttr(this.el, 'data-priority', lanePeekPriorityClass(next.candidate));
    reconcile(this.el, peekParts(next), {
      key: (part: PeekPart): string => part.key,
      create: createPart,
      update: updatePart,
    });
  }

  protected onDispose(): void {
    disposeList(this.el);
  }
}

export const def: ComponentDef = { id: 'peek-card', blocks: ['acp-harness__lane-peek'] };
