// Spec 341 — the docs reader (`/docs`, `/journal`, `/doc`; specs 171, 172,
// 174, 223). Rust renders the body (hook_server.rs `render_docs_page`):
//
//   div.lb-page.lb-docs[data-title] > article.lb-prose >
//     nav.lb-tabs > a.lb-tabs__tab[aria-selected]      harness switcher (>1 harness)
//     div#docs-filter[data-placeholder][data-unit]     the SearchFilter mounts here
//     ul#docs-list.lb-docs__list > li.lb-docs__item[data-path] > a.lb-docs__link
//     p#docs-empty                                     shown when nothing matches
//
// or one rendered markdown file (`/doc`). This module hydrates it: the index
// filter (both indexes — the old page's script returned early on `/journal`),
// ↑/↓/Enter selection, type-anywhere-to-filter, local dates, and on `/doc`
// the comment + artifact overlay.

import type { Disposer } from '../../../ui/component';
import { DisposableBag } from '../../../ui/component';
import { FeedbackOverlay, isEditableTarget, keymap, localizeTimes, matchesQuery, PROSE_CLASS, SearchFilter } from '../../kit';
import type { AppShell } from '../../kit';

import './docs.css';

const SELECTED = 'lb-docs__item--selected';

/** The flat index: every row is already in the DOM; the filter hides rows in place. */
export class DocsIndex {
  readonly filter: SearchFilter;
  private readonly items: HTMLElement[];
  private visible: HTMLElement[];
  private selected = -1;
  private readonly unit: string;
  private readonly empty: HTMLElement | null;
  private readonly bag = new DisposableBag();

  constructor(slot: HTMLElement, list: HTMLElement, empty: HTMLElement | null) {
    this.items = [...list.children].filter((node): node is HTMLElement => node instanceof HTMLElement);
    this.visible = this.items.slice();
    this.unit = slot.dataset.unit ?? 'files';
    this.empty = empty;
    this.filter = new SearchFilter({
      placeholder: slot.dataset.placeholder ?? 'filter — type to narrow, ↑↓ to move, enter to open',
      onInput: () => this.apply(),
      onSubmit: () => this.open(),
    });
    this.bag.add(() => this.filter.dispose());
    slot.replaceChildren(this.filter.el);
    this.filter.setCount(`${this.items.length} ${this.unit}`);

    const input = this.filter.input;
    // ↑/↓ work from the box and from the page; any other field keeps its arrows.
    const listKeys = (): boolean =>
      this.visible.length > 0 && (document.activeElement === input || !isEditableTarget(document.activeElement));
    const keys = keymap();
    this.bag.add(
      keys.bindAll([
        { key: 'ArrowDown', label: 'Next match', inInput: true, when: listKeys, run: () => this.step(1) },
        { key: 'ArrowUp', label: 'Previous match', inInput: true, when: listKeys, run: () => this.step(-1) },
        {
          key: 'Enter',
          label: 'Open the selected file',
          // A focused link answers Enter itself.
          when: () => this.selected >= 0 && !(document.activeElement instanceof HTMLAnchorElement),
          run: () => this.open(),
        },
      ]),
    );
    // Typing anywhere goes to the box. Decline so the character lands in it,
    // and leave the shell's `` ` `` / `?` (already bound, so they never get
    // here) and every chord alone.
    this.bag.add(
      keys.setFallback((event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return false;
        if (event.key.length !== 1 || event.key === '`' || event.key === '?') return false;
        input.focus();
        return false;
      }),
    );
  }

  get selectedPath(): string | null {
    return this.visible[this.selected]?.dataset.path ?? null;
  }

  dispose(): void {
    this.bag.dispose();
  }

  private apply(): void {
    const query = this.filter.query;
    const filtering = query.trim().length > 0;
    this.visible = [];
    for (const item of this.items) {
      const match = matchesQuery(item.dataset.path ?? '', query);
      item.hidden = !match;
      item.classList.remove(SELECTED);
      if (match) this.visible.push(item);
    }
    this.selected = -1;
    this.filter.setCount(
      filtering ? `${this.visible.length} / ${this.items.length} ${this.unit}` : `${this.items.length} ${this.unit}`,
    );
    if (this.empty) this.empty.hidden = this.visible.length > 0;
    if (filtering && this.visible.length > 0) this.select(0);
  }

  private select(index: number): void {
    this.visible[this.selected]?.classList.remove(SELECTED);
    this.selected = index;
    const item = this.visible[index];
    if (!item) return;
    item.classList.add(SELECTED);
    item.scrollIntoView?.({ block: 'nearest' });
  }

  private step(delta: number): void {
    const next = this.selected + delta;
    this.select(next < 0 ? this.visible.length - 1 : next >= this.visible.length ? 0 : next);
  }

  /** Enter: the selection, else the first match — exactly like clicking the row. */
  private open(): void {
    const item = this.visible[this.selected] ?? this.visible[0];
    // Inside a keydown the click carries user activation, so the row's
    // target=_blank is not popup-blocked.
    item?.querySelector('a')?.click();
  }
}

export interface DocsLocation {
  readonly pathname: string;
  readonly search: string;
}

export function mountDocs(shell: Pick<AppShell, 'setTitle'>, main: HTMLElement, at: DocsLocation = location): Disposer {
  const bag = new DisposableBag();
  const page = main.querySelector<HTMLElement>('.lb-docs');
  const title = page?.dataset.title;
  if (title) shell.setTitle(title);
  localizeTimes(main);

  const slot = main.querySelector<HTMLElement>('#docs-filter');
  const list = main.querySelector<HTMLElement>('#docs-list');
  if (slot && list) {
    const index = new DocsIndex(slot, list, main.querySelector<HTMLElement>('#docs-empty'));
    bag.add(() => index.dispose());
  }

  if (at.pathname === '/doc') {
    const query = new URLSearchParams(at.search);
    const harness = query.get('harness') ?? '';
    const path = query.get('path') ?? '';
    const scope = main.querySelector<HTMLElement>(`article.${PROSE_CLASS}`);
    if (harness && path && scope) {
      const overlay = new FeedbackOverlay({ harness, path, scope });
      bag.add(() => overlay.dispose());
    }
  }
  return () => bag.dispose();
}
