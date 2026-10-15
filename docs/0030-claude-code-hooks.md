# Claude Code Hook Support — Implementation Spec

> Status: Implemented (hook toast stack removed 2026-10-15; the notification
> overlay that briefly carried the messages was removed the same day — hook
> event text is no longer surfaced anywhere)
> Date: 2026-03-21
> Milestone: N/A — New feature

## Problem

When Claude Code runs inside a Krypton terminal, its hook events (tool approvals, notifications, session lifecycle) are invisible to the terminal emulator. Users have no native way to see what Claude is doing, approve/deny tool use, or get notifications outside the terminal output stream.

## Solution

Krypton runs a lightweight HTTP server on localhost that receives Claude Code hook events. The user configures Claude Code's `settings.json` to use HTTP hooks pointing at Krypton's endpoint. When hook events arrive, Krypton emits Tauri events to the frontend, which renders contextual UI (status badge, tool HUD, uplink bar, activity trace) in the terminal window chrome. The event message text itself is not displayed; events with no chrome effect are logged to the console.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `axum`, `tokio` dependencies |
| `src-tauri/src/hook_server.rs` | New — HTTP server, request parsing, event emission |
| `src-tauri/src/lib.rs` | Register hook server state, start server in setup, add commands |
| `src-tauri/src/commands.rs` | Add `get_hook_server_port`, `configure_claude_hooks` commands |
| `src-tauri/src/config.rs` | Add `[hooks]` config section |
| `src/claude-hooks.ts` | New — frontend listener for hook events, UI rendering |
| `src/compositor.ts` | Integrate hook status badge into window chrome |
| `src/types.ts` | Add hook-related types |
| `src/main.ts` | Initialize claude-hooks module |
| `src/styles/hooks.css` | Hook UI styles (badge, tool HUD, uplink, activity trace) |

## Design

### Data Structures

**Rust (hook_server.rs):**

```rust
/// Hook event received from Claude Code via HTTP POST
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeHookEvent {
    pub session_id: String,
    pub hook_event_name: String,
    pub cwd: Option<String>,
    pub permission_mode: Option<String>,
    // Event-specific fields stored as raw JSON
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

/// State for the HTTP hook server
pub struct HookServer {
    pub port: u16,
    pub shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}
```

