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
7. Based on hookEventName, renders appropriate UI:
   - PreToolUse/PostToolUse: status badge update on window chrome
   - Notification: toast overlay
   - SessionStart: badge terminal window as "Claude Code active"
   - Stop: clear active status
```

**User setup:**
```
1. User runs get_hook_server_config_snippet command (via command palette)
2. Krypton returns JSON snippet for Claude Code settings.json
3. User pastes into ~/.claude/settings.json
4. Claude Code picks up hooks config on next session
```

### UI Changes

**Status badge** — small indicator in the window titlebar (next to existing status dot) that shows when Claude Code is active in that terminal. Pulses during tool execution.

**Notification toast** — minimal overlay in the bottom-right of the window content area. Auto-dismisses after 3 seconds. Shows Claude Code notification messages.

**Tool activity indicator** — text in the titlebar showing current tool name during PreToolUse → PostToolUse lifecycle (e.g., "Edit: src/main.ts").

All UI uses existing cyberpunk styling (accent colors, BEM classes). No `backdrop-filter`.

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
