# 7. Configuration File Format

Configuration is read from a TOML file at `~/.config/krypton/krypton.toml` on all platforms. The file is created with defaults on first launch if it doesn't exist.

Custom themes and sound packs are stored as separate TOML files:

| Content | Path |
|---------|------|
| Custom themes | `~/.config/krypton/themes/*.toml` |
| Custom sound packs | `~/.config/krypton/sounds/*.toml` |

## Reference

```toml
# ~/.config/krypton/krypton.toml

# NOTE: The Tauri native shell is always fullscreen, borderless, and transparent.
# The workspace IS the full screen. There is no [window] section for the app itself.
# Individual terminal windows are positioned by workspace layouts below.

[shell]
program = "/bin/zsh"
args = ["--login"]

[font]
family = "Mononoki Nerd Font Mono"
# Or an array for fallback fonts (e.g. for Thai / CJK glyphs):
# family = ["Mononoki Nerd Font Mono", "Noto Sans Thai Looped"]
size = 14.0
line_height = 1.2
ligatures = true

[terminal]
scrollback_lines = 10000
cursor_style = "block"       # block | underline | bar
cursor_blink = true

[theme]
name = "krypton-dark"        # built-in or custom theme name
# Custom themes: place .toml files in ~/.config/krypton/themes/
# e.g., ~/.config/krypton/themes/my-custom.toml -> name = "my-custom"
# See docs/10-theme-specification.md for the full theme file format.

# Inline overrides (applied on top of the named theme):
[theme.colors]
foreground = "#c0c5ce"
background = "#1b2b34"
cursor = "#c0c5ce"
selection = "#4f5b66"
black = "#1b2b34"
red = "#ec5f67"
green = "#99c794"
yellow = "#fac863"
blue = "#6699cc"
magenta = "#c594c5"
cyan = "#5fb3b3"
white = "#c0c5ce"
bright_black = "#65737e"
bright_red = "#ec5f67"
bright_green = "#99c794"
bright_yellow = "#fac863"
bright_blue = "#6699cc"
bright_magenta = "#c594c5"
bright_cyan = "#5fb3b3"
bright_white = "#ffffff"

# --- Keybindings ---
# Every action in Krypton has a keybinding. All are configurable.

[keybindings]

# Leader key — enters compositor mode
leader = "Ctrl+Space"

# Command palette
command_palette = "CmdOrCtrl+Shift+P"

# Global (work in any mode)
workspace_1 = "CmdOrCtrl+1"
workspace_2 = "CmdOrCtrl+2"
workspace_3 = "CmdOrCtrl+3"
workspace_next = "CmdOrCtrl+]"
workspace_prev = "CmdOrCtrl+["

# Tab management
new_tab = "CmdOrCtrl+T"
close_tab = "CmdOrCtrl+W"
next_tab = "CmdOrCtrl+Shift+]"
prev_tab = "CmdOrCtrl+Shift+["
tab_1 = "CmdOrCtrl+Alt+1"
tab_2 = "CmdOrCtrl+Alt+2"
tab_3 = "CmdOrCtrl+Alt+3"
move_tab_to_window = "Leader T"    # then window index

# Window management (via leader key sequences)
new_window = "Leader N"
close_window = "Leader X"
maximize_window = "Leader F"
resize_mode = "Leader R"           # enter resize mode
move_mode = "Leader M"             # enter move mode
swap_window = "Leader S"           # then target window index
reset_layout = "Leader ="

# Window focus navigation
focus_left = "Leader H"
focus_down = "Leader J"
focus_up = "Leader K"
focus_right = "Leader L"
focus_next = "Leader N"
focus_prev = "Leader P"
focus_window_1 = "Leader 1"
focus_window_2 = "Leader 2"
focus_window_3 = "Leader 3"

# Pane splits
split_horizontal = "CmdOrCtrl+Shift+H"
split_vertical = "CmdOrCtrl+Shift+V"

# Clipboard
copy = "CmdOrCtrl+C"
paste = "CmdOrCtrl+V"

# Quick Terminal
quick_terminal = "Cmd+I"

# Scrollback
scroll_page_up = "Ctrl+Shift+U"
scroll_page_down = "Ctrl+Shift+D"

# Search
search = "CmdOrCtrl+F"
search_next = "CmdOrCtrl+G"
search_prev = "CmdOrCtrl+Shift+G"

# Resize mode keys (active only in resize mode)
[keybindings.resize_mode]
grow_right = "Right"
shrink_left = "Left"
grow_down = "Down"
shrink_up = "Up"
step_large = "Shift+Arrow"        # larger step
confirm = "Enter"
cancel = "Escape"

# Move mode keys (active only in move mode)
[keybindings.move_mode]
move_right = "Right"
move_left = "Left"
move_down = "Down"
move_up = "Up"
step_large = "Shift+Arrow"
confirm = "Enter"
cancel = "Escape"

# --- Sound Effects ---
# Procedural sound effects synthesized via Web Audio API.
# All sounds use additive + subtractive functional synthesis (no audio files).

[sound]
enabled = true                 # master toggle for all sound effects
volume = 0.5                   # master volume (0.0 to 1.0)
pack = "krypton-cyber"         # sound pack name: "krypton-cyber", "ghost-signal",
                               # "chill-city-fm", "orbit-deck", "mach-line",
                               # "deep-glyph", or custom
keyboard_type = "cherry-mx-brown"  # keypress sound: "cherry-mx-blue", "cherry-mx-red",
                                   # "cherry-mx-brown", "topre", "buckling-spring",
                                   # "membrane", "none" (disable keypress sounds)
keyboard_volume = 1.0          # volume multiplier for keypress sounds (0.0 to 1.0)
# Custom sound packs: place .toml files in ~/.config/krypton/sounds/

# Per-event overrides: set to false to disable, or a float (0.0-1.0) for volume
[sound.events]
# window.create = true          # use default volume
# window.close = true
# window.focus = 0.3            # quieter focus click
# mode.enter = true
# mode.exit = true
# quick_terminal.show = true
# quick_terminal.hide = true
# startup = true
# terminal.bell = true
# resize.step = 0.15            # very quiet for repeated steps
# command_palette.open = true
# command_palette.execute = true
# keypress = true               # toggle/adjust keypress sounds separately

# --- Shader Effects ---
# Post-processing visual effects applied to terminal panes via CSS/SVG filters.

[shader]
enabled = false              # Master toggle
preset = "none"              # Default preset: none, crt, hologram, glitch, bloom, matrix
intensity = 0.5              # Effect strength 0.0–1.0
animate = true               # Enable time-based animation (scanline sweep, flicker, etc.)
fps_cap = 30                 # Max animation FPS (CSS-driven, this is advisory)

# --- Visual ---
# Visual effects for the terminal content area.

[visual]
perspective_depth = 800        # 3D perspective depth in pixels. Higher = subtler.
                               # 0 = disabled (flat rendering). Default: 800
                               # Recommended range: 400–1200
perspective_tilt_x = 2.0       # X-axis tilt in degrees (top/bottom lean).
                               # 0 = no tilt. Default: 2.0
                               # Recommended range: 1–6. Negative reverses direction.
perspective_tilt_y = 0.0       # Y-axis tilt in degrees (left/right lean).
                               # 0 = no tilt. Default: 0.0
                               # Recommended range: 1–6. Negative reverses direction.
opacity = 0.5                  # Window backdrop opacity (0.0 = fully transparent,
                               # 1.0 = fully opaque). Controls the alpha channel of
                               # terminal window backgrounds. Default: 0.5
glow_intensity = 0.8           # Top-line glow brightness boost (0.0 = off, 3.0 = max).
                               # Controls the brightness of the glow overlay on the
                               # first few terminal rows. Default: 0.8

# --- Claude Code Hooks ---
# HTTP server for receiving Claude Code hook events (toast notifications, status).

[hooks]
enabled = true                 # Enable the hook HTTP server
port = 0                       # Port to listen on (0 = auto-assign)
show_toasts = true             # Show toast notifications for hook events

# --- SSH Session Multiplexing ---
# Clone SSH sessions into new tabs/windows via ControlMaster multiplexing.
# Krypton detects active SSH connections and manages control sockets automatically.

[ssh]
enabled = true                                          # Master toggle
control_persist = 600                                   # Seconds to keep master alive after last session
clone_target = "tab"                                    # Default target: "tab" or "window"

# --- AI Agent ---
# Model presets for the embedded AI coding agent.
# Define multiple presets and switch between them by changing `active`.

[agent]
active = "zai"                          # which model preset to use

[[agent.models]]
name = "zai"
provider = "zai"
model = "glm-4.7"
base_url = "https://api.z.ai/api/coding/paas/v4"
api_key_env = "ZAI_API_KEY"             # env var for API key (empty = no key)
context_window = 128000
max_tokens = 8192

# Example: Ollama local model
# [[agent.models]]
# name = "ollama-gemma4"
# provider = "ollama"
# model = "gemma4:latest"
# base_url = "http://localhost:11434/v1"
# api_key_env = ""
# context_window = 128000
# max_tokens = 8192

# Example: OpenAI
# [[agent.models]]
# name = "openai-gpt4o"
# provider = "openai"
# model = "gpt-4o"
# base_url = "https://api.openai.com/v1"
# api_key_env = "OPENAI_API_KEY"
# context_window = 128000
# max_tokens = 16384

# --- ACP Harness ---
# Multi-lane ACP orchestration view opened with Leader Y.

[acp_harness]
idle_flash_sound = true        # play soft cue when a busy lane becomes idle with a draft
memory_footer = true           # append MEMORY footer for automatic shared-memory extraction

# --- Context Extensions ---
# Built-in extensions that activate when specific processes are detected
# running in terminal panes. Currently includes: Java Resource Monitor.

[extensions]
enabled = true                 # Master toggle for all context extensions
poll_interval_ms = 500         # How often to poll foreground process (milliseconds)

# --- Quick Terminal ---
# A persistent overlay terminal toggled via Cmd+I, centered on screen.

[quick_terminal]
width_ratio = 0.6              # fraction of screen width (default: 60%)
height_ratio = 0.5             # fraction of screen height (default: 50%)
animation = "slide"            # entrance/exit animation: "slide", "fade", "none"
shell = ""                     # shell override (empty = use default [shell] config)
cwd = ""                       # working directory override (empty = $HOME)

# --- Workspaces ---
# Each workspace is a virtual desktop containing arranged terminal windows.

[workspaces]
startup = "coding"           # workspace to activate on launch
gap = 8                      # pixel gap between tiled windows
padding = 8                  # inner margin of the workspace
resize_step = 20             # pixels per arrow key press in resize mode
move_step = 20               # pixels per arrow key press in move mode
resize_step_large = 100      # pixels per Shift+Arrow in resize mode
move_step_large = 100        # pixels per Shift+Arrow in move mode

# Built-in presets (single, 2-column, 3-column, 2x2-grid, main+sidebar,
# main+bottom) are always available. User definitions below can override them.

[[workspaces.layouts]]
name = "coding"
grid = { cols = 3, rows = 1 }

  [[workspaces.layouts.windows]]
  label = "editor"
  col = 0
  row = 0
  col_span = 2
  row_span = 1
  shell = "/bin/zsh"
  cwd = "~/projects"

  [[workspaces.layouts.windows]]
  label = "terminal"
  col = 2
  row = 0
  col_span = 1
  row_span = 1

[[workspaces.layouts]]
name = "monitoring"
grid = { cols = 2, rows = 2 }

  [[workspaces.layouts.windows]]
  label = "logs"
  col = 0
  row = 0
  col_span = 1
  row_span = 1
  shell = "/bin/zsh"
  args = ["-c", "tail -f /var/log/system.log"]

  [[workspaces.layouts.windows]]
  label = "htop"
  col = 1
  row = 0
  col_span = 1
  row_span = 1
  shell = "/usr/bin/htop"

  [[workspaces.layouts.windows]]
  label = "network"
  col = 0
  row = 1
  col_span = 2
  row_span = 1

# Absolute positioning override example
[[workspaces.layouts]]
name = "custom-fixed"

  [[workspaces.layouts.windows]]
  label = "main"
  x = 100
  y = 100
  width = 1200
  height = 800

  [[workspaces.layouts.windows]]
  label = "side"
  x = 1320
  y = 100
  width = 500
  height = 800
```

