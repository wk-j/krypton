// Spec 302 §1.7 — `KeyHintBar`.
//
// The "what can I press here" strip. Its call sites wrap the run three ways,
// and the differences are real markup, not noise:
//
//   * overlay feet (review, priority, execution dialog) — one `<span>` per
//     hint, no separator, trailing `<span class="…__foot-note">` (`spans`);
//   * triage hint, picker and palette heads, composer rows — the run written
//     straight into the container, joined by ` · ` (`bare`);
//   * ticket footer — the whole run inside one bare `<span>`, with a second
//     bare `<span>` for the note (`run`).
//
// `layout` picks how the run is wrapped. Every key is a `<kbd>` cap (spec 369):
// the caps and hint runs come from `src/ui/kbd.ts`, so this bar and every
// hand-built hint line draw the same cap. The component's root IS the
// container the caller used to build by hand (`.acp-review__foot`,
// `.acp-triage__action-hint`, the header's `<span>`), so nothing wraps it and
// the existing CSS keeps matching. It owns no block: `block` is the root's
// full class, supplied by the caller.

import { Component } from '../../../ui/component';
import { classes, el, setChildren, type ElChild } from '../../../ui/dom';
import { keyHint, keyHintNodes, keyHintsSignature, type KeyHint } from '../../../ui/kbd';
import type { ComponentDef } from '../types';

/**
 * `spans` — one `<span>` per hint (the overlay feet).
 * `run`   — the whole joined run inside one `<span>` (the ticket footer).
 * `bare`  — the run written straight into the root (headers, hints, pills).
 */
export type KeyHintLayout = 'spans' | 'run' | 'bare';

export interface KeyHintBarProps {
  readonly hints: readonly KeyHint[];
  /** Trailing aside. Absent or empty emits no node and no text. */
  readonly note?: string;
  /** The root's full class name. `''` leaves the root unclassed. */
  readonly block: string;
  /** Default: `bare`. */
  readonly layout?: KeyHintLayout;
  /** Between hints. Default `''` for `spans`, `' · '` otherwise. */
  readonly separator?: string;
  /** Class of the note node. Omitted — a bare `<span>`, as the ticket foot emits. */
  readonly noteClass?: string;
  /** Set — the note is joined into the text run instead of getting its own node. */
  readonly noteJoin?: string;
}

/** One hint as a `<span>`, even a legend-only one: the overlay feet style `> span`. */
function hintSpan(hint: KeyHint): Node {
  return hint.keys.length > 0 ? keyHint(hint) : el('span', { text: hint.label });
}

export class KeyHintBar extends Component<KeyHintBarProps> {
  constructor(tag: 'div' | 'span' | 'footer' = 'div') {
    super(el(tag));
  }

  protected readDeps(next: KeyHintBarProps): readonly unknown[] {
    return [
      keyHintsSignature(next.hints),
      next.note,
      next.block,
      next.layout,
      next.separator,
      next.noteClass,
      next.noteJoin,
    ];
  }

  protected syncClasses(next: KeyHintBarProps): void {
    const className = classes(next.block);
    if (className) this.el.className = className;
    else this.el.removeAttribute('class');
  }

  protected paint(next: KeyHintBarProps): void {
    this.syncClasses(next);

    const layout = next.layout ?? 'bare';
    const separator = next.separator ?? (layout === 'spans' ? '' : ' · ');
    const joinedNote = next.note && next.noteJoin !== undefined ? `${next.noteJoin}${next.note}` : null;

    const children: ElChild[] = [];
    if (layout === 'spans') {
      next.hints.forEach((hint, index) => {
        if (index > 0 && separator) children.push(separator);
        children.push(hintSpan(hint));
      });
      if (joinedNote) children.push(joinedNote);
    } else {
      // The note continues the sentence: `Enter send · Esc cancel — delivered on the lane’s next idle`.
      const run: ElChild[] = [...keyHintNodes(next.hints, separator)];
      if (joinedNote) run.push(joinedNote);
      if (layout === 'run') children.push(el('span', { children: run }));
      else children.push(...run);
    }

    if (next.note && joinedNote === null) {
      children.push(el('span', { class: next.noteClass, text: next.note }));
    }
    setChildren(this.el, children);
  }
}

export const def: ComponentDef = { id: 'key-hint-bar', blocks: [] };
