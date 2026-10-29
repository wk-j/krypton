// Spec 341 — the switcher: every surface and every project in one filterable
// list, opened with `` ` `` from any page. The shell supplies the items; this
// file owns only the overlay, the filter and the keys.

import { DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { reconcile } from '../../../ui/list';
import type { ListNode } from '../../../ui/list';
import { matchesQuery } from '../lib/format';
import { keymap } from '../lib/keymap';

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

class Row implements ListNode {
  readonly el = el('li', { class: 'lb-switcher__item', attrs: { role: 'option' } });

  constructor(
    public item: SwitcherItem,
    onPick: (row: Row) => void,
  ) {
    this.el.addEventListener('click', () => onPick(this));
  }

  paint(item: SwitcherItem, selected: boolean): void {
    this.item = item;
    this.el.replaceChildren(
      el('span', { class: 'lb-switcher__title', text: item.title }),
      el('span', { class: 'lb-switcher__meta', text: item.disabledReason ?? item.meta }),
    );
    this.el.classList.toggle('lb-switcher__item--off', item.disabledReason !== undefined);
    this.el.classList.toggle('lb-switcher__item--current', item.current === true);
    this.el.setAttribute('aria-selected', String(selected));
    this.el.setAttribute('aria-disabled', String(item.disabledReason !== undefined));
  }

  dispose(): void {
    this.el.remove();
  }
}

export class Switcher {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list = el('ul', { class: 'lb-switcher__list', attrs: { role: 'listbox', 'aria-label': 'Surfaces and projects' } });
  private readonly bag = new DisposableBag();
  private items: SwitcherItem[] = [];
  private visible: SwitcherItem[] = [];
  private selected = 0;
  private open = false;
  private returnFocus: Element | null = null;

  constructor(private readonly getItems: () => SwitcherItem[]) {
    this.input = el('input', {
      class: ['lb-input', 'lb-switcher__input'],
      attrs: { type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: 'Go to a surface or project…', 'aria-label': 'Go to' },
    });
    const panel = el(
      'div',
      { class: 'lb-overlay__panel', attrs: { role: 'dialog', 'aria-label': 'Switch surface' } },
      el('div', { class: 'lb-overlay__head' }, this.input),
      el('div', { class: 'lb-overlay__body' }, this.list),
      el(
        'footer',
        { class: 'lb-overlay__foot' },
        el('span', {}, el('kbd', { text: '↑↓' }), ' move'),
        el('span', {}, el('kbd', { text: 'Enter' }), ' go'),
        el('span', {}, el('kbd', { text: 'Esc' }), ' close'),
      ),
    );
    this.el = el('div', { class: 'lb-overlay lb-switcher', attrs: { hidden: true } }, panel);
    this.bag.listen(this.el, 'mousedown', (event) => {
      if (event.target === this.el) this.close();
    });
    this.bag.listen(this.input, 'input', () => this.filter());
    const isOpen = (): boolean => this.open;
    this.bag.add(keymap().addModal(isOpen));
    this.bag.add(
      keymap().bindAll([
        { key: 'ArrowDown', inInput: true, modal: true, when: isOpen, run: () => this.move(1) },
        { key: 'ArrowUp', inInput: true, modal: true, when: isOpen, run: () => this.move(-1) },
        {
          key: 'Enter',
          inInput: true,
          modal: true,
          when: isOpen,
          run: () => this.pick(this.visible[this.selected]),
        },
        { key: 'Escape', inInput: true, modal: true, when: isOpen, run: () => this.close() },
        { code: 'Backquote', inInput: true, modal: true, when: isOpen, run: () => this.close() },
      ]),
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Open on every item, or only on `kind` (the shell's project button). */
  show(kind?: SwitcherItem['kind']): void {
    const items = this.getItems();
    this.items = kind ? items.filter((item) => item.kind === kind) : items;
    this.returnFocus = document.activeElement;
    this.open = true;
    this.el.hidden = false;
    this.input.value = '';
    this.input.placeholder = kind === 'project' ? 'Switch project…' : 'Go to a surface or project…';
    this.filter();
    const current = this.visible.findIndex((item) => item.current);
    if (current >= 0) this.selected = current;
    this.paint();
    this.input.focus();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
    if (this.returnFocus instanceof HTMLElement) this.returnFocus.focus();
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  dispose(): void {
    this.bag.dispose();
    this.el.remove();
  }

  private filter(): void {
    const query = this.input.value;
    this.visible = this.items.filter((item) => matchesQuery(`${item.title} ${item.meta} ${item.kind}`, query));
    this.selected = this.visible.findIndex((item) => item.disabledReason === undefined);
    if (this.selected < 0) this.selected = 0;
    this.paint();
  }

  private move(delta: number): void {
    const n = this.visible.length;
    if (n === 0) return;
    for (let step = 1; step <= n; step++) {
      const index = (this.selected + delta * step + n * step) % n;
      if (this.visible[index].disabledReason === undefined) {
        this.selected = index;
        break;
      }
    }
    this.paint();
    this.list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
  }

  private pick(item: SwitcherItem | undefined): void {
    if (!item || item.disabledReason !== undefined) return;
    this.close();
    item.run();
  }

  private paint(): void {
    reconcile(this.list, this.visible, {
      key: (item) => `${item.kind}:${item.id}`,
      create: (item, index) => {
        const row = new Row(item, (picked) => this.pick(picked.item));
        row.paint(item, index === this.selected);
        return row;
      },
      update: (row, item, index) => row.paint(item, index === this.selected),
    });
    if (this.visible.length === 0) {
      this.list.append(el('li', { class: 'lb-switcher__empty', text: 'Nothing matches' }));
    }
  }
}
