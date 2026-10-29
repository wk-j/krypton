// Spec 341 — the Issue Analysis Viewer (`/analyses`, `/analysis`; spec 192).
// Rust renders the body (hook_server.rs `render_analyses_page`):
//
//   div.lb-page.lb-analyses[data-title] >
//     nav.lb-tabs.lb-analyses__tabs > a.lb-tabs__tab[aria-selected]   one per project
//     div.lb-split > nav.lb-tree-nav (issue tree) + article.lb-prose (index or bundle)
//
// This module hydrates it: `[`/`]`/`1`–`9` follow the project links, the tree
// keeps its scroll per project (`kav:<active tab href>`), dates go local.

import type { Disposer } from '../../../ui/component';
import { DisposableBag } from '../../../ui/component';
import { hydrateTreeNav, keymap, localizeTimes } from '../../kit';
import type { AppShell } from '../../kit';

import './analyses.css';

export function mountAnalyses(shell: Pick<AppShell, 'setTitle'>, main: HTMLElement): Disposer {
  const bag = new DisposableBag();
  const title = main.querySelector<HTMLElement>('.lb-analyses')?.dataset.title;
  if (title) shell.setTitle(title);
  localizeTimes(main);

  const tabs = [...main.querySelectorAll<HTMLAnchorElement>('.lb-analyses__tabs .lb-tabs__tab')];
  const active = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
  const tree = main.querySelector<HTMLElement>('.lb-tree-nav');
  if (tree) bag.add(hydrateTreeNav(tree, `kav:${tabs[active]?.getAttribute('href') ?? ''}`));

  if (tabs.length > 0) {
    // The tabs are ordinary links (the server renders the selected project), so
    // a key just follows one; past either end it does nothing.
    const follow = (index: number): boolean => {
      const tab = tabs[index];
      if (!tab) return false;
      tab.click();
      return true;
    };
    bag.add(
      keymap().bindAll([
        { key: ']', label: 'Next project', run: () => follow(active + 1) },
        { key: '[', label: 'Previous project', run: () => follow(active - 1) },
        {
          key: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
          display: '1–9',
          label: 'Jump to project',
          run: (event) => follow(Number(event.key) - 1),
        },
      ]),
    );
  }
  return () => bag.dispose();
}
