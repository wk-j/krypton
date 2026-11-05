// Spec 227 — the two resizable splits (file list | panes, source / response).
// Sizes persist in localStorage `krypton-hurl-splits`; below 860px the file
// list stacks above the panes and its split resizes height instead.
// Spec 361: `useSplits()` renders the two separators; sizes stay imperative
// (CSS custom properties on the ref'd workspace/panes), as measuring the
// workspace cannot happen during render.

import { useLayoutEffect, useState } from 'react';
import type { JSX, PointerEvent as ReactPointerEvent } from 'react';

import { useKeymap } from '../../kit';

export const SPLIT_KEY = 'krypton-hurl-splits';
const ROSTER_DEFAULT = 280;
const ROSTER_H_DEFAULT = 180;
const SOURCE_DEFAULT = 0.4;
const ROSTER_STEP = 24;
const SOURCE_STEP = 0.05;

type SplitKind = 'roster' | 'source';

/** Sizes and the four nodes they are written to; one instance per page. */
class SplitModel {
  private rosterPx = ROSTER_DEFAULT;
  private rosterH = ROSTER_H_DEFAULT;
  private sourceRatio = SOURCE_DEFAULT;
  readonly narrow: MediaQueryList | null =
    typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 860px)') : null;
  workspace: HTMLElement | null = null;
  panes: HTMLElement | null = null;
  roster: HTMLElement | null = null;
  source: HTMLElement | null = null;
  /** Ends a drag in progress (listeners, body class); null when idle. */
  private endDrag: (() => void) | null = null;

  constructor() {
    this.restore();
  }

  readonly setWorkspace = (node: HTMLElement | null): void => {
    this.workspace = node;
  };
  readonly setPanes = (node: HTMLElement | null): void => {
    this.panes = node;
  };
  readonly setRoster = (node: HTMLElement | null): void => {
    this.roster = node;
  };
  readonly setSource = (node: HTMLElement | null): void => {
    this.source = node;
  };

  readonly apply = (): void => {
    if (!this.workspace || !this.panes || !this.roster || !this.source) return;
    const roster = this.displayedRoster(this.workspace);
    const source = clampSource(this.sourceRatio);
    this.workspace.style.setProperty('--roster', `${roster}px`);
    this.panes.style.setProperty('--source', `${source * 100}%`);
    this.roster.setAttribute('aria-valuenow', String(roster));
    this.roster.setAttribute('aria-orientation', this.isNarrow() ? 'horizontal' : 'vertical');
    this.source.setAttribute('aria-valuenow', String(Math.round(source * 100)));
  };

  nudge(kind: SplitKind, direction: number): void {
    if (kind === 'source') this.sourceRatio += direction * SOURCE_STEP;
    else if (this.isNarrow()) this.rosterH += direction * ROSTER_STEP;
    else this.rosterPx += direction * ROSTER_STEP;
    this.commit();
  }

  reset(kind: SplitKind): void {
    if (kind === 'source') this.sourceRatio = SOURCE_DEFAULT;
    else if (this.isNarrow()) this.rosterH = ROSTER_H_DEFAULT;
    else this.rosterPx = ROSTER_DEFAULT;
    this.commit();
  }

  drag(down: ReactPointerEvent<HTMLElement>, kind: SplitKind): void {
    if (down.button !== 0 || !this.workspace || !this.panes) return;
    down.preventDefault();
    const node = down.currentTarget;
    node.focus();
    node.setPointerCapture?.(down.pointerId);
    const axisY = kind === 'source' || this.isNarrow();
    const startPos = axisY ? down.clientY : down.clientX;
    const startRoster = this.displayedRoster(this.workspace);
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
    const release = (): void => {
      document.body.classList.remove(resizing);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      this.endDrag = null;
    };
    const up = (): void => {
      release();
      this.persist();
    };
    this.endDrag?.();
    this.endDrag = release;
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  /** Unmount mid-drag: drop the listeners and the body class. */
  cancelDrag(): void {
    this.endDrag?.();
  }

  private isNarrow(): boolean {
    return this.narrow?.matches === true;
  }

  private displayedRoster(workspace: HTMLElement): number {
    const box = workspace.getBoundingClientRect();
    if (this.isNarrow()) {
      const maxH = Math.max(120, (box.height || 480) - 260);
      return Math.round(Math.max(120, Math.min(maxH, this.rosterH)));
    }
    const maxW = Math.max(180, (box.width || 960) - 280);
    return Math.round(Math.max(160, Math.min(Math.min(640, maxW), this.rosterPx)));
  }

  private commit(): void {
    this.apply();
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(
        SPLIT_KEY,
        JSON.stringify({ rosterPx: this.rosterPx, rosterH: this.rosterH, sourceRatio: this.sourceRatio }),
      );
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
}

function clampSource(ratio: number): number {
  return Math.max(0.18, Math.min(0.72, ratio));
}

export interface Splits {
  /** Ref callbacks for the nodes carrying `--roster` and `--source`. */
  readonly workspaceRef: (node: HTMLElement | null) => void;
  readonly panesRef: (node: HTMLElement | null) => void;
  /** The separator between the file list and the panes. */
  readonly rosterSplit: JSX.Element;
  /** The separator between source and response. */
  readonly sourceSplit: JSX.Element;
  /** Re-measure and write the sizes (stable). */
  readonly apply: () => void;
}

/**
 * Call after the page's own `useKeymap`: these bindings must register later
 * so a focused separator's arrows win over the page's j/k/↑/↓.
 */
export function useSplits(): Splits {
  const [model] = useState(() => new SplitModel());

  useLayoutEffect(() => {
    model.apply();
    const apply = model.apply;
    model.narrow?.addEventListener('change', apply);
    window.addEventListener('resize', apply);
    return () => {
      model.narrow?.removeEventListener('change', apply);
      window.removeEventListener('resize', apply);
      model.cancelDrag();
    };
  }, [model]);

  const focusedRoster = (): boolean => model.roster !== null && document.activeElement === model.roster;
  const focusedSource = (): boolean => model.source !== null && document.activeElement === model.source;
  useKeymap([
    { key: '[', label: 'Narrow the file list', run: () => model.nudge('roster', -1) },
    { key: ']', label: 'Widen the file list', run: () => model.nudge('roster', 1) },
    { key: ['-', '_'], display: '-', label: 'Shrink the source pane', run: () => model.nudge('source', -1) },
    { key: ['=', '+'], display: '= / +', label: 'Grow the source pane', run: () => model.nudge('source', 1) },
    // A focused separator takes the arrows (and Home) ahead of the file list.
    { key: ['ArrowLeft', 'ArrowUp'], when: focusedRoster, run: () => model.nudge('roster', -1) },
    { key: ['ArrowRight', 'ArrowDown'], when: focusedRoster, run: () => model.nudge('roster', 1) },
    { key: 'Home', when: focusedRoster, run: () => model.reset('roster') },
    { key: 'ArrowUp', when: focusedSource, run: () => model.nudge('source', -1) },
    { key: 'ArrowDown', when: focusedSource, run: () => model.nudge('source', 1) },
    { key: 'Home', when: focusedSource, run: () => model.reset('source') },
  ]);

  return {
    workspaceRef: model.setWorkspace,
    panesRef: model.setPanes,
    apply: model.apply,
    rosterSplit: (
      <div
        ref={model.setRoster}
        className="lb-hurl__split lb-hurl__split--x"
        title="Drag to resize file list. Double-click resets. [ ] keys."
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize file list"
        aria-valuemin={160}
        aria-valuemax={640}
        onDoubleClick={(): void => model.reset('roster')}
        onPointerDown={(event): void => model.drag(event, 'roster')}
      />
    ),
    sourceSplit: (
      <div
        ref={model.setSource}
        className="lb-hurl__split lb-hurl__split--y"
        title="Drag to resize source. Double-click resets. - = keys."
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="Resize source"
        aria-valuemin={18}
        aria-valuemax={72}
        onDoubleClick={(): void => model.reset('source')}
        onPointerDown={(event): void => model.drag(event, 'source')}
      />
    ),
  };
}
