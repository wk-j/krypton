# Krypton

A keyboard-driven terminal emulator with a cyberpunk aesthetic, built around a **multi-agent ACP harness**. Built with Rust + Tauri v2 and TypeScript + xterm.js.

Single transparent native window. Multiple terminal windows rendered as DOM elements with custom chrome. Tiling layout engine. Vim-style modal keyboard system. And, at its center, a unified harness for running and coordinating several AI coding agents side by side.

![](./docs/images/SCR-20260312-maqq.png)

## The ACP Harness

The harness is Krypton's headline feature: one keyboard-driven surface that drives multiple external AI coding agents through the **Agent Client Protocol (ACP)**, so you can run, compare, and coordinate them in parallel without leaving the terminal.

### Lanes — one harness, many agents

Each agent runs in its own **lane** with an independent session, transcript, and status:

- **Claude Code** · **Gemini CLI** · **Codex** · **Factory Droid** · **Cursor Agent** · **JetBrains Junie** · **Oh My Pi (OMP)**
- **Per-lane model selection** -- pick the model per lane from an in-harness picker; non-Claude lanes are bridged via a generated `.mcp.json`.
- **Lane modes** -- a normal coding lane, a **Review lane** for critiquing a diff, and a **Brainstorm lane** for divergent ideation.
- **Per-lane resource metrics** and a pinned **plan-tracking panel** in the right rail.

### Coordination between agents

- **Inter-lane peering** -- lanes message each other through `peer_send` / `peer_list` MCP tools; envelopes queue in per-lane inboxes and drain on the next idle turn.
- **Mention fan-out** -- `@mention` one or more lanes to dispatch the same prompt across them.
- **Soft awaiting-peer** -- a lane can wait on a peer's reply without hard-blocking the composer.
- **Shared memory** -- lanes persist and read state across turns via the harness MCP memory server.
- **Contextual lane peek & peer-activity heat** -- see what neighbouring lanes are doing at a glance.

### Staying in control

- **Directive management** -- author shared directives, preview their effect, and apply them to lanes from a directive dialog.
- **Attention triage** -- agents surface only genuinely hard, irreversible, or ambiguous decisions to a non-blocking human review queue (default-on), with a directive-bound grant model.
- **Streaming markdown** transcripts, provider-error rendering, and a readability-tuned transcript window.

### Control the harness from the command line

`kryptonctl` is an authenticated local controller for the running Krypton
instance. It can inspect harnesses and lanes, submit prompts, wait for a lane to
finish, manage lane settings and permissions, and read transcripts or shared
memory. It is a controller, not an ACP lane, so it cannot impersonate a lane or
send peer messages.

```sh
kryptonctl acp harnesses
kryptonctl acp lanes
kryptonctl acp send Claude-1 "Review the current diff" --wait
kryptonctl --json acp transcript Claude-1
kryptonctl acp capabilities
```

`send --wait` blocks until the lane is idle and its queue is empty. Read the
completed response with `transcript`; add `--json` for scripting.

## Other Features

- **Transparent Workspace** -- Fullscreen borderless window with tiling Grid/Focus layouts.
- **Modal Keyboard System** -- Normal, Compositor, Resize, Move, Selection, Hint, and Command Palette modes.
- **Quick File Search (Cmd+O)** -- Fuzzy file picker with integrated grep mode (`Tab`).
- **Embedded pi-agent (`Leader a`)** -- An in-process AI coding agent alongside the external ACP lanes.
- **Smart Prompt Dialog (Cmd+Shift+K)** -- Global modal to dispatch prompts to active Claude sessions.
- **Cyberpunk HUD** -- Glowing chrome, telemetry sidebars, and reactive background animations (EEG, Matrix).
- **Shader Presets** -- CRT, hologram, glitch, bloom, and matrix post-processing.
- **Productivity Windows** -- Built-in Hurl client, Markdown viewer, Git diff viewer, and Obsidian-style Vault viewer.
- **Sound Engine** -- 20+ event-driven cyberpunk audio cues via `rodio`.
- **Hot-Reloadable Config** -- TOML-based configuration and theming with instant updates.

## Development & Architecture

Krypton uses a **Rust (Tauri v2)** backend for PTY management, sound, and subprocess control, with a **TypeScript (xterm.js)** frontend for the UI and compositor.

```sh
npm install      # Dependencies
make dev         # Run dev environment
make build       # Build distributable bundle
make install     # Install Krypton.app and kryptonctl (macOS)
```

On macOS, `make install` installs Krypton to `/Applications` and `kryptonctl` to
`~/.local/bin` by default. Override the CLI destination with
`CLI_INSTALL_DIR=/desired/path make install`.

Configuration is located at `~/.config/krypton/krypton.toml`. Custom themes go
in `~/.config/krypton/themes/`. The authenticated loopback endpoint used by
`kryptonctl` is enabled by default through `[acp_controller].enabled`.

## Tech Stack

- **Backend:** Rust, Tauri v2, portable-pty, rodio, axum (hooks and local control API).
- **Frontend:** TypeScript, xterm.js, Vite, WAAPI (animations).
- **AI:** pi-agent-core, Agent Client Protocol (ACP).


