// @vitest-environment happy-dom
import * as smd from 'streaming-markdown';
import { describe, expect, it } from 'vitest';

import { CELL_GRID_CLASS, cellGridStylesheet, gridifyCodeBlocks } from './cell-grid';
import { makeSafeRenderer, md } from './harness-markdown';
import type { HarnessTranscriptItem } from './harness-view-types';
import { applyTranscriptAnnotations } from './transcript-annotation';

const CELL = `${CELL_GRID_CLASS}__cell`;

// Every row but the first is 12 cells, counted the way agents pad diagrams
// (wcswidth): `ที่`/`นี่` are one cell each, `日`/`本` two, and `กำ`/`ทำ` two —
// one grapheme each (U+0E33 SARA AM is a SpacingMark), two code points wide.
const DIAGRAM = [
  'FOLLOW-UP',
  '╭──────────╮',
  '│ ▶ run ci │',
  '│ ที่นี่ 日本  │',
  '│ กำลังทำ   │',
  '╰──────────╯',
].join('\n');
const FENCE = '```\n' + DIAGRAM + '\n```\n';

// An all-ASCII frame around Thai text, padded to 16 cells per row like the
// agent replies that prompted it: no box character, so only the padding
// after non-ASCII text says the block is laid out by columns.
const FRAME = ['+--------------+', '| ชื่อ   : สมชาย |', '| สถานะ : รอ   |', '+--------------+'].join('\n');
const FRAME_FENCE = '```\n' + FRAME + '\n```\n';

function stream(chunks: readonly string[]): HTMLElement {
  const body = document.createElement('div');
  const parser = smd.parser(makeSafeRenderer(body, { cellGrid: true }));
  for (const chunk of chunks) smd.parser_write(parser, chunk);
  smd.parser_end(parser);
  return body;
}

function codeOf(root: ParentNode): HTMLElement {
  return root.querySelector<HTMLElement>('pre > code')!;
}

function cols(cell: HTMLElement): number {
  return Number(cell.style.getPropertyValue('--acp-cg-n') || 1);
}

/** Per source line, the cells it holds and the cell columns they add up to. */
function lines(code: HTMLElement): Array<{ cells: Array<[string, string, number]>; width: number }> {
  const out = [{ cells: [] as Array<[string, string, number]>, width: 0 }];
  const walk = (node: Node): void => {
    if (node instanceof HTMLElement && node.classList.contains(CELL)) {
      const kind = [...node.classList].find((c) => /--(run|glyph|box|tab)$/.test(c))!.split('--')[1];
      out[out.length - 1].cells.push([node.textContent ?? '', kind, cols(node)]);
      out[out.length - 1].width += cols(node);
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      for (let k = 1; k < (node.textContent ?? '').split('\n').length; k++) out.push({ cells: [], width: 0 });
      return;
    }
    node.childNodes.forEach(walk);
  };
  code.childNodes.forEach(walk);
  return out.filter((line) => line.cells.length > 0);
}

function chunked(text: string, seed: number): string[] {
  let state = seed;
  const next = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; ) {
    const n = 1 + Math.floor(next() * 7);
    out.push(cps.slice(i, i + n).join(''));
    i += n;
  }
  return out;
}

