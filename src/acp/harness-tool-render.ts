// Krypton — ACP Harness View: tool output rendering.
//
// Extracted from acp-harness-view.ts (spec 204). Owns the output-dump analysis
// the `ToolRow` component paints: tool-dump normalisation, the grep renderer,
// and the `git diff --stat` / `git status --short` parsers. It reads decoded
// text and `ToolPayload`s only; the readers of the wire `ToolCall` live in
// `src/acp/adapters/` (spec 380).
//
// Spec 301 phase 3 moved every builder that painted a whole row — the tool
// body, its streaming patch, the artifact and Review Board cards, the unified
// diff — into `src/acp/components/`.

import { stripAnsi } from './provider-error';
import { gridifyLines, sliceCells } from './cell-grid';
import type { ToolPayload } from './harness-view-types';

// First frame of SPINNER_FRAMES in harness-lane-chrome.ts. In-flight tool
// rows seed this braille cell (never the empty `·` / missing `⟳`) so the
// reserved glyph box keeps the same metrics until ✓/✗ replace it. The JS
// ticker overwrites the glyph on the next tick.
const TOOL_SPINNER_SEED = '⠋';

export function statusGlyph(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'failed' || status === 'canceled') return '✗';
  return TOOL_SPINNER_SEED;
}

export function isMemoryTool(view: { readonly toolName: string | null; readonly title: string }): boolean {
  return (view.toolName ?? '').toLowerCase().startsWith('memory_') || view.title.toLowerCase().includes('memory_');
}

export function cleanToolTitle(title: string | undefined, fallback: string): string {
  const value = title?.trim() ?? '';
  if (!value || value.toLowerCase() === 'tool' || value.toLowerCase() === fallback) return '';
  if (/^tool\s+exit\s+\d+$/i.test(value)) return '';
  return value;
}

/** Maximum retained output-line width; CSS clips further to the actual well. */
const OUTPUT_LINE_CELLS = 140;

/**
 * Cut a line beyond the retained limit at 139 cells plus `…`. Counted in cells,
 * not code units (spec 326): equally padded Thai and ASCII rows are cut on the
 * same column, and no grapheme is split.
 */
function capLineCells(line: string): string {
  const fit = sliceCells(line, OUTPUT_LINE_CELLS);
  return fit.length === line.length ? line : `${sliceCells(fit, OUTPUT_LINE_CELLS - 1)}…`;
}

export function boundedOutputLines(value: string, maxLines: number): string {
  // Backends that captured their tool output under a PTY / forced color (e.g. `gh`
  // colorizing JSON) hand us raw ANSI SGR codes. This panel renders via
  // `pre.textContent`, so an unhandled ESC (0x1b) byte shows as a garbage glyph and
  // the trailing `[1;37m` shows as literal text. Strip ANSI + leftover C0/C1 control
  // chars here (keeping \t and \n) so every lane's output reads clean.
  return stripAnsi(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .slice(0, maxLines)
    .map(capLineCells)
    .join('\n');
}

export function isTerminalToolStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

export function formatToolElapsed(ms: number): string {
  if (ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms / 100) * 100}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatArtifactBytes(size: number | null): string {
  if (size === null) return '— bytes';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** spec 133 — redacted body for an artifact-path write/edit card: never the
 * HTML, only path + bytes + hash. */
export function renderArtifactRedaction(r: NonNullable<ToolPayload['artifactRedaction']>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'acp-harness__artifact-redaction';
  const note = document.createElement('div');
  note.className = 'acp-harness__artifact-redaction-note';
  note.textContent = r.pending ? 'html artifact · contents hidden' : 'html artifact edit · contents hidden';
  wrap.appendChild(note);
  const meta = document.createElement('div');
  meta.className = 'acp-harness__artifact-redaction-meta';
  const hash7 = r.hash ? r.hash.slice(0, 7) : '—';
  meta.textContent = `${r.tail} · ${formatArtifactBytes(r.size)} · ${hash7}`;
  wrap.appendChild(meta);
  return wrap;
}

export function isGitDiffCommand(command: string): boolean {
  return /\bgit\s+diff\b/.test(command);
}

export function parseGitDiffStat(text: string): Array<{ path: string; changes: number; plus: number; minus: number }> {
  const rows: Array<{ path: string; changes: number; plus: number; minus: number }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /\d+\s+files?\s+changed/.test(line)) continue;
    const match = line.match(/^(.+?)\s+\|\s+(\d+)\s+([+\-]+)$/);
    if (!match) continue;
    const marks = match[3] ?? '';
    rows.push({
      path: match[1]?.trim() ?? '',
      changes: Number(match[2] ?? 0),
      plus: (marks.match(/\+/g) ?? []).length,
      minus: (marks.match(/-/g) ?? []).length,
    });
  }
  return rows.slice(0, 8);
}

