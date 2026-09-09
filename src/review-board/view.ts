// Krypton — Review Board view (spec 211)
//
// A content window over one lane-authored review document. The human reads it in
// a guided order, jumps into the real code, annotates any block, triages
// findings, answers decisions, and sends one structured response back.
//
// Two properties drive most of the design:
//   • Blocks are addressed by ID, never by CSS selector into rendered content.
//     That is what lets a comment survive the lane rewriting the document (the
//     anchoring failure mode spec 211 was written to avoid).
//   • Every answer autosaves to `response.md` on disk. Closing the window loses
//     nothing; `s` is a separate, explicit act that hands the answers to the lane.

import { convertFileSrc } from '@tauri-apps/api/core';

import { invoke } from '../profiler/ipc';

import type {
  ContentView,
  LeaderKeyBinding,
  LeaderKeySpec,
  PaneContentType,
} from '../types';
import type {
  ReviewBlock,
  ReviewBundleFiles,
  ReviewDocument,
  ReviewResponse,
  ReviewResponseSendResult,
  ReviewSection,
} from '../acp/types';

import {
  answerableBlocks,
  parseReviewDocument,
  parseWalkthroughAnchor,
  reattachBlockId,
  sectionIndexOfBlock,
} from './parse';
import { renderBlock, type BlockAnswerState, type RenderContext } from './render';
import {
  isResponseEmpty,
  parseResponseFile,
  serializeResponseFile,
} from './response-file';
import {
  emptyAnswers,
  fromResponse,
  toResponse,
  unansweredBlocks,
  type ReviewAnswers,
} from './response';

/** No view-scoped leader keys: everything the Board does is a direct key, and the
 *  free leader slots are scarce. Declared (empty) so the conflict test covers it
 *  the moment one is added. */
export const REVIEW_BOARD_LEADER_KEYS: readonly LeaderKeySpec[] = [];

/** Debounce for the autosave write. Long enough that holding `a` down over a run
 *  of findings is one write, short enough that closing the window right after a
 *  keystroke has already saved. */
const AUTOSAVE_DEBOUNCE_MS = 400;

/** Keys that address the focused block. Inert in `overview`, which renders no
 *  authored block — acting on an off-screen one would be a silent edit. */
const BLOCK_ACTION_KEYS: ReadonlySet<string> = new Set(['a', 'x', 'c', 'Enter']);

/** Cap on a quoted selection stored with a comment. */
const QUOTE_CAP = 2000;

const REVIEW_SCROLL_LERP = 0.24;
const REVIEW_SCROLL_SNAP_PX = 0.5;

/** Advance one frame toward the current scroll target. `max` is live geometry,
 *  so a resize or content shrink cannot leave the RAF chasing an unreachable value. */
export function smoothReviewScrollStep(
  scrollTop: number,
  target: number,
  max: number,
): { scrollTop: number; target: number; done: boolean } {
  const clampedTarget = clamp(target, 0, max);
  const delta = clampedTarget - scrollTop;
  const distance = Math.abs(delta);
  if (distance <= REVIEW_SCROLL_SNAP_PX) {
    return { scrollTop: clampedTarget, target: clampedTarget, done: true };
  }

  const travel = Math.min(distance, Math.max(1, distance * REVIEW_SCROLL_LERP));
  const next = scrollTop + Math.sign(delta) * travel;
  if (Math.abs(clampedTarget - next) <= REVIEW_SCROLL_SNAP_PX) {
    return { scrollTop: clampedTarget, target: clampedTarget, done: true };
  }
  return { scrollTop: next, target: clampedTarget, done: false };
}

/** Extend repeated movement in the same direction; reverse from what is visible. */
export function nextReviewScrollTarget(
  scrollTop: number,
  activeTarget: number | null,
  delta: number,
  max: number,
): number {
  const activeDelta = activeTarget === null ? 0 : activeTarget - scrollTop;
  const continuing = activeDelta !== 0 && Math.sign(activeDelta) === Math.sign(delta);
  const base = continuing && activeTarget !== null ? activeTarget : scrollTop;
  return clamp(base + delta, 0, max);
}

/** Where a walkthrough step or an anchored finding should open. */
// ─── Chapter navigation (spec 244) ───────────────────────────────────────
// Everything below is pure: the Board's navigation rules are decided here and
// only applied to the DOM by the class, so they are testable without a webview.

/** Which blocks the body is showing. `overview` shows none of them — it is a
 *  summary surface that renders no authored block, so it can reorder nothing. */
export type ReviewViewMode = 'overview' | 'section' | 'document' | 'open';

export type ReviewMapRow =
  | { kind: 'overview' }
  | { kind: 'section'; index: number }
  | { kind: 'open' }
  | { kind: 'document' };

/** Map rows top to bottom: Overview, the authored chapters, then the two
 *  cross-document views. */
export function reviewMapRows(sectionCount: number): ReviewMapRow[] {
  const rows: ReviewMapRow[] = [{ kind: 'overview' }];
  for (let i = 0; i < sectionCount; i++) rows.push({ kind: 'section', index: i });
  rows.push({ kind: 'open' }, { kind: 'document' });
  return rows;
}

/** Global block indices the body renders, in document order. */
export function visibleBlockIndices(opts: {
  mode: ReviewViewMode;
  blockCount: number;
  section: { startBlock: number; endBlock: number } | null;
  openIndices: readonly number[];
}): number[] {
  const all = (): number[] => Array.from({ length: opts.blockCount }, (_, i) => i);
  switch (opts.mode) {
    case 'overview':
      return [];
    case 'document':
      return all();
    case 'open':
      return [...opts.openIndices];
    case 'section': {
      if (!opts.section) return all();
      const out: number[] = [];
      for (let i = opts.section.startBlock; i < Math.min(opts.section.endBlock, opts.blockCount); i++) {
        out.push(i);
      }
      return out;
    }
  }
}

/** Where `n` / `N` lands. At a chapter edge in section mode the move becomes a
 *  chapter step rather than a dead end, so continuous reading stays one key. */
export function stepVisibleCursor(
  visible: readonly number[],
  cursor: number,
  delta: number,
  allowChapterEdge: boolean,
): { block: number | null; section: -1 | 0 | 1 } {
  if (visible.length === 0) return { block: null, section: 0 };
  const at = visible.indexOf(cursor);
  // Cursor outside the visible set (a chapter switch just happened): enter from
  // the end the move came from rather than refusing it.
  if (at === -1) return { block: delta > 0 ? visible[0] : visible[visible.length - 1], section: 0 };
  const next = at + delta;
  if (next >= 0 && next < visible.length) return { block: visible[next], section: 0 };
  if (!allowChapterEdge) return { block: null, section: 0 };
  return { block: null, section: delta > 0 ? 1 : -1 };
}

/** Cursor for a chapter the reader just opened: its first unanswered block, else
 *  its first block. */
export function sectionEntryBlock(
  section: { startBlock: number; endBlock: number },
  openIndices: readonly number[],
): number {
  const open = openIndices.find((i) => i >= section.startBlock && i < section.endBlock);
  return open ?? section.startBlock;
}

/** After an answer removes the current item from `Open items`: the next item,
 *  else the previous one. `null` when nothing is left to answer. */
export function reconcileOpenCursor(visible: readonly number[], cursor: number): number | null {
  if (visible.length === 0) return null;
  return visible.find((i) => i >= cursor) ?? visible[visible.length - 1];
}

export interface ReviewJumpTarget {
  path: string;
  line?: number;
}

/** Channel for sending the human's response to the authoring lane (spec 211).
 *  Resolved on demand, the same broker pattern as the Diff Window's review
 *  channel — the Board stays decoupled from the harness. */
export interface ReviewSendChannel {
  send: (payload: {
    reviewId: string;
    dir: string;
    title: string;
    target: string;
    batchId: string;
    response: ReviewResponse;
    blockLabels: Record<string, string>;
  }) => Promise<ReviewResponseSendResult>;
}

export interface ReviewBoardOptions {
  /** Absolute bundle directory. The durable id and the write target. */
  dir: string;
  slug: string;
  /** Lane that authored it, for the header and the send target. */
  laneName?: string;
  /** Repo root, for resolving relative image sources and jump anchors. */
  cwd?: string;
  /** Open a `file:line` in the Diff Window (or a reader when there is no diff). */
  jump?: (target: ReviewJumpTarget) => void;
  /** Deliver the response to the authoring lane. Absent when no harness backs it. */
  review?: ReviewSendChannel;
}

