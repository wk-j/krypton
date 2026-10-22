// Krypton — ACP Harness View: text diagrams on a character-cell grid (spec 324).
//
// A fenced code block that is laid out by character columns is re-laid as
// cells, the way a terminal lays text: every grapheme takes one or two cells
// of a rounded `ch` width, and box-drawing characters are painted by generated
// per-glyph rules instead of the font. The default font stack has neither box
// glyphs nor Thai, so the browser drew both from wider or proportional
// fallback fonts and diagram borders drifted off their columns.
//
// `CellGridWriter` is the streaming half (`makeSafeRenderer` routes fenced
// code text to it); `gridifyCodeBlocks` is the one-shot half for `marked`
// output and cached HTML. Both build the same DOM, so a streamed row seals
// without a node being replaced (AGENTS.md constraint 10). Geometry lives in
// `cell-grid.css`.

import './cell-grid.css';

import { graphemeUnits } from './harness-composer-bloom';

export const CELL_GRID_CLASS = 'acp-cellgrid';
const CELL = `${CELL_GRID_CLASS}__cell`;
const COLS_PROPERTY = '--acp-cg-n';
/** Box-drawing (U+2500–U+257F) or block-element (U+2580–U+259F) characters: a diagram. */
const BOX_RE = /[\u2500-\u259F]/;
/**
 * Non-ASCII text, then two or more spaces, then more text on the same line:
 * padding that lines something up after the text — an ASCII frame
 * (`| ชื่อ     |`), a table, aligned comments. It lines up only if every
 * character takes its cell. Non-ASCII text at a line's end (a trailing
 * comment) aligns nothing and stays plain.
 */
const PADDED_AFTER_NON_ASCII_RE = /[^\x00-\x7F][^\n]*? {2,}\S/;
const ZERO_WIDTH_RE = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI_SEQUENCE_RE = /[\u200D\uFE0F]/;
const TAB_STOP = 8;

/** Whether text is laid out by character columns and should sit on the cell grid. */
export function needsCellGrid(text: string): boolean {
  return BOX_RE.test(text) || PADDED_AFTER_NON_ASCII_RE.test(text);
}

// ─── Glyph tables ─────────────────────────────────────────────────────

/** Line weight of one arm: none, light, heavy, double. */
type Weight = 0 | 1 | 2 | 3;
/** Arms from the cell centre, in the order up, right, down, left. */
type Arms = readonly [Weight, Weight, Weight, Weight];

const ARMS = new Map<string, Arms>();
function defineArms(chars: string, ...arms: Arms[]): void {
  [...chars].forEach((ch, i) => ARMS.set(ch, arms[i]));
}
defineArms('─━│┃', [0, 1, 0, 1], [0, 2, 0, 2], [1, 0, 1, 0], [2, 0, 2, 0]);
defineArms('┌┍┎┏', [0, 1, 1, 0], [0, 2, 1, 0], [0, 1, 2, 0], [0, 2, 2, 0]);
defineArms('┐┑┒┓', [0, 0, 1, 1], [0, 0, 1, 2], [0, 0, 2, 1], [0, 0, 2, 2]);
defineArms('└┕┖┗', [1, 1, 0, 0], [1, 2, 0, 0], [2, 1, 0, 0], [2, 2, 0, 0]);
defineArms('┘┙┚┛', [1, 0, 0, 1], [1, 0, 0, 2], [2, 0, 0, 1], [2, 0, 0, 2]);
defineArms('├┝┞┟┠┡┢┣',
  [1, 1, 1, 0], [1, 2, 1, 0], [2, 1, 1, 0], [1, 1, 2, 0], [2, 1, 2, 0], [2, 2, 1, 0], [1, 2, 2, 0], [2, 2, 2, 0]);
defineArms('┤┥┦┧┨┩┪┫',
  [1, 0, 1, 1], [1, 0, 1, 2], [2, 0, 1, 1], [1, 0, 2, 1], [2, 0, 2, 1], [2, 0, 1, 2], [1, 0, 2, 2], [2, 0, 2, 2]);
