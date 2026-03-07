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

  private setMode(mode: Mode): void {
    this.mode = mode;
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

      // Enter Resize mode
      case 'r':
        this.setMode(Mode.Resize);
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
        break;
      case 'ArrowRight':
      case 'l':
        this.compositor.resizeFocused('right');
        break;
      case 'ArrowUp':
      case 'k':
        this.compositor.resizeFocused('up');
        break;
      case 'ArrowDown':
      case 'j':
        this.compositor.resizeFocused('down');
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
        break;
      case 'ArrowRight':
      case 'l':
        this.compositor.moveFocused('right');
        break;
      case 'ArrowUp':
      case 'k':
        this.compositor.moveFocused('up');
        break;
      case 'ArrowDown':
      case 'j':
        this.compositor.moveFocused('down');
        break;
      case 'Enter':
        this.toNormal();
        break;
      default:
        break;
    }
  }
}
