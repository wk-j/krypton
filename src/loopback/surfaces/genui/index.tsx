// Spec 313 / 341 / 361 — the GenUI component gallery: an index rail of every shipped
// catalog component, one live example at a time on a Krypton-window stage,
// hash-addressed (`#Slider`) so back/forward and deep links work. The preview
// is the production renderer mounted into an `Island`, never re-implemented.

// The panel body the Harness seats a spec in: the gallery preview carries the
// same block, so the roots get the app's own column rhythm, not a gallery one.
// Spec 366: the catalog paints with the app's material tokens (plate, well,
// key, lamp), so the preview loads the same root set the app does.
import '../../../acp/components/genui-panel/genui-panel.css';
import '../../../styles/materials.css';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { COMPONENTS, GROUP_ORDER } from '../../../acp/genui/catalog';
import type { ComponentSpec, ParamSpec } from '../../../acp/genui/catalog';
import { FOCUSABLE_ATTR } from '../../../acp/components/genui-catalog/renderer';
import { Button, Island, KbdHints, SearchFilter, useKeymap, useLatest, useShell } from '../../kit';
import { EXAMPLES } from './examples';
import { GalleryPreview } from './preview';
import { applyKryptonTheme } from './theme';

import './genui.css';

/** One catalog component and its place in the index. */
interface Entry {
  readonly spec: ComponentSpec;
  readonly position: number;
}

const SURFACE_TITLE = 'GenUI components';
const THEME_FALLBACK = 'krypton-dark (built-in) · app theme unavailable';
const EXAMPLE_BY_NAME = new Map(EXAMPLES.map((example) => [example.component, example]));

const GROUPS: readonly { readonly group: string; readonly entries: readonly Entry[] }[] = (() => {
  let position = 0;
  return GROUP_ORDER.map((group) => ({
    group,
    entries: COMPONENTS.filter((component) => component.group === group).map((spec) => ({ spec, position: ++position })),
  }));
})();
const ENTRIES: readonly Entry[] = GROUPS.flatMap((group) => group.entries);
const BY_NAME = new Map(ENTRIES.map((entry) => [entry.spec.name, entry]));

const HINTS: readonly (readonly [string, string])[] = [
  ['/', 'search'],
  ['[ ]', 'prev/next'],
  ['↑↓', 'move'],
  ['Enter', 'open'],
  ['Esc', 'clear'],
];

function paramKind(param: ParamSpec): string {
  if (param.kind === 'enum' && param.values !== undefined) return param.values.join(' | ');
  if (param.kind === 'binding') return param.holds === undefined ? 'binding $name' : `binding $name → ${param.holds}`;
  return param.kind;
}

