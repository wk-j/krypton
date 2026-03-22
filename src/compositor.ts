// Krypton — Compositor
// Manages terminal windows: creation, destruction, layout, focus, resize, move.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import {
  WindowId,
  SessionId,
  TabId,
  PaneId,
  WindowBounds,
  KryptonWindow,
  LayoutMode,
  QuickTerminalConfig,
  DEFAULT_QUICK_TERMINAL_CONFIG,
  Tab,
  Pane,
  PaneNode,
  SplitDirection,
  ProgressState,
  type ProgressEvent,
  type PaneProgress,
} from './types';
import { autoTile, focusTile, resolveGridSlot } from './layout';
import { AnimationEngine, BoundsSnapshot } from './animation';
import { SoundEngine } from './sound';
import { ShaderEngine } from './shaders';
import type { ShaderPreset } from './shaders';
import type { KryptonConfig, TabsConfig, ShaderConfig } from './config';
import { DEFAULT_SHADER_CONFIG } from './config';
import type { FrontendThemeEngine } from './theme';
import { ExtensionManager } from './extensions';
import type { ExtensionHost } from './extensions';
import { DashboardManager } from './dashboard';
import type { ClaudeHookManager } from './claude-hooks';

/** Replace the alpha channel of an rgba() color string.
 *  e.g. replaceAlpha('rgba(6, 10, 18, 0.5)', 0.8) → 'rgba(6, 10, 18, 0.8)' */
function replaceAlpha(rgba: string, alpha: number): string {
  const m = rgba.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  }
  return rgba;
}

/** Custom key event handler for xterm.js — set by InputRouter */
type CustomKeyHandler = (e: KeyboardEvent) => boolean;

/** Terminal + addons for Quick Terminal (which has no tab/pane structure) */
interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
}

/** Reverse lookup: session ID -> where it lives */
interface SessionLocation {
  windowId: WindowId;
  tabId: TabId;
  paneId: PaneId;
}

