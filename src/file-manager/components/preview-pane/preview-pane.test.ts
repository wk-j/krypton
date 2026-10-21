// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreviewOutput } from '../../types';
import { PreviewPane } from './index';

const B = 'krypton-file-manager';
const INITIAL: PreviewOutput = { kind: 'text', text: '' };

describe('PreviewPane', () => {
  it('starts with an untouched <pre> and a hidden markdown div', () => {
    const p = new PreviewPane(INITIAL);
    p.update({ hidden: false, output: INITIAL });
    expect(p.el.outerHTML).toBe(
      `<div class="${B}__preview"><pre class="${B}__preview-content"></pre>`
      + `<div class="${B}__preview-markdown" style="display: none;"></div></div>`,
    );
  });

  it('text / html / markdown show the right child; the hidden one keeps its content (P10)', () => {
    const p = new PreviewPane(INITIAL);
    p.update({ hidden: false, output: { kind: 'markdown', html: '<p>md <img src="x"></p>' } });
    expect(p.contentEl.style.display).toBe('none');
    expect(p.markdownEl.style.display).toBe('');
    expect((p.markdownEl.querySelector('img') as HTMLElement).style.maxWidth).toBe('100%');

    p.update({ hidden: false, output: { kind: 'text', text: '<b>' } });
    expect(p.contentEl.textContent).toBe('<b>');
    expect(p.markdownEl.style.display).toBe('none');
    expect(p.markdownEl.innerHTML).toContain('md'); // P10

    p.update({ hidden: false, output: { kind: 'html', html: '<span class="hljs-keyword">x</span>' } });
    expect(p.contentEl.innerHTML).toBe('<span class="hljs-keyword">x</span>');
  });

  it('toggles --hidden without rewriting the content', () => {
    const p = new PreviewPane(INITIAL);
    const out: PreviewOutput = { kind: 'text', text: 'abc' };
    p.update({ hidden: false, output: out });
    const node = p.contentEl.firstChild;
    p.update({ hidden: true, output: out });
    expect(p.el.className).toBe(`${B}__preview ${B}__preview--hidden`);
    expect(p.contentEl.firstChild).toBe(node);
    p.update({ hidden: false, output: out });
    expect(p.el.className).toBe(`${B}__preview`);
  });

  describe('smooth scrolling', () => {
    let frames: Map<number, FrameRequestCallback>;

    const flush = (n = 1000): void => {
      for (let i = 0; i < n && frames.size > 0; i++) {
        const [id, cb] = frames.entries().next().value as [number, FrameRequestCallback];
        frames.delete(id);
        cb(0);
      }
    };

    const setup = (): PreviewPane => {
      frames = new Map();
      let nextId = 1;
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        const id = nextId++;
        frames.set(id, cb);
        return id;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
      vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as MediaQueryList);
      const p = new PreviewPane(INITIAL);
      for (const child of [p.contentEl, p.markdownEl]) {
        Object.defineProperty(child, 'scrollHeight', { configurable: true, value: 1000 });
        Object.defineProperty(child, 'clientHeight', { configurable: true, value: 200 });
      }
      return p;
    };

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('scrollBy glides the visible child', () => {
      const p = setup();
      p.scrollBy(80);
      expect(p.contentEl.scrollTop).toBe(0);
      flush(1);
      expect(p.contentEl.scrollTop).toBeGreaterThan(0);
      expect(p.contentEl.scrollTop).toBeLessThan(80);
      flush();
      expect(p.contentEl.scrollTop).toBe(80);
      expect(p.markdownEl.scrollTop).toBe(0);

      p.update({ hidden: false, output: { kind: 'markdown', html: 'x' } });
      p.markdownEl.scrollTop = 160;
      p.scrollBy(-80);
      flush();
      expect(p.markdownEl.scrollTop).toBe(80);
      expect(p.contentEl.scrollTop).toBe(80);
    });

    it('resetScroll and new content cancel an in-flight animation', () => {
      const p = setup();
      p.scrollBy(80);
      flush(1);
      const at = p.contentEl.scrollTop;
      p.resetScroll();
      expect(frames.size).toBe(0);
      flush();
      expect(p.contentEl.scrollTop).toBe(at);

      p.scrollBy(80);
      expect(frames.size).toBe(1);
      p.update({ hidden: false, output: { kind: 'text', text: 'new' } });
      expect(frames.size).toBe(0);
    });

    it('dispose cancels the animation', () => {
      const p = setup();
      p.scrollBy(80);
      p.dispose();
      expect(frames.size).toBe(0);
    });
  });
});
