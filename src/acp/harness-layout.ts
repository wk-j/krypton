// Spec 301 §Layout — where a harness panel lives.
//
// Before this, a panel's position was nailed down in three unrelated places:
// the `appendChild` order in `buildDOM`, the absolute positioning in
// `acp-harness.css`, and a private `*SlotEl` field each renderer addressed by
// name. Moving one panel was a three-file edit with no compiler help.
//
// Now it is one line in `HARNESS_LAYOUT_DEFAULT`, type-checked against the slot
// union. Slots own their own sizing rules, so no CSS edit; renderers address
// their component, so no renderer edit.

import type { LayoutTable } from '../ui/layout';

export type HarnessSlot =
  | 'lane.head'
  | 'lane.understats'
  | 'rail.top'
  | 'rail.bottom'
  | 'dock.right'
  | 'composer.above'
  | 'composer.below';

export type HarnessLayout = LayoutTable<HarnessSlot>;

/**
 * Today's arrangement, reproduced exactly.
 *
 * Order within `rail.top` matches the `appendChild` order in `buildDOM`
 * (plan, peek, thought); `rail.bottom` holds the prompt queue, which CSS pins
 * with `margin-top: auto`.
 *
 * The annotation rail is NOT here. It is transcript content — `AssistantRow`
 * appends it to the message body it annotates (spec 302 §5.8), under the reply
 * whose quotes the notes point at — so a `rail.top` slot would MOVE it, not
 * place it. A layout row nothing can mount is a lie about where a panel lives.
 */
export const HARNESS_LAYOUT_DEFAULT = {
  plan: { slot: 'rail.top', order: 10 },
  peek: { slot: 'rail.top', order: 20 },
  thought: { slot: 'rail.top', order: 30 },
  queue: { slot: 'rail.bottom', order: 10 },
  ticket: { slot: 'dock.right', order: 10 },
  peerStrip: { slot: 'composer.above', order: 10 },
} as const satisfies HarnessLayout;

/**
 * Surfaces that are deliberately NOT placeable.
 *
 * - `.acp-harness__lane-body` (the transcript): reparenting a scroll container
 *   discards `scrollTop`. The layout may resize its slot; it may never move
 *   the node. Spec 94/95 exist because of this.
 * - The composer: keyboard-first (CLAUDE.md constraint 1) — the command escape
 *   hatch must always be present. Its slot may move; the component may not be
 *   unmounted.
 * - Inline permission / question / write-review rows: transcript content, not
 *   panels. Spec 251 already drew that line — hiding or moving a panel must
 *   never conceal an action that unblocks a lane.
 *
 * `#panels` (spec 251) is independent and unchanged: it hides the whole rail
 * via a root class, which is coarser than, and orthogonal to, slot placement.
 */
export const HARNESS_PINNED_SURFACES = ['transcript', 'composer', 'inlineDecisions'] as const;
