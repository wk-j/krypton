// Spec 309 §Catalog — Data group renderers.
//
// The three reuse adapters (`Chart` → `chartGeometry`, `Diff` → `DiffBlock`,
// `Diagram` → `renderMermaid`) are asserted at their seam: the mark count and
// the aria summary for charts, DiffBlock's own row markup for `Diff`, and the
// placeholder → result swap (plus the stale-resolution guard) for `Diagram`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { el } from '../../../ui/dom';
import type { MermaidResult } from '../../harness-mermaid-fence';
import type { UiAction, UiNode, Value } from '../../genui/types';
import { unifiedDiffRows } from '../diff-block';
import { DATA_RENDERERS } from './data';
import type { GenUiComponent, GenUiContext } from './renderer';
import { registerRenderers } from './renderer';

const mermaidState = vi.hoisted(() => ({
  /** What `cachedMermaid` answers; `undefined` forces a render. */
  cached: undefined as MermaidResult | undefined,
  /** What the queued render resolves with, one microtask later. */
  next: null as MermaidResult | null,
  renders: 0,
}));

vi.mock('../../harness-mermaid-fence', () => ({
  cachedMermaid: (): MermaidResult | undefined => mermaidState.cached,
  renderMermaid: (): Promise<MermaidResult | null> => {
    mermaidState.renders += 1;
    return Promise.resolve(mermaidState.next);
  },
}));

vi.mock('../../harness-svg-fence', () => ({
  readMermaidTheme: () => ({ key: 'test-theme', config: {} }),
}));

registerRenderers(DATA_RENDERERS);

interface Harness {
  readonly ctx: GenUiContext;
  readonly runs: UiAction[][];
  readonly repaints: number[];
}

function makeCtx(): Harness {
  const views: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  const runs: UiAction[][] = [];
  const repaints: number[] = [];
  const ctx: GenUiContext = {
    run: (actions) => {
      runs.push([...actions]);
    },
    setInput: () => {
      /* no input in the Data group */
    },
    state: {},
    view: (key) => {
      if (views[key] === undefined) views[key] = {};
      return views[key];
    },
    repaint: () => {
      repaints.push(repaints.length);
    },
  };
  return { ctx, runs, repaints };
}

let keySeq = 0;

function makeNode(component: string, props: Record<string, Value>): UiNode {
  keySeq += 1;
  return { kind: 'node', component, props, key: `n${keySeq}` };
}

interface Mounted {
  readonly host: HTMLElement;
  readonly cmp: GenUiComponent;
  readonly node: UiNode;
}

function mount(component: string, props: Record<string, Value>, ctx: GenUiContext): Mounted {
  const host = el('div');
  const node = makeNode(component, props);
  const cmp = DATA_RENDERERS[component](host);
  cmp.update({ node, ctx });
  return { host, cmp, node };
}

