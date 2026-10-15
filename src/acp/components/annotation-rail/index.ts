// Spec 302 §5.8 — `AnnotationRail`.
//
//   ANNOTATED  3 · 2 unsent                              [ send 2 ]
//   · deps tuple needs the lane arg                       [ del ]
//   · the reconciler keeps node identity                  [ del ]
//
// Ports `renderAnnotationRail` (src/acp/transcript-annotation.ts:329-370). That
// builder rebuilt the whole rail — head, send button, every note — each time
// `applyTranscriptAnnotations` ran, which is once per paint of the row that
// owns it; deleting one note therefore replaced the nodes of all the others.
// Here the notes are reconciled on their stable client id, so a delete, a
// drain or a drift flag touches one `<li>`.
//
// The two buttons are `ActionButton`: the send button's `disabled` is the same
// real attribute the delegated `[data-anno-send]` handler relies on, and `del`
// carries the annotation id in `data-anno-del` exactly as before. Neither
// button takes an `onClick` — the rail is inside the transcript body and the
// harness listens once at the root, which is the one listener the markup has
// ever had.
//
// Mounted only when there is at least one annotation; the owning row removes
// it otherwise, and an empty rail is not a state the harness has.

import './annotation-rail.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import type { TranscriptAnnotation } from '../../types';
import { ActionButton } from '../action-button';
import type { ComponentDef } from '../types';

export interface AnnotationRailProps {
  readonly annotations: readonly TranscriptAnnotation[];
}

/** Everything the rail draws, as one string the deps tuple can compare. */
function signature(annotations: readonly TranscriptAnnotation[]): string {
  let out = '';
  for (const note of annotations) {
    out += `${note.id}:${note.status}:${note.drifted === true ? '1' : '0'}:${note.body}\u001f`;
  }
  return out;
}

class AnnotationItem extends Component<TranscriptAnnotation> {
  private readonly noteEl = el('span', { class: 'acp-harness__anno-note' });
  private readonly del = new ActionButton();

  constructor() {
    super(el('li'));
    this.el.appendChild(this.noteEl);
  }

  protected readDeps(next: TranscriptAnnotation): readonly unknown[] {
    return [next.id, next.body, next.status, next.drifted === true];
  }

  protected syncClasses(next: TranscriptAnnotation): void {
    this.el.className = next.drifted
      ? `acp-harness__anno-item acp-harness__anno-item--${next.status} acp-harness__anno-item--drifted`
      : `acp-harness__anno-item acp-harness__anno-item--${next.status}`;
  }

  protected paint(next: TranscriptAnnotation): void {
    this.syncClasses(next);
    this.noteEl.textContent = next.body;
    // Only an unsent note can still be withdrawn.
    if (next.status === 'unsent') {
      this.del.update({
        block: 'acp-harness__anno-del',
        label: 'del',
        data: { 'anno-del': next.id },
      });
      if (this.del.el.parentNode !== this.el) this.el.appendChild(this.del.el);
    } else {
      this.del.el.remove();
    }
  }

  protected onDispose(): void {
    this.del.dispose();
  }
}

export class AnnotationRail extends Component<AnnotationRailProps> {
  private readonly titleEl = el('span');
  private readonly send = new ActionButton();
  private readonly listEl = el('ol', { class: 'acp-harness__anno-list' });

  constructor() {
    super(el('section', { attrs: { 'aria-label': 'Annotations' } }));
    this.el.append(
      el('div', { class: 'acp-harness__anno-rail-head' }, this.titleEl, this.send.el),
      this.listEl,
    );
  }

  protected readDeps(next: AnnotationRailProps): readonly unknown[] {
    // NOT the array identity: the owner edits `item.annotations` in place —
    // `splice` on delete (`acp-harness-view.ts:14035,14054`) and `a.status = …`
    // on send/drain (`:14066`) — so the same array has to be able to say it
    // changed. `drifted` is written by `applyTranscriptAnnotations` on the same
    // objects, which is why it is in the signature too.
    return [signature(next.annotations)];
  }

  protected syncClasses(_next: AnnotationRailProps): void {
    this.el.className = 'acp-harness__anno-rail';
  }

  protected paint(next: AnnotationRailProps): void {
    this.syncClasses(next);
    const total = next.annotations.length;
    const unsent = next.annotations.filter((note) => note.status === 'unsent').length;
    this.titleEl.textContent = unsent
      ? `ANNOTATED  ${total} · ${unsent} unsent`
      : `ANNOTATED  ${total}`;
    this.send.update({
      block: 'acp-harness__anno-send',
      label: unsent ? `send ${unsent}` : 'sent',
      disabled: unsent === 0,
      data: { 'anno-send': '1' },
    });
    reconcile(this.listEl, next.annotations, {
      key: (note: TranscriptAnnotation): string => note.id,
      create: (note: TranscriptAnnotation): AnnotationItem => {
        const cmp = new AnnotationItem();
        cmp.update(note);
        return cmp;
      },
      update: (cmp: AnnotationItem, note: TranscriptAnnotation): void => cmp.update(note),
    });
  }

  protected onDispose(): void {
    disposeList(this.listEl);
    this.send.dispose();
  }
}

export const def: ComponentDef = {
  id: 'annotation-rail',
  blocks: [
    'acp-harness__anno-rail',
    'acp-harness__anno-send',
    'acp-harness__anno-list',
    'acp-harness__anno-item',
    'acp-harness__anno-note',
    'acp-harness__anno-del',
  ],
};
