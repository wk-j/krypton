// Krypton — Compositor
// Manages terminal windows: creation, destruction, layout, focus, resize, move.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import {
  WindowId,
  WindowBounds,
  KryptonWindow,
  LayoutMode,
  AnimationConfig,
  QuickTerminalConfig,
  DEFAULT_QUICK_TERMINAL_CONFIG,
} from './types';
import { autoTile, focusTile, resolveGridSlot } from './layout';
import { AnimationEngine, BoundsSnapshot } from './animation';
import { SoundEngine } from './sound';
import type { KryptonConfig } from './config';
import type { FrontendThemeEngine } from './theme';

/** Custom key event handler for xterm.js — set by InputRouter */
type CustomKeyHandler = (e: KeyboardEvent) => boolean;

/** Terminal + addons for a window */
interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
}

/**
 * Abbreviate an absolute path for display in the title bar.
 * - Replaces $HOME with ~
 * - If deeper than 2 levels, shows .../parent/leaf
 * - Max length capped at 40 chars
 */
function abbreviatePath(fullPath: string): string {
  let p = fullPath;
  // Replace home dir with ~ (detect /Users/xxx or /home/xxx prefix)
  const homeMatch = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (homeMatch) {
    p = '~' + p.slice(homeMatch[1].length);
  }
  // If too long, abbreviate middle segments
  const parts = p.split('/').filter(Boolean);
  if (parts.length > 3) {
    const prefix = p.startsWith('~') ? '' : '/';
    p = `${prefix}${parts[0]}/.../` + parts.slice(-2).join('/');
  }
  // Cap length
  if (p.length > 40) {
    p = '...' + p.slice(p.length - 37);
  }
  return p;
}

/** xterm.js built-in theme fallback (used when theme engine not yet initialized) */
const DEFAULT_TERMINAL_THEME: Record<string, string> = {
  background: 'rgba(10, 10, 15, 0.5)',
  foreground: '#b0c4d8',
  cursor: '#0cf',
  cursorAccent: '#0a0a0f',
  selectionBackground: 'rgba(26, 58, 92, 0.6)',
  selectionForeground: '#ffffff',
  black: '#0a0a0f',
  red: '#ff3a5c',
  green: '#0cf',
  yellow: '#e8c547',
  blue: '#4a9eff',
  magenta: '#c77dff',
  cyan: '#0cf',
  white: '#b0c4d8',
  brightBlack: '#2a4a6c',
  brightRed: '#ff5c7a',
  brightGreen: '#33ddff',
  brightYellow: '#ffd866',
  brightBlue: '#6ab4ff',
  brightMagenta: '#d9a0ff',
  brightCyan: '#33ddff',
  brightWhite: '#ffffff',
};

/** Minimum window dimensions */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

/** Counter for unique window IDs */
let windowIdCounter = 0;

function nextWindowId(): WindowId {
  return `win-${windowIdCounter++}`;
}

export class Compositor {
  private windows: Map<WindowId, KryptonWindow> = new Map();
  private terminals: Map<WindowId, TerminalInstance> = new Map();
  private focusedWindowId: WindowId | null = null;
  private workspace: HTMLElement;
  private onFocusChangeCallbacks: Array<(id: WindowId | null) => void> = [];
  private customKeyHandler: CustomKeyHandler | null = null;
  private layoutMode: LayoutMode = LayoutMode.Focus;
  /** Visual order of window IDs after the last Focus layout relayout.
   *  Index 0 = left (main) column, 1..N = top-to-bottom right stack. */
  private focusVisualOrder: WindowId[] = [];
  /** When a window is maximized, store its ID here. Only one window can be maximized at a time. */
  private maximizedWindowId: WindowId | null = null;
  /** Animation engine for layout transitions and window effects */
  private animation: AnimationEngine = new AnimationEngine();
  /** Sound engine for procedural sound effects */
  private sound: SoundEngine = new SoundEngine();

  // ─── Theme Engine ─────────────────────────────────────────────────
  /** Reference to the frontend theme engine (set via setThemeEngine) */
  private themeEngine: FrontendThemeEngine | null = null;

  // ─── Config-backed settings ──────────────────────────────────────
  /** xterm.js theme — built-in default, overridable by config theme.colors */
  private terminalTheme: Record<string, string> = { ...DEFAULT_TERMINAL_THEME };
  /** Font family for terminals */
  private fontFamily = "'Mononoki Nerd Font Mono', 'JetBrains Mono', 'Fira Code', monospace";
  /** Font size for terminals */
  private fontSize = 14;
  /** Line height for terminals */
  private lineHeight = 1.2;
  /** Scrollback lines */
  private scrollbackLines = 10000;
  /** Cursor style */
  private cursorStyle: 'block' | 'underline' | 'bar' = 'block';
  /** Cursor blink */
  private cursorBlink = true;
  /** Pixels per arrow key step in resize/move mode */
  private stepSize = 20;
  /** Window gap in pixels */
  private windowGap = 6;

  // ─── Quick Terminal State ─────────────────────────────────────────
  private qtConfig: QuickTerminalConfig = { ...DEFAULT_QUICK_TERMINAL_CONFIG };
  /** The Quick Terminal DOM element (null until first show) */
  private qtElement: HTMLElement | null = null;
  /** xterm.js terminal instance for Quick Terminal */
  private qtTerminal: TerminalInstance | null = null;
  /** PTY session ID for Quick Terminal */
  private qtSessionId: number | null = null;
  /** Whether the Quick Terminal is currently visible */
  private qtVisible = false;
  /** Previously focused workspace window ID (restored when QT hides) */
  private qtSavedFocusId: WindowId | null = null;
  /** Whether the Quick Terminal has been lazily initialized */
  private qtInitialized = false;

  constructor(workspace: HTMLElement) {
    this.workspace = workspace;
    this.setupResizeHandler();
    this.setupPtyListeners();
  }

