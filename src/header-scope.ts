// Krypton — Header Oscilloscope Band
// Per-window canvas that renders a live oscilloscope trace in the window head
// (replacing the static .krypton-window__header-accent tick band). Its amplitude
// is driven by the window's real PTY output throughput via pump(bytes). The rAF
// loop STOPS when the window goes idle (energy + buffer decay to ~0), so an idle
// window's band consumes 0 CPU — honoring the <1% idle-CPU architecture budget.
// Under prefers-reduced-motion it renders a single static hairline and never
// animates. Implements BackgroundAnimation so it shares the canvas-in-chrome
// lifecycle conventions used by claude-hooks (start/stop/resize/dispose).
//
// See docs/188-oscilloscope-header-band.md.

import { BackgroundAnimation } from './flame';

/** Per-frame energy decay — energy falls below EPS ~0.6s after the last pump,
 *  which is what guarantees the loop self-stops when output ceases. */
const DECAY = 0.9;
/** Bytes that map to roughly a full-scale energy bump. Tuned low so that
 *  ordinary interactive output (command results, prompt redraws — tens to a
 *  few hundred bytes) produces a visible deflection on the ~6px band, not just
 *  multi-kilobyte bursts. */
const BYTES_SCALE = 512;
/** Below this, energy and buffer are treated as silence and the loop stops. */
const EPS = 0.02;
/** Safety net: force-stop if the loop is somehow still running long after the
 *  last pump (mirrors the claude-hooks idle watchdog). Normal decay stops it
 *  far sooner; this only catches a stuck loop. */
const WATCHDOG_MS = 5000;
/** Fallback accent when the CSS custom property is not yet resolvable. */
const DEFAULT_ACCENT = '0, 200, 255';

export class HeaderScope implements BackgroundAnimation {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = Math.max(1, window.devicePixelRatio || 1);
  private w = 0;
  private h = 0;
  private n = 0;
  private buf: Float32Array = new Float32Array(0);
  private energy = 0;
  private phase = 0;
  private raf = 0;
  private running = false;
  private lastPump = 0;
  private accent = DEFAULT_ACCENT;
  private readonly ro: ResizeObserver;
  private readonly reduceMotion: MediaQueryList;
  private readonly onReduceChange: () => void;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className =
      'krypton-window__header-accent krypton-window__header-accent--scope';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('HeaderScope: 2D canvas context unavailable');
    this.ctx = ctx;

    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.onReduceChange = (): void => {
      if (this.reduceMotion.matches) this.stop();
      this.drawStatic();
    };
    this.reduceMotion.addEventListener('change', this.onReduceChange);

    // React to window relayout (Grid/Focus) without touching the compositor.
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
  }

  getElement(): HTMLCanvasElement {
    return this.canvas;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Re-read the per-lane accent from the inherited CSS custom property.
   *  Call on theme-changed / lane-accent changes. */
  refreshColor(): void {
    const v = getComputedStyle(this.canvas)
      .getPropertyValue('--krypton-window-accent-rgb')
      .trim();
    if (v) this.accent = v;
    if (!this.running) this.drawStatic();
  }

  /** Feed real throughput. Bumps energy and (re)starts the loop if stopped. */
  pump(bytes: number): void {
    this.lastPump = performance.now();
    if (this.reduceMotion.matches) return;
    this.energy = Math.min(1, this.energy + bytes / BYTES_SCALE);
    this.start();
  }

  /** DPR-aware resize; remaps the ring buffer so the trace does not pop. */
  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return; // hidden (e.g. QT collapsed)
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width * this.dpr));
    this.h = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.width = this.w;
    this.canvas.height = this.h;

    const n = Math.max(8, Math.floor(this.w / (this.dpr * 2)));
    const nb = new Float32Array(n);
    const copy = Math.min(n, this.n);
    for (let i = 0; i < copy; i++) nb[n - 1 - i] = this.buf[this.n - 1 - i] || 0;
    this.buf = nb;
    this.n = n;

    this.refreshColor();
    if (!this.running) this.drawStatic();
  }

  start(): void {
    if (this.running || this.reduceMotion.matches) return;
    if (this.n === 0) this.resize();
    if (this.n === 0) return; // still hidden — nothing to draw yet
    this.running = true;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  dispose(): void {
    this.stop();
    this.ro.disconnect();
    this.reduceMotion.removeEventListener('change', this.onReduceChange);
    this.canvas.remove();
  }

  private readonly loop = (): void => {
    if (!this.running) return;
    this.energy *= DECAY;
    this.phase += 0.06;
    this.pushSample(this.energy * this.wob(this.phase));
    this.draw();

    const stuck = performance.now() - this.lastPump > WATCHDOG_MS;
    if (!stuck && (this.energy > EPS || this.bufMax() > EPS)) {
      this.raf = requestAnimationFrame(this.loop);
    } else {
      this.stop();
      this.energy = 0;
      this.buf = new Float32Array(this.n);
      this.drawStatic();
    }
  };

  /** Smooth, non-repeating waveform shape (sum of incommensurate sines). */
  private wob(t: number): number {
    return (
      (Math.sin(t * 1.3) + 0.5 * Math.sin(t * 2.7 + 1.1) + 0.3 * Math.sin(t * 5.1 + 2.3)) /
      1.8
    );
  }

  private pushSample(v: number): void {
    const b = this.buf;
    for (let i = 0; i < this.n - 1; i++) b[i] = b[i + 1];
    b[this.n - 1] = v;
  }

  private bufMax(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      const a = Math.abs(this.buf[i]);
      if (a > m) m = a;
    }
    return m;
  }

  private draw(): void {
    const { ctx, w, h, n } = this;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 6 * this.dpr;
    ctx.shadowColor = `rgba(${this.accent}, 0.9)`;
    ctx.strokeStyle = `rgba(${this.accent}, ${(0.6 + Math.min(0.4, this.energy)).toFixed(3)})`;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = mid - this.buf[i] * mid * 0.92;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /** Idle / reduced-motion rendering: a single faint flat hairline. */
  private drawStatic(): void {
    if (this.w === 0 || this.h === 0) return;
    const { ctx, w, h } = this;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.strokeStyle = `rgba(${this.accent}, 0.28)`;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }
}
