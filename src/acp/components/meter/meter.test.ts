import { describe, expect, it } from 'vitest';

import { Meter, type MeterProps } from './index';

const paint = (props: MeterProps): Meter => {
  const meter = new Meter(props.mode);
  meter.update(props);
  return meter;
};

describe('Meter — track', () => {
  it('emits the process-table CPU cell the string builder emits', () => {
    // harness-lane-chrome.ts:180 — renderMetricCell('cpu', formatCpu(12.4), metricPercent(12.4, 100)).
    const meter = paint({ mode: 'track', tone: 'cpu', valueText: '12.4%', value: 12.4, max: 100 });

    expect(meter.el.outerHTML).toBe(
      '<span class="acp-harness__metrics-meter acp-harness__metrics-meter--cpu">' +
        '<span class="acp-harness__metrics-meter-value">12.4%</span>' +
        '<span class="acp-harness__metrics-meter-track">' +
        '<span class="acp-harness__metrics-meter-fill" style="width:12%"></span>' +
        '</span>' +
        '</span>',
    );
  });

  it('emits the RSS cell against the machine total', () => {
    const meter = paint({ mode: 'track', tone: 'rss', valueText: '843M', value: 843, max: 16_384 });

    expect(meter.el.className).toBe('acp-harness__metrics-meter acp-harness__metrics-meter--rss');
    expect(meter.el.querySelector('.acp-harness__metrics-meter-fill')?.getAttribute('style')).toBe('width:5%');
  });

  it('clamps over-max, non-positive max and non-finite input the way metricPercent does', () => {
    const width = (value: number, max: number): string | null | undefined =>
      paint({ mode: 'track', tone: 'cpu', valueText: '', value, max })
        .el.querySelector('.acp-harness__metrics-meter-fill')
        ?.getAttribute('style');

    expect(width(180, 100)).toBe('width:100%');
    expect(width(-4, 100)).toBe('width:0%');
    expect(width(12, 0)).toBe('width:0%');
    expect(width(12, -1)).toBe('width:0%');
    expect(width(Number.NaN, 100)).toBe('width:0%');
    expect(width(Number.POSITIVE_INFINITY, 100)).toBe('width:0%');
    expect(width(12, Number.NaN)).toBe('width:0%');
  });

  it('re-derives the tone modifier when the cell changes kind of reading', () => {
    const meter = new Meter('track');
    meter.update({ mode: 'track', tone: 'cpu', valueText: '12.4%', value: 12.4, max: 100 });
    meter.update({ mode: 'track', tone: 'rss', valueText: '843M', value: 843, max: 16_384 });

    expect(meter.el.className).toBe('acp-harness__metrics-meter acp-harness__metrics-meter--rss');
  });

  it('keeps its child nodes and skips the write while the rounded width holds', () => {
    const meter = paint({ mode: 'track', tone: 'cpu', valueText: '12.4%', value: 12.4, max: 100 });
    const fill = meter.el.querySelector('.acp-harness__metrics-meter-fill');
    const valueNode = meter.el.querySelector('.acp-harness__metrics-meter-value')?.firstChild;

    meter.update({ mode: 'track', tone: 'cpu', valueText: '12.4%', value: 12.44, max: 100 });

    expect(meter.el.querySelector('.acp-harness__metrics-meter-value')?.firstChild).toBe(valueNode);
    expect(meter.el.querySelector('.acp-harness__metrics-meter-fill')).toBe(fill);
  });

  it('repaints the same nodes when the width actually moves', () => {
    const meter = paint({ mode: 'track', tone: 'cpu', valueText: '12.4%', value: 12.4, max: 100 });
    const fill = meter.el.querySelector('.acp-harness__metrics-meter-fill');

    meter.update({ mode: 'track', tone: 'cpu', valueText: '48.0%', value: 48, max: 100 });

    expect(meter.el.querySelector('.acp-harness__metrics-meter-fill')).toBe(fill);
    expect(fill?.getAttribute('style')).toBe('width:48%');
  });

  it('refuses to repaint as another mode instead of emitting the wrong block', () => {
    const meter = paint({ mode: 'track', tone: 'cpu', valueText: '12.4%', value: 12.4, max: 100 });

    expect(() => meter.update({ mode: 'glyph', value: 900 })).toThrow(/mode 'track'/);
  });
});

describe('Meter — glyph', () => {
  it('emits the thought-effort strip the DOM builder emits', () => {
    // harness-transcript-render.ts:92 — buildThoughtEffortMeter(900): ratio ~0.68 → 3 cells, 'deep'.
    const meter = paint({ mode: 'glyph', value: 900 });

    expect(meter.el.outerHTML).toBe(
      '<span class="acp-harness__thought-effort">' +
        '<span class="acp-harness__thought-effort-glyph">▰▰▰▱▱</span>' +
        '<span class="acp-harness__thought-effort-tier">deep</span>' +
        '</span>',
    );
  });

  it('walks the five tiers off the log scale', () => {
    const tier = (len: number): string | null =>
      paint({ mode: 'glyph', value: len }).el.querySelector('.acp-harness__thought-effort-tier')?.textContent ?? null;

    expect(tier(0)).toBe('brief');
    expect(tier(40)).toBe('brief');
    expect(tier(70)).toBe('brief');
    expect(tier(200)).toBe('considered');
    expect(tier(900)).toBe('deep');
    expect(tier(2200)).toBe('extended');
    expect(tier(4000)).toBe('exhaustive');
    expect(tier(40_000)).toBe('exhaustive');
  });

  it('always shows at least one filled cell, and never more than five', () => {
    const glyph = (len: number): string | null =>
      paint({ mode: 'glyph', value: len }).el.querySelector('.acp-harness__thought-effort-glyph')?.textContent ?? null;

    expect(glyph(0)).toBe('▰▱▱▱▱');
    expect(glyph(4000)).toBe('▰▰▰▰▰');
    expect(glyph(Number.MAX_SAFE_INTEGER)).toBe('▰▰▰▰▰');
  });

  it('does not rewrite the strip while the thought grows inside one tier', () => {
    const meter = paint({ mode: 'glyph', value: 900 });
    const glyphNode = meter.el.querySelector('.acp-harness__thought-effort-glyph')?.firstChild;

    meter.update({ mode: 'glyph', value: 905 });

    expect(meter.el.querySelector('.acp-harness__thought-effort-glyph')?.firstChild).toBe(glyphNode);

    meter.update({ mode: 'glyph', value: 2200 });

    expect(meter.el.querySelector('.acp-harness__thought-effort-tier')?.textContent).toBe('extended');
  });
});

