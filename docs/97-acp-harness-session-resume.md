# ACP Harness Session List and Resume — Implementation Spec

> Status: Implemented
> Date: 2026-05-08
> Milestone: M-ACP — Harness convergence

## Problem

ACP adapters can keep durable conversation sessions, but Krypton's harness can only create fresh sessions (`session/new`). Users cannot inspect project-scoped agent history or resume a previous ACP session from inside the harness.

## Solution

Add a keyboard-first ACP session picker to the harness. When a lane is active, the picker uses that lane's backend automatically, initializes a short-lived probe for the same backend, calls `session/list` with the harness `projectDir`, and starts a new harness lane from the selected session using `session/resume` when available or `session/load` as a fallback. If no lane is active, or the user explicitly switches backend inside the picker, the existing backend list is used as a fallback. The feature is capability-gated per backend and never assumes `session/list` implies resumability.

## Research

- ACP session lifecycle is capability-gated. `session/list` is advertised as `agentCapabilities.sessionCapabilities.list`; `session/resume` is `agentCapabilities.sessionCapabilities.resume`; `session/load` is still the top-level `agentCapabilities.loadSession`.
- ACP `session/list` accepts `cwd` and pagination cursor, and returns `SessionInfo[]` with `sessionId`, `cwd`, `title`, and `updatedAt`.
- ACP `session/resume` reconnects to an existing session without replaying history; `session/load` restores the session and streams previous conversation history back through `session/update`.
- Current Krypton flow already split initialization for Spec 83: `AcpClient.initialize()` calls `acp_initialize`, computes capability-gated MCP servers, calls `acp_set_mcp_servers`, then calls `acp_session_new`.
- `src-tauri/src/acp.rs` previously had no commands for `session/list`, `session/resume`, or `session/load`, but it already stored `cwd`, `mcp_servers`, and `acp_session_id` on the backend client.
- Harness lanes already know their `backendId`. Using the active lane's backend as the default avoids an unnecessary picker step and matches the user's current working context.
- Harness lanes currently use `#new`/`#restart` for fresh replacement. Resuming should create a new lane instead of replacing the active one, so history comparison remains explicit.
- Probing all installed backends just to populate a global history view would spawn multiple adapters and possibly run login/setup logic. V1 should initialize only the active backend by default, with an explicit backend-switch fallback.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Zed Agent Panel | Threads are grouped by project; thread history can restore archived threads. External-agent support varies by agent capability. | Closest UX model for project-scoped multi-agent work. |
| VS Code Copilot Chat | Sessions list is scoped to the workspace and supports opening/resuming sessions; CLI sessions can be resumed in terminal. | Confirms workspace-scoped history is expected. |
| Claude Code | Sessions are tied to project directories and can be resumed via `--resume`, `--continue`, or an interactive `/resume` picker. | Strong precedent for cwd-scoped agent session lists. |
| ACP schema | `session/list`, `session/resume`, and `session/load` are separate capabilities. | Krypton must gate actions independently. |

**Krypton delta** — Match project-scoped history and explicit resume actions. Diverge by keeping the flow inside the ACP Harness local leader model: `Cmd+P` actions, no mouse dependency, active-lane backend inference by default, no automatic multi-backend probing, and resumed sessions appear as normal lanes beside fresh lanes.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `acp_session_list`, `acp_session_resume`, and `acp_session_load`; share cwd/MCP payload construction with `acp_session_new`; set `acp_session_id` after resume/load. |
| `src-tauri/src/lib.rs` | Register the new Tauri commands. |
| `src/acp/types.ts` | Add session capability and `AcpSessionInfo` / list response types. |
| `src/acp/client.ts` | Add initialize-only/session-start methods and wrappers for list/resume/load. |
| `src/acp/acp-harness-view.ts` | Add local leader key, session picker state, backend/session selection flow, and lane creation from resumed/loaded sessions. |
| `src/styles/acp-harness.css` | Style the session picker using existing harness overlay primitives. |
| `src/leader-keys.test.ts` | Validate the new local leader key does not conflict. |
| `docs/04-architecture.md` | Document harness session resume architecture. |
| `docs/05-data-flow.md` | Add data flow for session listing and resume/load. |
| `docs/72-acp-harness-view.md` | Update harness behavior and keybindings. |
| `docs/PROGRESS.md` | Add Recent Landings entry after implementation. |

