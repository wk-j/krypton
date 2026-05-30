# Zed Editor Reference (ACP / MCP / model prior art)

Local repo: `/Users/wk/Source/zed` — git HEAD `3d9852ae04` at time of writing.

Zed is the canonical **ACP client**. Read it as prior art for Krypton's ACP harness: how a mature
client spawns external agents, forwards MCP servers, and selects models. Krypton plays the same
client role the `agent_servers` crate plays here.

**Always read the local source — it is the ground truth. Line numbers below drift; the symbol
names are the durable anchor.** Zed is huge (238 crates); the entry points below save you a scan.

---

## Crate map (the ones that matter for ACP/MCP/model)

| Crate | Role |
|-------|------|
| `crates/agent_servers/` | The **ACP client**. Spawns external agent subprocesses, drives the JSON-RPC session, forwards MCP servers, sets the model. Start here. |
| `crates/acp_thread/` | ACP connection/session state, thread model (`connection.rs`). |
| `crates/acp_tools/` | ACP debugging / tool surface. |
| `crates/context_server/` | Zed's **MCP client** — spawns MCP servers (stdio + http transports), runs the MCP `initialize` handshake. |
| `crates/agent/` | Native (built-in) Zed agent; `LanguageModels` registry; `tools/context_server_registry.rs`. |
| `crates/agent_ui/` | Agent panel UI, `model_selector.rs`, `agent_model_selector.rs`. |
| `crates/agent_settings/` | Global `AgentSettings` (native-agent default model, profiles). |
| `crates/language_model[s]/`, `language_model_core/`, `language_models_cloud/` | `LanguageModel` trait, `LanguageModelProvider`, `LanguageModelRegistry`. |
| `crates/settings_content/` | Settings JSON schema — `context_servers`, `agent_servers` live here (`src/project.rs`). |

**ACP protocol itself is an external crate**, not vendored:
`Cargo.toml:512` → `agent-client-protocol = { version = "=0.12.1", features = ["unstable"] }`.
All `acp::*` types (`NewSessionRequest`, `McpServer`, `SetSessionModelRequest`, …) come from there.

---

## 1. ACP client implementation

- `crates/agent_servers/src/acp.rs` — main client. `AcpConnection` wraps the
  `agent-client-protocol` SDK's `ConnectionTo<Agent>`. `into_foreground_future()` bridges the SDK's
  async responses into GPUI's task context.
- `crates/agent_servers/src/agent_servers.rs` — `AgentServer` trait: `connect()`, `default_model()`,
  `default_mode()`.
- `crates/agent_servers/src/custom.rs` — `CustomAgentServer` for external agents; reads/writes the
  per-agent `default_model` / `default_mode` in settings.
- Session requests are built by helpers around `acp.rs:1403`:
  - `into_new_session_request(mcp_servers)` → `acp::NewSessionRequest`
  - `into_load_session_request(session_id, mcp_servers)`
  - `into_resume_session_request(session_id, mcp_servers)`

---

## 2. External agent servers

External agents run as ACP-server subprocesses over **stdio**. Registered IDs:
`"claude-acp"` (Claude Code), `"gemini"`, `"codex-acp"`.

- Per-agent config (incl. `default_model`) is stored under settings key `agent_servers["<id>"]`.
- `crates/agent/src/native_agent_server.rs` — `NativeAgentServer`, the built-in agent implementing
  the same `AgentServer` trait.
- `crates/agent_ui/src/agent_panel.rs` — agent panel; enumerates configured servers and switches
  between them.

---

## 3. MCP / context servers → ACP forwarding

User configures MCP servers under `context_servers` in `.zed/settings.json`:

```json
{
  "context_servers": {
    "my-mcp-server": { "command": "/path/to/bin", "args": ["--x"], "env": { "VAR": "value" } }
  }
}
```

**The translation that matters for Krypton** — `crates/agent_servers/src/acp.rs:3840`,
`fn mcp_servers_for_project(project, cx) -> Vec<acp::McpServer>`:

- reads `project.context_server_store()`, iterates `configured_server_ids()`
- `Custom` / `Extension` config (when `is_local || remote`) → `acp::McpServer::Stdio`
  (`McpServerStdio::new(id, command.path).args(...).env(vec![EnvVariable{name,value}])`)
- `Http` config → `acp::McpServer::Http` (`McpServerHttp::new(id, url).headers(vec![HttpHeader])`)
- the resulting `Vec<acp::McpServer>` is passed into `into_new_session_request(...)` (and load/resume).

So MCP servers are delivered to the external agent **inside `session/new`** (called at
`acp.rs:1569`, `:1753`, `:1796`). Zed's own MCP host lives in `crates/context_server/`
(`context_server.rs`, `client.rs`, `transport/stdio_transport.rs`, `transport/http.rs`).

Note: Zed sends `env` as an **array** of `{name, value}` (ACP shape), translating from the
object-form `env` in settings. This is the same object→array translation Krypton's
`src/acp/mcp-bridge.ts` does. Settings here use `command`/`args`/`env`-object; ACP uses
`{name, value}` arrays — same mismatch, same fix.

---

## 4. Model selection — how the model name reaches the ACP agent (and never the MCP servers)

Two distinct questions, both verified directly in `acp.rs`:

