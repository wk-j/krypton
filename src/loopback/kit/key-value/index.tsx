// Spec 341 — a label/value list (`.kv`, bare `dl` before).
// Spec 361: React component.

import { Fragment } from 'react';
import type { JSX, ReactNode } from 'react';

import './key-value.css';

export interface KeyValueProps {
  readonly entries: readonly (readonly [label: string, value: ReactNode])[];
}

export function KeyValue({ entries }: KeyValueProps): JSX.Element {
  return (
    <dl className="lb-kv">
      {entries.map(([label, value], i) => (
        <Fragment key={i}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
