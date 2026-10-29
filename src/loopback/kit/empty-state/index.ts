// Spec 341 — every list and grid has one: a centred muted mono line.

import { el } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';

import './empty-state.css';

export function emptyState(text: string, ...extra: readonly ElChild[]): HTMLElement {
  return el('div', { class: 'lb-empty' }, el('p', { class: 'lb-empty__text', text }), ...extra);
}
