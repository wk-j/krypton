// Krypton — Quick File Search
//
// Cmd+O opens a centered overlay backed by `fff-search` running in the Rust
// process. Enter opens the highlighted file in Helix in a new tab. Ctrl+E
// copies the relative path to the clipboard; Cmd+Enter copies the absolute
// path. Clipboard picks are never auto-pasted, so behavior is identical
// across terminal, agent, hurl, markdown, vault windows.
//
// See docs/68-quick-file-search.md.

import { invoke } from '@tauri-apps/api/core';
import { Compositor } from './compositor';
import { openInHelixTab } from './editor-open';
import type { QuickGrepHit, QuickGrepResponse, QuickSearchHit, QuickSearchResponse } from './types';

type SearchMode = 'file' | 'grep';

const RESULT_LIMIT = 50;
const QUERY_DEBOUNCE_MS = 16;
const FLASH_MS = 80;

export class QuickFileSearch {
  private compositor: Compositor;
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private rootEl: HTMLElement;
  private resultsList: HTMLElement;
  private statusBar: HTMLElement;
  private hintBar: HTMLElement;

  private results: QuickSearchHit[] = [];
  private grepResults: QuickGrepHit[] = [];
  private mode: SearchMode = 'file';
  private selectedIndex = 0;
  private visible = false;
  private currentRoot: string | null = null;

  private queryToken = 0;
  private debounceTimer: number | null = null;
  private mouseMovedSinceOpen = false;

  private onCloseCallback: () => void;

