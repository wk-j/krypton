// Spec 302 §7.16 — `ReviewThreadDialog`.
//
// The keyboard-first base picker that freezes a Review Thread's snapshot
// (`acp-harness-view.ts:3110-3170`, inside `pickReviewThreadBase`). Today the
// dialog is built inline inside a `new Promise` executor, so its markup, its
// listeners and its resolution are one 120-line closure; here the markup is a
// component and the promise stays with the caller.
//
// The preview `<pre>` is the thing the human reads before Enter freezes
// exactly what it shows, so it is a prop: the caller recollects the diff when
// the base changes and hands the new text back.

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { ActionButton } from '../action-button';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './review-thread-dialog.css';

/** The two bases the dialog offers, in order, with their explanations. */
const BASES: readonly { readonly value: string; readonly label: string; readonly description: string }[] = [
  {
    value: 'upstream',
    label: 'Upstream merge-base',
    description: 'Changes since the tracked branch, including local work',
  },
  { value: 'head', label: 'HEAD', description: 'Working tree changes only' },
];

export interface ReviewThreadDialogProps {
  readonly open: boolean;
  /** `upstream` | `head` — whichever radio is checked. */
  readonly base: string;
  /** Collected preview, or the Thai progress line while it is being gathered. */
  readonly preview: string;
  /** True until a preview with a fingerprint has arrived. */
  readonly confirmDisabled: boolean;
  onSelectBase(base: string): void;
  onConfirm(): void;
  onCancel(): void;
  onAutoClose?(): void;
}

export class ReviewThreadDialog extends Component<ReviewThreadDialogProps> {
  private readonly shell: OverlayShell;
  private readonly body: HTMLElement;
  private readonly bases: HTMLFieldSetElement;
  private readonly details: HTMLElement;
  private readonly confirm = new ActionButton();
  private readonly cancel = new ActionButton();
  private readonly inputs: HTMLInputElement[] = [];
  private select: ((base: string) => void) | null = null;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;

    this.bases = el('fieldset', { class: 'acp-review-thread__bases' });
    this.bases.appendChild(el('legend', { text: 'Compare against' }));
    for (const base of BASES) {
      const input = el('input', {
        class: 'acp-review-thread__radio',
        attrs: { type: 'radio', name: 'review-thread-base', value: base.value },
      });
      this.inputs.push(input);
      const copy = el('span', {}, el('strong', { text: base.label }), el('small', { text: base.description }));
      this.bases.appendChild(el('label', { class: 'acp-review-thread__choice' }, input, copy));
    }
    // ONE delegated listener for both radios, attached once.
    this.bag.listen(this.bases, 'change', (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.checked) this.select?.(target.value);
    });

    this.details = el('pre', {
      class: 'acp-review-thread__details',
      attrs: { 'aria-live': 'polite' },
    });
    const actions = el('div', { class: 'acp-review-thread__actions' }, this.confirm.el, this.cancel.el);
    this.body = el('div', {
      class: 'acp-review-thread__body',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Start Review Thread' },
    }, this.bases, this.details, actions);
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  /**
   * The two ends of this dialog's tab ring, for the caller that opens focus on
   * the checked radio and traps Tab between it and Cancel. Focus is not render
   * state, so it stays with the caller (CLAUDE.md constraint 1); the component
   * only names the nodes it built.
   */
  get baseInputs(): readonly HTMLInputElement[] {
    return this.inputs;
  }

  get cancelButton(): HTMLElement {
    return this.cancel.el;
  }

  update(next: ReviewThreadDialogProps): void {
    this.select = next.onSelectBase;
    super.update(next);
  }

  protected readDeps(next: ReviewThreadDialogProps): readonly unknown[] {
    return [next.open, next.base, next.preview, next.confirmDisabled];
  }

  protected syncClasses(_next: ReviewThreadDialogProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: ReviewThreadDialogProps): void {
    for (const input of this.inputs) input.checked = input.value === next.base;
    this.details.textContent = next.preview;
    this.confirm.update({
      block: '',
      label: 'Start Review · Enter',
      disabled: next.confirmDisabled,
      onClick: () => next.onConfirm(),
    });
    this.cancel.update({ block: '', label: 'Cancel · Esc', onClick: () => next.onCancel() });
    setAttr(this.el, 'tabindex', -1);
    this.shell.update({
      open: next.open,
      name: 'review-thread',
      block: 'acp-review-thread',
      title: 'Start Review Thread',
      body: this.body,
      onAutoClose: next.onAutoClose,
    });
  }

  protected onDispose(): void {
    this.confirm.dispose();
    this.cancel.dispose();
    this.shell.dispose();
  }
}

export const def: ComponentDef = {
  id: 'review-thread-dialog',
  blocks: ['acp-harness__review-thread-overlay', 'acp-review-thread'],
};