defineArms('┬┭┮┯┰┱┲┳',
  [0, 1, 1, 1], [0, 1, 1, 2], [0, 2, 1, 1], [0, 2, 1, 2], [0, 1, 2, 1], [0, 1, 2, 2], [0, 2, 2, 1], [0, 2, 2, 2]);
defineArms('┴┵┶┷┸┹┺┻',
  [1, 1, 0, 1], [1, 1, 0, 2], [1, 2, 0, 1], [1, 2, 0, 2], [2, 1, 0, 1], [2, 1, 0, 2], [2, 2, 0, 1], [2, 2, 0, 2]);
defineArms('┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋',
  [1, 1, 1, 1], [1, 1, 1, 2], [1, 2, 1, 1], [1, 2, 1, 2], [2, 1, 1, 1], [1, 1, 2, 1], [2, 1, 2, 1], [2, 1, 1, 2],
  [2, 2, 1, 1], [1, 1, 2, 2], [1, 2, 2, 1], [2, 2, 1, 2], [1, 2, 2, 2], [2, 1, 2, 2], [2, 2, 2, 1], [2, 2, 2, 2]);
defineArms('═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬',
  [0, 3, 0, 3], [3, 0, 3, 0], [0, 3, 1, 0], [0, 1, 3, 0], [0, 3, 3, 0], [0, 0, 1, 3], [0, 0, 3, 1], [0, 0, 3, 3],
  [1, 3, 0, 0], [3, 1, 0, 0], [3, 3, 0, 0], [1, 0, 0, 3], [3, 0, 0, 1], [3, 0, 0, 3], [1, 3, 1, 0], [3, 1, 3, 0],
  [3, 3, 3, 0], [1, 0, 1, 3], [3, 0, 3, 1], [3, 0, 3, 3], [0, 3, 1, 3], [0, 1, 3, 1], [0, 3, 3, 3], [1, 3, 0, 3],
  [3, 1, 0, 1], [3, 3, 0, 3], [1, 3, 1, 3], [3, 1, 3, 1], [3, 3, 3, 3]);
defineArms('╴╵╶╷╸╹╺╻╼╽╾╿',
  [0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 2], [2, 0, 0, 0],
  [0, 2, 0, 0], [0, 0, 2, 0], [0, 2, 0, 1], [1, 0, 2, 0], [0, 1, 0, 2], [2, 0, 1, 0]);

type ArcCorner = 'down-right' | 'down-left' | 'up-left' | 'up-right';
interface Dash {
  readonly axis: 'h' | 'v';
  readonly weight: Weight;
  readonly dashes: number;
}

/** Rounded corners, keyed by the two arms they join. */
const ARCS: Record<string, ArcCorner> = { '╭': 'down-right', '╮': 'down-left', '╯': 'up-left', '╰': 'up-right' };

/** Dashed lines: axis, weight and dashes per cell. */
const DASHES: Record<string, Dash> = {
  '┄': { axis: 'h', weight: 1, dashes: 3 }, '┅': { axis: 'h', weight: 2, dashes: 3 },
  '┆': { axis: 'v', weight: 1, dashes: 3 }, '┇': { axis: 'v', weight: 2, dashes: 3 },
  '┈': { axis: 'h', weight: 1, dashes: 4 }, '┉': { axis: 'h', weight: 2, dashes: 4 },
  '┊': { axis: 'v', weight: 1, dashes: 4 }, '┋': { axis: 'v', weight: 2, dashes: 4 },
  '╌': { axis: 'h', weight: 1, dashes: 2 }, '╍': { axis: 'h', weight: 2, dashes: 2 },
  '╎': { axis: 'v', weight: 1, dashes: 2 }, '╏': { axis: 'v', weight: 2, dashes: 2 },
};

/** Horizontal-only lines: their drawing spans the cell edge to edge, so a run of
 *  one of them is a single cell and repeated characters cost no extra spans. */
const MERGEABLE: Record<string, true> = {
  '─': true, '━': true, '═': true, '┄': true, '┅': true, '┈': true, '┉': true, '╌': true, '╍': true,
};

