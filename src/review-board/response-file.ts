// Krypton — `response.md` serialization (spec 211)
//
// One file with two halves: YAML-ish frontmatter is the SOURCE OF TRUTH, and the
// body below it is a generated readable rendering, rewritten on every save. That
// split is what lets a bundle stay `cat`-able and greppable like an analysis
// bundle (spec 191) while still restoring exact state when the Board reopens.
//
// Parsing is deliberately lenient in one direction only: unknown keys are
// ignored and malformed entries are skipped with a count, because a hand-edited
// or half-written file must never block a review. A frontmatter that will not
// parse at all is reported so the caller can back it up rather than overwrite it.

import type { ReviewResponse } from '../acp/types';

/** Marker line that tells a human reading the file where the truth lives. */
const GENERATED_NOTICE =
  '<!-- generated from the frontmatter above; edit answers in the Review Board, not here -->';

/** Longest single field written into the frontmatter. A hostile or runaway quote
 *  must not turn a bundle into a multi-megabyte file. */
const FIELD_CAP = 4000;

export interface ParsedResponseFile {
  response: ReviewResponse;
  /** Entries skipped because they were malformed — surfaced as a banner count. */
  skipped: number;
  /** True when there was no parseable frontmatter at all. The caller backs the
   *  file up to `response.md.bak` and starts fresh rather than silently losing
   *  a hand-edit that might have been meaningful. */
  unparseable: boolean;
}

// ─── Writing ──────────────────────────────────────────────────────────────

/** Quote a scalar for the frontmatter. Everything is written as a JSON string,
 *  so a note containing `:`, a newline, or a `---` line can never break the
 *  block it lives in — the same reasoning as the JSON-payload prompt framing. */
function scalar(value: string): string {
  return JSON.stringify(value);
}

function cap(value: string): string {
  return value.length > FIELD_CAP ? value.slice(0, FIELD_CAP) : value;
}

/** Apply the field cap once, up front, so the frontmatter and the generated body
 *  are rendered from the SAME values. Capping only at the write site would let
 *  the body carry text the frontmatter (the source of truth) does not. */
function capFields(response: ReviewResponse): ReviewResponse {
  return {
    ...response,
    note: response.note === undefined ? undefined : cap(response.note),
    comments: response.comments.map((c) => ({ ...c, quote: cap(c.quote), body: cap(c.body) })),
  };
}

/**
 * Serialize a response to the full `response.md` text: frontmatter first, then
 * the generated body. Stable output for a given response, so an unchanged
 * response never dirties the file's mtime content-wise.
 */
