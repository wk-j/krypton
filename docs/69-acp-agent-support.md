# ACP Agent Window — Implementation Spec

> Status: Draft
> Date: 2026-04-25
> Milestone: M8 — Polish

## Problem

Krypton's built-in agent (`src/agent/`, pi-agent-core + ZAI `glm-4.7`) works well for users with a ZAI key, but users with active Claude or Gemini CLI subscriptions can't drive those agents from inside Krypton. The existing pi agent is also stable, well-tuned, and shouldn't be destabilized to bolt on a second backend.

## Solution

Add a **separate, dedicated AI agent window** that speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio JSON-RPC to a subprocess (Claude Code, Gemini CLI, or any future ACP agent). Live in a new `src/acp/` directory and a new Rust module `src-tauri/src/acp.rs`. **Do not touch `src/agent/`** — the pi-agent stays exactly as it is. Two parallel agent-window types coexist: `Leader a` opens the pi agent (unchanged), `Leader A` opens the ACP picker.

## Research

- **Transport**: stdio + newline-delimited JSON-RPC 2.0, UTF-8, no embedded newlines, stderr is for logs only.
- **Lifecycle**: `initialize` (negotiate `protocolVersion`, exchange `clientCapabilities` / `agentCapabilities`) → optional `authenticate` → `session/new` → `session/prompt` (request) with `session/update` notifications streaming back → response with `stopReason`. `session/cancel` interrupts.
- **Capabilities Krypton must advertise**: `fs.readTextFile`, `fs.writeTextFile` (true — existing Tauri commands suffice). `terminal: false` for v1.
- **Agent capabilities to honor**: `promptCapabilities.image`, `promptCapabilities.embeddedContext` (gates `@`-mention resource blocks).
- **`session/update` variants** forwarded to the frontend: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, `available_commands_update`, `current_mode_update`. The view consumes the first six; the last two are forwarded for future use. `user_message_chunk` is intentionally skipped (the user message is rendered locally on send).
- **Usage** is reported through two off-spec channels: claude-agent-acp emits `session/update { sessionUpdate: "usage_update" }` notifications mid-turn, and both claude-agent-acp and codex-acp attach a usage object to the `session/prompt` *response* (claude-agent at top-level, codex under `_meta.usage`). Krypton merges both into a single `UsageInfo` and renders it in the status line.
- **`ToolCall`** shape: `toolCallId`, `title`, `kind` (`read|edit|delete|move|search|execute|think|fetch|other`), `status` (`pending|in_progress|completed|failed`), `content[]` (text, diff `{path, oldText, newText}`, terminal), `locations[]`, `rawInput`, `rawOutput`.
- **Permission**: agent calls `session/request_permission` *on the client*, params include `ToolCall` and `options[] = PermissionOption{ optionId, name, kind ∈ allow_once|allow_always|reject_once|reject_always }`; response is `{ outcome: { outcome: "selected"|"cancelled", optionId? } }`. Critical: this is a JSON-RPC **request** initiated by the agent, not a notification — Rust must handle inbound requests with ids, not only notifications.
- **Stop reasons**: `end_turn | max_tokens | max_turn_requests | refusal | cancelled`.
- **Why a parallel window, not a backend swap**: `src/agent/agent-view.ts` is 2076 lines, tightly coupled to pi-agent-core's controller surface (skills, compaction, model presets, JSONL session format). Refactoring it into a backend-agnostic shell is a bigger change than implementing a fresh, ACP-native view. ACP's data shape (typed tool calls, plans, thoughts, permission requests) is also genuinely different from pi-agent's text+tool stream and benefits from purpose-built rendering.
- **Alternatives considered**: (a) shared abstraction across both backends — rejected: forces compromises in both UIs, risks regressing the pi agent. (b) shell out to `claude`/`gemini` in plain mode and scrape stdout — rejected: brittle, no tool-call structure, no permissions. (c) MCP — wrong layer; MCP exposes tools to an agent, ACP exposes an agent to a client.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Zed | First-class ACP host. `~/.config/zed/settings.json` `agent_servers` block (`command`, `args`, `env`). | Reference implementation; protocol authors. |
| Neovim (`acp.nvim`, CodeCompanion) | Spawns `npx @agentclientprotocol/claude-agent-acp` or `gemini --experimental-acp`, renders chunks in a buffer. | Confirms stdio adapter pattern is the norm. |
| IntelliJ "Gemini CLI Companion" | Launches `gemini --experimental-acp`, JSON-RPC over stdio, modal permission prompts. | Validates Gemini CLI ACP mode for IDE-style hosts. |
| Emacs `acp.el` | Minimal ACP client; line-delimited framing in a non-Node host. | Reference for non-JS implementation. |

