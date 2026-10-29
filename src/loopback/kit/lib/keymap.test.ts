import { afterEach, describe, expect, it, vi } from 'vitest';

import { Keymap } from './keymap';

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('Keymap', () => {
  let map: Keymap;
  afterEach(() => {
    map.dispose();
    document.body.replaceChildren();
  });

  it('matches a code binding whatever character the layout produces', () => {
    map = new Keymap(window);
    const run = vi.fn();
    map.bind({ code: 'Backquote', run });
    // Thai Kedmanee puts `_` on the backquote key.
    press(document.body, { key: '_', code: 'Backquote' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('ignores keys typed into a field unless the binding opts in', () => {
    map = new Keymap(window);
    const page = vi.fn();
    const field = vi.fn();
    map.bind({ key: 'j', run: page });
    map.bind({ key: 'Escape', inInput: true, run: field });
    const input = document.createElement('input');
    document.body.append(input);
    press(input, { key: 'j' });
    press(input, { key: 'Escape' });
    expect(page).not.toHaveBeenCalled();
    expect(field).toHaveBeenCalledOnce();
  });

  it('leaves browser and OS chords alone', () => {
    map = new Keymap(window);
    const run = vi.fn();
    map.bind({ key: 'r', run });
    press(document.body, { key: 'r', metaKey: true });
    press(document.body, { key: 'r', ctrlKey: true });
    press(document.body, { key: 'r', altKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses two ungated bindings for one chord', () => {
    map = new Keymap(window);
    map.bind({ key: ['j', 'ArrowDown'], label: 'next', run: () => {} });
    expect(() => map.bind({ key: 'ArrowDown', label: 'other', run: () => {} })).toThrow(/duplicate/);
    expect(() => map.bind({ key: 'ArrowDown', when: () => true, run: () => {} })).not.toThrow();
  });

  it('tries the newest binding first and falls through when it declines', () => {
    map = new Keymap(window);
    const order: string[] = [];
    map.bind({ key: 'Enter', run: () => void order.push('page') });
    map.bind({ key: 'Enter', when: () => true, run: () => (order.push('overlay'), false) });
    const event = press(document.body, { key: 'Enter' });
    expect(order).toEqual(['overlay', 'page']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('pauses page bindings while a modal is open', () => {
    map = new Keymap(window);
    let open = true;
    const page = vi.fn();
    const overlay = vi.fn();
    map.addModal(() => open);
    map.bind({ key: 'j', run: page });
    map.bind({ key: 'Escape', modal: true, when: () => open, run: overlay });
    press(document.body, { key: 'j' });
    press(document.body, { key: 'Escape' });
    expect(page).not.toHaveBeenCalled();
    expect(overlay).toHaveBeenCalledOnce();
    open = false;
    press(document.body, { key: 'j' });
    expect(page).toHaveBeenCalledOnce();
  });

  it('lists labelled bindings whose gate is open', () => {
    map = new Keymap(window);
    map.bind({ code: 'Backquote', display: '`', label: 'Switch', group: 'Shell', run: () => {} });
    map.bind({ key: ['j', 'ArrowDown'], label: 'Next', run: () => {} });
    map.bind({ key: 'x', label: 'Hidden', when: () => false, run: () => {} });
    map.bind({ key: 'y', run: () => {} });
    expect(map.help()).toEqual([
      { group: 'Shell', keys: '`', label: 'Switch' },
      { group: 'Page', keys: 'j / ↓', label: 'Next' },
    ]);
  });
});
