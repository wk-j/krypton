// Krypton — Matrix 3D Rain Background Animation
// Canvas-based falling character columns with simulated depth (parallax).
// Renders behind terminal content when Claude Code is actively processing.

import { BackgroundAnimation, RenderCtx } from './flame';

/** Katakana range + digits + select Latin for the character pool */
const CHAR_POOL: string[] = [];
// Katakana U+30A0–U+30FF
for (let i = 0x30A0; i <= 0x30FF; i++) CHAR_POOL.push(String.fromCharCode(i));
// Digits
for (let i = 48; i <= 57; i++) CHAR_POOL.push(String.fromCharCode(i));
// Select Latin uppercase
for (let i = 65; i <= 90; i++) CHAR_POOL.push(String.fromCharCode(i));

function randomChar(): string {
  return CHAR_POOL[Math.floor(Math.random() * CHAR_POOL.length)];
}

/** Single falling column */
interface MatrixColumn {
  x: number;
  y: number;
  speed: number;
  length: number;
  /** 0 = front (large, bright, fast), 1 = back (small, dim, slow) */
  depth: number;
  chars: string[];
  charTimer: number;
  charInterval: number;
  fontSize: number;
  opacity: number;
}

const FADE_DURATION = 600;
const BASE_OPACITY = 0.25;
const MIN_COLUMNS = 8;
const COLUMN_DENSITY = 0.06; // columns per pixel of width
const FONT_MIN = 8;
const FONT_MAX = 15;

/** Create a column with random properties */
function spawnColumn(x: number, H: number, startAbove: boolean): MatrixColumn {
  const depth = Math.random();
  const fontSize = FONT_MAX - (FONT_MAX - FONT_MIN) * depth;
  const speed = (1.5 + Math.random() * 2.5) * (1 - depth * 0.6);
  const length = Math.floor(8 + Math.random() * 20 + (H / fontSize) * 0.3);
  const chars: string[] = [];
  for (let i = 0; i < length; i++) chars.push(randomChar());

  return {
    x,
    y: startAbove ? -(Math.random() * H) : Math.random() * H,
    speed,
    length,
    depth,
    chars,
    charTimer: 0,
    charInterval: Math.floor(3 + Math.random() * 6),
    fontSize,
    opacity: 0.9 - depth * 0.55,
  };
}

// ─── Pure Renderer (no DOM) ─────────────────────────────────────

/** Pure matrix rain renderer — usable from both main thread and Web Worker */
export class MatrixRenderer {
  private columns: MatrixColumn[] = [];
  private W: number = 0;
  private H: number = 0;

  init(W: number, H: number): void {
    this.W = W;
    this.H = H;
    const count = Math.max(MIN_COLUMNS, Math.floor(W * COLUMN_DENSITY));
    this.columns = [];
    for (let i = 0; i < count; i++) {
      const x = (i / count) * W + (Math.random() - 0.5) * (W / count) * 0.6;
      this.columns.push(spawnColumn(x, H, false));
    }
    this.columns.sort((a, b) => b.depth - a.depth);
  }

  update(ctx: RenderCtx, W: number, H: number): void {
    if (this.W !== W || this.H !== H) this.init(W, H);
    this.updateAndDraw(ctx);
  }

  private updateAndDraw(ctx: RenderCtx): void {
    for (const col of this.columns) {
      // Advance position
      col.y += col.speed;

      // Cycle characters periodically
      col.charTimer++;
      if (col.charTimer >= col.charInterval) {
        col.charTimer = 0;
        const swaps = 1 + Math.floor(Math.random() * 3);
        for (let s = 0; s < swaps; s++) {
          const idx = Math.floor(Math.random() * col.chars.length);
          col.chars[idx] = randomChar();
        }
      }

      // Reset column when fully off-screen
      const tailEnd = col.y - col.length * col.fontSize;
      if (tailEnd > this.H) {
        const newCol = spawnColumn(col.x, this.H, true);
        newCol.x = col.x;
        Object.assign(col, newCol);
        col.y = -col.length * col.fontSize * Math.random();
        continue;
      }

      // Draw characters from head upward
      ctx.save();
      ctx.font = `${col.fontSize}px monospace`;
      ctx.textAlign = 'center';

      for (let i = 0; i < col.length; i++) {
        const charY = col.y - i * col.fontSize;

        if (charY < -col.fontSize || charY > this.H + col.fontSize) continue;

        const charIdx = i % col.chars.length;
        const fadeRatio = 1 - i / col.length;

        if (i === 0) {
          ctx.globalAlpha = col.opacity;
          ctx.fillStyle = '#e0ffe0';
          ctx.fillText(col.chars[charIdx], col.x, charY);

          ctx.globalAlpha = col.opacity * 0.5;
          ctx.shadowColor = '#00ff41';
          ctx.shadowBlur = col.fontSize * 0.8;
          ctx.fillText(col.chars[charIdx], col.x, charY);
          ctx.shadowBlur = 0;
        } else {
          const alpha = col.opacity * fadeRatio * fadeRatio;
          if (alpha < 0.02) continue;

          ctx.globalAlpha = alpha;
          const g = Math.floor(255 - fadeRatio * 40);
          const b = Math.floor(40 + (1 - fadeRatio) * 80);
          ctx.fillStyle = `rgb(0,${g},${b})`;
          ctx.fillText(col.chars[charIdx], col.x, charY);
        }
      }

      ctx.restore();
    }
  }
}

// ─── DOM Animation (main-thread fallback) ────────────────────────

/** Manages a single Matrix rain canvas animation instance */
export class MatrixAnimation implements BackgroundAnimation {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private renderer = new MatrixRenderer();
  private animFrame: number = 0;
  private running: boolean = false;
  private W: number = 0;
  private H: number = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-matrix-canvas';
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
    this.renderer = new MatrixRenderer();
  }

  private tick = (): void => {
    if (!this.running) return;

    this.ctx.clearRect(0, 0, this.W, this.H);
    this.renderer.update(this.ctx, this.W, this.H);

    this.animFrame = requestAnimationFrame(this.tick);
  };
}
