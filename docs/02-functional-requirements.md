# 3. Functional Requirements

## 3.1 Shell & PTY Management

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-PTY-001 | The system shall spawn a PTY and attach it to the user's default shell. | Must |
| FR-PTY-002 | The system shall support configuring a custom shell binary and arguments. | Must |
| FR-PTY-003 | The system shall detect shell exit and display an exit status indicator. | Must |
| FR-PTY-004 | The system shall support sending signals (SIGINT, SIGTSTP, etc.) to the child process. | Must |
| FR-PTY-005 | The system shall handle PTY resize events when the terminal viewport changes. | Must |
| FR-PTY-006 | On Windows, the system shall use ConPTY for pseudoterminal support. | Must |

## 3.2 Terminal Emulation

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-VT-001 | The system shall support VT100/VT220/xterm escape sequence rendering via xterm.js. | Must |
| FR-VT-002 | The system shall support SGR (Select Graphic Rendition) attributes: bold, italic, underline, strikethrough, dim, blink, reverse, hidden. | Must |
| FR-VT-003 | The system shall support 4-bit, 8-bit (256), and 24-bit (truecolor) color modes. | Must |
| FR-VT-004 | The system shall support alternate screen buffer (used by vim, less, htop, etc.). | Must |
| FR-VT-005 | The system shall implement cursor positioning, scrolling regions, and line editing sequences. | Must |
| FR-VT-006 | The system shall support OSC sequences for setting window/tab title. | Should |
| FR-VT-007 | The system shall support bracketed paste mode. | Should |
| FR-VT-008 | The system shall support mouse reporting (X10, SGR, UTF-8 modes). | Should |

## 3.3 Rendering & Display

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-RND-001 | The system shall render terminal output as a scrollable grid of monospaced character cells. | Must |
| FR-RND-002 | The system shall support configurable font family, font size, and line height. | Must |
| FR-RND-003 | The system shall support emoji and full Unicode (including CJK wide characters). | Must |
| FR-RND-004 | The system shall render ligatures if the selected font supports them. | Should |
| FR-RND-005 | The system shall provide a configurable scrollback buffer (default: 10,000 lines). | Must |
| FR-RND-006 | The system shall support cursor styles: block, underline, bar (blinking and steady variants). | Must |

## 3.4 Tabs & Panes

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-TAB-001 | The system shall support multiple tabs within each window, each running an independent shell session. | Must |
| FR-TAB-002 | The system shall support splitting a tab into horizontal and vertical panes within a window. | Should |
| FR-TAB-003 | All tab/pane operations (create, close, navigate, reorder, move) shall be accessible via keyboard shortcuts. | Must |
| FR-TAB-004 | The system shall support reordering tabs via keybinding (primary) and optionally via mouse drag-and-drop (secondary). | Should |
| FR-TAB-005 | The system shall support moving a tab between windows via keybinding. | Should |

## 3.5 Input Handling

> **Core Principle:** Every feature in Krypton must be fully operable via keyboard.
> The mouse is a secondary, optional input method. All requirements below reflect this.

### 3.5.1 Keyboard-First Constraint

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-INP-001 | **Every feature** in the application shall have a corresponding keyboard-accessible action (keybinding, command palette entry, or keyboard shortcut sequence). No functionality shall be mouse-only. | Must |
| FR-INP-002 | The system shall support a **leader key** (configurable, default: `Ctrl+Space`) that activates compositor mode, where subsequent keypresses control windows/workspaces instead of being sent to the PTY. | Must |
| FR-INP-003 | The system shall support a **command palette** (triggered via keybinding, default: `CmdOrCtrl+Shift+P`) that lists all available actions, filterable by typing. | Must |
| FR-INP-004 | The system shall support configurable keybindings for all actions via the configuration file. | Must |

### 3.5.2 Terminal Input

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-INP-010 | The system shall forward keyboard input to the focused window's active PTY session when not in compositor mode. | Must |
| FR-INP-011 | The system shall support IME (Input Method Editor) for CJK text entry. | Should |
| FR-INP-012 | The system shall support clipboard copy/paste (Cmd+C/Cmd+V on macOS, Ctrl+Shift+C/V on Linux/Windows). | Must |
| FR-INP-013 | The system shall support text selection via keyboard (Shift+Arrow, Shift+Home/End, Shift+Ctrl+Arrow for word selection). | Must |
| FR-INP-014 | The system shall optionally support text selection via mouse click-drag as a secondary input method. | Should |
| FR-INP-015 | The system shall support URL detection and opening links via keyboard (select URL + keybinding to open). | Must |
| FR-INP-016 | The system shall optionally support Cmd/Ctrl+Click to open links as a secondary mouse input method. | Should |

