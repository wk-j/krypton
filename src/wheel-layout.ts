// Krypton — Wheel layout (spec 272)
// Pure geometry for the arc navigation rail: rail/main frames, arc points,
// card poses, wrap-around stepping, pane schematics, and activity decay.

import type { PaneContentType, WindowBounds, WindowId } from './types';

export const WHEEL_HIDE_ANGLE = 1.2;
export const WHEEL_CARD_WIDTH = 112;
/** Default card height; live cards take the main frame's aspect (wheelCardHeight). */
export const WHEEL_CARD_HEIGHT = 70;
export const WHEEL_CARD_MIN_HEIGHT = 56;
export const WHEEL_CARD_MAX_HEIGHT = 100;
/** Cards within this many slots of the active one show the live window (spec 273). */
export const WHEEL_LIVE_SLOTS = 3;
/** A live preview fades to its schematic over this many px before a rail edge. */
export const WHEEL_EDGE_FADE = 24;
export const WHEEL_ACTIVE_SCALE = 1.5;
/** Cards lean by this fraction of their arc angle instead of turning fully radial. */
export const WHEEL_TILT = 0.5;
/** Gap between the arc and the active card's outer edge. */
export const WHEEL_ARC_GAP = 10;
/** Gap between the active card and its neighbours. */
export const WHEEL_CARD_GAP = 4;
/** Gap between two idle cards. */
export const WHEEL_IDLE_GAP = 8;
export const WHEEL_LABEL_GAP = 8;
export const WHEEL_LABEL_MAX_WIDTH = 90;
/** The active card's caret: its gap from the card, its width (matches
 *  `.krypton-wheel__caret`), then the gap to the label. */
export const WHEEL_CARET_GAP = 5;
export const WHEEL_CARET_WIDTH = 7;
export const WHEEL_ACTIVE_LABEL_GAP = 6;
/** Room for the 40px two-character active label chip (~60px in a 0.6em mono
 *  font) plus the 6px it keeps from the rail edge. */
export const WHEEL_ACTIVE_LABEL_ROOM = 66;
/** Characters a rail label shows; the full label stays on the card's aria-label. */
export const WHEEL_LABEL_CHARS = 2;
/** Least room kept left of the arc for tuft strands. */
export const WHEEL_MIN_ARC_X = 34;
/** The arc meets the rail's top and bottom edges this far inside its right edge. */
export const WHEEL_ARC_END_INSET = 16;
/** Static fur tufts drawn per window slot along the arc. */
export const WHEEL_FUR_PER_SLOT = 4;
/** Most text bars a terminal pane's silhouette keeps. */
export const WHEEL_SILHOUETTE_ROWS = 18;
export const WHEEL_LERP = 0.14;
export const WHEEL_ACTIVITY_EPS = 0.02;
export const WHEEL_MIN_MAIN_WIDTH = 480;

const WHEEL_RAIL_WIDTH_RATIO = 0.24;
const WHEEL_RAIL_MIN_WIDTH = 280;
const WHEEL_RAIL_MAX_WIDTH = 400;
const WHEEL_ACTIVITY_HALF_LIFE_MS = 1500;
const WHEEL_ACTIVITY_BYTES_SCALE = 8192;
const WHEEL_ACTIVITY_MIN_KICK = 0.04;

export interface WheelFrame {
  /** Rail bounds; null when the viewport is too narrow to keep one. */
  rail: WindowBounds | null;
  /** Shared base bounds for every window. */
  main: WindowBounds;
}

/** Rail-size-derived arc, card orbit, and item spacing. */
export interface WheelGeometry {
  railWidth: number;
  railHeight: number;
  cardHeight: number;
  /** x of the arc apex (its leftmost point, at t = 0). */
  arcX: number;
  radius: number;
  /** Radius of the concentric orbit every card centre rides on. */
  cardRadius: number;
  /** Angle between the active item and its neighbours. */
  step: number;
  /** Angle between two idle neighbours, further out. */
  idleStep: number;
  /** Half-angle at which the arc leaves the rail's top and bottom edges. */
  arcExtent: number;
}

export interface WheelPose {
  x: number;
  y: number;
  rotate: number;
  scale: number;
  opacity: number;
  hidden: boolean;
}

/** One pane leaf of a window's active tab, normalized to 0..1. */
/** One text bar of a terminal silhouette: [start, end] as fractions of the
 *  pane width; [0, 0] is a blank row. */
export type WheelLine = [number, number];

export interface WheelPaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
  glyph: string;
  /** Terminal panes only: the visible rows as text bars, top to bottom. */
  lines?: WheelLine[];
}

