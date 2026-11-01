// Krypton — the unified-diff model behind a native output card (spec 351).
//
// diff2html's parser supplies files, hunks and line numbers; this module turns
// them into the rows the card paints: one line-number column (old for a
// deletion, new otherwise), a gap row between hunks, and word-level marks on
// deletion/insertion pairs. Pure: no DOM, no highlighting.

import { diffWordsWithSpace } from 'diff';
import { parse } from 'diff2html';
import type { DiffBlock, DiffFile } from 'diff2html/lib/types';

import { extToLang, isMarkdownFile } from '../file-preview';

export type NativeDiffRowKind = 'ctx' | 'add' | 'del' | 'gap';

/** A changed character range `[from, to)` inside a row's text. */
export type DiffMark = readonly [number, number];

export interface NativeDiffRow {
  readonly kind: NativeDiffRowKind;
  /** Old line for `del`, new line for `add`/`ctx`, null for `gap`. */
  readonly line: number | null;
  /** Sign stripped. A `gap` row holds the hunk header's context text. */
  readonly text: string;
  readonly marks: readonly DiffMark[];
}

export type NativeDiffStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';

export interface NativeDiffFile {
  readonly status: NativeDiffStatus;
  readonly path: string;
  /** The pre-rename path; null unless renamed. */
  readonly oldPath: string | null;
  readonly added: number;
  readonly deleted: number;
  /** highlight.js language id, or null for plain text. */
  readonly language: string | null;
  readonly rows: readonly NativeDiffRow[];
}

/** Larger diffs stay raw: the card is painted in one synchronous pass. */
export const NATIVE_DIFF_MAX_CHARS = 2 * 1024 * 1024;
export const NATIVE_DIFF_MAX_LINES = 5_000;

/** Word marks are skipped on longer lines and on mostly-rewritten pairs. */
const MARK_MAX_CHARS = 500;
const MARK_MIN_COMMON = 0.25;

/** The first non-blank line opens a git diff, or a `---`/`+++` pair opens `diff -u`. */
export function looksLikeUnifiedDiff(lines: readonly string[]): boolean {
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first < 0) return false;
  const head = lines[first];
  if (head.startsWith('diff --git ')) return true;
  return head.startsWith('--- ') && (lines[first + 1] ?? '').startsWith('+++ ');
}

/** null when the text is not a unified diff, has no file, is combined (merge), or is too large. */
export function parseNativeDiff(text: string): NativeDiffFile[] | null {
  if (text.length > NATIVE_DIFF_MAX_CHARS) return null;
  const lines = text.split('\n');
  if (lines.length > NATIVE_DIFF_MAX_LINES || !looksLikeUnifiedDiff(lines)) return null;
  const files = parse(restoreBlankContext(lines).join('\n'));
  if (files.length === 0 || files.some((file) => file.isCombined)) return null;
  return files.map(nativeFile);
}

/**
 * Terminal rows come back with trailing blanks trimmed, so an empty context
 * line (` `) reads as ``, which diff2html skips — and every later line number
 * in the hunk drifts. Count each hunk's lines from its `@@` header and put
 * the space back. A no-op on git's own output.
 */
function restoreBlankContext(lines: readonly string[]): string[] {
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((line) => {
    if (oldLeft > 0 || newLeft > 0) {
      const sign = line === '' ? ' ' : line[0];
      if (sign === ' ') {
        oldLeft--;
        newLeft--;
      } else if (sign === '-') {
        oldLeft--;
      } else if (sign === '+') {
        newLeft--;
      } else if (sign !== '\\') {
        oldLeft = 0;
        newLeft = 0;
        return line;
      }
      return line === '' ? ' ' : line;
    }
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLeft = header[2] === undefined ? 1 : Number(header[2]);
    }
    return line;
  });
}

/** Cheap pre-filter for the re-run IPC; Rust decides what may actually run. */
export function isGitDiffCmdline(cmdline: string): boolean {
  return /^\s*git(\s+--no-pager)?\s+diff(\s|$)/.test(cmdline);
}

