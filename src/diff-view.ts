// Krypton — Diff View
// Renders git diff output as side-by-side HTML using diff2html.

import { parse } from 'diff2html';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui';
import type { DiffFile } from 'diff2html/lib/types';
import 'diff2html/bundles/css/diff2html.min.css';
import 'highlight.js/styles/github-dark-dimmed.css';

import type { ContentView, PaneContentType } from './types';
import type {
  DiffReviewBatch,
  DiffReviewComment,
  DiffReviewSendResult,
  DiffReviewTargets,
} from './acp/types';

/** Untracked file whose content the backend declined to render (spec 155). */
export interface SkippedFile {
  path: string;
  /** 'binary' | 'too_large' | 'unreadable' */
  reason: string;
}

/** One refresh round-trip result — a re-collected working diff. */
export interface WorkingDiffResult {
  diff: string;
  skipped: SkippedFile[];
}

/** Channel for sending inline review comments to a working lane (spec 158).
 *  Routing is resolved on demand (no broadcast); the diff view stays decoupled
 *  from the harness — it only calls these callbacks. */
export interface DiffReviewChannel {
  /** Live lanes in this repo + a pre-selected default, resolved on demand. */
  resolveTargets: () => Promise<DiffReviewTargets>;
  /** Send a batch to the chosen lane. Resolves with the accept outcome; the
   *  view keeps the batch unless the result is 'accepted'/'duplicate'. */
  send: (batch: DiffReviewBatch) => Promise<DiffReviewSendResult>;
}

export interface DiffViewOptions {
  skipped?: SkippedFile[];
  /** Re-collects the working diff (spec 155). When absent the view is a
   *  static snapshot, exactly as before — no `r` key, no sync indicator. */
  refreshProvider?: () => Promise<WorkingDiffResult>;
  /** Inline review comments (spec 158). Absent when no harness backs the repo. */
  review?: DiffReviewChannel;
}

/** A review comment plus its local send state. The shared payload is never
 *  mutated after capture, so the line/quote anchor the lane receives stays
 *  exactly what the human saw, even after the diff refreshes (Codex-1 B4: a
 *  sent comment is kept, marked, never silently dropped). */
interface PendingComment extends DiffReviewComment {
  sent: boolean;
}

/** Anchor captured from the diff2html DOM. */
interface CapturedAnchor {
  file: string;
  side: 'old' | 'new';
  lineStart: number;
  lineEnd: number;
  quote: string;
}

/** Max quote length stored per comment. */
const QUOTE_CAP = 2000;

/** Debounce for event-driven refreshes; coalesces a burst of lane-idle
 *  signals from multiple lanes into one git round-trip. */
const REFRESH_DEBOUNCE_MS = 300;

/** Diff content view — renders git diff output as side-by-side panels */
export class DiffContentView implements ContentView {
  readonly type: PaneContentType = 'diff';
  readonly element: HTMLElement;

  private files: DiffFile[] = [];
  private currentFileIndex = 0;
  private fileContainer: HTMLElement;
  private navEl: HTMLElement;
  private skippedEl: HTMLElement;

  // File-list quick-switcher overlay (modal)
  private listEl: HTMLElement;
  private listOpen = false;
  private listSelectedIndex = 0;
  private diffStyle: 'side-by-side' | 'line-by-line' = 'side-by-side';
  private closeCallback: (() => void) | null = null;

  // Live refresh state (spec 155 / ADR-0008)
  private refreshProvider: (() => Promise<WorkingDiffResult>) | null;
  private skipped: SkippedFile[];
  private syncEl: HTMLElement | null = null;
  private dirty = false;
  private refreshing = false;
  private trailingRefresh = false;
  private lastSyncedAt: Date | null = null;
  private syncFailed = false;
  private debounceTimer: number | null = null;
  private refreshedCallback: ((fileCount: number) => void) | null = null;
  private disposeListeners: (() => void)[] = [];

  // Review comments (spec 158)
  private review: DiffReviewChannel | null;
  private comments: PendingComment[] = [];
  private targets: DiffReviewTargets = { lanes: [], default: null };
  private reviewTarget: string | null = null;
  private composerEl: HTMLElement | null = null;
  private composerArea: HTMLTextAreaElement | null = null;
  private composerAnchor: CapturedAnchor | null = null;
  private commentsOverlay: HTMLElement | null = null;
  private commentsOverlayOpen = false;
  private commentsSelectedIndex = 0;
  private reviewNotice = '';
  private sending = false;

