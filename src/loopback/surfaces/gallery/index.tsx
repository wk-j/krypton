// Spec 170 / 173 / 265 / 341 / 361 — the artifact gallery: every project's HTML
// artifacts as cards, `all` + one tab per project, polled from `/artifacts`.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { Card, Dot, EmptyState, fetchJson, formatBytes, KbdHints, Pill, poll, StatBar, statusTone, Tabs, useKeymap, useLatest, useShell } from '../../kit';
import type { PollStatus, TabItem } from '../../kit';

import './gallery.css';

export const POLL_MS = 1000;
const ALL = '';

export interface GalleryArtifact {
  readonly id: string;
  readonly state?: string;
  readonly size?: number;
  readonly hash?: string;
  readonly token?: string;
  readonly title?: string;
  readonly laneLabel?: string;
  readonly tail?: string;
}

export interface GalleryProject {
  readonly projectId: string;
  readonly projectName?: string;
  readonly artifacts?: readonly GalleryArtifact[];
}

type ArtState = 'live' | 'pending';

function stateKey(state: string | undefined): ArtState {
  return state === 'live' ? 'live' : 'pending';
}

function artifactsOf(project: GalleryProject): readonly GalleryArtifact[] {
  return Array.isArray(project.artifacts) ? project.artifacts : [];
}

/** Same-basename projects gain the tail of their opaque id (spec 265). */
export function projectLabels(projects: readonly GalleryProject[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const p of projects) {
    const name = p.projectName || 'project';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const p of projects) {
    const name = p.projectName || 'project';
    const suffix = String(p.projectId || '').replace(/^project-/, '').slice(-6);
    labels.set(p.projectId, (counts.get(name) ?? 0) > 1 ? `${name} · ${suffix}` : name);
  }
  return labels;
}

function signature(projects: readonly GalleryProject[]): string {
  return JSON.stringify(
    projects.map((p) => [
      p.projectId,
      p.projectName,
      artifactsOf(p).map((a) => [a.id, a.state, a.size, a.hash, a.token, a.title, a.laneLabel, a.tail]),
    ]),
  );
}


function sameArtifact(a: GalleryArtifact, b: GalleryArtifact): boolean {
  return (
    a.state === b.state &&
    a.size === b.size &&
    a.hash === b.hash &&
    a.token === b.token &&
    a.title === b.title &&
    a.laneLabel === b.laneLabel &&
    a.tail === b.tail
  );
}

const ArtifactCard = memo(
  function ArtifactCard({ art: a }: { readonly art: GalleryArtifact }): JSX.Element {
    const sk = stateKey(a.state);
    return (
      <Card tag="article" className="lb-gallery__art" data-state={sk}>
        <div className="lb-gallery__head">
          <div className="lb-gallery__title">{a.title || 'untitled'}</div>
          <Pill label={sk} tone={statusTone(sk)} />
        </div>
        <div className="lb-gallery__lane">{a.laneLabel || '?'}</div>
        <div className="lb-gallery__meta">
          <span className="lb-gallery__size">{sk === 'live' ? formatBytes(Number(a.size) || 0) : 'writing…'}</span>
        </div>
        <div className="lb-gallery__tail">{(a.hash ? `${String(a.hash).slice(0, 12)} · ` : '') + (a.tail || '')}</div>
        {sk === 'live' && a.token ? (
          <a
            className="lb-btn lb-btn--primary lb-gallery__open"
            href={`/artifact/${encodeURIComponent(a.token)}`}
            target="_blank"
            rel="noopener"
          >
            Open
          </a>
        ) : (
          <span className="lb-btn lb-btn--secondary lb-gallery__open" aria-disabled="true">
            pending
          </span>
        )}
      </Card>
    );
  },
  (prev, next) => sameArtifact(prev.art, next.art),
);

interface SectionProps {
  readonly project: GalleryProject;
  readonly label: string;
  readonly showHead: boolean;
}

const ProjectSection = memo(
  function ProjectSection({ project, label, showHead }: SectionProps): JSX.Element {
    const arts = artifactsOf(project);
    return (
      <section className="lb-gallery__project">
        <div className="lb-gallery__project-head" hidden={!showHead}>
          <h2 className="lb-h2 lb-gallery__name">{label}</h2>
          <div className="lb-gallery__count">{`${arts.length} ${arts.length === 1 ? 'artifact' : 'artifacts'}`}</div>
        </div>
        <div className="lb-gallery__cards">
          {arts.map((a) => (
            <ArtifactCard key={a.id} art={a} />
          ))}
        </div>
      </section>
    );
  },
  (prev, next) =>
    prev.label === next.label && prev.showHead === next.showHead && signature([prev.project]) === signature([next.project]),
);

function totals(projects: readonly GalleryProject[]): { total: number; live: number; pending: number } {
  let total = 0;
  let live = 0;
  for (const p of projects) {
    for (const a of artifactsOf(p)) {
      total++;
      if (stateKey(a.state) === 'live') live++;
    }
  }
  return { total, live, pending: total - live };
}

