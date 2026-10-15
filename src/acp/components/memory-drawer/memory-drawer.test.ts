import { afterEach, describe, expect, it } from 'vitest';

import type { HandoffEntry } from '../../types';
import { MemoryDrawer, type MemoryDrawerProps } from './index';

const drawers: MemoryDrawer[] = [];

const NOW = 1_700_000_000_000;

const entry = (over: Partial<HandoffEntry> = {}): HandoffEntry => ({
  id: 'ho-1',
  author: 'claude-1',
  host: 'mbp',
  summary: 'wire the composer meta segments',
  detail: 'phase 6 is next',
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  boundLanes: [],
  ...over,
});

const props = (over: Partial<MemoryDrawerProps> = {}): MemoryDrawerProps => ({
  open: true,
  entries: [entry()],
  cursorId: null,
  warning: null,
  activeLaneLabel: null,
  now: NOW,
  ...over,
});

const mount = (over: Partial<MemoryDrawerProps> = {}): MemoryDrawer => {
  const drawer = new MemoryDrawer();
  drawers.push(drawer);
  drawer.update(props(over));
  return drawer;
};

afterEach(() => {
  for (const drawer of drawers.splice(0)) drawer.dispose();
});

describe('MemoryDrawer', () => {
  it('emits the overlay, the counted head and one row per handoff', () => {
    const drawer = mount({ entries: [entry(), entry({ id: 'ho-2' })] });
    expect(drawer.el.className).toBe('acp-harness__memory-overlay');
    expect(drawer.el.querySelector('.acp-harness__memory__title')?.textContent).toBe('Handoffs · 2');
    const rows = [...drawer.el.querySelectorAll<HTMLElement>('.acp-harness__memory-row')];
    expect(rows.map((row) => row.dataset.memoryId)).toEqual(['ho-1', 'ho-2']);
    expect(rows[0].querySelector('.acp-harness__memory-source')?.textContent).toBe('claude-1@mbp');
    expect(rows[0].querySelector('.acp-harness__memory-source')?.getAttribute('title'))
      .toBe('claude-1@mbp');
    expect(rows[0].querySelector('.acp-harness__memory-text')?.textContent)
      .toBe('wire the composer meta segments');
    expect(rows[0].querySelector('.acp-harness__memory-kind')?.textContent).not.toBe('');
  });

  it('opens the detail under the cursor row and closes it again', () => {
    const entries = [entry(), entry({ id: 'ho-2', detail: 'second' })];
    const drawer = mount({ entries, cursorId: 'ho-2' });
    const rows = [...drawer.el.querySelectorAll<HTMLElement>('.acp-harness__memory-row')];
    expect(rows[1].className).toBe('acp-harness__memory-row acp-harness__memory-row--cursor');
    expect(rows[1].querySelector('.acp-harness__memory-detail')?.textContent).toBe('ho-2\n\nsecond');
    expect(rows[0].querySelector('.acp-harness__memory-detail')).toBeNull();

    drawer.update(props({ entries, cursorId: 'ho-1' }));
    const after = [...drawer.el.querySelectorAll<HTMLElement>('.acp-harness__memory-row')];
    expect(after[1]).toBe(rows[1]);
    expect(after[1].className).toBe('acp-harness__memory-row');
    expect(after[1].querySelector('.acp-harness__memory-detail')).toBeNull();
    expect(after[0].querySelector('.acp-harness__memory-detail')?.textContent).toBe('ho-1\n\nphase 6 is next');
  });

  it('marks the handoff the active lane is bound to, and lists its bindings', () => {
    const drawer = mount({
      entries: [entry({ boundLanes: ['claude-1', 'codex-1'] })],
      cursorId: 'ho-1',
      activeLaneLabel: 'codex-1',
    });
    const row = drawer.el.querySelector<HTMLElement>('.acp-harness__memory-row');
    expect(row?.className).toBe('acp-harness__memory-row acp-harness__memory-row--cursor acp-harness__memory-row--bound');
    expect(row?.querySelector('.acp-harness__memory-text')?.textContent)
      .toBe('▸ wire the composer meta segments');
    expect(row?.querySelector('.acp-harness__memory-detail')?.textContent)
      .toBe('ho-1 · bound: claude-1, codex-1\n\nphase 6 is next');
  });

  it('replaces the list with the backend warning, and with the empty hint', () => {
    const drawer = mount({ warning: 'xenon unreachable' });
    expect(drawer.el.querySelector('.acp-harness__memory__title')?.textContent)
      .toBe('Handoffs · unavailable');
    expect(drawer.el.querySelector('.acp-harness__memory__empty')?.textContent)
      .toBe('memory unavailable: xenon unreachable');
    expect(drawer.el.querySelector('.acp-harness__memory-row')).toBeNull();

    drawer.update(props({ entries: [] }));
    expect(drawer.el.querySelector('.acp-harness__memory__empty')?.textContent).toBe('no handoffs yet');
  });

  it('hides while closed', () => {
    const drawer = mount({ open: false });
    expect(drawer.el.hidden).toBe(true);
    expect(drawer.isOpen).toBe(false);
  });

  it('writes nothing when the dependency tuple holds', () => {
    const entries = [entry()];
    const drawer = mount({ entries });
    const observer = new MutationObserver(() => undefined);
    observer.observe(drawer.el, { childList: true, subtree: true, attributes: true, characterData: true });
    drawer.update(props({ entries }));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
