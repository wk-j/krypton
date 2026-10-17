// Spec 309 — the contract every catalog renderer implements.
//
// A renderer is a kernel `Component<GenUiProps>`: its `readDeps()` is the props
// the evaluator produced for its node, so an untouched subtree early-returns
// when one input changes. Children are mounted through `renderChildren`, which
// is one keyed `reconcile()` over the node keys the evaluator assigned — a
// child whose key survives is patched in place, never rebuilt.
//
// The registry is filled by `./index.ts` at module init rather than imported
// here, so a group module can call `renderChildren` without a cycle.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { reconcile } from '../../../ui/list';
import type { UiAction, UiNode, UiState, UiStateValue, Value, ValueList, ValueObject } from '../../genui/types';
import { isList, isNode, isPlainObject } from '../../genui/types';

export const BLOCK = 'acp-genui';

export interface GenUiContext {
  /** Run a control's actions, in order. */
  run(actions: readonly UiAction[]): void;
  /** Write a declared input and re-evaluate the spec. */
  setInput(name: string, value: UiStateValue): void;
  /** Current inputs, for a control that needs to read its own value. */
  readonly state: UiState;
  /**
   * Per-node view state that survives re-evaluation and panel reopen: the open
   * tab, expanded rows, a sort column. Keyed by the node's key; the returned
   * object is live and may be mutated in place.
   */
  view(key: string): Record<string, unknown>;
  /** Invalidate after mutating view state without touching an input. */
  repaint(): void;
}

export interface GenUiProps {
  readonly node: UiNode;
  readonly ctx: GenUiContext;
}

export abstract class GenUiComponent extends Component<GenUiProps> {
  protected syncClasses(): void {
    // Catalog components carry no state-derived wrapper class; a renderer that
    // needs one overrides this.
  }
}

export type GenUiFactory = (host: HTMLElement) => GenUiComponent;

/** Component name → factory. Filled by `./index.ts`; read at call time. */
export const RENDERERS: Record<string, GenUiFactory> = Object.create(null) as Record<string, GenUiFactory>;

export function registerRenderers(group: Readonly<Record<string, GenUiFactory>>): void {
  for (const [name, factory] of Object.entries(group)) RENDERERS[name] = factory;
}

interface ChildEntry {
  readonly el: HTMLElement;
  readonly cmp: GenUiComponent;
  dispose(): void;
}

/**
 * Mount `nodes` into `container`, reusing a child whose key and component name
 * are unchanged. This is the only way a renderer draws another node.
 */
export function renderChildren(container: HTMLElement, nodes: readonly UiNode[], ctx: GenUiContext): void {
  reconcile<UiNode, ChildEntry>(container, nodes, {
    key: (node) => `${node.component}\u0000${node.key}`,
    create: (node) => {
      const host = el('div', { class: `${BLOCK}__slot` });
      const factory = RENDERERS[node.component];
      const cmp = factory === undefined ? new UnknownComponent(host) : factory(host);
      cmp.update({ node, ctx });
      return { el: host, cmp, dispose: () => cmp.dispose() };
    },
    update: (entry, node) => entry.cmp.update({ node, ctx }),
  });
}

/** A component the catalog knows but this build has no renderer for. */
class UnknownComponent extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.component];
  }

  protected paint(next: GenUiProps): void {
    this.el.replaceChildren(el('div', { class: `${BLOCK}__error`, text: `no renderer for ${next.node.component}` }));
  }
}

// ── prop readers ────────────────────────────────────────────────────────────
// The validator already rejected the wrong shape at compile time; these cope
// with what only runtime can produce (a loaded file, a mapped list).

export function asString(value: Value, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asNumber(value: Value, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function asBoolean(value: Value, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function asList(value: Value): ValueList {
  return isList(value) ? value : [];
}

export function asObject(value: Value): ValueObject {
  return isPlainObject(value) ? value : {};
}

export function asNodes(value: Value): readonly UiNode[] {
  if (isNode(value)) return [value];
  if (!isList(value)) return [];
  const out: UiNode[] = [];
  for (const item of value) {
    if (isNode(item)) out.push(item);
    else if (isList(item)) out.push(...asNodes(item));
  }
  return out;
}

export const TONE_CLASS: Readonly<Record<string, string>> = {
  neutral: '', good: '--good', warn: '--warn', bad: '--bad', info: '--info',
};

/** `acp-genui__badge--warn` for a known tone, otherwise the bare block. */
export function toneClass(base: string, value: Value): string {
  const name = typeof value === 'string' ? value : 'neutral';
  const suffix = Object.prototype.hasOwnProperty.call(TONE_CLASS, name) ? TONE_CLASS[name] : '';
  return suffix === '' ? base : `${base} ${base}${suffix}`;
}

/** Grouped, fixed-digit number the way `fmt()` renders it. */
export function formatNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Every focusable a catalog control exposes carries this, for the panel's roving tabindex. */
export const FOCUSABLE_ATTR = 'data-genui-focusable';