/** SSH connection metadata returned by detect_ssh_session */
interface SshConnectionInfo {
  user: string;
  host: string;
  port: number;
  control_socket: string | null;
  extra_args: string[];
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

/** Fully transparent background for xterm.js canvas.
 *  The visual backdrop (tint + blur) is handled by the .krypton-window CSS
 *  background and backdrop-filter, which the browser composites every frame.
 *  Making the canvas background transparent ensures dynamic content behind
 *  the Tauri window (e.g. video wallpapers) is not frozen by a static
 *  canvas fill. */
const XTERM_TRANSPARENT_BG = 'rgba(0, 0, 0, 0)';

/** xterm.js built-in theme fallback (used when theme engine not yet initialized) */
const DEFAULT_TERMINAL_THEME: Record<string, string> = {
  background: XTERM_TRANSPARENT_BG,
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

/** Cyberpunk accent color palette for per-window coloring */
interface AccentColor {
  name: string;
  hex: string;
  rgb: string; // "r, g, b" for rgba() usage
}

const ACCENT_PALETTE: AccentColor[] = [
  { name: 'cyan',    hex: '#00ccff', rgb: '0, 204, 255' },
  { name: 'magenta', hex: '#c77dff', rgb: '199, 125, 255' },
  { name: 'amber',   hex: '#e8c547', rgb: '232, 197, 71' },
  { name: 'green',   hex: '#39ff7f', rgb: '57, 255, 127' },
  { name: 'violet',  hex: '#7b61ff', rgb: '123, 97, 255' },
  { name: 'orange',  hex: '#ff8c42', rgb: '255, 140, 66' },
  { name: 'pink',    hex: '#ff5c8a', rgb: '255, 92, 138' },
  { name: 'teal',    hex: '#2dd4bf', rgb: '45, 212, 191' },
  { name: 'gold',    hex: '#fbbf24', rgb: '251, 191, 36' },
  { name: 'red',     hex: '#ff3a5c', rgb: '255, 58, 92' },
];

/** Minimum window dimensions */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

/** Counters for unique IDs */
let windowIdCounter = 0;
let tabIdCounter = 0;
let paneIdCounter = 0;

function nextWindowId(): WindowId {
  return `win-${windowIdCounter++}`;
}

function nextTabId(): TabId {
  return `tab-${tabIdCounter++}`;
}

function nextPaneId(): PaneId {
  return `pane-${paneIdCounter++}`;
}

export class Compositor {
  private windows: Map<WindowId, KryptonWindow> = new Map();
  private sessionMap: Map<SessionId, SessionLocation> = new Map();
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

  // ─── Per-Window Accent Colors ──────────────────────────────────────
  /** Maps window ID to its assigned palette index */
  private windowColorIndex: Map<WindowId, number> = new Map();
  /** Set of palette indices currently in use */
  private usedColorIndices: Set<number> = new Set();

  // ─── Theme Engine ─────────────────────────────────────────────────
  /** Reference to the frontend theme engine (set via setThemeEngine) */
  private themeEngine: FrontendThemeEngine | null = null;

  // ─── Claude Hook Manager ────────────────────────────────────────
  private claudeHookManager: ClaudeHookManager | null = null;
  private hookToastsEnabled: boolean = true;

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
  /** Config-driven window backdrop opacity (overrides theme alpha) */
  private configOpacity: number | null = null;

  // ─── Tabs Config ─────────────────────────────────────────────────
  private tabsConfig: TabsConfig = {
    always_show_tabbar: false,
    default_split: 'vertical',
    close_window_on_last_tab: true,
  };

  // ─── Shader Engine ──────────────────────────────────────────────
  private shaderEngine: ShaderEngine = new ShaderEngine();
  private shaderConfig: ShaderConfig = { ...DEFAULT_SHADER_CONFIG };

  // ─── Progress Tracking (OSC 9;4) ─────────────────────────────────
  /** Per-session progress state (tracks all panes independently) */
  private sessionProgress: Map<SessionId, PaneProgress> = new Map();
  /** Quick Terminal progress state */
  private qtProgress: PaneProgress | null = null;

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

  /** Context extension manager for process-aware widgets */
  private extensions: ExtensionManager;

  /** Dashboard overlay manager */
  private dashboards: DashboardManager = new DashboardManager();

  constructor(workspace: HTMLElement) {
    this.workspace = workspace;
    this.setupResizeHandler();
    this.setupPtyListeners();

    // Initialize extension manager with host callbacks
    const host: ExtensionHost = {
      findPaneBySessionId: (sessionId) => this.findPaneBySessionId(sessionId),
      refitPane: (paneId) => this.refitPaneById(paneId),
    };
    this.extensions = new ExtensionManager(host);
    this.extensions.start();

    // Wire dashboard manager to restore terminal focus on close
    this.dashboards.onRefocus(() => this.refocusTerminal());
  }

  /** Apply loaded config to compositor settings. Call before creating windows. */
  applyConfig(config: KryptonConfig): void {
    // Font
    this.fontFamily = `'${config.font.family}', 'Fira Code', 'Cascadia Code', monospace`;
    this.fontSize = config.font.size;
    this.lineHeight = config.font.line_height;

    // Expose cell height for CSS overlays (e.g. top-line glow)
    document.documentElement.style.setProperty(
      '--krypton-terminal-cell-height',
      `${this.fontSize * this.lineHeight}px`
    );

    // Terminal
    this.scrollbackLines = config.terminal.scrollback_lines;
    this.cursorStyle = config.terminal.cursor_style;
    this.cursorBlink = config.terminal.cursor_blink;

    // Theme: if the theme engine is connected, use its xterm theme;
    // otherwise fall back to config-based color overrides.
    // The xterm canvas background is always fully transparent — the visual
    // backdrop (tint + blur) lives on .krypton-window via CSS, which the
    // browser composites every frame (required for dynamic wallpapers).
    if (this.themeEngine) {
      const xt = this.themeEngine.buildXtermTheme();
      xt.background = XTERM_TRANSPARENT_BG;
      this.terminalTheme = xt;
    } else {
      // Legacy fallback: merge config colors on top of hardcoded default
      const c = config.theme.colors;
      const theme: Record<string, string> = { ...DEFAULT_TERMINAL_THEME };
      if (c.foreground) theme.foreground = c.foreground;
      // background is always transparent — ignore config c.background for canvas
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

    // Tabs
    if (config.tabs) {
      this.tabsConfig = config.tabs;
    }

    // Shaders
    if (config.shader) {
      this.shaderConfig = config.shader;
      this.shaderEngine = new ShaderEngine({
        fps_cap: config.shader.fps_cap,
        animate: config.shader.animate,
      });
    }

    // Extensions — enable/disable context extensions
    if (config.extensions) {
      this.extensions.setEnabled(config.extensions.enabled);
    }

    // Hooks — toggle toast display and max visible toasts
    if (config.hooks) {
      this.hookToastsEnabled = config.hooks.show_toasts;
      if (this.claudeHookManager) {
        this.claudeHookManager.setToastsEnabled(this.hookToastsEnabled);
        this.claudeHookManager.setMaxToasts(config.hooks.max_toasts);
      }
    }

    // Visual — 3D perspective depth and tilt
    if (config.visual) {
      const depth = config.visual.perspective_depth;
      const tiltX = config.visual.perspective_tilt_x ?? 0;
      const tiltY = config.visual.perspective_tilt_y ?? 0;
      // Set perspective variables on both workspace (for windows) and root (for toasts).
      // Workspace uses `perspective` property (accepts 'none'), toasts use `perspective()`
      // function in transform (needs a length). Store the numeric value so both work.
      const perspProp = depth > 0 ? `${depth}px` : 'none';
      const perspFunc = depth > 0 ? `${depth}px` : '9999px';
      const tiltXVal = depth > 0 && tiltX !== 0 ? `${tiltX}deg` : '0deg';
      const tiltYVal = depth > 0 && tiltY !== 0 ? `${tiltY}deg` : '0deg';
      this.workspace.style.setProperty('--krypton-perspective', perspProp);
      this.workspace.style.setProperty('--krypton-perspective-tilt-x', tiltXVal);
      this.workspace.style.setProperty('--krypton-perspective-tilt-y', tiltYVal);
      const root = document.documentElement.style;
      root.setProperty('--krypton-perspective', perspFunc);
      root.setProperty('--krypton-perspective-tilt-x', tiltXVal);
      root.setProperty('--krypton-perspective-tilt-y', tiltYVal);

      // Transparency — window backdrop opacity from [visual] config.
      // Overrides the theme's backdrop alpha when set.
      const opacity = Math.max(0, Math.min(1, config.visual.opacity ?? 0.5));
      this.configOpacity = opacity;

      // Override the theme's backdrop color alpha with config opacity.
      // Read the current theme backdrop color and replace its alpha channel.
      const themeBackdrop = this.themeEngine?.theme?.chrome?.backdrop?.color
        ?? 'rgba(6, 10, 18, 0.5)';
      root.setProperty('--krypton-backdrop-color', replaceAlpha(themeBackdrop, opacity));

      // Also override quick terminal background alpha with config opacity.
      const themeQtBg = this.themeEngine?.theme?.ui?.quick_terminal?.background
        ?? 'rgba(6, 10, 18, 0.6)';
      root.setProperty('--krypton-qt-bg', replaceAlpha(themeQtBg, opacity));

      // Also override dashboard backdrop and panel alpha with config opacity.
      root.setProperty('--krypton-dashboard-backdrop', `rgba(0, 0, 0, ${opacity * 0.6})`);
      const themeBg = this.themeEngine?.theme?.colors?.background
        ?? 'rgba(10, 10, 15, 0.95)';
      root.setProperty('--krypton-dashboard-panel-bg', replaceAlpha(themeBg, opacity));

      // Update existing terminals so their background alpha matches
      this.updateTerminalThemes();

      // Glow intensity — controls the top-line brightness overlay
      const glow = Math.max(0, Math.min(3, config.visual.glow_intensity ?? 0.8));
      root.setProperty('--krypton-glow-intensity', String(glow));
    }
  }

  // ─── Pane Tree Helpers ──────────────────────────────────────────

  /** Create a terminal instance and return a Pane */
  private createPane(container: HTMLElement): Pane {
    const paneId = nextPaneId();
    const el = document.createElement('div');
    el.className = 'krypton-pane';
    el.dataset.paneId = paneId;
    container.appendChild(el);

    // Terminal wrapper — xterm opens into this, not the pane directly.
    // The pane is always flex column; this wrapper is the flex-growing child
    // that shrinks when extension bars are inserted as siblings.
    const terminalWrap = document.createElement('div');
    terminalWrap.className = 'krypton-pane__terminal';
    el.appendChild(terminalWrap);

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
    terminal.open(terminalWrap);

    // Edge glow overlays — sit above the xterm canvas
    const glowTop = document.createElement('div');
    glowTop.className = 'krypton-glow-overlay';
    terminalWrap.appendChild(glowTop);

    const glowBottom = document.createElement('div');
    glowBottom.className = 'krypton-glow-overlay krypton-glow-overlay--bottom';
    terminalWrap.appendChild(glowBottom);

    if (this.customKeyHandler) {
      terminal.attachCustomKeyEventHandler(this.customKeyHandler);
    }

    // Attach shader if enabled — use short delay to let WebGL addon render first frame
    let shaderInstance = null;
    if (this.shaderConfig.enabled && this.shaderConfig.preset !== 'none') {
      console.log('[krypton:shaders] Attaching shader to pane', paneId, 'preset:', this.shaderConfig.preset);
      shaderInstance = this.shaderEngine.attach(
        el,
        this.shaderConfig.preset as ShaderPreset,
        this.shaderConfig.intensity,
      );
      console.log('[krypton:shaders] attach() returned:', shaderInstance);
    } else {
      console.log('[krypton:shaders] Shader skipped — enabled:', this.shaderConfig.enabled, 'preset:', this.shaderConfig.preset);
    }

    return { id: paneId, sessionId: null, terminal, fitAddon, element: el, shaderInstance };
  }

  /** Copy-on-select: copy terminal selection to clipboard when text is selected */
  private wireCopyOnSelect(terminal: Terminal): void {
    terminal.onSelectionChange(() => {
      const text = terminal.getSelection();
      if (text) {
        navigator.clipboard.writeText(text).catch((err) => {
          console.error('Failed to copy selection to clipboard:', err);
        });
      }
    });
  }

  /** Wire a pane's terminal to a PTY session */
  private wirePaneInput(pane: Pane): void {
    pane.terminal.onData((data: string) => {
      if (pane.sessionId !== null) {
        const encoder = new TextEncoder();
        invoke('write_to_pty', {
          sessionId: pane.sessionId,
          data: Array.from(encoder.encode(data)),
        }).catch((e: unknown) => console.error('Write to PTY failed:', e));
      }
    });
    // Keypress sound on actual keyboard input only (not mouse reporting)
    pane.terminal.onKey(({ domEvent }) => {
      this.sound.playKeypress('press', domEvent.key);
      setTimeout(() => this.sound.playKeypress('release', domEvent.key), 30 + Math.random() * 40);
    });
    // Copy-on-select
    this.wireCopyOnSelect(pane.terminal);
  }

  /** Spawn a PTY for a pane and register it in the session map */
  private async spawnPaneSession(
    pane: Pane,
    windowId: WindowId,
    tabId: TabId,
    cwd: string | null,
  ): Promise<void> {
    try {
      const sessionId = await invoke<number>('spawn_pty', {
        cols: pane.terminal.cols,
        rows: pane.terminal.rows,
        cwd,
      });
      pane.sessionId = sessionId;
      this.sessionMap.set(sessionId, { windowId, tabId, paneId: pane.id });
    } catch (e) {
      console.error(`Failed to spawn PTY for pane ${pane.id}:`, e);
      pane.terminal.write('\r\n\x1b[31mFailed to spawn shell.\x1b[0m\r\n');
    }
  }

  /** Find a pane by ID within a pane tree */
  private findPaneInTree(node: PaneNode, paneId: PaneId): Pane | null {
    if (node.type === 'leaf') {
      return node.pane.id === paneId ? node.pane : null;
    }
    return this.findPaneInTree(node.first, paneId) ?? this.findPaneInTree(node.second, paneId);
  }

  /** Find a pane element + ID by session ID (used by ExtensionManager). */
  private findPaneBySessionId(sessionId: SessionId): { paneId: PaneId; element: HTMLElement } | null {
    const loc = this.sessionMap.get(sessionId);
    if (!loc) return null;

    const win = this.windows.get(loc.windowId);
    if (!win) return null;

    const tab = win.tabs.find((t) => t.id === loc.tabId);
    if (!tab) return null;

    const pane = this.findPaneInTree(tab.paneTree, loc.paneId);
    if (!pane) return null;

    return { paneId: pane.id, element: pane.element };
  }

  /** Re-fit a single pane by ID (triggers addon-fit + resize_pty). */
  private refitPaneById(paneId: PaneId): void {
    for (const win of this.windows.values()) {
      for (const tab of win.tabs) {
        const pane = this.findPaneInTree(tab.paneTree, paneId);
        if (pane) {
          pane.fitAddon.fit();
          if (pane.sessionId !== null) {
            invoke('resize_pty', {
              sessionId: pane.sessionId,
              cols: pane.terminal.cols,
              rows: pane.terminal.rows,
            }).catch((e: unknown) => console.error('Resize PTY failed:', e));
          }
          return;
        }
      }
    }
  }

  /** Get the focused pane of the focused window's active tab */
  private getFocusedPane(): Pane | null {
    if (!this.focusedWindowId) return null;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length === 0) return null;
    const tab = win.tabs[win.activeTabIndex];
    return this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
  }

  /** Get the active tab of the focused window */
  private getActiveTab(): Tab | null {
    if (!this.focusedWindowId) return null;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length === 0) return null;
    return win.tabs[win.activeTabIndex];
  }

  /** Collect all panes from a pane tree */
  private collectPanes(node: PaneNode): Pane[] {
    if (node.type === 'leaf') return [node.pane];
    return [...this.collectPanes(node.first), ...this.collectPanes(node.second)];
  }

  /** Dispose all terminals in a pane tree and remove from session map */
  private disposePaneTree(node: PaneNode): void {
    if (node.type === 'leaf') {
      // Clean up any active extensions on this pane
      this.extensions.onPaneDestroyed(node.pane.id);
      if (node.pane.shaderInstance) {
        this.shaderEngine.detach(node.pane.shaderInstance);
        node.pane.shaderInstance = null;
      }
      node.pane.terminal.dispose();
      if (node.pane.sessionId !== null) {
        this.sessionMap.delete(node.pane.sessionId);
      }
      node.pane.element.remove();
    } else {
      this.disposePaneTree(node.first);
      this.disposePaneTree(node.second);
      node.element.remove();
    }
  }

  /** Fit all visible panes in a pane tree and resize their PTYs */
  private fitPaneTree(node: PaneNode): void {
    if (node.type === 'leaf') {
      const pane = node.pane;
      pane.fitAddon.fit();
      if (pane.sessionId !== null) {
        invoke('resize_pty', {
          sessionId: pane.sessionId,
          cols: pane.terminal.cols,
          rows: pane.terminal.rows,
        }).catch((e: unknown) => console.error('Resize PTY failed:', e));
      }
    } else {
      this.fitPaneTree(node.first);
      this.fitPaneTree(node.second);
    }
  }

  /** Build the pane tree DOM inside a container */
  private buildPaneTreeDom(node: PaneNode, container: HTMLElement): void {
    if (node.type === 'leaf') {
      container.appendChild(node.pane.element);
    } else {
      container.appendChild(node.element);
    }
  }

  /** Update the tab bar visibility and active state for a window */
  private updateTabBar(win: KryptonWindow): void {
    const shouldShow = this.tabsConfig.always_show_tabbar || win.tabs.length > 1;
    win.tabBarElement.classList.toggle('krypton-window__tabbar--visible', shouldShow);

    // Update active indicators
    const tabEls = win.tabBarElement.querySelectorAll('.krypton-tab');
    tabEls.forEach((el, i) => {
      el.classList.toggle('krypton-tab--active', i === win.activeTabIndex);
    });
  }

  /** Build a single tab DOM element with index, dot, and title */
  private buildTabElement(tabId: TabId, index: number, title: string): HTMLElement {
    const tabEl = document.createElement('div');
    tabEl.className = 'krypton-tab';
    tabEl.dataset.tabId = tabId;

    const indexSpan = document.createElement('span');
    indexSpan.className = 'krypton-tab__index';
    indexSpan.textContent = String(index + 1).padStart(2, '0');

    const dot = document.createElement('span');
    dot.className = 'krypton-tab__dot';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'krypton-tab__title';
    titleSpan.textContent = title;

    tabEl.appendChild(indexSpan);
    tabEl.appendChild(dot);
    tabEl.appendChild(titleSpan);
    return tabEl;
  }

  /** Rebuild the tab bar DOM for a window */
  private rebuildTabBar(win: KryptonWindow): void {
    win.tabBarElement.innerHTML = '';
    for (let i = 0; i < win.tabs.length; i++) {
      const tab = win.tabs[i];
      const tabEl = this.buildTabElement(tab.id, i, tab.title);
      tab.element = tabEl;
      win.tabBarElement.appendChild(tabEl);
    }
    this.updateTabBar(win);
  }

  /** Switch the visible tab content for a window */
  private showActiveTab(win: KryptonWindow): void {
    // Clear content area
    while (win.contentElement.firstChild) {
      win.contentElement.removeChild(win.contentElement.firstChild);
    }

    const tab = win.tabs[win.activeTabIndex];
    if (!tab) return;

    // Mount the active tab's pane tree
    this.buildPaneTreeDom(tab.paneTree, win.contentElement);
  }

  /**
   * Set the frontend theme engine. The compositor will use it to build the
   * xterm.js theme and will register for theme change callbacks.
   */
  setThemeEngine(engine: FrontendThemeEngine): void {
    this.themeEngine = engine;

    // Use the theme engine's xterm theme if available — always force
    // transparent canvas background (visual backdrop handled by CSS).
    const xtermTheme = engine.buildXtermTheme();
    if (Object.keys(xtermTheme).length > 0) {
      xtermTheme.background = XTERM_TRANSPARENT_BG;
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
    // Canvas background is always fully transparent — the visual backdrop
    // lives on .krypton-window via CSS (see XTERM_TRANSPARENT_BG comment).
    xtermTheme.background = XTERM_TRANSPARENT_BG;
    this.terminalTheme = xtermTheme;

    // Update all workspace terminals (all panes in all tabs in all windows)
    for (const [, win] of this.windows) {
      for (const tab of win.tabs) {
        for (const pane of this.collectPanes(tab.paneTree)) {
          pane.terminal.options.theme = xtermTheme;
        }
      }
    }

    // Update Quick Terminal if it exists
    if (this.qtTerminal) {
      this.qtTerminal.terminal.options.theme = xtermTheme;
    }
  }

  /**
   * Set the Claude hook manager. The compositor will use it to create
   * badge and tool indicator elements in window chrome.
   */
  setClaudeHookManager(manager: ClaudeHookManager): void {
    this.claudeHookManager = manager;
  }

  /** Toggle hook toast notifications on/off. Returns new state. */
  toggleHookToasts(): boolean {
    if (!this.claudeHookManager) return false;
    this.hookToastsEnabled = !this.hookToastsEnabled;
    this.claudeHookManager.setToastsEnabled(this.hookToastsEnabled);
    return this.hookToastsEnabled;
  }

  /** Whether hook toasts are currently enabled */
  get hookToastsVisible(): boolean {
    return this.hookToastsEnabled;
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

  /** Get pinned windows with their display labels and IDs */
  get pinnedWindows(): Array<{ id: WindowId; label: string }> {
    const result: Array<{ id: WindowId; label: string }> = [];
    for (const [id, win] of this.windows) {
      if (win.pinned) {
        const labelEl = win.element.querySelector('.krypton-window__label');
        const label = labelEl?.textContent ?? id;
        result.push({ id, label });
      }
    }
    return result;
  }

  /** Get the animation engine instance */
  get animationEngine(): AnimationEngine {
    return this.animation;
  }

  /** Get the sound engine instance */
  get soundEngine(): SoundEngine {
    return this.sound;
  }

  /** Get the extension manager instance */
  get extensionManager(): ExtensionManager {
    return this.extensions;
  }

  /** Get the dashboard manager instance */
  get dashboardManager(): DashboardManager {
    return this.dashboards;
  }

  // ─── Shader Controls ─────────────────────────────────────────────

  /** Cycle shader preset on the focused pane */
  cycleShaderPreset(): void {
    const pane = this.getFocusedPane();
    if (!pane) return;

    if (pane.shaderInstance) {
      const next = this.shaderEngine.cyclePreset(pane.shaderInstance);
      console.log(`[krypton:shaders] Cycled to preset: ${next}`);
    } else {
      // No shader yet — attach with 'crt' (first real preset)
      pane.shaderInstance = this.shaderEngine.attach(
        pane.element,
        'crt' as ShaderPreset,
        this.shaderConfig.intensity,
      );
    }
  }

  /** Toggle shaders on/off globally for all panes */
  toggleShadersGlobally(): void {
    this.shaderConfig.enabled = !this.shaderConfig.enabled;
    console.log(`[krypton:shaders] Globally ${this.shaderConfig.enabled ? 'enabled' : 'disabled'}`);

    if (this.shaderConfig.enabled) {
      // Attach shaders to all panes that don't have one
      const preset = (this.shaderConfig.preset !== 'none' ? this.shaderConfig.preset : 'crt') as ShaderPreset;
      this._forEachPane((pane) => {
        if (!pane.shaderInstance) {
          pane.shaderInstance = this.shaderEngine.attach(
            pane.element,
            preset,
            this.shaderConfig.intensity,
          );
        }
      });
    } else {
      // Detach shaders from all panes
      this._forEachPane((pane) => {
        if (pane.shaderInstance) {
          this.shaderEngine.detach(pane.shaderInstance);
          pane.shaderInstance = null;
        }
      });
    }
  }

  /** Re-apply shader settings to all existing panes (for config hot-reload) */
  reapplyShaderConfig(config: ShaderConfig): void {
    this.shaderConfig = config;
    this.shaderEngine = new ShaderEngine({
      fps_cap: config.fps_cap,
      animate: config.animate,
    });

    // Detach all existing shaders
    this._forEachPane((pane) => {
      if (pane.shaderInstance) {
        this.shaderEngine.detach(pane.shaderInstance);
        pane.shaderInstance = null;
      }
    });

    // Re-attach if enabled
    if (config.enabled && config.preset !== 'none') {
      this._forEachPane((pane) => {
        pane.shaderInstance = this.shaderEngine.attach(
          pane.element,
          config.preset as ShaderPreset,
          config.intensity,
        );
      });
    }
  }

  /** Iterate over every pane in every tab of every window */
  private _forEachPane(fn: (pane: Pane) => void): void {
    for (const [, win] of this.windows) {
      for (const tab of win.tabs) {
        for (const pane of this.collectPanes(tab.paneTree)) {
          fn(pane);
        }
      }
    }
  }

  /** Register callback for focus changes */
  onFocusChange(cb: (id: WindowId | null) => void): void {
    this.onFocusChangeCallbacks.push(cb);
  }

  /** Set custom key event handler for all terminals (called by InputRouter) */
  setCustomKeyHandler(handler: CustomKeyHandler): void {
    this.customKeyHandler = handler;
    // Attach to all panes in all tabs in all windows
    for (const [, win] of this.windows) {
      for (const tab of win.tabs) {
        for (const pane of this.collectPanes(tab.paneTree)) {
          pane.terminal.attachCustomKeyEventHandler(handler);
        }
      }
    }
    // Also attach to Quick Terminal if it exists
    if (this.qtTerminal) {
      this.qtTerminal.terminal.attachCustomKeyEventHandler(handler);
    }
  }

  /** Allocate the next available accent color from the palette */
  private allocateAccentColor(windowId: WindowId): AccentColor {
    for (let i = 0; i < ACCENT_PALETTE.length; i++) {
      if (!this.usedColorIndices.has(i)) {
        this.usedColorIndices.add(i);
        this.windowColorIndex.set(windowId, i);
        return ACCENT_PALETTE[i];
      }
    }
    // All colors in use — wrap around using window count as tiebreaker
    const idx = this.windowColorIndex.size % ACCENT_PALETTE.length;
    this.windowColorIndex.set(windowId, idx);
    return ACCENT_PALETTE[idx];
  }

  /** Free a window's accent color so it can be reused */
  private freeAccentColor(windowId: WindowId): void {
    const idx = this.windowColorIndex.get(windowId);
    if (idx !== undefined) {
      this.windowColorIndex.delete(windowId);
      // Only free the index if no other window is using it
      let stillUsed = false;
      for (const otherIdx of this.windowColorIndex.values()) {
        if (otherIdx === idx) { stillUsed = true; break; }
      }
      if (!stillUsed) {
        this.usedColorIndices.delete(idx);
      }
    }
  }

  /** Apply accent color CSS custom properties to a DOM element */
  private applyAccentColor(el: HTMLElement, color: AccentColor): void {
    el.style.setProperty('--krypton-window-accent', color.hex);
    el.style.setProperty('--krypton-window-accent-rgb', color.rgb);
  }

  /** Get the cwd of the focused pane's shell, if available */
  private async getFocusedCwd(): Promise<string | null> {
    const pane = this.getFocusedPane();
    if (!pane || pane.sessionId === null) return null;
    try {
      const cwd = await invoke<string | null>('get_pty_cwd', {
        sessionId: pane.sessionId,
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

    // Assign unique accent color
    const accentColor = this.allocateAccentColor(id);
    this.applyAccentColor(el, accentColor);

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
    // Claude Code badge (sparkle indicator)
    if (this.claudeHookManager) {
      labelGroup.appendChild(this.claudeHookManager.createBadge());
    }
    labelGroup.appendChild(label);

    // Right side: Claude tool indicator + PTY status
    const claudeTool = this.claudeHookManager
      ? this.claudeHookManager.createToolIndicator()
      : document.createElement('span');
    const ptyStatus = document.createElement('span');
    ptyStatus.className = 'krypton-window__pty-status';
    ptyStatus.textContent = 'starting...';

    titlebar.appendChild(labelGroup);
    titlebar.appendChild(claudeTool);
    titlebar.appendChild(ptyStatus);
    chrome.appendChild(titlebar);

    // Header accent bar (striped decoration below titlebar)
    const headerAccent = document.createElement('div');
    headerAccent.className = 'krypton-window__header-accent';
    chrome.appendChild(headerAccent);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'krypton-window__tabbar';

    // Content area
    const content = document.createElement('div');
    content.className = 'krypton-window__content';

    // Corner accent elements
    for (const pos of ['tl', 'tr', 'bl', 'br']) {
      const corner = document.createElement('div');
      corner.className = `krypton-window__corner krypton-window__corner--${pos}`;
      el.appendChild(corner);
    }

    // Claude Code HUD elements inside content area
    if (this.claudeHookManager) {
      content.appendChild(this.claudeHookManager.createUplinkBar());
      content.appendChild(this.claudeHookManager.createActivityTrace());
    }

    // 3D perspective wrapper — isolates the 3D context from backdrop-filter
    const perspectiveWrap = document.createElement('div');
    perspectiveWrap.className = 'krypton-window__perspective';
    perspectiveWrap.appendChild(content);

    el.appendChild(chrome);
    el.appendChild(tabBar);
    el.appendChild(perspectiveWrap);
    this.workspace.appendChild(el);

    // Create first tab with a single pane
    const pane = this.createPane(content);
    const tabId = nextTabId();
    const tabEl = this.buildTabElement(tabId, 0, 'Shell 1');
    tabBar.appendChild(tabEl);

    const tab: Tab = {
      id: tabId,
      title: 'Shell 1',
      paneTree: { type: 'leaf', pane },
      focusedPaneId: pane.id,
      element: tabEl,
    };

    // Create window record
    const win: KryptonWindow = {
      id,
      tabs: [tab],
      activeTabIndex: 0,
      gridSlot: { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      element: el,
      tabBarElement: tabBar,
      contentElement: content,
      pinned: false,
    };
    this.windows.set(id, win);
    this.updateTabBar(win);

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

    // Listen for shell title changes (OSC 0/2 sequences)
    pane.terminal.onTitleChange((title: string) => {
      if (title) {
        const styled = this.claudeHookManager
          ? this.claudeHookManager.formatTerminalTitle(title)
          : title;
        label.textContent = styled;
        tab.title = styled;
        const titleEl = tab.element.querySelector('.krypton-tab__title');
        if (titleEl) titleEl.textContent = styled;
      }
    });

    // Spawn PTY for the first pane
    await this.spawnPaneSession(pane, id, tabId, cwd);
    this.wirePaneInput(pane);

    if (pane.sessionId !== null) {
      label.textContent = `session_${String(pane.sessionId).padStart(2, '0')}`;
      ptyStatus.textContent = 'pty // active';
      this.updateWindowCwd(pane.sessionId, ptyStatus);
    } else {
      ptyStatus.textContent = 'pty // failed';
    }

    // Click to focus
    el.addEventListener('mousedown', () => {
      this.focusWindow(id);
    });

    return id;
  }

  /** Close a window and destroy all its tabs/panes */
  async closeWindow(id: WindowId): Promise<void> {
    const win = this.windows.get(id);
    if (!win) return;

    // Exit maximize mode if the maximized window is being closed
    if (this.maximizedWindowId === id) {
      this.maximizedWindowId = null;
      this.showAllWindows();
    }

    // Dispose all tabs and their pane trees
    for (const tab of win.tabs) {
      this.disposePaneTree(tab.paneTree);
    }

    // Free accent color for reuse
    this.freeAccentColor(id);

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

    // Re-focus the terminal after relayout/fit — the fit cycle can steal focus
    this.refocusTerminal();
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
      // Focus the active tab's focused pane terminal
      if (win.tabs.length > 0) {
        const tab = win.tabs[win.activeTabIndex];
        const pane = this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
        if (pane) {
          pane.terminal.focus();
        }
      }
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

  /**
   * Focus window by index (1-based), relative to the currently focused window.
   * Index 1 = current window (no-op), 2 = next window, 3 = two ahead, etc.
   * The order wraps around so all windows are always reachable.
   */
  focusByIndex(index: number): void {
    const ids = this.windowIds;
    if (ids.length === 0 || index < 1 || index > ids.length) return;

    // Rotate the list so the focused window is at position 0
    const focusIdx = this.focusedWindowId ? ids.indexOf(this.focusedWindowId) : 0;
    const rotated = [...ids.slice(focusIdx), ...ids.slice(0, focusIdx)];

    this.focusWindow(rotated[index - 1]);
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
      // Use the visual order captured during the last relayout,
      // but skip pinned windows — they don't participate in the cycle.
      const order = this.focusVisualOrder.filter((id) => {
        const w = this.windows.get(id);
        return w && !w.pinned;
      });
      if (order.length <= 1) return; // all pinned or only one unpinned
      const currentIdx = this.focusedWindowId ? order.indexOf(this.focusedWindowId) : 0;
      const startIdx = currentIdx === -1 ? 0 : currentIdx;
      const nextIdx = (startIdx + direction + order.length) % order.length;
      this.focusWindow(order[nextIdx]);
    } else {
      // Grid layout: cycle by creation order (pinned windows participate normally).
      const ids = this.windowIds;
      const currentIdx = this.focusedWindowId ? ids.indexOf(this.focusedWindowId) : 0;
      const nextIdx = (currentIdx + direction + ids.length) % ids.length;
      this.focusWindow(ids[nextIdx]);
    }
  }

  /**
   * Toggle pin state of a window. Pinned windows stick to the right column
   * in Focus layout and are skipped during focus cycling.
   * If no windowId is provided, toggles the focused window.
   */
  async togglePin(windowId?: WindowId): Promise<void> {
    const id = windowId ?? this.focusedWindowId;
    if (!id) return;
    const win = this.windows.get(id);
    if (!win) return;

    win.pinned = !win.pinned;

    // Update CSS class for visual indicator
    if (win.pinned) {
      win.element.classList.add('krypton-window--pinned');
      this.sound.play('window.pin');
    } else {
      win.element.classList.remove('krypton-window--pinned');
      this.sound.play('window.unpin');
    }

    // If we just pinned the currently focused (main) window in Focus layout,
    // move focus to the next unpinned window so the main column isn't empty.
    if (win.pinned && this.layoutMode === LayoutMode.Focus && this.focusedWindowId === id) {
      const unpinnedId = this.windowIds.find((wid) => {
        const w = this.windows.get(wid);
        return w && !w.pinned && wid !== id;
      });
      if (unpinnedId) {
        this.focusWindowQuiet(unpinnedId);
      }
    }

    // Relayout with animation
    const snapshots = this.snapshotBounds();
    this.relayout();
    await this.nextFrame();
    this.fitAll();
    this.animateRelayout(snapshots);
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
    const pane = this.getFocusedPane();
    return pane ? pane.terminal : null;
  }

  /** Get the PTY session ID of the focused pane (or Quick Terminal if visible) */
  getFocusedSessionId(): number | null {
    if (this.qtVisible && this.qtSessionId !== null) {
      return this.qtSessionId;
    }
    const pane = this.getFocusedPane();
    return pane?.sessionId ?? null;
  }

  /** Refocus the terminal of the currently focused pane */
  refocusTerminal(): void {
    const pane = this.getFocusedPane();
    if (pane) {
      pane.terminal.focus();
    }
  }

  /** Scroll the focused terminal by the given number of pages (negative = up) */
  scrollPages(pages: number): void {
    // If Quick Terminal is visible, scroll it instead
    if (this.qtVisible && this.qtTerminal) {
      this.qtTerminal.terminal.scrollPages(pages);
      return;
    }
    const pane = this.getFocusedPane();
    if (pane) {
      pane.terminal.scrollPages(pages);
    }
  }

  /**
   * Write raw bytes to the focused terminal's PTY session.
   * Handles both regular panes and Quick Terminal.
   * Used by InputRouter for modifier key combinations that xterm.js
   * doesn't translate correctly (e.g., Shift+Enter).
   */
  writeToFocusedPty(data: string): void {
    const encoder = new TextEncoder();
    const bytes = Array.from(encoder.encode(data));

    // If Quick Terminal is visible, write to its PTY
    if (this.qtVisible && this.qtSessionId !== null) {
      invoke('write_to_pty', { sessionId: this.qtSessionId, data: bytes })
        .catch((e) => console.error('QT write to PTY failed:', e));
      return;
    }

    // Otherwise write to focused pane's PTY
    const pane = this.getFocusedPane();
    if (pane && pane.sessionId !== null) {
      invoke('write_to_pty', { sessionId: pane.sessionId, data: bytes })
        .catch((e: unknown) => console.error('Write to PTY failed:', e));
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

  // ─── Tab / Pane Public API ─────────────────────────────────────

  /** Create a new tab in the focused window */
  async createTab(): Promise<void> {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win) return;

    const cwd = await this.getFocusedCwd();
    const tabId = nextTabId();

    // Detach current tab's pane tree from DOM
    while (win.contentElement.firstChild) {
      win.contentElement.removeChild(win.contentElement.firstChild);
    }

    // Create the new pane
    const pane = this.createPane(win.contentElement);

    const tabNum = win.tabs.length + 1;
    const tabEl = this.buildTabElement(tabId, tabNum - 1, `Shell ${tabNum}`);

    const tab: Tab = {
      id: tabId,
      title: `Shell ${tabNum}`,
      paneTree: { type: 'leaf', pane },
      focusedPaneId: pane.id,
      element: tabEl,
    };

    win.tabs.push(tab);
    win.activeTabIndex = win.tabs.length - 1;
    this.rebuildTabBar(win);
    this.showActiveTab(win);

    await this.nextFrame();
    this.fitWindow(win.id);

    // Spawn PTY and wire input
    await this.spawnPaneSession(pane, win.id, tabId, cwd);
    this.wirePaneInput(pane);

    // Title change listener
    pane.terminal.onTitleChange((title: string) => {
      if (title) {
        tab.title = title;
        const titleEl = tab.element.querySelector('.krypton-tab__title');
        if (titleEl) titleEl.textContent = title;
      }
    });

    pane.terminal.focus();
    this.sound.play('tab.create');
  }

  /** Close the active tab in the focused window */
  async closeTab(): Promise<void> {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length === 0) return;

    if (win.tabs.length === 1) {
      // Last tab — close the window
      if (this.tabsConfig.close_window_on_last_tab) {
        await this.closeWindow(win.id);
      }
      return;
    }

    this.closeTabByIndex(win, win.activeTabIndex);
    this.sound.play('tab.close');
  }

  /** Internal: close a specific tab by index */
  private closeTabByIndex(win: KryptonWindow, tabIndex: number): void {
    const tab = win.tabs[tabIndex];
    this.disposePaneTree(tab.paneTree);
    win.tabs.splice(tabIndex, 1);

    // Adjust active tab index
    if (win.activeTabIndex >= win.tabs.length) {
      win.activeTabIndex = win.tabs.length - 1;
    }

    this.rebuildTabBar(win);
    this.showActiveTab(win);
    this.fitWindow(win.id);

    // Focus the new active tab's pane
    if (win.tabs.length > 0) {
      const newTab = win.tabs[win.activeTabIndex];
      const pane = this.findPaneInTree(newTab.paneTree, newTab.focusedPaneId);
      if (pane) pane.terminal.focus();
    }
  }

  /** Switch to the previous or next tab in the focused window */
  switchTab(direction: -1 | 1): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length <= 1) return;

    // Detach current pane tree from DOM
    while (win.contentElement.firstChild) {
      win.contentElement.removeChild(win.contentElement.firstChild);
    }

    win.activeTabIndex = (win.activeTabIndex + direction + win.tabs.length) % win.tabs.length;
    this.updateTabBar(win);
    this.showActiveTab(win);
    this.fitWindow(win.id);

    const tab = win.tabs[win.activeTabIndex];
    const pane = this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
    if (pane) pane.terminal.focus();

    this.sound.play('tab.switch');
  }

  /** Move the active tab from the focused window to another window by index */
  moveTabToWindow(targetIndex: number): void {
    if (!this.focusedWindowId) return;
    const srcWin = this.windows.get(this.focusedWindowId);
    if (!srcWin || srcWin.tabs.length === 0) return;

    // Get target window by index (1-based, relative to window order)
    const ids = this.windowIds;
    if (targetIndex < 1 || targetIndex > ids.length) return;
    const focusIdx = ids.indexOf(this.focusedWindowId);
    const rotated = [...ids.slice(focusIdx), ...ids.slice(0, focusIdx)];
    const targetId = rotated[targetIndex - 1];
    if (targetId === this.focusedWindowId) return; // No-op: same window

    const targetWin = this.windows.get(targetId);
    if (!targetWin) return;

    // Detach the tab from source
    const tab = srcWin.tabs[srcWin.activeTabIndex];

    // Remove pane tree from source window's DOM
    while (srcWin.contentElement.firstChild) {
      srcWin.contentElement.removeChild(srcWin.contentElement.firstChild);
    }

    srcWin.tabs.splice(srcWin.activeTabIndex, 1);

    // Update session map for all panes in the moved tab
    for (const pane of this.collectPanes(tab.paneTree)) {
      if (pane.sessionId !== null) {
        this.sessionMap.set(pane.sessionId, {
          windowId: targetId,
          tabId: tab.id,
          paneId: pane.id,
        });
      }
    }

    // Attach to target window
    targetWin.tabs.push(tab);
    targetWin.activeTabIndex = targetWin.tabs.length - 1;

    // Update source window
    if (srcWin.tabs.length === 0) {
      this.closeWindow(srcWin.id);
    } else {
      if (srcWin.activeTabIndex >= srcWin.tabs.length) {
        srcWin.activeTabIndex = srcWin.tabs.length - 1;
      }
      this.rebuildTabBar(srcWin);
      this.showActiveTab(srcWin);
      this.fitWindow(srcWin.id);
    }

    // Update target window
    this.rebuildTabBar(targetWin);
    // Detach current content and show new tab
    while (targetWin.contentElement.firstChild) {
      targetWin.contentElement.removeChild(targetWin.contentElement.firstChild);
    }
    this.showActiveTab(targetWin);
    this.fitWindow(targetWin.id);

    this.sound.play('tab.move');
  }

  /** Split the focused pane */
  async splitPane(direction?: SplitDirection): Promise<void> {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length === 0) return;

    const tab = win.tabs[win.activeTabIndex];
    const splitDir = direction ?? (this.tabsConfig.default_split as SplitDirection);
    const cwd = await this.getFocusedCwd();

    // Find the focused pane's parent in the tree and replace it with a split
    const replaceInTree = (node: PaneNode): PaneNode => {
      if (node.type === 'leaf' && node.pane.id === tab.focusedPaneId) {
        // Create split container element
        const splitEl = document.createElement('div');
        splitEl.className = `krypton-split krypton-split--${splitDir}`;

        const divider = document.createElement('div');
        divider.className = 'krypton-split__divider';

        // Reparent old pane into the split
        node.pane.element.remove();
        splitEl.appendChild(node.pane.element);
        splitEl.appendChild(divider);

        // Create new pane inside the split
        const newPane = this.createPane(splitEl);

        return {
          type: 'split',
          direction: splitDir,
          ratio: 0.5,
          first: node,
          second: { type: 'leaf', pane: newPane },
          element: splitEl,
        };
      }
      if (node.type === 'split') {
        return {
          ...node,
          first: replaceInTree(node.first),
          second: replaceInTree(node.second),
        };
      }
      return node;
    };

    tab.paneTree = replaceInTree(tab.paneTree);

    // Rebuild the content DOM
    while (win.contentElement.firstChild) {
      win.contentElement.removeChild(win.contentElement.firstChild);
    }
    this.buildPaneTreeDom(tab.paneTree, win.contentElement);

    // Find the new pane (it's the one that was just created — last in the tree)
    const allPanes = this.collectPanes(tab.paneTree);
    const newPane = allPanes[allPanes.length - 1];

    // Spawn PTY and wire
    await this.spawnPaneSession(newPane, win.id, tab.id, cwd);
    this.wirePaneInput(newPane);

    // Title change listener for new pane
    newPane.terminal.onTitleChange((title: string) => {
      if (title && tab.focusedPaneId === newPane.id) {
        tab.title = title;
      }
    });

    tab.focusedPaneId = newPane.id;

    await this.nextFrame();
    this.fitPaneTree(tab.paneTree);
    newPane.terminal.focus();
    this.updatePaneFocusIndicator(tab);
    this.sound.play('pane.split');
  }

  /** Close the focused pane */
  async closePane(): Promise<void> {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length === 0) return;

    const tab = win.tabs[win.activeTabIndex];
    const panes = this.collectPanes(tab.paneTree);

    if (panes.length <= 1) {
      // Only one pane — close the tab instead
      await this.closeTab();
      return;
    }

    this.closePaneInTab(tab, tab.focusedPaneId, win);
    this.sound.play('pane.close');
  }

  /** Internal: close a pane within a tab, promote its sibling */
  private closePaneInTab(tab: Tab, paneId: PaneId, win: KryptonWindow): void {
    // Find and dispose the pane
    const pane = this.findPaneInTree(tab.paneTree, paneId);
    if (pane) {
      pane.terminal.dispose();
      if (pane.sessionId !== null) {
        this.sessionMap.delete(pane.sessionId);
      }
      pane.element.remove();
    }

    // Remove the pane from the tree, promoting the sibling
    const removeFromTree = (node: PaneNode): PaneNode | null => {
      if (node.type === 'leaf') {
        return node.pane.id === paneId ? null : node;
      }
      const firstResult = removeFromTree(node.first);
      const secondResult = removeFromTree(node.second);

      if (!firstResult) {
        // Remove the split container element
        node.element.remove();
        return secondResult;
      }
      if (!secondResult) {
        node.element.remove();
        return firstResult;
      }
      return { ...node, first: firstResult, second: secondResult };
    };

    const newTree = removeFromTree(tab.paneTree);
    if (newTree) {
      tab.paneTree = newTree;
    }

    // Rebuild DOM
    while (win.contentElement.firstChild) {
      win.contentElement.removeChild(win.contentElement.firstChild);
    }
    this.buildPaneTreeDom(tab.paneTree, win.contentElement);

    // Focus the first remaining pane
    const remainingPanes = this.collectPanes(tab.paneTree);
    if (remainingPanes.length > 0) {
      tab.focusedPaneId = remainingPanes[0].id;
      remainingPanes[0].terminal.focus();
      this.updatePaneFocusIndicator(tab);
    }

    this.fitPaneTree(tab.paneTree);
  }

  /** Navigate between panes in a direction */
  focusPaneDirection(direction: 'left' | 'down' | 'up' | 'right'): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length === 0) return;

    const tab = win.tabs[win.activeTabIndex];
    const panes = this.collectPanes(tab.paneTree);
    if (panes.length <= 1) return;

    const currentPane = this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
    if (!currentPane) return;

    const curRect = currentPane.element.getBoundingClientRect();
    const curCx = curRect.left + curRect.width / 2;
    const curCy = curRect.top + curRect.height / 2;

    let bestPane: Pane | null = null;
    let bestDist = Infinity;

    for (const p of panes) {
      if (p.id === tab.focusedPaneId) continue;
      const rect = p.element.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      let matches = false;
      let dist = 0;

      switch (direction) {
        case 'left':  matches = cx < curCx; dist = (curCx - cx) + Math.abs(curCy - cy) * 0.5; break;
        case 'right': matches = cx > curCx; dist = (cx - curCx) + Math.abs(curCy - cy) * 0.5; break;
        case 'up':    matches = cy < curCy; dist = (curCy - cy) + Math.abs(curCx - cx) * 0.5; break;
        case 'down':  matches = cy > curCy; dist = (cy - curCy) + Math.abs(curCx - cx) * 0.5; break;
      }

      if (matches && dist < bestDist) {
        bestDist = dist;
        bestPane = p;
      }
    }

    if (bestPane) {
      tab.focusedPaneId = bestPane.id;
      bestPane.terminal.focus();
      this.updatePaneFocusIndicator(tab);
      this.sound.play('pane.focus');
    }
  }

  /** Cycle pane focus forward (+1) or backward (-1) within the active tab */
  cyclePaneFocus(direction: -1 | 1): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length === 0) return;

