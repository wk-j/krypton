// Krypton — Theme Engine (Frontend)
// Receives full theme data from the backend, sets CSS custom properties on
// document.documentElement, and updates xterm.js terminal instances.

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// ─── Theme Data Types (mirrors Rust FullTheme) ───────────────────

export interface ThemeMeta {
  display_name: string;
  author: string;
  version: string;
  description: string;
  license: string;
}

export interface ThemeColors {
  foreground: string;
  background: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  bright_black: string;
  bright_red: string;
  bright_green: string;
  bright_yellow: string;
  bright_blue: string;
  bright_magenta: string;
  bright_cyan: string;
  bright_white: string;
}

export interface ChromeBorder {
  width: number;
  color: string;
  radius: number;
}

export interface ChromeShadow {
  color: string;
  blur: number;
  spread: number;
  offset_x: number;
  offset_y: number;
}

export interface ChromeBackdrop {
  color: string;
  blur: number;
}

export interface ChromeTitlebar {
  height: number;
  background: string;
  text_color: string;
  font_size: number;
  font_weight: number;
  letter_spacing: number;
  text_transform: string;
  alignment: string;
}

export interface ChromeStatusDot {
  size: number;
  color: string;
  shape: string;
}

export interface ChromeHeaderAccent {
  enabled: boolean;
  height: number;
  color: string;
  margin_horizontal: number;
}

export interface ChromeCornerAccents {
  enabled: boolean;
  size: number;
  thickness: number;
  color: string;
}

export interface ChromeTabs {
  height: number;
  background: string;
  active_color: string;
  inactive_color: string;
  font_size: number;
}

export interface ChromeConfig {
  style: string;
  border: ChromeBorder;
  shadow: ChromeShadow;
  backdrop: ChromeBackdrop;
  titlebar: ChromeTitlebar;
  status_dot: ChromeStatusDot;
  header_accent: ChromeHeaderAccent;
  corner_accents: ChromeCornerAccents;
  tabs: ChromeTabs;
}

export interface FocusedConfig {
  border_color: string;
  shadow_color: string;
  shadow_blur: number;
  titlebar_text_color: string;
  status_dot_color: string;
  header_accent_color: string;
  corner_accent_color: string;
  corner_accent_glow: string;
  label_color: string;
}

export interface WorkspaceThemeConfig {
  background: string;
  blur: number;
}

export interface UiCommandPalette {
  background: string;
  border: string;
  text_color: string;
  highlight_color: string;
  input_background: string;
  input_text_color: string;
  backdrop_blur: number;
}

export interface UiSearch {
  background: string;
  text_color: string;
  match_color: string;
  border: string;
}

export interface UiModeIndicator {
  background: string;
  text_color: string;
  font_size: number;
  position: string;
}

export interface UiWhichKey {
  background: string;
  border: string;
  title_color: string;
  key_color: string;
  label_color: string;
  separator_color: string;
  backdrop_blur: number;
}

export interface UiQuickTerminal {
  backdrop_blur: number;
  background: string;
  shadow_color: string;
  shadow_blur: number;
}

export interface UiHints {
  background: string;
  foreground: string;
  matched_foreground: string;
}

export interface UiConfig {
  command_palette: UiCommandPalette;
  search: UiSearch;
  mode_indicator: UiModeIndicator;
  which_key: UiWhichKey;
  quick_terminal: UiQuickTerminal;
  hints: UiHints;
}

export interface FullTheme {
  meta: ThemeMeta;
  colors: ThemeColors;
  chrome: ChromeConfig;
  focused: FocusedConfig;
  workspace: WorkspaceThemeConfig;
  ui: UiConfig;
}

// ─── Theme Change Callback ────────────────────────────────────────

export type ThemeChangeCallback = (theme: FullTheme) => void;

// ─── Frontend Theme Engine ────────────────────────────────────────

