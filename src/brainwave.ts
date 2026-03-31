// Krypton — Brainwave EEG Background Animation
// Canvas-based multi-channel EEG waveform animation that renders behind terminal
// content when Claude Code is actively processing a prompt.
// Features: multi-layered channels with harmonics, travelling spike pulses,
// grid overlay, data readout tickers, and glow compositing.

import { BackgroundAnimation, RenderCtx } from './flame';

/** Single EEG channel definition */
interface Channel {
  baseFreq: number;
  harmonics: number[];
  harmonicAmps: number[];
  noiseFreq: number;
  noiseAmp: number;
  color: string;
  glowColor: string;
  width: number;
  speed: number;
  phase: number;
  spikeLife: number;
  spikeAmp: number;
  spikePos: number;
  spikeSpeed: number;
}

/** Floating data readout near a channel */
interface Readout {
  channel: number;
  x: number;
  value: string;
  opacity: number;
  life: number;
}

/** Vertical scan pulse */
interface ScanPulse {
  x: number;
  speed: number;
  width: number;
  opacity: number;
}

const FADE_DURATION = 600;
const BASE_OPACITY = 0.22;

/** Channel definitions — 4 EEG bands with harmonics */
function createChannels(): Channel[] {
  return [
    {
      baseFreq: 1.2, harmonics: [2.4, 3.6], harmonicAmps: [0.3, 0.1],
      noiseFreq: 8, noiseAmp: 0.25,
      color: 'rgba(0,255,200,0.75)', glowColor: 'rgba(0,255,200,0.3)',
      width: 2.0, speed: 0.12, phase: 0,
      spikeLife: 0, spikeAmp: 0, spikePos: 0, spikeSpeed: 0,
    },
    {
      baseFreq: 4.2, harmonics: [8.4, 12.6], harmonicAmps: [0.2, 0.12],
      noiseFreq: 20, noiseAmp: 0.18,
      color: 'rgba(60,150,255,0.65)', glowColor: 'rgba(60,150,255,0.22)',
      width: 1.5, speed: 0.26, phase: 1.2,
      spikeLife: 0, spikeAmp: 0, spikePos: 0, spikeSpeed: 0,
    },
    {
      baseFreq: 7.0, harmonics: [14, 21], harmonicAmps: [0.15, 0.06],
      noiseFreq: 30, noiseAmp: 0.3,
      color: 'rgba(130,80,255,0.6)', glowColor: 'rgba(130,80,255,0.2)',
      width: 1.2, speed: 0.35, phase: 2.4,
      spikeLife: 0, spikeAmp: 0, spikePos: 0, spikeSpeed: 0,
    },
    {
      baseFreq: 11.0, harmonics: [22, 33], harmonicAmps: [0.12, 0.05],
      noiseFreq: 45, noiseAmp: 0.35,
      color: 'rgba(200,50,255,0.5)', glowColor: 'rgba(200,50,255,0.18)',
      width: 0.9, speed: 0.48, phase: 3.6,
      spikeLife: 0, spikeAmp: 0, spikePos: 0, spikeSpeed: 0,
    },
  ];
}

// ─── Pure Renderer (no DOM) ─────────────────────────────────────

/** Pure brainwave EEG renderer — usable from both main thread and Web Worker */
export class BrainwaveRenderer {
  private channels: Channel[] = [];
  private readouts: Readout[] = [];
  private scanPulses: ScanPulse[] = [];
  private t: number = 0;
  private W: number = 0;
  private H: number = 0;
  private waveCache: Float32Array[] = [];

  init(W: number, H: number): void {
    this.W = W;
    this.H = H;
    this.channels = createChannels();
    this.readouts = [];
    this.scanPulses = [];
    this.waveCache = this.channels.map(() => new Float32Array(Math.ceil(W) + 1));
  }

  update(ctx: RenderCtx, W: number, H: number): void {
    if (this.W !== W || this.H !== H) this.init(W, H);
    if (this.channels.length === 0) this.init(W, H);

    this.drawGrid(ctx);
    this.updateScanPulses();
    this.drawScanPulses(ctx);
    this.computeWaves();
    this.drawChannels(ctx);
    this.updateReadouts();
    this.drawReadouts(ctx);

    this.t += 0.008;
  }

