// Spec 301 — typed element builder.
//
// Deliberately NOT a template engine: there is no parsing step, no caching, no
// `innerHTML`. `el()` exists so a component's paint() reads like the markup it
// emits while still producing real nodes whose identity the reconciler can keep.

export type ElChild = Node | string | number | null | undefined | false;

export type ClassSpec = string | false | null | undefined | readonly ClassSpec[];

export interface ElOptions {
  /** Class list; falsey entries are dropped, nested arrays are flattened. */
  class?: ClassSpec;
  /** Text content. Mutually exclusive with `children` — `children` wins. */
  text?: string;
  title?: string;
  /** `data-*` attributes; `undefined` removes the attribute. */
  data?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Plain attributes; `undefined`/`false` removes, `true` sets the empty string. */
  attrs?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Inline custom properties and styles. `--foo` keys go through setProperty. */
  style?: Readonly<Record<string, string | undefined>>;
  children?: readonly ElChild[];
}

/** Flatten a class spec into a deduped, space-joined class string. */
export function classes(...specs: readonly ClassSpec[]): string {
  const out: string[] = [];
  const walk = (spec: ClassSpec): void => {
    if (!spec) return;
    if (Array.isArray(spec)) {
      for (const inner of spec) walk(inner);
      return;
    }
    for (const token of String(spec).split(/\s+/)) {
      if (token && !out.includes(token)) out.push(token);
    }
  };
  for (const spec of specs) walk(spec);
  return out.join(' ');
}

export function setAttr(node: Element, name: string, value: string | number | boolean | undefined): void {
  if (value === undefined || value === false) node.removeAttribute(name);
  else node.setAttribute(name, value === true ? '' : String(value));
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  ...rest: readonly ElChild[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyOptions(node, opts);
  const children = opts.children ?? rest;
  if (children.length > 0) append(node, children);
  else if (opts.text !== undefined) node.textContent = opts.text;
  return node;
}

/** Apply `ElOptions` to an existing node — the in-place update path for paint(). */
export function applyOptions(node: HTMLElement, opts: ElOptions): void {
  if (opts.class !== undefined) node.className = classes(opts.class);
  if (opts.title !== undefined) setAttr(node, 'title', opts.title);
  if (opts.data) {
    for (const [key, value] of Object.entries(opts.data)) setAttr(node, `data-${key}`, value);
  }
  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) setAttr(node, key, value);
  }
  if (opts.style) {
    for (const [key, value] of Object.entries(opts.style)) {
      if (value === undefined) node.style.removeProperty(key);
      else if (key.startsWith('--')) node.style.setProperty(key, value);
      else node.style.setProperty(key, value);
    }
  }
}

export function frag(...children: readonly ElChild[]): DocumentFragment {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Append children, skipping falsey entries and wrapping primitives as text. */
export function append(parent: Node, children: readonly ElChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Replace a node's children in one pass. Keeps the node itself — never the parent's wipe. */
export function setChildren(parent: HTMLElement, children: readonly ElChild[]): void {
  parent.replaceChildren();
  append(parent, children);
}
