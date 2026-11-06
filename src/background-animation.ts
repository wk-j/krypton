// Krypton — shared contract for canvas animations mounted in window chrome or
// content (header scope, music visualizer, program-status fire).

/** Common interface for all background animations */
export interface BackgroundAnimation {
  getElement(): HTMLCanvasElement;
  start(): void;
  stop(): void;
  resize(): void;
  dispose(): void;
  isRunning(): boolean;
}

/** Render context type — works for both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D */
export type RenderCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