**Krypton delta** — Match Zed's TOML-style backend declaration (familiar to ACP users). Diverge by routing every UI surface through a keyboard-first window in our own compositor (no popups), single-key inline permission prompts, and cyberpunk chrome consistent with the rest of Krypton.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `tokio` features (`process`, `io-util`, `sync`) if not already present. |
| `src-tauri/src/acp.rs` | **New.** Spawn agent subprocess, frame newline-delimited JSON-RPC, manage one client per session, route inbound requests/notifications/responses, emit Tauri events. |
| `src-tauri/src/lib.rs` | Register `acp_*` commands; add `AcpRegistry` to managed state. |
| `src/acp/types.ts` | **New.** ACP wire types (`ContentBlock`, `SessionUpdate`, `ToolCall`, `PermissionOption`, `StopReason`). |
| `src/acp/client.ts` | **New.** `AcpClient` — frontend wrapper around `acp_*` Tauri commands and `acp-event-<session>` listener; spawn / initialize / prompt / cancel / dispose / permission-respond. |
| `src/acp/acp-view.ts` | **New.** `AcpView` implementing `ContentView` — message list, streamed renderer, inline permission prompt, plan rendering. Modeled on `agent-view.ts` but standalone. |
| `src/acp/index.ts` | **New.** Public re-exports. |
| `src/styles/acp.css` | **New.** ACP-window-specific styles (consistent with `agent.css`). |
| `src/types.ts` | Add `'acp'` to `PaneContentType` union. |
| `src/compositor.ts` | New `openAcpView(backendId)` mirroring `openAgentView()`. **No changes to `openAgentView`.** |
| `src/command-palette.ts` | New entries for built-in ACP agents. Existing pi-agent palette entry untouched. |
| `src/input-router.ts` | New compositor key `Leader A` (Shift+a) → palette filter "ACP Agent". |
| `docs/PROGRESS.md`, `docs/04-architecture.md`, `docs/06-configuration.md` | Add the new ACP module + config section. **`docs/42-pi-agent-integration.md` is not modified.** |

## Design

### Built-In Backends

ACP backends are code-defined, not configured in `krypton.toml`.

| Backend ID | Command |
|------------|---------|
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` |
| `gemini` | `gemini --experimental-acp` |
| `codex` | `codex-acp` |

**PATH for spawned adapters.** macOS GUI apps launched from `/Applications` inherit only `/usr/bin:/bin:/usr/sbin:/sbin`, so `gemini` (Homebrew) and `npx` (nvm) are typically invisible. At app start, run `sh -lc 'printenv PATH'` once, cache the result in a `OnceCell<String>`, and pass it via `Command::env("PATH", cached)` for every ACP spawn. Reuses the same login-shell trick already used by `get_env_var`.

### Rust: `AcpRegistry` (`src-tauri/src/acp.rs`)

```rust
pub struct AcpClient {
    acp_session_id: String,           // returned by session/new
    krypton_session: u64,             // our id, used in event names
    stdin: tokio::process::ChildStdin,
    pending: Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>,
    perm_pending: Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>,
    next_id: AtomicU64,
    capabilities: AgentCapabilities,
    child: tokio::process::Child,
}

