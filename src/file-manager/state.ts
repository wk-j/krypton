// Krypton — File Manager state model (spec 317).
//
// One mutable plain object owned by the view. No DOM, no timers. The helpers
// and selectors below are the old view's arithmetic, extracted verbatim.

import type { FileContextEntry, FileManagerContext } from '../file-manager-ai';
import { formatSize } from '../file-preview';
import type { BreadcrumbProps } from './components/breadcrumb';
import type { FileListProps } from './components/file-list';
import type { SearchListProps } from './components/search-list';
import type { StatusBarProps } from './components/status-bar';
import { recencyByPath } from './decorations';
import { overscanRange } from './smooth-scroll';
import type { ClipboardState, FileEntry, PromptState, SortField, SortOrder } from './types';

export interface SearchState {
  active: boolean;
  text: string;
  root: string;
  capped: boolean;
  pool: string[];
  poolLower: string[];
  results: string[];
  cursor: number;
  scrollOffset: number;
}

export interface FileManagerState {
  readonly initialCwd: string;
  cwd: string;
  /** '/' until getHome() resolves (no re-render on resolve — quirk P8). */
  homeDir: string;
  /** Sorted listing. */
  entries: FileEntry[];
  /** Fresh array per filter pass (identity is the recency memo key). */
  filtered: FileEntry[];
  cursor: number;
  scrollOffset: number;
  visibleRows: number;
  cellHeight: number;
  sortField: SortField;
  sortOrder: SortOrder;
  filterMode: boolean;
  filterText: string;
  marked: Set<string>;
  tracked: Map<string, string>;
  clipboard: ClipboardState | null;
  showHidden: boolean;
  history: string[];
  prompt: PromptState | null;
  confirmAction: (() => void) | null;
  previewHidden: boolean;
  listWidthPx: number;
  search: SearchState;
}

/** Upper bound of the search pool; at or above it the status says "(capped)". */
export const SEARCH_POOL_CAP = 50_000;

export function createState(initialCwd: string): FileManagerState {
  return {
    initialCwd,
    cwd: initialCwd,
    homeDir: '/',
    entries: [],
    filtered: [],
    cursor: 0,
    scrollOffset: 0,
    visibleRows: 30, // sensible default until onResize is called
    cellHeight: 20,
    sortField: 'name',
    sortOrder: 'asc',
    filterMode: false,
    filterText: '',
    marked: new Set(),
    tracked: new Map(),
    clipboard: null,
    showHidden: false,
    history: [],
    prompt: null,
    confirmAction: null,
    previewHidden: false,
    listWidthPx: 333,
    search: {
      active: false,
      text: '',
      root: '',
      capped: false,
      pool: [],
      poolLower: [],
      results: [],
      cursor: 0,
      scrollOffset: 0,
    },
  };
}

// ─── pure helpers ────────────────────────────────────────────────────

export function wrapCursor(cursor: number, delta: number, len: number): number {
  return ((cursor + delta) % len + len) % len;
}

/** Keep `cursor` inside the window starting at `offset`. `rows <= 0` → unchanged. */
export function clampScroll(cursor: number, offset: number, rows: number): number {
  if (rows <= 0) return offset;
  let next = offset;
  if (cursor < next) {
    next = cursor;
  } else if (cursor >= next + rows) {
    next = cursor - rows + 1;
  }
  return Math.max(0, next);
}

/** `[start, end)` of the visible window. */
export function windowRange(offset: number, rows: number, len: number): [number, number] {
  return [offset, Math.min(offset + rows, len)];
}

export function parentDir(cwd: string): string {
  return cwd.replace(/\/[^/]+\/?$/, '') || '/';
}

/** `name 2.ext` … `name 999.ext`, else `name copy.ext`, as an absolute path in `cwd`. */
export function uniqueCopyPath(cwd: string, name: string, existing: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} ${i}${ext}`;
    if (!existing.has(candidate)) return `${cwd}/${candidate}`;
  }
  return `${cwd}/${stem} copy${ext}`;
}

export function currentEntry(s: FileManagerState): FileEntry | undefined {
  return s.filtered[s.cursor];
}

export function marksOrCurrent(s: FileManagerState): string[] {
  if (s.marked.size > 0) return [...s.marked];
  const entry = currentEntry(s);
  return entry ? [entry.path] : [];
}

export function markedOrCurrentFiles(s: FileManagerState): FileEntry[] {
  if (s.marked.size > 0) {
    return s.filtered.filter((entry) => !entry.is_dir && s.marked.has(entry.path));
  }
  const entry = currentEntry(s);
  return entry && !entry.is_dir ? [entry] : [];
}

/** After a refresh: keep marks that still exist; cursor on the same name, else clamp. */
export function restoreSelection(
  prevName: string | null,
  prevCursor: number,
  prevMarked: ReadonlySet<string>,
  filtered: readonly FileEntry[],
): { cursor: number; marked: Set<string> } {
  const marked = new Set<string>();
  for (const entry of filtered) {
    if (prevMarked.has(entry.path)) marked.add(entry.path);
  }
  let cursor = 0;
  if (prevName) {
    const idx = filtered.findIndex((e) => e.name === prevName);
    cursor = idx >= 0 ? idx : Math.min(prevCursor, Math.max(0, filtered.length - 1));
  }
  return { cursor, marked };
}

// ─── selectors → component props ─────────────────────────────────────

export function selectBreadcrumb(s: FileManagerState): BreadcrumbProps {
  if (s.search.active) {
    return { search: true, text: `SEARCH // ${s.search.text}\u2588` };
  }
  let display = s.cwd;
  if (s.homeDir !== '/' && display.startsWith(s.homeDir)) {
    display = '~' + display.slice(s.homeDir.length);
  }
  return { search: false, text: display };
}

