// Krypton — Webview content view (feature 102).
// Hosts a Tauri child webview behind DOM chrome. The native webview sits on
// top of `.krypton-webview-host`; chrome (address bar, loading bar) lives in
// DOM around it. Bounds sync runs through ResizeObserver, with visibility
// driven by the compositor calling suspend()/resume() on overlay/workspace
// transitions (the native webview always renders above DOM and would
// otherwise occlude command palettes etc.).

import { invoke } from './profiler/ipc';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  ContentView,
  PaneContentType,
  WebviewId,
  WebviewState,
} from './types';

interface LoadingEvent { id: WebviewId; started: boolean }
interface NavigatedEvent { id: WebviewId; url: string }
interface TitleEvent { id: WebviewId; title: string }
interface ChordEvent { id: WebviewId; key: string; mods: number }
interface ActionEvent {
  id: WebviewId;
  kind: string;
  url?: string | null;
  target?: string | null;
}

const RESIZE_DEBOUNCE_MS = 16;

export class WebviewContentView implements ContentView {
  readonly type: PaneContentType = 'webview';
  readonly element: HTMLElement;

  private hostEl: HTMLElement;
  private addressInput: HTMLInputElement;
  private loadingBar: HTMLElement;
  private backBtn: HTMLElement;
  private fwdBtn: HTMLElement;
  private reloadBtn: HTMLElement;

  private state: WebviewState = {
    id: -1,
    url: '',
    pendingUrl: null,
    title: '',
    loading: false,
  };

  private disposed = false;
  private suspended = false;
  private pendingFocus = false;

  private resizeObs: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private lastBounds = { x: -1, y: -1, w: -1, h: -1 };

  private unlisteners: UnlistenFn[] = [];

  /** Called by compositor to dispatch chords forwarded by the bridge script.
   *  Returning true means the view consumed the chord; false hands off to
   *  the compositor/input-router for global handling. */
  handleForwardedChord?: (key: string, mods: number) => boolean;

  /** Set by compositor to handle in-page actions forwarded from the
   *  Vimium-lite bridge layer (e.g. "open this link in a new pane"). */
  onOpenInNewPane?: (url: string) => void;

  constructor(private initialUrl: string) {
    this.element = document.createElement('div');
    this.element.className = 'krypton-content-view krypton-webview-view';
    this.element.tabIndex = -1;

    const chrome = document.createElement('div');
    chrome.className = 'krypton-webview-chrome';

    this.backBtn = this.makeChromeButton('◀', 'Back (Cmd+[)', () => this.back());
    this.fwdBtn = this.makeChromeButton('▶', 'Forward (Cmd+])', () => this.forward());
    this.reloadBtn = this.makeChromeButton('↻', 'Reload (Cmd+R)', () => this.reload());

    const nav = document.createElement('div');
    nav.className = 'krypton-webview-nav';
    nav.append(this.backBtn, this.fwdBtn, this.reloadBtn);

    this.addressInput = document.createElement('input');
    this.addressInput.className = 'krypton-webview-url';
    this.addressInput.type = 'text';
    this.addressInput.spellcheck = false;
    this.addressInput.autocapitalize = 'off';
    this.addressInput.autocomplete = 'off';
    this.addressInput.value = initialUrl;
    this.addressInput.addEventListener('keydown', (e) => this.onAddressKey(e));

    chrome.append(nav, this.addressInput);

    this.loadingBar = document.createElement('div');
    this.loadingBar.className = 'krypton-webview-loading-bar';

    this.hostEl = document.createElement('div');
    this.hostEl.className = 'krypton-webview-host';

    this.element.append(chrome, this.loadingBar, this.hostEl);

    this.attachEventListeners();
    void this.spawn();
  }

