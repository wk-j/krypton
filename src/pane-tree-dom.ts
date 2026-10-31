// Krypton — Pane tree DOM mounting
// The pane tree (PaneNode) is the source of truth; this re-derives a tab's
// split DOM from it after a split or close has edited the tree.

/** Structural subset of PaneNode this module reads. */
export type PaneTreeDomNode =
  | { type: 'leaf'; pane: { element: HTMLElement } }
  | { type: 'split'; ratio: number; first: PaneTreeDomNode; second: PaneTreeDomNode; element: HTMLElement };

function nodeElement(node: PaneTreeDomNode): HTMLElement {
  return node.type === 'leaf' ? node.pane.element : node.element;
}

/** Size both children of `node` from its ratio (spec 296). */
export function applySplitFlex(node: Extract<PaneTreeDomNode, { type: 'split' }>): void {
  nodeElement(node.first).style.flex = `${node.ratio} 1 0`;
  nodeElement(node.second).style.flex = `${1 - node.ratio} 1 0`;
}

/**
 * Append `node`'s DOM to `container`, rebuilding every split element below it
 * as `[first, divider, second]`. Split and close detach or create elements at
 * any depth of the tree, so every level is re-derived, not just the root.
 * Sizing is re-derived too: a node's inline flex is cleared and only its parent
 * split sets it again, so a sibling promoted to the root by a close stops
 * carrying the share it had inside the removed split.
 */
export function mountPaneTree(node: PaneTreeDomNode, container: HTMLElement): void {
  nodeElement(node).style.flex = '';
  if (node.type === 'leaf') {
    container.appendChild(node.pane.element);
    return;
  }
  const divider = Array.from(node.element.children).find((child) =>
    child.classList.contains('krypton-split__divider'),
  );
  node.element.replaceChildren();
  mountPaneTree(node.first, node.element);
  if (divider) node.element.appendChild(divider);
  mountPaneTree(node.second, node.element);
  applySplitFlex(node);
  container.appendChild(node.element);
}
