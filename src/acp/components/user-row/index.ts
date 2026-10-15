// Spec 302 §3.3 — `UserRow` (live).
//
// What the human said. The body is one text node grown in place (spec 114 rev
// 4, rev 24: a sealed user row stays one natively wrapped text node); the
// label carries the spec 278 steer state and the spec 280 voice marker.
//
// Ports `harness-transcript-render.ts:277-290` (label vocabulary) and the
// shared plain-text streaming path (`updateStreamingTextBody` /
// `sealStreamingTextBody`, `harness-markdown.ts:350-416`).
//
// It owns no block: `--steer`, `--steer-pending` and `--voice` are modifiers of
// the row base's `acp-harness__msg-label`, so their rules stay with that
// block's owner and this directory ships no stylesheet.

import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';

export class UserRow extends TranscriptRow {
  private current: RowProps;
  /** The live plain-text node; `appendData` grows it, the seal keeps it. */
  private textNode: Text | null = null;

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
    super.syncClasses(!this.isLive && next.streaming ? { ...next, streaming: false } : next);
  }

  /** spec 278: a message sent into the running turn reads `steer…` until the
   *  adapter takes it, then `steer`. spec 280: a voice row says so. */
  protected labelText(next: RowProps): string {
    const { item } = next;
    const base = item.steer ? (item.steer === 'pending' ? 'steer…' : 'steer') : super.labelText(next);
    return item.voice ? `${base} · voice` : base;
  }

  protected labelModifiers(next: RowProps): readonly string[] {
    const { item } = next;
    const out: string[] = [];
    if (item.steer) {
      out.push('acp-harness__msg-label--steer');
      if (item.steer === 'pending') out.push('acp-harness__msg-label--steer-pending');
    }
    if (item.voice) out.push('acp-harness__msg-label--voice');
    return out;
  }

  protected bodyClasses(): readonly string[] {
    return this.isLive ? ['acp-harness__msg-body--stream-plain'] : [];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    // Live text arrives through appendChunk(); depending on it here would
    // rebuild the row on every delta.
    return this.isLive ? ['live'] : [next.item.text];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    // A live body belongs to appendChunk(), which runs straight after paint().
    if (this.isLive) return;
    if (this.textNode && this.textNode.parentNode === body && body.childNodes.length === 1) {
      if (this.textNode.data !== next.item.text) this.textNode.data = next.item.text;
      return;
    }
    this.textNode = document.createTextNode(next.item.text);
    body.replaceChildren(this.textNode);
  }

  protected appendChunk(next: RowProps): void {
    const { item } = next;
    if (!this.textNode || this.textNode.parentNode !== this.body) {
      this.textNode = document.createTextNode(item.text);
      this.body.replaceChildren(this.textNode);
      item.streamPlainLength = item.text.length;
      return;
    }
    const written = item.streamPlainLength ?? 0;
    if (item.text.length > written) {
      this.textNode.appendData(item.text.slice(written));
    } else if (item.text.length < written) {
      this.textNode.data = item.text;
    } else {
      return;
    }
    item.streamPlainLength = item.text.length;
  }

  /** Keep the live node (spec 114 rev 19's reason applies here too: replacing
   *  an identical node re-lays out the row at the turn boundary); repair its
   *  data only when the stream and the final text disagree. */
  protected onSeal(): void {
    const { item } = this.current;
    item.streamPlainLength = undefined;
    if (!this.textNode || this.textNode.parentNode !== this.body || this.body.childNodes.length !== 1) {
      this.textNode = document.createTextNode(item.text);
      this.body.replaceChildren(this.textNode);
      return;
    }
    if (this.textNode.data !== item.text) this.textNode.data = item.text;
  }

  protected onDispose(): void {
    super.onDispose();
    this.textNode = null;
  }
}

export const def: ComponentDef = { id: 'user-row', blocks: [] };
