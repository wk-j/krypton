// Spec 302 §1.5 — `EmptyState`.
//
// The one-line "nothing here yet" row the harness paints eighteen times across
// ten class names: the transcript, the lane dashboard, the backend picker, the
// session picker (loading / error / no sessions), the memory drawer, the review
// matrix, the triage queue, the reading-priority panel and the two ticket
// surfaces. It owns no block — `block` is a prop, so every caller keeps its own
// class and the existing CSS is untouched.
//
// The tag is a CONSTRUCTOR argument rather than a prop: `Component.el` is
// readonly and the node is handed to a parent at mount time, so honouring a tag
// change inside `paint()` would mean swapping a node somebody else already
// holds. Every call site knows its tag when it builds the component — `li`
// inside the ticket dock's `<ul>`, `p` for the dock's progress summary, `div`
// everywhere else — so construction time is where the choice belongs.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export type EmptyStateTag = 'div' | 'li' | 'p';

export interface EmptyStateProps {
  /** The BEM block the caller owns, e.g. `acp-harness__transcript-empty`. */
  readonly block: string;
  /** Plain text; newlines survive because this goes through `textContent`. */
  readonly text: string;
}

export class EmptyState extends Component<EmptyStateProps> {
  constructor(tag: EmptyStateTag = 'div') {
    super(el(tag));
  }

  protected readDeps(next: EmptyStateProps): readonly unknown[] {
    return [next.block, next.text];
  }

  protected syncClasses(next: EmptyStateProps): void {
    this.el.className = next.block;
  }

  protected paint(next: EmptyStateProps): void {
    this.syncClasses(next);
    this.el.textContent = next.text;
  }
}

export const def: ComponentDef = { id: 'empty-state', blocks: [] };
