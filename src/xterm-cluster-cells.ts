// Krypton — xterm.js DOM renderer fix for combining marks and wide glyphs.
//
// The DOM renderer squeezes every cell to the grid with per-span
// `letter-spacing = width * cellWidth - measure(chars)`. Two failures follow
// for proportional complex-script fonts (Thai in Mali, etc.):
// 1. CSS applies that spacing after EVERY code point, so a cell holding a base
//    + combining marks (`ที่`, `น้ำ`, Latin e + U+0301) gets the correction once
//    per mark: marks slide off their base and the cell advance is wrong.
// 2. Glyphs wider than their cells overflow right, and every cell span is an
//    inline-block painted atomically in tree order, so the NEXT cell's
//    background covers the overflow — right-side tone marks vanish wherever
//    the app paints cell backgrounds (helix, any TUI).
// We post-process each rendered row: mark-bearing cells move into an
// inline-block child sized to the exact cell advance with `letter-spacing: 0`,
// and the text of affected spans moves into `position: relative` children,
// which paint after all in-flow backgrounds (still below the z-index:1
// selection layer). Spans without marks or overflow pay one regex test.

import type { Terminal } from '@xterm/xterm';

/** Code points xterm folds into the previous cell (zero width). */
const ATTACHES_TO_PREVIOUS = /[\p{Mn}\p{Me}\u200D]/u;

interface WidthCacheLike {
  get(chars: string, bold: boolean, italic: boolean): number;
}

type CreateRow = (...args: unknown[]) => HTMLSpanElement[];

interface RowFactoryLike {
  createRow: CreateRow;
  defaultSpacing: number;
}

const patched = new WeakSet<object>();

/**
 * Split span text into per-cell units the way xterm stores them: a unit is
 * one code point plus every following combining mark / ZWJ.
 */
export function splitCellClusters(text: string): string[] {
  const units: string[] = [];
  for (const cp of text) {
    if (units.length > 0 && ATTACHES_TO_PREVIOUS.test(cp)) {
      units[units.length - 1] += cp;
    } else {
      units.push(cp);
    }
  }
  return units;
}

function fixSpan(span: HTMLSpanElement, factory: RowFactoryLike, widthCache: WidthCacheLike): void {
  const text = span.textContent ?? '';
  const inline = span.style.letterSpacing;
  const spacing = inline ? parseFloat(inline) : factory.defaultSpacing;
  const hasMarks = ATTACHES_TO_PREVIOUS.test(text);
  // Negative inline spacing = glyph wider than its cells = overflow.
  if (!hasMarks && !(inline && spacing < 0)) return;
  const bold = span.classList.contains('xterm-bold');
  const italic = span.classList.contains('xterm-italic');
  const doc = span.ownerDocument;
  const frag = doc.createDocumentFragment();
  let run = '';
  const flushRun = (): void => {
    if (!run) return;
    const lifted = doc.createElement('span');
    lifted.style.position = 'relative';
    lifted.textContent = run;
    frag.appendChild(lifted);
    run = '';
  };
  for (const unit of hasMarks ? splitCellClusters(text) : [text]) {
    // One code point (a surrogate pair counts as one): stock spacing is right.
    if (!hasMarks || unit.length <= ((unit.codePointAt(0) ?? 0) > 0xffff ? 2 : 1)) {
      run += unit;
      continue;
    }
    flushRun();
    // Merged spans share one spacing, and spacing = advance - measure(unit)
    // for each of their cells, so measure(unit) + spacing is the exact cell
    // advance (wide cells included).
    const cell = doc.createElement('span');
    cell.style.display = 'inline-block';
    cell.style.position = 'relative';
    cell.style.letterSpacing = '0';
    cell.style.width = `${widthCache.get(unit, bold, italic) + spacing}px`;
    cell.textContent = unit;
    frag.appendChild(cell);
  }
  flushRun();
  span.replaceChildren(frag);
}

function isRowFactory(value: unknown): value is RowFactoryLike {
  return typeof Reflect.get(Object(value), 'createRow') === 'function'
    && typeof Reflect.get(Object(value), 'defaultSpacing') === 'number';
}

function rowFactoryOf(terminal: Terminal): RowFactoryLike | null {
  // Private chain: Terminal._core._renderService._renderer.value._rowFactory
  let node: unknown = terminal;
  for (const key of ['_core', '_renderService', '_renderer', 'value', '_rowFactory']) {
    if (node === null || typeof node !== 'object') return null;
    node = Reflect.get(node, key);
  }
  return isRowFactory(node) ? node : null;
}

/**
 * Install on a terminal after `terminal.open()`. Reaches into xterm.js
 * private renderer state (pinned to @xterm/xterm 6.x); if the shape changes,
 * it warns and leaves the stock renderer in place.
 */
export function installClusterCellRendering(terminal: Terminal): void {
  const factory = rowFactoryOf(terminal);
  if (!factory) {
    console.warn('[krypton:xterm] DOM row factory not found; combining-mark cell fix skipped');
    return;
  }
  if (patched.has(factory)) return;
  patched.add(factory);
  const createRow = factory.createRow.bind(factory);
  factory.createRow = (...args: unknown[]): HTMLSpanElement[] => {
    const spans = createRow(...args);
    // createRow(lineData, row, isCursorRow, cursorStyle, cursorInactiveStyle,
    //           cursorX, cursorBlink, cellWidth, widthCache, linkStart, linkEnd)
    const widthCache = args[8];
    if (typeof Reflect.get(Object(widthCache), 'get') !== 'function') return spans;
    for (const span of spans) fixSpan(span, factory, widthCache as WidthCacheLike);
    return spans;
  };
}
