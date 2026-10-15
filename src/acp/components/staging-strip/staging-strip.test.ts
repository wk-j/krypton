import { describe, expect, it } from 'vitest';

import type { StagedImage } from '../../harness-view-types';
import { StagingStrip, type StagingStripProps } from './index';

const SHOT: StagedImage = { data: 'AAAA', mimeType: 'image/png', path: '/tmp/screenshot.png' };
const DIAGRAM: StagedImage = { data: 'BBBB', mimeType: 'image/png', path: '/tmp/diagram.png' };
const PASTED: StagedImage = { data: 'CCCC', mimeType: 'image/jpeg', path: null };

const writes = (el: HTMLElement, run: () => void): number => {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  return records.length;
};

const mount = (props: StagingStripProps): StagingStrip => {
  const strip = new StagingStrip();
  strip.update(props);
  return strip;
};

describe('StagingStrip', () => {
  it('emits one tile per staged image, then the count hint', () => {
    const strip = mount({ images: [SHOT, DIAGRAM] });

    expect(strip.el.outerHTML).toBe(
      '<div class="acp-harness__staging">' +
        '<div class="acp-harness__staged-image">' +
        '<img class="acp-harness__staged-thumb" alt="" src="data:image/png;base64,AAAA">' +
        '<span class="acp-harness__staged-label">screenshot.png</span>' +
        '<button class="acp-harness__staged-remove" title="Remove image" type="button" ' +
        'data-remove-staged-image="0">x</button>' +
        '</div>' +
        '<div class="acp-harness__staged-image">' +
        '<img class="acp-harness__staged-thumb" alt="" src="data:image/png;base64,BBBB">' +
        '<span class="acp-harness__staged-label">diagram.png</span>' +
        '<button class="acp-harness__staged-remove" title="Remove image" type="button" ' +
        'data-remove-staged-image="1">x</button>' +
        '</div>' +
        '<span class="acp-harness__staging-hint">2 images · Esc to clear</span>' +
        '</div>',
    );
  });

  it('labels a pasted image with its mime type', () => {
    const strip = mount({ images: [PASTED] });
    expect(strip.el.querySelector('.acp-harness__staged-label')?.textContent).toBe('image/jpeg');
    expect(strip.el.querySelector('.acp-harness__staging-hint')?.textContent)
      .toBe('1 image · Esc to clear');
  });

  it('keeps the surviving tile’s nodes when the first image is removed', () => {
    const strip = mount({ images: [SHOT, DIAGRAM] });
    const tiles = strip.el.querySelectorAll('.acp-harness__staged-image');
    const kept = tiles[1];
    const keptThumb = kept.querySelector('img');

    strip.update({ images: [DIAGRAM] });

    const after = strip.el.querySelectorAll('.acp-harness__staged-image');
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(kept);
    expect(after[0].querySelector('img')).toBe(keptThumb);
    expect(keptThumb?.getAttribute('src')).toBe('data:image/png;base64,BBBB');
    expect(after[0].querySelector('button')?.dataset.removeStagedImage).toBe('0');
  });

  it('gives two copies of the same image two tiles', () => {
    const strip = mount({ images: [PASTED, PASTED] });
    expect(strip.el.querySelectorAll('.acp-harness__staged-image')).toHaveLength(2);
  });

  it('hides itself when nothing is staged, and comes back', () => {
    const strip = mount({ images: [SHOT] });
    expect(strip.el.hidden).toBe(false);

    strip.update({ images: [] });
    expect(strip.el.hidden).toBe(true);
    expect(strip.el.querySelector('.acp-harness__staged-image')).toBeNull();

    strip.update({ images: [SHOT] });
    expect(strip.el.hidden).toBe(false);
    expect(strip.el.className).toBe('acp-harness__staging');
  });

  it('reports the clicked index and stops reporting after dispose()', () => {
    const removed: number[] = [];
    const strip = new StagingStrip();
    strip.update({ images: [SHOT, DIAGRAM], onRemove: (index: number): void => { removed.push(index); } });

    const buttons = strip.el.querySelectorAll<HTMLElement>('.acp-harness__staged-remove');
    buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(removed).toEqual([1]);

    strip.dispose();
    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(removed).toEqual([1]);
  });

  it('writes nothing when the staged set did not move', () => {
    const strip = mount({ images: [SHOT, DIAGRAM] });
    const count = writes(strip.el, () => {
      strip.update({ images: [SHOT, DIAGRAM] });
    });
    expect(count).toBe(0);
  });
});