### 3.5.3 Window Navigation (Keyboard)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-INP-020 | The system shall support cycling focus between windows via keybinding (e.g., `Leader` then `H/J/K/L` for directional, or `Leader` then `N/P` for next/previous). | Must |
| FR-INP-021 | The system shall support focusing a window by index via keybinding (e.g., `Leader` then `1/2/3`). | Must |
| FR-INP-022 | The system shall display a visual focus indicator (border highlight, glow) on the currently focused window. | Must |

### 3.5.4 Window Management (Keyboard)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-INP-030 | The system shall support creating a new window in the current workspace via keybinding. | Must |
| FR-INP-031 | The system shall support closing the focused window via keybinding. | Must |
| FR-INP-032 | The system shall support **resizing** the focused window via keyboard (e.g., `Leader+R` to enter resize mode where arrow keys adjust size). | Must |
| FR-INP-033 | The system shall support **moving** the focused window via keyboard (e.g., `Leader+M` to enter move mode where arrow keys reposition the window). | Must |
| FR-INP-034 | The system shall support **maximizing** the focused window (expand to fill workspace) and restoring via keybinding. | Must |
| FR-INP-035 | The system shall support **swapping** two windows' positions via keybinding (e.g., `Leader+S` then select target window). | Should |
| FR-INP-036 | The system shall support resetting the current workspace to its default layout via keybinding. | Should |

### 3.5.5 Tab Navigation (Keyboard)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-INP-040 | The system shall support creating a new tab in the focused window via keybinding. | Must |
| FR-INP-041 | The system shall support closing the active tab via keybinding. | Must |
| FR-INP-042 | The system shall support switching tabs via keybinding (next/previous tab, or tab by index). | Must |
| FR-INP-043 | The system shall support moving a tab to another window via keybinding (e.g., `Leader+T` then target window index). | Should |

### 3.5.6 Workspace Switching (Keyboard)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-INP-050 | The system shall support switching to a workspace by index via keybinding (e.g., `CmdOrCtrl+1/2/3`). | Must |
| FR-INP-051 | The system shall support switching to next/previous workspace via keybinding. | Must |
| FR-INP-052 | The system shall support switching to a workspace by name via the command palette. | Must |

## 3.6 Configuration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-CFG-001 | The system shall read configuration from a TOML file at a platform-appropriate path (e.g., `~/.config/krypton/krypton.toml`). | Must |
| FR-CFG-002 | The system shall support hot-reloading of configuration changes without restart. | Should |
| FR-CFG-003 | The system shall support theming: foreground, background, cursor, selection, and ANSI color palette (16 colors). | Must |
| FR-CFG-004 | The system shall ship with at least 3 built-in color themes. | Should |
| FR-CFG-005 | The system shall support environment variable overrides in the config. | Could |
| FR-CFG-006 | The system shall support **user-defined custom themes** as separate TOML files in a themes directory (e.g., `~/.config/krypton/themes/`). | Must |
| FR-CFG-007 | The system shall support loading third-party themes by placing a `.toml` file in the themes directory. | Must |

## 3.7 Search

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-SRC-001 | The system shall support searching scrollback buffer text with a search overlay. | Should |
| FR-SRC-002 | The system shall support regex search mode. | Could |
| FR-SRC-003 | The system shall highlight all matches and allow navigating between them. | Should |

## 3.8 Workspace & Window System

### 3.8.1 Workspace (Desktop)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-WS-001 | The application shall run as a single fullscreen, borderless, fully transparent Tauri native shell. The active workspace fills this transparent surface — acting as a virtual desktop. | Must |
| FR-WS-002 | A workspace is a full-screen virtual desktop that contains and arranges multiple terminal windows. | Must |
| FR-WS-003 | The system shall support multiple named workspaces. Only one workspace is visible at a time. | Must |
| FR-WS-004 | The system shall support a startup workspace that is applied when Krypton launches. | Must |
| FR-WS-005 | The system shall support named workspace definitions in the TOML configuration file. | Must |
| FR-WS-006 | The system shall ship with built-in workspace presets: `single`, `2-column`, `3-column`, `2x2-grid`, `main+sidebar`, `main+bottom`. | Must |
| FR-WS-007 | User-defined workspaces in config shall override built-in presets of the same name. | Must |

