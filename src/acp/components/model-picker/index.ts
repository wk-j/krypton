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
//
// Spec 388 adds the effort strip under the list: one line of the agent's
// `thought_level` values, the `h`/`l` cursor lit like the list cursor and the
// agent's current value ticked. It is a sibling well of the list on the same
// plate (an `extras` node), so no box sits inside another. Its `h/l` caps sit
// on the strip itself: in the head they wrapped the title at the 580px plate.

import './model-picker.css';

import { Component } from '../../../ui/component';
import { el, frag } from '../../../ui/dom';
import { keyHint, type KeyHint } from '../../../ui/kbd';
import type { EffortOption, ModelInfo } from '../../types';
import { ListPicker } from '../list-picker';
import { OverlayShell, type OverlayShellParts } from '../overlay-shell';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__model';

const HINTS: readonly KeyHint[] = [
  { keys: ['j', 'k'], label: 'move', keySeparator: '/' },
  { keys: ['Enter'], label: 'switch' },
  { keys: ['Esc'], label: 'cancel' },
];

/** spec 388: the strip's own key caps, after its label. */
const EFFORT_KEYS: KeyHint = { keys: ['h', 'l'], label: '', keySeparator: '/' };

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

/** spec 388: the effort strip. `cursor` indexes `options`. */
export interface ModelPickerEffort {
  readonly options: readonly EffortOption[];
  /** The agent's current value — ticked. */
  readonly current: string | null;
  readonly cursor: number;
}

export interface ModelPickerProps {
  readonly open: boolean;
  /** The lane being switched. `null` — the lane went away; the overlay shuts. */
  readonly laneName: string | null;
  /** `lane.availableModels`, in the order the agent advertised them. */
  readonly models: readonly ModelInfo[];
  readonly currentModelId: string | null;
  readonly cursor: number;
  /** spec 388: null or absent — the lane has no effort control, no strip. */
  readonly effort?: ModelPickerEffort | null;
  onAutoClose?(): void;
}

export class ModelPicker extends Component<ModelPickerProps> {
  private readonly shell: OverlayShell;
  private readonly list = new ListPicker<ModelEntry>();
  private readonly effortEl = el('div', { class: `${BLOCK}-effort` });
  private effortKey: string | null = null;
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
    return [next.open, next.laneName, this.keyFor(next), next.cursor, effortKeyFor(next.effort)];
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
      extras: next.effort ? [this.paintEffort(next.effort)] : [],
      onAutoClose: this.emitAutoClose,
    });
  }

  /** The strip is rebuilt only when what it says changed; a cursor move is one
   *  class swap on two option spans. */
  private paintEffort(effort: ModelPickerEffort): HTMLElement {
    const key = effortKeyFor(effort);
    if (key === this.effortKey) return this.effortEl;
    const shape = effortShapeKey(effort);
    if (this.effortKey === null || effortShapeKey(this.lastEffort) !== shape) {
      this.effortEl.replaceChildren(
        el('span', { class: `${BLOCK}-effort-label`, text: 'effort' }),
        keyHint(EFFORT_KEYS, `${BLOCK}-effort-keys`),
        ...effort.options.map((option) => el('span', { class: `${BLOCK}-effort-option` }, option.name)),
      );
    }
    const options = this.effortEl.querySelectorAll<HTMLElement>(`.${BLOCK}-effort-option`);
    effort.options.forEach((option, index) => {
      const node = options[index];
      if (!node) return;
      const cls = index === effort.cursor
        ? `${BLOCK}-effort-option ${BLOCK}-effort-option--active`
        : `${BLOCK}-effort-option`;
      if (node.className !== cls) node.className = cls;
      const ticked = node.lastElementChild?.classList.contains(`${BLOCK}-current`) === true;
      const current = option.value === effort.current;
      if (current && !ticked) node.append(el('span', { class: `${BLOCK}-current`, text: '✓' }));
      if (!current && ticked) node.lastElementChild?.remove();
    });
    const active = options[effort.cursor];
    if (active && this.lastEffort?.cursor !== effort.cursor) active.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.effortKey = key;
    this.lastEffort = effort;
    return this.effortEl;
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

  private lastEffort: ModelPickerEffort | null = null;

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

/** Everything the strip shows: option order and names, the tick, the cursor. */
function effortKeyFor(effort: ModelPickerEffort | null | undefined): string {
  if (!effort) return '';
  return `${effortShapeKey(effort)}\u0002${effort.current ?? ''}\u0002${effort.cursor}`;
}

/** The options alone — a change here rebuilds the strip's spans. */
function effortShapeKey(effort: ModelPickerEffort | null | undefined): string {
  if (!effort) return '';
  return effort.options.map((option) => `${option.value}\u0000${option.name}`).join('\u0001');
}

export const def: ComponentDef = { id: 'model-picker', blocks: [BLOCK] };
