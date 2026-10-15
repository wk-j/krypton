// Spec 302 §2.1 — `Card`.
//
// The head + meta + body + action box the harness builds nine different ways:
// the HTML artifact card (`harness-tool-render.ts:691-724`), the Review Board
// card (`:729-770`), the svg/mermaid fence card (`harness-svg-fence.ts:287-317`
// and the live card at `:525-542`), the usage rollup card
// (`harness-transcript-render.ts:125-249`), the attention-triage judgement card
// (`attention-overlay.ts:59-135`), the lane peek header (`lane-peek.ts:549-567`)
// and the subagent card (`harness-subagents.ts:360-406`).
//
// `block` is a PROP, so the component owns no block of its own — with one
// exception. `renderReviewCardBody` paints into `acp-harness__artifact-head`
// today, which means restyling the artifact card silently restyles the Review
// Board card. That collision is resolved here: the review card asks for
// `acp-harness__review-card` and this directory ships its own sheet for it
// (`review-card.css`, the artifact head family copied verbatim). The artifact
// card keeps `acp-harness__artifact` and its existing rules.
//
// Two shapes, because the fence card is genuinely a different arrangement of
// the same parts rather than the same arrangement with different strings:
//
//   variant 'head' (default)      variant 'bar'
//   ├── ${block}-head             ├── ${block}-bar
//   │   ├── ${block}-hint         │   ├── ${block}-kind      ← head.title
//   │   ├── ${block}-glyph        │   ├── ${block}-hint
//   │   ├── ${block}-title        │   ├── ${block}-meta
//   │   └── toolbar buttons       │   └── toolbar buttons
//   ├── ${block}-meta             ├── ${block}-preview → body
//   ├── body                      └── ${block}-action
//   └── ${block}-action
//
// `hint` follows one rule in both shapes: the span exists when the prop is a
// string and carries `hidden` when that string is empty — which is exactly the
// fence card's always-present-but-hidden hint (`harness-svg-fence.ts:297-299`)
// and, with `undefined`, the artifact card's "no hint label, no span".

import './review-card.css';

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { ActionButton, type ActionButtonProps } from '../action-button';
import type { ComponentDef } from '../types';

export interface CardHead {
  readonly glyph?: string;
  readonly hint?: string;
  readonly title: string;
  readonly meta?: string;
  readonly toolbar?: readonly ActionButtonProps[];
}

export type CardVariant = 'head' | 'bar';

export interface CardProps {
  readonly head: CardHead;
  /** Owned by the caller: the card mounts it, and never writes into it. */
  readonly body?: Node;
  readonly action?: string;
  /** The BEM block the caller owns, e.g. `acp-harness__artifact`. */
  readonly block: string;
  /** Extra full class names, already namespaced by the caller. */
  readonly modifiers?: readonly string[];
  readonly variant?: CardVariant;
}

export interface CardOptions {
  /** Tag of the root the card creates. The fence card is a `<figure>`. */
  readonly tag?: keyof HTMLElementTagNameMap;
  /**
   * Paint into a node the caller already owns instead of creating one. The
   * artifact and review cards have no wrapper of their own today — they paint
   * straight into `.acp-harness__msg-body` — so a hosted card leaves the host's
   * classes alone and contributes only `modifiers`.
   */
  readonly host?: HTMLElement;
}

export class Card extends Component<CardProps> {
  /** '' when the card owns its root, so `block` classes it instead. */
  private readonly hostClass: string | null;
  private readonly toolbar: ActionButton[] = [];
  private headEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private glyphEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private metaEl: HTMLElement | null = null;
  private actionEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;

  constructor(opts: CardOptions = {}) {
    super(opts.host ?? el(opts.tag ?? 'div'));
    this.hostClass = opts.host ? opts.host.className : null;
  }

  protected readDeps(next: CardProps): readonly unknown[] {
    return [
      next.block,
      next.variant,
      next.head.hint,
      next.head.glyph,
      next.head.title,
      next.head.meta,
      next.head.toolbar,
      next.body,
      next.action,
      next.modifiers?.join(' '),
    ];
  }

