// Krypton — Files and Grep scopes of the Search Palette (spec 349)
//
// Both tabs search the focused project with `fff-search` running in the Rust
// process (docs/0068-quick-file-search.md). Enter opens the highlighted hit in
// Helix in a new tab. Ctrl+E copies the relative path to the clipboard;
// Cmd+Enter copies the absolute path. Clipboard picks are never auto-pasted.
// `Cmd+O` opens the Search Palette on the Files tab; the overlay itself lives
// in search-palette.ts.

import { invoke } from '@tauri-apps/api/core';
import { Compositor } from './compositor';
import { openInHelixTab } from './editor-open';
import type {
  AcceptControl,
  AcceptHow,
  ScopeHint,
  ScopeQueryResult,
  ScopeRow,
  SearchScope,
} from './palette-types';
import type { QuickGrepHit, QuickGrepResponse, QuickSearchHit, QuickSearchResponse } from './types';

const RESULT_LIMIT = 50;

const HINTS: readonly ScopeHint[] = [
  { keys: ['Enter'], label: 'open in hx', kind: 'helix' },
  { keys: ['⌃E'], label: 'copy', kind: 'relative' },
  { keys: ['⌘Enter'], label: 'copy absolute', kind: 'absolute' },
  { keys: ['Tab'], label: 'next tab' },
  { keys: ['Esc'], label: 'close' },
];

/**
 * The project root both tabs search: the git root above the focused cwd
 * (resolved by `quick_search_warm_root`). Resolved once per palette open and
 * shared, so switching Files ↔ Grep does not warm it again.
 */
export class ProjectRoot {
  private root: string | null = null;
  private error: string | null = null;
  private resolving: Promise<void> | null = null;
  /** Bumped on reset so a warm-up from an earlier open cannot write back. */
  private generation = 0;

  constructor(private readonly compositor: Compositor) {}

  reset(): void {
    this.generation++;
    this.root = null;
    this.error = null;
    this.resolving = null;
  }

  ensure(): Promise<void> {
    this.resolving ??= this.resolve();
    return this.resolving;
  }

  /** The resolved root, or null while unresolved or after a failed warm-up. */
  get path(): string | null {
    return this.error === null ? this.root : null;
  }

  get display(): string {
    return this.root ? abbreviatePath(this.root) : '';
  }

  /** The result a tab shows when there is no usable root. */
  unresolved(): ScopeQueryResult {
    const status = this.error === null ? 'resolving…' : `error: ${this.error}`;
    return { rows: [], status, pending: false };
  }

  private async resolve(): Promise<void> {
    const generation = this.generation;
    const cwd = await this.resolveCwd();
    let root: string;
    let error: string | null = null;
    try {
      root = await invoke<string>('quick_search_warm_root', { cwd });
    } catch (e) {
      console.error('[ProjectRoot] warm_root failed:', e);
      root = cwd;
      error = String(e);
    }
    if (generation !== this.generation) return;
    this.root = root;
    this.error = error;
  }

  private async resolveCwd(): Promise<string> {
    try {
      const cwd = await this.compositor.getFocusedWorkingDirectory();
      if (cwd) return cwd;
    } catch {
      // fall through
    }
    // Fallback: the backend canonicalizes "."
    return '.';
  }
}

/** A hit both tabs can open or copy. `line`/`col` are set for grep hits. */
interface Hit {
  path: string;
  absolute: string;
  line: number | null;
  /** 1-based column. */
  col: number | null;
}

class FileRow implements ScopeRow {
  constructor(readonly hit: QuickSearchHit, private readonly query: string) {}

  get target(): Hit {
    return { path: this.hit.path, absolute: this.hit.absolute, line: null, col: null };
  }

  render(el: HTMLElement): void {
    el.classList.add('krypton-search-palette__row--file');
    const { dir, name } = splitPath(this.hit.path);

    const filenameEl = document.createElement('span');
    filenameEl.className = 'krypton-search-palette__filename';
    filenameEl.append(...highlight(name, this.query));

    const parentEl = document.createElement('span');
    parentEl.className = 'krypton-search-palette__parent';
    parentEl.textContent = dir;

    el.append(filenameEl, parentEl);
  }
}

class GrepRow implements ScopeRow {
  constructor(readonly hit: QuickGrepHit) {}

  get target(): Hit {
    return {
      path: this.hit.path,
      absolute: this.hit.absolute,
      line: this.hit.line,
      col: grepColumn(this.hit.line_content, this.hit.col),
    };
  }

