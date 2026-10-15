// Spec 302 §2.4 — `InlinePalette<T>`.
//
// The inline autocomplete list the composer paints four times today, each a
// verbatim copy of the others: `/` slash commands
// (`harness-lane-chrome.ts:437-462`), `@` lane mentions
// (`acp-harness-view.ts:4468-4494`), `#` built-in commands (`:4563-4590`) and
// the `{{#verb}}` injection palette (`:4643-4672`).
//
// ⚠ All four emit the SAME class with no discriminator, so the mention palette
// cannot be restyled without also restyling `/`, `#` and `{{#`. This component
// adds `data-palette="<variant>"` on the shell — one block, four addressable
// variants — and changes nothing else about the markup.
//
// It owns the row list, the cursor (`--selected`) and the meta line. It does
// NOT own which key opens, moves or commits it: the caller keeps the key table
// (CLAUDE.md constraint 1) and drives this component through the exported
// cursor helpers plus the `commit` prop.
import './inline-palette.css';

import { Component } from '../../../ui/component';
import { classes, el, setAttr, setChildren } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import type { ComponentDef } from '../types';

export type InlinePaletteVariant = 'slash' | 'mention' | 'hash' | 'verb';

/**
 * One row's text, as the caller projects it.
 *
 * A `-hint` / `-desc` span is emitted exactly when the field is PRESENT, which
 * is what keeps the four renderers byte-compatible: the `/` and `{{#` palettes
 * drop an empty description (`cmd.description || undefined`) while the `#`
 * palette emits the span unconditionally (`desc: cmd.description`, even when
 * that string is empty). Pass `undefined`, never `''`, to omit a span.
 */
export interface InlinePaletteRow {
  /** Already carries the sigil the variant prints: `/x`, `@x`, `#x`, `{{#x}}`. */
  readonly name: string;
  readonly hint?: string;
  readonly desc?: string;
}

export interface InlinePaletteProps<T> {
  readonly variant: InlinePaletteVariant;
  readonly matches: readonly T[];
  /** Caller-owned cursor; clamped here exactly as every renderer clamps today. */
  readonly cursor: number;
  /** The meta line above the rows — the key legend, which differs per variant. */
  readonly hint: string;
  row(item: T): InlinePaletteRow;
  /**
   * Meta line to show when `matches` is empty. Supplied only by the mention
   * palette (`no matching lanes · Esc dismiss`); the other three render
   * nothing at all when they have no matches.
   */
  readonly zeroState?: string;
  /**
   * Insert the selected item. Called by `commitSelected()` — which the
   * caller's key table invokes on its own commit key (`Enter|Tab` for `/` and
   * `@`, `Tab` only for `#` and `{{#`) — and by a pointer press on a row.
   */
  commit?(item: T, index: number): void;
}

/** `Math.max(0, Math.min(cursor, count - 1))`, the clamp all four renderers use. */
export function clampPaletteCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(cursor, count - 1));
}

/** `↓` / `⌃n`: the `(cursor + 1) % count` the four key handlers copy. */
export function nextPaletteCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  return (cursor + 1) % count;
}

/** `↑` / `⌃p`: the `(cursor - 1 + count) % count` the four key handlers copy. */
export function prevPaletteCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  return (cursor - 1 + count) % count;
}

const BLOCK = 'acp-harness__slash-palette';
const META = `${BLOCK}-meta`;
const ROW = `${BLOCK}-row`;
const ROW_SELECTED = `${ROW}--selected`;
const NAME = `${BLOCK}-name`;
const HINT = `${BLOCK}-hint`;
const DESC = `${BLOCK}-desc`;

interface MetaLineItem {
  readonly kind: 'meta';
  readonly text: string;
}

interface RowLineItem {
  readonly kind: 'row';
  readonly row: InlinePaletteRow;
  readonly selected: boolean;
}

type PaletteLine = MetaLineItem | RowLineItem;

/** The meta line. A component so the one reconciled list can hold it by key. */
class PaletteMeta extends Component<MetaLineItem> {
  constructor() {
    super(el('div', { class: META }));
  }

  protected readDeps(next: MetaLineItem): readonly unknown[] {
    return [next.text];
  }

  protected syncClasses(_next: MetaLineItem): void {
    this.el.className = META;
  }

  protected paint(next: MetaLineItem): void {
    this.syncClasses(next);
    this.el.textContent = next.text;
  }
}

class PaletteRowLine extends Component<RowLineItem> {
  private readonly nameEl = el('span', { class: NAME });
  private readonly hintEl = el('span', { class: HINT });
  private readonly descEl = el('span', { class: DESC });

  constructor() {
    super(el('div', { class: ROW }));
  }

  protected readDeps(next: RowLineItem): readonly unknown[] {
    return [next.row.name, next.row.hint, next.row.desc, next.selected];
  }

  protected syncClasses(next: RowLineItem): void {
    this.el.className = classes(ROW, next.selected && ROW_SELECTED);
  }

