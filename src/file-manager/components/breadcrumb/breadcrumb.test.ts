// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createState, selectBreadcrumb } from '../../state';
import { Breadcrumb } from './index';

describe('Breadcrumb', () => {
  it('renders the ~-substituted cwd', () => {
    const s = createState('/home/u/p');
    s.homeDir = '/home/u';
    const b = new Breadcrumb();
    b.update(selectBreadcrumb(s));
    expect(b.el.outerHTML).toBe('<div class="krypton-file-manager__breadcrumb">~/p</div>');
  });

  it('leaves the path alone while homeDir is "/"', () => {
    const b = new Breadcrumb();
    b.update(selectBreadcrumb(createState('/home/u/p')));
    expect(b.el.textContent).toBe('/home/u/p');
  });

  it('toggles the search variant', () => {
    const b = new Breadcrumb();
    b.update({ search: true, text: 'SEARCH // ab\u2588' });
    expect(b.el.outerHTML).toBe(
      '<div class="krypton-file-manager__breadcrumb krypton-file-manager__breadcrumb--search">SEARCH // ab\u2588</div>',
    );
    b.update({ search: false, text: '/x' });
    expect(b.el.className).toBe('krypton-file-manager__breadcrumb');
  });
});
