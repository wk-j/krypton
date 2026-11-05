// Spec 329 / 341 — the e2e explorer: a read-only browser over the project's
// e2e cases, their runs, each run's checks, log and artifacts. Ported from the
// self-contained `src/acp/artifact-e2e.html` into the loopback app. Spec 355
// adds the system map: a run's checks pinned on its case's map (`./map.ts`).
// Spec 361: React. The run pane keeps the old one-paint switch: the shown case
// and run (`shownCase`, `shown`) only move when `/run` answers or the loading
// line is due; the selection (`sel`) moves at once.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX, MouseEvent, ReactNode } from 'react';

import {
  Banner,
  Button,
  copyText,
  Dot,
  EmptyState,
  fetchJson,
  fetchText,
  formatBytes,
  HttpError,
  KbdHints,
  KeyValue,
  pad2,
  Pill,
  poll,
  RosterList,
  SearchFilter,
  StatBar,
  useBanner,
  useKeymap,
  useLatest,
  useShell,
} from '../../kit';
import type { Poller, Stat, Tone } from '../../kit';
import { buildMermaidTheme, renderMermaid } from '../../../acp/harness-mermaid-fence';
import type { MermaidTheme } from '../../../acp/harness-mermaid-fence';
import type { SvgPalette } from '../../../acp/harness-svg-fence';
import { buildPins, countsText, DEFAULT_PIN_COLOURS, hexColour, litNodes, mapSource, MAX_PINS } from './map';
import type { E2eMap, E2eMapEntry, MapPin, PassRun, PinColours, Unplaced } from './map';
import { clip, kindTag, paramsText, resolvePointer, stepLayout, stepLinks } from './checks';
import type { Check, CheckEvidence, PointerHit, StepLinks } from './checks';

import './e2e.css';

const FOCUS_RELOAD_MS = 10000;
const ACTIVE_POLL_MS = 2000;
const LOADING_DELAY_MS = 250;
const FLASH_MS = 4000;
const EXPIRED = 'This link has expired: Krypton restarted. Run #e2e open again.';
const TEXT_EXT = ['json', 'txt', 'log', 'md', 'csv', 'xml', 'yaml', 'yml', 'html', 'htm', 'svg'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
/** The drawn map reaches the DOM only as an inert `<img>` (spec 294), as GenUI's Diagram does. */
const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';
const LETTER: Readonly<Record<string, string>> = {
  PASS: 'P',
  FAIL: 'F',
  ERROR: 'E',
  BLOCKED: 'B',
  CANCELLED: 'C',
  'NO RESULT': '!',
  'INVALID RESULT': '!',
  INTERRUPTED: '!',
};
const RUN_COLUMNS = ['verdict', 'run', 'origin', 'started', 'time', 'checks', 'commit · versions'];
const HINTS: readonly (readonly [string, string])[] = [
  ['/', 'filter'],
  ['j / k', 'move'],
  ['Tab', 'next pane'],
  ['Enter', 'open'],
  ['f', 'failures only'],
  ['m', 'view'],
  ['l', 'log'],
  ['y', 'copy run command'],
  ['r', 'reload'],
  ['Esc', 'close'],
];

export interface E2eCase {
  readonly id: string;
  readonly title: string;
  readonly code: string | null;
  readonly issue: number | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly fresh: Readonly<Record<string, unknown>>;
  readonly files: readonly string[];
  readonly caseHash: string | null;
  readonly uncommitted: boolean;
  /** Spec 355: repo-relative path of the case's system map, a key of `E2eStatus.maps`. */
  readonly map?: string | null;
}

export interface E2eRun {
  readonly caseId: string;
  readonly runId: string;
  readonly origin: string;
  readonly launchId: string | null;
  readonly verdict: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly counts: { pass: number; fail: number; skip: number; blocked: number; info: number };
  readonly versions: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly git: { sha: string; dirty: boolean; branch: string } | null;
  readonly caseHash: string | null;
  readonly exitCode: number | null;
  readonly resultPath: string | null;
  readonly message: string | null;
  readonly argv: readonly string[] | null;
}

interface E2eIssue {
  readonly number: number;
  readonly state: string;
  readonly url: string;
  readonly reportedRunIds: readonly string[];
}

interface ActiveLaunch {
  readonly launchId: string;
  readonly caseId: string;
  readonly startedAt: string;
}

export interface E2eStatus {
  readonly projectName: string;
  readonly initialized: boolean;
  readonly manifest: { readonly name: string } | null;
  readonly errors: readonly string[];
  readonly issues: readonly E2eIssue[] | null;
  readonly issuesError: string | null;
  readonly activeLaunch: ActiveLaunch | null;
  readonly cases: readonly E2eCase[];
  readonly runs: readonly E2eRun[];
  readonly maps?: Readonly<Record<string, E2eMapEntry>>;
}

interface Artifact {
  readonly label: string;
  readonly path: string;
  readonly size: number | null;
  readonly problem: string | null;
  readonly index: number;
}

interface RunDetail {
  readonly info: E2eRun;
  readonly result: { readonly checks?: readonly Check[]; readonly env?: string } | null;
  readonly log: boolean;
  readonly artifacts: readonly Omit<Artifact, 'index'>[];
}

interface DrawnMap {
  readonly kind: 'drawn';
  readonly map: E2eMap;
  readonly pins: readonly MapPin[];
  readonly unplaced: readonly Unplaced[];
  readonly svg: string;
}

/** The shown run on its case's map, or why the run pane fell back to the check list. */
type MapShot = DrawnMap | { readonly kind: 'error'; readonly message: string };

type Pane = 'cases' | 'runs' | 'checks' | 'artifacts';

/** The run pane's layouts, in `m` order (spec 0328 rev 5). */
type Layout = 'map' | 'group' | 'step';

/** The case the case head and the runs pane show (moves with the run pane's paint). */
interface ShownCase {
  readonly c: E2eCase | null;
  readonly runs: readonly E2eRun[];
}

/** The last painted run; `failuresOnly` as it was when the pane last repainted. */
interface ShownRun {
  readonly detail: RunDetail;
  readonly shot: MapShot | null;
  readonly failuresOnly: boolean;
}

type ViewerBody =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }
  | { readonly kind: 'download'; readonly href: string; readonly path: string }
  | { readonly kind: 'pointer'; readonly text: string; readonly note: string | null };

interface Viewer {
  /** Bumped per open, so a late fetch never fills a newer viewer. */
  readonly id: number;
  readonly title: string;
  readonly note: string | null;
  readonly body: ViewerBody;
}

interface Group {
  readonly name: string;
  readonly rows: readonly number[];
}