  constructor(unifiedDiff: string, container: HTMLElement, options?: DiffViewOptions) {
    this.refreshProvider = options?.refreshProvider ?? null;
    this.review = options?.review ?? null;
    this.skipped = options?.skipped ?? [];
    if (this.refreshProvider) this.lastSyncedAt = new Date();

    this.element = document.createElement('div');
    this.element.className = 'krypton-diff';
    this.element.tabIndex = 0;
    container.appendChild(this.element);

    // Parse git diff output
    try {
      this.files = parse(unifiedDiff);
    } catch {
      this.files = [];
    }

    // File navigation bar
    this.navEl = document.createElement('div');
    this.navEl.className = 'krypton-diff__nav';
    this.element.appendChild(this.navEl);

    // Untracked files the backend skipped (binary / too large) — name-only,
    // so nothing a lane created is invisible.
    this.skippedEl = document.createElement('div');
    this.skippedEl.className = 'krypton-diff__skipped';
    this.element.appendChild(this.skippedEl);
    this.renderSkipped();

    // Diff content area
    this.fileContainer = document.createElement('div');
    this.fileContainer.className = 'krypton-diff__content';
    this.element.appendChild(this.fileContainer);

    // File-list overlay — hidden until toggled with `t`
    this.listEl = document.createElement('div');
    this.listEl.className = 'krypton-diff__filelist';
    this.listEl.hidden = true;
    this.element.appendChild(this.listEl);

    // Review comments (spec 158) — composer + comments overlay, hidden until used.
    if (this.review) {
      this.composerEl = document.createElement('div');
      this.composerEl.className = 'krypton-diff__composer';
      this.composerEl.hidden = true;
      this.element.appendChild(this.composerEl);

      this.commentsOverlay = document.createElement('div');
      this.commentsOverlay.className = 'krypton-diff__comments';
      this.commentsOverlay.hidden = true;
      this.element.appendChild(this.commentsOverlay);

      void this.refreshTargets();
    }

    if (this.files.length === 0) {
      this.renderEmpty();
    } else {
      this.renderCurrentFile();
    }
  }

  /** Set callback to invoke when user presses q/Escape to close */
  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  private renderEmpty(): void {
    this.closeFileList();
    this.navEl.innerHTML = '';
    this.appendReviewIndicator();
    this.appendSyncIndicator();
    this.fileContainer.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'krypton-diff__empty';
    msg.textContent = 'No changes';
    this.fileContainer.appendChild(msg);
  }

  private renderNav(): void {
    this.navEl.innerHTML = '';
    const file = this.files[this.currentFileIndex];
    if (!file) return;

    const index = document.createElement('span');
    index.className = 'krypton-diff__file-index';
    index.textContent = `${this.currentFileIndex + 1}/${this.files.length}`;

    const path = document.createElement('span');
    path.className = 'krypton-diff__file-path';
    path.textContent = this.filePath(file);

    const stats = document.createElement('span');
    stats.className = 'krypton-diff__stats';
    const adds = file.addedLines;
    const dels = file.deletedLines;
    stats.innerHTML = `<span class="krypton-diff__adds">+${adds}</span> <span class="krypton-diff__dels">-${dels}</span>`;

    const mode = document.createElement('span');
    mode.className = 'krypton-diff__mode';
    mode.textContent = this.diffStyle === 'side-by-side' ? 'SPLIT' : 'UNIFIED';

    this.navEl.appendChild(index);
    this.navEl.appendChild(path);
    this.navEl.appendChild(stats);
    this.navEl.appendChild(mode);
    this.appendReviewIndicator();
    this.appendSyncIndicator();
  }

  // ─── Review comments (spec 158) ───

  /** Target lane + pending-comment count in the nav bar. Static text, no border
   *  rail — matches the sync-indicator philosophy. */
  private appendReviewIndicator(): void {
    if (!this.review) return;
    const el = document.createElement('span');
    el.className = 'krypton-diff__review-target';
    const pending = this.comments.filter((c) => !c.sent).length;
    const target = this.reviewTarget ? `→ ${this.reviewTarget}` : '→ (no lane)';
    let text = pending > 0 ? `${target} · ${pending} comment${pending === 1 ? '' : 's'}` : target;
    if (this.reviewNotice) text += ` · ${this.reviewNotice}`;
    el.textContent = text;
    if (!this.reviewTarget) el.classList.add('krypton-diff__review-target--none');
    this.navEl.appendChild(el);
  }

  /** Pull the current lane roster + default target on demand (no broadcast). */
  private async refreshTargets(): Promise<void> {
    if (!this.review) return;
    try {
      this.targets = await this.review.resolveTargets();
    } catch {
      this.targets = { lanes: [], default: null };
    }
    // Keep the human's pick if it is still a candidate; otherwise fall back to
    // the resolved default.
    const names = this.targets.lanes.map((l) => l.displayName);
    if (!this.reviewTarget || !names.includes(this.reviewTarget)) {
      this.reviewTarget = this.targets.default;
    }
    if (!this.commentsOverlayOpen) this.renderNav();
    else this.renderCommentsOverlay();
  }

  /** The file path the lane would edit for the current file (post-image name,
   *  or the old name for a deletion). */
  private currentFilePath(): string | null {
    const file = this.files[this.currentFileIndex];
    if (!file) return null;
    return file.newName && file.newName !== '/dev/null'
      ? file.newName
      : (file.oldName ?? null);
  }

  // ─── Anchor capture from the diff2html DOM ───

  private elementOf(node: Node | null): Element | null {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  }

