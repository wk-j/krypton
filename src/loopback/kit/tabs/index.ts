// Spec 341 — a segmented row (project tabs, view toggles). `[`/`]` cycle and
// `1`–`9` jump when `keys` is on; the active tab carries `aria-selected`.

import { Component } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import { reconcile } from '../../../ui/list';
import { keymap } from '../lib/keymap';

import './tabs.css';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number | string;
  readonly title?: string;
}

interface TabsProps {
  readonly tabs: readonly TabItem[];
  readonly active: string;
}

export interface TabsOptions {
  readonly label: string;
  onSelect(id: string): void;
  /** Bind `[`/`]` and `1`–`9`. Default false (a page has at most one such row). */
  readonly keys?: boolean;
  /**
   * Index of the tab `1` selects (default 0). A leading `all` tab sets 1, so
   * `1`–`9` name the real entries and the `all` tab keeps its own key.
   */
  readonly numberFrom?: number;
  readonly sticky?: boolean;
}

interface TabProps {
  readonly tab: TabItem;
  readonly active: boolean;
  /** The digit that selects this tab, or null. */
  readonly digit: number | null;
}

class Tab extends Component<TabProps> {
  constructor(props: TabProps, onClick: (id: string) => void) {
    super(el('button', { class: 'lb-tabs__tab', attrs: { type: 'button', role: 'tab' } }));
    this.bag.listen(this.el, 'click', () => onClick(this.el.dataset.id ?? ''));
    this.update(props);
  }

  protected readDeps(next: TabProps): readonly unknown[] {
    return [next.tab.id, next.tab.label, next.tab.count, next.tab.title, next.active, next.digit];
  }

  protected paint(next: TabProps): void {
    this.el.dataset.id = next.tab.id;
    this.el.title = next.tab.title ?? '';
    setChildren(this.el, [
      el('span', { class: 'lb-tabs__label', text: next.tab.label }),
      next.tab.count !== undefined ? el('b', { class: 'lb-tabs__count', text: String(next.tab.count) }) : null,
      next.digit !== null ? el('span', { class: 'lb-tabs__key', text: String(next.digit) }) : null,
    ]);
    this.syncClasses(next);
  }

  protected syncClasses(next: TabProps): void {
    this.el.setAttribute('aria-selected', String(next.active));
  }
}

export class Tabs extends Component<TabsProps> {
  private props: TabsProps = { tabs: [], active: '' };

  constructor(private readonly options: TabsOptions, initial?: TabsProps) {
    super(
      el('nav', {
        class: ['lb-tabs', options.sticky && 'lb-tabs--sticky'],
        attrs: { role: 'tablist', 'aria-label': options.label },
      }),
    );
    if (options.keys) {
      this.bag.add(
        keymap().bindAll([
          { key: ']', label: 'Next tab', run: () => this.step(1) },
          { key: '[', label: 'Previous tab', run: () => this.step(-1) },
          {
            key: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
            display: '1–9',
            label: 'Jump to tab',
            run: (event) => {
              const tab = this.props.tabs[(this.options.numberFrom ?? 0) + Number(event.key) - 1];
              if (!tab) return false;
              this.options.onSelect(tab.id);
            },
          },
        ]),
      );
    }
    if (initial) this.update(initial);
  }

  protected readDeps(next: TabsProps): readonly unknown[] {
    return [next.active, ...next.tabs.flatMap((t) => [t.id, t.label, t.count, t.title])];
  }

  protected paint(next: TabsProps): void {
    this.props = next;
    const from = this.options.numberFrom ?? 0;
    reconcile(
      this.el,
      next.tabs.map((tab, index): TabProps => {
        const digit = index - from + 1;
        return {
          tab,
          active: tab.id === next.active,
          digit: this.options.keys && digit >= 1 && digit <= 9 ? digit : null,
        };
      }),
      {
        key: (row) => row.tab.id,
        create: (row) => new Tab(row, (id) => this.options.onSelect(id)),
        update: (cmp, row) => cmp.update(row),
      },
    );
  }

  protected syncClasses(): void {
    /* static */
  }

  private step(delta: number): void {
    const tabs = this.props.tabs;
    if (tabs.length === 0) return;
    const index = Math.max(0, tabs.findIndex((t) => t.id === this.props.active));
    this.options.onSelect(tabs[(index + delta + tabs.length) % tabs.length].id);
  }
}
