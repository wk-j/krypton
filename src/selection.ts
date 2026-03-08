// Krypton — Selection Controller
// Vim-like keyboard-driven text selection mode for terminal buffers.
// Manages a virtual cursor, character/line-wise visual selection,
// and clipboard yanking via navigator.clipboard.

import { Terminal } from '@xterm/xterm';

/** Selection type — character-wise or line-wise */
export enum SelectionType {
  None = 'none',
  Char = 'char',
  Line = 'line',
}

/** Virtual cursor position within the terminal buffer (0-based) */
interface BufferPosition {
  x: number;  // column
  y: number;  // absolute row in buffer (includes scrollback)
}

export class SelectionController {
  private terminal: Terminal | null = null;
  private terminalBody: HTMLElement | null = null;
  private cursor: BufferPosition = { x: 0, y: 0 };
  private anchor: BufferPosition | null = null;
  private selectionType: SelectionType = SelectionType.None;
  private cursorOverlay: HTMLElement | null = null;
  private gPending: boolean = false; // waiting for second 'g' press

  /** Whether the controller is currently active */
  get active(): boolean {
    return this.terminal !== null;
  }

  /** Current selection type (for mode indicator display) */
  get type(): SelectionType {
    return this.selectionType;
  }

  /**
   * Enter selection mode on the given terminal.
   * @param terminal The xterm.js Terminal instance
   * @param lineWise If true, start with line-wise selection immediately
   */
  enter(terminal: Terminal, lineWise: boolean): void {
    this.terminal = terminal;
    this.selectionType = SelectionType.None;
    this.anchor = null;
    this.gPending = false;

    // Find the terminal body element (parent of the xterm container)
    const xtermEl = terminal.element;
    this.terminalBody = xtermEl?.closest('.krypton-window__body') as HTMLElement ?? null;

    // Initialize cursor at the terminal's current cursor position
    const buf = terminal.buffer.active;
    this.cursor = {
      x: buf.cursorX,
      y: buf.baseY + buf.cursorY,
    };

    // Create the visual cursor overlay
    this.createCursorOverlay();
    this.updateCursorOverlay();

    // If line-wise, immediately start selection
    if (lineWise) {
      this.selectionType = SelectionType.Line;
      this.anchor = { ...this.cursor };
      this.updateSelection();
    }
  }

  /** Exit selection mode, clean up */
  exit(): void {
    if (this.terminal) {
      this.terminal.clearSelection();
    }
    this.removeCursorOverlay();
    this.terminal = null;
    this.terminalBody = null;
    this.anchor = null;
    this.selectionType = SelectionType.None;
    this.gPending = false;
  }

  // ─── Movement ─────────────────────────────────────────────────────

  moveLeft(): void {
    this.gPending = false;
    if (this.cursor.x > 0) {
      this.cursor.x--;
    }
    this.afterMove();
  }

  moveRight(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const maxCol = this.terminal.cols - 1;
    if (this.cursor.x < maxCol) {
      this.cursor.x++;
    }
    this.afterMove();
  }

  moveUp(): void {
    this.gPending = false;
    if (this.cursor.y > 0) {
      this.cursor.y--;
      this.clampX();
    }
    this.afterMove();
  }

  moveDown(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const maxRow = this.terminal.buffer.active.length - 1;
    if (this.cursor.y < maxRow) {
      this.cursor.y++;
      this.clampX();
    }
    this.afterMove();
  }

  wordForward(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const buf = this.terminal.buffer.active;
    let { x, y } = this.cursor;
    const maxRow = buf.length - 1;

    // Skip current word (non-whitespace)
    while (y <= maxRow) {
      const line = buf.getLine(y);
      if (!line) break;
      const ch = this.getCharAt(line, x);
      if (this.isWhitespace(ch)) break;
      x++;
      if (x >= this.terminal.cols) {
        x = 0;
        y++;
      }
    }
    // Skip whitespace
    while (y <= maxRow) {
      const line = buf.getLine(y);
      if (!line) break;
      const ch = this.getCharAt(line, x);
      if (!this.isWhitespace(ch)) break;
      x++;
      if (x >= this.terminal.cols) {
        x = 0;
        y++;
      }
    }

    this.cursor = { x: Math.min(x, this.terminal.cols - 1), y: Math.min(y, maxRow) };
    this.afterMove();
  }