**Rust (config.rs):**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksConfig {
    /// Enable the HTTP hook server (default: true)
    pub enabled: bool,
    /// Port to listen on (default: 0 = auto-assign)
    pub port: u16,
}
```

**TypeScript (types.ts):**

```typescript
export interface ClaudeHookEvent {
  hookEventName: string;
  sessionId: string;
  cwd?: string;
  permissionMode?: string;
  // PreToolUse
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // Notification
  message?: string;
  title?: string;
  notificationType?: string;
  // Stop
  lastAssistantMessage?: string;
}
```

### API / Commands

**New Tauri commands:**

```rust
#[tauri::command]
fn get_hook_server_port(state: State<'_, Arc<HookServer>>) -> Result<u16, String>

#[tauri::command]
fn get_hook_server_config_snippet(state: State<'_, Arc<HookServer>>) -> Result<String, String>
// Returns JSON snippet users can paste into Claude Code settings.json
```

**New Tauri events:**

- `claude-hook` — emitted when any hook event arrives. Payload: `ClaudeHookEvent`

**HTTP endpoint:**

```
POST http://localhost:{port}/hook
Content-Type: application/json
Body: Claude Code hook JSON (stdin format)

Response: 200 OK with empty JSON {} (accept all events, no blocking)
```

Phase 1 is observe-only — the server always returns `200 {}`, meaning it never blocks Claude Code's actions. Future phases can add approval UI that holds the HTTP response until the user decides.

### Data Flow

**Setup:**
```
1. Tauri app starts
2. lib.rs reads hooks config (enabled, port)
3. If enabled, spawns tokio runtime on dedicated thread
4. axum server binds to 127.0.0.1:{port} (port 0 = OS-assigned)
5. Actual port stored in HookServer state
6. Server logs: "Claude Code hook server listening on port {port}"
```

**Hook event flow:**
```
1. Claude Code (in PTY) triggers a hook event (e.g., PreToolUse)
2. Claude Code HTTP-POSTs JSON to http://localhost:{port}/hook
3. axum handler deserializes ClaudeHookEvent
4. Handler emits Tauri event "claude-hook" with the payload
5. Handler responds 200 {} immediately
6. Frontend claude-hooks.ts listener receives event
7. Based on hookEventName, updates UI elements (see event→UI table below)
```

**User setup:**
```
1. User runs get_hook_server_config_snippet command (via command palette)
2. Krypton returns JSON snippet for Claude Code settings.json
3. User pastes into ~/.claude/settings.json
4. Claude Code picks up hooks config on next session
```

### UI Elements

All UI uses existing cyberpunk HUD aesthetic (`--krypton-*` CSS custom properties, BEM classes). No `backdrop-filter`. Animations via WAAPI or CSS keyframes at 60 FPS.

```
┌─── titlebar ─────────────────────────────────────────┐
│ ● ◈ ◈ neural_link // online    ▸ Edit ← main.ts  ~/ │
│    ↑                            ↑                     │
│    sigil badge                  tool execution HUD    │
├───────────────────────────────────────────────────────┤
│                                                    ║  │
│              terminal content                      ║  │ ← activity trace (right edge)
│                                                    ║  │
│═══════════════════════════════════════════════════════│ ← neural uplink bar (bottom edge)
└───────────────────────────────────────────────────────┘
                                  ┌──────────────────────┐
                                  │ ▌SESSION▐ Started   ×│ ← persistent toast stack
                                  │ ▌TOOL▐   Edit ← f  ×│    (click to dismiss)
                                  │ ▌DONE▐   Edit done  ×│
                                  └──────────────────────┘
```

Four UI elements, all managed by `ClaudeHookManager` in `claude-hooks.ts`:

| # | Element | Location | CSS class |
|---|---------|----------|-----------|
| 1 | **Sigil Badge** | Titlebar, left (after status dot) | `.krypton-claude-badge` |
| 2 | **Tool Execution HUD** | Titlebar, right side | `.krypton-claude-tool` |
| 3 | **Neural Uplink Bar** | Bottom edge of `.krypton-window__content` | `.krypton-uplink` |
| 4 | **Activity Trace** | Right edge of `.krypton-window__content` | `.krypton-activity-trace` |

Additionally, `ClaudeHookManager.formatTerminalTitle()` rewrites Claude Code's OSC 0/2 terminal titles into cyberpunk labels (e.g., `NEW CODING SESSION` → `◈ neural_link // online`). This is called from compositor's `onTitleChange` handler but the logic lives in `claude-hooks.ts`.

### Event → UI Mapping

Each hook event triggers specific changes across the four UI elements. This is the authoritative reference for what happens visually when each event fires. Events whose only effect was a message (no chrome change) now just hit a `console.log`.

#### `SessionStart`

| Element | Change |
|---------|--------|
| Sigil Badge | Adds `--active` → glows accent color with halo `text-shadow` |
| Neural Uplink Bar | Adds `--active` → fades in as solid accent strip at 40% opacity |
| Tool HUD | No change |
| Activity Trace | No change |
| Terminal Title | Claude Code sets OSC 2 title → `formatTerminalTitle()` rewrites it (e.g., `◈ neural_link // online`) |

#### `PreToolUse`

| Element | Change |
|---------|--------|
| Sigil Badge | Adds `--working` → sonar-ping animation (`krypton-sigil-ping`, 1.5s cycle) |
| Neural Uplink Bar | Adds `--working` → dual-pulse gradient scrolls left-to-right. Adds `--fast` for Bash/Edit/Write/NotebookEdit (0.9s vs 1.8s animation) |
| Tool HUD | Decode animation: 6 frames of glitch chars (`░▒▓█▀▄▌▐`) resolve over ~180ms into `▸ <tool> ← <target>`. Target shows abbreviated file path, truncated command, or pattern. Cancels any pending clear timer from a previous PostToolUse |
| Activity Trace | New tick appended at bottom, colored by tool type: cyan (Edit/Write), amber (Bash), dim cyan (Read/Glob/Grep). Tick fades to invisible over 30s, then removed. Max 20 ticks |

#### `PostToolUse`

| Element | Change |
|---------|--------|
| Sigil Badge | Removes `--working` if no other session has an active tool |
| Neural Uplink Bar | Removes `--working`, returns to `--active` (solid strip). If tool response contains error: flashes `--error` (red, 2 blinks over 600ms), then returns to `--active` |
| Tool HUD | Holds current text for **1.5 seconds**. Then glitch-out animation (2 frames of increasing garble) and hides. If a new PreToolUse arrives during the hold, the clear is cancelled and new tool text decodes in immediately |
| Activity Trace | If tool had error: additional red tick added |

#### `Notification`

| Element | Change |
|---------|--------|
| Sigil Badge | No change |
| Neural Uplink Bar | No change |
| Tool HUD | No change |
| Activity Trace | No change |

#### `Stop`

| Element | Change |
|---------|--------|
| Sigil Badge | Brief bright flash (keeps `--active` for 2s), then removes `--active` → fades to dormant (15% ghost) |
| Neural Uplink Bar | Removes all modifiers → fades to invisible (`opacity: 0`) |
| Tool HUD | Cleared if visible |
| Activity Trace | No change (existing ticks continue fading naturally) |
| Terminal Title | Claude Code may set a final OSC 2 title → `formatTerminalTitle()` rewrites it (e.g., `◈ signal_end // done`) |

#### `InstructionsLoaded`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `UserPromptSubmit`

| Element | Change |
|---------|--------|
| Sigil Badge | Session marked active |

#### `PermissionRequest`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `PostToolUseFailure`

| Element | Change |
|---------|--------|
| Neural Uplink Bar | Flashes `--error` (red, 2 blinks over 600ms) |
| Activity Trace | Red error tick added |

#### `SubagentStart`

| Element | Change |
|---------|--------|
| Activity Trace | Edit tick added |

#### `SubagentStop`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `StopFailure`

| Element | Change |
|---------|--------|
| Neural Uplink Bar | Flashes `--error` |

#### `TeammateIdle`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `TaskCompleted`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `ConfigChange`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `WorktreeCreate`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `WorktreeRemove`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `PreCompact`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `PostCompact`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `Elicitation`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `ElicitationResult`

| Element | Change |
|---------|--------|
| — | No visible change; the event is logged to the console |

#### `SessionEnd`

| Element | Change |
|---------|--------|
| Sigil Badge | Session marked inactive, bright flash then fade to dormant |
| Neural Uplink Bar | Fades to invisible |

### UI Element Details

#### 1. Sigil Badge (◈)

Diamond glyph (`◈` U+25C8) in the titlebar. States:

- **Dormant:** `color: rgba(255,255,255,0.15)` — barely visible ghost
- **Active (`--active`):** accent color at 85% + double `text-shadow` halo (6px + 14px)
- **Working (`--working`):** `krypton-sigil-ping` animation — glow radiates outward (4px → 20px → 36px shadow) then contracts, 1.5s cycle

#### 2. Tool Execution HUD

Monospace readout in right side of titlebar. Format: `▸ Edit ← main.ts`

- **Decode-in:** 6 frames × 30ms. Glitch characters progressively resolve to real text (probability increases each frame). Class `--decoding` dims color to 35% during animation
- **Visible (`--visible`):** `max-width: 220px`, `opacity: 1`. Full accent color at 60%
- **Glitch-out:** 2 frames × 30ms. Characters randomly replaced, then element hidden

#### 3. Neural Uplink Bar

2px strip at bottom of terminal content area. States:

- **Hidden:** `opacity: 0` — completely invisible
- **Active (`--active`):** solid accent at 40% opacity
- **Working (`--working`):** animated gradient with two bright pulses, `background-size: 200%`, scrolls via `krypton-uplink-stream` at 1.8s/cycle
- **Fast (`--fast`):** same animation at 0.9s/cycle (for Bash/Edit/Write tools)
- **Error (`--error`):** red-orange, flashes twice via `krypton-uplink-error` (300ms × 2)

#### 4. Activity Trace

3px vertical strip on right edge. Each tool leaves a tick mark:

- Tick size: 3px × 6px with 2px gap, `border-radius: 1px`, colored `box-shadow`
- Colors: `--edit` (accent/cyan), `--bash` (amber `#f0a030`), `--read` (dim accent 30%), `--error` (red `#ff4040`)
- Fade: full opacity → 0 over 30 seconds (CSS `transition`), removed from DOM after fade
- Layout: `flex-direction: column-reverse`, newest at bottom
- Max 20 ticks; overflow removes oldest immediately

### Configuration

Since the `[loopback_server]` split (doc 0006), this section gates hook
ingestion only. The server that hosts `/hook` — and every other loopback
surface — is configured in `[loopback_server]`.

```toml
[loopback_server]
# The HTTP host serving /hook plus harness memory and the browser surfaces
enabled = true
# Port to listen on (0 = auto-assign available port)
port = 8765

[hooks]
# Accept Claude Code hook events on POST /hook (503 when false)
enabled = true
# Background animation style: "flame" | "brainwave" | "matrix" | "none"
animation = "brainwave"
```

### Keybindings / Command Palette

None. The hook toast stack and its `claude.toggle-toasts` palette action were
removed, and so was the notification overlay that briefly carried the messages;
there is no hook-message surface left to switch on or off.

## Edge Cases

1. **Port conflict** — a busy configured port falls back to an OS-assigned ephemeral port (`[loopback_server] port = 0` asks for that directly). Only a failed fallback bind disables the server; the reason is kept and surfaced by `unavailable_reason()`.
2. **Multiple Claude Code sessions** — the `session_id` field in hook events distinguishes sessions. Frontend routes events to the correct window by matching the Claude Code cwd against PTY cwd.
3. **Claude Code not running** — server idles with zero overhead. No polling.
4. **Hook server crashes** — non-fatal. Terminal continues working. Log error, set HookServer state to disabled.
5. **Large payloads** — axum body limit of 1MB. Claude Code hook payloads are small (< 10KB typically).
6. **Session-to-window mapping** — match Claude Code's `cwd` field against each PTY's working directory (`get_pty_cwd`). If no match found, broadcast to all windows or use most recently focused.

## Open Questions

None — phase 1 is observe-only with no blocking decisions required.

## Out of Scope

- **Tool approval UI** (blocking PreToolUse responses) — phase 2
- **Claude Code auto-configuration** (auto-writing to `~/.claude/settings.json`) — too invasive
- **Multi-machine support** (non-localhost HTTP) — security implications
- **WebSocket streaming** — HTTP POST per event is sufficient for Claude Code's hook model
