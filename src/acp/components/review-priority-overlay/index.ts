// Spec 302 §7.9 — `ReviewPriorityOverlay`.
//
// The read-only reading-priority roll-up (spec 162). Ports
// `review-priority-overlay.ts:35-128`: the panel wipe becomes a props
// comparison, the `loc` / foot `innerHTML` become nodes, the lane switcher
// (character-for-character the review matrix's loop) becomes `TabStrip`, and
// the level tag becomes `Chip`.
//
// An awareness roll-up, not a queue: there is no jump/Enter affordance, because
// acting on a range still happens in that lane's Diff Window.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import type { ReviewPriorityRange, ReviewPriorityReport } from '../../types';
import { Chip } from '../chip';
import { KeyHintBar, type KeyHint, type KeyHintBarProps } from '../key-hint-bar';
import { OverlayShell } from '../overlay-shell';
import { TabStrip } from '../tab-strip';
import type { ComponentDef } from '../types';
import './review-priority-overlay.css';

export interface ReviewPriorityLane {
  readonly id: string;
  readonly label: string;
  /** `high`-range count — what helps the human pick which lane to inspect. */
  readonly highCount: number;
}

export interface ReviewPriorityOverlayProps {
  readonly open: boolean;
  /** Lanes with at least one reported range, stable order. */
  readonly lanes: readonly ReviewPriorityLane[];
  readonly selectedIndex: number;
  /** The selected lane's latest report, or null. */
  readonly report: ReviewPriorityReport | null;
  onAutoClose?(): void;
}

export class ReviewPriorityOverlay extends Component<ReviewPriorityOverlayProps> {
  private readonly shell: OverlayShell;
  private readonly tabs: TabStrip;
  private readonly main: HTMLElement;
  private readonly body: HTMLElement;
  /** One chip per rendered row, reused across repaints in row order. */
  private readonly tags: Chip[] = [];

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.tabs = new TabStrip();
    this.body = el('div', { class: 'acp-priority__body' });
    this.main = el('div', { class: 'acp-priority__main' });
    this.main.appendChild(this.body);
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  protected readDeps(next: ReviewPriorityOverlayProps): readonly unknown[] {
    return [
      next.open,
      next.lanes.map((lane) => `${lane.id}\u0001${lane.label}\u0001${lane.highCount}`).join('\u0002'),
      next.selectedIndex,
      next.report,
      next.report?.ranges,
      next.report?.ranges.length ?? 0,
    ];
  }

  protected syncClasses(_next: ReviewPriorityOverlayProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: ReviewPriorityOverlayProps): void {
    const empty = next.lanes.length === 0 || next.report === null;
    if (!empty) {
      this.paintTabs(next);
      this.paintGroups(next.report.ranges);
    }
    this.shell.update({
      open: next.open,
      name: 'priority',
      block: 'acp-priority',
      title: 'Review priority',
      sub: 'reading order — advisory · open the lane’s diff to act',
      body: this.main,
      hints: this.hints(next),
      empty: empty ? 'No reading priority reported.' : undefined,
      onAutoClose: next.onAutoClose,
    });
  }

  /** The switcher is only meaningful with more than one lane reporting. */
  private paintTabs(next: ReviewPriorityOverlayProps): void {
    if (next.lanes.length <= 1) {
      this.tabs.el.remove();
      return;
    }
    const active = next.lanes[next.selectedIndex] ?? next.lanes[0];
    this.tabs.update({
      tabs: next.lanes.map((lane) => ({ id: lane.id, label: lane.label, count: lane.highCount })),
      activeId: active.id,
      block: 'acp-priority',
      item: 'lane',
      activeClass: 'is-active',
      count: 'suffix',
    });
    if (this.tabs.el.parentNode !== this.main) this.main.insertBefore(this.tabs.el, this.body);
  }

  private paintGroups(ranges: readonly ReviewPriorityRange[]): void {
    const groups: HTMLElement[] = [];
    let tagIndex = 0;
    for (const [label, level] of [['read first', 'high'], ['routine', 'routine']] as const) {
      const matching = ranges.filter((range) => range.level === level);
      if (matching.length === 0) continue;
      const group = el('div', { class: 'acp-priority__group' });
      group.appendChild(el('div', {
        class: 'acp-priority__group-label',
        text: `${label} · ${matching.length}`,
      }));
      for (const range of matching) group.appendChild(this.row(range, tagIndex++));
      groups.push(group);
    }
    for (const extra of this.tags.splice(tagIndex)) extra.dispose();
    this.body.replaceChildren(...groups);
  }

  private row(range: ReviewPriorityRange, index: number): HTMLElement {
    const tag = this.tags[index] ?? new Chip();
    this.tags[index] = tag;
    tag.update({ block: 'acp-priority__tag', text: range.level, modifiers: [`acp-priority__tag--${range.level}`] });

    // A single-line range shows just the line; a span shows start–end.
    const lines = range.lineStart === range.lineEnd
      ? `${range.lineStart}`
      : `${range.lineStart}–${range.lineEnd}`;
    const loc = el('span', { class: 'acp-priority__loc' }, ...[
      el('span', { class: 'acp-priority__file', text: range.file }),
      el('span', { class: 'acp-priority__lines', text: `:${lines}` }),
    ]);
    const content = el('span', { class: 'acp-priority__row-content' }, loc);
    if (range.reason) {
      content.appendChild(el('span', { class: 'acp-priority__reason', text: range.reason }));
    }
    return el('div', { class: `acp-priority__row acp-priority__row--${range.level}` }, tag.el, content);
  }

  private hints(next: ReviewPriorityOverlayProps): KeyHintBarProps {
    const hints: KeyHint[] = [];
    if (next.lanes.length > 1) hints.push({ keys: ['j', 'k'], label: 'switch lane' });
    hints.push({ keys: ['esc'], label: 'close' });
    return {
      hints,
      note: 'read-only — advisory reading hint',
      noteClass: 'acp-priority__foot-note',
      style: 'kbd',
      block: 'acp-priority__foot',
    };
  }

  protected onDispose(): void {
    for (const tag of this.tags) tag.dispose();
    this.tags.length = 0;
    this.tabs.dispose();
    this.shell.dispose();
  }
}

export const def: ComponentDef = {
  id: 'review-priority-overlay',
  blocks: ['acp-harness__priority-overlay', 'acp-priority'],
};
