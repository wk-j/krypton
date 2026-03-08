# 8. Milestones

| Phase | Deliverable | Target |
|-------|-------------|--------|
| **M0 — Scaffold** | Tauri project initialized, fullscreen transparent borderless shell, build pipeline on all 3 platforms. | Week 1-2 |
| **M1 — Single Session** | PTY spawn, raw I/O forwarded to xterm.js via Tauri IPC, working terminal in a single window. | Week 3-4 |
| **M2 — xterm.js Integration** | WebGL addon, fit addon, proper resize handling, SGR/truecolor validation, alternate screen buffer. | Week 5-7 |
| **M3 — Compositor & Windows** | Workspace rendering, window chrome, grid layout engine, keyboard focus navigation. | Week 8-11 |
| **M4 — Keyboard System & Workspaces** | Leader key, input router, mode system, command palette, workspace switching with animations, Quick Terminal overlay. | Week 12-15 |
| **M5 — Tabs & Panes** | Multi-tab per window, pane splits, keyboard tab/pane navigation, move tabs between windows. | Week 16-18 |
| **M6 — Config, Theming & Custom Themes** | TOML config, keybindings, theme engine, custom theme files, chrome styles, hot-reload. | Week 19-21 |
| **M7 — Sound Effects** | Procedural sound engine (Web Audio API, additive + subtractive synthesis), built-in Krypton Cyber sound pack, per-action sounds, configurable volume/toggle/per-event overrides. | Week 22-23 |
| **M8 — Polish** | Search, URL detection, IME, performance profiling, edge cases, bug fixes. | Week 24-27 |
| **M9 — Release** | Packaging (DMG, AppImage, MSI), documentation, first public release. | Week 28-30 |

## Milestone Details

### M0 — Scaffold (Week 1-2)
- Initialize Tauri v2 project with TypeScript frontend
- Configure Tauri window: fullscreen, borderless, transparent
- Verify transparent window renders correctly on macOS, Linux, Windows
- Set up CI/CD for all 3 platforms
- Install xterm.js and addons as frontend dependencies

### M1 — Single Session (Week 3-4)
- Implement PTY spawn via `portable-pty` in Rust backend
- Create Tauri commands: `spawn_pty`, `write_to_pty`, `resize_pty`
- Wire xterm.js `onData` -> IPC -> PTY write path
- Wire PTY read -> Tauri event -> `xterm.write()` path
- Render a single terminal window on the transparent workspace
- Verify interactive shell works (typing, output, ctrl+c)

### M2 — xterm.js Integration (Week 5-7)
- Enable `@xterm/addon-webgl` with canvas fallback
- Integrate `@xterm/addon-fit` for automatic resize
- Validate SGR rendering (colors, bold, italic, etc.)
- Test alternate screen buffer (vim, htop, less)
- Test truecolor output

### M3 — Compositor & Windows (Week 8-11)
- Build compositor layer: workspace as transparent fullscreen virtual desktop
- Window DOM structure: chrome, title bar, tab bar, xterm.js body
- Custom window chrome rendering (border, shadow, control buttons)
- Grid layout engine: resolve `{ col, row, col_span, row_span }` to screen coordinates
- Support absolute position overrides
- Keyboard-driven window focus: directional (H/J/K/L) and by index
- Window creation/close via keyboard
- Focus indicator (visual border/glow on active window)
- Ship built-in workspace presets
- Responsive recalculation on screen resolution change

### M4 — Keyboard System & Workspaces (Week 12-15)
- Implement Input Router with mode system (Normal, Compositor, Resize, Move)
- Leader key activation and single-action compositor mode
- Resize mode: arrow keys resize focused window, step size configurable
- Move mode: arrow keys reposition focused window
- Window swap via keyboard
- Window maximize/restore via keyboard
- Command palette: fuzzy search over all actions, display keybindings
- Workspace switching via hotkeys (`CmdOrCtrl+1/2/3`, next/prev)
- Animation engine: slide, crossfade, morph workspace transitions
- Configurable animation style, duration, easing
- Keyboard input buffering during transitions
- Session pool: preserve PTY sessions across workspace switches
- Mode indicator UI
- Quick Terminal: persistent overlay terminal toggled via `Cmd+I`, centered on screen, own PTY session, animated show/hide, does not participate in tiling layout

### M5 — Tabs & Panes (Week 16-18)
- Tab bar UI within each window (keyboard-navigable)
- Create/close/switch tabs via keyboard
- Move tab to another window via keybinding (`Leader T` then window index)
- Horizontal/vertical pane splits within a window
- Keyboard navigation between panes
- Session manager: track multiple PTY instances per window

### M6 — Config, Theming & Custom Themes (Week 19-21)
- TOML config parser with `serde` (keybindings, workspaces)
- Theme engine: load built-in themes + custom `.toml` files from themes directory
- Theme scope: terminal colors, window chrome, workspace background, UI elements
- Apply theme as CSS custom properties (instant update across all windows)
- Hot-reload via `notify` crate (config + theme files)
- Ship 3 built-in terminal themes (dark, light, solarized)
- Ship 3 built-in chrome styles (macos, minimal, none)
- Full keybinding customization with conflict detection
- Command palette theme switching

### M7 — Sound Effects (Week 22-23)
- Sound engine module (`src/sound.ts`): Web Audio API wrapper with single shared AudioContext
- Additive synthesis: multi-oscillator patch builder (sine, square, sawtooth, triangle, noise generators)
- Subtractive synthesis: filter chain (lowpass, highpass, bandpass, notch) with cutoff/Q envelopes
- ADSR amplitude envelope and pitch envelope automation
- FM synthesis support (oscillator-to-oscillator frequency modulation)
- Effects chain: reverb (ConvolverNode), delay (DelayNode), distortion (WaveShaperNode)
- Master channel: DynamicsCompressorNode limiter + GainNode volume control
- Built-in `krypton-cyber` sound pack: patches for all events (window create/close/focus, mode enter/exit, QT show/hide, startup, bell, etc.)
- Integration: compositor + input-router call `SoundEngine.play(eventName)` at each action point
- Configuration: `[sound]` TOML section (enabled, volume, pack, per-event overrides) applied via `applyConfig()`
- Custom sound pack loading from `~/.config/krypton/sounds/*.toml`
- Graceful degradation when Web Audio API is unavailable

### M8 — Polish (Week 24-27)
- `@xterm/addon-search` integration with keyboard-driven search overlay
- URL detection with keyboard-driven link opening
- IME support testing and fixes
- Performance profiling (latency, animation FPS, transparent rendering overhead, sound synthesis overhead)
- Edge cases: rapid workspace switching, many windows, large scrollback, resolution changes
- Bug fixes

### M9 — Release (Week 28-30)
- Platform packaging: DMG (macOS), AppImage/deb (Linux), MSI (Windows)
- Auto-update mechanism (Tauri updater)
- User documentation (keyboard cheat sheet, workspace config guide, custom theme guide, sound pack authoring guide)
- First public release
