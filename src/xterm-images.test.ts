import { describe, expect, it } from 'vitest';

import { deviceDimensions, pixelSizeReport } from './xterm-images';

describe('pixelSizeReport', () => {
  it('never reports a cell larger than the rendered one, so images stay inside their cells', () => {
    // Share Tech Mono 16px, line height 1.2: xterm's own report rounds this to 9 × 22.
    expect(pixelSizeReport([16], { width: 8.64, height: 21.6 }, 100, 40)).toBe('\x1b[6;21;8t');
    expect(pixelSizeReport([16], { width: 9, height: 18 }, 100, 40)).toBe('\x1b[6;18;9t');
  });

  it('reports the text area as cols × rows of the same whole-pixel cell', () => {
    expect(pixelSizeReport([14], { width: 8.64, height: 21.6 }, 59, 40)).toBe('\x1b[4;840;472t');
  });

  it('leaves sequences xterm does not answer, and unmeasured cells, to xterm', () => {
    expect(pixelSizeReport([14, 2], { width: 8.64, height: 21.6 }, 100, 40)).toBeNull();
    expect(pixelSizeReport([18], { width: 8.64, height: 21.6 }, 100, 40)).toBeNull();
    expect(pixelSizeReport([16], { width: 0, height: 0 }, 100, 40)).toBeNull();
  });
});

describe('deviceDimensions', () => {
  const blank = (): Parameters<typeof deviceDimensions>[2] => ({
    css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } },
  });

  it('scales cells to device pixels, so a 2× screen gets 2× image detail', () => {
    const out = blank();
    deviceDimensions({ canvas: { width: 864, height: 864 }, cell: { width: 8.64, height: 21.6 } }, 2, out);
    expect(out.css.cell).toEqual({ width: 17.28, height: 43.2 });
    expect(pixelSizeReport([16], out.css.cell, 100, 40)).toBe('\x1b[6;43;17t');
  });

  it('keeps the layer canvas whole-pixel at fractional ratios, or the addon would clear it on every paint', () => {
    const out = blank();
    deviceDimensions({ canvas: { width: 509, height: 862 }, cell: { width: 8.627, height: 21.55 } }, 1.25, out);
    expect(Number.isInteger(out.css.canvas.width)).toBe(true);
    expect(Number.isInteger(out.css.canvas.height)).toBe(true);
    expect(out.css.canvas).toEqual({ width: 636, height: 1078 });
  });
});
