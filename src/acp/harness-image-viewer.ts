// Krypton — ACP Harness image viewer overlay (spec 281).
// Keyboard-first: n/p step through the lane's images, =/- zoom, 0 fit,
// 1 actual size, hjkl pan, o open the file, Esc close. Zoom/pan are a single
// transform on the stage image (no layout per frame).

import type { HarnessImage } from './harness-view-types';
import { formatImageBytes, isOpenableImage } from './harness-images';

export interface ImageViewerHost {
  /** Images of the active lane in transcript order (any state). */
  laneImages(): HarnessImage[];
  /** Reload a released path image; resolves true once it is live again. */
  ensureLive(image: HarnessImage): Promise<boolean>;
  openPath(path: string): void;
  onClose(): void;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

export class HarnessImageViewer {
  readonly el: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly tile: HTMLElement;
  private readonly meta: HTMLElement;
  private imageId: string | null = null;
  private scale = 1;
  private fit = true;
  private panX = 0;
  private panY = 0;

  constructor(private readonly host: ImageViewerHost) {
    this.el = document.createElement('div');
    this.el.className = 'acp-harness__image-viewer';
    this.el.hidden = true;
    this.stage = document.createElement('div');
    this.stage.className = 'acp-harness__image-viewer-stage';
    this.img = document.createElement('img');
    this.img.className = 'acp-harness__image-viewer-img';
    this.img.alt = '';
    this.img.decoding = 'async';
    this.img.addEventListener('load', () => this.applyTransform());
    this.tile = document.createElement('div');
    this.tile.className = 'acp-harness__image-tile acp-harness__image-viewer-tile';
    this.tile.hidden = true;
    this.stage.append(this.img, this.tile);
    this.meta = document.createElement('div');
    this.meta.className = 'acp-harness__image-viewer-meta';
    this.el.append(this.stage, this.meta);
    // Mouse is secondary: a click outside the image closes.
    this.el.addEventListener('click', (e: MouseEvent) => {
      if (e.target !== this.img) this.close();
    });
  }

  get isOpen(): boolean {
    return this.imageId !== null;
  }

  get currentImageId(): string | null {
    return this.imageId;
  }

  open(imageId: string): void {
    this.imageId = imageId;
    this.el.hidden = false;
    this.show(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.imageId = null;
    this.el.hidden = true;
    this.img.removeAttribute('src');
    this.host.onClose();
  }

  /** Lane images changed (release, eviction, clear): repaint, advance past a
   *  vanished image, or close when nothing openable is left. */
  refresh(): void {
    if (!this.imageId) return;
    const openable = this.openable();
    if (openable.some((image) => image.imageId === this.imageId)) {
      this.show(false);
      return;
    }
    const next = openable[0];
    if (!next) {
      this.close();
      return;
    }
    this.imageId = next.imageId;
    this.show(true);
  }

  handleKey(e: KeyboardEvent): boolean {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey || e.altKey) return true;
    const bigPan = e.shiftKey ? 0.5 : 0.1;
    switch (e.key) {
      case 'Escape':
        this.close();
        break;
      case 'n':
        this.step(1);
        break;
      case 'p':
        this.step(-1);
        break;
      case '=':
      case '+':
        this.zoomBy(ZOOM_STEP);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / ZOOM_STEP);
        break;
      case '0':
        this.fit = true;
        this.panX = 0;
        this.panY = 0;
        this.applyTransform();
        break;
      case '1':
        this.fit = false;
        this.scale = 1;
        this.applyTransform();
        break;
      case 'h':
      case 'H':
        this.pan(bigPan, 0);
        break;
      case 'l':
      case 'L':
        this.pan(-bigPan, 0);
        break;
      case 'k':
      case 'K':
        this.pan(0, bigPan);
        break;
      case 'j':
      case 'J':
        this.pan(0, -bigPan);
        break;
      case 'o': {
        const image = this.current();
        if (image?.path) this.host.openPath(image.path);
        break;
      }
      default:
        break;
    }
    return true;
  }

