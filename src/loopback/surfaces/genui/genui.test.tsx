import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { COMPONENTS } from '../../../acp/genui/catalog';
import { act, flush, press as pressKey, render } from '../../kit/test-utils';
import type { Rendered } from '../../kit/test-utils';
import { GenuiPage } from '.';

function press(target: EventTarget, key: string): void {
  pressKey(key, {}, target);
}

/** `navigate()` writes `location.hash`; open whatever the fragment names now. */
function settleHash(): void {
  act(() => {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

/** Type into the search box the way React's `onChange` listens for it. */
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    // The prototype setter bypasses React's value tracker so the edit reads as user input.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function navItems(root: HTMLElement): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>('.lb-genui__nav-item')];
}

function openName(root: HTMLElement): string | null | undefined {
  return root.querySelector('.lb-genui__view-name')?.textContent;
}

describe('GenUI component gallery', () => {
  let view: Rendered;
  let root: HTMLElement;
  let setTitle: Mock<(title: string) => void>;

  beforeEach(async () => {
    history.replaceState(null, '', '/genui-gallery');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    setTitle = vi.fn();
    view = render(<GenuiPage />, { shell: { surfaceId: 'genui', setTitle } });
    root = view.container;
    await flush();
  });

  afterEach(() => {
    view.unmount();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('indexes every component, opens the first, and falls back to krypton-dark without theme.json', () => {
    expect(navItems(root).map((item) => item.textContent).sort())
      .toEqual(COMPONENTS.map((component) => component.name).sort());
    expect(openName(root)).toBe(COMPONENTS[0].name);
    expect(setTitle).toHaveBeenLastCalledWith(`${COMPONENTS[0].name} · GenUI components`);
    expect(root.querySelector('.lb-genui__theme')?.textContent).toBe('krypton-dark (built-in) · app theme unavailable');
    expect(root.querySelector('.lb-filter__count')?.textContent).toBe(`${COMPONENTS.length} components`);
    expect(root.querySelector('.lb-genui__preview')?.childElementCount).toBeGreaterThan(0);
  });

  it('filters by `/` search and opens the first match on Enter', () => {
    press(document.body, '/');
    const input = root.querySelector<HTMLInputElement>('.lb-filter__input');
    expect(document.activeElement).toBe(input);
    if (input === null) return;
    type(input, 'slider');
    expect(root.querySelector('.lb-filter__count')?.textContent).toBe(`1 / ${COMPONENTS.length} match`);
    expect(navItems(root).filter((item) => !item.hidden).map((item) => item.textContent)).toEqual(['Slider']);

    press(input, 'Enter');
    settleHash();
    expect(location.hash).toBe('#Slider');
    expect(openName(root)).toBe('Slider');
    expect(document.activeElement?.textContent).toBe('Slider');

    type(input, 'no such component');
    expect(root.querySelector<HTMLElement>('.lb-genui__empty')?.hidden).toBe(false);
  });

  it('Esc in the search clears it and returns to the open entry', () => {
    const input = root.querySelector<HTMLInputElement>('.lb-filter__input');
    if (input === null) throw new Error('no search box');
    input.focus();
    type(input, 'grid');
    press(input, 'Escape');
    expect(input.value).toBe('');
    expect(navItems(root).every((item) => !item.hidden)).toBe(true);
    expect(document.activeElement?.textContent).toBe(COMPONENTS[0].name);
  });

  it('walks components with ] and [ and moves in the rail with ↑/↓', () => {
    press(document.body, ']');
    settleHash();
    expect(openName(root)).toBe(COMPONENTS[1].name);
    press(document.body, '[');
    settleHash();
    expect(openName(root)).toBe(COMPONENTS[0].name);
    press(document.body, '[');
    settleHash();
    expect(openName(root)).toBe(COMPONENTS[COMPONENTS.length - 1].name);

    const items = navItems(root);
    items[0].focus();
    press(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press(items[1], 'ArrowUp');
    press(items[0], 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    press(items[items.length - 1], 'Enter');
    settleHash();
    expect(openName(root)).toBe(items[items.length - 1].textContent);
  });

  it('toggles the example source and keeps one view mounted', () => {
    const toggle = root.querySelector<HTMLButtonElement>('.lb-genui__view-actions button');
    const source = root.querySelector<HTMLElement>('.lb-genui__source');
    expect(source?.hidden).toBe(true);
    act(() => toggle?.click());
    expect(source?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.textContent).toBe('Hide source');
    press(document.body, ']');
    settleHash();
    expect(root.querySelectorAll('.lb-genui__view')).toHaveLength(1);
  });
});
