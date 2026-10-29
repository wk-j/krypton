// Spec 341 — `?` lists every labelled key the page answers to: the shell's,
// then the surface's, read live from the keymap.

import { DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { keymap } from '../lib/keymap';

import '../overlay/overlay.css';
import './key-help.css';

export class KeyHelp {
  readonly el: HTMLElement;
  private readonly body = el('div', { class: 'lb-overlay__body lb-keyhelp__body' });
  private readonly bag = new DisposableBag();
  private open = false;

  constructor() {
    this.el = el(
      'div',
      { class: 'lb-overlay lb-keyhelp', attrs: { hidden: true } },
      el(
        'div',
        { class: 'lb-overlay__panel', attrs: { role: 'dialog', 'aria-label': 'Keyboard shortcuts' } },
        el('div', { class: 'lb-overlay__head' }, el('h2', { class: 'lb-overlay__title', text: 'Keyboard' })),
        this.body,
        el('footer', { class: 'lb-overlay__foot' }, el('span', {}, el('kbd', { text: 'Esc' }), ' close')),
      ),
    );
    this.bag.listen(this.el, 'mousedown', (event) => {
      if (event.target === this.el) this.close();
    });
    const isOpen = (): boolean => this.open;
    this.bag.add(keymap().addModal(isOpen));
    this.bag.add(
      keymap().bind({ key: ['Escape', '?'], inInput: true, modal: true, when: isOpen, run: () => this.close() }),
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    const groups = new Map<string, HTMLElement>();
    for (const entry of keymap().help()) {
      let list = groups.get(entry.group);
      if (!list) {
        list = el('dl', { class: 'lb-keyhelp__list' });
        groups.set(entry.group, list);
      }
      list.append(el('dt', {}, el('kbd', { text: entry.keys })), el('dd', { text: entry.label }));
    }
    this.body.replaceChildren(
      ...[...groups].map(([group, list]) =>
        el('section', { class: 'lb-keyhelp__group' }, el('h3', { class: 'lb-h3', text: group }), list),
      ),
    );
    this.open = true;
    this.el.hidden = false;
  }

  close(): void {
    this.open = false;
    this.el.hidden = true;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  dispose(): void {
    this.bag.dispose();
    this.el.remove();
  }
}
