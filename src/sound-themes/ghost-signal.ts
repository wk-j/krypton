// ═══════════════════════════════════════════════════════════════════
// GHOST SIGNAL — sound theme for Krypton
// Cyberpunk-noir audio theme — Web Audio API synthesis
// Adapted from ghost-signal project
// ═══════════════════════════════════════════════════════════════════

import type { GhostSignalTheme } from './types';

const meta = {
  name: 'Ghost Signal',
  subtitle: 'Cyberpunk-noir audio theme \u2014 Web Audio API synthesis',
  colors: {
    accent:   '#FCEE0A',
    accent2:  '#00F0FF',
    danger:   '#FF2D6B',
    bg:       '#0A0A0C',
    surface:  '#111116',
    surface2: '#1A1A22',
    border:   '#2A2A35',
    text:     '#E0E0E8',
    textDim:  '#6A6A78',
  },
  placeholder: 'Start typing to hear holo-keyboard sounds...',
  sounds: {
    HOVER:            { label: 'Hover',          meta: '60 ms / 2 kHz / sine sweep',       desc: 'Ghost-light proximity scan' },
    HOVER_UP:         { label: 'Hover Up',       meta: '50 ms / 3 kHz / sine sweep',       desc: 'Scanner retracting' },
    CLICK:            { label: 'Click',           meta: '35 ms / 800 Hz / square pop',      desc: 'Chrome relay snap' },
    IMPORTANT_CLICK:  { label: 'Important Click', meta: '120 ms / 440 Hz / triangle body',  desc: 'System override confirm' },
    FEATURE_SWITCH_ON:{ label: 'Feature Switch',  meta: 'ON 250 ms / OFF 220 ms \u2014 implant power cycle', desc: '' },
    LIMITER_ON:       { label: 'Limiter',         meta: 'ON 200 ms / OFF 200 ms \u2014 pressure clamp',      desc: '' },
    SWITCH_TOGGLE:    { label: 'Switch Toggle',   meta: '40 ms \u2014 micro-switch flip',                    desc: '' },
    TAB_INSERT:       { label: 'Tab Insert',      meta: '100 ms / 3 ascending blips',       desc: 'Data stream open' },
    TAB_CLOSE:        { label: 'Tab Close',       meta: '90 ms / 3 descending blips',       desc: 'Data stream severed' },
    TAB_SLASH:        { label: 'Tab Slash',       meta: '160 ms / 1760 Hz / triangle ping', desc: 'Command line activate' },
    TYPING_LETTER:    { label: 'Typing Letter',   meta: '25 ms / 19 variants',              desc: 'Holo-key tap' },
    TYPING_BACKSPACE: { label: 'Typing Backspace', meta: '30 ms / square pulse',            desc: 'Data retract' },
    TYPING_ENTER:     { label: 'Typing Enter',    meta: '80 ms / saw + sub',                desc: 'Command submit' },
    TYPING_SPACE:     { label: 'Typing Space',    meta: '30 ms / noise puff',               desc: 'Buffer advance' },
    APP_START:        { label: 'App Start',       meta: '1.2 s / drone + fifth + noise',    desc: 'Ghost frequency awakening' },
  },
};

