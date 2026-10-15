// Spec 302 §6.6 — `DictationControl`.
//
// Two surfaces come out of `harness-dictation-controller.ts:37-82`, and both
// are here because they are one feature:
//
//   * `DictationControl` — the `[● REC th ⌘D]` button in the composer tools
//     (`renderControl`, :54-81), phases `MIC · MIC en · REC th · FINALIZING…`;
//   * `DictationPreview` — the composer input while the microphone is open
//     (`renderInput`, :37-52): the draft split around the insertion point with
//     the final and interim spans between, then the `Caret`.
//
// `patchComposer()` (:83-113) goes away with them: it exists only because the
// composer rebuilds its `innerHTML`, so the controller had to re-find its own
// nodes by `data-dictation-*` selector and write them back. Both components own
// their nodes for life, so a speech result is `update()` and nothing else. The
// `data-dictation-*` attributes stay in the markup — the view's delegated click
// handler (`acp-harness-view.ts:6561`) still matches them until the composer
// root hands `onToggle` in instead.
//
// `DictationPreview` paints into a `.acp-harness__input` of its own, the same
// node `DraftLine` paints the typed draft into: the composer input is one or
// the other, never both, and swapping the whole span is what makes the mode
// change structural instead of two owners writing one node. The block belongs
// to `draft-line`, which is why no rule for it is declared here.

import './dictation-control.css';

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { Caret } from '../caret';
import type { DictationPhase, DictationPreviewParts } from '../../harness-dictation';
import type { ComponentDef } from '../types';

export interface DictationControlProps {
  /** `idle` whenever the session is not this lane's (`renderControl`'s rule). */
  readonly phase: DictationPhase;
  /** The session belongs to this lane: aria + the one-key hint. */
  readonly active: boolean;
  /** `dictationLanguageLabel(session.lang)` — `en` / `th`. */
  readonly language: string;
  /** Click on the button. Not a dependency. */
  readonly onToggle?: () => void;
}

function labelFor(props: DictationControlProps): string {
  if (props.phase === 'starting') return `MIC ${props.language}`;
  if (props.phase === 'listening') return `REC ${props.language}`;
  if (props.phase === 'stopping') return 'FINALIZING…';
  return 'MIC';
}

export class DictationControl extends Component<DictationControlProps> {
  private readonly labelEl: HTMLElement;
  private readonly shiftKeyEl: HTMLElement;
  private toggle: (() => void) | undefined;

  constructor() {
    super(el('button', {
      class: 'acp-harness__dictation',
      attrs: { type: 'button', 'data-dictation-toggle': true },
    }));
    this.labelEl = el('span', { attrs: { 'data-dictation-label': true, 'aria-live': 'polite' } });
    this.shiftKeyEl = el('span', { class: 'acp-harness__dictation-key', text: '⇧D' });
    this.el.append(
      el('span', { class: 'acp-harness__dictation-dot', attrs: { 'aria-hidden': 'true' }, text: '●' }),
      this.labelEl,
      el('span', { class: 'acp-harness__dictation-key', text: '⌘D' }),
    );
    // ONE listener, attached once; `update()` retargets it so a fresh closure
    // per pass costs no repaint and never goes stale.
    this.bag.listen(this.el, 'click', (event: Event): void => {
      if (!this.toggle) return;
      event.preventDefault();
      this.toggle();
    });
  }

  update(next: DictationControlProps): void {
    this.toggle = next.onToggle;
    super.update(next);
  }

  protected readDeps(next: DictationControlProps): readonly unknown[] {
    return [next.phase, next.active, next.language];
  }

  protected syncClasses(next: DictationControlProps): void {
    this.el.className = classes('acp-harness__dictation', `acp-harness__dictation--${next.phase}`);
  }

  protected paint(next: DictationControlProps): void {
    this.syncClasses(next);
    setAttr(this.el, 'aria-label', next.active ? 'Stop dictation' : 'Start English dictation');
    setAttr(this.el, 'aria-pressed', String(next.active));
    setAttr(
      this.el,
      'title',
      next.active ? 'Stop dictation (Cmd+D)' : 'English: Cmd+D · Thai: Cmd+Shift+D',
    );
    this.labelEl.textContent = labelFor(next);
    // A running session has one chord left (stop); an idle one advertises both
    // languages.
    if (next.active) this.shiftKeyEl.remove();
    else this.el.appendChild(this.shiftKeyEl);
  }
}

/** The composer input while dictation is open. Its root IS the input span. */
export class DictationPreview extends Component<DictationPreviewParts> {
  private readonly beforeNode = document.createTextNode('');
  private readonly afterNode = document.createTextNode('');
  private readonly leadingEl: HTMLElement;
  private readonly finalEl: HTMLElement;
  private readonly interimEl: HTMLElement;
  private readonly trailingEl: HTMLElement;
  private readonly caret = new Caret();

  constructor() {
    super(el('span', { class: 'acp-harness__input' }));
    this.leadingEl = el('span', { attrs: { 'data-dictation-leading': true } });
    this.finalEl = el('span', {
      class: 'acp-harness__dictation-final',
      attrs: { 'data-dictation-final': true },
    });
    this.interimEl = el('span', {
      class: 'acp-harness__dictation-interim',
      attrs: { 'data-dictation-interim': true },
    });
    this.trailingEl = el('span', { attrs: { 'data-dictation-trailing': true } });
    this.caret.update({});
    this.el.append(
      this.beforeNode,
      this.leadingEl,
      this.finalEl,
      this.interimEl,
      this.trailingEl,
      this.caret.el,
      this.afterNode,
    );
  }

  protected readDeps(next: DictationPreviewParts): readonly unknown[] {
    return [next.before, next.leading, next.finalText, next.interimText, next.trailing, next.after];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__input';
  }

  protected paint(next: DictationPreviewParts): void {
    this.syncClasses();
    this.beforeNode.data = next.before;
    this.leadingEl.textContent = next.leading;
    this.finalEl.textContent = next.finalText;
    this.interimEl.textContent = next.interimText;
    this.trailingEl.textContent = next.trailing;
    this.afterNode.data = next.after;
  }

  protected onDispose(): void {
    this.caret.dispose();
  }
}

export const def: ComponentDef = {
  id: 'dictation-control',
  blocks: ['acp-harness__dictation'],
};
