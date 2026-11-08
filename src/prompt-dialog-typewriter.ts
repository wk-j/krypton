// Krypton — Smart Prompt Dialog typewriter slip (spec 373)
// The rail, carriage, ink afterimages and lamplight from the Ribbon TTY design,
// drawn around the dialog's <textarea>. The textarea stays the editor (IME,
// selection, undo, @ completion); this module only reads its caret position.
// Nothing here moves unless a key, click or scroll moves the caret. The sheet
// is the whole dialog panel: it carries the paper grain, the lamplight and
// `data-move`; the slip is the typing area on it.

import { getCaretCoordinates, getTextRangeBox } from './caret-position';

export type CarriageMove = 'type' | 'cr' | 'back' | 'still';

/** The rail runs this far below the bottom of the caret's line (design `GAP`). */
const RAIL_GAP = 40;
const CARRIAGE_W = 108;
const CARRIAGE_H = 34;
const RAIL_H = 12;
/** From the bottom of the caret's line to the bottom of the carriage: what a
 *  popup opening under the caret must clear so it never covers the typewriter. */
export const CARRIAGE_CLEARANCE = RAIL_GAP + CARRIAGE_H / 2;
/** The typebar strike and the green LED flash (overlays.css `krypton-prompt-strike`). */
const STRIKE_MS = 70;
/** A held key repeats faster than the typebar can travel; strike at most this often. */
const STRIKE_MIN_GAP_MS = 60;
/** Fraction of the line where the margin bell rings, once per row (design: 0.86). */
const MARGIN_BELL = 0.86;
const GRAIN_PX = 384;
/** The lamplight ellipse's radii (`.krypton-prompt-dialog__lamp-light`). */
const LAMP_RX = 520;
const LAMP_RY = 360;
/** The lamp hangs this far above the rail; the flare this far (design). */
const LAMP_ABOVE_RAIL = 90;
const FLARE_ABOVE_RAIL = 26;
/** Inside this share of the lamp's reach the sheet is light enough for dark
 *  ink; outside it pale ink reads better. The two inks' contrasts on the
 *  multiplied paper cross near 0.6. */
export const LIT_REACH = 0.6;

const CLS = 'krypton-prompt-dialog';
/** The head and foot print that sits above the lamplight and is inked for it. */
const PRINT_SELECTOR = `.${CLS}__target-chip > span, .${CLS}__footer > span`;

/** How far a point is from the lamp's centre, in lamp radii: 0 under it, 1 at its edge. */
export function lampReach(dx: number, dy: number): number {
  return Math.hypot(dx / LAMP_RX, dy / LAMP_RY);
}

/** One paper grain texture per app run, generated on first open. */
let grainUrl: string | null | undefined;

