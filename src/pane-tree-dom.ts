// Krypton — Pane tree DOM mounting
// The pane tree (PaneNode) is the source of truth; this re-derives a tab's
// split DOM from it after a split or close has edited the tree.

/** Structural subset of PaneNode this module reads. */
export type PaneTreeDomNode =
  | { type: 'leaf'; pane: { element: HTMLElement } }
  | { type: 'split'; first: PaneTreeDomNode; second: PaneTreeDomNode; element: HTMLElement };

/**
 * Append `node`'s DOM to `container`, rebuilding every split element below it
 * as `[first, divider, second]`. Split and close detach or create elements at
 * any depth of the tree, so every level is re-derived, not just the root.
 */
export function mountPaneTree(node: PaneTreeDomNode, container: HTMLElement): void {
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
  container.appendChild(node.element);
}
