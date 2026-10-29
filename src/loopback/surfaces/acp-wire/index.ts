// Spec 288 / 341 — the ACP wire profiler. `/acp-wire/{token}` is the live
// dashboard; `/acp-wire/{token}/message/{seq}` is the same document in
// full-page message mode ([ / ] walk seqs through history.pushState).

import { Component, DisposableBag } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';
import { reconcile } from '../../../ui/list';
import {
  Banner,
  button,
  card,
  copyText,
  DataTable,
  dot,
  fetchJson,
  HttpError,
  kbdHints,
  keymap,
  keyValue,
  pill,
  poll,
  SearchFilter,
  setPressed,
  StatBar,
} from '../../kit';
import type { Poller, Tone } from '../../kit';
import { digest, jsonTree } from './json-tree';
import type { Json } from './json-tree';
import type { EventsPage, FilterState, Group, MethodRow, Row, Selection, WireEvent, WireSummary } from './model';
import { DIRS, fmtBytes, fmtTime, fmtUs, isGroup, LIMIT, MAX_ROWS, MSG_RE, parsePath, WireStore } from './model';
import { createWaterfallSvg, paintWaterfall } from './waterfall';

import './acp-wire.css';

export interface AcpWireHost {
  setTitle(title: string): void;
}

type PayloadState = { text: string | null } | { evicted: true } | { loading: true } | { error: string };
type View = 'tree' | 'raw';

const POLL_MS = 1000;
const DIR_CLASS: Record<string, string> = {
  to_agent: 'lb-acp-wire__acc',
  from_agent: 'lb-acp-wire__grn',
  to_ui: 'lb-muted',
};

function dirNode(dir: string): HTMLElement {
  const label = DIRS.find((d) => d.k === dir)?.label ?? dir;
  return el('span', { class: DIR_CLASS[dir], text: label });
}

function methodNode(m: string | null | undefined): ElChild[] {
  const s = m ?? '';
  const i = s.indexOf('·');
  return i < 0 ? [s] : [s.slice(0, i), el('span', { class: 'lb-muted', text: ` · ${s.slice(i + 1)}` })];
}

function setPill(node: HTMLElement, label: string, tone: Tone): void {
  node.className = `lb-pill lb-pill--${tone}`;
  node.textContent = label;
}

interface RowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly open: boolean;
}

class WireRow extends Component<RowProps> {
  constructor(props: RowProps) {
    super(el('tr'));
    this.update(props);
  }

  protected readDeps(next: RowProps): readonly unknown[] {
    const r = next.row;
    if (r.kind === 'gap') return ['gap'];
    if (r.kind === 'group') {
      return ['grp', r.grp.seq, r.grp.members.length, r.grp.bytes, r.grp.last.monoUs, next.open, next.selected];
    }
    const e = r.ev;
    return ['ev', e.seq, e.latencyUs, e.error, e.pairSeq, e.bytes, e.truncated, r.child, next.selected];
  }

  protected paint(next: RowProps): void {
    const r = next.row;
    this.syncClasses(next);
    if (r.kind === 'gap') {
      setChildren(this.el, [el('td', { attrs: { colspan: 8 }, text: '— gap: older events evicted or skipped —' })]);
      return;
    }
    if (r.kind === 'group') {
      const g = r.grp;
      const f = g.first;
      this.el.dataset.key = `g${g.seq}`;
      setChildren(this.el, [
        el('td', { class: 'lb-muted', text: fmtTime(f.tsMs) }),
        el('td', { text: f.lane }),
        el('td', {}, dirNode(f.dir)),
        el(
          'td',
          {},
          el('span', { class: 'lb-muted', text: `${next.open ? '▾ ' : '▸ '}${f.kind}` }),
          ' ',
          el('span', { class: 'lb-acp-wire__acc', text: `×${g.members.length}` }),
        ),
        el('td', { class: 'lb-acp-wire__fill', title: f.method ?? '' }, ...methodNode(f.method)),
        el('td'),
        el('td', { class: 'lb-table__num', text: fmtBytes(g.bytes) }),
        el('td', { class: 'lb-table__num lb-muted', title: 'span first → last', text: fmtUs(g.last.monoUs - f.monoUs) }),
      ]);
      return;
    }
    const e = r.ev;
    this.el.dataset.key = `e${e.seq}`;
    const lat: ElChild =
      e.latencyUs != null ? fmtUs(e.latencyUs) : e.kind === 'request' ? el('span', { class: 'lb-muted', text: '…' }) : '';
    setChildren(this.el, [
      el('td', { class: 'lb-muted', text: fmtTime(e.tsMs) }),
      el('td', { text: e.lane }),
      el('td', {}, dirNode(e.dir)),
      el('td', { class: e.kind === 'invalid' ? 'lb-acp-wire__red' : 'lb-muted', text: e.kind }),
      el('td', { class: 'lb-acp-wire__fill', title: e.method ?? '' }, ...methodNode(e.method)),
      el('td', { class: 'lb-table__num lb-muted', text: e.id == null ? '' : String(e.id) }),
      el(
        'td',
        { class: 'lb-table__num' },
        fmtBytes(e.bytes),
        e.truncated ? el('span', { class: 'lb-muted', text: ' trunc' }) : null,
      ),
      el('td', { class: ['lb-table__num', e.error && 'lb-acp-wire__red'] }, lat),
    ]);
  }