/** The shell's project, when the reader has not picked a tab and it has artifacts. */
function adopted(projects: readonly GalleryProject[], ctxProject: string | null, picked: boolean): string | null {
  if (picked || !ctxProject) return null;
  const match = projects.find((p) => p.projectId === ctxProject);
  return match && artifactsOf(match).length > 0 ? match.projectId : null;
}

/** Fall back to `all` when the active project vanished or nothing is registered. */
function normalized(projects: readonly GalleryProject[], active: string): string {
  if (active && !projects.some((p) => p.projectId === active)) return ALL;
  if (totals(projects).total === 0) return ALL;
  return active;
}

const HINTS: readonly (readonly [string, string])[] = [
  ['[ ]', 'switch project'],
  ['1–9', 'jump'],
  ['0', 'all projects'],
];

export function GalleryPage(): JSX.Element {
  const { context } = useShell();
  const ctxProject = context.project?.projectId ?? null;
  const [projects, setProjects] = useState<readonly GalleryProject[] | null>(null);
  /** `''` = the all tab. In memory only; kept across polls. */
  const [active, setActive] = useState(ALL);
  const [reconnecting, setReconnecting] = useState(false);
  /** Once the reader picks a tab, the shell's project no longer steers it. */
  const picked = useRef(false);
  const ctxRef = useLatest(ctxProject);

  useEffect(() => {
    const poller = poll<readonly GalleryProject[]>({
      load: async (signal) => {
        const body = await fetchJson<{ projects?: unknown }>('/artifacts', { signal });
        return Array.isArray(body?.projects) ? (body.projects as GalleryProject[]) : [];
      },
      apply: (next) => {
        setProjects(next);
        setReconnecting(false);
        setActive((prev) => normalized(next, adopted(next, ctxRef.current, picked.current) ?? prev));
      },
      onStatus: (s: PollStatus) => {
        if (s === 'reconnecting') setReconnecting(true);
        else if (s === 'ok') setReconnecting(false);
      },
      intervalMs: POLL_MS,
      signature,
    });
    return () => poller.dispose();
  }, [ctxRef]);

  useEffect(() => {
    if (!projects) return;
    const id = adopted(projects, ctxProject, picked.current);
    if (id !== null) setActive(id);
  }, [ctxProject, projects]);

  const list = projects ?? [];
  const activeRef = useLatest(active);
  const pick = useCallback(
    (id: string): void => {
      picked.current = true;
      if (activeRef.current === id) return;
      activeRef.current = id;
      setActive(id);
      window.scrollTo({ top: 0 });
    },
    [activeRef],
  );

  useKeymap([
    {
      key: '0',
      label: 'All projects',
      run: () => {
        if (list.length === 0) return false;
        pick(ALL);
      },
    },
  ]);

  const { total, live, pending } = totals(list);
  const labels = projectLabels(list);
  const tabs: TabItem[] = [{ id: ALL, label: 'all', count: total }];
  for (const p of list) tabs.push({ id: p.projectId, label: labels.get(p.projectId) ?? 'project', count: artifactsOf(p).length });
  const visible = active ? list.filter((p) => p.projectId === active) : list;
  const loaded = projects !== null;
  const emptyText = !loaded
    ? null
    : total === 0
      ? 'No artifacts yet — lanes will surface HTML artifacts here as they register them.'
      : visible.length === 0
        ? 'No artifacts for this project.'
        : null;
  const status = !loaded
    ? 'connecting…'
    : reconnecting
      ? 'reconnecting…'
      : total === 0
        ? 'no artifacts yet'
        : active
          ? `live gallery · ${labels.get(active) ?? 'project'}`
          : 'live gallery';

  return (
    <div className="lb-page lb-gallery">
      <div className="lb-gallery__top">
        <div className="lb-gallery__state">
          <span className="lb-gallery__dot">
            <Dot state={total > 0 ? 'live' : 'idle'} />
          </span>
          <span className="lb-gallery__status">{status}</span>
        </div>
        <StatBar
          align="end"
          stats={
            loaded
              ? [
                  { key: 'total', label: 'artifacts', value: total },
                  { key: 'live', label: 'live', value: live, tone: 'add' },
                  { key: 'pending', label: 'pending', value: pending },
                ]
              : []
          }
        />
      </div>
      <Tabs
        label="Project"
        keys
        numberFrom={1}
        sticky
        hidden={list.length === 0}
        tabs={list.length === 0 ? [] : tabs}
        active={active}
        onSelect={pick}
      />
      <div className="lb-gallery__projects">
        {(total === 0 ? [] : visible).map((p) => (
          <ProjectSection key={p.projectId} project={p} label={labels.get(p.projectId) ?? 'project'} showHead={!active} />
        ))}
      </div>
      <div className="lb-gallery__empty" hidden={loaded && emptyText === null}>
        {emptyText ? <EmptyState text={emptyText} /> : null}
      </div>
      <KbdHints entries={HINTS} note="read-only gallery · polls /artifacts · open links serve the registered artifact on this origin" />
    </div>
  );
}
