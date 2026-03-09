# Command Palette — Implementation Spec

> Status: Implemented
> Date: 2026-03-09
> Milestone: M4 — Keyboard System & Workspaces

## Problem

Users must memorize keybindings to perform actions. There is no discoverable, searchable interface to find and execute commands. Complex actions like unpinning a window require knowing directional focus keys to reach it first.

## Solution

Add a fuzzy-searchable command palette overlay activated by `Cmd+Shift+P`. It lists every action in Krypton with its keybinding. The user types to filter, uses arrow keys to navigate, and presses Enter to execute. A new `src/command-palette.ts` module owns the UI and action registry. The input router gains a `CommandPalette` mode.

## Affected Files

| File | Change |
|------|--------|
| `src/command-palette.ts` | **New** — action registry, fuzzy filter, DOM overlay, execute dispatch |
| `src/types.ts` | Add `CommandPalette` to `Mode` enum |
| `src/input-router.ts` | Add `Cmd+Shift+P` global hotkey, `handleCommandPaletteKey()` handler |
| `src/compositor.ts` | Expose any missing public methods needed by actions |
| `src/main.ts` | Instantiate `CommandPalette`, wire to compositor and input router |
| `src/theme.ts` | Map remaining CSS variables for command palette theme |
| `src/styles.css` | Styles for `.krypton-palette` overlay |
| `src/which-key.ts` | No change needed (command palette is a global hotkey, not a compositor key) |

## Design

### Data Structures

```typescript
/** A single action in the command palette registry */
interface PaletteAction {
  id: string;                          // e.g. 'window.create'
  label: string;                       // e.g. 'New Window'
  category: string;                    // e.g. 'Window'
  keybinding?: string;                 // e.g. 'Leader n' (display only)
  execute: () => void | Promise<void>; // the action callback
}
```

### Action Registry

All actions are registered at construction time. The palette takes a reference to `Compositor` and `InputRouter` to call their methods. Categories:

| Category | Actions |
|----------|---------|
| Window | New Window, Close Window, Toggle Maximize, Toggle Pin, Toggle Focus Layout, Focus Left/Right/Up/Down, Focus Next/Prev, Focus by Index 1-9 |
| Tab | New Tab, Close Tab, Next Tab, Previous Tab |
| Pane | Split Vertical, Split Horizontal, Close Pane, Focus Pane Left/Right/Up/Down, Cycle Pane Next/Prev |
| Layout | Toggle Grid/Focus Layout |
| Mode | Enter Resize Mode, Enter Move Mode, Enter Swap Mode, Enter Selection Mode, Enter Selection Line Mode, Enter Hint Mode |
| Terminal | Toggle Quick Terminal, Scroll Up, Scroll Down |

### Fuzzy Matching

Simple substring match (case-insensitive) on `label` and `category`. Matching characters highlighted in the result. No external dependency.

Implementation: for each action, check if query characters appear in order (subsequence match). Score by:
1. Consecutive character runs (prefer "new win" matching "New Window" over "cloNE Window")
2. Match at word boundary (prefer matching at start of words)

### Data Flow

```
1. User presses Cmd+Shift+P
2. InputRouter intercepts (global hotkey), calls commandPalette.open()
3. CommandPalette shows overlay, focuses <input>, sets mode to CommandPalette
4. SoundEngine plays 'command_palette.open'
5. User types → input event fires → filter actions → update result list
6. User presses ArrowUp/ArrowDown → navigate selection
7. User presses Enter → execute selected action
8. CommandPalette hides overlay, plays 'command_palette.execute'
9. InputRouter returns to Normal mode
10. User presses Escape → close without executing, play 'command_palette.close'
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+Shift+P` | Global (any mode) | Open/close command palette |
| `ArrowUp` / `ArrowDown` | CommandPalette mode | Navigate result list |
| `Enter` | CommandPalette mode | Execute selected action |
| `Escape` | CommandPalette mode | Close palette |

### UI Changes

DOM structure (appended to `document.body`):

```html
<div class="krypton-palette">                         <!-- fixed overlay backdrop -->
  <div class="krypton-palette__container">             <!-- centered popup -->
    <div class="krypton-palette__input-row">
      <span class="krypton-palette__prompt">></span>
      <input class="krypton-palette__input" type="text" placeholder="Type a command..." />
    </div>
    <div class="krypton-palette__results">
      <div class="krypton-palette__item krypton-palette__item--selected">
        <span class="krypton-palette__item-label">
          <mark>New</mark> <mark>Win</mark>dow         <!-- highlighted match chars -->
        </span>
        <span class="krypton-palette__item-key">Leader n</span>
      </div>
      <!-- ... more items ... -->
    </div>
  </div>
</div>
```

Key visual properties:
- Fixed overlay, `z-index: 10002` (above which-key and hints)
- Backdrop blur from theme (`--krypton-palette-blur`)
- Container: centered top-third, max 500px wide, max 400px tall results
- Results scrollable, max ~12 visible items
- Selected item highlighted with `--krypton-palette-highlight`
- Keybinding shown right-aligned in dimmed text
- Visibility toggled via `krypton-palette--visible` class

### CSS Variables (to map in theme.ts)

Add missing mappings (4 new):

| Variable | Theme field | Existing? |
|----------|------------|-----------|
| `--krypton-palette-bg` | `ui.command_palette.background` | Yes |
| `--krypton-palette-border` | `ui.command_palette.border` | Yes |
| `--krypton-palette-highlight` | `ui.command_palette.highlight_color` | Yes |
| `--krypton-palette-text` | `ui.command_palette.text_color` | **New** |
| `--krypton-palette-input-bg` | `ui.command_palette.input_background` | **New** |
| `--krypton-palette-input-text` | `ui.command_palette.input_text_color` | **New** |
| `--krypton-palette-blur` | `ui.command_palette.backdrop_blur` | **New** |

## Edge Cases

| Case | Behavior |
|------|----------|
| Open palette while Quick Terminal is visible | Works — palette overlays QT |
| Open palette from Compositor/other mode | Force-exit current mode first, then open palette |
| No matching actions | Show "No results" placeholder |
| Execute async action (e.g. createWindow) | Close palette immediately, action runs in background |
| Rapid open/close | Debounce not needed — open/close is instant toggle |
| Empty query | Show all actions grouped by category |

## Out of Scope

- Workspace switching actions (workspaces not yet implemented)
- Theme switching actions (list_themes exists but theme picker UI is separate)
- Custom user-defined palette commands
- Recently-used action sorting
- Config reload / open config file actions (can be added later)
