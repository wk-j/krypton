// Krypton — Program Status Protocol (OSC 7501), rev 0.3.
//
// A program reports what it is doing (idle, working, done, blocked, error) via
//   ESC ] 7501 ; key=value(:key=value)* ST
// The terminal keeps one record per `id` and decides how to show them. This
// module is the pure half: `parseProgramStatus` validates one report body
// against every grammar rule and limit, and `ProgramStatusStore` applies the
// spec's record and lifetime rules per view. Presentation lives in the
// compositor / footer. See docs/284-program-status-osc7501.md.

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

export interface ProgramStatusRecord {
  /** '' is the root record. */
  id: string;
  state: ProgramState;
  kind: BlockedKind | null;
  /** 0–100; null = indeterminate (or not applicable to the state). */
  progress: number | null;
  /** As reported. Inheritance is resolved when summarising. */
  app: string | null;
  title: string | null;
  msg: string | null;
  updatedAt: number;
}

export type ProgramStatusReport =
  | { type: 'query' }
  | { type: 'clear'; id: string | null }
  | { type: 'set'; record: Omit<ProgramStatusRecord, 'updatedAt'> };

export interface ProgramStatusSummary {
  /** Highest-priority record in the view. */
  state: ProgramState;
  kind: BlockedKind | null;
  app: string | null;
  title: string | null;
  msg: string | null;
  progress: number | null;
  /** Records in blocked | error | done. */
  attention: number;
}

// ─── Limits (spec § Limits) ──────────────────────────────────────────

/** Whole sequence, OSC through ST. */
const MAX_SEQUENCE_BYTES = 4096;
/** `ESC ] 7501 ;` (7 bytes) + the shortest terminator (BEL, 1 byte). */
const SEQUENCE_OVERHEAD_BYTES = 8;
const MAX_KEY_BYTES = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_APP_BYTES = 32;
const MAX_ID_BYTES = 128;
const MAX_ID_DEPTH = 8;
/** Records per view. The spec's floor; LRU eviction past it. */
export const MAX_RECORDS_PER_VIEW = 64;

const KEY_RE = /^[a-z]+$/;
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const PROGRESS_RE = /^[0-9]{1,3}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const STATES: Record<string, true> = { idle: true, working: true, done: true, blocked: true, error: true, clear: true };
const KINDS: Record<string, true> = { permission: true, question: true, auth: true };

