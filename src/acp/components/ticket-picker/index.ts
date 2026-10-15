// Spec 302 §7.5 — `TicketPicker`.
//
// spec 194's `#ticket` dialog: Open/Closed tabs, a live filter line, the
// matching tickets and four actions on the selected one.
// `renderTicketOverlayEl` (`harness-ticket-controller.ts:678-783`) rebuilt the
// entire panel — tabs, filter, every row and all four buttons — through one
// `innerHTML` per KEYSTROKE of the filter, which is also why its own click
// handler has to re-find everything by `data-*` attribute afterwards.
//
// Composition, in panel order: `TabStrip` · the filter line with `Caret` ·
// `ListPicker` · four `ActionButton`s · `KeyHintBar`. The panel's children are
// flat (`.acp-ticket__panel` is the flex column), so everything after the tabs
// rides in the shell's `extras`.
//
// ⚠ The tabs now emit `data-tab-id`, not `data-ticket-tab`, and selection
// arrives through `onSelectTab`. `handleTicketPickerClick`'s
// `closest('[data-ticket-tab]')` branch (`harness-ticket-controller.ts:296-300`)
// must be deleted by the integrator, along with the row and action branches —
// rows report through `onChooseRow` and buttons through `onAction`, so leaving
// the delegated handler in place would run every selection twice.

import './ticket-picker.css';

import { Component } from '../../../ui/component';
import { el, frag, setChildren } from '../../../ui/dom';
import { formatAge } from '../../harness-format';
import type { TicketPickerAction, TicketPickerTab } from '../../harness-ticket-helpers';
import type { TicketPickerRow } from '../../harness-view-types';
import { ActionButton } from '../action-button';
import { Caret } from '../caret';
import { EmptyState } from '../empty-state';
import { KeyHintBar } from '../key-hint-bar';
import { ListPicker, type ListPickerRowTag } from '../list-picker';
import { OverlayShell, type OverlayShellParts } from '../overlay-shell';
import { TabStrip } from '../tab-strip';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-ticket';

const PARTS: OverlayShellParts = {
  panel: `${BLOCK}__panel`,
  head: `${BLOCK}__head`,
  // `<header class="acp-ticket__head">local tickets + GitHub<span …__sub>…`:
  // the title is a bare text node, with no span of its own.
  titleAsText: true,
  sub: `${BLOCK}__sub`,
};

const PANEL_ATTRS: Readonly<Record<string, string>> = {
  role: 'dialog',
  'aria-modal': 'true',
  'aria-label': 'Working ticket',
};

const TITLE = 'local tickets + GitHub';

const FOOT_HINTS = [
  { keys: ['Tab'], label: 'open/closed' },
  { keys: ['↑↓', '⌃n⌃p'], label: 'select', keySeparator: ' / ' },
  { keys: ['Esc'], label: 'dismiss' },
] as const;

/** One row, with every string it prints already resolved. */
interface TicketEntry {
  readonly title: string;
  readonly num: string;
  readonly badge: string | null;
  readonly labels: string | null;
  readonly age: string;
  readonly unavailable: boolean;
}

export interface TicketPickerProps {
  readonly open: boolean;
  /** Already filtered by tab and filter text — the view's `ticketPickerMatches()`. */
  readonly rows: readonly TicketPickerRow[];
  /** Tab counts over ALL rows, not over `rows` — `ticketPickerTabCounts()`. */
  readonly counts: { readonly open: number; readonly closed: number };
  readonly tab: TicketPickerTab;
  /** The live filter text; empty renders the `type to filter` hint. */
  readonly filter: string;
  readonly cursor: number;
  readonly laneName: string | null;
  readonly laneStatus: string | null;
  /** Lane total for the foot note, not the lanes this picker touches. */
  readonly laneCount: number;
  /** `ticketWorkActionDisabledReason()`; non-null disables the three work actions. */
  readonly workDisabledReason: string | null;
  /**
   * Clock for the row ages. A prop, not `Date.now()`, so a row's content stays
   * a pure function of its item: `formatAge` rounds to the minute, so passing
   * `Date.now()` every pass still repaints at most once a minute.
   */
  readonly now: number;
  onSelectTab?(tab: TicketPickerTab): void;
  onChooseRow?(index: number): void;
  onAction?(action: TicketPickerAction): void;
  onAutoClose?(): void;
}

