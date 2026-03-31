// Krypton — Input Router
// Handles keyboard modes: Normal, Compositor, Resize, Move.
// In Normal mode, all keys pass through to the focused terminal.
// Leader key (Ctrl+Space) enters Compositor mode which shows a
// which-key popup with available actions.

import { Mode } from './types';
import { Compositor } from './compositor';
import { SelectionController } from './selection';
import { HintController } from './hints';
import { CommandPalette } from './command-palette';
import { DashboardManager } from './dashboard';

import type { PaneContentType } from './types';

/** Callback for mode changes */
type ModeChangeCallback = (mode: Mode, contentType: PaneContentType | null) => void;

export class InputRouter {
  private mode: Mode = Mode.Normal;
  private compositor: Compositor;
  private modeChangeCallbacks: ModeChangeCallback[] = [];
  private selection: SelectionController = new SelectionController();
  private hints: HintController = new HintController();
  private commandPalette: CommandPalette | null = null;
  private dashboardManager: DashboardManager | null = null;

  constructor(compositor: Compositor) {
    this.compositor = compositor;
    this.hints.onExit(() => {
      this.toNormal();
    });
    this.setupKeyHandler();
  }

  /** Get the hint controller (for config updates) */
  get hintController(): HintController {
    return this.hints;
  }

  /** Get current mode */
  get currentMode(): Mode {
    return this.mode;
  }

  /** Register callback for mode changes */
  onModeChange(cb: ModeChangeCallback): void {
    this.modeChangeCallbacks.push(cb);
  }

