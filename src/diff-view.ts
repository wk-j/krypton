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
  ReviewPriorityRange,
  ReviewPrioritySnapshot,
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

/** Channel for pulling the authoring lane's diff review-priority report (spec
 *  160). Resolved on demand (a pull, no broadcast) — same broker pattern as the
 *  review channel; the diff view stays decoupled from the harness. */
export interface ReviewPriorityChannel {
  resolve: () => Promise<ReviewPrioritySnapshot>;
}

export interface DiffViewOptions {
  skipped?: SkippedFile[];
  /** Re-collects the working diff (spec 155). When absent the view is a
   *  static snapshot, exactly as before — no `r` key, no sync indicator. */
  refreshProvider?: () => Promise<WorkingDiffResult>;
  /** Inline review comments (spec 158). Absent when no harness backs the repo. */
  review?: DiffReviewChannel;
  /** Lane-reported reading-order hints (spec 160). Absent when no harness backs
   *  the repo; when present the view pre-triages the diff (fold/mark). */
  reviewPriority?: ReviewPriorityChannel;
}

/** A hunk's rows partitioned out of a panel tbody (spec 160 folding). */
interface RenderedHunk {
  /** the @@-block-header `<tr>`, or null for a leading headerless run. */
  header: Element | null;
  /** the content `<tr>` rows of the hunk (excludes the header). */
  rows: Element[];
}

/** One hunk's pre-measured focus-tracking entry (spec 158 ext), built once per
 *  render so scrolling only does cheap math against `bottom`. */
interface FocusEntry {
  /** scroll-space bottom offset of the hunk (independent of current scrollTop). */
  bottom: number;
  /** new-panel content rows — the anchor + nav-readout source. */
  newRows: Element[];
  /** every row to mark (header + content, both panels in side-by-side). */
  rows: Element[];
  /** the header cell that hosts the `← here` chip, or null. */
  chipCell: Element | null;
  /** new-side line span for the nav readout, null for a pure-deletion hunk. */
  range: { lineStart: number; lineEnd: number } | null;
}

/** Per-hunk review priority — the highest level of any reported range
 *  overlapping the hunk's new-side lines (spec 160). */
export type HunkPriority = 'high' | 'normal' | 'routine';

/** The priority a hunk spanning new-side lines [lo, hi] takes: the highest level
 *  (`high` > `routine`) of any reported range overlapping it; `normal` if none
 *  overlap. Pure — the folding/marking authority of spec 160 lives here so the
 *  "high wins / no-overlap → normal / drift → normal" rule (ADR-0009) is
 *  testable without the diff2html DOM. */
