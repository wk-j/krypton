// Spec 302 §4.3 — `LaneSymbol`.
//
// The row-1 leading status glyph: a state-tinted wrapper holding either the
// braille spinner (busy), a static SVG status icon (starting / permission /
// peer / error / stopped), or nothing at all (idle — the empty wrapper keeps
// the head grid's first column aligned).
//
// The spinner is the already-built `Spinner` component rather than a literal
// frame-0 glyph, so the lane symbol joins the shared frame counter the moment
// it appears and leaves it the moment the lane stops being busy. That is the
// whole reason this is a component and not a string: `renderLaneSymbol()`
// emitted `SPINNER_FRAMES[0]` and relied on the view's
// `querySelectorAll('.acp-harness__spinner')` re-apply to catch up.

import './lane-symbol.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { harnessIconEl } from '../../harness-icons';
import type { HarnessLaneStatus } from '../../types';
import { Spinner } from '../spinner';
import type { ComponentDef } from '../types';

export interface LaneSymbolProps {
  readonly status: HarnessLaneStatus;
}

/** The `krypton-icon-` suffix for a status. Ported verbatim from
 *  `harness-lane-chrome.ts:612-622`. */
export function statusIconId(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return 'status-starting';
    case 'idle': return 'status-idle';
    case 'busy': return 'status-busy';
    case 'needs_permission': return 'status-perm';
    case 'awaiting_peer': return 'status-peer';
    case 'error': return 'status-error';
    case 'stopped': return 'status-error';
  }
}

/** The lane status vocabulary, unchanged (`harness-lane-chrome.ts:642-652`). */
export function statusLabel(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return 'starting';
    case 'idle': return 'idle';
    case 'busy': return 'busy';
    case 'needs_permission': return 'action required';
    case 'awaiting_peer': return 'awaiting peer';
    case 'error': return 'error';
    case 'stopped': return 'stopped';
  }
}

export class LaneSymbol extends Component<LaneSymbolProps> {
  /** Non-null exactly while the lane is busy. Disposing it is what unregisters
   *  the glyph from `tickAllSpinners()`; leaving it mounted would keep a
   *  detached node on the tick list for the lifetime of the harness. */
  private spinner: Spinner | null = null;

  constructor() {
    super(el('span'));
  }

  protected readDeps(next: LaneSymbolProps): readonly unknown[] {
    return [next.status];
  }

  protected syncClasses(next: LaneSymbolProps): void {
    this.el.className = `acp-harness__lane-symbol acp-harness__lane-symbol--${next.status}`;
  }

  protected paint(next: LaneSymbolProps): void {
    this.syncClasses(next);
    if (next.status !== 'busy' && this.spinner) {
      this.spinner.dispose();
      this.spinner = null;
    }
    this.el.replaceChildren();
    if (next.status === 'busy') {
      if (!this.spinner) this.spinner = new Spinner();
      this.spinner.update({ running: true });
      this.el.appendChild(this.spinner.el);
      return;
    }
    if (next.status === 'idle') return;
    this.el.appendChild(harnessIconEl(statusIconId(next.status)));
  }

  protected onDispose(): void {
    this.spinner?.dispose();
    this.spinner = null;
  }
}

export const def: ComponentDef = { id: 'lane-symbol', blocks: ['acp-harness__lane-symbol'] };
