// Krypton — inline images (Sixel, iTerm2 IIP) in terminal panes.
//
// `@xterm/addon-image` decodes the images, answers DA1 with the Sixel bit and
// turns on xterm's CSI 14/16/18 t pixel reports, which image programs
// (ratatui-image in `leaf`, chafa, …) probe before choosing a protocol. Three
// adjustments make its output match a native terminal:
//
// 1. Device pixels. The addon sizes its layer canvas and its cells in CSS
//    pixels, so on a 2× display a program is told a cell is 8 × 21 px, renders
//    the image at that size, and it is upscaled to the screen — half the
//    detail of Ghostty, which reports device pixels. Every size the addon uses
//    (layer canvas, tile coordinates, cells an image covers, IIP sizing,
//    XTSMGRAPHICS) is read from its renderer's `dimensions`; those are
//    replaced by the CSS dimensions × devicePixelRatio, and terminal.css shows
//    the layer canvas at its CSS size. One image pixel is one device pixel.
//
// 2. Whole-pixel size reports. xterm answers CSI 14/16 t with `toFixed(0)`,
//    but Krypton's cell is DOM-measured and fractional (xterm-char-measure.ts;
//    Share Tech Mono 16px at line height 1.2 is 8.64 × 21.6 CSS px, reported as
//    9 × 22). A program sizes an image to `cells × reported px` and the addon
//    covers `ceil(px / real cell)` cells, so a rounded-up report spills the
//    image one column and one row past the area the program reserved; ratatui
//    never rewrites those cells, so the spill stays after a page turn or
//    scroll. The cell is reported rounded down, and the text area as
//    cols × rows of that same cell, so both reports agree.
//
// 3. No blank frames while an image arrives. A program redraws an image by
//    erasing its cells and re-sending it; a page of Sixel is hundreds of KB,
//    which reaches xterm as many 4 KB pty-output writes, and xterm paints the
//    erased area between them. From the start of a Sixel (DCS q) or IIP
//    (OSC 1337) sequence until the addon has placed the image, painting is
//    held the way DEC mode 2026 (synchronized output) holds it, so the old
//    frame stays on screen until the new one is complete. A program that set
//    mode 2026 itself keeps control of it.

import type { Terminal } from '@xterm/xterm';
import { ImageAddon } from '@xterm/addon-image';

export interface CellSize {
  width: number;
  height: number;
}

/** The part of xterm's render dimensions the image addon reads. */
interface RenderDimensionsLike {
  css: { canvas: CellSize; cell: CellSize };
}

/** Reply to `CSI 14 t` / `CSI 16 t` in whole pixels no larger than the real
 *  cell, or `null` to leave the sequence to xterm. */
export function pixelSizeReport(
  params: readonly (number | number[])[],
  cell: CellSize,
  cols: number,
  rows: number,
): string | null {
  const width = Math.floor(cell.width);
  const height = Math.floor(cell.height);
  if (width < 1 || height < 1) return null;
  switch (params[0]) {
    case 16:
      return `\x1b[6;${height};${width}t`;
    case 14:
      // `CSI 14 ; 2 t` asks for the outer window, which xterm does not report.
      return params[1] === 2 ? null : `\x1b[4;${height * rows};${width * cols}t`;
    default:
      return null;
  }
}

/** Image-layer geometry in device pixels: the CSS geometry × devicePixelRatio.
 *  The layer canvas is rounded to whole pixels, since the addon resizes (and so
 *  clears) the canvas whenever its size differs from these. */
export function deviceDimensions(css: RenderDimensionsLike['css'], dpr: number, out: RenderDimensionsLike): void {
  out.css.canvas.width = Math.round(css.canvas.width * dpr);
  out.css.canvas.height = Math.round(css.canvas.height * dpr);
  out.css.cell.width = css.cell.width * dpr;
  out.css.cell.height = css.cell.height * dpr;
}

function isSize(value: unknown): value is CellSize {
  return value !== null && typeof value === 'object'
    && typeof Reflect.get(value, 'width') === 'number'
    && typeof Reflect.get(value, 'height') === 'number';
}

function privateChain(terminal: Terminal, keys: readonly string[]): object | null {
  let node: unknown = terminal;
  for (const key of keys) {
    if (node === null || typeof node !== 'object') return null;
    node = Reflect.get(node, key);
  }
  return node !== null && typeof node === 'object' ? node : null;
}

function cssDimensionsOf(terminal: Terminal): RenderDimensionsLike['css'] | null {
  // Private chain: Terminal._core._renderService.dimensions.css (mutated in place by xterm).
  const css = privateChain(terminal, ['_core', '_renderService', 'dimensions', 'css']);
  if (!css || !isSize(Reflect.get(css, 'canvas')) || !isSize(Reflect.get(css, 'cell'))) return null;
  return css as RenderDimensionsLike['css'];
}

/** Getter for the device-pixel dimensions. One object, refilled per call: the
 *  addon reads `cellSize` for every tile it draws. */
