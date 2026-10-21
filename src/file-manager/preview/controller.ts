// Krypton — File Manager preview timing (spec 317).
//
// One 80 ms debounce shared by both sources, a generation counter that
// discards stale async results, and the cursor-only `lastPreviewPath` skip.

import type { PreviewOutput } from '../types';
import { PREVIEW_RENDERERS, renderPreview, type PreviewIO, type PreviewRenderer, type PreviewTarget } from './registry';

export const PREVIEW_DEBOUNCE_MS = 80;

export interface PreviewSink {
  /** Paint an output into the pane. */
  show(output: PreviewOutput): void;
  /** `previewEl.scrollTop = 0` on a new cursor preview. */
  resetScroll(): void;
}

export class PreviewController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private lastPreviewPath: string | null = null;

  constructor(
    private readonly sink: PreviewSink,
    private readonly io: (t: PreviewTarget) => PreviewIO,
    private readonly renderers: readonly PreviewRenderer[] = PREVIEW_RENDERERS,
  ) {}

  /**
   * Cursor preview (`o`, `l` on a file, search select). The target is read when
   * the debounce fires, not when requested — as the old `loadPreviewNow()` did.
   */
  requestCursor(getTarget: () => PreviewTarget | null): void {
    this.schedule(() => void this.runCursor(getTarget()));
  }

  /** Search preview: forgets `lastPreviewPath`; no skip, no scroll reset. */
  requestSearch(target: PreviewTarget): void {
    this.lastPreviewPath = null;
    this.schedule(() => void this.runSearch(target));
  }

  /** Directory change: forget the path and blank the pane. Does NOT bump the generation (quirk P9). */
  clear(): void {
    this.lastPreviewPath = null;
    this.sink.show({ kind: 'text', text: '' });
  }

  /** Forget the last path without painting (search select). */
  forgetPath(): void {
    this.lastPreviewPath = null;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(run: () => void): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runCursor(t: PreviewTarget | null): Promise<void> {
    if (!t) {
      this.sink.show({ kind: 'text', text: '' });
      this.lastPreviewPath = null;
      return;
    }
    // Skip if we already previewed this exact path
    if (t.path === this.lastPreviewPath) return;
    this.lastPreviewPath = t.path;
    this.sink.resetScroll();
    // Bump generation so any in-flight async preview is discarded
    const gen = ++this.generation;
    const out = await renderPreview(t, this.io(t), this.renderers);
    if (gen !== this.generation) return;
    this.sink.show(out);
  }

  private async runSearch(t: PreviewTarget): Promise<void> {
    const gen = ++this.generation;
    const out = await renderPreview(t, this.io(t), this.renderers);
    if (gen !== this.generation) return;
    this.sink.show(out);
  }
}
