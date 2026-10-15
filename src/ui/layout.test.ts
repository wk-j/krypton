import { beforeEach, describe, expect, it } from 'vitest';

import { LayoutHost, type LayoutTable, type Mountable } from './layout';

type Slot = 'rail.top' | 'rail.bottom' | 'dock.right';

class Panel implements Mountable {
  readonly el = document.createElement('section');
  disposed = 0;

  constructor(name: string) {
    this.el.dataset.panel = name;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

const DEFAULT_LAYOUT: LayoutTable<Slot> = {
  plan: { slot: 'rail.top', order: 10 },
  peek: { slot: 'rail.top', order: 20 },
  thought: { slot: 'rail.top', order: 30 },
  queue: { slot: 'rail.bottom', order: 10 },
  ticket: { slot: 'dock.right', order: 10 },
};

let slots: Record<Slot, HTMLElement>;
let host: LayoutHost<Slot>;

beforeEach(() => {
  slots = {
    'rail.top': document.createElement('div'),
    'rail.bottom': document.createElement('div'),
    'dock.right': document.createElement('div'),
  };
  host = new LayoutHost<Slot>(slots, DEFAULT_LAYOUT);
});

const panelsIn = (slot: Slot): string[] =>
  [...slots[slot].children].map((child) => (child as HTMLElement).dataset.panel ?? '');

describe('LayoutHost', () => {
  it('places components in their slot, sorted by order regardless of mount order', () => {
    host.mount('thought', new Panel('thought'));
    host.mount('plan', new Panel('plan'));
    host.mount('peek', new Panel('peek'));
    host.mount('queue', new Panel('queue'));

    expect(panelsIn('rail.top')).toEqual(['plan', 'peek', 'thought']);
    expect(panelsIn('rail.bottom')).toEqual(['queue']);
  });

  it('moves a panel to another slot on a one-line table change, without disposing it', () => {
    const plan = new Panel('plan');
    host.mount('plan', plan);
    host.mount('peek', new Panel('peek'));
    const node = plan.el;

    host.apply({ ...DEFAULT_LAYOUT, plan: { slot: 'dock.right', order: 5 } });

    expect(panelsIn('rail.top')).toEqual(['peek']);
    expect(panelsIn('dock.right')).toEqual(['plan']);
    expect(slots['dock.right'].firstElementChild).toBe(node);
    expect(plan.disposed).toBe(0);
  });

  it('reorders within a slot when only the order changes', () => {
    host.mount('plan', new Panel('plan'));
    host.mount('peek', new Panel('peek'));

    host.apply({ ...DEFAULT_LAYOUT, plan: { slot: 'rail.top', order: 99 } });

    expect(panelsIn('rail.top')).toEqual(['peek', 'plan']);
  });

  it('unmounts a panel the new table drops', () => {
    const ticket = new Panel('ticket');
    host.mount('ticket', ticket);

    const { ticket: _dropped, ...withoutTicket } = DEFAULT_LAYOUT;
    host.apply(withoutTicket);

    expect(panelsIn('dock.right')).toEqual([]);
    expect(ticket.disposed).toBe(1);
  });

  it('replacing a mounted id disposes the component it replaced', () => {
    const first = new Panel('plan');
    const second = new Panel('plan2');
    host.mount('plan', first);
    host.mount('plan', second);

    expect(first.disposed).toBe(1);
    expect(panelsIn('rail.top')).toEqual(['plan2']);
  });

  it('refuses a component with no layout entry instead of guessing a slot', () => {
    expect(() => host.mount('nope', new Panel('nope'))).toThrow(/no layout entry/);
  });

  it('dispose tears down every mounted panel', () => {
    const plan = new Panel('plan');
    const queue = new Panel('queue');
    host.mount('plan', plan);
    host.mount('queue', queue);

    host.dispose();

    expect(plan.disposed).toBe(1);
    expect(queue.disposed).toBe(1);
    expect(panelsIn('rail.top')).toEqual([]);
  });
});