function Params({ spec }: { readonly spec: ComponentSpec }): JSX.Element {
  return (
    <section className="lb-genui__params">
      <div className="lb-h3 lb-genui__label">Parameters</div>
      <dl className="lb-genui__param-list">
        {spec.params.map((param) => [
          <dt key={`${param.name}:dt`} className="lb-genui__param-name">
            {param.name}
            {param.required === true ? <span className="lb-genui__param-required">required</span> : null}
          </dt>,
          <dd key={`${param.name}:dd`} className="lb-genui__param-kind">
            {paramKind(param)}
          </dd>,
        ])}
        {spec.params.length === 0 ? (
          <>
            <dt className="lb-genui__param-name">—</dt>
            <dd className="lb-genui__param-kind">no parameters</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function PagerLink({ entry, direction }: { readonly entry: Entry; readonly direction: 'prev' | 'next' }): JSX.Element {
  return (
    <a className={`lb-genui__pager-link lb-genui__pager-link--${direction}`} href={`#${entry.spec.name}`}>
      <span className="lb-genui__pager-dir">{direction === 'prev' ? '← prev' : 'next →'}</span>
      <span className="lb-genui__pager-name">{entry.spec.name}</span>
    </a>
  );
}

interface ViewProps {
  readonly entry: Entry;
  readonly preview: GalleryPreview;
  readonly status: string;
  readonly sourceOpen: boolean;
  onToggleSource(): void;
}

function EntryView({ entry, preview, status, sourceOpen, onToggleSource }: ViewProps): JSX.Element {
  const spec = entry.spec;
  const example = EXAMPLE_BY_NAME.get(spec.name);
  if (example === undefined) throw new Error(`Missing GenUI gallery example: ${spec.name}`);
  return (
    <div className="lb-genui__view">
      <header className="lb-genui__view-head">
        <div className="lb-genui__crumb">{`${spec.group} · ${entry.position} / ${ENTRIES.length}`}</div>
        <div className="lb-genui__view-title">
          <h2 className="lb-genui__view-name">{spec.name}</h2>
          <div className="lb-genui__view-actions">
            <Button label={sourceOpen ? 'Hide source' : 'Source'} aria-expanded={sourceOpen} onClick={onToggleSource} />
            <Button label="Reset" onClick={() => preview.reset()} />
          </div>
        </div>
        <p className="lb-genui__view-summary">{spec.summary}</p>
      </header>
      <div className="lb-h3 lb-genui__label">Preview · Krypton surface</div>
      <div className="lb-genui__stage">
        <Island
          className="lb-genui__preview acp-genui-panel__body acp-genui"
          deps={[preview]}
          mount={(host) => {
            preview.mount(host);
            return () => preview.dispose();
          }}
        />
      </div>
      <div className="lb-genui__status" role="status">
        {status}
      </div>
      <pre className="lb-code lb-code--wrap lb-genui__source" hidden={!sourceOpen}>
        {`version 2\n${example.source}`}
      </pre>
      <Params spec={spec} />
    </div>
  );
}

function matches(entry: Entry, query: string): boolean {
  return query === '' || `${entry.spec.name} ${entry.spec.summary}`.toLowerCase().includes(query);
}

export function GenuiPage(): JSX.Element {
  const { setTitle } = useShell();
  const [query, setQuery] = useState('');
  const [themeLabel, setThemeLabel] = useState('');
  const [started, setStarted] = useState(false);
  const [current, setCurrent] = useState<Entry | null>(null);
  /** Per-component view state that outlives navigation, as the old cached views did. */
  const [sourceOpen, setSourceOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [statuses, setStatuses] = useState<ReadonlyMap<string, string>>(new Map());
  const previews = useRef(new Map<string, GalleryPreview>());
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navItems = useRef(new Map<string, HTMLAnchorElement>());
  const currentRef = useRef<Entry | null>(null);

  const trimmed = query.trim().toLowerCase();
  const visible = ENTRIES.filter((entry) => matches(entry, trimmed));
  /** The list `[`/`]` and the pager walk: the search result when it holds the open component. */
  const walk = current !== null && visible.includes(current) ? visible : ENTRIES;
  const state = useLatest({ visible, walk, query });

  const previewOf = (entry: Entry): GalleryPreview => {
    let preview = previews.current.get(entry.spec.name);
    if (preview === undefined) {
      const name = entry.spec.name;
      const example = EXAMPLE_BY_NAME.get(name);
      if (example === undefined) throw new Error(`Missing GenUI gallery example: ${name}`);
      preview = new GalleryPreview(example.source, (text) => {
        setStatuses((prev) => new Map(prev).set(name, text));
      });
      previews.current.set(name, preview);
    }
    return preview;
  };

  /** Scroll the rail only when the item is out of its band — `scrollIntoView` hides it under the sticky group heading. */
  const revealNav = useCallback((item: HTMLElement): void => {
    const nav = navRef.current;
    if (nav === null) return;
    const port = nav.getBoundingClientRect();
    if (port.height === 0) return;
    const heading = item.parentElement?.querySelector<HTMLElement>('.lb-genui__nav-heading');
    const rect = item.getBoundingClientRect();
    const top = port.top + (heading?.offsetHeight ?? 0);
    if (rect.top < top) nav.scrollTop -= top - rect.top;
    else if (rect.bottom > port.bottom) nav.scrollTop += rect.bottom - port.bottom;
  }, []);

  /** Move focus inside the rail; native focus scrolling would tuck the item under the sticky heading. */
  const focusNavItem = useCallback(
    (entry: Entry): void => {
      const item = navItems.current.get(entry.spec.name);
      if (item === undefined) return;
      item.focus({ preventScroll: true });
      revealNav(item);
    },
    [revealNav],
  );

  const show = useCallback((name: string): void => {
    const entry = BY_NAME.get(name);
    if (entry === undefined || currentRef.current === entry) return;
    currentRef.current = entry;
    setCurrent(entry);
  }, []);

  const navigate = useCallback(
    (entry: Entry): void => {
      if (location.hash === `#${entry.spec.name}`) show(entry.spec.name);
      else location.hash = entry.spec.name;
    },
    [show],
  );

  const setTitleRef = useLatest(setTitle);
  // A newly shown component: top of the pane, the tab title, the rail marker in view.
  useLayoutEffect(() => {
    if (current === null) return;
    if (mainRef.current !== null) mainRef.current.scrollTop = 0;
    setTitleRef.current(`${current.spec.name} · ${SURFACE_TITLE}`);
    const item = navItems.current.get(current.spec.name);
    if (item !== undefined) revealNav(item);
  }, [current, setTitleRef, revealNav]);

  /** Theme first — the mermaid Diagram renderer reads resolved tokens at mount — then the first view. */
  useEffect(() => {
    let live = true;
    // The catalog's scheme rules read this before theme.json lands, as the old page's markup set it.
    document.documentElement.dataset.themeScheme ??= 'dark';
    void applyKryptonTheme()
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
      let name = '';
      try {
        name = decodeURIComponent(location.hash.slice(1));
      } catch {
        name = '';
      }
      if (BY_NAME.has(name)) show(name);
      else if (currentRef.current === null) show(ENTRIES[0].spec.name);
    };
    showFromHash();
    // A palette switch or Reload Config in Krypton lands the next time this tab
    // is looked at; the custom properties repaint the mounted preview with no rebuild.
    let live = true;
    const onFocus = (): void => {
      void applyKryptonTheme()
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
    const index = list.findIndex((entry) => navItems.current.get(entry.spec.name) === active);
    const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
    focusNavItem(list[next]);
  };

  const focusPreview = (): void => {
    const element = detailRef.current;
    if (element === null) return;
    const target =
      element.querySelector<HTMLElement>(`[${FOCUSABLE_ATTR}]`) ??
      element.querySelector<HTMLElement>('.lb-genui__view-actions button');
    target?.focus();
  };

  useKeymap([
    {
      key: ['[', ']'],
      display: '[ / ]',
      label: 'Previous / next component',
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
      label: 'Open the focused component',
      run: (event) => {
        const entry = ENTRIES.find((candidate) => navItems.current.get(candidate.spec.name) === event.target);
        if (entry === undefined) return false;
        const wasOpen = currentRef.current === entry;
        navigate(entry);
        // Only an already-built view can take focus now; a new one lands on hashchange.
        if (wasOpen) focusPreview();
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
    <div className="lb-page lb-page--fill lb-genui">
      <div className="lb-split lb-genui__layout">
        <aside className="lb-genui__side">
          <div className="lb-genui__theme">{themeLabel}</div>
          <SearchFilter
            className="lb-genui__search"
            placeholder="Search name or summary"
            label="Search components"
            value={query}
            onChange={setQuery}
            onSubmit={() => {
              const first = state.current.visible[0];
              if (first === undefined) return;
              navigate(first);
              focusNavItem(first);
            }}
            // One Esc clears the box and leaves it for the open component's index entry.
            escape="clear-and-leave"
            onEscape={() => {
              if (currentRef.current !== null) focusNavItem(currentRef.current);
            }}
            count={
              !started
                ? undefined
                : trimmed === ''
                  ? `${ENTRIES.length} components`
                  : `${visible.length} / ${ENTRIES.length} match`
            }
            inputRef={inputRef}
          />
          <nav className="lb-genui__nav" aria-label="Components" ref={navRef}>
            {GROUPS.map(({ group, entries }) => {
              const shown = entries.filter((entry) => matches(entry, trimmed)).length;
              return (
                <section key={group} className="lb-genui__nav-group" data-group={group} hidden={shown === 0}>
                  <h2 className="lb-genui__nav-heading" data-group={group}>{`${group} · ${shown}`}</h2>
                  {entries.map((entry) => {
                    const name = entry.spec.name;
                    const isCurrent = entry === current;
                    return (
                      <a
                        key={name}
                        className={isCurrent ? 'lb-genui__nav-item lb-genui__nav-item--current' : 'lb-genui__nav-item'}
                        href={`#${name}`}
                        hidden={!matches(entry, trimmed)}
                        aria-current={isCurrent ? 'true' : undefined}
                        ref={(node) => {
                          if (node === null) navItems.current.delete(name);
                          else navItems.current.set(name, node);
                        }}
                      >
                        {name}
                      </a>
                    );
                  })}
                </section>
              );
            })}
          </nav>
          <p className="lb-genui__empty" hidden={!started || visible.length > 0}>
            No component matches.
          </p>
          <KbdHints entries={HINTS} />
        </aside>
        <div className="lb-genui__main" ref={mainRef}>
          <article className="lb-genui__detail" ref={detailRef}>
            {current === null ? null : (
              <EntryView
                key={current.spec.name}
                entry={current}
                preview={previewOf(current)}
                status={statuses.get(current.spec.name) ?? ''}
                sourceOpen={sourceOpen.get(current.spec.name) ?? false}
                onToggleSource={() => {
                  const name = current.spec.name;
                  setSourceOpen((prev) => new Map(prev).set(name, !(prev.get(name) ?? false)));
                }}
              />
            )}
          </article>
          <nav className="lb-genui__pager" aria-label="Previous and next component">
            {pager === null ? null : (
              <>
                <PagerLink entry={pager[0]} direction="prev" />
                <PagerLink entry={pager[1]} direction="next" />
              </>
            )}
          </nav>
          <footer className="lb-genui__foot">
            Fixed local examples through the production compiler and renderer. Draft and OpenUrl show demo feedback; nothing is sent to a lane.
          </footer>
        </div>
      </div>
    </div>
  );
}
