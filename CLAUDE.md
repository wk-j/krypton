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

- **NO `backdrop-filter: blur()`** — causes window freeze on transparent WKWebView on macOS (see platform gotcha in `docs/04-architecture.md`)
- **macOS fullscreen:** Set position+size manually, NOT using fullscreen API (breaks transparency)
- **macOS focus fix:** Window must be `always_on_top(true)` then immediately `always_on_top(false)` in setup
- **Process detection:** Uses `tcgetpgrp()` on Unix; different API on Windows
- **Environment variables in release:** macOS GUI apps don't inherit shell env vars. `get_env_var` falls back to spawning a login shell with `printenv` (not shell-specific variable syntax) to stay compatible with bash/zsh/fish
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
- **`/pi-mono-reference`** — Reference for `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`. Load when working on `src/agent/`, debugging agent events, adding tools, changing models/providers, or any question about the pi-agent-core or pi-ai API. Source of truth is at `/Users/wk/Source/pi-mono`.
- **`/pretext-reference`** — Reference for `@chenglou/pretext` text layout & measurement library. Load when creating text layouts, text animations, measuring text height without DOM, rendering text to canvas/SVG, or working with multiline text measurement. Source of truth is at `/Users/wk/Source/pretext`.
- **`/diegetic-ui`** — Design and build Diegetic UI applications — interfaces embedded in the story world (Iron Man HUD, Dead Space health bar, Alien motion tracker). Trigger on "HUD", "sci-fi UI", "holographic interface", "AR overlay", "cockpit display", "diegetic design", "in-world UI", "Iron Man style", or "make it feel like it's in the game/movie/world".

## Documentation

- `docs/PROGRESS.md` — **Update this** when completing milestone tasks
- `docs/04-architecture.md` — System architecture, DOM structure, module responsibilities
- `docs/05-data-flow.md` — How keystrokes, resize, and workspace switching flow through the system
- `docs/06-configuration.md` — Full TOML config reference with examples
- Treat docs as the authoritative spec. If implementation diverges from spec, update the docs

## Milestone Status

See `docs/PROGRESS.md` for current milestone status and task checklists.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **krypton** (3607 symbols, 9998 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/krypton/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/krypton/context` | Codebase overview, check index freshness |
| `gitnexus://repo/krypton/clusters` | All functional areas |
| `gitnexus://repo/krypton/processes` | All execution flows |
| `gitnexus://repo/krypton/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
