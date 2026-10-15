import { afterEach, describe, expect, it } from 'vitest';

import type { ReviewPriorityRange } from '../../types';
import { ReviewPriorityOverlay, type ReviewPriorityOverlayProps } from './index';

const overlays: ReviewPriorityOverlay[] = [];

const range = (over: Partial<ReviewPriorityRange> = {}): ReviewPriorityRange => ({
  file: 'src/ui/list.ts',
  lineStart: 42,
  lineEnd: 58,
  level: 'high',
  ...over,
});

const props = (over: Partial<ReviewPriorityOverlayProps> = {}): ReviewPriorityOverlayProps => ({
  open: true,
  lanes: [{ id: 'lane-1', label: 'codex-1', highCount: 1 }],
  selectedIndex: 0,
  report: { laneId: 'lane-1', ranges: [range()], reportedAt: 0 },
  ...over,
});

const mount = (over: Partial<ReviewPriorityOverlayProps> = {}): ReviewPriorityOverlay => {
  const overlay = new ReviewPriorityOverlay();
  overlays.push(overlay);
  overlay.update(props(over));
  return overlay;
};

afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.dispose();
});

describe('ReviewPriorityOverlay', () => {
  it('emits the head, the group label and one row per range', () => {
    const overlay = mount();
    expect(overlay.el.className).toBe('acp-harness__priority-overlay');
    expect(overlay.el.querySelector('.acp-priority__title')?.textContent).toBe('Review priority');
    expect(overlay.el.querySelector('.acp-priority__sub')?.textContent)
      .toBe('reading order — advisory · open the lane’s diff to act');
    expect(overlay.el.querySelector('.acp-priority__group-label')?.textContent).toBe('read first · 1');
    const row = overlay.el.querySelector<HTMLElement>('.acp-priority__row');
    expect(row?.className).toBe('acp-priority__row acp-priority__row--high');
    expect(row?.querySelector('.acp-priority__tag')?.className)
      .toBe('acp-priority__tag acp-priority__tag--high');
    expect(row?.querySelector('.acp-priority__file')?.textContent).toBe('src/ui/list.ts');
    expect(row?.querySelector('.acp-priority__lines')?.textContent).toBe(':42–58');
    expect(row?.querySelector('.acp-priority__reason')).toBeNull();
  });

  it('collapses a single-line range to one number and shows the reason', () => {
    const overlay = mount({
      report: {
        laneId: 'lane-1',
        ranges: [range({ lineStart: 7, lineEnd: 7, reason: 'new reconciler key' })],
        reportedAt: 0,
      },
    });
    expect(overlay.el.querySelector('.acp-priority__lines')?.textContent).toBe(':7');
    expect(overlay.el.querySelector('.acp-priority__reason')?.textContent).toBe('new reconciler key');
  });

  it('orders read-first before routine and labels each group with its count', () => {
    const overlay = mount({
      report: {
        laneId: 'lane-1',
        ranges: [
          range({ level: 'routine', file: 'a.ts' }),
          range({ file: 'b.ts' }),
          range({ level: 'routine', file: 'c.ts' }),
        ],
        reportedAt: 0,
      },
    });
    expect([...overlay.el.querySelectorAll('.acp-priority__group-label')].map((g) => g.textContent))
      .toEqual(['read first · 1', 'routine · 2']);
    expect([...overlay.el.querySelectorAll('.acp-priority__file')].map((f) => f.textContent))
      .toEqual(['b.ts', 'a.ts', 'c.ts']);
  });

  it('omits the lane switcher with one lane and earns a j/k hint with two', () => {
    const overlay = mount();
    expect(overlay.el.querySelector('.acp-priority__lanes')).toBeNull();
    expect([...overlay.el.querySelectorAll('.acp-priority__foot span:not(.acp-priority__foot-note)')]
      .map((s) => s.textContent)).toEqual(['esc close']);
    overlay.update(props({
      lanes: [
        { id: 'lane-1', label: 'codex-1', highCount: 4 },
        { id: 'lane-2', label: 'grok-1', highCount: 2 },
      ],
    }));
    expect([...overlay.el.querySelectorAll('.acp-priority__lane')].map((t) => t.textContent))
      .toEqual(['codex-1 · 4', 'grok-1 · 2']);
    expect([...overlay.el.querySelectorAll('.acp-priority__foot span:not(.acp-priority__foot-note)')]
      .map((s) => s.textContent)).toEqual(['j k switch lane', 'esc close']);
    expect(overlay.el.querySelector('.acp-priority__foot-note')?.textContent)
      .toBe('read-only — advisory reading hint');
  });

  it('shows the empty state with no report, and drops the foot with it', () => {
    const overlay = mount({ report: null });
    expect(overlay.el.querySelector('.acp-priority__empty')?.textContent)
      .toBe('No reading priority reported.');
    expect(overlay.el.querySelector('.acp-priority__foot')).toBeNull();
    expect(overlay.el.querySelector('.acp-priority__body')).toBeNull();
  });

  it('hides when closed and reopens with the same props', () => {
    const overlay = mount({ open: false });
    expect(overlay.el.hidden).toBe(true);
    overlay.update(props({ open: true }));
    expect(overlay.el.hidden).toBe(false);
    expect(overlay.isOpen).toBe(true);
  });

  it('writes nothing when the dependency tuple holds', () => {
    const report = { laneId: 'lane-1', ranges: [range()], reportedAt: 0 };
    const overlay = mount({ report });
    const observer = new MutationObserver(() => undefined);
    observer.observe(overlay.el, { childList: true, subtree: true, attributes: true, characterData: true });
    overlay.update(props({ report }));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
