// Krypton — Wheel rail (spec 272)
// The arc navigation rail of the Wheel layout: a canvas arc furred with
// tufts (static texture plus live per-window throughput), a faint card orbit,
// one card + label per window, a caret on the active card, and a position
// caption. Cards near the active one carry the real window, scaled onto the
// card (spec 273); the rail owns those transforms and the dock morph that flies
// windows between card and main frame. The rAF loop runs only while the wheel
// is rotating, a window is docking, or a tuft is still decaying, so an idle
// rail costs 0 CPU. Activity-only frames are capped at 30 fps (2 fps under
// reduced motion).

import type { WindowBounds, WindowId } from './types';
import {
  WHEEL_ACTIVITY_EPS,
  WHEEL_CARD_HEIGHT,
  WHEEL_CARD_WIDTH,
  WHEEL_FUR_PER_SLOT,
  WHEEL_LABEL_GAP,
  WHEEL_LERP,
  bumpActivity,
  decayActivity,
  wheelArcPoint,
  wheelCardHeight,
  wheelEdgeFade,
  wheelFurLevel,
  wheelGeometry,
  wheelIsLiveSlot,
  wheelItemAngle,
  wheelItemPose,
  wheelLabelHead,
  wheelPreviewTransform,
  wheelRandom,
  type WheelGeometry,
  type WheelItem,
  type WheelPose,
} from './wheel-layout';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SCROLL_SENSITIVITY = 0.004;
const SCROLL_SNAP_MS = 140;
const ACTIVITY_FRAME_MS = 33;
const REDUCED_ACTIVITY_FRAME_MS = 500;
const ACTIVE_LABEL_GAP = 6;
const CARET_GAP = 5;
/** Matches `.krypton-wheel__caret` width. */
const CARET_WIDTH = 7;
const FUR_ALPHA = 0.8;
const ORBIT_ALPHA = 0.3;
const DEFAULT_ACCENT_RGB = '0, 204, 255';
/** Dock morph ease per frame (~200 ms to settle at 60 fps). */
const DOCK_LERP = 0.22;
const DOCK_EPS = 0.002;
const CARD_Z = '3';
const ACTIVE_CARD_Z = '4';

export interface WheelRailCallbacks {
  /** A card was clicked, or a mouse-wheel scroll settled on an item. */
  onActivate(id: WindowId): void;
  /** The live window element to show on a card, or null to keep the schematic. */
  previewElement(id: WindowId): HTMLElement | null;
  /** False when the configured animation style is `none`. */
  motionEnabled(): boolean;
}

interface WheelEntry {
  item: WheelItem;
  card: HTMLButtonElement;
  label: HTMLSpanElement;
  /** Last max-width written to the label, so frames only touch it on change. */
  labelRoom: number;
  activity: number;
  seed: number;
  /** 1 = the window sits on its card, 0 = it fills the main frame. */
  dock: number;
  /** The window element while the rail writes its transform; null when released. */
  element: HTMLElement | null;
  /** Last `--krypton-wheel-live` written to the card (0 = schematic, 1 = live). */
  live: number;
}

export class WheelRail {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly caret: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly callbacks: WheelRailCallbacks;
  private readonly reduceMotion: MediaQueryList;
  private entries: WheelEntry[] = [];
  private byId = new Map<WindowId, WheelEntry>();
  private target = 0;
  private pos = 0;
  private positioned = false;
  private width = 0;
  private height = 0;
  private geo: WheelGeometry = wheelGeometry(0, 0);
  private cardHeight = WHEEL_CARD_HEIGHT;
  private railBounds: WindowBounds = { x: 0, y: 0, width: 0, height: 0 };
  private main: WindowBounds | null = null;
  /** Focused window's index; drives dock targets and the live slots. */
  private activeIndex = 0;
  private visible = false;
  private accentRgb = DEFAULT_ACCENT_RGB;
  private raf = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrame = 0;
  private lastDraw = 0;
  private disposed = false;

  constructor(host: HTMLElement, callbacks: WheelRailCallbacks) {
    this.callbacks = callbacks;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    this.root = document.createElement('div');
    this.root.className = 'krypton-wheel';
    this.root.hidden = true;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-wheel__arc';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d');

    this.caret = document.createElement('div');
    this.caret.className = 'krypton-wheel__caret';
    this.caret.setAttribute('aria-hidden', 'true');