export interface WheelItem {
  id: WindowId;
  label: string;
  schematic: WheelPaneRect[];
  tabCount: number;
  /** Text the active card's ghost eye is made of (spec 274): label plus tab title. */
  eyeText: string;
  /** Changes whenever the card DOM must be rebuilt. */
  key: string;
}

/** Minimal pane-tree shape the schematic needs (structural subset of PaneNode). */
export type WheelPaneNode =
  | { type: 'leaf'; id: string; contentType: PaneContentType; lines?: WheelLine[] }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; first: WheelPaneNode; second: WheelPaneNode };

export function wheelRailWidth(viewportWidth: number): number {
  return clamp(
    Math.round(viewportWidth * WHEEL_RAIL_WIDTH_RATIO),
    WHEEL_RAIL_MIN_WIDTH,
    WHEEL_RAIL_MAX_WIDTH,
  );
}

export function computeWheelFrame(
  viewportWidth: number,
  viewportHeight: number,
  gap: number,
  footerHeight: number,
): WheelFrame {
  const vw = Math.max(1, viewportWidth);
  const g = Math.max(0, gap);
  const usableH = Math.max(1, viewportHeight - footerHeight);
  const mainH = Math.max(1, usableH - g * 2);
  const railW = wheelRailWidth(vw);
  const mainW = vw - railW - g * 2;

  if (mainW < WHEEL_MIN_MAIN_WIDTH) {
    return {
      rail: null,
      main: { x: g, y: g, width: Math.max(1, vw - g * 2), height: mainH },
    };
  }
  return {
    rail: { x: 0, y: 0, width: railW, height: usableH },
    main: { x: railW + g, y: g, width: mainW, height: mainH },
  };
}

/** Card height that matches the main frame's aspect, so a live preview fills its card. */
export function wheelCardHeight(main: WindowBounds): number {
  const ratio = main.height / Math.max(1, main.width);
  return clamp(Math.round(WHEEL_CARD_WIDTH * ratio), WHEEL_CARD_MIN_HEIGHT, WHEEL_CARD_MAX_HEIGHT);
}

export function wheelGeometry(
  railWidth: number,
  railHeight: number,
  cardHeight: number = WHEEL_CARD_HEIGHT,
): WheelGeometry {
  const w = Math.max(1, railWidth);
  const h = Math.max(1, railHeight);
  const cardH = Math.max(1, cardHeight);
  const activeHalfW = (WHEEL_CARD_WIDTH * WHEEL_ACTIVE_SCALE) / 2;
  const orbitGap = activeHalfW + WHEEL_ARC_GAP;
  // Right of the apex: the active card's orbit gap, then whichever is wider —
  // an idle card half and its label, or the active card half, caret, and label.
  const idleSpan = WHEEL_CARD_WIDTH / 2 + WHEEL_LABEL_GAP + WHEEL_LABEL_MAX_WIDTH;
  const activeSpan = activeHalfW + WHEEL_CARET_GAP + WHEEL_CARET_WIDTH + WHEEL_ACTIVE_LABEL_GAP
    + WHEEL_ACTIVE_LABEL_ROOM;
  const arcX = Math.max(WHEEL_MIN_ARC_X, w - orbitGap - Math.max(idleSpan, activeSpan));
  // The circle through the apex and the two inset right-hand rail corners, so
  // the arc spans the full rail height and bows toward the main frame.
  const bow = Math.max(40, w - WHEEL_ARC_END_INSET - arcX);
  const half = h / 2;
  const radius = (bow * bow + half * half) / (2 * bow);
  const cardRadius = Math.max(1, radius - orbitGap);
  // Half-heights of both cards plus the gap. A leaning neighbour also dips a
  // corner toward the card beside it, so add that and settle each step with a
  // few fixed-point passes.
  const settle = (pitch: number, halfW: number): number => {
    let step = pitch / cardRadius;
    for (let i = 0; i < 4; i++) step = (pitch + halfW * Math.sin(step * WHEEL_TILT)) / cardRadius;
    return step;
  };
  const step = settle((cardH * (WHEEL_ACTIVE_SCALE + 1)) / 2 + WHEEL_CARD_GAP, activeHalfW);
  const idleStep = settle(cardH + WHEEL_IDLE_GAP, WHEEL_CARD_WIDTH / 2);
  return {
    railWidth: w,
    railHeight: h,
    cardHeight: cardH,
    arcX,
    radius,
    cardRadius,
    step,
    idleStep,
    arcExtent: Math.asin(Math.min(1, half / radius)),
  };
}

