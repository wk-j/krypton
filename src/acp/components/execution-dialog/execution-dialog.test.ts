import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionPayload, ExecutionView } from '../../harness-view-types';
import { OverlayShell } from '../overlay-shell';
import { ExecutionDialog, type ExecutionDialogProps } from './index';

const payload: ExecutionPayload = {
  source: 'omp', language: 'js', title: 'Inspect values', code: 'const total = 1;\nconsole.log(total);',
  output: 'first line', observedLive: true, cellStatus: 'running', durationMs: null,
  exitCode: null, isError: false, activity: [], views: [], detached: null, truncated: [],
};
const dialogs: ExecutionDialog[] = [];
const props = (data: ExecutionPayload, overrides: Partial<ExecutionDialogProps> = {}): ExecutionDialogProps => ({
  open: true, targetId: 'item-1', payload: data, status: 'in_progress', startedAt: 10,
  takeFocus: false, onClose: () => undefined, ...overrides,
});

function open(data: ExecutionPayload = payload, overrides: Partial<ExecutionDialogProps> = {}): ExecutionDialog {
  const dialog = new ExecutionDialog();
  dialogs.push(dialog);
  document.body.append(dialog.el);
  dialog.update(props(data, overrides));
  return dialog;
}

function button(dialog: ExecutionDialog, name: RegExp): HTMLButtonElement {
  const match = [...dialog.el.querySelectorAll('button')].find((candidate) => name.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''));
  if (!match) throw new Error(`Missing control ${name}`);
  return match;
}

function region(dialog: ExecutionDialog, label: string): HTMLElement {
  const node = dialog.el.querySelector<HTMLElement>(`[role="region"][aria-label="${label}"]`);
  if (!node) throw new Error(`Missing region ${label}`);
  return node;
}

function selectedTab(dialog: ExecutionDialog): string {
  return dialog.el.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? '';
}

