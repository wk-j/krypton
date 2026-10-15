import { afterEach, describe, expect, it } from 'vitest';

import { MemoryDrawer } from '../memory-drawer';
import { HelpOverlay } from './index';

const overlays: { dispose(): void }[] = [];

const mount = (open: boolean): HelpOverlay => {
  const overlay = new HelpOverlay();
  overlays.push(overlay);
  overlay.update({ open });
  return overlay;
};

afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.dispose();
});

describe('HelpOverlay', () => {
  it('emits the head and the section grid', () => {
    const overlay = mount(true);
    expect(overlay.el.className).toBe('acp-harness__help-overlay');
    expect(overlay.el.querySelector('.acp-harness__help__title')?.textContent).toBe('ACP Harness Help');
    expect(overlay.el.querySelector('.acp-harness__help__sub')?.textContent).toBe('Esc / ? / q closes');
    const titles = [...overlay.el.querySelectorAll('.acp-harness__help-section h3')].map((h) => h.textContent);
    expect(titles).toEqual([
      'Lane Control',
      'Composer (readline)',
      'Permissions',
      'Memory',
      'Transcript',
      'Commands',
      'Model',
    ]);
  });

  it('spans the last two sections across both grid columns', () => {
    const overlay = mount(true);
    const sections = [...overlay.el.querySelectorAll('.acp-harness__help-section')];
    expect(sections.slice(0, 5).every((s) => s.className === 'acp-harness__help-section')).toBe(true);
    expect(sections.slice(5).map((s) => s.className)).toEqual([
      'acp-harness__help-section acp-harness__help-section--wide',
      'acp-harness__help-section acp-harness__help-section--wide',
    ]);
  });

  it('pairs every term with its description, and keeps the kbd run in the Esc line', () => {
    const overlay = mount(true);
    const perms = [...overlay.el.querySelectorAll('.acp-harness__help-section')][2];
    expect([...perms.querySelectorAll('dt')].map((dt) => dt.textContent))
      .toEqual(['a', 'A', 'r', 'R', 'Esc']);
    const esc = [...perms.querySelectorAll('dd')][4];
    expect([...esc.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['r', 'R']);
    expect(esc.textContent).toBe('Never answers a request — only r / R reject');
  });

  it('writes the angle-bracket command terms as text, not as markup', () => {
    const overlay = mount(true);
    const terms = [...overlay.el.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(terms).toContain('#review [<lane> …] [-- <docpath | note>]');
    expect(overlay.el.querySelector('dt lane')).toBeNull();
  });

  it('renders the Model section as prose, not a list', () => {
    const overlay = mount(true);
    const model = [...overlay.el.querySelectorAll('.acp-harness__help-section')][6];
    expect(model.querySelector('dl')).toBeNull();
    expect(model.querySelector('p')?.textContent).toContain('Each lane is a separate ACP subprocess');
  });

  it('toggles hidden without rebuilding the grid', () => {
    const overlay = mount(false);
    expect(overlay.el.hidden).toBe(true);
    const grid = overlay.el.querySelector('.acp-harness__help-grid');
    overlay.update({ open: true });
    expect(overlay.el.hidden).toBe(false);
    expect(overlay.el.querySelector('.acp-harness__help-grid')).toBe(grid);
  });

  it('closes the memory drawer when it opens, and tells the drawer’s owner', () => {
    const drawer = new MemoryDrawer();
    overlays.push(drawer);
    let autoClosed = 0;
    drawer.update({
      open: true,
      entries: [],
      cursorId: null,
      warning: null,
      activeLaneLabel: null,
      now: 0,
      onAutoClose: () => {
        autoClosed += 1;
      },
    });
    expect(drawer.isOpen).toBe(true);

    const help = mount(true);
    expect(help.isOpen).toBe(true);
    expect(drawer.isOpen).toBe(false);
    expect(drawer.el.hidden).toBe(true);
    expect(autoClosed).toBe(1);
  });

  it('writes nothing when it is updated with the same open state', () => {
    const overlay = mount(true);
    const observer = new MutationObserver(() => undefined);
    observer.observe(overlay.el, { childList: true, subtree: true, attributes: true, characterData: true });
    overlay.update({ open: true });
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
