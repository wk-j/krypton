import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountDocs } from '.';

// The markup `render_docs_list` / `render_journal_list` emit (hook_server.rs).
function row(path: string, href: string, name: string, ts?: number): string {
  const time = ts ? `<time class="lb-docs__date" data-ts="${ts}">1970-01-01 00:00</time>` : '';
  return `<li class="lb-docs__item" data-path="${path}"><a class="lb-docs__link" target="_blank" rel="noopener" href="${href}"><span class="lb-docs__icon">◆</span><span class="lb-docs__name">${name}</span>${time}</a></li>`;
}

const DOCS_BODY = `<div class="lb-page lb-page--wide lb-docs" data-title="hm-1 · /src/krypton · 3 files"><article class="lb-prose">
<nav class="lb-tabs" aria-label="Harnesses"><a class="lb-tabs__tab" aria-selected="true" href="/docs?harness=hm-1">hm-1</a></nav>
<div class="lb-docs__filter" id="docs-filter" data-placeholder="filter paths — type to narrow, ↑↓ to move, enter to open" data-unit="files"></div>
<ul class="lb-docs__list" id="docs-list">
${row('readme.md', '/doc?harness=hm-1&path=README.md', 'README.md', 1_700_000_000_000)}
${row('docs/adr/0004-peering.md', '/doc?harness=hm-1&path=docs%2Fadr%2F0004-peering.md', '<span class="lb-docs__dir">docs/adr/</span>0004-peering.md')}
${row('docs/0171-docs-browser.md', '/doc?harness=hm-1&path=docs%2F0171-docs-browser.md', '<span class="lb-docs__dir">docs/</span>0171-docs-browser.md')}
</ul>
<p class="lb-docs__empty" id="docs-empty" hidden>No path matches that filter.</p>
</article></div>`;

const JOURNAL_BODY = `<div class="lb-page lb-page--wide lb-docs" data-title="hm-1 · /src/krypton · 2 days"><article class="lb-prose">
<div class="lb-docs__filter" id="docs-filter" data-placeholder="filter days — type to narrow, ↑↓ to move, enter to open" data-unit="days"></div>
<ul class="lb-docs__list" id="docs-list">
${row('2026-08-15', '/doc?harness=hm-1&path=.krypton%2Fjournal%2F2026-08-15.md', '2026-08-15')}
${row('2026-08-14', '/doc?harness=hm-1&path=.krypton%2Fjournal%2F2026-08-14.md', '2026-08-14')}
</ul>
<p class="lb-docs__empty" id="docs-empty" hidden>No day matches that filter.</p>
</article></div>`;

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const visiblePaths = (main: HTMLElement): string[] =>
  [...main.querySelectorAll<HTMLElement>('.lb-docs__item')].filter((li) => !li.hidden).map((li) => li.dataset.path ?? '');

const selectedPath = (main: HTMLElement): string | undefined =>
  main.querySelector<HTMLElement>('.lb-docs__item--selected')?.dataset.path;

