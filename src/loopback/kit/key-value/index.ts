// Spec 341 — a label/value list (`.kv`, bare `dl` before).

import { el } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';

import './key-value.css';

export function keyValue(entries: readonly (readonly [label: string, value: ElChild])[]): HTMLDListElement {
  return el(
    'dl',
    { class: 'lb-kv' },
    ...entries.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', {}, value)]),
  );
}