export class FrontendThemeEngine {
  private currentTheme: FullTheme | null = null;
  private changeCallbacks: ThemeChangeCallback[] = [];
  private unlisten: UnlistenFn | null = null;

  /** Load the initial theme from the backend */
  async init(): Promise<FullTheme> {
    const theme = await invoke<FullTheme>('get_theme');
    this.apply(theme);

    // Listen for hot-reload events from the backend
    this.unlisten = await listen<FullTheme>('theme-changed', (event) => {
      console.log('[Krypton] Theme hot-reload received:', event.payload.meta.display_name);
      this.apply(event.payload);
    });

    return theme;
  }

  /** Register a callback for theme changes */
  onChange(cb: ThemeChangeCallback): void {
    this.changeCallbacks.push(cb);
  }

  /** Get the current theme (null if not yet loaded) */
  get theme(): FullTheme | null {
    return this.currentTheme;
  }

  /** Build the xterm.js theme object from the current theme colors */
  buildXtermTheme(): Record<string, string> {
    if (!this.currentTheme) return {};
    const c = this.currentTheme.colors;
    return {
      background: c.background,
      foreground: c.foreground,
      cursor: c.cursor,
      cursorAccent: c.black,
      selectionBackground: c.selection,
      selectionForeground: '#ffffff',
      black: c.black,
      red: c.red,
      green: c.green,
      yellow: c.yellow,
      blue: c.blue,
      magenta: c.magenta,
      cyan: c.cyan,
      white: c.white,
      brightBlack: c.bright_black,
      brightRed: c.bright_red,
      brightGreen: c.bright_green,
      brightYellow: c.bright_yellow,
      brightBlue: c.bright_blue,
      brightMagenta: c.bright_magenta,
      brightCyan: c.bright_cyan,
      brightWhite: c.bright_white,
    };
  }

  /** Apply a full theme — sets CSS custom properties and notifies callbacks */
  apply(theme: FullTheme): void {
    this.currentTheme = theme;
    this.setCssProperties(theme);
    for (const cb of this.changeCallbacks) {
      cb(theme);
    }
  }

  /** Dispose the event listener */
  dispose(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }

