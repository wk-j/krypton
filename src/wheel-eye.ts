// Krypton — Wheel ghost eye (spec 274)
// The active Wheel card's eye: an almond of streaming text, ported from the
// user's "watching eye" study, drawn on one canvas that moves to whichever card
// holds the focused window. The pupil follows the mouse pointer. Once the
// pointer has been still for 3.5 s it watches output activity instead (the main
// frame or the busiest card), and with nothing to watch it drifts. The eye runs
// its own clock: rAF only while the pointer moves or the lids blink, 80 ms
// while it watches something, 420 ms when quiet. A frame redraws only when the
// visible grid changes.

import { WHEEL_ACTIVE_SCALE, WHEEL_CARD_HEIGHT, WHEEL_CARD_WIDTH } from './wheel-layout';

export const WHEEL_EYE_FONT_PX = 3.6;
export const WHEEL_EYE_LINE_PX = 4;
/** Target distance (px) at which the pupil is tanh(1) ≈ 76% of the way to its rim. */
export const WHEEL_EYE_REACH = 360;
/** Least activity the eye bothers to look at. */
export const WHEEL_EYE_WAKE = 0.08;
/** The pointer leads the gaze until it has been still this long. */
export const WHEEL_EYE_POINTER_IDLE_MS = 3500;
export const WHEEL_EYE_BLINK_MS = 160;
/** Most characters of window text the eye is made of. */
export const WHEEL_EYE_TEXT_MAX = 400;

const POINTER_FRESH_MS = 1000;
const AWAKE_MS = 80;
const QUIET_MS = 420;
/** Per-frame eases at 60 fps (the study's values); applied time-based. */
const GAZE_EASE = 0.12;
const DILATE_EASE = 0.08;
const FRAME_MS = 1000 / 60;

export type WheelEyeClass = 'o' | 'i' | 'p';

/** Consecutive same-class cells in one grid row. */
export interface WheelEyeRun {
  cls: WheelEyeClass;
  col: number;
  text: string;
}

export interface WheelEyeState {
  cols: number;
  rows: number;
  /** Pupil offset from the centre, in cells. */
  px: number;
  py: number;
  /** Pupil dilation, 1 … 1.9. */
  dil: number;
  /** 0 open … 1 closed. */
  lid: number;
  /** Text scroll, in characters. */
  offset: number;
  /** The pointer is inside the eye. */
  alert: boolean;
}

/** A point to look at, in viewport px, with a 0–1 level that drives dilation. */
export interface WheelEyePoint {
  x: number;
  y: number;
  level: number;
}

/** Viewport centre, lean, and scale of the card holding the eye. */
export interface WheelEyeCentre {
  x: number;
  y: number;
  rotate: number;
  scale: number;
}

export interface WheelEyeCallbacks {
  /** The eye card's pose on screen, or null while the rail is hidden. */
  centre(): WheelEyeCentre | null;
  /** The busiest window's point (main-frame centre or a card centre), or null when all are quiet. */
  activity(): WheelEyePoint | null;
  /** The focused window's own activity; speeds up the text flow. */
  ownActivity(): number;
  /** False under reduced motion or animation style `none`: the eye is drawn still. */
  motionEnabled(): boolean;
}

export interface WheelEyeStyle {
  fontFamily: string;
  accentRgb: string;
  fgRgb: string;
  dangerRgb: string;
}

export function wheelEyeShape(nx: number, ny: number): boolean {
  return Math.abs(nx) < 1 && Math.abs(ny) <= Math.pow(Math.max(0, 1 - nx * nx), 0.85);
}

export function wheelEyePupil(s: WheelEyeState): { col: number; row: number; hw: number; hh: number } {
  return {
    col: Math.round(s.cols / 2 - 0.5 + s.px),
    row: Math.round(s.rows / 2 - 0.5 + s.py),
    hw: Math.max(2, Math.round(s.cols * 0.045 * s.dil)),
    hh: Math.max(1, Math.round(s.rows * 0.07 * s.dil)),
  };
}

/** One array of same-class runs per grid row. Cells outside the almond or
 *  under a lid are blank and end a run. */
