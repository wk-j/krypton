// Spec 302 §6.8 — `DecisionComposer`.
//
// `perm   a accept · A all · r reject · R all` — the composer while a
// permission request or a question owns the keyboard. Built today by
// `renderDecisionComposer` (`acp-harness-view.ts:13329-13339`), which also
// emits the live-voice strip above this row; that strip is its own component
// and the composer root places it, so this one is the decision row alone.
//
// The hint run IS a `KeyHintBar` (`bare` layout, ` · ` separator): every key
// is a `<kbd>` cap (spec 369). The block it paints into is the caller's
// (`.acp-harness__permission-options`). Every caller passes structured hints:
// the fixed permission and remote-command runs, and the question run that
// `questionActionsHint()` builds from its conditional parts.
//
// The row's label reuses `.acp-harness__composer-meta`, which `composer-meta`
// owns — including the `--permission` context rules that style it here. This
// directory declares only the two blocks it is the sole emitter of.

import './decision-composer.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { keyHintsSignature, type KeyHint } from '../../../ui/kbd';
import { KeyHintBar } from '../key-hint-bar';
import type { ComponentDef } from '../types';

export interface DecisionComposerProps {
  /** `perm` / `ask`. */
  readonly label: string;
  readonly hint: readonly KeyHint[];
}

export class DecisionComposer extends Component<DecisionComposerProps> {
  private readonly labelEl: HTMLElement;
  private readonly hints = new KeyHintBar('div');

  constructor() {
    super(el('div', { class: 'acp-harness__permission-row' }));
    this.labelEl = el('div', { class: 'acp-harness__composer-meta' });
    this.el.append(this.labelEl, this.hints.el);
  }

  protected readDeps(next: DecisionComposerProps): readonly unknown[] {
    return [next.label, keyHintsSignature(next.hint)];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__permission-row';
    this.labelEl.className = 'acp-harness__composer-meta';
  }

  protected paint(next: DecisionComposerProps): void {
    this.syncClasses();
    this.labelEl.textContent = next.label;
    this.hints.update({
      hints: next.hint,
      layout: 'bare',
      separator: ' · ',
      block: 'acp-harness__permission-options',
    });
  }

  protected onDispose(): void {
    this.hints.dispose();
  }
}

export const def: ComponentDef = {
  id: 'decision-composer',
  blocks: ['acp-harness__permission-row', 'acp-harness__permission-options'],
};
