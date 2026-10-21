// Krypton — File Manager preview pane (spec 317).
//
// Two children: `<pre>` for text / highlighted code and a markdown `<div>`.
// Only the visible child is written; the hidden one keeps its old content
// (quirk P10). Output is applied only when its identity changes, so toggling
// `hidden` never rewrites (and never scrolls) the content.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { SmoothScroller } from '../../smooth-scroll';
import type { PreviewOutput } from '../../types';

export interface PreviewPaneProps {
  hidden: boolean;
  /** A fresh object per render; identity is the change signal. */
  output: PreviewOutput;
}

const B = 'krypton-file-manager';

export class PreviewPane extends Component<PreviewPaneProps> {
  readonly contentEl: HTMLPreElement = el('pre', { class: `${B}__preview-content` });
  readonly markdownEl: HTMLDivElement = el('div', { class: `${B}__preview-markdown` });
  private applied: PreviewOutput;
  private readonly scroller = new SmoothScroller(
    () => this.visibleChild().scrollTop,
    (v) => { this.visibleChild().scrollTop = v; },
    () => {
      const t = this.visibleChild();
      return Math.max(0, t.scrollHeight - t.clientHeight);
    },
  );

  /** `initial` is the output the fresh DOM already shows (nothing); it is not applied. */
  constructor(initial: PreviewOutput) {
    super(el('div', { class: `${B}__preview` }));
    this.applied = initial;
    this.markdownEl.style.display = 'none';
    this.el.append(this.contentEl, this.markdownEl);
  }

  protected readDeps(p: PreviewPaneProps): readonly unknown[] {
    return [p.hidden, p.output];
  }

  protected paint(p: PreviewPaneProps): void {
    this.syncClasses(p);
    if (p.output === this.applied) return;
    this.scroller.cancel();
    this.applied = p.output;
    const out = p.output;
    switch (out.kind) {
      case 'text':
        this.contentEl.style.display = '';
        this.markdownEl.style.display = 'none';
        this.contentEl.textContent = out.text;
        break;
      case 'html':
        this.contentEl.style.display = '';
        this.markdownEl.style.display = 'none';
        this.contentEl.innerHTML = out.html;
        break;
      case 'markdown':
        this.contentEl.style.display = 'none';
        this.markdownEl.style.display = '';
        this.markdownEl.innerHTML = out.html;
        for (const img of this.markdownEl.querySelectorAll('img')) {
          (img as HTMLElement).style.maxWidth = '100%';
        }
        break;
    }
  }

  protected syncClasses(p: PreviewPaneProps): void {
    this.el.classList.toggle(`${B}__preview--hidden`, p.hidden);
  }

  private visibleChild(): HTMLElement {
    return this.markdownEl.style.display !== 'none' ? this.markdownEl : this.contentEl;
  }

  /** Smooth-scroll whichever child is visible. */
  scrollBy(delta: number): void {
    this.scroller.by(delta);
  }

  resetScroll(): void {
    this.scroller.cancel();
    this.el.scrollTop = 0;
  }

  protected onDispose(): void {
    this.scroller.cancel();
  }

  setFlex(value: string): void {
    this.el.style.flex = value;
  }
}
