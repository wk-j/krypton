import { afterEach, describe, expect, it, vi } from 'vitest';

import { compile } from '../../genui/compile';
import { initialState } from '../../genui/evaluate';
import type { Program } from '../../genui/ast';
import type { UiFenceEntry } from '../../genui/types';
import { GenUiPanel } from './index';
import type { GenUiPanelProps } from './index';

const source = [
  '$seats = 10',
  'Card("Estimate", [',
  '  Slider($seats, 1, 50, label: "Seats"),',
  '  Metric("Total", "$" + ($seats * 29)),',
  '  Text("static note"),',
  '  Button("Use this", Draft("Plan for " + $seats + " seats"))',
  '])',
].join('\n');

const compiled = compile(source);
const program = compiled.program as Program;

const entry: UiFenceEntry = {
  index: 0,
  source,
  sourceHash: 'hash',
  title: 'Estimate',
  summary: '1 input',
  hintLabel: null,
  program,
  diagnostics: [],
};

const panels: GenUiPanel[] = [];

function open(overrides: Partial<GenUiPanelProps> = {}): GenUiPanel {
  const panel = new GenUiPanel();
  panels.push(panel);
  document.body.appendChild(panel.el);
  panel.update({
    open: true,
    entry,
    state: initialState(program),
    views: new Map<string, Record<string, unknown>>(),
    takeFocus: true,
    onDraft: () => null,
    onOpenUrl: () => undefined,
    onClose: () => undefined,
    ...overrides,
  });
  return panel;
}

function slot(panel: GenUiPanel, text: string): HTMLElement {
  const found = [...panel.el.querySelectorAll<HTMLElement>('.acp-genui__slot')]
    .filter((candidate) => (candidate.textContent ?? '').includes(text));
  return found[found.length - 1];
}

