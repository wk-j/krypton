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
|  +---------------+ +------------+                                       |
|  | Theme         | | VT Parser  |                                       |
|  | Engine        | | (vte)      |                                       |
|  +---------------+ +------------+                                       |
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
| `notify` | Filesystem watcher for config hot-reload | Planned |
| `unicode-width` | Character width calculation for CJK / emoji | Planned |
| `display-info` | Query monitor geometry for fullscreen dimensions | Planned |

## 5.2 Key Frontend Packages (npm)

| Package | Purpose |
|---------|---------|
| `@xterm/xterm` | Core terminal emulator library |
| `@xterm/addon-webgl` | WebGL-based renderer for GPU-accelerated drawing |
| `@xterm/addon-fit` | Auto-fit terminal dimensions to container |
| `@xterm/addon-search` | In-terminal text search |
| `@xterm/addon-web-links` | Clickable URL detection |
| `@xterm/addon-unicode11` | Proper Unicode width handling |

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
10. **Chrome rendering** — cyberpunk/sci-fi window chrome with glowing cyan borders, session label with status dot, PTY status indicator, right sidebar with telemetry decoration, and bottom bar
11. **Optional mouse handling** — secondary drag/resize/click interactions for users who prefer mouse

### Window DOM Structure

Krypton uses a cyberpunk/sci-fi chrome style. Each window has a titlebar with session label and PTY status, a content area with the terminal body and a right sidebar decoration, and a bottom bar.

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
          <span class="krypton-window__pty-status">PTY_STREAMS // ACTIVE</span>
        </div>
      </div>
      <div class="krypton-window__content">
        <div class="krypton-window__body">
          <!-- xterm.js mounts here -->
        </div>
        <div class="krypton-window__sidebar">
          <div class="krypton-window__sidebar-dot"></div>
          <div class="krypton-window__sidebar-dot"></div>
          <div class="krypton-window__sidebar-text">TELEMETRY_DATA</div>
        </div>
      </div>
      <div class="krypton-window__bottombar">
        <div class="krypton-window__bottom-decoration">
          <div class="krypton-window__bottom-line"></div>
          <div class="krypton-window__bottom-line"></div>
        </div>
      </div>
    </div>

    <!-- More windows... -->

    <!-- Quick Terminal (overlay, toggled via Cmd+I) -->
    <div class="krypton-quick-terminal" id="quick-terminal"
         style="position: absolute; z-index: 5000; display: none;">
      <!-- Same chrome structure as regular windows -->
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
          <!-- xterm.js mounts here -->
        </div>
      </div>
    </div>

    <!-- Which-key popup (shown during compositor/resize/move modes) -->
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
- **IPC**: `get_config` Tauri command returns the full `KryptonConfig` to the frontend on startup.
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

### Theme Engine (Backend)

The Theme Engine lives in Rust and manages theme loading:

- Parse built-in themes embedded in the binary
- Scan `~/.config/krypton/themes/*.toml` for custom theme files
- Validate theme structure, fill in defaults for missing properties
- Serve theme data to the frontend via `invoke("get_theme", { name })` or Tauri event on hot-reload
- The frontend applies theme values as CSS custom properties (`--window-border-color`, `--titlebar-bg`, etc.) so that all windows update instantly

## 5.6 Input Router & Mode System (Frontend)

The input router is the central keyboard dispatcher. It determines what happens with each keypress based on the current **mode**:

### Modes

| Mode | Activated by | Behavior | Exit |
|------|-------------|----------|------|
| **Normal** | Default | Keypresses forwarded to focused window's PTY | Enter another mode via leader key |
| **Compositor** | Leader key (`Cmd+P`) | Keypresses interpreted as compositor commands (focus window, toggle layout, switch workspace, open command palette) | Auto-exits after one action, or `Escape` to cancel |
| **Resize** | `Leader` then `R` | Arrow keys resize the focused window; step size configurable | `Escape` or `Enter` to confirm |
| **Move** | `Leader` then `M` | Arrow keys reposition the focused window | `Escape` or `Enter` to confirm |
| **Command Palette** | `CmdOrCtrl+Shift+P` | Text input filters the action list; Enter executes; Escape closes | `Escape` or action execution |
| **Search** | `CmdOrCtrl+F` | Text input searches scrollback in the focused window | `Escape` to close |