### 3.8.2 Windows (Terminal Instances)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-WIN-001 | Each window is a DOM element rendered inside the active workspace — not a native OS window. | Must |
| FR-WIN-002 | Each window shall have its own xterm.js instance, tab bar, and PTY session(s). | Must |
| FR-WIN-003 | Each window shall render fully custom chrome (title bar, border, shadow, control buttons). | Must |
| FR-WIN-004 | The compositor shall manage window z-order, focus state, and input routing. | Must |
| FR-WIN-005 | Only one window shall be "focused" at a time; keyboard input routes to the focused window's active PTY. | Must |
| FR-WIN-006 | The system shall support creating new windows via keybinding. | Must |
| FR-WIN-007 | The system shall support closing windows; closing the last window in the last workspace shall terminate the application. | Must |
| FR-WIN-008 | Windows shall be movable via keyboard (primary) and optionally via mouse drag on title bar (secondary). | Must |
| FR-WIN-009 | Windows shall be resizable via keyboard (primary) and optionally via mouse drag on edges/corners (secondary). | Must |

### 3.8.3 Layout Positioning

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-WS-020 | Each workspace definition shall specify a list of windows with layout properties. | Must |
| FR-WS-021 | The system shall support a **grid/tile positioning model** where windows are placed by proportional column/row spans within the workspace. | Must |
| FR-WS-022 | The system shall support **absolute pixel positioning** as an override (`x`, `y`, `width`, `height` relative to the workspace). | Should |
| FR-WS-023 | Grid positions shall be defined as `{ col, row, col_span, row_span }` within an `N x M` grid. | Must |
| FR-WS-024 | The workspace fills the full screen; window positions are calculated from the screen dimensions and the grid definition. | Must |
| FR-WS-025 | The system shall recalculate window positions if screen resolution changes. | Must |
| FR-WS-026 | The system shall support a `gap` property (in pixels) for spacing between tiled windows. | Should |
| FR-WS-027 | The system shall support a `padding` property for inner margins of the workspace. | Should |
| FR-WS-028 | Each window in a workspace may optionally specify a shell command, working directory, or profile to auto-launch. | Should |

### 3.8.4 Workspace Switching

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-WS-030 | The system shall support switching between workspaces at runtime via configurable hotkeys. | Must |
| FR-WS-031 | Switching workspaces shall transition from the current desktop to the target desktop with an animated transition. | Must |
| FR-WS-032 | Switching workspaces shall create new windows if the target workspace has more windows than currently exist, and hide excess windows if it has fewer. | Must |
| FR-WS-033 | The system shall preserve PTY sessions across workspace switches — no shell restart. | Must |
| FR-WS-034 | Windows hidden by a workspace switch shall keep their PTY sessions alive in the session pool. | Must |

### 3.8.5 Built-in Workspace Presets

| Preset Name | Description | Grid |
|-------------|-------------|------|
| `single` | One full-screen window | 1x1 |
| `2-column` | Two windows side by side, equal width | 2x1 |
| `3-column` | Three windows side by side, equal width | 3x1 |
| `2x2-grid` | Four windows in a 2x2 grid | 2x2 |
| `main+sidebar` | Large window (2/3) on left, narrow window (1/3) on right | 3x1 (main spans 2 cols) |
| `main+bottom` | Large window (2/3 height) on top, short window (1/3) on bottom | 1x3 (main spans 2 rows) |

## 3.9 Window Chrome

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-CHR-001 | Each window shall render a custom title bar at the top containing the window label and/or active tab name. | Must |
| FR-CHR-002 | Each window shall render custom control buttons (close, minimize/collapse, maximize/expand). | Must |
| FR-CHR-003 | The window border style (width, color, radius, shadow) shall be fully configurable via the theme. | Must |
| FR-CHR-004 | The title bar style (height, background, font, text alignment) shall be fully configurable via the theme. | Must |
| FR-CHR-005 | The control buttons style (shape, color, size, icon) shall be fully configurable via the theme. | Must |
| FR-CHR-006 | The focused window shall have a visually distinct border/shadow to indicate active state. | Must |
| FR-CHR-007 | The system shall ship with at least 3 built-in chrome styles: `macos` (traffic light buttons, frosted bar), `minimal` (thin border, small controls), `none` (borderless, no chrome). | Should |
| FR-CHR-008 | Windows shall be focusable via keyboard navigation (primary) and optionally via mouse click on title bar (secondary). | Must |
| FR-CHR-009 | Windows shall support maximize toggle via keybinding (primary) and optionally via double-click on title bar (secondary). | Should |
| FR-CHR-010 | The tab bar shall be integrated below the title bar within the window chrome. | Must |

