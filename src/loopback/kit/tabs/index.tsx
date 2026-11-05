// Spec 341 — a segmented row (project tabs, view toggles). `[`/`]` cycle and
// `1`–`9` jump when `keys` is on; the active tab carries `aria-selected`.
// Spec 361: controlled — `tabs`/`active` are props (was `update()`), the
// parent stores what `onSelect` reports.

import type { JSX } from 'react';

import { useKeymap } from '../hooks';
import type { KeyBinding } from '../lib/keymap';

import './tabs.css';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number | string;
  readonly title?: string;
}

export interface TabsOptions {
  readonly label: string;
  readonly tabs: readonly TabItem[];
  /** Id of the active tab. */
  readonly active: string;
  onSelect(id: string): void;
  /** Bind `[`/`]` and `1`–`9`. Default false (a page has at most one such row). Fixed at mount. */
  readonly keys?: boolean;
  /**
   * Index of the tab `1` selects (default 0). A leading `all` tab sets 1, so
   * `1`–`9` name the real entries and the `all` tab keeps its own key.
   */
  readonly numberFrom?: number;
  readonly sticky?: boolean;
  readonly hidden?: boolean;
}

export function Tabs({ label, tabs, active, onSelect, keys = false, numberFrom = 0, sticky, hidden }: TabsOptions): JSX.Element {
  const step = (delta: number): void => {
    if (tabs.length === 0) return;
    const index = Math.max(0, tabs.findIndex((t) => t.id === active));
    onSelect(tabs[(index + delta + tabs.length) % tabs.length].id);
  };
  const bindings: KeyBinding[] = keys
    ? [
        { key: ']', label: 'Next tab', run: () => step(1) },
        { key: '[', label: 'Previous tab', run: () => step(-1) },
        {
          key: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
          display: '1–9',
          label: 'Jump to tab',
          run: (event) => {
            const tab = tabs[numberFrom + Number(event.key) - 1];
            if (!tab) return false;
            onSelect(tab.id);
          },
        },
      ]
    : [];
  useKeymap(bindings);

  return (
    <nav className={sticky ? 'lb-tabs lb-tabs--sticky' : 'lb-tabs'} role="tablist" aria-label={label} hidden={hidden}>
      {tabs.map((tab, index) => {
        const digit = index - numberFrom + 1;
        return (
          <button
            key={tab.id}
            className="lb-tabs__tab"
            type="button"
            role="tab"
            data-id={tab.id}
            title={tab.title ?? ''}
            aria-selected={tab.id === active}
            onClick={(): void => onSelect(tab.id)}
          >
            <span className="lb-tabs__label">{tab.label}</span>
            {tab.count !== undefined ? <b className="lb-tabs__count">{String(tab.count)}</b> : null}
            {keys && digit >= 1 && digit <= 9 ? <span className="lb-tabs__key">{String(digit)}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
