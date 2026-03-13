// ═══════════════════════════════════════════════════════════════════
// ORBIT DECK — sound theme for Krypton
// Near-future EVA control interface — Web Audio API synthesis
// Adapted from ghost-signal project
// ═══════════════════════════════════════════════════════════════════

import type { GhostSignalTheme } from './types';

const meta = {
  name: 'Orbit Deck',
  subtitle: 'Near-future EVA control interface \u2014 Web Audio API synthesis',
  colors: {
    accent:   '#E8714A',
    accent2:  '#4DC9B0',
    danger:   '#D4463B',
    bg:       '#0B1520',
    surface:  '#0F1E2E',
    surface2: '#152838',
    border:   '#1E3A50',
    text:     '#D8E4EC',
    textDim:  '#5A7A8E',
  },
  placeholder: 'Typing on the suit forearm keypad... each press heard through the helmet speakers, muffled by vacuum',
  sounds: {
    HOVER:            { label: 'Hover',          meta: '65 ms / 2.2 kHz / sine sweep',     desc: 'Visor HUD proximity ping' },
    HOVER_UP:         { label: 'Hover Up',       meta: '50 ms / 2.8 kHz / sine sweep',     desc: 'Signal drifting out of range' },
    CLICK:            { label: 'Click',           meta: '35 ms / 800 Hz / sine pop',        desc: 'Suit forearm panel button' },
    IMPORTANT_CLICK:  { label: 'Important Click', meta: '130 ms / 440 Hz / sine + ping',    desc: 'Airlock control engagement' },
    FEATURE_SWITCH_ON:{ label: 'Feature Switch',  meta: 'ON 300 ms / OFF 270 ms \u2014 suit subsystem power cycle', desc: '' },
    LIMITER_ON:       { label: 'Limiter',         meta: 'ON 230 ms / OFF 200 ms \u2014 visor seal engage/release',  desc: '' },
    SWITCH_TOGGLE:    { label: 'Switch Toggle',   meta: '40 ms \u2014 chest panel toggle',                         desc: '' },
    TAB_INSERT:       { label: 'Tab Insert',      meta: '110 ms / 3 ascending blips',       desc: 'Comm channel opening' },
    TAB_CLOSE:        { label: 'Tab Close',       meta: '90 ms / 3 descending blips',       desc: 'Comm channel closing' },
    TAB_SLASH:        { label: 'Tab Slash',       meta: '190 ms / 1.5 kHz / sine ping',     desc: 'Command interface ready' },
    TYPING_LETTER:    { label: 'Typing Letter',   meta: '25 ms / 16 variants',              desc: 'Suit forearm keypad' },
    TYPING_BACKSPACE: { label: 'Typing Backspace', meta: '30 ms / sine blip',               desc: 'Delete blip' },
    TYPING_ENTER:     { label: 'Typing Enter',    meta: '85 ms / confirm tone',             desc: 'Command confirmed' },
    TYPING_SPACE:     { label: 'Typing Space',    meta: '30 ms / broad tap',                desc: 'Suit casing tap' },
    APP_START:        { label: 'App Start',       meta: '1.4 s / drone + shimmer + wind',    desc: 'Orbital silence awakening' },
  },
};

