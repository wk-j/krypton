import { describe, expect, it } from 'vitest';

import {
  adjustColumnWidth,
  adjustWindowHeight,
  applyScrollCamera,
  boundsForPack,
  columnsFromWindowOrder,
  consumeOrExpel,
  cyclePresetWidth,
  DEFAULT_SCROLL_LAYOUT,
  findWindowInStrip,
  insertColumnAfter,
  nextInStripOrder,
  packColumns,
  parseCenterMode,
  proportionWidth,
  removeWindowFromStrip,
  stripOrder,
  syncScrollColumns,
  usableViewport,
} from './scroll-layout';

import type { ScrollColumn } from './types';

const GAP = 8;
const FOOTER = 28;
const VW = 1000;
const VH = 800;
const { usableW, usableH } = usableViewport(VW, VH, GAP, FOOTER);

function col(ids: string[], width = 0.5, height = 1): ScrollColumn {
  return {
    windowIds: ids,
    width: proportionWidth(width),
    heights: ids.map(() => height),
  };
}

function pack(columns: ScrollColumn[]) {
  return packColumns(columns, usableW, usableH, GAP, DEFAULT_SCROLL_LAYOUT.minColumnPx);
}

describe('scroll layout pack', () => {
  it('sizes two 50% columns independently and does not reflow on insert', () => {
    const two = [col(['a']), col(['b'])];
    const packedTwo = pack(two);
    expect(packedTwo.columns).toHaveLength(2);
    expect(packedTwo.columns[0].pixelW).toBe(packedTwo.columns[1].pixelW);
    const w0 = packedTwo.columns[0].pixelW;

    const three = insertColumnAfter(two, 0, 'c', 0.5);
    expect(three[0].width.value).toBe(0.5);
    expect(three[1].windowIds).toEqual(['c']);
    expect(three[2].windowIds).toEqual(['b']);
    const packedThree = pack(three);
    expect(packedThree.columns[0].pixelW).toBe(w0);
    expect(packedThree.columns[2].pixelW).toBe(w0);
  });

  it('splits a stacked column equally in height', () => {
    const packed = pack([col(['a', 'b', 'c'])]);
    const tiles = packed.columns[0].tiles;
    expect(tiles).toHaveLength(3);
    expect(tiles[0].y).toBeCloseTo(0);
    expect(tiles[0].height).toBeCloseTo(tiles[1].height);
    expect(tiles[1].height).toBeCloseTo(tiles[2].height);
    const span = tiles[2].y + tiles[2].height - tiles[0].y;
    expect(span).toBeCloseTo(usableH);
  });

  it('sizes a lone window to default_window_height and centers the leftover', () => {
    const packed = pack([col(['a'], 0.5, 0.5)]);
    const tile = packed.columns[0].tiles[0];
    expect(tile.height).toBeCloseTo(usableH * 0.5);
    expect(tile.y).toBeCloseTo((usableH - tile.height) / 2);
  });

  it('keeps requested heights when they fit, leaving empty space below', () => {
    const packed = pack([{
      windowIds: ['a', 'b'],
      width: proportionWidth(0.5),
      heights: [0.3, 0.3],
    }]);
    const tiles = packed.columns[0].tiles;
    expect(tiles[0].height).toBeCloseTo(usableH * 0.3);
    expect(tiles[1].height).toBeCloseTo(usableH * 0.3);
    expect(tiles[1].y + tiles[1].height).toBeLessThan(usableH - 1);
    // Equal space above the first tile and below the last.
    expect(tiles[0].y).toBeCloseTo(usableH - (tiles[1].y + tiles[1].height));
  });

  it('scales stacked heights down when they overflow the column', () => {
    const packed = pack([{
      windowIds: ['a', 'b'],
      width: proportionWidth(0.5),
      heights: [0.8, 0.8],
    }]);
    const tiles = packed.columns[0].tiles;
    const span = tiles[1].y + tiles[1].height - tiles[0].y;
    expect(span).toBeCloseTo(usableH);
    expect(tiles[0].height).toBeCloseTo(tiles[1].height);
  });
});