  /** Apply loaded config to compositor settings. Call before creating windows. */
  applyConfig(config: KryptonConfig): void {
    // Font
    this.fontFamily = `'${config.font.family}', 'Fira Code', 'Cascadia Code', monospace`;
    this.fontSize = config.font.size;
    this.lineHeight = config.font.line_height;

    // Terminal
    this.scrollbackLines = config.terminal.scrollback_lines;
    this.cursorStyle = config.terminal.cursor_style;
    this.cursorBlink = config.terminal.cursor_blink;

    // Theme: if the theme engine is connected, use its xterm theme;
    // otherwise fall back to config-based color overrides.
    if (this.themeEngine) {
      this.terminalTheme = this.themeEngine.buildXtermTheme();
    } else {
      // Legacy fallback: merge config colors on top of hardcoded default
      const c = config.theme.colors;
      const theme: Record<string, string> = { ...DEFAULT_TERMINAL_THEME };
      if (c.foreground) theme.foreground = c.foreground;
      if (c.background) theme.background = c.background;
      if (c.cursor) theme.cursor = c.cursor;
      if (c.selection) theme.selectionBackground = c.selection;
      if (c.black) theme.black = c.black;
      if (c.red) theme.red = c.red;
      if (c.green) theme.green = c.green;
      if (c.yellow) theme.yellow = c.yellow;
      if (c.blue) theme.blue = c.blue;
      if (c.magenta) theme.magenta = c.magenta;
      if (c.cyan) theme.cyan = c.cyan;
      if (c.white) theme.white = c.white;
      if (c.bright_black) theme.brightBlack = c.bright_black;
      if (c.bright_red) theme.brightRed = c.bright_red;
      if (c.bright_green) theme.brightGreen = c.bright_green;
      if (c.bright_yellow) theme.brightYellow = c.bright_yellow;
      if (c.bright_blue) theme.brightBlue = c.bright_blue;
      if (c.bright_magenta) theme.brightMagenta = c.bright_magenta;
      if (c.bright_cyan) theme.brightCyan = c.bright_cyan;
      if (c.bright_white) theme.brightWhite = c.bright_white;
      this.terminalTheme = theme;
    }

    // Quick Terminal
    this.qtConfig = {
      widthRatio: config.quick_terminal.width_ratio,
      heightRatio: config.quick_terminal.height_ratio,
      backdropBlur: config.quick_terminal.backdrop_blur,
      animationDuration: 200, // not yet in TOML, keep default
    };

    // Workspaces
    this.windowGap = config.workspaces.gap;
    this.stepSize = config.workspaces.resize_step;

    // Sound
    this.sound.applyConfig(config.sound);
  }

  /**
   * Set the frontend theme engine. The compositor will use it to build the
   * xterm.js theme and will register for theme change callbacks.
   */
  setThemeEngine(engine: FrontendThemeEngine): void {
    this.themeEngine = engine;

    // Use the theme engine's xterm theme if available
    const xtermTheme = engine.buildXtermTheme();
    if (Object.keys(xtermTheme).length > 0) {
      this.terminalTheme = xtermTheme;
    }

    // Listen for theme changes — update all existing terminals
    engine.onChange(() => {
      this.updateTerminalThemes();
    });
  }

  /**
   * Update all existing terminal instances with the current theme.
   * Called on theme hot-reload so open terminals reflect the new colors.
   */
  private updateTerminalThemes(): void {
    if (!this.themeEngine) return;

    const xtermTheme = this.themeEngine.buildXtermTheme();
    this.terminalTheme = xtermTheme;

    // Update all workspace terminals
    for (const [, termInfo] of this.terminals) {
      termInfo.terminal.options.theme = xtermTheme;
    }

    // Update Quick Terminal if it exists
    if (this.qtTerminal) {
      this.qtTerminal.terminal.options.theme = xtermTheme;
    }
  }

  /** Get the currently focused window ID */
  get focusedId(): WindowId | null {
    return this.focusedWindowId;
  }

  /** Get all window IDs in creation order */
  get windowIds(): WindowId[] {
    return Array.from(this.windows.keys());
  }

  /** Get count of windows */
  get windowCount(): number {
    return this.windows.size;
  }

  /** Get the animation engine instance */
  get animationEngine(): AnimationEngine {
    return this.animation;
  }

  /** Get the sound engine instance */
  get soundEngine(): SoundEngine {
    return this.sound;
  }

  /** Register callback for focus changes */
  onFocusChange(cb: (id: WindowId | null) => void): void {
    this.onFocusChangeCallbacks.push(cb);
  }

  /** Set custom key event handler for all terminals (called by InputRouter) */
  setCustomKeyHandler(handler: CustomKeyHandler): void {
    this.customKeyHandler = handler;
    for (const [, termInfo] of this.terminals) {
      termInfo.terminal.attachCustomKeyEventHandler(handler);
    }
    // Also attach to Quick Terminal if it exists
    if (this.qtTerminal) {
      this.qtTerminal.terminal.attachCustomKeyEventHandler(handler);
    }
  }