function createSounds(ctx: AudioContext, noiseBuffer: (duration?: number) => AudioBuffer): Record<string, () => void> {
  const sounds: Record<string, () => void> = {};

  // ---------------------------------------------------------------
  // 1. HOVER — visor HUD proximity ping, 65 ms
  // ---------------------------------------------------------------
  sounds.HOVER = function() {
    const now = ctx.currentTime;
    const dur = 0.065;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2200, now);
    osc.frequency.linearRampToValueAtTime(2800, now + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    lp.Q.value = 1.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.10, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.04);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.015, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + dur);
  };

  // ---------------------------------------------------------------
  // 2. HOVER_UP — signal drifting out, 50 ms
  // ---------------------------------------------------------------
  sounds.HOVER_UP = function() {
    const now = ctx.currentTime;
    const dur = 0.05;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2800, now);
    osc.frequency.linearRampToValueAtTime(1800, now + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3500;
    lp.Q.value = 1.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  };

  // ---------------------------------------------------------------
  // 3. CLICK — suit forearm panel button, 35 ms
  // ---------------------------------------------------------------
  sounds.CLICK = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 800;
    const oscG = ctx.createGain();
    oscG.gain.setValueAtTime(0.26, now);
    oscG.gain.exponentialRampToValueAtTime(0.001, now + 0.004);
    osc.connect(oscG).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.006);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.015);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 4000;
    bp.Q.value = 4;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.18, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.012);
    nSrc.connect(bp).connect(lp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.035);
  };

  // ---------------------------------------------------------------
  // 4. IMPORTANT_CLICK — airlock control engagement, 130 ms
  // ---------------------------------------------------------------
  sounds.IMPORTANT_CLICK = function() {
    const now = ctx.currentTime;

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.value = 440;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = 6;
    const bG = ctx.createGain();
    bG.gain.setValueAtTime(0, now);
    bG.gain.linearRampToValueAtTime(0.26, now + 0.002);
    bG.gain.setValueAtTime(0.26, now + 0.042);
    bG.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    body.connect(lp).connect(bG).connect(ctx.destination);
    body.start(now);
    body.stop(now + 0.14);

    const ping = ctx.createOscillator();
    ping.type = 'sine';
    ping.frequency.value = 1760;
    const pG = ctx.createGain();
    pG.gain.setValueAtTime(0.14, now + 0.015);
    pG.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
    ping.connect(pG).connect(ctx.destination);
    ping.start(now + 0.015);
    ping.stop(now + 0.06);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 55;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.16, now);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now);
    sub.stop(now + 0.06);
  };

  // ---------------------------------------------------------------
  // 5. FEATURE_SWITCH_ON — suit subsystem power-up, 300 ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_ON = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.02);
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass';
    nBp.frequency.value = 4000;
    nBp.Q.value = 3;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.22, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
    nSrc.connect(nBp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.025);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(220, now + 0.025);
    sine.frequency.exponentialRampToValueAtTime(660, now + 0.26);

    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(220, now + 0.025);
    tri.frequency.exponentialRampToValueAtTime(660, now + 0.26);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(500, now + 0.025);
    lp.frequency.exponentialRampToValueAtTime(4000, now + 0.26);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.05);
    gain.gain.setValueAtTime(0.18, now + 0.22);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.30);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    sine.connect(lp);
    tri.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    sine.start(now + 0.025);
    sine.stop(now + 0.31);
    tri.start(now + 0.025);
    tri.stop(now + 0.31);

    const hiss = ctx.createBufferSource();
    hiss.buffer = noiseBuffer(0.22);
    const hHp = ctx.createBiquadFilter();
    hHp.type = 'highpass';
    hHp.frequency.value = 2000;
    const hG = ctx.createGain();
    hG.gain.setValueAtTime(0.01, now + 0.03);
    hG.gain.linearRampToValueAtTime(0.08, now + 0.22);
    hG.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    hiss.connect(hHp).connect(hG).connect(ctx.destination);
    hiss.start(now + 0.03);
    hiss.stop(now + 0.29);

    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 120;
    const humG = ctx.createGain();
    humG.gain.setValueAtTime(0, now + 0.03);
    humG.gain.linearRampToValueAtTime(0.04, now + 0.15);
    humG.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    hum.connect(humG).connect(ctx.destination);
    hum.start(now + 0.03);
    hum.stop(now + 0.30);
  };

  // ---------------------------------------------------------------
  // 6. FEATURE_SWITCH_OFF — suit subsystem power-down, 270 ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_OFF = function() {
    const now = ctx.currentTime;

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(660, now);
    sine.frequency.exponentialRampToValueAtTime(160, now + 0.23);

    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(660, now);
    tri.frequency.exponentialRampToValueAtTime(160, now + 0.23);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(4000, now);
    lp.frequency.exponentialRampToValueAtTime(400, now + 0.23);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    sine.connect(lp);
    tri.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    sine.start(now);
    sine.stop(now + 0.26);
    tri.start(now);
    tri.stop(now + 0.26);

    const hiss = ctx.createBufferSource();
    hiss.buffer = noiseBuffer(0.2);
    const hBp = ctx.createBiquadFilter();
    hBp.type = 'bandpass';
    hBp.frequency.value = 2800;
    hBp.Q.value = 1.5;
    const hG = ctx.createGain();
    hG.gain.setValueAtTime(0.08, now);
    hG.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    hiss.connect(hBp).connect(hG).connect(ctx.destination);
    hiss.start(now);
    hiss.stop(now + 0.22);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 80;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.08, now + 0.18);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now + 0.18);
    sub.stop(now + 0.27);
  };

  // ---------------------------------------------------------------
  // 7. LIMITER_ON — visor seal engaging, 230 ms
  // ---------------------------------------------------------------
  sounds.LIMITER_ON = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.015);
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass';
    nBp.frequency.value = 3500;
    nBp.Q.value = 5;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.20, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
    nSrc.connect(nBp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.02);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, now + 0.015);
    osc.frequency.exponentialRampToValueAtTime(480, now + 0.18);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 12;
    lp.frequency.setValueAtTime(400, now + 0.015);
    lp.frequency.exponentialRampToValueAtTime(1200, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.025);
    gain.gain.setValueAtTime(0.16, now + 0.17);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.23);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now + 0.015);
    osc.stop(now + 0.24);

    const hiss = ctx.createBufferSource();
    hiss.buffer = noiseBuffer(0.15);
    const hHp = ctx.createBiquadFilter();
    hHp.type = 'highpass';
    hHp.frequency.value = 2500;
    const hG = ctx.createGain();
    hG.gain.setValueAtTime(0.02, now + 0.02);
    hG.gain.linearRampToValueAtTime(0.06, now + 0.16);
    hG.gain.linearRampToValueAtTime(0, now + 0.18);
    hiss.connect(hHp).connect(hG).connect(ctx.destination);
    hiss.start(now + 0.02);
    hiss.stop(now + 0.20);
  };

  // ---------------------------------------------------------------
  // 8. LIMITER_OFF — visor seal releasing, 200 ms
  // ---------------------------------------------------------------
  sounds.LIMITER_OFF = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.03);
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass';
    nLp.frequency.value = 6000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.30, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    nSrc.connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.035);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(480, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.17);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.setValueAtTime(12, now);
    lp.Q.linearRampToValueAtTime(1, now + 0.17);
    lp.frequency.setValueAtTime(1200, now);
    lp.frequency.exponentialRampToValueAtTime(3000, now + 0.17);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.21);

    const bump = ctx.createOscillator();
    bump.type = 'sine';
    bump.frequency.value = 120;
    const bG = ctx.createGain();
    bG.gain.setValueAtTime(0.06, now + 0.14);
    bG.gain.exponentialRampToValueAtTime(0.001, now + 0.175);
    bump.connect(bG).connect(ctx.destination);
    bump.start(now + 0.14);
    bump.stop(now + 0.20);
  };

  // ---------------------------------------------------------------
  // 9. SWITCH_TOGGLE — chest panel toggle, 40 ms
  // ---------------------------------------------------------------
  sounds.SWITCH_TOGGLE = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.004);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.10, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.002);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.004);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1200;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.18, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.008);
    osc.connect(lp).connect(g1).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.01);

    const echo = ctx.createOscillator();
    echo.type = 'sine';
    echo.frequency.value = 600;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.07, now + 0.008);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.018);
    echo.connect(g2).connect(ctx.destination);
    echo.start(now + 0.008);
    echo.stop(now + 0.04);
  };

  // ---------------------------------------------------------------
  // 10. TAB_INSERT — comm channel opening, 110 ms
  // ---------------------------------------------------------------
  sounds.TAB_INSERT = function() {
    const now = ctx.currentTime;
    const freqs = [600, 900, 1200];

    freqs.forEach((f, i) => {
      const t = now + i * 0.01;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
      osc.connect(lp).connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.02);
    });

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.07);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.04, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.08);

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.02;
    const dG = ctx.createGain();
    dG.gain.value = 0.03;
    nG.connect(delay).connect(dG).connect(ctx.destination);
  };

  // ---------------------------------------------------------------
  // 11. TAB_CLOSE — comm channel closing, 90 ms
  // ---------------------------------------------------------------
  sounds.TAB_CLOSE = function() {
    const now = ctx.currentTime;
    const freqs = [1200, 900, 600];

    freqs.forEach((f, i) => {
      const t = now + i * 0.008;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.14, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
      osc.connect(lp).connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.016);
    });

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(4000, now);
    bp.frequency.exponentialRampToValueAtTime(1000, now + 0.05);
    bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.06, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.06);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 70;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.08, now + 0.05);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now + 0.05);
    sub.stop(now + 0.09);
  };

  // ---------------------------------------------------------------
  // 12. TAB_SLASH — command interface ready, 190 ms
  // ---------------------------------------------------------------
  sounds.TAB_SLASH = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1500;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5000;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 3;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 8;
    lfo.connect(lfoG).connect(osc.frequency);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.20, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.20);
    lfo.start(now);
    lfo.stop(now + 0.20);

    const harm = ctx.createOscillator();
    harm.type = 'sine';
    harm.frequency.value = 3000;
    const hG = ctx.createGain();
    hG.gain.setValueAtTime(0.03, now);
    hG.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    harm.connect(hG).connect(ctx.destination);
    harm.start(now);
    harm.stop(now + 0.06);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.06);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.01, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.06);
  };

  // ---------------------------------------------------------------
  // 13. TYPING_LETTER — suit forearm keypad, 25 ms (16 variants)
  // ---------------------------------------------------------------
  sounds.TYPING_LETTER = function() {
    const now = ctx.currentTime;

    const bodyFreq = 1000 + Math.floor(Math.random() * 16) * 80;
    const noiseCentre = 4500 + (Math.random() - 0.5) * 1000;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.012);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = noiseCentre;
    bp.Q.value = 3;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass';
    nLp.frequency.value = 5500;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.20, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.01);
    nSrc.connect(bp).connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.025);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = bodyFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.04, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.014);
    osc.connect(g).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.025);
  };

  // ---------------------------------------------------------------
  // 14. TYPING_BACKSPACE — delete blip, 30 ms
  // ---------------------------------------------------------------
  sounds.TYPING_BACKSPACE = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(550, now);
    osc.frequency.exponentialRampToValueAtTime(350, now + 0.02);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.028);
    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.03);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.015);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.06, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.03);
  };

  // ---------------------------------------------------------------
  // 15. TYPING_ENTER — command confirmed, 85 ms
  // ---------------------------------------------------------------
  sounds.TYPING_ENTER = function() {
    const now = ctx.currentTime;

    const pop = ctx.createOscillator();
    pop.type = 'sine';
    pop.frequency.value = 500;
    const pG = ctx.createGain();
    pG.gain.setValueAtTime(0.22, now);
    pG.gain.exponentialRampToValueAtTime(0.001, now + 0.003);
    pop.connect(pG).connect(ctx.destination);
    pop.start(now);
    pop.stop(now + 0.005);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.012);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    bp.Q.value = 3;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.12, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.01);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.015);

    const conf = ctx.createOscillator();
    conf.type = 'sine';
    conf.frequency.value = 1000;
    const cLp = ctx.createBiquadFilter();
    cLp.type = 'lowpass';
    cLp.frequency.value = 3000;
    const cG = ctx.createGain();
    cG.gain.setValueAtTime(0.18, now + 0.01);
    cG.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    conf.connect(cLp).connect(cG).connect(ctx.destination);
    conf.start(now + 0.01);
    conf.stop(now + 0.07);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 70;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.14, now);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now);
    sub.stop(now + 0.04);
  };

  // ---------------------------------------------------------------
  // 16. TYPING_SPACE — broad suit casing tap, 30 ms
  // ---------------------------------------------------------------
  sounds.TYPING_SPACE = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.02);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 1;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass';
    nLp.frequency.value = 4000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.16, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.018);
    nSrc.connect(bp).connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.03);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 350;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.03);
  };

  // ---------------------------------------------------------------
  // 17. APP_START — orbital silence awakening, 1.4 s
  // ---------------------------------------------------------------
  sounds.APP_START = function() {
    const now = ctx.currentTime;

    // Deep drone — like hearing your own heartbeat in a spacesuit
    const drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 110;
    const dLp = ctx.createBiquadFilter();
    dLp.type = 'lowpass';
    dLp.frequency.setValueAtTime(200, now);
    dLp.frequency.linearRampToValueAtTime(700, now + 0.7);
    dLp.frequency.exponentialRampToValueAtTime(150, now + 1.4);
    dLp.Q.value = 2;
    const dG = ctx.createGain();
    dG.gain.setValueAtTime(0, now);
    dG.gain.linearRampToValueAtTime(0.16, now + 0.5);
    dG.gain.setValueAtTime(0.16, now + 0.8);
    dG.gain.exponentialRampToValueAtTime(0.001, now + 1.4);
    drone.connect(dLp).connect(dG).connect(ctx.destination);
    drone.start(now);
    drone.stop(now + 1.45);

    // Octave shimmer — distant, high, barely there
    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.value = 220;
    const sLp = ctx.createBiquadFilter();
    sLp.type = 'lowpass';
    sLp.frequency.value = 500;
    sLp.Q.value = 1.5;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0, now + 0.5);
    sG.gain.linearRampToValueAtTime(0.06, now + 0.9);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 1.4);
    shimmer.connect(sLp).connect(sG).connect(ctx.destination);
    shimmer.start(now + 0.5);
    shimmer.stop(now + 1.45);

    // Gentle LFO — slow breathing modulation
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1.5;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.03;
    lfo.connect(lfoG).connect(dG.gain);
    lfo.start(now);
    lfo.stop(now + 1.45);

    // Atmospheric whisper — thin, high noise like solar wind
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(1.3);
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass';
    nBp.frequency.value = 2000;
    nBp.Q.value = 1;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass';
    nLp.frequency.value = 3000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0, now);
    nG.gain.linearRampToValueAtTime(0.025, now + 0.6);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
    nSrc.connect(nBp).connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 1.35);

    // Sub rumble — the structure of the station felt through the suit
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 55;
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0, now);
    subG.gain.linearRampToValueAtTime(0.08, now + 0.4);
    subG.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    sub.connect(subG).connect(ctx.destination);
    sub.start(now);
    sub.stop(now + 1.05);
  };

  return sounds;
}

export default { meta, createSounds } as GhostSignalTheme;
