// Spec 302 §5.1 — the peek card's `prefix / value` row, and the segment model
// every peek value is built from.
//
// `renderLanePeekRow` (src/acp/lane-peek.ts:419-426) interpolated markup into
// the value half: `<b>` for the subject of a tool row, the inbox depth, the
// shell state and the review round, and `<span class="…-verdict">` for a
// reviewer's answer. A value is therefore not a string — it is a short ordered
// run of typed segments, which is what lets the row keep a stable dependency
// signature without an `innerHTML` round-trip.
//
// `StatList`'s `grid` layout emits the same `-row > -prefix + -value` shape,
// but its value is a `string | Node`: a caller with inline markup must hand it
// a freshly built node every pass, and a fresh node is never `Object.is`-equal,
// so every peek pass would repaint every row. The segment run is the same
// markup with a comparable dependency, so the peek rows keep their own row
// component. The `plan` row is a second reason: its value half is
// `.acp-harness__lane-peek-plan`, not `-value`, which `StatRow` cannot emit.

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';

/** One run inside a peek value. `strong` is the `<b>` the old templates spliced
 *  in; `verdict` is spec 277's coloured reviewer answer. */
export type PeekSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'verdict'; readonly text: string; readonly verdict: string };

export interface PeekRowProps {
  readonly prefix: string;
  readonly segments: readonly PeekSegment[];
  /** `data-peek-row` marker — `tool` today, read by the view's peek tests. */
  readonly dataRow?: string;
}

/** Comparable identity of a segment run, for a row's dependency tuple. */
export function segmentSignature(segments: readonly PeekSegment[]): string {
  let out = '';
  for (const segment of segments) {
    out += segment.kind === 'verdict'
      ? `v\u001f${segment.verdict}\u001f${segment.text}\u001e`
      : `${segment.kind}\u001f${segment.text}\u001e`;
  }
  return out;
}

/** Nodes for a segment run. Text goes through the DOM, never through `esc()`. */
export function segmentNodes(segments: readonly PeekSegment[]): (Node | string)[] {
  const out: (Node | string)[] = [];
  for (const segment of segments) {
    if (segment.text === '') continue;
    if (segment.kind === 'text') out.push(segment.text);
    else if (segment.kind === 'strong') out.push(el('b', { text: segment.text }));
    else {
      out.push(el('span', {
        class: 'acp-harness__lane-peek-verdict',
        data: { verdict: segment.verdict },
        text: segment.text,
      }));
    }
  }
  return out;
}

export class PeekRow extends Component<PeekRowProps> {
  private readonly prefixEl = el('span', { class: 'acp-harness__lane-peek-prefix' });
  private readonly valueEl = el('span', { class: 'acp-harness__lane-peek-value' });

  constructor() {
    super(el('div'));
    this.el.append(this.prefixEl, this.valueEl);
  }

  protected readDeps(next: PeekRowProps): readonly unknown[] {
    return [next.prefix, segmentSignature(next.segments), next.dataRow];
  }

  protected syncClasses(_next: PeekRowProps): void {
    this.el.className = 'acp-harness__lane-peek-row';
  }

  protected paint(next: PeekRowProps): void {
    this.syncClasses(next);
    setAttr(this.el, 'data-peek-row', next.dataRow);
    this.prefixEl.textContent = next.prefix;
    this.valueEl.replaceChildren(...segmentNodes(next.segments));
  }
}
