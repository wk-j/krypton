// Krypton — Sound Engine (WAV-based)
// Plays pre-rendered WAV files via Web Audio API.
// Eliminates real-time synthesis to avoid AudioContext degradation bugs.

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

// ─── WAV Sound ID mapping ────────────────────────────────────────
// Maps Krypton SoundEvent names to WAV file base names.

const EVENT_TO_WAV: Record<SoundEvent, string> = {
  'startup':                'APP_START',
  'window.create':          'TAB_INSERT',
  'window.close':           'TAB_CLOSE',
  'window.focus':           'HOVER',
  'window.maximize':        'FEATURE_SWITCH_ON',
  'window.restore':         'FEATURE_SWITCH_OFF',
  'window.pin':             'LIMITER_ON',
  'window.unpin':           'LIMITER_OFF',
  'mode.enter':             'CLICK',
  'mode.exit':              'HOVER_UP',
  'quick_terminal.show':    'FEATURE_SWITCH_ON',
  'quick_terminal.hide':    'FEATURE_SWITCH_OFF',
  'workspace.switch':       'TAB_SLASH',
  'command_palette.open':   'TAB_SLASH',
  'command_palette.close':  'HOVER_UP',
  'command_palette.execute': 'IMPORTANT_CLICK',
  'hint.activate':          'CLICK',
  'hint.select':            'IMPORTANT_CLICK',
  'hint.cancel':            'HOVER_UP',
  'layout.toggle':          'SWITCH_TOGGLE',
  'swap.complete':          'CLICK',
  'resize.step':            'HOVER',
  'move.step':              'HOVER',
  'terminal.bell':          'IMPORTANT_CLICK',
  'terminal.exit':          'TAB_CLOSE',
  'tab.create':             'TAB_INSERT',
  'tab.close':              'TAB_CLOSE',
  'tab.switch':             'CLICK',
  'tab.move':               'SWITCH_TOGGLE',
  'pane.split':             'TAB_INSERT',
  'pane.close':             'TAB_CLOSE',
  'pane.focus':             'HOVER',
};

/** All WAV file names (unique set of sounds to load) */
const ALL_WAV_NAMES = [
  'APP_START', 'CLICK', 'FEATURE_SWITCH_OFF', 'FEATURE_SWITCH_ON',
  'HOVER', 'HOVER_UP', 'IMPORTANT_CLICK', 'LIMITER_OFF', 'LIMITER_ON',
  'SWITCH_TOGGLE', 'TAB_CLOSE', 'TAB_INSERT', 'TAB_SLASH',
  'TYPING_BACKSPACE', 'TYPING_ENTER', 'TYPING_LETTER', 'TYPING_SPACE',
] as const;