/** `null` while a confirm prompt owns the status bar. */
export function selectStatus(s: FileManagerState): StatusBarProps | null {
  if (s.confirmAction) return null;

  if (s.prompt) {
    return { text: `${s.prompt.label} ${s.prompt.value}\u2588`, tone: 'prompt' };
  }

  if (s.search.active) {
    let text = `${s.search.results.length} matches`;
    if (s.search.capped) text += ' (capped)';
    text += ` \u2502 ${s.search.pool.length} files indexed`;
    return { text, tone: 'filter' };
  }

  if (s.filterMode) {
    return { text: `/${s.filterText}\u2588  (${s.filtered.length} matches)`, tone: 'filter' };
  }

  const parts: string[] = [];
  parts.push(`${s.filtered.length} items`);
  if (s.marked.size > 0) parts.push(`${s.marked.size} marked`);
  if (s.tracked.size > 0) parts.push(`${s.tracked.size} tracked`);

  const sortArrow = s.sortOrder === 'asc' ? '\u2191' : '\u2193';
  parts.push(`sort: ${s.sortField} ${sortArrow}`);

  if (s.clipboard) {
    const icon = s.clipboard.op === 'copy' ? '\u2398' : '\u2702';
    parts.push(`${icon} ${s.clipboard.paths.length}`);
  }

  if (s.showHidden) parts.push('hidden: on');

  // Current entry info
  const entry = currentEntry(s);
  if (entry) {
    parts.push(entry.permissions);
    if (!entry.is_dir) parts.push(formatSize(entry.size));
  }

  return { text: parts.join(' \u2502 '), tone: 'normal' };
}

/**
 * `position` is the animated (fractional) top row; it defaults to the logical
 * `scrollOffset`. The window is overscanned and `shiftPx` aligns it.
 */
export function selectFileList(s: FileManagerState, position: number = s.scrollOffset): FileListProps {
  if (s.filtered.length === 0) {
    return { rows: [], empty: s.filterText ? 'No matches' : 'Empty directory' };
  }
  const recency = recencyByPath(s.filtered);
  const [start, end] = overscanRange(position, s.visibleRows, s.filtered.length);
  const rows = [];
  for (let i = start; i < end; i++) {
    const entry = s.filtered[i];
    rows.push({ entry, isCursor: i === s.cursor, marked: s.marked.has(entry.path), recency: recency.get(entry.path) });
  }
  return { rows, empty: null, shiftPx: (start - position) * s.cellHeight };
}

export function selectSearchList(s: FileManagerState, position: number = s.search.scrollOffset): SearchListProps {
  const { search } = s;
  if (search.results.length === 0) {
    return { rows: [], empty: search.text ? 'No matches' : 'Loading...' };
  }
  const query = search.text.toLowerCase();
  const [start, end] = overscanRange(position, s.visibleRows, search.results.length);
  const rows = [];
  for (let i = start; i < end; i++) {
    rows.push({ relPath: search.results[i], query, isCursor: i === search.cursor });
  }
  return { rows, empty: null, shiftPx: (start - position) * s.cellHeight };
}

export function aiContext(s: FileManagerState): FileManagerContext {
  const toCtx = (e: FileEntry): FileContextEntry => ({ name: e.name, path: e.path, is_dir: e.is_dir, size: e.size });
  const cursorEntry = currentEntry(s) ?? null;
  const markedFiles: FileContextEntry[] = [];
  for (const entry of s.filtered) {
    if (s.marked.has(entry.path)) markedFiles.push(toCtx(entry));
  }
  return {
    cwd: s.cwd,
    cursorFile: cursorEntry ? toCtx(cursorEntry) : null,
    markedFiles,
    totalEntries: s.filtered.length,
  };
}