function button(panel: GenUiPanel, label: string): HTMLButtonElement {
  return [...panel.el.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!;
}

afterEach(() => {
  for (const panel of panels.splice(0)) { panel.dispose(); panel.el.remove(); }
});

describe('GenUiPanel', () => {
  it('compiles the shared example used by the tests', () => {
    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(program).not.toBeNull();
  });

  it('repaints only the nodes an input changed', () => {
    const panel = open();
    const note = slot(panel, 'static note');
    const noteNode = note.firstElementChild;
    expect(slot(panel, 'Total').textContent).toContain('$290');

    const range = panel.el.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = '20';
    range.dispatchEvent(new Event('input', { bubbles: true }));

    expect(slot(panel, 'Total').textContent).toContain('$580');
    expect(slot(panel, 'static note')).toBe(note);
    expect(slot(panel, 'static note').firstElementChild).toBe(noteNode);
    expect(panel.el.querySelector('input[type="range"]')).toBe(range);
  });

  it('keeps the retained inputs across a close and reopen', () => {
    const state = initialState(program);
    const panel = open({ state });
    const range = panel.el.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = '20';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    panel.close();
    expect(panel.isOpen).toBe(false);
    panel.update({
      open: true,
      entry,
      state,
      views: new Map<string, Record<string, unknown>>(),
      takeFocus: true,
      onDraft: () => null,
      onOpenUrl: () => undefined,
      onClose: () => undefined,
    });
    expect(panel.el.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe('20');
    expect(slot(panel, 'Total').textContent).toContain('$580');
  });

  it('loads a draft only through its callback and keeps a refusal visible', () => {
    const onDraft = vi.fn(() => 'Composer already has a draft');
    const panel = open({ onDraft });
    button(panel, 'Use this').click();
    expect(onDraft).toHaveBeenCalledWith('Plan for 10 seats');
    expect(panel.isOpen).toBe(true);
    expect(panel.el.querySelector('.acp-genui-panel__feedback')?.textContent).toContain('already has a draft');
  });

  it('closes once the draft is loaded', () => {
    const onDraft = vi.fn(() => null);
    const panel = open({ onDraft });
    button(panel, 'Use this').click();
    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(panel.isOpen).toBe(false);
  });

  it('toggles the source from the head and offers no Close button', () => {
    const onClose = vi.fn();
    const panel = open({ onClose });
    const toggle = button(panel, 'Source');
    expect(toggle.closest('.acp-genui-panel__head')).not.toBeNull();
    expect([...panel.el.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('Close');

    toggle.click();
    expect(panel.el.querySelector('pre')?.textContent).toBe(source);
    expect(panel.el.querySelector('pre')?.querySelector('script')).toBeNull();
    expect(toggle.textContent).toBe('Hide source');
    expect(panel.el.querySelector('pre')?.hidden).toBe(false);

    toggle.click();
    expect(toggle.textContent).toBe('Source');
    expect(panel.el.querySelector('pre')?.hidden).toBe(true);

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    expect(panel.handleKey(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(panel.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rides a roving tabindex over every catalog focusable and leaves native keys alone', () => {
    const panel = open();
    // Ring order, not DOM order: the catalog controls first, then the head's
    // Source toggle, so opening focuses the spec's first control.
    const focusables = [
      ...panel.el.querySelectorAll<HTMLElement>('.acp-genui-panel__body [data-genui-focusable]'),
      button(panel, 'Source'),
    ];
    expect(focusables.length).toBeGreaterThan(2);
    expect(focusables.filter((node) => node.tabIndex === 0)).toHaveLength(1);
    expect(document.activeElement).toBe(focusables[0]);
    expect(document.activeElement).toBe(panel.el.querySelector('input[type="range"]'));

    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    Object.defineProperty(tab, 'target', { value: focusables[0] });
    expect(panel.handleKey(tab)).toBe(true);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[1]);
    expect(focusables[1].tabIndex).toBe(0);
    expect(focusables[0].tabIndex).toBe(-1);

    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    Object.defineProperty(back, 'target', { value: focusables[1] });
    expect(panel.handleKey(back)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);

    const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    Object.defineProperty(arrow, 'target', { value: focusables[1] });
    expect(panel.handleKey(arrow)).toBe(false);
    expect(arrow.defaultPrevented).toBe(false);
  });

  it('swallows a key aimed outside the panel while it is open', () => {
    const panel = open();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    Object.defineProperty(event, 'target', { value: outside });
    expect(panel.handleKey(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    outside.remove();
  });

  it('collapses when its tab hides, telling the host not to take focus back', async () => {
    const tab = document.createElement('div');
    tab.className = 'krypton-tab-wrapper';
    document.body.appendChild(tab);
    const panel = new GenUiPanel();
    panels.push(panel);
    tab.appendChild(panel.el);
    const onClose = vi.fn();
    panel.update({
      open: true,
      entry,
      state: initialState(program),
      views: new Map<string, Record<string, unknown>>(),
      takeFocus: true,
      onDraft: () => null,
      onOpenUrl: () => undefined,
      onClose,
    });
    tab.classList.add('krypton-tab-wrapper--hidden');
    await Promise.resolve();
    expect(panel.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledWith(false);
    tab.remove();
  });

  it('is an inline block that hides itself when collapsed', () => {
    const panel = open();
    expect(panel.el.classList.contains('acp-genui-panel')).toBe(true);
    expect(panel.el.closest('.acp-harness__genui-panel-overlay')).toBeNull();
    expect(panel.el.getAttribute('role')).toBe('group');
    expect(panel.el.getAttribute('aria-modal')).toBeNull();
    expect(panel.el.hidden).toBe(false);
    expect(panel.el.getAttribute('aria-label')).toBe('Estimate');
    expect(panel.el.querySelector('.acp-genui-panel__legend')?.textContent).toContain('Esc closes');

    panel.close();
    expect(panel.el.hidden).toBe(true);
    expect(panel.el.querySelector('.acp-genui-panel__body')?.children).toHaveLength(0);
  });

  it('drops the outermost Card frame the card head already titles, and keeps one it does not', () => {
    const panel = open();
    const body = panel.el.querySelector('.acp-genui-panel__body')!;
    expect(body.querySelector('.acp-genui__card')).toBeNull();
    // Only the hidden source block still carries that text.
    expect(body.textContent).not.toContain('Estimate');
    // The children took the frame's place, in order.
    expect(body.children).toHaveLength(4);
    expect(panel.el.querySelector('input[type="range"]')).not.toBeNull();

    // Computed title ⇒ the head shows the component name, so the frame is the
    // only place that title is printed and it stays.
    const other = open({ entry: { ...entry, title: 'Card' } });
    expect(other.el.querySelector('.acp-genui__card-title')?.textContent).toBe('Estimate');
  });

  it('keeps its mounted DOM when the host moves the node to another seat', () => {
    const panel = open();
    const range = panel.el.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = '20';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    const seat = document.createElement('div');
    document.body.appendChild(seat);

    seat.appendChild(panel.el);

    expect(panel.isOpen).toBe(true);
    expect(panel.el.querySelector('input[type="range"]')).toBe(range);
    expect(slot(panel, 'Total').textContent).toContain('$580');
    seat.remove();
  });
});
