// Spec 302 — `DirectiveDiffRow`, the row that hosts `DiffBlock` in `raw` mode.
//
// The directive upsert approval card (spec 124): a `system` row carrying
// `item.diff`, rendered as the prompt text followed by the unified diff printed
// verbatim, sign included. Ported from `harness-transcript-render.ts:395-415`.
//
// The catalog lists this only as a `DiffBlock` mode (§2.5) — the `<pre>` and its
// `-add` / `-del` / `-ctx` rows belong to the component. What is left over, and
// what lives here, is the row: the `acp-harness__msg-text` paragraph above the
// diff, and the block ownership for both.
//
// `item.diff.title` is deliberately unused: the builder never rendered it, and
// `item.text` already carries the human prompt.

import './directive-diff-row.css';

import { el, setChildren } from '../../../ui/dom';
import { DiffBlock, rawDiffRows } from '../diff-block';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';

export class DirectiveDiffRow extends TranscriptRow {
  private readonly text: HTMLElement;
  private readonly diff: DiffBlock;

  constructor(props: RowProps) {
    super(props, false);
    this.text = el('div', { class: 'acp-harness__msg-text' });
    this.diff = new DiffBlock('raw');
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    return [next.item.text, next.item.diff?.unified];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    this.text.textContent = next.item.text;
    const unified = next.item.diff?.unified;
    if (unified === undefined) {
      setChildren(body, [this.text]);
      return;
    }
    this.diff.update({ mode: 'raw', prefix: 'acp-harness', rows: rawDiffRows(unified) });
    setChildren(body, [this.text, this.diff.el]);
  }

  protected onDispose(): void {
    super.onDispose();
    this.diff.dispose();
  }
}

export const def: ComponentDef = {
  id: 'directive-diff-row',
  blocks: ['acp-harness__directive-diff', 'acp-harness__msg-text'],
};
