// Spec 400 (revision): the project's bug-trail index — `/trail?project=<id>`
// without `issue`. Every row's status comes from the issue view's own model
// (`frame` / `trailStatus` / `gapText` / `stateLine`) on the trail's last step,
// so the index and the trail can never disagree.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { Banner, EmptyState, fetchJson, HttpError, KbdHints, Pill, useKeymap, useShell } from '../../kit';
import { frame, gapText, stateLine, trailStatus } from './model';
import type { CheckStatus, TrailIndex, TrailPayload } from './types';

const INDEX_HINTS: readonly (readonly [string, string])[] = [
  ['j / k', 'move'],
  ['Enter', 'open'],
];

/** A check Krypton ran and that failed (unchecked / not-run / untrusted are not failures). */
const FAILING: ReadonlySet<CheckStatus> = new Set<CheckStatus>(['mismatch', 'missing', 'unknown', 'unavailable', 'unexpected']);

export interface IndexRow {
  readonly issue: string;
  readonly title: string | null;
  readonly href: string;
  readonly status: ReturnType<typeof trailStatus>;
  readonly openDecisions: number;
  readonly steps: number;
  readonly commit: string;
  readonly gap: boolean;
  readonly problems: number;
  readonly stateWarn: boolean;
}

/** One index row per trail, derived from the full payload. Pure. */
export function indexRow(projectId: string, trail: TrailPayload): IndexRow {
  const f = frame(trail, trail.steps.length - 1);
  const failing = trail.steps.reduce((n, step) => n + step.evidence.filter((e) => FAILING.has(e.status)).length, 0);
  return {
    issue: trail.issue,
    title: trail.title,
    href: `/trail?project=${encodeURIComponent(projectId)}&issue=${encodeURIComponent(trail.issue.replace('#', '/'))}`,
    status: trailStatus(f),
    openDecisions: f.openDecisions,
    steps: trail.steps.length,
    commit: trail.commit.slice(0, 8),
    gap: gapText(trail, f) !== null,
    problems: failing + trail.errors.length + trail.map.errors.length,
    stateWarn: stateLine(trail).warn,
  };
}

function loadErrorText(error: unknown): string {
  if (error instanceof HttpError && error.status === 404) return 'No open project with that id. Open Bug trails from Krypton Home.';
  return `The trails could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
}

function rowMeta(row: IndexRow): string {
  const parts = [`${row.steps} step${row.steps === 1 ? '' : 's'}`, `analysis @ ${row.commit}`];
  if (row.gap) parts.push('not reproduced');
  if (row.problems > 0) parts.push(`${row.problems} failing check${row.problems === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function TrailIndexPage(): JSX.Element {
  const { setTitle } = useShell();
  const [index, setIndex] = useState<TrailIndex | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cur, setCur] = useState(0);
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchJson<TrailIndex>(`/trail.json${location.search}`, { signal: controller.signal })
      .then(setIndex)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(loadErrorText(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (index) setTitle(`Bug trails · ${index.projectName}`);
  }, [index, setTitle]);

  const rows = index ? index.trails.map((trail) => indexRow(index.projectId, trail)) : [];
  const last = Math.max(rows.length - 1, 0);

  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.lb-trail__entry--current')?.scrollIntoView?.({ block: 'nearest' });
  }, [cur, index]);

  useKeymap([
    { key: ['j', 'ArrowDown'], label: 'Next trail', run: () => setCur((c) => Math.min(c + 1, last)) },
    { key: ['k', 'ArrowUp'], label: 'Previous trail', run: () => setCur((c) => Math.max(c - 1, 0)) },
    {
      key: 'Enter',
      label: 'Open the trail',
      run: () => {
        const row = rows[cur];
        if (!row) return false;
        location.assign(row.href);
      },
    },
  ]);

  if (loadError) {
    return (
      <div className="lb-page lb-trail">
        <Banner text={loadError} tone="error" />
      </div>
    );
  }
  if (!index) return <div className="lb-page lb-trail" />;

  return (
    <div className="lb-page lb-trail">
      <header className="lb-trail__head">
        <div className="lb-trail__titles">
          <h1 className="lb-trail__title">Bug trails</h1>
          <div className="lb-trail__meta">
            <span>{index.projectName}</span>
            <span>{`${rows.length} trail${rows.length === 1 ? '' : 's'}`}</span>
          </div>
        </div>
      </header>
      {rows.length ? (
        <ol className="lb-trail__index" ref={listRef}>
          {rows.map((row, i) => (
            <li key={row.issue} className={i === cur ? 'lb-trail__entry lb-trail__entry--current' : 'lb-trail__entry'}>
              <a className="lb-trail__entry-link" href={row.href} onFocus={() => setCur(i)}>
                <span className="lb-trail__entry-key">{row.issue}</span>
                <span className="lb-trail__entry-title">{row.title ?? ''}</span>
                <span className="lb-trail__entry-pills">
                  <Pill label={row.status.label} tone={row.status.tone} />
                  {row.openDecisions > 0 ? (
                    <Pill label={`${row.openDecisions} decision${row.openDecisions === 1 ? '' : 's'} open`} tone="accent" />
                  ) : null}
                </span>
                <span className={row.problems > 0 ? 'lb-trail__entry-meta lb-trail__entry-meta--warn' : 'lb-trail__entry-meta'}>
                  {rowMeta(row)}
                </span>
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState text="No bug trails yet. Analyze a bug issue in Krypton (Analyze, or #analyze-github-issue) and its trail appears here." />
      )}
      <KbdHints entries={INDEX_HINTS} />
    </div>
  );
}
