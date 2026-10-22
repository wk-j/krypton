// Spec 309 §Catalog — the Data group (13 components, 12 of them in phase 1;
// `Snippet` arrives with the loader in phase 2).
//
// Three renderers are thin adapters over code that already exists and is
// already tested, as the spec's "existing renderers to reuse" row requires:
//
//   - `Chart` / `Sparkline` take their value scale from `chartGeometry()`
//     (`review-board/render.ts`), the pure layout function whose zero-including
//     axis is the thing that silently goes wrong when re-derived by hand. The
//     marks are built with `createElementNS` — there is no SVG string anywhere
//     in this module, so nothing can reach `innerHTML`.
//   - `Diff` is `DiffBlock` in `unified` mode with `prefix` set to this block.
//   - `Diagram` is `renderMermaid()`, which is async, cached and host-free: the
//     node paints a sized placeholder, then swaps in the result if and only if
//     the component is still alive and still on the same source.

import { chartGeometry, DEFAULT_CHART_LAYOUT } from '../../../review-board/render';
import { el, setChildren } from '../../../ui/dom';
import { disposeList } from '../../../ui/list';
import { gridifyCodeBlocks } from '../../cell-grid';
import type { MermaidResult } from '../../harness-mermaid-fence';
import { cachedMermaid, renderMermaid } from '../../harness-mermaid-fence';
import { readMermaidTheme } from '../../harness-svg-fence';
import { tableHas } from '../../genui/catalog';
import type { Value, ValueList, ValueObject } from '../../genui/types';
import { isList, isNode, isPlainObject } from '../../genui/types';
import { DiffBlock, unifiedDiffRows } from '../diff-block';
import type { GenUiContext, GenUiFactory, GenUiProps } from './renderer';
import {
  asList,
  asBoolean,
  asNumber,
  asObject,
  asString,
  BLOCK,
  FOCUSABLE_ATTR,
  formatNumber,
  GenUiComponent,
  renderChildren,
  toneClass,
} from './renderer';

/** Rows drawn before the "… N more rows" tail. */
const TABLE_ROW_CAP = 200;

/** Colour slots a multi-series chart cycles through; `data.css` defines each. */
const SERIES_SLOTS = 6;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Mermaid's rendered SVG reaches the DOM only as an inert `<img>` (spec 294). */
const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';

const PIE_SIZE = 220;
const HEATMAP_ROW_HEIGHT = 26;
const GAUGE_WIDTH = 220;
const GAUGE_RADIUS = 84;

// ── small shared helpers ────────────────────────────────────────────────────

