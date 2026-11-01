// Krypton — native card body for a unified diff (spec 351): one line-number
// column (old for a deletion, new otherwise), syntax colour, word marks.

import hljs from 'highlight.js';

import { el } from '../ui/dom';
import type { DiffMark, NativeDiffFile, NativeDiffRow, NativeDiffRowKind } from './git-diff';

const SIGN: Readonly<Record<NativeDiffRowKind, string>> = { ctx: '', add: '+', del: '-', gap: '' };

export function renderDiff(files: readonly NativeDiffFile[]): HTMLElement {
  return el(
    'div',
    { class: 'krypton-native-diff', style: { '--krypton-native-gutter': `${gutterDigits(files)}ch` } },
    ...files.map(renderFile),
  );
}

function gutterDigits(files: readonly NativeDiffFile[]): number {
  let max = 0;
  for (const file of files) for (const row of file.rows) if (row.line !== null && row.line > max) max = row.line;
  return Math.max(3, String(max).length);
}

function renderFile(file: NativeDiffFile): HTMLElement {
  const language = file.language !== null && hljs.getLanguage(file.language) ? file.language : null;
  const head = el(
    'div',
    { class: 'krypton-native-diff__head' },
    el('span', { class: ['krypton-native-diff__status', `krypton-native-diff__status--${file.status}`], text: file.status }),
    el('span', { class: 'krypton-native-diff__path', text: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path }),
    file.status !== 'binary' && el('span', { class: 'krypton-native-diff__added', text: `+${file.added}` }),
    file.status !== 'binary' && el('span', { class: 'krypton-native-diff__deleted', text: `-${file.deleted}` }),
  );
  return el('div', { class: 'krypton-native-diff__file' }, head, ...file.rows.map((row) => renderRow(row, language)));
}

function renderRow(row: NativeDiffRow, language: string | null): HTMLElement {
  const code = el('span', { class: 'krypton-native-diff__code' });
  if (row.kind === 'gap') {
    code.textContent = row.text ? `⋯ ${row.text}` : '⋯';
  } else if (language !== null) {
    // hljs escapes the text; offsets of its text nodes equal the source's.
    code.innerHTML = hljs.highlight(row.text, { language, ignoreIllegals: true }).value;
    if (row.marks.length > 0) markRanges(code, row.marks);
  } else {
    code.textContent = row.text;
    if (row.marks.length > 0) markRanges(code, row.marks);
  }
  return el(
    'div',
    { class: ['krypton-native-diff__row', `krypton-native-diff__row--${row.kind}`] },
    el('span', { class: 'krypton-native-diff__num', text: row.line === null ? '' : String(row.line) }),
    el('span', { class: 'krypton-native-diff__sign', text: SIGN[row.kind] }),
    code,
  );
}

/** Wrap each changed range in a mark span, splitting text nodes inside hljs spans. */
function markRanges(root: HTMLElement, marks: readonly DiffMark[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let offset = 0;
  for (const node of nodes) {
    const start = offset;
    const end = start + node.data.length;
    offset = end;
    const parent = node.parentNode;
    if (!parent) continue;
    let at = 0;
    const pieces: Node[] = [];
    for (const [from, to] of marks) {
      if (to <= start || from >= end) continue;
      const a = Math.max(from, start) - start;
      const b = Math.min(to, end) - start;
      if (a > at) pieces.push(document.createTextNode(node.data.slice(at, a)));
      pieces.push(el('span', { class: 'krypton-native-diff__mark', text: node.data.slice(a, b) }));
      at = b;
    }
    if (pieces.length === 0) continue;
    if (at < node.data.length) pieces.push(document.createTextNode(node.data.slice(at)));
    for (const piece of pieces) parent.insertBefore(piece, node);
    parent.removeChild(node);
  }
}
