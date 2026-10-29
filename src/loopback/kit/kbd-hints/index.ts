// Spec 341 — the key-hint footer (`.shortcuts`, `.keys`, `.hint` before).

import { el } from '../../../ui/dom';

import './kbd-hints.css';

/** `[['j / k', 'move'], ['Enter', 'open']]` → `j / k move · Enter open`. */
export function kbdHints(entries: readonly (readonly [keys: string, label: string])[], note?: string): HTMLElement {
  return el(
    'footer',
    { class: 'lb-hints' },
    ...entries.map(([keys, label]) => el('span', { class: 'lb-hints__item' }, el('kbd', { text: keys }), ` ${label}`)),
    note ? el('span', { class: 'lb-hints__note', text: note }) : null,
  );
}
