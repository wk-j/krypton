import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HarnessImage } from '../../harness-view-types';
import { ImageViewer, type ImageViewerProps } from './index';

const viewers: ImageViewer[] = [];

const image = (over: Partial<HarnessImage> & { imageId: string }): HarnessImage => ({
  itemId: 'row-1',
  origin: 'bytes',
  path: null,
  discovery: 'explicit',
  state: 'live',
  mimeType: 'image/png',
  bytes: 2048,
  objectUrl: `blob:${over.imageId}`,
  label: `${over.imageId}.png`,
  source: 'agent',
  key: `k-${over.imageId}`,
  hintLabel: null,
  ...over,
});

const props = (over: Partial<ImageViewerProps> = {}): ImageViewerProps => ({
  images: [image({ imageId: 'a' }), image({ imageId: 'b' })],
  imageId: 'a',
  svg: null,
  ensureLive: async () => false,
  openPath: () => undefined,
  onSelect: () => undefined,
  onClose: () => undefined,
  onShowSvgSource: () => undefined,
  ...over,
});

const mount = (over: Partial<ImageViewerProps> = {}): ImageViewer => {
  const viewer = new ImageViewer();
  viewers.push(viewer);
  viewer.update(props(over));
  return viewer;
};

const key = (k: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: k, cancelable: true, ...init });

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.dispose();
});

describe('ImageViewer', () => {
  it('emits the full-bleed stage and the meta line for the open image', () => {
    const viewer = mount();
    expect(viewer.el.className).toBe('acp-harness__image-viewer-overlay');
    expect(viewer.el.hidden).toBe(false);
    const img = viewer.el.querySelector<HTMLImageElement>('.acp-harness__image-viewer-img');
    expect(img?.getAttribute('src')).toBe('blob:a');
    expect(img?.alt).toBe('a.png');
    expect(viewer.el.querySelector('.acp-harness__image-viewer-meta')?.textContent)
      .toBe('1/2 · a.png · 2 KB   n/p next · =/- zoom · 0 fit · 1 100% · hjkl pan · Esc close');
  });

  it('stays hidden while nothing is open', () => {
    const viewer = mount({ imageId: null });
    expect(viewer.el.hidden).toBe(true);
  });

  it('shows the released tile instead of the image, and asks for a reload', async () => {
    const ensureLive = vi.fn(async () => false);
    const viewer = mount({
      images: [image({ imageId: 'a', state: 'released', origin: 'path', path: '/tmp/a.png', objectUrl: null })],
      ensureLive,
    });
    const tile = viewer.el.querySelector<HTMLElement>('.acp-harness__image-viewer-tile');
    expect(tile?.hidden).toBe(false);
    expect(tile?.textContent).toBe('IMG LOADING // a.png');
    expect(viewer.el.querySelector<HTMLImageElement>('.acp-harness__image-viewer-img')?.hidden).toBe(true);
    expect(ensureLive).toHaveBeenCalledTimes(1);
  });

  it('steps to the next openable image through the owner, not by itself', () => {
    const onSelect = vi.fn();
    const viewer = mount({ onSelect });
    viewer.handleKey(key('n'));
    expect(onSelect).toHaveBeenCalledWith('b');
    viewer.handleKey(key('p'));
    expect(onSelect).toHaveBeenLastCalledWith('b');
  });

  it('closes on Escape and on a click outside the image', () => {
    const onClose = vi.fn();
    const viewer = mount({ onClose });
    viewer.handleKey(key('Escape'));
    expect(onClose).toHaveBeenCalledTimes(1);
    viewer.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('opens the backing file only when the image has a path', () => {
    const openPath = vi.fn();
    const viewer = mount({ openPath });
    viewer.handleKey(key('o'));
    expect(openPath).not.toHaveBeenCalled();
    viewer.update(props({ images: [image({ imageId: 'a', path: '/tmp/a.png' })], openPath }));
    viewer.handleKey(key('o'));
    expect(openPath).toHaveBeenCalledWith('/tmp/a.png');
  });

  it('zooms with = and resets to fit with 0, writing the transform on the image', () => {
    const viewer = mount();
    const img = viewer.el.querySelector<HTMLImageElement>('.acp-harness__image-viewer-img');
    viewer.handleKey(key('1'));
    expect(img?.style.transform).toContain('scale(1)');
    viewer.handleKey(key('='));
    expect(img?.style.transform).toContain('scale(1.25)');
    viewer.handleKey(key('0'));
    expect(img?.style.transform).toContain('scale(1)');
  });

  it('lays an SVG fence out at its zoomed size instead of scaling it', () => {
    const viewer = mount({
      imageId: null,
      svg: { itemId: 'row-9', index: 0, label: 'flow.svg', src: 'data:image/svg+xml,x', width: 200, height: 100 },
    });
    const img = viewer.el.querySelector<HTMLImageElement>('.acp-harness__image-viewer-img');
    expect(img?.getAttribute('src')).toBe('data:image/svg+xml,x');
    expect(img?.style.width).toBe('200px');
    expect(img?.style.transform).not.toContain('scale(');
    expect(viewer.el.querySelector('.acp-harness__image-viewer-meta')?.textContent)
      .toBe('flow.svg · 200×100 · 100%   =/- zoom · 0 fit · 1 100% · hjkl pan · s source · Esc close');
  });

  it('closes before handing the fence back for its Source flip', () => {
    const onClose = vi.fn();
    const onShowSvgSource = vi.fn();
    const viewer = mount({
      imageId: null,
      svg: { itemId: 'row-9', index: 2, label: 'flow.svg', src: 'data:x', width: 10, height: 10 },
      onClose,
      onShowSvgSource,
    });
    viewer.handleKey(key('s'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onShowSvgSource).toHaveBeenCalledWith('row-9', 2);
  });

  it('drops its listeners on dispose', () => {
    const onClose = vi.fn();
    const viewer = mount({ onClose });
    viewer.dispose();
    viewer.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('writes nothing when the dependency tuple holds', () => {
    const images = [image({ imageId: 'a' })];
    const viewer = mount({ images });
    const observer = new MutationObserver(() => undefined);
    observer.observe(viewer.el, { childList: true, subtree: true, attributes: true, characterData: true });
    viewer.update(props({ images }));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
