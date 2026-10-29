import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountReviews } from '.';

// What `render_reviews_page` emits (hook_server.rs), trimmed.
const BODY = `<div class="lb-page lb-page--wide lb-reviews" data-title="Why the poll loop exists">
<div class="lb-split"><nav class="lb-tree-nav" aria-label="Reviews"><ul class="lb-tree lb-tree--stacked"><li class="lb-tree__group"><div class="lb-tree__label">2 reviews</div><ul class="lb-tree__items">
<li class="lb-tree__item"><a class="lb-tree__link" aria-current="page" href="/review?harness=hm-2&amp;slug=a">Why the poll loop exists<span class="lb-tree__count">3 blocks</span></a></li>
</ul></li></ul></nav>
<article class="lb-prose"><ul class="reviews-index"><li class="rv-row"><a class="rv-row__main" href="#"><span class="rv-row__meta">lane · 3 blocks · <time class="rv-date" data-ts="1700000000000">2023-11-14 22:13</time></span></a></li></ul></article></div>
</div>`;

describe('reviews', () => {
  let dispose: () => void;

  afterEach(() => {
    dispose();
    sessionStorage.clear();
    document.body.replaceChildren();
  });

  it('titles the shell, localises dates and restores the tree scroll per harness', () => {
    sessionStorage.setItem('krv:hm-2', '90');
    sessionStorage.setItem('krv:', '30');
    const main = document.createElement('main');
    main.innerHTML = BODY;
    document.body.append(main);
    const setTitle = vi.fn();
    dispose = mountReviews({ setTitle }, main, '?harness=hm-2&slug=a');
    expect(setTitle).toHaveBeenCalledWith('Why the poll loop exists');
    expect(main.querySelector<HTMLElement>('.lb-tree-nav')?.scrollTop).toBe(90);
    expect(main.querySelector('time')?.textContent).not.toBe('2023-11-14 22:13');
  });

  it('uses the bare key on the harness-less index', () => {
    sessionStorage.setItem('krv:', '30');
    const main = document.createElement('main');
    main.innerHTML = BODY;
    document.body.append(main);
    dispose = mountReviews({ setTitle: vi.fn() }, main, '');
    expect(main.querySelector<HTMLElement>('.lb-tree-nav')?.scrollTop).toBe(30);
  });
});
