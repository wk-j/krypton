// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { FooterProgramStatus } from './workspace-footer-program-status';

describe('FooterProgramStatus', () => {
  it('names each nonzero program state instead of showing an unexplained glyph count', () => {
    const footer = new FooterProgramStatus();

    footer.render({ blocked: 0, error: 0, done: 1 });
    expect(footer.el.textContent).toBe('DONE 1');
    expect(footer.el.querySelector('[data-state="done"]')?.textContent).toBe('DONE 1');

    footer.render({ blocked: 2, error: 1, done: 3 });
    expect(Array.from(footer.el.children, (part) => part.textContent)).toEqual([
      'BLOCKED 2', 'ERROR 1', 'DONE 3',
    ]);

    footer.render({ blocked: 0, error: 0, done: 0 });
    expect(footer.el.hidden).toBe(true);
    expect(footer.el.childElementCount).toBe(0);
  });
});
