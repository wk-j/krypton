import { describe, expect, it } from 'vitest';

import type { PlanEntry } from '../../types';
import { PlanPanel } from './index';

function entry(content: string, status: PlanEntry['status'], priority?: PlanEntry['priority']): PlanEntry {
  return priority ? { content, status, priority } : { content, status };
}

const PLAN: PlanEntry[] = [
  entry('extract kernel', 'completed'),
  entry('wire composer meta segments', 'in_progress', 'high'),
  entry('delete signature', 'pending'),
];

const entries = (panel: PlanPanel): HTMLElement[] =>
  [...panel.el.querySelectorAll<HTMLElement>('.acp-harness__plan-entry')];

describe('PlanPanel', () => {
  it('emits header, progress bar and the marked entry rows', () => {
    const panel = new PlanPanel();
    panel.update({ entries: PLAN, collapsed: false });

    expect(panel.el.className).toBe('acp-harness__plan');
    expect(panel.el.hidden).toBe(false);
    expect(panel.el.title).toBe('p collapse');
    expect(panel.el.querySelector('.acp-harness__plan-title')?.textContent).toBe('plan');
    expect(panel.el.querySelector('.acp-harness__plan-count')?.textContent).toBe('1 / 3');
    expect(panel.el.querySelector('.acp-harness__plan-count b')?.textContent).toBe('1');
    expect(panel.el.querySelector<HTMLElement>('.acp-harness__plan-progress-fill')?.style.width)
      .toBe('33%');
    expect(entries(panel).map((row) => `${row.className}|${row.textContent}`)).toEqual([
      'acp-harness__plan-entry acp-harness__plan-entry--completed|✓extract kernel',
      'acp-harness__plan-entry acp-harness__plan-entry--in_progress|▸wire composer meta segmentshigh',
      'acp-harness__plan-entry acp-harness__plan-entry--pending|·delete signature',
    ]);
    expect(panel.el.querySelector('.acp-harness__plan-priority')?.textContent).toBe('high');
  });

  it('keeps the other entries when one step completes', () => {
    const panel = new PlanPanel();
    panel.update({ entries: PLAN, collapsed: false });
    const nodes = entries(panel);

    panel.update({
      entries: [
        entry('extract kernel', 'completed'),
        entry('wire composer meta segments', 'completed', 'high'),
        entry('delete signature', 'in_progress'),
      ],
      collapsed: false,
    });

    expect(entries(panel)).toEqual(nodes);
    expect(nodes[0].className).toBe('acp-harness__plan-entry acp-harness__plan-entry--completed');
    expect(nodes[2].className).toBe('acp-harness__plan-entry acp-harness__plan-entry--in_progress');
    expect(panel.el.querySelector('.acp-harness__plan-count')?.textContent).toBe('2 / 3');
    expect(panel.el.querySelector<HTMLElement>('.acp-harness__plan-progress-fill')?.style.width)
      .toBe('67%');
  });

  it('drops the priority tag when the step stops being high', () => {
    const panel = new PlanPanel();
    panel.update({ entries: PLAN, collapsed: false });
    expect(panel.el.querySelector('.acp-harness__plan-priority')).not.toBeNull();

    panel.update({
      entries: [
        entry('extract kernel', 'completed'),
        entry('wire composer meta segments', 'in_progress'),
        entry('delete signature', 'pending'),
      ],
      collapsed: false,
    });
    expect(panel.el.querySelector('.acp-harness__plan-priority')).toBeNull();
  });

  it('hides the entry list while collapsed and brings it back', () => {
    const panel = new PlanPanel();
    panel.update({ entries: PLAN, collapsed: true });

    expect(panel.el.className).toBe('acp-harness__plan acp-harness__plan--collapsed');
    expect(panel.el.title).toBe('p expand');
    expect(panel.el.querySelector('.acp-harness__plan-entries')).toBeNull();
    expect(panel.el.querySelector('.acp-harness__plan-count')?.textContent).toBe('1 / 3');

    panel.update({ entries: PLAN, collapsed: false });
    expect(panel.el.className).toBe('acp-harness__plan');
    expect(entries(panel).length).toBe(3);
  });

  it('hides itself when the lane has no plan', () => {
    const panel = new PlanPanel();
    panel.update({ entries: PLAN, collapsed: false });
    panel.update({ entries: [], collapsed: false });

    expect(panel.el.hidden).toBe(true);
    expect(panel.el.children.length).toBe(0);
    expect(panel.el.hasAttribute('title')).toBe(false);
  });

  it('writes nothing while the entry array holds', () => {
    const panel = new PlanPanel();
    const same = { entries: PLAN, collapsed: false };
    panel.update(same);

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(panel.el, { subtree: true, childList: true, attributes: true, characterData: true });
    panel.update(same);
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });

  it('escapes nothing by hand — entry text goes through the DOM', () => {
    const panel = new PlanPanel();
    panel.update({ entries: [entry('<b>bold</b>', 'pending')], collapsed: false });
    expect(panel.el.querySelector('.acp-harness__plan-entry-text b')).toBeNull();
    expect(panel.el.querySelector('.acp-harness__plan-entry-text')?.textContent)
      .toBe('<b>bold</b>');
  });

  it('marks the phase that drives the card tone', () => {
    const panel = new PlanPanel();
    panel.update({ entries: PLAN, collapsed: false });
    expect(panel.el.dataset.phase).toBe('active');

    panel.update({
      entries: [entry('extract kernel', 'completed'), entry('delete signature', 'pending')],
      collapsed: false,
    });
    expect(panel.el.dataset.phase).toBe('idle');

    panel.update({
      entries: [entry('extract kernel', 'completed'), entry('delete signature', 'completed')],
      collapsed: true,
    });
    expect(panel.el.dataset.phase).toBe('done');

    panel.update({ entries: [], collapsed: false });
    expect(panel.el.hasAttribute('data-phase')).toBe(false);
  });

  it('tears its entries down on dispose', () => {
    const panel = new PlanPanel();
    panel.update({ entries: PLAN, collapsed: false });
    panel.dispose();
    expect(panel.el.querySelectorAll('.acp-harness__plan-entry').length).toBe(0);
  });
});
