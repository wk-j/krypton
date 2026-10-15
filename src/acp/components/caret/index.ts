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
// ⚠ The attention overlay wanted a half-block glyph and forked the rule into
// `acp-triage__caret` (`attention-overlay.ts:120`, `attention-triage.css:276-278`).
// That fork is the `glyph` prop, and the one declaration the fork actually
// changed (the window-accent colour) survives as a context rule in caret.css.

import './caret.css';

import { Component } from '../../../ui/component';
import { classes, el } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export type CaretGlyph = '█' | '▋';

const DEFAULT_GLYPH: CaretGlyph = '█';

export interface CaretProps {
  /** Full block (composer, dictation, ticket filter) or half block (triage redirect). */
  readonly glyph?: CaretGlyph;
  /** Default true. False pins the caret solid by adding the `--static` modifier. */
  readonly blink?: boolean;
}

export class Caret extends Component<CaretProps> {
  constructor() {
    super(el('span'));
  }

  protected readDeps(next: CaretProps): readonly unknown[] {
    return [next.glyph ?? DEFAULT_GLYPH, next.blink !== false];
  }

  protected syncClasses(next: CaretProps): void {
    this.el.className = classes(
      'acp-harness__caret',
      next.blink === false ? 'acp-harness__caret--static' : null,
    );
  }

  protected paint(next: CaretProps): void {
    this.syncClasses(next);
    this.el.textContent = next.glyph ?? DEFAULT_GLYPH;
  }
}

export const def: ComponentDef = { id: 'caret', blocks: ['acp-harness__caret'] };
