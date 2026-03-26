// Krypton — Markdown Viewer
// Two-panel layout: file browser (left) + rendered preview (right).

import { Marked, Lexer } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { invoke } from '@tauri-apps/api/core';

import type { ContentView, PaneContentType } from './types';

/** List .md files in a directory, respecting .gitignore when possible. */
export async function listMarkdownFiles(cwd: string): Promise<string[]> {
  let fileList: string;
  try {
    fileList = await invoke<string>('run_command', {
      program: 'git',
      args: ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
      cwd,
    });
  } catch {
    try {
      fileList = await invoke<string>('run_command', {
        program: 'find',
        args: ['.', '-maxdepth', '5', '-name', '*.md', '-type', 'f'],
        cwd,
      });
    } catch {
      return [];
    }
  }
  return fileList
    .split('\n')
    .map((f) => f.trim().replace(/^\.\//, ''))
    .filter((f) => f.length > 0)
    .sort();
}

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
  private focusPanel: 'sidebar' | 'preview' | 'select' = 'sidebar';

  // Select mode state
  private selectableBlocks: HTMLElement[] = [];
  private selectAnchor = -1;  // first selected block index
  private selectCursor = -1;  // current block index (extends from anchor)
  private selectIndicator: HTMLElement | null = null;

  // Navigation history (jumplist)
  private jumpHistory: string[] = [];
  private jumpIndex = -1;

  // Link hint mode state
  private linkHintActive = false;
  private linkHintLabels: HTMLElement[] = [];
  private linkHintMap: Map<string, HTMLAnchorElement> = new Map();
  private linkHintInput = '';

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

    // Handle link clicks — local .md links navigate in viewer, others open in browser
    this.previewContent.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement).closest('a');
      if (link) {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (!href) return;

        // Check if it's a local markdown link (relative path ending in .md, no protocol)
        if (href.endsWith('.md') && !href.includes('://')) {
          this.navigateToLocalMd(href);
        } else {
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

  private pushJump(file: string): void {
    // Truncate forward history when navigating to a new file
    if (this.jumpIndex < this.jumpHistory.length - 1) {
      this.jumpHistory.splice(this.jumpIndex + 1);
    }
    // Don't push duplicates at the top
    if (this.jumpHistory[this.jumpHistory.length - 1] !== file) {
      this.jumpHistory.push(file);
    }
    this.jumpIndex = this.jumpHistory.length - 1;
  }

  private navigateJump(delta: number): void {
    const next = this.jumpIndex + delta;
    if (next < 0 || next >= this.jumpHistory.length) return;
    this.jumpIndex = next;
    const file = this.jumpHistory[next];

    const idx = this.filteredFiles.indexOf(file);
    if (idx !== -1) {
      this.selectedIndex = idx;
      this.renderFileList();
    }
    this.loadFile(file, false);
    this.setFocus('preview');
  }

  private navigateToLocalMd(href: string): void {
    // Resolve relative to the directory of the currently viewed file
    const currentFile = this.previewHeader.textContent || '';
    const currentDir = currentFile.includes('/')
      ? currentFile.slice(0, currentFile.lastIndexOf('/'))
      : '';
    const resolved = currentDir ? `${currentDir}/${href}` : href;

    // Normalize path (resolve ../ and ./ segments)
    const parts: string[] = [];
    for (const seg of resolved.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    const normalizedPath = parts.join('/');

    // If the file is in our list, select it; otherwise just load it directly
    const idx = this.filteredFiles.indexOf(normalizedPath);
    if (idx !== -1) {
      this.selectedIndex = idx;
      this.renderFileList();
    }
    this.loadFile(normalizedPath);
    this.setFocus('preview');
  }

  private async loadFile(relativePath: string, recordJump = true): Promise<void> {
    if (recordJump) this.pushJump(relativePath);
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
      this.annotateBlocksWithRaw(text);

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

  private setFocus(panel: 'sidebar' | 'preview' | 'select'): void {
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

    // Ctrl+O / Ctrl+I — jumplist back/forward (handle before modifier guard)
    if (e.ctrlKey && e.key === 'o') {
      this.navigateJump(-1);
      return true;
    }
    if (e.ctrlKey && e.key === 'i') {
      this.navigateJump(1);
      return true;
    }

    // Don't intercept modifier combos (let globals handle them)
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    if (this.linkHintActive) {
      return this.handleLinkHintKey(e);
    }

    if (this.focusPanel === 'select') {
      return this.handleSelectKey(e);
    } else if (this.focusPanel === 'sidebar') {
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
      case 'r':
        this.reloadCurrentFile();
        return true;
      case 'R':
        this.refreshFileList();
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
      case 'v':
        this.enterSelectMode();
        return true;
      case 'o':
        this.enterLinkHintMode();
        return true;
      case 'y':
        this.copyFilePath();
        return true;
      case 'r':
        this.reloadCurrentFile();
        return true;
      case 'R':
        this.refreshFileList();
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

  // ── Select Mode ──

  private static readonly BLOCK_SELECTOR =
    'p, pre, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, table, hr';

  /** Enter select mode — highlight the block nearest the current scroll position. */
  private enterSelectMode(): void {
    this.selectableBlocks = Array.from(
      this.previewContent.querySelectorAll(MarkdownContentView.BLOCK_SELECTOR),
    ) as HTMLElement[];
    if (this.selectableBlocks.length === 0) return;

    // Find the first block visible in the viewport
    const scrollTop = this.previewContent.scrollTop;
    const containerTop = this.previewContent.getBoundingClientRect().top;
    let startIdx = 0;
    for (let i = 0; i < this.selectableBlocks.length; i++) {
      const rect = this.selectableBlocks[i].getBoundingClientRect();
      const offset = rect.top - containerTop + scrollTop;
      if (offset + rect.height > scrollTop) {
        startIdx = i;
        break;
      }
    }

    this.selectAnchor = startIdx;
    this.selectCursor = startIdx;
    this.focusPanel = 'select';
    this.updateSelectHighlight();
    this.showSelectIndicator();
  }

  /** Exit select mode and clear highlights. */
  private exitSelectMode(): void {
    for (const el of this.selectableBlocks) {
      el.classList.remove('krypton-md__block--selected');
    }
    this.selectableBlocks = [];
    this.selectAnchor = -1;
    this.selectCursor = -1;
    this.hideSelectIndicator();
    this.setFocus('preview');
  }

  /** Update which blocks have the selected highlight. */
  private updateSelectHighlight(): void {
    const lo = Math.min(this.selectAnchor, this.selectCursor);
    const hi = Math.max(this.selectAnchor, this.selectCursor);
    for (let i = 0; i < this.selectableBlocks.length; i++) {
      this.selectableBlocks[i].classList.toggle(
        'krypton-md__block--selected',
        i >= lo && i <= hi,
      );
    }
    // Scroll current block into view
    this.selectableBlocks[this.selectCursor]?.scrollIntoView({
      block: 'nearest',
      behavior: 'auto',
    });
    this.updateSelectIndicator();
  }

  /** Move cursor in select mode. If extend is true, anchor stays (visual-line expand). */
  private moveSelectCursor(delta: number, extend: boolean): void {
    const next = Math.max(0, Math.min(this.selectableBlocks.length - 1, this.selectCursor + delta));
    if (next === this.selectCursor) return;
    this.selectCursor = next;
    if (!extend) this.selectAnchor = next;
    this.updateSelectHighlight();
  }

  /** Annotate rendered block elements with their raw markdown source and line numbers. */
  private annotateBlocksWithRaw(rawText: string): void {
    const tokens = Lexer.lex(rawText, { gfm: true });
    const blocks = this.previewContent.querySelectorAll(
      MarkdownContentView.BLOCK_SELECTOR,
    );

    // Walk tokens (skipping 'space' tokens that produce no DOM element)
    // and pair each with the corresponding DOM block.
    // Track character offset to compute accurate line numbers.
    let blockIdx = 0;
    let charOffset = 0;
    for (const tok of tokens) {
      const tokStart = rawText.indexOf(tok.raw, charOffset);
      if (tokStart !== -1) charOffset = tokStart + tok.raw.length;

      if (tok.type === 'space') continue;
      if (blockIdx >= blocks.length) break;

      const el = blocks[blockIdx] as HTMLElement;
      el.dataset.raw = tok.raw.replace(/\n+$/, '');
      if (tokStart !== -1) {
        const startLine = rawText.slice(0, tokStart).split('\n').length;
        const endLine = startLine + tok.raw.trimEnd().split('\n').length - 1;
        el.dataset.startLine = String(startLine);
        el.dataset.endLine = String(endLine);
      }
      blockIdx++;
    }
  }

  /** Collect raw text from selected blocks. */
  private collectSelectedText(): string[] {
    const lo = Math.min(this.selectAnchor, this.selectCursor);
    const hi = Math.max(this.selectAnchor, this.selectCursor);
    const texts: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const el = this.selectableBlocks[i];
      const raw = el.dataset.raw;
      const text = raw ?? el.textContent?.trim();
      if (text) texts.push(text);
    }
    return texts;
  }

  /** Find the line range of selected blocks within the raw markdown. */
  private getSelectedLineRange(): { start: number; end: number } | null {
    const lo = Math.min(this.selectAnchor, this.selectCursor);
    const hi = Math.max(this.selectAnchor, this.selectCursor);
    const startLine = this.selectableBlocks[lo]?.dataset.startLine;
    const endLine = this.selectableBlocks[hi]?.dataset.endLine;
    if (!startLine || !endLine) return null;
    return { start: parseInt(startLine, 10), end: parseInt(endLine, 10) };
  }

  /** Copy selected blocks as raw markdown to clipboard. */
  private async copySelection(): Promise<void> {
    const texts = this.collectSelectedText();
    if (texts.length === 0) return;
    try {
      await navigator.clipboard.writeText(texts.join('\n\n'));
    } catch {
      // Clipboard API may fail in some contexts — silently ignore
    }
    this.exitSelectMode();
  }

  /** Copy selected blocks wrapped with file path and line range as AI context. */
  private async copyAsContext(): Promise<void> {
    const texts = this.collectSelectedText();
    if (texts.length === 0) return;

    const filePath = this.previewHeader.textContent || 'unknown';
    const range = this.getSelectedLineRange();
    const content = texts.join('\n\n');

    let header = `\`${filePath}\``;
    if (range) {
      header += range.start === range.end
        ? ` (line ${range.start})`
        : ` (lines ${range.start}-${range.end})`;
    }

    const formatted = `${header}\n\`\`\`markdown\n${content}\n\`\`\``;

    try {
      await navigator.clipboard.writeText(formatted);
    } catch {
      // Clipboard API may fail — silently ignore
    }
    this.exitSelectMode();
  }

  /** Copy the active file's relative path to clipboard. */
  private async copyFilePath(): Promise<void> {
    const file = this.previewHeader.textContent;
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file);
    } catch {
      // Clipboard API may fail — silently ignore
    }
  }

  private showSelectIndicator(): void {
    if (!this.selectIndicator) {
      this.selectIndicator = document.createElement('div');
      this.selectIndicator.className = 'krypton-md__select-indicator';
      this.previewContent.parentElement?.appendChild(this.selectIndicator);
    }
    this.updateSelectIndicator();
    this.selectIndicator.style.display = '';
  }

  private updateSelectIndicator(): void {
    if (!this.selectIndicator) return;
    const count = Math.abs(this.selectCursor - this.selectAnchor) + 1;
    this.selectIndicator.textContent = `SELECT · ${count} block${count > 1 ? 's' : ''} · y:yank md  Y:yank context  Esc:cancel`;
  }

  private hideSelectIndicator(): void {
    if (this.selectIndicator) {
      this.selectIndicator.style.display = 'none';
    }
  }

  // ── Link Hint Mode ──

  private static generateHintLabels(count: number): string[] {
    const chars = 'asdfghjkl';
    const labels: string[] = [];
    if (count <= chars.length) {
      for (let i = 0; i < count; i++) labels.push(chars[i]);
    } else {
      for (let i = 0; i < chars.length && labels.length < count; i++) {
        for (let j = 0; j < chars.length && labels.length < count; j++) {
          labels.push(chars[i] + chars[j]);
        }
      }
    }
    return labels;
  }

  private enterLinkHintMode(): void {
    const links = Array.from(
      this.previewContent.querySelectorAll('a[href]'),
    ) as HTMLAnchorElement[];
    if (links.length === 0) return;

    const labels = MarkdownContentView.generateHintLabels(links.length);
    this.linkHintMap.clear();
    this.linkHintLabels = [];
    this.linkHintInput = '';

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const label = labels[i];
      this.linkHintMap.set(label, link);

      const badge = document.createElement('span');
      badge.className = 'krypton-md__link-hint';
      badge.textContent = label;
      link.style.position = 'relative';
      link.appendChild(badge);
      this.linkHintLabels.push(badge);
    }

    this.linkHintActive = true;
  }

  private exitLinkHintMode(): void {
    for (const badge of this.linkHintLabels) badge.remove();
    this.linkHintLabels = [];
    this.linkHintMap.clear();
    this.linkHintInput = '';
    this.linkHintActive = false;
  }

  private handleLinkHintKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.exitLinkHintMode();
      return true;
    }

    if (e.key.length !== 1) return true; // absorb non-character keys

    this.linkHintInput += e.key.toLowerCase();

    // Check for exact match
    const match = this.linkHintMap.get(this.linkHintInput);
    if (match) {
      const href = match.getAttribute('href');
      this.exitLinkHintMode();
      if (href) {
        if (href.endsWith('.md') && !href.includes('://')) {
          this.navigateToLocalMd(href);
        } else {
          invoke('open_url', { url: href }).catch(() => {
            console.error('Failed to open URL:', href);
          });
        }
      }
      return true;
    }

    // Check if input is a prefix of any label
    let hasPrefix = false;
    for (const label of this.linkHintMap.keys()) {
      if (label.startsWith(this.linkHintInput)) {
        hasPrefix = true;
        break;
      }
    }

    if (!hasPrefix) {
      // No possible match — exit
      this.exitLinkHintMode();
    } else {
      // Dim non-matching hints
      for (const badge of this.linkHintLabels) {
        const label = badge.textContent || '';
        badge.classList.toggle(
          'krypton-md__link-hint--dimmed',
          !label.startsWith(this.linkHintInput),
        );
      }
    }
    return true;
  }

  private handleSelectKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        this.moveSelectCursor(1, e.shiftKey);
        return true;
      case 'k':
      case 'ArrowUp':
        this.moveSelectCursor(-1, e.shiftKey);
        return true;
      case 'J':
        this.moveSelectCursor(1, true);
        return true;
      case 'K':
        this.moveSelectCursor(-1, true);
        return true;
      case 'g':
        if (e.shiftKey) {
          this.moveSelectCursor(this.selectableBlocks.length, true);
        } else {
          this.moveSelectCursor(-this.selectableBlocks.length, true);
        }
        return true;
      case 'y':
        this.copySelection();
        return true;
      case 'Y':
        this.copyAsContext();
        return true;
      case 'Escape':
      case 'q':
        this.exitSelectMode();
        return true;
      default:
        return true; // absorb all keys in select mode
    }
  }

  /** Reload the currently selected file from disk. */
  private reloadCurrentFile(): void {
    const file = this.filteredFiles[this.selectedIndex];
    if (file) this.loadFile(file);
  }

  /** Re-scan the CWD for .md files and refresh the sidebar. */
  private async refreshFileList(): Promise<void> {
    const newFiles = await listMarkdownFiles(this.cwd);
    const currentFile = this.filteredFiles[this.selectedIndex] ?? null;

    this.files = newFiles;
    this.applyFilter();

    // Try to preserve selection
    if (currentFile) {
      const idx = this.filteredFiles.indexOf(currentFile);
      if (idx >= 0) {
        this.selectedIndex = idx;
        this.renderFileList();
      }
    }
  }

  onResize(): void {
    // No special handling needed
  }

  dispose(): void {
    this.element.remove();
  }
}
