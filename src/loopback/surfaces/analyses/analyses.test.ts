import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAnalyses } from '.';

// What `render_analyses_page` emits (hook_server.rs), trimmed to two issues.
const BODY = `<div class="lb-page lb-page--wide lb-analyses" data-title="acme/widget#12">
<nav class="lb-tabs lb-analyses__tabs" aria-label="Projects">
<a class="lb-tabs__tab" aria-selected="false" href="/analyses?project=p-a"><span class="lb-tabs__label">alpha</span><b class="lb-tabs__count">1</b><span class="lb-tabs__key">1</span></a>
<a class="lb-tabs__tab" aria-selected="true" href="/analyses?project=p-b" aria-current="page"><span class="lb-tabs__label">beta</span><b class="lb-tabs__count">2</b><span class="lb-tabs__key">2</span></a>
<a class="lb-tabs__tab" aria-selected="false" href="/analyses?project=p-c"><span class="lb-tabs__label">gamma</span><b class="lb-tabs__count">4</b><span class="lb-tabs__key">3</span></a>
</nav>
<div class="lb-split"><nav class="lb-tree-nav" aria-label="Issues"><ul class="lb-tree"><li class="lb-tree__group"><div class="lb-tree__label">acme/widget</div><ul class="lb-tree__items">
<li class="lb-tree__item"><a class="lb-tree__link" aria-current="page" href="/analysis?project=p-b&amp;issue=acme%2Fwidget%2F12">#12 <span class="lb-tree__count">1 การวิเคราะห์</span></a></li>
</ul></li></ul></nav>
<article class="lb-prose"><ul class="analyses-index"><li class="ai-row"><a class="ai-row__main" href="#"><span class="ai-row__meta">1 การวิเคราะห์ · <time class="ai-date" data-ts="1700000000000">2023-11-14 22:13</time></span></a></li></ul></article></div>
</div>`;

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

describe('analyses', () => {
  let dispose: () => void;
  const followed: string[] = [];

  function mount(body = BODY): HTMLElement {
    const main = document.createElement('main');
    main.innerHTML = body;
    document.body.append(main);
    for (const tab of main.querySelectorAll('.lb-tabs__tab')) {
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        followed.push(tab.getAttribute('href') ?? '');
      });
    }
    dispose = mountAnalyses({ setTitle: vi.fn() }, main);
    return main;
  }

  afterEach(() => {
    dispose();
    followed.length = 0;
    sessionStorage.clear();
    document.body.replaceChildren();
  });

  it('follows the project tabs with ] [ and 1–9, and does nothing past either end', () => {
    mount();
    press({ key: ']' });
    press({ key: '[' });
    press({ key: '1' });
    press({ key: '3' });
    expect(followed).toEqual(['/analyses?project=p-c', '/analyses?project=p-a', '/analyses?project=p-a', '/analyses?project=p-c']);

    const beyond = press({ key: '9' });
    expect(beyond.defaultPrevented).toBe(false);
    expect(followed).toHaveLength(4);
  });

  it('declines [ on the first tab', () => {
    mount(BODY.replace('aria-selected="false" href="/analyses?project=p-a"', 'aria-selected="true" href="/analyses?project=p-a"').replace('aria-selected="true" href="/analyses?project=p-b"', 'aria-selected="false" href="/analyses?project=p-b"'));
    expect(press({ key: '[' }).defaultPrevented).toBe(false);
    expect(followed).toEqual([]);
  });

  it('restores the tree scroll under the active project key and localises dates', () => {
    sessionStorage.setItem('kav:/analyses?project=p-b', '120');
    const main = mount();
    expect(main.querySelector<HTMLElement>('.lb-tree-nav')?.scrollTop).toBe(120);
    expect(main.querySelector('time')?.textContent).not.toBe('2023-11-14 22:13');
  });

  it('puts the page title in the shell', () => {
    const main = document.createElement('main');
    main.innerHTML = BODY;
    const setTitle = vi.fn();
    dispose = mountAnalyses({ setTitle }, main);
    expect(setTitle).toHaveBeenCalledWith('acme/widget#12');
  });
});
