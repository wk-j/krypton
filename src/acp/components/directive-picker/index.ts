// Spec 302 §7.2 — `DirectivePicker`.
//
// The `#directive` overlay (spec 124): every configured directive on one
// scannable line, plus a fixed-height preview of the selected prompt.
// `renderDirectivePicker` (`acp-harness-view.ts:12745-12806`) rebuilt the
// head, the list AND the preview through one `innerHTML` per keystroke, so
// moving the cursor re-parsed every prompt body in the list.
//
// Here the preview is its own component with its own dependency tuple: moving
// the cursor repaints two rows and one preview, and a directive whose prompt
// did not change is not touched at all.
//
// The three overlay rules are `>` child combinators on the root
// (`acp-harness.css:6258-6260`), so the shell runs with `parts.panel: null`
// and the preview rides in `extras`, as a SIBLING of the list.

import './directive-picker.css';

import type { HarnessDirective } from '../../../config';
import { Component } from '../../../ui/component';
import { el, frag } from '../../../ui/dom';
import { ListPicker } from '../list-picker';
import { OverlayShell, type OverlayShellParts } from '../overlay-shell';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__directive';

const HINTS = 'j/k move · enter switch · shift+enter new lane · backspace clear · esc cancel';

/** spec 130: legacy triage metadata, a glyph only; the full label is the title. */
const TRIAGE_TITLE = 'legacy triage metadata; attention tools are default-on';

const PARTS: OverlayShellParts = {
  panel: null,
  head: `${BLOCK}-head`,
  title: null,
  sub: null,
};

/** A directive plus the one bit of row state that is not on the directive. */
interface DirectiveEntry {
  readonly directive: HarnessDirective;
  readonly assigned: boolean;
}

interface PreviewProps {
  readonly directive: HarnessDirective | null;
}

/** The prompt pane. Its own component so a cursor move does not re-read the list. */
class DirectivePreview extends Component<PreviewProps> {
  private readonly scope = el('span', { class: `${BLOCK}-preview-scope` });
  private readonly body = el('div', { class: `${BLOCK}-preview-body` });

  constructor() {
    super(el('div', { class: `${BLOCK}-preview` }));
    this.el.append(
      el('div', { class: `${BLOCK}-preview-head` }, el('span', { text: '// prompt' }), this.scope),
      this.body,
    );
  }

  protected readDeps(next: PreviewProps): readonly unknown[] {
    return [next.directive?.id, next.directive?.task, next.directive?.system_prompt];
  }

  protected syncClasses(): void {
    this.el.className = `${BLOCK}-preview`;
  }

  protected paint(next: PreviewProps): void {
    this.syncClasses();
    const directive = next.directive;
    if (directive === null) return;
    this.scope.textContent = [directive.id, directive.task].filter(Boolean).join(' · ');
    this.body.textContent = directive.system_prompt || '(empty prompt)';
  }
}

export interface DirectivePickerProps {
  readonly open: boolean;
  /**
   * The active lane's display name. `null` — no active lane, which is the
   * `if (!lane)` bail at `acp-harness-view.ts:12751`: there is nothing to
   * switch, so the overlay stays shut.
   */
  readonly laneName: string | null;
  /** Already ordered by the view's `pickerDirectives()`. */
  readonly directives: readonly HarnessDirective[];
  /** `pendingDirectiveChange?.directiveId ?? activeDirectiveId` — the `assigned` tag. */
  readonly currentDirectiveId: string | null;
  readonly cursor: number;
  /** A row was clicked. The caller decides what selecting means. */
  onChoose?(index: number): void;
  onAutoClose?(): void;
}

