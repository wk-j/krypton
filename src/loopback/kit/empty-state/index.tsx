// Spec 341 — every list and grid has one: a centred muted mono line.
// Spec 361: React component; extra content is `children`.

import type { JSX, ReactNode } from 'react';

import './empty-state.css';

export interface EmptyStateProps {
  readonly text: string;
  /** Rendered after the line (a hint, a button). */
  readonly children?: ReactNode;
}

export function EmptyState({ text, children }: EmptyStateProps): JSX.Element {
  return (
    <div className="lb-empty">
      <p className="lb-empty__text">{text}</p>
      {children}
    </div>
  );
}