### Does the model name reach the MCP servers? **No.**

- `into_new_session_request` (`acp.rs:1403`) sets **only** `cwd`, `additional_directories`,
  `mcp_servers` — no model field on `NewSessionRequest`.
- `mcp_servers_for_project` (`acp.rs:3840`) builds each `McpServer` from `command`/`args`/`env`
  (or `url`/`headers`) only — no model injected into the server's spawn env or args.
- MCP servers are model-agnostic context/tool providers: told *where to run*, never *which model*
  the agent chose.

### How is the model name injected into the ACP **agent**? A dedicated post-`session/new` RPC.

The model is a property of the *agent session*, set via `acp::SetSessionModelRequest`
(`{session_id, model_id}`) — a separate JSON-RPC call, NOT a field on `session/new`. Full flow:

1. **Source = settings (a plain string).** `AcpConnectionDefaults::refresh_from_settings`
   (`acp.rs:481-507`) reads `AllAgentServersSettings` from the `SettingsStore`, finds the per-agent
   entry by `agent_id`, and does `agent_settings.default_model().map(acp::ModelId::new)` (`:504`).
   So the model id comes from settings key `agent_servers["<id>"].default_model`. `observe_settings`
   (`:509`) keeps it live as settings change. `acp::ModelId` is an **opaque string** — there is no
   enforced `provider/model` format; it just has to match a `model_id` the agent advertised. (The
   unit test default is `"claude-sonnet-4"`, `acp.rs:3109`.)
2. **The agent owns the model list (authoritative).** The `session/new` response carries
   `acp::SessionModelState { available_models, current_model_id }` — the agent declares what it
   supports and what's currently active. Zed does **not** impose its own `LanguageModelRegistry` on
   external agents.
3. **Inject at session open, gated** (`acp.rs:1633-1667`): `self.defaults.model()` (the settings
   default) is sent only if it appears in `available_models`. If so: optimistically set local
   `current_model_id`, spawn a detached task sending `SetSessionModelRequest::new(session_id,
   default_model)`, and revert `current_model_id` on failure. If not found → `log::warn!` and leave
   the agent's own current model untouched.
4. **Runtime switch** (`acp.rs:3981`, `AcpModelSelector::select_model`): identical pattern on user
   pick — optimistic local update → `SetSessionModelRequest` → revert on error. `list_models`
   (`:3969`) returns the agent-advertised `available_models`.

**Implication for Krypton:** (a) to set a lane's model on an ACP agent, send the set-model RPC
**after** `session/new`, gated against the agent's advertised model list — don't try to put it in
`session/new`, and trust the agent's list over any client-side registry. (b) if a lane's MCP server
needs to *know* the active model, Krypton must inject it itself (env var on the server `command`, or
a tool arg) — neither ACP `session/new` nor Zed's pattern carries the model to an MCP server.

Model registry / selection lives in: `crates/agent/src/agent.rs` (`LanguageModels` registry,
`refresh_list()`), `crates/language_model*/` (the `LanguageModel`/`LanguageModelProvider`/
`LanguageModelRegistry` types), and the UI selectors in `crates/agent_ui/src/model_selector.rs` /
`agent_model_selector.rs`.

---

## 5. Settings schema

- `crates/settings_content/src/project.rs` — `context_servers: HashMap<Arc<str>,
  ContextServerSettingsContent>` with `Stdio { command, args, env, timeout, enabled, remote }`,
  `Http { url, headers, timeout, oauth, enabled }`, `Extension { settings, enabled, remote }`
  variants. Also a project-level `context_server_timeout`.
- `crates/settings_content/src/settings_content.rs` — `agent_servers: Option<AllAgentServersSettings>`
  (a map of agent-id → per-agent settings carrying `default_model`, `default_mode`, favorites).
- `crates/agent_settings/src/agent_settings.rs` — global `AgentSettings` (`default_model` for the
  *native* agent, profiles, model parameters).

> The exact field lists in §5 come from a survey pass, not a line-by-line read — open the files to
> confirm before relying on a specific field name.

---

## Quick "where do I look" index

| Question | File / symbol |
|----------|---------------|
| How is `session/new` built? | `acp.rs` → `into_new_session_request` (~`:1403`) |
| How are MCP servers forwarded? | `acp.rs` → `mcp_servers_for_project` (`:3840`) |
| How is the model sent to the agent? | `acp.rs` → `SetSessionModelRequest` (`:1652` at session open, `:3993` runtime switch) |
| Where does the model id come from? | settings `agent_servers["<id>"].default_model` → `AcpConnectionDefaults::refresh_from_settings` (`acp.rs:481-507`) |
| Where is the runtime model picker? | `acp.rs` → `AcpModelSelector::{list_models, select_model}` (`:3968`) |
| Who owns the model list? | the agent — `session/new` response `SessionModelState.available_models`; client gates against it |
| Where is the ACP protocol defined? | external crate `agent-client-protocol` `=0.12.1` (`Cargo.toml:512`) |
| How does Zed host its own MCP clients? | `crates/context_server/` |
| Where do `context_servers` settings live? | `crates/settings_content/src/project.rs` |
| Per-agent default model storage | `crates/agent_servers/src/custom.rs`; settings `agent_servers["<id>"]` |
