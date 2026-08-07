// Krypton — Review Board block renderers (spec 211)
//
// Per-block DOM builders, plus the pure helpers they are built from. The split
// is deliberate: chart geometry, the SVG sanitizer, and the markup vocabulary
// (severity chips, anchor labels) are pure functions with no DOM dependency, so
// the parts that can be silently wrong are covered by unit tests while the DOM
// assembly stays thin enough to read.

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import { html as diff2html } from 'diff2html';

import type {
  ReviewBlock,
  ReviewBlockSeverity,
  ReviewChartBlock,
  ReviewFindingBlock,
} from '../acp/types';

import { parseWalkthroughAnchor } from './parse';

/** The Markdown Viewer's stack (spec 39/137), configured identically so a review
 *  renders exactly like a doc. A separate instance rather than an import, so the
 *  Board does not pull the whole viewer module (and its pretext dependency) in. */
const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

/** Rows above which a `diff` block renders as a summary the human expands with
 *  `Enter`, per the 16ms keypress budget (spec 211 Edge Cases). */
export const DIFF_SUMMARY_THRESHOLD = 2000;

// ─── Severity vocabulary ──────────────────────────────────────────────────

/** Chip label + tone class suffix for a finding severity. Tone drives the
 *  heading/chip colour only — never a left accent rail (house rule), and never a
 *  score or grade (ADR-0004). */
export function severityChip(severity: ReviewBlockSeverity): { label: string; tone: string } {
  switch (severity) {
    case 'blocking':
      return { label: 'BLOCK', tone: 'blocking' };
    case 'non-blocking':
      return { label: 'WARN', tone: 'warn' };
    case 'suggestion':
      return { label: 'SUGG', tone: 'sugg' };
  }
}

/** Glyph for a finding's triage state, matching the spec's legend. */
export function findingStateGlyph(state: 'accepted' | 'dismissed' | null): string {
  if (state === 'accepted') return '✓';
  if (state === 'dismissed') return '✗';
  return '·';
}

/** `file:line` corner label for a finding, or null when it carries no anchor. */
export function findingAnchorLabel(data: ReviewFindingBlock): string | null {
  if (!data.file) return null;
  return data.line !== undefined ? `${data.file}:${data.line}` : data.file;
}

// ─── SVG sanitizer ────────────────────────────────────────────────────────
// A review is lane-authored content, so an `svg` block is untrusted input on the
// way into the app's own DOM. Allowlist-only: anything not named here is dropped
// rather than escaped, because a half-understood SVG is not worth an XSS.

const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'marker', 'clipPath', 'mask', 'pattern',
  'linearGradient', 'radialGradient', 'stop',
]);

const SVG_ATTRIBUTES: ReadonlySet<string> = new Set([
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'class', 'id', 'offset', 'stop-color', 'stop-opacity',
  'text-anchor', 'dominant-baseline', 'font-size', 'font-family', 'font-weight',
  'letter-spacing', 'preserveaspectratio', 'gradientunits', 'patternunits',
  'clip-path', 'mask', 'marker-end', 'marker-start', 'vector-effect',
]);

/** Is this element name allowed to survive sanitization? */
export function isAllowedSvgElement(localName: string): boolean {
  return SVG_ELEMENTS.has(localName);
}

/**
 * Is this attribute allowed to survive sanitization? `name` is the local name;
 * `qualifiedName` is what was actually written, so a namespaced attribute
 * (`xlink:href`, `on:click`) is rejected even when its local name is on the
 * allowlist.
 */
export function isAllowedSvgAttribute(name: string, qualifiedName = name): boolean {
  if (qualifiedName.includes(':')) return false;
  return SVG_ATTRIBUTES.has(name.toLowerCase());
}

/** Attribute values that reach outside the document or execute — rejected
 *  whatever the attribute name. `url(#…)` stays: an internal reference to a
 *  `<defs>` in the same sanitized subtree is the whole point of gradients. */