## Design

### Data Structures

```ts
export interface AcpSessionCapabilities {
  canList: boolean;
  canResume: boolean;
  canLoad: boolean;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface AcpSessionListResult {
  sessions: AcpSessionInfo[];
  nextCursor?: string | null;
}

type AcpSessionStartMode = 'new' | 'resume' | 'load';
```

Harness session picker state:

```ts
interface SessionPickerState {
  open: boolean;
  phase: 'sessions' | 'backend' | 'loading' | 'error';
  backendCursor: number;
  sessionCursor: number;
  backendId: string | null;
  probeClient: AcpClient | null;
  capabilities: AcpSessionCapabilities | null;
  sessions: AcpSessionInfo[];
  nextCursor: string | null;
  error: string | null;
}
```

### API / Commands

Rust Tauri commands:

```rust
acp_session_list(session: u64, cwd: Option<String>, cursor: Option<String>)
  -> Result<Value, String>

acp_session_resume(session: u64, session_id: String)
  -> Result<AgentSessionInfo, String>

acp_session_load(session: u64, session_id: String)
  -> Result<AgentSessionInfo, String>
```

Frontend client methods:

```ts
initializeOnly(): Promise<AgentInitInfo>;
setMcpServers(mcpServers: AcpMcpServerDescriptor[]): Promise<void>;
sessionNew(): Promise<AgentSessionInfo>;
listSessions(cwd: string, cursor?: string | null): Promise<AcpSessionListResult>;
resumeSession(sessionId: string): Promise<AgentSessionInfo>;
loadSession(sessionId: string): Promise<AgentSessionInfo>;
```

`AcpClient.initialize(onInitialized)` remains as the existing convenience path for fresh sessions.

### Data Flow

```
1. User presses Cmd+P then 0 in the ACP Harness.
2. If an active lane exists, Harness chooses `activeLane.backendId` and opens the session picker directly in loading/session phase.
3. If no lane exists, Harness opens backend phase using installed backends already loaded for the lane picker.
4. Harness spawns a probe client for the chosen backend and calls initializeOnly().
5. Harness derives capabilities from agentCapabilities:
   - canList = Boolean(sessionCapabilities.list)
   - canResume = Boolean(sessionCapabilities.resume)
   - canLoad = Boolean(loadSession)
6. If canList is false, picker shows "session list unsupported" and disposes the probe client.
7. Harness computes the same capability-gated MCP server list used for fresh lanes, calls setMcpServers(), then calls listSessions(projectDir).
8. Picker filters results to projectDir when returned `cwd` is present and renders title / updatedAt / short session id.
9. User selects a session. Pressing `b` switches to backend phase if they want a different backend.
10. If canResume, call session/resume. Else if canLoad, call session/load. Else show disabled "cannot resume".
11. Harness creates a new lane for the selected backend using the already-initialized probe client before sending resume/load.
12. Harness attaches the lane event listener, sends the same capability-gated MCP server list used by fresh lanes, then calls `session/resume` or `session/load`.
13. Lane transcript starts with a system row: `resuming <sessionId>` or `loading <sessionId>`.
14. For session/load, replayed history arrives as normal session/update events while the request is pending, then the lane returns idle after the request resolves.
15. Closing/cancelling the picker before step 10 disposes the probe client.
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+P` then `0` | ACP Harness | Open ACP session picker |
| `j` / `k`, arrows | Session picker | Move cursor |
| `Enter` | Backend phase | Initialize selected backend and list sessions |
| `Enter` | Session phase | Resume/load selected session when supported |
| `b` | Session phase | Switch backend |
| `n` | Session picker | Spawn a fresh lane for selected backend instead |
| `PageDown` | Session phase with `nextCursor` | Fetch next page |
| `Esc` | Session picker | Cancel and dispose probe client |

