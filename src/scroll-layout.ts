// Krypton — Scroll tiling (spec 241)
// Pure niri-style strip math. Compositor owns state; this module packs,
// cameras, and mutates column lists without touching the DOM.

import type {
  CenterFocusedColumn,
  ColumnWidth,
  ScrollColumn,
  WindowBounds,
  WindowId,
} from './types';

export interface ScrollLayoutConfig {
  defaultColumnWidth: number;
  defaultWindowHeight: number;
  presetColumnWidths: number[];
  centerFocusedColumn: CenterFocusedColumn;
  alwaysCenterSingleColumn: boolean;
  minColumnPx: number;
  minWindowPx: number;
}

export const DEFAULT_SCROLL_LAYOUT: ScrollLayoutConfig = {
  defaultColumnWidth: 0.5,
  defaultWindowHeight: 1,
  presetColumnWidths: [1 / 3, 0.5, 2 / 3],
  centerFocusedColumn: 'always',
  alwaysCenterSingleColumn: true,
  minColumnPx: 160,
  minWindowPx: 120,
};

export interface ScrollTile {
  id: WindowId;
  y: number;
  height: number;
}

export interface PackedColumn {
  windowIds: WindowId[];
  width: ColumnWidth;
  stripX: number;
  pixelW: number;
  tiles: ScrollTile[];
}

export interface ScrollPack {
  columns: PackedColumn[];
  stripW: number;
  usableW: number;
  usableH: number;
  gap: number;
}

export interface WindowLocation {
  col: number;
  row: number;
}

export function parseCenterMode(value: string | undefined): CenterFocusedColumn {
  if (value === 'never' || value === 'on-overflow' || value === 'always') return value;
  return 'always';
}

export function proportionWidth(value: number): ColumnWidth {
  return { kind: 'proportion', value: clamp(value, 0.15, 1) };
}

export function proportionHeight(value: number): number {
  return clamp(value, 0.15, 1);
}

export function usableViewport(
  vw: number,
  vh: number,
  gap: number,
  footerHeight: number,
): { usableW: number; usableH: number } {
  return {
    usableW: Math.max(1, vw - gap * 2),
    usableH: Math.max(1, vh - gap * 2 - footerHeight),
  };
}

export function packColumns(
  columns: ScrollColumn[],
  usableW: number,
  usableH: number,
  gap: number,
  minColumnPx: number,
  minWindowPx: number = DEFAULT_SCROLL_LAYOUT.minWindowPx,
): ScrollPack {
  let stripX = 0;
  const packed: PackedColumn[] = [];

  for (const col of columns) {
    const pixelW = Math.round(clamp(col.width.value * usableW, minColumnPx, usableW));
    const tiles = packColumnTiles(col, usableH, gap, minWindowPx);
    packed.push({
      windowIds: col.windowIds,
      width: col.width,
      stripX,
      pixelW,
      tiles,
    });
    stripX += pixelW + gap;
  }

  const stripW = packed.length > 0 ? stripX - gap : 0;
  return { columns: packed, stripW, usableW, usableH, gap };
}

function packColumnTiles(
  col: ScrollColumn,
  usableH: number,
  gap: number,
  minWindowPx: number,
): ScrollTile[] {
  const n = col.windowIds.length;
  if (n === 0) return [];
  const heights = ensureHeights(col);
  const available = Math.max(0, usableH - gap * Math.max(0, n - 1));
  const requested = heights.map((h) => clamp(h * usableH, minWindowPx, usableH));
  const sum = requested.reduce((a, b) => a + b, 0);
  const scale = sum > available && sum > 0 ? available / sum : 1;
  const gaps = gap * Math.max(0, n - 1);
  const content = sum * scale + gaps;
  const tiles: ScrollTile[] = [];
  // Leftover vertical space is split above and below the stack (spec 241).
  let y = Math.max(0, (usableH - content) / 2);
  for (let i = 0; i < n; i++) {
    const height = requested[i] * scale;
    tiles.push({ id: col.windowIds[i], y, height });
    y += height + gap;
  }
  return tiles;
}