function nativeFile(file: DiffFile): NativeDiffFile {
  const deleted = file.isDeleted === true || file.newName === '/dev/null';
  const path = deleted ? file.oldName : file.newName;
  const renamed = file.isRename === true || file.isCopy === true;
  const status: NativeDiffStatus = file.isBinary
    ? 'binary'
    : file.isNew
      ? 'added'
      : deleted
        ? 'deleted'
        : renamed
          ? 'renamed'
          : 'modified';
  const rows: NativeDiffRow[] = [];
  const hunks = file.blocks.filter((block) => block.lines.length > 0);
  hunks.forEach((block, index) => {
    if (index > 0) rows.push({ kind: 'gap', line: null, text: hunkContext(block.header), marks: [] });
    pushHunkRows(block, rows);
  });
  return {
    status,
    path,
    oldPath: renamed ? file.oldName : null,
    added: file.addedLines,
    deleted: file.deletedLines,
    language: extToLang(path) ?? (isMarkdownFile(path) ? 'markdown' : null),
    rows,
  };
}

/** `@@ -5017,7 +5017,7 @@ export class Compositor` → `export class Compositor`. */
function hunkContext(header: string): string {
  return /^@@[^@]*@@\s?(.*)$/.exec(header)?.[1]?.trim() ?? '';
}

function pushHunkRows(block: DiffBlock, rows: NativeDiffRow[]): void {
  const lines = block.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'context') {
      rows.push({ kind: 'ctx', line: line.newNumber, text: line.content.slice(1), marks: [] });
      i++;
      continue;
    }
    // A run of deletions, then the insertions that replace them.
    const dels: string[] = [];
    const delNums: number[] = [];
    while (i < lines.length && lines[i].type === 'delete') {
      delNums.push(lines[i].oldNumber ?? 0);
      dels.push(lines[i].content.slice(1));
      i++;
    }
    const adds: string[] = [];
    const addNums: number[] = [];
    while (i < lines.length && lines[i].type === 'insert') {
      addNums.push(lines[i].newNumber ?? 0);
      adds.push(lines[i].content.slice(1));
      i++;
    }
    // Pair line-for-line only when the run is a straight replacement.
    const paired = dels.length === adds.length;
    const delMarks: DiffMark[][] = [];
    const addMarks: DiffMark[][] = [];
    for (let k = 0; k < dels.length; k++) {
      const marks = paired ? wordMarks(dels[k], adds[k]) : null;
      delMarks.push(marks?.del ?? []);
      addMarks.push(marks?.add ?? []);
    }
    dels.forEach((text, k) => rows.push({ kind: 'del', line: delNums[k], text, marks: delMarks[k] }));
    adds.forEach((text, k) => rows.push({ kind: 'add', line: addNums[k], text, marks: addMarks[k] ?? [] }));
  }
}

/** Changed ranges of one deletion/insertion pair; null when not worth marking. */
export function wordMarks(before: string, after: string): { del: DiffMark[]; add: DiffMark[] } | null {
  if (before.length > MARK_MAX_CHARS || after.length > MARK_MAX_CHARS) return null;
  const changes = diffWordsWithSpace(before, after);
  const del: DiffMark[] = [];
  const add: DiffMark[] = [];
  let common = 0;
  let delAt = 0;
  let addAt = 0;
  for (const change of changes) {
    const length = change.value.length;
    if (change.removed) {
      del.push([delAt, delAt + length]);
      delAt += length;
    } else if (change.added) {
      add.push([addAt, addAt + length]);
      addAt += length;
    } else {
      common += length;
      delAt += length;
      addAt += length;
    }
  }
  // Nothing in common worth anchoring on: the whole row is the change.
  if (common < MARK_MIN_COMMON * Math.max(before.length, after.length)) return null;
  return { del, add };
}
