// Krypton — `#push` argument parsing and report formatting (spec 212), and the
// `#resume` grammar plus local ∪ Xenon handoff merge/select (spec 293).
//
// Kept free of Tauri and DOM so the command grammar and the summary line are
// testable without a running harness.

import type { HandoffEntry } from './types';

// Mirrors `xenon::KINDS` (Rust). Both lists validate, so both must be extended
// together — the frontend rejects an unknown kind before the command is ever
// invoked. `daily` is spec 224, `handoff` is spec 293.
export const XENON_KINDS = [
  'artifact',
  'review',
  'analysis',
  'doc',
  'attention',
  'daily',
  'timeline',
  'handoff',
] as const;

export type XenonKind = (typeof XENON_KINDS)[number];

export interface PushArgs {
  kind: XenonKind | null;
  slug: string | null;
  force: boolean;
}

export type PushParseResult =
  | { ok: true; args: PushArgs }
  | { ok: false; error: string };

/**
 * `#push [--force] [<kind> [<slug>]]`
 *
 * Bare `#push` covers the kinds in `[xenon].auto_push` (all of them when that is
 * empty) — the backend resolves that, not this parser, because the config is
 * only available there.
 */
export function parsePushCommand(input: string): PushParseResult {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== '#push') {
    return { ok: false, error: 'not a #push command' };
  }

  const rest = parts.slice(1);
  const force = rest.some((p) => p === '--force' || p === '-f');
  const positional = rest.filter((p) => p !== '--force' && p !== '-f');

  if (positional.length > 2) {
    return { ok: false, error: 'usage: #push [--force] [<kind> [<slug>]]' };
  }
  if (positional.length === 0) {
    return { ok: true, args: { kind: null, slug: null, force } };
  }

  const kind = positional[0];
  if (!(XENON_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `unknown kind "${kind}" - expected ${XENON_KINDS.join(', ')}` };
  }
  return {
    ok: true,
    args: { kind: kind as XenonKind, slug: positional[1] ?? null, force },
  };
}

export interface PushItem {
  kind: string;
  slug: string;
  title: string;
  state: 'pushed' | 'unchanged' | 'blocked' | 'failed';
  url?: string;
  uploaded?: number;
  reason?: string;
  retryable?: boolean;
}

export interface PushReport {
  pushed: number;
  unchanged: number;
  blocked: number;
  failed: number;
  queued: number;
  items: PushItem[];
  baseUrl: string;
  project: string;
}

export interface XenonStatus {
  enabled: boolean;
  configured: boolean;
  baseUrl: string;
  project: string;
  /** 'configured' | 'missing' | 'unavailable' | 'unconfigured' */
  token: string;
  queued: number;
  autoPush: string[];
}

export function xenonProjectUrl(status: XenonStatus, timelineTopic?: string): string {
  const project = encodeURIComponent(status.project);
  if (timelineTopic === undefined) return `${status.baseUrl}/p/${project}`;
  const topic = timelineTopic.trim();
  const query = topic ? `?topic=${encodeURIComponent(topic)}` : '';
  return `${status.baseUrl}/p/${project}/timeline${query}`;
}

/**
 * spec 213: what a completed push proves about the link, for the workspace
 * footer's backend-link segment. A real interaction is stronger evidence than a
 * probe and costs no extra request.
 *
 * Returns `null` when the push proves nothing — an empty push never touched the
 * network, and a `blocked` item was stopped by the local secret scan before any
 * request was made. Reporting those as "linked" would paint a dead server green.
 */
export function linkEvidenceFromPush(
  report: PushReport,
): { baseUrl: string; project: string; reachedServer: boolean; unauthorized: boolean; detail: string | null } | null {
  const reached = report.items.find((i) => i.state === 'pushed' || i.state === 'unchanged');
  const failed = report.items.filter((i) => i.state === 'failed');
  if (!reached && failed.length === 0) return null;

  const base = { baseUrl: report.baseUrl, project: report.project };
  if (reached) {
    return { ...base, reachedServer: true, unauthorized: false, detail: null };
  }
  // The backend marks an auth failure as non-retryable precisely because it
  // needs a human, not a retry — which is exactly the segment's warning state.
  const authFailure = failed.find((i) => i.retryable === false && /token|unauthor|forbidden/i.test(i.reason ?? ''));
  return {
    ...base,
    reachedServer: false,
    unauthorized: authFailure !== undefined,
    detail: (authFailure ?? failed[0]).reason ?? null,
  };
}

