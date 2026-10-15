import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ListPicker,
  clampCursor,
  nextCursor,
  prevCursor,
  type ListPickerProps,
} from './index';

interface Row {
  readonly id: string;
  readonly label: string;
}

const ROWS: readonly Row[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'omp', label: 'Oh My Pi' },
];

const rendered = new Map<string, number>();

const renderRow = (item: Row): Node => {
  rendered.set(item.id, (rendered.get(item.id) ?? 0) + 1);
  const span = document.createElement('span');
  span.className = 'acp-harness__picker-label';
  span.textContent = item.label;
  return span;
};

// happy-dom has no layout, so `scrollIntoView` is recorded rather than spied on
// through a mock: the assertion that matters is WHICH node was asked to scroll.
const scrolled: Element[] = [];
const scrollOptions: unknown[] = [];

const pickers: ListPicker<Row>[] = [];

const mount = (props: ListPickerProps<Row>): ListPicker<Row> => {
  const picker = new ListPicker<Row>();
  pickers.push(picker);
  picker.update(props);
  return picker;
};

const base = (over: Partial<ListPickerProps<Row>> = {}): ListPickerProps<Row> => ({
  items: ROWS,
  cursor: 0,
  renderRow,
  block: 'acp-picker',
  name: 'picker',
  followCursor: false,
  ...over,
});

beforeEach(() => {
  scrolled.length = 0;
  scrollOptions.length = 0;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options?: unknown): void {
      scrolled.push(this);
      scrollOptions.push(options);
    },
  });
});

afterEach(() => {
  for (const picker of pickers.splice(0)) picker.dispose();
  rendered.clear();
});

describe('cursor helpers', () => {
  it('wraps both ways, which is what all seven copied handlers do', () => {
    expect(nextCursor(2, 3)).toBe(0);
    expect(nextCursor(0, 3)).toBe(1);
    expect(prevCursor(0, 3)).toBe(2);
    expect(prevCursor(2, 3)).toBe(1);
  });

  it('answers 0 for an empty list instead of NaN', () => {
    expect(nextCursor(0, 0)).toBe(0);
    expect(prevCursor(0, 0)).toBe(0);
    expect(clampCursor(4, 0)).toBe(0);
  });

  it('clamps an out-of-range cursor before moving it', () => {
    expect(clampCursor(9, 3)).toBe(2);
    expect(clampCursor(-4, 3)).toBe(0);
    expect(nextCursor(9, 3)).toBe(0);
    expect(prevCursor(-4, 3)).toBe(2);
  });
});

