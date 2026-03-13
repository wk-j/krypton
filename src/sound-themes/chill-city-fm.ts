// ═══════════════════════════════════════════════════════════════════
// CHILL CITY FM — sound theme for Krypton
// Warm lo-fi retro analog audio theme — Web Audio API synthesis
// Adapted from ghost-signal project
// ═══════════════════════════════════════════════════════════════════

import type { GhostSignalTheme } from './types';

const meta = {
  name: 'Chill City FM',
  subtitle: 'Warm lo-fi retro audio theme \u2014 Web Audio API synthesis',
  colors: {
    accent:   '#E8A849',
    accent2:  '#5CB8E4',
    danger:   '#C94A4A',
    bg:       '#1A1410',
    surface:  '#231E18',
    surface2: '#2E2720',
    border:   '#3D3429',
    text:     '#E8DDD0',
    textDim:  '#8A7D6E',
  },
  placeholder: 'Start typing to hear vintage keyboard sounds... like writing a late-night letter by lamplight',
  sounds: {
    HOVER:            { label: 'Hover',          meta: '70 ms / 1.4 kHz / sine sweep',      desc: 'VCR head brushing tape' },
    HOVER_UP:         { label: 'Hover Up',       meta: '55 ms / 1.8 kHz / sine sweep',      desc: 'Tape head lifting off' },
    CLICK:            { label: 'Click',           meta: '40 ms / 600 Hz / triangle pop',     desc: 'Boombox button press' },
    IMPORTANT_CLICK:  { label: 'Important Click', meta: '140 ms / 320 Hz / triangle body',   desc: 'VHS tape loading into VCR' },
    FEATURE_SWITCH_ON:{ label: 'Feature Switch',  meta: 'ON 280 ms / OFF 260 ms \u2014 CRT power cycle',      desc: '' },
    LIMITER_ON:       { label: 'Limiter',         meta: 'ON 220 ms / OFF 210 ms \u2014 cassette record engage', desc: '' },
    SWITCH_TOGGLE:    { label: 'Switch Toggle',   meta: '45 ms \u2014 stereo receiver toggle',                 desc: '' },
    TAB_INSERT:       { label: 'Tab Insert',      meta: '110 ms / 3 ascending blips',        desc: 'FM station tuning in' },
    TAB_CLOSE:        { label: 'Tab Close',       meta: '95 ms / 3 descending blips',        desc: 'FM signal lost' },
    TAB_SLASH:        { label: 'Tab Slash',       meta: '180 ms / 1200 Hz / triangle ping',  desc: 'NES power-on chime' },
    TYPING_LETTER:    { label: 'Typing Letter',   meta: '30 ms / 16 variants',               desc: 'Vintage typewriter tack' },
    TYPING_BACKSPACE: { label: 'Typing Backspace', meta: '35 ms / triangle pulse',           desc: 'Carriage pull-back thock' },
    TYPING_ENTER:     { label: 'Typing Enter',    meta: '90 ms / ding + chunk',              desc: 'Carriage return' },
    TYPING_SPACE:     { label: 'Typing Space',    meta: '35 ms / woody thump',               desc: 'Space bar thump' },
    APP_START:        { label: 'App Start',       meta: '1.3 s / triangle drone + hiss',     desc: 'Late-night signal fading in' },
  },
};

