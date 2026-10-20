// Spec 302 §1.6 — `ActionButton`.
//
// The labelled button with an optional key hint: the ticket picker's four
// actions, the SVG card's Source/Copy toolbar, the annotation rail's send/del,
// the review-thread picker's confirm/cancel and the remote picker rows.
// It owns no block — `block` is a prop.
//
// The disabled prop writes the real attribute, which is what delegated click
// handlers read. Selection markers belong in data, not in disabled state.
//
// `title` carries `disabledReason` only while the button is disabled, so
// re-enabling cannot leave a stale "why is this greyed out" tooltip behind.

import { Component } from '../../../ui/component';
import { classes, el, setAttr, setChildren } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export interface ActionButtonProps {
  /** The BEM block the caller owns, e.g. `acp-ticket__action`. `''` for the
   *  unclassed buttons of the review-thread picker. */
  readonly block: string;
  readonly label: string;
  /** Rendered as `<span class="${block}-key">`; omitted entirely when absent. */
  readonly keyHint?: string;
  /** A full extra class name, already namespaced, e.g. `acp-ticket__action--fix`. */
  readonly modifier?: string;
  readonly disabled?: boolean;
  /** Shown as `title` while `disabled` is true. */
  readonly disabledReason?: string;
  /** Attribute suffixes: `{ 'ticket-action': 'set-ticket' }` → `data-ticket-action`. */
  readonly data?: Readonly<Record<string, string>>;
  /** `submit` only for the timeline capture footer, which posts its form. */
  readonly type?: 'button' | 'submit';
  /** `-1` keeps a toolbar button out of the tab order (the SVG fence card):
   *  the harness is keyboard-first and focus belongs to the composer. */
  readonly tabIndex?: number;
  readonly onClick?: (ev: MouseEvent) => void;
}

/** Stable text for the deps tuple; `data` is rebuilt per pass by every caller. */
function dataSignature(data: Readonly<Record<string, string>> | undefined): string {
  if (!data) return '';
  let out = '';
  for (const [key, value] of Object.entries(data)) out += `${key}=${value}\u001f`;
  return out;
}

export class ActionButton extends Component<ActionButtonProps> {
  private handler: ((ev: MouseEvent) => void) | null = null;
  private dataKeys: readonly string[] = [];

  constructor() {
    super(el('button', { attrs: { type: 'button' } }));
    // ONE listener for the component's whole life; `paint()` never touches it.
    this.bag.listen(this.el, 'click', (ev: Event) => {
      this.handler?.(ev as MouseEvent);
    });
  }

  /**
   * `onClick` is the one prop that is NOT a dependency: call sites build a
   * fresh closure per pass (`() => choose(index)`), so putting it in the tuple
   * would force a repaint on every update. Retarget the single listener
   * instead, which also keeps the handler from going stale when the deps hold.
   */
  update(next: ActionButtonProps): void {
    this.handler = next.onClick ?? null;
    super.update(next);
  }

  protected readDeps(next: ActionButtonProps): readonly unknown[] {
    const disabled = next.disabled === true;
    return [
      next.block,
      next.label,
      next.keyHint,
      next.modifier,
      disabled,
      disabled ? next.disabledReason : undefined,
      next.type ?? 'button',
      next.tabIndex,
      dataSignature(next.data),
    ];
  }

  protected syncClasses(next: ActionButtonProps): void {
    const className = classes(next.block, next.modifier);
    if (className) this.el.className = className;
    else this.el.removeAttribute('class');
  }

  protected paint(next: ActionButtonProps): void {
    this.syncClasses(next);
    const disabled = next.disabled === true;
    setAttr(this.el, 'type', next.type ?? 'button');
    setAttr(this.el, 'tabindex', next.tabIndex);
    setAttr(this.el, 'disabled', disabled);
    setAttr(this.el, 'title', disabled ? next.disabledReason : undefined);
    this.syncData(next.data);
    const key = next.keyHint ? el('span', { class: `${next.block}-key`, text: next.keyHint }) : null;
    setChildren(this.el, [key, key ? ` ${next.label}` : next.label]);
  }

  /** Writes the current `data-*` set and drops the keys that fell out of it. */
  private syncData(data: Readonly<Record<string, string>> | undefined): void {
    for (const key of this.dataKeys) {
      if (!data || !(key in data)) this.el.removeAttribute(`data-${key}`);
    }
    const keys: string[] = [];
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        setAttr(this.el, `data-${key}`, value);
        keys.push(key);
      }
    }
    this.dataKeys = keys;
  }
}

export const def: ComponentDef = { id: 'action-button', blocks: [] };
