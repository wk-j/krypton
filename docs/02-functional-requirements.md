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
| FR-VT-009 | The system shall support ConEmu `OSC 9;4` progress bar sequences (states: remove, normal, error, indeterminate, paused) and display a native GUI progress indicator integrated into the window chrome. | Should |

## 3.3 Rendering & Display

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-RND-001 | The system shall render terminal output as a scrollable grid of monospaced character cells. | Must |
| FR-RND-002 | The system shall support configurable font family, font size, and line height. | Must |
| FR-RND-003 | The system shall support emoji and full Unicode (including CJK wide characters). | Must |
| FR-RND-004 | The system shall render ligatures if the selected font supports them. | Should |
| FR-RND-005 | The system shall provide a configurable scrollback buffer (default: 10,000 lines). | Must |
| FR-RND-006 | The system shall support cursor styles: block, underline, bar (blinking and steady variants). | Must |
| FR-RND-007 | The system shall support keyboard scrolling of the scrollback buffer via `Ctrl+Shift+U` (page up) and `Ctrl+Shift+D` (page down). `Shift+PageUp`/`Shift+PageDown` shall also work as built-in defaults. | Must |

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
| FR-INP-015 | The system shall support URL detection and opening links via keyboard hint mode — activate with `Cmd+Shift+H` or `Leader Shift+H`, scan visible buffer for regex patterns, overlay keyboard labels, type label to act. | Must |
| FR-INP-016 | The system shall optionally support Cmd/Ctrl+Click to open links as a secondary mouse input method. | Should |
| FR-INP-017 | Hint mode shall support configurable regex patterns with per-rule actions (Copy, Open, Paste) and a configurable label alphabet. Built-in patterns: URLs, file paths, emails. | Must |

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
| FR-INP-037 | The system shall support toggling a **focus layout** (`Leader+F`) where the focused window occupies the left column at full height and remaining windows stack vertically on the right. Changing focus swaps the newly focused window to the left column. New windows replace the current left window, pushing it to the stack. Toggling again returns to the default grid layout. | Should |

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
| FR-WIN-010 | The system shall support **pinning** a window via keybinding (`Leader p` toggle). A pinned window sticks to the right column in Focus layout and is skipped during focus cycling (`Cmd+Shift+</>`) but can receive focus via click or directional navigation. | Should |
| FR-WIN-011 | Pinned windows shall display a visual indicator (icon in title bar) distinguishing them from unpinned windows. | Should |
| FR-WIN-012 | Pin state shall only affect Focus layout; in Grid layout pinned windows tile normally. | Should |

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

## 3.10 Quick Terminal

The **Quick Terminal** is a fast-access, overlay terminal window that floats centered on the screen above the current workspace. It is toggled with a single global hotkey (`Cmd+I`) and is designed for running quick commands without disrupting the workspace layout. It is conceptually similar to a dropdown/quake-style terminal but centered rather than anchored to a screen edge.

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-QT-001 | The system shall provide a **Quick Terminal** — a single, persistent terminal window that overlays the active workspace, centered on screen. | Must |
| FR-QT-002 | The Quick Terminal shall be toggled (shown/hidden) via a global hotkey (default: `Cmd+I`). The hotkey shall work from any input mode (Normal, Compositor, Resize, Move, Swap). | Must |
| FR-QT-003 | The Quick Terminal shall be centered horizontally and vertically on screen, sized to approximately 60% of screen width and 50% of screen height. Size shall be configurable. | Must |
| FR-QT-004 | The Quick Terminal shall render above all workspace windows at the highest z-order. It shall use the same cyberpunk chrome style as regular windows, with a distinct label (e.g., `QUICK_TERMINAL`). | Must |
| FR-QT-005 | When the Quick Terminal is shown, it shall immediately receive keyboard focus. All keyboard input routes to the Quick Terminal's PTY in Normal mode. | Must |
| FR-QT-006 | When the Quick Terminal is hidden, focus shall return to the previously focused workspace window. The Quick Terminal's PTY session shall remain alive in the background. | Must |
| FR-QT-007 | The Quick Terminal shall animate on show/hide — slide-down + fade-in on show, slide-up + fade-out on hide (using the animation engine). | Should |
| FR-QT-008 | The Quick Terminal shall have its own independent PTY session that persists across show/hide cycles and workspace switches. | Must |
| FR-QT-009 | The Quick Terminal shall not participate in workspace layout (grid/focus tiling). It is always an overlay, never tiled. | Must |
| FR-QT-010 | The Quick Terminal's backdrop shall have a stronger blur effect than regular windows to visually separate it from the workspace beneath. | Should |
| FR-QT-011 | Pressing `Escape` while the Quick Terminal is focused and in Normal mode shall hide the Quick Terminal (same as pressing `Cmd+I` again). | Should |
| FR-QT-012 | The Quick Terminal size and position shall be configurable via the TOML config (`[quick_terminal]` section). | Should |

