// Spec 302 §7.6 — `RemotePicker`.
//
// The "Open Remote ACP Harness" dialog: the focused SSH session (when there is
// one) and every configured remote profile, plus the absolute-path prompt the
// focused-SSH row needs when the terminal has no project directory.
// `showRemoteHarnessPicker` (`remote-harness-picker.ts:69-170`) builds all of
// it inside one Promise executor, with a `let cursor` closure, a `render()`
// that rebuilds every row with `innerHTML` and attaches a fresh click listener
// per row, and a hand-rolled `escapeHtml` at the bottom of the file.
//
// This component renders selection state only. It does not own the promise,
// the `document`-level keydown capture, focus, or what Enter means — all of
// which stay with the caller (CLAUDE.md constraint 1).
//
// ⚠ It does NOT use `OverlayShell`: this dialog's root is a focusable
// `<div role="dialog">`, its panel is a `<section>` and its hint is a
// `<footer>`. Those are tag differences, not class differences, and the shell
// has no tag knobs. It composes `ListPicker` and `KeyHintBar` instead.

import './remote-picker.css';

import { Component } from '../../../ui/component';
import { el, frag } from '../../../ui/dom';
import { KeyHintBar, type KeyHint } from '../key-hint-bar';
import { ListPicker } from '../list-picker';
import type { ComponentDef } from '../types';

const BLOCK = 'remote-harness-picker';

const HEAD = 'REMOTE ACP HARNESS';

const PATH_PLACEHOLDER = '/absolute/remote/project/path';

const LIST_HINTS: readonly KeyHint[] = [
  { keys: ['j/k'], label: 'select' },
  { keys: ['Enter'], label: 'connect' },
  { keys: ['Esc'], label: 'cancel' },
];

const NO_ROWS_HINTS: readonly KeyHint[] = [
  { keys: [], label: 'No SSH session or remote profiles' },
  { keys: ['Esc'], label: 'close' },
];

const PATH_HINTS: readonly KeyHint[] = [
  { keys: ['Enter'], label: 'connect' },
  { keys: ['Esc'], label: 'back' },
  { keys: [], label: 'absolute path required' },
];

const PATH_INVALID_HINTS: readonly KeyHint[] = [
  { keys: [], label: 'Enter an absolute path beginning with /' },
];

/** What a row shows. `launch` and `needsPath` stay with the caller. */
export interface RemotePickerRow {
  readonly label: string;
  readonly detail: string;
}

export interface RemotePickerProps {
  /** `remoteHarnessPickerRows(choices)` — the focused SSH row, then profiles. */
  readonly rows: readonly RemotePickerRow[];
  readonly cursor: number;
  /** The selected row needs a project path; the input is showing. */
  readonly pathMode: boolean;
  /** The path just submitted was not absolute — the hint says so instead. */
  readonly pathInvalid?: boolean;
  onChoose?(index: number): void;
}

export class RemotePicker extends Component<RemotePickerProps> {
  private readonly panel = el('section', { class: `${BLOCK}__panel` });
  private readonly head = el('header', { class: `${BLOCK}__head`, text: HEAD });
  private readonly list = new ListPicker<RemotePickerRow>('div', 'button');
  private readonly path = el('input', {
    class: `${BLOCK}__path`,
    attrs: { placeholder: PATH_PLACEHOLDER },
  });
  private readonly hint = new KeyHintBar('footer');
  private rows: readonly RemotePickerRow[] = [];
  private rowsKey: string | null = null;
  private choose: ((index: number) => void) | undefined;

  constructor() {
    super(el('div'));
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Open Remote ACP Harness');
    this.path.hidden = true;
    this.panel.append(this.head, this.list.el, this.path, this.hint.el);
    this.el.appendChild(this.panel);
    // ONE delegated listener replaces the per-row listener `render()` reattached
    // on every cursor move.
    this.bag.listen(this.el, 'click', (event: Event) => {
      if (this.choose === undefined || !(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>('[data-remote-index]');
      if (row === null || !this.el.contains(row)) return;
      const index = Number(row.dataset.remoteIndex);
      if (Number.isInteger(index)) this.choose(index);
    });
  }

  /** The path field, for the caller that focuses it and reads its value. */
  get pathInput(): HTMLInputElement {
    return this.path;
  }

  update(next: RemotePickerProps): void {
    this.choose = next.onChoose;
    super.update(next);
  }

  protected readDeps(next: RemotePickerProps): readonly unknown[] {
    return [this.keyFor(next), next.cursor, next.pathMode, next.pathInvalid === true];
  }

  protected syncClasses(): void {
    this.el.className = BLOCK;
    this.panel.className = `${BLOCK}__panel`;
    this.head.className = `${BLOCK}__head`;
    this.path.className = `${BLOCK}__path`;
  }

  protected paint(next: RemotePickerProps): void {
    this.syncClasses();
    this.list.update({
      items: this.rowsFor(next),
      cursor: next.cursor,
      renderRow: this.renderRow,
      block: BLOCK,
      name: 'remote',
      listClass: `${BLOCK}__list`,
      rowClass: `${BLOCK}__row`,
    });
    this.path.hidden = !next.pathMode;
    this.hint.update({ hints: hintsFor(next), style: 'plain', block: `${BLOCK}__hint` });
  }

  private readonly renderRow = (row: RemotePickerRow): Node =>
    frag(el('strong', { text: row.label }), el('span', { text: row.detail }));

  private rowsFor(next: RemotePickerProps): readonly RemotePickerRow[] {
    const key = this.keyFor(next);
    if (key === this.rowsKey) return this.rows;
    this.rowsKey = key;
    this.rows = next.rows.map((row) => ({ label: row.label, detail: row.detail }));
    return this.rows;
  }

  private keyFor(next: RemotePickerProps): string {
    return next.rows.map((row) => `${row.label}\u0000${row.detail}`).join('\u0001');
  }

  protected onDispose(): void {
    this.list.dispose();
    this.hint.dispose();
  }
}

/** Four hint lines, in the order the dialog can reach them. */
function hintsFor(next: RemotePickerProps): readonly KeyHint[] {
  if (next.pathMode) return next.pathInvalid === true ? PATH_INVALID_HINTS : PATH_HINTS;
  return next.rows.length > 0 ? LIST_HINTS : NO_ROWS_HINTS;
}

export const def: ComponentDef = { id: 'remote-picker', blocks: [BLOCK] };
