// Spec 302 §6.1 — `Composer`.
//
// The composer root: the node the view has rebuilt wholesale through
// `innerHTML` on every keystroke, every 1 Hz tick and every dictation result
// (`acp-harness-view.ts:renderComposer` / `renderDecisionComposer`).
//
// It owns three things and nothing else:
//
//   1. the root's modifiers — `--command`, `--memory`, `--dictating`,
//      `--permission` — and `--acp-lane-accent`;
//   2. the child ORDER, which is the order `renderComposer` concatenated its
//      fragments in: chrome, peer strip, live-voice strip, staging strip, the
//      four inline palettes, the input line;
//   3. the three shapes the root takes: `no lanes`, the decision row (a
//      pending permission or question owns the keyboard), and the draft.
//
// It owns NO key table (CLAUDE.md constraint 1). The palettes are driven
// through `commitPalette()`, which the view's key handlers call on their own
// commit key — `Enter`/`Tab` for `/` and `@`, `Tab` only for `#` and `{{#`.
//
// Every child is updated on every `update()`; only the ROOT's structure is
// dependency-gated. A child's own dependency tuple decides whether its update
// paints, which is what lets the 1 Hz clock tick `ComposerMeta` alone instead
// of rebuilding the whole surface — and what lets a keystroke repaint the
// draft without touching the chrome.

import './composer.css';

import { Component } from '../../../ui/component';
import { classes, el, setChildren } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { AssistStrip, type AssistStripProps } from '../assist-strip';
import { ComposerMeta, type ComposerMetaProps } from '../composer-meta';
import { DecisionComposer, type DecisionComposerProps } from '../decision-composer';
import { DictationControl, type DictationControlProps } from '../dictation-control';
import { DraftLine, type DraftLineProps } from '../draft-line';
import {
  InlinePalette,
  type InlinePaletteRow,
  type InlinePaletteVariant,
} from '../inline-palette';
import { LiveVoiceStrip, type LiveVoiceStripProps } from '../live-voice-strip';
import { PeerStrip, type PeerStripProps } from '../peer-strip';
import { StagingStrip, type StagingStripProps } from '../staging-strip';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__composer';

/**
 * One inline palette, with its item type erased to the row it paints.
 *
 * The four palettes list four unrelated things (lane names, advertised slash
 * commands, `#` built-ins, injectable verbs), and the only thing the composer
 * needs from an item is the row. The caller keeps its own array and receives
 * the committed INDEX back, which is the index into that array.
 */
export interface ComposerPaletteProps {
  readonly rows: readonly InlinePaletteRow[];
  readonly cursor: number;
  /** The meta line above the rows — the key legend, which differs per variant. */
  readonly hint: string;
  /** Meta line when `rows` is empty. Only the mention palette has one. */
  readonly zeroState?: string;
  /** Insert row `index`. Invoked by `commitPalette()` and by a row press. */
  commit?(index: number): void;
}

/** The composer with no lanes left: one text node, as the builder emits today. */
export interface ComposerEmptyProps {
  readonly kind: 'empty';
}

/** A pending permission or question owns the keyboard. */
export interface ComposerDecisionProps {
  readonly kind: 'decision';
  readonly accent: string;
  readonly liveVoice: LiveVoiceStripProps;
  readonly decision: DecisionComposerProps;
}

export interface ComposerDraftProps {
  readonly kind: 'draft';
  readonly accent: string;
  /** `focus === 'transcript'` — command mode. */
  readonly command: boolean;
  /** The memory drawer is open. */
  readonly memory: boolean;
  /** A dictation session belongs to this lane. */
  readonly dictating: boolean;
  readonly meta: ComposerMetaProps;
  /**
   * The dictation button, or `null` when the webview has no speech recognition
   * and no session is running — today's `renderControl` returns `''` there, so
   * the button is absent from the tools row rather than hidden.
   */
  readonly dictation: DictationControlProps | null;
  readonly peer: PeerStripProps;
  /** Spec 306 — the sidecar's next-prompt strip; an `idle` state hides it. */
  readonly assist: AssistStripProps;
  readonly liveVoice: LiveVoiceStripProps;
  readonly staging: StagingStripProps;
  readonly mention: ComposerPaletteProps;
  readonly slash: ComposerPaletteProps;
  readonly hash: ComposerPaletteProps;
  readonly verb: ComposerPaletteProps;
  readonly draft: DraftLineProps;
}

export type ComposerProps = ComposerEmptyProps | ComposerDecisionProps | ComposerDraftProps;

export class Composer extends Component<ComposerProps> {
  private readonly meta = new ComposerMeta();
  private readonly dictation = new DictationControl();
  private readonly peer = new PeerStrip();
  private readonly assist = new AssistStrip();
  private readonly liveVoice = new LiveVoiceStrip();
  private readonly staging = new StagingStrip();
  private readonly palettes: Record<InlinePaletteVariant, InlinePalette<InlinePaletteRow>> = {
    mention: new InlinePalette<InlinePaletteRow>(),
    slash: new InlinePalette<InlinePaletteRow>(),
    hash: new InlinePalette<InlinePaletteRow>(),
    verb: new InlinePalette<InlinePaletteRow>(),
  };
  private readonly draft = new DraftLine();
  private readonly decision = new DecisionComposer();

