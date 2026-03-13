// Krypton — Sound Engine
// Procedural sound effects via Web Audio API.
// Supports two theme types:
//   1. Patch-based (krypton-cyber) — declarative oscillator/filter/envelope definitions
//   2. Ghost-signal — function-based themes with fire-and-forget sound functions

import type { GhostSignalTheme } from './sound-themes/types';

// ─── Types ────────────────────────────────────────────────────────

/** Oscillator waveform types including noise generators */
type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'white-noise' | 'pink-noise';

/** A single oscillator partial within a patch */
interface OscillatorDef {
  waveform: Waveform;
  frequency: number;
  amplitude: number;
  detune?: number;
  /** Pitch envelope: sweep frequency from start to end over duration (seconds) */
  pitchEnvelope?: { start: number; end: number; duration: number };
  /** FM synthesis: modulate this oscillator's frequency using another oscillator's output */
  fm?: { modulatorIndex: number; depth: number };
}

/** Filter definition for subtractive synthesis */
interface FilterDef {
  type: BiquadFilterType;
  cutoff: number;
  Q: number;
  /** Filter cutoff envelope: sweep from start to end over duration (seconds) */
  envelope?: { start: number; end: number; duration: number };
}

/** ADSR amplitude envelope */
interface EnvelopeDef {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** Optional effects */
interface EffectsDef {
  reverb?: { duration: number; decay: number };
  delay?: { time: number; feedback: number };
  distortion?: { amount: number };
}

/** Complete sound patch definition */
export interface SoundPatch {
  oscillators: OscillatorDef[];
  filter?: FilterDef;
  envelope: EnvelopeDef;
  effects?: EffectsDef;
  pan?: number;
}

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

/** Keyboard type for keypress sounds */
export type KeyboardType =
  | 'cherry-mx-blue'
  | 'cherry-mx-red'
  | 'cherry-mx-brown'
  | 'topre'
  | 'buckling-spring'
  | 'membrane'
  | 'none';

/** A keypress sound set: press (key down) and release (key up) patches */
interface KeypressPatchSet {
  press: SoundPatch;
  release: SoundPatch;
}

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
  pack: 'krypton-cyber',
  keyboard_type: 'cherry-mx-brown',
  keyboard_volume: 1.0,
  events: {},
};

// ─── Ghost-signal Event Mapping ──────────────────────────────────
// Maps Krypton SoundEvent names to ghost-signal sound IDs.