/** One-line chip summary. Reports nothing found as such rather than "0 pushed". */
export function summarizePush(report: PushReport): string {
  if (report.items.length === 0) {
    return 'nothing to push';
  }
  const bits: string[] = [];
  if (report.pushed) bits.push(`${report.pushed} pushed`);
  if (report.unchanged) bits.push(`${report.unchanged} unchanged`);
  if (report.blocked) bits.push(`${report.blocked} blocked`);
  if (report.failed) bits.push(`${report.failed} failed`);
  if (report.queued) bits.push(`${report.queued} queued`);
  return `${report.project}: ${bits.join(' · ')}`;
}

/**
 * Multi-line transcript detail. Blocked and failed items are always named —
 * a silent secret block would be worse than no scan at all — while successes
 * collapse to a count plus one permalink to follow.
 */
export function describePush(report: PushReport): string {
  if (report.items.length === 0) {
    return `Nothing to push for ${report.project}.`;
  }

  const lines: string[] = [summarizePush(report)];

  for (const item of report.items) {
    if (item.state === 'blocked') {
      lines.push(`  blocked  ${item.kind}/${item.slug} - ${item.reason ?? 'secret scan'}`);
    } else if (item.state === 'failed') {
      const tail = item.retryable ? ' (queued for retry)' : '';
      lines.push(`  failed   ${item.kind}/${item.slug} - ${item.reason ?? 'unknown'}${tail}`);
    }
  }

  const firstPushed = report.items.find((i) => i.state === 'pushed');
  if (firstPushed?.url) {
    lines.push(`  ${firstPushed.url}`);
  } else if (report.pushed === 0 && report.unchanged > 0) {
    lines.push(`  everything already up to date at ${report.baseUrl}`);
  }

  return lines.join('\n');
}

// ─── spec 293: global handoff resume ─────────────────────────────────────────

/** A handoff as listed (`detail` null) or fetched (`detail` set) from Xenon. */
export interface RemoteHandoff {
  id: string;
  author: string;
  host: string;
  summary: string;
  detail: string | null;
  /** From revision meta, not server timestamps. */
  createdAt: number;
  updatedAt: number;
  seq: number;
  url: string;
}

/** `xenon_handoff_list` result. `available: false` → resume uses local only;
 *  a non-null `reason` is worth one system line, a null one (Xenon off) is not. */
export interface XenonHandoffList {
  available: boolean;
  reason: string | null;
  handoffs: RemoteHandoff[];
}

export type HandoffSource = 'local' | 'xenon';

/** The winning copy of one handoff id after merging local and Xenon. */
export interface MergedHandoff {
  id: string;
  author: string;
  host: string;
  summary: string;
  /** Null when the winner is a Xenon list row — fetch it before resuming. */
  detail: string | null;
  createdAt: number;
  updatedAt: number;
  source: HandoffSource;
}

export type ResumeRequest =
  | { mode: 'newest' }
  | { mode: 'list' }
  | { mode: 'id'; reference: string };

export type ResumeParseResult =
  | { ok: true; request: ResumeRequest }
  | { ok: false; error: string };

const RESUME_USAGE = 'usage: #resume [list | <id>]';

/** `#resume` (newest), `#resume list`, `#resume <id-or-prefix>`. */
export function parseResumeCommand(input: string): ResumeParseResult {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== '#resume') {
    return { ok: false, error: 'not a #resume command' };
  }
  const rest = parts.slice(1);
  if (rest.length === 0) return { ok: true, request: { mode: 'newest' } };
  if (rest.length > 1) return { ok: false, error: RESUME_USAGE };
  if (rest[0] === 'list') return { ok: true, request: { mode: 'list' } };
  return { ok: true, request: { mode: 'id', reference: rest[0].toLowerCase() } };
}

