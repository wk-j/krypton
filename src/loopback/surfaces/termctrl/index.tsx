// Specs 198/330/341 — the Terminal Control monitor: a read-only roster of
// named termctrl sessions, the selected one's visible screen (on the harness
// cell grid) or its full retained log, polled while the tab is visible.
// Spec 361: a React page. The poll and fetch code reads and writes one mutable
// model across awaits (selection, view, the log cursor), as the class did; the
// model keeps its identity and `paint()` re-renders from it. The screen `<pre>`
// is filled by the harness cell grid, never by React; the log renders as
// memoized 2000-line chunks, so an append re-renders only the chunk it grows.

import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { JSX, UIEvent } from 'react';

import { gridifyText } from '../../../acp/cell-grid';
import type { PageProps } from '../../app';
import {
  Button,
  Chip,
  Dot,
  fetchJson,
  formatBytes,
  KbdHints,
  matchesQuery,
  Pill,
  poll,
  RosterList,
  SearchFilter,
  StatBar,
  useKeymap,
} from '../../kit';
import type { Poller, Tone } from '../../kit';
import { createAnsiText } from './ansi-text';
import type { AnsiText } from './ansi-text';

import '../../../acp/cell-grid.css';
import './termctrl.css';

const LOG_LINE_CAP = 200_000;
const LOG_CHUNK_LINES = 2000;
const LOG_ANCHOR_MAX = 64;

const HINTS: readonly (readonly [string, string])[] = [
  ['/', 'filter'],
  ['j k', 'select'],
  ['r', 'refresh'],
  ['v', 'screen/log'],
  ['g G', 'top/end'],
  ['w', 'wrap'],
  ['Esc', 'clear filter'],
];

export interface TermctrlSession {
  name: string;
  state: string;
  command?: string[] | null;
  cwd?: string | null;
  cols?: number | null;
  rows?: number | null;
  recording?: boolean;
  idleForMs?: number | null;
  error?: string | null;
  /** Client clock: when the session last printed (the Log view's new-output gate). */
  lastOutputAt?: number | null;
}

export interface SessionsPayload {
  available: boolean;
  terminalControlVersion?: string | null;
  sessions?: TermctrlSession[];
  error?: string | null;
}

type View = 'screen' | 'log';

type ConnKind = 'idle' | 'live' | 'del';

interface LogChunk {
  readonly id: number;
  readonly text: string;
  readonly lines: number;
}

interface LogState {
  name: string;
  decoder: AnsiText;
  openText: string;
  /** Replaced (never edited) when a chunk grows, so a chunk's text is its render key. */
  chunks: LogChunk[];
  nextChunk: number;
  lines: number;
  length: number | null;
  anchor: Uint8Array;
  truncated: boolean;
  trimmed: boolean;
  following: boolean;
  unseen: number;
  fetchedAt: number;
  nextAt: number;
  final: boolean;
  error: string | null;
}

interface EmptyNote {
  readonly title: string;
  readonly copy: string;
  readonly command: string;
  readonly isError: boolean;
}

interface Model {
  sessions: TermctrlSession[];
  selectedName: string | null;
  view: View;
  query: string;
  firstLoad: boolean;
  screenInFlight: boolean;
  logInFlight: boolean;
  readonly screenCache: Map<string, string>;
  /** What the screen `<pre>` shows; a new object per change. */
  screen: { readonly name: string | null; readonly text: string | null };
  log: LogState | null;
  /** Scroll the log to its end after the next commit. */
  followPending: boolean;
  /** `kind` stays null (no `data-state`) until the first status. */
  conn: { readonly kind: ConnKind | null; readonly text: string };
  stat: { version: string; sessions: string; refresh: string };
  refreshing: boolean;
  meta: { readonly command: string; readonly context: string };
  /** The last empty-state note; kept (hidden) while the preview shows. */
  empty: EmptyNote | null;
  emptyShown: boolean;
  nowrap: boolean;
}

