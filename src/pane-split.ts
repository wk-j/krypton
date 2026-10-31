// Krypton — Pane split ratio helpers (spec 296).
// Pure functions over the pane tree: which split a keyboard step or a divider
// drag edits, and the ratio bounds every edit is clamped to.

import type { PaneId, PaneNode, SplitDirection } from './types';

type SplitNode = Extract<PaneNode, { type: 'split' }>;

/** Smallest share either side of a split keeps after a keyboard step or drag. */
export const SPLIT_RATIO_MIN = 0.1;
export const SPLIT_RATIO_MAX = 0.9;

export function clampSplitRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, r));
}

/** Splits on the path from `node` down to `paneId`'s leaf, outermost first;
 *  null when the pane is not in the tree. */
function splitsAbove(node: PaneNode, paneId: PaneId): SplitNode[] | null {
  if (node.type === 'leaf') return node.pane.id === paneId ? [] : null;
  const below = splitsAbove(node.first, paneId) ?? splitsAbove(node.second, paneId);
  return below ? [node, ...below] : null;
}

/** Nearest ancestor split of `paneId` whose direction is `axis`; null if none. */
export function findResizableSplit(tree: PaneNode, paneId: PaneId, axis: SplitDirection): SplitNode | null {
  const chain = splitsAbove(tree, paneId) ?? [];
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].direction === axis) return chain[i];
  }
  return null;
}

/** Nearest ancestor split of `paneId` on either axis. */
export function nearestSplit(tree: PaneNode, paneId: PaneId): SplitNode | null {
  const chain = splitsAbove(tree, paneId) ?? [];
  return chain.length > 0 ? chain[chain.length - 1] : null;
}

/** The split node that owns `element` (a `.krypton-split`), or null. */
export function findSplitByElement(tree: PaneNode, element: Element): SplitNode | null {
  if (tree.type === 'leaf') return null;
  if (tree.element === element) return tree;
  return findSplitByElement(tree.first, element) ?? findSplitByElement(tree.second, element);
}

/** Ratio for a pointer position inside the split element's rect, before clamping. */
export function ratioFromPointer(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  direction: SplitDirection,
  clientX: number,
  clientY: number,
): number {
  return direction === 'vertical'
    ? (clientX - rect.left) / Math.max(1, rect.width)
    : (clientY - rect.top) / Math.max(1, rect.height);
}