## 3.11 Layout Transition Animations (Implemented)

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

## 3.12 Configuration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-CFG-001 | The system shall read configuration from a TOML file at `~/.config/krypton/krypton.toml`. | Must |
| FR-CFG-002 | If the config file does not exist on startup, the system shall create the directory and write a default config file. | Must |
| FR-CFG-003 | Missing config fields shall fall back to built-in defaults (partial configs are valid). | Must |
| FR-CFG-004 | If the config file fails to parse, the system shall log a warning and start with defaults. | Must |
| FR-CFG-005 | The config shall support the following sections: `[shell]`, `[font]`, `[terminal]`, `[theme]`, `[quick_terminal]`, `[workspaces]`. | Must |
| FR-CFG-006 | Shell program and arguments shall be configurable and used when spawning PTY sessions. | Must |
| FR-CFG-007 | Font family, size, and line height shall be configurable and applied to all terminal instances. | Must |
| FR-CFG-008 | Terminal scrollback lines, cursor style, and cursor blink shall be configurable. | Must |
| FR-CFG-009 | Theme color overrides (ANSI 16 colors, foreground, background, cursor, selection) shall be configurable inline under `[theme.colors]`. | Must |
| FR-CFG-010 | Quick Terminal width ratio, height ratio, and backdrop blur shall be configurable under `[quick_terminal]`. | Should |

## 3.13 Custom Themes

### 3.13.1 Theme System

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-001 | The system shall support a **theme file format** (TOML) that defines all visual properties of the application. | Must |
| FR-THM-002 | Themes shall be loadable from: (a) built-in presets, (b) user's themes directory (`~/.config/krypton/themes/*.toml`), or (c) inline in the main config. | Must |
| FR-THM-003 | The system shall ship with at least 4 built-in themes: `krypton-dark`, `krypton-light`, `solarized`, `legacy-radiance`. | Must |
| FR-THM-004 | Hot-reloading of themes shall be supported — changes to theme files apply immediately without restart. | Should |
| FR-THM-005 | The command palette shall list all available themes and allow switching at runtime via keyboard. | Must |

### 3.13.2 Theme Scope — Terminal Colors

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-010 | A theme shall define terminal foreground, background, cursor, and selection colors. | Must |
| FR-THM-011 | A theme shall define the full ANSI 16-color palette (black, red, green, yellow, blue, magenta, cyan, white, and their bright variants). | Must |
| FR-THM-012 | A theme may optionally define the 256-color palette overrides. | Could |

### 3.13.3 Theme Scope — Window Chrome

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-020 | A theme shall define the window chrome style: border width, border color, border radius, and box shadow. | Must |
| FR-THM-021 | A theme shall define the title bar style: height, background color/gradient, text color, font size, and text alignment. | Must |
| FR-THM-022 | A theme shall define the control buttons: shape (`circle`, `square`, `icon`), colors (normal, hover, active), size, and spacing. | Must |
| FR-THM-023 | A theme shall define distinct styles for **focused** vs. **unfocused** window chrome (e.g., brighter border, stronger shadow for focused). | Must |
| FR-THM-024 | A theme shall define the tab bar style: background, active tab color, inactive tab color, tab height, tab font. | Must |

