// Spec 302 §2.5 — `DiffBlock`.
//
// The three diff renderers the harness ships, behind one component:
//
//   - `paired`  — the side-by-side gutter preview built by `diff-render.ts:17-102`
//     and mounted by `harness-tool-render.ts:608-623` /
//     `harness-transcript-render.ts:924-925`. It is the only mode that windows
//     its rows: `context` lines around every change, then a `lineCap` with a
//     "… N more lines" tail.
//   - `unified` — the `git diff` output renderer (`harness-tool-render.ts:931-953`).
//   - `raw`     — the directive upsert approval card's `<pre>`
//     (`harness-transcript-render.ts:397-415`), which prints the unified text
//     verbatim, sign included.
//
// `diff-render.ts` already parameterised its row builder by class prefix — the
// one existing reuse precedent in the repo (spec 301 §Prior Art). `prefix` is
// therefore a prop here too, and the component owns no block.
//
// MARK INCONSISTENCY (spec 302 §2.5, deliberately NOT resolved here): paired
// deletions are marked with `−` U+2212 and unified deletions with ASCII `-`.
// Both are reproduced exactly as they render today; unifying them changes
// rendered text and is the integrator's call.

import { diffLines } from 'diff';

import { Component } from '../../../ui/component';
import { classes, el, setChildren } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export type DiffMode = 'paired' | 'unified' | 'raw';

/**
 * `file` is the `diff --git` header row of a unified diff; `meta` its
 * `+++`/`---`/`index ` lines. Paired diffs only ever carry `add`/`del`/`ctx` —
 * their `hunk` rows are the gap markers this component synthesises while
 * windowing.
 */
export type DiffRowKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta' | 'file';

export interface DiffRow {
  readonly kind: DiffRowKind;
  /** Already stripped of its sign in `unified`; verbatim in `raw`. */
  readonly text: string;
  /** Paired gutters. `null` when the row does not exist on that side. */
  readonly oldLine?: number | null;
  readonly newLine?: number | null;
}

export interface DiffBlockProps {
  readonly mode: DiffMode;
  readonly rows: readonly DiffRow[];
  /** Paired only — the `${prefix}__tool-diff-path` header. */
  readonly path?: string;
  /** Paired only — context lines kept around each change. Default 2. */
  readonly context?: number;
  /** Paired only — rows emitted before the "… N more lines" tail. Default 24. */
  readonly lineCap?: number;
  /** BEM prefix, `acp-harness` at every call site today. */
  readonly prefix: string;
}

/** `diff-render.ts:3-4` — the window the paired preview has always used. */
const DEFAULT_CONTEXT = 2;
const DEFAULT_LINE_CAP = 24;

const PAIRED_MARK: Readonly<Record<DiffRowKind, string>> = {
  add: '+',
  del: '\u2212',
  ctx: ' ',
  hunk: '⋯',
  meta: ' ',
  file: ' ',
};

/** `gitDiffLineTone()` spells the context tone `context`, not `ctx`. */
const UNIFIED_TONE: Readonly<Record<DiffRowKind, string>> = {
  add: 'add',
  del: 'del',
  ctx: 'context',
  hunk: 'hunk',
  meta: 'meta',
  file: 'file',
};

const UNIFIED_MARK: Readonly<Record<DiffRowKind, string>> = {
  add: '+',
  del: '-',
  ctx: '',
  hunk: '@@',
  meta: '·',
  file: '',
};

const RAW_TONE: Readonly<Record<DiffRowKind, string>> = {
  add: 'add',
  del: 'del',
  ctx: 'ctx',
  hunk: 'ctx',
  meta: 'ctx',
  file: 'ctx',
};

export class DiffBlock extends Component<DiffBlockProps> {
  private pathEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;

  /**
   * The root tag is mode-dependent (`<pre>` for `raw`, whose monospace comes
   * from the UA sheet, not from `.acp-harness__directive-diff`), and a
   * component may not swap its own node — so the mode is fixed at
   * construction. Every call site renders exactly one mode.
   */
  constructor(mode: DiffMode) {
    super(el(mode === 'raw' ? 'pre' : 'div'));
  }

  protected readDeps(next: DiffBlockProps): readonly unknown[] {
    return [next.mode, next.prefix, next.rows, next.path, next.context, next.lineCap];
  }

  protected syncClasses(next: DiffBlockProps): void {
    const prefix = next.prefix;
    if (next.mode === 'paired') this.el.className = `${prefix}__tool-diff`;
    else if (next.mode === 'unified') {
      this.el.className = classes(`${prefix}__tool-rich`, `${prefix}__tool-rich--unidiff`);
    } else this.el.className = `${prefix}__directive-diff`;
  }

  protected paint(next: DiffBlockProps): void {
    this.syncClasses(next);
    if (next.mode === 'paired') this.paintPaired(next);
    else if (next.mode === 'unified') this.paintUnified(next);
    else this.paintRaw(next);
  }