function svgEl(tag: string, attrs: Readonly<Record<string, string | number>>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** Two decimals: keeps generated path/point attributes short and stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A catalog prop the spec actually passed — `Progress(3)` has no `max`. */
function hasProp(props: Readonly<Record<string, Value>>, name: string): boolean {
  return tableHas(props, name) && props[name] !== null;
}

/** One field of a row/item object, without reaching `Object.prototype`. */
function field(obj: ValueObject, name: string): Value {
  return tableHas(obj, name) ? obj[name] : null;
}

// ── Table ───────────────────────────────────────────────────────────────────

/** A cell is addressed by header label for an object row, by position for a list row. */
function cellAt(row: Value, label: string, index: number): Value {
  if (isList(row)) return index < row.length ? row[index] : null;
  if (isPlainObject(row)) return field(row, label);
  return index === 0 ? row : null;
}

/** Right-align a column only when every cell it has is a number. */
function isNumericColumn(rows: ValueList, label: string, index: number): boolean {
  let seen = false;
  for (const row of rows) {
    const cell = cellAt(row, label, index);
    if (cell === null || cell === '') continue;
    if (typeof cell !== 'number') return false;
    seen = true;
  }
  return seen;
}

class TableComponent extends GenUiComponent {
  /** Cells that mounted a child node; their lists are disposed before a repaint. */
  private slots: HTMLElement[] = [];

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.columns, next.node.props.rows, next.ctx];
  }

  protected paint(next: GenUiProps): void {
    this.releaseSlots();
    const props = next.node.props;
    const rows = asList(props.rows);
    const labels = asList(props.columns).map((column) =>
      isPlainObject(column) ? asString(field(column, 'label')) : asString(column));
    const numeric = labels.map((label, index) => isNumericColumn(rows, label, index));

    const head = el('tr', { class: `${BLOCK}__table-row` }, ...labels.map((label, index) =>
      el('th', { class: this.cellClass('head', numeric[index]), text: label })));

    const body: HTMLElement[] = [];
    for (const row of rows.slice(0, TABLE_ROW_CAP)) {
      body.push(el('tr', { class: `${BLOCK}__table-row` }, ...labels.map((label, index) =>
        this.cell(cellAt(row, label, index), numeric[index], next.ctx))));
    }
    if (rows.length > TABLE_ROW_CAP) {
      body.push(el('tr', { class: `${BLOCK}__table-row` }, el('td', {
        class: `${BLOCK}__table-more`,
        attrs: { colspan: Math.max(1, labels.length) },
        text: `… ${formatNumber(rows.length - TABLE_ROW_CAP)} more rows`,
      })));
    }

    setChildren(this.el, [el('table', { class: `${BLOCK}__table` },
      el('thead', {}, head),
      el('tbody', {}, ...body))]);
  }

  private cellClass(part: 'head' | 'cell', numeric: boolean): string {
    const base = `${BLOCK}__table-${part}`;
    return numeric ? `${base} ${base}--num` : base;
  }

  private cell(value: Value, numeric: boolean, ctx: GenUiContext): HTMLElement {
    const td = el('td', { class: this.cellClass('cell', numeric) });
    if (isNode(value) || (isList(value) && value.some(isNode))) {
      renderChildren(td, isNode(value) ? [value] : asList(value).filter(isNode), ctx);
      this.slots.push(td);
      return td;
    }
    td.textContent = typeof value === 'number' ? formatNumber(value, Number.isInteger(value) ? 0 : 2) : asString(value);
    return td;
  }

  private releaseSlots(): void {
    for (const slot of this.slots) disposeList(slot);
    this.slots = [];
  }

  protected onDispose(): void {
    this.releaseSlots();
  }
}

// ── Chart ───────────────────────────────────────────────────────────────────

interface ChartSeries {
  readonly name: string;
  readonly values: readonly number[];
}

/** `series` is a list of numbers, or a list of `{ name, values }`. */
function readChartSeries(raw: Value, count: number): ChartSeries[] {
  const list = asList(raw);
  if (list.length === 0) return [];
  if (isPlainObject(list[0])) {
    return list.map((entry, index) => {
      const obj = asObject(entry);
      return {
        name: asString(field(obj, 'name'), `series ${index + 1}`),
        values: fitValues(asList(field(obj, 'values')), count),
      };
    });
  }
  return [{ name: 'values', values: fitValues(list, count) }];
}

/** One value per label, so every chart type has a mark per (label, series). */
function fitValues(list: ValueList, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(asNumber(i < list.length ? list[i] : 0));
  return out;
}

function mark(tag: string, attrs: Readonly<Record<string, string | number>>, series: number): SVGElement {
  return svgEl(tag, { ...attrs, class: `${BLOCK}__chart-mark`, 'data-series': series % SERIES_SLOTS });
}

function chartRoot(width: number, height: number, label: string): SVGElement {
  return svgEl('svg', {
    class: `${BLOCK}__chart-svg`,
    viewBox: `0 0 ${round(width)} ${round(height)}`,
    width: '100%',
    height: round(height),
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': label,
  });
}

function chartText(text: string, x: number, y: number, anchor: 'start' | 'end'): SVGElement {
  const node = svgEl('text', { class: `${BLOCK}__chart-text`, x: round(x), y: round(y), 'text-anchor': anchor });
  node.textContent = text;
  return node;
}

