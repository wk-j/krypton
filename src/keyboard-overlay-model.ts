// Krypton — Keyboard overlay model (spec 271)
// Geometry, label tables, touch-typing finger map, hand pose and the canvas
// renderer for the ghost-hands keyboard overlay. Ported from the "Keyboard
// study: ghost hands" artifact, minus the mouse grip. No DOM access: the same
// driver runs inside the overlay worker or on the main thread as a fallback.

export type OverlayLayout = 'us' | 'de' | 'th';
export type OverlayLayoutSetting = OverlayLayout | 'auto';
type Side = 'L' | 'R';

interface Point {
  x: number;
  y: number;
}

interface KeyRow {
  codes: readonly string[];
  xs: (i: number) => number;
}

/** Overlay footprint in key units (COMPACT geometry: no mouse pad). The height
 *  ends just under the lowest hand box: a bottom-row reach drops the wrist to
 *  7.72U, plus the 0.3U box pad = 8.02U, so the overlay docks flush. */
export const KEY_UNITS_WIDE = 15.4;
export const KEY_UNITS_TALL = 8.1;
const MIN_UNIT = 12;

// ─── Physical keys (positions in key units) ─────────────────────

const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => `Digit${d}`);
const letters = (s: string): string[] => s.split('').map((c) => `Key${c.toUpperCase()}`);

export const ROWS: readonly KeyRow[] = [
  { codes: ['Escape', 'Backquote', ...digits, 'Minus', 'Equal', 'Backspace'], xs: (i) => i },
  { codes: [...letters('qwertyuiop'), 'BracketLeft', 'BracketRight', 'Backslash'], xs: (i) => 2.5 + i },
  { codes: [...letters('asdfghjkl'), 'Semicolon', 'Quote', 'Enter'], xs: (i) => 2.8 + i },
  {
    codes: ['ShiftLeft', ...letters('zxcvbnm'), 'Comma', 'Period', 'Slash', 'ShiftRight'],
    xs: (i) => (i === 0 ? 2.1 : i === 11 ? 13.6 : 2.3 + i),
  },
];
const SPACE = { x0: 5.0, x1: 11.5, row: 4 };

