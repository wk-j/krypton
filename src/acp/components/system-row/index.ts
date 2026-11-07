// Spec 302 §3.14 — `SystemRow` + `HiddenRowsIndicator`; spec 371 notices.
//
// Four shapes of one row, because they are states of the same `system` item
// rather than separate kinds:
//
//   plain       `sys    lane restarted — session 4f2a9c`
//   indicator   `       ↑ 142 earlier rows hidden — [⌃H] show 60 more`  (key cap)
//   notice      `triage ● FLAGGED  Should the lamp be green?`  (spec 371)
//   event       `event  peer OMP-2 cancelled`   (an inter-lane notice)
//
// A notice is data the caller set (`item.notice`): its source is the label,
// its action a flat-ink legend with a status LED before it when the tone asks
// for the human, then the subject. `item.text` is only its portable line for
// other readers; this row never parses it.
//
// The plain shape was ported from `harness-transcript-render.ts:429-431`, the
// indicator synthesis from `acp-harness-view.ts:12150-12159`.
//
// The indicator is a SYNTHETIC item: it has no place in `lane.transcript`, it
// is prepended to the render list while the tail window hides rows, and it must
// never play the entrance animation — today that is bought by adding its id to
// `lane.seenTranscriptIds` before the render loop reads `isNew`, which is an
// invariant held by the caller. Here the row holds it itself: the indicator
// constructs its chrome with `isNew: false` whatever the caller passed, so the
// `--enter` class is unreachable for it.

import './system-row.css';

import { keyCap } from '../../../ui/kbd';
import { el } from '../../../ui/dom';
import { TranscriptRow, type RowProps } from '../transcript-row';
import { gridifyText } from '../../cell-grid';
import { NOTICE_LABEL, type HarnessNotice } from '../../harness-notice';
import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { ComponentDef } from '../types';

/** Id of the synthetic hidden-rows row. Matches `acp-harness-view.ts:822`. */
export const HIDDEN_INDICATOR_ID = '__hidden_indicator__';

/** The indicator's key, painted as a `<kbd>` cap (spec 369). */
const SHOW_MORE_KEY = '⌃H';

export type SystemRowVariant = 'plain' | 'notice' | 'event';

/**
 * Which body a `system` item renders. Exported because the transcript
 * dispatcher routes a notice before the directive-diff branch: an item
 * carrying both renders as the notice, as the inter-lane event always did.
 */
export function systemRowVariant(item: HarnessTranscriptItem): SystemRowVariant {
  const source = item.notice?.source;
  if (source === undefined) return 'plain';
  return source === 'inter-lane' ? 'event' : 'notice';
}

/** `[action legend] subject`, or the subject alone when there is no action. */
function noticeNodes(notice: HarnessNotice): HTMLElement[] {
  const subject = el('span', { class: 'acp-harness__notice-subject', text: notice.subject });
  if (!notice.action) return [subject];
  const action = el('span', {
    class: `acp-harness__notice-action acp-harness__notice-action--${notice.tone}`,
    text: notice.action,
  });
  return [action, subject];
}

/** The row the tail window prepends while earlier rows are hidden (spec 103). */
export function hiddenRowsIndicatorItem(hidden: number, step: number): HarnessTranscriptItem {
  return {
    id: HIDDEN_INDICATOR_ID,
    kind: 'system',
    text: `↑ ${hidden} earlier row${hidden === 1 ? '' : 's'} hidden — ${SHOW_MORE_KEY} show ${step} more`,
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
    const notice = next.item.notice;
    return notice ? NOTICE_LABEL[notice.source] : 'sys';
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    return systemRowVariant(next.item) === 'event' ? ['acp-harness__harness-event-body'] : [];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    return [next.item.text, next.item.notice];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const { notice, text } = next.item;
    if (notice) {
      body.replaceChildren(...noticeNodes(notice));
      return;
    }
    if (this.indicator) {
      // The text is built by `hiddenRowsIndicatorItem` above; its key becomes a cap.
      const at = text.indexOf(SHOW_MORE_KEY);
      if (at >= 0) {
        body.replaceChildren(text.slice(0, at), keyCap(SHOW_MORE_KEY), text.slice(at + SHOW_MORE_KEY.length));
        return;
      }
    }
    body.textContent = text;
    // Spec 326: `!shell` output laid out by columns sits on the cell grid. Other
    // system text is prose and keeps wrapping.
    if (next.item.kind === 'shell') gridifyText(body);
  }
}

export const def: ComponentDef = {
  id: 'system-row',
  blocks: [
    'acp-harness__msg--hidden-indicator',
    'acp-harness__msg--harness-event',
    'acp-harness__harness-event-body',
    'acp-harness__notice',
  ],
};
