# Claude Code Hook Support — Implementation Spec

> Status: Implemented
> Date: 2026-03-21
> Milestone: N/A — New feature

## Problem

When Claude Code runs inside a Krypton terminal, its hook events (tool approvals, notifications, session lifecycle) are invisible to the terminal emulator. Users have no native way to see what Claude is doing, approve/deny tool use, or get notifications outside the terminal output stream.

## Solution

Krypton runs a lightweight HTTP server on localhost that receives Claude Code hook events. The user configures Claude Code's `settings.json` to use HTTP hooks pointing at Krypton's endpoint. When hook events arrive, Krypton emits Tauri events to the frontend, which renders contextual UI (status badges, notification toasts, tool approval widgets) in the terminal window chrome.

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
| `src/styles.css` | Hook UI styles (toast, badge, approval widget) |

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

Five UI elements, all managed by `ClaudeHookManager` in `claude-hooks.ts`:

| # | Element | Location | CSS class |
|---|---------|----------|-----------|
| 1 | **Sigil Badge** | Titlebar, left (after status dot) | `.krypton-claude-badge` |
| 2 | **Tool Execution HUD** | Titlebar, right side | `.krypton-claude-tool` |
| 3 | **Neural Uplink Bar** | Bottom edge of `.krypton-window__content` | `.krypton-uplink` |
| 4 | **Activity Trace** | Right edge of `.krypton-window__content` | `.krypton-activity-trace` |
| 5 | **Intercept Toast** | Fixed, bottom-right of viewport | `.krypton-claude-toast` |

Additionally, `ClaudeHookManager.formatTerminalTitle()` rewrites Claude Code's OSC 0/2 terminal titles into cyberpunk labels (e.g., `NEW CODING SESSION` → `◈ neural_link // online`). This is called from compositor's `onTitleChange` handler but the logic lives in `claude-hooks.ts`.

### Event → UI Mapping

Each hook event triggers specific changes across the five UI elements. This is the authoritative reference for what happens visually when each event fires.

#### `SessionStart`

| Element | Change |
|---------|--------|
| Sigil Badge | Adds `--active` → glows accent color with halo `text-shadow` |
| Neural Uplink Bar | Adds `--active` → fades in as solid accent strip at 40% opacity |
| Tool HUD | No change |
| Activity Trace | No change |
| Toast | `SESSION` label (green) — "Session started" |
| Terminal Title | Claude Code sets OSC 2 title → `formatTerminalTitle()` rewrites it (e.g., `◈ neural_link // online`) |

#### `PreToolUse`

| Element | Change |
|---------|--------|
| Sigil Badge | Adds `--working` → sonar-ping animation (`krypton-sigil-ping`, 1.5s cycle) |
| Neural Uplink Bar | Adds `--working` → dual-pulse gradient scrolls left-to-right. Adds `--fast` for Bash/Edit/Write/NotebookEdit (0.9s vs 1.8s animation) |
| Tool HUD | Decode animation: 6 frames of glitch chars (`░▒▓█▀▄▌▐`) resolve over ~180ms into `▸ <tool> ← <target>`. Target shows abbreviated file path, truncated command, or pattern. Cancels any pending clear timer from a previous PostToolUse |
| Activity Trace | New tick appended at bottom, colored by tool type: cyan (Edit/Write), amber (Bash), dim cyan (Read/Glob/Grep). Tick fades to invisible over 30s, then removed. Max 20 ticks |
| Toast | `TOOL` label (cyan) — "`<tool> ← <detail>`" |

#### `PostToolUse`

| Element | Change |
|---------|--------|
| Sigil Badge | Removes `--working` if no other session has an active tool |
| Neural Uplink Bar | Removes `--working`, returns to `--active` (solid strip). If tool response contains error: flashes `--error` (red, 2 blinks over 600ms), then returns to `--active` |
| Tool HUD | Holds current text for **1.5 seconds**. Then glitch-out animation (2 frames of increasing garble) and hides. If a new PreToolUse arrives during the hold, the clear is cancelled and new tool text decodes in immediately |
| Activity Trace | If tool had error: additional red tick added |
| Toast | Success: `DONE` label (dim cyan) — "`<tool> done`". Error: `ERROR` label (red) — "`<tool> failed`" |

#### `Notification`

| Element | Change |
|---------|--------|
| Sigil Badge | No change |
| Neural Uplink Bar | No change |
| Tool HUD | No change |
| Activity Trace | No change |
| Toast | `CLAUDE` label (amber) for general, `PERMIT` (amber, brighter) for permission prompts, `ERROR` (red) for errors, `OK` (green) for success |

#### `Stop`

| Element | Change |
|---------|--------|
| Sigil Badge | Brief bright flash (keeps `--active` for 2s), then removes `--active` → fades to dormant (15% ghost) |
| Neural Uplink Bar | Removes all modifiers → fades to invisible (`opacity: 0`) |
| Tool HUD | Cleared if visible |
| Activity Trace | No change (existing ticks continue fading naturally) |
| Toast | `STOP` label (magenta) — "Session ended" |
| Terminal Title | Claude Code may set a final OSC 2 title → `formatTerminalTitle()` rewrites it (e.g., `◈ signal_end // done`) |

#### `InstructionsLoaded`

