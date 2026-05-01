# 5. Architecture Overview

```
+-------------------------------------------------------------------------+
|  Tauri Native Shell (Fullscreen, Borderless, Transparent)               |
|  +-------------------------------------------------------------------+  |
|  |     Webview — Active Workspace (Transparent Virtual Desktop)       |  |
|  |                                                                   |  |
|  |  +--Window 0 (focused)----+  +--Window 1--------------+          |  |
|  |  | [Title Bar] [x][-][+]  |  | [Title Bar] [x][-][+]  |          |  |
|  |  | [Tab 0 | Tab 1]        |  | [Tab 0]                |          |  |
|  |  | +--------------------+ |  | +--------------------+  |          |  |
|  |  | |   xterm.js #0      | |  | |   xterm.js #1      |  |          |  |
|  |  | |                    | |  | |                    |  |          |  |
|  |  | +--------------------+ |  | +--------------------+  |          |  |
|  |  +------------------------+  +--------------------------+          |  |
|  |                                                                   |  |
|  |  (Window 2, Window 3... hidden — belong to other workspaces)      |  |
|  |                                                                   |  |
|  |  [ Compositor: z-order, focus, move, resize, animations ]         |  |
|  |  [ Mode Indicator ]  [ Command Palette ]  [ Sound Engine ]        |  |
|  +-------------------------------------------------------------------+  |
|                          |  IPC (Tauri Commands & Events)               |
+--------------------------|----------------------------------------------+
                           v
+-------------------------------------------------------------------------+
|                       Rust Backend                                      |
|                                                                         |
|  +---------------+ +------------+ +-----------+ +--------------------+  |
|  | Workspace     | | Session    | | PTY       | | Config             |  |
|  | Manager       | | Pool       | | Manager   | | Manager            |  |
|  | (workspace    | | (window-to-| | (portable | | (TOML, hot-reload) |  |
|  |  definitions, | |  session   | |  -pty)    | |                    |  |
|  |  switching,   | |  mapping)  | |           | |                    |  |
|  |  presets)     | |            | |           | |                    |  |
|  +---------------+ +------------+ +-----------+ +--------------------+  |
|                                                                         |
|  +---------------+ +------------+ +-------------------+ +--------------+  |
|  | Theme         | | VT Parser  | | Process Poller    | | Sound        |  |
|  | Engine        | | (vte)      | | (tcgetpgrp,       | | Engine       |  |
|  +---------------+ +------------+ |  process-changed) | | (rodio/cpal) |  |
|                                   +-------------------+ +--------------+  |
|  +---------------+                                                        |
|  | SSH Manager   |                                                        |
|  | (detect,      |                                                        |
|  |  clone, ctrl  |                                                        |
|  |  sockets)     |                                                        |
|  +---------------+                                                        |
+-------------------------------------------------------------------------+
              |
              v
    +-------------------+
    |  OS PTY / Shell(s) |
    +-------------------+
```

### Key Architectural Principle: Workspace as Desktop

Krypton uses **one native Tauri shell** that is always **fullscreen, borderless, and fully transparent**. The webview background is `transparent` — the OS desktop wallpaper shows through. The active **workspace** fills this surface as a virtual desktop. Terminal **windows** are DOM elements floating on the workspace with their own opaque (or semi-transparent) backgrounds, chrome, and shadows.

Each window has:
- Cyberpunk/sci-fi **chrome** — titlebar with session label, status dot, PTY status text; right sidebar with telemetry decoration; bottom bar with line indicators; glowing cyan border on focused window
- Its own **xterm.js instance** for terminal rendering
- **Keyboard-driven move and resize** as the primary interaction, with optional mouse as secondary

This model enables:
- **Workspace = desktop** — switching workspaces feels like switching macOS Spaces; each workspace is a full-screen arrangement of windows
- **Fully custom chrome** — window borders, title bars, controls, and shadows are all theme-driven via custom theme TOML files
- **Animated workspace transitions** — windows animate between positions using CSS/JS transitions on the transparent surface
- **Zero overhead** — switching workspaces shows/hides/repositions DOM elements; no native OS windows created or destroyed
- **Unified focus management** — the compositor controls which window receives keyboard input
- **Consistent behavior** — no platform-specific window manager quirks

### Tauri Native Shell Configuration