/**
 * Union of the local store and the Xenon list, one row per id. The newer
 * `updatedAt` wins; on a tie the local copy wins because it already carries
 * its detail. Newest first.
 */
export function mergeHandoffs(local: HandoffEntry[], remote: RemoteHandoff[]): MergedHandoff[] {
  const byId = new Map<string, MergedHandoff>();
  for (const entry of local) {
    const prior = byId.get(entry.id);
    if (prior && prior.updatedAt >= entry.updatedAt) continue;
    byId.set(entry.id, {
      id: entry.id,
      author: entry.author,
      host: entry.host,
      summary: entry.summary,
      detail: entry.detail,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      source: 'local',
    });
  }
  for (const entry of remote) {
    const prior = byId.get(entry.id);
    if (prior && prior.updatedAt >= entry.updatedAt) continue;
    byId.set(entry.id, {
      id: entry.id,
      author: entry.author,
      host: entry.host,
      summary: entry.summary,
      detail: entry.detail,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      source: 'xenon',
    });
  }
  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export type HandoffMatch<T> =
  | { ok: true; handoff: T }
  | { ok: false; reason: 'too_short' | 'none' | 'ambiguous'; error: string };

/** Shortest prefix (after `ho-`) accepted as a handoff reference. */
const MIN_HANDOFF_PREFIX = 4;

/**
 * Resolve `#resume <reference>`: an exact id, or a unique prefix of the id
 * with or without its `ho-` — the same rules `xenon_handoff_fetch` applies, so
 * a miss here can be retried there against the full Xenon list.
 */
export function matchHandoffReference<T extends { id: string }>(
  list: readonly T[],
  reference: string,
): HandoffMatch<T> {
  const exact = list.find((entry) => entry.id === reference);
  if (exact) return { ok: true, handoff: exact };
  const bare = reference.startsWith('ho-') ? reference.slice(3) : reference;
  if (bare.length < MIN_HANDOFF_PREFIX) {
    return {
      ok: false,
      reason: 'too_short',
      error: `handoff reference "${reference}" is too short - use at least ${MIN_HANDOFF_PREFIX} characters after ho-`,
    };
  }
  const candidates = list.filter(
    (entry) => entry.id.startsWith(reference) || entry.id.startsWith(`ho-${reference}`),
  );
  if (candidates.length === 1) return { ok: true, handoff: candidates[0] };
  if (candidates.length === 0) {
    return { ok: false, reason: 'none', error: `no handoff matches "${reference}"` };
  }
  return {
    ok: false,
    reason: 'ambiguous',
    error: `"${reference}" matches ${candidates.length} handoffs - use a longer id`,
  };
}

/** Coarse age for handoff rows, which may be months old: `<1m`, `5m`, `3h`, `12d`. */
export function formatHandoffAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Rows shown by `#resume list`. */
export const HANDOFF_LIST_LIMIT = 10;
const HANDOFF_LIST_SUMMARY_CHARS = 80;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The `#resume list` system block: `id · age · host · author · summary · source`. */
export function formatHandoffList(merged: readonly MergedHandoff[], now: number): string {
  if (merged.length === 0) return 'no handoffs in this project';
  const shown = merged.slice(0, HANDOFF_LIST_LIMIT);
  const head = merged.length > shown.length
    ? `handoffs (${shown.length} of ${merged.length}, newest first) - #resume <id> to pick one`
    : `handoffs (${shown.length}, newest first) - #resume <id> to pick one`;
  const rows = shown.map((entry) =>
    [
      entry.id,
      formatHandoffAge(now - entry.updatedAt),
      entry.host,
      entry.author,
      oneLine(entry.summary, HANDOFF_LIST_SUMMARY_CHARS) || '(no summary)',
      entry.source,
    ].join(' · '),
  );
  return [head, ...rows.map((row) => `  ${row}`)].join('\n');
}
