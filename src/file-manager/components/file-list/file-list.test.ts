// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listComponents } from '../../../ui/list';
import { LIST_OVERSCAN, ListGlide } from '../../smooth-scroll';
import { createState, selectFileList } from '../../state';
import { entry } from '../../test-fixtures';
import { FileList } from './index';

const B = 'krypton-file-manager';

function setup(n = 10, rows = 4) {
  const s = createState('/r');
  s.entries = Array.from({ length: n }, (_, i) => entry(`f${i}`, { modified: i + 1 }));
  s.filtered = [...s.entries];
  s.visibleRows = rows;
  const listEl = document.createElement('div');
  listEl.className = `${B}__list`;
  const list = new FileList(listEl);
  const render = (): void => list.update(selectFileList(s));
  render();
  return { s, list, listEl, rowsEl: list.rowsEl, render };
}

const names = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll(`.${B}__name`)).map((n) => n.textContent ?? '');

describe('FileList', () => {
  it('renders the visibleRows window from scrollOffset, plus overscan', () => {
    const { s, listEl, rowsEl, render } = setup();
    expect(listEl.firstElementChild).toBe(rowsEl);
    expect(rowsEl.className).toBe(`${B}__rows`);
    expect(names(listEl)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    expect(rowsEl.style.transform).toBe('translateY(0px)');
    s.scrollOffset = 4;
    render();
    // [4 - 3 → even 0, 4 + 4 + 3 → clamped to 10)
    expect(names(listEl)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']);
    expect(rowsEl.style.transform).toBe(`translateY(${-4 * s.cellHeight}px)`);
  });

  it('overscan window size: visibleRows + 2 * LIST_OVERSCAN (+1 for even alignment)', () => {
    const { s, listEl, render } = setup(100, 10);
    s.scrollOffset = 50;
    render();
    expect(names(listEl)).toHaveLength(10 + 2 * LIST_OVERSCAN + 1);
    expect(names(listEl)[0]).toBe('f46');
    expect(names(listEl).slice(-1)[0]).toBe('f62');
  });

  it('a cursor move repaints two rows and keeps every node', () => {
    const { s, rowsEl, render } = setup();
    const before = Array.from(rowsEl.children);
    const htmlBefore = before.map((n) => n.outerHTML);
    s.cursor = 1;
    render();
    const after = Array.from(rowsEl.children);
    expect(after.every((n, i) => n === before[i])).toBe(true);
    const changed = after.filter((n, i) => n.outerHTML !== htmlBefore[i]);
    expect(changed).toHaveLength(2);
    expect(after[1].classList.contains(`${B}__item--cursor`)).toBe(true);
  });

  it('a one-line scroll keeps every node still in the window', () => {
    const { s, rowsEl, render } = setup(100, 10);
    s.scrollOffset = 50;
    render();
    const before = new Map(Array.from(rowsEl.children).map((n, i) => [names(rowsEl)[i], n]));
    s.scrollOffset = 51;
    render();
    const after = Array.from(rowsEl.children);
    const kept = after.filter((n, i) => before.get(names(rowsEl)[i]) === n);
    // 46..62 → 48..63: the 15 shared rows keep their nodes
    expect(kept).toHaveLength(15);
  });

  it('empty states', () => {
    const { s, listEl, render } = setup();
    s.filtered = [];
    render();
    expect(listEl.innerHTML).toBe(`<div class="${B}__empty">Empty directory</div>`);
    expect(listComponents(listEl)).toHaveLength(0);
    s.filterText = 'x';
    render();
    expect(listEl.innerHTML).toBe(`<div class="${B}__empty">No matches</div>`);
    s.filtered = [...s.entries];
    render();
    expect(names(listEl)).toHaveLength(7);
  });

  it('release() disposes rows and forces the next paint', () => {
    const { list, listEl, render } = setup();
    list.release();
    expect(listEl.children).toHaveLength(0);
    expect(listComponents(listEl)).toHaveLength(0);
    render();
    expect(names(listEl)).toHaveLength(7);
  });
});

describe('FileList + ListGlide (smooth scrolling)', () => {
  let frames: Array<FrameRequestCallback | null> = [];
  let reduced = false;

  beforeEach(() => {
    frames = [];
    reduced = false;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = null; });
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce') }));
  });

  afterEach(() => vi.unstubAllGlobals());

  const flush = (max = 200): number => {
    let n = 0;
    while (n < max && frames.some((f) => f !== null)) {
      const batch = frames;
      frames = [];
      for (const cb of batch) cb?.(0);
      n++;
    }
    return n;
  };

  function glideSetup(n = 100, rows = 10) {
    const base = setup(n, rows);
    const glide = new ListGlide(() => paint());
    const paint = (): void => {
      glide.sync(base.s.scrollOffset, base.s.visibleRows, base.s.cellHeight);
      base.list.update(selectFileList(base.s, glide.position));
    };
    paint();
    return { ...base, glide, paint };
  }

  const translate = (el: HTMLElement): number => Number(/translateY\((-?[\d.e-]+)px\)/.exec(el.style.transform)?.[1]);
  const shift = (s: { scrollOffset: number; cellHeight: number }, start: number): number =>
    (start - s.scrollOffset) * s.cellHeight;

  it('glides to the new offset over several frames and lands exactly', () => {
    const { s, rowsEl, glide, paint } = glideSetup();
    s.scrollOffset = 5;
    paint();
    expect(glide.active).toBe(true);
    expect(glide.position).toBe(0); // nothing moves before the first frame
    expect(translate(rowsEl)).toBe(0);

    frames.shift()?.(0);
    expect(glide.position).toBeGreaterThan(0);
    expect(glide.position).toBeLessThan(5);

    expect(flush()).toBeGreaterThan(1);
    expect(glide.active).toBe(false);
    expect(glide.position).toBe(5);
    // first rendered row is 2 (5 - 3 → even 2); the rows node sits at -scrollOffset*cellHeight relative to it
    expect(names(rowsEl)[0]).toBe('f2');
    expect(translate(rowsEl)).toBe(shift(s, 2));
  });

  it('renders the window around the animated position during the glide', () => {
    const { s, rowsEl, glide, paint } = glideSetup();
    s.scrollOffset = 8;
    paint();
    for (let i = 0; i < 3; i++) frames.shift()?.(0);
    const pos = glide.position;
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThan(8);
    const first = Number(names(rowsEl)[0].slice(1));
    const last = Number(names(rowsEl).slice(-1)[0].slice(1));
    expect(first).toBeLessThanOrEqual(Math.floor(pos));
    expect(last).toBeGreaterThanOrEqual(Math.ceil(pos) + s.visibleRows - 1);
    expect(translate(rowsEl)).toBeCloseTo((first - pos) * s.cellHeight, 6);
  });

  it('a jump larger than visibleRows snaps with no animation', () => {
    const { s, rowsEl, glide, paint } = glideSetup();
    s.scrollOffset = 90;
    paint();
    expect(glide.active).toBe(false);
    expect(frames.filter(Boolean)).toHaveLength(0);
    expect(glide.position).toBe(90);
    expect(translate(rowsEl)).toBe(shift(s, 86));
  });

  it('snapNext() cancels a running glide and lands the next sync', () => {
    const { s, glide, paint } = glideSetup();
    s.scrollOffset = 5;
    paint();
    expect(glide.active).toBe(true);
    glide.snapNext();
    expect(glide.active).toBe(false);
    s.scrollOffset = 0;
    paint();
    expect(glide.position).toBe(0);
    expect(frames.filter(Boolean)).toHaveLength(0);
  });

  it('prefers-reduced-motion snaps', () => {
    reduced = true;
    const { s, rowsEl, glide, paint } = glideSetup();
    s.scrollOffset = 5;
    paint();
    expect(glide.active).toBe(false);
    expect(frames.filter(Boolean)).toHaveLength(0);
    expect(glide.position).toBe(5);
    expect(translate(rowsEl)).toBe(shift(s, 2));
  });

  it('a one-row glide keeps every node that stays in the window', () => {
    const { s, rowsEl, paint } = glideSetup();
    s.scrollOffset = 20;
    paint(); // > visibleRows → snaps
    const before = new Set(Array.from(rowsEl.children));
    s.scrollOffset = 21;
    paint();
    flush();
    const kept = Array.from(rowsEl.children).filter((n) => before.has(n));
    // 16..32 → 18..33
    expect(kept).toHaveLength(15);
  });
});
