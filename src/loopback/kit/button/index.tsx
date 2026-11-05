// Spec 341 — buttons. `primary` is the one place text sits on the accent;
// `toggle` reports its state through `aria-pressed`. Spec 361: `pressed` is a
// prop (was `setPressed()`); `data-*` and `aria-expanded` pass through.

import type { JSX, MouseEvent } from 'react';

import './button.css';

export interface ButtonProps {
  readonly label: string;
  readonly variant?: 'primary' | 'secondary' | 'toggle' | 'ghost';
  /** `aria-pressed`; rendered only on `toggle`. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  /** Key hint shown inside the button. */
  readonly kbd?: string;
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** For disclosure buttons (`Source` / `Hide source`). */
  readonly 'aria-expanded'?: boolean;
  /** Caller markers (`data-lane`, `data-state`), written as attributes. */
  readonly [data: `data-${string}`]: string | undefined;
}

export function Button({
  label,
  variant = 'secondary',
  pressed = false,
  disabled = false,
  title,
  kbd,
  onClick,
  ...attrs
}: ButtonProps): JSX.Element {
  return (
    <button
      className={`lb-btn lb-btn--${variant}`}
      title={title}
      type="button"
      disabled={disabled}
      aria-pressed={variant === 'toggle' ? pressed : undefined}
      onClick={onClick}
      {...attrs}
    >
      <span className="lb-btn__label">{label}</span>
      {kbd ? <kbd>{kbd}</kbd> : null}
    </button>
  );
}
