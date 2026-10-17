// Spec 307 §UI Changes — `HandoffPicker`.
//
// `#resume list` used to print a static transcript block (`formatHandoffList`)
// and return: the user read an opaque id out of it and typed `#resume <id>` by
// hand. This overlay lists the same merged local ∪ Xenon rows with the cursor
// row's detail beside them, so `Enter` resumes without a second command.
//
// Composition is the directive picker's: `OverlayShell` + `ListPicker` + a
// preview with its OWN dependency tuple, so moving the cursor repaints two rows
// and one preview instead of re-reading every handoff body.
//
// The three overlay rules are `>`-less siblings of the root, so the shell runs
// with `parts.panel: null` and the preview rides in `extras`, as a SIBLING of
// the list.
//
// It owns no keys (CLAUDE.md constraint 1): `open` and `cursor` are props, and
// j/k/Enter/Esc stay in the view's key cascade.

import './handoff-picker.css';

import { Component } from '../../../ui/component';
import { el, frag } from '../../../ui/dom';
import { formatHandoffAge, type MergedHandoff } from '../../xenon-push';
import { ListPicker } from '../list-picker';
import { OverlayShell, type OverlayShellParts } from '../overlay-shell';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__handoff';

const HINTS = 'j/k move · enter resume · esc cancel';

/** Spec 307 edge case: nothing to pick from. The shell drops the preview with it. */
const EMPTY = 'no handoffs in this project';

/** The winning copy is a Xenon list row; `resolveHandoffDoc` fetches the body on resume. */
const DEFERRED_DETAIL = 'detail lives on xenon - fetched on resume';

const NO_SUMMARY = '(no summary)';

const PARTS: OverlayShellParts = {
  panel: null,
  head: `${BLOCK}-head`,
  title: null,
  sub: null,
  empty: `${BLOCK}-empty`,
};

/**
 * A handoff plus the two bits of row state that are not on the handoff: the
 * lane's current binding, and the age, which is a function of the caller's
 * `now` rather than of the row.
 */
interface HandoffEntry {
  readonly handoff: MergedHandoff;
  readonly bound: boolean;
  readonly age: string;
}

interface PreviewProps {
  readonly entry: HandoffEntry | null;
}

/** The detail pane. Its own component so a cursor move does not re-read the list. */
class HandoffPreview extends Component<PreviewProps> {
  private readonly scope = el('span', { class: `${BLOCK}-preview-scope` });
  private readonly source = el('span', { class: `${BLOCK}-preview-source` });
  private readonly summary = el('div', { class: `${BLOCK}-preview-summary` });
  private readonly detail = el('div', { class: `${BLOCK}-preview-detail` });

  constructor() {
    super(el('div', { class: `${BLOCK}-preview` }));
    this.el.append(
      el('div', { class: `${BLOCK}-preview-head` }, this.scope, this.source),
      this.summary,
      this.detail,
    );
  }

  protected readDeps(next: PreviewProps): readonly unknown[] {
    const handoff = next.entry?.handoff;
    return [
      handoff?.id,
      handoff?.author,
      handoff?.host,
      handoff?.summary,
      handoff?.detail,
      handoff?.source,
      next.entry?.age,
    ];
  }

  protected syncClasses(next: PreviewProps): void {
    this.el.className = `${BLOCK}-preview`;
    const deferred = next.entry !== null && next.entry.handoff.detail === null;
    this.detail.className = deferred
      ? `${BLOCK}-preview-detail ${BLOCK}-preview-detail--deferred`
      : `${BLOCK}-preview-detail`;
  }

  protected paint(next: PreviewProps): void {
    this.syncClasses(next);
    const entry = next.entry;
    if (entry === null) return;
    const handoff = entry.handoff;
    this.scope.textContent = `${handoff.id} · ${handoff.author}@${handoff.host} · ${entry.age}`;
    this.source.textContent = handoff.source;
    this.summary.textContent = handoff.summary || NO_SUMMARY;
    this.detail.textContent = handoff.detail === null ? DEFERRED_DETAIL : handoff.detail;
  }
}

export interface HandoffPickerProps {
  readonly open: boolean;
  /**
   * The lane the resume will run in. `null` — the lane went away between the
   * list read and the paint; the overlay stays shut, as every picker does.
   */
  readonly laneName: string | null;
  /** Merged local ∪ Xenon rows, already ordered newest-first by the caller. */
  readonly rows: readonly MergedHandoff[];
  readonly cursor: number;
  /** The handoff this lane is already bound to → the `bound` marker. */
  readonly boundId: string | null;
  /** `Date.now()` from the caller, for `formatHandoffAge`. */
  readonly now: number;
  /** e.g. `xenon unreachable - local handoffs only`. Rides in the head's sub span. */
  readonly note: string | null;
  onAutoClose?(): void;
}