const GHOST_SIGNAL_EVENT_MAP: Record<SoundEvent, string> = {
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

// ─── Ghost-signal Built-in Theme Registry ────────────────────────
// Lazy-loaded via dynamic import() — only the active theme is loaded.

const GHOST_SIGNAL_THEMES: Record<string, () => Promise<GhostSignalTheme>> = {
  'ghost-signal':  () => import('./sound-themes/ghost-signal').then(m => m.default),
  'chill-city-fm': () => import('./sound-themes/chill-city-fm').then(m => m.default),
  'orbit-deck':    () => import('./sound-themes/orbit-deck').then(m => m.default),
  'mach-line':     () => import('./sound-themes/mach-line').then(m => m.default),
  'deep-glyph':    () => import('./sound-themes/deep-glyph').then(m => m.default),
};

/**
 * Resolved sound theme: either patch-based (krypton-native) or function-based (ghost-signal).
 */
type ActiveSoundTheme =
  | { type: 'patches'; patches: Record<string, SoundPatch> }
  | { type: 'ghost-signal'; sounds: Record<string, () => void>; theme: GhostSignalTheme };

// ─── Built-in Krypton Cyber Sound Pack ───────────────────────────

const KRYPTON_CYBER: Record<SoundEvent, SoundPatch> = {
  // ─── Action event sounds — tonal cues (distinct from keypress clicks) ──
  // These use sine/triangle tones, not noise bursts. Quiet, short, musical.
  // Keypress sounds are handled separately by the keyboard type system.

  // Window create: rising two-note blip
  'window.create': {
    oscillators: [
      { waveform: 'sine', frequency: 220, amplitude: 0.08,
        pitchEnvelope: { start: 180, end: 260, duration: 0.04 } },
    ],
    filter: { type: 'lowpass', cutoff: 800, Q: 0.7 },
    envelope: { attack: 0.002, decay: 0.04, sustain: 0.0, release: 0.02 },
  },

  // Window close: falling tone
  'window.close': {
    oscillators: [
      { waveform: 'sine', frequency: 200, amplitude: 0.07,
        pitchEnvelope: { start: 240, end: 140, duration: 0.05 } },
    ],
    filter: { type: 'lowpass', cutoff: 700, Q: 0.7 },
    envelope: { attack: 0.002, decay: 0.05, sustain: 0.0, release: 0.025 },
  },

  // Window focus: tiny soft ping
  'window.focus': {
    oscillators: [
      { waveform: 'triangle', frequency: 400, amplitude: 0.04 },
    ],
    filter: { type: 'lowpass', cutoff: 1000, Q: 0.5 },
    envelope: { attack: 0.001, decay: 0.02, sustain: 0.0, release: 0.01 },
  },

  // Window maximize: rising fifth interval
  'window.maximize': {
    oscillators: [
      { waveform: 'sine', frequency: 200, amplitude: 0.06 },
      { waveform: 'sine', frequency: 300, amplitude: 0.04 },
    ],
    filter: { type: 'lowpass', cutoff: 900, Q: 0.7 },
    envelope: { attack: 0.003, decay: 0.05, sustain: 0.0, release: 0.025 },
  },

  // Window restore: falling fourth interval
  'window.restore': {
    oscillators: [
      { waveform: 'sine', frequency: 300, amplitude: 0.05 },
      { waveform: 'sine', frequency: 200, amplitude: 0.04 },
    ],
    filter: { type: 'lowpass', cutoff: 900, Q: 0.7 },
    envelope: { attack: 0.003, decay: 0.05, sustain: 0.0, release: 0.025 },
  },

  // Window pin: short rising click (lock into place)
  'window.pin': {
    oscillators: [
      { waveform: 'sine', frequency: 600, amplitude: 0.05,
        pitchEnvelope: { start: 400, end: 700, duration: 0.04 } },
      { waveform: 'triangle', frequency: 800, amplitude: 0.03 },
    ],
    filter: { type: 'lowpass', cutoff: 1200, Q: 0.8 },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0.0, release: 0.015 },
  },

  // Window unpin: short falling click (release)
  'window.unpin': {
    oscillators: [
      { waveform: 'sine', frequency: 500, amplitude: 0.04,
        pitchEnvelope: { start: 700, end: 350, duration: 0.04 } },
      { waveform: 'triangle', frequency: 400, amplitude: 0.02 },
    ],
    filter: { type: 'lowpass', cutoff: 1000, Q: 0.7 },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0.0, release: 0.015 },
  },

  // Mode enter: short high blip
  'mode.enter': {
    oscillators: [
      { waveform: 'sine', frequency: 500, amplitude: 0.06 },
    ],
    filter: { type: 'lowpass', cutoff: 1200, Q: 0.7 },
    envelope: { attack: 0.001, decay: 0.025, sustain: 0.0, release: 0.012 },
  },

  // Mode exit: lower blip
  'mode.exit': {
    oscillators: [
      { waveform: 'sine', frequency: 350, amplitude: 0.04 },
    ],
    filter: { type: 'lowpass', cutoff: 900, Q: 0.7 },
    envelope: { attack: 0.002, decay: 0.025, sustain: 0.0, release: 0.012 },
  },

  // Quick Terminal show: warm rising tone
  'quick_terminal.show': {
    oscillators: [
      { waveform: 'sine', frequency: 250, amplitude: 0.07,
        pitchEnvelope: { start: 200, end: 300, duration: 0.06 } },
    ],
    filter: { type: 'lowpass', cutoff: 800, Q: 0.7 },
    envelope: { attack: 0.003, decay: 0.06, sustain: 0.0, release: 0.03 },
  },

  // Quick Terminal hide: warm falling tone
  'quick_terminal.hide': {
    oscillators: [
      { waveform: 'sine', frequency: 280, amplitude: 0.05,
        pitchEnvelope: { start: 300, end: 200, duration: 0.06 } },
    ],
    filter: { type: 'lowpass', cutoff: 800, Q: 0.7 },
    envelope: { attack: 0.003, decay: 0.06, sustain: 0.0, release: 0.03 },
  },

  // Workspace switch: gentle whoosh (noise + tone)
  'workspace.switch': {
    oscillators: [
      { waveform: 'sine', frequency: 180, amplitude: 0.05,
        pitchEnvelope: { start: 150, end: 220, duration: 0.08 } },
    ],
    filter: { type: 'lowpass', cutoff: 700, Q: 0.7 },
    envelope: { attack: 0.005, decay: 0.07, sustain: 0.0, release: 0.035 },
    pan: 0.3,
  },

  // Command palette open: two-note ascending
  'command_palette.open': {
    oscillators: [
      { waveform: 'triangle', frequency: 300, amplitude: 0.05 },
      { waveform: 'triangle', frequency: 400, amplitude: 0.03 },
    ],
    filter: { type: 'lowpass', cutoff: 1000, Q: 0.5 },
    envelope: { attack: 0.002, decay: 0.04, sustain: 0.0, release: 0.02 },
  },

  // Command palette close: single descending note
  'command_palette.close': {
    oscillators: [
      { waveform: 'triangle', frequency: 350, amplitude: 0.03,
        pitchEnvelope: { start: 380, end: 280, duration: 0.03 } },
    ],
    filter: { type: 'lowpass', cutoff: 800, Q: 0.5 },
    envelope: { attack: 0.002, decay: 0.03, sustain: 0.0, release: 0.015 },
  },

  // Command palette execute: confirmation ping
  'command_palette.execute': {
    oscillators: [
      { waveform: 'sine', frequency: 440, amplitude: 0.06 },
    ],
    filter: { type: 'lowpass', cutoff: 1200, Q: 0.7 },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0.0, release: 0.02 },
  },

  // Hint activate: scanning sweep (rising shimmer)
  'hint.activate': {
    oscillators: [
      { waveform: 'triangle', frequency: 350, amplitude: 0.05,
        pitchEnvelope: { start: 300, end: 450, duration: 0.05 } },
    ],
    filter: { type: 'lowpass', cutoff: 1100, Q: 0.6 },
    envelope: { attack: 0.002, decay: 0.04, sustain: 0.0, release: 0.02 },
  },

  // Hint select: confirmation click (short, decisive)
  'hint.select': {
    oscillators: [
      { waveform: 'sine', frequency: 480, amplitude: 0.06 },
      { waveform: 'sine', frequency: 600, amplitude: 0.03 },
    ],
    filter: { type: 'lowpass', cutoff: 1400, Q: 0.7 },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0.0, release: 0.015 },
  },

  // Hint cancel: soft descending blip
  'hint.cancel': {
    oscillators: [
      { waveform: 'triangle', frequency: 320, amplitude: 0.03,
        pitchEnvelope: { start: 350, end: 250, duration: 0.03 } },
    ],
    filter: { type: 'lowpass', cutoff: 800, Q: 0.5 },
    envelope: { attack: 0.002, decay: 0.03, sustain: 0.0, release: 0.015 },
  },

  // Layout toggle: quick two-note flip
  'layout.toggle': {
    oscillators: [
      { waveform: 'sine', frequency: 250, amplitude: 0.05 },
      { waveform: 'sine', frequency: 330, amplitude: 0.03 },
    ],
    filter: { type: 'lowpass', cutoff: 900, Q: 0.7 },
    envelope: { attack: 0.002, decay: 0.035, sustain: 0.0, release: 0.018 },
  },

  // Swap complete: crossing tones
  'swap.complete': {
    oscillators: [
      { waveform: 'sine', frequency: 250, amplitude: 0.04,
        pitchEnvelope: { start: 220, end: 300, duration: 0.04 } },
      { waveform: 'sine', frequency: 350, amplitude: 0.03,
        pitchEnvelope: { start: 380, end: 280, duration: 0.04 } },
    ],
    filter: { type: 'lowpass', cutoff: 900, Q: 0.7 },
    envelope: { attack: 0.002, decay: 0.04, sustain: 0.0, release: 0.02 },
  },

  // Resize step: tiny triangle pip
  'resize.step': {
    oscillators: [
      { waveform: 'triangle', frequency: 600, amplitude: 0.03 },
    ],
    envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
  },

  // Move step: slightly lower pip
  'move.step': {
    oscillators: [
      { waveform: 'triangle', frequency: 500, amplitude: 0.025 },
    ],
    envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
  },

  // Terminal bell: metallic ping (FM synthesis)
  'terminal.bell': {
    oscillators: [
      { waveform: 'sine', frequency: 600, amplitude: 0.08,
        fm: { modulatorIndex: 1, depth: 80 } },
      { waveform: 'sine', frequency: 1500, amplitude: 0.03 },
    ],
    filter: { type: 'lowpass', cutoff: 2000, Q: 1.0 },
    envelope: { attack: 0.001, decay: 0.06, sustain: 0.0, release: 0.03 },
  },

  // Terminal exit: descending fade
  'terminal.exit': {
    oscillators: [
      { waveform: 'sine', frequency: 180, amplitude: 0.06,
        pitchEnvelope: { start: 200, end: 100, duration: 0.1 } },
    ],
    filter: { type: 'lowpass', cutoff: 600, Q: 0.7 },
    envelope: { attack: 0.003, decay: 0.08, sustain: 0.0, release: 0.04 },
  },

  // ─── Tab/Pane events ──────────────────────────────────
  'tab.create': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.06 },
      { waveform: 'sine', frequency: 140, amplitude: 0.04 },
    ],
    filter: { type: 'bandpass', cutoff: 4000, Q: 1.5 },
    envelope: { attack: 0.001, decay: 0.012, sustain: 0.0, release: 0.006 },
  },
  'tab.close': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.05 },
    ],
    filter: { type: 'highpass', cutoff: 3000, Q: 1.2 },
    envelope: { attack: 0.001, decay: 0.01, sustain: 0.0, release: 0.005 },
  },
  'tab.switch': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.04 },
    ],
    filter: { type: 'bandpass', cutoff: 4200, Q: 2.0 },
    envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
  },
  'tab.move': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.06 },
      { waveform: 'sine', frequency: 100, amplitude: 0.03 },
    ],
    filter: { type: 'bandpass', cutoff: 3500, Q: 1.5 },
    envelope: { attack: 0.001, decay: 0.012, sustain: 0.0, release: 0.005 },
  },
  'pane.split': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.07 },
      { waveform: 'sine', frequency: 160, amplitude: 0.03 },
    ],
    filter: { type: 'bandpass', cutoff: 3800, Q: 1.4 },
    envelope: { attack: 0.001, decay: 0.015, sustain: 0.0, release: 0.006 },
  },
  'pane.close': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.04 },
    ],
    filter: { type: 'highpass', cutoff: 3200, Q: 1.0 },
    envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
  },
  'pane.focus': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.03 },
    ],
    filter: { type: 'bandpass', cutoff: 4500, Q: 2.2 },
    envelope: { attack: 0.001, decay: 0.006, sustain: 0.0, release: 0.003 },
  },

  'startup': {
    oscillators: [
      { waveform: 'sine', frequency: 120, amplitude: 0.07,
        pitchEnvelope: { start: 80, end: 160, duration: 0.1 } },
      { waveform: 'sine', frequency: 240, amplitude: 0.04 },
    ],
    filter: {
      type: 'lowpass', cutoff: 500, Q: 0.7,
      envelope: { start: 300, end: 700, duration: 0.12 },
    },
    envelope: { attack: 0.005, decay: 0.1, sustain: 0.02, release: 0.05 },
  },
};

