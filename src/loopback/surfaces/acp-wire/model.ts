// Spec 288 / 341 — the ACP wire profiler's client-side model: the held event
// ring, filtering, run grouping and the derived stats. No DOM here.

export type WireDir = 'to_agent' | 'from_agent' | 'to_ui';

export interface WireEvent {
  seq: number;
  tsMs: number;
  monoUs: number;
  lane: string;
  backend: string;
  remote?: boolean;
  session?: string | null;
  dir: WireDir;
  kind: string;
  method?: string | null;
  id?: string | number | null;
  bytes: number;
  truncated?: boolean;
  hasPayload?: boolean;
  latencyUs?: number | null;
  error?: boolean | null;
  pairSeq?: number | null;
  /** Only on `/event/{seq}`. */
  payload?: string | null;
}

export interface GapMarker {
  readonly gap: true;
  readonly seq: number;
}

export type Held = WireEvent | GapMarker;

export interface WireSummary {
  mode: string;
  events: number;
  evicted: number;
  payloadBytes: number;
  payloadCapBytes: number;
  nowMs: number;
  nowMonoUs: number;
  inFlight: number;
  dirs?: Partial<Record<WireDir, { bytes: number; count?: number }>>;
  lanes?: { lane: string; backend: string; remote?: boolean }[];
  methods?: MethodRow[];
}

export interface MethodRow {
  method: string;
  count: number;
  bytes: number;
  p50Us: number | null;
  p95Us: number | null;
  maxUs: number | null;
  errors: number;
}

export interface EventsPage {
  events?: WireEvent[];
  gap?: boolean;
  nextSeq?: number;
}

export interface Group {
  readonly group: true;
  readonly seq: number;
  readonly members: WireEvent[];
  readonly first: WireEvent;
  readonly last: WireEvent;
  readonly bytes: number;
}

export type Row =
  | { readonly kind: 'gap'; readonly seq: number }
  | { readonly kind: 'event'; readonly ev: WireEvent; readonly child: boolean }
  | { readonly kind: 'group'; readonly grp: Group };

export type Selection = WireEvent | Group;

export const DIRS: readonly { readonly k: WireDir; readonly label: string }[] = [
  { k: 'to_agent', label: '→ agent' },
  { k: 'from_agent', label: '← agent' },
  { k: 'to_ui', label: '⇢ ui' },
];

export const MAX_HELD = 20000;
export const MAX_ROWS = 400;
export const LIMIT = 2000;
export const WINDOW_US = 60e6;

export function isGap(h: Held): h is GapMarker {
  return 'gap' in h;
}

export function isGroup(s: Selection): s is Group {
  return 'group' in s;
}

export function fmtUs(n: number | null | undefined): string {
  if (n == null) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} s`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)} ms`;
  return `${n} µs`;
}

export function fmtBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number, w = 2): string => String(x).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export interface FilterState {
  lane: string;
  dirs: Record<WireDir, boolean>;
  q: string;
  grouped: boolean;
  open: Set<number>;
}

/** Held events in seq order plus the seq index; responses patch their request. */
export class WireStore {
  readonly events: Held[] = [];
  readonly bySeq = new Map<number, WireEvent>();

  /** Returns the seqs dropped from the head of the ring. */
  ingest(list: readonly WireEvent[], gap: boolean): number[] {
    if (gap && list.length) this.events.push({ gap: true, seq: list[0].seq - 0.5 });
    for (const e of list) {
      if (this.bySeq.has(e.seq)) continue;
      this.events.push(e);
      this.bySeq.set(e.seq, e);
      // A response carries pairSeq = request seq; the held request is never re-sent, so patch it.
      if (e.kind === 'response' && e.pairSeq != null) {
        const req = this.bySeq.get(e.pairSeq);
        if (req) {
          req.latencyUs = e.latencyUs;
          req.error = e.error;
          req.pairSeq = e.seq;
        }
      }
    }
    const dropped: number[] = [];
    if (this.events.length > MAX_HELD) {
      for (const d of this.events.splice(0, this.events.length - MAX_HELD)) {
        if (isGap(d)) continue;
        this.bySeq.delete(d.seq);
        dropped.push(d.seq);
      }
    }
    return dropped;
  }