| Element | Change |
|---------|--------|
| Toast | `LOAD` label (dim green) — "Loaded `<abbreviated path>`" |

#### `UserPromptSubmit`

| Element | Change |
|---------|--------|
| Sigil Badge | Session marked active |
| Toast | `PROMPT` label (blue) — "Prompt submitted" |

#### `PermissionRequest`

| Element | Change |
|---------|--------|
| Toast | `PERMIT` label (amber, bright) — "Permission: `<tool_name>`" |

#### `PostToolUseFailure`

| Element | Change |
|---------|--------|
| Neural Uplink Bar | Flashes `--error` (red, 2 blinks over 600ms) |
| Activity Trace | Red error tick added |
| Toast | `ERROR` label (red) — "`<tool> failed — <error>`" |

#### `SubagentStart`

| Element | Change |
|---------|--------|
| Activity Trace | Edit tick added |
| Toast | `AGENT` label (violet) — "Spawned `<subagent_type>`" |

#### `SubagentStop`

| Element | Change |
|---------|--------|
| Toast | `AGENT` label (dim violet) — "`<subagent_type>` finished" |

#### `StopFailure`

| Element | Change |
|---------|--------|
| Neural Uplink Bar | Flashes `--error` |
| Toast | `ERROR` label (red) — "`<error detail>`" |

#### `TeammateIdle`

| Element | Change |
|---------|--------|
| Toast | `TEAM` label (teal) — "Teammate idle" |

#### `TaskCompleted`

| Element | Change |
|---------|--------|
| Toast | `TASK` label (green) — "✓ `<task_subject>`" |

#### `ConfigChange`

| Element | Change |
|---------|--------|
| Toast | `CONFIG` label (dim amber) — "Config: `<config_key>`" |

#### `WorktreeCreate`

| Element | Change |
|---------|--------|
| Toast | `TREE` label (dim cyan) — "Worktree: `<abbreviated path>`" |

#### `WorktreeRemove`

| Element | Change |
|---------|--------|
| Toast | `TREE` label (dim cyan) — "Removed `<abbreviated path>`" |

#### `PreCompact`

| Element | Change |
|---------|--------|
| Toast | `COMPACT` label (dim magenta) — "Compacting context…" |

#### `PostCompact`

| Element | Change |
|---------|--------|
| Toast | `COMPACT` label (dim magenta) — "Context compacted" |

#### `Elicitation`

| Element | Change |
|---------|--------|
| Toast | `INPUT` label (amber, bright) — "Input requested" |

#### `ElicitationResult`

| Element | Change |
|---------|--------|
| Toast | `INPUT` label (amber, bright) — "Input received" |

#### `SessionEnd`

| Element | Change |
|---------|--------|
| Sigil Badge | Session marked inactive, bright flash then fade to dormant |
| Neural Uplink Bar | Fades to invisible |
| Toast | `STOP` label (magenta) — "Session terminated" |

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

#### 5. Intercept Toast (persistent stack)

Fixed-position panel stack at bottom-right of viewport. **All events** produce toasts. Toasts are **persistent** — no auto-dismiss. User clicks toast or `×` button to dismiss.

- Entrance: `translateX(20px) → 0` over 300ms + `::after` scan-line (2px accent, sweeps top→bottom over 400ms)
- Body: `rgba(6,10,18,0.92)`, 1px accent border, 3px solid left stripe colored by type
- Label: uppercase bordered chip, text varies by event type (SESSION, TOOL, DONE, CLAUDE, PERMIT, ERROR, OK, STOP)
- Close button: `×` glyph at right edge, dim by default, brightens on hover
- Stack: `column-reverse`, 4px gap, scrollable up to 80vh with manual scroll. No cap on count
- Type styles:

| Type | Label | Left stripe / border color |
|------|-------|---------------------------|
| `--session` | SESSION | green (`#50dc64`) |
| `--tool` | TOOL | accent/cyan |
| `--tool_done` | DONE | dim cyan (35% opacity) |
| `--notification` | CLAUDE | amber (`#fac863`) |
| `--permission_prompt` | PERMIT | amber (brighter) |
| `--error` | ERROR | red (`#ff5050`) |
| `--success` | OK | green |
| `--stop` | STOP | magenta (`#c864ff`) |
| `--instructions` | LOAD | dim green (35% opacity) |
| `--prompt` | PROMPT | blue (`#64a0ff`) |
| `--subagent` | AGENT | violet (`#a078ff`) |
| `--subagent_done` | AGENT | dim violet (35% opacity) |
| `--teammate` | TEAM | teal (`#50c8b4`) |
| `--task` | TASK | green (`#50dc64`) |
| `--config` | CONFIG | dim amber |
| `--worktree` | TREE | dim cyan |
| `--compact` | COMPACT | dim magenta (35% opacity) |
| `--elicitation` | INPUT | amber (bright) |

### Configuration

```toml
[hooks]
# Enable the HTTP hook server for Claude Code integration
enabled = true
# Port to listen on (0 = auto-assign available port)
port = 0
```

### Keybindings

No new keybindings in phase 1. Future: compositor key to open Claude Code dashboard.

## Edge Cases

1. **Port conflict** — port 0 (default) lets the OS assign an available port, avoiding conflicts. If a specific port is configured and busy, log error and disable hooks.
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
