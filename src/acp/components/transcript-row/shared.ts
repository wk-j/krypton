// Spec 302 §3.0 — the chrome every transcript row shares.
//
// Two base classes need it (`TranscriptRow extends Component`,
// `LiveTranscriptRow extends LiveComponent`) and TypeScript has no multiple
// inheritance, so the shared part is a handful of pure functions rather than a
// mixin. `data-render-signature` is deliberately absent: deps live on each row
// subclass now.

import { transcriptLabel } from '../../harness-lane-chrome';
import type { HarnessLane, HarnessTranscriptItem } from '../../harness-view-types';

export interface RowProps {
  readonly item: HarnessTranscriptItem;
  /** First time this id is rendered — drives the `--enter` entrance animation. */
  readonly isNew: boolean;
  /** The agent is writing into this row right now. */
  readonly streaming: boolean;
  /** Resolves rail thumbnails borrowed from other rows (spec 286). */
  readonly lane: HarnessLane | null;
  readonly projectDir: string | null;
  readonly resolveLocalImages: boolean;
}

export interface RowChrome {
  readonly el: HTMLElement;
  readonly label: HTMLElement;
  readonly body: HTMLElement;
}

const ENTER_CLASS = 'acp-harness__msg--enter';
const ENTER_ANIMATION = 'acp-harness-msg-enter';

export function buildRowChrome(itemId: string): RowChrome {
  const el = document.createElement('div');
  el.dataset.msgId = itemId;
  const label = document.createElement('div');
  label.className = 'acp-harness__msg-label';
  const body = document.createElement('div');
  body.className = 'acp-harness__msg-body';
  el.append(label, body);
  return { el, label, body };
}

/**
 * Add `--enter` and release it on `animationend`.
 *
 * The row owns this, which is why `paint()` never writes `className` wholesale
 * and the `const entering = …` rescue in the old transcript loop is gone: the
 * class is part of the state `syncWrapperClasses` derives from.
 */
export function installEntranceAnimation(el: HTMLElement, onRelease: () => void): () => void {
  const release = (event: AnimationEvent): void => {
    if (event.target !== el || event.animationName !== ENTER_ANIMATION) return;
    el.classList.remove(ENTER_CLASS);
    onRelease();
    detach();
  };
  const detach = (): void => {
    el.removeEventListener('animationend', release);
    el.removeEventListener('animationcancel', release);
  };
  el.addEventListener('animationend', release);
  el.addEventListener('animationcancel', release);
  return detach;
}

/**
 * The wrapper class string, derived wholly from state.
 *
 * `entering` is passed in rather than read off the node: once the entrance
 * animation has fired, the row must not re-add `--enter` on a later paint.
 */
export function wrapperClasses(
  props: RowProps,
  entering: boolean,
  extra: readonly string[] = [],
): string {
  const { item, streaming } = props;
  const out = ['acp-harness__msg', `acp-harness__msg--${item.kind}`];
  if (item.status) out.push(`acp-harness__msg--${item.status}`);
  if (entering) out.push(ENTER_CLASS);
  if (streaming) out.push('acp-harness__msg--streaming');
  for (const cls of extra) {
    if (cls && !out.includes(cls)) out.push(cls);
  }
  return out.join(' ');
}

/** The default label text for a kind; subclasses override per spec 302 §3.0. */
export function rowLabel(item: HarnessTranscriptItem): string {
  return transcriptLabel(item.kind);
}