describe('cell grid', () => {
  it('leaves code that is not laid out by columns as plain text', () => {
    // Non-ASCII without padding after it, and Thai only at a line's end.
    const body = stream(['```\nnpm test ▶ 日本\nconst x = 1;  // ตั้งค่า\nprint("สวัสดี")\n```\n']);
    const code = codeOf(body);
    expect(code.classList.contains(CELL_GRID_CLASS)).toBe(false);
    expect(code.querySelector('span')).toBeNull();
    expect(gridifyCodeBlocks(body)).toBe(0);
  });

  it('grids an ASCII frame whose padding follows Thai text', () => {
    const code = codeOf(stream([FRAME_FENCE]));
    expect(code.classList.contains(CELL_GRID_CLASS)).toBe(true);
    expect(code.textContent?.replace(/\n$/, '')).toBe(FRAME);
    expect(lines(code).map((row) => row.width)).toEqual([16, 16, 16, 16]);
    const reference = code.outerHTML;
    // The trigger only shows on the second line, and here only once its padding is complete.
    for (let seed = 1; seed <= 30; seed++) {
      expect(codeOf(stream(chunked(FRAME_FENCE, seed))).outerHTML, `seed ${seed}`).toBe(reference);
    }
  });

  it('lays a diagram out on cells while keeping the source text', () => {
    const code = codeOf(stream([FENCE]));
    expect(code.classList.contains(CELL_GRID_CLASS)).toBe(true);
    expect(code.textContent?.replace(/\n$/, '')).toBe(DIAGRAM);
    const rows = lines(code);
    expect(rows.map((row) => row.width)).toEqual([9, 12, 12, 12, 12, 12]);
    // A horizontal border is one merged cell; corners and walls are their own.
    expect(rows[1].cells).toEqual([['╭', 'box', 1], ['──────────', 'box', 10], ['╮', 'box', 1]]);
    expect(rows[2].cells).toEqual([['│', 'box', 1], [' ', 'run', 1], ['▶', 'glyph', 1], [' run ci ', 'run', 8], ['│', 'box', 1]]);
    expect(rows[3].cells).toEqual([
      ['│', 'box', 1], [' ', 'run', 1], ['ที่', 'glyph', 1], ['นี่', 'glyph', 1], [' ', 'run', 1],
      ['日', 'glyph', 2], ['本', 'glyph', 2], ['  ', 'run', 2], ['│', 'box', 1],
    ]);
    expect(rows[4].cells).toEqual([
      ['│', 'box', 1], [' ', 'run', 1], ['กำ', 'glyph', 2], ['ลั', 'glyph', 1], ['ง', 'glyph', 1],
      ['ทำ', 'glyph', 2], ['   ', 'run', 3], ['│', 'box', 1],
    ]);
  });

  it('builds the same grid whatever the stream chunking', () => {
    const reference = codeOf(stream([FENCE])).outerHTML;
    // Cuts before the first box character, between a Thai base and its marks, and before SARA AM.
    const cuts = [
      '```\nFOLLOW', '-UP\n╭───', '───────╮\n│ ▶ run ci │\n│ ที', '่', 'นี', '่ 日本  │\n│ ก', 'ำลังท', 'ำ   │\n╰──────────╯\n```\n',
    ];
    expect(cuts.join('')).toBe(FENCE);
    expect(codeOf(stream(cuts)).outerHTML).toBe(reference);
    for (let seed = 1; seed <= 30; seed++) {
      expect(codeOf(stream(chunked(FENCE, seed))).outerHTML, `seed ${seed}`).toBe(reference);
    }
  });

  it('keeps a combining mark in its base letter\'s text node', () => {
    const code = codeOf(stream(['```\n│ ที', '่ │\n```\n']));
    const cell = [...code.querySelectorAll<HTMLElement>(`.${CELL}--glyph`)].find((c) => c.textContent === 'ที่')!;
    expect(cell.childNodes).toHaveLength(1);
  });

  it('grids a highlighted marked block inside its highlight spans, once', () => {
    const host = document.createElement('div');
    host.innerHTML = md.parse(FENCE, { async: false }) as string;
    const code = codeOf(host);
    const text = code.textContent;
    expect(gridifyCodeBlocks(host)).toBe(1);
    expect(code.textContent).toBe(text);
    expect(lines(code).map((row) => row.width)).toEqual([9, 12, 12, 12, 12, 12]);
    const html = host.innerHTML;
    expect(gridifyCodeBlocks(host)).toBe(0);
    expect(host.innerHTML).toBe(html);
  });

  it('has drawing geometry for every box-drawing and block-element code point', () => {
    const css = cellGridStylesheet();
    const undrawn: string[] = [];
    for (let cp = 0x2500; cp <= 0x259f; cp++) {
      const cls = `${CELL}--u${cp.toString(16)}`;
      const drawn = new RegExp(`\\.${cls}::(before \\{ background: [^;]*gradient|after \\{[^}]*border-[a-z]+-width: 1px)`);
      if (!drawn.test(css)) undrawn.push(String.fromCodePoint(cp));
    }
    expect(undrawn).toEqual([]);
  });

  it('marks an annotation that crosses cells without splitting a cell', () => {
    const body = stream([FENCE]);
    const code = codeOf(body);
    const before = [...code.querySelectorAll<HTMLElement>(`.${CELL}`)].map((cell) => [cell.textContent, cols(cell)]);
    const item: HarnessTranscriptItem = {
      id: 'a1',
      kind: 'assistant',
      text: DIAGRAM,
      annotations: [{ id: 'n1', itemId: 'a1', quote: '▶ run', quoteIndex: 0, body: 'why', status: 'unsent', createdAt: 0 }],
    };
    applyTranscriptAnnotations(body, item);
    expect(item.annotations![0].drifted).toBe(false);
    const marks = [...code.querySelectorAll('mark')];
    expect(marks.map((mark) => mark.textContent).join('')).toBe('▶ run');
    expect(marks.every((mark) => mark.parentElement?.classList.contains(CELL))).toBe(true);
    expect([...code.querySelectorAll<HTMLElement>(`.${CELL}`)].map((cell) => [cell.textContent, cols(cell)])).toEqual(before);
  });
});
