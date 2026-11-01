// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above this import, so the view loads with the stubs.
import { ReviewBoardView } from './view';

// A finding's explanation is the paragraph the lane wrote right after it. The
// parser also copies that paragraph into the finding's `detail`, so the Board
// must show it exactly once in every view (spec 354).
const { REVIEW, EXPLANATION } = vi.hoisted(() => {
  const explanation = 'Only the root matcher is loaded, so nested ignores leak.';
  return {
    EXPLANATION: explanation,
    REVIEW: [
      '# Archive review',
      '',
      '## What changed',
      '',
      '```review:finding',
      'severity: non-blocking',
      'title: matcher misses nested .gitignore',
      'file: src-tauri/src/hook_server.rs',
      'line: 6577',
      '```',
      '',
      explanation,
      '',
    ].join('\n'),
  };
});

vi.mock('../profiler/ipc', () => ({
  invoke: async (cmd: string): Promise<unknown> =>
    cmd === 'read_review_bundle' ? { review: REVIEW } : undefined,
}));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string): string => path }));

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('Review Board finding explanation', () => {
  it('renders once in the chapter, in Open items and in the full document', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new ReviewBoardView(host, { dir: '/tmp/review', slug: 'archive-review' });
    await view.requestRefresh();

    const body = (): string => host.querySelector('.krypton-review__body')?.textContent ?? '';
    const openView = (row: number): void => {
      host.querySelector<HTMLElement>(`[data-map-row="${row}"]`)?.click();
    };

    // Map rows: Overview, the one chapter, Open items, Full document.
    expect(occurrences(body(), EXPLANATION)).toBe(1);
    openView(2);
    expect(body()).toContain('matcher misses nested .gitignore');
    expect(occurrences(body(), EXPLANATION)).toBe(1);
    openView(3);
    expect(occurrences(body(), EXPLANATION)).toBe(1);

    view.dispose();
  });
});

describe('Review Board comment', () => {
  it('keeps a comment typed after `c`, quoting the block label when nothing is selected', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new ReviewBoardView(host, { dir: '/tmp/review', slug: 'archive-review' });
    await view.requestRefresh();

    // The cursor opens on the first unanswered block: the finding.
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'c' }));
    const input = host.querySelector<HTMLTextAreaElement>('.krypton-review__comment-input');
    expect(input).not.toBeNull();
    input!.value = 'read nested ignores too';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));

    const comments = view.draftResponse().comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('read nested ignores too');
    expect(comments[0].quote).toBe(
      'matcher misses nested .gitignore — src-tauri/src/hook_server.rs:6577',
    );
    expect(host.querySelector('.krypton-review__overlay')).toBeNull();

    view.dispose();
  });
});