/** What the run pane's result area shows, in display order. */
type Plan =
  | {
      readonly kind: 'map';
      readonly shot: DrawnMap;
      readonly pins: readonly { readonly pin: MapPin; readonly rows: readonly number[] }[];
      readonly loose: readonly Unplaced[];
    }
  | { readonly kind: 'none'; readonly lead: string | null }
  | { readonly kind: 'group'; readonly lead: string | null; readonly groups: readonly Group[] }
  | {
      readonly kind: 'step';
      readonly lead: string | null;
      readonly preconditions: readonly number[];
      readonly steps: readonly { readonly head: number; readonly rows: readonly number[] }[];
      readonly other: readonly Group[];
    };

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function duration(run: E2eRun): string {
  const a = Date.parse(run.startedAt ?? '');
  const b = Date.parse(run.finishedAt ?? '');
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return '—';
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
}

function verdictTone(verdict: string): Tone {
  if (verdict === 'PASS') return 'add';
  if (verdict === 'BLOCKED') return 'accent';
  if (verdict === 'CANCELLED') return 'muted';
  return 'del';
}

function checkTone(status: string): Tone {
  if (status === 'pass') return 'add';
  if (status === 'fail') return 'del';
  if (status === 'blocked') return 'accent';
  return 'muted';
}

function pairs(record: Readonly<Record<string, unknown>> | null, sep: string): string {
  return record ? Object.keys(record).map((k) => `${k}${sep}${String(record[k])}`).join('  ') : '';
}

/** `KeyValue` rows, dropping empty values as the old page did. */
function Kv({ rows }: { readonly rows: readonly (readonly [string, string | null | undefined])[] }): JSX.Element {
  return <KeyValue entries={rows.filter((row): row is readonly [string, string] => row[1] !== null && row[1] !== undefined && row[1] !== '')} />;
}