/** Horizontal bars: grouped by default, split in place when `stacked`. */
function barChart(labels: readonly string[], series: readonly ChartSeries[], stacked: boolean, root: SVGElement): void {
  const multi = series.length > 1;
  const split = stacked && multi;
  const data = split
    ? labels.map((label, i) => ({ label, value: series.reduce((total, s) => total + Math.max(0, s.values[i]), 0) }))
    : labels.flatMap((label, i) => series.map((s) => ({ label: multi ? `${label} · ${s.name}` : label, value: s.values[i] })));
  const geo = chartGeometry({ kind: 'bar', data });

  geo.bars.forEach((bar, index) => {
    if (split) {
      let x = bar.x;
      series.forEach((s, slot) => {
        const share = bar.value > 0 ? (Math.max(0, s.values[index]) / bar.value) * bar.width : 0;
        root.appendChild(mark('rect', { x: round(x), y: bar.y, width: round(share), height: bar.height, rx: 1 }, slot));
        x += share;
      });
    } else {
      const slot = multi ? index % series.length : 0;
      root.appendChild(mark('rect', { x: round(bar.x), y: bar.y, width: round(bar.width), height: bar.height, rx: 1 }, slot));
    }
    root.appendChild(chartText(bar.label, 0, bar.textY, 'start'));
    root.appendChild(chartText(formatNumber(bar.value, Number.isInteger(bar.value) ? 0 : 1), geo.width, bar.textY, 'end'));
  });
}

/** line / area / scatter: one shared value scale, one mark per plotted point. */
function pointChart(
  type: string,
  labels: readonly string[],
  series: readonly ChartSeries[],
  root: SVGElement,
): void {
  const count = labels.length;
  // One `chartGeometry` call over every series fixes the y scale for all of
  // them; a second over the label row fixes x. No scaling is re-derived here.
  const scale = chartGeometry({
    kind: 'line',
    data: series.flatMap((s) => s.values.map((value, i) => ({ label: labels[i], value }))),
  });
  const xGeo = chartGeometry({ kind: 'line', data: labels.map((label) => ({ label, value: 0 })) });

  root.appendChild(svgEl('line', {
    class: `${BLOCK}__chart-axis`,
    x1: 0, y1: round(scale.baselineY), x2: round(scale.width), y2: round(scale.baselineY),
  }));

  series.forEach((s, slot) => {
    const points = s.values.map((value, i) => ({ x: xGeo.points[i].x, y: scale.points[slot * count + i].y }));
    const path = points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
    if (type === 'area' && points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];
      root.appendChild(svgEl('path', {
        class: `${BLOCK}__chart-area`,
        'data-series': slot % SERIES_SLOTS,
        d: `M ${round(first.x)} ${round(scale.baselineY)} `
          + points.map((p) => `L ${round(p.x)} ${round(p.y)}`).join(' ')
          + ` L ${round(last.x)} ${round(scale.baselineY)} Z`,
      }));
    }
    if (type !== 'scatter' && points.length > 1) {
      root.appendChild(svgEl('polyline', { class: `${BLOCK}__chart-line`, 'data-series': slot % SERIES_SLOTS, points: path }));
    }
    for (const point of points) root.appendChild(mark('circle', { cx: round(point.x), cy: round(point.y), r: 3 }, slot));
  });
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number, wedge: boolean): string {
  const large = end - start > Math.PI ? 1 : 0;
  const x0 = round(cx + r * Math.cos(start));
  const y0 = round(cy + r * Math.sin(start));
  const x1 = round(cx + r * Math.cos(end));
  const y1 = round(cy + r * Math.sin(end));
  const arc = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  return wedge ? `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z` : arc;
}

/** Pie and funnel read the first series only — a second would have no place to go. */
function pieChart(series: readonly ChartSeries[], root: SVGElement): void {
  const values = (series.length === 0 ? [] : series[0].values).map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0);
  const centre = PIE_SIZE / 2;
  const radius = centre - 8;
  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    const share = total > 0 ? value / total : 1 / values.length;
    if (values.length === 1) {
      root.appendChild(mark('circle', { cx: centre, cy: centre, r: radius }, index));
    } else {
      root.appendChild(mark('path', { d: arcPath(centre, centre, radius, angle, angle + share * Math.PI * 2, true) }, index));
    }
    angle += share * Math.PI * 2;
  });
}

function funnelChart(labels: readonly string[], series: readonly ChartSeries[], root: SVGElement): void {
  const values = series.length === 0 ? labels.map(() => 0) : series[0].values;
  const geo = chartGeometry({ kind: 'bar', data: labels.map((label, i) => ({ label, value: values[i] })) });
  const plotX = DEFAULT_CHART_LAYOUT.labelWidth;
  const plotWidth = Math.max(1, geo.width - DEFAULT_CHART_LAYOUT.labelWidth - DEFAULT_CHART_LAYOUT.valueWidth);
  geo.bars.forEach((bar, index) => {
    root.appendChild(mark('rect', {
      x: round(plotX + (plotWidth - bar.width) / 2), y: bar.y, width: round(bar.width), height: bar.height, rx: 1,
    }, index));
    root.appendChild(chartText(bar.label, 0, bar.textY, 'start'));
    root.appendChild(chartText(formatNumber(values[index], 0), geo.width, bar.textY, 'end'));
  });
}

