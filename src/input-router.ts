// Krypton — Input Router
// Handles keyboard modes: Normal, Compositor, Resize, Move.
// In Normal mode, all keys pass through to the focused terminal.
// Leader key (Ctrl+Space) enters Compositor mode which shows a
// which-key popup with available actions.

import { Mode } from './types';
import { Compositor } from './compositor';

/** Callback for mode changes */
type ModeChangeCallback = (mode: Mode) => void;

export class InputRouter {
  private mode: Mode = Mode.Normal;
  private compositor: Compositor;
  private modeChangeCallbacks: ModeChangeCallback[] = [];

  constructor(compositor: Compositor) {
    this.compositor = compositor;
    this.setupKeyHandler();
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
      // Prevent xterm from consuming Escape when Quick Terminal is focused
      // (so input-router can hide it)
      if (e.key === 'Escape' && this.compositor.isQuickTerminalFocused && this.mode === Mode.Normal) {
        return false;
      }
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

  private setMode(mode: Mode): void {
    const prevMode = this.mode;
    this.mode = mode;

    // Play sound on mode transitions
    if (prevMode === Mode.Normal && mode !== Mode.Normal) {
      this.compositor.soundEngine.play('mode.enter');
    } else if (prevMode !== Mode.Normal && mode === Mode.Normal) {
      this.compositor.soundEngine.play('mode.exit');
    }

    for (const cb of this.modeChangeCallbacks) {
      cb(mode);
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
        this.toNormal();
        return;
      }

      // Escape in Normal mode: hide Quick Terminal if it's focused
      if (e.key === 'Escape' && this.mode === Mode.Normal && this.compositor.isQuickTerminalFocused) {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.toggleQuickTerminal();
        return;
      }

      // Ctrl+Shift+U/D — scroll terminal buffer up/down by one page
      if (e.ctrlKey && e.shiftKey && (e.code === 'KeyU' || e.code === 'KeyD')) {
        e.preventDefault();
        e.stopPropagation();
        this.compositor.scrollPages(e.code === 'KeyU' ? -1 : 1);
        return;
      }

      // Normal mode: pass through to terminal
      if (this.mode === Mode.Normal) {
        return;
      }

      // Dispatch to mode handler
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
      }
    }, true);
  }

  // ─── Compositor Mode ─────────────────────────────────────────────

  private handleCompositorKey(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();

    switch (key) {
      // Focus directional
      case 'h':
        this.compositor.focusDirection('left');
        this.toNormal();
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

      default:
        this.toNormal();
        break;
    }
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
}
