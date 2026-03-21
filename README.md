# Krypton

A keyboard-driven terminal emulator with a cyberpunk aesthetic. Built with Rust + Tauri v2 and TypeScript + xterm.js.

Single transparent native window. Multiple terminal windows rendered as DOM elements with custom chrome. Tiling layout engine. Vim-style modal keyboard system. Sound effects. Shader post-processing. Claude Code integration.

![](./docs/images/SCR-20260312-maqq.png)

## Features

- **Transparent workspace** -- fullscreen borderless window with DOM-based terminal windows
- **Tiling layouts** -- Grid (auto-tile balanced) and Focus (65/35 split with pinned windows on right)
- **Modal keyboard system** -- Normal, Compositor, Resize, Move, Swap, Selection, Hint, TabMove, CommandPalette, Dashboard modes
- **Tabs & panes** -- split terminals horizontally/vertically within a window, tab bar with keyboard navigation
- **Which-key popup** -- Helix-style hint overlay showing available keybindings per mode
- **Command palette** -- fuzzy-searchable action list (`Cmd+Shift+P`) with ~35 registered actions
- **Quick Terminal** -- persistent overlay terminal toggled with `Cmd+I`
- **Animation engine** -- morph, slide, crossfade transitions with entrance/exit effects and input buffering
- **Cyberpunk HUD chrome** -- glowing borders, L-shaped corner accents, striped header bars, telemetry sidebar
- **Sound effects** -- 20+ event-driven sounds (window create/close, mode enter/exit, focus, tabs, panes) via rodio
- **Shader effects** -- post-processing presets: CRT, hologram, glitch, bloom, matrix
- **Hint mode** -- regex-pattern matching with keyboard label overlays for quick selection
- **Selection mode** -- vim-like keyboard-driven text selection (char/line-wise)
- **Pin windows** -- pinned windows stick to right column in Focus layout, skipped during focus cycling
- **Theming** -- built-in themes + custom TOML themes in `~/.config/krypton/themes/`, hot-reloaded
- **SSH support** -- connection detection and OpenSSH ControlMaster multiplexing
- **Claude Code hooks** -- HTTP server receives Claude Code events, renders neural uplink bar, sigil badge, tool HUD, activity trace, and notification toasts in the window chrome
- **Dashboard system** -- tabbed overlay dashboards (Git, OpenCode) with keyboard routing
- **Extensions** -- context-aware plugins that activate on process detection
- **Cursor trail** -- rainbow flame particle system on mouse and text cursor

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+P` | Leader key (enter Compositor mode) |
| `Cmd+I` | Toggle Quick Terminal |
| `Cmd+Shift+P` | Command palette |
| `Cmd+Shift+<` / `>` | Cycle focus between windows |
| `Ctrl+Shift+U` / `D` | Scroll buffer up/down one page |
| Leader + `n` | New window |
| Leader + `x` | Close window |
| Leader + `f` | Toggle Focus/Grid layout |
| Leader + `z` | Toggle maximize |
| Leader + `p` | Toggle pin on focused window |
| Leader + `h/j/k/l` | Focus window by direction |
| Leader + `r` | Enter Resize mode |
| Leader + `m` | Enter Move mode |
| Leader + `s` | Enter Swap mode |
| Leader + `t` | New tab |
| Leader + `\` / `-` | Split pane vertical / horizontal |
| `Escape` | Exit current mode / hide Quick Terminal |

## Configuration

Krypton is configured via TOML at `~/.config/krypton/krypton.toml` (auto-created on first run). Changes are hot-reloaded.

Custom themes go in `~/.config/krypton/themes/*.toml`. Built-in themes: `krypton-dark`, `legacy-radiance`.

See `docs/06-configuration.md` for the full config reference.

## Development

```sh
npm install              # Install frontend dependencies
npx tauri dev            # Run full app (Rust + frontend dev server)
npm run build            # Build frontend
npx tauri build          # Build distributable app bundle
make dev                 # Shortcut for npx tauri dev
make build               # Shortcut for npx tauri build
make install             # Build + copy to /Applications (macOS)
```

### Rust only (from src-tauri/)

```sh
cargo build              # Build backend
cargo clippy             # Lint (must pass with no warnings)
cargo fmt                # Format
cargo test               # Run tests
```

### Type-check

```sh
npm run check            # or: npx tsc --noEmit
```

## Architecture

```
krypton/
  src/                     # Frontend TypeScript
    main.ts                # Entry point
    compositor.ts          # Window lifecycle, layout, tabs, panes, Quick Terminal
    input-router.ts        # Modal keyboard system (10 modes)
    layout.ts              # Grid and Focus tiling algorithms
    animation.ts           # WAAPI-based transitions with input buffering
    command-palette.ts     # Fuzzy-searchable action registry
    which-key.ts           # Keybinding hint popup
    sound.ts               # Sound effect triggers (calls Rust backend)
    theme.ts               # Theme engine, CSS custom property application
    config.ts              # Frontend config bridge
    claude-hooks.ts        # Claude Code hook event UI
    dashboard.ts           # Tabbed overlay dashboard framework
    hints.ts               # Regex-pattern label overlays
    selection.ts           # Vim-like text selection mode
    shaders.ts             # Post-processing shader presets
    cursor-trail.ts        # Rainbow flame particle effects
    extensions.ts          # Context-aware process extensions
    types.ts               # Shared type definitions
    styles.css             # Cyberpunk HUD styles (BEM)
  src-tauri/               # Rust backend
    src/
      lib.rs               # Tauri builder, plugin setup, command registration
      pty.rs               # PTY session management (portable-pty)
      commands.rs          # IPC command handlers
      config.rs            # TOML config loading + filesystem watcher
      theme.rs             # Theme resolution (built-in + custom)
      sound.rs             # Audio engine (rodio, dedicated thread)
      hook_server.rs       # HTTP server for Claude Code hooks
      ssh.rs               # SSH detection + ControlMaster multiplexing
  docs/                    # Specifications and progress tracking
```

**Backend** manages PTY sessions, config/theme loading, sound playback, SSH multiplexing, and the Claude Code hook server. **Frontend** handles rendering, layout, input routing, animations, and all UI. Communication uses Tauri IPC -- commands for request/response, events for streaming.

## Tech Stack

- **Rust** + **Tauri v2** -- native shell, PTY management, IPC, audio, HTTP hook server
- **TypeScript** + **xterm.js** -- terminal rendering, compositor, input system
- **Vite** -- frontend build tooling
- **portable-pty** -- cross-platform PTY spawning
- **rodio** -- audio playback
- **axum** -- Claude Code hook HTTP server

## License

MIT