function heatmapChart(labels: readonly string[], series: readonly ChartSeries[], root: SVGElement): void {
  const gutter = DEFAULT_CHART_LAYOUT.labelWidth;
  const plotWidth = Math.max(1, DEFAULT_CHART_LAYOUT.width - gutter - 8);
  const cell = plotWidth / Math.max(1, labels.length);
  const all = series.flatMap((s) => s.values);
  const low = all.length === 0 ? 0 : Math.min(...all);
  const span = all.length === 0 ? 0 : Math.max(...all) - low;
  series.forEach((s, row) => {
    const y = row * HEATMAP_ROW_HEIGHT;
    root.appendChild(chartText(s.name, 0, y + HEATMAP_ROW_HEIGHT / 2 + 4, 'start'));
    s.values.forEach((value, column) => {
      root.appendChild(mark('rect', {
        x: round(gutter + column * cell + 1), y: y + 1,
        width: round(Math.max(1, cell - 2)), height: HEATMAP_ROW_HEIGHT - 2, rx: 1,
        'fill-opacity': round(0.14 + 0.86 * (span === 0 ? 1 : (value - low) / span)),
      }, row));
    });
  });
}

function chartAriaLabel(type: string, labels: readonly string[], series: readonly ChartSeries[], unit: string): string {
  const names = series.map((s) => s.name).join(', ');
  const scope = type === 'pie' || type === 'funnel' ? labels.join(', ') : `${labels.length} categories`;
  return `${type} chart of ${names === '' ? 'no data' : names} across ${scope}${unit === '' ? '' : ` in ${unit}`}`;
}

class ChartComponent extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    const p = next.node.props;
    return [p.type, p.labels, p.series, p.unit, p.stacked];
  }

  protected paint(next: GenUiProps): void {
    const props = next.node.props;
    const type = asString(props.type, 'bar');
    const labels = asList(props.labels).map((value) => asString(value));
    const series = readChartSeries(props.series, labels.length);
    const unit = asString(props.unit);
    const aria = chartAriaLabel(type, labels, series, unit);

    let root: SVGElement;
    if (type === 'pie') {
      root = chartRoot(PIE_SIZE, PIE_SIZE, aria);
      pieChart(series, root);
    } else if (type === 'heatmap') {
      root = chartRoot(DEFAULT_CHART_LAYOUT.width, Math.max(HEATMAP_ROW_HEIGHT, series.length * HEATMAP_ROW_HEIGHT), aria);
      heatmapChart(labels, series, root);
    } else if (type === 'funnel') {
      root = chartRoot(DEFAULT_CHART_LAYOUT.width, Math.max(22, labels.length * 22), aria);
      funnelChart(labels, series, root);
    } else if (type === 'line' || type === 'area' || type === 'scatter') {
      root = chartRoot(DEFAULT_CHART_LAYOUT.width, 120, aria);
      pointChart(type, labels, series, root);
    } else {
      const rows = asBoolean(props.stacked) && series.length > 1 ? labels.length : labels.length * series.length;
      root = chartRoot(DEFAULT_CHART_LAYOUT.width, Math.max(22, rows * 22), aria);
      barChart(labels, series, asBoolean(props.stacked), root);
    }

    const keys = type === 'pie' || type === 'funnel'
      ? labels
      : series.length > 1 ? series.map((s) => s.name) : [];
    const ticks = type === 'line' || type === 'area' || type === 'scatter'
      ? el('div', { class: `${BLOCK}__chart-ticks` }, ...labels.map((label) =>
        el('span', { class: `${BLOCK}__chart-tick`, text: label })))
      : null;

    setChildren(this.el, [el('figure', { class: `${BLOCK}__chart ${BLOCK}__chart--${type}` },
      root,
      ticks,
      keys.length === 0 ? null : el('div', { class: `${BLOCK}__chart-keys` }, ...keys.map((name, index) =>
        el('span', { class: `${BLOCK}__chart-key`, data: { series: index % SERIES_SLOTS } },
          el('span', { class: `${BLOCK}__chart-swatch` }),
          el('span', { class: `${BLOCK}__chart-key-name`, text: name })))),
      unit === '' ? null : el('figcaption', { class: `${BLOCK}__chart-unit`, text: unit }))]);
  }
}