describe('docs index', () => {
  let main: HTMLElement;
  let dispose: () => void;
  const shell = { setTitle: vi.fn() };
  const opened: string[] = [];

  function mount(body: string, pathname: string): HTMLInputElement {
    main = document.createElement('main');
    main.innerHTML = body;
    document.body.append(main);
    for (const link of main.querySelectorAll('a.lb-docs__link')) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        opened.push(link.getAttribute('href') ?? '');
      });
    }
    dispose = mountDocs(shell, main, { pathname, search: '' });
    const input = main.querySelector<HTMLInputElement>('#docs-filter input');
    if (!input) throw new Error('filter not mounted');
    return input;
  }

  const count = (): string => main.querySelector('.lb-filter__count')?.textContent ?? '';

  beforeEach(() => {
    opened.length = 0;
    shell.setTitle.mockClear();
  });
  afterEach(() => {
    dispose();
    document.body.replaceChildren();
  });

  it('mounts the kit filter, titles the shell and localises dates', () => {
    mount(DOCS_BODY, '/docs');
    expect(shell.setTitle).toHaveBeenCalledWith('hm-1 · /src/krypton · 3 files');
    expect(main.querySelector('#docs-filter .lb-filter')).not.toBeNull();
    expect(count()).toBe('3 files');
    expect(main.querySelector('time')?.textContent).not.toBe('1970-01-01 00:00');
  });

  it('narrows /docs by every space-separated term and opens the first match on Enter', () => {
    const input = mount(DOCS_BODY, '/docs');
    type(input, 'adr peer');
    expect(visiblePaths(main)).toEqual(['docs/adr/0004-peering.md']);
    expect(count()).toBe('1 / 3 files');
    expect(selectedPath(main)).toBe('docs/adr/0004-peering.md');
    expect(main.querySelector<HTMLElement>('#docs-empty')?.hidden).toBe(true);
    press(input, { key: 'Enter' });
    expect(opened).toEqual(['/doc?harness=hm-1&path=docs%2Fadr%2F0004-peering.md']);

    type(input, 'nothing-matches');
    expect(visiblePaths(main)).toEqual([]);
    expect(main.querySelector<HTMLElement>('#docs-empty')?.hidden).toBe(false);
    expect(count()).toBe('0 / 3 files');
  });

  it('moves the selection with ↑/↓, wrapping, and Esc clears the filter', () => {
    const input = mount(DOCS_BODY, '/docs');
    input.focus();
    type(input, 'docs');
    expect(selectedPath(main)).toBe('docs/adr/0004-peering.md');
    press(input, { key: 'ArrowDown' });
    expect(selectedPath(main)).toBe('docs/0171-docs-browser.md');
    press(input, { key: 'ArrowDown' });
    expect(selectedPath(main)).toBe('docs/adr/0004-peering.md');
    press(input, { key: 'ArrowUp' });
    expect(selectedPath(main)).toBe('docs/0171-docs-browser.md');
    press(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(visiblePaths(main)).toHaveLength(3);
    expect(count()).toBe('3 files');
  });

  it('filters the /journal index too (the old page script returned early there)', () => {
    const input = mount(JOURNAL_BODY, '/journal');
    expect(count()).toBe('2 days');
    type(input, '08-14');
    expect(visiblePaths(main)).toEqual(['2026-08-14']);
    expect(count()).toBe('1 / 2 days');
    press(input, { key: 'Enter' });
    expect(opened).toEqual(['/doc?harness=hm-1&path=.krypton%2Fjournal%2F2026-08-14.md']);
    type(input, '1999');
    expect(main.querySelector<HTMLElement>('#docs-empty')?.hidden).toBe(false);
  });

  it('sends a printable key typed on the page to the filter, but not the shell keys or chords', () => {
    const input = mount(DOCS_BODY, '/docs');
    const typed = press(document.body, { key: 'x' });
    expect(document.activeElement).toBe(input);
    // Declined, so the browser still types the character into the box.
    expect(typed.defaultPrevented).toBe(false);

    input.blur();
    press(document.body, { key: '`', code: 'Backquote' });
    press(document.body, { key: '?' });
    press(document.body, { key: 'k', metaKey: true });
    expect(document.activeElement).not.toBe(input);
  });

  it('does not arm the doc overlay on an index', () => {
    mount(JOURNAL_BODY, '/journal');
    expect(document.querySelector('.lb-feedback')).toBeNull();
  });
});

describe('doc reader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    sessionStorage.clear();
  });

  it('mounts the comment + artifact overlay on /doc with the harness and path from the query', () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hash: 'h1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const main = document.createElement('main');
    main.innerHTML = '<div class="lb-page lb-page--wide lb-docs" data-title="docs/a.md"><article class="lb-prose"><h1>A</h1><p>Body</p></article></div>';
    document.body.append(main);
    const setTitle = vi.fn();
    const dispose = mountDocs({ setTitle }, main, { pathname: '/doc', search: '?harness=hm-1&path=docs%2Fa.md' });
    expect(setTitle).toHaveBeenCalledWith('docs/a.md');
    expect(document.querySelectorAll('.lb-feedback__pill')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith('/doc-state?harness=hm-1&path=docs%2Fa.md', expect.anything());
    dispose();
    expect(document.querySelector('.lb-feedback')).toBeNull();
  });
});
