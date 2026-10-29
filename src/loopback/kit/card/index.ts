// Spec 341 — the standard raised surface. Never nest one inside another.

import { el } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';

import './card.css';

export interface CardOptions {
  readonly title?: string;
  /** Right side of the heading row (a chip, a pill, a button). */
  readonly aside?: ElChild;
  readonly class?: string;
  readonly tag?: 'section' | 'article' | 'div';
}

export function card(options: CardOptions, ...children: readonly ElChild[]): HTMLElement {
  const head =
    options.title !== undefined || options.aside
      ? el('header', { class: 'lb-card__head' }, el('h3', { class: 'lb-card__title', text: options.title ?? '' }), options.aside)
      : null;
  return el(options.tag ?? 'section', { class: ['lb-card', options.class] }, head, ...children);
}
