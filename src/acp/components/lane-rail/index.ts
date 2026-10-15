// Spec 302 §4.6 — `LaneRail`.
//
// The zen-mode left rail: one `RailEntry` per lane, reconciled. Switching the
// active lane moves the `--active` modifier and leaves every entry's node
// alone, which is what stops the rail flashing on a lane switch.

import './lane-rail.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { reconcile } from '../../../ui/list';
import { RailEntry, type RailEntryProps } from '../rail-entry';
import type { ComponentDef } from '../types';

export interface LaneRailProps {
  readonly entries: readonly RailEntryProps[];
}

export class LaneRail extends Component<LaneRailProps> {
  constructor() {
    super(el('aside', { class: 'acp-harness__rail' }));
  }

  protected readDeps(next: LaneRailProps): readonly unknown[] {
    // The entry list identity plus the active lane: entries hold their own deps,
    // so this only has to notice that the roster or the selection moved.
    return [next.entries.length, next.entries.map((entry) => entry.lane.id).join(','), activeId(next)];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__rail';
  }

  protected paint(next: LaneRailProps): void {
    this.syncClasses();
    this.reconcileEntries(next);
  }

  update(next: LaneRailProps): void {
    super.update(next);
    // Entries carry per-lane state that moves without the roster moving.
    if (this.painted) this.reconcileEntries(next);
  }

  private reconcileEntries(next: LaneRailProps): void {
    reconcile(this.el, next.entries, {
      key: (entry) => entry.lane.id,
      create: (entry) => {
        const cmp = new RailEntry();
        cmp.update(entry);
        return cmp;
      },
      update: (cmp, entry) => cmp.update(entry),
    });
  }
}

function activeId(props: LaneRailProps): string | null {
  return props.entries.find((entry) => entry.active)?.lane.id ?? null;
}

export const def: ComponentDef = { id: 'lane-rail', blocks: ['acp-harness__rail'] };