  protected syncClasses(next: RowProps): void {
    const r = next.row;
    this.el.className = [
      'lb-acp-wire__row',
      r.kind === 'gap' && 'lb-acp-wire__row--gap',
      r.kind === 'group' && 'lb-acp-wire__row--group',
      r.kind === 'event' && r.child && 'lb-acp-wire__row--child',
      next.selected && 'lb-acp-wire__row--selected',
    ]
      .filter(Boolean)
      .join(' ');
  }
}

export interface AcpWireOptions {
  readonly pathname?: string;
}

export class AcpWireView {
  readonly el: HTMLElement;
  private readonly bag = new DisposableBag();
  private readonly base: string;
  private readonly store = new WireStore();
  private readonly payloads = new Map<number, PayloadState>();
  private readonly banner = new Banner();
  private summary: WireSummary | null = null;
  private since = 0;
  private view: View = 'tree';
  private readonly mode: 'dash' | 'msg';

  // dashboard state
  private readonly filter: FilterState = {
    lane: 'all',
    dirs: { to_agent: true, from_agent: true, to_ui: false },
    q: '',
    grouped: true,
    open: new Set<number>(),
  };
  private sel: Selection | null = null;
  private paused = false;
  private poller: Poller | null = null;
  private rows: Row[] = [];
  private groups = new Map<number, Group>();
  private groupOf = new Map<number, number>();
  private detailKey: string | null = null;
  private detailSeq: number | null = null;
  private detailView: View | null = null;
  private laneSig = '';

  // message state
  private msg: { seq: number; ev: WireEvent | null; err: string | null } = { seq: 0, ev: null, err: null };

  constructor(
    private readonly host: AcpWireHost,
    options: AcpWireOptions = {},
  ) {
    const path = parsePath(options.pathname ?? location.pathname);
    this.base = path.base;
    this.mode = path.seq === null ? 'dash' : 'msg';
    if (path.seq === null) {
      this.el = this.buildDash();
      this.bindDashKeys();
      this.render();
      this.schedule();
    } else {
      this.el = this.buildMsg();
      this.bindMsgKeys();
      this.bag.listen(window, 'popstate', () => {
        const m = MSG_RE.exec(location.pathname);
        if (m) this.loadMessage(Number(m[2]), false);
      });
      // Summary only names the capture mode for the "payload not captured" notice.
      fetchJson<WireSummary>(`${this.base}/summary`).then(
        (s) => {
          this.summary = s;
          if (this.msg.ev) this.renderMessage();
        },
        () => {},
      );
      this.loadMessage(path.seq, false);
    }
  }

  msgUrl(seq: number): string {
    return `${this.base}/message/${seq}`;
  }

  dispose(): void {
    this.poller?.dispose();
    this.poller = null;
    this.searchFilter?.dispose();
    this.banner.dispose();
    this.bag.dispose();
  }

  // ---------------------------------------------------------------- dashboard