type Overlay = 'none' | 'comment' | 'send';

/** Pane width at which the Review Map stops being an overlay and becomes a
 *  permanent column. 860px of reading column + 272px of map + gutters. */
export const REVIEW_MAP_WIDE_MIN_PX = 1180;

export class ReviewBoardView implements ContentView {
  readonly type: PaneContentType = 'review';
  readonly element: HTMLElement;

  private readonly dir: string;
  private readonly slug: string;
  private readonly cwd: string;
  private readonly jumpTo: ((target: ReviewJumpTarget) => void) | null;
  private readonly review: ReviewSendChannel | null;

  private doc: ReviewDocument = { title: null, laneName: null, subject: null, blocks: [], sections: [] };
  private answers: ReviewAnswers = emptyAnswers();
  private laneName: string;

  /** Index into `doc.blocks`; -1 when the document is empty. */
  private cursor = -1;
  /** Flat list of every walkthrough step, in document order, for `Tab`. */
  private steps: { blockId: string; index: number; at: string; say: string }[] = [];
  private stepCursor = -1;
  /** Diff blocks the human expanded past the summary threshold. */
  private expandedDiffs = new Set<string>();

  /** Which blocks the body shows (spec 244). Presentation only — never written
   *  to `response.md` and never persisted across a restart. */
  private viewMode: ReviewViewMode = 'section';
  private sectionIndex = 0;
  /** Review Map keyboard state. `mapFocused` is a focus mode, not a view. */
  private mapFocused = false;
  private mapIndex = 0;
  /** Narrow panes hide the map until `o` reveals it. */
  private mapRevealed = false;
  private wide = true;

  private overlay: Overlay = 'none';
  private overlayEl: HTMLElement | null = null;
  private commentInput: HTMLTextAreaElement | null = null;
  private commentQuote = '';
  private commentBlockId: string | null = null;
  private noteInput: HTMLTextAreaElement | null = null;

  private saveTimer: number | null = null;
  private saveState: 'saved' | 'saving' | 'error' = 'saved';
  private sending = false;
  private banner: string | null = null;
  private sentAt: number | undefined;
  private lastSyncAt = 0;
  /** `respondedAt` we last wrote, so a newer value on disk means another Board. */
  private ownRespondedAt = 0;

  // In-doc search (inherited behaviour from the Markdown Viewer, spec 137).
  private searchActive = false;
  private searchHud: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchMatches: HTMLElement[] = [];
  private searchIndex = -1;
  private searchDebounce: number | null = null;
  /** View to restore when search closes with no match (spec 244). */
  private searchReturn: { mode: ReviewViewMode; sectionIndex: number; cursor: number } | null = null;
  private static readonly SEARCH_MATCH_CAP = 500;

  private header: HTMLElement;
  private content: HTMLElement;
  private map: HTMLElement;
  private body: HTMLElement;
  private resizeObs: ResizeObserver | null = null;
  private closeCallback: (() => void) | null = null;
  private disposeListeners: (() => void)[] = [];
  private bodyScrollRaf = 0;
  private bodyScrollTarget: number | null = null;

  constructor(container: HTMLElement, private options: ReviewBoardOptions) {
    this.dir = options.dir;
    this.slug = options.slug;
    this.cwd = options.cwd ?? '.';
    this.jumpTo = options.jump ?? null;
    this.review = options.review ?? null;
    this.laneName = options.laneName ?? '—';

    this.element = document.createElement('div');
    this.element.className = 'krypton-review';
    this.element.tabIndex = 0;
    container.appendChild(this.element);

    this.header = document.createElement('div');
    this.header.className = 'krypton-review__header';
    this.element.appendChild(this.header);

    this.content = document.createElement('div');
    this.content.className = 'krypton-review__content';
    this.element.appendChild(this.content);

    this.map = document.createElement('aside');
    this.map.className = 'krypton-review__map';
    this.content.appendChild(this.map);

    this.body = document.createElement('div');
    this.body.className = 'krypton-review__body';
    this.body.addEventListener('wheel', this.cancelBodyScrollOnUserInput, { passive: true });
    this.body.addEventListener('pointerdown', this.cancelBodyScrollOnUserInput);
    this.content.appendChild(this.body);

    // Clicking a block moves the cursor there, so the mouse is never a dead end
    // even though the whole surface is designed for the keyboard.
    this.body.addEventListener('click', (e) => {
      const block = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]');
      if (!block) return;
      const index = this.doc.blocks.findIndex((b) => b.id === block.dataset.blockId);
      if (index >= 0) this.setCursor(index);
    });