  constructor(root: HTMLElement = el('div', { class: BLOCK })) {
    super(root);
  }

  /**
   * Insert the highlighted row of one palette. False when that palette has
   * nothing to commit — the `matches.length === 0 → return false` bail every
   * one of the four key handlers started with.
   */
  commitPalette(variant: InlinePaletteVariant): boolean {
    return this.palettes[variant].commitSelected();
  }

  /**
   * Hand the two time-dependent rows new props without touching anything else.
   *
   * The composer's only per-second state is the elapsed clock in the chrome and
   * the `5m+` age bucket in the peer strip; both compare equal when the
   * formatted value has not moved, so a tick on a quiet second writes nothing.
   * Everything else — palettes, staging tiles, the input line — is untouched,
   * which is what replaces the 1 Hz whole-composer rebuild.
   */
  updateTick(meta: ComposerMetaProps, peer: PeerStripProps): void {
    this.meta.update(meta);
    this.peer.update(peer);
  }

  update(next: ComposerProps): void {
    this.updateChildren(next);
    super.update(next);
  }

  protected readDeps(next: ComposerProps): readonly unknown[] {
    if (next.kind === 'empty') return ['empty'];
    if (next.kind === 'decision') return ['decision', next.accent];
    return ['draft', next.accent, next.command, next.memory, next.dictating, next.dictation !== null];
  }

  protected syncClasses(next: ComposerProps): void {
    // `no lanes` deliberately leaves the class alone: the builder never wrote
    // one on that branch, so a harness whose last lane closed in command mode
    // keeps the command-mode backdrop until a lane returns.
    if (next.kind === 'empty') return;
    if (next.kind === 'decision') {
      this.el.className = classes(BLOCK, `${BLOCK}--permission`);
      return;
    }
    this.el.className = classes(
      BLOCK,
      next.command && `${BLOCK}--command`,
      next.memory && `${BLOCK}--memory`,
      next.dictating && `${BLOCK}--dictating`,
    );
  }

  protected paint(next: ComposerProps): void {
    this.syncClasses(next);
    if (next.kind === 'empty') {
      setChildren(this.el, ['no lanes']);
      return;
    }
    this.el.style.setProperty('--acp-lane-accent', next.accent);
    if (next.kind === 'decision') {
      syncOrder(this.el, [this.liveVoice.el, this.decision.el]);
      return;
    }
    if (next.dictation === null) this.dictation.el.remove();
    else if (this.dictation.el.parentNode !== this.meta.toolsEl) {
      this.meta.toolsEl.appendChild(this.dictation.el);
    }
    syncOrder(this.el, [
      this.meta.el,
      this.peer.el,
      this.assist.el,
      this.liveVoice.el,
      this.staging.el,
      this.palettes.mention.el,
      this.palettes.slash.el,
      this.palettes.hash.el,
      this.palettes.verb.el,
      this.draft.el,
    ]);
  }

  /**
   * Hand every child its props, whatever the root's own dependency tuple says.
   * A child that compares equal writes nothing; a child whose state moved
   * paints without the root being repainted at all.
   */
  private updateChildren(next: ComposerProps): void {
    if (next.kind === 'empty') return;
    if (next.kind === 'decision') {
      this.liveVoice.update(next.liveVoice);
      this.decision.update(next.decision);
      return;
    }
    this.meta.update(next.meta);
    if (next.dictation !== null) this.dictation.update(next.dictation);
    this.peer.update(next.peer);
    this.assist.update(next.assist);
    this.liveVoice.update(next.liveVoice);
    this.staging.update(next.staging);
    this.updatePalette('mention', next.mention);
    this.updatePalette('slash', next.slash);
    this.updatePalette('hash', next.hash);
    this.updatePalette('verb', next.verb);
    this.draft.update(next.draft);
  }

  private updatePalette(variant: InlinePaletteVariant, props: ComposerPaletteProps): void {
    const commit = props.commit;
    this.palettes[variant].update({
      variant,
      matches: props.rows,
      cursor: props.cursor,
      hint: props.hint,
      zeroState: props.zeroState,
      row: (row: InlinePaletteRow): InlinePaletteRow => row,
      commit: commit === undefined ? undefined : (_row, index): void => commit(index),
    });
  }

  protected onDispose(): void {
    this.meta.dispose();
    this.dictation.dispose();
    this.peer.dispose();
    this.assist.dispose();
    this.liveVoice.dispose();
    this.staging.dispose();
    for (const palette of Object.values(this.palettes)) palette.dispose();
    this.draft.dispose();
    this.decision.dispose();
  }
}

export const def: ComponentDef = { id: 'composer', blocks: [BLOCK] };
