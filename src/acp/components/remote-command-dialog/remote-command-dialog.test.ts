import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteCommandPayload } from '../../harness-view-types';
import { RemoteCommandDialog, type RemoteCommandDialogProps } from './index';

const payload: RemoteCommandPayload = {
  source: 'mcp', computerId: 'build', command: 'printf "hello"\npwd', cwd: null, error: null, outcomeUnknown: false, displayTruncated: [],
  result: { exitCode: 0, outcome: 'completed', stdout: '  first\nsecond', stderr: 'warning', truncated: false },
};
const dialogs: RemoteCommandDialog[] = [];
function props(over: Partial<RemoteCommandDialogProps> = {}): RemoteCommandDialogProps {
  return { open: true, targetId: 'tool-1', payload, status: 'completed', takeFocus: false, onClose: () => undefined, ...over };
}
function open(over: Partial<RemoteCommandDialogProps> = {}): RemoteCommandDialog {
  const dialog = new RemoteCommandDialog(); dialogs.push(dialog); document.body.append(dialog.el); dialog.update(props(over)); return dialog;
}
function press(dialog: RemoteCommandDialog, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey, cancelable: true });
  const handled = dialog.handleKey(event);
  expect(event.defaultPrevented).toBe(handled);
  return handled;
}
function panel(dialog: RemoteCommandDialog, name: string): HTMLElement {
  const match = dialog.el.querySelector<HTMLElement>(`[role="tabpanel"][aria-label="${name}"]`);
  if (!match) throw new Error(`Missing ${name}`);
  return match;
}
function value(dialog: RemoteCommandDialog, label: string): HTMLElement {
  const match = [...dialog.el.querySelectorAll('dt')].find((node) => node.textContent === label)?.nextElementSibling;
  if (!(match instanceof HTMLElement)) throw new Error(`Missing field ${label}`);
  return match;
}
afterEach(() => { for (const dialog of dialogs.splice(0)) dialog.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('RemoteCommandDialog', () => {
  it('opens a labelled modal with requested values and separates stdout, stderr and exit', () => {
    const dialog = open({ takeFocus: true });
    expect(dialog.isOpen).toBe(true);
    const modal = dialog.el.querySelector('[role="dialog"]')!;
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(modal.getAttribute('aria-labelledby')!)?.textContent).toBe('Remote command');
    expect(document.activeElement?.textContent).toBe('Command');
    expect(panel(dialog, 'Command').hidden).toBe(false);
    expect(value(dialog, 'Requested command').textContent).toBe(payload.command);
    expect(value(dialog, 'Working directory (explicit request)').textContent).toBe('Not reported');
    expect(value(dialog, 'stdout').textContent).toBe('  first\nsecond');
    expect(value(dialog, 'stderr').textContent).toBe('warning');
    expect(value(dialog, 'Remote exit code').textContent).toBe('0');
    expect(dialog.el.querySelector('[data-started-at]')).toBeNull();
  });

  it('switches sections with Tab/ShiftTab and clicks, and leaves native copy/selection keys alone', () => {
    const onClose = vi.fn();
    const dialog = open({ takeFocus: true, onClose });
    expect(press(dialog, 'Tab')).toBe(true);
    expect(panel(dialog, 'Output').hidden).toBe(false);
    expect(document.activeElement?.textContent).toBe('Output');
    press(dialog, 'Tab');
    expect(panel(dialog, 'Result').hidden).toBe(false);
    press(dialog, 'Tab', true);
    expect(panel(dialog, 'Output').hidden).toBe(false);
    const command = dialog.el.querySelector<HTMLButtonElement>('[data-tab-id="command"]')!;
    command.click();
    expect(panel(dialog, 'Command').hidden).toBe(false);
    expect(press(dialog, 'c')).toBe(false);
    expect(press(dialog, 'ArrowDown', true)).toBe(false);
    const copy = new KeyboardEvent('keydown', { key: 'c', metaKey: true, cancelable: true });
    expect(dialog.handleKey(copy)).toBe(false);
    expect(copy.defaultPrevented).toBe(false);
    expect(press(dialog, 'Escape')).toBe(true);
    expect(dialog.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    expect(press(dialog, 'Tab')).toBe(false);
  });

  it('keeps output nodes, earlier text nodes and scroll while updates append or settle', () => {
    const dialog = open({ status: 'in_progress', payload: { ...payload, result: { ...payload.result!, exitCode: null } } });
    press(dialog, 'Tab');
    const output = panel(dialog, 'Output');
    const pre = value(dialog, 'stdout').querySelector('pre')!;
    const textNode = pre.firstChild;
    output.scrollTop = 51;
    dialog.update(props({ payload: { ...payload, result: { ...payload.result!, stdout: '  first\nsecond\nthird' } } }));
    expect(panel(dialog, 'Output')).toBe(output);
    expect(value(dialog, 'stdout').querySelector('pre')).toBe(pre);
    expect(pre.firstChild).toBe(textNode);
    expect(pre.textContent).toBe('  first\nsecond\nthird');
    expect(output.scrollTop).toBe(51);
    expect(dialog.el.textContent).toContain('Done · exit 0');
    dialog.update(props({ status: 'in_progress' }));
    expect(dialog.el.textContent).toContain('Done · exit 0');
    dialog.update(props({ targetId: 'other', payload: { ...payload, computerId: 'other' } }));
    expect(output.scrollTop).toBe(0);
    expect(value(dialog, 'Computer ID (requested)').textContent).toBe('other');
  });

  it('renders unknown, missing values, errors and both output-limit notes without inventing remote runtime', () => {
    const dialog = open({ payload: { ...payload, result: { ...payload.result!, outcome: 'unknown', exitCode: null, truncated: true }, error: 'connection lost', outcomeUnknown: true, displayTruncated: ['stderr'] } });
    expect(dialog.el.textContent).toContain('Outcome unknown');
    expect(value(dialog, 'Remote exit code').textContent).toBe('Not reported');
    expect(value(dialog, 'Remote outcome').textContent).toContain('remote process may still be running');
    expect(value(dialog, 'Error / diagnostic').textContent).toBe('connection lost');
    expect(dialog.el.textContent).toContain('Backend output limit reached.');
    expect(dialog.el.textContent).toContain('Display limit reached: stderr.');
    expect(dialog.el.querySelector('[data-started-at]')).toBeNull();
  });

  it('retains full inert diagnostics separately from remote streams and follows diagnostic-only updates', () => {
    const data = { ...payload, result: null };
    const diagnostic = '{broken\nline 2\nline 3\nline 4\n<script>line 5</script>';
    const dialog = open({ payload: data });
    dialog.update(props({ payload: data, diagnostics: [{ label: 'output', text: diagnostic }] }));
    expect(value(dialog, 'Tool diagnostics (not remote output)').textContent).toBe(`output\n${diagnostic}`);
    expect(value(dialog, 'stdout').textContent).toBe('');
    expect(value(dialog, 'Remote exit code').textContent).toBe('Not reported');
    expect(dialog.el.textContent).toContain('Remote result not reported');
    expect(dialog.el.querySelector('script')).toBeNull();
    dialog.update(props({ payload: data, diagnostics: [{ label: 'output', text: `${diagnostic}\nlate` }] }));
    expect(value(dialog, 'Tool diagnostics (not remote output)').textContent).toContain('late');
  });

  it('closes without focus restoration when superseded, and disposes listeners and ticker state', () => {
    const onClose = vi.fn();
    const dialog = open({ status: 'in_progress', payload: { ...payload, result: null }, startedAt: 10, onClose });
    expect(dialog.el.querySelector('[data-started-at]')).not.toBeNull();
    const other = open({ targetId: 'other' });
    expect(dialog.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    expect(dialog.el.querySelector('[data-started-at]')).toBeNull();
    const close = other.el.querySelector<HTMLButtonElement>('[aria-label="Close remote command details"]')!;
    other.dispose();
    close.click();
    expect(other.isOpen).toBe(false);
    expect(other.el.isConnected).toBe(false);
    expect(press(other, 'Escape')).toBe(false);
  });
});

describe('RemoteCommandDialog keyboard scrolling', () => {
  it('scrolls the active panel horizontally and vertically while focus stays on its tab', () => {
    const dialog = open({ takeFocus: true });
    const command = panel(dialog, 'Command');
    const output = panel(dialog, 'Output');
    Object.defineProperties(command, {
      clientHeight: { value: 200 }, scrollHeight: { value: 1000 },
      clientWidth: { value: 300 }, scrollWidth: { value: 1500 },
    });
    const focused = document.activeElement;
    press(dialog, 'ArrowDown');
    expect(command.scrollTop).toBe(40);
    press(dialog, 'ArrowRight');
    expect(command.scrollLeft).toBe(40);
    press(dialog, 'ArrowLeft');
    expect(command.scrollLeft).toBe(0);
    press(dialog, 'PageDown');
    expect(command.scrollTop).toBe(200);
    press(dialog, 'PageUp');
    expect(command.scrollTop).toBe(40);
    press(dialog, 'End');
    expect(command.scrollTop).toBe(800);
    press(dialog, 'ArrowDown');
    expect(command.scrollTop).toBe(800);
    press(dialog, 'Home');
    expect(command.scrollTop).toBe(0);
    press(dialog, 'ArrowUp');
    expect(command.scrollTop).toBe(0);
    expect(document.activeElement).toBe(focused);
    press(dialog, 'Tab');
    Object.defineProperties(output, { clientHeight: { value: 200 }, scrollHeight: { value: 600 } });
    press(dialog, 'ArrowDown');
    expect(output.scrollTop).toBe(40);
    expect(command.scrollTop).toBe(0);
  });

  it('leaves Shift-selection, modifier chords and existing text selections native', () => {
    const dialog = open({ takeFocus: true });
    const command = panel(dialog, 'Command');
    command.scrollTop = 100;
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(press(dialog, key, true)).toBe(false);
    }
    for (const modifier of ['metaKey', 'ctrlKey']) {
      for (const key of ['c', 'ArrowRight']) {
        const event = new KeyboardEvent('keydown', { key, [modifier]: true, cancelable: true });
        expect(dialog.handleKey(event)).toBe(false);
        expect(event.defaultPrevented).toBe(false);
      }
    }
    const range = document.createRange();
    range.selectNodeContents(value(dialog, 'Requested command'));
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(press(dialog, 'ArrowRight')).toBe(false);
    expect(command.scrollTop).toBe(100);
    selection.removeAllRanges();
  });
});