### 3.13.4 Theme Scope — Workspace Background

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-030 | The workspace background shall be fully transparent by default (showing the OS desktop beneath). | Must |
| FR-THM-031 | A theme may optionally define a workspace background color or image with configurable opacity (overlay on the transparent surface). | Should |
| FR-THM-032 | A theme may define a workspace-level blur effect (vibrancy/frosted glass) applied to the transparent background behind windows. | Could |

### 3.13.5 Theme Scope — UI Elements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-THM-040 | A theme shall define command palette styles: background, text color, border, highlight color for selected item, input field style. | Must |
| FR-THM-041 | A theme shall define search overlay styles: background, text color, match highlight color. | Must |
| FR-THM-042 | A theme shall define mode indicator styles: badge background, text color, position. | Must |
| FR-THM-043 | A theme shall define window shadow properties: color, blur, spread, offset (supports casting shadows on the transparent desktop). | Must |

## 3.14 Sound Effects

Krypton provides a procedural sound effects system inspired by Opera GX's browser sounds. All sounds are synthesized at runtime in the browser using the **Web Audio API** — no audio files are shipped. Sounds are generated via **additive and subtractive functional synthesis**: tones are built by summing sine/square/sawtooth/triangle oscillators at harmonic and inharmonic frequencies (additive), then shaped by filters that remove frequency bands (subtractive), combined with amplitude envelopes (ADSR) and effects (reverb, delay, distortion). This produces short, precise, sci-fi feedback sounds that match the cyberpunk aesthetic.

### 3.14.1 Sound Engine — Synthesis Architecture

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-SFX-001 | The system shall synthesize all sound effects at runtime using the **Web Audio API**. No pre-recorded audio files shall be shipped or required. | Must |
| FR-SFX-002 | The system shall use **additive synthesis** — building timbres by summing multiple oscillator partials (fundamentals + harmonics) with individually controllable amplitudes, frequencies, and detuning. | Must |
| FR-SFX-003 | The system shall use **subtractive synthesis** — shaping the additive signal through configurable filters (lowpass, highpass, bandpass, notch) with controllable cutoff frequency, resonance (Q), and time-varying filter envelopes. | Must |
| FR-SFX-004 | The system shall support the following oscillator waveforms: `sine`, `square`, `sawtooth`, `triangle`. | Must |
| FR-SFX-005 | Each sound shall be defined as a **patch** — a declarative data structure specifying oscillators (waveform, frequency, amplitude, detune), filters (type, cutoff, Q, envelope), amplitude envelope (ADSR: attack, decay, sustain, release), and optional effects (reverb, delay, distortion, bitcrusher). | Must |
| FR-SFX-006 | The system shall support **frequency modulation (FM)** between oscillators within a patch — one oscillator's output modulates another's frequency for metallic/bell-like timbres. | Should |
| FR-SFX-007 | The system shall support **noise generators** (white noise, pink noise) as source oscillators for percussive/transient sounds (clicks, static bursts, impacts). | Must |
| FR-SFX-008 | The system shall support **pitch envelopes** — time-varying pitch sweeps (e.g., downward sweep for a "drop" effect, upward sweep for "rise"). | Should |
| FR-SFX-009 | The system shall reuse a single `AudioContext` instance across all sound playback to avoid resource leaks. The context shall be lazily initialized on the first user interaction (to comply with browser autoplay policies). | Must |

### 3.14.2 Sound Events — Action-to-Sound Mapping

