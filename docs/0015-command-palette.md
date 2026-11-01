# Command Palette — Implementation Spec

> Status: Implemented
> Date: 2026-03-09
> Milestone: M4 — Keyboard System & Workspaces
> Amended by: [0349](./0349-unified-search-palette-tabs.md) — the palette is now the **Commands** tab of the Search Palette, one overlay shared with Files and Grep. `src/command-palette.ts` holds only `CommandScope` (action registry, fuzzy filter, execute); the overlay, keys and DOM live in `src/search-palette.ts`, the mode is `Mode.SearchPalette`, and the styles are `.krypton-search-palette*` in `src/styles/search-palette.css`. `Tab` / `Shift+Tab` switch tabs (they used to move the selection). The Data Flow, Keybindings, UI Changes and Edge Cases below are updated to match.

## Problem

Users must memorize keybindings to perform actions. There is no discoverable, searchable interface to find and execute commands. Complex actions like unpinning a window require knowing directional focus keys to reach it first.

## Solution

Add a fuzzy-searchable command palette overlay activated by `Cmd+Shift+P`. It lists every action in Krypton with its keybinding. The user types to filter, uses arrow keys or Ctrl+N/P to navigate, and presses Enter to execute. Since spec 0349, `src/command-palette.ts` is the `CommandScope` (action registry + filter) and the overlay is the Search Palette (`src/search-palette.ts`, `Mode.SearchPalette`), opened on its Commands tab.

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
2. InputRouter intercepts (global hotkey) → toggleSearchPalette('commands'):
   hidden → searchPalette.open('commands') and Mode.SearchPalette;
   visible on Commands → close; visible on another tab → switch to Commands
3. SoundEngine plays 'command_palette.open'; CommandScope.activate() rebuilds the
   actions (Context section from the focused view first)
4. User types → 16 ms debounce → CommandScope.query() → result list
5. User presses ArrowUp/ArrowDown or Ctrl+P/Ctrl+N → navigate selection
6. User presses Enter (or Alt+1..9) → CommandScope.accept(): play 'command_palette.execute',
   close the palette (router → Normal), flashAck, run the action
7. User presses Escape → close without executing, play 'command_palette.close'
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+Shift+P` | Global (any mode) | Open the Search Palette on Commands; close it when Commands is active; switch to Commands from another tab |
| `Tab` / `Shift+Tab` | Search Palette | Next / previous tab (Commands → Files → Grep) |
| `ArrowUp` / `ArrowDown`, `Ctrl+P` / `Ctrl+N` | Search Palette | Navigate result list |
| `Enter` | Search Palette | Execute selected action |
| `Alt+1`..`Alt+9` | Search Palette | Execute the Nth visible action |
| `Ctrl+U` | Search Palette | Clear the query |
| `Escape` | Search Palette | Close palette |

### UI Changes

The overlay DOM and styles are spec 0349's: `.krypton-search-palette` with a tab strip,
one input row, one result list, a status line and a hint line. A Commands row is
`div.krypton-search-palette__row.krypton-search-palette__row--action` holding
`__category`, an optional `__swatch`, `__label` (matched characters in `<mark>`) and
`__key` (keybinding, right-aligned and dimmed).

Key visual properties:
- Fixed overlay, `z-index: 10002` (above which-key and hints), scrim `rgba(0, 0, 0, 0.35)`, no backdrop blur
- Container: centered near the top, 600px wide (max 92vw), results up to 50vh, scrollable
- Selected row highlighted; the active tab uses `--krypton-palette-highlight`
- Visibility toggled via `krypton-search-palette--visible`

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
| Open palette from Compositor/other mode | Force-exit Selection, Hint, PromptDialog, InlineAI or QuickOverview first, then open |
| No matching actions | Status line shows `no matches` |
| Execute async action (e.g. createWindow) | Close palette immediately, action runs in background |
| Rapid open/close | Debounce not needed — open/close is instant toggle |
| Empty query | Context section (focused view's actions) first, then every action in registration order |

## Out of Scope

- Workspace switching actions (workspaces not yet implemented)
- Custom user-defined palette commands
- Recently-used action sorting

Color theme switching is in-scope: each built-in and custom theme is a **Color Theme** action (`Color Theme: Legacy Radiance (active)`). Sound packs remain a separate **Sound Theme** category. **Reload Config** re-reads `krypton.toml` and reapplies theme + config.
