// Spec 302 §7.11 — `MemoryDrawer`.
//
// The handoff drawer (`acp-harness-view.ts:13173-13218` `renderMemory`). The
// `innerHTML` per row — which re-parsed every row on every cursor move — becomes
// one `MemoryRow` component per entry, reconciled by handoff id, so moving the
// cursor rewrites two class attributes and one detail node instead of the list.
//
// NOT a `ListPicker`: a memory row is a three-column CSS grid whose selected
// detail spans `grid-column: 1 / -1`, so its parts must be direct children of
// the row, and the row must keep `data-memory-id` for the view's click handler.
// `ListPicker` owns the row element and addresses rows by index.

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { reconcile } from '../../../ui/list';
import { formatShortTime } from '../../harness-format';
import { laneAccentForLabel } from '../../harness-lane-identity';
import type { HandoffEntry } from '../../types';
import { formatHandoffAge } from '../../xenon-push';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './memory-drawer.css';

interface MemoryRowProps {
  readonly entry: HandoffEntry;
  readonly selected: boolean;
  /** spec 293: the active lane's next `#handoff` writes this one. */
  readonly bound: boolean;
  /** Clock read once per paint, so every row's age comes from the same instant. */
  readonly now: number;
}

class MemoryRow extends Component<MemoryRowProps> {
  private readonly source: HTMLElement;
  private readonly text: HTMLElement;
  private readonly kind: HTMLElement;
  private detail: HTMLElement | null = null;

  constructor() {
    super(el('div'));
    this.source = el('span', { class: 'acp-harness__memory-source' });
    this.text = el('span', { class: 'acp-harness__memory-text' });
    this.kind = el('span', { class: 'acp-harness__memory-kind' });
    this.el.append(this.source, this.text, this.kind);
  }

  protected readDeps(next: MemoryRowProps): readonly unknown[] {
    return [
      next.entry,
      next.entry.id,
      next.entry.author,
      next.entry.host,
      next.entry.summary,
      next.entry.detail,
      next.entry.updatedAt,
      next.entry.boundLanes.join(', '),
      next.selected,
      next.bound,
      next.now,
    ];
  }

  protected syncClasses(next: MemoryRowProps): void {
    this.el.className = 'acp-harness__memory-row'
      + (next.selected ? ' acp-harness__memory-row--cursor' : '')
      + (next.bound ? ' acp-harness__memory-row--bound' : '');
  }

  protected paint(next: MemoryRowProps): void {
    this.syncClasses(next);
    const entry = next.entry;
    this.el.dataset.memoryId = entry.id;

    const origin = `${entry.author}@${entry.host}`;
    this.source.style.setProperty('--acp-memory-accent', laneAccentForLabel(entry.author));
    setAttr(this.source, 'title', origin);
    this.source.textContent = origin;
    this.text.textContent = `${next.bound ? '▸ ' : ''}${entry.summary}`;
    setAttr(this.kind, 'title', formatShortTime(entry.updatedAt));
    this.kind.textContent = formatHandoffAge(next.now - entry.updatedAt);

    if (!next.selected) {
      this.detail?.remove();
      this.detail = null;
      return;
    }
    const bindings = entry.boundLanes.length > 0 ? ` · bound: ${entry.boundLanes.join(', ')}` : '';
    const detail = this.detail ?? el('div', { class: 'acp-harness__memory-detail' });
    this.detail = detail;
    detail.textContent = `${entry.id}${bindings}\n\n${entry.detail}`;
    if (detail.parentNode !== this.el) this.el.appendChild(detail);
  }
}

export interface MemoryDrawerProps {
  readonly open: boolean;
  /** Handoffs, newest first (the view sorts). */
  readonly entries: readonly HandoffEntry[];
  /** Id of the row under the cursor, or null. */
  readonly cursorId: string | null;
  /** Non-empty when the memory backend is unreachable; replaces the list. */
  readonly warning: string | null;
  /** Display name of the active lane — the row it binds is marked. */
  readonly activeLaneLabel: string | null;
  /** `Date.now()` from the caller, so row ages are stable within a paint. */
  readonly now: number;
  onAutoClose?(): void;
}

export class MemoryDrawer extends Component<MemoryDrawerProps> {
  private readonly shell: OverlayShell;
  private readonly panel: HTMLElement;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.panel = el('div', { class: 'acp-harness__memory-panel' });
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  protected readDeps(next: MemoryDrawerProps): readonly unknown[] {
    return [
      next.open,
      next.entries,
      next.entries.length,
      next.cursorId,
      next.warning,
      next.activeLaneLabel,
      next.now,
    ];
  }

  protected syncClasses(_next: MemoryDrawerProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: MemoryDrawerProps): void {
    if (next.warning === null && next.entries.length > 0) this.paintRows(next);
    this.shell.update({
      open: next.open,
      name: 'memory',
      block: 'acp-harness__memory',
      title: next.warning !== null
        ? 'Handoffs · unavailable'
        : `Handoffs · ${next.entries.length}`,
      body: this.panel,
      empty: this.emptyText(next),
      onAutoClose: next.onAutoClose,
    });
  }

  private emptyText(next: MemoryDrawerProps): string | undefined {
    if (next.warning !== null) return `memory unavailable: ${next.warning}`;
    if (next.entries.length === 0) return 'no handoffs yet';
    return undefined;
  }

  private paintRows(next: MemoryDrawerProps): void {
    reconcile<HandoffEntry, MemoryRow>(this.panel, next.entries, {
      key: (entry) => entry.id,
      create: (entry) => {
        const row = new MemoryRow();
        row.update(this.rowProps(next, entry));
        return row;
      },
      update: (row, entry) => row.update(this.rowProps(next, entry)),
    });
  }

  private rowProps(next: MemoryDrawerProps, entry: HandoffEntry): MemoryRowProps {
    return {
      entry,
      selected: entry.id === next.cursorId,
      bound: next.activeLaneLabel !== null && entry.boundLanes.includes(next.activeLaneLabel),
      now: next.now,
    };
  }

  protected onDispose(): void {
    this.shell.dispose();
  }
}

export const def: ComponentDef = {
  id: 'memory-drawer',
  blocks: ['acp-harness__memory-overlay', 'acp-harness__memory'],
};
