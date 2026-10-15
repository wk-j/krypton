// Spec 302 §2.3 — `ListPicker<T>`.
//
// The keyboard-driven row list every harness picker reimplements: the lane
// picker, the directive picker, the model picker, the session picker, the
// ticket picker, the remote-harness picker and the inline question list each
// carry their own copy of the same three lines of cursor arithmetic and their
// own `innerHTML` row loop.
//
// It owns the cursor math, the active modifier, the `data-*-index` attributes
// and `scrollIntoView({ block: 'nearest' })` — which only the model picker has
// today (`acp-harness-view.ts:12814-12817`), because every other picker
// rebuilt its list at `scrollTop` 0 and nobody noticed.
//
// It deliberately owns NOTHING about keys: which key opens the picker and what
// Enter does stay with the caller (CLAUDE.md constraint 1). The caller also
// still owns filtering — `items` arrives already filtered.
//
// The six pickers do NOT share a class convention, and this component does not
// pretend they do. Four of them name their elements with a single dash on the
// `acp-harness` block (`acp-harness__picker-row`), the ticket picker's
// container is `__rows` and its active modifier is `--selected`, and two of
// them build rows as `<button>`s. `separator`, `listClass`, `rowClass`,
// `activeModifier` and the row tag name those differences instead of forcing a
// rename that would have to be mirrored in five stylesheets.
//
// It owns no block: `block` is a prop, so each picker keeps its own classes.

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { disposeList, listComponent, reconcile } from '../../../ui/list';
import type { ComponentDef } from '../types';

/**
 * Clamp a cursor into `[0, total)`. `total === 0` yields 0, which is what every
 * picker's `Math.max(0, Math.min(cursor, total - 1))` line computes today.
 */
export function clampCursor(cursor: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(Math.trunc(cursor), total - 1));
}

/** Move down one row, wrapping — the `(x + 1) % n` copied at eight call sites. */
export function nextCursor(cursor: number, total: number): number {
  if (total <= 0) return 0;
  return (clampCursor(cursor, total) + 1) % total;
}

/** Move up one row, wrapping — the `(x - 1 + n) % n` copied at eight call sites. */
export function prevCursor(cursor: number, total: number): number {
  if (total <= 0) return 0;
  return (clampCursor(cursor, total) - 1 + total) % total;
}

export type ListPickerTag = 'ul' | 'div';
export type ListPickerRowTag = 'li' | 'button' | 'div';

export interface ListPickerProps<T> {
  readonly items: readonly T[];
  /** Clamped by the component; the caller may hand over a stale index. */
  readonly cursor: number;
  /**
   * Build one row's content.
   *
   * MUST be a pure function of `(item, index)`: a row's content is rebuilt when
   * its item or its index moves, never because the closure's identity changed.
   * Callers pass a fresh arrow on every pass, so closure identity carries no
   * information — anything a row renders must be reachable from `item`.
   */
  renderRow(item: T, index: number): Node;
  /** The BEM block the caller owns, e.g. `acp-ticket`. */
  readonly block: string;
  /** Row index attribute name: `data-${name}-index`, e.g. `ticket`. */
  readonly name: string;
  /**
   * Joins `block` to the element name. Default `'__'`. The lane, directive,
   * model and session pickers are elements of the `acp-harness` block and use
   * `'-'`: `acp-harness__picker-list` / `-row`.
   */
  readonly separator?: '__' | '-';
  /** Full container class, replacing `${block}${separator}list`. */
  readonly listClass?: string;
  /**
   * Attributes on the container — the ticket rows box is
   * `role="listbox" data-count="${matches.length}"`. `undefined` removes one,
   * and an attribute that drops out of the record between paints is removed.
   */
  readonly listAttrs?: Readonly<Record<string, string | undefined>>;
  /** Full row base class, replacing `${block}${separator}row`. */
  readonly rowClass?: string;
  /** Active row modifier suffix: `${rowClass}--${activeModifier}`. Default `active`. */
  readonly activeModifier?: string;
  /** Row tag, per item — the ticket picker emits `div` for unavailable rows. */
  rowTagFor?(item: T, index: number): ListPickerRowTag;
  /**
   * Extra full class names on a row, e.g. `acp-ticket__row--unavailable`.
   * Pure in `(item, index, active)`, like `renderRow`: it is consulted when a
   * row repaints, not when the closure's identity changes.
   */
  rowClasses?(item: T, index: number, active: boolean): readonly string[];
  /**
   * Extra row attributes, e.g. `role` / `aria-selected` / `data-session-backend`.
   * An attribute that disappears from the result is removed from the row.
   * Pure in `(item, index, active)`, like `rowClasses`.
   */
  rowAttrs?(item: T, index: number, active: boolean): Readonly<Record<string, string | undefined>>;
  /** Emit `data-${name}-index`. Default true; the session backend rows carry none. */
  readonly indexAttr?: boolean;
  /**
   * The caller's current filter text. Not applied here — `items` arrives
   * filtered. It is part of the dependency tuple so a re-filter that happens to
   * reuse the same array identity still repaints and re-anchors the cursor.
   */
  readonly filter?: string;
  /** Scroll the active row into view after each paint. Default true. */
  readonly followCursor?: boolean;
}

