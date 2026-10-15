import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TicketPickerAction, TicketPickerTab } from '../../harness-ticket-helpers';
import type { TicketPickerRow } from '../../harness-view-types';
import { TicketPicker, type TicketPickerProps } from './index';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');

const ROWS: readonly TicketPickerRow[] = [
  {
    kind: 'local',
    ticketId: 'KR-301',
    title: 'Harness UI refactor',
    labels: ['ui', 'refactor'],
    state: 'open',
    updatedAt: new Date(NOW - 10 * 60_000).toISOString(),
    url: 'https://github.com/wk/krypton/issues/301',
  },
  {
    kind: 'github',
    number: 412,
    title: 'Picker loses its scroll offset',
    labels: [],
    state: 'open',
    url: 'https://github.com/wk/krypton/issues/412',
  },
];

const UNAVAILABLE: TicketPickerRow = {
  kind: 'unavailable',
  title: 'gh unavailable — local tickets only',
  labels: [],
  state: 'open',
};

const pickers: TicketPicker[] = [];
const scrolled: Element[] = [];

const base = (over: Partial<TicketPickerProps> = {}): TicketPickerProps => ({
  open: true,
  rows: ROWS,
  counts: { open: 7, closed: 23 },
  tab: 'open',
  filter: '',
  cursor: 0,
  laneName: 'codex-1',
  laneStatus: 'idle',
  laneCount: 3,
  workDisabledReason: null,
  now: NOW,
  ...over,
});

const mount = (props: TicketPickerProps): TicketPicker => {
  const picker = new TicketPicker();
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

const panelOf = (picker: TicketPicker): HTMLElement => {
  const panel = picker.el.querySelector<HTMLElement>('.acp-ticket__panel');
  if (panel === null) throw new Error('no panel');
  return panel;
};

beforeEach(() => {
  scrolled.length = 0;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: HTMLElement): void {
      scrolled.push(this);
    },
  });
});

afterEach(() => {
  for (const picker of pickers.splice(0)) picker.dispose();
});

