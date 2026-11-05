// Spec 288 / 341 — the ACP wire profiler. `/acp-wire/{token}` is the live
// dashboard; `/acp-wire/{token}/message/{seq}` is the same document in
// full-page message mode ([ / ] walk seqs through history.pushState).
// Spec 361: React page. Each poll mutates the held ring (`WireStore`) in place,
// so a `version` counter drives everything that reads it; table rows memoize
// on the values they paint and the detail pane on what it shows.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import type { PageProps } from '../../app';
import {
  Banner,
  Button,
  Card,
  copyText,
  Dot,
  DataTable,
  fetchJson,
  HttpError,
  KbdHints,
  KeyValue,
  Pill,
  poll,
  SearchFilter,
  StatBar,
  useBanner,
  useKeymap,
  useLatest,
  useShell,
} from '../../kit';
import type { Column, Stat, Tone } from '../../kit';
import { Digest, JsonTree } from './json-tree';
import type { Json } from './json-tree';
import type {
  EventsPage,
  FilterState,
  Group,
  MethodRow,
  Row,
  Selection,
  WireDir,
  WireEvent,
  WireSummary,
} from './model';
import { DIRS, fmtBytes, fmtTime, fmtUs, isGroup, LIMIT, MAX_ROWS, MSG_RE, parsePath, WireStore } from './model';
import { paintWaterfall } from './waterfall';

import './acp-wire.css';

type PayloadState = { text: string | null } | { evicted: true } | { loading: true } | { error: string };
type View = 'tree' | 'raw';
type Lane = { lane: string; backend: string; remote?: boolean };

const POLL_MS = 1000;
const DIR_CLASS: Record<string, string> = {
  to_agent: 'lb-acp-wire__acc',
  from_agent: 'lb-acp-wire__grn',
  to_ui: 'lb-muted',
};
const CAPTURE_OFF = 'Capture is off — enable from the Krypton palette: “ACP Wire: Capture Meta”.';

const LEGEND: readonly (readonly [color: string, text: string])[] = [
  ['var(--accent)', 'Krypton → agent request (span = latency)'],
  ['var(--muted)', 'agent → Krypton request (fs / permission)'],
  ['var(--del)', 'error response'],
  ['var(--fg)', 'notification'],
];

const DASH_HINTS: readonly (readonly [string, string])[] = [
  ['j k', 'move'],
  ['Enter', 'jump to pair / expand group'],
  ['g', 'group runs on/off'],
  ['/', 'filter'],
  ['Esc', 'clear'],
  ['Space', 'pause'],
  ['1 2 3', 'toggle dir'],
  ['l', 'cycle lane'],
  ['e', 'export JSONL'],
  ['o', 'open message in full page'],
  ['v', 'readable / raw JSON'],
];

const MSG_HINTS: readonly (readonly [string, string])[] = [
  ['[ ]', 'previous / next seq'],
  ['Enter', 'jump to pair'],
  ['j k', 'scroll'],
  ['v', 'readable / raw JSON'],
  ['y', 'copy JSON'],
  ['Esc', 'back to profiler'],
];

/**
 * Every page binding carries a gate, as the old mode check did, so the keymap's
 * duplicate-chord check treats them the same; each mode is its own component.
 */
const when = (): boolean => true;

function msgUrl(base: string, seq: number): string {
  return `${base}/message/${seq}`;
}

function dirNode(dir: string): JSX.Element {
  const label = DIRS.find((d) => d.k === dir)?.label ?? dir;
  return <span className={DIR_CLASS[dir]}>{label}</span>;
}

function methodNode(m: string | null | undefined): ReactNode {
  const s = m ?? '';
  const i = s.indexOf('·');
  if (i < 0) return s;
  return (
    <>
      {s.slice(0, i)}
      <span className="lb-muted">{` · ${s.slice(i + 1)}`}</span>
    </>
  );
}

function laneNode(e: WireEvent): JSX.Element {
  return (
    <span>
      {e.lane}
      <span className="lb-muted">{` · ${e.backend}${e.remote ? ' · remote' : ''} · session ${e.session ?? ''}`}</span>
    </span>
  );
}

function knownLanes(summary: WireSummary | null): Lane[] {
  const seen = new Set<string>();
  return (summary?.lanes ?? []).filter((l) => !seen.has(l.lane) && seen.add(l.lane));
}

function rowKey(r: Row): string {
  if (r.kind === 'gap') return `x${r.seq}`;
  return r.kind === 'group' ? `g${r.grp.seq}` : `e${r.ev.seq}`;
}

function selKey(sel: Selection | null): string {
  if (!sel) return '';
  return `${isGroup(sel) ? 'g' : 'e'}${sel.seq}`;
}

function payloadKey(c: PayloadState | undefined): string {
  if (!c || 'loading' in c) return 'L';
  if ('evicted' in c) return 'E';
  return 'error' in c ? 'X' : 'T';
}

// ------------------------------------------------------------------ table rows

interface RowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly open: boolean;
  /** What the row paints, read while rendering: the store patches held events in place. */
  readonly deps: readonly unknown[];
}