export function parseGitStatusShort(text: string): Array<{ index: string; worktree: string; path: string }> {
  const rows: Array<{ index: string; worktree: string; path: string }> = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const match = raw.match(/^(.)(.)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      index: match[1] ?? ' ',
      worktree: match[2] ?? ' ',
      path: match[3] ?? '',
    });
  }
  return rows.slice(0, 10);
}

export function gitStatusTone(index: string, worktree: string): string {
  if (index === '?' || worktree === '?') return 'new';
  if (index === 'D' || worktree === 'D') return 'deleted';
  if (index === 'A' || worktree === 'A') return 'added';
  return 'modified';
}

export function toolSectionTone(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized === 'stderr' || normalized === 'error' || normalized === 'message') return 'error';
  if (
    normalized === 'stdout' ||
    normalized === 'output' ||
    normalized === 'text' ||
    normalized === 'content'
  ) {
    return 'output';
  }
  if (normalized === 'summary') return 'summary';
  if (normalized === 'diff') return 'diff';
  if (normalized === 'terminal') return 'terminal';
  return 'default';
}

/** Chip `data-kind` for spec 235 / 231 HUD accents. Local map so this file
 *  does not import the HUD module (HUD already imports us). */
export function toolChipKind(kind: string): string {
  const k = kind.trim().toLowerCase();
  if (!k) return 'other';
  if (k === 'edit' || k === 'write' || k === 'create' || k === 'modify' || k === 'patch') return 'edit';
  if (k === 'read' || k === 'open' || k === 'cat') return 'read';
  if (k === 'search' || k === 'grep' || k === 'rg' || k === 'find') return 'search';
  if (
    k === 'execute' ||
    k === 'bash' ||
    k === 'shell' ||
    k === 'run' ||
    k === 'exec' ||
    k === 'command'
  ) {
    return 'execute';
  }
  if (k === 'delete') return 'delete';
  if (k === 'move' || k === 'rename') return 'move';
  if (k === 'fetch' || k === 'http' || k === 'web') return 'fetch';
  return 'other';
}

const GREP_CMD = /\b(rg|grep|ag|ack)\b/;
const GREP_SECTION = /^(stdout|output|content|text)$/i;

export function isGrepCommand(text: string): boolean {
  return GREP_CMD.test(text);
}

export function isGrepLikeOutput(
  tool: Pick<ToolPayload, 'kind' | 'command' | 'subject'>,
  section: { label: string },
): boolean {
  if (!GREP_SECTION.test(section.label)) return false;
  if (toolChipKind(tool.kind) === 'search') return true;
  return isGrepCommand(tool.command) || isGrepCommand(tool.subject);
}