// ── Sparkline ───────────────────────────────────────────────────────────────

class SparklineComponent extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.values, next.node.props.tone];
  }

  protected paint(next: GenUiProps): void {
    const values = asList(next.node.props.values).map((value) => asNumber(value));
    const geo = chartGeometry({ kind: 'sparkline', data: values.map((value, i) => ({ label: String(i), value })) });
    const root = svgEl('svg', {
      class: `${BLOCK}__spark-svg`,
      viewBox: `0 0 ${geo.width} ${geo.height}`,
      width: '100%',
      height: geo.height,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `sparkline of ${values.length} values`,
    });
    if (geo.points.length > 1) {
      root.appendChild(svgEl('polyline', { class: `${BLOCK}__spark-line`, points: geo.polyline }));
    }
    if (geo.points.length > 0) {
      const last = geo.points[geo.points.length - 1];
      root.appendChild(svgEl('circle', { class: `${BLOCK}__spark-dot`, cx: round(last.x), cy: round(last.y), r: 2.5 }));
    }
    setChildren(this.el, [el('div', { class: toneClass(`${BLOCK}__spark`, next.node.props.tone) }, root)]);
  }
}

// ── Progress / Gauge / SegmentedBar ─────────────────────────────────────────

class ProgressComponent extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    const p = next.node.props;
    return [p.value, p.max, p.label, p.tone, hasProp(p, 'max')];
  }

  protected paint(next: GenUiProps): void {
    const props = next.node.props;
    const value = asNumber(props.value);
    const bounded = hasProp(props, 'max');
    const max = bounded ? asNumber(props.max, 100) : 100;
    const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
    const readout = bounded
      ? `${formatNumber(value)} / ${formatNumber(max)}`
      : `${formatNumber(Math.round(percent))}%`;
    const label = asString(props.label);

    setChildren(this.el, [el('div', { class: `${BLOCK}__progress` },
      label === '' ? null : el('span', { class: `${BLOCK}__progress-label`, text: label }),
      el('div', { class: `${BLOCK}__progress-track` },
        el('div', { class: toneClass(`${BLOCK}__progress-fill`, props.tone), style: { width: `${round(percent)}%` } })),
      el('span', { class: `${BLOCK}__progress-value`, text: readout }))]);
  }
}

class GaugeComponent extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    const p = next.node.props;
    return [p.value, p.min, p.max, p.label, p.tone];
  }

  protected paint(next: GenUiProps): void {
    const props = next.node.props;
    const min = hasProp(props, 'min') ? asNumber(props.min) : 0;
    const max = hasProp(props, 'max') ? asNumber(props.max, 100) : 100;
    const value = asNumber(props.value);
    const fraction = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
    const cx = GAUGE_WIDTH / 2;
    const cy = GAUGE_RADIUS + 10;
    const label = asString(props.label);

    const root = svgEl('svg', {
      class: `${BLOCK}__gauge-svg`,
      viewBox: `0 0 ${GAUGE_WIDTH} ${cy + 12}`,
      width: '100%',
      height: cy + 12,
      role: 'img',
      'aria-label': `${label === '' ? 'gauge' : label}: ${formatNumber(value)} of ${formatNumber(max)}`,
    });
    root.appendChild(svgEl('path', {
      class: `${BLOCK}__gauge-track`, d: arcPath(cx, cy, GAUGE_RADIUS, Math.PI, Math.PI * 2, false),
    }));
    if (fraction > 0) {
      root.appendChild(svgEl('path', {
        class: toneClass(`${BLOCK}__gauge-fill`, props.tone),
        d: arcPath(cx, cy, GAUGE_RADIUS, Math.PI, Math.PI * (1 + fraction), false),
      }));
    }

    setChildren(this.el, [el('div', { class: `${BLOCK}__gauge` },
      root,
      el('span', { class: `${BLOCK}__gauge-value`, text: formatNumber(value, Number.isInteger(value) ? 0 : 1) }),
      label === '' ? null : el('span', { class: `${BLOCK}__gauge-label`, text: label }))]);
  }
}