function rowDeps(r: Row, selected: boolean, open: boolean): readonly unknown[] {
  if (r.kind === 'gap') return ['gap'];
  if (r.kind === 'group') {
    return ['grp', r.grp.seq, r.grp.members.length, r.grp.bytes, r.grp.last.monoUs, open, selected];
  }
  const e = r.ev;
  return ['ev', e.seq, e.latencyUs, e.error, e.pairSeq, e.bytes, e.truncated, r.child, selected];
}

function WireRowView({ row: r, selected, open }: RowProps): JSX.Element {
  const className = [
    'lb-acp-wire__row',
    r.kind === 'gap' && 'lb-acp-wire__row--gap',
    r.kind === 'group' && 'lb-acp-wire__row--group',
    r.kind === 'event' && r.child && 'lb-acp-wire__row--child',
    selected && 'lb-acp-wire__row--selected',
  ]
    .filter(Boolean)
    .join(' ');
  if (r.kind === 'gap') {
    return (
      <tr className={className}>
        <td colSpan={8}>— gap: older events evicted or skipped —</td>
      </tr>
    );
  }
  if (r.kind === 'group') {
    const g = r.grp;
    const f = g.first;
    return (
      <tr className={className} data-key={`g${g.seq}`}>
        <td className="lb-muted">{fmtTime(f.tsMs)}</td>
        <td>{f.lane}</td>
        <td>{dirNode(f.dir)}</td>
        <td>
          <span className="lb-muted">{`${open ? '▾ ' : '▸ '}${f.kind}`}</span>{' '}
          <span className="lb-acp-wire__acc">{`×${g.members.length}`}</span>
        </td>
        <td className="lb-acp-wire__fill" title={f.method ?? ''}>
          {methodNode(f.method)}
        </td>
        <td />
        <td className="lb-table__num">{fmtBytes(g.bytes)}</td>
        <td className="lb-table__num lb-muted" title="span first → last">
          {fmtUs(g.last.monoUs - f.monoUs)}
        </td>
      </tr>
    );
  }
  const e = r.ev;
  const lat: ReactNode =
    e.latencyUs != null ? fmtUs(e.latencyUs) : e.kind === 'request' ? <span className="lb-muted">…</span> : '';
  return (
    <tr className={className} data-key={`e${e.seq}`}>
      <td className="lb-muted">{fmtTime(e.tsMs)}</td>
      <td>{e.lane}</td>
      <td>{dirNode(e.dir)}</td>
      <td className={e.kind === 'invalid' ? 'lb-acp-wire__red' : 'lb-muted'}>{e.kind}</td>
      <td className="lb-acp-wire__fill" title={e.method ?? ''}>
        {methodNode(e.method)}
      </td>
      <td className="lb-table__num lb-muted">{e.id == null ? '' : String(e.id)}</td>
      <td className="lb-table__num">
        {fmtBytes(e.bytes)}
        {e.truncated ? <span className="lb-muted"> trunc</span> : null}
      </td>
      <td className={e.error ? 'lb-table__num lb-acp-wire__red' : 'lb-table__num'}>{lat}</td>
    </tr>
  );
}

const WireRow = memo(
  WireRowView,
  (prev, next) => prev.deps.length === next.deps.length && prev.deps.every((value, i) => Object.is(value, next.deps[i])),
);

// --------------------------------------------------------------- shared detail

/** Metadata list shared by the detail pane and the message page. */
function MetaList({ e, pairDd }: { readonly e: WireEvent; readonly pairDd: ReactNode }): JSX.Element {
  const entries: [string, ReactNode][] = [
    ['seq', String(e.seq)],
    ['time', fmtTime(e.tsMs)],
    ['lane', laneNode(e)],
    ['dir', e.dir],
    ['kind', e.kind],
    ['method', <span className="lb-acp-wire__acc">{e.method || '—'}</span>],
  ];
  if (e.id != null) entries.push(['id', String(e.id)]);
  entries.push([
    'bytes',
    <span>
      {fmtBytes(e.bytes)}
      {e.truncated ? <span className="lb-muted"> (truncated)</span> : null}
    </span>,
  ]);
  if (e.latencyUs != null) {
    entries.push([
      'latency',
      <span className={e.error ? 'lb-acp-wire__red' : undefined}>{fmtUs(e.latencyUs) + (e.error ? ' · error' : '')}</span>,
    ]);
  } else if (e.kind === 'request') {
    entries.push(['latency', <span className="lb-muted">in flight</span>]);
  }
  if (e.pairSeq != null) entries.push(['paired', pairDd]);
  return <KeyValue entries={entries} />;
}

function Pre({ text, tone }: { readonly text: string; readonly tone?: string }): JSX.Element {
  const base = 'lb-acp-wire__payload lb-acp-wire__payload--pre';
  return <pre className={tone ? `${base} ${tone}` : base}>{text}</pre>;
}

interface PayloadProps {
  readonly e: WireEvent;
  readonly c: PayloadState | undefined;
  /** Fold long strings behind "show all" (the detail pane, not the message page). */
  readonly clipLong: boolean;
  readonly view: View;
  /** Capture mode, named when the payload was not captured. */
  readonly mode: string;
  readonly onView: (view: View) => void;
}

