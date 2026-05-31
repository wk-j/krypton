// Krypton — Markdown Viewer
// Two-panel layout: file browser (left) + rendered preview (right).

import { Marked, Lexer } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { convertFileSrc } from '@tauri-apps/api/core';

import { invoke } from './profiler/ipc';
import { openExternalUrl } from './external-url';

import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';

import type { ContentView, LeaderKeyBinding, LeaderKeySpec, PaneContentType } from './types';
import type { MarkdownViewAI } from './markdown-view-ai';
import type { MarkdownViewContext } from './markdown-view-ai';

export const MARKDOWN_LEADER_KEYS: readonly LeaderKeySpec[] = [
  { key: ';', label: 'Link Hints', group: 'Markdown', effect: 'important' },
];

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
  /** Path of the file currently rendered in the preview (guards no-op reloads). */
  private currentLoadedFile: string | null = null;

  getWorkingDirectory(): string | null {
    return this.cwd;
  }

  getLeaderKeyBindings(): LeaderKeyBinding[] {
    return MARKDOWN_LEADER_KEYS.map((spec) => ({
      ...spec,
      run: () => this.enterLinkHintMode(),
      isEnabled: () => this.hasPreviewLinks() && !this.isFilterActive && this.aiOverlay === null,
      disabledReason: () => 'No links available',
    }));
  }

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

  // Content reveal animations
  private revealAnimations: Animation[] = [];

  // Hint mode state (shared by link hints `o`/`;` and heading hints `H`)
  private hintActive = false;
  private hintLabels: HTMLElement[] = [];
  private hintMap: Map<string, HTMLElement> = new Map();
  private hintInput = '';
  private hintOnPick: ((el: HTMLElement) => void) | null = null;
  // Targets whose inline `position` we set to 'relative' for badge anchoring,
  // with their prior value so exitHintMode can restore it.
  private hintTouched: Array<{ el: HTMLElement; prevPosition: string }> = [];

  // In-doc search state
  private searchActive = false;
  private searchHud: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchMatches: HTMLElement[] = [];
  private searchIndex = -1;
  private searchDebounce: number | null = null;

  // AI overlay
  private aiOverlay: MarkdownViewAI | null = null;

  constructor(files: string[], cwd: string, container: HTMLElement, initialFile?: string) {
    this.files = files.sort();
    this.filteredFiles = [...this.files];
    this.cwd = cwd;
    // If initialFile is given, ensure it appears in the sidebar even when
    // it wasn't part of the discovered list (e.g., absolute path from hint).
    if (initialFile && !this.files.includes(initialFile)) {
      this.files = [initialFile, ...this.files];
      this.filteredFiles = [...this.files];
    }

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

    // Auto-select initial / first file
    if (initialFile) {
      const idx = this.filteredFiles.indexOf(initialFile);
      if (idx >= 0) {
        this.selectedIndex = idx;
        this.renderFileList();
      }
      this.loadFile(initialFile);
      this.setFocus('preview');
    } else if (this.files.length > 0) {
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
          openExternalUrl(href, { external: e.shiftKey });
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

  private async loadFile(relativePath: string, recordJump = true, force = false): Promise<void> {
    // No-op when the requested file is already shown — re-selecting it should
    // just hand focus to the preview (caller does that), not re-render/reset scroll.
    if (!force && relativePath === this.currentLoadedFile) return;

    // Tear down any transient overlay mode bound to the old DOM before the
    // innerHTML swap, or its badges/highlights orphan and the mode's key
    // handlers fire against dead element refs.
    if (this.searchActive) this.closeSearch();
    if (this.hintActive) this.exitHintMode();
    if (this.focusPanel === 'select') this.exitSelectMode();

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

      const fmMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const body = fmMatch ? text.slice(fmMatch[0].length) : text;
      const lineOffset = fmMatch ? fmMatch[0].split('\n').length - 1 : 0;
      const html = await md.parse(body, { gfm: true, breaks: true });
      this.previewContent.innerHTML = html;
      this.currentLoadedFile = relativePath;
      this.rewriteImageSources(relativePath);
      this.annotateBlocksWithRaw(body, lineOffset);

      if (truncated) {
        const notice = document.createElement('div');
        notice.className = 'krypton-md__truncated';
        notice.textContent = 'File truncated (> 200KB)';
        this.previewContent.appendChild(notice);
      }

      this.previewContent.scrollTop = 0;
      this.animateContentReveal();
    } catch {
      this.currentLoadedFile = null;
      this.previewContent.innerHTML = `<div class="krypton-md__empty">Failed to read file: ${relativePath}</div>`;
    }
  }

  /** Resolve relative <img src> against the current file's directory so local
   *  images load inside the webview (raw file:// is blocked cross-origin). */
  private rewriteImageSources(relativePath: string): void {
    const currentDir = relativePath.includes('/')
      ? relativePath.slice(0, relativePath.lastIndexOf('/'))
      : '';
    const imgs = this.previewContent.querySelectorAll('img[src]');
    for (const img of Array.from(imgs) as HTMLImageElement[]) {
      const src = img.getAttribute('src') ?? '';
      // Leave remote / data / already-absolute-protocol sources untouched.
      if (/^(https?:|data:|asset:|blob:)/i.test(src) || src.startsWith('//')) continue;

      // Strip ?query / #fragment before FS resolution (cache-busters like
      // `diagram.png?v=3` would otherwise become part of the path).
      const path = src.replace(/[?#].*$/, '');
      if (!path) continue;

      // Build an absolute path: leading "/" is treated as cwd-root, else relative
      // to the current file's directory. Collapse ./ and ../ segments.
      const joined = path.startsWith('/')
        ? `${this.cwd}/${path.slice(1)}`
        : `${this.cwd}/${currentDir ? currentDir + '/' : ''}${path}`;
      const parts: string[] = [];
      for (const seg of joined.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
      }
      const abs = '/' + parts.join('/');

      const relForNotice = src;
      img.src = convertFileSrc(abs);
      img.addEventListener('error', () => {
        const breach = document.createElement('span');
        breach.className = 'krypton-md__img-breach';
        breach.textContent = `IMG BREACH // ${relForNotice}`;
        img.replaceWith(breach);
      }, { once: true });
    }
  }

  /** Animate content blocks into view — headings get pretext line-by-line reveal, other blocks stagger in. */
  private animateContentReveal(): void {
    // Cancel previous animations
    for (const a of this.revealAnimations) a.cancel();
    this.revealAnimations = [];

    const blocks = this.previewContent.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, p, pre, ul, ol, blockquote, table, hr',
    ) as NodeListOf<HTMLElement>;

    // Only animate the first ~40 blocks to avoid perf overhead on huge files
    const limit = Math.min(blocks.length, 40);
    let lineIndex = 0; // cumulative line counter for stagger timing

    for (let i = 0; i < limit; i++) {
      const el = blocks[i];
      const tag = el.tagName;

      if (/^H[1-6]$/.test(tag)) {
        // Heading: use pretext to split into lines, animate each line
        lineIndex = this.animateHeadingLines(el, lineIndex);
      } else {
        // Regular block: simple staggered fade+slide
        el.style.opacity = '0';
        el.style.transform = 'translateY(6px)';

        const delay = lineIndex * 30;
        const anim = el.animate([
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], {
          duration: 250,
          delay,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          fill: 'forwards',
        });
        this.revealAnimations.push(anim);
        lineIndex++;
      }
    }
  }

  /** Split a heading into lines with pretext and animate each line. Returns updated lineIndex. */
  private animateHeadingLines(heading: HTMLElement, lineIndex: number): number {
    const text = heading.textContent || '';
    if (!text.trim()) return lineIndex;

    // Determine font from heading level
    const level = parseInt(heading.tagName[1], 10);
    const sizes: Record<number, string> = { 1: '1.8em', 2: '1.4em', 3: '1.2em', 4: '1.05em', 5: '0.95em', 6: '0.95em' };
    const fontSize = sizes[level] || '1em';
    const font = `bold ${fontSize} "Fira Code", monospace`;

    // Measure available width from container (preview content has 24px padding each side)
    const maxWidth = this.previewContent.clientWidth - 48;
    if (maxWidth <= 0) return lineIndex + 1;

    const prepared = prepareWithSegments(text, font);
    const { lines } = layoutWithLines(prepared, maxWidth, 1.3 * parseFloat(fontSize) * 16);

    // If single line, just animate the heading as-is
    if (lines.length <= 1) {
      heading.style.opacity = '0';
      heading.style.transform = 'translateX(-8px)';

      const delay = lineIndex * 30;
      const anim = heading.animate([
        { opacity: 0, transform: 'translateX(-8px)', filter: 'blur(3px)' },
        { opacity: 0.7, transform: 'translateX(1px)', filter: 'blur(0px)', offset: 0.6 },
        { opacity: 1, transform: 'translateX(0)', filter: 'blur(0px)' },
      ], {
        duration: 300,
        delay,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards',
      });
      this.revealAnimations.push(anim);

      // Glow pulse
      const glowAnim = heading.animate([
        { textShadow: '0 0 0px transparent' },
        { textShadow: '0 0 12px rgba(0, 204, 255, 0.5)', offset: 0.4 },
        { textShadow: '0 0 3px rgba(0, 204, 255, 0.1)' },
      ], {
        duration: 500,
        delay: delay + 180,
        easing: 'ease-out',
        fill: 'forwards',
      });
      this.revealAnimations.push(glowAnim);

      return lineIndex + 1;
    }

    // Multi-line heading: replace content with per-line spans
    heading.textContent = '';
    heading.style.opacity = '1'; // container visible, children animate

    for (let j = 0; j < lines.length; j++) {
      const lineEl = document.createElement('div');
      lineEl.className = 'krypton-md__heading-line';
      lineEl.textContent = lines[j].text;
      lineEl.style.opacity = '0';
      lineEl.style.transform = 'translateX(-10px)';
      heading.appendChild(lineEl);

      const delay = (lineIndex + j) * 30;
      const anim = lineEl.animate([
        { opacity: 0, transform: 'translateX(-10px)', filter: 'blur(3px)' },
        { opacity: 0.7, transform: 'translateX(1px)', filter: 'blur(0px)', offset: 0.6 },
        { opacity: 1, transform: 'translateX(0)', filter: 'blur(0px)' },
      ], {
        duration: 300,
        delay,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards',
      });
      this.revealAnimations.push(anim);

      // Glow pulse per line
      const glowAnim = lineEl.animate([
        { textShadow: '0 0 0px transparent' },
        { textShadow: '0 0 12px rgba(0, 204, 255, 0.5)', offset: 0.4 },
        { textShadow: '0 0 3px rgba(0, 204, 255, 0.1)' },
      ], {
        duration: 500,
        delay: delay + 180,
        easing: 'ease-out',
        fill: 'forwards',
      });
      this.revealAnimations.push(glowAnim);
    }

    return lineIndex + lines.length;
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
    // AI overlay active — delegate all keys to it
    if (this.aiOverlay) {
      return this.aiOverlay.onKeyDown(e);
    }

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

    // Search box editing — let the input element handle typing/Enter/Esc itself.
    if (this.searchActive && this.searchInput && document.activeElement === this.searchInput) {
      return false;
    }

    // Don't intercept modifier combos (let globals handle them)
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    if (this.hintActive) {
      return this.handleHintKey(e);
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
    // Search results present (input not focused) — n/N cycle, Esc/q clears.
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
        case 'q':
          this.closeSearch();
          return true;
        // other keys fall through (scrolling still works while matches persist)
      }
    }

    switch (e.key) {
      case 'h':
      case 'ArrowLeft':
        this.setFocus('sidebar');
        return true;
      case '/':
        this.openSearch();
        return true;
      case 'H':
        this.enterHeadingHintMode();
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
      case 'i':
        this.openAI();
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
  private annotateBlocksWithRaw(rawText: string, lineOffset = 0): void {
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
        const startLine = rawText.slice(0, tokStart).split('\n').length + lineOffset;
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

  // ── Hint Mode (shared: links + headings) ──

  private hasPreviewLinks(): boolean {
    return this.previewContent.querySelector('a[href]') !== null;
  }

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

  /** Generic hint overlay: badge each target, run `onPick` for the typed label. */
  private enterHintMode(targets: HTMLElement[], onPick: (el: HTMLElement) => void): void {
    if (targets.length === 0) return;

    const labels = MarkdownContentView.generateHintLabels(targets.length);
    this.hintMap.clear();
    this.hintLabels = [];
    this.hintInput = '';
    this.hintOnPick = onPick;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const label = labels[i];
      this.hintMap.set(label, target);

      const badge = document.createElement('span');
      badge.className = 'krypton-md__link-hint';
      badge.textContent = label;
      // Anchor the badge; remember the prior inline position to restore on exit
      // so we don't leave a permanent side-effect on headings/links.
      this.hintTouched.push({ el: target, prevPosition: target.style.position });
      target.style.position = 'relative';
      target.appendChild(badge);
      this.hintLabels.push(badge);
    }

    this.hintActive = true;
  }

  private enterLinkHintMode(): void {
    const links = Array.from(
      this.previewContent.querySelectorAll('a[href]'),
    ) as HTMLAnchorElement[];
    this.enterHintMode(links, (el) => {
      const href = el.getAttribute('href');
      if (!href) return;
      if (href.endsWith('.md') && !href.includes('://')) {
        this.navigateToLocalMd(href);
      } else {
        openExternalUrl(href);
      }
    });
  }

  private enterHeadingHintMode(): void {
    const headings = Array.from(
      this.previewContent.querySelectorAll('h1, h2, h3, h4, h5, h6'),
    ) as HTMLElement[];
    this.enterHintMode(headings, (el) => {
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  }

  private exitHintMode(): void {
    for (const badge of this.hintLabels) badge.remove();
    for (const { el, prevPosition } of this.hintTouched) el.style.position = prevPosition;
    this.hintTouched = [];
    this.hintLabels = [];
    this.hintMap.clear();
    this.hintInput = '';
    this.hintOnPick = null;
    this.hintActive = false;
  }

  private handleHintKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.exitHintMode();
      return true;
    }

    if (e.key.length !== 1) return true; // absorb non-character keys

    this.hintInput += e.key.toLowerCase();

    // Check for exact match
    const match = this.hintMap.get(this.hintInput);
    if (match) {
      const onPick = this.hintOnPick;
      this.exitHintMode();
      onPick?.(match);
      return true;
    }

    // Check if input is a prefix of any label
    let hasPrefix = false;
    for (const label of this.hintMap.keys()) {
      if (label.startsWith(this.hintInput)) {
        hasPrefix = true;
        break;
      }
    }

    if (!hasPrefix) {
      // No possible match — exit
      this.exitHintMode();
    } else {
      // Dim non-matching hints
      for (const badge of this.hintLabels) {
        const label = badge.textContent || '';
        badge.classList.toggle(
          'krypton-md__link-hint--dimmed',
          !label.startsWith(this.hintInput),
        );
      }
    }
    return true;
  }

  // ── In-Doc Search ──

  private static readonly SEARCH_MATCH_CAP = 500;

  /** Open (or re-focus) the in-doc search HUD. */
  private openSearch(): void {
    if (!this.searchHud) {
      this.searchHud = document.createElement('div');
      this.searchHud.className = 'krypton-md__search';

      const prompt = document.createElement('span');
      prompt.className = 'krypton-md__search-prompt';
      prompt.textContent = '/';

      this.searchInput = document.createElement('input');
      this.searchInput.className = 'krypton-md__search-input';
      this.searchInput.placeholder = 'search...';
      this.searchInput.addEventListener('input', () => this.scheduleSearch(this.searchInput!.value));
      this.searchInput.addEventListener('keydown', (e) => this.handleSearchInputKey(e));

      const count = document.createElement('span');
      count.className = 'krypton-md__search-count';

      this.searchHud.append(prompt, this.searchInput, count);
      this.previewContent.parentElement?.appendChild(this.searchHud);
    }

    this.searchActive = true;
    this.searchHud.style.display = '';
    this.searchInput!.focus();
    this.searchInput!.select();
    this.applySearch(this.searchInput!.value);
  }

  private handleSearchInputKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.closeSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.flushSearch(); // ensure matches reflect the latest query before stepping
      this.searchStep(e.shiftKey ? -1 : 1);
      // Blur so n/N work as navigation in the preview pane.
      this.searchInput?.blur();
      this.element.focus();
    }
  }

  /** Debounced live re-highlight — avoids a full unwrap+TreeWalk on every keystroke. */
  private scheduleSearch(query: string): void {
    if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
    this.searchDebounce = window.setTimeout(() => {
      this.searchDebounce = null;
      this.applySearch(query);
    }, 120);
  }

  /** Run any pending debounced search immediately. */
  private flushSearch(): void {
    if (this.searchDebounce === null) return;
    clearTimeout(this.searchDebounce);
    this.searchDebounce = null;
    this.applySearch(this.searchInput?.value ?? '');
  }

  /** Re-highlight matches for the current query. */
  private applySearch(query: string): void {
    this.unwrapMatches();
    const q = query.toLowerCase();
    if (!q) {
      this.updateSearchCount();
      return;
    }

    // Collect candidate text nodes first (mutating during walk is unsafe).
    const walker = document.createTreeWalker(this.previewContent, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement;
        if (!p || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (p.closest('pre, code, .krypton-md__link-hint, .krypton-md__search')) {
          return NodeFilter.FILTER_REJECT;
        }
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
      if (this.searchMatches.length >= MarkdownContentView.SEARCH_MATCH_CAP) break;
      const text = node.nodeValue ?? '';
      const lower = text.toLowerCase();
      if (!lower.includes(q)) continue;

      const frag = document.createDocumentFragment();
      let last = 0;
      let idx = lower.indexOf(q, 0);
      while (idx !== -1 && this.searchMatches.length < MarkdownContentView.SEARCH_MATCH_CAP) {
        if (idx > last) frag.append(text.slice(last, idx));
        const mark = document.createElement('mark');
        mark.className = 'krypton-md__match';
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

  /** Move to the next/previous match and scroll it into view. */
  private searchStep(delta: number): void {
    if (this.searchMatches.length === 0) return;
    if (this.searchIndex >= 0) {
      this.searchMatches[this.searchIndex]?.classList.remove('krypton-md__match--current');
    }
    const n = this.searchMatches.length;
    this.searchIndex = ((this.searchIndex + delta) % n + n) % n;
    const current = this.searchMatches[this.searchIndex];
    current.classList.add('krypton-md__match--current');
    current.scrollIntoView({ behavior: 'auto', block: 'center' });
    this.updateSearchCount();
  }

  private updateSearchCount(): void {
    const count = this.searchHud?.querySelector('.krypton-md__search-count');
    if (!count) return;
    const total = this.searchMatches.length;
    if (total === 0) {
      count.textContent = 'no matches';
    } else {
      const pos = this.searchIndex >= 0 ? `${this.searchIndex + 1}/` : '';
      const capped = total >= MarkdownContentView.SEARCH_MATCH_CAP ? '+' : '';
      count.textContent = `${pos}${total}${capped}`;
    }
  }

  /** Remove all <mark> wrappers, restoring the original text. */
  private unwrapMatches(): void {
    for (const mark of this.searchMatches) {
      mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
    }
    this.searchMatches = [];
    this.searchIndex = -1;
    this.previewContent.normalize();
  }

  /** Close the search HUD and clear highlights. */
  private closeSearch(): void {
    if (this.searchDebounce !== null) {
      clearTimeout(this.searchDebounce);
      this.searchDebounce = null;
    }
    this.unwrapMatches();
    this.searchActive = false;
    if (this.searchHud) this.searchHud.style.display = 'none';
    if (this.focusPanel === 'preview') this.element.focus();
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
    if (file) this.loadFile(file, true, true);
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

  // ── AI Overlay ──

  private async openAI(): Promise<void> {
    if (this.aiOverlay) return;

    const { MarkdownViewAI } = await import('./markdown-view-ai');

    // Tear down transient overlays so their badges/highlights don't sit behind
    // the AI panel (select state is preserved — it feeds getAIContext).
    if (this.searchActive) this.closeSearch();
    if (this.hintActive) this.exitHintMode();

    this.aiOverlay = new MarkdownViewAI({
      cwd: this.cwd,
      getContext: () => this.getAIContext(),
      onClose: () => this.closeAI(),
    });

    this.aiOverlay.open(this.element);
  }

  private closeAI(): void {
    if (!this.aiOverlay) return;
    this.aiOverlay.close();
    this.aiOverlay = null;
  }

  private getAIContext(): MarkdownViewContext {
    const currentFile = this.previewHeader.textContent || null;

    // Collect selected text if in select mode
    let selectedText: string | null = null;
    if (this.selectableBlocks.length > 0 && this.selectAnchor >= 0) {
      const texts = this.collectSelectedText();
      if (texts.length > 0) {
        selectedText = texts.join('\n\n');
      }
    }

    return {
      cwd: this.cwd,
      currentFile,
      selectedText,
    };
  }

  onResize(): void {
    // No special handling needed
  }

  dispose(): void {
    this.closeAI();
    if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
    for (const a of this.revealAnimations) a.cancel();
    this.revealAnimations = [];
    this.element.remove();
  }
}
