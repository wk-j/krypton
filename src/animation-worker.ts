// Krypton — Animation Web Worker
// Receives an OffscreenCanvas and runs background animation rendering off the
// main thread. PTY output processing on the main thread cannot starve these
// animations because they run in their own rAF loop here.

import { FlameRenderer } from './flame';
import { MatrixRenderer } from './matrix';
import { BrainwaveRenderer } from './brainwave';
import { CircuitTraceRenderer } from './circuit-trace';

type AnimationType = 'flame' | 'matrix' | 'brainwave' | 'circuit-trace';

interface Renderer {
  init(W: number, H: number): void;
  update(ctx: OffscreenCanvasRenderingContext2D, W: number, H: number): void;
}

type WorkerMessage =
  | { type: 'init'; animation: AnimationType; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'dispose' }
  | { type: 'fft'; bins: number[] };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let renderer: Renderer | null = null;
let running = false;
let rafId = 0;
let W = 0;
let H = 0;
let dpr = 1;

function createRenderer(type: AnimationType): Renderer {
  switch (type) {
    case 'matrix': return new MatrixRenderer();
    case 'brainwave': return new BrainwaveRenderer();
    case 'circuit-trace': return new CircuitTraceRenderer();
    default: return new FlameRenderer();
  }
}

function tick(): void {
  if (!running || !ctx) return;
  ctx.clearRect(0, 0, W, H);
  renderer!.update(ctx, W, H);
  rafId = requestAnimationFrame(tick);
}

function applySize(w: number, h: number, devicePixelRatio: number): void {
  W = w;
  H = h;
  dpr = devicePixelRatio;
  if (canvas && ctx) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  renderer?.init(W, H);
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      canvas = msg.canvas;
      ctx = canvas.getContext('2d');
      renderer = createRenderer(msg.animation);
      if (msg.width > 0 && msg.height > 0) {
        applySize(msg.width, msg.height, msg.dpr);
      }
      break;

    case 'start':
      if (!running) {
        running = true;
        tick();
      }
      break;

    case 'stop':
      running = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      break;

    case 'resize':
      applySize(msg.width, msg.height, msg.dpr);
      break;

    case 'fft':
      // Forward FFT bins to the circuit-trace renderer
      if (renderer && 'setFftBins' in renderer) {
        (renderer as CircuitTraceRenderer).setFftBins(msg.bins);
      }
      break;

    case 'dispose':
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      canvas = null;
      ctx = null;
      renderer = null;
      self.close();
      break;
  }
};
