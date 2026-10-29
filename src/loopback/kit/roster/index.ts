// Spec 341 — a keyboard list: one selected row (`aria-selected`), `j`/`k`/
// arrows move it, `Enter` opens it. termctrl sessions, e2e cases, the commands
// index and the home tiles all had their own copy of this.

import { Component, DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { keymap } from '../lib/keymap';
import type { KeyBinding } from '../lib/keymap';

import './roster.css';

export interface RosterOptions<T> {
  readonly label: string;
  key(item: T): string;
  /** Row content. Called on create and whenever `deps(item)` moves. */
  render(item: T): HTMLElement | DocumentFragment;
  /** The values `render` reads; default: the item itself (reference equality). */
  deps?(item: T): readonly unknown[];
  onSelect?(item: T): void;
  onOpen?(item: T): void;
  /** Bind `j`/`k`/`↑`/`↓`/`Enter` on the page keymap. Default true. */
  readonly keys?: boolean;
  /** Gate for those keys (e.g. only while this pane is active). */
  readonly when?: () => boolean;
  readonly empty?: string;
  /** `j`/`k` past either end wraps to the other. Default false (stops at the ends). */
  readonly wrap?: boolean;
}

interface RowProps<T> {
  readonly item: T;
  readonly selected: boolean;
}

class RosterRow<T> extends Component<RowProps<T>> {
  item!: T;

  constructor(
    private readonly options: RosterOptions<T>,
    props: RowProps<T>,
    onClick: (row: RosterRow<T>) => void,
  ) {
    super(el('li', { class: 'lb-roster__item', attrs: { role: 'option', tabindex: '-1' } }));
    this.bag.listen(this.el, 'click', () => onClick(this));
    this.update(props);
  }

  protected readDeps(next: RowProps<T>): readonly unknown[] {
    return [next.selected, ...(this.options.deps ? this.options.deps(next.item) : [next.item])];
  }

  protected paint(next: RowProps<T>): void {
    this.item = next.item;
    this.el.replaceChildren(this.options.render(next.item));
    this.el.dataset.key = this.options.key(next.item);
    this.syncClasses(next);
  }

  protected syncClasses(next: RowProps<T>): void {
    this.el.setAttribute('aria-selected', String(next.selected));
  }
}

export class RosterList<T> {
  readonly el: HTMLUListElement;
  private items: readonly T[] = [];
  private selectedKey: string | null = null;
  private readonly bag = new DisposableBag();
  private readonly emptyNode: HTMLElement | null;

  constructor(private readonly options: RosterOptions<T>) {
    this.el = el('ul', { class: 'lb-roster', attrs: { role: 'listbox', 'aria-label': options.label } });
    this.emptyNode = options.empty ? el('li', { class: 'lb-roster__empty', text: options.empty }) : null;
    if (options.keys !== false) {
      const when = options.when;
      const bindings: KeyBinding[] = [
        { key: ['j', 'ArrowDown'], label: 'Next item', when, run: () => this.move(1) },
        { key: ['k', 'ArrowUp'], label: 'Previous item', when, run: () => this.move(-1) },
        {
          key: 'Enter',
          label: 'Open the selected item',
          when,
          run: () => {
            const item = this.selected();
            if (!item || !this.options.onOpen) return false;
            this.options.onOpen(item);
          },
        },
      ];
      this.bag.add(keymap().bindAll(bindings));
    }
  }

  setItems(items: readonly T[]): void {
    this.items = items;
    if (this.selectedKey !== null && !items.some((item) => this.options.key(item) === this.selectedKey)) {
      this.selectedKey = null;
    }
    this.render();
  }

  selected(): T | null {
    if (this.selectedKey === null) return null;
    return this.items.find((item) => this.options.key(item) === this.selectedKey) ?? null;
  }

  /** Select by key; `notify` fires `onSelect`. Scrolls the row into view. */
  select(key: string | null, notify = true): void {
    if (key === this.selectedKey) return;
    this.selectedKey = key;
    this.render();
    const item = this.selected();
    if (item && notify) this.options.onSelect?.(item);
    if (key !== null) {
      this.el.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  move(delta: number): void {
    const n = this.items.length;
    if (n === 0) return;
    const index = this.items.findIndex((item) => this.options.key(item) === this.selectedKey);
    let next: number;
    if (index < 0) next = delta > 0 ? 0 : n - 1;
    else if (this.options.wrap) next = (((index + delta) % n) + n) % n;
    else next = Math.min(n - 1, Math.max(0, index + delta));
    this.select(this.options.key(this.items[next]));
  }

  dispose(): void {
    this.bag.dispose();
    disposeList(this.el);
  }

  private render(): void {
    reconcile(this.el, this.items, {
      key: (item) => this.options.key(item),
      create: (item) =>
        new RosterRow(this.options, { item, selected: this.options.key(item) === this.selectedKey }, (row) => {
          this.select(this.options.key(row.item));
          this.options.onOpen?.(row.item);
        }),
      update: (row, item) => row.update({ item, selected: this.options.key(item) === this.selectedKey }),
    });
    if (this.emptyNode) {
      if (this.items.length === 0) this.el.append(this.emptyNode);
      else this.emptyNode.remove();
    }
  }
}
