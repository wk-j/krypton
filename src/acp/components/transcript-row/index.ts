// Spec 302 §3.0 — `TranscriptRow`, the base for one subclass per `item.kind`.
//
// The base owns the wrapper, the label, the body node and the image strip;
// subclasses own their body and whatever extra wrapper/label modifiers their
// kind implies.
//
// It extends `LiveComponent` for every kind, not just the four the agent
// streams into: a row that never streams is constructed with `live = false`,
// so `seal()` returns early and `appendChunk()` never runs. One hierarchy, and
// the four live kinds get the seal contract for free by overriding
// `appendChunk()` / `onSeal()`.
//
// `data-render-signature` is gone: a row's dependency tuple lives on its own
// subclass, next to the paint it guards.

import './transcript-row.css';

import { LiveComponent } from '../../../ui/component';
import { ImageStrip, imageStripSignature } from '../image-strip';
import {
  buildRowChrome,
  installEntranceAnimation,
  rowLabel,
  wrapperClasses,
  type RowProps,
} from './shared';
import type { ComponentDef } from '../types';

export type { RowProps } from './shared';

export abstract class TranscriptRow extends LiveComponent<RowProps> {
  protected readonly label: HTMLElement;
  protected readonly body: HTMLElement;
  private entering: boolean;
  private strip: ImageStrip | null = null;

  /** `live` is the agent-is-writing-into-this flag, not the entrance animation. */
  constructor(props: RowProps, live = false) {
    const chrome = buildRowChrome(props.item.id);
    super(chrome.el, live);
    this.label = chrome.label;
    this.body = chrome.body;
    this.entering = props.isNew;
    if (this.entering) {
      const detach = installEntranceAnimation(this.el, () => {
        this.entering = false;
      });
      this.bag.add(detach);
    }
  }

  protected readDeps(next: RowProps): readonly unknown[] {
    return [
      next.streaming,
      next.item.status,
      this.labelText(next),
      imageStripSignature(next.item),
      ...this.bodyDeps(next),
    ];
  }

  /** The values this kind's `paintBody()` reads. */
  protected abstract bodyDeps(next: RowProps): readonly unknown[];

  protected abstract paintBody(body: HTMLElement, next: RowProps): void;

  protected syncClasses(next: RowProps): void {
    this.el.className = wrapperClasses(next, this.entering, this.wrapperModifiers(next));
    this.label.className = ['acp-harness__msg-label', ...this.labelModifiers(next)].join(' ');
    this.label.replaceChildren(this.labelText(next));
    const extra = this.labelExtra(next);
    if (extra) this.label.appendChild(extra);
    this.body.className = ['acp-harness__msg-body', ...this.bodyClasses(next)].join(' ');
  }

  protected paint(next: RowProps): void {
    this.syncClasses(next);
    this.paintBody(this.body, next);
    this.syncImages(next);
  }

  /** Extra wrapper classes this kind implies, e.g. `acp-harness__msg--usage`. */
  protected wrapperModifiers(_next: RowProps): readonly string[] {
    return [];
  }

  protected labelText(next: RowProps): string {
    return rowLabel(next.item);
  }

  protected labelModifiers(_next: RowProps): readonly string[] {
    return [];
  }

  /** Optional node appended to the label — the thought-effort meter. */
  protected labelExtra(_next: RowProps): Node | null {
    return null;
  }

  /** Extra classes on `.acp-harness__msg-body`, e.g. `acp-harness__question`. */
  protected bodyClasses(_next: RowProps): readonly string[] {
    return [];
  }

  /** Static kinds never stream; the live four override these. */
  protected appendChunk(_next: RowProps): void {
    /* static row */
  }

  protected onSeal(): void {
    /* static row */
  }

  /** The strip is a child component: late thumbnail state never repaints the row. */
  private syncImages(next: RowProps): void {
    if (ImageStrip.isEmpty(next.item)) {
      if (this.strip) {
        this.strip.el.remove();
        this.strip.dispose();
        this.strip = null;
      }
      return;
    }
    if (!this.strip) {
      this.strip = new ImageStrip();
      this.el.appendChild(this.strip.el);
    }
    this.strip.update({ item: next.item });
  }

  protected onDispose(): void {
    this.strip?.dispose();
    this.strip = null;
  }
}

/**
 * The base owns the row wrapper and its two children, so it owns their rules —
 * including the label modifiers each kind sets (`--thought`, `--steer`,
 * `--steer-pending`, `--voice`), which are composed at runtime from state the
 * base derives.
 */
export const def: ComponentDef = {
  id: 'transcript-row',
  blocks: ['acp-harness__msg', 'acp-harness__msg-label', 'acp-harness__msg-body'],
};