function createModel(): Model {
  return {
    sessions: [],
    selectedName: null,
    view: 'screen',
    query: '',
    firstLoad: true,
    screenInFlight: false,
    logInFlight: false,
    screenCache: new Map(),
    screen: { name: null, text: null },
    log: null,
    followPending: false,
    conn: { kind: null, text: 'Connecting' },
    stat: { version: 'detecting', sessions: 'loading', refresh: 'waiting' },
    refreshing: false,
    meta: { command: 'Waiting for sessions', context: 'No session selected' },
    empty: null,
    emptyShown: false,
    nowrap: false,
  };
}

function commandLabel(session: TermctrlSession): string {
  return session.command && session.command.length ? session.command.join(' ') : 'session metadata unavailable';
}

function idleLabel(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return 'active now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s idle`;
  return `${Math.floor(ms / 60000)}m idle`;
}

function stateBadge(session: TermctrlSession): [string, Tone] {
  if (session.recording && session.state === 'running') return ['recording', 'accent'];
  if (session.state === 'running') return ['running', 'add'];
  if (session.state === 'exited' || session.state === 'stale') return [session.state, 'muted'];
  return [session.state, 'del'];
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function lastBytes(previous: Uint8Array, next: Uint8Array): Uint8Array {
  if (next.length >= LOG_ANCHOR_MAX) return next.slice(next.length - LOG_ANCHOR_MAX);
  const keep = Math.min(LOG_ANCHOR_MAX - next.length, previous.length);
  const merged = new Uint8Array(keep + next.length);
  merged.set(previous.subarray(previous.length - keep), 0);
  merged.set(next, keep);
  return merged;
}

/** `/termctrl/<token>` → `<token>`. */
export function tokenFromPath(pathname: string): string {
  return decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
}

function newLog(name: string): LogState {
  return {
    name,
    decoder: createAnsiText(),
    openText: '',
    chunks: [],
    nextChunk: 0,
    lines: 0,
    length: null,
    anchor: new Uint8Array(0),
    truncated: false,
    trimmed: false,
    following: true,
    unseen: 0,
    fetchedAt: 0,
    nextAt: 0,
    final: false,
    error: null,
  };
}

/** Lines fill the last chunk up to `LOG_CHUNK_LINES`, then open new ones; the cap drops whole oldest chunks. */
function appendLogLines(state: LogState, input: string[]): void {
  let lines = input;
  if (lines.length > LOG_LINE_CAP) {
    lines = lines.slice(lines.length - LOG_LINE_CAP);
    state.trimmed = true;
  }
  let start = 0;
  const last = state.chunks[state.chunks.length - 1];
  if (last && last.lines < LOG_CHUNK_LINES && lines.length) {
    start = Math.min(LOG_CHUNK_LINES - last.lines, lines.length);
    const slice = lines.slice(0, start);
    state.chunks[state.chunks.length - 1] = { id: last.id, text: `${last.text}${slice.join('\n')}\n`, lines: last.lines + start };
    state.lines += start;
  }
  for (; start < lines.length; start += LOG_CHUNK_LINES) {
    const slice = lines.slice(start, start + LOG_CHUNK_LINES);
    state.chunks.push({ id: state.nextChunk++, text: `${slice.join('\n')}\n`, lines: slice.length });
    state.lines += slice.length;
  }
  if (!state.following) state.unseen += lines.length;
  while (state.lines > LOG_LINE_CAP && state.chunks.length > 1) {
    const oldest = state.chunks.shift();
    if (!oldest) break;
    state.lines -= oldest.lines;
    state.trimmed = true;
  }
}

function logStateText(log: LogState | null): string {
  if (!log) return 'Full log';
  const lines = log.lines + (log.openText ? 1 : 0);
  const parts = ['Full log', `${lines.toLocaleString('en-US')} lines`, formatBytes(log.length || 0)];
  parts.push(log.following ? 'following' : `paused · ${log.unseen.toLocaleString('en-US')} new · G`);
  if (log.truncated || log.trimmed) parts.push('older output dropped');
  if (log.error) parts.push(log.error);
  else if (log.length && !lines) parts.push('no line output · full-screen app? v for Screen');
  return parts.join(' · ');
}

function visibleSessions(m: Model): TermctrlSession[] {
  const query = m.query.trim();
  if (!query) return m.sessions;
  return m.sessions.filter((s) => matchesQuery([s.name, s.state, commandLabel(s), s.cwd ?? ''].join(' '), query));
}

function sessionDeps(session: TermctrlSession): readonly unknown[] {
  return [session.state, session.recording, commandLabel(session), session.cols, session.rows, session.idleForMs];
}

function sessionKey(session: TermctrlSession): string {
  return session.name;
}

function renderRow(session: TermctrlSession): JSX.Element {
  const [label, tone] = stateBadge(session);
  return (
    <div className="lb-termctrl__session">
      <span className="lb-termctrl__row">
        <span className="lb-termctrl__name">{session.name}</span>
        <Pill label={label} tone={tone} />
      </span>
      <span className="lb-termctrl__cmd">{commandLabel(session)}</span>
      <span className="lb-termctrl__row">
        <span className="lb-termctrl__sub">{session.cols && session.rows ? `${session.cols} × ${session.rows}` : 'no viewport'}</span>
        <span className="lb-termctrl__sub">
          {idleLabel(session.idleForMs) || (session.state === 'exited' ? 'final screen' : 'unavailable')}
        </span>
      </span>
    </div>
  );
}

/** One run of committed log lines: a single text node inside the log `<pre>`. */
const LogChunkText = memo(function LogChunkText({ text }: { readonly text: string }): string {
  return text;
});

export interface TermctrlPageProps extends Partial<PageProps> {
  /** The monitor token; the browser reads it from `location.pathname`. */
  readonly token?: string;
}

export function TermctrlPage({ token = tokenFromPath(location.pathname) }: TermctrlPageProps): JSX.Element {
  const apiBase = `/termctrl/api/${encodeURIComponent(token)}`;
  const [m] = useState(createModel);
  const [, paint] = useReducer((n: number): number => n + 1, 0);
  const listPoll = useRef<Poller | null>(null);
  const previewHead = useRef<HTMLDivElement>(null);
  const screenEl = useRef<HTMLPreElement>(null);
  const logEl = useRef<HTMLPreElement>(null);

  // ─── Roster ────────────────────────────────────────────────────────

  const selectedSession = (): TermctrlSession | null => m.sessions.find((s) => s.name === m.selectedName) ?? null;

  const selectSession = (name: string): void => {
    if (name === m.selectedName) return;
    discardLog();
    m.selectedName = name;
    renderSelection();
    refreshSelected(false);
  };

  // ─── Status ────────────────────────────────────────────────────────

  const setConnection = (kind: ConnKind, text: string): void => {
    m.conn = { kind, text };
    paint();
  };

  const showEmpty = (title: string, copy: string, command: string, isError: boolean): void => {
    m.empty = { title, copy, command, isError };
    m.emptyShown = true;
    paint();
  };

  const showPreview = (): void => {
    m.emptyShown = false;
    paint();
  };

  const renderSelection = (): void => {
    const session = selectedSession();
    if (!session) {
      m.meta = { command: 'No session selected', context: 'Choose a session from the roster' };
      showEmpty('No tracked sessions', 'Start a named session and it will appear on the next refresh.', 'termctrl start remote -- ssh user@host', false);
      return;
    }
    m.meta = {
      command: commandLabel(session),
      context: (session.cwd || 'cwd unavailable') + (session.cols && session.rows ? ` · ${session.cols} × ${session.rows}` : ''),
    };
    if (session.state === 'stale' || session.state === 'incompatible') {
      showEmpty(
        session.state === 'stale' ? 'Session is stale' : 'Session protocol is incompatible',
        session.error || 'Terminal Control cannot read this session.',
        `termctrl status ${session.name}`,
        session.state === 'incompatible',
      );
      return;
    }
    const cached = m.screenCache.get(session.name);
    if (m.view === 'screen' && session.state === 'exited' && cached !== undefined) setScreenText(session.name, cached);
    showPreview();
  };

  const setView = (next: View): void => {
    if (next === m.view) return;
    m.view = next;
    renderSelection();
    refreshSelected(false);
  };

  const refreshSelected = (force: boolean): void => {
    if (m.view === 'log') void refreshLog(force);
    else void refreshScreen();
  };

  const refreshNow = (): void => {
    m.stat = { ...m.stat, refresh: 'refreshing' };
    m.refreshing = true;
    paint();
    void (listPoll.current?.refresh() ?? Promise.resolve()).finally(() => {
      m.refreshing = false;
      paint();
    });
    refreshSelected(true);
  };

  const applySessions = (payload: SessionsPayload): void => {
    const receivedAt = Date.now();
    if (!payload.available) {
      m.sessions = [];
      m.selectedName = null;
      m.screenCache.clear();
      discardLog();
      setConnection('del', 'termctrl unavailable');
      m.stat = { ...m.stat, version: 'not detected', sessions: 'unknown' };
      const windows = /Win/.test(navigator.platform || '');
      m.firstLoad = false;
      showEmpty(
        'termctrl is unavailable',
        windows ? 'Persistent sessions currently require macOS or Linux.' : payload.error || 'Install Terminal Control and refresh this page.',
        windows ? 'macOS or Linux required' : 'cargo install terminal-control',
        true,
      );
      return;
    }
    if (payload.error) {
      // A failed `list` says nothing about the sessions: keep the last roster
      // and selection, so a hiccup cannot move the Log view to another session
      // and its whole ring.
      setConnection('del', 'CLI response error');
      m.stat = { ...m.stat, version: payload.terminalControlVersion || 'unknown' };
      if (m.firstLoad) showEmpty('termctrl returned an error', payload.error, 'termctrl list --json', true);
      m.firstLoad = false;
      return;
    }
    const previousStates = new Map(m.sessions.map((s) => [s.name, s.state]));
    m.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    for (const session of m.sessions) {
      session.lastOutputAt = session.idleForMs == null ? null : receivedAt - session.idleForMs;
      if (session.state === 'exited' && previousStates.get(session.name) !== 'exited') m.screenCache.delete(session.name);
    }
    for (const name of [...m.screenCache.keys()]) {
      if (!m.sessions.some((s) => s.name === name)) m.screenCache.delete(name);
    }
    if (!m.sessions.some((s) => s.name === m.selectedName)) {
      discardLog();
      m.selectedName = m.sessions.length ? m.sessions[0].name : null;
    }
    setConnection('live', 'Connected to termctrl');
    const running = m.sessions.filter((s) => s.state === 'running').length;
    m.stat = {
      version: payload.terminalControlVersion || 'unknown',
      sessions: `${m.sessions.length} total · ${running} running`,
      refresh: 'just now',
    };
    renderSelection();
    if (m.selectedName) refreshSelected(false);
    m.firstLoad = false;
  };

  // ─── Screen view ───────────────────────────────────────────────────

  const setScreenText = (name: string, text: string): void => {
    if (m.screen.name === name && m.screen.text === text) return;
    m.screen = { name, text };
    paint();
  };

  const refreshScreen = async (): Promise<void> => {
    const session = selectedSession();
    if (m.view !== 'screen' || !session || m.screenInFlight || document.visibilityState === 'hidden') return;
    if (session.state === 'stale' || session.state === 'incompatible') return;
    const cached = m.screenCache.get(session.name);
    if (session.state === 'exited' && cached !== undefined) {
      setScreenText(session.name, cached);
      showPreview();
      return;
    }
    m.screenInFlight = true;
    const selectedAtStart = session.name;
    try {
      const payload = await fetchJson<{ text?: unknown }>(`${apiBase}/screen/${encodeURIComponent(session.name)}`, {
        headers: { Accept: 'application/json' },
      });
      const text = typeof payload.text === 'string' ? payload.text : '';
      const current = selectedSession();
      if (session.state === 'exited' && current?.name === selectedAtStart && current.state === 'exited') {
        m.screenCache.set(selectedAtStart, text);
      }
      if (m.selectedName === selectedAtStart && m.view === 'screen') {
        setScreenText(selectedAtStart, text);
        showPreview();
      }
    } catch {
      if (m.selectedName === selectedAtStart) {
        setScreenText(selectedAtStart, 'Visible screen is temporarily unavailable.\nThe next poll will retry.');
      }
    } finally {
      m.screenInFlight = false;
    }
  };

  // ─── Log view (spec 330) ───────────────────────────────────────────
  // The page owns the cursor: the ring length it last saw and its last bytes.
  // Krypton answers with only the bytes after them (append) or the whole ring
  // when it cannot place them (reset).

  const discardLog = (): void => {
    m.log = null;
    paint();
  };

  const followLogEnd = (): void => {
    if (!m.log) return;
    m.log.following = true;
    m.log.unseen = 0;
    m.followPending = true;
    paint();
  };

  const refreshLog = async (force: boolean): Promise<void> => {
    const session = selectedSession();
    if (m.view !== 'log' || !session || m.logInFlight || document.visibilityState === 'hidden') return;
    if (session.state === 'stale' || session.state === 'incompatible') return;
    if (!m.log || m.log.name !== session.name) {
      m.log = newLog(session.name);
      paint();
    }
    const state = m.log;
    const now = Date.now();
    if (!force && state.length !== null) {
      if (state.final || now < state.nextAt) return;
      // An exited session is read once more for its final output, then kept.
      const newOutput = session.lastOutputAt != null && session.lastOutputAt > state.fetchedAt - 1000;
      if (!newOutput && session.state !== 'exited') return;
    }
    m.logInFlight = true;
    state.fetchedAt = now;
    let received = 0;
    let idleGap = 2000;
    let url = `${apiBase}/log/${encodeURIComponent(session.name)}`;
    if (state.length !== null && state.anchor.length) url += `?length=${state.length}&anchor=${toHex(state.anchor)}`;
    try {
      // Raw bytes plus cursor headers: `fetchJson` does not fit this route.
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(problem?.error ? problem.error : 'session log unavailable');
      }
      const body = new Uint8Array(await response.arrayBuffer());
      received = Date.now();
      if (m.log !== state) return;
      const truncated = response.headers.get('x-termctrl-log-truncated') === 'true';
      const wasFollowing = state.following;
      if (response.headers.get('x-termctrl-log-mode') !== 'append') {
        state.decoder = createAnsiText({ dropFirstLine: truncated });
        state.chunks = [];
        state.lines = 0;
        state.unseen = 0;
        state.anchor = lastBytes(new Uint8Array(0), body);
      } else {
        state.anchor = lastBytes(state.anchor, body);
      }
      state.length = Number(response.headers.get('x-termctrl-log-length')) || 0;
      state.truncated = truncated;
      state.error = null;
      const decoded = state.decoder.push(body);
      appendLogLines(state, decoded.lines);
      state.openText = decoded.open;
      if (!state.lines && !state.openText) idleGap = 30000;
      if (session.state === 'exited') state.final = true;
      if (wasFollowing) followLogEnd();
      else paint();
    } catch (error) {
      if (m.log === state) {
        state.error = error instanceof Error && error.message ? error.message : 'session log unavailable';
        paint();
      }
    } finally {
      // Each read re-serializes the whole ring in termctrl: keep reads under
      // ~10% of wall time. A ring with no line output (a full-screen app whose
      // start was dropped) is re-read only every 30 s.
      const spent = (received || Date.now()) - now;
      state.nextAt = Date.now() + Math.max(idleGap, 10 * spent);
      m.logInFlight = false;
    }
  };

  const onLogScroll = (event: UIEvent<HTMLPreElement>): void => {
    const log = m.log;
    if (!log) return;
    const pre = event.currentTarget;
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    if (atEnd === log.following) return;
    log.following = atEnd;
    if (atEnd) log.unseen = 0;
    paint();
  };

  // ─── Keys and polls ────────────────────────────────────────────────

  const inLog = (): boolean => m.view === 'log';
  useKeymap([
    {
      key: 'Escape',
      label: 'Clear the filter',
      run: () => {
        if (!m.query) return false;
        m.query = '';
        paint();
      },
    },
    { key: 'r', label: 'Refresh now', run: () => refreshNow() },
    { key: 'v', label: 'Toggle Screen / Log', run: () => setView(m.view === 'screen' ? 'log' : 'screen') },
    { key: 'G', label: 'Follow the log end', when: inLog, run: () => followLogEnd() },
    {
      key: 'g',
      label: 'Log top',
      when: inLog,
      run: () => {
        if (logEl.current) logEl.current.scrollTop = 0;
      },
    },
    {
      key: 'w',
      label: 'Toggle log wrap',
      when: inLog,
      run: () => {
        m.nowrap = !m.nowrap;
        paint();
        if (m.log?.following) followLogEnd();
      },
    },
  ]);

  useEffect(() => {
    const list = poll<SessionsPayload>({
      intervalMs: 2000,
      load: (signal) => fetchJson<SessionsPayload>(`${apiBase}/sessions`, { signal, headers: { Accept: 'application/json' } }),
      apply: (payload) => applySessions(payload),
      onStatus: (status) => {
        m.refreshing = false;
        paint();
        if (status !== 'reconnecting') return;
        setConnection('del', 'Monitor request failed');
        if (m.firstLoad) {
          showEmpty('Monitor request failed', 'Krypton could not read the local monitor endpoint.', 'Press r to retry', true);
        }
      },
    });
    const screen = poll<void>({ intervalMs: 1000, load: () => refreshScreen(), apply: () => undefined });
    const log = poll<void>({ intervalMs: 1000, load: () => refreshLog(false), apply: () => undefined });
    listPoll.current = list;
    return () => {
      list.dispose();
      screen.dispose();
      log.dispose();
      if (listPoll.current === list) listPoll.current = null;
    };
    // The model, `paint` and the element refs are stable; only the token restarts the polls.
  }, [apiBase]);

  // Specs 324/326: box drawing, blocks and wide text sit on the harness cell grid.
  const screen = m.screen;
  useLayoutEffect(() => {
    const pre = screenEl.current;
    if (!pre || screen.text === null) return;
    pre.textContent = screen.text;
    gridifyText(pre);
  }, [screen]);

  useLayoutEffect(() => {
    if (!m.followPending) return;
    m.followPending = false;
    const pre = logEl.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  });

  // ─── Render ────────────────────────────────────────────────────────

  const visible = visibleSessions(m);
  const log = m.log;
  const logClass = `lb-termctrl__screen lb-termctrl__log${m.nowrap ? ' lb-termctrl__log--nowrap' : ''}`;
  const empty = m.empty;

  return (
    <div className="lb-page lb-page--fill lb-termctrl">
      <div className="lb-termctrl__bar">
        <span className="lb-termctrl__conn" role="status" data-state={m.conn.kind ?? undefined}>
          <Dot state={m.conn.kind ?? 'idle'} />
          <span className="lb-termctrl__conn-text">{m.conn.text}</span>
        </span>
        <Chip text="read only" muted />
        <StatBar
          align="end"
          stats={[
            { key: 'version', label: 'Version', value: m.stat.version },
            { key: 'sessions', label: 'Sessions', value: m.stat.sessions },
            { key: 'refresh', label: 'Last refresh', value: m.stat.refresh },
          ]}
        />
      </div>
      <section className="lb-termctrl__layout">
        <aside className="lb-termctrl__roster" aria-label="Terminal sessions">
          <div className="lb-termctrl__roster-head">
            <h1 className="lb-h2">Sessions</h1>
            <SearchFilter
              placeholder="Filter sessions"
              value={m.query}
              count={`${visible.length} visible`}
              onChange={(query) => {
                m.query = query;
                paint();
              }}
            />
          </div>
          <RosterList<TermctrlSession>
            label="Tracked terminal sessions"
            items={visible}
            selected={m.selectedName}
            itemKey={sessionKey}
            wrap
            render={renderRow}
            deps={sessionDeps}
            onSelect={(session) => selectSession(session.name)}
            onOpen={() => {
              if (window.matchMedia('(max-width: 760px)').matches) {
                previewHead.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }}
          />
          <p className="lb-termctrl__no-match" hidden={visible.length > 0 || m.sessions.length === 0}>
            No sessions match the filter.
          </p>
        </aside>
        <article className="lb-termctrl__preview" aria-live="polite">
          <div ref={previewHead} className="lb-termctrl__preview-head">
            <div className="lb-termctrl__meta">
              <strong className="lb-termctrl__command">{m.meta.command}</strong>
              <code className="lb-termctrl__context">{m.meta.context}</code>
            </div>
            <div className="lb-termctrl__actions">
              <div className="lb-termctrl__views" role="group" aria-label="Preview">
                <Button
                  label="Screen"
                  variant="toggle"
                  pressed={m.view === 'screen'}
                  title="Visible screen (v)"
                  onClick={() => setView('screen')}
                />
                <Button label="Log" variant="toggle" pressed={m.view === 'log'} title="Full retained log (v)" onClick={() => setView('log')} />
              </div>
              <Button label="↻ Refresh" variant="ghost" kbd="r" title="Refresh now (r)" disabled={m.refreshing} onClick={() => refreshNow()} />
            </div>
          </div>
          <div className="lb-termctrl__wrap" hidden={m.emptyShown || m.view !== 'screen'}>
            <span className="lb-termctrl__state">Visible screen</span>
            <pre ref={screenEl} className="lb-termctrl__screen" aria-label="Selected terminal visible screen" />
          </div>
          <div className="lb-termctrl__wrap" hidden={m.emptyShown || m.view !== 'log'}>
            <span className={log && !log.following ? 'lb-termctrl__state lb-termctrl__state--paused' : 'lb-termctrl__state'}>
              {logStateText(log)}
            </span>
            <pre ref={logEl} className={logClass} tabIndex={0} aria-label="Selected terminal retained log" onScroll={onLogScroll}>
              {log?.chunks.map((chunk) => <LogChunkText key={chunk.id} text={chunk.text} />)}
              {log?.openText}
            </pre>
          </div>
          <div className={empty?.isError ? 'lb-termctrl__empty lb-termctrl__empty--error' : 'lb-termctrl__empty'} hidden={!m.emptyShown}>
            {empty ? (
              <>
                <span className="lb-termctrl__empty-icon">›_</span>
                <h2 className="lb-h2">{empty.title}</h2>
                <p className="lb-muted">{empty.copy}</p>
                <code className="lb-code">{empty.command}</code>
              </>
            ) : null}
          </div>
        </article>
      </section>
      <KbdHints entries={HINTS} note="list 2s · screen 1s · log on new output · pauses when hidden" />
    </div>
  );
}
