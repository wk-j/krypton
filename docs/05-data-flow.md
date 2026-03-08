# 6. Data Flow

```
 User Input                                                   Display
    |                                                            ^
    v                                                            |
+--------+    IPC invoke     +-----------+    PTY write    +----------+
| xterm  | ----------------> |   Rust    | --------------> |  Shell   |
|  .js   |                   |  Backend  |                 | Process  |
|        | <---------------- |           | <-------------- |          |
+--------+    Tauri event    +-----------+    PTY read     +----------+
```

## Keyboard Input Routing (Step-by-step)

1. **User presses a key** -> webview captures `keydown` event
2. **Input Router checks mode**:
   - **Global hotkey?** (e.g., `CmdOrCtrl+1`) -> execute immediately (e.g., switch workspace)
   - **Normal mode?** -> forward to focused window's xterm.js -> xterm.js encodes and emits `onData`
   - **Compositor/Resize/Move mode?** -> execute compositor command (focus, resize, move, etc.)
   - **Command palette / Search mode?** -> route to overlay's text input handler
3. **If forwarded to PTY**: Tauri `invoke("write_to_pty", { window_id, data })` via IPC
4. **Rust backend writes** -> Raw bytes written to PTY file descriptor
5. **Shell processes input** -> Shell sends output back through PTY
6. **Rust backend reads PTY** -> Raw bytes read from PTY fd
7. **Backend emits event** -> Tauri event `terminal-output` pushes raw bytes to frontend (scoped by window_id)
8. **xterm.js renders** -> xterm.js parses VT sequences and updates the window's terminal canvas

## Quick Terminal Toggle Flow (e.g., user presses Cmd+I)

```
1. User presses Cmd+I (global hotkey, works from any mode)
2. Input Router intercepts the key before any mode-specific handling
3. If Quick Terminal is hidden:
   a. Compositor saves the currently focused workspace window ID
   b. Quick Terminal DOM element becomes visible (display: flex)
   c. Animation engine plays entrance animation (slide-down + fade-in)
   d. Quick Terminal's xterm.js instance receives focus
   e. Input Router stays in / returns to Normal mode
   f. All keyboard input now routes to the Quick Terminal's PTY
   g. If Quick Terminal has no PTY session yet, one is spawned on first show
4. If Quick Terminal is visible:
   a. Animation engine plays exit animation (slide-up + fade-out)
   b. Quick Terminal DOM element becomes hidden (display: none)
   c. Focus returns to the previously saved workspace window
   d. Input Router stays in / returns to Normal mode
5. The Quick Terminal's PTY session remains alive across show/hide cycles
6. Pressing Escape in Normal mode while Quick Terminal is focused also hides it
```

## Resize Flow

1. **Window resizes** (layout change, keyboard resize, workspace switch) -> `@xterm/addon-fit` calculates new rows/cols
2. **Frontend notifies backend** -> Tauri `invoke("resize_pty", { window_id, rows, cols })`
3. **Backend resizes PTY** -> `TIOCSWINSZ` ioctl (POSIX) / `ResizePseudoConsole` (Windows)
4. **Shell redraws** -> Shell receives `SIGWINCH`, redraws output

## Config Loading Flow (on app startup)

```
1. Rust backend starts, calls config::load_config()
2. load_config() resolves path: ~/.config/krypton/krypton.toml
3. If file doesn't exist:
   a. Create directory ~/.config/krypton/
   b. Serialize KryptonConfig::default() to TOML
   c. Write default config file to disk
   d. Return default config
4. If file exists:
   a. Read file contents
   b. Parse TOML into KryptonConfig (missing fields filled by #[serde(default)])
   c. If parse fails, log error and return defaults
5. Config stored as Arc<KryptonConfig> in Tauri managed state
6. Frontend calls invoke("get_config") during initialization
7. Compositor.applyConfig() applies settings:
   - Font family, size, line height
   - Terminal scrollback, cursor style, cursor blink
   - Theme color overrides (merged on top of built-in theme)
   - Quick Terminal width/height ratio, backdrop blur
   - Workspace gap, resize/move step sizes
8. First terminal window created with config-backed settings
9. PTY spawned with config shell program and args
```

## Compositor Mode Flow (e.g., user presses Leader key)

