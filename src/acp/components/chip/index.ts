// Spec 302 §1.1 — `Chip`.
//
// The small labelled span the harness paints fifteen different ways: lane mode,
// sandbox/permission-mode, model, mcp, metrics, rail metric, peek chip, tool
// kind, ticket badge, priority tag. It owns no block — `block` is a prop, so
// the existing CSS is untouched and each caller keeps its own class.
//
// Content order is always [text, icon, trailing]; that covers every chip the
// harness emits today, including `mcp ✓ 14` (text `mcp `, icon `check`,
// trailing ` 14`) and `⚠ unsandboxed` (no text, icon `warn`, trailing
// ` unsandboxed`).

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { harnessIconEl } from '../../harness-icons';
import type { ComponentDef } from '../types';

export type ChipTone = 'neutral' | 'warn' | 'on' | 'off' | 'hot';

export interface ChipIcon {
  /** `krypton-icon-<id>` symbol suffix. */
  readonly id: string;
  /** Extra class on the `<svg>`, e.g. `acp-harness__icon--dot`. */
  readonly cls?: string;
}

export interface ChipProps {
  /** The BEM block the caller owns, e.g. `acp-harness__lane-model`. */
  readonly block: string;
  readonly text: string;
  readonly icon?: ChipIcon;
  readonly trailing?: string;
  /** Appends `${block}--${tone}`; `neutral` appends nothing. */
  readonly tone?: ChipTone;
  readonly title?: string;
  /** Extra full class names, already namespaced by the caller. */
  readonly modifiers?: readonly string[];
  readonly data?: Readonly<Record<string, string | undefined>>;
}

export class Chip extends Component<ChipProps> {
  constructor() {
    super(el('span'));
  }

  protected readDeps(next: ChipProps): readonly unknown[] {
    return [
      next.block,
      next.text,
      next.icon?.id,
      next.icon?.cls,
      next.trailing,
      next.tone,
      next.title,
      next.modifiers?.join(' '),
      next.data,
    ];
  }

  protected syncClasses(next: ChipProps): void {
    this.el.className = classes(
      next.block,
      next.tone && next.tone !== 'neutral' ? `${next.block}--${next.tone}` : null,
      next.modifiers ?? null,
    );
  }

  protected paint(next: ChipProps): void {
    this.syncClasses(next);
    setAttr(this.el, 'title', next.title);
    if (next.data) {
      for (const [key, value] of Object.entries(next.data)) setAttr(this.el, `data-${key}`, value);
    }
    this.el.replaceChildren();
    if (next.text) this.el.append(next.text);
    if (next.icon) this.el.appendChild(harnessIconEl(next.icon.id, next.icon.cls));
    if (next.trailing) this.el.append(next.trailing);
  }
}

export const def: ComponentDef = { id: 'chip', blocks: [] };
