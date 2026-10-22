import { describe, expect, it } from 'vitest';

import {
  DiffBlock,
  type DiffBlockProps,
  type DiffRow,
  pairedDiffRows,
  rawDiffRows,
  unifiedDiffRows,
} from './index';

const PREFIX = 'acp-harness';

const paint = (props: DiffBlockProps): DiffBlock => {
  const block = new DiffBlock(props.mode);
  block.update(props);
  return block;
};

describe('DiffBlock paired', () => {
  it('emits the four-column gutter row with the U+2212 deletion mark', () => {
    const rows: DiffRow[] = [
      { kind: 'ctx', text: 'const a = 1;', oldLine: 12, newLine: 12 },
      { kind: 'del', text: 'current.replaceWith(next);', oldLine: 13, newLine: null },
      { kind: 'add', text: 'current.replaceChildren(...next.childNodes);', oldLine: null, newLine: 13 },
    ];

    const block = paint({ mode: 'paired', rows, prefix: PREFIX });
    const body = block.el.firstElementChild;
    expect(block.el.className).toBe('acp-harness__tool-diff');
    expect(body?.getAttribute('class')).toBe('acp-harness__tool-body acp-harness__tool-body--diff');

    const lines = Array.from(body?.children ?? []);
    expect(lines.map((line) => line.getAttribute('class'))).toEqual([
      'acp-harness__diff-line acp-harness__diff-line--ctx',
      'acp-harness__diff-line acp-harness__diff-line--del',
      'acp-harness__diff-line acp-harness__diff-line--add',
    ]);
    expect(lines.map((line) => line.children[2].textContent)).toEqual([' ', '\u2212', '+']);
    expect(lines[1].outerHTML).toBe(
      '<div class="acp-harness__diff-line acp-harness__diff-line--del">' +
        '<span class="acp-harness__diff-num">13</span>' +
        '<span class="acp-harness__diff-num"></span>' +
        '<span class="acp-harness__diff-mark">\u2212</span>' +
        '<span class="acp-harness__diff-text">current.replaceWith(next);</span>' +
        '</div>',
    );
  });

  it('drops out-of-context rows and marks the gap with ⋯ context omitted', () => {
    const rows: DiffRow[] = [];
    for (let i = 1; i <= 20; i++) rows.push({ kind: 'ctx', text: `line ${i}`, oldLine: i, newLine: i });
    rows[2] = { kind: 'add', text: 'first change', oldLine: null, newLine: 3 };
    rows[15] = { kind: 'add', text: 'second change', oldLine: null, newLine: 16 };

    const block = paint({ mode: 'paired', rows, prefix: PREFIX });
    const body = block.el.firstElementChild;
    const kinds = Array.from(body?.children ?? []).map((line) => line.getAttribute('class'));

    // 2 context lines each side of both changes, one gap marker between them.
    expect(kinds.filter((cls) => cls?.endsWith('--hunk')).length).toBe(1);
    const gap = body?.querySelector('.acp-harness__diff-line--hunk');
    expect(gap?.children[0].textContent).toBe('');
    expect(gap?.children[1].textContent).toBe('');
    expect(gap?.children[2].textContent).toBe('⋯');
    expect(gap?.children[3].textContent).toBe('context omitted');
    expect(body?.textContent).not.toContain('line 9');
  });

  it('caps a 500-row diff at lineCap and tails it with the remaining count', () => {
    const rows: DiffRow[] = [];
    for (let i = 1; i <= 500; i++) rows.push({ kind: 'add', text: `added ${i}`, oldLine: null, newLine: i });

    const block = paint({ mode: 'paired', rows, prefix: PREFIX });
    const body = block.el.firstElementChild;
    const lines = body?.querySelectorAll('.acp-harness__diff-line') ?? [];
    expect(lines.length).toBe(24);
    expect(lines[23].textContent).toContain('added 24');

    const more = body?.lastElementChild;
    expect(more?.getAttribute('class')).toBe('acp-harness__tool-more');
    expect(more?.textContent).toBe('… 476 more lines');
  });

  it('honours an explicit lineCap and singularises the tail', () => {
    const rows: DiffRow[] = [
      { kind: 'add', text: 'one', oldLine: null, newLine: 1 },
      { kind: 'add', text: 'two', oldLine: null, newLine: 2 },
      { kind: 'add', text: 'three', oldLine: null, newLine: 3 },
    ];

    const block = paint({ mode: 'paired', rows, prefix: PREFIX, lineCap: 2 });
    expect(block.el.querySelectorAll('.acp-harness__diff-line').length).toBe(2);
    expect(block.el.querySelector('.acp-harness__tool-more')?.textContent).toBe('… 1 more line');
  });

  it('says so when a diff kept nothing', () => {
    const block = paint({ mode: 'paired', rows: [], prefix: PREFIX });
    const body = block.el.firstElementChild;
    expect(body?.firstElementChild?.getAttribute('class')).toBe('acp-harness__tool-meta');
    expect(body?.textContent).toBe('no textual changes');
  });

  it('keeps the path header above the body and removes it when the path goes away', () => {
    const rows: DiffRow[] = [{ kind: 'add', text: 'x', oldLine: null, newLine: 1 }];
    const block = new DiffBlock('paired');
    block.update({ mode: 'paired', rows, prefix: PREFIX, path: 'src/ui/list.ts' });

    const header = block.el.firstElementChild;
    expect(header?.outerHTML).toBe('<div class="acp-harness__tool-diff-path">src/ui/list.ts</div>');
    const body = block.el.lastElementChild;

    block.update({ mode: 'paired', rows: [...rows], prefix: PREFIX });
    expect(block.el.children.length).toBe(1);
    expect(block.el.firstElementChild).toBe(body);
  });

  it('reuses the body node across updates and skips the paint when nothing moved', () => {
    const rows: DiffRow[] = [{ kind: 'add', text: 'x', oldLine: null, newLine: 1 }];
    const props: DiffBlockProps = { mode: 'paired', rows, prefix: PREFIX };
    const block = paint(props);
    const body = block.el.firstElementChild;
    const line = body?.firstElementChild;

    block.update({ ...props });
    expect(block.el.firstElementChild?.firstElementChild).toBe(line);

    block.update({ ...props, rows: [{ kind: 'del', text: 'x', oldLine: 1, newLine: null }] });
    expect(block.el.firstElementChild).toBe(body);
    expect(block.el.firstElementChild?.firstElementChild).not.toBe(line);
  });

  it('builds its rows from two texts the way the preview always has', () => {
    const rows = pairedDiffRows('a\nb\n', 'a\nc\n');
    expect(rows).toEqual([
      { kind: 'ctx', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'b', oldLine: 2, newLine: null },
      { kind: 'add', text: 'c', oldLine: null, newLine: 2 },
    ]);
  });
});

