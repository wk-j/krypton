// Spec 302 §1.9 — `Caret`.
//
// The block cursor three unrelated surfaces emit today — the composer draft
// line (`acp-harness-view.ts:13257`), the dictation preview
// (`harness-dictation-controller.ts:50`) and the ticket picker's filter
// (`harness-ticket-controller.ts:758`) — and a fourth queries:
// `harness-composer-bloom.ts:156,176` locates the caret with
// `querySelector('.acp-harness__caret')` and walks the input's child nodes up
// to it, so the caret must stay a direct `<span class="acp-harness__caret">`
// child of the input with the text before it in sibling text nodes.
//
// ⚠ The attention overlay wanted a narrower caret and forked the rule into
// `acp-triage__caret` (`attention-overlay.ts:120`, `attention-triage.css:276-278`).
// That fork is the `half` prop, and the one declaration the fork actually
// changed (the window-accent colour) survives as a context rule in caret.css.
//
// The block is DRAWN in CSS, not typed: the caret used to be a `█` (U+2588)
// text node, and a configured font that lacks block elements (e.g. `Share Tech
// Mono`) sends just that one character to a fallback font. Measured at 16px
// with `[font] family = ["Share Tech Mono", …, "Monaspace Radon", …]`: cell
// 8.64px, `█` 9.92px wide (1.148 cells) and 20.1px tall against a 19.2px line
// box — a caret wider than its cell, pushing the rest of the draft off the
// character grid. A `1ch` box is exactly one cell in whatever font renders the
// text, and cannot fall back.

import './caret.css';

import { Component } from '../../../ui/component';
import { classes, el } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export interface CaretProps {
  /** True paints the five-eighths bar the triage redirect line asks for,
   *  inside a full cell so the text after it does not move. */
  readonly half?: boolean;
  /** Default true. False pins the caret solid by adding the `--static` modifier. */
  readonly blink?: boolean;
}

export class Caret extends Component<CaretProps> {
  constructor() {
    super(el('span'));
  }

  protected readDeps(next: CaretProps): readonly unknown[] {
    return [next.half === true, next.blink !== false];
  }

  protected syncClasses(next: CaretProps): void {
    this.el.className = classes(
      'acp-harness__caret',
      next.half === true ? 'acp-harness__caret--half' : null,
      next.blink === false ? 'acp-harness__caret--static' : null,
    );
  }

  protected paint(next: CaretProps): void {
    this.syncClasses(next);
  }
}

export const def: ComponentDef = { id: 'caret', blocks: ['acp-harness__caret'] };