`0` is chosen because the current local harness keys are `+`, `_`, and `=`, and global leader reserves `1-9` but not `0`.

### UI Changes

Add a new overlay class family reusing the existing picker visual language:

```css
.acp-harness__session-picker
.acp-harness__session-row
.acp-harness__session-row--active
.acp-harness__session-meta
.acp-harness__session-action
```

Session phase header shows the active backend label and `b switch backend`. Rows show title (or `untitled session`), relative updated time, cwd suffix if it differs from `projectDir`, and short session id. Rows that cannot be opened because neither resume nor load is available render disabled. Backend phase rows show backend label, backend id, and running-lane count.

### Configuration

No TOML configuration in v1.

## Edge Cases

- **Backend does not support `session/list`:** show an inline unsupported state and keep the backend selectable for fresh lane spawn via `n`.
- **No active lane exists:** open backend phase first, matching the existing Add Lane picker mental model.
- **User wants a different backend than active lane:** press `b` in the session picker to choose another backend explicitly.
- **Backend lists sessions but cannot resume/load:** render rows disabled with `list only`; do not call resume/load.
- **`session/resume` fails despite capability:** the new lane moves to `error` and records the failure in its transcript. Do not fallback to `load` unless resume is unsupported; a resume failure may indicate session corruption or auth issues.
- **`session/load` replays large history:** treat the lane as `starting` during load, append replayed events through the normal transcript path, and rely on existing render batching/scroll anchoring. Do not virtualize history in this spec.
- **Returned sessions include other cwd values:** pass `cwd: projectDir` to `session/list`; also filter client-side when `cwd` is present and differs after normalization.
- **Pagination:** v1 supports manual `PageDown` loading via `nextCursor`; no infinite scroll.
- **MCP bridge/memory:** resume/load sends the same `.mcp.json` bridge and `krypton-harness-memory` server descriptors as fresh lanes. Pi-1 remains unable to use MCP and keeps its existing no-memory behavior.
- **OpenCode default model:** apply default model only for fresh `session/new`. Do not force `session/set_config_option` on resumed/loaded historical sessions.
- **User cancels picker while backend is initializing/listing:** dispose the probe client and ignore late events using the existing disposed-event guard pattern.

## Open Questions

None.

## Out of Scope

- Generic ACP `session/close`.
- Resume by manually typing a session id when `session/list` is unavailable.
- Forking/branching sessions.
- Deleting/archiving sessions.
- Persisting ACP transcript history inside Krypton.
- Real transcript virtualization for huge loaded histories.
- Automatic probing of every installed backend on harness open.

## Resources

- [ACP Session List](https://agentclientprotocol.com/protocol/session-list) — `session/list` purpose, `cwd` filter, and pagination model.
- [ACP Schema](https://agentclientprotocol.com/protocol/schema) — exact request/response shapes for `session/list`, `session/load`, `session/resume`, and capability flags.
- [ACP Updates](https://agentclientprotocol.com/updates) — session list/resume are stabilized protocol features as of April 2026.
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) — thread history and project-scoped multi-agent UX.
- [VS Code chat sessions](https://code.visualstudio.com/docs/copilot/chat/chat-sessions) — workspace-scoped sessions list and session management UX.
- [GitHub Copilot CLI sessions in VS Code](https://docs.github.com/en/copilot/how-tos/copilot-cli/connecting-vscode) — listing and resuming CLI sessions from the current workspace.
- [Claude Code sessions](https://code.claude.com/docs/en/sessions) — project-tied local sessions and resume picker precedent.
- Internal: `docs/69-acp-agent-support.md`, `docs/72-acp-harness-view.md`, `docs/83-acp-shared-mcp-config.md`, `src/acp/client.ts`, `src/acp/acp-harness-view.ts`, `src-tauri/src/acp.rs`.
