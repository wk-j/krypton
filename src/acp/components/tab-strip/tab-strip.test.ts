import { describe, expect, it } from 'vitest';

import { TabStrip, type TabStripProps } from './index';

const REVIEW: TabStripProps = {
  block: 'acp-review',
  item: 'lane',
  activeClass: 'is-active',
  activeId: 'codex-1',
  tabs: [
    { id: 'codex-1', label: 'codex-1', count: 4 },
    { id: 'grok-1', label: 'grok-1', count: 2 },
  ],
};

const TICKET: TabStripProps = {
  block: 'acp-ticket',
  item: 'tab',
  activeClass: 'acp-ticket__tab--active',
  activeId: 'open',
  count: 'badge',
  role: 'tablist',
  ariaLabel: 'Ticket status',
  tabs: [
    { id: 'open', label: 'Open', count: 7 },
    { id: 'closed', label: 'Closed', count: 23 },
  ],
};

const click = (node: Element): void => {
  node.dispatchEvent(new Event('click', { bubbles: true }));
};

describe('TabStrip · markup', () => {
  it('emits the review lane switcher as the overlay builds it today', () => {
    const strip = new TabStrip();
    strip.update(REVIEW);

    expect(strip.el.outerHTML).toBe(
      '<div class="acp-review__lanes">' +
        '<span class="acp-review__lane is-active" data-tab-id="codex-1">codex-1 · 4</span>' +
        '<span class="acp-review__lane" data-tab-id="grok-1">grok-1 · 2</span>' +
        '</div>',
    );
  });

  it('emits the priority switcher from the same props, only the prefix differs', () => {
    const strip = new TabStrip();
    strip.update({ ...REVIEW, block: 'acp-priority' });

    expect(strip.el.className).toBe('acp-priority__lanes');
    expect([...strip.el.children].map((tab) => tab.className)).toEqual([
      'acp-priority__lane is-active',
      'acp-priority__lane',
    ]);
  });

  it('emits the ticket picker as buttons with a count badge and tab semantics', () => {
    const strip = new TabStrip('button');
    strip.update(TICKET);

    expect(strip.el.className).toBe('acp-ticket__tabs');
    expect(strip.el.getAttribute('role')).toBe('tablist');
    expect(strip.el.getAttribute('aria-label')).toBe('Ticket status');

    const [open, closed] = [...strip.el.children] as HTMLElement[];
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('type')).toBe('button');
    expect(open.className).toBe('acp-ticket__tab acp-ticket__tab--active');
    expect(open.getAttribute('role')).toBe('tab');
    expect(open.getAttribute('aria-selected')).toBe('true');
    expect(open.innerHTML).toBe('Open <span class="acp-ticket__tab-count">7</span>');
    expect(closed.getAttribute('aria-selected')).toBe('false');
    expect(closed.innerHTML).toBe('Closed <span class="acp-ticket__tab-count">23</span>');
  });

  it('shows a zero count in both shapes, and omits the count when there is none', () => {
    const suffix = new TabStrip();
    suffix.update({ ...REVIEW, tabs: [{ id: 'codex-1', label: 'codex-1', count: 0 }] });
    expect(suffix.el.firstElementChild?.textContent).toBe('codex-1 · 0');

    const badge = new TabStrip('button');
    badge.update({ ...TICKET, tabs: [{ id: 'open', label: 'Open', count: 0 }] });
    expect(badge.el.firstElementChild?.innerHTML).toBe('Open <span class="acp-ticket__tab-count">0</span>');

    const bare = new TabStrip();
    bare.update({ ...REVIEW, tabs: [{ id: 'codex-1', label: 'codex-1' }] });
    expect(bare.el.firstElementChild?.textContent).toBe('codex-1');
  });

  it('marks a disabled tab per element type', () => {
    const button = new TabStrip('button');
    button.update({ ...TICKET, tabs: [{ id: 'open', label: 'Open', count: 7, disabled: true }] });
    expect(button.el.firstElementChild?.hasAttribute('disabled')).toBe(true);

    const span = new TabStrip();
    span.update({ ...REVIEW, tabs: [{ id: 'codex-1', label: 'codex-1', disabled: true }] });
    expect(span.el.firstElementChild?.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('TabStrip · updates', () => {
  it('moves the active class without rebuilding a single tab node', () => {
    const strip = new TabStrip();
    strip.update(REVIEW);
    const [first, second] = [...strip.el.children];

    strip.update({ ...REVIEW, activeId: 'grok-1' });

    expect([...strip.el.children]).toEqual([first, second]);
    expect(first.className).toBe('acp-review__lane');
    expect(second.className).toBe('acp-review__lane is-active');
  });

  it('clears the active class when the active id leaves the strip entirely', () => {
    const strip = new TabStrip();
    strip.update(REVIEW);
    strip.update({ ...REVIEW, activeId: 'nobody' });

    expect([...strip.el.children].map((tab) => tab.className)).toEqual([
      'acp-review__lane',
      'acp-review__lane',
    ]);
  });

  it('keeps surviving tabs and drops the ones that fell out', () => {
    const strip = new TabStrip();
    strip.update(REVIEW);
    const survivor = strip.el.children[1];

    strip.update({
      ...REVIEW,
      activeId: 'grok-1',
      tabs: [{ id: 'grok-1', label: 'grok-1', count: 3 }],
    });

    expect(strip.el.children).toHaveLength(1);
    expect(strip.el.firstElementChild).toBe(survivor);
    expect(survivor.textContent).toBe('grok-1 · 3');
  });

  it('skips the repaint when nothing in the dependency tuple moved', () => {
    const strip = new TabStrip();
    strip.update(REVIEW);
    const text = strip.el.firstElementChild?.firstChild;

    strip.update({ ...REVIEW, tabs: REVIEW.tabs.map((tab) => ({ ...tab })) });

    expect(strip.el.firstElementChild?.firstChild).toBe(text);
  });
});

describe('TabStrip · selection', () => {
  it('reports the clicked tab through one delegated listener', () => {
    const picked: string[] = [];
    const strip = new TabStrip('button');
    strip.update({ ...TICKET, onSelect: (id) => picked.push(id) });

    click(strip.el.children[1]);
    click(strip.el.children[1].querySelector('.acp-ticket__tab-count') as Element);
    click(strip.el);

    expect(picked).toEqual(['closed', 'closed']);
  });

  it('ignores a click on a disabled tab', () => {
    const picked: string[] = [];
    const strip = new TabStrip();
    strip.update({
      ...REVIEW,
      tabs: [{ id: 'codex-1', label: 'codex-1', disabled: true }],
      onSelect: (id) => picked.push(id),
    });

    click(strip.el.firstElementChild as Element);

    expect(picked).toEqual([]);
  });

  it('uses the newest callback without forcing a repaint', () => {
    const picked: string[] = [];
    const strip = new TabStrip();
    strip.update(REVIEW);
    const node = strip.el.firstElementChild;

    strip.update({ ...REVIEW, onSelect: (id) => picked.push(`late:${id}`) });

    expect(strip.el.firstElementChild).toBe(node);
    click(node as Element);
    expect(picked).toEqual(['late:codex-1']);
  });

  it('tears the tabs down and detaches the listener on dispose', () => {
    const picked: string[] = [];
    const strip = new TabStrip();
    strip.update({ ...REVIEW, onSelect: (id) => picked.push(id) });
    const node = strip.el.firstElementChild as Element;

    strip.dispose();
    expect(strip.el.children).toHaveLength(0);

    // Put a tab back by hand: the click still reaches the container, so an
    // undetached listener would fire here.
    strip.el.appendChild(node);
    click(node);

    expect(picked).toEqual([]);
  });
});