/** Point at angle `t` on a circle of radius `r` concentric with the arc; t = 0 is the apex. */
export function wheelArcPoint(t: number, r: number, geo: WheelGeometry): [number, number] {
  return [geo.arcX + geo.radius - r * Math.cos(t), geo.railHeight / 2 + r * Math.sin(t)];
}

/** Arc angle of the item `offset` slots from `pos`. The first slot out uses
 *  `step` (room for the enlarged active card), later slots the tighter
 *  `idleStep`. Continuous in `offset`, so cards glide
 *  as the wheel turns. */
export function wheelItemAngle(offset: number, geo: WheelGeometry): number {
  const d = Math.abs(offset);
  const near = Math.min(1, d) * geo.step;
  if (d <= 1) return Math.sign(offset) * near;
  // Past the first slot a card's lean trails the orbit tangent by k·t, so the
  // spacing it needs grows as 1 / cos(k·t): dt/dn = idleStep / cos(k·t), solved.
  const k = 1 - WHEEL_TILT;
  const far = k > 1e-6
    ? Math.asin(Math.min(1, Math.sin(k * near) + k * geo.idleStep * (d - 1))) / k
    : near + geo.idleStep * (d - 1);
  return Math.sign(offset) * far;
}

/** Card pose on its orbit. Scale eases with distance from `pos`, so the grow
 *  follows the wheel's rotation instead of jumping when the target changes. */
export function wheelItemPose(index: number, pos: number, geo: WheelGeometry): WheelPose {
  const offset = index - pos;
  const t = wheelItemAngle(offset, geo);
  const angle = Math.abs(t);
  const [x, y] = wheelArcPoint(t, geo.cardRadius, geo);
  const hidden = angle > WHEEL_HIDE_ANGLE
    || x - WHEEL_CARD_WIDTH / 2 > geo.railWidth
    || Math.abs(y - geo.railHeight / 2) > geo.railHeight / 2 + geo.cardHeight;
  return {
    x,
    y,
    rotate: -t * WHEEL_TILT,
    scale: 1 + (WHEEL_ACTIVE_SCALE - 1) * Math.max(0, 1 - Math.abs(offset)),
    opacity: hidden ? 0 : Math.max(0, 1 - angle / 1.25),
    hidden,
  };
}

/** 1 while a posed card sits clear of the rail's right, top, and bottom
 *  edges, easing to 0 over WHEEL_EDGE_FADE px as its rotated bounds reach one.
 *  A live preview is not clipped by the rail, so it must fade out first. */
export function wheelEdgeFade(pose: WheelPose, geo: WheelGeometry): number {
  const hw = (WHEEL_CARD_WIDTH / 2) * pose.scale;
  const hh = (geo.cardHeight / 2) * pose.scale;
  const cos = Math.abs(Math.cos(pose.rotate));
  const sin = Math.abs(Math.sin(pose.rotate));
  const extentX = hw * cos + hh * sin;
  const extentY = hw * sin + hh * cos;
  const room = Math.min(
    geo.railWidth - (pose.x + extentX),
    pose.y - extentY,
    geo.railHeight - (pose.y + extentY),
  );
  return clamp(room / WHEEL_EDGE_FADE, 0, 1);
}

/** Transform that carries a live window (laid out at `main`) onto its card.
 *  `dock` 1 = on the card, 0 = identity (the main frame); translate, rotate,
 *  and scale interpolate between them. Pair with `transform-origin: 50% 50%`. */
export function wheelPreviewTransform(
  pose: WheelPose,
  rail: WindowBounds,
  main: WindowBounds,
  dock: number,
): string {
  const d = clamp(dock, 0, 1);
  const dx = (rail.x + pose.x - (main.x + main.width / 2)) * d;
  const dy = (rail.y + pose.y - (main.y + main.height / 2)) * d;
  const docked = (WHEEL_CARD_WIDTH * pose.scale) / Math.max(1, main.width);
  const scale = 1 + (docked - 1) * d;
  return `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${(pose.rotate * d).toFixed(4)}rad) scale(${scale.toFixed(4)})`;
}

/** Whether slot `index` shows its live window while `active` is focused. */
export function wheelIsLiveSlot(index: number, active: number): boolean {
  return index !== active && Math.abs(index - active) <= WHEEL_LIVE_SLOTS;
}

/** Static fur height (0..1) of fur tuft `k`; WHEEL_FUR_PER_SLOT tufts sit
 *  between neighbouring window slots. Seeded by `k` so fur rotates with the
 *  wheel without flickering. */