function PayloadView({ e, c, clipLong, view, mode, onView }: PayloadProps): JSX.Element {
  if (!e.hasPayload) {
    return (
      <Pre
        text={`payload not captured — capture mode ${String(mode).toUpperCase()}\n(switch via Krypton palette: ACP Wire: Capture Full)`}
        tone="lb-muted"
      />
    );
  }
  if (!c || 'loading' in c) return <Pre text="loading payload…" tone="lb-muted" />;
  if ('evicted' in c) return <Pre text="evicted — payload no longer in the server ring buffer" tone="lb-muted" />;
  if ('error' in c) return <Pre text={c.error} tone="lb-acp-wire__red" />;
  if (c.text == null) return <Pre text="payload not captured" tone="lb-muted" />;
  const note = e.truncated ? <p className="lb-acp-wire__note">payload truncated by capture cap</p> : null;
  let parsed: Json;
  try {
    parsed = JSON.parse(c.text) as Json;
  } catch {
    return (
      <>
        {note}
        <Pre text={c.text} />
      </>
    );
  }
  const tabs = (
    <div className="lb-acp-wire__vtabs">
      <Button label="readable" variant="toggle" pressed={view === 'tree'} onClick={(): void => onView('tree')} />
      <Button label="raw JSON" variant="toggle" pressed={view === 'raw'} onClick={(): void => onView('raw')} />
      <kbd>v</kbd>
    </div>
  );
  if (view === 'raw') {
    return (
      <>
        {note}
        {tabs}
        <Pre text={JSON.stringify(parsed, null, 2)} />
      </>
    );
  }
  return (
    <>
      {note}
      {tabs}
      <Digest value={parsed} />
      <JsonTree value={parsed} clipLong={clipLong} />
    </>
  );
}

/** Re-parses and re-renders the tree only when the message, its payload or the view move. */
const Payload = memo(PayloadView);

function GroupDetail({ g, open }: { readonly g: Group; readonly open: boolean }): JSX.Element {
  const n = g.members.length;
  const f = g.first;
  return (
    <>
      <KeyValue
        entries={[
          [
            'group',
            <span>
              <span className="lb-acp-wire__acc">{String(n)}</span>
              {` consecutive ${f.kind}s`}
            </span>,
          ],
          ['method', <span className="lb-acp-wire__acc">{f.method || '—'}</span>],
          ['lane', laneNode(f)],
          ['dir', f.dir],
          ['time', `${fmtTime(f.tsMs)} → ${fmtTime(g.last.tsMs)}`],
          ['span', fmtUs(g.last.monoUs - f.monoUs)],
          [
            'bytes',
            <span>
              {fmtBytes(g.bytes)}
              <span className="lb-muted">{` · avg ${fmtBytes(Math.round(g.bytes / n))}`}</span>
            </span>,
          ],
          ['seq', `${f.seq} – ${g.last.seq}`],
        ]}
      />
      <p className="lb-acp-wire__note">{`enter / click: ${open ? 'collapse' : 'expand'} · g: turn grouping off`}</p>
    </>
  );
}

interface DetailProps {
  /** Everything the pane shows; the pane is keyed and memoized on it. */
  readonly detailKey: string;
  readonly ev: WireEvent | null;
  readonly group: Group | undefined;
  readonly open: boolean;
  readonly pair: WireEvent | undefined;
  readonly payload: PayloadState | undefined;
  readonly view: View;
  readonly mode: string;
  readonly onPair: (pair: WireEvent) => void;
  readonly onView: (view: View) => void;
}

function DetailView({ ev, group, open, pair, payload, view, mode, onPair, onView }: DetailProps): JSX.Element {
  if (ev) {
    let pairDd: ReactNode = null;
    if (ev.pairSeq != null) {
      pairDd = pair ? (
        <a
          href="#"
          onClick={(event): void => {
            event.preventDefault();
            onPair(pair);
          }}
        >
          {`${pair.kind} seq ${pair.seq} ↵`}
        </a>
      ) : (
        <span className="lb-muted">{`seq ${ev.pairSeq} (not held)`}</span>
      );
    }
    return (
      <>
        <MetaList e={ev} pairDd={pairDd} />
        <Payload e={ev} c={payload} clipLong view={view} mode={mode} onView={onView} />
      </>
    );
  }
  if (group) return <GroupDetail g={group} open={open} />;
  return <p className="lb-acp-wire__note">Select a row (j/k).</p>;
}

/** Polls repaint every second; the pane rebuilds only when what it shows changed. */
const Detail = memo(DetailView, (prev, next) => prev.detailKey === next.detailKey);

/** The first row still visible at the top of the scroll box, and its offset from the box top. */
function topRow(box: HTMLElement | null, body: HTMLElement | null): { row: HTMLElement; offset: number } | null {
  if (!box || !body) return null;
  const top = box.getBoundingClientRect().top;
  for (const tr of Array.from(body.children) as HTMLElement[]) {
    const r = tr.getBoundingClientRect();
    if (tr.dataset.key && r.bottom > top) return { row: tr, offset: r.top - top };
  }
  return null;
}

// ------------------------------------------------------------------- dashboard