  /** Set all --krypton-* CSS custom properties on document.documentElement */
  private setCssProperties(theme: FullTheme): void {
    const root = document.documentElement.style;
    const s = (name: string, value: string) => root.setProperty(name, value);

    // Terminal colors
    s('--krypton-fg', theme.colors.foreground);
    s('--krypton-bg', theme.colors.background);
    s('--krypton-cursor', theme.colors.cursor);
    s('--krypton-selection', theme.colors.selection);
    s('--krypton-ansi-0', theme.colors.black);
    s('--krypton-ansi-1', theme.colors.red);
    s('--krypton-ansi-2', theme.colors.green);
    s('--krypton-ansi-3', theme.colors.yellow);
    s('--krypton-ansi-4', theme.colors.blue);
    s('--krypton-ansi-5', theme.colors.magenta);
    s('--krypton-ansi-6', theme.colors.cyan);
    s('--krypton-ansi-7', theme.colors.white);
    s('--krypton-ansi-8', theme.colors.bright_black);
    s('--krypton-ansi-9', theme.colors.bright_red);
    s('--krypton-ansi-10', theme.colors.bright_green);
    s('--krypton-ansi-11', theme.colors.bright_yellow);
    s('--krypton-ansi-12', theme.colors.bright_blue);
    s('--krypton-ansi-13', theme.colors.bright_magenta);
    s('--krypton-ansi-14', theme.colors.bright_cyan);
    s('--krypton-ansi-15', theme.colors.bright_white);

    // Chrome: border
    s('--krypton-border-color', theme.chrome.border.color);
    s('--krypton-border-width', `${theme.chrome.border.width}px`);
    s('--krypton-border-radius', `${theme.chrome.border.radius}px`);

    // Chrome: shadow
    s('--krypton-shadow-color', theme.chrome.shadow.color);
    s('--krypton-shadow-blur', `${theme.chrome.shadow.blur}px`);

    // Chrome: backdrop
    s('--krypton-backdrop-color', theme.chrome.backdrop.color);
    s('--krypton-backdrop-blur', `${theme.chrome.backdrop.blur}px`);

    // Chrome: titlebar
    s('--krypton-titlebar-bg', theme.chrome.titlebar.background);
    s('--krypton-titlebar-height', `${theme.chrome.titlebar.height}px`);
    s('--krypton-titlebar-text', theme.chrome.titlebar.text_color);

    // Chrome: status dot
    s('--krypton-status-dot-size', `${theme.chrome.status_dot.size}px`);
    s('--krypton-status-dot-color', theme.chrome.status_dot.color);

    // Chrome: header accent
    s('--krypton-header-accent-color', theme.chrome.header_accent.color);
    s('--krypton-header-accent-height', `${theme.chrome.header_accent.height}px`);
    s('--krypton-header-accent-margin', `${theme.chrome.header_accent.margin_horizontal}px`);

    // Chrome: corner accents
    s('--krypton-corner-color', theme.chrome.corner_accents.color);
    s('--krypton-corner-size', `${theme.chrome.corner_accents.size}px`);
    s('--krypton-corner-thickness', `${theme.chrome.corner_accents.thickness}px`);

    // Focused state
    s('--krypton-focused-border', theme.focused.border_color);
    s('--krypton-focused-shadow', theme.focused.shadow_color);
    s('--krypton-focused-shadow-blur', `${theme.focused.shadow_blur}px`);
    s('--krypton-focused-accent', theme.focused.corner_accent_color);
    s('--krypton-focused-accent-glow', theme.focused.corner_accent_glow);
    s('--krypton-focused-titlebar-text', theme.focused.titlebar_text_color);
    s('--krypton-focused-status-dot', theme.focused.status_dot_color);
    s('--krypton-focused-header-accent', theme.focused.header_accent_color);
    s('--krypton-focused-label', theme.focused.label_color);

    // UI: Which-key
    s('--krypton-whichkey-bg', theme.ui.which_key.background);
    s('--krypton-whichkey-border', theme.ui.which_key.border);
    s('--krypton-whichkey-title', theme.ui.which_key.title_color);
    s('--krypton-whichkey-key', theme.ui.which_key.key_color);
    s('--krypton-whichkey-label', theme.ui.which_key.label_color);
    s('--krypton-whichkey-separator', theme.ui.which_key.separator_color);
    s('--krypton-whichkey-blur', `${theme.ui.which_key.backdrop_blur}px`);

    // UI: Quick Terminal
    s('--krypton-qt-bg', theme.ui.quick_terminal.background);
    s('--krypton-qt-blur', `${theme.ui.quick_terminal.backdrop_blur}px`);
    s('--krypton-qt-shadow-color', theme.ui.quick_terminal.shadow_color);
    s('--krypton-qt-shadow-blur', `${theme.ui.quick_terminal.shadow_blur}px`);

    // UI: Command Palette
    s('--krypton-palette-bg', theme.ui.command_palette.background);
    s('--krypton-palette-border', theme.ui.command_palette.border);
    s('--krypton-palette-highlight', theme.ui.command_palette.highlight_color);

    // UI: Search
    s('--krypton-search-bg', theme.ui.search.background);
    s('--krypton-search-match', theme.ui.search.match_color);

    // UI: Mode indicator
    s('--krypton-mode-bg', theme.ui.mode_indicator.background);
    s('--krypton-mode-text', theme.ui.mode_indicator.text_color);

    // UI: Hints
    s('--krypton-hint-bg', theme.ui.hints.background);
    s('--krypton-hint-fg', theme.ui.hints.foreground);
    s('--krypton-hint-matched-fg', theme.ui.hints.matched_foreground);
  }
}
