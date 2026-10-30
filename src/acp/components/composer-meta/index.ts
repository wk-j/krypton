// Spec 302 §6.2 — `ComposerMeta`.
//
// The composer's chrome row: the status chip on the left
// (`reviewing · 2:14 · 3 queued`), the lane's chips after it
// (`auto-edit`, `directive 0301-impl`), the git branch (icon + `main`), and on
// the right the `? help` hint plus whatever the composer mounts beside it (the
// dictation control). Built today by `acp-harness-view.ts:13289-13304` out of
// `harness-composer-meta.ts:48-68` (`renderStatusSegments`), `composerStatusChip`
// (`:13390-13430`), `renderSaltyBypassChip` / `renderPermissionModeChip`
// (`harness-lane-chrome.ts:346-363`), `renderDirectiveChip` (`:13359-13381`) and
// `renderComposerProjectStatus` (`:13644-13653`).
//
// **This is the only part of the composer that ticks.** The 1 Hz
// `setInterval` at `acp-harness-view.ts:13439` rebuilds the WHOLE composer just
// to advance `2:14` to `2:15`. The tick here is an ordinary `update()`: the
// elapsed clock arrives already formatted inside `segments`, so it IS a
// dependency, and a tick whose second did not change compares equal and writes
// nothing. No `tick()` method, no timer and no clock reading inside the
// component — a component that reads `Date.now()` in `readDeps()` can never be
// dep-stable, and the formatting (`formatElapsed`) is the view's, next to the
// turn's start stamp.
//
// The status segments and the lane chips are both `Chip`s: a segment is
// `<span class="acp-harness__meta-seg" data-seg="verb">`, which is exactly the
// block + text + `data` that `Chip` paints. `StatList` does not fit either run —
// its row model is label+value and its `inline` rows are deliberately unclassed,
// so it cannot emit a per-row class or a `data-seg` attribute.
//
// The chips are NOT reconciled into `.acp-harness__composer-meta` directly:
// that container also holds the status chip and the project status, and
// `reconcile()` owns every child of its container. The chip set is keyed here
// and placed with `syncOrder()` instead, which is the same node-identity
// contract over a container the component shares with itself.

import './composer-meta.css';

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { disposeList, reconcile, syncOrder } from '../../../ui/list';
import { Chip, type ChipProps } from '../chip';
import { harnessSymbolEl } from '../../harness-icons';
import type { MetaSegment } from '../../harness-composer-meta';
import type { ComponentDef } from '../types';

/** The directive chip's nested `◆ <source>` triage marker — the one chip in
 *  this row with an element inside it (`acp-harness-view.ts:13378`). */
export interface ComposerMetaChipExtra {
  /** Full class name, e.g. `acp-harness__directive-chip__triage`. */
  readonly class: string;
  readonly text: string;
  readonly title?: string;
  /** Text between the chip's own text and the marker. Default `' '`. */
  readonly separator?: string;
}

export interface ComposerMetaChipProps extends ChipProps {
  /** Identity across updates: `sandbox`, `permission-mode`, `directive`. */
  readonly key: string;
  readonly extra?: ComposerMetaChipExtra | null;
}

export interface ComposerMetaBranch {
  /** The ref alone: `main`. The branch mark is the `krypton-icon-branch`
   *  symbol, not a prefix character — `⎇` (U+2387) is in none of the fonts
   *  Krypton ships with, so it used to fall back to Apple Symbols and draw
   *  1.85 text cells wide, nothing like the footer's branch icon. */
  readonly ref: string;
  /** `<projectDir> on <branch>`; `''` keeps today's empty `title=""`. */
  readonly title: string;
}

export interface ComposerMetaProps {
  /** The status chip's segments, from `buildBusySegments` / `textSegments`. */
  readonly segments: readonly MetaSegment[];
  /** Busy lane with no flash override — `acp-harness__memory-chip--running`. */
  readonly running: boolean;
  /** Sandbox / permission-mode / directive, in paint order. */
  readonly chips: readonly ComposerMetaChipProps[];
  readonly branch: ComposerMetaBranch | null;
  /** `? help`. */
  readonly helpHint: string;
  /** Click on `[data-open-directive-picker]`. Not a dependency. */
  readonly onOpenDirective?: () => void;
}

const SEGMENT_BLOCK = 'acp-harness__meta-seg';

function chipSignature(chip: ComposerMetaChipProps): string {
  return [
    chip.key,
    chip.block,
    chip.text,
    chip.trailing ?? '',
    chip.tone ?? '',
    chip.title ?? '',
    chip.icon?.id ?? '',
    chip.icon?.cls ?? '',
    (chip.modifiers ?? []).join(' '),
    chip.data ? Object.entries(chip.data).map(([k, v]) => `${k}=${v ?? ''}`).join(',') : '',
    chip.extra?.class ?? '',
    chip.extra?.text ?? '',
    chip.extra?.title ?? '',
    chip.extra?.separator ?? '',
  ].join('\u0001');
}

/** The chip plus the nodes of its optional trailing marker. */
interface ChipEntry {
  readonly chip: Chip;
  separator: Text | null;
  marker: HTMLElement | null;
}

