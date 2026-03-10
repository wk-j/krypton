# Krypton — Claude Context

## Project Overview

Krypton is a keyboard-driven terminal emulator with a cyberpunk aesthetic built with **Rust + Tauri v2** (backend) and **TypeScript + xterm.js** (frontend). It presents a single transparent native window where multiple terminal windows are rendered as DOM elements with a tiling layout engine and Vim-style modal keyboard system.

## Architecture

```
krypton/
  src/                   # Frontend TypeScript
    main.ts              # Entry point — init theme, compositor, input router, first window
    compositor.ts        # Window manager, layout, Quick Terminal
    input-router.ts      # Modal keyboard system (Normal/Compositor/Resize/Move/Swap/Selection/Hint/TabMove/CommandPalette)
    animation.ts         # WAAPI-based animation engine
    layout.ts            # Grid and Focus tiling algorithms
    which-key.ts         # Helix-style keybinding hint popup
    command-palette.ts   # Fuzzy-search command palette (Cmd+Shift+P)
    theme.ts             # Frontend theme engine (CSS custom properties)
    config.ts            # Config loading from Tauri IPC
    types.ts             # Shared TypeScript types
    selection.ts         # Vim-like text selection mode
    hints.ts             # Rio-style hint mode (keyboard labels for links/paths/emails)
    sound.ts             # Web Audio API sound engine
    styles.css           # Cyberpunk HUD styles (cyan borders, L-shaped corners)
  src-tauri/             # Rust backend
    src/
      main.rs            # Binary entry point (calls lib.rs)
      lib.rs             # Tauri builder, plugin setup, filesystem watcher
      commands.rs        # IPC command handlers (spawn_pty, write_to_pty, resize_pty, etc.)
      pty.rs             # PTY session management via portable-pty
      config.rs          # TOML config loader (~/.config/krypton/krypton.toml)
      theme.rs           # Theme engine (built-in + custom themes)
  docs/                  # SRS documentation and progress tracking
    PROGRESS.md          # Milestone status tracker
```

## Tech Stack

- **Rust** + **Tauri v2** — native shell, PTY management (portable-pty), IPC, filesystem watching (notify)
- **TypeScript** + **xterm.js v6** — terminal rendering, compositor, input routing, animations
- **Vite** — frontend build tooling (dev server on port 1420)
- **Web Audio API** — synthesized sound engine

## Development Commands

```sh
npm install              # Install frontend dependencies
npx tauri dev            # Run full app (Rust backend + Vite dev server)
npm run build            # Build frontend only (tsc --noEmit && vite build)
npx tauri build          # Build distributable app bundle
npx tsc --noEmit         # Type-check only

# From src-tauri/
cargo build              # Build backend
cargo clippy             # Lint
cargo fmt                # Format
cargo test               # Run tests
```

## Key Concepts

### Modal Keyboard System
Leader key (`Cmd+P`) enters Compositor mode. Escape returns to Normal from any mode.

| Mode | Entry | Purpose |
|------|-------|---------|
| **Normal** | default | Pass keys to terminal |
| **Compositor** | `Cmd+P` (Leader) | Window management — single-action then back to Normal |
| **Resize** | `Leader r` | Arrow keys resize focused window |
| **Move** | `Leader m` | Arrow keys reposition focused window |
| **Swap** | `Leader s` then `h/j/k/l` | Swap focused window with neighbor |
| **Selection** | `Leader v` / `Leader V` | Vim-like text selection (char/line-wise) |
| **Hint** | `Cmd+Shift+H` / `Leader Shift+H` | Keyboard labels on links/paths/emails |
| **TabMove** | `Leader T` then `1-9` | Move tab to another window by index |
| **CommandPalette** | `Cmd+Shift+P` | Fuzzy-search command execution |

### Window Layout
- **Grid layout** — auto-tiles windows in a balanced grid
- **Focus layout** — focused window at 65% left, remaining stacked at 35% right
- Pinned windows stick to the right column in Focus layout

### IPC Pattern
- **Commands** — request/response for `spawn_pty`, `write_to_pty`, `resize_pty`, `get_config`, `get_theme`, etc.
- **Events** — streaming PTY output (`pty-output`), hot-reload (`theme-changed`, `config-changed`)

### Config & Themes
- User config: `~/.config/krypton/krypton.toml` (auto-created with defaults)
- Built-in themes: `krypton-dark`, `legacy-radiance`
- Custom themes: `~/.config/krypton/themes/*.toml`
- Hot-reloaded via filesystem watcher (300ms debounce)

### Sound Engine
- `src/sound.ts` — Web Audio API wrapper with additive/subtractive/FM synthesis, ADSR envelopes, effects chain (reverb, delay, distortion)
- Built-in `krypton-cyber` sound pack; keypress sounds with 6 keyboard types
- Configured via `[sound]` TOML section

## Milestone Status

See `docs/PROGRESS.md` for current milestone status and detailed task checklists.

Milestones M0–M2 and M5 are complete. M3, M4, M6, M7, M8 are in progress. M9 (Release) is not started.
