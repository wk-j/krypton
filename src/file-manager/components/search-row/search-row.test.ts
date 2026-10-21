// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { SearchRow } from './index';

const B = 'krypton-file-manager';

describe('SearchRow', () => {
  it('marks fuzzy match runs', () => {
    const r = new SearchRow();
    r.update({ relPath: 'src/main.ts', query: 'smt', isCursor: true });
    expect(r.el.outerHTML).toBe(
      `<div class="${B}__item ${B}__item--cursor"><span class="${B}__icon">  </span><span class="${B}__name">`
      + `<span class="${B}__match">s</span>rc/<span class="${B}__match">m</span>ain.<span class="${B}__match">t</span>s`
      + '</span></div>',
    );
  });

  it('plain text for an empty query', () => {
    const r = new SearchRow();
    r.update({ relPath: 'a/b', query: '', isCursor: false });
    expect(r.el.outerHTML).toBe(`<div class="${B}__item"><span class="${B}__icon">  </span><span class="${B}__name">a/b</span></div>`);
  });
});
