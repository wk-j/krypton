// Krypton — Search Palette (spec 349)
//
// One overlay with three scope tabs: Commands | Files | Grep. `Cmd+Shift+P`
// opens it on Commands and `Cmd+O` on Files; Tab / Shift+Tab move between
// tabs and the typed query carries over. Each tab is a SearchScope that owns
// its engine, rows and accept actions (command-palette.ts,
// quick-file-search.ts); this class owns the DOM, selection, keys and the one
// close path that tells the InputRouter to leave the palette mode.

import { keyCap, keyHint } from './ui/kbd';
import type { SoundEngine } from './sound';
import type {
  AcceptControl,
  AcceptHow,
  ScopeId,
  ScopeRow,
  SearchScope,
} from './palette-types';

const SCOPE_ORDER: readonly ScopeId[] = ['commands', 'files', 'grep'];
const QUERY_DEBOUNCE_MS = 16;
const REPOLL_MS = 250;
const FLASH_MS = 80;

export interface ClosePaletteOptions {
  /** Skip the close sound (the accept already played `execute`). */
  silent?: boolean;
  /** Call the owner's onClose. False when the InputRouter itself is changing mode. */
  notify?: boolean;
}

export class SearchPalette {
  private readonly overlay: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly asideEl: HTMLElement;
  private readonly resultsEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly tabEls = new Map<ScopeId, HTMLElement>();

  private active: ScopeId = 'commands';
  private rows: ScopeRow[] = [];
  private rowEls: HTMLElement[] = [];
  private selectedIndex = 0;
  private visible = false;

  /** Bumped on every tab entry and close: drops activations from an old tab. */
  private epoch = 0;
  /** Bumped on every query: drops any response that is no longer the latest. */
  private queryToken = 0;
  private debounceTimer: number | null = null;

