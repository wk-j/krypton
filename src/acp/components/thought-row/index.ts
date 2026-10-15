// Spec 302 §3.2 — `ThoughtRow` (live).
//
// Reasoning text: a thought-effort meter under the label and ONE text node in
// the body, grown in place while the model thinks and kept across the seal.
//
// Ports `harness-transcript-render.ts:287-296` (label + meter + body),
// `updateStreamingTextBody()`'s thought branch and the seal at
// `acp-harness-view.ts:14487-14507`.
//
// Spec 114 rev 19: sealing a thought must NOT replace `body.firstChild`.
// Replacing an identical text node laid the row out again at every
// thought→assistant / thought→tool / thought→stop boundary, which WebKit could
// paint as a flash. `onSeal()` therefore repairs the node's data only when it
// does not already hold the final collapsed text.

import './thought-row.css';

import { el } from '../../../ui/dom';
import { collapseThoughtBlankLines } from '../../harness-format';
import { Meter } from '../meter';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';

const VEIL_CLASS = 'acp-harness__msg-body--thought-veil';
const PLAIN_CLASS = 'acp-harness__msg-body--stream-plain';

export class ThoughtRow extends TranscriptRow {
  private current: RowProps;
  private readonly meter = new Meter('glyph');
  /** The live plain-text node — the one node the seal must not replace. */
  private textNode: Text | null = null;
  private veiled = false;

  constructor(props: RowProps) {
    super(props, props.streaming);
    this.current = props;
  }

  update(next: RowProps): void {
    this.current = next;
    super.update(next);
  }

  seal(next: RowProps): void {
    this.current = next;
    super.seal(next);
  }

  /**
   * Deps and classes both read `isLive`, not `props.streaming`: a caller that
   * seals and then keeps passing `streaming: true` can neither leave
   * `--streaming` on the wrapper nor force a repaint of the sealed row.
   */
  protected readDeps(next: RowProps): readonly unknown[] {
    return super.readDeps(!this.isLive && next.streaming ? { ...next, streaming: false } : next);
  }

  protected syncClasses(next: RowProps): void {
    // The meter is a child component, so the label keeps its node across paints.
    if (next.item.text.length > 0) this.meter.update({ mode: 'glyph', value: next.item.text.length });
    super.syncClasses(!this.isLive && next.streaming ? { ...next, streaming: false } : next);
  }

  protected labelModifiers(): readonly string[] {
    return ['acp-harness__msg-label--thought'];
  }

  /** No meter while the row is veiled (zero text) — a "brief" reading on
   *  hidden reasoning would be a lie about how much thinking is happening. */
  protected labelExtra(next: RowProps): Node | null {
    return next.item.text.length > 0 ? this.meter.el : null;
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    // Live text arrives through appendChunk(); depending on it here would
    // rebuild the row on every delta.
    return this.isLive ? ['live'] : [next.item.text];
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    if (!this.isLive) return [];
    return next.item.text.length === 0 ? [VEIL_CLASS] : [PLAIN_CLASS];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    // A live body belongs to appendChunk(), which runs straight after paint().
    if (this.isLive) return;
    const text = collapseThoughtBlankLines(next.item.text);
    if (this.textNode && this.textNode.parentNode === body && body.childNodes.length === 1) {
      if (this.textNode.data !== text) this.textNode.data = text;
      return;
    }
    this.textNode = document.createTextNode(text);
    body.replaceChildren(this.textNode);
  }

  protected appendChunk(next: RowProps): void {
    const { item } = next;
    if (item.text.length === 0) {
      this.installVeil(next);
      return;
    }
    // The collapsed form is not a prefix of `item.text` — a blank line dropped
    // in the middle shifts everything after it — so the node is rewritten from
    // the collapsed text instead of grown with appendData().
    const text = collapseThoughtBlankLines(item.text);
    if (this.veiled || !this.textNode || this.textNode.parentNode !== this.body) {
      this.textNode = document.createTextNode(text);
      this.body.replaceChildren(this.textNode);
      this.veiled = false;
      this.syncBodyClasses(next);
    } else if (this.textNode.data === text) {
      return;
    } else {
      this.textNode.data = text;
    }
    item.streamPlainLength = item.text.length;
    this.body.scrollTop = this.body.scrollHeight;
  }

  protected onSeal(): void {
    const { item } = this.current;
    const text = collapseThoughtBlankLines(item.text);
    item.streamPlainLength = undefined;
    if (this.veiled) {
      // Nothing ever arrived; the view drops this row, but leave no veil behind.
      this.body.replaceChildren();
      this.textNode = null;
      this.veiled = false;
      return;
    }
    if (!this.textNode || this.textNode.parentNode !== this.body || this.body.childNodes.length !== 1) {
      this.textNode = document.createTextNode(text);
      this.body.replaceChildren(this.textNode);
      return;
    }
    if (this.textNode.data !== text) this.textNode.data = text;
  }

  protected onDispose(): void {
    super.onDispose();
    this.meter.dispose();
    this.textNode = null;
  }

  /** Veiled thinking: providers that keep reasoning server-side stream deltas
   *  whose text is empty. Show "thinking" with pulsing dots, never an empty
   *  block. The dots are children 2-4, which is what the CSS nth-child rules
   *  stagger. */
  private installVeil(next: RowProps): void {
    if (this.veiled) return;
    this.body.replaceChildren(
      el(
        'span',
        { class: 'acp-harness__thought-veil' },
        el('span', { class: 'acp-harness__thought-veil-word', text: 'thinking' }),
        el('span', { class: 'acp-harness__thought-veil-dot', text: '·' }),
        el('span', { class: 'acp-harness__thought-veil-dot', text: '·' }),
        el('span', { class: 'acp-harness__thought-veil-dot', text: '·' }),
      ),
    );
    this.textNode = null;
    this.veiled = true;
    this.syncBodyClasses(next);
  }

  /** Re-derive the body's FULL class string — never a remove-by-name. */
  private syncBodyClasses(next: RowProps): void {
    this.body.className = ['acp-harness__msg-body', ...this.bodyClasses(next)].join(' ');
  }
}

export const def: ComponentDef = {
  id: 'thought-row',
  blocks: ['acp-harness__thought-effort', 'acp-harness__thought-veil'],
};
