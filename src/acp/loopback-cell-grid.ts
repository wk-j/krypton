// Krypton — the harness cell grid (specs 324/326) for the Terminal Control
// monitor page (spec 330). The page is inline HTML opened in the OS browser, so
// `vite.loopback.config.ts` bundles this entry and the hook server serves it at
// `/termctrl/assets/cell-grid.js`. The page renders plain text until it loads.

import { gridifyText } from './cell-grid';

export interface LoopbackCellGrid {
  /** Lay a raw-text block out as cells when it is laid out by columns. */
  readonly gridifyText: (host: HTMLElement) => boolean;
}

declare global {
  interface Window {
    KryptonCellGrid?: LoopbackCellGrid;
  }
}

window.KryptonCellGrid = { gridifyText };
window.dispatchEvent(new Event('krypton-cell-grid-ready'));
