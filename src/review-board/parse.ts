// Krypton — Review Board document parser (spec 211)
//
// Pure Markdown → ReviewBlock[]. One block per top-level `marked` token, with
// fenced code blocks whose info string names a review type upgraded to a typed
// block. Nothing here touches the DOM, so the whole block layer is testable
// without a webview.
//
// Two invariants the rest of the Board leans on:
//   1. Parsing NEVER throws and never drops a block. A malformed or unknown
//      typed fence degrades to `markdown` carrying a `diagnostic` chip — half a
//      review beats none, and the raw source is always still readable.
//   2. Block ids are stable across lane iterations, so the human's comments and
//      triage re-attach after the lane rewrites part of the file.

import { Lexer } from 'marked';

import type {
  ReviewBlock,
  ReviewBlockKind,
  ReviewBlockMeta,
  ReviewBlockSeverity,
  ReviewChartBlock,
  ReviewDecisionBlock,
  ReviewDocument,
  ReviewFindingBlock,
  ReviewMetricsBlock,
  ReviewWalkthroughBlock,
  ReviewWalkthroughStep,
} from '../acp/types';

/** Fence info-string prefix that marks a typed block. */
const REVIEW_FENCE_PREFIX = 'review:';

/** Kinds addressed by a `review:<kind>` fence. `diff` uses the bare ```diff
 *  fence instead (so the lane's normal diff output is picked up as-is), and
 *  `markdown` is the fallback, never named explicitly. */
const TYPED_FENCE_KINDS: ReadonlySet<string> = new Set([
  'walkthrough',
  'finding',
  'decision',
  'chart',
  'metrics',
  'svg',
]);

const SEVERITIES: ReadonlySet<string> = new Set(['blocking', 'non-blocking', 'suggestion']);
const CHART_KINDS: ReadonlySet<string> = new Set(['bar', 'line', 'sparkline']);

/** Cap on decision options, so `1`…`9` can address every one of them. */
export const DECISION_OPTION_CAP = 9;

/** FNV-1a, 32-bit, as 8 lowercase hex chars. Content-addressed block ids need a
 *  cheap non-cryptographic hash — collisions only cost a re-attach, never
 *  correctness, and the ordinal prefix disambiguates within one document. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Math.imul keeps the multiply in 32-bit space (a plain * overflows to f64).
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** `b<ordinal>-<hash>`: the ordinal keeps ids unique when a lane repeats a block
 *  verbatim, the hash is what survives edits elsewhere in the file. */
function blockId(ordinal: number, raw: string): string {
  return `b${ordinal}-${fnv1a(raw.trim())}`;
}

/** The content-addressed half of a block id, used for re-attach when a lane
 *  inserts a block above (which shifts every following ordinal). */
export function blockIdHash(id: string): string {
  const dash = id.indexOf('-');
  return dash === -1 ? id : id.slice(dash + 1);
}

/**
 * Re-attach an answer recorded against `recordedId` to a block in the current
 * document. Exact id first; failing that, a UNIQUE hash match — a block whose
 * text is unchanged but whose position moved. An ambiguous hash (the lane
 * duplicated the block) is left unattached rather than guessed at.
 */
export function reattachBlockId(recordedId: string, blocks: readonly ReviewBlock[]): string | null {
  if (blocks.some((b) => b.id === recordedId)) return recordedId;
  const hash = blockIdHash(recordedId);
  const matches = blocks.filter((b) => blockIdHash(b.id) === hash);
  return matches.length === 1 ? matches[0].id : null;
}

// ─── YAML-ish block bodies ────────────────────────────────────────────────
// Block bodies are the shape agents emit most reliably: flat `key: value`, plus
// `key:` followed by an indented list of scalars, an indented list of maps, or
// an indented map. Deliberately NOT a YAML parser — anything richer is a
// diagnostic, not a silent misparse.

type ScalarValue = string;
type ListValue = string[];
type MapListValue = Record<string, string>[];
type MapValue = Record<string, string>;
type BlockValue = ScalarValue | ListValue | MapListValue | MapValue;

/** Strip one layer of matching quotes an agent may have added around a scalar. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Split `key: value` at the FIRST colon; `null` when the line has no key. */
function splitKey(line: string): { key: string; rest: string } | null {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const key = line.slice(0, colon).trim();
  if (!key || /\s/.test(key)) return null;
  return { key, rest: line.slice(colon + 1) };
}

/** Indentation width of a line, tabs counted as one column (agents mix them). */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++;
  return n;
}