export function applyScrollCamera(
  pack: ScrollPack,
  cameraX: number,
  focusedCol: number,
  prevFocusedCol: number,
  config: ScrollLayoutConfig,
): number {
  const col = pack.columns[focusedCol];
  if (!col) return 0;

  const single = pack.columns.length === 1 && config.alwaysCenterSingleColumn;
  const always = config.centerFocusedColumn === 'always' || single;
  if (always) {
    return col.stripX + col.pixelW / 2 - pack.usableW / 2;
  }

  let cam = cameraX;
  if (config.centerFocusedColumn === 'on-overflow') {
    const prev = pack.columns[prevFocusedCol];
    if (prev && prevFocusedCol !== focusedCol) {
      const left = Math.min(prev.stripX, col.stripX);
      const right = Math.max(prev.stripX + prev.pixelW, col.stripX + col.pixelW);
      if (right - left > pack.usableW) {
        cam = col.stripX + col.pixelW / 2 - pack.usableW / 2;
      }
    }
  }

  if (col.stripX < cam) cam = col.stripX;
  if (col.stripX + col.pixelW > cam + pack.usableW) {
    cam = col.stripX + col.pixelW - pack.usableW;
  }
  return clampScrollCamera(cam, pack);
}

export function clampScrollCamera(cameraX: number, pack: ScrollPack): number {
  const maxCam = Math.max(0, pack.stripW - pack.usableW);
  return clamp(cameraX, 0, maxCam);
}

export function boundsForPack(
  pack: ScrollPack,
  cameraX: number,
): Map<WindowId, WindowBounds> {
  const out = new Map<WindowId, WindowBounds>();
  const gap = pack.gap;
  for (const col of pack.columns) {
    for (const tile of col.tiles) {
      out.set(tile.id, {
        x: gap + col.stripX - cameraX,
        y: gap + tile.y,
        width: col.pixelW,
        height: tile.height,
      });
    }
  }
  return out;
}

export function findWindowInStrip(
  columns: ScrollColumn[],
  id: WindowId,
): WindowLocation | null {
  for (let col = 0; col < columns.length; col++) {
    const row = columns[col].windowIds.indexOf(id);
    if (row !== -1) return { col, row };
  }
  return null;
}

export function stripOrder(columns: ScrollColumn[]): WindowId[] {
  const ids: WindowId[] = [];
  for (const col of columns) {
    for (const id of col.windowIds) ids.push(id);
  }
  return ids;
}

/**
 * Next window in strip order. Scroll does not wrap (spec 241): at either end
 * of the strip this returns null so focus stops instead of teleporting the
 * camera back across the whole strip.
 */
export function nextInStripOrder(
  columns: ScrollColumn[],
  currentId: WindowId | null,
  dir: -1 | 1,
): WindowId | null {
  const order = stripOrder(columns);
  if (order.length === 0) return null;
  const idx = currentId ? order.indexOf(currentId) : -1;
  if (idx === -1) return order[dir > 0 ? 0 : order.length - 1];
  const dest = idx + dir;
  if (dest < 0 || dest >= order.length) return null;
  return order[dest];
}

export function insertColumnAfter(
  columns: ScrollColumn[],
  focusedCol: number,
  windowId: WindowId,
  defaultWidth: number,
  defaultHeight: number = DEFAULT_SCROLL_LAYOUT.defaultWindowHeight,
): ScrollColumn[] {
  const next = cloneColumns(columns);
  const at = next.length === 0 ? 0 : clampInt(focusedCol + 1, 0, next.length);
  next.splice(at, 0, makeColumn([windowId], defaultWidth, [defaultHeight]));
  return next;
}

export function removeWindowFromStrip(
  columns: ScrollColumn[],
  windowId: WindowId,
): { columns: ScrollColumn[]; focusId: WindowId | null } {
  const loc = findWindowInStrip(columns, windowId);
  if (!loc) return { columns: cloneColumns(columns), focusId: null };

  const next = cloneColumns(columns);
  const col = next[loc.col];
  removeWindowAt(col, loc.row);

  let focusId: WindowId | null = null;
  if (col.windowIds.length > 0) {
    focusId = col.windowIds[Math.min(loc.row, col.windowIds.length - 1)];
  } else {
    next.splice(loc.col, 1);
    if (next.length > 0) {
      const neighbor = next[Math.min(loc.col, next.length - 1)];
      focusId = neighbor.windowIds[0];
    }
  }
  return { columns: next, focusId };
}

/** Consume into neighbor if alone; expel to a new column if stacked. */
export function consumeOrExpel(
  columns: ScrollColumn[],
  windowId: WindowId,
  dir: -1 | 1,
  defaultWidth: number,
): { columns: ScrollColumn[]; focusId: WindowId } | null {
  const loc = findWindowInStrip(columns, windowId);
  if (!loc) return null;
  const next = cloneColumns(columns);
  const col = next[loc.col];
  const height = ensureHeights(col)[loc.row];

  if (col.windowIds.length === 1) {
    const neighborIdx = loc.col + dir;
    const neighbor = next[neighborIdx];
    if (!neighbor) return null;
    appendWindow(neighbor, windowId, height);
    next.splice(loc.col, 1);
    return { columns: next, focusId: windowId };
  }

  removeWindowAt(col, loc.row);
  const neu = makeColumn([windowId], defaultWidth, [height]);
  if (dir < 0) {
    next.splice(loc.col, 0, neu);
  } else {
    next.splice(loc.col + 1, 0, neu);
  }
  return { columns: next, focusId: windowId };
}

