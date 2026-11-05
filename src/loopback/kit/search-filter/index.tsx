// Spec 341 — the filter box eight pages carried a copy of: `/` focuses it,
// `Esc` clears it (and blurs once empty), a muted count sits on the right.
// Spec 361: controlled — the parent owns `value` (was `query`/`initial`) and
// `count` (was `setCount()`); `inputRef` hands out the `<input>` (was `.input`).
// Reader pages portal it into a Rust slot, so it assumes nothing about its parent.

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent, Ref } from 'react';

import { useKeymap } from '../hooks';
import type { KeyBinding } from '../lib/keymap';

import './search-filter.css';

export interface SearchFilterOptions {
  readonly placeholder: string;
  readonly label?: string;
  /** The query shown in the box. */
  readonly value: string;
  /** The user edited the box, or the first Esc cleared it (`''`). */
  readonly onChange: (query: string) => void;
  /** Enter inside the box (e.g. open the first match). */
  readonly onSubmit?: (query: string) => void;
  /** Called after Esc leaves the box. */
  readonly onEscape?: () => void;
  /**
   * `'clear-then-leave'` (default): the first Esc empties the box, the next one
   * leaves it. `'clear-and-leave'`: one Esc does both. `'leave'`: Esc leaves
   * and keeps the query.
   */
  readonly escape?: 'clear-then-leave' | 'clear-and-leave' | 'leave';
  /** Bind `/` to focus the box. Default true; at most one filter per page may. Fixed at mount. */
  readonly slashKey?: boolean;
  /** Muted text on the right (match count). */
  readonly count?: string;
  /** Extra class after `lb-filter`. */
  readonly className?: string;
  /** The `<input>` element, for focus/blur and "is the box focused" checks. */
  readonly inputRef?: Ref<HTMLInputElement>;
}

export function SearchFilter({
  placeholder,
  label,
  value,
  onChange,
  onSubmit,
  onEscape,
  escape = 'clear-then-leave',
  slashKey = true,
  count,
  className,
  inputRef,
}: SearchFilterOptions): JSX.Element {
  const input = useRef<HTMLInputElement | null>(null);
  const setInput = useCallback(
    (node: HTMLInputElement | null): void => {
      input.current = node;
      if (typeof inputRef === 'function') inputRef(node);
      else if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );

  // The box is uncontrolled in React's sense so no `value` attribute is
  // written (spec 341 markup); `value` is pushed into the property instead.
  useLayoutEffect(() => {
    if (input.current && input.current.value !== value) input.current.value = value;
  }, [value]);

  const bindings: KeyBinding[] = slashKey
    ? [
        {
          key: '/',
          label: 'Focus the filter',
          group: 'Page',
          run: () => {
            input.current?.focus();
            input.current?.select();
          },
        },
      ]
    : [];
  useKeymap(bindings);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const box = event.currentTarget;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (box.value && escape !== 'leave') {
        box.value = '';
        onChange('');
        if (escape !== 'clear-and-leave') return;
      }
      box.blur();
      onEscape?.();
      return;
    }
    if (event.key === 'Enter' && onSubmit) {
      event.preventDefault();
      onSubmit(box.value);
    }
  };

  return (
    <div className={className ? `lb-filter ${className}` : 'lb-filter'}>
      <input
        ref={setInput}
        className="lb-input lb-filter__input"
        type="search"
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label={label ?? placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>): void => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <span className="lb-filter__count">{count}</span>
    </div>
  );
}