function paperGrain(): string | null {
  if (grainUrl !== undefined) return grainUrl;
  grainUrl = null;
  const canvas = document.createElement('canvas');
  canvas.width = GRAIN_PX;
  canvas.height = GRAIN_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return grainUrl;
  const img = ctx.createImageData(GRAIN_PX, GRAIN_PX);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 255 - Math.random() * 20;
    d[i] = v;
    d[i + 1] = v - 1;
    d[i + 2] = v - 3;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Fibres, then specks — the design's recipe.
  for (let k = 0; k < 46; k++) {
    ctx.strokeStyle = `rgba(120,95,65,${0.05 + Math.random() * 0.07})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    const a = Math.random() * GRAIN_PX;
    const b = Math.random() * GRAIN_PX;
    ctx.moveTo(a, b);
    ctx.quadraticCurveTo(
      a + (Math.random() - 0.5) * 40, b + (Math.random() - 0.5) * 40,
      a + (Math.random() - 0.5) * 60, b + (Math.random() - 0.5) * 60,
    );
    ctx.stroke();
  }
  for (let k = 0; k < 120; k++) {
    ctx.fillStyle = `rgba(45,35,25,${0.12 + Math.random() * 0.5})`;
    ctx.beginPath();
    ctx.arc(Math.random() * GRAIN_PX, Math.random() * GRAIN_PX, Math.random() * 1.05 + 0.25, 0, 7);
    ctx.fill();
  }
  grainUrl = canvas.toDataURL('image/png');
  return grainUrl;
}

interface GraphemeSegments {
  containing(index: number): { segment: string; index: number } | undefined;
}

interface GraphemeSegmenter {
  segment(input: string): GraphemeSegments;
}

// lib is ES2021; Intl.Segmenter typings arrive with ES2022.
const graphemeSegmenter: GraphemeSegmenter | null = (() => {
  const Ctor = (Intl as typeof Intl & {
    Segmenter?: new (locale: string | undefined, options: { granularity: 'grapheme' }) => GraphemeSegmenter;
  }).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
})();

/** No typed grapheme cluster is longer than this (a ZWJ family emoji is 11). */
const CLUSTER_REACH = 16;

/** The text an ink copies when `length` units were typed at `index`: the whole
 *  grapheme clusters they belong to. A Thai mark (สระบน, วรรณยุกต์) joins the
 *  consonant before it, so its ink lands on that consonant's cell, where the
 *  textarea draws the mark, and never on the empty cell after it. */
export function inkRange(text: string, index: number, length: number): [number, number] {
  const end = index + length;
  if (!graphemeSegmenter || length <= 0) return [index, end];
  const from = Math.max(0, index - CLUSTER_REACH);
  const segments = graphemeSegmenter.segment(text.slice(from, end + CLUSTER_REACH));
  const first = segments.containing(index - from);
  const last = segments.containing(end - 1 - from);
  if (!first || !last) return [index, end];
  return [from + first.index, from + last.index + last.segment.length];
}

function part(className: string, parent: HTMLElement, tag = 'div'): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

export class Typewriter {
  private readonly sheet: HTMLElement;
  private readonly slip: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly onBell: () => void;
  private readonly fx: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly carriage: HTMLElement;
  private readonly lamp: HTMLElement;
  private readonly lampLight: HTMLElement;
  private readonly lampFlare: HTMLElement;
  private readonly ledStrike: HTMLElement;
  private readonly ledQueue: HTMLElement;
  private readonly ledError: HTMLElement;
  private readonly reducedMotion: MediaQueryList | null;
  private active = false;
  private raf = 0;
  private inkRaf = 0;
  /** The lamp's centre in sheet coordinates, once placed. */
  private lampAt: { x: number; y: number } | null = null;
  private pendingMove: CarriageMove | null = null;
  /** Set by strike(); the next placement checks the margin bell. */
  private typed = false;
  private prev: { rowTop: number; left: number } | null = null;
  private bellRowTop: number | null = null;
  private charW = 10;
  private lineH = 24;
  private padLeft = 0;
  private padRight = 0;
  private strikeAt = 0;
  private strikeTimer = 0;

  constructor(sheet: HTMLElement, slip: HTMLElement, textarea: HTMLTextAreaElement, onBell: () => void) {
    this.sheet = sheet;
    this.slip = slip;
    this.textarea = textarea;
    this.onBell = onBell;
    this.fx = part(`${CLS}__slip-fx`, slip);
    this.rail = part(`${CLS}__rail`, slip);
    part(`${CLS}__rail-cap ${CLS}__rail-cap--l`, this.rail, 'i');
    part(`${CLS}__rail-cap ${CLS}__rail-cap--r`, this.rail, 'i');
    this.carriage = part(`${CLS}__carriage`, slip);
    const stalk = part(`${CLS}__carriage-stalk`, this.carriage);
    part(`${CLS}__carriage-head`, stalk, 'i');
    const pill = part(`${CLS}__carriage-pill`, this.carriage);
    const leds = part(`${CLS}__carriage-leds`, pill, 'span');
    this.ledStrike = part(`${CLS}__led ${CLS}__led--g`, leds, 'i');
    this.ledQueue = part(`${CLS}__led ${CLS}__led--a`, leds, 'i');
    this.ledError = part(`${CLS}__led ${CLS}__led--r`, leds, 'i');
    this.lamp = part(`${CLS}__lamp`, sheet);
    this.lampLight = part(`${CLS}__lamp-light`, this.lamp);
    this.lampFlare = part(`${CLS}__lamp-flare`, part(`${CLS}__flare`, sheet));
    this.sheet.dataset.move = 'still';
    this.reducedMotion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    window.addEventListener('resize', () => {
      if (!this.active) return;
      this.measure();
      this.sync('still');
    });
  }

  /** The dialog opened: lay paper, measure the type, park the carriage. */
  show(): void {
    this.active = true;
    const grain = paperGrain();
    if (grain) this.sheet.style.setProperty('--prompt-grain', `url(${grain})`);
    this.measure();
    this.prev = null;
    this.bellRowTop = null;
    this.sync('still');
  }

  hide(): void {
    this.active = false;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.inkRaf);
    this.lampAt = null;
    this.fx.replaceChildren();
  }

  /** The head or foot was re-rendered: ink its new print for where the lamp is. */
  relight(): void {
    if (!this.active || !this.lampAt) return;
    cancelAnimationFrame(this.inkRaf);
    this.inkRaf = requestAnimationFrame(() => {
      if (this.lampAt) this.writeInks(this.readInks(this.lampAt.x, this.lampAt.y));
    });
  }

  /** Move rail and carriage under the caret's line on the next frame. Without
   *  a move, the direction of travel picks it (design `sync`). */
  sync(move?: CarriageMove): void {
    if (!this.active) return;
    if (move) this.pendingMove = move;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.place());
  }

  /** Typebar strike and the ink afterimage of the grapheme cluster that
   *  `grapheme`, typed at `index`, belongs to. */
  strike(index: number, grapheme: string): void {
    if (!this.active) return;
    this.typed = true;
    const now = performance.now();
    if (now - this.strikeAt >= STRIKE_MIN_GAP_MS) {
      this.strikeAt = now;
      const strikeCls = `${CLS}__carriage--strike`;
      this.carriage.classList.remove(strikeCls);
      void this.carriage.offsetWidth; // restart the one-shot animation
      this.carriage.classList.add(strikeCls);
      this.ledStrike.classList.add(`${CLS}__led--on`);
      window.clearTimeout(this.strikeTimer);
      this.strikeTimer = window.setTimeout(() => this.ledStrike.classList.remove(`${CLS}__led--on`), STRIKE_MS);
    }
    if (this.reducedMotion?.matches) return;
    const ta = this.textarea;
    // Unrounded boxes: the copy has to sit on the textarea's glyphs to the
    // fraction of a pixel, or it shows as a second letter beside the first.
    const sheetBox = this.sheet.getBoundingClientRect();
    const fxBox = this.fx.getBoundingClientRect();
    const taBox = ta.getBoundingClientRect();
    const [start, end] = inkRange(ta.value, index, grapheme.length);
    const type = getTextRangeBox(ta, start, end);
    if (type.top < 0 || type.top >= ta.clientHeight) return;
    // The type's line box in sheet coordinates: with the textarea's
    // line-height on the copy, its baseline is the textarea's.
    const x = taBox.left - sheetBox.left - this.sheet.clientLeft + type.left;
    const y = taBox.top - sheetBox.top - this.sheet.clientTop + type.top - (this.lineH - type.height) / 2;
    // Paper cut from the sheet: the patch starts on a whole sheet pixel and
    // its grain is the sheet's grain at that pixel, so the two never resample
    // apart; the type sits the remaining fraction in.
    const px = Math.floor(x);
    const py = Math.floor(y);
    const ink = document.createElement('span');
    ink.className = `${CLS}__ink`;
    ink.style.left = `${sheetBox.left + this.sheet.clientLeft + px - fxBox.left}px`;
    ink.style.top = `${sheetBox.top + this.sheet.clientTop + py - fxBox.top}px`;
    ink.style.width = `${Math.ceil(x + type.width) - px}px`;
    ink.style.height = `${Math.ceil(y + this.lineH) - py}px`;
    ink.style.backgroundPosition = `${-px}px ${-py}px`;
    const copy = part(`${CLS}__ink-type`, ink, 'span');
    copy.style.padding = `${y - py}px 0 0 ${x - px}px`;
    copy.textContent = ta.value.slice(start, end);
    ink.addEventListener('animationend', (e) => {
      if (e.target === ink) ink.remove();
    });
    this.fx.appendChild(ink);
  }

  /** Amber: Enter would queue on a busy lane. Red: the last send failed. */
  setLeds(state: { queue: boolean; error: boolean }): void {
    this.ledQueue.classList.toggle(`${CLS}__led--on`, state.queue);
    this.ledError.classList.toggle(`${CLS}__led--on`, state.error);
  }

  private measure(): void {
    const cs = window.getComputedStyle(this.textarea);
    const fontSize = parseFloat(cs.fontSize) || 17;
    this.lineH = parseFloat(cs.lineHeight) || fontSize * 1.45;
    this.padLeft = parseFloat(cs.paddingLeft) || 0;
    this.padRight = parseFloat(cs.paddingRight) || 0;
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      this.charW = ctx.measureText('M').width || fontSize * 0.6;
    } else {
      this.charW = fontSize * 0.6;
    }
    this.slip.style.setProperty('--prompt-charw', `${this.charW.toFixed(2)}px`);
  }

  private place(): void {
    const ta = this.textarea;
    const caret = getCaretCoordinates(ta, ta.selectionStart);
    // A caret line scrolled out of view parks the carriage at the nearest edge.
    const visibleTop = Math.min(Math.max(caret.top, 0), Math.max(0, ta.clientHeight - this.lineH));
    const x = ta.offsetLeft + caret.left + this.charW / 2;
    const railY = ta.offsetTop + visibleTop + this.lineH + RAIL_GAP;
    const rowTop = caret.top + ta.scrollTop;
    // The lamp hangs over the whole sheet, so it is placed in sheet coordinates.
    const lampX = this.slip.offsetLeft + x;
    const lampY = this.slip.offsetTop + railY - LAMP_ABOVE_RAIL;
    const inks = this.readInks(lampX, lampY);
    const prev = this.prev;
    let move = this.pendingMove;
    if (!move) {
      if (!prev) move = 'still';
      else if (rowTop > prev.rowTop && caret.left < prev.left) move = 'cr';
      else if (caret.left < prev.left || rowTop < prev.rowTop) move = 'back';
      else move = 'type';
    }
    this.pendingMove = null;
    this.sheet.dataset.move = move;
    this.rail.style.transform = `translate3d(0, ${(railY - RAIL_H / 2).toFixed(1)}px, 0)`;
    this.carriage.style.transform =
      `translate3d(${(x - CARRIAGE_W / 2).toFixed(1)}px, ${(railY - CARRIAGE_H / 2).toFixed(1)}px, 0)`;
    this.lampLight.style.transform = `translate3d(${lampX.toFixed(1)}px, ${lampY.toFixed(1)}px, 0)`;
    const flareY = lampY + LAMP_ABOVE_RAIL - FLARE_ABOVE_RAIL;
    this.lampFlare.style.transform = `translate3d(${lampX.toFixed(1)}px, ${flareY.toFixed(1)}px, 0)`;
    this.lampAt = { x: lampX, y: lampY };
    this.writeInks(inks);
    if (this.typed) {
      this.typed = false;
      const lineWidth = ta.clientWidth - this.padLeft - this.padRight;
      const column = caret.left - this.padLeft + this.charW;
      if (lineWidth > 0 && column >= lineWidth * MARGIN_BELL && this.bellRowTop !== rowTop) {
        this.bellRowTop = rowTop;
        this.onBell();
      }
    }
    this.prev = { rowTop, left: caret.left };
  }

  /** Each head and foot part and whether the lamp lights the sheet under it.
   *  Empty when the lamp is off (light scheme): the print keeps its dark ink. */
  private readInks(lampX: number, lampY: number): Array<[HTMLElement, boolean]> {
    if (this.lamp.offsetParent === null) return [];
    const sheet = this.sheet.getBoundingClientRect();
    const left = sheet.left + this.sheet.clientLeft;
    const top = sheet.top + this.sheet.clientTop;
    return Array.from(this.sheet.querySelectorAll<HTMLElement>(PRINT_SELECTOR), (node) => {
      const box = node.getBoundingClientRect();
      const dx = box.left + box.width / 2 - left - lampX;
      const dy = box.top + box.height / 2 - top - lampY;
      return [node, lampReach(dx, dy) < LIT_REACH];
    });
  }

  private writeInks(inks: ReadonlyArray<[HTMLElement, boolean]>): void {
    for (const [node, lit] of inks) node.classList.toggle(`${CLS}__lit`, lit);
  }
}
