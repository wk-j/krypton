// Spec 341 — status pill, live dot and count chip. One meaning each: the old
// pages used `.chip` for five different things.

import { el } from '../../../ui/dom';

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

/** A state badge (never a button): mono label with a leading dot. */
export function pill(label: string, tone: Tone, title?: string): HTMLSpanElement {
  return el('span', { class: ['lb-pill', `lb-pill--${tone}`], text: label, title });
}

/** 10px status dot; `live` carries the one sanctioned animation (`beacon`), `add` is a static success. */
export function dot(state: 'idle' | 'live' | 'add' | 'accent' | 'del' = 'idle', title?: string): HTMLSpanElement {
  return el('span', { class: ['lb-dot', state !== 'idle' && `lb-dot--${state}`], title, attrs: { 'aria-hidden': 'true' } });
}

/** A capsule: a count (accent numeral, red when `alert`) or, `muted`, a constraint/meta label. */
export function chip(text: string, options: { alert?: boolean; muted?: boolean; title?: string } = {}): HTMLSpanElement {
  return el('span', {
    class: ['lb-chip', options.alert && 'lb-chip--alert', options.muted && 'lb-chip--muted'],
    text,
    title: options.title,
  });
}