  /** Line number + side for a diff row, supporting BOTH renderers: side-by-side
   *  uses `.d2h-code-side-linenumber` (one number per split table; side from
   *  panel order) and line-by-line uses `.d2h-code-linenumber` with
   *  `.line-num1`/`.line-num2` (Codex-1 B3). Returns null for a padding/empty
   *  row. */
  private lineInfoForRow(row: Element | null): { side: 'old' | 'new'; line: number } | null {
    if (!row) return null;
    // Line-by-line: a single cell carries both old + new numbers.
    const unified = row.querySelector('.d2h-code-linenumber');
    if (unified) {
      const newNum = parseInt(unified.querySelector('.line-num2')?.textContent ?? '', 10);
      if (Number.isFinite(newNum)) return { side: 'new', line: newNum };
      const oldNum = parseInt(unified.querySelector('.line-num1')?.textContent ?? '', 10);
      if (Number.isFinite(oldNum)) return { side: 'old', line: oldNum };
      return null;
    }
    // Side-by-side: one number per row; side from which split panel it sits in.
    const sideCell = row.querySelector('.d2h-code-side-linenumber');
    if (sideCell) {
      const num = parseInt(sideCell.textContent ?? '', 10);
      if (!Number.isFinite(num)) return null;
      const panel = row.closest('.d2h-file-side-diff');
      const panels = Array.from(this.fileContainer.querySelectorAll('.d2h-file-side-diff'));
      const side: 'old' | 'new' = panels.indexOf(panel as Element) <= 0 ? 'old' : 'new';
      return { side, line: num };
    }
    return null;
  }

  private lineInfoFor(node: Node | null): { side: 'old' | 'new'; line: number } | null {
    const el = this.elementOf(node);
    return this.lineInfoForRow(el?.closest('tr') ?? null);
  }