export class DirectivePicker extends Component<DirectivePickerProps> {
  private readonly shell: OverlayShell;
  private readonly list = new ListPicker<DirectiveEntry>();
  private readonly preview = new DirectivePreview();
  private readonly extras: readonly Node[];
  private entries: readonly DirectiveEntry[] = [];
  private entriesKey: string | null = null;
  private choose: ((index: number) => void) | undefined;
  private autoClose: (() => void) | undefined;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.extras = [this.preview.el];
    // ONE delegated listener for the overlay's life, as the view attaches once
    // at `acp-harness-view.ts:6514`. `paint()` never touches it.
    this.bag.listen(this.el, 'click', (event: Event) => {
      if (this.choose === undefined || !(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>('[data-directive-index]');
      if (row === null || !this.el.contains(row)) return;
      const index = Number(row.dataset.directiveIndex);
      if (Number.isInteger(index)) this.choose(index);
    });
  }

  update(next: DirectivePickerProps): void {
    this.choose = next.onChoose;
    this.autoClose = next.onAutoClose;
    super.update(next);
  }

  protected readDeps(next: DirectivePickerProps): readonly unknown[] {
    return [next.open, next.laneName, this.keyFor(next), next.cursor];
  }

  /** Owned by `OverlayShell`, `ListPicker` and `DirectivePreview`. */
  protected syncClasses(): void {
    /* no classes of its own */
  }

  protected paint(next: DirectivePickerProps): void {
    const entries = this.entriesFor(next);
    const cursor = Math.max(0, Math.min(next.cursor, entries.length - 1));
    const selected = entries.length === 0 ? null : entries[cursor].directive;
    this.list.update({
      items: entries,
      cursor: next.cursor,
      renderRow: this.renderRow,
      rowClasses: rowClasses,
      block: BLOCK,
      separator: '-',
      name: 'directive',
    });
    this.preview.update({ directive: selected });
    this.shell.update({
      open: next.open && next.laneName !== null,
      rootClass: `${BLOCK}-picker`,
      block: BLOCK,
      parts: PARTS,
      title: `// directive · ${next.laneName ?? ''}`,
      sub: HINTS,
      body: this.list.el,
      // No preview when nothing is selected — the empty list renders an empty
      // `<ul>` and no pane, exactly as the `selected ? … : ''` ternary does.
      extras: selected === null ? undefined : this.extras,
      onAutoClose: this.emitAutoClose,
    });
  }

  private readonly renderRow = (entry: DirectiveEntry): Node => {
    const directive = entry.directive;
    return frag(
      el('span', { class: `${BLOCK}-icon`, text: directive.icon }),
      el('span', { class: `${BLOCK}-title`, text: directive.title || directive.id }),
      entry.assigned ? el('span', { class: `${BLOCK}-assigned`, text: 'assigned' }) : null,
      directive.enabled ? null : el('span', { class: `${BLOCK}-badge`, text: 'disabled' }),
      directive.triage_equipped
        ? el('span', {
            class: [`${BLOCK}-badge`, `${BLOCK}-badge--triage`],
            title: TRIAGE_TITLE,
            text: '◆',
          })
        : null,
      directive.description
        ? el('span', { class: `${BLOCK}-desc`, text: directive.description })
        : null,
    );
  };

  private readonly emitAutoClose = (): void => {
    this.autoClose?.();
  };

  private entriesFor(next: DirectivePickerProps): readonly DirectiveEntry[] {
    const key = this.keyFor(next);
    if (key === this.entriesKey) return this.entries;
    this.entriesKey = key;
    this.entries = next.directives.map((directive) => ({
      directive,
      assigned: directive.id === next.currentDirectiveId,
    }));
    return this.entries;
  }

  /** Every field a row or the preview reads, so an edited directive repaints. */
  private keyFor(next: DirectivePickerProps): string {
    return next.directives
      .map((d) =>
        [
          d.id,
          d.icon,
          d.title,
          d.description,
          d.task,
          d.system_prompt,
          d.enabled,
          d.triage_equipped,
          d.id === next.currentDirectiveId,
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

/** spec 124: a disabled directive stays listed, dimmed, and stays selectable. */
function rowClasses(entry: DirectiveEntry): readonly string[] {
  return entry.directive.enabled ? [] : [`${BLOCK}-row--disabled`];
}

export const def: ComponentDef = {
  id: 'directive-picker',
  blocks: [
    `${BLOCK}-picker`,
    `${BLOCK}-head`,
    `${BLOCK}-list`,
    `${BLOCK}-row`,
    `${BLOCK}-icon`,
    `${BLOCK}-title`,
    `${BLOCK}-assigned`,
    `${BLOCK}-badge`,
    `${BLOCK}-desc`,
    `${BLOCK}-preview`,
  ],
};
