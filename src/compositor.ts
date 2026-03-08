// Krypton — Compositor
// Manages terminal windows: creation, destruction, layout, focus, resize, move.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { WindowId, WindowBounds, KryptonWindow, LayoutMode } from './types';
import { autoTile, focusTile, resolveGridSlot } from './layout';

/** Custom key event handler for xterm.js — set by InputRouter */
type CustomKeyHandler = (e: KeyboardEvent) => boolean;

/** Terminal + addons for a window */
interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
}

/** xterm.js theme (Krypton Cyber — transparent) */
const TERMINAL_THEME = {
  background: 'rgba(10, 10, 15, 0.5)',
  foreground: '#b0c4d8',
  cursor: '#0cf',
  cursorAccent: '#0a0a0f',
  selectionBackground: 'rgba(26, 58, 92, 0.6)',
  selectionForeground: '#ffffff',
  black: '#0a0a0f',
  red: '#ff3a5c',
  green: '#0cf',
  yellow: '#e8c547',
  blue: '#4a9eff',
  magenta: '#c77dff',
  cyan: '#0cf',
  white: '#b0c4d8',
  brightBlack: '#2a4a6c',
  brightRed: '#ff5c7a',
  brightGreen: '#33ddff',
  brightYellow: '#ffd866',
  brightBlue: '#6ab4ff',
  brightMagenta: '#d9a0ff',
  brightCyan: '#33ddff',
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
  private layoutMode: LayoutMode = LayoutMode.Focus;

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

  /** Get the cwd of the focused window's shell, if available */
  private async getFocusedCwd(): Promise<string | null> {
    if (!this.focusedWindowId) return null;
    const win = this.windows.get(this.focusedWindowId);
    if (!win || win.sessionId === null) return null;
    try {
      const cwd = await invoke<string | null>('get_pty_cwd', {
        sessionId: win.sessionId,
      });
      return cwd;
    } catch {
      return null;
    }
  }

  /** Create a new terminal window, spawn a PTY, and add it to the layout */
  async createWindow(): Promise<WindowId> {
    // Inherit cwd from the focused window
    const cwd = await this.getFocusedCwd();
    const id = nextWindowId();

    // Build DOM structure — cyberpunk chrome
    const el = document.createElement('div');
    el.id = id;
    el.className = 'krypton-window';
    el.dataset.windowId = id;

    // Session counter for display
    const sessionNum = String(windowIdCounter).padStart(2, '0');

    const chrome = document.createElement('div');
    chrome.className = 'krypton-window__chrome';

    const titlebar = document.createElement('div');
    titlebar.className = 'krypton-window__titlebar';

    // Left side: status dot + session label
    const labelGroup = document.createElement('div');
    labelGroup.className = 'krypton-window__label-group';

    const statusDot = document.createElement('div');
    statusDot.className = 'krypton-window__status-dot';

    const label = document.createElement('span');
    label.className = 'krypton-window__label';
    label.textContent = `session_${sessionNum}`;

    labelGroup.appendChild(statusDot);
    labelGroup.appendChild(label);

    // Right side: PTY status
    const ptyStatus = document.createElement('span');
    ptyStatus.className = 'krypton-window__pty-status';
    ptyStatus.textContent = 'pty_streams // active';

    titlebar.appendChild(labelGroup);
    titlebar.appendChild(ptyStatus);
    chrome.appendChild(titlebar);

    // Content area
    const content = document.createElement('div');
    content.className = 'krypton-window__content';

    const body = document.createElement('div');
    body.className = 'krypton-window__body';

    content.appendChild(body);

    // Corner accent elements
    for (const pos of ['tl', 'tr', 'bl', 'br']) {
      const corner = document.createElement('div');
      corner.className = `krypton-window__corner krypton-window__corner--${pos}`;
      el.appendChild(corner);
    }

    // Header accent bar (striped decoration below titlebar)
    const headerAccent = document.createElement('div');
    headerAccent.className = 'krypton-window__header-accent';
    chrome.appendChild(headerAccent);

    el.appendChild(chrome);
    el.appendChild(content);
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

    // Note: WebGL addon is NOT loaded because it does not support
    // transparent backgrounds. The default canvas renderer is used
    // instead, which respects allowTransparency + rgba backgrounds.

    // Attach custom key handler so InputRouter can intercept keys
    if (this.customKeyHandler) {
      terminal.attachCustomKeyEventHandler(this.customKeyHandler);
    }

    this.terminals.set(id, { terminal, fitAddon });

    // Focus the new window BEFORE relayout so that Focus layout
    // places it on the left (main) column immediately.
    this.focusWindowQuiet(id);

    // Relayout all windows, then fit all terminals (including existing ones that resized)
    this.relayout();
    await this.nextFrame();
    this.fitAll();

    // Spawn PTY
    try {
      const sessionId = await invoke<number>('spawn_pty', {
        cols: terminal.cols,
        rows: terminal.rows,
        cwd,
      });
      win.sessionId = sessionId;
      label.textContent = `session_${String(sessionId).padStart(2, '0')}`;
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
        // Last window closed — quit the app
        getCurrentWindow().close();
        return;
      }
    }

    this.relayout();
    await this.nextFrame();
    this.fitAll();
  }

  /**
   * Set focus state (CSS class, terminal focus, callbacks) without triggering
   * a relayout. Used internally when a relayout will follow immediately after.
   */
  private focusWindowQuiet(id: WindowId): void {
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

  /** Focus a window by ID */
  focusWindow(id: WindowId): void {
    if (!this.windows.has(id)) return;
    const previousId = this.focusedWindowId;

    this.focusWindowQuiet(id);

    // In Focus layout, the focused window is always the left (main) panel.
    // Relayout so the newly focused window swaps to the left and the
    // previously focused window moves into the right stack.
    if (this.layoutMode === LayoutMode.Focus && previousId !== id && this.windows.size > 1) {
      this.relayout();
      this.fitAll();
    }
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

  /** Get the current layout mode */
  get currentLayoutMode(): LayoutMode {
    return this.layoutMode;
  }

  /** Toggle between Grid and Focus layout modes, then relayout */
  async toggleFocusLayout(): Promise<void> {
    this.layoutMode =
      this.layoutMode === LayoutMode.Grid ? LayoutMode.Focus : LayoutMode.Grid;
    this.relayout();
    await this.nextFrame();
    this.fitAll();
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

  /** Default window size as fraction of viewport */
  private static readonly DEFAULT_WIDTH_RATIO = 0.5;
  private static readonly DEFAULT_HEIGHT_RATIO = 0.6;
  /** Multi-window: total area used as fraction of viewport */
  private static readonly MULTI_WIDTH_RATIO = 0.85;
  private static readonly MULTI_HEIGHT_RATIO = 0.75;
  private static readonly WINDOW_GAP = 6;

  /** Recalculate grid layout and apply positions to all windows */
  relayout(): void {
    const count = this.windows.size;
    if (count === 0) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Single window: centered at a comfortable default size (same for both modes)
    if (count === 1) {
      const win = this.windows.values().next().value;
      if (!win) return;
      const w = Math.round(vw * Compositor.DEFAULT_WIDTH_RATIO);
      const h = Math.round(vh * Compositor.DEFAULT_HEIGHT_RATIO);
      win.gridSlot = { col: 0, row: 0, colSpan: 1, rowSpan: 1 };
      win.bounds = {
        x: Math.round((vw - w) / 2),
        y: Math.round((vh - h) / 2),
        width: w,
        height: h,
      };
      this.applyBounds(win);
      return;
    }

    if (this.layoutMode === LayoutMode.Focus) {
      this.relayoutFocus(vw, vh, count);
    } else {
      this.relayoutGrid(vw, vh, count);
    }
  }

  /** Grid layout: tile windows in a balanced grid within a centered region */
  private relayoutGrid(vw: number, vh: number, count: number): void {
    const { slots, gridCols, gridRows } = autoTile(count);

    const totalW = Math.round(vw * Compositor.MULTI_WIDTH_RATIO);
    const totalH = Math.round(vh * Compositor.MULTI_HEIGHT_RATIO);
    const offsetX = Math.round((vw - totalW) / 2);
    const offsetY = Math.round((vh - totalH) / 2);
    const gap = Compositor.WINDOW_GAP;

    const cellW = (totalW - gap * (gridCols - 1)) / gridCols;
    const cellH = (totalH - gap * (gridRows - 1)) / gridRows;

    let i = 0;
    for (const [, win] of this.windows) {
      if (i >= slots.length) break;
      const slot = slots[i];
      win.gridSlot = slot;

      win.bounds = {
        x: Math.round(offsetX + slot.col * (cellW + gap)),
        y: Math.round(offsetY + slot.row * (cellH + gap)),
        width: Math.round(cellW * slot.colSpan + gap * (slot.colSpan - 1)),
        height: Math.round(cellH * slot.rowSpan + gap * (slot.rowSpan - 1)),
      };
      this.applyBounds(win);

      i++;
    }
  }

  /** Focus layout: focused window on left (full height), rest stacked on right */
  private relayoutFocus(vw: number, vh: number, count: number): void {
    const ids = this.windowIds;
    const focusIndex = this.focusedWindowId
      ? ids.indexOf(this.focusedWindowId)
      : 0;

    const { slots, gridCols, gridRows, order } = focusTile(
      count,
      Math.max(0, focusIndex),
    );

    const totalW = Math.round(vw * Compositor.MULTI_WIDTH_RATIO);
    const totalH = Math.round(vh * Compositor.MULTI_HEIGHT_RATIO);
    const offsetX = Math.round((vw - totalW) / 2);
    const offsetY = Math.round((vh - totalH) / 2);
    const gap = Compositor.WINDOW_GAP;

    const cellW = (totalW - gap * (gridCols - 1)) / gridCols;
    const cellH = (totalH - gap * (gridRows - 1)) / gridRows;

    for (let i = 0; i < order.length; i++) {
      const winId = ids[order[i]];
      const win = this.windows.get(winId);
      if (!win || i >= slots.length) continue;

      const slot = slots[i];
      win.gridSlot = slot;
      win.bounds = {
        x: Math.round(offsetX + slot.col * (cellW + gap)),
        y: Math.round(offsetY + slot.row * (cellH + gap)),
        width: Math.round(cellW * slot.colSpan + gap * (slot.colSpan - 1)),
        height: Math.round(cellH * slot.rowSpan + gap * (slot.rowSpan - 1)),
      };
      this.applyBounds(win);
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
          win.sessionId = null;
          this.closeWindow(wid);
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
