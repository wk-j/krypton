// Spec 341 — a keyboard list: one selected row (`aria-selected`), `j`/`k`/
// arrows move it, `Enter` opens it. termctrl sessions, e2e cases, the commands
// index and the home tiles all had their own copy of this.
// Spec 361: controlled — the parent owns `items` and `selected` (a key) and
// stores what `onSelect` reports; `move()` is on the `ref` handle for pages
// that bind their own row keys (`keys: false`).

import { memo, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { JSX, ReactNode, Ref } from 'react';

import { useKeymap, useLatest } from '../hooks';
import type { KeyBinding } from '../lib/keymap';

import './roster.css';

export interface RosterHandle {
  /** Step the selection by `delta` (clamped, or wrapped with `wrap`) and report it through `onSelect`. */
  move(delta: number): void;
}

export interface RosterOptions<T> {
  readonly label: string;
  readonly items: readonly T[];
  /** Key of the selected item, or null. A key missing from `items` selects nothing. */
  readonly selected: string | null;
  itemKey(item: T): string;
  /** Row content. Called on mount and whenever `deps(item)` or the row's selection moves. */
  render(item: T): ReactNode;
  /** The values `render` reads; default: the item itself (reference equality). */
  deps?(item: T): readonly unknown[];
  /** A different row was chosen (keys, click, `move()`); the parent stores its key as `selected`. */
  onSelect?(item: T): void;
  onOpen?(item: T): void;
  /** Bind `j`/`k`/`↑`/`↓`/`Enter` on the page keymap. Default true; fixed at mount. */
  readonly keys?: boolean;
  /** Gate for those keys (e.g. only while this pane is active). */
  readonly when?: () => boolean;
  readonly empty?: string;
  /** `j`/`k` past either end wraps to the other. Default false (stops at the ends). */
  readonly wrap?: boolean;
  readonly ref?: Ref<RosterHandle>;
}

interface RowProps<T> {
  readonly item: T;
  readonly rowKey: string;
  readonly selected: boolean;
  readonly options: RosterOptions<T>;
  /** Stable across renders. */
  readonly onClick: (key: string) => void;
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function RowView<T>({ item, rowKey, selected, options, onClick }: RowProps<T>): JSX.Element {
  return (
    <li
      className="lb-roster__item"
      role="option"
      tabIndex={-1}
      data-key={rowKey}
      aria-selected={selected}
      onClick={(): void => onClick(rowKey)}
    >
      {options.render(item)}
    </li>
  );
}

const Row = memo(
  RowView,
  (prev, next) =>
    prev.selected === next.selected &&
    sameValues(prev.options.deps ? prev.options.deps(prev.item) : [prev.item], next.options.deps ? next.options.deps(next.item) : [next.item]),
) as unknown as typeof RowView;

export function RosterList<T>(props: RosterOptions<T>): JSX.Element {
  const { label, items, selected, itemKey, empty, keys, when, ref } = props;
  const latest = useLatest(props);
  const list = useRef<HTMLUListElement>(null);

  const itemAt = useCallback(
    (key: string | null): { readonly item: T } | null => {
      if (key === null) return null;
      const { items: current, itemKey: keyOf } = latest.current;
      const index = current.findIndex((item) => keyOf(item) === key);
      return index < 0 ? null : { item: current[index] };
    },
    [latest],
  );

  const select = useCallback(
    (key: string): void => {
      if (key === latest.current.selected) return;
      const found = itemAt(key);
      if (found) latest.current.onSelect?.(found.item);
    },
    [latest, itemAt],
  );

  const move = useCallback(
    (delta: number): void => {
      const { items: current, itemKey: keyOf, selected: key, wrap } = latest.current;
      const n = current.length;
      if (n === 0) return;
      const index = current.findIndex((item) => keyOf(item) === key);
      let next: number;
      if (index < 0) next = delta > 0 ? 0 : n - 1;
      else if (wrap) next = (((index + delta) % n) + n) % n;
      else next = Math.min(n - 1, Math.max(0, index + delta));
      select(keyOf(current[next]));
    },
    [latest, select],
  );

  const click = useCallback(
    (key: string): void => {
      select(key);
      const found = itemAt(key);
      if (found) latest.current.onOpen?.(found.item);
    },
    [latest, select, itemAt],
  );

  useImperativeHandle(ref, () => ({ move }), [move]);

  const bindings: KeyBinding[] =
    keys === false
      ? []
      : [
          { key: ['j', 'ArrowDown'], label: 'Next item', when, run: () => move(1) },
          { key: ['k', 'ArrowUp'], label: 'Previous item', when, run: () => move(-1) },
          {
            key: 'Enter',
            label: 'Open the selected item',
            when,
            run: () => {
              const found = itemAt(selected);
              if (!found || !props.onOpen) return false;
              props.onOpen(found.item);
            },
          },
        ];
  useKeymap(bindings);

  // Bring the selected row into view when the selection moves or its row (re)appears.
  const present = selected !== null && items.some((item) => itemKey(item) === selected);
  useEffect(() => {
    if (!present || selected === null) return;
    list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, present]);

  return (
    <ul ref={list} className="lb-roster" role="listbox" aria-label={label}>
      {items.map((item) => {
        const key = itemKey(item);
        return <Row key={key} item={item} rowKey={key} selected={key === selected} options={props} onClick={click} />;
      })}
      {empty && items.length === 0 ? <li className="lb-roster__empty">{empty}</li> : null}
    </ul>
  );
}
