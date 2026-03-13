// ═══════════════════════════════════════════════════════════════════
// DEEP GLYPH — sound theme for Krypton
// Midnight-code audio theme — Web Audio API synthesis
// Adapted from ghost-signal project
// ═══════════════════════════════════════════════════════════════════

import type { GhostSignalTheme } from './types';

const meta = {
  name: 'Deep Glyph',
  subtitle: 'Midnight-code audio theme \u2014 Web Audio API synthesis',
  colors: {
    accent:   '#4DE8E0',
    accent2:  '#7BF090',
    danger:   '#E85A6E',
    bg:       '#0A0E1A',
    surface:  '#121829',
    surface2: '#1A2238',
    border:   '#2A3550',
    text:     '#C8D6E5',
    textDim:  '#5E7290',
  },
  placeholder: 'Type something... each glyph has its own resonance...',
  sounds: {
    HOVER:            { label: 'Hover',            meta: '65ms / 800 Hz / additive sine',  desc: 'Holographic shimmer \u2014 glyph brightens under cursor' },
    HOVER_UP:         { label: 'Hover Up',         meta: '55ms / 860 Hz / additive sine',  desc: 'Glyph dimming \u2014 downward dissolve on cursor leave' },
    CLICK:            { label: 'Click',            meta: '40ms / 520 Hz / 3 partials',     desc: 'Glass key press \u2014 crystalline snap' },
    IMPORTANT_CLICK:  { label: 'Important Click',  meta: '130ms / 320 Hz / 4 partials',    desc: 'Execute command \u2014 sub-bass thud + harmonic bloom' },
    FEATURE_SWITCH_ON:{ label: 'Feature Switch',   meta: '280ms ON / 260ms OFF',           desc: 'Code module online \u2014 partials ignite in sequence' },
    LIMITER_ON:       { label: 'Limiter',          meta: '200ms ON / 200ms OFF',           desc: 'Breakpoint clamp \u2014 partials squeeze together' },
    SWITCH_TOGGLE:    { label: 'Switch Toggle',    meta: '40ms \u2014 beating pair',            desc: 'Bit flip \u2014 two-frequency interference blip' },
    TAB_INSERT:       { label: 'Tab Insert',       meta: '110ms / 3 ascending chords',     desc: 'New buffer \u2014 additive chords cascade up' },
    TAB_CLOSE:        { label: 'Tab Close',        meta: '95ms / 3 descending chords',     desc: 'Buffer close \u2014 chords collapse down' },
    TAB_SLASH:        { label: 'Tab Slash',        meta: '170ms / 600 Hz / harmonic bloom', desc: 'Command palette \u2014 bright ping with spectral tail' },
    TYPING_LETTER:    { label: 'Typing Letter',    meta: '30ms / 15 variants',             desc: 'Holo-key pip \u2014 each glyph resonates differently' },
    TYPING_BACKSPACE: { label: 'Typing Backspace',  meta: '35ms / 380 Hz sweep down',      desc: 'Glyph de-rez \u2014 lower, retracting' },
    TYPING_ENTER:     { label: 'Typing Enter',     meta: '85ms / 300 Hz / 4 partials',     desc: 'Line commit \u2014 heavy thud with shimmer tail' },
    TYPING_SPACE:     { label: 'Typing Space',     meta: '35ms / 420 Hz / wide spread',    desc: 'Space glyph \u2014 broad, hollow, airy' },
    APP_START:        { label: 'App Start',        meta: '1300ms / 6 partials sequential',  desc: 'IDE awakening \u2014 partials fade in like lines of code' },
  },
};

// ═══════════════════════════════════════════════════════════════════
// SONIC DNA
// ═══════════════════════════════════════════════════════════════════
// Primary waveform:    Additive sine partials (3-6 harmonics summed)
// Signature effect:    Comb filter resonance (short delay feedback)
// Transient character: Granular noise bursts (bandpass micro-grains, 5-8ms)
// Envelope philosophy: Staccato body + spectral tail (fast decay, partials linger)
// Frequency world:     Wide partials spread (fundamentals 150-600Hz, harmonics to 6kHz)
// ═══════════════════════════════════════════════════════════════════