  render(el: HTMLElement): void {
    el.classList.add('krypton-search-palette__row--grep');

    const locEl = document.createElement('span');
    locEl.className = 'krypton-search-palette__grep-loc';
    locEl.textContent = `${this.hit.path}:${this.hit.line}`;

    const snippetEl = document.createElement('span');
    snippetEl.className = 'krypton-search-palette__grep-snippet';
    snippetEl.append(...highlightRanges(this.hit.line_content, this.hit.match_ranges));

    el.append(locEl, snippetEl);
  }
}

function targetOf(row: ScopeRow): Hit | null {
  if (row instanceof FileRow || row instanceof GrepRow) return row.target;
  return null;
}

function recordPick(absolute: string): void {
  invoke('quick_search_record_pick', { absolute }).catch((e) => {
    console.warn('[ProjectSearch] record_pick failed:', e);
  });
}

/** Shared accept for file and grep hits. */
async function acceptHit(compositor: Compositor, hit: Hit, how: AcceptHow, ctl: AcceptControl): Promise<void> {
  if (how === 'primary') {
    // Close BEFORE awaiting spawn so InputRouter leaves the palette mode at
    // once and keystrokes flow to the new hx tab.
    if (!compositor.hasFocusedWindow()) {
      ctl.setStatus('open failed: no focused window');
      return;
    }
    ctl.playExecute();
    ctl.close();
    void openInHelixTab(compositor, { path: hit.absolute, line: hit.line, col: hit.col }).then((result) => {
      if (result !== 'opened') console.warn(`[ProjectSearch] openInHelixTab: ${result}`);
    });
    recordPick(hit.absolute);
    return;
  }

  const absolute = how === 'copy-absolute';
  const base = absolute ? hit.absolute : hit.path;
  const text = hit.line === null ? base : `${base}:${hit.line}:${hit.col}`;
  let copied = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    copied = false;
    console.error('[ProjectSearch] clipboard write failed:', e);
    ctl.setStatus('clipboard write failed');
  }
  recordPick(hit.absolute);
  if (!copied) return;

  ctl.playExecute();
  await ctl.flash(absolute ? 'absolute' : 'relative');
  ctl.close();
}

export class FileScope implements SearchScope {
  readonly id = 'files' as const;
  readonly label = 'Files';
  readonly shortcut = '⌘O';
  readonly prompt = '⟶';
  readonly placeholder = 'find file…';
  readonly hints = HINTS;

  constructor(private readonly compositor: Compositor, private readonly root: ProjectRoot) {}

  aside(): string {
    return this.root.display;
  }

  reset(): void {
    this.root.reset();
  }

  activate(): Promise<void> {
    return this.root.ensure();
  }

  async query(q: string): Promise<ScopeQueryResult> {
    await this.root.ensure();
    const root = this.root.path;
    if (root === null) return this.root.unresolved();

    let resp: QuickSearchResponse;
    try {
      resp = await invoke<QuickSearchResponse>('quick_search_query', { root, query: q, limit: RESULT_LIMIT });
    } catch (e) {
      return { rows: [], status: `error: ${String(e)}`, pending: false };
    }

    const rows = resp.hits.map((hit) => new FileRow(hit, q));
    let status: string;
    if (resp.indexing) {
      status = `indexing… (${resp.indexed_count.toLocaleString()} files)`;
    } else if (resp.hits.length === 0) {
      status = q.length === 0 ? 'Type to search this project (no history yet)' : 'no matches';
    } else {
      status = `${resp.hits.length} matches`;
    }
    return { rows, status, pending: resp.indexing };
  }

  async accept(row: ScopeRow, how: AcceptHow, ctl: AcceptControl): Promise<void> {
    const hit = targetOf(row);
    if (hit) await acceptHit(this.compositor, hit, how, ctl);
  }
}

export class GrepScope implements SearchScope {
  readonly id = 'grep' as const;
  readonly label = 'Grep';
  readonly shortcut = '';
  readonly prompt = '⟶';
  readonly placeholder = 'grep this project…';
  readonly hints = HINTS;

  constructor(private readonly compositor: Compositor, private readonly root: ProjectRoot) {}

  aside(): string {
    return this.root.display;
  }

  reset(): void {
    this.root.reset();
  }

  activate(): Promise<void> {
    return this.root.ensure();
  }

