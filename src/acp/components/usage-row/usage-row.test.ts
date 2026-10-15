import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageRow } from './index';
import type { RowProps } from '../transcript-row';
import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { UsageGroup, UsageRollup } from '../../usage-log';

function group(over: Partial<UsageGroup> & { key: string }): UsageGroup {
  return {
    turns: 11,
    inputTokens: 10_000,
    outputTokens: 12_400,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reportedCost: 0,
    ...over,
  };
}

function rollup(over: Partial<UsageRollup> = {}): UsageRollup {
  return {
    date: '2026-10-15',
    turns: 14,
    turnsWithoutTokens: 0,
    inputTokens: 10_000,
    outputTokens: 12_400,
    cachedReadTokens: 90_000,
    cachedWriteTokens: 0,
    reportedCost: 0.4412,
    reportedCostTurns: 14,
    currency: 'USD',
    byModel: [group({ key: 'claude-sonnet-4-5' })],
    byLane: [],
    unsent: 0,
    recording: true,
    ...over,
  };
}

function item(usage: UsageRollup): HarnessTranscriptItem {
  return { id: 'u1', kind: 'system', text: '[usage] 14 turns', usage };
}

function props(usage: UsageRollup): RowProps {
  return {
    item: item(usage),
    isNew: false,
    streaming: false,
    lane: null,
    projectDir: null,
    resolveLocalImages: false,
  };
}

function mount(usage: UsageRollup = rollup()): UsageRow {
  const row = new UsageRow(props(usage));
  row.update(props(usage));
  return row;
}

function text(row: UsageRow, selector: string): string | undefined {
  return row.el.querySelector(selector)?.textContent ?? undefined;
}

