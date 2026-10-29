import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { COMPONENTS } from '../../../acp/genui/catalog';
import type { AppShell } from '../../kit';
import { GenuiGallery } from '.';

function press(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/** `navigate()` writes `location.hash`; open whatever the fragment names now. */
function settleHash(): void {
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function navItems(root: HTMLElement): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>('.lb-genui__nav-item')];
}

function openName(root: HTMLElement): string | null | undefined {
  return root.querySelector('.lb-genui__view-name')?.textContent;
}

describe('GenUI component gallery', () => {
  let gallery: GenuiGallery;
  let setTitle: Mock<(title: string) => void>;

  beforeEach(async () => {
    history.replaceState(null, '', '/genui-gallery');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    setTitle = vi.fn();
    gallery = new GenuiGallery({ setTitle } as unknown as AppShell);
    document.body.replaceChildren(gallery.el);
    await gallery.start();
  });

  afterEach(() => {
    gallery.dispose();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('indexes every component, opens the first, and falls back to krypton-dark without theme.json', () => {
    expect(navItems(gallery.el).map((item) => item.textContent).sort())
      .toEqual(COMPONENTS.map((component) => component.name).sort());
    expect(openName(gallery.el)).toBe(COMPONENTS[0].name);
    expect(setTitle).toHaveBeenLastCalledWith(`${COMPONENTS[0].name} · GenUI components`);
    expect(gallery.el.querySelector('.lb-genui__theme')?.textContent).toBe('krypton-dark (built-in) · app theme unavailable');
    expect(gallery.el.querySelector('.lb-filter__count')?.textContent).toBe(`${COMPONENTS.length} components`);
    expect(gallery.el.querySelector('.lb-genui__preview')?.childElementCount).toBeGreaterThan(0);
  });

  it('filters by `/` search and opens the first match on Enter', () => {
    press(document.body, '/');
    const input = gallery.el.querySelector<HTMLInputElement>('.lb-filter__input');
    expect(document.activeElement).toBe(input);
    if (input === null) return;
    input.value = 'slider';
    input.dispatchEvent(new Event('input'));
    expect(gallery.el.querySelector('.lb-filter__count')?.textContent).toBe(`1 / ${COMPONENTS.length} match`);
    expect(navItems(gallery.el).filter((item) => !item.hidden).map((item) => item.textContent)).toEqual(['Slider']);

    press(input, 'Enter');
    settleHash();
    expect(location.hash).toBe('#Slider');
    expect(openName(gallery.el)).toBe('Slider');
    expect(document.activeElement?.textContent).toBe('Slider');

    input.value = 'no such component';
    input.dispatchEvent(new Event('input'));
    expect(gallery.el.querySelector<HTMLElement>('.lb-genui__empty')?.hidden).toBe(false);
  });

  it('Esc in the search clears it and returns to the open entry', () => {
    const input = gallery.el.querySelector<HTMLInputElement>('.lb-filter__input');
    if (input === null) throw new Error('no search box');
    input.focus();
    input.value = 'grid';
    input.dispatchEvent(new Event('input'));
    press(input, 'Escape');
    expect(input.value).toBe('');
    expect(navItems(gallery.el).every((item) => !item.hidden)).toBe(true);
    expect(document.activeElement?.textContent).toBe(COMPONENTS[0].name);
  });

  it('walks components with ] and [ and moves in the rail with ↑/↓', () => {
    press(document.body, ']');
    settleHash();
    expect(openName(gallery.el)).toBe(COMPONENTS[1].name);
    press(document.body, '[');
    settleHash();
    expect(openName(gallery.el)).toBe(COMPONENTS[0].name);
    press(document.body, '[');
    settleHash();
    expect(openName(gallery.el)).toBe(COMPONENTS[COMPONENTS.length - 1].name);

    const items = navItems(gallery.el);
    items[0].focus();
    press(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press(items[1], 'ArrowUp');
    press(items[0], 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    press(items[items.length - 1], 'Enter');
    settleHash();
    expect(openName(gallery.el)).toBe(items[items.length - 1].textContent);
  });

  it('toggles the example source and keeps one view mounted', () => {
    const toggle = gallery.el.querySelector<HTMLButtonElement>('.lb-genui__view-actions button');
    const source = gallery.el.querySelector<HTMLElement>('.lb-genui__source');
    expect(source?.hidden).toBe(true);
    toggle?.click();
    expect(source?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.textContent).toBe('Hide source');
    press(document.body, ']');
    settleHash();
    expect(gallery.el.querySelectorAll('.lb-genui__view')).toHaveLength(1);
  });
});
