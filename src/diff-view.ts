// Krypton — Diff View
// Renders git diff output as side-by-side HTML using diff2html.

import { parse, html } from 'diff2html';
import type { DiffFile } from 'diff2html/lib/types';
import 'diff2html/bundles/css/diff2html.min.css';

import type { ContentView, PaneContentType } from './types';

/** Diff content view — renders git diff output as side-by-side panels */
export class DiffContentView implements ContentView {
  readonly type: PaneContentType = 'diff';
  readonly element: HTMLElement;

  private files: DiffFile[] = [];
  private currentFileIndex = 0;
  private fileContainer: HTMLElement;
  private navEl: HTMLElement;
  private diffStyle: 'side-by-side' | 'line-by-line' = 'side-by-side';
  private closeCallback: (() => void) | null = null;

  constructor(unifiedDiff: string, container: HTMLElement) {
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

    // Diff content area
    this.fileContainer = document.createElement('div');
    this.fileContainer.className = 'krypton-diff__content';
    this.element.appendChild(this.fileContainer);

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
    this.navEl.innerHTML = '';
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
    path.textContent = file.newName || file.oldName || 'unknown';

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
  }

  private renderCurrentFile(): void {
    this.renderNav();
    this.fileContainer.innerHTML = '';

    const file = this.files[this.currentFileIndex];
    if (!file) return;

    // Render single file diff as HTML
    const diffHtml = html([file], {
      outputFormat: this.diffStyle,
      drawFileList: false,
      colorScheme: 'dark' as never,
      diffStyle: 'word',
      matching: 'lines',
      renderNothingWhenEmpty: false,
    });

    // Wrap in dark color scheme container
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-dark-color-scheme';
    wrapper.innerHTML = diffHtml;
    this.fileContainer.appendChild(wrapper);
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    switch (e.key) {
      case 'j':
        this.fileContainer.scrollBy({ top: 40, behavior: 'smooth' });
        return true;
      case 'k':
        this.fileContainer.scrollBy({ top: -40, behavior: 'smooth' });
        return true;
      case 'f':
        this.fileContainer.scrollBy({ top: this.fileContainer.clientHeight * 0.9, behavior: 'smooth' });
        return true;
      case 'b':
        this.fileContainer.scrollBy({ top: -this.fileContainer.clientHeight * 0.9, behavior: 'smooth' });
        return true;
      case 'g':
        if (e.shiftKey) {
          this.fileContainer.scrollTo({ top: this.fileContainer.scrollHeight, behavior: 'smooth' });
        } else {
          this.fileContainer.scrollTo({ top: 0, behavior: 'smooth' });
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
      case 'q':
      case 'Escape':
        if (this.closeCallback) this.closeCallback();
        return true;
      default:
        return false;
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
      this.fileContainer.scrollBy({ top: delta * 200, behavior: 'smooth' });
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
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private toggleDiffStyle(): void {
    this.diffStyle = this.diffStyle === 'side-by-side' ? 'line-by-line' : 'side-by-side';
    this.renderCurrentFile();
  }

  onResize(): void {
    // diff2html handles its own layout via CSS
  }

  dispose(): void {
    this.element.remove();
  }
}
