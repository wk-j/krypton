// Spec 341 — the filter box eight pages carried a copy of: `/` focuses it,
// `Esc` clears it (and blurs once empty), a muted count sits on the right.

import { DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { keymap } from '../lib/keymap';

import './search-filter.css';

export interface SearchFilterOptions {
  readonly placeholder: string;
  readonly label?: string;
  readonly onInput: (query: string) => void;
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
  /** Bind `/` to focus the box. Default true; at most one filter per page may. */
  readonly slashKey?: boolean;
  readonly initial?: string;
}

export class SearchFilter {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly count = el('span', { class: 'lb-filter__count' });
  private readonly bag = new DisposableBag();

  constructor(private readonly options: SearchFilterOptions) {
    this.input = el('input', {
      class: ['lb-input', 'lb-filter__input'],
      attrs: {
        type: 'search',
        placeholder: options.placeholder,
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': options.label ?? options.placeholder,
      },
    });
    if (options.initial) this.input.value = options.initial;
    this.el = el('div', { class: 'lb-filter' }, this.input, this.count);
    this.bag.listen(this.input, 'input', () => options.onInput(this.input.value));
    this.bag.listen(this.input, 'keydown', (event) => this.onKey(event as KeyboardEvent));
    if (options.slashKey !== false) {
      this.bag.add(
        keymap().bind({
          key: '/',
          label: 'Focus the filter',
          group: 'Page',
          run: () => this.focus(),
        }),
      );
    }
  }

  get query(): string {
    return this.input.value;
  }

  set query(value: string) {
    this.input.value = value;
    this.options.onInput(value);
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  setCount(text: string): void {
    this.count.textContent = text;
  }

  dispose(): void {
    this.bag.dispose();
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (this.input.value && this.options.escape !== 'leave') {
        this.query = '';
        if (this.options.escape !== 'clear-and-leave') return;
      }
      this.input.blur();
      this.options.onEscape?.();
      return;
    }
    if (event.key === 'Enter' && this.options.onSubmit) {
      event.preventDefault();
      this.options.onSubmit(this.input.value);
    }
  }
}
