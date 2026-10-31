// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountPaneTree, type PaneTreeDomNode } from './pane-tree-dom';

function pane(id: string): { type: 'leaf'; pane: { element: HTMLElement } } {
  const element = document.createElement('div');
  element.className = 'krypton-pane';
  element.dataset.paneId = id;
  return { type: 'leaf', pane: { element } };
}

function splitEl(...children: HTMLElement[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'krypton-split';
  el.append(...children);
  return el;
}

function divider(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'krypton-split__divider';
  return el;
}

/** `A`, `|`, `(…)` rendering of what is actually in the DOM under `el`. */
function shape(el: Element): string {
  if (el.classList.contains('krypton-pane')) return (el as HTMLElement).dataset.paneId ?? '?';
  if (el.classList.contains('krypton-split__divider')) return '|';
  return `(${Array.from(el.children).map(shape).join(' ')})`;
}

describe('mountPaneTree', () => {
  it('mounts a split created under an existing split (second split in a tab)', () => {
    // DOM as splitPane leaves it: B was moved out of the root split into a new,
    // still-detached split element together with the new pane C.
    const a = pane('A');
    const b = pane('B');
    const c = pane('C');
    const inner: PaneTreeDomNode = {
      type: 'split', ratio: 0.5, first: b, second: c, element: splitEl(b.pane.element, divider(), c.pane.element),
    };
    const root: PaneTreeDomNode = {
      type: 'split', ratio: 0.5, first: a, second: inner, element: splitEl(a.pane.element, divider()),
    };
    const container = document.createElement('div');

    mountPaneTree(root, container);

    expect(Array.from(container.children).map(shape)).toEqual(['(A | (B | C))']);
  });

  it('puts the promoted sibling where its removed parent split was (closing a nested pane)', () => {
    const a = pane('A');
    const b = pane('B');
    const c = pane('C');
    const innerEl = splitEl(b.pane.element, divider(), c.pane.element);
    const rootEl = splitEl(a.pane.element, divider(), innerEl);
    const container = document.createElement('div');
    container.appendChild(rootEl);

    // closePaneInTab: C is removed, its parent split element is removed, B is promoted.
    c.pane.element.remove();
    innerEl.remove();
    container.replaceChildren();
    mountPaneTree({ type: 'split', ratio: 0.5, first: a, second: b, element: rootEl }, container);

    expect(Array.from(container.children).map(shape)).toEqual(['(A | B)']);
  });

  it('sizes children from each split ratio and clears the share of a sibling promoted to the root', () => {
    const a = pane('A');
    const b = pane('B');
    const c = pane('C');
    const inner: PaneTreeDomNode = {
      type: 'split', ratio: 0.25, first: b, second: c, element: splitEl(b.pane.element, divider(), c.pane.element),
    };
    const container = document.createElement('div');
    mountPaneTree({ type: 'split', ratio: 0.75, first: a, second: inner, element: splitEl(a.pane.element, divider()) }, container);

    expect(a.pane.element.style.flexGrow).toBe('0.75');
    expect(inner.element.style.flexGrow).toBe('0.25');
    expect(b.pane.element.style.flexGrow).toBe('0.25');
    expect(c.pane.element.style.flexGrow).toBe('0.75');

    // Closing A and then C leaves B alone in the tab: it must fill the wrapper,
    // not keep the 25% it had beside C.
    container.replaceChildren();
    mountPaneTree(b, container);

    expect(b.pane.element.style.flex).toBe('');
  });
});