export class HandoffPicker extends Component<HandoffPickerProps> {
  private readonly shell: OverlayShell;
  private readonly list = new ListPicker<HandoffEntry>();
  private readonly preview = new HandoffPreview();
  private readonly extras: readonly Node[];
  private entries: readonly HandoffEntry[] = [];
  private entriesKey: string | null = null;
  private autoClose: (() => void) | undefined;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.extras = [this.preview.el];
  }

  update(next: HandoffPickerProps): void {
    this.autoClose = next.onAutoClose;
    super.update(next);
  }

  protected readDeps(next: HandoffPickerProps): readonly unknown[] {
    return [next.open, next.laneName, next.note, this.keyFor(next), next.cursor];
  }

  /** Owned by `OverlayShell`, `ListPicker` and `HandoffPreview`. */
  protected syncClasses(): void {
    /* no classes of its own */
  }

  protected paint(next: HandoffPickerProps): void {
    const entries = this.entriesFor(next);
    const empty = entries.length === 0;
    const cursor = Math.max(0, Math.min(next.cursor, entries.length - 1));
    const selected = empty ? null : entries[cursor];
    this.list.update({
      items: entries,
      cursor: next.cursor,
      renderRow: this.renderRow,
      rowClasses: rowClasses,
      block: BLOCK,
      separator: '-',
      name: 'handoff',
    });
    this.preview.update({ entry: selected });
    this.shell.update({
      open: next.open && next.laneName !== null,
      rootClass: `${BLOCK}-picker`,
      block: BLOCK,
      parts: PARTS,
      title: `// handoff · ${next.laneName ?? ''}`,
      sub: this.subFor(next, entries.length),
      body: this.list.el,
      // The shell replaces the body AND drops the extras for an empty state, so
      // no pane is left hanging under the "no handoffs" line.
      extras: empty ? undefined : this.extras,
      empty: empty ? EMPTY : undefined,
      onAutoClose: this.emitAutoClose,
    });
  }

  /** `id · age · host · author · summary · source` — `formatHandoffList`'s vocabulary. */
  private readonly renderRow = (entry: HandoffEntry): Node => {
    const handoff = entry.handoff;
    return frag(
      el('span', { class: `${BLOCK}-id`, text: handoff.id }),
      el('span', { class: `${BLOCK}-age`, text: entry.age }),
      el('span', { class: `${BLOCK}-host`, text: handoff.host }),
      el('span', { class: `${BLOCK}-author`, text: handoff.author }),
      // Truncated by CSS, never by slicing: the full text stays in the DOM for
      // the detail pane's sake and for anyone who widens the window.
      el('span', { class: `${BLOCK}-summary`, text: handoff.summary || NO_SUMMARY }),
      entry.bound ? el('span', { class: `${BLOCK}-bound`, text: 'bound' }) : null,
      el('span', {
        class: [`${BLOCK}-tag`, handoff.source === 'xenon' && `${BLOCK}-tag--xenon`],
        text: handoff.source,
      }),
    );
  };

  /** Row count, the Xenon note when there is one, then the key hints. */
  private subFor(next: HandoffPickerProps, total: number): string {
    const parts = [`${total} handoffs`];
    if (next.note !== null) parts.push(next.note);
    parts.push(HINTS);
    return parts.join(' · ');
  }

  private readonly emitAutoClose = (): void => {
    this.autoClose?.();
  };

  private entriesFor(next: HandoffPickerProps): readonly HandoffEntry[] {
    const key = this.keyFor(next);
    if (key === this.entriesKey) return this.entries;
    this.entriesKey = key;
    this.entries = next.rows.map((handoff) => ({
      handoff,
      bound: handoff.id === next.boundId,
      age: formatHandoffAge(next.now - handoff.updatedAt),
    }));
    return this.entries;
  }

  /**
   * Every value a row or the preview reads. The age is the COARSE bucket, not
   * `now`, so a repaint one second later reuses the entries and a cursor move
   * never rebuilds the row set.
   */
  private keyFor(next: HandoffPickerProps): string {
    return next.rows
      .map((handoff) =>
        [
          handoff.id,
          handoff.author,
          handoff.host,
          handoff.summary,
          handoff.detail ?? '\u0002',
          handoff.source,
          formatHandoffAge(next.now - handoff.updatedAt),
          handoff.id === next.boundId,
        ].join('\u0000'),
      )
      .join('\u0001');
  }

  protected onDispose(): void {
    this.list.dispose();
    this.preview.dispose();
    this.shell.dispose();
  }
}

/** Spec 307: the lane's current handoff stays listed and stays selectable. */
function rowClasses(entry: HandoffEntry): readonly string[] {
  return entry.bound ? [`${BLOCK}-row--bound`] : [];
}

export const def: ComponentDef = { id: 'handoff-picker', blocks: [BLOCK] };