export function wheelFurLevel(k: number): number {
  const rand = wheelRandom(Math.imul(k, 977) + 13);
  const base = 0.05 + 0.35 * Math.pow(rand(), 2);
  // Every sixth tuft (one per 1.5 slots) grows into a cluster.
  const cluster = ((k % 6) + 6) % 6 === 2 ? 0.4 + 0.25 * rand() : 0;
  return Math.min(1, base + cluster);
}

/** xorshift32, as in the prototype, so seeded shapes stay stable between frames. */
export function wheelRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function wrapWheelIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

export function decayActivity(activity: number, dtMs: number): number {
  if (activity <= 0 || dtMs <= 0) return Math.max(0, activity);
  const next = activity * Math.pow(0.5, dtMs / WHEEL_ACTIVITY_HALF_LIFE_MS);
  return next < WHEEL_ACTIVITY_EPS / 4 ? 0 : next;
}

export function bumpActivity(activity: number, bytes: number): number {
  if (!(bytes > 0)) return activity;
  return Math.min(1, activity + Math.max(bytes / WHEEL_ACTIVITY_BYTES_SCALE, WHEEL_ACTIVITY_MIN_KICK));
}

export function wheelGlyph(contentType: PaneContentType): string {
  switch (contentType) {
    case 'terminal': return '>_';
    case 'diff': return '±';
    case 'markdown': return '¶';
    case 'agent':
    case 'acp':
    case 'acp_harness': return '◈';
    default: return '▦';
  }
}

/** Flatten a pane tree into normalized leaf rects (vertical split = side by side). */
export function wheelSchematic(node: WheelPaneNode, focusedId: string): WheelPaneRect[] {
  const out: WheelPaneRect[] = [];
  const walk = (n: WheelPaneNode, x: number, y: number, w: number, h: number): void => {
    if (n.type === 'leaf') {
      const rect: WheelPaneRect = { x, y, w, h, focused: n.id === focusedId, glyph: wheelGlyph(n.contentType) };
      if (n.lines) rect.lines = n.lines;
      out.push(rect);
      return;
    }
    const ratio = clamp(n.ratio, 0.05, 0.95);
    if (n.direction === 'vertical') {
      walk(n.first, x, y, w * ratio, h);
      walk(n.second, x + w * ratio, y, w * (1 - ratio), h);
    } else {
      walk(n.first, x, y, w, h * ratio);
      walk(n.second, x, y + h * ratio, w, h * (1 - ratio));
    }
  };
  walk(node, 0, 0, 1, 1);
  return out;
}

export function wheelItemKey(
  label: string,
  schematic: WheelPaneRect[],
  tabCount: number,
  eyeText = '',
): string {
  const rects = schematic
    .map((r) => {
      const lines = r.lines?.map(([a, b]) => `${Math.round(a * 50)}-${Math.round(b * 50)}`).join(' ') ?? '';
      return `${r.x.toFixed(3)},${r.y.toFixed(3)},${r.w.toFixed(3)},${r.h.toFixed(3)},${r.focused ? 1 : 0},${r.glyph},${lines}`;
    })
    .join(';');
  return `${label}|${tabCount}|${eyeText}|${rects}`;
}

/** Bucket a terminal's visible rows into at most WHEEL_SILHOUETTE_ROWS bars.
 *  Each bar spans the widest text in its bucket, from the first non-space
 *  column to the end of the trimmed line. */
export function wheelTextSilhouette(rows: readonly string[], cols: number): WheelLine[] {
  const width = Math.max(1, cols);
  const count = Math.min(rows.length, WHEEL_SILHOUETTE_ROWS);
  const out: WheelLine[] = [];
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * rows.length) / count);
    const to = Math.floor(((b + 1) * rows.length) / count);
    let start = width;
    let end = 0;
    for (let r = from; r < to; r++) {
      const text = rows[r].trimEnd();
      const lead = text.search(/\S/);
      if (lead < 0) continue;
      start = Math.min(start, lead);
      end = Math.max(end, text.length);
    }
    out.push(end > start ? [start / width, Math.min(1, end / width)] : [0, 0]);
  }
  return out;
}

/** Directory-style label for a project badge name: `krypton` → `krypton/`.
 *  A truncated name (ending in `…`) and `~` / `/` keep their text as-is. */
export function wheelLabel(projectName: string | null, fallback: string): string {
  if (projectName) {
    return projectName === '~' || /[/…]$/.test(projectName)
      ? projectName
      : `${projectName}/`;
  }
  return fallback.trim();
}

/** The rail's visible label: the label's first WHEEL_LABEL_CHARS characters
 *  (code points, so an emoji is not split), case kept: `krypton/` → `kr`. */
export function wheelLabelHead(label: string): string {
  return Array.from(label).slice(0, WHEEL_LABEL_CHARS).join('');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