  private makeChromeButton(label: string, title: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button');
    b.className = 'krypton-webview-btn';
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.tabIndex = -1;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  private async spawn(): Promise<void> {
    const rect = this.computeHostRect();
    try {
      const id = await invoke<number>('spawn_webview', {
        url: this.initialUrl,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
      });
      if (this.disposed) {
        invoke('close_webview', { id }).catch(() => undefined);
        return;
      }
      this.state.id = id;
      this.lastBounds = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      this.setupResizeObserver();
      if (this.suspended) {
        this.updateSuspendedPlaceholder();
        void invoke('set_webview_visible', { id: this.state.id, visible: false });
      } else if (this.pendingFocus) {
        this.pendingFocus = false;
        this.focusView();
      }
    } catch (err) {
      console.error('spawn_webview failed:', err);
      this.showError(String(err));
    }
  }

  private setupResizeObserver(): void {
    this.resizeObs = new ResizeObserver(() => this.scheduleResize());
    this.resizeObs.observe(this.hostEl);
    // Window-level resizes (workspace switch, native fullscreen) don't always
    // trigger ResizeObserver on a stable child — listen on window too.
    const onWinResize = () => this.scheduleResize();
    window.addEventListener('resize', onWinResize);
    this.unlisteners.push(() => window.removeEventListener('resize', onWinResize));
  }

  private scheduleResize(): void {
    if (this.disposed || this.state.id < 0) return;
    if (this.resizeTimer !== null) return;
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      this.applyBounds();
    }, RESIZE_DEBOUNCE_MS);
  }

  private applyBounds(): void {
    if (this.disposed || this.state.id < 0 || this.suspended) return;
    const rect = this.computeHostRect();
    if (rect.w <= 1 || rect.h <= 1) {
      // Host has no real size — hide so it doesn't render at last good bounds.
      void invoke('set_webview_visible', { id: this.state.id, visible: false });
      return;
    }
    if (
      rect.x === this.lastBounds.x &&
      rect.y === this.lastBounds.y &&
      rect.w === this.lastBounds.w &&
      rect.h === this.lastBounds.h
    ) {
      return;
    }
    this.lastBounds = rect;
    void invoke('resize_webview', {
      id: this.state.id,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
    // If we previously hid due to 0-rect, restore.
    void invoke('set_webview_visible', { id: this.state.id, visible: true });
  }

  private computeHostRect(): { x: number; y: number; w: number; h: number } {
    const r = this.hostEl.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  private attachEventListeners(): void {
    void listen<LoadingEvent>('webview-loading', (e) => {
      if (e.payload.id !== this.state.id) return;
      this.state.loading = e.payload.started;
      this.loadingBar.classList.toggle('krypton-webview-loading-bar--active', e.payload.started);
    }).then((un) => this.unlisteners.push(un));

    void listen<NavigatedEvent>('webview-navigated', (e) => {
      if (e.payload.id !== this.state.id) return;
      this.state.url = e.payload.url;
      this.state.pendingUrl = null;
      this.updateSuspendedPlaceholder();
      if (document.activeElement !== this.addressInput) {
        this.addressInput.value = e.payload.url;
      }
    }).then((un) => this.unlisteners.push(un));

    void listen<TitleEvent>('webview-title', (e) => {
      if (e.payload.id !== this.state.id) return;
      this.state.title = e.payload.title;
      this.updateSuspendedPlaceholder();
    }).then((un) => this.unlisteners.push(un));

    void listen<ChordEvent>('chord-from-webview', (e) => {
      if (e.payload.id !== this.state.id) return;
      this.handleChord(e.payload.key, e.payload.mods);
    }).then((un) => this.unlisteners.push(un));

    void listen<ActionEvent>('webview-action', (e) => {
      if (e.payload.id !== this.state.id) return;
      this.handleAction(e.payload);
    }).then((un) => this.unlisteners.push(un));
  }

  private handleAction(a: ActionEvent): void {
    if (a.kind === 'open_url' && a.target === 'new_pane' && a.url) {
      if (this.onOpenInNewPane) this.onOpenInNewPane(a.url);
    }
  }

  /** Mods bitmask matches the bridge script: 1=meta 2=shift 4=alt 8=ctrl. */
  private handleChord(key: string, mods: number): void {
    if (this.handleForwardedChord && this.handleForwardedChord(key, mods)) return;

    const cmd = (mods & 1) !== 0 || (mods & 8) !== 0;
    if (!cmd) return;
    const shift = (mods & 2) !== 0;

    // Webview-local chords only fire without Shift; Cmd+Shift+[ / ] are
    // global tab-switch and must reach the host input router instead.
    if (!shift) {
      switch (key) {
        case 'l':
          this.focusAddressBar();
          return;
        case 'r':
          this.reload();
          return;
        case '[':
          this.back();
          return;
        case ']':
          this.forward();
          return;
      }
    }

    // Everything else (Cmd+P, Cmd+W, Cmd+1..9, Cmd+Shift+[ / ]) →
    // synthesize a KeyboardEvent so the existing input-router pipeline
    // handles them uniformly.
    this.dispatchSyntheticChord(key, mods);
  }

  private dispatchSyntheticChord(key: string, mods: number): void {
    const evt = new KeyboardEvent('keydown', {
      key,
      code: keyToCode(key),
      metaKey: (mods & 1) !== 0,
      shiftKey: (mods & 2) !== 0,
      altKey: (mods & 4) !== 0,
      ctrlKey: (mods & 8) !== 0,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(evt);
  }

  focusAddressBar(): void {
    this.addressInput.focus();
    this.addressInput.select();
  }

  focusView(): void {
    if (this.state.id < 0) {
      this.pendingFocus = true;
      return;
    }
    void invoke('focus_webview', { id: this.state.id });
  }

  back(): void {
    if (this.state.id < 0) return;
    void invoke('webview_back', { id: this.state.id });
  }

  forward(): void {
    if (this.state.id < 0) return;
    void invoke('webview_forward', { id: this.state.id });
  }

  reload(): void {
    if (this.state.id < 0) return;
    void invoke('webview_reload', { id: this.state.id });
  }

  navigate(url: string): void {
    if (this.state.id < 0) return;
    const normalized = normalizeUrl(url);
    this.state.pendingUrl = normalized;
    void invoke('navigate_webview', { id: this.state.id, url: normalized });
  }

  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.updateSuspendedPlaceholder();
    this.hostEl.classList.add('krypton-webview-host--suspended');
    if (this.state.id >= 0) {
      void invoke('set_webview_visible', { id: this.state.id, visible: false });
    }
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.hostEl.classList.remove('krypton-webview-host--suspended');
    if (this.state.id < 0) return;
    // Re-sync bounds after resume in case layout changed while hidden.
    this.lastBounds = { x: -1, y: -1, w: -1, h: -1 };
    this.applyBounds();
  }

  private updateSuspendedPlaceholder(): void {
    const title = this.state.title.trim();
    const url = this.state.pendingUrl ?? this.state.url ?? this.initialUrl;
    this.hostEl.dataset.title = title || webviewHostForUrl(url);
    this.hostEl.dataset.url = url;
  }

  getState(): WebviewState {
    return { ...this.state };
  }

  private onAddressKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = this.addressInput.value.trim();
      if (v.length > 0) this.navigate(v);
      this.addressInput.blur();
      this.focusView();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.addressInput.value = this.state.url || this.initialUrl;
      this.addressInput.blur();
      this.focusView();
    }
  }

  private showError(message: string): void {
    const err = document.createElement('div');
    err.className = 'krypton-webview-error';
    err.textContent = `Webview failed: ${message}`;
    this.hostEl.appendChild(err);
  }

  // ─── ContentView interface ──────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    // Most keys reach the native webview directly. We only see keys when the
    // pane wrapper has focus (e.g. before the user clicks into the webview)
    // or via the bridge script's synthetic dispatch path.
    if (!(e.metaKey || e.ctrlKey)) return false;
    const key = e.key.toLowerCase();
    switch (key) {
      case 'l':
        e.preventDefault();
        this.focusAddressBar();
        return true;
      case 'r':
        e.preventDefault();
        this.reload();
        return true;
      case '[':
        e.preventDefault();
        this.back();
        return true;
      case ']':
        e.preventDefault();
        this.forward();
        return true;
      default:
        return false;
    }
  }

  onResize(): void {
    this.scheduleResize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    for (const un of this.unlisteners) {
      try { un(); } catch { /* ignore */ }
    }
    this.unlisteners = [];
    const id = this.state.id;
    if (id >= 0) {
      invoke('close_webview', { id }).catch(() => undefined);
    }
  }
}

function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  // Bare host or path — assume https.
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(input)) return `https://${input}`;
  // Treat as search query — caller should override via config; default DDG.
  return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
}

function webviewHostForUrl(input: string): string {
  try {
    return new URL(input).hostname || input;
  } catch {
    return input;
  }
}

function keyToCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === '[') return 'BracketLeft';
  if (key === ']') return 'BracketRight';
  return key;
}
