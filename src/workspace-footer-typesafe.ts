import {
  formatTypeSafeFooterLabel,
  formatTypeSafeTooltip,
  type TypeSafeMetricsSnapshot,
} from './typesafe-metrics';

export class FooterTypeSafe {
  readonly el: HTMLElement;
  enabled = false;
  metrics: TypeSafeMetricsSnapshot | null = null;

  constructor() {
    // spec 258: process-lifetime TypeSafe API request count. It leads the
    // global cluster and stays hidden until TypeSafe is enabled and a real
    // network attempt has started.
    this.el = document.createElement('span');
    this.el.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--typesafe';
    this.el.hidden = true;
  }

  /** spec 258: exact outbound TypeSafe request attempts in this app run.
   * Hidden while disabled or at zero; static and event-driven once visible. */
  render(detail: boolean): void {
    const metrics = this.metrics;
    if (!this.enabled || !metrics || metrics.apiRequests <= 0) {
      this.el.hidden = true;
      this.el.replaceChildren();
      this.el.removeAttribute('title');
      this.el.removeAttribute('aria-label');
      return;
    }

    this.el.hidden = false;
    const glyph = document.createElement('span');
    glyph.className = 'krypton-workspace-footer__typesafe-glyph';
    glyph.textContent = '⚡';
    const label = document.createElement('span');
    label.textContent = formatTypeSafeFooterLabel(metrics, detail);
    this.el.replaceChildren(glyph, label);
    this.el.title = formatTypeSafeTooltip(metrics);
    this.el.setAttribute('aria-label', `TypeSafe API requests ${metrics.apiRequests}`);
  }
}
