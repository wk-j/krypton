// Krypton — Smart Prompt Dialog typewriter slip (spec 373)
// The rail, carriage, ink afterimages and lamplight from the Ribbon TTY design,
// drawn around the dialog's <textarea>. The textarea stays the editor (IME,
// selection, undo, @ completion); this module only reads its caret position.
// Nothing here moves unless a key, click or scroll moves the caret.

import { getCaretCoordinates } from './caret-position';

export type CarriageMove = 'type' | 'cr' | 'back' | 'still';

/** The rail runs this far below the bottom of the caret's line (design `GAP`). */
const RAIL_GAP = 40;
const CARRIAGE_W = 108;
const CARRIAGE_H = 34;
const RAIL_H = 12;
const STRIKE_MS = 110;
/** A held key repeats faster than the typebar can travel; strike at most this often. */
const STRIKE_MIN_GAP_MS = 60;
/** Fraction of the line where the margin bell rings, once per row (design: 0.86). */
const MARGIN_BELL = 0.86;
const GRAIN_PX = 384;

const CLS = 'krypton-prompt-dialog';

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

/** CJK, Hangul, fullwidth forms and emoji take two cells (design `gw`). */
const WIDE_GRAPHEME = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]/u;

function part(className: string, parent: HTMLElement, tag = 'div'): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

export class Typewriter {
  private readonly slip: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly onBell: () => void;
  private readonly fx: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly carriage: HTMLElement;
  private readonly lampLight: HTMLElement;
  private readonly lampFlare: HTMLElement;
  private readonly ledStrike: HTMLElement;
  private readonly ledQueue: HTMLElement;
  private readonly ledError: HTMLElement;
  private readonly reducedMotion: MediaQueryList | null;
  private active = false;
  private raf = 0;
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

  constructor(slip: HTMLElement, textarea: HTMLTextAreaElement, onBell: () => void) {
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
    this.lampLight = part(`${CLS}__lamp-light`, part(`${CLS}__lamp`, slip));
    this.lampFlare = part(`${CLS}__lamp-flare`, part(`${CLS}__flare`, slip));
    this.slip.dataset.move = 'still';
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
    if (grain) this.slip.style.setProperty('--prompt-grain', `url(${grain})`);
    this.measure();
    this.prev = null;
    this.bellRowTop = null;
    this.sync('still');
  }

  hide(): void {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.fx.replaceChildren();
  }

  /** Move rail and carriage under the caret's line on the next frame. Without
   *  a move, the direction of travel picks it (design `sync`). */
  sync(move?: CarriageMove): void {
    if (!this.active) return;
    if (move) this.pendingMove = move;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.place());
  }

  /** Typebar strike and the ink afterimage of `grapheme`, which starts at `index`. */
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
    const cell = getCaretCoordinates(ta, index);
    if (cell.top < 0 || cell.top >= ta.clientHeight) return;
    const ink = document.createElement('span');
    ink.className = `${CLS}__ink`;
    ink.textContent = grapheme;
    ink.style.left = `${ta.offsetLeft + cell.left}px`;
    ink.style.top = `${ta.offsetTop + cell.top}px`;
    ink.style.width = `${this.charW * (WIDE_GRAPHEME.test(grapheme) ? 2 : 1)}px`;
    ink.style.height = `${this.lineH}px`;
    ink.addEventListener('animationend', () => ink.remove(), { once: true });
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
    const prev = this.prev;
    let move = this.pendingMove;
    if (!move) {
      if (!prev) move = 'still';
      else if (rowTop > prev.rowTop && caret.left < prev.left) move = 'cr';
      else if (caret.left < prev.left || rowTop < prev.rowTop) move = 'back';
      else move = 'type';
    }
    this.pendingMove = null;
    this.slip.dataset.move = move;
    this.rail.style.transform = `translate3d(0, ${(railY - RAIL_H / 2).toFixed(1)}px, 0)`;
    this.carriage.style.transform =
      `translate3d(${(x - CARRIAGE_W / 2).toFixed(1)}px, ${(railY - CARRIAGE_H / 2).toFixed(1)}px, 0)`;
    this.lampLight.style.transform = `translate3d(${x.toFixed(1)}px, ${(railY - 90).toFixed(1)}px, 0)`;
    this.lampFlare.style.transform = `translate3d(${x.toFixed(1)}px, ${(railY - 26).toFixed(1)}px, 0)`;
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
}
