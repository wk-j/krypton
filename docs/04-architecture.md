# 5. Architecture Overview

```
+-------------------------------------------------------------------------+
|  Tauri Native Shell (Fullscreen, Borderless, Transparent)               |
|  +-------------------------------------------------------------------+  |
|  |     Webview — Active Workspace (Transparent Virtual Desktop)       |  |
|  |                                                                   |  |
|  |  +--Window 0 (focused)----+  +--Window 1--------------+          |  |
|  |  | [Title Bar] [x][-][+]  |  | [Title Bar] [x][-][+]  |          |  |
|  |  | [Tab 0 | Tab 1]        |  | [Tab 0]                |          |  |
|  |  | +--------------------+ |  | +--------------------+  |          |  |
|  |  | |   xterm.js #0      | |  | |   xterm.js #1      |  |          |  |
|  |  | |                    | |  | |                    |  |          |  |
|  |  | +--------------------+ |  | +--------------------+  |          |  |
|  |  +------------------------+  +--------------------------+          |  |
|  |                                                                   |  |
|  |  (Window 2, Window 3... hidden — belong to other workspaces)      |  |
|  |                                                                   |  |
|  |  [ Compositor: z-order, focus, move, resize, animations ]         |  |
|  |  [ Mode Indicator ]  [ Command Palette ]  [ Sound Engine ]        |  |
|  +-------------------------------------------------------------------+  |
|                          |  IPC (Tauri Commands & Events)               |
+--------------------------|----------------------------------------------+
                           v
+-------------------------------------------------------------------------+
|                       Rust Backend                                      |
|                                                                         |
|  +---------------+ +------------+ +-----------+ +--------------------+  |
|  | Workspace     | | Session    | | PTY       | | Config             |  |
|  | Manager       | | Pool       | | Manager   | | Manager            |  |
|  | (workspace    | | (window-to-| | (portable | | (TOML, hot-reload) |  |
|  |  definitions, | |  session   | |  -pty)    | |                    |  |
|  |  switching,   | |  mapping)  | |           | |                    |  |
|  |  presets)     | |            | |           | |                    |  |
|  +---------------+ +------------+ +-----------+ +--------------------+  |
|                                                                         |
|  +---------------+ +------------+ +-------------------+ +--------------+  |
|  | Theme         | | VT Parser  | | Process Poller    | | Sound        |  |
|  | Engine        | | (vte)      | | (tcgetpgrp,       | | Engine       |  |
|  +---------------+ +------------+ |  process-changed) | | (rodio/cpal) |  |
|                                   +-------------------+ +--------------+  |
|  +---------------+                                                        |
|  | SSH Manager   |                                                        |
|  | (detect,      |                                                        |
|  |  clone, ctrl  |                                                        |
|  |  sockets)     |                                                        |
|  +---------------+                                                        |
+-------------------------------------------------------------------------+
              |
              v
    +-------------------+
    |  OS PTY / Shell(s) |
    +-------------------+
```

### Key Architectural Principle: Workspace as Desktop

Krypton uses **one native Tauri shell** that is always **fullscreen, borderless, and fully transparent**. The webview background is `transparent` — the OS desktop wallpaper shows through. The active **workspace** fills this surface as a virtual desktop. Terminal **windows** are DOM elements floating on the workspace with their own opaque (or semi-transparent) backgrounds, chrome, and shadows.

Each window has:
- Cyberpunk/sci-fi **chrome** — titlebar with session label, status dot, PTY status text; right sidebar with telemetry decoration; bottom bar with line indicators; glowing cyan border on focused window
- Its own **xterm.js instance** for terminal rendering
- **Keyboard-driven move and resize** as the primary interaction, with optional mouse as secondary

This model enables:
- **Workspace = desktop** — switching workspaces feels like switching macOS Spaces; each workspace is a full-screen arrangement of windows
- **Fully custom chrome** — window borders, title bars, controls, and shadows are all theme-driven via custom theme TOML files
- **Animated workspace transitions** — windows animate between positions using CSS/JS transitions on the transparent surface
- **Zero overhead** — switching workspaces shows/hides/repositions DOM elements; no native OS windows created or destroyed
- **Unified focus management** — the compositor controls which window receives keyboard input
- **Consistent behavior** — no platform-specific window manager quirks

### Tauri Native Shell Configuration

```rust
// src-tauri/src/main.rs (conceptual)
tauri::Builder::default()
    .setup(|app| {
        let window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
            .fullscreen(true)           // always fullscreen
            .decorations(false)         // no native title bar or borders
            .transparent(true)          // transparent background
            .always_on_top(false)       // sits at normal z-level
            .skip_taskbar(false)        // visible in OS taskbar/dock
            .build()?;
        Ok(())
    })
```

The webview's `<html>` and `<body>` have `background: transparent`. Windows are the only visible elements — they float on the invisible workspace surface with their own chrome and shadows.

## 5.1 Key Rust Crates

| Crate | Purpose | Status |
|-------|---------|--------|
| `tauri` | Application framework, fullscreen transparent borderless shell, IPC | Implemented |
| `portable-pty` | Cross-platform PTY allocation and management | Implemented |
| `serde` / `serde_json` | Serialization framework for IPC and config | Implemented |
| `toml` | TOML config file parsing | Implemented |
| `dirs` | Cross-platform home directory resolution for config path | Implemented |
| `log` / `tauri-plugin-log` | Logging framework | Implemented |
| `vte` | VT escape sequence parser (backend validation/processing) | Planned |
| `notify` | Filesystem watcher for config/theme hot-reload | Implemented |
| `open` | Open URLs/files with system default handler (hint mode) | Implemented |
| `libc` | Unix FFI for `tcgetpgrp()` (foreground process detection) | Implemented |
| `unicode-width` | Character width calculation for CJK / emoji | Planned |
| `display-info` | Query monitor geometry for fullscreen dimensions | Planned |
| `rusqlite` | Read-only SQLite database access for dashboard overlays | Implemented |
| `rodio` | Audio playback for sound engine (WAV decoding + OS audio output via cpal) | Implemented |
| `hostname` | Local hostname detection for SSH remote CWD filtering (OSC 7 hostname comparison) | Implemented |
| `reqwest` | HTTPS client for the subscription credit usage view (Claude OAuth usage endpoint, Copilot quota API, Cursor dashboard usage RPC) | Implemented |

## 5.2 Key Frontend Packages (npm)

| Package | Purpose |
|---------|---------|
| `@xterm/xterm` | Core terminal emulator library |
| `@xterm/addon-webgl` | WebGL-based renderer for GPU-accelerated drawing |
| `@xterm/addon-fit` | Auto-fit terminal dimensions to container |
| `@xterm/addon-search` | In-terminal text search |
| `@xterm/addon-web-links` | Clickable URL detection |
| `@xterm/addon-unicode11` | Proper Unicode width handling |
| `@excalidraw/excalidraw` | Drawing canvas for the Pencil window (lazy-loaded with React 19 — only mounted when Pencil opens) |

## 5.3 Frontend Technology

- **xterm.js** — The terminal rendering library. Uses its WebGL/Canvas renderer for high-performance character grid output. xterm.js handles VT escape sequence parsing on the frontend, cursor rendering, selection, search, and link detection.
- **xterm.js addons** — `xterm-addon-webgl` (GPU-accelerated rendering), `xterm-addon-fit` (auto-resize), `xterm-addon-search`, `xterm-addon-web-links`.
- **Vanilla TypeScript / lightweight framework** — For the compositor (workspace management, window chrome, animations, command palette).

Since xterm.js handles VT parsing and rendering on the frontend, the Rust backend's primary role is PTY management, workspace state, theme loading, and raw byte forwarding.

## 5.4 Compositor Layer (Frontend)

The compositor is a TypeScript module running in the webview that manages workspace and window lifecycle:

### Responsibilities

