# 7. Configuration File Format

Configuration is read from a TOML file at `~/.config/krypton/krypton.toml` on all platforms. Krypton never writes this file except to persist `[theme] name` (see [Load Behavior](#load-behavior)); every key is optional, and a missing file means built-in defaults.

Custom themes are stored as separate TOML files:

| Content | Path |
|---------|------|
| Custom themes | `~/.config/krypton/themes/*.toml` |

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
cursor_trail = true          # rainbow flame particles following mouse + text cursor

[theme]
name = "krypton-dark"        # built-in or custom theme name
# Built-ins: krypton-dark, krypton-light, legacy-radiance.
# krypton-light is slate ink on cool frost with an aluminium faceplate. A file of the
# same name in ~/.config/krypton/themes/ shadows the bundled copy.
# Custom themes: place .toml files in ~/.config/krypton/themes/
# e.g., ~/.config/krypton/themes/my-custom.toml -> name = "my-custom"
# Switching: command palette → "Color Theme: …". File edits apply on Reload Config or the next launch.
# See docs/0010-theme-specification.md for the full theme file format.
# Theme files may also carry a [tokens] table for per-component CSS custom
# properties — see "[tokens] (theme files)" at the end of this document.

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
# Keybindings are built in and NOT configurable: there is no [keybindings]
# section, and one in this file is ignored. The leader is Cmd+P; press it to
# open the which-key popup listing the compositor actions.
# Resize and move modes use the arrow keys (Shift+Arrow for the large step),
# Enter to confirm and Escape to cancel. Split resize (spec 296): Shift+H/L move
# the nearest vertical split divider left/right, Shift+K/J the nearest
# horizontal one up/down, by [workspaces] resize_step px; "=" resets the
# nearest split to 50/50.

# --- Sound Effects ---
# WAV packs bundled with the app, played by the Rust backend (rodio).

[sound]
enabled = true                 # master toggle for all sound effects
volume = 0.5                   # master volume (0.0 to 1.0)
pack = "deep-glyph"            # bundled packs: "deep-glyph", "mach-line", "holo-dash"
keyboard_type = "cherry-mx-brown"  # reserved: parsed, not applied (the pack supplies keypress sounds)
keyboard_volume = 1.0          # volume multiplier for keypress sounds (0.0 to 1.0)
# Custom sound packs are not supported: packs load only from the app bundle.

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
opacity = 0.5                  # Screen opacity (0.0 = fully transparent, 1.0 =
                               # fully opaque): the alpha of the terminal and
                               # Quick Terminal screens behind the faceplate.
                               # Plates (titlebar, tab bar, footers, panels,
                               # overlays) keep their own 0.9 / 0.94 alpha
                               # (spec 366). Diff View (dark scheme) lets this
                               # show through the code surface. A light-scheme
                               # theme raises it to at least 0.94: without blur a
                               # translucent light surface takes the wallpaper's
                               # hue (spec 321). Default: 0.5
glow_intensity = 0.8           # Top-line glow brightness boost (0.0 = off, 3.0 = max).
                               # Controls the brightness of the glow overlay on the
                               # first few terminal rows. Default: 0.8
window_border = true           # Show the window's 1px bezel edge and, when
                               # focused, its accent ring. false makes both
                               # transparent (geometry unchanged). Default: true
progress_gauge_working = true  # Show the centre progress ring while a program
                               # reports busy (OSC 9;4 state 3, label "working").
                               # false hides only that ring; percent, error and
                               # paused rings and the titlebar progress lamp still show
                               # (spec 364). Default: true
blur = 12                      # reserved: parsed, not applied

# --- Keyboard Overlay (spec 271) ---
# Read-only on-screen keyboard with wireframe "ghost hands", docked at the
# center-bottom of the workspace screen. It only observes keys; it never
# consumes them or writes to a terminal. Leader Shift+K toggles it at runtime.

[keyboard_overlay]
enabled = false                # Show at startup. The runtime toggle is not persisted.
layout = "auto"                # auto | us | de | th. auto shows QWERTY and switches
                               # to Kedmanee labels while you type Thai.
width_ratio = 0.36             # Keyboard width as a fraction of the workspace width
                               # (0.2–0.8). Height follows at 8.1/15.4 of it; the
                               # mouse pad adds ~40% width (capped at the workspace).
opacity = 0.7                  # Whole-overlay alpha (0.1–1.0)
mask_secure_input = true       # Hide keys while the focused terminal is at a
                               # password prompt (termios ECHO off + ICANON on).
                               # A remote sudo inside ssh/tmux is NOT detectable.
idle_ghost = false             # After 5 s idle the hands play demo phrases.
                               # Visual only (never typed); keeps a 60 fps loop.
mouse = true                   # Draw a mouse right of the keyboard. The right hand
                               # grips it while the pointer moves and lights its
                               # buttons on click. false = compact keyboard only.

# --- Loopback HTTP Server ---
# The single localhost server behind harness memory (the krypton-harness-memory
# MCP endpoint), every browser surface (#dashboard, #gallery, #docs, #journal,
# #reviews, #analyses, #commands, #tools), the hurl / termctrl / acp-wire
# viewers, artifact and doc feedback, and the Claude Code /hook endpoint.
# Turning it off turns all of that off — lanes then run with memory unavailable.
# Load-time only: restart Krypton after changing it.

[loopback_server]
enabled = true                 # Start the loopback HTTP server
port = 8765                    # Port to listen on (0 = auto-assign;
                               # a busy fixed port falls back to ephemeral)

# --- Claude Code Hooks ---
# Ingestion of Claude Code hook events on POST /hook, served by the loopback
# server above. This section does NOT control the server itself.

[hooks]
enabled = true                 # Accept hook events on /hook (hot-reloadable)

# --- Program-Status Fire (specs 0362, 0363, 0365) ---
# OSC 7501 states (spec 0284) that set a terminal window on fire: a WebGL2 fire
# along the bottom of its content, behind the text. Hot-reloadable. Empty = off.
# "tool_error" also burns an ACP Harness window after a lane's tool call fails,
# with the [fire.error] look, until you type in that lane (spec 0365).
# The look keys are optional multipliers (1 = built-in look) and CSS colours;
# a [fire.<state>] table overrides them for that state only, key by key.

[fire]
on = []                        # any of: "working", "blocked", "error", "done", "tool_error"
# height = 1.0                 # flame height, 0.25–3
# intensity = 1.0              # brightness, 0.1–2
# speed = 1.0                  # animation speed, 0.25–4
# low = "#8a1405"              # colours; unset → theme token krypton-fire-* → built-in
# mid = "#ff5a14"
# hot = "#ffc65a"

# [fire.blocked]               # e.g. a taller, faster, violet fire while blocked
# height = 1.4
# speed = 1.6
# mid = "#b04dff"

# --- ACP Harness Controller CLI ---
# Starts the authenticated local endpoint used by kryptonctl. Load-time only.

[acp_controller]
enabled = true
# Fixed loopback port for the control API so external clients (e.g. a browser
# extension) get a stable URL. Falls back to an OS-assigned port on conflict;
# 0 = always auto-assign. See docs/0175-harness-web-control-api.md.
port = 8766
# Exact browser origins allowed to call the control API directly (CORS).
# Empty = no CORS headers (proxy-only, the secure default): a web app must reach
# the API through its own server-side proxy so the bearer token never enters the
# browser. Never use "*". See docs/0175-harness-web-control-api.md.
cors_origins = []
# Write the Chrome Native Messaging host manifest on launch so the browser
# extension (docs/176) can fetch the control token with zero setup.
install_native_host = true
# Which browsers' NativeMessagingHosts dirs to target:
# chrome | chromium | edge | brave | opera | opera-gx  (Opera GX users: ["opera-gx"])
native_host_browsers = ["chrome"]

# --- Xenon resource server (spec 212) ---
# Where `#push` publishes harness-generated resources (reviews, analyses,
# artifacts, docs, attention flags, daily notes, recorded timeline events). Publishing is explicit
# except for the opt-in review and attention triggers documented below. The
# bearer token is NOT configured here: it lives in the operating-system
# credential vault, written by pasting it into Krypton once.

[xenon]
enabled = false
# Server root, e.g. "https://xenon.example.com". Empty = unconfigured.
base_url = ""
# Project slug override. Empty derives "<owner>.<repo>" from the git remote,
# falling back to a path-derived name. Must be a single path segment — the
# server addresses projects with one, so a "/" is replaced with "-".
project = ""
# Which kinds a bare `#push` covers. Empty = all of them.
# One of: review, analysis, artifact, doc, attention, daily, timeline, handoff.
#
# Listing "review" ALSO publishes a Review Board when it is first registered.
# Listing "attention" ALSO publishes a flag when a lane raises it, because the
# flag has no on-disk form. Listing "handoff" ALSO publishes a handoff each
# time a lane writes it (spec 293). Other kinds remain manual; later review
# edits and responses also require `#push review [<slug>]`.
# `#resume` reads handoffs back from Xenon whenever `enabled`; that pull needs
# a token with `resource:read` (no extra key).
auto_push = []
# Review threads (spec 270) add no TOML key. Only their Guide's Review Board
# bundle follows the opt-in review auto-push rule; the private diff snapshot,
# line comments, and verdict history remain local.
# How often the workspace footer's backend-link segment probes the server
# (spec 213). The segment is the only place that tells you whether the link is
# actually alive — `#xenon status` reports configuration, never connectivity.
# 0 disables the timer, leaving the segment to update on `⌘P X` and after a
# `#push`.
probe_interval_secs = 60

# --- LLM usage log (spec 214) ---
# One numeric row per completed prompt turn: tokens in/out, cached tokens,
# model, lane, backend, stop reason, and the cost the adapter reported (when it
# reports one). NO prompt or response text is ever recorded — that is what lets
# the rows stream to Xenon unattended.

[usage_log]
# Master switch for recording at all.
enabled = true
# Stream each turn to Xenon as it ends. Needs [xenon].enabled and a stored
# token; without either, rows still accumulate locally and upload once Xenon is
# configured. This is deliberately NOT an [xenon].auto_push kind: usage is not a
# resource, streaming IS the feature, and this is the opt-OUT (ADR-0019).
publish = true
# Local .krypton/usage/<date>.jsonl files older than this are deleted at
# startup. Rows already accepted by Xenon live on there. 0 disables pruning.
retain_days = 90

# --- Developer daily brief (specs 223, 225) ---
# One dated markdown file per day, WRITTEN BY A LANE from data already on disk:
# the usage log above, git, review bundles, artifacts, and the harness journal.
# The evidence is joined deterministically and handed to the lane as a prompt;
# what lands on disk is the brief, and it says so (`generated: lane-narration`).
# The section keeps the name `daily_note` so an existing config still loads.

[daily_note]
# Master switch for journal capture (attention, review, artifact, ticket,
# and your own `#daily note` lines). Off still lets a day be written from usage,
# git, reviews, and artifacts — it just has no prose timeline behind it.
enabled = true
# .krypton/journal/<date>.jsonl files older than this are deleted on the first
# capture of a run. 0 disables pruning. Written .md days are NEVER pruned —
# they are the record; the jsonl is only its input.
retain_days = 400
# Where written days go. Relative to the project root unless absolute, which is
# how a day lands straight in an Obsidian vault.
output_dir = ".krypton/journal"
# Absolute paths to other projects also covered by the day. Explicit rather than
# a machine-wide scan: a day should not depend on what else happens to be on
# disk.
extra_projects = []

# --- Commit explainers (specs 375, 376) ---
# The Commit Browser (Leader E) `e` queues a background job: its own ACP process
# explains one commit as a project-independent learning note, drafted in a
# scratch dir and copied to <dir>/<repo>-<sha7>.md by Krypton. The Harness
# command `#learn <sha>` does the same on a lane instead.

[knowledge]
# Where explainers go. Absolute or ~/ only (no project-relative path: the notes
# are personal and global). May point into an Obsidian vault.
dir = "~/.config/krypton/knowledge"
# Explainers are always written in Thai; technical terms, code and commands stay English.
# Background job only (#learn uses the lane's own backend).
backend = "codex"            # ACP backend id that runs each job
model = "gpt-6.1-sol[high]"  # "" = backend default
mode = "workspace-write"     # session mode forced on the job; "" = backend default
parallel = 2                 # jobs at once (1–4); the rest wait FIFO

# Timeline automatic recording is a per-project runtime setting, not TOML.
# Use #timeline auto [on|off]; see "Timeline Automatic Recording" below.
# Retired [typesafe] / [typesafe.timeline_topics] keys are ignored.

# Telegram Harness Controller is intentionally NOT configured here. Krypton's
# Settings view owns ~/.config/krypton/telegram.toml, while the Bot API token
# lives in the operating-system credential vault. See the section below.

# --- SSH Session Multiplexing ---
# Clone SSH sessions into new tabs/windows via ControlMaster multiplexing.
# Krypton detects active SSH connections and manages control sockets automatically.

[ssh]
enabled = true                                          # Master toggle
control_persist = 600                                   # Seconds to keep master alive after last session
clone_target = "tab"                                    # Default target: "tab" or "window"

# --- AI Agent ---
# Model presets for the embedded AI coding agent (Agent window, File Manager
# AI, Markdown AI). Inline AI (Cmd+K) does not use these; see [inline_ai].
# Define multiple presets and switch between them by changing `active`.

[agent]
active = "zai"                          # which model preset to use

[[agent.models]]
name = "zai"
provider = "zai"
model = "glm-5.1"
base_url = "https://api.z.ai/api/coding/paas/v4"
api_key_env = "ZAI_API_KEY"             # env var for API key (empty = no key)
context_window = 128000                 # required
max_tokens = 8192                       # required
# vision = false                        # optional: model accepts image input

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

# --- Inline AI (Cmd+K in a terminal pane, spec 333) ---
# Runs through an ACP backend subprocess: no API key, the CLI's own login.

[inline_ai]
backend = "claude"             # ACP backend id (same ids as the backend picker)
model = "haiku"                # applied after session/new ("" = backend default)
mode = "default"               # session/set_mode after session/new ("" = backend's own mode)
context = true                 # attach a pane snapshot to the first prompt of each Cmd+K (spec 334)
follow_up = true               # when an accepted Cmd+K command fails, propose a fix on a pane chip (spec 335)
remote_checks = true           # in an SSH pane, let Cmd+K run read-only checks on that host (spec 336)

# --- Native command output (spec 351) ---
[native_output]
enabled = true                 # draw native cards over unified-diff command output
default_view = "native"        # "native" | "raw" for new cards; Leader i flips one

# --- ACP Harness ---
# Multi-lane ACP orchestration view opened with Leader Y.

[acp_harness]
idle_flash_sound = true        # play soft cue when a busy lane becomes idle with a draft
memory_footer = true           # append MEMORY footer for automatic shared-memory extraction
composer_bloom = true          # fading letter afterimage on the prompt (spec 252)
composer_bloom_ms = 320        # afterimage duration in ms (180–700)
composer_bloom_trail = 5       # visible graphemes that flash on one paste (1–12)
word_autocomplete = true       # ghost-text word completion in the composer (spec 285)
lessons = true                 # global lane lessons: policy block, lesson_* tools, nudges (spec 298)

# Cheap-model turn sidecar (spec 306). Off by default: it runs through an ACP
# backend subprocess (no API key, the CLI's own login) and spends the same
# subscription quota the lanes spend, once per turn.
[acp_harness.assist]
mode = "off"                   # off | manual | auto
backend = "claude"             # ACP backend id (same ids as the backend picker)
model = "haiku"                # id/alias for session/set_model ("" = backend default)
timeout_ms = 8000              # model-call deadline in ms (1000–20000); a cold start gets its own
max_input_chars = 6000         # hard cap on the payload sent to the model (500–20000)

# Per-task override. The table name must be a registered assist task id
# (`follow-up` or `grammar`).
# [acp_harness.assist.tasks.follow-up]   # specs 323, 327: follow-up buttons under replies
# mode = "auto"                # default "off"; one cheap-model call per finished reply
# model = "haiku"
# count = 3                    # 1..3 buttons per reply (run, open and prompt together)

# Rails verifier (spec 337). Runs only in projects that have a trusted
# `.krypton/rails.toml` (`#rails trust`); the judge spends the backend's
# subscription quota once per changed working tree.
[acp_harness.rails]
mode = "auto"                  # off | manual | auto
backend = "claude"             # ACP backend id for the judge
model = "haiku"                # id/alias for session/set_model ("" = backend default)
timeout_ms = 60000             # judge deadline in ms (10000–180000)
max_input_chars = 32000        # judge payload cap (4000–80000)
debounce_ms = 5000             # quiet time after a lane goes idle before a run (1000–60000)
min_interval_ms = 0            # spec 339: shortest time between auto run starts (0–3600000; 0 = off)

# --- ACP Wire Profiler (spec 288) ---
# Records ACP traffic (Krypton ↔ agent stdio and Rust → UI events) into an
# in-memory ring for the loopback profiler page (palette: ACP Wire: Open
# Profiler). Palette commands change the mode at runtime; Reload Config
# re-applies `capture`.

[acp_wire]
capture = "off"                # off | meta (size/method/id/timing) | full (also message bodies)
ring_events = 20000            # ring size in events (1000–200000)
full_payload_mb = 64           # memory cap for bodies in full mode, MiB (8–512)

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
backdrop_blur = 20             # reserved: parsed, not applied

# --- Workspaces ---
# Each workspace is a virtual desktop containing arranged terminal windows.

[workspaces]
startup = "single"           # reserved: parsed, not applied
# default_layout = "focus"   # grid | focus | depth | scroll | stage | wheel
gap = 6                      # space between tiled windows, and the workspace
                             # edge inset in Grid/Scroll (0-64, live on Reload Config)
padding = 0                  # reserved: parsed but not applied yet
resize_step = 20             # pixels per arrow key press in resize mode; also the split-divider step (Shift+H/J/K/L, spec 296)
move_step = 20               # pixels per arrow key press in move mode
resize_step_large = 100      # pixels per Shift+Arrow in resize mode
move_step_large = 100        # pixels per Shift+Arrow in move mode

# Scroll layout (spec 241). Only used when default_layout = "scroll"
# or after Leader f cycles into Scroll.
# [workspaces.scroll]
# default_column_width = 0.5
# default_window_height = 1.0              # 0.15–1.0 of usable height; 1.0 = fill
# preset_column_widths = [0.33333, 0.5, 0.66667]
# center_focused_column = "always"         # never | always | on-overflow
# always_center_single_column = true

# --- Tabs ---

[tabs]
always_show_tabbar = false      # show the tab strip even when a window has one tab
default_split = "vertical"      # pane split direction when the action names none: "vertical" | "horizontal"
close_window_on_last_tab = true # closing a window's last tab closes the window

# --- Music Player ---

[music]
enabled = true                 # reserved: parsed, not applied
volume = 0.7                   # playback volume at launch (0.0–1.0)
directory = "~/Music"          # MP3 directory loaded at launch ("~" expands). Opening
                               # another directory in the player is not saved here.
visualizer = true              # Circuit Trace background visualizer
visualizer_opacity = 0.18      # visualizer canvas opacity (0.0–1.0)

# --- Vault Viewer ---

[vault]
path = ""                      # default vault directory ("" = none)
# More named vaults for the vault picker:
# [[vault.paths]]
# name = "notes"
# path = "/path/to/notes"
```

## Section Reference

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[shell]` | `program` | string | `$SHELL`, else `/bin/sh` | Shell binary path |
| `[shell]` | `args` | string[] | `["--login"]` | Arguments passed to shell |
| `[font]` | `family` | string \| string[] | `"Mononoki Nerd Font Mono"` | Font family name, or an array of names for fallback (first match per glyph) |
| `[font]` | `size` | float | `14.0` | Font size in points |
| `[font]` | `line_height` | float | `1.2` | Line height multiplier |
| `[font]` | `ligatures` | bool | `true` | Enable font ligatures |
| `[terminal]` | `scrollback_lines` | int | `10000` | Scrollback buffer size |
| `[terminal]` | `cursor_style` | string | `"block"` | `block`, `underline`, or `bar` |
| `[terminal]` | `cursor_blink` | bool | `true` | Enable cursor blinking |
| `[terminal]` | `cursor_trail` | bool | `true` | Rainbow flame trail following the mouse and text cursor |
| `[keyboard_overlay]` | `enabled` | bool | `false` | Show the ghost-hands keyboard overlay at startup; `Leader Shift+K` toggles it at runtime (spec 271) |
| `[keyboard_overlay]` | `layout` | string | `"auto"` | Key labels: `auto` (QWERTY, Kedmanee while typing Thai), `us`, `de`, `th` |
| `[keyboard_overlay]` | `width_ratio` | float | `0.36` | Keyboard width ÷ workspace width, clamped to 0.2–0.8; the mouse pad adds to it, and the whole overlay is capped at the workspace width |
| `[keyboard_overlay]` | `opacity` | float | `0.7` | Whole-overlay alpha, clamped to 0.1–1.0 |
| `[keyboard_overlay]` | `mask_secure_input` | bool | `true` | Hide keys at a local terminal password prompt (`ECHO` off, `ICANON` on) |
| `[keyboard_overlay]` | `idle_ghost` | bool | `false` | Hands-only demo phrases after 5 s idle; never typed into a terminal |
| `[keyboard_overlay]` | `mouse` | bool | `true` | Draw a mouse the right hand grips while the pointer moves; clicks light its buttons. `false` keeps the compact keyboard-only overlay |
| `[theme]` | `name` | string | `"krypton-dark"` | Built-in or custom theme name (see [Theme Specification](./0010-theme-specification.md)). Command palette **Color Theme** actions call `set_theme` and persist this key. File edits apply on **Reload Config** or the next launch. |
| `[theme.colors]` | *(various)* | string | — | Hex color overrides (applied on top of named theme) |
| `[tabs]` | `always_show_tabbar` | bool | `false` | Show the tab strip even when a window has a single tab |
| `[tabs]` | `default_split` | string | `"vertical"` | Pane split direction when the split action does not name one: `"vertical"` or `"horizontal"` |
| `[tabs]` | `close_window_on_last_tab` | bool | `true` | Closing a window's last tab (or the content view in it) closes the window |
| `[music]` | `enabled` | bool | `true` | Reserved — parsed, not applied |
| `[music]` | `volume` | float | `0.7` | Playback volume at launch (0.0–1.0) |
| `[music]` | `directory` | string | `"~/Music"` | MP3 directory loaded at launch when no playlist is loaded; `~` expands. Opening another directory in the player changes the in-memory value only — the file is not rewritten |
| `[music]` | `visualizer` | bool | `true` | Circuit Trace background visualizer |
| `[music]` | `visualizer_opacity` | float | `0.18` | Visualizer canvas opacity (0.0–1.0) |
| `[vault]` | `path` | string | `""` | Default vault directory for the Vault Viewer picker |
| `[[vault.paths]]` | `name`, `path` | string | — | Further named vaults for the picker. Entries with an empty `path` or a `path` already listed are skipped; an empty `name` shows the last path segment. The focused project's `docs/wiki` is added without an entry (spec 144) |

### Agent Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[agent]` | `active` | string | `"zai"` | Name of the active model preset |
| `[[agent.models]]` | `name` | string | *required* | Unique preset name (e.g. `"zai"`, `"ollama-gemma4"`) |
| `[[agent.models]]` | `provider` | string | *required* | Provider: `"zai"`, `"ollama"`, `"openai"`, `"anthropic"`, etc. |
| `[[agent.models]]` | `model` | string | *required* | Model identifier (e.g. `"glm-5.1"`, `"gemma4:latest"`, `"gpt-4o"`) |
| `[[agent.models]]` | `base_url` | string | *required* | API endpoint URL |
| `[[agent.models]]` | `api_key_env` | string | *required* | Environment variable name for API key. Empty string = no key needed (local models) |
| `[[agent.models]]` | `context_window` | int | *required* | Model's context window in tokens |
| `[[agent.models]]` | `max_tokens` | int | *required* | Maximum output tokens per response |
| `[[agent.models]]` | `vision` | bool | `false` | Model accepts image input |

To switch models, change `active` to the name of another preset. Changes take effect on next agent session (reset the agent or open a new agent window).

Every `[[agent.models]]` key except `vision` is required: a preset missing one makes the whole `krypton.toml` fail to parse, and Krypton then runs on built-in defaults for every section (see [Load Behavior](#load-behavior)). Defining any `[[agent.models]]` entry replaces the built-in preset list.

### Inline AI Configuration (spec 333)

`[inline_ai]` picks the ACP backend behind the terminal's `Cmd+K` overlay. Like the Harness lanes, it runs the backend CLI as a subprocess, so it needs **no API key**: the CLI's own login authenticates it, and every query spends that subscription's quota. One process is kept warm per backend and pane directory; every `Cmd+K` opens a fresh session on it. The session is fenced: no MCP servers, and every permission request, file write and question from the agent is declined.

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[inline_ai]` | `backend` | string | `"claude"` | ACP backend id, from the same id space as the Harness backend picker. A change respawns the process on the next `Cmd+K` |
| `[inline_ai]` | `model` | string | `"haiku"` | Model id or alias applied after each `session/new`. Backends that advertise no model state (e.g. `omp`, `cursor`) reject any id — set `""` for those to keep the backend default |
| `[inline_ai]` | `mode` | string | `"default"` | Agent-side session mode (`session/set_mode`) applied after each `session/new`. `"default"` makes Claude ask before any state-changing command, which the fence then declines, even when `~/.claude/settings.json` says `defaultMode = "auto"`. Backends with other mode ids (e.g. `codex`) reject it — set their asking mode or `""` (keep the backend's own, and with it whatever it approves without asking) |
| `[inline_ai]` | `context` | bool | `true` | Spec 334. Attaches a `<terminal_context>` snapshot of the pane to the first prompt of each `Cmd+K`: cwd, shell, foreground process, SSH target, the selection, the last commands with their exit codes (OSC 133, sent by fish 4 on its own), and the newest command's output or else the screen tail. It is capped at 8 000 chars, and credential-shaped text is replaced with `[REDACTED]`. The overlay label shows what was attached. `false` sends only the working directory. It also decides whether a `follow_up` report carries the failed command's output |
| `[inline_ai]` | `follow_up` | bool | `true` | Spec 335. After `↵` / `⇧↵` accepts a command, the overlay's conversation stays open and Krypton watches that command through OSC 133. If it exits with a status other than 0 or 130, or the shell rejects the line before running it (a fish syntax error), Krypton sends the command, its result and (with `context = true`) its output to the same conversation, and an `AI FIX` chip in the pane's corner shows the corrected command. `Cmd+K` in that pane opens it; `↵` / `⇧↵` replace the shell line with it. Each failure costs one model call. Only a pane whose latest OSC 133 event is a prompt is watched (spec 336), so zsh/bash without integration, tmux, an `ssh` into a host that sends no OSC 133, and the Quick Terminal are never watched |
| `[inline_ai]` | `remote_checks` | bool | `true` | Spec 336. When the pane's foreground process is `ssh`, `Cmd+K` opens a separate, non-PTY SSH channel to that host (borrowing the pane's ControlMaster when it has one, else a Krypton-owned one with `BatchMode=yes`) and gives the agent one tool, `host_exec`, that runs a command there only when Krypton's read-only list (spec 318) accepts it: no git, globs, redirects, `$VAR`, `~` or `cd`. The agent is told the host's shell and, from OSC 7, its cwd. A host that needs a password and has no reusable master gets no checks; the label says `no remote checks` and the agent is told why. `false` opens no connection |

Edits apply on **Reload Config** at the next `Cmd+K`; an overlay that is already open keeps its session. `follow_up` is read when a command is accepted.

Every Inline AI prompt also tells the agent to check, with read-only commands, every fact its answer depends on before answering (spec 336); there is no switch for it.

### Native Command Output (specs 351, 352)

A finished command whose output is a unified diff gets a native card over its rows: one line-number column, syntax colour, word marks and a `command · Native | Raw · Copy` bar. The card needs OSC 133 command marks, which fish 4 sends by default. If the rows hold something else (delta, a pager's leftovers), a plain local `git [--no-pager] diff …` is re-run once without pager or colour to get the diff. A plain local `git status` is re-run as porcelain v2 and shown as the branch line plus Conflicts / Staged / Unstaged / Untracked groups with `+A -D` counts. Cards are transparent; the raw rows under them are hidden while the card is in Native view. `Leader i` flips the newest visible card between Native and Raw, and `Leader Shift+I` copies its diff or status.

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[native_output]` | `enabled` | bool | `true` | `false` draws no new cards; existing ones stay |
| `[native_output]` | `default_view` | string | `"native"` | View of new cards: `"native"` or `"raw"`. Any other value means `"native"` |

Edits apply on **Reload Config** to the next finished command. In fish panes, `enabled = true` also loads Krypton's pager hints (spec 353): for the run of a plain `git diff`, `GIT_PAGER=cat` keeps the diff out of less/delta, so the whole diff is in the terminal for the card. Raw then shows git's own coloured diff. The hints follow `enabled` only for panes opened after the change.

### Timeline Automatic Recording

Timeline is managed by the working local MCP-capable lane, not a separate
semantic service ([spec 316](0316-llm-managed-timeline.md)). It needs no
additional API key or model configuration. `#timeline auto` reports the
per-project setting; `#timeline auto on` / `off` changes it. It defaults off
(manual mode, [spec 356](0356-timeline-manual-mode.md)); `#timeline auto on`
turns on automatic recording.

This is persisted outside TOML in the gitignored
`.krypton/timeline/settings.json`. The file exists only after `#timeline auto`
on/off or a schema 1 migration; without it the project is in manual mode, and a
stored value is kept as is. After `#timeline auto on`:

```json
{ "schema": 2, "automaticRecording": true }
```

The native DTO is `TimelineSettings { automaticRecording: boolean }`, accessed
through `timeline_settings` / `timeline_set_enabled`; `timeline_pending_count`
supplies nonvisual legacy migration state. Reading schema 1 settings migrates
`automaticSuggestions` to schema 2 `automaticRecording` atomically while
preserving the old value, including false. Event records remain schema 1.
Off is manual mode: the lane calls Timeline tools only when the human's current
message or a `#timeline` command asks, `timeline_record` requires a
`user_request_excerpt` quoting that request (checked, never stored), and the
legacy backlog line is not sent, so `timeline_pending_resolve` runs only on
request. Off never deletes history. There is no fallback capture form, human
queue or extra model turn. Explicit read-only work cannot mutate Timeline, and
Remote/Pi lanes without project-backed tools do not access local storage.

The former `[typesafe]` and `[typesafe.timeline_topics]` configuration,
topic-choice UI, transport, footer counter and Profiler metrics are retired.
Old TOML sections are accepted as unknown configuration and ignored; they do
not enable a service or require credentials. No live semantic dependency
remains. Rebuilt hosts and normally reconnected lanes must expose the new
MCP contract before existing backlog can be processed; the setting itself
does not start a migration turn or prove any production candidates migrated.

### ACP Agent Backends

ACP agent backends are built into Krypton rather than configured in `krypton.toml`. The built-in backend IDs are `claude`, `codex`, `opencode`, `pi-acp`, `droid`, `cursor`, `junie`, `omp`, `grok`, `copilot`, `mimo`, `cline`, `fx`, and `antigravity`. They run as ACP Harness lanes.

| Backend | Command |
|---------|---------|
| Claude | `npx -y @agentclientprotocol/claude-agent-acp@latest` |
| Codex | `npx -y @agentclientprotocol/codex-acp@latest` |
| OpenCode | `opencode acp` |
| Pi | `pi-acp` |
| Droid | `droid exec --output-format acp` |
| Cursor | `cursor-agent acp` |
| Junie | `junie --acp true` |
| OMP | `omp acp` |
| Grok | `grok --trust agent stdio` |
| Copilot | `copilot --acp --stdio` |
| MiMo | `mimo acp` |
| Cline | `cline --acp` |
| fx | `fx acp` |
| Antigravity | `./agy_acp_server.par` (managed install from the ACP Registry, launched from its cache directory; local-only) |

Claude and Codex run through `npx` with the `@latest` tag, so every new lane resolves the newest adapter release (and the Claude/Codex CLI each adapter bundles), skipping any older global or project-local copy. Grok and OMP use the CLI installed on the machine; once per launch Krypton checks them and, when either is behind, shows an update button in the ACP Harness window titlebar that runs `grok update` / `omp update` in a terminal tab. See `docs/0322-acp-backend-update-check.md`.

Krypton resolves these commands through `PATH`; macOS GUI launches use a cached login-shell `PATH`. Authentication is the user's responsibility outside Krypton (`claude /login`, Codex login/adapter setup, `pi /login` or provider env vars, Factory `FACTORY_API_KEY` env var or `droid` device-code flow, `cursor-agent login` or `CURSOR_API_KEY`, `junie` first-run for JetBrains Account or `JUNIE_API_KEY` / `--auth <token>` / BYOK provider keys, `omp` first-run/auth-broker or provider keys, `grok` first-run browser login or `XAI_API_KEY`, `copilot` `/login` device flow or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`, `mimo` first-run provider setup, `cline auth`, `fx login` / `fx setup` or `AI_GATEWAY_API_KEY`). Antigravity is the exception: Krypton installs it and signs it in automatically (see below).

**Pi lane prerequisites.** The Pi-1 lane uses the third-party [`pi-acp`](https://github.com/svkozak/pi-acp) adapter to drive the [`pi`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) coding agent. Install both globally:

```sh
npm install -g @mariozechner/pi-coding-agent
npm install -g pi-acp
```

Configure the model provider via either an API-key env var (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) exported before launching Krypton, or run `pi /login` once outside Krypton for OAuth subscriptions (Claude Pro/Max, ChatGPT Plus, Copilot). The harness does not provide a TTY for pi's interactive OAuth flow, so OAuth must be initiated outside Krypton.

Optional pi settings in `~/.pi/agent/settings.json`:

- `"quietStartup": true` — suppress pi-acp's startup banner in the lane transcript.
- Set env `PI_OFFLINE=1` to disable pi's update checks and install telemetry.

**Pi-1 caveats.** Unlike regular lanes such as Codex, Claude, OpenCode, Droid, and Cursor, Pi-1 deliberately:

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

**MCP delivery (Cursor-specific).** `cursor-agent` **ignores MCP servers passed via ACP `session/new`** — both stdio and http — even though it advertises `mcpCapabilities`. It honored them on `2026.05.20` but regressed upstream (verified broken on `2026.05.27`/`2026.05.28`; tracked as [Zed #50924](https://github.com/zed-industries/zed/issues/50924) and Cursor forum reports). `--approve-mcps` has no effect in ACP mode either. So Krypton does **not** inject via `session/new` for Cursor. Instead, on Cursor lane spawn it writes the per-lane `krypton-harness-memory` server into `<projectDir>/.cursor/mcp.json` (merging, preserving the user's own entries) and pre-approves it with `cursor-agent mcp enable krypton-harness-memory` — cursor's only working ACP-mode path (an unapproved native server stays "needs approval" and never connects). The entry is removed from `.cursor/mcp.json` when the lane closes. When upstream `session/new` injection returns, this workaround can be dropped. If the project also defines `.cursor/mcp.json` entries of its own, avoid the reserved name `krypton-harness-memory`.

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

OMP is a regular permission-gated lane. Headless `omp acp` creates its sessions with `enableMCP: false`, so it reads no on-disk MCP config — neither the project `.mcp.json` nor `~/.omp/agent/mcp.json`. Krypton passes the project `.mcp.json` servers (the spec-83 bridge) plus the per-lane `krypton-harness-memory` server through `session/new.mcpServers`. A server listed only in `~/.omp/agent/mcp.json` does not reach OMP lanes; put it in the project `.mcp.json`. Krypton re-reads `.mcp.json` on every lane spawn, so a file created or edited while a lane runs reaches the next lane spawn or respawn.

Optional: `acp_harness.lane_models.omp.active` is accepted for the lane model chip, but Krypton does not pass it to OMP at spawn or via `session/set_model` until either path is verified to take effect under `omp acp`.

**Grok lane prerequisites.** The Grok lane uses xAI Grok Build's native ACP mode (`grok --trust agent stdio`). `--trust` is required because Grok 1.0.13 skips every repo-local MCP server (project `.mcp.json`) until the folder is in `~/.grok/trusted_folders.toml`; ACP has no TUI `/hooks-trust` prompt, so without the flag `search_tool` returns an empty catalog. The flag records the cwd as trusted (same store as the TUI). Install the CLI (macOS/Linux):

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

**Cline lane prerequisites.** The Cline lane uses the Cline CLI's native ACP server (`cline --acp`, stdio). Install the CLI globally:

```sh
npm i -g cline
```

Then authenticate outside Krypton by running `cline auth` once. Krypton does not provide a TTY for Cline's interactive auth flow, so it must be completed outside Krypton. Startup failures include Cline-specific install, old-CLI-without-ACP, auth, token, and empty-stderr hints.

Cline is a regular permission-gated lane, but it gets its MCP servers through a **native-config overlay**, not `session/new`. Verified against cline 3.0.24, the `initialize` response advertises no `mcpCapabilities`, so any http/sse server injected through `session/new.mcpServers` is silently dropped and never connects. Instead Krypton writes a per-lane `cline_mcp_settings.json` — carrying the per-lane `krypton-harness-memory` server (tagged `streamableHttp`) plus the project `.mcp.json` bridge (spec 83) — under `~/.config/krypton/runtime/cline/<harness>/<lane>/`, and points the `CLINE_MCP_SETTINGS_PATH` env var at it at spawn. This overrides only the MCP settings file, so the global `~/.cline` auth/providers from `cline auth` stay shared across lanes. The overlay is removed on lane close and garbage-collected on harness start. Optional `acp_harness.lane_models.cline.active` drives the lane model chip; Cline does expose `-m`/`--provider` CLI flags, but v1 leaves the model to `cline auth`/config, so the chip is display-only unless Cline advertises model state at `session/new` (then the generic `session/set_model` path applies).

**fx lane prerequisites.** The fx lane runs Vercel Labs [fx](https://github.com/vercel-labs/fx)'s native ACP server (`fx acp`, stdio). Install fx (it lands in `~/.local/bin`) and sign in once in a terminal:

```sh
curl -fsSL https://fx.sh/setup.sh | bash
fx login            # Vercel AI Gateway; or `fx login codex` / `fx login grok`, or `fx setup` / AI_GATEWAY_API_KEY
```

Krypton passes no flags, so the lane uses fx's saved provider and permission mode (default `auto`: routine work runs without asking, other actions go through fx's own safety review). An unauthenticated fx fails `initialize` with its own reason ("Run fx login …"); startup failures add fx-specific install, old-CLI (`fx upgrade`), and `fx doctor` hints.

fx is a regular permission-gated lane: the project `.mcp.json` bridge (spec 83) and the per-lane `krypton-harness-memory` server reach it through `session/new.mcpServers` (verified against fx 0.0.16: `mcpCapabilities {http}`, no SSE). fx connects to HTTP servers lazily on first use and asks permission for every MCP call; the harness auto-allows its built-in tools in fx's `mcp_<server>_<tool>` form. Client entries win over same-name project entries fx loads itself, and global `~/.fx/mcp.json` servers are not loaded in lanes. Models come from the lane's model picker (fx's `model` config option for its saved provider); provider switching stays in fx.

**Antigravity lane prerequisites.** Antigravity is not on `PATH`. Krypton installs Google's `antigravity-acp` server from the ACP Registry into the app cache (`app_cache_dir()`) on the first Antigravity lane spawn and launches it from its install directory. The download is ~110 MB and takes ~400 MB on disk per version. Krypton re-checks the registry at most once an hour and removes old versions before the process's first Antigravity spawn. Antigravity lanes are **local-only**: a remote harness does not offer the backend, and spawning one there fails with "Antigravity lanes are local-only".

Auth is automatic. When `session/new` (or resume/load) reports "Authentication required", Krypton calls `authenticate` with `oauth-personal`, which uses your existing Google sign-in (or starts the server's browser sign-in), and the server persists the choice to `~/.gemini/antigravity-acp/settings.json`. Workspace (`oauth-business`), Gemini API-key, or Agent Platform users must set `auth.type` in that file before the first lane; switching later also means editing `auth.type`. If sign-in fails, run `agy` once to sign in. Model ids come from the lane's model picker (the server advertises them at `session/new`); there is no fixed list.

See `docs/0069-acp-agent-support.md` for the original ACP design, `docs/0084-acp-pi-lane.md` for Pi-1, `docs/0086-acp-droid-lane.md` for Droid-1, `docs/0113-acp-cursor-lane.md` for Cursor, `docs/0119-acp-junie-lane.md` for Junie, `docs/0122-acp-omp-lane.md` for OMP, `docs/0135-acp-grok-lane.md` for Grok, `docs/0150-acp-copilot-lane.md` for Copilot, `docs/0159-acp-cline-lane.md` for Cline, and `docs/0359-acp-fx-lane.md` for fx.

### ACP Harness Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[acp_harness]` | `idle_flash_sound` | bool | `true` | Reserved for the soft cue when an active lane returns idle while its draft is non-empty |
| `[acp_harness]` | `memory_footer` | bool | `true` | Append the MEMORY footer to each harness prompt so agents can publish short shared-memory bullets |
| `[acp_harness]` | `composer_bloom` | bool | `true` | Fading letter afterimage on direct composer insertion (spec 252). System Reduce Motion still wins. |
| `[acp_harness]` | `composer_bloom_ms` | int | `320` | Afterimage duration in milliseconds, clamped to 180–700 |
| `[acp_harness]` | `composer_bloom_trail` | int | `5` | How many inserted visible graphemes receive an afterimage on one paste, clamped to 1–12 |
| `[acp_harness]` | `word_autocomplete` | bool | `true` | Show predicted word completions as composer ghost text (`Tab` accepts + space, `→` accepts) (spec 285). Prompts from every lane are still logged to `~/.config/krypton/harness-prompt-history.db` when `false`. Applies on Reload Config. |
| `[acp_harness]` | `lessons` | bool | `true` | Global lane lessons (spec 298). Lessons live in `~/.config/krypton/lessons/` (one `<slug>.md` each, plus a generated `INDEX.md` and `retired/`) and are injected into the policy of every lane in every project. `false` removes the policy block, hides `lesson_record` / `lesson_retire` from `tools/list`, drops the correction nudges, and disables `#lesson`. The files are left untouched. Applies on Reload Config. |
| `[[acp_harness.remote_profiles]]` | `name` | string | — | Unique picker label for an SSH Harness target |
| `[[acp_harness.remote_profiles]]` | `host` | string | — | OpenSSH host alias; user, port, identity and ProxyJump remain in `~/.ssh/config` |
| `[[acp_harness.remote_profiles]]` | `project_dir` | absolute path | — | Remote project root sent through the runtime protocol, never a shell command |
| `[[acp_harness.remote_profiles]]` | `connect_timeout_seconds` | integer | `15` | Bounded hello-handshake timeout |
| `[acp_harness.lane_models.<backend>]` | `active` | string | `""` | Model id/alias applied to the lane (CLI flag at spawn, or `session/set_model`/`set_config_option` after `session/new`). Empty = use the adapter default, except MiMo uses its anonymous free `mimo/mimo-auto` model |
| `[acp_harness.lane_models.<backend>]` | `models` | array | `[]` | Informational allow-list (not enforced). The in-harness picker (spec 127) sources its options from the agent-advertised `availableModels`, not this array |
| `[acp_wire]` | `capture` | string | `"off"` | ACP wire tap mode: `off`, `meta` (size, method, id, timing), or `full` (also message bodies — prompts, file contents, tool output). Applied at launch and on Reload Config; the palette `ACP Wire: Capture …` commands change it at runtime without writing back (spec 288) |
| `[acp_wire]` | `ring_events` | int | `20000` | In-memory ring size in events, clamped to 1000–200000. Oldest evicted first |
| `[acp_wire]` | `full_payload_mb` | int | `64` | Memory cap for captured bodies in `full` mode (MiB, clamped 8–512). Oldest bodies are dropped first; their events stay |

The ACP Harness backend picker is code-defined in v1: installed built-in backends are listed, and the harness starts with no lanes until the user spawns one via `Cmd+P → +`. Shared memory is tab-local and is dropped when the harness tab closes. See `docs/0072-acp-harness-view.md`.

Remote profiles are optional. Krypton automatically probes the remote user cache,
detects macOS/Linux plus arm64/x86_64, and uploads the matching `krypton-remote`
companion when required. The remote computer does not need Krypton source, Rust,
`sudo`, or a manual `PATH` installation. A same-platform helper is bundled with
the app; cross-platform helpers are downloaded from the matching Krypton release,
verified against its SHA-256 file, and cached locally before upload. Krypton uses
`BatchMode=yes`, so password, passphrase, and first-time host-key prompts must be
completed with ordinary `ssh <host>` before opening the Harness. Agent CLIs and
their authentication still belong on the remote computer.

```toml
[[acp_harness.remote_profiles]]
name = "buildbox"
host = "buildbox"
project_dir = "/srv/repos/krypton"
connect_timeout_seconds = 15
```

**Lane model selection.** `<backend>` keys match the ACP Harness backend ids: `opencode`, `droid`, `cursor`, `claude`, `codex`, `pi-acp`, `junie`, `omp`, `grok`, `copilot`, `mimo`, `cline`, `fx`, and `antigravity`. Krypton applies `active` only for backends that support model selection in v1:

- **OpenCode** (v2+) — `session/new` advertises no `models` object; it carries a stable ACP `configOptions` select with `category: "model"`. Krypton applies `active` via `session/set_config_option {configId, value}` right after `session/new`, and the in-harness picker lists that select's options and switches through the same request. A failure (model not in OpenCode's list — e.g. its provider is not authenticated in `opencode auth list` — or a timeout) is **non-fatal**: the lane starts on OpenCode's own default and the model chip turns amber. Empty `active` = OpenCode's default.
- **fx** — same `configOptions` path as OpenCode. fx advertises a `provider` select ahead of its `model` select under `category: "model"`; when several model-category selects exist, Krypton uses the one whose id is `model` (otherwise the first). `active` must be one of the models fx offers for its saved provider; a rejection is non-fatal (amber chip, fx's current model keeps running).
- **Droid** — passes `-m <active>` to `droid exec` at spawn. Default if unset is Factory's `claude-opus-4-7`. Changing the model requires respawning the lane.
- **Claude** (and any ACP-native backend that advertises model state) — applied via `session/set_model {sessionId, modelId}` right *after* `session/new`, for adapters whose `session/new` response carries a valid `models` object (an `availableModels` array or a `currentModelId` string). When there is no `models` object but `configOptions` has a `category: "model"` select, the same apply uses `session/set_config_option` instead (the OpenCode path above); `models` wins when both are present. `active` is sent **verbatim**, so aliases like `opus`/`sonnet`/`haiku` resolve adapter-side. A failure (unknown id, timeout, adapter doesn't implement the method) is **non-fatal**: the lane keeps running on the agent default and the model chip turns amber with a tooltip. The set of available models is the *agent's* (advertised in `session/new`) — you don't maintain a catalog; the optional `models` array only curates/orders a future picker.
- **Cursor / Codex / Pi / Junie / OMP / Grok / Copilot** — `active` is accepted in the schema but no CLI flag is passed at spawn (those adapters do not pass model via a spawn flag in v1). The value still drives the lane model chip if present, and each auto-enables the generic `session/set_model` path with no further code if/when its adapter advertises model state at `session/new`. (Grok's `-m` spawn flag under `agent stdio` is unverified and deferred — see `docs/0135-acp-grok-lane.md`. Copilot's ACP server documents no model flag and advertised no model state at `initialize` in CLI 1.0.60 — see `docs/0150-acp-copilot-lane.md`.)

**Respawn-to-apply.** `active` is snapshotted into the lane at spawn. Editing `krypton.toml` updates the stored config and the chip inference, but does **not** re-apply to a live lane — the agent model changes only on the next spawn / `#new` / `#new!` / lane restart. Resumed and loaded sessions keep whatever model they were saved with and are not forced to the current config.

**In-harness model picker (spec 127).** Press the harness leader key then `,` (`⌘P` then `,`) to open a keyboard-driven model picker for the focused lane (`j`/`k` move, `↵` switch, `esc` cancel). It lists the models the agent advertised in `session/new` (so you can't pick an unsupported id) and switches the **live** lane via `session/set_model`. The picker is **session-scoped**: it does **not** rewrite `krypton.toml`, so `active` still governs the spawn default and the picker choice resets on respawn. The picker is disabled for lanes whose backend advertises no model state (the chip explains why). A switch that the agent rejects reverts the chip; a timeout keeps the choice but flags it unconfirmed (the agent may still apply it). When the new model doesn't support the lane's current mode, the adapter clamps it (e.g. `auto` → `default` on Haiku) and the lane notes the downgrade in its transcript.

Example:

```toml
[acp_harness.lane_models.opencode]
active = "anthropic/claude-sonnet-4-5"
models = ["zai-coding-plan/glm-5.1", "anthropic/claude-sonnet-4-5", "openai/gpt-5"]
```

### ACP Harness Assist (spec 306)

`[acp_harness.assist]` configures the cheap-model sidecar: after a lane turn ends, a small model reads the reply and offers follow-up buttons under it (`follow-up`), and after the human sends a prompt it can review that prompt (`grammar`). It reaches that model **through an ACP backend subprocess** — the same path the harness lanes use — so it needs **no API key**: it reuses whatever login the backend CLI already has (`claude`, `codex`, `omp`, …). The default is `mode = "off"` because those calls spend the **same subscription quota** the lane agents spend, without being asked.

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[acp_harness.assist]` | `mode` | string | `"off"` | `off` (never runs), `manual` (only `Cmd+/` and `#assist … now`), or `auto` (also runs when an eligible turn ends). Any other value is treated as `off`. Session-scoped `#assist` changes do not rewrite this file |
| `[acp_harness.assist]` | `backend` | string | `"claude"` | ACP backend id to spawn for the sidecar, from the same id space as `[acp_harness.lane_models.<backend>]` and the backend picker. An unknown id fails the run |
| `[acp_harness.assist]` | `model` | string | `"haiku"` | Model id or alias sent with `session/set_model` after the session is created. `"haiku"` works for the `claude` backend; a backend that advertises no model state rejects a model id, so leave `model = ""` for those — empty means "keep the backend's own default" |
| `[acp_harness.assist]` | `timeout_ms` | int | `8000` | Model-call deadline in milliseconds, clamped to 1000–20000 in the frontend. The request is aborted on expiry. Backend setup on a cold start (spawn → `initialize` → `session/new` → `session/set_model`) gets its own window of the same length, so it is not counted against the call |
| `[acp_harness.assist]` | `max_input_chars` | int | `6000` | Hard cap on the payload handed to the model, clamped to 500–20000. The turn transcript is truncated to fit; tool entries are names and counts only |
| `[acp_harness.assist.tasks.<id>]` | `mode` | string | inherits | Override for this task only |
| `[acp_harness.assist.tasks.<id>]` | `backend` | string | inherits | Override for this task only |
| `[acp_harness.assist.tasks.<id>]` | `model` | string | inherits | Override for this task only |
| `[acp_harness.assist.tasks.<id>]` | `timeout_ms` | int | inherits | Override for this task only |
| `[acp_harness.assist.tasks.<id>]` | `max_input_chars` | int | inherits | Override for this task only |
| `[acp_harness.assist.tasks.<id>]` | *(any other scalar key)* | string/int/bool | — | Task-specific knob passed through verbatim as that task's `options`. Krypton holds no knowledge of these keys, so a new task needs no config schema change |

`<id>` must be a **registered assist task id** — `follow-up` (specs 323, 327) or `grammar`. A table naming an unregistered task parses but is never read; that includes a `[acp_harness.assist.tasks.next-prompt]` table from before the `next-prompt` strip was removed (2026-10-23).

Resolution order per run is `task defaults` ← `[acp_harness.assist]` ← `[acp_harness.assist.tasks.<id>]`, with the numeric keys clamped afterwards; the clamps live in the frontend, so an out-of-range value in TOML is corrected, not rejected.

`[acp_harness.assist.tasks.follow-up]` (specs 323 and 327, `docs/0323-harness-follow-up-actions.md`, `docs/0327-harness-follow-up-prompts.md`) turns on follow-up buttons under finished replies: commands to run, URLs to open, and prompts for the lane (send, or paste into the composer). Its `mode` defaults to `"off"`; with `"auto"` every finished reply of 40 or more characters costs one cheap-model call, since a prompt needs no command or URL in the reply. Its one option `count` (1..3, default `3`) caps the buttons per reply across all three kinds. No Rust config change backs it — the keys pass through the generic per-task table.

Example — auto-running follow-ups on the `claude` backend's small model:

```toml
[acp_harness.assist]
mode = "auto"
backend = "claude"
model = "haiku"

[acp_harness.assist.tasks.follow-up]
count = 3
```

### ACP Harness Rails Verifier (spec 337)

`[acp_harness.rails]` configures the background Rails verifier (`docs/0337-rails-verifier.md`). At harness quiet points it runs the checks a project declares in `.krypton/rails.toml`, then asks a cheap judge model whether the diff breaks the `## Rails` bullets that apply to the changed paths. The judge goes through an ACP backend subprocess, like `[acp_harness.assist]`, so it needs no API key. No check command runs, and no automatic run starts, until the manifest exists and `#rails trust` has approved that exact file; a manual `#rails now` before that runs the judge step only. The project manifest's own format (`version`, `sources`, `glossary`, `[[check]]`) is described in the spec, not here: it lives in the target repo, not in `krypton.toml`.

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[acp_harness.rails]` | `mode` | string | `"auto"` | `off` (never runs), `manual` (only `#rails now` and `r` in the Rails dock), or `auto` (also runs at quiet points once the manifest is trusted). Any other value is treated as `off`. `#rails off\|manual\|auto` overrides it for the session without rewriting this file |
| `[acp_harness.rails]` | `backend` | string | `"claude"` | ACP backend id for the judge step |
| `[acp_harness.rails]` | `model` | string | `"haiku"` | Model id or alias sent with `session/set_model`; `""` keeps the backend's default |
| `[acp_harness.rails]` | `timeout_ms` | int | `60000` | Judge deadline in milliseconds, clamped to 10000–180000. Checks have their own `timeout_s` in the project manifest |
| `[acp_harness.rails]` | `max_input_chars` | int | `32000` | Cap on the judge payload (rules, failed-check output, diff, glossary), clamped to 4000–80000 |
| `[acp_harness.rails]` | `debounce_ms` | int | `5000` | Quiet time after a lane goes busy → idle before a run starts, clamped to 1000–60000. Any later busy → idle restarts it |
| `[acp_harness.rails]` | `min_interval_ms` | int | `0` | Shortest time from the start of the newest recorded run (auto or manual) to the start of the next auto run, clamped to 0–3600000; `0` = off. A run due inside the window is held and starts once when it ends, if the harness is quiet; the dock head shows `auto run held until HH:MM`. `#rails now` ignores it; `#rails manual` drops a held run (spec 339) |

The clamps live in the frontend, so an out-of-range value in TOML is corrected, not rejected. The trust store is `~/.config/krypton/rails-trust.toml`, written only by `#rails trust` or the Rails dock's Trust button (spec 344), both a human action; deleting an entry makes that project's checks wait for trust again.

### ACP Harness Directives (`acp-harness.toml`)

Reusable, backend/task-scoped **directives** (system-style prompt blocks) live in a separate Krypton-owned file, **not** in `krypton.toml`:

| File | `~/.config/krypton/acp-harness.toml` |
|------|--------------------------------------|

Unlike `krypton.toml` (hand-edited, never written by Krypton), `acp-harness.toml` may be edited three ways: **by hand**, by the **`#directive` command** (which directs the focused lane to edit it with its own file tools — spec 161), or it is **created empty on first harness open**. Edits are picked up the next time the harness loads it — and the directive picker re-reads it on every open — so there is no live hot-reload in v1. A directive entry that fails to parse is skipped with a warning rather than breaking the whole file. See `docs/0124-acp-harness-directive-management.md` and `docs/0161-directive-tools-on-demand.md`.

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
| `[[directives]].triage_equipped` | bool | `false` | Legacy spec-129 metadata. Since spec 130, `attention_flag` / `attention_resolve` are default-on for every lane that receives the `krypton-harness-memory` MCP server, so this field no longer controls tool visibility or assignment approval. Krypton still accepts and displays it as a legacy directive badge for compatibility. See `docs/0130-default-attention-triage.md`. |

A directive's `system_prompt` is injected into the same leading context packet as the lane-context stub, after it and before the user's prompt. Assign a directive to the focused lane with `Cmd+P → .` (the directive picker) or by clicking the composer `directive …` chip. To **create or edit** a directive, type `#directive <what you want>` in the composer (spec 161): the focused lane reads `acp-harness.toml`, adds/edits the `[[directives]]` entry with its own file tools, and the picker shows it on the next open. (The earlier dedicated directive MCP tools — `directive_list`/`directive_preview`/`directive_apply`/`directive_remove` — were removed to cut per-turn token overhead; agent-initiated cross-lane assignment is no longer available.)

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

### Connected Computers (app-managed, spec 311)

Open **Connected Computers…** from the command palette to manage targets for
local Harness lane commands. Krypton writes a separate versioned file, not
`krypton.toml`:

```text
~/.config/krypton/connected-computers.toml
```

```toml
schema_version = 1

[[computers]]
id = "buildbox"
host = "buildbox"
user = "alice"          # optional; OpenSSH config/default when omitted
port = 22               # optional; OpenSSH config/default when omitted
default_cwd = "/srv/builds" # optional remote absolute path
auto_approve_read_only = false   # optional; default true — read-only commands run without asking (spec 318)
bypass_command_approval = true   # optional; default false — all valid commands run without asking (spec 385)
```

The file stores no password or private key. OpenSSH config supplies keys, jump
hosts and host-key policy. Profiles start as `configured` after app launch;
the user must choose **Connect** before a lane can run a command. Saving checks
the file revision to prevent overwriting an external edit. Spec 385 amends
specs 311/318: Rust first checks `bypass_command_approval` (omitted means `false`,
written only when `true`, schema version remains `1`). When enabled, any valid
command runs as the original command bytes without classifier or approval row.
This persistent grant covers every authorized local lane across all projects
for this computer ID, including role-assigned and Telegram-driven lanes; other
IDs remain independent, even on the same physical host. Lane bypass alone does
not enable it. There is no new exec argument, configuration API or CLI flag.
With bypass off, commands passing the built-in read-only classifier (spec 318)
run as re-quoted argv when `auto_approve_read_only` is on (default); every other
command requires exact-command approval. To always ask, disable both settings.
Reads may return non-hidden files to the model provider; bypass additionally
permits credential reads, deletion, network and service changes with the SSH
account's permissions and does not apply the read-only path guard. It is not a
sandbox. All validation, lane/connection checks, limits and cancellation remain.

The editor's unchecked `Bypass remote command approval` checkbox warns:
`All local lanes can run any command on this computer without asking, including file deletion and service changes. This setting is saved across app restarts.`
It disables the read-only checkbox without clearing its choice; save preserves
that checked state, and disabling bypass restores it. Detail shows
`Command approval: BYPASS — all commands`, otherwise `Read-only auto-approval`
or `Always ask`; enabled list rows append `BYPASS`. Changing policy requires
disconnect → edit → save → reconnect. Pending approvals are not accepted by
saving or reconnecting, and restart still requires explicit Connect.
Remote Harness workspaces and `acp_harness.remote_profiles` remain independent.

### Telegram Harness Controller (app-managed)

Telegram settings do not belong to the user-authored `krypton.toml`. Open
**Telegram Controller Settings** from the command palette; Krypton atomically
writes the non-secret settings to:

```text
~/.config/krypton/telegram.toml
```

```toml
schema_version = 1
enabled = false
rich_messages = false
authorized_user_ids = ["123456789"]
authorized_group_chat_ids = ["-1001234567890"]
```

`rich_messages` is an operator-controlled compatibility switch available in the
Telegram Settings view (`m`). When enabled, new assistant responses use native
Telegram Rich Messages for headings, tables, lists, code, links, and quotes,
with sanitized rendering and automatic plain fallback. It defaults to `false`
because Bot API acceptance cannot prove that every receiving Telegram client can
render rich content. Changing it does not alter a response already in flight.

IDs are canonical signed decimal strings: user IDs are positive and group chat
IDs are negative. Private control requires an authorized user. Group control
requires both an authorized sender and authorized group. Removing an entry
invalidates process-local chat targets immediately.

The Bot API token is stored under service/account
`com.krypton.telegram / bot-token` in macOS Keychain, Windows Credential
Manager, or Linux Secret Service. It has no TOML/environment fallback and is
never returned to the frontend. The non-secret polling watermark lives at
`~/.config/krypton/runtime/telegram-state.json`; changing bot identity resets
it. See spec 200 and ADR-0013 through ADR-0015.

### ACP Harness Attention Triage (spec 128)

Attention triage is **default-on** for lanes that receive the `krypton-harness-memory` MCP server. There is no `krypton.toml` switch and no required directive grant: `tools/list` advertises `attention_flag` / `attention_resolve` by default, while payload validation and the review queue remain the safety surface. The old `Cmd+P → '` manual equip action has been removed from the active UI. Summon the judgement queue with `Cmd+P → ;`. Existing `triage_equipped` directive fields are preserved only as legacy metadata/badges. See `docs/0128-attention-triage.md` and `docs/0130-default-attention-triage.md`.

### Loopback Server & Hooks Configuration

`[loopback_server]` owns the HTTP host; `[hooks]` owns one endpoint on it. Before
this split, `[hooks] enabled = false` silently disabled harness memory, every
browser surface and the hurl/termctrl/acp-wire viewers.

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[loopback_server]` | `enabled` | bool | `true` | Start the loopback HTTP server: harness memory MCP, `#dashboard`/`#gallery`/`#docs`/`#journal`/`#reviews`/`#analyses`/`#commands`/`#tools`, hurl, termctrl, acp-wire, artifact/doc feedback, and `/hook`. Off = lanes run without `krypton-harness-memory` and no surface opens. Load-time only; restart Krypton after changing it |
| `[loopback_server]` | `port` | int | `8765` | Port to listen on. `0` = OS auto-assigns. A busy fixed port falls back to an ephemeral one |
| `[hooks]` | `enabled` | bool | `true` | Accept Claude Code hook events on `POST /hook` (`503` when off). Read per request, so Reload Config applies it. Does **not** control the server |
| `[fire]` | `on` | string[] | `[]` | OSC 7501 program states (`working`, `blocked`, `error`, `done`) that set a terminal window on fire. The window burns while the status its chrome shows (highest-priority pane) is in the list, so `working` goes out at the next prompt or program exit and `done`/`error` when you type in that pane. `tool_error` burns a window holding an ACP Harness while any lane has a failed top-level tool call (not `canceled`, `!` shell rows or subagent children) that you have not acknowledged by typing while that lane is active; it uses the `error` look and ranks as `error` against the program states. Unknown values are ignored with a warning. Hot-reloadable. See docs 0362, 0365 |
| `[fire]` | `height` | float | `1.0` | Flame height multiplier, clamped to 0.25–3. Scales the built-in height (22% of the content height, 40–120 px). Hot-reloadable. See doc 0363 |
| `[fire]` | `intensity` | float | `1.0` | Brightness multiplier, clamped to 0.1–2. Hot-reloadable |
| `[fire]` | `speed` | float | `1.0` | Animation speed multiplier (flicker, rise and embers together), clamped to 0.25–4. Hot-reloadable |
| `[fire]` | `low` / `mid` / `hot` | string | unset | Fire colours: `low` the cooler flame tips, `mid` the flame body and the glow, `hot` the hottest core (embers keep their blackbody colour). Any CSS colour, `var()` included. Unset → theme tokens `krypton-fire-low`/`-mid`/`-hot` → built-in. Overrides the theme. An invalid value is ignored with a warning. Hot-reloadable |
| `[fire.<state>]` | same keys | | unset | Per-state look for `working`, `blocked`, `error` or `done`, overriding `[fire]` key by key. A lit window eases to its new state's look over about a second (snaps under reduced motion). A table for a state not in `on` is inert. See doc 0363 |
| `[acp_controller]` | `enabled` | bool | `true` | Start the authenticated local `kryptonctl` control endpoint. Load-time only; restart Krypton after changing it |
| `[acp_controller]` | `port` | int | `8766` | Fixed loopback port for the control API (stable URL for external clients). Ephemeral fallback on conflict; `0` = auto-assign. Load-time only. See doc 175 |
| `[acp_controller]` | `cors_origins` | string[] | `[]` | Exact browser origins allowed to call the control API directly (CORS). Empty = proxy-only (secure default); never `"*"`. Load-time only. See doc 175 |
| `[acp_controller]` | `install_native_host` | bool | `true` | Write the Chrome Native Messaging host manifest on launch (zero-config browser extension). Load-time only. See doc 176 |
| `[acp_controller]` | `native_host_browsers` | string[] | `["chrome"]` | Browsers whose `NativeMessagingHosts` dir gets the manifest: `chrome`/`chromium`/`edge`/`brave`/`opera`/`opera-gx`. Load-time only. See doc 176 |
| `[xenon]` | `enabled` | bool | `false` | Master switch for publishing to a Xenon resource server. While false, `#push` is inert. See doc 212 |
| `[xenon]` | `base_url` | string | `""` | Xenon server root, e.g. `https://xenon.example.com`. Empty = unconfigured |
| `[xenon]` | `project` | string | `""` | Project slug override. Empty derives `<owner>.<repo>` from the git remote, else a path-derived name. Single path segment only |
| `[xenon]` | `auto_push` | string[] | `[]` | Kinds a bare `#push` covers (`review`, `analysis`, `artifact`, `doc`, `attention`, `daily`, `timeline`, `handoff`). Empty = all. Listing `review` also publishes a Board on first registration; listing `attention` publishes a flag when raised; listing `handoff` publishes a handoff on each write (spec 293). Later review edits/responses and all other kinds remain manual. Listing `timeline` only includes recorded events in an explicit bare `#push`; legacy intake and resolution receipts remain local. `#resume` pulls handoffs from Xenon when enabled (token needs `resource:read`) |
| `[xenon]` | `probe_interval_secs` | integer | `60` | Cadence of the workspace footer's backend-link probe (spec 213). `0` disables the interval; the segment then updates only on `⌘P X` and after a `#push`. Hot-reloaded with the rest of `[xenon]` |

| `[usage_log]` | `enabled` | bool | `true` | Record one row per completed prompt turn to `.krypton/usage/<date>.jsonl`. See doc 214 |
| `[usage_log]` | `publish` | bool | `true` | Stream recorded turns to Xenon as they end. Requires `[xenon].enabled` plus a stored token; rows accumulate locally either way |
| `[usage_log]` | `retain_days` | integer | `90` | Local day files older than this are deleted on the sender's first cycle. `0` disables pruning |

| `[daily_note]` | `enabled` | bool | `true` | Capture harness events to `.krypton/journal/<date>.jsonl`. See docs 223 and 225 |
| `[daily_note]` | `retain_days` | integer | `400` | Journal `.jsonl` files older than this are deleted on the first capture of a run. `0` disables pruning; written `.md` days are never pruned |
| `[daily_note]` | `output_dir` | string | `".krypton/journal"` | Where written days go. Project-relative unless absolute — point it at a vault to write days there directly |
| `[daily_note]` | `extra_projects` | string[] | `[]` | Absolute paths to other projects also covered by the day. No machine-wide scan |

| `[knowledge]` | `dir` | string | `"~/.config/krypton/knowledge"` | Where commit explainers (`<repo>-<sha7>.md`) are written and listed. Absolute or `~/`. See spec 375 |
| `[knowledge]` | `backend` | string | `"codex"` | ACP backend id each Commit Browser explainer job spawns (spec 376). `#learn` uses its lane instead |
| `[knowledge]` | `model` | string | `"gpt-6.1-sol[high]"` | Model set on the job's session; `""` keeps the backend default |
| `[knowledge]` | `mode` | string | `"workspace-write"` | Session mode forced on the job; `""` keeps the backend default. Writes stay inside the job's scratch dir only with codex `workspace-write` — another backend or mode gives no sandbox guarantee |
| `[knowledge]` | `parallel` | integer | `2` | Explainer jobs running at once, clamped 1–4; the rest wait FIFO |

**Usage rows never contain text.** A row carries counts and identifiers only —
no prompt, no response, no file paths, no tool arguments. That is the property
that makes unattended streaming safe, and it is asserted in
`src/acp/usage-log.test.ts` so widening the row is a deliberate act. Read
today's numbers in the composer with `#usage`; open the server's ledger with
`#usage open`; drain a stuck queue with `#usage flush`. Cost estimates are
computed by Xenon from its own rate table (ADR-0018), so `#usage` in the app
shows only what an adapter actually reported.

**The Xenon bearer token is never stored in TOML.** It lives in the OS
credential vault under service `com.krypton.xenon`, keyed by `base_url` — the
same pattern as the Telegram bot token (ADR-0015). Mint one at
`<base_url>/settings/tokens`, then store it from the harness composer with
`#xenon token <token>` (the value is never echoed anywhere). `#xenon status`
reports whether the token is `configured`, `missing`, or `unavailable`, and
`#xenon token clear` deletes it.

Note that `[xenon]` is read from the shared config on every `#push`, so editing
it takes effect after a **Reload Config** from the command palette — no restart
needed.

### Hints Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[hints]` | `alphabet` | string | `"asdfghjklqweruiop"` | Characters used for hint label generation (should be easy to type) |
| `[hints]` | `file_action` | string | `"peek"` | What selecting a `filepath` hint does: `"peek"` opens the Quick Overview dialog (Enter escalates to Helix / markdown viewer / browser), `"editor"` opens the target directly as before. See `docs/0210-quick-overview-dialog.md` |
| `[[hints.rules]]` | `name` | string | *required* | Unique identifier for the rule |
| `[[hints.rules]]` | `regex` | string | *required* | Regular expression pattern to match in terminal content |
| `[[hints.rules]]` | `action` | string | *required* | Action on selection: `"Copy"`, `"Open"`, or `"Paste"`; the built-in `filepath` rule ignores this and follows `[hints] file_action` instead |
| `[[hints.rules]]` | `enabled` | bool | `true` | Whether this rule is active |

Built-in rules (active by default): `url` (Open), `filepath` (peek in the Quick Overview dialog), `email` (Copy).

### Sound Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[sound]` | `enabled` | bool | `true` | Master toggle — enables/disables all sound effects |
| `[sound]` | `volume` | float | `0.5` | Master volume (0.0 = silent, 1.0 = full) |
| `[sound]` | `pack` | string | `"deep-glyph"` | Sound pack name. Bundled packs: `"deep-glyph"`, `"mach-line"`, `"holo-dash"`. Packs are WAV sets shipped as app resources; custom packs are not supported. |
| `[sound]` | `keyboard_type` | string | `"cherry-mx-brown"` | Reserved — parsed, not applied. Keypress sounds come from the pack, with separate sounds for Backspace, Enter, Space and other keys. |
| `[sound]` | `keyboard_volume` | float | `1.0` | Volume multiplier for keypress sounds (0.0 = silent, 1.0 = full). Multiplied with master volume. |
| `[sound.events]` | `<event_name>` | bool \| float | `true` | Per-event toggle or volume override. `false` disables, `true` uses master volume, float (0.0–1.0) sets individual volume. |

Valid event names: `startup`, `window.create`, `window.close`, `window.focus`, `window.maximize`, `window.restore`, `window.pin`, `window.unpin`, `mode.enter`, `mode.exit`, `quick_terminal.show`, `quick_terminal.hide`, `workspace.switch`, `command_palette.open`, `command_palette.close`, `command_palette.execute`, `hint.activate`, `hint.select`, `hint.cancel`, `layout.toggle`, `swap.complete`, `resize.step`, `move.step`, `terminal.bell`, `terminal.exit`, `tab.create`, `tab.close`, `tab.switch`, `tab.move`, `pane.split`, `pane.close`, `pane.focus`, `keypress`.

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
| `[visual]` | `perspective_tilt_x` | float | `2.0` | X-axis (top/bottom) tilt in degrees for 3D layer separation. 0 = no tilt. Recommended: 1–6. The old name `perspective_tilt` is accepted as an alias |
| `[visual]` | `perspective_tilt_y` | float | `0.0` | Y-axis (left/right) tilt in degrees. 0 = no tilt |
| `[visual]` | `opacity` | float | `0.5` | Screen opacity (0.0 = fully transparent, 1.0 = fully opaque): the alpha of the terminal and Quick Terminal screens. Overrides the theme's backdrop alpha. Plates (titlebar, tab bar, footers, panels, overlays) keep their own 0.9 / 0.94 alpha ([spec 366](./0366-console-faceplate-ui.md)). Under a light-scheme theme the effective value is at least 0.94 ([spec 321](./0321-light-scheme-legibility.md)). Diff View (dark scheme) lets this show through the code surface. |
| `[visual]` | `glow_intensity` | float | `0.8` | Top-line glow brightness boost. 0.0 disables the glow, higher = stronger. Clamped to 0.0–3.0. |
| `[visual]` | `window_border` | bool | `true` | Show the window's 1px bezel edge and, when focused, its accent ring. `false` makes both transparent, so window geometry is unchanged; plates, screen and LEDs stay. The Quick Terminal overlay keeps its own chrome. |
| `[visual]` | `progress_gauge_working` | bool | `true` | Show the centre progress ring while a program reports busy (OSC 9;4 state `3`, label `working`). `false` hides only that ring: percent, error and paused rings and the titlebar progress lamp still show. Hot-reloadable. See [spec 364](./0364-progress-gauge-hide-working.md) |
| `[visual]` | `blur` | int | `12` | Reserved — parsed, not applied |

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
| `[quick_terminal]` | `backdrop_blur` | int | `20` | Reserved — parsed, not applied |

### Workspace Configuration

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `[workspaces]` | `startup` | string | `"single"` | Reserved — parsed, not applied |
| `[workspaces]` | `default_layout` | string | `"focus"` | Default layout mode: `"grid"`, `"focus"`, `"depth"`, `"scroll"`, `"stage"`, or `"wheel"` |
| `[workspaces.scroll]` | `default_column_width` | float | `0.5` | New-column width as a fraction of the usable viewport (Scroll layout) |
| `[workspaces.scroll]` | `default_window_height` | float | `1.0` | New-window height as a fraction of the usable viewport (Scroll layout). `1.0` fills the column; smaller values top-align and leave empty space below. Clamped to `0.15`–`1.0`. Live: Resize `↓`/`↑`. |
| `[workspaces.scroll]` | `preset_column_widths` | float[] | `[0.33333, 0.5, 0.66667]` | Widths cycled by `Leader =` in Scroll |
| `[workspaces.scroll]` | `center_focused_column` | string | `"always"` | Camera: `"always"` keeps the focused column in the horizontal center of the screen; `"never"` snaps it to the near edge; `"on-overflow"` centers only when the previous and focused columns cannot both fit |
| `[workspaces.scroll]` | `always_center_single_column` | bool | `true` | Center a lone column regardless of `center_focused_column` |
| `[workspaces]` | `gap` | int | `6` | Pixel space between tiled windows. Also the workspace edge inset in **Grid**, **Scroll**, and **Stage**; Stage also uses it between recent-window previews. Clamped to `0`–`64`. Applies on **Reload Config** — no restart. **Depth** ignores it (ratio-centered), as does a lone Grid window. |
| `[workspaces]` | `padding` | int | `0` | Reserved — parsed but not yet applied. Use `gap` for both window spacing and the workspace edge inset. |
| `[workspaces]` | `resize_step` | int | `20` | Pixels per arrow key press in resize mode; also the split-divider step for `Shift+H/J/K/L` (spec 296) |
| `[workspaces]` | `move_step` | int | `20` | Pixels per arrow key press in move mode |
| `[workspaces]` | `resize_step_large` | int | `100` | Pixels per Shift+Arrow in resize mode |
| `[workspaces]` | `move_step_large` | int | `100` | Pixels per Shift+Arrow in move mode |

---

## Terminal Control Monitor Environment

The read-only Terminal Control monitor has no TOML settings. It accepts two
optional environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TERMCTRL_BINARY` | Auto-detect | Absolute path or executable name for the `termctrl` CLI |
| `TERMCTRL_RUNTIME_DIR` | Terminal Control default | Existing Terminal Control runtime-directory override, forwarded unchanged |

Binary auto-detection checks the process `PATH`, the cached login-shell `PATH`,
`~/.cargo/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`. This keeps Finder or
Spotlight launches working on macOS even when the GUI process receives a sparse
environment. The monitor is opened through `#termctrl` or the command palette;
it does not require a configuration entry.

## Load Behavior

Krypton reads `krypton.toml` at startup and again on the palette's **Reload Config** (there is no filesystem watcher). It never writes the file except as described below.

- **Missing file**: Krypton runs on built-in defaults and does not create the file.
- **Missing keys**: every section and key is optional and takes its default independently. The exceptions are array entries: `[[agent.models]]` requires every key except `vision`, and `[[hints.rules]]` requires `name`, `regex` and `action`.
- **Unknown sections and keys** are ignored, so a retired section such as `[typesafe]` (or a `[keybindings]` table) still loads.
- **Parse error** (invalid TOML, a wrong value type, a missing required key): at startup Krypton logs the error and runs on built-in defaults for every section; on **Reload Config** it reports the error and keeps the config already loaded. The file is left untouched in both cases.
- **The only write**: the palette's **Color Theme** action (`set_theme`) rewrites the `[theme] name` line in place. Comments and other sections are kept, and nothing is written when the file does not exist. Other runtime changes (the agent's active preset, a directory opened in the music player) live in memory only.

## [hurl]

Configure the built-in Hurl client window.

```toml
[hurl]
# Absolute path to the `hurl` binary. Leave unset to auto-detect from PATH
# (falls back to a login shell lookup on macOS GUI launches).
binary_path = "/opt/homebrew/bin/hurl"
```

The in-app Hurl client is opened via `Leader q` or the command palette ("Open Hurl Client"). The OS-browser client is opened via **Open Hurl Web Client** or harness `#hurl`. Both index every `.hurl` file under the focused terminal cwd (gitignore-aware) and run the selected file with `--color --pretty --include`. `[hurl].binary_path` feeds both surfaces. Extra CLI args from config are honored only in-app. Folder expand/collapse, last file, env, and verbose flags are shared in `<app_cache_dir>/hurl/state/<sha256(cwd)>.json`, not in this TOML. See `docs/0065-hurl-client-window.md` and `docs/0227-hurl-web-client.md`.

## [pencil]

Configure the Pencil window — an in-app `.excalidraw` editor backed by `@excalidraw/excalidraw`.

```toml
[pencil]
# Directory scanned by the Pencil picker (`Leader e`). Tilde-expanded.
# If empty, the picker shows a notification; absolute paths can still be
# opened programmatically (and, in future, via quick-file-search routing).
dir = "~/Documents/excalidraw"
```

The picker recursively lists `*.excalidraw` files under `dir`, sorted by modification time (newest first), with a synthetic "+ New drawing" row at the top that prompts for a file name. Press `r` on an existing row to rename it without leaving the picker. When a Pencil view is focused, local leader `/` opens an existing drawing in the current Pencil tab and local leader `?` prompts for a new drawing in the current file's directory. Opening the same file twice through the global picker refocuses the existing tab. Saving is autosave-on-change (800 ms debounced) plus `Cmd+S` for an immediate flush — writes are atomic via `<path>.tmp` + rename. Theme follows Krypton's background luminance. See `docs/0071-pencil-window.md` for the full design.

## [tokens] (theme files)

Lives in a theme file under `~/.config/krypton/themes/*.toml`, not in `krypton.toml`. Each entry becomes a `--<key>` CSS custom property on `document.documentElement`, which is how a theme recolours one component (the `--acp-*` harness hooks, the `--mat-*` material stops, …) without shipping CSS.

```toml
# ~/.config/krypton/themes/amber-tools.toml
[tokens]
"acp-tool-head-fg"      = "#ffd27f"
"acp-tool-output-max-h" = "420px"
"acp-peek-accent"       = "var(--agent-cyan)"
```

| Rule | Value |
|------|-------|
| Key charset | `^[a-z][a-z0-9-]{0,63}$`, applied as `--<key>` |
| Value length | 256 characters max |
| Value functions | Allowlist checked after CSS-unescaping and lowercasing: `var rgb rgba hsl hsla color-mix color oklch lab calc clamp min max env`. Everything else — `url()`, `image()`, `image-set()`, `-webkit-image-set()`, `cross-fade()`, `element()`, `expression()`, `attr()` — is rejected, so a theme can never fetch. |
| Unknown key | Applied and inert; a theme written for a newer Krypton still loads on an older one |
| Namespace convention | `acp-*` harness, `vault-*` vault, `krypton-*` global. Documented, not enforced. |
| Precedence | After every built-in property (so `"agent-text"` beats the derived one), before per-element `style.setProperty`, which still wins |

Entries that fail these rules are dropped individually with a `theme token rejected: <key>` warning and the rest of the theme still loads. Tokens apply live through **Color Theme** and **Reload Config**. See `docs/0010-theme-specification.md` and `docs/0303-themeable-component-tokens.md`.

`krypton-fire-low`, `krypton-fire-mid` and `krypton-fire-hot` recolour the program-status fire (doc 0362); any colour the allowlist accepts works, including `oklch()` and `color-mix()`. A `low`/`mid`/`hot` key in `[fire]` or `[fire.<state>]` of `krypton.toml` outranks these tokens (doc 0363).
