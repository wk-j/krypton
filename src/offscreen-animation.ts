// Krypton — OffscreenCanvas Animation Proxy
// Implements BackgroundAnimation but delegates all rendering to a Web Worker
// via OffscreenCanvas. The main thread only sends lightweight control messages.

import type { BackgroundAnimation } from './flame';

type AnimationType = 'flame' | 'matrix' | 'brainwave' | 'circuit-trace';

const FADE_DURATION = 600;
const BASE_OPACITY: Record<AnimationType, string> = {
  flame: '0.25',
  matrix: '0.25',
  brainwave: '0.22',
  'circuit-trace': '0.18',
};

const CANVAS_CLASS: Record<AnimationType, string> = {
  flame: 'krypton-flame-canvas',
  matrix: 'krypton-matrix-canvas',
  brainwave: 'krypton-brainwave-canvas',
  'circuit-trace': 'krypton-circuit-trace-canvas',
};

export class OffscreenAnimationProxy implements BackgroundAnimation {
  private canvas: HTMLCanvasElement;
  private worker: Worker;
  private running = false;
  private animationType: AnimationType;

  constructor(animationType: AnimationType) {
    this.animationType = animationType;
    this.canvas = document.createElement('canvas');
    this.canvas.className = CANVAS_CLASS[animationType];

    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker = new Worker(
      new URL('./animation-worker.ts', import.meta.url),
      { type: 'module' }
    );

    const dpr = window.devicePixelRatio || 1;
    this.worker.postMessage(
      { type: 'init', animation: animationType, canvas: offscreen, width: 0, height: 0, dpr },
      [offscreen]
    );
  }

  getElement(): HTMLCanvasElement {
    return this.canvas;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.worker.postMessage({ type: 'start' });

    // Fade in via CSS on the main-thread canvas element
    this.canvas.style.opacity = '0';
    this.canvas.style.display = 'block';
    requestAnimationFrame(() => {
      this.canvas.style.transition = `opacity ${FADE_DURATION}ms ease-in`;
      this.canvas.style.opacity = BASE_OPACITY[this.animationType];
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.worker.postMessage({ type: 'stop' });

    this.canvas.style.transition = `opacity ${FADE_DURATION}ms ease-out`;
    this.canvas.style.opacity = '0';
    setTimeout(() => {
      if (!this.running) {
        this.canvas.style.display = 'none';
      }
    }, FADE_DURATION + 50);
  }

  isRunning(): boolean {
    return this.running;
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = parent.getBoundingClientRect();
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.worker.postMessage({ type: 'resize', width: rect.width, height: rect.height, dpr });
  }

  /** Forward FFT frequency bins to the worker (for circuit-trace visualizer) */
  sendFftData(bins: number[]): void {
    this.worker.postMessage({ type: 'fft', bins });
  }

  /** Set canvas opacity (e.g., from config) */
  setOpacity(opacity: number): void {
    if (this.running) {
      this.canvas.style.opacity = String(opacity);
    }
  }

  dispose(): void {
    this.running = false;
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
    this.canvas.remove();
  }
}

/** Feature-detect OffscreenCanvas + transferControlToOffscreen support */
export function supportsOffscreenCanvas(): boolean {
  return typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
}
