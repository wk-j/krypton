// Krypton — File Manager virtual-list frame (smooth scrolling).
//
// FileList and SearchList share one `div.krypton-file-manager__list` host. Each
// owns a `div.krypton-file-manager__rows` inner node holding the overscanned
// window; `place()` translates it so the fractional scroll position lines up.
// The empty-state text still goes straight into the host.

import { el, setChildren } from '../../ui/dom';
import { disposeList } from '../../ui/list';

export class ListFrame {
  readonly rows = el('div', { class: 'krypton-file-manager__rows' });

  constructor(private readonly host: HTMLElement) {}

  /** The rows node, mounted as the host's only child. */
  mountRows(): HTMLElement {
    if (this.host.firstChild !== this.rows || this.host.childNodes.length !== 1) {
      setChildren(this.host, [this.rows]);
    }
    return this.rows;
  }

  showEmpty(text: string): void {
    disposeList(this.rows);
    setChildren(this.host, [el('div', { class: 'krypton-file-manager__empty', text })]);
  }

  /** Translate the rows node by `shiftPx` (≤ 0: the first rendered row sits above the viewport). */
  place(shiftPx: number): void {
    const t = `translateY(${shiftPx}px)`;
    if (this.rows.style.transform !== t) this.rows.style.transform = t;
  }

  release(): void {
    disposeList(this.rows);
    this.rows.style.transform = '';
    this.host.replaceChildren();
  }

  /** Component teardown: free rows; clear the host only if it shows them (an empty-state note stays, as before). */
  dispose(): void {
    const mounted = this.rows.parentNode === this.host;
    disposeList(this.rows);
    if (mounted) this.host.replaceChildren();
  }
}
