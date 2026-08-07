import { describe, expect, it } from 'vitest';

import {
  chartGeometry,
  DEFAULT_CHART_LAYOUT,
  extremeIndices,
  findingAnchorLabel,
  findingStateGlyph,
  formatChartValue,
  isAllowedSvgAttribute,
  isAllowedSvgElement,
  isUnsafeAttrValue,
  severityChip,
} from './render';
import type { ReviewChartBlock } from '../acp/types';

// spec 211 — the renderer's pure core. The DOM assembly is thin and visible; the
// parts that can be silently wrong are the geometry (a truncated axis lies about
// the data) and the sanitizer policy (a hole in the allowlist is an XSS), so
// those are covered here. This repo has no DOM test environment, so the
// sanitizer is tested through its exported policy predicates rather than by
// feeding markup through DOMParser.

const chart = (
  kind: ReviewChartBlock['kind'],
  data: [string, number][],
  title?: string,
): ReviewChartBlock => ({ kind, title, data: data.map(([label, value]) => ({ label, value })) });

describe('severity vocabulary', () => {
  it('maps each severity to a chip label and tone', () => {
    expect(severityChip('blocking')).toEqual({ label: 'BLOCK', tone: 'blocking' });
    expect(severityChip('non-blocking')).toEqual({ label: 'WARN', tone: 'warn' });
    expect(severityChip('suggestion')).toEqual({ label: 'SUGG', tone: 'sugg' });
  });

  it('renders the triage state as a glyph, open by default', () => {
    expect(findingStateGlyph(null)).toBe('·');
    expect(findingStateGlyph('accepted')).toBe('✓');
    expect(findingStateGlyph('dismissed')).toBe('✗');
  });

  it('labels a finding anchor only when it has one', () => {
    expect(findingAnchorLabel({ severity: 'blocking', title: 't', file: 'a.ts', line: 12 })).toBe('a.ts:12');
    expect(findingAnchorLabel({ severity: 'blocking', title: 't', file: 'a.ts' })).toBe('a.ts');
    expect(findingAnchorLabel({ severity: 'blocking', title: 't' })).toBeNull();
  });
});

describe('chartGeometry — bar', () => {
  it('makes bar length proportional to value, not to distance from the smallest', () => {
    // The truncated-axis anti-pattern: with a min-anchored scale the 100 bar
    // would be zero-length. Including zero keeps 200 exactly twice 100.
    const geom = chartGeometry(chart('bar', [['a', 100], ['b', 200]]));
    expect(geom.min).toBe(0);
    expect(geom.max).toBe(200);
    expect(geom.bars[1].width).toBeCloseTo(geom.bars[0].width * 2, 5);
  });

  it('grows height with the row count and keeps rows in data order', () => {
    const one = chartGeometry(chart('bar', [['a', 1]]));
    const three = chartGeometry(chart('bar', [['a', 1], ['b', 2], ['c', 3]]));
    expect(three.height).toBe(one.height * 3);
    expect(three.bars.map((b) => b.label)).toEqual(['a', 'b', 'c']);
    expect(three.bars[0].y).toBeLessThan(three.bars[1].y);
  });

  it('keeps every bar inside the plot area', () => {
    const geom = chartGeometry(chart('bar', [['acp/', 152], ['diff-view', 41], ['compositor', 21]]));
    const plotRight = DEFAULT_CHART_LAYOUT.width - DEFAULT_CHART_LAYOUT.valueWidth;
    for (const bar of geom.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(DEFAULT_CHART_LAYOUT.labelWidth);
      expect(bar.x + bar.width).toBeLessThanOrEqual(plotRight + 0.001);
    }
  });

  it('straddles zero when the data has negative values', () => {
    const geom = chartGeometry(chart('bar', [['gained', 40], ['lost', -40]]));
    expect(geom.min).toBe(-40);
    expect(geom.max).toBe(40);
    // The negative bar ends where the positive one starts: a shared zero line.
    expect(geom.bars[1].x + geom.bars[1].width).toBeCloseTo(geom.bars[0].x, 5);
  });

  it('degrades a zero-spread dataset to full-length bars instead of dividing by zero', () => {
    const geom = chartGeometry(chart('bar', [['a', 0], ['b', 0]]));
    for (const bar of geom.bars) {
      expect(Number.isFinite(bar.width)).toBe(true);
      expect(bar.width).toBeGreaterThan(0);
    }
  });

  it('never produces a zero-width bar for a nonzero value', () => {
    const geom = chartGeometry(chart('bar', [['tiny', 1], ['huge', 100000]]));
    expect(geom.bars[0].width).toBeGreaterThanOrEqual(1);
  });
});

