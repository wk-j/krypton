# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Krypton is a keyboard-driven terminal emulator with a cyberpunk aesthetic built with **Rust + Tauri v2** (backend) and **TypeScript + xterm.js** (frontend). It presents a single transparent native window where multiple terminal windows are rendered as DOM elements with a tiling layout engine and Vim-style modal keyboard system.

## Development Commands

```sh
npm install              # Install frontend dependencies
npx tauri dev            # Run full app (Rust backend + Vite dev server)
npm run build            # Build frontend (tsc --noEmit && vite build)
npm run check            # Type-check frontend only (tsc --noEmit)
npx tauri build          # Build distributable app bundle
```

### Rust backend (from src-tauri/)

```sh
cargo build              # Build backend
cargo clippy             # Lint
cargo fmt                # Format
cargo test               # Run all tests
cargo test test_name     # Run a single test by name
```

## Architecture

The app has two halves that communicate over Tauri IPC:

**Rust backend** (`src-tauri/src/`) — manages PTY sessions (spawn, read, write, resize) via `portable-pty`, loads TOML config from `~/.config/krypton/krypton.toml`, resolves themes (built-in + custom from `~/.config/krypton/themes/*.toml`), and watches the config directory for hot-reload (300ms debounce via `notify` crate). State is shared through `Arc<RwLock<_>>` managed by Tauri.

**TypeScript frontend** (`src/`) — renders terminal windows using xterm.js inside custom cyberpunk chrome. The major subsystems are:

- **Compositor** (`compositor.ts`) — window lifecycle, layout management (Grid/Focus), Quick Terminal overlay, tab/pane management. Owns the `WindowState[]` array and the session routing map.
- **Input Router** (`input-router.ts`) — modal keyboard system with modes: Normal, Compositor, Resize, Move, Swap, Selection, Hint, TabMove, CommandPalette. Leader key (`Cmd+P`) enters Compositor mode; Escape returns to Normal. Single-action compositor keys auto-return to Normal after execution.
- **Layout Engine** (`layout.ts`) — Grid (auto-tile balanced grid) and Focus (65/35 split with pinned windows on right) algorithms.
- **Sound Engine** (`sound.ts`) — Web Audio API with additive/subtractive/FM synthesis, ADSR envelopes, effects chain. Built-in `krypton-cyber` sound pack with 6 keyboard types.
- **Animation** (`animation.ts`) — WAAPI-based transitions (morph, slide, crossfade) with keyboard input buffering during animations.

### IPC Pattern

- **Commands** (request/response): `spawn_pty`, `write_to_pty`, `resize_pty`, `get_config`, `get_theme`, `list_themes`, `reload_config`, `open_url`, `get_pty_cwd`
- **Events** (streaming): `pty-output` (terminal data), `theme-changed`, `config-changed` (hot-reload)

### Config & Themes

- User config: `~/.config/krypton/krypton.toml` (auto-created with defaults on first run)
- Built-in themes: `krypton-dark`, `legacy-radiance`
- Custom themes: `~/.config/krypton/themes/*.toml`
- Theme colors applied as `--krypton-*` CSS custom properties on `document.documentElement`
- Hot-reloaded via filesystem watcher — edit a `.toml` file and changes appear instantly

## Milestone Status

See `docs/PROGRESS.md` for current milestone status and task checklists.
