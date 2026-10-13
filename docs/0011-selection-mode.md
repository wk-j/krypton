# Selection Mode — Implementation Spec

> Status: Implemented
> Date: 2026-03-08
> Milestone: M8 — Polish

## Problem

There is no keyboard-driven way to select and copy text from the terminal. Users must use the mouse, which breaks the keyboard-first philosophy. A vim-like Selection mode lets users navigate the terminal buffer, select text visually, and yank it to the clipboard — all without touching the mouse.

## Solution

Add a new `Selection` mode to the InputRouter. When activated, a virtual cursor appears at the terminal's current cursor position. The user navigates with vim motions (h/j/k/l, w/b/e, 0/$, g/G), starts visual selection with `v` (character-wise) or `V` (line-wise), and yanks to clipboard with `y`. The selection is rendered via xterm.js's `terminal.select()` API. Escape exits without copying.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `Selection` to `Mode` enum |
| `src/selection.ts` | **New file** — `SelectionController` class with cursor movement, selection tracking, clipboard |
| `src/input-router.ts` | Add Selection mode entry (from Compositor: `v`/`V`), dispatch to `handleSelectionKey()` |
| `src/which-key.ts` | Add Selection mode keybinding hints |
| `src/compositor.ts` | Expose `getActiveTerminal()` method for SelectionController to access the focused xterm.js instance |
| `src/styles.css` | Add `.krypton-selection-cursor` overlay style for the virtual cursor indicator |

## Design

### Data Structures

```typescript
// In src/selection.ts

/** Selection type — character-wise or line-wise */
enum SelectionType {
  None = 'none',       // Cursor-only mode (navigation, no selection yet)
  Char = 'char',       // v — character-wise visual selection
  Line = 'line',       // V — line-wise visual selection
}

/** Virtual cursor position within the terminal buffer */
interface BufferPosition {
  x: number;  // column (0-based)
  y: number;  // row in buffer (absolute, includes scrollback)
}

class SelectionController {
  private terminal: Terminal | null;
  private cursor: BufferPosition;
  private anchor: BufferPosition | null;  // selection start (null = no selection)
  private selectionType: SelectionType;
  private cursorOverlay: HTMLElement | null;  // visual cursor marker

  enter(terminal: Terminal): void;   // Enter selection mode
  exit(): void;                       // Exit, clear selection
  
  // Movement
  moveLeft(): void;     // h
  moveDown(): void;     // j
  moveUp(): void;       // k
  moveRight(): void;    // l
  wordForward(): void;  // w
  wordBack(): void;     // b
  wordEnd(): void;      // e
  lineStart(): void;    // 0
  lineEnd(): void;      // $
  bufferTop(): void;    // g (double-tap gg)
  bufferBottom(): void; // G
  halfPageUp(): void;   // Ctrl+u
  halfPageDown(): void; // Ctrl+d

  // Selection
  toggleCharSelect(): void;  // v — start/stop char-wise selection
  toggleLineSelect(): void;  // V — start/stop line-wise selection

  // Actions
  yank(): Promise<void>;  // y — copy selection to clipboard, exit mode
}
```

### API / Commands

No new Tauri commands needed. This is entirely frontend:

- `compositor.getActiveTerminal(): Terminal | null` — returns the focused terminal's xterm.js `Terminal` instance (or Quick Terminal's if QT is focused)
- `SelectionController.enter(terminal)` / `.exit()` — called by InputRouter on mode transitions

Clipboard write uses the standard `navigator.clipboard.writeText()` API.

### Data Flow

```
1. User presses Leader then v (or V) in Compositor mode
2. InputRouter sets mode to Selection, calls compositor.getActiveTerminal()
3. SelectionController.enter(terminal) initializes:
   a. Reads terminal.buffer.active.cursorY / cursorX for initial position
   b. Creates cursor overlay element positioned over that cell
   c. If entered via V, immediately sets selectionType = Line and anchor = cursor
   d. If entered via v, sets selectionType = None (cursor-only until v pressed)
4. User presses movement keys (h/j/k/l/w/b/etc.)
5. SelectionController updates cursor position, scrolls viewport if needed
6. User presses v or V to start visual selection (sets anchor = current cursor)
7. On each cursor move after anchor is set:
   a. Compute selection range from anchor to cursor
   b. Call terminal.select(startCol, startRow, length) to highlight
8. User presses y:
   a. Read terminal.getSelection()
   b. Write to clipboard via navigator.clipboard.writeText()
   c. InputRouter exits to Normal mode
   d. SelectionController.exit() removes overlay, clears selection
9. User presses Escape at any point:
   a. InputRouter exits to Normal mode
   b. SelectionController.exit() clears everything
```

### Keybindings

**Entry (from Compositor mode):**

| Key | Action |
|-----|--------|
| `v` | Enter Selection mode (cursor-only, press v again to start char selection) |
| `V` | Enter Selection mode with line-wise selection immediately active |

**In Selection mode:**

| Key | Action |
|-----|--------|
| `h` / `ArrowLeft` | Move cursor left |
| `j` / `ArrowDown` | Move cursor down |
| `k` / `ArrowUp` | Move cursor up |
| `l` / `ArrowRight` | Move cursor right |
| `w` | Jump to next word start |
| `b` | Jump to previous word start |
| `e` | Jump to current/next word end |
| `0` | Jump to line start |
| `$` | Jump to line end |
| `g` | Jump to buffer top (first line) |
| `G` | Jump to buffer bottom (last line) |
| `Ctrl+u` | Half page up |
| `Ctrl+d` | Half page down |
| `v` | Toggle character-wise selection (sets/clears anchor) |
| `V` | Toggle line-wise selection |
| `y` | Yank (copy) selection to clipboard and exit |
| `Escape` | Exit Selection mode without copying |

### UI Changes

**Virtual cursor overlay:** A small highlighted block positioned absolutely over the current cell. Uses the same accent color as the theme (`--krypton-focused-accent`). This is a DOM element layered on top of the terminal body, repositioned on each cursor move by reading cell dimensions from xterm.js.

**CSS classes:**
```css
.krypton-selection-cursor {
  position: absolute;
  background: var(--krypton-focused-accent, #0cf);
  opacity: 0.7;
  pointer-events: none;
  z-index: 3;
  transition: transform 50ms ease;
}
```

**xterm.js selection highlight:** Uses the built-in `terminal.select(col, row, length)` which renders the selection using xterm.js's native selection styling (colored by the theme's `selection` color).

## Edge Cases

- **Empty buffer:** If terminal has no content, movement is clamped to row 0, col 0.
- **Scrollback:** Cursor can move into scrollback. Viewport auto-scrolls to keep cursor visible via `terminal.scrollToLine()`.
- **Line wrapping:** `w/b/e` word motions treat each buffer row independently. `$` goes to the last non-whitespace character on the row.
- **Quick Terminal:** Selection mode works on whichever terminal is focused, including the Quick Terminal.
- **Selection across scrollback:** `terminal.select()` handles this natively.
- **No selection on yank:** If the user presses `y` without any active selection (cursor-only mode), it's a no-op — stay in Selection mode.
- **Mode indicator:** The mode indicator bar shows "Selection" (or "Visual" / "V-Line") when active.

## Out of Scope

- Block/column selection (Ctrl+v in vim) — can be added later
- Search within selection mode (/ to search) — future enhancement
- Registers or yank history — clipboard only for now
- Mouse interaction during selection mode