function WireDashboard({ base }: { readonly base: string }): JSX.Element {
  const [store] = useState(() => new WireStore());
  const [payloads] = useState(() => new Map<number, PayloadState>());
  const since = useRef(0);
  /** Bumped per ingest: the store is mutated in place. */
  const [version, setVersion] = useState(0);
  const [summary, setSummary] = useState<WireSummary | null>(null);
  const [lane, setLane] = useState('all');
  const [dirs, setDirs] = useState<Record<WireDir, boolean>>({ to_agent: true, from_agent: true, to_ui: false });
  const [q, setQ] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [sel, setSel] = useState<Selection | null>(null);
  const [paused, setPaused] = useState(false);
  const [connHidden, setConnHidden] = useState(true);
  const [view, setView] = useState<View>('tree');
  /** Repaint once a selected message's payload lands (the cache is a plain Map). */
  const [, setPayloadTick] = useState(0);
  /** Follow the tail (when nothing is selected) after this commit. */
  const [tailTick, setTailTick] = useState(0);
  /** Scroll the selected row into view after this commit. */
  const [revealTick, setRevealTick] = useState(0);
  const banner = useBanner();
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);
  const wf = useRef<SVGSVGElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const life = useRef<AbortController | null>(null);

  const filter = useMemo<FilterState>(() => ({ lane, dirs, q, grouped, open }), [lane, dirs, q, grouped, open]);
  // `version` stands for the store's in-place mutations.
  const built = useMemo(() => store.buildRows(filter), [store, filter, version]);
  const rates = useMemo(() => store.rates(summary), [store, summary, version]);

  if (sel && isGroup(sel) && !built.groups.has(sel.seq)) setSel(null);

  // ------------------------------------------------------------- actions

  /** Expand the group that folds a selected member (`groupOf` ignores `open`: reuse this render's unless the filter moved). */
  const revealSel = (s: Selection | null, f: FilterState): void => {
    if (!s || isGroup(s)) return;
    const same = f.lane === lane && f.dirs === dirs && f.q === q && f.grouped === grouped;
    const g = (same ? built : store.buildRows(f)).groupOf.get(s.seq);
    if (g != null && !f.open.has(g)) setOpen((prev) => (prev.has(g) ? prev : new Set(prev).add(g)));
  };

  const select = (e: Selection | undefined): void => {
    if (!e) return;
    let nextDirs = dirs;
    let nextLane = lane;
    if (!isGroup(e)) {
      if (!dirs[e.dir]) nextDirs = { ...dirs, [e.dir]: true };
      if (lane !== 'all' && lane !== e.lane) nextLane = 'all';
    }
    setSel(e);
    setDirs(nextDirs);
    setLane(nextLane);
    revealSel(e, { ...filter, dirs: nextDirs, lane: nextLane });
    setRevealTick((t) => t + 1);
  };

  const toggleGroup = (seq: number): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  };

  const pick = (d: 1 | -1): void => {
    const rs = built.rows.filter((r) => r.kind !== 'gap');
    const sk = selKey(sel);
    const i = rs.findIndex((r) => rowKey(r) === sk);
    const r = i < 0 ? rs[rs.length - 1] : rs[Math.max(0, Math.min(rs.length - 1, i + d))];
    if (r?.kind === 'group') select(r.grp);
    else if (r?.kind === 'event') select(r.ev);
  };

  const latestSelect = useLatest(select);
  const onPair = useCallback((pair: WireEvent): void => latestSelect.current(pair), [latestSelect]);

  const onRowsClick = (event: ReactMouseEvent<HTMLTableSectionElement>): void => {
    const tr = (event.target as Element).closest<HTMLElement>('tr[data-key]');
    if (!tr?.dataset.key) return;
    const seq = Number(tr.dataset.key.slice(1));
    if (tr.dataset.key.startsWith('g')) {
      const g = built.groups.get(seq);
      if (g) {
        setSel(g);
        toggleGroup(seq);
      }
    } else select(store.bySeq.get(seq));
  };

  const onWaterfallClick = (event: ReactMouseEvent<SVGSVGElement>): void => {
    const r = (event.target as Element).closest('rect[data-seq]');
    if (r) select(store.bySeq.get(Number(r.getAttribute('data-seq'))));
  };

  useKeymap([
    { key: 'j', label: 'Next message', when, run: () => pick(1) },
    { key: 'k', label: 'Previous message', when, run: () => pick(-1) },
    {
      key: 'Enter',
      label: 'Jump to pair / expand group',
      when,
      run: () => {
        if (sel && isGroup(sel)) toggleGroup(sel.seq);
        else if (sel && sel.pairSeq != null) select(store.bySeq.get(sel.pairSeq));
      },
    },
    {
      key: 'g',
      label: 'Group runs on/off',
      when,
      run: () => {
        const nextGrouped = !grouped;
        const nextSel = sel && isGroup(sel) ? (store.bySeq.get(sel.seq) ?? null) : sel;
        setGrouped(nextGrouped);
        setSel(nextSel);
        revealSel(nextSel, { ...filter, grouped: nextGrouped });
      },
    },
    {
      key: 'Escape',
      label: 'Clear selection and filter',
      when,
      run: () => {
        setSel(null);
        setQ('');
        setTailTick((t) => t + 1);
      },
    },
    { key: ' ', label: 'Pause / resume', when, run: () => setPaused((p) => !p) },
    {
      key: ['1', '2', '3'],
      display: '1 / 2 / 3',
      label: 'Toggle direction',
      when,
      run: (event) => {
        const k = DIRS[Number(event.key) - 1].k;
        setDirs((prev) => ({ ...prev, [k]: !prev[k] }));
      },
    },
    {
      key: 'l',
      label: 'Cycle lane',
      when,
      run: () => {
        const all = ['all', ...knownLanes(summary).map((l) => l.lane)];
        setLane(all[(all.indexOf(lane) + 1) % all.length]);
      },
    },
    {
      key: 'e',
      label: 'Export JSONL',
      when,
      run: () => {
        location.href = `${base}/export.jsonl`;
      },
    },
    {
      key: 'o',
      label: 'Open message in full page',
      when,
      run: () => {
        if (sel && !isGroup(sel)) window.open(msgUrl(base, sel.seq), '_blank', 'noopener');
      },
    },
    { key: 'v', label: 'Readable / raw JSON', when, run: () => setView((v) => (v === 'tree' ? 'raw' : 'tree')) },
  ]);

  // ------------------------------------------------------------- effects

  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (paused) return undefined;
    const poller = poll<[WireSummary, EventsPage]>({
      intervalMs: POLL_MS,
      load: (signal) =>
        Promise.all([
          fetchJson<WireSummary>(`${base}/summary`, { signal }),
          fetchJson<EventsPage>(`${base}/events?since=${since.current}&limit=${LIMIT}`, { signal }),
        ]),
      apply: ([next, page]) => {
        const dropped = store.ingest(page.events ?? [], !!page.gap);
        for (const seq of dropped) payloads.delete(seq);
        if (dropped.length) {
          setOpen((prev) => {
            if (!dropped.some((seq) => prev.has(seq))) return prev;
            const kept = new Set(prev);
            for (const seq of dropped) kept.delete(seq);
            return kept;
          });
        }
        setSel((prev) => (prev && !isGroup(prev) && !store.bySeq.has(prev.seq) ? null : prev));
        if (typeof page.nextSeq === 'number') since.current = page.nextSeq;
        setSummary(next);
        setVersion((v) => v + 1);
        setTailTick((t) => t + 1);
      },
      onStatus: (status) => {
        if (status !== 'loading') setConnHidden(status === 'ok');
      },
    });
    return () => poller.dispose();
  }, [base, paused, store, payloads]);

  const mode = summary ? summary.mode : null;
  const { show: showBanner, hide: hideBanner } = banner;
  useEffect(() => {
    if (mode === 'off') showBanner(CAPTURE_OFF, 'info');
    else hideBanner();
  }, [mode, showBanner, hideBanner]);

  // The selected message's payload, fetched once and cached until evicted.
  const shownEv = sel && !isGroup(sel) ? sel : null;
  const latestSel = useLatest(sel);
  useEffect(() => {
    const signal = life.current?.signal;
    if (!signal || !shownEv?.hasPayload || payloads.has(shownEv.seq)) return;
    const seq = shownEv.seq;
    payloads.set(seq, { loading: true });
    fetchJson<WireEvent>(`${base}/event/${seq}`, { signal })
      .then(
        (d) => {
          payloads.set(seq, { text: d.payload == null ? null : String(d.payload) });
        },
        (err: unknown) => {
          if (signal.aborted) return;
          payloads.set(
            seq,
            err instanceof HttpError && err.status === 404
              ? { evicted: true }
              : { error: `failed to load payload: ${err instanceof Error ? err.message : String(err)}` },
          );
        },
      )
      .then(() => {
        const current = latestSel.current;
        if (!signal.aborted && current && !isGroup(current) && current.seq === seq) setPayloadTick((t) => t + 1);
      });
  });

  // ------------------------------------------------------------- detail pane

  const shownGroup = sel && isGroup(sel) ? built.groups.get(sel.seq) : undefined;
  const pair = shownEv?.pairSeq != null ? store.bySeq.get(shownEv.pairSeq) : undefined;
  const cached = shownEv ? payloads.get(shownEv.seq) : undefined;
  let detailKey = '';
  if (shownEv) {
    const pk = shownEv.hasPayload ? payloadKey(cached) : (summary?.mode ?? '');
    detailKey = [shownEv.seq, shownEv.latencyUs, shownEv.error, shownEv.pairSeq, pair ? 1 : 0, view, pk].join('|');
  } else if (shownGroup) {
    detailKey = ['g', shownGroup.seq, shownGroup.members.length, shownGroup.bytes, open.has(shownGroup.seq)].join('|');
  }

  // A rebuilt pane for the same message in the same view keeps the payload box's scroll.
  const detailSeq = shownEv ? shownEv.seq : null;
  const shown = useRef<{ key: string; seq: number | null; view: View | null }>({ key: '', seq: null, view: null });
  const keepBox =
    detailSeq !== null && detailKey !== shown.current.key && shown.current.seq === detailSeq && shown.current.view === view
      ? (pane.current?.querySelector<HTMLElement>('.lb-acp-wire__payload')?.scrollTop ?? 0)
      : 0;

  // While a row is selected the table stops following the tail; keep the top
  // visible row pinned so the 400-row window sliding never moves the view.
  // Measured before this render commits, applied right after.
  const anchor = sel ? topRow(wrap.current, tbody.current) : null;

  // ------------------------------------------------------------- layout effects

  useLayoutEffect(() => {
    if (wf.current) paintWaterfall(wf.current, store.events, summary, lane, sel);
  }, [store, version, summary, lane, sel]);

  useLayoutEffect(() => {
    const box = wrap.current;
    if (!anchor || !box || !anchor.row.isConnected) return;
    box.scrollTop += anchor.row.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.offset;
  });

  useLayoutEffect(() => {
    shown.current = { key: detailKey, seq: detailSeq, view: detailSeq === null ? null : view };
    if (!keepBox) return;
    const box = pane.current?.querySelector<HTMLElement>('.lb-acp-wire__payload');
    if (box) box.scrollTop = keepBox;
  }, [detailKey, detailSeq, view, keepBox]);

  // Only a `select()` scrolls the row into view (the closure is that commit's selection).
  const sk = selKey(sel);
  useLayoutEffect(() => {
    if (revealTick) tbody.current?.querySelector(`tr[data-key="${sk}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [revealTick]);

  useLayoutEffect(() => {
    const box = wrap.current;
    if (box && !sel) box.scrollTop = box.scrollHeight;
  }, [tailTick]);

  // ------------------------------------------------------------- render

  const s = summary;
  const dirStats = s?.dirs ?? {};
  const bytesOf = (k: WireDir): string => {
    const d = dirStats[k];
    return d ? fmtBytes(d.bytes) : '—';
  };
  const inFlight = s ? s.inFlight : 0;
  const evicted = s ? s.evicted : 0;
  const stats: Stat[] = [
    { key: 'rate', label: 'msg/s (5s)', value: rates.perSec.toFixed(1) },
    { key: 'to_agent', label: '→ agent', value: bytesOf('to_agent') },
    { key: 'from_agent', label: '← agent', value: bytesOf('from_agent') },
    { key: 'to_ui', label: '⇢ ui (IPC)', value: bytesOf('to_ui') },
    {
      key: 'rpc',
      label: 'RPC p50 / p95',
      value: rates.p50 != null ? `${fmtUs(rates.p50)} / ${fmtUs(rates.p95)}` : '—',
    },
    { key: 'inflight', label: 'in-flight', value: String(inFlight), tone: inFlight ? 'add' : undefined },
    { key: 'evicted', label: 'evicted', value: String(evicted), tone: evicted ? undefined : 'add' },
  ];
  const modeTone: Tone = mode === 'full' ? 'del' : mode === 'meta' ? 'accent' : 'muted';
  const lanes: Lane[] = [{ lane: 'all', backend: '', remote: false }, ...knownLanes(s)];

  const rows = built.rows.slice(-MAX_ROWS);
  const msgCount =
    `· ${built.real}` + (built.rows.length > rows.length ? ` (showing last ${rows.length} rows)` : '');

  const methods = s?.methods ?? [];
  const methodTotal = methods.reduce((sum, m) => sum + m.bytes, 0) || 1;
  const methodColumns: Column<MethodRow>[] = [
    { id: 'method', label: 'method', render: (m) => m.method },
    { id: 'count', label: 'count', numeric: true, render: (m) => String(m.count) },
    { id: 'bytes', label: 'bytes', numeric: true, render: (m) => fmtBytes(m.bytes) },
    {
      id: 'share',
      label: 'share',
      render: (m) => (
        <div className="lb-acp-wire__mbar">
          <i style={{ width: `${((m.bytes / methodTotal) * 100).toFixed(1)}%` }} />
        </div>
      ),
    },
    { id: 'p50', label: 'p50', numeric: true, render: (m) => fmtUs(m.p50Us) },
    { id: 'p95', label: 'p95', numeric: true, render: (m) => fmtUs(m.p95Us) },
    { id: 'max', label: 'max', numeric: true, render: (m) => fmtUs(m.maxUs) },
    {
      id: 'errors',
      label: 'errors',
      numeric: true,
      render: (m) => <span className={m.errors ? 'lb-acp-wire__red' : 'lb-muted'}>{String(m.errors)}</span>,
    },
  ];

  return (
    <div className="lb-page lb-page--split lb-acp-wire">
      <div className="lb-acp-wire__bar">
        <Dot state={paused ? 'idle' : 'live'} />
        <Pill label={paused ? 'paused' : 'live'} tone={paused ? 'accent' : 'add'} />
        <Pill label={`capture: ${mode ?? '…'}`} tone={modeTone} />
        <Pill label="disconnected" tone="del" hidden={connHidden} />
        <span className="lb-acp-wire__note">
          {s
            ? `ring ${s.events} events · evicted ${s.evicted} · payload ` +
              `${(s.payloadBytes / 1048576).toFixed(1)}/${(s.payloadCapBytes / 1048576).toFixed(0)} MB`
            : 'connecting…'}
        </span>
        <span className="lb-acp-wire__spacer" />
        <SearchFilter
          placeholder="filter method, id, lane…"
          escape="clear-and-leave"
          value={q}
          onChange={setQ}
          onSubmit={(): void => input.current?.blur()}
          inputRef={input}
        />
      </div>
      <Banner {...banner.props} />
      <div className="lb-acp-wire__stats">
        <StatBar stats={stats} />
      </div>
      <div className="lb-acp-wire__bar">
        <span className="lb-acp-wire__note">lane</span>
        <span className="lb-acp-wire__chips">
          {lanes.map((l) => (
            <Button
              key={l.lane}
              label={l.lane === 'all' ? 'all lanes' : `${l.lane} · ${l.backend}${l.remote ? ' · remote' : ''}`}
              variant="toggle"
              pressed={l.lane === lane}
              data-lane={l.lane}
              onClick={(): void => setLane(l.lane)}
            />
          ))}
        </span>
        <span className="lb-acp-wire__note">dir</span>
        <span className="lb-acp-wire__chips">
          {DIRS.map((d, i) => (
            <Button
              key={d.k}
              label={`${i + 1} ${d.label}`}
              variant="toggle"
              pressed={dirs[d.k]}
              onClick={(): void => setDirs((prev) => ({ ...prev, [d.k]: !prev[d.k] }))}
            />
          ))}
        </span>
      </div>
      <Card title="Waterfall — request spans & notifications (last 60s)">
        {/* Children are painted by `paintWaterfall`; React renders none. */}
        <svg
          ref={wf}
          className="lb-acp-wire__wf"
          viewBox="0 0 1000 60"
          preserveAspectRatio="none"
          onClick={onWaterfallClick}
        />
        <div className="lb-acp-wire__legend">
          {LEGEND.map(([color, text], i) => (
            <span key={text}>
              <i
                className={i === 3 ? 'lb-acp-wire__sw lb-acp-wire__sw--tick' : 'lb-acp-wire__sw'}
                style={{ background: color }}
              />
              {text}
            </span>
          ))}
        </div>
      </Card>
      <div className="lb-acp-wire__split">
        <Card title="Messages" aside={<span className="lb-acp-wire__acc">{msgCount}</span>}>
          <div className="lb-acp-wire__scroll" ref={wrap}>
            <table className="lb-table lb-acp-wire__table" hidden={built.real === 0}>
              <thead>
                <tr>
                  <th>time</th>
                  <th>lane</th>
                  <th>dir</th>
                  <th>kind</th>
                  <th className="lb-acp-wire__fill">method</th>
                  <th className="lb-table__num">id</th>
                  <th className="lb-table__num">bytes</th>
                  <th className="lb-table__num">latency</th>
                </tr>
              </thead>
              <tbody ref={tbody} onClick={onRowsClick}>
                {rows.map((r) => {
                  const key = rowKey(r);
                  const selected = key === sk;
                  const isOpen = r.kind === 'group' && open.has(r.grp.seq);
                  return <WireRow key={key} row={r} selected={selected} open={isOpen} deps={rowDeps(r, selected, isOpen)} />;
                })}
              </tbody>
            </table>
            <div className="lb-acp-wire__empty" hidden={built.real > 0}>
              no events captured yet
            </div>
          </div>
        </Card>
        <Card
          title="Detail"
          aside={
            <a
              className="lb-acp-wire__open"
              target="_blank"
              rel="noopener"
              hidden={!shownEv}
              href={shownEv ? msgUrl(base, shownEv.seq) : undefined}
            >
              {'open full page ↗ '}
              <kbd>o</kbd>
            </a>
          }
        >
          <div className="lb-acp-wire__detail" ref={pane}>
            <Detail
              key={detailKey}
              detailKey={detailKey}
              ev={shownEv}
              group={shownGroup}
              open={shownGroup ? open.has(shownGroup.seq) : false}
              pair={pair}
              payload={cached}
              view={view}
              mode={s ? s.mode : 'meta'}
              onPair={onPair}
              onView={setView}
            />
          </div>
        </Card>
      </div>
      <Card title="By method">
        <DataTable<MethodRow>
          columns={methodColumns}
          rows={methods}
          itemKey={(m) => m.method}
          deps={(m) => [m.count, m.bytes, m.p50Us, m.p95Us, m.maxUs, m.errors, methodTotal]}
          hidden={!methods.length}
        />
        <p className="lb-acp-wire__note" hidden={methods.length > 0}>
          no methods yet
        </p>
      </Card>
      <KbdHints entries={DASH_HINTS} note="polling 1s · /acp-wire · spec 288" />
    </div>
  );
}

// ---------------------------------------------------------------- message page

interface MessageState {
  readonly seq: number;
  /** Load generation: every load (even of the same seq) refetches. */
  readonly n: number;
  readonly ev: WireEvent | null;
  readonly err: string | null;
}

function WireMessage({ base, seq: firstSeq }: { readonly base: string; readonly seq: number }): JSX.Element {
  const { setTitle } = useShell();
  const banner = useBanner();
  const [msg, setMsg] = useState<MessageState>({ seq: firstSeq, n: 0, ev: null, err: null });
  const [summary, setSummary] = useState<WireSummary | null>(null);
  const [view, setView] = useState<View>('tree');
  const ev = msg.ev;

  const load = useCallback(
    (seq: number, push: boolean): void => {
      if (seq < 0) return;
      if (push) history.pushState(null, '', msgUrl(base, seq));
      setMsg((prev) => ({ seq, n: prev.n + 1, ev: null, err: null }));
    },
    [base],
  );

  const copyMessage = async (): Promise<void> => {
    if (!ev) return;
    let text: string;
    if (ev.payload != null) {
      try {
        text = JSON.stringify(JSON.parse(ev.payload), null, 2);
      } catch {
        text = String(ev.payload);
      }
    } else text = JSON.stringify(ev, null, 2);
    const ok = await copyText(text);
    if (ok) {
      banner.show(ev.payload != null ? 'payload copied' : 'metadata copied (no payload captured)', 'ok', 1600);
    } else banner.show('copy failed', 'error', 1600);
  };

  useKeymap([
    { key: '[', label: 'Previous seq', when, run: () => load(msg.seq - 1, true) },
    { key: ']', label: 'Next seq', when, run: () => load(msg.seq + 1, true) },
    {
      key: 'Enter',
      label: 'Jump to pair',
      when,
      run: () => {
        if (ev?.pairSeq != null) load(ev.pairSeq, true);
      },
    },
    { key: 'j', label: 'Scroll down', when, run: () => window.scrollBy(0, 60) },
    { key: 'k', label: 'Scroll up', when, run: () => window.scrollBy(0, -60) },
    { key: 'v', label: 'Readable / raw JSON', when, run: () => setView((v) => (v === 'tree' ? 'raw' : 'tree')) },
    { key: 'y', label: 'Copy JSON', when, run: () => void copyMessage() },
    {
      key: 'Escape',
      label: 'Back to profiler',
      when,
      run: () => {
        location.href = base;
      },
    },
  ]);

  useEffect(() => {
    const onPop = (): void => {
      const m = MSG_RE.exec(location.pathname);
      if (m) load(Number(m[2]), false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [load]);

  // Summary only names the capture mode for the "payload not captured" notice.
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<WireSummary>(`${base}/summary`, { signal: controller.signal }).then(setSummary, () => {});
    return () => controller.abort();
  }, [base]);

  const { seq, n } = msg;
  useEffect(() => {
    const controller = new AbortController();
    window.scrollTo?.(0, 0);
    fetchJson<WireEvent>(`${base}/event/${seq}`, { signal: controller.signal }).then(
      (d) => setMsg((prev) => (prev.n === n ? { ...prev, ev: d } : prev)),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const text =
          err instanceof HttpError && err.status === 404
            ? `seq ${seq} is not in the ring — evicted, cleared, or not captured yet`
            : `failed to load message: ${err instanceof Error ? err.message : String(err)}`;
        setMsg((prev) => (prev.n === n ? { ...prev, err: text } : prev));
      },
    );
    return () => controller.abort();
  }, [base, seq, n]);

  useEffect(() => {
    setTitle(ev ? `${ev.method || ev.kind} · seq ${ev.seq} — ACP Wire` : `seq ${seq} — ACP Wire`);
  }, [setTitle, ev, seq]);

  const payload = useMemo<PayloadState | undefined>(
    () => (ev ? { text: ev.payload == null ? null : String(ev.payload) } : undefined),
    [ev],
  );

  let meta: ReactNode;
  if (ev) {
    let pairDd: ReactNode = null;
    if (ev.pairSeq != null) {
      const target = ev.pairSeq;
      pairDd = (
        <a
          href={msgUrl(base, target)}
          onClick={(event): void => {
            event.preventDefault();
            load(target, true);
          }}
        >
          {`seq ${target} ↵`}
        </a>
      );
    }
    meta = <MetaList e={ev} pairDd={pairDd} />;
  } else {
    meta = <p className={msg.err ? 'lb-acp-wire__red' : 'lb-acp-wire__note'}>{msg.err ?? 'loading…'}</p>;
  }

  return (
    <div className="lb-page lb-acp-wire lb-acp-wire--msg">
      <div className="lb-acp-wire__bar">
        <a className="lb-btn lb-btn--ghost" href={base}>
          ← profiler
        </a>
        <Pill label={`seq ${seq}`} tone="muted" />
        <span className="lb-acp-wire__spacer" />
        <Button label="[ prev seq" onClick={(): void => load(seq - 1, true)} />
        <Button label="next seq ]" onClick={(): void => load(seq + 1, true)} />
        <Button label="copy JSON" kbd="y" onClick={(): void => void copyMessage()} />
      </div>
      <Banner {...banner.props} />
      <Card title="Message">
        <div>{meta}</div>
      </Card>
      <Card title="Payload">
        <div>
          {ev ? (
            <Payload e={ev} c={payload} clipLong={false} view={view} mode={summary ? summary.mode : 'meta'} onView={setView} />
          ) : null}
        </div>
      </Card>
      <KbdHints entries={MSG_HINTS} note="/acp-wire · spec 288" />
    </div>
  );
}

// ------------------------------------------------------------------------ page

export interface AcpWirePageProps extends Partial<PageProps> {
  /** Default `location.pathname`, read once. */
  readonly pathname?: string;
}

export function AcpWirePage({ pathname }: AcpWirePageProps): JSX.Element {
  const [path] = useState(() => parsePath(pathname ?? location.pathname));
  return path.seq === null ? <WireDashboard base={path.base} /> : <WireMessage base={path.base} seq={path.seq} />;
}
