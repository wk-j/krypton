// Spec 341 — the Issue Analysis Viewer (`/analyses`, `/analysis`; spec 192).
// Rust renders the body (hook_server.rs `render_analyses_page`):
//
//   div.lb-page.lb-analyses[data-title] >
//     nav.lb-tabs.lb-analyses__tabs > a.lb-tabs__tab[aria-selected]   one per project
//     div.lb-split > nav.lb-tree-nav (issue tree) + article.lb-prose (index or bundle)
//
// This page hydrates it: `[`/`]`/`1`–`9` follow the project links, the tree
// keeps its scroll per project (`kav:<active tab href>`), dates go local.
//
// Spec 361: React renders nothing here; effects attach to the Rust markup.

import { useEffect, useMemo } from 'react';
import type { JSX } from 'react';

import type { PageProps } from '../../app';
import { hydrateTreeNav, localizeTimes, useKeymap, useShell } from '../../kit';

import './analyses.css';

export function AnalysesPage({ main }: PageProps): JSX.Element | null {
  const { setTitle } = useShell();

  useEffect(() => {
    const title = main.querySelector<HTMLElement>('.lb-analyses')?.dataset.title;
    if (title) setTitle(title);
  }, [main, setTitle]);

  useEffect(() => {
    localizeTimes(main);
  }, [main]);

  const tabs = useMemo(() => [...main.querySelectorAll<HTMLAnchorElement>('.lb-analyses__tabs .lb-tabs__tab')], [main]);
  const active = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
  const treeKey = `kav:${tabs[active]?.getAttribute('href') ?? ''}`;

  useEffect(() => {
    const tree = main.querySelector<HTMLElement>('.lb-tree-nav');
    return tree ? hydrateTreeNav(tree, treeKey) : undefined;
  }, [main, treeKey]);

  return tabs.length > 0 ? <ProjectKeys tabs={tabs} active={active} /> : null;
}

interface ProjectKeysProps {
  readonly tabs: readonly HTMLAnchorElement[];
  readonly active: number;
}

/** Bound only when the page has project tabs. */
function ProjectKeys({ tabs, active }: ProjectKeysProps): null {
  // The tabs are ordinary links (the server renders the selected project), so
  // a key just follows one; past either end it does nothing.
  const follow = (index: number): boolean => {
    const tab = tabs[index];
    if (!tab) return false;
    tab.click();
    return true;
  };
  useKeymap([
    { key: ']', label: 'Next project', run: () => follow(active + 1) },
    { key: '[', label: 'Previous project', run: () => follow(active - 1) },
    {
      key: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
      display: '1–9',
      label: 'Jump to project',
      run: (event) => follow(Number(event.key) - 1),
    },
  ]);
  return null;
}
