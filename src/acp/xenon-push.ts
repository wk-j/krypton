// Krypton — `#push` argument parsing and report formatting (spec 212).
//
// Kept free of Tauri and DOM so the command grammar and the summary line are
// testable without a running harness.

export const XENON_KINDS = ['artifact', 'review', 'analysis', 'doc', 'attention'] as const;

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