export class TicketPicker extends Component<TicketPickerProps> {
  private readonly shell: OverlayShell;
  private readonly tabs = new TabStrip('button');
  private readonly filterEl = el('div', { class: `${BLOCK}__filter` });
  private readonly filterHint = el('span', { class: `${BLOCK}__filter-hint`, text: 'type to filter' });
  private readonly caret = new Caret();
  private readonly list = new ListPicker<TicketEntry>('div', 'button');
  private readonly emptyRows: HTMLElement;
  private readonly empty = new EmptyState();
  private readonly actionsEl = el('div', {
    class: `${BLOCK}__actions`,
    attrs: { 'aria-label': 'Selected ticket actions' },
  });
  private readonly actions: readonly ActionButton[];
  // A real `<footer class="acp-ticket__foot">`, which `KeyHintBar`'s default
  // `<div>` root is not — so the foot is built here and rides in `extras`
  // rather than through the shell's `hints` slot.
  private readonly foot = new KeyHintBar('footer');
  private readonly extrasList: readonly Node[];
  private readonly extrasEmpty: readonly Node[];
  private entries: readonly TicketEntry[] = [];
  private entriesKey: string | null = null;
  private selectTab: ((tab: TicketPickerTab) => void) | undefined;
  private chooseRow: ((index: number) => void) | undefined;
  private action: ((action: TicketPickerAction) => void) | undefined;
  private autoClose: (() => void) | undefined;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.actions = [new ActionButton(), new ActionButton(), new ActionButton(), new ActionButton()];
    for (const button of this.actions) this.actionsEl.appendChild(button.el);
    this.filterEl.append(this.filterHint, this.caret.el);
    // The empty note sits INSIDE the rows container: `.acp-ticket__rows` is the
    // panel's one `flex: 1 1 auto; overflow-y: auto` child, so a note outside
    // it would not fill the panel.
    this.emptyRows = el('div', {
      class: `${BLOCK}__rows`,
      attrs: { role: 'listbox', 'data-count': '0' },
    });
    this.emptyRows.appendChild(this.empty.el);
    this.extrasList = [this.filterEl, this.list.el, this.actionsEl, this.foot.el];
    this.extrasEmpty = [this.filterEl, this.emptyRows, this.actionsEl, this.foot.el];
    // ONE delegated listener for row clicks, attached once; the tabs and the
    // four buttons carry their own.
    this.bag.listen(this.el, 'click', (event: Event) => {
      if (this.chooseRow === undefined || !(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>('[data-ticket-index]');
      if (row === null || !this.el.contains(row)) return;
      const index = Number(row.dataset.ticketIndex);
      if (Number.isInteger(index)) this.chooseRow(index);
    });
  }

  update(next: TicketPickerProps): void {
    this.selectTab = next.onSelectTab;
    this.chooseRow = next.onChooseRow;
    this.action = next.onAction;
    this.autoClose = next.onAutoClose;
    super.update(next);
  }

  protected readDeps(next: TicketPickerProps): readonly unknown[] {
    return [
      next.open,
      this.keyFor(next),
      next.cursor,
      next.tab,
      next.counts.open,
      next.counts.closed,
      next.filter,
      next.laneName,
      next.laneStatus,
      next.laneCount,
      next.workDisabledReason,
    ];
  }

  /** Owned by the shell, the tabs, the list, the buttons and the foot. */
  protected syncClasses(): void {
    /* no classes of its own */
  }

  protected paint(next: TicketPickerProps): void {
    const entries = this.entriesFor(next);
    const cursor = Math.max(0, Math.min(next.cursor, entries.length - 1));
    const selected = entries.length === 0 ? null : next.rows[cursor];

    this.tabs.update({
      tabs: [
        { id: 'open', label: 'Open', count: next.counts.open },
        { id: 'closed', label: 'Closed', count: next.counts.closed },
      ],
      activeId: next.tab,
      block: BLOCK,
      item: 'tab',
      activeClass: `${BLOCK}__tab--active`,
      count: 'badge',
      role: 'tablist',
      ariaLabel: 'Ticket status',
      onSelect: this.emitSelectTab,
    });

    setChildren(this.filterEl, [next.filter ? next.filter : this.filterHint, this.caret.el]);
    this.caret.update({});

    if (entries.length === 0) {
      this.empty.update({ block: `${BLOCK}__empty`, text: emptyText(next) });
    } else {
      this.list.update({
        items: entries,
        cursor: next.cursor,
        renderRow: this.renderRow,
        rowTagFor: rowTagFor,
        rowClasses: rowClasses,
        rowAttrs: rowAttrs,
        block: BLOCK,
        name: 'ticket',
        listClass: `${BLOCK}__rows`,
        activeModifier: 'selected',
        listAttrs: { role: 'listbox', 'data-count': String(entries.length) },
        filter: next.filter,
      });
    }

    this.paintActions(next, selected);
    this.foot.update({
      hints: FOOT_HINTS,
      style: 'plain',
      layout: 'run',
      block: `${BLOCK}__foot`,
      note: `shared with all ${next.laneCount} lanes · work runs in ${next.laneName ?? 'no lane'}`,
    });

    this.shell.update({
      open: next.open,
      rootClass: 'acp-harness__ticket-overlay',
      block: BLOCK,
      parts: PARTS,
      panelAttrs: PANEL_ATTRS,
      title: TITLE,
      sub: next.laneName === null
        ? 'target: no active lane'
        : `target: ${next.laneName} · ${next.laneStatus ?? ''}`,
      body: this.tabs.el,
      extras: entries.length === 0 ? this.extrasEmpty : this.extrasList,
      onAutoClose: this.emitAutoClose,
    });
  }

  /**
   * `Set ticket` only needs a usable row; the three GitHub actions also need a
   * URL and a lane that can take the work.
   */
  private paintActions(next: TicketPickerProps, selected: TicketPickerRow | null): void {
    const usable = selected !== null && selected.kind !== 'unavailable';
    const workDisabled = !usable || !selected.url || next.workDisabledReason !== null;
    const work = {
      disabled: workDisabled,
      disabledReason: next.workDisabledReason ?? undefined,
    };
    this.actions[0].update({
      block: `${BLOCK}__action`,
      keyHint: 'Enter',
      label: 'Set ticket',
      disabled: !usable,
      data: { 'ticket-action': 'set-ticket' },
      onClick: this.emitSetTicket,
    });
    this.actions[1].update({
      ...work,
      block: `${BLOCK}__action`,
      keyHint: '⌘1',
      label: 'Analyze',
      data: { 'ticket-action': 'analyze-github-issue' },
      onClick: this.emitAnalyze,
    });
    this.actions[2].update({
      ...work,
      block: `${BLOCK}__action`,
      keyHint: '⌘2',
      label: 'Post comment',
      data: { 'ticket-action': 'post-github-comment' },
      onClick: this.emitComment,
    });
    this.actions[3].update({
      ...work,
      block: `${BLOCK}__action`,
      modifier: `${BLOCK}__action--fix`,
      keyHint: '⌘3',
      label: 'Fix here',
      data: { 'ticket-action': 'fix-github-issue' },
      onClick: this.emitFix,
    });
  }

  private readonly renderRow = (entry: TicketEntry): Node =>
    frag(
      el('span', { class: `${BLOCK}__title`, text: entry.title }),
      el(
        'span',
        { class: `${BLOCK}__identity` },
        el('span', { class: `${BLOCK}__num`, text: entry.num }),
        entry.badge === null ? null : el('span', { class: `${BLOCK}__badge`, text: entry.badge }),
      ),
      entry.labels === null ? null : el('span', { class: `${BLOCK}__labels`, text: entry.labels }),
      el('span', { class: `${BLOCK}__age`, text: entry.age }),
    );

  private readonly emitSelectTab = (id: string): void => {
    if (id === 'open' || id === 'closed') this.selectTab?.(id);
  };

  private readonly emitSetTicket = (): void => {
    this.action?.('set-ticket');
  };

  private readonly emitAnalyze = (): void => {
    this.action?.('analyze-github-issue');
  };

  private readonly emitComment = (): void => {
    this.action?.('post-github-comment');
  };

  private readonly emitFix = (): void => {
    this.action?.('fix-github-issue');
  };

  private readonly emitAutoClose = (): void => {
    this.autoClose?.();
  };

  private entriesFor(next: TicketPickerProps): readonly TicketEntry[] {
    const key = this.keyFor(next);
    if (key === this.entriesKey) return this.entries;
    this.entriesKey = key;
    this.entries = next.rows.map((row) => entryFor(row, next.now));
    return this.entries;
  }

  private keyFor(next: TicketPickerProps): string {
    return next.rows
      .map((row) => {
        const entry = entryFor(row, next.now);
        return [entry.title, entry.num, entry.badge ?? '', entry.labels ?? '', entry.age, entry.unavailable].join('\u0000');
      })
      .join('\u0001');
  }

  protected onDispose(): void {
    this.tabs.dispose();
    this.caret.dispose();
    this.list.dispose();
    this.empty.dispose();
    for (const button of this.actions) button.dispose();
    this.foot.dispose();
    this.shell.dispose();
  }
}

/** Everything a row prints, resolved once per row rather than per repaint. */
function entryFor(row: TicketPickerRow, now: number): TicketEntry {
  const updated = Date.parse(row.updatedAt ?? '');
  const age = Number.isNaN(updated) ? '' : formatAge(now - updated);
  const state = row.kind === 'unavailable' ? '' : ` · ${row.state}`;
  const num = row.kind === 'local'
    ? row.ticketId ?? 'local'
    : row.kind === 'unavailable'
      ? 'gh'
      : `#${row.number ?? '?'}`;
  const badge = row.kind === 'local' ? 'LOCAL' : row.kind === 'github' ? 'IMPORT' : null;
  return {
    title: row.title,
    num,
    badge,
    labels: row.labels.length > 0 ? row.labels.join(', ') : null,
    age: `${age}${state}`,
    unavailable: row.kind === 'unavailable',
  };
}

function emptyText(next: TicketPickerProps): string {
  if (next.filter.trim()) return 'no matching tickets';
  return next.tab === 'closed' ? 'no closed tickets' : 'no open tickets';
}

/** An unavailable row is a `<div>`: it is a notice, not something to press. */
function rowTagFor(entry: TicketEntry): ListPickerRowTag {
  return entry.unavailable ? 'div' : 'button';
}

function rowClasses(entry: TicketEntry): readonly string[] {
  return entry.unavailable ? [`${BLOCK}__row--unavailable`] : [];
}

function rowAttrs(
  entry: TicketEntry,
  _index: number,
  active: boolean,
): Readonly<Record<string, string | undefined>> {
  return {
    role: 'option',
    'aria-selected': String(active),
    'aria-disabled': entry.unavailable ? 'true' : undefined,
  };
}

export const def: ComponentDef = {
  id: 'ticket-picker',
  blocks: ['acp-harness__ticket-overlay', BLOCK],
};