    const tab = win.tabs[win.activeTabIndex];
    const panes = this.collectPanes(tab.paneTree);
    if (panes.length <= 1) return;

    const currentIndex = panes.findIndex(p => p.id === tab.focusedPaneId);
    if (currentIndex === -1) return;

    const nextIndex = (currentIndex + direction + panes.length) % panes.length;
    const nextPane = panes[nextIndex];

    tab.focusedPaneId = nextPane.id;
    nextPane.terminal.focus();
    this.updatePaneFocusIndicator(tab);
    this.sound.play('pane.focus');
  }

  /** Update the visual pane focus indicator within a tab */
  private updatePaneFocusIndicator(tab: Tab): void {
    const panes = this.collectPanes(tab.paneTree);
    for (const p of panes) {
      p.element.classList.toggle('krypton-pane--focused', p.id === tab.focusedPaneId);
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
    this.sound.play('tab.create');

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

    // Animate 3D float-in: swings from tilted-back to resting float
    const duration = this.qtConfig.animationDuration;
    const anim = this.qtElement.animate(
      [
        { transform: 'perspective(800px) rotateX(16deg) translateZ(-60px) translateY(-40px)', opacity: '0' },
        { transform: 'perspective(800px) rotateX(1.5deg) translateZ(20px) translateY(0)', opacity: '1' },
      ],
      { duration, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'none' },
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
    this.sound.play('tab.close');

    // Animate 3D float-out: tilts back and recedes into depth
    const duration = this.qtConfig.animationDuration;
    const anim = this.qtElement.animate(
      [
        { transform: 'perspective(800px) rotateX(1.5deg) translateZ(20px) translateY(0)', opacity: '1' },
        { transform: 'perspective(800px) rotateX(16deg) translateZ(-60px) translateY(-40px)', opacity: '0' },
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

      // Refocus the restored window's active pane terminal
      if (win.tabs.length > 0) {
        const tab = win.tabs[win.activeTabIndex];
        const pane = this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
        if (pane) {
          pane.terminal.focus();
        }
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

    // Quick Terminal always uses cyan (first palette color)
    this.applyAccentColor(el, ACCENT_PALETTE[0]);

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

    // 3D perspective wrapper
    const perspectiveWrap = document.createElement('div');
    perspectiveWrap.className = 'krypton-window__perspective';
    perspectiveWrap.appendChild(content);

    el.appendChild(chrome);
    el.appendChild(perspectiveWrap);
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

    // Edge glow overlays
    const qtGlowTop = document.createElement('div');
    qtGlowTop.className = 'krypton-glow-overlay';
    body.appendChild(qtGlowTop);

    const qtGlowBottom = document.createElement('div');
    qtGlowBottom.className = 'krypton-glow-overlay krypton-glow-overlay--bottom';
    body.appendChild(qtGlowBottom);

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

    // Attach shader to Quick Terminal if enabled
    if (this.shaderConfig.enabled && this.shaderConfig.preset !== 'none') {
      this.shaderEngine.attach(
        body,
        this.shaderConfig.preset as ShaderPreset,
        this.shaderConfig.intensity,
      );
    }

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
    });
    // Keypress sound on actual keyboard input only (not mouse reporting)
    terminal.onKey(({ domEvent }) => {
      this.sound.playKeypress('press', domEvent.key);
      setTimeout(() => this.sound.playKeypress('release', domEvent.key), 30 + Math.random() * 40);
    });
    // Copy-on-select
    this.wireCopyOnSelect(terminal);

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

    const pane = this.getFocusedPane();
    if (pane) {
      // Replay each buffered keydown by re-dispatching to the terminal's textarea
      const textarea = pane.terminal.textarea;
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

  /** Focus layout: focused window on left (full height, 65% width), rest fill remaining area.
   *  Pinned windows are always placed in the right column (below unpinned stack). */
  private relayoutFocus(vw: number, vh: number, count: number): void {
    const ids = this.windowIds;
    const gap = this.windowGap;
    const mainW = Math.round(vw * Compositor.FOCUS_MAIN_RATIO);
    const stackW = vw - mainW - gap;

    // Separate windows into unpinned and pinned lists (preserving creation order)
    const unpinnedIds: WindowId[] = [];
    const pinnedIds: WindowId[] = [];
    for (const id of ids) {
      const w = this.windows.get(id);
      if (!w) continue;
      if (w.pinned) {
        pinnedIds.push(id);
      } else {
        unpinnedIds.push(id);
      }
    }

    // Determine which window takes the main (left) column.
    // Must be an unpinned window. If the focused window is pinned (or no
    // unpinned windows exist), fall back to the first unpinned window,
    // or the first pinned window as last resort.
    let mainId: WindowId | null = null;
    if (unpinnedIds.length > 0) {
      if (this.focusedWindowId && unpinnedIds.includes(this.focusedWindowId)) {
        mainId = this.focusedWindowId;
      } else {
        mainId = unpinnedIds[0];
      }
    } else if (pinnedIds.length > 0) {
      // All windows are pinned — first pinned window takes main column
      mainId = this.focusedWindowId && pinnedIds.includes(this.focusedWindowId)
        ? this.focusedWindowId
        : pinnedIds[0];
    }

    if (!mainId) return;

    // Build the right-column stack: unpinned windows (excl. main) in cycle
    // order, then pinned windows.
    const mainIdxInUnpinned = unpinnedIds.indexOf(mainId);
    const unpinnedStack: WindowId[] = [];
    if (mainIdxInUnpinned !== -1) {
      // Cycle order starting after the main window
      for (let offset = 1; offset < unpinnedIds.length; offset++) {
        unpinnedStack.push(unpinnedIds[(mainIdxInUnpinned + offset) % unpinnedIds.length]);
      }
    }

    const rightStack = [...unpinnedStack, ...pinnedIds];
    // If mainId is a pinned window (all pinned case), remove it from rightStack
    const mainIdxInRight = rightStack.indexOf(mainId);
    if (mainIdxInRight !== -1) {
      rightStack.splice(mainIdxInRight, 1);
    }

    const stackCount = rightStack.length;

    // Calculate right-column cell heights with a separator between
    // unpinned and pinned sections (2x gap).
    const pinSeparatorGap = (unpinnedStack.length > 0 && pinnedIds.length > 0) ? gap : 0;
    const totalGaps = (stackCount > 1 ? gap * (stackCount - 1) : 0) + pinSeparatorGap;
    const stackCellH = stackCount > 0 ? (vh - totalGaps) / stackCount : vh;

    // Build visual order and apply bounds
    this.focusVisualOrder = [mainId];

    // Main window: left column, full height
    const mainWin = this.windows.get(mainId);
    if (mainWin) {
      mainWin.gridSlot = { col: 0, row: 0, colSpan: 1, rowSpan: Math.max(1, stackCount) };
      mainWin.bounds = { x: 0, y: 0, width: mainW, height: vh };
      this.applyBounds(mainWin);
    }

    // Right-column windows
    let y = 0;
    for (let i = 0; i < rightStack.length; i++) {
      const winId = rightStack[i];
      const win = this.windows.get(winId);
      if (!win) continue;

      this.focusVisualOrder.push(winId);

      // Add extra separator gap between unpinned and pinned sections
      if (i === unpinnedStack.length && pinSeparatorGap > 0) {
        y += pinSeparatorGap;
      }

      win.gridSlot = { col: 1, row: i, colSpan: 1, rowSpan: 1 };
      win.bounds = {
        x: mainW + gap,
        y: Math.round(y),
        width: stackW,
        height: Math.round(stackCellH),
      };
      this.applyBounds(win);

      y += stackCellH + gap;
    }
  }

  /** Fit all terminals to their containers and resize PTYs */
  fitAll(): void {
    for (const [, win] of this.windows) {
      this.fitWindow(win.id);
    }
  }

  /** Fit the active tab's pane tree for a window */
  private fitWindow(id: WindowId): void {
    const win = this.windows.get(id);
    if (!win || win.tabs.length === 0) return;

    const tab = win.tabs[win.activeTabIndex];
    this.fitPaneTree(tab.paneTree);
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

  // ─── OSC 7 CWD Tracking ──────────────────────────────────────────

  /**
   * Scan raw PTY output for OSC 7 escape sequences that report the
   * current working directory: ESC ] 7 ; file://host/path BEL|ST
   *
   * When found, reports the path to the backend so SSH clone can
   * use it as the remote CWD.
   */
  private parseOsc7(sessionId: number, data: number[]): void {
    // Quick scan: look for ESC ] 7 ; (0x1b 0x5d 0x37 0x3b)
    for (let i = 0; i < data.length - 4; i++) {
      if (data[i] === 0x1b && data[i + 1] === 0x5d && data[i + 2] === 0x37 && data[i + 3] === 0x3b) {
        // Found OSC 7 start — collect until BEL (0x07) or ESC \ (0x1b 0x5c)
        let end = -1;
        for (let j = i + 4; j < data.length; j++) {
          if (data[j] === 0x07) {
            end = j;
            break;
          }
          if (data[j] === 0x1b && j + 1 < data.length && data[j + 1] === 0x5c) {
            end = j;
            break;
          }
        }
        if (end > i + 4) {
          const uriBytes = data.slice(i + 4, end);
          const uri = new TextDecoder().decode(new Uint8Array(uriBytes));
          // URI format: file://hostname/path or file:///path
          // Extract both hostname and path so the backend can distinguish
          // local CWD updates from remote ones (SSH shells emit the remote hostname).
          const match = uri.match(/^file:\/\/([^/]*)(\/.*)$/);
          if (match) {
            const hostname = decodeURIComponent(match[1]);
            const path = decodeURIComponent(match[2]);
            invoke('set_ssh_remote_cwd', { sessionId, cwd: path, hostname })
              .catch(() => { /* ignore — ssh feature may be disabled */ });
          }
        }
      }
    }
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

      // Detect OSC 7 (current directory reporting): ESC ] 7 ; <uri> BEL/ST
      // Used to track the remote working directory for SSH clone.
      this.parseOsc7(sid, data);

      // Check Quick Terminal first
      if (this.qtSessionId === sid && this.qtTerminal) {
        this.qtTerminal.terminal.write(new Uint8Array(data));
        return;
      }

      // Look up via session map (O(1) instead of linear scan)
      const loc = this.sessionMap.get(sid);
      if (loc) {
        const win = this.windows.get(loc.windowId);
        if (win) {
          const tab = win.tabs.find((t) => t.id === loc.tabId);
          if (tab) {
            const pane = this.findPaneInTree(tab.paneTree, loc.paneId);
            if (pane) {
              pane.terminal.write(new Uint8Array(data));
            }
          }
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

      // Look up which pane this session belongs to
      const loc = this.sessionMap.get(sid);
      if (!loc) return;
      this.sessionMap.delete(sid);

      const win = this.windows.get(loc.windowId);
      if (!win) return;

      this.sound.play('terminal.exit');

      // Find the tab and close the pane
      const tabIndex = win.tabs.findIndex((t) => t.id === loc.tabId);
      if (tabIndex < 0) return;
      const tab = win.tabs[tabIndex];
      const panes = this.collectPanes(tab.paneTree);

      if (panes.length === 1) {
        // Last pane in tab — close the tab
        if (win.tabs.length === 1) {
          // Last tab in window — close window
          const statusEl = this.findPtyStatus(win.element);
          if (statusEl) statusEl.textContent = 'pty // exited';
          this.closeWindow(win.id);
        } else {
          this.closeTabByIndex(win, tabIndex);
        }
      } else {
        // Close just this pane within the tab
        this.closePaneInTab(tab, loc.paneId, win);
      }
    });

    // ─── Progress Bar (OSC 9;4) ────────────────────────────────────
    listen<ProgressEvent>('pty-progress', (event) => {
      const { session_id: sid, state, progress } = event.payload;

      // Quick Terminal
      if (this.qtSessionId === sid) {
        this.handleProgress(sid, state, progress, null);
        return;
      }

      // Regular window: look up via session map
      const loc = this.sessionMap.get(sid);
      if (loc) {
        this.handleProgress(sid, state, progress, loc.windowId);
      }
    });
  }

  // ─── Progress Bar Helpers (OSC 9;4) ──────────────────────────────

  /**
   * Handle a progress update for a session. Updates internal state and
   * drives the status dot arc gauge + titlebar scanline sweep.
   */
  private handleProgress(
    sessionId: SessionId,
    state: number,
    progress: number,
    windowId: WindowId | null,
  ): void {
    const pState = state as ProgressState;

    if (pState === ProgressState.Hidden) {
      // Clear progress state
      if (windowId === null) {
        this.qtProgress = null;
      } else {
        this.sessionProgress.delete(sessionId);
      }
    } else {
      // Store progress state
      const paneProgress: PaneProgress = { state: pState, progress };
      if (windowId === null) {
        this.qtProgress = paneProgress;
      } else {
        this.sessionProgress.set(sessionId, paneProgress);
      }
    }

    // Determine which window element to update
    let winEl: HTMLElement | null = null;
    if (windowId === null) {
      winEl = this.qtElement;
    } else {
      const win = this.windows.get(windowId);
      if (win) winEl = win.element;
    }
    if (!winEl) return;

    // Resolve which progress to display — active tab's focused pane for regular windows
    let displayProgress: PaneProgress | null = null;
    if (windowId === null) {
      displayProgress = this.qtProgress;
    } else {
      displayProgress = this.getWindowDisplayProgress(windowId);
    }

    this.updateProgressGauge(winEl, displayProgress);
  }

  /**
   * For a regular window, get the progress of the active tab's focused pane.
   */
  private getWindowDisplayProgress(windowId: WindowId): PaneProgress | null {
    const win = this.windows.get(windowId);
    if (!win) return null;
    const tab = win.tabs[win.activeTabIndex];
    if (!tab) return null;

    // Find the focused pane's session
    const focusedPane = this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
    if (!focusedPane || focusedPane.sessionId === null) return null;

    return this.sessionProgress.get(focusedPane.sessionId) ?? null;
  }

  /** SVG namespace for creating SVG elements */
  private static readonly SVG_NS = 'http://www.w3.org/2000/svg';

  /** Circumference of the gauge arc (r=40 in a 100x100 viewBox, C = 2*pi*40 ~= 251.327) */
  private static readonly GAUGE_CIRCUMFERENCE = 2 * Math.PI * 40;

  /**
   * Create or update the large centered background gauge in a window's
   * content area, and toggle the titlebar scanline sweep.
   */
  private updateProgressGauge(
    winEl: HTMLElement,
    displayProgress: PaneProgress | null,
  ): void {
    const contentEl = winEl.querySelector('.krypton-window__content') ?? winEl.querySelector('.krypton-window__body');
    const titlebar = winEl.querySelector('.krypton-window__titlebar');
    if (!contentEl || !titlebar) return;

    if (!displayProgress || displayProgress.state === ProgressState.Hidden) {
      this.removeProgressGauge(contentEl, titlebar);
      return;
    }

    const { state, progress } = displayProgress;

    // Ensure gauge container exists
    let gauge = contentEl.querySelector('.krypton-progress-gauge') as HTMLElement | null;
    if (!gauge) {
      gauge = this.createGaugeElement();
      // Insert as first child so it renders behind terminal content
      contentEl.insertBefore(gauge, contentEl.firstChild);
      // Trigger reflow then make visible for opacity transition
      void gauge.offsetHeight;
      gauge.classList.add('krypton-progress-gauge--visible');
    }

    const svg = gauge.querySelector('.krypton-progress-gauge__svg') as SVGElement;
    const fill = gauge.querySelector('.krypton-progress-gauge__fill') as SVGCircleElement;
    const pctText = gauge.querySelector('.krypton-progress-gauge__pct') as SVGTextElement;
    const labelText = gauge.querySelector('.krypton-progress-gauge__label') as SVGTextElement;
    if (!svg || !fill || !pctText || !labelText) return;

    // Clear state modifiers
    gauge.classList.remove(
      'krypton-progress-gauge--error',
      'krypton-progress-gauge--paused',
      'krypton-progress-gauge--indeterminate',
      'krypton-progress-gauge--flare',
      'krypton-progress-gauge--fade-out',
    );
    titlebar.classList.remove(
      'krypton-window__titlebar--progress-error',
      'krypton-window__titlebar--progress-paused',
    );

    // Activate titlebar scanline sweep
    titlebar.classList.add('krypton-window__titlebar--progress');

    const C = Compositor.GAUGE_CIRCUMFERENCE;

    switch (state) {
      case ProgressState.Normal: {
        const filled = (progress / 100) * C;
        fill.setAttribute('stroke-dasharray', `${filled} ${C - filled}`);
        pctText.textContent = `${progress}%`;
        labelText.textContent = 'loading';

        // Completion flash at 100%
        if (progress >= 100) {
          pctText.textContent = '100%';
          labelText.textContent = 'complete';
          gauge.classList.add('krypton-progress-gauge--flare');
          const gaugeRef = gauge;
          const contentRef = contentEl;
          const titlebarRef = titlebar;
          setTimeout(() => {
            gaugeRef.classList.remove('krypton-progress-gauge--flare');
            gaugeRef.classList.add('krypton-progress-gauge--fade-out');
            setTimeout(() => {
              this.removeProgressGauge(contentRef, titlebarRef);
            }, 1500);
          }, 800);
        }
        break;
      }

      case ProgressState.Error: {
        fill.setAttribute('stroke-dasharray', `${C} 0`);
        gauge.classList.add('krypton-progress-gauge--error');
        titlebar.classList.add('krypton-window__titlebar--progress-error');
        pctText.textContent = progress > 0 ? `${progress}%` : 'ERR';
        labelText.textContent = 'error';
        break;
      }

      case ProgressState.Indeterminate: {
        const segment = C * 0.25;
        fill.setAttribute('stroke-dasharray', `${segment} ${C - segment}`);
        gauge.classList.add('krypton-progress-gauge--indeterminate');
        pctText.textContent = '';
        labelText.textContent = 'working';
        break;
      }

      case ProgressState.Paused: {
        const filled = (progress / 100) * C;
        fill.setAttribute('stroke-dasharray', `${filled} ${C - filled}`);
        gauge.classList.add('krypton-progress-gauge--paused');
        titlebar.classList.add('krypton-window__titlebar--progress-paused');
        pctText.textContent = `${progress}%`;
        labelText.textContent = 'paused';
        break;
      }
    }
  }

  /**
   * Create the large centered background gauge DOM element.
   * Returns a container div with an SVG inside.
   */
  private createGaugeElement(): HTMLElement {
    const ns = Compositor.SVG_NS;

    // Wrapper div
    const gauge = document.createElement('div');
    gauge.className = 'krypton-progress-gauge';

    // SVG — 100x100 viewBox with arc at center
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'krypton-progress-gauge__svg');
    svg.setAttribute('viewBox', '0 0 100 100');

    // Background track circle
    const track = document.createElementNS(ns, 'circle');
    track.setAttribute('cx', '50');
    track.setAttribute('cy', '50');
    track.setAttribute('r', '40');
    track.setAttribute('class', 'krypton-progress-gauge__track');

    // Progress fill arc
    const fill = document.createElementNS(ns, 'circle');
    fill.setAttribute('cx', '50');
    fill.setAttribute('cy', '50');
    fill.setAttribute('r', '40');
    fill.setAttribute('class', 'krypton-progress-gauge__fill');
    fill.setAttribute('stroke-dasharray', `0 ${Compositor.GAUGE_CIRCUMFERENCE}`);
    fill.setAttribute('transform', 'rotate(-90 50 50)');

    // Large percentage text
    const pct = document.createElementNS(ns, 'text');
    pct.setAttribute('x', '50');
    pct.setAttribute('y', '47');
    pct.setAttribute('class', 'krypton-progress-gauge__pct');
    pct.textContent = '';

    // Status label text
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', '50');
    label.setAttribute('y', '60');
    label.setAttribute('class', 'krypton-progress-gauge__label');
    label.textContent = '';

    svg.appendChild(track);
    svg.appendChild(fill);
    svg.appendChild(pct);
    svg.appendChild(label);
    gauge.appendChild(svg);
    return gauge;
  }

  /**
   * Remove the background gauge and titlebar sweep from a window.
   */
  private removeProgressGauge(
    contentEl: Element,
    titlebar: Element,
  ): void {
    const gauge = contentEl.querySelector('.krypton-progress-gauge');
    if (gauge) gauge.remove();

    titlebar.classList.remove(
      'krypton-window__titlebar--progress',
      'krypton-window__titlebar--progress-error',
      'krypton-window__titlebar--progress-paused',
    );
  }

  // ─── SSH Session Multiplexing ─────────────────────────────────────

  /**
   * Probe the remote CWD by injecting a command into the active PTY.
   *
   * The probe output is embedded inside a private-use OSC escape
   * sequence (OSC 7337) that xterm.js silently discards — the printf
   * output itself is completely invisible to the user.
   *
   * To hide the *command echo* (the shell repeating what we typed),
   * we wrap the payload in a compound command that:
   *   1. Saves the cursor position  (ESC 7)
   *   2. Turns off terminal echo    (stty -echo)
   *   3. Runs the printf            (produces the invisible OSC)
   *   4. Restores echo              (stty echo)
   *   5. Restores the cursor        (ESC 8) and erases the line
   *
   * Because `stty -echo` is set before the newline is echoed back
   * by the remote TTY driver, and cursor save/restore brackets the
   * whole thing, the terminal buffer is left untouched.
   *
   * Falls back to `null` if no response arrives within the timeout.
   */
  private probeRemoteCwd(sessionId: number): Promise<string | null> {
    const marker = `__KR_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}__`;
    const TIMEOUT_MS = 3000;

    // What we look for in the raw pty-output stream.
    // The printf will emit: ESC ] 7337 ; <marker> ; <cwd> BEL
    const oscStart = `\x1b]7337;${marker};`;
    const oscEnd = '\x07';

    return new Promise((resolve) => {
      let settled = false;
      let buffer = '';

      // eslint-disable-next-line prefer-const
      let unlisten: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (unlisten) unlisten();
      };

      const finish = (cwd: string | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(cwd);
      };

      timer = setTimeout(() => finish(null), TIMEOUT_MS);

      // Listen for the OSC response in raw pty-output
      listen<[number, number[]]>('pty-output', (event) => {
        const [sid, data] = event.payload;
        if (sid !== sessionId || settled) return;

        buffer += new TextDecoder().decode(new Uint8Array(data));

        const si = buffer.indexOf(oscStart);
        if (si === -1) return;
        const payloadStart = si + oscStart.length;
        const ei = buffer.indexOf(oscEnd, payloadStart);
        if (ei === -1) return;

        const cwd = buffer.slice(payloadStart, ei).trim();
        finish(cwd || null);
      }).then((fn) => {
        if (settled) {
          fn();
        } else {
          unlisten = fn;
        }
      });

      // Inject the probe command.
      //
      // The command we send (as keystrokes into the PTY):
      //   <CR><ESC[2K> — move to column 0, erase the current line
      //                   (wipes the visible prompt so our command
      //                    doesn't appear next to stale text)
      //   <space>      — leading space: most shells skip history
      //   stty -echo;  — disable TTY echo so the command + output
      //                   are not displayed
      //   printf '\033]7337;<marker>;%s\007' "$(pwd)";
      //                — emit the CWD inside an invisible OSC sequence
      //   stty echo    — re-enable TTY echo
      //   <\n>         — execute the compound command
      //
      // After execution the shell prints a fresh prompt.  Because
      // echo was off during execution, neither the command text
      // nor the printf output were visible.  The fresh prompt
      // naturally replaces the erased line.
      const cmd = [
        '\r\x1b[2K',                                                    // CR + erase line
        ` stty -echo; printf '\\033]7337;${marker};%s\\007' "$(pwd)";`, // probe (no echo)
        ' stty echo\n',                                                  // restore echo + exec
      ].join('');

      const encoded = new TextEncoder().encode(cmd);
      invoke('write_to_pty', { sessionId, data: Array.from(encoded) })
        .catch(() => finish(null));
    });
  }

  /**
   * Clone the SSH session from the focused pane into a new tab.
   * Detects the active SSH connection and spawns a new PTY that
   * piggybacks on the same connection via ControlMaster.
   */
  async cloneSshSession(): Promise<void> {
    const sessionId = this.getFocusedSessionId();
    if (sessionId === null) return;

    const win = this.focusedWindowId ? this.windows.get(this.focusedWindowId) : null;
    if (!win) return;

    try {
      // Detect SSH connection in the current terminal
      const info = await invoke<SshConnectionInfo | null>('detect_ssh_session', { sessionId });
      if (!info) {
        this.showNotification('No SSH session detected in focused terminal');
        return;
      }

      // Probe the remote CWD from the live SSH shell before we switch tabs.
      // This injects a command into the existing PTY and captures the output.
      const remoteCwd = await this.probeRemoteCwd(sessionId);

      // Create a new tab in the current window
      const tabId = nextTabId();

      // Detach current tab's pane tree from DOM
      while (win.contentElement.firstChild) {
        win.contentElement.removeChild(win.contentElement.firstChild);
      }

      const pane = this.createPane(win.contentElement);

      const tabEl = document.createElement('div');
      tabEl.className = 'krypton-tab';
      tabEl.dataset.tabId = tabId;
      const titleSpan = document.createElement('span');
      titleSpan.className = 'krypton-tab__title';
      titleSpan.textContent = `SSH ${info.user}@${info.host}`;
      tabEl.appendChild(titleSpan);

      const tab: Tab = {
        id: tabId,
        title: `SSH ${info.user}@${info.host}`,
        paneTree: { type: 'leaf', pane },
        focusedPaneId: pane.id,
        element: tabEl,
      };

      win.tabs.push(tab);
      win.activeTabIndex = win.tabs.length - 1;
      this.rebuildTabBar(win);
      this.showActiveTab(win);

      await this.nextFrame();
      this.fitWindow(win.id);

      // Spawn cloned SSH PTY with the probed remote CWD
      const newSessionId = await invoke<number>('clone_ssh_session', {
        sessionId,
        cols: pane.terminal.cols,
        rows: pane.terminal.rows,
        remoteCwd,
      });
      pane.sessionId = newSessionId;
      this.sessionMap.set(newSessionId, { windowId: win.id, tabId, paneId: pane.id });
      this.wirePaneInput(pane);

      // Update titlebar
      const ptyStatus = this.findPtyStatus(win.element);
      if (ptyStatus) {
        ptyStatus.textContent = `SSH: ${info.user}@${info.host}`;
      }

      pane.terminal.onTitleChange((title: string) => {
        if (title) {
          tab.title = title;
          titleSpan.textContent = title;
        }
      });

      pane.terminal.focus();
      this.sound.play('tab.create');
    } catch (e) {
      console.error('Failed to clone SSH session:', e);
      this.showNotification(`SSH clone failed: ${e}`);
    }
  }

  /**
   * Clone the SSH session from the focused pane into a new window.
   */
  async cloneSshSessionToNewWindow(): Promise<void> {
    const sessionId = this.getFocusedSessionId();
    if (sessionId === null) return;

    try {
      // Detect SSH connection
      const info = await invoke<SshConnectionInfo | null>('detect_ssh_session', { sessionId });
      if (!info) {
        this.showNotification('No SSH session detected in focused terminal');
        return;
      }

      // Probe the remote CWD from the live SSH shell before spawning
      const remoteCwd = await this.probeRemoteCwd(sessionId);

      // Create a new window (reuses createWindow's DOM setup)
      const newWindowId = await this.createWindow();
      const win = this.windows.get(newWindowId);
      if (!win) return;

      // Get the pane that was just created
      const activeTab = win.tabs[win.activeTabIndex];
      if (!activeTab) return;
      const pane = activeTab.paneTree.type === 'leaf' ? activeTab.paneTree.pane : null;
      if (!pane || pane.sessionId === null) return;

      // The createWindow already spawned a shell PTY — we need to replace it
      // with a cloned SSH session. Remove the old session from the map.
      const oldSessionId = pane.sessionId;
      this.sessionMap.delete(oldSessionId);

      // Spawn cloned SSH PTY with the probed remote CWD
      const newSessionId = await invoke<number>('clone_ssh_session', {
        sessionId,
        cols: pane.terminal.cols,
        rows: pane.terminal.rows,
        remoteCwd,
      });
      pane.sessionId = newSessionId;
      this.sessionMap.set(newSessionId, {
        windowId: newWindowId,
        tabId: activeTab.id,
        paneId: pane.id,
      });

      // Update titlebar to show SSH info
      const ptyStatus = this.findPtyStatus(win.element);
      if (ptyStatus) {
        ptyStatus.textContent = `SSH: ${info.user}@${info.host}`;
      }
      const label = this.findLabel(win.element);
      if (label) {
        label.textContent = `ssh_${info.host}`;
      }

      // Update tab title
      activeTab.title = `SSH ${info.user}@${info.host}`;
      const titleSpan = activeTab.element.querySelector('.krypton-tab__title');
      if (titleSpan) {
        titleSpan.textContent = activeTab.title;
      }
    } catch (e) {
      console.error('Failed to clone SSH session to new window:', e);
      this.showNotification(`SSH clone failed: ${e}`);
    }
  }

  /**
   * Show a brief notification toast. Falls through silently if the method
   * is not yet implemented (notifications are a nice-to-have).
   */
  private showNotification(message: string): void {
    console.warn(`[krypton:ssh] ${message}`);
    // Create a simple toast notification
    const toast = document.createElement('div');
    toast.className = 'krypton-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%);
      padding: 8px 20px; border-radius: 6px; z-index: 9999;
      font-family: var(--krypton-font-family, monospace);
      font-size: 13px; color: var(--krypton-ui-text, #c0c5ce);
      background: var(--krypton-ui-bg, rgba(30, 40, 50, 0.95));
      border: 1px solid var(--krypton-chrome-border, rgba(0, 255, 255, 0.3));
      pointer-events: none; opacity: 0; transition: opacity 0.2s ease;
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 2500);
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
