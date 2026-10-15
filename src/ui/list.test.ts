import { beforeEach, describe, expect, it } from 'vitest';

import { disposeList, listComponents, reconcile, syncOrder, type ListSpec } from './list';

interface Item {
  id: string;
  text: string;
}

class Cell {
  readonly el = document.createElement('li');
  updates = 0;
  disposed = 0;

  constructor(item: Item) {
    this.el.dataset.id = item.id;
    this.el.textContent = item.text;
  }

  update(item: Item): void {
    this.updates += 1;
    if (this.el.textContent !== item.text) this.el.textContent = item.text;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

const spec: ListSpec<Item, Cell> = {
  key: (item) => item.id,
  create: (item) => new Cell(item),
  update: (cmp, item) => cmp.update(item),
};

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('ul');
});

const ids = (): string[] => [...container.children].map((child) => (child as HTMLElement).dataset.id ?? '');

describe('syncOrder', () => {
  it('removes children the list does not own', () => {
    const keep = document.createElement('li');
    container.append(document.createElement('li'), keep, document.createElement('li'));

    syncOrder(container, [keep]);

    expect([...container.children]).toEqual([keep]);
  });
});

describe('reconcile', () => {
  it('reuses nodes across a reorder instead of rebuilding them', () => {
    const a: Item = { id: 'a', text: 'A' };
    const b: Item = { id: 'b', text: 'B' };
    const c: Item = { id: 'c', text: 'C' };
    reconcile(container, [a, b, c], spec);
    const nodes = [...container.children];

    reconcile(container, [c, a, b], spec);

    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(container.children[0]).toBe(nodes[2]);
    expect(container.children[1]).toBe(nodes[0]);
    expect(container.children[2]).toBe(nodes[1]);
  });

  it('keeps node identity across 100 updates — never replaceWith', () => {
    const item: Item = { id: 'a', text: 'A' };
    reconcile(container, [item], spec);
    const node = container.firstElementChild;

    for (let i = 0; i < 100; i++) {
      reconcile(container, [{ id: 'a', text: `A${i}` }], spec);
    }

    expect(container.firstElementChild).toBe(node);
    expect(container.children).toHaveLength(1);
    expect(node?.textContent).toBe('A99');
  });

  it('disposes and removes a key that fell out of the window', () => {
    reconcile(container, [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], spec);
    const dropped = listComponents(container).find((cmp) => cmp.el.dataset.id === 'a') as Cell;

    reconcile(container, [{ id: 'b', text: 'B' }], spec);

    expect(ids()).toEqual(['b']);
    expect(dropped.disposed).toBe(1);
  });

  it('does not touch a node that is already in position', () => {
    const items: Item[] = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }];
    reconcile(container, items, spec);

    const moves: MutationRecord[] = [];
    const observer = new MutationObserver((records) => moves.push(...records));
    observer.observe(container, { childList: true });
    reconcile(container, items, spec);
    moves.push(...observer.takeRecords());
    observer.disconnect();

    expect(moves).toHaveLength(0);
  });

  it('rejects duplicate keys instead of silently dropping a row', () => {
    expect(() => reconcile(container, [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }], spec)).toThrow(
      /duplicate key/,
    );
  });

  it('disposeList tears down every tracked component', () => {
    reconcile(container, [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], spec);
    const cells = listComponents(container) as Cell[];

    disposeList(container);

    expect(cells.every((cell) => cell.disposed === 1)).toBe(true);
    expect(container.children).toHaveLength(0);
    expect(listComponents(container)).toHaveLength(0);
  });
});
