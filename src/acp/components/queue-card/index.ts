// Spec 302 §5.5 — `QueueCard`.
//
//   ⏎ queue (3) · held behind lane mail
//   ▸1  rerun the type check                      →codex-2 +1   img×2
//   2   open the model picker
//   3   write the migration note
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

  constructor() {
    super(el('li'));
    this.el.append(this.markerEl, this.bodyEl);
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
    while (this.el.lastChild && this.el.lastChild !== this.bodyEl) this.el.lastChild.remove();
    if (next.mention) {
      this.el.appendChild(el('span', { class: 'acp-harness__lane-queue-tag', text: next.mention }));
    }
    if (next.images > 0) {
      this.el.appendChild(
        el('span', { class: 'acp-harness__lane-queue-tag', text: `img×${next.images}` }),
      );
    }
  }
}

export class QueueCard extends Component<QueueCardProps> {
  private readonly headEl = el('div', { class: 'acp-harness__lane-queue-head' });
  private readonly listEl = el('ol', { class: 'acp-harness__lane-queue-list' });
  private readonly hint = new KeyHintBar('div');

  constructor() {
    super(el('div'));
    this.el.append(this.headEl, this.listEl, this.hint.el);
  }

  protected readDeps(next: QueueCardProps): readonly unknown[] {
    return [next.queue, next.status, next.accent];
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
    const stateSuffix = next.status === 'awaiting_peer'
      ? ' · held behind lane mail'
      : next.status === 'error' ? ' · paused' : '';
    this.headEl.textContent = `⏎ queue (${next.queue.length})${stateSuffix}`;
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