**Global hotkeys that work from any mode:**
- `Cmd+I` — Toggle Quick Terminal (show/hide centered overlay terminal)
- `Cmd+Shift+<` / `Cmd+Shift+>` — Cycle focus through windows
- `Ctrl+Shift+U` / `Ctrl+Shift+D` — Scroll terminal buffer up/down by one page

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
  +-- Cmd Palette ---> Filter/select action list
  +-- Search --------> Update search query
```

### Command Palette

The command palette is a fuzzy-searchable overlay listing **every action** in Krypton:

- Window actions: new, close, focus next/prev, focus by index, maximize, restore, swap, reset layout, toggle focus layout
- Tab actions: new, close, next/prev, move to window
- Workspace actions: switch by name, next/prev workspace
- Pane actions: split horizontal/vertical, close, navigate
- Theme actions: switch theme
- Clipboard: copy, paste
- Search: open search, next/prev match
- Config: reload config, open config file
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

## 5.8 Sound Engine (Frontend)

A dedicated TypeScript module (`src/sound.ts`) that synthesizes and plays short sound effects for every user action using the Web Audio API. No audio files — all sounds are generated procedurally at runtime via **additive and subtractive functional synthesis**.

### Architecture

```
Action (compositor/input-router event)
  |
  v
SoundEngine.play('window.create')
  |
  v
[Patch Lookup] — resolve event name to a SoundPatch definition
  |
  v
[Oscillator Graph Construction]
  |  - Create OscillatorNodes (sine/square/sawtooth/triangle/noise)
  |  - Set frequencies, detune, amplitudes per partial (ADDITIVE)
  |  - Connect through BiquadFilterNodes (lowpass/highpass/bandpass) (SUBTRACTIVE)
  |  - Apply ADSR envelope via GainNode automation (setValueAtTime / linearRampToValueAtTime)
  |  - Optional: pitch envelope via frequency automation
  |  - Optional: FM synthesis (oscillator -> gain -> target oscillator.frequency)
  |  - Optional: effects chain (ConvolverNode for reverb, DelayNode, WaveShaperNode for distortion)
  |
  v
[Master Channel]
  |  - DynamicsCompressorNode (limiter to prevent clipping on simultaneous sounds)
  |  - GainNode (master volume from config)
  |
  v
AudioContext.destination (speakers)
```

### Key Design Decisions

- **Single AudioContext** — lazily created on first user interaction (browser autoplay policy). Reused for all subsequent sounds. Never closed during app lifetime.
- **Ephemeral nodes** — each `play()` call creates a short-lived subgraph of oscillators, gains, and filters. Nodes are scheduled to stop via `OscillatorNode.stop(endTime)` and auto-disconnect after completion. No persistent audio graph.
- **Non-blocking** — all scheduling uses `AudioContext.currentTime` offsets. No `setTimeout` or `requestAnimationFrame` for audio timing. The audio thread runs independently from the main thread.
- **Patch definitions** — each sound is a plain object (or TOML-serializable struct) describing oscillators, filters, envelopes, and effects. This makes them configurable and replaceable via custom sound packs.
- **Graceful degradation** — if `AudioContext` is unavailable or construction fails, the engine silently becomes a no-op. All `play()` calls are guarded.

### SoundPatch Data Model

```typescript
interface SoundPatch {
  oscillators: Array<{
    waveform: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'white-noise' | 'pink-noise';
    frequency: number;          // Hz (or relative: 'fundamental', '2x', '3x', etc.)
    amplitude: number;          // 0.0 - 1.0
    detune?: number;            // cents
    pitchEnvelope?: { start: number; end: number; duration: number };
    fm?: { modulatorIndex: number; depth: number };  // FM synthesis
  }>;
  filter?: {
    type: 'lowpass' | 'highpass' | 'bandpass' | 'notch';
    cutoff: number;             // Hz
    Q: number;                  // resonance
    envelope?: { start: number; end: number; duration: number };  // cutoff sweep
  };
  envelope: {
    attack: number;             // seconds
    decay: number;              // seconds
    sustain: number;            // 0.0 - 1.0
    release: number;            // seconds
  };
  effects?: {
    reverb?: { duration: number; decay: number };
    delay?: { time: number; feedback: number };
    distortion?: { amount: number };  // WaveShaperNode curve
  };
  pan?: number;                 // -1.0 (left) to 1.0 (right)
}
```

### Integration Points

The Sound Engine is called by the compositor and input router at the moment each action occurs:

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
