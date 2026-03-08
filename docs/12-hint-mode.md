# 12 — Hint Mode

> **Status:** Implemented  
> **Milestone:** M8 (Polish)  
> **Depends on:** Compositor, Input Router, xterm.js buffer API

## Overview

Hint mode scans the visible terminal buffer for configurable regex patterns (URLs, file paths, emails, etc.), overlays short keyboard labels on each match, and lets the user type a label to act on the match (open, copy, or paste). Inspired by [Rio Terminal hints](https://rioterm.com/docs/features/hints).

## User Flow

1. User presses `Leader Shift+H` (from Compositor mode) or global shortcut `Cmd+Shift+H`
2. Mode switches to `Mode.Hint`
3. The visible buffer of the **focused terminal** is scanned for all configured patterns
4. Each match gets a short label (e.g., `a`, `s`, `d`, `f`, `aa`, `as`, ...) rendered as a floating overlay on top of the terminal
5. User types the label characters — as they type, non-matching labels fade out
6. When a label is fully matched:
   - The configured action fires (open URL, copy to clipboard, etc.)
   - Mode returns to Normal
7. `Escape` cancels hint mode at any time

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `src/hints.ts` | `HintController` class — scanning, label generation, overlay rendering, input handling |

### Mode Addition

Add `Hint = 'Hint'` to the `Mode` enum in `src/types.ts`.

### Input Routing

In `src/input-router.ts`:
- `Cmd+Shift+H` as a global interceptor (works from Normal mode) enters Hint mode
- `Shift+H` in Compositor mode enters Hint mode
- When in `Mode.Hint`, all key events route to `HintController.handleKey()`
- `Escape` exits to Normal
- Alphanumeric keys narrow/select labels
- `Backspace` removes last typed character from the filter

### Terminal Buffer Scanning

Use xterm.js buffer API to read visible content:

```typescript
const buffer = terminal.buffer.active;
const startRow = buffer.viewportY;
for (let row = startRow; row < startRow + terminal.rows; row++) {
  const line = buffer.getLine(row);
  if (!line) continue;
  const text = line.translateToString(false);
  // Run regex matches against text, record col/row/length
}
```

Multi-line matches are not supported in v1 — each line is scanned independently.

### Label Generation

Labels are generated from an **alphabet string** (configurable, default `"asdfghjklqweruiop"`). Labels are assigned shortest-first:

- If matches <= alphabet length: single-character labels (`a`, `s`, `d`, ...)
- If more matches: two-character labels (`aa`, `as`, `ad`, ...) appended as needed
- Labels are assigned to matches in reading order (top-left to bottom-right)

Algorithm: prefix-free code generation ensuring no label is a prefix of another.

### Overlay Rendering

Each hint label is an absolutely-positioned `<div>` placed over the terminal:

```html
<div class="krypton-hint-overlay">
  <div class="krypton-hint" style="left: {x}px; top: {y}px;">
    <span class="krypton-hint__label">as</span>
  </div>
  <!-- ... more hints ... -->
</div>
```

Position calculation:
- Get the terminal container's bounding rect
- Compute character cell size: `containerWidth / terminal.cols`, `containerHeight / terminal.rows`
- Place each hint at `(col * cellWidth, (row - viewportY) * cellHeight)`

Label styling:
- Background: `var(--krypton-hint-bg)` (default: amber/gold `#f4bf75`)
- Text: `var(--krypton-hint-fg)` (default: dark `#181818`)
- Font: monospace, bold, small (10px)
- Border-radius: 2px
- Z-index: 9000 (above terminal content, below which-key)

As the user types, matched characters in the label get a "matched" style (dimmer) and non-matching hints get `opacity: 0.2`.

### Actions

Each hint rule has an `action` that fires when a label is selected:

| Action | Behavior |
|--------|----------|
| `"Copy"` | Copy matched text to clipboard via `navigator.clipboard.writeText()` |
| `"Open"` | Open matched text via Tauri `shell.open()` (opens URLs in browser, files in default app) |
| `"Paste"` | Write matched text to the terminal's PTY input |

Default action per built-in pattern:
- URLs → `"Open"`
- File paths → `"Copy"`
- Emails → `"Copy"`

### Built-in Patterns

Ship three built-in hint rules (active by default):

| Name | Regex | Action | Description |
|------|-------|--------|-------------|
| `url` | `(https?://\|ftp://)[^\x00-\x1F\x7F-\x9F<>"\\s{}\^⟨⟩\x60\\\\]+` | Open | HTTP/HTTPS/FTP URLs |
| `filepath` | `~?/?(?:[\\w@.-]+/)+[\\w@.-]+` | Copy | Unix-style file paths |
| `email` | `[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}` | Copy | Email addresses |

Users can override or add patterns via config (see Configuration section).

## Configuration

### TOML Config

```toml
[hints]
# Characters used for label generation (default: home row + common keys)
alphabet = "asdfghjklqweruiop"

# Built-in patterns are enabled by default. To disable one:
# [hints.rules.url]
# enabled = false

# Custom hint rule example:
[[hints.rules]]
name = "ip-address"
regex = "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b"
action = "Copy"

[[hints.rules]]
name = "git-sha"
regex = "\\b[0-9a-f]{7,40}\\b"
action = "Copy"
```

### TypeScript Config Interface

```typescript
export interface HintRule {
  name: string;
  regex: string;
  action: 'Copy' | 'Open' | 'Paste';
  enabled: boolean;
}

export interface HintsConfig {
  alphabet: string;
  rules: HintRule[];
}
```

### Rust Config Struct

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HintsConfig {
    pub alphabet: String,
    pub rules: Vec<HintRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HintRule {
    pub name: String,
    pub regex: String,
    pub action: HintAction,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HintAction {
    Copy,
    Open,
    Paste,
}
```

Built-in patterns are injected in `Default for HintsConfig` — user config merges on top (matching by `name`).

### Theme Properties

Add to `[ui]` section in theme TOML and the `UiConfig` struct:

```toml
[ui.hints]
background = "#f4bf75"
foreground = "#181818"
matched_foreground = "#8a7444"
```

CSS custom properties:
- `--krypton-hint-bg`
- `--krypton-hint-fg`
- `--krypton-hint-matched-fg`

## Sound Integration

Use existing sound event infrastructure:

| Event | When |
|-------|------|
| `hint.activate` | Entering hint mode |
| `hint.select` | A label is fully matched and action fires |
| `hint.cancel` | Exiting via Escape with no selection |

## WhichKey Integration

When in `Mode.Hint`, WhichKey shows:
```
[a-z]  type label    Esc  cancel    Bksp  undo char
```

## Edge Cases

- **No matches found:** Show a brief "No hints found" message (toast-style, 1s), return to Normal
- **Single match:** Still show the label, don't auto-execute (user confirms by typing)
- **Terminal scrolling:** Hints are computed for the current viewport only; scrolling cancels hint mode
- **Quick Terminal:** Hint mode works on the Quick Terminal if it's focused
- **Multiple windows:** Only the focused window's terminal is scanned

## Performance

- Regex scanning of visible buffer only (typically 24-80 lines) — negligible cost
- DOM overlay creation is O(n) where n = number of matches (typically < 50)
- Labels are removed on mode exit (not left in DOM)

## Not in Scope (v1)

- Multi-line pattern matching
- Mouse interaction with hints
- `persist` mode (staying in hint mode after a selection)
- Custom external commands as actions (only Copy/Open/Paste)
- Per-rule keybinding to activate specific pattern types
