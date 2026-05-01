# AGENTS.md

Guidance for Codex and other code agents working in this repository.

## Project Overview

Krypton is a keyboard-driven terminal emulator with a cyberpunk aesthetic. It is built with Rust + Tauri v2 for the backend and TypeScript + xterm.js for the frontend.

Important terms:

- Workspace: virtual desktop containing terminal windows.
- Window: DOM-based terminal instance with custom chrome, not a native OS window.

## Development Commands

```sh
npm install              # Install frontend dependencies
npm run check            # Type-check frontend only
npm run build            # Type-check and build frontend
npm run test             # Run Vitest tests
npx tauri dev            # Run full app
npx tauri build          # Build distributable app bundle
make dev                 # Shortcut for npx tauri dev
make build               # Shortcut for npx tauri build
```

Rust backend commands, run from `src-tauri/`:

```sh
cargo build
cargo clippy
cargo fmt
cargo fmt -- --check
cargo test
```

## Architecture

The Rust backend in `src-tauri/src/` manages PTY sessions, config/theme loading, sound, subprocess control, and Tauri IPC. It should forward terminal bytes and system events; xterm.js handles terminal parsing.

The TypeScript frontend in `src/` owns rendering, compositor state, keyboard routing, layout, animations, and feature views.

Key modules:

- `src/compositor.ts`: window/tab/pane lifecycle, layout, content views.
- `src/input-router.ts`: modal keyboard system and global shortcuts.
- `src/layout.ts`: Grid and Focus layout algorithms.
- `src/agent/`: embedded pi-agent integration.
- `src/acp/` and `src-tauri/src/acp.rs`: external ACP agents such as Claude, Gemini, and Codex.
- `src/styles/`: vanilla CSS, split by feature.

## Constraints

- Keep Krypton keyboard-first. New user-facing features need keyboard access.
- Keep one native Tauri window. App windows are DOM elements.
- Do not add frontend frameworks or CSS frameworks.
- Use vanilla TypeScript with direct DOM manipulation.
- Use BEM-style CSS classes and existing theme CSS variables.
- Avoid `backdrop-filter: blur()`; it can freeze transparent WKWebView on macOS.
- Keep `<html>` and `<body>` backgrounds transparent.
- Use `position: absolute` plus `transform: translate()` for movable window layout.
- Prefer existing local patterns over new abstractions.

## Code Style

TypeScript:

- Strict mode, 2-space indent, semicolons, single quotes.
- Add explicit parameter and return types.
- Avoid `any`; use `unknown` and narrow.
- Import order: external packages, Tauri API, xterm.js, then local modules.
- Wrap Tauri `invoke()` calls in `try`/`catch` when failures are recoverable.

Rust:

- Return `Result<T, String>` or a typed error where appropriate for IPC.
- Use `?` for error propagation.
- Avoid `.unwrap()` outside tests.
- Use `log` macros for diagnostics.
- All IPC-facing types need `serde` support.

## Documentation

Docs are treated as the implementation spec. When behavior changes, update the related docs.

Common docs:

- `docs/PROGRESS.md`: milestone/status updates.
- `docs/04-architecture.md`: module and system architecture.
- `docs/05-data-flow.md`: keyboard, resize, and workspace data flow.
- `docs/06-configuration.md`: user config reference.
- `docs/69-acp-agent-support.md`: ACP agent window design.

## Testing Expectations

Before handing off code changes, run the narrowest useful checks:

- Frontend-only changes: `npm run check` and relevant Vitest tests.
- Rust backend changes: `cargo fmt -- --check`, `cargo clippy`, and relevant `cargo test` from `src-tauri/`.
- Cross-boundary Tauri changes: run both TypeScript and Rust checks when practical.

If a check cannot be run, mention why in the final response.

## Git And Workspace Safety

- The worktree may contain user changes. Do not revert changes you did not make.
- Do not run destructive git commands unless explicitly requested.
- Keep edits scoped to the requested task.
- Do not commit unless the user asks for a commit.