  protected paint(next: RowLineItem): void {
    this.syncClasses(next);
    this.nameEl.textContent = next.row.name;
    if (next.row.hint !== undefined) this.hintEl.textContent = next.row.hint;
    if (next.row.desc !== undefined) this.descEl.textContent = next.row.desc;
    setChildren(this.el, [
      this.nameEl,
      next.row.hint !== undefined ? this.hintEl : null,
      next.row.desc !== undefined ? this.descEl : null,
    ]);
  }
}

type PaletteLineNode = PaletteMeta | PaletteRowLine;

export class InlinePalette<T> extends Component<InlinePaletteProps<T>> {
  private current: InlinePaletteProps<T> | null = null;
  private lines: readonly PaletteLine[] = [];

  constructor() {
    super(el('div', { class: BLOCK }));
    // Attached ONCE. `mousedown` rather than `click` so the press never takes
    // focus off the composer — the palette is a keyboard surface that happens
    // to accept a pointer, not a focusable menu.
    this.bag.listen(this.el, 'mousedown', (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const rowEl = target.closest(`.${ROW}`);
      if (!rowEl || !this.el.contains(rowEl)) return;
      const index = [...this.el.querySelectorAll(`.${ROW}`)].indexOf(rowEl);
      if (index < 0) return;
      event.preventDefault();
      this.commitAt(index);
    });
  }

  /** The clamped cursor, i.e. which row carries `--selected`. */
  get selectedIndex(): number {
    return clampPaletteCursor(this.current?.cursor ?? 0, this.current?.matches.length ?? 0);
  }

  get selected(): T | undefined {
    const props = this.current;
    if (!props || props.matches.length === 0) return undefined;
    return props.matches[this.selectedIndex];
  }

  /**
   * Insert the selected item. Returns false when there is nothing to commit,
   * which is the `matches.length === 0 → return false` bail every one of the
   * four key handlers starts with.
   */
  commitSelected(): boolean {
    return this.commitAt(this.selectedIndex);
  }

  update(next: InlinePaletteProps<T>): void {
    this.current = next;
    this.lines = this.buildLines(next);
    super.update(next);
  }

  protected readDeps(next: InlinePaletteProps<T>): readonly unknown[] {
    const deps: unknown[] = [next.variant, next.zeroState, next.matches.length];
    for (const line of this.lines) {
      if (line.kind === 'meta') {
        deps.push(line.text);
        continue;
      }
      deps.push(line.row.name, line.row.hint, line.row.desc, line.selected);
    }
    return deps;
  }

  protected syncClasses(_next: InlinePaletteProps<T>): void {
    this.el.className = BLOCK;
  }

  protected paint(next: InlinePaletteProps<T>): void {
    this.syncClasses(next);
    setAttr(this.el, 'data-count', next.matches.length);
    setAttr(this.el, 'data-palette', next.variant);
    const visible = this.lines.length > 0;
    this.el.hidden = !visible;
    reconcile<PaletteLine, PaletteLineNode>(this.el, this.lines, {
      key: (line: PaletteLine, index: number): string =>
        line.kind === 'meta' ? 'meta' : `row:${index}`,
      create: (line: PaletteLine): PaletteLineNode => {
        if (line.kind === 'meta') {
          const meta = new PaletteMeta();
          meta.update(line);
          return meta;
        }
        const row = new PaletteRowLine();
        row.update(line);
        return row;
      },
      update: (cmp: PaletteLineNode, line: PaletteLine): void => {
        if (cmp instanceof PaletteMeta && line.kind === 'meta') cmp.update(line);
        else if (cmp instanceof PaletteRowLine && line.kind === 'row') cmp.update(line);
      },
    });
    if (!visible) return;
    // The composer keeps the highlighted row in view while the list scrolls
    // (`acp-harness-view.ts:13288-13292`). It belongs with the cursor, which is
    // this component's state.
    const selectedEl = this.el.querySelector<HTMLElement>(`.${ROW_SELECTED}`);
    if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }

  protected onDispose(): void {
    disposeList(this.el);
  }

  private buildLines(next: InlinePaletteProps<T>): readonly PaletteLine[] {
    const count = next.matches.length;
    if (count === 0) {
      return next.zeroState === undefined ? [] : [{ kind: 'meta', text: next.zeroState }];
    }
    const cursor = clampPaletteCursor(next.cursor, count);
    const lines: PaletteLine[] = [{ kind: 'meta', text: next.hint }];
    for (let i = 0; i < count; i++) {
      lines.push({ kind: 'row', row: next.row(next.matches[i]), selected: i === cursor });
    }
    return lines;
  }

  private commitAt(index: number): boolean {
    const props = this.current;
    if (!props || !props.commit) return false;
    if (index < 0 || index >= props.matches.length) return false;
    props.commit(props.matches[index], index);
    return true;
  }
}

export const def: ComponentDef = { id: 'inline-palette', blocks: [BLOCK] };
