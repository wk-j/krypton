// Spec 302 §1.9 — `Caret`.
//
// The text cursor three unrelated surfaces emit today — the composer draft
// line (`acp-harness-view.ts:13257`), the dictation preview
// (`harness-dictation-controller.ts:50`) and the ticket picker's filter
// (`harness-ticket-controller.ts:758`) — and a fourth queries:
// `harness-composer-bloom.ts:156,176` locates the caret with
// `querySelector('.acp-harness__caret')` and walks the input's child nodes up
// to it, so the caret must stay a direct `<span class="acp-harness__caret">`
// child of the input with the text before it in sibling text nodes.
//
// ⚠ The attention overlay forked the rule into `acp-triage__caret`
// (`attention-overlay.ts:120`, `attention-triage.css:276-278`) to narrow the
// glyph. The underline has no glyph to narrow, so the fork is gone and the one
// declaration it actually changed (the window-accent colour) survives as a
// context rule in caret.css.
//
// The cursor is an UNDERLINE drawn by CSS, never a typed glyph. It was a `█`
// (U+2588) text node, which fails twice: a configured font that lacks block
// elements (e.g. `Share Tech Mono`) sends that one character to a fallback
// font (measured at 16px: cell 8.64px, `█` 9.92px wide and 20.1px tall against
// a 19.2px line box), and a cursor that occupies a cell splits the word it
// sits in — with the spec-285 ghost, `pend` + caret + `ing` read as two
// fragments. The underline host is zero-width and its bar overlays the
// following cell, so the draft keeps the character grid it has with no caret.

import './caret.css';

import { Component } from '../../../ui/component';
import { classes, el } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export interface CaretProps {
  /** Default true. False pins the caret solid by adding the `--static` modifier. */
  readonly blink?: boolean;
}

export class Caret extends Component<CaretProps> {
  constructor() {
    super(el('span'));
  }

  protected readDeps(next: CaretProps): readonly unknown[] {
    return [next.blink !== false];
  }

  protected syncClasses(next: CaretProps): void {
    this.el.className = classes(
      'acp-harness__caret',
      next.blink === false ? 'acp-harness__caret--static' : null,
    );
  }

  protected paint(next: CaretProps): void {
    this.syncClasses(next);
  }
}

export const def: ComponentDef = { id: 'caret', blocks: ['acp-harness__caret'] };