describe('DiffBlock unified', () => {
  it('emits mark + text rows with the ASCII deletion mark and the context tone', () => {
    const rows = unifiedDiffRows(
      [
        'diff --git a/src/acp/lane-peek.ts b/src/acp/lane-peek.ts',
        'index 1111111..2222222 100644',
        '--- a/src/acp/lane-peek.ts',
        '+++ b/src/acp/lane-peek.ts',
        '@@ -412,6 +412,9 @@',
        ' export function patchPeekActiveTool() {',
        '-  return old;',
        '+  return next;',
      ].join('\n'),
    );

    const block = paint({ mode: 'unified', rows, prefix: PREFIX });
    expect(block.el.className).toBe('acp-harness__tool-rich acp-harness__tool-rich--unidiff');

    const children = Array.from(block.el.children);
    expect(children[0].outerHTML).toBe(
      '<div class="acp-harness__tool-diff-file acp-harness__tok-path">src/acp/lane-peek.ts</div>',
    );
    expect(children.slice(1).map((row) => row.getAttribute('class'))).toEqual([
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--meta',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--meta',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--meta',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--hunk',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--context',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--del',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--add',
    ]);
    expect(children.slice(1).map((row) => row.firstElementChild?.textContent)).toEqual([
      '·',
      '·',
      '·',
      '@@',
      '',
      '-',
      '+',
    ]);
    expect(children[6].outerHTML).toBe(
      '<div class="acp-harness__tool-diff-line acp-harness__tool-diff-line--del">' +
        '<span class="acp-harness__tool-diff-mark">-</span>' +
        '<span class="acp-harness__tool-diff-text">  return old;</span>' +
        '</div>',
    );
    expect(children[4].lastElementChild?.textContent).toBe('@@ -412,6 +412,9 @@');
  });

  it('labels a rename with both paths and keeps a plain path once', () => {
    const rows = unifiedDiffRows('diff --git a/old.ts b/new.ts\n+added\n');
    expect(rows[0]).toEqual({ kind: 'file', text: 'old.ts -> new.ts' });
  });
});

