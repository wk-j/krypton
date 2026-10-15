import { afterEach, describe, expect, it } from 'vitest';

import type { HarnessDirective } from '../../../config';
import type { AcpBackendDescriptor } from '../../types';
import { LanePicker, type LanePickerProps } from './index';

const BACKENDS: readonly AcpBackendDescriptor[] = [
  { id: 'claude', display_name: 'Claude Code', command: 'claude' },
  { id: 'codex', display_name: 'Codex', command: 'codex' },
  { id: 'droid', display_name: 'Droid', command: 'droid' },
];

const DIRECTIVE: HarnessDirective = {
  id: '0301-impl',
  title: '0301 implementation',
  icon: '⚒',
  description: 'carve the components out',
  task: 'implementation',
  system_prompt: 'ship the kernel',
  enabled: true,
  triage_equipped: false,
};

const pickers: LanePicker[] = [];

const base = (over: Partial<LanePickerProps> = {}): LanePickerProps => ({
  open: true,
  backends: BACKENDS,
  running: new Map([['claude', 2]]),
  cursor: 0,
  pendingDirective: null,
  ...over,
});

const mount = (props: LanePickerProps): LanePicker => {
  const picker = new LanePicker();
  pickers.push(picker);
  picker.update(props);
  return picker;
};

/** Records every DOM write under `node` until `takeRecords()` is read. */
const watch = (node: Node): MutationObserver => {
  const observer = new MutationObserver(() => {
    /* records are read synchronously through takeRecords() */
  });
  observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  return observer;
};

afterEach(() => {
  for (const picker of pickers.splice(0)) picker.dispose();
});

describe('LanePicker', () => {
  it('emits the panel, the head and one row per backend', () => {
    const picker = mount(base({ cursor: 1 }));

    expect(picker.el.outerHTML).toBe(
      '<aside class="acp-harness__picker">' +
        '<div class="acp-harness__picker-panel">' +
        '<header class="acp-harness__picker-head">' +
        '<span>// add lane</span>' +
        '<span>j/k move · enter spawn · esc cancel</span>' +
        '</header>' +
        '<ul class="acp-harness__picker-list">' +
        '<li class="acp-harness__picker-row" data-picker-index="0">' +
        '<span class="acp-harness__picker-label">Claude</span>' +
        '<span class="acp-harness__picker-id">claude</span>' +
        ' <span class="acp-harness__picker-count">·2 running</span>' +
        '</li>' +
        '<li class="acp-harness__picker-row acp-harness__picker-row--active" data-picker-index="1">' +
        '<span class="acp-harness__picker-label">Codex</span>' +
        '<span class="acp-harness__picker-id">codex</span>' +
        '</li>' +
        '<li class="acp-harness__picker-row" data-picker-index="2">' +
        '<span class="acp-harness__picker-label">Droid</span>' +
        '<span class="acp-harness__picker-id">droid</span>' +
        '</li>' +
        '</ul>' +
        '</div>' +
        '</aside>',
    );
  });

  it('names the pending spawn directive in the head (spec 163)', () => {
    const picker = mount(base({ pendingDirective: DIRECTIVE }));
    expect(picker.el.querySelector('header')?.firstElementChild?.textContent).toBe(
      '// add lane · directive: 0301 implementation',
    );

    picker.update(base({ pendingDirective: { ...DIRECTIVE, title: '' } }));
    expect(picker.el.querySelector('header')?.firstElementChild?.textContent).toBe(
      '// add lane · directive: 0301-impl',
    );
  });

  it('replaces the list with the empty note when no backend is installed', () => {
    const picker = mount(base({ backends: [] }));

    expect(picker.el.querySelector('ul')).toBeNull();
    expect(picker.el.querySelector('.acp-harness__picker-empty')?.textContent).toBe(
      'no ACP backends installed',
    );
  });

  it('hides itself while closed instead of discarding the panel', () => {
    const picker = mount(base());
    const list = picker.el.querySelector('ul');

    picker.update(base({ open: false }));
    expect(picker.el.hidden).toBe(true);

    picker.update(base());
    expect(picker.el.hidden).toBe(false);
    expect(picker.el.querySelector('ul')).toBe(list);
  });

  it('moves --active without touching any other row node', () => {
    const picker = mount(base({ cursor: 0 }));
    const rows = [...picker.el.querySelectorAll('li')];
    const untouched = rows[2];
    const untouchedChild = untouched.firstChild;

    picker.update(base({ cursor: 1 }));

    expect([...picker.el.querySelectorAll('li')]).toStrictEqual(rows);
    expect(rows[0].className).toBe('acp-harness__picker-row');
    expect(rows[1].className).toBe('acp-harness__picker-row acp-harness__picker-row--active');
    expect(untouched.firstChild).toBe(untouchedChild);
  });

  it('re-derives the row class when the cursor comes back', () => {
    const picker = mount(base({ cursor: 1 }));
    picker.update(base({ cursor: 2 }));
    picker.update(base({ cursor: 1 }));

    const rows = [...picker.el.querySelectorAll('li')];
    expect(rows[1].className).toBe('acp-harness__picker-row acp-harness__picker-row--active');
    expect(rows[2].className).toBe('acp-harness__picker-row');
  });

  it('repaints the running count when a lane starts, and nothing else', () => {
    const picker = mount(base());
    const rows = [...picker.el.querySelectorAll('li')];

    picker.update(base({ running: new Map([['claude', 3]]) }));

    expect([...picker.el.querySelectorAll('li')]).toStrictEqual(rows);
    expect(rows[0].textContent).toBe('Claudeclaude ·3 running');
    expect(rows[1].childNodes.length).toBe(2);
  });

  it('writes nothing to the DOM when the props say the same thing', () => {
    const picker = mount(base({ cursor: 1 }));
    const observer = watch(picker.el);

    picker.update(base({ cursor: 1 }));

    expect(observer.takeRecords()).toStrictEqual([]);
    observer.disconnect();
  });

  it('stops reporting auto-close after dispose', () => {
    let closed = 0;
    const picker = new LanePicker();
    picker.update(base({ onAutoClose: () => { closed += 1; } }));
    const other = new LanePicker();

    picker.dispose();
    other.update(base());

    expect(closed).toBe(0);
    expect(other.el.hidden).toBe(false);
    other.dispose();
  });
});