    this.hint = document.createElement('div');
    this.hint.className = 'krypton-wheel__hint';

    this.root.append(this.canvas, this.caret, this.hint);
    this.root.addEventListener('wheel', this.onWheel, { passive: false });
    host.appendChild(this.root);
    this.refreshColors();
  }

  /** True while the rail is shown; live previews exist only then. */
  get isVisible(): boolean {
    return this.visible;
  }

  /** Position the rail beside the shared main frame, or hide it (narrow
   *  viewport / maximize) with `null`, which also releases every window. */
  setBounds(bounds: WindowBounds | null, main: WindowBounds | null = null): void {
    if (this.disposed) return;
    if (!bounds || !main) {
      this.visible = false;
      this.root.hidden = true;
      this.stopLoop();
      this.releaseAll();
      return;
    }
    const wasVisible = this.visible;
    const mainMoved = !this.main || !sameBounds(this.main, main);
    this.visible = true;
    this.root.hidden = false;
    this.railBounds = { ...bounds };
    this.main = { ...main };
    const style = this.root.style;
    style.left = `${bounds.x}px`;
    style.top = `${bounds.y}px`;
    style.width = `${bounds.width}px`;
    style.height = `${bounds.height}px`;
    const cardHeight = wheelCardHeight(main);
    if (cardHeight !== this.cardHeight) {
      this.cardHeight = cardHeight;
      style.setProperty('--krypton-wheel-card-height', `${cardHeight}px`);
      for (const entry of this.entries) this.paintEntry(entry, entry.item);
    }
    if (bounds.width !== this.width || bounds.height !== this.height || cardHeight !== this.geo.cardHeight) {
      this.width = bounds.width;
      this.height = bounds.height;
      this.geo = wheelGeometry(this.width, this.height, cardHeight);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    } else if (!wasVisible || mainMoved) {
      this.render();
    }
    this.kick();
  }

  /** Reconcile cards with the window list; card DOM is rebuilt only when an item's key changes. */
  setItems(items: WheelItem[]): void {
    if (this.disposed) return;
    const next: WheelEntry[] = [];
    const nextById = new Map<WindowId, WheelEntry>();
    for (const item of items) {
      let entry = this.byId.get(item.id);
      if (!entry) {
        entry = this.createEntry(item);
      } else if (entry.item.key !== item.key) {
        this.paintEntry(entry, item);
      }
      entry.item = item;
      next.push(entry);
      nextById.set(item.id, entry);
    }
    for (const [id, entry] of this.byId) {
      if (!nextById.has(id)) {
        this.releaseElement(entry);
        entry.card.remove();
        entry.label.remove();
      }
    }
    this.entries = next;
    this.byId = nextById;
    const max = Math.max(0, next.length - 1);
    this.target = Math.min(this.target, max);
    this.pos = Math.min(this.pos, max);
    this.kick();
  }

  /** Repaint one known card if its content changed; unknown ids are ignored. */
  updateItem(item: WheelItem): void {
    const entry = this.byId.get(item.id);
    if (!entry || entry.item.key === item.key) return;
    this.paintEntry(entry, item);
    entry.item = item;
  }

  /** Rotate to the focused window's index and dock windows around it: the
   *  focused one flies from its card into the main frame, the previous one
   *  back to its card. The first call jumps without spinning or morphing. */
  setActive(index: number): void {
    if (this.disposed) return;
    this.target = Math.max(0, Math.min(Math.max(0, this.entries.length - 1), index));
    this.activeIndex = Math.round(this.target);
    if (this.snapTimer) {
      clearTimeout(this.snapTimer);
      this.snapTimer = null;
    }
    if (!this.positioned) {
      this.pos = this.target;
      this.positioned = true;
      this.settleDocks();
      this.render();
    }
    this.kick();
  }

  /** Feed a window's output throughput into its tuft. */
  pump(id: WindowId, bytes: number): void {
    const entry = this.byId.get(id);
    if (!entry) return;
    entry.activity = bumpActivity(entry.activity, bytes);
    this.kick();
  }

  /** Re-read theme colors; call on theme change. */
  refreshColors(): void {
    const rgb = getComputedStyle(this.root).getPropertyValue('--krypton-accent-rgb').trim();
    this.accentRgb = rgb || DEFAULT_ACCENT_RGB;
    if (this.visible) this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseAll();
    this.disposed = true;
    this.stopLoop();
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.root.removeEventListener('wheel', this.onWheel);
    this.root.remove();
    this.entries = [];
    this.byId.clear();
  }

  // ─── DOM ─────────────────────────────────────────────────────────

  private createEntry(item: WheelItem): WheelEntry {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'krypton-wheel__card';
    card.tabIndex = -1;
    card.dataset.windowId = item.id;
    // Keep DOM focus on the terminal; the click alone switches windows.
    card.addEventListener('mousedown', (event) => event.preventDefault());
    card.addEventListener('click', () => this.callbacks.onActivate(item.id));

    const label = document.createElement('span');
    label.className = 'krypton-wheel__label';
    label.setAttribute('aria-hidden', 'true');

    this.root.insertBefore(card, this.caret);
    this.root.insertBefore(label, this.caret);
    const entry: WheelEntry = {
      item,
      card,
      label,
      labelRoom: -1,
      activity: 0,
      seed: hashSeed(item.id),
      dock: 1,
      element: null,
      live: 0,
    };
    this.paintEntry(entry, item);
    return entry;
  }

  private paintEntry(entry: WheelEntry, item: WheelItem): void {
    entry.card.setAttribute('aria-label', item.label);
    entry.label.textContent = wheelLabelHead(item.label);
    entry.card.replaceChildren(buildSchematicSvg(item, this.cardHeight));
  }

  // ─── Live previews (spec 273) ────────────────────────────────────

  /** Snap every dock to its target (first placement, no motion). */
  private settleDocks(): void {
    for (let i = 0; i < this.entries.length; i++) {
      this.entries[i].dock = i === this.activeIndex ? 0 : 1;
    }
  }

  /** Ease docks toward their targets; returns true while any is still moving. */
  private stepDocks(): boolean {
    const instant = this.reduceMotion.matches || !this.callbacks.motionEnabled();
    let moving = false;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const goal = i === this.activeIndex ? 0 : 1;
      if (entry.dock === goal) continue;
      const next = instant ? goal : entry.dock + (goal - entry.dock) * DOCK_LERP;
      entry.dock = Math.abs(goal - next) < DOCK_EPS ? goal : next;
      if (entry.dock !== goal) moving = true;
    }
    return moving;
  }

  /** Hand a window back to the compositor with no rail styles left on it. */
  private releaseElement(entry: WheelEntry): void {
    const el = entry.element;
    if (el) {
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.opacity = '';
      entry.element = null;
    }
    this.setCardLive(entry, 0);
  }

  private releaseAll(): void {
    for (const entry of this.entries) this.releaseElement(entry);
    this.settleDocks();
  }

  private setCardLive(entry: WheelEntry, amount: number): void {
    const live = Math.round(amount * 50) / 50;
    if (live === entry.live) return;
    entry.live = live;
    entry.card.style.setProperty('--krypton-wheel-live', `${live}`);
    entry.card.classList.toggle('krypton-wheel__card--live', live > 0);
  }

  /** Write the window's transform for slot `i`, or release it once it no longer
   *  needs one (the focused window after it has docked into the main frame). */
  private placePreview(entry: WheelEntry, i: number, pose: WheelPose): void {
    const main = this.main;
    const active = i === this.activeIndex;
    const wanted = main !== null
      && (wheelIsLiveSlot(i, this.activeIndex) || (active && entry.dock > 0));
    if (!wanted) {
      this.releaseElement(entry);
      return;
    }
    const el = entry.element ?? this.callbacks.previewElement(entry.item.id);
    if (!el) {
      this.setCardLive(entry, 0);
      return;
    }
    if (!entry.element) {
      entry.element = el;
      el.style.transformOrigin = '50% 50%';
    }
    // On the card the window takes the card's fade; in the main frame it is
    // opaque. Near a rail edge it fades out and the card's schematic fades in.
    const edge = pose.hidden ? 0 : wheelEdgeFade(pose, this.geo);
    const shown = pose.opacity * edge;
    el.style.transform = wheelPreviewTransform(pose, this.railBounds, main, entry.dock);
    el.style.opacity = (1 + (shown - 1) * entry.dock).toFixed(3);
    this.setCardLive(entry, active ? 0 : entry.dock * edge);
  }

  // ─── Render loop ─────────────────────────────────────────────────

  private kick(): void {
    if (this.disposed || !this.visible || this.raf) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed || !this.visible) return;
    const dt = Math.min(100, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;

    let busy = false;
    for (const entry of this.entries) {
      entry.activity = decayActivity(entry.activity, dt);
      if (entry.activity >= WHEEL_ACTIVITY_EPS) busy = true;
    }

    const reduced = this.reduceMotion.matches;
    const rotating = Math.abs(this.target - this.pos) > 0.0005;
    if (rotating) {
      this.pos = reduced ? this.target : this.pos + (this.target - this.pos) * WHEEL_LERP;
    } else {
      this.pos = this.target;
    }
    const docking = this.stepDocks();
    const minInterval = reduced ? REDUCED_ACTIVITY_FRAME_MS : ACTIVITY_FRAME_MS;
    if (rotating || docking || !busy || now - this.lastDraw >= minInterval) {
      this.render();
      this.lastDraw = now;
    }

    if (Math.abs(this.target - this.pos) > 0.0005 || docking) {
      this.raf = requestAnimationFrame(this.frame);
    } else if (busy) {
      // Activity-only: wake at the capped rate instead of spinning rAF at 60 Hz.
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.raf && !this.disposed && this.visible) {
          this.raf = requestAnimationFrame(this.frame);
        }
      }, minInterval);
    }
  };

  private render(): void {
    if (!this.visible || this.width <= 0) return;
    this.layoutCards();
    this.drawArc();
  }

  private layoutCards(): void {
    const highlighted = Math.round(this.target);
    let caretShown = false;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const pose = wheelItemPose(i, this.pos, this.geo);
      const on = i === highlighted;
      const cardStyle = entry.card.style;
      const labelStyle = entry.label.style;
      const visibility = pose.hidden ? 'hidden' : 'visible';
      const opacity = pose.opacity.toFixed(3);
      cardStyle.visibility = visibility;
      labelStyle.visibility = visibility;
      cardStyle.opacity = opacity;
      labelStyle.opacity = opacity;
      cardStyle.zIndex = on ? ACTIVE_CARD_Z : CARD_Z;
      entry.card.classList.toggle('krypton-wheel__card--active', on);
      entry.label.classList.toggle('krypton-wheel__label--active', on);
      this.placePreview(entry, i, pose);
      if (pose.hidden) continue;

      cardStyle.transform = `translate(${pose.x.toFixed(2)}px, ${pose.y.toFixed(2)}px) translate(-50%, -50%) rotate(${pose.rotate.toFixed(4)}rad) scale(${pose.scale.toFixed(3)})`;
      // Labels stay upright; they are pinned to a point on the leaning card.
      const halfW = (WHEEL_CARD_WIDTH / 2) * pose.scale;
      const cos = Math.cos(pose.rotate);
      const sin = Math.sin(pose.rotate);
      const pinX = (dx: number, dy: number): number => pose.x + dx * cos - dy * sin;
      const pinY = (dx: number, dy: number): number => pose.y + dx * sin + dy * cos;
      const pin = (dx: number, dy: number): string =>
        `translate(${pinX(dx, dy).toFixed(2)}px, ${pinY(dx, dy).toFixed(2)}px)`;
      // Every label sits inline with its card; the active one past the caret.
      const labelDx = on ? halfW + CARET_GAP + CARET_WIDTH + ACTIVE_LABEL_GAP : halfW + WHEEL_LABEL_GAP;
      const labelX = pinX(labelDx, 0);
      labelStyle.transform = `${pin(labelDx, 0)} translateY(-50%)`;
      if (on) {
        caretShown = true;
        this.caret.style.transform = `${pin(halfW + CARET_GAP, 0)} translateY(-50%)`;
      }
      // Ellipsize at the rail edge instead of letting the rail clip the text.
      const room = Math.max(0, Math.floor(this.width - labelX - 6));
      if (room !== entry.labelRoom) {
        entry.labelRoom = room;
        labelStyle.maxWidth = `${room}px`;
      }
    }
    this.caret.style.visibility = caretShown ? 'visible' : 'hidden';
    const count = this.entries.length;
    const current = count === 0 ? 0 : Math.min(count, highlighted + 1);
    this.hint.textContent = `${pad2(current)} / ${pad2(count)}`;
  }

  private drawArc(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const geo = this.geo;
    const ext = geo.arcExtent;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.lineCap = 'round';

    // The arc, thicker toward its upper middle (prototype profile, spread over
    // the part of the arc that is inside the rail).
    ctx.strokeStyle = `rgba(${this.accentRgb}, 0.8)`;
    for (let t = -ext - 0.04; t < ext + 0.04; t += 0.015) {
      const [ax, ay] = wheelArcPoint(t, geo.radius, geo);
      const [bx, by] = wheelArcPoint(t + 0.017, geo.radius, geo);
      const u = t / ext;
      ctx.lineWidth = 0.8 + 4 * Math.pow(Math.max(0, 1 - Math.abs(u + 0.23)), 1.6);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // Faint concentric orbit that the card centres ride on.
    const cx = geo.arcX + geo.radius;
    const cy = geo.railHeight / 2;
    const orbitExt = Math.asin(Math.min(1, cy / geo.cardRadius)) + 0.05;
    ctx.globalAlpha = ORBIT_ALPHA;
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.arc(cx, cy, geo.cardRadius, Math.PI - orbitExt, Math.PI + orbitExt);
    ctx.stroke();

    ctx.strokeStyle = `rgb(${this.accentRgb})`;
    ctx.fillStyle = `rgb(${this.accentRgb})`;
    ctx.lineWidth = 0.7;

    // Static fur along the whole visible arc; seeded per slot so it turns with the wheel.
    const span = 1 + (ext + 0.05) / geo.idleStep;
    const first = Math.ceil((this.pos - span) * WHEEL_FUR_PER_SLOT);
    const last = Math.floor((this.pos + span) * WHEEL_FUR_PER_SLOT);
    for (let k = first; k <= last; k++) {
      const t = wheelItemAngle(k / WHEEL_FUR_PER_SLOT - this.pos, geo);
      if (Math.abs(t) > ext + 0.05) continue;
      const fade = Math.max(0, 1 - Math.abs(t) / (ext + 0.3));
      this.drawTuft(ctx, t, wheelFurLevel(k), Math.imul(k, 977) + 13, FUR_ALPHA * fade);
    }

    // Live throughput: one bright tuft per window, level with its card.
    for (let i = 0; i < this.entries.length; i++) {
      const t = wheelItemAngle(i - this.pos, geo);
      if (Math.abs(t) > ext + 0.05) continue;
      const entry = this.entries[i];
      const v = entry.activity;
      const fade = Math.max(0, 1 - Math.abs(t) / (ext + 0.3));
      if (v >= WHEEL_ACTIVITY_EPS) this.drawTuft(ctx, t, v, entry.seed, fade);
      const [px, py] = wheelArcPoint(t, geo.radius, geo);
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.arc(px, py, 1.2 + v * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** One tuft of outward strands at arc angle `t`; strand count/length follow `v`. */
  private drawTuft(ctx: CanvasRenderingContext2D, t: number, v: number, seed: number, alpha: number): void {
    if (alpha <= 0) return;
    const [px, py] = wheelArcPoint(t, this.geo.radius, this.geo);
    const rand = wheelRandom(seed);
    const outward = Math.atan2(Math.sin(t), -Math.cos(t));
    const strands = 3 + Math.round(v * 32);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let s = 0; s < strands; s++) {
      // Four draws per strand keep each strand's shape stable as the count changes.
      const spread = rand() - 0.5;
      const wide = rand() < 0.15;
      const reach = rand();
      const bend = rand();
      const angle = outward + spread * (wide ? 5 : 2.2);
      const len = 3 + (4 + reach * 80) * v;
      const ex = px + Math.cos(angle) * len;
      const ey = py + Math.sin(angle) * len;
      ctx.moveTo(px, py);
      ctx.lineTo(ex, ey);
      // Long strands shed a speck past their tip.
      if (reach > 0.72 && v > 0.3) {
        const sx = px + Math.cos(angle) * len * 1.25;
        const sy = py + Math.sin(angle) * len * 1.25;
        ctx.rect(sx - 0.6, sy - 0.6, 1.2, 1.2);
      }
      if (len > 14) {
        const mx = px + Math.cos(angle) * len * 0.6;
        const my = py + Math.sin(angle) * len * 0.6;
        const branch = angle + (bend - 0.5) * 1.4;
        ctx.moveTo(mx, my);
        ctx.lineTo(mx + Math.cos(branch) * len * 0.35, my + Math.sin(branch) * len * 0.35);
      }
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 0.6 + v * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // ─── Input ───────────────────────────────────────────────────────

  private readonly onWheel = (event: WheelEvent): void => {
    const count = this.entries.length;
    if (count < 2) return;
    const delta = event.deltaY || event.deltaX;
    const atEnd = (delta < 0 && this.target <= 0) || (delta > 0 && this.target >= count - 1);
    if (atEnd) return;
    event.preventDefault();
    this.target = Math.max(0, Math.min(count - 1, this.target + delta * SCROLL_SENSITIVITY));
    this.kick();
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      const index = Math.round(this.target);
      this.target = index;
      this.kick();
      const id = this.entries[index]?.item.id;
      if (id) this.callbacks.onActivate(id);
    }, SCROLL_SNAP_MS);
  };
}

function buildSchematicSvg(item: WheelItem, cardHeight: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'krypton-wheel__schematic');
  svg.setAttribute('viewBox', `0 0 ${WHEEL_CARD_WIDTH} ${cardHeight}`);
  svg.setAttribute('aria-hidden', 'true');
  const x0 = 6;
  const y0 = 6;
  const areaW = WHEEL_CARD_WIDTH - 12;
  const areaH = cardHeight - 16;
  const split = item.schematic.length > 1;
  for (const pane of item.schematic) {
    const x = x0 + pane.x * areaW;
    const y = y0 + pane.y * areaH;
    const w = pane.w * areaW;
    const h = pane.h * areaH;
    // Splits are drawn as divider lines; the card has no outer frame.
    if (split && pane.focused) {
      svg.appendChild(svgRect(x, y, w, h, 'krypton-wheel__pane--focused'));
    }
    if (pane.x + pane.w < 0.999) svg.appendChild(svgLine(x + w, y, x + w, y + h));
    if (pane.y + pane.h < 0.999) svg.appendChild(svgLine(x, y + h, x + w, y + h));

    const lines = pane.lines ?? [];
    if (lines.some(([a, b]) => b > a)) {
      const innerX = x + 3;
      const innerW = Math.max(1, w - 6);
      const pitch = Math.max(1, h - 4) / Math.max(lines.length, 12);
      const cls = pane.focused || !split ? 'krypton-wheel__text krypton-wheel__text--focused' : 'krypton-wheel__text';
      lines.forEach(([a, b], row) => {
        if (b <= a) return;
        svg.appendChild(svgRect(innerX + a * innerW, y + 2 + row * pitch, Math.max(1, (b - a) * innerW), Math.max(1, pitch * 0.5), cls));
      });
    } else if (w >= 28 && h >= 16) {
      const glyph = document.createElementNS(SVG_NS, 'text');
      glyph.setAttribute('x', (x + w / 2).toFixed(1));
      glyph.setAttribute('y', (y + h / 2 + 4).toFixed(1));
      glyph.setAttribute('class', 'krypton-wheel__glyph');
      glyph.textContent = pane.glyph;
      svg.appendChild(glyph);
    }
  }
  if (item.tabCount > 1) {
    const dots = Math.min(item.tabCount, 6);
    for (let i = 0; i < dots; i++) {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', `${WHEEL_CARD_WIDTH - 8 - i * 5}`);
      dot.setAttribute('cy', `${cardHeight - 5}`);
      dot.setAttribute('r', '1.6');
      dot.setAttribute('class', 'krypton-wheel__tab-dot');
      svg.appendChild(dot);
    }
  }
  return svg;
}

function svgRect(x: number, y: number, w: number, h: number, cls: string): SVGRectElement {
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', x.toFixed(1));
  rect.setAttribute('y', y.toFixed(1));
  rect.setAttribute('width', w.toFixed(1));
  rect.setAttribute('height', h.toFixed(1));
  rect.setAttribute('class', cls);
  return rect;
}

function svgLine(x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', x1.toFixed(1));
  line.setAttribute('y1', y1.toFixed(1));
  line.setAttribute('x2', x2.toFixed(1));
  line.setAttribute('y2', y2.toFixed(1));
  line.setAttribute('class', 'krypton-wheel__divider');
  return line;
}

function sameBounds(a: WindowBounds, b: WindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