Each user action in Krypton triggers a corresponding sound event. The mapping is configurable.

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-SFX-010 | The system shall play a sound effect on the following compositor events: window create, window close, window focus change, window maximize, window restore. | Must |
| FR-SFX-011 | The system shall play a sound effect on the following mode events: enter compositor mode (leader key), enter resize mode, enter move mode, enter swap mode, exit to normal mode. | Must |
| FR-SFX-012 | The system shall play a sound effect on the following layout events: toggle focus layout, swap windows, resize step, move step. | Should |
| FR-SFX-013 | The system shall play a sound effect on the following Quick Terminal events: show, hide. | Must |
| FR-SFX-014 | The system shall play a sound effect on the following UI events: command palette open, command palette close, command palette execute action, which-key popup shown. | Should |
| FR-SFX-015 | The system shall play a sound effect on the following workspace events: workspace switch. | Must |
| FR-SFX-016 | The system shall play a sound effect on the following terminal events: shell exit (Ctrl+D), bell character (BEL / `\x07`). | Should |
| FR-SFX-017 | The system shall play a sound effect on application startup (a short boot/power-on sequence). | Should |
| FR-SFX-018 | The system shall play synthesized keypress sounds (key-down press + key-up release) on each keystroke sent to the terminal PTY. Sounds are randomized slightly per-keypress for a natural feel. | Should |
| FR-SFX-019 | The system shall support configurable keyboard types: `cherry-mx-blue` (loud tactile click), `cherry-mx-red` (linear smooth), `cherry-mx-brown` (tactile bump, default), `topre` (deep soft thock), `buckling-spring` (metallic ping + spring rattle), `membrane` (soft dampened), `none` (disabled). | Should |

### 3.14.3 Built-in Sound Patches

The system ships a default sound pack — the **Krypton Cyber** sound set — with all action sounds modeled after mechanical keyboard clicks (filtered noise bursts + low sine thumps). Keypress sounds are separate, with 6 keyboard types.

| Sound Event | Patch Character | Synthesis Approach |
|---|---|---|
| `window.create` | Firm keypress click + thock | White noise (bandpass ~3.5kHz) + sine (120Hz). 1ms attack, 15ms decay. |
| `window.close` | Deeper bottom-out thock | White noise (bandpass ~2.5kHz) + sine (80Hz). 1ms attack, 18ms decay. |
| `window.focus` | Light tap | White noise only (bandpass ~4kHz, Q=2). Ultra-short 8ms decay. |
| `window.maximize` | Double-click tap | White noise (bandpass ~3.2kHz) + sine (100Hz). 12ms decay. |
| `window.restore` | Softer click | White noise (bandpass ~3kHz) + sine (90Hz). 12ms decay. |
| `mode.enter` | Crisp tactile click | White noise (bandpass ~4.5kHz) + sine (150Hz). 10ms decay. |
| `mode.exit` | Soft key release / upstroke | White noise only (highpass ~3kHz). 8ms decay. |
| `quick_terminal.show` | Firm press with body | White noise (bandpass ~3kHz) + sine (110Hz). 20ms decay. |
| `quick_terminal.hide` | Light release click | White noise only (bandpass ~3.8kHz). 10ms decay. |
| `workspace.switch` | Spacebar thock — deeper | White noise (bandpass ~2.2kHz) + sine (70Hz). 25ms decay. |
| `command_palette.open` | Modifier key press | White noise (bandpass ~3.2kHz) + sine (130Hz). 15ms decay. |
| `command_palette.execute` | Enter key — firm thock | White noise (bandpass ~2.8kHz) + sine (90Hz). 20ms decay. |
| `terminal.bell` | Firm click with body | White noise (bandpass ~3kHz) + sine (140Hz). 20ms decay. |
| `startup` | Spacebar thock — deepest | White noise (bandpass ~2kHz) + sine (60Hz). 30ms decay. |
| `resize.step` | Tiny keycap edge tap | White noise only (bandpass ~5kHz, Q=2.5). 5ms decay. |
| `swap.complete` | Rapid click | White noise (bandpass ~3.5kHz) + sine (100Hz). 10ms decay. |

#### Keyboard Type Patches

