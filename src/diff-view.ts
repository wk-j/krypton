// Krypton — Diff View
// Renders git diff output as side-by-side HTML using diff2html.

import { parse } from 'diff2html';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui';
import type { DiffFile } from 'diff2html/lib/types';
import 'diff2html/bundles/css/diff2html.min.css';
import 'highlight.js/styles/github-dark-dimmed.css';

import type { ContentView, PaneContentType } from './types';

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

export interface DiffViewOptions {
  skipped?: SkippedFile[];
  /** Re-collects the working diff (spec 155). When absent the view is a
   *  static snapshot, exactly as before — no `r` key, no sync indicator. */
  refreshProvider?: () => Promise<WorkingDiffResult>;
}

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

  constructor(unifiedDiff: string, container: HTMLElement, options?: DiffViewOptions) {
    this.refreshProvider = options?.refreshProvider ?? null;
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
    this.appendSyncIndicator();
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
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (this.listOpen) return this.onFileListKey(e);

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
