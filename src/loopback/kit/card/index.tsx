// Spec 341 — the standard raised surface. Never nest one inside another.
// Spec 361: React component; content is `children`.

import type { JSX, ReactNode } from 'react';

import './card.css';

export interface CardOptions {
  readonly title?: string;
  /** Right side of the heading row (a chip, a pill, a button). */
  readonly aside?: ReactNode;
  /** Extra class after `lb-card` (was `class`). */
  readonly className?: string;
  readonly tag?: 'section' | 'article' | 'div';
  /** Caller markers (`data-state`, `data-lane-id`), written as attributes. */
  readonly [data: `data-${string}`]: string | undefined;
}

export interface CardProps extends CardOptions {
  readonly children?: ReactNode;
}

export function Card({ title, aside, className, tag: Tag = 'section', children, ...attrs }: CardProps): JSX.Element {
  return (
    <Tag className={className ? `lb-card ${className}` : 'lb-card'} {...attrs}>
      {title !== undefined || aside ? (
        <header className="lb-card__head">
          <h3 className="lb-card__title">{title ?? ''}</h3>
          {aside}
        </header>
      ) : null}
      {children}
    </Tag>
  );
}