Each keyboard type provides a **press** (key-down) and **release** (key-up) sound. Release fires ~30-70ms after press for natural feel. Amplitude and filter cutoff are randomized +/-8% per keystroke.

| Keyboard Type | Press Character | Release Character |
|---|---|---|
| `cherry-mx-blue` | Loud tactile click — sharp high-frequency noise burst + 180Hz body | Lighter high click — high bandpass noise |
| `cherry-mx-red` | Linear smooth — soft thock, low bandpass noise + 100Hz body | Very quiet upstroke — highpass noise whisp |
| `cherry-mx-brown` | Tactile bump — moderate click, mid bandpass noise + 130Hz body | Gentle upstroke click |
| `topre` | Deep soft thock — lowpass filtered noise + 80Hz body | Muted return — soft bandpass noise |
| `buckling-spring` | Loud metallic ping — wide bandpass noise + 220Hz + 440Hz harmonics | Spring rattle — noise + 300Hz partial |
| `membrane` | Soft mushy press — lowpass dampened noise + 70Hz body | Very quiet dampened return |

### 3.14.4 Sound Configuration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-SFX-020 | The system shall support a `[sound]` section in the TOML config for controlling the sound engine. | Must |
| FR-SFX-021 | The system shall support a global `enabled` toggle (`sound.enabled = true/false`) to enable or disable all sound effects. Default: `true`. | Must |
| FR-SFX-022 | The system shall support a global `volume` control (`sound.volume`, 0.0 to 1.0). Default: `0.5`. | Must |
| FR-SFX-023 | The system shall support per-event volume overrides or disabling individual sound events (`sound.events.<event_name> = false` or `sound.events.<event_name> = 0.3`). | Should |
| FR-SFX-024 | The system shall support a `sound.pack` setting to select a named sound pack. Default: `"krypton-cyber"`. | Should |
| FR-SFX-028 | The system shall support a `sound.keyboard_type` setting to select the keyboard sound profile. Default: `"cherry-mx-brown"`. Set to `"none"` to disable keypress sounds. | Should |
| FR-SFX-029 | The system shall support a `sound.keyboard_volume` setting (0.0–1.0) to independently control keypress sound volume. Default: `1.0`. Multiplied with master volume. | Should |
| FR-SFX-025 | The system shall support custom sound packs defined as TOML files in `~/.config/krypton/sounds/`. Each file defines a set of patches keyed by event name. | Could |
| FR-SFX-026 | Sound configuration changes shall take effect immediately via hot-reload (no restart required). | Should |
| FR-SFX-027 | The sound engine shall respect the system audio output device and volume. | Must |

### 3.14.5 Sound Engine Constraints

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-SFX-030 | Sound playback shall be non-blocking — synthesis and playback must not delay UI rendering or keyboard input processing. All audio scheduling shall use Web Audio API's built-in timing (`AudioContext.currentTime`). | Must |
| FR-SFX-031 | Sound effects shall be short (< 500ms for action feedback, < 1s for startup sequence). No looping or ambient background audio. | Must |
| FR-SFX-032 | Simultaneous sound events (e.g., close window triggers both `window.close` and `mode.exit`) shall mix cleanly without clipping. The engine shall apply a limiter/compressor on the master output. | Must |
| FR-SFX-033 | The sound engine shall dispose of completed audio nodes promptly to prevent memory leaks during long sessions. | Must |
| FR-SFX-034 | If the Web Audio API is unavailable (e.g., headless environment, no audio device), the sound engine shall silently degrade — no errors, no crashes. | Must |