describe('scroll camera', () => {
  it('never-mode snaps an off-screen focused column onto the right edge', () => {
    const columns = [col(['a']), col(['b']), col(['c'])];
    const packed = pack(columns);
    const config = { ...DEFAULT_SCROLL_LAYOUT, centerFocusedColumn: 'never' as const };
    const cam = applyScrollCamera(packed, 0, 2, 0, config);
    const focused = packed.columns[2];
    expect(focused.stripX).toBeGreaterThanOrEqual(cam - 0.5);
    expect(focused.stripX + focused.pixelW).toBeLessThanOrEqual(cam + packed.usableW + 0.5);
  });

  it('centers a single column when alwaysCenterSingleColumn is set', () => {
    const packed = pack([col(['a'], 0.5)]);
    const cam = applyScrollCamera(packed, 0, 0, 0, DEFAULT_SCROLL_LAYOUT);
    const bounds = boundsForPack(packed, cam).get('a')!;
    expect(bounds.x + bounds.width / 2).toBeCloseTo(VW / 2, 0);
  });

  it('always mode centers the focused column even with neighbors', () => {
    const packed = pack([col(['a']), col(['b']), col(['c'])]);
    const config = { ...DEFAULT_SCROLL_LAYOUT, centerFocusedColumn: 'always' as const };
    const cam = applyScrollCamera(packed, 0, 1, 0, config);
    const col1 = packed.columns[1];
    expect(cam).toBeCloseTo(col1.stripX + col1.pixelW / 2 - packed.usableW / 2);
  });

  it('ships always-center so the focused column sits in the middle of the screen', () => {
    expect(DEFAULT_SCROLL_LAYOUT.centerFocusedColumn).toBe('always');
    const packed = pack([col(['a']), col(['b']), col(['c'])]);
    const cam = applyScrollCamera(packed, 0, 2, 0, DEFAULT_SCROLL_LAYOUT);
    const focused = packed.columns[2];
    const bounds = boundsForPack(packed, cam).get('c')!;
    expect(cam).toBeCloseTo(focused.stripX + focused.pixelW / 2 - packed.usableW / 2);
    expect(bounds.x + bounds.width / 2).toBeCloseTo(VW / 2, 0);
  });

  it('parses missing or unknown center mode as always', () => {
    expect(parseCenterMode(undefined)).toBe('always');
    expect(parseCenterMode('always')).toBe('always');
    expect(parseCenterMode('never')).toBe('never');
    expect(parseCenterMode('on-overflow')).toBe('on-overflow');
    expect(parseCenterMode('nope')).toBe('always');
  });
});

describe('scroll mutations', () => {
  it('close drops an empty column and focuses a neighbor', () => {
    const { columns, focusId } = removeWindowFromStrip(
      [col(['a']), col(['b']), col(['c'])],
      'b',
    );
    expect(stripOrder(columns)).toEqual(['a', 'c']);
    expect(focusId).toBe('c');
  });

  it('close of a stacked window keeps the column', () => {
    const { columns, focusId } = removeWindowFromStrip([col(['a', 'b'])], 'a');
    expect(columns).toHaveLength(1);
    expect(columns[0].windowIds).toEqual(['b']);
    expect(focusId).toBe('b');
  });

  it('consume-or-expel merges an alone window into the neighbor', () => {
    const result = consumeOrExpel([col(['a']), col(['b'])], 'b', -1, 0.5);
    expect(result).not.toBeNull();
    expect(result!.columns).toHaveLength(1);
    expect(result!.columns[0].windowIds).toEqual(['a', 'b']);
  });

  it('consume-or-expel expels a stacked window to a new default-width column', () => {
    const start = [col(['a', 'b'], 0.6)];
    const result = consumeOrExpel(start, 'b', 1, 0.5);
    expect(result).not.toBeNull();
    expect(result!.columns).toHaveLength(2);
    expect(result!.columns[0].windowIds).toEqual(['a']);
    expect(result!.columns[0].width.value).toBeCloseTo(0.6);
    expect(result!.columns[1].windowIds).toEqual(['b']);
    expect(result!.columns[1].width.value).toBeCloseTo(0.5);
  });

  it('consume-or-expel is a no-op without a neighbor', () => {
    expect(consumeOrExpel([col(['a'])], 'a', 1, 0.5)).toBeNull();
  });

  it('cycles preset widths 1/3 → 1/2 → 2/3', () => {
    const presets = DEFAULT_SCROLL_LAYOUT.presetColumnWidths;
    const a = cyclePresetWidth(proportionWidth(0.5), presets);
    expect(a.value).toBeCloseTo(2 / 3);
    const b = cyclePresetWidth(a, presets);
    expect(b.value).toBeCloseTo(1 / 3);
  });

  it('resize changes only the targeted column proportion', () => {
    const next = adjustColumnWidth([col(['a']), col(['b'])], 0, 0.1);
    expect(next[0].width.value).toBeCloseTo(0.6);
    expect(next[1].width.value).toBeCloseTo(0.5);
  });

  it('resize up/down changes only the targeted window height', () => {
    const start = [{
      windowIds: ['a', 'b'],
      width: proportionWidth(0.5),
      heights: [0.5, 0.5],
    }];
    const next = adjustWindowHeight(start, 0, 0, 0.1);
    expect(next[0].heights).toEqual([0.6, 0.5]);
  });

  it('insert uses the given default window height', () => {
    const next = insertColumnAfter([col(['a'], 0.5, 1)], 0, 'b', 0.5, 0.5);
    expect(next[1].windowIds).toEqual(['b']);
    expect(next[1].heights).toEqual([0.5]);
    expect(next[0].heights).toEqual([1]);
  });

  it('consume-or-expel preserves per-window heights', () => {
    const start = [col(['a'], 0.5, 0.4), col(['b'], 0.5, 0.6)];
    const merged = consumeOrExpel(start, 'b', -1, 0.5);
    expect(merged!.columns[0].heights).toEqual([0.4, 0.6]);
    const expelled = consumeOrExpel(merged!.columns, 'b', 1, 0.5);
    expect(expelled!.columns[0].heights).toEqual([0.4]);
    expect(expelled!.columns[1].heights).toEqual([0.6]);
  });
});

