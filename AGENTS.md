# AGENTS.md — Coding Agent Guidelines for Krypton

## Project Overview

Krypton is a terminal emulator built with **Rust + Tauri v2** (backend) and **TypeScript + xterm.js** (frontend). A single fullscreen, borderless, transparent Tauri window acts as an invisible shell. Terminal "windows" are DOM elements with custom chrome floating on transparent workspace surfaces. The authoritative spec lives in `docs/` (10 files). Read `docs/PROGRESS.md` for current milestone status.

**Critical terminology:**
- **Workspace** = virtual desktop (full-screen arrangement of terminal windows)
- **Window** = DOM-based terminal instance with custom chrome (NOT a native OS window)

## Build & Run Commands

### Development
```sh
npm run dev            # Start Vite dev server (frontend only)
npx tauri dev          # Start full app (Rust backend + frontend dev server)
```

### Production Build
```sh
npm run build          # Build frontend to dist/
npx tauri build        # Build full app bundle (DMG/AppImage/MSI)
```

### Rust Only (from src-tauri/)
```sh
cargo build            # Build Rust backend
cargo build --release  # Release build
cargo clippy           # Lint Rust code
cargo fmt              # Format Rust code
cargo fmt -- --check   # Check formatting without writing
```

### Tests
```sh
cargo test                           # Run all Rust tests
cargo test test_name                 # Run a single Rust test by name
cargo test --lib                     # Run only library tests
cargo test -- --nocapture            # Show stdout/stderr in test output
npm test                             # Run frontend tests (when configured)
```

### TypeScript
```sh
npx tsc --noEmit       # Type-check without emitting
```

## Project Structure

```
krypton/
├── docs/              # SRS documentation (authoritative spec)
│   └── PROGRESS.md    # Milestone tracking — update as you complete tasks
├── src/               # Frontend TypeScript source (Vite entry)
│   └── main.ts        # App entry point
├── src-tauri/         # Rust backend
│   ├── src/
│   │   ├── main.rs    # Binary entry (calls lib)
│   │   └── lib.rs     # Tauri builder & plugin setup
│   ├── Cargo.toml     # Rust dependencies
│   └── tauri.conf.json
├── index.html         # Vite entry HTML
├── package.json       # Node dependencies & scripts
├── tsconfig.json      # TypeScript config
└── vite.config.ts     # Vite config
```

## Code Style — Rust

- **Edition:** 2021, minimum Rust version 1.77.2
- **Formatting:** Use `cargo fmt` defaults (4-space indent)
- **Linting:** `cargo clippy` must pass with no warnings
- **Crate name:** `app` (binary), `app_lib` (library)
- **Naming:** `snake_case` for functions/variables/modules, `PascalCase` for types/traits, `SCREAMING_SNAKE_CASE` for constants
- **Error handling:**
  - Use `Result<T, E>` with the `?` operator for propagation
  - Use `thiserror` for custom error types when adding them
  - `.expect("meaningful message")` only for truly unrecoverable init failures
  - Never use `.unwrap()` outside of tests
- **Modules:** One module per file. Group related functionality into submodules under `src-tauri/src/`
- **Tauri commands:** Annotate with `#[tauri::command]`, return `Result<T, String>` for IPC. Register in `lib.rs` via `.invoke_handler(tauri::generate_handler![...])`
- **Logging:** Use `log` crate macros (`info!`, `warn!`, `error!`, `debug!`). Debug-only plugins guarded by `cfg!(debug_assertions)`
- **Dependencies:** Add to `[dependencies]` in `src-tauri/Cargo.toml`. Keep `serde` with `derive` feature for all serializable types

## Code Style — TypeScript

- **Strict mode:** `"strict": true` in tsconfig.json
- **Module system:** ES modules (`import`/`export`), no CommonJS `require()`
- **Formatting:** 2-space indent, semicolons, single quotes
- **Naming:** `camelCase` for functions/variables, `PascalCase` for classes/interfaces/types, `SCREAMING_SNAKE_CASE` for constants
- **Types:** Explicit types on function parameters and return values. Avoid `any` — use `unknown` and narrow
- **Imports:**
  - Group: 1) external packages, 2) Tauri API, 3) xterm.js, 4) local modules. Blank line between groups
  - Use named imports: `import { invoke } from '@tauri-apps/api/core'`
- **No frameworks:** Vanilla TypeScript with direct DOM manipulation for the compositor layer
- **xterm.js usage:** Each terminal window gets its own `Terminal` instance. Addons loaded per-instance. Always attach `WebglAddon` with canvas fallback
- **IPC:** Use `@tauri-apps/api` — `invoke()` for commands, `listen()` for events
- **Error handling:** Wrap `invoke()` calls in try/catch. Log errors to console in development

## Code Style — CSS

- **No CSS frameworks.** Hand-written CSS with custom properties for theming
- **Custom properties** prefixed with `--krypton-` for theme values (e.g., `--krypton-window-border-color`)
- **Layout:** Use `position: absolute` with `transform: translate()` for window positioning (avoids layout thrashing)
- **Transparency:** `html` and `body` must have `background: transparent`
- **BEM-like naming** for classes: `.krypton-window`, `.krypton-window__titlebar`, `.krypton-window--focused`

## Architecture Constraints

1. **Keyboard-first:** Every feature must have a keyboard shortcut. Mouse is secondary
2. **Single native window:** All windows are DOM elements — never create additional OS/Tauri windows
3. **Backend role:** PTY management, session pool, config/theme loading, raw byte forwarding. No VT parsing in Rust (xterm.js handles it)
4. **Frontend role:** Compositor, window chrome, layout engine, input routing, animations, mode system
5. **IPC pattern:** Tauri commands for request/response, Tauri events for streaming data (PTY output)
6. **Performance:** Keypress-to-render < 16ms, animations at 60 FPS, idle CPU < 1%
7. **Config format:** TOML at `~/.config/krypton/krypton.toml`, custom themes at `~/.config/krypton/themes/*.toml`

## Key Dependencies

### Rust (src-tauri/Cargo.toml)
- `tauri` — App framework + IPC
- `portable-pty` — Cross-platform PTY (to be added)
- `serde` / `serde_json` / `toml` — Serialization
- `log` / `tauri-plugin-log` — Logging
- `notify` — Filesystem watcher for hot-reload (to be added)

### Frontend (package.json)
- `@xterm/xterm` + addons (`webgl`, `fit`, `search`, `web-links`, `unicode11`) — Terminal rendering
- `@tauri-apps/api` — Tauri IPC from frontend
- `vite` — Build tool
- `typescript` — Type system

## Working with docs/

- `docs/PROGRESS.md` — **Update this** when completing milestone tasks (check boxes)
- `docs/04-architecture.md` — System architecture, DOM structure, module responsibilities
- `docs/05-data-flow.md` — How keystrokes, resize, and workspace switching flow through the system
- `docs/06-configuration.md` — Full TOML config reference with examples
- `docs/07-milestones.md` — Detailed deliverables per milestone
- Treat docs as the authoritative spec. If implementation diverges from spec, update the docs
