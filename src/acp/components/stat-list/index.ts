// Spec 302 §1.4 — `StatRow` / `StatList`.
//
// Seven hand-rolled label+value builders become one list: the lane stats line,
// the `#usage` metric grid, the lane-peek rows, the triage overlay sections,
// the review-priority rows and the ticket dock's meta rows. The list owns the
// row set and reconciles it, so a changed row never rebuilds its siblings.
//
// **Owns no block.** `block` is a prop, exactly as on `Chip`: every caller
// keeps the class it already has, so no stylesheet moves with this directory
// and `blocks` is empty.
//
// Class derivation per layout — this is the whole contract:
//
//   layout   root                     row                      label / value
//   inline   caller's (`rootClass`)   none (bare `<span>`)      none; text in order
//   dl       `<dl>` + `rootClass`     `<block>`                 bare `<dt>` / `<dd>`
//   grid     caller's (`rootClass`)   `<block>-row`             `<block>-prefix` / `-value`
//
// `tone` appends `--<tone>` to the row class (`acp-harness__usage-metric--input`,
// `acp-harness__lane-peek-row--warn`). `icon` is placed first inside the label
// slot — for `inline` that is the cell itself, which is where the lane stats
// line puts its gauge/tool/rows glyphs today.
//
// A row's `value` takes a `Node` because three of the call sites it replaces
// interpolate markup into the value half (the peek row's `<b>`, the priority
// row's file/line split, the ticket dock's `<a>`): the caller builds those
// nodes and hands them over, which is how the last `innerHTML` in each of
// those builders goes away.

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { harnessIconEl } from '../../harness-icons';
import type { ComponentDef } from '../types';

export type StatLayout = 'inline' | 'dl' | 'grid';

export interface StatIcon {
  /** `krypton-icon-<id>` symbol suffix. */
  readonly id: string;
  /** Extra class on the `<svg>`, e.g. `acp-harness__icon--dot`. */
  readonly cls?: string;
}

export interface StatRowProps {
  /** The label half. `''` for a value-only cell — the lane stats line is all
   *  value-only cells, since its text is one formatted string per cell. */
  readonly label: string;
  readonly value: string | Node;
  readonly title?: string;
  readonly icon?: StatIcon;
  /** Appends the row-class modifier `--<tone>`. */
  readonly tone?: string;
  /** Reconciler identity. Defaults to the row's position, which is right for
   *  an append-only or fully rebuilt list; supply it when rows are inserted,
   *  removed or reordered and their nodes must follow. */
  readonly key?: string;
}

export interface StatListProps {
  readonly rows: readonly StatRowProps[];
  /** The BEM block the caller owns, e.g. `acp-harness__usage-metric`. */
  readonly block: string;
  readonly layout: StatLayout;
  /** Full class string for the list root, e.g.
   *  `acp-harness__usage-metrics acp-harness__usage-metrics--4`. Omit it when
   *  the list was constructed over an existing container: the caller then owns
   *  that node's class and the list never writes it. */
  readonly rootClass?: string;
}

/** `''` must remove the attribute, not leave `class=""` behind: an inline
 *  stats cell has no class at all today. */
function setClassName(node: HTMLElement, value: string): void {
  if (value === '') node.removeAttribute('class');
  else node.className = value;
}

function fill(target: HTMLElement, children: readonly (Node | string)[]): void {
  target.replaceChildren();
  for (const child of children) {
    if (child === '') continue;
    target.append(child);
  }
}

export class StatRow extends Component<StatRowProps> {
  private readonly layout: StatLayout;
  private readonly block: string;
  /** `dt` / `-prefix`, and `dd` / `-value`. Both null for `inline`, whose cell
   *  is a single span with no element halves. */
  private readonly labelEl: HTMLElement | null;
  private readonly valueEl: HTMLElement | null;

  constructor(layout: StatLayout, block: string) {
    super(el(layout === 'inline' ? 'span' : 'div'));
    this.layout = layout;
    this.block = block;
    if (layout === 'dl') {
      this.labelEl = el('dt');
      this.valueEl = el('dd');
      this.el.append(this.labelEl, this.valueEl);
    } else if (layout === 'grid') {
      this.labelEl = el('span', { class: `${block}-prefix` });
      this.valueEl = el('span', { class: `${block}-value` });
      this.el.append(this.labelEl, this.valueEl);
    } else {
      this.labelEl = null;
      this.valueEl = null;
    }
  }

  protected readDeps(next: StatRowProps): readonly unknown[] {
    return [next.label, next.value, next.title, next.icon?.id, next.icon?.cls, next.tone];
  }

  protected syncClasses(next: StatRowProps): void {
    const row = this.layout === 'grid' ? `${this.block}-row` : this.layout === 'dl' ? this.block : '';
    setClassName(this.el, classes(row, next.tone && row ? `${row}--${next.tone}` : null));
  }

  protected paint(next: StatRowProps): void {
    this.syncClasses(next);
    setAttr(this.el, 'title', next.title);
    const icon = next.icon ? harnessIconEl(next.icon.id, next.icon.cls) : null;
    const lead: (Node | string)[] = icon ? [icon, next.label] : [next.label];
    if (this.labelEl && this.valueEl) {
      fill(this.labelEl, lead);
      fill(this.valueEl, [next.value]);
      return;
    }
    fill(this.el, [...lead, next.value]);
  }
}

export class StatList extends Component<StatListProps> {
  private readonly layout: StatLayout;
  private block: string | null = null;

  /**
   * `root` adopts an existing container — the lane stats `<div>`, a peek
   * panel's row area — so the list adds no wrapper to markup that has none.
   * The container becomes the list's: stray children are removed, which is how
   * it stays authoritative without an `innerHTML` wipe.
   */
  constructor(layout: StatLayout, root?: HTMLElement) {
    super(root ?? el(layout === 'dl' ? 'dl' : 'div'));
    this.layout = layout;
  }

  protected readDeps(next: StatListProps): readonly unknown[] {
    // The rows array itself: a caller rebuilds it every pass, and the per-row
    // deps inside `StatRow` are what actually suppress the DOM writes.
    return [next.layout, next.block, next.rootClass, next.rows];
  }

  protected syncClasses(next: StatListProps): void {
    if (next.rootClass !== undefined) setClassName(this.el, classes(next.rootClass));
  }

  protected paint(next: StatListProps): void {
    if (next.layout !== this.layout) {
      throw new Error(
        `[ui] StatList was constructed for layout '${this.layout}' and cannot repaint as ` +
          `'${next.layout}' — the root tag and the row markup differ per layout.`,
      );
    }
    this.syncClasses(next);
    const block = next.block;
    if (this.block !== null && this.block !== block) disposeList(this.el);
    this.block = block;
    reconcile(this.el, next.rows, {
      key: (row: StatRowProps, index: number): string => row.key ?? `#${index}`,
      create: (row: StatRowProps): StatRow => {
        const cmp = new StatRow(this.layout, block);
        cmp.update(row);
        return cmp;
      },
      update: (cmp: StatRow, row: StatRowProps): void => cmp.update(row),
    });
  }

  protected onDispose(): void {
    disposeList(this.el);
  }
}

export const def: ComponentDef = { id: 'stat-list', blocks: [] };
