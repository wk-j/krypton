// Spec 302 §5.4 — `ThoughtCard` (LIVE).
//
//   claude-1                                              thinking
//   the tail window can slide past a live row…
//
// Ports `renderLaneThought` (src/acp/lane-peek.ts:607-627) and
// `patchLaneThoughtCard` (:629-648). The two were the same card painted twice:
// the render built it from a template and the patch re-derived every field by
// query. The patch exists only to keep the body node — and with it the
// teletype's print-head state, which is held in a `WeakMap` keyed by that very
// node — alive across a pass. A component owns its nodes, so there is nothing
// to keep alive by hand.
//
// **Live contract.** The card is constructed live while the lane is still
// thinking (`isLivePeekThought`). `appendChunk()` hands the latest thought text
// to `syncPeekThoughtBody`, which advances the teletype print head into the
// ghost/fresh span pair it already owns — the body's child nodes keep their
// identity, the text grows. `seal()` settles that pair through
// `sealThoughtTeletype`: the full text lands in the ghost span, the caret goes,
// and `acp-harness__msg-body--thought-teletype` is dropped. The next `update()`
// writes nothing.
//
// The head is re-derived in `paint()` AND in `onSeal()`, because sealing is the
// moment `thinking` becomes `thought` and the phase attribute settles — and
// `seal()` does not route through `paint()`.

import './thought-card.css';

import { LiveComponent } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { isLivePeekThought, syncPeekThoughtBody } from '../../lane-peek';
import type { LanePeekSnapshot } from '../../harness-view-types';
import type { ComponentDef } from '../types';

export interface ThoughtCardProps {
  readonly snapshot: LanePeekSnapshot;
  readonly projectDir: string | null;
}

export class ThoughtCard extends LiveComponent<ThoughtCardProps> {
  private readonly nameEl = el('span', { class: 'acp-harness__lane-thought-name' });
  private readonly labelEl = el('span', { class: 'acp-harness__lane-thought-label' });
  private readonly bodyEl = el('div', { class: 'acp-harness__lane-thought-body' });
  private latest: ThoughtCardProps | null = null;

  /** The view constructs with `isLivePeekThought(snapshot.thought)`: a card
   *  mounted for an already-sealed thought never streams. */
  constructor(live = true) {
    super(el('aside'), live);
    this.el.append(
      el('header', { class: 'acp-harness__lane-thought-head' }, this.nameEl, this.labelEl),
      this.bodyEl,
    );
  }

  /** The body node the teletype writes into — the view pins its scroll. */
  get body(): HTMLElement {
    return this.bodyEl;
  }

  update(next: ThoughtCardProps): void {
    this.latest = next;
    super.update(next);
  }

  seal(next: ThoughtCardProps): void {
    this.latest = next;
    super.seal(next);
  }

  protected readDeps(next: ThoughtCardProps): readonly unknown[] {
    const thought = next.snapshot.thought ?? null;
    return [
      next.snapshot.laneId,
      next.snapshot.displayName,
      thought?.phase ?? 'empty',
      next.projectDir,
      this.isLive,
      // A live card's text arrives through `appendChunk()` and must not force a
      // structural repaint; a sealed one has no other way to notice an edit.
      this.isLive ? null : thought?.text ?? null,
    ];
  }

  protected syncClasses(_next: ThoughtCardProps): void {
    this.el.className = 'acp-harness__lane-thought';
  }

  protected paint(next: ThoughtCardProps): void {
    this.syncClasses(next);
    this.paintHead(next);
    // While live, the body belongs to `appendChunk()` — which runs right after
    // this, on the same update.
    if (!this.isLive) syncPeekThoughtBody(this.bodyEl, next.snapshot.thought ?? null, next.projectDir);
  }

  protected appendChunk(next: ThoughtCardProps): void {
    syncPeekThoughtBody(this.bodyEl, next.snapshot.thought ?? null, next.projectDir);
  }

  protected onSeal(): void {
    const next = this.latest;
    if (!next) return;
    this.paintHead(next);
    syncPeekThoughtBody(this.bodyEl, next.snapshot.thought ?? null, next.projectDir);
  }

  private paintHead(next: ThoughtCardProps): void {
    const thought = next.snapshot.thought ?? null;
    setAttr(this.el, 'data-lane-id', next.snapshot.laneId);
    setAttr(this.el, 'data-phase', thought?.phase ?? 'empty');
    this.nameEl.textContent = next.snapshot.displayName;
    this.labelEl.textContent = isLivePeekThought(thought) ? 'thinking' : 'thought';
  }
}

export const def: ComponentDef = {
  id: 'thought-card',
  blocks: ['acp-harness__lane-thought', 'acp-harness__thought-fresh', 'acp-harness__thought-caret'],
};