/**
 * East Asian Wide/Fullwidth code points (two cells). Generated from Unicode 16.0
 * (`unicodedata.east_asian_width in {W, F}`, combining marks excluded, ranges
 * joined across unassigned code points).
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2630, 0x2637], [0x2648, 0x2653], [0x267f, 0x267f], [0x268a, 0x268f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55], [0x2e80, 0x3029], [0x302e, 0x303e], [0x3041, 0x3096], [0x309b, 0x3247], [0x3250, 0xa4c6],
  [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xf900, 0xfad9], [0xfe10, 0xfe19], [0xfe30, 0xfe6b], [0xff01, 0xff60],
  [0xffe0, 0xffe6], [0x16fe0, 0x16fe3], [0x16ff0, 0x1b2fb], [0x1d300, 0x1d376], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6df],
  [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff], [0x1fa70, 0x1faf8], [0x20000, 0x323af],
];

function isWide(cp: number): boolean {
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = WIDE[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Cells one code point takes, as `wcwidth` counts it: combining, enclosing and
 *  format characters and Hangul conjoining vowels/finals take none. */
function codePointCols(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (ZERO_WIDTH_RE.test(ch) || (cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) return 0;
  return isWide(cp) ? 2 : 1;
}

/**
 * Cells a grapheme takes: the sum of its code points, as `wcswidth` and the
 * agents padding a diagram count them. A Thai base with SARA AM (`กำ`) is one
 * grapheme, because U+0E33 is a SpacingMark, yet two cells. An emoji ZWJ or
 * VS16 sequence draws as one glyph and takes two. Ambiguous-width characters
 * (`▶`, `●`) take one.
 */
function cellCols(grapheme: string): number {
  if (EMOJI_SEQUENCE_RE.test(grapheme)) return 2;
  let cols = 0;
  for (const ch of grapheme) cols += codePointCols(ch);
  return cols;
}

// ─── Generated per-glyph rules ────────────────────────────────────────
//
// Strokes are background layers on the box cell's `::before`, which is inset by
// `--acp-cg-over` past the cell on every side. Coordinates below are in the
// cell's own space; `x()`/`y()` move them into the `::before` box. LEFT/TOP
// and RIGHT/BOTTOM mean the overdrawn edges, so a stroke that reaches an edge
// overlaps its neighbour's and no seam can open between cells.

const W = 'var(--acp-cg-w)';
const CX = 'var(--acp-cg-cx)';
const CY = 'var(--acp-cg-cy)';
const G = 'var(--acp-cg-g)';
const OVER = 'var(--acp-cg-over)';
const LEFT = 'left-edge';
const RIGHT = 'right-edge';
const TOP = 'top-edge';
const BOTTOM = 'bottom-edge';

function x(v: string): string {
  if (v === LEFT) return '0px';
  if (v === RIGHT) return '100%';
  return `calc(${v} + ${OVER})`;
}

function y(v: string): string {
  if (v === TOP) return '0px';
  if (v === BOTTOM) return '100%';
  return `calc(${v} + ${OVER})`;
}

/** A filled rectangle; positions are always lengths, sizes may reach 100%. */
function rect(x0: string, y0: string, x1: string, y1: string, color = 'currentColor'): string {
  return `linear-gradient(${color}, ${color}) ${x(x0)} ${y(y0)} / calc(${x(x1)} - ${x(x0)}) calc(${y(y1)} - ${y(y0)}) no-repeat`;
}

function strokeWidth(weight: Weight): string {
  return weight === 2 ? '2px' : '1px';
}

function armLayers([up, right, down, left]: Arms): string[] {
  const layers: string[] = [];
  const horizontalDouble = left === 3 || right === 3;
  const verticalDouble = up === 3 || down === 3;
  const half = (weight: Weight): string => `${strokeWidth(weight)} / 2`;
  // Single (light/heavy) arms meet at the centre; one that crosses a double line stops at it.
  if (up === 1 || up === 2) {
    layers.push(rect(`calc(${CX} - ${half(up)})`, TOP, `calc(${CX} + ${half(up)})`,
      horizontalDouble ? `calc(${CY} - ${G})` : `calc(${CY} + ${half(up)})`));
  }
  if (down === 1 || down === 2) {
    layers.push(rect(`calc(${CX} - ${half(down)})`, horizontalDouble ? `calc(${CY} + ${G})` : `calc(${CY} - ${half(down)})`,
      `calc(${CX} + ${half(down)})`, BOTTOM));
  }
  if (left === 1 || left === 2) {
    layers.push(rect(LEFT, `calc(${CY} - ${half(left)})`,
      verticalDouble ? `calc(${CX} - ${G})` : `calc(${CX} + ${half(left)})`, `calc(${CY} + ${half(left)})`));
  }
  if (right === 1 || right === 2) {
    layers.push(rect(verticalDouble ? `calc(${CX} + ${G})` : `calc(${CX} - ${half(right)})`, `calc(${CY} - ${half(right)})`,
      RIGHT, `calc(${CY} + ${half(right)})`));
  }
  const doubles = [up, right, down, left].filter((weight) => weight === 3).length;
  if (doubles > 0) layers.push(...doubleLayers([up, right, down, left], doubles >= 2));
  return layers;
}

/**
 * Double arms are drawn as the outline of the channels they form: each double
 * arm is a 2G-wide channel from the centre to its edge (joined by the centre
 * square when two or more meet), and the 1px lines are that region's border.
 * `╔` gets an outer and an inner corner, `╬` four inner corners, `═` two rails.
 */
function doubleLayers([up, right, down, left]: Arms, joined: boolean): string[] {
  const xs = [LEFT, `calc(${CX} - ${G})`, CX, `calc(${CX} + ${G})`, RIGHT];
  const ys = [TOP, `calc(${CY} - ${G})`, CY, `calc(${CY} + ${G})`, BOTTOM];
  const filled = Array.from({ length: 4 }, () => [false, false, false, false]);
  const fill = (i0: number, i1: number, j0: number, j1: number): void => {
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) filled[i][j] = true;
  };
  if (right === 3) fill(joined ? 1 : 2, 3, 1, 2);
  if (left === 3) fill(0, joined ? 2 : 1, 1, 2);
  if (up === 3) fill(1, 2, 0, joined ? 2 : 1);
  if (down === 3) fill(1, 2, joined ? 1 : 2, 3);
  if (joined) fill(1, 2, 1, 2);
  // Interior ends reach half a pixel further so perpendicular lines meet at a corner.
  const from = (v: string): string => (v === LEFT || v === TOP ? v : `calc(${v} - 0.5px)`);
  const to = (v: string): string => (v === RIGHT || v === BOTTOM ? v : `calc(${v} + 0.5px)`);
  const layers: string[] = [];
  for (let k = 1; k <= 3; k++) {
    for (let j = 0; j < 4; j++) {
      if (filled[k - 1][j] !== filled[k][j]) {
        layers.push(rect(`calc(${xs[k]} - 0.5px)`, from(ys[j]), `calc(${xs[k]} + 0.5px)`, to(ys[j + 1])));
      }
    }
    for (let i = 0; i < 4; i++) {
      if (filled[i][k - 1] !== filled[i][k]) {
        layers.push(rect(from(xs[i]), `calc(${ys[k]} - 0.5px)`, to(xs[i + 1]), `calc(${ys[k]} + 0.5px)`));
      }
    }
  }
  return layers;
}

