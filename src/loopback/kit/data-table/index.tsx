// Spec 341 — a keyed table. Rows are keyed and memoized, so a poll that
// changes one value repaints one row and keeps the scroll position.
// Spec 361: React component over `rows`; the row key is `itemKey` (`key` is
// reserved by React); `.el` tweaks become `className` / `hidden`.

import { memo, useCallback } from 'react';
import type { JSX, ReactNode } from 'react';

import { useLatest } from '../hooks';

import './data-table.css';

export interface Column<T> {
  readonly id: string;
  readonly label: string;
  render(item: T): ReactNode;
  /** Right-aligned tabular numerals. */
  readonly numeric?: boolean;
  readonly class?: string;
}

export interface DataTableOptions<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  itemKey(item: T): string;
  /** The values the cells read; default: the item itself. A row repaints only when these (or `rowClass`) move. */
  deps?(item: T): readonly unknown[];
  onRowClick?(item: T): void;
  /** Row modifier classes (selection, state). */
  rowClass?(item: T): string | undefined;
  /** Extra class after `lb-table`. */
  readonly className?: string;
  readonly hidden?: boolean;
}

interface RowProps<T> {
  readonly item: T;
  readonly rowKey: string;
  readonly options: DataTableOptions<T>;
  /** Present only with `onRowClick`; stable across renders. */
  readonly onClick: ((key: string) => void) | undefined;
}

function cellClass<T>(column: Column<T>): string {
  return [column.numeric && 'lb-table__num', column.class].filter(Boolean).join(' ');
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function rowDeps<T>({ item, options, onClick }: RowProps<T>): readonly unknown[] {
  return [...(options.deps ? options.deps(item) : [item]), options.rowClass?.(item), onClick !== undefined];
}

function RowView<T>({ item, rowKey, options, onClick }: RowProps<T>): JSX.Element {
  const className = ['lb-table__row', onClick && 'lb-table__row--link', options.rowClass?.(item)].filter(Boolean).join(' ');
  return (
    <tr className={className} onClick={onClick ? (): void => onClick(rowKey) : undefined}>
      {options.columns.map((column) => (
        <td key={column.id} className={cellClass(column)}>
          {column.render(item)}
        </td>
      ))}
    </tr>
  );
}

const Row = memo(RowView, (prev, next) => sameValues(rowDeps(prev), rowDeps(next))) as unknown as typeof RowView;

export function DataTable<T>(props: DataTableOptions<T>): JSX.Element {
  const { columns, rows, itemKey, onRowClick, className, hidden } = props;
  const latest = useLatest(props);
  const click = useCallback(
    (key: string): void => {
      const { rows: current, itemKey: keyOf, onRowClick: onClick } = latest.current;
      const index = current.findIndex((row) => keyOf(row) === key);
      if (index >= 0) onClick?.(current[index]);
    },
    [latest],
  );
  return (
    <table className={className ? `lb-table ${className}` : 'lb-table'} hidden={hidden}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.id} className={cellClass(column)}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => {
          const key = itemKey(item);
          return <Row key={key} item={item} rowKey={key} options={props} onClick={onRowClick ? click : undefined} />;
        })}
      </tbody>
    </table>
  );
}
