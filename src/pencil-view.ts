// Krypton — Pencil window (Excalidraw editor).
// See docs/71-pencil-window.md.
//
// Lazy-loads React + ReactDOM + @excalidraw/excalidraw the first time the
// view mounts so they stay out of the main bundle.

import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn } from '@tauri-apps/api/event';

import { setupListener } from './util/listener';

import type { ContentView, PaneContentType } from './types';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface ExcalidrawScene {
  type: 'excalidraw';
  version: number;
  source: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

const EMPTY_SCENE = (): ExcalidrawScene => ({
  type: 'excalidraw',
  version: 2,
  source: 'https://krypton.local',
  elements: [],
  appState: {},
  files: {},
});

const AUTOSAVE_DEBOUNCE_MS = 800;

export class PencilContentView implements ContentView {
  readonly type: PaneContentType = 'pencil';
  readonly element: HTMLElement;
  readonly filePath: string;

  private statusBarEl: HTMLElement;
  private statusPathEl: HTMLElement;
  private statusPillEl: HTMLElement;
  private canvasEl: HTMLElement;

  private dirty = false;
  private lastSerialized = '';
  private saveStatus: SaveStatus = 'idle';
  private lastError: string | null = null;
  private saveTimer: number | null = null;

  private excalidrawAPI: any = null;
  private reactRoot: any = null;

  private themeUnlisten: UnlistenFn | null = null;
  private beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

  private titleCb: ((name: string) => void) | null = null;
  private notifyCb: ((message: string) => void) | null = null;

  constructor(filePath: string, container: HTMLElement) {
    this.filePath = filePath;

    this.element = document.createElement('div');
    this.element.className = 'krypton-pencil';
    this.element.tabIndex = 0;

    this.statusBarEl = document.createElement('div');
    this.statusBarEl.className = 'krypton-pencil__statusbar';

    this.statusPathEl = document.createElement('span');
    this.statusPathEl.className = 'krypton-pencil__path';
    this.statusPathEl.textContent = this.relativePath();
    this.statusBarEl.appendChild(this.statusPathEl);

    this.statusPillEl = document.createElement('span');
    this.statusPillEl.className = 'krypton-pencil__pill';
    this.statusBarEl.appendChild(this.statusPillEl);

    this.canvasEl = document.createElement('div');
    this.canvasEl.className = 'krypton-pencil__canvas';

    this.element.appendChild(this.statusBarEl);
    this.element.appendChild(this.canvasEl);
    container.appendChild(this.element);

    this.beforeUnloadHandler = (): void => {
      if (this.dirty) this.fireAndForgetSave();
    };
    window.addEventListener('beforeunload', this.beforeUnloadHandler);

    this.renderStatus();
    void this.init();
  }

  onTitleChange(cb: (name: string) => void): void {
    this.titleCb = cb;
  }

  setNotifier(cb: (message: string) => void): void {
    this.notifyCb = cb;
  }

  getWorkingDirectory(): string {
    const idx = this.filePath.lastIndexOf('/');
    return idx >= 0 ? this.filePath.slice(0, idx) : this.filePath;
  }

  onResize(): void {
    // Excalidraw uses its own ResizeObserver; nothing to do here.
  }

  onKeyDown(e: KeyboardEvent): boolean {
    // Cmd+S — flush immediately.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyS') {
      this.cancelTimer();
      void this.saveNow();
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
    if (this.themeUnlisten) {
      this.themeUnlisten();
      this.themeUnlisten = null;
    }
    this.cancelTimer();

    if (this.dirty) {
      // Sync flush via fire-and-forget invoke; Rust completes after we tear down.
      this.fireAndForgetSave();
    }

    if (this.reactRoot) {
      try {
        this.reactRoot.unmount();
      } catch (e) {
        console.error('[Pencil] react unmount failed:', e);
      }
      this.reactRoot = null;
    }
    this.excalidrawAPI = null;
  }

  private async init(): Promise<void> {
    // 1. Load file (or start empty if missing).
    let scene: ExcalidrawScene = EMPTY_SCENE();
    let fileExists = true;
    try {
      const raw = await invoke<string>('read_pencil_file', { path: this.filePath });
      if (raw && raw.trim().length > 0) {
        try {
          const parsed = JSON.parse(raw) as Partial<ExcalidrawScene>;
          if (parsed && parsed.type === 'excalidraw') {
            scene = {
              type: 'excalidraw',
              version: parsed.version ?? 2,
              source: parsed.source ?? 'https://krypton.local',
              elements: Array.isArray(parsed.elements) ? parsed.elements : [],
              appState: (parsed.appState as Record<string, unknown>) ?? {},
              files: (parsed.files as Record<string, unknown>) ?? {},
            };
            this.lastSerialized = raw;
          } else {
            console.warn('[Pencil] file is not a valid excalidraw JSON; starting empty');
            this.dirty = true;
          }
        } catch (e) {
          console.warn('[Pencil] failed to parse file, starting empty:', e);
          this.dirty = true;
        }
      }
    } catch {
      // Read failed — assume new file. First save will create it.
      fileExists = false;
      this.dirty = true;
    }
    void fileExists;

    // 2. Lazy import React + Excalidraw, then mount.
    try {
      const [React, { createRoot }, excalidrawMod] = await Promise.all([
        import('react'),
        import('react-dom/client'),
        import('@excalidraw/excalidraw'),
      ]);
      // Ensure stylesheet is loaded.
      // @ts-expect-error — side-effect import via @vite-ignore so Vite includes the CSS chunk.
      await import(/* @vite-ignore */ '@excalidraw/excalidraw/index.css').catch(() => {});

      const Excalidraw = (excalidrawMod as any).Excalidraw;
      const serializeAsJSON = (excalidrawMod as any).serializeAsJSON;

      const initialTheme = this.computeTheme();
      const initialData = {
        elements: scene.elements,
        appState: { ...scene.appState, theme: initialTheme },
        files: scene.files,
      };

      const onChange = (
        elements: unknown[],
        appState: Record<string, unknown>,
        files: Record<string, unknown>,
      ): void => {
        try {
          const serialized: string = serializeAsJSON(elements, appState, files, 'local');
          if (serialized === this.lastSerialized) return;
          // Stamp dirty + schedule autosave.
          this.dirty = true;
          // Stash the latest serialized payload on the instance for the timer to use.
          (this as unknown as { _pendingSerialized: string })._pendingSerialized = serialized;
          this.scheduleAutosave();
        } catch (e) {
          console.error('[Pencil] serialize failed:', e);
        }
      };

      this.reactRoot = createRoot(this.canvasEl);
      this.reactRoot.render(
        React.createElement(Excalidraw, {
          initialData,
          onChange,
          excalidrawAPI: (api: unknown) => {
            this.excalidrawAPI = api;
          },
        }),
      );

      // 3. Subscribe to theme changes.
      this.themeUnlisten = await setupListener('theme-changed', () => {
        this.applyThemeToExcalidraw();
      });
    } catch (e) {
      console.error('[Pencil] failed to mount Excalidraw:', e);
      this.canvasEl.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'krypton-pencil__error';
      err.textContent = `Failed to load Excalidraw: ${e}`;
      this.canvasEl.appendChild(err);
    }
  }

  private scheduleAutosave(): void {
    this.cancelTimer();
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private cancelTimer(): void {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private async saveNow(): Promise<void> {
    const pending = (this as unknown as { _pendingSerialized?: string })._pendingSerialized;
    if (!pending || pending === this.lastSerialized) {
      this.dirty = false;
      this.saveStatus = 'saved';
      this.renderStatus();
      return;
    }
    this.saveStatus = 'saving';
    this.renderStatus();
    try {
      await invoke('write_pencil_file', { path: this.filePath, contents: pending });
      this.lastSerialized = pending;
      this.dirty = false;
      this.saveStatus = 'saved';
      this.lastError = null;
    } catch (e) {
      const msg = String(e);
      this.saveStatus = 'error';
      this.lastError = msg;
      // dirty stays true — next onChange will re-trigger debounce
      console.error('[Pencil] save failed:', msg);
      this.notifyCb?.(`Pencil save failed: ${msg}`);
    }
    this.renderStatus();
  }

  private fireAndForgetSave(): void {
    const pending = (this as unknown as { _pendingSerialized?: string })._pendingSerialized;
    if (!pending || pending === this.lastSerialized) return;
    invoke('write_pencil_file', { path: this.filePath, contents: pending }).catch((e: unknown) => {
      console.error('[Pencil] flush save failed:', e);
      this.notifyCb?.(`Pencil closed without save: ${e}`);
    });
  }

  private computeTheme(): 'light' | 'dark' {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--krypton-bg').trim();
    const lum = parseLuminance(bg);
    return lum < 0.5 ? 'dark' : 'light';
  }

  private applyThemeToExcalidraw(): void {
    if (!this.excalidrawAPI) return;
    const theme = this.computeTheme();
    try {
      this.excalidrawAPI.updateScene({ appState: { theme } });
    } catch (e) {
      console.error('[Pencil] applyTheme failed:', e);
    }
  }

  private relativePath(): string {
    // Show last 3 segments to keep the path short but informative.
    const parts = this.filePath.split('/').filter(Boolean);
    return parts.length <= 3 ? this.filePath : '…/' + parts.slice(-3).join('/');
  }

  private renderStatus(): void {
    this.statusPathEl.textContent = this.relativePath();
    let pillText = '';
    let pillClass = '';
    switch (this.saveStatus) {
      case 'saving':
        pillText = 'saving...';
        pillClass = 'krypton-pencil__pill--saving';
        break;
      case 'saved':
        pillText = 'saved';
        pillClass = 'krypton-pencil__pill--saved';
        break;
      case 'error':
        pillText = `! save failed: ${this.lastError ?? 'unknown'}`;
        pillClass = 'krypton-pencil__pill--error';
        break;
      default:
        pillText = '';
    }
    this.statusPillEl.textContent = pillText;
    this.statusPillEl.className = 'krypton-pencil__pill ' + pillClass;

    // Update tab title if we have an error indicator.
    if (this.titleCb) {
      const base = this.basenameNoExt();
      const suffix = this.saveStatus === 'error' ? ' [!]' : '';
      this.titleCb(base + suffix);
    }
  }

  private basenameNoExt(): string {
    const base = this.filePath.split('/').pop() ?? this.filePath;
    return base.replace(/\.excalidraw$/, '');
  }
}

function parseLuminance(color: string): number {
  // Accept hex (#rgb / #rrggbb), rgb(), or rgba(); anything else → assume dark.
  const trimmed = color.trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else {
      return 0;
    }
  } else {
    const m = trimmed.match(/rgba?\(([^)]+)\)/);
    if (!m) return 0;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return 0;
    r = parts[0];
    g = parts[1];
    b = parts[2];
  }
  // Relative luminance per WCAG, approximated with sRGB linear.
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
