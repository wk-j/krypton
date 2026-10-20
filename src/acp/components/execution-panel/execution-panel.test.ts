import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionPayload, ExecutionView } from '../../harness-view-types';
import { ExecutionPanel, type ExecutionPanelProps } from './index';

const payload: ExecutionPayload = {
  source: 'omp', language: 'js', title: 'Inspect values', code: 'const total = 1;\nconsole.log(total);',
  output: 'first line', observedLive: true, cellStatus: 'running', durationMs: null,
  exitCode: null, isError: false, activity: [], views: [], detached: null, truncated: [],
};
const panels: ExecutionPanel[] = [];
const props = (data: ExecutionPayload, overrides: Partial<ExecutionPanelProps> = {}): ExecutionPanelProps => ({
  open: true, payload: data, status: 'in_progress', takeFocus: false, onClose: () => undefined, ...overrides,
});

function open(data: ExecutionPayload = payload, overrides: Partial<ExecutionPanelProps> = {}): ExecutionPanel {
  const panel = new ExecutionPanel();
  panels.push(panel);
  document.body.append(panel.el);
  panel.update(props(data, overrides));
  return panel;
}

function button(panel: ExecutionPanel, name: RegExp): HTMLButtonElement {
  const match = [...panel.el.querySelectorAll('button')].find((candidate) => name.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''));
  if (!match) throw new Error(`Missing control ${name}`);
  return match;
}

