import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MergedHandoff } from '../../xenon-push';
import { HandoffPicker, type HandoffPickerProps } from './index';

const NOW = 1_760_000_000_000;

const ROWS: readonly MergedHandoff[] = [
  {
    id: 'ho-mv6qbxhh-85bcbb',
    author: 'wk',
    host: 'studio',
    summary: 'wire the resume tail through applyResume',
    detail: 'reserve, resolve, bind, dispatch',
    createdAt: NOW - 10 * 60_000,
    updatedAt: NOW - 5 * 60_000,
    source: 'local',
  },
  {
    id: 'ho-mv6qbxhh-91ab02',
    author: 'ana',
    host: 'tower',
    summary: 'merge xenon rows by id',
    detail: null,
    createdAt: NOW - 4 * 3_600_000,
    updatedAt: NOW - 3 * 3_600_000,
    source: 'xenon',
  },
  {
    id: 'ho-mv6qbxhh-0c17de',
    author: 'wk',
    host: 'studio',
    summary: '',
    detail: 'an older thread with no summary',
    createdAt: NOW - 13 * 86_400_000,
    updatedAt: NOW - 12 * 86_400_000,
    source: 'local',
  },
];

const pickers: HandoffPicker[] = [];
const scrolled: Element[] = [];

const base = (over: Partial<HandoffPickerProps> = {}): HandoffPickerProps => ({
  open: true,
  laneName: 'claude-1',
  rows: ROWS,
  cursor: 0,
  boundId: null,
  now: NOW,
  note: null,
  ...over,
});

