// Spec 313 / 341 — the GenUI component gallery: an index rail of every shipped
// catalog component, one live example at a time on a Krypton-window stage,
// hash-addressed (`#Slider`) so back/forward and deep links work.

// The panel body the Harness seats a spec in: the gallery preview carries the
// same block, so the roots get the app's own column rhythm, not a gallery one.
import '../../../acp/components/genui-panel/genui-panel.css';

import { COMPONENTS, GROUP_ORDER } from '../../../acp/genui/catalog';
import type { ComponentSpec, ParamSpec } from '../../../acp/genui/catalog';
import { FOCUSABLE_ATTR } from '../../../acp/components/genui-catalog/renderer';
import { DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { button, kbdHints, keymap, SearchFilter } from '../../kit';
import type { AppShell } from '../../kit';
import { EXAMPLES } from './examples';
import { GalleryPreview } from './preview';
import { applyKryptonTheme } from './theme';

import './genui.css';

/** One catalog component: its index entry, and its view once it has been opened. */
interface Entry {
  readonly spec: ComponentSpec;
  readonly position: number;
  readonly nav: HTMLAnchorElement;
  element: HTMLElement | null;
  preview: GalleryPreview | null;
}

const SURFACE_TITLE = 'GenUI components';
const THEME_FALLBACK = 'krypton-dark (built-in) · app theme unavailable';

function paramKind(param: ParamSpec): string {
  if (param.kind === 'enum' && param.values !== undefined) return param.values.join(' | ');
  if (param.kind === 'binding') return param.holds === undefined ? 'binding $name' : `binding $name → ${param.holds}`;
  return param.kind;
}

function buildParams(spec: ComponentSpec): HTMLElement {
  const rows: HTMLElement[] = [];
  for (const param of spec.params) {
    rows.push(
      el(
        'dt',
        { class: 'lb-genui__param-name' },
        param.name,
        param.required === true ? el('span', { class: 'lb-genui__param-required', text: 'required' }) : null,
      ),
      el('dd', { class: 'lb-genui__param-kind', text: paramKind(param) }),
    );
  }
  if (spec.params.length === 0) {
    rows.push(
      el('dt', { class: 'lb-genui__param-name', text: '—' }),
      el('dd', { class: 'lb-genui__param-kind', text: 'no parameters' }),
    );
  }
  return el(
    'section',
    { class: 'lb-genui__params' },
    el('div', { class: ['lb-h3', 'lb-genui__label'], text: 'Parameters' }),
    el('dl', { class: 'lb-genui__param-list' }, ...rows),
  );
}

export class GenuiGallery {
  readonly el: HTMLElement;
  private readonly nav = el('nav', { class: 'lb-genui__nav', attrs: { 'aria-label': 'Components' } });
  private readonly detail = el('article', { class: 'lb-genui__detail' });
  private readonly pager = el('nav', {
    class: 'lb-genui__pager',
    attrs: { 'aria-label': 'Previous and next component' },
  });
  private readonly mainPane: HTMLElement;
  private readonly empty = el('p', { class: 'lb-genui__empty', text: 'No component matches.', attrs: { hidden: true } });
  private readonly themeLabel = el('div', { class: 'lb-genui__theme' });
  private readonly search: SearchFilter;
  private readonly groups: HTMLElement[] = [];
  private readonly examples = new Map(EXAMPLES.map((example) => [example.component, example]));
  private readonly entries: Entry[] = [];
  private readonly byName = new Map<string, Entry>();
  private readonly bag = new DisposableBag();
  private current: Entry | null = null;

  constructor(private readonly shell: AppShell) {
    this.search = new SearchFilter({
      placeholder: 'Search name or summary',
      label: 'Search components',
      onInput: () => this.filterNav(),
      onSubmit: () => {
        const first = this.visibleEntries()[0];
        if (first === undefined) return;
        this.navigate(first);
        this.focusNavItem(first);
      },
      // One Esc clears the box and leaves it for the open component's index entry.
      escape: 'clear-and-leave',
      onEscape: () => {
        if (this.current !== null) this.focusNavItem(this.current);
      },
    });
    this.search.el.classList.add('lb-genui__search');
    this.bag.add(() => this.search.dispose());

    for (const group of GROUP_ORDER) {
      const specs = COMPONENTS.filter((component) => component.group === group);
      const heading = el('h2', { class: 'lb-genui__nav-heading', data: { group }, text: `${group} · ${specs.length}` });
      const section = el('section', { class: 'lb-genui__nav-group', data: { group } }, heading);
      for (const spec of specs) {
        const item = el('a', { class: 'lb-genui__nav-item', attrs: { href: `#${spec.name}` }, text: spec.name });
        section.append(item);
        const entry: Entry = { spec, position: this.entries.length + 1, nav: item, element: null, preview: null };
        this.entries.push(entry);
        this.byName.set(spec.name, entry);
      }
      this.groups.push(section);
      this.nav.append(section);
    }

    this.mainPane = el(
      'div',
      { class: 'lb-genui__main' },
      this.detail,
      this.pager,
      el('footer', {
        class: 'lb-genui__foot',
        text: 'Fixed local examples through the production compiler and renderer. Draft and OpenUrl show demo feedback; nothing is sent to a lane.',
      }),
    );
    this.el = el(
      'div',
      { class: ['lb-page', 'lb-page--fill', 'lb-genui'] },
      el(
        'div',
        { class: ['lb-split', 'lb-genui__layout'] },
        el(
          'aside',
          { class: 'lb-genui__side' },
          this.themeLabel,
          this.search.el,
          this.nav,
          this.empty,
          kbdHints([
            ['/', 'search'],
            ['[ ]', 'prev/next'],
            ['↑↓', 'move'],
            ['Enter', 'open'],
            ['Esc', 'clear'],
          ]),
        ),
        this.mainPane,
      ),
    );
    this.bindKeys();
  }

  /** Theme first — the mermaid Diagram renderer reads resolved tokens at mount — then the first view. */
  async start(): Promise<void> {
    // The catalog's scheme rules read this before theme.json lands, as the old page's markup set it.
    document.documentElement.dataset.themeScheme ??= 'dark';
    try {
      this.themeLabel.textContent = await applyKryptonTheme();
    } catch {
      this.themeLabel.textContent = THEME_FALLBACK;
    }
    this.filterNav();
    this.showFromHash();
    this.bag.listen(window, 'hashchange', () => this.showFromHash());
    // A palette switch or Reload Config in Krypton lands the next time this tab
    // is looked at; the custom properties repaint the mounted preview with no rebuild.
    this.bag.listen(window, 'focus', () => {
      void applyKryptonTheme().then((text) => { this.themeLabel.textContent = text; }).catch(() => {});
    });
  }

  dispose(): void {
    this.bag.dispose();
    this.current?.preview?.dispose();
  }

  private bindKeys(): void {
    this.bag.add(
      keymap().bindAll([
        {
          key: ['[', ']'],
          display: '[ / ]',
          label: 'Previous / next component',
          run: (event) => {
            const list = this.walkList();
            if (list.length === 0) return;
            const index = this.current === null ? -1 : list.indexOf(this.current);
            const next = list[(index + (event.key === ']' ? 1 : -1) + list.length) % list.length];
            this.navigate(next);
            this.focusNavItem(next);
          },
        },
        {
          key: ['ArrowDown', 'ArrowUp'],
          display: '↑ / ↓',
          label: 'Move in the index (from the search box: ↓)',
          inInput: true,
          run: (event) => {
            const target = event.target;
            if (target === this.search.input) {
              if (event.key !== 'ArrowDown') return false;
              this.focusNav(1);
              return;
            }
            if (!(target instanceof Node) || !this.nav.contains(target)) return false;
            this.focusNav(event.key === 'ArrowDown' ? 1 : -1);
          },
        },
        {
          key: 'Enter',
          label: 'Open the focused component',
          run: (event) => {
            const entry = this.entries.find((candidate) => candidate.nav === event.target);
            if (entry === undefined) return false;
            this.navigate(entry);
            if (entry.element !== null) this.focusPreviewOf(entry.element);
          },
        },
        {
          // Outside any input; inside the box SearchFilter's own Esc clears and leaves.
          key: 'Escape',
          label: 'Clear the search',
          run: () => {
            if (this.search.query === '') return false;
            this.search.query = '';
          },
        },
      ]),
    );
  }

  private buildEntryView(entry: Entry): HTMLElement {
    const spec = entry.spec;
    const example = this.examples.get(spec.name);
    if (example === undefined) throw new Error(`Missing GenUI gallery example: ${spec.name}`);

    const previewHost = el('div', { class: ['lb-genui__preview', 'acp-genui-panel__body', 'acp-genui'] });
    const status = el('div', { class: 'lb-genui__status', attrs: { role: 'status' } });
    const source = el('pre', {
      class: ['lb-code', 'lb-code--wrap', 'lb-genui__source'],
      text: `version 2\n${example.source}`,
      attrs: { hidden: true },
    });
    const preview = new GalleryPreview(example.source, previewHost, status);
    entry.preview = preview;

    const sourceButton = button('Source', {
      onClick: () => {
        source.hidden = !source.hidden;
        sourceButton.setAttribute('aria-expanded', String(!source.hidden));
        const text = sourceButton.querySelector('.lb-btn__label');
        if (text !== null) text.textContent = source.hidden ? 'Source' : 'Hide source';
      },
    });
    sourceButton.setAttribute('aria-expanded', 'false');
    const resetButton = button('Reset', { onClick: () => preview.reset() });

    return el(
      'div',
      { class: 'lb-genui__view' },
      el(
        'header',
        { class: 'lb-genui__view-head' },
        el('div', { class: 'lb-genui__crumb', text: `${spec.group} · ${entry.position} / ${this.entries.length}` }),
        el(
          'div',
          { class: 'lb-genui__view-title' },
          el('h2', { class: 'lb-genui__view-name', text: spec.name }),
          el('div', { class: 'lb-genui__view-actions' }, sourceButton, resetButton),
        ),
        el('p', { class: 'lb-genui__view-summary', text: spec.summary }),
      ),
      el('div', { class: ['lb-h3', 'lb-genui__label'], text: 'Preview · Krypton surface' }),
      el('div', { class: 'lb-genui__stage' }, previewHost),
      status,
      source,
      buildParams(spec),
    );
  }

  private visibleEntries(): Entry[] {
    return this.entries.filter((entry) => !entry.nav.hidden);
  }

  /** The list `[`/`]` and the pager walk: the search result when it holds the open component. */
  private walkList(): Entry[] {
    const visible = this.visibleEntries();
    if (this.current !== null && visible.includes(this.current)) return visible;
    return this.entries;
  }

  private updatePager(): void {
    const list = this.walkList();
    const index = this.current === null ? -1 : list.indexOf(this.current);
    if (index < 0 || list.length < 2) {
      this.pager.replaceChildren();
      return;
    }
    const previous = list[(index - 1 + list.length) % list.length];
    const next = list[(index + 1) % list.length];
    this.pager.replaceChildren(pagerLink(previous, 'prev'), pagerLink(next, 'next'));
  }

  /** Scroll the rail only when the item is out of its band — `scrollIntoView` hides it under the sticky group heading. */
  private revealNav(item: HTMLElement): void {
    const port = this.nav.getBoundingClientRect();
    if (port.height === 0) return;
    const heading = item.parentElement?.querySelector<HTMLElement>('.lb-genui__nav-heading');
    const rect = item.getBoundingClientRect();
    const top = port.top + (heading?.offsetHeight ?? 0);
    if (rect.top < top) this.nav.scrollTop -= top - rect.top;
    else if (rect.bottom > port.bottom) this.nav.scrollTop += rect.bottom - port.bottom;
  }

  private focusPreviewOf(element: HTMLElement): void {
    const target = element.querySelector<HTMLElement>(`[${FOCUSABLE_ATTR}]`)
      ?? element.querySelector<HTMLElement>('.lb-genui__view-actions button');
    target?.focus();
  }

  private show(name: string): void {
    const entry = this.byName.get(name);
    if (entry === undefined || this.current === entry) return;
    this.current?.preview?.dispose();
    this.current = entry;
    if (entry.element === null) entry.element = this.buildEntryView(entry);
    this.detail.replaceChildren(entry.element);
    entry.preview?.mount();
    this.mainPane.scrollTop = 0;
    this.shell.setTitle(`${entry.spec.name} · ${SURFACE_TITLE}`);
    for (const other of this.entries) {
      other.nav.classList.toggle('lb-genui__nav-item--current', other === entry);
      if (other === entry) other.nav.setAttribute('aria-current', 'true');
      else other.nav.removeAttribute('aria-current');
    }
    this.revealNav(entry.nav);
    this.updatePager();
  }

  private navigate(entry: Entry): void {
    if (location.hash === `#${entry.spec.name}`) this.show(entry.spec.name);
    else location.hash = entry.spec.name;
  }

  private showFromHash(): void {
    let name = '';
    try {
      name = decodeURIComponent(location.hash.slice(1));
    } catch {
      name = '';
    }
    if (this.byName.has(name)) this.show(name);
    else if (this.current === null) this.show(this.entries[0].spec.name);
  }

  private filterNav(): void {
    const query = this.search.query.trim().toLowerCase();
    for (const entry of this.entries) {
      const haystack = `${entry.spec.name} ${entry.spec.summary}`.toLowerCase();
      entry.nav.hidden = query !== '' && !haystack.includes(query);
    }
    for (const section of this.groups) {
      const group = section.dataset.group;
      const shown = this.entries.filter((entry) => entry.spec.group === group && !entry.nav.hidden);
      section.hidden = shown.length === 0;
      const heading = section.querySelector<HTMLElement>('.lb-genui__nav-heading');
      if (heading !== null) heading.textContent = `${group ?? ''} · ${shown.length}`;
    }
    const visible = this.visibleEntries().length;
    this.search.setCount(query === '' ? `${this.entries.length} components` : `${visible} / ${this.entries.length} match`);
    this.empty.hidden = visible > 0;
    this.updatePager();
  }

  /** Move focus inside the rail; native focus scrolling would tuck the item under the sticky heading. */
  private focusNavItem(entry: Entry): void {
    entry.nav.focus({ preventScroll: true });
    this.revealNav(entry.nav);
  }

  private focusNav(step: number): void {
    const visible = this.visibleEntries();
    if (visible.length === 0) return;
    const active = document.activeElement;
    const index = visible.findIndex((entry) => entry.nav === active);
    const next = index < 0
      ? (step > 0 ? 0 : visible.length - 1)
      : (index + step + visible.length) % visible.length;
    this.focusNavItem(visible[next]);
  }
}

function pagerLink(entry: Entry, direction: 'prev' | 'next'): HTMLAnchorElement {
  return el(
    'a',
    {
      class: ['lb-genui__pager-link', `lb-genui__pager-link--${direction}`],
      attrs: { href: `#${entry.spec.name}` },
    },
    el('span', { class: 'lb-genui__pager-dir', text: direction === 'prev' ? '← prev' : 'next →' }),
    el('span', { class: 'lb-genui__pager-name', text: entry.spec.name }),
  );
}
