// Krypton — generative UI shared values (spec 309).
// Every value an evaluated spec can produce. Nodes, actions and bindings are
// tagged so data loaded from a file can never impersonate one.

import type { Program } from './ast';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  readonly severity: Severity;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface UiNode {
  readonly kind: 'node';
  /** Catalog component name, e.g. `Card`. */
  readonly component: string;
  readonly props: Readonly<Record<string, Value>>;
  /** Stable identity for `reconcile()`: the node's path in the evaluated tree. */
  readonly key: string;
}

export type UiActionType = 'draft' | 'set' | 'copy' | 'openUrl';

export interface UiAction {
  readonly kind: 'action';
  readonly type: UiActionType;
  /** `draft` / `copy`: the text. `openUrl`: the url. `set`: unused. */
  readonly text?: string;
  /** `set` only. */
  readonly name?: string;
  /** `set` only. */
  readonly value?: Value;
}

export interface Binding {
  readonly kind: 'binding';
  readonly name: string;
}

export type ValueList = readonly Value[];
export type ValueObject = { readonly [key: string]: Value };

export type Value =
  | null
  | boolean
  | number
  | string
  | ValueList
  | ValueObject
  | UiNode
  | UiAction
  | Binding;

/**
 * What an input may hold: data only. Recursive so `EditableTable` can write a
 * list of row objects, while a node, action or binding can never be stored.
 */
export type UiStateValue =
  | string
  | number
  | boolean
  | null
  | readonly UiStateValue[]
  | { readonly [key: string]: UiStateValue };

export type UiState = Record<string, UiStateValue>;

/** Narrow an evaluated value to something an input may hold; `undefined` when it may not. */
export function toStateValue(value: Value): UiStateValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const out: UiStateValue[] = [];
    for (const item of value) {
      const narrowed = toStateValue(item);
      if (narrowed === undefined) return undefined;
      out.push(narrowed);
    }
    return out;
  }
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, UiStateValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const narrowed = toStateValue(item);
    if (narrowed === undefined) return undefined;
    out[key] = narrowed;
  }
  return out;
}

export function isNode(value: Value): value is UiNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as UiNode).kind === 'node';
}

export function isAction(value: Value): value is UiAction {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as UiAction).kind === 'action';
}

export function isBinding(value: Value): value is Binding {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Binding).kind === 'binding';
}

export function isList(value: Value): value is ValueList {
  return Array.isArray(value);
}

export function isPlainObject(value: Value): value is ValueObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isNode(value) && !isAction(value) && !isBinding(value);
}

/** A sealed spec plus everything the card and panel need to open it. */
export interface UiFenceEntry {
  readonly index: number;
  readonly source: string;
  readonly sourceHash: string;
  /** Outermost `Card` title, else the first root's component name. */
  readonly title: string;
  /** Card subtitle, e.g. `chart · table · 2 inputs`. */
  readonly summary: string;
  hintLabel: string | null;
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
}
