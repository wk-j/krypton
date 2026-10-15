// Spec 302 §7.14 — `ImageViewer`.
//
// The full-bleed image / SVG viewer (spec 281/283, `harness-image-viewer.ts`).
// Keyboard-first: n/p step, =/- zoom, 0 fit, 1 actual size, hjkl pan, o open,
// s source (SVG), Esc close. Zoom and pan are one transform on the stage image,
// never a layout per frame.
//
// What moves and what does not: WHICH image is open is render state and is now
// a prop, so the owner's "open image" and the viewer agree by construction.
// Zoom / pan / fit stay inside the component — no owner reads them, and a
// repaint for an unrelated lane image must not reset the view.
//
// Full-bleed: the shell's head carries no title here and is hidden by this
// directory's sheet; the viewer's own meta line is its chrome.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { formatImageBytes, isOpenableImage } from '../../harness-images';
import type { HarnessImage } from '../../harness-view-types';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './image-viewer.css';

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

/** spec 283: an SVG fence shown in the viewer; not part of the lane image list. */
export interface SvgViewerItem {
  readonly itemId: string;
  readonly index: number;
  readonly label: string;
  /** Themed `data:image/svg+xml` URL. */
  readonly src: string;
  /** 100% size, from `svgBaseSize`. */
  readonly width: number;
  readonly height: number;
}

export interface ImageViewerProps {
  /** Images of the active lane in transcript order (any state). */
  readonly images: readonly HarnessImage[];
  /** The open bitmap, or null. Mutually exclusive with `svg`. */
  readonly imageId: string | null;
  /** The open SVG fence, or null. */
  readonly svg: SvgViewerItem | null;
  /** Reload a released path image; resolves true once it is live again. */
  ensureLive(image: HarnessImage): Promise<boolean>;
  openPath(path: string): void;
  /** `n`/`p` stepped to another image, or the open one vanished. */
  onSelect(imageId: string): void;
  onClose(): void;
  /** `s`: flip the fence's card to Source, after the viewer closed. */
  onShowSvgSource(itemId: string, index: number): void;
  onAutoClose?(): void;
}

export class ImageViewer extends Component<ImageViewerProps> {
  private readonly shell: OverlayShell;
  private readonly stage: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly tile: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly body: HTMLElement;
  private props: ImageViewerProps | null = null;
  private scale = 1;
  private fit = true;
  private panX = 0;
  private panY = 0;
  /** The target the current view state belongs to; a new one resets it. */
  private viewKey: string | null = null;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.img = el('img', { class: 'acp-harness__image-viewer-img', attrs: { alt: '', decoding: 'async' } });
    this.tile = el('div', { class: 'acp-harness__image-tile acp-harness__image-viewer-tile' });
    this.tile.hidden = true;
    this.stage = el('div', { class: 'acp-harness__image-viewer-stage' }, this.img, this.tile);
    this.meta = el('div', { class: 'acp-harness__image-viewer-meta' });
    this.body = el('div', { class: 'acp-harness__image-viewer-body' }, this.stage, this.meta);

    this.bag.listen(this.img, 'load', () => this.applyTransform());
    // Mouse is secondary: a click outside the image closes.
    this.bag.listen(this.el, 'click', (event: Event) => {
      if (event.target !== this.img) this.props?.onClose();
    });
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  update(next: ImageViewerProps): void {
    this.props = next;
    super.update(next);
  }

  protected readDeps(next: ImageViewerProps): readonly unknown[] {
    const image = next.images.find((candidate) => candidate.imageId === next.imageId) ?? null;
    return [
      next.imageId,
      next.svg?.itemId ?? null,
      next.svg?.index ?? null,
      next.svg?.src ?? null,
      image?.state ?? null,
      image?.objectUrl ?? null,
      image?.label ?? null,
      image?.bytes ?? null,
      next.images.filter(isOpenableImage).length,
    ];
  }