pub struct AcpRegistry { clients: RwLock<HashMap<u64, Arc<AcpClient>>> }
```

One reader task per process (`tokio::spawn`) does `BufReader::lines().next_line()` and dispatches:

- **Response** (`id` + `result`/`error`): resolve `pending[id]`.
- **Request** (`id` + `method`):
  - `fs/read_text_file` / `fs/write_text_file` → call existing Krypton fs helpers, reply. `fs/read_text_file` returns `{content: ""}` for `NotFound` instead of erroring — Gemini's edit tool pre-reads the target file to compute a diff even when creating new files, and treats a read error as a tool-call failure. Permission/IO errors still propagate.
  - `session/request_permission` → store oneshot in `perm_pending[id]`, emit `acp-event` with the JSON-RPC `id`; await frontend response via `acp_permission_response` Tauri command, then send JSON-RPC reply.
- **Notification** (no `id`): emit `acp-event-<krypton_session>` to frontend with raw `params`.

Stderr is captured into a 64KB rolling per-client buffer **and** mirrored to `log::debug!`. Process death cancels all `pending` / `perm_pending` oneshots with errors.

**Subprocess teardown.** `acp_dispose` sends `SIGTERM`, waits up to 2s for graceful exit, then `SIGKILL`. Closing the AcpView tab calls `acp_dispose` unconditionally — adapters like Claude Code flush their session state on `SIGTERM`. Cancelling a turn (`acp_cancel`) only sends `session/cancel` JSON-RPC — it does not kill the process.

**Startup error handling.** `acp_spawn` returns a `krypton_session` immediately after `Command::spawn` succeeds. The frontend then invokes `acp_initialize`, which sends `initialize` + `session/new` and awaits both responses. AcpView shows a spinner ("Starting <display_name>…") during this phase. If the child exits **or** initialize does not complete within **30 seconds** (covers first-run `npx -y` package download), Rust emits an `error` event carrying the buffered stderr (truncated to 2KB) plus a heuristic hint:

| stderr substring | suggested action |
|------------------|------------------|
| `claude /login`, `not authenticated` | "Run `claude /login` in a terminal, then retry." |
| `gemini auth`, `please authenticate` | "Run `gemini auth login` in a terminal, then retry." |
| `npm ERR`, `ENOENT` on `npx` | "Check network or install the adapter manually: `npm i -g @agentclientprotocol/claude-agent-acp`." |
| _none of the above_ | raw stderr tail. |

After initialize succeeds, stderr stays in the rolling buffer (debug only); it is **not** rendered in AcpView during normal operation.

### Tauri Commands

```rust
acp_list_backends() -> Vec<AcpBackendDescriptor>             // from config
acp_spawn(backend_id: String, cwd: Option<String>) -> Result<u64, String>
acp_initialize(session: u64) -> Result<AgentInfo, String>    // initialize + session/new
acp_prompt(session: u64, blocks: Vec<ContentBlock>) -> Result<StopReason, String>
acp_cancel(session: u64) -> Result<(), String>
acp_permission_response(session: u64, request_id: u64, option_id: Option<String>) -> Result<(), String>
acp_dispose(session: u64) -> Result<(), String>
```

`acp_prompt` is awaited end-to-end; chunks arrive out-of-band on `acp-event-<session>`.

### Frontend: `AcpClient` (`src/acp/client.ts`)

```ts
export type AcpEvent =
  | { type: 'message_chunk'; text: string }
  | { type: 'thought_chunk'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_update'; update: ToolCallUpdate }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'permission_request'; requestId: number; toolCall: ToolCall; options: PermissionOption[] }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'stop'; stopReason: StopReason }
  | { type: 'error'; message: string };

export interface UsageInfo {
  used?: number;            // tokens used so far in the session window
  size?: number;            // total context window size
  cost?: { amount: number; currency: string };
  inputTokens?: number;     // alternate shape used by some adapters
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export class AcpClient {
  static async spawn(backendId: string, cwd: string | null): Promise<AcpClient>;
  onEvent(cb: (e: AcpEvent) => void): () => void;
  prompt(blocks: ContentBlock[]): Promise<StopReason>;
  cancel(): Promise<void>;
  respondPermission(requestId: number, optionId: string | null): Promise<void>;
  dispose(): Promise<void>;
}
```

### Frontend: `AcpView` (`src/acp/acp-view.ts`)

Implements `ContentView` (same interface as `AgentView`). Owns its own `AcpClient`. Rendering responsibilities:

- **CWD source.** `compositor.openAcpView(backendId)` resolves CWD from the focused terminal pane (same logic as `openAgentView` at `compositor.ts:1981–1989`); falls back to `$HOME` if no terminal is focused.
- **Input is plain text.** No `@`-mention picker in v1. User-typed text becomes a single `{type:"text"}` ContentBlock — adapters discover files through their own tool calls and the `fs/*` callbacks Krypton already serves. Image attachments (`{type:"image"}`) are still allowed when the agent advertises `promptCapabilities.image`.
- Streamed `agent_message_chunk` → markdown block (reuse `marked` + `highlight.js` setup; coalesce chunks with `requestAnimationFrame` to avoid re-parsing markdown on every token).
- `agent_thought_chunk` → dimmer collapsible block.
- `tool_call` / `tool_call_update` → bracketed tool row matching the existing agent's phosphor style. **Diffs render inline as a one-line summary** (`[edit] src/main.ts +12 -3`); the full diff string is held on the block. Pressing `o` or `Enter` while the block is focused calls the existing `openDiffFromString` compositor hook to open a Diff Viewer window. The view does **not** auto-open diff windows — multi-edit turns would otherwise flood the workspace.
- `plan` → collapsible task list with `[ ] / [~] / [x]` for `pending|in_progress|completed`.
- `permission_request` → inline block:

  ```
  ⏵ permission: edit  src/main.ts
    [a] allow once   [A] always   [r] reject   [R] never
  ```

  Single-key handler in the view; `Esc` sends `cancelled` (per-prompt, scoped to that one request — Krypton stores nothing). The `optionId` chosen by the user is passed back to the adapter verbatim; Krypton never interprets `kind = allow_always` itself, so adapters keep full ownership of their permission memory.
- `stop` → close turn, return prompt to user input.

The view borrows visual conventions from `agent-view.ts` but does not import its code. Style file `src/styles/acp.css` mirrors `agent.css` patterns and reuses the same theme CSS variables.

### Mapping ACP → `AcpEvent`

| ACP wire | `AcpEvent` |
|----------|------------|
| `session/update { sessionUpdate: "agent_message_chunk", content }` | `message_chunk` |
| `session/update { sessionUpdate: "agent_thought_chunk", content }` | `thought_chunk` |
| `session/update { sessionUpdate: "tool_call", … }` | `tool_call` |
| `session/update { sessionUpdate: "tool_call_update", … }` | `tool_call_update` |
| `session/update { sessionUpdate: "plan", entries }` | `plan` |
| `session/request_permission` (request) | `permission_request` |
| `session/prompt` response `{ stopReason }` | `stop` |

### Data Flow (one prompt turn)

```
1. User types message + Enter in AcpView
2. AcpClient.prompt(blocks) → invoke('acp_prompt', { session, blocks })
3. Rust writes session/prompt JSON-RPC to child stdin
4. Child streams session/update notifications → reader emits acp-event-<s>
5. AcpView's onEvent listener renders each chunk
6. Child sends session/request_permission (request, has id)
   → Rust stores oneshot in perm_pending[id], emits acp-event with requestId
   → AcpView shows inline prompt, user picks
   → AcpClient.respondPermission(id, optionId)
   → invoke('acp_permission_response') → Rust replies on JSON-RPC, child resumes
7. Child returns response { stopReason } → acp_prompt resolves → AcpClient emits stop
```

### Auth

For v1, auth is the user's responsibility outside Krypton (`claude /login`, `gemini auth`). If `initialize` returns a non-empty `authMethods` and the agent later refuses with a permission/auth error, surface a notification with the install/login command. Implementing the `authenticate` JSON-RPC flow is **out of scope** for v1.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader A` (Shift+a) | Compositor mode | Open ACP backend picker (palette filtered to ACP entries). |
| `a` / `A` / `r` / `R` | Permission prompt focused | allow_once / allow_always / reject_once / reject_always (passes `optionId` to adapter). |
| `Esc` | Permission prompt focused | Respond `cancelled` outcome. |
| `o` or `Enter` | Tool block with diff focused | Open full diff in Diff Viewer window via `openDiffFromString`. |
| `Ctrl+C` | AcpView input focused, turn active | `acp_cancel` (sends `session/cancel`; does not kill subprocess). |
| `Ctrl+C` | AcpView input focused, idle | Clear input buffer if non-empty; otherwise no-op. |
| `Esc` | AcpView input focused | Blur input, return focus to compositor (agent keeps streaming in background). |

`Leader a` (lowercase) continues to open the existing pi agent — unchanged.

## Edge Cases

- **Subprocess crashes mid-prompt**: reader task ends → cancel all `pending` / `perm_pending` with errors → emit `error` then synthetic `stop { stopReason: "cancelled" }`; mark client disposed.
- **`acp_cancel` with no prompt active**: no-op.
- **Adapter not installed** (`npx` fails / `gemini` not on PATH): `acp_spawn` returns descriptive error → palette / view shows toast with install hint.
- **Newline inside a JSON payload**: ACP forbids it; on a malformed line, log to debug and drop rather than crash.
- **Multiple ACP windows simultaneously**: each gets its own subprocess + `krypton_session`. No multiplexing.
- **Built-in backend command not on PATH**: deferred error at spawn time with an adapter-specific startup hint when available.
- **Image attachment when `promptCapabilities.image` is false**: stripped client-side with a one-time inline notice.
- **`fs/read_text_file` outside any open project**: allowed (the agent already has shell access via its own tools); no path sandboxing in v1.
- **`fs/read_text_file` on a missing file**: returns `{content: ""}` instead of an error so Gemini's edit-then-write flow (which pre-reads to diff) can create new files cleanly.
- **User opens both pi-agent and ACP windows concurrently**: independent — each window has its own controller, its own session, its own keybindings.
- **User closes AcpView while a turn is streaming**: `acp_dispose` is called → `SIGTERM`, 2s grace, then `SIGKILL`. Pending oneshots resolve to errors but the AcpView is already gone, so no UI follow-up is needed.
- **User blurs AcpView (`Esc`) mid-stream then reopens later**: agent keeps streaming into the still-mounted DOM; reopening the tab simply restores focus. (Closing the tab is the only way to terminate the subprocess.)
- **First-run `npx -y` download exceeds 30s**: initialize timeout fires, surface stderr + npm hint. User can retry; second attempt uses the npx cache and is fast.

## Open Questions

None.

## Out of Scope

- Touching `src/agent/` (pi-agent), `docs/42-pi-agent-integration.md`, or any pi-agent behavior.
- ACP `terminal/*` methods (agent-spawned long-running terminals).
- ACP `session/load` (resumption).
- Implementing `authenticate` JSON-RPC flow inside Krypton.
- MCP server exposure from Krypton to ACP agents (`mcpCapabilities.http`/`sse`).
- Auto-installing missing adapters. Document the install command, don't run it.
- Switching backend on a live ACP window (open a new window instead).
- Sharing message history between pi-agent and ACP windows.
- Persisting transcripts on the Krypton side. Adapters keep their own session history (Claude Code in `~/.claude/`, Gemini CLI in its own store); duplicating that in Krypton without `session/load` would be a misleading pseudo-resumption.
- Krypton-side memory of `allow_always` / `reject_always` permission choices. Adapters own permission memory; the chosen `optionId` is forwarded verbatim and forgotten.
- `@`-mention file picker in the input field. v1 ships text-only input; the picker is a possible v2 addition once we see how often users want it.

## Resources

- [ACP Overview](https://agentclientprotocol.com/protocol) — top-level model: methods + notifications, JSON-RPC 2.0.
- [ACP Transports](https://agentclientprotocol.com/protocol/transports.md) — stdio + newline-delimited JSON, UTF-8, no embedded `\n`.
- [ACP Initialization](https://agentclientprotocol.com/protocol/initialization) — `initialize` payload and capability flags.
- [ACP Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn.md) — `session/prompt`, `session/update` variants, `stopReason` enum.
- [ACP Tool Calls](https://agentclientprotocol.com/protocol/tool-calls.md) — `ToolCall` / `ToolCallContent` shape, permission flow.
- [ACP Content Blocks](https://agentclientprotocol.com/protocol/content) — text/image/audio/resource/resource_link block shapes.
- [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) — reference Claude Agent SDK adapter.
- [Gemini CLI ACP mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) — `gemini --experimental-acp`.
- [`docs/42-pi-agent-integration.md`](./42-pi-agent-integration.md) — existing pi-agent integration; referenced for context only, not modified.
