// Spec 341 — the read-only Review Board archive (`/reviews`, `/review`;
// specs 211, 217). Rust renders the body (hook_server.rs `render_reviews_page`):
//
//   div.lb-page.lb-reviews[data-title] > div.lb-split >
//     nav.lb-tree-nav (bundles per harness) + article.lb-prose (index or bundle)
//
// The typed review blocks come from the Rust post-pass (`render_review_blocks`);
// this module only keeps the tree's scroll per harness (`krv:<harness>`),
// localises dates and puts the review title in the shell.

import type { Disposer } from '../../../ui/component';
import { DisposableBag } from '../../../ui/component';
import { hydrateTreeNav, localizeTimes } from '../../kit';
import type { AppShell } from '../../kit';

import './reviews.css';

export function mountReviews(shell: Pick<AppShell, 'setTitle'>, main: HTMLElement, search: string = location.search): Disposer {
  const bag = new DisposableBag();
  const title = main.querySelector<HTMLElement>('.lb-reviews')?.dataset.title;
  if (title) shell.setTitle(title);
  localizeTimes(main);
  const tree = main.querySelector<HTMLElement>('.lb-tree-nav');
  if (tree) bag.add(hydrateTreeNav(tree, `krv:${new URLSearchParams(search).get('harness') ?? ''}`));
  return () => bag.dispose();
}
