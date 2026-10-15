import { afterEach, describe, expect, it } from 'vitest';

import { RemotePicker, type RemotePickerProps, type RemotePickerRow } from './index';

const ROWS: readonly RemotePickerRow[] = [
  { label: 'Current SSH', detail: 'wk@build-01:22 · /srv/krypton' },
  { label: 'studio', detail: 'studio.local · /Users/wk/Source/krypton' },
];

const pickers: RemotePicker[] = [];

const base = (over: Partial<RemotePickerProps> = {}): RemotePickerProps => ({
  rows: ROWS,
  cursor: 0,
  pathMode: false,
  ...over,
});

const mount = (props: RemotePickerProps): RemotePicker => {
  const picker = new RemotePicker();
  pickers.push(picker);
  picker.update(props);
  return picker;
};

const watch = (node: Node): MutationObserver => {
  const observer = new MutationObserver(() => {
    /* read synchronously through takeRecords() */
  });
  observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  return observer;
};

const hintOf = (picker: RemotePicker): string | null =>
  picker.el.querySelector('.remote-harness-picker__hint')?.textContent ?? null;

afterEach(() => {
  for (const picker of pickers.splice(0)) picker.dispose();
});

describe('RemotePicker', () => {
  it('emits a focusable dialog around a section panel', () => {
    const picker = mount(base());

    expect(picker.el.tagName).toBe('DIV');
    expect(picker.el.className).toBe('remote-harness-picker');
    expect(picker.el.tabIndex).toBe(0);
    expect(picker.el.getAttribute('role')).toBe('dialog');
    expect(picker.el.getAttribute('aria-label')).toBe('Open Remote ACP Harness');
    expect([...picker.el.children].map((child) => child.tagName)).toStrictEqual(['SECTION']);
    expect(
      [...picker.el.querySelectorAll('section > *')].map((child) => child.className),
    ).toStrictEqual([
      'remote-harness-picker__head',
      'remote-harness-picker__list',
      'remote-harness-picker__path',
      'remote-harness-picker__hint',
    ]);
  });

  it('emits the head, one button per row and the key hints', () => {
    const picker = mount(base());

    expect(picker.el.querySelector('header')?.outerHTML).toBe(
      '<header class="remote-harness-picker__head">REMOTE ACP HARNESS</header>',
    );
    expect(picker.el.querySelector('.remote-harness-picker__list')?.outerHTML).toBe(
      '<div class="remote-harness-picker__list">' +
        '<button type="button" class="remote-harness-picker__row remote-harness-picker__row--active" ' +
        'data-remote-index="0">' +
        '<strong>Current SSH</strong><span>wk@build-01:22 · /srv/krypton</span></button>' +
        '<button type="button" class="remote-harness-picker__row" data-remote-index="1">' +
        '<strong>studio</strong><span>studio.local · /Users/wk/Source/krypton</span></button>' +
        '</div>',
    );
    expect(hintOf(picker)).toBe('j/k select · Enter connect · Esc cancel');
  });

  it('keeps the path field hidden until the row needs one', () => {
    const picker = mount(base());
    const input = picker.pathInput;

    expect(input.hidden).toBe(true);
    expect(input.getAttribute('placeholder')).toBe('/absolute/remote/project/path');

    picker.update(base({ pathMode: true }));
    expect(input.hidden).toBe(false);
    expect(picker.pathInput).toBe(input);
    expect(hintOf(picker)).toBe('Enter connect · Esc back · absolute path required');

    picker.update(base({ pathMode: true, pathInvalid: true }));
    expect(hintOf(picker)).toBe('Enter an absolute path beginning with /');

    picker.update(base());
    expect(input.hidden).toBe(true);
    expect(hintOf(picker)).toBe('j/k select · Enter connect · Esc cancel');
  });

  it('tells the reader there is nothing to connect to', () => {
    const picker = mount(base({ rows: [] }));

    expect(picker.el.querySelector('.remote-harness-picker__list')?.children.length).toBe(0);
    expect(hintOf(picker)).toBe('No SSH session or remote profiles · Esc close');
  });

  it('moves --active without rebuilding a row', () => {
    const picker = mount(base({ cursor: 0 }));
    const rows = [...picker.el.querySelectorAll('button')];
    const untouchedChild = rows[1].firstChild;

    picker.update(base({ cursor: 1 }));

    expect([...picker.el.querySelectorAll('button')]).toStrictEqual(rows);
    expect(rows[0].className).toBe('remote-harness-picker__row');
    expect(rows[1].className).toBe(
      'remote-harness-picker__row remote-harness-picker__row--active',
    );
    expect(rows[1].firstChild).toBe(untouchedChild);
  });

  it('re-derives the row class after the cursor comes back', () => {
    const picker = mount(base({ cursor: 1 }));
    picker.update(base({ cursor: 0 }));
    picker.update(base({ cursor: 1 }));

    const rows = [...picker.el.querySelectorAll('button')];
    expect(rows[1].className).toBe(
      'remote-harness-picker__row remote-harness-picker__row--active',
    );
    expect(rows[0].className).toBe('remote-harness-picker__row');
  });

  it('writes nothing to the DOM when the props say the same thing', () => {
    const picker = mount(base({ cursor: 1 }));
    const observer = watch(picker.el);

    picker.update(base({ cursor: 1 }));

    expect(observer.takeRecords()).toStrictEqual([]);
    observer.disconnect();
  });

  it('reports a clicked row by index, once, and stops after dispose', () => {
    const chosen: number[] = [];
    const picker = mount(base({ onChoose: (index) => chosen.push(index) }));
    const rows = [...picker.el.querySelectorAll('button')];

    rows[1].querySelector('strong')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(chosen).toStrictEqual([1]);

    picker.dispose();
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(chosen).toStrictEqual([1]);
  });
});