  wordBack(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const buf = this.terminal.buffer.active;
    let { x, y } = this.cursor;

    // Move back one to start searching from previous char
    x--;
    if (x < 0) {
      y--;
      if (y < 0) { this.cursor = { x: 0, y: 0 }; this.afterMove(); return; }
      x = this.terminal.cols - 1;
    }

    // Skip whitespace backwards
    while (y >= 0) {
      const line = buf.getLine(y);
      if (!line) break;
      const ch = this.getCharAt(line, x);
      if (!this.isWhitespace(ch)) break;
      x--;
      if (x < 0) {
        y--;
        if (y < 0) break;
        x = this.terminal.cols - 1;
      }
    }
    // Skip word backwards (non-whitespace)
    while (y >= 0) {
      const line = buf.getLine(y);
      if (!line) break;
      if (x <= 0) break;
      const prevCh = this.getCharAt(line, x - 1);
      if (this.isWhitespace(prevCh)) break;
      x--;
    }

    this.cursor = { x: Math.max(x, 0), y: Math.max(y, 0) };
    this.afterMove();
  }

  wordEnd(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const buf = this.terminal.buffer.active;
    let { x, y } = this.cursor;
    const maxRow = buf.length - 1;

    // Move forward one to start searching from next char
    x++;
    if (x >= this.terminal.cols) {
      x = 0;
      y++;
    }

    // Skip whitespace
    while (y <= maxRow) {
      const line = buf.getLine(y);
      if (!line) break;
      const ch = this.getCharAt(line, x);
      if (!this.isWhitespace(ch)) break;
      x++;
      if (x >= this.terminal.cols) {
        x = 0;
        y++;
      }
    }
    // Move to end of word (non-whitespace)
    while (y <= maxRow) {
      const line = buf.getLine(y);
      if (!line) break;
      if (x + 1 >= this.terminal.cols) break;
      const nextCh = this.getCharAt(line, x + 1);
      if (this.isWhitespace(nextCh)) break;
      x++;
    }

    this.cursor = { x: Math.min(x, this.terminal.cols - 1), y: Math.min(y, maxRow) };
    this.afterMove();
  }

  lineStart(): void {
    this.gPending = false;
    this.cursor.x = 0;
    this.afterMove();
  }

  lineEnd(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const buf = this.terminal.buffer.active;
    const line = buf.getLine(this.cursor.y);
    if (line) {
      // Find last non-whitespace character
      const text = line.translateToString(true);
      this.cursor.x = Math.max(text.length - 1, 0);
    }
    this.afterMove();
  }

  /** Handle 'g' key — first press sets pending, second press goes to top */
  handleG(): void {
    if (this.gPending) {
      this.bufferTop();
      this.gPending = false;
    } else {
      this.gPending = true;
    }
  }

  bufferTop(): void {
    this.gPending = false;
    this.cursor = { x: 0, y: 0 };
    this.afterMove();
  }

  bufferBottom(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const buf = this.terminal.buffer.active;
    this.cursor = { x: 0, y: buf.length - 1 };
    this.afterMove();
  }

  halfPageUp(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const jump = Math.floor(this.terminal.rows / 2);
    this.cursor.y = Math.max(this.cursor.y - jump, 0);
    this.clampX();
    this.afterMove();
  }

  halfPageDown(): void {
    this.gPending = false;
    if (!this.terminal) return;
    const buf = this.terminal.buffer.active;
    const jump = Math.floor(this.terminal.rows / 2);
    this.cursor.y = Math.min(this.cursor.y + jump, buf.length - 1);
    this.clampX();
    this.afterMove();
  }

  // ─── Selection Toggles ────────────────────────────────────────────

  toggleCharSelect(): void {
    this.gPending = false;
    if (this.selectionType === SelectionType.Char) {
      // Cancel selection, back to cursor-only
      this.selectionType = SelectionType.None;
      this.anchor = null;
      if (this.terminal) this.terminal.clearSelection();
    } else {
      this.selectionType = SelectionType.Char;
      this.anchor = { ...this.cursor };
      this.updateSelection();
    }
  }

  toggleLineSelect(): void {
    this.gPending = false;
    if (this.selectionType === SelectionType.Line) {
      this.selectionType = SelectionType.None;
      this.anchor = null;
      if (this.terminal) this.terminal.clearSelection();
    } else {
      this.selectionType = SelectionType.Line;
      this.anchor = { ...this.cursor };
      this.updateSelection();
    }
  }

  // ─── Actions ──────────────────────────────────────────────────────