  protected syncClasses(_next: ImageViewerProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: ImageViewerProps): void {
    const key = next.svg ? `svg:${next.svg.itemId}:${next.svg.index}` : next.imageId;
    const changed = key !== this.viewKey;
    this.viewKey = key;
    if (changed) this.resetView();

    this.shell.update({
      open: next.svg !== null || next.imageId !== null,
      name: 'image-viewer',
      block: 'acp-harness__image-viewer',
      title: '',
      body: this.body,
      onAutoClose: next.onAutoClose,
    });

    if (next.svg) {
      this.showSvg(next.svg);
      return;
    }
    this.showImage(next);
  }

  /** `handleKey` consumes every key while the viewer is open, as today. */
  handleKey(event: KeyboardEvent): boolean {
    event.preventDefault();
    if (event.metaKey || event.ctrlKey || event.altKey) return true;
    const props = this.props;
    if (!props) return true;
    const bigPan = event.shiftKey ? 0.5 : 0.1;
    switch (event.key) {
      case 'Escape':
        props.onClose();
        break;
      case 'n':
        if (!props.svg) this.step(props, 1);
        break;
      case 'p':
        if (!props.svg) this.step(props, -1);
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
        this.resetView();
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
        const image = this.current(props);
        if (image?.path) props.openPath(image.path);
        break;
      }
      case 's': {
        if (!props.svg) break;
        const { itemId, index } = props.svg;
        props.onClose();
        props.onShowSvgSource(itemId, index);
        break;
      }
      default:
        break;
    }
    return true;
  }

  private current(props: ImageViewerProps): HarnessImage | null {
    return props.images.find((image) => image.imageId === props.imageId) ?? null;
  }

  private step(props: ImageViewerProps, delta: number): void {
    const openable = props.images.filter(isOpenableImage);
    if (openable.length === 0) {
      props.onClose();
      return;
    }
    const index = openable.findIndex((image) => image.imageId === props.imageId);
    const next = openable[(Math.max(index, 0) + delta + openable.length) % openable.length];
    props.onSelect(next.imageId);
  }

  private showImage(props: ImageViewerProps): void {
    const image = this.current(props);
    if (!image) {
      // The open image left the lane: advance to the first still-openable one,
      // or tell the owner there is nothing left to show.
      const next = props.images.filter(isOpenableImage)[0];
      if (next) props.onSelect(next.imageId);
      else if (props.imageId !== null) props.onClose();
      return;
    }
    if (image.state === 'live' && image.objectUrl) {
      this.tile.hidden = true;
      this.img.hidden = false;
      this.clearSvgSize();
      if (this.img.getAttribute('src') !== image.objectUrl) this.img.src = image.objectUrl;
      this.img.alt = image.label;
      this.applyTransform();
    } else {
      this.img.hidden = true;
      this.img.removeAttribute('src');
      this.tile.hidden = false;
      const reloadable = image.state === 'released' && image.origin === 'path';
      this.tile.textContent = reloadable
        ? `IMG LOADING // ${image.label}`
        : `IMG RELEASED // ${image.label}`;
      if (reloadable) {
        const id = image.imageId;
        void props.ensureLive(image).then((ok) => {
          if (ok && this.props?.imageId === id) this.showImage(this.props);
        });
      }
    }
    this.renderMeta(props, image);
  }

  private showSvg(svg: SvgViewerItem): void {
    this.tile.hidden = true;
    this.img.hidden = false;
    this.img.alt = svg.label;
    if (this.img.getAttribute('src') !== svg.src) this.img.src = svg.src;
    this.applyTransform();
  }

  private renderMeta(props: ImageViewerProps, image: HarnessImage): void {
    const openable = props.images.filter(isOpenableImage);
    const index = openable.findIndex((candidate) => candidate.imageId === image.imageId);
    const parts = [`${index + 1}/${openable.length}`, image.label];
    if (this.img.naturalWidth > 0 && !this.img.hidden) {
      parts.push(`${this.img.naturalWidth}×${this.img.naturalHeight}`);
      parts.push(`${Math.round(this.effectiveScale() * 100)}%`);
    }
    if (image.bytes > 0) parts.push(formatImageBytes(image.bytes));
    this.meta.textContent = `${parts.join(' · ')}   n/p next · =/- zoom · 0 fit · 1 100% · hjkl pan`
      + `${image.path ? ' · o open' : ''} · Esc close`;
  }

  private renderSvgMeta(svg: SvgViewerItem): void {
    const size = `${Math.round(svg.width)}×${Math.round(svg.height)}`;
    const zoom = `${Math.round(this.effectiveScale() * 100)}%`;
    this.meta.textContent = `${svg.label} · ${size} · ${zoom}   =/- zoom · 0 fit · 1 100% · hjkl pan · s source · Esc close`;
  }

  private resetView(): void {
    this.fit = true;
    this.panX = 0;
    this.panY = 0;
  }

  /** 100% size: the SVG's declared size, else the decoded bitmap's. */
  private baseSize(): { width: number; height: number } {
    const svg = this.props?.svg;
    if (svg) return { width: svg.width, height: svg.height };
    return { width: this.img.naturalWidth, height: this.img.naturalHeight };
  }

  private fitScale(): number {
    const { width, height } = this.baseSize();
    const rect = this.stage.getBoundingClientRect();
    if (width === 0 || height === 0 || rect.width === 0 || rect.height === 0) return 1;
    // Bitmaps never upscale to fit; vectors fill the stage.
    const cap = this.props?.svg ? Infinity : 1;
    return Math.min(rect.width / width, rect.height / height, cap);
  }

  private effectiveScale(): number {
    return this.fit ? this.fitScale() : this.scale;
  }

  private zoomBy(factor: number): void {
    // A small vector can fit above ZOOM_MAX; measure its ceiling from the fit so
    // `=` never zooms out.
    const max = this.props?.svg ? ZOOM_MAX * Math.max(1, this.fitScale()) : ZOOM_MAX;
    this.scale = Math.min(max, Math.max(ZOOM_MIN, this.effectiveScale() * factor));
    this.fit = false;
    this.applyTransform();
  }

  /** Pan by a fraction of the viewport; positive x reveals the left edge. */
  private pan(fx: number, fy: number): void {
    const rect = this.stage.getBoundingClientRect();
    this.panX += rect.width * fx;
    this.panY += rect.height * fy;
    this.applyTransform();
  }

  private clearSvgSize(): void {
    this.img.style.width = '';
    this.img.style.height = '';
  }

  private applyTransform(): void {
    const scale = this.effectiveScale();
    const { width, height } = this.baseSize();
    const rect = this.stage.getBoundingClientRect();
    const maxX = Math.max(0, (width * scale - rect.width) / 2);
    const maxY = Math.max(0, (height * scale - rect.height) / 2);
    this.panX = Math.min(maxX, Math.max(-maxX, this.panX));
    this.panY = Math.min(maxY, Math.max(-maxY, this.panY));
    const shift = `translate(-50%, -50%) translate(${this.panX}px, ${this.panY}px)`;
    const svg = this.props?.svg;
    if (svg) {
      // A transform would scale the 100% raster and blur; lay out at the zoomed
      // size instead.
      this.img.style.width = `${width * scale}px`;
      this.img.style.height = `${height * scale}px`;
      this.img.style.transform = shift;
      this.renderSvgMeta(svg);
      return;
    }
    this.img.style.transform = `${shift} scale(${scale})`;
    const image = this.props ? this.current(this.props) : null;
    if (image && this.props) this.renderMeta(this.props, image);
  }

  protected onDispose(): void {
    this.shell.dispose();
  }
}

export const def: ComponentDef = {
  id: 'image-viewer',
  blocks: ['acp-harness__image-viewer-overlay', 'acp-harness__image-viewer'],
};
