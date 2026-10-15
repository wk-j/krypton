// Spec 302 §2.2 — `OverlayShell`.
//
// Twelve summon-on-demand surfaces each build the same four things by hand: a
// hidden `<aside>`, a panel, a `header` carrying a title and a subtitle, and a
// key-hint foot. They also each remember, by hand, to close the other overlays
// — `helpOpen = false; memoryDrawerOpen = false;` is copied at seven sites
// (`acp-harness-view.ts:5083,5263,5544,9903,10016,10153,10199`), one per author
// who happened to think of it.
//
// This component owns the `hidden` toggle, the body swap, and a module-level
// registry that holds the single open shell. Opening one closes the rest; the
// closed shell's owner hears about it through `onAutoClose` so its own boolean
// stays in step. The component never learns WHICH key opened it (CLAUDE.md
// constraint 1) — `open` is a prop, like any other piece of render state.
//
// The twelve shells do NOT agree on their markup, and this component does not
// pretend they do: the review/priority pair is `__panel > __head > __title +
// __sub`, while the five inline pickers use single-dash element names
// (`acp-harness__picker-head`), three of them have no panel wrapper at all and
// are styled through `>` child combinators, and the ticket head carries its
// title as a bare text node. `parts` names every one of those differences
// explicitly rather than hiding them behind a class-name convention that only
// two call sites follow.
//
// It owns no block: `block` is a prop, so each overlay keeps its own classes
// and its own sheet.

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { KeyHintBar, type KeyHintBarProps } from '../key-hint-bar';
import type { ComponentDef } from '../types';

/**
 * The open shell, or none. A `Set` rather than a single slot so a shell that is
 * disposed while open cannot leave a dangling "currently open" reference that
 * the next opener would try to close.
 */
const openShells = new Set<OverlayShell>();

/**
 * Per-node class overrides. Absent — every node takes its `block`-derived BEM
 * class. `null` means something different for each node and is spelled out
 * below; it never means "use the default".
 */
export interface OverlayShellParts {
  /**
   * `null` emits **no panel wrapper**: head, body, extras and foot become
   * direct children of the root, which is what the directive, model and
   * session pickers need — their rules are `>` child combinators on the
   * overlay root (`acp-harness.css:6258-6260,6438-6439,6568-6571`).
   */
  readonly panel?: string | null;
  readonly head?: string;
  /** `null` emits the title span with no class attribute at all. */
  readonly title?: string | null;
  /** `null` emits the sub span with no class attribute at all. */
  readonly sub?: string | null;
  readonly empty?: string;
  /**
   * The title is a bare text node inside the head, with no span around it —
   * `acp-ticket__head` (`harness-ticket-controller.ts:752`). `title` is then
   * unused, and the sub span still follows the text.
   */
  readonly titleAsText?: boolean;
}

