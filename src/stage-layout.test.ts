import { describe, expect, it } from 'vitest';

import {
  computeStageLayout,
  defaultStageFrame,
  focusStage,
  rotateStageOrder,
  syncStageOrder,
} from './stage-layout';

const VW = 1440;
const VH = 900;
const GAP = 8;
const FOOTER = 28;

function layout(order: string[], width = VW, height = VH) {
  return computeStageLayout({
    order,
    frame: defaultStageFrame(width, height, GAP, FOOTER),
    viewportWidth: width,
    viewportHeight: height,
    gap: GAP,
    footerHeight: FOOTER,
  });
}

describe('stage order', () => {
  it('removes stale IDs, appends new windows, and promotes focus', () => {
    expect(syncStageOrder(['a', 'gone', 'b'], ['a', 'b', 'c'], 'b'))
      .toEqual(['b', 'a', 'c']);
  });

  it('moves directly focused windows to the front without duplicates', () => {
    expect(focusStage(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(focusStage(['a', 'b'], 'missing')).toEqual(['a', 'b']);
  });

  it('rotates in both directions so every stage remains reachable', () => {
    expect(rotateStageOrder(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a']);
    expect(rotateStageOrder(['a', 'b', 'c'], -1)).toEqual(['c', 'a', 'b']);
  });
});

describe('stage geometry', () => {
  it('places one active window beside a left shelf of recent windows', () => {
    const result = layout(['a', 'b', 'c']);
    const [active, first, second] = result.placements;

    expect(result.shelfWidth).toBeGreaterThan(0);
    expect(active.role).toBe('active');
    expect(active.baseBounds.x).toBeGreaterThan(result.shelfWidth);
    expect(first.role).toBe('shelf');
    expect(second.role).toBe('shelf');
    expect(first.translateX).toBeLessThan(0);
    expect(first.scale).toBeLessThan(1);
    expect(second.translateY).toBeGreaterThan(first.translateY);
  });

  it('uses identical base bounds for active and shelf windows', () => {
    const result = layout(['a', 'b', 'c', 'd']);
    for (const placement of result.placements) {
      expect(placement.baseBounds).toEqual(result.frameBounds);
    }
  });

  it('shows at most five recent windows and keeps the rest hidden', () => {
    const result = layout(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(result.placements.filter((p) => p.role === 'shelf')).toHaveLength(5);
    expect(result.placements.filter((p) => p.role === 'hidden')).toHaveLength(2);
  });

  it('centers a lone window without reserving an empty shelf', () => {
    const result = layout(['a']);
    const active = result.placements[0];
    expect(result.shelfWidth).toBe(0);
    expect(Math.abs(active.baseBounds.x + active.baseBounds.width / 2 - VW / 2)).toBeLessThanOrEqual(1);
  });

  it('hides the shelf when a narrow viewport cannot fit it beside the minimum stage', () => {
    const result = layout(['a', 'b'], 420, 700);
    expect(result.shelfWidth).toBe(0);
    expect(result.visibleRecentCount).toBe(0);
    expect(result.placements[1].role).toBe('hidden');
    expect(result.frameBounds.x + result.frameBounds.width / 2).toBe(210);
  });

  it('reduces visible recents when the viewport is too short for 72px cards', () => {
    const result = layout(['a', 'b', 'c', 'd', 'e', 'f'], 1200, 300);
    expect(result.visibleRecentCount).toBeLessThan(5);
    expect(result.visibleRecentCount).toBeGreaterThan(0);
  });

  it('clamps a moved or resized frame inside the area to the right of the shelf', () => {
    const frame = { x: -1, y: -1, width: 2, height: 2 };
    const result = computeStageLayout({
      order: ['a', 'b'],
      frame,
      viewportWidth: VW,
      viewportHeight: VH,
      gap: GAP,
      footerHeight: FOOTER,
    });
    const b = result.frameBounds;
    expect(b.x).toBeGreaterThan(result.shelfWidth);
    expect(b.y).toBe(GAP);
    expect(b.x + b.width).toBeLessThanOrEqual(VW - GAP);
    expect(b.y + b.height).toBeLessThanOrEqual(VH - FOOTER - GAP);
  });
});
