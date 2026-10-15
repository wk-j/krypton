// Krypton — ACP Harness image viewer overlay (spec 281).
// Keyboard-first: n/p step through the lane's images, =/- zoom, 0 fit,
// 1 actual size, hjkl pan, o open the file, Esc close. Zoom/pan are a single
// transform on the stage image (no layout per frame).
// spec 283: also zooms one ```svg card; vector content is laid out at the
// zoomed size instead of transform-scaled, so it stays sharp.
//
// Spec 302 §7.14: the markup, the zoom/pan transform and the key table are
// `ImageViewer` (`components/image-viewer`). What stays here is the imperative
// surface the view calls — `open`, `openSvg`, `close`, `refresh`, `handleKey`,
// `el` — over the one piece of state the view asks about: WHICH image is open.
// The component renders that state; it never decides it.

import { ImageViewer, type SvgViewerItem } from './components/image-viewer';
import { isOpenableImage } from './harness-images';
import type { HarnessImage } from './harness-view-types';

export type { SvgViewerItem };

export interface ImageViewerHost {
  /** Images of the active lane in transcript order (any state). */
  laneImages(): HarnessImage[];
  /** Reload a released path image; resolves true once it is live again. */
  ensureLive(image: HarnessImage): Promise<boolean>;
  openPath(path: string): void;
  /** spec 283: whether the SVG fence still exists in the active lane. */
  hasSvgFence(itemId: string, index: number): boolean;
  /** spec 283: flip the fence's card to Source (called after the viewer closed). */
  showSvgSource(itemId: string, index: number): void;
  onClose(): void;
}

export class HarnessImageViewer {
  readonly el: HTMLElement;
  private readonly viewer = new ImageViewer();
  private imageId: string | null = null;
  private svg: SvgViewerItem | null = null;

  constructor(private readonly host: ImageViewerHost) {
    this.el = this.viewer.el;
    // Paints the closed shell: the root class and `hidden`, as the hand-built
    // overlay had from its constructor.
    this.sync();
  }

  get isOpen(): boolean {
    return this.imageId !== null || this.svg !== null;
  }

  get isSvg(): boolean {
    return this.svg !== null;
  }

  get currentImageId(): string | null {
    return this.imageId;
  }

  open(imageId: string): void {
    this.svg = null;
    this.imageId = imageId;
    this.sync();
  }

  openSvg(item: SvgViewerItem): void {
    this.imageId = null;
    this.svg = item;
    this.sync();
  }

  close(): void {
    if (!this.isOpen) return;
    this.imageId = null;
    this.svg = null;
    this.sync();
    this.host.onClose();
  }

  /** Lane images changed (release, eviction, clear): repaint, advance past a
   *  vanished image, or close when nothing openable is left. */
  refresh(): void {
    if (this.svg) {
      if (!this.host.hasSvgFence(this.svg.itemId, this.svg.index)) this.close();
      return;
    }
    if (!this.imageId) return;
    const openable = this.host.laneImages().filter(isOpenableImage);
    if (!openable.some((image) => image.imageId === this.imageId)) {
      const next = openable[0];
      if (!next) {
        this.close();
        return;
      }
      // A different image: the component resets zoom/pan for it.
      this.imageId = next.imageId;
    }
    this.sync();
  }

  handleKey(e: KeyboardEvent): boolean {
    return this.viewer.handleKey(e);
  }

  dispose(): void {
    this.viewer.dispose();
  }

  private sync(): void {
    this.viewer.update({
      images: this.host.laneImages(),
      imageId: this.imageId,
      svg: this.svg,
      ensureLive: (image: HarnessImage): Promise<boolean> => this.host.ensureLive(image),
      openPath: (path: string): void => this.host.openPath(path),
      onSelect: (imageId: string): void => {
        // A CLOSED viewer never adopts an image: the component offers the first
        // openable one whenever it paints without a match, which for us is
        // simply the closed state.
        if (!this.isOpen) return;
        this.svg = null;
        this.imageId = imageId;
        this.sync();
      },
      onClose: (): void => this.close(),
      onShowSvgSource: (itemId: string, index: number): void => this.host.showSvgSource(itemId, index),
      // Another overlay took the single open slot: our state follows it down.
      onAutoClose: (): void => this.close(),
    });
  }
}