interface ListPickerRowProps<T> {
  readonly picker: ListPickerProps<T>;
  readonly item: T;
  readonly index: number;
  readonly cursor: number;
}

/** One row. Its class is re-derived from the cursor; its content is not. */
class ListPickerRow<T> extends Component<ListPickerRowProps<T>> {
  private appliedAttrs: readonly string[] = [];
  private content: { readonly item: T; readonly index: number } | null = null;

  constructor(tag: ListPickerRowTag) {
    super(el(tag));
    if (tag === 'button') this.el.setAttribute('type', 'button');
  }

  protected readDeps(next: ListPickerRowProps<T>): readonly unknown[] {
    return [
      next.item,
      next.index,
      next.index === next.cursor,
      next.picker.block,
      next.picker.name,
      next.picker.separator,
      next.picker.rowClass,
      next.picker.activeModifier,
      next.picker.indexAttr,
    ];
  }

  protected syncClasses(next: ListPickerRowProps<T>): void {
    const picker = next.picker;
    const active = next.index === next.cursor;
    const base = picker.rowClass ?? `${picker.block}${picker.separator ?? '__'}row`;
    this.el.className = classes(
      base,
      active && `${base}--${picker.activeModifier ?? 'active'}`,
      picker.rowClasses?.(next.item, next.index, active) ?? null,
    );
  }

  protected paint(next: ListPickerRowProps<T>): void {
    const picker = next.picker;
    const active = next.index === next.cursor;
    this.syncClasses(next);

    const attrs: Record<string, string | undefined> = {
      ...picker.rowAttrs?.(next.item, next.index, active),
    };
    if (picker.indexAttr !== false) attrs[`data-${picker.name}-index`] = String(next.index);
    for (const name of this.appliedAttrs) {
      if (!(name in attrs)) this.el.removeAttribute(name);
    }
    for (const [name, value] of Object.entries(attrs)) setAttr(this.el, name, value);
    this.appliedAttrs = Object.keys(attrs);

    const current = this.content;
    if (current !== null && current.item === next.item && current.index === next.index) return;
    this.content = { item: next.item, index: next.index };
    this.el.replaceChildren(picker.renderRow(next.item, next.index));
  }
}

export class ListPicker<T> extends Component<ListPickerProps<T>> {
  private readonly rowTag: ListPickerRowTag;
  private cursorIndex = 0;
  private activeRowEl: HTMLElement | null = null;
  private appliedListAttrs: readonly string[] = [];

  constructor(tag: ListPickerTag = 'ul', rowTag: ListPickerRowTag = 'li') {
    super(el(tag));
    this.rowTag = rowTag;
  }

  /** The clamped cursor this picker last painted. */
  get cursor(): number {
    return this.cursorIndex;
  }

  /** The active row, or null while the list is empty. */
  get activeRow(): HTMLElement | null {
    return this.activeRowEl;
  }

  protected readDeps(next: ListPickerProps<T>): readonly unknown[] {
    return [
      next.items,
      next.items.length,
      clampCursor(next.cursor, next.items.length),
      next.rowTagFor,
      next.renderRow,
      next.block,
      next.name,
      next.separator,
      next.listClass,
      next.listAttrs && Object.entries(next.listAttrs).flat().join('\u0000'),
      next.rowClass,
      next.activeModifier,
      next.indexAttr,
      next.filter,
      next.followCursor,
    ];
  }

  protected syncClasses(next: ListPickerProps<T>): void {
    this.el.className = next.listClass ?? `${next.block}${next.separator ?? '__'}list`;
  }

  protected paint(next: ListPickerProps<T>): void {
    this.syncClasses(next);
    const listAttrs = next.listAttrs;
    for (const name of this.appliedListAttrs) {
      if (listAttrs === undefined || listAttrs[name] === undefined) this.el.removeAttribute(name);
    }
    const written: string[] = [];
    for (const [name, value] of Object.entries(listAttrs ?? {})) {
      if (value === undefined) continue;
      setAttr(this.el, name, value);
      written.push(name);
    }
    this.appliedListAttrs = written;
    const cursor = clampCursor(next.cursor, next.items.length);
    this.cursorIndex = cursor;
    const tagFor = next.rowTagFor;
    reconcile<T, ListPickerRow<T>>(this.el, next.items, {
      // The tag joins the key: a row that changes tag is a different element,
      // so it is rebuilt rather than silently kept as the wrong one.
      key: (item, index) => `${index}\u0000${tagFor?.(item, index) ?? this.rowTag}`,
      create: (item, index) => {
        const row = new ListPickerRow<T>(tagFor?.(item, index) ?? this.rowTag);
        row.update({ picker: next, item, index, cursor });
        return row;
      },
      update: (row, item, index) => {
        row.update({ picker: next, item, index, cursor });
      },
    });
    const activeKey = `${cursor}\u0000${
      next.items.length > 0 ? tagFor?.(next.items[cursor], cursor) ?? this.rowTag : this.rowTag
    }`;
    const active = listComponent(this.el, activeKey);
    this.activeRowEl = next.items.length > 0 && active ? active.el : null;
    // happy-dom and jsdom have no layout; guard the way the model picker does.
    const row = this.activeRowEl;
    if (next.followCursor !== false && row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  protected onDispose(): void {
    disposeList(this.el);
  }
}

export const def: ComponentDef = { id: 'list-picker', blocks: [] };