function dashLayers({ axis, weight, dashes }: Dash): string[] {
  const stroke = strokeWidth(weight);
  if (axis === 'h') {
    const period = `calc(${W} / ${dashes})`;
    return [
      `repeating-linear-gradient(to right, currentColor 0 calc(${period} * 0.6), transparent 0 ${period}) ` +
        `0px ${y(`calc(${CY} - ${stroke} / 2)`)} / 100% ${stroke} no-repeat`,
    ];
  }
  const period = `calc(1lh / ${dashes})`;
  return [
    `repeating-linear-gradient(to bottom, currentColor 0 calc(${period} * 0.6), transparent 0 ${period}) ` +
      `${x(`calc(${CX} - ${stroke} / 2)`)} 0px / ${stroke} 100% no-repeat`,
  ];
}

function diagonalLayers(ch: string): string[] {
  const line = (direction: string): string =>
    `linear-gradient(${direction}, transparent calc(50% - 0.6px), currentColor 0 calc(50% + 0.6px), transparent 0)`;
  if (ch === '╱') return [line('to bottom right')];
  if (ch === '╲') return [line('to top right')];
  return [line('to bottom right'), line('to top right')];
}

/** U+2580–U+259F: fractional fills of the cell. */
function blockLayers(cp: number): string[] {
  const fillRect = (fx0: number, fy0: number, fx1: number, fy1: number, color = 'currentColor'): string =>
    rect(
      fx0 === 0 ? LEFT : `calc(${W} * ${fx0})`,
      fy0 === 0 ? TOP : `calc(1lh * ${fy0})`,
      fx1 === 1 ? RIGHT : `calc(${W} * ${fx1})`,
      fy1 === 1 ? BOTTOM : `calc(1lh * ${fy1})`,
      color,
    );
  if (cp === 0x2580) return [fillRect(0, 0, 1, 0.5)];
  if (cp >= 0x2581 && cp <= 0x2588) return [fillRect(0, 1 - (cp - 0x2580) / 8, 1, 1)];
  if (cp >= 0x2589 && cp <= 0x258f) return [fillRect(0, 0, (0x2590 - cp) / 8, 1)];
  if (cp === 0x2590) return [fillRect(0.5, 0, 1, 1)];
  if (cp >= 0x2591 && cp <= 0x2593) {
    return [fillRect(0, 0, 1, 1, `color-mix(in srgb, currentColor ${(cp - 0x2590) * 25}%, transparent)`)];
  }
  if (cp === 0x2594) return [fillRect(0, 0, 1, 1 / 8)];
  if (cp === 0x2595) return [fillRect(7 / 8, 0, 1, 1)];
  // Quadrants: 0 upper-left, 1 upper-right, 2 lower-left, 3 lower-right.
  const quadrants: Record<number, number[]> = {
    0x2596: [2], 0x2597: [3], 0x2598: [0], 0x2599: [0, 2, 3], 0x259a: [0, 3],
    0x259b: [0, 1, 2], 0x259c: [0, 1, 3], 0x259d: [1], 0x259e: [1, 2], 0x259f: [1, 2, 3],
  };
  return (quadrants[cp] ?? []).map((q) => {
    const fx = (q % 2) * 0.5;
    const fy = Math.floor(q / 2) * 0.5;
    return fillRect(fx, fy, fx + 0.5, fy + 0.5);
  });
}