  /** Yank (copy) the current selection to clipboard. Returns true if text was copied. */
  async yank(): Promise<boolean> {
    if (!this.terminal || !this.anchor) return false;

    const text = this.terminal.getSelection();
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.error('[Selection] Failed to write to clipboard:', e);
      return false;
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────

  /** Called after every cursor movement to update selection + overlay + scroll */
  private afterMove(): void {
    this.ensureCursorVisible();
    this.updateSelection();
    this.updateCursorOverlay();
  }

  /** Clamp cursor.x to be within the valid range for the current row */
  private clampX(): void {
    if (!this.terminal) return;
    this.cursor.x = Math.min(this.cursor.x, this.terminal.cols - 1);
    this.cursor.x = Math.max(this.cursor.x, 0);
  }

  /** Scroll the viewport to keep the virtual cursor visible */
  private ensureCursorVisible(): void {
    if (!this.terminal) return;
    const buf = this.terminal.buffer.active;
    const viewTop = buf.viewportY;
    const viewBottom = viewTop + this.terminal.rows - 1;

    if (this.cursor.y < viewTop) {
      this.terminal.scrollToLine(this.cursor.y);
    } else if (this.cursor.y > viewBottom) {
      this.terminal.scrollToLine(this.cursor.y - this.terminal.rows + 1);
    }
  }

  /** Update the xterm.js selection based on anchor + cursor + selectionType */
  private updateSelection(): void {
    if (!this.terminal || !this.anchor) return;

    if (this.selectionType === SelectionType.Line) {
      const startRow = Math.min(this.anchor.y, this.cursor.y);
      const endRow = Math.max(this.anchor.y, this.cursor.y);
      this.terminal.selectLines(startRow, endRow);
    } else if (this.selectionType === SelectionType.Char) {
      // Determine start and end in reading order
      let startY = this.anchor.y;
      let startX = this.anchor.x;
      let endY = this.cursor.y;
      let endX = this.cursor.x;

      if (startY > endY || (startY === endY && startX > endX)) {
        [startY, startX, endY, endX] = [endY, endX, startY, startX];
      }

      if (startY === endY) {
        // Single-line selection
        const len = endX - startX + 1;
        this.terminal.select(startX, startY, len);
      } else {
        // Multi-line: select from startX to end of first line,
        // then full middle lines, then start of last line to endX.
        // xterm.js select() only does single-line, so we use a
        // length that spans the entire range linearly.
        const cols = this.terminal.cols;
        const totalLen = (endY - startY) * cols + (endX - startX) + 1;
        this.terminal.select(startX, startY, totalLen);
      }
    }
  }

  /** Create the visual cursor overlay element */
  private createCursorOverlay(): void {
    this.removeCursorOverlay();
    const el = document.createElement('div');
    el.className = 'krypton-selection-cursor';
    if (this.terminalBody) {
      this.terminalBody.appendChild(el);
    }
    this.cursorOverlay = el;
  }

  /** Remove the visual cursor overlay element */
  private removeCursorOverlay(): void {
    if (this.cursorOverlay) {
      this.cursorOverlay.remove();
      this.cursorOverlay = null;
    }
  }

  /** Position the cursor overlay over the current cell */
  private updateCursorOverlay(): void {
    if (!this.cursorOverlay || !this.terminal) return;

    const buf = this.terminal.buffer.active;
    // Convert absolute buffer row to viewport-relative row
    const viewRow = this.cursor.y - buf.viewportY;

    // Get cell dimensions from the terminal's core renderer
    // xterm.js exposes _core with dimensions, but we can calculate from element size
    const xtermEl = this.terminal.element;
    if (!xtermEl) return;

    const screenEl = xtermEl.querySelector('.xterm-screen') as HTMLElement;
    if (!screenEl) return;

    const cellWidth = screenEl.clientWidth / this.terminal.cols;
    const cellHeight = screenEl.clientHeight / this.terminal.rows;

    // Account for the padding in .krypton-window__body .xterm (4px top, 6px left)
    const padTop = 4;
    const padLeft = 6;

    this.cursorOverlay.style.width = `${cellWidth}px`;
    this.cursorOverlay.style.height = `${cellHeight}px`;
    this.cursorOverlay.style.transform = `translate(${padLeft + this.cursor.x * cellWidth}px, ${padTop + viewRow * cellHeight}px)`;

    // Hide if cursor is outside visible viewport
    if (viewRow < 0 || viewRow >= this.terminal.rows) {
      this.cursorOverlay.style.display = 'none';
    } else {
      this.cursorOverlay.style.display = '';
    }
  }

  /** Get character at position in a buffer line */
  private getCharAt(line: ReturnType<NonNullable<typeof this.terminal>['buffer']['active']['getLine']>, x: number): string {
    if (!line) return ' ';
    const cell = line.getCell(x);
    if (!cell) return ' ';
    const ch = cell.getChars();
    return ch || ' ';
  }

  /** Check if a character is whitespace */
  private isWhitespace(ch: string): boolean {
    return ch === '' || ch === ' ' || ch === '\t' || ch === '\0';
  }
}
