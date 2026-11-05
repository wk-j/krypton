// Spec 341 — the read-only Review Board archive (`/reviews`, `/review`;
// specs 211, 217). Rust renders the body (hook_server.rs `render_reviews_page`):
//
//   div.lb-page.lb-reviews[data-title] > div.lb-split >
//     nav.lb-tree-nav (bundles per harness) + article.lb-prose (index or bundle)
//
// The typed review blocks come from the Rust post-pass (`render_review_blocks`);
// this page only keeps the tree's scroll per harness (`krv:<harness>`),
// localises dates and puts the review title in the shell.
//
// Spec 361: React renders nothing here; effects attach to the Rust markup.

import { useEffect } from 'react';

import type { PageProps } from '../../app';
import { hydrateTreeNav, localizeTimes, useShell } from '../../kit';

import './reviews.css';

export interface ReviewsPageProps extends PageProps {
  /** The query string; tests pass one, the browser uses `location.search`. */
  readonly search?: string;
}

export function ReviewsPage({ main, search = location.search }: ReviewsPageProps): null {
  const { setTitle } = useShell();

  useEffect(() => {
    const title = main.querySelector<HTMLElement>('.lb-reviews')?.dataset.title;
    if (title) setTitle(title);
  }, [main, setTitle]);

  useEffect(() => {
    localizeTimes(main);
  }, [main]);

  const treeKey = `krv:${new URLSearchParams(search).get('harness') ?? ''}`;
  useEffect(() => {
    const tree = main.querySelector<HTMLElement>('.lb-tree-nav');
    return tree ? hydrateTreeNav(tree, treeKey) : undefined;
  }, [main, treeKey]);

  return null;
}