  /**
   * Custom key event handler for xterm.js terminals.
   * Return false to prevent xterm.js from processing the key.
   */
  get customKeyHandler(): (e: KeyboardEvent) => boolean {
    return (e: KeyboardEvent): boolean => {
      if (InputRouter.isLeaderKey(e)) {
        return false;
      }
      // Prevent xterm from consuming global focus-cycle shortcuts
      if (e.metaKey && e.shiftKey && (e.code === 'Comma' || e.code === 'Period')) {
        return false;
      }
      // Prevent xterm from consuming Cmd+I (Quick Terminal toggle)
      if (InputRouter.isQuickTerminalKey(e)) {
        return false;
      }
      // Prevent xterm from consuming Ctrl+Shift+U/D (scroll shortcuts)
      if (e.ctrlKey && e.shiftKey && (e.code === 'KeyU' || e.code === 'KeyD')) {
        return false;
      }
      // Prevent xterm from consuming Cmd+Shift+P (command palette)
      if (InputRouter.isCommandPaletteKey(e)) {
        return false;
      }
      // Prevent xterm from consuming Cmd+Shift+H (hint mode)
      if (InputRouter.isHintKey(e)) {
        return false;
      }
      // Prevent xterm from consuming dashboard toggle shortcuts
      if (this.dashboardManager?.matchShortcut(e)) {
        return false;
      }
      // Prevent xterm from consuming Cmd+Shift+[ / Cmd+Shift+] (tab switching)
      // and Cmd+[ / Cmd+] (pane cycling)
      if (e.metaKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        return false;
      }
      // Prevent xterm from consuming Cmd+T (new tab) and Cmd+N (new window)
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey &&
          (e.code === 'KeyT' || e.code === 'KeyN')) {
        return false;
      }
      // Modifier+Enter: xterm.js v6 discards shift/ctrl/alt modifiers on Enter,
      // sending bare \r for all variants. Intercept so InputRouter can send the
      // correct escape sequence (CSI 13;{mod} u — kitty keyboard protocol).
      if (e.code === 'Enter' && (e.shiftKey || e.ctrlKey || e.altKey) && !e.metaKey) {
        return false;
      }
      // Let xterm handle Escape normally in the Quick Terminal
      // (needed for apps like vim/helix). Use Cmd+I to toggle instead.
      if (this.mode !== Mode.Normal) {
        return false;
      }
      return true;
    };
  }

  /** Check if a key event is the leader key combo (Cmd+P) */
  static isLeaderKey(e: KeyboardEvent): boolean {
    return (
      (e.key === 'p' || e.key === 'P' || e.code === 'KeyP') &&
      e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    );
  }

  /** Check if a key event is the Quick Terminal toggle (Cmd+I) */
  static isQuickTerminalKey(e: KeyboardEvent): boolean {
    return (
      (e.key === 'i' || e.key === 'I' || e.code === 'KeyI') &&
      e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    );
  }

  /** Set the command palette instance (called after construction) */
  setCommandPalette(palette: CommandPalette): void {
    this.commandPalette = palette;
  }

  /** Set the dashboard manager instance (called after construction) */
  setDashboardManager(manager: DashboardManager): void {
    this.dashboardManager = manager;
    // Wire the mode callback: dashboard open/close -> InputRouter mode change
    manager.onModeChange((active) => {
      if (active) {
        this.setMode(Mode.Dashboard);
      } else {
        this.toNormal();
      }
    });
  }

  /** Check if a key event is the Command Palette shortcut (Cmd+Shift+P) */
  static isCommandPaletteKey(e: KeyboardEvent): boolean {
    return (
      e.code === 'KeyP' &&
      e.metaKey &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey
    );
  }

  /** Check if a key event is the Hint mode shortcut (Cmd+Shift+H) */
  static isHintKey(e: KeyboardEvent): boolean {
    return (
      e.code === 'KeyH' &&
      e.metaKey &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey
    );
  }

  private setMode(mode: Mode): void {
    const prevMode = this.mode;
    this.mode = mode;

    // Play sound on mode transitions
    if (prevMode === Mode.Normal && mode !== Mode.Normal) {
      this.compositor.soundEngine.play('mode.enter');
    } else if (prevMode !== Mode.Normal && mode === Mode.Normal) {
      this.compositor.soundEngine.play('mode.exit');
    }

    const contentType = this.compositor.getFocusedContentType();
    for (const cb of this.modeChangeCallbacks) {
      cb(mode, contentType);
    }
  }

  private toNormal(): void {
    this.setMode(Mode.Normal);
    this.compositor.refocusTerminal();
  }

  private setupKeyHandler(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Debug: log all key events when not in Normal mode, or modifier combos
      if (this.mode !== Mode.Normal || e.ctrlKey || e.metaKey) {
        console.log(`[InputRouter] mode=${this.mode} key="${e.key}" code="${e.code}" ctrl=${e.ctrlKey} meta=${e.metaKey} alt=${e.altKey}`);
      }

      // Buffer keyboard input during animations (Normal mode only).
      // Let modifier keys and mode-switching keys through so the user
      // can still interact with the compositor during transitions.
      if (this.mode === Mode.Normal && this.compositor.animationEngine.isAnimating) {
        if (!e.metaKey && !e.ctrlKey && !InputRouter.isLeaderKey(e)) {
          this.compositor.animationEngine.bufferInput(e);
          e.preventDefault();
          return;
        }
      }

      // Global: Cmd+I — toggle Quick Terminal (works from any input mode)
      if (InputRouter.isQuickTerminalKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.toggleQuickTerminal();
        return;
      }

      // Global: Cmd+Shift+P — toggle Command Palette (works from any mode)
      if (InputRouter.isCommandPaletteKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (this.commandPalette) {
          if (this.commandPalette.isVisible) {
            this.commandPalette.close();
            this.toNormal();
          } else {
            // Force-exit current mode before opening palette
            if (this.mode === Mode.Selection) {
              this.exitSelectionMode();
            } else if (this.mode === Mode.Hint) {
              this.hints.exit();
            }
            this.commandPalette.open();
            this.setMode(Mode.CommandPalette);
          }
        }
        return;
      }

      // Global: Dashboard toggle shortcuts (works from Normal and Dashboard modes)
      if (this.dashboardManager) {
        const dashId = this.dashboardManager.matchShortcut(e);
        if (dashId) {
          e.preventDefault();
          e.stopPropagation();
          this.dashboardManager.toggle(dashId);
          return;
        }
      }

      // Global: Cmd+Shift+< cycle focus next (forward through stack)
      // Global: Cmd+Shift+> cycle focus previous (backward through stack)
      // Match on code (Comma/Period) since key value varies with Cmd held on macOS
      if (e.metaKey && e.shiftKey && (e.code === 'Comma' || e.code === 'Period')) {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.focusCycle(e.code === 'Comma' ? 1 : -1);
        return;
      }

      // Leader key: Cmd+P
      if (InputRouter.isLeaderKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (this.mode === Mode.Normal) {
          this.setMode(Mode.Compositor);
        } else {
          this.toNormal();
        }
        return;
      }

      // Escape: return to Normal from any mode
      if (e.key === 'Escape' && this.mode !== Mode.Normal) {
        e.preventDefault();
        e.stopPropagation();
        if (this.mode === Mode.Selection) {
          this.exitSelectionMode();
        } else if (this.mode === Mode.Hint) {
          this.compositor.soundEngine.play('hint.cancel');
          this.hints.exit();
          this.toNormal();
        } else if (this.mode === Mode.CommandPalette) {
          this.commandPalette?.close();
          this.toNormal();
        } else if (this.mode === Mode.Dashboard) {
          this.dashboardManager?.close();
          // DashboardManager.close() triggers modeCallback -> toNormal()
        } else {
          this.toNormal();
        }
        return;
      }

      // Quick Terminal is dismissed via Cmd+I (not Escape), so terminal apps
      // like vim/helix can use Escape without conflict.

      // Ctrl+Shift+U/D — scroll terminal buffer up/down by one page
      if (e.ctrlKey && e.shiftKey && (e.code === 'KeyU' || e.code === 'KeyD')) {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.scrollPages(e.code === 'KeyU' ? -1 : 1);
        return;
      }

      // Global: Cmd+Shift+[ — previous tab, Cmd+Shift+] — next tab
      if (e.metaKey && e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.switchTab(e.code === 'BracketLeft' ? -1 : 1);
        return;
      }

      // Global: Cmd+[ — previous pane, Cmd+] — next pane
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey &&
          (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.cyclePaneFocus(e.code === 'BracketLeft' ? -1 : 1);
        return;
      }

      // Global: Cmd+T — new tab
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.code === 'KeyT') {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.createTab();
        return;
      }

      // Global: Cmd+N — new window
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.createWindow();
        return;
      }

      // Global: Cmd+Shift+H — enter hint mode (works from Normal mode)
      if (InputRouter.isHintKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        this.enterHintMode();
        return;
      }

      // Modifier+Enter: xterm.js discards shift/ctrl/alt modifiers on Enter,
      // so we intercept and send the correct CSI u escape sequence directly.
      // This enables Shift+Enter, Ctrl+Enter, Alt+Enter in shells and apps
      // that understand the kitty keyboard protocol or fixterms encoding.
      if (this.mode === Mode.Normal && e.code === 'Enter' &&
          (e.shiftKey || e.ctrlKey || e.altKey) && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        // CSI u modifier encoding: shift=2, alt=3, alt+shift=4, ctrl=5,
        // ctrl+shift=6, ctrl+alt=7, ctrl+alt+shift=8
        let mod = 1;
        if (e.shiftKey) mod += 1;
        if (e.altKey) mod += 2;
        if (e.ctrlKey) mod += 4;
        // Send CSI 13;{mod} u  (Enter keycode = 13)
        this.compositor.writeToFocusedPty(`\x1b[13;${mod}u`);
        return;
      }

      // Normal mode: if focused pane has a content view, delegate to it
      // (but not when Quick Terminal is visible — QT owns keyboard focus)
      if (this.mode === Mode.Normal) {
        if (this.compositor.isQuickTerminalVisible) {
          return; // Let xterm.js Quick Terminal handle the key
        }
        const pane = this.compositor.getFocusedPanePublic();
        if (pane?.contentView) {
          if (pane.contentView.onKeyDown(e)) {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
        // Otherwise pass through to terminal
        return;
      }

      // Command Palette mode: let typing flow to the <input>, only
      // intercept navigation keys (ArrowUp/Down, Enter, Tab, Escape).
      if (this.mode === Mode.CommandPalette) {
        this.handleCommandPaletteKey(e);
        return;
      }

      // Dashboard mode: delegate to DashboardManager key handler
      if (this.mode === Mode.Dashboard) {
        this.handleDashboardKey(e);
        return;
      }

      // Dispatch to mode handler — prevent default for all other modes
      e.preventDefault();
      e.stopPropagation();

      switch (this.mode) {
        case Mode.Compositor:
          this.handleCompositorKey(e);
          break;
        case Mode.Resize:
          this.handleResizeKey(e);
          break;
        case Mode.Move:
          this.handleMoveKey(e);
          break;
        case Mode.Swap:
          this.handleSwapKey(e);
          break;
        case Mode.Selection:
          this.handleSelectionKey(e);
          break;
        case Mode.Hint:
          this.handleHintKey(e);
          break;
        case Mode.TabMove:
          this.handleTabMoveKey(e);
          break;
      }
    }, true);
  }

  // ─── Compositor Mode ─────────────────────────────────────────────

  private handleCompositorKey(e: KeyboardEvent): void {
    // Ignore modifier-only keypresses (Shift, Ctrl, Alt, Meta) — these are
    // pressed as part of key combos like Shift+H or Shift+V and should not
    // trigger the default "exit compositor" behavior.
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
      return;
    }

    const key = e.key.toLowerCase();

    switch (key) {
      // Focus directional / Hint mode
      case 'h':
        if (e.shiftKey) {
          // Shift+H: enter hint mode
          this.enterHintMode();
        } else {
          this.compositor.focusDirection('left');
          this.toNormal();
        }
        break;
      case 'j':
        this.compositor.focusDirection('down');
        this.toNormal();
        break;
      case 'k':
        this.compositor.focusDirection('up');
        this.toNormal();
        break;
      case 'l':
        this.compositor.focusDirection('right');
        this.toNormal();
        break;

      // Focus by index
      case '1': case '2': case '3': case '4': case '5':
      case '6': case '7': case '8': case '9':
        this.compositor.focusByIndex(parseInt(key, 10));
        this.toNormal();
        break;

      // New window
      case 'n':
        this.compositor.createWindow().then(() => this.toNormal());
        break;

      // Close window
      case 'x': {
        const focused = this.compositor.focusedId;
        if (focused) {
          this.compositor.closeWindow(focused).then(() => {
            if (this.compositor.windowCount === 0) {
              this.compositor.createWindow().then(() => this.toNormal());
            } else {
              this.toNormal();
            }
          });
        }
        break;
      }

      // p — toggle pin / Shift+P — toggle profiler HUD
      case 'p':
        if (e.shiftKey) {
          this.compositor.toggleProfilerHud().then(() => this.toNormal());
        } else {
          this.compositor.togglePin().then(() => this.toNormal());
        }
        break;

      // Toggle focus layout
      case 'f':
        this.compositor.toggleFocusLayout().then(() => this.toNormal());
        break;

      // Toggle maximize
      case 'z':
        this.compositor.toggleMaximize().then(() => this.toNormal());
        break;

      // Enter Resize mode
      case 'r':
        this.setMode(Mode.Resize);
        break;

      // Enter Swap mode
      case 's':
        this.setMode(Mode.Swap);
        break;

      // Enter Move mode
      case 'm':
        this.setMode(Mode.Move);
        break;

      // Enter Selection mode (character-wise)
      case 'v':
        this.enterSelectionMode(e.shiftKey);
        break;

      // ─── Tabs ──────────────────────────────────────────────
      // t — create new tab
      case 't':
        if (e.shiftKey) {
          // Shift+T: enter tab-move mode (wait for window index 1-9)
          this.setMode(Mode.TabMove);
        } else {
          this.compositor.createTab().then(() => this.toNormal());
        }
        break;

      // w — close active tab (or window if last tab)
      case 'w':
        this.compositor.closeTab().then(() => this.toNormal());
        break;

      // [ — previous tab
      case '[':
        this.compositor.switchTab(-1);
        this.toNormal();
        break;

      // ] — next tab
      case ']':
        this.compositor.switchTab(1);
        this.toNormal();
        break;

      // ─── Panes ─────────────────────────────────────────────
      // \ — vertical split
      case '\\':
        this.compositor.splitPane('vertical').then(() => this.toNormal());
        break;

      // - — horizontal split
      case '-':
        this.compositor.splitPane('horizontal').then(() => this.toNormal());
        break;

      // g — cycle shader preset on focused pane / G — toggle shaders globally
      case 'g':
        if (e.shiftKey) {
          this.compositor.toggleShadersGlobally();
        } else {
          this.compositor.cycleShaderPreset();
        }
        this.toNormal();
        break;

      // o — open markdown viewer
      case 'o':
        this.compositor.openMarkdownView().then(() => this.toNormal());
        break;

      // d — open diff view / D — open diff view (staged)
      case 'd':
        this.compositor.openDiffView({ staged: e.shiftKey }).then(() => this.toNormal());
        break;

      // a — open AI agent window (or focus existing)
      case 'a':
        this.compositor.openAgentView().then(() => this.toNormal());
        break;

      // c — clone SSH session (new tab) / C — clone SSH session (new window)
      case 'c':
        if (e.shiftKey) {
          this.compositor.cloneSshSessionToNewWindow().then(() => this.toNormal());
        } else {
          this.compositor.cloneSshSession().then(() => this.toNormal());
        }
        break;

      default:
        // Alt+h/j/k/l — navigate panes
        if (e.altKey && !e.shiftKey) {
          switch (e.code) {
            case 'KeyH':
              this.compositor.focusPaneDirection('left');
              this.toNormal();
              return;
            case 'KeyJ':
              this.compositor.focusPaneDirection('down');
              this.toNormal();
              return;
            case 'KeyK':
              this.compositor.focusPaneDirection('up');
              this.toNormal();
              return;
            case 'KeyL':
              this.compositor.focusPaneDirection('right');
              this.toNormal();
              return;
            // Alt+x — close focused pane
            case 'KeyX':
              this.compositor.closePane().then(() => this.toNormal());
              return;
          }
        }
        this.toNormal();
        break;
    }
  }

  /** Enter Selection mode, optionally line-wise (Shift+V) */
  private enterSelectionMode(lineWise: boolean): void {
    const terminal = this.compositor.getActiveTerminal();
    if (!terminal) {
      this.toNormal();
      return;
    }
    this.selection.enter(terminal, lineWise);
    this.setMode(Mode.Selection);
  }

  /** Exit Selection mode and clean up */
  private exitSelectionMode(): void {
    this.selection.exit();
    this.toNormal();
  }

  // ─── Resize Mode ─────────────────────────────────────────────────

  private handleResizeKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft':
      case 'h':
        this.compositor.resizeFocused('left');
        this.compositor.soundEngine.play('resize.step');
        break;
      case 'ArrowRight':
      case 'l':
        this.compositor.resizeFocused('right');
        this.compositor.soundEngine.play('resize.step');
        break;
      case 'ArrowUp':
      case 'k':
        this.compositor.resizeFocused('up');
        this.compositor.soundEngine.play('resize.step');
        break;
      case 'ArrowDown':
      case 'j':
        this.compositor.resizeFocused('down');
        this.compositor.soundEngine.play('resize.step');
        break;
      case 'Enter':
        this.toNormal();
        break;
      default:
        // Ignore unknown keys, stay in Resize mode
        break;
    }
  }

  // ─── Move Mode ───────────────────────────────────────────────────

  private handleMoveKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft':
      case 'h':
        this.compositor.moveFocused('left');
        this.compositor.soundEngine.play('move.step');
        break;
      case 'ArrowRight':
      case 'l':
        this.compositor.moveFocused('right');
        this.compositor.soundEngine.play('move.step');
        break;
      case 'ArrowUp':
      case 'k':
        this.compositor.moveFocused('up');
        this.compositor.soundEngine.play('move.step');
        break;
      case 'ArrowDown':
      case 'j':
        this.compositor.moveFocused('down');
        this.compositor.soundEngine.play('move.step');
        break;
      case 'Enter':
        this.toNormal();
        break;
      default:
        break;
    }
  }

  // ─── Swap Mode ──────────────────────────────────────────────────

  private handleSwapKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft':
      case 'h':
        this.compositor.swapInDirection('left');
        this.compositor.soundEngine.play('swap.complete');
        this.toNormal();
        break;
      case 'ArrowRight':
      case 'l':
        this.compositor.swapInDirection('right');
        this.compositor.soundEngine.play('swap.complete');
        this.toNormal();
        break;
      case 'ArrowUp':
      case 'k':
        this.compositor.swapInDirection('up');
        this.compositor.soundEngine.play('swap.complete');
        this.toNormal();
        break;
      case 'ArrowDown':
      case 'j':
        this.compositor.swapInDirection('down');
        this.compositor.soundEngine.play('swap.complete');
        this.toNormal();
        break;
      default:
        this.toNormal();
        break;
    }
  }

  // ─── Tab Move Mode ────────────────────────────────────────────
  // Entered via Shift+T in compositor mode. Waits for a 1-9 key
  // to move the active tab to that window index.

  private handleTabMoveKey(e: KeyboardEvent): void {
    const key = e.key;
    if (key >= '1' && key <= '9') {
      this.compositor.moveTabToWindow(parseInt(key, 10));
      this.toNormal();
    } else {
      // Any other key cancels
      this.toNormal();
    }
  }

  // ─── Command Palette Mode ──────────────────────────────────────
  // The palette has its own <input> that receives typing events.
  // We only intercept navigation keys (ArrowUp/Down, Enter, Tab).
  // All other keys pass through to the input element.

  private handleCommandPaletteKey(e: KeyboardEvent): void {
    if (!this.commandPalette) {
      this.toNormal();
      return;
    }

    const consumed = this.commandPalette.handleKey(e);
    if (consumed) {
      e.preventDefault();
      e.stopPropagation();
      // If the action closed the palette, return to Normal
      if (!this.commandPalette.isVisible) {
        this.toNormal();
      }
    }
    // If not consumed (regular typing), do NOT preventDefault —
    // let the event reach the <input> element naturally.
  }

  // ─── Dashboard Mode ────────────────────────────────────────────
  // The dashboard has its own key handler. We delegate all keys to
  // DashboardManager, which in turn calls the active dashboard's onKeyDown.

  private handleDashboardKey(e: KeyboardEvent): void {
    if (!this.dashboardManager) {
      this.toNormal();
      return;
    }

    const consumed = this.dashboardManager.handleKey(e);
    if (consumed) {
      e.preventDefault();
      e.stopPropagation();
    }
    // If the dashboard was closed by the key handler, mode is already Normal
    // (DashboardManager.close() triggers modeCallback -> toNormal)
  }

  // ─── Hint Mode ─────────────────────────────────────────────────

  private enterHintMode(): void {
    console.log('[InputRouter] enterHintMode called');
    const terminal = this.compositor.getActiveTerminal();
    console.log('[InputRouter] active terminal:', terminal ? 'found' : 'null');
    if (!terminal) {
      this.toNormal();
      return;
    }
    this.compositor.soundEngine.play('hint.activate');
    const found = this.hints.enter(terminal);
    console.log('[InputRouter] hint mode entered:', found);
    if (found) {
      this.setMode(Mode.Hint);
    } else {
      // No matches — toast shown by HintController, stay/return to Normal
      this.toNormal();
    }
  }

  private handleHintKey(e: KeyboardEvent): void {
    const result = this.hints.handleKey(e);
    switch (result) {
      case 'selected':
        this.compositor.soundEngine.play('hint.select');
        this.toNormal();
        break;
      case 'exit':
        this.compositor.soundEngine.play('hint.cancel');
        this.toNormal();
        break;
      case 'continue':
        // Stay in hint mode
        break;
    }
  }

  // ─── Selection Mode ────────────────────────────────────────────

  private handleSelectionKey(e: KeyboardEvent): void {
    const key = e.key;

    // Ctrl+u / Ctrl+d — half page scroll
    if (e.ctrlKey) {
      switch (key) {
        case 'u':
          this.selection.halfPageUp();
          return;
        case 'd':
          this.selection.halfPageDown();
          return;
      }
    }

    switch (key) {
      // Movement
      case 'h':
      case 'ArrowLeft':
        this.selection.moveLeft();
        break;
      case 'j':
      case 'ArrowDown':
        this.selection.moveDown();
        break;
      case 'k':
      case 'ArrowUp':
        this.selection.moveUp();
        break;
      case 'l':
      case 'ArrowRight':
        this.selection.moveRight();
        break;

      // Word motions
      case 'w':
        this.selection.wordForward();
        break;
      case 'b':
        this.selection.wordBack();
        break;
      case 'e':
        this.selection.wordEnd();
        break;

      // Line start/end
      case '0':
        this.selection.lineStart();
        break;
      case '$':
        this.selection.lineEnd();
        break;

      // Buffer top/bottom
      case 'g':
        this.selection.handleG();
        break;
      case 'G':
        this.selection.bufferBottom();
        break;

      // Selection toggles
      case 'v':
        if (e.shiftKey) {
          this.selection.toggleLineSelect();
        } else {
          this.selection.toggleCharSelect();
        }
        break;
      case 'V':
        this.selection.toggleLineSelect();
        break;

      // Yank (copy)
      case 'y':
        this.selection.yank().then((copied) => {
          if (copied) {
            this.compositor.soundEngine.play('mode.exit');
          }
          this.exitSelectionMode();
        });
        break;

      // Escape handled by the main handler above, but just in case:
      case 'Escape':
        this.exitSelectionMode();
        break;

      default:
        // Unknown keys are ignored — stay in Selection mode
        break;
    }
  }
}
