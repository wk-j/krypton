// Spec 302 §1.8 — `TabStrip`.
//
// Three call sites, the same strip:
//
//   * review matrix  (acp-harness-view.ts:5327-5342) — `<div
//     class="acp-review__lanes">` + `<span class="acp-review__lane is-active">`
//     whose text is `${name} · ${count}`;
//   * review priority (review-priority-overlay.ts:98-108) — the same loop,
//     character for character, with the `acp-priority` prefix;
//   * ticket picker  (harness-ticket-controller.ts:700-707,754-757) — `<div
//     class="acp-ticket__tabs" role="tablist">` + `<button
//     class="acp-ticket__tab acp-ticket__tab--active" type="button" role="tab"
//     aria-selected>` whose count is a `<span class="acp-ticket__tab-count">`.
//
// Nothing here is derived from anything else: the BEM element name (`lane` vs
// `tab`, which also names the container, `__lanes` / `__tabs`), the tag, the
// active-class convention and the count shape are four independent props,
// because that is how the three sites actually differ. Guessing `tab` from
// `button` would hold for exactly as long as the next caller takes to break it.
//
// `block` is a prop, so the component owns no block and ships no sheet.

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import type { ComponentDef } from '../types';

export interface TabStripTab {
  readonly id: string;
  readonly label: string;
  /** Rendered when present — including `0`, which every site shows today. */
  readonly count?: number;
  readonly disabled?: boolean;
}

/** BEM element name: the container is `${block}__${item}s`, each tab `${block}__${item}`. */
export type TabStripItem = 'lane' | 'tab';

/** `suffix` — ` · 4` in the tab's own text. `badge` — `<span class="${block}__tab-count">`. */
export type TabStripCount = 'suffix' | 'badge';

export interface TabStripProps {
  readonly tabs: readonly TabStripTab[];
  readonly activeId: string;
  /** The caller's BEM block, e.g. `acp-review`, `acp-ticket`. */
  readonly block: string;
  readonly item: TabStripItem;
  readonly activeClass: 'is-active' | `${string}--active`;
  /** Default `suffix`. */
  readonly count?: TabStripCount;
  /** `tablist` also gives every tab `role="tab"` and `aria-selected`. */
  readonly role?: 'tablist';
  readonly ariaLabel?: string;
  readonly onSelect?: (id: string) => void;
}

interface TabItemProps {
  readonly tab: TabStripTab;
  readonly block: string;
  readonly item: TabStripItem;
  readonly active: boolean;
  readonly activeClass: string;
  readonly count: TabStripCount;
  readonly aria: boolean;
}

class TabItem extends Component<TabItemProps> {
  constructor(tag: 'span' | 'button') {
    super(tag === 'button' ? el('button', { attrs: { type: 'button' } }) : el('span'));
  }

  protected readDeps(next: TabItemProps): readonly unknown[] {
    return [
      next.tab.id,
      next.tab.label,
      next.tab.count,
      next.tab.disabled,
      next.block,
      next.item,
      next.active,
      next.activeClass,
      next.count,
      next.aria,
    ];
  }

  protected syncClasses(next: TabItemProps): void {
    this.el.className = classes(`${next.block}__${next.item}`, next.active && next.activeClass);
  }

  protected paint(next: TabItemProps): void {
    this.syncClasses(next);
    setAttr(this.el, 'data-tab-id', next.tab.id);
    setAttr(this.el, 'role', next.aria && 'tab');
    setAttr(this.el, 'aria-selected', next.aria && String(next.active));
    const disabled = next.tab.disabled === true;
    if (this.el instanceof HTMLButtonElement) setAttr(this.el, 'disabled', disabled);
    else setAttr(this.el, 'aria-disabled', disabled && 'true');

    const { label, count } = next.tab;
    if (count === undefined) {
      this.el.textContent = label;
      return;
    }
    if (next.count === 'suffix') {
      this.el.textContent = `${label} · ${count}`;
      return;
    }
    this.el.replaceChildren(
      document.createTextNode(`${label} `),
      el('span', { class: `${next.block}__${next.item}-count`, text: String(count) }),
    );
  }
}

export class TabStrip extends Component<TabStripProps> {
  private readonly tag: 'span' | 'button';
  private select: ((id: string) => void) | undefined;

  constructor(tag: 'span' | 'button' = 'span') {
    super(el('div'));
    this.tag = tag;
    // ONE delegated listener for the whole strip, attached once. `select` is
    // refreshed by `update()` rather than read from a dep, so a caller passing
    // a fresh arrow function every render still costs zero repaints.
    this.bag.listen(this.el, 'click', (event: Event) => {
      if (!this.select || !(event.target instanceof Element)) return;
      const node = event.target.closest<HTMLElement>('[data-tab-id]');
      if (!node || !this.el.contains(node)) return;
      if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') return;
      const id = node.dataset.tabId;
      if (id !== undefined) this.select(id);
    });
  }

  update(next: TabStripProps): void {
    this.select = next.onSelect;
    super.update(next);
  }

  protected readDeps(next: TabStripProps): readonly unknown[] {
    return [
      next.tabs
        .map((tab) => `${tab.id}\u0001${tab.label}\u0001${tab.count ?? ''}\u0001${tab.disabled ?? false}`)
        .join('\u0002'),
      next.activeId,
      next.block,
      next.item,
      next.activeClass,
      next.count,
      next.role,
      next.ariaLabel,
    ];
  }

  protected syncClasses(next: TabStripProps): void {
    this.el.className = `${next.block}__${next.item}s`;
  }

  protected paint(next: TabStripProps): void {
    this.syncClasses(next);
    setAttr(this.el, 'role', next.role);
    setAttr(this.el, 'aria-label', next.ariaLabel);

    const shared = {
      block: next.block,
      item: next.item,
      activeClass: next.activeClass,
      count: next.count ?? 'suffix',
      aria: next.role === 'tablist',
    };
    reconcile<TabStripTab, TabItem>(this.el, next.tabs, {
      key: (tab) => tab.id,
      create: (tab) => {
        const item = new TabItem(this.tag);
        item.update({ ...shared, tab, active: tab.id === next.activeId });
        return item;
      },
      update: (item, tab) => item.update({ ...shared, tab, active: tab.id === next.activeId }),
    });
  }

  protected onDispose(): void {
    disposeList(this.el);
  }
}

export const def: ComponentDef = { id: 'tab-strip', blocks: [] };
