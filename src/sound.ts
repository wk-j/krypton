// Krypton — Sound Engine
// Procedural sound effects via Web Audio API.
// All sounds synthesized at runtime using additive + subtractive functional synthesis.
// No audio files shipped.

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
  | 'mode.enter'
  | 'mode.exit'
  | 'quick_terminal.show'
  | 'quick_terminal.hide'
  | 'workspace.switch'
  | 'command_palette.open'
  | 'command_palette.close'
  | 'command_palette.execute'
  | 'layout.toggle'
  | 'swap.complete'
  | 'resize.step'
  | 'move.step'
  | 'terminal.bell'
  | 'terminal.exit'
  | 'startup';

/** Sound configuration (mirrors TOML [sound] section) */
export interface SoundConfig {
  enabled: boolean;
  volume: number;
  pack: string;
  events: Record<string, boolean | number>;
}

/** Default sound configuration */
export const DEFAULT_SOUND_CONFIG: SoundConfig = {
  enabled: true,
  volume: 0.15,
  pack: 'krypton-cyber',
  events: {},
};

// ─── Built-in Krypton Cyber Sound Pack ───────────────────────────

const KRYPTON_CYBER: Record<SoundEvent, SoundPatch> = {
  // ─── All sounds modeled after mechanical keyboard clicks ──────
  // Core recipe: filtered noise burst (the "click") + low sine thump (the "thock")
  // Envelopes are ultra-short (2-15ms decay). Everything is quiet and tactile.

  // Window create: firm keypress — click + thock
  'window.create': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.12 },
      { waveform: 'sine', frequency: 120, amplitude: 0.06 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3500, Q: 1.2,
    },
    envelope: { attack: 0.001, decay: 0.015, sustain: 0.0, release: 0.008 },
  },

  // Window close: slightly deeper thock — like bottoming out a key
  'window.close': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.1 },
      { waveform: 'sine', frequency: 80, amplitude: 0.07 },
    ],
    filter: {
      type: 'bandpass', cutoff: 2500, Q: 1.0,
    },
    envelope: { attack: 0.001, decay: 0.018, sustain: 0.0, release: 0.01 },
  },

  // Window focus: light tap — like brushing a keycap
  'window.focus': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.06 },
    ],
    filter: {
      type: 'bandpass', cutoff: 4000, Q: 2.0,
    },
    envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
  },

  // Window maximize: double-click — two rapid taps
  'window.maximize': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.1 },
      { waveform: 'sine', frequency: 100, amplitude: 0.05 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3200, Q: 1.2,
    },
    envelope: { attack: 0.001, decay: 0.012, sustain: 0.0, release: 0.006 },
  },

  // Window restore: softer click
  'window.restore': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.08 },
      { waveform: 'sine', frequency: 90, amplitude: 0.04 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3000, Q: 1.0,
    },
    envelope: { attack: 0.001, decay: 0.012, sustain: 0.0, release: 0.006 },
  },

  // Mode enter: crisp click — like actuating a tactile switch
  'mode.enter': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.1 },
      { waveform: 'sine', frequency: 150, amplitude: 0.04 },
    ],
    filter: {
      type: 'bandpass', cutoff: 4500, Q: 1.5,
    },
    envelope: { attack: 0.001, decay: 0.01, sustain: 0.0, release: 0.005 },
  },

  // Mode exit: soft key release — upstroke sound
  'mode.exit': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.06 },
    ],
    filter: {
      type: 'highpass', cutoff: 3000, Q: 0.8,
    },
    envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
  },

  // Quick Terminal show: firm press with slightly longer body
  'quick_terminal.show': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.1 },
      { waveform: 'sine', frequency: 110, amplitude: 0.06 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3000, Q: 1.0,
    },
    envelope: { attack: 0.001, decay: 0.02, sustain: 0.0, release: 0.01 },
  },

  // Quick Terminal hide: light release click
  'quick_terminal.hide': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.07 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3800, Q: 1.2,
    },
    envelope: { attack: 0.001, decay: 0.01, sustain: 0.0, release: 0.005 },
  },

  // Workspace switch: spacebar thock — deeper, slightly longer
  'workspace.switch': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.1 },
      { waveform: 'sine', frequency: 70, amplitude: 0.08 },
    ],
    filter: {
      type: 'bandpass', cutoff: 2200, Q: 0.8,
    },
    envelope: { attack: 0.001, decay: 0.025, sustain: 0.0, release: 0.012 },
  },

  // Command palette open: modifier key press
  'command_palette.open': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.08 },
      { waveform: 'sine', frequency: 130, amplitude: 0.04 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3200, Q: 1.0,
    },
    envelope: { attack: 0.001, decay: 0.015, sustain: 0.0, release: 0.008 },
  },

  // Command palette close: modifier key release
  'command_palette.close': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.05 },
    ],
    filter: {
      type: 'highpass', cutoff: 3500, Q: 0.8,
    },
    envelope: { attack: 0.001, decay: 0.008, sustain: 0.0, release: 0.004 },
  },

  // Command palette execute: enter key — firm thock
  'command_palette.execute': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.12 },
      { waveform: 'sine', frequency: 90, amplitude: 0.06 },
    ],
    filter: {
      type: 'bandpass', cutoff: 2800, Q: 1.0,
    },
    envelope: { attack: 0.001, decay: 0.02, sustain: 0.0, release: 0.01 },
  },

  // Layout toggle: standard keypress
  'layout.toggle': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.09 },
      { waveform: 'sine', frequency: 110, amplitude: 0.04 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3500, Q: 1.2,
    },
    envelope: { attack: 0.001, decay: 0.012, sustain: 0.0, release: 0.006 },
  },

  // Swap complete: two rapid clicks
  'swap.complete': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.09 },
      { waveform: 'sine', frequency: 100, amplitude: 0.04 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3500, Q: 1.2,
    },
    envelope: { attack: 0.001, decay: 0.01, sustain: 0.0, release: 0.005 },
  },

  // Resize step: tiny tick — like tapping the edge of a keycap
  'resize.step': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.05 },
    ],
    filter: {
      type: 'bandpass', cutoff: 5000, Q: 2.5,
    },
    envelope: { attack: 0.001, decay: 0.005, sustain: 0.0, release: 0.002 },
  },

  // Move step: tiny tick — slightly softer variant
  'move.step': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.04 },
    ],
    filter: {
      type: 'bandpass', cutoff: 4500, Q: 2.0,
    },
    envelope: { attack: 0.001, decay: 0.005, sustain: 0.0, release: 0.002 },
  },

  // Terminal bell: firm click with a bit more body
  'terminal.bell': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.12 },
      { waveform: 'sine', frequency: 140, amplitude: 0.05 },
    ],
    filter: {
      type: 'bandpass', cutoff: 3000, Q: 1.0,
    },
    envelope: { attack: 0.001, decay: 0.02, sustain: 0.0, release: 0.01 },
  },

  // Terminal exit: key release — soft upstroke
  'terminal.exit': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.06 },
      { waveform: 'sine', frequency: 80, amplitude: 0.03 },
    ],
    filter: {
      type: 'bandpass', cutoff: 2800, Q: 1.0,
    },
    envelope: { attack: 0.001, decay: 0.015, sustain: 0.0, release: 0.008 },
  },

  // Startup: spacebar press — the deepest thock
  'startup': {
    oscillators: [
      { waveform: 'white-noise', frequency: 0, amplitude: 0.1 },
      { waveform: 'sine', frequency: 60, amplitude: 0.08 },
    ],
    filter: {
      type: 'bandpass', cutoff: 2000, Q: 0.8,
    },
    envelope: { attack: 0.001, decay: 0.03, sustain: 0.0, release: 0.015 },
  },
};

