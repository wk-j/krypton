// Spec 302 §6.4 — `StagingStrip`.
//
// `[▣ screenshot.png x] [▣ diagram.png x]   2 images · Esc to clear` — the
// pasted/dropped images waiting to be sent with the next prompt. Built today by
// `acp-harness-view.ts:13259-13275`.
//
// Tiles are keyed by their CONTENT, not by their index: removing the first of
// two images must leave the second one's `<img>` alone rather than re-decoding
// a 2 MB data URL into a recycled node. The index still rides along as
// `data-remove-staged-image`, which is what the view's delegated click handler
// (`acp-harness-view.ts:6574`) reads; `onRemove` is the same signal for a
// composer that owns its own clicks.
//
// With no images the strip is `hidden` instead of absent: today the builder
// returns `''` and no node exists at all, and `.acp-harness__staging` carries
// `display: flex` and vertical padding, so an empty root left visible would add
// blank space where there was none.

import './staging-strip.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { basename } from '../../harness-format';
import type { StagedImage } from '../../harness-view-types';
import type { ComponentDef } from '../types';

export interface StagingStripProps {
  readonly images: readonly StagedImage[];
  /** Click on a tile's remove button. Not a dependency. */
  readonly onRemove?: (index: number) => void;
}

interface TileProps {
  readonly image: StagedImage;
  readonly index: number;
}

class StagedTile extends Component<TileProps> {
  private readonly thumb: HTMLImageElement;
  private readonly labelEl: HTMLElement;
  private readonly removeEl: HTMLButtonElement;

  constructor() {
    super(el('div', { class: 'acp-harness__staged-image' }));
    this.thumb = el('img', { class: 'acp-harness__staged-thumb', attrs: { alt: '' } });
    this.labelEl = el('span', { class: 'acp-harness__staged-label' });
    this.removeEl = el('button', {
      class: 'acp-harness__staged-remove',
      attrs: { type: 'button' },
      title: 'Remove image',
      text: 'x',
    });
    this.el.append(this.thumb, this.labelEl, this.removeEl);
  }

  protected readDeps(next: TileProps): readonly unknown[] {
    return [next.image.mimeType, next.image.data, next.image.path, next.index];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__staged-image';
    this.thumb.className = 'acp-harness__staged-thumb';
    this.labelEl.className = 'acp-harness__staged-label';
    this.removeEl.className = 'acp-harness__staged-remove';
  }

  protected paint(next: TileProps): void {
    this.syncClasses();
    const src = `data:${next.image.mimeType};base64,${next.image.data}`;
    if (this.thumb.getAttribute('src') !== src) setAttr(this.thumb, 'src', src);
    this.labelEl.textContent = next.image.path ? basename(next.image.path) : next.image.mimeType;
    setAttr(this.removeEl, 'data-remove-staged-image', next.index);
  }
}

/** Content identity, with a counter so two pastes of the same image are two
 *  stable keys rather than a reconciler collision. */
function tileKeys(images: readonly StagedImage[]): string[] {
  const seen = new Map<string, number>();
  return images.map((image) => {
    const base = image.path ?? `${image.mimeType}\u0001${image.data}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

export class StagingStrip extends Component<StagingStripProps> {
  private readonly hintEl: HTMLElement;
  private readonly tiles = new Map<string, StagedTile>();
  private remove: ((index: number) => void) | undefined;

  constructor() {
    super(el('div', { class: 'acp-harness__staging' }));
    this.hintEl = el('span', { class: 'acp-harness__staging-hint' });
    this.el.appendChild(this.hintEl);
    // ONE delegated listener for every tile, now and later.
    this.bag.listen(this.el, 'click', (event: Event): void => {
      if (!this.remove || !(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLElement>('[data-remove-staged-image]');
      if (!button || !this.el.contains(button)) return;
      const index = Number(button.dataset.removeStagedImage);
      if (!Number.isInteger(index)) return;
      event.preventDefault();
      this.remove(index);
    });
  }

  update(next: StagingStripProps): void {
    this.remove = next.onRemove;
    super.update(next);
  }

  protected readDeps(next: StagingStripProps): readonly unknown[] {
    return [
      next.images.map((image) => `${image.path ?? ''}\u0001${image.mimeType}\u0001${image.data}`).join('\u0002'),
    ];
  }

  protected syncClasses(next: StagingStripProps): void {
    this.el.className = 'acp-harness__staging';
    this.el.hidden = next.images.length === 0;
  }

  protected paint(next: StagingStripProps): void {
    this.syncClasses(next);
    const keys = tileKeys(next.images);
    const nodes: HTMLElement[] = [];
    for (let i = 0; i < next.images.length; i++) {
      const key = keys[i];
      let tile = this.tiles.get(key);
      if (!tile) {
        tile = new StagedTile();
        this.tiles.set(key, tile);
      }
      tile.update({ image: next.images[i], index: i });
      nodes.push(tile.el);
    }
    const live = new Set(keys);
    for (const [key, tile] of this.tiles) {
      if (live.has(key)) continue;
      tile.dispose();
      this.tiles.delete(key);
    }
    const count = next.images.length;
    this.hintEl.textContent = `${count} image${count === 1 ? '' : 's'} · Esc to clear`;
    nodes.push(this.hintEl);
    syncOrder(this.el, nodes);
  }

  protected onDispose(): void {
    for (const tile of this.tiles.values()) tile.dispose();
    this.tiles.clear();
  }
}

export const def: ComponentDef = {
  id: 'staging-strip',
  blocks: [
    'acp-harness__staging',
    'acp-harness__staged-image',
    'acp-harness__staged-thumb',
    'acp-harness__staged-label',
    'acp-harness__staged-remove',
    'acp-harness__staging-hint',
  ],
};