function visiblePanel(dialog: ExecutionDialog): HTMLElement {
  const panels = [...dialog.el.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((node) => !node.hidden);
  expect(panels).toHaveLength(1);
  return panels[0];
}

function press(dialog: ExecutionDialog, key: string, init: KeyboardEventInit = {}): { handled: boolean; prevented: boolean } {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
  const handled = dialog.handleKey(event);
  return { handled, prevented: event.defaultPrevented };
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  for (const dialog of dialogs.splice(0)) dialog.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ExecutionDialog', () => {
  it('opens as a labelled modal on the Output section with focus on its tab, and keeps nodes through stream and completion', () => {
    const dialog = open(payload, { takeFocus: true });
    const modal = dialog.el.querySelector('[role="dialog"]')!;
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(modal.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Inspect values');
    expect(selectedTab(dialog)).toContain('Output');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    const source = dialog.el.querySelector('code')!;
    const syntax = source.firstChild;
    const output = region(dialog, 'Execution output');
    const text = output.querySelector('pre')!.firstChild;
    dialog.update(props({ ...payload, output: 'first line\nsecond line' }, { takeFocus: true }));
    dialog.update(props({ ...payload, output: 'first line\nsecond line', cellStatus: 'complete', durationMs: 13, exitCode: 0 }, { status: 'completed', takeFocus: true }));
    expect(dialog.el.querySelector('code')).toBe(source);
    expect(source.firstChild).toBe(syntax);
    expect(region(dialog, 'Execution output')).toBe(output);
    expect(output.querySelector('pre')!.firstChild).toBe(text);
    expect(output.textContent).toBe('first line\nsecond line');
    expect(selectedTab(dialog)).toContain('2 lines');
  });

  it('summarizes status, runtime provenance, exit code and background job without inventing values', () => {
    const dialog = open();
    const summary = dialog.el.querySelector('dl')!;
    expect(summary.textContent).toContain('Running');
    expect(summary.textContent).toContain('observed');
    const exit = [...summary.querySelectorAll('div')].find((node) => node.textContent?.startsWith('Exit code'))!;
    expect(exit.hidden).toBe(true);
    dialog.update(props({ ...payload, cellStatus: 'error', exitCode: 1, durationMs: 40, isError: true }, { status: 'failed' }));
    expect(summary.textContent).toContain('Error');
    expect(summary.textContent).toContain('runtime');
    expect(exit.hidden).toBe(false);
    expect(exit.textContent).toContain('1');
    dialog.update(props({ ...payload, observedLive: false, cellStatus: 'complete' }, { status: 'completed', targetId: 'replay' }));
    const runtime = [...summary.querySelectorAll('div')].find((node) => node.textContent?.startsWith('Time'))!;
    expect(runtime.hidden).toBe(true);
    dialog.update(props({ ...payload, detached: { jobId: 'job-7', state: 'running' } }, { status: 'completed', targetId: 'bg' }));
    expect(summary.textContent).toContain('Background · last reported');
    expect(summary.textContent).toContain('job-7 · running');
    expect(summary.querySelector('[data-started-at]')).toBeNull();
  });

  it('switches sections by number, arrow keys on a focused tab and clicks, and keeps the choice across reopen', () => {
    const dialog = open(payload, { takeFocus: true });
    expect(press(dialog, '1')).toEqual({ handled: true, prevented: true });
    expect(selectedTab(dialog)).toContain('Code');
    expect(visiblePanel(dialog).contains(dialog.el.querySelector('code'))).toBe(true);
    expect(document.activeElement?.textContent).toContain('Code');
    press(dialog, 'ArrowLeft');
    expect(selectedTab(dialog)).toContain('Activity');
    expect(visiblePanel(dialog).textContent).toContain('No activity reported.');
    press(dialog, 'ArrowRight');
    expect(selectedTab(dialog)).toContain('Code');
    const outputTab = [...dialog.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Output'))!;
    outputTab.click();
    expect(selectedTab(dialog)).toContain('Output');
    press(dialog, '3');
    dialog.close();
    dialog.update(props(payload, { targetId: 'item-2', takeFocus: true }));
    expect(selectedTab(dialog)).toContain('Activity');
  });

  it('keeps code and hostile structured output inert', () => {
    const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const view: ExecutionView = { kind: 'table', text: 'table display', columns: [{ head: attack }], rows: [[attack]] };
    const source = `console.log(${JSON.stringify(attack)});`;
    const dialog = open({ ...payload, code: source, output: view.text, views: [view],
      activity: [{ op: 'log', text: attack, detail: '' }] });
    expect(dialog.el.querySelector('code')?.textContent).toBe(source);
    expect(dialog.el.querySelector('td')?.textContent).toBe(attack);
    expect(dialog.el.querySelectorAll('script, img, iframe')).toHaveLength(0);
    expect(region(dialog, 'Execution output').textContent).not.toContain(view.text);
    expect(dialog.el.querySelector('li')?.textContent).toContain(attack);
  });

  it('replaces recognized text with table/JSON only once and toggles Raw/Formatted by button and r', () => {
    const table: ExecutionView = { kind: 'table', text: 'serialized table', columns: [{ head: 'Count', numeric: true }], rows: [['7']] };
    const json: ExecutionView = { kind: 'json', text: 'serialized json', json: '{\n  "ok": true\n}' };
    const data = { ...payload, output: `before\n${table.text}\n${json.text}\nafter`, views: [table, json] };
    const dialog = open(data);
    const output = region(dialog, 'Execution output');
    expect(output.querySelectorAll('table')).toHaveLength(1);
    expect(output.textContent).toContain(json.json);
    expect(output.textContent).not.toContain('serialized');
    const tableNode = output.querySelector('table');
    dialog.update(props({ ...data, output: `${data.output}\nappended`, views: [{ ...table }, { ...json }] }));
    expect(output.querySelector('table')).toBe(tableNode);
    button(dialog, /^Raw$/).click();
    expect(output.querySelector('table')).toBeNull();
    expect(output.textContent).toBe(`${data.output}\nappended`);
    expect(button(dialog, /^Raw$/).getAttribute('aria-pressed')).toBe('true');
    press(dialog, 'r');
    expect(output.querySelectorAll('table')).toHaveLength(1);
    expect(output.textContent).not.toContain('serialized');
  });

  it('retains ambiguous rich-view text instead of hiding or duplicating it', () => {
    const view: ExecutionView = { kind: 'table', text: 'same', columns: [{ head: 'Value' }], rows: [['safe']] };
    const dialog = open({ ...payload, output: 'same\nsame', views: [view] });
    expect(region(dialog, 'Execution output').textContent).toBe('same\nsame');
    expect(region(dialog, 'Execution output').querySelector('table')).toBeNull();
  });

  it('copies the latest retained source by button and c, and reports clipboard rejection', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const dialog = open();
    press(dialog, 'c');
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith(payload.code);
    expect(dialog.el.querySelector('[role="status"]')?.textContent).toMatch(/copied/i);
    const changed = { ...payload, code: 'retained prefix', truncated: ['code'] as const };
    dialog.update(props(changed));
    button(dialog, /Copy shown code/i).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith(changed.code);
    expect(dialog.el.querySelector('[role="status"]')?.textContent).toMatch(/incomplete/i);
    writeText.mockRejectedValueOnce(new Error('denied'));
    button(dialog, /^Copy/).click();
    await Promise.resolve();
    expect(dialog.el.querySelector('[role="status"]')?.textContent).toMatch(/failed/i);
  });

  it('discards stale copy completion after source changes', async () => {
    const dialog = open();
    vi.stubGlobal('navigator', { clipboard: { writeText: (): Promise<void> => Promise.resolve() } });
    button(dialog, /^Copy/).click();
    dialog.update(props({ ...payload, code: 'changed source' }));
    await Promise.resolve();
    expect(dialog.el.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('traps Tab inside the dialog, leaves native and Cmd keys alone, and closes with Escape once', () => {
    const onClose = vi.fn<(restoreFocus: boolean) => void>();
    const dialog = open(payload, { onClose, takeFocus: true });
    const tabbables = [...dialog.el.querySelectorAll<HTMLElement>('button, [tabindex]')]
      .filter((node) => node.tabIndex >= 0 && !node.closest('[hidden]'));
    tabbables[tabbables.length - 1].focus();
    expect(press(dialog, 'Tab').handled).toBe(true);
    expect(document.activeElement).toBe(tabbables[0]);
    press(dialog, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(tabbables[tabbables.length - 1]);
    expect(press(dialog, 'Enter')).toEqual({ handled: false, prevented: false });
    expect(press(dialog, 'c', { metaKey: true })).toEqual({ handled: false, prevented: false });
    expect(press(dialog, 'x')).toEqual({ handled: true, prevented: true });
    expect(press(dialog, 'Escape').handled).toBe(true);
    expect(dialog.isOpen).toBe(false);
    expect(dialog.el.hidden).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    dialog.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(press(dialog, '1').handled).toBe(false);
  });

  it('focuses pointer-pressed controls and closes from the scrim but not from inside the panel', () => {
    const onClose = vi.fn<(restoreFocus: boolean) => void>();
    const dialog = open(payload, { onClose });
    const copy = button(dialog, /^Copy/);
    copy.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.activeElement).toBe(copy);
    dialog.el.querySelector<HTMLElement>('[role="dialog"]')!.click();
    expect(dialog.isOpen).toBe(true);
    dialog.el.click();
    expect(dialog.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('closes without reclaiming focus when another overlay opens or its enclosing tab is hidden', async () => {
    const onClose = vi.fn<(restoreFocus: boolean) => void>();
    const dialog = open(payload, { onClose });
    const other = new OverlayShell();
    other.update({ open: true, name: 'other', block: 'acp-other', title: 'Other', body: document.createElement('div') });
    expect(dialog.isOpen).toBe(false);
    expect(dialog.el.hidden).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    other.dispose();

    const tab = document.createElement('div');
    tab.className = 'krypton-tab-wrapper';
    document.body.append(tab);
    const hosted = new ExecutionDialog();
    dialogs.push(hosted);
    tab.append(hosted.el);
    const onHiddenClose = vi.fn<(restoreFocus: boolean) => void>();
    hosted.update(props(payload, { onClose: onHiddenClose }));
    tab.classList.add('krypton-tab-wrapper--hidden');
    await Promise.resolve();
    expect(hosted.isOpen).toBe(false);
    expect(onHiddenClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('preserves selected output and a scrolled-up viewport while appending, and follows only from the bottom', () => {
    const dialog = open();
    const output = region(dialog, 'Execution output');
    let height = 1000;
    Object.defineProperties(output, { scrollHeight: { get: (): number => height }, clientHeight: { value: 100 } });
    output.scrollTop = 150;
    const text = output.querySelector('pre')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    document.getSelection()?.addRange(range);
    dialog.update(props({ ...payload, output: 'first line\nappended output' }));
    expect(output.scrollTop).toBe(150);
    expect(document.getSelection()?.toString()).toBe('first');
    expect(document.getSelection()?.anchorNode).toBe(text);
    output.scrollTop = 900;
    dialog.update(props({ ...payload, output: 'first line\nappended output\nmore' }));
    expect(output.scrollTop).toBe(height);
    height = 1200;
    output.scrollTop = 300;
    dialog.update(props({ ...payload, output: 'replacement snapshot' }));
    expect(output.scrollTop).toBe(300);
    expect(output.textContent).toBe('replacement snapshot');
  });

  it('scrolls the selected section with j/k and g/G', () => {
    const dialog = open();
    const output = region(dialog, 'Execution output');
    Object.defineProperty(output, 'scrollHeight', { get: (): number => 900 });
    press(dialog, 'j');
    press(dialog, 'j');
    expect(output.scrollTop).toBe(120);
    press(dialog, 'k');
    expect(output.scrollTop).toBe(60);
    press(dialog, 'G');
    expect(output.scrollTop).toBe(900);
    press(dialog, 'g');
    expect(output.scrollTop).toBe(0);
  });

  it('shows only supplied activity snapshots, emphasizes the latest reported phase, and replaces removed events', () => {
    const first = { op: 'phase', text: 'Read inputs', detail: '' };
    const second = { op: 'phase', text: 'Summarize', detail: '' };
    const dialog = open({ ...payload, activity: [first, { op: 'log', text: 'Backend note', detail: '' }, second] });
    const items = (): HTMLElement[] => [...dialog.el.querySelectorAll<HTMLElement>('li')];
    const firstNode = items()[0];
    expect(items().map((node) => node.classList.contains('acp-execution-dialog__event--current'))).toEqual([false, false, true]);
    dialog.update(props({ ...payload, activity: [first] }));
    expect(items()).toHaveLength(1);
    expect(items()[0]).toBe(firstNode);
    expect(firstNode.classList.contains('acp-execution-dialog__event--current')).toBe(true);
    dialog.update(props({ ...payload, activity: [] }));
    expect(items()).toHaveLength(0);
  });
});