describe('TicketPicker', () => {
  it('emits the dialog panel in head · tabs · filter · rows · actions · foot order', () => {
    const picker = mount(base());
    const panel = panelOf(picker);

    expect(picker.el.className).toBe('acp-harness__ticket-overlay');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-label')).toBe('Working ticket');
    expect([...panel.children].map((child) => child.className)).toStrictEqual([
      'acp-ticket__head',
      'acp-ticket__tabs',
      'acp-ticket__filter',
      'acp-ticket__rows',
      'acp-ticket__actions',
      'acp-ticket__foot',
    ]);
  });

  it('carries the title as a bare text node and the target as the sub', () => {
    const picker = mount(base());

    expect(picker.el.querySelector('header')?.outerHTML).toBe(
      '<header class="acp-ticket__head">local tickets + GitHub' +
        '<span class="acp-ticket__sub">target: codex-1 · idle</span></header>',
    );
  });

  it('says so when no lane can take the work', () => {
    const picker = mount(base({ laneName: null, laneStatus: null }));

    expect(picker.el.querySelector('.acp-ticket__sub')?.textContent).toBe('target: no active lane');
    expect(picker.el.querySelector('.acp-ticket__foot')?.textContent).toBe(
      'Tab open/closed · ↑↓ / ⌃n⌃p select · Esc dismissshared with all 3 lanes · work runs in no lane',
    );
  });

  it('emits the tab strip with both counts', () => {
    const picker = mount(base());

    expect(picker.el.querySelector('.acp-ticket__tabs')?.outerHTML).toBe(
      '<div class="acp-ticket__tabs" role="tablist" aria-label="Ticket status">' +
        '<button type="button" class="acp-ticket__tab acp-ticket__tab--active" data-tab-id="open" ' +
        'role="tab" aria-selected="true">Open <span class="acp-ticket__tab-count">7</span></button>' +
        '<button type="button" class="acp-ticket__tab" data-tab-id="closed" ' +
        'role="tab" aria-selected="false">Closed <span class="acp-ticket__tab-count">23</span></button>' +
        '</div>',
    );
  });

  it('shows the filter hint until something is typed', () => {
    const picker = mount(base());
    expect(picker.el.querySelector('.acp-ticket__filter')?.outerHTML).toBe(
      '<div class="acp-ticket__filter">' +
        '<span class="acp-ticket__filter-hint">type to filter</span>' +
        '<span class="acp-harness__caret"></span></div>',
    );

    picker.update(base({ filter: 'harn' }));
    expect(picker.el.querySelector('.acp-ticket__filter')?.outerHTML).toBe(
      '<div class="acp-ticket__filter">harn<span class="acp-harness__caret"></span></div>',
    );
  });

  it('emits a local row as a button and an unavailable row as a div', () => {
    const picker = mount(base({ rows: [...ROWS, UNAVAILABLE] }));
    const rows = [...picker.el.querySelectorAll('.acp-ticket__row')];

    expect(rows[0].outerHTML).toBe(
      '<button type="button" class="acp-ticket__row acp-ticket__row--selected" role="option" ' +
        'aria-selected="true" data-ticket-index="0">' +
        '<span class="acp-ticket__title">Harness UI refactor</span>' +
        '<span class="acp-ticket__identity"><span class="acp-ticket__num">KR-301</span>' +
        '<span class="acp-ticket__badge">LOCAL</span></span>' +
        '<span class="acp-ticket__labels">ui, refactor</span>' +
        '<span class="acp-ticket__age">10m · open</span>' +
        '</button>',
    );
    expect(rows[1].outerHTML).toBe(
      '<button type="button" class="acp-ticket__row" role="option" aria-selected="false" ' +
        'data-ticket-index="1">' +
        '<span class="acp-ticket__title">Picker loses its scroll offset</span>' +
        '<span class="acp-ticket__identity"><span class="acp-ticket__num">#412</span>' +
        '<span class="acp-ticket__badge">IMPORT</span></span>' +
        '<span class="acp-ticket__age"> · open</span>' +
        '</button>',
    );
    expect(rows[2].tagName).toBe('DIV');
    expect(rows[2].className).toBe('acp-ticket__row acp-ticket__row--unavailable');
    expect(rows[2].getAttribute('aria-disabled')).toBe('true');
    expect(rows[2].querySelector('.acp-ticket__num')?.textContent).toBe('gh');
  });

  it('counts the rows it is showing on the listbox', () => {
    const picker = mount(base());

    expect(picker.el.querySelector('.acp-ticket__rows')?.getAttribute('data-count')).toBe('2');
    expect(picker.el.querySelector('.acp-ticket__rows')?.getAttribute('role')).toBe('listbox');
  });

  it('puts the empty note inside the rows container, which is the scroll box', () => {
    const picker = mount(base({ rows: [] }));
    const rows = picker.el.querySelector('.acp-ticket__rows');

    expect(rows?.getAttribute('data-count')).toBe('0');
    expect(rows?.innerHTML).toBe('<div class="acp-ticket__empty">no open tickets</div>');

    picker.update(base({ rows: [], tab: 'closed' }));
    expect(picker.el.querySelector('.acp-ticket__empty')?.textContent).toBe('no closed tickets');

    picker.update(base({ rows: [], filter: 'zz' }));
    expect(picker.el.querySelector('.acp-ticket__empty')?.textContent).toBe('no matching tickets');
  });

  it('emits the four actions, with the three work actions keyed off the lane', () => {
    const picker = mount(base());

    expect(picker.el.querySelector('.acp-ticket__actions')?.outerHTML).toBe(
      '<div class="acp-ticket__actions" aria-label="Selected ticket actions">' +
        '<button type="button" class="acp-ticket__action" data-ticket-action="set-ticket">' +
        '<span class="acp-ticket__action-key">Enter</span> Set ticket</button>' +
        '<button type="button" class="acp-ticket__action" data-ticket-action="analyze-github-issue">' +
        '<span class="acp-ticket__action-key">⌘1</span> Analyze</button>' +
        '<button type="button" class="acp-ticket__action" data-ticket-action="post-github-comment">' +
        '<span class="acp-ticket__action-key">⌘2</span> Post comment</button>' +
        '<button type="button" class="acp-ticket__action acp-ticket__action--fix" ' +
        'data-ticket-action="fix-github-issue">' +
        '<span class="acp-ticket__action-key">⌘3</span> Fix here</button>' +
        '</div>',
    );
  });

  it('disables the work actions with the reason as their tooltip', () => {
    const picker = mount(base({ workDisabledReason: 'codex-1 is busy' }));
    const buttons = [...picker.el.querySelectorAll<HTMLButtonElement>('.acp-ticket__action')];

    expect(buttons.map((button) => button.disabled)).toStrictEqual([false, true, true, true]);
    expect(buttons[1].title).toBe('codex-1 is busy');

    picker.update(base());
    expect(buttons.map((button) => button.disabled)).toStrictEqual([false, false, false, false]);
    expect(buttons[1].hasAttribute('title')).toBe(false);
  });

  it('disables every action while the selected row is the unavailable notice', () => {
    const picker = mount(base({ rows: [UNAVAILABLE] }));
    const buttons = [...picker.el.querySelectorAll<HTMLButtonElement>('.acp-ticket__action')];

    expect(buttons.map((button) => button.disabled)).toStrictEqual([true, true, true, true]);
  });

  it('moves --selected without rebuilding a row, and follows it', () => {
    const picker = mount(base({ cursor: 0 }));
    const rows = [...picker.el.querySelectorAll('.acp-ticket__row')];
    const untouchedChild = rows[1].firstChild;
    scrolled.length = 0;

    picker.update(base({ cursor: 1 }));

    expect([...picker.el.querySelectorAll('.acp-ticket__row')]).toStrictEqual(rows);
    expect(rows[0].className).toBe('acp-ticket__row');
    expect(rows[0].getAttribute('aria-selected')).toBe('false');
    expect(rows[1].className).toBe('acp-ticket__row acp-ticket__row--selected');
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(rows[1].firstChild).toBe(untouchedChild);
    expect(scrolled).toStrictEqual([rows[1]]);
  });

  it('re-derives the row class after the cursor comes back', () => {
    const picker = mount(base({ cursor: 1 }));
    picker.update(base({ cursor: 0 }));
    picker.update(base({ cursor: 1 }));

    const rows = [...picker.el.querySelectorAll('.acp-ticket__row')];
    expect(rows[1].className).toBe('acp-ticket__row acp-ticket__row--selected');
    expect(rows[0].className).toBe('acp-ticket__row');
  });

  it('writes nothing to the DOM when the props say the same thing', () => {
    const picker = mount(base({ cursor: 1 }));
    const observer = watch(picker.el);

    picker.update(base({ cursor: 1 }));

    expect(observer.takeRecords()).toStrictEqual([]);
    observer.disconnect();
  });

  it('reports tab, row and action selection, and stops after dispose', () => {
    const tabs: TicketPickerTab[] = [];
    const chosen: number[] = [];
    const actions: TicketPickerAction[] = [];
    const picker = mount(
      base({
        onSelectTab: (tab) => tabs.push(tab),
        onChooseRow: (index) => chosen.push(index),
        onAction: (action) => actions.push(action),
      }),
    );
    const closedTab = picker.el.querySelectorAll<HTMLElement>('.acp-ticket__tab')[1];
    const row = picker.el.querySelectorAll<HTMLElement>('.acp-ticket__row')[1];
    const fix = picker.el.querySelector<HTMLElement>('.acp-ticket__action--fix');

    closedTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    row.querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fix?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(tabs).toStrictEqual(['closed']);
    expect(chosen).toStrictEqual([1]);
    expect(actions).toStrictEqual(['fix-github-issue']);

    picker.dispose();
    closedTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fix?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(tabs).toStrictEqual(['closed']);
    expect(chosen).toStrictEqual([1]);
    expect(actions).toStrictEqual(['fix-github-issue']);
  });
});
