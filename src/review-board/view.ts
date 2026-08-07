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
} from '../acp/types';

import {
  answerableBlocks,
  parseReviewDocument,
  parseWalkthroughAnchor,
  reattachBlockId,
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

/** Cap on a quoted selection stored with a comment. */
const QUOTE_CAP = 2000;

/** Where a walkthrough step or an anchored finding should open. */
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

type Overlay = 'none' | 'outline' | 'comment' | 'send';

export class ReviewBoardView implements ContentView {
  readonly type: PaneContentType = 'review';
  readonly element: HTMLElement;

  private readonly dir: string;
  private readonly slug: string;
  private readonly cwd: string;
  private readonly jumpTo: ((target: ReviewJumpTarget) => void) | null;
  private readonly review: ReviewSendChannel | null;

  private doc: ReviewDocument = { title: null, laneName: null, subject: null, blocks: [] };
  private answers: ReviewAnswers = emptyAnswers();
  private laneName: string;

  /** Index into `doc.blocks`; -1 when the document is empty. */
  private cursor = -1;
  /** Flat list of every walkthrough step, in document order, for `Tab`. */
  private steps: { blockId: string; index: number; at: string; say: string }[] = [];
  private stepCursor = -1;
  /** Diff blocks the human expanded past the summary threshold. */
  private expandedDiffs = new Set<string>();

  private overlay: Overlay = 'none';
  private overlayEl: HTMLElement | null = null;
  private outlineIndex = 0;
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
  private static readonly SEARCH_MATCH_CAP = 500;

  private header: HTMLElement;
  private body: HTMLElement;
  private closeCallback: (() => void) | null = null;
  private disposeListeners: (() => void)[] = [];

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

    this.body = document.createElement('div');
    this.body.className = 'krypton-review__body';
    this.element.appendChild(this.body);

    // Clicking a block moves the cursor there, so the mouse is never a dead end
    // even though the whole surface is designed for the keyboard.
    this.body.addEventListener('click', (e) => {
      const block = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]');
      if (!block) return;
      const index = this.doc.blocks.findIndex((b) => b.id === block.dataset.blockId);
      if (index >= 0) this.moveCursor(index - this.cursor);
    });

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

  private render(): void {
    this.renderHeader();
    this.renderBody();
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
      this.header.appendChild(
        seg('krypton-review__seg--pos', `block ${this.cursor + 1}/${this.doc.blocks.length}`),
      );
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

    const ctx = this.renderContext();
    this.doc.blocks.forEach((block, index) => {
      const el = renderBlock(block, ctx);
      if (index === this.cursor) el.classList.add('krypton-review__block--cursor');
      // Only mark the walkthrough step the guided read is on.
      if (block.kind === 'walkthrough') this.markCurrentStep(el, block.id);
      this.body.appendChild(el);
    });

    const cursorEl = this.body.querySelector('.krypton-review__block--cursor');
    cursorEl?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
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

  private moveCursor(delta: number): void {
    if (this.doc.blocks.length === 0) return;
    this.cursor = clamp(this.cursor + delta, 0, this.doc.blocks.length - 1);
    this.render();
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
    this.cursor = next;
    this.render();
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
    if (blockIndex >= 0) this.cursor = blockIndex;
    this.render();
    this.body
      .querySelector('.krypton-review__step--current')
      ?.scrollIntoView({ block: 'center', behavior: 'auto' });
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
    this.scheduleSave();
    this.render();
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
    this.scheduleSave();
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
    if (this.overlay === 'outline') this.renderOutline();
    else if (this.overlay === 'comment') this.renderCommentComposer();
    else if (this.overlay === 'send') this.renderSendPreview();
  }

  /** `o` — the outline: every block with its kind and answered state. This is what
   *  stands in for a persistent sidebar, which would steal reading width. */
  private renderOutline(): void {
    const root = this.overlayEl;
    if (!root) return;
    root.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'krypton-review__overlay-head';
    head.textContent = `outline · ${this.doc.blocks.length} blocks · j/k move · Enter jump · Esc close`;
    root.appendChild(head);

    const list = document.createElement('div');
    list.className = 'krypton-review__outline';
    this.doc.blocks.forEach((block, index) => {
      const row = document.createElement('div');
      row.className = 'krypton-review__outline-row';
      if (index === this.outlineIndex) row.classList.add('krypton-review__outline-row--selected');
      const state = this.answerStateOf(block.id);
      const mark =
        block.kind === 'finding'
          ? state.findingState === 'accepted'
            ? '✓'
            : state.findingState === 'dismissed'
              ? '✗'
              : '·'
          : block.kind === 'decision'
            ? state.chosen !== null
              ? String(state.chosen)
              : '·'
            : ' ';
      row.append(
        span('krypton-review__outline-num', String(index + 1)),
        span('krypton-review__outline-kind', block.kind),
        span('krypton-review__outline-mark', mark),
        span('krypton-review__outline-label', this.blockLabel(block.id)),
      );
      if (state.commentCount > 0) {
        row.appendChild(span('krypton-review__outline-comments', `✎ ${state.commentCount}`));
      }
      list.appendChild(row);
    });
    root.appendChild(list);
    list
      .querySelector('.krypton-review__outline-row--selected')
      ?.scrollIntoView({ block: 'nearest' });
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

  private onOutlineKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        this.outlineIndex = clamp(this.outlineIndex + 1, 0, this.doc.blocks.length - 1);
        this.renderOutline();
        return true;
      case 'k':
      case 'ArrowUp':
        this.outlineIndex = clamp(this.outlineIndex - 1, 0, this.doc.blocks.length - 1);
        this.renderOutline();
        return true;
      case 'g':
        this.outlineIndex = e.shiftKey ? this.doc.blocks.length - 1 : 0;
        this.renderOutline();
        return true;
      case 'Enter':
        this.cursor = this.outlineIndex;
        this.closeOverlay();
        this.render();
        return true;
      case 'o':
      case 'q':
      case 'Escape':
        this.closeOverlay();
        return true;
      default:
        return false;
    }
  }

  // ─── In-doc search (spec 137 behaviour) ─────────────────────────────────

  private openSearch(): void {
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
    current.scrollIntoView({ behavior: 'auto', block: 'center' });
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
    this.unwrapMatches();
    this.searchActive = false;
    if (this.searchHud) this.searchHud.style.display = 'none';
    this.element.focus();
  }

  // ─── Keyboard ───────────────────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    // A focused textarea/input owns its own keys.
    const active = document.activeElement;
    if (active === this.commentInput || active === this.noteInput || active === this.searchInput) {
      return false;
    }

    if (this.overlay === 'outline') return this.onOutlineKey(e);
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

    if (/^[1-9]$/.test(e.key)) {
      this.answerDecision(Number(e.key));
      return true;
    }

    switch (e.key) {
      case 'j':
        this.body.scrollBy({ top: 60, behavior: 'auto' });
        return true;
      case 'k':
        this.body.scrollBy({ top: -60, behavior: 'auto' });
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
      case 'g':
        if (e.shiftKey) {
          this.cursor = Math.max(0, this.doc.blocks.length - 1);
          this.body.scrollTo({ top: this.body.scrollHeight, behavior: 'auto' });
        } else {
          this.cursor = this.doc.blocks.length > 0 ? 0 : -1;
          this.body.scrollTo({ top: 0, behavior: 'auto' });
        }
        this.render();
        return true;
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
        this.outlineIndex = Math.max(0, this.cursor);
        this.openOverlay('outline');
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
      case 'q':
      case 'Escape':
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
    // A single reading column — nothing to recompute.
  }

  dispose(): void {
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
