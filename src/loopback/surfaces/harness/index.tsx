// Spec 381 — the harness component gallery: every component that paints agent
// output, one entry at a time with all its named states, on a Krypton-window
// stage painted with the app's own theme. Hash-addressed (`#tool-execute`).
// Each preview is the production row fed by the production item builder
// (`build.ts`), mounted framework-free into an `Island` (`stage.ts`).

// The shell rules every row sits in, and the app's material tokens (spec 366).
// Each row component imports its own sheet.
import '../../../styles/harness-shared.css';
import '../../../styles/materials.css';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { Button, Island, KbdHints, SearchFilter, useKeymap, useLatest, useShell } from '../../kit';
// Not through the kit barrel: it reaches src/theme.ts, which no other page needs.
import { applyKryptonTheme } from '../../kit/lib/krypton-theme';
import { ENTRIES, GROUP_ORDER, GROUP_TITLES } from './examples';
import type { GalleryEntry } from './examples';
import { HarnessStage } from './stage';

import './harness.css';

const SURFACE_TITLE = 'Harness components';
const THEME_URL = '/harness-gallery/theme.json';
const THEME_FALLBACK = 'krypton-dark (built-in) · app theme unavailable';

const GROUPS = GROUP_ORDER.map((group) => ({ group, entries: ENTRIES.filter((entry) => entry.group === group) }));
/** Rail order, which `[`/`]` and the pager walk. */
const ORDERED: readonly GalleryEntry[] = GROUPS.flatMap((group) => group.entries);
const BY_ID = new Map(ORDERED.map((entry) => [entry.id, entry]));

const HINTS: readonly (readonly [string, string])[] = [
  ['/', 'search'],
  ['[ ]', 'prev/next'],
  ['↑↓', 'move'],
  ['Enter', 'open'],
  ['s', 'source'],
  ['Esc', 'clear'],
];

function matches(entry: GalleryEntry, query: string): boolean {
  if (query === '') return true;
  const states = entry.states.map((state) => state.label).join(' ');
  return `${entry.title} ${entry.summary} ${states} ${entry.components.join(' ')}`.toLowerCase().includes(query);
}

function PagerLink({ entry, direction }: { readonly entry: GalleryEntry; readonly direction: 'prev' | 'next' }): JSX.Element {
  return (
    <a className={`lb-harness__pager-link lb-harness__pager-link--${direction}`} href={`#${entry.id}`}>
      <span className="lb-harness__pager-dir">{direction === 'prev' ? '← prev' : 'next →'}</span>
      <span className="lb-harness__pager-name">{entry.title}</span>
    </a>
  );
}

interface ViewProps {
  readonly entry: GalleryEntry;
  readonly sourceOpen: boolean;
  onToggleSource(): void;
}

function EntryView({ entry, sourceOpen, onToggleSource }: ViewProps): JSX.Element {
  const position = ORDERED.indexOf(entry) + 1;
  const stage = useRef<HarnessStage | null>(null);
  // The source toggle shows or hides the JSON under each state; it never remounts the rows.
  useEffect(() => {
    stage.current?.setSourceOpen(sourceOpen);
  }, [sourceOpen]);
  const sourceRef = useLatest(sourceOpen);
  return (
    <div className="lb-harness__view">
      <header className="lb-harness__view-head">
        <div className="lb-harness__crumb">{`${GROUP_TITLES[entry.group]} · ${position} / ${ORDERED.length}`}</div>
        <div className="lb-harness__view-title">
          <h2 className="lb-harness__view-name">{entry.title}</h2>
          <div className="lb-harness__view-actions">
            <Button label={sourceOpen ? 'Hide source' : 'Source'} aria-expanded={sourceOpen} onClick={onToggleSource} />
          </div>
        </div>
        <p className="lb-harness__view-summary">{entry.summary}</p>
        <p className="lb-harness__components">{entry.components.join(' · ')}</p>
      </header>
      <div className="lb-h3 lb-harness__label">{`${entry.states.length} ${entry.states.length === 1 ? 'state' : 'states'} · Krypton surface`}</div>
      <Island
        className="lb-harness__states"
        deps={[entry]}
        mount={(host) => {
          const next = new HarnessStage(entry);
          next.mount(host, sourceRef.current);
          stage.current = next;
          return () => {
            next.dispose();
            if (stage.current === next) stage.current = null;
          };
        }}
      />
    </div>
  );
}