export function isUnsafeAttrValue(value: string): boolean {
  const v = value.replace(/\s+/g, '').toLowerCase();
  if (v.includes('javascript:') || v.includes('data:text/html') || v.includes('vbscript:')) return true;
  // Any url() that is not a same-document fragment reference.
  return /url\((?!#)/.test(v);
}

export interface SanitizedSvg {
  /** The cleaned `<svg>` source, or an empty string when nothing survived. */
  svg: string;
  /** How many elements/attributes were dropped — surfaced as a diagnostic chip. */
  removed: number;
}

/**
 * Sanitize a lane-authored `<svg>` to the allowlist above using the browser's
 * own XML parser (never a regex — a regex sanitizer is a bug waiting to happen).
 * `<script>`, `<foreignObject>`, event handlers, and external references are all
 * dropped. Returns an empty `svg` when the source will not parse at all.
 */
export function sanitizeSvg(source: string): SanitizedSvg {
  let removed = 0;
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName === 'parsererror' || root.localName.toLowerCase() !== 'svg') {
    return { svg: '', removed: 1 };
  }

  const visit = (element: Element): void => {
    // Copy the child list first: the walk removes nodes as it goes.
    for (const child of Array.from(element.children)) {
      if (!isAllowedSvgElement(child.localName)) {
        child.remove();
        removed++;
        continue;
      }
      visit(child);
    }
    for (const attr of Array.from(element.attributes)) {
      if (!isAllowedSvgAttribute(attr.localName, attr.name) || isUnsafeAttrValue(attr.value)) {
        element.removeAttributeNode(attr);
        removed++;
      }
    }
  };
  visit(root);

  // Scale to the reading column rather than the lane's chosen pixel size, but
  // only when a viewBox makes that lossless.
  if (root.hasAttribute('viewBox')) {
    root.setAttribute('width', '100%');
    root.removeAttribute('height');
  }
  return { svg: root.outerHTML, removed };
}

// ─── Chart geometry ───────────────────────────────────────────────────────
// Single-series charts: one accent hue, no legend (the title names the series),
// thin marks, recessive axes, values as text tokens beside the mark rather than
// coloured. Horizontal bars because the labels are file paths and area names —
// they read left-to-right without rotation.

export interface ChartLayout {
  width: number;
  height: number;
  /** Left gutter reserved for category labels (bar charts only). */
  labelWidth: number;
  /** Right gutter reserved for the value readout. */
  valueWidth: number;
}

export const DEFAULT_CHART_LAYOUT: ChartLayout = {
  width: 640,
  height: 0, // derived from the row count for bars; fixed for line/sparkline
  labelWidth: 150,
  valueWidth: 64,
};

/** Height of one bar row, including its gap. */
const BAR_ROW_HEIGHT = 22;
const BAR_THICKNESS = 10;
/** Plot height for line / sparkline charts, which do not grow with the data. */
const LINE_PLOT_HEIGHT = 120;

export interface ChartBar {
  label: string;
  value: number;
  /** Bar rect, already inset from the label gutter. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Baseline y for the label text (vertically centred on the bar). */
  textY: number;
}

export interface ChartPoint {
  label: string;
  value: number;
  x: number;
  y: number;
}

export interface ChartGeometry {
  kind: ReviewChartBlock['kind'];
  width: number;
  height: number;
  /** Populated for `bar`. */
  bars: ChartBar[];
  /** Populated for `line` / `sparkline`. */
  points: ChartPoint[];
  /** `points` as an SVG polyline `points` attribute. Empty for `bar`. */
  polyline: string;
  /** Zero-baseline y in plot space, for the recessive axis rule. */
  baselineY: number;
  min: number;
  max: number;
}

/**
 * Lay a chart block out in SVG user space. Pure — no DOM, no CSS — so the
 * geometry (the part that silently goes wrong) is unit-testable.
 *
 * The value scale always includes zero, so a bar's length is proportional to its
 * value rather than to its distance from the smallest value (the truncated-axis
 * anti-pattern). A dataset with no spread degrades to full-length marks rather
 * than dividing by zero.
 */
export function chartGeometry(
  block: ReviewChartBlock,
  layout: ChartLayout = DEFAULT_CHART_LAYOUT,
): ChartGeometry {
  const data = block.data;
  const values = data.map((d) => d.value);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min;

  if (block.kind === 'bar') {
    const plotX = layout.labelWidth;
    const plotWidth = Math.max(1, layout.width - layout.labelWidth - layout.valueWidth);
    const height = Math.max(BAR_ROW_HEIGHT, data.length * BAR_ROW_HEIGHT);
    // Zero sits inside the plot only when the data straddles it.
    const zeroX = span === 0 ? plotX : plotX + ((0 - min) / span) * plotWidth;
    const bars: ChartBar[] = data.map((d, i) => {
      const y = i * BAR_ROW_HEIGHT + (BAR_ROW_HEIGHT - BAR_THICKNESS) / 2;
      const valueX = span === 0 ? plotX + plotWidth : plotX + ((d.value - min) / span) * plotWidth;
      const x = Math.min(zeroX, valueX);
      const width = Math.max(1, Math.abs(valueX - zeroX));
      return { label: d.label, value: d.value, x, y, width, height: BAR_THICKNESS, textY: y + BAR_THICKNESS };
    });
    return { kind: 'bar', width: layout.width, height, bars, points: [], polyline: '', baselineY: 0, min, max };
  }

  // line / sparkline: x by ordinal position, y inverted (SVG grows downward).
  const height = block.kind === 'sparkline' ? Math.round(LINE_PLOT_HEIGHT / 3) : LINE_PLOT_HEIGHT;
  const inset = 4; // keeps a ≥8px marker from clipping at the edges
  const plotWidth = Math.max(1, layout.width - inset * 2);
  const plotHeight = Math.max(1, height - inset * 2);
  const step = data.length > 1 ? plotWidth / (data.length - 1) : 0;
  const yFor = (value: number): number =>
    span === 0 ? inset + plotHeight / 2 : inset + plotHeight - ((value - min) / span) * plotHeight;
  const points: ChartPoint[] = data.map((d, i) => ({
    label: d.label,
    value: d.value,
    x: data.length > 1 ? inset + i * step : inset + plotWidth / 2,
    y: yFor(d.value),
  }));
  return {
    kind: block.kind,
    width: layout.width,
    height,
    bars: [],
    points,
    polyline: points.map((p) => `${round(p.x)},${round(p.y)}`).join(' '),
    baselineY: yFor(0),
    min,
    max,
  };
}

/** Two decimals max — keeps generated SVG attribute strings short and stable. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compact value readout beside a mark. Integers stay integers; fractions keep
 *  one decimal, so a bar row never wraps on a long float. */
export function formatChartValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ─── DOM builders ─────────────────────────────────────────────────────────

/** Per-block answer state the renderer needs to paint (owned by the view). */
export interface BlockAnswerState {
  findingState: 'accepted' | 'dismissed' | null;
  /** 1-based chosen option, or null when the decision is unanswered. */
  chosen: number | null;
  commentCount: number;
}

const EMPTY_ANSWER: BlockAnswerState = { findingState: null, chosen: null, commentCount: 0 };

export interface RenderContext {
  answerOf(blockId: string): BlockAnswerState;
  /** Resolve a relative image src to something the webview can load. */
  resolveImageSrc(src: string): string;
  /** True once a `diff` block over the summary threshold has been expanded. */
  isDiffExpanded(blockId: string): boolean;
}

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Build the DOM for one block. The wrapper always carries `data-block-id` and
 * `data-kind`, which is how the view's cursor, outline, and comment anchoring
 * address blocks — never a CSS selector into the rendered content (the crit
 * failure mode spec 211 was designed to avoid).
 */
export function renderBlock(block: ReviewBlock, ctx: RenderContext): HTMLElement {
  const wrapper = el('div', 'krypton-review__block');
  wrapper.dataset.blockId = block.id;
  wrapper.dataset.kind = block.kind;
  wrapper.classList.add(`krypton-review__block--${block.kind}`);

  const answer = ctx.answerOf(block.id) ?? EMPTY_ANSWER;

  switch (block.kind) {
    case 'markdown':
      wrapper.appendChild(renderMarkdown(block.raw, ctx));
      break;
    case 'walkthrough':
      wrapper.appendChild(renderWalkthrough(block));
      break;
    case 'diff':
      wrapper.appendChild(renderDiff(block, ctx.isDiffExpanded(block.id)));
      break;
    case 'finding':
      wrapper.appendChild(renderFinding(block, answer, ctx));
      break;
    case 'decision':
      wrapper.appendChild(renderDecision(block, answer));
      break;
    case 'chart':
      wrapper.appendChild(renderChart(block));
      break;
    case 'metrics':
      wrapper.appendChild(renderMetrics(block));
      break;
    case 'svg':
      wrapper.appendChild(renderSvg(block, wrapper));
      break;
  }

  if (block.diagnostic) {
    wrapper.appendChild(el('div', 'krypton-review__diagnostic', `⚠ ${block.diagnostic}`));
  }
  if (answer.commentCount > 0) {
    wrapper.appendChild(el('div', 'krypton-review__comment-mark', `✎ ${answer.commentCount}`));
  }
  return wrapper;
}

function renderMarkdown(source: string, ctx: RenderContext): HTMLElement {
  const host = el('div', 'krypton-review__md');
  // `parse` is synchronous with no async extensions registered; the cast-free
  // sync overload keeps the whole render pass off the microtask queue so a
  // refresh cannot interleave with the cursor restore.
  host.innerHTML = md.parse(source, { gfm: true, breaks: false, async: false });
  for (const img of Array.from(host.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') ?? '';
    if (src) img.setAttribute('src', ctx.resolveImageSrc(src));
  }
  return host;
}

function renderWalkthrough(block: Extract<ReviewBlock, { kind: 'walkthrough' }>): HTMLElement {
  const host = el('div', 'krypton-review__walkthrough');
  host.appendChild(
    el('div', 'krypton-review__walkthrough-title', block.data.title ?? 'read it in this order'),
  );
  const list = el('ol', 'krypton-review__steps');
  block.data.steps.forEach((step, i) => {
    const item = el('li', 'krypton-review__step');
    item.dataset.stepIndex = String(i);
    const anchor = parseWalkthroughAnchor(step.at);
    const at = el('span', 'krypton-review__step-at', anchor ? step.at : '(no anchor)');
    if (!anchor) at.classList.add('krypton-review__step-at--missing');
    item.append(at, el('span', 'krypton-review__step-say', step.say));
    list.appendChild(item);
  });
  host.appendChild(list);
  return host;
}

function renderDiff(block: Extract<ReviewBlock, { kind: 'diff' }>, expanded: boolean): HTMLElement {
  const host = el('div', 'krypton-review__diff');
  const lines = block.data.unified.split('\n').length;
  if (lines > DIFF_SUMMARY_THRESHOLD && !expanded) {
    host.appendChild(
      el('div', 'krypton-review__diff-summary', `${lines} diff lines — Enter to expand`),
    );
    return host;
  }
  try {
    host.innerHTML = diff2html(block.data.unified, {
      drawFileList: false,
      outputFormat: 'line-by-line',
      matching: 'lines',
    });
  } catch {
    // A fragment the lane wrote by hand may not carry a file header. Falling
    // back to the raw text keeps the change readable instead of blanking it.
    host.appendChild(el('pre', 'krypton-review__diff-raw', block.data.unified));
  }
  return host;
}

function renderFinding(
  block: Extract<ReviewBlock, { kind: 'finding' }>,
  answer: BlockAnswerState,
  ctx: RenderContext,
): HTMLElement {
  const host = el('div', 'krypton-review__finding');
  const chip = severityChip(block.data.severity);
  host.classList.add(`krypton-review__finding--${chip.tone}`);
  if (answer.findingState) host.classList.add(`krypton-review__finding--${answer.findingState}`);

  const head = el('div', 'krypton-review__finding-head');
  head.appendChild(el('span', 'krypton-review__severity', chip.label));
  head.appendChild(el('span', 'krypton-review__finding-title', block.data.title));
  const anchorLabel = findingAnchorLabel(block.data);
  if (anchorLabel) head.appendChild(el('span', 'krypton-review__finding-anchor', anchorLabel));
  head.appendChild(
    el('span', 'krypton-review__finding-state', findingStateGlyph(answer.findingState)),
  );
  host.appendChild(head);

  if (block.data.detail) host.appendChild(renderMarkdown(block.data.detail, ctx));
  return host;
}

function renderDecision(
  block: Extract<ReviewBlock, { kind: 'decision' }>,
  answer: BlockAnswerState,
): HTMLElement {
  const host = el('div', 'krypton-review__decision');
  host.appendChild(el('div', 'krypton-review__decision-question', block.data.question));
  const list = el('ol', 'krypton-review__options');
  block.data.options.forEach((option, i) => {
    const n = i + 1;
    const item = el('li', 'krypton-review__option');
    item.dataset.option = String(n);
    if (answer.chosen === n) item.classList.add('krypton-review__option--chosen');
    item.appendChild(el('span', 'krypton-review__option-key', String(n)));
    item.appendChild(el('span', 'krypton-review__option-text', option));
    if (block.data.recommended === n) {
      item.appendChild(el('span', 'krypton-review__option-rec', 'rec'));
    }
    list.appendChild(item);
  });
  host.appendChild(list);
  return host;
}

function renderChart(block: Extract<ReviewBlock, { kind: 'chart' }>): HTMLElement {
  const host = el('div', 'krypton-review__chart');
  // Single series: the title names it, so there is no legend box.
  if (block.data.title) host.appendChild(el('div', 'krypton-review__chart-title', block.data.title));

  const geom = chartGeometry(block.data);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${geom.width} ${geom.height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'krypton-review__chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `${block.data.title ?? 'chart'}: ${block.data.data.map((d) => `${d.label} ${d.value}`).join(', ')}`,
  );

  const ns = (tag: string): SVGElement => document.createElementNS('http://www.w3.org/2000/svg', tag);

  if (geom.kind === 'bar') {
    for (const bar of geom.bars) {
      const label = ns('text');
      label.setAttribute('x', String(DEFAULT_CHART_LAYOUT.labelWidth - 8));
      label.setAttribute('y', String(round(bar.textY - 1)));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('class', 'krypton-review__chart-label');
      label.textContent = bar.label;
      svg.appendChild(label);

      const rect = ns('rect');
      rect.setAttribute('x', String(round(bar.x)));
      rect.setAttribute('y', String(round(bar.y)));
      rect.setAttribute('width', String(round(bar.width)));
      rect.setAttribute('height', String(bar.height));
      // Rounded data-end only; the baseline end stays square.
      rect.setAttribute('rx', '2');
      rect.setAttribute('class', 'krypton-review__chart-bar');
      svg.appendChild(rect);

      const value = ns('text');
      value.setAttribute('x', String(round(bar.x + bar.width + 8)));
      value.setAttribute('y', String(round(bar.textY - 1)));
      value.setAttribute('class', 'krypton-review__chart-value');
      value.textContent = formatChartValue(bar.value);
      svg.appendChild(value);
    }
  } else {
    const line = ns('polyline');
    line.setAttribute('points', geom.polyline);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('class', 'krypton-review__chart-line');
    svg.appendChild(line);
    // Direct-label the extremes only — never a number on every point.
    const extremes = extremeIndices(geom.points.map((p) => p.value));
    geom.points.forEach((point, i) => {
      const dot = ns('circle');
      dot.setAttribute('cx', String(round(point.x)));
      dot.setAttribute('cy', String(round(point.y)));
      dot.setAttribute('r', geom.kind === 'sparkline' ? '2' : '4');
      dot.setAttribute('class', 'krypton-review__chart-dot');
      svg.appendChild(dot);
      if (geom.kind === 'sparkline' || !extremes.has(i)) return;
      const value = ns('text');
      value.setAttribute('x', String(round(point.x)));
      value.setAttribute('y', String(round(point.y - 8)));
      value.setAttribute('text-anchor', 'middle');
      value.setAttribute('class', 'krypton-review__chart-value');
      value.textContent = formatChartValue(point.value);
      svg.appendChild(value);
    });
  }

  host.appendChild(svg);
  return host;
}

/** Indices of the min and max value — the only points that get a direct label. */
export function extremeIndices(values: readonly number[]): Set<number> {
  if (values.length === 0) return new Set();
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[lo]) lo = i;
    if (values[i] > values[hi]) hi = i;
  }
  return new Set([lo, hi]);
}

function renderMetrics(block: Extract<ReviewBlock, { kind: 'metrics' }>): HTMLElement {
  const host = el('dl', 'krypton-review__metrics');
  for (const row of block.data.rows) {
    host.appendChild(el('dt', 'krypton-review__metric-label', row.label));
    host.appendChild(el('dd', 'krypton-review__metric-value', row.value));
  }
  return host;
}

function renderSvg(block: Extract<ReviewBlock, { kind: 'svg' }>, wrapper: HTMLElement): HTMLElement {
  const host = el('div', 'krypton-review__svg');
  const { svg, removed } = sanitizeSvg(block.data.svg);
  if (!svg) {
    host.appendChild(el('div', 'krypton-review__diagnostic', '⚠ svg could not be rendered safely'));
    return host;
  }
  host.innerHTML = svg;
  if (removed > 0) {
    // Report on the wrapper so it reads as one chip alongside a parse diagnostic.
    wrapper.dataset.svgRemoved = String(removed);
  }
  return host;
}
