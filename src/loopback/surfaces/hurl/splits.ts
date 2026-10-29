// Spec 227 — the two resizable splits (file list | panes, source / response).
// Sizes persist in localStorage `krypton-hurl-splits`; below 860px the file
// list stacks above the panes and its split resizes height instead.

import { DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { keymap } from '../../kit';

export const SPLIT_KEY = 'krypton-hurl-splits';
const ROSTER_DEFAULT = 280;
const ROSTER_H_DEFAULT = 180;
const SOURCE_DEFAULT = 0.4;
const ROSTER_STEP = 24;
const SOURCE_STEP = 0.05;

type SplitKind = 'roster' | 'source';

export class Splits {
  readonly roster: HTMLElement;
  readonly source: HTMLElement;
  private rosterPx = ROSTER_DEFAULT;
  private rosterH = ROSTER_H_DEFAULT;
  private sourceRatio = SOURCE_DEFAULT;
  private readonly narrow: MediaQueryList | null;
  private readonly bag = new DisposableBag();

  constructor(
    private readonly workspace: HTMLElement,
    private readonly panes: HTMLElement,
  ) {
    this.roster = el('div', {
      class: ['lb-hurl__split', 'lb-hurl__split--x'],
      title: 'Drag to resize file list. Double-click resets. [ ] keys.',
      attrs: {
        role: 'separator',
        tabindex: '0',
        'aria-orientation': 'vertical',
        'aria-label': 'Resize file list',
        'aria-valuemin': '160',
        'aria-valuemax': '640',
      },
    });
    this.source = el('div', {
      class: ['lb-hurl__split', 'lb-hurl__split--y'],
      title: 'Drag to resize source. Double-click resets. - = keys.',
      attrs: {
        role: 'separator',
        tabindex: '0',
        'aria-orientation': 'horizontal',
        'aria-label': 'Resize source',
        'aria-valuemin': '18',
        'aria-valuemax': '72',
      },
    });
    this.narrow = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 860px)') : null;
    this.restore();
    this.bindDrag(this.roster, 'roster');
    this.bindDrag(this.source, 'source');
    if (this.narrow) this.bag.listen(this.narrow, 'change', () => this.apply());
    this.bag.listen(window, 'resize', () => this.apply());
    const focused = (node: HTMLElement) => (): boolean => document.activeElement === node;
    this.bag.add(
      keymap().bindAll([
        { key: '[', label: 'Narrow the file list', run: () => this.nudge('roster', -1) },
        { key: ']', label: 'Widen the file list', run: () => this.nudge('roster', 1) },
        { key: ['-', '_'], display: '-', label: 'Shrink the source pane', run: () => this.nudge('source', -1) },
        { key: ['=', '+'], display: '= / +', label: 'Grow the source pane', run: () => this.nudge('source', 1) },
        // A focused separator takes the arrows (and Home) ahead of the file list.
        { key: ['ArrowLeft', 'ArrowUp'], when: focused(this.roster), run: () => this.nudge('roster', -1) },
        { key: ['ArrowRight', 'ArrowDown'], when: focused(this.roster), run: () => this.nudge('roster', 1) },
        { key: 'Home', when: focused(this.roster), run: () => this.reset('roster') },
        { key: 'ArrowUp', when: focused(this.source), run: () => this.nudge('source', -1) },
        { key: 'ArrowDown', when: focused(this.source), run: () => this.nudge('source', 1) },
        { key: 'Home', when: focused(this.source), run: () => this.reset('source') },
      ]),
    );
    this.apply();
  }

  /** Current sizes: file list width/height in px, source share of the panes. */
  sizes(): { rosterPx: number; rosterH: number; sourceRatio: number } {
    return { rosterPx: this.rosterPx, rosterH: this.rosterH, sourceRatio: this.sourceRatio };
  }

  apply(): void {
    const roster = this.displayedRoster();
    const source = clampSource(this.sourceRatio);
    this.workspace.style.setProperty('--roster', `${roster}px`);
    this.panes.style.setProperty('--source', `${source * 100}%`);
    this.roster.setAttribute('aria-valuenow', String(roster));
    this.roster.setAttribute('aria-orientation', this.isNarrow() ? 'horizontal' : 'vertical');
    this.source.setAttribute('aria-valuenow', String(Math.round(source * 100)));
  }

  dispose(): void {
    this.bag.dispose();
  }

  private isNarrow(): boolean {
    return this.narrow?.matches === true;
  }

  private displayedRoster(): number {
    const box = this.workspace.getBoundingClientRect();
    if (this.isNarrow()) {
      const maxH = Math.max(120, (box.height || 480) - 260);
      return Math.round(Math.max(120, Math.min(maxH, this.rosterH)));
    }
    const maxW = Math.max(180, (box.width || 960) - 280);
    return Math.round(Math.max(160, Math.min(Math.min(640, maxW), this.rosterPx)));
  }

  private nudge(kind: SplitKind, direction: number): void {
    if (kind === 'source') this.sourceRatio += direction * SOURCE_STEP;
    else if (this.isNarrow()) this.rosterH += direction * ROSTER_STEP;
    else this.rosterPx += direction * ROSTER_STEP;
    this.commit();
  }

  private reset(kind: SplitKind): void {
    if (kind === 'source') this.sourceRatio = SOURCE_DEFAULT;
    else if (this.isNarrow()) this.rosterH = ROSTER_H_DEFAULT;
    else this.rosterPx = ROSTER_DEFAULT;
    this.commit();
  }

  private commit(): void {
    this.apply();
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(SPLIT_KEY, JSON.stringify(this.sizes()));
    } catch {
      /* storage unavailable */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(SPLIT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<Record<'rosterPx' | 'rosterH' | 'sourceRatio', unknown>>;
      if (typeof saved.rosterPx === 'number' && Number.isFinite(saved.rosterPx)) this.rosterPx = saved.rosterPx;
      if (typeof saved.rosterH === 'number' && Number.isFinite(saved.rosterH)) this.rosterH = saved.rosterH;
      if (typeof saved.sourceRatio === 'number' && Number.isFinite(saved.sourceRatio)) this.sourceRatio = saved.sourceRatio;
    } catch {
      /* corrupt entry: keep defaults */
    }
  }

  private bindDrag(node: HTMLElement, kind: SplitKind): void {
    this.bag.listen(node, 'dblclick', () => this.reset(kind));
    this.bag.listen(node, 'pointerdown', (event) => {
      const down = event as PointerEvent;
      if (down.button !== 0) return;
      down.preventDefault();
      node.focus();
      node.setPointerCapture?.(down.pointerId);
      const axisY = kind === 'source' || this.isNarrow();
      const startPos = axisY ? down.clientY : down.clientX;
      const startRoster = this.displayedRoster();
      const startSource = clampSource(this.sourceRatio);
      if (kind === 'roster' && this.isNarrow()) this.rosterH = startRoster;
      else if (kind === 'roster') this.rosterPx = startRoster;
      this.sourceRatio = startSource;
      const panesHeight = this.panes.getBoundingClientRect().height;
      const resizing = axisY ? 'lb-hurl--resizing-y' : 'lb-hurl--resizing-x';
      document.body.classList.add(resizing);
      const move = (ev: PointerEvent): void => {
        const delta = (axisY ? ev.clientY : ev.clientX) - startPos;
        if (kind === 'source') this.sourceRatio = startSource + (panesHeight ? delta / panesHeight : 0);
        else if (this.isNarrow()) this.rosterH = startRoster + delta;
        else this.rosterPx = startRoster + delta;
        this.apply();
      };
      const up = (): void => {
        document.body.classList.remove(resizing);
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
        this.persist();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });
  }
}

function clampSource(ratio: number): number {
  return Math.max(0.18, Math.min(0.72, ratio));
}