  /** Build an anchor from the current text selection, or fall back to the hunk
   *  nearest the top of the viewport when nothing is selected. */
  private captureAnchor(): CapturedAnchor | null {
    const file = this.currentFilePath();
    if (!file) return null;

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && this.element.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      const start = this.lineInfoFor(range.startContainer);
      if (start) {
        const end = this.lineInfoFor(range.endContainer);
        // Constrain a cross-side / cross-panel selection to the start side
        // (Codex-1 W1): a comment maps to one side + one contiguous range.
        let lineStart = start.line;
        let lineEnd = end && end.side === start.side ? end.line : start.line;
        if (lineEnd < lineStart) [lineStart, lineEnd] = [lineEnd, lineStart];
        return {
          file,
          side: start.side,
          lineStart,
          lineEnd,
          quote: sel.toString().slice(0, QUOTE_CAP),
        };
      }
    }
    return this.currentHunkAnchor(file);
  }

  private currentHunkAnchor(file: string): CapturedAnchor | null {
    // In side-by-side each panel has its OWN tbodies; scope the search to the
    // NEW (right) panel so a whole-hunk anchor lands on the editable post-change
    // lines, not the old/left side (Codex-1 B2). Line-by-line has no split
    // panels, so the whole container is the scope and prefer-new picks the new
    // number from the shared cell.
    const panels = this.fileContainer.querySelectorAll('.d2h-file-side-diff');
    const scope: ParentNode = panels.length > 1 ? panels[1] : this.fileContainer;
    const blocks = Array.from(scope.querySelectorAll('.d2h-diff-tbody'));
    if (blocks.length === 0) return null;
    const containerTop = this.fileContainer.getBoundingClientRect().top;
    // First block whose bottom is still below the viewport top = the hunk the
    // human is looking at.
    const block =
      blocks.find((b) => b.getBoundingClientRect().bottom - containerTop > 0) ?? blocks[0];

    const infos = Array.from(block.querySelectorAll('tr'))
      .map((row) => this.lineInfoForRow(row))
      .filter((i): i is { side: 'old' | 'new'; line: number } => i !== null);
    if (infos.length === 0) return null;
    const preferred = infos.filter((i) => i.side === 'new');
    const chosen = preferred.length > 0 ? preferred : infos;
    const side = chosen[0].side;
    const lines = chosen.filter((i) => i.side === side).map((i) => i.line);
    const quote = Array.from(block.querySelectorAll('.d2h-code-line-ctn'))
      .map((e) => e.textContent ?? '')
      .join('\n')
      .slice(0, QUOTE_CAP);
    return { file, side, lineStart: Math.min(...lines), lineEnd: Math.max(...lines), quote };
  }

  // ─── Composer ───

  private startComment(): void {
    const anchor = this.captureAnchor();
    if (!anchor || !this.composerEl) {
      this.reviewNotice = 'select code or a hunk to comment on';
      this.renderNav();
      return;
    }
    this.composerAnchor = anchor;
    this.composerEl.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'krypton-diff__composer-label';
    const range = anchor.lineStart === anchor.lineEnd
      ? `${anchor.lineStart}`
      : `${anchor.lineStart}-${anchor.lineEnd}`;
    label.textContent = `${anchor.file}:${range} (${anchor.side})`;

    const area = document.createElement('textarea');
    area.className = 'krypton-diff__composer-input';
    area.placeholder = 'comment — Enter to add, Shift+Enter newline, Esc cancel';
    area.rows = 2;

    const hint = document.createElement('div');
    hint.className = 'krypton-diff__composer-hint';
    hint.textContent = this.reviewTarget ? `→ ${this.reviewTarget}` : 'no target lane yet';

    this.composerEl.appendChild(label);
    this.composerEl.appendChild(area);
    this.composerEl.appendChild(hint);
    this.composerEl.hidden = false;
    this.composerArea = area;
    area.focus();
  }

  private onComposerKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.closeComposer();
      return true;
    }
    // Enter submits; Shift+Enter inserts a newline (let the textarea handle it).
    if (e.key === 'Enter' && !e.shiftKey) {
      this.commitComment();
      return true;
    }
    return false;
  }

  private closeComposer(): void {
    if (this.composerEl) this.composerEl.hidden = true;
    this.composerArea = null;
    this.composerAnchor = null;
    this.element.focus();
  }

  private commitComment(): void {
    const body = this.composerArea?.value.trim() ?? '';
    const anchor = this.composerAnchor;
    if (!anchor || body === '') {
      this.closeComposer();
      return;
    }
    this.comments.push({
      id: crypto.randomUUID(),
      file: anchor.file,
      side: anchor.side,
      lineStart: anchor.lineStart,
      lineEnd: anchor.lineEnd,
      quote: anchor.quote,
      body,
      createdAt: Date.now(),
      sent: false,
    });
    this.reviewNotice = '';
    this.closeComposer();
    this.renderNav();
  }

  // ─── Comments overlay ───

  private openCommentsOverlay(): void {
    if (!this.commentsOverlay) return;
    this.commentsOverlayOpen = true;
    this.commentsSelectedIndex = Math.min(this.commentsSelectedIndex, Math.max(0, this.comments.length - 1));
    this.commentsOverlay.hidden = false;
    void this.refreshTargets(); // pull a current roster while the picker is open
    this.renderCommentsOverlay();
  }

  private closeCommentsOverlay(): void {
    this.commentsOverlayOpen = false;
    if (this.commentsOverlay) this.commentsOverlay.hidden = true;
  }

  private onCommentsKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        this.moveCommentSelection(1);
        return true;
      case 'k':
      case 'ArrowUp':
        this.moveCommentSelection(-1);
        return true;
      case 'Enter':
        this.jumpToComment();
        return true;
      case 'd':
        this.deleteSelectedComment();
        return true;
      case 'Tab':
      case ']':
        this.cycleTarget(1);
        return true;
      case '[':
        this.cycleTarget(-1);
        return true;
      case 's':
        void this.sendComments();
        return true;
      case 'C':
      case 'q':
      case 'Escape':
        this.closeCommentsOverlay();
        return true;
      default:
        return true;
    }
  }

  private moveCommentSelection(delta: number): void {
    if (this.comments.length === 0) return;
    this.commentsSelectedIndex =
      (this.commentsSelectedIndex + delta + this.comments.length) % this.comments.length;
    this.renderCommentsOverlay();
  }

  private cycleTarget(delta: number): void {
    const names = this.targets.lanes.map((l) => l.displayName);
    if (names.length === 0) return;
    const cur = this.reviewTarget ? names.indexOf(this.reviewTarget) : -1;
    this.reviewTarget = names[(cur + delta + names.length) % names.length];
    this.renderCommentsOverlay();
    this.renderNav();
  }

  private deleteSelectedComment(): void {
    const c = this.comments[this.commentsSelectedIndex];
    if (!c) return;
    this.comments.splice(this.commentsSelectedIndex, 1);
    this.commentsSelectedIndex = Math.min(this.commentsSelectedIndex, Math.max(0, this.comments.length - 1));
    this.renderCommentsOverlay();
    this.renderNav();
  }

  private jumpToComment(): void {
    const c = this.comments[this.commentsSelectedIndex];
    if (!c) return;
    const idx = this.files.findIndex((f) => this.fileKey(f) === c.file || this.filePath(f) === c.file);
    this.closeCommentsOverlay();
    if (idx >= 0 && idx !== this.currentFileIndex) {
      this.currentFileIndex = idx;
      this.renderCurrentFile();
    }
    this.scrollToLine(c.side, c.lineStart);
  }

  /** Scroll the matching line into view, if it can still be located. */
  private scrollToLine(side: 'old' | 'new', line: number): void {
    const cell = this.findLineCell(side, line);
    cell?.closest('tr')?.scrollIntoView({ behavior: 'auto', block: 'center' });
  }

  private async sendComments(): Promise<void> {
    // In-flight guard: a second `s` while a send is pending would mint a new
    // batchId for the same comments (Codex-1 W2). The queue de-dupes per comment
    // so it could not double-deliver, but the guard avoids redundant round-trips.
    if (!this.review || this.sending) return;
    if (this.comments.length === 0) {
      this.reviewNotice = 'no comments to send';
      this.renderCommentsOverlay();
      return;
    }
    if (!this.reviewTarget) {
      this.reviewNotice = 'pick a target lane first ([ ] / Tab)';
      this.renderCommentsOverlay();
      return;
    }
    // Send ALL comments, not just unsent: a comment marked sent but dropped
    // before the lane drained it (lane close / `#new`) must be recoverable. The
    // DiffReviewQueue de-dupes by comment id at drain, so re-sending an
    // already-delivered comment is a harmless no-op (Codex-1 B1).
    const target = this.reviewTarget;
    const batch: DiffReviewBatch = {
      batchId: crypto.randomUUID(),
      target,
      comments: this.comments.map(({ sent: _sent, ...c }) => c),
    };
    this.sending = true;
    this.reviewNotice = `sending → ${target}…`;
    this.renderCommentsOverlay();
    let result: DiffReviewSendResult;
    try {
      result = await this.review.send(batch);
    } catch {
      result = { status: 'no-live-lane' };
    } finally {
      this.sending = false;
    }
    if (result.status === 'accepted' || result.status === 'duplicate') {
      for (const c of this.comments) c.sent = true;
      this.reviewNotice =
        result.status === 'duplicate' ? `already delivered → ${target}` : `sent → ${target}`;
    } else {
      // Kept, not dropped — the human can retarget and re-send (Codex-1 B1/B4).
      this.reviewNotice = `${target} is no longer live — comments kept, retarget and re-send`;
      void this.refreshTargets();
    }
    this.renderCommentsOverlay();
    this.renderNav();
  }

  private renderCommentsOverlay(): void {
    const root = this.commentsOverlay;
    if (!root) return;
    root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'krypton-diff__comments-header';
    const target = this.reviewTarget ? `→ ${this.reviewTarget}` : '→ (no lane — [ ] to pick)';
    header.textContent =
      `${this.comments.length} comment${this.comments.length === 1 ? '' : 's'} · ${target}`;
    root.appendChild(header);

    if (this.reviewNotice) {
      const notice = document.createElement('div');
      notice.className = 'krypton-diff__comments-notice';
      notice.textContent = this.reviewNotice;
      root.appendChild(notice);
    }

    const items = document.createElement('div');
    items.className = 'krypton-diff__comments-items';
    root.appendChild(items);

    if (this.comments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'krypton-diff__comments-empty';
      empty.textContent = 'No comments — press c on a hunk to add one';
      items.appendChild(empty);
    }

    this.comments.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'krypton-diff__comments-item';
      if (i === this.commentsSelectedIndex) row.classList.add('krypton-diff__comments-item--selected');
      if (c.sent) row.classList.add('krypton-diff__comments-item--sent');

      const range = c.lineStart === c.lineEnd ? `${c.lineStart}` : `${c.lineStart}-${c.lineEnd}`;
      const loc = document.createElement('span');
      loc.className = 'krypton-diff__comments-loc';
      loc.textContent = `${c.file}:${range}`;

      const note = document.createElement('span');
      note.className = 'krypton-diff__comments-note';
      note.textContent = c.body;

      if (c.sent) {
        const tag = document.createElement('span');
        tag.className = 'krypton-diff__comments-tag';
        tag.textContent = 'sent';
        row.appendChild(tag);
      }
      row.appendChild(loc);
      row.appendChild(note);
      row.addEventListener('click', () => {
        this.commentsSelectedIndex = i;
        this.jumpToComment();
      });
      items.appendChild(row);
    });

    const footer = document.createElement('div');
    footer.className = 'krypton-diff__comments-footer';
    footer.textContent = 'j/k move · Enter jump · d delete · [ ] target · s send · Esc close';
    root.appendChild(footer);

    (items.children[this.commentsSelectedIndex] as HTMLElement | undefined)
      ?.scrollIntoView({ block: 'nearest' });
  }

  // ─── Pin markers ───

  /** Find the line-number cell for a (side, line) anchor in the current render,
   *  across both diff2html renderers. Null if the line is no longer present. */
  private findLineCell(side: 'old' | 'new', line: number): Element | null {
    const want = String(line);
    // Line-by-line: .line-num1 (old) / .line-num2 (new) inside .d2h-code-linenumber.
    const numClass = side === 'new' ? '.line-num2' : '.line-num1';
    for (const el of this.fileContainer.querySelectorAll(numClass)) {
      if ((el.textContent ?? '').trim() === want) return el.closest('.d2h-code-linenumber');
    }
    // Side-by-side: pick the matching panel, then the number cell.
    const panels = this.fileContainer.querySelectorAll('.d2h-file-side-diff');
    const panel = side === 'new' ? panels[1] : panels[0];
    if (panel) {
      for (const el of panel.querySelectorAll('.d2h-code-side-linenumber')) {
        if ((el.textContent ?? '').trim() === want) return el;
      }
    }
    return null;
  }

  /** Mark commented lines on the current file. Best-effort: a comment whose line
   *  drifted after a refresh simply shows no pin (its stored anchor is intact). */
  private renderPins(): void {
    if (!this.review) return;
    const file = this.currentFilePath();
    if (!file) return;
    for (const c of this.comments) {
      if (c.file !== file) continue;
      const cell = this.findLineCell(c.side, c.lineStart);
      if (!cell || cell.querySelector('.krypton-diff__pin')) continue;
      const pin = document.createElement('span');
      pin.className = 'krypton-diff__pin';
      pin.textContent = '●';
      pin.title = c.sent ? `sent: ${c.body}` : c.body;
      cell.appendChild(pin);
    }
  }

  private renderCurrentFile(): void {
    this.renderNav();
    this.fileContainer.innerHTML = '';

    const file = this.files[this.currentFileIndex];
    if (!file) return;

    // Use cheaper matching for large diffs to avoid O(n²) slowdown
    const totalLines = file.addedLines + file.deletedLines;
    const matching = totalLines > 500 ? 'none' as const : 'lines' as const;

    // Wrap in dark color scheme container
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-dark-color-scheme';
    this.fileContainer.appendChild(wrapper);

    // Render with Diff2HtmlUI for built-in syntax highlighting
    const ui = new Diff2HtmlUI(wrapper, [file], {
      outputFormat: this.diffStyle,
      drawFileList: false,
      colorScheme: 'dark' as never,
      diffStyle: 'word',
      matching,
      maxLineSizeInBlockForComparison: 200,
      maxLineLengthHighlight: 10000,
      renderNothingWhenEmpty: false,
      highlight: true,
      synchronisedScroll: this.diffStyle === 'side-by-side',
    });
    ui.draw();
    // Pins must run AFTER draw — renderNav (which runs before the redraw) would
    // mark the about-to-be-deleted DOM (Codex-1 Warning-1).
    this.renderPins();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    // Composer is a focused <textarea>: intercept only submit/cancel, let every
    // other key fall through (return false) so typing reaches the textarea.
    if (this.composerEl && !this.composerEl.hidden) return this.onComposerKey(e);
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (this.listOpen) return this.onFileListKey(e);
    if (this.commentsOverlayOpen) return this.onCommentsKey(e);

    // Review comments (spec 158)
    if (this.review) {
      if (e.key === 'c') {
        this.startComment();
        return true;
      }
      if (e.key === 'C') {
        this.openCommentsOverlay();
        return true;
      }
    }

    switch (e.key) {
      case 'j':
        this.fileContainer.scrollBy({ top: 40, behavior: 'auto' });
        return true;
      case 'k':
        this.fileContainer.scrollBy({ top: -40, behavior: 'auto' });
        return true;
      case 'h':
        this.scrollHorizontal(-40);
        return true;
      case 'l':
        this.scrollHorizontal(40);
        return true;
      case 'f':
        this.fileContainer.scrollBy({ top: this.fileContainer.clientHeight * 0.9, behavior: 'auto' });
        return true;
      case 'b':
        this.fileContainer.scrollBy({ top: -this.fileContainer.clientHeight * 0.9, behavior: 'auto' });
        return true;
      case 'g':
        if (e.shiftKey) {
          this.fileContainer.scrollTo({ top: this.fileContainer.scrollHeight, behavior: 'auto' });
        } else {
          this.fileContainer.scrollTo({ top: 0, behavior: 'auto' });
        }
        return true;
      case 'n':
        this.navigateHunk(e.shiftKey ? -1 : 1);
        return true;
      case 'N':
        this.navigateHunk(-1);
        return true;
      case ']':
        this.navigateFile(1);
        return true;
      case '[':
        this.navigateFile(-1);
        return true;
      case 's':
        this.toggleDiffStyle();
        return true;
      case 't':
        if (this.files.length > 0) this.openFileList();
        return true;
      case 'r':
        // Manual refresh — explicit human intent, no debounce (ADR-0008's
        // mid-turn escape hatch).
        if (!this.refreshProvider) return false;
        if (this.debounceTimer !== null) {
          window.clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
        void this.doRefresh();
        return true;
      case 'q':
      case 'Escape':
        if (this.closeCallback) this.closeCallback();
        return true;
      default:
        return false;
    }
  }

  private scrollHorizontal(delta: number): void {
    // In side-by-side mode, .d2h-file-side-diff is the per-panel scrollable
    // container (overflow-x: scroll). In unified mode the scroll container is
    // .d2h-file-diff — its overflow-y: hidden makes overflow-x compute to
    // auto, so long lines overflow there, never reaching fileContainer.
    const panels = this.fileContainer.querySelectorAll<HTMLElement>('.d2h-file-side-diff');
    if (panels.length > 0) {
      panels.forEach((p) => p.scrollBy({ left: delta, behavior: 'auto' }));
    } else {
      const unified = this.fileContainer.querySelector<HTMLElement>('.d2h-file-diff');
      (unified ?? this.fileContainer).scrollBy({ left: delta, behavior: 'auto' });
    }
  }

  private navigateFile(delta: number): void {
    if (this.files.length <= 1) return;
    this.currentFileIndex = (this.currentFileIndex + delta + this.files.length) % this.files.length;
    this.renderCurrentFile();
  }

  private navigateHunk(delta: number): void {
    // Navigate between diff blocks (d2h-diff-tbody sections)
    const blocks = this.fileContainer.querySelectorAll('.d2h-diff-tbody');
    if (blocks.length === 0) {
      this.fileContainer.scrollBy({ top: delta * 200, behavior: 'auto' });
      return;
    }

    const scrollTop = this.fileContainer.scrollTop;
    const containerTop = this.fileContainer.getBoundingClientRect().top;
    let target: Element | null = null;

    if (delta > 0) {
      for (const block of blocks) {
        const offset = block.getBoundingClientRect().top - containerTop + scrollTop;
        if (offset > scrollTop + 10) {
          target = block;
          break;
        }
      }
    } else {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const offset = blocks[i].getBoundingClientRect().top - containerTop + scrollTop;
        if (offset < scrollTop - 10) {
          target = blocks[i];
          break;
        }
      }
    }

    if (target) {
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }

  private toggleDiffStyle(): void {
    this.diffStyle = this.diffStyle === 'side-by-side' ? 'line-by-line' : 'side-by-side';
    this.renderCurrentFile();
  }

  // ─── File-list quick-switcher (modal overlay) ───

  /** Display path for a file, with rename arrow. Shared by the nav bar and
   *  the file-list overlay so both label files identically. */
  private filePath(file: DiffFile): string {
    const isRename = file.oldName && file.newName && file.oldName !== file.newName
      && file.oldName !== '/dev/null' && file.newName !== '/dev/null';
    return isRename
      ? `${file.oldName} → ${file.newName}`
      : file.newName === '/dev/null' ? file.oldName || 'unknown'
      : file.newName || file.oldName || 'unknown';
  }

  /** Single-letter status derived the same way as the nav-bar rename check —
   *  A(dded) / D(eleted) / R(enamed) / M(odified). */
  private fileStatus(file: DiffFile): { letter: string; label: string } {
    if (file.newName === '/dev/null') return { letter: 'D', label: 'deleted' };
    if (file.oldName === '/dev/null') return { letter: 'A', label: 'added' };
    if (file.oldName && file.newName && file.oldName !== file.newName) {
      return { letter: 'R', label: 'renamed' };
    }
    return { letter: 'M', label: 'modified' };
  }

  private openFileList(): void {
    this.listOpen = true;
    this.listSelectedIndex = this.currentFileIndex;
    this.listEl.hidden = false;
    this.renderFileList();
  }

  private closeFileList(): void {
    this.listOpen = false;
    this.listEl.hidden = true;
  }

  /** Keys while the overlay is open. Swallows everything (returns true) so the
   *  diff underneath never scrolls behind the picker; Escape/q/t dismiss. */
  private onFileListKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        this.moveListSelection(1);
        return true;
      case 'k':
      case 'ArrowUp':
        this.moveListSelection(-1);
        return true;
      case 'g':
        this.listSelectedIndex = e.shiftKey ? this.files.length - 1 : 0;
        this.renderFileList();
        return true;
      case 'Enter':
      case ' ':
        this.confirmFileList();
        return true;
      case 't':
      case 'q':
      case 'Escape':
        this.closeFileList();
        return true;
      default:
        return true;
    }
  }

  private moveListSelection(delta: number): void {
    if (this.files.length === 0) return;
    this.listSelectedIndex =
      (this.listSelectedIndex + delta + this.files.length) % this.files.length;
    this.renderFileList();
  }

  private confirmFileList(): void {
    const target = this.listSelectedIndex;
    this.closeFileList();
    if (target !== this.currentFileIndex && this.files[target]) {
      this.currentFileIndex = target;
      this.renderCurrentFile();
    }
  }

  private renderFileList(): void {
    this.listEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'krypton-diff__filelist-header';
    header.textContent =
      `${this.files.length} ${this.files.length === 1 ? 'file' : 'files'} changed`;
    this.listEl.appendChild(header);

    const items = document.createElement('div');
    items.className = 'krypton-diff__filelist-items';
    this.listEl.appendChild(items);

    this.files.forEach((file, i) => {
      const row = document.createElement('div');
      row.className = 'krypton-diff__filelist-item';
      if (i === this.listSelectedIndex) row.classList.add('krypton-diff__filelist-item--selected');
      if (i === this.currentFileIndex) row.classList.add('krypton-diff__filelist-item--current');

      const status = this.fileStatus(file);
      const badge = document.createElement('span');
      badge.className =
        `krypton-diff__filelist-status krypton-diff__filelist-status--${status.letter.toLowerCase()}`;
      badge.textContent = status.letter;
      badge.title = status.label;

      const path = document.createElement('span');
      path.className = 'krypton-diff__filelist-path';
      path.textContent = this.filePath(file);

      const stats = document.createElement('span');
      stats.className = 'krypton-diff__filelist-stats';
      stats.innerHTML =
        `<span class="krypton-diff__adds">+${file.addedLines}</span> <span class="krypton-diff__dels">-${file.deletedLines}</span>`;

      row.appendChild(badge);
      row.appendChild(path);
      row.appendChild(stats);
      // Mouse is secondary, but a click jumps straight to the file.
      row.addEventListener('click', () => {
        this.listSelectedIndex = i;
        this.confirmFileList();
      });
      items.appendChild(row);
    });

    (items.children[this.listSelectedIndex] as HTMLElement | undefined)
      ?.scrollIntoView({ block: 'nearest' });
  }

  // ─── Live refresh (spec 155 / ADR-0008) ───

  /** Event-driven refresh request (lane quiet point). Debounced; deferred to
   *  a dirty flag while the hosting tab is hidden. */
  requestRefresh(): void {
    if (!this.refreshProvider) return;
    if (this.element.offsetParent === null) {
      this.dirty = true;
      return;
    }
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.doRefresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Reveal hook — a hidden tab that went dirty refreshes exactly once. */
  onShow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    void this.doRefresh();
  }

  /** Number of files in the current diff (drives the tab title). */
  fileCount(): number {
    return this.files.length;
  }

  /** Invoked after every applied refresh with the new file count. */
  onRefreshed(cb: (fileCount: number) => void): void {
    this.refreshedCallback = cb;
  }

  /** Cleanup hook run from dispose() — e.g. the compositor's bus unsubscribe. */
  addDisposeListener(cb: () => void): void {
    this.disposeListeners.push(cb);
  }

  private async doRefresh(): Promise<void> {
    if (!this.refreshProvider) return;
    if (this.refreshing) {
      // Coalesce: one trailing refresh after the in-flight one completes.
      this.trailingRefresh = true;
      return;
    }
    this.refreshing = true;
    this.updateSyncIndicator();
    try {
      const result = await this.refreshProvider();
      this.syncFailed = false;
      this.lastSyncedAt = new Date();
      this.applyRefresh(result);
    } catch {
      // Keep the last rendered diff; the indicator reports the failure and
      // the next trigger (or `r`) retries.
      this.syncFailed = true;
      this.lastSyncedAt = new Date();
    } finally {
      this.refreshing = false;
      this.updateSyncIndicator();
      if (this.trailingRefresh) {
        this.trailingRefresh = false;
        void this.doRefresh();
      }
    }
  }

  private applyRefresh(result: WorkingDiffResult): void {
    const prevKey = this.files[this.currentFileIndex]
      ? this.fileKey(this.files[this.currentFileIndex])
      : null;
    const prevScroll = this.fileContainer.scrollTop;

    // A parse failure must propagate to doRefresh's catch: swallowing it here
    // would erase the last valid snapshot and report a clean sync. A truly
    // empty diff (no changes) parses to [] without throwing, so the empty
    // state below remains reachable only for genuine emptiness (Codex-1 review).
    const parsed = parse(result.diff);

    this.files = parsed;
    this.skipped = result.skipped;
    this.renderSkipped();

    if (this.files.length === 0) {
      this.currentFileIndex = 0;
      this.renderEmpty();
      this.refreshedCallback?.(0);
      return;
    }

    // Preserve the file the human was reading; if it left the diff, clamp to
    // the nearest index and reset scroll.
    const matched = prevKey === null
      ? -1
      : this.files.findIndex((f) => this.fileKey(f) === prevKey);
    const samePath = matched >= 0;
    this.currentFileIndex = samePath
      ? matched
      : Math.min(this.currentFileIndex, this.files.length - 1);
    this.renderCurrentFile();
    this.fileContainer.scrollTop = samePath ? prevScroll : 0;
    // If the picker is open, rebuild it against the new file set and keep the
    // selection in range.
    if (this.listOpen) {
      this.listSelectedIndex = Math.min(this.listSelectedIndex, this.files.length - 1);
      this.renderFileList();
    }
    this.refreshedCallback?.(this.files.length);
  }

  private fileKey(file: DiffFile): string {
    return file.newName === '/dev/null'
      ? (file.oldName ?? '')
      : (file.newName ?? file.oldName ?? '');
  }

  /** Static freshness text — never blinks or pulses, same philosophy as the
   *  backpressure gauge. */
  private syncText(): string {
    const at = this.lastSyncedAt
      ? this.lastSyncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
    if (this.refreshing) return 'refreshing…';
    if (this.syncFailed) return at ? `sync failed ${at}` : 'sync failed';
    return at ? `synced ${at}` : '';
  }

  private appendSyncIndicator(): void {
    if (!this.refreshProvider) {
      this.syncEl = null;
      return;
    }
    const sync = document.createElement('span');
    sync.className = 'krypton-diff__sync';
    sync.textContent = this.syncText();
    this.navEl.appendChild(sync);
    this.syncEl = sync;
  }

  private updateSyncIndicator(): void {
    if (this.syncEl) this.syncEl.textContent = this.syncText();
  }

  private renderSkipped(): void {
    this.skippedEl.innerHTML = '';
    this.skippedEl.hidden = this.skipped.length === 0;
    if (this.skipped.length === 0) return;
    const reasonLabel = (r: string): string =>
      r === 'too_large' ? 'too large' : r;
    this.skippedEl.textContent =
      `not rendered: ${this.skipped.map((s) => `${s.path} (${reasonLabel(s.reason)})`).join(' · ')}`;
  }

  onResize(): void {
    // diff2html handles its own layout via CSS
  }

  dispose(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const cb of this.disposeListeners) cb();
    this.disposeListeners = [];
    this.element.remove();
  }
}
