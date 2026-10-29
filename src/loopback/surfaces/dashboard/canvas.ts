// Specs 168/169 — the lane monitor's canvases: the attention gauge, the
// synthetic activity beat and the CPU sparkline. Colours come from the token
// sheet (`getComputedStyle`), never from literals, so the canvases follow the
// same palette as the pills next to them.

import { el } from '../../../ui/dom';
import type { Tone } from '../../kit';

type Palette = Readonly<Record<Tone | 'border', string>>;

let cachedPalette: Palette | null = null;

/** The token colours, read once the sheet has applied (`--add` resolves). */
export function palette(): Palette {
  if (cachedPalette) return cachedPalette;
  const css = getComputedStyle(document.documentElement);
  const read = (name: string): string => css.getPropertyValue(name).trim();
  const next: Palette = {
    accent: read('--accent') || 'gold',
    add: read('--add') || 'green',
    del: read('--del') || 'red',
    muted: read('--muted') || 'gray',
    border: read('--border') || 'gray',
  };
  if (read('--add')) cachedPalette = next;
  return next;
}

/** `color` at `alpha` for gradient stops; hex and `rgb()` tokens are supported. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const raw = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const n = Number.parseInt(raw, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^,]+),([^,]+),([^,)]+)/i.exec(color);
  if (rgb) return `rgba(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()}, ${alpha})`;
  return color;
}

/** Spec 169 CPU heat: green < 50, yellow < 90, red ≥ 90 (a process-tree sum can exceed 100). */
export function heatTone(cpu: number): Tone {
  return cpu >= 90 ? 'del' : cpu >= 50 ? 'accent' : 'add';
}

/** Gauge colour: none open → green, one or two → yellow, more → red. */
export function gaugeTone(openCount: number): Tone {
  return openCount === 0 ? 'add' : openCount <= 2 ? 'accent' : 'del';
}

interface Surface2D {
  readonly ctx: CanvasRenderingContext2D;
  readonly w: number;
  readonly h: number;
}

/** A full-width canvas of fixed CSS height, refitted to its width and DPR on demand. */
export class FittedCanvas {
  readonly el: HTMLCanvasElement;
  private current: Surface2D | null = null;
  private dpr = 0;

  constructor(
    className: string,
    private readonly height: number,
  ) {
    this.el = el('canvas', { class: className, style: { height: `${height}px` } });
  }

  /** The drawing surface at the current size; null without a 2D context. */
  surface(): Surface2D | null {
    const w = this.el.clientWidth || this.el.parentElement?.clientWidth || 320;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (this.current && this.current.w === w && this.dpr === dpr) return this.current;
    const ctx = this.el.getContext('2d');
    if (!ctx) return null;
    this.el.width = Math.round(w * dpr);
    this.el.height = Math.round(this.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;
    this.current = { ctx, w, h: this.height };
    return this.current;
  }
}

function baseline(s: Surface2D, color: string): void {
  const { ctx, w, h } = s;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Half-ring gauge of open attention flags, full at 8. */
export function drawGauge(canvas: FittedCanvas, openCount: number): void {
  const s = canvas.surface();
  if (!s) return;
  const { ctx, w, h } = s;
  const p = palette();
  const cx = w / 2;
  const cy = h - 12;
  const r = Math.max(1, Math.min(w / 2 - 16, h - 24));
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.strokeStyle = p.border;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = p[gaugeTone(openCount)];
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * Math.min(1, openCount / 8));
  ctx.stroke();
}

export interface BeatState {
  status: string;
  /** Status tone (DESIGN status table). */
  tone: Tone;
  active: boolean;
  turnActiveSince: number | null;
  /** Rolling samples, oldest first. */
  readonly buf: number[];
  /** Decaying spike for the busy rhythm. */
  spike: number;
}

/**
 * Spec 168 — synthetic activity heartbeat. Not real data: a status-coloured
 * rhythm so a glance tells you a lane is alive and what it is doing (busy
 * spikes, needs-permission/awaiting-peer breathe, idle/stopped flatline).
 */
function samplePulse(beat: BeatState, now: number): number {
  const t = performance.now();
  if (beat.status === 'awaiting_peer') return Math.sin(t * 0.003) * 0.18 + (Math.random() - 0.5) * 0.05;
  if (beat.status === 'needs_permission') return Math.sin(t * 0.006) * 0.35 + (Math.random() - 0.5) * 0.08;
  if (beat.status === 'busy') {
    const boost = beat.turnActiveSince ? Math.min(0.35, (now - beat.turnActiveSince) / 120000) : 0;
    if (Math.random() < 0.04 + boost) beat.spike = 1;
    const v = beat.spike > 0.02 ? beat.spike : (Math.random() - 0.5) * 0.12;
    beat.spike *= 0.55;
    return Math.max(-1, Math.min(1, v));
  }
  return (Math.random() - 0.5) * 0.06;
}

export function drawBeat(canvas: FittedCanvas, beat: BeatState, now: number): void {
  const s = canvas.surface();
  if (!s) return;
  const { ctx, w, h } = s;
  const p = palette();
  ctx.clearRect(0, 0, w, h);
  if (!beat.active) {
    baseline(s, p.muted);
    return;
  }
  const buf = beat.buf;
  buf.push(samplePulse(beat, now));
  buf.shift();
  const mid = h / 2;
  ctx.strokeStyle = p[beat.tone];
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  for (let i = 0; i < buf.length; i++) {
    const x = (i / (buf.length - 1)) * w;
    const y = mid - buf[i] * (h * 0.42);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * Spec 169 — CPU sparkline over the client-side ring of `cpuPercent` samples
 * (one per applied snapshot). No live process → flat muted baseline, never a
 * fake 0% line.
 */
export function drawCpuSpark(canvas: FittedCanvas, samples: readonly number[], cpu: number | null): void {
  const s = canvas.surface();
  if (!s) return;
  const { ctx, w, h } = s;
  const p = palette();
  ctx.clearRect(0, 0, w, h);
  if (cpu === null) {
    baseline(s, p.muted);
    return;
  }
  const n = samples.length;
  const pad = 3;
  const gh = h - pad * 2;
  const peak = Math.max(100, ...samples) * 1.12;
  const py = (v: number): number => pad + gh - (v / peak) * gh;
  const step = w / (n - 1);
  const col = p[heatTone(cpu)];
  // 100% reference line
  ctx.strokeStyle = p.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, py(100));
  ctx.lineTo(w, py(100));
  ctx.stroke();
  // area fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, withAlpha(col, 0.33));
  grad.addColorStop(1, withAlpha(col, 0.03));
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < n; i++) ctx.lineTo(i * step, py(samples[i]));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // line
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    if (i === 0) ctx.moveTo(0, py(samples[0]));
    else ctx.lineTo(i * step, py(samples[i]));
  }
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  // head dot
  ctx.beginPath();
  ctx.arc((n - 1) * step, py(samples[n - 1]), 2.4, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
}
