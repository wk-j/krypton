import { describe, expect, it } from 'vitest';

import type { FsWriteReviewPayload, HarnessTranscriptItem } from '../../harness-view-types';
import type { RowProps } from '../transcript-row';
import { FsWriteReviewRow } from './index';

function review(over: Partial<FsWriteReviewPayload> = {}): FsWriteReviewPayload {
  return {
    requestId: 11,
    path: 'src/ui/list.ts',
    oldText: 'const a = 1;\nconst b = 2;\n',
    newText: 'const a = 1;\nconst b = 3;\n',
    ...over,
  };
}

function props(fsReview: FsWriteReviewPayload | undefined): RowProps {
  const item: HarnessTranscriptItem = { id: 'w1', kind: 'fs_write_review', text: 'write', fsReview };
  return { item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function watch(node: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
  return observer;
}

function mount(payload: FsWriteReviewPayload | undefined): { row: FsWriteReviewRow; body: HTMLElement } {
  const row = new FsWriteReviewRow(props(payload));
  row.update(props(payload));
  const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
  if (!body) throw new Error('fs review row did not paint');
  return { row, body };
}

describe('FsWriteReviewRow', () => {
  it('emits head, paired diff and the three action hints', () => {
    const { row, body } = mount(review());

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--fs_write_review');
    expect(body.className).toBe('acp-harness__msg-body acp-harness__fs-review');
    expect(body.children[0].outerHTML).toBe(
      '<div class="acp-harness__fs-review-head">' +
        '<span class="acp-harness__fs-review-verb">✏️ write</span>' +
        '<span class="acp-harness__fs-review-path" title="src/ui/list.ts">src/ui/list.ts</span>' +
      '</div>',
    );
    expect(body.children[1].className).toBe('acp-harness__tool-diff');
    expect(body.children[1].firstElementChild?.className)
      .toBe('acp-harness__tool-body acp-harness__tool-body--diff');
    expect(body.children[2].outerHTML).toBe(
      '<div class="acp-harness__fs-review-actions">' +
        '<span class="acp-harness__fs-review-action acp-harness__fs-review-action--accept">[a] accept</span>' +
        '<span class="acp-harness__fs-review-action acp-harness__fs-review-action--reject">[r] reject</span>' +
        '<span class="acp-harness__fs-review-action acp-harness__fs-review-action--accept-all">[A] accept all</span>' +
      '</div>',
    );
    row.dispose();
  });

  it('paints the diff gutters the way the string renderer did', () => {
    const { row, body } = mount(review());
    const lines = [...body.querySelectorAll('.acp-harness__diff-line')];
    expect(lines.map((line) => line.className)).toEqual([
      'acp-harness__diff-line acp-harness__diff-line--ctx',
      'acp-harness__diff-line acp-harness__diff-line--del',
      'acp-harness__diff-line acp-harness__diff-line--add',
    ]);
    expect(lines[1].outerHTML).toBe(
      '<div class="acp-harness__diff-line acp-harness__diff-line--del">' +
        '<span class="acp-harness__diff-num">2</span>' +
        '<span class="acp-harness__diff-num"></span>' +
        '<span class="acp-harness__diff-mark">−</span>' +
        '<span class="acp-harness__diff-text">const b = 2;</span>' +
      '</div>',
    );
    row.dispose();
  });

  it('flips --resolved and keeps every diff node identical', () => {
    const payload = review();
    const { row, body } = mount(payload);
    const diff = body.children[1];
    const lines = [...body.querySelectorAll('.acp-harness__diff-line')];
    const observer = watch(diff as HTMLElement);

    payload.resolved = 'accepted';
    row.update(props(payload));

    expect(body.className)
      .toBe('acp-harness__msg-body acp-harness__fs-review acp-harness__fs-review--resolved');
    expect(body.children[1]).toBe(diff);
    expect([...body.querySelectorAll('.acp-harness__diff-line')]).toEqual(lines);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();

    expect(body.children[2].outerHTML).toBe(
      '<div class="acp-harness__fs-review-resolved acp-harness__fs-review-resolved--accepted">✓ accepted</div>',
    );
    expect(body.querySelector('.acp-harness__fs-review-actions')).toBeNull();
    row.dispose();
  });

  it('re-derives the class and the action row when a resolution is withdrawn', () => {
    const payload = review({ resolved: 'rejected' });
    const { row, body } = mount(payload);
    expect(body.children[2].textContent).toBe('✗ rejected');

    payload.resolved = undefined;
    row.update(props(payload));
    expect(body.className).toBe('acp-harness__msg-body acp-harness__fs-review');
    expect(body.querySelector('.acp-harness__fs-review-resolved')).toBeNull();
    expect(body.querySelectorAll('.acp-harness__fs-review-action')).toHaveLength(3);
    row.dispose();
  });

  it('re-diffs when the text changes, and writes nothing when nothing moved', () => {
    const payload = review();
    const { row, body } = mount(payload);

    payload.newText = 'const a = 1;\nconst b = 4;\n';
    row.update(props(payload));
    expect(body.querySelector('.acp-harness__diff-line--add .acp-harness__diff-text')?.textContent)
      .toBe('const b = 4;');

    const observer = watch(row.el);
    row.update(props(payload));
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    row.dispose();
  });

  it('keeps a cell for an empty path', () => {
    const { row, body } = mount(review({ path: '' }));
    expect(body.querySelector('.acp-harness__fs-review-path')?.textContent).toBe('«empty»');
    row.dispose();
  });

  it('falls back to the item text when the payload is missing', () => {
    const { row, body } = mount(undefined);
    expect(body.className).toBe('acp-harness__msg-body');
    expect(body.textContent).toBe('write');
    row.dispose();
  });
});