  visible(f: FilterState): Held[] {
    const q = f.q.toLowerCase();
    return this.events.filter((e) => {
      if (isGap(e)) return !q;
      if (f.lane !== 'all' && e.lane !== f.lane) return false;
      if (!f.dirs[e.dir]) return false;
      if (q && `${e.method ?? ''} ${e.lane} ${e.id ?? ''} ${e.kind} ${e.backend}`.toLowerCase().indexOf(q) < 0) {
        return false;
      }
      return true;
    });
  }

  /**
   * Consecutive notifications/events with the same lane, direction and method
   * collapse into one group row, keyed by the first member's seq — stable while
   * a live run keeps growing at the tail.
   */
  buildRows(f: FilterState): { rows: Row[]; real: number; groups: Map<number, Group>; groupOf: Map<number, number> } {
    const rows: Row[] = [];
    const groups = new Map<number, Group>();
    const groupOf = new Map<number, number>();
    let run: { k: string; members: WireEvent[] } | null = null;
    let real = 0;
    const flush = (): void => {
      if (!run) return;
      const m = run.members;
      run = null;
      if (m.length === 1) {
        rows.push({ kind: 'event', ev: m[0], child: false });
        return;
      }
      let bytes = 0;
      for (const e of m) {
        bytes += e.bytes;
        groupOf.set(e.seq, m[0].seq);
      }
      const g: Group = { group: true, seq: m[0].seq, members: m, first: m[0], last: m[m.length - 1], bytes };
      groups.set(g.seq, g);
      rows.push({ kind: 'group', grp: g });
      if (f.open.has(g.seq)) for (const e of m) rows.push({ kind: 'event', ev: e, child: true });
    };
    for (const e of this.visible(f)) {
      if (isGap(e)) {
        flush();
        rows.push({ kind: 'gap', seq: e.seq });
        continue;
      }
      real++;
      const k =
        f.grouped && (e.kind === 'notification' || e.kind === 'event')
          ? `${e.lane}\u0001${e.dir}\u0001${e.kind}\u0001${e.method ?? ''}`
          : null;
      if (k && run && run.k === k) {
        run.members.push(e);
        continue;
      }
      flush();
      if (k) run = { k, members: [e] };
      else rows.push({ kind: 'event', ev: e, child: false });
    }
    flush();
    return { rows, real, groups, groupOf };
  }

  /** msg/s over 5 s and client-side RPC p50/p95 (see spec 288). */
  rates(summary: WireSummary | null): { perSec: number; p50: number | null; p95: number | null } {
    let lastTs = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (!isGap(e)) {
        lastTs = e.tsMs;
        break;
      }
    }
    const ref = Math.max(lastTs, summary?.nowMs ?? 0);
    let n5 = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (isGap(e)) continue;
      if (e.tsMs <= ref - 5000) break;
      if (e.dir !== 'to_ui') n5++;
    }
    // session/prompt is long-running and request_permission is human-bound:
    // both would swamp the RPC percentiles.
    const lats: number[] = [];
    for (const e of this.events) {
      if (
        !isGap(e) &&
        e.kind === 'response' &&
        e.latencyUs != null &&
        e.method !== 'session/prompt' &&
        e.method !== 'session/request_permission'
      ) {
        lats.push(e.latencyUs);
      }
    }
    return { perSec: n5 / 5, p50: percentile(lats, 0.5), p95: percentile(lats, 0.95) };
  }
}

/** `/acp-wire/{token}` → profiler; `/acp-wire/{token}/message/{seq}` → message page. */
export const MSG_RE = /^(.*)\/message\/(\d+)\/?$/;

export function parsePath(pathname: string): { base: string; seq: number | null } {
  const m = MSG_RE.exec(pathname);
  if (m) return { base: m[1], seq: Number(m[2]) };
  return { base: pathname.replace(/\/+$/, ''), seq: null };
}