## Section Reference

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[shell]` | `program` | string | System default | Shell binary path |
| `[shell]` | `args` | string[] | `[]` | Arguments passed to shell |
| `[font]` | `family` | string \| string[] | `"Mononoki Nerd Font Mono"` | Font family name, or an array of names for fallback (first match per glyph) |
| `[font]` | `size` | float | `14.0` | Font size in points |
| `[font]` | `line_height` | float | `1.2` | Line height multiplier |
| `[font]` | `ligatures` | bool | `true` | Enable font ligatures |
| `[terminal]` | `scrollback_lines` | int | `10000` | Scrollback buffer size |
| `[terminal]` | `cursor_style` | string | `"block"` | `block`, `underline`, or `bar` |
| `[terminal]` | `cursor_blink` | bool | `true` | Enable cursor blinking |
| `[theme]` | `name` | string | `"krypton-dark"` | Built-in or custom theme name (see [Theme Specification](./10-theme-specification.md)) |
| `[theme.colors]` | *(various)* | string | — | Hex color overrides (applied on top of named theme) |
| `[keybindings]` | `leader` | string | `"Ctrl+Space"` | Leader key to enter compositor mode |
| `[keybindings]` | `command_palette` | string | `"CmdOrCtrl+Shift+P"` | Open command palette |
| `[keybindings]` | `quick_terminal` | string | `"Cmd+I"` | Toggle Quick Terminal overlay |
| `[keybindings]` | `scroll_page_up` | string | `"Ctrl+Shift+U"` | Scroll terminal buffer up one page |
| `[keybindings]` | `scroll_page_down` | string | `"Ctrl+Shift+D"` | Scroll terminal buffer down one page |
| `[keybindings]` | *(various)* | string | — | See full keybinding reference in TOML example above |
| `[keybindings.resize_mode]` | *(various)* | string | — | Keys active in resize mode |
| `[keybindings.move_mode]` | *(various)* | string | — | Keys active in move mode |

### Agent Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[agent]` | `active` | string | `"zai"` | Name of the active model preset |
| `[[agent.models]]` | `name` | string | *required* | Unique preset name (e.g. `"zai"`, `"ollama-gemma4"`) |
| `[[agent.models]]` | `provider` | string | — | Provider: `"zai"`, `"ollama"`, `"openai"`, `"anthropic"`, etc. |
| `[[agent.models]]` | `model` | string | — | Model identifier (e.g. `"glm-4.7"`, `"gemma4:latest"`, `"gpt-4o"`) |
| `[[agent.models]]` | `base_url` | string | — | API endpoint URL |
| `[[agent.models]]` | `api_key_env` | string | — | Environment variable name for API key. Empty string = no key needed (local models) |
| `[[agent.models]]` | `context_window` | int | `128000` | Model's context window in tokens |
| `[[agent.models]]` | `max_tokens` | int | `8192` | Maximum output tokens per response |

