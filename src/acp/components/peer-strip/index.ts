// Spec 302 §6.5 — `PeerStrip`.
//
// The informational line above the composer input (spec 118): `⇆ awaiting
// codex · 5m+ · #cancel drops pending lane-mail wait`, `▼3 lane mails queued`,
// or the soft `awaiting lane mail · #cancel drops pending wait`. Built today by
// `buildComposerPeerStrip` (`lane-peek.ts:731-759`).
//
// The age bucket inside `awaitingPeerText()` is read from the clock, so the
// text — not the peer list — is the dependency, and it is computed ONCE per
// `update()` rather than inside `readDeps()`: a `readDeps()` that reads
// `Date.now()` can flip between the call before `paint()` and the verification
// call after it, which is exactly the instability the kernel warns about. This
// is also the second thing the 1 Hz composer rebuild was paying for: a strip
// whose bucket has not moved now writes nothing.

import './peer-strip.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { awaitingPeerText } from '../../harness-lane-chrome';
import type { PendingPeerSummary } from '../../inter-lane';
import type { HarnessLaneStatus } from '../../types';
import type { ComponentDef } from '../types';

export interface PeerStripProps {
  readonly laneStatus: HarnessLaneStatus;
  /** `coordinator.pendingPeersFor(lane.id)`. */
  readonly pendingPeers: PendingPeerSummary[];
  /** `coordinator.inboxDepth(lane.id)`. */
  readonly inboxDepth: number;
}

/** The strip's whole content, or `''` when there is nothing to say. */
function stripText(props: PeerStripProps): string {
  if (props.pendingPeers.length > 0) {
    // The chip form ends in a bare `#cancel`; the strip has room to say what
    // cancelling drops, so the short suffix is replaced rather than appended.
    const body = awaitingPeerText(props.pendingPeers).replace(/ · #cancel$/, '');
    return `⇆ ${body} · #cancel drops pending lane-mail wait`;
  }
  if (props.inboxDepth > 0) {
    return `▼${props.inboxDepth} lane mail${props.inboxDepth === 1 ? '' : 's'} queued`;
  }
  if (props.laneStatus === 'awaiting_peer') return 'awaiting lane mail · #cancel drops pending wait';
  return '';
}

export class PeerStrip extends Component<PeerStripProps> {
  private text = '';

  constructor() {
    super(el('div', { class: 'acp-harness__composer-peer', attrs: { role: 'status' } }));
  }

  update(next: PeerStripProps): void {
    this.text = stripText(next);
    super.update(next);
  }

  protected readDeps(): readonly unknown[] {
    return [this.text];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__composer-peer';
    this.el.hidden = this.text === '';
  }

  protected paint(): void {
    this.syncClasses();
    this.el.textContent = this.text;
  }
}

export const def: ComponentDef = { id: 'peer-strip', blocks: ['acp-harness__composer-peer'] };