export function priorityForLineRange(
  lo: number,
  hi: number,
  ranges: ReviewPriorityRange[],
): HunkPriority {
  let result: HunkPriority = 'normal';
  for (const r of ranges) {
    if (r.lineEnd < lo || r.lineStart > hi) continue; // no overlap
    if (r.level === 'high') return 'high'; // high wins outright
    result = 'routine';
  }
  return result;
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

  // Keybindings help overlay (modal)
  private helpEl: HTMLElement;
  private helpOpen = false;

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

  // Review priority (spec 160) — lane-reported reading-order hints. The window
  // FOLDS routine hunks (expandable) and MARKS + navigates to high ones; it
  // never hides or reorders. Empty ranges = today's full diff (safe degrade).
  private reviewPriority: ReviewPriorityChannel | null;
  private priorityRanges: ReviewPriorityRange[] = [];
  /** Routine folds the human expanded, keyed `${fileKey}#${hunkIndex}`. Remembered
   *  for the session so a refresh / re-render keeps them open. */
  private expandedHunks = new Set<string>();
  /** High-priority hunk header rows in the current file's new panel, in file
   *  order — the targets of `{`/`}` priority navigation. */
  private highHunkAnchors: Element[] = [];
  /** Priority panel (spec 160 ext) — a cross-file dock that live-PREVIEWS every
   *  reported range (`high` first, then `routine`) as you walk it with `j`/`k`,
   *  no `Enter` needed. Docks right of the diff (`hidden` when closed, so the
   *  diff reflows to full width). `}`/`{` still do in-file high-hunk nav. */
  private priorityListEl: HTMLElement | null = null;
  private priorityOpen = false;
  private prioritySelectedIndex = 0;
  /** Reported ranges resolved to a diff file index (drift-dropped), sorted
   *  high→routine then file order — the panel rows + preview targets. */
  private priorityItems: { range: ReviewPriorityRange; fileIndex: number }[] = [];
  /** Where the diff sat when the panel opened, so `Esc` can restore it (a
   *  cancelled browse); `Enter`/`q`/`p` keep the previewed position instead. */
  private priorityReturnFile = 0;
  private priorityReturnScroll = 0;
  /** Coalesces cross-file re-renders while `j`/`k` is held — same-file moves
   *  scroll immediately, file switches wait out a brief pause. */
  private priorityPreviewTimer: number | null = null;
  /** Focus-hunk indicator (spec 158 ext) — the hunk at the top of the viewport is
   *  the one `c` anchors to / `n`·`N` step from, so it gets a header marker (A) +
   *  a `hunk L<a>–<b>` nav readout (B), tracked on scroll (rAF-throttled). */
  private focusReadoutEl: HTMLElement | null = null;
  private focusRaf: number | null = null;
  /** Per-hunk focus entries for the current file (rebuilt each render); scrolling
   *  reads these instead of re-walking the DOM. */
  private focusCache: FocusEntry[] = [];
  /** Index of the currently-marked focus hunk in `focusCache`, or -1. Lets the
   *  scroll handler skip all DOM work while the focus hunk is unchanged. */
  private focusIndex = -1;

  constructor(unifiedDiff: string, container: HTMLElement, options?: DiffViewOptions) {
    this.refreshProvider = options?.refreshProvider ?? null;
    this.review = options?.review ?? null;
    this.reviewPriority = options?.reviewPriority ?? null;
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

    // Content row: the diff (grows) beside the priority panel (docks right,
    // shrinks the diff only while open). A flex row so the diff reflows on its
    // own when the panel hides — no manual width math, no re-render.
    const contentRow = document.createElement('div');
    contentRow.className = 'krypton-diff__content-row';
    this.element.appendChild(contentRow);

    // Diff content area
    this.fileContainer = document.createElement('div');
    this.fileContainer.className = 'krypton-diff__content';
    contentRow.appendChild(this.fileContainer);

    // Track the focus hunk (the one `c`/`n` act on) as the human scrolls. Coalesced
    // to one update per frame, and — crucially — driven off a cache built at render
    // time so a scroll only does cheap arithmetic + touches the DOM when the focus
    // hunk actually changes (no per-frame splitHunks / layout reads / writes).
    const onScroll = (): void => {
      if (this.focusRaf !== null) return;
      this.focusRaf = window.requestAnimationFrame(() => {
        this.focusRaf = null;
        this.applyFocusMarker(this.computeFocusIndex());
      });
    };
    this.fileContainer.addEventListener('scroll', onScroll, { passive: true });
    this.disposeListeners.push(() => this.fileContainer.removeEventListener('scroll', onScroll));

    // Priority panel (spec 160 ext) — docked, hidden until toggled with `p`.
    if (this.reviewPriority) {
      this.priorityListEl = document.createElement('div');
      this.priorityListEl.className = 'krypton-diff__priority';
      this.priorityListEl.hidden = true;
      contentRow.appendChild(this.priorityListEl);
    }

    // File-list overlay — hidden until toggled with `t`
    this.listEl = document.createElement('div');
    this.listEl.className = 'krypton-diff__filelist';
    this.listEl.hidden = true;
    this.element.appendChild(this.listEl);

    // Keybindings help overlay — hidden until toggled with `?`
    this.helpEl = document.createElement('div');
    this.helpEl.className = 'krypton-diff__help';
    this.helpEl.hidden = true;
    this.element.appendChild(this.helpEl);

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

    // spec 160: pull the lane's reading-order hints. The full diff is already
    // on screen (above); this re-renders once with folds/markers when it
    // resolves (an in-process control call), so the human first sees everything,
    // then the routine churn collapses — never the other way around.
    if (this.reviewPriority) void this.refreshPriority();
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
    this.appendHelpHint();
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
    this.appendFocusReadout();
    this.appendPrioritySummary();
    this.appendReviewIndicator();
    this.appendSyncIndicator();
    this.appendHelpHint();
  }

  /** Static `N high · N routine` count of the lane's reported ranges across the
   *  whole diff (spec 160) — depth, never motion, matching the sync/backpressure
   *  philosophy. Counts reported regions, not folded hunks (a region is the unit
   *  the lane chose to flag). Hidden when nothing was reported. */
  private appendPrioritySummary(): void {
    if (!this.reviewPriority || this.priorityRanges.length === 0) return;
    const high = this.priorityRanges.filter((r) => r.level === 'high').length;
    const routine = this.priorityRanges.filter((r) => r.level === 'routine').length;
    const parts: string[] = [];
    if (high > 0) parts.push(`${high} high`);
    if (routine > 0) parts.push(`${routine} routine`);
    if (parts.length === 0) return;
    const el = document.createElement('span');
    el.className = 'krypton-diff__priority-summary';
    el.textContent = parts.join(' · ');
    this.navEl.appendChild(el);
  }

  /** Focus-hunk readout (spec 158 ext, B) — `hunk L<a>–<b>` for the hunk `c` would
   *  anchor to. Created here each render; the scroll handler updates its text via
   *  the stored ref. Hidden until `applyFocusMarker` populates it. */
  private appendFocusReadout(): void {
    const el = document.createElement('span');
    el.className = 'krypton-diff__focus';
    el.hidden = true;
    this.focusReadoutEl = el;
    this.navEl.appendChild(el);
  }

  /** Static `? help` affordance at the end of the nav bar so the keybindings
   *  overlay is discoverable. Chrome text, no border rail. */
  private appendHelpHint(): void {
    const el = document.createElement('span');
    el.className = 'krypton-diff__help-hint';
    // Advertise the priority panel only when there is something to jump to.
    const hasPriority = !!this.reviewPriority && this.priorityRanges.length > 0;
    el.textContent = hasPriority ? 'p priority · ? help' : '? help';
    this.navEl.appendChild(el);
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

  /** New-side line span of a hunk (for the nav readout); null for a pure-deletion
   *  hunk with no new-side lines. */
  private hunkNewRange(hunk: RenderedHunk): { lineStart: number; lineEnd: number } | null {
    const lines: number[] = [];
    for (const row of hunk.rows) {
      const info = this.lineInfoForRow(row);
      if (info && info.side === 'new') lines.push(info.line);
    }
    if (lines.length === 0) return null;
    return { lineStart: Math.min(...lines), lineEnd: Math.max(...lines) };
  }

  /** Build the focus cache once per render: split the new (and paired old) panel
   *  tbody into hunks and pre-measure each hunk's scroll-space bottom. diff2html
   *  emits ONE tbody per file per side with hunks separated by `.d2h-info` headers,
   *  so the hunk unit comes from `splitHunks`, not a per-tbody pick. After this,
   *  scrolling never re-walks the DOM — it only compares `scrollTop` to `bottom`. */
  private rebuildFocusCache(): void {
    this.focusCache = [];
    this.focusIndex = -1;
    const panels = Array.from(this.fileContainer.querySelectorAll('.d2h-file-side-diff'));
    const sideBySide = panels.length > 1;
    // NEW (right) panel in side-by-side so anchors land on editable post-change
    // lines (Codex-1 B2); line-by-line has one tbody whose cells carry both.
    const newScope: ParentNode = sideBySide ? panels[1] : this.fileContainer;
    const newTbody = newScope.querySelector('.d2h-diff-tbody');
    if (!newTbody) {
      this.setFocusReadout(null);
      return;
    }
    const newHunks = this.splitHunks(newTbody);
    if (newHunks.length === 0) {
      this.setFocusReadout(null);
      return;
    }
    const oldTbody = sideBySide ? panels[0]?.querySelector('.d2h-diff-tbody') ?? null : null;
    const oldHunks = oldTbody ? this.splitHunks(oldTbody) : [];

    const containerTop = this.fileContainer.getBoundingClientRect().top;
    const scrollTop = this.fileContainer.scrollTop;
    newHunks.forEach((h, i) => {
      const old = oldHunks[i] ?? null;
      const els = [h.header, ...h.rows].filter((e): e is Element => !!e);
      const last = els[els.length - 1];
      const bottom = last ? last.getBoundingClientRect().bottom - containerTop + scrollTop : 0;
      const chipHost = old?.header ?? h.header;
      const chipCell =
        chipHost?.querySelector('.d2h-code-side-line, .d2h-code-line') ??
        chipHost?.lastElementChild ??
        null;
      const rows = [h.header, ...h.rows, old?.header ?? null, ...(old?.rows ?? [])].filter(
        (e): e is Element => !!e,
      );
      this.focusCache.push({ bottom, newRows: h.rows, rows, chipCell, range: this.hunkNewRange(h) });
    });
    this.applyFocusMarker(this.computeFocusIndex());
  }

  /** Index of the focus hunk (first whose bottom is below the viewport top; the
   *  last if all are scrolled past). Pure arithmetic against the cache — no DOM. */
  private computeFocusIndex(): number {
    if (this.focusCache.length === 0) return -1;
    const scrollTop = this.fileContainer.scrollTop;
    const idx = this.focusCache.findIndex((c) => c.bottom > scrollTop);
    return idx < 0 ? this.focusCache.length - 1 : idx;
  }

  /** Move the focus marker (A) + readout (B) to `idx`. Returns immediately when
   *  the focus hunk is unchanged, so a scroll within one hunk does zero DOM work.
   *  Marks every row of the hunk (both panels) — the marker shows on the gutter,
   *  visible wherever the human is in the hunk, not just on the (possibly
   *  scrolled-off) header. */
  private applyFocusMarker(idx: number): void {
    if (idx === this.focusIndex) return;
    const prev = this.focusIndex >= 0 ? this.focusCache[this.focusIndex] : null;
    if (prev) for (const r of prev.rows) r.classList.remove('krypton-diff__hunk-focus');
    for (const chip of Array.from(this.fileContainer.querySelectorAll('.krypton-diff__here'))) {
      chip.remove();
    }
    this.focusIndex = idx;
    const entry = idx >= 0 ? this.focusCache[idx] : null;
    if (!entry) {
      this.setFocusReadout(null);
      return;
    }
    for (const r of entry.rows) r.classList.add('krypton-diff__hunk-focus');
    if (entry.chipCell && !entry.chipCell.querySelector('.krypton-diff__here')) {
      const chip = document.createElement('span');
      chip.className = 'krypton-diff__here';
      chip.textContent = '← here';
      entry.chipCell.appendChild(chip);
    }
    this.setFocusReadout(entry.range);
  }

  private currentHunkAnchor(file: string): CapturedAnchor | null {
    const idx = this.computeFocusIndex();
    if (idx < 0) return null;
    const block = this.focusCache[idx];

    const infos = block.newRows
      .map((row) => this.lineInfoForRow(row))
      .filter((i): i is { side: 'old' | 'new'; line: number } => i !== null);
    if (infos.length === 0) return null;
    const preferred = infos.filter((i) => i.side === 'new');
    const chosen = preferred.length > 0 ? preferred : infos;
    const side = chosen[0].side;
    const lines = chosen.filter((i) => i.side === side).map((i) => i.line);
    const quote = block.newRows
      .map((r) => r.querySelector('.d2h-code-line-ctn')?.textContent ?? '')
      .filter((t) => t.length > 0)
      .join('\n')
      .slice(0, QUOTE_CAP);
    return { file, side, lineStart: Math.min(...lines), lineEnd: Math.max(...lines), quote };
  }

  private setFocusReadout(range: { lineStart: number; lineEnd: number } | null): void {
    const el = this.focusReadoutEl;
    if (!el) return;
    if (!range) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent =
      range.lineStart === range.lineEnd
        ? `hunk L${range.lineStart}`
        : `hunk L${range.lineStart}–${range.lineEnd}`;
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
    // spec 160: fold routine hunks / mark high ones on the freshly-drawn DOM.
    this.applyReviewPriority();
    // spec 158 ext: pre-measure hunks + mark the viewport-top focus hunk + readout.
    this.rebuildFocusCache();
  }

  // ─── Review priority (spec 160) ───

  /** Pull the lane's report on demand and re-render the current file with the
   *  resulting folds/markers. A pull, like the review-targets roster — a freshly
   *  opened or just-refreshed diff always sees current state. */
  private async refreshPriority(): Promise<void> {
    if (!this.reviewPriority) return;
    try {
      const snap = await this.reviewPriority.resolve();
      this.priorityRanges = Array.isArray(snap?.ranges) ? snap.ranges : [];
    } catch {
      this.priorityRanges = [];
    }
    if (this.files.length > 0) {
      const scroll = this.fileContainer.scrollTop;
      this.renderCurrentFile();
      this.fileContainer.scrollTop = scroll;
    }
  }

  /** Fold routine hunks and mark high ones on the current file's drawn DOM.
   *  Maps each git/diff2html hunk to the reported ranges (same file, overlapping
   *  new-side lines) and takes the highest level. A hunk that no range overlaps
   *  stays normal; a range that maps to no hunk is silently dropped — the failure
   *  mode is always under-collapse (show more), never over-collapse (ADR-0009). */
  private applyReviewPriority(): void {
    this.highHunkAnchors = [];
    if (!this.reviewPriority || this.priorityRanges.length === 0) return;
    const file = this.currentFilePath();
    if (!file) return;
    const ranges = this.priorityRanges.filter((r) => r.file === file);
    if (ranges.length === 0) return;

    // The NEW (right) panel carries the post-change line numbers the ranges are
    // anchored to. Side-by-side has two panels (old left / new right); the
    // line-by-line renderer has one tbody whose cells carry both numbers.
    const panels = Array.from(this.fileContainer.querySelectorAll('.d2h-file-side-diff'));
    const sideBySide = panels.length > 1;
    const newScope: ParentNode = sideBySide ? panels[1] : this.fileContainer;
    const newTbody = newScope.querySelector('.d2h-diff-tbody');
    if (!newTbody) return;

    const newHunks = this.splitHunks(newTbody);
    if (newHunks.length === 0) return;
    const oldTbody = sideBySide ? panels[0]?.querySelector('.d2h-diff-tbody') ?? null : null;
    const oldHunks = oldTbody ? this.splitHunks(oldTbody) : [];

    const fileKey = this.fileKey(this.files[this.currentFileIndex]);
    newHunks.forEach((hunk, i) => {
      const level = this.hunkPriority(hunk, ranges);
      const key = `${fileKey}#${i}`;
      if (level === 'routine' && !this.expandedHunks.has(key)) {
        this.foldHunk(hunk, key, true);
        if (oldHunks[i]) this.foldHunk(oldHunks[i], key, false);
      } else if (level === 'high') {
        if (hunk.header) this.highHunkAnchors.push(hunk.header);
        // Badge the header that carries the @@ context text: the old/left panel
        // in side-by-side, or the sole panel in line-by-line. Row tint on both.
        const old = oldHunks[i];
        this.markHigh(hunk, !old);
        if (old) this.markHigh(old, true);
      }
    });
  }

  /** Partition a panel tbody into hunks. diff2html emits ONE tbody per panel
   *  with all hunks inside, each prefixed by a `.d2h-info` block-header row;
   *  hunk index N is the same in both side-by-side panels (paired folding). */
  private splitHunks(tbody: Element | null): RenderedHunk[] {
    if (!tbody) return [];
    const hunks: RenderedHunk[] = [];
    let cur: RenderedHunk | null = null;
    for (const row of Array.from(tbody.children)) {
      if (row.tagName !== 'TR') continue;
      if (row.querySelector('.d2h-info')) {
        cur = { header: row, rows: [] };
        hunks.push(cur);
      } else {
        if (!cur) {
          cur = { header: null, rows: [] };
          hunks.push(cur);
        }
        cur.rows.push(row);
      }
    }
    return hunks;
  }

  /** Highest priority of any reported range overlapping the hunk's new-side
   *  lines. A hunk with no new-side lines (pure deletion) can't be anchored on
   *  the new side and stays normal. */
  private hunkPriority(hunk: RenderedHunk, ranges: ReviewPriorityRange[]): HunkPriority {
    const lines: number[] = [];
    for (const row of hunk.rows) {
      const info = this.lineInfoForRow(row);
      if (info && info.side === 'new') lines.push(info.line);
    }
    if (lines.length === 0) return 'normal';
    return priorityForLineRange(Math.min(...lines), Math.max(...lines), ranges);
  }

  /** Collapse a routine hunk's content rows to a single in-place summary row.
   *  `withLabel` shows the count on the new (right) panel only — the old panel's
   *  spacer keeps the side-by-side rows aligned without duplicating the text. */
  private foldHunk(hunk: RenderedHunk, key: string, withLabel: boolean): void {
    if (hunk.rows.length === 0) return;
    const colSpan = hunk.rows[0].children.length || 2;
    for (const row of hunk.rows) (row as HTMLElement).style.display = 'none';
    const summary = document.createElement('tr');
    summary.className = 'krypton-diff__fold';
    summary.dataset.foldKey = key;
    const cell = document.createElement('td');
    cell.colSpan = colSpan;
    cell.className = 'krypton-diff__fold-cell';
    if (withLabel) {
      const n = hunk.rows.length;
      cell.textContent = `▸ ${n} routine line${n === 1 ? '' : 's'} — Enter to expand`;
    } else {
      cell.innerHTML = '&nbsp;';
    }
    summary.appendChild(cell);
    const anchor = hunk.header ?? hunk.rows[0];
    anchor.parentElement?.insertBefore(
      summary,
      hunk.header ? hunk.header.nextSibling : hunk.rows[0],
    );
    // Mouse is secondary, but a click on the summary expands the fold.
    summary.addEventListener('click', () => this.expandHunk(key));
  }

  /** Expand a folded hunk: remember it open for the session and re-render (which
   *  rebuilds the rows the fold hid). Scroll is preserved. */
  private expandHunk(key: string): void {
    this.expandedHunks.add(key);
    const scroll = this.fileContainer.scrollTop;
    this.renderCurrentFile();
    this.fileContainer.scrollTop = scroll;
  }

  /** Mark a high hunk: a full-cell tint on its rows + a heading-colour badge on
   *  the block header. Never a left accent rail (house rule). */
  private markHigh(hunk: RenderedHunk, withBadge: boolean): void {
    for (const row of hunk.rows) row.classList.add('krypton-diff__hl-high');
    if (withBadge && hunk.header && !hunk.header.querySelector('.krypton-diff__high-badge')) {
      const badge = document.createElement('span');
      badge.className = 'krypton-diff__high-badge';
      badge.textContent = '◆ high';
      const content = hunk.header.querySelector('.d2h-code-side-line, .d2h-code-line') ?? hunk.header.lastElementChild;
      content?.appendChild(badge);
    }
  }

  /** Jump to the next/previous high hunk (spec 160). Distinct from n/N which walk
   *  all hunks — this targets only what the lane flagged high. */
  private navigateHighHunk(delta: number): void {
    if (this.highHunkAnchors.length === 0) return;
    const scrollTop = this.fileContainer.scrollTop;
    const containerTop = this.fileContainer.getBoundingClientRect().top;
    const offsets = this.highHunkAnchors.map(
      (el) => el.getBoundingClientRect().top - containerTop + scrollTop,
    );
    let target: Element | null = null;
    if (delta > 0) {
      for (let i = 0; i < offsets.length; i++) {
        if (offsets[i] > scrollTop + 10) {
          target = this.highHunkAnchors[i];
          break;
        }
      }
      target = target ?? this.highHunkAnchors[0]; // wrap to first
    } else {
      for (let i = offsets.length - 1; i >= 0; i--) {
        if (offsets[i] < scrollTop - 10) {
          target = this.highHunkAnchors[i];
          break;
        }
      }
      target = target ?? this.highHunkAnchors[this.highHunkAnchors.length - 1];
    }
    target?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  /** Expand the routine fold nearest the top of the viewport (Enter). Returns
   *  true if one was expanded. */
  private expandNearestFold(): boolean {
    const folds = Array.from(this.fileContainer.querySelectorAll<HTMLElement>('.krypton-diff__fold'));
    if (folds.length === 0) return false;
    const containerTop = this.fileContainer.getBoundingClientRect().top;
    const target =
      folds.find((f) => f.getBoundingClientRect().bottom - containerTop > 0) ?? folds[0];
    const key = target.dataset.foldKey;
    if (!key) return false;
    this.expandHunk(key);
    return true;
  }

  // ─── Priority panel (spec 160 ext) — cross-file live-preview dock ───

  /** Resolve every reported range to a diff file index, dropping ranges whose
   *  file is not in the current diff (drift), and sort `high` first then by file
   *  order. Builds the panel rows + the preview targets. */
  private buildPriorityItems(): void {
    this.priorityItems = [];
    for (const range of this.priorityRanges) {
      const fileIndex = this.files.findIndex((f) => this.fileKey(f) === range.file);
      if (fileIndex < 0) continue;
      this.priorityItems.push({ range, fileIndex });
    }
    const rank = (level: string): number => (level === 'high' ? 0 : 1);
    this.priorityItems.sort(
      (a, b) =>
        rank(a.range.level) - rank(b.range.level) ||
        a.fileIndex - b.fileIndex ||
        a.range.lineStart - b.range.lineStart,
    );
  }

  /** Open the dock and preview the first item. Remembers the current diff
   *  position so `Esc` can restore it. No-op when nothing was reported. */
  private openPriorityList(): void {
    if (!this.priorityListEl) return;
    this.buildPriorityItems();
    if (this.priorityItems.length === 0) return;
    this.priorityReturnFile = this.currentFileIndex;
    this.priorityReturnScroll = this.fileContainer.scrollTop;
    this.priorityOpen = true;
    this.prioritySelectedIndex = 0;
    this.priorityListEl.hidden = false;
    this.renderPriorityList();
    this.previewSelected(true);
  }

  /** Close the dock. `restore` (Esc) returns the diff to where it was when the
   *  panel opened — a cancelled browse; `Enter`/`q`/`p` keep the previewed spot. */
  private closePriorityList(restore: boolean): void {
    if (!this.priorityOpen) return;
    this.priorityOpen = false;
    if (this.priorityPreviewTimer !== null) {
      window.clearTimeout(this.priorityPreviewTimer);
      this.priorityPreviewTimer = null;
    }
    if (this.priorityListEl) this.priorityListEl.hidden = true;
    this.clearPreviewHighlight();
    if (restore) {
      if (this.currentFileIndex !== this.priorityReturnFile && this.files[this.priorityReturnFile]) {
        this.currentFileIndex = this.priorityReturnFile;
        this.renderCurrentFile();
      }
      this.fileContainer.scrollTop = this.priorityReturnScroll;
    }
  }

  private onPriorityKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        this.movePrioritySelection(1);
        return true;
      case 'k':
      case 'ArrowUp':
        this.movePrioritySelection(-1);
        return true;
      case 'g':
        this.jumpPrioritySelection(e.shiftKey ? this.priorityItems.length - 1 : 0);
        return true;
      case 'G':
        this.jumpPrioritySelection(this.priorityItems.length - 1);
        return true;
      case 'Enter':
        this.closePriorityList(false);
        return true;
      case 'Escape':
        this.closePriorityList(true);
        return true;
      case 'q':
      case 'p':
        this.closePriorityList(false);
        return true;
      default:
        return true; // modal: swallow everything so the diff never scrolls behind
    }
  }

  private movePrioritySelection(delta: number): void {
    const n = this.priorityItems.length;
    if (n === 0) return;
    this.prioritySelectedIndex = (this.prioritySelectedIndex + delta + n) % n;
    this.renderPriorityList();
    this.previewSelected(false);
  }

  private jumpPrioritySelection(index: number): void {
    const n = this.priorityItems.length;
    if (n === 0) return;
    this.prioritySelectedIndex = Math.max(0, Math.min(index, n - 1));
    this.renderPriorityList();
    this.previewSelected(false);
  }

  /** Live preview: scroll the diff to the selected range and tint it. Same-file
   *  moves are immediate; a file switch needs a re-render, so it is debounced
   *  (~80ms) to coalesce fast `j`/`k` runs — the panel selection still updates
   *  every keystroke, the diff catches up on the pause. `immediate` (open / a
   *  single jump) skips the debounce. */
  private previewSelected(immediate: boolean): void {
    const item = this.priorityItems[this.prioritySelectedIndex];
    if (!item) return;
    if (this.priorityPreviewTimer !== null) {
      window.clearTimeout(this.priorityPreviewTimer);
      this.priorityPreviewTimer = null;
    }
    if (item.fileIndex === this.currentFileIndex) {
      this.highlightAndScrollToRange(item.range);
      return;
    }
    const apply = (): void => {
      this.currentFileIndex = item.fileIndex;
      this.renderCurrentFile();
      this.highlightAndScrollToRange(item.range);
    };
    if (immediate) {
      apply();
    } else {
      this.priorityPreviewTimer = window.setTimeout(() => {
        this.priorityPreviewTimer = null;
        apply();
      }, 80);
    }
  }

  private clearPreviewHighlight(): void {
    for (const el of Array.from(this.fileContainer.querySelectorAll('.krypton-diff__preview-row'))) {
      el.classList.remove('krypton-diff__preview-row');
    }
  }

  /** Tint the hunk overlapping the range and scroll it into view. For a folded
   *  routine hunk the content rows are hidden, so tint + scroll its block header
   *  / fold summary row instead. Best-effort, like the high marker. */
  private highlightAndScrollToRange(range: ReviewPriorityRange): void {
    this.clearPreviewHighlight();
    const panels = Array.from(this.fileContainer.querySelectorAll('.d2h-file-side-diff'));
    const sideBySide = panels.length > 1;
    const newScope: ParentNode = sideBySide ? panels[1] : this.fileContainer;
    const newTbody = newScope.querySelector('.d2h-diff-tbody');
    if (!newTbody) return;
    const hunks = this.splitHunks(newTbody);

    let target: Element | null = null;
    for (const hunk of hunks) {
      const lines: number[] = [];
      for (const row of hunk.rows) {
        const info = this.lineInfoForRow(row);
        if (info && info.side === 'new') lines.push(info.line);
      }
      if (lines.length === 0) continue;
      if (Math.min(...lines) <= range.lineEnd && Math.max(...lines) >= range.lineStart) {
        if (hunk.header) hunk.header.classList.add('krypton-diff__preview-row');
        const visible = hunk.rows.filter((r) => (r as HTMLElement).style.display !== 'none');
        for (const row of visible) row.classList.add('krypton-diff__preview-row');
        // Folded routine hunk: tint its in-place summary row too.
        const fold = (hunk.header?.nextElementSibling ?? hunk.rows[0]?.previousElementSibling) ?? null;
        if (fold && fold.classList.contains('krypton-diff__fold')) {
          fold.classList.add('krypton-diff__preview-row');
        }
        target = hunk.header ?? visible[0] ?? hunk.rows[0];
        break;
      }
    }
    target?.scrollIntoView({ behavior: 'auto', block: 'center' });
  }

  /** Single-letter status badge for a level, mirroring the diff's own markers
   *  (`◆ high`, `▸ routine`) so the panel and the diff body read identically. */
  private renderPriorityList(): void {
    const root = this.priorityListEl;
    if (!root) return;
    root.innerHTML = '';

    const high = this.priorityItems.filter((it) => it.range.level === 'high').length;
    const routine = this.priorityItems.length - high;
    const header = document.createElement('div');
    header.className = 'krypton-diff__priority-head';
    const title = document.createElement('span');
    title.textContent = 'Priority';
    const counts = document.createElement('span');
    counts.className = 'krypton-diff__priority-counts';
    counts.textContent = `${high} high · ${routine} routine`;
    header.appendChild(title);
    header.appendChild(counts);
    root.appendChild(header);

    const items = document.createElement('div');
    items.className = 'krypton-diff__priority-items';
    root.appendChild(items);

    let lastLevel: string | null = null;
    this.priorityItems.forEach((it, i) => {
      if (it.range.level !== lastLevel) {
        lastLevel = it.range.level;
        const group = document.createElement('div');
        group.className = 'krypton-diff__priority-group';
        group.textContent = it.range.level === 'high' ? 'High — read first' : 'Routine — folded';
        items.appendChild(group);
      }
      const row = document.createElement('div');
      row.className = 'krypton-diff__priority-item';
      if (i === this.prioritySelectedIndex) row.classList.add('krypton-diff__priority-item--selected');

      const top = document.createElement('div');
      top.className = 'krypton-diff__priority-item-top';
      const badge = document.createElement('span');
      badge.className = `krypton-diff__priority-badge krypton-diff__priority-badge--${it.range.level}`;
      badge.textContent = it.range.level === 'high' ? '◆ high' : '▸ routine';
      const lines = document.createElement('span');
      lines.className = 'krypton-diff__priority-lines';
      lines.textContent = `L${it.range.lineStart}–${it.range.lineEnd}`;
      top.appendChild(badge);
      top.appendChild(lines);

      const path = document.createElement('span');
      path.className = 'krypton-diff__priority-path';
      path.textContent = this.filePath(this.files[it.fileIndex]);

      row.appendChild(top);
      row.appendChild(path);
      // Mouse is secondary, but a click previews the row immediately.
      row.addEventListener('click', () => this.jumpPrioritySelection(i));
      items.appendChild(row);
    });

    const footer = document.createElement('div');
    footer.className = 'krypton-diff__priority-footer';
    footer.textContent = 'j/k preview · Enter keep · Esc back · q close';
    root.appendChild(footer);

    (items.querySelectorAll('.krypton-diff__priority-item')[this.prioritySelectedIndex] as HTMLElement | undefined)
      ?.scrollIntoView({ block: 'nearest' });
  }

  onKeyDown(e: KeyboardEvent): boolean {
    // Composer is a focused <textarea>: intercept only submit/cancel, let every
    // other key fall through (return false) so typing reaches the textarea.
    if (this.composerEl && !this.composerEl.hidden) return this.onComposerKey(e);
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (this.helpOpen) return this.onHelpKey(e);
    if (this.listOpen) return this.onFileListKey(e);
    if (this.commentsOverlayOpen) return this.onCommentsKey(e);
    if (this.priorityOpen) return this.onPriorityKey(e);

    if (e.key === '?') {
      this.openHelp();
      return true;
    }

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

    // Review priority (spec 160): `}`/`{` jump only between high hunks (n/N still
    // walk all hunks); Enter expands the routine fold nearest the viewport top.
    if (this.reviewPriority) {
      if (e.key === '}') {
        this.navigateHighHunk(1);
        return true;
      }
      if (e.key === '{') {
        this.navigateHighHunk(-1);
        return true;
      }
      if (e.key === 'Enter') {
        return this.expandNearestFold();
      }
      // `p` opens the cross-file priority panel (no-op when nothing was
      // reported — degrades to today's diff).
      if (e.key === 'p') {
        this.openPriorityList();
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
    // Walk between HUNKS, not tbodies: diff2html packs every hunk into one tbody
    // per side (querying `.d2h-diff-tbody` would yield 1–2 file-wide blocks), so
    // split the new-panel tbody on its `.d2h-info` headers and step those.
    const panels = this.fileContainer.querySelectorAll('.d2h-file-side-diff');
    const scope: ParentNode = panels.length > 1 ? panels[1] : this.fileContainer;
    const tbody = scope.querySelector('.d2h-diff-tbody');
    const hunks = tbody ? this.splitHunks(tbody) : [];
    const anchors = hunks
      .map((h) => h.header ?? h.rows[0])
      .filter((e): e is Element => !!e);
    if (anchors.length === 0) {
      this.fileContainer.scrollBy({ top: delta * 200, behavior: 'auto' });
      return;
    }

    const scrollTop = this.fileContainer.scrollTop;
    const containerTop = this.fileContainer.getBoundingClientRect().top;
    let target: Element | null = null;

    if (delta > 0) {
      for (const anchor of anchors) {
        const offset = anchor.getBoundingClientRect().top - containerTop + scrollTop;
        if (offset > scrollTop + 10) {
          target = anchor;
          break;
        }
      }
    } else {
      for (let i = anchors.length - 1; i >= 0; i--) {
        const offset = anchors[i].getBoundingClientRect().top - containerTop + scrollTop;
        if (offset < scrollTop - 10) {
          target = anchors[i];
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

  // ─── Keybindings help overlay ───

  private openHelp(): void {
    this.helpOpen = true;
    this.helpEl.hidden = false;
    this.renderHelp();
  }

  private closeHelp(): void {
    this.helpOpen = false;
    this.helpEl.hidden = true;
  }

  /** Keys while the help overlay is open. Swallows everything (returns true) so
   *  the diff underneath never scrolls; `?`/q/Escape dismiss. */
  private onHelpKey(e: KeyboardEvent): boolean {
    if (e.key === '?' || e.key === 'q' || e.key === 'Escape') this.closeHelp();
    return true;
  }

  /** Build the keybindings reference. Sections mirror onKeyDown; review and
   *  refresh rows appear only when those features are wired up. */
  private renderHelp(): void {
    this.helpEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'krypton-diff__help-header';
    header.textContent = 'Keybindings';
    this.helpEl.appendChild(header);

    const body = document.createElement('div');
    body.className = 'krypton-diff__help-body';
    this.helpEl.appendChild(body);

    const sections: { title: string; rows: [string, string][] }[] = [
      {
        title: 'Scroll',
        rows: [
          ['j / k', 'down / up'],
          ['h / l', 'left / right'],
          ['f / b', 'page down / up'],
          ['g / G', 'top / bottom'],
        ],
      },
      {
        title: 'Navigate',
        rows: [
          ['n / N', 'next / previous hunk'],
          ['] / [', 'next / previous file'],
          ['t', 'file switcher'],
        ],
      },
      {
        title: 'View',
        rows: [
          ['s', 'toggle split / unified'],
          ...(this.refreshProvider ? ([['r', 'refresh diff']] as [string, string][]) : []),
        ],
      },
    ];

    if (this.review) {
      sections.push({
        title: 'Review',
        rows: [
          ['c', 'comment on hunk / selection'],
          ['C', 'open comments'],
        ],
      });
    }

    if (this.reviewPriority) {
      sections.push({
        title: 'Priority',
        rows: [
          ['p', 'priority panel (cross-file, live preview)'],
          ['} / {', 'next / prev high hunk'],
          ['Enter', 'expand folded routine hunk'],
        ],
      });
    }

    sections.push({
      title: 'General',
      rows: [
        ['?', 'this help'],
        ['q / Esc', 'close diff'],
      ],
    });

    for (const section of sections) {
      const title = document.createElement('div');
      title.className = 'krypton-diff__help-section';
      title.textContent = section.title;
      body.appendChild(title);

      for (const [keys, desc] of section.rows) {
        const row = document.createElement('div');
        row.className = 'krypton-diff__help-row';

        const k = document.createElement('span');
        k.className = 'krypton-diff__help-keys';
        k.textContent = keys;

        const d = document.createElement('span');
        d.className = 'krypton-diff__help-desc';
        d.textContent = desc;

        row.appendChild(k);
        row.appendChild(d);
        body.appendChild(row);
      }
    }

    const footer = document.createElement('div');
    footer.className = 'krypton-diff__help-footer';
    footer.textContent = '? or Esc to close';
    this.helpEl.appendChild(footer);
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
      // spec 160: re-pull the priority report alongside the diff so the
      // re-mapped folds/markers land in the SAME render as the new hunks (no
      // flash of full-then-folded on a live refresh). Best-effort — a failed
      // pull just leaves the diff untriaged.
      if (this.reviewPriority) {
        try {
          const snap = await this.reviewPriority.resolve();
          this.priorityRanges = Array.isArray(snap?.ranges) ? snap.ranges : [];
        } catch {
          this.priorityRanges = [];
        }
      }
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

    // Priority panel open: the human is browsing the previewed region, not a
    // scroll position. Re-map ranges to the new file set and render the selected
    // item's file ONCE here (the panel path owns the single draw — don't also run
    // the file-preserving render below, which would draw twice).
    if (this.priorityOpen) {
      if (this.priorityPreviewTimer !== null) {
        window.clearTimeout(this.priorityPreviewTimer);
        this.priorityPreviewTimer = null;
      }
      this.buildPriorityItems();
      if (this.priorityItems.length > 0) {
        this.prioritySelectedIndex = Math.min(this.prioritySelectedIndex, this.priorityItems.length - 1);
        this.priorityReturnFile = Math.min(this.priorityReturnFile, this.files.length - 1);
        const item = this.priorityItems[this.prioritySelectedIndex];
        this.currentFileIndex = item.fileIndex;
        this.renderCurrentFile();
        this.renderPriorityList();
        this.highlightAndScrollToRange(item.range);
        this.refreshedCallback?.(this.files.length);
        return;
      }
      // Everything the panel pointed at drifted away — close it and fall through
      // to the normal file-preserving refresh.
      this.priorityOpen = false;
      if (this.priorityListEl) this.priorityListEl.hidden = true;
      this.clearPreviewHighlight();
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
    if (this.priorityPreviewTimer !== null) {
      window.clearTimeout(this.priorityPreviewTimer);
      this.priorityPreviewTimer = null;
    }
    if (this.focusRaf !== null) {
      window.cancelAnimationFrame(this.focusRaf);
      this.focusRaf = null;
    }
    for (const cb of this.disposeListeners) cb();
    this.disposeListeners = [];
    this.element.remove();
  }
}
