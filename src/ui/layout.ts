// Spec 301 — declarative placement.
//
// Today a panel's position is nailed down in three unrelated places: the
// `appendChild` order in buildDOM, the CSS that positions it, and a private
// element field each renderer writes into by name. Moving one panel is a
// three-file edit with no compiler help.
//
// Components already expose exactly what a container needs — `el` and
// `dispose()` — so placement becomes a table, type-checked against the slot
// union. Slots own their own sizing rules, so moving a panel is one line.

import { syncOrder } from './list';

export interface Mountable {
  readonly el: HTMLElement;
  dispose(): void;
}

export interface LayoutEntry<S extends string> {
  readonly slot: S;
  readonly order: number;
}

export type LayoutTable<S extends string> = Readonly<Record<string, LayoutEntry<S>>>;

export interface Slot {
  readonly el: HTMLElement;
  mount(id: string, cmp: Mountable, order: number): void;
  unmount(id: string): void;
  has(id: string): boolean;
}

interface Placed {
  readonly cmp: Mountable;
  order: number;
}

class SlotImpl implements Slot {
  readonly el: HTMLElement;
  private readonly placed = new Map<string, Placed>();

  constructor(el: HTMLElement) {
    this.el = el;
  }

  has(id: string): boolean {
    return this.placed.has(id);
  }

  get(id: string): Mountable | undefined {
    return this.placed.get(id)?.cmp;
  }

  mount(id: string, cmp: Mountable, order: number): void {
    const current = this.placed.get(id);
    if (current && current.cmp === cmp) {
      if (current.order === order) return;
      current.order = order;
    } else {
      if (current) current.cmp.dispose();
      this.placed.set(id, { cmp, order });
    }
    this.reorder();
  }

  /** Detach without disposing — used when a component moves between slots. */
  detach(id: string): Mountable | undefined {
    const current = this.placed.get(id);
    if (!current) return undefined;
    this.placed.delete(id);
    current.cmp.el.remove();
    return current.cmp;
  }

  unmount(id: string): void {
    const current = this.placed.get(id);
    if (!current) return;
    this.placed.delete(id);
    current.cmp.el.remove();
    current.cmp.dispose();
  }

  disposeAll(): void {
    for (const { cmp } of this.placed.values()) cmp.dispose();
    this.placed.clear();
    this.el.replaceChildren();
  }

  private reorder(): void {
    const sorted = [...this.placed.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
    syncOrder(
      this.el,
      sorted.map(([, placed]) => placed.cmp.el),
    );
  }
}

/**
 * Named placement containers plus the table that says which container each
 * component mounts into, and in what order.
 */
export class LayoutHost<S extends string> {
  private readonly slots: Map<S, SlotImpl>;
  private layout: LayoutTable<S>;
  /** Which slot each mounted id currently sits in, so `apply()` can move it. */
  private readonly placement = new Map<string, S>();

  constructor(slots: Readonly<Record<S, HTMLElement>>, layout: LayoutTable<S>) {
    this.slots = new Map(
      (Object.entries(slots) as [S, HTMLElement][]).map(([id, el]) => [id, new SlotImpl(el)]),
    );
    this.layout = layout;
  }

  slot(id: S): Slot {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`[ui] unknown layout slot ${JSON.stringify(id)}`);
    return slot;
  }

  entry(id: string): LayoutEntry<S> {
    const entry = this.layout[id];
    if (!entry) throw new Error(`[ui] no layout entry for component ${JSON.stringify(id)}`);
    return entry;
  }

  /** Place a component where the current table says it belongs. */
  mount(id: string, cmp: Mountable): void {
    const entry = this.entry(id);
    const previous = this.placement.get(id);
    if (previous !== undefined && previous !== entry.slot) {
      const slot = this.slots.get(previous);
      const detached = slot?.detach(id);
      if (detached && detached !== cmp) detached.dispose();
    }
    this.placement.set(id, entry.slot);
    (this.slot(entry.slot) as SlotImpl).mount(id, cmp, entry.order);
  }

  mounted(id: string): Mountable | undefined {
    const slotId = this.placement.get(id);
    if (slotId === undefined) return undefined;
    return this.slots.get(slotId)?.get(id);
  }

  unmount(id: string): void {
    const slotId = this.placement.get(id);
    if (slotId === undefined) return;
    this.placement.delete(id);
    this.slots.get(slotId)?.unmount(id);
  }

  /** Swap the table and re-place everything currently mounted. */
  apply(layout: LayoutTable<S>): void {
    this.layout = layout;
    for (const [id, slotId] of [...this.placement]) {
      const entry = layout[id];
      const slot = this.slots.get(slotId);
      if (!slot) continue;
      if (!entry) {
        this.placement.delete(id);
        slot.unmount(id);
        continue;
      }
      const cmp = slot.get(id);
      if (!cmp) continue;
      if (entry.slot !== slotId) slot.detach(id);
      this.placement.set(id, entry.slot);
      (this.slot(entry.slot) as SlotImpl).mount(id, cmp, entry.order);
    }
  }

  dispose(): void {
    for (const slot of this.slots.values()) slot.disposeAll();
    this.placement.clear();
  }
}