export function wheelEyeRows(s: WheelEyeState, text: string): WheelEyeRun[][] {
  const { col: pc, row: pr, hw, hh } = wheelEyePupil(s);
  const irx = hw * 2.6;
  const iry = hh * 2.8 + 1;
  const source = text || ' ';
  const out: WheelEyeRun[][] = [];
  for (let r = 0; r < s.rows; r++) {
    const ny = (r + 0.5 - s.rows / 2) / (s.rows / 2);
    const runs: WheelEyeRun[] = [];
    let run: WheelEyeRun | null = null;
    for (let c = 0; c < s.cols; c++) {
      const nx = (c + 0.5 - s.cols / 2) / (s.cols / 2);
      if (!wheelEyeShape(nx, ny) || Math.abs(ny) > (1 - s.lid) * 1.02) {
        run = null;
        continue;
      }
      const dx = c - pc;
      const dy = r - pr;
      const cls: WheelEyeClass = Math.abs(dx) <= hw && Math.abs(dy) <= hh
        ? 'p'
        : (dx / irx) ** 2 + (dy / iry) ** 2 < 1 ? 'i' : 'o';
      const ch = source[(s.offset + r * s.cols + c) % source.length];
      if (run && run.cls === cls) {
        run.text += ch;
      } else {
        run = { cls, col: c, text: ch };
        runs.push(run);
      }
    }
    out.push(runs);
  }
  return out;
}

/** Changes only when the drawn grid would: pupil cell and size, lid step, text offset, alert. */
export function wheelEyeKey(s: WheelEyeState, textLength: number): string {
  const p = wheelEyePupil(s);
  const offset = textLength > 0 ? s.offset % textLength : 0;
  return `${s.cols},${s.rows},${p.col},${p.row},${p.hw},${p.hh},${Math.round(s.lid * 10)},${offset},${s.alert ? 1 : 0}`;
}

/** Card-local target offset (px) → pupil offset (cells), plus 0–1 nearness for dilation. */
export function wheelEyeGaze(dx: number, dy: number, cols: number, rows: number): { x: number; y: number; near: number } {
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.tanh(d / WHEEL_EYE_REACH);
  return {
    x: (dx / d) * k * cols * 0.3,
    y: (dy / d) * k * rows * 0.27,
    near: 1 - Math.min(1, d / (2 * WHEEL_EYE_REACH)),
  };
}

/** Grid for a card: about 0.88 of the card width in columns, an odd row count
 *  near the study's almond aspect, capped at 0.7 of the card height. */
export function wheelEyeGrid(cellWidth: number, cardHeight: number): { cols: number; rows: number } {
  const cw = cellWidth > 0 ? cellWidth : WHEEL_EYE_FONT_PX * 0.6;
  const cols = Math.max(9, Math.floor((0.88 * WHEEL_CARD_WIDTH) / cw));
  const cap = Math.floor((0.7 * cardHeight) / WHEEL_EYE_LINE_PX);
  let rows = 2 * Math.round(((cols * cw * 0.42) / WHEEL_EYE_LINE_PX - 1) / 2) + 1;
  if (rows > cap) rows = cap % 2 === 1 ? cap : cap - 1;
  return { cols, rows: Math.max(5, rows) };
}

/** Lid closure `ms` after a blink began: 160 ms closing, 160 ms opening, else open. */
export function wheelEyeLid(ms: number): number {
  const t = ms / WHEEL_EYE_BLINK_MS;
  if (!(t >= 0 && t < 2)) return 0;
  return t < 1 ? t : 2 - t;
}

/** The text the eye is made of: the label plus the tab title, whitespace collapsed. */
export function wheelEyeText(label: string, title: string): string {
  const a = label.replace(/\s+/g, ' ').trim();
  const b = title.replace(/\s+/g, ' ').trim();
  const text = !b || b === a ? a : a ? `${a} ${b}` : b;
  return (text || 'krypton').slice(0, WHEEL_EYE_TEXT_MAX);
}

/** Which window the eye watches once the pointer is idle: the busiest one at
 *  or above WHEEL_EYE_WAKE, the focused window winning ties; null when all are quiet. */
