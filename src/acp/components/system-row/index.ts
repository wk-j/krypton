// Spec 302 §3.14 — `SystemRow` + `HiddenRowsIndicator`.
//
// Three shapes of one row, because they are three states of the same `system`
// item rather than three kinds:
//
//   plain       `sys    lane restarted — session 4f2a9c`
//   indicator   `       ↑ 142 earlier rows hidden — Ctrl+H show 60 more`
//   event       `event  reviewer-1 finished round 2`   (inter-lane harness event)
//
// Ported from `harness-transcript-render.ts:379-383` (the event branch) and its
// plain-text fallback at `:429-431`, plus the indicator synthesis at
// `acp-harness-view.ts:12150-12159`.
//
// The indicator is a SYNTHETIC item: it has no place in `lane.transcript`, it
// is prepended to the render list while the tail window hides rows, and it must
// never play the entrance animation — today that is bought by adding its id to
// `lane.seenTranscriptIds` before the render loop reads `isNew`, which is an
// invariant held by the caller. Here the row holds it itself: the indicator
// constructs its chrome with `isNew: false` whatever the caller passed, so the
// `--enter` class is unreachable for it.

import './system-row.css';

import { TranscriptRow, type RowProps } from '../transcript-row';
import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { ComponentDef } from '../types';

/** Id of the synthetic hidden-rows row. Matches `acp-harness-view.ts:822`. */
export const HIDDEN_INDICATOR_ID = '__hidden_indicator__';

const EVENT_PREFIX = '[inter-lane]';
const EVENT_PREFIX_RE = /^\[inter-lane\]\s*/u;

export type SystemRowVariant = 'plain' | 'event';

/**
 * Which body a `system` item renders. Exported because the transcript
 * dispatcher must tell an inter-lane harness event apart from a directive
 * approval card: both are `kind === 'system'`, and the event branch wins today
 * (`harness-transcript-render.ts:379` runs before the `item.diff` branch at
 * `:395`), so an item carrying both renders as an event.
 */
export function systemRowVariant(item: HarnessTranscriptItem): SystemRowVariant {
  return item.text.startsWith(EVENT_PREFIX) ? 'event' : 'plain';
}

/** The row the tail window prepends while earlier rows are hidden (spec 103). */
export function hiddenRowsIndicatorItem(hidden: number, step: number): HarnessTranscriptItem {
  return {
    id: HIDDEN_INDICATOR_ID,
    kind: 'system',
    text: `↑ ${hidden} earlier row${hidden === 1 ? '' : 's'} hidden — Ctrl+H show ${step} more`,
  };
}

export class SystemRow extends TranscriptRow {
  private readonly indicator: boolean;

  constructor(props: RowProps) {
    const indicator = props.item.id === HIDDEN_INDICATOR_ID;
    super(indicator ? { ...props, isNew: false } : props, false);
    this.indicator = indicator;
  }

  protected wrapperModifiers(next: RowProps): readonly string[] {
    const out: string[] = [];
    if (this.indicator) out.push('acp-harness__msg--hidden-indicator');
    if (systemRowVariant(next.item) === 'event') out.push('acp-harness__msg--harness-event');
    return out;
  }

  protected labelText(next: RowProps): string {
    return systemRowVariant(next.item) === 'event' ? 'event' : 'sys';
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    return systemRowVariant(next.item) === 'event' ? ['acp-harness__harness-event-body'] : [];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    return [next.item.text];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const text = next.item.text;
    body.textContent = systemRowVariant(next.item) === 'event' ? text.replace(EVENT_PREFIX_RE, '') : text;
  }
}

export const def: ComponentDef = {
  id: 'system-row',
  blocks: [
    'acp-harness__msg--hidden-indicator',
    'acp-harness__msg--harness-event',
    'acp-harness__harness-event-body',
  ],
};
