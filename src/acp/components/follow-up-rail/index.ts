// Spec 323 — `FollowUpRail`.
//
// The FOLLOW-UP buttons under a sealed assistant reply: the commands and URLs
// the assist sidecar picked out of that reply. Every reply keeps its own rail,
// so scrolling back reaches the buttons of any earlier turn.
//
// It is a CHILD component of `AssistantRow`, mounted as the row's last child —
// a sibling of the body, so neither the body's `innerHTML` repaint nor the
// annotation wrapper ever touches it. The result arrives seconds after the
// turn sealed; it moves this component's deps only, never the row's.
//
// Static by contract (AGENTS.md constraint 10): a button has no state, a click
// changes nothing here, and there is no "ran" mark. Clicks stay delegated on
// `[data-follow-up-index]` at the view level, so the rail attaches no listener.

import './follow-up-rail.css';

import { Component } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import type { FollowUpAction } from '../../assist/types';
import { harnessIconEl } from '../../harness-icons';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__followups';

export interface FollowUpRailProps {
  readonly actions: readonly FollowUpAction[];
}

export class FollowUpRail extends Component<FollowUpRailProps> {
  private signature = '';
  private hints = '';

  constructor() {
    super(el('section', { class: BLOCK, attrs: { 'aria-label': 'Follow-up actions' } }));
  }

  /** Folded before `super.update()`: `actions` is the item's own array, mutated in place by the hint layer. */
  update(next: FollowUpRailProps): void {
    this.signature = next.actions
      .map((action) => `${action.followUpKind}\u001f${action.target}\u001f${action.label}`)
      .join('\u001e');
    this.hints = next.actions.map((action) => action.hintLabel ?? '').join('\u001f');
    super.update(next);
  }

  protected readDeps(): readonly unknown[] {
    return [this.signature, this.hints];
  }

  protected syncClasses(): void {
    this.el.className = BLOCK;
  }

  protected paint(next: FollowUpRailProps): void {
    this.syncClasses();
    setChildren(this.el, [
      el('div', { class: `${BLOCK}-head`, text: 'FOLLOW-UP' }),
      el('div', { class: `${BLOCK}-list` }, ...next.actions.map(renderAction)),
    ]);
  }
}

function renderAction(action: FollowUpAction, index: number): HTMLButtonElement {
  const run = action.followUpKind === 'run';
  return el(
    'button',
    {
      class: `${BLOCK}-btn ${BLOCK}-btn--${action.followUpKind}`,
      // Keyboard reach is the `f` open-hint layer; Tab stays in the composer.
      attrs: { type: 'button', tabindex: -1, 'aria-label': `${run ? 'Run' : 'Open'} ${action.target}` },
      data: { 'follow-up-index': index },
    },
    el('span', { class: `${BLOCK}-hint`, text: action.hintLabel ?? '' }),
    el('span', { class: `${BLOCK}-glyph`, attrs: { 'aria-hidden': 'true' } }, harnessIconEl(`follow-up-${action.followUpKind}`)),
    el('span', { class: `${BLOCK}-label`, text: action.label }),
    // In full, never ellipsized: the human must see exactly what will run.
    el('code', { class: `${BLOCK}-target`, text: action.target }),
  );
}

export const def: ComponentDef = { id: 'follow-up-rail', blocks: [BLOCK] };
