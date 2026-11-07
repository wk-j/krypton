// Spec 369 — keyboard shortcuts as key caps.
//
// Every shortcut the app draws in DOM text is a `<kbd>` cap (one shared rule in
// src/styles/kbd.css) followed by its action as printed legend. This module is
// the one place that builds them, so no surface spells a key as `[a]` or
// `esc close` again. Cap legends follow spec 369 §Cap legends: letters as
// typed (`a`, `A`), named keys as words (`Esc`, `Enter`, `Tab`), modifiers as
// macOS symbols inside the cap (`⌘Enter`, `⌃C`).

import { el } from './dom';

export interface KeyHint {
  /** Each key becomes one `<kbd>` cap. Empty: the hint is legend only. */
  readonly keys: readonly string[];
  /** Printed legend after the caps. May be empty. */
  readonly label: string;
  /** Joins this hint's caps. Default `' '`; alternatives use `'/'`. */
  readonly keySeparator?: string;
}

/** One cap: `<kbd>key</kbd>`. */
export function keyCap(key: string): HTMLElement {
  return el('kbd', { text: key });
}

/**
 * One hint as a node. A hint with keys is `<span class="krypton-key-hint">`
 * holding its caps and legend, so it never wraps between a cap and its words.
 * A legend-only hint is a bare text node (so a long sentence can still wrap),
 * unless `className` asks for a span to colour it.
 */
export function keyHint(hint: KeyHint, className?: string): Node {
  if (hint.keys.length === 0 && !className) return document.createTextNode(hint.label);
  const separator = hint.keySeparator ?? ' ';
  const span = el('span', { class: hint.keys.length > 0 ? ['krypton-key-hint', className] : className });
  hint.keys.forEach((key, index) => {
    if (index > 0 && separator) span.append(separator);
    span.append(keyCap(key));
  });
  if (hint.label) span.append(hint.keys.length > 0 ? ` ${hint.label}` : hint.label);
  return span;
}

/** A run of hints joined by `separator` (default `' · '`). */
export function keyHintNodes(hints: readonly KeyHint[], separator = ' · '): Node[] {
  const out: Node[] = [];
  hints.forEach((hint, index) => {
    if (index > 0 && separator) out.push(document.createTextNode(separator));
    out.push(keyHint(hint));
  });
  return out;
}

/** Content signature for a dependency tuple: equal hints compare equal. */
export function keyHintsSignature(hints: readonly KeyHint[]): string {
  return hints
    .map((hint) => `${hint.keys.join('\u0000')}\u0001${hint.label}\u0001${hint.keySeparator ?? ''}`)
    .join('\u0002');
}