describe('UsageRow', () => {
  it('wraps the card in the usage row chrome', () => {
    const row = mount();

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system acp-harness__msg--usage');
    expect(text(row, '.acp-harness__msg-label')).toBe('usage');
    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body acp-harness__usage');
    const card = body?.firstElementChild;
    expect(card?.tagName).toBe('SECTION');
    expect(card?.className).toBe('acp-harness__usage-card');
    expect(card?.getAttribute('aria-label')).toBe('Usage for 2026-10-15');
  });

  it('emits the head, cache track, metric list, model table and foot in order', () => {
    const row = mount();
    const card = row.el.querySelector('.acp-harness__usage-card');

    expect([...(card?.children ?? [])].map((child) => child.className)).toEqual([
      'acp-harness__usage-head',
      'acp-harness__usage-cache',
      'acp-harness__usage-metrics acp-harness__usage-metrics--4',
      'acp-harness__usage-models',
      'acp-harness__usage-foot',
    ]);
    expect(text(row, '.acp-harness__usage-date')).toBe('2026-10-15');
    expect(text(row, '.acp-harness__usage-turns')).toBe('14 turns');
    expect(text(row, '.acp-harness__usage-cache-label')).toBe('Cache hit');
    expect(text(row, '.acp-harness__usage-cache-value')).toBe('90%');
    expect(text(row, '.acp-harness__usage-foot')).toBe('USD 0.4412 reported (14 turns)');
  });

  it('paints the cache track as flex-grown segments, dropping the empty one', () => {
    const row = mount();
    const track = row.el.querySelector('.acp-harness__usage-cache-track');

    expect(track?.getAttribute('aria-hidden')).toBe('true');
    expect([...(track?.children ?? [])].map((s) => s.className)).toEqual([
      'acp-harness__usage-cache-segment acp-harness__usage-cache-segment--cache-read',
      'acp-harness__usage-cache-segment acp-harness__usage-cache-segment--input',
    ]);
  });

  it('paints the metric list as a dl with one tone per metric', () => {
    const row = mount();
    const metrics = row.el.querySelector('.acp-harness__usage-metrics');

    expect(metrics?.tagName).toBe('DL');
    expect([...(metrics?.children ?? [])].map((m) => m.className)).toEqual([
      'acp-harness__usage-metric acp-harness__usage-metric--input',
      'acp-harness__usage-metric acp-harness__usage-metric--output',
      'acp-harness__usage-metric acp-harness__usage-metric--cache-read',
      'acp-harness__usage-metric acp-harness__usage-metric--cache-write',
    ]);
    expect(metrics?.firstElementChild?.innerHTML).toBe('<dt>Input</dt><dd>10.0k</dd>');
  });

  it('paints the model table head and one row per model', () => {
    const row = mount(rollup({ byModel: [group({ key: 'claude-sonnet-4-5' }), group({ key: 'gpt-5-codex', turns: 3 })] }));
    const models = row.el.querySelector('.acp-harness__usage-models');

    expect(models?.firstElementChild?.outerHTML).toBe(
      '<div class="acp-harness__usage-model-head">' +
        '<span>Model</span><span>Turns</span><span>Input</span><span>Output</span></div>',
    );
    expect(models?.children.length).toBe(3);
    expect(models?.children[1].outerHTML).toBe(
      '<div class="acp-harness__usage-model">' +
        '<span class="acp-harness__usage-model-name" title="claude-sonnet-4-5">claude-sonnet-4-5</span>' +
        '<span class="acp-harness__usage-model-stat">' +
        '<span class="acp-harness__usage-model-stat-label">Turns</span><span>11</span></span>' +
        '<span class="acp-harness__usage-model-stat">' +
        '<span class="acp-harness__usage-model-stat-label">Input</span><span>10.0k</span></span>' +
        '<span class="acp-harness__usage-model-stat">' +
        '<span class="acp-harness__usage-model-stat-label">Output</span><span>12.4k</span></span></div>',
    );
  });

  it('omits the cache block, the model table and the foot when the rollup has none', () => {
    const row = mount(
      rollup({
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        byModel: [],
        reportedCostTurns: 0,
        unsent: 0,
        turnsWithoutTokens: 0,
      }),
    );
    const card = row.el.querySelector('.acp-harness__usage-card');

    expect([...(card?.children ?? [])].map((child) => child.className)).toEqual([
      'acp-harness__usage-head',
      'acp-harness__usage-metrics acp-harness__usage-metrics--2',
    ]);
  });

  it('re-derives the metric grid class when the cache counters go back to zero', () => {
    const row = new UsageRow(props(rollup()));
    row.update(props(rollup()));
    expect(row.el.querySelector('.acp-harness__usage-metrics')?.className).toBe(
      'acp-harness__usage-metrics acp-harness__usage-metrics--4',
    );

    row.update(props(rollup({ cachedReadTokens: 0, cachedWriteTokens: 0 })));
    expect(row.el.querySelector('.acp-harness__usage-metrics')?.className).toBe(
      'acp-harness__usage-metrics acp-harness__usage-metrics--2',
    );
    expect(row.el.querySelector('.acp-harness__usage-cache')).toBeNull();
  });

  it('writes nothing when the rollup has not moved', () => {
    const row = mount();
    const segment = row.el.querySelector('.acp-harness__usage-cache-segment');
    const date = row.el.querySelector('.acp-harness__usage-date')?.firstChild;
    const modelName = row.el.querySelector('.acp-harness__usage-model-name')?.firstChild;

    row.update(props(rollup()));
    expect(row.el.querySelector('.acp-harness__usage-cache-segment')).toBe(segment);
    expect(row.el.querySelector('.acp-harness__usage-date')?.firstChild).toBe(date);
    expect(row.el.querySelector('.acp-harness__usage-model-name')?.firstChild).toBe(modelName);
  });

  it('leaves the cache track and the metric list untouched when only a model moves', () => {
    const row = mount();
    const segments = [...row.el.querySelectorAll('.acp-harness__usage-cache-segment')];
    const metricValues = [...row.el.querySelectorAll('.acp-harness__usage-metric dd')].map((dd) => dd.firstChild);
    const modelRow = row.el.querySelector('.acp-harness__usage-model');

    row.update(props(rollup({ byModel: [group({ key: 'claude-sonnet-4-5', turns: 12 })] })));

    expect([...row.el.querySelectorAll('.acp-harness__usage-cache-segment')]).toEqual(segments);
    expect([...row.el.querySelectorAll('.acp-harness__usage-metric dd')].map((dd) => dd.firstChild)).toEqual(
      metricValues,
    );
    expect(row.el.querySelector('.acp-harness__usage-model')).toBe(modelRow);
    expect(modelRow?.querySelector('.acp-harness__usage-model-stat span:last-child')?.textContent).toBe('12');
  });

  it('leaves the cache track and the model table untouched when only output tokens move', () => {
    const row = mount();
    const segments = [...row.el.querySelectorAll('.acp-harness__usage-cache-segment')];
    const modelCells = [...row.el.querySelectorAll('.acp-harness__usage-model span')].map((s) => s.firstChild);

    row.update(props(rollup({ outputTokens: 99_000 })));

    expect([...row.el.querySelectorAll('.acp-harness__usage-cache-segment')]).toEqual(segments);
    expect([...row.el.querySelectorAll('.acp-harness__usage-model span')].map((s) => s.firstChild)).toEqual(
      modelCells,
    );
    expect(row.el.querySelectorAll('.acp-harness__usage-metric dd')[1].textContent).toBe('99.0k');
  });

  it('drops a model that fell out of the rollup and keeps the one that stayed', () => {
    const row = mount(rollup({ byModel: [group({ key: 'a' }), group({ key: 'b' })] }));
    const first = row.el.querySelector('.acp-harness__usage-model');

    row.update(props(rollup({ byModel: [group({ key: 'a' })] })));
    const models = row.el.querySelector('.acp-harness__usage-models');
    expect(models?.children.length).toBe(2);
    expect(models?.children[1]).toBe(first);
  });

  it('appends every notice to the foot and clears it when they resolve', () => {
    const row = mount(rollup({ turnsWithoutTokens: 2, unsent: 1 }));
    expect([...row.el.querySelectorAll('.acp-harness__usage-foot span')].map((s) => s.textContent)).toEqual([
      'USD 0.4412 reported (14 turns)',
      '2 turns reported no token counters',
      '1 rows not yet accepted by Xenon (will retry)',
    ]);

    row.update(props(rollup({ reportedCostTurns: 0 })));
    expect(row.el.querySelector('.acp-harness__usage-foot')).toBeNull();
  });

  it('stops listening for the entrance animation once disposed', () => {
    const row = new UsageRow({ ...props(rollup()), isNew: true });
    row.update({ ...props(rollup()), isNew: true });
    expect(row.el.className).toContain('acp-harness__msg--enter');

    row.dispose();
    const event = new Event('animationend');
    Object.defineProperty(event, 'animationName', { value: 'acp-harness-msg-enter' });
    row.el.dispatchEvent(event);
    expect(row.el.className).toContain('acp-harness__msg--enter');
  });
});

// Spec 250, moved from `harness-transcript-render.test.ts`, where it read
// `src/styles/acp-harness.css`. The #usage row is a historical readout, not a
// live surface: a bordered card that establishes its own containment and never
// animates, sized by container queries rather than the viewport.
describe('UsageRow stylesheet', () => {
  const css = readFileSync(join(import.meta.dirname, 'usage-row.css'), 'utf8');

  it('frames the card on all four sides and contains its own layout', () => {
    const cardRule = css.match(/\.acp-harness__usage-card\s*\{([\s\S]*?)\n\s*\}/)?.[1];
    expect(cardRule).toContain('contain: content');
    expect(cardRule).toContain('border: 1px solid');
    expect(cardRule).not.toContain('border-left');
  });

  it('reflows on container width, never viewport width', () => {
    expect(css).toContain('@container (max-width: 680px)');
    expect(css).toContain('@container (max-width: 420px)');
  });

  it('never animates a usage rule', () => {
    expect(css).not.toMatch(/\.acp-harness__usage[^{]*\{[^}]*animation:/s);
  });
});
