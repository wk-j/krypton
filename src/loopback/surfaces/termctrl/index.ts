// Specs 198/330/341 — the Terminal Control monitor: a read-only roster of
// named termctrl sessions, the selected one's visible screen (on the harness
// cell grid) or its full retained log, polled while the tab is visible.

import { gridifyText } from '../../../acp/cell-grid';
import { DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import {
  button,
  chip,
  dot,
  fetchJson,
  formatBytes,
  kbdHints,
  keymap,
  matchesQuery,
  pill,
  poll,
  RosterList,
  SearchFilter,
  setPressed,
  StatBar,
} from '../../kit';
import type { Poller, Tone } from '../../kit';
import { createAnsiText } from './ansi-text';
import type { AnsiText } from './ansi-text';

import '../../../acp/cell-grid.css';
import './termctrl.css';

const LOG_LINE_CAP = 200_000;
const LOG_CHUNK_LINES = 2000;
const LOG_ANCHOR_MAX = 64;

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

interface LogState {
  name: string;
  decoder: AnsiText;
  openNode: Text;
  openText: string;
  chunks: { node: Text; lines: number }[];
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

export class TermctrlView {
  readonly el: HTMLElement;
  private readonly bag = new DisposableBag();
  private readonly apiBase: string;
  private sessions: TermctrlSession[] = [];
  private selectedName: string | null = null;
  private view: View = 'screen';
  private firstLoad = true;
  private screenInFlight = false;
  private logInFlight = false;
  private readonly screenCache = new Map<string, string>();
  private shownScreen: { name: string | null; text: string | null } = { name: null, text: null };
  private log: LogState | null = null;

  private readonly connText = el('span', { class: 'lb-termctrl__conn-text', text: 'Connecting' });
  private connDot: HTMLElement = dot('idle');
  private readonly conn = el('span', { class: 'lb-termctrl__conn', attrs: { role: 'status' } }, this.connDot, this.connText);
  private readonly stats = new StatBar([], { align: 'end' });
  private stat = { version: 'detecting', sessions: 'loading', refresh: 'waiting' };
  private readonly filter: SearchFilter;
  private readonly roster: RosterList<TermctrlSession>;
  private readonly commandEl = el('strong', { class: 'lb-termctrl__command', text: 'Waiting for sessions' });
  private readonly contextEl = el('code', { class: 'lb-termctrl__context', text: 'No session selected' });
  private readonly previewHead: HTMLElement;
  private readonly viewScreen: HTMLButtonElement;
  private readonly viewLog: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly screenEl = el('pre', {
    class: 'lb-termctrl__screen',
    attrs: { 'aria-label': 'Selected terminal visible screen' },
  });
  private readonly screenWrap: HTMLElement;
  private readonly logEl = el('pre', {
    class: ['lb-termctrl__screen', 'lb-termctrl__log'],
    attrs: { tabindex: '0', 'aria-label': 'Selected terminal retained log' },
  });
  private readonly logStateEl = el('span', { class: 'lb-termctrl__state', text: 'Full log' });
  private readonly logWrap: HTMLElement;
  private readonly emptyEl = el('div', { class: 'lb-termctrl__empty', attrs: { hidden: true } });
  private readonly noMatch = el('p', { class: 'lb-termctrl__no-match', text: 'No sessions match the filter.', attrs: { hidden: true } });
  private readonly listPoll: Poller;
  private readonly screenPoll: Poller;
  private readonly logPoll: Poller;

  constructor(token: string) {
    this.apiBase = `/termctrl/api/${encodeURIComponent(token)}`;
    this.filter = new SearchFilter({
      placeholder: 'Filter sessions',
      onInput: () => this.renderSessions(),
    });
    this.roster = new RosterList<TermctrlSession>({
      label: 'Tracked terminal sessions',
      key: (session) => session.name,
      wrap: true,
      render: (session) => this.renderRow(session),
      deps: (session) => [session.state, session.recording, commandLabel(session), session.cols, session.rows, session.idleForMs],
      onSelect: (session) => this.selectSession(session.name),
      onOpen: () => {
        if (window.matchMedia('(max-width: 760px)').matches) {
          this.previewHead.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      },
    });

    this.viewScreen = button('Screen', {
      variant: 'toggle',
      pressed: true,
      title: 'Visible screen (v)',
      onClick: () => this.setView('screen'),
    });
    this.viewLog = button('Log', {
      variant: 'toggle',
      pressed: false,
      title: 'Full retained log (v)',
      onClick: () => this.setView('log'),
    });
    this.refreshButton = button('↻ Refresh', { variant: 'ghost', kbd: 'r', title: 'Refresh now (r)', onClick: () => this.refreshNow() });

    this.previewHead = el(
      'div',
      { class: 'lb-termctrl__preview-head' },
      el('div', { class: 'lb-termctrl__meta' }, this.commandEl, this.contextEl),
      el(
        'div',
        { class: 'lb-termctrl__actions' },
        el('div', { class: 'lb-termctrl__views', attrs: { role: 'group', 'aria-label': 'Preview' } }, this.viewScreen, this.viewLog),
        this.refreshButton,
      ),
    );
    this.screenWrap = el(
      'div',
      { class: 'lb-termctrl__wrap' },
      el('span', { class: 'lb-termctrl__state', text: 'Visible screen' }),
      this.screenEl,
    );
    this.logWrap = el('div', { class: 'lb-termctrl__wrap', attrs: { hidden: true } }, this.logStateEl, this.logEl);

    this.el = el(
      'div',
      { class: ['lb-page', 'lb-page--fill', 'lb-termctrl'] },
      el('div', { class: 'lb-termctrl__bar' }, this.conn, chip('read only', { muted: true }), this.stats.el),
      el(
        'section',
        { class: 'lb-termctrl__layout' },
        el(
          'aside',
          { class: 'lb-termctrl__roster', attrs: { 'aria-label': 'Terminal sessions' } },
          el('div', { class: 'lb-termctrl__roster-head' }, el('h1', { class: 'lb-h2', text: 'Sessions' }), this.filter.el),
          this.roster.el,
          this.noMatch,
        ),
        el(
          'article',
          { class: 'lb-termctrl__preview', attrs: { 'aria-live': 'polite' } },
          this.previewHead,
          this.screenWrap,
          this.logWrap,
          this.emptyEl,
        ),
      ),
      kbdHints(
        [
          ['/', 'filter'],
          ['j k', 'select'],
          ['r', 'refresh'],
          ['v', 'screen/log'],
          ['g G', 'top/end'],
          ['w', 'wrap'],
          ['Esc', 'clear filter'],
        ],
        'list 2s · screen 1s · log on new output · pauses when hidden',
      ),
    );
    this.filter.setCount('0 visible');
    this.renderStats();

    this.bag.listen(this.logEl, 'scroll', () => {
      const log = this.log;
      if (!log) return;
      const atEnd = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 4;
      if (atEnd === log.following) return;
      log.following = atEnd;
      if (atEnd) log.unseen = 0;
      this.renderLogState();
    });

    const inLog = (): boolean => this.view === 'log';
    this.bag.add(
      keymap().bindAll([
        {
          key: 'Escape',
          label: 'Clear the filter',
          run: () => {
            if (!this.filter.query) return false;
            this.filter.query = '';
          },
        },
        { key: 'r', label: 'Refresh now', run: () => this.refreshNow() },
        { key: 'v', label: 'Toggle Screen / Log', run: () => this.setView(this.view === 'screen' ? 'log' : 'screen') },
        { key: 'G', label: 'Follow the log end', when: inLog, run: () => this.followLogEnd() },
        {
          key: 'g',
          label: 'Log top',
          when: inLog,
          run: () => {
            this.logEl.scrollTop = 0;
          },
        },
        {
          key: 'w',
          label: 'Toggle log wrap',
          when: inLog,
          run: () => {
            this.logEl.classList.toggle('lb-termctrl__log--nowrap');
            if (this.log?.following) this.followLogEnd();
          },
        },
      ]),
    );

    this.listPoll = poll<SessionsPayload>({
      intervalMs: 2000,
      load: (signal) =>
        fetchJson<SessionsPayload>(`${this.apiBase}/sessions`, { signal, headers: { Accept: 'application/json' } }),
      apply: (payload) => this.applySessions(payload),
      onStatus: (status) => {
        this.refreshButton.disabled = false;
        if (status !== 'reconnecting') return;
        this.setConnection('del', 'Monitor request failed');
        if (this.firstLoad) {
          this.showEmpty('Monitor request failed', 'Krypton could not read the local monitor endpoint.', 'Press r to retry', true);
        }
      },
    });
    this.screenPoll = poll<void>({ intervalMs: 1000, load: () => this.refreshScreen(), apply: () => undefined });
    this.logPoll = poll<void>({ intervalMs: 1000, load: () => this.refreshLog(false), apply: () => undefined });
  }

  dispose(): void {
    this.listPoll.dispose();
    this.screenPoll.dispose();
    this.logPoll.dispose();
    this.bag.dispose();
    this.filter.dispose();
    this.roster.dispose();
  }

  // ─── Roster ────────────────────────────────────────────────────────

  private renderRow(session: TermctrlSession): HTMLElement {
    const [label, tone] = stateBadge(session);
    return el(
      'div',
      { class: 'lb-termctrl__session' },
      el('span', { class: 'lb-termctrl__row' }, el('span', { class: 'lb-termctrl__name', text: session.name }), pill(label, tone)),
      el('span', { class: 'lb-termctrl__cmd', text: commandLabel(session) }),
      el(
        'span',
        { class: 'lb-termctrl__row' },
        el('span', { class: 'lb-termctrl__sub', text: session.cols && session.rows ? `${session.cols} × ${session.rows}` : 'no viewport' }),
        el('span', {
          class: 'lb-termctrl__sub',
          text: idleLabel(session.idleForMs) || (session.state === 'exited' ? 'final screen' : 'unavailable'),
        }),
      ),
    );
  }

  private visibleSessions(): TermctrlSession[] {
    const query = this.filter.query.trim();
    if (!query) return this.sessions;
    return this.sessions.filter((s) => matchesQuery([s.name, s.state, commandLabel(s), s.cwd ?? ''].join(' '), query));
  }

  private renderSessions(): void {
    const visible = this.visibleSessions();
    this.filter.setCount(`${visible.length} visible`);
    this.roster.setItems(visible);
    this.roster.select(this.selectedName, false);
    this.noMatch.hidden = visible.length > 0 || this.sessions.length === 0;
  }

  private selectSession(name: string): void {
    if (name === this.selectedName) return;
    this.discardLog();
    this.selectedName = name;
    this.renderSessions();
    this.renderSelection();
    this.refreshSelected(false);
  }

  private selectedSession(): TermctrlSession | null {
    return this.sessions.find((s) => s.name === this.selectedName) ?? null;
  }

  // ─── Status ────────────────────────────────────────────────────────

  private setConnection(kind: 'idle' | 'live' | 'del', text: string): void {
    this.connText.textContent = text;
    const next = dot(kind);
    this.connDot.replaceWith(next);
    this.connDot = next;
    this.conn.dataset.state = kind;
  }

  private renderStats(): void {
    this.stats.update([
      { key: 'version', label: 'Version', value: this.stat.version },
      { key: 'sessions', label: 'Sessions', value: this.stat.sessions },
      { key: 'refresh', label: 'Last refresh', value: this.stat.refresh },
    ]);
  }

  private showEmpty(title: string, copy: string, command: string, isError: boolean): void {
    this.screenWrap.hidden = true;
    this.logWrap.hidden = true;
    this.emptyEl.hidden = false;
    this.emptyEl.classList.toggle('lb-termctrl__empty--error', isError);
    this.emptyEl.replaceChildren(
      el('span', { class: 'lb-termctrl__empty-icon', text: '›_' }),
      el('h2', { class: 'lb-h2', text: title }),
      el('p', { class: 'lb-muted', text: copy }),
      el('code', { class: 'lb-code', text: command }),
    );
  }

  private showPreview(): void {
    this.emptyEl.hidden = true;
    this.screenWrap.hidden = this.view !== 'screen';
    this.logWrap.hidden = this.view !== 'log';
  }

  private renderSelection(): void {
    const session = this.selectedSession();
    if (!session) {
      this.commandEl.textContent = 'No session selected';
      this.contextEl.textContent = 'Choose a session from the roster';
      this.showEmpty('No tracked sessions', 'Start a named session and it will appear on the next refresh.', 'termctrl start remote -- ssh user@host', false);
      return;
    }
    this.commandEl.textContent = commandLabel(session);
    this.contextEl.textContent =
      (session.cwd || 'cwd unavailable') + (session.cols && session.rows ? ` · ${session.cols} × ${session.rows}` : '');
    if (session.state === 'stale' || session.state === 'incompatible') {
      this.showEmpty(
        session.state === 'stale' ? 'Session is stale' : 'Session protocol is incompatible',
        session.error || 'Terminal Control cannot read this session.',
        `termctrl status ${session.name}`,
        session.state === 'incompatible',
      );
      return;
    }
    const cached = this.screenCache.get(session.name);
    if (this.view === 'screen' && session.state === 'exited' && cached !== undefined) this.setScreenText(session.name, cached);
    this.showPreview();
    if (this.view === 'log') this.renderLogState();
  }

  private setView(next: View): void {
    if (next === this.view) return;
    this.view = next;
    setPressed(this.viewScreen, next === 'screen');
    setPressed(this.viewLog, next === 'log');
    this.renderSelection();
    this.refreshSelected(false);
  }

  private refreshSelected(force: boolean): void {
    if (this.view === 'log') void this.refreshLog(force);
    else void this.refreshScreen();
  }

  private refreshNow(): void {
    this.stat.refresh = 'refreshing';
    this.renderStats();
    this.refreshButton.disabled = true;
    void this.listPoll.refresh().finally(() => {
      this.refreshButton.disabled = false;
    });
    this.refreshSelected(true);
  }

  private applySessions(payload: SessionsPayload): void {
    const receivedAt = Date.now();
    if (!payload.available) {
      this.sessions = [];
      this.selectedName = null;
      this.screenCache.clear();
      this.discardLog();
      this.setConnection('del', 'termctrl unavailable');
      this.stat = { ...this.stat, version: 'not detected', sessions: 'unknown' };
      this.renderStats();
      this.renderSessions();
      const windows = /Win/.test(navigator.platform || '');
      this.firstLoad = false;
      this.showEmpty(
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
      this.setConnection('del', 'CLI response error');
      this.stat.version = payload.terminalControlVersion || 'unknown';
      this.renderStats();
      if (this.firstLoad) this.showEmpty('termctrl returned an error', payload.error, 'termctrl list --json', true);
      this.firstLoad = false;
      return;
    }
    const previousStates = new Map(this.sessions.map((s) => [s.name, s.state]));
    this.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    for (const session of this.sessions) {
      session.lastOutputAt = session.idleForMs == null ? null : receivedAt - session.idleForMs;
      if (session.state === 'exited' && previousStates.get(session.name) !== 'exited') this.screenCache.delete(session.name);
    }
    for (const name of [...this.screenCache.keys()]) {
      if (!this.sessions.some((s) => s.name === name)) this.screenCache.delete(name);
    }
    if (!this.sessions.some((s) => s.name === this.selectedName)) {
      this.discardLog();
      this.selectedName = this.sessions.length ? this.sessions[0].name : null;
    }
    this.setConnection('live', 'Connected to termctrl');
    const running = this.sessions.filter((s) => s.state === 'running').length;
    this.stat = {
      version: payload.terminalControlVersion || 'unknown',
      sessions: `${this.sessions.length} total · ${running} running`,
      refresh: 'just now',
    };
    this.renderStats();
    this.renderSessions();
    this.renderSelection();
    if (this.selectedName) this.refreshSelected(false);
    this.firstLoad = false;
  }

  // ─── Screen view ───────────────────────────────────────────────────

  /** Specs 324/326: box drawing, blocks and wide text sit on the harness cell grid. */
  private setScreenText(name: string, text: string): void {
    if (this.shownScreen.name === name && this.shownScreen.text === text) return;
    this.shownScreen = { name, text };
    this.screenEl.textContent = text;
    gridifyText(this.screenEl);
  }

  private async refreshScreen(): Promise<void> {
    const session = this.selectedSession();
    if (this.view !== 'screen' || !session || this.screenInFlight || document.visibilityState === 'hidden') return;
    if (session.state === 'stale' || session.state === 'incompatible') return;
    const cached = this.screenCache.get(session.name);
    if (session.state === 'exited' && cached !== undefined) {
      this.setScreenText(session.name, cached);
      this.showPreview();
      return;
    }
    this.screenInFlight = true;
    const selectedAtStart = session.name;
    try {
      const payload = await fetchJson<{ text?: unknown }>(`${this.apiBase}/screen/${encodeURIComponent(session.name)}`, {
        headers: { Accept: 'application/json' },
      });
      const text = typeof payload.text === 'string' ? payload.text : '';
      const current = this.selectedSession();
      if (session.state === 'exited' && current?.name === selectedAtStart && current.state === 'exited') {
        this.screenCache.set(selectedAtStart, text);
      }
      if (this.selectedName === selectedAtStart && this.view === 'screen') {
        this.setScreenText(selectedAtStart, text);
        this.showPreview();
      }
    } catch {
      if (this.selectedName === selectedAtStart) {
        this.setScreenText(selectedAtStart, 'Visible screen is temporarily unavailable.\nThe next poll will retry.');
      }
    } finally {
      this.screenInFlight = false;
    }
  }

  // ─── Log view (spec 330) ───────────────────────────────────────────
  // The page owns the cursor: the ring length it last saw and its last bytes.
  // Krypton answers with only the bytes after them (append) or the whole ring
  // when it cannot place them (reset).

  private discardLog(): void {
    this.log = null;
    this.logEl.replaceChildren();
    this.renderLogState();
  }

  private newLog(name: string): LogState {
    const openNode = document.createTextNode('');
    this.logEl.replaceChildren(openNode);
    return {
      name,
      decoder: createAnsiText(),
      openNode,
      openText: '',
      chunks: [],
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

  private followLogEnd(): void {
    if (!this.log) return;
    this.log.following = true;
    this.log.unseen = 0;
    this.logEl.scrollTop = this.logEl.scrollHeight;
    this.renderLogState();
  }

  private appendLogLines(state: LogState, input: string[]): void {
    let lines = input;
    if (lines.length > LOG_LINE_CAP) {
      lines = lines.slice(lines.length - LOG_LINE_CAP);
      state.trimmed = true;
    }
    for (let start = 0; start < lines.length; start += LOG_CHUNK_LINES) {
      const slice = lines.slice(start, start + LOG_CHUNK_LINES);
      const node = document.createTextNode(`${slice.join('\n')}\n`);
      this.logEl.insertBefore(node, state.openNode);
      state.chunks.push({ node, lines: slice.length });
      state.lines += slice.length;
    }
    if (!state.following) state.unseen += lines.length;
    while (state.lines > LOG_LINE_CAP && state.chunks.length > 1) {
      const oldest = state.chunks.shift();
      if (!oldest) break;
      oldest.node.remove();
      state.lines -= oldest.lines;
      state.trimmed = true;
    }
  }

  private renderLogState(): void {
    const log = this.log;
    if (!log) {
      this.logStateEl.textContent = 'Full log';
      this.logStateEl.classList.remove('lb-termctrl__state--paused');
      return;
    }
    const lines = log.lines + (log.openText ? 1 : 0);
    const parts = ['Full log', `${lines.toLocaleString('en-US')} lines`, formatBytes(log.length || 0)];
    parts.push(log.following ? 'following' : `paused · ${log.unseen.toLocaleString('en-US')} new · G`);
    if (log.truncated || log.trimmed) parts.push('older output dropped');
    if (log.error) parts.push(log.error);
    else if (log.length && !lines) parts.push('no line output · full-screen app? v for Screen');
    this.logStateEl.textContent = parts.join(' · ');
    this.logStateEl.classList.toggle('lb-termctrl__state--paused', !log.following);
  }

  private async refreshLog(force: boolean): Promise<void> {
    const session = this.selectedSession();
    if (this.view !== 'log' || !session || this.logInFlight || document.visibilityState === 'hidden') return;
    if (session.state === 'stale' || session.state === 'incompatible') return;
    if (!this.log || this.log.name !== session.name) this.log = this.newLog(session.name);
    const state = this.log;
    const now = Date.now();
    if (!force && state.length !== null) {
      if (state.final || now < state.nextAt) return;
      // An exited session is read once more for its final output, then kept.
      const newOutput = session.lastOutputAt != null && session.lastOutputAt > state.fetchedAt - 1000;
      if (!newOutput && session.state !== 'exited') return;
    }
    this.logInFlight = true;
    state.fetchedAt = now;
    let received = 0;
    let idleGap = 2000;
    let url = `${this.apiBase}/log/${encodeURIComponent(session.name)}`;
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
      if (this.log !== state) return;
      const truncated = response.headers.get('x-termctrl-log-truncated') === 'true';
      const wasFollowing = state.following;
      if (response.headers.get('x-termctrl-log-mode') !== 'append') {
        state.decoder = createAnsiText({ dropFirstLine: truncated });
        state.chunks = [];
        state.lines = 0;
        state.unseen = 0;
        this.logEl.replaceChildren(state.openNode);
        state.anchor = lastBytes(new Uint8Array(0), body);
      } else {
        state.anchor = lastBytes(state.anchor, body);
      }
      state.length = Number(response.headers.get('x-termctrl-log-length')) || 0;
      state.truncated = truncated;
      state.error = null;
      const decoded = state.decoder.push(body);
      this.appendLogLines(state, decoded.lines);
      state.openText = decoded.open;
      state.openNode.data = decoded.open;
      if (!state.lines && !state.openText) idleGap = 30000;
      if (session.state === 'exited') state.final = true;
      if (wasFollowing) this.followLogEnd();
      else this.renderLogState();
    } catch (error) {
      if (this.log === state) {
        state.error = error instanceof Error && error.message ? error.message : 'session log unavailable';
        this.renderLogState();
      }
    } finally {
      // Each read re-serializes the whole ring in termctrl: keep reads under
      // ~10% of wall time. A ring with no line output (a full-screen app whose
      // start was dropped) is re-read only every 30 s.
      const spent = (received || Date.now()) - now;
      state.nextAt = Date.now() + Math.max(idleGap, 10 * spent);
      this.logInFlight = false;
    }
  }
}
