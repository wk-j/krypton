// Spec 341 — status pill, live dot and count chip. One meaning each: the old
// pages used `.chip` for five different things. Spec 361: React components.

import type { JSX } from 'react';

import './badge.css';

export type Tone = 'accent' | 'add' | 'del' | 'muted';

/** DESIGN.binance.md status table — the dashboard and gallery must agree. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'starting':
    case 'needs_permission':
    case 'pending':
      return 'accent';
    case 'busy':
    case 'live':
    case 'running':
    case 'pass':
      return 'add';
    case 'awaiting_peer':
    case 'error':
    case 'fail':
      return 'del';
    default:
      return 'muted';
  }
}

export interface PillProps {
  readonly label: string;
  readonly tone: Tone;
  readonly title?: string;
  readonly hidden?: boolean;
}

/** A state badge (never a button): mono label with a leading dot. */
export function Pill({ label, tone, title, hidden }: PillProps): JSX.Element {
  return (
    <span className={`lb-pill lb-pill--${tone}`} title={title} hidden={hidden}>
      {label}
    </span>
  );
}

export type DotState = 'idle' | 'live' | 'add' | 'accent' | 'del';

export interface DotProps {
  readonly state?: DotState;
  readonly title?: string;
}

/** 10px status dot; `live` carries the one sanctioned animation (`beacon`), `add` is a static success. */
export function Dot({ state = 'idle', title }: DotProps): JSX.Element {
  return <span className={state === 'idle' ? 'lb-dot' : `lb-dot lb-dot--${state}`} title={title} aria-hidden="true" />;
}

export interface ChipProps {
  readonly text: string;
  /** Red numeral. */
  readonly alert?: boolean;
  /** A constraint/meta label rather than a count. */
  readonly muted?: boolean;
  readonly title?: string;
}

/** A capsule: a count (accent numeral, red when `alert`) or, `muted`, a constraint/meta label. */
export function Chip({ text, alert = false, muted = false, title }: ChipProps): JSX.Element {
  let className = 'lb-chip';
  if (alert) className += ' lb-chip--alert';
  if (muted) className += ' lb-chip--muted';
  return (
    <span className={className} title={title}>
      {text}
    </span>
  );
}
