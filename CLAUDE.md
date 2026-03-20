# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Krypton is a keyboard-driven terminal emulator with a cyberpunk aesthetic built with **Rust + Tauri v2** (backend) and **TypeScript + xterm.js** (frontend). A single fullscreen, borderless, transparent Tauri window acts as an invisible shell. Terminal "windows" are DOM elements with custom chrome floating on transparent workspace surfaces.

**Critical terminology:**
- **Workspace** = virtual desktop (full-screen arrangement of terminal windows)
- **Window** = DOM-based terminal instance with custom chrome (NOT a native OS window)

## Development Commands

```sh
npm install              # Install frontend dependencies
npx tauri dev            # Run full app (Rust backend + Vite dev server)
npm run build            # Build frontend (tsc --noEmit && vite build)
npm run check            # Type-check frontend only (tsc --noEmit)
npx tauri build          # Build distributable app bundle
make dev                 # Shortcut for npx tauri dev
make build               # Shortcut for npx tauri build
make install             # Build + copy to /Applications (macOS)
make clean               # cargo clean + rm -rf dist
```

### Rust backend (from src-tauri/)

```sh
cargo build              # Build backend
cargo clippy             # Lint — must pass with no warnings
cargo fmt                # Format (4-space indent)
cargo fmt -- --check     # Check formatting without writing
cargo test               # Run all tests
cargo test test_name     # Run a single test by name
cargo test -- --nocapture  # Show stdout/stderr in test output
```

## Architecture

The app has two halves that communicate over Tauri IPC:

**Rust backend** (`src-tauri/src/`) — manages PTY sessions (spawn, read, write, resize) via `portable-pty`, loads TOML config from `~/.config/krypton/krypton.toml`, resolves themes (built-in + custom from `~/.config/krypton/themes/*.toml`), and watches the config directory for hot-reload (300ms debounce via `notify` crate). State is shared through `Arc<RwLock<_>>` managed by Tauri.

**TypeScript frontend** (`src/`) — renders terminal windows using xterm.js inside custom cyberpunk chrome. The major subsystems are:

- **Compositor** (`compositor.ts`) — window lifecycle, layout management (Grid/Focus), Quick Terminal overlay, tab/pane management. Owns the `WindowState[]` array and the session routing map (`sessionMap: Map<SessionId, SessionLocation>` for O(1) routing of PTY output to the correct pane).
- **Input Router** (`input-router.ts`) — modal keyboard system with modes: Normal, Compositor, Resize, Move, Swap, Selection, Hint, TabMove, CommandPalette, Dashboard. Leader key (`Cmd+P`) enters Compositor mode; Escape returns to Normal. Single-action compositor keys auto-return to Normal after execution. The `customKeyHandler` intercepts keys BEFORE xterm.js processes them — returning `false` prevents xterm.js from seeing the key.
- **Layout Engine** (`layout.ts`) — Grid (auto-tile balanced grid) and Focus (65/35 split with pinned windows on right) algorithms.
- **Sound Engine** (`sound.ts`) — thin frontend wrapper that calls Rust backend (`sound.rs`), which uses `rodio` on a dedicated audio thread with WAV packs bundled as Tauri resources.
- **Animation** (`animation.ts`) — WAAPI-based transitions (morph, slide, crossfade) with keyboard input buffering during animations.

### IPC Pattern

- **Commands** (request/response): `spawn_pty`, `write_to_pty`, `resize_pty`, `get_config`, `get_theme`, `list_themes`, `reload_config`, `open_url`, `get_pty_cwd`
- **Events** (streaming): `pty-output` (terminal data), `theme-changed`, `config-changed` (hot-reload), `pty-progress`, `process-changed`
- All Rust commands return `Result<T, String>` for IPC serialization. Register in `lib.rs` via `.invoke_handler(tauri::generate_handler![...])`.
- Frontend uses `invoke()` for commands, `listen()` for events (from `@tauri-apps/api/core`).

### Config & Themes