/**
 * Decode a typed block body into keyed values. Returns the values plus any
 * lines it could not place, so the caller can raise one diagnostic rather than
 * failing the whole block.
 */
export function parseBlockBody(body: string): { values: Map<string, BlockValue>; stray: string[] } {
  const values = new Map<string, BlockValue>();
  const stray: string[] = [];
  const lines = body.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    // Only column-0 keys open a value; anything indented belongs to the key
    // above and is consumed by the nested readers below.
    if (indentOf(line) > 0) {
      stray.push(line.trim());
      i++;
      continue;
    }
    const head = splitKey(line);
    if (!head) {
      stray.push(line.trim());
      i++;
      continue;
    }
    const inlineValue = head.rest.trim();
    if (inlineValue.length > 0) {
      values.set(head.key, unquote(inlineValue));
      i++;
      continue;
    }

    // `key:` with nothing after it — collect the block that follows. A member
    // is either indented or a `- ` list item at column zero (valid YAML; lanes
    // write both). A blank line is skipped. Anything else at column zero is
    // the next key and ends the group.
    const nested: string[] = [];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim().length === 0) {
        i++;
        continue;
      }
      if (indentOf(next) === 0 && !next.trim().startsWith('-')) break;
      nested.push(next);
      i++;
    }
    values.set(head.key, decodeNested(nested, stray));
  }

  return { values, stray };
}

/** Decode the indented body under a bare `key:` — a list of scalars, a list of
 *  maps, or a map. Empty nested blocks decode to an empty list. */
function decodeNested(lines: string[], stray: string[]): BlockValue {
  if (lines.length === 0) return [];
  const isList = lines.some((l) => l.trim().startsWith('- '));
  if (!isList) {
    const map: Record<string, string> = {};
    for (const line of lines) {
      const kv = splitKey(line.trim());
      if (kv) map[kv.key] = unquote(kv.rest);
      else stray.push(line.trim());
    }
    return map;
  }

  // A list. Each `- ` opens an item; deeper lines continue it. An item whose
  // first line is `key: value` (or which has continuation keys) is a map.
  const items: string[][] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      items.push([trimmed.slice(2).trim()]);
    } else if (trimmed === '-') {
      items.push([]);
    } else if (items.length > 0) {
      items[items.length - 1].push(trimmed);
    } else {
      stray.push(trimmed);
    }
  }

  const anyMapItem = items.some((item) => item.some((l) => splitKey(l) !== null));
  if (!anyMapItem) {
    return items.map((item) => unquote(item.join(' ')));
  }

  const maps: Record<string, string>[] = [];
  for (const item of items) {
    const map: Record<string, string> = {};
    let lastKey: string | null = null;
    for (const l of item) {
      const kv = splitKey(l);
      if (kv) {
        map[kv.key] = unquote(kv.rest);
        lastKey = kv.key;
      } else if (lastKey) {
        // A wrapped continuation line of the previous value.
        map[lastKey] = `${map[lastKey]} ${l.trim()}`.trim();
      } else {
        stray.push(l);
      }
    }
    maps.push(map);
  }
  return maps;
}

function asScalar(value: BlockValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function asMapList(value: BlockValue | undefined): Record<string, string>[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'object' && v !== null)
    ? (value as Record<string, string>[])
    : null;
}

function asStringList(value: BlockValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

function asMap(value: BlockValue | undefined): Record<string, string> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : null;
}

// ─── Per-kind decoders ────────────────────────────────────────────────────
// Each returns the decoded payload, or a diagnostic string explaining what was
// missing. The diagnostic is human-facing — it lands on a chip the reviewer
// reads, so it names the field, not an internal symbol.

type Decoded<T> = { ok: true; data: T; diagnostic?: string } | { ok: false; diagnostic: string };

function decodeWalkthrough(body: string): Decoded<ReviewWalkthroughBlock> {
  const { values, stray } = parseBlockBody(body);
  const rawSteps = asMapList(values.get('steps'));
  if (!rawSteps) return { ok: false, diagnostic: 'walkthrough needs a `steps:` list of `at:`/`say:` items' };

  const steps: ReviewWalkthroughStep[] = [];
  let skipped = 0;
  for (const item of rawSteps) {
    const at = (item.at ?? '').trim();
    const say = (item.say ?? '').trim();
    if (!at && !say) {
      skipped++;
      continue;
    }
    steps.push({ at, say });
  }
  if (steps.length === 0) return { ok: false, diagnostic: 'walkthrough has no usable steps' };

  const notes: string[] = [];
  if (skipped > 0) notes.push(`${skipped} empty step${skipped === 1 ? '' : 's'} skipped`);
  if (stray.length > 0) notes.push(`${stray.length} unrecognized line${stray.length === 1 ? '' : 's'}`);
  return {
    ok: true,
    data: { title: asScalar(values.get('title')) ?? undefined, steps },
    diagnostic: notes.length > 0 ? notes.join('; ') : undefined,
  };
}