export interface OverlayShellProps {
  readonly open: boolean;
  /** Root class `acp-harness__${name}-overlay`, e.g. `review`. */
  readonly name?: string;
  /**
   * The root's full class, replacing the `name`-derived one. The picker roots
   * are `acp-harness__picker`, `…__directive-picker`, `…__model-picker`,
   * `…__session-picker` and `remote-harness-picker` — none of which the
   * `-overlay` suffix reaches. Supply this or `name`; neither leaves the root
   * unclassed, as `KeyHintBar` does for `block: ''`.
   */
  readonly rootClass?: string;
  /** Panel/head/title/sub/empty prefix, e.g. `acp-review`. */
  readonly block: string;
  readonly title: string;
  readonly sub?: string;
  /**
   * A caller-owned node between the title and the sub line.
   *
   * The orchestrator console's head is three parts — title, the cyan seat
   * pill, then the summary — and folding the seat into `sub` turned the pill
   * into dim subtitle text. Spec 301 promises no visual change, so the shell
   * carries the third node rather than the caller losing it.
   */
  readonly headExtra?: Node;
  /** The panel's middle. Built and owned by the caller. */
  readonly body: Node;
  /**
   * Siblings appended after the body and before the foot — the session
   * picker's `__empty` + `__error` notes and the directive picker's preview
   * pane, which are siblings of the list today and would lose their `>`
   * selectors inside a wrapper.
   */
  readonly extras?: readonly Node[];
  /** The foot. `KeyHintBar`'s root IS `.${block}__foot`, so nothing wraps it. */
  readonly hints?: KeyHintBarProps;
  /**
   * Empty-state text. When set it replaces `body` AND drops the foot, which is
   * what both overlay shells do today (`acp-harness-view.ts:5320-5325`,
   * `review-priority-overlay.ts:89-95` both return before appending the foot).
   */
  readonly empty?: string;
  readonly parts?: OverlayShellParts;
  /**
   * Attributes on the root `<aside>`, e.g. the remote picker's `role="dialog"`
   * and `tabindex="0"`. `undefined` removes one, and an attribute that drops
   * out of the record between paints is removed from the node.
   */
  readonly rootAttrs?: Readonly<Record<string, string | undefined>>;
  /**
   * Attributes on the panel — the ticket dialog is
   * `role="dialog" aria-modal="true" aria-label="Working ticket"`
   * (`harness-ticket-controller.ts:96-98`). Same removal semantics.
   */
  readonly panelAttrs?: Readonly<Record<string, string | undefined>>;
  /**
   * Called when another shell opened and this one was closed for it. The owner
   * uses it to clear its own `…Open` flag; it is a notification, never a
   * decision — the component still has no idea which key opens it.
   */
  onAutoClose?(): void;
}

export class OverlayShell extends Component<OverlayShellProps> {
  private readonly panel: HTMLElement;
  private readonly head: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly hintBar = new KeyHintBar();
  private titleTextNode: Text | null = null;
  private emptyEl: HTMLElement | null = null;
  private placed: readonly Node[] = [];
  private appliedRootAttrs: readonly string[] = [];
  private appliedPanelAttrs: readonly string[] = [];
  private autoClose: (() => void) | undefined;

  constructor() {
    super(el('aside'));
    this.titleEl = el('span');
    this.subEl = el('span');
    this.head = el('header', { children: [this.titleEl] });
    this.panel = el('div', { children: [this.head] });
    this.el.hidden = true;
    this.el.appendChild(this.panel);
  }

  /** True while this shell holds the single open slot. */
  get isOpen(): boolean {
    return openShells.has(this);
  }

  protected readDeps(next: OverlayShellProps): readonly unknown[] {
    return [
      next.open,
      next.name,
      next.rootClass,
      next.block,
      next.title,
      next.sub,
      next.headExtra,
      next.body,
      next.extras,
      next.extras?.length,
      next.hints,
      next.empty,
      next.parts?.panel,
      next.parts?.head,
      next.parts?.title,
      next.parts?.sub,
      next.parts?.empty,
      next.parts?.titleAsText,
      next.rootAttrs && Object.entries(next.rootAttrs).flat().join('\u0000'),
      next.panelAttrs && Object.entries(next.panelAttrs).flat().join('\u0000'),
    ];
  }

  protected syncClasses(next: OverlayShellProps): void {
    const parts = next.parts;
    const root = next.rootClass ?? (next.name === undefined ? '' : `acp-harness__${next.name}-overlay`);
    if (root) this.el.className = root;
    else this.el.removeAttribute('class');

    const panelClass = parts?.panel === undefined ? `${next.block}__panel` : parts.panel;
    if (panelClass === null) this.panel.removeAttribute('class');
    else this.panel.className = panelClass;

    this.head.className = parts?.head ?? `${next.block}__head`;

    const titleClass = parts?.title === undefined ? `${next.block}__title` : parts.title;
    if (titleClass === null) this.titleEl.removeAttribute('class');
    else this.titleEl.className = titleClass;

    const subClass = parts?.sub === undefined ? `${next.block}__sub` : parts.sub;
    if (subClass === null) this.subEl.removeAttribute('class');
    else this.subEl.className = subClass;

    if (this.emptyEl !== null) this.emptyEl.className = parts?.empty ?? `${next.block}__empty`;
  }