To switch models, change `active` to the name of another preset. Changes take effect on next agent session (reset the agent or open a new agent window).

### ACP Agent Backends

ACP agent backends are built into Krypton rather than configured in `krypton.toml`. The built-in backend IDs are `claude`, `gemini`, `codex`, `opencode`, `pi-acp`, `droid`, `cursor`, `junie`, `omp`, `grok`, and `copilot`.

| Backend | Command |
|---------|---------|
| Claude | `npx -y @agentclientprotocol/claude-agent-acp` |
| Gemini | `gemini --experimental-acp` |
| Codex | `codex-acp` |
| OpenCode | `opencode acp` |
| Pi | `pi-acp` |
| Droid | `droid exec --output-format acp` |
| Cursor | `cursor-agent acp` |
| Junie | `junie --acp true` |
| OMP | `omp acp` |
| Grok | `grok agent stdio` |
| Copilot | `copilot --acp --stdio` |

Krypton resolves these commands through `PATH`; macOS GUI launches use a cached login-shell `PATH`. Authentication is the user's responsibility outside Krypton (`claude /login`, `gemini auth login`, Codex login/adapter setup, `pi /login` or provider env vars, Factory `FACTORY_API_KEY` env var or `droid` device-code flow, `cursor-agent login` or `CURSOR_API_KEY`, `junie` first-run for JetBrains Account or `JUNIE_API_KEY` / `--auth <token>` / BYOK provider keys, `omp` first-run/auth-broker or provider keys, `grok` first-run browser login or `XAI_API_KEY`, `copilot` `/login` device flow or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`).

