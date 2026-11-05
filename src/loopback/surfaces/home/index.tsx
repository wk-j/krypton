// Spec 341 — Home: the stat strip, the project picker and one tile per
// surface, grouped Monitor / Project / Reference. A tile that cannot open in
// this context stays in place, muted, with the reason.
// Spec 361: a React page over `useShell().context`; no polling — the shell
// refetches the context when the tab regains focus.

import { useRef, useState } from 'react';
import type { JSX } from 'react';

import { Chip, Dot, EmptyState, KbdHints, matchesQuery, SearchFilter, StatBar, useKeymap, useShell } from '../../kit';
import type { Stat } from '../../kit';
import { availability, GROUP_TITLES, SURFACES } from '../../surfaces';
import type { NavContext, SurfaceDef, SurfaceGroup } from '../../surfaces';

import './home.css';

const GROUP_ORDER: readonly SurfaceGroup[] = ['monitor', 'project', 'reference'];

const HINTS: readonly (readonly [string, string])[] = [
  ['/', 'filter'],
  ['j / k', 'move'],
  ['Enter', 'open'],
  ['`', 'switch'],
  ['?', 'keys'],
];

/** The live count a tile can show from the directory alone (no extra fetch). */
export function tileCount(def: SurfaceDef, ctx: NavContext): { text: string; alert: boolean } | null {
  const projects = ctx.directory.projects;
  if (def.id === 'dashboard') {
    const total = projects.reduce((n, p) => n + p.lanes.total, 0);
    if (total === 0) return null;
    const attention = projects.reduce((n, p) => n + p.attention, 0);
    const busy = projects.reduce((n, p) => n + p.lanes.busy, 0);
    return { text: attention > 0 ? `${attention} flagged` : `${busy}/${total} busy`, alert: attention > 0 };
  }
  if (def.id === 'gallery') {
    const live = projects.reduce((n, p) => n + p.artifacts.live, 0);
    const pending = projects.reduce((n, p) => n + p.artifacts.pending, 0);
    if (live + pending === 0) return null;
    return { text: pending > 0 ? `${live} live · ${pending} pending` : `${live} live`, alert: false };
  }
  return null;
}

function homeStats(ctx: NavContext): Stat[] {
  const projects = ctx.directory.projects;
  return [
    { key: 'projects', label: 'projects', value: projects.length },
    {
      key: 'lanes',
      label: 'lanes busy',
      value: `${projects.reduce((n, p) => n + p.lanes.busy, 0)}/${projects.reduce((n, p) => n + p.lanes.total, 0)}`,
    },
    { key: 'artifacts', label: 'live artifacts', value: projects.reduce((n, p) => n + p.artifacts.live, 0) },
    {
      key: 'attention',
      label: 'attention',
      value: projects.reduce((n, p) => n + p.attention, 0),
      tone: projects.some((p) => p.attention > 0) ? 'del' : 'muted',
    },
  ];
}

function Tile({ def, ctx }: { readonly def: SurfaceDef; readonly ctx: NavContext }): JSX.Element {
  const state = availability(def, ctx);
  const count = tileCount(def, ctx);
  const body = (
    <>
      <span className="lb-tile__title">{def.title}</span>
      <span className="lb-tile__summary">{state.href === null ? state.reason : def.summary}</span>
      <div className="lb-tile__meta">
        {def.scope === 'project' && ctx.project ? <span className="lb-tile__scope">{ctx.project.name}</span> : null}
        {def.access === 'capability' ? <span className="lb-tile__scope">session</span> : null}
        {count ? <Chip text={count.text} alert={count.alert} /> : null}
      </div>
    </>
  );
  if (state.href === null) {
    return (
      <div className="lb-tile lb-tile--off" aria-disabled="true">
        {body}
      </div>
    );
  }
  return (
    <a className="lb-tile" href={state.href}>
      {body}
    </a>
  );
}

export function HomePage(): JSX.Element {
  const { context: ctx, contextLoaded, selectProject } = useShell();
  const [query, setQuery] = useState('');
  const groupsRef = useRef<HTMLDivElement>(null);

  const tiles = (): HTMLAnchorElement[] => [...(groupsRef.current?.querySelectorAll<HTMLAnchorElement>('a.lb-tile') ?? [])];

  const moveFocus = (delta: number): void => {
    const all = tiles();
    if (all.length === 0) return;
    const index = all.indexOf(document.activeElement as HTMLAnchorElement);
    const next = index < 0 ? (delta > 0 ? 0 : all.length - 1) : (index + delta + all.length) % all.length;
    all[next].focus();
  };

  useKeymap([
    { key: ['j', 'ArrowDown', 'ArrowRight'], label: 'Next tile', run: () => moveFocus(1) },
    { key: ['k', 'ArrowUp', 'ArrowLeft'], label: 'Previous tile', run: () => moveFocus(-1) },
  ]);

  const projects = ctx.directory.projects;
  const sections = contextLoaded
    ? GROUP_ORDER.map((group) => ({
        group,
        defs: SURFACES.filter(
          (def) => def.group === group && def.id !== 'home' && matchesQuery(`${def.title} ${def.summary}`, query),
        ),
      })).filter((section) => section.defs.length > 0)
    : [];
  const openCount = sections.reduce((n, s) => n + s.defs.filter((def) => availability(def, ctx).href !== null).length, 0);

  return (
    <div className="lb-page lb-home">
      <header className="lb-home__head">
        <div className="lb-home__intro">
          <h1 className="lb-home__title">Krypton</h1>
          <p className="lb-home__sub">Every loopback surface for the harnesses open in Krypton.</p>
        </div>
        <StatBar stats={contextLoaded ? homeStats(ctx) : []} align="end" />
      </header>
      <div className="lb-home__projects" role="group" aria-label="Project">
        {contextLoaded ? (
          <>
            <span className="lb-home__label">Project</span>
            {projects.length === 0 ? (
              <span className="lb-home__none">No harness is open in Krypton.</span>
            ) : (
              projects.map((project) => (
                <button
                  key={project.projectId}
                  className="lb-home__project"
                  title={project.dir}
                  type="button"
                  aria-pressed={project.projectId === ctx.project?.projectId}
                  onClick={(): void => selectProject(project)}
                >
                  <Dot state={project.lanes.busy > 0 ? 'live' : 'idle'} />
                  <span>{project.name}</span>
                  <span className="lb-home__project-meta">{`${project.lanes.total} lanes`}</span>
                </button>
              ))
            )}
          </>
        ) : null}
      </div>
      <div className="lb-home__filter">
        <SearchFilter
          placeholder="Filter surfaces"
          value={query}
          onChange={setQuery}
          onSubmit={(): void => tiles()[0]?.click()}
          onEscape={(): void => tiles()[0]?.focus()}
          count={contextLoaded && query ? `${openCount} open` : ''}
        />
      </div>
      <div ref={groupsRef} className="lb-home__groups">
        {!contextLoaded ? null : sections.length > 0 ? (
          sections.map(({ group, defs }) => (
            <section key={group} className="lb-home__group">
              <h2 className="lb-h3">{GROUP_TITLES[group]}</h2>
              <div className="lb-home__grid">
                {defs.map((def) => (
                  <Tile key={def.id} def={def} ctx={ctx} />
                ))}
              </div>
            </section>
          ))
        ) : (
          <EmptyState text="No surface matches the filter." />
        )}
      </div>
      <KbdHints entries={HINTS} note="refreshes when this tab regains focus" />
    </div>
  );
}
