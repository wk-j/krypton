// Krypton — the native view of one command block (specs 351, 352).
//
// A card covers exactly its block's terminal rows: a transparent body with the
// native rendering (a diff or a `git status`) and a bar at the top-right with
// the command, a Native/Raw switch and copy. The body is built once;
// afterwards only the view class and the placement change. The layer owns
// placement through `place()`; nothing outside writes this card's DOM.

import { Component } from '../ui/component';
import { classes, el } from '../ui/dom';
import type { NativeDiffFile } from './git-diff';
import type { NativeGitStatus } from './git-status';
import { renderDiff } from './render-diff';
import { renderStatus } from './render-status';
import './native-output.css';

export type NativeView = 'native' | 'raw';

export type NativeModel =
  | { readonly kind: 'diff'; readonly files: readonly NativeDiffFile[] }
  | { readonly kind: 'status'; readonly status: NativeGitStatus };

export interface NativeCardProps {
  readonly label: string;
  /** Shown as the bar's tooltip, e.g. that the command was re-run. */
  readonly detail: string;
  readonly model: NativeModel;
  readonly view: NativeView;
}

export interface NativeCardActions {
  onView(view: NativeView): void;
  onCopy(): void;
}

/** Pixel placement inside the layer; `barTop` keeps the bar on screen. */
export interface NativeCardPlacement {
  readonly top: number;
  readonly height: number;
  readonly barTop: number;
}

export class NativeCard extends Component<NativeCardProps> {
  private readonly bar: HTMLElement;
  private readonly labelEl: HTMLElement;
  private readonly nativeBtn: HTMLButtonElement;
  private readonly rawBtn: HTMLButtonElement;
  private readonly body: HTMLElement;
  private paintedModel: NativeModel | null = null;
  private placement: NativeCardPlacement | null = null;

  constructor(actions: NativeCardActions) {
    super(el('div', { class: 'krypton-native-block' }));
    this.labelEl = el('span', { class: 'krypton-native-block__label' });
    this.nativeBtn = button('Native');
    this.rawBtn = button('Raw');
    const copyBtn = button('Copy');
    this.bar = el(
      'div',
      { class: 'krypton-native-block__bar' },
      this.labelEl,
      el('span', { class: 'krypton-native-block__switch' }, this.nativeBtn, this.rawBtn),
      copyBtn,
    );
    this.body = el('div', { class: 'krypton-native-block__body' });
    this.el.append(this.body, this.bar);
    this.el.style.display = 'none';
    this.bag.listen(this.nativeBtn, 'click', () => actions.onView('native'));
    this.bag.listen(this.rawBtn, 'click', () => actions.onView('raw'));
    this.bag.listen(copyBtn, 'click', () => actions.onCopy());

    // Pressing a control must neither move focus off the terminal nor start an
    // xterm selection on the raw cells underneath.
    const hold = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    this.bag.listen(this.bar, 'mousedown', hold);
    this.bag.listen(this.body, 'mousedown', hold);
    // The body scrolls itself while it can; at either end the wheel goes on to
    // the terminal, so scrolling past a card never sticks.
    this.bag.listen(this.body, 'wheel', (e: Event) => {
      const { deltaY } = e as WheelEvent;
      const body = this.body;
      const canUp = body.scrollTop > 0;
      const canDown = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
      if ((deltaY < 0 && canUp) || (deltaY > 0 && canDown)) e.stopPropagation();
    }, { passive: true });
  }

  protected readDeps(next: NativeCardProps): readonly unknown[] {
    return [next.label, next.detail, next.model, next.view];
  }

  protected syncClasses(next: NativeCardProps): void {
    this.el.className = classes('krypton-native-block', next.view === 'raw' && 'krypton-native-block--raw');
  }

  protected paint(next: NativeCardProps): void {
    this.syncClasses(next);
    this.labelEl.textContent = next.label;
    this.bar.title = next.detail;
    this.nativeBtn.setAttribute('aria-pressed', String(next.view === 'native'));
    this.rawBtn.setAttribute('aria-pressed', String(next.view === 'raw'));
    if (this.paintedModel !== next.model) {
      this.paintedModel = next.model;
      this.body.replaceChildren(next.model.kind === 'diff' ? renderDiff(next.model.files) : renderStatus(next.model.status));
    }
  }

  /** null hides the card (off screen). Writes only what changed. */
  place(next: NativeCardPlacement | null): void {
    const prev = this.placement;
    this.placement = next;
    if (next === null) {
      if (prev !== null) this.el.style.display = 'none';
      return;
    }
    if (prev === null) this.el.style.display = '';
    if (prev?.top !== next.top) this.el.style.transform = `translateY(${next.top}px)`;
    if (prev?.height !== next.height) this.el.style.height = `${next.height}px`;
    if (prev?.barTop !== next.barTop) this.bar.style.transform = `translateY(${next.barTop}px)`;
  }
}

function button(label: string): HTMLButtonElement {
  return el('button', { class: 'krypton-native-block__opt', text: label, attrs: { type: 'button', tabindex: -1 } });
}
