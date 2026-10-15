// Spec 302 §7.3 — `ModelPicker`.
//
// spec 127's model switcher: the lane's advertised models, the current one
// ticked. `renderModelPicker` (`acp-harness-view.ts:12809-12847`) is the one
// picker that already scrolled its cursor into view, and the comment it needed
// to explain itself — "innerHTML rebuilds the list at scrollTop 0 on every
// j/k" — is the whole argument for this layer. The list is no longer rebuilt,
// and `scrollIntoView({ block: 'nearest' })` now comes from `ListPicker`,
// which does it for every picker instead of just this one.
//
// Keyboard-only by design (`acp-harness-view.ts:6526`): no mouse handler, so
// no selection callback. `cursor` is a prop — today the view's
// `modelPickerCursor` field.

import './model-picker.css';

import { Component } from '../../../ui/component';
import { el, frag } from '../../../ui/dom';
import type { ModelInfo } from '../../types';
import { ListPicker } from '../list-picker';
import { OverlayShell, type OverlayShellParts } from '../overlay-shell';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__model';

const HINTS = 'j/k move · enter switch · esc cancel';

const PARTS: OverlayShellParts = {
  panel: null,
  head: `${BLOCK}-head`,
  title: null,
  sub: null,
};

/** The tick is row state, not model state, so it travels on the item. */
interface ModelEntry {
  readonly model: ModelInfo;
  readonly current: boolean;
}

export interface ModelPickerProps {
  readonly open: boolean;
  /** The lane being switched. `null` — the lane went away; the overlay shuts. */
  readonly laneName: string | null;
  /** `lane.availableModels`, in the order the agent advertised them. */
  readonly models: readonly ModelInfo[];
  readonly currentModelId: string | null;
  readonly cursor: number;
  onAutoClose?(): void;
}

export class ModelPicker extends Component<ModelPickerProps> {
  private readonly shell: OverlayShell;
  private readonly list = new ListPicker<ModelEntry>();
  private entries: readonly ModelEntry[] = [];
  private entriesKey: string | null = null;
  private autoClose: (() => void) | undefined;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
  }

  update(next: ModelPickerProps): void {
    this.autoClose = next.onAutoClose;
    super.update(next);
  }

  protected readDeps(next: ModelPickerProps): readonly unknown[] {
    return [next.open, next.laneName, this.keyFor(next), next.cursor];
  }

  /** Owned by `OverlayShell` and `ListPicker`. */
  protected syncClasses(): void {
    /* no classes of its own */
  }

  protected paint(next: ModelPickerProps): void {
    this.list.update({
      items: this.entriesFor(next),
      cursor: next.cursor,
      renderRow: this.renderRow,
      block: BLOCK,
      separator: '-',
      name: 'model',
    });
    this.shell.update({
      open: next.open && next.laneName !== null,
      rootClass: `${BLOCK}-picker`,
      block: BLOCK,
      parts: PARTS,
      title: `// model · ${next.laneName ?? ''}`,
      sub: HINTS,
      body: this.list.el,
      onAutoClose: this.emitAutoClose,
    });
  }

  /** The tick lives INSIDE the name span, which is the flex row it aligns in. */
  private readonly renderRow = (entry: ModelEntry): Node =>
    frag(
      el(
        'span',
        { class: `${BLOCK}-name` },
        entry.model.name,
        entry.current ? el('span', { class: `${BLOCK}-current`, text: '✓' }) : null,
      ),
      entry.model.description
        ? el('span', { class: `${BLOCK}-desc`, text: entry.model.description })
        : null,
    );

  private readonly emitAutoClose = (): void => {
    this.autoClose?.();
  };

  private entriesFor(next: ModelPickerProps): readonly ModelEntry[] {
    const key = this.keyFor(next);
    if (key === this.entriesKey) return this.entries;
    this.entriesKey = key;
    this.entries = next.models.map((model) => ({
      model,
      current: model.model_id === next.currentModelId,
    }));
    return this.entries;
  }

  private keyFor(next: ModelPickerProps): string {
    return next.models
      .map((model) =>
        [
          model.model_id,
          model.name,
          model.description ?? '',
          model.model_id === next.currentModelId,
        ].join('\u0000'),
      )
      .join('\u0001');
  }

  protected onDispose(): void {
    this.list.dispose();
    this.shell.dispose();
  }
}

export const def: ComponentDef = { id: 'model-picker', blocks: [BLOCK] };