/** Quoted `-e` or first quoted arg after rg/grep/ag/ack. Empty when unquoted. */
export function extractGrepQuery(command: string): string {
  if (!command) return '';
  const eFlag = command.match(/(?:^|\s)-e\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (eFlag) return (eFlag[1] ?? eFlag[2] ?? eFlag[3] ?? '').trim();
  const flags = '(?:\\s+--?[A-Za-z0-9][A-Za-z0-9-]*)*';
  const dbl = command.match(new RegExp(`\\b(?:rg|grep|ag|ack)\\b${flags}\\s+"([^"]+)"`));
  if (dbl?.[1]) return dbl[1].trim();
  const sgl = command.match(new RegExp(`\\b(?:rg|grep|ag|ack)\\b${flags}\\s+'([^']+)'`));
  if (sgl?.[1]) return sgl[1].trim();
  return '';
}

/** Literal needles from a quoted grep pattern. Splits grep `\\|` / `|` OR. */
export function grepHitNeedles(query: string): string[] {
  if (!query) return [];
  const parts = query.split(/\\\||\|/).map((part) => part.trim()).filter((part) => part.length >= 2);
  return parts;
}

export interface GrepRow {
  path: string | null;
  line: string;
  text: string;
  context: boolean;
}

function looksLikeGrepPath(value: string): boolean {
  if (!value || value.length > 240) return false;
  if (/\s/.test(value)) return false;
  if (/^(error|warning|note|fatal|info)$/i.test(value)) return false;
  return /[./\\]/.test(value);
}

export function parseGrepLine(line: string): GrepRow | null {
  let match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
  if (match && looksLikeGrepPath(match[1] ?? '')) {
    return {
      path: match[1] ?? '',
      line: `${match[2]}:${match[3]}`,
      text: match[4] ?? '',
      context: false,
    };
  }
  match = line.match(/^(.+?):(\d+):(.*)$/);
  if (match && looksLikeGrepPath(match[1] ?? '')) {
    return {
      path: match[1] ?? '',
      line: match[2] ?? '',
      text: match[3] ?? '',
      context: false,
    };
  }
  match = line.match(/^(.+?)-(\d+)-(.*)$/);
  if (match && looksLikeGrepPath(match[1] ?? '')) {
    return {
      path: match[1] ?? '',
      line: match[2] ?? '',
      text: match[3] ?? '',
      context: true,
    };
  }
  match = line.match(/^(\d+):(.*)$/);
  if (match) {
    return { path: null, line: match[1] ?? '', text: match[2] ?? '', context: false };
  }
  match = line.match(/^(\d+)-(.*)$/);
  if (match) {
    return { path: null, line: match[1] ?? '', text: match[2] ?? '', context: true };
  }
  return null;
}

const WORKSPACE_OPEN_RE = /^<workspace_result\b[^>]*>\s*/i;
const WORKSPACE_CLOSE_RE = /\s*<\/workspace_result>\s*$/i;
const GREP_FOUND_RE = /^Found(?: at least)? \d+ matching lines?$/i;
const GREP_NONE_RE = /^No matches found$/i;

/** Grok's grep/search tool wraps hits in a `<workspace_result>` envelope.
 *  Strip the open tag even when the line cap dropped the close tag, so a
 *  truncated dump does not paint XML. */
export function unwrapWorkspaceResultDump(text: string): string {
  const trimmed = text.trim();
  if (!WORKSPACE_OPEN_RE.test(trimmed)) return text;
  return trimmed.replace(WORKSPACE_OPEN_RE, '').replace(WORKSPACE_CLOSE_RE, '').trim();
}

/** Drop Grok `read_file` line-number anchors (`1→`, `10→`, …). Display only. */
export function stripGrokReadLineAnchors(text: string): string {
  return text.replace(/^\d+→/gm, '');
}

/** True when the dump starts with a Grok `read_file` line anchor (`1→`, `238→`). */
export function looksLikeGrokReadAnchors(text: string): boolean {
  const first = text.split('\n', 1)[0] ?? '';
  return /^\d+→/.test(first);
}

/** Protocol wrappers Grok puts around tool dumps, before the line cap.
 *  Shape-based: XML unwrap always; N→ strip when kind is read *or* the dump
 *  itself starts with an anchor (kind can be missing on a tool_call_update). */
export function normalizeToolDump(text: string, kind: string): string {
  let out = unwrapWorkspaceResultDump(text);
  if (toolChipKind(kind) === 'read' || looksLikeGrokReadAnchors(out)) {
    out = stripGrokReadLineAnchors(out);
  }
  return out;
}

function isGrepPathHeader(line: string): boolean {
  return looksLikeGrepPath(line) && !/:\d+/.test(line);
}

/** Majority of considered lines must parse, else null (plain `<pre>`).
 *  Host preamble (XML envelope, "Found N", path-only headers) is skipped so
 *  Grok's grouped dump (`path` then `line:text`) still qualifies. */
export function parseGrepDump(text: string): GrepRow[] | null {
  const lines = unwrapWorkspaceResultDump(text)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const rows: GrepRow[] = [];
  let currentPath: string | null = null;
  let considered = 0;
  for (const line of lines) {
    if (GREP_FOUND_RE.test(line) || GREP_NONE_RE.test(line)) continue;
    if (isGrepPathHeader(line)) {
      currentPath = line;
      continue;
    }
    considered += 1;
    const row = parseGrepLine(line);
    if (!row) continue;
    if (!row.path && currentPath) row.path = currentPath;
    rows.push(row);
  }
  if (considered === 0 || rows.length * 2 <= considered) return null;
  return rows;
}

function appendHighlighted(parent: HTMLElement, text: string, needles: string[]): void {
  if (!text) return;
  if (needles.length === 0) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  let rest = text;
  while (rest.length > 0) {
    let bestAt = -1;
    let bestNeedle = '';
    for (const needle of needles) {
      const at = rest.indexOf(needle);
      if (at < 0) continue;
      if (bestAt < 0 || at < bestAt || (at === bestAt && needle.length > bestNeedle.length)) {
        bestAt = at;
        bestNeedle = needle;
      }
    }
    if (bestAt < 0) {
      parent.appendChild(document.createTextNode(rest));
      return;
    }
    if (bestAt > 0) parent.appendChild(document.createTextNode(rest.slice(0, bestAt)));
    const hit = document.createElement('span');
    hit.className = 'acp-harness__tok-hit';
    hit.textContent = bestNeedle;
    parent.appendChild(hit);
    rest = rest.slice(bestAt + bestNeedle.length);
  }
}

function tok(kind: string, value: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `acp-harness__tok-${kind}`;
  el.textContent = value;
  return el;
}

/** A grep dump is always an output-slot section (`stdout` / `output` /
 *  `content` / `text`), so it paints no label line: the well is the output. */
export function renderGrepSection(
  tool: Pick<ToolPayload, 'command' | 'subject'>,
  section: { label: string; text: string },
): HTMLElement | null {
  const rows = parseGrepDump(section.text);
  if (!rows) return null;
  const needles = grepHitNeedles(extractGrepQuery(tool.command) || extractGrepQuery(tool.subject));
  const block = document.createElement('div');
  block.className = 'acp-harness__tool-section acp-harness__tool-section--output';
  const rich = document.createElement('div');
  rich.className = 'acp-harness__tool-rich acp-harness__tool-rich--grep';
  const texts: HTMLElement[] = [];
  for (const row of rows) {
    const line = document.createElement('div');
    const shape = row.path ? 'path' : 'lineno';
    line.className = `acp-harness__grep-row acp-harness__grep-row--${shape}${row.context ? ' acp-harness__grep-row--ctx' : ''}`;
    if (row.path) {
      line.appendChild(tok('path', row.path));
      line.appendChild(tok('sep', ':'));
    }
    line.appendChild(tok('line', row.line));
    line.appendChild(tok('sep', row.path ? ':' : row.context ? '-' : ':'));
    const text = document.createElement('span');
    text.className = row.context ? 'acp-harness__tok-text acp-harness__tok-ctx' : 'acp-harness__tok-text';
    if (row.context || needles.length === 0) {
      text.textContent = row.text;
    } else {
      appendHighlighted(text, row.text, needles);
    }
    line.appendChild(text);
    texts.push(text);
    rich.appendChild(line);
  }
  // Spec 326: matched lines that hold a diagram or padded Thai sit on the cell grid.
  gridifyLines(rich, texts);
  block.appendChild(rich);
  return block;
}