  /** `diff-render.ts:40-78` — keep window, gap markers, cap, "more lines" tail. */
  private paintPaired(next: DiffBlockProps): void {
    const prefix = next.prefix;
    const context = next.context ?? DEFAULT_CONTEXT;
    const lineCap = next.lineCap ?? DEFAULT_LINE_CAP;
    const rows = next.rows;

    const keep = new Array<boolean>(rows.length).fill(false);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].kind === 'ctx') continue;
      const from = Math.max(0, i - context);
      const to = Math.min(rows.length - 1, i + context);
      for (let j = from; j <= to; j++) keep[j] = true;
    }

    const nodes: HTMLElement[] = [];
    let emitted = 0;
    let truncated = false;
    let inGap = false;
    let firstHunk = true;
    for (let i = 0; i < rows.length; i++) {
      if (!keep[i]) {
        inGap = true;
        continue;
      }
      if (inGap && !firstHunk) nodes.push(pairedRow(GAP_ROW, prefix));
      inGap = false;
      firstHunk = false;
      if (emitted >= lineCap) {
        truncated = true;
        break;
      }
      nodes.push(pairedRow(rows[i], prefix));
      emitted++;
    }

    if (nodes.length === 0) {
      nodes.push(el('div', { class: `${prefix}__tool-meta`, text: 'no textual changes' }));
    }

    let keptCount = 0;
    for (const kept of keep) if (kept) keptCount++;
    const moreLines = keptCount - emitted;
    if (truncated && moreLines > 0) {
      nodes.push(
        el('div', {
          class: `${prefix}__tool-more`,
          text: `… ${moreLines} more line${moreLines === 1 ? '' : 's'}`,
        }),
      );
    }

    const body = this.ensureBody(classes(`${prefix}__tool-body`, `${prefix}__tool-body--diff`));
    setChildren(body, nodes);
    this.el.replaceChildren(...this.framePaired(next.path, prefix, body));
  }

  /** The `${prefix}__tool-diff-path` header is kept only while `path` is set. */
  private framePaired(path: string | undefined, prefix: string, body: HTMLElement): HTMLElement[] {
    if (path === undefined) {
      this.pathEl = null;
      return [body];
    }
    const pathEl = this.pathEl ?? el('div');
    pathEl.className = `${prefix}__tool-diff-path`;
    pathEl.textContent = path;
    this.pathEl = pathEl;
    return [pathEl, body];
  }

  private ensureBody(className: string): HTMLElement {
    const body = this.bodyEl ?? el('div');
    body.className = className;
    this.bodyEl = body;
    return body;
  }

  /** `harness-tool-render.ts:931-953`. */
  private paintUnified(next: DiffBlockProps): void {
    const prefix = next.prefix;
    const nodes = next.rows.map((row) =>
      row.kind === 'file'
        ? el('div', {
            class: classes(`${prefix}__tool-diff-file`, `${prefix}__tok-path`),
            text: row.text,
          })
        : el(
            'div',
            { class: classes(`${prefix}__tool-diff-line`, `${prefix}__tool-diff-line--${UNIFIED_TONE[row.kind]}`) },
            el('span', { class: `${prefix}__tool-diff-mark`, text: UNIFIED_MARK[row.kind] }),
            el('span', { class: `${prefix}__tool-diff-text`, text: row.text }),
          ),
    );
    setChildren(this.el, nodes);
  }

  /** `harness-transcript-render.ts:401-415`. */
  private paintRaw(next: DiffBlockProps): void {
    const prefix = next.prefix;
    const nodes = next.rows.map((row) =>
      el('div', { class: `${prefix}__directive-diff-${RAW_TONE[row.kind]}`, text: row.text }),
    );
    setChildren(this.el, nodes);
  }
}

function pairedRow(row: DiffRow, prefix: string): HTMLElement {
  return el(
    'div',
    { class: classes(`${prefix}__diff-line`, `${prefix}__diff-line--${row.kind}`) },
    el('span', { class: `${prefix}__diff-num`, text: row.oldLine == null ? '' : String(row.oldLine) }),
    el('span', { class: `${prefix}__diff-num`, text: row.newLine == null ? '' : String(row.newLine) }),
    el('span', { class: `${prefix}__diff-mark`, text: PAIRED_MARK[row.kind] }),
    el('span', { class: `${prefix}__diff-text`, text: row.text }),
  );
}

/** The gap marker a windowed paired diff emits between hunks
 *  (`diff-render.ts:81-90`): a hunk row with both gutters empty. */
const GAP_ROW: DiffRow = { kind: 'hunk', text: 'context omitted' };

/** Line rows for `mode: 'paired'` — `diff-render.ts:18-38`, which keeps this
 *  row builder private. */
export function pairedDiffRows(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffLines(oldText, newText)) {
    const kind: DiffRowKind = part.added === true ? 'add' : part.removed === true ? 'del' : 'ctx';
    const value = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value;
    for (const text of value.split('\n')) {
      if (kind === 'add') {
        rows.push({ kind, text, oldLine: null, newLine });
        newLine++;
      } else if (kind === 'del') {
        rows.push({ kind, text, oldLine, newLine: null });
        oldLine++;
      } else {
        rows.push({ kind, text, oldLine, newLine });
        oldLine++;
        newLine++;
      }
    }
  }
  return rows;
}

/** Line rows for `mode: 'unified'` — the classification of
 *  `gitDiffFileLabel/Tone/Text` (`harness-tool-render.ts:957-986`), which the
 *  cutover deletes along with `renderUnifiedGitDiff`. */
export function unifiedDiffRows(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    if (line.startsWith('diff --git ')) {
      rows.push({ kind: 'file', text: gitDiffFileLabel(line) });
    } else if (line.startsWith('@@')) {
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      rows.push({ kind: 'meta', text: line.slice(4) });
    } else if (line.startsWith('index ')) {
      rows.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1) });
    } else {
      rows.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return rows;
}

function gitDiffFileLabel(line: string): string {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return line.replace(/^diff --git\s+/, '');
  const oldPath = match[1] ?? '';
  const newPath = match[2] ?? '';
  return oldPath === newPath ? newPath : `${oldPath} -> ${newPath}`;
}

/** Line rows for `mode: 'raw'` — `harness-transcript-render.ts:403-412`. The
 *  sign stays in the text, and empty lines are rows too. */
export function rawDiffRows(unified: string): DiffRow[] {
  return unified.split('\n').map((line) => {
    const sign = line.charAt(0);
    const kind: DiffRowKind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
    return { kind, text: line };
  });
}

export const def: ComponentDef = { id: 'diff-block', blocks: [] };