class SegmentedBarComponent extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.parts, next.node.props.unit];
  }

  protected paint(next: GenUiProps): void {
    const unit = asString(next.node.props.unit);
    const parts = asList(next.node.props.parts).map((part) => {
      const obj = asObject(part);
      return {
        label: asString(field(obj, 'label')),
        value: Math.max(0, asNumber(field(obj, 'value'))),
        tone: field(obj, 'tone'),
      };
    });
    const total = parts.reduce((sum, part) => sum + part.value, 0);

    setChildren(this.el, [el('div', { class: `${BLOCK}__segbar` },
      el('div', { class: `${BLOCK}__segbar-track` }, ...parts.map((part) =>
        el('div', {
          class: toneClass(`${BLOCK}__segbar-part`, part.tone),
          style: { width: `${round(total > 0 ? (part.value / total) * 100 : 0)}%` },
          title: `${part.label}: ${formatNumber(part.value)}${unit === '' ? '' : ` ${unit}`}`,
        }))),
      el('div', { class: `${BLOCK}__segbar-keys` }, ...parts.map((part) =>
        el('span', { class: `${BLOCK}__segbar-key` },
          el('span', { class: toneClass(`${BLOCK}__segbar-swatch`, part.tone) }),
          el('span', { class: `${BLOCK}__segbar-name`, text: part.label }),
          el('span', {
            class: `${BLOCK}__segbar-amount`,
            text: `${formatNumber(part.value)}${unit === '' ? '' : ` ${unit}`}`,
          })))))]);
  }
}

// ── Steps / Timeline ────────────────────────────────────────────────────────

const STEP_MARK: Readonly<Record<string, string>> = { done: '✓', current: '→', blocked: '✕' };

class StepsComponent extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.items];
  }

  protected paint(next: GenUiProps): void {
    const items = asList(next.node.props.items).map((item, index) => {
      const obj = isPlainObject(item) ? item : {};
      const status = asString(field(obj, 'status'));
      const known = tableHas(STEP_MARK, status);
      return el('li', { class: `${BLOCK}__step-row ${BLOCK}__step-row--${known ? status : 'todo'}` },
        el('span', { class: `${BLOCK}__step-mark`, text: known ? STEP_MARK[status] : String(index + 1) }),
        el('span', { class: `${BLOCK}__step-body` },
          el('span', { class: `${BLOCK}__step-title`, text: isPlainObject(item) ? asString(field(obj, 'title')) : asString(item) }),
          field(obj, 'detail') === null
            ? null
            : el('span', { class: `${BLOCK}__step-detail`, text: asString(field(obj, 'detail')) })));
    });
    setChildren(this.el, [el('ol', { class: `${BLOCK}__steps` }, ...items)]);
  }
}

class TimelineComponent extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.items];
  }

  protected paint(next: GenUiProps): void {
    const items = asList(next.node.props.items).map((item) => {
      const obj = asObject(item);
      const detail = field(obj, 'detail');
      return el('li', { class: `${BLOCK}__event` },
        el('span', { class: toneClass(`${BLOCK}__event-dot`, field(obj, 'tone')) }),
        el('span', { class: `${BLOCK}__event-time`, text: asString(field(obj, 'time')) }),
        el('span', { class: `${BLOCK}__event-body` },
          el('span', { class: `${BLOCK}__event-title`, text: asString(field(obj, 'title')) }),
          detail === null ? null : el('span', { class: `${BLOCK}__event-detail`, text: asString(detail) })));
    });
    setChildren(this.el, [el('ol', { class: `${BLOCK}__timeline` }, ...items)]);
  }
}

// ── Tree ────────────────────────────────────────────────────────────────────

/** Nesting a spec may express; past this the remaining depth is flattened away. */
const TREE_MAX_DEPTH = 12;

interface TreeItem {
  readonly label: string;
  readonly note: string;
  readonly children: TreeItem[];
}