- User config: `~/.config/krypton/krypton.toml` (auto-created with defaults on first run)
- Built-in themes: `krypton-dark`, `legacy-radiance`
- Custom themes: `~/.config/krypton/themes/*.toml`
- Theme colors applied as `--krypton-*` CSS custom properties on `document.documentElement`
- Hot-reloaded via filesystem watcher — edit a `.toml` file and changes appear instantly

## Architecture Constraints

1. **Keyboard-first:** Every feature must have a keyboard shortcut. Mouse is secondary
2. **Single native window:** All windows are DOM elements — never create additional OS/Tauri windows
3. **Backend role:** PTY management, session pool, config/theme loading, raw byte forwarding. No VT parsing in Rust (xterm.js handles it)
4. **Frontend role:** Compositor, window chrome, layout engine, input routing, animations, mode system
5. **No CSS frameworks.** Vanilla CSS with BEM naming (`.krypton-window__titlebar`, `.krypton-window--focused`)
6. **No frontend frameworks.** Vanilla TypeScript with direct DOM manipulation
7. **CSS layout:** `position: absolute` + `transform: translate()` for window positioning (avoids layout thrashing)
8. **Performance:** Keypress-to-render < 16ms, animations at 60 FPS, idle CPU < 1%

## Platform Gotchas

- **NO `backdrop-filter: blur()`** — causes window freeze on transparent WKWebView on macOS (see `docs/24-backdrop-filter-removal.md`)
- **macOS fullscreen:** Set position+size manually, NOT using fullscreen API (breaks transparency)
- **macOS focus fix:** Window must be `always_on_top(true)` then immediately `always_on_top(false)` in setup
- **Process detection:** Uses `tcgetpgrp()` on Unix; different API on Windows
- Both `<html>` and `<body>` must have `background: transparent`

## Code Style

### Rust
- **Error handling:** `Result<T, E>` with `?` operator. `.expect("meaningful message")` only for unrecoverable init failures. Never `.unwrap()` outside tests
- **Logging:** `log` crate macros (`info!`, `warn!`, `error!`, `debug!`). Debug-only plugins guarded by `cfg!(debug_assertions)`
- All serializable types need `serde` with `derive` feature

### TypeScript
- Strict mode, 2-space indent, semicolons, single quotes
- Explicit types on function parameters and return values. Avoid `any` — use `unknown` and narrow
- Import order: 1) external packages, 2) Tauri API, 3) xterm.js, 4) local modules (blank line between groups)
- Wrap `invoke()` calls in try/catch. Graceful degradation for optional features

## Agent Skills

Skills in `.agents/skills/` define repeatable workflows. Load the appropriate skill when its trigger conditions are met:

- **`/design-first`** — Before writing code for a new feature or significant change (3+ files or 2+ subsystems), write an implementation spec at `docs/<NN>-<feature-name>.md`, present it, and wait for explicit user approval. Skip for bug fixes, one-line changes, doc-only changes, or when user says "just do it".
- **`/feature-implementation`** — When implementing any feature, ensures all related docs in `docs/` are updated (PROGRESS.md, architecture, data-flow, configuration, requirements). A feature is not complete until docs reflect the actual implementation. See the skill for the full doc map of which changes require which doc updates.
- **`/ghost-signal-theme`** — Automates adding a new ghost-signal sound pack: copy 17 WAVs to `src-tauri/sounds/<pack-id>/`, register in `sound.rs` and `sound.ts`, update `docs/17-sound-themes.md`. Trigger on "add sound theme", "new sound pack", or referencing a WAV directory.

## Documentation

- `docs/PROGRESS.md` — **Update this** when completing milestone tasks
- `docs/04-architecture.md` — System architecture, DOM structure, module responsibilities
- `docs/05-data-flow.md` — How keystrokes, resize, and workspace switching flow through the system
- `docs/06-configuration.md` — Full TOML config reference with examples
- Treat docs as the authoritative spec. If implementation diverges from spec, update the docs

## Milestone Status

See `docs/PROGRESS.md` for current milestone status and task checklists.
