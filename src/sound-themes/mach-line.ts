// ═══════════════════════════════════════════════════════════════════
// MACH LINE — sound theme for Krypton
// Stealth supersonic audio theme — Web Audio API synthesis
// Adapted from ghost-signal project
// ═══════════════════════════════════════════════════════════════════

import type { GhostSignalTheme } from './types';

const meta = {
  name: 'Mach Line',
  subtitle: 'Stealth supersonic audio theme \u2014 Web Audio API synthesis',
  colors: {
    accent:   '#D4E4F0',
    accent2:  '#3AAFB9',
    danger:   '#C43E3A',
    bg:       '#080C12',
    surface:  '#0E1420',
    surface2: '#162030',
    border:   '#1E2E42',
    text:     '#C8D6E0',
    textDim:  '#5A6E80',
  },
  placeholder: 'Type here \u2014 classified keystrokes on carbon-fiber keys...',
  sounds: {
    HOVER:            { label: 'Hover',          meta: '50 ms / 3 kHz / sine sweep',        desc: 'Radar sweep detection' },
    HOVER_UP:         { label: 'Hover Up',       meta: '40 ms / 4.2 kHz / sine sweep',      desc: 'Radar lock releasing' },
    CLICK:            { label: 'Click',           meta: '30 ms / 600 Hz / square pop',       desc: 'Carbon-fiber relay snap' },
    IMPORTANT_CLICK:  { label: 'Important Click', meta: '140 ms / 350 Hz / triangle body',   desc: 'Weapons release authorisation' },
    FEATURE_SWITCH_ON:{ label: 'Feature Switch',  meta: 'ON 280 ms / OFF 250 ms \u2014 turbine power cycle', desc: '' },
    LIMITER_ON:       { label: 'Limiter',         meta: 'ON 220 ms / OFF 200 ms \u2014 G-force clamp',      desc: '' },
    SWITCH_TOGGLE:    { label: 'Switch Toggle',   meta: '35 ms \u2014 avionics toggle',                     desc: '' },
    TAB_INSERT:       { label: 'Tab Insert',      meta: '110 ms / 3 ascending pips',        desc: 'Radar contact acquired' },
    TAB_CLOSE:        { label: 'Tab Close',       meta: '100 ms / 3 descending pips',       desc: 'Radar contact lost' },
    TAB_SLASH:        { label: 'Tab Slash',       meta: '150 ms / 1500 Hz / triangle ping', desc: 'IFF interrogation' },
    TYPING_LETTER:    { label: 'Typing Letter',   meta: '22 ms / 16 variants',              desc: 'Carbon-fiber key cap' },
    TYPING_BACKSPACE: { label: 'Typing Backspace', meta: '28 ms / square pulse',            desc: 'Data erasure' },
    TYPING_ENTER:     { label: 'Typing Enter',    meta: '90 ms / saw + sub',                desc: 'Mission confirm' },
    TYPING_SPACE:     { label: 'Typing Space',    meta: '28 ms / noise puff',               desc: 'Pressure release' },
  },
};

