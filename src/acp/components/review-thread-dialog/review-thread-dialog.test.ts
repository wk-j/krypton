import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewThreadDialog, type ReviewThreadDialogProps } from './index';

const dialogs: ReviewThreadDialog[] = [];

const props = (over: Partial<ReviewThreadDialogProps> = {}): ReviewThreadDialogProps => ({
  open: true,
  base: 'upstream',
  preview: 'กำลังเก็บ preview…',
  confirmDisabled: true,
  onSelectBase: () => undefined,
  onConfirm: () => undefined,
  onCancel: () => undefined,
  ...over,
});

const mount = (over: Partial<ReviewThreadDialogProps> = {}): ReviewThreadDialog => {
  const dialog = new ReviewThreadDialog();
  dialogs.push(dialog);
  dialog.update(props(over));
  return dialog;
};

afterEach(() => {
  for (const dialog of dialogs.splice(0)) dialog.dispose();
});

describe('ReviewThreadDialog', () => {
  it('emits the dialog, the two bases, the preview and the action row', () => {
    const dialog = mount();
    expect(dialog.el.className).toBe('acp-harness__review-thread-overlay');
    expect(dialog.el.querySelector('.acp-review-thread__title')?.textContent).toBe('Start Review Thread');
    const body = dialog.el.querySelector<HTMLElement>('.acp-review-thread__body');
    expect(body?.getAttribute('role')).toBe('dialog');
    expect(body?.getAttribute('aria-modal')).toBe('true');
    expect(body?.getAttribute('aria-label')).toBe('Start Review Thread');
    expect(dialog.el.querySelector('.acp-review-thread__bases legend')?.textContent)
      .toBe('Compare against');
    expect([...dialog.el.querySelectorAll('.acp-review-thread__choice strong')].map((s) => s.textContent))
      .toEqual(['Upstream merge-base', 'HEAD']);
    expect([...dialog.el.querySelectorAll('.acp-review-thread__choice small')].map((s) => s.textContent))
      .toEqual(['Changes since the tracked branch, including local work', 'Working tree changes only']);
    const details = dialog.el.querySelector<HTMLElement>('.acp-review-thread__details');
    expect(details?.tagName).toBe('PRE');
    expect(details?.getAttribute('aria-live')).toBe('polite');
    expect(details?.textContent).toBe('กำลังเก็บ preview…');
    expect([...dialog.el.querySelectorAll('.acp-review-thread__actions button')].map((b) => b.textContent))
      .toEqual(['Start Review · Enter', 'Cancel · Esc']);
  });

  it('checks the base the props name, and follows a change back', () => {
    const dialog = mount();
    const inputs = [...dialog.el.querySelectorAll<HTMLInputElement>('.acp-review-thread__radio')];
    expect(inputs.map((input) => input.checked)).toEqual([true, false]);
    dialog.update(props({ base: 'head' }));
    expect(inputs.map((input) => input.checked)).toEqual([false, true]);
    dialog.update(props({ base: 'upstream' }));
    expect(inputs.map((input) => input.checked)).toEqual([true, false]);
  });

  it('reports a radio change to the owner instead of keeping its own base', () => {
    const onSelectBase = vi.fn();
    const dialog = mount({ onSelectBase });
    const head = [...dialog.el.querySelectorAll<HTMLInputElement>('.acp-review-thread__radio')][1];
    head.checked = true;
    head.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onSelectBase).toHaveBeenCalledWith('head');
  });

  it('enables Start Review only once a preview has arrived', () => {
    const onConfirm = vi.fn();
    const dialog = mount({ onConfirm });
    const confirm = dialog.el.querySelector<HTMLButtonElement>('.acp-review-thread__actions button');
    expect(confirm?.disabled).toBe(true);
    dialog.update(props({ preview: '4 files · +120 −8', confirmDisabled: false, onConfirm }));
    expect(confirm?.disabled).toBe(false);
    expect(dialog.el.querySelector('.acp-review-thread__details')?.textContent).toBe('4 files · +120 −8');
    confirm?.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels through the second button', () => {
    const onCancel = vi.fn();
    const dialog = mount({ onCancel });
    const cancel = [...dialog.el.querySelectorAll<HTMLButtonElement>('.acp-review-thread__actions button')][1];
    cancel.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('drops its button listeners on dispose', () => {
    const onCancel = vi.fn();
    const dialog = mount({ onCancel });
    const cancel = [...dialog.el.querySelectorAll<HTMLButtonElement>('.acp-review-thread__actions button')][1];
    dialog.dispose();
    cancel.click();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('hides while closed', () => {
    const dialog = mount({ open: false });
    expect(dialog.el.hidden).toBe(true);
  });

  it('writes nothing when the dependency tuple holds', () => {
    const dialog = mount();
    const observer = new MutationObserver(() => undefined);
    observer.observe(dialog.el, { childList: true, subtree: true, attributes: true, characterData: true });
    dialog.update(props());
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
