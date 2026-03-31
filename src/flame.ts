// Krypton — Background Animations
// Canvas-based animations that render behind terminal content when Claude Code
// is actively processing a prompt.

/** Common interface for all background animations */
export interface BackgroundAnimation {
  getElement(): HTMLCanvasElement;
  start(): void;
  stop(): void;
  resize(): void;
  dispose(): void;
  isRunning(): boolean;
}

/** Render context type — works for both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D */
export type RenderCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Single flame particle */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  r: number;
}

/** Wave layer definition */
interface WaveLayer {
  freq: number;
  amp: number;
  speed: number;
  color: string;
  width: number;
}

const FADE_DURATION = 600;
const BASE_OPACITY = 0.25;
const PARTICLE_DENSITY = 0.18;

const WAVE_LAYERS: WaveLayer[] = [
  { freq: 2.1, amp: 0.38, speed: 0.3, color: 'rgba(255,160,20,0.9)', width: 2.0 },
  { freq: 3.6, amp: 0.22, speed: 0.5, color: 'rgba(255,80,0,0.5)', width: 1.2 },
  { freq: 1.3, amp: 0.14, speed: 0.2, color: 'rgba(200,30,0,0.25)', width: 0.7 },
];
const WAVE_GLOW = 'rgba(255,220,80,0.35)';

// ─── Pure Renderer (no DOM) ─────────────────────────────────────

/** Pure flame+wave renderer — usable from both main thread and Web Worker */
export class FlameRenderer {
  private particles: Particle[] = [];
  private t: number = 0;
  private W: number = 0;
  private H: number = 0;

  init(W: number, H: number): void {
    this.W = W;
    this.H = H;
    const count = Math.max(18, Math.round(W * PARTICLE_DENSITY));
    this.particles = [];
    for (let i = 0; i < count; i++) {
      this.particles.push(this.newParticle(true));
    }
  }

  update(ctx: RenderCtx, W: number, H: number): void {
    if (this.W !== W || this.H !== H) this.init(W, H);
    this.drawFlame(ctx);
    this.drawWave(ctx);
    this.t += 0.009;
  }

  private newParticle(randomY: boolean): Particle {
    const CX = this.W / 2;
    const life = 0.4 + Math.random() * 0.6;
    return {
      x: CX + (Math.random() - 0.5) * this.W * 0.9,
      y: randomY ? Math.random() * this.H : this.H,
      vx: (Math.random() - 0.5) * 0.5,
      vy: -(0.3 + Math.random() * 0.6) * (this.H / 60),
      life: randomY ? Math.random() * life : life,
      maxLife: life,
      r: 1.5 + Math.random() * (this.W / 30),
    };
  }

  private flameColor(ratio: number, alpha: number): string {
    if (ratio < 0.20) return `rgba(255,255,200,${alpha})`;
    if (ratio < 0.45) return `rgba(255,200,20,${alpha})`;
    if (ratio < 0.65) return `rgba(255,100,0,${alpha})`;
    if (ratio < 0.82) return `rgba(220,30,0,${alpha})`;
    return `rgba(100,0,0,${alpha * 0.4})`;
  }

  private drawFlame(ctx: RenderCtx): void {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const ratio = 1 - p.life / p.maxLife;
      const alpha = Math.sin(ratio * Math.PI) * 0.85;
      const r = p.r * (1 - ratio * 0.4);

      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fillStyle = this.flameColor(ratio, alpha);
      ctx.fill();

      p.x += p.vx + Math.sin(this.t * 1.8 + i * 0.7) * 0.18;
      p.y += p.vy;
      p.life -= 0.009;

      if (p.life <= 0) {
        this.particles[i] = this.newParticle(false);
      }
    }
  }

  private drawWave(ctx: RenderCtx): void {
    const cy = this.H * 0.75;
    const waveH = this.H * 0.25;

    for (const l of WAVE_LAYERS) {
      ctx.beginPath();
      ctx.lineWidth = l.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = l.color;

      for (let x = 0; x <= this.W; x++) {
        const nx = x / this.W;
        const env = Math.sin(nx * Math.PI);
        const y = cy + Math.sin(nx * Math.PI * 2 * l.freq + this.t * l.speed)
          * (waveH * 0.75) * l.amp * env;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Glow pass
      ctx.beginPath();
      ctx.lineWidth = l.width * 0.35;
      ctx.strokeStyle = WAVE_GLOW;

      for (let x = 0; x <= this.W; x++) {
        const nx = x / this.W;
        const env = Math.sin(nx * Math.PI);
        const y = cy + Math.sin(nx * Math.PI * 2 * l.freq + this.t * l.speed)
          * (waveH * 0.75) * l.amp * env;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}

// ─── DOM Animation (main-thread fallback) ────────────────────────

/** Manages a single flame+wave canvas animation instance */
export class FlameAnimation implements BackgroundAnimation {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private renderer = new FlameRenderer();
  private animFrame: number = 0;
  private running: boolean = false;
  private W: number = 0;
  private H: number = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-flame-canvas';
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
  }

  dispose(): void {
    this.running = false;
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = 0;
    }
    this.canvas.remove();
  }

  private tick = (): void => {
    if (!this.running) return;

    this.ctx.clearRect(0, 0, this.W, this.H);
    this.renderer.update(this.ctx, this.W, this.H);

    this.animFrame = requestAnimationFrame(this.tick);
  };
}
