// Krypton — Grid Layout Engine
// Resolves grid slots to pixel coordinates within the workspace.

import { GridSlot, WindowBounds } from './types';

/** Layout configuration */
export interface LayoutConfig {
  /** Padding around the workspace edges in pixels */
  workspacePadding: number;
  /** Gap between windows in pixels */
  windowGap: number;
}

const DEFAULT_CONFIG: LayoutConfig = {
  workspacePadding: 0,
  windowGap: 6,
};

/**
 * Compute pixel bounds for a grid slot given the total grid dimensions
 * and available viewport size.
 */
export function resolveGridSlot(
  slot: GridSlot,
  gridCols: number,
  gridRows: number,
  viewportWidth: number,
  viewportHeight: number,
  config: LayoutConfig = DEFAULT_CONFIG,
): WindowBounds {
  const pad = config.workspacePadding;
  const gap = config.windowGap;

  // Available space after workspace padding
  const availW = viewportWidth - pad * 2;
  const availH = viewportHeight - pad * 2;

  // Cell size including gaps
  const cellW = (availW - gap * (gridCols - 1)) / gridCols;
  const cellH = (availH - gap * (gridRows - 1)) / gridRows;

  const x = pad + slot.col * (cellW + gap);
  const y = pad + slot.row * (cellH + gap);
  const width = cellW * slot.colSpan + gap * (slot.colSpan - 1);
  const height = cellH * slot.rowSpan + gap * (slot.rowSpan - 1);

  return { x, y, width, height };
}

/**
 * Auto-tile N windows into a grid.
 * Returns an array of grid slots and the grid dimensions [cols, rows].
 */
export function autoTile(count: number): { slots: GridSlot[]; gridCols: number; gridRows: number } {
  if (count <= 0) {
    return { slots: [], gridCols: 1, gridRows: 1 };
  }

  if (count === 1) {
    return {
      slots: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }],
      gridCols: 1,
      gridRows: 1,
    };
  }

  // For 2 windows: side by side
  if (count === 2) {
    return {
      slots: [
        { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      ],
      gridCols: 2,
      gridRows: 1,
    };
  }

  // For 3 windows: 2 on left, 1 tall on right
  if (count === 3) {
    return {
      slots: [
        { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { col: 0, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 0, colSpan: 1, rowSpan: 2 },
      ],
      gridCols: 2,
      gridRows: 2,
    };
  }

  // For 4: 2x2 grid
  if (count === 4) {
    return {
      slots: [
        { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 0, colSpan: 1, rowSpan: 1 },
        { col: 0, row: 1, colSpan: 1, rowSpan: 1 },
        { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      ],
      gridCols: 2,
      gridRows: 2,
    };
  }

  // General case: compute cols/rows, fill left-to-right top-to-bottom
  const gridCols = Math.ceil(Math.sqrt(count));
  const gridRows = Math.ceil(count / gridCols);
  const slots: GridSlot[] = [];

  for (let i = 0; i < count; i++) {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    slots.push({ col, row, colSpan: 1, rowSpan: 1 });
  }

  return { slots, gridCols, gridRows };
}