## 3.10 Layout Transition Animations

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-ANI-001 | The system shall support animated transitions when switching between workspaces. | Must |
| FR-ANI-002 | The system shall provide the following built-in animation styles: `slide` (horizontal slide like macOS Spaces), `crossfade` (opacity fade between workspaces), `morph` (each window animates from current to target position/size). | Must |
| FR-ANI-003 | The animation style shall be configurable per-workspace or globally in the TOML config. | Must |
| FR-ANI-004 | The animation duration shall be configurable (default: 300ms). | Must |
| FR-ANI-005 | The animation easing function shall be configurable (default: `ease-in-out`). Options: `linear`, `ease-in`, `ease-out`, `ease-in-out`, `spring`. | Should |
| FR-ANI-006 | Animations shall be disableable (set `animation = "none"` or `duration = 0`). | Must |
| FR-ANI-007 | During a transition animation, keyboard input shall be buffered and delivered to the target workspace's focused window after the transition completes. | Should |
| FR-ANI-008 | Window creation (on workspace switch or manual) shall animate with a configurable entrance effect (e.g., `fade-in`, `scale-up`, `slide-in`). | Should |
| FR-ANI-009 | Window close shall animate with a configurable exit effect (e.g., `fade-out`, `scale-down`, `slide-out`). | Should |
| FR-ANI-010 | The system shall maintain 60 FPS during all transition animations. | Must |

## 3.11 Custom Themes

### 3.11.1 Theme System

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-001 | The system shall support a **theme file format** (TOML) that defines all visual properties of the application. | Must |
| FR-THM-002 | Themes shall be loadable from: (a) built-in presets, (b) user's themes directory (`~/.config/krypton/themes/*.toml`), or (c) inline in the main config. | Must |
| FR-THM-003 | The system shall ship with at least 3 built-in themes: `krypton-dark`, `krypton-light`, `solarized`. | Must |
| FR-THM-004 | Hot-reloading of themes shall be supported — changes to theme files apply immediately without restart. | Should |
| FR-THM-005 | The command palette shall list all available themes and allow switching at runtime via keyboard. | Must |

### 3.11.2 Theme Scope — Terminal Colors

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-010 | A theme shall define terminal foreground, background, cursor, and selection colors. | Must |
| FR-THM-011 | A theme shall define the full ANSI 16-color palette (black, red, green, yellow, blue, magenta, cyan, white, and their bright variants). | Must |
| FR-THM-012 | A theme may optionally define the 256-color palette overrides. | Could |

### 3.11.3 Theme Scope — Window Chrome

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-020 | A theme shall define the window chrome style: border width, border color, border radius, and box shadow. | Must |
| FR-THM-021 | A theme shall define the title bar style: height, background color/gradient, text color, font size, and text alignment. | Must |
| FR-THM-022 | A theme shall define the control buttons: shape (`circle`, `square`, `icon`), colors (normal, hover, active), size, and spacing. | Must |
| FR-THM-023 | A theme shall define distinct styles for **focused** vs. **unfocused** window chrome (e.g., brighter border, stronger shadow for focused). | Must |
| FR-THM-024 | A theme shall define the tab bar style: background, active tab color, inactive tab color, tab height, tab font. | Must |

### 3.11.4 Theme Scope — Workspace Background

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-030 | The workspace background shall be fully transparent by default (showing the OS desktop beneath). | Must |
| FR-THM-031 | A theme may optionally define a workspace background color or image with configurable opacity (overlay on the transparent surface). | Should |
| FR-THM-032 | A theme may define a workspace-level blur effect (vibrancy/frosted glass) applied to the transparent background behind windows. | Could |

### 3.11.5 Theme Scope — UI Elements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-040 | A theme shall define command palette styles: background, text color, border, highlight color for selected item, input field style. | Must |
| FR-THM-041 | A theme shall define search overlay styles: background, text color, match highlight color. | Must |
| FR-THM-042 | A theme shall define mode indicator styles: badge background, text color, position. | Must |
| FR-THM-043 | A theme shall define window shadow properties: color, blur, spread, offset (supports casting shadows on the transparent desktop). | Must |