  /** Get the cwd of the focused window's shell, if available */
  private async getFocusedCwd(): Promise<string | null> {
    if (!this.focusedWindowId) return null;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.sessionId === null) return null;
    try {
      const cwd = await invoke<string | null>('get_pty_cwd', {
        sessionId: win.sessionId,
      });
      return cwd;
    } catch {
      return null;
    }
  }

  /** Create a new terminal window, spawn a PTY, and add it to the layout */
  async createWindow(): Promise<WindowId> {
    // Exit maximize mode when creating a new window
    if (this.maximizedWindowId) {
      this.maximizedWindowId = null;
      this.showAllWindows();
    }

    // Inherit cwd from the focused window
    const cwd = await this.getFocusedCwd();
    const id = nextWindowId();

    // Build DOM structure — cyberpunk chrome
    const el = document.createElement('div');
    el.id = id;
    el.className = 'krypton-window';
    el.dataset.windowId = id;

    // Session counter for display
    const sessionNum = String(windowIdCounter).padStart(2, '0');

    const chrome = document.createElement('div');
    chrome.className = 'krypton-window__chrome';

    const titlebar = document.createElement('div');
    titlebar.className = 'krypton-window__titlebar';

    // Left side: status dot + session label
    const labelGroup = document.createElement('div');
    labelGroup.className = 'krypton-window__label-group';

    const statusDot = document.createElement('div');
    statusDot.className = 'krypton-window__status-dot';

    const label = document.createElement('span');
    label.className = 'krypton-window__label';
    label.textContent = `session_${sessionNum}`;

    labelGroup.appendChild(statusDot);
    labelGroup.appendChild(label);

    // Right side: PTY status (shows CWD once available)
    const ptyStatus = document.createElement('span');
    ptyStatus.className = 'krypton-window__pty-status';
    ptyStatus.textContent = 'starting...';

    titlebar.appendChild(labelGroup);
    titlebar.appendChild(ptyStatus);
    chrome.appendChild(titlebar);

    // Content area
    const content = document.createElement('div');
    content.className = 'krypton-window__content';

    const body = document.createElement('div');
    body.className = 'krypton-window__body';

    content.appendChild(body);

    // Corner accent elements
    for (const pos of ['tl', 'tr', 'bl', 'br']) {
      const corner = document.createElement('div');
      corner.className = `krypton-window__corner krypton-window__corner--${pos}`;
      el.appendChild(corner);
    }

    // Header accent bar (striped decoration below titlebar)
    const headerAccent = document.createElement('div');
    headerAccent.className = 'krypton-window__header-accent';
    chrome.appendChild(headerAccent);

    el.appendChild(chrome);
    el.appendChild(content);
    this.workspace.appendChild(el);

    // Create window record
    const win: KryptonWindow = {
      id,
      sessionId: null,
      gridSlot: { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      element: el,
      terminalContainer: body,
    };
    this.windows.set(id, win);

    // Create xterm.js terminal with config-backed settings
    const terminal = new Terminal({
      cursorBlink: this.cursorBlink,
      cursorStyle: this.cursorStyle,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      lineHeight: this.lineHeight,
      scrollback: this.scrollbackLines,
      allowTransparency: true,
      theme: this.terminalTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(body);

    // Note: WebGL addon is NOT loaded because it does not support
    // transparent backgrounds. The default canvas renderer is used
    // instead, which respects allowTransparency + rgba backgrounds.

    // Attach custom key handler so InputRouter can intercept keys
    if (this.customKeyHandler) {
      terminal.attachCustomKeyEventHandler(this.customKeyHandler);
    }

    this.terminals.set(id, { terminal, fitAddon });

    // Focus the new window BEFORE relayout so that Focus layout
    // places it on the left (main) column immediately.
    this.focusWindowQuiet(id);

    // Snapshot existing window positions, relayout, then animate the transition
    const snapshots = this.snapshotBounds();
    this.relayout();
    await this.nextFrame();
    this.fitAll();

    // Animate: morph existing windows + entrance effect on new window
    this.animation.entrance(el);
    this.animateRelayout(snapshots.filter((s) => s.id !== id));

    // Sound: window create
    this.sound.play('window.create');

    // Listen for shell title changes (OSC 0/2 sequences).
    // Most shells set this to "command" or "user@host:cwd".
    terminal.onTitleChange((title: string) => {
      if (title) {
        label.textContent = title;
      }
    });

    // Spawn PTY
    try {
      const sessionId = await invoke<number>('spawn_pty', {
        cols: terminal.cols,
        rows: terminal.rows,
        cwd,
      });
      win.sessionId = sessionId;
      label.textContent = `session_${String(sessionId).padStart(2, '0')}`;
      ptyStatus.textContent = 'pty // active';

      // Fetch initial CWD and update the status area
      this.updateWindowCwd(win.sessionId, ptyStatus);
    } catch (e) {
      console.error(`Failed to spawn PTY for window ${id}:`, e);
      terminal.write('\r\n\x1b[31mFailed to spawn shell.\x1b[0m\r\n');
      ptyStatus.textContent = 'pty // failed';
    }

    // Wire input: xterm -> PTY
    terminal.onData((data: string) => {
      if (win.sessionId !== null) {
        const encoder = new TextEncoder();
        invoke('write_to_pty', {
          sessionId: win.sessionId,
          data: Array.from(encoder.encode(data)),
        }).catch((e) => console.error('Write to PTY failed:', e));
      }
      // Keypress sound: press on input, release after short delay
      this.sound.playKeypress('press');
      setTimeout(() => this.sound.playKeypress('release'), 30 + Math.random() * 40);
    });

    // Click to focus
    el.addEventListener('mousedown', () => {
      this.focusWindow(id);
    });

    return id;
  }

  /** Close a window and destroy its PTY */
  async closeWindow(id: WindowId): Promise<void> {
    const win = this.windows.get(id);
    if (!win) return;

    // Exit maximize mode if the maximized window is being closed
    if (this.maximizedWindowId === id) {
      this.maximizedWindowId = null;
      this.showAllWindows();
    }

    const termInfo = this.terminals.get(id);
    if (termInfo) {
      termInfo.terminal.dispose();
      this.terminals.delete(id);
    }

    // Sound: window close
    this.sound.play('window.close');

    // Play exit animation, then remove from DOM
    await this.animation.exit(win.element);
    win.element.remove();

    // Snapshot remaining windows before relayout
    this.windows.delete(id);
    const snapshots = this.snapshotBounds();

    if (this.focusedWindowId === id) {
      const remaining = this.windowIds;
      if (remaining.length > 0) {
        this.focusWindow(remaining[remaining.length - 1]);
      } else {
        this.focusedWindowId = null;
        this.notifyFocusChange();
        // Last window closed — quit the app
        getCurrentWindow().close();
        return;
      }
    }

    this.relayout();
    await this.nextFrame();
    this.fitAll();
    this.animateRelayout(snapshots);
  }

  /**
   * Set focus state (CSS class, terminal focus, callbacks) without triggering
   * a relayout. Used internally when a relayout will follow immediately after.
   */
  private focusWindowQuiet(id: WindowId): void {
    if (!this.windows.has(id)) return;

    if (this.focusedWindowId) {
      const prev = this.windows.get(this.focusedWindowId);
      if (prev) {
        prev.element.classList.remove('krypton-window--focused');
      }
    }

    this.focusedWindowId = id;
    const win = this.windows.get(id);
    if (win) {
      win.element.classList.add('krypton-window--focused');
    }

    const termInfo = this.terminals.get(id);
    if (termInfo) {
      termInfo.terminal.focus();
    }

    this.notifyFocusChange();
  }

  /** Focus a window by ID */
  focusWindow(id: WindowId): void {
    if (!this.windows.has(id)) return;
    const previousId = this.focusedWindowId;

    if (previousId !== id) {
      this.sound.play('window.focus');
    }

    this.focusWindowQuiet(id);

    // In Focus layout, the focused window is always the left (main) panel.
    // Relayout so the newly focused window swaps to the left and the
    // previously focused window moves into the right stack.
    if (this.layoutMode === LayoutMode.Focus && previousId !== id && this.windows.size > 1) {
      const snapshots = this.snapshotBounds();
      this.relayout();
      this.fitAll();
      this.animateRelayout(snapshots);
    }
  }

  /** Focus window by direction relative to current focused window */
  focusDirection(direction: 'left' | 'down' | 'up' | 'right'): void {
    if (!this.focusedWindowId || this.windows.size <= 1) return;
    const bestId = this.findWindowInDirection(this.focusedWindowId, direction);
    if (bestId) {
      this.focusWindow(bestId);
    }
  }

  /** Focus window by index (1-based) */
  focusByIndex(index: number): void {
    const ids = this.windowIds;
    if (index >= 1 && index <= ids.length) {
      this.focusWindow(ids[index - 1]);
    }
  }

  /**
   * Swap the focused window with the nearest window in the given direction.
   * The two windows exchange their positions in the layout. Focus stays on
   * the originally focused window (now at the target's old position).
   */
  swapInDirection(direction: 'left' | 'down' | 'up' | 'right'): void {
    if (!this.focusedWindowId) return;
    const current = this.windows.get(this.focusedWindowId);
    if (!current) return;
    if (this.windows.size <= 1) return;

    // Find nearest window in the given direction (same algorithm as focusDirection)
    const targetId = this.findWindowInDirection(this.focusedWindowId, direction);
    if (!targetId) return;

    // Snapshot before swap for animation
    const snapshots = this.snapshotBounds();

    // Swap positions in the Map by rebuilding insertion order.
    // This swaps where each window appears in creation-order iteration,
    // which determines their layout slot assignment.
    const entries = Array.from(this.windows.entries());
    const idxA = entries.findIndex(([id]) => id === this.focusedWindowId);
    const idxB = entries.findIndex(([id]) => id === targetId);

    // Swap the entries
    const tmp = entries[idxA];
    entries[idxA] = entries[idxB];
    entries[idxB] = tmp;

    // Rebuild the map in the new order
    this.windows = new Map(entries);

    // Relayout and animate
    this.relayout();
    this.fitAll();
    this.animateRelayout(snapshots);
  }

  /**
   * Find the nearest window in a direction from a given source window.
   * Returns the window ID or null if none found.
   */
  private findWindowInDirection(sourceId: WindowId, direction: 'left' | 'down' | 'up' | 'right'): WindowId | null {
    const source = this.windows.get(sourceId);
    if (!source) return null;

    const ids = this.windowIds;
    let bestId: WindowId | null = null;
    let bestDist = Infinity;
    const curCx = source.bounds.x + source.bounds.width / 2;
    const curCy = source.bounds.y + source.bounds.height / 2;

    for (const [id, win] of this.windows) {
      if (id === sourceId) continue;
      const cx = win.bounds.x + win.bounds.width / 2;
      const cy = win.bounds.y + win.bounds.height / 2;

      let matches = false;
      let dist = 0;

      switch (direction) {
        case 'left':
          matches = cx < curCx;
          dist = (curCx - cx) + Math.abs(curCy - cy) * 0.5;
          break;
        case 'right':
          matches = cx > curCx;
          dist = (cx - curCx) + Math.abs(curCy - cy) * 0.5;
          break;
        case 'up':
          matches = cy < curCy;
          dist = (curCy - cy) + Math.abs(curCx - cx) * 0.5;
          break;
        case 'down':
          matches = cy > curCy;
          dist = (cy - curCy) + Math.abs(curCx - cx) * 0.5;
          break;
      }

      if (matches && dist < bestDist) {
        bestDist = dist;
        bestId = id;
      }
    }

    // Wrap around if nothing found in that direction
    if (!bestId) {
      const currentIdx = ids.indexOf(sourceId);
      switch (direction) {
        case 'right':
        case 'down':
          bestId = ids[(currentIdx + 1) % ids.length];
          break;
        case 'left':
        case 'up':
          bestId = ids[(currentIdx - 1 + ids.length) % ids.length];
          break;
      }
    }

    return bestId;
  }

  /**
   * Cycle focus through windows. direction: 1 = next, -1 = previous.
   *
   * In Focus layout, cycling follows the visual stack order:
   *   index 0 = left (main) column, 1..N = top-to-bottom in the right stack.
   * Pressing "next" (Cmd+Shift+.) goes: left -> top of right stack -> downward -> wrap to left.
   * Pressing "prev" (Cmd+Shift+,) goes the opposite direction.
   *
   * In Grid layout, cycling follows creation order.
   */
  focusCycle(direction: 1 | -1): void {
    if (this.windows.size <= 1) return;

    if (this.layoutMode === LayoutMode.Focus && this.focusVisualOrder.length > 1) {
      // Use the visual order captured during the last relayout.
      const order = this.focusVisualOrder;
      const currentIdx = this.focusedWindowId ? order.indexOf(this.focusedWindowId) : 0;
      const nextIdx = (currentIdx + direction + order.length) % order.length;
      this.focusWindow(order[nextIdx]);
    } else {
      // Grid layout: cycle by creation order.
      const ids = this.windowIds;
      const currentIdx = this.focusedWindowId ? ids.indexOf(this.focusedWindowId) : 0;
      const nextIdx = (currentIdx + direction + ids.length) % ids.length;
      this.focusWindow(ids[nextIdx]);
    }
  }

  /**
   * Get the active (focused) terminal's xterm.js Terminal instance.
   * Returns the Quick Terminal's instance if it's focused, otherwise
   * the focused workspace window's terminal. Used by SelectionController.
   */
  getActiveTerminal(): Terminal | null {
    if (this.qtVisible && this.qtTerminal) {
      return this.qtTerminal.terminal;
    }
    if (this.focusedWindowId) {
      const termInfo = this.terminals.get(this.focusedWindowId);
      if (termInfo) return termInfo.terminal;
    }
    return null;
  }

  /** Refocus the terminal of the currently focused window */
  refocusTerminal(): void {
    if (this.focusedWindowId) {
      const termInfo = this.terminals.get(this.focusedWindowId);
      if (termInfo) {
        termInfo.terminal.focus();
      }
    }
  }

  /** Scroll the focused terminal by the given number of pages (negative = up) */
  scrollPages(pages: number): void {
    // If Quick Terminal is visible, scroll it instead
    if (this.qtVisible && this.qtTerminal) {
      this.qtTerminal.terminal.scrollPages(pages);
      return;
    }
    if (this.focusedWindowId) {
      const termInfo = this.terminals.get(this.focusedWindowId);
      if (termInfo) {
        termInfo.terminal.scrollPages(pages);
      }
    }
  }

  /** Get the current layout mode */
  get currentLayoutMode(): LayoutMode {
    return this.layoutMode;
  }

  /** Toggle between Grid and Focus layout modes, then relayout */
  async toggleFocusLayout(): Promise<void> {
    this.sound.play('layout.toggle');
    const snapshots = this.snapshotBounds();
    this.layoutMode =
      this.layoutMode === LayoutMode.Grid ? LayoutMode.Focus : LayoutMode.Grid;
    // Exit maximize when switching layout
    this.maximizedWindowId = null;
    this.showAllWindows();
    this.relayout();
    await this.nextFrame();
    this.fitAll();
    this.animateRelayout(snapshots);
  }

  /** Whether a window is currently maximized */
  get isMaximized(): boolean {
    return this.maximizedWindowId !== null;
  }

  /**
   * Toggle maximize on the focused window.
   * When maximized, the window fills the workspace area and all other windows are hidden.
   * Pressing again restores the normal layout.
   */
  async toggleMaximize(): Promise<void> {
    if (!this.focusedWindowId) return;

    const snapshots = this.snapshotBounds();

    if (this.maximizedWindowId === this.focusedWindowId) {
      // Sound: window restore
      this.sound.play('window.restore');
      // Restore: un-maximize, show all windows, relayout
      this.maximizedWindowId = null;
      this.showAllWindows();
      this.relayout();
      await this.nextFrame();
      this.fitAll();
      this.animateRelayout(snapshots);
    } else {
      // Sound: window maximize
      this.sound.play('window.maximize');
      // Maximize: hide other windows, expand focused to fill workspace area
      this.maximizedWindowId = this.focusedWindowId;
      const win = this.windows.get(this.focusedWindowId);
      if (!win) return;

      // Hide all other windows
      for (const [id, w] of this.windows) {
        if (id !== this.focusedWindowId) {
          w.element.style.display = 'none';
        }
      }

      // Expand to full viewport
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      win.bounds = { x: 0, y: 0, width: vw, height: vh };
      this.applyBounds(win);
      await this.nextFrame();
      this.fitWindow(this.focusedWindowId);

      // Animate the focused window morphing to full size
      const focusSnap = snapshots.find((s) => s.id === this.focusedWindowId);
      if (focusSnap) {
        this.animateRelayout([focusSnap]);
      }
    }
  }

  /** Show all windows (restore display after maximize) */
  private showAllWindows(): void {
    for (const [, win] of this.windows) {
      win.element.style.display = '';
    }
  }

  // ─── Quick Terminal ───────────────────────────────────────────────

  /** Whether the Quick Terminal is currently visible */
  get isQuickTerminalVisible(): boolean {
    return this.qtVisible;
  }

  /** Whether the Quick Terminal is currently focused */
  get isQuickTerminalFocused(): boolean {
    return this.qtVisible;
  }

  /** Toggle the Quick Terminal overlay */
  async toggleQuickTerminal(): Promise<void> {
    if (this.qtVisible) {
      await this.hideQuickTerminal();
    } else {
      await this.showQuickTerminal();
    }
  }

  /** Show the Quick Terminal (lazy-creates PTY on first call) */
  private async showQuickTerminal(): Promise<void> {
    if (this.qtVisible) return;
    this.sound.play('quick_terminal.show');

    // Save currently focused workspace window for restoration
    this.qtSavedFocusId = this.focusedWindowId;

    // Lazy-initialize the Quick Terminal on first show
    if (!this.qtInitialized) {
      await this.initQuickTerminal();
    }

    if (!this.qtElement || !this.qtTerminal) return;

    // Position centered on screen
    this.positionQuickTerminal();

    // Show the element
    this.qtElement.classList.add('krypton-quick-terminal--visible');
    this.qtVisible = true;

    // Unfocus workspace window visually
    if (this.focusedWindowId) {
      const prev = this.windows.get(this.focusedWindowId);
      if (prev) {
        prev.element.classList.remove('krypton-window--focused');
      }
    }

    // Focus the Quick Terminal (add focused styling)
    this.qtElement.classList.add('krypton-window--focused');

    // Animate slide-down + fade-in
    const duration = this.qtConfig.animationDuration;
    const anim = this.qtElement.animate(
      [
        { transform: 'translateY(-30px)', opacity: '0' },
        { transform: 'translateY(0)', opacity: '1' },
      ],
      { duration, easing: 'cubic-bezier(0, 0, 0.2, 1)', fill: 'none' },
    );

    // Fit terminal after visible
    await this.nextFrame();
    this.qtTerminal.fitAddon.fit();
    if (this.qtSessionId !== null) {
      invoke('resize_pty', {
        sessionId: this.qtSessionId,
        cols: this.qtTerminal.terminal.cols,
        rows: this.qtTerminal.terminal.rows,
      }).catch((e) => console.error('QT resize PTY failed:', e));
    }

    // Focus xterm.js
    this.qtTerminal.terminal.focus();

    try {
      await anim.finished;
    } catch {
      // Animation cancelled
    }
  }

  /** Hide the Quick Terminal and restore previous focus */
  private async hideQuickTerminal(): Promise<void> {
    if (!this.qtVisible || !this.qtElement) return;
    this.sound.play('quick_terminal.hide');

    // Animate slide-up + fade-out
    const duration = this.qtConfig.animationDuration;
    const anim = this.qtElement.animate(
      [
        { transform: 'translateY(0)', opacity: '1' },
        { transform: 'translateY(-30px)', opacity: '0' },
      ],
      { duration, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );

    try {
      await anim.finished;
    } catch {
      // Animation cancelled
    }

    // Hide element
    this.qtElement.classList.remove('krypton-quick-terminal--visible');
    this.qtElement.classList.remove('krypton-window--focused');
    // Cancel fill-forwards so next show starts clean
    anim.cancel();
    this.qtVisible = false;

    // Blur the Quick Terminal's xterm.js so browser focus is released
    if (this.qtTerminal) {
      this.qtTerminal.terminal.blur();
    }

    // Restore focus to the previously focused workspace window.
    // We need to re-add the focused CSS class (removed during show)
    // and re-focus the xterm.js terminal so it receives keyboard input.
    const restoreId = this.qtSavedFocusId ?? (this.windows.size > 0 ? this.windowIds[this.windowIds.length - 1] : null);
    if (restoreId && this.windows.has(restoreId)) {
      const win = this.windows.get(restoreId)!;
      win.element.classList.add('krypton-window--focused');
      this.focusedWindowId = restoreId;

      const termInfo = this.terminals.get(restoreId);
      if (termInfo) {
        termInfo.terminal.focus();
      }
      this.notifyFocusChange();
    }
    this.qtSavedFocusId = null;
  }

  /**
   * Fully destroy the Quick Terminal (DOM + terminal + state).
   * Called when the QT shell exits (Ctrl+D). Hides first if visible,
   * then tears down everything so the next toggle recreates from scratch.
   */
  private async destroyQuickTerminal(): Promise<void> {
    // Hide with animation + restore workspace focus if currently visible
    if (this.qtVisible) {
      await this.hideQuickTerminal();
    }

    // Dispose xterm.js terminal
    if (this.qtTerminal) {
      this.qtTerminal.terminal.dispose();
      this.qtTerminal = null;
    }

    // Remove DOM element
    if (this.qtElement) {
      this.qtElement.remove();
      this.qtElement = null;
    }

    // Reset state so next toggle lazy-creates everything fresh
    this.qtSessionId = null;
    this.qtInitialized = false;
  }

  /** Lazily initialize the Quick Terminal DOM + PTY */
  private async initQuickTerminal(): Promise<void> {
    // Build DOM — same cyberpunk chrome as regular windows
    const el = document.createElement('div');
    el.id = 'quick-terminal';
    el.className = 'krypton-window krypton-quick-terminal';

    const chrome = document.createElement('div');
    chrome.className = 'krypton-window__chrome';

    const titlebar = document.createElement('div');
    titlebar.className = 'krypton-window__titlebar';

    const labelGroup = document.createElement('div');
    labelGroup.className = 'krypton-window__label-group';

    const statusDot = document.createElement('div');
    statusDot.className = 'krypton-window__status-dot';

    const label = document.createElement('span');
    label.className = 'krypton-window__label';
    label.textContent = 'QUICK_TERMINAL';

    labelGroup.appendChild(statusDot);
    labelGroup.appendChild(label);

    const qtPtyStatus = document.createElement('span');
    qtPtyStatus.className = 'krypton-window__pty-status';
    qtPtyStatus.textContent = 'starting...';

    titlebar.appendChild(labelGroup);
    titlebar.appendChild(qtPtyStatus);
    chrome.appendChild(titlebar);

    const headerAccent = document.createElement('div');
    headerAccent.className = 'krypton-window__header-accent';
    chrome.appendChild(headerAccent);

    const content = document.createElement('div');
    content.className = 'krypton-window__content';

    const body = document.createElement('div');
    body.className = 'krypton-window__body';
    content.appendChild(body);

    // Corner accents
    for (const pos of ['tl', 'tr', 'bl', 'br']) {
      const corner = document.createElement('div');
      corner.className = `krypton-window__corner krypton-window__corner--${pos}`;
      el.appendChild(corner);
    }

    el.appendChild(chrome);
    el.appendChild(content);
    this.workspace.appendChild(el);
    this.qtElement = el;

    // Create xterm.js terminal with config-backed settings
    const terminal = new Terminal({
      cursorBlink: this.cursorBlink,
      cursorStyle: this.cursorStyle,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      lineHeight: this.lineHeight,
      scrollback: this.scrollbackLines,
      allowTransparency: true,
      theme: this.terminalTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(body);

    // Attach custom key handler
    if (this.customKeyHandler) {
      terminal.attachCustomKeyEventHandler(this.customKeyHandler);
    }

    // Listen for shell title changes (OSC 0/2 sequences)
    terminal.onTitleChange((title: string) => {
      if (title) {
        label.textContent = title;
      }
    });

    this.qtTerminal = { terminal, fitAddon };

    // Spawn PTY for Quick Terminal — inherit CWD from focused window
    const inheritedCwd = await this.getFocusedCwd();
    try {
      const sessionId = await invoke<number>('spawn_pty', {
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: inheritedCwd,
      });
      this.qtSessionId = sessionId;
      qtPtyStatus.textContent = 'pty // active';

      // Fetch initial CWD for Quick Terminal
      this.updateWindowCwd(sessionId, qtPtyStatus);
    } catch (e) {
      console.error('Failed to spawn Quick Terminal PTY:', e);
      terminal.write('\r\n\x1b[31mFailed to spawn shell.\x1b[0m\r\n');
      qtPtyStatus.textContent = 'pty // failed';
    }

    // Wire input: xterm -> PTY
    terminal.onData((data: string) => {
      if (this.qtSessionId !== null) {
        const encoder = new TextEncoder();
        invoke('write_to_pty', {
          sessionId: this.qtSessionId,
          data: Array.from(encoder.encode(data)),
        }).catch((e) => console.error('QT write to PTY failed:', e));
      }
      // Keypress sound: press on input, release after short delay
      this.sound.playKeypress('press');
      setTimeout(() => this.sound.playKeypress('release'), 30 + Math.random() * 40);
    });

    this.qtInitialized = true;
  }

  /** Position the Quick Terminal centered on the viewport */
  private positionQuickTerminal(): void {
    if (!this.qtElement) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.round(vw * this.qtConfig.widthRatio);
    const h = Math.round(vh * this.qtConfig.heightRatio);
    const x = Math.round((vw - w) / 2);
    const y = Math.round((vh - h) / 2);

    this.qtElement.style.left = `${x}px`;
    this.qtElement.style.top = `${y}px`;
    this.qtElement.style.width = `${w}px`;
    this.qtElement.style.height = `${h}px`;
  }

  // ─── Resize & Move ───────────────────────────────────────────────

  /** Resize the focused window by a directional step */
  resizeFocused(direction: 'left' | 'down' | 'up' | 'right'): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win) return;

    const b = win.bounds;

    switch (direction) {
      case 'right':
        b.width = Math.max(MIN_WIDTH, b.width + this.stepSize);
        break;
      case 'left':
        b.width = Math.max(MIN_WIDTH, b.width - this.stepSize);
        break;
      case 'down':
        b.height = Math.max(MIN_HEIGHT, b.height + this.stepSize);
        break;
      case 'up':
        b.height = Math.max(MIN_HEIGHT, b.height - this.stepSize);
        break;
    }

    this.applyBounds(win);
    this.fitWindow(this.focusedWindowId);
  }

  /** Move the focused window by a directional step */
  moveFocused(direction: 'left' | 'down' | 'up' | 'right'): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win) return;

    const b = win.bounds;

    switch (direction) {
      case 'left':
        b.x = Math.max(0, b.x - this.stepSize);
        break;
      case 'right':
        b.x = Math.min(window.innerWidth - MIN_WIDTH, b.x + this.stepSize);
        break;
      case 'up':
        b.y = Math.max(0, b.y - this.stepSize);
        break;
      case 'down':
        b.y = Math.min(window.innerHeight - MIN_HEIGHT, b.y + this.stepSize);
        break;
    }

    this.applyBounds(win);
  }

  // ─── Layout ──────────────────────────────────────────────────────

  /** Capture a snapshot of all windows' current bounds (for animation) */
  private snapshotBounds(): BoundsSnapshot[] {
    const snapshots: BoundsSnapshot[] = [];
    for (const [id, win] of this.windows) {
      snapshots.push({
        id,
        bounds: { ...win.bounds },
      });
    }
    return snapshots;
  }

  /** Animate layout transition from snapshots to current bounds */
  private async animateRelayout(snapshots: BoundsSnapshot[]): Promise<void> {
    await this.animation.animateLayoutTransition(
      snapshots,
      (id) => this.windows.get(id)?.bounds ?? null,
      (id) => this.windows.get(id)?.element ?? null,
      this.workspace,
    );
    this.replayBufferedInput();
  }

  /**
   * Replay any keyboard events that were buffered during animation.
   * The events are dispatched to the focused terminal's xterm.js instance.
   */
  private replayBufferedInput(): void {
    const events = this.animation.flushInputBuffer();
    if (events.length === 0) return;

    const termInfo = this.focusedWindowId
      ? this.terminals.get(this.focusedWindowId)
      : null;

    if (termInfo) {
      // Replay each buffered keydown by re-dispatching to the terminal's textarea
      const textarea = termInfo.terminal.textarea;
      if (textarea) {
        for (const event of events) {
          textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: event.key,
            code: event.code,
            keyCode: event.keyCode,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
          }));
        }
      }
    }
  }

  /** Default window size as fraction of viewport */
  private static readonly DEFAULT_WIDTH_RATIO = 0.5;
  private static readonly DEFAULT_HEIGHT_RATIO = 0.6;
  /** Multi-window: total area used as fraction of viewport */
  private static readonly MULTI_WIDTH_RATIO = 0.85;
  private static readonly MULTI_HEIGHT_RATIO = 0.75;
  private static readonly WINDOW_GAP = 6;

  /** Recalculate grid layout and apply positions to all windows */
  relayout(): void {
    const count = this.windows.size;
    if (count === 0) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Single window
    if (count === 1) {
      const win = this.windows.values().next().value;
      if (!win) return;

      if (this.layoutMode === LayoutMode.Focus) {
        // Focus mode: full height, 65% width, left-aligned
        const w = Math.round(vw * Compositor.FOCUS_MAIN_RATIO);
        win.gridSlot = { col: 0, row: 0, colSpan: 1, rowSpan: 1 };
        win.bounds = { x: 0, y: 0, width: w, height: vh };
      } else {
        // Grid mode: centered at a comfortable default size
        const w = Math.round(vw * Compositor.DEFAULT_WIDTH_RATIO);
        const h = Math.round(vh * Compositor.DEFAULT_HEIGHT_RATIO);
        win.gridSlot = { col: 0, row: 0, colSpan: 1, rowSpan: 1 };
        win.bounds = {
          x: Math.round((vw - w) / 2),
          y: Math.round((vh - h) / 2),
          width: w,
          height: h,
        };
      }

      this.applyBounds(win);
      return;
    }

    if (this.layoutMode === LayoutMode.Focus) {
      this.relayoutFocus(vw, vh, count);
    } else {
      this.relayoutGrid(vw, vh, count);
    }
  }

  /** Grid layout: tile windows in a balanced grid within a centered region */
  private relayoutGrid(vw: number, vh: number, count: number): void {
    const { slots, gridCols, gridRows } = autoTile(count);

    const totalW = Math.round(vw * Compositor.MULTI_WIDTH_RATIO);
    const totalH = Math.round(vh * Compositor.MULTI_HEIGHT_RATIO);
    const offsetX = Math.round((vw - totalW) / 2);
    const offsetY = Math.round((vh - totalH) / 2);
    const gap = this.windowGap;

    const cellW = (totalW - gap * (gridCols - 1)) / gridCols;
    const cellH = (totalH - gap * (gridRows - 1)) / gridRows;

    let i = 0;
    for (const [, win] of this.windows) {
      if (i >= slots.length) break;
      const slot = slots[i];
      win.gridSlot = slot;

      win.bounds = {
        x: Math.round(offsetX + slot.col * (cellW + gap)),
        y: Math.round(offsetY + slot.row * (cellH + gap)),
        width: Math.round(cellW * slot.colSpan + gap * (slot.colSpan - 1)),
        height: Math.round(cellH * slot.rowSpan + gap * (slot.rowSpan - 1)),
      };
      this.applyBounds(win);

      i++;
    }
  }

  /** Ratio of screen width the focused window occupies in Focus layout */
  private static readonly FOCUS_MAIN_RATIO = 0.65;

  /** Focus layout: focused window on left (full height, 65% width), rest fill remaining area */
  private relayoutFocus(vw: number, vh: number, count: number): void {
    const ids = this.windowIds;
    const focusIndex = this.focusedWindowId
      ? ids.indexOf(this.focusedWindowId)
      : 0;

    const { order } = focusTile(count, Math.max(0, focusIndex));

    const gap = this.windowGap;
    const mainW = Math.round(vw * Compositor.FOCUS_MAIN_RATIO);
    const stackW = vw - mainW - gap;
    const stackCount = count - 1;
    const stackCellH = (vh - gap * (stackCount - 1)) / stackCount;

    // Build the visual order (window IDs in layout position order)
    // and apply bounds for each window.
    this.focusVisualOrder = [];
    for (let i = 0; i < order.length; i++) {
      const winId = ids[order[i]];
      const win = this.windows.get(winId);
      if (!win) continue;

      this.focusVisualOrder.push(winId);

      if (i === 0) {
        // Focused window: left side, full height, 65% width
        win.gridSlot = { col: 0, row: 0, colSpan: 1, rowSpan: stackCount };
        win.bounds = { x: 0, y: 0, width: mainW, height: vh };
      } else {
        // Stack windows: right side, fill remaining width, split height evenly
        const stackIdx = i - 1;
        win.gridSlot = { col: 1, row: stackIdx, colSpan: 1, rowSpan: 1 };
        win.bounds = {
          x: mainW + gap,
          y: Math.round(stackIdx * (stackCellH + gap)),
          width: stackW,
          height: Math.round(stackCellH),
        };
      }

      this.applyBounds(win);
    }
  }

  /** Fit all terminals to their containers and resize PTYs */
  fitAll(): void {
    for (const [id] of this.terminals) {
      this.fitWindow(id);
    }
  }

  /** Fit a single terminal to its container and resize its PTY */
  private fitWindow(id: WindowId): void {
    const termInfo = this.terminals.get(id);
    const win = this.windows.get(id);
    if (!termInfo || !win) return;

    termInfo.fitAddon.fit();

    if (win.sessionId !== null) {
      invoke('resize_pty', {
        sessionId: win.sessionId,
        cols: termInfo.terminal.cols,
        rows: termInfo.terminal.rows,
      }).catch((e) => console.error('Resize PTY failed:', e));
    }
  }

  /** Apply a window's bounds to its DOM element */
  private applyBounds(win: KryptonWindow): void {
    const b = win.bounds;
    const el = win.element;
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.width}px`;
    el.style.height = `${b.height}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  // ─── PTY Events ──────────────────────────────────────────────────

  private setupPtyListeners(): void {
    listen<[number, number[]]>('pty-output', (event) => {
      const [sid, data] = event.payload;

      // Detect standalone BEL character (\x07) for terminal bell sound.
      // Skip BEL when it appears as an OSC sequence terminator (e.g. \x1b]0;title\x07)
      // by checking that \x07 is not preceded by an active OSC/escape context.
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 7) {
          // Look backwards for an ESC ] (OSC start) without a closing ST (\x1b\\)
          let inOsc = false;
          for (let j = i - 1; j >= 0; j--) {
            // Found ESC (0x1b) followed by ] (0x5d) = OSC start
            if (data[j] === 0x5d && j > 0 && data[j - 1] === 0x1b) {
              inOsc = true;
              break;
            }
            // Found another ESC or standalone BEL before finding OSC — stop looking
            if (data[j] === 0x1b || data[j] === 7) break;
          }
          if (!inOsc) {
            this.sound.play('terminal.bell');
            break; // One bell per output chunk is enough
          }
        }
      }

      // Check Quick Terminal first
      if (this.qtSessionId === sid && this.qtTerminal) {
        this.qtTerminal.terminal.write(new Uint8Array(data));
        return;
      }

      for (const [wid, win] of this.windows) {
        if (win.sessionId === sid) {
          const termInfo = this.terminals.get(wid);
          if (termInfo) {
            termInfo.terminal.write(new Uint8Array(data));
          }
          break;
        }
      }
    });

    listen<number>('pty-exit', (event) => {
      const sid = event.payload;

      // Quick Terminal PTY exited — hide, clean up, recreate on next toggle
      if (this.qtSessionId === sid) {
        this.qtSessionId = null;
        this.sound.play('terminal.exit');
        this.destroyQuickTerminal();
        return;
      }

      for (const [wid, win] of this.windows) {
        if (win.sessionId === sid) {
          win.sessionId = null;
          // Update status to reflect exit before closing
          const statusEl = this.findPtyStatus(win.element);
          if (statusEl) statusEl.textContent = 'pty // exited';
          this.sound.play('terminal.exit');
          this.closeWindow(wid);
          break;
        }
      }
    });
  }

  // ─── Window Title Helpers ─────────────────────────────────────────

  /**
   * Fetch the CWD for a PTY session and update the status element.
   * Called once after spawn and could be called periodically.
   */
  private async updateWindowCwd(
    sessionId: number,
    statusEl: HTMLElement,
  ): Promise<void> {
    try {
      const cwd = await invoke<string | null>('get_pty_cwd', { sessionId });
      if (cwd) {
        statusEl.textContent = abbreviatePath(cwd);
      }
    } catch {
      // Session may have exited — ignore
    }
  }

  /**
   * Find the pty-status element within a window's DOM.
   */
  private findPtyStatus(windowEl: HTMLElement): HTMLElement | null {
    return windowEl.querySelector('.krypton-window__pty-status');
  }

  /**
   * Find the label element within a window's DOM.
   */
  private findLabel(windowEl: HTMLElement): HTMLElement | null {
    return windowEl.querySelector('.krypton-window__label');
  }

  // ─── Window Resize Handler ───────────────────────────────────────

  private setupResizeHandler(): void {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.relayout();
        this.fitAll();
        // Reposition Quick Terminal if visible
        if (this.qtVisible) {
          this.positionQuickTerminal();
          if (this.qtTerminal && this.qtSessionId !== null) {
            this.qtTerminal.fitAddon.fit();
            invoke('resize_pty', {
              sessionId: this.qtSessionId,
              cols: this.qtTerminal.terminal.cols,
              rows: this.qtTerminal.terminal.rows,
            }).catch((e) => console.error('QT resize PTY failed:', e));
          }
        }
      }, 50);
    });
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  private notifyFocusChange(): void {
    for (const cb of this.onFocusChangeCallbacks) {
      cb(this.focusedWindowId);
    }
  }
}
