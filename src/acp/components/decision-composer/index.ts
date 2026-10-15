// Spec 302 §6.8 — `DecisionComposer`.
//
// `perm   a accept · A all · r reject · R all` — the composer while a
// permission request or a question owns the keyboard. Built today by
// `renderDecisionComposer` (`acp-harness-view.ts:13329-13339`), which also
// emits the live-voice strip above this row; that strip is its own component
// and the composer root places it, so this one is the decision row alone.
//
// The hint run IS a `KeyHintBar` (`plain` style, `bare` layout, ` · `
// separator): the block it paints into is the caller's, so
// `.acp-harness__permission-options` comes out character-identical. The props
// take the run EITHER as structured hints or as a ready string, because the two
// call sites differ: the permission hint is a fixed four-key run and can be
// described, while the question hint arrives pre-joined from
// `questionActionsHint()` with its own conditional parts.
//
// The row's label reuses `.acp-harness__composer-meta`, which `composer-meta`
// owns — including the `--permission` context rules that style it here. This
// directory declares only the two blocks it is the sole emitter of.

import './decision-composer.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { KeyHintBar, type KeyHint } from '../key-hint-bar';
import type { ComponentDef } from '../types';

export interface DecisionComposerProps {
  /** `perm` / `ask`. */
  readonly label: string;
  readonly hint: string | readonly KeyHint[];
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
    return [
      next.label,
      typeof next.hint === 'string'
        ? next.hint
        : next.hint.map((hint) => `${hint.keys.join('\u0000')}\u0001${hint.label}`).join('\u0002'),
    ];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__permission-row';
    this.labelEl.className = 'acp-harness__composer-meta';
  }

  protected paint(next: DecisionComposerProps): void {
    this.syncClasses();
    this.labelEl.textContent = next.label;
    this.hints.update({
      hints: typeof next.hint === 'string' ? [{ keys: [], label: next.hint }] : next.hint,
      style: 'plain',
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
