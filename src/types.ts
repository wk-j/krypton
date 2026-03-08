// Krypton — Core type definitions

/** Unique identifier for a terminal window */
export type WindowId = string;

/** Unique PTY session identifier (backend-assigned) */
export type SessionId = number;

/** Input mode for the keyboard router */
export enum Mode {
  Normal = 'Normal',
  Compositor = 'Compositor',
  Resize = 'Resize',
  Move = 'Move',
  Swap = 'Swap',
}

/** Layout strategy for tiling windows */
export enum LayoutMode {
  /** Auto-tile in a balanced grid */
  Grid = 'Grid',
  /** Focused window on left (full height), remaining windows stacked on right */
  Focus = 'Focus',
}

/** A slot in the grid layout */
export interface GridSlot {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

/** Resolved pixel bounds for a window */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Represents a terminal window's state */
export interface KryptonWindow {
  id: WindowId;
  sessionId: SessionId | null;
  gridSlot: GridSlot;
  bounds: WindowBounds;
  element: HTMLElement;
  terminalContainer: HTMLElement;
}
