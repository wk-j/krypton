// Krypton — Core type definitions

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

/** Unique identifier for a terminal window */
export type WindowId = string;

/** Unique PTY session identifier (backend-assigned) */
export type SessionId = number;

/** Unique identifier for a tab within a window */
export type TabId = string;

/** Unique identifier for a pane within a tab */
export type PaneId = string;

/** Direction of a pane split */
export type SplitDirection = 'horizontal' | 'vertical';

/** Input mode for the keyboard router */
export enum Mode {
  Normal = 'Normal',
  Compositor = 'Compositor',
  Resize = 'Resize',
  Move = 'Move',
  Swap = 'Swap',
  Selection = 'Selection',
  Hint = 'Hint',
  TabMove = 'TabMove',
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

/** A leaf pane — hosts one xterm.js terminal + PTY session */
export interface Pane {
  id: PaneId;
  sessionId: SessionId | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLElement;
}

/** Binary tree node for pane splits */
export type PaneNode =
  | { type: 'leaf'; pane: Pane }
  | { type: 'split'; direction: SplitDirection; ratio: number; first: PaneNode; second: PaneNode; element: HTMLElement };

/** A tab within a window */
export interface Tab {
  id: TabId;
  title: string;
  paneTree: PaneNode;
  focusedPaneId: PaneId;
  element: HTMLElement;
}

/** Represents a terminal window's state */
export interface KryptonWindow {
  id: WindowId;
  tabs: Tab[];
  activeTabIndex: number;
  gridSlot: GridSlot;
  bounds: WindowBounds;
  element: HTMLElement;
  tabBarElement: HTMLElement;
  contentElement: HTMLElement;
}

// ─── Animation Types ──────────────────────────────────────────

/** Workspace transition animation style */
export enum AnimationStyle {
  /** No animation */
  None = 'none',
  /** Horizontal slide (like macOS Spaces) */
  Slide = 'slide',
  /** Opacity crossfade between workspaces */
  Crossfade = 'crossfade',
  /** Each window morphs from current to target position/size */
  Morph = 'morph',
}

/** Window entrance/exit effect */
export enum WindowEffect {
  None = 'none',
  FadeIn = 'fade-in',
  FadeOut = 'fade-out',
  ScaleUp = 'scale-up',
  ScaleDown = 'scale-down',
  SlideIn = 'slide-in',
  SlideOut = 'slide-out',
}

/** Easing function for animations */
export enum AnimationEasing {
  Linear = 'linear',
  EaseIn = 'ease-in',
  EaseOut = 'ease-out',
  EaseInOut = 'ease-in-out',
  Spring = 'spring',
}

/** Full animation configuration */
export interface AnimationConfig {
  /** Workspace transition style */
  style: AnimationStyle;
  /** Duration in milliseconds */
  duration: number;
  /** Easing function */
  easing: AnimationEasing;
  /** Window entrance effect */
  entranceEffect: WindowEffect;
  /** Window exit effect */
  exitEffect: WindowEffect;
}

// ─── Quick Terminal Types ─────────────────────────────────────────

/** Quick Terminal configuration */
export interface QuickTerminalConfig {
  /** Width as fraction of viewport (default 0.6) */
  widthRatio: number;
  /** Height as fraction of viewport (default 0.5) */
  heightRatio: number;
  /** Backdrop blur in px (default 20) */
  backdropBlur: number;
  /** Show/hide animation duration in ms (default 200) */
  animationDuration: number;
}

/** Default Quick Terminal configuration */
export const DEFAULT_QUICK_TERMINAL_CONFIG: QuickTerminalConfig = {
  widthRatio: 0.6,
  heightRatio: 0.5,
  backdropBlur: 20,
  animationDuration: 200,
};
