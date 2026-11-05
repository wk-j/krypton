// Spec 341 — the switcher: every surface and every project in one filterable
// list, opened with `` ` `` from any page. The shell supplies the items when it
// opens it; this file owns only the overlay, the filter and the keys (spec 361:
// a React component the shell portals into `<body>`).

import { useLayoutEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent } from 'react';

import { useKeymap, useModal } from '../hooks';
import { matchesQuery } from '../lib/format';

import '../overlay/overlay.css';
import './switcher.css';

export interface SwitcherItem {
  readonly id: string;
  readonly kind: 'surface' | 'project';
  readonly title: string;
  readonly meta: string;
  /** Unavailable entries stay listed (muted, with the reason) but cannot be chosen. */
  readonly disabledReason?: string;
  readonly current?: boolean;
  run(): void;
}

export interface SwitcherProps {
  readonly open: boolean;
  /** The items captured when the switcher opened (the shell filters by kind). */
  readonly items: readonly SwitcherItem[];
  readonly placeholder: string;
  onClose(): void;
}

function visibleItems(items: readonly SwitcherItem[], query: string): readonly SwitcherItem[] {
  return items.filter((item) => matchesQuery(`${item.title} ${item.meta} ${item.kind}`, query));
}

function firstEnabled(items: readonly SwitcherItem[]): number {
  return Math.max(0, items.findIndex((item) => item.disabledReason === undefined));
}

export function Switcher({ open, items, placeholder, onClose }: SwitcherProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const scrollPending = useRef(false);
  const visible = visibleItems(items, query);

  // Opening: empty filter, select the current entry (else the first enabled),
  // focus the input and remember where focus came from.
  useLayoutEffect(() => {
    if (!open) return undefined;
    returnFocus.current = document.activeElement;
    setQuery('');
    const all = visibleItems(items, '');
    const current = all.findIndex((item) => item.current);
    setSelected(current >= 0 ? current : firstEnabled(all));
    input.current?.focus();
    return () => {
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back instanceof HTMLElement) back.focus();
    };
  }, [open, items]);

  useLayoutEffect(() => {
    if (!scrollPending.current) return;
    scrollPending.current = false;
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const move = (delta: number): void => {
    const n = visible.length;
    if (n === 0) return;
    for (let step = 1; step <= n; step++) {
      const index = (selected + delta * step + n * step) % n;
      if (visible[index].disabledReason === undefined) {
        scrollPending.current = true;
        setSelected(index);
        break;
      }
    }
  };

  const pick = (item: SwitcherItem | undefined): void => {
    if (!item || item.disabledReason !== undefined) return;
    onClose();
    item.run();
  };

  useModal(open);
  useKeymap([
    { key: 'ArrowDown', inInput: true, modal: true, when: () => open, run: () => move(1) },
    { key: 'ArrowUp', inInput: true, modal: true, when: () => open, run: () => move(-1) },
    { key: 'Enter', inInput: true, modal: true, when: () => open, run: () => pick(visible[selected]) },
    { key: 'Escape', inInput: true, modal: true, when: () => open, run: onClose },
    { code: 'Backquote', inInput: true, modal: true, when: () => open, run: onClose },
  ]);

  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="lb-overlay lb-switcher" hidden={!open} onMouseDown={onBackdrop}>
      <div className="lb-overlay__panel" role="dialog" aria-label="Switch surface">
        <div className="lb-overlay__head">
          <input
            ref={input}
            className="lb-input lb-switcher__input"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            aria-label="Go to"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(firstEnabled(visibleItems(items, event.target.value)));
            }}
          />
        </div>
        <div className="lb-overlay__body">
          <ul ref={list} className="lb-switcher__list" role="listbox" aria-label="Surfaces and projects">
            {visible.map((item, index) => {
              const off = item.disabledReason !== undefined;
              const className = ['lb-switcher__item', off && 'lb-switcher__item--off', item.current && 'lb-switcher__item--current']
                .filter(Boolean)
                .join(' ');
              return (
                <li
                  key={`${item.kind}:${item.id}`}
                  className={className}
                  role="option"
                  aria-selected={index === selected}
                  aria-disabled={off}
                  onClick={() => pick(item)}
                >
                  <span className="lb-switcher__title">{item.title}</span>
                  <span className="lb-switcher__meta">{item.disabledReason ?? item.meta}</span>
                </li>
              );
            })}
            {visible.length === 0 && <li className="lb-switcher__empty">Nothing matches</li>}
          </ul>
        </div>
        <footer className="lb-overlay__foot">
          <span>
            <kbd>↑↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> go
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}
