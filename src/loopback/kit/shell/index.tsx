// Spec 341 — the bar every loopback page carries: brand → Home, the
// project / surface location, a `limited` marker without a session, and the
// two shell keys (`` ` `` switcher, `?` keys). It renders at once and never
// waits for the page's data; the navigation context arrives afterwards.
//
// Spec 361: `ShellProvider` owns the navigation context and the title and hands
// them to pages through `useShell()`; `AppShell` is the bar plus its overlays.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { availability, GROUP_TITLES, SURFACES, surfaceById } from '../../surfaces';
import type { NavContext, ProjectEntry, SurfaceId } from '../../surfaces';
import { useKeymap } from '../hooks';
import { KeyHelp } from '../key-help';
import { keymap } from '../lib/keymap';
import type { HelpEntry } from '../lib/keymap';
import { EMPTY_CONTEXT, loadNavContext, rememberProject } from '../lib/nav';
import { Switcher } from '../switcher';
import type { SwitcherItem } from '../switcher';
import { ShellContext, useShell } from './context';
import type { ShellApi } from './context';

import './shell.css';

export { ShellContext, useShell };
export type { ShellApi };

/** Refetch the directory on focus at most this often. */
const FOCUS_REFRESH_MS = 2000;

const SURFACE_PLACEHOLDER = 'Go to a surface or project…';

export interface ShellProviderProps {
  readonly surface: SurfaceId;
  /** Overrides the surface title in the bar (e.g. the open file). */
  readonly title?: string;
  readonly children?: ReactNode;
}

export function ShellProvider({ surface: surfaceId, title: initialTitle, children }: ShellProviderProps): JSX.Element {
  const surface = surfaceById(surfaceId);
  const [context, setContext] = useState<NavContext>(EMPTY_CONTEXT);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [title, setTitle] = useState(initialTitle ?? surface.title);
  const lastRefresh = useRef(0);
  const contextRef = useRef(context);

  const apply = useCallback((next: NavContext): void => {
    contextRef.current = next;
    setContext(next);
    setContextLoaded(true);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    lastRefresh.current = Date.now();
    apply(await loadNavContext());
  }, [apply]);

  const selectProject = useCallback(
    (project: ProjectEntry): void => {
      rememberProject(project.projectId);
      if (surface.scope === 'project') {
        const href = surface.href({ ...contextRef.current, project });
        if (href) {
          location.assign(href);
          return;
        }
      }
      apply({ ...contextRef.current, project });
    },
    [apply, surface],
  );

  useLayoutEffect(() => {
    document.title = `${title} · Krypton`;
  }, [title]);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => {
      if (Date.now() - lastRefresh.current >= FOCUS_REFRESH_MS) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const value = useMemo(
    (): ShellApi => ({ surface, title, context, contextLoaded, setTitle, selectProject, refresh }),
    [surface, title, context, contextLoaded, selectProject, refresh],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

interface SwitcherView {
  readonly items: readonly SwitcherItem[];
  readonly placeholder: string;
}

export function AppShell(): JSX.Element {
  const shell = useShell();
  const { surface, title, context: ctx, contextLoaded } = shell;
  const [open, setOpen] = useState<'switcher' | 'keys' | null>(null);
  // Each overlay keeps its last content while hidden, as the old DOM did.
  const [switcher, setSwitcher] = useState<SwitcherView>({ items: [], placeholder: SURFACE_PLACEHOLDER });
  const [helpEntries, setHelpEntries] = useState<readonly HelpEntry[]>([]);

  const showSwitcher = (kind?: SwitcherItem['kind']): void => {
    const items = switcherItems(shell);
    setSwitcher({
      items: kind ? items.filter((item) => item.kind === kind) : items,
      placeholder: kind === 'project' ? 'Switch project…' : SURFACE_PLACEHOLDER,
    });
    setOpen('switcher');
  };
  const showKeys = (): void => {
    setHelpEntries(keymap().help());
    setOpen('keys');
  };
  const close = (): void => setOpen(null);

  useKeymap([
    { code: 'Backquote', display: '`', label: 'Switch surface or project', group: 'Shell', run: () => showSwitcher() },
    { key: '?', label: 'Keyboard shortcuts', group: 'Shell', run: showKeys },
  ]);

  const showProject = (surface.scope === 'project' || surface.id === 'home') && ctx.project !== null;
  let sessionTitle: string | undefined;
  if (contextLoaded) {
    sessionTitle =
      ctx.session === 'expired'
        ? 'Krypton restarted: reopen from Krypton (#home) to link Terminal Control, ACP wire, Hurl and E2E'
        : 'Opened outside Krypton: reopen from Krypton (#home) to link Terminal Control, ACP wire, Hurl and E2E';
  }

  return (
    <>
      <div className="lb-shell__bar">
        <a className="lb-shell__brand" href="/" title="Home">
          <span className="lb-shell__mark">K</span>
          <span className="lb-shell__name">Krypton</span>
        </a>
        <nav className="lb-shell__crumbs" aria-label="Location">
          <span className="lb-shell__sep">/</span>
          <button
            className="lb-shell__project"
            type="button"
            hidden={!showProject}
            title={ctx.project ? `${ctx.project.dir} — switch project` : undefined}
            onClick={() => showSwitcher('project')}
          >
            {ctx.project ? `${ctx.project.name} ▾` : null}
          </button>
          <span className="lb-shell__sep" hidden={!showProject}>
            /
          </span>
          <span className="lb-shell__surface">{title}</span>
        </nav>
        <span className="lb-shell__spacer" />
        <span className="lb-shell__session" hidden={!contextLoaded || ctx.capabilities !== null} title={sessionTitle}>
          limited
        </span>
        <button className="lb-shell__action" type="button" title="Switch surface or project" onClick={() => showSwitcher()}>
          <kbd>`</kbd> Switch
        </button>
        <button className="lb-shell__action" type="button" title="Keyboard shortcuts" onClick={showKeys}>
          <kbd>?</kbd> Keys
        </button>
      </div>
      {createPortal(
        <>
          <Switcher open={open === 'switcher'} items={switcher.items} placeholder={switcher.placeholder} onClose={close} />
          <KeyHelp open={open === 'keys'} entries={helpEntries} onClose={close} />
        </>,
        document.body,
      )}
    </>
  );
}

function switcherItems(shell: ShellApi): SwitcherItem[] {
  const { context: ctx } = shell;
  const surfaces = SURFACES.map((def): SwitcherItem => {
    const state = availability(def, ctx);
    const scopeNote = def.scope === 'project' && ctx.project ? ` · ${ctx.project.name}` : '';
    return {
      id: def.id,
      kind: 'surface',
      title: def.title,
      meta: `${GROUP_TITLES[def.group]}${scopeNote}`,
      disabledReason: state.href === null ? state.reason : undefined,
      current: def.id === shell.surface.id,
      run: () => {
        if (state.href !== null) location.assign(state.href);
      },
    };
  });
  const projects = ctx.directory.projects.map(
    (project): SwitcherItem => ({
      id: project.projectId,
      kind: 'project',
      title: project.name,
      meta: `project · ${project.dir}`,
      current: project.projectId === ctx.project?.projectId,
      run: () => shell.selectProject(project),
    }),
  );
  return [...surfaces, ...projects];
}
