// spec 146 / spec 162: the two neutral review depth indicators. Near-identical
// shape (summed per-source count, glyph + label, hidden at zero, never
// coloured), so they share a file.

export class FooterReviews {
  readonly el: HTMLElement;
  /** spec 146: recorded #review rounds per publishing harness instance, summed
   * for the neutral depth indicator (distinct from the attention gauge). */
  private reviewsBySource = new Map<string, number>();

  constructor() {
    // spec 146: neutral review-count depth indicator (review quality matrix),
    // published by the ACP harness via `review:quality`. Distinct from the
    // attention gauge: it means "N rounds recorded — press to inspect", never
    // "act on me", and is never coloured by badness (ADR-0004).
    this.el = document.createElement('span');
    this.el.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--reviews';
    this.el.hidden = true;
  }

  set(sourceId: string, totalReviews: number): void {
    if (totalReviews > 0) this.reviewsBySource.set(sourceId, totalReviews);
    else this.reviewsBySource.delete(sourceId);
  }

  /** spec 146: render the neutral review-count depth indicator — total recorded
   * #review rounds summed across sources. Deliberately NOT a gauge: a single
   * glyph + count, never coloured by badness, never pulses (ADR-0004). Hidden at
   * zero. Distinct from the attention gauge — depth ("inspect"), not demand. */
  render(): void {
    let n = 0;
    for (const total of this.reviewsBySource.values()) n += total;
    if (n <= 0) {
      this.el.hidden = true;
      this.el.replaceChildren();
      this.el.removeAttribute('title');
      return;
    }
    this.el.hidden = false;
    const glyph = document.createElement('span');
    glyph.className = 'krypton-workspace-footer__reviews-glyph';
    glyph.textContent = '◷';
    const label = document.createElement('span');
    label.textContent = `${n} review${n === 1 ? '' : 's'}`;
    this.el.replaceChildren(glyph, label);
    this.el.title = `${n} recorded review round${n === 1 ? '' : 's'} — press ⌘P ' to inspect the review quality matrix`;
  }
}

export class FooterPriority {
  readonly el: HTMLElement;
  /** spec 162: count of `high` review-priority ranges per publishing harness,
   * summed for the neutral "read these first" depth indicator. */
  private priorityBySource = new Map<string, number>();

  constructor() {
    // spec 162: neutral review-priority depth indicator (mark_review_priority
    // roll-up), published via `review:priority`. Like the review-count gauge it
    // means "N spots marked to read first — press to inspect", never "act on
    // me"; an advisory reading hint, never coloured (ADR-0009).
    this.el = document.createElement('span');
    this.el.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--priority';
    this.el.hidden = true;
  }

  set(sourceId: string, highCount: number): void {
    if (highCount > 0) this.priorityBySource.set(sourceId, highCount);
    else this.priorityBySource.delete(sourceId);
  }

  /** spec 162: neutral count of `high` review-priority spots summed across
   * sources. Hidden at zero so the footer stays quiet when no lane has marked a
   * reading priority. Depth ("inspect"), never demand — never coloured. */
  render(): void {
    let n = 0;
    for (const total of this.priorityBySource.values()) n += total;
    if (n <= 0) {
      this.el.hidden = true;
      this.el.replaceChildren();
      this.el.removeAttribute('title');
      return;
    }
    this.el.hidden = false;
    const glyph = document.createElement('span');
    glyph.className = 'krypton-workspace-footer__priority-glyph';
    glyph.textContent = '▤';
    const label = document.createElement('span');
    label.textContent = `${n} priority`;
    this.el.replaceChildren(glyph, label);
    this.el.title = `${n} spot${n === 1 ? '' : 's'} marked to read first — press ⌘P / to inspect the review priority roll-up`;
  }
}