// ─── Keyboard Type Sound Patches ─────────────────────────────────
// Each keyboard type has a press (key-down) and release (key-up) patch.
// All are noise-based with subtle tonal body — modeled after real switch acoustics.

const KEYBOARD_PATCHES: Record<Exclude<KeyboardType, 'none'>, KeypressPatchSet> = {
  // Cherry MX Blue: loud tactile click — sharp high click on press, lighter click on release
  'cherry-mx-blue': {
    press: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.14 },
        { waveform: 'sine', frequency: 180, amplitude: 0.05 },
      ],
      filter: { type: 'bandpass', cutoff: 4500, Q: 1.8 },
      envelope: { attack: 0.001, decay: 0.018, sustain: 0.0, release: 0.008 },
    },
    release: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.08 },
      ],
      filter: { type: 'bandpass', cutoff: 5500, Q: 2.0 },
      envelope: { attack: 0.001, decay: 0.01, sustain: 0.0, release: 0.005 },
    },
  },

  // Cherry MX Red: linear smooth — soft thock on bottom-out, very quiet upstroke
  'cherry-mx-red': {
    press: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.07 },
        { waveform: 'sine', frequency: 100, amplitude: 0.04 },
      ],
      filter: { type: 'bandpass', cutoff: 2800, Q: 1.0 },
      envelope: { attack: 0.001, decay: 0.012, sustain: 0.0, release: 0.006 },
    },
    release: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.03 },
      ],
      filter: { type: 'highpass', cutoff: 4000, Q: 0.8 },
      envelope: { attack: 0.001, decay: 0.006, sustain: 0.0, release: 0.003 },
    },
  },

  // Cherry MX Brown: tactile bump — gentle bump click, moderate thock
  'cherry-mx-brown': {
    press: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.1 },
        { waveform: 'sine', frequency: 130, amplitude: 0.04 },
      ],
      filter: { type: 'bandpass', cutoff: 3500, Q: 1.3 },
      envelope: { attack: 0.001, decay: 0.014, sustain: 0.0, release: 0.007 },
    },
    release: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.05 },
      ],
      filter: { type: 'highpass', cutoff: 3500, Q: 1.0 },
      envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
    },
  },

  // Topre: rubber dome + capacitive — deep soft thock, very muted
  'topre': {
    press: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.06 },
        { waveform: 'sine', frequency: 80, amplitude: 0.05 },
      ],
      filter: { type: 'lowpass', cutoff: 2000, Q: 0.8 },
      envelope: { attack: 0.001, decay: 0.02, sustain: 0.0, release: 0.01 },
    },
    release: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.03 },
      ],
      filter: { type: 'bandpass', cutoff: 2500, Q: 1.0 },
      envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
    },
  },

  // Buckling Spring (IBM Model M): loud metallic ping + spring rattle
  'buckling-spring': {
    press: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.15 },
        { waveform: 'sine', frequency: 220, amplitude: 0.06 },
        { waveform: 'sine', frequency: 440, amplitude: 0.03 },
      ],
      filter: { type: 'bandpass', cutoff: 5000, Q: 2.0 },
      envelope: { attack: 0.001, decay: 0.022, sustain: 0.0, release: 0.012 },
    },
    release: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.1 },
        { waveform: 'sine', frequency: 300, amplitude: 0.03 },
      ],
      filter: { type: 'bandpass', cutoff: 4500, Q: 1.5 },
      envelope: { attack: 0.001, decay: 0.015, sustain: 0.0, release: 0.008 },
    },
  },

  // Membrane: soft mushy press — very quiet, dampened
  'membrane': {
    press: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.04 },
        { waveform: 'sine', frequency: 70, amplitude: 0.02 },
      ],
      filter: { type: 'lowpass', cutoff: 1500, Q: 0.6 },
      envelope: { attack: 0.002, decay: 0.015, sustain: 0.0, release: 0.008 },
    },
    release: {
      oscillators: [
        { waveform: 'white-noise', frequency: 0, amplitude: 0.02 },
      ],
      filter: { type: 'lowpass', cutoff: 1200, Q: 0.5 },
      envelope: { attack: 0.002, decay: 0.01, sustain: 0.0, release: 0.005 },
    },
  },
};