  private searchFilter: SearchFilter | null = null;
  private readonly liveDot = el('span');
  private readonly livePill = pill('live', 'add');
  private readonly modePill = pill('capture: …', 'muted');
  private readonly connPill = pill('disconnected', 'del');
  private readonly bufLine = el('span', { class: 'lb-acp-wire__note', text: 'connecting…' });
  private readonly stats = new StatBar();
  private readonly laneBar = el('span', { class: 'lb-acp-wire__chips' });
  private readonly dirButtons = DIRS.map((d, i) =>
    button(`${i + 1} ${d.label}`, {
      variant: 'toggle',
      onClick: () => {
        this.filter.dirs[d.k] = !this.filter.dirs[d.k];
        this.render();
      },
    }),
  );
  private readonly wf = createWaterfallSvg();
  private readonly tbody = el('tbody');
  private readonly table = el(
    'table',
    { class: 'lb-table lb-acp-wire__table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: 'time' }),
        el('th', { text: 'lane' }),
        el('th', { text: 'dir' }),
        el('th', { text: 'kind' }),
        el('th', { class: 'lb-acp-wire__fill', text: 'method' }),
        el('th', { class: 'lb-table__num', text: 'id' }),
        el('th', { class: 'lb-table__num', text: 'bytes' }),
        el('th', { class: 'lb-table__num', text: 'latency' }),
      ),
    ),
    this.tbody,
  );
  private readonly empty = el('div', { class: 'lb-acp-wire__empty', text: 'no events captured yet' });
  private readonly tableWrap = el('div', { class: 'lb-acp-wire__scroll' }, this.table, this.empty);
  private readonly msgCount = el('span', { class: 'lb-acp-wire__acc' });
  private readonly detail = el('div', { class: 'lb-acp-wire__detail' });
  private readonly openLink = el(
    'a',
    { class: 'lb-acp-wire__open', attrs: { target: '_blank', rel: 'noopener', hidden: true } },
    'open full page ↗ ',
    el('kbd', { text: 'o' }),
  );
  private readonly methods = new DataTable<MethodRow>({
    key: (m) => m.method,
    columns: [
      { id: 'method', label: 'method', render: (m) => m.method },
      { id: 'count', label: 'count', numeric: true, render: (m) => String(m.count) },
      { id: 'bytes', label: 'bytes', numeric: true, render: (m) => fmtBytes(m.bytes) },
      {
        id: 'share',
        label: 'share',
        render: (m) =>
          el(
            'div',
            { class: 'lb-acp-wire__mbar' },
            el('i', { style: { width: `${((m.bytes / this.methodTotal) * 100).toFixed(1)}%` } }),
          ),
      },
      { id: 'p50', label: 'p50', numeric: true, render: (m) => fmtUs(m.p50Us) },
      { id: 'p95', label: 'p95', numeric: true, render: (m) => fmtUs(m.p95Us) },
      { id: 'max', label: 'max', numeric: true, render: (m) => fmtUs(m.maxUs) },
      {
        id: 'errors',
        label: 'errors',
        numeric: true,
        render: (m) => el('span', { class: m.errors ? 'lb-acp-wire__red' : 'lb-muted', text: String(m.errors) }),
      },
    ],
    deps: (m) => [m.count, m.bytes, m.p50Us, m.p95Us, m.maxUs, m.errors, this.methodTotal],
  });
  private methodTotal = 1;
  private readonly methodsEmpty = el('p', { class: 'lb-acp-wire__note', text: 'no methods yet' });

  private buildDash(): HTMLElement {
    this.searchFilter = new SearchFilter({
      placeholder: 'filter method, id, lane…',
      escape: 'clear-and-leave',
      onInput: (q) => {
        this.filter.q = q;
        this.render();
      },
      onSubmit: () => this.searchFilter?.input.blur(),
    });
    this.bag.listen(this.tbody, 'click', (event) => {
      const tr = (event.target as Element).closest<HTMLElement>('tr[data-key]');
      if (!tr?.dataset.key) return;
      const seq = Number(tr.dataset.key.slice(1));
      if (tr.dataset.key.startsWith('g')) {
        const g = this.groups.get(seq);
        if (g) {
          this.sel = g;
          this.toggleGroup(seq);
        }
      } else this.select(this.store.bySeq.get(seq));
    });
    this.bag.listen(this.wf, 'click', (event) => {
      const r = (event.target as Element).closest('rect[data-seq]');
      if (r) this.select(this.store.bySeq.get(Number(r.getAttribute('data-seq'))));
    });
    const legend = el(
      'div',
      { class: 'lb-acp-wire__legend' },
      ...(
        [
          ['var(--accent)', 'Krypton → agent request (span = latency)'],
          ['var(--muted)', 'agent → Krypton request (fs / permission)'],
          ['var(--del)', 'error response'],
          ['var(--fg)', 'notification'],
        ] as const
      ).map(([color, text], i) =>
        el(
          'span',
          {},
          el('i', { class: ['lb-acp-wire__sw', i === 3 && 'lb-acp-wire__sw--tick'], style: { background: color } }),
          text,
        ),
      ),
    );
    this.setLive();
    this.connPill.hidden = true;
    return el(
      'div',
      { class: 'lb-page lb-page--split lb-acp-wire' },
      el(
        'div',
        { class: 'lb-acp-wire__bar' },
        this.liveDot,
        this.livePill,
        this.modePill,
        this.connPill,
        this.bufLine,
        el('span', { class: 'lb-acp-wire__spacer' }),
        this.searchFilter.el,
      ),
      this.banner.el,
      el('div', { class: 'lb-acp-wire__stats' }, this.stats.el),
      el(
        'div',
        { class: 'lb-acp-wire__bar' },
        el('span', { class: 'lb-acp-wire__note', text: 'lane' }),
        this.laneBar,
        el('span', { class: 'lb-acp-wire__note', text: 'dir' }),
        el('span', { class: 'lb-acp-wire__chips' }, ...this.dirButtons),
      ),
      card({ title: 'Waterfall — request spans & notifications (last 60s)' }, this.wf, legend),
      el(
        'div',
        { class: 'lb-acp-wire__split' },
        card({ title: 'Messages', aside: this.msgCount }, this.tableWrap),
        card({ title: 'Detail', aside: this.openLink }, this.detail),
      ),
      card({ title: 'By method' }, this.methods.el, this.methodsEmpty),
      kbdHints(
        [
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
        ],
        'polling 1s · /acp-wire · spec 288',
      ),
    );
  }

  private bindDashKeys(): void {
    const when = (): boolean => this.mode === 'dash';
    const pick = (d: 1 | -1): void => {
      const rs = this.rows.filter((r) => r.kind !== 'gap');
      const sk = this.selKey();
      const i = rs.findIndex((r) => this.rowKey(r) === sk);
      const r = i < 0 ? rs[rs.length - 1] : rs[Math.max(0, Math.min(rs.length - 1, i + d))];
      if (r?.kind === 'group') this.select(r.grp);
      else if (r?.kind === 'event') this.select(r.ev);
    };
    this.bag.add(
      keymap().bindAll([
        { key: 'j', label: 'Next message', when, run: () => pick(1) },
        { key: 'k', label: 'Previous message', when, run: () => pick(-1) },
        {
          key: 'Enter',
          label: 'Jump to pair / expand group',
          when,
          run: () => {
            const s = this.sel;
            if (s && isGroup(s)) this.toggleGroup(s.seq);
            else if (s && s.pairSeq != null) this.select(this.store.bySeq.get(s.pairSeq));
          },
        },
        {
          key: 'g',
          label: 'Group runs on/off',
          when,
          run: () => {
            this.filter.grouped = !this.filter.grouped;
            if (this.sel && isGroup(this.sel)) this.sel = this.store.bySeq.get(this.sel.seq) ?? null;
            this.render();
            this.revealSel();
          },
        },
        {
          key: 'Escape',
          label: 'Clear selection and filter',
          when,
          run: () => {
            this.sel = null;
            if (this.searchFilter) this.searchFilter.input.value = '';
            this.filter.q = '';
            this.render();
            this.autoScroll();
          },
        },
        { key: ' ', label: 'Pause / resume', when, run: () => this.setPaused(!this.paused) },
        {
          key: ['1', '2', '3'],
          display: '1 / 2 / 3',
          label: 'Toggle direction',
          when,
          run: (event) => {
            const d = DIRS[Number(event.key) - 1].k;
            this.filter.dirs[d] = !this.filter.dirs[d];
            this.render();
          },
        },
        {
          key: 'l',
          label: 'Cycle lane',
          when,
          run: () => {
            const all = ['all', ...this.knownLanes().map((l) => l.lane)];
            this.filter.lane = all[(all.indexOf(this.filter.lane) + 1) % all.length];
            this.render();
          },
        },
        {
          key: 'e',
          label: 'Export JSONL',
          when,
          run: () => {
            location.href = `${this.base}/export.jsonl`;
          },
        },
        {
          key: 'o',
          label: 'Open message in full page',
          when,
          run: () => {
            if (this.sel && !isGroup(this.sel)) window.open(this.msgUrl(this.sel.seq), '_blank', 'noopener');
          },
        },
        { key: 'v', label: 'Readable / raw JSON', when, run: () => this.toggleView() },
      ]),
    );
  }

  private knownLanes(): { lane: string; backend: string; remote?: boolean }[] {
    const seen = new Set<string>();
    return (this.summary?.lanes ?? []).filter((l) => !seen.has(l.lane) && seen.add(l.lane));
  }

  private setLive(): void {
    this.liveDot.className = dot(this.paused ? 'idle' : 'live').className;
    setPill(this.livePill, this.paused ? 'paused' : 'live', this.paused ? 'accent' : 'add');
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    this.setLive();
    this.schedule();
  }

  private schedule(): void {
    this.poller?.dispose();
    this.poller = null;
    if (this.paused) return;
    this.poller = poll<[WireSummary, EventsPage]>({
      intervalMs: POLL_MS,
      load: (signal) =>
        Promise.all([
          fetchJson<WireSummary>(`${this.base}/summary`, { signal }),
          fetchJson<EventsPage>(`${this.base}/events?since=${this.since}&limit=${LIMIT}`, { signal }),
        ]),
      apply: ([summary, page]) => this.ingest(summary, page),
      onStatus: (status) => {
        if (status !== 'loading') this.connPill.hidden = status === 'ok';
      },
    });
  }

  /** One poll's worth of data. Public for tests. */
  ingest(summary: WireSummary, page: EventsPage): void {
    this.summary = summary;
    for (const seq of this.store.ingest(page.events ?? [], !!page.gap)) {
      this.payloads.delete(seq);
      this.filter.open.delete(seq);
    }
    if (this.sel && !isGroup(this.sel) && !this.store.bySeq.has(this.sel.seq)) this.sel = null;
    if (typeof page.nextSeq === 'number') this.since = page.nextSeq;
    this.render();
    this.autoScroll();
  }

  private autoScroll(): void {
    if (!this.sel) this.tableWrap.scrollTop = this.tableWrap.scrollHeight;
  }

  private render(): void {
    this.renderHeader();
    this.renderChips();
    this.renderStats();
    paintWaterfall(this.wf, this.store.events, this.summary, this.filter.lane, this.sel);
    this.renderTable();
    this.renderDetail();
    this.renderMethods();
  }

  private renderHeader(): void {
    const s = this.summary;
    const mode = s ? s.mode : null;
    setPill(
      this.modePill,
      `capture: ${mode ?? '…'}`,
      mode === 'full' ? 'del' : mode === 'meta' ? 'accent' : 'muted',
    );
    if (mode === 'off') {
      if (this.banner.el.hidden) {
        this.banner.show('Capture is off — enable from the Krypton palette: “ACP Wire: Capture Meta”.', 'info');
      }
    } else this.banner.hide();
    if (s) {
      this.bufLine.textContent =
        `ring ${s.events} events · evicted ${s.evicted} · payload ` +
        `${(s.payloadBytes / 1048576).toFixed(1)}/${(s.payloadCapBytes / 1048576).toFixed(0)} MB`;
    }
  }

  private renderChips(): void {
    const lanes = [{ lane: 'all', backend: '', remote: false }, ...this.knownLanes()];
    const sig = lanes.map((l) => `${l.lane}|${l.backend}|${l.remote ? 1 : 0}`).join('\n');
    if (sig !== this.laneSig) {
      this.laneSig = sig;
      setChildren(
        this.laneBar,
        lanes.map((l) => {
          const b = button(l.lane === 'all' ? 'all lanes' : `${l.lane} · ${l.backend}${l.remote ? ' · remote' : ''}`, {
            variant: 'toggle',
            onClick: () => {
              this.filter.lane = l.lane;
              this.render();
            },
          });
          b.dataset.lane = l.lane;
          return b;
        }),
      );
    }
    for (const b of this.laneBar.querySelectorAll<HTMLButtonElement>('button[data-lane]')) {
      setPressed(b, b.dataset.lane === this.filter.lane);
    }
    DIRS.forEach((d, i) => setPressed(this.dirButtons[i], this.filter.dirs[d.k]));
  }

  private renderStats(): void {
    const s = this.summary;
    const dirs = s?.dirs ?? {};
    const r = this.store.rates(s);
    const b = (k: keyof typeof dirs): string => {
      const d = dirs[k];
      return d ? fmtBytes(d.bytes) : '—';
    };
    const inFlight = s ? s.inFlight : 0;
    const evicted = s ? s.evicted : 0;
    this.stats.update([
      { key: 'rate', label: 'msg/s (5s)', value: r.perSec.toFixed(1) },
      { key: 'to_agent', label: '→ agent', value: b('to_agent') },
      { key: 'from_agent', label: '← agent', value: b('from_agent') },
      { key: 'to_ui', label: '⇢ ui (IPC)', value: b('to_ui') },
      {
        key: 'rpc',
        label: 'RPC p50 / p95',
        value: r.p50 != null ? `${fmtUs(r.p50)} / ${fmtUs(r.p95)}` : '—',
      },
      { key: 'inflight', label: 'in-flight', value: String(inFlight), tone: inFlight ? 'add' : undefined },
      { key: 'evicted', label: 'evicted', value: String(evicted), tone: evicted ? undefined : 'add' },
    ]);
  }

  private rowKey(r: Row): string {
    if (r.kind === 'gap') return `x${r.seq}`;
    return r.kind === 'group' ? `g${r.grp.seq}` : `e${r.ev.seq}`;
  }

  private selKey(): string {
    if (!this.sel) return '';
    return `${isGroup(this.sel) ? 'g' : 'e'}${this.sel.seq}`;
  }

  private renderTable(): void {
    const built = this.store.buildRows(this.filter);
    this.rows = built.rows;
    this.groups = built.groups;
    this.groupOf = built.groupOf;
    const rows = built.rows.slice(-MAX_ROWS);
    this.msgCount.textContent =
      `· ${built.real}` + (built.rows.length > rows.length ? ` (showing last ${rows.length} rows)` : '');
    this.empty.hidden = built.real > 0;
    this.table.hidden = built.real === 0;
    // While a row is selected the table stops following the tail; keep the top
    // visible row pinned so the 400-row window sliding never moves the view.
    const wrapTop = this.tableWrap.getBoundingClientRect().top;
    let anchor: HTMLElement | null = null;
    let anchorOff = 0;
    if (this.sel) {
      for (const tr of Array.from(this.tbody.children) as HTMLElement[]) {
        const rr = tr.getBoundingClientRect();
        if (tr.dataset.key && rr.bottom > wrapTop) {
          anchor = tr;
          anchorOff = rr.top - wrapTop;
          break;
        }
      }
    }
    const sk = this.selKey();
    reconcile(this.tbody, rows, {
      key: (r) => this.rowKey(r),
      create: (r) => new WireRow({ row: r, selected: this.rowKey(r) === sk, open: this.isOpen(r) }),
      update: (c, r) => c.update({ row: r, selected: this.rowKey(r) === sk, open: this.isOpen(r) }),
    });
    if (anchor?.isConnected) {
      this.tableWrap.scrollTop += anchor.getBoundingClientRect().top - wrapTop - anchorOff;
    }
  }

  private isOpen(r: Row): boolean {
    return r.kind === 'group' && this.filter.open.has(r.grp.seq);
  }

  private select(e: Selection | undefined): void {
    if (!e) return;
    this.sel = e;
    if (!isGroup(e)) {
      this.filter.dirs[e.dir] = true;
      if (this.filter.lane !== 'all' && this.filter.lane !== e.lane) this.filter.lane = 'all';
    }
    this.render();
    this.revealSel();
    this.tbody.querySelector(`tr[data-key="${this.selKey()}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }

  private revealSel(): void {
    if (!this.sel || isGroup(this.sel)) return;
    const g = this.groupOf.get(this.sel.seq);
    if (g != null && !this.filter.open.has(g)) {
      this.filter.open.add(g);
      this.render();
    }
  }

  private toggleGroup(seq: number): void {
    if (!this.filter.open.delete(seq)) this.filter.open.add(seq);
    this.render();
  }

  private toggleView(): void {
    this.view = this.view === 'tree' ? 'raw' : 'tree';
    if (this.mode === 'msg') this.renderMessage();
    else this.renderDetail();
  }

  private setView(v: View): void {
    if (this.view !== v) this.toggleView();
  }

  /** Polls repaint every second; rebuild the pane only when what it shows changed. */
  private renderDetail(): void {
    const e = this.sel;
    const d = this.detail;
    const on = !!e && !isGroup(e);
    this.openLink.hidden = !on;
    if (e && !isGroup(e)) this.openLink.href = this.msgUrl(e.seq);
    if (!e) {
      if (this.detailKey !== '') {
        this.detailKey = '';
        this.detailSeq = null;
        setChildren(d, [el('p', { class: 'lb-acp-wire__note', text: 'Select a row (j/k).' })]);
      }
      return;
    }
    if (isGroup(e)) {
      this.renderGroupDetail(e);
      return;
    }
    if (e.hasPayload && !this.payloads.has(e.seq)) this.fetchPayload(e.seq);
    const pair = e.pairSeq != null ? this.store.bySeq.get(e.pairSeq) : undefined;
    const c = this.payloads.get(e.seq);
    const pk = e.hasPayload
      ? c && 'loading' in c
        ? 'L'
        : c && 'evicted' in c
          ? 'E'
          : c && 'error' in c
            ? 'X'
            : 'T'
      : (this.summary?.mode ?? '');
    const key = [e.seq, e.latencyUs, e.error, e.pairSeq, pair ? 1 : 0, this.view, pk].join('|');
    if (key === this.detailKey) return;
    const same = this.detailSeq === e.seq;
    const oldBox = d.querySelector<HTMLElement>('.lb-acp-wire__payload');
    const keepBox = same && this.detailView === this.view && oldBox ? oldBox.scrollTop : 0;
    const keepPane = same ? d.scrollTop : 0;
    this.detailKey = key;
    this.detailSeq = e.seq;
    this.detailView = this.view;
    let pairDd: ElChild = null;
    if (e.pairSeq != null) {
      if (pair) {
        const a = el('a', { attrs: { href: '#' }, text: `${pair.kind} seq ${pair.seq} ↵` });
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          this.select(pair);
        });
        pairDd = a;
      } else pairDd = el('span', { class: 'lb-muted', text: `seq ${e.pairSeq} (not held)` });
    }
    setChildren(d, [this.metaList(e, pairDd), ...this.payloadNodes(e, c, true)]);
    const newBox = d.querySelector<HTMLElement>('.lb-acp-wire__payload');
    if (newBox && keepBox) newBox.scrollTop = keepBox;
    if (keepPane) d.scrollTop = keepPane;
  }

  private renderGroupDetail(sel: Group): void {
    const g = this.groups.get(sel.seq);
    if (!g) {
      this.sel = null;
      this.renderDetail();
      return;
    }
    const n = g.members.length;
    const f = g.first;
    const open = this.filter.open.has(g.seq);
    const key = ['g', g.seq, n, g.bytes, open].join('|');
    if (key === this.detailKey) return;
    this.detailKey = key;
    this.detailSeq = null;
    this.detailView = null;
    setChildren(this.detail, [
      keyValue([
        ['group', el('span', {}, el('span', { class: 'lb-acp-wire__acc', text: String(n) }), ` consecutive ${f.kind}s`)],
        ['method', el('span', { class: 'lb-acp-wire__acc', text: f.method || '—' })],
        ['lane', this.laneNode(f)],
        ['dir', f.dir],
        ['time', `${fmtTime(f.tsMs)} → ${fmtTime(g.last.tsMs)}`],
        ['span', fmtUs(g.last.monoUs - f.monoUs)],
        [
          'bytes',
          el('span', {}, fmtBytes(g.bytes), el('span', { class: 'lb-muted', text: ` · avg ${fmtBytes(Math.round(g.bytes / n))}` })),
        ],
        ['seq', `${f.seq} – ${g.last.seq}`],
      ]),
      el('p', {
        class: 'lb-acp-wire__note',
        text: `enter / click: ${open ? 'collapse' : 'expand'} · g: turn grouping off`,
      }),
    ]);
  }

  private renderMethods(): void {
    const ms = this.summary?.methods ?? [];
    this.methodTotal = ms.reduce((s, m) => s + m.bytes, 0) || 1;
    this.methods.setRows(ms);
    this.methods.el.hidden = !ms.length;
    this.methodsEmpty.hidden = ms.length > 0;
  }

  private fetchPayload(seq: number): void {
    this.payloads.set(seq, { loading: true });
    fetchJson<WireEvent>(`${this.base}/event/${seq}`)
      .then(
        (d) => this.payloads.set(seq, { text: d.payload == null ? null : String(d.payload) }),
        (err: unknown) =>
          this.payloads.set(
            seq,
            err instanceof HttpError && err.status === 404
              ? { evicted: true }
              : { error: `failed to load payload: ${err instanceof Error ? err.message : String(err)}` },
          ),
      )
      .then(() => {
        if (this.sel && !isGroup(this.sel) && this.sel.seq === seq) this.renderDetail();
      });
  }

  // ------------------------------------------------------------ shared detail

  private laneNode(e: WireEvent): HTMLElement {
    return el(
      'span',
      {},
      e.lane,
      el('span', {
        class: 'lb-muted',
        text: ` · ${e.backend}${e.remote ? ' · remote' : ''} · session ${e.session ?? ''}`,
      }),
    );
  }

  /** Metadata list shared by the detail pane and the message page. */
  private metaList(e: WireEvent, pairDd: ElChild): HTMLElement {
    const entries: [string, ElChild][] = [
      ['seq', String(e.seq)],
      ['time', fmtTime(e.tsMs)],
      ['lane', this.laneNode(e)],
      ['dir', e.dir],
      ['kind', e.kind],
      ['method', el('span', { class: 'lb-acp-wire__acc', text: e.method || '—' })],
    ];
    if (e.id != null) entries.push(['id', String(e.id)]);
    entries.push([
      'bytes',
      el('span', {}, fmtBytes(e.bytes), e.truncated ? el('span', { class: 'lb-muted', text: ' (truncated)' }) : null),
    ]);
    if (e.latencyUs != null) {
      entries.push([
        'latency',
        el('span', { class: e.error ? 'lb-acp-wire__red' : undefined, text: fmtUs(e.latencyUs) + (e.error ? ' · error' : '') }),
      ]);
    } else if (e.kind === 'request') {
      entries.push(['latency', el('span', { class: 'lb-muted', text: 'in flight' })]);
    }
    if (e.pairSeq != null) entries.push(['paired', pairDd]);
    return keyValue(entries);
  }

  private payloadNodes(e: WireEvent, c: PayloadState | undefined, clipLong: boolean): HTMLElement[] {
    const pre = (text: string, cls?: string): HTMLElement =>
      el('pre', { class: ['lb-acp-wire__payload', 'lb-acp-wire__payload--pre', cls], text });
    if (!e.hasPayload) {
      const mode = this.summary ? this.summary.mode : 'meta';
      return [
        pre(
          `payload not captured — capture mode ${String(mode).toUpperCase()}\n(switch via Krypton palette: ACP Wire: Capture Full)`,
          'lb-muted',
        ),
      ];
    }
    if (!c || 'loading' in c) return [pre('loading payload…', 'lb-muted')];
    if ('evicted' in c) return [pre('evicted — payload no longer in the server ring buffer', 'lb-muted')];
    if ('error' in c) return [pre(c.error, 'lb-acp-wire__red')];
    if (c.text == null) return [pre('payload not captured', 'lb-muted')];
    const note = e.truncated ? el('p', { class: 'lb-acp-wire__note', text: 'payload truncated by capture cap' }) : null;
    let parsed: Json;
    try {
      parsed = JSON.parse(c.text) as Json;
    } catch {
      return [note, pre(c.text)].filter((x): x is HTMLElement => !!x);
    }
    const tabs = el(
      'div',
      { class: 'lb-acp-wire__vtabs' },
      button('readable', { variant: 'toggle', pressed: this.view === 'tree', onClick: () => this.setView('tree') }),
      button('raw JSON', { variant: 'toggle', pressed: this.view === 'raw', onClick: () => this.setView('raw') }),
      el('kbd', { text: 'v' }),
    );
    const body: (HTMLElement | null)[] =
      this.view === 'raw'
        ? [note, tabs, pre(JSON.stringify(parsed, null, 2))]
        : [note, tabs, digest(parsed), jsonTree(parsed, clipLong)];
    return body.filter((x): x is HTMLElement => !!x);
  }

  // -------------------------------------------------------------- message page

  private readonly mSeq = pill('seq …', 'muted');
  private readonly mMeta = el('div');
  private readonly mBody = el('div');

  private buildMsg(): HTMLElement {
    return el(
      'div',
      { class: 'lb-page lb-acp-wire lb-acp-wire--msg' },
      el(
        'div',
        { class: 'lb-acp-wire__bar' },
        el('a', { class: 'lb-btn lb-btn--ghost', attrs: { href: this.base }, text: '← profiler' }),
        this.mSeq,
        el('span', { class: 'lb-acp-wire__spacer' }),
        button('[ prev seq', { onClick: () => this.loadMessage(this.msg.seq - 1, true) }),
        button('next seq ]', { onClick: () => this.loadMessage(this.msg.seq + 1, true) }),
        button('copy JSON', { kbd: 'y', onClick: () => void this.copyMessage() }),
      ),
      this.banner.el,
      card({ title: 'Message' }, this.mMeta),
      card({ title: 'Payload' }, this.mBody),
      kbdHints(
        [
          ['[ ]', 'previous / next seq'],
          ['Enter', 'jump to pair'],
          ['j k', 'scroll'],
          ['v', 'readable / raw JSON'],
          ['y', 'copy JSON'],
          ['Esc', 'back to profiler'],
        ],
        '/acp-wire · spec 288',
      ),
    );
  }

  private bindMsgKeys(): void {
    const when = (): boolean => this.mode === 'msg';
    this.bag.add(
      keymap().bindAll([
        { key: '[', label: 'Previous seq', when, run: () => this.loadMessage(this.msg.seq - 1, true) },
        { key: ']', label: 'Next seq', when, run: () => this.loadMessage(this.msg.seq + 1, true) },
        {
          key: 'Enter',
          label: 'Jump to pair',
          when,
          run: () => {
            if (this.msg.ev?.pairSeq != null) this.loadMessage(this.msg.ev.pairSeq, true);
          },
        },
        { key: 'j', label: 'Scroll down', when, run: () => window.scrollBy(0, 60) },
        { key: 'k', label: 'Scroll up', when, run: () => window.scrollBy(0, -60) },
        { key: 'v', label: 'Readable / raw JSON', when, run: () => this.toggleView() },
        { key: 'y', label: 'Copy JSON', when, run: () => void this.copyMessage() },
        {
          key: 'Escape',
          label: 'Back to profiler',
          when,
          run: () => {
            location.href = this.base;
          },
        },
      ]),
    );
  }

  /** The current message seq (message mode). */
  get messageSeq(): number {
    return this.msg.seq;
  }

  private loadMessage(seq: number, push: boolean): void {
    if (seq < 0) return;
    this.msg = { seq, ev: null, err: null };
    if (push) history.pushState(null, '', this.msgUrl(seq));
    this.renderMessage();
    window.scrollTo?.(0, 0);
    fetchJson<WireEvent>(`${this.base}/event/${seq}`)
      .then(
        (d) => {
          if (this.msg.seq !== seq) return;
          this.msg.ev = d;
          this.payloads.clear();
          this.payloads.set(seq, { text: d.payload == null ? null : String(d.payload) });
        },
        (err: unknown) => {
          if (this.msg.seq !== seq) return;
          this.msg.err =
            err instanceof HttpError && err.status === 404
              ? `seq ${seq} is not in the ring — evicted, cleared, or not captured yet`
              : `failed to load message: ${err instanceof Error ? err.message : String(err)}`;
        },
      )
      .then(() => {
        if (this.msg.seq === seq) this.renderMessage();
      });
  }

  private renderMessage(): void {
    const e = this.msg.ev;
    setPill(this.mSeq, `seq ${this.msg.seq}`, 'muted');
    if (!e) {
      this.host.setTitle(`seq ${this.msg.seq} — ACP Wire`);
      setChildren(this.mMeta, [
        el('p', { class: this.msg.err ? 'lb-acp-wire__red' : 'lb-acp-wire__note', text: this.msg.err ?? 'loading…' }),
      ]);
      setChildren(this.mBody, []);
      return;
    }
    this.host.setTitle(`${e.method || e.kind} · seq ${e.seq} — ACP Wire`);
    let pairDd: ElChild = null;
    if (e.pairSeq != null) {
      const target = e.pairSeq;
      const a = el('a', { attrs: { href: this.msgUrl(target) }, text: `seq ${target} ↵` });
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        this.loadMessage(target, true);
      });
      pairDd = a;
    }
    setChildren(this.mMeta, [this.metaList(e, pairDd)]);
    setChildren(this.mBody, this.payloadNodes(e, this.payloads.get(e.seq), false));
  }

  private async copyMessage(): Promise<void> {
    const e = this.msg.ev;
    if (!e) return;
    let text: string;
    if (e.payload != null) {
      try {
        text = JSON.stringify(JSON.parse(e.payload), null, 2);
      } catch {
        text = String(e.payload);
      }
    } else text = JSON.stringify(e, null, 2);
    const ok = await copyText(text);
    if (ok) {
      this.banner.show(e.payload != null ? 'payload copied' : 'metadata copied (no payload captured)', 'ok', 1600);
    } else this.banner.show('copy failed', 'error', 1600);
  }
}
