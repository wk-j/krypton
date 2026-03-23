// Krypton — Markdown Viewer
// Two-panel layout: file browser (left) + rendered preview (right).

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { invoke } from '@tauri-apps/api/core';

import type { ContentView, PaneContentType } from './types';

// Create marked instance with highlight.js integration
const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

/** Markdown viewer with file browser + preview */
export class MarkdownContentView implements ContentView {
  readonly type: PaneContentType = 'markdown';
  readonly element: HTMLElement;

  private files: string[] = [];
  private filteredFiles: string[] = [];
  private selectedIndex = 0;
  private cwd: string;
  private closeCallback: (() => void) | null = null;

  // DOM elements
  private sidebar: HTMLElement;
  private fileListEl: HTMLElement;
  private filterInput: HTMLInputElement;
  private filterContainer: HTMLElement;
  private previewHeader: HTMLElement;
  private previewContent: HTMLElement;
  private isFilterActive = false;
  private focusPanel: 'sidebar' | 'preview' = 'sidebar';

  constructor(files: string[], cwd: string, container: HTMLElement) {
    this.files = files.sort();
    this.filteredFiles = [...this.files];
    this.cwd = cwd;

    this.element = document.createElement('div');
    this.element.className = 'krypton-md';
    this.element.tabIndex = 0;
    container.appendChild(this.element);

    // ── Sidebar ──
    this.sidebar = document.createElement('div');
    this.sidebar.className = 'krypton-md__sidebar krypton-md__panel--focused';

    const sidebarHeader = document.createElement('div');
    sidebarHeader.className = 'krypton-md__sidebar-header';
    sidebarHeader.textContent = 'DOCS';
    this.sidebar.appendChild(sidebarHeader);

    this.filterContainer = document.createElement('div');
    this.filterContainer.className = 'krypton-md__filter';
    this.filterContainer.style.display = 'none';
    this.filterInput = document.createElement('input');
    this.filterInput.className = 'krypton-md__filter-input';
    this.filterInput.placeholder = 'filter...';
    this.filterInput.addEventListener('input', () => this.applyFilter());
    this.filterInput.addEventListener('keydown', (e) => this.handleFilterKey(e));
    this.filterContainer.appendChild(this.filterInput);
    this.sidebar.appendChild(this.filterContainer);

    this.fileListEl = document.createElement('div');
    this.fileListEl.className = 'krypton-md__file-list';
    this.sidebar.appendChild(this.fileListEl);

    // ── Preview ──
    const preview = document.createElement('div');
    preview.className = 'krypton-md__preview';

    this.previewHeader = document.createElement('div');
    this.previewHeader.className = 'krypton-md__preview-header';
    preview.appendChild(this.previewHeader);

    this.previewContent = document.createElement('div');
    this.previewContent.className = 'krypton-md__preview-content';
    preview.appendChild(this.previewContent);

    this.element.appendChild(this.sidebar);
    this.element.appendChild(preview);

    // Render file list
    this.renderFileList();

    // Auto-select first file
    if (this.files.length > 0) {
      this.loadFile(this.files[0]);
    } else {
      this.previewContent.innerHTML = '<div class="krypton-md__empty">No markdown files found</div>';
    }

    // Handle link clicks — open in browser
    this.previewContent.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement).closest('a');
      if (link) {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (href) {
          invoke('open_url', { url: href }).catch(() => {
            console.error('Failed to open URL:', href);
          });
        }
      }
    });
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  // ── File List ──

  private renderFileList(): void {
    this.fileListEl.innerHTML = '';
    for (let i = 0; i < this.filteredFiles.length; i++) {
      const el = document.createElement('div');
      el.className = 'krypton-md__file';
      if (i === this.selectedIndex) {
        el.classList.add('krypton-md__file--selected');
      }
      el.textContent = this.filteredFiles[i];
      el.addEventListener('click', () => {
        this.selectedIndex = i;
        this.renderFileList();
        this.loadFile(this.filteredFiles[i]);
        this.setFocus('preview');
      });
      this.fileListEl.appendChild(el);
    }
    // Scroll selected item into view
    const selected = this.fileListEl.querySelector('.krypton-md__file--selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  private applyFilter(): void {
    const query = this.filterInput.value.toLowerCase();
    this.filteredFiles = query
      ? this.files.filter((f) => f.toLowerCase().includes(query))
      : [...this.files];
    this.selectedIndex = 0;
    this.renderFileList();
  }

  private handleFilterKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.closeFilter();
    } else if (e.key === 'Enter') {
      e.stopPropagation();
      // Close filter UI but keep filtered results
      this.isFilterActive = false;
      this.filterContainer.style.display = 'none';
      this.element.focus();
      if (this.filteredFiles.length > 0) {
        this.loadFile(this.filteredFiles[this.selectedIndex]);
        this.setFocus('preview');
      }
    } else if (e.key === 'ArrowDown' || (e.key === 'j' && e.ctrlKey)) {
      e.preventDefault();
      this.moveSelection(1);
    } else if (e.key === 'ArrowUp' || (e.key === 'k' && e.ctrlKey)) {
      e.preventDefault();
      this.moveSelection(-1);
    }
  }

  private openFilter(): void {
    this.isFilterActive = true;
    this.filterContainer.style.display = '';
    this.filterInput.value = '';
    this.filterInput.focus();
  }

  private closeFilter(): void {
    this.isFilterActive = false;
    this.filterContainer.style.display = 'none';
    this.filterInput.value = '';
    this.filteredFiles = [...this.files];
    this.renderFileList();
    this.element.focus();
  }

  private moveSelection(delta: number): void {
    if (this.filteredFiles.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.filteredFiles.length - 1, this.selectedIndex + delta));
    this.renderFileList();
  }

  // ── Preview ──

  private async loadFile(relativePath: string): Promise<void> {
    this.previewHeader.textContent = relativePath;

    try {
      const content = await invoke<string>('run_command', {
        program: 'cat',
        args: [relativePath],
        cwd: this.cwd,
      });

      // Truncate very large files
      const maxSize = 200 * 1024;
      const truncated = content.length > maxSize;
      const text = truncated ? content.slice(0, maxSize) : content;

      const html = await md.parse(text, { gfm: true, breaks: false });
      this.previewContent.innerHTML = html;

      if (truncated) {
        const notice = document.createElement('div');
        notice.className = 'krypton-md__truncated';
        notice.textContent = 'File truncated (> 200KB)';
        this.previewContent.appendChild(notice);
      }

      this.previewContent.scrollTop = 0;
    } catch {
      this.previewContent.innerHTML = `<div class="krypton-md__empty">Failed to read file: ${relativePath}</div>`;
    }
  }

  private setFocus(panel: 'sidebar' | 'preview'): void {
    this.focusPanel = panel;
    if (panel === 'sidebar') {
      this.sidebar.classList.add('krypton-md__panel--focused');
      this.previewContent.parentElement?.classList.remove('krypton-md__panel--focused');
    } else {
      this.sidebar.classList.remove('krypton-md__panel--focused');
      this.previewContent.parentElement?.classList.add('krypton-md__panel--focused');
    }
  }

  // ── Keyboard ──

  onKeyDown(e: KeyboardEvent): boolean {
    // Don't intercept when filter input is active
    if (this.isFilterActive) return false;

    // Don't intercept modifier combos (let globals handle them)
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    if (this.focusPanel === 'sidebar') {
      return this.handleSidebarKey(e);
    } else {
      return this.handlePreviewKey(e);
    }
  }

  private handleSidebarKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        this.moveSelection(1);
        return true;
      case 'k':
      case 'ArrowUp':
        this.moveSelection(-1);
        return true;
      case 'Enter':
      case 'l':
      case 'ArrowRight':
        if (this.filteredFiles.length > 0) {
          this.loadFile(this.filteredFiles[this.selectedIndex]);
          this.setFocus('preview');
        }
        return true;
      case '/':
        this.openFilter();
        return true;
      case 'q':
      case 'Escape':
        if (this.closeCallback) this.closeCallback();
        return true;
      default:
        return false;
    }
  }

  private handlePreviewKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'h':
      case 'ArrowLeft':
        this.setFocus('sidebar');
        return true;
      case 'j':
        this.previewContent.scrollBy({ top: 40, behavior: 'auto' });
        return true;
      case 'k':
        this.previewContent.scrollBy({ top: -40, behavior: 'auto' });
        return true;
      case 'f':
        this.previewContent.scrollBy({ top: this.previewContent.clientHeight * 0.9, behavior: 'auto' });
        return true;
      case 'b':
        this.previewContent.scrollBy({ top: -this.previewContent.clientHeight * 0.9, behavior: 'auto' });
        return true;
      case 'g':
        if (e.shiftKey) {
          this.previewContent.scrollTo({ top: this.previewContent.scrollHeight, behavior: 'auto' });
        } else {
          this.previewContent.scrollTo({ top: 0, behavior: 'auto' });
        }
        return true;
      case ']':
        this.navigateHeading(1);
        return true;
      case '[':
        this.navigateHeading(-1);
        return true;
      case 'q':
      case 'Escape':
        if (this.closeCallback) this.closeCallback();
        return true;
      default:
        return false;
    }
  }

  private navigateHeading(delta: number): void {
    const headings = this.previewContent.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length === 0) return;

    const scrollTop = this.previewContent.scrollTop;
    const containerTop = this.previewContent.getBoundingClientRect().top;
    let target: Element | null = null;

    if (delta > 0) {
      for (const h of headings) {
        const offset = h.getBoundingClientRect().top - containerTop + scrollTop;
        if (offset > scrollTop + 10) {
          target = h;
          break;
        }
      }
    } else {
      for (let i = headings.length - 1; i >= 0; i--) {
        const offset = headings[i].getBoundingClientRect().top - containerTop + scrollTop;
        if (offset < scrollTop - 10) {
          target = headings[i];
          break;
        }
      }
    }

    if (target) {
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }

  onResize(): void {
    // No special handling needed
  }

  dispose(): void {
    this.element.remove();
  }
}