  private drawGrid(ctx: RenderCtx): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,255,200,0.04)';
    ctx.lineWidth = 0.5;

    const hSpacing = 30;
    for (let y = 0; y < this.H; y += hSpacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.W, y);
      ctx.stroke();
    }

    const vSpacing = 50;
    for (let x = 0; x < this.W; x += vSpacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.H);
      ctx.stroke();
    }

    ctx.restore();
  }

  private updateScanPulses(): void {
    if (Math.random() < 0.005) {
      this.scanPulses.push({
        x: -20,
        speed: 1.5 + Math.random() * 2.5,
        width: 30 + Math.random() * 60,
        opacity: 0.04 + Math.random() * 0.06,
      });
    }

    for (let i = this.scanPulses.length - 1; i >= 0; i--) {
      this.scanPulses[i].x += this.scanPulses[i].speed;
      if (this.scanPulses[i].x > this.W + this.scanPulses[i].width) {
        this.scanPulses.splice(i, 1);
      }
    }
  }

  private drawScanPulses(ctx: RenderCtx): void {
    for (const pulse of this.scanPulses) {
      const grad = ctx.createLinearGradient(
        pulse.x - pulse.width / 2, 0,
        pulse.x + pulse.width / 2, 0
      );
      grad.addColorStop(0, 'rgba(0,255,200,0)');
      grad.addColorStop(0.5, `rgba(0,255,200,${pulse.opacity})`);
      grad.addColorStop(1, 'rgba(0,255,200,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(pulse.x - pulse.width / 2, 0, pulse.width, this.H);
    }
  }

  private computeWaves(): void {
    const numChannels = this.channels.length;
    const margin = this.H * 0.08;
    const usableH = this.H - margin * 2;
    const spacing = usableH / (numChannels + 1);

    for (let ci = 0; ci < numChannels; ci++) {
      const ch = this.channels[ci];
      const cy = margin + spacing * (ci + 1);
      const amp = spacing * 0.32;

      if (ch.spikeLife <= 0 && Math.random() < 0.004) {
        ch.spikeLife = 20 + Math.random() * 25;
        ch.spikeAmp = 1.8 + Math.random() * 1.8;
        ch.spikePos = Math.random() * 0.3;
        ch.spikeSpeed = 0.008 + Math.random() * 0.012;
      }

      const spikeMultiplier = ch.spikeLife > 0
        ? 1 + (ch.spikeAmp - 1) * (ch.spikeLife / 35)
        : 1;
      if (ch.spikeLife > 0) {
        ch.spikeLife--;
        ch.spikePos += ch.spikeSpeed;
      }

      const cache = this.waveCache[ci];
      if (!cache) continue;

      for (let x = 0; x <= this.W; x++) {
        const nx = x / this.W;
        const env = Math.sin(nx * Math.PI);

        let wave = Math.sin(nx * Math.PI * 2 * ch.baseFreq + this.t * ch.speed * 10 + ch.phase);

        for (let hi = 0; hi < ch.harmonics.length; hi++) {
          wave += Math.sin(
            nx * Math.PI * 2 * ch.harmonics[hi] + this.t * ch.speed * 10 * (hi + 2) + ch.phase
          ) * ch.harmonicAmps[hi];
        }

        const noise = Math.sin(nx * Math.PI * 2 * ch.noiseFreq + this.t * ch.speed * 25)
          * ch.noiseAmp;

        const spikePulse = ch.spikeLife > 0
          ? Math.exp(-Math.pow((nx - ch.spikePos) * 6, 2)) * (spikeMultiplier - 1)
          : 0;

        cache[x] = cy + (wave + noise) * amp * env * (1 + spikePulse);
      }
    }
  }

  private drawChannels(ctx: RenderCtx): void {
    const numChannels = this.channels.length;

    for (let ci = 0; ci < numChannels; ci++) {
      const ch = this.channels[ci];
      const cache = this.waveCache[ci];
      if (!cache) continue;

      // Outer glow pass
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.lineWidth = ch.width * 5;
      ctx.strokeStyle = ch.glowColor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let x = 0; x <= this.W; x += 3) {
        x === 0 ? ctx.moveTo(x, cache[x]) : ctx.lineTo(x, cache[x]);
      }
      ctx.stroke();
      ctx.restore();

      // Inner glow pass
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.lineWidth = ch.width * 2.5;
      ctx.strokeStyle = ch.glowColor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let x = 0; x <= this.W; x += 2) {
        x === 0 ? ctx.moveTo(x, cache[x]) : ctx.lineTo(x, cache[x]);
      }
      ctx.stroke();
      ctx.restore();

      // Main crisp stroke
      ctx.beginPath();
      ctx.lineWidth = ch.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = ch.color;
      for (let x = 0; x <= this.W; x++) {
        x === 0 ? ctx.moveTo(x, cache[x]) : ctx.lineTo(x, cache[x]);
      }
      ctx.stroke();

      // Data point dots at spike peaks
      if (ch.spikeLife > 0 && ch.spikeLife < 15) {
        const peakX = Math.round(ch.spikePos * this.W);
        if (peakX >= 0 && peakX <= this.W && cache[peakX] !== undefined) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const dotRadius = 2 + ch.width;
          ctx.beginPath();
          ctx.arc(peakX, cache[peakX], dotRadius, 0, Math.PI * 2);
          ctx.fillStyle = ch.color;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(peakX, cache[peakX], dotRadius * 3, 0, Math.PI * 2);
          ctx.fillStyle = ch.glowColor;
          ctx.fill();
          ctx.restore();
        }
      }

      // Channel label
      if (ci < numChannels) {
        const labels = ['\u03b4', '\u03b1', '\u03b2', '\u03b3'];
        const margin = this.H * 0.08;
        const usableH = this.H - margin * 2;
        const spacing = usableH / (numChannels + 1);
        const cy = margin + spacing * (ci + 1);

        ctx.save();
        ctx.font = '9px monospace';
        ctx.fillStyle = ch.color;
        ctx.globalAlpha = 0.6;
        ctx.fillText(labels[ci] ?? '', 4, cy - spacing * 0.3);
        ctx.restore();
      }
    }
  }

  private updateReadouts(): void {
    if (Math.random() < 0.01 && this.readouts.length < 6) {
      const ci = Math.floor(Math.random() * this.channels.length);
      const x = 0.2 + Math.random() * 0.6;
      const freqLabels = ['1.2Hz', '4.2Hz', '7.0Hz', '11Hz'];
      const values = [
        freqLabels[ci] ?? '',
        `${(Math.random() * 80 + 20).toFixed(0)}\u03bcV`,
        `SNR ${(Math.random() * 12 + 3).toFixed(1)}`,
        `\u0394${(Math.random() * 2 - 1).toFixed(2)}`,
      ];
      this.readouts.push({
        channel: ci,
        x,
        value: values[Math.floor(Math.random() * values.length)],
        opacity: 0.5,
        life: 80 + Math.random() * 60,
      });
    }

    for (let i = this.readouts.length - 1; i >= 0; i--) {
      this.readouts[i].life--;
      if (this.readouts[i].life < 20) {
        this.readouts[i].opacity *= 0.92;
      }
      if (this.readouts[i].life <= 0) {
        this.readouts.splice(i, 1);
      }
    }
  }

  private drawReadouts(ctx: RenderCtx): void {
    const numChannels = this.channels.length;
    const margin = this.H * 0.08;
    const usableH = this.H - margin * 2;
    const spacing = usableH / (numChannels + 1);

    ctx.save();
    ctx.font = '8px monospace';

    for (const r of this.readouts) {
      const ch = this.channels[r.channel];
      if (!ch) continue;
      const cy = margin + spacing * (r.channel + 1);
      const px = r.x * this.W;

      ctx.globalAlpha = r.opacity * 0.5;
      ctx.fillStyle = ch.color;
      ctx.fillText(r.value, px, cy - spacing * 0.35);
    }

    ctx.restore();
  }
}