**Pi lane prerequisites.** The Pi-1 lane uses the third-party [`pi-acp`](https://github.com/svkozak/pi-acp) adapter to drive the [`pi`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) coding agent. Install both globally:

```sh
npm install -g @mariozechner/pi-coding-agent
npm install -g pi-acp
```

Configure the model provider via either an API-key env var (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) exported before launching Krypton, or run `pi /login` once outside Krypton for OAuth subscriptions (Claude Pro/Max, ChatGPT Plus, Copilot). The harness does not provide a TTY for pi's interactive OAuth flow, so OAuth must be initiated outside Krypton.

Optional pi settings in `~/.pi/agent/settings.json`:

- `"quietStartup": true` — suppress pi-acp's startup banner in the lane transcript.
- Set env `PI_OFFLINE=1` to disable pi's update checks and install telemetry.

**Pi-1 caveats.** Unlike regular lanes such as Codex, Claude, Gemini, OpenCode, Droid, and Cursor, Pi-1 deliberately:

- Skips the project `.mcp.json` bridge — pi has no MCP host by design.
- Skips the per-lane `krypton-harness-memory` server — same reason. Memory drawer entries from Pi-1 are not produced.
- Bypasses the permission rail — pi runs `bash`, `edit`, `write` immediately. The lane chip shows `⚠ unsandboxed` to make the safety delta visible. Run inside a sandboxed cwd or container if working with untrusted prompts.

Pi auto-loads `AGENTS.md` and `CLAUDE.md` walking up from `cwd`, so project context is shared with the other lanes for free.

**Droid lane prerequisites.** The Droid-1 lane uses Factory's official [`droid`](https://docs.factory.ai/cli/getting-started/overview) CLI in native ACP mode (`droid exec --output-format acp`) — no third-party adapter is required. Install Factory's CLI per their docs, then either:

- Export `FACTORY_API_KEY=fk-...` in your login shell (Krypton's full login-env injection forwards it to the lane subprocess), **or**
- Run `droid` once outside Krypton to complete the device-code OAuth flow. Krypton does not provide a TTY for the device-code prompt.

Optional: pin a model for the Droid lane via `acp_harness.lane_models.droid.active` (passed to `droid` as `-m <id>` at spawn). Default model is `claude-opus-4-7`.

Unlike Pi-1, Droid-1 is a **regular lane**: the `.mcp.json` bridge applies, the per-lane `krypton-harness-memory` server is wired in, and the permission rail engages on tool calls beyond Droid's current autonomy level. No `⚠ unsandboxed` chip.

**Cursor lane prerequisites.** The Cursor lane uses Cursor Agent's native ACP mode (`cursor-agent acp`). Install Cursor Agent per Cursor's CLI docs, then run `cursor-agent login` outside Krypton or export `CURSOR_API_KEY` in the login shell before launching Krypton. Krypton does not provide a TTY for first-run installer/auth prompts, so startup failures include Cursor-specific login, Keychain, and install hints instead of opening an interactive wizard.

**MCP delivery (Cursor-specific).** `cursor-agent` **ignores MCP servers passed via ACP `session/new`** — both stdio and http — even though it advertises `mcpCapabilities`. It honored them on `2026.05.20` but regressed upstream (verified broken on `2026.05.27`/`2026.05.28`; tracked as [Zed #50924](https://github.com/zed-industries/zed/issues/50924) and Cursor forum reports). `--approve-mcps` has no effect in ACP mode either. So Krypton does **not** inject via `session/new` for Cursor. Instead, on Cursor lane spawn it writes the per-lane `krypton-harness-memory` server into `<projectDir>/.cursor/mcp.json` (merging, preserving the user's own entries) and pre-approves it with `cursor-agent mcp enable krypton-harness-memory` — cursor's only working ACP-mode path (an unapproved native server stays "needs approval" and never connects). The entry is removed from `.cursor/mcp.json` when the lane closes. When upstream `session/new` injection returns, this workaround can be dropped. Until Cursor ACP write-permission behavior is manually verified, the lane chip shows `⚠ permissions unverified`. If the project also defines `.cursor/mcp.json` entries of its own, avoid the reserved name `krypton-harness-memory`.

> Limitation: the project `.mcp.json` bridge servers are **not** mirrored into `.cursor/mcp.json` for Cursor in this revision — only the harness memory server (peer/memory tools). Multiple concurrent Cursor lanes share one `<projectDir>/.cursor/mcp.json`; each lane rewrites it with its own per-lane URL just before spawn, so already-running lanes keep their loaded server.

Optional: `acp_harness.lane_models.cursor.active` is accepted for the lane model chip, but Krypton does not pass it to Cursor at spawn until `cursor-agent acp --model <id>` is verified for ACP sessions.

**Junie lane prerequisites.** The Junie lane uses JetBrains Junie CLI's native ACP mode (`junie --acp true`). Install Junie per JetBrains' docs:

```sh
curl -fsSL https://junie.jetbrains.com/install.sh | bash
```

Then authenticate using any of the three supported paths, outside Krypton:

- Run `junie` once in a terminal to complete the JetBrains Account browser login, **or**
- Export `JUNIE_API_KEY` in your login shell for JetBrains usage-based billing, **or**
- Configure BYOK by exporting a provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`) in your login shell — Krypton's full login-env injection forwards it to the lane subprocess. Junie's `-a`/`--auth <token>` headless-auth flag is also supported but not wired into Krypton; users who need it run it through their own automation.

Junie is a **regular lane**: the `.mcp.json` bridge applies, the per-lane `krypton-harness-memory` server is wired in, and no force/yolo/brave flags are passed. Until Junie ACP write-permission behavior is manually verified, the lane chip shows `⚠ permissions unverified`. Junie may also load MCP servers natively from `~/.junie/config.json` / `<project>/.junie/config.json` via `--mcp-default-locations`; projects that define both a `.junie/config.json` entry and a Krypton-bridged `.mcp.json` entry for the same server may see duplicates until this duplication risk is verified.

Optional: `acp_harness.lane_models.junie.active` is accepted for the lane model chip, but Krypton does not pass it to Junie at spawn or via `session/set_model` until either path is verified to take effect under `--acp true`.

**OMP lane prerequisites.** The OMP lane uses Oh My Pi's native ACP mode (`omp acp`). Install OMP per the upstream README:

```sh
curl -fsSL https://omp.sh/install | sh
```

Then authenticate outside Krypton by running `omp` once for first-run/auth-broker setup, or export a provider key such as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the login shell before launching Krypton. Krypton does not provide a TTY for interactive OAuth or auth-broker setup. Startup failures include OMP-specific install, old-CLI-without-ACP, auth, API-key, and empty-stderr hints.

OMP is a regular permission-gated lane, but it native-loads project root `.mcp.json` in ACP mode. To avoid duplicate MCP server registration, Krypton skips only the project `.mcp.json` bridge for OMP while still injecting the per-lane `krypton-harness-memory` MCP server through `session/new.mcpServers`.

Optional: `acp_harness.lane_models.omp.active` is accepted for the lane model chip, but Krypton does not pass it to OMP at spawn or via `session/set_model` until either path is verified to take effect under `omp acp`.

**Grok lane prerequisites.** The Grok lane uses xAI Grok Build's native ACP mode (`grok agent stdio`). Install the CLI (macOS/Linux):

```sh
curl -fsSL https://x.ai/cli/install.sh | bash
```

Then authenticate outside Krypton by running `grok` once for the first-run browser login, or export `XAI_API_KEY` in the login shell before launching Krypton. Krypton does not provide a TTY for the browser-OAuth flow. Startup failures include Grok-specific install, old-CLI-without-ACP, auth, API-key, and empty-stderr hints.

Grok is a regular permission-gated lane: the project `.mcp.json` bridge (spec 83) and the per-lane `krypton-harness-memory` MCP server both apply, capability-gated by what Grok advertises at `initialize`. Optional `acp_harness.lane_models.grok.active` drives the lane model chip and is applied via the generic `session/set_model` path if Grok advertises model state at `session/new`; no CLI `-m` flag is passed at spawn in v1.

**Copilot lane prerequisites.** The Copilot lane uses GitHub Copilot CLI's native ACP server (`copilot --acp --stdio`, public preview). Install the CLI (Node.js 22+):

```sh
npm install -g @github/copilot
```

Then authenticate outside Krypton by running `copilot` and the `/login` device flow once, or export a fine-grained PAT with the **Copilot Requests** permission as `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` (in that precedence) in the login shell before launching Krypton. Krypton does not provide a TTY for the `/login` device flow. Startup failures include Copilot-specific install, old-CLI-without-ACP, auth, token, and empty-stderr hints.

Copilot is a regular permission-gated lane: the project `.mcp.json` bridge (spec 83) and the per-lane `krypton-harness-memory` MCP server both apply, capability-gated by what Copilot advertises at `initialize` (verified against Copilot CLI 1.0.60: `mcpCapabilities {http, sse}`, `promptCapabilities.image`). Optional `acp_harness.lane_models.copilot.active` drives the lane model chip; Copilot's ACP server documents no model-selection flag, so the value is applied only via the generic `session/set_model` path if Copilot advertises model state at `session/new` (it did not at `initialize` in 1.0.60), otherwise the chip is display-only and Copilot runs its default.

See `docs/69-acp-agent-support.md` for the original ACP design, `docs/84-acp-pi-lane.md` for Pi-1, `docs/86-acp-droid-lane.md` for Droid-1, `docs/113-acp-cursor-lane.md` for Cursor, `docs/119-acp-junie-lane.md` for Junie, `docs/122-acp-omp-lane.md` for OMP, `docs/135-acp-grok-lane.md` for Grok, and `docs/150-acp-copilot-lane.md` for Copilot.

### ACP Harness Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[acp_harness]` | `idle_flash_sound` | bool | `true` | Reserved for the soft cue when an active lane returns idle while its draft is non-empty |
| `[acp_harness]` | `memory_footer` | bool | `true` | Append the MEMORY footer to each harness prompt so agents can publish short shared-memory bullets |
| `[acp_harness.lane_models.<backend>]` | `active` | string | `""` | Model id/alias applied to the lane (CLI flag at spawn, or `session/set_model`/`set_config_option` after `session/new`). Empty = use the adapter default |
| `[acp_harness.lane_models.<backend>]` | `models` | array | `[]` | Informational allow-list (not enforced). The in-harness picker (spec 127) sources its options from the agent-advertised `availableModels`, not this array |

The ACP Harness backend picker is code-defined in v1: installed built-in backends are listed, and the harness starts with no lanes until the user spawns one via `Cmd+P → +`. Shared memory is tab-local and is dropped when the harness tab closes. See `docs/72-acp-harness-view.md`.

**Lane model selection.** `<backend>` keys match the ACP backend ids: `gemini`, `opencode`, `droid`, `cursor`, `claude`, `codex`, `pi-acp`, `junie`, `omp`, `grok`, and `copilot`. Krypton applies `active` only for backends that support model selection in v1:

- **Gemini** — passes `--model <active>` as a CLI flag at spawn. Changing the model requires respawning the lane.
- **OpenCode** — sends `session/set_config_option {model}` (with `session/set_model` fallback) right after `session/new`. If `active` is empty, Krypton falls back to the historical default `zai-coding-plan/glm-5.1`.
- **Droid** — passes `-m <active>` to `droid exec` at spawn. Default if unset is Factory's `claude-opus-4-7`. Changing the model requires respawning the lane.
- **Claude** (and any ACP-native backend that advertises model state) — applied via `session/set_model {sessionId, modelId}` right *after* `session/new`, for adapters whose `session/new` response carries a valid `models` object (an `availableModels` array or a `currentModelId` string). `active` is sent **verbatim**, so aliases like `opus`/`sonnet`/`haiku` resolve adapter-side. A failure (unknown id, timeout, adapter doesn't implement the method) is **non-fatal**: the lane keeps running on the agent default and the model chip turns amber with a tooltip. The set of available models is the *agent's* (advertised in `session/new`) — you don't maintain a catalog; the optional `models` array only curates/orders a future picker.
- **Cursor / Codex / Pi / Junie / OMP / Grok / Copilot** — `active` is accepted in the schema but no CLI flag is passed at spawn (those adapters do not pass model via a spawn flag in v1). The value still drives the lane model chip if present, and each auto-enables the generic `session/set_model` path with no further code if/when its adapter advertises model state at `session/new`. (Grok's `-m` spawn flag under `agent stdio` is unverified and deferred — see `docs/135-acp-grok-lane.md`. Copilot's ACP server documents no model flag and advertised no model state at `initialize` in CLI 1.0.60 — see `docs/150-acp-copilot-lane.md`.)

**Respawn-to-apply.** `active` is snapshotted into the lane at spawn. Editing `krypton.toml` updates the stored config and the chip inference, but does **not** re-apply to a live lane — the agent model changes only on the next spawn / `#new` / `#new!` / lane restart. Resumed and loaded sessions keep whatever model they were saved with and are not forced to the current config.

**In-harness model picker (spec 127).** Press the harness leader key then `,` (`⌘P` then `,`) to open a keyboard-driven model picker for the focused lane (`j`/`k` move, `↵` switch, `esc` cancel). It lists the models the agent advertised in `session/new` (so you can't pick an unsupported id) and switches the **live** lane via `session/set_model`. The picker is **session-scoped**: it does **not** rewrite `krypton.toml`, so `active` still governs the spawn default and the picker choice resets on respawn. The picker is disabled for lanes whose backend advertises no model state (the chip explains why). A switch that the agent rejects reverts the chip; a timeout keeps the choice but flags it unconfirmed (the agent may still apply it). When the new model doesn't support the lane's current mode, the adapter clamps it (e.g. `auto` → `default` on Haiku) and the lane notes the downgrade in its transcript.

Example:

```toml
[acp_harness.lane_models.gemini]
active = "gemini-2.5-pro"
models = ["gemini-2.5-pro", "gemini-2.5-flash"]

[acp_harness.lane_models.opencode]
active = "anthropic/claude-sonnet-4-5"
models = ["zai-coding-plan/glm-5.1", "anthropic/claude-sonnet-4-5", "openai/gpt-5"]
```

### ACP Harness Directives (`acp-harness.toml`)

Reusable, backend/task-scoped **directives** (system-style prompt blocks) live in a separate Krypton-owned file, **not** in `krypton.toml`:

| File | `~/.config/krypton/acp-harness.toml` |
|------|--------------------------------------|

Unlike `krypton.toml` (hand-edited, never written by Krypton), `acp-harness.toml` is Krypton-managed: it is **created empty on first harness open** and rewritten atomically when an agent mutates a directive (and you approve). Edits made by hand are picked up the next time the harness loads it; there is no live hot-reload in v1. See `docs/124-acp-harness-directive-management.md`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `version` | int | `1` | Schema version for future migrations |
| `[[directives]]` | array | `[]` | Reusable Harness directives |
| `[[directives]].id` | string | — | Required, unique, lowercase kebab-case (`[a-z0-9][a-z0-9-]*`) |
| `[[directives]].title` | string | `""` | Display title in the picker |
| `[[directives]].icon` | string | `""` | 1–2 char glyph; falls back to a deterministic glyph from task/backend when empty |
| `[[directives]].description` | string | `""` | One-line description shown in the picker |
| `[[directives]].backend` | string | `""` | Target backend id (empty = all backends) |
| `[[directives]].task` | string | `""` | Free-form task key (`implementation`/`review`/`research`/…), kebab-case |
| `[[directives]].system_prompt` | string | `""` | Reusable system-style prompt block (16 KiB cap) |
| `[[directives]].enabled` | bool | `true` | Disabled directives show in the picker but cannot be assigned |
| `[[directives]].triage_equipped` | bool | `false` | Legacy spec-129 metadata. Since spec 130, `attention_flag` / `attention_resolve` are default-on for every lane that receives the `krypton-harness-memory` MCP server, so this field no longer controls tool visibility or assignment approval. Krypton still accepts and displays it as a legacy directive badge for compatibility. See `docs/130-default-attention-triage.md`. |

A directive's `system_prompt` is injected into the same leading context packet as the lane-context stub, after it and before the user's prompt. Assign a directive to the focused lane with `Cmd+P → .` (the directive picker) or by clicking the composer `directive …` chip. Agents can also list/preview/create/update/delete/assign directives through the harness MCP tools (`directive_list`, `directive_preview`, `directive_remove`, `directive_apply`); persistent changes and cross-lane assignment require your approval in the lane transcript.

Example:

```toml
version = 1

[[directives]]
id = "codex-implementation"
title = "Codex Implementation"
icon = "⌘"
description = "Scoped code changes and narrow verification."
backend = "codex"
task = "implementation"
enabled = true
system_prompt = """
You are the implementation lane. Make scoped edits, follow existing patterns, and run the narrowest useful checks before reporting changed files.
"""

[[directives]]
id = "claude-review"
title = "Claude Review"
icon = "◇"
description = "Read-only review for regressions and missing tests."
backend = "claude"
task = "review"
enabled = true
system_prompt = """
You are the review lane. Do not edit files. Prioritize bugs, regressions, risky assumptions, and missing tests.
"""
```

### ACP Harness Attention Triage (spec 128)

Attention triage is **default-on** for lanes that receive the `krypton-harness-memory` MCP server. There is no `krypton.toml` switch and no required directive grant: `tools/list` advertises `attention_flag` / `attention_resolve` by default, while payload validation and the review queue remain the safety surface. The old `Cmd+P → '` manual equip action has been removed from the active UI. Summon the judgement queue with `Cmd+P → ;`. Existing `triage_equipped` directive fields are preserved only as legacy metadata/badges. See `docs/128-attention-triage.md` and `docs/130-default-attention-triage.md`.

### Hooks Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[hooks]` | `enabled` | bool | `true` | Master toggle — enables/disables the Claude Code hook HTTP server |
| `[hooks]` | `port` | int | `0` | Port to listen on. 0 = OS auto-assigns an available port |
| `[hooks]` | `show_toasts` | bool | `true` | Show toast notifications for hook events. Toggleable at runtime via command palette |

### Hints Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[hints]` | `alphabet` | string | `"asdfghjklqweruiop"` | Characters used for hint label generation (should be easy to type) |
| `[[hints.rules]]` | `name` | string | — | Unique identifier for the rule |
| `[[hints.rules]]` | `regex` | string | — | Regular expression pattern to match in terminal content |
| `[[hints.rules]]` | `action` | string | `"Copy"` | Action on selection: `"Copy"`, `"Open"`, or `"Paste"`; the built-in `filepath` rule opens Helix in a new tab instead of copying |
| `[[hints.rules]]` | `enabled` | bool | `true` | Whether this rule is active |

Built-in rules (active by default): `url` (Open), `filepath` (open in Helix tab), `email` (Copy).

### Sound Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[sound]` | `enabled` | bool | `true` | Master toggle — enables/disables all sound effects |
| `[sound]` | `volume` | float | `0.5` | Master volume (0.0 = silent, 1.0 = full) |
| `[sound]` | `pack` | string | `"krypton-cyber"` | Sound pack name. Built-in options: `"krypton-cyber"` (patch-based synthesis), `"ghost-signal"`, `"chill-city-fm"`, `"orbit-deck"`, `"mach-line"`, `"deep-glyph"` (ghost-signal function-based themes). Custom packs from `~/.config/krypton/sounds/` also supported. |
| `[sound]` | `keyboard_type` | string | `"cherry-mx-brown"` | Keyboard type for keypress sounds. Options: `"cherry-mx-blue"`, `"cherry-mx-red"`, `"cherry-mx-brown"`, `"topre"`, `"buckling-spring"`, `"membrane"`, `"none"`. **Ignored when a ghost-signal theme is active** (the theme provides its own typing sounds with per-key routing: Backspace, Enter, Space, and letters each use distinct sounds). |
| `[sound]` | `keyboard_volume` | float | `1.0` | Volume multiplier for keypress sounds (0.0 = silent, 1.0 = full). Multiplied with master volume. |
| `[sound.events]` | `<event_name>` | bool \| float | `true` | Per-event toggle or volume override. `false` disables, `true` uses master volume, float (0.0–1.0) sets individual volume. |

Valid event names: `window.create`, `window.close`, `window.focus`, `window.maximize`, `window.restore`, `mode.enter`, `mode.exit`, `quick_terminal.show`, `quick_terminal.hide`, `workspace.switch`, `command_palette.open`, `command_palette.close`, `command_palette.execute`, `layout.toggle`, `swap.complete`, `resize.step`, `move.step`, `terminal.bell`, `terminal.exit`, `startup`, `keypress`.

### Shader Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[shader]` | `enabled` | bool | `false` | Master toggle — enables/disables all shader effects |
| `[shader]` | `preset` | string | `"none"` | Default preset: `"none"`, `"crt"`, `"hologram"`, `"glitch"`, `"bloom"`, `"matrix"` |
| `[shader]` | `intensity` | float | `0.5` | Effect strength (0.0–1.0). Controls filter parameters, scanline opacity, displacement, etc. |
| `[shader]` | `animate` | bool | `true` | Enable time-based CSS animations (scanline sweep, flicker, bloom pulse) |
| `[shader]` | `fps_cap` | int | `30` | Advisory max FPS for animations (CSS-driven, browser-controlled) |

Shader presets can be cycled at runtime via `Leader g` (per-pane) or toggled globally via `Leader G` (Shift+g).

### Visual Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[visual]` | `perspective_depth` | int | `800` | 3D perspective depth in pixels. Higher = subtler effect. 0 = disabled. Recommended: 400–1200 |
| `[visual]` | `perspective_tilt` | float | `2.0` | Tilt angle in degrees for 3D layer separation. 0 = no tilt. Recommended: 1–6 |
| `[visual]` | `opacity` | float | `0.5` | Window backdrop opacity (0.0 = fully transparent, 1.0 = fully opaque). Overrides the theme's backdrop alpha. |
| `[visual]` | `glow_intensity` | float | `0.8` | Top-line glow brightness boost. 0.0 disables the glow, higher = stronger. Clamped to 0.0–3.0. |

### SSH Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[ssh]` | `enabled` | bool | `true` | Master toggle — enables/disables SSH session cloning feature |
| `[ssh]` | `control_persist` | int | `600` | Seconds to keep a ControlMaster connection alive after the last client disconnects |
| `[ssh]` | `clone_target` | string | `"tab"` | Default target for the clone action: `"tab"` (new tab in same window) or `"window"` (new window) |

### Extensions Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[extensions]` | `enabled` | bool | `true` | Master toggle — enables/disables all context-aware extensions |
| `[extensions]` | `poll_interval_ms` | int | `500` | How often the backend polls each PTY session's foreground process (milliseconds). Lower = more responsive, higher = less CPU. Recommended: 300–1000 |

Built-in extensions (system-level, not user-configurable): Java Resource Monitor (triggers on `java` process — shows JVM heap, GC stats, CPU%, RSS).

### Quick Terminal Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[quick_terminal]` | `width_ratio` | float | `0.6` | Width as fraction of screen (0.0–1.0) |
| `[quick_terminal]` | `height_ratio` | float | `0.5` | Height as fraction of screen (0.0–1.0) |
| `[quick_terminal]` | `animation` | string | `"slide"` | Entrance/exit animation: `slide`, `fade`, `none` |
| `[quick_terminal]` | `shell` | string | `""` | Shell override (empty = use default `[shell]` config) |
| `[quick_terminal]` | `cwd` | string | `""` | Working directory override (empty = `$HOME`) |

### Workspace Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[workspaces]` | `startup` | string | `"single"` | Workspace to activate on launch |
| `[workspaces]` | `default_layout` | string | `"focus"` | Default layout mode: `"grid"`, `"focus"`, or `"depth"` |
| `[workspaces]` | `gap` | int | `0` | Pixel gap between tiled windows |
| `[workspaces]` | `padding` | int | `0` | Inner margin of the workspace |
| `[workspaces]` | `resize_step` | int | `20` | Pixels per arrow key press in resize mode |
| `[workspaces]` | `move_step` | int | `20` | Pixels per arrow key press in move mode |
| `[workspaces]` | `resize_step_large` | int | `100` | Pixels per Shift+Arrow in resize mode |
| `[workspaces]` | `move_step_large` | int | `100` | Pixels per Shift+Arrow in move mode |
| `[[workspaces.layouts]]` | `name` | string | *required* | Unique workspace name |
| `[[workspaces.layouts]]` | `grid` | object | — | Grid definition `{ cols, rows }` (omit for absolute positioning) |
| `[[workspaces.layouts.windows]]` | `label` | string | — | Human-readable window label |
| `[[workspaces.layouts.windows]]` | `col` | int | — | Grid column (0-indexed) |
| `[[workspaces.layouts.windows]]` | `row` | int | — | Grid row (0-indexed) |
| `[[workspaces.layouts.windows]]` | `col_span` | int | `1` | Number of grid columns to span |
| `[[workspaces.layouts.windows]]` | `row_span` | int | `1` | Number of grid rows to span |
| `[[workspaces.layouts.windows]]` | `x` | int | — | Absolute X position in pixels (overrides grid) |
| `[[workspaces.layouts.windows]]` | `y` | int | — | Absolute Y position in pixels (overrides grid) |
| `[[workspaces.layouts.windows]]` | `width` | int | — | Absolute width in pixels (overrides grid) |
| `[[workspaces.layouts.windows]]` | `height` | int | — | Absolute height in pixels (overrides grid) |
| `[[workspaces.layouts.windows]]` | `shell` | string | Default shell | Shell binary for this window |
| `[[workspaces.layouts.windows]]` | `args` | string[] | `[]` | Shell arguments |
| `[[workspaces.layouts.windows]]` | `cwd` | string | `$HOME` | Working directory |

---

## Config Flush Defaults

> Status: Implemented — Date: 2026-03-22

When new configuration fields are added to the Rust `KryptonConfig` structs, existing users' `krypton.toml` files don't include those new keys. After loading and deserializing the config (which merges defaults for missing fields via `#[serde(default)]`), the fully-populated config is serialized back to disk. This "flushes" any new fields into the user's file with their default values.

### Flush Behavior

```rust
fn flush_config(path: &PathBuf, config: &KryptonConfig) {
    match toml::to_string_pretty(config) {
        Ok(toml_str) => {
            let content = format!(
                "# Krypton configuration\n\
                 # See docs/06-configuration.md for full reference\n\n\
                 {toml_str}"
            );
            if let Err(e) = fs::write(path, &content) {
                log::error!("Failed to flush config to {}: {e}", path.display());
            }
        }
        Err(e) => log::error!("Failed to serialize config for flush: {e}"),
    }
}
```

The flush runs on every startup and on every hot-reload, ensuring the file always reflects the complete schema. It compares serialized content against the existing file and only writes if they differ, preventing watcher re-trigger loops.

### Caveats

- **User comments stripped**: `toml::to_string_pretty` does not preserve comments. The config file header directs users to the docs for reference.
- **Parse error recovery**: When the file has syntax errors, flushing defaults overwrites the broken file — the user gets a working config instead of being stuck.
- **Read-only file**: The flush logs an error and continues. The app still works with the in-memory config.

## [hurl]

Configure the built-in Hurl client window.

```toml
[hurl]
# Absolute path to the `hurl` binary. Leave unset to auto-detect from PATH
# (falls back to a login shell lookup on macOS GUI launches).
binary_path = "/opt/homebrew/bin/hurl"
```

The Hurl client is opened via `Cmd+P` then `H`, or via the command palette ("Open Hurl Client"). It indexes every `.hurl` file under the focused terminal cwd (gitignore-aware) and runs the selected file with `--color --pretty --include`. See `docs/65-hurl-client-window.md` for the full keybinding reference.

## [pencil]

Configure the Pencil window — an in-app `.excalidraw` editor backed by `@excalidraw/excalidraw`.

```toml
[pencil]
# Directory scanned by the Pencil picker (`Leader e`). Tilde-expanded.
# If empty, the picker shows a notification; absolute paths can still be
# opened programmatically (and, in future, via quick-file-search routing).
dir = "~/Documents/excalidraw"
```

The picker recursively lists `*.excalidraw` files under `dir`, sorted by modification time (newest first), with a synthetic "+ New drawing" row at the top that prompts for a file name. Press `r` on an existing row to rename it without leaving the picker. When a Pencil view is focused, local leader `/` opens an existing drawing in the current Pencil tab and local leader `?` prompts for a new drawing in the current file's directory. Opening the same file twice through the global picker refocuses the existing tab. Saving is autosave-on-change (800 ms debounced) plus `Cmd+S` for an immediate flush — writes are atomic via `<path>.tmp` + rename. Theme follows Krypton's background luminance. See `docs/71-pencil-window.md` for the full design.
