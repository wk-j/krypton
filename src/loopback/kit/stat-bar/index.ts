// Spec 341 — the summary row: small muted label over a large accent numeral.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { reconcile } from '../../../ui/list';
import type { Tone } from '../badge';

import './stat-bar.css';

export interface Stat {
  readonly key: string;
  readonly label: string;
  readonly value: string | number;
  /** Numeral color; default accent. */
  readonly tone?: Tone;
  readonly title?: string;
}

class StatTile extends Component<Stat> {
  private readonly value = el('b', { class: 'lb-stat__value' });
  private readonly label = el('span', { class: 'lb-stat__label' });

  constructor(stat: Stat) {
    super(el('div', { class: 'lb-stat' }));
    this.el.append(this.value, this.label);
    this.update(stat);
  }

  protected readDeps(next: Stat): readonly unknown[] {
    return [next.label, next.value, next.tone, next.title];
  }

  protected paint(next: Stat): void {
    this.value.textContent = String(next.value);
    this.label.textContent = next.label;
    if (next.title) this.el.title = next.title;
    else this.el.removeAttribute('title');
    this.syncClasses(next);
  }

  protected syncClasses(next: Stat): void {
    this.el.className = next.tone && next.tone !== 'accent' ? `lb-stat lb-stat--${next.tone}` : 'lb-stat';
  }
}

export class StatBar extends Component<readonly Stat[]> {
  constructor(stats: readonly Stat[] = [], options: { align?: 'start' | 'end' } = {}) {
    super(el('div', { class: ['lb-stats', options.align === 'end' && 'lb-stats--end'] }));
    this.update(stats);
  }

  protected readDeps(next: readonly Stat[]): readonly unknown[] {
    return next.flatMap((s) => [s.key, s.label, s.value, s.tone, s.title]);
  }

  protected paint(next: readonly Stat[]): void {
    reconcile(this.el, next, {
      key: (stat) => stat.key,
      create: (stat) => new StatTile(stat),
      update: (tile, stat) => tile.update(stat),
    });
  }

  protected syncClasses(): void {
    /* the bar's classes never change */
  }
}
