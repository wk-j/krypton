// Spec 341 — the one transient status line ("copied", "run cancelled",
// "reconnecting…"). Pages used `flash()`, `flashStatus()` and `showBanner()`.

import { el } from '../../../ui/dom';

import './banner.css';

export type BannerTone = 'info' | 'ok' | 'error';

export class Banner {
  readonly el = el('div', { class: 'lb-banner', attrs: { role: 'status', 'aria-live': 'polite', hidden: true } });
  private timer: number | undefined;

  /** Show `text`; `ms` > 0 hides it again after that long. */
  show(text: string, tone: BannerTone = 'info', ms = 0): void {
    window.clearTimeout(this.timer);
    this.el.textContent = text;
    this.el.className = `lb-banner lb-banner--${tone}`;
    this.el.hidden = false;
    if (ms > 0) this.timer = window.setTimeout(() => this.hide(), ms);
  }

  hide(): void {
    window.clearTimeout(this.timer);
    this.el.hidden = true;
  }

  dispose(): void {
    window.clearTimeout(this.timer);
  }
}
