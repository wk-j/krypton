import { afterEach, describe, expect, it } from 'vitest';

import type { ReviewOutcome } from '../../types';
import { ReviewMatrixOverlay, type ReviewMatrixOverlayProps } from './index';

const overlays: ReviewMatrixOverlay[] = [];

const outcome = (over: Partial<ReviewOutcome> = {}): ReviewOutcome => ({
  authoringLaneId: 'lane-1',
  authoringLaneName: 'codex-1',
  subjectLabel: 'src/ui/component.ts',
  reviewerCount: 2,
  blockers: 0,
  warnings: 1,
  at: Date.now(),
  ...over,
});

const props = (over: Partial<ReviewMatrixOverlayProps> = {}): ReviewMatrixOverlayProps => ({
  open: true,
  lanes: [{ id: 'lane-1', label: 'codex-1', roundCount: 1 }],
  selectedLaneIndex: 0,
  rows: [outcome()],
  selectedRowIndex: 0,
  expandedRowIndex: null,
  ...over,
});

const mount = (over: Partial<ReviewMatrixOverlayProps> = {}): ReviewMatrixOverlay => {
  const overlay = new ReviewMatrixOverlay();
  overlays.push(overlay);
  overlay.update(props(over));
  return overlay;
};

afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.dispose();
});

describe('ReviewMatrixOverlay', () => {
  it('emits the head, the column labels and one row per outcome', () => {
    const overlay = mount();
    expect(overlay.el.className).toBe('acp-harness__review-overlay');
    expect(overlay.el.querySelector('.acp-review__title')?.textContent).toBe('Review quality matrix');
    expect(overlay.el.querySelector('.acp-review__sub')?.textContent)
      .toBe('this session · in-memory · not persisted');
    expect([...overlay.el.querySelectorAll('.acp-review__table th')].map((th) => th.textContent))
      .toEqual(['round', 'subject', 'reviewers', 'block', 'warn']);
    const cells = [...overlay.el.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells.slice(1)).toEqual(['src/ui/component.ts', '2', '0', '1']);
    expect(overlay.el.querySelector('.acp-review__block')?.className)
      .toBe('acp-review__num acp-review__block is-zero');
    expect(overlay.el.querySelector('.acp-review__warn')?.className)
      .toBe('acp-review__num acp-review__warn');
  });

  it('omits the lane switcher with one lane and shows it with two', () => {
    const overlay = mount();
    expect(overlay.el.querySelector('.acp-review__lanes')).toBeNull();
    overlay.update(props({
      lanes: [
        { id: 'lane-1', label: 'codex-1', roundCount: 4 },
        { id: 'lane-2', label: 'grok-1', roundCount: 2 },
      ],
    }));
    expect([...overlay.el.querySelectorAll('.acp-review__lane')].map((tab) => tab.textContent))
      .toEqual(['codex-1 · 4', 'grok-1 · 2']);
    expect(overlay.el.querySelector('.acp-review__lane')?.className)
      .toBe('acp-review__lane is-active');
  });

  it('marks the selected round and re-derives the class when selection moves back', () => {
    const rows = [outcome(), outcome({ subjectLabel: 'docs/0302.md' })];
    const overlay = mount({ rows, selectedRowIndex: 1 });
    const trs = [...overlay.el.querySelectorAll('tbody tr')];
    expect(trs[1].className).toBe('acp-review__row--selected');
    expect(trs[0].className).toBe('');
    overlay.update(props({ rows, selectedRowIndex: 0 }));
    const after = [...overlay.el.querySelectorAll('tbody tr')];
    expect(after[0].className).toBe('acp-review__row--selected');
    expect(after[1].className).toBe('');
  });

  it('expands findings into a classed detail row, grouped by severity', () => {
    const rows = [outcome({
      findings: [
        { file: 'src/ui/list.ts', line: 42, severity: 'blocking', note: 'key collision' },
        { file: 'src/ui/dom.ts', severity: 'suggestion', note: 'inline this' },
      ],
    })];
    const overlay = mount({ rows, expandedRowIndex: 0 });
    expect(overlay.el.querySelector('.acp-review__subj')?.textContent)
      .toBe('▾ src/ui/component.ts');
    const cell = overlay.el.querySelector<HTMLTableCellElement>('.acp-review__detail-cell');
    expect(cell?.getAttribute('colspan')).toBe('5');
    expect(cell?.getAttribute('style')).toBeNull();
    expect([...overlay.el.querySelectorAll('.acp-review__findings-group')].map((g) => g.className))
      .toEqual([
        'acp-review__findings-group acp-review__findings-group--blocking',
        'acp-review__findings-group acp-review__findings-group--suggestion',
      ]);
    expect([...overlay.el.querySelectorAll('.acp-review__finding')].map((f) => f.textContent))
      .toEqual([
        'src/ui/list.ts:42 — blocking — key collision',
        'src/ui/dom.ts — suggestion — inline this',
      ]);
  });

  it('collapses the detail row again and marks the subject with ▸', () => {
    const rows = [outcome({
      findings: [{ file: 'a.ts', severity: 'blocking', note: 'n' }],
    })];
    const overlay = mount({ rows, expandedRowIndex: 0 });
    overlay.update(props({ rows, expandedRowIndex: null }));
    expect(overlay.el.querySelector('.acp-review__detail-cell')).toBeNull();
    expect(overlay.el.querySelector('.acp-review__subj')?.textContent).toBe('▸ src/ui/component.ts');
  });

  it('builds the foot from the state that earns each hint', () => {
    const overlay = mount();
    const foot = overlay.el.querySelector<HTMLElement>('.acp-review__foot');
    expect([...(foot?.querySelectorAll('span:not(.acp-review__foot-note)') ?? [])].map((s) => s.textContent))
      .toEqual(['j k select round', 'esc close']);
    expect(foot?.querySelector('.acp-review__foot-note')?.textContent)
      .toBe('read-only — observation, not a score');
  });

  it('shows the empty state and drops the foot with it', () => {
    const overlay = mount({ lanes: [], rows: [] });
    expect(overlay.el.querySelector('.acp-review__empty')?.textContent).toBe('No reviews recorded.');
    expect(overlay.el.querySelector('.acp-review__foot')).toBeNull();
    expect(overlay.el.querySelector('.acp-review__table')).toBeNull();
  });

  it('keeps the table node across a row change and writes nothing on a repeat update', () => {
    const rows = [outcome()];
    const overlay = mount({ rows });
    const table = overlay.el.querySelector('.acp-review__table');
    const observer = new MutationObserver(() => undefined);
    observer.observe(overlay.el, { childList: true, subtree: true, attributes: true, characterData: true });
    overlay.update(props({ rows }));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
    expect(overlay.el.querySelector('.acp-review__table')).toBe(table);
  });
});
