# Implementation Progress

> Last updated: 2026-05-02 (OpenCode ACP default model selected by Krypton)

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
| M7 — Sound Effects | In Progress | 10/11 |
| M8 — Polish | In Progress | 17/18 |
| M9 — Release | Not Started | 0/4 |

---

## Recent Landings

- **ACP Harness view (Leader Y)** — multi-lane ACP orchestration tab that spawns the default same-project roster (Codex-1, Claude-1, Gemini-1, OpenCode-1 when installed), routes prompts to one active lane, displays a lane dashboard plus command center, handles per-lane permissions, and keeps tab-local shared memory extracted from completed tool observations and optional `MEMORY:` footer bullets. Built-in OpenCode lanes select `zai-coding-plan/glm-5.1` through ACP session configuration so Krypton owns the default lane model. See `docs/72-acp-harness-view.md`.
- **Pencil window (Leader e)** — embed `@excalidraw/excalidraw` as a new content view to open and edit `.excalidraw` files in-app. React + Excalidraw are lazy-loaded so the main bundle is unaffected. Picker scans `[pencil] dir` recursively (mtime sorted) with "+ New drawing" first row; opening the same file twice refocuses the existing tab. Autosave is debounced (800 ms) via `serializeAsJSON`; `Cmd+S` flushes immediately; atomic temp+rename in Rust. Theme follows Krypton bg luminance. See `docs/71-pencil-window.md`.
- **ACP agent windows (Leader A)** — second, parallel agent window backed by the [Agent Client Protocol](https://agentclientprotocol.com). Spawns built-in external adapters (Claude Code, Gemini CLI, Codex, OpenCode) over newline-delimited JSON-RPC and surfaces tool calls, plans, thoughts, and inline permission prompts. Lives in `src/acp/` + `src-tauri/src/acp.rs`; the existing pi-agent at `src/agent/` is untouched. See `docs/69-acp-agent-support.md`.
- **Quick file search (Cmd+O)** — global modal backed by `fff-search` with long-lived per-project pickers (LRU 8), persistent LMDB frecency, and `.git`-aware root resolution. Enter copies the relative path to the clipboard, Cmd+Enter copies the absolute path — never auto-pasted, so behavior is uniform across terminal/agent/hurl/markdown windows. **Tab toggles into grep mode** (content search reusing the same picker; copies `path:line:col`). See `docs/68-quick-file-search.md`.
- **Matrix glyph atlas** — per-frame `fillText` replaced with `drawImage` blits from a pre-rasterized `OffscreenCanvas`. Eliminates CoreText/GPU-process IPC from the hot path; matrix runs at 60 fps with single-digit CPU. See `docs/67-matrix-glyph-atlas.md`, `docs/64-matrix-animation-cpu-burn.md` (Phase 2).
- **Hurl client window** — keyboard-driven `.hurl` runner with tree sidebar, streaming output, per-file cache, and persistent sidebar state. See `docs/65-hurl-client-window.md`.

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

- [x] Sound engine: Rust backend (`src-tauri/src/sound.rs`) via `rodio` crate with dedicated audio thread. Replaced frontend Web Audio API for reliability. See `docs/17-sound-themes.md`
- [x] WAV-based sound packs (deep-glyph, mach-line) bundled as Tauri resources under `src-tauri/sounds/`
- [x] Frontend thin IPC wrapper (`src/sound.ts`): `play()` / `playKeypress()` call Tauri commands
- [x] 5 Tauri commands: `sound_play`, `sound_play_keypress`, `sound_apply_config`, `sound_load_pack`, `sound_get_packs`
- [x] Overlap management in Rust: MAX_CONCURRENT=8, keypress throttle 25ms, event cooldown 50ms
- [x] Integration: compositor + input-router call `SoundEngine.play()` at each action point (48 call sites unchanged)
- [x] Configuration: `[sound]` TOML section applied via `applyConfig()` — hot-reload updates Rust engine directly
- [x] Keypress sounds: per-key routing (Backspace/Enter/Space/Letter), configurable `keyboard_volume`
- [x] Sound theme switching via command palette
- [ ] Custom sound pack loading from `~/.config/krypton/sounds/`
- [x] Graceful degradation when no audio device is available

## M8 — Polish (Week 24-27)

- [x] Vim-like Selection mode (`src/selection.ts`) — keyboard-driven text selection with virtual cursor, h/j/k/l/w/b/e/0/$/gg/G navigation, v (char-wise) and V (line-wise) visual selection, y to yank to clipboard. Enter via `Leader v` or `Leader V`
- [x] Hint mode (`src/hints.ts`) — Rio-style pattern matching: `Cmd+Shift+H` or `Leader Shift+H` scans visible buffer for regex patterns (URLs, file paths, emails), overlays keyboard labels on matches, type label to act (Open/Copy/Paste). Configurable alphabet, rules, and per-rule actions via `[hints]` TOML config.
- [x] Terminal shader effects (`src/shaders.ts`) — CSS/SVG filter-based post-processing: 5 presets (crt, hologram, glitch, bloom, matrix) with scanlines, chromatic aberration, displacement, bloom glow. Per-pane ShaderInstance with overlay div + animated keyframes. Configurable via `[shader]` TOML section; `Leader g` cycles preset, `Leader G` toggles globally.
- [x] Progress bar via ConEmu `OSC 9;4` — Rust backend inline parser detects progress sequences in PTY output, emits `pty-progress` Tauri event. Frontend renders a large translucent SVG arc gauge centered in the window's content area behind terminal text (fills clockwise for normal progress, orbits for indeterminate, red for error, amber for paused) with percentage text, status labels, and a subtle titlebar scanline sweep. Per-window accent color aware. Used by Zig CLI, systemd, Amp, etc.
- [x] 3D perspective depth — CSS `perspective` on content containers with `translateZ` layering: terminal text at back (0), progress gauge mid (10px), shader overlay (20px), selection cursor/dividers at front (30px). Configurable via `[visual] perspective_depth` (default 800px, 0 = disabled). GPU-composited, hot-reloadable.
- [x] Context-aware extensions — process detection via `tcgetpgrp()` on PTY master fd (500ms poller), `ExtensionManager` activates built-in extensions when matching foreground processes are detected. First extension: **Java Resource Monitor** — top bar shows `[JAVA] MainClass PID`, bottom bar shows live `HEAP`, `GC`, `CPU%`, `RSS` stats via `jstat -gc` + `ps` (2s poll). Bars are real layout elements (not overlays), terminal resizes via `addon-fit`. Configurable via `[extensions] enabled/poll_interval_ms`.
- [x] Overlay dashboard infrastructure — `DashboardManager` framework (`src/dashboard.ts`) for registering and displaying full-screen overlay panels. Generic lifecycle (`onOpen`/`onClose`/`onKeyDown`), `Mode.Dashboard` input routing, CSS animated show/hide (z-index 9500), command palette integration. First dashboard: **Git Status** (`Cmd+Shift+G`) — shows current branch, staged/modified/untracked/deleted file counts, and changed file list. Uses new `run_command` Tauri command for non-PTY subprocess execution.
- [x] OpenCode Dashboard (`Cmd+Shift+O`) — reads OpenCode's local SQLite database (`~/.local/share/opencode/opencode.db`) via new `query_sqlite` Tauri command (`rusqlite`, read-only). Displays: aggregate stats (sessions, messages, output tokens, cache reads, cost), 20 most recent sessions with message counts/tokens/diffs/duration, model usage breakdown (model, provider, count, output tokens), and top 15 tool usage with bar chart. New `query_sqlite` command: generic read-only SQLite query executor with write-statement rejection, 1000-row limit, 5-second busy timeout.
- [ ] `@xterm/addon-search` integration with keyboard-driven search overlay
- [ ] IME support testing and fixes
- [ ] Performance profiling (latency, animation FPS, transparent rendering overhead)
- [x] Fix macOS transparency freeze — removed `backdrop-filter: blur()` from all elements (`.krypton-window`, Quick Terminal, which-key, command palette, dashboard, hint-toast). On macOS, `backdrop-filter` in a transparent WKWebView causes the compositor to snapshot/freeze the desktop behind terminal windows when focused. Also added `.xterm-scrollable-element` CSS override to fix xterm.js setting opaque inline `backgroundColor`. See platform gotcha in `docs/04-architecture.md`.
- [x] Sound engine moved to Rust backend — replaced frontend Web Audio API with `rodio` crate on dedicated audio thread. WAV packs bundled as Tauri resources under `src-tauri/sounds/`. Frontend is thin IPC wrapper. See `docs/17-sound-themes.md`.
- [x] SSH session multiplexing — detect active SSH connections in terminal panes via process tree inspection (`SshManager` in `src-tauri/src/ssh.rs`), clone sessions using OpenSSH `ControlMaster` auto-multiplexing. **Remote CWD inheritance**: cloned sessions start in the same directory via invisible PTY probe (`stty -echo` + OSC 7337 private escape sequence); passive OSC 7 hostname filtering as fallback (uses `hostname` crate to distinguish local vs remote CWD). Keybindings: `Leader c` (clone to new tab), `Leader Shift+C` (clone to new window). Command palette actions. Titlebar shows `SSH: user@host`. Config: `[ssh]` section with `enabled`, `control_persist`, `clone_target`. Socket dir: `~/.config/krypton/ssh-sockets/`. See `docs/28-ssh-session-multiplexing.md`.
- [x] Notification overlay (`src/notification.ts`) — `NotificationController` with glitch-decode text animation, per-level color coding (info/success/warning/error/system), auto-dismiss with timer bar, max 6 stacked. OSC detection (OSC 9, 777, 99/kitty) via `terminal.parser.registerOscHandler()`. Container mounted on `document.body` with `position: fixed`, repositioned via `alignTo()` to anchor to focused window bounds. Programmatic API for any frontend subsystem. See `docs/40-notification-overlay.md`.
- [x] Cursor trail — rainbow flame particle effect (`src/cursor-trail.ts`) on both mouse cursor (document-level `mousemove` capture) and terminal text cursor (polls `buffer.active.cursorX/Y` via compositor). Particles drift upward with turbulence, cycle rainbow hues, fade with quadratic falloff. Teardrop-shaped with radial gradient + glow. Appended to `document.body` (z-index 99999). Togglable via `toggle()`.
- [x] Agent markdown visual effects — futuristic CSS effects on AI response rendering: scanline overlay + materialize animation on assistant messages, neon glow pulse on headings, animated edge-sweep on code blocks, holographic shimmer on blockquotes, traveling pulse on horizontal rules, hover-highlight on table rows, custom `▸` bullets, neon glow on inline code/links/bold. All pure CSS, GPU-composited, theme-aware via `--krypton-window-accent-rgb`. See agent markdown effects section in `docs/42-pi-agent-integration.md`.
- [x] Smart Prompt Dialog (`src/prompt-dialog.ts`) — global modal (`Cmd+Shift+K`) that composes a prompt and dispatches it to an active `claude` terminal tab via `write_to_pty`. Auto-detects Claude sessions through the `process-changed` event + `processBySession` cache on Compositor. Persistent target chip shows `→ Claude <cwd> pid <N>` with `Cmd+,` to reopen the picker (arrow/1-9/Enter/Esc) when multiple sessions exist. Supports `@path` autocomplete via existing `search_files` command (fuzzy-matched, cached per CWD with 10s TTL, positioned via mirrored-div caret helper in `src/caret-position.ts`), `@selection` inline-expanded from the focused xterm selection. Last-used target remembered across opens within the session. Target window gets a 600ms accent-glow flash on dispatch. New `Mode.PromptDialog`, magenta-accented dialog chrome to visually distinguish from the cyan command palette. See `docs/61-smart-prompt-dialog.md`.
- [x] Agent image attachment — paste (Cmd+V) or drag-drop images into agent windows. Up to 4 images staged as thumbnails above the input line, sent as multi-part `UserMessage` to vision-capable models. Vision gated by `vision = true` in TOML model preset. Non-vision models warned at submit time. Images stripped from JSONL session persistence (placeholder `[N images attached]` saved instead). See `docs/62-agent-image-attachment.md`.
- [x] Matrix animation CPU burn fix — OffscreenCanvas `fillText` on macOS WebKit has no glyph cache and IPCs per draw, so matrix/brainwave renderers were burning ~50–60% CPU per window when Claude was processing. Two fixes: (1) per-renderer frame cap in `animation-worker.ts` (matrix/brainwave/circuit-trace at 30 fps, flame at 60) — ~2× CPU reduction for the expensive renderers; (2) idle-timeout safety net in `claude-hooks.ts` that auto-stops the animation 60 s after the last hook event, preventing orphaned animations when `Stop`/`SessionEnd` hooks are dropped (crash, Ctrl+C, HTTP failure). See `docs/64-matrix-animation-cpu-burn.md`.
- [x] Agent `@path` fuzzy file search — typing `@` in the agent window's prompt input opens a fuzzy-ranked file picker scoped to the active `projectDir`. Uses the existing `search_files` Tauri command (respects `.gitignore`, caps 50k entries) cached per directory with 10 s TTL and shared with the Smart Prompt Dialog. `@` must be at start-of-line or preceded by whitespace. Tab/Enter accept, Esc dismisses, arrow keys navigate the dropdown. Takes precedence over the slash-command autocomplete; reuses the amber-phosphor dropdown aesthetic. Implemented in `src/agent/agent-view.ts` (`updateMentionState`, `rankMentionFiles`, `renderMentionPopup`, `acceptMention`) with matching CSS in `src/styles/agent.css`.
- [x] ACP Harness view — `Leader Y` / command palette opens a multi-lane ACP content tab for the focused CWD. The harness owns independent ACP clients, per-lane drafts and permissions, active-lane-only prompt dispatch, and dashboard transcript rendering. See `docs/72-acp-harness-view.md`.
- [x] ACP Harness MCP memory — the harness creates a tab-local memory store on the existing localhost hook server, passes lane-scoped HTTP MCP descriptors through ACP `session/new.mcpServers`, injects latest summaries, and renders a read-only observer memory board while agents manage create/update/delete/search/get themselves. See `docs/73-acp-harness-mcp-memory.md`.
- [x] ACP Harness memory persistence — lane memory is saved to per-project-dir JSON files under `~/.config/krypton/acp-harness-memory/` and restored on next harness creation for the same directory. Debounced atomic writes on change. See `docs/76-acp-harness-memory-persistence.md`.
- [ ] Edge cases: rapid workspace switching, many windows, large scrollback, resolution changes
- [ ] Bug fixes

## M9 — Release (Week 28-30)

- [ ] Platform packaging: DMG (macOS), AppImage/deb (Linux), MSI (Windows)
- [ ] Auto-update mechanism (Tauri updater)
- [ ] User documentation (keyboard cheat sheet, workspace config guide, custom theme guide, sound pack authoring guide) — theme specification draft created (`docs/10-theme-specification.md`)
- [ ] First public release