// ─── Sound Engine ─────────────────────────────────────────────────

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private config: SoundConfig = { ...DEFAULT_SOUND_CONFIG };
  private patches: Record<string, SoundPatch> = { ...KRYPTON_CYBER };

  // ─── Sound theme state ────────────────────────────────────────
  private activeTheme: ActiveSoundTheme = { type: 'patches', patches: KRYPTON_CYBER };
  /** Ghost-signal proxy context (wraps real ctx with volume-controlled destination) */
  private ghostSignalCtx: AudioContext | null = null;
  private ghostSignalGain: GainNode | null = null;

  // ─── Sound queue / overlap management ─────────────────────────
  /** Max concurrent synthesized sounds. Beyond this, new sounds are dropped. */
  private static readonly MAX_CONCURRENT = 8;
  /** Minimum interval (ms) between keypress sounds to avoid stacking during fast typing */
  private static readonly KEYPRESS_THROTTLE_MS = 25;
  /** Per-event cooldown (ms) — same action event won't re-fire within this window */
  private static readonly EVENT_COOLDOWN_MS = 50;

  /** Currently playing sound IDs — use Set for accurate tracking without timer drift */
  private activeSoundIds: Set<number> = new Set();
  /** Monotonically increasing ID for each sound instance */
  private nextSoundId = 0;
  /** Timestamp of the last keypress sound (press phase) */
  private lastKeypressTime = 0;
  /** Last fire time per action event for dedup */
  private lastEventTime: Map<string, number> = new Map();

  /** Flag to prevent play() during async theme loading */
  private themeLoading = false;

  /**
   * Apply sound configuration. Call after loading config from backend.
   * If the pack changed, triggers async theme loading.
   */
  applyConfig(config: SoundConfig): void {
    const oldPack = this.config.pack;
    this.config = { ...DEFAULT_SOUND_CONFIG, ...config };
    // Update master volume if context is live
    if (this.masterGain) {
      this.masterGain.gain.value = this.config.volume;
    }
    // Update ghost-signal gain if active
    if (this.ghostSignalGain) {
      this.ghostSignalGain.gain.value = this.config.volume;
    }
    // Reload theme if pack changed
    if (this.config.pack !== oldPack) {
      this.themeLoading = true;
      this.loadTheme(this.config.pack)
        .catch((err) => console.warn('Sound theme loading failed:', err))
        .finally(() => { this.themeLoading = false; });
    }
  }

  /**
   * Load a sound theme by name. Async — resolves built-in or custom themes.
   * Falls back to krypton-cyber if loading fails.
   */
  async loadTheme(packName: string): Promise<void> {
    // krypton-cyber is the built-in patch-based theme
    if (packName === 'krypton-cyber') {
      this.activeTheme = { type: 'patches', patches: KRYPTON_CYBER };
      this.patches = { ...KRYPTON_CYBER };
      this.ghostSignalCtx = null;
      this.ghostSignalGain = null;
      return;
    }

    // Try ghost-signal built-in themes
    const loader = GHOST_SIGNAL_THEMES[packName];
    if (loader) {
      try {
        const theme = await loader();
        this.activateGhostSignalTheme(theme);
        return;
      } catch (err) {
        console.warn(`Failed to load sound theme "${packName}":`, err);
      }
    }

    // Unknown theme — fallback to krypton-cyber
    console.warn(`Unknown sound pack "${packName}", falling back to krypton-cyber`);
    this.activeTheme = { type: 'patches', patches: KRYPTON_CYBER };
    this.patches = { ...KRYPTON_CYBER };
    this.ghostSignalCtx = null;
    this.ghostSignalGain = null;
  }

  /**
   * Activate a ghost-signal theme: create proxy context and sound functions.
   */
  private activateGhostSignalTheme(theme: GhostSignalTheme): void {
    this.ensureContext();
    if (!this.ctx || !this.compressor) return;

    // Create a master gain node for ghost-signal volume control.
    // Route through the compressor for clipping protection and consistent
    // loudness with patch-based sounds: gsGain -> compressor -> masterGain -> destination
    const gsGain = this.ctx.createGain();
    gsGain.gain.value = this.config.volume;
    gsGain.connect(this.compressor);
    this.ghostSignalGain = gsGain;

    // Create a proxy context where .destination points to our gain node
    // This gives us volume control without modifying ghost-signal theme code
    const realCtx = this.ctx;
    const proxyCtx = new Proxy(realCtx, {
      get(target: AudioContext, prop: string | symbol): unknown {
        if (prop === 'destination') return gsGain;
        const val = Reflect.get(target, prop);
        return typeof val === 'function' ? (val as Function).bind(target) : val;
      },
    }) as AudioContext;
    this.ghostSignalCtx = proxyCtx;

    // Create noiseBuffer helper for ghost-signal themes
    const noiseBuffer = (duration = 0.1): AudioBuffer => {
      const len = realCtx.sampleRate * duration;
      const buf = realCtx.createBuffer(1, len, realCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    };

    // Initialize the theme's sound functions
    const sounds = theme.createSounds(proxyCtx, noiseBuffer);
    this.activeTheme = { type: 'ghost-signal', sounds, theme };
  }

  /**
   * Get list of available sound theme names.
   */
  getAvailableThemes(): string[] {
    return ['krypton-cyber', ...Object.keys(GHOST_SIGNAL_THEMES)];
  }

  /**
   * Get the display name of a sound theme.
   */
  getThemeDisplayName(packName: string): string {
    if (packName === 'krypton-cyber') return 'Krypton Cyber';
    if (packName in GHOST_SIGNAL_THEMES) {
      // Return a formatted version of the pack name
      return packName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
    return packName;
  }

  /**
   * Get the current active pack name.
   */
  getCurrentPack(): string {
    return this.config.pack;
  }

  /**
   * Track a new active sound. Returns the sound ID.
   * For ghost-signal sounds: auto-untrack after fallbackMs (since we can't hook node events).
   * For patch-based sounds: untrack explicitly via untrackSound() in the 'ended' event listener.
   */
  private trackSound(fallbackMs: number): number {
    const id = this.nextSoundId++;
    this.activeSoundIds.add(id);
    // Safety net: always untrack after fallback timeout to prevent counter leaks
    setTimeout(() => {
      this.activeSoundIds.delete(id);
    }, fallbackMs);
    return id;
  }

  /**
   * Explicitly untrack a sound (called from oscillator 'ended' event).
   * No-op if already removed by the safety-net timeout.
   */
  private untrackSound(id: number): void {
    this.activeSoundIds.delete(id);
  }

  /**
   * Play a keypress sound (press or release).
   * For patch-based themes: uses the configured keyboard_type to select the patch set.
   * For ghost-signal themes: routes to the appropriate TYPING_* sound based on key.
   * Throttled: skips if previous press is still within throttle window.
   */
  playKeypress(phase: 'press' | 'release', key?: string): void {
    if (!this.config.enabled || this.themeLoading) return;

    // Check per-event override for keypress
    const eventConfig = this.config.events['keypress'];
    if (eventConfig === false) return;

    // Throttle: skip if too soon after last press
    const now = performance.now();
    if (phase === 'press') {
      if (now - this.lastKeypressTime < SoundEngine.KEYPRESS_THROTTLE_MS) return;
      this.lastKeypressTime = now;
    }

    // Max concurrent check
    if (this.activeSoundIds.size >= SoundEngine.MAX_CONCURRENT) return;

    // ─── Ghost-signal theme: use TYPING_* functions ───
    if (this.activeTheme.type === 'ghost-signal') {
      // Ghost-signal themes have no key-release sounds
      if (phase === 'release') return;

      const sounds = this.activeTheme.sounds;
      let soundId: string;
      if (key === 'Backspace') {
        soundId = 'TYPING_BACKSPACE';
      } else if (key === 'Enter') {
        soundId = 'TYPING_ENTER';
      } else if (key === ' ') {
        soundId = 'TYPING_SPACE';
      } else {
        soundId = 'TYPING_LETTER';
      }

      const fn = sounds[soundId];
      if (fn) {
        const id = this.trackSound(200);
        fn();
        void id; // sound tracked via trackSound timeout
      }
      return;
    }

    // ─── Patch-based theme: use keyboard_type ───
    const kbType = this.config.keyboard_type;
    if (kbType === 'none') return;

    // Validate keyboard type is a known key
    if (!(kbType in KEYBOARD_PATCHES)) return;
    const patchSet = KEYBOARD_PATCHES[kbType as Exclude<KeyboardType, 'none'>];

    const basePatch = phase === 'press' ? patchSet.press : patchSet.release;

    // Determine volume: keyboard_volume * per-event override
    let volume = this.config.keyboard_volume;
    if (typeof eventConfig === 'number') {
      volume *= Math.max(0, Math.min(1, eventConfig));
    }

    // Add subtle randomization for natural feel:
    // +/-8% amplitude variation, +/-3% filter cutoff variation
    const ampJitter = 0.92 + Math.random() * 0.16;    // 0.92 – 1.08
    const cutoffJitter = 0.97 + Math.random() * 0.06;  // 0.97 – 1.03

    const patch: SoundPatch = {
      ...basePatch,
      oscillators: basePatch.oscillators.map((osc) => ({
        ...osc,
        amplitude: osc.amplitude * ampJitter,
      })),
      filter: basePatch.filter
        ? { ...basePatch.filter, cutoff: basePatch.filter.cutoff * cutoffJitter }
        : undefined,
    };

    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    this.synthesize(patch, volume);
  }

  /**
   * Play a sound event. Non-blocking — schedules audio via Web Audio API timing.
   * Gracefully no-ops if sound is disabled, event is disabled, or AudioContext unavailable.
   * Deduplicates: skips if the same event fired within the cooldown window.
   */
  play(event: SoundEvent): void {
    if (!this.config.enabled || this.themeLoading) return;

    // Check per-event override
    const eventConfig = this.config.events[event];
    if (eventConfig === false) return;

    // Cooldown dedup: skip if same event fired too recently
    const now = performance.now();
    const lastTime = this.lastEventTime.get(event) ?? 0;
    if (now - lastTime < SoundEngine.EVENT_COOLDOWN_MS) return;
    this.lastEventTime.set(event, now);

    // Max concurrent check
    if (this.activeSoundIds.size >= SoundEngine.MAX_CONCURRENT) return;

    // ─── Ghost-signal theme: use event map ───
    if (this.activeTheme.type === 'ghost-signal') {
      const ghostSoundId = GHOST_SIGNAL_EVENT_MAP[event];
      if (!ghostSoundId) return;
      const fn = this.activeTheme.sounds[ghostSoundId];
      if (!fn) return;

      // APP_START sounds are 1.2-1.4 s; all others are very short
      const timeout = ghostSoundId === 'APP_START' ? 1500 : 300;
      this.trackSound(timeout);
      fn();
      return;
    }

    // ─── Patch-based theme: synthesize from patch definition ───
    const patch = this.patches[event];
    if (!patch) return;

    // Determine volume for this event
    let eventVolume = 1.0;
    if (typeof eventConfig === 'number') {
      eventVolume = Math.max(0, Math.min(1, eventConfig));
    }

    // Lazily initialize AudioContext on first play
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    this.synthesize(patch, eventVolume);
  }

  /**
   * Lazily create AudioContext and master channel.
   * Called on first play() to comply with browser autoplay policy.
   */
  private ensureContext(): void {
    if (this.ctx) {
      // Resume if suspended (browser autoplay policy may suspend context)
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => { /* best-effort resume */ });
      }
      return;
    }

    try {
      this.ctx = new AudioContext();

      // Resume immediately — some WebViews create contexts in suspended state
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => { /* best-effort resume */ });
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
    } catch {
      // Web Audio API unavailable — silent degradation
      this.ctx = null;
      this.masterGain = null;
      this.compressor = null;
    }
  }

  /**
   * Synthesize and play a sound patch.
   * Creates an ephemeral audio subgraph: oscillators -> filter -> envelope -> effects -> master.
   */
  private synthesize(patch: SoundPatch, eventVolume: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const env = patch.envelope;
    const totalDuration = env.attack + env.decay + env.sustain * 0.1 + env.release + 0.05;
    const endTime = now + totalDuration;

    // Track active sound — use 'ended' event on first oscillator for accurate cleanup,
    // with a safety-net timeout in case the event doesn't fire
    const soundId = this.trackSound(totalDuration * 1000 + 500);

    // ─── Build oscillator sources ───

    const oscNodes: Array<OscillatorNode | AudioBufferSourceNode> = [];
    const oscGains: GainNode[] = [];

    for (const oscDef of patch.oscillators) {
      let source: OscillatorNode | AudioBufferSourceNode;
      const oscGain = ctx.createGain();
      oscGain.gain.value = oscDef.amplitude * eventVolume;

      if (oscDef.waveform === 'white-noise' || oscDef.waveform === 'pink-noise') {
        // Noise generator
        source = this.createNoiseSource(ctx, oscDef.waveform, totalDuration);
      } else {
        // Standard oscillator
        const osc = ctx.createOscillator();
        osc.type = oscDef.waveform;
        osc.frequency.setValueAtTime(oscDef.frequency, now);

        if (oscDef.detune) {
          osc.detune.setValueAtTime(oscDef.detune, now);
        }

        // Pitch envelope
        if (oscDef.pitchEnvelope) {
          const pe = oscDef.pitchEnvelope;
          osc.frequency.setValueAtTime(pe.start, now);
          osc.frequency.linearRampToValueAtTime(pe.end, now + pe.duration);
        }

        source = osc;
      }

      source.connect(oscGain);
      oscNodes.push(source);
      oscGains.push(oscGain);
    }

    // ─── FM synthesis ───
    // Wire FM modulators: modulator output -> gain (depth) -> carrier frequency
    for (let i = 0; i < patch.oscillators.length; i++) {
      const oscDef = patch.oscillators[i];
      if (oscDef.fm && oscDef.fm.modulatorIndex < oscNodes.length) {
        const modNode = oscNodes[oscDef.fm.modulatorIndex];
        const carrier = oscNodes[i];
        if (modNode instanceof OscillatorNode && carrier instanceof OscillatorNode) {
          const fmGain = ctx.createGain();
          fmGain.gain.value = oscDef.fm.depth;
          // Disconnect modulator from its own oscGain for FM routing
          // (it still plays through its own gain for additive mix)
          modNode.connect(fmGain);
          fmGain.connect(carrier.frequency);
        }
      }
    }

    // ─── Mix oscillators into a bus ───

    const busMerge = ctx.createGain();
    busMerge.gain.value = 1.0;
    for (const oscGain of oscGains) {
      oscGain.connect(busMerge);
    }

    // ─── Subtractive filter ───

    let filteredOutput: AudioNode = busMerge;
    if (patch.filter) {
      const bqf = ctx.createBiquadFilter();
      bqf.type = patch.filter.type;
      bqf.frequency.setValueAtTime(patch.filter.cutoff, now);
      bqf.Q.setValueAtTime(patch.filter.Q, now);

      if (patch.filter.envelope) {
        const fe = patch.filter.envelope;
        bqf.frequency.setValueAtTime(fe.start, now);
        bqf.frequency.linearRampToValueAtTime(fe.end, now + fe.duration);
      }

      busMerge.connect(bqf);
      filteredOutput = bqf;
    }

    // ─── ADSR amplitude envelope ───

    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0.0001, now);
    // Attack
    envGain.gain.linearRampToValueAtTime(1.0, now + env.attack);
    // Decay -> Sustain
    envGain.gain.linearRampToValueAtTime(
      Math.max(0.0001, env.sustain),
      now + env.attack + env.decay,
    );
    // Release
    const releaseStart = now + env.attack + env.decay + env.sustain * 0.1;
    envGain.gain.setValueAtTime(Math.max(0.0001, env.sustain), releaseStart);
    envGain.gain.linearRampToValueAtTime(0.0001, releaseStart + env.release);

    filteredOutput.connect(envGain);

    // ─── Effects chain ───

    let effectsOutput: AudioNode = envGain;

    if (patch.effects) {
      // Delay
      if (patch.effects.delay) {
        const delay = ctx.createDelay(1.0);
        delay.delayTime.value = patch.effects.delay.time;

        const feedbackGain = ctx.createGain();
        feedbackGain.gain.value = patch.effects.delay.feedback;

        const dryGain = ctx.createGain();
        dryGain.gain.value = 1.0;
        const wetGain = ctx.createGain();
        wetGain.gain.value = 0.3;

        const delayMerge = ctx.createGain();

        effectsOutput.connect(dryGain);
        effectsOutput.connect(delay);
        delay.connect(feedbackGain);
        feedbackGain.connect(delay);
        delay.connect(wetGain);

        dryGain.connect(delayMerge);
        wetGain.connect(delayMerge);
        effectsOutput = delayMerge;
      }

      // Distortion
      if (patch.effects.distortion) {
        const shaper = ctx.createWaveShaper();
        shaper.curve = this.makeDistortionCurve(patch.effects.distortion.amount);
        shaper.oversample = '2x';
        effectsOutput.connect(shaper);
        effectsOutput = shaper;
      }
    }

    // ─── Stereo pan ───

    let panOutput: AudioNode = effectsOutput;
    if (patch.pan !== undefined && patch.pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = patch.pan;
      effectsOutput.connect(panner);
      panOutput = panner;
    }

    // ─── Connect to master ───

    panOutput.connect(this.compressor!);

    // ─── Start, schedule stop, and set up cleanup via 'ended' event ───

    const cleanupNodes = (): void => {
      this.untrackSound(soundId);
      for (const source of oscNodes) {
        try { source.disconnect(); } catch { /* already disconnected */ }
      }
      for (const g of oscGains) {
        try { g.disconnect(); } catch { /* already disconnected */ }
      }
      try { busMerge.disconnect(); } catch { /* ok */ }
      try { envGain.disconnect(); } catch { /* ok */ }
    };

    let cleanedUp = false;
    for (const source of oscNodes) {
      source.start(now);
      source.stop(endTime);
      // Use 'ended' event on the first oscillator for precise cleanup timing
      if (!cleanedUp) {
        cleanedUp = true;
        source.addEventListener('ended', cleanupNodes, { once: true });
      }
    }
  }

  /**
   * Create a noise source (white or pink noise) as an AudioBufferSourceNode.
   */
  private createNoiseSource(
    ctx: AudioContext,
    type: 'white-noise' | 'pink-noise',
    duration: number,
  ): AudioBufferSourceNode {
    const sampleRate = ctx.sampleRate;
    const length = Math.ceil(sampleRate * Math.max(duration, 0.1));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    if (type === 'white-noise') {
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    } else {
      // Pink noise using Paul Kellet's algorithm
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    return source;
  }

  /**
   * Generate a distortion curve for WaveShaperNode.
   */
  private makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
    const samples = 256;
    const curve = new Float32Array(samples) as Float32Array<ArrayBuffer>;
    const k = amount * 50;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }
}
