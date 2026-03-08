# Implementation Progress

> Last updated: 2026-03-08 (Quick Terminal)

## Overview

| Milestone | Status | Progress |
|-----------|--------|----------|
| M0 — Scaffold | Complete | 5/5 |
| M1 — Single Session | Complete | 6/6 |
| M2 — xterm.js Integration | Complete | 5/5 |
| M3 — Compositor & Windows | In Progress | 8/10 |
| M4 — Keyboard System & Workspaces | In Progress | 11/14 |
| M5 — Tabs & Panes | Not Started | 0/6 |
| M6 — Config, Theming & Custom Themes | Not Started | 0/9 |
| M7 — Polish | Not Started | 0/6 |
| M8 — Release | Not Started | 0/4 |

---

## M0 — Scaffold (Week 1-2)

- [x] Initialize Tauri v2 project with TypeScript frontend
- [x] Install xterm.js and addons as frontend dependencies
- [x] Configure Tauri window: fullscreen, borderless, transparent
- [x] Set up frontend build pipeline (Vite + TypeScript, transparent HTML/CSS shell)
- [x] Verify transparent window renders correctly on macOS

## M1 — Single Session (Week 3-4)

- [x] Implement PTY spawn via `portable-pty` in Rust backend
- [x] Create Tauri commands: `spawn_pty`, `write_to_pty`, `resize_pty`
- [x] Wire xterm.js `onData` -> IPC -> PTY write path
- [x] Wire PTY read -> Tauri event -> `xterm.write()` path
- [x] Render a single terminal window on the transparent workspace
- [x] Verify interactive shell works (typing, output, ctrl+c)

## M2 — xterm.js Integration (Week 5-7)

- [x] Enable `@xterm/addon-webgl` with canvas fallback
- [x] Integrate `@xterm/addon-fit` for automatic resize
- [x] Validate SGR rendering (colors, bold, italic, etc.)
- [x] Test alternate screen buffer (vim, htop, less)
- [x] Test truecolor output

## M3 — Compositor & Windows (Week 8-11)

- [x] Build compositor layer: workspace as transparent fullscreen virtual desktop
- [x] Window DOM structure: cyberpunk chrome with titlebar (session label + status dot + PTY status), content area (xterm.js body + sidebar decoration), bottom bar
- [x] Custom window chrome rendering — sci-fi style with glowing cyan borders, telemetry sidebar, bottom bar decorations
- [x] Grid layout engine: resolve `{ col, row, col_span, row_span }` to screen coordinates
- [ ] Support absolute position overrides
- [x] Keyboard-driven window focus: directional (H/J/K/L) and by index
- [x] Window creation/close via keyboard
- [x] Focus indicator — cyan border glow + box-shadow on focused window, dimmed borders on unfocused
- [x] Ship built-in workspace presets — Focus Layout: focused window left (full height), remaining stacked right; toggle via `Leader f`
- [ ] Responsive recalculation on screen resolution change — basic version done, needs testing

## M4 — Keyboard System & Workspaces (Week 12-15)

- [x] Implement Input Router with mode system (Normal, Compositor, Resize, Move, Swap)
- [x] Leader key activation and single-action compositor mode
- [x] Resize mode: arrow keys resize focused window, step size configurable
- [x] Move mode: arrow keys reposition focused window
- [x] Window swap via keyboard (Leader+s then direction h/j/k/l)
- [x] Window maximize/restore via keyboard (Leader+z toggle)
- [ ] Command palette: fuzzy search over all actions, display keybindings
- [ ] Workspace switching via hotkeys (`CmdOrCtrl+1/2/3`, next/prev)
- [x] Animation engine: morph (bounds transition), slide (horizontal), crossfade (opacity), window entrance/exit effects
- [x] Configurable animation style, duration, easing (AnimationConfig with AnimationStyle, AnimationEasing, WindowEffect enums)
- [x] Keyboard input buffering during transitions (buffered in Normal mode, replayed after animation)
- [ ] Session pool: preserve PTY sessions across workspace switches
- [x] Mode indicator UI
- [x] Quick Terminal: persistent overlay terminal (Cmd+I toggle), centered on screen, own PTY, animated show/hide

## M5 — Tabs & Panes (Week 16-18)

- [ ] Tab bar UI within each window (keyboard-navigable)
- [ ] Create/close/switch tabs via keyboard
- [ ] Move tab to another window via keybinding (`Leader T` then window index)
- [ ] Horizontal/vertical pane splits within a window
- [ ] Keyboard navigation between panes
- [ ] Session manager: track multiple PTY instances per window

## M6 — Config, Theming & Custom Themes (Week 19-21)

- [ ] TOML config parser with `serde` (keybindings, workspaces)
- [ ] Theme engine: load built-in themes + custom `.toml` files from themes directory
- [ ] Theme scope: terminal colors, window chrome, workspace background, UI elements
- [ ] Apply theme as CSS custom properties (instant update across all windows)
- [ ] Hot-reload via `notify` crate (config + theme files)
- [ ] Ship 3 built-in terminal themes (dark, light, solarized)
- [ ] Ship 3 built-in chrome styles (macos, minimal, none)
- [ ] Full keybinding customization with conflict detection
- [ ] Command palette theme switching

## M7 — Polish (Week 22-25)

- [ ] `@xterm/addon-search` integration with keyboard-driven search overlay
- [ ] URL detection with keyboard-driven link opening
- [ ] IME support testing and fixes
- [ ] Performance profiling (latency, animation FPS, transparent rendering overhead)
- [ ] Edge cases: rapid workspace switching, many windows, large scrollback, resolution changes
- [ ] Bug fixes

## M8 — Release (Week 26-28)

- [ ] Platform packaging: DMG (macOS), AppImage/deb (Linux), MSI (Windows)
- [ ] Auto-update mechanism (Tauri updater)
- [ ] User documentation (keyboard cheat sheet, workspace config guide, custom theme guide)
- [ ] First public release
