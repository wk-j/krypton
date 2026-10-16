export class FooterProgramStatus {
  /** spec 284: OSC 7501 — live panes whose program is blocked / errored / done.
   *  Counts are read from the compositor on every render; never cached here. */
  readonly el: HTMLElement;

  constructor() {
    this.el = document.createElement('span');
    this.el.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--program-status';
    this.el.hidden = true;
  }

  /** spec 284: `▲n ✕n ✓n` — panes blocked / errored / done, each part shown
   *  only when non-zero, the whole segment hidden when all are zero. */
  render(counts: { blocked: number; error: number; done: number }): void {
    const { blocked, error, done } = counts;
    const parts: HTMLElement[] = [];
    for (const [state, glyph, n] of [['blocked', '▲', blocked], ['error', '✕', error], ['done', '✓', done]] as const) {
      if (n === 0) continue;
      const part = document.createElement('span');
      part.className = 'krypton-workspace-footer__program-count';
      part.dataset.state = state;
      part.textContent = `${glyph}${n}`;
      parts.push(part);
    }
    if (parts.length === 0) {
      this.el.hidden = true;
      this.el.replaceChildren();
      this.el.removeAttribute('title');
      return;
    }
    this.el.hidden = false;
    this.el.replaceChildren(...parts);
    this.el.title =
      `programs needing you — blocked ${blocked}, error ${error}, done ${done} · Leader ! to jump`;
  }
}