describe('window gap ([workspaces] gap)', () => {
  it('spends the gap on the edge inset, between columns, and between stacked windows', () => {
    const columns = [col(['a', 'b'], 0.25), col(['c'], 0.25)];
    const packed = packColumns(columns, usableW, usableH, GAP, DEFAULT_SCROLL_LAYOUT.minColumnPx);
    const bounds = boundsForPack(packed, 0);
    const a = bounds.get('a')!;
    const b = bounds.get('b')!;
    const c = bounds.get('c')!;

    expect(a.x).toBe(GAP);                       // left edge inset
    expect(b.y - (a.y + a.height)).toBeCloseTo(GAP); // stacked windows
    expect(c.x - (a.x + a.width)).toBeCloseTo(GAP);  // adjacent columns
  });

  it('a wider gap eats column pixels, not the inset', () => {
    const columns = [col(['a'], 0.25), col(['b'], 0.25)];
    const wide = usableViewport(VW, VH, 24, FOOTER);
    const packed = packColumns(columns, wide.usableW, wide.usableH, 24, DEFAULT_SCROLL_LAYOUT.minColumnPx);
    const bounds = boundsForPack(packed, 0);
    expect(bounds.get('a')!.x).toBe(24);
    expect(bounds.get('b')!.x - (bounds.get('a')!.x + bounds.get('a')!.width)).toBeCloseTo(24);
  });
});

describe('strip order cycling', () => {
  const columns = [col(['a', 'b']), col(['c'])];

  it('walks strip order left-to-right, top-to-bottom', () => {
    expect(nextInStripOrder(columns, 'a', 1)).toBe('b');
    expect(nextInStripOrder(columns, 'b', 1)).toBe('c');
    expect(nextInStripOrder(columns, 'c', -1)).toBe('b');
  });

  it('does not wrap at either end of the strip', () => {
    expect(nextInStripOrder(columns, 'c', 1)).toBeNull();
    expect(nextInStripOrder(columns, 'a', -1)).toBeNull();
  });

  it('starts from the near end when nothing is focused', () => {
    expect(nextInStripOrder(columns, null, 1)).toBe('a');
    expect(nextInStripOrder(columns, null, -1)).toBe('c');
    expect(nextInStripOrder([], null, 1)).toBeNull();
  });
});

describe('scroll sync', () => {
  it('rebuilds one column per window from visual order', () => {
    const columns = columnsFromWindowOrder(['x', 'y'], 0.5);
    expect(columns).toHaveLength(2);
    expect(findWindowInStrip(columns, 'y')).toEqual({ col: 1, row: 0 });
  });

  it('drops dead ids and appends unknown live ids', () => {
    const synced = syncScrollColumns([col(['gone', 'a'])], ['a', 'new'], 0.5, 0.5);
    expect(stripOrder(synced)).toEqual(['a', 'new']);
    expect(synced[1].heights).toEqual([0.5]);
  });

  it('recomputes pixel widths from stored proportions on a new viewport', () => {
    const columns = [col(['a'], 0.5)];
    const small = packColumns(columns, 400, 300, GAP, 160);
    const large = packColumns(columns, 800, 300, GAP, 160);
    expect(large.columns[0].pixelW).toBeCloseTo(small.columns[0].pixelW * 2);
  });
});