```
1. User presses Leader key (Cmd+P)
2. Input Router enters Compositor mode
3. UI shows mode indicator (e.g., "COMPOSITOR" badge)
4. User presses next key:
   - H/J/K/L -> focus window in that direction
   - 1/2/3   -> focus window by index
   - N       -> create new window
   - X       -> close focused window
   - R       -> enter Resize mode
   - M       -> enter Move mode
   - S       -> enter Swap mode (select target window)
   - F       -> maximize/restore focused window
   - Escape  -> cancel, return to Normal mode
5. After action executes, Input Router returns to Normal mode
```

## Resize Mode Flow (e.g., Leader then R)

```
1. Input Router enters Resize mode
2. UI shows "RESIZE" indicator + edge highlight on focused window
3. User presses arrow keys repeatedly:
   - Right: grow width by step_size
   - Left:  shrink width by step_size
   - Down:  grow height by step_size
   - Up:    shrink height by step_size
   (step_size configurable, default 20px per keypress)
4. Window resizes in real-time, xterm.js addon-fit recalculates
5. Each resize step sends invoke("resize_pty", { window_id, rows, cols })
6. Enter or Escape exits Resize mode -> return to Normal mode
```

## Workspace Lifecycle Flow

### Startup

```
1. Krypton process starts
2. Config Manager loads krypton.toml (including keybindings, themes) into Arc<RwLock<KryptonConfig>>
3. Theme Engine initializes — embeds built-in themes (krypton-dark, legacy-radiance)
4. Tauri creates fullscreen, borderless, transparent native shell
5. Filesystem watcher starts on ~/.config/krypton/ (notify crate, 300ms debounce)
6. Frontend: FrontendThemeEngine calls invoke("get_theme") — backend resolves theme.name, applies [theme.colors] overrides
7. Frontend sets 50+ --krypton-* CSS custom properties on document.documentElement
8. Frontend loads config via invoke("get_config"), applies to compositor
9. Compositor creates first terminal window with themed xterm.js instance
10. Input Router initializes in Normal mode, first window focused
11. User sees themed windows on transparent desktop, keyboard-ready
```

### Theme Hot-Reload (user edits a .toml file)

```
1. notify crate detects .toml file change in ~/.config/krypton/
2. 300ms debounce timer elapses
3. Backend: reload_and_emit() re-parses krypton.toml, resolves theme by name
4. Backend: applies [theme.colors] overrides on top of resolved FullTheme
5. Backend: updates Arc<RwLock<KryptonConfig>> with new config
6. Backend: emits "theme-changed" Tauri event (payload: FullTheme)
7. Backend: emits "config-changed" Tauri event (payload: KryptonConfig)
8. Frontend: FrontendThemeEngine receives "theme-changed" event
9. Frontend: sets all --krypton-* CSS custom properties (instant CSS cascade)
10. Frontend: notifies compositor which updates terminal.options.theme on all open terminals
11. Result: window chrome + terminal colors update instantly without restart
```

### Workspace Switch (e.g., user presses CmdOrCtrl+2)

```
1. Input Router intercepts global hotkey CmdOrCtrl+2
2. Frontend sends invoke("switch_workspace", { name: "monitoring" })
3. Workspace Manager returns target workspace layout definition
4. Compositor diffs current workspace vs. target workspace:
   - Windows in both: animate from current to target position/size
   - Windows only in target workspace: create with entrance animation, spawn shell
   - Windows only in current workspace: hide with exit animation (PTY stays alive)
5. Animation engine plays workspace transition (keyboard input buffered)
6. After animation completes:
   - All xterm.js instances trigger addon-fit recalculation
   - Each window sends resize_pty for new dimensions
   - Buffered keyboard input delivered to newly focused window
   - Input Router returns to Normal mode
```

### Window-Session Relationship

```
 Active Workspace ("coding")                   Hidden (other workspaces)
+--Window 0 (focused)--+  +--Window 1------+  +--Window 2 (hidden)--+
|  Tab 0: PTY #0       |  |  Tab 0: PTY #2 |  |  Tab 0: PTY #4      |
|  Tab 1: PTY #1       |  |  Tab 1: PTY #3 |  |                     |
+-----------------------+  +----------------+  +---------------------+
         |                          |                    |
         v                          v                    v
+--------------------------------------------------------------+
|              Session Pool (Rust Backend)                      |
|  PTY #0  PTY #1  PTY #2  PTY #3  PTY #4                     |
+--------------------------------------------------------------+
```

Sessions live in a shared pool. Windows reference sessions by ID. When a workspace switch hides a window, its sessions remain alive in the pool. When the workspace becomes active again, windows reconnect to their sessions.
