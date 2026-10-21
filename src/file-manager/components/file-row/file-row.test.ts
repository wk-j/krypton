// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { dir, entry } from '../../test-fixtures';
import { FileRow, type FileRowProps } from './index';

const B = 'krypton-file-manager';
const row = (p: Partial<FileRowProps> & Pick<FileRowProps, 'entry'>): FileRow => {
  const r = new FileRow();
  r.update({ isCursor: false, marked: false, recency: undefined, ...p });
  return r;
};
const inner = (mark: string, icon: string, name: string, size: string, sizeCls = '', fill = ''): string =>
  `<span class="${B}__mark">${mark}</span><span class="${B}__icon">${icon}</span>`
  + `<span class="${B}__name">${name}</span><span class="${B}__age-bar">${fill}</span>`
  + `<span class="${B}__size${sizeCls}">${size}</span>`;

describe('FileRow', () => {
  it('file', () => {
    expect(row({ entry: entry('a.unknown', { size: 21 }) }).el.outerHTML)
      .toBe(`<div class="${B}__item">${inner('  ', '  ', 'a.unknown', '21B')}</div>`);
  });

  it('directory', () => {
    expect(row({ entry: dir('src') }).el.outerHTML)
      .toBe(`<div class="${B}__item ${B}__item--dir">${inner('  ', '\u25b8 ', 'src/', '')}</div>`);
  });

  it('symlink → target', () => {
    const r = row({ entry: entry('link', { is_symlink: true, symlink_target: '/t', size: 3 }) });
    expect(r.el.outerHTML).toBe(`<div class="${B}__item ${B}__item--symlink">${inner('  ', '  ', 'link \u2192 /t', '3B')}</div>`);
  });

  it('cursor + marked + file-type class, in the old order', () => {
    const r = row({ entry: entry('a.ts', { size: 1 }), isCursor: true, marked: true });
    expect(r.el.className).toBe(`${B}__item ${B}__item--cursor ${B}__item--marked ${B}__item--ft-code`);
    expect(r.el.querySelector(`.${B}__mark`)!.textContent).toBe('\u25cf ');
  });

  it('size classes', () => {
    expect(row({ entry: entry('a', { size: 200 * 1024 }) }).el.querySelector(`.${B}__size`)!.className)
      .toBe(`${B}__size ${B}__size--large`);
    expect(row({ entry: entry('a', { size: 2 * 1024 * 1024 }) }).el.querySelector(`.${B}__size`)!.className)
      .toBe(`${B}__size ${B}__size--mega`);
  });

  it('adds and removes the age fill as recency changes', () => {
    const e = entry('a');
    const r = row({ entry: e, recency: 1 });
    const fill = r.el.querySelector(`.${B}__age-fill`) as HTMLElement;
    expect(fill.style.width).toBe('100%');
    expect(fill.style.opacity).toBe('1');
    r.update({ entry: e, isCursor: false, marked: false, recency: undefined });
    expect(r.el.querySelector(`.${B}__age-fill`)).toBeNull();
    r.update({ entry: e, isCursor: true, marked: false, recency: 0 });
    expect((r.el.querySelector(`.${B}__age-fill`) as HTMLElement).style.width).toBe('15%');
  });

  it('does not repaint on equal props', () => {
    const e = entry('a');
    const r = row({ entry: e });
    const name = r.el.querySelector(`.${B}__name`)!;
    const spy = vi.spyOn(r as unknown as { paint: () => void }, 'paint');
    r.update({ entry: e, isCursor: false, marked: false, recency: undefined });
    expect(spy).not.toHaveBeenCalled();
    expect(r.el.querySelector(`.${B}__name`)).toBe(name);
  });
});