  private openable(): HarnessImage[] {
    return this.host.laneImages().filter(isOpenableImage);
  }

  private current(): HarnessImage | null {
    return this.host.laneImages().find((image) => image.imageId === this.imageId) ?? null;
  }

  private step(delta: number): void {
    const openable = this.openable();
    if (openable.length === 0) {
      this.close();
      return;
    }
    const idx = openable.findIndex((image) => image.imageId === this.imageId);
    const next = openable[(Math.max(idx, 0) + delta + openable.length) % openable.length];
    this.imageId = next.imageId;
    this.show(true);
  }

  private show(resetView: boolean): void {
    const image = this.current();
    if (!image) {
      this.refresh();
      return;
    }
    if (resetView) {
      this.fit = true;
      this.panX = 0;
      this.panY = 0;
    }
    if (image.state === 'live' && image.objectUrl) {
      this.tile.hidden = true;
      this.img.hidden = false;
      if (this.img.getAttribute('src') !== image.objectUrl) this.img.src = image.objectUrl;
      this.img.alt = image.label;
      this.applyTransform();
    } else {
      this.img.hidden = true;
      this.img.removeAttribute('src');
      this.tile.hidden = false;
      const reloadable = image.state === 'released' && image.origin === 'path';
      this.tile.textContent = reloadable ? `IMG LOADING // ${image.label}` : `IMG RELEASED // ${image.label}`;
      if (reloadable) {
        const id = image.imageId;
        void this.host.ensureLive(image).then((ok) => {
          if (ok && this.imageId === id) this.show(false);
        });
      }
    }
    this.renderMeta(image);
  }

  private renderMeta(image: HarnessImage): void {
    const openable = this.openable();
    const idx = openable.findIndex((candidate) => candidate.imageId === image.imageId);
    const parts = [`${idx + 1}/${openable.length}`, image.label];
    if (this.img.naturalWidth > 0 && !this.img.hidden) {
      parts.push(`${this.img.naturalWidth}×${this.img.naturalHeight}`);
      parts.push(`${Math.round(this.effectiveScale() * 100)}%`);
    }
    if (image.bytes > 0) parts.push(formatImageBytes(image.bytes));
    this.meta.textContent = `${parts.join(' · ')}   n/p next · =/- zoom · 0 fit · 1 100% · hjkl pan${image.path ? ' · o open' : ''} · Esc close`;
  }

  private fitScale(): number {
    const width = this.img.naturalWidth;
    const height = this.img.naturalHeight;
    const rect = this.stage.getBoundingClientRect();
    if (width === 0 || height === 0 || rect.width === 0 || rect.height === 0) return 1;
    return Math.min(rect.width / width, rect.height / height, 1);
  }

  private effectiveScale(): number {
    return this.fit ? this.fitScale() : this.scale;
  }

  private zoomBy(factor: number): void {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.effectiveScale() * factor));
    this.fit = false;
    this.scale = next;
    this.applyTransform();
  }

  /** Pan by a fraction of the viewport; positive x reveals the left edge. */
  private pan(fx: number, fy: number): void {
    const rect = this.stage.getBoundingClientRect();
    this.panX += rect.width * fx;
    this.panY += rect.height * fy;
    this.applyTransform();
  }

  private applyTransform(): void {
    const scale = this.effectiveScale();
    const rect = this.stage.getBoundingClientRect();
    const maxX = Math.max(0, (this.img.naturalWidth * scale - rect.width) / 2);
    const maxY = Math.max(0, (this.img.naturalHeight * scale - rect.height) / 2);
    this.panX = Math.min(maxX, Math.max(-maxX, this.panX));
    this.panY = Math.min(maxY, Math.max(-maxY, this.panY));
    this.img.style.transform =
      `translate(-50%, -50%) translate(${this.panX}px, ${this.panY}px) scale(${scale})`;
    const image = this.current();
    if (image) this.renderMeta(image);
  }
}