export function HarnessGalleryPage(): JSX.Element {
  const { setTitle } = useShell();
  const [query, setQuery] = useState('');
  const [themeLabel, setThemeLabel] = useState('');
  const [started, setStarted] = useState(false);
  const [current, setCurrent] = useState<GalleryEntry | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navItems = useRef(new Map<string, HTMLAnchorElement>());
  const currentRef = useRef<GalleryEntry | null>(null);

  const trimmed = query.trim().toLowerCase();
  const visible = ORDERED.filter((entry) => matches(entry, trimmed));
  /** The list `[`/`]` and the pager walk: the search result when it holds the open entry. */
  const walk = current !== null && visible.includes(current) ? visible : ORDERED;
  const state = useLatest({ visible, walk, query });

  /** Scroll the rail only when the item is out of its band — `scrollIntoView` hides it under the sticky group heading. */
  const revealNav = useCallback((item: HTMLElement): void => {
    const nav = navRef.current;
    if (nav === null) return;
    const port = nav.getBoundingClientRect();
    if (port.height === 0) return;
    const heading = item.parentElement?.querySelector<HTMLElement>('.lb-harness__nav-heading');
    const rect = item.getBoundingClientRect();
    const top = port.top + (heading?.offsetHeight ?? 0);
    if (rect.top < top) nav.scrollTop -= top - rect.top;
    else if (rect.bottom > port.bottom) nav.scrollTop += rect.bottom - port.bottom;
  }, []);

  /** Move focus inside the rail; native focus scrolling would tuck the item under the sticky heading. */
  const focusNavItem = useCallback(
    (entry: GalleryEntry): void => {
      const item = navItems.current.get(entry.id);
      if (item === undefined) return;
      item.focus({ preventScroll: true });
      revealNav(item);
    },
    [revealNav],
  );

  const show = useCallback((id: string): void => {
    const entry = BY_ID.get(id);
    if (entry === undefined || currentRef.current === entry) return;
    currentRef.current = entry;
    setCurrent(entry);
  }, []);

  const navigate = useCallback(
    (entry: GalleryEntry): void => {
      if (location.hash === `#${entry.id}`) show(entry.id);
      else location.hash = entry.id;
    },
    [show],
  );

  const setTitleRef = useLatest(setTitle);
  // A newly shown entry: top of the pane, the tab title, the rail marker in view.
  useLayoutEffect(() => {
    if (current === null) return;
    if (mainRef.current !== null) mainRef.current.scrollTop = 0;
    setTitleRef.current(`${current.title} · ${SURFACE_TITLE}`);
    const item = navItems.current.get(current.id);
    if (item !== undefined) revealNav(item);
  }, [current, setTitleRef, revealNav]);

  /** Theme first: rows read resolved tokens when they mount. */
  useEffect(() => {
    let live = true;
    document.documentElement.dataset.themeScheme ??= 'dark';
    void applyKryptonTheme(THEME_URL)
      .catch(() => THEME_FALLBACK)
      .then((text) => {
        if (!live) return;
        setThemeLabel(text);
        setStarted(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!started) return undefined;
    const showFromHash = (): void => {
      let id = '';
      try {
        id = decodeURIComponent(location.hash.slice(1));
      } catch {
        id = '';
      }
      if (BY_ID.has(id)) show(id);
      else if (currentRef.current === null) show(ORDERED[0].id);
    };
    showFromHash();
    // A palette switch or Reload Config in Krypton lands the next time this tab
    // is looked at; the custom properties repaint the mounted rows with no rebuild.
    let live = true;
    const onFocus = (): void => {
      void applyKryptonTheme(THEME_URL)
        .then((text) => {
          if (live) setThemeLabel(text);
        })
        .catch(() => {});
    };
    window.addEventListener('hashchange', showFromHash);
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      window.removeEventListener('hashchange', showFromHash);
      window.removeEventListener('focus', onFocus);
    };
  }, [started, show]);

  const focusNav = (step: number): void => {
    const list = state.current.visible;
    if (list.length === 0) return;
    const active = document.activeElement;
    const index = list.findIndex((entry) => navItems.current.get(entry.id) === active);
    const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
    focusNavItem(list[next]);
  };

  useKeymap([
    {
      key: ['[', ']'],
      display: '[ / ]',
      label: 'Previous / next entry',
      run: (event) => {
        const list = state.current.walk;
        if (list.length === 0) return;
        const open = currentRef.current;
        const index = open === null ? -1 : list.indexOf(open);
        const next = list[(index + (event.key === ']' ? 1 : -1) + list.length) % list.length];
        navigate(next);
        focusNavItem(next);
      },
    },
    {
      key: ['ArrowDown', 'ArrowUp'],
      display: '↑ / ↓',
      label: 'Move in the index (from the search box: ↓)',
      inInput: true,
      run: (event) => {
        const target = event.target;
        if (target === inputRef.current) {
          if (event.key !== 'ArrowDown') return false;
          focusNav(1);
          return;
        }
        if (!(target instanceof Node) || navRef.current === null || !navRef.current.contains(target)) return false;
        focusNav(event.key === 'ArrowDown' ? 1 : -1);
      },
    },
    {
      key: 'Enter',
      label: 'Open the focused entry',
      run: (event) => {
        const entry = ORDERED.find((candidate) => navItems.current.get(candidate.id) === event.target);
        if (entry === undefined) return false;
        navigate(entry);
      },
    },
    {
      key: 's',
      label: 'Show or hide the canonical input under each state',
      run: () => {
        setSourceOpen((open) => !open);
      },
    },
    {
      // Outside any input; inside the box SearchFilter's own Esc clears and leaves.
      key: 'Escape',
      label: 'Clear the search',
      run: () => {
        if (state.current.query === '') return false;
        setQuery('');
      },
    },
  ]);

  const index = current === null ? -1 : walk.indexOf(current);
  const pager =
    index < 0 || walk.length < 2
      ? null
      : [walk[(index - 1 + walk.length) % walk.length], walk[(index + 1) % walk.length]] as const;

  return (
    <div className="lb-page lb-page--fill lb-harness">
      <div className="lb-split lb-harness__layout">
        <aside className="lb-harness__side">
          <div className="lb-harness__theme">{themeLabel}</div>
          <SearchFilter
            className="lb-harness__search"
            placeholder="Search entry, state or component"
            label="Search entries"
            value={query}
            onChange={setQuery}
            onSubmit={() => {
              const first = state.current.visible[0];
              if (first === undefined) return;
              navigate(first);
              focusNavItem(first);
            }}
            // One Esc clears the box and leaves it for the open entry's index item.
            escape="clear-and-leave"
            onEscape={() => {
              if (currentRef.current !== null) focusNavItem(currentRef.current);
            }}
            count={
              !started
                ? undefined
                : trimmed === ''
                  ? `${ORDERED.length} entries`
                  : `${visible.length} / ${ORDERED.length} match`
            }
            inputRef={inputRef}
          />
          <nav className="lb-harness__nav" aria-label="Entries" ref={navRef}>
            {GROUPS.map(({ group, entries }) => {
              const shown = entries.filter((entry) => matches(entry, trimmed)).length;
              return (
                <section key={group} className="lb-harness__nav-group" data-group={group} hidden={shown === 0}>
                  <h2 className="lb-harness__nav-heading">{`${GROUP_TITLES[group]} · ${shown}`}</h2>
                  {entries.map((entry) => {
                    const isCurrent = entry === current;
                    return (
                      <a
                        key={entry.id}
                        className={isCurrent ? 'lb-harness__nav-item lb-harness__nav-item--current' : 'lb-harness__nav-item'}
                        href={`#${entry.id}`}
                        hidden={!matches(entry, trimmed)}
                        aria-current={isCurrent ? 'true' : undefined}
                        ref={(node) => {
                          if (node === null) navItems.current.delete(entry.id);
                          else navItems.current.set(entry.id, node);
                        }}
                      >
                        {entry.title}
                      </a>
                    );
                  })}
                </section>
              );
            })}
          </nav>
          <p className="lb-harness__empty" hidden={!started || visible.length > 0}>
            No entry matches.
          </p>
          <KbdHints entries={HINTS} />
        </aside>
        <div className="lb-harness__main" ref={mainRef}>
          <article className="lb-harness__detail">
            {current === null ? null : (
              <EntryView
                key={current.id}
                entry={current}
                sourceOpen={sourceOpen}
                onToggleSource={() => setSourceOpen((open) => !open)}
              />
            )}
          </article>
          <nav className="lb-harness__pager" aria-label="Previous and next entry">
            {pager === null ? null : (
              <>
                <PagerLink entry={pager[0]} direction="prev" />
                <PagerLink entry={pager[1]} direction="next" />
              </>
            )}
          </nav>
          <footer className="lb-harness__foot">
            Canonical lane data (spec 380) through the production item builders and row components. Nothing here talks to a lane.
          </footer>
        </div>
      </div>
    </div>
  );
}
