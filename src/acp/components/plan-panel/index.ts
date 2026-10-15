// Spec 302 §5.6 — `PlanPanel`.
//
//   plan                                                        4 / 9
//   ████████████░░░░░░░░░░░░░░░░
//   ✓  extract kernel
//   ▸  wire composer meta segments            high
//   ·  delete signature
//
// Ports `AcpHarnessView.renderPlanPanel` (spec 302 cites
// `acp-harness-view.ts:14668-14726`; the method today starts at
// `private renderPlanPanel`). One `innerHTML` assignment rebuilt the header,
// the progress bar and every entry whenever a single entry's status flipped —
// and then re-queried the fresh tree to scroll the in-progress entry into
// view. Here the header and the bar are long-lived nodes, the entries are
// reconciled, and the scroll target is the entry component's own node.
//
// `Meter` does not cover the progress bar: its `track` mode emits
// `-value + -track > -fill`, and the plan bar is a bare
// `-progress > -progress-fill` with no value cell. Two nodes, one width — a
// third component in the tree would be more markup than it removes.

import './plan-panel.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import type { PlanEntry } from '../../types';
import type { ComponentDef } from '../types';

export interface PlanPanelProps {
  readonly entries: readonly PlanEntry[];
  readonly collapsed: boolean;
}

const ENTRY_MARK: Record<PlanEntry['status'], string> = {
  completed: '✓',
  in_progress: '▸',
  pending: '·',
};

class PlanEntryRow extends Component<PlanEntry> {
  private readonly markEl = el('span', { class: 'acp-harness__plan-entry-mark' });
  private readonly textEl = el('span', { class: 'acp-harness__plan-entry-text' });

  constructor() {
    super(el('div'));
    this.el.append(this.markEl, this.textEl);
  }

  protected readDeps(next: PlanEntry): readonly unknown[] {
    return [next.content, next.status, next.priority];
  }

  protected syncClasses(next: PlanEntry): void {
    this.el.className = `acp-harness__plan-entry acp-harness__plan-entry--${next.status}`;
  }

  protected paint(next: PlanEntry): void {
    this.syncClasses(next);
    this.markEl.textContent = ENTRY_MARK[next.status];
    this.textEl.replaceChildren(next.content);
    if (next.priority === 'high') {
      this.textEl.appendChild(el('span', { class: 'acp-harness__plan-priority', text: 'high' }));
    }
  }
}

export class PlanPanel extends Component<PlanPanelProps> {
  private readonly countEl = el('span', { class: 'acp-harness__plan-count' });
  private readonly doneEl = el('b');
  private readonly fillEl = el('span', { class: 'acp-harness__plan-progress-fill' });
  private readonly headerEl: HTMLElement;
  private readonly progressEl: HTMLElement;
  private readonly entriesEl = el('div', { class: 'acp-harness__plan-entries' });

  constructor() {
    super(el('div'));
    this.countEl.append(this.doneEl);
    this.headerEl = el(
      'div',
      { class: 'acp-harness__plan-header' },
      el('span', { class: 'acp-harness__plan-title', text: 'plan' }),
      this.countEl,
    );
    this.progressEl = el('div', { class: 'acp-harness__plan-progress' }, this.fillEl);
  }

  protected readDeps(next: PlanPanelProps): readonly unknown[] {
    return [next.entries, next.collapsed];
  }

  protected syncClasses(next: PlanPanelProps): void {
    this.el.className = next.collapsed
      ? 'acp-harness__plan acp-harness__plan--collapsed'
      : 'acp-harness__plan';
  }

  protected paint(next: PlanPanelProps): void {
    this.syncClasses(next);
    if (next.entries.length === 0) {
      // No plan, no panel: the rail slot has nothing to show and the card must
      // not leave last turn's entries on screen.
      disposeList(this.entriesEl);
      this.el.replaceChildren();
      this.el.hidden = true;
      this.el.removeAttribute('title');
      return;
    }
    const total = next.entries.length;
    const done = next.entries.filter((entry) => entry.status === 'completed').length;
    this.el.title = `p ${next.collapsed ? 'expand' : 'collapse'}`;
    this.doneEl.textContent = String(done);
    // ` / ${total}` is a sibling text node of the <b>, exactly as the template
    // emitted it; the <b> keeps its identity across a count change.
    while (this.countEl.lastChild && this.countEl.lastChild !== this.doneEl) {
      this.countEl.lastChild.remove();
    }
    this.countEl.append(` / ${total}`);
    this.fillEl.style.width = `${Math.round((done / total) * 100)}%`;

    reconcile(this.entriesEl, next.collapsed ? [] : next.entries, {
      key: (_entry: PlanEntry, index: number): string => `#${index}`,
      create: (entry: PlanEntry): PlanEntryRow => {
        const cmp = new PlanEntryRow();
        cmp.update(entry);
        return cmp;
      },
      update: (cmp: PlanEntryRow, entry: PlanEntry): void => cmp.update(entry),
    });

    this.el.replaceChildren(
      ...(next.collapsed
        ? [this.headerEl, this.progressEl]
        : [this.headerEl, this.progressEl, this.entriesEl]),
    );
    this.el.hidden = false;
    if (!next.collapsed) this.scrollToActive();
  }

  /** Keep the running step in view — the panel is shorter than most plans. */
  private scrollToActive(): void {
    const target = this.entriesEl.querySelector<HTMLElement>('.acp-harness__plan-entry--in_progress')
      ?? this.entriesEl.querySelector<HTMLElement>('.acp-harness__plan-entry:last-child');
    target?.scrollIntoView({ block: 'nearest' });
  }

  protected onDispose(): void {
    disposeList(this.entriesEl);
  }
}

export const def: ComponentDef = { id: 'plan-panel', blocks: ['acp-harness__plan'] };