function deviceDimensionsReader(terminal: Terminal): () => RenderDimensionsLike | undefined {
  const out: RenderDimensionsLike = { css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } } };
  return () => {
    const css = cssDimensionsOf(terminal);
    if (!css) return undefined;
    deviceDimensions(css, terminal.element?.ownerDocument.defaultView?.devicePixelRatio || 1, out);
    return out;
  };
}

function renderImagesAtDevicePixels(addon: ImageAddon, dimensions: () => RenderDimensionsLike | undefined): void {
  // Private: ImageAddon._renderer (ImageRenderer), whose `dimensions` getter
  // every size computation in the addon goes through.
  const renderer: unknown = Reflect.get(addon, '_renderer');
  if (renderer === null || typeof renderer !== 'object' || !('dimensions' in renderer)) {
    console.warn('[krypton:xterm] image renderer not found; inline images stay at CSS-pixel resolution');
    return;
  }
  Object.defineProperty(renderer, 'dimensions', { configurable: true, get: dimensions });
}

interface DecModesLike {
  synchronizedOutput: boolean;
}

interface SequenceHandlers {
  registerDcsHandler(id: { final: string }, handler: {
    hook(): void;
    put(): void;
    unhook(): boolean;
  }): unknown;
  registerOscHandler(ident: number, handler: {
    start(): void;
    put(): void;
    end(): boolean;
  }): unknown;
}

/** Release a hold when no image data has arrived for this long. */
const IMAGE_STALL_MS = 1000;

/** Hold painting from the start of an image sequence until the addon has
 *  placed the image. Must be registered BEFORE the addon: the parser calls
 *  `unhook`/`end` newest-first and still calls the remaining (older) handlers
 *  after one has handled the sequence, including after an async IIP decode —
 *  so these run last, once the image is in the buffer. */
function holdPaintDuringImageTransfer(terminal: Terminal): void {
  // Private: Terminal._core._inputHandler._parser (the addon registers its own
  // Sixel/IIP handlers there) and Terminal._core.coreService.decPrivateModes.
  const parser = privateChain(terminal, ['_core', '_inputHandler', '_parser']);
  const modes = privateChain(terminal, ['_core', 'coreService', 'decPrivateModes']);
  if (!parser || !modes || typeof Reflect.get(parser, 'registerDcsHandler') !== 'function'
    || typeof Reflect.get(modes, 'synchronizedOutput') !== 'boolean') {
    console.warn('[krypton:xterm] parser internals not found; images may flash while they load');
    return;
  }
  const handlers = parser as SequenceHandlers;
  const decModes = modes as DecModesLike;
  let holding = false;
  let lastData = 0;
  let frame = 0;
  const release = (): boolean => {
    if (holding) {
      holding = false;
      cancelAnimationFrame(frame);
      decModes.synchronizedOutput = false;
      // Paint the rows buffered while held (same as DECRST 2026).
      terminal.refresh(0, terminal.rows - 1);
    }
    return false;
  };
  // xterm's own synchronized-output safety timer drops the hold after 1 s and
  // queues a paint, which would show the erased area mid-transfer. This
  // callback is requested a frame ahead, so it runs before that paint and takes
  // the hold back — unless the data has stopped, in which case it paints.
  const guard = (): void => {
    if (!holding) return;
    if (performance.now() - lastData > IMAGE_STALL_MS) {
      release();
      return;
    }
    decModes.synchronizedOutput = true;
    frame = requestAnimationFrame(guard);
  };
  const hold = (): void => {
    if (decModes.synchronizedOutput) return; // the program (DEC 2026) or an outer hold owns it
    decModes.synchronizedOutput = true;
    holding = true;
    lastData = performance.now();
    frame = requestAnimationFrame(guard);
  };
  const arrived = (): void => {
    if (holding) lastData = performance.now();
  };
  handlers.registerDcsHandler({ final: 'q' }, { hook: hold, put: arrived, unhook: release });
  handlers.registerOscHandler(1337, { start: hold, put: arrived, end: release });
}

/** Load the image addon and fit it to Krypton's DOM-measured, fractional cells. */
export function installInlineImages(terminal: Terminal): void {
  holdPaintDuringImageTransfer(terminal);
  const addon = new ImageAddon();
  terminal.loadAddon(addon);
  const dimensions = deviceDimensionsReader(terminal);
  renderImagesAtDevicePixels(addon, dimensions);
  terminal.parser.registerCsiHandler({ final: 't' }, (params) => {
    const windowOptions = terminal.options.windowOptions;
    const enabled = params[0] === 16 ? windowOptions?.getCellSizePixels
      : params[0] === 14 ? windowOptions?.getWinSizePixels
        : false;
    if (!enabled) return false;
    const dims = dimensions();
    const reply = dims ? pixelSizeReport(params, dims.css.cell, terminal.cols, terminal.rows) : null;
    if (reply === null) return false;
    // Same path as xterm's reports: onData → write_to_pty, ordered with DA1.
    terminal.input(reply, false);
    return true;
  });
}
