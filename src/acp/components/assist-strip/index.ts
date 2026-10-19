// Spec 306 §UI — `AssistStrip`.
//
// The assist sidecar's one surface: up to three numbered next-prompt rows
// above the draft line, plus the key legend that says how to take one.
//
//   cmd+1  run the failing test
//   cmd+2  check the fs_write_review path
//   cmd+0 dismiss · cmd+/ again
//
// `idle` and `failed` both paint nothing and hide the node: a failure speaks
// once through `flashChip`, never as a permanent row, and the controller maps
// a dismissed lane to `idle` so dismissal is not a second hidden-state input.
//
// The dependency tuple is `[kind, labels]`, folded in `update()` BEFORE
// `super.update()` — the `PeerStrip` discipline. `actions` is a fresh array on
// every turn and the prompts never reach the DOM, so neither identity nor the
// prompt text may decide a repaint; the joined labels do.

import './assist-strip.css';

import { Component } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import type { AssistState } from '../../assist/types';
import { KeyHintBar, type KeyHintBarProps } from '../key-hint-bar';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__assist';

/** Three accept keys exist, so a fourth suggestion could not be taken. */
const MAX_ROWS = 3;

/** Fixed: the keys are the component's contract with `onKeyDown`, not state.
    `cmd+1-3 use` is gone — each row spells its own key. */
const HINTS: KeyHintBarProps = {
  hints: [
    { keys: ['cmd+0'], label: 'dismiss' },
    { keys: ['cmd+/'], label: 'again' },
  ],
  style: 'plain',
  block: `${BLOCK}-hint`,
};

export interface AssistStripProps {
  readonly state: AssistState;
}

export class AssistStrip extends Component<AssistStripProps> {
  private readonly hint = new KeyHintBar('div');
  private kind: AssistState['kind'] = 'idle';
  private labels = '';

  constructor() {
    super(el('div', { class: BLOCK, attrs: { role: 'status' } }));
  }

  update(next: AssistStripProps): void {
    this.kind = next.state.kind;
    this.labels =
      next.state.kind === 'ready'
        ? next.state.actions.slice(0, MAX_ROWS).map((action) => action.label).join('\u0000')
        : '';
    super.update(next);
  }

  protected readDeps(): readonly unknown[] {
    return [this.kind, this.labels];
  }

  protected syncClasses(next: AssistStripProps): void {
    this.el.className = BLOCK;
    this.el.hidden = next.state.kind === 'idle' || next.state.kind === 'failed';
  }

  protected paint(next: AssistStripProps): void {
    this.syncClasses(next);
    const state = next.state;
    if (state.kind === 'idle' || state.kind === 'failed') {
      setChildren(this.el, []);
      return;
    }
    if (state.kind === 'pending') {
      setChildren(this.el, [
        el('div', { class: `${BLOCK}-row ${BLOCK}-row--pending`, text: 'assist · thinking…' }),
      ]);
      return;
    }
    this.hint.update(HINTS);
    setChildren(this.el, [
      ...state.actions.slice(0, MAX_ROWS).map((action, index) =>
        el(
          'div',
          { class: `${BLOCK}-row` },
          el('span', { class: `${BLOCK}-index`, text: `cmd+${index + 1}` }),
          el('span', { class: `${BLOCK}-label`, text: action.label }),
        ),
      ),
      this.hint.el,
    ]);
  }

  protected onDispose(): void {
    this.hint.dispose();
  }
}

export const def: ComponentDef = { id: 'assist-strip', blocks: [BLOCK] };