/** The route's `{"error"}` text, or its plain body, or the status. */
function failureText(error: unknown): string {
  if (error instanceof HttpError) {
    try {
      const parsed = JSON.parse(error.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* plain text */
    }
    return error.body || `status ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function runsOf(status: E2eStatus | null, caseId: string | null): E2eRun[] {
  return status ? status.runs.filter((r) => r.caseId === caseId) : [];
}

function issueOf(status: E2eStatus | null, c: E2eCase): E2eIssue | null {
  if (!status?.issues || c.issue === null || c.issue === undefined) return null;
  return status.issues.find((i) => i.number === c.issue) ?? null;
}

// Spec 0328 marks, as `e2eCaseMarks` computes them for `#e2e status`.
function marksOf(status: E2eStatus | null, c: E2eCase, runs: readonly E2eRun[]): string[] {
  const marks: string[] = [];
  if (c.uncommitted) marks.push('uncommitted');
  const lastPass = runs.find((r) => r.origin === 'krypton' && r.verdict === 'PASS');
  if (c.caseHash && lastPass?.caseHash && lastPass.caseHash !== c.caseHash) marks.push('edited');
  const issue = issueOf(status, c);
  if (issue) {
    const judged = runs.find((r) => r.verdict === 'PASS' || r.verdict === 'FAIL');
    if (judged && !issue.reportedRunIds.includes(judged.runId)) marks.push('unreported');
  }
  return marks;
}

function visibleCases(status: E2eStatus | null, query: string): readonly E2eCase[] {
  if (!status) return [];
  const q = query.trim().toLowerCase();
  return status.cases.filter(
    (c) => !q || [c.id, c.title, c.code ?? '', c.issue ? `#${c.issue}` : ''].join(' ').toLowerCase().includes(q),
  );
}

/** Rows grouped by `group`, groups in first-appearance order. */
function groupBy(checks: readonly Check[], indexes: readonly number[]): Group[] {
  const groups = new Map<string, number[]>();
  for (const index of indexes) {
    const name = checks[index].group ?? '';
    groups.set(name, [...(groups.get(name) ?? []), index]);
  }
  return [...groups].map(([name, rows]) => ({ name, rows }));
}

/** The shown run's result area for `layout`; `f` trims the lists, never the map picture. */
function planResult(run: ShownRun, checks: readonly Check[], links: StepLinks, layout: Layout): Plan {
  const shows = (index: number): boolean => {
    const status = checks[index].status;
    return !run.failuresOnly || status === 'fail' || status === 'blocked';
  };
  const shot = run.shot;
  if (layout === 'map' && shot?.kind === 'drawn') {
    return {
      kind: 'map',
      shot,
      pins: shot.pins.map((pin) => ({ pin, rows: pin.checks.filter(shows) })).filter((pin) => pin.rows.length > 0),
      loose: shot.unplaced.filter((u) => shows(u.index)),
    };
  }
  const lead = shot?.kind === 'error' ? shot.message : null;
  if (!run.detail.result) return { kind: 'none', lead };
  if (layout === 'step') {
    // Spec 0328 rev 5: preconditions, then each step with the rows that link to it, then the rest by group.
    const steps = stepLayout(checks, links);
    return {
      kind: 'step',
      lead,
      preconditions: steps.preconditions.filter(shows),
      steps: steps.steps
        .map((step) => ({ head: step.head, rows: step.rows.filter(shows), keep: shows(step.head) }))
        .filter((step) => step.rows.length > 0 || step.keep)
        .map(({ head, rows }) => ({ head, rows })),
      other: groupBy(checks, steps.other.filter(shows)),
    };
  }
  return { kind: 'group', lead, groups: groupBy(checks, checks.map((_, index) => index).filter(shows)) };
}

/** Check indexes in display order: the stops of the `checks` pane's cursor are the ones with evidence. */
function planOrder(plan: Plan): number[] {
  switch (plan.kind) {
    case 'map':
      return [...plan.pins.flatMap((pin) => pin.rows), ...plan.loose.map((u) => u.index)];
    case 'none':
      return [];
    case 'group':
      return plan.groups.flatMap((group) => group.rows);
    case 'step':
      return [
        ...plan.preconditions,
        ...plan.steps.flatMap((step) => [step.head, ...step.rows]),
        ...plan.other.flatMap((group) => group.rows),
      ];
  }
}

/** The page is fixed dark with its own tokens, not the app's `--krypton-*` ones `readSvgPalette` reads. */
function readMapStyle(): { theme: MermaidTheme; colours: PinColours } {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string): string => style.getPropertyValue(name).trim();
  const sources: ReadonlyArray<readonly [keyof SvgPalette, string]> = [
    ['fg', '--fg'],
    ['muted', '--muted'],
    ['border', '--border'],
    ['accent', '--accent'],
    ['success', '--add'],
    ['error', '--del'],
    ['surface', '--card'],
  ];
  const palette: SvgPalette = {};
  for (const [key, name] of sources) {
    const value = token(name);
    if (value) palette[key] = value;
  }
  return {
    theme: buildMermaidTheme(palette, token('--mono'), true),
    colours: {
      pass: hexColour(token('--add')) ?? DEFAULT_PIN_COLOURS.pass,
      fail: hexColour(token('--del')) ?? DEFAULT_PIN_COLOURS.fail,
      blocked: hexColour(token('--accent')) ?? DEFAULT_PIN_COLOURS.blocked,
      muted: hexColour(token('--muted')) ?? DEFAULT_PIN_COLOURS.muted,
    },
  };
}

function caseRow(status: E2eStatus | null, c: E2eCase): JSX.Element {
  const runs = runsOf(status, c.id);
  const latest = runs[0];
  const marks = marksOf(status, c, runs);
  return (
    <span className="lb-e2e__case">
      <span className="lb-e2e__row">
        <span className="lb-e2e__case-id">{c.id}</span>
        <Pill label={latest ? latest.verdict : 'NEVER RUN'} tone={latest ? verdictTone(latest.verdict) : 'muted'} />
      </span>
      <span className="lb-e2e__case-title">{c.title}</span>
      <span className="lb-e2e__row">
        <span className="lb-e2e__strip">
          {runs.slice(0, 10).map((r) => {
            const letter = LETTER[r.verdict] ?? '!';
            return (
              <span key={r.runId} className={`lb-e2e__strip--${letter === '!' ? 'X' : letter}`}>
                {letter}
              </span>
            );
          })}
        </span>
        <span className="lb-muted lb-e2e__meta">{[c.code, c.issue ? `#${c.issue}` : null].filter(Boolean).join(' · ')}</span>
      </span>
      {marks.length ? (
        <span className="lb-e2e__marks">
          {marks.map((m) => (
            <span key={m} className="lb-e2e__mark">
              {m}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function runRow(r: E2eRun): JSX.Element {
  const commit = r.git ? `${r.git.sha.slice(0, 8)}${r.git.dirty ? '*' : ''} ${r.git.branch}` : '';
  const versions = Object.keys(r.versions)
    .map((k) => `${k} ${r.versions[k]}`)
    .join(' · ');
  return (
    <span className="lb-e2e__run-row">
      <span>
        <Pill label={r.verdict} tone={verdictTone(r.verdict)} />
      </span>
      <span>{r.runId}</span>
      <span className="lb-muted">{r.origin}</span>
      <span>{when(r.startedAt)}</span>
      <span>{duration(r)}</span>
      <span>{`${r.counts.pass}✓ ${r.counts.fail + r.counts.blocked}✗`}</span>
      <span className="lb-muted">{[commit, versions].filter(Boolean).join(' · ')}</span>
    </span>
  );
}

function artifactRow(a: Artifact): JSX.Element {
  return (
    <span className="lb-e2e__artifact">
      <span>{a.label}</span>
      <span className="lb-muted">{a.path}</span>
      <span className={a.problem ? 'lb-e2e__problem' : 'lb-muted'}>{a.problem ?? (a.size === null ? '' : formatBytes(a.size))}</span>
    </span>
  );
}

function ViewerContent({ body }: { readonly body: ViewerBody }): JSX.Element {
  switch (body.kind) {
    case 'text':
      return <pre className="lb-e2e__viewer-text">{body.text}</pre>;
    case 'image':
      return <img className="lb-e2e__viewer-img" alt={body.alt} src={body.src} />;
    case 'download':
      return (
        <pre className="lb-e2e__viewer-text">
          <a href={body.href}>{`download ${body.path}`}</a>
        </pre>
      );
    case 'pointer':
      return (
        <div>
          <Banner text={body.note ?? ''} tone={body.note ? 'info' : undefined} hidden={body.note === null} />
          <pre className="lb-e2e__viewer-text">{body.text}</pre>
        </div>
      );
  }
}

export function E2ePage(): JSX.Element {
  const { setTitle } = useShell();
  // The link's token is the last path segment of `/e2e/<token>`.
  const [api] = useState(
    () => `/e2e/api/${encodeURIComponent(decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? ''))}`,
  );
  const flash = useBanner();

  const [status, setStatus] = useState<E2eStatus | null>(null);
  /** The `Loaded` stat; null until the first load starts (an empty stat bar, as before). */
  const [loaded, setLoaded] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [query, setQuery] = useState('');
  /** The case list is first filled by a status or by typing in the filter. */
  const [filterTouched, setFilterTouched] = useState(false);
  const [caseSel, setCaseSel] = useState<string | null>(null);
  const [runSel, setRunSel] = useState<string | null>(null);
  /** Null until the first paint: the runs list shows no `No runs yet` line before it, as before. */
  const [shownCase, setShownCase] = useState<ShownCase | null>(null);
  const [shown, setShown] = useState<ShownRun | null>(null);
  /** An empty-state line in the run pane instead of `shown` (`Select a run`, `loading run…`, a failure). */
  const [boxText, setBoxText] = useState<string | null>('Select a run');
  /** The run behind the log, artifact and evidence actions; null while a newly selected run loads. */
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [pane, setPane] = useState<Pane>('cases');
  /** `m`: map (default when the case has one) → by group → by step; kept across runs. */
  const [layout, setLayout] = useState<Layout>('map');
  /** Index into the shown checks of the row under the `checks` pane's cursor. */
  const [cursor, setCursor] = useState<number | null>(null);
  const [cursorScroll, setCursorScroll] = useState(0);
  const [selectedArtifact, setSelectedArtifact] = useState(0);
  const [viewer, setViewer] = useState<Viewer | null>(null);

  const statusRef = useRef<E2eStatus | null>(null);
  const sel = useRef<{ caseId: string | null; runId: string | null }>({ caseId: null, runId: null });
  const failuresOnly = useRef(false);
  const poller = useRef<Poller | null>(null);
  const activeTimer = useRef<number | undefined>(undefined);
  const loadingTimer = useRef<number | undefined>(undefined);
  const detailRequest = useRef(0);
  const retriedMissingRun = useRef(false);
  const mapStyle = useRef<{ readonly theme: MermaidTheme; readonly colours: PinColours } | null>(null);
  const viewerSeq = useRef(0);
  const filterInput = useRef<HTMLInputElement | null>(null);
  const runBox = useRef<HTMLDivElement>(null);
  const viewerBox = useRef<HTMLDivElement>(null);

  // ── derived from the last painted run ──

  const checks = useMemo((): readonly Check[] => {
    const list = shown?.detail.result?.checks;
    return Array.isArray(list) ? list : [];
  }, [shown]);
  const links = useMemo(() => stepLinks(checks), [checks]);
  /** The layouts the shown run offers, in `m` order. */
  const layouts = useMemo((): Layout[] => {
    const out: Layout[] = [];
    if (shown?.shot?.kind === 'drawn' && shown.detail.result) out.push('map');
    out.push('group');
    if (links.heads.length) out.push('step');
    return out;
  }, [shown, links]);
  /** The chosen layout when this run offers it, else the grouped list. */
  const shownLayout: Layout = layouts.includes(layout) ? layout : 'group';
  const plan = useMemo(() => (shown ? planResult(shown, checks, links, shownLayout) : null), [shown, checks, links, shownLayout]);
  /** Rows with `evidence`, in display order. */
  const evidence = useMemo(() => (plan ? planOrder(plan).filter((index) => checks[index].evidence) : []), [plan, checks]);
  const artifactItems = useMemo(
    (): readonly Artifact[] => (shown ? shown.detail.artifacts.map((a, index) => ({ ...a, index })) : []),
    [shown],
  );

  // Keep the cursor on its row across repaints; leave the `checks` pane when no shown row has evidence.
  useLayoutEffect(() => {
    if (cursor !== null && evidence.includes(cursor)) return;
    const first = evidence[0] ?? null;
    if (first !== cursor) setCursor(first);
    if (first === null && pane === 'checks') setPane('runs');
  }, [evidence, cursor, pane]);

  useLayoutEffect(() => {
    if (cursorScroll) runBox.current?.querySelector<HTMLElement>('.lb-e2e__check--cursor')?.scrollIntoView?.({ block: 'nearest' });
  }, [cursorScroll]);

  const viewerId = viewer?.id ?? null;
  useLayoutEffect(() => {
    if (viewerId !== null) viewerBox.current?.scrollIntoView?.({ block: 'nearest' });
  }, [viewerId]);

  useEffect(() => {
    if (status) setTitle(status.manifest ? status.manifest.name : status.projectName);
  }, [status, setTitle]);

  // ── loading ──

  const writeHash = (): void => {
    const params = new URLSearchParams();
    if (sel.current.caseId) params.set('case', sel.current.caseId);
    if (sel.current.runId) params.set('run', sel.current.runId);
    const hash = params.toString();
    history.replaceState(null, '', location.pathname + location.search + (hash ? `#${hash}` : ''));
  };

  /** The newest PASS older than `runId`, when this run did not pass; null when there is none or it cannot load. */
  const earlierPass = async (caseId: string, runId: string, verdict: string): Promise<PassRun | null> => {
    if (verdict === 'PASS') return null;
    const runs = runsOf(statusRef.current, caseId);
    const at = runs.findIndex((r) => r.runId === runId);
    const pass = at < 0 ? undefined : runs.slice(at + 1).find((r) => r.verdict === 'PASS');
    if (!pass) return null;
    try {
      const url = `${api}/run?case=${encodeURIComponent(caseId)}&run=${encodeURIComponent(pass.runId)}`;
      const next = await fetchJson<RunDetail>(url);
      return next.result ? { runId: pass.runId, checks: next.result.checks ?? [] } : null;
    } catch {
      return null;
    }
  };

  /**
   * Draw the run on its case's map before the run pane paints, so a run
   * switch stays one paint (0329). Resolves null when the case has no map,
   * the run has no Result, or a newer selection made this one moot.
   */
  const prepareMap = async (caseId: string, runId: string, next: RunDetail, wanted: () => boolean): Promise<MapShot | null> => {
    const current = statusRef.current;
    const path = current?.cases.find((c) => c.id === caseId)?.map;
    const entry = path ? current?.maps?.[path] : undefined;
    if (!path || !entry || !next.result) return null;
    if (!entry.map) return { kind: 'error', message: `map ${path}: ${entry.errors.join('; ') || 'not loaded'}` };
    const before = await earlierPass(caseId, runId, next.info.verdict);
    const { pins, unplaced } = buildPins(next.result.checks ?? [], entry.map, before);
    if (pins.length > MAX_PINS) return { kind: 'error', message: `map ${path}: too many pins (${pins.length} > ${MAX_PINS})` };
    mapStyle.current ??= readMapStyle();
    const source = mapSource(entry.map, pins, litNodes(entry.map, pins), mapStyle.current.colours);
    const result = await renderMermaid(source, mapStyle.current.theme, wanted);
    if (!result) return null;
    if (!result.ok) return { kind: 'error', message: `map could not be drawn: ${result.error}` };
    return { kind: 'drawn', map: entry.map, pins, unplaced, svg: result.svg };
  };

  /**
   * Select a run and fetch its detail. The run highlight moves now; the
   * previous detail stays on screen until `/run` answers, then the pending
   * case switch (`paintCase`) and the run pane render in one task, so a switch
   * never paints an empty or half-built detail. Only an answer slower than
   * LOADING_DELAY_MS shows `loading run…`.
   */
  const selectRun = (runId: string | null, paintCase?: () => void): void => {
    sel.current = { ...sel.current, runId };
    // The old detail's log and artifacts must not open under the new run id.
    setDetail(null);
    writeHash();
    window.clearTimeout(loadingTimer.current);
    const request = ++detailRequest.current;
    let pending = paintCase ?? null;
    const paint = (fill: () => void): void => {
      if (pending) {
        pending();
        pending = null;
        setRunSel(runId);
      }
      fill();
    };
    if (!pending) setRunSel(runId);
    const caseId = sel.current.caseId;
    if (!runId || !caseId) {
      paint(() => setBoxText('Select a run'));
      return;
    }
    loadingTimer.current = window.setTimeout(() => {
      paint(() => setBoxText('loading run…'));
    }, LOADING_DELAY_MS);
    const url = `${api}/run?case=${encodeURIComponent(caseId)}&run=${encodeURIComponent(runId)}`;
    fetchJson<RunDetail>(url)
      .then(async (next) => ({ next, shot: await prepareMap(caseId, runId, next, () => request === detailRequest.current) }))
      .then(
        ({ next, shot }) => {
          if (request !== detailRequest.current) return;
          window.clearTimeout(loadingTimer.current);
          paint(() => {
            setDetail(next);
            setShown({ detail: next, shot, failuresOnly: failuresOnly.current });
            setBoxText(null);
            setSelectedArtifact(0);
            setCursor(null);
            setViewer(null);
          });
        },
        (error: unknown) => {
          if (request !== detailRequest.current) return;
          if (error instanceof HttpError && error.status === 404 && !retriedMissingRun.current) {
            window.clearTimeout(loadingTimer.current);
            retriedMissingRun.current = true;
            void poller.current?.refresh();
            return;
          }
          window.clearTimeout(loadingTimer.current);
          paint(() => setBoxText(failureText(error)));
        },
      );
  };

  const selectCase = (caseId: string | null, runId: string | null): void => {
    sel.current = { ...sel.current, caseId };
    setCaseSel(caseId);
    const current = statusRef.current;
    const c = current?.cases.find((x) => x.id === caseId) ?? null;
    const runs = c ? runsOf(current, c.id) : [];
    const run = runs.some((r) => r.runId === runId) ? runId : (runs[0]?.runId ?? null);
    selectRun(run, () => setShownCase({ c, runs }));
  };

  const scheduleActivePoll = (): void => {
    window.clearTimeout(activeTimer.current);
    // `poller` is null once the page unmounted: an `/active` answer arriving after that schedules nothing.
    if (!poller.current || !statusRef.current?.activeLaunch) return;
    activeTimer.current = window.setTimeout(() => void pollActive(), ACTIVE_POLL_MS);
  };

  /** Only the cheap `/active` route while a launch runs; a change reloads `/status`. */
  const pollActive = async (): Promise<void> => {
    if (document.visibilityState === 'hidden') {
      scheduleActivePoll();
      return;
    }
    const known = statusRef.current?.activeLaunch?.launchId ?? null;
    try {
      const next = await fetchJson<{ activeLaunch: ActiveLaunch | null }>(`${api}/active`);
      const now = next.activeLaunch?.launchId ?? null;
      if (now !== known) void poller.current?.refresh();
      else scheduleActivePoll();
    } catch {
      scheduleActivePoll();
    }
  };

  const loadStatus = async (signal: AbortSignal): Promise<E2eStatus> => {
    setLoaded('loading…');
    try {
      return await fetchJson<E2eStatus>(`${api}/status`, { signal });
    } catch (error) {
      if (error instanceof HttpError) throw new Error(error.status === 404 ? EXPIRED : `status ${error.status}`);
      throw error;
    }
  };

  const applyStatus = (next: E2eStatus): void => {
    statusRef.current = next;
    retriedMissingRun.current = false;
    setStatus(next);
    setLoaded(when(new Date(Date.now()).toISOString()));
    const messages: string[] = [];
    if (!next.initialized) messages.push("not initialized — run #e2e init in this project's harness");
    messages.push(...next.errors);
    if (next.issuesError) messages.push(`issues unavailable: ${next.issuesError}`);
    setErrors(messages);

    const wanted = new URLSearchParams(location.hash.slice(1));
    let { caseId, runId } = sel.current;
    if (!caseId) caseId = wanted.get('case');
    if (!runId) runId = wanted.get('run');
    if (!next.cases.some((c) => c.id === caseId)) {
      caseId = next.cases[0]?.id ?? null;
      runId = null;
    }
    sel.current = { caseId, runId };
    selectCase(caseId, runId);
    scheduleActivePoll();
  };

  const renderFatal = (message: string): void => {
    setLoaded('failed');
    setErrors([message]);
  };

  const pollHandlers = useLatest({ loadStatus, applyStatus, renderFatal });
  useEffect(() => {
    const current = poll<E2eStatus>({
      load: (signal) => pollHandlers.current.loadStatus(signal),
      apply: (next) => pollHandlers.current.applyStatus(next),
      onStatus: (state, error) => {
        if (state === 'reconnecting') pollHandlers.current.renderFatal(failureText(error));
      },
      refreshOnFocus: true,
      minGapMs: FOCUS_RELOAD_MS,
    });
    poller.current = current;
    return () => {
      current.dispose();
      if (poller.current === current) poller.current = null;
      window.clearTimeout(activeTimer.current);
      window.clearTimeout(loadingTimer.current);
      detailRequest.current += 1;
    };
  }, [pollHandlers]);

  // ── actions ──

  const leaveFilter = (): void => {
    filterInput.current?.blur();
    setPane('cases');
  };

  const closeViewer = (): boolean => {
    if (!viewer) return false;
    setViewer(null);
    return true;
  };

  const toggleFailures = (): void => {
    failuresOnly.current = !failuresOnly.current;
    const next = failuresOnly.current;
    if (!detail) return;
    setShown((prev) => (prev ? { ...prev, failuresOnly: next } : prev));
    setViewer(null);
  };

  const cycleLayout = (): void => {
    if (!detail || layouts.length < 2) return;
    setLayout(layouts[(layouts.indexOf(shownLayout) + 1) % layouts.length]);
    setViewer(null);
  };

  const moveCursor = (delta: number): void => {
    const at = cursor === null ? -1 : evidence.indexOf(cursor);
    const next = evidence[Math.min(evidence.length - 1, Math.max(0, at + delta))];
    if (next === undefined) return;
    setCursor(next);
    setCursorScroll((n) => n + 1);
  };

  const moveArtifact = (delta: number): void => {
    const n = artifactItems.length;
    if (n === 0) return;
    const index = artifactItems.findIndex((a) => a.index === selectedArtifact);
    const next = index < 0 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, index + delta));
    setSelectedArtifact(artifactItems[next].index);
  };

  const showViewer = (title: string, body: ViewerBody, note?: string): number => {
    const id = ++viewerSeq.current;
    setViewer({ id, title, note: note ?? null, body });
    return id;
  };

  const fillViewer = (id: number, body: ViewerBody): void => {
    setViewer((prev) => (prev && prev.id === id ? { ...prev, body } : prev));
  };

  const showText = (title: string, url: string, note?: string): void => {
    const id = showViewer(title, { kind: 'text', text: 'loading…' }, note);
    fetchText(url).then(
      (text) => fillViewer(id, { kind: 'text', text: text || '(empty)' }),
      (error: unknown) => fillViewer(id, { kind: 'text', text: failureText(error) }),
    );
  };

  const openLog = (): void => {
    if (!detail || !detail.log || !detail.info.launchId) return;
    showText(`log · ${detail.info.launchId}`, `${api}/log?launch=${encodeURIComponent(detail.info.launchId)}`);
  };

  const artifactUrl = (index: number): string =>
    `${api}/artifact?case=${encodeURIComponent(sel.current.caseId ?? '')}&run=${encodeURIComponent(sel.current.runId ?? '')}&index=${index}`;

  const openArtifact = (index: number, note?: string): void => {
    const a = detail?.artifacts[index];
    if (!a || !sel.current.caseId || !sel.current.runId) return;
    if (a.problem) {
      flash.show(`${a.path}: ${a.problem}`, 'error', FLASH_MS);
      return;
    }
    const url = artifactUrl(index);
    const ext = (a.path.split('.').pop() ?? '').toLowerCase();
    const title = `${a.label} · ${a.path}`;
    if (IMAGE_EXT.includes(ext)) showViewer(title, { kind: 'image', src: url, alt: a.label }, note);
    else if (TEXT_EXT.includes(ext)) showText(title, url, note);
    else showViewer(title, { kind: 'download', href: url, path: a.path }, note);
  };

  /** The value at `pointer`, pretty-printed; the whole file under a note when the pointer misses. */
  const showPointer = (index: number, pointer: string): void => {
    const a = detail?.artifacts[index];
    if (!a || !sel.current.caseId || !sel.current.runId) return;
    const id = showViewer(`${a.label} · ${a.path} · ${pointer}`, { kind: 'pointer', text: 'loading…', note: null });
    fetchText(artifactUrl(index)).then(
      (text) => {
        let hit: PointerHit = { found: false };
        try {
          hit = resolvePointer(JSON.parse(text), pointer);
        } catch {
          /* not JSON after all: the whole file below */
        }
        if (hit.found) {
          fillViewer(id, { kind: 'pointer', text: JSON.stringify(hit.value, null, 2), note: null });
          return;
        }
        fillViewer(id, { kind: 'pointer', text: text || '(empty)', note: `pointer ${pointer} not found — whole file` });
      },
      (error: unknown) => fillViewer(id, { kind: 'pointer', text: failureText(error), note: null }),
    );
  };

  /** Enter in the `checks` pane: the row's evidence, at its pointer when the artifact is a `.json` file. */
  const openEvidence = (index: number): void => {
    const target = checks[index]?.evidence;
    const artifacts = detail?.artifacts ?? [];
    if (!target) return;
    const at = artifacts.findIndex((a) => a.label === target.artifact);
    if (at < 0) {
      flash.show(`no artifact "${target.artifact}"`, 'error', FLASH_MS);
      return;
    }
    const { path, problem } = artifacts[at];
    if (target.pointer === undefined || problem) openArtifact(at);
    else if ((path.split('.').pop() ?? '').toLowerCase() === 'json') showPointer(at, target.pointer);
    else openArtifact(at, `pointer ${target.pointer} not found — whole file`);
  };

  const openArtifactRow = (a: Artifact): void => {
    setPane('artifacts');
    openArtifact(a.index);
  };

  const enter = (): void => {
    if (pane === 'cases') setPane('runs');
    else if (pane === 'runs') {
      if (detail && detail.artifacts.length) setPane('artifacts');
    } else if (pane === 'checks') {
      if (cursor !== null) openEvidence(cursor);
    } else openArtifact(selectedArtifact);
  };

  const cyclePane = (back: boolean): void => {
    const order: Pane[] = ['cases', 'runs'];
    if (evidence.length) order.push('checks');
    if (detail?.artifacts.length) order.push('artifacts');
    const i = Math.max(0, order.indexOf(pane));
    setPane(order[(i + (back ? order.length - 1 : 1)) % order.length]);
  };

  const copyCommand = async (): Promise<void> => {
    if (!sel.current.caseId) return;
    const text = `#e2e run ${sel.current.caseId}`;
    const ok = await copyText(text);
    flash.show(ok ? `copied: ${text}` : text, ok ? 'ok' : 'info', FLASH_MS);
  };

  // ── keys ──
  // The artifacts list binds its row keys here (`keys={false}` below), so they
  // keep their place ahead of the page's own bindings while the list mounts
  // and unmounts with each run.

  useKeymap([
    { key: ['j', 'ArrowDown'], label: 'Next item', when: () => pane === 'artifacts', run: () => moveArtifact(1) },
    { key: ['k', 'ArrowUp'], label: 'Previous item', when: () => pane === 'artifacts', run: () => moveArtifact(-1) },
    {
      key: 'Enter',
      label: 'Open the selected item',
      when: () => pane === 'artifacts',
      run: () => {
        const item = artifactItems.find((a) => a.index === selectedArtifact);
        if (!item) return false;
        openArtifactRow(item);
      },
    },
    {
      key: 'ArrowDown',
      inInput: true,
      when: () => document.activeElement === filterInput.current,
      label: 'Leave the filter',
      run: () => leaveFilter(),
    },
    { key: 'Tab', shift: false, label: 'Next pane', run: () => cyclePane(false) },
    { key: 'Tab', shift: true, label: 'Previous pane', display: '⇧Tab', run: () => cyclePane(true) },
    { key: ['j', 'ArrowDown'], label: 'Next row with evidence', when: () => pane === 'checks', run: () => moveCursor(1) },
    { key: ['k', 'ArrowUp'], label: 'Previous row with evidence', when: () => pane === 'checks', run: () => moveCursor(-1) },
    { key: 'Enter', label: "Open: runs, artifacts, the artifact or the row's evidence", run: () => enter() },
    { key: 'f', label: 'Failed and blocked checks only', run: () => toggleFailures() },
    { key: 'm', label: 'View: map / by group / by step', run: () => cycleLayout() },
    { key: 'l', label: 'Open the run log', run: () => openLog() },
    { key: 'y', label: 'Copy the run command', run: () => void copyCommand() },
    { key: 'r', label: 'Reload', run: () => void poller.current?.refresh() },
    {
      key: 'Escape',
      label: 'Close the viewer / clear the filter',
      run: () => {
        if (closeViewer()) return;
        if (!query) return false;
        setQuery('');
      },
    },
  ]);

  // ── rendering ──

  const cases = visibleCases(status, query);
  const total = status ? status.cases.length : 0;
  const casesShown = status !== null || filterTouched;

  const tally = new Map<string, number>();
  for (const c of status?.cases ?? []) {
    const key = runsOf(status, c.id)[0]?.verdict ?? 'never run';
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const stats: Stat[] =
    loaded === null
      ? []
      : [
          { key: 'cases', label: 'Cases', value: status ? status.cases.length : '—' },
          { key: 'latest', label: 'Latest runs', value: [...tally].map(([k, n]) => `${n} ${k}`).join(' · ') || '—' },
          { key: 'loaded', label: 'Loaded', value: loaded, tone: 'muted' },
        ];
  const active = status?.activeLaunch ?? null;

  const caseHead = (): ReactNode => {
    const c = shownCase?.c ?? null;
    if (!c) return <EmptyState text={status && !status.cases.length ? 'No cases — the adapter listed none' : 'Select a case'} />;
    const issue = issueOf(status, c);
    return (
      <>
        <div className="lb-e2e__row">
          <h2 className="lb-h2">{c.title}</h2>
          {issue ? (
            <a href={issue.url} target="_blank" rel="noreferrer noopener">
              {`#${issue.number} ${issue.state.toLowerCase()}`}
            </a>
          ) : null}
        </div>
        <Kv
          rows={[
            ['id', c.id],
            ['code', c.code],
            ['issue', c.issue && !issue ? `#${c.issue}` : null],
            ['files', c.files.join('  ')],
            ['params', pairs(c.params, '=')],
            ['fresh', pairs(c.fresh, '=')],
            ['marks', marksOf(status, c, runsOf(status, c.id)).join('  ')],
          ]}
        />
        <div className="lb-e2e__command">
          <code className="lb-code">{`#e2e run ${c.id}`}</code>
          <Button label="copy" kbd="y" onClick={() => void copyCommand()} />
        </div>
      </>
    );
  };

  /** One check; the rev 5 fields add a line each only when present, so an older row reads as before. */
  const checkRow = (index: number, showLink: boolean, head = false): JSX.Element => {
    const check = checks[index];
    const tag = kindTag(check.kind);
    const link = showLink ? links.linkOf[index] : null;
    const unknownStep = links.unknownStep[index];
    let className = 'lb-e2e__check';
    if (head) className += ' lb-e2e__check--head';
    if (check.evidence && index === cursor) className += ' lb-e2e__check--cursor';
    return (
      <div key={index} className={className}>
        <span>
          <Pill label={check.status} tone={checkTone(check.status)} />
        </span>
        <span className="lb-e2e__check-label">
          {tag ? <span className="lb-e2e__check-kind">{tag}</span> : null}
          {check.label}
          {check.target ? <span className="lb-e2e__check-target">{`${check.target.type} · ${check.target.name}`}</span> : null}
          {link === null ? null : <span className="lb-e2e__check-link">{`← ${checks[link].label}`}</span>}
          {check.detail ? <span className="lb-e2e__check-detail">{check.detail}</span> : null}
          {check.params && Object.keys(check.params).length ? (
            <span className="lb-e2e__check-params">{paramsText(check.params)}</span>
          ) : null}
          {check.expected === undefined ? null : <span className="lb-e2e__check-value">{`expected ${clip(check.expected)}`}</span>}
          {check.actual === undefined ? null : (
            <span className={check.status === 'fail' ? 'lb-e2e__check-value lb-e2e__check-value--fail' : 'lb-e2e__check-value'}>
              {`actual ${clip(check.actual)}`}
            </span>
          )}
          {check.evidence ? evidenceLine(check.evidence) : null}
          {unknownStep === null ? null : <span className="lb-e2e__check-detail lb-e2e__problem">{`no step "${unknownStep}"`}</span>}
        </span>
      </div>
    );
  };

  const evidenceLine = (target: CheckEvidence): JSX.Element => {
    const artifact = shown?.detail.artifacts.find((a) => a.label === target.artifact);
    const problem = artifact ? artifact.problem : `no artifact "${target.artifact}"`;
    return (
      <span className="lb-e2e__check-evidence">
        {`evidence: ${target.artifact}${target.pointer ? ` ${target.pointer}` : ''}`}
        {problem ? <span className="lb-e2e__problem">{` — ${problem}`}</span> : null}
      </span>
    );
  };

  const noChecks = (run: ShownRun): JSX.Element => <EmptyState text={run.failuresOnly ? 'No failed or blocked checks' : 'No checks'} />;

  const groupBlocks = (groups: readonly Group[], showLink: boolean): JSX.Element[] =>
    groups.map((group) => (
      <div key={group.name} className="lb-e2e__group">
        {group.name ? <div className="lb-e2e__group-name">{group.name}</div> : null}
        {group.rows.map((index) => checkRow(index, showLink))}
      </div>
    ));

  /** The run on its case's map, then each pin's checks. */
  const mapView = (run: ShownRun, view: Extract<Plan, { kind: 'map' }>): JSX.Element => {
    const nodes = new Map(view.shot.map.nodes.map((n) => [n.id, n]));
    const blocks = view.pins.map(({ pin, rows }) => {
      const node = nodes.get(pin.at);
      return (
        <div key={pin.key} className="lb-e2e__pin">
          <div className="lb-e2e__pin-head">
            <strong>{pin.key}</strong>
            <span>{node ? node.label.replace(/\n/g, ' ') : pin.at}</span>
            {pin.group ? <span className="lb-muted">{pin.group}</span> : null}
            <Pill label={countsText(pin.counts)} tone={checkTone(pin.tone)} />
            {node?.source ? <code className="lb-e2e__pin-source">{node.source}</code> : null}
          </div>
          {pin.before ? <span className="lb-e2e__pin-note">{`PASS ${pin.before.runId}: ${countsText(pin.before.counts)}`}</span> : null}
          {rows.map((index) => checkRow(index, true))}
        </div>
      );
    });
    if (view.loose.length) {
      blocks.push(
        <div key=" loose" className="lb-e2e__pin">
          <div className="lb-e2e__pin-head">
            <strong>not on the map</strong>
          </div>
          {view.loose.map((u) => (
            <Fragment key={u.index}>
              {checkRow(u.index, true)}
              {u.reason ? <span className="lb-e2e__pin-note lb-e2e__problem">{u.reason}</span> : null}
            </Fragment>
          ))}
        </div>,
      );
    }
    return (
      <div className="lb-e2e__map-view">
        <figure className="lb-e2e__map">
          <img
            className="lb-e2e__map-img"
            src={SVG_DATA_URL_PREFIX + encodeURIComponent(view.shot.svg)}
            alt={`System map with ${view.shot.pins.length} pins`}
          />
        </figure>
        {blocks.length ? <div className="lb-e2e__pins">{blocks}</div> : noChecks(run)}
      </div>
    );
  };

  const result = (run: ShownRun, view: Plan): ReactNode => {
    if (view.kind === 'map') return mapView(run, view);
    const lead = view.lead === null ? null : <Banner text={view.lead} tone="error" />;
    if (view.kind === 'none') {
      return (
        <>
          {lead}
          <EmptyState text="No Result for this run — see the message and the log" />
        </>
      );
    }
    if (view.kind === 'group') {
      return (
        <>
          {lead}
          {view.groups.length ? <div className="lb-e2e__checks">{groupBlocks(view.groups, true)}</div> : noChecks(run)}
        </>
      );
    }
    const blocks: JSX.Element[] = [];
    if (view.preconditions.length) {
      blocks.push(
        <div key=" preconditions" className="lb-e2e__group">
          <div className="lb-e2e__group-name">Preconditions</div>
          {view.preconditions.map((index) => checkRow(index, false))}
        </div>,
      );
    }
    for (const step of view.steps) {
      blocks.push(
        <div key={step.head} className="lb-e2e__step">
          {checkRow(step.head, false, true)}
          {step.rows.map((index) => checkRow(index, false))}
        </div>,
      );
    }
    if (view.other.length) {
      blocks.push(
        <div key=" other" className="lb-e2e__group">
          <div className="lb-e2e__group-name">Other checks</div>
          {groupBlocks(view.other, false)}
        </div>,
      );
    }
    return (
      <>
        {lead}
        {blocks.length ? <div className="lb-e2e__checks">{blocks}</div> : noChecks(run)}
      </>
    );
  };

  const runPane = (): ReactNode => {
    if (boxText !== null || !shown || !plan) return <EmptyState text={boxText ?? 'Select a run'} />;
    const info = shown.detail.info;
    const c = info.counts;
    return (
      <>
        <div className="lb-e2e__row">
          <span className="lb-e2e__row">
            <Pill label={info.verdict} tone={verdictTone(info.verdict)} />
            <strong className="lb-e2e__run-id">{info.runId}</strong>
          </span>
          <span className="lb-muted lb-e2e__meta">{info.origin + (info.launchId ? ` · launch ${info.launchId}` : '')}</span>
        </div>
        <Kv
          rows={[
            ['started', when(info.startedAt)],
            ['finished', `${when(info.finishedAt)} (${duration(info)})`],
            ['commit', info.git ? `${info.git.sha}${info.git.dirty ? ' (dirty)' : ''} on ${info.git.branch}` : null],
            ['env', shown.detail.result?.env],
            ['versions', pairs(info.versions, ' ')],
            ['params', info.params ? pairs(info.params, '=') : null],
            ['exit', info.exitCode === null || info.exitCode === undefined ? null : String(info.exitCode)],
            ['argv', info.argv ? info.argv.join(' ') : null],
            ['result', info.resultPath],
          ]}
        />
        {info.message ? <div className="lb-e2e__message">{info.message}</div> : null}
        <div className="lb-e2e__toolbar">
          <Button label="failures only" variant="toggle" pressed={shown.failuresOnly} kbd="f" onClick={toggleFailures} />
          {layouts.length > 1 ? <Button label={`view: ${shownLayout}`} kbd="m" onClick={cycleLayout} /> : null}
          {shown.detail.log ? <Button label="log" kbd="l" onClick={openLog} /> : null}
          <span className="lb-muted lb-e2e__meta">{`${c.pass} pass · ${c.fail} fail · ${c.blocked} blocked · ${c.skip} skip · ${c.info} info`}</span>
        </div>
        {result(shown, plan)}
        {artifactItems.length ? (
          <div className="lb-e2e__group">
            <div className="lb-e2e__group-name">Artifacts</div>
            <RosterList<Artifact>
              label="Artifacts"
              items={artifactItems}
              selected={String(selectedArtifact)}
              itemKey={(a) => String(a.index)}
              render={artifactRow}
              keys={false}
              onSelect={(a) => setSelectedArtifact(a.index)}
              onOpen={openArtifactRow}
            />
          </div>
        ) : null}
        <div ref={viewerBox} className="lb-e2e__viewer" hidden={!viewer}>
          {viewer ? (
            <>
              <div className="lb-e2e__viewer-head">
                <span>{viewer.title}</span>
                <Button label="close" variant="ghost" kbd="Esc" onClick={() => void closeViewer()} />
              </div>
              {viewer.note ? <Banner text={viewer.note} tone="info" /> : null}
              <ViewerContent body={viewer.body} />
            </>
          ) : null}
        </div>
      </>
    );
  };

  const focused = (on: boolean): string => (on ? ' lb-e2e__pane--focused' : '');

  return (
    <div className="lb-page lb-page--split lb-e2e">
      <header className="lb-e2e__head">
        <div>
          <h1 className="lb-e2e__title">{status?.manifest ? status.manifest.name : 'E2E Explorer'}</h1>
          <span className="lb-e2e__project lb-muted">{status ? `${status.projectName} · e2e explorer` : 'loading'}</span>
        </div>
        <span className="lb-e2e__active">
          <span className="lb-e2e__dot">
            <Dot state={active ? 'live' : 'idle'} />
          </span>
          <span>{active ? `${active.caseId} since ${when(active.startedAt)}` : 'nothing'}</span>
        </span>
        <span className="lb-e2e__readonly">read only</span>
      </header>
      <StatBar stats={stats} />
      <div className="lb-e2e__errors">
        {errors.map((message, i) => (
          <Banner key={i} text={message} tone="error" />
        ))}
      </div>
      <Banner {...flash.props} />
      <section className="lb-e2e__layout">
        <aside className={`lb-e2e__cases${focused(pane === 'cases')}`} aria-label="Cases">
          <div className="lb-e2e__pane-head">
            <h2 className="lb-h3">Cases</h2>
            <SearchFilter
              placeholder="Filter cases"
              value={query}
              onChange={(q) => {
                setQuery(q);
                setFilterTouched(true);
              }}
              onSubmit={leaveFilter}
              count={casesShown ? `${cases.length} / ${total}` : undefined}
              inputRef={filterInput}
            />
          </div>
          <div
            className="lb-e2e__list"
            onClick={(event: MouseEvent<HTMLDivElement>) => {
              if ((event.target as Element).closest('.lb-roster')) setPane('cases');
            }}
          >
            <RosterList<E2eCase>
              label="E2E cases"
              items={cases}
              selected={caseSel}
              itemKey={(c) => c.id}
              render={(c) => caseRow(status, c)}
              deps={(c) => [c, status]}
              when={() => pane === 'cases'}
              onSelect={(c) => selectCase(c.id, null)}
            />
            <div className="lb-e2e__cases-empty" hidden={casesShown && cases.length > 0}>
              {casesShown ? <EmptyState text={!status ? 'loading' : total ? 'No case matches the filter' : 'No cases'} /> : null}
            </div>
          </div>
        </aside>
        <article className="lb-e2e__detail" aria-live="polite">
          <div className="lb-e2e__section lb-e2e__case-head">{caseHead()}</div>
          <div className={`lb-e2e__section${focused(pane === 'runs')}`}>
            <div className="lb-e2e__pane-title">
              <h2 className="lb-h3">Runs</h2>
              <span className="lb-e2e__count">{String(shownCase?.runs.length ?? 0)}</span>
            </div>
            <div className="lb-e2e__run-row lb-e2e__run-head">
              {RUN_COLUMNS.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <div className="lb-e2e__runs" onClick={() => setPane('runs')}>
              <RosterList<E2eRun>
                label="Runs of the selected case"
                items={shownCase?.runs ?? []}
                selected={runSel}
                itemKey={(r) => r.runId}
                render={runRow}
                empty={shownCase ? 'No runs yet' : undefined}
                when={() => pane === 'runs'}
                onSelect={(r) => selectRun(r.runId)}
              />
            </div>
          </div>
          <div
            ref={runBox}
            className={`lb-e2e__section lb-e2e__run${focused(pane === 'artifacts')}${pane === 'checks' ? ' lb-e2e__run--checks' : ''}`}
          >
            {runPane()}
          </div>
        </article>
      </section>
      <KbdHints entries={HINTS} note="read-only · refreshes on focus · run with #e2e run <case>" />
    </div>
  );
}
