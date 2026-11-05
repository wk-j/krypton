// Spec 341 — the docs reader (`/docs`, `/journal`, `/doc`; specs 171, 172,
// 174, 223). Rust renders the body (hook_server.rs `render_docs_page`):
//
//   div.lb-page.lb-docs[data-title] > article.lb-prose >
//     nav.lb-tabs > a.lb-tabs__tab[aria-selected]      harness switcher (>1 harness)
//     div#docs-filter[data-placeholder][data-unit]     the SearchFilter mounts here
//     ul#docs-list.lb-docs__list > li.lb-docs__item[data-path] > a.lb-docs__link
//     p#docs-empty                                     shown when nothing matches
//
// or one rendered markdown file (`/doc`; its raw HTML/JS runs — ADR-0010).
// This page hydrates it: the index filter (both indexes — the old page's
// script returned early on `/journal`), ↑/↓/Enter selection,
// type-anywhere-to-filter, local dates, and on `/doc` the comment + artifact
// overlay.
//
// Spec 361: the page renders only portals — the filter into the empty Rust
// slot, the overlay into `<body>`. The Rust rows are never rendered by React:
// effects toggle their `hidden` and selection class and undo it on unmount.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';

import type { PageProps } from '../../app';
import {
  FeedbackOverlay,
  isEditableTarget,
  localizeTimes,
  matchesQuery,
  PROSE_CLASS,
  SearchFilter,
  useKeyFallback,
  useKeymap,
  useShell,
} from '../../kit';

import './docs.css';

const SELECTED = 'lb-docs__item--selected';

export interface DocsLocation {
  readonly pathname: string;
  readonly search: string;
}

export interface DocsPageProps extends PageProps {
  /** Where the page is; tests pass one, the browser uses `location`. */
  readonly at?: DocsLocation;
}

export function DocsPage({ main, at = location }: DocsPageProps): JSX.Element {
  const { setTitle } = useShell();

  useEffect(() => {
    const title = main.querySelector<HTMLElement>('.lb-docs')?.dataset.title;
    if (title) setTitle(title);
  }, [main, setTitle]);

  useEffect(() => {
    localizeTimes(main);
  }, [main]);

  const { pathname, search } = at;
  const slots = useMemo(
    () => ({
      filter: main.querySelector<HTMLElement>('#docs-filter'),
      list: main.querySelector<HTMLElement>('#docs-list'),
      empty: main.querySelector<HTMLElement>('#docs-empty'),
    }),
    [main],
  );

  const overlay = useMemo(() => {
    if (pathname !== '/doc') return null;
    const query = new URLSearchParams(search);
    const harness = query.get('harness') ?? '';
    const path = query.get('path') ?? '';
    const scope = main.querySelector<HTMLElement>(`article.${PROSE_CLASS}`);
    return harness && path && scope ? { harness, path, scope } : null;
  }, [main, pathname, search]);

  return (
    <>
      {slots.filter && slots.list ? <DocsIndex slot={slots.filter} list={slots.list} empty={slots.empty} /> : null}
      {overlay
        ? createPortal(
            <FeedbackOverlay
              key={`${overlay.harness}:${overlay.path}`}
              harness={overlay.harness}
              path={overlay.path}
              scope={overlay.scope}
            />,
            document.body,
          )
        : null}
    </>
  );
}

interface DocsIndexProps {
  readonly slot: HTMLElement;
  readonly list: HTMLElement;
  readonly empty: HTMLElement | null;
}

interface Selection {
  /** Index into the visible rows; -1 = none. A fresh object per select() so the row scrolls again. */
  readonly index: number;
}

const NO_SELECTION: Selection = { index: -1 };

/** The flat index: every row is already in the DOM; the filter hides rows in place. */
function DocsIndex({ slot, list, empty }: DocsIndexProps): JSX.Element {
  const items = useMemo(
    () => [...list.children].filter((node): node is HTMLElement => node instanceof HTMLElement),
    [list],
  );
  const unit = slot.dataset.unit ?? 'files';
  const placeholder = slot.dataset.placeholder ?? 'filter — type to narrow, ↑↓ to move, enter to open';
  const input = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const visible = useMemo(() => items.filter((item) => matchesQuery(item.dataset.path ?? '', query)), [items, query]);
  const selected = selection.index;
  const filtering = query.trim().length > 0;

  // Hide the rows that do not match (and show the empty note), then put them back on unmount.
  useLayoutEffect(() => {
    const shown = new Set(visible);
    for (const item of items) item.hidden = !shown.has(item);
    const emptyWasHidden = empty?.hidden ?? true;
    if (empty) empty.hidden = visible.length > 0;
    return () => {
      for (const item of items) item.hidden = false;
      if (empty) empty.hidden = emptyWasHidden;
    };
  }, [items, visible, empty]);

  // Mark the selected row (after the rows above settled, so it scrolls to its final place).
  useLayoutEffect(() => {
    const item = visible[selection.index];
    if (!item) return undefined;
    item.classList.add(SELECTED);
    item.scrollIntoView?.({ block: 'nearest' });
    return () => item.classList.remove(SELECTED);
  }, [visible, selection]);

  const onChange = (next: string): void => {
    setQuery(next);
    const any = next.trim().length > 0 && items.some((item) => matchesQuery(item.dataset.path ?? '', next));
    setSelection(any ? { index: 0 } : NO_SELECTION);
  };

  const step = (delta: number): void => {
    const next = selected + delta;
    setSelection({ index: next < 0 ? visible.length - 1 : next >= visible.length ? 0 : next });
  };

  /** Enter: the selection, else the first match — exactly like clicking the row. */
  const open = (): void => {
    const item = visible[selected] ?? visible[0];
    // Inside a keydown the click carries user activation, so the row's
    // target=_blank is not popup-blocked.
    item?.querySelector('a')?.click();
  };

  // ↑/↓ work from the box and from the page; any other field keeps its arrows.
  const listKeys = (): boolean =>
    visible.length > 0 && (document.activeElement === input.current || !isEditableTarget(document.activeElement));
  useKeymap([
    { key: 'ArrowDown', label: 'Next match', inInput: true, when: listKeys, run: () => step(1) },
    { key: 'ArrowUp', label: 'Previous match', inInput: true, when: listKeys, run: () => step(-1) },
    {
      key: 'Enter',
      label: 'Open the selected file',
      // A focused link answers Enter itself.
      when: () => selected >= 0 && !(document.activeElement instanceof HTMLAnchorElement),
      run: open,
    },
  ]);

  // Typing anywhere goes to the box. Decline so the character lands in it,
  // and leave the shell's `` ` `` / `?` (already bound, so they never get
  // here) and every chord alone.
  useKeyFallback((event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key.length !== 1 || event.key === '`' || event.key === '?') return false;
    input.current?.focus();
    return false;
  });

  return createPortal(
    <SearchFilter
      placeholder={placeholder}
      value={query}
      onChange={onChange}
      onSubmit={open}
      count={filtering ? `${visible.length} / ${items.length} ${unit}` : `${items.length} ${unit}`}
      inputRef={input}
    />,
    slot,
  );
}
