// Krypton — Compositor
// Manages terminal windows: creation, destruction, layout, focus, resize, move.

import { invoke } from './profiler/ipc';
import { collector } from './profiler/metrics';
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
  ContentView,
  PaneContentType,
  QuickTerminalAnimation,
  QuickTerminalConfig,
  DEFAULT_QUICK_TERMINAL_CONFIG,
  Tab,
  Pane,
  PaneNode,
  SplitDirection,
  type ProgressEvent,
  type PaneProgress,
  type ProcessChangedEvent,
  type ProcessInfo,
  type ProcessCandidate,
} from './types';
import { autoTile, focusTile, resolveGridSlot } from './layout';
import { AnimationEngine, BoundsSnapshot } from './animation';
import { SoundEngine } from './sound';
import { ShaderEngine } from './shaders';
import type { ShaderPreset } from './shaders';
import type { KryptonConfig, TabsConfig, ShaderConfig } from './config';
import { DEFAULT_SHADER_CONFIG, loadConfig } from './config';
import type { FrontendThemeEngine } from './theme';
import { ExtensionManager } from './extensions';
import type { ExtensionHost } from './extensions';
import { DashboardManager } from './dashboard';
import type { ClaudeHookManager } from './claude-hooks';
import type { NotificationController } from './notification';
import { installPerspectiveMouseFix } from './perspective-fix';
import { ProgressGauge } from './progress-gauge';
import { probeRemoteCwd, type SshConnectionInfo } from './ssh-session';

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
  /** ID of the dedicated AI agent window (at most one at a time) */
  private workspace: HTMLElement;
  private onFocusChangeCallbacks: Array<(id: WindowId | null) => void> = [];
  private onRelayoutCallbacks: Array<() => void> = [];
  private customKeyHandler: CustomKeyHandler | null = null;
  private layoutMode: LayoutMode = LayoutMode.Focus;
  /** Visual order of window IDs after the last Focus layout relayout.
   *  Index 0 = left (main) column, 1..N = top-to-bottom right stack. */
  private focusVisualOrder: WindowId[] = [];
  /** Ordered list of window IDs from front (index 0) to back in Depth layout. */
  private depthOrder: WindowId[] = [];
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

  // ─── Notification Controller ────────────────────────────────────
  private notifController: NotificationController | null = null;

  // ─── Claude Hook Manager ────────────────────────────────────────
  private claudeHookManager: ClaudeHookManager | null = null;
  private hookToastsEnabled: boolean = false;
  private pendingHookAnimation: string | null = null;
  private pendingMaxToasts: number | null = null;

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
  private progressGauge!: ProgressGauge;

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

  /** Profiler HUD overlay (lazy-created on first toggle) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private profilerHud: any = null;

  /** Active inline AI overlay (at most one) */
  private inlineAI: import('./inline-ai').InlineAIOverlay | null = null;

  /** Latest foreground process per session, populated from process-changed events.
   *  Used by findSessionsByProcess() for the Smart Prompt Dialog. */
  private processBySession: Map<SessionId, ProcessInfo> = new Map();

  /** Callbacks invoked after config reload with the fresh config */
  private onConfigReloadCallbacks: Array<(config: KryptonConfig) => void> = [];

  constructor(workspace: HTMLElement) {
    this.workspace = workspace;
    this.progressGauge = new ProgressGauge({
      getWindowElement: (windowId) => this.windows.get(windowId)?.element ?? null,
      getQuickTerminalElement: () => this.qtElement,
      getWindowDisplayProgress: (windowId) => this.getWindowDisplayProgress(windowId),
    });
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

    // Track foreground process per session for Smart Prompt Dialog targeting
    void listen<ProcessChangedEvent>('process-changed', (event) => {
      const { session_id, process } = event.payload;
      if (process) {
        this.processBySession.set(session_id, process);
      } else {
        this.processBySession.delete(session_id);
      }
    });
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
    document.documentElement.style.setProperty(
      '--krypton-font-family',
      this.fontFamily
    );
    document.documentElement.style.setProperty(
      '--krypton-font-size',
      `${this.fontSize}px`
    );
    document.documentElement.style.setProperty(
      '--krypton-chrome-font-size',
      `${Math.round(this.fontSize * 0.786)}px`
    );
    document.documentElement.style.setProperty(
      '--krypton-line-height',
      `${this.lineHeight}`
    );
    document.documentElement.style.setProperty(
      '--krypton-content-line-height',
      `${this.lineHeight}`
    );
    document.documentElement.style.setProperty(
      '--krypton-prose-line-height',
      `${this.lineHeight}`
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
    const qtAnim = config.quick_terminal.animation;
    const validAnims = ['slide', 'float', 'fade', 'glitch', 'none'] as const;
    this.qtConfig = {
      widthRatio: config.quick_terminal.width_ratio,
      heightRatio: config.quick_terminal.height_ratio,
      backdropBlur: config.quick_terminal.backdrop_blur,
      animationDuration: 200, // not yet in TOML, keep default
      animation: validAnims.includes(qtAnim as any) ? qtAnim as QuickTerminalAnimation : 'slide',
    };

    // Workspaces
    this.windowGap = config.workspaces.gap;
    this.stepSize = config.workspaces.resize_step;

    // Default layout mode
    const layoutStr = config.workspaces.default_layout?.toLowerCase();
    if (layoutStr === 'grid') {
      this.layoutMode = LayoutMode.Grid;
    } else if (layoutStr === 'depth') {
      this.layoutMode = LayoutMode.Depth;
    } else {
      this.layoutMode = LayoutMode.Focus;
    }

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

    // Hooks — toggle toast display, max visible toasts, animation type
    if (config.hooks) {
      this.hookToastsEnabled = config.hooks.show_toasts;
      if (config.hooks.animation) {
        this.pendingHookAnimation = config.hooks.animation;
      }
      this.pendingMaxToasts = config.hooks.max_toasts;
      if (this.claudeHookManager) {
        this.claudeHookManager.setToastsEnabled(this.hookToastsEnabled);
        this.claudeHookManager.setMaxToasts(config.hooks.max_toasts);
        if (this.pendingHookAnimation) {
          this.claudeHookManager.setAnimationType(this.pendingHookAnimation);
          this.pendingHookAnimation = null;
        }
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

  /** Reload config and theme from the backend and re-apply everything.
   *  Called by the command palette "Reload Config" action. */
  async reloadConfig(): Promise<void> {
    // Tell the backend to re-read the TOML file. On parse error the backend
    // leaves the user's file untouched and returns the error message — show
    // it so the user can fix it manually.
    try {
      await invoke('reload_config');
    } catch (e) {
      this.showNotification(`Config error (file NOT modified): ${e}`);
      return;
    }

    // Fetch the updated config and theme
    const config = await loadConfig();
    this.applyConfig(config);

    // Reload theme (triggers onChange → updateTerminalThemes)
    if (this.themeEngine) {
      await this.themeEngine.reload();
    }

    // Re-apply config opacity after theme reload (theme sets its own alpha)
    this.applyConfig(config);

    // Notify external consumers (e.g. MusicPlayer) of the updated config
    for (const cb of this.onConfigReloadCallbacks) {
      cb(config);
    }

    console.log('[Krypton] Config reloaded via command palette');
  }

  /** Register a callback to be invoked after config reload with the fresh config. */
  onConfigReload(cb: (config: KryptonConfig) => void): void {
    this.onConfigReloadCallbacks.push(cb);
  }

  // ─── Pane Tree Helpers ──────────────────────────────────────────

  /** Create a persistent wrapper for a tab's pane tree content.
   *  The wrapper stays in the DOM and is shown/hidden via CSS class toggle,
   *  avoiding expensive DOM detach/reattach on tab switch. */
  private createTabWrapper(contentEl: HTMLElement): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'krypton-tab-wrapper';
    contentEl.appendChild(wrapper);
    return wrapper;
  }

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

    // Register OSC notification handlers (OSC 9/777/99)
    if (this.notifController) {
      this.notifController.registerOscHandlers(terminal);
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

    return { id: paneId, sessionId: null, terminal, fitAddon, element: el, shaderInstance, contentView: null };
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
    if (!pane.terminal) return;
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
    if (!pane.terminal) return;
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
        if (pane && pane.fitAddon && pane.terminal) {
          pane.fitAddon.fit();
          this.syncTerminalCellHeight(pane.terminal);
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
  /** Get the content type of the focused pane (null = terminal). */
  getFocusedContentType(): PaneContentType | null {
    const pane = this.getFocusedPane();
    return pane?.contentView?.type ?? null;
  }

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
      if (node.pane.contentView) {
        node.pane.contentView.dispose();
      }
      if (node.pane.terminal) {
        node.pane.terminal.dispose();
      }
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
      if (pane.contentView) {
        pane.contentView.onResize?.(pane.element.clientWidth, pane.element.clientHeight);
      } else if (pane.fitAddon && pane.terminal) {
        pane.fitAddon.fit();
        this.syncTerminalCellHeight(pane.terminal);
        if (pane.sessionId !== null) {
          invoke('resize_pty', {
            sessionId: pane.sessionId,
            cols: pane.terminal.cols,
            rows: pane.terminal.rows,
          }).catch((e: unknown) => console.error('Resize PTY failed:', e));
        }
      }
    } else {
      this.fitPaneTree(node.first);
      this.fitPaneTree(node.second);
    }
  }

  /** Sync --krypton-terminal-cell-height from actual xterm rendering.
   *  fontSize * lineHeight underestimates real cell height because xterm measures
   *  actual font bounding boxes via canvas — this reads the ground truth. */
  private syncTerminalCellHeight(terminal: Terminal): void {
    const screenEl = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screenEl || terminal.rows === 0) return;
    const cellHeight = screenEl.clientHeight / terminal.rows;
    if (cellHeight > 0) {
      document.documentElement.style.setProperty('--krypton-terminal-cell-height', `${cellHeight}px`);
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

  /** Switch the visible tab content for a window.
   *  Uses CSS visibility toggle instead of DOM detach/reattach to avoid
   *  expensive reflow — critical for agent views with large chat histories. */
  private showActiveTab(win: KryptonWindow): void {
    const activeTab = win.tabs[win.activeTabIndex];
    if (!activeTab) return;

    for (const tab of win.tabs) {
      // Ensure wrapper exists and is mounted
      if (!tab.contentWrapperEl) {
        tab.contentWrapperEl = this.createTabWrapper(win.contentElement);
        this.buildPaneTreeDom(tab.paneTree, tab.contentWrapperEl);
      } else if (!tab.contentWrapperEl.parentElement) {
        win.contentElement.appendChild(tab.contentWrapperEl);
        // Re-mount pane tree if wrapper was detached (e.g. after tab close cleanup)
        if (tab.contentWrapperEl.children.length === 0) {
          this.buildPaneTreeDom(tab.paneTree, tab.contentWrapperEl);
        }
      }

      // Toggle visibility
      tab.contentWrapperEl.classList.toggle(
        'krypton-tab-wrapper--hidden',
        tab !== activeTab,
      );
    }
  }

  /** Remove pane-tree elements from a content area, keeping HUD overlays */
  private clearPaneTree(contentEl: HTMLElement): void {
    const toRemove: Element[] = [];
    for (const child of Array.from(contentEl.children)) {
      const cl = child.classList;
      if (!cl.contains('krypton-flame-canvas') &&
          !cl.contains('krypton-brainwave-canvas') &&
          !cl.contains('krypton-matrix-canvas') &&
          !cl.contains('krypton-circuit-trace-canvas') &&
          !cl.contains('krypton-uplink') &&
          !cl.contains('krypton-activity-trace')) {
        toRemove.push(child);
      }
    }
    for (const el of toRemove) el.remove();
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
          if (pane.terminal) pane.terminal.options.theme = xtermTheme;
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
    // Apply settings that were configured before the manager existed
    manager.setToastsEnabled(this.hookToastsEnabled);
    if (this.pendingMaxToasts !== null) {
      manager.setMaxToasts(this.pendingMaxToasts);
      this.pendingMaxToasts = null;
    }
    if (this.pendingHookAnimation) {
      manager.setAnimationType(this.pendingHookAnimation);
      this.pendingHookAnimation = null;
    }
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

  /** Get the content element of the focused window (for overlay layers like visualizer) */
  getFocusedContentElement(): HTMLElement | null {
    if (!this.focusedWindowId) return null;
    const win = this.windows.get(this.focusedWindowId);
    return win?.contentElement ?? null;
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

  /** Set the notification controller (called from main.ts).
   *  Wires focus-change to move the control into the active window. */
  setNotificationController(ctrl: NotificationController): void {
    this.notifController = ctrl;
    this.onFocusChange((id) => {
      if (!id) return;
      const win = this.windows.get(id);
      if (win) {
        ctrl.attachTo(win.element);
      }
    });
  }

  /** Get the notification controller */
  get notifications(): NotificationController | null {
    return this.notifController;
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

  /** Register callback invoked after window relayout (for resizing overlays) */
  onRelayout(cb: () => void): void {
    this.onRelayoutCallbacks.push(cb);
  }

  /** Set custom key event handler for all terminals (called by InputRouter) */
  setCustomKeyHandler(handler: CustomKeyHandler): void {
    this.customKeyHandler = handler;
    // Attach to all panes in all tabs in all windows
    for (const [, win] of this.windows) {
      for (const tab of win.tabs) {
        for (const pane of this.collectPanes(tab.paneTree)) {
          if (pane.terminal) pane.terminal.attachCustomKeyEventHandler(handler);
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
    if (!pane) return null;

    // If the pane has a PTY session, ask the backend for its cwd
    if (pane.sessionId !== null) {
      try {
        return await invoke<string | null>('get_pty_cwd', {
          sessionId: pane.sessionId,
        });
      } catch {
        return null;
      }
    }

    // Content view (e.g. AI agent) — use its project directory
    return pane.contentView?.getWorkingDirectory?.() ?? null;
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
      const animCanvas = this.claudeHookManager.createAnimationCanvas();
      if (animCanvas) content.appendChild(animCanvas);
      content.appendChild(this.claudeHookManager.createUplinkBar());
      content.appendChild(this.claudeHookManager.createActivityTrace());
    }

    // 3D perspective wrapper — isolates the 3D context from backdrop-filter
    const perspectiveWrap = document.createElement('div');
    perspectiveWrap.className = 'krypton-window__perspective';
    perspectiveWrap.appendChild(content);

    // Footer bar (notification area)
    const footer = document.createElement('div');
    footer.className = 'krypton-window__footer';

    el.appendChild(chrome);
    el.appendChild(tabBar);
    el.appendChild(perspectiveWrap);
    el.appendChild(footer);
    this.workspace.appendChild(el);

    // Fix mouse coordinates under perspective tilt
    installPerspectiveMouseFix(content);

    // Create first tab with a single pane
    const wrapper = this.createTabWrapper(content);
    const pane = this.createPane(wrapper);
    const tabId = nextTabId();
    const tabEl = this.buildTabElement(tabId, 0, 'Shell 1');
    tabBar.appendChild(tabEl);

    const tab: Tab = {
      id: tabId,
      title: 'Shell 1',
      paneTree: { type: 'leaf', pane },
      focusedPaneId: pane.id,
      element: tabEl,
      contentWrapperEl: wrapper,
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
    pane.terminal!.onTitleChange((title: string) => {
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

  /**
   * Create a non-terminal window with a ContentView (e.g., diff view).
   * Uses the same chrome as regular windows but skips PTY/terminal setup.
   */
  async createContentWindow(title: string, contentView: ContentView): Promise<WindowId> {
    if (this.maximizedWindowId) {
      this.maximizedWindowId = null;
      this.showAllWindows();
    }

    const id = nextWindowId();
    const el = document.createElement('div');
    el.id = id;
    el.className = 'krypton-window';
    el.dataset.windowId = id;
    el.dataset.contentType = contentView.type;

    const accentColor = this.allocateAccentColor(id);
    this.applyAccentColor(el, accentColor);

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
    label.textContent = title;

    labelGroup.appendChild(statusDot);
    labelGroup.appendChild(label);

    const ptyStatus = document.createElement('span');
    ptyStatus.className = 'krypton-window__pty-status';
    ptyStatus.textContent = contentView.type.toUpperCase();

    titlebar.appendChild(labelGroup);
    titlebar.appendChild(ptyStatus);
    chrome.appendChild(titlebar);

    const headerAccent = document.createElement('div');
    headerAccent.className = 'krypton-window__header-accent';
    chrome.appendChild(headerAccent);

    const tabBar = document.createElement('div');
    tabBar.className = 'krypton-window__tabbar';

    const content = document.createElement('div');
    content.className = 'krypton-window__content';

    for (const pos of ['tl', 'tr', 'bl', 'br']) {
      const corner = document.createElement('div');
      corner.className = `krypton-window__corner krypton-window__corner--${pos}`;
      el.appendChild(corner);
    }

    const perspectiveWrap = document.createElement('div');
    perspectiveWrap.className = 'krypton-window__perspective';
    perspectiveWrap.appendChild(content);

    const footer = document.createElement('div');
    footer.className = 'krypton-window__footer';

    el.appendChild(chrome);
    el.appendChild(tabBar);
    el.appendChild(perspectiveWrap);
    el.appendChild(footer);
    this.workspace.appendChild(el);

    // Create pane with content view (no terminal/PTY)
    const cvWrapper = this.createTabWrapper(content);
    const paneId = nextPaneId();
    const paneEl = document.createElement('div');
    paneEl.className = 'krypton-pane';
    paneEl.dataset.paneId = paneId;
    cvWrapper.appendChild(paneEl);

    // Mount the content view into the pane
    paneEl.appendChild(contentView.element);

    // Edge glow overlays — match terminal pane glow
    const glowTop = document.createElement('div');
    glowTop.className = 'krypton-glow-overlay';
    paneEl.appendChild(glowTop);

    const glowBottom = document.createElement('div');
    glowBottom.className = 'krypton-glow-overlay krypton-glow-overlay--bottom';
    paneEl.appendChild(glowBottom);

    const pane: Pane = {
      id: paneId,
      sessionId: null,
      terminal: null,
      fitAddon: null,
      element: paneEl,
      shaderInstance: null,
      contentView,
    };

    const tabId = nextTabId();
    const tabEl = this.buildTabElement(tabId, 0, title);
    tabBar.appendChild(tabEl);

    const tab: Tab = {
      id: tabId,
      title,
      paneTree: { type: 'leaf', pane },
      focusedPaneId: pane.id,
      element: tabEl,
      contentWrapperEl: cvWrapper,
    };

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

    this.focusWindowQuiet(id);
    const snapshots = this.snapshotBounds();
    this.relayout();
    await this.nextFrame();
    this.fitAll();

    this.animation.entrance(el);
    this.animateRelayout(snapshots.filter((s) => s.id !== id));
    this.sound.play('window.create');

    // Focus the content view
    contentView.element.focus();

    el.addEventListener('mousedown', () => {
      this.focusWindow(id);
    });

    return id;
  }

  /** Check whether the given directory is inside a git repository. */
  private async isGitRepo(cwd: string | null): Promise<boolean> {
    if (!cwd) return false;
    try {
      await invoke<string>('run_command', {
        program: 'git',
        args: ['rev-parse', '--git-dir'],
        cwd,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Open a diff view window showing git diff output from the focused terminal's CWD.
   */
  async openDiffView(options?: { staged?: boolean }): Promise<void> {
    const cwd = await this.getFocusedCwd();
    if (!await this.isGitRepo(cwd)) {
      this.showNotification('Not a git repository — diff view unavailable');
      return;
    }
    const args = ['diff', '-M'];
    if (options?.staged) args.push('--staged');

    let diffOutput: string;
    try {
      diffOutput = await invoke<string>('run_command', {
        program: 'git',
        args,
        cwd,
      });
    } catch (e) {
      console.error('Failed to run git diff:', e);
      return;
    }

    const { DiffContentView } = await import('./diff-view');
    const container = document.createElement('div');
    container.style.cssText = 'width:100%;height:100%;overflow:hidden;';

    const diffView = new DiffContentView(diffOutput, container);

    const fileCount = diffView['files'].length;
    const titleText = options?.staged
      ? `DIFF_STAGED // ${fileCount} file${fileCount !== 1 ? 's' : ''}`
      : `DIFF // ${fileCount} file${fileCount !== 1 ? 's' : ''}`;

    await this.createContentTab(titleText, diffView);

    // Wire close callback to close the tab
    diffView.onClose(() => {
      this.closeTab();
    });
  }

  /**
   * Open a markdown viewer window listing .md files from the focused terminal's CWD.
   */
  async openMarkdownView(): Promise<void> {
    const cwd = await this.getFocusedCwd() ?? undefined;
    if (!await this.isGitRepo(cwd ?? null)) {
      this.showNotification('Not a git repository — markdown viewer unavailable');
      return;
    }

    const { listMarkdownFiles, MarkdownContentView } = await import('./markdown-view');
    const files = await listMarkdownFiles(cwd ?? '.');
    if (files.length === 0) {
      console.error('No markdown files found');
    }

    const container = document.createElement('div');
    container.style.cssText = 'width:100%;height:100%;overflow:hidden;';

    const mdView = new MarkdownContentView(files, cwd ?? '.', container);

    // Use the last path component of CWD as title
    const dirName = (cwd ?? '.').split('/').filter(Boolean).pop() ?? 'docs';
    await this.createContentTab(`MD // ${dirName}`, mdView);

    mdView.onClose(() => {
      this.closeTab();
    });
  }

  /**
   * Open a keyboard-driven file manager in a new tab.
   * Starts in the focused terminal's CWD.
   */
  async openFileManager(): Promise<void> {
    const cwd = await this.getFocusedCwd() ?? '/';

    const { FileManagerView } = await import('./file-manager');
    const container = document.createElement('div');
    container.style.cssText = 'width:100%;height:100%;overflow:hidden;';

    const fm = new FileManagerView(cwd, container);

    // Derive a short title from the CWD
    const dirName = cwd.split('/').filter(Boolean).pop() ?? '/';
    await this.createContentTab(`FILE // ${dirName}`, fm);

    fm.onClose(() => {
      this.closeTab();
    });
  }

  /**
   * Open an Obsidian vault viewer window.
   */
  async openVault(vaultPath?: string): Promise<void> {
    const entries = await this.getVaultEntries();

    let path = vaultPath;

    if (!path) {
      if (entries.length === 0) {
        this.showNotification('No vault path configured — set [vault] path in krypton.toml');
        return;
      }
      if (entries.length === 1) {
        path = entries[0].path;
      } else {
        // Show picker — open the vault view with the first entry but pop
        // the picker immediately so the user can pick.
        const pick = await this.pickVault(entries);
        if (!pick) return;
        path = pick;
      }
    }

    path = await this.expandVaultPath(path);

    const { VaultContentView } = await import('./vault-view');
    const container = document.createElement('div');
    container.style.cssText = 'width:100%;height:100%;overflow:hidden;';

    const vaultView = new VaultContentView(path, container);
    vaultView.setVaultSwitcher(
      () => this.getVaultEntries(),
      (p: string) => this.expandVaultPath(p),
    );

    const dirName = path.split('/').filter(Boolean).pop() ?? 'vault';
    await this.createContentTab(`VAULT // ${dirName}`, vaultView);

    vaultView.onTitleChange((newName) => this.retitleFocusedTab(`VAULT // ${newName}`));

    vaultView.onClose(() => {
      this.closeTab();
    });
  }

  /**
   * Resolve the configured vault list, merging the legacy single `path` entry
   * with the named `vaults` array. Duplicates (by path) are collapsed.
   */
  async getVaultEntries(): Promise<Array<{ name: string; path: string }>> {
    type VaultCfg = { path?: string; paths?: Array<{ name?: string; path?: string }> };
    let cfg: VaultCfg = {};
    try {
      const config = await invoke<{ vault?: VaultCfg }>('get_config');
      cfg = config.vault ?? {};
    } catch {
      // Config unavailable
    }

    const out: Array<{ name: string; path: string }> = [];
    const seen = new Set<string>();
    const push = (name: string, path: string): void => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      out.push({ name: name || path.split('/').filter(Boolean).pop() || path, path });
    };

    if (cfg.path) push(cfg.path.split('/').filter(Boolean).pop() ?? 'default', cfg.path);
    for (const v of cfg.paths ?? []) {
      if (v?.path) push(v.name ?? '', v.path);
    }
    return out;
  }

  /** Expand `~/` in a path to the user's home directory. */
  async expandVaultPath(path: string): Promise<string> {
    if (path.startsWith('~/')) {
      try {
        const home = await invoke<string>('get_env_var', { name: 'HOME' });
        if (home) return home + path.slice(1);
      } catch {
        // Keep path as-is
      }
    }
    return path;
  }

  /**
   * Show a transient overlay picker listing configured vaults.
   * Resolves with the selected path, or null if cancelled.
   */
  private pickVault(entries: Array<{ name: string; path: string }>): Promise<string | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'krypton-vault-picker-overlay';

      const panel = document.createElement('div');
      panel.className = 'krypton-vault-picker';

      const title = document.createElement('div');
      title.className = 'krypton-vault-picker__title';
      title.textContent = 'SELECT VAULT';
      panel.appendChild(title);

      const list = document.createElement('div');
      list.className = 'krypton-vault-picker__list';
      panel.appendChild(list);

      let selected = 0;
      const render = (): void => {
        list.innerHTML = '';
        entries.forEach((e, i) => {
          const row = document.createElement('div');
          row.className = 'krypton-vault-picker__item';
          if (i === selected) row.classList.add('krypton-vault-picker__item--selected');

          const name = document.createElement('span');
          name.className = 'krypton-vault-picker__name';
          name.textContent = e.name;
          const p = document.createElement('span');
          p.className = 'krypton-vault-picker__path';
          p.textContent = e.path;
          row.appendChild(name);
          row.appendChild(p);
          row.addEventListener('click', () => {
            cleanup();
            resolve(e.path);
          });
          list.appendChild(row);
        });
      };
      render();

      const hint = document.createElement('div');
      hint.className = 'krypton-vault-picker__hint';
      hint.textContent = 'j/k  select    Enter  open    Esc  cancel';
      panel.appendChild(hint);

      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      const cleanup = (): void => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
      };

      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          cleanup();
          resolve(null);
          return;
        }
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          const p = entries[selected]?.path ?? null;
          cleanup();
          resolve(p);
          return;
        }
        if (ev.key === 'j' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          ev.stopPropagation();
          selected = Math.min(selected + 1, entries.length - 1);
          render();
          return;
        }
        if (ev.key === 'k' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          ev.stopPropagation();
          selected = Math.max(selected - 1, 0);
          render();
          return;
        }
        const digit = Number.parseInt(ev.key, 10);
        if (!Number.isNaN(digit) && digit >= 1 && digit <= entries.length) {
          ev.preventDefault();
          ev.stopPropagation();
          cleanup();
          resolve(entries[digit - 1].path);
        }
      };
      document.addEventListener('keydown', onKey, true);

      // Expose for vault-view direct use
      (overlay as unknown as { __pickerResolve: typeof resolve }).__pickerResolve = resolve;
    });
  }

  /** Public API so VaultContentView can reuse the picker. */
  async pickVaultPath(): Promise<string | null> {
    const entries = await this.getVaultEntries();
    if (entries.length < 2) return null;
    return this.pickVault(entries);
  }

  /**
   * Open (or focus) the dedicated AI agent window.
   * At most one agent window exists at a time; subsequent calls focus the existing one.
   */
  async openAgentView(): Promise<void> {
    const { AgentView } = await import('./agent/agent-view');

    // Resolve CWD from focused terminal for per-project session and tool scoping
    const focusedPane = this.getFocusedPane();
    let projectDir: string | null = null;
    if (focusedPane?.sessionId !== null && focusedPane?.sessionId !== undefined) {
      try {
        projectDir = await invoke<string>('get_pty_cwd', { sessionId: focusedPane.sessionId });
      } catch {
        // CWD unavailable — fall back to no project scoping
      }
    }

    const agentView = new AgentView();
    agentView.setProjectDir(projectDir);
    agentView.onClose(() => this.closeTab());
    agentView.onOpenContext((ctrl) => this.openContextView(ctrl));
    agentView.onOpenDiff((diff, title) => this.openDiffFromString(diff, title));

    // Resolve active model preset name for the tab title
    let modelLabel = 'agent';
    try {
      const config = await invoke<{ agent?: { active?: string } }>('get_config');
      if (config?.agent?.active) modelLabel = config.agent.active;
    } catch { /* use fallback */ }

    await this.createContentTab(`AI  ${modelLabel}`, agentView);
  }

  // ─── Inline AI Overlay ──────────────────────────────────────────────

  /**
   * Open the inline AI overlay on the focused terminal window.
   * Returns true if opened, false if not possible (no terminal pane).
   */
  async openInlineAI(): Promise<boolean> {
    // Already open — just focus the input
    if (this.inlineAI) return true;

    const pane = this.getFocusedPane();
    if (!pane || pane.contentView) {
      // Not a terminal pane
      this.notifController?.show({ message: 'Inline AI requires a terminal pane', level: 'warning' });
      return false;
    }

    const win = this.focusedWindowId ? this.windows.get(this.focusedWindowId) : null;
    if (!win) return false;

    const { InlineAIOverlay } = await import('./inline-ai');
    const { AgentController } = await import('./agent/agent');

    // Use a lightweight, disposable controller — not the agent-pane one
    const controller = new AgentController();
    let projectDir: string | null = null;
    if (pane.sessionId !== null) {
      try {
        projectDir = await invoke<string>('get_pty_cwd', { sessionId: pane.sessionId });
      } catch { /* ignore */ }
    }
    controller.setProjectDir(projectDir);

    const overlay = new InlineAIOverlay(
      controller,
      (data: string) => this.writeToFocusedPty(data),
      () => this.closeInlineAI(),
      pane.sessionId,
    );

    this.inlineAI = overlay;
    overlay.open(win.contentElement);
    this.sound.play('mode.enter');
    return true;
  }

  /** Close the inline AI overlay and return focus to the terminal. */
  closeInlineAI(): void {
    if (this.inlineAI) {
      this.inlineAI.close();
      this.inlineAI = null;
      this.refocusTerminal();
    }
  }

  /** Whether the inline AI overlay is currently open */
  get isInlineAIOpen(): boolean {
    return this.inlineAI !== null;
  }

  /** Forward a keyboard event to the inline AI overlay. Returns true if consumed. */
  handleInlineAIKey(e: KeyboardEvent): boolean {
    return this.inlineAI?.onKeyDown(e) ?? false;
  }

  /** Toggle the profiler HUD overlay (non-modal, docked top-right). */
  async toggleProfilerHud(): Promise<void> {
    if (!this.profilerHud) {
      const { ProfilerHud } = await import('./profiler/profiler-hud');
      this.profilerHud = new ProfilerHud();
    }
    this.profilerHud.toggle();
  }

  /**
   * Open a dedicated context inspector window for an agent controller.
   * Subscribes to live state changes for real-time updates.
   */
  async openContextView(controller: import('./agent/agent').AgentController): Promise<void> {
    const { ContextView } = await import('./agent/context-view');
    const contextView = new ContextView(controller);
    contextView.onClose(() => this.closeTab());
    await this.createContentTab('CTX  agent', contextView);
  }

  /**
   * Open a diff view from a unified diff string (used by agent inline diff).
   */
  async openDiffFromString(unifiedDiff: string, title: string): Promise<void> {
    const { DiffContentView } = await import('./diff-view');
    const container = document.createElement('div');
    container.style.cssText = 'width:100%;height:100%;overflow:hidden;';
    const diffView = new DiffContentView(unifiedDiff, container);
    diffView.onClose(() => this.closeTab());
    await this.createContentTab(title, diffView);
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

    // Dispose flame animation for this window
    if (this.claudeHookManager) {
      const animCanvas = win.contentElement.querySelector('.krypton-flame-canvas, .krypton-brainwave-canvas, .krypton-matrix-canvas') as HTMLCanvasElement | null;
      if (animCanvas) {
        this.claudeHookManager.disposeAnimation(animCanvas);
      }
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
          pane.terminal?.focus();
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
    if ((this.layoutMode === LayoutMode.Focus || this.layoutMode === LayoutMode.Depth) && previousId !== id && this.windows.size > 1) {
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

  /** Get the currently focused pane (public accessor for input routing) */
  getFocusedPanePublic(): Pane | null {
    return this.getFocusedPane();
  }

  /** Read the current xterm.js selection from the focused terminal pane.
   *  Returns null if the focused pane isn't a terminal or the selection is empty. */
  getFocusedSelection(): string | null {
    const pane = this.getFocusedPane();
    if (!pane || !pane.terminal) return null;
    const text = pane.terminal.getSelection();
    return text.length > 0 ? text : null;
  }

  /** Enumerate every session whose current foreground process matches `name`.
   *  Returns rich per-session info (window, pid, title) for the Smart Prompt Dialog. */
  findSessionsByProcess(name: string): ProcessCandidate[] {
    const results: ProcessCandidate[] = [];
    for (const [sessionId, info] of this.processBySession) {
      if (info.name !== name) continue;
      const loc = this.sessionMap.get(sessionId);
      if (!loc) continue;
      const win = this.windows.get(loc.windowId);
      if (!win) continue;
      const tab = win.tabs.find((t) => t.id === loc.tabId);
      const windowTitle = tab?.title ?? win.id;
      results.push({ sessionId, windowId: win.id, windowTitle, pid: info.pid });
    }
    return results;
  }

  /** Briefly flash a window's chrome to confirm a prompt was delivered to it. */
  flashWindow(windowId: WindowId): void {
    const win = this.windows.get(windowId);
    if (!win) return;
    const el = win.element;
    el.classList.remove('krypton-window--flash');
    void el.offsetWidth;
    el.classList.add('krypton-window--flash');
    window.setTimeout(() => {
      el.classList.remove('krypton-window--flash');
    }, 400);
  }

  /** Get the workspace element — used by overlays that need to mount globally. */
  get workspaceElement(): HTMLElement {
    return this.workspace;
  }

  /** Refocus the terminal of the currently focused pane */
  refocusTerminal(): void {
    const pane = this.getFocusedPane();
    if (pane) {
      if (pane.contentView) {
        pane.contentView.element.focus();
      } else {
        pane.terminal?.focus();
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
    const pane = this.getFocusedPane();
    if (pane) {
      pane.terminal?.scrollPages(pages);
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

  /** Cycle layout modes: Grid → Focus → Depth → Grid */
  async toggleFocusLayout(): Promise<void> {
    this.sound.play('layout.toggle');
    const snapshots = this.snapshotBounds();
    const prev = this.layoutMode;

    // Cycle: Grid → Focus → Depth → Grid
    if (prev === LayoutMode.Grid) {
      this.layoutMode = LayoutMode.Focus;
    } else if (prev === LayoutMode.Focus) {
      this.layoutMode = LayoutMode.Depth;
    } else {
      this.layoutMode = LayoutMode.Grid;
    }

    // Clear depth styles when leaving Depth mode
    if (prev === LayoutMode.Depth) {
      this.clearDepthStyles();
    }

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

    // Create a new wrapper for this tab's pane tree
    const wrapper = this.createTabWrapper(win.contentElement);
    const pane = this.createPane(wrapper);

    const tabNum = win.tabs.length + 1;
    const tabEl = this.buildTabElement(tabId, tabNum - 1, `Shell ${tabNum}`);

    const tab: Tab = {
      id: tabId,
      title: `Shell ${tabNum}`,
      paneTree: { type: 'leaf', pane },
      focusedPaneId: pane.id,
      element: tabEl,
      contentWrapperEl: wrapper,
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
    pane.terminal?.onTitleChange((title: string) => {
      if (title) {
        tab.title = title;
        const titleEl = tab.element.querySelector('.krypton-tab__title');
        if (titleEl) titleEl.textContent = title;
      }
    });

    pane.terminal?.focus();
    this.sound.play('tab.create');
  }

  /** Rename the currently active tab in the focused window. */
  retitleFocusedTab(title: string): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win) return;
    const tab = win.tabs[win.activeTabIndex];
    if (!tab) return;
    tab.title = title;
    const titleEl = tab.element.querySelector('.krypton-tab__title');
    if (titleEl) titleEl.textContent = title;
  }

  /** Create a new tab with a content view in the focused window */
  async createContentTab(title: string, contentView: ContentView): Promise<void> {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win) return;

    const tabId = nextTabId();

    // Create wrapper and pane with content view (no terminal/PTY)
    const ctWrapper = this.createTabWrapper(win.contentElement);
    const paneId = nextPaneId();
    const paneEl = document.createElement('div');
    paneEl.className = 'krypton-pane';
    paneEl.dataset.paneId = paneId;
    ctWrapper.appendChild(paneEl);

    paneEl.appendChild(contentView.element);

    // Edge glow overlays — match terminal pane glow
    const ctGlowTop = document.createElement('div');
    ctGlowTop.className = 'krypton-glow-overlay';
    paneEl.appendChild(ctGlowTop);

    const ctGlowBottom = document.createElement('div');
    ctGlowBottom.className = 'krypton-glow-overlay krypton-glow-overlay--bottom';
    paneEl.appendChild(ctGlowBottom);

    const pane: Pane = {
      id: paneId,
      sessionId: null,
      terminal: null,
      fitAddon: null,
      element: paneEl,
      shaderInstance: null,
      contentView,
    };

    const tabNum = win.tabs.length + 1;
    const tabEl = this.buildTabElement(tabId, tabNum - 1, title);

    const tab: Tab = {
      id: tabId,
      title,
      paneTree: { type: 'leaf', pane },
      focusedPaneId: pane.id,
      element: tabEl,
      contentWrapperEl: ctWrapper,
    };

    win.tabs.push(tab);
    win.activeTabIndex = win.tabs.length - 1;
    this.rebuildTabBar(win);
    this.showActiveTab(win);

    await this.nextFrame();
    this.fitWindow(win.id);

    contentView.element.focus();
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
    // Remove the tab's persistent wrapper from DOM
    tab.contentWrapperEl?.remove();
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
      if (pane?.contentView) {
        pane.contentView.element.focus();
      } else if (pane?.terminal) {
        pane.terminal.focus();
      }
    }
  }

  /** Switch to the previous or next tab in the focused window */
  switchTab(direction: -1 | 1): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.tabs.length <= 1) return;

    win.activeTabIndex = (win.activeTabIndex + direction + win.tabs.length) % win.tabs.length;
    this.updateTabBar(win);
    this.showActiveTab(win);

    const tab = win.tabs[win.activeTabIndex];
    const pane = this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
    if (pane) pane.terminal?.focus();

    // Tab wrappers stay mounted (CSS visibility toggle, no DOM detach/reattach),
    // so fit can run immediately without waiting for reflow.
    this.fitWindow(win.id);

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

    // Detach the tab's wrapper from source window (don't destroy it)
    tab.contentWrapperEl?.remove();

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

    // Attach to target window — re-parent the wrapper into the target's content
    if (tab.contentWrapperEl) {
      targetWin.contentElement.appendChild(tab.contentWrapperEl);
    }
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

    // Rebuild the pane tree inside the tab's wrapper
    const splitContainer = tab.contentWrapperEl ?? win.contentElement;
    this.clearPaneTree(splitContainer);
    this.buildPaneTreeDom(tab.paneTree, splitContainer);

    // Find the new pane (it's the one that was just created — last in the tree)
    const allPanes = this.collectPanes(tab.paneTree);
    const newPane = allPanes[allPanes.length - 1];

    // Spawn PTY and wire
    await this.spawnPaneSession(newPane, win.id, tab.id, cwd);
    this.wirePaneInput(newPane);

    // Title change listener for new pane
    newPane.terminal?.onTitleChange((title: string) => {
      if (title && tab.focusedPaneId === newPane.id) {
        tab.title = title;
      }
    });

    tab.focusedPaneId = newPane.id;

    await this.nextFrame();
    this.fitPaneTree(tab.paneTree);
    newPane.terminal?.focus();
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
      if (pane.contentView) pane.contentView.dispose();
      pane.terminal?.dispose();
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

    // Rebuild DOM inside the tab's wrapper
    const closeContainer = tab.contentWrapperEl ?? win.contentElement;
    this.clearPaneTree(closeContainer);
    this.buildPaneTreeDom(tab.paneTree, closeContainer);

    // Focus the first remaining pane
    const remainingPanes = this.collectPanes(tab.paneTree);
    if (remainingPanes.length > 0) {
      tab.focusedPaneId = remainingPanes[0].id;
      remainingPanes[0].terminal?.focus();
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
      bestPane.terminal?.focus();
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
    nextPane.terminal?.focus();
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

    // Unfocus workspace window visually and blur any focused content view
    if (this.focusedWindowId) {
      const prev = this.windows.get(this.focusedWindowId);
      if (prev) {
        prev.element.classList.remove('krypton-window--focused');
        // Blur the active pane's content view (e.g. agent) so it releases keyboard focus
        if (prev.tabs.length > 0) {
          const tab = prev.tabs[prev.activeTabIndex];
          const pane = this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
          if (pane?.contentView) {
            pane.contentView.element.blur();
          }
        }
      }
    }

    // Focus the Quick Terminal (add focused styling)
    this.qtElement.classList.add('krypton-window--focused');

    // Fit terminal BEFORE animation so reflow doesn't cause a visible jump
    await this.nextFrame();
    this.qtTerminal.fitAddon.fit();
    if (this.qtSessionId !== null) {
      invoke('resize_pty', {
        sessionId: this.qtSessionId,
        cols: this.qtTerminal.terminal.cols,
        rows: this.qtTerminal.terminal.rows,
      }).catch((e) => console.error('QT resize PTY failed:', e));
    }

    // Animate show based on configured style
    const duration = this.qtConfig.animationDuration;
    const anim = this.animateQtShow(this.qtElement, duration);

    // Focus xterm.js
    this.qtTerminal.terminal.focus();

    if (anim) {
      try {
        await anim.finished;
      } catch {
        // Animation cancelled
      }
    }
  }

  /** Hide the Quick Terminal and restore previous focus */
  private async hideQuickTerminal(): Promise<void> {
    if (!this.qtVisible || !this.qtElement) return;
    this.sound.play('tab.close');

    // Animate hide based on configured style
    const duration = this.qtConfig.animationDuration;
    const anim = this.animateQtHide(this.qtElement, duration);

    if (anim) {
      try {
        await anim.finished;
      } catch {
        // Animation cancelled
      }
    }

    // Hide element
    this.qtElement.classList.remove('krypton-quick-terminal--visible');
    this.qtElement.classList.remove('krypton-window--focused');
    // Cancel fill-forwards so next show starts clean
    if (anim) anim.cancel();
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

      // Refocus the restored window's active pane (terminal or content view)
      if (win.tabs.length > 0) {
        const tab = win.tabs[win.activeTabIndex];
        const pane = this.findPaneInTree(tab.paneTree, tab.focusedPaneId);
        if (pane) {
          if (pane.contentView) {
            pane.contentView.element.focus();
          } else {
            pane.terminal?.focus();
          }
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

    const footer = document.createElement('div');
    footer.className = 'krypton-window__footer';

    el.appendChild(chrome);
    el.appendChild(perspectiveWrap);
    el.appendChild(footer);
    this.workspace.appendChild(el);
    this.qtElement = el;

    // Fix mouse coordinates under perspective tilt
    installPerspectiveMouseFix(content);

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

    // Register OSC notification handlers (OSC 9/777/99)
    if (this.notifController) {
      this.notifController.registerOscHandlers(terminal);
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
  /** Build WAAPI show animation for Quick Terminal based on configured style */
  private animateQtShow(el: HTMLElement, duration: number): Animation | null {
    switch (this.qtConfig.animation) {
      case 'slide':
        return el.animate(
          [
            { transform: 'translateY(-100%)', opacity: '0' },
            { transform: 'translateY(0)', opacity: '1' },
          ],
          { duration, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'none' },
        );
      case 'float':
        return el.animate(
          [
            { transform: 'perspective(800px) rotateX(16deg) translateZ(-60px) translateY(-40px)', opacity: '0' },
            { transform: 'perspective(800px) rotateX(1.5deg) translateZ(20px) translateY(0)', opacity: '1' },
          ],
          { duration, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'none' },
        );
      case 'fade':
        return el.animate(
          [
            { opacity: '0', transform: 'scale(0.96)' },
            { opacity: '1', transform: 'scale(1)' },
          ],
          { duration, easing: 'ease-out', fill: 'none' },
        );
      case 'glitch': {
        const d = duration;
        return el.animate(
          [
            { clipPath: 'inset(40% 0 60% 0)', opacity: '0.6', offset: 0 },
            { clipPath: 'inset(10% 0 30% 0)', opacity: '0.8', offset: 0.25 },
            { clipPath: 'inset(60% 0 5% 0)', opacity: '0.7', offset: 0.5 },
            { clipPath: 'inset(20% 0 10% 0)', opacity: '0.9', offset: 0.75 },
            { clipPath: 'inset(0 0 0 0)', opacity: '1', offset: 1 },
          ],
          { duration: d, easing: 'steps(4, end)', fill: 'none' },
        );
      }
      case 'none':
        return null;
    }
  }

  /** Build WAAPI hide animation for Quick Terminal based on configured style */
  private animateQtHide(el: HTMLElement, duration: number): Animation | null {
    switch (this.qtConfig.animation) {
      case 'slide':
        return el.animate(
          [
            { transform: 'translateY(0)', opacity: '1' },
            { transform: 'translateY(-100%)', opacity: '0' },
          ],
          { duration, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
        );
      case 'float':
        return el.animate(
          [
            { transform: 'perspective(800px) rotateX(1.5deg) translateZ(20px) translateY(0)', opacity: '1' },
            { transform: 'perspective(800px) rotateX(16deg) translateZ(-60px) translateY(-40px)', opacity: '0' },
          ],
          { duration, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
        );
      case 'fade':
        return el.animate(
          [
            { opacity: '1', transform: 'scale(1)' },
            { opacity: '0', transform: 'scale(0.96)' },
          ],
          { duration, easing: 'ease-in', fill: 'forwards' },
        );
      case 'glitch': {
        const d = duration;
        return el.animate(
          [
            { clipPath: 'inset(0 0 0 0)', opacity: '1', offset: 0 },
            { clipPath: 'inset(20% 0 10% 0)', opacity: '0.9', offset: 0.25 },
            { clipPath: 'inset(60% 0 5% 0)', opacity: '0.7', offset: 0.5 },
            { clipPath: 'inset(10% 0 30% 0)', opacity: '0.8', offset: 0.75 },
            { clipPath: 'inset(40% 0 60% 0)', opacity: '0', offset: 1 },
          ],
          { duration: d, easing: 'steps(4, end)', fill: 'forwards' },
        );
      }
      case 'none':
        return null;
    }
  }

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
      const textarea = pane.terminal?.textarea;
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
  /** Depth layout: window size as fraction of viewport */
  private static readonly DEPTH_WIDTH_RATIO = 0.88;
  private static readonly DEPTH_HEIGHT_RATIO = 0.90;
  /** Depth layout: maximum visible layers (GPU budget) */
  private static readonly DEPTH_MAX_VISIBLE = 4;

  /** Recalculate grid layout and apply positions to all windows */
  relayout(): void {
    collector.layoutStart();
    const count = this.windows.size;
    if (count === 0) { collector.layoutEnd(); return; }

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
      } else if (this.layoutMode === LayoutMode.Depth) {
        // Depth mode: centered inset, single window
        const w = Math.round(vw * Compositor.DEPTH_WIDTH_RATIO);
        const h = Math.round(vh * Compositor.DEPTH_HEIGHT_RATIO);
        win.gridSlot = { col: 0, row: 0, colSpan: 1, rowSpan: 1 };
        win.bounds = {
          x: Math.round((vw - w) / 2),
          y: Math.round((vh - h) / 2),
          width: w,
          height: h,
        };
        win.element.classList.add('krypton-window--depth');
        this.applyDepthLayer(win, 0);
        this.depthOrder = [win.id];
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
      collector.layoutEnd();
      return;
    }

    if (this.layoutMode === LayoutMode.Focus) {
      this.relayoutFocus(vw, vh, count);
    } else if (this.layoutMode === LayoutMode.Depth) {
      this.relayoutDepth(vw, vh);
    } else {
      this.relayoutGrid(vw, vh, count);
    }
    collector.layoutEnd();
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

  // ─── Depth / Z-Stack Layout ─────────────────────────────────────

  /** Build depth order: focused window first, then remaining in MRU-like order */
  private buildDepthOrder(): WindowId[] {
    const ids = this.windowIds;
    if (ids.length === 0) return [];

    // If we already have a depth order, preserve it but ensure focused is at front
    if (this.depthOrder.length > 0 && this.focusedWindowId) {
      // Remove any stale IDs and duplicates, add any new ones
      const validIds = new Set(ids);
      const seen = new Set<WindowId>();
      const filtered: WindowId[] = [];
      for (const id of this.depthOrder) {
        if (validIds.has(id) && !seen.has(id)) {
          seen.add(id);
          filtered.push(id);
        }
      }

      // Move focused to front
      const focusIdx = filtered.indexOf(this.focusedWindowId);
      if (focusIdx > 0) {
        filtered.splice(focusIdx, 1);
        filtered.unshift(this.focusedWindowId);
      } else if (focusIdx === -1) {
        filtered.unshift(this.focusedWindowId);
      }

      // Add any windows not yet in the depth order (excluding focused, already added)
      const inOrder = new Set(filtered);
      const newIds = ids.filter((id) => !inOrder.has(id));
      return [...filtered, ...newIds];
    }

    // First time: focused at front, rest in creation order
    if (this.focusedWindowId && ids.includes(this.focusedWindowId)) {
      const rest = ids.filter((id) => id !== this.focusedWindowId);
      return [this.focusedWindowId, ...rest];
    }
    return [...ids];
  }

  /** Depth layout: all windows at same bounds, layered as a card stack */
  private relayoutDepth(vw: number, vh: number): void {
    const w = Math.round(vw * Compositor.DEPTH_WIDTH_RATIO);
    const h = Math.round(vh * Compositor.DEPTH_HEIGHT_RATIO);
    const x = Math.round((vw - w) / 2);
    const y = Math.round((vh - h) / 2);

    this.depthOrder = this.buildDepthOrder();

    for (let i = 0; i < this.depthOrder.length; i++) {
      const win = this.windows.get(this.depthOrder[i]);
      if (!win) continue;

      win.gridSlot = { col: 0, row: 0, colSpan: 1, rowSpan: 1 };
      win.bounds = { x, y, width: w, height: h };
      this.applyBounds(win);
      win.element.classList.add('krypton-window--depth');
      this.applyDepthLayer(win, i);
    }
  }

  /** Apply depth-layer visual properties to a window using 3D perspective */
  private applyDepthLayer(win: KryptonWindow, depth: number): void {
    const el = win.element;

    if (depth >= Compositor.DEPTH_MAX_VISIBLE) {
      el.style.display = 'none';
      return;
    }

    el.style.display = '';
    el.style.zIndex = `${100 - depth}`;
    el.style.pointerEvents = depth === 0 ? 'auto' : 'none';

    // Card-stack: shift each layer up so its top border peeks above the front.
    // No translateZ/rotateX — perspective projection fights the Y offset.
    // Depth cue comes from scale + opacity + brightness instead.
    const ty = -depth * 40;         // 40px peek per layer
    const scale = 1 - depth * 0.04; // 4% smaller per layer
    el.style.transform = `translateY(${ty}px) scale(${scale})`;
    el.style.transformOrigin = 'center top';
    el.style.opacity = `${Math.max(0.3, 1 - depth * 0.15)}`;
    el.style.filter = depth > 0
      ? `brightness(${1 - depth * 0.08})`
      : '';
  }

  /** Clear all depth-specific inline styles (when leaving Depth mode) */
  private clearDepthStyles(): void {
    for (const [, win] of this.windows) {
      win.element.classList.remove('krypton-window--depth');
      win.element.style.transform = '';
      win.element.style.opacity = '';
      win.element.style.filter = '';
      win.element.style.pointerEvents = '';
      win.element.style.display = '';
      win.element.style.zIndex = '';
      win.element.style.transformOrigin = '';
    }
    this.depthOrder = [];
  }

  /** Depth: pull next card to front (rotate stack forward) */
  async depthPullForward(): Promise<void> {
    if (this.layoutMode !== LayoutMode.Depth || this.depthOrder.length < 2) return;

    // Capture old depth indices for animation
    const oldDepths = new Map<WindowId, number>();
    for (let i = 0; i < this.depthOrder.length; i++) {
      oldDepths.set(this.depthOrder[i], i);
    }

    // Rotate: front goes to back
    const front = this.depthOrder.shift()!;
    this.depthOrder.push(front);

    // Focus the new front window
    this.focusWindowQuiet(this.depthOrder[0]);
    this.notifyFocusChange();

    // Apply new layout
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.relayoutDepth(vw, vh);
    await this.nextFrame();
    this.fitAll();

    // Animate the shuffle
    const layers = new Map<WindowId, { element: HTMLElement; oldDepth: number; newDepth: number }>();
    for (let i = 0; i < this.depthOrder.length; i++) {
      const id = this.depthOrder[i];
      const win = this.windows.get(id);
      if (!win || i >= Compositor.DEPTH_MAX_VISIBLE) continue;
      const od = oldDepths.get(id) ?? i;
      if (od !== i) {
        layers.set(id, { element: win.element, oldDepth: od, newDepth: i });
      }
    }
    await this.animation.depthShuffle(layers, 'forward');
    this.replayBufferedInput();
  }

  /** Depth: push front card to back (rotate stack backward) */
  async depthPushBack(): Promise<void> {
    if (this.layoutMode !== LayoutMode.Depth || this.depthOrder.length < 2) return;

    const oldDepths = new Map<WindowId, number>();
    for (let i = 0; i < this.depthOrder.length; i++) {
      oldDepths.set(this.depthOrder[i], i);
    }

    // Rotate: back comes to front
    const back = this.depthOrder.pop()!;
    this.depthOrder.unshift(back);

    this.focusWindowQuiet(this.depthOrder[0]);
    this.notifyFocusChange();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.relayoutDepth(vw, vh);
    await this.nextFrame();
    this.fitAll();

    const layers = new Map<WindowId, { element: HTMLElement; oldDepth: number; newDepth: number }>();
    for (let i = 0; i < this.depthOrder.length; i++) {
      const id = this.depthOrder[i];
      const win = this.windows.get(id);
      if (!win || i >= Compositor.DEPTH_MAX_VISIBLE) continue;
      const od = oldDepths.get(id) ?? i;
      if (od !== i) {
        layers.set(id, { element: win.element, oldDepth: od, newDepth: i });
      }
    }
    await this.animation.depthShuffle(layers, 'backward');
    this.replayBufferedInput();
  }

  /** Fit all terminals to their containers and resize PTYs */
  fitAll(): void {
    for (const [, win] of this.windows) {
      this.fitWindow(win.id);
    }
    // Resize flame canvases to match new window dimensions
    if (this.claudeHookManager) {
      this.claudeHookManager.resizeAnimations();
    }
    for (const cb of this.onRelayoutCallbacks) cb();
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

      // Record bytes for profiler PTY throughput
      collector.recordPtyBytes(sid, data.length);

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
              pane.terminal?.write(new Uint8Array(data));
            }
          }
        }
      }
    });

    listen<number>('pty-exit', (event) => {
      const sid = event.payload;
      this.progressGauge.clearSession(sid);

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
        this.progressGauge.handleProgress(sid, state, progress, null);
        return;
      }

      // Regular window: look up via session map
      const loc = this.sessionMap.get(sid);
      if (loc) {
        this.progressGauge.handleProgress(sid, state, progress, loc.windowId);
      }
    });
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

    return this.progressGauge.getSessionProgress(focusedPane.sessionId);
  }

  // ─── SSH Session Multiplexing ─────────────────────────────────────

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
      const remoteCwd = await probeRemoteCwd(sessionId);

      // Create a new tab in the current window
      const tabId = nextTabId();

      // Create wrapper for the new tab's pane tree
      const sshWrapper = this.createTabWrapper(win.contentElement);
      const pane = this.createPane(sshWrapper);

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
        contentWrapperEl: sshWrapper,
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
        cols: pane.terminal!.cols,
        rows: pane.terminal!.rows,
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

      pane.terminal!.onTitleChange((title: string) => {
        if (title) {
          tab.title = title;
          titleSpan.textContent = title;
        }
      });

      pane.terminal?.focus();
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
      const remoteCwd = await probeRemoteCwd(sessionId);

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
        cols: pane.terminal!.cols,
        rows: pane.terminal!.rows,
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
    console.warn(`[krypton] ${message}`);
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