export function cyclePresetWidth(
  current: ColumnWidth,
  presets: number[],
): ColumnWidth {
  if (presets.length === 0) return current;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < presets.length; i++) {
    const d = Math.abs(presets[i] - current.value);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return proportionWidth(presets[(best + 1) % presets.length]);
}

export function adjustColumnWidth(
  columns: ScrollColumn[],
  colIndex: number,
  delta: number,
): ScrollColumn[] {
  const next = cloneColumns(columns);
  const col = next[colIndex];
  if (!col) return next;
  col.width = proportionWidth(col.width.value + delta);
  return next;
}

export function adjustWindowHeight(
  columns: ScrollColumn[],
  colIndex: number,
  rowIndex: number,
  delta: number,
): ScrollColumn[] {
  const next = cloneColumns(columns);
  const col = next[colIndex];
  if (!col || rowIndex < 0 || rowIndex >= col.heights.length) return next;
  col.heights[rowIndex] = proportionHeight(col.heights[rowIndex] + delta);
  return next;
}

export function moveScrollColumn(
  columns: ScrollColumn[],
  colIndex: number,
  dir: -1 | 1,
): ScrollColumn[] {
  const dest = colIndex + dir;
  if (dest < 0 || dest >= columns.length) return columns;
  const next = cloneColumns(columns);
  const tmp = next[colIndex];
  next[colIndex] = next[dest];
  next[dest] = tmp;
  return next;
}

export function reorderScrollWindow(
  columns: ScrollColumn[],
  colIndex: number,
  rowIndex: number,
  dir: -1 | 1,
): ScrollColumn[] {
  const col = columns[colIndex];
  if (!col) return columns;
  const dest = rowIndex + dir;
  if (dest < 0 || dest >= col.windowIds.length) return columns;
  const next = cloneColumns(columns);
  const moved = next[colIndex];
  swapAt(moved.windowIds, rowIndex, dest);
  swapAt(moved.heights, rowIndex, dest);
  return next;
}

export function syncScrollColumns(
  columns: ScrollColumn[],
  liveIds: WindowId[],
  defaultWidth: number,
  defaultHeight: number = DEFAULT_SCROLL_LAYOUT.defaultWindowHeight,
): ScrollColumn[] {
  const live = new Set(liveIds);
  const next = cloneColumns(columns)
    .map((col) => {
      const kept: WindowId[] = [];
      const heights: number[] = [];
      for (let i = 0; i < col.windowIds.length; i++) {
        const id = col.windowIds[i];
        if (!live.has(id)) continue;
        kept.push(id);
        heights.push(col.heights[i]);
      }
      return { ...col, windowIds: kept, heights };
    })
    .filter((col) => col.windowIds.length > 0);

  const known = new Set(stripOrder(next));
  for (const id of liveIds) {
    if (!known.has(id)) {
      next.push(makeColumn([id], defaultWidth, [defaultHeight]));
      known.add(id);
    }
  }
  return next;
}

export function columnsFromWindowOrder(
  ids: WindowId[],
  defaultWidth: number,
  defaultHeight: number = DEFAULT_SCROLL_LAYOUT.defaultWindowHeight,
): ScrollColumn[] {
  return ids.map((id) => makeColumn([id], defaultWidth, [defaultHeight]));
}

function makeColumn(
  windowIds: WindowId[],
  width: number,
  heights?: number[],
): ScrollColumn {
  return {
    windowIds: windowIds.slice(),
    width: proportionWidth(width),
    heights: windowIds.map((_, i) => proportionHeight(heights?.[i] ?? 1)),
  };
}

function ensureHeights(col: ScrollColumn): number[] {
  const n = col.windowIds.length;
  const src = col.heights ?? [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(proportionHeight(src[i] ?? 1));
  }
  return out;
}

function removeWindowAt(col: ScrollColumn, row: number): void {
  col.windowIds.splice(row, 1);
  col.heights.splice(row, 1);
}

function appendWindow(col: ScrollColumn, id: WindowId, height: number): void {
  col.windowIds.push(id);
  col.heights.push(proportionHeight(height));
}

function swapAt<T>(arr: T[], i: number, j: number): void {
  const tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
}

function cloneColumns(columns: ScrollColumn[]): ScrollColumn[] {
  return columns.map((col) => ({
    windowIds: col.windowIds.slice(),
    width: { ...col.width },
    heights: ensureHeights(col),
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