// ─── Sound Engine ─────────────────────────────────────────────────

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private config: SoundConfig = { ...DEFAULT_SOUND_CONFIG };

  // ─── WAV buffer cache ───────────────────────────────────────
  /** Decoded AudioBuffers keyed by WAV name (e.g., 'CLICK', 'HOVER') */
  private buffers: Map<string, AudioBuffer> = new Map();
  /** True while WAV files are being loaded */
  private loading = false;
  /** True once initial load has completed */
  private loaded = false;

  // ─── Sound queue / overlap management ─────────────────────────
  /** Max concurrent sounds. Beyond this, new sounds are dropped. */
  private static readonly MAX_CONCURRENT = 8;
  /** Minimum interval (ms) between keypress sounds to avoid stacking during fast typing */
  private static readonly KEYPRESS_THROTTLE_MS = 25;
  /** Per-event cooldown (ms) — same action event won't re-fire within this window */
  private static readonly EVENT_COOLDOWN_MS = 50;

  /** Currently playing sound count */
  private activeSounds = 0;
  /** Timestamp of the last keypress sound (press phase) */
  private lastKeypressTime = 0;
  /** Last fire time per action event for dedup */
  private lastEventTime: Map<string, number> = new Map();

  // ─── Diagnostics ──────────────────────────────────────────────
  private totalSoundsAttempted = 0;
  private totalSoundsPlayed = 0;
  private diagInterval: ReturnType<typeof setInterval> | null = null;

  /** Start periodic diagnostic logging. Call once after init. */
  startDiagnostics(): void {
    if (this.diagInterval) return;
    console.log('[SoundEngine] diagnostics ON (WAV-based), pack=' + this.config.pack);
    this.diagInterval = setInterval(() => this.logDiag(), 30_000);
  }

  private logDiag(): void {
    console.log(
      `[SoundEngine] ctx=${this.ctx?.state ?? 'null'} ` +
      `active=${this.activeSounds} ` +
      `attempted=${this.totalSoundsAttempted} played=${this.totalSoundsPlayed} ` +
      `buffers=${this.buffers.size}/${ALL_WAV_NAMES.length} loaded=${this.loaded}`
    );
  }

  /**
   * Apply sound configuration. Call after loading config from backend.
   * If the pack changed, triggers async WAV loading.
   */
  applyConfig(config: SoundConfig): void {
    this.config = { ...DEFAULT_SOUND_CONFIG, ...config };
    // Update master volume if context is live
    if (this.masterGain) {
      this.masterGain.gain.value = this.config.volume;
    }
    // Load WAV files if not already loaded
    if (!this.loaded && !this.loading) {
      this.loadAllWavs();
    }
  }

  /**
   * Load a sound theme by name. For WAV-based engine, all packs
   * use the same deep-glyph WAV files. Kept for API compatibility.
   */
  async loadTheme(_packName: string): Promise<void> {
    if (!this.loaded && !this.loading) {
      await this.loadAllWavs();
    }
  }

  /**
   * Get list of available sound theme names.
   */
  getAvailableThemes(): string[] {
    return ['deep-glyph'];
  }

  /**
   * Get the display name of a sound theme.
   */
  getThemeDisplayName(packName: string): string {
    if (packName === 'deep-glyph') return 'Deep Glyph';
    return packName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  /**
   * Get the current active pack name.
   */
  getCurrentPack(): string {
    return this.config.pack;
  }

  /**
   * Play a keypress sound (press or release).
   * Routes by key name to the appropriate TYPING_* WAV.
   * Release phase is ignored — WAV files include the full sound.
   */
  playKeypress(phase: 'press' | 'release', key?: string): void {
    if (phase === 'press') this.totalSoundsAttempted++;
    if (!this.config.enabled) return;

    // Only play on press — release is baked into the WAV
    if (phase === 'release') return;

    // Check per-event override for keypress
    const eventConfig = this.config.events['keypress'];
    if (eventConfig === false) return;

    // Throttle: skip if too soon after last press
    const now = performance.now();
    if (now - this.lastKeypressTime < SoundEngine.KEYPRESS_THROTTLE_MS) return;
    this.lastKeypressTime = now;

    // Max concurrent check
    if (this.activeSounds >= SoundEngine.MAX_CONCURRENT) return;

    // Determine which WAV to play
    let wavName: string;
    if (key === 'Backspace') {
      wavName = 'TYPING_BACKSPACE';
    } else if (key === 'Enter') {
      wavName = 'TYPING_ENTER';
    } else if (key === ' ') {
      wavName = 'TYPING_SPACE';
    } else {
      wavName = 'TYPING_LETTER';
    }

    // Determine volume
    let volume = this.config.keyboard_volume;
    if (typeof eventConfig === 'number') {
      volume *= Math.max(0, Math.min(1, eventConfig));
    }

    this.playBuffer(wavName, volume);
  }

  /**
   * Play a sound event. Non-blocking — schedules audio via Web Audio API.
   * Gracefully no-ops if sound is disabled, event is disabled, or WAV not loaded.
   * Deduplicates: skips if the same event fired within the cooldown window.
   */
  play(event: SoundEvent): void {
    this.totalSoundsAttempted++;
    if (!this.config.enabled) return;

    // Check per-event override
    const eventConfig = this.config.events[event];
    if (eventConfig === false) return;

    // Cooldown dedup: skip if same event fired too recently
    const now = performance.now();
    const lastTime = this.lastEventTime.get(event) ?? 0;
    if (now - lastTime < SoundEngine.EVENT_COOLDOWN_MS) return;
    this.lastEventTime.set(event, now);

    // Max concurrent check
    if (this.activeSounds >= SoundEngine.MAX_CONCURRENT) return;

    // Map event to WAV name
    const wavName = EVENT_TO_WAV[event];
    if (!wavName) return;

    // Determine volume
    let volume = 1.0;
    if (typeof eventConfig === 'number') {
      volume = Math.max(0, Math.min(1, eventConfig));
    }

    this.playBuffer(wavName, volume);
  }

  // ─── Private: AudioContext lifecycle ───────────────────────────

  /**
   * Lazily create AudioContext and master channel.
   * Called on first play to comply with browser autoplay policy.
   */
  private ensureContext(): boolean {
    if (this.ctx) {
      // Resume if suspended (browser autoplay policy or macOS display sleep)
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => { /* best-effort */ });
      }
      if (this.ctx.state === 'closed') {
        // Context died — recreate
        this.ctx = null;
        this.masterGain = null;
        this.compressor = null;
      } else {
        return true;
      }
    }

    try {
      this.ctx = new AudioContext();

      // Monitor for context death
      this.ctx.addEventListener('statechange', () => {
        if (this.ctx?.state === 'closed') {
          this.ctx = null;
          this.masterGain = null;
          this.compressor = null;
        } else if (this.ctx?.state === 'suspended') {
          this.ctx.resume().catch(() => { /* best-effort */ });
        }
      });

      // Resume immediately — some WebViews create contexts in suspended state
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => { /* best-effort */ });
      }

      // Master channel: compressor -> gain -> destination
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -3;
      this.compressor.knee.value = 10;
      this.compressor.ratio.value = 8;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.1;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.config.volume;

      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      return true;
    } catch {
      // Web Audio API unavailable — silent degradation
      this.ctx = null;
      this.masterGain = null;
      this.compressor = null;
      return false;
    }
  }

  // ─── Private: WAV loading ─────────────────────────────────────

  /**
   * Fetch and decode all WAV files into AudioBuffers.
   * Files are served from /sounds/deep-glyph/ (Vite public directory).
   */
  private async loadAllWavs(): Promise<void> {
    if (this.loading) return;
    this.loading = true;

    // Ensure context exists for decodeAudioData
    if (!this.ensureContext()) {
      this.loading = false;
      return;
    }

    const basePath = '/sounds/deep-glyph';
    let loadedCount = 0;

    for (const name of ALL_WAV_NAMES) {
      try {
        const url = `${basePath}/${name}.wav`;
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[SoundEngine] Failed to fetch ${url}: ${response.status}`);
          continue;
        }
        const arrayBuffer = await response.arrayBuffer();

        // decodeAudioData needs a valid context
        if (!this.ctx || this.ctx.state === 'closed') {
          if (!this.ensureContext()) break;
        }

        const audioBuffer = await this.ctx!.decodeAudioData(arrayBuffer);
        this.buffers.set(name, audioBuffer);
        loadedCount++;
      } catch (err) {
        console.warn(`[SoundEngine] Failed to load WAV "${name}":`, err);
      }
    }

    this.loaded = true;
    this.loading = false;
    console.log(`[SoundEngine] Loaded ${loadedCount}/${ALL_WAV_NAMES.length} WAV files`);
  }

  // ─── Private: Playback ────────────────────────────────────────

  /**
   * Play a named WAV buffer through the master channel.
   * Creates only 2 nodes: BufferSourceNode + GainNode.
   */
  private playBuffer(wavName: string, volume: number): void {
    const buffer = this.buffers.get(wavName);
    if (!buffer) return; // WAV not loaded yet — silent skip

    if (!this.ensureContext()) return;
    if (!this.ctx || !this.compressor) return;

    try {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const gain = this.ctx.createGain();
      gain.gain.value = volume;

      source.connect(gain);
      gain.connect(this.compressor);

      this.activeSounds++;
      this.totalSoundsPlayed++;

      source.addEventListener('ended', () => {
        this.activeSounds = Math.max(0, this.activeSounds - 1);
        try { source.disconnect(); } catch { /* ok */ }
        try { gain.disconnect(); } catch { /* ok */ }
      }, { once: true });

      source.start();
    } catch (err) {
      console.warn('[SoundEngine] Playback error:', err);
    }
  }
}
