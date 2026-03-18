// Krypton — Sound Engine (Rust backend via IPC)
// Thin frontend wrapper that delegates all audio playback to the Rust
// sound engine via Tauri commands. No Web Audio API usage.

import { invoke } from '@tauri-apps/api/core';

// ─── Types ────────────────────────────────────────────────────────

/** Sound event names */
export type SoundEvent =
  | 'window.create'
  | 'window.close'
  | 'window.focus'
  | 'window.maximize'
  | 'window.restore'
  | 'window.pin'
  | 'window.unpin'
  | 'mode.enter'
  | 'mode.exit'
  | 'quick_terminal.show'
  | 'quick_terminal.hide'
  | 'workspace.switch'
  | 'command_palette.open'
  | 'command_palette.close'
  | 'command_palette.execute'
  | 'hint.activate'
  | 'hint.select'
  | 'hint.cancel'
  | 'layout.toggle'
  | 'swap.complete'
  | 'resize.step'
  | 'move.step'
  | 'terminal.bell'
  | 'terminal.exit'
  | 'tab.create'
  | 'tab.close'
  | 'tab.switch'
  | 'tab.move'
  | 'pane.split'
  | 'pane.close'
  | 'pane.focus'
  | 'startup';

/** Sound configuration (mirrors TOML [sound] section) */
export interface SoundConfig {
  enabled: boolean;
  volume: number;
  pack: string;
  keyboard_type: string;
  keyboard_volume: number;
  events: Record<string, boolean | number>;
}

/** Default sound configuration */
export const DEFAULT_SOUND_CONFIG: SoundConfig = {
  enabled: true,
  volume: 0.5,
  pack: 'deep-glyph',
  keyboard_type: 'cherry-mx-brown',
  keyboard_volume: 1.0,
  events: {},
};

// ─── Pack display names (static — no IPC needed) ─────────────────

const PACK_DISPLAY_NAMES: Record<string, string> = {
  'deep-glyph': 'Deep Glyph',
  'mach-line': 'Mach Line',
  'holo-dash': 'Holo Dash',
};

// ─── Backend response types ──────────────────────────────────────

interface SoundPackInfo {
  available: { id: string; display_name: string }[];
  current: string;
}

// ─── Sound Engine ─────────────────────────────────────────────────

export class SoundEngine {
  private enabled: boolean = true;
  private currentPack: string = 'deep-glyph';
  // Suppress key-repeat sounds: track last-played timestamp per key.
  // domEvent.repeat is unreliable in WKWebView (Tauri/macOS), so we
  // use a time-based guard instead. A key held down fires repeats
  // every ~30ms; a deliberate re-press takes >120ms. We suppress
  // anything that arrives within 80ms of the previous sound for the
  // same key so the first tap always plays but held-key spam is silent.
  private _lastKeySoundAt: Map<string, number> = new Map();
  private static readonly KEY_REPEAT_SUPPRESS_MS = 80;

  /**
   * Apply sound configuration. Forwards to Rust backend.
   */
  applyConfig(config: SoundConfig): void {
    this.enabled = config.enabled;
    this.currentPack = config.pack;
    invoke('sound_apply_config', { config }).catch((e) => {
      console.warn('[SoundEngine] Failed to apply config:', e);
    });
  }

  /**
   * Play a sound event. Fire-and-forget IPC to Rust backend.
   */
  play(event: SoundEvent): void {
    if (!this.enabled) return;
    invoke('sound_play', { event }).catch(() => {});
  }

  /**
   * Play a keypress sound. Only fires on 'press' phase.
   * Fire-and-forget IPC to Rust backend.
   */
  playKeypress(phase: 'press' | 'release', key?: string): void {
    if (phase !== 'press' || !this.enabled) return;
    // Suppress key-repeat sounds. domEvent.repeat is unreliable in
    // WKWebView, so we gate on elapsed time since the last sound for
    // this key. First tap always plays; held-key repeats (~30ms apart)
    // are silenced.
    const k = key ?? '';
    const now = performance.now();
    const last = this._lastKeySoundAt.get(k) ?? -Infinity;
    if (now - last < SoundEngine.KEY_REPEAT_SUPPRESS_MS) return;
    this._lastKeySoundAt.set(k, now);
    invoke('sound_play_keypress', { key: k }).catch(() => {});
  }

  /**
   * Load a sound theme by pack name.
   */
  async loadTheme(packName: string): Promise<void> {
    this.currentPack = packName;
    await invoke('sound_load_pack', { pack: packName });
  }

  /**
   * Get list of available sound theme names.
   */
  getAvailableThemes(): string[] {
    return Object.keys(PACK_DISPLAY_NAMES);
  }

  /**
   * Get the display name of a sound theme.
   */
  getThemeDisplayName(packName: string): string {
    return PACK_DISPLAY_NAMES[packName] ?? packName
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  /**
   * Get the current active pack name.
   */
  getCurrentPack(): string {
    return this.currentPack;
  }

  /**
   * Start diagnostics (no-op — diagnostics are in the Rust backend now).
   */
  startDiagnostics(): void {
    // Diagnostics are handled by the Rust sound engine via log crate.
  }
}
