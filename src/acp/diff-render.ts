import { diffLines } from 'diff';

export interface DiffRenderOptions {
  context?: number;
  lineCap?: number;
  cssPrefix?: string;
}

const DEFAULT_CONTEXT = 2;
const DEFAULT_LINE_CAP = 24;
const DEFAULT_PREFIX = 'acp-view';

type Row = { kind: 'add' | 'del' | 'ctx'; text: string; oldLine: number | null; newLine: number | null };

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

export function countDiff(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

export function renderDiffPreview(oldText: string, newText: string, options: DiffRenderOptions = {}): string {
  const CONTEXT = options.context ?? DEFAULT_CONTEXT;
  const LINE_CAP = options.lineCap ?? DEFAULT_LINE_CAP;
  const prefix = options.cssPrefix ?? DEFAULT_PREFIX;

  const parts = diffLines(oldText, newText);
  const rows: Row[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const p of parts) {
    const lines = stripTrailingNewline(p.value).split('\n');
    const kind: Row['kind'] = p.added ? 'add' : p.removed ? 'del' : 'ctx';
    for (const text of lines) {
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

  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== 'ctx') {
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) keep[j] = true;
    }
  }

  const html: string[] = [];
  let emitted = 0;
  let truncated = false;
  let inGap = false;
  let firstHunk = true;
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) {
      inGap = true;
      continue;
    }
    if (inGap && !firstHunk) html.push(renderDiffGap(prefix));
    inGap = false;
    firstHunk = false;
    if (emitted >= LINE_CAP) {
      truncated = true;
      break;
    }
    html.push(renderDiffRow(rows[i], prefix));
    emitted++;
  }

  if (html.length === 0) {
    html.push(`<div class="${prefix}__tool-meta">no textual changes</div>`);
  }

  let keptCount = 0;
  for (let i = 0; i < keep.length; i++) if (keep[i]) keptCount++;
  const moreLines = keptCount - emitted;
  if (truncated && moreLines > 0) {
    html.push(`<div class="${prefix}__tool-more">… ${moreLines} more line${moreLines === 1 ? '' : 's'}</div>`);
  }
  return `<div class="${prefix}__tool-body ${prefix}__tool-body--diff">${html.join('')}</div>`;
}

function renderDiffGap(prefix: string): string {
  return (
    `<div class="${prefix}__diff-line ${prefix}__diff-line--hunk">` +
      `<span class="${prefix}__diff-num"></span>` +
      `<span class="${prefix}__diff-num"></span>` +
      `<span class="${prefix}__diff-mark">⋯</span>` +
      `<span class="${prefix}__diff-text">context omitted</span>` +
    `</div>`
  );
}

function renderDiffRow(row: Row, prefix: string): string {
  const mark = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  return (
    `<div class="${prefix}__diff-line ${prefix}__diff-line--${row.kind}">` +
      `<span class="${prefix}__diff-num">${row.oldLine ?? ''}</span>` +
      `<span class="${prefix}__diff-num">${row.newLine ?? ''}</span>` +
      `<span class="${prefix}__diff-mark">${mark}</span>` +
      `<span class="${prefix}__diff-text">${escHtml(row.text)}</span>` +
    `</div>`
  );
}