function createSounds(ctx: AudioContext, noiseBuffer: (duration?: number) => AudioBuffer): Record<string, () => void> {
  const sounds: Record<string, () => void> = {};

  // ---------------------------------------------------------------
  // 1. HOVER — warm sine sweep 1.4kHz→1.8kHz + tape hiss, 70 ms
  // ---------------------------------------------------------------
  sounds.HOVER = function() {
    const now = ctx.currentTime;
    const dur = 0.07;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1400, now);
    osc.frequency.linearRampToValueAtTime(1800, now + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2500;
    lp.Q.value = 3;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.10, now + 0.008);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 1;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass';
    nLp.frequency.value = 4000;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.025, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    nSrc.connect(bp).connect(nLp).connect(nGain).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + dur);
  };

  // ---------------------------------------------------------------
  // 2. HOVER_UP — sine sweep 1.8kHz→1.2kHz, 55 ms
  // ---------------------------------------------------------------
  sounds.HOVER_UP = function() {
    const now = ctx.currentTime;
    const dur = 0.055;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1800, now);
    osc.frequency.linearRampToValueAtTime(1200, now + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000;
    lp.Q.value = 2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  };

  // ---------------------------------------------------------------
  // 3. CLICK — triangle pop + warm noise burst, 40 ms
  // ---------------------------------------------------------------
  sounds.CLICK = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 600;
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.28, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.004);
    osc.connect(oscGain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.006);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.025);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 3;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass';
    nLp.frequency.value = 4000;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.22, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
    nSrc.connect(bp).connect(nLp).connect(nGain).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.04);
  };

  // ---------------------------------------------------------------
  // 4. IMPORTANT_CLICK — VHS loading chunk, 140 ms
  // ---------------------------------------------------------------
  sounds.IMPORTANT_CLICK = function() {
    const now = ctx.currentTime;

    const pop = ctx.createOscillator();
    pop.type = 'triangle';
    pop.frequency.value = 600;
    const popG = ctx.createGain();
    popG.gain.setValueAtTime(0.22, now);
    popG.gain.exponentialRampToValueAtTime(0.001, now + 0.004);
    pop.connect(popG).connect(ctx.destination);
    pop.start(now); pop.stop(now + 0.006);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.18, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.03);

    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.value = 320;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 5;
    const bGain = ctx.createGain();
    bGain.gain.setValueAtTime(0, now);
    bGain.gain.linearRampToValueAtTime(0.28, now + 0.003);
    bGain.gain.setValueAtTime(0.28, now + 0.053);
    bGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    body.connect(lp).connect(bGain).connect(ctx.destination);
    body.start(now); body.stop(now + 0.15);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 65;
    const sGain = ctx.createGain();
    sGain.gain.setValueAtTime(0.18, now);
    sGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    sub.connect(sGain).connect(ctx.destination);
    sub.start(now); sub.stop(now + 0.07);
  };

  // ---------------------------------------------------------------
  // 5. FEATURE_SWITCH_ON — CRT power-up, 280 ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_ON = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.25, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.04);

    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(180, now + 0.04);
    tri.frequency.exponentialRampToValueAtTime(520, now + 0.24);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(180, now + 0.04);
    sine.frequency.exponentialRampToValueAtTime(520, now + 0.24);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 3;
    lp.frequency.setValueAtTime(600, now + 0.04);
    lp.frequency.exponentialRampToValueAtTime(3000, now + 0.24);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.20, now + 0.06);
    gain.gain.setValueAtTime(0.20, now + 0.18);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    tri.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    tri.start(now + 0.04); tri.stop(now + 0.29);
    sine.start(now + 0.04); sine.stop(now + 0.29);

    const hum = ctx.createOscillator();
    hum.type = 'sine'; hum.frequency.value = 60;
    const hG = ctx.createGain();
    hG.gain.setValueAtTime(0, now + 0.04);
    hG.gain.linearRampToValueAtTime(0.08, now + 0.18);
    hG.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    hum.connect(hG).connect(ctx.destination);
    hum.start(now + 0.04); hum.stop(now + 0.29);
  };

  // ---------------------------------------------------------------
  // 6. FEATURE_SWITCH_OFF — CRT power-down, 260 ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_OFF = function() {
    const now = ctx.currentTime;

    const zap = ctx.createOscillator();
    zap.type = 'sine'; zap.frequency.value = 8000;
    const zG = ctx.createGain();
    zG.gain.setValueAtTime(0.04, now);
    zG.gain.exponentialRampToValueAtTime(0.001, now + 0.005);
    zap.connect(zG).connect(ctx.destination);
    zap.start(now); zap.stop(now + 0.008);

    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(520, now);
    tri.frequency.exponentialRampToValueAtTime(120, now + 0.22);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(520, now);
    sine.frequency.exponentialRampToValueAtTime(120, now + 0.22);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 3;
    lp.frequency.setValueAtTime(3000, now);
    lp.frequency.exponentialRampToValueAtTime(300, now + 0.22);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.20, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    tri.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    tri.start(now); tri.stop(now + 0.25);
    sine.start(now); sine.stop(now + 0.25);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 50;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.10, now + 0.16);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now + 0.16); sub.stop(now + 0.25);

    const cSrc = ctx.createBufferSource();
    cSrc.buffer = noiseBuffer(0.04);
    const cBp = ctx.createBiquadFilter();
    cBp.type = 'bandpass'; cBp.frequency.value = 2000; cBp.Q.value = 2;
    const cG = ctx.createGain();
    cG.gain.setValueAtTime(0.03, now + 0.20);
    cG.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    cSrc.connect(cBp).connect(cG).connect(ctx.destination);
    cSrc.start(now + 0.20); cSrc.stop(now + 0.26);
  };

  // ---------------------------------------------------------------
  // 7. LIMITER_ON — cassette record engage, 220 ms
  // ---------------------------------------------------------------
  sounds.LIMITER_ON = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.02);
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass'; nBp.frequency.value = 3000; nBp.Q.value = 3;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.20, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
    nSrc.connect(nBp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.025);

    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(250, now + 0.02);
    tri.frequency.exponentialRampToValueAtTime(420, now + 0.18);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(250, now + 0.02);
    sine.frequency.exponentialRampToValueAtTime(420, now + 0.18);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 8;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 15;
    lfo.connect(lfoG).connect(tri.frequency);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 10;
    lp.frequency.setValueAtTime(500, now + 0.02);
    lp.frequency.exponentialRampToValueAtTime(1800, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.04);
    gain.gain.setValueAtTime(0.18, now + 0.16);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    tri.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    tri.start(now + 0.02); tri.stop(now + 0.23);
    sine.start(now + 0.02); sine.stop(now + 0.23);
    lfo.start(now + 0.02); lfo.stop(now + 0.23);
  };

  // ---------------------------------------------------------------
  // 8. LIMITER_OFF — cassette record release, 210 ms
  // ---------------------------------------------------------------
  sounds.LIMITER_OFF = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.025);
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass'; nLp.frequency.value = 5000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.28, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    nSrc.connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.03);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.18);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 4;
    lp.frequency.setValueAtTime(2500, now);
    lp.frequency.exponentialRampToValueAtTime(400, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.21);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.22);

    const bump = ctx.createOscillator();
    bump.type = 'sine'; bump.frequency.value = 140;
    const bG = ctx.createGain();
    bG.gain.setValueAtTime(0.08, now + 0.15);
    bG.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
    bump.connect(bG).connect(ctx.destination);
    bump.start(now + 0.15); bump.stop(now + 0.21);
  };

  // ---------------------------------------------------------------
  // 9. SWITCH_TOGGLE — stereo receiver toggle, 45 ms
  // ---------------------------------------------------------------
  sounds.SWITCH_TOGGLE = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.005);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.12, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.003);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.005);

    const osc1 = ctx.createOscillator();
    osc1.type = 'triangle'; osc1.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.18, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.01);
    osc1.connect(lp).connect(g1).connect(ctx.destination);
    osc1.start(now); osc1.stop(now + 0.012);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle'; osc2.frequency.value = 450;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.08, now + 0.012);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.024);
    osc2.connect(g2).connect(ctx.destination);
    osc2.start(now + 0.012); osc2.stop(now + 0.045);
  };

  // ---------------------------------------------------------------
  // 10. TAB_INSERT — FM station tuning in, 110 ms
  // ---------------------------------------------------------------
  sounds.TAB_INSERT = function() {
    const now = ctx.currentTime;
    const freqs = [480, 640, 800];

    freqs.forEach((f, i) => {
      const t = now + i * 0.012;
      const osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.018);
      osc.connect(lp).connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.022);
    });

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.08);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2000; bp.Q.value = 1.5;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.08, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.11);

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.025;
    const dG = ctx.createGain();
    dG.gain.value = 0.04;
    nG.connect(delay).connect(dG).connect(ctx.destination);
  };

  // ---------------------------------------------------------------
  // 11. TAB_CLOSE — FM signal lost, 95 ms
  // ---------------------------------------------------------------
  sounds.TAB_CLOSE = function() {
    const now = ctx.currentTime;
    const freqs = [800, 640, 480];

    freqs.forEach((f, i) => {
      const t = now + i * 0.008;
      const osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.16, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.014);
      osc.connect(lp).connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.018);
    });

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.06);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3000, now);
    bp.frequency.exponentialRampToValueAtTime(800, now + 0.06);
    bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.10, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.07);

    const thud = ctx.createOscillator();
    thud.type = 'sine'; thud.frequency.value = 90;
    const tG = ctx.createGain();
    tG.gain.setValueAtTime(0.12, now + 0.05);
    tG.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
    thud.connect(tG).connect(ctx.destination);
    thud.start(now + 0.05); thud.stop(now + 0.095);
  };

  // ---------------------------------------------------------------
  // 12. TAB_SLASH — NES power-on chime, 180 ms
  // ---------------------------------------------------------------
  sounds.TAB_SLASH = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 1200;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3500;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 4;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 10;
    lfo.connect(lfoG).connect(osc.frequency);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.19);
    lfo.start(now); lfo.stop(now + 0.19);

    const harm = ctx.createOscillator();
    harm.type = 'sine'; harm.frequency.value = 2400;
    const hG = ctx.createGain();
    hG.gain.setValueAtTime(0.05, now);
    hG.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    harm.connect(hG).connect(ctx.destination);
    harm.start(now); harm.stop(now + 0.07);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 3000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.02, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.08);
  };

  // ---------------------------------------------------------------
  // 13. TYPING_LETTER — vintage typewriter tack, 30 ms (16 variants)
  // ---------------------------------------------------------------
  sounds.TYPING_LETTER = function() {
    const now = ctx.currentTime;

    const bodyFreq = 800 + Math.floor(Math.random() * 16) * 80;
    const noiseCentre = 3500 + (Math.random() - 0.5) * 800;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.018);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = noiseCentre; bp.Q.value = 2.5;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass'; nLp.frequency.value = 5000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.22, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.014);
    nSrc.connect(bp).connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.03);

    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = bodyFreq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.07, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.018);
    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.03);
  };

  // ---------------------------------------------------------------
  // 14. TYPING_BACKSPACE — carriage pull-back thock, 35 ms
  // ---------------------------------------------------------------
  sounds.TYPING_BACKSPACE = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 450;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.14, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.01);
    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.012);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.028);
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass'; nBp.frequency.value = 1200; nBp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.02, now + 0.005);
    nG.gain.linearRampToValueAtTime(0.08, now + 0.027);
    nG.gain.linearRampToValueAtTime(0, now + 0.03);
    nSrc.connect(nBp).connect(nG).connect(ctx.destination);
    nSrc.start(now + 0.005); nSrc.stop(now + 0.035);
  };

  // ---------------------------------------------------------------
  // 15. TYPING_ENTER — carriage return ding-chunk, 90 ms
  // ---------------------------------------------------------------
  sounds.TYPING_ENTER = function() {
    const now = ctx.currentTime;

    const ding = ctx.createOscillator();
    ding.type = 'sine'; ding.frequency.value = 2400;
    const dG = ctx.createGain();
    dG.gain.setValueAtTime(0.04, now);
    dG.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
    ding.connect(dG).connect(ctx.destination);
    ding.start(now); ding.stop(now + 0.025);

    const pop = ctx.createOscillator();
    pop.type = 'triangle'; pop.frequency.value = 380;
    const pG = ctx.createGain();
    pG.gain.setValueAtTime(0.20, now);
    pG.gain.exponentialRampToValueAtTime(0.001, now + 0.004);
    pop.connect(pG).connect(ctx.destination);
    pop.start(now); pop.stop(now + 0.006);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.015);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.12, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.012);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.015);

    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(380, now);
    body.frequency.exponentialRampToValueAtTime(240, now + 0.065);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 5;
    const bG = ctx.createGain();
    bG.gain.setValueAtTime(0.18, now);
    bG.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    body.connect(lp).connect(bG).connect(ctx.destination);
    body.start(now); body.stop(now + 0.08);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 60;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.18, now);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now); sub.stop(now + 0.04);
  };

  // ---------------------------------------------------------------
  // 16. TYPING_SPACE — broad woody thump, 35 ms
  // ---------------------------------------------------------------
  sounds.TYPING_SPACE = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.028);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1000; bp.Q.value = 1.5;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass'; nLp.frequency.value = 3500;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.18, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.022);
    nSrc.connect(bp).connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.035);

    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 280;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.10, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.018);
    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.035);
  };

  // ---------------------------------------------------------------
  // 17. APP_START — late-night signal fading in, 1.3 s
  // ---------------------------------------------------------------
  sounds.APP_START = function() {
    const now = ctx.currentTime;

    // Warm triangle drone — like a radio carrier wave
    const drone = ctx.createOscillator();
    drone.type = 'triangle';
    drone.frequency.value = 196;
    const dLp = ctx.createBiquadFilter();
    dLp.type = 'lowpass';
    dLp.frequency.setValueAtTime(300, now);
    dLp.frequency.linearRampToValueAtTime(1200, now + 0.6);
    dLp.frequency.exponentialRampToValueAtTime(250, now + 1.3);
    dLp.Q.value = 3;
    const dG = ctx.createGain();
    dG.gain.setValueAtTime(0, now);
    dG.gain.linearRampToValueAtTime(0.14, now + 0.4);
    dG.gain.setValueAtTime(0.14, now + 0.7);
    dG.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
    drone.connect(dLp).connect(dG).connect(ctx.destination);
    drone.start(now);
    drone.stop(now + 1.35);

    // Minor third — melancholy, distant, like a memory
    const third = ctx.createOscillator();
    third.type = 'sine';
    third.frequency.value = 233;
    const tLp = ctx.createBiquadFilter();
    tLp.type = 'lowpass';
    tLp.frequency.value = 600;
    tLp.Q.value = 2;
    const tG = ctx.createGain();
    tG.gain.setValueAtTime(0, now + 0.35);
    tG.gain.linearRampToValueAtTime(0.08, now + 0.65);
    tG.gain.setValueAtTime(0.08, now + 0.8);
    tG.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
    third.connect(tLp).connect(tG).connect(ctx.destination);
    third.start(now + 0.35);
    third.stop(now + 1.35);

    // Slow wobble — tape warble on the drone
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 3;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 3;
    lfo.connect(lfoG).connect(drone.frequency);
    lfo.start(now);
    lfo.stop(now + 1.35);

    // Tape hiss — warm, enveloping
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(1.2);
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass';
    nBp.frequency.value = 1000;
    nBp.Q.value = 0.8;
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass';
    nLp.frequency.value = 3000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0, now);
    nG.gain.linearRampToValueAtTime(0.04, now + 0.4);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    nSrc.connect(nBp).connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 1.25);

    // 60 Hz mains hum — grounding warmth
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 60;
    const humG = ctx.createGain();
    humG.gain.setValueAtTime(0, now);
    humG.gain.linearRampToValueAtTime(0.05, now + 0.3);
    humG.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    hum.connect(humG).connect(ctx.destination);
    hum.start(now);
    hum.stop(now + 0.95);
  };

  return sounds;
}

export default { meta, createSounds } as GhostSignalTheme;