```rust
// src-tauri/src/main.rs (conceptual)
tauri::Builder::default()
    .setup(|app| {
        let window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
            .fullscreen(true)           // always fullscreen
            .decorations(false)         // no native title bar or borders
            .transparent(true)          // transparent background
            .always_on_top(false)       // sits at normal z-level
            .skip_taskbar(false)        // visible in OS taskbar/dock
            .build()?;
        Ok(())
    })
```

The webview's `<html>` and `<body>` have `background: transparent`. Windows are the only visible elements — they float on the invisible workspace surface with their own chrome and shadows.

## 5.1 Key Rust Crates

| Crate | Purpose | Status |
|-------|---------|--------|
| `tauri` | Application framework, fullscreen transparent borderless shell, IPC | Implemented |
| `portable-pty` | Cross-platform PTY allocation and management | Implemented |
| `serde` / `serde_json` | Serialization framework for IPC and config | Implemented |
| `toml` | TOML config file parsing | Implemented |
| `dirs` | Cross-platform home directory resolution for config path | Implemented |
| `log` / `tauri-plugin-log` | Logging framework | Implemented |
| `vte` | VT escape sequence parser (backend validation/processing) | Planned |
| `notify` | Filesystem watcher for config/theme hot-reload | Implemented |
| `open` | Open URLs/files with system default handler (hint mode) | Implemented |
| `libc` | Unix FFI for `tcgetpgrp()` (foreground process detection) | Implemented |
| `unicode-width` | Character width calculation for CJK / emoji | Planned |
| `display-info` | Query monitor geometry for fullscreen dimensions | Planned |
| `rusqlite` | Read-only SQLite database access for dashboard overlays | Implemented |
| `rodio` | Audio playback for sound engine (WAV decoding + OS audio output via cpal) | Implemented |
| `hostname` | Local hostname detection for SSH remote CWD filtering (OSC 7 hostname comparison) | Implemented |

## 5.2 Key Frontend Packages (npm)

| Package | Purpose |
|---------|---------|
| `@xterm/xterm` | Core terminal emulator library |
| `@xterm/addon-webgl` | WebGL-based renderer for GPU-accelerated drawing |
| `@xterm/addon-fit` | Auto-fit terminal dimensions to container |
| `@xterm/addon-search` | In-terminal text search |
| `@xterm/addon-web-links` | Clickable URL detection |
| `@xterm/addon-unicode11` | Proper Unicode width handling |
| `@excalidraw/excalidraw` | Drawing canvas for the Pencil window (lazy-loaded with React 19 — only mounted when Pencil opens) |

## 5.3 Frontend Technology

- **xterm.js** — The terminal rendering library. Uses its WebGL/Canvas renderer for high-performance character grid output. xterm.js handles VT escape sequence parsing on the frontend, cursor rendering, selection, search, and link detection.
- **xterm.js addons** — `xterm-addon-webgl` (GPU-accelerated rendering), `xterm-addon-fit` (auto-resize), `xterm-addon-search`, `xterm-addon-web-links`.
- **Vanilla TypeScript / lightweight framework** — For the compositor (workspace management, window chrome, animations, command palette).

Since xterm.js handles VT parsing and rendering on the frontend, the Rust backend's primary role is PTY management, workspace state, theme loading, and raw byte forwarding.

## 5.4 Compositor Layer (Frontend)

The compositor is a TypeScript module running in the webview that manages workspace and window lifecycle:

### Responsibilities