  constructor(compositor: Compositor, onClose: () => void) {
    this.compositor = compositor;
    this.onCloseCallback = onClose;
    this.overlay = this.buildDom();
    this.input = this.overlay.querySelector('.krypton-quicksearch__input')!;
    this.rootEl = this.overlay.querySelector('.krypton-quicksearch__root')!;
    this.resultsList = this.overlay.querySelector('.krypton-quicksearch__results')!;
    this.statusBar = this.overlay.querySelector('.krypton-quicksearch__statusbar')!;
    this.hintBar = this.overlay.querySelector('.krypton-quicksearch__hint')!;

    this.input.addEventListener('input', () => {
      this.scheduleQuery();
    });

    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    this.overlay.addEventListener('mousemove', () => {
      this.mouseMovedSinceOpen = true;
    });

    document.body.appendChild(this.overlay);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  async open(): Promise<void> {
    if (this.visible) return;
    this.visible = true;
    this.results = [];
    this.grepResults = [];
    this.mode = 'file';
    this.selectedIndex = 0;
    this.mouseMovedSinceOpen = false;
    this.input.value = '';
    this.input.placeholder = 'find file…';
    this.updateModeBadge();
    this.renderResults();
    this.statusBar.textContent = 'resolving…';
    this.overlay.classList.add('krypton-quicksearch--visible');
    this.compositor.soundEngine.play('command_palette.open');

    requestAnimationFrame(() => this.input.focus());

    const cwd = await this.resolveCwd();
    let root: string;
    try {
      root = await invoke<string>('quick_search_warm_root', { cwd });
    } catch (e) {
      console.error('[QuickFileSearch] warm_root failed:', e);
      this.statusBar.textContent = `error: ${String(e)}`;
      this.rootEl.textContent = abbreviatePath(cwd);
      this.currentRoot = cwd;
      return;
    }
    this.currentRoot = root;
    this.rootEl.textContent = abbreviatePath(root);
    void this.runQuery();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.overlay.classList.remove('krypton-quicksearch--visible');
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.compositor.soundEngine.play('command_palette.close');
    this.onCloseCallback();
  }

  /** Returns true if the event was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.visible) return false;

    // Cmd+Enter — copy absolute path
    if (e.key === 'Enter' && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      void this.acceptSelected('absolute');
      return true;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      this.toggleMode();
      return true;
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.close();
        return true;

      case 'Enter':
        e.preventDefault();
        void this.openInHelix();
        return true;

      case 'ArrowDown':
        e.preventDefault();
        this.move(1);
        return true;

      case 'ArrowUp':
        e.preventDefault();
        this.move(-1);
        return true;
    }

    // Ctrl+P / Ctrl+N readline-style cursor; Ctrl+E copy relative path
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'n' || e.key === 'p') {
        e.preventDefault();
        this.move(e.key === 'n' ? 1 : -1);
        return true;
      }
      if (e.key === 'u') {
        e.preventDefault();
        this.input.value = '';
        this.scheduleQuery();
        return true;
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        void this.acceptSelected('relative');
        return true;
      }
    }

    // Let typing flow to the <input>
    return false;
  }

  // ─── private ──────────────────────────────────────────────

  private async resolveCwd(): Promise<string> {
    try {
      const cwd = await this.compositor.getFocusedWorkingDirectory();
      if (cwd) return cwd;
    } catch {
      // fall through
    }
    // Fallback: $HOME (resolve via backend by canonicalizing ".")
    return '.';
  }

  private scheduleQuery(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runQuery();
    }, QUERY_DEBOUNCE_MS);
  }

  private toggleMode(): void {
    this.mode = this.mode === 'file' ? 'grep' : 'file';
    this.input.placeholder = this.mode === 'grep' ? 'grep this project…' : 'find file…';
    this.updateModeBadge();
    this.selectedIndex = 0;
    this.renderResults();
    void this.runQuery();
  }

  private updateModeBadge(): void {
    this.overlay.dataset.mode = this.mode;
  }

  private async runQuery(): Promise<void> {
    if (!this.currentRoot) return;
    if (this.mode === 'grep') {
      return this.runGrepQuery();
    }
    const myToken = ++this.queryToken;
    const q = this.input.value;

    let resp: QuickSearchResponse;
    try {
      resp = await invoke<QuickSearchResponse>('quick_search_query', {
        root: this.currentRoot,
        query: q,
        limit: RESULT_LIMIT,
      });
    } catch (e) {
      if (myToken !== this.queryToken) return;
      this.statusBar.textContent = `error: ${String(e)}`;
      this.results = [];
      this.renderResults();
      return;
    }
    if (myToken !== this.queryToken) return;

    this.results = resp.hits;
    this.selectedIndex = 0;
    this.renderResults();

    if (resp.indexing) {
      const n = resp.indexed_count.toLocaleString();
      this.statusBar.textContent = `indexing… (${n} files)`;
      // Re-poll after a short delay so the UI catches up as the scan completes.
      window.setTimeout(() => {
        if (myToken === this.queryToken) void this.runQuery();
      }, 250);
    } else if (resp.hits.length === 0) {
      this.statusBar.textContent = q.length === 0
        ? 'Type to search this project (no history yet)'
        : 'no matches';
    } else {
      this.statusBar.textContent = `${resp.hits.length} matches`;
    }
  }

  private async runGrepQuery(): Promise<void> {
    if (!this.currentRoot) return;
    const myToken = ++this.queryToken;
    const q = this.input.value;

    if (q.trim().length === 0) {
      this.grepResults = [];
      this.selectedIndex = 0;
      this.renderResults();
      this.statusBar.textContent = 'grep — type a query';
      return;
    }

    let resp: QuickGrepResponse;
    try {
      resp = await invoke<QuickGrepResponse>('quick_grep_query', {
        root: this.currentRoot,
        query: q,
        limit: RESULT_LIMIT,
      });
    } catch (e) {
      if (myToken !== this.queryToken) return;
      this.statusBar.textContent = `error: ${String(e)}`;
      this.grepResults = [];
      this.renderResults();
      return;
    }
    if (myToken !== this.queryToken) return;

    this.grepResults = resp.hits;
    this.selectedIndex = 0;
    this.renderResults();

    const re = resp.regex_fallback_error;
    if (resp.indexing) {
      this.statusBar.textContent = `indexing… (${resp.indexed_count.toLocaleString()} files)`;
      window.setTimeout(() => {
        if (myToken === this.queryToken) void this.runGrepQuery();
      }, 250);
    } else if (re) {
      this.statusBar.textContent = `regex fallback: ${re}`;
    } else if (resp.hits.length === 0) {
      this.statusBar.textContent = 'no matches';
    } else {
      this.statusBar.textContent = `${resp.hits.length} matches (grep)`;
    }
  }

  private currentLength(): number {
    return this.mode === 'grep' ? this.grepResults.length : this.results.length;
  }

  private move(delta: number): void {
    const len = this.currentLength();
    if (len === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + len) % len;
    this.updateSelection();
    this.scrollToSelected();
  }

  private updateSelection(): void {
    const items = this.resultsList.querySelectorAll('.krypton-quicksearch__result');
    items.forEach((el, i) => {
      el.classList.toggle('is-selected', i === this.selectedIndex);
    });
  }

  private scrollToSelected(): void {
    const el = this.resultsList.children[this.selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }

  private async acceptSelected(kind: 'relative' | 'absolute'): Promise<void> {
    if (this.currentLength() === 0) return;

    let text: string;
    let absolute: string;
    if (this.mode === 'grep') {
      const hit = this.grepResults[this.selectedIndex];
      if (!hit) return;
      const base = kind === 'absolute' ? hit.absolute : hit.path;
      text = `${base}:${hit.line}:${hit.col + 1}`;
      absolute = hit.absolute;
    } else {
      const hit = this.results[this.selectedIndex];
      if (!hit) return;
      text = kind === 'absolute' ? hit.absolute : hit.path;
      absolute = hit.absolute;
    }

    let copied = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      copied = false;
      console.error('[QuickFileSearch] clipboard write failed:', e);
      this.statusBar.textContent = 'clipboard write failed';
    }

    // Record the pick (frecency) — fire-and-forget.
    invoke('quick_search_record_pick', { absolute }).catch((e) => {
      console.warn('[QuickFileSearch] record_pick failed:', e);
    });

    if (!copied) return;

    this.compositor.soundEngine.play('command_palette.execute');
    this.flashSelected(kind);
    window.setTimeout(() => this.close(), FLASH_MS);
  }

  private async openInHelix(): Promise<void> {
    if (this.currentLength() === 0) return;

    let absolute: string;
    let line: number | null = null;
    let col: number | null = null;
    if (this.mode === 'grep') {
      const hit = this.grepResults[this.selectedIndex];
      if (!hit) return;
      absolute = hit.absolute;
      line = hit.line;
      col = hit.col + 1;
    } else {
      const hit = this.results[this.selectedIndex];
      if (!hit) return;
      absolute = hit.absolute;
    }

    const result = await openInHelixTab(this.compositor, {
      path: absolute,
      line,
      col,
    });
    if (result === 'create-tab-failed') {
      this.statusBar.textContent = 'open failed: createTab';
      return;
    }
    if (result === 'no-focused-window') {
      this.statusBar.textContent = 'open failed: no focused window';
      return;
    }

    invoke('quick_search_record_pick', { absolute }).catch((e) => {
      console.warn('[QuickFileSearch] record_pick failed:', e);
    });

    this.compositor.soundEngine.play('command_palette.execute');
    this.flashSelected('helix');
    window.setTimeout(() => this.close(), FLASH_MS);
  }

  private flashSelected(kind: 'relative' | 'absolute' | 'helix'): void {
    const row = this.resultsList.children[this.selectedIndex] as HTMLElement | undefined;
    if (row) row.classList.add('is-flashing');
    this.hintBar.dataset.flash = kind;
    window.setTimeout(() => {
      row?.classList.remove('is-flashing');
      delete this.hintBar.dataset.flash;
    }, FLASH_MS);
  }

  private renderResults(): void {
    this.resultsList.innerHTML = '';
    if (this.mode === 'grep') {
      this.renderGrepResults();
    } else {
      this.renderFileResults();
    }
  }

  private renderFileResults(): void {
    const q = this.input.value;
    for (let i = 0; i < this.results.length; i++) {
      const hit = this.results[i];
      const li = document.createElement('li');
      li.className = 'krypton-quicksearch__result';
      if (i === this.selectedIndex) li.classList.add('is-selected');

      const { dir, name } = splitPath(hit.path);
      const filenameEl = document.createElement('span');
      filenameEl.className = 'krypton-quicksearch__filename';
      filenameEl.append(...highlight(name, q));

      const parentEl = document.createElement('span');
      parentEl.className = 'krypton-quicksearch__parent';
      parentEl.textContent = dir;

      li.appendChild(filenameEl);
      li.appendChild(parentEl);
      this.attachRowEvents(li, i);
      this.resultsList.appendChild(li);
    }
  }

  private renderGrepResults(): void {
    for (let i = 0; i < this.grepResults.length; i++) {
      const hit = this.grepResults[i];
      const li = document.createElement('li');
      li.className = 'krypton-quicksearch__result krypton-quicksearch__result--grep';
      if (i === this.selectedIndex) li.classList.add('is-selected');

      const locEl = document.createElement('span');
      locEl.className = 'krypton-quicksearch__grep-loc';
      locEl.textContent = `${hit.path}:${hit.line}`;

      const snippetEl = document.createElement('span');
      snippetEl.className = 'krypton-quicksearch__grep-snippet';
      snippetEl.append(...highlightRanges(hit.line_content, hit.match_ranges));

      li.appendChild(locEl);
      li.appendChild(snippetEl);
      this.attachRowEvents(li, i);
      this.resultsList.appendChild(li);
    }
  }

  private attachRowEvents(li: HTMLElement, i: number): void {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.selectedIndex = i;
      this.updateSelection();
      void this.acceptSelected(e.metaKey ? 'absolute' : 'relative');
    });
    li.addEventListener('mouseenter', () => {
      if (!this.mouseMovedSinceOpen) return;
      this.selectedIndex = i;
      this.updateSelection();
    });
  }

  private buildDom(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'krypton-quicksearch';
    overlay.innerHTML = `
      <div class="krypton-quicksearch__container">
        <div class="krypton-quicksearch__input-row">
          <span class="krypton-quicksearch__prompt">⟶</span>
          <input class="krypton-quicksearch__input" type="text" spellcheck="false"
                 autocomplete="off" placeholder="find file…" />
          <span class="krypton-quicksearch__root"></span>
        </div>
        <ul class="krypton-quicksearch__results"></ul>
        <div class="krypton-quicksearch__statusbar"></div>
        <div class="krypton-quicksearch__hint">
          <span data-kind="helix">↵ open in hx</span>
          <span data-kind="relative">^E copy</span>
          <span data-kind="absolute">⌘↵ copy absolute</span>
          <span>⇥ toggle file/grep</span>
          <span>⎋ close</span>
        </div>
      </div>
    `;
    return overlay;
  }
}

// ─── helpers ──────────────────────────────────────────────

function splitPath(p: string): { dir: string; name: string } {
  const idx = p.lastIndexOf('/');
  if (idx < 0) return { dir: '', name: p };
  return { dir: p.slice(0, idx + 1), name: p.slice(idx + 1) };
}

function abbreviatePath(p: string): string {
  const home = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  let s = p;
  if (home) s = '~' + p.slice(home[1].length);
  if (s.length > 56) s = '…' + s.slice(s.length - 53);
  return s;
}

/** Highlight explicit byte ranges (used by grep — fff-search reports
 *  match_byte_offsets directly so we don't need to re-derive indices). */
function highlightRanges(text: string, ranges: Array<[number, number]>): Node[] {
  if (ranges.length === 0) return [document.createTextNode(text)];
  // Sort + merge overlapping ranges defensively.
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Node[] = [];
  let cursor = 0;
  for (const [s, e] of sorted) {
    if (e <= cursor) continue;
    const start = Math.max(s, cursor);
    if (start > cursor) out.push(document.createTextNode(text.slice(cursor, start)));
    const end = Math.min(e, text.length);
    if (end > start) {
      const m = document.createElement('mark');
      m.textContent = text.slice(start, end);
      out.push(m);
    }
    cursor = end;
  }
  if (cursor < text.length) out.push(document.createTextNode(text.slice(cursor)));
  return out;
}

/** Subsequence highlight — matches the same case-insensitive walk used by
 *  `command-palette` so highlights line up with what the user typed. */
function highlight(text: string, query: string): Node[] {
  if (!query) return [document.createTextNode(text)];
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < tl.length && qi < ql.length; ti++) {
    if (tl[ti] === ql[qi]) {
      indices.push(ti);
      qi++;
    }
  }
  if (qi < ql.length) return [document.createTextNode(text)];
  const set = new Set(indices);
  const out: Node[] = [];
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      const m = document.createElement('mark');
      m.textContent = text[i];
      out.push(m);
    } else {
      out.push(document.createTextNode(text[i]));
    }
  }
  return out;
}
