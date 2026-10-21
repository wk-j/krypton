// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createState, selectFileList, selectSearchList } from '../../state';
import { entry } from '../../test-fixtures';
import { FileList } from '../file-list';
import { SearchList } from './index';

const B = 'krypton-file-manager';

describe('SearchList', () => {
  it('Loading... vs No matches', () => {
    const s = createState('/r');
    const el = document.createElement('div');
    const list = new SearchList(el);
    list.update(selectSearchList(s));
    expect(el.innerHTML).toBe(`<div class="${B}__empty">Loading...</div>`);
    s.search.text = 'x';
    list.update(selectSearchList(s));
    expect(el.innerHTML).toBe(`<div class="${B}__empty">No matches</div>`);
  });

  it('switches FileList → SearchList → FileList on the shared node with no stale rows', () => {
    const s = createState('/r');
    s.entries = [entry('a'), entry('b')];
    s.filtered = [...s.entries];
    const el = document.createElement('div');
    const files = new FileList(el);
    const search = new SearchList(el);
    files.update(selectFileList(s));
    expect(Array.from(el.children)).toEqual([files.rowsEl]);
    expect(files.rowsEl.children).toHaveLength(2);

    files.release();
    s.search.results = ['x/1', 'x/2', 'x/3'];
    search.update(selectSearchList(s));
    expect(Array.from(el.children)).toEqual([search.rowsEl]);
    expect(Array.from(search.rowsEl.children).map((c) => c.textContent)).toEqual(['  x/1', '  x/2', '  x/3']);

    search.release();
    files.update(selectFileList(s));
    expect(Array.from(el.querySelectorAll(`.${B}__name`)).map((c) => c.textContent)).toEqual(['a', 'b']);
    expect(Array.from(el.children)).toEqual([files.rowsEl]);
    expect(files.rowsEl.children).toHaveLength(2);
  });

  it('overscans and translates like FileList', () => {
    const s = createState('/r');
    s.visibleRows = 4;
    s.search.results = Array.from({ length: 50 }, (_, i) => `d/${i}`);
    s.search.scrollOffset = 20;
    s.search.cursor = 20;
    const el = document.createElement('div');
    const list = new SearchList(el);
    list.update(selectSearchList(s));
    const texts = Array.from(list.rowsEl.children).map((c) => c.textContent?.trim());
    // [20 - 3 → even 16, 20 + 4 + 3)
    expect(texts[0]).toBe('d/16');
    expect(texts.slice(-1)[0]).toBe('d/26');
    expect(list.rowsEl.style.transform).toBe(`translateY(${(16 - 20) * s.cellHeight}px)`);
    // a fractional (animated) position shifts by the fraction
    list.update(selectSearchList(s, 19.5));
    expect(list.rowsEl.style.transform).toBe(`translateY(${(16 - 19.5) * s.cellHeight}px)`);
  });
});