export class ComposerMeta extends Component<ComposerMetaProps> {
  /** `.acp-harness__composer-meta` — the left run. */
  private readonly metaEl: HTMLElement;
  /** `.acp-harness__composer-tools` — the right run. The composer mounts the
   *  dictation control here, so this component never wipes it. */
  readonly toolsEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly helpEl: HTMLElement;
  private readonly projectEl: HTMLElement;
  private readonly branchEl: HTMLElement;
  private readonly chips = new Map<string, ChipEntry>();
  private openDirective: (() => void) | undefined;

  constructor() {
    super(el('div'));
    this.statusEl = el('span');
    this.branchEl = el('span', { class: 'acp-harness__project-branch' });
    this.projectEl = el(
      'span',
      { class: 'acp-harness__project-status' },
      harnessSymbolEl('krypton-icon-branch'),
      this.branchEl,
    );
    this.metaEl = el('div', { class: 'acp-harness__composer-meta' }, this.statusEl);
    this.helpEl = el('span', { class: 'acp-harness__help-hint' });
    this.toolsEl = el('div', { class: 'acp-harness__composer-tools' }, this.helpEl);
    this.el.append(this.metaEl, this.toolsEl);
    // ONE delegated listener for the row's whole life. The handler is
    // retargeted by `update()`, never re-attached by `paint()`.
    this.bag.listen(this.el, 'click', (event: Event): void => {
      if (!this.openDirective || !(event.target instanceof Element)) return;
      if (!event.target.closest('[data-open-directive-picker]')) return;
      event.preventDefault();
      this.openDirective();
    });
  }

  update(next: ComposerMetaProps): void {
    this.openDirective = next.onOpenDirective;
    super.update(next);
  }

  protected readDeps(next: ComposerMetaProps): readonly unknown[] {
    return [
      next.segments.map((seg) => `${seg.id}\u0001${seg.text}`).join('\u0002'),
      next.running,
      next.chips.map(chipSignature).join('\u0002'),
      next.branch?.ref ?? null,
      next.branch?.title ?? null,
      next.helpHint,
    ];
  }

  protected syncClasses(next: ComposerMetaProps): void {
    this.el.className = 'acp-harness__composer-chrome';
    this.statusEl.className = classes(
      'acp-harness__memory-chip',
      next.running ? 'acp-harness__memory-chip--running' : null,
    );
  }

  protected paint(next: ComposerMetaProps): void {
    this.syncClasses(next);
    reconcile(this.statusEl, next.segments, {
      key: (seg: MetaSegment): string => seg.id,
      create: (seg: MetaSegment): Chip => {
        const chip = new Chip();
        chip.update({ block: SEGMENT_BLOCK, text: seg.text, data: { seg: seg.id } });
        return chip;
      },
      update: (chip: Chip, seg: MetaSegment): void => {
        chip.update({ block: SEGMENT_BLOCK, text: seg.text, data: { seg: seg.id } });
      },
    });

    const nodes: HTMLElement[] = [this.statusEl];
    const live = new Set<string>();
    for (const props of next.chips) {
      live.add(props.key);
      nodes.push(this.paintChip(props));
    }
    for (const [key, entry] of this.chips) {
      if (live.has(key)) continue;
      entry.chip.dispose();
      this.chips.delete(key);
    }

    if (next.branch) {
      setAttr(this.projectEl, 'title', next.branch.title);
      this.branchEl.textContent = next.branch.ref;
      nodes.push(this.projectEl);
    }
    syncOrder(this.metaEl, nodes);
    this.helpEl.textContent = next.helpHint;
  }

  /** Paint one chip and its optional marker, returning the node to place. */
  private paintChip(props: ComposerMetaChipProps): HTMLElement {
    let entry = this.chips.get(props.key);
    if (!entry) {
      entry = { chip: new Chip(), separator: null, marker: null };
      this.chips.set(props.key, entry);
    }
    entry.chip.update(props);
    const extra = props.extra ?? null;
    if (!extra) {
      entry.separator?.remove();
      entry.marker?.remove();
      entry.separator = null;
      entry.marker = null;
      return entry.chip.el;
    }
    if (!entry.separator) entry.separator = document.createTextNode('');
    if (!entry.marker) entry.marker = el('span');
    entry.separator.data = extra.separator ?? ' ';
    entry.marker.className = extra.class;
    setAttr(entry.marker, 'title', extra.title);
    entry.marker.textContent = extra.text;
    // The chip's own paint() replaces its children whenever its deps move, so
    // the marker is re-placed every pass rather than once at creation.
    if (entry.marker.previousSibling !== entry.separator || entry.marker.nextSibling !== null) {
      entry.chip.el.append(entry.separator, entry.marker);
    }
    return entry.chip.el;
  }

  protected onDispose(): void {
    disposeList(this.statusEl);
    for (const entry of this.chips.values()) entry.chip.dispose();
    this.chips.clear();
  }
}

export const def: ComponentDef = {
  id: 'composer-meta',
  blocks: [
    'acp-harness__composer-chrome',
    'acp-harness__composer-tools',
    'acp-harness__composer-meta',
    'acp-harness__memory-chip',
    'acp-harness__meta-seg',
    'acp-harness__help-hint',
    'acp-harness__project-status',
    'acp-harness__project-branch',
    'acp-harness__directive-chip',
  ],
};
