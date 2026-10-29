// Spec 341 — a keyed table. Rows are reconciled, so a poll that changes one
// value repaints one row and keeps the scroll position.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';
import { reconcile } from '../../../ui/list';

import './data-table.css';

export interface Column<T> {
  readonly id: string;
  readonly label: string;
  render(item: T): ElChild;
  /** Right-aligned tabular numerals. */
  readonly numeric?: boolean;
  readonly class?: string;
}

export interface DataTableOptions<T> {
  readonly columns: readonly Column<T>[];
  key(item: T): string;
  /** The values the cells read; default: the item itself. */
  deps?(item: T): readonly unknown[];
  onRowClick?(item: T): void;
  /** Row modifier classes (selection, state). */
  rowClass?(item: T): string | undefined;
}

class Row<T> extends Component<T> {
  constructor(
    private readonly options: DataTableOptions<T>,
    item: T,
  ) {
    super(el('tr', { class: 'lb-table__row' }));
    if (options.onRowClick) {
      this.el.classList.add('lb-table__row--link');
      this.bag.listen(this.el, 'click', () => options.onRowClick?.(this.current));
    }
    this.update(item);
  }

  private current!: T;

  protected readDeps(next: T): readonly unknown[] {
    return [...(this.options.deps ? this.options.deps(next) : [next]), this.options.rowClass?.(next)];
  }

  protected paint(next: T): void {
    this.current = next;
    this.el.replaceChildren(
      ...this.options.columns.map((column) =>
        el('td', { class: [column.numeric && 'lb-table__num', column.class] }, column.render(next)),
      ),
    );
    this.syncClasses(next);
  }

  protected syncClasses(next: T): void {
    this.el.className = ['lb-table__row', this.options.onRowClick && 'lb-table__row--link', this.options.rowClass?.(next)]
      .filter(Boolean)
      .join(' ');
  }
}

export class DataTable<T> {
  readonly el: HTMLTableElement;
  private readonly body = el('tbody');

  constructor(private readonly options: DataTableOptions<T>) {
    const head = el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...options.columns.map((column) =>
          el('th', { class: [column.numeric && 'lb-table__num', column.class], text: column.label }),
        ),
      ),
    );
    this.el = el('table', { class: 'lb-table' }, head, this.body);
  }

  setRows(items: readonly T[]): void {
    reconcile(this.body, items, {
      key: (item) => this.options.key(item),
      create: (item) => new Row(this.options, item),
      update: (row, item) => row.update(item),
    });
  }
}