function treeChild(parent: TreeItem[], label: string): TreeItem {
  for (const item of parent) {
    if (item.label === label) return item;
  }
  const created: TreeItem = { label, note: '', children: [] };
  parent.push(created);
  return created;
}

function treeFromObject(obj: ValueObject, depth: number): TreeItem {
  const children: TreeItem[] = [];
  if (depth < TREE_MAX_DEPTH) {
    for (const child of asList(field(obj, 'children'))) {
      if (isPlainObject(child)) children.push(treeFromObject(child, depth + 1));
      else children.push({ label: asString(child), note: '', children: [] });
    }
  }
  return { label: asString(field(obj, 'label')), note: asString(field(obj, 'note')), children };
}

/** Path strings merge into one forest; objects are taken as written. */
function treeFrom(items: ValueList): TreeItem[] {
  const roots: TreeItem[] = [];
  for (const item of items) {
    if (isPlainObject(item)) {
      roots.push(treeFromObject(item, 0));
      continue;
    }
    const segments = asString(item).split('/').filter((segment) => segment !== '').slice(0, TREE_MAX_DEPTH);
    let level = roots;
    for (const segment of segments) level = treeChild(level, segment).children;
  }
  return roots;
}

class TreeComponent extends GenUiComponent {
  private wired = false;
  private ctx: GenUiContext | null = null;
  private key = '';

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.items, Object.keys(this.openSet(next)).sort().join('\u0000'), next.ctx];
  }

  /** `{ path: true }` for every expanded branch; collapsed is the default. */
  private openSet(next: GenUiProps): Record<string, true> {
    const view = next.ctx.view(next.node.key);
    const current = view.open;
    if (typeof current === 'object' && current !== null) return current as Record<string, true>;
    const created: Record<string, true> = Object.create(null) as Record<string, true>;
    view.open = created;
    return created;
  }

  protected paint(next: GenUiProps): void {
    this.ctx = next.ctx;
    this.key = next.node.key;
    const open = this.openSet(next);
    if (!this.wired) {
      this.wired = true;
      this.bag.listen(this.el, 'click', (event) => this.onClick(event));
    }
    const list = el('ul', { class: `${BLOCK}__tree` });
    this.appendBranch(list, treeFrom(asList(next.node.props.items)), '', open);
    setChildren(this.el, [list]);
  }

  private appendBranch(list: HTMLElement, items: readonly TreeItem[], prefix: string, open: Record<string, true>): void {
    for (const item of items) {
      const path = `${prefix}/${item.label}`;
      const branch = item.children.length > 0;
      const expanded = branch && open[path] === true;
      const row = el('div', { class: `${BLOCK}__tree-row` },
        branch
          ? el('button', {
            class: `${BLOCK}__tree-toggle`,
            text: expanded ? '▾' : '▸',
            attrs: {
              type: 'button',
              'data-tree-path': path,
              'aria-expanded': expanded ? 'true' : 'false',
              [FOCUSABLE_ATTR]: true,
            },
          })
          : el('span', { class: `${BLOCK}__tree-leaf` }),
        el('span', { class: `${BLOCK}__tree-label`, text: item.label }),
        item.note === '' ? null : el('span', { class: `${BLOCK}__tree-note`, text: item.note }));

      const node = el('li', { class: `${BLOCK}__tree-item ${BLOCK}__tree-item--${branch ? 'branch' : 'leaf'}` }, row);
      if (expanded) {
        const children = el('ul', { class: `${BLOCK}__tree` });
        this.appendBranch(children, item.children, path, open);
        node.appendChild(children);
      }
      list.appendChild(node);
    }
  }

  private onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || this.ctx === null) return;
    const toggle = target.closest<HTMLElement>('[data-tree-path]');
    if (toggle === null) return;
    const path = toggle.getAttribute('data-tree-path');
    if (path === null) return;
    const view = this.ctx.view(this.key);
    const open = view.open as Record<string, true> | undefined;
    if (open === undefined) return;
    if (open[path] === true) delete open[path];
    else open[path] = true;
    this.ctx.repaint();
  }
}

// ── Code ────────────────────────────────────────────────────────────────────

