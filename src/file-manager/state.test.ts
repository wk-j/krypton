// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  aiContext,
  clampScroll,
  createState,
  parentDir,
  restoreSelection,
  selectBreadcrumb,
  selectFileList,
  selectSearchList,
  selectStatus,
  uniqueCopyPath,
  windowRange,
  wrapCursor,
} from './state';
import { dir, entry } from './test-fixtures';

describe('pure helpers', () => {
  it('wrapCursor wraps both ways', () => {
    expect(wrapCursor(0, -1, 5)).toBe(4);
    expect(wrapCursor(4, 1, 5)).toBe(0);
    expect(wrapCursor(1, 7, 5)).toBe(3);
  });

  it('clampScroll keeps the cursor in the window', () => {
    expect(clampScroll(2, 5, 4)).toBe(2);
    expect(clampScroll(10, 0, 4)).toBe(7);
    expect(clampScroll(5, 3, 4)).toBe(3);
    expect(clampScroll(5, 3, 0)).toBe(3);
  });

  it('windowRange clips to the length', () => {
    expect(windowRange(3, 5, 6)).toEqual([3, 6]);
  });

  it('parentDir', () => {
    expect(parentDir('/a/b')).toBe('/a');
    expect(parentDir('/a/b/')).toBe('/a');
    expect(parentDir('/a')).toBe('/');
    expect(parentDir('/')).toBe('/');
  });

  it('uniqueCopyPath', () => {
    expect(uniqueCopyPath('/d', 'a.txt', new Set(['a.txt', 'a 2.txt']))).toBe('/d/a 3.txt');
    expect(uniqueCopyPath('/d', '.env', new Set(['.env']))).toBe('/d/.env 2');
    const all = new Set(Array.from({ length: 998 }, (_, i) => `a ${i + 2}.txt`));
    expect(uniqueCopyPath('/d', 'a.txt', all)).toBe('/d/a copy.txt');
  });

  it('restoreSelection keeps marks that still exist and the cursor by name', () => {
    const list = [entry('a'), entry('b'), entry('c')];
    expect(restoreSelection('b', 0, new Set(['/r/c', '/r/gone']), list)).toEqual({ cursor: 1, marked: new Set(['/r/c']) });
    expect(restoreSelection('gone', 7, new Set(), list).cursor).toBe(2);
    expect(restoreSelection(null, 2, new Set(), list).cursor).toBe(0);
  });
});

describe('selectors', () => {
  const base = () => {
    const s = createState('/home/u/p');
    s.entries = [dir('src'), entry('a.ts', { path: '/home/u/p/a.ts', size: 2048 })];
    s.filtered = [...s.entries];
    return s;
  };

  it('selectStatus: normal parts', () => {
    const s = base();
    s.cursor = 1;
    s.marked.add('/home/u/p/a.ts');
    s.tracked.set('x', '');
    s.clipboard = { paths: ['x', 'y'], op: 'cut' };
    s.showHidden = true;
    s.sortOrder = 'desc';
    expect(selectStatus(s)).toEqual({
      text: '2 items │ 1 marked │ 1 tracked │ sort: name ↓ │ ✂ 2 │ hidden: on │ rw-r--r-- │ 2.0K',
      tone: 'normal',
    });
  });

  it('selectStatus: prompt, search, filter, confirm', () => {
    const s = base();
    s.filterMode = true;
    s.filterText = 'a';
    expect(selectStatus(s)).toEqual({ text: '/a█  (2 matches)', tone: 'filter' });
    s.search.active = true;
    s.search.results = ['a'];
    s.search.pool = ['a', 'b'];
    s.search.capped = true;
    expect(selectStatus(s)).toEqual({ text: '1 matches (capped) │ 2 files indexed', tone: 'filter' });
    s.prompt = { label: 'New file:', value: 'x', onSubmit: () => {} };
    expect(selectStatus(s)).toEqual({ text: 'New file: x█', tone: 'prompt' });
    s.confirmAction = () => {};
    expect(selectStatus(s)).toBeNull();
  });

  it('selectBreadcrumb substitutes ~ and has a search variant', () => {
    const s = base();
    expect(selectBreadcrumb(s)).toEqual({ search: false, text: '/home/u/p' });
    s.homeDir = '/home/u';
    expect(selectBreadcrumb(s)).toEqual({ search: false, text: '~/p' });
    s.search.active = true;
    s.search.text = 'ab';
    expect(selectBreadcrumb(s)).toEqual({ search: true, text: 'SEARCH // ab█' });
  });

  it('selectFileList windows the rows and reports empty states', () => {
    const s = base();
    s.visibleRows = 1;
    s.scrollOffset = 1;
    s.cursor = 1;
    const p = selectFileList(s);
    expect(p.empty).toBeNull();
    // overscan: the window also holds the row above (see overscanRange)
    expect(p.rows.map((r) => [r.entry.name, r.isCursor])).toEqual([['src', false], ['a.ts', true]]);
    expect(p.shiftPx).toBe(-s.cellHeight);
    s.filtered = [];
    expect(selectFileList(s)).toEqual({ rows: [], empty: 'Empty directory' });
    s.filterText = 'z';
    expect(selectFileList(s)).toEqual({ rows: [], empty: 'No matches' });
  });

  it('selectSearchList lower-cases the query', () => {
    const s = base();
    expect(selectSearchList(s).empty).toBe('Loading...');
    s.search.text = 'Q';
    expect(selectSearchList(s).empty).toBe('No matches');
    s.search.results = ['a/q'];
    expect(selectSearchList(s)).toEqual({ rows: [{ relPath: 'a/q', query: 'q', isCursor: true }], empty: null, shiftPx: 0 });
  });

  it('aiContext', () => {
    const s = base();
    s.marked.add('/r/src');
    expect(aiContext(s)).toEqual({
      cwd: '/home/u/p',
      cursorFile: { name: 'src', path: '/r/src', is_dir: true, size: 0 },
      markedFiles: [{ name: 'src', path: '/r/src', is_dir: true, size: 0 }],
      totalEntries: 2,
    });
  });
});