const ARC_INSETS: Record<ArcCorner, string> = {
  'down-right': `left: calc(${CX} - 0.5px); top: calc(${CY} - 0.5px); right: calc(0px - ${OVER}); bottom: calc(0px - ${OVER}); ` +
    `border-left-width: 1px; border-top-width: 1px; border-top-left-radius: calc(${W} / 2);`,
  'down-left': `left: calc(0px - ${OVER}); right: calc(${W} - ${CX} - 0.5px); top: calc(${CY} - 0.5px); bottom: calc(0px - ${OVER}); ` +
    `border-right-width: 1px; border-top-width: 1px; border-top-right-radius: calc(${W} / 2);`,
  'up-left': `left: calc(0px - ${OVER}); right: calc(${W} - ${CX} - 0.5px); top: calc(0px - ${OVER}); bottom: calc(1lh - ${CY} - 0.5px); ` +
    `border-right-width: 1px; border-bottom-width: 1px; border-bottom-right-radius: calc(${W} / 2);`,
  'up-right': `left: calc(${CX} - 0.5px); right: calc(0px - ${OVER}); top: calc(0px - ${OVER}); bottom: calc(1lh - ${CY} - 0.5px); ` +
    `border-left-width: 1px; border-bottom-width: 1px; border-bottom-left-radius: calc(${W} / 2);`,
};

function glyphClass(ch: string): string {
  return `${CELL}--u${ch.codePointAt(0)!.toString(16)}`;
}