/** Let the `renderMermaid` continuation and its `setChildren` run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const LABELS: Value = ['a', 'b', 'c'];
const SERIES: Value = [
  { name: 'Pass', values: [1, 2, 3] },
  { name: 'Fail', values: [3, 2, 1] },
];

describe('Chart', () => {
  // Every type plots one mark per value it can show: bar/line/area/scatter/
  // heatmap draw both series (3 × 2), pie and funnel take the first (3).
  const marksByType: Readonly<Record<string, number>> = {
    bar: 6, line: 6, area: 6, scatter: 6, heatmap: 6, pie: 3, funnel: 3,
  };

  it('draws the expected marks for each type and names the series', () => {
    const { ctx } = makeCtx();
    for (const [type, marks] of Object.entries(marksByType)) {
      const { host } = mount('Chart', { type, labels: LABELS, series: SERIES }, ctx);
      expect(`${type}:${host.querySelectorAll('.acp-genui__chart-mark').length}`).toBe(`${type}:${marks}`);
      const svg = host.querySelector('svg');
      expect(svg?.getAttribute('role')).toBe('img');
      expect(svg?.getAttribute('aria-label')).toBe(
        type === 'pie' || type === 'funnel'
          ? `${type} chart of Pass, Fail across a, b, c`
          : `${type} chart of Pass, Fail across 3 categories`,
      );
    }
  });

  it('keeps one mark per value when bars are stacked, and reports the unit', () => {
    const { ctx } = makeCtx();
    const { host } = mount('Chart', { type: 'bar', labels: LABELS, series: SERIES, stacked: true, unit: 'ms' }, ctx);
    expect(host.querySelectorAll('.acp-genui__chart-mark').length).toBe(6);
    expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'bar chart of Pass, Fail across 3 categories in ms',
    );
    expect(host.querySelector('.acp-genui__chart-unit')?.textContent).toBe('ms');
  });

  it('accepts a bare list of numbers as one series', () => {
    const { ctx } = makeCtx();
    const { host } = mount('Chart', { type: 'line', labels: LABELS, series: [4, 5, 6] }, ctx);
    expect(host.querySelectorAll('.acp-genui__chart-mark').length).toBe(3);
    expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe('line chart of values across 3 categories');
  });
});

describe('Table', () => {
  it('renders a component cell and right-aligns a numeric column', () => {
    const { ctx } = makeCtx();
    const cell = makeNode('Code', { code: 'npm test' });
    const { host } = mount('Table', { columns: ['step', 'count'], rows: [[cell, 5]] }, ctx);

    expect(host.querySelector('.acp-genui__code-text')?.textContent).toBe('npm test');
    const cells = host.querySelectorAll('.acp-genui__table-cell');
    expect(cells[0].className).toBe('acp-genui__table-cell');
    expect(cells[1].className).toBe('acp-genui__table-cell acp-genui__table-cell--num');
    expect(host.querySelectorAll('.acp-genui__table-head--num').length).toBe(1);
  });

  it('reads object rows by column label', () => {
    const { ctx } = makeCtx();
    const rows: Value = [{ file: 'a.ts', lines: 12 }];
    const { host } = mount('Table', { columns: ['file', 'lines'], rows }, ctx);
    expect(Array.from(host.querySelectorAll('.acp-genui__table-cell')).map((c) => c.textContent)).toEqual(['a.ts', '12']);
  });

  it('stops at 200 rows and names the remainder', () => {
    const { ctx } = makeCtx();
    const rows: Value = Array.from({ length: 250 }, (_, i) => [i]);
    const { host } = mount('Table', { columns: ['n'], rows }, ctx);

    expect(host.querySelectorAll('.acp-genui__table-cell').length).toBe(200);
    const more = host.querySelector('.acp-genui__table-more');
    expect(more?.textContent).toBe('… 50 more rows');
    expect(more?.getAttribute('colspan')).toBe('1');
  });

  // jsdom applies no sheet, so the frame is asserted on the sheet itself.
  // `border-collapse: collapse` silently voids every `border-radius` a cell
  // declares, and this sheet's `krypton.component` layer outranks the
  // `separate` that `harness-shared.css` sets for tables inside a message
  // body — which is how this one table rendered square beside rounded blocks.
  it('frames the table with the shared radius, never a collapsed border box', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data.css'), 'utf8');
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = declarations.match(/\.acp-genui__table\s*\{[^}]*\}/)?.[0] ?? '';

    expect(rule).toMatch(/border-collapse:\s*separate/);
    expect(rule).toMatch(/border-radius:\s*var\(--krypton-border-radius,\s*8px\)/);
    expect(declarations).not.toMatch(/border-collapse:\s*collapse/);
  });
});

describe('Progress', () => {
  it('shows a percentage when max is absent', () => {
    const { ctx } = makeCtx();
    const { host } = mount('Progress', { value: 42 }, ctx);
    expect(host.querySelector('.acp-genui__progress-value')?.textContent).toBe('42%');
    expect(host.querySelector<HTMLElement>('.acp-genui__progress-fill')?.style.width).toBe('42%');
  });

  it('shows value over max when max is given', () => {
    const { ctx } = makeCtx();
    const { host } = mount('Progress', { value: 3, max: 10, tone: 'good' }, ctx);
    expect(host.querySelector('.acp-genui__progress-value')?.textContent).toBe('3 / 10');
    const fill = host.querySelector<HTMLElement>('.acp-genui__progress-fill');
    expect(fill?.style.width).toBe('30%');
    expect(fill?.className).toBe('acp-genui__progress-fill acp-genui__progress-fill--good');
  });
});

describe('Tree', () => {
  it('starts collapsed and toggles through the view state', () => {
    const { ctx, repaints } = makeCtx();
    const { host, cmp, node } = mount('Tree', { items: ['src/acp/data.ts'] }, ctx);

    const labels = (): string[] =>
      Array.from(host.querySelectorAll('.acp-genui__tree-label')).map((n) => n.textContent ?? '');
    expect(labels()).toEqual(['src']);

    const toggle = host.querySelector<HTMLElement>('.acp-genui__tree-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    toggle?.click();
    expect(repaints.length).toBe(1);
    expect((ctx.view(node.key).open as Record<string, true>)['/src']).toBe(true);

    cmp.update({ node, ctx });
    expect(labels()).toEqual(['src', 'acp']);

    host.querySelector<HTMLElement>('.acp-genui__tree-toggle')?.click();
    cmp.update({ node, ctx });
    expect(labels()).toEqual(['src']);
  });

  it('takes object items with notes', () => {
    const { ctx } = makeCtx();
    const items: Value = [{ label: 'core', note: '3 files', children: ['a.ts'] }];
    const { host } = mount('Tree', { items }, ctx);
    expect(host.querySelector('.acp-genui__tree-note')?.textContent).toBe('3 files');
  });
});

describe('Code', () => {
  it('copies the exact text through ctx.run', () => {
    const { ctx, runs } = makeCtx();
    const code = 'const a = 1;\nconst b = 2;\n';
    const { host } = mount('Code', { code, language: 'ts' }, ctx);

    expect(host.querySelector('.acp-genui__code-lang')?.textContent).toBe('ts');
    expect(host.querySelector('pre > code')?.textContent).toBe(code);
    host.querySelector<HTMLElement>('.acp-genui__code-copy')?.click();
    expect(runs).toEqual([[{ kind: 'action', type: 'copy', text: code }]]);
  });
});

describe('Diff', () => {
  const PATCH = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';

  it('delegates to DiffBlock in unified mode under this block', () => {
    const { ctx } = makeCtx();
    const { host } = mount('Diff', { patch: PATCH, path: 'x.ts' }, ctx);

    const body = host.querySelector('.acp-genui__tool-rich--unidiff');
    expect(body).not.toBeNull();
    expect(body?.className).toBe('acp-genui__tool-rich acp-genui__tool-rich--unidiff');
    expect(body?.children.length).toBe(unifiedDiffRows(PATCH).length);
    expect(host.querySelector('.acp-genui__diff-path')?.textContent).toBe('x.ts');
    expect(host.querySelector('.acp-genui__tool-diff-line--del .acp-genui__tool-diff-text')?.textContent).toBe('old');
    expect(host.querySelector('.acp-genui__tool-diff-line--add .acp-genui__tool-diff-text')?.textContent).toBe('new');
  });
});

describe('Diagram', () => {
  beforeEach(() => {
    mermaidState.cached = undefined;
    mermaidState.next = null;
    mermaidState.renders = 0;
  });

  it('paints a placeholder, then swaps in the rendered diagram', async () => {
    mermaidState.next = { ok: true, svg: '<svg id="d"/>', diagramType: 'flowchart' };
    const { ctx } = makeCtx();
    const { host } = mount('Diagram', { mermaid: 'graph LR; A-->B' }, ctx);

    // The render is queued, not settled: the sized placeholder is what paints.
    expect(host.querySelector('.acp-genui__diagram-pending')?.textContent).toBe('rendering diagram…');
    expect(mermaidState.renders).toBe(1);

    await flush();

    expect(host.querySelector('.acp-genui__diagram-pending')).toBeNull();
    const img = host.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('flowchart diagram');
    expect(img?.getAttribute('src')).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg id="d"/>')}`);
  });

  it('ignores a render that settles after dispose', async () => {
    mermaidState.next = { ok: true, svg: '<svg id="late"/>', diagramType: 'flowchart' };
    const { ctx } = makeCtx();
    const { host, cmp } = mount('Diagram', { mermaid: 'graph LR; C-->D' }, ctx);
    const before = host.innerHTML;

    cmp.dispose();
    await flush();

    expect(host.innerHTML).toBe(before);
    expect(host.querySelector('img')).toBeNull();
  });

  it('paints a cached result without rendering again', () => {
    mermaidState.cached = { ok: false, error: 'Parse error on line 2:\nbad' };
    const { ctx } = makeCtx();
    const { host } = mount('Diagram', { mermaid: 'graph LR; bad' }, ctx);

    expect(mermaidState.renders).toBe(0);
    expect(host.querySelector('.acp-genui__diagram-error')?.textContent).toBe('Parse error on line 2:');
  });
});