// ─── DOM Animation (main-thread fallback) ────────────────────────

/** Manages a single brainwave EEG canvas animation instance */
export class BrainwaveAnimation implements BackgroundAnimation {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private renderer = new BrainwaveRenderer();
  private animFrame: number = 0;
  private running: boolean = false;
  private W: number = 0;
  private H: number = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-brainwave-canvas';
    this.ctx = this.canvas.getContext('2d')!;
  }

  getElement(): HTMLCanvasElement {
    return this.canvas;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.renderer.init(this.W, this.H);
    this.canvas.style.opacity = '0';
    this.canvas.style.display = 'block';

    requestAnimationFrame(() => {
      this.canvas.style.transition = `opacity ${FADE_DURATION}ms ease-in`;
      this.canvas.style.opacity = String(BASE_OPACITY);
    });

    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.canvas.style.transition = `opacity ${FADE_DURATION}ms ease-out`;
    this.canvas.style.opacity = '0';

    setTimeout(() => {
      if (!this.running) {
        if (this.animFrame) {
          cancelAnimationFrame(this.animFrame);
          this.animFrame = 0;
        }
        this.canvas.style.display = 'none';
      }
    }, FADE_DURATION + 50);
  }

  isRunning(): boolean {
    return this.running;
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = parent.getBoundingClientRect();
    this.W = rect.width;
    this.H = rect.height;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.renderer.init(this.W, this.H);
  }

  dispose(): void {
    this.running = false;
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = 0;
    }
    this.canvas.remove();
    this.renderer = new BrainwaveRenderer();
  }

  private tick = (): void => {
    if (!this.running) return;

    this.ctx.clearRect(0, 0, this.W, this.H);
    this.renderer.update(this.ctx, this.W, this.H);

    this.animFrame = requestAnimationFrame(this.tick);
  };
}
