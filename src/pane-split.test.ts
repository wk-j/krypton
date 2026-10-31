import { describe, expect, it } from 'vitest';

import {
  clampSplitRatio,
  findResizableSplit,
  findSplitByElement,
  nearestSplit,
  ratioFromPointer,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
} from './pane-split';
import type { Pane, PaneNode, SplitDirection } from './types';

function leaf(id: string): PaneNode {
  return { type: 'leaf', pane: { id } as Pane };
}

function split(direction: SplitDirection, first: PaneNode, second: PaneNode): Extract<PaneNode, { type: 'split' }> {
  return { type: 'split', direction, ratio: 0.5, first, second, element: {} as HTMLElement };
}

// A | (B / C): a vertical root split whose right side is stacked horizontally.
const inner = split('horizontal', leaf('B'), leaf('C'));
const root = split('vertical', leaf('A'), inner);

describe('clampSplitRatio', () => {
  it('keeps both sides of a split at least 10% wide', () => {
    expect(clampSplitRatio(0.02)).toBe(SPLIT_RATIO_MIN);
    expect(clampSplitRatio(0.97)).toBe(SPLIT_RATIO_MAX);
    expect(clampSplitRatio(0.4)).toBe(0.4);
  });

  it('resets a non-finite ratio to an even split', () => {
    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe('findResizableSplit', () => {
  it('picks the nearest ancestor on the requested axis', () => {
    expect(findResizableSplit(root, 'C', 'horizontal')).toBe(inner);
    // C's nearest vertical divider is the root one, not its own stack.
    expect(findResizableSplit(root, 'C', 'vertical')).toBe(root);
  });

  it('returns null when no ancestor split runs on that axis', () => {
    expect(findResizableSplit(root, 'A', 'horizontal')).toBeNull();
    expect(findResizableSplit(leaf('A'), 'A', 'vertical')).toBeNull();
    expect(findResizableSplit(root, 'missing', 'vertical')).toBeNull();
  });
});

describe('nearestSplit', () => {
  it('returns the innermost split containing the pane, on either axis', () => {
    expect(nearestSplit(root, 'B')).toBe(inner);
    expect(nearestSplit(root, 'A')).toBe(root);
    expect(nearestSplit(leaf('A'), 'A')).toBeNull();
  });
});

describe('findSplitByElement', () => {
  it('finds the split whose element is the dragged divider parent', () => {
    expect(findSplitByElement(root, inner.element)).toBe(inner);
    expect(findSplitByElement(root, {} as Element)).toBeNull();
  });
});

describe('ratioFromPointer', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it('reads x for a vertical (side-by-side) split and y for a stacked one', () => {
    expect(ratioFromPointer(rect, 'vertical', 200, 999)).toBe(0.25);
    expect(ratioFromPointer(rect, 'horizontal', 999, 200)).toBe(0.75);
  });
});
