# Implementation Progress

> Last updated: 2026-03-13 (M8: Progress bar — OSC 9;4 status dot arc gauge)

## Overview

| Milestone | Status | Progress |
|-----------|--------|----------|
| M0 — Scaffold | Complete | 5/5 |
| M1 — Single Session | Complete | 6/6 |
| M2 — xterm.js Integration | Complete | 5/5 |
| M3 — Compositor & Windows | In Progress | 9/11 |
| M4 — Keyboard System & Workspaces | In Progress | 12/14 |
| M5 — Tabs & Panes | Complete | 6/6 |
| M6 — Config, Theming & Custom Themes | In Progress | 7/9 |
| M7 — Sound Effects | In Progress | 14/15 |
| M8 — Polish | In Progress | 5/9 |
| M9 — Release | Not Started | 0/4 |

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
- [x] Window DOM structure: cyberpunk chrome with titlebar (dynamic shell title via OSC + CWD status + status dot), content area (xterm.js body + sidebar decoration), bottom bar
- [x] Custom window chrome rendering — sci-fi style with glowing cyan borders, telemetry sidebar, bottom bar decorations
- [x] Grid layout engine: resolve `{ col, row, col_span, row_span }` to screen coordinates
- [ ] Support absolute position overrides
- [x] Keyboard-driven window focus: directional (H/J/K/L) and by index
- [x] Window creation/close via keyboard
- [x] Focus indicator — cyan border glow + box-shadow on focused window, dimmed borders on unfocused
- [x] Ship built-in workspace presets — Focus Layout: focused window left (full height), remaining stacked right; toggle via `Leader f`
- [x] Pin windows — `Leader p` toggles pin on focused window; pinned windows stick to right column in Focus layout, skipped during focus cycling; visual indicator (diamond icon) in title bar; pin/unpin sound effects; CSS class `krypton-window--pinned`
- [ ] Responsive recalculation on screen resolution change — basic version done, needs testing

## M4 — Keyboard System & Workspaces (Week 12-15)

- [x] Implement Input Router with mode system (Normal, Compositor, Resize, Move, Swap, CommandPalette)
- [x] Leader key activation and single-action compositor mode
- [x] Resize mode: arrow keys resize focused window, step size configurable
- [x] Move mode: arrow keys reposition focused window
- [x] Window swap via keyboard (Leader+s then direction h/j/k/l)
- [x] Window maximize/restore via keyboard (Leader+z toggle)
- [x] Command palette: fuzzy-searchable overlay (`Cmd+Shift+P`) listing all actions with keybindings, fuzzy subsequence matching with score-based ranking, category tags, highlighted match characters. `src/command-palette.ts` module with action registry for Window/Tab/Pane/Layout/Mode/Terminal categories (~35 actions)
- [ ] Workspace switching via hotkeys (`CmdOrCtrl+1/2/3`, next/prev)
- [x] Animation engine: morph (bounds transition), slide (horizontal), crossfade (opacity), window entrance/exit effects
- [x] Configurable animation style, duration, easing (AnimationConfig with AnimationStyle, AnimationEasing, WindowEffect enums)
- [x] Keyboard input buffering during transitions (buffered in Normal mode, replayed after animation)
- [ ] Session pool: preserve PTY sessions across workspace switches
- [x] Mode indicator UI
- [x] Quick Terminal: persistent overlay terminal (Cmd+I toggle), centered on screen, own PTY, animated show/hide

## M5 — Tabs & Panes (Week 16-18)

