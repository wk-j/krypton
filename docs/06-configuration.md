# 7. Configuration File Format

Configuration is read from a TOML file at a platform-appropriate path:

| Platform | Path |
|----------|------|
| macOS | `~/.config/krypton/krypton.toml` |
| Linux | `~/.config/krypton/krypton.toml` (or `$XDG_CONFIG_HOME/krypton/krypton.toml`) |
| Windows | `%APPDATA%\krypton\krypton.toml` |

Custom themes are stored as separate TOML files:

| Platform | Path |
|----------|------|
| All | `~/.config/krypton/themes/*.toml` |

## Reference

```toml
# ~/.config/krypton/krypton.toml

# NOTE: The Tauri native shell is always fullscreen, borderless, and transparent.
# The workspace IS the full screen. There is no [window] section for the app itself.
# Individual terminal windows are positioned by workspace layouts below.

[shell]
program = "/bin/zsh"
args = ["--login"]

[font]
family = "JetBrains Mono"
size = 14.0
line_height = 1.2
ligatures = true

[terminal]
scrollback_lines = 10000
cursor_style = "block"       # block | underline | bar
cursor_blink = true

[theme]
name = "krypton-dark"        # built-in or custom theme name
# Custom themes: place .toml files in ~/.config/krypton/themes/
# e.g., ~/.config/krypton/themes/my-custom.toml -> name = "my-custom"

# Inline overrides (applied on top of the named theme):
[theme.colors]
foreground = "#c0c5ce"
background = "#1b2b34"
cursor = "#c0c5ce"
selection = "#4f5b66"
black = "#1b2b34"
red = "#ec5f67"
green = "#99c794"
yellow = "#fac863"
blue = "#6699cc"
magenta = "#c594c5"
cyan = "#5fb3b3"
white = "#c0c5ce"
bright_black = "#65737e"
bright_red = "#ec5f67"
bright_green = "#99c794"
bright_yellow = "#fac863"
bright_blue = "#6699cc"
bright_magenta = "#c594c5"
bright_cyan = "#5fb3b3"
bright_white = "#ffffff"

# --- Keybindings ---
# Every action in Krypton has a keybinding. All are configurable.

[keybindings]

# Leader key — enters compositor mode
leader = "Ctrl+Space"

# Command palette
command_palette = "CmdOrCtrl+Shift+P"

# Global (work in any mode)
workspace_1 = "CmdOrCtrl+1"
workspace_2 = "CmdOrCtrl+2"
workspace_3 = "CmdOrCtrl+3"
workspace_next = "CmdOrCtrl+]"
workspace_prev = "CmdOrCtrl+["

# Tab management
new_tab = "CmdOrCtrl+T"
close_tab = "CmdOrCtrl+W"
next_tab = "CmdOrCtrl+Shift+]"
prev_tab = "CmdOrCtrl+Shift+["
tab_1 = "CmdOrCtrl+Alt+1"
tab_2 = "CmdOrCtrl+Alt+2"
tab_3 = "CmdOrCtrl+Alt+3"
move_tab_to_window = "Leader T"    # then window index

# Window management (via leader key sequences)
new_window = "Leader N"
close_window = "Leader X"
maximize_window = "Leader F"
resize_mode = "Leader R"           # enter resize mode
move_mode = "Leader M"             # enter move mode
swap_window = "Leader S"           # then target window index
reset_layout = "Leader ="

# Window focus navigation
focus_left = "Leader H"
focus_down = "Leader J"
focus_up = "Leader K"
focus_right = "Leader L"
focus_next = "Leader N"
focus_prev = "Leader P"
focus_window_1 = "Leader 1"
focus_window_2 = "Leader 2"
focus_window_3 = "Leader 3"

# Pane splits
split_horizontal = "CmdOrCtrl+Shift+H"
split_vertical = "CmdOrCtrl+Shift+V"

# Clipboard
copy = "CmdOrCtrl+C"
paste = "CmdOrCtrl+V"

# Search
search = "CmdOrCtrl+F"
search_next = "CmdOrCtrl+G"
search_prev = "CmdOrCtrl+Shift+G"

# Resize mode keys (active only in resize mode)
[keybindings.resize_mode]
grow_right = "Right"
shrink_left = "Left"
grow_down = "Down"
shrink_up = "Up"
step_large = "Shift+Arrow"        # larger step
confirm = "Enter"
cancel = "Escape"

# Move mode keys (active only in move mode)
[keybindings.move_mode]
move_right = "Right"
move_left = "Left"
move_down = "Down"
move_up = "Up"
step_large = "Shift+Arrow"
confirm = "Enter"
cancel = "Escape"

# --- Workspaces ---
# Each workspace is a virtual desktop containing arranged terminal windows.

[workspaces]
startup = "coding"           # workspace to activate on launch
gap = 8                      # pixel gap between tiled windows
padding = 8                  # inner margin of the workspace
resize_step = 20             # pixels per arrow key press in resize mode
move_step = 20               # pixels per arrow key press in move mode
resize_step_large = 100      # pixels per Shift+Arrow in resize mode
move_step_large = 100        # pixels per Shift+Arrow in move mode

# Built-in presets (single, 2-column, 3-column, 2x2-grid, main+sidebar,
# main+bottom) are always available. User definitions below can override them.

[[workspaces.layouts]]
name = "coding"
grid = { cols = 3, rows = 1 }

  [[workspaces.layouts.windows]]
  label = "editor"
  col = 0
  row = 0
  col_span = 2
  row_span = 1
  shell = "/bin/zsh"
  cwd = "~/projects"

  [[workspaces.layouts.windows]]
  label = "terminal"
  col = 2
  row = 0
  col_span = 1
  row_span = 1

[[workspaces.layouts]]
name = "monitoring"
grid = { cols = 2, rows = 2 }

  [[workspaces.layouts.windows]]
  label = "logs"
  col = 0
  row = 0
  col_span = 1
  row_span = 1
  shell = "/bin/zsh"
  args = ["-c", "tail -f /var/log/system.log"]

  [[workspaces.layouts.windows]]
  label = "htop"
  col = 1
  row = 0
  col_span = 1
  row_span = 1
  shell = "/usr/bin/htop"

  [[workspaces.layouts.windows]]
  label = "network"
  col = 0
  row = 1
  col_span = 2
  row_span = 1

# Absolute positioning override example
[[workspaces.layouts]]
name = "custom-fixed"

  [[workspaces.layouts.windows]]
  label = "main"
  x = 100
  y = 100
  width = 1200
  height = 800

  [[workspaces.layouts.windows]]
  label = "side"
  x = 1320
  y = 100
  width = 500
  height = 800
```