  protected syncClasses(next: CardProps): void {
    this.el.className = classes(this.hostClass ?? next.block, next.modifiers ?? null);
  }

  protected paint(next: CardProps): void {
    this.syncClasses(next);
    const block = next.block;
    const bar = next.variant === 'bar';

    const head = this.headEl ?? el('div');
    head.className = bar ? `${block}-bar` : `${block}-head`;
    this.headEl = head;

    const title = this.titleEl ?? el('span');
    title.className = bar ? `${block}-kind` : `${block}-title`;
    title.textContent = next.head.title;
    this.titleEl = title;

    const hint = this.syncHint(next.head.hint, block);
    const glyph = this.syncGlyph(next.head.glyph, block);
    const meta = this.syncMeta(next.head.meta, block, bar);
    const action = this.syncAction(next.action, block);
    const buttons = this.syncToolbar(next.head.toolbar);

    head.replaceChildren(...(bar ? [title, hint, meta, ...buttons] : [hint, glyph, title, ...buttons]).filter(isNode));

    if (bar) {
      const preview = this.previewEl ?? el('div');
      preview.className = `${block}-preview`;
      this.previewEl = preview;
      if (next.body) preview.replaceChildren(next.body);
      else preview.replaceChildren();
      this.el.replaceChildren(...[head, preview, action].filter(isNode));
      return;
    }
    this.el.replaceChildren(...[head, meta, next.body, action].filter(isNode));
  }

  private syncHint(hint: string | undefined, block: string): HTMLElement | null {
    if (hint === undefined) {
      this.hintEl = null;
      return null;
    }
    const node = this.hintEl ?? el('span');
    node.className = `${block}-hint`;
    node.textContent = hint;
    // The fence card ships a hint span before it has a label to put in it.
    setAttr(node, 'hidden', hint === '');
    this.hintEl = node;
    return node;
  }

  private syncGlyph(glyph: string | undefined, block: string): HTMLElement | null {
    if (glyph === undefined) {
      this.glyphEl = null;
      return null;
    }
    const node = this.glyphEl ?? el('span');
    node.className = `${block}-glyph`;
    node.textContent = glyph;
    this.glyphEl = node;
    return node;
  }

  /** A row under the head, or a cell in the bar — same block, same text. */
  private syncMeta(meta: string | undefined, block: string, bar: boolean): HTMLElement | null {
    if (meta === undefined) {
      this.metaEl = null;
      return null;
    }
    const node = this.metaEl ?? el(bar ? 'span' : 'div');
    node.className = `${block}-meta`;
    node.textContent = meta;
    this.metaEl = node;
    return node;
  }

  private syncAction(action: string | undefined, block: string): HTMLElement | null {
    if (action === undefined) {
      this.actionEl = null;
      return null;
    }
    const node = this.actionEl ?? el('div');
    node.className = `${block}-action`;
    node.textContent = action;
    this.actionEl = node;
    return node;
  }

  /** Buttons are components: constructed once per slot, updated in place, and
   *  disposed — with their listeners — when the toolbar shrinks. */
  private syncToolbar(toolbar: readonly ActionButtonProps[] | undefined): HTMLElement[] {
    const wanted = toolbar ?? [];
    for (const extra of this.toolbar.splice(wanted.length)) extra.dispose();
    const nodes: HTMLElement[] = [];
    for (let i = 0; i < wanted.length; i++) {
      const button = this.toolbar[i] ?? new ActionButton();
      this.toolbar[i] = button;
      button.update(wanted[i]);
      nodes.push(button.el);
    }
    return nodes;
  }

  protected onDispose(): void {
    for (const button of this.toolbar) button.dispose();
    this.toolbar.length = 0;
  }
}

/** Generic so `Array.filter` narrows `(HTMLElement | null)[]` to `HTMLElement[]`
 *  rather than falling back to the boolean overload. */
function isNode<T extends Node>(child: T | null | undefined): child is T {
  return child != null;
}

export const def: ComponentDef = { id: 'card', blocks: ['acp-harness__review-card'] };
