// Spec 301 — the one keyed list diff.
//
// This generalises the transcript loop the harness already runs, keeping its
// exact semantics:
//   * pointer-compare before `insertBefore`, so a node that is already in the
//     right place is never touched (spec 103 rev 2);
//   * reuse-and-patch, never `replaceWith` (spec 94);
//   * `dispose()` + remove for keys that fell out of the window.
//
// Live-awareness is structural rather than a flag: the reconciler only ever
// calls `spec.update(cmp, item)`, and a `LiveComponent` decides for itself
// whether that becomes a repaint. The reconciler cannot repaint a row.

/** The surface the reconciler needs. `Component` satisfies it; so can a wrapper. */
export interface ListNode {
  readonly el: HTMLElement;
  dispose(): void;
}

export interface ListSpec<T, C extends ListNode> {
  key(item: T, index: number): string;
  create(item: T, index: number): C;
  update(cmp: C, item: T, index: number): void;
}

const lists = new WeakMap<HTMLElement, Map<string, ListNode>>();

/**
 * Place `nodes` as the exact children of `container`, in order, moving as few
 * nodes as possible and removing anything else.
 *
 * The container is owned by the caller's list: stray children are removed. That
 * is the point — it is how a list stays authoritative without an `innerHTML`
 * wipe, which is what destroys scroll position (spec 95).
 */
export function syncOrder(container: HTMLElement, nodes: readonly HTMLElement[]): void {
  let cursor: ChildNode | null = container.firstChild;
  for (const node of nodes) {
    if (cursor === node) {
      cursor = node.nextSibling;
      continue;
    }
    container.insertBefore(node, cursor);
  }
  while (cursor) {
    const next: ChildNode | null = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

export function reconcile<T, C extends ListNode>(
  container: HTMLElement,
  items: readonly T[],
  spec: ListSpec<T, C>,
): void {
  const previous = lists.get(container) ?? new Map<string, ListNode>();
  const next = new Map<string, ListNode>();
  const nodes: HTMLElement[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = spec.key(item, i);
    if (next.has(key)) {
      throw new Error(`[ui] reconcile: duplicate key ${JSON.stringify(key)}`);
    }
    const existing = previous.get(key) as C | undefined;
    let cmp: C;
    if (existing) {
      previous.delete(key);
      spec.update(existing, item, i);
      cmp = existing;
    } else {
      cmp = spec.create(item, i);
    }
    next.set(key, cmp);
    nodes.push(cmp.el);
  }

  syncOrder(container, nodes);
  for (const dropped of previous.values()) dropped.dispose();
  lists.set(container, next);
}

/** Tear down every component a container's list still holds. */
export function disposeList(container: HTMLElement): void {
  const current = lists.get(container);
  if (!current) return;
  lists.delete(container);
  for (const cmp of current.values()) cmp.dispose();
  container.replaceChildren();
}

/** The components a container's list currently holds, in DOM order. */
export function listComponents(container: HTMLElement): readonly ListNode[] {
  return [...(lists.get(container)?.values() ?? [])];
}

/** The component a container's list holds under `key`, if any. */
export function listComponent(container: HTMLElement, key: string): ListNode | undefined {
  return lists.get(container)?.get(key);
}
