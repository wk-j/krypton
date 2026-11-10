import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import { act, flush, press as pressKey, render } from '../../kit/test-utils';
import type { Rendered } from '../../kit/test-utils';
import { ENTRIES, GROUP_ORDER } from './examples';
import { HarnessGalleryPage } from '.';

// Spec 381: the gallery never reaches Tauri. Every call fails loudly, and the
// spy proves none happened even where a caller would have caught the error.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => {
    throw new Error('the harness gallery reached Tauri');
  }),
}));

const ORDERED = GROUP_ORDER.flatMap((group) => ENTRIES.filter((entry) => entry.group === group));

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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function navItems(root: HTMLElement): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>('.lb-harness__nav-item')];
}

function openTitle(root: HTMLElement): string | null | undefined {
  return root.querySelector('.lb-harness__view-name')?.textContent;
}

describe('harness component gallery', () => {
  let view: Rendered;
  let root: HTMLElement;
  let setTitle: Mock<(title: string) => void>;

  beforeEach(async () => {
    history.replaceState(null, '', '/harness-gallery');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    vi.mocked(invoke).mockClear();
    setTitle = vi.fn();
    view = render(<HarnessGalleryPage />, { shell: { surfaceId: 'harness', setTitle } });
    root = view.container;
    await flush();
  });

  afterEach(() => {
    view.unmount();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('indexes every entry by group, opens the first, and falls back to krypton-dark without theme.json', () => {
    expect(navItems(root).map((item) => item.textContent)).toEqual(ORDERED.map((entry) => entry.title));
    expect(openTitle(root)).toBe(ORDERED[0].title);
    expect(setTitle).toHaveBeenLastCalledWith(`${ORDERED[0].title} · Harness components`);
    expect(root.querySelector('.lb-harness__theme')?.textContent).toBe('krypton-dark (built-in) · app theme unavailable');
    expect(root.querySelector('.lb-filter__count')?.textContent).toBe(`${ORDERED.length} entries`);
  });

  it('renders every entry with one block per state and the production rows, without reaching Tauri', () => {
    for (const entry of ORDERED) {
      location.hash = entry.id;
      settleHash();
      expect(openTitle(root), entry.id).toBe(entry.title);
      const blocks = [...root.querySelectorAll<HTMLElement>('.lb-harness__block')];
      expect(blocks.map((block) => block.dataset.state), entry.id).toEqual(entry.states.map((state) => state.label));
      entry.states.forEach((state, index) => {
        const body = blocks[index].querySelector('.acp-harness > .acp-harness__lane-body');
        expect(body?.querySelectorAll(':scope > .acp-harness__msg').length, `${entry.id} · ${state.label}`)
          .toBe(state.inputs.length);
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('builds tool rows through the production payload: a failed command shows its exit', () => {
    location.hash = 'tool-execute';
    settleHash();
    const exit1 = root.querySelector<HTMLElement>('.lb-harness__block[data-state="exit 1"]');
    expect(exit1?.querySelector('.acp-harness__msg--tool.acp-harness__msg--failed')).not.toBeNull();
    expect(exit1?.textContent).toContain('boom');
  });

  it('toggles the canonical input under each state with s, without remounting rows', () => {
    const rows = [...root.querySelectorAll('.acp-harness__msg')];
    const sources = [...root.querySelectorAll<HTMLElement>('.lb-harness__source')];
    expect(sources.length).toBe(ORDERED[0].states.length);
    expect(sources.every((source) => source.hidden)).toBe(true);
    press(document.body, 's');
    expect(sources.every((source) => !source.hidden)).toBe(true);
    expect(JSON.parse(sources[0].textContent ?? '')).toEqual(JSON.parse(JSON.stringify(ORDERED[0].states[0].inputs)));
    expect([...root.querySelectorAll('.acp-harness__msg')]).toEqual(rows);
    const toggle = root.querySelector<HTMLButtonElement>('.lb-harness__view-actions button');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle?.click());
    expect(sources.every((source) => source.hidden)).toBe(true);
  });

  it('walks entries with ] and [, moves in the rail with ↑/↓, and opens with Enter', () => {
    press(document.body, ']');
    settleHash();
    expect(openTitle(root)).toBe(ORDERED[1].title);
    press(document.body, '[');
    settleHash();
    press(document.body, '[');
    settleHash();
    expect(openTitle(root)).toBe(ORDERED[ORDERED.length - 1].title);

    const items = navItems(root);
    items[0].focus();
    press(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press(items[1], 'Enter');
    settleHash();
    expect(openTitle(root)).toBe(ORDERED[1].title);
  });

  it('filters by `/` search over states and components, and Esc clears it', () => {
    press(document.body, '/');
    const input = root.querySelector<HTMLInputElement>('.lb-filter__input');
    expect(document.activeElement).toBe(input);
    if (input === null) return;
    type(input, 'guardian-review-row');
    expect(navItems(root).filter((item) => !item.hidden).map((item) => item.textContent)).toEqual(['Guardian review']);
    press(input, 'Enter');
    settleHash();
    expect(openTitle(root)).toBe('Guardian review');
    type(input, 'no such entry');
    expect(root.querySelector<HTMLElement>('.lb-harness__empty')?.hidden).toBe(false);
    press(input, 'Escape');
    expect(input.value).toBe('');
  });
});
