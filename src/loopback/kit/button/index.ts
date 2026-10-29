// Spec 341 — buttons. `primary` is the one place text sits on the accent;
// `toggle` reports its state through `aria-pressed`.

import { el, setAttr } from '../../../ui/dom';

import './button.css';

export interface ButtonOptions {
  readonly variant?: 'primary' | 'secondary' | 'toggle' | 'ghost';
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  /** Key hint shown inside the button. */
  readonly kbd?: string;
  readonly onClick?: (event: MouseEvent) => void;
}

export function button(label: string, options: ButtonOptions = {}): HTMLButtonElement {
  const variant = options.variant ?? 'secondary';
  const node = el(
    'button',
    {
      class: ['lb-btn', `lb-btn--${variant}`],
      title: options.title,
      attrs: {
        type: 'button',
        disabled: options.disabled === true,
        'aria-pressed': variant === 'toggle' ? String(options.pressed === true) : undefined,
      },
    },
    el('span', { class: 'lb-btn__label', text: label }),
    options.kbd ? el('kbd', { text: options.kbd }) : null,
  );
  if (options.onClick) node.addEventListener('click', options.onClick);
  return node;
}

export function setPressed(node: HTMLButtonElement, pressed: boolean): void {
  setAttr(node, 'aria-pressed', String(pressed));
}