function createSounds(ctx: AudioContext, noiseBuffer: (duration?: number) => AudioBuffer): Record<string, () => void> {
  const sounds: Record<string, () => void> = {};

  // ---------------------------------------------------------------
  // 1. HOVER — sine sweep 2 kHz → 3.2 kHz, 60 ms
  // ---------------------------------------------------------------
  sounds.HOVER = function() {
    const now = ctx.currentTime;
    const dur = 0.06;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2000, now);
    osc.frequency.linearRampToValueAtTime(3200, now + dur);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.005);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(dur);
    const nGain = ctx.createGain();
    nGain.gain.value = 0.015;

    osc.connect(bp).connect(gain).connect(ctx.destination);
    nSrc.connect(nGain).connect(ctx.destination);

    osc.start(now);
    osc.stop(now + dur);
    nSrc.start(now);
    nSrc.stop(now + dur);
  };

  // ---------------------------------------------------------------
  // 2. HOVER_UP — sine sweep 3 kHz → 1.8 kHz, 50 ms
  // ---------------------------------------------------------------
  sounds.HOVER_UP = function() {
    const now = ctx.currentTime;
    const dur = 0.05;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(3000, now);
    osc.frequency.linearRampToValueAtTime(1800, now + dur);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.10, now + 0.004);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(bp).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  };

  // ---------------------------------------------------------------
  // 3. CLICK — square pop + noise tick, 35 ms
  // ---------------------------------------------------------------
  sounds.CLICK = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 800;
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.25, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.003);
    osc.connect(oscGain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.005);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4000;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.3, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
    nSrc.connect(hp).connect(nGain).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 0.035);
  };

  // ---------------------------------------------------------------
  // 4. IMPORTANT_CLICK — click transient + triangle body + sub, 120 ms
  // ---------------------------------------------------------------
  sounds.IMPORTANT_CLICK = function() {
    const now = ctx.currentTime;

    const pop = ctx.createOscillator();
    pop.type = 'square';
    pop.frequency.value = 800;
    const popG = ctx.createGain();
    popG.gain.setValueAtTime(0.2, now);
    popG.gain.exponentialRampToValueAtTime(0.001, now + 0.003);
    pop.connect(popG).connect(ctx.destination);
    pop.start(now); pop.stop(now + 0.005);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.015);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 4000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.2, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.012);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.015);

    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.value = 440;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 6;
    const bGain = ctx.createGain();
    bGain.gain.setValueAtTime(0, now);
    bGain.gain.linearRampToValueAtTime(0.3, now + 0.002);
    bGain.gain.setValueAtTime(0.3, now + 0.042);
    bGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    body.connect(lp).connect(bGain).connect(ctx.destination);
    body.start(now); body.stop(now + 0.13);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 80;
    const sGain = ctx.createGain();
    sGain.gain.setValueAtTime(0.15, now);
    sGain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    sub.connect(sGain).connect(ctx.destination);
    sub.start(now); sub.stop(now + 0.05);
  };

  // ---------------------------------------------------------------
  // 5. FEATURE_SWITCH_ON — noise spark + ascending saw+sine, 250 ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_ON = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 4000; bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.3, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.03);

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(220, now + 0.03);
    saw.frequency.exponentialRampToValueAtTime(880, now + 0.22);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(220, now + 0.03);
    sine.frequency.exponentialRampToValueAtTime(880, now + 0.22);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 4;
    lp.frequency.setValueAtTime(400, now + 0.03);
    lp.frequency.exponentialRampToValueAtTime(4000, now + 0.22);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.05);
    gain.gain.setValueAtTime(0.22, now + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    saw.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    saw.start(now + 0.03); saw.stop(now + 0.26);
    sine.start(now + 0.03); sine.stop(now + 0.26);
  };

  // ---------------------------------------------------------------
  // 6. FEATURE_SWITCH_OFF — descending saw+sine + rumble, 220 ms
  // ---------------------------------------------------------------
  sounds.FEATURE_SWITCH_OFF = function() {
    const now = ctx.currentTime;

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(880, now);
    saw.frequency.exponentialRampToValueAtTime(160, now + 0.20);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(880, now);
    sine.frequency.exponentialRampToValueAtTime(160, now + 0.20);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 4;
    lp.frequency.setValueAtTime(4000, now);
    lp.frequency.exponentialRampToValueAtTime(300, now + 0.20);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    saw.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);

    saw.start(now); saw.stop(now + 0.23);
    sine.start(now); sine.stop(now + 0.23);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 60;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.12, now + 0.14);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now + 0.14); sub.stop(now + 0.23);
  };

  // ---------------------------------------------------------------
  // 7. LIMITER_ON — narrow ascending sweep + ring mod onset, 200 ms
  // ---------------------------------------------------------------
  sounds.LIMITER_ON = function() {
    const now = ctx.currentTime;

    const carrier = ctx.createOscillator();
    carrier.type = 'sine'; carrier.frequency.value = 1500;
    const modulator = ctx.createOscillator();
    modulator.type = 'sine'; modulator.frequency.value = 300;
    const modGain = ctx.createGain();
    modGain.gain.value = 0;
    modulator.connect(modGain.gain);
    const cG = ctx.createGain();
    cG.gain.setValueAtTime(0.2, now);
    cG.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    carrier.connect(modGain).connect(cG).connect(ctx.destination);
    carrier.start(now); carrier.stop(now + 0.05);
    modulator.start(now); modulator.stop(now + 0.05);

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(300, now + 0.02);
    saw.frequency.exponentialRampToValueAtTime(600, now + 0.18);

    const sine = ctx.createOscillator();
    sine.type = 'sine';
    sine.frequency.setValueAtTime(300, now + 0.02);
    sine.frequency.exponentialRampToValueAtTime(600, now + 0.18);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 12;
    lp.frequency.setValueAtTime(500, now + 0.02);
    lp.frequency.exponentialRampToValueAtTime(2000, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.04);
    gain.gain.setValueAtTime(0.2, now + 0.14);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);

    const mix = ctx.createGain(); mix.gain.value = 0.5;
    saw.connect(lp);
    sine.connect(mix).connect(lp);
    lp.connect(gain).connect(ctx.destination);
    saw.start(now + 0.02); saw.stop(now + 0.21);
    sine.start(now + 0.02); sine.stop(now + 0.21);
  };

  // ---------------------------------------------------------------
  // 8. LIMITER_OFF — burst + descending tone, 200 ms
  // ---------------------------------------------------------------
  sounds.LIMITER_OFF = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.02);
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.35, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
    nSrc.connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.025);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.18);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 5;
    lp.frequency.setValueAtTime(3000, now);
    lp.frequency.exponentialRampToValueAtTime(400, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.21);

    const rev = ctx.createOscillator();
    rev.type = 'sine'; rev.frequency.value = 180;
    const rG = ctx.createGain();
    rG.gain.setValueAtTime(0.06, now + 0.15);
    rG.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
    rev.connect(rG).connect(ctx.destination);
    rev.start(now + 0.15); rev.stop(now + 0.21);
  };

  // ---------------------------------------------------------------
  // 9. SWITCH_TOGGLE — square blip + pitched echo, 40 ms
  // ---------------------------------------------------------------
  sounds.SWITCH_TOGGLE = function() {
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    osc1.type = 'square'; osc1.frequency.value = 1200;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.2, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.008);
    const hs = ctx.createBiquadFilter();
    hs.type = 'highshelf'; hs.frequency.value = 3000; hs.gain.value = 3;
    osc1.connect(hs).connect(g1).connect(ctx.destination);
    osc1.start(now); osc1.stop(now + 0.01);

    const osc2 = ctx.createOscillator();
    osc2.type = 'square'; osc2.frequency.value = 600;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.1, now + 0.01);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    osc2.connect(g2).connect(ctx.destination);
    osc2.start(now + 0.01); osc2.stop(now + 0.04);
  };

  // ---------------------------------------------------------------
  // 10. TAB_INSERT — 3 ascending blips + noise whoosh, 100 ms
  // ---------------------------------------------------------------
  sounds.TAB_INSERT = function() {
    const now = ctx.currentTime;
    const freqs = [660, 990, 1320];

    freqs.forEach((f, i) => {
      const t = now + i * 0.015;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.2, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.025);
    });

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.08);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 4000; bp.Q.value = 1;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.1, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.1);

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.03;
    const dG = ctx.createGain();
    dG.gain.value = 0.06;
    nG.connect(delay).connect(dG).connect(ctx.destination);
  };

  // ---------------------------------------------------------------
  // 11. TAB_CLOSE — 3 descending blips + zip + thud, 90 ms
  // ---------------------------------------------------------------
  sounds.TAB_CLOSE = function() {
    const now = ctx.currentTime;
    const freqs = [1320, 990, 660];

    freqs.forEach((f, i) => {
      const t = now + i * 0.01;
      const osc = ctx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.02);
    });

    const zip = ctx.createOscillator();
    zip.type = 'sawtooth';
    zip.frequency.setValueAtTime(4000, now);
    zip.frequency.exponentialRampToValueAtTime(200, now + 0.05);
    const zG = ctx.createGain();
    zG.gain.setValueAtTime(0.12, now);
    zG.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    zip.connect(zG).connect(ctx.destination);
    zip.start(now); zip.stop(now + 0.06);

    const thud = ctx.createOscillator();
    thud.type = 'sine'; thud.frequency.value = 100;
    const tG = ctx.createGain();
    tG.gain.setValueAtTime(0.15, now + 0.04);
    tG.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    thud.connect(tG).connect(ctx.destination);
    thud.start(now + 0.04); thud.stop(now + 0.09);
  };

  // ---------------------------------------------------------------
  // 12. TAB_SLASH — triangle ping + LFO shimmer + sparkle, 160 ms
  // ---------------------------------------------------------------
  sounds.TAB_SLASH = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 1760;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 6;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 20;
    lfo.connect(lfoG).connect(osc.frequency);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.17);
    lfo.start(now); lfo.stop(now + 0.17);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.06);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 8000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.04, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    nSrc.connect(hp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.06);
  };

  // ---------------------------------------------------------------
  // 13. TYPING_LETTER — noise tap + random pitched body, 25 ms (19 variants)
  // ---------------------------------------------------------------
  sounds.TYPING_LETTER = function() {
    const now = ctx.currentTime;

    const bodyFreq = 1000 + Math.floor(Math.random() * 19) * 80;
    const noiseCentre = 5000 + (Math.random() - 0.5) * 1000;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.015);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = noiseCentre; bp.Q.value = 2;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.25, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.012);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.025);

    const osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = bodyFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
    osc.connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.025);
  };

  // ---------------------------------------------------------------
  // 14. TYPING_BACKSPACE — square pulse + reverse noise, 30 ms
  // ---------------------------------------------------------------
  sounds.TYPING_BACKSPACE = function() {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square'; osc.frequency.value = 600;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.008);
    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.01);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.025);
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass'; nLp.frequency.value = 3000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.015, now + 0.005);
    nG.gain.linearRampToValueAtTime(0.08, now + 0.025);
    nG.gain.linearRampToValueAtTime(0, now + 0.027);
    nSrc.connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now + 0.005); nSrc.stop(now + 0.03);
  };

  // ---------------------------------------------------------------
  // 15. TYPING_ENTER — hard transient + descending saw + sub, 80 ms
  // ---------------------------------------------------------------
  sounds.TYPING_ENTER = function() {
    const now = ctx.currentTime;

    const pop = ctx.createOscillator();
    pop.type = 'square'; pop.frequency.value = 500;
    const pG = ctx.createGain();
    pG.gain.setValueAtTime(0.2, now);
    pG.gain.exponentialRampToValueAtTime(0.001, now + 0.003);
    pop.connect(pG).connect(ctx.destination);
    pop.start(now); pop.stop(now + 0.005);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.01);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3500; bp.Q.value = 1;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.15, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.01);
    nSrc.connect(bp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.012);

    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(500, now);
    body.frequency.exponentialRampToValueAtTime(300, now + 0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1500; lp.Q.value = 6;
    const bG = ctx.createGain();
    bG.gain.setValueAtTime(0.2, now);
    bG.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    body.connect(lp).connect(bG).connect(ctx.destination);
    body.start(now); body.stop(now + 0.08);

    const sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 80;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0.2, now);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now); sub.stop(now + 0.04);
  };

  // ---------------------------------------------------------------
  // 16. TYPING_SPACE — noise puff + triangle undertone, 30 ms
  // ---------------------------------------------------------------
  sounds.TYPING_SPACE = function() {
    const now = ctx.currentTime;

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(0.025);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5000;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.2, now);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 0.02);
    nSrc.connect(bp).connect(lp).connect(nG).connect(ctx.destination);
    nSrc.start(now); nSrc.stop(now + 0.03);

    const osc = ctx.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 350;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.1, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
    osc.connect(g).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.03);
  };

  // ---------------------------------------------------------------
  // 17. APP_START — ghost frequency awakening, 1.2 s
  // ---------------------------------------------------------------
  sounds.APP_START = function() {
    const now = ctx.currentTime;

    // Deep drone — sine slowly fading in, low-passed
    const drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 165;
    const dLp = ctx.createBiquadFilter();
    dLp.type = 'lowpass';
    dLp.frequency.setValueAtTime(300, now);
    dLp.frequency.linearRampToValueAtTime(900, now + 0.6);
    dLp.frequency.exponentialRampToValueAtTime(200, now + 1.2);
    dLp.Q.value = 4;
    const dG = ctx.createGain();
    dG.gain.setValueAtTime(0, now);
    dG.gain.linearRampToValueAtTime(0.18, now + 0.35);
    dG.gain.setValueAtTime(0.18, now + 0.6);
    dG.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    drone.connect(dLp).connect(dG).connect(ctx.destination);
    drone.start(now);
    drone.stop(now + 1.25);

    // Perfect fifth above — enters late, quieter, ethereal
    const fifth = ctx.createOscillator();
    fifth.type = 'sine';
    fifth.frequency.value = 248;
    const fLp = ctx.createBiquadFilter();
    fLp.type = 'lowpass';
    fLp.frequency.value = 600;
    fLp.Q.value = 2;
    const fG = ctx.createGain();
    fG.gain.setValueAtTime(0, now + 0.3);
    fG.gain.linearRampToValueAtTime(0.10, now + 0.6);
    fG.gain.setValueAtTime(0.10, now + 0.75);
    fG.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    fifth.connect(fLp).connect(fG).connect(ctx.destination);
    fifth.start(now + 0.3);
    fifth.stop(now + 1.25);

    // Slow LFO tremolo on drone for breathing feel
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 2.5;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.04;
    lfo.connect(lfoG).connect(dG.gain);
    lfo.start(now);
    lfo.stop(now + 1.25);

    // Dark noise wash — low-passed, slow swell
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(1.1);
    const nLp = ctx.createBiquadFilter();
    nLp.type = 'lowpass';
    nLp.frequency.value = 1200;
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0, now);
    nG.gain.linearRampToValueAtTime(0.04, now + 0.5);
    nG.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
    nSrc.connect(nLp).connect(nG).connect(ctx.destination);
    nSrc.start(now);
    nSrc.stop(now + 1.15);

    // Sub presence
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 55;
    const sG = ctx.createGain();
    sG.gain.setValueAtTime(0, now);
    sG.gain.linearRampToValueAtTime(0.10, now + 0.3);
    sG.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    sub.connect(sG).connect(ctx.destination);
    sub.start(now);
    sub.stop(now + 0.85);
  };

  return sounds;
}

export default { meta, createSounds } as GhostSignalTheme;
