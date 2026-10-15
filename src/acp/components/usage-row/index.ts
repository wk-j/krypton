// Spec 302 §3.13 — `UsageRow`.
//
// The `#usage` rollup card (spec 250): one bounded telemetry readout, no
// timers and no animation, because it is a historical record rather than a live
// status surface. Ported from `renderUsageSummaryBody`
// (`harness-transcript-render.ts:125-249`) plus the wrapper logic at `:375-378`.
//
// The three variable regions are independent sub-components, so a rollup that
// only moved the cache numbers rewrites the cache track and nothing else:
//
//   `-cache`    → `Meter` in `segments` mode (the track is its root)
//   `-metrics`  → `StatList` in `dl` layout
//   `-models`   → `UsageModels` below, a keyed list over `UsageModelRow`
//
// `UsageModels` keeps its own map instead of calling `reconcile()` because the
// `-model-head` row is a sibling of the data rows inside
// `.acp-harness__usage-models`, and `reconcile()` owns every child of its
// container. `syncOrder()` — the same placement primitive — takes the head as
// the first node and the list stays authoritative.
//
// The dependency tuple is read off the ROLLUP, not off the derived summary: the
// harness mutates the rollup in place, so `UsageVisualSummary` is rebuilt from
// it on every paint and must never be the thing compared.

import './usage-row.css';

import { Component } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { Meter } from '../meter';
import { StatList, type StatRowProps } from '../stat-list';
import { TranscriptRow, type RowProps } from '../transcript-row';
import { buildUsageVisualSummary, type UsageRollup, type UsageVisualSummary } from '../../usage-log';
import type { ComponentDef } from '../types';

type UsageModel = UsageVisualSummary['models'][number];

const MODEL_COLUMNS = ['Model', 'Turns', 'Input', 'Output'] as const;