describe('Meter — segments', () => {
  it('emits the usage cache track the DOM builder emits', () => {
    // harness-transcript-render.ts:156 — cachedRead/cachedWrite/input shares of the turn.
    const meter = paint({
      mode: 'segments',
      segments: [
        { tone: 'cache-read', value: 90_000 },
        { tone: 'cache-write', value: 8000 },
        { tone: 'input', value: 2000 },
      ],
    });

    expect(meter.el.outerHTML).toBe(
      '<div class="acp-harness__usage-cache-track" aria-hidden="true">' +
        '<span class="acp-harness__usage-cache-segment acp-harness__usage-cache-segment--cache-read" style="flex-grow: 0.9;"></span>' +
        '<span class="acp-harness__usage-cache-segment acp-harness__usage-cache-segment--cache-write" style="flex-grow: 0.08;"></span>' +
        '<span class="acp-harness__usage-cache-segment acp-harness__usage-cache-segment--input" style="flex-grow: 0.02;"></span>' +
        '</div>',
    );
  });

  it('drops empty segments and leaves an all-zero track bare', () => {
    const meter = paint({
      mode: 'segments',
      segments: [
        { tone: 'cache-read', value: 0 },
        { tone: 'cache-write', value: 1 },
        { tone: 'input', value: 3 },
      ],
    });

    expect([...meter.el.children].map((child) => child.className)).toStrictEqual([
      'acp-harness__usage-cache-segment acp-harness__usage-cache-segment--cache-write',
      'acp-harness__usage-cache-segment acp-harness__usage-cache-segment--input',
    ]);

    const empty = paint({ mode: 'segments', segments: [{ tone: 'input', value: 0 }] });
    expect(empty.el.children.length).toBe(0);
  });

  it('skips the rebuild while the shares hold, and rebuilds when one moves', () => {
    const meter = paint({
      mode: 'segments',
      segments: [
        { tone: 'cache-read', value: 3 },
        { tone: 'input', value: 1 },
      ],
    });
    const first = meter.el.firstElementChild;

    meter.update({
      mode: 'segments',
      segments: [
        { tone: 'cache-read', value: 30 },
        { tone: 'input', value: 10 },
      ],
    });
    expect(meter.el.firstElementChild).toBe(first);

    meter.update({
      mode: 'segments',
      segments: [
        { tone: 'cache-read', value: 1 },
        { tone: 'input', value: 1 },
      ],
    });
    expect(meter.el.firstElementChild).not.toBe(first);
    expect(meter.el.firstElementChild?.getAttribute('style')).toBe('flex-grow: 0.5;');
  });
});

describe('Meter — diffstat', () => {
  it('emits the git-diff stat bar the DOM builder emits', () => {
    // harness-tool-render.ts:901 — row { changes: 42, plus: 36, minus: 6 }, widest row 42.
    const meter = paint({ mode: 'diffstat', value: 36, minus: 6, max: 42 });

    expect(meter.el.outerHTML).toBe(
      '<span class="acp-harness__tool-stat-bar" ' +
        'style="--stat-plus-width: 85.71428571428571%; --stat-minus-width: 14.285714285714285%;"></span>',
    );
  });

  it('clamps a mark count above the widest row and a zero denominator', () => {
    const over = paint({ mode: 'diffstat', value: 80, minus: 0, max: 42 });
    expect(over.el.style.getPropertyValue('--stat-plus-width')).toBe('100%');

    const none = paint({ mode: 'diffstat', value: 4, minus: 2, max: 0 });
    expect(none.el.style.getPropertyValue('--stat-plus-width')).toBe('0%');
    expect(none.el.style.getPropertyValue('--stat-minus-width')).toBe('0%');

    const broken = paint({ mode: 'diffstat', value: Number.NaN, minus: 2, max: 42 });
    expect(broken.el.style.getPropertyValue('--stat-plus-width')).toBe('0%');
  });

  it('keeps the bar node when the shares change', () => {
    const meter = paint({ mode: 'diffstat', value: 36, minus: 6, max: 42 });
    const node = meter.el;

    meter.update({ mode: 'diffstat', value: 21, minus: 21, max: 42 });

    expect(meter.el).toBe(node);
    expect(node.style.getPropertyValue('--stat-plus-width')).toBe('50%');
    expect(node.style.getPropertyValue('--stat-minus-width')).toBe('50%');
  });
});
