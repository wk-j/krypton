import type { AttentionTier } from './view-bus-types';

// spec 138: attention gauge — tier ordering for picking the heaviest open item
// across harness sources, and the count cap shown as a pip strip (`6+` beyond).
const ATTENTION_TIER_WEIGHT: Record<AttentionTier, number> = {
  reversible: 0,
  costly: 1,
  irreversible: 2,
};
const ATTENTION_PIP_MAX = 6;

export class FooterAttention {
  readonly el: HTMLElement;
  /** spec 128/138: open attention count + heaviest reversibility tier per
   * publishing harness instance. Counts are summed and tiers max'd for display
   * so every lane's attention collects in this one place. */
  private attentionBySource = new Map<string, { count: number; tier: AttentionTier | null }>();

  constructor() {
    // spec 128: global attention-triage badge — open count published by the ACP
    // harness via `system:attention`, shown regardless of focused view.
    this.el = document.createElement('span');
    this.el.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--attention';
    this.el.hidden = true;
  }

  set(sourceId: string, openCount: number, maxReversibility: AttentionTier | null): void {
    if (openCount > 0) this.attentionBySource.set(sourceId, { count: openCount, tier: maxReversibility });
    else this.attentionBySource.delete(sourceId);
  }

  /** spec 128/138: render the open attention-triage gauge — count summed across
   * sources, coloured by the heaviest open reversibility tier, with the count
   * encoded as a pip strip (`6+` past the cap). Static (no motion). Hidden at
   * zero so the footer stays quiet when nothing needs the human. */
  render(): void {
    let n = 0;
    let tierWeight = -1;
    let tier: AttentionTier = 'costly'; // fallback colour if a source reports a null tier
    for (const { count, tier: t } of this.attentionBySource.values()) {
      n += count;
      if (t && ATTENTION_TIER_WEIGHT[t] > tierWeight) {
        tierWeight = ATTENTION_TIER_WEIGHT[t];
        tier = t;
      }
    }
    if (n <= 0) {
      this.el.hidden = true;
      this.el.replaceChildren();
      this.el.removeAttribute('title');
      return;
    }
    this.el.hidden = false;
    this.el.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--attention ' +
      `krypton-workspace-footer__segment--rev-${tier}`;

    const label = document.createElement('span');
    label.textContent = `${n > ATTENTION_PIP_MAX ? `${ATTENTION_PIP_MAX}+` : n} attention`;
    const pips = document.createElement('span');
    pips.className = 'krypton-workspace-footer__attention-pips';
    const lit = Math.min(n, ATTENTION_PIP_MAX);
    for (let i = 0; i < ATTENTION_PIP_MAX; i++) {
      const pip = document.createElement('i');
      if (i >= lit) pip.className = 'is-off';
      pips.appendChild(pip);
    }
    this.el.replaceChildren(label, pips);
    this.el.title =
      `${n} open attention item${n === 1 ? '' : 's'} awaiting your judgement — heaviest: ${tier}`;
  }
}