function decodeFinding(body: string, detail: string): Decoded<ReviewFindingBlock> {
  const { values, stray } = parseBlockBody(body);
  const title = asScalar(values.get('title'));
  if (!title) return { ok: false, diagnostic: 'finding needs a `title:`' };

  const rawSeverity = (asScalar(values.get('severity')) ?? '').toLowerCase();
  const severity: ReviewBlockSeverity = SEVERITIES.has(rawSeverity)
    ? (rawSeverity as ReviewBlockSeverity)
    : 'non-blocking';

  const rawLine = asScalar(values.get('line'));
  const line = rawLine !== null && /^\d+$/.test(rawLine) ? Number(rawLine) : undefined;

  const notes: string[] = [];
  if (rawSeverity && !SEVERITIES.has(rawSeverity)) {
    notes.push(`unknown severity "${rawSeverity}" — shown as non-blocking`);
  }
  if (rawLine !== null && line === undefined) notes.push(`line "${rawLine}" is not a number`);
  if (stray.length > 0) notes.push(`${stray.length} unrecognized line${stray.length === 1 ? '' : 's'}`);

  return {
    ok: true,
    data: {
      severity,
      title,
      file: asScalar(values.get('file')) ?? undefined,
      line,
      detail: detail.trim().length > 0 ? detail.trim() : undefined,
    },
    diagnostic: notes.length > 0 ? notes.join('; ') : undefined,
  };
}

function decodeDecision(body: string): Decoded<ReviewDecisionBlock> {
  const { values, stray } = parseBlockBody(body);
  const question = asScalar(values.get('question'));
  if (!question) return { ok: false, diagnostic: 'decision needs a `question:`' };

  const rawOptions = values.get('options');
  const listed = asStringList(rawOptions);
  // Tolerate a lane writing options as maps (`- text: …`) rather than scalars.
  const fromMaps = listed === null ? asMapList(rawOptions) : null;
  const options = listed ?? fromMaps?.map((m) => Object.values(m).join(' — ').trim()) ?? null;
  if (!options || options.length === 0) {
    return { ok: false, diagnostic: 'decision needs an `options:` list' };
  }

  const notes: string[] = [];
  let kept = options.filter((o) => o.trim().length > 0).map((o) => o.trim());
  if (kept.length > DECISION_OPTION_CAP) {
    notes.push(`only the first ${DECISION_OPTION_CAP} options are answerable`);
    kept = kept.slice(0, DECISION_OPTION_CAP);
  }
  if (kept.length === 0) return { ok: false, diagnostic: 'decision has no usable options' };

  const rawRec = asScalar(values.get('recommended'));
  let recommended: number | undefined;
  if (rawRec !== null) {
    const n = Number(rawRec);
    if (Number.isInteger(n) && n >= 1 && n <= kept.length) recommended = n;
    else notes.push(`recommended "${rawRec}" is not one of the ${kept.length} options`);
  }
  if (stray.length > 0) notes.push(`${stray.length} unrecognized line${stray.length === 1 ? '' : 's'}`);

  return {
    ok: true,
    data: { question, options: kept, recommended },
    diagnostic: notes.length > 0 ? notes.join('; ') : undefined,
  };
}