// ─── Sound Engine ─────────────────────────────────────────────────

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private config: SoundConfig = { ...DEFAULT_SOUND_CONFIG };
  private patches: Record<string, SoundPatch> = { ...KRYPTON_CYBER };

  /**
   * Apply sound configuration. Call after loading config from backend.
   */
  applyConfig(config: SoundConfig): void {
    this.config = { ...DEFAULT_SOUND_CONFIG, ...config };
    // Update master volume if context is live
    if (this.masterGain) {
      this.masterGain.gain.value = this.config.volume;
    }
  }

  /**
   * Play a sound event. Non-blocking — schedules audio via Web Audio API timing.
   * Gracefully no-ops if sound is disabled, event is disabled, or AudioContext unavailable.
   */
  play(event: SoundEvent): void {
    if (!this.config.enabled) return;

    // Check per-event override
    const eventConfig = this.config.events[event];
    if (eventConfig === false) return;

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
    if (this.ctx) return;

    try {
      this.ctx = new AudioContext();

      // Master channel: compressor -> gain -> destination
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -6;
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

    // ─── Start and schedule stop ───

    for (const source of oscNodes) {
      source.start(now);
      source.stop(endTime);
    }

    // Clean up nodes after completion (allow GC)
    setTimeout(() => {
      for (const source of oscNodes) {
        try { source.disconnect(); } catch { /* already disconnected */ }
      }
      for (const g of oscGains) {
        try { g.disconnect(); } catch { /* already disconnected */ }
      }
      try { busMerge.disconnect(); } catch { /* ok */ }
      try { envGain.disconnect(); } catch { /* ok */ }
    }, totalDuration * 1000 + 100);
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