const mount = (props: HandoffPickerProps): HandoffPicker => {
  const picker = new HandoffPicker();
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

const rowsOf = (picker: HandoffPicker): HTMLElement[] => [...picker.el.querySelectorAll('li')];

const textOf = (picker: HandoffPicker, selector: string): string | undefined =>
  picker.el.querySelector(selector)?.textContent ?? undefined;

beforeEach(() => {
  scrolled.length = 0;
  // happy-dom has no layout; record which node was asked to scroll.
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

describe('HandoffPicker', () => {
  it('emits head, one row per merged handoff and the preview as a list sibling', () => {
    const picker = mount(base());

    expect(picker.el.outerHTML).toBe(
      '<aside class="acp-harness__handoff-picker">' +
        '<header class="acp-harness__handoff-head">' +
        '<span>// handoff · claude-1</span>' +
        '<span>3 handoffs · j/k move · enter resume · esc cancel</span>' +
        '</header>' +
        '<ul class="acp-harness__handoff-list">' +
        '<li class="acp-harness__handoff-row acp-harness__handoff-row--active" data-handoff-index="0">' +
        '<span class="acp-harness__handoff-id">ho-mv6qbxhh-85bcbb</span>' +
        '<span class="acp-harness__handoff-age">5m</span>' +
        '<span class="acp-harness__handoff-host">studio</span>' +
        '<span class="acp-harness__handoff-author">wk</span>' +
        '<span class="acp-harness__handoff-summary">wire the resume tail through applyResume</span>' +
        '<span class="acp-harness__handoff-tag">local</span>' +
        '</li>' +
        '<li class="acp-harness__handoff-row" data-handoff-index="1">' +
        '<span class="acp-harness__handoff-id">ho-mv6qbxhh-91ab02</span>' +
        '<span class="acp-harness__handoff-age">3h</span>' +
        '<span class="acp-harness__handoff-host">tower</span>' +
        '<span class="acp-harness__handoff-author">ana</span>' +
        '<span class="acp-harness__handoff-summary">merge xenon rows by id</span>' +
        '<span class="acp-harness__handoff-tag acp-harness__handoff-tag--xenon">xenon</span>' +
        '</li>' +
        '<li class="acp-harness__handoff-row" data-handoff-index="2">' +
        '<span class="acp-harness__handoff-id">ho-mv6qbxhh-0c17de</span>' +
        '<span class="acp-harness__handoff-age">12d</span>' +
        '<span class="acp-harness__handoff-host">studio</span>' +
        '<span class="acp-harness__handoff-author">wk</span>' +
        '<span class="acp-harness__handoff-summary">(no summary)</span>' +
        '<span class="acp-harness__handoff-tag">local</span>' +
        '</li>' +
        '</ul>' +
        '<div class="acp-harness__handoff-preview">' +
        '<div class="acp-harness__handoff-preview-head">' +
        '<span class="acp-harness__handoff-preview-scope">ho-mv6qbxhh-85bcbb · wk@studio · 5m</span>' +
        '<span class="acp-harness__handoff-preview-source">local</span>' +
        '</div>' +
        '<div class="acp-harness__handoff-preview-summary">wire the resume tail through applyResume</div>' +
        '<div class="acp-harness__handoff-preview-detail">reserve, resolve, bind, dispatch</div>' +
        '</div>' +
        '</aside>',
    );
  });

  it('never slices the summary — truncation is the stylesheet\'s job', () => {
    const summary = 'x'.repeat(400);
    const picker = mount(base({ rows: [{ ...ROWS[0], summary }] }));

    expect(textOf(picker, '.acp-harness__handoff-summary')).toBe(summary);
  });

  it('moves --active with the cursor without rebuilding a row', () => {
    const picker = mount(base({ cursor: 0 }));
    const rows = rowsOf(picker);
    const untouchedChild = rows[2].firstChild;

    picker.update(base({ cursor: 1 }));

    expect(rowsOf(picker)).toStrictEqual(rows);
    expect(rows[0].className).toBe('acp-harness__handoff-row');
    expect(rows[1].className).toBe('acp-harness__handoff-row acp-harness__handoff-row--active');
    expect(rows[2].firstChild).toBe(untouchedChild);
  });

  it('keeps the cursor row scrolled into view', () => {
    const picker = mount(base({ cursor: 2 }));

    expect(scrolled).toStrictEqual([rowsOf(picker)[2]]);
  });

  it('tracks the cursor in the preview', () => {
    const picker = mount(base({ cursor: 0 }));
    expect(textOf(picker, '.acp-harness__handoff-preview-detail')).toBe(
      'reserve, resolve, bind, dispatch',
    );

    picker.update(base({ cursor: 2 }));

    expect(textOf(picker, '.acp-harness__handoff-preview-scope')).toBe(
      'ho-mv6qbxhh-0c17de · wk@studio · 12d',
    );
    expect(textOf(picker, '.acp-harness__handoff-preview-summary')).toBe('(no summary)');
    expect(textOf(picker, '.acp-harness__handoff-preview-detail')).toBe(
      'an older thread with no summary',
    );
  });

  it('says a xenon-only detail is fetched on resume', () => {
    const picker = mount(base({ cursor: 1 }));

    const detail = picker.el.querySelector('.acp-harness__handoff-preview-detail');
    expect(detail?.textContent).toBe('detail lives on xenon - fetched on resume');
    expect(detail?.className).toBe(
      'acp-harness__handoff-preview-detail acp-harness__handoff-preview-detail--deferred',
    );

    picker.update(base({ cursor: 0 }));
    expect(picker.el.querySelector('.acp-harness__handoff-preview-detail')?.className).toBe(
      'acp-harness__handoff-preview-detail',
    );
  });

  it('marks the handoff this lane is already bound to', () => {
    const picker = mount(base({ boundId: 'ho-mv6qbxhh-91ab02' }));

    const rows = rowsOf(picker);
    expect(rows[1].className).toBe('acp-harness__handoff-row acp-harness__handoff-row--bound');
    expect(rows[1].querySelector('.acp-harness__handoff-bound')?.textContent).toBe('bound');
    expect(rows[0].querySelector('.acp-harness__handoff-bound')).toBeNull();
  });

  it('carries the xenon note in the head', () => {
    const picker = mount(base({ note: 'xenon unreachable - local handoffs only' }));

    expect(picker.el.querySelector('header')?.lastElementChild?.textContent).toBe(
      '3 handoffs · xenon unreachable - local handoffs only · j/k move · enter resume · esc cancel',
    );
  });

  it('replaces the list and the preview with one empty line when there is nothing to pick', () => {
    const picker = mount(base({ rows: [] }));

    expect(textOf(picker, '.acp-harness__handoff-empty')).toBe('no handoffs in this project');
    expect(picker.el.querySelector('ul')).toBeNull();
    expect(picker.el.querySelector('.acp-harness__handoff-preview')).toBeNull();
  });

  it('comes back from the empty state when a handoff is written', () => {
    const picker = mount(base({ rows: [] }));
    picker.update(base());

    expect(picker.el.querySelector('.acp-harness__handoff-empty')).toBeNull();
    expect(rowsOf(picker).length).toBe(3);
    expect(picker.el.querySelector('.acp-harness__handoff-preview')).not.toBeNull();
  });

  it('stays hidden while closed', () => {
    const picker = mount(base({ open: false }));
    expect(picker.el.hidden).toBe(true);

    picker.update(base({ open: true }));
    expect(picker.el.hidden).toBe(false);
  });

  it('shuts when the lane that opened it went away', () => {
    const picker = mount(base());
    expect(picker.el.hidden).toBe(false);

    picker.update(base({ laneName: null }));
    expect(picker.el.hidden).toBe(true);
  });

  it('writes nothing to the DOM when the props say the same thing', () => {
    const picker = mount(base({ cursor: 1 }));
    const observer = watch(picker.el);

    picker.update(base({ cursor: 1 }));

    expect(observer.takeRecords()).toStrictEqual([]);
    observer.disconnect();
  });

  it('ignores a `now` that has not crossed an age bucket', () => {
    const picker = mount(base());
    const observer = watch(picker.el);

    picker.update(base({ now: NOW + 1_000 }));

    expect(observer.takeRecords()).toStrictEqual([]);
    observer.disconnect();
  });

  it('leaves the single open slot on dispose', () => {
    const picker = new HandoffPicker();
    picker.update(base());
    picker.dispose();

    const other = new HandoffPicker();
    other.update(base());
    expect(other.el.hidden).toBe(false);
    other.dispose();
  });
});