function decodeChart(body: string): Decoded<ReviewChartBlock> {
  const { values, stray } = parseBlockBody(body);
  const rawKind = (asScalar(values.get('kind')) ?? 'bar').toLowerCase();
  const kind = CHART_KINDS.has(rawKind) ? (rawKind as ReviewChartBlock['kind']) : 'bar';

  const map = asMap(values.get('data'));
  const list = map === null ? asMapList(values.get('data')) : null;
  const pairs: { label: string; value: number }[] = [];
  let dropped = 0;

  const push = (label: string, raw: string): void => {
    const value = Number(raw);
    if (!label.trim() || !Number.isFinite(value)) {
      dropped++;
      return;
    }
    pairs.push({ label: label.trim(), value });
  };

  if (map) {
    for (const [label, raw] of Object.entries(map)) push(label, raw);
  } else if (list) {
    // `- label: acp/` + `value: 152` form.
    for (const item of list) push(item.label ?? '', item.value ?? '');
  } else {
    return { ok: false, diagnostic: 'chart needs a `data:` map of label → number' };
  }
  if (pairs.length === 0) return { ok: false, diagnostic: 'chart has no numeric data points' };

  const notes: string[] = [];
  if (!CHART_KINDS.has(rawKind)) notes.push(`unknown chart kind "${rawKind}" — drawn as a bar chart`);
  if (dropped > 0) notes.push(`${dropped} non-numeric data point${dropped === 1 ? '' : 's'} dropped`);
  if (stray.length > 0) notes.push(`${stray.length} unrecognized line${stray.length === 1 ? '' : 's'}`);

  return {
    ok: true,
    data: { kind, title: asScalar(values.get('title')) ?? undefined, data: pairs },
    diagnostic: notes.length > 0 ? notes.join('; ') : undefined,
  };
}

function decodeMetrics(body: string): Decoded<ReviewMetricsBlock> {
  const rows: { label: string; value: string }[] = [];
  for (const line of body.split('\n')) {
    if (line.trim().length === 0) continue;
    const kv = splitKey(line.trim());
    // Metrics are a flat strip, so a bare `foo: bar` with spaces in the key is
    // still useful — fall back to a plain first-colon split.
    if (kv) {
      rows.push({ label: kv.key, value: unquote(kv.rest) });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      rows.push({ label: line.slice(0, colon).trim(), value: unquote(line.slice(colon + 1)) });
    } else {
      rows.push({ label: line.trim(), value: '' });
    }
  }
  if (rows.length === 0) return { ok: false, diagnostic: 'metrics has no `label: value` rows' };
  return { ok: true, data: { rows } };
}

function decodeSvg(body: string): Decoded<{ svg: string }> {
  const svg = body.trim();
  if (!/^<svg[\s>]/i.test(svg)) return { ok: false, diagnostic: 'svg block must start with an <svg> element' };
  return { ok: true, data: { svg } };
}

// ─── Document parsing ─────────────────────────────────────────────────────

/** Leading `---` frontmatter stamp `review.md` carries. Returned separately so
 *  it is never rendered as a block (marked would read it as an hr + heading). */
function splitFrontMatter(source: string): { front: Record<string, string>; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return { front: {}, body: source };
  const front: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = splitKey(line.trim());
    if (kv) front[kv.key.toLowerCase()] = unquote(kv.rest);
  }
  return { front, body: source.slice(match[0].length) };
}

/** The fenced-code shape `marked`'s lexer emits, narrowed to what we read. */
interface FenceToken {
  type: string;
  raw: string;
  lang?: string;
  text?: string;
}

/** Resolve a fence info string to a block kind, or null when it is ordinary code. */
function fenceKind(lang: string): ReviewBlockKind | null {
  // `marked` keeps the whole info string in `lang`; only the first word names
  // the language, so ```review:finding severity=blocking still resolves.
  const first = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (first === 'diff') return 'diff';
  if (!first.startsWith(REVIEW_FENCE_PREFIX)) return null;
  const kind = first.slice(REVIEW_FENCE_PREFIX.length);
  return TYPED_FENCE_KINDS.has(kind) ? (kind as ReviewBlockKind) : null;
}

/**
 * Parse a `review.md` source into its frontmatter stamp plus one block per
 * top-level token. Never throws; a token that cannot be typed stays `markdown`.
 */
