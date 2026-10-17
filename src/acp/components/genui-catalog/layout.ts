// Spec 309 — Layout group renderers (Card · Row · Stack · Grid · Tabs ·
// Details · Divider).
//
// Every renderer here owns exactly one box inside the slot the reconciler
// handed it (`.acp-genui__slot` is `display: contents`, so that box is the
// element the parent's flex/grid lays out). The box and its fixed children are
// built in the constructor, so `paint()` only ever writes text, classes and the
// child list — a repaint can never move a focused control.
//
// `Tabs` and `Details` keep their one bit of view state in `ctx.view(key)`,
// which outlives re-evaluation and panel reopen, and both list that bit in
// `readDeps()`: the click handler writes it and asks for a repaint, and the
// repaint is what moves the DOM.

import { classes, el } from '../../../ui/dom';
import {
  BLOCK,
  FOCUSABLE_ATTR,
  GenUiComponent,
  asBoolean,
  asList,
  asNodes,
  asNumber,
  asString,
  renderChildren,
} from './renderer';
import type { GenUiFactory, GenUiProps } from './renderer';

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 6;
const DEFAULT_COLUMNS = 2;

class CardComponent extends GenUiComponent {
  private readonly title = el('div', { class: `${BLOCK}__card-title` });
  private readonly body = el('div', { class: `${BLOCK}__card-body` });
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('section', { class: `${BLOCK}__card`, children: [this.title, this.body] });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.title, next.node.props.children];
  }

  protected paint(next: GenUiProps): void {
    const title = asString(next.node.props.title);
    this.title.textContent = title;
    this.title.hidden = title === '';
    renderChildren(this.body, asNodes(next.node.props.children), next.ctx);
  }
}

class RowComponent extends GenUiComponent {
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', { class: `${BLOCK}__row` });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.children];
  }

  protected paint(next: GenUiProps): void {
    renderChildren(this.root, asNodes(next.node.props.children), next.ctx);
  }
}

class StackComponent extends GenUiComponent {
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', { class: `${BLOCK}__stack` });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.children];
  }

  protected paint(next: GenUiProps): void {
    renderChildren(this.root, asNodes(next.node.props.children), next.ctx);
  }
}

class GridComponent extends GenUiComponent {
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    // `__grid` belongs to EditableTable (inputs.css); the tile grid is `__tiles`.
    this.root = el('div', { class: `${BLOCK}__tiles` });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.children, next.node.props.columns];
  }

  protected paint(next: GenUiProps): void {
    const asked = Math.round(asNumber(next.node.props.columns, DEFAULT_COLUMNS));
    const columns = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, asked));
    this.root.style.setProperty('--acp-genui-columns', String(columns));
    renderChildren(this.root, asNodes(next.node.props.children), next.ctx);
  }
}

/**
 * One pane visible at a time. The strip is a roving tabindex: the selected tab
 * is the only one in the sequential order, and Arrow/Home/End move it.
 */
class TabsComponent extends GenUiComponent {
  private readonly strip = el('div', { class: `${BLOCK}__tabs-strip`, attrs: { role: 'tablist' } });
  private readonly pane = el('div', { class: `${BLOCK}__tabs-pane` });
  private readonly root: HTMLElement;
  private readonly tabs: HTMLButtonElement[] = [];
  private current: GenUiProps | null = null;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', { class: `${BLOCK}__tabs`, children: [this.strip, this.pane] });
    host.appendChild(this.root);
    this.bag.listen(this.strip, 'keydown', (event) => {
      if (event instanceof KeyboardEvent) this.onKey(event);
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.labels, next.node.props.children, selectedTab(next)];
  }

  protected paint(next: GenUiProps): void {
    this.current = next;
    const panes = asNodes(next.node.props.children);
    const labels = asList(next.node.props.labels);
    const selected = selectedTab(next);
    const count = Math.max(labels.length, panes.length);

    for (const dropped of this.tabs.splice(count)) dropped.remove();
    for (let i = 0; i < count; i++) {
      const tab = this.tabs[i] ?? this.createTab(i);
      this.tabs[i] = tab;
      const on = i === selected;
      tab.textContent = asString(labels[i], `Tab ${i + 1}`);
      tab.className = classes(`${BLOCK}__tab`, on && `${BLOCK}__tab--on`);
      tab.tabIndex = on ? 0 : -1;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      if (tab.parentNode === null) this.strip.appendChild(tab);
    }

    const pane = panes[selected];
    renderChildren(this.pane, pane === undefined ? [] : [pane], next.ctx);
  }

  private createTab(index: number): HTMLButtonElement {
    const tab = el('button', {
      class: `${BLOCK}__tab`,
      attrs: { type: 'button', role: 'tab', [FOCUSABLE_ATTR]: true },
    });
    this.bag.listen(tab, 'click', () => this.select(index));
    return tab;
  }

  private onKey(event: KeyboardEvent): void {
    const count = this.tabs.length;
    if (count === 0) return;
    const from = this.tabs.findIndex((tab) => tab.tabIndex === 0);
    const at = from < 0 ? 0 : from;
    let next = at;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % count;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (at + count - 1) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    event.preventDefault();
    this.select(next);
    this.tabs[next].focus();
  }

  private select(index: number): void {
    const props = this.current;
    if (props === null) return;
    props.ctx.view(props.node.key).tab = index;
    props.ctx.repaint();
  }
}

/** Clamped so a stored tab index survives a spec that lost a pane. */
function selectedTab(next: GenUiProps): number {
  const count = asNodes(next.node.props.children).length;
  const stored = next.ctx.view(next.node.key).tab;
  const index = typeof stored === 'number' ? Math.trunc(stored) : 0;
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}

class DetailsComponent extends GenUiComponent {
  private readonly summary = el('summary', {
    class: `${BLOCK}__details-summary`,
    attrs: { [FOCUSABLE_ATTR]: true },
  });

  private readonly body = el('div', { class: `${BLOCK}__details-body` });
  private readonly root: HTMLDetailsElement;
  private current: GenUiProps | null = null;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('details', { class: `${BLOCK}__details`, children: [this.summary, this.body] });
    host.appendChild(this.root);
    // Native disclosure: the element has already moved, so this only records
    // the new state. No repaint — the DOM is the thing that changed.
    this.bag.listen(this.root, 'toggle', () => {
      const props = this.current;
      if (props !== null) props.ctx.view(props.node.key).open = this.root.open;
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.title, next.node.props.children, openState(next)];
  }

  protected paint(next: GenUiProps): void {
    this.current = next;
    this.summary.textContent = asString(next.node.props.title);
    this.root.open = openState(next);
    renderChildren(this.body, asNodes(next.node.props.children), next.ctx);
  }
}

function openState(next: GenUiProps): boolean {
  const stored = next.ctx.view(next.node.key).open;
  return typeof stored === 'boolean' ? stored : asBoolean(next.node.props.open, false);
}

class DividerComponent extends GenUiComponent {
  protected readDeps(): readonly unknown[] {
    return [];
  }

  protected paint(): void {
    this.el.replaceChildren(el('hr', { class: `${BLOCK}__divider` }));
  }
}

export const LAYOUT_RENDERERS: Readonly<Record<string, GenUiFactory>> = {
  Card: (host) => new CardComponent(host),
  Row: (host) => new RowComponent(host),
  Stack: (host) => new StackComponent(host),
  Grid: (host) => new GridComponent(host),
  Tabs: (host) => new TabsComponent(host),
  Details: (host) => new DetailsComponent(host),
  Divider: (host) => new DividerComponent(host),
};