  constructor(
    private readonly scopes: Readonly<Record<ScopeId, SearchScope>>,
    private readonly sound: SoundEngine,
    private readonly onClose: () => void,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'krypton-search-palette';

    const container = document.createElement('div');
    container.className = 'krypton-search-palette__container';

    const tabs = document.createElement('div');
    tabs.className = 'krypton-search-palette__tabs';
    tabs.setAttribute('role', 'tablist');
    for (const id of SCOPE_ORDER) {
      const scope = this.scopes[id];
      const tab = document.createElement('div');
      tab.className = 'krypton-search-palette__tab';
      tab.setAttribute('role', 'tab');
      tab.dataset.scope = id;
      const label = document.createElement('span');
      label.className = 'krypton-search-palette__tab-label';
      label.textContent = scope.label;
      tab.appendChild(label);
      if (scope.shortcut) {
        tab.appendChild(keyCap(scope.shortcut));
      }
      tab.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.switchTo(id);
      });
      this.tabEls.set(id, tab);
      tabs.appendChild(tab);
    }

    const inputRow = document.createElement('div');
    inputRow.className = 'krypton-search-palette__input-row';
    this.promptEl = document.createElement('span');
    this.promptEl.className = 'krypton-search-palette__prompt';
    this.input = document.createElement('input');
    this.input.className = 'krypton-search-palette__input';
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.asideEl = document.createElement('span');
    this.asideEl.className = 'krypton-search-palette__aside';
    inputRow.append(this.promptEl, this.input, this.asideEl);

    this.resultsEl = document.createElement('div');
    this.resultsEl.className = 'krypton-search-palette__results';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'krypton-search-palette__status';
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'krypton-search-palette__hint';

    container.append(tabs, inputRow, this.resultsEl, this.statusEl, this.hintEl);
    this.overlay.appendChild(container);
    document.body.appendChild(this.overlay);

    this.input.addEventListener('input', () => this.scheduleQuery());
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    for (const id of SCOPE_ORDER) {
      this.scopes[id].setInvalidate?.(() => {
        if (this.visible && this.active === id) void this.runQuery();
      });
    }
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get activeScope(): ScopeId {
    return this.active;
  }

  /** Show the palette on `scope` with an empty query. No-op while visible. */
  open(scope: ScopeId): void {
    if (this.visible) return;
    this.visible = true;
    this.input.value = '';
    for (const id of SCOPE_ORDER) this.scopes[id].reset();
    this.overlay.classList.add('krypton-search-palette--visible');
    this.sound.play('command_palette.open');
    this.enter(scope);
    requestAnimationFrame(() => this.input.focus());
  }

  /** Move to another tab, keeping the typed query. */
  switchTo(scope: ScopeId): void {
    if (!this.visible || scope === this.active) return;
    this.enter(scope);
    this.input.focus();
  }

  /** Every close path ends here. */
  close(options: ClosePaletteOptions = {}): void {
    if (!this.visible) return;
    this.visible = false;
    this.epoch++;
    this.queryToken++;
    this.clearDebounce();
    this.overlay.classList.remove('krypton-search-palette--visible');
    if (!options.silent) this.sound.play('command_palette.close');
    if (options.notify !== false) this.onClose();
  }

  /** Returns true if the event was consumed; unconsumed keys reach the <input>. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.visible) return false;

    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.cycleScope(e.shiftKey ? -1 : 1);
      return true;
    }

    // Cmd+Enter — copy absolute path (Files / Grep)
    if (e.key === 'Enter' && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      void this.acceptSelected('copy-absolute');
      return true;
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.close();
        return true;
      case 'Enter':
        e.preventDefault();
        void this.acceptSelected('primary');
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

    // Ctrl+N / Ctrl+P readline-style cursor; Ctrl+U clear; Ctrl+E copy relative
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.code === 'KeyN' || e.code === 'KeyP') {
        e.preventDefault();
        this.move(e.code === 'KeyN' ? 1 : -1);
        return true;
      }
      if (e.code === 'KeyU') {
        e.preventDefault();
        this.input.value = '';
        this.scheduleQuery();
        return true;
      }
      if (e.code === 'KeyE') {
        e.preventDefault();
        void this.acceptSelected('copy-relative');
        return true;
      }
    }

    // Alt+1..9 — accept the Nth visible row. Match on code: Option changes
    // e.key on macOS.
    if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
      const index = Number(e.code.slice(5)) - 1;
      if (index < this.rows.length) {
        e.preventDefault();
        this.select(index);
        void this.acceptSelected('primary');
        return true;
      }
    }

    return false;
  }

  // ─── private ──────────────────────────────────────────────

  private cycleScope(delta: number): void {
    const at = SCOPE_ORDER.indexOf(this.active);
    const next = SCOPE_ORDER[(at + delta + SCOPE_ORDER.length) % SCOPE_ORDER.length];
    this.switchTo(next);
  }

  /** Make `scope` the active tab, activate it, then run the current query. */
  private enter(scope: ScopeId): void {
    this.active = scope;
    const epoch = ++this.epoch;
    this.queryToken++;
    this.clearDebounce();

    const s = this.scopes[scope];
    for (const [id, tab] of this.tabEls) {
      const on = id === scope;
      tab.classList.toggle('krypton-search-palette__tab--active', on);
      tab.setAttribute('aria-selected', String(on));
    }
    this.overlay.dataset.scope = scope;
    this.promptEl.textContent = s.prompt;
    this.input.placeholder = s.placeholder;
    this.asideEl.textContent = s.aside();
    this.renderHints(s);
    this.setRows([]);
    this.statusEl.textContent = '';

    void s.activate().then(
      () => {
        if (epoch !== this.epoch) return;
        this.asideEl.textContent = s.aside();
        void this.runQuery();
      },
      (err: unknown) => {
        if (epoch !== this.epoch) return;
        this.statusEl.textContent = `error: ${String(err)}`;
      },
    );
  }

  private scheduleQuery(): void {
    this.clearDebounce();
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runQuery();
    }, QUERY_DEBOUNCE_MS);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async runQuery(): Promise<void> {
    if (!this.visible) return;
    const token = ++this.queryToken;
    const scope = this.scopes[this.active];
    let rows: ScopeRow[];
    let status: string;
    let pending: boolean;
    try {
      ({ rows, status, pending } = await scope.query(this.input.value));
    } catch (err) {
      if (token !== this.queryToken) return;
      console.error(`[SearchPalette] ${scope.id} query failed:`, err);
      this.setRows([]);
      this.statusEl.textContent = `error: ${String(err)}`;
      return;
    }
    if (token !== this.queryToken) return;

    this.setRows(rows);
    this.statusEl.textContent = status;
    this.asideEl.textContent = scope.aside();
    if (pending) {
      // The backend is still indexing: poll until the scan settles.
      window.setTimeout(() => {
        if (token === this.queryToken) void this.runQuery();
      }, REPOLL_MS);
    }
  }

  private setRows(rows: ScopeRow[]): void {
    this.rows = rows;
    this.selectedIndex = 0;
    this.resultsEl.textContent = '';
    this.rowEls = [];

    const zeroQuery = this.input.value.trim().length === 0;
    let previousSection: ScopeRow['section'] = undefined;
    rows.forEach((row, i) => {
      if (zeroQuery && row.section === 'context' && previousSection !== 'context') {
        const header = document.createElement('div');
        header.className = 'krypton-search-palette__section-header';
        header.textContent = 'Context';
        this.resultsEl.appendChild(header);
      }
      previousSection = row.section;

      const el = document.createElement('div');
      el.className = 'krypton-search-palette__row';
      if (row.section === 'context') el.classList.add('krypton-search-palette__row--context');
      if (i === this.selectedIndex) el.classList.add('krypton-search-palette__row--selected');
      row.render(el);
      el.addEventListener('mouseenter', () => this.select(i));
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.select(i);
        void this.acceptSelected('primary');
      });
      this.rowEls.push(el);
      this.resultsEl.appendChild(el);
    });
  }

  private renderHints(scope: SearchScope): void {
    this.hintEl.textContent = '';
    delete this.hintEl.dataset.flash;
    for (const hint of scope.hints) {
      const span = document.createElement('span');
      span.appendChild(keyHint(hint));
      if (hint.kind) span.dataset.kind = hint.kind;
      this.hintEl.appendChild(span);
    }
  }

  private select(index: number): void {
    this.rowEls[this.selectedIndex]?.classList.remove('krypton-search-palette__row--selected');
    this.selectedIndex = index;
    this.rowEls[index]?.classList.add('krypton-search-palette__row--selected');
  }

  private move(delta: number): void {
    const len = this.rows.length;
    if (len === 0) return;
    this.select((this.selectedIndex + delta + len) % len);
    this.rowEls[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private async acceptSelected(how: AcceptHow): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (!row) return;
    const ctl: AcceptControl = {
      close: () => this.close({ silent: true }),
      setStatus: (text) => {
        this.statusEl.textContent = text;
      },
      flash: (kind) => this.flash(kind),
      playExecute: () => this.sound.play('command_palette.execute'),
    };
    await this.scopes[this.active].accept(row, how, ctl);
  }

  private flash(kind: string): Promise<void> {
    const row = this.rowEls[this.selectedIndex];
    row?.classList.add('krypton-search-palette__row--flashing');
    this.hintEl.dataset.flash = kind;
    return new Promise((resolve) => {
      window.setTimeout(() => {
        row?.classList.remove('krypton-search-palette__row--flashing');
        delete this.hintEl.dataset.flash;
        resolve();
      }, FLASH_MS);
    });
  }
}