class CodeComponent extends GenUiComponent {
  private code = '';
  private ctx: GenUiContext | null = null;
  private copy: HTMLButtonElement | null = null;

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.code, next.node.props.language, next.ctx];
  }

  protected paint(next: GenUiProps): void {
    this.code = asString(next.node.props.code);
    this.ctx = next.ctx;
    const language = asString(next.node.props.language);

    if (this.copy === null) {
      this.copy = el('button', {
        class: `${BLOCK}__code-copy`,
        text: 'Copy',
        attrs: { type: 'button', [FOCUSABLE_ATTR]: true },
      });
      this.bag.listen(this.copy, 'click', () => {
        this.ctx?.run([{ kind: 'action', type: 'copy', text: this.code }]);
      });
    }

    const code = el('code', { class: `${BLOCK}__code-text`, text: this.code });
    const block = el('div', { class: `${BLOCK}__code` },
      el('div', { class: `${BLOCK}__code-head` },
        el('span', { class: `${BLOCK}__code-lang`, text: language === '' ? 'text' : language }),
        this.copy),
      el('pre', { class: `${BLOCK}__code-body` }, code));
    gridifyCodeBlocks(block); // spec 326: a diagram or padded Thai sits on the cell grid
    setChildren(this.el, [block]);
  }
}

// ── Diff ────────────────────────────────────────────────────────────────────

class DiffComponent extends GenUiComponent {
  private block: DiffBlock | null = null;

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.patch, next.node.props.path];
  }

  protected paint(next: GenUiProps): void {
    const path = asString(next.node.props.path);
    const block = this.block ?? new DiffBlock('unified');
    this.block = block;
    block.update({ mode: 'unified', rows: unifiedDiffRows(asString(next.node.props.patch)), prefix: BLOCK, path });
    setChildren(this.el, [el('div', { class: `${BLOCK}__diff` },
      path === '' ? null : el('div', { class: `${BLOCK}__diff-path`, text: path }),
      block.el)]);
  }

  protected onDispose(): void {
    this.block?.dispose();
    this.block = null;
  }
}

// ── Diagram ─────────────────────────────────────────────────────────────────

class DiagramComponent extends GenUiComponent {
  /** Bumped by every paint and by dispose, so a late render finds a stale token. */
  private token = 0;
  private gone = false;
  private figure: HTMLElement | null = null;

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.mermaid];
  }

  protected paint(next: GenUiProps): void {
    this.token += 1;
    const token = this.token;
    const source = asString(next.node.props.mermaid);
    const theme = readMermaidTheme();
    const figure = el('div', { class: `${BLOCK}__diagram` });
    this.figure = figure;
    setChildren(this.el, [figure]);

    const hit = cachedMermaid(source, theme);
    if (hit !== undefined) {
      this.swap(figure, hit);
      return;
    }
    // Sized placeholder: the panel never reflows when the real frame lands.
    figure.appendChild(el('div', { class: `${BLOCK}__diagram-pending`, text: 'rendering diagram…' }));
    void renderMermaid(source, theme, () => !this.gone && this.token === token).then((result) => {
      if (result === null || this.gone || this.token !== token || this.figure !== figure) return;
      this.swap(figure, result);
    });
  }

  private swap(figure: HTMLElement, result: MermaidResult): void {
    setChildren(figure, [result.ok
      ? el('img', {
        class: `${BLOCK}__diagram-img`,
        attrs: { src: SVG_DATA_URL_PREFIX + encodeURIComponent(result.svg), alt: `${result.diagramType} diagram` },
      })
      : el('div', { class: `${BLOCK}__diagram-error`, text: result.error.split('\n')[0] })]);
  }

  protected onDispose(): void {
    this.gone = true;
    this.token += 1;
    this.figure = null;
  }
}

export const DATA_RENDERERS: Record<string, GenUiFactory> = {
  Table: (host) => new TableComponent(host),
  Chart: (host) => new ChartComponent(host),
  Sparkline: (host) => new SparklineComponent(host),
  Progress: (host) => new ProgressComponent(host),
  Gauge: (host) => new GaugeComponent(host),
  SegmentedBar: (host) => new SegmentedBarComponent(host),
  Steps: (host) => new StepsComponent(host),
  Timeline: (host) => new TimelineComponent(host),
  Tree: (host) => new TreeComponent(host),
  Code: (host) => new CodeComponent(host),
  Diff: (host) => new DiffComponent(host),
  Diagram: (host) => new DiagramComponent(host),
};