describe('chartGeometry — line and sparkline', () => {
  it('spaces points evenly and inverts y so larger values sit higher', () => {
    const geom = chartGeometry(chart('line', [['t1', 1], ['t2', 5], ['t3', 3]]));
    expect(geom.points).toHaveLength(3);
    const gapA = geom.points[1].x - geom.points[0].x;
    const gapB = geom.points[2].x - geom.points[1].x;
    expect(gapA).toBeCloseTo(gapB, 5);
    // y grows downward in SVG space, so the largest value has the smallest y.
    expect(geom.points[1].y).toBeLessThan(geom.points[2].y);
    expect(geom.points[2].y).toBeLessThan(geom.points[0].y);
  });

  it('emits a polyline attribute matching the points', () => {
    const geom = chartGeometry(chart('line', [['a', 1], ['b', 2]]));
    expect(geom.polyline.split(' ')).toHaveLength(2);
    expect(geom.polyline).toMatch(/^[\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
  });

  it('centres a single point rather than pinning it to the left edge', () => {
    const geom = chartGeometry(chart('line', [['only', 7]]));
    expect(geom.points[0].x).toBeCloseTo(DEFAULT_CHART_LAYOUT.width / 2, 0);
  });

  it('draws a sparkline shorter than a full line chart', () => {
    expect(chartGeometry(chart('sparkline', [['a', 1], ['b', 2]])).height).toBeLessThan(
      chartGeometry(chart('line', [['a', 1], ['b', 2]])).height,
    );
  });

  it('keeps points inside the plot box so markers do not clip', () => {
    const geom = chartGeometry(chart('line', [['a', 0], ['b', 100]]));
    for (const p of geom.points) {
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(geom.height);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(geom.width);
    }
  });
});

describe('chart labelling', () => {
  it('direct-labels only the extremes, never every point', () => {
    expect(extremeIndices([5, 1, 3, 9, 4])).toEqual(new Set([1, 3]));
    expect(extremeIndices([])).toEqual(new Set());
    // A flat series collapses to one labelled point rather than labelling all.
    expect(extremeIndices([2, 2, 2])).toEqual(new Set([0]));
  });

  it('keeps integers integral and fractions to one decimal', () => {
    expect(formatChartValue(152)).toBe('152');
    expect(formatChartValue(1.25)).toBe('1.3');
    expect(formatChartValue(-4)).toBe('-4');
  });
});

describe('svg sanitizer policy', () => {
  it('allows the shape and text vocabulary a diagram needs', () => {
    for (const name of ['svg', 'g', 'path', 'rect', 'circle', 'text', 'linearGradient', 'stop']) {
      expect(isAllowedSvgElement(name)).toBe(true);
    }
  });

  it('rejects script, foreignObject, and anything that can navigate or embed', () => {
    for (const name of ['script', 'foreignObject', 'iframe', 'image', 'a', 'animate', 'set', 'style']) {
      expect(isAllowedSvgElement(name)).toBe(false);
    }
  });

  it('rejects every event handler attribute', () => {
    for (const name of ['onclick', 'onload', 'onmouseover', 'onbegin', 'onfocusin']) {
      expect(isAllowedSvgAttribute(name)).toBe(false);
    }
  });

  it('rejects a namespaced attribute even when its local name is allowed', () => {
    expect(isAllowedSvgAttribute('href', 'xlink:href')).toBe(false);
    // `class` is on the allowlist, but only unqualified.
    expect(isAllowedSvgAttribute('class', 'class')).toBe(true);
    expect(isAllowedSvgAttribute('class', 'xlink:class')).toBe(false);
  });

  it('allows presentation attributes case-insensitively', () => {
    expect(isAllowedSvgAttribute('viewbox')).toBe(true);
    expect(isAllowedSvgAttribute('viewBox')).toBe(true);
    expect(isAllowedSvgAttribute('stroke-width')).toBe(true);
  });

  it('rejects executable and external attribute values', () => {
    expect(isUnsafeAttrValue('javascript:alert(1)')).toBe(true);
    expect(isUnsafeAttrValue('JaVaScRiPt:alert(1)')).toBe(true);
    expect(isUnsafeAttrValue('java\tscript:alert(1)')).toBe(true); // whitespace-split bypass
    expect(isUnsafeAttrValue('vbscript:msgbox')).toBe(true);
    expect(isUnsafeAttrValue('data:text/html,<script>')).toBe(true);
    expect(isUnsafeAttrValue('url(https://evil.test/x.png)')).toBe(true);
    expect(isUnsafeAttrValue('url( //evil.test/x.png )')).toBe(true);
  });

  it('allows same-document fragment references, which gradients depend on', () => {
    expect(isUnsafeAttrValue('url(#grad-1)')).toBe(false);
    expect(isUnsafeAttrValue('#grad-1')).toBe(false);
    expect(isUnsafeAttrValue('M0 0 L10 10')).toBe(false);
    expect(isUnsafeAttrValue('rgb(255, 0, 0)')).toBe(false);
  });
});
