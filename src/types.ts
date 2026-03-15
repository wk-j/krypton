// Krypton — Core type definitions

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { ShaderInstance } from './shaders';

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
  CommandPalette = 'CommandPalette',
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
  shaderInstance: ShaderInstance | null;
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
  /** Whether this window is pinned (sticks to right column in Focus layout, skipped in focus cycle) */
  pinned: boolean;
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

// ─── Progress Bar Types (OSC 9;4) ─────────────────────────────────

/** Progress state reported by ConEmu OSC 9;4 sequences */
export enum ProgressState {
  /** Remove / hide progress indicator */
  Hidden = 0,
  /** Normal progress with percentage (0-100) */
  Normal = 1,
  /** Error state (red) */
  Error = 2,
  /** Indeterminate / pulsing */
  Indeterminate = 3,
  /** Paused state (amber) */
  Paused = 4,
}

/** Payload from the backend `pty-progress` event */
export interface ProgressEvent {
  session_id: number;
  state: ProgressState;
  /** 0-100, meaningful for Normal/Error/Paused states */
  progress: number;
}

/** Per-pane progress tracking state */
export interface PaneProgress {
  state: ProgressState;
  progress: number;
}

/** Default Quick Terminal configuration */
export const DEFAULT_QUICK_TERMINAL_CONFIG: QuickTerminalConfig = {
  widthRatio: 0.6,
  heightRatio: 0.5,
  backdropBlur: 20,
  animationDuration: 200,
};

// ─── Context Extension Types ─────────────────────────────────────

/** Information about the foreground process of a PTY session (from backend) */
export interface ProcessInfo {
  pid: number;
  name: string;
  cmdline: string[];
}

/** Payload from the backend `process-changed` event */
export interface ProcessChangedEvent {
  session_id: number;
  process: ProcessInfo | null;
  previous: string | null;
}

/** Widget position: top or bottom bar of the terminal window content area */
export type WidgetPosition = 'top' | 'bottom';

/** A rendered extension widget (horizontal bar) */
export interface ExtensionWidget {
  element: HTMLElement;
  position: WidgetPosition;
  /** Optional cleanup callback (clear intervals, listeners) */
  dispose?: () => void;
}

/** A built-in context-aware extension definition */
export interface ContextExtension {
  name: string;
  description: string;
  /** Process names that trigger this extension (exact match on basename) */
  processNames: string[];
  /** Create widget bars when the extension activates */
  createWidgets(process: ProcessInfo, sessionId: SessionId): ExtensionWidget[];
  /** Update widgets when process info changes (optional) */
  updateWidgets?(widgets: ExtensionWidget[], process: ProcessInfo): void;
  /** Custom cleanup on deactivation (optional; default removes elements) */
  destroyWidgets?(widgets: ExtensionWidget[]): void;
}

/** Tracks an active extension on a specific pane */
export interface ActiveExtension {
  extension: ContextExtension;
  widgets: ExtensionWidget[];
  process: ProcessInfo;
  paneElement: HTMLElement;
}

/** Java server process with a listening port (from backend find_java_server command) */
export interface JavaServerInfo {
  pid: number;
  port: number;
  main_class: string;
  cmdline: string[];
}

/** Java process resource statistics (from backend get_java_stats command) */
export interface JavaStats {
  heap_used_mb: number;
  heap_max_mb: number;
  heap_percent: number;
  gc_count: number;
  gc_time_secs: number;
  cpu_percent: number;
  rss_mb: number;
  pid: number;
  main_class: string;
}