export function serializeResponseFile(
  input: ReviewResponse,
  respondedAt: number,
  blockLabel: (blockId: string) => string,
): string {
  const response = capFields(input);
  const lines: string[] = ['---'];
  lines.push(`review: ${scalar(response.reviewId)}`);
  lines.push(`responded_at: ${scalar(new Date(respondedAt).toISOString())}`);
  if (response.sentAt !== undefined) {
    lines.push(`sent_at: ${scalar(new Date(response.sentAt).toISOString())}`);
  }
  if (response.note && response.note.trim().length > 0) {
    lines.push(`note: ${scalar(response.note.trim())}`);
  }
  if (response.findings.length > 0) {
    lines.push('findings:');
    for (const f of response.findings) {
      lines.push(`  - block: ${scalar(f.blockId)}`);
      lines.push(`    state: ${f.state}`);
    }
  }
  if (response.decisions.length > 0) {
    lines.push('decisions:');
    for (const d of response.decisions) {
      lines.push(`  - block: ${scalar(d.blockId)}`);
      lines.push(`    chosen: ${d.chosen}`);
    }
  }
  if (response.comments.length > 0) {
    lines.push('comments:');
    for (const c of response.comments) {
      lines.push(`  - block: ${scalar(c.blockId)}`);
      lines.push(`    quote: ${scalar(c.quote)}`);
      lines.push(`    body: ${scalar(c.body)}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(GENERATED_NOTICE);
  lines.push('');
  lines.push(renderResponseBody(response, blockLabel));
  return lines.join('\n');
}

/**
 * The human-readable half. Never parsed back — it exists so `cat response.md`
 * answers "what did I decide?" without a tool.
 */
export function renderResponseBody(
  response: ReviewResponse,
  blockLabel: (blockId: string) => string,
): string {
  const out: string[] = ['## Answers'];
  const total = response.findings.length + response.decisions.length + response.comments.length;
  if (total === 0) {
    out.push('');
    out.push(
      response.note && response.note.trim().length > 0
        ? '_No findings or decisions were answered — a note was sent._'
        : '_Nothing answered yet._',
    );
  }
  for (const f of response.findings) {
    out.push(`- **${f.state}** · ${blockLabel(f.blockId)}`);
  }
  for (const d of response.decisions) {
    out.push(`- **decision** · ${blockLabel(d.blockId)} → *${d.chosen}*`);
  }
  for (const c of response.comments) {
    out.push(`- **comment** · ${blockLabel(c.blockId)}`);
    if (c.quote.trim().length > 0) out.push(`  > ${oneLine(c.quote)}`);
    out.push(`  ${oneLine(c.body)}`);
  }
  if (response.note && response.note.trim().length > 0) {
    out.push('');
    out.push('## Note');
    out.push(response.note.trim());
  }
  out.push('');
  out.push(
    response.sentAt !== undefined
      ? `_Sent to the lane at ${new Date(response.sentAt).toISOString()}._`
      : '_Answered but not yet sent._',
  );
  return out.join('\n');
}

/** Collapse a quote/note to a single line so it cannot break the list markup. */
function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

// ─── Reading ──────────────────────────────────────────────────────────────

/** Pull the leading `---` block out of the file. Null when there is none. */
function extractFrontMatter(source: string): string | null {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? match[1] : null;
}

/** Decode one frontmatter scalar. Written as JSON, but a hand-edit may well be
 *  bare — accept both, and treat an unterminated quote as bare text. */
function decodeScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // fall through to the bare reading
    }
  }
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function indentWidth(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++;
  return n;
}

/** Split `key: rest` at the first colon; null when the line has no bare key. */
function splitKey(line: string): { key: string; rest: string } | null {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const key = line.slice(0, colon).trim();
  if (!key || /\s/.test(key)) return null;
  return { key, rest: line.slice(colon + 1) };
}

/** Group the indented lines under a `key:` into one record per `- ` item. */
function readItems(lines: string[], start: number): { items: Record<string, string>[]; next: number } {
  const items: Record<string, string>[] = [];
  let i = start;
  let current: Record<string, string> | null = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    if (indentWidth(line) === 0) break; // a new top-level key ends the list
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      current = {};
      items.push(current);
      const kv = splitKey(trimmed.slice(2).trim());
      if (kv) current[kv.key] = decodeScalar(kv.rest);
    } else if (current) {
      const kv = splitKey(trimmed);
      if (kv) current[kv.key] = decodeScalar(kv.rest);
    }
    i++;
  }
  return { items, next: i };
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Parse a `response.md` back into a `ReviewResponse`. Unknown keys are ignored;
 * an entry missing its `block` (or carrying an out-of-range `chosen`) is skipped
 * and counted rather than guessed at. `reviewId` is passed in because the file's
 * own `review:` key may have been hand-edited to something that no longer
 * matches the bundle it lives in — the directory is the authority.
 */
export function parseResponseFile(source: string, reviewId: string): ParsedResponseFile {
  const empty: ReviewResponse = { reviewId, comments: [], findings: [], decisions: [] };
  const front = extractFrontMatter(source);
  if (front === null) {
    return { response: empty, skipped: 0, unparseable: source.trim().length > 0 };
  }

  const response: ReviewResponse = { reviewId, comments: [], findings: [], decisions: [] };
  let skipped = 0;
  let recognized = 0;
  const lines = front.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0 || indentWidth(line) > 0) {
      i++;
      continue;
    }
    const kv = splitKey(line);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv.key.toLowerCase();
    const inline = kv.rest.trim();

    if (inline.length > 0) {
      // A scalar key. Unknown ones are ignored, forward-compatibly.
      if (key === 'note') {
        response.note = decodeScalar(inline);
        recognized++;
      } else if (key === 'sent_at') {
        response.sentAt = parseTimestamp(decodeScalar(inline));
        recognized++;
      } else if (key === 'review' || key === 'responded_at') {
        recognized++;
      }
      i++;
      continue;
    }

    const { items, next } = readItems(lines, i + 1);
    i = next;
    if (key === 'findings') {
      recognized++;
      for (const item of items) {
        const blockId = item.block;
        const state = item.state;
        if (!blockId || (state !== 'accepted' && state !== 'dismissed')) {
          skipped++;
          continue;
        }
        response.findings.push({ blockId, state });
      }
    } else if (key === 'decisions') {
      recognized++;
      for (const item of items) {
        const blockId = item.block;
        const chosen = Number(item.chosen);
        if (!blockId || !Number.isInteger(chosen) || chosen < 1) {
          skipped++;
          continue;
        }
        response.decisions.push({ blockId, chosen });
      }
    } else if (key === 'comments') {
      recognized++;
      for (const item of items) {
        const blockId = item.block;
        const body = item.body;
        if (!blockId || body === undefined) {
          skipped++;
          continue;
        }
        response.comments.push({ blockId, quote: item.quote ?? '', body });
      }
    }
  }

  // A frontmatter block with nothing we understand is a corrupt file, not an
  // empty response — the caller must not overwrite it without a backup.
  const unparseable = recognized === 0 && front.trim().length > 0;
  return { response, skipped, unparseable };
}

/** Is there anything in this response worth writing or sending? */
export function isResponseEmpty(response: ReviewResponse): boolean {
  return (
    response.findings.length === 0 &&
    response.decisions.length === 0 &&
    response.comments.length === 0 &&
    (response.note ?? '').trim().length === 0
  );
}
