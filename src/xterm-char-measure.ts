// Krypton — measure xterm.js cell size from the DOM, not from a canvas.
//
// xterm 6 sizes cells with `OffscreenCanvas.measureText('W')` whenever the
// API exists. WKWebView's OffscreenCanvas cannot resolve user-installed fonts
// (~/Library/Fonts): the whole `font.family` list collapses to the generic
// `monospace` fallback, so cells get that font's metrics (16px: 9.6 x 22)
// while the DOM renderer paints the real font (Share Tech Mono: 8.64 x 18).
// Rows end up taller than the box-drawing glyphs, leaving gaps in every
// vertical line (`│`) of TUIs like btop, and text gets extra tracking.
// Measuring a DOM span uses the same font resolution as the rows themselves.
//
// The DOM renderer's per-glyph WidthCache has a second flaw: it measures with
// `offsetWidth`, an integer, so every glyph width is off by up to 1/64 px.
// Each row span's letter-spacing (cell width − glyph width) inherits that
// error once per cell, and across a 160-column btop row the right border
// lands 2–3 px off the grid, by a different amount on every row. Glyph widths
// are re-measured with the fractional `getBoundingClientRect()`.

import type { Terminal } from '@xterm/xterm';

const REPEAT = 32;

interface MeasureResult {
  width: number;
  height: number;
}

interface CharSizeServiceLike {
  width: number;
  height: number;
  _measureStrategy: { measure(): Readonly<MeasureResult> };
  measure(): void;
}

function charSizeServiceOf(terminal: Terminal): CharSizeServiceLike | null {
  // Private chain: Terminal._core._charSizeService
  const core: unknown = Reflect.get(terminal, '_core');
  if (core === null || typeof core !== 'object') return null;
  const service: unknown = Reflect.get(core, '_charSizeService');
  if (service === null || typeof service !== 'object') return null;
  const strategy: unknown = Reflect.get(service, '_measureStrategy');
  if (strategy === null || typeof strategy !== 'object') return null;
  if (typeof Reflect.get(service, 'measure') !== 'function') return null;
  return service as CharSizeServiceLike;
}

function domRendererOf(terminal: Terminal): object | null {
  // Private chain: Terminal._core._renderService._renderer.value
  let node: unknown = terminal;
  for (const key of ['_core', '_renderService', '_renderer', 'value']) {
    if (node === null || typeof node !== 'object') return null;
    node = Reflect.get(node, key);
  }
  return node !== null && typeof node === 'object' ? node : null;
}

/** Swap the WidthCache's integer `offsetWidth` measure for a fractional one. */
function installPreciseWidthCache(terminal: Terminal): boolean {
  const renderer = domRendererOf(terminal);
  const cache: unknown = renderer ? Reflect.get(renderer, '_widthCache') : null;
  if (cache === null || typeof cache !== 'object') return false;
  const elements: unknown = Reflect.get(cache, '_measureElements');
  const clear: unknown = Reflect.get(cache, 'clear');
  if (!Array.isArray(elements) || typeof Reflect.get(cache, '_measure') !== 'function' || typeof clear !== 'function') {
    return false;
  }
  Reflect.set(cache, '_measure', (chars: string, variant: number): number => {
    const el: unknown = elements[variant];
    if (!(el instanceof HTMLElement)) return 0;
    el.textContent = chars.repeat(REPEAT);
    return el.getBoundingClientRect().width / REPEAT;
  });
  Reflect.apply(clear, cache, []);
  // The row container's default spacing was derived from the cached 'W'.
  const setDefaultSpacing: unknown = renderer ? Reflect.get(renderer, '_setDefaultSpacing') : null;
  if (typeof setDefaultSpacing === 'function') Reflect.apply(setDefaultSpacing, renderer, []);
  return true;
}

/**
 * Install on a terminal after `terminal.open()`. Swaps the private cell
 * measure strategy and the DOM renderer's glyph width measure (pinned to
 * @xterm/xterm 6.x), then re-measures; if the shape changes, it warns and
 * leaves the stock measurement in place.
 */
export function installDomCharMeasure(terminal: Terminal): void {
  const service = charSizeServiceOf(terminal);
  const host = terminal.element?.querySelector('.xterm-helpers') ?? terminal.element;
  if (!service || !host) {
    console.warn('[krypton:xterm] char size service not found; DOM cell measurement skipped');
    return;
  }

  if (!installPreciseWidthCache(terminal)) {
    console.warn('[krypton:xterm] DOM width cache not found; glyph widths stay integer-rounded');
  }

  const el = document.createElement('span');
  el.classList.add('xterm-char-measure-element');
  el.setAttribute('aria-hidden', 'true');
  el.textContent = 'W'.repeat(REPEAT);
  el.style.whiteSpace = 'pre';
  el.style.fontKerning = 'none';
  host.appendChild(el);

  // Seed with the stock (canvas) size so a pane opened while hidden keeps a
  // valid cell size until it can be laid out.
  const result: MeasureResult = { width: service.width, height: service.height };
  service._measureStrategy = {
    measure(): Readonly<MeasureResult> {
      el.style.fontFamily = terminal.options.fontFamily ?? '';
      el.style.fontSize = `${terminal.options.fontSize ?? 0}px`;
      const rect = el.getBoundingClientRect();
      // Zero while the pane is display:none — keep the last good size.
      if (rect.width > 0 && rect.height > 0) {
        result.width = rect.width / REPEAT;
        result.height = rect.height;
      }
      return result;
    },
  };
  service.measure();
}
