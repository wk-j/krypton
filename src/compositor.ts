// Krypton — Compositor
// Manages terminal windows: creation, destruction, layout, focus, resize, move.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';

import { WindowId, WindowBounds, KryptonWindow } from './types';
import { autoTile, resolveGridSlot } from './layout';

/** Custom key event handler for xterm.js — set by InputRouter */
type CustomKeyHandler = (e: KeyboardEvent) => boolean;

/** Terminal + addons for a window */
interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
}

/** xterm.js theme (Ocean Dark) */
const TERMINAL_THEME = {
  background: '#1b2b34',
  foreground: '#c0c5ce',
  cursor: '#c0c5ce',
  selectionBackground: '#4f5b66',
  black: '#1b2b34',
  red: '#ec5f67',
  green: '#99c794',
  yellow: '#fac863',
  blue: '#6699cc',
  magenta: '#c594c5',
  cyan: '#5fb3b3',
  white: '#c0c5ce',
  brightBlack: '#65737e',
  brightRed: '#ec5f67',
  brightGreen: '#99c794',
  brightYellow: '#fac863',
  brightBlue: '#6699cc',
  brightMagenta: '#c594c5',
  brightCyan: '#5fb3b3',
  brightWhite: '#ffffff',
};

/** Minimum window dimensions */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

/** Pixels per arrow key step in resize/move mode */
const STEP_SIZE = 20;

/** Counter for unique window IDs */
let windowIdCounter = 0;

function nextWindowId(): WindowId {
  return `win-${windowIdCounter++}`;
}

export class Compositor {
  private windows: Map<WindowId, KryptonWindow> = new Map();
  private terminals: Map<WindowId, TerminalInstance> = new Map();
  private focusedWindowId: WindowId | null = null;
  private workspace: HTMLElement;
  private onFocusChangeCallbacks: Array<(id: WindowId | null) => void> = [];
  private customKeyHandler: CustomKeyHandler | null = null;

  constructor(workspace: HTMLElement) {
    this.workspace = workspace;
    this.setupResizeHandler();
    this.setupPtyListeners();
  }

  /** Get the currently focused window ID */
  get focusedId(): WindowId | null {
    return this.focusedWindowId;
  }

  /** Get all window IDs in creation order */
  get windowIds(): WindowId[] {
    return Array.from(this.windows.keys());
  }

  /** Get count of windows */
  get windowCount(): number {
    return this.windows.size;
  }

  /** Register callback for focus changes */
  onFocusChange(cb: (id: WindowId | null) => void): void {
    this.onFocusChangeCallbacks.push(cb);
  }

  /** Set custom key event handler for all terminals (called by InputRouter) */
  setCustomKeyHandler(handler: CustomKeyHandler): void {
    this.customKeyHandler = handler;
    for (const [, termInfo] of this.terminals) {
      termInfo.terminal.attachCustomKeyEventHandler(handler);
    }
  }

  /** Create a new terminal window, spawn a PTY, and add it to the layout */
  async createWindow(): Promise<WindowId> {
    const id = nextWindowId();

    // Build DOM structure
    const el = document.createElement('div');
    el.id = id;
    el.className = 'krypton-window';
    el.dataset.windowId = id;

    const chrome = document.createElement('div');
    chrome.className = 'krypton-window__chrome';

    const titlebar = document.createElement('div');
    titlebar.className = 'krypton-window__titlebar';

    const label = document.createElement('span');
    label.className = 'krypton-window__label';
    label.textContent = 'terminal';

    const controls = document.createElement('div');
    controls.className = 'krypton-window__controls';

    for (const type of ['close', 'minimize', 'maximize']) {
      const btn = document.createElement('button');
      btn.className = `krypton-window__ctrl krypton-window__ctrl--${type}`;
      controls.appendChild(btn);
    }

    titlebar.appendChild(label);
    titlebar.appendChild(controls);
    chrome.appendChild(titlebar);

    const body = document.createElement('div');
    body.className = 'krypton-window__body';

    el.appendChild(chrome);
    el.appendChild(body);
    this.workspace.appendChild(el);

    // Create window record
    const win: KryptonWindow = {
      id,
      sessionId: null,
      gridSlot: { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      element: el,
      terminalContainer: body,
    };
    this.windows.set(id, win);

    // Create xterm.js terminal
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      lineHeight: 1.2,
      scrollback: 10000,
      allowTransparency: true,
      theme: TERMINAL_THEME,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(body);

    // Load WebGL addon
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // Canvas fallback
    }

    // Attach custom key handler so InputRouter can intercept keys
    if (this.customKeyHandler) {
      terminal.attachCustomKeyEventHandler(this.customKeyHandler);
    }

    this.terminals.set(id, { terminal, fitAddon });

    // Relayout all windows, then fit
    this.relayout();
    await this.nextFrame();
    fitAddon.fit();

    // Spawn PTY
    try {
      const sessionId = await invoke<number>('spawn_pty', {
        cols: terminal.cols,
        rows: terminal.rows,
      });
      win.sessionId = sessionId;
      label.textContent = `terminal ${sessionId}`;
    } catch (e) {
      console.error(`Failed to spawn PTY for window ${id}:`, e);
      terminal.write('\r\n\x1b[31mFailed to spawn shell.\x1b[0m\r\n');
    }

    // Wire input: xterm -> PTY
    terminal.onData((data: string) => {
      if (win.sessionId !== null) {
        const encoder = new TextEncoder();
        invoke('write_to_pty', {
          sessionId: win.sessionId,
          data: Array.from(encoder.encode(data)),
        }).catch((e) => console.error('Write to PTY failed:', e));
      }
    });

    // Click to focus
    el.addEventListener('mousedown', () => {
      this.focusWindow(id);
    });

    // Focus this new window
    this.focusWindow(id);

    return id;
  }