    // Pointer activation of a map row, so the map is not keyboard-only either.
    this.map.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-map-row]');
      if (!row) return;
      const index = Number(row.dataset.mapRow);
      if (!Number.isNaN(index)) this.activateMapRow(index);
    });

    // `ContentView.onResize` is declared but never called by the compositor, so
    // the layout switch has to observe its own pane (spec 244).
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? this.element.clientWidth;
        this.applyLayout(width);
      });
      this.resizeObs.observe(this.element);
    }
    this.element.dataset.layout = 'wide';

    void this.load();
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  addDisposeListener(cb: () => void): void {
    this.disposeListeners.push(cb);
  }

  getWorkingDirectory(): string | null {
    return this.options.cwd ?? null;
  }

  getLeaderKeyBindings(): LeaderKeyBinding[] {
    return [];
  }

  /** Bundle slug — the durable id, so the compositor can de-dupe open Boards. */
  bundleSlug(): string {
    return this.slug;
  }

  // ─── Loading and refresh ────────────────────────────────────────────────

  /** Read the bundle off disk, re-attach answers by block id, and render. */
  private async load(preserveCursor = false): Promise<void> {
    let files: ReviewBundleFiles;
    try {
      files = await invoke<ReviewBundleFiles>('read_review_bundle', { dir: this.dir });
    } catch (e) {
      this.banner = `bundle unavailable — ${errorText(e)}`;
      this.render();
      return;
    }

    const priorCursorId = preserveCursor ? this.doc.blocks[this.cursor]?.id ?? null : null;
    const priorStepKey = preserveCursor ? this.steps[this.stepCursor] ?? null : null;

    this.cancelBodyScroll();
    this.doc = parseReviewDocument(files.review);
    if (this.doc.laneName) this.laneName = this.doc.laneName;
    this.rebuildSteps();

    // Restore answers. On first load they come from disk; on refresh the in-memory
    // answers win, because the human may have answered since the last save and a
    // debounced write could still be pending.
    const restoreFrom = preserveCursor
      ? toResponse(this.slug, this.answers, this.doc.blocks, this.sentAt)
      : this.readResponse(files.response);
    const { answers, dropped } = fromResponse(restoreFrom, this.doc.blocks, (id) =>
      reattachBlockId(id, this.doc.blocks),
    );
    this.answers = answers;
    this.sentAt = restoreFrom.sentAt;
    if (dropped > 0) {
      this.banner = `${dropped} answer${dropped === 1 ? '' : 's'} dropped — their block${
        dropped === 1 ? ' is' : 's are'
      } no longer in the document`;
    }

    // Restore the cursor by ID, so a refresh that shifted every ordinal keeps the
    // human where they were reading.
    if (priorCursorId) {
      const resolved = reattachBlockId(priorCursorId, this.doc.blocks);
      const index = resolved ? this.doc.blocks.findIndex((b) => b.id === resolved) : -1;
      this.cursor = index >= 0 ? index : Math.min(this.cursor, this.doc.blocks.length - 1);
    } else {
      // First open: start at the first unanswered finding/decision, else block 1.
      const first = unansweredBlocks(this.doc.blocks, this.answers)[0];
      this.cursor = first
        ? this.doc.blocks.indexOf(first)
        : this.doc.blocks.length > 0
          ? 0
          : -1;
    }
    if (priorStepKey) {
      this.stepCursor = this.steps.findIndex(
        (s) => s.at === priorStepKey.at && s.say === priorStepKey.say,
      );
    }

    // Chapters are re-derived on every parse, so recover the reader's chapter
    // from the restored block cursor rather than from a section id — a renamed
    // heading must not cost them their place (spec 244).
    this.sectionIndex = sectionIndexOfBlock(this.doc.sections, Math.max(0, this.cursor));

    this.lastSyncAt = Date.now();
    this.render();
  }

  /** Parse `response.md`, backing up a frontmatter we cannot read at all rather
   *  than silently overwriting what may have been a meaningful hand-edit. */
  private readResponse(source: string | undefined): ReviewResponse {
    if (!source) return { reviewId: this.slug, comments: [], findings: [], decisions: [] };
    const parsed = parseResponseFile(source, this.slug);
    if (parsed.unparseable) {
      // Move it aside NOW, before the first autosave can overwrite it — a bad
      // hand-edit must never block the review, and must never be lost either.
      this.banner = 'response.md could not be read — moved to response.md.bak, starting fresh';
      void invoke('backup_review_response', { dir: this.dir }).catch(() => undefined);
    } else if (parsed.skipped > 0) {
      this.banner = `${parsed.skipped} malformed entr${
        parsed.skipped === 1 ? 'y' : 'ies'
      } in response.md were skipped`;
    }
    return parsed.response;
  }

  /** Re-read the file now (ADR-0008: lane quiet points + a manual `r`). */
  requestRefresh(): void {
    void this.load(true);
  }

  private rebuildSteps(): void {
    this.steps = [];
    for (const block of this.doc.blocks) {
      if (block.kind !== 'walkthrough') continue;
      block.data.steps.forEach((step, index) => {
        this.steps.push({ blockId: block.id, index, at: step.at, say: step.say });
      });
    }
    if (this.stepCursor >= this.steps.length) this.stepCursor = this.steps.length - 1;
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  private renderContext(): RenderContext {
    return {
      answerOf: (blockId) => this.answerStateOf(blockId),
      resolveImageSrc: (src) => this.resolveImageSrc(src),
      isDiffExpanded: (blockId) => this.expandedDiffs.has(blockId),
    };
  }

  private answerStateOf(blockId: string): BlockAnswerState {
    return {
      findingState: this.answers.findings.get(blockId) ?? null,
      chosen: this.answers.decisions.get(blockId) ?? null,
      commentCount: this.answers.comments.filter((c) => c.blockId === blockId).length,
    };
  }

  /** Resolve a relative image src against the bundle so it loads in the webview
   *  (raw `file://` is blocked cross-origin). */
  private resolveImageSrc(src: string): string {
    if (/^(https?:|data:|asset:|blob:)/i.test(src) || src.startsWith('//')) return src;
    const clean = src.replace(/[?#].*$/, '');
    if (!clean) return src;
    const base = clean.startsWith('/') ? this.cwd : this.dir;
    const parts: string[] = [];
    for (const seg of `${base}/${clean.replace(/^\//, '')}`.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    return convertFileSrc(`/${parts.join('/')}`);
  }

  /** Full rebuild. Cursor movement inside one chapter deliberately does NOT come
   *  through here — see `setCursor()`. */
  private render(): void {
    this.renderHeader();
    this.renderBody();
    this.renderMap();
    this.renderOverlay();
  }

  private renderHeader(): void {
    this.header.innerHTML = '';
    const seg = (className: string, text: string): HTMLElement => {
      const el = document.createElement('span');
      el.className = `krypton-review__seg ${className}`;
      el.textContent = text;
      return el;
    };

    const title = this.doc.title ?? this.slug;
    this.header.appendChild(seg('krypton-review__seg--title', `REVIEW // ${title}`));
    this.header.appendChild(seg('krypton-review__seg--lane', this.laneName));
    this.header.appendChild(seg('krypton-review__seg--slug', this.slug));

    if (this.doc.blocks.length > 0) {
      this.header.appendChild(seg('krypton-review__seg--pos', this.positionLabel()));
    }
    // Search renders the whole document temporarily; say so rather than letting
    // the chapter appear to vanish.
    if (this.searchActive) {
      this.header.appendChild(seg('krypton-review__seg--search', 'search · full document'));
    }
    if (this.steps.length > 0) {
      const at = this.stepCursor >= 0 ? `${this.stepCursor + 1}/` : '';
      this.header.appendChild(seg('krypton-review__seg--steps', `step ${at}${this.steps.length}`));
    }

    // A Board with nothing to answer is `reference`, not "0 unanswered": it is an
    // explanation to come back to, not a task. Never a score (ADR-0004).
    const answerable = answerableBlocks(this.doc.blocks).length;
    if (answerable === 0) {
      this.header.appendChild(seg('krypton-review__seg--reference', 'reference'));
    } else {
      const open = unansweredBlocks(this.doc.blocks, this.answers).length;
      const el = seg(
        open > 0 ? 'krypton-review__seg--open' : 'krypton-review__seg--done',
        open > 0 ? `${open} unanswered` : 'all answered',
      );
      this.header.appendChild(el);
    }

    this.header.appendChild(seg('krypton-review__seg--save', this.saveLabel()));
    this.header.appendChild(seg('krypton-review__seg--sync', this.syncLabel()));
  }

  /** Chapter + block position, in the terms of the current view. */
  private positionLabel(): string {
    const total = this.doc.blocks.length;
    if (this.viewMode === 'overview') return 'overview';
    if (this.viewMode === 'open') {
      const visible = this.openIndices();
      const at = visible.indexOf(this.cursor);
      return `open items · block ${at + 1 || 0}/${visible.length}`;
    }
    if (this.viewMode === 'document' || this.doc.sections.length === 0) {
      return `block ${this.cursor + 1}/${total}`;
    }
    return `chapter ${this.sectionIndex + 1}/${this.doc.sections.length} · block ${this.cursor + 1}/${total}`;
  }

  private saveLabel(): string {
    if (this.saveState === 'error') return 'save failed';
    if (this.saveState === 'saving') return 'saving…';
    if (isResponseEmpty(toResponse(this.slug, this.answers, this.doc.blocks))) return 'no answers';
    return this.sentAt !== undefined ? 'sent' : 'saved · not sent yet';
  }

  private syncLabel(): string {
    if (this.lastSyncAt === 0) return 'loading…';
    const age = Math.max(0, Math.round((Date.now() - this.lastSyncAt) / 1000));
    if (age < 5) return 'synced just now';
    if (age < 90) return `synced ${age}s ago`;
    return `synced ${Math.round(age / 60)}m ago`;
  }

  private renderBody(): void {
    this.body.innerHTML = '';

    if (this.banner) {
      const banner = document.createElement('div');
      banner.className = 'krypton-review__banner';
      banner.textContent = this.banner;
      this.body.appendChild(banner);
    }

    if (this.doc.blocks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'krypton-review__empty';
      empty.textContent = 'no blocks yet — the lane is still composing';
      this.body.appendChild(empty);
      return;
    }

    if (this.viewMode === 'overview') {
      this.renderOverview();
      return;
    }

    const visible = this.visibleIndices();
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'krypton-review__empty';
      empty.textContent =
        this.viewMode !== 'open'
          ? 'this chapter is empty'
          : answerableBlocks(this.doc.blocks).length === 0
            ? 'nothing to answer — this Board is a reference'
            : 'everything is answered';
      this.body.appendChild(empty);
      return;
    }

    const ctx = this.renderContext();
    for (const index of visible) {
      const block = this.doc.blocks[index];
      const el = renderBlock(block, ctx);
      if (index === this.cursor) el.classList.add('krypton-review__block--cursor');
      // Only mark the walkthrough step the guided read is on.
      if (block.kind === 'walkthrough') this.markCurrentStep(el, block.id);
      this.body.appendChild(el);
    }

    const cursorEl = this.body.querySelector('.krypton-review__block--cursor');
    this.scrollElementIntoView(cursorEl, 'nearest');
  }

  // ─── Chapters, Review Map, Overview (spec 244) ──────────────────────────

  /** Findings and decisions with nothing recorded, as block indices. */
  private openIndices(): number[] {
    const open = new Set(unansweredBlocks(this.doc.blocks, this.answers).map((b) => b.id));
    const out: number[] = [];
    this.doc.blocks.forEach((b, i) => {
      if (open.has(b.id)) out.push(i);
    });
    return out;
  }

  private activeSection(): ReviewSection | null {
    return this.doc.sections[this.sectionIndex] ?? null;
  }

  private visibleIndices(): number[] {
    return visibleBlockIndices({
      mode: this.viewMode,
      blockCount: this.doc.blocks.length,
      section: this.activeSection(),
      openIndices: this.openIndices(),
    });
  }

  private renderMap(): void {
    this.map.innerHTML = '';
    this.map.dataset.state = this.wide || this.mapRevealed ? 'open' : 'hidden';
    this.map.classList.toggle('krypton-review__map--focused', this.mapFocused);
    if (this.map.dataset.state === 'hidden') return;

    const openIndices = this.openIndices();
    const answerable = answerableBlocks(this.doc.blocks).length;

    const head = document.createElement('div');
    head.className = 'krypton-review__map-head';
    head.append(
      span('krypton-review__map-count', `${this.doc.blocks.length} blocks`),
      span('krypton-review__map-count', `${answerable} answerable`),
      span(
        openIndices.length > 0
          ? 'krypton-review__map-count krypton-review__map-count--open'
          : 'krypton-review__map-count',
        answerable === 0 ? 'reference' : `${openIndices.length} unanswered`,
      ),
    );
    this.map.appendChild(head);

    const rows = reviewMapRows(this.doc.sections.length);
    const list = document.createElement('div');
    list.className = 'krypton-review__map-rows';
    rows.forEach((row, index) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'krypton-review__map-row';
      el.dataset.mapRow = String(index);
      if (this.mapFocused && index === this.mapIndex) {
        el.classList.add('krypton-review__map-row--selected');
      }
      if (this.isActiveRow(row)) {
        el.classList.add('krypton-review__map-row--active');
        el.setAttribute('aria-current', 'page');
      }
      if (row.kind === 'section') {
        const section = this.doc.sections[row.index];
        const open = openIndices.filter(
          (i) => i >= section.startBlock && i < section.endBlock,
        ).length;
        el.dataset.depth = String(section.depth);
        el.append(
          span('krypton-review__map-index', String(row.index + 1)),
          span('krypton-review__map-label', section.title),
          span('krypton-review__map-blocks', String(section.endBlock - section.startBlock)),
        );
        if (open > 0) el.appendChild(span('krypton-review__map-open', String(open)));
      } else {
        el.classList.add('krypton-review__map-row--smart');
        const label =
          row.kind === 'overview'
            ? 'Overview'
            : row.kind === 'open'
              ? 'Open items'
              : 'Full document';
        el.append(span('krypton-review__map-label', label));
        if (row.kind === 'open' && openIndices.length > 0) {
          el.appendChild(span('krypton-review__map-open', String(openIndices.length)));
        }
        if (row.kind === 'document') {
          el.appendChild(span('krypton-review__map-blocks', String(this.doc.blocks.length)));
        }
      }
      list.appendChild(el);
    });
    this.map.appendChild(list);

    const foot = document.createElement('div');
    foot.className = 'krypton-review__map-foot';
    foot.textContent = this.mapFocused
      ? 'j/k move · Enter open · Esc back'
      : 'o map · [ ] chapter · O overview';
    this.map.appendChild(foot);

    list
      .querySelector('.krypton-review__map-row--selected')
      ?.scrollIntoView({ block: 'nearest' });
  }

  private isActiveRow(row: ReviewMapRow): boolean {
    if (row.kind === 'section') {
      return this.viewMode === 'section' && row.index === this.sectionIndex;
    }
    return this.viewMode === row.kind;
  }

  /**
   * `Overview` — a read-only landing surface. It renders NO authored block, so it
   * cannot reorder or hide what the lane wrote, and it reports raw counts only:
   * never a percentage, bar, or grade (the same rule the header follows, ADR-0004).
   */
  private renderOverview(): void {
    const root = document.createElement('div');
    root.className = 'krypton-review__overview';

    const identity = document.createElement('div');
    identity.className = 'krypton-review__overview-identity';
    identity.appendChild(span('krypton-review__overview-title', this.doc.title ?? this.slug));
    if (this.doc.subject) {
      identity.appendChild(span('krypton-review__overview-subject', this.doc.subject));
    }
    identity.appendChild(span('krypton-review__overview-meta', `${this.laneName} · ${this.slug}`));
    root.appendChild(identity);

    const answerable = answerableBlocks(this.doc.blocks);
    const openBlocks = unansweredBlocks(this.doc.blocks, this.answers);
    if (answerable.length === 0) {
      root.appendChild(
        // Not "0 unanswered": a Board with nothing to answer is an explanation
        // to come back to, not a task list (ADR-0004).
        this.overviewSection('work remaining', [['nothing to answer', 'reference']]),
      );
    } else {
      const severity = (level: string): number =>
        openBlocks.filter((b) => b.kind === 'finding' && b.data.severity === level).length;
      const rows: [string, string][] = [
        ['blocking findings', String(severity('blocking'))],
        ['non-blocking findings', String(severity('non-blocking'))],
        ['suggestions', String(severity('suggestion'))],
        ['decisions', String(openBlocks.filter((b) => b.kind === 'decision').length)],
      ];
      root.appendChild(this.overviewSection('open work', rows));
    }

    if (this.doc.sections.length > 0) {
      const openIndices = this.openIndices();
      const rows: [string, string][] = this.doc.sections.map((section, i) => {
        const open = openIndices.filter(
          (n) => n >= section.startBlock && n < section.endBlock,
        ).length;
        const blocks = section.endBlock - section.startBlock;
        return [
          `${i + 1}. ${section.title}`,
          open > 0 ? `${blocks} blocks · ${open} open` : `${blocks} blocks`,
        ];
      });
      root.appendChild(this.overviewSection('chapters', rows));
    }

    const tail: [string, string][] = [];
    if (this.steps.length > 0) {
      tail.push(['walkthrough', `${this.steps.length} steps · Tab to start the guided read`]);
    }
    const at = this.doc.blocks[this.cursor];
    if (at) {
      const section = this.doc.sections[sectionIndexOfBlock(this.doc.sections, this.cursor)];
      tail.push([
        'resume at',
        section
          ? `block ${this.cursor + 1} · ${section.title}`
          : `block ${this.cursor + 1}`,
      ]);
    }
    if (tail.length > 0) root.appendChild(this.overviewSection('reading', tail));

    this.body.appendChild(root);
  }

  private overviewSection(title: string, rows: readonly (readonly [string, string])[]): HTMLElement {
    const el = document.createElement('section');
    el.className = 'krypton-review__overview-group';
    el.appendChild(span('krypton-review__overview-heading', title));
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'krypton-review__overview-row';
      row.append(
        span('krypton-review__overview-label', label),
        span('krypton-review__overview-value', value),
      );
      el.appendChild(row);
    }
    return el;
  }

  private markCurrentStep(blockEl: HTMLElement, blockId: string): void {
    const current = this.steps[this.stepCursor];
    if (!current || current.blockId !== blockId) return;
    const item = blockEl.querySelector<HTMLElement>(
      `.krypton-review__step[data-step-index="${current.index}"]`,
    );
    item?.classList.add('krypton-review__step--current');
  }

  // ─── Cursor movement ────────────────────────────────────────────────────

  private readonly cancelBodyScrollOnUserInput = (): void => {
    this.cancelBodyScroll();
  };

  private cancelBodyScroll(): void {
    if (this.bodyScrollRaf !== 0) {
      window.cancelAnimationFrame(this.bodyScrollRaf);
      this.bodyScrollRaf = 0;
    }
    this.bodyScrollTarget = null;
  }

  private scrollBodyBy(delta: number): void {
    const max = Math.max(0, this.body.scrollHeight - this.body.clientHeight);
    const target = nextReviewScrollTarget(
      this.body.scrollTop,
      this.bodyScrollTarget,
      delta,
      max,
    );
    this.scrollBodyTo(target);
  }

  private scrollBodyTo(target: number): void {
    const max = Math.max(0, this.body.scrollHeight - this.body.clientHeight);
    const clampedTarget = clamp(target, 0, max);
    if (Math.abs(clampedTarget - this.body.scrollTop) <= REVIEW_SCROLL_SNAP_PX) {
      this.cancelBodyScroll();
      this.body.scrollTop = clampedTarget;
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.cancelBodyScroll();
      this.body.scrollTop = clampedTarget;
      return;
    }

    this.bodyScrollTarget = clampedTarget;
    if (this.bodyScrollRaf !== 0) return;

    const step = (): void => {
      this.bodyScrollRaf = 0;
      if (this.bodyScrollTarget === null) return;

      const liveMax = Math.max(0, this.body.scrollHeight - this.body.clientHeight);
      const next = smoothReviewScrollStep(
        this.body.scrollTop,
        this.bodyScrollTarget,
        liveMax,
      );
      this.bodyScrollTarget = next.target;
      this.body.scrollTop = next.scrollTop;
      if (next.done) {
        this.bodyScrollTarget = null;
        return;
      }
      this.bodyScrollRaf = window.requestAnimationFrame(step);
    };
    this.bodyScrollRaf = window.requestAnimationFrame(step);
  }

  private scrollElementIntoView(
    target: Element | null,
    block: 'nearest' | 'center',
  ): void {
    if (!target) return;
    const containerRect = this.body.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = targetRect.top - containerRect.top + this.body.scrollTop;
    let top = targetTop;

    if (block === 'center') {
      top -= (this.body.clientHeight - targetRect.height) / 2;
    } else {
      const targetBottom = targetTop + targetRect.height;
      const visibleBottom = this.body.scrollTop + this.body.clientHeight;
      if (targetTop >= this.body.scrollTop && targetBottom <= visibleBottom) {
        top = this.body.scrollTop;
      } else if (targetBottom > visibleBottom) {
        top = targetBottom - this.body.clientHeight;
      }
    }

    this.scrollBodyTo(top);
  }

  /**
   * Put the cursor on a global block index. When that block is already rendered
   * this only moves a class — the whole point of splitting the render paths, so
   * `n` / `N` never rebuild a document (spec 244).
   */
  private setCursor(index: number, scroll: 'center' | 'nearest' = 'nearest'): void {
    if (index < 0 || index >= this.doc.blocks.length) return;
    this.cursor = index;
    let el = this.blockEl(index);
    if (el) {
      this.body
        .querySelector('.krypton-review__block--cursor')
        ?.classList.remove('krypton-review__block--cursor');
      el.classList.add('krypton-review__block--cursor');
      this.renderHeader();
    } else {
      // Not on screen. In section mode the block lives in another chapter; in
      // Overview or Open items it is filtered out entirely. Either way the fix
      // is the same — reveal it in its own chapter. `Full document` already
      // shows everything, so it never lands here.
      if (this.viewMode !== 'document') {
        this.viewMode = 'section';
        this.sectionIndex = sectionIndexOfBlock(this.doc.sections, index);
      }
      this.cancelBodyScroll();
      this.renderHeader();
      this.renderBody();
      this.renderMap();
      el = this.blockEl(index);
    }
    this.scrollElementIntoView(el, scroll);
  }

  private blockEl(index: number): HTMLElement | null {
    const id = this.doc.blocks[index]?.id;
    if (!id) return null;
    return this.body.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
  }

  /** `n` / `N` — next/previous VISIBLE block, continuing into the adjacent
   *  chapter at a section edge rather than dead-ending there. */
  private moveCursor(delta: number): void {
    if (this.doc.blocks.length === 0) return;
    const step = stepVisibleCursor(
      this.visibleIndices(),
      this.cursor,
      delta,
      this.viewMode === 'section',
    );
    if (step.block !== null) {
      this.setCursor(step.block);
      return;
    }
    if (step.section === 0) return;
    const target = this.sectionIndex + step.section;
    const section = this.doc.sections[target];
    if (!section) return; // ends of the document still stop
    this.gotoSection(target, step.section > 0 ? section.startBlock : section.endBlock - 1);
  }

  /** Open a chapter. Entry block defaults to its first unanswered block. */
  private gotoSection(index: number, block?: number): void {
    const section = this.doc.sections[index];
    if (!section) return;
    this.cancelBodyScroll();
    this.viewMode = 'section';
    this.sectionIndex = index;
    this.cursor = block ?? sectionEntryBlock(section, this.openIndices());
    // A new chapter starts at its top; `render()` then reveals the entry block if
    // it happens to sit below the fold. Doing it in this order means the reader
    // never lands mid-chapter with a cursor they cannot see.
    this.body.scrollTop = 0;
    this.render();
  }

  /** `[` / `]` — adjacent chapter, stopping at the ends. */
  private stepSection(delta: number): void {
    if (this.doc.sections.length === 0) return;
    if (this.viewMode !== 'section') {
      this.gotoSection(clamp(this.sectionIndex, 0, this.doc.sections.length - 1));
      return;
    }
    const next = this.sectionIndex + delta;
    if (next < 0 || next >= this.doc.sections.length) {
      this.flash(delta > 0 ? 'last chapter' : 'first chapter');
      return;
    }
    this.gotoSection(next);
  }

  /** Switch which blocks the body shows. Presentation only — never touches an
   *  answer, and never persists. */
  private setViewMode(mode: ReviewViewMode): void {
    this.cancelBodyScroll();
    this.viewMode = mode;
    if (mode === 'section') {
      this.sectionIndex = sectionIndexOfBlock(this.doc.sections, Math.max(0, this.cursor));
    } else if (mode === 'open') {
      const open = this.openIndices();
      if (open.length > 0) this.cursor = reconcileOpenCursor(open, this.cursor) ?? open[0];
    }
    this.body.scrollTop = 0;
    this.render();
  }

  /** `Escape` backs out one level: a non-section view returns to the chapter the
   *  cursor is in, and only section mode closes the Board. `q` still closes from
   *  anywhere, so the one-key exit is never lost. */
  private backOut(): boolean {
    if (this.viewMode === 'section') return false;
    this.setViewMode('section');
    return true;
  }

  // ─── Review Map focus ───────────────────────────────────────────────────

  private openMap(): void {
    if (this.doc.sections.length === 0 && this.doc.blocks.length === 0) return;
    if (!this.wide) this.mapRevealed = true;
    this.mapFocused = true;
    this.mapIndex = reviewMapRows(this.doc.sections.length).findIndex((row) =>
      this.isActiveRow(row),
    );
    if (this.mapIndex < 0) this.mapIndex = 0;
    this.renderMap();
  }

  private closeMap(): void {
    this.mapFocused = false;
    this.mapRevealed = false;
    this.renderMap();
    this.element.focus();
  }

  private activateMapRow(index: number): void {
    const row = reviewMapRows(this.doc.sections.length)[index];
    if (!row) return;
    this.mapIndex = index;
    if (row.kind === 'section') this.gotoSection(row.index);
    else this.setViewMode(row.kind);
    // A narrow overlay closes on selection; a persistent map stays put but hands
    // the keyboard back to the reading column.
    this.mapFocused = false;
    this.mapRevealed = false;
    this.renderMap();
    this.element.focus();
  }

  private onMapKey(e: KeyboardEvent): boolean {
    const rows = reviewMapRows(this.doc.sections.length);
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        this.mapIndex = clamp(this.mapIndex + 1, 0, rows.length - 1);
        this.renderMap();
        return true;
      case 'k':
      case 'ArrowUp':
        this.mapIndex = clamp(this.mapIndex - 1, 0, rows.length - 1);
        this.renderMap();
        return true;
      case 'g':
        this.mapIndex = e.shiftKey ? rows.length - 1 : 0;
        this.renderMap();
        return true;
      case 'Enter':
        this.activateMapRow(this.mapIndex);
        return true;
      case 'o':
      case 'q':
      case 'Escape':
        this.closeMap();
        return true;
      default:
        return false;
    }
  }

  /** Pane width decides whether the map is a column or an overlay. Three tiers,
   *  because the header also sheds segments as the pane narrows. */
  private applyLayout(width: number): void {
    const wide = width >= REVIEW_MAP_WIDE_MIN_PX;
    this.element.dataset.layout = wide ? 'wide' : width >= 760 ? 'narrow' : 'tight';
    if (wide === this.wide) return;
    this.wide = wide;
    // Crossing the threshold must not strand map focus or a floating overlay.
    this.mapFocused = false;
    this.mapRevealed = false;
    this.renderMap();
  }

  /** `}` / `{` — jump between findings and decisions with nothing recorded. */
  private moveToUnanswered(delta: number): void {
    const open = unansweredBlocks(this.doc.blocks, this.answers);
    if (open.length === 0) {
      this.flash(
        answerableBlocks(this.doc.blocks).length === 0
          ? 'nothing to answer — this Board is a reference'
          : 'everything is answered',
      );
      return;
    }
    const indices = open.map((b) => this.doc.blocks.indexOf(b));
    const next =
      delta > 0
        ? indices.find((i) => i > this.cursor) ?? indices[0]
        : [...indices].reverse().find((i) => i < this.cursor) ?? indices[indices.length - 1];
    // Global by design: section mode follows the target into its chapter.
    this.setCursor(next);
  }

  /** `Tab` / `Shift+Tab` — the guided read. Each step scrolls the block cursor to
   *  its walkthrough and asks the Diff Window to follow its anchor. */
  private moveStep(delta: number): void {
    if (this.steps.length === 0) {
      this.flash('no walkthrough in this review');
      return;
    }
    const n = this.steps.length;
    this.stepCursor = this.stepCursor < 0 && delta < 0 ? n - 1 : ((this.stepCursor + delta) % n + n) % n;
    const step = this.steps[this.stepCursor];
    const blockIndex = this.doc.blocks.findIndex((b) => b.id === step.blockId);
    // The guided read is global too: follow the step into whatever chapter (or
    // out of whatever filtered view) it lives in.
    if (blockIndex >= 0) this.setCursor(blockIndex);
    else this.render();
    this.scrollElementIntoView(
      this.body.querySelector('.krypton-review__step--current'),
      'center',
    );
    this.jumpToAnchor(step.at, { quiet: true });
  }

  /** Ask the host to open a `path:line`. A step whose anchor no longer resolves
   *  still opens the file at its top — the explanation is worth reading either
   *  way, which is why a drifted step is never hidden. */
  private jumpToAnchor(at: string, options?: { quiet?: boolean }): void {
    const anchor = parseWalkthroughAnchor(at);
    if (!anchor) {
      if (!options?.quiet) this.flash('this step has no anchor');
      return;
    }
    if (!this.jumpTo) {
      if (!options?.quiet) this.flash('no window to jump into');
      return;
    }
    this.jumpTo({ path: anchor.path, line: anchor.line });
  }

  // ─── Answering ──────────────────────────────────────────────────────────

  private currentBlock(): ReviewBlock | null {
    return this.doc.blocks[this.cursor] ?? null;
  }

  /** `a` / `x` — accept or dismiss the focused finding. Pressing the same state
   *  again clears it, so a mis-keyed triage is one keystroke to undo. */
  private triageFinding(state: 'accepted' | 'dismissed'): void {
    const block = this.currentBlock();
    if (!block || block.kind !== 'finding') {
      this.flash('not a finding');
      return;
    }
    if (this.answers.findings.get(block.id) === state) this.answers.findings.delete(block.id);
    else this.answers.findings.set(block.id, state);
    this.afterAnswer();
  }

  /** `1`…`9` — answer the focused decision. Re-pressing the chosen option clears it. */
  private answerDecision(option: number): void {
    const block = this.currentBlock();
    if (!block || block.kind !== 'decision') {
      this.flash('not a decision');
      return;
    }
    if (option > block.data.options.length) {
      this.flash(`this decision has ${block.data.options.length} options`);
      return;
    }
    if (this.answers.decisions.get(block.id) === option) this.answers.decisions.delete(block.id);
    else this.answers.decisions.set(block.id, option);
    this.afterAnswer();
  }

  /** Save, then re-render. In `Open items` the answered block leaves the visible
   *  set, so the cursor moves to the next item (else the previous one) rather
   *  than pointing at something that is no longer on screen. */
  private afterAnswer(): void {
    this.scheduleSave();
    if (this.viewMode === 'open') {
      const next = reconcileOpenCursor(this.openIndices(), this.cursor);
      if (next !== null) this.cursor = next;
    }
    this.render();
  }

  /** `Enter` — the context action: expand a folded diff, or open a finding's
   *  anchor / the current walkthrough step in the Diff Window. */
  private contextAction(): void {
    const block = this.currentBlock();
    if (!block) return;
    if (block.kind === 'diff') {
      if (this.expandedDiffs.has(block.id)) this.expandedDiffs.delete(block.id);
      else this.expandedDiffs.add(block.id);
      this.render();
      return;
    }
    if (block.kind === 'finding') {
      if (!block.data.file) {
        this.flash('this finding has no file anchor');
        return;
      }
      this.jumpToAnchor(
        block.data.line !== undefined ? `${block.data.file}:${block.data.line}` : block.data.file,
      );
      return;
    }
    if (block.kind === 'walkthrough') {
      const step = this.steps[this.stepCursor];
      if (step && step.blockId === block.id) this.jumpToAnchor(step.at);
      else this.jumpToAnchor(block.data.steps[0]?.at ?? '');
      return;
    }
    this.flash('nothing to open here');
  }

  // ─── Autosave ───────────────────────────────────────────────────────────

  /** Debounced write of `response.md`. EVERY answer schedules one, so closing the
   *  window never loses work; `s` is what hands the answers to the lane. */
  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveState = 'saving';
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private async saveNow(): Promise<void> {
    const response = toResponse(this.slug, this.answers, this.doc.blocks, this.sentAt);
    const respondedAt = Date.now();
    const contents = serializeResponseFile(response, respondedAt, (id) => this.blockLabel(id));
    try {
      await invoke('write_review_response', { dir: this.dir, contents });
      this.ownRespondedAt = respondedAt;
      this.saveState = 'saved';
      this.banner = null;
    } catch (e) {
      // Keep the response in memory so a re-created bundle can still take it.
      this.saveState = 'error';
      this.banner = `could not save response.md — answers kept in memory (${errorText(e)})`;
    }
    this.renderHeader();
    if (this.saveState === 'error') this.renderBody();
  }

  /** Flush a pending write immediately (before a send, and on dispose). */
  private async flushSave(): Promise<void> {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.saveNow();
  }

  /** Human-readable label for a block, used in the generated `response.md` body
   *  and in the payload handed to the lane — a raw block id means nothing to
   *  either reader. */
  private blockLabel(blockId: string): string {
    const block = this.doc.blocks.find((b) => b.id === blockId);
    if (!block) return blockId;
    if (block.kind === 'finding') {
      const anchor = block.data.file
        ? ` — ${block.data.file}${block.data.line !== undefined ? `:${block.data.line}` : ''}`
        : '';
      return `${block.data.title}${anchor}`;
    }
    if (block.kind === 'decision') return block.data.question;
    if (block.kind === 'walkthrough') return block.data.title ?? 'walkthrough';
    // Fall back to the block's first meaningful line.
    const line = block.raw.split('\n').find((l) => l.trim().length > 0) ?? blockId;
    return line.trim().slice(0, 120);
  }

  private blockLabels(): Record<string, string> {
    const out: Record<string, string> = {};
    const response = toResponse(this.slug, this.answers, this.doc.blocks, this.sentAt);
    for (const id of [
      ...response.findings.map((f) => f.blockId),
      ...response.decisions.map((d) => d.blockId),
      ...response.comments.map((c) => c.blockId),
    ]) {
      out[id] = this.blockLabel(id);
    }
    return out;
  }

  // ─── Overlays ───────────────────────────────────────────────────────────

  private openOverlay(kind: Overlay): void {
    this.closeOverlay();
    this.overlay = kind;
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = `krypton-review__overlay krypton-review__overlay--${kind}`;
    this.element.appendChild(this.overlayEl);
    this.renderOverlay();
  }

  private closeOverlay(): void {
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.overlay = 'none';
    this.commentInput = null;
    this.noteInput = null;
    this.commentBlockId = null;
    this.element.focus();
  }

  private renderOverlay(): void {
    if (!this.overlayEl) return;
    if (this.overlay === 'comment') this.renderCommentComposer();
    else if (this.overlay === 'send') this.renderSendPreview();
  }

  /** `c` — comment on the focused block. The selection is quoted when there is
   *  one, else the block's head, so the lane always gets an anchor it can find. */
  private startComment(): void {
    const block = this.currentBlock();
    if (!block) return;
    const selection = window.getSelection()?.toString().trim() ?? '';
    this.commentBlockId = block.id;
    this.commentQuote = (selection.length > 0 ? selection : this.blockHead(block)).slice(
      0,
      QUOTE_CAP,
    );
    this.openOverlay('comment');
    this.commentInput?.focus();
  }

  /** The first couple of lines of a block, as a fallback quote. */
  private blockHead(block: ReviewBlock): string {
    return block.raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .slice(0, 2)
      .join(' ')
      .slice(0, 200);
  }

  private renderCommentComposer(): void {
    const root = this.overlayEl;
    if (!root) return;
    root.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'krypton-review__overlay-head';
    head.textContent = 'comment · Cmd+Enter to save · Esc to cancel';
    root.appendChild(head);

    const quote = document.createElement('div');
    quote.className = 'krypton-review__comment-quote';
    quote.textContent = this.commentQuote;
    root.appendChild(quote);

    this.commentInput = document.createElement('textarea');
    this.commentInput.className = 'krypton-review__comment-input';
    this.commentInput.rows = 4;
    this.commentInput.placeholder = 'what should the lane do about this?';
    this.commentInput.addEventListener('keydown', (e) => this.onComposerKey(e));
    root.appendChild(this.commentInput);
  }

  private onComposerKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.closeOverlay();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      this.commitComment();
    }
  }

  private commitComment(): void {
    const body = this.commentInput?.value.trim() ?? '';
    const blockId = this.commentBlockId;
    if (!blockId || body.length === 0) {
      this.closeOverlay();
      return;
    }
    this.answers.comments.push({ blockId, quote: this.commentQuote, body });
    this.closeOverlay();
    this.scheduleSave();
    this.render();
  }

  /** `s` — the send preview: everything about to go, plus an optional note. */
  private async openSendPreview(): Promise<void> {
    await this.flushSave();
    this.openOverlay('send');
    this.noteInput?.focus();
  }

  private renderSendPreview(): void {
    const root = this.overlayEl;
    if (!root) return;
    root.innerHTML = '';
    const response = toResponse(this.slug, this.answers, this.doc.blocks, this.sentAt);

    const head = document.createElement('div');
    head.className = 'krypton-review__overlay-head';
    head.textContent = this.sending
      ? `sending → ${this.laneName}…`
      : `send → ${this.laneName} · Cmd+Enter to confirm · Esc to cancel`;
    root.appendChild(head);

    if (this.banner) {
      const notice = document.createElement('div');
      notice.className = 'krypton-review__overlay-notice';
      notice.textContent = this.banner;
      root.appendChild(notice);
    }

    const list = document.createElement('div');
    list.className = 'krypton-review__send-list';
    for (const f of response.findings) {
      list.appendChild(sendRow(f.state, this.blockLabel(f.blockId)));
    }
    for (const d of response.decisions) {
      list.appendChild(sendRow(`option ${d.chosen}`, this.blockLabel(d.blockId)));
    }
    for (const c of response.comments) {
      list.appendChild(sendRow('comment', `${this.blockLabel(c.blockId)} — ${c.body}`));
    }
    if (response.findings.length + response.decisions.length + response.comments.length === 0) {
      list.appendChild(sendRow('—', 'nothing answered; only the note below will be sent'));
    }
    root.appendChild(list);

    this.noteInput = document.createElement('textarea');
    this.noteInput.className = 'krypton-review__note-input';
    this.noteInput.rows = 3;
    this.noteInput.placeholder = 'optional note for the lane';
    this.noteInput.value = this.answers.note;
    this.noteInput.addEventListener('input', () => {
      this.answers.note = this.noteInput?.value ?? '';
      this.scheduleSave();
    });
    this.noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.closeOverlay();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        void this.confirmSend();
      }
    });
    root.appendChild(this.noteInput);
  }

  private async confirmSend(): Promise<void> {
    if (this.sending) return;
    const response = toResponse(this.slug, this.answers, this.doc.blocks);
    if (isResponseEmpty(response)) {
      this.flash('nothing to send — answer something or add a note');
      return;
    }
    if (!this.review) {
      this.flash('no live lane — the answers are recorded on disk');
      return;
    }

    this.sending = true;
    this.renderOverlay();
    let result: ReviewResponseSendResult;
    try {
      result = await this.review.send({
        reviewId: this.slug,
        dir: this.dir,
        title: this.doc.title ?? this.slug,
        target: this.laneName,
        batchId: crypto.randomUUID(),
        response,
        blockLabels: this.blockLabels(),
      });
    } catch {
      result = { status: 'no-live-lane' };
    } finally {
      this.sending = false;
    }

    if (result.status === 'accepted' || result.status === 'duplicate') {
      // Stamp `sentAt` and re-save, so a reopened Board can tell "answered" from
      // "delivered" — and so a lane reading the bundle later sees the same thing.
      this.sentAt = Date.now();
      await this.saveNow();
      this.closeOverlay();
      this.flash(
        result.status === 'duplicate'
          ? `already delivered → ${this.laneName}`
          : `sent → ${this.laneName}`,
      );
      this.render();
      return;
    }
    // Kept, never dropped: the answers are on disk and the response stays in
    // memory, so a later lane can still be handed it.
    this.banner = `${this.laneName} is no longer live — the answers are recorded on disk`;
    this.renderOverlay();
  }

  // ─── In-doc search (spec 137 behaviour) ─────────────────────────────────

  private openSearch(): void {
    if (!this.searchActive) {
      // Search is whole-document by contract (spec 137), and it highlights
      // rendered DOM — so a chaptered body would only ever find the chapter it
      // is showing. Render everything for the duration and land back in the
      // chapter the match turns out to be in.
      this.searchReturn = {
        mode: this.viewMode,
        sectionIndex: this.sectionIndex,
        cursor: this.cursor,
      };
      if (this.viewMode !== 'document') {
        this.cancelBodyScroll();
        this.viewMode = 'document';
        this.renderBody();
        this.renderMap();
      }
    }
    if (!this.searchHud) {
      this.searchHud = document.createElement('div');
      this.searchHud.className = 'krypton-review__search';
      const prompt = document.createElement('span');
      prompt.className = 'krypton-review__search-prompt';
      prompt.textContent = '/';
      this.searchInput = document.createElement('input');
      this.searchInput.className = 'krypton-review__search-input';
      this.searchInput.placeholder = 'search…';
      this.searchInput.addEventListener('input', () => this.scheduleSearch());
      this.searchInput.addEventListener('keydown', (e) => this.onSearchInputKey(e));
      const count = document.createElement('span');
      count.className = 'krypton-review__search-count';
      this.searchHud.append(prompt, this.searchInput, count);
      this.element.appendChild(this.searchHud);
    }
    this.searchActive = true;
    this.renderHeader();
    this.searchHud.style.display = '';
    this.searchInput?.focus();
    this.searchInput?.select();
    this.applySearch();
  }

  private onSearchInputKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.closeSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.flushSearch();
      this.searchStep(e.shiftKey ? -1 : 1);
      this.searchInput?.blur();
      this.element.focus();
    }
  }

  private scheduleSearch(): void {
    if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
    this.searchDebounce = window.setTimeout(() => {
      this.searchDebounce = null;
      this.applySearch();
    }, 120);
  }

  private flushSearch(): void {
    if (this.searchDebounce === null) return;
    clearTimeout(this.searchDebounce);
    this.searchDebounce = null;
    this.applySearch();
  }

  private applySearch(): void {
    this.unwrapMatches();
    const q = (this.searchInput?.value ?? '').toLowerCase();
    if (!q) {
      this.updateSearchCount();
      return;
    }
    const walker = document.createTreeWalker(this.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement;
        if (!p || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (p.closest('pre, code, .krypton-review__search')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    let n = walker.nextNode();
    while (n) {
      textNodes.push(n as Text);
      n = walker.nextNode();
    }

    for (const node of textNodes) {
      if (this.searchMatches.length >= ReviewBoardView.SEARCH_MATCH_CAP) break;
      const text = node.nodeValue ?? '';
      const lower = text.toLowerCase();
      if (!lower.includes(q)) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      let idx = lower.indexOf(q, 0);
      while (idx !== -1 && this.searchMatches.length < ReviewBoardView.SEARCH_MATCH_CAP) {
        if (idx > last) frag.append(text.slice(last, idx));
        const mark = document.createElement('mark');
        mark.className = 'krypton-review__match';
        mark.textContent = text.slice(idx, idx + q.length);
        frag.append(mark);
        this.searchMatches.push(mark);
        last = idx + q.length;
        idx = lower.indexOf(q, last);
      }
      if (last < text.length) frag.append(text.slice(last));
      node.parentNode?.replaceChild(frag, node);
    }
    this.searchIndex = -1;
    this.updateSearchCount();
  }

  private searchStep(delta: number): void {
    if (this.searchMatches.length === 0) return;
    if (this.searchIndex >= 0) {
      this.searchMatches[this.searchIndex]?.classList.remove('krypton-review__match--current');
    }
    const n = this.searchMatches.length;
    this.searchIndex = ((this.searchIndex + delta) % n + n) % n;
    const current = this.searchMatches[this.searchIndex];
    current.classList.add('krypton-review__match--current');
    this.scrollElementIntoView(current, 'center');
    this.updateSearchCount();
  }

  private updateSearchCount(): void {
    const count = this.searchHud?.querySelector('.krypton-review__search-count');
    if (!count) return;
    const total = this.searchMatches.length;
    if (total === 0) {
      count.textContent = 'no matches';
      return;
    }
    const pos = this.searchIndex >= 0 ? `${this.searchIndex + 1}/` : '';
    const capped = total >= ReviewBoardView.SEARCH_MATCH_CAP ? '+' : '';
    count.textContent = `${pos}${total}${capped}`;
  }

  private unwrapMatches(): void {
    for (const mark of this.searchMatches) {
      mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
    }
    this.searchMatches = [];
    this.searchIndex = -1;
    this.body.normalize();
  }

  private closeSearch(): void {
    if (this.searchDebounce !== null) {
      clearTimeout(this.searchDebounce);
      this.searchDebounce = null;
    }
    // Read the landing block BEFORE unwrapping — that is what destroys the marks.
    const current = this.searchIndex >= 0 ? this.searchMatches[this.searchIndex] ?? null : null;
    const landingId = current?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId ?? null;
    this.unwrapMatches();
    this.searchActive = false;
    if (this.searchHud) this.searchHud.style.display = 'none';

    const back = this.searchReturn;
    this.searchReturn = null;
    const landing = landingId ? this.doc.blocks.findIndex((b) => b.id === landingId) : -1;
    if (landing >= 0) {
      // There was a match: keep it, in its own chapter.
      if (back?.mode !== 'document') {
        this.viewMode = 'section';
        this.sectionIndex = sectionIndexOfBlock(this.doc.sections, landing);
      }
      this.cursor = landing;
      this.render();
      this.scrollElementIntoView(this.blockEl(landing), 'center');
    } else if (back) {
      // Nothing found: put the reader back exactly where search took them from.
      this.viewMode = back.mode;
      this.sectionIndex = back.sectionIndex;
      this.cursor = back.cursor;
      this.render();
    } else {
      this.renderHeader();
    }
    this.element.focus();
  }

  // ─── Keyboard ───────────────────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    // A focused textarea/input owns its own keys.
    const active = document.activeElement;
    if (active === this.commentInput || active === this.noteInput || active === this.searchInput) {
      return false;
    }

    if (this.mapFocused) return this.onMapKey(e);
    if (this.overlay === 'comment' || this.overlay === 'send') {
      if (e.key === 'Escape' || e.key === 'q') {
        this.closeOverlay();
        return true;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (this.overlay === 'comment') this.commitComment();
        else void this.confirmSend();
        return true;
      }
      return false;
    }

    // Don't intercept modifier combos — the globals own them.
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    if (this.searchActive) {
      switch (e.key) {
        case 'n':
          this.searchStep(1);
          return true;
        case 'N':
          this.searchStep(-1);
          return true;
        case '/':
          this.openSearch();
          return true;
        case 'Escape':
          this.closeSearch();
          return true;
        // other keys fall through: scrolling still works while matches persist
      }
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      this.moveStep(e.shiftKey ? -1 : 1);
      return true;
    }

    if (this.viewMode === 'overview' && (BLOCK_ACTION_KEYS.has(e.key) || /^[1-9]$/.test(e.key))) {
      this.flash('open a chapter first');
      return true;
    }

    if (/^[1-9]$/.test(e.key)) {
      this.answerDecision(Number(e.key));
      return true;
    }

    switch (e.key) {
      case 'j':
        this.scrollBodyBy(60);
        return true;
      case 'k':
        this.scrollBodyBy(-60);
        return true;
      case 'n':
        this.moveCursor(1);
        return true;
      case 'N':
        this.moveCursor(-1);
        return true;
      case '}':
        this.moveToUnanswered(1);
        return true;
      case '{':
        this.moveToUnanswered(-1);
        return true;
      case '[':
        this.stepSection(-1);
        return true;
      case ']':
        this.stepSection(1);
        return true;
      case 'g': {
        // `g` / `G` are the top and bottom of the CURRENT view, not the document.
        const visible = this.visibleIndices();
        if (visible.length > 0) this.setCursor(visible[0]);
        this.scrollBodyTo(0);
        return true;
      }
      case 'G': {
        const visible = this.visibleIndices();
        if (visible.length > 0) this.setCursor(visible[visible.length - 1]);
        this.scrollBodyTo(this.body.scrollHeight);
        return true;
      }
      case 'Enter':
        this.contextAction();
        return true;
      case 'c':
        this.startComment();
        return true;
      case 'a':
        this.triageFinding('accepted');
        return true;
      case 'x':
        this.triageFinding('dismissed');
        return true;
      case 'o':
        this.openMap();
        return true;
      case 'O':
        this.setViewMode('overview');
        return true;
      case '/':
        this.openSearch();
        return true;
      case 's':
        void this.openSendPreview();
        return true;
      case 'r':
        this.requestRefresh();
        this.flash('reloading review.md');
        return true;
      case 'Escape':
        // Back out one level first: Overview / Open items / Full document return
        // to the chapter, so `O` then `Esc` is not a way to close a review by
        // accident. `q` below is still the unconditional exit.
        if (this.backOut()) return true;
        if (this.closeCallback) this.closeCallback();
        return true;
      case 'q':
        if (this.closeCallback) this.closeCallback();
        return true;
      default:
        return false;
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  focusView(): void {
    this.element.focus();
  }

  onShow(): void {
    // Idempotent: the header's sync age is the only thing that goes stale while
    // the tab is hidden.
    this.renderHeader();
  }

  onResize(): void {
    // Declared by `ContentView`, but the compositor never calls it — the layout
    // switch runs off this view's own ResizeObserver instead (spec 244).
  }

  dispose(): void {
    this.cancelBodyScroll();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.body.removeEventListener('wheel', this.cancelBodyScrollOnUserInput);
    this.body.removeEventListener('pointerdown', this.cancelBodyScrollOnUserInput);
    // Flush a pending autosave so the last keystroke before a close is not lost.
    // Fire-and-forget: `dispose` is synchronous by contract, and the answers are
    // already fully determined — nothing here can change them.
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.saveNow();
    }
    if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
    for (const cb of this.disposeListeners) cb();
    this.disposeListeners = [];
    this.element.remove();
  }

  /** Transient one-line notice in the header. */
  private flash(text: string): void {
    const el = document.createElement('span');
    el.className = 'krypton-review__seg krypton-review__seg--flash';
    el.textContent = text;
    this.header.appendChild(el);
    window.setTimeout(() => el.remove(), 2200);
  }

  /** True when another Board saved a newer response than ours — the caller offers
   *  `r` to reload rather than silently clobbering (last writer wins otherwise). */
  hasNewerResponseOnDisk(respondedAt: number): boolean {
    return respondedAt > this.ownRespondedAt;
  }
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function sendRow(mark: string, label: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'krypton-review__send-row';
  row.append(span('krypton-review__send-mark', mark), span('krypton-review__send-label', label));
  return row;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
