// Spec 341 — the reader sidebar (analyses, reviews). Rust renders the tree:
//
//   nav.lb-tree-nav            the scrolling pane
//     ul.lb-tree [.lb-tree--stacked: the count on its own line]
//       li.lb-tree__group > div.lb-tree__label + ul.lb-tree__items
//         li.lb-tree__item > a.lb-tree__link[aria-current=page] > span.lb-tree__count
//
// Every link is a full-page navigation, so the browser never restores the
// pane's scroll and it would snap to the top on each click. `hydrateTreeNav`
// stashes `scrollTop` under the caller's key and restores it on load.

import type { Disposer } from '../../../ui/component';

import './tree-nav.css';

export function hydrateTreeNav(root: HTMLElement, storageKey: string): Disposer {
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved !== null) root.scrollTop = Number(saved);
  } catch {
    /* storage disabled: the pane simply starts at the top */
  }
  let frame = 0;
  const onScroll = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      try {
        sessionStorage.setItem(storageKey, String(root.scrollTop));
      } catch {
        /* storage full or disabled */
      }
    });
  };
  root.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    root.removeEventListener('scroll', onScroll);
    if (frame) cancelAnimationFrame(frame);
  };
}