function createSounds(ctx: AudioContext, noiseBuffer: (duration?: number) => AudioBuffer): Record<string, () => void> {
  const sounds: Record<string, () => void> = {};

  // Helper: create a comb filter (delay + feedback loop)
  function combFilter(input: GainNode, delayTime: number, feedback: number): GainNode {
    const delay = ctx.createDelay();
    delay.delayTime.value = delayTime;
    const fbGain = ctx.createGain();
    fbGain.gain.value = feedback;
    const output = ctx.createGain();
    output.gain.value = 1.0;
    input.connect(output);
    input.connect(delay);
    delay.connect(fbGain);
    fbGain.connect(delay);
    delay.connect(output);
    return output;
  }

  // Helper: create a granular noise burst
  function grainBurst(now: number, freq: number, q: number, gain: number, dur: number): void {
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(dur + 0.005);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(gain, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + dur);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + dur + 0.005);
  }

  // ---------------------------------------------------------------
  // 1. HOVER — holographic shimmer, 65ms
  // ---------------------------------------------------------------
  sounds.HOVER = function() {
    const now = ctx.currentTime;

    // Fundamental 800 Hz sweeping up
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(800, now);
    osc1.frequency.linearRampToValueAtTime(860, now + 0.065);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.08, now + 0.003);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.065);

    // 3rd partial 2400 Hz sweeping up
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(2400, now);
    osc2.frequency.linearRampToValueAtTime(2460, now + 0.065);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(0.04, now + 0.003);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.065);

    // Sum into comb filter
    const sum = ctx.createGain();
    sum.gain.value = 1.0;
    osc1.connect(g1).connect(sum);
    osc2.connect(g2).connect(sum);
    const comb = combFilter(sum, 0.002, 0.3);
    comb.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.07);
    osc2.start(now);
    osc2.stop(now + 0.07);

    // Granular noise
    grainBurst(now, 4000, 3, 0.03, 0.015);
  };

  // ---------------------------------------------------------------
  // 2. HOVER_UP — glyph dimming, 55ms
  // ---------------------------------------------------------------
  sounds.HOVER_UP = function() {
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(860, now);
    osc1.frequency.linearRampToValueAtTime(750, now + 0.055);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.08, now + 0.002);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(2580, now);
    osc2.frequency.linearRampToValueAtTime(2250, now + 0.055);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(0.04, now + 0.002);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

    const sum = ctx.createGain();
    sum.gain.value = 1.0;
    osc1.connect(g1).connect(sum);
    osc2.connect(g2).connect(sum);
    const comb = combFilter(sum, 0.0025, 0.25);
    comb.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.06);
    osc2.start(now);
    osc2.stop(now + 0.06);

    grainBurst(now, 3500, 2.5, 0.025, 0.012);
  };

  // ---------------------------------------------------------------
  // 3. CLICK — glass key press, 40ms
  // ---------------------------------------------------------------
  sounds.CLICK = function() {
    const now = ctx.currentTime;

    // 3 partials: 520, 1040, 2600
    const freqs = [520, 1040, 2600];
    const gains = [0.15, 0.08, 0.04];
    const decays = [0.025, 0.025, 0.04]; // spectral tail on upper

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gains[i], now + 0.001);
      g.gain.exponentialRampToValueAtTime(0.001, now + decays[i]);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + decays[i] + 0.005);
    });

    const comb = combFilter(sum, 0.0015, 0.35);
    comb.connect(ctx.destination);

    // Granular noise burst
    grainBurst(now, 3000, 4, 0.12, 0.006);
  };

  // ---------------------------------------------------------------
  // 4. IMPORTANT_CLICK — execute command, 130ms
  // ---------------------------------------------------------------
  sounds.IMPORTANT_CLICK = function() {
    const now = ctx.currentTime;

    // 4 partials + sub-bass
    const freqs = [320, 640, 1600, 3200];
    const gains = [0.18, 0.10, 0.06, 0.03];
    const decays = [0.06, 0.06, 0.13, 0.13]; // body vs tail

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gains[i], now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, now + decays[i]);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + decays[i] + 0.005);
    });

    // Sub-bass
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 80;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0, now);
    sG.gain.linearRampToValueAtTime(0.12, now + 0.002);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now);
    sub.stop(now + 0.085);

    const comb = combFilter(sum, 0.003, 0.45);
    comb.connect(ctx.destination);

    grainBurst(now, 2500, 3, 0.14, 0.008);
  };

  // ---------------------------------------------------------------
  // 5. FEATURE_SWITCH_ON — module online, 280ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_ON = function() {
    const now = ctx.currentTime;

    // 5 partials staggered ascending
    const partials = [220, 440, 880, 1320, 2200];
    const offsets = [0, 0.02, 0.04, 0.06, 0.08];

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    partials.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const t = now + offsets[i];
      g.gain.setValueAtTime(0, now);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(t + 0.205);
    });

    // Comb filter with decaying feedback
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.002;
    const fbG = ctx.createGain();
    fbG.gain.setValueAtTime(0.5, now);
    fbG.gain.linearRampToValueAtTime(0.2, now + 0.25);
    const output = ctx.createGain();
    output.gain.value = 1.0;
    sum.connect(output);
    sum.connect(delay);
    delay.connect(fbG);
    fbG.connect(delay);
    delay.connect(output);

    // LP sweep opening
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1500, now);
    lp.frequency.linearRampToValueAtTime(5000, now + 0.25);
    lp.Q.value = 2;
    output.connect(lp).connect(ctx.destination);

    grainBurst(now, 2000, 2, 0.08, 0.007);
  };

  // ---------------------------------------------------------------
  // 6. FEATURE_SWITCH_OFF — module offline, 260ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_OFF = function() {
    const now = ctx.currentTime;

    // 5 partials staggered descending
    const partials = [2200, 1320, 880, 440, 220];
    const offsets = [0, 0.02, 0.04, 0.06, 0.08];

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    partials.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const t = now + offsets[i];
      g.gain.setValueAtTime(0, now);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.10, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(t + 0.185);
    });

    // Comb with rising feedback
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.002;
    const fbG = ctx.createGain();
    fbG.gain.setValueAtTime(0.2, now);
    fbG.gain.linearRampToValueAtTime(0.5, now + 0.24);
    const output = ctx.createGain();
    output.gain.value = 1.0;
    sum.connect(output);
    sum.connect(delay);
    delay.connect(fbG);
    fbG.connect(delay);
    delay.connect(output);

    // LP sweep closing
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5000, now);
    lp.frequency.linearRampToValueAtTime(800, now + 0.24);
    lp.Q.value = 2;
    output.connect(lp).connect(ctx.destination);

    grainBurst(now, 3000, 2, 0.06, 0.006);
  };

  // ---------------------------------------------------------------
  // 7. LIMITER_ON — breakpoint clamp, 200ms
  // ---------------------------------------------------------------
  sounds.LIMITER_ON = function() {
    const now = ctx.currentTime;

    // 3 partials converging inward
    const starts = [400, 800, 1200];
    const ends = [400, 550, 500];
    const gains = [0.10, 0.10, 0.10];

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    starts.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now);
      osc.frequency.linearRampToValueAtTime(ends[i], now + 0.15);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gains[i], now + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + 0.205);
    });

    const comb = combFilter(sum, 0.001, 0.55);
    comb.connect(ctx.destination);

    // Noise burst — high-pass
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.013);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.10, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.008);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.013);
  };

  // ---------------------------------------------------------------
  // 8. LIMITER_OFF — breakpoint release, 200ms
  // ---------------------------------------------------------------
  sounds.LIMITER_OFF = function() {
    const now = ctx.currentTime;

    // 3 partials bursting outward
    const starts = [480, 500, 520];
    const ends = [400, 800, 1300];
    const decays = [0.06, 0.2, 0.2]; // body vs tails

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    starts.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now);
      osc.frequency.linearRampToValueAtTime(ends[i], now + 0.15);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.10, now + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, now + decays[i]);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + decays[i] + 0.005);
    });

    const comb = combFilter(sum, 0.0015, 0.4);
    comb.connect(ctx.destination);

    grainBurst(now, 3500, 3, 0.08, 0.007);
  };

  // ---------------------------------------------------------------
  // 9. SWITCH_TOGGLE — bit flip, 40ms
  // ---------------------------------------------------------------
  sounds.SWITCH_TOGGLE = function() {
    const now = ctx.currentTime;

    // Two close frequencies for beating
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 660;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 670;

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.07, now + 0.001);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(0.07, now + 0.001);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc1.connect(g1).connect(sum);
    osc2.connect(g2).connect(sum);

    const comb = combFilter(sum, 0.0012, 0.3);
    comb.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.045);
    osc2.start(now);
    osc2.stop(now + 0.045);
  };

  // ---------------------------------------------------------------
  // 10. TAB_INSERT — new buffer, 110ms (3 ascending chords)
  // ---------------------------------------------------------------
  sounds.TAB_INSERT = function() {
    const now = ctx.currentTime;

    const chords = [
      { freqs: [350, 700], t: 0 },
      { freqs: [500, 1000], t: 0.018 },
      { freqs: [700, 1400], t: 0.036 },
    ];

    chords.forEach((chord) => {
      const t = now + chord.t;
      chord.freqs.forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.12, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

        const delay = ctx.createDelay();
        delay.delayTime.value = 0.002;
        const fbG = ctx.createGain();
        fbG.gain.value = 0.35;
        const out = ctx.createGain();
        out.gain.value = 1.0;
        osc.connect(g).connect(out);
        g.connect(delay);
        delay.connect(fbG);
        fbG.connect(delay);
        delay.connect(out);
        out.connect(ctx.destination);

        osc.start(t);
        osc.stop(t + 0.045);
      });
      grainBurst(t, 4000, 3, 0.05, 0.005);
    });
  };

  // ---------------------------------------------------------------
  // 11. TAB_CLOSE — buffer close, 95ms (3 descending chords)
  // ---------------------------------------------------------------
  sounds.TAB_CLOSE = function() {
    const now = ctx.currentTime;

    const chords = [
      { freqs: [700, 1400], t: 0 },
      { freqs: [500, 1000], t: 0.015 },
      { freqs: [350, 700], t: 0.030 },
    ];

    chords.forEach((chord) => {
      const t = now + chord.t;
      chord.freqs.forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.10, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

        const delay = ctx.createDelay();
        delay.delayTime.value = 0.002;
        const fbG = ctx.createGain();
        fbG.gain.value = 0.3;
        const out = ctx.createGain();
        out.gain.value = 1.0;
        osc.connect(g).connect(out);
        g.connect(delay);
        delay.connect(fbG);
        fbG.connect(delay);
        delay.connect(out);
        out.connect(ctx.destination);

        osc.start(t);
        osc.stop(t + 0.04);
      });
      grainBurst(t, 3500, 3, 0.04, 0.005);
    });
  };

  // ---------------------------------------------------------------
  // 12. TAB_SLASH — command palette, 170ms
  // ---------------------------------------------------------------
  sounds.TAB_SLASH = function() {
    const now = ctx.currentTime;

    // 4 partials: body pair + shimmer pair
    const bodyFreqs = [600, 900];
    const shimmerFreqs = [1500, 3000];

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    bodyFreqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const gain = i === 0 ? 0.14 : 0.10;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gain, now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + 0.065);
    });

    shimmerFreqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const gain = i === 0 ? 0.07 : 0.04;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gain, now + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.17);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + 0.175);
    });

    // Comb filter
    const comb = combFilter(sum, 0.0018, 0.5);

    // LP sweep opening
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2000, now);
    lp.frequency.linearRampToValueAtTime(6000, now + 0.1);
    lp.Q.value = 1.5;
    comb.connect(lp).connect(ctx.destination);

    grainBurst(now, 5000, 4, 0.08, 0.006);
  };

  // ---------------------------------------------------------------
  // 13. TYPING_LETTER — holo-key pip, 30ms (15 variants)
  // ---------------------------------------------------------------
  sounds.TYPING_LETTER = function() {
    const now = ctx.currentTime;

    // Randomized fundamental from 15-value pool
    const bodyFreq = 500 + Math.floor(Math.random() * 15) * 40;
    const partialFreq = bodyFreq * 2.5;
    const noiseCentre = 3000 + (Math.random() - 0.5) * 2000;

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    // Fundamental
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = bodyFreq;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.10, now + 0.001);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    osc1.connect(g1).connect(sum);

    // Upper partial
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = partialFreq;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(0.04, now + 0.001);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    osc2.connect(g2).connect(sum);

    const comb = combFilter(sum, 0.0015, 0.25);
    comb.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.035);
    osc2.start(now);
    osc2.stop(now + 0.035);

    grainBurst(now, noiseCentre, 3, 0.08, 0.006);
  };

  // ---------------------------------------------------------------
  // 14. TYPING_BACKSPACE — glyph de-rez, 35ms
  // ---------------------------------------------------------------
  sounds.TYPING_BACKSPACE = function() {
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(380, now);
    osc1.frequency.linearRampToValueAtTime(320, now + 0.035);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.08, now + 0.001);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(950, now);
    osc2.frequency.linearRampToValueAtTime(800, now + 0.035);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(0.04, now + 0.001);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

    const sum = ctx.createGain();
    sum.gain.value = 1.0;
    osc1.connect(g1).connect(sum);
    osc2.connect(g2).connect(sum);
    const comb = combFilter(sum, 0.002, 0.2);
    comb.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.04);
    osc2.start(now);
    osc2.stop(now + 0.04);

    grainBurst(now, 2500, 2.5, 0.07, 0.005);
  };

  // ---------------------------------------------------------------
  // 15. TYPING_ENTER — line commit, 85ms
  // ---------------------------------------------------------------
  sounds.TYPING_ENTER = function() {
    const now = ctx.currentTime;

    // 4 partials: body + spectral tail
    const freqs = [300, 600, 1200, 2400];
    const gains = [0.14, 0.08, 0.05, 0.03];
    const decays = [0.045, 0.045, 0.085, 0.085];

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gains[i], now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, now + decays[i]);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + decays[i] + 0.005);
    });

    const comb = combFilter(sum, 0.0025, 0.4);
    comb.connect(ctx.destination);

    grainBurst(now, 2000, 2, 0.12, 0.008);
  };

  // ---------------------------------------------------------------
  // 16. TYPING_SPACE — space glyph, 35ms
  // ---------------------------------------------------------------
  sounds.TYPING_SPACE = function() {
    const now = ctx.currentTime;

    // 3 spread partials
    const freqs = [420, 630, 1260];
    const gains = [0.08, 0.06, 0.03];

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gains[i], now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + 0.04);
    });

    const comb = combFilter(sum, 0.002, 0.2);
    comb.connect(ctx.destination);

    // Wider, more diffuse noise
    grainBurst(now, 2500, 1.5, 0.09, 0.007);
  };

  // ---------------------------------------------------------------
  // 17. APP_START — IDE awakening, 1300ms
  // ---------------------------------------------------------------
  sounds.APP_START = function() {
    const now = ctx.currentTime;

    // 6 partials fading in sequentially
    const partials = [150, 300, 450, 750, 1200, 2400];
    const offsets = [0, 0.15, 0.3, 0.45, 0.6, 0.75];
    const peakGains = [0.08, 0.06, 0.05, 0.04, 0.03, 0.02];

    const sum = ctx.createGain();
    sum.gain.value = 1.0;

    partials.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const t = now + offsets[i];
      g.gain.setValueAtTime(0, now);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peakGains[i], t + 0.2);
      g.gain.setValueAtTime(peakGains[i], t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
      osc.connect(g).connect(sum);
      osc.start(now);
      osc.stop(now + 1.305);
    });

    // Comb filter with decaying feedback
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.003;
    const fbG = ctx.createGain();
    fbG.gain.setValueAtTime(0.5, now);
    fbG.gain.linearRampToValueAtTime(0.1, now + 1.2);
    const output = ctx.createGain();
    output.gain.value = 1.0;
    sum.connect(output);
    sum.connect(delay);
    delay.connect(fbG);
    fbG.connect(delay);
    delay.connect(output);

    // LP sweep opening wide
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, now);
    lp.frequency.linearRampToValueAtTime(6000, now + 0.9);
    lp.Q.value = 1.5;
    output.connect(lp).connect(ctx.destination);

    // Ambient noise bed
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(1.35);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 1;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0, now);
    nG.gain.linearRampToValueAtTime(0.03, now + 0.5);
    nG.gain.setValueAtTime(0.03, now + 0.8);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 1.35);
  };

  return sounds;
}

export default { meta, createSounds } as GhostSignalTheme;
