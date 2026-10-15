// Spec 302 §3.15 — `ImageStrip`.
//
// The thumbnail strip beneath a row body (spec 281). Scanned path images that
// are still loading stay hidden until they resolve, and an image already shown
// in the REFERENCES rail is skipped (spec 286).
//
// Late thumbnail state patches ONLY this component: the owning row's deps do
// not include the image list, so a decoded thumbnail never repaints the row.

import './image-strip.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { formatImageBytes } from '../../harness-images';
import { railCoversImage } from '../../message-resource-thumb';
import type { HarnessImage, HarnessTranscriptItem } from '../../harness-view-types';
import type { ComponentDef } from '../types';

export interface ImageStripProps {
  readonly item: HarnessTranscriptItem;
}

/** The images this strip paints — scanned-and-loading and rail-covered removed. */
export function visibleStripImages(item: HarnessTranscriptItem): readonly HarnessImage[] {
  return (item.images ?? []).filter(
    (image) => !(image.discovery === 'scanned' && image.state === 'loading') && !railCoversImage(item, image),
  );
}

/** Identity of everything the strip paints, for the owner's dep tuple. */
export function imageStripSignature(item: HarnessTranscriptItem): string {
  const images = visibleStripImages(item)
    .map((image) => `${image.imageId}:${image.state}:${image.hintLabel ?? ''}:${image.objectUrl ?? ''}`)
    .join(',');
  return `${images}|${item.imageOverflow ?? 0}`;
}

function tileText(image: HarnessImage): string {
  const size = image.bytes > 0 ? ` ${formatImageBytes(image.bytes)}` : '';
  switch (image.state) {
    case 'loading':
      return `IMG LOADING // ${image.label}`;
    case 'released':
      return `IMG RELEASED // ${image.label}${size}`;
    case 'missing':
      return `IMG MISSING // ${image.path ?? image.label}`;
    default:
      return `IMG REJECTED // ${image.rejectReason ?? image.mimeType ?? 'unknown'}${size}`;
  }
}

export class ImageStrip extends Component<ImageStripProps> {
  constructor() {
    super(el('div', { class: 'acp-harness__images' }));
  }

  /** True when there is nothing to show; the owner hides the strip. */
  static isEmpty(item: HarnessTranscriptItem): boolean {
    return visibleStripImages(item).length === 0 && (item.imageOverflow ?? 0) === 0;
  }

  protected readDeps(next: ImageStripProps): readonly unknown[] {
    return [imageStripSignature(next.item)];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__images';
  }

  protected paint(next: ImageStripProps): void {
    this.syncClasses();
    const images = visibleStripImages(next.item);
    const overflow = next.item.imageOverflow ?? 0;
    const children: HTMLElement[] = [];
    for (const image of images) {
      children.push(image.state === 'live' && image.objectUrl ? liveThumb(image) : stateTile(image));
    }
    if (overflow > 0) {
      children.push(
        el('div', { class: 'acp-harness__image-tile acp-harness__image-tile--overflow', text: `+${overflow} more` }),
      );
    }
    this.el.replaceChildren(...children);
  }
}

function liveThumb(image: HarnessImage): HTMLElement {
  const figure = el('figure', {
    class: ['acp-harness__image-thumb', image.hintLabel ? 'acp-harness__image-thumb--hinted' : null],
    data: { imageId: image.imageId },
    title: image.path ?? image.label,
  });
  const img = el('img', { attrs: { src: image.objectUrl ?? '', alt: image.label, decoding: 'async', loading: 'lazy' } });
  const caption = el('figcaption', { text: `${image.label} · ${formatImageBytes(image.bytes)}` });
  figure.append(img, caption);
  if (image.hintLabel) {
    figure.appendChild(el('span', { class: 'acp-harness__image-hint', text: image.hintLabel }));
  }
  return figure;
}

function stateTile(image: HarnessImage): HTMLElement {
  const tile = el('div', {
    class: `acp-harness__image-tile acp-harness__image-tile--${image.state}`,
    title: image.path ?? image.label,
  });
  if (image.state === 'released' && image.origin === 'path') {
    tile.dataset.imageId = image.imageId;
    if (image.hintLabel) {
      tile.appendChild(el('span', { class: 'acp-harness__image-hint', text: image.hintLabel }));
    }
  }
  tile.append(tileText(image));
  return tile;
}

export const def: ComponentDef = {
  id: 'image-strip',
  blocks: [
    'acp-harness__images',
    'acp-harness__image-thumb',
    'acp-harness__image-tile',
    'acp-harness__image-hint',
  ],
};