1. **Workspace rendering** — display the active workspace; show/hide windows when switching workspaces
2. **Window rendering** — create/destroy window DOM containers, each hosting an xterm.js instance with custom chrome
3. **Layout engine** — compute window positions from grid definitions relative to the workspace (full screen). Supports multiple layout modes: **Grid** (balanced auto-tile) and **Focus** (focused window on left at full height, remaining windows stacked on right)
4. **Input routing & mode management** — manage keyboard modes (normal, compositor, resize, move) and route keys accordingly
5. **Focus management** — track which window is focused; route keyboard events to the focused window's PTY in normal mode
6. **Keyboard-driven window control** — handle window move, resize, swap, maximize, and focus cycling via keybindings
7. **Command palette** — overlay for fuzzy-searching and executing all available actions by name
8. **Animation engine** — orchestrate workspace transition animations (slide, crossfade, morph) and window entrance/exit effects
9. **Quick Terminal** — manage a persistent overlay terminal (toggled via `Cmd+I`) that floats centered on screen above all workspace windows; separate from the tiling layout
10. **Z-order** — manage window stacking within a workspace; focused window rises to top
11. **Chrome rendering** — cyberpunk/sci-fi window chrome with glowing cyan borders, session label with status dot, PTY status indicator, right sidebar with telemetry decoration, and bottom bar
12. **Per-window accent colors** — each window gets a unique color from a 10-color cyberpunk palette (cyan, magenta, amber, green, violet, orange, pink, teal, gold, red) applied to chrome, borders, corners, tabs; colors recycled on window close
13. **Shader engine** — manage per-pane CSS/SVG post-processing effects (CRT, hologram, glitch, bloom, matrix); cycle presets via `Leader g`, toggle globally via `Leader G`
14. **Progress indicator** — listen for `pty-progress` events (ConEmu `OSC 9;4`); render a large translucent SVG arc gauge centered in the window's content area (behind terminal text) and a titlebar scanline sweep; per-pane state tracking with active-tab display; accent-color-aware theming
15. **Context extensions** — `ExtensionManager` listens for `process-changed` Tauri events from a backend poller (500ms, using `tcgetpgrp()` on PTY master fd). When a matching foreground process is detected (e.g., `java`), the corresponding built-in extension activates and renders widget bars (top/bottom horizontal strips inside the pane). Bars are real flex children that push the xterm terminal inward — `addon-fit` recalculates and `resize_pty` fires. First extension: Java Resource Monitor (JVM heap, GC, CPU%, RSS via `jstat` + `ps`).
16. **Overlay dashboards** — `DashboardManager` provides a generic framework for full-screen overlay panels. Modules register dashboards with an ID, title, optional keyboard shortcut, and `onOpen`/`onClose`/`onKeyDown` lifecycle hooks. The manager handles DOM creation (backdrop + panel + header + scrollable content area at z-index 9500), show/hide transitions (CSS opacity + scale), `Mode.Dashboard` integration with the InputRouter, and focus restoration. Built-in dashboards: **Git Status** (`Cmd+Shift+G`) — branch, file counts, changed file list via `run_command`; **OpenCode** (`Cmd+Shift+O`) — session history, token usage, model/tool distribution from local SQLite database via `query_sqlite`.
17. **Optional mouse handling** — secondary drag/resize/click interactions for users who prefer mouse
18. **ACP agent windows** — `src/acp/` (`AcpClient`, `AcpView`) and `src-tauri/src/acp.rs` (`AcpRegistry`, `AcpClient`) implement a separate, dedicated agent window that drives an external [Agent Client Protocol](https://agentclientprotocol.com) adapter (Claude Code, Gemini CLI, …) over newline-delimited JSON-RPC on the subprocess's stdio. The reader task dispatches by message shape: responses resolve `pending[id]` oneshots, inbound `fs/read_text_file` and `fs/write_text_file` requests are answered locally, `session/request_permission` is bridged to the frontend through a per-id oneshot, and `session/update` notifications are emitted on `acp-event-<session>`. The pi-agent (`src/agent/`) is intentionally untouched — both window types coexist on `Leader a` (pi-agent) and `Leader A` (ACP picker). See `docs/69-acp-agent-support.md`.
19. **ACP Harness view** — `AcpHarnessView` (`src/acp/acp-harness-view.ts`) opens multiple `AcpClient` lanes in one content tab for the focused working directory. It renders a read-only lane dashboard plus an input-only command center, routes prompts only to the active lane, handles per-lane permission prompts, and uses `src/acp/acp-harness-memory.ts` for tab-local shared memory extraction/injection. Open via `Leader Y` or command palette. See `docs/72-acp-harness-view.md`.
20. **Cursor trail** — `CursorTrail` (`src/cursor-trail.ts`) renders a rainbow flame particle effect on both the mouse cursor and the terminal text cursor. Spawns burst particles on `mousemove` (document-level capture) and polls the focused terminal's `buffer.active.cursorX/Y` each frame. Particles drift upward with turbulence, cycle through rainbow hues, and fade with quadratic falloff. Appended to `document.body` at z-index 99999. Togglable at runtime via `toggle()`

### Window DOM Structure

Krypton uses a cyberpunk/sci-fi chrome style. Each window has a titlebar with session label and PTY status, a **tab bar** (auto-shown when multiple tabs exist), and a **content area** containing the active tab's pane tree. Pane trees are binary splits — each leaf is a `.krypton-pane` hosting an xterm.js instance, and splits are `.krypton-split` containers with a `.krypton-split__divider` between two children.

```html
<html style="background: transparent">
<body style="background: transparent">
  <div class="krypton-workspace"
       style="background: transparent; width: 100vw; height: 100vh;">

    <div class="krypton-window krypton-window--focused" id="win-0"
         style="position: absolute;">
      <div class="krypton-window__chrome">
        <div class="krypton-window__titlebar">
          <div class="krypton-window__label-group">
            <div class="krypton-window__status-dot"></div>
            <span class="krypton-window__label">SESSION_01</span>
          </div>
          <span class="krypton-window__pty-status">~/projects</span>
        </div>
        <div class="krypton-window__header-accent"></div>
      </div>

      <!-- Tab bar: auto-shown when >1 tab or always_show_tabbar = true -->
      <div class="krypton-window__tabbar krypton-window__tabbar--visible">
        <div class="krypton-tab krypton-tab--active" data-tab-id="tab-0">
          <span class="krypton-tab__title">Shell 1</span>
        </div>
        <div class="krypton-tab" data-tab-id="tab-1">
          <span class="krypton-tab__title">Shell 2</span>
        </div>
      </div>

      <!-- Content area: hosts the active tab's pane tree -->
      <div class="krypton-window__content">
        <!-- Single pane (leaf node) -->
        <div class="krypton-pane krypton-pane--focused" data-pane-id="pane-0">
          <!-- xterm.js mounts here -->
        </div>

        <!-- OR a split with two panes -->
        <!--
        <div class="krypton-split krypton-split--vertical">
          <div class="krypton-pane krypton-pane--focused" data-pane-id="pane-0">
            xterm.js
          </div>
          <div class="krypton-split__divider"></div>
          <div class="krypton-pane" data-pane-id="pane-1">
            xterm.js
          </div>
        </div>
        -->
      </div>

      <!-- Corner accents -->
      <div class="krypton-window__corner krypton-window__corner--tl"></div>
      <div class="krypton-window__corner krypton-window__corner--tr"></div>
      <div class="krypton-window__corner krypton-window__corner--bl"></div>
      <div class="krypton-window__corner krypton-window__corner--br"></div>
    </div>

    <!-- More windows... -->

    <!-- Quick Terminal (overlay, toggled via Cmd+I) -->
    <div class="krypton-quick-terminal" id="quick-terminal"
         style="position: absolute; z-index: 5000; display: none;">
      <!-- Same chrome structure as regular windows (no tabs/panes) -->
      <div class="krypton-window__chrome">
        <div class="krypton-window__titlebar">
          <div class="krypton-window__label-group">
            <div class="krypton-window__status-dot"></div>
            <span class="krypton-window__label">QUICK_TERMINAL</span>
          </div>
          <span class="krypton-window__pty-status">PTY_STREAMS // ACTIVE</span>
        </div>
      </div>
      <div class="krypton-window__content">
        <div class="krypton-window__body">
          <!-- xterm.js mounts here (single terminal, no tab/pane structure) -->
        </div>
      </div>
    </div>

    <!-- Dashboard overlay (shown when a dashboard is active, z-index: 9500) -->
    <div class="krypton-dashboard krypton-dashboard--visible">
      <div class="krypton-dashboard__backdrop"></div>
      <div class="krypton-dashboard__panel">
        <div class="krypton-dashboard__header">
          <span class="krypton-dashboard__title">Git Status</span>
          <span class="krypton-dashboard__shortcut-hint">Cmd+Shift+G</span>
          <button class="krypton-dashboard__close">&times;</button>
        </div>
        <div class="krypton-dashboard__content">
          <!-- Dashboard-specific content rendered by onOpen() -->
        </div>
      </div>
    </div>

    <!-- Which-key popup (shown during compositor/resize/move/tab-move modes) -->
    <div class="krypton-whichkey">...</div>
  </div>
</body>
</html>
```

### Window Identity Model

Each window has a stable `window_id` (e.g., `"win-0"`, `"win-1"`). The workspace state is:

```
workspace_name -> [ WindowSlot { window_id, grid_position, abs_override?, session_ids } ]
```

When switching workspaces:
- Windows in both workspaces: **animate** from current to target position/size
- Windows only in target: **create** with entrance animation, assign idle session or spawn new shell
- Windows only in current: **hide** with exit animation (DOM hidden, PTY kept alive in session pool)

## 5.5 Config Manager (Backend)

The Config Manager (`src-tauri/src/config.rs`) handles loading and serving the TOML configuration:

- **Serde structs**: `KryptonConfig` with subsections `ShellConfig`, `FontConfig`, `TerminalConfig`, `ThemeConfig` (with `ThemeColors`), `QuickTerminalConfig`, `WorkspacesConfig`. All derive `Default` and use `#[serde(default)]` so missing fields fall back to built-in defaults.
- **Config path**: `~/.config/krypton/krypton.toml` on all platforms (resolved via `dirs::home_dir()`).
- **First-run behavior**: If the config file doesn't exist, the directory is created and a default config is written.
- **Parse errors**: Logged and silently fall back to defaults (app still starts).
- **IPC**: `get_config` Tauri command returns the full `KryptonConfig` to the frontend on startup. `run_command` Tauri command runs a short-lived process (non-PTY) and returns stdout, used by overlay dashboards to gather data (e.g., `git status --porcelain`, `git branch --show-current`). `query_sqlite` Tauri command executes read-only SQL queries against a specified SQLite database and returns rows as JSON objects, used by the OpenCode dashboard to read session/message/token data.
- **Shell config**: `spawn_pty` command accepts optional `shell`/`shell_args` params from the frontend, falling back to config values, then `$SHELL`.

Frontend counterpart: `src/config.ts` defines matching TypeScript interfaces and a `loadConfig()` function. The compositor's `applyConfig()` method applies settings (font, terminal, theme colors, Quick Terminal sizing, workspace gap/step sizes) before the first window is created.

## 5.6 Workspace Manager (Backend)

The Workspace Manager lives in Rust and handles the data/logic side:

- Parse `[[workspaces.layouts]]` from TOML config
- Store built-in presets and user overrides
- Respond to `invoke("switch_workspace", { name })` — send target workspace layout to frontend compositor via Tauri event
- Track window-to-session mapping in the session pool
- Handle `invoke("get_workspace_list")` — return available workspace names for UI display

The actual window positioning and animation is **frontend-driven** (CSS/JS), not Rust-driven, because the compositor operates entirely within the DOM.

### Theme Engine (Backend — `src-tauri/src/theme.rs`)

The Theme Engine lives in Rust (`theme::ThemeEngine`) and manages theme loading:

- Embeds built-in themes at compile time via `include_str!` (krypton-dark, legacy-radiance)
- Scans `~/.config/krypton/themes/*.toml` for custom theme files
- Resolves themes by name (custom themes take precedence over built-in)
- Applies `[theme.colors]` config overrides on top of the resolved theme
- Serves full theme data (`FullTheme` struct — meta, colors, chrome, focused, workspace, ui) to the frontend via `invoke("get_theme")`
- Lists available themes via `invoke("list_themes")`
- Supports `invoke("reload_config")` for manual reload
- **Tauri commands**: `get_theme`, `list_themes`, `reload_config`
- **Tauri events**: `theme-changed`, `config-changed` (emitted on hot-reload)

### Theme Engine (Frontend — `src/theme.ts`)

The Frontend Theme Engine (`FrontendThemeEngine`) receives theme data and applies it:

- Sets 50+ `--krypton-*` CSS custom properties on `document.documentElement`
- Builds xterm.js theme objects from theme colors for terminal instances
- Listens for `theme-changed` Tauri event from backend (hot-reload)
- Notifies the compositor to update all existing terminal instances on theme change
- `styles.css` uses `var(--krypton-*)` throughout so theme changes cascade instantly

### Config Hot-Reload (Backend — `src-tauri/src/lib.rs`)

- `notify` crate watches `~/.config/krypton/` recursively for `.toml` file changes
- 300ms debounce prevents rapid-fire reloads
- On change: re-parses config, resolves theme, emits `theme-changed` and `config-changed` events
- Config stored as `Arc<RwLock<KryptonConfig>>` for safe concurrent access

## 5.6 Input Router & Mode System (Frontend)

The input router is the central keyboard dispatcher. It determines what happens with each keypress based on the current **mode**:

### Modes

| Mode | Activated by | Behavior | Exit |
|------|-------------|----------|------|
| **Normal** | Default | Keypresses forwarded to focused window's PTY | Enter another mode via leader key |
| **Compositor** | Leader key (`Cmd+P`) | Keypresses interpreted as compositor commands (focus window, toggle layout, pin window, switch workspace) | Auto-exits after one action, or `Escape` to cancel |
| **Resize** | `Leader` then `R` | Arrow keys resize the focused window; step size configurable | `Escape` or `Enter` to confirm |
| **Move** | `Leader` then `M` | Arrow keys reposition the focused window | `Escape` or `Enter` to confirm |
| **Selection** | `Leader` then `v` or `V` | Vim-like keyboard text selection — virtual cursor navigates buffer with h/j/k/l/w/b/e/0/$, `v` toggles char-wise selection, `V` toggles line-wise, `y` yanks to clipboard | `Escape` to cancel, `y` to yank and exit |
| **Hint** | `Leader` then `Shift+H` or `Cmd+Shift+H` (global) | Scans visible buffer for regex patterns (URLs, paths, emails), overlays keyboard labels on matches. Type a label to act (open/copy/paste). | `Escape` to cancel, or selecting a label |
| **Dashboard** | Dashboard shortcut (e.g., `Cmd+Shift+G` for Git) | Displays a full-screen overlay panel. Keys delegated to the active dashboard's `onKeyDown` handler. | `Escape`, or re-pressing the dashboard's toggle shortcut |

**Compositor single-action keys (in Compositor mode):**

| Key | Action |
|-----|--------|
| `g` | Cycle shader preset on focused pane (none → crt → hologram → glitch → bloom → matrix → none) |
| `G` (Shift+g) | Toggle shaders on/off globally |
| `c` | Clone SSH session from focused pane into a new tab (via ControlMaster multiplexing) |
| `C` (Shift+c) | Clone SSH session from focused pane into a new window |
| **Command Palette** | `CmdOrCtrl+Shift+P` | Text input filters the action list; Enter executes; Escape closes | `Escape` or action execution |
| **Search** | `CmdOrCtrl+F` | Text input searches scrollback in the focused window | `Escape` to close |

**Global hotkeys that work from any mode:**
- `Cmd+I` — Toggle Quick Terminal (show/hide centered overlay terminal)
- `Cmd+Shift+P` — Toggle Command Palette (fuzzy-searchable action list)
- `Leader Y` — Open ACP Harness, a multi-lane ACP content view sharing the focused CWD
- `Cmd+Shift+<` / `Cmd+Shift+>` — Cycle focus through windows
- `Ctrl+Shift+U` / `Ctrl+Shift+D` — Scroll terminal buffer up/down by one page
- `Cmd+Shift+H` — Enter hint mode (scan terminal for URLs/paths/emails, overlay labels)
- `Cmd+Shift+G` — Toggle Git Dashboard (overlay showing git status for focused terminal's CWD)
- `Cmd+Shift+O` — Toggle OpenCode Dashboard (session history, token usage, model/tool stats from local SQLite DB)

### Key routing flow

```
Keypress
  |
  v
[Is Quick Terminal toggle?] --yes--> Show/hide Quick Terminal, transfer focus
  |
  no
  v
[Is a global hotkey?] --yes--> Execute global action (workspace switch, command palette, etc.)
  |
  no
  v
[Current mode?]
  |
  +-- Normal --------> Forward to focused window's xterm.js -> PTY
  +-- Compositor ----> Interpret as compositor command
  +-- Resize --------> Adjust focused window size
  +-- Move ----------> Adjust focused window position
  +-- Selection -----> Navigate virtual cursor / expand selection
  +-- Hint ----------> Filter/select hint labels -> execute action
  +-- Cmd Palette ---> Filter/select action list
  +-- Dashboard -----> Delegate to active dashboard's onKeyDown handler
  +-- Search --------> Update search query
```

### Command Palette

The command palette is a fuzzy-searchable overlay listing **every action** in Krypton:

- Window actions: new, close, focus next/prev, focus by index, maximize, restore, swap, reset layout, toggle focus layout, toggle pin
- Tab actions: new, close, next/prev, move to window
- Workspace actions: switch by name, next/prev workspace
- Pane actions: split horizontal/vertical, close, navigate
- Theme actions: switch theme
- Clipboard: copy, paste
- Search: open search, next/prev match
- Config: reload config, open config file
- Dashboard actions: toggle registered dashboards (Git Status, etc.)
- SSH actions: clone session to new tab/window
- Application: quit

Each entry displays the action name and its current keybinding (if any).

## 5.7 Animation Engine (Frontend)

A dedicated module that handles all motion:

- **Workspace transitions** — on switch, compute start/end rects for each window, apply chosen animation (slide, crossfade, morph)
- **Entrance/exit effects** — windows appearing or disappearing
- **Keyboard-driven resize/move** — smooth real-time position updates as user holds arrow keys in resize/move mode
- **Spring physics** (optional) — for `spring` easing, implement a simple spring solver

Implementation options:
- **CSS transitions** — simplest, hardware-accelerated `transform` and `opacity`
- **Web Animations API** — more control, cancellable, reversible
- **requestAnimationFrame loop** — for spring physics or complex choreography

The animation engine must maintain **60 FPS** and avoid layout thrashing (use `transform: translate()` + `width`/`height`, not `top`/`left`).

## 5.8 Sound Engine (Rust Backend)

The sound engine runs entirely in the Rust backend (`src-tauri/src/sound.rs`) using the `rodio` crate for OS-native audio playback. The frontend `src/sound.ts` is a thin IPC wrapper — it contains no Web Audio API code. This eliminates all AudioContext degradation, suspended-state, and silence bugs that plagued the previous browser-based implementation.

### Architecture

```
App start (lib.rs setup)
  |
  v
SoundEngine::new() — spawns dedicated "krypton-audio" thread
  |                    (owns OutputStream + Sinks, receives AudioMsg via mpsc)
  |
  v
SoundEngine::init(resource_dir) — sends LoadPack message to audio thread
  |                                  audio thread reads 17 WAV files into HashMap<String, Vec<u8>>
  |
  v
[Ready — WAV bytes cached in audio thread memory]

---

Frontend action (compositor/input-router event)
  |
  v
SoundEngine.play('window.create')         [src/sound.ts — thin IPC wrapper]
  |
  v
invoke('sound_play', { event })            [Tauri IPC]
  |
  v
sound::sound_play() command                [src-tauri/src/sound.rs]
  |  - Check enabled, per-event override, cooldown dedup (50ms)
  |  - Map event -> WAV name
  |  - Calculate volume (master * per-event override)
  |
  v
mpsc::Sender::send(AudioMsg::Play { wav_name, volume })
  |
  v
Audio thread receives message
  |  - Prune finished Sinks
  |  - Check MAX_CONCURRENT (8)
  |  - Clone WAV bytes from buffer cache
  |  - Decoder::new(Cursor::new(bytes))
  |  - Sink::try_new() -> set_volume() -> append(source)
  |
  v
OS audio output (via cpal/CoreAudio)
```

### Key Design Decisions

- **Dedicated audio thread** — `rodio::OutputStream` is `!Send+!Sync` (platform audio handles), so all audio resources live on a dedicated named thread (`krypton-audio`). The Tauri-managed `SoundEngine` holds only an `mpsc::Sender<AudioMsg>` which is `Send+Sync`.
- **WAV-only** — no procedural synthesis. Each sound pack is a directory of 17 pre-rendered WAV files under `src-tauri/sounds/<pack>/`. Total ~1.4 MB for both packs.
- **In-memory buffers** — WAV file bytes are read into `Vec<u8>` at pack load time. Each playback clones the bytes into a `Cursor` for `rodio::Decoder`. This avoids filesystem I/O on the hot path.
- **Overlap management** — same constants as the previous frontend implementation: `MAX_CONCURRENT=8` (excess dropped), `KEYPRESS_THROTTLE_MS=25`, `EVENT_COOLDOWN_MS=50`. Enforced in the `SoundEngine` (Tauri command side) before sending to the audio thread.
- **Fire-and-forget IPC** — frontend `invoke()` calls don't await completion. The Tauri command acquires the mutex, checks throttle/cooldown, sends a channel message, and returns immediately. Actual audio playback is asynchronous on the audio thread.
- **Graceful degradation** — if no audio device is available, `OutputStream::try_default()` fails on the audio thread, which drains the channel and exits. All `play()` calls become silent no-ops.
- **Hot-reload** — on `config-changed`, `lib.rs::reload_and_emit()` calls `engine.apply_config()` directly on the Rust side. If the pack changed, a `LoadPack` message is sent to the audio thread.

### macOS Backdrop-Filter Freeze (Platform Gotcha)

> Implemented: 2026-03-16

CSS `backdrop-filter: blur()` on macOS transparent WKWebView windows causes the native compositor to **snapshot** the content behind the blurred element rather than continuously compositing it live. When the Tauri window gains focus, macOS optimizes rendering by freezing this snapshot — dynamic desktop content (video wallpapers) behind terminal windows stops updating.

**Fix:** All `backdrop-filter` / `-webkit-backdrop-filter` declarations were removed from `src/styles.css`. Semi-transparent `background` colors (rgba with alpha) remain, providing a tinted overlay without triggering the snapshot. Affected elements: `.krypton-window`, `.krypton-quick-terminal`, `.krypton-whichkey__popup`, `.krypton-hint-toast`, `.krypton-palette__container`, `.krypton-dashboard__backdrop`.

Additionally, xterm.js's internal color parser rejects alpha < 255, falling back to opaque `#000000` on `.xterm-scrollable-element`. A CSS `!important` override was added for that element.

Config/theme keys `blur`, `backdrop_blur` remain in parsers for forward compatibility but are currently **inert**.

See also: `docs/16-terminal-shaders.md` for related visual rendering.

### Tauri Commands

| Command | Parameters | Purpose |
|---------|-----------|---------|
| `sound_play` | `event: String` | Play a UI sound event |
| `sound_play_keypress` | `key: String` | Play a keypress sound (routes by key name) |
| `sound_apply_config` | `config: SoundConfig` | Apply sound config from frontend |
| `sound_load_pack` | `pack: String` | Switch sound pack |
| `sound_get_packs` | — | Get available packs and current selection |

### Integration Points

The frontend `SoundEngine` class (`src/sound.ts`) exposes the same `play()` / `playKeypress()` API as before. Call sites in `compositor.ts`, `input-router.ts`, `command-palette.ts`, and `main.ts` are unchanged.

| Caller | Event | Sound |
|--------|-------|-------|
| `compositor.createWindow()` | After window DOM created | `window.create` |
| `compositor.closeWindow()` | Before exit animation | `window.close` |
| `compositor.focusWindow()` | On focus change | `window.focus` |
| `compositor.toggleMaximize()` | On maximize/restore | `window.maximize` / `window.restore` |
| `compositor.toggleQuickTerminal()` | On show/hide | `quick_terminal.show` / `quick_terminal.hide` |
| `compositor.toggleFocusLayout()` | On layout toggle | `layout.toggle` |
| `input-router` (mode change) | On enter/exit mode | `mode.enter` / `mode.exit` |
| `input-router` (compositor key) | On resize/move step | `resize.step` / `move.step` |
| `input-router` (swap) | On swap complete | `swap.complete` |
| `main.ts` (startup) | After first window rendered | `startup` |
| PTY event listener | On BEL character | `terminal.bell` |
| PTY event listener | On shell exit | `terminal.exit` |
| `terminal.onData()` (both regular + QT) | On each keystroke to PTY | `keypress` (press phase only via `playKeypress('press', key)`) |

### Sound Packs

Two built-in packs, each containing 17 WAV files:

| Pack | Directory | Description |
|------|-----------|-------------|
| `deep-glyph` (default) | `src-tauri/sounds/deep-glyph/` | Rich, deep UI sounds |
| `mach-line` | `src-tauri/sounds/mach-line/` | Sharp, mechanical interface tones |

Packs are bundled as Tauri resources (declared in `tauri.conf.json`) and loaded at runtime from the app's resource directory. The command palette lists all available packs for switching.
