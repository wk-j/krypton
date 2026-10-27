// Spec 302 §3.17 — `Transcript`, the list container.
//
// Owns the tail window, the hidden-rows indicator, the empty state and one
// `reconcile()` over the row components. It does NOT own scroll: the lane body
// it paints into is the pinned node `LaneShell` created, and the view keeps the
// anchor/sticky machinery around the update call, exactly where
// `renderActiveTranscript` had it.
//
// Disposing a row that slid out of the window tears down that row's streaming
// parser. That is the structural replacement for the spec-117 orphan-parser
// `console.warn` guard: a parser can no longer outlive its row.

import './transcript.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, listComponent, reconcile } from '../../../ui/list';
import { HIDDEN_INDICATOR_ID, hiddenRowsIndicatorItem } from '../system-row';
import { createTranscriptRow } from './rows';
import type { RowProps, TranscriptRow } from '../transcript-row';
import type { HarnessLane, HarnessTranscriptItem } from '../../harness-view-types';
import type { ComponentDef } from '../types';

/** How many more rows `Ctrl+H` reveals. Matches `TRANSCRIPT_WINDOW_STEP`. */
export const TRANSCRIPT_WINDOW_STEP = 60;

export interface TranscriptProps {
  readonly lane: HarnessLane;
  readonly projectDir: string | null;
  readonly resolveLocalImages: boolean;
}

export { rowKindFor } from './rows';

/** The rows that render for a lane: the tail window, plus the indicator. */
export function tailWindow(lane: HarnessLane): {
  items: readonly HarnessTranscriptItem[];
  hidden: number;
} {
  const total = lane.transcript.length;
  const size = lane.transcriptWindow;
  const start = Number.isFinite(size) ? Math.max(0, total - size) : 0;
  const items: HarnessTranscriptItem[] = [];
  if (start > 0) items.push(hiddenRowsIndicatorItem(start, TRANSCRIPT_WINDOW_STEP));
  for (let i = start; i < total; i++) items.push(lane.transcript[i]);
  return { items, hidden: start };
}

export class Transcript extends Component<TranscriptProps> {
  private empty: HTMLElement | null = null;

  /** `body` is the pinned `.acp-harness__lane-body` node owned by `LaneShell`. */
  constructor(body: HTMLElement) {
    super(body);
  }

  /**
   * The list is re-derived on every commit: rows hold their own deps, so the
   * container's job is to notice that the window moved, not to guard paints.
   */
  protected readDeps(next: TranscriptProps): readonly unknown[] {
    return [next.lane.id, next.lane.transcript.length, next.lane.transcriptWindow];
  }

  protected syncClasses(): void {
    /* the body's class is owned by LaneShell, which created the node */
  }

  update(next: TranscriptProps): void {
    super.update(next);
    // Unconditional: a row's own deps decide whether it repaints, and a
    // streaming row needs its appendChunk on every pass.
    this.reconcileRows(next);
  }

  protected paint(next: TranscriptProps): void {
    this.reconcileRows(next);
  }

  private reconcileRows(next: TranscriptProps): void {
    const { lane } = next;
    if (lane.transcript.length === 0) {
      this.showEmpty();
      return;
    }
    this.hideEmpty();
    const { items } = tailWindow(lane);
    reconcile(this.el, items, {
      key: (item) => item.id,
      create: (item) => {
        const props = this.rowProps(item, next);
        const row = createTranscriptRow(props);
        row.update(props);
        lane.seenTranscriptIds.add(item.id);
        return row;
      },
      update: (row, item) => {
        row.update(this.rowProps(item, next));
        lane.seenTranscriptIds.add(item.id);
      },
    });
  }

  /**
   * The mounted row for an item id, if it is inside the tail window.
   *
   * The seal paths need it: `LiveComponent.seal()` is the single live→static
   * transition and only a mounted row can perform it. A row outside the window
   * (or on a background lane) has no component, which is exactly why the view
   * keeps a cold-cache capture for that case.
   */
  rowFor(id: string): TranscriptRow | null {
    return (listComponent(this.el, id) as TranscriptRow | undefined) ?? null;
  }

  protected onDispose(): void {
    // Row disposal is what tears down a streaming parser, so it must happen
    // when the lane shell goes away, not only when a row scrolls out.
    disposeList(this.el);
  }

  private rowProps(item: HarnessTranscriptItem, next: TranscriptProps): RowProps {
    const { lane } = next;
    return {
      item,
      isNew: item.id !== HIDDEN_INDICATOR_ID && !lane.seenTranscriptIds.has(item.id),
      streaming:
        item.id === lane.currentAssistantId ||
        item.id === lane.currentThoughtId ||
        item.id === lane.currentUserId,
      lane,
      projectDir: next.projectDir,
      resolveLocalImages: next.resolveLocalImages,
    };
  }

  private showEmpty(): void {
    if (this.empty) return;
    this.empty = el('div', {
      class: 'acp-harness__transcript-empty',
      text: 'lane transcript will appear here',
    });
    this.el.replaceChildren(this.empty);
  }

  private hideEmpty(): void {
    if (!this.empty) return;
    this.empty.remove();
    this.empty = null;
  }
}

export const def: ComponentDef = { id: 'transcript', blocks: ['acp-harness__transcript-empty'] };
