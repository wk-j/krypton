import { afterEach, describe, expect, it } from 'vitest';

import type { HarnessDirective } from '../../../config';
import { DirectivePicker, type DirectivePickerProps } from './index';

const directive = (over: Partial<HarnessDirective> = {}): HarnessDirective => ({
  id: '0301-impl',
  title: 'harness UI refactor',
  icon: '⚒',
  description: 'carve the components out',
  task: 'implementation',
  system_prompt: 'ship the kernel first',
  enabled: true,
  triage_equipped: false,
  ...over,
});

const DIRECTIVES: readonly HarnessDirective[] = [
  directive(),
  directive({ id: 'review-1', title: 'review', icon: '⌁', description: '', enabled: false }),
  directive({ id: 'triage-1', title: 'triage', icon: '◇', triage_equipped: true }),
];

const pickers: DirectivePicker[] = [];

const base = (over: Partial<DirectivePickerProps> = {}): DirectivePickerProps => ({
  open: true,
  laneName: 'claude-1',
  directives: DIRECTIVES,
  currentDirectiveId: '0301-impl',
  cursor: 0,
  ...over,
});

const mount = (props: DirectivePickerProps): DirectivePicker => {
  const picker = new DirectivePicker();
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

afterEach(() => {
  for (const picker of pickers.splice(0)) picker.dispose();
});

describe('DirectivePicker', () => {
  it('emits the head, the rows and the preview as siblings of the root', () => {
    const picker = mount(base());

    expect([...picker.el.children].map((child) => child.className)).toStrictEqual([
      'acp-harness__directive-head',
      'acp-harness__directive-list',
      'acp-harness__directive-preview',
    ]);
    expect(picker.el.querySelector('header')?.outerHTML).toBe(
      '<header class="acp-harness__directive-head">' +
        '<span>// directive · claude-1</span>' +
        '<span>j/k move · enter switch · shift+enter new lane · backspace clear · esc cancel</span>' +
        '</header>',
    );
  });

  it('emits the assigned tag, the disabled badge and the triage glyph', () => {
    const picker = mount(base());
    const rows = [...picker.el.querySelectorAll('li')];

    expect(rows[0].outerHTML).toBe(
      '<li class="acp-harness__directive-row acp-harness__directive-row--active" data-directive-index="0">' +
        '<span class="acp-harness__directive-icon">⚒</span>' +
        '<span class="acp-harness__directive-title">harness UI refactor</span>' +
        '<span class="acp-harness__directive-assigned">assigned</span>' +
        '<span class="acp-harness__directive-desc">carve the components out</span>' +
        '</li>',
    );
    expect(rows[1].outerHTML).toBe(
      '<li class="acp-harness__directive-row acp-harness__directive-row--disabled" data-directive-index="1">' +
        '<span class="acp-harness__directive-icon">⌁</span>' +
        '<span class="acp-harness__directive-title">review</span>' +
        '<span class="acp-harness__directive-badge">disabled</span>' +
        '</li>',
    );
    expect(rows[2].querySelector('.acp-harness__directive-badge--triage')?.outerHTML).toBe(
      '<span class="acp-harness__directive-badge acp-harness__directive-badge--triage" ' +
        'title="legacy triage metadata; attention tools are default-on">◆</span>',
    );
  });

  it('previews the selected prompt, with the id and task as its scope', () => {
    const picker = mount(base({ cursor: 2 }));

    expect(picker.el.querySelector('.acp-harness__directive-preview')?.outerHTML).toBe(
      '<div class="acp-harness__directive-preview">' +
        '<div class="acp-harness__directive-preview-head">' +
        '<span>// prompt</span>' +
        '<span class="acp-harness__directive-preview-scope">triage-1 · implementation</span>' +
        '</div>' +
        '<div class="acp-harness__directive-preview-body">ship the kernel first</div>' +
        '</div>',
    );
  });

  it('says so when the selected directive carries no prompt', () => {
    const picker = mount(base({ directives: [directive({ system_prompt: '' })] }));

    expect(picker.el.querySelector('.acp-harness__directive-preview-body')?.textContent).toBe(
      '(empty prompt)',
    );
  });

  it('drops the preview pane when there is nothing to select', () => {
    const picker = mount(base({ directives: [] }));

    expect(picker.el.querySelector('.acp-harness__directive-preview')).toBeNull();
    expect(picker.el.querySelector('ul')?.children.length).toBe(0);
  });

  it('stays shut while no lane can take the switch', () => {
    const picker = mount(base({ laneName: null }));
    expect(picker.el.hidden).toBe(true);

    picker.update(base());
    expect(picker.el.hidden).toBe(false);
  });

  it('moves --active and keeps every row node, including the preview', () => {
    const picker = mount(base({ cursor: 0 }));
    const rows = [...picker.el.querySelectorAll('li')];
    const preview = picker.el.querySelector('.acp-harness__directive-preview');
    const previewHead = preview?.firstElementChild;

    picker.update(base({ cursor: 1 }));

    expect([...picker.el.querySelectorAll('li')]).toStrictEqual(rows);
    expect(rows[0].className).toBe('acp-harness__directive-row');
    expect(rows[1].className).toBe(
      'acp-harness__directive-row acp-harness__directive-row--active acp-harness__directive-row--disabled',
    );
    expect(picker.el.querySelector('.acp-harness__directive-preview')).toBe(preview);
    expect(preview?.firstElementChild).toBe(previewHead);
    expect(picker.el.querySelector('.acp-harness__directive-preview-body')?.textContent).toBe(
      'ship the kernel first',
    );
  });

  it('re-derives the row class after the cursor comes back', () => {
    const picker = mount(base({ cursor: 1 }));
    picker.update(base({ cursor: 0 }));
    picker.update(base({ cursor: 1 }));

    const rows = [...picker.el.querySelectorAll('li')];
    expect(rows[1].className).toBe(
      'acp-harness__directive-row acp-harness__directive-row--active acp-harness__directive-row--disabled',
    );
    expect(rows[0].className).toBe('acp-harness__directive-row');
  });

  it('moves the assigned tag when the lane switches directive', () => {
    const picker = mount(base());
    expect(picker.el.querySelectorAll('.acp-harness__directive-assigned').length).toBe(1);

    picker.update(base({ currentDirectiveId: 'review-1' }));

    const rows = [...picker.el.querySelectorAll('li')];
    expect(rows[0].querySelector('.acp-harness__directive-assigned')).toBeNull();
    expect(rows[1].querySelector('.acp-harness__directive-assigned')?.textContent).toBe('assigned');
  });

  it('writes nothing to the DOM when the props say the same thing', () => {
    const picker = mount(base({ cursor: 1 }));
    const observer = watch(picker.el);

    picker.update(base({ cursor: 1 }));

    expect(observer.takeRecords()).toStrictEqual([]);
    observer.disconnect();
  });

  it('reports a clicked row by index and stops after dispose', () => {
    const chosen: number[] = [];
    const picker = mount(base({ onChoose: (index) => chosen.push(index) }));
    const rows = [...picker.el.querySelectorAll('li')];

    rows[2].querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(chosen).toStrictEqual([2]);

    picker.dispose();
    rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(chosen).toStrictEqual([2]);
  });
});