export function parseReviewDocument(source: string): ReviewDocument {
  const { front, body } = splitFrontMatter(source);
  const blocks: ReviewBlock[] = [];

  let tokens: FenceToken[];
  try {
    tokens = Lexer.lex(body, { gfm: true }) as unknown as FenceToken[];
  } catch {
    // A lexer failure is not a reason to lose the review — show the whole file.
    return {
      title: front.title ?? null,
      laneName: front.lane ?? null,
      subject: front.subject ?? null,
      blocks:
        body.trim().length > 0
          ? [{ id: blockId(1, body), kind: 'markdown', raw: body, diagnostic: 'could not be parsed as Markdown' }]
          : [],
    };
  }

  let ordinal = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const raw = token.raw ?? '';
    if (raw.trim().length === 0) continue;
    ordinal++;
    const id = blockId(ordinal, raw);
    const meta = { id, raw };

    if (token.type !== 'code') {
      blocks.push({ ...meta, kind: 'markdown' });
      continue;
    }

    const kind = fenceKind(token.lang ?? '');
    if (kind === null) {
      // Ordinary code, or an unknown `review:*` kind. Either way it renders as
      // a plain code block; only the latter earns a diagnostic.
      const first = (token.lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      const unknownTyped = first.startsWith(REVIEW_FENCE_PREFIX);
      blocks.push({
        ...meta,
        kind: 'markdown',
        diagnostic: unknownTyped ? `unknown review block "${first}"` : undefined,
      });
      continue;
    }

    const text = token.text ?? '';
    // Each branch builds its own typed block, so `data` narrows against `kind`
    // with no cast — a decoder returning the wrong payload is a compile error.
    switch (kind) {
      case 'diff':
        blocks.push({ ...meta, kind: 'diff', data: { unified: text } });
        break;
      case 'walkthrough':
        pushDecoded(blocks, meta, 'walkthrough', decodeWalkthrough(text));
        break;
      case 'finding':
        // A finding may be followed by prose explaining it. `marked` emits that
        // as its own paragraph token, so the card picks it up rather than
        // leaving the explanation detached from the finding it explains.
        pushDecoded(blocks, meta, 'finding', decodeFinding(text, takeFollowingProse(tokens, index)));
        break;
      case 'decision':
        pushDecoded(blocks, meta, 'decision', decodeDecision(text));
        break;
      case 'chart':
        pushDecoded(blocks, meta, 'chart', decodeChart(text));
        break;
      case 'metrics':
        pushDecoded(blocks, meta, 'metrics', decodeMetrics(text));
        break;
      case 'svg':
        pushDecoded(blocks, meta, 'svg', decodeSvg(text));
        break;
    }
  }

  return {
    title: front.title ?? null,
    laneName: front.lane ?? null,
    subject: front.subject ?? null,
    blocks,
  };
}

/** Append a decoded typed block, or degrade it to a diagnostic-carrying
 *  `markdown` block. The `kind`/`data` pairing is checked by the caller's
 *  narrowed types, so this stays the single place degradation is decided. */
function pushDecoded<K extends Exclude<ReviewBlockKind, 'markdown'>>(
  blocks: ReviewBlock[],
  meta: ReviewBlockMeta,
  kind: K,
  decoded: Decoded<Extract<ReviewBlock, { kind: K }>['data']>,
): void {
  if (!decoded.ok) {
    blocks.push({ ...meta, kind: 'markdown', diagnostic: decoded.diagnostic });
    return;
  }
  blocks.push({ ...meta, kind, data: decoded.data, diagnostic: decoded.diagnostic } as ReviewBlock);
}

/** Text of the paragraph immediately after `index`, if there is one. Read-only —
 *  the paragraph still renders as its own markdown block, so the explanation is
 *  never hidden; the finding card just also knows about it. */
function takeFollowingProse(tokens: readonly FenceToken[], index: number): string {
  for (let i = index + 1; i < tokens.length; i++) {
    const next = tokens[i];
    if (next.type === 'space') continue;
    return next.type === 'paragraph' ? (next.text ?? '') : '';
  }
  return '';
}

// ─── Derived counts ───────────────────────────────────────────────────────

/** Blocks the human can answer: findings (accept/dismiss) and decisions. */
export function answerableBlocks(blocks: readonly ReviewBlock[]): ReviewBlock[] {
  return blocks.filter((b) => b.kind === 'finding' || b.kind === 'decision');
}

/** Walkthrough step count across the document — on a comprehension Board this is
 *  a better measure of "how much is here to read" than the block count. */
export function walkthroughStepCount(blocks: readonly ReviewBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.kind === 'walkthrough') total += block.data.steps.length;
  }
  return total;
}

/** A parsed `at:` anchor. `line` is absent for a whole-file step. */
export interface WalkthroughAnchor {
  path: string;
  line?: number;
  lineEnd?: number;
}

/** Decode `path`, `path:line`, or `path:start-end`. Returns null for an empty
 *  anchor; a trailing non-numeric suffix is treated as part of the path so a
 *  Windows-style `C:\…` or a colon in a filename does not silently truncate. */
export function parseWalkthroughAnchor(at: string): WalkthroughAnchor | null {
  const raw = at.trim();
  if (!raw) return null;
  const match = raw.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (!match) return { path: raw };
  const line = Number(match[2]);
  const lineEnd = match[3] !== undefined ? Number(match[3]) : undefined;
  return { path: match[1], line, lineEnd: lineEnd !== undefined && lineEnd >= line ? lineEnd : undefined };
}