1. **Workspace rendering** — display the active workspace; show/hide windows when switching workspaces
2. **Window rendering** — create/destroy window DOM containers, each hosting an xterm.js instance with custom chrome
3. **Layout engine** — compute window positions from grid definitions relative to the workspace (full screen). Supports multiple layout modes: **Grid** (balanced auto-tile) and **Focus** (focused window on left at full height, remaining windows stacked on right)
4. **Input routing & mode management** — manage keyboard modes (normal, compositor, resize, move) and route keys accordingly
5. **Focus management** — track which window is focused; route keyboard events to the focused window's PTY in normal mode
6. **Keyboard-driven window control** — handle window move, resize, swap, maximize, and focus cycling via keybindings
7. **Command palette** — overlay for fuzzy-searching and executing all available actions by name
8. **Animation engine** — orchestrate workspace transition animations (slide, crossfade, morph) and window entrance/exit effects
9. **Quick Terminal** — manage a persistent overlay terminal (toggled via `Cmd+I`) that floats centered on screen above all workspace windows; separate from the tiling layout
10. **Z-order** — manage window stacking within a workspace; focused window rises to top
11. **Chrome rendering** — cyberpunk/sci-fi window chrome with glowing cyan borders, session label with status dot, PTY status indicator, right sidebar with telemetry decoration, and bottom bar
12. **Per-window accent colors** — each window gets a unique color from a 10-color cyberpunk palette (cyan, magenta, amber, green, violet, orange, pink, teal, gold, red) applied to chrome, borders, corners, tabs; colors recycled on window close. **Spec 142:** an ACP harness view overrides its host window's accent to track the *active lane's* identity color via a `data-lane-accent` slot attribute + `!important` CSS in `window.css`, layered beneath the `data-signal` status override (spec 105); removed on dispose so the window reverts to its allocated color
13. **Shader engine** — manage per-pane CSS/SVG post-processing effects (CRT, hologram, glitch, bloom, matrix); cycle presets via `Leader g`, toggle globally via `Leader G`
14. **Progress indicator** — listen for `pty-progress` events (ConEmu `OSC 9;4`); render a large translucent SVG arc gauge centered in the window's content area (behind terminal text) and a titlebar scanline sweep; per-pane state tracking with active-tab display; accent-color-aware theming
15. **Context extensions** — `ExtensionManager` listens for `process-changed` Tauri events from a backend poller (500ms, using `tcgetpgrp()` on PTY master fd). When a matching foreground process is detected (e.g., `java`), the corresponding built-in extension activates and renders widget bars (top/bottom horizontal strips inside the pane). Bars are real flex children that push the xterm terminal inward — `addon-fit` recalculates and `resize_pty` fires. First extension: Java Resource Monitor (JVM heap, GC, CPU%, RSS via `jstat` + `ps`).
16. **Backend logging** — Tauri logging writes to the platform app log directory only. The stdout target is deliberately disabled so backend logs from watchers, quick search, and PTY lifecycle events cannot spill into the terminal that launched Krypton, especially during nested development sessions.
17. **Overlay dashboards** — `DashboardManager` provides a generic framework for full-screen overlay panels. Modules register dashboards with an ID, title, optional keyboard shortcut, and `onOpen`/`onClose`/`onKeyDown` lifecycle hooks. The manager handles DOM creation (backdrop + panel + header + scrollable content area at z-index 9500), show/hide transitions (CSS opacity + scale), `Mode.Dashboard` integration with the InputRouter, and focus restoration. Built-in dashboards: **Git Status** (`Cmd+Shift+G`) — branch, file counts, changed file list via `run_command`; **OpenCode** (`Cmd+Shift+O`) — session history, token usage, model/tool distribution from local SQLite database via `query_sqlite`.
18. **Workspace footer** — `WorkspaceFooter` (`src/workspace-footer.ts`) owns the single fixed 28px bottom rail for workspace-level status. It subscribes to `InputRouter` mode changes, `Compositor` focus/summary helpers, and focused-view `ViewBus` signals (`view:state`, `view:metrics`, `view:throughput`, `view:progress`, `view:exit`) to render mode, focused role/title, CWD/git, counts, process/activity, and contextual hints. The music mini-player no longer owns its own fixed footer; `MusicPlayer` registers a music segment with the footer. `Leader ?` toggles compact/detail density and command palette actions can show/hide or toggle detail. See `docs/121-workspace-status-bar.md`.
19. **Window AI credit status** — `src/usage-store.ts` is the shared, ref-counted frontend owner for Claude/Codex/Copilot/Cursor subscription usage polling. A visible content view optionally declares its providers through `ContentView.getUsageProviders()`; ACP Harness publishes the deduplicated union of its lanes and signals membership changes. The compositor subscribes only the active tab's focused pane and renders quota windows into the left side of that window's `.krypton-window__footer`, while transient notifications remain right-aligned. See `docs/153-window-ai-credit-status.md`.
20. **Optional mouse handling** — secondary drag/resize/click interactions for users who prefer mouse
21. **Editor opener** — `src/editor-open.ts` provides the shared "open in Helix" path used by Quick File Search and the built-in file path hint rule. It asks the compositor to create a terminal tab whose PTY process is `hx` with the selected path argument; relative paths inherit the focused pane's cwd, and the normal `pty-exit` flow closes the tab when Helix exits. Backend PTY sessions inject the user's login-shell `PATH` before spawning so GUI launches can still resolve tools such as `hx`. Backend PTY sessions emit `pty-exit` from both reader EOF/error and a direct child-process wait, so direct editor tabs close even when the PTY master does not report EOF immediately.
21. **Pi agent view** — `src/agent/` implements the embedded pi-agent content tab opened via `Leader a`. `AgentController` lazily builds a browser-compatible `@mariozechner/pi-agent-core` agent with CWD-aware `read_file`, `write_file`, `bash`, and skill tools. `AgentView` owns the keyboard-driven chat surface, image staging, slash commands, context-window callback, inline diff previews, validation checks, and the `write_file` / risky-`bash` approval handlers. Before a pi-agent write reaches the backend `write_file` IPC, `src/agent/tools.ts` reads the old file, computes a diff when under the preview cap, awaits AgentView's approval promise, and only writes after `a`/`A`; `r`/`R` rejects with a tool error and leaves disk untouched. Before a pi-agent shell command reaches `run_command`, `tools.ts` classifies it with a conservative allowlist: read-only commands run immediately, while redirection, mutators, Git state changes, package/network tools, script runners, and unknown commands render a command review and wait for the same `a`/`r`/`A`/`R` keys. `/check` is a user-owned validation path, not an agent tool call: AgentView reads project marker files, selects a narrow command (`npm run check`, `npm run typecheck`, `npm test`, `cargo check`, or `go test ./...`), runs it directly through `run_command`, and stores failing output for `f`/`/fixcheck`. See `docs/42-pi-agent-integration.md`, `docs/99-agent-write-approval.md`, `docs/100-agent-bash-approval.md`, and `docs/101-agent-check-command.md`.

