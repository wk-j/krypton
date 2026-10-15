// Spec 302 §1.7 — `KeyHintBar`.
//
// The "what can I press here" strip. Nine call sites paint it four different
// ways today, and the differences are real markup, not noise:
//
//   * review / priority overlay foot  — one `<span>` per hint, no separator,
//     trailing `<span class="…__foot-note">` (acp-harness-view.ts:5412-5429,
//     review-priority-overlay.ts:121-127);
//   * triage action hint + annotate pill — `<kbd>` runs written straight into
//     the container, joined by ` · ` (attention-overlay.ts:127-130,
//     acp-harness-view.ts:15081) — and the redirect variant of that same
//     container is plain text with the note joined by ` — `
//     (attention-overlay.ts:124);
//   * picker / palette headers — one `<span>` of `·`-joined plain text
//     (acp-harness-view.ts:12705-12710,12770-12774,12807-12811,12838-12892,
//     harness-lane-chrome.ts:463);
//   * ticket footer — the whole run inside one bare `<span>`, with a second
//     bare `<span>` for the note (harness-ticket-controller.ts:780-783).
//
// So `style` picks how a key is drawn and `layout` picks how the run is
// wrapped; neither is derived from the other. The component's root IS the
// container the caller used to build by hand (`.acp-review__foot`,
// `.acp-triage__action-hint`, the header's `<span>`), so nothing wraps it and
// the existing CSS keeps matching. It owns no block: `block` is the root's
// full class, supplied by the caller.

import { Component } from '../../../ui/component';
import { classes, el, setChildren, type ElChild } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export interface KeyHint {
  /** Rendered as `<kbd>` each (`kbd`) or as text (`plain`). May be empty. */
  readonly keys: readonly string[];
  /** Follows the keys after a single space. May be empty. */
  readonly label: string;
  /** Joins this hint's keys. Default `' '`; the triage bar uses `'/'`. */
  readonly keySeparator?: string;
}

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
  readonly style: 'kbd' | 'plain';
  /** The root's full class name. `''` leaves the root unclassed. */
  readonly block: string;
  /** Default: `spans` for `kbd`, `bare` for `plain`. */
  readonly layout?: KeyHintLayout;
  /** Between hints. Default `''` for `spans`, `' · '` otherwise. */
  readonly separator?: string;
  /** Class of the note node. Omitted — a bare `<span>`, as the ticket foot emits. */
  readonly noteClass?: string;
  /** Set — the note is joined into the text run instead of getting its own node. */
  readonly noteJoin?: string;
}

/** `['j','k']` + `select round` → `j k select round` with the caller's key joiner. */
function hintText(hint: KeyHint): string {
  const keys = hint.keys.join(hint.keySeparator ?? ' ');
  if (!keys) return hint.label;
  return hint.label ? `${keys} ${hint.label}` : keys;
}

/** `<kbd>j</kbd> <kbd>k</kbd> select round` as nodes, never as a string. */
function kbdChildren(hint: KeyHint): ElChild[] {
  const separator = hint.keySeparator ?? ' ';
  const out: ElChild[] = [];
  hint.keys.forEach((key, index) => {
    if (index > 0 && separator) out.push(separator);
    out.push(el('kbd', { text: key }));
  });
  if (hint.label) out.push(out.length > 0 ? ` ${hint.label}` : hint.label);
  return out;
}

export class KeyHintBar extends Component<KeyHintBarProps> {
  constructor(tag: 'div' | 'span' | 'footer' = 'div') {
    super(el(tag));
  }

  protected readDeps(next: KeyHintBarProps): readonly unknown[] {
    return [
      next.hints
        .map((hint) => `${hint.keys.join('\u0000')}\u0001${hint.label}\u0001${hint.keySeparator ?? ''}`)
        .join('\u0002'),
      next.note,
      next.style,
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

    const layout = next.layout ?? (next.style === 'kbd' ? 'spans' : 'bare');
    const separator = next.separator ?? (layout === 'spans' ? '' : ' · ');
    const joinedNote = next.note && next.noteJoin !== undefined ? `${next.noteJoin}${next.note}` : null;

    const children: ElChild[] = [];
    if (layout === 'spans') {
      next.hints.forEach((hint, index) => {
        if (index > 0 && separator) children.push(separator);
        const content = next.style === 'kbd' ? kbdChildren(hint) : [hintText(hint)];
        children.push(el('span', { children: content }));
      });
      if (joinedNote) children.push(joinedNote);
    } else {
      const run = this.runChildren(next, separator);
      if (joinedNote) {
        // The note continues the sentence, so it continues the text node too:
        // `Enter send · Esc cancel — delivered on the lane’s next idle`.
        const last = run.length > 0 ? run[run.length - 1] : null;
        if (typeof last === 'string') run[run.length - 1] = `${last}${joinedNote}`;
        else run.push(joinedNote);
      }
      if (layout === 'run') children.push(el('span', { children: run }));
      else children.push(...run);
    }

    if (next.note && joinedNote === null) {
      children.push(el('span', { class: next.noteClass, text: next.note }));
    }
    setChildren(this.el, children);
  }

  /** One text node for a plain run; `<kbd>`-bearing nodes otherwise. */
  private runChildren(next: KeyHintBarProps, separator: string): ElChild[] {
    if (next.style === 'plain') return [next.hints.map(hintText).join(separator)];
    const out: ElChild[] = [];
    next.hints.forEach((hint, index) => {
      if (index > 0 && separator) out.push(separator);
      out.push(...kbdChildren(hint));
    });
    return out;
  }
}

export const def: ComponentDef = { id: 'key-hint-bar', blocks: [] };
