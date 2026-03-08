// Krypton — Configuration
// TypeScript types mirroring the Rust config structs.
// Loaded from backend via IPC on startup.

import { invoke } from '@tauri-apps/api/core';

export interface ShellConfig {
  program: string;
  args: string[];
}

export interface FontConfig {
  family: string;
  size: number;
  line_height: number;
  ligatures: boolean;
}

export interface TerminalConfig {
  scrollback_lines: number;
  cursor_style: 'block' | 'underline' | 'bar';
  cursor_blink: boolean;
}

export interface ThemeColors {
  foreground: string | null;
  background: string | null;
  cursor: string | null;
  selection: string | null;
  black: string | null;
  red: string | null;
  green: string | null;
  yellow: string | null;
  blue: string | null;
  magenta: string | null;
  cyan: string | null;
  white: string | null;
  bright_black: string | null;
  bright_red: string | null;
  bright_green: string | null;
  bright_yellow: string | null;
  bright_blue: string | null;
  bright_magenta: string | null;
  bright_cyan: string | null;
  bright_white: string | null;
}

export interface ThemeConfig {
  name: string;
  colors: ThemeColors;
}

export interface QuickTerminalConfig {
  width_ratio: number;
  height_ratio: number;
  backdrop_blur: number;
  animation: string;
  shell: string;
  cwd: string;
}

export interface WorkspacesConfig {
  startup: string;
  gap: number;
  padding: number;
  resize_step: number;
  move_step: number;
  resize_step_large: number;
  move_step_large: number;
}

export interface SoundConfig {
  enabled: boolean;
  volume: number;
  pack: string;
  keyboard_type: string;
  keyboard_volume: number;
  events: Record<string, boolean | number>;
}

export interface HintRule {
  name: string;
  regex: string;
  action: 'Copy' | 'Open' | 'Paste';
  enabled: boolean;
}

export interface HintsConfig {
  alphabet: string;
  rules: HintRule[];
}

export interface TabsConfig {
  always_show_tabbar: boolean;
  default_split: 'vertical' | 'horizontal';
  close_window_on_last_tab: boolean;
}

export interface KryptonConfig {
  shell: ShellConfig;
  font: FontConfig;
  terminal: TerminalConfig;
  theme: ThemeConfig;
  quick_terminal: QuickTerminalConfig;
  workspaces: WorkspacesConfig;
  sound: SoundConfig;
  hints: HintsConfig;
  tabs: TabsConfig;
}

/** Load configuration from the Rust backend */
export async function loadConfig(): Promise<KryptonConfig> {
  return invoke<KryptonConfig>('get_config');
}
