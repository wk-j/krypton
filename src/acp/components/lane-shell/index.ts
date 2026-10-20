// Spec 302 §4.1 — `LaneShell`.
//
// The one component this whole refactor exists for. `renderDashboard()` used to
// start with `dashboardEl.innerHTML = ''`, which destroys the transcript body's
// scroll offset; the two-part `prevScrollTop` dance (capture before the wipe,
// write back after reattachment) existed only to rescue it, and the symptom it
// failed to fully rescue was the transcript yanking itself back once a second
// while a lane stayed busy.
//
// A LaneShell is constructed once and updated in place, so the lane body node
// is never detached and the rescue is unnecessary by construction (spec 95:
// "a render path that calls innerHTML = '' on a container holding scrollable
// state is hostile to scroll preservation, no matter how careful the
// save/restore code is around it").
//
// The shell's reconcile key carries the active flag, because active and
// collapsed lanes use different tags (`section` / `div`) and a collapsed lane
// has no body at all — exactly as today. Flipping active therefore rebuilds the
// shell, which is the lane-switch case the view already handled that way.

import './lane-shell.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { LaneHead } from '../lane-head';
import { LaneStats } from '../lane-stats';
import type { AcpLaneMetrics } from '../../../types';
import type { PendingPeerSummary } from '../../inter-lane';
import type { HarnessLane } from '../../harness-view-types';
import type { HarnessMcpLaneStats } from '../../types';
import type { ComponentDef } from '../types';

export interface LaneShellProps {
  readonly lane: HarnessLane;
  readonly active: boolean;
  readonly mcp: HarnessMcpLaneStats | null;
  readonly metrics: AcpLaneMetrics | null;
  readonly inboxDepth: number;
  readonly pendingPeers: PendingPeerSummary[];
  readonly isOrchestrator: boolean;
  readonly projectDir: string | null;
  /** Review-thread action in the head; null when the lane cannot start one. */
  readonly reviewThread: { readonly count: number; readonly enabled: boolean } | null;
  readonly onStartReview: () => void;
}

/** Reconcile key. Active-ness is part of it: the two states are different DOM. */
export function laneShellKey(laneId: string, active: boolean): string {
  return `${laneId}|${active ? 'active' : 'collapsed'}`;
}

export class LaneShell extends Component<LaneShellProps> {
  private readonly head: LaneHead;
  private readonly stats: LaneStats | null;
  /**
   * The pinned transcript body. Created once per shell, never reparented —
   * the layout may resize its slot, it may never move this node.
   */
  readonly body: HTMLElement | null;
  /** The head's trailing Start Review action occupies its reserved grid cell. */
  private actions: HTMLElement | null = null;
  private reviewButton: HTMLButtonElement | null = null;
  private onStartReview: (() => void) | null = null;
  private readonly active: boolean;

  constructor(props: LaneShellProps, rail: HTMLElement | null) {
    super(el(props.active ? 'section' : 'div', { data: { laneId: props.lane.id } }));
    this.active = props.active;
    this.head = new LaneHead();
    this.el.appendChild(this.head.el);
    if (props.active) {
      this.stats = new LaneStats();
      this.body = el('div', { class: 'acp-harness__lane-body', data: { laneId: props.lane.id } });
      this.el.append(this.stats.el, this.body);
      if (rail) this.el.appendChild(rail);
    } else {
      this.stats = null;
      this.body = null;
    }
  }

  protected readDeps(next: LaneShellProps): readonly unknown[] {
    return [
      next.lane.status,
      next.lane.accent,
      next.active,
      next.reviewThread?.count,
      next.reviewThread?.enabled,
      // The head and stats hold their own deps; they are updated unconditionally
      // in update() so a chip change does not have to move this tuple.
    ];
  }

  protected syncClasses(next: LaneShellProps): void {
    this.el.className =
      `acp-harness__lane ${next.active ? 'acp-harness__lane--active' : 'acp-harness__lane--collapsed'}` +
      ` acp-harness__lane--${next.lane.status}`;
  }

  protected paint(next: LaneShellProps): void {
    this.syncClasses(next);
    // spec 215: collapsed lanes keep their accent — CSS dims it toward the base
    // text colour without dropping the hue, so lane identity survives de-focus.
    this.el.style.setProperty('--acp-lane-accent', next.lane.accent);
    this.syncReviewAction(next);
    this.dropActionSlotIfEmpty();
  }

  /**
   * Head and stats are child components with their own dependency tuples, so
   * this is cheap: it is how a 2 s metrics poll with unchanged numbers writes
   * nothing at all.
   */
  update(next: LaneShellProps): void {
    super.update(next);
    this.head.update({
      lane: next.lane,
      active: next.active,
      mcp: next.mcp,
      metrics: next.metrics,
      inboxDepth: next.inboxDepth,
      pendingPeers: next.pendingPeers,
      isOrchestrator: next.isOrchestrator,
    });
    this.stats?.update({ lane: next.lane, projectDir: next.projectDir });
  }

  /** The wrapper exists only while it has something in it. */
  private actionSlot(): HTMLElement {
    if (!this.actions) {
      this.actions = el('span', { class: 'acp-harness__lane-actions' });
      this.head.el.appendChild(this.actions);
    }
    return this.actions;
  }

  private dropActionSlotIfEmpty(): void {
    if (!this.actions || this.actions.childNodes.length > 0) return;
    this.actions.remove();
    this.actions = null;
  }


  /** spec 211: the Start Review action lives in the active lane's head. */
  private syncReviewAction(next: LaneShellProps): void {
    const wanted = this.active ? next.reviewThread : null;
    if (!wanted) {
      this.reviewButton?.remove();
      this.reviewButton = null;
      return;
    }
    if (!this.reviewButton) {
      this.reviewButton = el('button', {
        class: 'acp-harness__review-thread-action',
        attrs: { type: 'button' },
      });
      this.bag.listen(this.reviewButton, 'click', () => this.onStartReview?.());
      this.actionSlot().appendChild(this.reviewButton);
    }
    this.onStartReview = next.onStartReview;
    this.reviewButton.textContent = wanted.count ? `Start Review · ${wanted.count}` : 'Start Review';
    this.reviewButton.title = wanted.enabled ? 'Start Review Thread' : 'รอให้ turn จบ';
    this.reviewButton.disabled = !wanted.enabled;
  }

  protected onDispose(): void {
    this.head.dispose();
    this.stats?.dispose();
  }
}

export const def: ComponentDef = {
  id: 'lane-shell',
  blocks: [
    'acp-harness__lane',
    'acp-harness__lane-body',
    'acp-harness__lane-actions',
    'acp-harness__review-thread-action',
  ],
};