describe('ListPicker', () => {
  it('emits the caller block, the row index attribute and the caller rows', () => {
    const picker = mount(base({ cursor: 1 }));

    expect(picker.el.outerHTML).toBe(
      '<ul class="acp-picker__list">' +
        '<li class="acp-picker__row" data-picker-index="0">' +
        '<span class="acp-harness__picker-label">Claude Code</span></li>' +
        '<li class="acp-picker__row acp-picker__row--active" data-picker-index="1">' +
        '<span class="acp-harness__picker-label">Codex</span></li>' +
        '<li class="acp-picker__row" data-picker-index="2">' +
        '<span class="acp-harness__picker-label">Oh My Pi</span></li>' +
        '</ul>',
    );
  });

  it('clamps a cursor the caller left past the end of the list', () => {
    const picker = mount(base({ cursor: 7 }));

    expect(picker.cursor).toBe(2);
    expect(picker.el.children[2].className).toBe('acp-picker__row acp-picker__row--active');
  });

  it('moves the cursor by touching exactly two rows', () => {
    const picker = mount(base({ cursor: 0 }));
    const before = [...picker.el.children];
    const untouched = before[2];
    const untouchedClass = untouched.className;
    const untouchedChild = untouched.firstChild;

    picker.update(base({ cursor: 1 }));

    expect([...picker.el.children]).toStrictEqual(before);
    expect(before[0].className).toBe('acp-picker__row');
    expect(before[1].className).toBe('acp-picker__row acp-picker__row--active');
    expect(untouched.className).toBe(untouchedClass);
    expect(untouched.firstChild).toBe(untouchedChild);
    // No row content was rebuilt: the cursor is a class, not a repaint.
    expect([...rendered.values()]).toEqual([1, 1, 1]);
  });

  it('re-derives the active class from the cursor rather than removing it by name', () => {
    const picker = mount(base({ cursor: 1 }));
    picker.update(base({ cursor: 2 }));
    picker.update(base({ cursor: 1 }));

    expect(picker.el.children[1].className).toBe('acp-picker__row acp-picker__row--active');
    expect(picker.el.children[2].className).toBe('acp-picker__row');
  });

  it('keeps surviving rows and their caller-built content when an item is removed', () => {
    const picker = mount(base());
    const [first, second, third] = [...picker.el.children];
    const firstContent = first.firstChild;
    const secondContent = second.firstChild;

    picker.update(base({ items: ROWS.slice(0, 2) }));

    expect([...picker.el.children]).toStrictEqual([first, second]);
    expect(first.firstChild).toBe(firstContent);
    expect(second.firstChild).toBe(secondContent);
    expect(third.isConnected).toBe(false);
    expect([...rendered.values()]).toEqual([1, 1, 1]);
  });

  it('rebuilds a row whose item changed under a reused index', () => {
    const picker = mount(base());
    const second = picker.el.children[1];

    picker.update(base({ items: [ROWS[0], { id: 'grok', label: 'Grok' }, ROWS[2]] }));

    expect(picker.el.children[1]).toBe(second);
    expect(second.textContent).toBe('Grok');
    expect(rendered.get('claude')).toBe(1);
  });

  it('skips the repaint while its dependency tuple holds', () => {
    const props = base();
    const picker = mount(props);
    const first = picker.el.firstElementChild;
    const content = first?.firstChild;

    picker.update(props);

    expect(picker.el.firstElementChild).toBe(first);
    expect(first?.firstChild).toBe(content);
    expect([...rendered.values()]).toEqual([1, 1, 1]);
  });

  it('re-anchors the cursor when only the filter token moved', () => {
    const picker = mount(base({ cursor: 1, filter: 'cl', followCursor: true }));
    expect(scrolled.length).toBe(1);

    picker.update(base({ cursor: 1, filter: 'co', followCursor: true }));

    expect(scrolled.length).toBe(2);
    expect(scrolled[1]).toBe(picker.el.children[1]);
  });

  it('scrolls the active row into view when following the cursor', () => {
    const picker = mount(base({ cursor: 2, followCursor: true }));

    expect(scrolled).toStrictEqual([picker.el.children[2]]);
    expect(scrollOptions).toStrictEqual([{ block: 'nearest' }]);
  });

  it('leaves the scroll position alone when the caller opts out', () => {
    mount(base({ cursor: 2, followCursor: false }));

    expect(scrolled.length).toBe(0);
  });

  it('renders an empty list as an empty <ul>, never as a stale one', () => {
    const picker = mount(base());
    picker.update(base({ items: [] }));

    expect(picker.el.children.length).toBe(0);
    expect(picker.cursor).toBe(0);
    expect(picker.activeRow).toBeNull();
  });

  it('removes the old index attribute when the picker is renamed', () => {
    const picker = mount(base());
    picker.update(base({ name: 'model' }));

    const first = picker.el.firstElementChild;
    expect(first?.hasAttribute('data-picker-index')).toBe(false);
    expect(first?.getAttribute('data-model-index')).toBe('0');
  });

  it('emits the single-dash element names the inline pickers are styled with', () => {
    const picker = mount(base({ separator: '-', block: 'acp-harness__picker', cursor: 1 }));

    expect(picker.el.className).toBe('acp-harness__picker-list');
    expect(picker.el.children[0].className).toBe('acp-harness__picker-row');
    expect(picker.el.children[1].className).toBe(
      'acp-harness__picker-row acp-harness__picker-row--active',
    );
  });

  it('takes a full container and row class, and the ticket active modifier', () => {
    const picker = mount(base({
      block: 'acp-ticket',
      listClass: 'acp-ticket__rows',
      rowClass: 'acp-ticket__row',
      activeModifier: 'selected',
      cursor: 0,
    }));

    expect(picker.el.className).toBe('acp-ticket__rows');
    expect(picker.el.children[0].className).toBe('acp-ticket__row acp-ticket__row--selected');
    expect(picker.el.children[1].className).toBe('acp-ticket__row');
  });

  it('builds the container and rows from the tags the caller asked for', () => {
    const picker = new ListPicker<Row>('div', 'button');
    pickers.push(picker);
    picker.update(base());

    expect(picker.el.tagName).toBe('DIV');
    const first = picker.el.firstElementChild;
    expect(first?.tagName).toBe('BUTTON');
    expect(first?.getAttribute('type')).toBe('button');
  });

  it('rebuilds a row whose tag changed and keeps the rows that did not', () => {
    const picker = new ListPicker<Row>('div', 'button');
    pickers.push(picker);
    const tagFor = (item: Row): 'button' | 'div' => (item.id === 'omp' ? 'div' : 'button');
    picker.update(base({ rowTagFor: () => 'button' }));
    const [first, , third] = [...picker.el.children];

    picker.update(base({ rowTagFor: tagFor }));

    expect(picker.el.children[0]).toBe(first);
    expect(picker.el.children[2]).not.toBe(third);
    expect(picker.el.children[2].tagName).toBe('DIV');
    expect(third.isConnected).toBe(false);
  });

  it('carries the per-row classes and attributes the caller derives', () => {
    const picker = mount(base({
      block: 'acp-ticket',
      rowClasses: (item: Row): readonly string[] =>
        item.id === 'omp' ? ['acp-ticket__row--unavailable'] : [],
      rowAttrs: (item: Row, index: number, active: boolean): Record<string, string | undefined> => ({
        role: 'option',
        'aria-selected': String(active),
        'aria-disabled': item.id === 'omp' ? 'true' : undefined,
      }),
      cursor: 0,
    }));

    expect(picker.el.children[0].getAttribute('aria-selected')).toBe('true');
    expect(picker.el.children[1].getAttribute('aria-selected')).toBe('false');
    expect(picker.el.children[1].hasAttribute('aria-disabled')).toBe(false);
    expect(picker.el.children[2].className).toBe('acp-ticket__row acp-ticket__row--unavailable');
    expect(picker.el.children[2].getAttribute('aria-disabled')).toBe('true');
  });

  it('drops a row attribute the caller stopped deriving', () => {
    const withBackend = base({
      indexAttr: false,
      rowAttrs: (item: Row): Record<string, string> => ({ 'data-session-backend': item.id }),
    });
    const picker = mount(withBackend);
    expect(picker.el.children[0].getAttribute('data-session-backend')).toBe('claude');
    expect(picker.el.children[0].hasAttribute('data-picker-index')).toBe(false);

    picker.update(base({ indexAttr: false, cursor: 1 }));
    expect(picker.el.children[0].hasAttribute('data-session-backend')).toBe(false);
  });

  it('carries container attributes and drops the ones the caller stopped deriving', () => {
    const picker = mount(base({
      block: 'acp-ticket',
      listClass: 'acp-ticket__rows',
      listAttrs: { role: 'listbox', 'data-count': '3' },
    }));

    expect(picker.el.getAttribute('role')).toBe('listbox');
    expect(picker.el.getAttribute('data-count')).toBe('3');

    picker.update(base({
      block: 'acp-ticket',
      listClass: 'acp-ticket__rows',
      listAttrs: { role: 'listbox', 'data-count': '2' },
      items: ROWS.slice(0, 2),
    }));
    expect(picker.el.getAttribute('data-count')).toBe('2');

    picker.update(base({ block: 'acp-ticket', listClass: 'acp-ticket__rows' }));
    expect(picker.el.hasAttribute('role')).toBe(false);
    expect(picker.el.hasAttribute('data-count')).toBe(false);
  });

  it('drops its rows on dispose', () => {
    const picker = new ListPicker<Row>();
    picker.update(base());
    expect(picker.el.children.length).toBe(3);

    picker.dispose();
    expect(picker.el.children.length).toBe(0);
  });
});