function glyphRule(ch: string): string {
  const selector = `.${glyphClass(ch)}`;
  const arc = ARCS[ch];
  if (arc) return `${selector}::after { ${ARC_INSETS[arc]} }`;
  const arms = ARMS.get(ch);
  const dash = DASHES[ch];
  const cp = ch.codePointAt(0)!;
  let layers: string[];
  if (arms) layers = armLayers(arms);
  else if (dash) layers = dashLayers(dash);
  else if (cp >= 0x2571 && cp <= 0x2573) layers = diagonalLayers(ch);
  else layers = blockLayers(cp);
  return `${selector}::before { background: ${layers.join(', ')}; }`;
}

let stylesheet: string | null = null;

/** Every per-glyph rule for U+2500–U+259F, in the `krypton.base` layer next to `cell-grid.css`. */
export function cellGridStylesheet(): string {
  if (stylesheet === null) {
    const rules: string[] = [];
    for (let cp = 0x2500; cp <= 0x259f; cp++) rules.push(glyphRule(String.fromCodePoint(cp)));
    stylesheet = `@layer krypton.base {\n${rules.join('\n')}\n}`;
  }
  return stylesheet;
}

const styledDocuments = new WeakSet<Document>();

function ensureStyles(doc: Document): void {
  if (styledDocuments.has(doc) || !doc.head) return;
  const style = doc.createElement('style');
  style.dataset.acpCellgrid = '';
  style.textContent = cellGridStylesheet();
  doc.head.append(style);
  styledDocuments.add(doc);
}

// ─── DOM ──────────────────────────────────────────────────────────────

function appendText(target: Node, text: string): void {
  const last = target.lastChild;
  if (last?.nodeType === Node.TEXT_NODE) (last as Text).appendData(text);
  else target.appendChild((target.ownerDocument ?? document).createTextNode(text));
}

function setCols(cell: HTMLElement, cols: number): void {
  if (cols === 1) cell.style.removeProperty(COLS_PROPERTY);
  else cell.style.setProperty(COLS_PROPERTY, String(cols));
}

/** A cell that later characters of the same kind extend in place: an ASCII run or a merged line. */
interface OpenCell {
  readonly cell: HTMLSpanElement;
  readonly text: Text;
  readonly key: string;
  cols: number;
}

/**
 * Lays one `<code>` block out as cells. Created per fenced block; stays in plain
 * text mode (appending to the trailing `Text` node, like `makeSafeRenderer`)
 * until the block shows it is laid out by columns (`needsCellGrid`), then converts
 * the text it already holds and keeps emitting cells.
 */
export class CellGridWriter {
  private gridded = false;
  private col = 0;
  private open: OpenCell | null = null;
  /** The last grapheme on the line and the cell holding it, which a following chunk may extend. */
  private last: { readonly owner: OpenCell; grapheme: string } | null = null;
  /** Plain mode: the unfinished last line, so padding split across chunks is still seen. */
  private pendingLine = '';

  constructor(private readonly code: HTMLElement) {}

  /** Streaming append for this block. */
  write(text: string): void {
    if (this.gridded) {
      this.emit(text, this.code);
      return;
    }
    appendText(this.code, text);
    const lines = (this.pendingLine + text).split('\n');
    this.pendingLine = lines[lines.length - 1];
    if (BOX_RE.test(text) || lines.some((line) => PADDED_AFTER_NON_ASCII_RE.test(line))) this.convert();
  }

