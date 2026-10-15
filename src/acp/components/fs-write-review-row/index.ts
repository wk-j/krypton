// Spec 302 §3.9 — `FsWriteReviewRow`.
//
// The gated `write_text_file` card (spec 89): a path head, a paired diff, and
// either the accept/reject hint line or the resolution stamp.
//
// Resolving the card used to rebuild the row, which re-ran `diffLines()` and
// re-parsed the whole preview into a fresh `innerHTML` tree. Here the diff rows
// are memoised on `(oldText, newText)` and handed to a `DiffBlock` field, so
// the resolve flips one class and swaps one tail node — the diff nodes keep
// their identity.
//
// Ported from `harness-transcript-render.ts:854-907` (`renderFsWriteReviewBody`)
// plus its dispatcher branch at `:362-365`. Markup is unchanged — `DiffBlock`
// in `paired` mode emits exactly what `renderDiffPreview()` wrote as a string.

import { el } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { DiffBlock, pairedDiffRows, type DiffRow } from '../diff-block';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';
import './fs-write-review-row.css';

const ACTIONS: readonly { readonly modifier: string; readonly text: string }[] = [
  { modifier: 'accept', text: '[a] accept' },
  { modifier: 'reject', text: '[r] reject' },
  { modifier: 'accept-all', text: '[A] accept all' },
];

export class FsWriteReviewRow extends TranscriptRow {
  private readonly head = el('div', { class: 'acp-harness__fs-review-head' });
  private readonly verb = el('span', { class: 'acp-harness__fs-review-verb', text: '✏️ write' });
  private readonly path = el('span', { class: 'acp-harness__fs-review-path' });
  private readonly diff = new DiffBlock('paired');
  private rows: readonly DiffRow[] = [];
  private rowsSource: { readonly oldText: string; readonly newText: string } | null = null;

  constructor(props: RowProps) {
    super(props, false);
    this.head.append(this.verb, this.path);
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    const payload = next.item.fsReview;
    if (!payload) return [];
    if (!payload.resolved) return ['acp-harness__fs-review'];
    return ['acp-harness__fs-review', 'acp-harness__fs-review--resolved'];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    const payload = next.item.fsReview;
    if (!payload) return [undefined, undefined, undefined, next.item.text];
    return [payload.path, payload.oldText, payload.newText, payload.resolved];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const payload = next.item.fsReview;
    if (!payload) {
      body.textContent = next.item.text;
      return;
    }
    // An empty path still needs a cell, as in the fs-activity row.
    this.path.textContent = payload.path || '«empty»';
    this.path.title = payload.path;

    // Only a real text change re-diffs; a resolve must not touch the preview.
    if (
      this.rowsSource === null ||
      this.rowsSource.oldText !== payload.oldText ||
      this.rowsSource.newText !== payload.newText
    ) {
      this.rowsSource = { oldText: payload.oldText, newText: payload.newText };
      this.rows = pairedDiffRows(payload.oldText, payload.newText);
    }
    this.diff.update({ mode: 'paired', rows: this.rows, prefix: 'acp-harness' });

    const nodes: HTMLElement[] = [this.head, this.diff.el];
    if (payload.resolved) {
      nodes.push(
        el('div', {
          class: `acp-harness__fs-review-resolved acp-harness__fs-review-resolved--${payload.resolved}`,
          text: payload.resolved === 'accepted' ? '✓ accepted' : '✗ rejected',
        }),
      );
    } else {
      nodes.push(
        el(
          'div',
          { class: 'acp-harness__fs-review-actions' },
          ...ACTIONS.map((action) =>
            el('span', {
              class: `acp-harness__fs-review-action acp-harness__fs-review-action--${action.modifier}`,
              text: action.text,
            }),
          ),
        ),
      );
    }
    syncOrder(body, nodes);
  }

  protected onDispose(): void {
    this.diff.dispose();
    super.onDispose();
  }
}

export const def: ComponentDef = { id: 'fs-write-review-row', blocks: ['acp-harness__fs-review'] };
