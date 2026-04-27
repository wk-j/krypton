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

const FADE_DURATION = 600;
const BASE_OPACITY = 0.25;
const MIN_COLUMNS = 8;
const COLUMN_DENSITY = 0.01; // columns per pixel of width
const FONT_MIN = 8;
const FONT_MAX = 15;

// ─── Glyph Atlas ─────────────────────────────────────────────────
// Per-frame fillText on OffscreenCanvas is pathological on macOS WebKit —
// every call hits uncached CoreText rasterization + GPU-process IPC. We
// pre-rasterize every (char, fontSize) tile once into an OffscreenCanvas,
// then the per-frame hot loop becomes pure drawImage blits with varying
// globalAlpha. See docs/67-matrix-glyph-atlas.md.

/** Integer font sizes covered by the atlas, inclusive of both ends. */
const ATLAS_SIZES: number[] = (() => {
  const out: number[] = [];
  for (let s = FONT_MIN; s <= FONT_MAX; s++) out.push(s);
  return out;
})();

interface GlyphAtlas {
  dpr: number;
  tileW: number;  // device pixels
  tileH: number;  // device pixels
  tileCssW: number; // css pixels (draw size)
  tileCssH: number; // css pixels
  white: OffscreenCanvas;
  green: OffscreenCanvas;
  /** char -> index in CHAR_POOL */
  charIndex: Map<string, number>;
}

let cachedAtlas: GlyphAtlas | null = null;

function buildAtlas(dpr: number): GlyphAtlas {
  const tileCssW = Math.ceil(FONT_MAX * 1.2);
  const tileCssH = Math.ceil(FONT_MAX * 1.6);
  const tileW = Math.ceil(tileCssW * dpr);
  const tileH = Math.ceil(tileCssH * dpr);

  const cols = ATLAS_SIZES.length;
  const rows = CHAR_POOL.length;

  const white = new OffscreenCanvas(tileW * cols, tileH * rows);
  const wctx = white.getContext('2d');
  if (!wctx) throw new Error('Failed to get 2D context for atlas');
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.fillStyle = '#ffffff';
  wctx.textAlign = 'center';
  wctx.textBaseline = 'alphabetic';

  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const size = ATLAS_SIZES[ci];
      const cx = ci * tileCssW + tileCssW / 2;
      // Baseline near the bottom of the tile leaves descender room above.
      const cy = ri * tileCssH + tileCssH - Math.ceil(size * 0.25);
      wctx.font = `${size}px monospace`;
      wctx.fillText(CHAR_POOL[ri], cx, cy);
    }
  }

  // Tinted green version via source-in composite — bitmap-level recolor, no
  // text rasterization involved.
  const green = new OffscreenCanvas(white.width, white.height);
  const gctx = green.getContext('2d');
  if (!gctx) throw new Error('Failed to get 2D context for atlas');
  gctx.drawImage(white, 0, 0);
  gctx.globalCompositeOperation = 'source-in';
  gctx.fillStyle = '#00ff41';
  gctx.fillRect(0, 0, green.width, green.height);

  const charIndex = new Map<string, number>();
  for (let i = 0; i < CHAR_POOL.length; i++) charIndex.set(CHAR_POOL[i], i);

  return { dpr, tileW, tileH, tileCssW, tileCssH, white, green, charIndex };
}

function getAtlas(dpr: number): GlyphAtlas {
  if (!cachedAtlas || cachedAtlas.dpr !== dpr) {
    cachedAtlas = buildAtlas(dpr);
  }
  return cachedAtlas;
}

function readDpr(ctx: RenderCtx): number {
  const t = ctx.getTransform();
  // setTransform(dpr, 0, 0, dpr, 0, 0) — .a holds the dpr scale.
  return t.a > 0 ? t.a : 1;
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

/** Create a column with random properties */
function spawnColumn(x: number, H: number, startAbove: boolean): MatrixColumn {
  const depth = Math.random();
  // Quantize to integer sizes so every column maps to an atlas tile.
  const fontSize = Math.round(FONT_MAX - (FONT_MAX - FONT_MIN) * depth);
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
    const atlas = getAtlas(readDpr(ctx));
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

      // Draw characters from head upward via the pre-rasterized atlas.
      // No fillText, no font set, no fillStyle churn — just drawImage blits
      // with varying globalAlpha.
      const sizeCol = col.fontSize - FONT_MIN;
      const tileW = atlas.tileW;
      const tileH = atlas.tileH;
      const drawW = atlas.tileCssW;
      const drawH = atlas.tileCssH;
      const halfW = drawW / 2;
      // Atlas baselines were placed near the bottom of each tile, so shift the
      // draw rect up by (drawH - descenderPad) to match the original baseline.
      const baselineOffset = drawH - Math.ceil(col.fontSize * 0.25);

      ctx.save();
      for (let i = 0; i < col.length; i++) {
        const charY = col.y - i * col.fontSize;

        if (charY < -col.fontSize || charY > this.H + col.fontSize) continue;

        const charIdx = i % col.chars.length;
        const fadeRatio = 1 - i / col.length;
        const ch = col.chars[charIdx];
        const ri = atlas.charIndex.get(ch);
        if (ri === undefined) continue;

        const sx = sizeCol * tileW;
        const sy = ri * tileH;
        const dx = col.x - halfW;
        const dy = charY - baselineOffset;

        if (i === 0) {
          // Head: green glow underneath, bright white glyph on top.
          ctx.globalAlpha = col.opacity * 0.5;
          ctx.shadowColor = '#00ff41';
          ctx.shadowBlur = col.fontSize * 0.8;
          ctx.drawImage(atlas.green, sx, sy, tileW, tileH, dx, dy, drawW, drawH);
          ctx.shadowBlur = 0;

          ctx.globalAlpha = col.opacity;
          ctx.drawImage(atlas.white, sx, sy, tileW, tileH, dx, dy, drawW, drawH);
        } else {
          const alpha = col.opacity * fadeRatio * fadeRatio;
          if (alpha < 0.02) continue;

          ctx.globalAlpha = alpha;
          ctx.drawImage(atlas.green, sx, sy, tileW, tileH, dx, dy, drawW, drawH);
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