- [x] Tab bar UI within each window (keyboard-navigable) — `.krypton-window__tabbar` with tab elements, active indicator, auto-show when >1 tab (configurable via `always_show_tabbar`)
- [x] Create/close/switch tabs via keyboard — `Leader t` (create), `Leader w` (close), `Leader [/]` (prev/next)
- [x] Move tab to another window via keybinding (`Leader T` then window index) — enters TabMove mode, press 1-9 to select target window
- [x] Horizontal/vertical pane splits within a window — `Leader \` (vertical), `Leader -` (horizontal); binary tree of splits with configurable default direction
- [x] Keyboard navigation between panes — `Leader Alt+h/j/k/l` (directional), `Leader Alt+x` (close pane); spatial nearest-neighbor search
- [x] Session manager: track multiple PTY instances per window — `sessionMap: Map<SessionId, {windowId, tabId, paneId}>` for O(1) PTY output routing; each pane owns its own PTY session

## M6 — Config, Theming & Custom Themes (Week 19-21)

- [x] TOML config parser with `serde` — loads `~/.config/krypton/krypton.toml`, creates default on first run, merges with defaults for missing fields
- [x] Config applied to frontend: shell program/args, font (family/size/line_height), terminal (scrollback/cursor_style/cursor_blink), theme color overrides, Quick Terminal sizing, workspace gap/step sizes
- [x] Theme engine: load built-in themes + custom `.toml` files from themes directory — `src-tauri/src/theme.rs` embeds built-in themes via `include_str!`, resolves by `theme.name`, supports custom themes from `~/.config/krypton/themes/*.toml`, applies `[theme.colors]` overrides on top
- [x] Theme scope: terminal colors, window chrome, workspace background, UI elements — full theme TOML structure (meta, colors, chrome, focused, workspace, ui) parsed and sent to frontend as `FullTheme`
- [x] Apply theme as CSS custom properties (instant update across all windows) — `FrontendThemeEngine` sets 50+ `--krypton-*` CSS custom properties on `document.documentElement`; `styles.css` uses `var()` throughout; existing xterm.js terminals updated via `terminal.options.theme` on change
- [x] Hot-reload via `notify` crate (config + theme files) — filesystem watcher on `~/.config/krypton/` with 300ms debounce; emits `theme-changed` and `config-changed` Tauri events; frontend listens and applies instantly
- [x] Per-window accent colors — 10-color cyberpunk palette (cyan, magenta, amber, green, violet, orange, pink, teal, gold, red); each window gets a unique color for chrome, borders, corners, tabs; colors recycled on window close
- [ ] Ship built-in terminal themes (dark, light, solarized, legacy-radiance) — krypton-dark and legacy-radiance TOML files created and loaded by engine; krypton-light and solarized not yet created
- [ ] Ship 3 built-in chrome styles (macos, minimal, none)
- [ ] Full keybinding customization with conflict detection
- [ ] Command palette theme switching

## M7 — Sound Effects (Week 22-23)

- [x] Sound engine module (`src/sound.ts`): Web Audio API wrapper with single shared AudioContext
- [x] Additive synthesis: multi-oscillator patch builder (sine, square, sawtooth, triangle, noise generators)
- [x] Subtractive synthesis: filter chain (lowpass, highpass, bandpass, notch) with cutoff/Q envelopes
- [x] ADSR amplitude envelope and pitch envelope automation
- [x] FM synthesis support (oscillator-to-oscillator frequency modulation)
- [x] Effects chain: reverb, delay, distortion
- [x] Master channel: DynamicsCompressorNode limiter + GainNode volume control
- [x] Built-in `krypton-cyber` sound pack: patches for all action events
- [x] Integration: compositor + input-router call `SoundEngine.play()` at each action point
- [x] Configuration: `[sound]` TOML section applied via `applyConfig()`
- [x] Keypress sounds: 6 keyboard types (cherry-mx-blue, cherry-mx-red, cherry-mx-brown, topre, buckling-spring, membrane) with press/release phases, amplitude/filter randomization, configurable via `keyboard_type` and `keyboard_volume`
- [x] Sound theme system: ghost-signal integration with 5 built-in themes (ghost-signal, chill-city-fm, orbit-deck, mach-line, deep-glyph), per-key typing sound routing, command palette switching, proxy AudioContext for volume control
- [ ] Custom sound pack loading from `~/.config/krypton/sounds/*.toml`
- [x] Graceful degradation when Web Audio API is unavailable

## M8 — Polish (Week 24-27)

- [x] Vim-like Selection mode (`src/selection.ts`) — keyboard-driven text selection with virtual cursor, h/j/k/l/w/b/e/0/$/gg/G navigation, v (char-wise) and V (line-wise) visual selection, y to yank to clipboard. Enter via `Leader v` or `Leader V`
- [x] Hint mode (`src/hints.ts`) — Rio-style pattern matching: `Cmd+Shift+H` or `Leader Shift+H` scans visible buffer for regex patterns (URLs, file paths, emails), overlays keyboard labels on matches, type label to act (Open/Copy/Paste). Configurable alphabet, rules, and per-rule actions via `[hints]` TOML config.
- [x] Terminal shader effects (`src/shaders.ts`) — CSS/SVG filter-based post-processing: 5 presets (crt, hologram, glitch, bloom, matrix) with scanlines, chromatic aberration, displacement, bloom glow. Per-pane ShaderInstance with overlay div + animated keyframes. Configurable via `[shader]` TOML section; `Leader g` cycles preset, `Leader G` toggles globally.
- [x] Progress bar via ConEmu `OSC 9;4` — Rust backend inline parser detects progress sequences in PTY output, emits `pty-progress` Tauri event. Frontend renders a radial SVG arc gauge around the window's status dot (fills clockwise for normal progress, orbits for indeterminate, red for error, amber for paused) with a subtle titlebar scanline sweep. Per-window accent color aware. Used by Zig CLI, systemd, Amp, etc.
- [ ] `@xterm/addon-search` integration with keyboard-driven search overlay
- [ ] IME support testing and fixes
- [ ] Performance profiling (latency, animation FPS, transparent rendering overhead, sound synthesis overhead)
- [ ] Edge cases: rapid workspace switching, many windows, large scrollback, resolution changes
- [ ] Bug fixes

## M9 — Release (Week 28-30)

- [ ] Platform packaging: DMG (macOS), AppImage/deb (Linux), MSI (Windows)
- [ ] Auto-update mechanism (Tauri updater)
- [ ] User documentation (keyboard cheat sheet, workspace config guide, custom theme guide, sound pack authoring guide) — theme specification draft created (`docs/10-theme-specification.md`)
- [ ] First public release