  protected paint(next: OverlayShellProps): void {
    this.autoClose = next.onAutoClose;
    this.syncClasses(next);
    this.appliedRootAttrs = this.applyAttrs(this.el, next.rootAttrs, this.appliedRootAttrs);
    this.appliedPanelAttrs = this.applyAttrs(this.panel, next.panelAttrs, this.appliedPanelAttrs);
    this.el.hidden = !next.open;
    if (next.open) {
      if (!openShells.has(this)) {
        for (const other of [...openShells]) other.closeForOther();
        openShells.add(this);
      }
    } else {
      openShells.delete(this);
    }

    // Head: [title, sub?], where the title is a span or a bare text node.
    let titleNode: Node;
    if (next.parts?.titleAsText === true) {
      if (this.titleTextNode === null) this.titleTextNode = document.createTextNode('');
      this.titleTextNode.data = next.title;
      titleNode = this.titleTextNode;
    } else {
      this.titleEl.textContent = next.title;
      titleNode = this.titleEl;
    }
    const headChildren: Node[] = [titleNode];
    if (next.headExtra) headChildren.push(next.headExtra);
    if (next.sub !== undefined) {
      this.subEl.textContent = next.sub;
      headChildren.push(this.subEl);
    }
    this.place(this.head, headChildren);

    let middle: Node;
    if (next.empty === undefined) {
      middle = next.body;
    } else {
      if (this.emptyEl === null) this.emptyEl = el('div');
      this.emptyEl.className = next.parts?.empty ?? `${next.block}__empty`;
      this.emptyEl.textContent = next.empty;
      middle = this.emptyEl;
    }

    let foot: HTMLElement | null = null;
    if (next.hints !== undefined && next.empty === undefined) {
      this.hintBar.update(next.hints);
      foot = this.hintBar.el;
    }

    const container = next.parts?.panel === null ? this.el : this.panel;
    const middles: readonly Node[] = next.empty === undefined && next.extras !== undefined
      ? [middle, ...next.extras]
      : [middle];
    // Drop the nodes this shell placed last time before reordering, so a body
    // swap never shuffles the head or the foot to reach a stale sibling.
    for (const stale of this.placed) {
      if (!middles.includes(stale) && stale.parentNode === container) container.removeChild(stale);
    }
    this.placed = middles;

    const children: Node[] = [this.head, ...middles];
    if (foot !== null) children.push(foot);
    if (container === this.panel) this.place(this.el, [this.panel]);
    this.place(container, children);
  }

  /**
   * Make `children` the exact children of `parent`, in order, moving as few
   * nodes as possible and removing the rest — `syncOrder` from the reconciler,
   * whose signature is narrowed to the `HTMLElement` rows a list holds, while
   * a caller's body and extras are plain `Node`s.
   */
  private place(parent: Node, children: readonly Node[]): void {
    let cursor: ChildNode | null = parent.firstChild;
    for (const child of children) {
      if (cursor === child) {
        cursor = child.nextSibling;
        continue;
      }
      parent.insertBefore(child, cursor);
    }
    while (cursor !== null) {
      const after: ChildNode | null = cursor.nextSibling;
      cursor.remove();
      cursor = after;
    }
  }

  /** Write `attrs`, dropping every attribute the last paint wrote and this one did not. */
  private applyAttrs(
    node: HTMLElement,
    attrs: Readonly<Record<string, string | undefined>> | undefined,
    applied: readonly string[],
  ): readonly string[] {
    for (const name of applied) {
      if (attrs === undefined || attrs[name] === undefined) node.removeAttribute(name);
    }
    if (attrs === undefined) return [];
    const written: string[] = [];
    for (const [name, value] of Object.entries(attrs)) {
      if (value === undefined) continue;
      setAttr(node, name, value);
      written.push(name);
    }
    return written;
  }

  /** Another shell took the open slot. Hide, and tell the owner. */
  private closeForOther(): void {
    if (!openShells.delete(this)) return;
    this.el.hidden = true;
    // The props still say `open: true`; without this the owner's next update
    // would compare equal and never repaint the shell back into view.
    this.invalidateDeps();
    this.autoClose?.();
  }

  protected onDispose(): void {
    openShells.delete(this);
    this.hintBar.dispose();
  }
}

export const def: ComponentDef = { id: 'overlay-shell', blocks: [] };