export function wheelEyeWatch(levels: readonly number[], active: number): { index: number; level: number } | null {
  let index = -1;
  let level = 0;
  for (let i = 0; i < levels.length; i++) {
    if (i !== active && levels[i] > level) {
      level = levels[i];
      index = i;
    }
  }
  const own = levels[active] ?? 0;
  if (own >= level) {
    index = active;
    level = own;
  }
  return index >= 0 && level >= WHEEL_EYE_WAKE ? { index, level } : null;
}

const ease = (perFrame: number, dt: number): number => 1 - Math.pow(1 - perFrame, dt / FRAME_MS);
const blinkGap = (): number => 2600 + Math.random() * 4500;

export class WheelEye {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly callbacks: WheelEyeCallbacks;
  private readonly state: WheelEyeState = {
    cols: 45, rows: 11, px: 0, py: 0, dil: 1, lid: 0, offset: 0, alert: false,
  };
  private host: HTMLElement | null = null;
  private text = 'krypton ';
  private tabCount = 1;
  private cardHeight = WHEEL_CARD_HEIGHT;
  private cellWidth = WHEEL_EYE_FONT_PX * 0.6;
  private dpr = 1;
  private fontFamily = 'monospace';
  private ink = { o: '', i: '', p: '', box: '', alert: '' };
  private readonly pointer = { x: 0, y: 0, has: false, at: -Infinity };
  private blinkAt = -Infinity;
  private nextBlinkAt = 0;
  private flow = 0;
  private last = 0;
  private lastKey = '';
  private wasInside = false;
  private running = false;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = Infinity;
  private disposed = false;