  /** Close a window and destroy its PTY */
  async closeWindow(id: WindowId): Promise<void> {
    const win = this.windows.get(id);
    if (!win) return;

    const termInfo = this.terminals.get(id);
    if (termInfo) {
      termInfo.terminal.dispose();
      this.terminals.delete(id);
    }

    win.element.remove();
    this.windows.delete(id);

    if (this.focusedWindowId === id) {
      const remaining = this.windowIds;
      if (remaining.length > 0) {
        this.focusWindow(remaining[remaining.length - 1]);
      } else {
        this.focusedWindowId = null;
        this.notifyFocusChange();
      }
    }

    this.relayout();
    await this.nextFrame();
    this.fitAll();
  }

  /** Focus a window by ID */
  focusWindow(id: WindowId): void {
    if (!this.windows.has(id)) return;

    if (this.focusedWindowId) {
      const prev = this.windows.get(this.focusedWindowId);
      if (prev) {
        prev.element.classList.remove('krypton-window--focused');
      }
    }

    this.focusedWindowId = id;
    const win = this.windows.get(id);
    if (win) {
      win.element.classList.add('krypton-window--focused');
    }

    const termInfo = this.terminals.get(id);
    if (termInfo) {
      termInfo.terminal.focus();
    }

    this.notifyFocusChange();
  }

  /** Focus window by direction relative to current focused window */
  focusDirection(direction: 'left' | 'down' | 'up' | 'right'): void {
    if (!this.focusedWindowId) return;
    const current = this.windows.get(this.focusedWindowId);
    if (!current) return;

    const ids = this.windowIds;
    if (ids.length <= 1) return;

    // Find best candidate using actual pixel bounds (center-to-center)
    let bestId: WindowId | null = null;
    let bestDist = Infinity;
    const curCx = current.bounds.x + current.bounds.width / 2;
    const curCy = current.bounds.y + current.bounds.height / 2;

    for (const [id, win] of this.windows) {
      if (id === this.focusedWindowId) continue;
      const cx = win.bounds.x + win.bounds.width / 2;
      const cy = win.bounds.y + win.bounds.height / 2;

      let matches = false;
      let dist = 0;

      switch (direction) {
        case 'left':
          matches = cx < curCx;
          dist = (curCx - cx) + Math.abs(curCy - cy) * 0.5;
          break;
        case 'right':
          matches = cx > curCx;
          dist = (cx - curCx) + Math.abs(curCy - cy) * 0.5;
          break;
        case 'up':
          matches = cy < curCy;
          dist = (curCy - cy) + Math.abs(curCx - cx) * 0.5;
          break;
        case 'down':
          matches = cy > curCy;
          dist = (cy - curCy) + Math.abs(curCx - cx) * 0.5;
          break;
      }

      if (matches && dist < bestDist) {
        bestDist = dist;
        bestId = id;
      }
    }

    // Wrap around if nothing found in that direction
    if (!bestId) {
      const currentIdx = ids.indexOf(this.focusedWindowId);
      switch (direction) {
        case 'right':
        case 'down':
          bestId = ids[(currentIdx + 1) % ids.length];
          break;
        case 'left':
        case 'up':
          bestId = ids[(currentIdx - 1 + ids.length) % ids.length];
          break;
      }
    }

    if (bestId) {
      this.focusWindow(bestId);
    }
  }

  /** Focus window by index (1-based) */
  focusByIndex(index: number): void {
    const ids = this.windowIds;
    if (index >= 1 && index <= ids.length) {
      this.focusWindow(ids[index - 1]);
    }
  }