describe('DiffBlock raw', () => {
  it('prints the unified text verbatim, sign included, inside a pre', () => {
    const block = paint({
      mode: 'raw',
      rows: rawDiffRows('@@ context\n+ added line\n- removed line'),
      prefix: PREFIX,
    });

    expect(block.el.tagName).toBe('PRE');
    expect(block.el.className).toBe('acp-harness__directive-diff');
    expect(block.el.outerHTML).toBe(
      '<pre class="acp-harness__directive-diff">' +
        '<div class="acp-harness__directive-diff-ctx">@@ context</div>' +
        '<div class="acp-harness__directive-diff-add">+ added line</div>' +
        '<div class="acp-harness__directive-diff-del">- removed line</div>' +
        '</pre>',
    );
  });

  it('keeps blank lines as context rows, as the directive card does today', () => {
    const block = paint({ mode: 'raw', rows: rawDiffRows('+a\n\n+b'), prefix: PREFIX });
    expect(Array.from(block.el.children).map((row) => row.getAttribute('class'))).toEqual([
      'acp-harness__directive-diff-add',
      'acp-harness__directive-diff-ctx',
      'acp-harness__directive-diff-add',
    ]);
  });
});

describe('DiffBlock prefix', () => {
  it('re-derives every class from the prefix it was given', () => {
    const block = paint({
      mode: 'paired',
      rows: [{ kind: 'add', text: 'x', oldLine: null, newLine: 1 }],
      prefix: 'fs-review',
    });

    expect(block.el.className).toBe('fs-review__tool-diff');
    expect(block.el.querySelector('.fs-review__diff-line--add')).not.toBeNull();
    expect(block.el.querySelector('[class*="acp-harness"]')).toBeNull();
  });
});

describe('DiffBlock on the cell grid (spec 326)', () => {
  const diagram: DiffRow[] = [
    { kind: 'ctx', text: '╭──────╮', oldLine: 1, newLine: 1 },
    { kind: 'del', text: '│ เก่า  │', oldLine: 2, newLine: null },
    { kind: 'add', text: '│ ใหม่  │', oldLine: null, newLine: 2 },
    { kind: 'ctx', text: '╰──────╯', oldLine: 3, newLine: 3 },
  ];

  it('grids every paired text cell once the diff holds a diagram, and clears when it does not', () => {
    const block = new DiffBlock('paired');
    block.update({ mode: 'paired', rows: diagram, prefix: PREFIX });
    const body = block.el.querySelector<HTMLElement>('.acp-harness__tool-body--diff')!;
    expect(body.classList.contains('acp-cellgrid-lines')).toBe(true);
    const texts = Array.from(body.querySelectorAll<HTMLElement>('.acp-harness__diff-text'));
    expect(texts.every((text) => text.classList.contains('acp-cellgrid'))).toBe(true);
    expect(texts.map((text) => text.textContent)).toEqual(diagram.map((row) => row.text));

    block.update({ mode: 'paired', rows: [{ kind: 'add', text: 'const a = 1;', oldLine: null, newLine: 1 }], prefix: PREFIX });
    expect(body.classList.contains('acp-cellgrid-lines')).toBe(false);
    expect(body.querySelector('.acp-cellgrid')).toBeNull();
  });

  it('grids unified and raw diff lines the same way', () => {
    const unified = paint({ mode: 'unified', rows: unifiedDiffRows('@@ -1 +1 @@\n-│ เก่า  │\n+│ ใหม่  │'), prefix: PREFIX });
    expect(unified.el.classList.contains('acp-cellgrid-lines')).toBe(true);
    const unifiedTexts = Array.from(unified.el.querySelectorAll<HTMLElement>('.acp-harness__tool-diff-text'));
    expect(unifiedTexts.length).toBeGreaterThan(0);
    expect(unifiedTexts.every((text) => text.classList.contains('acp-cellgrid'))).toBe(true);

    const raw = paint({ mode: 'raw', rows: rawDiffRows('-│ เก่า  │\n+│ ใหม่  │'), prefix: PREFIX });
    expect(raw.el.classList.contains('acp-cellgrid-lines')).toBe(true);
    expect(Array.from(raw.el.children).every((line) => line.classList.contains('acp-cellgrid'))).toBe(true);
  });
});