function createSounds(ctx: AudioContext, noiseBuffer: (duration?: number) => AudioBuffer): Record<string, () => void> {
  const sounds: Record<string, () => void> = {};

  // ---------------------------------------------------------------
  // 1. HOVER — sine sweep 3 kHz → 4.2 kHz, 50 ms
  // ---------------------------------------------------------------
  sounds.HOVER = function() {
    const now = ctx.currentTime;
    const dur = 0.05;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(3000, now);
    osc.frequency.linearRampToValueAtTime(4200, now + dur);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3600;
    bp.Q.value = 10;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.10, now + 0.004);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(dur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const nG = ctx.createGain();
    nG.gain.value = 0.01;

    osc.connect(bp).connect(gain).connect(ctx.destination);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);

    osc.start(now);
    osc.stop(now + dur);
    nSrc.start(now);
    nSrc.stop(now + dur);
  };

  // ---------------------------------------------------------------
  // 2. HOVER_UP — sine sweep 4.2 kHz → 2.8 kHz, 40 ms
  // ---------------------------------------------------------------
  sounds.HOVER_UP = function() {
    const now = ctx.currentTime;
    const dur = 0.04;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(4200, now);
    osc.frequency.linearRampToValueAtTime(2800, now + dur);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3500;
    bp.Q.value = 8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.003);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(bp).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  };

  // ---------------------------------------------------------------
  // 3. CLICK — square pop + noise tick, 30 ms
  // ---------------------------------------------------------------
  sounds.CLICK = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 600;
    const oscG = ctx.createGain();
    oscG.gain.setValueAtTime(0.25, now);
    oscG.gain.exponentialRampToValueAtTime(0.001, now + 0.003);
    osc.connect(oscG).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.005);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.015);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.3, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.012);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.03);
  };

  // ---------------------------------------------------------------
  // 4. IMPORTANT_CLICK — click transient + triangle body + sub, 140 ms
  // ---------------------------------------------------------------
  sounds.IMPORTANT_CLICK = function() {
    const now = ctx.currentTime;

    const pop = ctx.createOscillator();
    pop.type = 'square';
    pop.frequency.value = 600;
    const popG = ctx.createGain();
    popG.gain.setValueAtTime(0.2, now);
    popG.gain.exponentialRampToValueAtTime(0.001, now + 0.003);
    pop.connect(popG).connect(ctx.destination);
    pop.start(now); pop.stop(now + 0.005);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.012);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 5000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.2, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.01);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.012);

    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.value = 350;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1000; lp.Q.value = 8;
    const bG = ctx.createGain();
    bG.gain.setValueAtTime(0, now);
    bG.gain.linearRampToValueAtTime(0.3, now + 0.003);
    bG.gain.setValueAtTime(0.3, now + 0.05);
    bG.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    body.connect(lp).connect(bG).connect(ctx.destination);
    body.start(now); body.stop(now + 0.15);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 55;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.18, now);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now); sub.stop(now + 0.06);
  };

  // ---------------------------------------------------------------
  // 5. FEATURE_SWITCH_ON — turbine spool-up, 280 ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_ON = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.025);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3500; bp.Q.value = 3;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.3, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.025);

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(180, now + 0.025);
    saw.frequency.exponentialRampToValueAtTime(720, now + 0.225);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(180, now + 0.025);
    sine.frequency.exponentialRampToValueAtTime(720, now + 0.225);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 5;
    lp.frequency.setValueAtTime(350, now + 0.025);
    lp.frequency.exponentialRampToValueAtTime(3500, now + 0.225);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.065);
    gain.gain.setValueAtTime(0.2, now + 0.16);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    saw.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    saw.start(now + 0.025); saw.stop(now + 0.29);
    sine.start(now + 0.025); sine.stop(now + 0.29);
  };

  // ---------------------------------------------------------------
  // 6. FEATURE_SWITCH_OFF — turbine spool-down, 250 ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_OFF = function() {
    const now = ctx.currentTime;

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(720, now);
    saw.frequency.exponentialRampToValueAtTime(120, now + 0.22);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(720, now);
    sine.frequency.exponentialRampToValueAtTime(120, now + 0.22);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 5;
    lp.frequency.setValueAtTime(3500, now);
    lp.frequency.exponentialRampToValueAtTime(250, now + 0.22);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    saw.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    saw.start(now); saw.stop(now + 0.26);
    sine.start(now); sine.stop(now + 0.26);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 50;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.1, now + 0.16);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now + 0.16); sub.stop(now + 0.26);
  };

  // ---------------------------------------------------------------
  // 7. LIMITER_ON — G-force compression, 220 ms
  // ---------------------------------------------------------------
  sounds.LIMITER_ON = function() {
    const now = ctx.currentTime;

    const carrier = ctx.createOscillator();
    carrier.type = 'sine'; carrier.frequency.value = 1200;
    const modulator = ctx.createOscillator();
    modulator.type = 'sine'; modulator.frequency.value = 250;
    const modGain = ctx.createGain();
    modGain.gain.value = 0;
    modulator.connect(modGain.gain);
    const cG = ctx.createGain();
    cG.gain.setValueAtTime(0.18, now);
    cG.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
    carrier.connect(modGain).connect(cG).connect(ctx.destination);
    carrier.start(now); carrier.stop(now + 0.04);
    modulator.start(now); modulator.stop(now + 0.04);

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(250, now + 0.02);
    saw.frequency.exponentialRampToValueAtTime(500, now + 0.20);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(250, now + 0.02);
    sine.frequency.exponentialRampToValueAtTime(500, now + 0.20);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 14;
    lp.frequency.setValueAtTime(400, now + 0.02);
    lp.frequency.exponentialRampToValueAtTime(1800, now + 0.20);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.055);
    gain.gain.setValueAtTime(0.18, now + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    const mix = ctx.createGain(); mix.gain.value = 0.5;
    saw.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);
    saw.start(now + 0.02); saw.stop(now + 0.23);
    sine.start(now + 0.02); sine.stop(now + 0.23);
  };

  // ---------------------------------------------------------------
  // 8. LIMITER_OFF — G-force release, 200 ms
  // ---------------------------------------------------------------
  sounds.LIMITER_OFF = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.018);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.3, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.018);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.02);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(500, now);
    osc.frequency.exponentialRampToValueAtTime(160, now + 0.18);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(2500, now);
    lp.frequency.exponentialRampToValueAtTime(350, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.21);

    const rev = ctx.createOscillator();
    rev.type = 'sine'; rev.frequency.value = 140;
    const rG = ctx.createGain();
    rG.gain.setValueAtTime(0.06, now + 0.14);
    rG.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
    rev.connect(rG).connect(ctx.destination);
    rev.start(now + 0.14); rev.stop(now + 0.21);
  };

  // ---------------------------------------------------------------
  // 9. SWITCH_TOGGLE — avionics toggle, 35 ms
  // ---------------------------------------------------------------
  sounds.SWITCH_TOGGLE = function() {
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    osc1.type = 'square'; osc1.frequency.value = 1600;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.18, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.007);
    const hs = ctx.createBiquadFilter();
    hs.type = 'highshelf'; hs.frequency.value = 4000; hs.gain.value = 4;
    osc1.connect(hs).connect(g1).connect(ctx.destination);
    osc1.start(now); osc1.stop(now + 0.01);

    const osc2 = ctx.createOscillator();
    osc2.type = 'square'; osc2.frequency.value = 800;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.09, now + 0.008);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.028);
    osc2.connect(g2).connect(ctx.destination);
    osc2.start(now + 0.008); osc2.stop(now + 0.035);
  };

  // ---------------------------------------------------------------
  // 10. TAB_INSERT — 3 ascending pips + noise sweep, 110 ms
  // ---------------------------------------------------------------
  sounds.TAB_INSERT = function() {
    const now = ctx.currentTime;
    const freqs = [550, 825, 1100];

    freqs.forEach((f, i) => {
      const t = now + i * 0.018;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.022);
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.025);
    });

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.09);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3500; bp.Q.value = 1.5;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.08, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.11);

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.035;
    const dG = ctx.createGain();
    dG.gain.value = 0.05;
    nG.connect(delay).connect(dG).connect(ctx.destination);
  };

  // ---------------------------------------------------------------
  // 11. TAB_CLOSE — 3 descending pips + zip + thud, 100 ms
  // ---------------------------------------------------------------
  sounds.TAB_CLOSE = function() {
    const now = ctx.currentTime;
    const freqs = [1100, 825, 550];

    freqs.forEach((f, i) => {
      const t = now + i * 0.012;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.016);
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.02);
    });

    const zip = ctx.createOscillator();
    zip.type = 'sawtooth';
    zip.frequency.setValueAtTime(3500, now);
    zip.frequency.exponentialRampToValueAtTime(180, now + 0.045);
    const zG = ctx.createGain();
    zG.gain.setValueAtTime(0.1, now);
    zG.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    zip.connect(zG).connect(ctx.destination);
    zip.start(now); zip.stop(now + 0.05);

    const thud = ctx.createOscillator();
    thud.type = 'sine'; thud.frequency.value = 80;
    const tG = ctx.createGain();
    tG.gain.setValueAtTime(0.14, now + 0.045);
    tG.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
    thud.connect(tG).connect(ctx.destination);
    thud.start(now + 0.045); thud.stop(now + 0.1);
  };

  // ---------------------------------------------------------------
  // 12. TAB_SLASH — IFF interrogation ping, 150 ms
  // ---------------------------------------------------------------
  sounds.TAB_SLASH = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 1500;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 8;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 25;
    lfo.connect(lfoG).connect(osc.frequency);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.16);
    lfo.start(now); lfo.stop(now + 0.16);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 9000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.035, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.05);
  };

  // ---------------------------------------------------------------
  // 13. TYPING_LETTER — carbon-fiber key cap, 22 ms (16 variants)
  // ---------------------------------------------------------------
  sounds.TYPING_LETTER = function() {
    const now = ctx.currentTime;

    const bodyFreq = 800 + Math.floor(Math.random() * 16) * 60;
    const noiseCentre = 4500 + (Math.random() - 0.5) * 1600;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.012);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = noiseCentre; bp.Q.value = 2.5;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.22, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.01);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.022);

    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = bodyFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.012);
    osc.connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.022);
  };

  // ---------------------------------------------------------------
  // 14. TYPING_BACKSPACE — data erasure, 28 ms
  // ---------------------------------------------------------------
  sounds.TYPING_BACKSPACE = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square'; osc.frequency.value = 500;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.14, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.007);
    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.01);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.022);
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass'; nLp.frequency.value = 2500;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.01, now + 0.004);
    nG.gain.linearRampToValueAtTime(0.07, now + 0.022);
    nG.gain.linearRampToValueAtTime(0, now + 0.025);
    nSrc.connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now + 0.004); nSrc.stop(now + 0.028);
  };

  // ---------------------------------------------------------------
  // 15. TYPING_ENTER — mission confirm, 90 ms
  // ---------------------------------------------------------------
  sounds.TYPING_ENTER = function() {
    const now = ctx.currentTime;

    const pop = ctx.createOscillator();
    pop.type = 'square'; pop.frequency.value = 400;
    const pG = ctx.createGain();
    pG.gain.setValueAtTime(0.2, now);
    pG.gain.exponentialRampToValueAtTime(0.001, now + 0.003);
    pop.connect(pG).connect(ctx.destination);
    pop.start(now); pop.stop(now + 0.005);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.01);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 1.5;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.14, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.01);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.012);

    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(400, now);
    body.frequency.exponentialRampToValueAtTime(250, now + 0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 7;
    const bG = ctx.createGain();
    bG.gain.setValueAtTime(0.2, now);
    bG.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    body.connect(lp).connect(bG).connect(ctx.destination);
    body.start(now); body.stop(now + 0.08);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 65;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.2, now);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now); sub.stop(now + 0.04);
  };

  // ---------------------------------------------------------------
  // 16. TYPING_SPACE — pressure release, 28 ms
  // ---------------------------------------------------------------
  sounds.TYPING_SPACE = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.02);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 1.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 4000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.18, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.018);
    nSrc.connect(bp).connect(lp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.028);

    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.013);
    osc.connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.028);
  };

  return sounds;
}

export default { meta, createSounds } as GhostSignalTheme;
