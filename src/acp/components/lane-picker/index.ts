// Spec 302 §7.1 — `LanePicker`.
//
// The "add lane" overlay: the installed ACP backends, one per row, with the
// number of lanes already running on each. `renderPicker`
// (`acp-harness-view.ts:12699-12741`) rebuilt the whole panel through
// `innerHTML` on every j/k, which is why the list could never remember a
// scroll offset and why `esc` had to wipe it to an empty string.
//
// Everything structural comes from the two primitives: `OverlayShell` owns the
// root, the `hidden` toggle, the panel, the head and the empty state;
// `ListPicker` owns the cursor math, the `--active` modifier and the
// `data-picker-index` attributes. What is left here is this picker's own
// content: the head line, the three key hints and one row's three spans.
//
// It owns no key table (CLAUDE.md constraint 1). `cursor` is a prop — today it
// is the view's `pickerCursor` field (`acp-harness-view.ts:1280`) — and the
// component never decides that `j` moves it.

import './lane-picker.css';

import type { HarnessDirective } from '../../../config';
import { Component } from '../../../ui/component';
import { el, frag } from '../../../ui/dom';
import { backendLabel } from '../../harness-lane-identity';
import type { AcpBackendDescriptor } from '../../types';
import { ListPicker } from '../list-picker';
import { OverlayShell, type OverlayShellParts } from '../overlay-shell';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__picker';

/** The head's second span, `.acp-harness__picker-head span:last-child`. */
const HINTS = 'j/k move · enter spawn · esc cancel';

const EMPTY = 'no ACP backends installed';

// Single-dash element names on the `acp-harness` block, an unclassed title and
// an unclassed hint span — the shape `acp-harness.css:6140-6238` styles.
const PARTS: OverlayShellParts = {
  panel: `${BLOCK}-panel`,
  head: `${BLOCK}-head`,
  title: null,
  sub: null,
  empty: `${BLOCK}-empty`,
};

/**
 * One row's data. The running count lives on the ITEM rather than in the row
 * closure because `ListPicker` rebuilds a row's content when its item or index
 * moves and at no other time — a count read out of a closure would go stale
 * the moment a lane started without the backend list changing.
 */
interface BackendEntry {
  readonly id: string;
  readonly label: string;
  readonly running: number;
}

export interface LanePickerProps {
  readonly open: boolean;
  /** Installed backends, already ordered by `harnessBackends()`. */
  readonly backends: readonly AcpBackendDescriptor[];
  /** Lanes already running per backend id; a missing id counts as zero. */
  readonly running: ReadonlyMap<string, number>;
  readonly cursor: number;
  /**
   * spec 163: set when Shift+Enter in the directive picker opened this one, so
   * the head can say which directive the spawned lane will carry.
   */
  readonly pendingDirective: HarnessDirective | null;
  /** Another overlay took the single open slot; clear the owner's flag. */
  onAutoClose?(): void;
}

export class LanePicker extends Component<LanePickerProps> {
  private readonly shell: OverlayShell;
  private readonly list = new ListPicker<BackendEntry>();
  private entries: readonly BackendEntry[] = [];
  private entriesKey: string | null = null;
  private autoClose: (() => void) | undefined;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
  }

  update(next: LanePickerProps): void {
    this.autoClose = next.onAutoClose;
    super.update(next);
  }

  protected readDeps(next: LanePickerProps): readonly unknown[] {
    return [
      next.open,
      this.keyFor(next),
      next.cursor,
      next.pendingDirective?.id,
      next.pendingDirective?.title,
    ];
  }

  /**
   * Every class this component paints belongs to `OverlayShell` or
   * `ListPicker`, and both re-derive theirs from their own props on each paint
   * — which `paint()` below always drives. Nothing is owned at this level.
   */
  protected syncClasses(): void {
    /* no classes of its own */
  }

  protected paint(next: LanePickerProps): void {
    const entries = this.entriesFor(next);
    this.list.update({
      items: entries,
      cursor: next.cursor,
      renderRow: this.renderRow,
      block: BLOCK,
      separator: '-',
      name: 'picker',
    });
    this.shell.update({
      open: next.open,
      rootClass: BLOCK,
      block: BLOCK,
      parts: PARTS,
      title: headTitle(next.pendingDirective),
      sub: HINTS,
      body: this.list.el,
      empty: entries.length === 0 ? EMPTY : undefined,
      onAutoClose: this.emitAutoClose,
    });
  }

  /** `·2 running` is dropped entirely at zero, as the template does today. */
  private readonly renderRow = (entry: BackendEntry): Node =>
    frag(
      el('span', { class: `${BLOCK}-label`, text: entry.label }),
      el('span', { class: `${BLOCK}-id`, text: entry.id }),
      entry.running > 0 ? ' ' : null,
      entry.running > 0
        ? el('span', { class: `${BLOCK}-count`, text: `·${entry.running} running` })
        : null,
    );

  private readonly emitAutoClose = (): void => {
    this.autoClose?.();
  };

  /** Identity-stable rows: a new array only when a row's content moved. */
  private entriesFor(next: LanePickerProps): readonly BackendEntry[] {
    const key = this.keyFor(next);
    if (key === this.entriesKey) return this.entries;
    this.entriesKey = key;
    this.entries = next.backends.map((backend) => ({
      id: backend.id,
      label: backendLabel(backend.id),
      running: next.running.get(backend.id) ?? 0,
    }));
    return this.entries;
  }

  private keyFor(next: LanePickerProps): string {
    return next.backends
      .map((backend) => `${backend.id}\u0000${next.running.get(backend.id) ?? 0}`)
      .join('\u0001');
  }

  protected onDispose(): void {
    this.list.dispose();
    this.shell.dispose();
  }
}

function headTitle(directive: HarnessDirective | null): string {
  if (directive === null) return '// add lane';
  return `// add lane · directive: ${directive.title || directive.id}`;
}

export const def: ComponentDef = { id: 'lane-picker', blocks: [BLOCK] };
