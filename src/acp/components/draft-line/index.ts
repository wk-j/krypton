// Spec 302 §6.3 — `DraftLine`.
//
// `claude-1  ⠋  convert the UI into reusable comp█onents` — the composer's
// input row: the lane tag, the prompt glyph, and the draft split at the cursor
// around the `Caret`, with the word-autocomplete ghost after it. Built today by
// `acp-harness-view.ts:13285-13287,13312-13317` plus `renderGhost` (`:15447-15450`).
//
// Two external contracts pin the shape of `.acp-harness__input`:
//
//   * `harness-composer-bloom.ts:156,176` finds the caret with
//     `querySelector('.acp-harness__caret')` and sums the `data.length` of the
//     TEXT NODE children before it to locate the inserted grapheme. So the text
//     before the cursor stays a bare text node that is a direct child of the
//     input, ahead of the caret — never a wrapping span.
//   * `ensureComposerBloomLayer()` (`:100-109`) appends its particle layer as a
//     child of that same input and only re-appends it when the parent changed.
//     This component therefore never replaces the input's children wholesale:
//     it writes its own four nodes and leaves anything else alone. That is also
//     why the afterimages no longer need to survive an `innerHTML` rebuild —
//     there is none.
//
// The prompt glyph is the `Spinner` component. Its one markup consequence is
// the idle prompt: today `<span class="acp-harness__prompt">⠋</span>`, now the
// same glyph inside the spinner's own (unclassed, unstyled) span, which is what
// spec 302 §1.2 assigns this call site. Busy is character-identical, and the
// glyph node now survives busy→idle instead of snapping back to frame 0.

import './draft-line.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { Caret } from '../caret';
import { DictationPreview } from '../dictation-control';
import { SPINNER_FRAMES, Spinner } from '../spinner';
import type { DictationPreviewParts } from '../../harness-dictation';
import type { ComponentDef } from '../types';

export interface DraftLineProps {
  /** `lane.displayName`. */
  readonly laneName: string;
  /** `lane.status === 'busy'` — the prompt glyph animates. */
  readonly running: boolean;
  readonly draft: string;
  readonly cursor: number;
  /** `visibleGhost(lane)` (`acp-harness-view.ts:15431-15445`), or null. */
  readonly ghost: string | null;
  /** Non-null replaces the typed draft with the dictation preview. */
  readonly dictation: DictationPreviewParts | null;
}

export class DraftLine extends Component<DraftLineProps> {
  private readonly tagEl: HTMLElement;
  private readonly promptEl: HTMLElement;
  /** The typed-draft input. The dictation preview owns a second one. */
  private readonly inputEl: HTMLElement;
  private readonly beforeNode = document.createTextNode('');
  private readonly afterNode = document.createTextNode('');
  private readonly caret = new Caret();
  private readonly spinner = new Spinner();
  private ghostEl: HTMLElement | null = null;
  private preview: DictationPreview | null = null;

  constructor() {
    super(el('div', { class: 'acp-harness__input-line' }));
    this.tagEl = el('span', { class: 'acp-harness__lane-tag' });
    this.promptEl = el('span', { class: 'acp-harness__prompt' }, this.spinner.el);
    this.inputEl = el('span', { class: 'acp-harness__input' });
    this.caret.update({});
    this.inputEl.append(this.beforeNode, this.caret.el, this.afterNode);
    this.el.append(this.tagEl, this.promptEl, this.inputEl);
  }

  protected readDeps(next: DraftLineProps): readonly unknown[] {
    const parts = next.dictation;
    return [
      next.laneName,
      next.running,
      next.draft,
      next.cursor,
      next.ghost,
      parts
        ? `${parts.before}\u0001${parts.leading}\u0001${parts.finalText}\u0001${parts.interimText}\u0001${parts.trailing}\u0001${parts.after}`
        : null,
    ];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__input-line';
    this.inputEl.className = 'acp-harness__input';
    this.promptEl.className = 'acp-harness__prompt';
    this.tagEl.className = 'acp-harness__lane-tag';
  }

  protected paint(next: DraftLineProps): void {
    this.syncClasses();
    if (this.tagEl.textContent !== next.laneName) this.tagEl.textContent = next.laneName;
    this.spinner.update({ running: next.running, terminalGlyph: SPINNER_FRAMES[0] });

    if (next.dictation) {
      const preview = this.preview ?? new DictationPreview();
      this.preview = preview;
      preview.update(next.dictation);
      syncOrder(this.el, [this.tagEl, this.promptEl, preview.el]);
      return;
    }

    const cursor = Math.max(0, Math.min(next.cursor, next.draft.length));
    this.beforeNode.data = next.draft.slice(0, cursor);
    this.afterNode.data = next.draft.slice(cursor);
    this.paintGhost(next.ghost);
    if (this.inputEl.parentNode !== this.el) {
      syncOrder(this.el, [this.tagEl, this.promptEl, this.inputEl]);
    }
  }

  /** The ghost sits between the caret and the text after the cursor, so an
   *  accepted suggestion reads as a continuation of the word being typed. */
  private paintGhost(ghost: string | null): void {
    if (!ghost) {
      this.ghostEl?.remove();
      this.ghostEl = null;
      return;
    }
    if (!this.ghostEl) {
      this.ghostEl = el('span', { class: 'acp-harness__ghost', attrs: { 'aria-hidden': 'true' } });
    }
    this.ghostEl.textContent = ghost;
    if (this.ghostEl.previousSibling !== this.caret.el) {
      this.inputEl.insertBefore(this.ghostEl, this.afterNode);
    }
  }

  protected onDispose(): void {
    this.caret.dispose();
    this.spinner.dispose();
    this.preview?.dispose();
  }
}

export const def: ComponentDef = {
  id: 'draft-line',
  blocks: [
    'acp-harness__input-line',
    'acp-harness__lane-tag',
    'acp-harness__prompt',
    'acp-harness__input',
    'acp-harness__ghost',
  ],
};