function output(panel: ExecutionPanel): HTMLElement {
  const node = panel.el.querySelector<HTMLElement>('[role="region"]');
  if (!node) throw new Error('Missing output region');
  return node;
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  for (const panel of panels.splice(0)) panel.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ExecutionPanel', () => {
  it('retains source, controls, focus and appended output nodes through stream and completion', () => {
    const panel = open(payload, { takeFocus: true });
    const source = panel.el.querySelector('code')!;
    const syntax = source.firstChild;
    const copy = button(panel, /^Copy/);
    copy.focus();
    const region = output(panel);
    const text = region.querySelector('pre')!.firstChild;
    panel.update(props({ ...payload, output: 'first line\nsecond line' }, { takeFocus: true }));
    panel.update(props({ ...payload, output: 'first line\nsecond line', cellStatus: 'complete', durationMs: 13 }, { status: 'completed', takeFocus: true }));
    expect(panel.el.querySelector('code')).toBe(source);
    expect(source.firstChild).toBe(syntax);
    expect(button(panel, /^Copy/)).toBe(copy);
    expect(document.activeElement).toBe(copy);
    expect(output(panel)).toBe(region);
    expect(region.querySelector('pre')!.firstChild).toBe(text);
    expect(region.textContent).toBe('first line\nsecond line');
  });

  it('keeps code and hostile structured output inert', () => {
    const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const view: ExecutionView = { kind: 'table', text: 'table display', columns: [{ head: attack }], rows: [[attack]] };
    const source = `console.log(${JSON.stringify(attack)});`;
    const panel = open({ ...payload, code: source, output: view.text, views: [view],
      activity: [{ op: 'log', text: attack, detail: '' }] });
    expect(panel.el.querySelector('code')?.textContent).toBe(source);
    expect(panel.el.querySelector('td')?.textContent).toBe(attack);
    expect(panel.el.querySelectorAll('script, img, iframe')).toHaveLength(0);
    expect(output(panel).textContent).not.toContain(view.text);
    expect(panel.el.querySelector('li')?.textContent).toContain(attack);
  });

  it('replaces recognized text with table/JSON only once and supports native Raw/Formatted controls', () => {
    const table: ExecutionView = { kind: 'table', text: 'serialized table', columns: [{ head: 'Count', numeric: true }], rows: [['7']] };
    const json: ExecutionView = { kind: 'json', text: 'serialized json', json: '{\n  "ok": true\n}' };
    const data = { ...payload, output: `before\n${table.text}\n${json.text}\nafter`, views: [table, json] };
    const panel = open(data);
    const region = output(panel);
    expect(region.querySelectorAll('table')).toHaveLength(1);
    expect(region.textContent).toContain(json.json);
    expect(region.textContent).not.toContain('serialized');
    const tableNode = region.querySelector('table');
    panel.update(props({ ...data, output: `${data.output}\nappended`, views: [{ ...table }, { ...json }] }));
    expect(region.querySelector('table')).toBe(tableNode);
    expect(region.querySelectorAll('table')).toHaveLength(1);
    button(panel, /^Raw$/).click();
    expect(region.querySelector('table')).toBeNull();
    expect(region.textContent).toBe(`${data.output}\nappended`);
    expect(button(panel, /^Raw$/).getAttribute('aria-pressed')).toBe('true');
    button(panel, /^Formatted$/).click();
    expect(region.querySelectorAll('table')).toHaveLength(1);
    expect(region.textContent).not.toContain('serialized');
  });

  it('retains ambiguous rich-view text instead of hiding or duplicating it', () => {
    const view: ExecutionView = { kind: 'table', text: 'same', columns: [{ head: 'Value' }], rows: [['safe']] };
    const panel = open({ ...payload, output: 'same\nsame', views: [view] });
    expect(output(panel).textContent).toBe('same\nsame');
    expect(output(panel).querySelector('table')).toBeNull();
  });

  it('keeps a Code disclosure closed during output updates and changes retained source on source updates', () => {
    const panel = open();
    const codeButton = button(panel, /^Code$/);
    const code = panel.el.querySelector('code')!;
    codeButton.click();
    expect(codeButton.getAttribute('aria-expanded')).toBe('false');
    expect(code.closest('[hidden]')).not.toBeNull();
    panel.update(props({ ...payload, output: 'new output' }));
    expect(codeButton.getAttribute('aria-expanded')).toBe('false');
    expect(code.textContent).toBe(payload.code);
    panel.update(props({ ...payload, code: 'print("updated")', language: 'py' }));
    expect(code.textContent).toBe('print("updated")');
    codeButton.click();
    expect(code.closest('[hidden]')).toBeNull();
    expect(codeButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('copies the latest retained source and reports clipboard rejection without a timer', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const panel = open();
    button(panel, /^Copy/).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith(payload.code);
    expect(panel.el.querySelector('[role="status"]')?.textContent).toMatch(/copied/i);
    const changed = { ...payload, code: 'retained prefix', truncated: ['code'] as const };
    panel.update(props(changed));
    button(panel, /Copy shown code/i).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith(changed.code);
    expect(panel.el.querySelector('[role="status"]')?.textContent).toMatch(/incomplete/i);
    writeText.mockRejectedValueOnce(new Error('denied'));
    button(panel, /^Copy/).click();
    await Promise.resolve();
    expect(panel.el.querySelector('[role="status"]')?.textContent).toMatch(/failed/i);
  });

  it('discards stale copy completion after source changes', async () => {
    const panel = open();
    vi.stubGlobal('navigator', { clipboard: { writeText: (): Promise<void> => Promise.resolve() } });
    button(panel, /^Copy/).click();
    panel.update(props({ ...payload, code: 'changed source' }));
    await Promise.resolve();
    expect(panel.el.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('leaves composer keys and focus alone while open but unfocused, including during streams', () => {
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();
    const panel = open();
    expect(document.activeElement).toBe(composer);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    expect(panel.handleKey(escape)).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
    panel.update(props({ ...payload, output: 'streamed' }));
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it('focuses pointer-pressed controls, cycles Tab, leaves native keys alone and closes with Escape', () => {
    const onClose = vi.fn<(restoreFocus: boolean) => void>();
    const panel = open(payload, { onClose });
    const copy = button(panel, /^Copy/);
    copy.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.hasFocus).toBe(true);
    expect(document.activeElement).toBe(copy);
    const native = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    expect(panel.handleKey(native)).toBe(false);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    expect(panel.handleKey(tab)).toBe(true);
    expect(document.activeElement).not.toBe(copy);
    expect(panel.el.contains(document.activeElement)).toBe(true);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    expect(panel.handleKey(escape)).toBe(true);
    expect(panel.isOpen).toBe(false);
    expect(panel.el.hidden).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    panel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without reclaiming focus when its enclosing tab is hidden', async () => {
    const tab = document.createElement('div');
    tab.className = 'krypton-tab-wrapper';
    document.body.append(tab);
    const panel = new ExecutionPanel();
    panels.push(panel);
    tab.append(panel.el);
    const onClose = vi.fn<(restoreFocus: boolean) => void>();
    panel.update(props(payload, { onClose }));
    tab.classList.add('krypton-tab-wrapper--hidden');
    await Promise.resolve();
    expect(panel.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    tab.remove();
  });

  it('preserves selected output and a scrolled-up viewport while appending, and follows only from the bottom', () => {
    const panel = open();
    const region = output(panel);
    let height = 1000;
    Object.defineProperties(region, { scrollHeight: { get: (): number => height }, clientHeight: { value: 100 } });
    region.scrollTop = 150;
    const text = region.querySelector('pre')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    document.getSelection()?.addRange(range);
    panel.update(props({ ...payload, output: 'first line\nappended output' }));
    expect(region.scrollTop).toBe(150);
    expect(document.getSelection()?.toString()).toBe('first');
    expect(document.getSelection()?.anchorNode).toBe(text);
    region.scrollTop = 900;
    panel.update(props({ ...payload, output: 'first line\nappended output\nmore' }));
    expect(region.scrollTop).toBe(height);
    height = 1200;
    region.scrollTop = 300;
    panel.update(props({ ...payload, output: 'replacement snapshot' }));
    expect(region.scrollTop).toBe(300);
    expect(region.textContent).toBe('replacement snapshot');
  });

  it('shows only supplied activity snapshots and replaces removed events', () => {
    const first = { op: 'phase', text: 'Read inputs', detail: '' };
    const panel = open({ ...payload, activity: [first, { op: 'log', text: 'Backend note', detail: '' }] });
    const firstNode = panel.el.querySelector('li');
    panel.update(props({ ...payload, activity: [first] }));
    expect(panel.el.querySelectorAll('li')).toHaveLength(1);
    expect(panel.el.querySelector('li')).toBe(firstNode);
    expect(panel.el.querySelector('li')?.textContent).not.toContain('Backend note');
    panel.update(props({ ...payload, activity: [] }));
    expect(panel.el.querySelectorAll('li')).toHaveLength(0);
  });
});