## Section Reference

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[shell]` | `program` | string | System default | Shell binary path |
| `[shell]` | `args` | string[] | `[]` | Arguments passed to shell |
| `[font]` | `family` | string | `"monospace"` | Font family name |
| `[font]` | `size` | float | `14.0` | Font size in points |
| `[font]` | `line_height` | float | `1.2` | Line height multiplier |
| `[font]` | `ligatures` | bool | `true` | Enable font ligatures |
| `[terminal]` | `scrollback_lines` | int | `10000` | Scrollback buffer size |
| `[terminal]` | `cursor_style` | string | `"block"` | `block`, `underline`, or `bar` |
| `[terminal]` | `cursor_blink` | bool | `true` | Enable cursor blinking |
| `[theme]` | `name` | string | `"krypton-dark"` | Built-in or custom theme name |
| `[theme.colors]` | *(various)* | string | — | Hex color overrides (applied on top of named theme) |
| `[keybindings]` | `leader` | string | `"Ctrl+Space"` | Leader key to enter compositor mode |
| `[keybindings]` | `command_palette` | string | `"CmdOrCtrl+Shift+P"` | Open command palette |
| `[keybindings]` | *(various)* | string | — | See full keybinding reference in TOML example above |
| `[keybindings.resize_mode]` | *(various)* | string | — | Keys active in resize mode |
| `[keybindings.move_mode]` | *(various)* | string | — | Keys active in move mode |

### Workspace Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[workspaces]` | `startup` | string | `"single"` | Workspace to activate on launch |
| `[workspaces]` | `gap` | int | `0` | Pixel gap between tiled windows |
| `[workspaces]` | `padding` | int | `0` | Inner margin of the workspace |
| `[workspaces]` | `resize_step` | int | `20` | Pixels per arrow key press in resize mode |
| `[workspaces]` | `move_step` | int | `20` | Pixels per arrow key press in move mode |
| `[workspaces]` | `resize_step_large` | int | `100` | Pixels per Shift+Arrow in resize mode |
| `[workspaces]` | `move_step_large` | int | `100` | Pixels per Shift+Arrow in move mode |
| `[[workspaces.layouts]]` | `name` | string | *required* | Unique workspace name |
| `[[workspaces.layouts]]` | `grid` | object | — | Grid definition `{ cols, rows }` (omit for absolute positioning) |
| `[[workspaces.layouts.windows]]` | `label` | string | — | Human-readable window label |
| `[[workspaces.layouts.windows]]` | `col` | int | — | Grid column (0-indexed) |
| `[[workspaces.layouts.windows]]` | `row` | int | — | Grid row (0-indexed) |
| `[[workspaces.layouts.windows]]` | `col_span` | int | `1` | Number of grid columns to span |
| `[[workspaces.layouts.windows]]` | `row_span` | int | `1` | Number of grid rows to span |
| `[[workspaces.layouts.windows]]` | `x` | int | — | Absolute X position in pixels (overrides grid) |
| `[[workspaces.layouts.windows]]` | `y` | int | — | Absolute Y position in pixels (overrides grid) |
| `[[workspaces.layouts.windows]]` | `width` | int | — | Absolute width in pixels (overrides grid) |
| `[[workspaces.layouts.windows]]` | `height` | int | — | Absolute height in pixels (overrides grid) |
| `[[workspaces.layouts.windows]]` | `shell` | string | Default shell | Shell binary for this window |
| `[[workspaces.layouts.windows]]` | `args` | string[] | `[]` | Shell arguments |
| `[[workspaces.layouts.windows]]` | `cwd` | string | `$HOME` | Working directory |