21. **ACP agent windows** — `src/acp/` (`AcpClient`, `AcpView`) and `src-tauri/src/acp.rs` (`AcpRegistry`, `AcpClient`) implement a separate, dedicated agent window that drives an external [Agent Client Protocol](https://agentclientprotocol.com) adapter (Claude Code, Gemini CLI, Codex, OpenCode, Cursor Agent, pi via `pi-acp`, OMP, …) over newline-delimited JSON-RPC on the subprocess's stdio. The harness boots empty (no auto-spawn); on first open it auto-presents the lane picker so the user selects which backend to start, and thereafter the user adds more lanes on demand via the local leader-key picker (`Cmd+P → +`); supported backends are Codex, Claude, Gemini, OpenCode, Pi, Droid, Cursor, Junie, OMP, Grok, Copilot, MiMo, and Cline. Lane picker, close-active-lane (`Cmd+P → _`), metrics overlay (`Cmd+P → =`), and session resume picker (`Cmd+P → 0`) are exposed as `ACP_HARNESS_LEADER_KEYS`. See `docs/92-acp-lane-picker.md` and `docs/97-acp-harness-session-resume.md`. Pi-1 deliberately skips the `.mcp.json` bridge and the per-lane memory MCP server because pi has no MCP host (by design), and it bypasses the permission rail because pi has no permission gate (by design) — the Pi-1 lane chip surfaces a `⚠ unsandboxed` marker so this safety delta is visible. Pi-1 prerequisites: `npm install -g @mariozechner/pi-coding-agent pi-acp`, then either set a provider API key env var or run `pi /login` once outside Krypton (the harness does not provide a TTY for pi's interactive OAuth flow). See `docs/84-acp-pi-lane.md`. Droid-1 spawns Factory's official `droid` CLI in native ACP mode (`droid exec --output-format acp`); it is a "regular" lane (full `.mcp.json` bridge, full per-lane memory MCP, permission rail engaged) — opposite archetype from Pi-1. Auth via `FACTORY_API_KEY` env var; the device-code OAuth flow needs a TTY and must be completed outside Krypton. Default model is Factory's `claude-opus-4-7`; override via `acp_harness.lane_models["droid"]` (passed to `droid` as `-m <id>` at spawn). See `docs/86-acp-droid-lane.md`. Cursor-1 spawns Cursor Agent's native ACP server (`cursor-agent acp`) as a regular lane with the `.mcp.json` bridge and per-lane memory MCP enabled. Cursor auth/install remains outside Krypton (`cursor-agent login` or `CURSOR_API_KEY`), startup errors include Cursor-specific Keychain/login/install hints, and the lane chip shows `⚠ permissions unverified` until Cursor ACP write-permission behavior is manually probed. See `docs/113-acp-cursor-lane.md`. Junie-1 spawns JetBrains Junie CLI in native ACP mode (`junie --acp true`) as a regular lane with the `.mcp.json` bridge and per-lane memory MCP enabled. Junie auth/install remains outside Krypton (`junie` first-run for JetBrains Account, or `JUNIE_API_KEY` / `--auth <token>` / BYOK provider keys in the login shell), startup errors include Junie-specific install / unknown-ACP-flag / auth / subscription / config-corruption hints, and the lane chip shows `⚠ permissions unverified` until Junie ACP write-permission behavior is manually probed. Junie's native MCP loaders (`--mcp-default-locations`, `~/.junie/config.json`) may overlap with the Krypton-bridged `.mcp.json`; this duplication risk is tracked as a post-implementation verification step rather than a launch blocker. See `docs/119-acp-junie-lane.md`. OMP-1 spawns Oh My Pi's native ACP server (`omp acp`) as a regular permission-gated lane. OMP native-loads project root `.mcp.json`, so Krypton skips only the project `.mcp.json` bridge for OMP while still injecting the per-lane `krypton-harness-memory` MCP server through `session/new.mcpServers`. OMP auth/install remains outside Krypton (`omp` first-run/auth-broker or provider keys in the login shell), and startup errors include OMP-specific install / old-CLI / auth / API-key / empty-stderr hints. See `docs/122-acp-omp-lane.md`. Grok-1 spawns xAI Grok Build's native ACP server (`grok agent stdio`) as a regular permission-gated lane with the `.mcp.json` bridge and per-lane memory MCP enabled. Grok auth/install remains outside Krypton (`grok` first-run browser login, or `XAI_API_KEY` in the login shell), and startup errors include Grok-specific install / old-CLI-without-ACP / auth / API-key / empty-stderr hints. No CLI `-m` model flag is passed at spawn in v1: `acp_harness.lane_models["grok"].active` drives the chip and applies through the generic `session/set_model` path if Grok advertises model state at `session/new`. See `docs/135-acp-grok-lane.md`. Copilot-1 spawns GitHub Copilot CLI's native ACP server (`copilot --acp --stdio`, public preview) as a regular permission-gated lane with the `.mcp.json` bridge and per-lane memory MCP enabled. Copilot auth/install remains outside Krypton (`copilot` `/login` device flow, or a fine-grained PAT with the Copilot Requests permission exported as `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`), and startup errors include Copilot-specific install / old-CLI-without-ACP / auth / token / empty-stderr hints. Verified against Copilot CLI 1.0.60: `initialize` advertises `mcpCapabilities {http, sse}` and `promptCapabilities.image`, so the per-lane HTTP `krypton-harness-memory` MCP passes `filterByCapability`. Whether Copilot actually *honors* `session/new.mcpServers` is still unverified (advertising a capability is not proof — Cursor advertised and regressed, spec 113); this needs a live `session/new` + tool call to confirm. Copilot's ACP server documents no model flag and advertised no model state at `initialize`, so `acp_harness.lane_models["copilot"].active` is chip-only unless Copilot later advertises model state at `session/new` (then the generic `session/set_model` path applies). See `docs/150-acp-copilot-lane.md`. Cline-1 spawns the Cline CLI's native ACP server (`cline --acp`, stdio) as a regular permission-gated lane with the `.mcp.json` bridge and per-lane memory MCP enabled, delivered through a **native-config overlay** rather than `session/new`: verified against cline 3.0.24, `initialize` advertises **no `mcpCapabilities`**, so an http/sse server passed through `session/new.mcpServers` is dropped and never connects (the regression-free analogue of Cursor's "advertises then ignores"). Instead Krypton writes a per-lane `cline_mcp_settings.json` (memory server tagged `streamableHttp`, plus the spec-83 project bridge) under `~/.config/krypton/runtime/cline/<harness>/<lane>/` and points `CLINE_MCP_SETTINGS_PATH` at it at spawn — leaving the global `~/.cline` auth/providers untouched. Cline auth/install remains outside Krypton (`npm i -g cline`, then `cline auth`), and startup errors include Cline-specific install / old-CLI-without-ACP / auth / token / empty-stderr hints. Cline does expose `-m`/`--provider` CLI flags, but v1 leaves the model to `cline auth`/config: `acp_harness.lane_models["cline"].active` is chip-only unless Cline advertises model state at `session/new` (then the generic `session/set_model` path applies). See `docs/159-acp-cline-lane.md`. The built-in OpenCode backend launches `opencode acp`, then selects `zai-coding-plan/glm-5.1` through ACP session configuration so Krypton controls its default model without writing OpenCode config files. The reader task dispatches by message shape: responses resolve `pending[id]` oneshots, inbound `fs/read_text_file` and `fs/write_text_file` requests are answered locally, `session/request_permission` is bridged to the frontend through a per-id oneshot, and `session/update` notifications are emitted on `acp-event-<session>`. ACP spawn can also carry HTTP MCP server descriptors into `session/new.mcpServers`, `session/load`, and `session/resume`. Both agent surfaces coexist on `Leader a` (pi-agent) and `Leader A` (ACP picker). See `docs/69-acp-agent-support.md`.
**Current harness backend policy:** The preceding backend list describes the shared ACP registry. Gemini remains available in the standalone ACP agent view but is excluded from ACP Harness lane/session pickers and backend-scoped directives.

22. **ACP extended session updates** — beyond `agent_message_chunk`, `agent_thought_chunk`, `tool_call(_update)`, `plan`, and `usage_update`, the harness also consumes `available_commands_update` (per-lane slash-command catalog) and `current_mode_update` (e.g. Claude plan-mode ↔ edit-mode). Each lane stores its own command list and current mode in `HarnessLane.availableCommands` / `currentMode` (with `modesById` looked up from `agentCapabilities.availableModes`). The lane head paints a purple mode chip via `renderModeChip()`, and the composer pops a slash-command palette when the draft matches `/^\/[a-zA-Z0-9_-]*$/` — `↑↓` selects, `Enter`/`Tab` inserts `/<name> ` at the cursor, `Esc` dismisses for the current draft. The Rust forwarder already whitelists both kinds in `handle_notification`; the gap was purely on the TS dispatcher side. Pi-1 emits neither so both surfaces stay quiet for it. See `docs/87-acp-extended-session-updates.md`.

23. **ACP fs activity surface** — Krypton's Rust ACP backend implements `fs/read_text_file` and `fs/write_text_file` as inbound JSON-RPC requests (declared via `clientCapabilities.fs`) so agents that prefer ACP file primitives over their internal tools route reads/writes through the harness. Every read and write now emits an `fs_activity` event (success and failure), and the lane transcript renders a `📖 read` / `✏️ wrote` / `✗ failed` chip with the affected path. This is visibility-only — the writes still go through immediately and there is no diff preview yet. Pi-1 stays N/A because pi-acp does not request the fs capability. See `docs/88-acp-fs-activity-surface.md`.

24. **ACP diff preview & gated writes** — `tool_call.content[].type === 'diff'` payloads (sent by Codex/Claude/Gemini with `oldText`+`newText`) now render in the harness as inline +/- hunks with line numbers via the shared `src/acp/diff-render.ts` module (extracted from `acp-view.ts`). For `fs/write_text_file`, the Rust handler holds the JSON-RPC reply on a `oneshot` channel (mirroring `session/request_permission`), reads the current disk content as `oldText`, emits a `fs_write_pending` event, and waits for the user's accept/reject decision through the new `acp_fs_write_response` Tauri command before writing or replying with a JSON-RPC error. Both `fs/read_text_file` and `fs/write_text_file` now go through `validate_fs_path`, which canonicalizes the requested path and rejects anything outside the lane's project root. Keys: `a` accept, `r` reject, `A` accept-all-this-turn, `R` reject-all-this-turn — reusing the `acceptAllForTurn`/`rejectAllForTurn` flags introduced for permissions. See `docs/89-acp-diff-preview.md`.

25. **ACP Harness view** — `AcpHarnessView` (`src/acp/acp-harness-view.ts`) opens multiple `AcpClient` lanes in one content tab for the focused working directory. It renders a read-only lane dashboard plus an input-only command center, shows the project cwd and current Git branch in the composer status line, routes prompts only to the active lane, handles per-lane permission prompts, stages pasted/dropped/global-captured images in the active lane composer, sends staged images as ACP image blocks with base64 data and local file URIs, and creates an MCP memory store on the existing localhost hook server. Each lane receives a lane-scoped HTTP memory endpoint; agents create/update/delete/search/get memory through MCP tools while the human observes the current board. Harness hash commands provide lane lifecycle controls including `#cancel`, `#restart`, `#new`, `#new!`, `#mem clear`, and `#mcp`; fresh-session commands use client disposal and a lane spawn epoch to ignore late events from replaced subprocesses. Memory persists per project directory. Open via `Leader Y` or command palette. The active lane **right rail** can show a contextual **lane peek** for one inferred non-active lane plus optional **lane-pair activity heat** (active vs peeked; palette-controlled metric/window/detail). See `docs/72-acp-harness-view.md`, `docs/73-acp-harness-mcp-memory.md`, and `docs/109-acp-contextual-lane-peek.md`.
26. **Cursor trail** — `CursorTrail` (`src/cursor-trail.ts`) renders a rainbow flame particle effect on both the mouse cursor and the terminal text cursor. Spawns burst particles on `mousemove` (document-level capture) and polls the focused terminal's `buffer.active.cursorX/Y` each frame. Particles drift upward with turbulence, cycle through rainbow hues, and fade with quadratic falloff. Appended to `document.body` at z-index 99999. Togglable at runtime via `toggle()`

27. **ACP Harness plan tracking** — `session/update { sessionUpdate: 'plan' }` notifications are no longer rendered as transcript items. Each lane stores the latest `entries[]` on `HarnessLane.plan`, and a per-active-lane floating panel (`.acp-harness__plan`, top-right of `.acp-harness__body`, z-index below the memory/help overlays) renders a `// plan` header with a `done/total` progress count and one row per entry. Status drives color (pending = dim, in_progress = amber, completed = green strikethrough); priority drives a 2px left border accent (high/medium/low). The panel auto-hides when a lane has no plan and clears on `#new`/`#new!`/`#restart`. Toggle collapse with `p` in transcript focus. See `docs/90-acp-plan-tracking.md`.

28. **ACP Harness render performance** — high-volume ACP event streams are batched in `AcpHarnessView` with a `requestAnimationFrame`-backed `scheduleRender()` so repeated message/tool chunks coalesce into one full dashboard render per frame. Lightweight `available_commands` and `mode_update` events patch only their affected composer/header surfaces. Assistant transcript items cache parsed/highlighted markdown on the row object, and pretext transcript rows cache measured line layouts by text, width, font, and line-height, reducing repeat work when long visible histories are rebuilt. See `docs/94-acp-harness-render-performance.md`.

29. **ACP Harness Peering (inter-lane messaging)** — `LaneBus` (`src/acp/lane-bus.ts`), `LaneInbox` (`src/acp/lane-inbox.ts`), and `InterLaneCoordinator` (`src/acp/inter-lane.ts`) let any two lanes in the same harness exchange messages for user-directed peer review. `AcpHarnessView` centralizes status mutations through `setLaneStatus()` which emits `lane:status` events on the bus; the coordinator subscribes and drains target inboxes whenever a lane returns to `idle`. The Rust MCP server (`krypton-harness-bus`) exposes two extra tools alongside the memory tools: `peer_send` emits an `acp-inter-lane-message` Tauri event with a JSON envelope, and `peer_list` returns naming guidance. Memory and peer tools are split into separate frontend taxonomy sets and combined only for harness auto-allow detection; auto-allowed requests still render structured permission cards with the matched rule. A lane that ends a turn with outstanding sends transitions to a new `awaiting_peer` status; the composer rejects new user prompts in that state with pending-peer guidance such as `awaiting Claude-1 · <1m · #cancel`, and `#cancel` releases the lane via `InterLaneCoordinator.cancelConversationsFor()`, notifying peers with a synthesized inbox notice. The coordinator injects programmatic user-turns via `enqueueSystemPrompt()`, bypassing the UI composer. **Cross-harness (spec 141):** a module-level `HarnessDirectory` singleton (`src/acp/harness-directory.ts`) makes peering reach every open harness view, even across projects. It vends globally-unique, never-recycled lane numbers (`nextLaneNumber(labelPrefix)`) so a bare `displayName` permanently identifies one lane, and routes a cross-view `peer_send` in-process by splitting `deliver()` into `acceptInbound()` (run on the *target* coordinator, where the pending state that classifies initiator-vs-replier lives) and `recordOutbound()` (run on the sender's). Pending is keyed by the foreign `displayName` so the reply-clear matches on both legs; `#cancel` against a foreign peer routes `acceptForeignCancellation` onto the target view, and a disposing view flips `alive=false` then fans `onForeignHarnessClosed` snapshots out so waiting senders are notified. `peer_list` folds in `peersFor(harnessId)` (foreign peers tagged `local:false`, carrying `cwd`). The `#review` command (spec 145) rides this same `peer_send` path — agent-orchestrated multi-reviewer fan-out, same-project (the diff subject needs a shared worktree). See `docs/106-inter-lane-messaging.md`, `docs/141-cross-harness-peering.md`, `docs/145-harness-design-review-panel.md`, and `docs/107-acp-harness-transcript-readability.md`.

30. **ACP Harness Attention Triage (specs 128/130)** — A default-on router that distils *the decisions needing the human* (vs `lane peek heat`, which ranks activity). `AttentionTriageStore` (`src/acp/attention-triage.ts`) owns a **demand queue** of self-reported `JudgementItem`s ranked by reversibility (ties oldest-first) plus per-lane `LaneTriageStats` (flagged vs silent turns, counted at busy→idle in `finishTurn`). Any lane that receives the `krypton-harness-memory` MCP server is advertised `attention_flag` / `attention_resolve`; `hook_server.rs` validates the presence floor and round-trips to the frontend (`acp-attention-flag` → frontend assembles git blast-radius from the shared `acp_collect_review_git_state` collector's `diffstat`, inserts the item, replies `{ item_id }`). `attention_resolve` demotes a lane's own item to the silent pile (never deleted). The old `triage_equipped` directive field remains legacy metadata and visible as a badge, but no longer gates tool visibility. The view renders a static **backpressure gauge** (`N attention`, weight-dynamic since spec 138 — coloured by the heaviest open reversibility tier with a count pip strip, still motionless) in the global workspace footer and a summon-on-demand overlay (`Leader ;`); acknowledge is pure bookkeeping, redirect injects on the lane's next idle via `InterLaneCoordinator.deliverRedirect()`, dig opens the lane transcript. See `docs/128-attention-triage.md`, `docs/130-default-attention-triage.md`, and `docs/adr/0001-attention-triage-self-reported-router.md`.

31. **ACP Harness Review Quality Matrix (spec 146)** — A summary-only, session-only history of `#review` rounds per authoring lane, mirroring attention triage's surfaces. `ReviewQualityStore` (`src/acp/review-quality.ts`) keeps a per-lane `ReviewOutcome[]` (newest-first; `{ subjectLabel, reviewerCount, blockers, warnings, at }`) in memory, dropped on dispose. After synthesizing a `#review`, the convening lane self-reports via the default-on `review_outcome` MCP tool (`{ blockers, warnings, reviewer_count, subject_label }`); `hook_server.rs` round-trips it to the frontend (`acp-review-outcome` → `store.record()`, bare ack) — **no git collection and no retained review-session state** (the deliberate simplification that resolved the design-review blockers). It is an **observation, not a score** (ADR-0004): raw counts only, no verdict, no stored diff size, no jump-to-transcript anchor, no ranking. The view publishes a neutral `N reviews` depth indicator on the global footer via the `review:quality` ViewBus signal (distinct from the attention gauge — depth, not demand; never coloured by badness) and a summon-on-demand read-only overlay (`Leader '`, `j/k` switch lane). See `docs/146-review-quality-matrix.md` and `docs/adr/0004-review-matrix-observation-not-score.md`.

32. **Diff review priority (spec 160)** — The authoring lane self-reports a per-change *reading-order hint* over the working diff via the default-on `mark_review_priority { ranges }` MCP tool (new-side line anchors; `high` / `routine` only — `normal` is the unreported default, so silence yields today's full diff). `hook_server.rs` validates and round-trips it (`acp-review-priority` → `AcpHarnessView.handleReviewPriority`, which stores the latest report per authoring lane in `reviewPriorityReports`, replies `{ recorded }`). The **Diff Window** (`src/diff-view.ts`) pulls a merged snapshot on open and on each auto-refresh through the compositor broker (`resolveDiffReviewPriority` → `diff.review-priority` control op on every harness owning the repo — a pull, no ViewBus broadcast), then maps each diff2html hunk to the overlapping ranges (highest level wins): `routine` hunks **collapse in place** to a one-line summary (`Enter`/click expands, remembered for the session via `expandedHunks`), `high` hunks get a full-cell gutter tint + a `◆ high` header badge and a dedicated `}`/`{` navigation (plain `n`/`N` still walk all hunks). The diff **always stays in file order — nothing is hidden or reordered**, and a range that maps to no hunk reverts to `normal` (under-collapse, never over-collapse). The nav header carries a static `N high · N routine` depth count. A **cross-file priority panel** (`p`, `.krypton-diff__priority`) docks right of the diff inside a flex `krypton-diff__content-row` (collapses via `[hidden]` so the diff reflows to full width — never covers it) and lists every reported range, `high` grouped first then `routine`. It is **live-preview** (variant B): `j`/`k` move the selection *and* scroll+tint the region immediately (`.krypton-diff__preview-row`), no `Enter` — same-file scroll is instant, cross-file switches debounced ~80ms (`priorityPreviewTimer`) to coalesce fast runs; `Esc` restores the pre-open file+scroll, `Enter`/`q`/`p` keep the previewed position. Re-maps on auto-refresh. Purely advisory; the human keeps the lock (ADR-0009 — the silent-pile principle applied to a diff). Complements spec 158 (carries the *human's notes in*; 160 carries the *lane's hints out*) and reuses its line-range anchor concept. See `docs/160-diff-review-priority.md` and `docs/adr/0009-diff-review-priority-is-lane-self-reported.md`.

### Window DOM Structure

Krypton uses a cyberpunk/sci-fi chrome style. Each window has a titlebar with session label and PTY status, a **tab bar** (auto-shown when multiple tabs exist), and a **content area** containing the active tab's pane tree. Pane trees are binary splits — each leaf is a `.krypton-pane` hosting an xterm.js instance, and splits are `.krypton-split` containers with a `.krypton-split__divider` between two children.

```html
<html style="background: transparent">
<body style="background: transparent">
  <div class="krypton-workspace"
       style="background: transparent; width: 100vw; height: 100vh;">

    <div class="krypton-window krypton-window--focused" id="win-0"
         style="position: absolute;">
      <div class="krypton-window__chrome">
        <div class="krypton-window__titlebar">
          <div class="krypton-window__label-group">
            <div class="krypton-window__status-dot"></div>
            <span class="krypton-window__label">SESSION_01</span>
          </div>
          <span class="krypton-window__pty-status">~/projects</span>
        </div>
        <div class="krypton-window__header-accent"></div>
      </div>

      <!-- Tab bar: auto-shown when >1 tab or always_show_tabbar = true -->
      <div class="krypton-window__tabbar krypton-window__tabbar--visible">
        <div class="krypton-tab krypton-tab--active" data-tab-id="tab-0">
          <span class="krypton-tab__title">Shell 1</span>
        </div>
        <div class="krypton-tab" data-tab-id="tab-1">
          <span class="krypton-tab__title">Shell 2</span>
        </div>
      </div>

      <!-- Content area: hosts the active tab's pane tree -->
      <div class="krypton-window__content">
        <!-- Single pane (leaf node) -->
        <div class="krypton-pane krypton-pane--focused" data-pane-id="pane-0">
          <!-- xterm.js mounts here -->
        </div>

        <!-- OR a split with two panes -->
        <!--
        <div class="krypton-split krypton-split--vertical">
          <div class="krypton-pane krypton-pane--focused" data-pane-id="pane-0">
            xterm.js
          </div>
          <div class="krypton-split__divider"></div>
          <div class="krypton-pane" data-pane-id="pane-1">
            xterm.js
          </div>
        </div>
        -->
      </div>

      <div class="krypton-window__footer">
        <div class="krypton-window__usage-status">
          <span class="krypton-window__usage-provider">CODEX 5h 41% / week 34%</span>
          <span class="krypton-window__usage-provider">CURSOR month 19%</span>
        </div>
        <div class="krypton-notif">...</div>
      </div>

      <!-- Corner accents -->
      <div class="krypton-window__corner krypton-window__corner--tl"></div>
      <div class="krypton-window__corner krypton-window__corner--tr"></div>
      <div class="krypton-window__corner krypton-window__corner--bl"></div>
      <div class="krypton-window__corner krypton-window__corner--br"></div>
    </div>

    <!-- More windows... -->

    <!-- Quick Terminal (overlay, toggled via Cmd+I) -->
    <div class="krypton-quick-terminal" id="quick-terminal"
         style="position: absolute; z-index: 5000; display: none;">
      <!-- Same chrome structure as regular windows (no tabs/panes) -->
      <div class="krypton-window__chrome">
        <div class="krypton-window__titlebar">
          <div class="krypton-window__label-group">
            <div class="krypton-window__status-dot"></div>
            <span class="krypton-window__label">QUICK_TERMINAL</span>
          </div>
          <span class="krypton-window__pty-status">PTY_STREAMS // ACTIVE</span>
        </div>
      </div>
      <div class="krypton-window__content">
        <div class="krypton-window__body">
          <!-- xterm.js mounts here (single terminal, no tab/pane structure) -->
        </div>
      </div>
    </div>

    <!-- Dashboard overlay (shown when a dashboard is active, z-index: 9500) -->
    <div class="krypton-dashboard krypton-dashboard--visible">
      <div class="krypton-dashboard__backdrop"></div>
      <div class="krypton-dashboard__panel">
        <div class="krypton-dashboard__header">
          <span class="krypton-dashboard__title">Git Status</span>
          <span class="krypton-dashboard__shortcut-hint">Cmd+Shift+G</span>
          <button class="krypton-dashboard__close">&times;</button>
        </div>
        <div class="krypton-dashboard__content">
          <!-- Dashboard-specific content rendered by onOpen() -->
        </div>
      </div>
    </div>

    <!-- Which-key popup (shown during compositor/resize/move/tab-move modes) -->
    <div class="krypton-whichkey">...</div>

    <!-- Workspace footer (single 28px bottom rail: status + music segment) -->
    <footer class="krypton-workspace-footer" role="status" aria-live="polite">
      <div class="krypton-workspace-footer__left">NORMAL · terminal Shell 1</div>
      <div class="krypton-workspace-footer__center">~/projects · main *</div>
      <div class="krypton-workspace-footer__right">
        <span class="krypton-workspace-footer__hint">Leader v select · Cmd+O files</span>
        <div class="krypton-workspace-footer__music"></div>
      </div>
    </footer>
  </div>
</body>
</html>
```

### Window Identity Model

Each window has a stable `window_id` (e.g., `"win-0"`, `"win-1"`). The workspace state is:

```
workspace_name -> [ WindowSlot { window_id, grid_position, abs_override?, session_ids } ]
```

When switching workspaces:
- Windows in both workspaces: **animate** from current to target position/size
- Windows only in target: **create** with entrance animation, assign idle session or spawn new shell
- Windows only in current: **hide** with exit animation (DOM hidden, PTY kept alive in session pool)

## 5.5 Config Manager (Backend)

The Config Manager (`src-tauri/src/config.rs`) handles loading and serving the TOML configuration:

- **Serde structs**: `KryptonConfig` with subsections `ShellConfig`, `FontConfig`, `TerminalConfig`, `ThemeConfig` (with `ThemeColors`), `QuickTerminalConfig`, `WorkspacesConfig`. All derive `Default` and use `#[serde(default)]` so missing fields fall back to built-in defaults.
- **Config path**: `~/.config/krypton/krypton.toml` on all platforms (resolved via `dirs::home_dir()`).
- **First-run behavior**: If the config file doesn't exist, the directory is created and a default config is written.
- **Parse errors**: Logged and silently fall back to defaults (app still starts).
- **IPC**: `get_config` Tauri command returns the full `KryptonConfig` to the frontend on startup. `run_command` Tauri command runs a short-lived process (non-PTY) and returns stdout, used by overlay dashboards to gather data (e.g., `git status --porcelain`, `git branch --show-current`). `query_sqlite` Tauri command executes read-only SQL queries against a specified SQLite database and returns rows as JSON objects, used by the OpenCode dashboard to read session/message/token data. Pencil uses dedicated file IPC (`read_pencil_file`, `write_pencil_file`, `rename_pencil_file`, `scan_pencil_dir`) so drawing IO and picker rename do not shell out.
- **Shell config**: `spawn_pty` command accepts optional `shell`/`shell_args` params from the frontend, falling back to config values, then `$SHELL`.
- **Exit detection**: each PTY session has a reader thread for output/progress events and a child wait thread for lifecycle events. Either PTY EOF/error or child exit emits `pty-exit`; the frontend de-duplicates duplicate exit events.

Frontend counterpart: `src/config.ts` defines matching TypeScript interfaces and a `loadConfig()` function. The compositor's `applyConfig()` method applies settings (font, terminal, theme colors, Quick Terminal sizing, workspace gap/step sizes) before the first window is created.

## 5.6 Workspace Manager (Backend)

The Workspace Manager lives in Rust and handles the data/logic side:

- Parse `[[workspaces.layouts]]` from TOML config
- Store built-in presets and user overrides
- Respond to `invoke("switch_workspace", { name })` — send target workspace layout to frontend compositor via Tauri event
- Track window-to-session mapping in the session pool
- Handle `invoke("get_workspace_list")` — return available workspace names for UI display

The actual window positioning and animation is **frontend-driven** (CSS/JS), not Rust-driven, because the compositor operates entirely within the DOM.

### Theme Engine (Backend — `src-tauri/src/theme.rs`)

The Theme Engine lives in Rust (`theme::ThemeEngine`) and manages theme loading:

- Embeds built-in themes at compile time via `include_str!` (krypton-dark, legacy-radiance)
- Scans `~/.config/krypton/themes/*.toml` for custom theme files
- Resolves themes by name (custom themes take precedence over built-in)
- Applies `[theme.colors]` config overrides on top of the resolved theme
- Serves full theme data (`FullTheme` struct — meta, colors, chrome, focused, workspace, ui) to the frontend via `invoke("get_theme")`
- Lists available themes via `invoke("list_themes")`
- Supports `invoke("reload_config")` for manual reload
- **Tauri commands**: `get_theme`, `list_themes`, `reload_config`
- **Tauri events**: `theme-changed`, `config-changed` (emitted on hot-reload)

### Theme Engine (Frontend — `src/theme.ts`)

The Frontend Theme Engine (`FrontendThemeEngine`) receives theme data and applies it:

- Sets 50+ `--krypton-*` CSS custom properties on `document.documentElement`
- Builds xterm.js theme objects from theme colors for terminal instances
- Listens for `theme-changed` Tauri event from backend (hot-reload)
- Notifies the compositor to update all existing terminal instances on theme change
- `styles.css` uses `var(--krypton-*)` throughout so theme changes cascade instantly

### Config Hot-Reload (Backend — `src-tauri/src/lib.rs`)

- `notify` crate watches `~/.config/krypton/` recursively for `.toml` file changes
- 300ms debounce prevents rapid-fire reloads
- On change: re-parses config, resolves theme, emits `theme-changed` and `config-changed` events
- Config stored as `Arc<RwLock<KryptonConfig>>` for safe concurrent access

## 5.6 Input Router & Mode System (Frontend)

The input router is the central keyboard dispatcher. It determines what happens with each keypress based on the current **mode**:

### Modes

| Mode | Activated by | Behavior | Exit |
|------|-------------|----------|------|
| **Normal** | Default | Keypresses forwarded to focused window's PTY | Enter another mode via leader key |
| **Compositor** | Leader key (`Cmd+P`) | Keypresses interpreted as compositor commands, or as focused content-view leader actions when the view owns a non-conflicting local key | Auto-exits after one action, or `Escape` to cancel |
| **Resize** | `Leader` then `R` | Arrow keys resize the focused window; step size configurable | `Escape` or `Enter` to confirm |
| **Move** | `Leader` then `M` | Arrow keys reposition the focused window | `Escape` or `Enter` to confirm |
| **Selection** | `Leader` then `v` or `V` | Vim-like keyboard text selection — virtual cursor navigates buffer with h/j/k/l/w/b/e/0/$, `v` toggles char-wise selection, `V` toggles line-wise, `y` yanks to clipboard | `Escape` to cancel, `y` to yank and exit |
| **Hint** | `Leader` then `Shift+H` or `Cmd+Shift+H` (global) | Scans visible buffer for regex patterns (URLs, paths, emails), overlays keyboard labels on matches. Type a label to act (open/copy/paste). | `Escape` to cancel, or selecting a label |
| **Dashboard** | Dashboard shortcut (e.g., `Cmd+Shift+G` for Git) | Displays a full-screen overlay panel. Keys delegated to the active dashboard's `onKeyDown` handler. | `Escape`, or re-pressing the dashboard's toggle shortcut |

**Compositor single-action keys (in Compositor mode):**

Focused content views may add local leader actions by implementing `ContentView.getLeaderKeyBindings()`. Each view exports static `LeaderKeySpec` metadata beside the view implementation; `src/leader-keys.ts` owns canonical key normalization and the global reserved-key list. `src/leader-keys.test.ts` imports all local metadata and fails if any local key conflicts with a global key or another local key. Disabled local bindings are hidden from which-key and never fall back to global behavior. Current local bindings include Markdown `;` for link hints, ACP Harness `+`/`_`/`=`/`0` for lane lifecycle, metrics, and project-scoped session resume, and Pencil `/` to open an existing drawing in the focused tab plus `?` for creating a new drawing beside the focused file.

| Key | Action |
|-----|--------|
| `g` | Cycle shader preset on focused pane (none → crt → hologram → glitch → bloom → matrix → none) |
| `G` (Shift+g) | Toggle shaders on/off globally |
| `c` | Clone SSH session from focused pane into a new tab (via ControlMaster multiplexing) |
| `C` (Shift+c) | Clone SSH session from focused pane into a new window |
| **Command Palette** | `CmdOrCtrl+Shift+P` | Text input filters the action list; Enter executes; Escape closes | `Escape` or action execution |
| **Search** | `CmdOrCtrl+F` | Text input searches scrollback in the focused window | `Escape` to close |

**Global hotkeys that work from any mode:**
- `Cmd+I` — Toggle Quick Terminal (show/hide centered overlay terminal)
- `Cmd+Shift+P` — Toggle Command Palette (fuzzy-searchable action list)
- `Leader Y` — Open ACP Harness, a multi-lane ACP content view sharing the focused CWD
- `Ctrl+Shift+S` — Global macOS screen capture; stages into the active ACP Harness lane when that view is focused, otherwise routes to the smart prompt dialog queue
- `Cmd+Shift+<` / `Cmd+Shift+>` — Cycle focus through windows
- `Ctrl+Shift+U` / `Ctrl+Shift+D` — Scroll terminal buffer up/down by one page
- `Cmd+Shift+H` — Enter hint mode (scan terminal for URLs/paths/emails, overlay labels)
- `Cmd+Shift+G` — Toggle Git Dashboard (overlay showing git status for focused terminal's CWD)
- `Cmd+Shift+O` — Toggle OpenCode Dashboard (session history, token usage, model/tool stats from local SQLite DB)

### Key routing flow

```
Keypress
  |
  v
[Is Quick Terminal toggle?] --yes--> Show/hide Quick Terminal, transfer focus
  |
  no
  v
[Is a global hotkey?] --yes--> Execute global action (workspace switch, command palette, etc.)
  |
  no
  v
[Current mode?]
  |
  +-- Normal --------> Forward to focused window's xterm.js -> PTY
  +-- Compositor ----> Dispatch focused-view local leader key if owned, otherwise interpret as global compositor command
  +-- Resize --------> Adjust focused window size
  +-- Move ----------> Adjust focused window position
  +-- Selection -----> Navigate virtual cursor / expand selection
  +-- Hint ----------> Filter/select hint labels -> execute action
  +-- Cmd Palette ---> Filter/select action list
  +-- Dashboard -----> Delegate to active dashboard's onKeyDown handler
  +-- Search --------> Update search query
```

### Command Palette

The command palette is a fuzzy-searchable overlay listing **every action** in Krypton:

- Window actions: new, close, focus next/prev, focus by index, maximize, restore, swap, reset layout, toggle focus layout, toggle pin
- Tab actions: new, close, next/prev, move to window
- Workspace actions: switch by name, next/prev workspace
- Pane actions: split horizontal/vertical, close, navigate
- Theme actions: switch theme
- Clipboard: copy, paste
- Search: open search, next/prev match
- Config: reload config, open config file
- Dashboard actions: toggle registered dashboards (Git Status, etc.)
- SSH actions: clone session to new tab/window
- Application: quit

Each entry displays the action name and its current keybinding (if any).

## 5.7 Animation Engine (Frontend)

A dedicated module that handles all motion:

- **Workspace transitions** — on switch, compute start/end rects for each window, apply chosen animation (slide, crossfade, morph)
- **Entrance/exit effects** — windows appearing or disappearing
- **Keyboard-driven resize/move** — smooth real-time position updates as user holds arrow keys in resize/move mode
- **Spring physics** (optional) — for `spring` easing, implement a simple spring solver

Implementation options:
- **CSS transitions** — simplest, hardware-accelerated `transform` and `opacity`
- **Web Animations API** — more control, cancellable, reversible
- **requestAnimationFrame loop** — for spring physics or complex choreography

The animation engine must maintain **60 FPS** and avoid layout thrashing (use `transform: translate()` + `width`/`height`, not `top`/`left`).

## 5.8 Sound Engine (Rust Backend)

The sound engine runs entirely in the Rust backend (`src-tauri/src/sound.rs`) using the `rodio` crate for OS-native audio playback. The frontend `src/sound.ts` is a thin IPC wrapper — it contains no Web Audio API code. This eliminates all AudioContext degradation, suspended-state, and silence bugs that plagued the previous browser-based implementation.

### Architecture

```
App start (lib.rs setup)
  |
  v
SoundEngine::new() — spawns dedicated "krypton-audio" thread
  |                    (owns OutputStream + Sinks, receives AudioMsg via mpsc)
  |
  v
SoundEngine::init(resource_dir) — sends LoadPack message to audio thread
  |                                  audio thread reads 17 WAV files into HashMap<String, Vec<u8>>
  |
  v
[Ready — WAV bytes cached in audio thread memory]

---

Frontend action (compositor/input-router event)
  |
  v
SoundEngine.play('window.create')         [src/sound.ts — thin IPC wrapper]
  |
  v
invoke('sound_play', { event })            [Tauri IPC]
  |
  v
sound::sound_play() command                [src-tauri/src/sound.rs]
  |  - Check enabled, per-event override, cooldown dedup (50ms)
  |  - Map event -> WAV name
  |  - Calculate volume (master * per-event override)
  |
  v
mpsc::Sender::send(AudioMsg::Play { wav_name, volume })
  |
  v
Audio thread receives message
  |  - Prune finished Sinks
  |  - Check MAX_CONCURRENT (8)
  |  - Clone WAV bytes from buffer cache
  |  - Decoder::new(Cursor::new(bytes))
  |  - Sink::try_new() -> set_volume() -> append(source)
  |
  v
OS audio output (via cpal/CoreAudio)
```

### Key Design Decisions

- **Dedicated audio thread** — `rodio::OutputStream` is `!Send+!Sync` (platform audio handles), so all audio resources live on a dedicated named thread (`krypton-audio`). The Tauri-managed `SoundEngine` holds only an `mpsc::Sender<AudioMsg>` which is `Send+Sync`.
- **WAV-only** — no procedural synthesis. Each sound pack is a directory of 17 pre-rendered WAV files under `src-tauri/sounds/<pack>/`. Total ~1.4 MB for both packs.
- **In-memory buffers** — WAV file bytes are read into `Vec<u8>` at pack load time. Each playback clones the bytes into a `Cursor` for `rodio::Decoder`. This avoids filesystem I/O on the hot path.
- **Overlap management** — same constants as the previous frontend implementation: `MAX_CONCURRENT=8` (excess dropped), `KEYPRESS_THROTTLE_MS=25`, `EVENT_COOLDOWN_MS=50`. Enforced in the `SoundEngine` (Tauri command side) before sending to the audio thread.
- **Fire-and-forget IPC** — frontend `invoke()` calls don't await completion. The Tauri command acquires the mutex, checks throttle/cooldown, sends a channel message, and returns immediately. Actual audio playback is asynchronous on the audio thread.
- **Graceful degradation** — if no audio device is available, `OutputStream::try_default()` fails on the audio thread, which drains the channel and exits. All `play()` calls become silent no-ops.
- **Hot-reload** — on `config-changed`, `lib.rs::reload_and_emit()` calls `engine.apply_config()` directly on the Rust side. If the pack changed, a `LoadPack` message is sent to the audio thread.

### macOS Backdrop-Filter Freeze (Platform Gotcha)

> Implemented: 2026-03-16

CSS `backdrop-filter: blur()` on macOS transparent WKWebView windows causes the native compositor to **snapshot** the content behind the blurred element rather than continuously compositing it live. When the Tauri window gains focus, macOS optimizes rendering by freezing this snapshot — dynamic desktop content (video wallpapers) behind terminal windows stops updating.

**Fix:** All `backdrop-filter` / `-webkit-backdrop-filter` declarations were removed from `src/styles.css`. Semi-transparent `background` colors (rgba with alpha) remain, providing a tinted overlay without triggering the snapshot. Affected elements: `.krypton-window`, `.krypton-quick-terminal`, `.krypton-whichkey__popup`, `.krypton-hint-toast`, `.krypton-palette__container`, `.krypton-dashboard__backdrop`.

Additionally, xterm.js's internal color parser rejects alpha < 255, falling back to opaque `#000000` on `.xterm-scrollable-element`. A CSS `!important` override was added for that element.

Config/theme keys `blur`, `backdrop_blur` remain in parsers for forward compatibility but are currently **inert**.

See also: `docs/16-terminal-shaders.md` for related visual rendering.

### Webview Panes (Platform Gotcha)

> Implemented: 2026-05-11

In-app webview panes (`PaneContentType = 'webview'`) embed a Tauri v2 child `Webview` via `Window::add_child` (gated behind the `unstable` Cargo feature). Native child webviews are `NSView` / `HWND` subviews and therefore **render above all host DOM unconditionally** on every platform. Three implications shape the implementation in `src-tauri/src/webview.rs` and `src/webview-view.ts`:

1. **Chrome insets rather than overlays.** The cyberpunk address bar / loading bar live in DOM at the top of the pane; the native webview is positioned to fill the area below them. DOM corner accents and glow overlays surround the webview rect rather than covering it.
2. **Overlays must hide the webview.** Anything that needs to draw on top of the pane area (command palette, dashboard, hint mode, workspace transitions) calls `compositor.suspendAllWebviews()` to issue `set_webview_visible(false)` on every child webview, then `resumeAllWebviews()` afterwards. Pane rects that go to 0×0 (hidden tab, other workspace) auto-hide because the `ResizeObserver` pipeline reports a zero rect and emits `set_webview_visible(false)` instead of `resize_webview`.
3. **Keyboard escape via injected bridge.** When a child webview has focus, key events go to its renderer, not the host. The `WebviewBuilder::initialization_script` injects a capture-phase listener that catches Krypton leader chords (`Cmd+P`, `Cmd+L`, `Cmd+R`, `Cmd+[`/`]`, `Cmd+1..9`, `Cmd+W`) and forwards them via the `forward_chord` command. The Rust handler takes focus back to the main window and re-emits the chord as a `chord-from-webview` event that the input-router pipeline replays as a synthetic `KeyboardEvent`.

`WebviewBuilder::transparent` is documented as **"Not implemented" on macOS/iOS** — webview rects always render opaque. Pages cannot composite alpha with DOM behind them, which is why the chrome surrounds rather than overlays.

See `docs/102-webview-windows.md` for the full spec.

### macOS GUI Bundle stdio Hijacks PTY Master (Platform Gotcha)

> Implemented: 2026-05-18

When Krypton is launched as a macOS `.app` bundle (Finder, Dock, `open -a`, launchd), the process starts with **fds 0/1/2 closed** — GUI apps don't have an inherited terminal. The kernel's `open(2)` always returns the lowest free fd, so the very first `posix_openpt()` inside `portable-pty::PtySystem::openpty()` (called from `pty.rs::PtyManager::spawn_pty`) returns master fds `0`, `1`, or `2`. That means the PTY **master** end occupies what Rust believes is stderr.

Any subsequent `log::info!`, `tracing::warn!`, `eprintln!`, panic message, or third-party diagnostic (e.g. `fff_search::background_watcher` failing to start an FSEvent stream, `tauri_plugin_log` falling back to stderr) writes to fd 2 — which is the master side of the freshly-spawned shell's PTY. Writes to the master flow into the slave as if they were keystrokes, so fish/zsh tries to execute each log line as a command and emits `Unknown command: '[2026-…][app_lib::hook_server][INFO] …'`.

**Fix:** `lib.rs::ensure_std_fds()` runs at the top of `run()` (Unix only) and `dup2(/dev/null)` into any of fds 0/1/2 that are not already open. With those slots reserved, `openpty()` allocates the master at fd ≥ 3 and standard streams stay harmless.

Symptoms that point at this bug recurring:
- Newly-opened terminal panes show pasted-in log lines on startup
- Shell complains `Unknown command: '[…][app_lib::…][…]'` or `Unsupported use of '='`
- Only the first one or two panes after launch are affected — once a master grabs fds 0/1/2, later `openpty()` calls land on fd ≥ 3

### Tauri Commands

| Command | Parameters | Purpose |
|---------|-----------|---------|
| `sound_play` | `event: String` | Play a UI sound event |
| `sound_play_keypress` | `key: String` | Play a keypress sound (routes by key name) |
| `sound_apply_config` | `config: SoundConfig` | Apply sound config from frontend |
| `sound_load_pack` | `pack: String` | Switch sound pack |
| `sound_get_packs` | — | Get available packs and current selection |

### Integration Points

The frontend `SoundEngine` class (`src/sound.ts`) exposes the same `play()` / `playKeypress()` API as before. Call sites in `compositor.ts`, `input-router.ts`, `command-palette.ts`, and `main.ts` are unchanged.

| Caller | Event | Sound |
|--------|-------|-------|
| `compositor.createWindow()` | After window DOM created | `window.create` |
| `compositor.closeWindow()` | Before exit animation | `window.close` |
| `compositor.focusWindow()` | On focus change | `window.focus` |
| `compositor.toggleMaximize()` | On maximize/restore | `window.maximize` / `window.restore` |
| `compositor.toggleQuickTerminal()` | On show/hide | `quick_terminal.show` / `quick_terminal.hide` |
| `compositor.toggleFocusLayout()` | On layout toggle | `layout.toggle` |
| `input-router` (mode change) | On enter/exit mode | `mode.enter` / `mode.exit` |
| `input-router` (compositor key) | On resize/move step | `resize.step` / `move.step` |
| `input-router` (swap) | On swap complete | `swap.complete` |
| `main.ts` (startup) | After first window rendered | `startup` |
| PTY event listener | On BEL character | `terminal.bell` |
| PTY event listener | On shell exit | `terminal.exit` |
| `terminal.onData()` (both regular + QT) | On each keystroke to PTY | `keypress` (press phase only via `playKeypress('press', key)`) |

### Sound Packs

Two built-in packs, each containing 17 WAV files:

| Pack | Directory | Description |
|------|-----------|-------------|
| `deep-glyph` (default) | `src-tauri/sounds/deep-glyph/` | Rich, deep UI sounds |
| `mach-line` | `src-tauri/sounds/mach-line/` | Sharp, mechanical interface tones |

Packs are bundled as Tauri resources (declared in `tauri.conf.json`) and loaded at runtime from the app's resource directory. The command palette lists all available packs for switching.

### Harness Controller CLI

`kryptonctl` is an external Harness Controller, not an ACP lane. The Rust
control server (`src-tauri/src/control.rs`) publishes an authenticated
loopback HTTP endpoint and a user-private runtime descriptor. Requests cross
the Tauri boundary through `acp-control-request` / `acp_control_reply`, then
`src/acp/control-bridge.ts` routes typed domain operations through the
process-wide `HarnessDirectory` to the owning `AcpHarnessView`.

The frontend remains the only authority for live harness state. Rust owns
discovery, authentication, protocol parsing, and request timeout handling; it
does not mirror lanes, queues, transcripts, or permissions. Core v1 uses
ordinary request/response operations, and `kryptonctl acp send --wait` polls
typed lane state. Prompt-specific IDs and prompt-specific cancellation are
deferred. See `docs/154-harness-controller-cli.md`.

The same control server also exposes a one-way **event stream** for web-app
remote control (`GET /control/v1/events`, SSE — doc 175). Keeping the
authority split, the frontend *pushes* the harness events it already processes
(`acp-harness-view` event sink + status transitions) over `acp_control_publish`
into a per-server `broadcast` channel that Rust fans out to subscribers; Rust
still derives no state. Commands stay on `POST /operations`. A browser app
either proxies server-side (default; bearer token stays off-browser) or calls
directly when `[acp_controller].cors_origins` lists its exact origin. See
`docs/175-harness-web-control-api.md`.

A Chrome/Chromium **browser extension** (`extension/`) is a packaged client of
this control API (doc 176): it sends the current page selection into a lane as a
chosen action via `lane.send`. Token discovery is zero-config through a Native
Messaging host, `krypton-bridge` (`src-tauri/src/bin/krypton-bridge.rs`), which
reads the `0600` control descriptor as the user; Krypton writes the host
manifest into the browser's `NativeMessagingHosts` dir on launch
(`src-tauri/src/native_host.rs`). The control API binds a fixed loopback port
(default `8766`) so the extension needs no port discovery.

When the popup is opened with **no text selected**, the extension extracts the
page's main content as Markdown client-side (doc 177): it injects a bundled
**Defuddle** (`extension/content-extract.src.js` → `dist/content.bundle.js`, built
by `make extension`) into the active tab on demand and sends the resulting
Markdown + metadata, so pages a lane cannot fetch server-side (Reddit, YouTube,
login-walled, JS-rendered) still work. A selection always takes precedence; the
injection stays on-demand (activeTab) rather than a declared content script.

**GitHub issue fixing** (doc 178) makes "fix this issue" a single surface-agnostic
operation. Any surface — Krypton's command palette / `#fix-issue` verb, the
extension popup, or a status card the extension injects onto the GitHub issue page
(a declared `github.com/*/issues/*` content script) — converges on the frontend
`dispatchIssue()` path (also the `github.dispatch-issue` control op), which records
an issue↔lane binding (harness-level map keyed by `owner/repo#123`) and prompts a
fresh lane. The lane self-reports progress via an `issue_report` MCP tool; status
is snapshot-first (`github.issue-status`) plus an `issue_status` SSE event, so the
injected card is refresh-safe and survives a Krypton restart (bindings persist to
disk next to the per-harness memory file). The `issueKey`-addressed reads
(`github.issue-status / list-issues / unlink-issue`) fan out across harnesses in
`control-bridge`. Read-only overlay only — no write-back to GitHub.
