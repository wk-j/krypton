// Spec 302 §5.5 — `QueueCard`.
//
//   omp-1                            ⏎ QUEUE 3 · HELD
//   ───────────────────────────────────────────────
//   ▸1  rerun the type check against the whole workspace and
//       report what the harness tests cover
//       →codex-2 +1   img×2
//   ───────────────────────────────────────────────
//   2   open the model picker
//   ───────────────────────────────────────────────
//   #unqueue · #queue clear
//
// Ports `AcpHarnessView.renderActiveLaneQueue` (spec 302 cites
// `acp-harness-view.ts:11982-12026`; the method today starts at
// `private renderActiveLaneQueue`). That builder joined the rows into one HTML
// string and assigned `innerHTML`, so editing the head prompt rebuilt every
// row below it. Here the `<ol>` is reconciled and the head, the list and the
// hint are three long-lived nodes.
//
// Row identity is positional. The queue is a drain-order list with no stable
// per-prompt id, and its only mutations are "head leaves" and "tail arrives" —
// a text-derived key would make an edited prompt a brand-new row for no gain,
// while a positional key keeps every untouched row's node and repaints only
// the cells whose text moved.

import './queue-card.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import type { QueuedPrompt } from '../../harness-view-types';
import type { HarnessLaneStatus } from '../../types';
import { KeyHintBar } from '../key-hint-bar';
import type { ComponentDef } from '../types';

export interface QueueCardProps {
  readonly queue: readonly QueuedPrompt[];
  readonly status: HarnessLaneStatus;
  /** The lane accent, written as `--acp-lane-accent` on the card root. */
  readonly accent: string;
  /** Active lane's display name — the head's left slot, as on every other rail
   *  card (`PeekCard`, `ThoughtCard`): `OMP-1 … ⏎ QUEUE 3`. */
  readonly laneName: string;
}

interface QueueRowProps {
  readonly marker: string;
  readonly next: boolean;
  readonly text: string;
  /** `→codex-2 +1`, or null when the prompt fanned out to nobody. */
  readonly mention: string | null;
  readonly images: number;
}

const QUEUE_HINTS = [
  { keys: [] as readonly string[], label: '#unqueue' },
  { keys: [] as readonly string[], label: '#queue clear' },
] as const;

function queueRows(next: QueueCardProps): QueueRowProps[] {
  const held = next.status === 'awaiting_peer';
  const paused = next.status === 'error';
  return next.queue.map((prompt, index) => {
    const isNext = index === 0 && !held && !paused;
    const extra = prompt.mentionTargets.length - 1;
    return {
      marker: isNext ? '▸1' : String(index + 1),
      next: isNext,
      text: prompt.text,
      mention: prompt.mentionTargets.length > 0
        ? `→${prompt.mentionTargets[0]}${extra > 0 ? ` +${extra}` : ''}`
        : null,
      images: prompt.images.length,
    };
  });
}

class QueueRow extends Component<QueueRowProps> {
  private readonly markerEl = el('span', { class: 'acp-harness__lane-queue-n' });
  private readonly bodyEl = el('span', { class: 'acp-harness__lane-queue-body' });
  /** Tag line under the prompt. Inline tags used to sit after the body, which
   *  cut a wrapped prompt in half and shortened its first line; they are a
   *  footnote to the row, so they get their own line in the text column. */
  private readonly metaEl = el('span', { class: 'acp-harness__lane-queue-meta' });

  constructor() {
    super(el('li'));
    this.el.append(this.markerEl, this.bodyEl, this.metaEl);
  }

  protected readDeps(next: QueueRowProps): readonly unknown[] {
    return [next.marker, next.next, next.text, next.mention, next.images];
  }

  protected syncClasses(next: QueueRowProps): void {
    this.el.className = next.next
      ? 'acp-harness__lane-queue-row acp-harness__lane-queue-row--next'
      : 'acp-harness__lane-queue-row';
  }

  protected paint(next: QueueRowProps): void {
    this.syncClasses(next);
    this.markerEl.textContent = next.marker;
    this.bodyEl.textContent = next.text;
    // Tags are rebuilt rather than reconciled: at most two, both pure text.
    this.metaEl.textContent = '';
    if (next.mention) {
      this.metaEl.appendChild(el('span', { class: 'acp-harness__lane-queue-tag', text: next.mention }));
    }
    if (next.images > 0) {
      this.metaEl.appendChild(
        el('span', { class: 'acp-harness__lane-queue-tag', text: `img×${next.images}` }),
      );
    }
    // An empty line would still take a grid row's gap.
    this.metaEl.hidden = this.metaEl.childElementCount === 0;
  }
}

export class QueueCard extends Component<QueueCardProps> {
  private readonly nameEl = el('span', { class: 'acp-harness__lane-queue-name' });
  private readonly labelEl = el('span', { class: 'acp-harness__lane-queue-label' });
  private readonly listEl = el('ol', { class: 'acp-harness__lane-queue-list' });
  private readonly hint = new KeyHintBar('div');

  constructor() {
    super(el('aside'));
    this.el.append(
      el('header', { class: 'acp-harness__lane-queue-head' }, this.nameEl, this.labelEl),
      this.listEl,
      this.hint.el,
    );
  }

  protected readDeps(next: QueueCardProps): readonly unknown[] {
    // `lane.queuedPrompts` is mutated IN PLACE — push on enqueue, shift on the
    // drain, splice on `#unqueue` / `#queue edit` / a missed steer — so the
    // array reference never moves and is not a diff. Spreading it puts the
    // depth and every prompt's identity in the tuple. A queued prompt is never
    // edited in place (`#queue edit N` removes it), so identity is exact.
    return [next.status, next.accent, next.laneName, ...next.queue];
  }

  protected syncClasses(next: QueueCardProps): void {
    const held = next.status === 'awaiting_peer' || next.status === 'error';
    this.el.className = held
      ? 'acp-harness__lane-queue acp-harness__lane-queue--held'
      : 'acp-harness__lane-queue';
  }

  protected paint(next: QueueCardProps): void {
    this.syncClasses(next);
    this.el.style.setProperty('--acp-lane-accent', next.accent);
    // Right slot carries what the card is and why it is not draining, the way
    // the peek card carries a lane's status there.
    const state = next.status === 'awaiting_peer'
      ? ' · held'
      : next.status === 'error' ? ' · paused' : '';
    this.nameEl.textContent = next.laneName;
    this.labelEl.textContent = `⏎ queue ${next.queue.length}${state}`;
    reconcile(this.listEl, queueRows(next), {
      key: (_row: QueueRowProps, index: number): string => `#${index}`,
      create: (row: QueueRowProps): QueueRow => {
        const cmp = new QueueRow();
        cmp.update(row);
        return cmp;
      },
      update: (cmp: QueueRow, row: QueueRowProps): void => cmp.update(row),
    });
    this.hint.update({
      hints: QUEUE_HINTS,
      style: 'plain',
      block: 'acp-harness__lane-queue-hint',
    });
  }

  protected onDispose(): void {
    disposeList(this.listEl);
    this.hint.dispose();
  }
}

export const def: ComponentDef = { id: 'queue-card', blocks: ['acp-harness__lane-queue'] };
