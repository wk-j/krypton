// Krypton — Brainwave EEG Background Animation
// Canvas-based multi-channel EEG waveform animation that renders behind terminal
// content when Claude Code is actively processing a prompt.

import { BackgroundAnimation } from './flame';

/** Single EEG channel definition */
interface Channel {
  baseFreq: number;
  noiseFreq: number;
  noiseAmp: number;
  color: string;
  glowColor: string;
  width: number;
  speed: number;
  /** Spike state: remaining frames of elevated amplitude */
  spikeLife: number;
  spikeAmp: number;
}

const FADE_DURATION = 600;
const BASE_OPACITY = 0.20;

/** Channel definitions — 5 EEG-like bands */
function createChannels(): Channel[] {
  return [
    // Delta — slow, high amplitude
    { baseFreq: 1.2, noiseFreq: 8, noiseAmp: 0.3, color: 'rgba(0,255,200,0.7)', glowColor: 'rgba(0,255,200,0.25)', width: 1.8, speed: 0.15, spikeLife: 0, spikeAmp: 0 },
    // Theta — moderate
    { baseFreq: 2.5, noiseFreq: 12, noiseAmp: 0.25, color: 'rgba(0,200,255,0.65)', glowColor: 'rgba(0,200,255,0.2)', width: 1.5, speed: 0.22, spikeLife: 0, spikeAmp: 0 },
    // Alpha — classic brain rhythm
    { baseFreq: 4.0, noiseFreq: 18, noiseAmp: 0.2, color: 'rgba(80,140,255,0.6)', glowColor: 'rgba(80,140,255,0.2)', width: 1.3, speed: 0.30, spikeLife: 0, spikeAmp: 0 },
    // Beta — fast, low amplitude
    { baseFreq: 6.5, noiseFreq: 28, noiseAmp: 0.35, color: 'rgba(120,80,255,0.55)', glowColor: 'rgba(120,80,255,0.18)', width: 1.0, speed: 0.40, spikeLife: 0, spikeAmp: 0 },
    // Gamma — fastest, subtle
    { baseFreq: 10.0, noiseFreq: 40, noiseAmp: 0.4, color: 'rgba(180,60,255,0.45)', glowColor: 'rgba(180,60,255,0.15)', width: 0.8, speed: 0.50, spikeLife: 0, spikeAmp: 0 },
  ];
}

/** Manages a single brainwave EEG canvas animation instance */
export class BrainwaveAnimation implements BackgroundAnimation {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private channels: Channel[] = [];
  private animFrame: number = 0;
  private t: number = 0;
  private running: boolean = false;
  private W: number = 0;
  private H: number = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-brainwave-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.channels = createChannels();
  }

  getElement(): HTMLCanvasElement {
    return this.canvas;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
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
  }

  dispose(): void {
    this.running = false;
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = 0;
    }
    this.canvas.remove();
    this.channels = [];
  }

  // ─── Private ───────────────────────────────────────────────────

  private tick = (): void => {
    if (!this.running) return;

    this.ctx.clearRect(0, 0, this.W, this.H);
    this.drawChannels();

    this.t += 0.008;
    this.animFrame = requestAnimationFrame(this.tick);
  };

  private drawChannels(): void {
    const numChannels = this.channels.length;
    const margin = this.H * 0.1;
    const usableH = this.H - margin * 2;
    const spacing = usableH / (numChannels + 1);

    for (let ci = 0; ci < numChannels; ci++) {
      const ch = this.channels[ci];
      const cy = margin + spacing * (ci + 1);
      const amp = spacing * 0.35;

      // Random spike trigger (~0.3% chance per frame)
      if (ch.spikeLife <= 0 && Math.random() < 0.003) {
        ch.spikeLife = 15 + Math.random() * 20;
        ch.spikeAmp = 1.5 + Math.random() * 1.5;
      }

      // Decay spike
      const spikeMultiplier = ch.spikeLife > 0
        ? 1 + (ch.spikeAmp - 1) * (ch.spikeLife / 30)
        : 1;
      if (ch.spikeLife > 0) ch.spikeLife--;

      // Main stroke
      this.ctx.beginPath();
      this.ctx.lineWidth = ch.width;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.strokeStyle = ch.color;

      for (let x = 0; x <= this.W; x++) {
        const nx = x / this.W;
        // Envelope: fade edges to flat baseline
        const env = Math.sin(nx * Math.PI);
        // Base wave
        const base = Math.sin(nx * Math.PI * 2 * ch.baseFreq + this.t * ch.speed * 10);
        // High-frequency noise
        const noise = Math.sin(nx * Math.PI * 2 * ch.noiseFreq + this.t * ch.speed * 25)
          * ch.noiseAmp;
        // Spike envelope (travels as a pulse)
        const spikePulse = ch.spikeLife > 0
          ? Math.exp(-Math.pow((nx - 0.5) * 4, 2)) * (spikeMultiplier - 1)
          : 0;
        const y = cy + (base + noise) * amp * env * (1 + spikePulse);
        x === 0 ? this.ctx.moveTo(x, y) : this.ctx.lineTo(x, y);
      }
      this.ctx.stroke();

      // Glow pass
      this.ctx.beginPath();
      this.ctx.lineWidth = ch.width * 3;
      this.ctx.strokeStyle = ch.glowColor;

      for (let x = 0; x <= this.W; x += 2) {
        const nx = x / this.W;
        const env = Math.sin(nx * Math.PI);
        const base = Math.sin(nx * Math.PI * 2 * ch.baseFreq + this.t * ch.speed * 10);
        const noise = Math.sin(nx * Math.PI * 2 * ch.noiseFreq + this.t * ch.speed * 25)
          * ch.noiseAmp;
        const spikePulse = ch.spikeLife > 0
          ? Math.exp(-Math.pow((nx - 0.5) * 4, 2)) * (spikeMultiplier - 1)
          : 0;
        const y = cy + (base + noise) * amp * env * (1 + spikePulse);
        x === 0 ? this.ctx.moveTo(x, y) : this.ctx.lineTo(x, y);
      }
      this.ctx.stroke();
    }
  }
}
