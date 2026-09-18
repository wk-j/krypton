import { describe, expect, it } from 'vitest';

import { clockwiseWindowOrder, resolveFocusLayout } from './layout';
import type { WindowBounds } from './types';

function win(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
): { id: string; bounds: WindowBounds } {
  return { id, bounds: { x, y, width, height } };
}

describe('clockwise window order', () => {
  it('cycles a three-window grid clockwise instead of creation order', () => {
    const windows = [
      win('top-left', 0, 0),
      win('bottom-left', 0, 100),
      win('right', 100, 0, 100, 200),
    ];

    expect(clockwiseWindowOrder(windows)).toEqual([
      'top-left',
      'right',
      'bottom-left',
    ]);
  });

  it('walks a two-by-two grid around its perimeter', () => {
    const windows = [
      win('top-left', 0, 0),
      win('top-right', 100, 0),
      win('bottom-left', 0, 100),
      win('bottom-right', 100, 100),
    ];

    expect(clockwiseWindowOrder(windows)).toEqual([
      'top-left',
      'top-right',
      'bottom-right',
      'bottom-left',
    ]);
  });

  it('keeps one- and two-window layouts stable', () => {
    expect(clockwiseWindowOrder([win('only', 0, 0)])).toEqual(['only']);
    expect(clockwiseWindowOrder([win('left', 0, 0), win('right', 100, 0)]))
      .toEqual(['left', 'right']);
  });
});

describe('Focus layout frame', () => {
  it('keeps the main and stack columns one gap from every screen edge', () => {
    const frame = resolveFocusLayout(1000, 800, 8, 28, 0.65);

    expect(frame.main).toEqual({ x: 8, y: 8, width: 640, height: 756 });
    expect(frame.stack).toEqual({ x: 656, y: 8, width: 336, height: 756 });
    expect(frame.stack.x + frame.stack.width).toBe(992);
    expect(frame.stack.y + frame.stack.height).toBe(764);
  });
});