  constructor(callbacks: WheelEyeCallbacks) {
    this.callbacks = callbacks;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-wheel__eye';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d');
    this.setStyle({ fontFamily: 'monospace', accentRgb: '0, 204, 255', fgRgb: '176, 196, 216', dangerRgb: '255, 85, 85' });
    // The chrome font may still be loading; re-measure the cell width once it lands.
    void document.fonts?.ready.then(() => {
      if (!this.disposed) this.measure();
    });
  }

  /** Put the eye on `card`, the focused window's. Moving to a new card opens
   *  the eye from closed; the same card only refreshes its text and tab dots,
   *  and re-attaches the canvas if the card's children were rebuilt. */
  mount(card: HTMLElement, text: string, tabCount: number): void {
    if (this.disposed) return;
    if (this.host !== card) {
      this.host?.classList.remove('krypton-wheel__card--eye');
      this.host = card;
      card.classList.add('krypton-wheel__card--eye');
      this.blinkAt = performance.now() - WHEEL_EYE_BLINK_MS;
      this.state.offset = 0;
      this.flow = 0;
      this.lastKey = '';
    }
    if (this.canvas.parentNode !== card) card.appendChild(this.canvas);
    const next = `${text} `;
    if (next !== this.text) {
      this.text = next;
      this.state.offset %= next.length;
      this.lastKey = '';
    }
    if (tabCount !== this.tabCount) {
      this.tabCount = tabCount;
      this.lastKey = '';
    }
    this.schedule(0);
  }

  isOn(card: HTMLElement): boolean {
    return this.host === card;
  }

  /** Run while the rail is shown; stopping clears the clock and the pointer listeners. */
  setRunning(on: boolean): void {
    if (this.disposed || on === this.running) return;
    this.running = on;
    const root = document.documentElement;
    if (on) {
      window.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: true });
      root.addEventListener('mouseleave', this.onPointerLeave);
      this.last = performance.now();
      this.nextBlinkAt = this.last + blinkGap();
      this.lastKey = '';
      this.schedule(0);
    } else {
      window.removeEventListener('pointermove', this.onPointerMove, { capture: true });
      root.removeEventListener('mouseleave', this.onPointerLeave);
      this.pointer.has = false;
      this.cancel();
    }
  }

  /** Card height or display DPR changed: resize the backing store and the grid. */
  resize(cardHeight: number): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (cardHeight === this.cardHeight && dpr === this.dpr) return;
    this.cardHeight = cardHeight;
    this.dpr = dpr;
    this.measure();
  }

  setStyle(style: WheelEyeStyle): void {
    const { accentRgb: a, fgRgb: f, dangerRgb: d } = style;
    this.ink = { o: `rgba(${a}, 0.45)`, i: `rgba(${f}, 0.85)`, p: `rgb(${a})`, box: `rgba(${a}, 0.9)`, alert: `rgb(${d})` };
    this.fontFamily = style.fontFamily || 'monospace';
    this.measure();
  }

  /** New output: pull the next tick in to the awake rate. */
  wake(): void {
    this.schedule(AWAKE_MS);
  }

  blink(): void {
    if (this.callbacks.motionEnabled()) this.blinkAt = performance.now();
    this.schedule(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.setRunning(false);
    this.host?.classList.remove('krypton-wheel__card--eye');
    this.host = null;
    this.canvas.remove();
    this.disposed = true;
  }

  private measure(): void {
    const k = WHEEL_ACTIVE_SCALE * this.dpr;
    this.canvas.width = Math.round(WHEEL_CARD_WIDTH * k);
    this.canvas.height = Math.round(this.cardHeight * k);
    const ctx = this.ctx;
    if (ctx) {
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.font = this.font(false);
      this.cellWidth = ctx.measureText('M'.repeat(20)).width / 20;
    }
    const grid = wheelEyeGrid(this.cellWidth, this.cardHeight);
    this.state.cols = grid.cols;
    this.state.rows = grid.rows;
    this.lastKey = '';
    this.schedule(0);
  }

  private font(bold: boolean): string {
    return `${bold ? 700 : 400} ${WHEEL_EYE_FONT_PX}px ${this.fontFamily}`;
  }

  // ─── Clock ───────────────────────────────────────────────────────

  /** Run the next tick in `ms` (0 = next animation frame), unless one is already due sooner. */
  private schedule(ms: number): void {
    if (this.disposed || !this.running || this.raf) return;
    const due = performance.now() + ms;
    if (due >= this.due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.due = due;
    if (ms <= 0) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.raf = requestAnimationFrame(this.tick);
      }, ms);
    }
  }

  private cancel(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    this.raf = 0;
    this.timer = null;
    this.due = Infinity;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const p = this.pointer;
    p.x = event.clientX;
    p.y = event.clientY;
    p.has = true;
    p.at = performance.now();
    this.schedule(0);
  };

  private readonly onPointerLeave = (): void => {
    this.pointer.has = false;
    this.schedule(AWAKE_MS);
  };

  private readonly tick = (): void => {
    this.raf = 0;
    this.due = Infinity;
    if (this.disposed || !this.running || !this.host) return;
    const now = performance.now();
    const dt = Math.min(250, Math.max(0, now - this.last));
    this.last = now;
    const s = this.state;

    if (!this.callbacks.motionEnabled()) {
      // Still eye: open, centred, no flinch or text flow; redrawn only on change.
      s.px = 0;
      s.py = 0;
      s.dil = 1;
      s.lid = 0;
      s.alert = false;
      this.draw();
      return;
    }
    if (document.hidden) {
      this.schedule(QUIET_MS);
      return;
    }
    const centre = this.callbacks.centre();
    if (!centre) return;
    const cos = Math.cos(-centre.rotate);
    const sin = Math.sin(-centre.rotate);
    const local = (x: number, y: number): [number, number] => {
      const dx = x - centre.x;
      const dy = y - centre.y;
      return [dx * cos - dy * sin, dx * sin + dy * cos];
    };

    // 1 pointer → 2 activity → 3 drift.
    const p = this.pointer;
    let target: { x: number; y: number } | null = null;
    let level = 0;
    let pointerLed = false;
    if (p.has && now - p.at < WHEEL_EYE_POINTER_IDLE_MS) {
      target = p;
      pointerLed = true;
    } else {
      const point = this.callbacks.activity();
      if (point) {
        target = point;
        level = point.level;
      }
    }
    let tx: number;
    let ty: number;
    if (target) {
      const [lx, ly] = local(target.x, target.y);
      const gaze = wheelEyeGaze(lx, ly, s.cols, s.rows);
      tx = gaze.x;
      ty = gaze.y;
      if (pointerLed) level = gaze.near;
    } else {
      tx = Math.sin(now / 1700) * s.cols * 0.08;
      ty = Math.cos(now / 2300) * s.rows * 0.06;
    }
    const eg = ease(GAZE_EASE, dt);
    s.px += (tx - s.px) * eg;
    s.py += (ty - s.py) * eg;
    const dilation = 1 + 0.9 * level * level;
    s.dil += (dilation - s.dil) * ease(DILATE_EASE, dt);

    // Flinch: a blink and the alert colour while the pointer is inside the almond.
    let inside = false;
    if (p.has) {
      const [lx, ly] = local(p.x, p.y);
      const halfW = ((s.cols * this.cellWidth) / 2) * centre.scale;
      const halfH = ((s.rows * WHEEL_EYE_LINE_PX) / 2) * centre.scale;
      inside = wheelEyeShape(lx / halfW, ly / halfH);
    }
    if (inside && !this.wasInside) this.blinkAt = now;
    this.wasInside = inside;
    s.alert = inside;

    if (now >= this.nextBlinkAt) {
      this.blinkAt = now;
      this.nextBlinkAt = now + blinkGap();
    }
    s.lid = wheelEyeLid(now - this.blinkAt);
    const blinking = now - this.blinkAt < WHEEL_EYE_BLINK_MS * 2;

    // One character per 420 ms when quiet, per 80 ms at full own output.
    this.flow += dt / (QUIET_MS - (QUIET_MS - AWAKE_MS) * Math.min(1, this.callbacks.ownActivity()));
    const steps = Math.floor(this.flow);
    this.flow -= steps;
    s.offset = (s.offset + steps) % this.text.length;

    this.draw();

    const fresh = p.has && now - p.at < POINTER_FRESH_MS;
    const easing = Math.hypot(tx - s.px, ty - s.py) > 0.5 || Math.abs(dilation - s.dil) > 0.02;
    if (fresh || blinking) this.schedule(0);
    else if (target || easing) this.schedule(AWAKE_MS);
    else this.schedule(QUIET_MS);
  };

  // ─── Draw ────────────────────────────────────────────────────────

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.state;
    const key = `${wheelEyeKey(s, this.text.length)}|${this.tabCount}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const cw = this.cellWidth;
    const lh = WHEEL_EYE_LINE_PX;
    const w = WHEEL_CARD_WIDTH;
    const h = this.cardHeight;
    const ink = this.ink;
    ctx.clearRect(0, 0, w, h);
    const ox = (w - s.cols * cw) / 2;
    const oy = (h - s.rows * lh) / 2;
    ctx.textBaseline = 'middle';
    let bold: boolean | null = null;
    const rows = wheelEyeRows(s, this.text);
    for (let r = 0; r < rows.length; r++) {
      for (const run of rows[r]) {
        const wantBold = run.cls === 'p';
        if (wantBold !== bold) {
          ctx.font = this.font(wantBold);
          bold = wantBold;
        }
        ctx.fillStyle = s.alert ? ink.alert : ink[run.cls];
        ctx.fillText(run.text, ox + run.col * cw, oy + r * lh + lh / 2);
      }
    }
    // The pupil box: a full 1px frame on screen (the card is scaled up).
    const pupil = wheelEyePupil(s);
    ctx.lineWidth = 1 / WHEEL_ACTIVE_SCALE;
    ctx.strokeStyle = s.alert ? ink.alert : ink.box;
    ctx.strokeRect(
      ox + (pupil.col - pupil.hw) * cw,
      oy + (pupil.row - pupil.hh) * lh,
      (pupil.hw * 2 + 1) * cw,
      (pupil.hh * 2 + 1) * lh,
    );
    if (this.tabCount > 1) {
      ctx.fillStyle = ink.p;
      for (let i = 0; i < Math.min(this.tabCount, 6); i++) {
        ctx.beginPath();
        ctx.arc(w - 8 - i * 5, h - 5, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
