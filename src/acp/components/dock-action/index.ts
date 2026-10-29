// Spec 302 §1.10 — `DockActionButton` (spec 344).
//
//   [ ◇ Comment ]     an icon and a label
//   [  ✓ 14:02  ]     the state badge, only while running or done
//
// One action button of a right-dock panel. The Ticket Panel's issue actions
// (spec 342) and the Rails dock's actions (spec 344) both use it, so the two
// docks show idle, running, done and disabled the same way.
//
// Label and icon are fixed for the button's life; only the state and the
// disabled reason change. A `done` button stays enabled: its colour warns, it
// never blocks. A `running` button keeps its colour while disabled, so what is
// running stays readable among disabled buttons.
//
// The button has no click listener of its own. Each dock routes clicks through
// one delegated handler that reads the `data-*` attribute passed in here.
// `ActionButton` (§1.6) cannot hold this button: it has no icon slot, no badge
// line, and a tooltip only while disabled.

import './dock-action.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { harnessIconEl } from '../../harness-icons';
import type { ComponentDef } from '../types';

const B = 'acp-dock-action';

/** What one button shows. `detail` is the tooltip while the button is enabled. */
export type DockActionState =
  | { readonly kind: 'idle'; readonly detail?: string }
  | { readonly kind: 'running' | 'done'; readonly badge: string; readonly detail: string };

export interface DockActionProps {
  readonly state: DockActionState;
  /** Non-null disables the button and becomes its tooltip. */
  readonly disabledReason: string | null;
}

export interface DockActionSpec {
  readonly label: string;
  /** `krypton-icon-*` suffix in `harness-icons.ts`. */
  readonly icon: string;
  /** `{ 'rails-action': 'now' }` → `data-rails-action="now"`, read by the dock's click handler. */
  readonly data: Readonly<Record<string, string>>;
}

export const DOCK_ACTION_IDLE: DockActionState = { kind: 'idle' };

/** One stable string per state, so a dock's deps compare by value. */
export function dockActionKey(state: DockActionState): string {
  if (state.kind === 'idle') return `idle\u001f${state.detail ?? ''}`;
  return `${state.kind}\u001f${state.badge}\u001f${state.detail}`;
}

export class DockActionButton extends Component<DockActionProps> {
  private readonly headEl: HTMLElement;
  private readonly stateEl = el('span', { class: `${B}__state` });

  constructor(spec: DockActionSpec) {
    super(el('button', { attrs: { type: 'button' }, data: spec.data }));
    this.headEl = el(
      'span',
      { class: `${B}__head` },
      harnessIconEl(spec.icon, `${B}__icon`),
      el('span', { class: `${B}__label`, text: spec.label }),
    );
  }

  protected readDeps(next: DockActionProps): readonly unknown[] {
    return [dockActionKey(next.state), next.disabledReason];
  }

  protected syncClasses(next: DockActionProps): void {
    const kind = next.state.kind;
    this.el.className = kind === 'idle' ? B : `${B} ${B}--${kind}`;
  }

  protected paint(next: DockActionProps): void {
    this.syncClasses(next);
    const { state, disabledReason } = next;
    setAttr(this.el, 'disabled', disabledReason !== null);
    setAttr(this.el, 'title', disabledReason ?? state.detail);
    if (state.kind === 'idle') {
      this.el.replaceChildren(this.headEl);
      return;
    }
    this.stateEl.textContent = state.badge;
    this.el.replaceChildren(this.headEl, this.stateEl);
  }
}

export const def: ComponentDef = { id: 'dock-action', blocks: [B] };
