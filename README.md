# Krypton

A keyboard-driven terminal emulator with a cyberpunk aesthetic. Built with Rust + Tauri v2 and TypeScript + xterm.js.

Single transparent native window. Multiple terminal windows rendered as DOM elements with custom chrome. Tiling layout engine. Vim-style modal keyboard system.

## Features

- **Transparent workspace** with backdrop blur on macOS
- **Tiling layouts** -- Grid (auto-tile) and Focus (65/35 split)
- **Modal keyboard system** -- Normal, Compositor, Resize, Move, Swap modes
- **Which-key popup** -- Helix-style hint overlay showing available keybindings
- **Quick Terminal** -- Persistent overlay terminal toggled with `Cmd+I`
- **Animation engine** -- Morph, slide, crossfade transitions with entrance/exit effects
- **Cyberpunk HUD chrome** -- Glowing cyan borders, L-shaped corner accents, striped header bars

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+P` | Leader key (enter Compositor mode) |
| `Cmd+I` | Toggle Quick Terminal |
| `Cmd+Shift+<` / `>` | Cycle focus between windows |
| `Ctrl+Shift+U` / `D` | Scroll buffer up/down one page |
| Leader + `n` | New window |
| Leader + `x` | Close window |
| Leader + `f` | Toggle Focus/Grid layout |
| Leader + `z` | Toggle maximize |
| Leader + `h/j/k/l` | Focus window by direction |
| Leader + `r` | Enter Resize mode |
| Leader + `m` | Enter Move mode |
| Leader + `s` | Enter Swap mode |
| `Escape` | Exit current mode / hide Quick Terminal |

## Development

```sh
npm install              # Install frontend dependencies
npx tauri dev            # Run full app (Rust + frontend dev server)
npm run build            # Build frontend
npx tauri build          # Build distributable app bundle
```

### Rust only (from src-tauri/)

```sh
cargo build              # Build backend
cargo clippy             # Lint
cargo fmt                # Format
cargo test               # Run tests
```

### Type-check

```sh
npx tsc --noEmit
```

## Architecture

```
krypton/
  src/                   # Frontend TypeScript
    main.ts              # Entry point
    compositor.ts        # Window manager, layout, Quick Terminal
    input-router.ts      # Modal keyboard system
    animation.ts         # WAAPI-based animation engine
    layout.ts            # Grid and Focus tiling algorithms
    which-key.ts         # Keybinding hint popup
    types.ts             # Shared type definitions
    styles.css           # Cyberpunk HUD styles
  src-tauri/             # Rust backend
    src/
      lib.rs             # Tauri builder and plugin setup
      pty.rs             # PTY session management
      commands.rs        # IPC command handlers
  docs/                  # Specification and progress tracking
```

**Backend** manages PTY sessions (spawn, read, write, resize) via `portable-pty`. **Frontend** handles rendering, layout, input routing, and animations. Communication uses Tauri IPC -- commands for request/response, events for streaming PTY output.

## Tech Stack

- **Rust** + **Tauri v2** -- native shell, PTY management, IPC
- **TypeScript** + **xterm.js** -- terminal rendering, compositor, input system
- **Vite** -- frontend build tooling

## License

MIT