/** Feature-detection reply body; the caller wraps it as `ESC ] 7501 ; ? ESC \`. */
export const PROGRAM_STATUS_QUERY_REPLY = '\x1b]7501;?\x1b\\';

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function isValidId(id: string): boolean {
  if (id.length > MAX_ID_BYTES) return false;
  const segments = id.split('/');
  if (segments.length > MAX_ID_DEPTH) return false;
  return segments.every((s) => SEGMENT_RE.test(s));
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Decode standard base64 (padding optional) to UTF-8, enforcing the decoded
 *  byte cap. Returns null when the value does not decode, is too long, or
 *  contains a control character — each of which discards the whole report. */
function decodeText(value: string, maxDecoded: number): string | null {
  if (!BASE64_RE.test(value)) return null;
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  if (binary.length > maxDecoded) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
  return CONTROL_RE.test(text) ? null : text;
}

/**
 * Parse one OSC 7501 body (the bytes after `7501;`). Returns null when the
 * report must be ignored or discarded: a limit is broken, base64 fails to
 * decode, decoded text has a control character, `state` is missing/unknown,
 * or `id` is malformed. Malformed pairs are skipped and unknown keys ignored.
 */
export function parseProgramStatus(body: string): ProgramStatusReport | null {
  if (utf8Length(body) + SEQUENCE_OVERHEAD_BYTES > MAX_SEQUENCE_BYTES) return null;
  if (body.trim() === '?') return { type: 'query' };

  const pairs = new Map<string, string>();
  for (const raw of body.split(':')) {
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (key.length === 0) continue;
    if (utf8Length(key) > MAX_KEY_BYTES) return null;
    if (!KEY_RE.test(key) || !VALUE_RE.test(value)) continue;
    pairs.set(key, value); // last one wins
  }

  // Every limit is checked before anything is decoded or stored.
  const msgRaw = pairs.get('msg');
  const titleRaw = pairs.get('title');
  const appRaw = pairs.get('app');
  const idRaw = pairs.get('id');
  if (msgRaw !== undefined && msgRaw.length > MAX_MSG_ENCODED) return null;
  if (titleRaw !== undefined && titleRaw.length > MAX_TITLE_ENCODED) return null;
  if (appRaw !== undefined && appRaw.length > MAX_APP_BYTES) return null;
  if (idRaw !== undefined && idRaw.length > MAX_ID_BYTES) return null;

  const state = pairs.get('state');
  if (state === undefined || STATES[state] !== true) return null;

  let id: string | null = null;
  if (idRaw !== undefined) {
    if (!isValidId(idRaw)) return null;
    id = idRaw;
  }

  const msg = msgRaw !== undefined ? decodeText(msgRaw, MAX_MSG_DECODED) : null;
  if (msgRaw !== undefined && msg === null) return null;
  const title = titleRaw !== undefined ? decodeText(titleRaw, MAX_TITLE_DECODED) : null;
  if (titleRaw !== undefined && title === null) return null;

  if (state === 'clear') return { type: 'clear', id };

  const programState = state as ProgramState;
  const kindRaw = pairs.get('kind');
  const kind = programState === 'blocked' && kindRaw !== undefined && KINDS[kindRaw] === true
    ? (kindRaw as BlockedKind)
    : null;

  let progress: number | null = null;
  const progressRaw = pairs.get('progress');
  if ((programState === 'working' || programState === 'blocked')
    && progressRaw !== undefined && PROGRESS_RE.test(progressRaw)) {
    const n = Number(progressRaw);
    if (n <= 100) progress = n;
  }

  const app = appRaw !== undefined && APP_RE.test(appRaw) ? appRaw : null;

  return {
    type: 'set',
    record: { id: id ?? '', state: programState, kind, progress, app, title, msg },
  };
}

// ─── Store ───────────────────────────────────────────────────────────

const STATE_PRIORITY: Record<ProgramState, number> = {
  idle: 0,
  working: 1,
  done: 2,
  error: 3,
  blocked: 4,
};

const ATTENTION_STATES: Record<ProgramState, boolean> = { idle: false, working: false, done: true, error: true, blocked: true };
const TRANSIENT_STATES: Record<ProgramState, boolean> = { idle: true, working: true, done: false, error: false, blocked: true };
const RESULT_STATES: Record<ProgramState, boolean> = { idle: false, working: false, done: true, error: true, blocked: false };

export function isAttentionState(state: ProgramState | null | undefined): boolean {
  return state !== null && state !== undefined && ATTENTION_STATES[state];
}

/** Higher wins. Exposed so chrome can aggregate summaries the same way. */
export function programStatePriority(state: ProgramState): number {
  return STATE_PRIORITY[state];
}

function sameSummary(a: ProgramStatusSummary | null, b: ProgramStatusSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.kind === b.kind && a.app === b.app && a.title === b.title
    && a.msg === b.msg && a.progress === b.progress && a.attention === b.attention;
}

export type ProgramStatusChangeHandler = (
  viewId: string,
  prev: ProgramStatusSummary | null,
  next: ProgramStatusSummary | null,
) => void;

export class ProgramStatusStore {
  /** Per view: records keyed by id, in least- → most-recently-updated order. */
  private views = new Map<string, Map<string, ProgramStatusRecord>>();
  private summaries = new Map<string, ProgramStatusSummary>();

  constructor(
    private readonly onChange: ProgramStatusChangeHandler,
    private readonly now: () => number = () => Date.now(),
  ) {}

  apply(viewId: string, report: ProgramStatusReport): void {
    if (report.type === 'query') return;
    if (report.type === 'clear') {
      const records = this.views.get(viewId);
      if (!records) return;
      if (report.id === null) {
        records.clear();
      } else {
        const prefix = `${report.id}/`;
        for (const id of [...records.keys()]) {
          if (id === report.id || id.startsWith(prefix)) records.delete(id);
        }
      }
      this.recompute(viewId);
      return;
    }

    let records = this.views.get(viewId);
    if (!records) {
      records = new Map();
      this.views.set(viewId, records);
    }
    const { id } = report.record;
    records.delete(id); // re-insert at the tail: Map order is the LRU order
    records.set(id, { ...report.record, updatedAt: this.now() });
    if (records.size > MAX_RECORDS_PER_VIEW) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
    this.recompute(viewId);
  }

  /** New shell prompt or the reporting program left the foreground: drop
   *  working | blocked (MUST) and idle (MAY). done | error survive. */
  dropTransient(viewId: string): void {
    this.dropWhere(viewId, (r) => TRANSIENT_STATES[r.state]);
  }

  /** The user typed into the view: stop showing results they have now seen. */
  acknowledge(viewId: string): void {
    this.dropWhere(viewId, (r) => RESULT_STATES[r.state]);
  }

  /** RIS — full reset removes every record. */
  reset(viewId: string): void {
    this.dropWhere(viewId, () => true);
  }

  /** The view is gone. */
  dispose(viewId: string): void {
    const had = this.views.delete(viewId);
    if (had) this.recompute(viewId);
  }

  summary(viewId: string): ProgramStatusSummary | null {
    return this.summaries.get(viewId) ?? null;
  }

  /**
   * Next view that needs the user, after `afterViewId`: blocked, then error,
   * then done; within a state the longest-waiting first. Wraps around.
   */
  nextAttention(afterViewId: string | null): string | null {
    const ranked: Array<{ viewId: string; priority: number; since: number }> = [];
    for (const [viewId, records] of this.views) {
      const top = this.topRecord(records);
      if (!top || !ATTENTION_STATES[top.state]) continue;
      ranked.push({ viewId, priority: STATE_PRIORITY[top.state], since: top.updatedAt });
    }
    if (ranked.length === 0) return null;
    ranked.sort((a, b) => b.priority - a.priority || a.since - b.since);
    const at = afterViewId === null ? -1 : ranked.findIndex((r) => r.viewId === afterViewId);
    return ranked[(at + 1) % ranked.length].viewId;
  }

  private dropWhere(viewId: string, pred: (r: ProgramStatusRecord) => boolean): void {
    const records = this.views.get(viewId);
    if (!records) return;
    for (const [id, record] of [...records]) {
      if (pred(record)) records.delete(id);
    }
    this.recompute(viewId);
  }

  private topRecord(records: Map<string, ProgramStatusRecord>): ProgramStatusRecord | null {
    let top: ProgramStatusRecord | null = null;
    for (const record of records.values()) {
      if (top === null
        || STATE_PRIORITY[record.state] > STATE_PRIORITY[top.state]
        || (STATE_PRIORITY[record.state] === STATE_PRIORITY[top.state] && record.updatedAt >= top.updatedAt)) {
        top = record;
      }
    }
    return top;
  }

  /** `app` of the record, else of its nearest ancestor (root last). */
  private resolveApp(records: Map<string, ProgramStatusRecord>, record: ProgramStatusRecord): string | null {
    if (record.app) return record.app;
    let id = record.id;
    while (id !== '') {
      const slash = id.lastIndexOf('/');
      id = slash < 0 ? '' : id.slice(0, slash);
      const ancestor = records.get(id);
      if (ancestor?.app) return ancestor.app;
    }
    return null;
  }

  private recompute(viewId: string): void {
    const records = this.views.get(viewId);
    let next: ProgramStatusSummary | null = null;
    if (records && records.size > 0) {
      const top = this.topRecord(records);
      if (top) {
        let attention = 0;
        for (const r of records.values()) if (ATTENTION_STATES[r.state]) attention++;
        next = {
          state: top.state,
          kind: top.kind,
          app: this.resolveApp(records, top),
          title: top.title,
          msg: top.msg,
          progress: top.progress,
          attention,
        };
      }
    } else if (records) {
      this.views.delete(viewId);
    }
    const prev = this.summaries.get(viewId) ?? null;
    if (sameSummary(prev, next)) return;
    if (next) this.summaries.set(viewId, next);
    else this.summaries.delete(viewId);
    this.onChange(viewId, prev, next);
  }
}

// ─── Presentation helpers ────────────────────────────────────────────

/** Bidi overrides/isolates and invisible marks a program could use to spoof
 *  text shown outside the terminal grid (spec § Security: SHOULD disarm). */
const INVISIBLE_RE = /[\u200b-\u200f\u061c\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function sanitizeStatusText(text: string): string {
  return text.replace(INVISIBLE_RE, '');
}

/** Short chip label: `40%` / `···` / `PERMISSION` / `DONE` / `ERROR`, with
 *  the app prefixed. Null for idle (nothing to show). */
export function programStatusLabel(summary: ProgramStatusSummary): string | null {
  let core: string;
  switch (summary.state) {
    case 'idle':
      return null;
    case 'working':
      core = summary.progress !== null ? `${summary.progress}%` : '···';
      break;
    case 'blocked':
      core = summary.kind ? summary.kind.toUpperCase() : 'BLOCKED';
      if (summary.progress !== null) core += ` ${summary.progress}%`;
      break;
    case 'done':
      core = 'DONE';
      break;
    case 'error':
      core = 'ERROR';
      break;
  }
  return summary.app ? `${summary.app.toUpperCase()} · ${core}` : core;
}

/** One human line for rail / footer: the message, else the title, else a
 *  phrase derived from the state. */
export function programStatusSentence(summary: ProgramStatusSummary): string {
  const text = summary.msg ?? summary.title;
  if (text) return sanitizeStatusText(text);
  switch (summary.state) {
    case 'blocked':
      return summary.kind === 'permission' ? 'needs permission'
        : summary.kind === 'question' ? 'has a question'
          : summary.kind === 'auth' ? 'needs credentials'
            : 'is waiting on you';
    case 'error':
      return 'failed';
    case 'done':
      return 'finished';
    case 'working':
      return 'working';
    case 'idle':
      return 'idle';
  }
}
