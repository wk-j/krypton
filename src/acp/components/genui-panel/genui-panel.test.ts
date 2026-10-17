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

  it('shows the exact source as text and closes on Escape', () => {
    const onClose = vi.fn();
    const panel = open({ onClose });
    button(panel, 'Source').click();
    expect(panel.el.querySelector('pre')?.textContent).toBe(source);
    expect(panel.el.querySelector('pre')?.querySelector('script')).toBeNull();
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    expect(panel.handleKey(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(panel.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rides a roving tabindex over every catalog focusable and leaves native keys alone', () => {
    const panel = open();
    const focusables = [...panel.el.querySelectorAll<HTMLElement>('[data-genui-focusable]')];
    expect(focusables.length).toBeGreaterThan(2);
    expect(focusables.filter((node) => node.tabIndex === 0)).toHaveLength(1);
    expect(document.activeElement).toBe(focusables[0]);

    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    Object.defineProperty(tab, 'target', { value: focusables[0] });
    expect(panel.handleKey(tab)).toBe(true);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[1]);
    expect(focusables[1].tabIndex).toBe(0);
    expect(focusables[0].tabIndex).toBe(-1);

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

  it('closes when its tab hides without taking focus back', async () => {
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
      onDraft: () => null,
      onOpenUrl: () => undefined,
      onClose,
    });
    tab.classList.add('krypton-tab-wrapper--hidden');
    await Promise.resolve();
    expect(panel.isOpen).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    tab.remove();
  });
});