  /** Re-lay the block's current text as cells; highlight spans stay and hold their cells. */
  convert(): void {
    const doc = this.code.ownerDocument;
    ensureStyles(doc);
    const walker = doc.createTreeWalker(this.code, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    this.col = 0;
    this.last = null;
    for (const node of nodes) {
      const fragment = doc.createDocumentFragment();
      this.open = null;
      this.emit(node.data, fragment);
      node.replaceWith(fragment);
    }
    this.code.classList.add(CELL_GRID_CLASS);
    this.gridded = true;
  }

  private emit(text: string, target: Node): void {
    graphemeUnits(text).forEach((segment, index) => {
      if (index === 0 && this.join(segment)) return;
      if (segment === '\n' || segment === '\r\n' || segment === '\r') {
        appendText(target, segment);
        this.col = 0;
        this.open = null;
        this.last = null;
        return;
      }
      const cp = segment.codePointAt(0)!;
      if (segment === '\t') {
        this.cell(target, `${CELL}--tab`, segment, TAB_STOP - (this.col % TAB_STOP));
      } else if (cp < 0x20 || cp === 0x7f) {
        this.attach(target, segment);
      } else if (segment.length === 1 && cp < 0x7f) {
        this.extend(target, 'run', `${CELL}--run`, segment, 1);
      } else if (segment.length === 1 && BOX_RE.test(segment)) {
        const cls = `${CELL}--box ${glyphClass(segment)}${ARCS[segment] ? ` ${CELL}--arc` : ''}`;
        if (MERGEABLE[segment]) this.extend(target, segment, cls, segment, 1);
        else this.cell(target, cls, segment, 1);
      } else {
        const cols = cellCols(segment);
        if (cols === 0) this.attach(target, segment);
        else if (cp < 0x7f && cols === 1) this.extend(target, 'run', `${CELL}--run`, segment, 1);
        else this.cell(target, `${CELL}--glyph`, segment, cols);
      }
    });
  }

  /**
   * A chunk can start inside a grapheme: a Thai mark or SARA AM, an emoji ZWJ
   * tail. Grow the previous grapheme's cell instead of opening a new one, so a
   * streamed block ends identical to a one-shot render and the cluster stays in
   * one `Text` node (0004: WebKit shapes each node alone).
   */
  private join(segment: string): boolean {
    const last = this.last;
    if (!last) return false;
    const grapheme = last.grapheme + segment;
    if (graphemeUnits(grapheme).length !== 1) return false;
    const delta = cellCols(grapheme) - cellCols(last.grapheme);
    last.owner.text.appendData(segment);
    if (delta !== 0) {
      last.owner.cols += delta;
      setCols(last.owner.cell, last.owner.cols);
      this.col += delta;
    }
    last.grapheme = grapheme;
    return true;
  }

  private cell(target: Node, modifiers: string, text: string, cols: number): OpenCell {
    const doc = target.ownerDocument ?? document;
    const cell = doc.createElement('span');
    cell.className = `${CELL} ${modifiers}`;
    setCols(cell, cols);
    const node = doc.createTextNode(text);
    cell.append(node);
    target.appendChild(cell);
    this.col += cols;
    this.open = null;
    const owner: OpenCell = { cell, text: node, key: '', cols };
    this.last = { owner, grapheme: text };
    return owner;
  }

  private extend(target: Node, key: string, modifiers: string, text: string, cols: number): void {
    const open = this.open;
    if (open && open.key === key && target.lastChild === open.cell) {
      open.text.appendData(text);
      open.cols += cols;
      setCols(open.cell, open.cols);
      this.col += cols;
      this.last = { owner: open, grapheme: text };
      return;
    }
    const { cell, text: node } = this.cell(target, modifiers, text, cols);
    this.open = { cell, text: node, key, cols };
    this.last = { owner: this.open, grapheme: text };
  }

  /** Zero-width text with no grapheme to join rides in the previous cell's node. */
  private attach(target: Node, text: string): void {
    if (this.last) this.last.owner.text.appendData(text);
    else appendText(target, text);
  }
}

/**
 * Grid every fenced block under `root` that is laid out by columns (`needsCellGrid`)
 * and is not gridded yet. Returns how many blocks it converted. Safe to call on
 * a detached tree; idempotent.
 */
export function gridifyCodeBlocks(root: HTMLElement | DocumentFragment): number {
  let converted = 0;
  let gridded = false;
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    if (code.classList.contains(CELL_GRID_CLASS)) {
      gridded = true;
      continue;
    }
    if (!needsCellGrid(code.textContent ?? '')) continue;
    new CellGridWriter(code).convert();
    converted += 1;
  }
  // Cached HTML arrives already gridded: its rules still have to be in this document.
  if (gridded) ensureStyles(root.ownerDocument ?? document);
  return converted;
}
