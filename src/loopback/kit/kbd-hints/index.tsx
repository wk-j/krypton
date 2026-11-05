// Spec 341 — the key-hint footer (`.shortcuts`, `.keys`, `.hint` before).
// Spec 361: React component.

import type { JSX } from 'react';

import './kbd-hints.css';

export interface KbdHintsProps {
  /** `[['j / k', 'move'], ['Enter', 'open']]` → `j / k move · Enter open`. */
  readonly entries: readonly (readonly [keys: string, label: string])[];
  readonly note?: string;
}

export function KbdHints({ entries, note }: KbdHintsProps): JSX.Element {
  return (
    <footer className="lb-hints">
      {entries.map(([keys, label], i) => (
        <span key={i} className="lb-hints__item">
          <kbd>{keys}</kbd>
          {` ${label}`}
        </span>
      ))}
      {note ? <span className="lb-hints__note">{note}</span> : null}
    </footer>
  );
}