  async query(q: string): Promise<ScopeQueryResult> {
    if (q.trim().length === 0) return { rows: [], status: 'grep — type a query', pending: false };

    await this.root.ensure();
    const root = this.root.path;
    if (root === null) return this.root.unresolved();

    let resp: QuickGrepResponse;
    try {
      resp = await invoke<QuickGrepResponse>('quick_grep_query', { root, query: q, limit: RESULT_LIMIT });
    } catch (e) {
      return { rows: [], status: `error: ${String(e)}`, pending: false };
    }

    const rows = resp.hits.map((hit) => new GrepRow(hit));
    let status: string;
    if (resp.indexing) {
      status = `indexing… (${resp.indexed_count.toLocaleString()} files)`;
    } else if (resp.regex_fallback_error) {
      status = `regex fallback: ${resp.regex_fallback_error}`;
    } else if (resp.hits.length === 0) {
      status = 'no matches';
    } else {
      status = `${resp.hits.length} matches (grep)`;
    }
    return { rows, status, pending: resp.indexing };
  }

  async accept(row: ScopeRow, how: AcceptHow, ctl: AcceptControl): Promise<void> {
    const hit = targetOf(row);
    if (hit) await acceptHit(this.compositor, hit, how, ctl);
  }
}

// ─── helpers ──────────────────────────────────────────────

function splitPath(p: string): { dir: string; name: string } {
  const idx = p.lastIndexOf('/');
  if (idx < 0) return { dir: '', name: p };
  return { dir: p.slice(0, idx + 1), name: p.slice(idx + 1) };
}

function abbreviatePath(p: string): string {
  const home = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  let s = p;
  if (home) s = '~' + p.slice(home[1].length);
  if (s.length > 56) s = '…' + s.slice(s.length - 53);
  return s;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

// lib is ES2021; Intl.Segmenter typings arrive with ES2022.
const graphemeSegmenter: GraphemeSegmenter | null = (() => {
  const Ctor = (Intl as typeof Intl & {
    Segmenter?: new (locale: string | undefined, options: { granularity: 'grapheme' }) => GraphemeSegmenter;
  }).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
})();

/**
 * Walk `text` to the UTF-8 byte offset `byteOffset` (the unit fff-search
 * reports): the UTF-16 index there, which JS strings use, and how many bytes
 * lie past the end of `text` (fff-search truncates long lines).
 */
function walkBytes(text: string, byteOffset: number): { index: number; overflow: number } {
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    if (bytes >= byteOffset) return { index, overflow: 0 };
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    index += ch.length;
  }
  return { index, overflow: Math.max(0, byteOffset - bytes) };
}

/**
 * 1-based column for `hx path:line:col` from fff-search's 0-based byte column.
 * Helix counts graphemes (helix-core `pos_at_coords`), so a Thai consonant with
 * its tone mark is one column. Bytes past a truncated line count one each.
 */
export function grepColumn(line: string, byteCol: number): number {
  const { index, overflow } = walkBytes(line, byteCol);
  const prefix = line.slice(0, index);
  const graphemes = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(prefix)).length
    : Array.from(prefix).length;
  return graphemes + overflow + 1;
}

/** Highlight fff-search's match spans, which are UTF-8 byte offsets into `text`. */
export function highlightRanges(text: string, ranges: Array<[number, number]>): Node[] {
  if (ranges.length === 0) return [document.createTextNode(text)];
  // Map to UTF-16 indices, then sort + merge overlapping spans defensively.
  const sorted = ranges
    .map(([s, e]): [number, number] => [walkBytes(text, s).index, walkBytes(text, e).index])
    .sort((a, b) => a[0] - b[0]);
  const out: Node[] = [];
  let cursor = 0;
  for (const [s, e] of sorted) {
    if (e <= cursor) continue;
    const start = Math.max(s, cursor);
    if (start > cursor) out.push(document.createTextNode(text.slice(cursor, start)));
    const end = Math.min(e, text.length);
    if (end > start) {
      const m = document.createElement('mark');
      m.textContent = text.slice(start, end);
      out.push(m);
    }
    cursor = end;
  }
  if (cursor < text.length) out.push(document.createTextNode(text.slice(cursor)));
  return out;
}

/** Subsequence highlight — the same case-insensitive walk the Commands tab
 *  uses, so highlights line up with what the user typed. */
function highlight(text: string, query: string): Node[] {
  if (!query) return [document.createTextNode(text)];
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < tl.length && qi < ql.length; ti++) {
    if (tl[ti] === ql[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  if (qi < ql.length) return [document.createTextNode(text)];
  const set = new Set(indices);
  const out: Node[] = [];
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      const m = document.createElement('mark');
      m.textContent = text[i];
      out.push(m);
    } else {
      out.push(document.createTextNode(text[i]));
    }
  }
  return out;
}
