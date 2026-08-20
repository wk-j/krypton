// Krypton — Theme Engine (Frontend)
// Receives full theme data from the backend, sets CSS custom properties on
// document.documentElement, and updates xterm.js terminal instances.

import { invoke } from './profiler/ipc';
import { setupListener } from './util/listener';

/** Clamp a CSS number into 0–255. */
function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Parse a CSS color into an [r, g, b] triplet. Alpha is dropped.
 * Supports #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), and rgba().
 */
export function colorToRgbTriplet(color: string): [number, number, number] | null {
  const s = color.trim().toLowerCase();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      h = `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    } else if (h.length === 8) {
      h = h.slice(0, 6);
    }
    if (h.length !== 6 || !/^[0-9a-f]{6}$/.test(h)) return null;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (m) {
    return [clampByte(Number(m[1])), clampByte(Number(m[2])), clampByte(Number(m[3]))];
  }
  return null;
}

/** Parse a CSS color into an "r, g, b" triplet suitable for rgba(). */
export function colorToRgb(color: string): string {
  const t = colorToRgbTriplet(color);
  if (!t) return '0, 0, 0';
  return `${t[0]}, ${t[1]}, ${t[2]}`;
}

/** Convert an "r, g, b" triplet to #rrggbb. */
export function rgbToHex(rgb: string): string {
  const parts = rgb.split(',').map((x) => parseInt(x.trim(), 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return '#000000';
  return `#${parts
    .slice(0, 3)
    .map((n) => clampByte(n).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Rebuild a color as rgba() with the given alpha. */
export function withAlpha(color: string, alpha: number): string {
  const t = colorToRgbTriplet(color);
  if (!t) return color;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${t[0]}, ${t[1]}, ${t[2]}, ${a})`;
}

/** WCAG relative luminance of a CSS color (alpha ignored). */
export function relativeLuminance(color: string): number {
  const t = colorToRgbTriplet(color);
  if (!t) return 0;
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(t[0]) + 0.7152 * lin(t[1]) + 0.0722 * lin(t[2]);
}

/** WCAG contrast ratio between two CSS colors. */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Mix `amountA` of color A into B (0 = B, 1 = A). Returns `rgb(r, g, b)`.
 */
export function mixColors(a: string, b: string, amountA: number): string {
  const A = colorToRgbTriplet(a);
  const B = colorToRgbTriplet(b);
  if (!A || !B) return a;
  const t = Math.max(0, Math.min(1, amountA));
  const m = (i: number): number => clampByte(A[i] * t + B[i] * (1 - t));
  return `rgb(${m(0)}, ${m(1)}, ${m(2)})`;
}

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
  /** 'oscilloscope' (live canvas trace fed by PTY throughput) or 'ticks'
   *  (static striped gradient). See docs/188-oscilloscope-header-band.md. */
  style: 'oscilloscope' | 'ticks';
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
  /** File/id name (`legacy-radiance`), set by the backend after resolve. */
  name?: string;
  meta: ThemeMeta;
  colors: ThemeColors;
  chrome: ChromeConfig;
  focused: FocusedConfig;
  workspace: WorkspaceThemeConfig;
  ui: UiConfig;
}

export type ThemeScheme = 'light' | 'dark';

/**
 * Classify a theme from chrome backdrop luminance.
 * Neon-on-void recipes (0.15–0.45 accent alphas, glow text) only read on dark
 * fields; light fields need ink-weighted chrome and separated surfaces.
 */
export function themeScheme(theme: FullTheme): ThemeScheme {
  return relativeLuminance(theme.chrome.backdrop.color) >= 0.45 ? 'light' : 'dark';
}

export interface ThemeAccent {
  hex: string;
  rgb: string;
}

/** Flatten a theme into CSS custom properties applied on :root. */
export function themeCssProperties(theme: FullTheme): Record<string, string> {
  const c = theme.colors;
  const accent = theme.focused.corner_accent_color;
  const accentRgb = colorToRgb(accent);
  const fgRgb = colorToRgb(c.foreground);
  const scheme = themeScheme(theme);
  const light = scheme === 'light';
  const backdrop = theme.chrome.backdrop.color;
  // Light: a cooler rail vs paper canvas so the zen sidebar and transcript
  // don't collapse into one frost slab. Dark keeps the existing alpha ladder.
  const surfaceRail = light
    ? withAlpha(mixColors(c.foreground, backdrop, 0.09), 0.92)
    : withAlpha(accent, 0.08);
  const surfaceCanvas = light
    ? withAlpha('#ffffff', 0.78)
    : withAlpha(backdrop, 0.55);
  const surfaceHigh = light
    ? withAlpha(mixColors(accent, '#ffffff', 0.06), 0.92)
    : withAlpha(backdrop, 0.85);
  const surfaceSolid = light
    ? withAlpha('#ffffff', 0.94)
    : withAlpha(backdrop, 0.96);
  const textDim = light
    ? mixColors(c.foreground, backdrop, 0.68)
    : theme.chrome.titlebar.text_color;
  const props: Record<string, string> = {
    '--krypton-fg': c.foreground,
    '--krypton-bg': c.background,
    '--krypton-cursor': c.cursor,
    '--krypton-selection': c.selection,
    '--krypton-scheme': scheme,
    '--krypton-fg-dim': textDim,

    '--krypton-accent': accent,
    '--krypton-accent-rgb': accentRgb,
    '--krypton-fg-rgb': fgRgb,
    '--krypton-bg-rgb': colorToRgb(c.background),
    '--krypton-danger-rgb': colorToRgb(c.red),
    '--krypton-warning-rgb': colorToRgb(c.yellow),
    '--krypton-success-rgb': colorToRgb(c.bright_green),
    '--krypton-special-rgb': colorToRgb(c.magenta),
    '--krypton-info-rgb': colorToRgb(c.blue),

    '--krypton-opacity-ghost': '0.04',
    '--krypton-opacity-inactive': '0.15',
    '--krypton-opacity-hover': '0.4',
    '--krypton-opacity-active': '0.7',
    '--krypton-opacity-neon': '1',

    '--krypton-z-window': '100',
    '--krypton-z-window-focused': '110',
    '--krypton-z-edge-glow': '200',
    '--krypton-z-overlay': '1000',
    '--krypton-z-modal': '2000',
    '--krypton-z-toast': '3000',
    '--krypton-z-hint': '4000',

    '--krypton-ansi-0': c.black,
    '--krypton-ansi-1': c.red,
    '--krypton-ansi-2': c.green,
    '--krypton-ansi-3': c.yellow,
    '--krypton-ansi-4': c.blue,
    '--krypton-ansi-5': c.magenta,
    '--krypton-ansi-6': c.cyan,
    '--krypton-ansi-7': c.white,
    '--krypton-ansi-8': c.bright_black,
    '--krypton-ansi-9': c.bright_red,
    '--krypton-ansi-10': c.bright_green,
    '--krypton-ansi-11': c.bright_yellow,
    '--krypton-ansi-12': c.bright_blue,
    '--krypton-ansi-13': c.bright_magenta,
    '--krypton-ansi-14': c.bright_cyan,
    '--krypton-ansi-15': c.bright_white,

    '--krypton-border-color': theme.chrome.border.color,
    '--krypton-border-width': `${theme.chrome.border.width}px`,
    '--krypton-border-radius': `${theme.chrome.border.radius}px`,

    '--krypton-shadow-color': theme.chrome.shadow.color,
    '--krypton-shadow-blur': `${theme.chrome.shadow.blur}px`,

    '--krypton-backdrop-color': theme.chrome.backdrop.color,
    '--krypton-backdrop-blur': `${theme.chrome.backdrop.blur}px`,
    '--krypton-bg-elev': withAlpha(theme.chrome.backdrop.color, 0.92),

    '--krypton-titlebar-bg': theme.chrome.titlebar.background,
    '--krypton-titlebar-height': `${theme.chrome.titlebar.height}px`,
    '--krypton-titlebar-text': theme.chrome.titlebar.text_color,

    '--krypton-status-dot-size': `${theme.chrome.status_dot.size}px`,
    '--krypton-status-dot-color': theme.chrome.status_dot.color,

    '--krypton-header-accent-color': theme.chrome.header_accent.color,
    '--krypton-header-accent-height': `${theme.chrome.header_accent.height}px`,
    '--krypton-header-accent-margin': `${theme.chrome.header_accent.margin_horizontal}px`,

    '--krypton-corner-color': theme.chrome.corner_accents.color,
    '--krypton-corner-size': `${theme.chrome.corner_accents.size}px`,
    '--krypton-corner-thickness': `${theme.chrome.corner_accents.thickness}px`,

    '--krypton-tab-height': `${theme.chrome.tabs.height}px`,
    '--krypton-tab-background': theme.chrome.tabs.background,
    '--krypton-tab-active-color': theme.chrome.tabs.active_color,
    '--krypton-tab-inactive-color': theme.chrome.tabs.inactive_color,
    '--krypton-tab-font-size': `${theme.chrome.tabs.font_size}px`,

    '--krypton-focused-border': theme.focused.border_color,
    '--krypton-focused-shadow': theme.focused.shadow_color,
    '--krypton-focused-shadow-blur': `${theme.focused.shadow_blur}px`,
    '--krypton-focused-accent': theme.focused.corner_accent_color,
    '--krypton-focused-accent-glow': theme.focused.corner_accent_glow,
    '--krypton-focused-titlebar-text': theme.focused.titlebar_text_color,
    '--krypton-focused-status-dot': theme.focused.status_dot_color,
    '--krypton-focused-header-accent': theme.focused.header_accent_color,
    '--krypton-focused-label': theme.focused.label_color,

    '--krypton-whichkey-bg': theme.ui.which_key.background,
    '--krypton-whichkey-border': theme.ui.which_key.border,
    '--krypton-whichkey-title': theme.ui.which_key.title_color,
    '--krypton-whichkey-key': theme.ui.which_key.key_color,
    '--krypton-whichkey-label': theme.ui.which_key.label_color,
    '--krypton-whichkey-separator': theme.ui.which_key.separator_color,
    '--krypton-whichkey-blur': `${theme.ui.which_key.backdrop_blur}px`,

    '--krypton-qt-bg': theme.ui.quick_terminal.background,
    '--krypton-qt-blur': `${theme.ui.quick_terminal.backdrop_blur}px`,
    '--krypton-qt-shadow-color': theme.ui.quick_terminal.shadow_color,
    '--krypton-qt-shadow-blur': `${theme.ui.quick_terminal.shadow_blur}px`,

    '--krypton-palette-bg': theme.ui.command_palette.background,
    '--krypton-palette-border': theme.ui.command_palette.border,
    '--krypton-palette-highlight': theme.ui.command_palette.highlight_color,
    '--krypton-palette-text': theme.ui.command_palette.text_color,
    '--krypton-palette-input-bg': theme.ui.command_palette.input_background,
    '--krypton-palette-input-text': theme.ui.command_palette.input_text_color,
    '--krypton-palette-blur': `${theme.ui.command_palette.backdrop_blur}px`,

    '--krypton-search-bg': theme.ui.search.background,
    '--krypton-search-match': theme.ui.search.match_color,

    '--krypton-mode-bg': theme.ui.mode_indicator.background,
    '--krypton-mode-text': theme.ui.mode_indicator.text_color,

    '--krypton-hint-bg': theme.ui.hints.background,
    '--krypton-hint-fg': theme.ui.hints.foreground,
    '--krypton-hint-matched-fg': theme.ui.hints.matched_foreground,

    // Default window accent — per-window inline overrides still win, except
    // index-0 / lane-slot-1 which inherit the theme accent.
    '--krypton-window-accent': accent,
    '--krypton-window-accent-rgb': accentRgb,

    // Agent / ACP harness (DESIGN.amber structure, color from the active theme)
    '--agent-text': c.foreground,
    '--agent-bg': backdrop,
    '--agent-panel': backdrop,
    '--agent-surface-low': light ? withAlpha(mixColors(c.foreground, backdrop, 0.05), 0.88) : withAlpha(backdrop, 0.35),
    '--agent-surface-mid': surfaceCanvas,
    '--agent-surface-high': surfaceHigh,
    // Solid panels follow the chrome backdrop, not ANSI black — light themes
    // use a dark `colors.black` for terminal output, which would paint the
    // harness thought card as a black slab on frost.
    '--agent-surface-solid': surfaceSolid,
    '--agent-surface-rail': surfaceRail,
    '--agent-surface-canvas': surfaceCanvas,
    '--agent-border': theme.chrome.border.color,
    '--agent-border-active': theme.focused.border_color,
    '--agent-primary': accent,
    '--agent-primary-rgb': accentRgb,
    '--agent-accent': c.green,
    '--agent-user': c.cyan,
    '--agent-error': c.red,
    '--agent-bright': theme.focused.titlebar_text_color,
    '--agent-dim': withAlpha(accent, light ? 0.55 : 0.35),
    '--agent-ghost': surfaceRail,
    '--agent-text-rgb': fgRgb,
    '--agent-text-dim': textDim,
    '--agent-green': c.green,
    '--agent-green-rgb': colorToRgb(c.green),
    '--agent-red': c.red,
    '--agent-red-rgb': colorToRgb(c.red),
    '--agent-magenta': c.magenta,
    '--agent-gold': c.yellow,
    '--agent-gold-rgb': colorToRgb(c.yellow),
    '--agent-cyan': c.cyan,
    '--agent-cyan-rgb': colorToRgb(c.cyan),
    '--agent-blue': c.blue,
    '--agent-blue-rgb': colorToRgb(c.blue),

    // Vault viewer (DESIGN.nasa structure, color from the active theme)
    '--vault-bg': c.background,
    '--vault-panel': theme.chrome.backdrop.color,
    '--vault-border': theme.chrome.border.color,
    '--vault-border-active': theme.focused.border_color,
    '--vault-primary': accent,
    '--vault-primary-rgb': accentRgb,
    '--vault-bright': theme.focused.titlebar_text_color,
    '--vault-dim': withAlpha(accent, light ? 0.55 : 0.35),
    '--vault-ghost': withAlpha(accent, light ? 0.12 : 0.08),
    '--vault-text': c.foreground,
    '--vault-text-dim': textDim,
    '--vault-orange': c.yellow,
    '--vault-gold': c.bright_yellow,
    '--vault-green': c.green,
    '--vault-cyan': c.cyan,
    '--vault-red': c.red,
    '--vault-magenta': c.magenta,
  };
  return props;
}

// ─── Theme Change Callback ────────────────────────────────────────

export type ThemeChangeCallback = (theme: FullTheme) => void;

// ─── Frontend Theme Engine ────────────────────────────────────────

export class FrontendThemeEngine {
  private currentTheme: FullTheme | null = null;
  private changeCallbacks: ThemeChangeCallback[] = [];
  private listening = false;

  /** Load the initial theme from the backend */
  async init(): Promise<FullTheme> {
    const theme = await invoke<FullTheme>('get_theme');
    this.apply(theme);
    this.startListening();
    return theme;
  }

  /** Listen for backend `theme-changed` (palette switch and reload_config). */
  private startListening(): void {
    if (this.listening) return;
    this.listening = true;
    void setupListener<FullTheme>('theme-changed', (theme) => {
      this.apply(theme);
    }).catch((e) => {
      console.warn('[Krypton] theme-changed listener failed:', e);
    });
  }

  /** Re-fetch the theme from the backend and apply it. */
  async reload(): Promise<FullTheme> {
    const theme = await invoke<FullTheme>('get_theme');
    this.apply(theme);
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

  /** Primary window accent derived from the focused chrome color. */
  primaryAccent(): ThemeAccent {
    const raw = this.currentTheme?.focused.corner_accent_color ?? '#00ccff';
    const rgb = colorToRgb(raw);
    return { hex: rgbToHex(rgb), rgb };
  }

  /** Build the xterm.js theme object from the current theme colors */
  buildXtermTheme(): Record<string, string> {
    if (!this.currentTheme) return {};
    const c = this.currentTheme.colors;
    const light = themeScheme(this.currentTheme) === 'light';
    return {
      background: c.background,
      foreground: c.foreground,
      cursor: c.cursor,
      cursorAccent: light ? '#ffffff' : c.black,
      selectionBackground: c.selection,
      selectionForeground: light ? c.foreground : '#ffffff',
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

  /** Set all --krypton-* / --agent-* / --vault-* CSS custom properties. */
  private setCssProperties(theme: FullTheme): void {
    const rootEl = document.documentElement;
    const root = rootEl.style;
    const props = themeCssProperties(theme);
    for (const [name, value] of Object.entries(props)) {
      root.setProperty(name, value);
    }
    if (theme.name) rootEl.dataset.theme = theme.name;
    if (theme.chrome.style) rootEl.dataset.chrome = theme.chrome.style;
    rootEl.dataset.themeScheme = themeScheme(theme);
  }
}
