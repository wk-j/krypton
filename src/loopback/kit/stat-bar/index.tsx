// Spec 341 — the summary row: small muted label over a large accent numeral.
// Spec 361: a pure component over `stats`, tiles keyed by `stat.key`.

import type { JSX } from 'react';

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

export interface StatBarProps {
  readonly stats?: readonly Stat[];
  readonly align?: 'start' | 'end';
}

function StatTile({ stat }: { readonly stat: Stat }): JSX.Element {
  return (
    <div className={stat.tone && stat.tone !== 'accent' ? `lb-stat lb-stat--${stat.tone}` : 'lb-stat'} title={stat.title || undefined}>
      <b className="lb-stat__value">{String(stat.value)}</b>
      <span className="lb-stat__label">{stat.label}</span>
    </div>
  );
}

export function StatBar({ stats = [], align = 'start' }: StatBarProps): JSX.Element {
  return (
    <div className={align === 'end' ? 'lb-stats lb-stats--end' : 'lb-stats'}>
      {stats.map((stat) => (
        <StatTile key={stat.key} stat={stat} />
      ))}
    </div>
  );
}
