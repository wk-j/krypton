// Spec 306 addendum — `GrammarPanel`, the `grammar` assist task's surface.
//
// A right-rail card in the thought card's family (same chrome, same column),
// mounted by the view only while the active lane has a review:
//
//   claude-1                                          GRAMMAR · 2 FIXES
//   curent → current
//   What → What are
//   What are the current changes in git?
//   cmd+g use · cmd+0 dismiss
//
// `pending` shows the checked prompt dimmed under a CHECKING label; a clean
// review shows one confirming line and the controller unmounts it shortly
// after. The panel owns no keys — `onKeyDown` routes `Cmd+G` / `Cmd+0`.

import './grammar-panel.css';

import { Component } from '../../../ui/component';
import { el, setAttr, setChildren } from '../../../ui/dom';
import type { AssistPanelState } from '../../assist/types';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__grammar';

export interface GrammarPanelProps {
  readonly laneName: string;
  /** Never `idle`: the view unmounts the panel instead. */
  readonly state: Exclude<AssistPanelState, { kind: 'idle' }>;
}

function statusLabel(state: GrammarPanelProps['state']): string {
  if (state.kind === 'pending') return 'grammar · checking';
  const n = state.check.fixes.length;
  if (state.check.corrected === null) return 'grammar · ok';
  return `grammar · ${n} ${n === 1 ? 'fix' : 'fixes'}`;
}

export class GrammarPanel extends Component<GrammarPanelProps> {
  private readonly nameEl = el('span', { class: `${BLOCK}-name` });
  private readonly labelEl = el('span', { class: `${BLOCK}-label` });
  private readonly bodyEl = el('div', { class: `${BLOCK}-body` });

  constructor() {
    super(el('aside', { class: BLOCK, attrs: { role: 'status' } }));
    this.el.append(el('header', { class: `${BLOCK}-head` }, this.nameEl, this.labelEl), this.bodyEl);
  }

  protected readDeps(next: GrammarPanelProps): readonly unknown[] {
    const s = next.state;
    return [
      next.laneName,
      s.kind,
      s.original,
      s.kind === 'ready' ? s.check.corrected : null,
      s.kind === 'ready' ? s.check.fixes.join('\u0000') : '',
    ];
  }

  protected syncClasses(next: GrammarPanelProps): void {
    this.el.className = BLOCK;
    const s = next.state;
    setAttr(this.el, 'data-phase', s.kind === 'pending' ? 'pending' : s.check.corrected === null ? 'ok' : 'fixes');
  }

  protected paint(next: GrammarPanelProps): void {
    this.syncClasses(next);
    const s = next.state;
    this.nameEl.textContent = next.laneName;
    this.labelEl.textContent = statusLabel(s);
    if (s.kind === 'pending') {
      setChildren(this.bodyEl, [el('div', { class: `${BLOCK}-original`, text: s.original })]);
      return;
    }
    if (s.check.corrected === null) {
      setChildren(this.bodyEl, [el('div', { class: `${BLOCK}-ok`, text: '✓ no grammar issues' })]);
      return;
    }
    setChildren(this.bodyEl, [
      el('ul', { class: `${BLOCK}-fixes` }, ...s.check.fixes.map((fix) => el('li', { class: `${BLOCK}-fix`, text: fix }))),
      el('div', { class: `${BLOCK}-corrected`, text: s.check.corrected }),
      el('div', { class: `${BLOCK}-hint`, text: 'cmd+g use · cmd+0 dismiss' }),
    ]);
  }
}

export const def: ComponentDef = { id: 'grammar-panel', blocks: [BLOCK] };