/** Write only when the text actually moved: the row repaints whenever ANY part
 *  of the rollup changed, and the parts that did not change must not be
 *  rewritten. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

class UsageModelRow extends Component<UsageModel> {
  private readonly name: HTMLElement;
  private readonly values: readonly HTMLElement[];

  constructor() {
    const name = el('span', { class: 'acp-harness__usage-model-name' });
    const values = MODEL_COLUMNS.slice(1).map(() => el('span'));
    const stats = values.map((value, i) =>
      el(
        'span',
        { class: 'acp-harness__usage-model-stat' },
        el('span', { class: 'acp-harness__usage-model-stat-label', text: MODEL_COLUMNS[i + 1] }),
        value,
      ),
    );
    super(el('div', { class: 'acp-harness__usage-model' }, name, ...stats));
    this.name = name;
    this.values = values;
  }

  protected readDeps(next: UsageModel): readonly unknown[] {
    return [next.name, next.turns, next.input, next.output];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__usage-model';
  }

  protected paint(next: UsageModel): void {
    this.syncClasses();
    setText(this.name, next.name);
    this.name.title = next.name;
    const cells = [next.turns, next.input, next.output];
    for (let i = 0; i < this.values.length; i++) setText(this.values[i], cells[i]);
  }
}

interface UsageModelsProps {
  readonly models: readonly UsageModel[];
}

class UsageModels extends Component<UsageModelsProps> {
  private readonly head: HTMLElement;
  private readonly rows = new Map<string, UsageModelRow>();

  constructor() {
    super(el('div', { class: 'acp-harness__usage-models' }));
    this.head = el(
      'div',
      { class: 'acp-harness__usage-model-head' },
      ...MODEL_COLUMNS.map((text) => el('span', { text })),
    );
    this.el.appendChild(this.head);
  }

  protected readDeps(next: UsageModelsProps): readonly unknown[] {
    return [next.models.map((m) => `${m.name}\u0000${m.turns}\u0000${m.input}\u0000${m.output}`).join('\u0001')];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__usage-models';
  }

  protected paint(next: UsageModelsProps): void {
    this.syncClasses();
    const kept = new Set<string>();
    const nodes: HTMLElement[] = [this.head];
    for (const model of next.models) {
      // Two groups can share a model key only if the rollup is malformed; the
      // suffix keeps the map total rather than dropping a row.
      let key = model.name;
      for (let n = 2; kept.has(key); n++) key = `${model.name}#${n}`;
      kept.add(key);
      const row = this.rows.get(key) ?? new UsageModelRow();
      this.rows.set(key, row);
      row.update(model);
      nodes.push(row.el);
    }
    for (const [key, row] of this.rows) {
      if (kept.has(key)) continue;
      this.rows.delete(key);
      row.dispose();
    }
    syncOrder(this.el, nodes);
  }

  protected onDispose(): void {
    for (const row of this.rows.values()) row.dispose();
    this.rows.clear();
  }
}

export class UsageRow extends TranscriptRow {
  private readonly card: HTMLElement;
  private readonly head: HTMLElement;
  private readonly date: HTMLElement;
  private readonly turns: HTMLElement;
  private readonly cache: HTMLElement;
  private readonly cacheValue: HTMLElement;
  private readonly track: Meter;
  private readonly metrics: StatList;
  private readonly models: UsageModels;
  private readonly foot: HTMLElement;
  /** The foot has no sub-component of its own — its children are classless
   *  spans — so its own small signature guards the rewrite. */
  private footKey: string | null = null;

  constructor(props: RowProps) {
    super(props, false);
    this.date = el('span', { class: 'acp-harness__usage-date' });
    this.turns = el('span', { class: 'acp-harness__usage-turns' });
    this.cacheValue = el('strong', { class: 'acp-harness__usage-cache-value' });
    this.cache = el(
      'div',
      { class: 'acp-harness__usage-cache' },
      el('span', { class: 'acp-harness__usage-cache-label', text: 'Cache hit' }),
      this.cacheValue,
    );
    this.track = new Meter('segments');
    this.metrics = new StatList('dl');
    this.models = new UsageModels();
    this.foot = el('footer', { class: 'acp-harness__usage-foot' });
    this.head = el('header', { class: 'acp-harness__usage-head' }, this.date, this.turns);
    this.card = el('section', { class: 'acp-harness__usage-card' }, this.head);
  }

  protected wrapperModifiers(): readonly string[] {
    return ['acp-harness__msg--usage'];
  }

  protected labelText(): string {
    return 'usage';
  }

  protected bodyClasses(): readonly string[] {
    return ['acp-harness__usage'];
  }

  /** Every field `buildUsageVisualSummary()` reads. The rollup object is
   *  mutated in place by the usage log, so its identity proves nothing. */
  protected bodyDeps(next: RowProps): readonly unknown[] {
    const usage = next.item.usage;
    if (!usage) return ['none', next.item.text];
    return [
      usage.date,
      usage.turns,
      usage.turnsWithoutTokens,
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedReadTokens,
      usage.cachedWriteTokens,
      usage.reportedCost,
      usage.reportedCostTurns,
      usage.currency,
      usage.unsent,
      usage.byModel
        .map((g) => `${g.key}\u0000${g.turns}\u0000${g.inputTokens}\u0000${g.outputTokens}`)
        .join('\u0001'),
    ];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const usage = next.item.usage;
    if (!usage) {
      setChildren(body, [next.item.text]);
      return;
    }
    this.paintCard(buildUsageVisualSummary(usage));
    setChildren(body, [this.card]);
  }

  private paintCard(summary: UsageVisualSummary): void {
    this.card.setAttribute('aria-label', `Usage for ${summary.date}`);
    setText(this.date, summary.date);
    setText(this.turns, summary.turns);

    const children: HTMLElement[] = [this.head];
    if (summary.segments.cachedRead > 0 || summary.segments.cachedWrite > 0) {
      setText(this.cacheValue, summary.cachePercent ?? 'unavailable');
      if (summary.cachePercent === null) this.track.el.remove();
      else {
        this.track.update({
          mode: 'segments',
          segments: [
            { tone: 'cache-read', value: summary.segments.cachedRead },
            { tone: 'cache-write', value: summary.segments.cachedWrite },
            { tone: 'input', value: summary.segments.input },
          ],
        });
        this.cache.appendChild(this.track.el);
      }
      children.push(this.cache);
    }

    const rows: StatRowProps[] = summary.metrics.map((metric) => ({
      key: metric.tone,
      label: metric.label,
      value: metric.value,
      tone: metric.tone,
    }));
    this.metrics.update({
      rows,
      block: 'acp-harness__usage-metric',
      layout: 'dl',
      rootClass: `acp-harness__usage-metrics acp-harness__usage-metrics--${summary.metrics.length}`,
    });
    children.push(this.metrics.el);

    if (summary.models.length > 0) {
      this.models.update({ models: summary.models });
      children.push(this.models.el);
    }

    const footKey = `${summary.cost ?? ''}\u0001${summary.notices.join('\u0001')}`;
    if (summary.cost !== null || summary.notices.length > 0) {
      if (this.footKey !== footKey) {
        const parts = summary.cost === null ? summary.notices : [summary.cost, ...summary.notices];
        setChildren(this.foot, parts.map((text) => el('span', { text })));
      }
      children.push(this.foot);
    }
    this.footKey = footKey;

    setChildren(this.card, children);
  }

  protected onDispose(): void {
    super.onDispose();
    this.track.dispose();
    this.metrics.dispose();
    this.models.dispose();
  }
}

export const def: ComponentDef = {
  id: 'usage-row',
  blocks: ['acp-harness__msg--usage', 'acp-harness__usage'],
};