## 3.15 Overlay Dashboards

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-DASH-001 | The app shall provide a `DashboardManager` framework for registering, toggling, and displaying full-screen overlay dashboard panels. | Must |
| FR-DASH-002 | Each dashboard shall be registered with a unique ID, title, optional keyboard shortcut, and `onOpen`/`onClose`/`onKeyDown` lifecycle hooks. | Must |
| FR-DASH-003 | Only one dashboard shall be active at a time. Opening a new dashboard shall close the current one first. | Must |
| FR-DASH-004 | Dashboard overlays shall render at z-index 9500 (above hint overlays, below which-key and command palette). | Must |
| FR-DASH-005 | Pressing Escape while a dashboard is open shall close it and restore terminal focus. | Must |
| FR-DASH-006 | Pressing the dashboard's toggle shortcut while it is open shall close it. | Must |
| FR-DASH-007 | The dashboard overlay shall display with a backdrop blur, themed panel, header with title and shortcut hint, and a scrollable content area. | Should |
| FR-DASH-008 | Dashboard open/close shall animate with CSS transitions (opacity + scale, 150ms open, 120ms close). | Should |
| FR-DASH-009 | Dashboards shall be listed as toggle actions in the command palette. | Should |
| FR-DASH-010 | A `run_command` Tauri command shall be available for dashboards to run short-lived processes and capture stdout without creating PTY sessions. | Must |

### 3.15.1 Git Dashboard

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-GIT-001 | A Git Dashboard shall be toggled via `Cmd+Shift+G`. | Must |
| FR-GIT-002 | The Git Dashboard shall display the current branch, staged/modified/untracked/deleted file counts, and a list of changed files for the focused terminal's working directory. | Must |
| FR-GIT-003 | Pressing `r` inside the Git Dashboard shall refresh the git status. | Should |
| FR-GIT-004 | If no terminal session is focused, the Git Dashboard shall display "No active terminal session". | Must |

### 3.15.2 OpenCode Dashboard

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-OC-001 | An OpenCode Dashboard shall be toggled via `Cmd+Shift+O`. | Must |
| FR-OC-002 | The OpenCode Dashboard shall display aggregate stats: total sessions, total messages, total output tokens, total cache reads, and total cost. | Must |
| FR-OC-003 | The OpenCode Dashboard shall display the 20 most recent top-level sessions with title, directory, message count, output tokens, lines added/deleted, duration, and relative time. | Must |
| FR-OC-004 | The OpenCode Dashboard shall display model usage breakdown (model name, provider, message count, output tokens). | Must |
| FR-OC-005 | The OpenCode Dashboard shall display the top 15 tool invocations with horizontal bar chart. | Must |
| FR-OC-006 | A `query_sqlite` Tauri command shall execute read-only SQL queries against any SQLite database and return rows as JSON. It shall open databases with `SQLITE_OPEN_READ_ONLY`, reject write statements, limit results to 1000 rows, and have a 5-second busy timeout. | Must |
| FR-OC-007 | Pressing `r` inside the OpenCode Dashboard shall refresh all data. | Should |
| FR-OC-008 | If the OpenCode database is not found, the dashboard shall display an error message with the expected path. | Must |

## 3.16 ACP Agent Orchestration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-ACP-001 | The system shall support opening single external ACP agent tabs for built-in backends such as Claude, Gemini, and Codex. | Should |
| FR-ACP-002 | The system shall support opening an ACP Harness view via keyboard (`Leader Y`) and command palette. | Should |
| FR-ACP-003 | The ACP Harness shall spawn multiple independent ACP subprocess lanes for the focused working directory when the corresponding backends are installed. | Should |
| FR-ACP-004 | The ACP Harness shall route each prompt to exactly one active lane and shall not broadcast prompts to multiple lanes. | Must |
| FR-ACP-005 | The ACP Harness shall expose keyboard controls for lane switching, prompt submission, cancellation, permission resolution, transcript scrolling, memory drawer navigation, and in-view help. | Must |
| FR-ACP-006 | The ACP Harness shall maintain tab-local shared memory extracted from completed tool observations and optional `MEMORY:` footer bullets, then inject selected other-lane entries into future prompts. | Should |
| FR-ACP-007 | The ACP Harness shall keep shared memory in process memory only; closing the harness tab drops transcripts, memory, and lane state. | Should |