  /** Refocus the terminal of the currently focused window */
  refocusTerminal(): void {
    if (this.focusedWindowId) {
      const termInfo = this.terminals.get(this.focusedWindowId);
      if (termInfo) {
        termInfo.terminal.focus();
      }
    }
  }

  // ─── Resize & Move ───────────────────────────────────────────────

  /** Resize the focused window by a directional step */
  resizeFocused(direction: 'left' | 'down' | 'up' | 'right'): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win) return;

    const b = win.bounds;

    switch (direction) {
      case 'right':
        b.width = Math.max(MIN_WIDTH, b.width + STEP_SIZE);
        break;
      case 'left':
        b.width = Math.max(MIN_WIDTH, b.width - STEP_SIZE);
        break;
      case 'down':
        b.height = Math.max(MIN_HEIGHT, b.height + STEP_SIZE);
        break;
      case 'up':
        b.height = Math.max(MIN_HEIGHT, b.height - STEP_SIZE);
        break;
    }

    this.applyBounds(win);
    this.fitWindow(this.focusedWindowId);
  }

  /** Move the focused window by a directional step */
  moveFocused(direction: 'left' | 'down' | 'up' | 'right'): void {
    if (!this.focusedWindowId) return;
    const win = this.windows.get(this.focusedWindowId);
    if (!win) return;

    const b = win.bounds;

    switch (direction) {
      case 'left':
        b.x = Math.max(0, b.x - STEP_SIZE);
        break;
      case 'right':
        b.x = Math.min(window.innerWidth - MIN_WIDTH, b.x + STEP_SIZE);
        break;
      case 'up':
        b.y = Math.max(0, b.y - STEP_SIZE);
        break;
      case 'down':
        b.y = Math.min(window.innerHeight - MIN_HEIGHT, b.y + STEP_SIZE);
        break;
    }

    this.applyBounds(win);
  }

  // ─── Layout ──────────────────────────────────────────────────────

  /** Recalculate grid layout and apply positions to all windows */
  relayout(): void {
    const count = this.windows.size;
    if (count === 0) return;

    const { slots, gridCols, gridRows } = autoTile(count);
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let i = 0;
    for (const [, win] of this.windows) {
      if (i >= slots.length) break;
      win.gridSlot = slots[i];

      const bounds = resolveGridSlot(slots[i], gridCols, gridRows, vw, vh);
      win.bounds = bounds;
      this.applyBounds(win);

      i++;
    }
  }

  /** Fit all terminals to their containers and resize PTYs */
  fitAll(): void {
    for (const [id] of this.terminals) {
      this.fitWindow(id);
    }
  }

  /** Fit a single terminal to its container and resize its PTY */
  private fitWindow(id: WindowId): void {
    const termInfo = this.terminals.get(id);
    const win = this.windows.get(id);
    if (!termInfo || !win) return;

    termInfo.fitAddon.fit();

    if (win.sessionId !== null) {
      invoke('resize_pty', {
        sessionId: win.sessionId,
        cols: termInfo.terminal.cols,
        rows: termInfo.terminal.rows,
      }).catch((e) => console.error('Resize PTY failed:', e));
    }
  }

  /** Apply a window's bounds to its DOM element */
  private applyBounds(win: KryptonWindow): void {
    const b = win.bounds;
    const el = win.element;
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.width}px`;
    el.style.height = `${b.height}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  // ─── PTY Events ──────────────────────────────────────────────────

  private setupPtyListeners(): void {
    listen<[number, number[]]>('pty-output', (event) => {
      const [sid, data] = event.payload;
      for (const [wid, win] of this.windows) {
        if (win.sessionId === sid) {
          const termInfo = this.terminals.get(wid);
          if (termInfo) {
            termInfo.terminal.write(new Uint8Array(data));
          }
          break;
        }
      }
    });

    listen<number>('pty-exit', (event) => {
      const sid = event.payload;
      for (const [wid, win] of this.windows) {
        if (win.sessionId === sid) {
          const termInfo = this.terminals.get(wid);
          if (termInfo) {
            termInfo.terminal.write('\r\n\x1b[33m[Shell exited]\x1b[0m\r\n');
          }
          win.sessionId = null;
          break;
        }
      }
    });
  }

  // ─── Window Resize Handler ───────────────────────────────────────

  private setupResizeHandler(): void {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.relayout();
        this.fitAll();
      }, 50);
    });
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  private notifyFocusChange(): void {
    for (const cb of this.onFocusChangeCallbacks) {
      cb(this.focusedWindowId);
    }
  }
}
