// Krypton — File Manager status bar (spec 317).

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import type { StatusTone } from '../../types';

export interface StatusBarProps {
  text: string;
  /** `null` leaves `className` untouched (quirk P7). */
  tone: StatusTone;
}

const BLOCK = 'krypton-file-manager__status';

export function statusClassName(tone: Exclude<StatusTone, null>): string {
  return tone === 'normal' ? BLOCK : `${BLOCK} ${BLOCK}--${tone}`;
}

export class StatusBar extends Component<StatusBarProps> {
  constructor() {
    super(el('div', { class: BLOCK }));
  }

  protected readDeps(p: StatusBarProps): readonly unknown[] {
    return [p.text, p.tone];
  }

  protected paint(p: StatusBarProps): void {
    this.el.textContent = p.text;
    this.syncClasses(p);
  }

  protected syncClasses(p: StatusBarProps): void {
    if (p.tone !== null) this.el.className = statusClassName(p.tone);
  }
}