export const LAYOUTS: Record<OverlayLayout, readonly (readonly string[])[]> = {
  us: [
    ['esc', '`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', '←'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", '↵'],
    ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', '⇧'],
  ],
  de: [
    ['esc', '^', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'ß', '´', '←'],
    ['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p', 'ü', '+', '#'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö', 'ä', '↵'],
    ['⇧', 'y', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '-', '⇧'],
  ],
  th: [
    ['esc', '_', 'ๅ', '/', '-', 'ภ', 'ถ', '◌ุ', '◌ึ', 'ค', 'ต', 'จ', 'ข', 'ช', '←'],
    ['ๆ', 'ไ', '◌ำ', 'พ', 'ะ', '◌ั', '◌ี', 'ร', 'น', 'ย', 'บ', 'ล', 'ฃ'],
    ['ฟ', 'ห', 'ก', 'ด', 'เ', '◌้', '◌่', 'า', 'ส', 'ว', 'ง', '↵'],
    ['⇧', 'ผ', 'ป', 'แ', 'อ', '◌ิ', '◌ื', 'ท', 'ม', 'ใ', 'ฝ', '⇧'],
  ],
};

function buildLabels(): {
  labels: Record<OverlayLayout, Record<string, string>>;
  charToCode: Record<OverlayLayout, Record<string, string>>;
} {
  const labels = {} as Record<OverlayLayout, Record<string, string>>;
  const charToCode = {} as Record<OverlayLayout, Record<string, string>>;
  for (const layout of Object.keys(LAYOUTS) as OverlayLayout[]) {
    labels[layout] = {};
    charToCode[layout] = { ' ': 'Space' };
    ROWS.forEach((row, ri) => row.codes.forEach((code, i) => {
      // Draw Thai combining marks bare: "◌" + mark splits the cluster across
      // fonts and renders as tofu on a worker canvas, while a lone mark lets the
      // Thai font supply its own dotted circle.
      const ch = LAYOUTS[layout][ri][i].replace('◌', '');
      labels[layout][code] = ch;
      if (ch.length === 1 && !'←↵⇧'.includes(ch)) charToCode[layout][ch] = code;
    }));
  }
  return { labels, charToCode };
}

export const { labels: LABELS, charToCode: CHAR_TO_CODE } = buildLabels();

/** Touch-typing finger map: code → [side, finger] with finger 0 thumb … 4 pinky. */
export const FINGER_MAP: Record<string, readonly [Side, number]> = {};
const assign = (side: Side, finger: number, codes: readonly string[]): void => {
  for (const code of codes) FINGER_MAP[code] = [side, finger];
};
assign('L', 4, ['Escape', 'Backquote', 'Digit1', 'KeyQ', 'KeyA', 'ShiftLeft', 'KeyZ']);
assign('L', 3, ['Digit2', 'KeyW', 'KeyS', 'KeyX']);
assign('L', 2, ['Digit3', 'KeyE', 'KeyD', 'KeyC']);
assign('L', 1, ['Digit4', 'Digit5', 'KeyR', 'KeyT', 'KeyF', 'KeyG', 'KeyV', 'KeyB']);
assign('R', 1, ['Digit6', 'Digit7', 'KeyY', 'KeyU', 'KeyH', 'KeyJ', 'KeyN', 'KeyM']);
assign('R', 2, ['Digit8', 'KeyI', 'KeyK', 'Comma']);
assign('R', 3, ['Digit9', 'KeyO', 'KeyL', 'Period']);
assign('R', 4, [
  'Digit0', 'Minus', 'Equal', 'Backspace', 'KeyP', 'BracketLeft', 'BracketRight',
  'Backslash', 'Semicolon', 'Quote', 'Enter', 'Slash', 'ShiftRight',
]);
const HOME: Record<Side, readonly (string | null)[]> = {
  L: [null, 'KeyF', 'KeyD', 'KeyS', 'KeyA'],
  R: [null, 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
};
const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** Every physical key the overlay draws (letters/digits/punctuation, Shift, Enter, Space…). */
const DRAWN_CODES: ReadonlySet<string> = new Set([...ROWS.flatMap((r) => r.codes), 'Space']);

// ─── Pure helpers ───────────────────────────────────────────────

/** Map a keydown to a drawn physical key: `e.code` first, then the label table. */
export function resolveCode(code: string, key: string, layout: OverlayLayout): string | null {
  if (code && DRAWN_CODES.has(code)) return code;
  if (key === ' ') return 'Space';
  return CHAR_TO_CODE[layout][key.toLowerCase()] ?? null;
}

/** `auto` layout: a Thai character switches labels to Kedmanee, an ASCII letter back to QWERTY. */
export function detectLayout(key: string, current: OverlayLayout): OverlayLayout {
  if (/^[฀-๿]$/.test(key)) return 'th';
  if (/^[a-zA-Z]$/.test(key)) return 'us';
  return current;
}

/** Resolve the configured label set to the one to draw now. */
export function initialLayout(setting: string): OverlayLayout {
  return setting === 'us' || setting === 'de' || setting === 'th' ? setting : 'us';
}

/** CSS size of the overlay for a workspace width and `width_ratio`. */
export function overlaySize(workspaceWidth: number, widthRatio: number): { width: number; height: number } {
  const ratio = clamp(Number.isFinite(widthRatio) ? widthRatio : 0.36, 0.2, 0.8);
  const unit = Math.max(MIN_UNIT, (workspaceWidth * ratio) / KEY_UNITS_WIDE);
  return { width: Math.round(unit * KEY_UNITS_WIDE), height: Math.round(unit * KEY_UNITS_TALL) };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ─── Renderer ───────────────────────────────────────────────────

export interface OverlayStyle {
  ink: string;
  accent: string;
  font: string;
  reducedMotion: boolean;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Finger {
  key: string | null;
  hold: number;
  ret: number;
  tip: Point;
}

interface Hand {
  side: Side;
  inner: number;
  fingers: Finger[];
  off: Point;
  act: number;
  u: number;
  snap: boolean;
  pts: Point[];
}

const GHOST_IDLE_MS = 5000;
const PHRASES: Record<'latin' | 'th', readonly string[]> = {
  latin: ['kubectl get pods', 'git push origin main', 'docker compose up'],
  th: ['สวัสดี', 'ทดสอบ', 'แป้นพิมพ์'],
};

function makeHand(side: Side): Hand {
  return {
    side,
    inner: side === 'L' ? 1 : -1,
    fingers: [0, 1, 2, 3, 4].map(() => ({ key: null, hold: 0, ret: 0, tip: { x: 0, y: 0 } })),
    off: { x: 0, y: 0 },
    act: 0,
    u: 0.46,
    snap: true,
    pts: [],
  };
}

/**
 * Draws the label-only keyboard and two 21-point wireframe hands (MediaPipe
 * landmark order). `frame()` returns false once every glow has faded and the
 * hands have settled, so the driver can stop its rAF loop (0 frames at idle).
 */
export class KeyboardOverlayRenderer {
  private U = MIN_UNIT;
  private W = 0;
  private H = 0;
  private OX = 0;
  private OY = 0;
  private pos: Record<string, Point> = {};
  private readonly glow: Record<string, number> = {};
  private readonly left = makeHand('L');
  private readonly right = makeHand('R');
  private readonly hands = [this.left, this.right];
  private style: OverlayStyle = { ink: '#b0c4d8', accent: '#0cf', font: 'monospace', reducedMotion: false };
  private layout: OverlayLayout = 'us';
  private ghostEnabled = false;
  private ghostOn = false;
  private ghostQueue: string[] = [];
  private ghostNext = 0;
  private ghostIndex = 0;
  private lastUserAt = 0;
  private lastFrameAt = 0;

  resize(width: number, height: number): void {
    this.W = width;
    this.H = height;
    this.U = Math.max(MIN_UNIT, width / KEY_UNITS_WIDE);
    const U = this.U;
    this.OX = U * 0.1;
    this.OY = U * 0.5;
    this.pos = {};
    ROWS.forEach((row, ri) => row.codes.forEach((code, i) => {
      this.pos[code] = { x: this.OX + (row.xs(i) + 0.5) * U, y: this.OY + (ri + 0.5) * U };
    }));
    const sy = this.OY + (SPACE.row + 0.5) * U;
    this.pos.Space = { x: this.OX + ((SPACE.x0 + SPACE.x1) / 2) * U, y: sy };
    this.pos.SpaceL = { x: this.OX + 6.4 * U, y: sy };
    this.pos.SpaceR = { x: this.OX + 9.4 * U, y: sy };
    this.snap();
  }

  setStyle(style: OverlayStyle): void {
    this.style = style;
  }

  setLayout(layout: OverlayLayout): void {
    this.layout = layout;
  }

  setGhost(enabled: boolean, now: number): void {
    this.ghostEnabled = enabled;
    this.lastUserAt = now;
    this.resetGhost();
  }

  /** Jump hands to their resting pose on the next frame (after resize/show). */
  snap(): void {
    for (const h of this.hands) h.snap = true;
  }

  /** A real keystroke: reach, glow, and push the idle ghost back. */
  press(code: string, shift: boolean, now: number): void {
    this.lastUserAt = now;
    this.resetGhost();
    this.pressKey(code, shift, now);
  }

  /** Milliseconds until the idle ghost is due, or null when it is off / already playing. */
  msUntilGhost(now: number): number | null {
    if (!this.ghostEnabled || this.ghostOn) return null;
    return Math.max(0, this.lastUserAt + GHOST_IDLE_MS - now);
  }

  /** Draw one frame; true when another frame is needed. */
  frame(ctx: Ctx2D, now: number): boolean {
    const dt = this.lastFrameAt ? Math.min(0.05, (now - this.lastFrameAt) / 1000) : 1 / 60;
    this.lastFrameAt = now;
    if (!this.W || !this.pos.KeyF) return false;
    this.tickGhost(now);
    const moved = this.updateHands(now);
    const glowing = this.draw(ctx, now, dt);
    const reaching = this.hands.some((h) => h.fingers.some((f) => f.key !== null && now < f.ret));
    const busy = glowing || reaching || moved >= 0.1 || this.ghostOn;
    if (!busy) this.lastFrameAt = 0;
    return busy;
  }

  private resetGhost(): void {
    this.ghostOn = false;
    this.ghostQueue = [];
  }

  private pressKey(code: string, shift: boolean, now: number): void {
    if (!this.pos[code]) return;
    let side: Side;
    let fi: number;
    if (code === 'Space') {
      side = 'R';
      fi = 0;
    } else {
      [side, fi] = FINGER_MAP[code] ?? ['R', 1];
    }
    if (shift) this.pressKey(side === 'L' ? 'ShiftRight' : 'ShiftLeft', false, now);
    const hand = side === 'L' ? this.left : this.right;
    const finger = hand.fingers[fi];
    finger.key = code;
    finger.hold = now + 140;
    finger.ret = now + 450;
    hand.act = 1;
    this.glow[code] = 1;
  }

  private phrase(): string[] {
    const list = PHRASES[this.layout === 'th' ? 'th' : 'latin'];
    return [...list[this.ghostIndex % list.length]];
  }

  /** Idle ghost: hands-only phrases, never typed into any terminal. */
  private tickGhost(now: number): void {
    if (!this.ghostEnabled || now - this.lastUserAt < GHOST_IDLE_MS) {
      if (this.ghostOn) this.resetGhost();
      return;
    }
    if (!this.ghostOn) {
      this.ghostOn = true;
      this.ghostQueue = this.phrase();
      this.ghostNext = now + 500;
    }
    if (now < this.ghostNext) return;
    if (!this.ghostQueue.length) {
      this.pressKey('Enter', false, now);
      this.ghostIndex++;
      this.ghostQueue = this.phrase();
      this.ghostNext = now + 1500;
      return;
    }
    const ch = this.ghostQueue.shift() ?? ' ';
    const lower = ch.toLowerCase();
    const code = CHAR_TO_CODE[this.layout][lower] ?? CHAR_TO_CODE.us[lower];
    if (code) this.pressKey(code, ch !== lower, now);
    this.ghostNext = now + 70 + Math.random() * 130 + (ch === ' ' ? 120 : 0);
  }

  private keyboardPose(h: Hand, now: number): Point[] {
    const P = this.pos;
    const U = this.U;
    const home = HOME[h.side];
    const rm = this.style.reducedMotion;
    const homeY = P.KeyF.y;
    const hx = (P[home[1] as string].x + P[home[4] as string].x) / 2;
    // The palm follows the reaching finger a little.
    let offT: Point = { x: 0, y: 0 };
    for (let f = 1; f <= 4; f++) {
      const F = h.fingers[f];
      if (F.key && now < F.ret) {
        const k = P[F.key];
        const hm = P[home[f] as string];
        offT = { x: (k.x - hm.x) * 0.42, y: (k.y - hm.y) * 0.42 };
      }
    }
    const e = h.snap || rm ? 1 : 0.16;
    h.off.x += (offT.x - h.off.x) * e;
    h.off.y += (offT.y - h.off.y) * e;
    const o = h.off;
    const wrist = { x: hx + o.x - h.inner * 0.2 * U, y: homeY + 4.3 * U + o.y };
    const pts: Point[] = new Array(21);
    pts[0] = wrist;
    const mcpDy = [0, 2.1, 2.0, 2.1, 2.45];
    for (let f = 1; f <= 4; f++) {
      const F = h.fingers[f];
      const hm = P[home[f] as string];
      let t = F.key && now < F.ret ? P[F.key] : hm;
      if (F.key && now < F.hold) t = { x: t.x, y: t.y + 0.06 * U };
      const te = h.snap || rm ? 1 : 0.38;
      F.tip.x += (t.x - F.tip.x) * te;
      F.tip.y += (t.y - F.tip.y) * te;
      const M = { x: hx + (hm.x - hx) * 0.8 + o.x, y: homeY + mcpDy[f] * U + o.y };
      const T = F.tip;
      const dx = T.x - M.x;
      const dy = T.y - M.y;
      const len = Math.hypot(dx, dy) || 1;
      const sgn = f >= 3 ? -h.inner : h.inner;
      const curl = Math.max(0, mcpDy[f] * U - len) * 0.4 + 0.07 * U;
      const px = (-dy / len) * curl * sgn;
      const py = (dx / len) * curl * sgn;
      const b = 1 + f * 4;
      pts[b] = M;
      pts[b + 1] = { x: M.x + dx * 0.42 + px, y: M.y + dy * 0.42 + py };
      pts[b + 2] = { x: M.x + dx * 0.74 + px * 0.6, y: M.y + dy * 0.74 + py * 0.6 };
      pts[b + 3] = { x: T.x, y: T.y };
    }
    // Thumb rests on the spacebar.
    const Th = h.fingers[0];
    const rest = P[h.side === 'L' ? 'SpaceL' : 'SpaceR'];
    let tt = Th.key && now < Th.hold ? { x: rest.x, y: rest.y + 0.12 * U } : rest;
    tt = { x: tt.x + o.x * 0.5, y: tt.y + o.y * 0.3 };
    const te = h.snap || rm ? 1 : 0.4;
    Th.tip.x += (tt.x - Th.tip.x) * te;
    Th.tip.y += (tt.y - Th.tip.y) * te;
    const cmc = { x: wrist.x + h.inner * 1.0 * U, y: wrist.y - 0.6 * U };
    const T = Th.tip;
    const dx = T.x - cmc.x;
    const dy = T.y - cmc.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (dy / len) * h.inner;
    const ny = (-dx / len) * h.inner;
    pts[1] = cmc;
    pts[2] = { x: cmc.x + dx * 0.38 + nx * 0.35 * U, y: cmc.y + dy * 0.38 + ny * 0.35 * U };
    pts[3] = { x: cmc.x + dx * 0.7 + nx * 0.2 * U, y: cmc.y + dy * 0.7 + ny * 0.2 * U };
    pts[4] = { x: T.x, y: T.y };
    return pts;
  }

  /** Advance both hands; returns the largest point movement this frame (px). */
  private updateHands(now: number): number {
    let moved = 0;
    for (const h of this.hands) {
      const next = this.keyboardPose(h, now);
      if (h.pts.length && !h.snap) {
        for (let i = 0; i < next.length; i++) {
          moved = Math.max(moved, Math.abs(next[i].x - h.pts[i].x) + Math.abs(next[i].y - h.pts[i].y));
        }
      } else {
        moved = Infinity;
      }
      h.pts = next;
      h.act *= 0.96;
      const reach = Math.tanh(Math.hypot(h.off.x, h.off.y) / this.U);
      h.u += (0.46 + 0.05 * reach + 0.08 * h.act - h.u) * 0.2;
      h.snap = false;
    }
    return moved;
  }

  /** Draw keys + hands; returns true while any key is still glowing. */
  private draw(x: Ctx2D, now: number, dt: number): boolean {
    const { ink, accent, font } = this.style;
    const U = this.U;
    const P = this.pos;
    x.clearRect(0, 0, this.W, this.H);
    let glowing = false;

    // Keys: labels only, lit by glow.
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    const labels = LABELS[this.layout];
    for (const code in labels) {
      const p = P[code];
      const g = this.glow[code] ?? 0;
      const label = labels[code];
      x.font = `${(label.length > 2 ? 0.32 : 0.44) * U}px ${font}`;
      x.globalAlpha = 0.28 + 0.72 * g;
      x.fillStyle = ink;
      x.fillText(label, p.x, p.y);
      if (g > 0.25) {
        x.globalAlpha = g;
        x.strokeStyle = accent;
        x.lineWidth = 1;
        x.strokeRect(
          Math.round(p.x - 0.42 * U) + 0.5, Math.round(p.y - 0.42 * U) + 0.5,
          Math.round(0.84 * U), Math.round(0.84 * U),
        );
      }
      if (g > 0) glowing = true;
      this.glow[code] = Math.max(0, g - dt * 2.6);
    }

    // Spacebar as a single rule.
    const sg = this.glow.Space ?? 0;
    if (sg > 0) glowing = true;
    this.glow.Space = Math.max(0, sg - dt * 2.6);
    x.globalAlpha = 0.25 + 0.75 * sg;
    x.strokeStyle = sg > 0.25 ? accent : ink;
    x.lineWidth = 1 + sg * 1.5;
    x.beginPath();
    x.moveTo(this.OX + SPACE.x0 * U, P.Space.y);
    x.lineTo(this.OX + SPACE.x1 * U, P.Space.y);
    x.stroke();

    // Hands: bones, joints, pressed tips, full bounding box + debug label.
    x.font = `${Math.max(9, U * 0.26)}px ${font}`;
    x.textAlign = 'left';
    x.textBaseline = 'alphabetic';
    this.hands.forEach((h, hi) => {
      const pts = h.pts;
      if (!pts.length) return;
      x.globalAlpha = 0.55;
      x.strokeStyle = ink;
      x.lineWidth = 1;
      x.beginPath();
      for (const [a, b] of BONES) {
        x.moveTo(pts[a].x, pts[a].y);
        x.lineTo(pts[b].x, pts[b].y);
      }
      x.stroke();
      x.globalAlpha = 1;
      x.fillStyle = ink;
      pts.forEach((p, i) => {
        const s = i === 0 ? 3 : 2.4;
        x.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      });
      x.fillStyle = accent;
      h.fingers.forEach((F, f) => {
        if (F.key && now < F.hold) {
          const p = pts[f * 4 + 4];
          x.fillRect(p.x - 4, p.y - 4, 8, 8);
        }
      });
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      const pad = 0.3 * U;
      x.globalAlpha = 0.32;
      x.strokeStyle = ink;
      x.strokeRect(
        Math.round(x0 - pad) + 0.5, Math.round(y0 - pad) + 0.5,
        Math.round(x1 - x0 + pad * 2), Math.round(y1 - y0 + pad * 2),
      );
      x.globalAlpha = 0.8;
      x.fillStyle = ink;
      const tag = U < 30 ? `hand${hi} ${h.u.toFixed(4)}` : `['hand${hi}:u'] ${h.u.toFixed(7)}`;
      x.fillText(tag, x0 - pad, y0 - pad - 5);
    });
    x.globalAlpha = 1;
    return glowing;
  }
}

// ─── Driver (shared by the worker and the main-thread fallback) ─

type OverlayCanvas = OffscreenCanvas | HTMLCanvasElement;

export type OverlayMessage =
  | { type: 'init'; canvas: OverlayCanvas }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'style'; style: OverlayStyle }
  | { type: 'config'; layout: OverlayLayout; ghost: boolean }
  | { type: 'key'; code: string; shift: boolean }
  | { type: 'visible'; visible: boolean }
  | { type: 'dispose' };

/** Owns the canvas, the renderer and the rAF loop; stops the loop when the hands settle. */
export class KeyboardOverlayDriver {
  private readonly renderer = new KeyboardOverlayRenderer();
  private canvas: OverlayCanvas | null = null;
  private ctx: Ctx2D | null = null;
  private width = 0;
  private height = 0;
  private visible = false;
  private rafId = 0;
  private ghostTimer: ReturnType<typeof setTimeout> | null = null;

  handle(msg: OverlayMessage): void {
    switch (msg.type) {
      case 'init':
        this.canvas = msg.canvas;
        this.ctx = msg.canvas.getContext('2d') as Ctx2D | null;
        break;
      case 'resize':
        this.width = msg.width;
        this.height = msg.height;
        if (this.canvas && this.ctx) {
          this.canvas.width = Math.round(msg.width * msg.dpr);
          this.canvas.height = Math.round(msg.height * msg.dpr);
          this.ctx.setTransform(msg.dpr, 0, 0, msg.dpr, 0, 0);
        }
        this.renderer.resize(msg.width, msg.height);
        this.wake();
        break;
      case 'style':
        this.renderer.setStyle(msg.style);
        this.renderer.snap();
        this.wake();
        break;
      case 'config':
        this.renderer.setLayout(msg.layout);
        this.renderer.setGhost(msg.ghost, performance.now());
        this.wake();
        break;
      case 'key':
        if (!this.visible) break;
        this.renderer.press(msg.code, msg.shift, performance.now());
        this.wake();
        break;
      case 'visible':
        this.visible = msg.visible;
        if (msg.visible) {
          this.renderer.snap();
          this.wake();
        } else {
          this.stop();
          this.ctx?.clearRect(0, 0, this.width, this.height);
        }
        break;
      case 'dispose':
        this.stop();
        this.canvas = null;
        this.ctx = null;
        break;
    }
  }

  private wake(): void {
    if (!this.visible || !this.ctx || this.rafId) return;
    this.clearGhostTimer();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.rafId = 0;
    if (!this.visible || !this.ctx) return;
    if (this.renderer.frame(this.ctx, now)) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    const ms = this.renderer.msUntilGhost(performance.now());
    if (ms !== null) this.ghostTimer = setTimeout(() => this.wake(), ms + 20);
  };

  private stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.clearGhostTimer();
  }

  private clearGhostTimer(): void {
    if (this.ghostTimer !== null) clearTimeout(this.ghostTimer);
    this.ghostTimer = null;
  }
}
