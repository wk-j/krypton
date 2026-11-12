// Krypton — ACP (Agent Client Protocol) backend.
//
// Spawns an external agent subprocess (e.g. `npx -y @agentclientprotocol/claude-agent-acp@latest`,
// `npx -y @agentclientprotocol/codex-acp@latest`) and speaks newline-delimited JSON-RPC 2.0 over its
// stdio. One AcpClient per Krypton-side session. The Rust side acts as the JSON-RPC
// client *and* must handle inbound requests (fs/read_text_file, fs/write_text_file,
// session/request_permission, Grok's `_x.ai/exit_plan_mode`, and
// `_x.ai/ask_user_question`) initiated by the agent.
//
// See docs/0069-acp-agent-support.md for the design.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::acp_wire::{AcpWire, WireLane};
use crate::remote_harness::{
    RemoteAgentEvent, RemoteAgentTransport, RemoteHarnessRegistry, RemoteRuntimeClient,
};
use crate::util::emit::EmitExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

fn instance_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcpInstanceRole {
    HarnessLane,
    SessionProbe,
    Assist,
    RailsJudge,
    InlineAi,
    CommitExplainer,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AcpInstanceOwner {
    pub role: AcpInstanceRole,
    pub label: String,
    pub harness_id: Option<String>,
    pub lane_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcpExecutionKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize)]
pub struct AcpInstanceExecution {
    pub kind: AcpExecutionKind,
    pub runtime_id: Option<String>,
    pub host: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcpInstanceLifecycle {
    Initializing,
    Ready,
    Terminating,
    Disconnected,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcpInstanceActivity {
    Idle,
    Running,
    Waiting,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcpInstanceLiveness {
    Alive,
    Exited,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct AcpInstanceSnapshot {
    pub session: u64,
    pub backend_id: String,
    pub owner: AcpInstanceOwner,
    pub cwd: String,
    pub acp_session_id: Option<String>,
    pub execution: AcpInstanceExecution,
    pub pid: Option<u32>,
    pub lifecycle: AcpInstanceLifecycle,
    pub activity: AcpInstanceActivity,
    pub liveness: AcpInstanceLiveness,
    pub has_error: bool,
    pub requested_model_id: Option<String>,
    pub confirmed_model_id: Option<String>,
    pub model_uncertain: bool,
    pub started_at_ms: u64,
    pub last_activity_at_ms: u64,
}

struct InstanceObservation {
    owner: AcpInstanceOwner,
    execution: AcpInstanceExecution,
    lifecycle: AcpInstanceLifecycle,
    liveness: AcpInstanceLiveness,
    has_error: bool,
    confirmed_model_id: Option<String>,
    model_uncertain: bool,
    model_ids: Vec<String>,
    model_revision: u64,
    model_change_epoch: u64,
    active_requests: u32,
    started_at_ms: u64,
    last_activity_at_ms: u64,
}

/// Lives with the request future, so timeouts/cancellation cannot leave a
/// phantom running turn. No prompt, auth, argv, or environment is retained.
struct InstanceRequest<'a> {
    client: &'a AcpClient,
    initializing: bool,
    model_change: bool,
    model_revision: u64,
    model_change_epoch: u64,
    request_id: Option<u64>,
    finished: bool,
}

impl InstanceRequest<'_> {
    fn finish(&mut self, result: &Result<Value, String>) {
        let mut state = self
            .client
            .instance
            .write()
            .unwrap_or_else(|p| p.into_inner());
        if state.lifecycle != AcpInstanceLifecycle::Terminating
            && (!self.model_change || state.model_change_epoch == self.model_change_epoch)
        {
            state.has_error = result.is_err();
        }
        if result.is_ok() {
            if self.initializing && state.lifecycle == AcpInstanceLifecycle::Initializing {
                state.lifecycle = AcpInstanceLifecycle::Ready;
            }
            if self.model_change
                && state.model_change_epoch == self.model_change_epoch
                && state.model_revision == self.model_revision
            {
                let requested = self
                    .client
                    .model_override
                    .read()
                    .ok()
                    .and_then(|g| g.clone());
                state.confirmed_model_id = requested.filter(|id| state.model_ids.contains(id));
                state.model_uncertain = state.confirmed_model_id.is_none();
            }
        }
        self.finished = true;
    }
}

impl Drop for InstanceRequest<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.request_id {
            self.client
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
        }
        let mut state = self
            .client
            .instance
            .write()
            .unwrap_or_else(|p| p.into_inner());
        state.active_requests = state.active_requests.saturating_sub(1);
        state.last_activity_at_ms = instance_now_ms();
        if !self.finished {
            if state.lifecycle != AcpInstanceLifecycle::Terminating
                && (!self.model_change || state.model_change_epoch == self.model_change_epoch)
            {
                state.has_error = true;
            }
            if self.model_change
                && state.model_change_epoch == self.model_change_epoch
                && state.model_revision == self.model_revision
            {
                state.confirmed_model_id = None;
                state.model_uncertain = true;
            }
        }
    }
}

pub(crate) fn resolve_kryptonctl_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = crate::util::resource_dir::resource_dir(app) {
        if let Ok(targets) = std::fs::read_dir(resources.join("remote-binaries")) {
            for target in targets.flatten() {
                if !target
                    .file_name()
                    .to_string_lossy()
                    .contains(std::env::consts::ARCH)
                {
                    continue;
                }
                let path = target.path().join("kryptonctl");
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for profile in ["debug", "release"] {
        let path = manifest.join("target").join(profile).join("kryptonctl");
        if path.is_file() {
            return Some(path);
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".local/bin/kryptonctl"))
        .filter(|path| path.is_file())
}

#[tauri::command]
pub fn computer_cli_available(app: AppHandle) -> bool {
    resolve_kryptonctl_path(&app).is_some()
}

// ─── Built-in backends ─────────────────────────────────────────────

#[derive(Debug, Clone)]
struct AcpBackend {
    command: String,
    args: Vec<String>,
    display_name: String,
}

fn builtin_backends() -> Vec<(&'static str, AcpBackend)> {
    vec![
        (
            "claude",
            AcpBackend {
                command: "npx".to_string(),
                // `@latest` makes npx resolve the newest release on every spawn (spec 0322).
                args: vec![
                    "-y".to_string(),
                    "@agentclientprotocol/claude-agent-acp@latest".to_string(),
                ],
                display_name: "Claude".to_string(),
            },
        ),
        (
            "codex",
            AcpBackend {
                // The adapter bundles its own `@openai/codex`; `@latest` makes npx
                // resolve the newest release on every spawn and skip stale
                // global/project copies (spec 0322).
                command: "npx".to_string(),
                args: vec![
                    "-y".to_string(),
                    "@agentclientprotocol/codex-acp@latest".to_string(),
                ],
                display_name: "Codex".to_string(),
            },
        ),
        (
            "opencode",
            AcpBackend {
                command: "opencode".to_string(),
                args: vec!["acp".to_string()],
                display_name: "OpenCode".to_string(),
            },
        ),
        (
            "pi-acp",
            AcpBackend {
                command: "pi-acp".to_string(),
                args: vec![],
                display_name: "Pi".to_string(),
            },
        ),
        (
            "droid",
            AcpBackend {
                command: "droid".to_string(),
                args: vec![
                    "exec".to_string(),
                    "--output-format".to_string(),
                    "acp".to_string(),
                ],
                display_name: "Droid".to_string(),
            },
        ),
        (
            "cursor",
            AcpBackend {
                command: "cursor-agent".to_string(),
                // cursor-agent ignores MCP servers passed via ACP `session/new`
                // (regressed upstream ~2026.05.27; `2026.05.20` honored them) and
                // `--approve-mcps` has NO effect in ACP mode — it only auto-approves
                // in `--print`/headless. So the harness memory server is delivered
                // through `<project>/.cursor/mcp.json` + `cursor-agent mcp enable`
                // (see prepare_cursor_mcp); no extra spawn args beyond the subcommand.
                args: vec!["acp".to_string()],
                display_name: "Cursor".to_string(),
            },
        ),
        (
            "omp",
            AcpBackend {
                command: "omp".to_string(),
                args: vec!["acp".to_string()],
                display_name: "OMP".to_string(),
            },
        ),
        (
            "grok",
            AcpBackend {
                command: "grok".to_string(),
                // `--trust` is a global grok flag (must precede `agent`). ACP has
                // no TUI `/hooks-trust` prompt, so without it Grok 1.0.13 skips
                // every repo-local MCP server in an untrusted folder
                // (`search_tool` returns an empty catalog). Opening a Grok lane
                // is implicit workspace trust — same as Claude already loading
                // `.mcp.json` via the spec-83 bridge. Records the cwd in
                // `~/.grok/trusted_folders.toml`.
                args: vec![
                    "--trust".to_string(),
                    "agent".to_string(),
                    "stdio".to_string(),
                ],
                display_name: "Grok".to_string(),
            },
        ),
        (
            "copilot",
            AcpBackend {
                command: "copilot".to_string(),
                // GitHub Copilot CLI native ACP server over stdio (public preview).
                // `--port N` would switch to TCP; the harness is stdio-only like
                // every other lane. No model flag is documented — see acp.rs model
                // block (none added) and docs/0150-acp-copilot-lane.md.
                args: vec!["--acp".to_string(), "--stdio".to_string()],
                display_name: "Copilot".to_string(),
            },
        ),
        (
            "cline",
            AcpBackend {
                command: "cline".to_string(),
                // Cline CLI native ACP server over stdio (`npm i -g cline`,
                // auth via `cline auth`). MCP delivery is native-config, NOT
                // ACP `session/new`: verified against cline 3.0.24, `initialize`
                // advertises NO `mcpCapabilities`, so any http/sse server passed
                // through `session/new` is dropped — the per-lane harness memory
                // server never lands and peer/memory tools are missing. Instead
                // Krypton writes a per-lane `cline_mcp_settings.json` and points
                // `CLINE_MCP_SETTINGS_PATH` at it at spawn (see
                // write_cline_mcp_overlay + acp_spawn). The model is selectable
                // via the CLI `-m`/`--provider` flags, but v1 leaves it to
                // `cline auth`/config (chip-only). See docs/0159-acp-cline-lane.md.
                args: vec!["--acp".to_string()],
                display_name: "Cline".to_string(),
            },
        ),
        (
            "antigravity",
            AcpBackend {
                // Placeholder: Antigravity's ACP server is not on PATH. It ships
                // only as a registry zip, so acp_spawn replaces command + args
                // with the managed install (acp_install::resolve). Local-only,
                // auth retried via `authenticate` (see request_with_auth_retry).
                // See docs/0287-acp-antigravity-lane.md.
                command: "agy_acp_server".to_string(),
                args: vec![],
                display_name: "Antigravity".to_string(),
            },
        ),
        (
            "fx",
            AcpBackend {
                // Vercel Labs fx: native ACP server over stdio (`fx acp`, the
                // command fx documents for ACP clients). No flags, so the lane
                // keeps fx's saved provider and permission mode. Auth is
                // `fx login` outside Krypton (no ACP authMethods); an
                // unauthenticated fx fails `initialize` with its own reason.
                // See docs/0359-acp-fx-lane.md.
                command: "fx".to_string(),
                args: vec!["acp".to_string()],
                display_name: "fx".to_string(),
            },
        ),
    ]
}

fn resolve_backend(id: &str) -> Option<AcpBackend> {
    builtin_backends()
        .into_iter()
        .find(|(bid, _)| *bid == id)
        .map(|(_, b)| b)
}

// ─── Public types exposed to the frontend ──────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AcpBackendDescriptor {
    pub id: String,
    pub display_name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub agent_protocol_version: i64,
    pub auth_methods: Vec<Value>,
    pub agent_capabilities: Value,
    pub session_id: String,
}

/// Result of `acp_initialize` (no session_id yet — session/new is a separate
/// step so the frontend can inject capability-gated MCP servers between).
#[derive(Debug, Clone, Serialize)]
pub struct AgentInitInfo {
    pub agent_protocol_version: i64,
    pub auth_methods: Vec<Value>,
    pub agent_capabilities: Value,
    /// spec 278: the agent advertised the `_session/steering` extension in the
    /// top-level initialize `_meta` (a sibling of `agentCapabilities`).
    pub steering_supported: bool,
}

/// One agent-advertised model entry, mapped from the ACP `session/new`
/// `models.availableModels[]` or the `configOptions` model selector (camelCase)
/// into snake_case for the frontend (spec 127). The picker offers exactly these
/// — never a hand-maintained list.
#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
}

/// One value of the agent's `thought_level` config option (spec 388).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EffortOption {
    pub value: String,
    pub name: String,
}

/// The lane's reasoning-effort control (spec 388): the `configOptions` select
/// with `category: "thought_level"`. Its id differs per agent (`effort`,
/// `reasoning_effort`, `thinking`, …), so it is found by category and the id
/// is kept here for `session/set_config_option`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EffortState {
    pub config_id: String,
    pub options: Vec<EffortOption>,
    pub current: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionInfo {
    pub session_id: String,
    /// True ONLY when a model was requested, the agent advertised model state,
    /// and the `session/set_model` request errored/timed out. False on success,
    /// skip, no-request, or no-capability. Drives a "requested model not applied"
    /// chip warning — it never claims to know the real running model.
    pub model_apply_failed: bool,
    /// Agent-advertised models from the `session/new` response (spec 127). Empty
    /// when the backend advertises no model state — the model picker is then
    /// disabled for that lane.
    pub available_models: Vec<ModelInfo>,
    /// The session's confirmed current model id. Starts as the agent's
    /// `currentModelId`, but is overwritten with the spawn-applied id when the
    /// configured value was an exact advertised id (so the picker's `✓` marks the
    /// running model, not the pre-switch default). `None` when unverified (e.g. an
    /// alias was applied — we don't assert a guessed canonical id).
    pub current_model_id: Option<String>,
    /// spec 388: the model Krypton asked for after `session/new` — the
    /// remembered pick or `lane_models.<backend>.active`. `None` when nothing
    /// was requested (and on resume/load, which never force a model).
    pub requested_model_id: Option<String>,
    /// spec 388: the reasoning-effort control after spawn-time apply. `None`
    /// when the lane's model is not driven through `configOptions` or the agent
    /// offers no `thought_level` select.
    pub effort: Option<EffortState>,
    /// The response's ACP `modes` (`SessionModeState`), forwarded unparsed: the
    /// frontend's lane adapter decodes it (spec 380).
    pub modes: Option<Value>,
}

/// Non-fatal spawn-time selection result. Confirmed identity lives in the
/// same observation used by live switches and agent-reported updates.
struct ModelApplyResult {
    failed: bool,
}

/// How the session accepts a model selection — decided by what `session/new`
/// (or resume/load) advertised.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ModelControl {
    /// A valid `models` object: unstable `session/set_model {modelId}`.
    SetModel,
    /// No `models` object, but a `configOptions` select with `category: "model"`
    /// (OpenCode v2): stable `session/set_config_option {configId, value}`.
    ConfigOption(String),
}

impl ModelControl {
    fn request(&self, acp_session_id: &str, model: &str) -> (&'static str, Value) {
        match self {
            Self::SetModel => (
                "session/set_model",
                json!({ "sessionId": acp_session_id, "modelId": model }),
            ),
            Self::ConfigOption(config_id) => (
                "session/set_config_option",
                json!({ "sessionId": acp_session_id, "configId": config_id, "value": model }),
            ),
        }
    }
}

/// Frontend-facing model state plus the request shape that switches it.
struct SessionModelState {
    available: Vec<ModelInfo>,
    current: Option<String>,
    /// `None` when the session advertises no model state.
    control: Option<ModelControl>,
}

/// Read model state from a `session/new` / resume / load response. A valid
/// `models` object wins (the verified `session/set_model` path); otherwise the
/// `configOptions` model selector (`parse_config_model_option`) is used.
fn parse_session_model_state(response: &Value) -> SessionModelState {
    let models = response.get("models");
    if advertises_models(models) {
        let (available, current) = parse_session_models(models);
        return SessionModelState {
            available,
            current,
            control: Some(ModelControl::SetModel),
        };
    }
    if let Some(state) = parse_config_model_option(response.get("configOptions")) {
        return state;
    }
    SessionModelState {
        available: Vec::new(),
        current: None,
        control: None,
    }
}

/// Capability shape check: an `availableModels` array or a `currentModelId`
/// string, not merely the key, so an empty/garbage `models` value does not
/// trigger a doomed request. An empty `availableModels: []` still counts.
fn advertises_models(models: Option<&Value>) -> bool {
    models
        .and_then(|v| v.as_object())
        .map(|m| {
            m.get("availableModels")
                .map(|a| a.is_array())
                .unwrap_or(false)
                || m.get("currentModelId")
                    .map(|c| c.is_string())
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Parse the ACP Session Config Options model selector: among the `select`
/// options with `category: "model"`, the one whose `id` is `"model"`, else the
/// agent's first (ACP's array-order tie-break). fx lists a `provider` select
/// before its `model` select under that category (spec 359). `options` is
/// either a flat `[{value, name, description?}]` list or grouped
/// `[{group, name, options: [...]}]`; both flatten into one model list.
fn parse_config_model_option(config_options: Option<&Value>) -> Option<SessionModelState> {
    let is_model_select = |o: &&Value| {
        o.get("category").and_then(|c| c.as_str()) == Some("model")
            && o.get("type").and_then(|t| t.as_str()) == Some("select")
    };
    let options = config_options?.as_array()?;
    let option = options
        .iter()
        .filter(is_model_select)
        .find(|o| o.get("id").and_then(|i| i.as_str()) == Some("model"))
        .or_else(|| options.iter().find(is_model_select))?;
    let config_id = option.get("id")?.as_str()?.to_string();
    let mut available = Vec::new();
    for entry in option
        .get("options")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        match entry.get("options").and_then(|v| v.as_array()) {
            Some(group) => available.extend(group.iter().filter_map(parse_config_select_value)),
            None => available.extend(parse_config_select_value(entry)),
        }
    }
    let current = option
        .get("currentValue")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(SessionModelState {
        available,
        current,
        control: Some(ModelControl::ConfigOption(config_id)),
    })
}

fn parse_config_select_value(entry: &Value) -> Option<ModelInfo> {
    let model_id = entry.get("value")?.as_str()?.to_string();
    let name = entry
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or(&model_id)
        .to_string();
    let description = entry
        .get("description")
        .and_then(|d| d.as_str())
        .map(|s| s.to_string());
    Some(ModelInfo {
        model_id,
        name,
        description,
    })
}

/// spec 388: the `thought_level` select of a `configOptions` list, flattened
/// like the model select (flat or grouped options). `None` when absent.
fn parse_effort_state(config_options: Option<&Value>) -> Option<EffortState> {
    let option = config_options?.as_array()?.iter().find(|o| {
        o.get("category").and_then(Value::as_str) == Some("thought_level")
            && o.get("type").and_then(Value::as_str) == Some("select")
    })?;
    let config_id = option.get("id")?.as_str()?.to_string();
    let mut options = Vec::new();
    for entry in option
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match entry.get("options").and_then(Value::as_array) {
            Some(group) => options.extend(group.iter().filter_map(parse_effort_option)),
            None => options.extend(parse_effort_option(entry)),
        }
    }
    let current = option
        .get("currentValue")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(EffortState {
        config_id,
        options,
        current,
    })
}

fn parse_effort_option(entry: &Value) -> Option<EffortOption> {
    let value = entry.get("value")?.as_str()?.to_string();
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&value)
        .to_string();
    Some(EffortOption { value, name })
}

/// spec 388: effort is offered only when the session's model is driven through
/// the `configOptions` model select, where model and effort sit in one option
/// set. A `models`-object lane (Codex, Cline) keeps whatever effort its model
/// ids carry — a separate effort switch there leaves the picker's `✓` stale.
fn session_effort_state(response: &Value, control: Option<&ModelControl>) -> Option<EffortState> {
    match control {
        Some(ModelControl::ConfigOption(_)) => parse_effort_state(response.get("configOptions")),
        _ => None,
    }
}

/// spec 388: the remembered model for this session, when the agent advertises
/// it. A stale id is logged and dropped so the configured model still applies.
fn remembered_model(
    memory: &crate::acp_lane_models::LaneModelMemory,
    backend_id: &str,
    state: &SessionModelState,
) -> Option<String> {
    let id = memory.model.get(backend_id)?;
    if state.available.iter().any(|m| &m.model_id == id) {
        Some(id.clone())
    } else {
        log::info!(
            "remembered model {id} is not advertised by backend {backend_id}; using the configured model"
        );
        None
    }
}

/// spec 388: the remembered effort value to send, or `None` when there is
/// nothing to do (no entry, no effort control, not offered, already current).
fn remembered_effort(
    memory: &crate::acp_lane_models::LaneModelMemory,
    backend_id: &str,
    state: Option<&EffortState>,
) -> Option<String> {
    let value = memory.effort.get(backend_id)?;
    let Some(state) = state else {
        log::info!("backend {backend_id} offers no effort option; remembered effort ignored");
        return None;
    };
    if !state.options.iter().any(|o| &o.value == value) {
        log::warn!(
            "remembered effort {value} is not offered by backend {backend_id}; keeping the agent default"
        );
        return None;
    }
    (state.current.as_deref() != Some(value.as_str())).then(|| value.clone())
}

/// Parse the ACP `models` value into the frontend-facing
/// `(available_models, current_model_id)` pair. Tolerates a
/// missing/garbage `models` value and filters malformed entries (an entry missing
/// `modelId`/`name` is dropped rather than failing the whole parse).
fn parse_session_models(models: Option<&Value>) -> (Vec<ModelInfo>, Option<String>) {
    let Some(obj) = models.and_then(|v| v.as_object()) else {
        return (Vec::new(), None);
    };
    let available = obj
        .get("availableModels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let e = entry.as_object()?;
                    let model_id = e.get("modelId")?.as_str()?.to_string();
                    let name = e
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or(&model_id)
                        .to_string();
                    let description = e
                        .get("description")
                        .and_then(|d| d.as_str())
                        .map(|s| s.to_string());
                    Some(ModelInfo {
                        model_id,
                        name,
                        description,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let current = obj
        .get("currentModelId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    (available, current)
}

fn effective_spawn_model(configured_model: Option<String>) -> Option<String> {
    configured_model.filter(|model| !model.is_empty())
}

fn client_session_cwd(client: &AcpClient) -> Option<String> {
    client.cwd.read().ok().and_then(|g| g.clone()).or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    })
}

fn client_mcp_servers(client: &AcpClient) -> Vec<Value> {
    client
        .mcp_servers
        .read()
        .map(|g| g.clone())
        .unwrap_or_default()
}

fn set_client_session_id(client: &AcpClient, session_id: &str) {
    if let Ok(mut g) = client.acp_session_id.write() {
        *g = Some(session_id.to_string());
    }
}

// ─── AcpClient ─────────────────────────────────────────────────────

enum AcpTransport {
    Local { stdin: ChildStdin, child: Child },
    Remote(RemoteAgentTransport),
}

struct AcpClient {
    krypton_session: u64,
    backend_id: String,
    #[allow(dead_code)]
    display_name: String,
    transport: Mutex<Option<AcpTransport>>,
    instance: RwLock<InstanceObservation>,
    process_identity: RwLock<Option<crate::process_metrics::ProcessIdentity>>,
    remote_observation: RwLock<Option<Arc<crate::remote_harness::RemoteAgentObservation>>>,
    teardown_complete: tokio::sync::watch::Sender<bool>,
    pending: std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// spec 278: requests whose response the reader also announces on the
    /// event stream as a `turn_marker`, in stdout order with session updates.
    turn_markers: Mutex<HashMap<u64, &'static str>>,
    perm_pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// `_x.ai/ask_user_question` parked while the human answers the card.
    ask_pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// spec 279: ACP `elicitation/create` (form mode) parked while the human
    /// answers the card. Keyed by `elicit_seq`, not the JSON-RPC id, so string
    /// or zero ids from the agent can never collide.
    elicit_pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    elicit_seq: AtomicU64,
    /// fs/write_text_file requests parked while waiting for user accept/reject.
    fs_write_pending: Mutex<HashMap<u64, FsWriteCtx>>,
    next_id: AtomicU64,
    /// Set after `initialize` completes. Notification before this point is rare.
    agent_capabilities: RwLock<Option<Value>>,
    /// `initialize` `authMethods`; gates the spec 287 `authenticate` retry.
    auth_methods: RwLock<Vec<Value>>,
    /// Filled by `session/new` response.
    acp_session_id: RwLock<Option<String>>,
    /// Rolling stderr capture (max 64KB) — surfaced on startup failure.
    stderr_buf: Mutex<String>,
    /// Reason a request's reply never arrived: set when the subprocess
    /// disconnects mid-flight so `request()` can report the real cause
    /// (a stderr tail when captured) instead of a bare "closed before reply".
    disconnect_reason: RwLock<Option<String>>,
    /// PID of the spawned adapter, set right after `cmd.spawn()`. 0 = unset
    /// (pre-spawn or post-dispose). Read by the metrics sampler to walk the
    /// adapter's process tree without taking the `child` mutex.
    child_pid: AtomicU32,
    /// Working directory the child was spawned in — also reported as project root
    /// in `session/new`. Falls back to the host process cwd when None.
    cwd: RwLock<Option<String>>,
    /// MCP servers passed through to `session/new`.
    mcp_servers: RwLock<Vec<Value>>,
    /// Model id chosen by the user via `acp_harness.lane_models` config — applied
    /// after `session/new` for backends that advertise model state over ACP. For
    /// backends that take a CLI flag (Gemini, Droid), the override is applied to
    /// spawn args before the client is created.
    model_override: RwLock<Option<String>>,
    /// How this session switches models; set from the session/new, resume, or
    /// load response. `None` until then or when no model state is advertised.
    model_control: RwLock<Option<ModelControl>>,
    /// spec 388: the reasoning-effort control, refreshed from session/new,
    /// resume/load, every `set_config_option` reply and `config_option_update`.
    effort_state: RwLock<Option<EffortState>>,
    /// Present only for remote lanes. Filesystem callbacks use the same runtime
    /// as the agent so a remote path can never fall through to local `std::fs`.
    remote_workspace: RwLock<Option<Arc<RemoteRuntimeClient>>>,
    /// Latch: once true, no more events fire.
    disposed: std::sync::atomic::AtomicBool,
    /// spec 288: wire profiler tap and this lane's identity on it.
    wire: Arc<AcpWire>,
    wire_lane: WireLane,
}

impl AcpClient {
    fn new(
        krypton_session: u64,
        backend_id: String,
        display_name: String,
        wire: Arc<AcpWire>,
        remote: bool,
        owner: AcpInstanceOwner,
    ) -> Self {
        let wire_lane = WireLane::new(krypton_session, &display_name, &backend_id, remote);
        Self {
            krypton_session,
            backend_id,
            display_name,
            transport: Mutex::new(None),
            instance: RwLock::new(InstanceObservation {
                owner,
                execution: AcpInstanceExecution {
                    kind: if remote {
                        AcpExecutionKind::Remote
                    } else {
                        AcpExecutionKind::Local
                    },
                    runtime_id: None,
                    host: None,
                },
                lifecycle: AcpInstanceLifecycle::Initializing,
                liveness: AcpInstanceLiveness::Alive,
                has_error: false,
                confirmed_model_id: None,
                model_uncertain: false,
                model_ids: Vec::new(),
                model_revision: 0,
                model_change_epoch: 0,
                active_requests: 0,
                started_at_ms: instance_now_ms(),
                last_activity_at_ms: instance_now_ms(),
            }),
            process_identity: RwLock::new(None),
            remote_observation: RwLock::new(None),
            teardown_complete: tokio::sync::watch::channel(false).0,
            pending: std::sync::Mutex::new(HashMap::new()),
            turn_markers: Mutex::new(HashMap::new()),
            perm_pending: Mutex::new(HashMap::new()),
            ask_pending: Mutex::new(HashMap::new()),
            elicit_pending: Mutex::new(HashMap::new()),
            elicit_seq: AtomicU64::new(1),
            fs_write_pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            agent_capabilities: RwLock::new(None),
            auth_methods: RwLock::new(Vec::new()),
            acp_session_id: RwLock::new(None),
            stderr_buf: Mutex::new(String::new()),
            disconnect_reason: RwLock::new(None),
            child_pid: AtomicU32::new(0),
            cwd: RwLock::new(None),
            mcp_servers: RwLock::new(Vec::new()),
            model_override: RwLock::new(None),
            model_control: RwLock::new(None),
            effort_state: RwLock::new(None),
            remote_workspace: RwLock::new(None),
            disposed: std::sync::atomic::AtomicBool::new(false),
            wire,
            wire_lane,
        }
    }
    fn touch(&self) {
        self.instance
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .last_activity_at_ms = instance_now_ms();
    }

    fn observe_models(&self, models: &SessionModelState) {
        let mut state = self.instance.write().unwrap_or_else(|p| p.into_inner());
        state.confirmed_model_id.clone_from(&models.current);
        state.model_uncertain = false;
        state.model_ids = models
            .available
            .iter()
            .map(|model| model.model_id.clone())
            .collect();
        state.model_revision += 1;
        state.last_activity_at_ms = instance_now_ms();
    }

    fn begin_request<'a>(&'a self, method: &str, params: &Value) -> InstanceRequest<'a> {
        let initializing = matches!(
            method,
            "initialize" | "session/new" | "session/load" | "session/resume"
        );
        let model = if method == "session/set_model" {
            params.get("modelId").and_then(Value::as_str)
        } else if method == "session/set_config_option" {
            let is_model = self.model_control.read().ok().is_some_and(|control|
                matches!(&*control, Some(ModelControl::ConfigOption(id)) if Some(id.as_str()) == params.get("configId").and_then(Value::as_str)));
            if is_model {
                params.get("value").and_then(Value::as_str)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(model) = model {
            *self
                .model_override
                .write()
                .unwrap_or_else(|p| p.into_inner()) = Some(model.to_string());
        }
        let mut state = self.instance.write().unwrap_or_else(|p| p.into_inner());
        state.active_requests += 1;
        state.last_activity_at_ms = instance_now_ms();
        if model.is_some() {
            state.model_change_epoch += 1;
        }
        if initializing && state.lifecycle == AcpInstanceLifecycle::Ready {
            state.lifecycle = AcpInstanceLifecycle::Initializing;
        }
        InstanceRequest {
            client: self,
            initializing,
            model_change: model.is_some(),
            model_revision: state.model_revision,
            model_change_epoch: state.model_change_epoch,
            request_id: None,
            finished: false,
        }
    }

    fn observe_disconnect(&self, confirmed_exit: bool) {
        let mut state = self.instance.write().unwrap_or_else(|p| p.into_inner());
        if state.lifecycle != AcpInstanceLifecycle::Terminating {
            let changed = state.lifecycle != AcpInstanceLifecycle::Disconnected;
            state.lifecycle = AcpInstanceLifecycle::Disconnected;
            state.has_error = true;
            if changed {
                state.last_activity_at_ms = instance_now_ms();
            }
        }
        if confirmed_exit || state.liveness == AcpInstanceLiveness::Exited {
            if state.liveness != AcpInstanceLiveness::Exited {
                state.last_activity_at_ms = instance_now_ms();
            }
            state.liveness = AcpInstanceLiveness::Exited;
        } else {
            state.liveness = AcpInstanceLiveness::Unknown;
        }
    }

    async fn snapshot(&self) -> AcpInstanceSnapshot {
        // A closed stdout is not proof that the local process ended.
        if self.child_pid.load(Ordering::Relaxed) != 0 {
            let mut transport = self.transport.lock().await;
            if let Some(AcpTransport::Local { child, .. }) = transport.as_mut() {
                match child.try_wait() {
                    Ok(Some(_)) => self.observe_disconnect(true),
                    Ok(None) => {
                        self.instance
                            .write()
                            .unwrap_or_else(|p| p.into_inner())
                            .liveness = AcpInstanceLiveness::Alive;
                    }
                    Err(_) => self.observe_disconnect(false),
                }
            }
        }
        if self
            .remote_observation
            .read()
            .ok()
            .is_some_and(|observation| {
                observation
                    .as_ref()
                    .is_some_and(|observation| observation.exited())
            })
        {
            self.observe_disconnect(true);
        }
        let waiting = !self.perm_pending.lock().await.is_empty()
            || !self.ask_pending.lock().await.is_empty()
            || !self.elicit_pending.lock().await.is_empty()
            || !self.fs_write_pending.lock().await.is_empty();
        let state = self.instance.read().unwrap_or_else(|p| p.into_inner());
        let pid = self.child_pid.load(Ordering::Relaxed);
        AcpInstanceSnapshot {
            session: self.krypton_session,
            backend_id: self.backend_id.clone(),
            owner: state.owner.clone(),
            cwd: self
                .cwd
                .read()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_default(),
            acp_session_id: self.acp_session_id.read().ok().and_then(|g| g.clone()),
            execution: state.execution.clone(),
            pid: (pid != 0).then_some(pid),
            lifecycle: state.lifecycle,
            activity: if waiting {
                AcpInstanceActivity::Waiting
            } else if state.active_requests > 0 {
                AcpInstanceActivity::Running
            } else {
                AcpInstanceActivity::Idle
            },
            liveness: state.liveness,
            has_error: state.has_error,
            requested_model_id: self.model_override.read().ok().and_then(|g| g.clone()),
            confirmed_model_id: state.confirmed_model_id.clone(),
            model_uncertain: state.model_uncertain,
            started_at_ms: state.started_at_ms,
            last_activity_at_ms: state.last_activity_at_ms,
        }
    }

    fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Send a JSON-RPC request (with id) and await the response.
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_id(self.next_request_id(), method, params)
            .await
    }

    /// spec 278: like `request`, but the reader also emits a `turn_marker`
    /// event when the response arrives — ordered with the session updates
    /// around it, which an invoke result is not. Returns the request id too.
    async fn request_marked(
        &self,
        method: &str,
        params: Value,
        kind: &'static str,
    ) -> Result<(u64, Value), String> {
        let id = self.next_request_id();
        self.turn_markers.lock().await.insert(id, kind);
        let result = self.request_with_id(id, method, params).await;
        if result.is_err() {
            // Never written or never answered: no marker will consume it.
            self.turn_markers.lock().await.remove(&id);
        }
        result.map(|value| (id, value))
    }

    async fn request_with_id(&self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        let mut observation = self.begin_request(method, &params);
        observation.request_id = Some(id);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            pending.insert(id, tx);
        }
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let result = match self.write_line(&payload).await {
            Err(error) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(error)
            }
            Ok(()) => match rx.await {
                Ok(v) => {
                    if let Some(err) = v.get("error") {
                        Err(format!("{method} failed: {err}"))
                    } else {
                        Ok(v.get("result").cloned().unwrap_or(Value::Null))
                    }
                }
                Err(_) => {
                    // The oneshot was dropped without a reply — almost always
                    // `finalize_disconnect` clearing `pending` after the subprocess
                    // went away. Surface the captured cause if it set one.
                    let detail = self.disconnect_reason.read().ok().and_then(|g| g.clone());
                    match detail {
                        Some(reason) => Err(format!("{method}: {reason}")),
                        None => Err(format!("{method}: subprocess closed before reply")),
                    }
                }
            },
        };
        observation.finish(&result);
        result
    }

    /// Send a JSON-RPC notification (no id, no response).
    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_line(&payload).await
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut text = serde_json::to_string(value).map_err(|e| format!("serialize: {e}"))?;
        self.touch();
        let mut guard = self.transport.lock().await;
        let transport = guard
            .as_mut()
            .ok_or_else(|| "ACP stdin closed".to_string())?;
        // spec 288: recorded under the transport lock, before the write, so the
        // request is in the tap before the reader can see its response.
        self.wire.record_out(&self.wire_lane, value, &text);
        text.push('\n');
        match transport {
            AcpTransport::Local { stdin, .. } => {
                stdin
                    .write_all(text.as_bytes())
                    .await
                    .map_err(|e| format!("write: {e}"))?;
                stdin.flush().await.map_err(|e| format!("flush: {e}"))
            }
            AcpTransport::Remote(remote) => remote.write(text).await,
        }
    }

    /// Reply to an inbound JSON-RPC request from the agent.
    async fn reply(&self, id: Value, result: Result<Value, Value>) -> Result<(), String> {
        let payload = match result {
            Ok(v) => json!({"jsonrpc": "2.0", "id": id, "result": v}),
            Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": e}),
        };
        self.write_line(&payload).await
    }

    fn event_name(&self) -> String {
        format!("acp-event-{}", self.krypton_session)
    }

    fn emit_event(&self, app: &AppHandle, payload: Value) {
        if self.disposed.load(Ordering::Relaxed) {
            return;
        }
        self.wire.record_ui(&self.wire_lane, &payload);
        app.emit_or_log(&self.event_name(), payload);
    }

    async fn append_stderr(&self, chunk: &str) {
        let mut buf = self.stderr_buf.lock().await;
        buf.push_str(chunk);
        // Cap at 64KB; drop from the front.
        if buf.len() > 64 * 1024 {
            let drop = buf.len() - 64 * 1024;
            *buf = buf[drop..].to_string();
        }
    }

    async fn stderr_snapshot(&self) -> String {
        self.stderr_buf.lock().await.clone()
    }
}

// ─── Reader task ───────────────────────────────────────────────────

async fn run_reader<R>(client: Arc<AcpClient>, app: AppHandle, mut reader: BufReader<R>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                log::info!("[acp:{}] subprocess stdout closed", client.krypton_session);
                break;
            }
            Ok(_) => {
                dispatch_output_line(&client, &app, &line).await;
            }
            Err(e) => {
                log::warn!("[acp:{}] read error: {e}", client.krypton_session);
                break;
            }
        }
    }
    finalize_disconnect(&client, &app).await;
}

async fn run_remote_reader(
    client: Arc<AcpClient>,
    app: AppHandle,
    mut events: tokio::sync::mpsc::UnboundedReceiver<RemoteAgentEvent>,
) {
    while let Some(event) = events.recv().await {
        match event {
            RemoteAgentEvent::Stdout(line) => dispatch_output_line(&client, &app, &line).await,
            RemoteAgentEvent::Stderr(line) => {
                log::debug!("[acp:{}] remote stderr: {line}", client.krypton_session);
                client.append_stderr(&format!("{line}\n")).await;
            }
            RemoteAgentEvent::Exit(code) => {
                client.observe_disconnect(true);
                log::info!(
                    "[acp:{}] remote adapter exited code={code:?}",
                    client.krypton_session
                );
                break;
            }
            RemoteAgentEvent::Disconnected => {
                client.observe_disconnect(false);
                break;
            }
        }
    }
    finalize_disconnect(&client, &app).await;
}

async fn dispatch_output_line(client: &Arc<AcpClient>, app: &AppHandle, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(error) => {
            client.wire.record_in(&client.wire_lane, None, trimmed);
            log::debug!(
                "[acp:{}] dropping non-JSON line ({error}): {trimmed}",
                client.krypton_session
            );
            return;
        }
    };
    client
        .wire
        .record_in(&client.wire_lane, Some(&value), trimmed);
    dispatch_message(client, app, value).await;
}

async fn dispatch_message(client: &Arc<AcpClient>, app: &AppHandle, value: Value) {
    let has_id = value.get("id").is_some();
    let has_method = value.get("method").is_some();

    if has_id && has_method {
        // Inbound request from the agent.
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let method = value
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        let c = client.clone();
        let a = app.clone();
        tokio::spawn(async move {
            handle_inbound_request(c, a, id, method, params).await;
        });
        return;
    }

    if has_id {
        // Response to one of our requests.
        let id = value.get("id").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
        let marker = client.turn_markers.lock().await.remove(&id);
        if let Some(kind) = marker {
            client.emit_event(app, turn_marker_event(kind, id, &value));
        }
        let mut pending = client.pending.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tx) = pending.remove(&id) {
            let _ = tx.send(value);
        } else {
            log::debug!(
                "[acp:{}] response for unknown id {id}",
                client.krypton_session
            );
        }
        return;
    }

    if has_method {
        // Notification.
        let method = value
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        handle_notification(client, app, &method, params);
        return;
    }

    log::debug!(
        "[acp:{}] dropping malformed message: {value}",
        client.krypton_session
    );
}

/// Percent-encode a path the way Grok names session directories under
/// `~/.grok/sessions/`: every byte outside unreserved (`A–Z a–z 0–9 - . _ ~`)
/// becomes `%XX` (so `/` → `%2F`). Matches Python `urllib.parse.quote(s, safe='')`.
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Grok home directory (`$GROK_HOME` or `~/.grok`).
fn grok_home_dir() -> Option<std::path::PathBuf> {
    if let Ok(h) = std::env::var("GROK_HOME") {
        let p = std::path::PathBuf::from(h);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }
    dirs::home_dir().map(|h| h.join(".grok"))
}

/// Session tree Grok uses for a project cwd:
/// `~/.grok/sessions/<percent-encoded-cwd>/` (plan.md, images/, etc.).
fn grok_session_dir_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    let trimmed = cwd.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(
        grok_home_dir()?
            .join("sessions")
            .join(percent_encode_path(trimmed)),
    )
}

/// True when `resolved` lies under Grok's session directory for this project.
/// Used so plan.md / session scratch (outside the project root) stay readable
/// and writable over ACP fs/* without opening the whole home directory.
fn is_under_grok_session_dir(cwd: &str, resolved: &std::path::Path) -> bool {
    let Some(session_root) = grok_session_dir_for_cwd(cwd) else {
        return false;
    };
    let session_root = std::fs::canonicalize(&session_root).unwrap_or(session_root);
    resolved.starts_with(&session_root)
}

/// Resolve `raw_path` against the lane cwd the same way `validate_fs_path` does.
fn resolve_fs_path(cwd: &str, raw_path: &str) -> std::path::PathBuf {
    let root = std::fs::canonicalize(cwd).unwrap_or_else(|_| std::path::PathBuf::from(cwd));
    let candidate = std::path::PathBuf::from(raw_path);
    let abs = if candidate.is_absolute() {
        candidate
    } else {
        root.join(&candidate)
    };
    let mut probe = abs.clone();
    loop {
        match std::fs::canonicalize(&probe) {
            Ok(p) => {
                let suffix = abs.strip_prefix(&probe).unwrap_or(std::path::Path::new(""));
                return p.join(suffix);
            }
            Err(_) => match probe.parent() {
                Some(parent) => probe = parent.to_path_buf(),
                None => return abs,
            },
        }
    }
}

/// Read vs write for Spec 89 path scoping. Grok no longer advertises
/// `readTextFile` (spec 228 — native `read_file` embeds images), but
/// leftover ACP reads and all Grok writes still hit this gate. Grok
/// `fs/*` is unrestricted: its list/grep/bash already escape the
/// project, so scoping ACP I/O only broke sibling repos (and hid the
/// write-review card). OMP gets the same out-of-root pass: it reads disk
/// natively (spec 122) and its only fs/* traffic is `edit`/`write`, which
/// would otherwise die as "Path outside project root" (e.g. `/tmp` scratch).
/// Other lanes keep Spec 89 scoping — their shell tools are permission-gated,
/// so ACP fs was the last unprompted path. Grok/OMP writes still go through
/// the Spec 89 review card (or Grok session-scratch auto-apply); this enum
/// only decides whether the request is rejected before that gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FsAccess {
    Read,
    Write,
}

/// Whether `resolved` may be served for this access + backend.
/// Project root and the current project's Grok session tree always pass
/// (reads and writes). Out-of-root Grok/OMP fs/* also passes — writes still
/// wait on the review card. Other lanes stay Spec 89 scoped.
fn fs_path_in_scope(
    root: &std::path::Path,
    cwd: &str,
    resolved: &std::path::Path,
    _access: FsAccess,
    backend_id: &str,
) -> bool {
    // In-project and Grok session-scratch paths: both reads and writes.
    if resolved.starts_with(root) || is_under_grok_session_dir(cwd, resolved) {
        return true;
    }
    // Out-of-root: Grok and OMP only. Not a second scope check — there is
    // no remaining path filter once this matches. Writes still hit
    // the review card in handle_inbound_request.
    matches!(backend_id, "grok" | "omp")
}

/// Reject fs/* requests that escape the lane's project root — except Grok's
/// session scratch under `~/.grok/sessions/<encoded-cwd>/` (every file there,
/// not just plan.md). Grok/OMP `fs/*` is additionally unscoped (see `FsAccess`);
/// out-of-root Grok/OMP writes still wait on the review card. When `cwd` is
/// unset (rare — fallback session), we pass through without enforcement.
async fn validate_fs_path(
    client: &Arc<AcpClient>,
    raw_path: &str,
    access: FsAccess,
) -> Result<(), Value> {
    if raw_path.is_empty() {
        return Err(json!({ "code": -32602, "message": "Empty path" }));
    }
    let cwd_opt = match client.cwd.read() {
        Ok(g) => g.clone(),
        Err(_) => return Ok(()),
    };
    let Some(cwd) = cwd_opt else {
        return Ok(());
    };
    if let Some(runtime) = client
        .remote_workspace
        .read()
        .ok()
        .and_then(|workspace| workspace.clone())
    {
        let candidate = if std::path::Path::new(raw_path).is_absolute() {
            raw_path.to_string()
        } else {
            std::path::Path::new(&cwd)
                .join(raw_path)
                .to_string_lossy()
                .to_string()
        };
        return runtime
            .canonicalize(&candidate)
            .await
            .map(|_| ())
            .map_err(|_| {
                json!({
                    "code": -32602,
                    "message": format!("Path outside remote project root: {raw_path}"),
                })
            });
    }
    let root = match std::fs::canonicalize(&cwd) {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    let resolved = resolve_fs_path(&cwd, raw_path);
    if fs_path_in_scope(&root, &cwd, &resolved, access, &client.backend_id) {
        return Ok(());
    }
    Err(json!({
        "code": -32602,
        "message": format!("Path outside project root: {}", raw_path),
    }))
}

/// Whether this path is Grok session scratch (auto-write, no review card).
async fn is_grok_session_scratch_path(client: &Arc<AcpClient>, raw_path: &str) -> bool {
    if client
        .remote_workspace
        .read()
        .map(|workspace| workspace.is_some())
        .unwrap_or(false)
    {
        return false;
    }
    let cwd_opt = match client.cwd.read() {
        Ok(g) => g.clone(),
        Err(_) => return false,
    };
    let Some(cwd) = cwd_opt else {
        return false;
    };
    is_under_grok_session_dir(&cwd, &resolve_fs_path(&cwd, raw_path))
}

/// Apply an fs write immediately (mkdir + write), used for session-scratch
/// auto-approval and shared with the permission-gated path.
fn apply_fs_write(path: &str, content: &str) -> Result<Value, Value> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Err(json!({ "code": -32000, "message": format!("mkdir: {e}") }));
        }
    }
    match std::fs::write(path, content) {
        Ok(_) => Ok(json!({})),
        Err(e) => Err(json!({ "code": -32000, "message": format!("write: {e}") })),
    }
}

async fn read_client_text(client: &AcpClient, path: &str) -> Result<Option<String>, String> {
    let remote = client
        .remote_workspace
        .read()
        .ok()
        .and_then(|workspace| workspace.clone());
    if let Some(remote) = remote {
        remote.read_text(path).await
    } else {
        match std::fs::read_to_string(path) {
            Ok(content) => Ok(Some(content)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
}

async fn apply_client_fs_write(
    client: &AcpClient,
    path: &str,
    content: &str,
) -> Result<Value, Value> {
    let remote = client
        .remote_workspace
        .read()
        .ok()
        .and_then(|workspace| workspace.clone());
    if let Some(remote) = remote {
        remote
            .write_text(path, content)
            .await
            .map(|_| json!({}))
            .map_err(|error| json!({ "code": -32000, "message": error }))
    } else {
        apply_fs_write(path, content)
    }
}

/// Context held while a fs/write_text_file request waits for the user's decision.
struct FsWriteCtx {
    reply: oneshot::Sender<Result<Value, Value>>,
    path: String,
    new_content: String,
}

/// Grok remaps every `read_file` through ACP when this is true, which
/// makes screenshots fail UTF-8 (spec 228). OMP tries ACP first and falls
/// back to disk, so every out-of-root read left a red
/// `Path outside project root` chip despite succeeding. Other lanes keep the
/// capability so reads stay auditable. Writes stay advertised for every backend.
fn advertise_read_text_file(backend_id: &str) -> bool {
    !matches!(backend_id, "grok" | "omp")
}

/// `initialize.clientCapabilities`. Krypton runs no client terminals
/// (`terminal: false`), but it declares the Zed terminal convention (spec 380
/// phase 3): claude-agent-acp and codex-acp then report a command's output in
/// `_meta.terminal_output` and its exit code in `_meta.terminal_exit`, and
/// the TypeScript lane adapter reads both. Rust only forwards them.
fn client_capabilities(backend_id: &str) -> Value {
    json!({
        "fs": {
            "readTextFile": advertise_read_text_file(backend_id),
            "writeTextFile": true,
        },
        "terminal": false,
        // spec 279: every lane renders form elicitations as a question card.
        "elicitation": { "form": {} },
        "_meta": { "terminal_output": true },
    })
}

/// Magic-byte image sniff — png/jpeg/gif/webp only, never the extension.
/// Shared with `read_image_file` (spec 281), which must not trust names.
pub(crate) fn sniff_image_magic(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if head.len() >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF {
        return Some("image/jpeg");
    }
    if head.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Sniff for the error chip only — not a general mime detector.
fn sniff_binary_kind(path: &str, head: &[u8]) -> &'static str {
    if let Some(mime) = sniff_image_magic(head) {
        return mime;
    }
    if head.starts_with(b"%PDF") {
        return "application/pdf";
    }
    if head.starts_with(b"PK") {
        return "application/zip";
    }
    if head.starts_with(b"\0asm") {
        return "application/wasm";
    }
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "wasm" => "application/wasm",
        _ => "binary",
    }
}

fn binary_read_error(path: &str) -> String {
    use std::io::Read;
    let mut kind = "binary";
    let mut head = [0u8; 16];
    if let Ok(mut file) = std::fs::File::open(path) {
        if let Ok(n) = file.read(&mut head) {
            kind = sniff_binary_kind(path, &head[..n]);
        }
    }
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    format!("binary file ({kind}, {bytes} bytes); fs/read_text_file is text-only")
}

fn emit_fs_activity(
    client: &Arc<AcpClient>,
    app: &AppHandle,
    method: &str,
    path: &str,
    ok: bool,
    error: Option<&str>,
) {
    let mut payload = json!({
        "type": "fs_activity",
        "method": method,
        "path": path,
        "ok": ok,
    });
    if let Some(msg) = error {
        if let Some(map) = payload.as_object_mut() {
            map.insert("error".to_string(), json!(msg));
        }
    }
    client.emit_event(app, payload);
}

/// Grok 1.0.5 `AskUserQuestionExtResponse` is internally tagged on `outcome`
/// (`accepted` | `skip_interview` | `chat_about_this`), not serde's default `type`.
/// Sending `type` fails with `missing field 'outcome'`.
fn grok_ask_user_ext_response(decision: Value) -> Value {
    let Value::Object(mut map) = decision else {
        return decision;
    };
    if !map.contains_key("outcome") {
        if let Some(tag) = map.remove("type") {
            map.insert("outcome".to_string(), tag);
        }
    } else {
        map.remove("type");
    }
    Value::Object(map)
}

fn grok_ask_user_skip() -> Value {
    json!({ "outcome": "skip_interview" })
}

fn elicitation_cancel() -> Value {
    json!({ "action": "cancel" })
}

/// spec 279: ACP `CreateElicitationResponse` is `accept` | `decline` | `cancel`.
/// Anything malformed from the frontend collapses to `cancel` so the agent
/// never receives an invalid response shape.
fn elicitation_reply(response: Value) -> Value {
    match response.get("action").and_then(Value::as_str) {
        Some("accept") => {
            let content = response
                .get("content")
                .filter(|c| c.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            json!({ "action": "accept", "content": content })
        }
        Some("decline") => json!({ "action": "decline" }),
        _ => elicitation_cancel(),
    }
}

/// Normalize Grok's ask_user_question params into `{ question, options, multiSelect }`.
fn extract_ask_questions(params: &Value) -> Vec<Value> {
    let raw = params.get("questions").or_else(|| {
        params
            .get("params")
            .and_then(|inner| inner.get("questions"))
    });
    let Some(arr) = raw.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let question = item
            .get("question")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let options = item
            .get("options")
            .and_then(|v| v.as_array())
            .map(|opts| {
                opts.iter()
                    .filter_map(|opt| {
                        let label = opt.get("label").and_then(|v| v.as_str())?;
                        if label.is_empty() {
                            return None;
                        }
                        Some(json!({
                            "label": label,
                            "description": opt.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                            "preview": opt.get("preview").and_then(|v| v.as_str()),
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if question.trim().is_empty() && options.is_empty() {
            continue;
        }
        let multi = item
            .get("multiSelect")
            .or_else(|| item.get("multi_select"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        out.push(json!({
            "question": question,
            "options": options,
            "multiSelect": multi,
        }));
    }
    out
}

async fn handle_inbound_request(
    client: Arc<AcpClient>,
    app: AppHandle,
    id: Value,
    method: String,
    params: Value,
) {
    let mut observation = client.begin_request(&method, &params);
    // Inbound work contributes activity; individual handlers own their errors.
    observation.finished = true;
    match method.as_str() {
        "fs/read_text_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Err(err) = validate_fs_path(&client, &path, FsAccess::Read).await {
                let msg = err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("path scope")
                    .to_string();
                emit_fs_activity(&client, &app, "read", &path, false, Some(&msg));
                let _ = client.reply(id, Err(err)).await;
                return;
            }
            let result = match read_client_text(&client, &path).await {
                Ok(Some(content)) => {
                    emit_fs_activity(&client, &app, "read", &path, true, None);
                    Ok(json!({ "content": content }))
                }
                Ok(None) => {
                    log::debug!("[acp] fs/read_text_file: {path} not found, returning empty");
                    // NotFound returns empty content per existing behavior; surface
                    // it as a successful read so users still see the access attempt.
                    emit_fs_activity(&client, &app, "read", &path, true, None);
                    Ok(json!({ "content": "" }))
                }
                Err(e) => {
                    let msg = if client
                        .remote_workspace
                        .read()
                        .map(|workspace| workspace.is_none())
                        .unwrap_or(false)
                        && e.contains("stream did not contain valid UTF-8")
                    {
                        binary_read_error(&path)
                    } else {
                        e
                    };
                    emit_fs_activity(&client, &app, "read", &path, false, Some(&msg));
                    Err(json!({ "code": -32000, "message": format!("fs/read_text_file: {msg}") }))
                }
            };
            let _ = client.reply(id, result).await;
        }
        "fs/write_text_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // Path scoping (Spec 89 Phase C): reject *writes* outside the lane's
            // project root (Grok session scratch under ~/.grok/sessions/<encoded-cwd>/
            // is allowed — every file in that tree, not just plan.md).
            // Grok/OMP fs/* is unrestricted so out-of-root writes reach the
            // review card instead of dying as "Path outside project root";
            // other lanes stay Spec-89 scoped.
            if let Err(err) = validate_fs_path(&client, &path, FsAccess::Write).await {
                let msg = err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("path scope")
                    .to_string();
                emit_fs_activity(&client, &app, "write", &path, false, Some(&msg));
                let _ = client.reply(id, Err(err)).await;
                return;
            }
            // Grok plan.md / session files: auto-apply (matches Grok TUI plan-mode
            // auto-approve for the plan file; no review card spam).
            if is_grok_session_scratch_path(&client, &path).await {
                let result = apply_client_fs_write(&client, &path, &content).await;
                match &result {
                    Ok(_) => emit_fs_activity(&client, &app, "write", &path, true, None),
                    Err(err) => {
                        let msg = err
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("write failed")
                            .to_string();
                        emit_fs_activity(&client, &app, "write", &path, false, Some(&msg));
                    }
                }
                let _ = client.reply(id, result).await;
                return;
            }
            // Compute oldText against current disk content for the diff preview.
            let old_text = read_client_text(&client, &path)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
            let request_id = id.as_u64().unwrap_or(0);
            let (tx, rx) = oneshot::channel::<Result<Value, Value>>();
            {
                let mut pending = client.fs_write_pending.lock().await;
                pending.insert(
                    request_id,
                    FsWriteCtx {
                        reply: tx,
                        path: path.clone(),
                        new_content: content.clone(),
                    },
                );
            }
            client.touch();
            client.emit_event(
                &app,
                json!({
                    "type": "fs_write_pending",
                    "requestId": request_id,
                    "path": path,
                    "oldText": old_text,
                    "newText": content,
                }),
            );
            // Wait for frontend decision via acp_fs_write_response.
            let outcome = rx.await;
            let result: Result<Value, Value> = match outcome {
                Ok(decision) => decision,
                Err(_) => Err(
                    json!({ "code": -32000, "message": "fs/write_text_file: decision channel dropped" }),
                ),
            };
            match &result {
                Ok(_) => emit_fs_activity(&client, &app, "write", &path, true, None),
                Err(err) => {
                    let msg = err
                        .get("message")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "write failed".to_string());
                    emit_fs_activity(&client, &app, "write", &path, false, Some(&msg));
                }
            }
            let _ = client.reply(id, result).await;
        }
        // Grok plan-mode approval (wire method uses a leading underscore).
        // Without this, exit_plan_mode fails with "client disconnected" and the
        // lane sticks in plan mode forever. Auto-approve so the agent can leave
        // plan mode under ACP (no Grok TUI). Verified against grok 1.0.3:
        // params { sessionId, toolCallId, planContent }, result { outcome, feedback }.
        "x.ai/exit_plan_mode" | "_x.ai/exit_plan_mode" => {
            let plan_content = params
                .get("planContent")
                .or_else(|| params.get("plan_content"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_call_id = params
                .get("toolCallId")
                .or_else(|| params.get("tool_call_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            log::info!(
                "[acp:{}] Grok exit_plan_mode: auto-approving (toolCallId={tool_call_id}, plan_len={})",
                client.krypton_session,
                plan_content.len()
            );
            client.emit_event(
                &app,
                json!({
                    "type": "session_update",
                    "kind": "tool_call_update",
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": tool_call_id,
                        "status": "completed",
                        "title": "Plan approved (harness)",
                        "content": [{
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": if plan_content.is_empty() {
                                    "Plan mode exit approved (empty plan).".to_string()
                                } else {
                                    format!("Plan approved:\n{plan_content}")
                                }
                            }
                        }],
                    },
                }),
            );
            let _ = client
                .reply(
                    id,
                    Ok(json!({
                        "outcome": "approved",
                        "feedback": Value::Null,
                    })),
                )
                .await;
        }
        // Grok TUI question card (spec 229). Dual prefix matches exit_plan_mode.
        // Do not auto-answer — park until the frontend replies.
        "x.ai/ask_user_question" | "_x.ai/ask_user_question" => {
            let questions = extract_ask_questions(&params);
            if questions.is_empty() {
                log::info!(
                    "[acp:{}] Grok ask_user_question: rejecting empty questions",
                    client.krypton_session
                );
                let _ = client
                    .reply(
                        id,
                        Err(json!({
                            "code": -32602,
                            "message": "Invalid params: no questions provided",
                        })),
                    )
                    .await;
                return;
            }
            let tool_call_id = params
                .get("toolCallId")
                .or_else(|| params.get("tool_call_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let request_id = id.as_u64().unwrap_or(0);
            let (tx, rx) = oneshot::channel();
            {
                let mut pending = client.ask_pending.lock().await;
                // Grok TUI replaces the active question by cancelling the previous.
                for (_, old) in pending.drain() {
                    let _ = old.send(grok_ask_user_skip());
                }
                pending.insert(request_id, tx);
            }
            client.touch();
            log::info!(
                "[acp:{}] Grok ask_user_question: parking {} question(s) (toolCallId={tool_call_id})",
                client.krypton_session,
                questions.len()
            );
            client.emit_event(
                &app,
                json!({
                    "type": "ask_user_question",
                    "requestId": request_id,
                    "questions": questions,
                    "toolCallId": tool_call_id,
                }),
            );
            let decision = match rx.await {
                Ok(value) => grok_ask_user_ext_response(value),
                Err(_) => grok_ask_user_skip(),
            };
            let _ = client.reply(id, Ok(decision)).await;
        }
        // spec 279: ACP form elicitation (OMP `/review` menu, plan approval,
        // extension select/confirm/input/editor; any agent may send it because
        // `initialize` advertises `elicitation.form`). Park until the frontend
        // card answers; never auto-answer.
        "elicitation/create" => {
            let mode = params.get("mode").and_then(Value::as_str).unwrap_or("");
            let schema = params.get("requestedSchema").filter(|s| s.is_object());
            let Some(schema) = schema.filter(|_| mode == "form").cloned() else {
                log::info!(
                    "[acp:{}] elicitation/create: declining unsupported mode {mode:?}",
                    client.krypton_session
                );
                let _ = client.reply(id, Ok(json!({ "action": "decline" }))).await;
                return;
            };
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let tool_call_id = params
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let request_id = client.elicit_seq.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = oneshot::channel();
            client.elicit_pending.lock().await.insert(request_id, tx);
            client.touch();
            client.emit_event(
                &app,
                json!({
                    "type": "elicitation_request",
                    "requestId": request_id,
                    "message": message,
                    "requestedSchema": schema,
                    "toolCallId": tool_call_id,
                }),
            );
            let response = match rx.await {
                Ok(value) => elicitation_reply(value),
                Err(_) => elicitation_cancel(),
            };
            let _ = client.reply(id, Ok(response)).await;
        }
        "session/request_permission" => {
            // Bridge to the frontend.
            let request_id = id.as_u64().unwrap_or(0);
            let (tx, rx) = oneshot::channel();
            {
                let mut perm = client.perm_pending.lock().await;
                perm.insert(request_id, tx);
            }
            client.touch();
            client.emit_event(
                &app,
                json!({
                    "type": "permission_request",
                    "requestId": request_id,
                    "params": params,
                }),
            );
            // Wait for frontend to respond via acp_permission_response.
            match rx.await {
                Ok(outcome) => {
                    let _ = client.reply(id, Ok(json!({ "outcome": outcome }))).await;
                }
                Err(_) => {
                    // Subprocess died or dispose: synthesize cancelled.
                    let _ = client
                        .reply(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })))
                        .await;
                }
            }
        }
        _ => {
            log::debug!(
                "[acp:{}] unknown inbound method {method}; replying with method-not-found",
                client.krypton_session
            );
            let _ = client
                .reply(
                    id,
                    Err(json!({"code": -32601, "message": format!("Method not found: {method}")})),
                )
                .await;
        }
    }
}

fn handle_notification(client: &Arc<AcpClient>, app: &AppHandle, method: &str, params: Value) {
    client.touch();
    match method {
        "session/update" => {
            let update_kind = params
                .get("update")
                .and_then(|u| u.get("sessionUpdate"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let update = params.get("update").cloned().unwrap_or(Value::Null);
            if update_kind == "current_model_update" {
                if let Some(model) = update.get("currentModelId").and_then(Value::as_str) {
                    let mut state = client.instance.write().unwrap_or_else(|p| p.into_inner());
                    state.confirmed_model_id = Some(model.to_string());
                    state.model_revision += 1;
                    state.model_uncertain = false;
                }
            } else if update_kind == "config_option_update" {
                let models = parse_session_model_state(&update);
                if models.control.is_some() {
                    client.observe_models(&models);
                }
                refresh_effort_from(client, &update);
            }
            match update_kind {
                "agent_message_chunk"
                | "user_message_chunk"
                | "agent_thought_chunk"
                | "tool_call"
                | "tool_call_update"
                | "plan"
                | "usage_update"
                | "available_commands_update"
                | "current_mode_update"
                | "session_info_update" => {
                    client.emit_event(
                        app,
                        json!({
                            "type": "session_update",
                            "kind": update_kind,
                            "update": update,
                        }),
                    );
                }
                other => {
                    log::debug!(
                        "[acp:{}] dropping session/update kind {other}",
                        client.krypton_session
                    );
                }
            }
        }
        other => {
            log::debug!(
                "[acp:{}] dropping notification {other}",
                client.krypton_session
            );
        }
    }
}

async fn finalize_disconnect(client: &Arc<AcpClient>, app: &AppHandle) {
    client.observe_disconnect(false);
    app.state::<Arc<crate::connected_computers::ConnectedComputerManager>>()
        .revoke_session(client.krypton_session);
    // Capture *why* the subprocess went away before waking the in-flight
    // requests, so each reports the real cause instead of a bare "closed
    // before reply". The write must land BEFORE `pending.clear()`: dropping a
    // oneshot sender is what wakes its awaiting `request()`, so the reason has
    // to be visible by the time the read side observes the drop.
    let detail = disconnect_detail(&client.backend_id, &client.stderr_snapshot().await);
    if let Ok(mut slot) = client.disconnect_reason.write() {
        *slot = Some(detail.clone());
    }
    // Cancel all pending request oneshots.
    {
        let mut pending = client.pending.lock().unwrap_or_else(|p| p.into_inner());
        pending.clear();
    }
    {
        let mut perm = client.perm_pending.lock().await;
        perm.clear();
    }
    {
        let mut asks = client.ask_pending.lock().await;
        asks.clear();
    }
    {
        let mut elicits = client.elicit_pending.lock().await;
        elicits.clear();
    }
    {
        let mut writes = client.fs_write_pending.lock().await;
        writes.clear();
    }
    if !client.disposed.load(Ordering::Relaxed) {
        client.emit_event(
            app,
            json!({
                "type": "stop",
                "stopReason": "cancelled",
                "reason": "subprocess exited",
            }),
        );
    }
}

// ─── Stderr task ───────────────────────────────────────────────────

async fn run_stderr_capture<R>(client: Arc<AcpClient>, mut reader: BufReader<R>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                log::debug!(
                    "[acp:{}] stderr: {}",
                    client.krypton_session,
                    line.trim_end()
                );
                client.append_stderr(&line).await;
            }
            Err(_) => break,
        }
    }
}

// ─── Registry ──────────────────────────────────────────────────────

struct UnresolvedRemoteInstance {
    snapshot: AcpInstanceSnapshot,
    observation: Arc<crate::remote_harness::RemoteAgentObservation>,
}

#[derive(Default)]
struct RegistryEntries {
    clients: HashMap<u64, Arc<AcpClient>>,
    unresolved: HashMap<u64, UnresolvedRemoteInstance>,
}

pub struct AcpRegistry {
    next_session: AtomicU64,
    entries: RwLock<RegistryEntries>,
}

impl AcpRegistry {
    pub fn new() -> Self {
        Self {
            next_session: AtomicU64::new(1),
            entries: RwLock::new(RegistryEntries::default()),
        }
    }

    fn allocate_session(&self) -> u64 {
        self.next_session.fetch_add(1, Ordering::Relaxed)
    }

    fn get(&self, session: u64) -> Option<Arc<AcpClient>> {
        self.entries.read().ok()?.clients.get(&session).cloned()
    }
    fn set_owner(&self, session: u64, owner: AcpInstanceOwner) -> Result<(), String> {
        let client = self
            .get(session)
            .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
        client.instance.write().map_err(|e| e.to_string())?.owner = owner;
        Ok(())
    }

    fn insert(&self, session: u64, client: Arc<AcpClient>) {
        {
            let mut state = client.instance.write().unwrap_or_else(|p| p.into_inner());
            state.started_at_ms = instance_now_ms();
            state.last_activity_at_ms = state.started_at_ms;
        }
        if let Ok(mut entries) = self.entries.write() {
            entries.clients.insert(session, client);
        }
    }

    fn snapshot_clients(&self) -> Vec<Arc<AcpClient>> {
        self.entries
            .read()
            .map(|entries| entries.clients.values().cloned().collect())
            .unwrap_or_default()
    }

    fn snapshot_pids(&self) -> Vec<(u64, crate::process_metrics::ProcessIdentity)> {
        let Ok(entries) = self.entries.read() else {
            return Vec::new();
        };
        entries
            .clients
            .values()
            .filter_map(|client| {
                let identity = *client.process_identity.read().ok()?;
                identity.map(|identity| (client.krypton_session, identity))
            })
            .collect()
    }

    async fn list_instances(&self) -> Result<Vec<AcpInstanceSnapshot>, String> {
        // Capture both collections atomically. No registry lock survives an
        // await, process observation, or copying per-client metadata.
        let (clients, mut snapshots) = {
            let mut entries = self.entries.write().map_err(|e| e.to_string())?;
            entries
                .unresolved
                .retain(|_, entry| !entry.observation.exited());
            (
                entries.clients.values().cloned().collect::<Vec<_>>(),
                entries
                    .unresolved
                    .values()
                    .map(|entry| entry.snapshot.clone())
                    .collect::<Vec<_>>(),
            )
        };
        snapshots.reserve(clients.len());
        for client in clients {
            snapshots.push(client.snapshot().await);
        }
        snapshots.sort_unstable_by_key(|snapshot| snapshot.session);
        Ok(snapshots)
    }

    async fn dispose(self: &Arc<Self>, session: u64) {
        let Some(client) = self.get(session) else {
            return;
        };
        let mut completion = client.teardown_complete.subscribe();
        if !client.disposed.swap(true, Ordering::AcqRel) {
            {
                let mut state = client.instance.write().unwrap_or_else(|p| p.into_inner());
                state.lifecycle = AcpInstanceLifecycle::Terminating;
                state.last_activity_at_ms = instance_now_ms();
            }
            // Tauri callers may disappear while teardown awaits the adapter.
            // The single detached owner still finishes and retires the epoch.
            let registry = self.clone();
            let owner = client.clone();
            tokio::spawn(async move {
                dispose_client(&owner).await;
                registry.retire(&owner).await;
                owner.teardown_complete.send_replace(true);
            });
        }
        let _ = completion.wait_for(|finished| *finished).await;
    }

    async fn retire(&self, client: &AcpClient) {
        let session = client.krypton_session;
        let mut snapshot = client.snapshot().await;
        let observation = client
            .remote_observation
            .read()
            .ok()
            .and_then(|g| g.clone());
        let mut entries = self.entries.write().unwrap_or_else(|p| p.into_inner());
        if entries.clients.remove(&session).is_none() {
            return; // Another disposer already retired this exact epoch.
        }
        if let Some(observation) = observation.filter(|observation| !observation.exited()) {
            snapshot.lifecycle = AcpInstanceLifecycle::Disconnected;
            snapshot.liveness = AcpInstanceLiveness::Unknown;
            snapshot.activity = AcpInstanceActivity::Idle;
            entries.unresolved.insert(
                session,
                UnresolvedRemoteInstance {
                    snapshot,
                    observation,
                },
            );
        }
    }
}

impl Default for AcpRegistry {
    fn default() -> Self {
        Self::new()
    }
}
#[tauri::command]
pub async fn acp_list_instances(
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<Vec<AcpInstanceSnapshot>, String> {
    registry.list_instances().await
}

#[tauri::command]
pub fn acp_set_instance_owner(
    session: u64,
    owner: AcpInstanceOwner,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
    registry.set_owner(session, owner)
}

// ─── Tauri commands ────────────────────────────────────────────────

#[tauri::command]
pub fn acp_list_backends() -> Result<Vec<AcpBackendDescriptor>, String> {
    let mut out: Vec<AcpBackendDescriptor> = builtin_backends()
        .iter()
        .map(|(id, b)| AcpBackendDescriptor {
            id: (*id).to_string(),
            display_name: b.display_name.clone(),
            command: b.command.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: each arg is an IPC field.
pub async fn acp_spawn(
    backend_id: String,
    cwd: Option<String>,
    owner: AcpInstanceOwner,
    mcp_servers: Option<Vec<Value>>,
    cline_mcp_settings_path: Option<String>,
    remote_runtime_id: Option<String>,
    computer_capability: Option<String>,
    app: AppHandle,
    registry: State<'_, Arc<AcpRegistry>>,
    remote_registry: State<'_, Arc<RemoteHarnessRegistry>>,
    config: State<'_, Arc<RwLock<crate::config::KryptonConfig>>>,
    wire: State<'_, Arc<AcpWire>>,
    connected_computers: State<'_, Arc<crate::connected_computers::ConnectedComputerManager>>,
) -> Result<u64, String> {
    let mut backend =
        resolve_backend(&backend_id).ok_or_else(|| format!("Unknown ACP backend: {backend_id}"))?;

    let display_name = if backend.display_name.is_empty() {
        backend_id.clone()
    } else {
        backend.display_name.clone()
    };

    // Resolve the configured active model; empty values use the adapter default.
    let configured_model = effective_spawn_model(
        config
            .read()
            .ok()
            .and_then(|cfg| cfg.acp_harness.lane_models.get(&backend_id).cloned())
            .map(|m| m.active),
    );

    // Backends that take the model via CLI flag — apply before spawn.
    if let Some(ref model) = configured_model {
        if backend_id == "droid" {
            backend.args.push("-m".to_string());
            backend.args.push(model.clone());
        }
    }

    if backend_id == "antigravity" {
        if remote_runtime_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
        {
            return Err("Antigravity lanes are local-only".to_string());
        }
        let (command, args) = crate::acp_install::resolve(&app, &crate::acp_install::ANTIGRAVITY)
            .await
            .map_err(|e| format!("Antigravity install failed: {e}. {ANTIGRAVITY_INSTALL_HINT}"))?;
        backend.command = command.to_string_lossy().into_owned();
        backend.args = args;
    }

    let session = registry.allocate_session();
    let remote = remote_runtime_id
        .as_deref()
        .is_some_and(|id| !id.is_empty());
    let client = Arc::new(AcpClient::new(
        session,
        backend_id.clone(),
        display_name,
        wire.inner().clone(),
        remote,
        owner,
    ));
    if let Ok(mut g) = client.cwd.write() {
        *g = cwd.clone().or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        });
    }
    if let Ok(mut g) = client.mcp_servers.write() {
        *g = mcp_servers.unwrap_or_default();
    }
    if let Ok(mut g) = client.model_override.write() {
        *g = configured_model.clone();
    }

    if let Some(runtime_id) = remote_runtime_id.filter(|id| !id.is_empty()) {
        let runtime = remote_registry
            .get(&runtime_id)
            .ok_or_else(|| format!("Unknown remote Harness: {runtime_id}"))?;
        {
            let mut state = client.instance.write().unwrap_or_else(|p| p.into_inner());
            state.execution.runtime_id = Some(runtime.runtime_id().to_string());
            state.execution.host = Some(runtime.host().to_string());
        }
        let remote_cwd = cwd
            .clone()
            .ok_or_else(|| "remote ACP spawn requires a working directory".to_string())?;
        let mut env = HashMap::new();
        if backend_id == "cline" {
            if let Some(path) = cline_mcp_settings_path.filter(|path| !path.is_empty()) {
                env.insert("CLINE_MCP_SETTINGS_PATH".to_string(), path);
            }
        }
        let handle = runtime
            .spawn_agent(
                backend.command.clone(),
                backend.args.clone(),
                remote_cwd,
                env,
            )
            .await
            .map_err(|error| {
                format!(
                    "Failed to spawn remote {} {}: {error}. {}",
                    backend.command,
                    backend.args.join(" "),
                    startup_hint(&backend_id, &error)
                )
            })?;
        if let Ok(mut workspace) = client.remote_workspace.write() {
            *workspace = Some(runtime);
        }
        let crate::remote_harness::RemoteAgentHandle { transport, events } = handle;
        *client
            .remote_observation
            .write()
            .unwrap_or_else(|p| p.into_inner()) = Some(transport.observation());
        *client.transport.lock().await = Some(AcpTransport::Remote(transport));
        registry.insert(session, client.clone());
        tokio::spawn(run_remote_reader(client, app, events));
    } else {
        let mut cmd = Command::new(&backend.command);
        cmd.args(&backend.args)
            .envs(crate::pty::cached_login_env().iter())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(ref capability) = computer_capability {
            cmd.env("KRYPTON_COMPUTER_CAPABILITY", capability);
            if let Some(path) = resolve_kryptonctl_path(&app) {
                cmd.env("KRYPTONCTL_PATH", path);
            }
        }
        #[cfg(unix)]
        cmd.process_group(0);
        if let Some(d) = cwd.as_ref() {
            cmd.current_dir(d);
        }
        if backend_id == "cline" {
            if let Some(path) = cline_mcp_settings_path.filter(|path| !path.is_empty()) {
                cmd.env("CLINE_MCP_SETTINGS_PATH", path);
            }
        }
        let mut child = cmd.spawn().map_err(|e| {
            let message = e.to_string();
            format!(
                "Failed to spawn {} {}: {e}. {}",
                backend.command,
                backend.args.join(" "),
                startup_hint(&backend_id, &message)
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "child stdin missing".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "child stdout missing".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "child stderr missing".to_string())?;
        if let Some(pid) = child.id() {
            client.child_pid.store(pid, Ordering::Relaxed);
            *client
                .process_identity
                .write()
                .unwrap_or_else(|p| p.into_inner()) =
                crate::process_metrics::ProcessIdentity::capture(pid);
        }
        *client.transport.lock().await = Some(AcpTransport::Local { stdin, child });
        if let Some(ref capability) = computer_capability {
            connected_computers.bind_session(capability, session)?;
        }
        registry.insert(session, client.clone());
        let reader_client = client.clone();
        let reader_app = app.clone();
        tokio::spawn(async move {
            let buf = BufReader::new(stdout);
            run_reader(reader_client, reader_app, buf).await;
        });
        tokio::spawn(async move {
            let buf = BufReader::new(stderr);
            run_stderr_capture(client, buf).await;
        });
    }

    Ok(session)
}

/// spec 322: Claude and Codex spawn through `npx -y <adapter>@latest`. The first
/// spawn after an adapter release installs it into the npx cache before the
/// adapter can answer `initialize` (Codex is ~336 MB with its bundled CLI; ~3
/// minutes was observed), so those lanes get a longer budget than an adapter
/// that is already on disk.
fn initialize_timeout(backend_id: &str) -> Duration {
    match backend_id {
        "claude" | "codex" => Duration::from_secs(300),
        _ => Duration::from_secs(30),
    }
}

#[tauri::command]
pub async fn acp_initialize(
    session: u64,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<AgentInitInfo, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;

    let init_params = json!({
        "protocolVersion": 1,
        "clientCapabilities": client_capabilities(&client.backend_id),
        "clientInfo": { "name": "krypton", "version": env!("CARGO_PKG_VERSION") },
    });

    let init_timeout = initialize_timeout(&client.backend_id);
    let init =
        match tokio::time::timeout(init_timeout, client.request("initialize", init_params)).await {
            Ok(Ok(init)) => init,
            Ok(Err(e)) => {
                let stderr = client.stderr_snapshot().await;
                return Err(format!(
                    "{e}. {}",
                    startup_hint(&client.backend_id, &stderr)
                ));
            }
            Err(_) => {
                let stderr = client.stderr_snapshot().await;
                return Err(format!(
                    "ACP initialize timed out after {}s. {}",
                    init_timeout.as_secs(),
                    startup_hint(&client.backend_id, &stderr)
                ));
            }
        };

    let proto = init
        .get("protocolVersion")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let auth_methods = init
        .get("authMethods")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let capabilities = init
        .get("agentCapabilities")
        .cloned()
        .unwrap_or(Value::Null);

    let steering_supported = steering_supported(&init);

    if let Ok(mut g) = client.agent_capabilities.write() {
        *g = Some(capabilities.clone());
    }
    if let Ok(mut g) = client.auth_methods.write() {
        g.clone_from(&auth_methods);
    }

    Ok(AgentInitInfo {
        agent_protocol_version: proto,
        auth_methods,
        agent_capabilities: capabilities,
        steering_supported,
    })
}

/// spec 278: the `turn_marker` event for a marked response. `outcome` is the
/// steering result's outcome (null for a prompt or an error response).
fn turn_marker_event(kind: &str, id: u64, response: &Value) -> Value {
    let outcome = response
        .get("result")
        .and_then(|r| r.get("outcome"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({ "type": "turn_marker", "kind": kind, "requestId": id, "outcome": outcome })
}

/// Copy the JSON-RPC id into an object result so the frontend can match it
/// with its `turn_marker`.
fn with_request_id(mut result: Value, id: u64) -> Value {
    if let Some(obj) = result.as_object_mut() {
        obj.insert("_kryptonRequestId".to_string(), json!(id));
    }
    result
}

/// spec 278: `_meta.steering.supported` on the initialize response — the
/// vendor steering extension claude-agent-acp and codex-acp both advertise.
fn steering_supported(init: &Value) -> bool {
    init.get("_meta")
        .and_then(|m| m.get("steering"))
        .and_then(|s| s.get("supported"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Replace the `mcpServers` list that `acp_session_new` will forward to the
/// agent. Must be called between `acp_initialize` and `acp_session_new` if the
/// frontend wants to inject capability-gated servers.
#[tauri::command]
pub async fn acp_set_mcp_servers(
    session: u64,
    mcp_servers: Vec<Value>,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    if let Ok(mut g) = client.mcp_servers.write() {
        *g = mcp_servers;
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_session_new(
    session: u64,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<AgentSessionInfo, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;

    // Project root for session/new: the cwd we spawned the child with, falling
    // back to the host process cwd. Without this, the agent treats `/` as the
    // project root and reads/writes happen at filesystem root.
    let session_cwd = client_session_cwd(&client);
    let mcp_servers = client_mcp_servers(&client);

    let new_session = request_with_auth_retry(
        &client,
        "session/new",
        json!({
            "cwd": session_cwd,
            "mcpServers": mcp_servers,
        }),
        Some(Duration::from_secs(30)),
    )
    .await?;

    let acp_session_id = new_session
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            client
                .instance
                .write()
                .unwrap_or_else(|p| p.into_inner())
                .has_error = true;
            "session/new: missing sessionId".to_string()
        })?
        .to_string();
    set_client_session_id(&client, &acp_session_id);

    // Surface the agent-advertised model list to the frontend (spec 127) and
    // remember how this session switches models.
    let model_state = parse_session_model_state(&new_session);
    client.observe_models(&model_state);
    set_client_model_control(&client, model_state.control.clone());
    set_client_effort(
        &client,
        session_effort_state(&new_session, model_state.control.as_ref()),
    );

    // spec 388: a harness lane's remembered pick replaces the configured model
    // when the agent advertises it.
    let memory = harness_lane_memory(&client);
    if let Some(model) = memory
        .as_ref()
        .and_then(|m| remembered_model(m, &client.backend_id, &model_state))
    {
        if let Ok(mut g) = client.model_override.write() {
            *g = Some(model);
        }
    }

    // Apply the configured model AFTER session/new (never as a session/new field),
    // awaited inline so the switch completes before the frontend can send the first
    // prompt. Non-fatal: a rejected or unavailable model leaves the agent default.
    let apply = apply_session_model(&client, &acp_session_id, &model_state).await;

    // spec 388: effort AFTER the model — a model switch can move the agent's
    // effort. Non-fatal: a failure keeps the agent default.
    if let Some(memory) = &memory {
        let effort = client_effort(&client);
        if let (Some(value), Some(state)) = (
            remembered_effort(memory, &client.backend_id, effort.as_ref()),
            effort.as_ref(),
        ) {
            if let Err(e) = send_effort(&client, &acp_session_id, &state.config_id, &value).await {
                log::warn!(
                    "remembered effort {value} for backend {}: {e}",
                    client.backend_id
                );
            }
        }
    }

    // Do not restore the pre-switch default after an alias or timed-out change.
    let current_model_id = client
        .instance
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .confirmed_model_id
        .clone();
    let requested_model_id = client.model_override.read().ok().and_then(|g| g.clone());

    Ok(AgentSessionInfo {
        session_id: acp_session_id,
        model_apply_failed: apply.failed,
        available_models: model_state.available,
        current_model_id,
        requested_model_id,
        effort: client_effort(&client),
        modes: new_session.get("modes").cloned(),
    })
}

fn set_client_model_control(client: &AcpClient, control: Option<ModelControl>) {
    if let Ok(mut g) = client.model_control.write() {
        *g = control;
    }
}

fn client_model_control(client: &AcpClient) -> Option<ModelControl> {
    client.model_control.read().ok().and_then(|g| g.clone())
}

fn set_client_effort(client: &AcpClient, effort: Option<EffortState>) {
    if let Ok(mut g) = client.effort_state.write() {
        *g = effort;
    }
}

fn client_effort(client: &AcpClient) -> Option<EffortState> {
    client.effort_state.read().ok().and_then(|g| g.clone())
}

/// spec 388: re-read the effort control from a payload that carries the full
/// `configOptions` (a `set_config_option` reply or a `config_option_update`).
/// A payload without `configOptions` (e.g. `session/set_model`'s empty reply)
/// leaves the state alone.
fn refresh_effort_from(client: &AcpClient, payload: &Value) {
    if payload.get("configOptions").is_none() {
        return;
    }
    let control = client_model_control(client);
    set_client_effort(client, session_effort_state(payload, control.as_ref()));
}

/// spec 388: the remembered picks, only for harness lanes — Inline AI, Commit
/// Explainer, Assist, Rails judges and session probes never read them.
fn harness_lane_memory(client: &AcpClient) -> Option<crate::acp_lane_models::LaneModelMemory> {
    let role = client
        .instance
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .owner
        .role;
    (role == AcpInstanceRole::HarnessLane).then(crate::acp_lane_models::load)
}

/// spec 388: send `session/set_config_option` for the effort control (10 s).
/// Refreshes the stored state from the reply; when the reply carries no
/// `configOptions`, the accepted value becomes current.
async fn send_effort(
    client: &AcpClient,
    acp_session_id: &str,
    config_id: &str,
    value: &str,
) -> Result<(), String> {
    let params = json!({ "sessionId": acp_session_id, "configId": config_id, "value": value });
    match tokio::time::timeout(
        Duration::from_secs(10),
        client.request("session/set_config_option", params),
    )
    .await
    {
        Ok(Ok(reply)) => {
            if reply.get("configOptions").is_some() {
                refresh_effort_from(client, &reply);
            } else if let Ok(mut g) = client.effort_state.write() {
                if let Some(state) = g.as_mut() {
                    state.current = Some(value.to_string());
                }
            }
            Ok(())
        }
        Ok(Err(e)) => Err(format!("session/set_config_option {config_id} failed: {e}")),
        Err(_) => Err(format!(
            "session/set_config_option {config_id} timed out; state uncertain"
        )),
    }
}

#[tauri::command]
pub async fn acp_session_list(
    session: u64,
    cwd: Option<String>,
    cursor: Option<String>,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<Value, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let mut params = serde_json::Map::new();
    if let Some(cwd) = cwd {
        params.insert("cwd".to_string(), json!(cwd));
    }
    if let Some(cursor) = cursor {
        params.insert("cursor".to_string(), json!(cursor));
    }
    client.request("session/list", Value::Object(params)).await
}

async fn acp_session_restore(
    client: Arc<AcpClient>,
    method: &str,
    session_id: String,
) -> Result<AgentSessionInfo, String> {
    let session_cwd = client_session_cwd(&client);
    let mcp_servers = client_mcp_servers(&client);
    let response = request_with_auth_retry(
        &client,
        method,
        json!({
            "sessionId": &session_id,
            "cwd": session_cwd,
            "mcpServers": mcp_servers,
        }),
        None,
    )
    .await?;
    set_client_session_id(&client, &session_id);
    // Resumed/loaded sessions keep whatever model they were saved with — v1 does
    // not force them to the current config, so no apply is attempted here. But we
    // DO surface any advertised model list/current id so the picker works on
    // restored lanes too (spec 127, Codex-1 #2). When the backend advertises no
    // model state, available_models is empty and the picker stays disabled.
    let model_state = parse_session_model_state(&response);
    client.observe_models(&model_state);
    let effort = session_effort_state(&response, model_state.control.as_ref());
    set_client_model_control(&client, model_state.control);
    // spec 388: the effort strip works on restored lanes, but nothing is forced.
    set_client_effort(&client, effort.clone());
    Ok(AgentSessionInfo {
        session_id,
        model_apply_failed: false,
        available_models: model_state.available,
        current_model_id: model_state.current,
        requested_model_id: None,
        effort,
        modes: response.get("modes").cloned(),
    })
}

#[tauri::command]
pub async fn acp_session_resume(
    session: u64,
    session_id: String,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<AgentSessionInfo, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    acp_session_restore(client, "session/resume", session_id).await
}

#[tauri::command]
pub async fn acp_session_load(
    session: u64,
    session_id: String,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<AgentSessionInfo, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    acp_session_restore(client, "session/load", session_id).await
}

/// Outcome of a live model switch (spec 127). Distinguished so the frontend can
/// hard-revert its optimistic chip on a rejected id but NOT on a timeout — after
/// the client-side timeout the agent may still apply the switch, so reverting
/// would fight the agent. A rejected id is surfaced as `Err`, not an outcome.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetModelOutcome {
    Ok,
    TimedOutUncertain,
}

/// Switch the model of a LIVE lane (spec 127). Unlike the spawn-time
/// `apply_session_model` (silent, non-fatal), this is user-initiated, so a
/// rejected/unknown id is returned as `Err` for the frontend to surface and
/// revert. A timeout is `Ok(TimedOutUncertain)` — the request may still complete
/// agent-side, so the frontend keeps its optimistic state and marks it uncertain.
#[tauri::command]
pub async fn acp_set_lane_model(
    session: u64,
    model_id: String,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<SetModelOutcome, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let acp_session_id = client
        .acp_session_id
        .read()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| "lane has no active session".to_string())?;
    // A lane whose session advertised no control keeps the historical
    // `session/set_model` request.
    let control = client
        .model_control
        .read()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(ModelControl::SetModel);
    let (method, params) = control.request(&acp_session_id, &model_id);
    match tokio::time::timeout(Duration::from_secs(10), client.request(method, params)).await {
        Ok(Ok(reply)) => {
            // spec 388: the model switch may have moved the agent's effort.
            refresh_effort_from(&client, &reply);
            Ok(SetModelOutcome::Ok)
        }
        Ok(Err(e)) => Err(format!("{method} failed: {e}")),
        Err(_) => {
            log::warn!(
                "acp_set_lane_model {method} modelId={model_id} timed out for backend {}",
                client.backend_id
            );
            Ok(SetModelOutcome::TimedOutUncertain)
        }
    }
}

/// spec 388: the live lane's reasoning-effort control, as last observed. The
/// picker reads it on open and again after a model switch.
#[tauri::command]
pub fn acp_lane_effort(
    session: u64,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<Option<EffortState>, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    Ok(client_effort(&client))
}

/// spec 388: set the live lane's reasoning effort. A value the lane does not
/// offer, a rejection and a timeout are all `Err` (nothing is remembered).
#[tauri::command]
pub async fn acp_set_lane_effort(
    session: u64,
    value: String,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<EffortState, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let acp_session_id = client
        .acp_session_id
        .read()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| "lane has no active session".to_string())?;
    let state = client_effort(&client).ok_or_else(|| "lane offers no effort option".to_string())?;
    if !state.options.iter().any(|o| o.value == value) {
        return Err(format!("effort {value} is not offered by this lane"));
    }
    send_effort(&client, &acp_session_id, &state.config_id, &value).await?;
    client_effort(&client).ok_or_else(|| "effort option disappeared after the switch".to_string())
}

/// spec 388: remember a confirmed picker choice for a backend in
/// `~/.config/krypton/acp-lane-models.toml`. Only the harness model picker
/// calls this; other model switches are never remembered.
#[tauri::command]
pub fn acp_remember_lane_choice(
    backend_id: String,
    model_id: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    if resolve_backend(&backend_id).is_none() {
        return Err(format!("Unknown ACP backend: {backend_id}"));
    }
    crate::acp_lane_models::remember(&backend_id, model_id.as_deref(), effort.as_deref())
}

/// Switch the agent-side mode of the live session (`session/set_mode`, spec
/// 333). Inline AI forces the backend's asking mode so a user default that
/// approves on its own (Claude `auto`) cannot run state-changing commands past
/// its permission fence. Rejection and timeout are both `Err`: a mode that did
/// not verifiably apply must not let the turn run.
#[tauri::command]
pub async fn acp_set_session_mode(
    session: u64,
    mode_id: String,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let acp_session_id = client
        .acp_session_id
        .read()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| "no active session".to_string())?;
    let params = json!({ "sessionId": acp_session_id, "modeId": mode_id });
    match tokio::time::timeout(
        Duration::from_secs(10),
        client.request("session/set_mode", params),
    )
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("session/set_mode failed: {e}")),
        Err(_) => Err("session/set_mode timed out".to_string()),
    }
}

/// Apply the lane's configured model after `session/new`. `failed` is `true`
/// only when a model was requested, the agent advertised model state, and the
/// switch request (`session/set_model` or `session/set_config_option`, per
/// `ModelControl`) errored/timed out. Never fatal — a misspelled or unavailable
/// model id must not stop the lane starting.
async fn apply_session_model(
    client: &AcpClient,
    acp_session_id: &str,
    state: &SessionModelState,
) -> ModelApplyResult {
    let no_op = ModelApplyResult { failed: false };
    let Some(control) = &state.control else {
        return no_op; // no advertised model state — nothing to switch
    };
    let Some(model) = client.model_override.read().ok().and_then(|g| g.clone()) else {
        return no_op; // no spawn model requested — agent default is used
    };
    // Sent verbatim (so aliases like `opus`/`sonnet` resolve adapter-side); any
    // failure is logged with the backend id + requested model and is non-fatal.
    let (method, params) = control.request(acp_session_id, &model);
    let res = tokio::time::timeout(Duration::from_secs(10), client.request(method, params)).await;
    match res {
        Ok(Ok(reply)) => {
            // spec 388: the model switch may have moved the agent's effort.
            refresh_effort_from(client, &reply);
            ModelApplyResult { failed: false }
        }
        Ok(Err(e)) => {
            log::warn!(
                "{method} modelId={model} failed for backend {}: {e}",
                client.backend_id
            );
            ModelApplyResult { failed: true }
        }
        Err(_) => {
            log::warn!(
                "{method} modelId={model} timed out for backend {}",
                client.backend_id
            );
            ModelApplyResult { failed: true }
        }
    }
}

#[tauri::command]
pub async fn acp_prompt(
    session: u64,
    blocks: Value,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<Value, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let acp_session_id = client
        .acp_session_id
        .read()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| "session not initialized".to_string())?;
    // spec 278: marked, so the reply's place among the session updates is known.
    let (id, result) = client
        .request_marked(
            "session/prompt",
            json!({ "sessionId": acp_session_id, "prompt": blocks }),
            "prompt",
        )
        .await?;
    Ok(with_request_id(result, id))
}

/// spec 278: inject a user message into the running turn through the
/// `_session/steering` extension. Returns the raw `{ outcome }` result plus
/// `_kryptonRequestId`, which its ordered `turn_marker` carries too. The
/// `promptRequired` idle behavior keeps claude-agent-acp from starting a turn
/// the harness never sees; adapters that don't know it ignore the `_meta`.
#[tauri::command]
pub async fn acp_steer(
    session: u64,
    blocks: Value,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<Value, String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let acp_session_id = client
        .acp_session_id
        .read()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| "session not initialized".to_string())?;
    let (id, result) = client
        .request_marked(
            "_session/steering",
            json!({
                "sessionId": acp_session_id,
                "prompt": blocks,
                "_meta": { "steering": { "idleBehavior": "promptRequired" } },
            }),
            "steer",
        )
        .await?;
    Ok(with_request_id(result, id))
}

#[tauri::command]
pub async fn acp_cancel(session: u64, registry: State<'_, Arc<AcpRegistry>>) -> Result<(), String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    {
        let mut asks = client.ask_pending.lock().await;
        for (_, tx) in asks.drain() {
            let _ = tx.send(grok_ask_user_skip());
        }
    }
    {
        let mut elicits = client.elicit_pending.lock().await;
        for (_, tx) in elicits.drain() {
            let _ = tx.send(elicitation_cancel());
        }
    }
    let acp_session_id = match client.acp_session_id.read().ok().and_then(|g| g.clone()) {
        Some(s) => s,
        None => return Ok(()),
    };
    client
        .notify("session/cancel", json!({ "sessionId": acp_session_id }))
        .await
}

#[tauri::command]
pub async fn acp_permission_response(
    session: u64,
    request_id: u64,
    option_id: Option<String>,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let mut perm = client.perm_pending.lock().await;
    if let Some(tx) = perm.remove(&request_id) {
        let outcome = match option_id {
            Some(opt) => json!({ "outcome": "selected", "optionId": opt }),
            None => json!({ "outcome": "cancelled" }),
        };
        let _ = tx.send(outcome);
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_ask_user_response(
    session: u64,
    request_id: u64,
    decision: Value,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let mut pending = client.ask_pending.lock().await;
    if let Some(tx) = pending.remove(&request_id) {
        let _ = tx.send(grok_ask_user_ext_response(decision));
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_elicitation_response(
    session: u64,
    request_id: u64,
    response: Value,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let mut pending = client.elicit_pending.lock().await;
    if let Some(tx) = pending.remove(&request_id) {
        let _ = tx.send(response);
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_fs_write_response(
    session: u64,
    request_id: u64,
    accept: bool,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
    let ctx = {
        let mut pending = client.fs_write_pending.lock().await;
        pending.remove(&request_id)
    };
    let Some(ctx) = ctx else {
        return Ok(());
    };
    let outcome: Result<Value, Value> = if accept {
        apply_client_fs_write(&client, &ctx.path, &ctx.new_content).await
    } else {
        Err(json!({ "code": -32000, "message": "User rejected the write" }))
    };
    let _ = ctx.reply.send(outcome);
    Ok(())
}

#[tauri::command]
pub async fn acp_dispose(
    session: u64,
    registry: State<'_, Arc<AcpRegistry>>,
    connected_computers: State<'_, Arc<crate::connected_computers::ConnectedComputerManager>>,
) -> Result<(), String> {
    connected_computers.revoke_session(session);
    registry.dispose(session).await;
    Ok(())
}

/// Tear down every registered transport without hiding stopping instances.
pub async fn dispose_all(registry: &Arc<AcpRegistry>) {
    let sessions: Vec<u64> = registry
        .snapshot_clients()
        .iter()
        .map(|client| client.krypton_session)
        .collect();
    for session in sessions {
        registry.dispose(session).await;
    }
}

/// Tear down an `AcpClient`: signal its process group (adapter + MCP
/// grandchildren) with SIGTERM, then SIGKILL on timeout. Used by both the
/// per-session `acp_dispose` command and the app-shutdown drain.
async fn dispose_client(client: &AcpClient) {
    client
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
    client.turn_markers.lock().await.clear();
    client.perm_pending.lock().await.clear();
    client.ask_pending.lock().await.clear();
    client.elicit_pending.lock().await.clear();
    client.fs_write_pending.lock().await.clear();
    client.wire.forget_session(client.krypton_session);
    let transport = client.transport.lock().await.take();
    match transport {
        Some(AcpTransport::Remote(remote)) => {
            let observation = remote.observation();
            if remote.terminate().await.is_ok() {
                let _ =
                    tokio::time::timeout(Duration::from_secs(2), observation.wait_for_exit()).await;
            }
            client.observe_disconnect(observation.exited());
        }
        Some(AcpTransport::Local { stdin, mut child }) => {
            drop(stdin);
            #[cfg(unix)]
            {
                if let Some(pid) = child.id() {
                    // Negative pid = signal whole process group (cleans up
                    // grandchildren like MCP servers spawned by the adapter).
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGTERM);
                    }
                }
            }
            let wait_result = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            if !matches!(wait_result, Ok(Ok(_))) {
                #[cfg(unix)]
                {
                    if let Some(pid) = child.id() {
                        unsafe {
                            libc::kill(-(pid as i32), libc::SIGKILL);
                        }
                    }
                }
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
            client.observe_disconnect(matches!(child.try_wait(), Ok(Some(_))));
        }
        None => {}
    }
    client.child_pid.store(0, Ordering::Relaxed);
    *client
        .process_identity
        .write()
        .unwrap_or_else(|p| p.into_inner()) = None;
    *client
        .remote_workspace
        .write()
        .unwrap_or_else(|p| p.into_inner()) = None;
}

// ─── Lane resource metrics ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AcpLaneMetrics {
    pub session: u64,
    pub root_pid: u32,
    pub root_alive: bool,
    pub cpu_ready: bool,
    pub total_cpu_percent: f64,
    pub total_rss_mb: f64,
    pub proc_count: u32,
    pub processes: Vec<crate::process_metrics::ProcMetric>,
}

#[tauri::command]
pub fn acp_get_lane_metrics(
    registry: State<'_, Arc<AcpRegistry>>,
    sampler: State<'_, Arc<crate::process_metrics::MetricsSampler>>,
) -> Result<Vec<AcpLaneMetrics>, String> {
    let pairs = registry.snapshot_pids();
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    let roots: Vec<_> = pairs.iter().map(|(_, identity)| *identity).collect();
    let trees = sampler.collect(&roots);
    Ok(pairs
        .into_iter()
        .zip(trees)
        .map(|((session, _), t)| AcpLaneMetrics {
            session,
            root_pid: t.root_pid,
            root_alive: t.root_alive,
            cpu_ready: t.cpu_ready,
            total_cpu_percent: t.total_cpu_percent,
            total_rss_mb: t.total_rss_mb,
            proc_count: t.proc_count,
            processes: t.processes,
        })
        .collect())
}

// ─── Background task status (spec 305) ─────────────────────────────

/// How much of a background task's output file is read per poll. A `mvn`
/// reactor log is megabytes; only the tail can say whether the job finished.
const BG_TAIL_BYTES: u64 = 4096;
/// Display clamp for the one output line the harness shows per task row.
const BG_LAST_LINE_MAX: usize = 200;

/// One task to stat, as captured from the launch tool call. The path comes
/// from the adapter's own tool result, not from a guessed layout.
#[derive(Debug, Deserialize)]
pub struct BgTaskQuery {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct BgTaskStatus {
    pub id: String,
    pub exists: bool,
    pub bytes: u64,
    pub modified_ms: Option<u64>,
    /// `Some` only when the exit marker IS the file's last non-empty line.
    pub exit_code: Option<i32>,
    pub last_line: String,
}

/// Split the tail of a background-task output file into its exit code and the
/// last line of real output. Claude Code appends `[exited with code N]` as the
/// final line when the process ends; while it runs the marker is absent. Only
/// the last non-empty line is tested, so build output that happens to contain
/// the same text mid-log never reads as an exit.
fn parse_task_tail(tail: &str) -> (Option<i32>, String) {
    let mut lines = tail
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .rev();
    let last = match lines.next() {
        Some(line) => line,
        None => return (None, String::new()),
    };
    match exit_marker_code(last) {
        Some(code) => (Some(code), clamp_line(lines.next().unwrap_or(""))),
        None => (None, clamp_line(last)),
    }
}

fn exit_marker_code(line: &str) -> Option<i32> {
    line.trim()
        .strip_prefix("[exited with code ")?
        .strip_suffix(']')?
        .trim()
        .parse::<i32>()
        .ok()
}

fn clamp_line(line: &str) -> String {
    line.trim().chars().take(BG_LAST_LINE_MAX).collect()
}

/// Poll every live background task in one IPC round trip. A missing file is a
/// status (`exists: false`), not an error — the CLI removes task files and the
/// harness must keep rendering the row it already has.
#[tauri::command]
pub async fn acp_background_task_status(
    queries: Vec<BgTaskQuery>,
) -> Result<Vec<BgTaskStatus>, String> {
    let mut out = Vec::with_capacity(queries.len());
    for query in queries {
        out.push(background_task_status(query).await?);
    }
    Ok(out)
}

async fn background_task_status(query: BgTaskQuery) -> Result<BgTaskStatus, String> {
    let path = std::path::Path::new(&query.path);
    if !path.is_absolute() {
        return Err(format!(
            "background task path must be absolute: {}",
            query.path
        ));
    }
    let missing = BgTaskStatus {
        id: query.id.clone(),
        exists: false,
        bytes: 0,
        modified_ms: None,
        exit_code: None,
        last_line: String::new(),
    };
    let meta = match tokio::fs::metadata(path).await {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(missing),
        Err(e) => return Err(format!("stat {}: {e}", query.path)),
    };
    if !meta.is_file() {
        return Ok(missing);
    }
    let bytes = meta.len();
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let tail = read_tail(path, bytes).await?;
    let (exit_code, last_line) = parse_task_tail(&tail);
    Ok(BgTaskStatus {
        id: query.id,
        exists: true,
        bytes,
        modified_ms,
        exit_code,
        last_line,
    })
}

/// Read at most `BG_TAIL_BYTES` from the end of the file. A multibyte sequence
/// cut by the seek lands at the start of the buffer, which `from_utf8_lossy`
/// absorbs — the lines the caller reads are whole.
async fn read_tail(path: &std::path::Path, bytes: u64) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("open {}: {e}", path.display())),
    };
    if bytes > BG_TAIL_BYTES {
        file.seek(std::io::SeekFrom::End(-(BG_TAIL_BYTES as i64)))
            .await
            .map_err(|e| format!("seek {}: {e}", path.display()))?;
    }
    let mut buf = Vec::with_capacity(BG_TAIL_BYTES as usize);
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ─── Cross-lane MCP config bridge ──────────────────────────────────

/// Read a UTF-8 file. Returns Ok(None) if the file is missing (NOT an error,
/// since `.mcp.json` is optional). Returns Err on permission/IO/encoding
/// errors. JSON parsing happens on the frontend.
#[tauri::command]
pub async fn read_mcp_config_file(path: String) -> Result<Option<String>, String> {
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path}: {e}")),
    }
}

/// Expose the cached login-shell environment to the frontend so it can expand
/// `${VAR}` placeholders in `.mcp.json` the same way Claude Code's native
/// loader does.
#[tauri::command]
pub fn acp_login_env() -> HashMap<String, String> {
    crate::pty::cached_login_env().clone()
}

// Shared native MCP overlay path validation.

fn sanitize_overlay_path_component(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// ─── Cline native MCP overlay (ACP session/new mcpServers is dropped) ──
//
// cline 3.0.24 `initialize` advertises no `mcpCapabilities`, so http/sse servers
// passed via `session/new` never connect. Cline instead reads MCP servers from
// `cline_mcp_settings.json`; `CLINE_MCP_SETTINGS_PATH` overrides the full path to
// that file. Krypton writes a per-lane file (each lane has its own harness-memory
// URL) under ~/.config/krypton/runtime/cline/<harness>/<lane>/ and points the env
// var at it at spawn, leaving the global `~/.cline` auth/providers untouched.

fn cline_overlay_lane_dir(
    harness_id: &str,
    lane_label: &str,
) -> Result<std::path::PathBuf, String> {
    let base = crate::config::config_dir()
        .ok_or_else(|| "Could not determine config directory".to_string())?;
    Ok(base
        .join("runtime")
        .join("cline")
        .join(sanitize_overlay_path_component(harness_id))
        .join(sanitize_overlay_path_component(lane_label)))
}

/// Write `cline_mcp_settings.json` for a Cline lane; returns the full file path
/// to pass as `CLINE_MCP_SETTINGS_PATH`.
#[tauri::command]
pub fn write_cline_mcp_overlay(
    harness_id: String,
    lane_label: String,
    content: String,
) -> Result<String, String> {
    let dir = cline_overlay_lane_dir(&harness_id, &lane_label)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("cline_mcp_settings.json");
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_cline_mcp_overlay(harness_id: String, lane_label: String) -> Result<(), String> {
    let dir = cline_overlay_lane_dir(&harness_id, &lane_label)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Remove stale Cline overlays for a harness (crash recovery) before new lanes spawn.
#[tauri::command]
pub fn gc_cline_mcp_overlays(harness_id: String) -> Result<(), String> {
    let Some(base) = crate::config::config_dir() else {
        return Ok(());
    };
    let dir = base
        .join("runtime")
        .join("cline")
        .join(sanitize_overlay_path_component(&harness_id));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// spec 113 rev — Cursor native MCP delivery.
///
/// cursor-agent (verified `2026.05.28-a70ca7c`) silently ignores MCP servers
/// passed through ACP `session/new` `mcpServers` — both stdio and http — even
/// though it advertises `mcpCapabilities`. It honored them on `2026.05.20` but
/// regressed upstream. `--approve-mcps` has no effect in ACP mode either. The
/// only working path is native config: write the servers into
/// `<project_dir>/.cursor/mcp.json` and add each to cursor's per-project
/// approved list via `cursor-agent mcp enable <name>` (without approval the
/// server stays "needs approval" and never connects in ACP mode).
///
/// Merges into any existing `.cursor/mcp.json`, preserving the user's entries.
/// Returns the krypton server names written so the lane can remove them on
/// close. `mcp enable` failures are logged, not fatal (the lane still spawns).
#[tauri::command]
pub async fn prepare_cursor_mcp(
    project_dir: String,
    servers: Value,
) -> Result<Vec<String>, String> {
    let dir = std::path::Path::new(&project_dir).join(".cursor");
    let path = dir.join("mcp.json");

    let mut root: Value = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|v| v.is_object())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "internal: root not object".to_string())?;
    let mcp = obj
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    if !mcp.is_object() {
        *mcp = json!({});
    }
    let mcp_obj = mcp.as_object_mut().unwrap();

    let mut names = Vec::new();
    if let Some(incoming) = servers.as_object() {
        for (name, cfg) in incoming {
            mcp_obj.insert(name.clone(), cfg.clone());
            names.push(name.clone());
        }
    }

    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| format!("write {}: {e}", path.display()))?;

    // Pre-approve each server: native approval is the only ACP-mode path that
    // makes cursor actually connect. Same env/cwd as the lane spawn so the
    // per-project approval slug matches.
    for name in &names {
        let result = Command::new("cursor-agent")
            .args(["mcp", "enable", name])
            .envs(crate::pty::cached_login_env().iter())
            .current_dir(&project_dir)
            .output()
            .await;
        match result {
            Ok(o) if o.status.success() => {}
            Ok(o) => log::warn!(
                "cursor-agent mcp enable {name} failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            ),
            Err(e) => log::warn!("cursor-agent mcp enable {name} did not run: {e}"),
        }
    }
    Ok(names)
}

/// Remove the krypton-injected servers from `<project_dir>/.cursor/mcp.json` on
/// Cursor lane close, preserving the user's own entries. Deletes the file only
/// when it is exactly the `{"mcpServers":{}}` we would have created.
#[tauri::command]
pub fn cleanup_cursor_mcp(project_dir: String, names: Vec<String>) -> Result<(), String> {
    let path = std::path::Path::new(&project_dir)
        .join(".cursor")
        .join("mcp.json");
    if !path.exists() {
        return Ok(());
    }
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let Ok(mut root) = serde_json::from_str::<Value>(&content) else {
        return Ok(());
    };
    let Some(obj) = root.as_object_mut() else {
        return Ok(());
    };
    if let Some(mcp) = obj.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
        for name in &names {
            mcp.remove(name);
        }
    }
    let mcp_empty = obj
        .get("mcpServers")
        .and_then(|m| m.as_object())
        .map(|m| m.is_empty())
        .unwrap_or(true);
    if obj.len() == 1 && mcp_empty {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

// ─── Helpers ───────────────────────────────────────────────────────

/// Last `max_chars` characters of a stderr capture, char-boundary safe. The
/// tail is where adapters print panics / fatal errors right before exit.
fn stderr_tail(stderr: &str, max_chars: usize) -> String {
    stderr
        .chars()
        .rev()
        .take(max_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Human-facing reason for a mid-flight subprocess disconnect. Prefers the tail
/// of captured stderr; falls back to a generic notice when nothing was caught.
fn disconnect_detail(backend_id: &str, stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        format!("{backend_id} subprocess exited before replying (no stderr captured)")
    } else {
        format!(
            "{backend_id} subprocess exited — {}",
            stderr_tail(trimmed, 1024)
        )
    }
}

const ANTIGRAVITY_INSTALL_HINT: &str = "Antigravity's ACP server downloads on first use (~110 MB download, ~400 MB on disk); check network and retry.";
const ANTIGRAVITY_AUTH_HINT: &str =
    "Run `agy` once to sign in, or set `auth.type` in ~/.gemini/antigravity-acp/settings.json.";
/// spec 287: the only auth method Krypton selects on its own (personal Google
/// sign-in shared with `agy`/IDE). The server persists it to settings.json.
const ANTIGRAVITY_AUTH_METHOD: &str = "oauth-personal";
/// `authenticate` may wait on a browser sign-in. Closing the lane aborts it
/// (acp_dispose → finalize_disconnect clears `pending`).
const AUTHENTICATE_TIMEOUT: Duration = Duration::from_secs(300);

/// ACP auth-required as `request_with_id` stringifies it: code -32000 plus the
/// agent's message. Both must match; -32000 alone is a generic server error.
fn is_auth_required(error: &str) -> bool {
    error.contains("\"code\":-32000") && error.to_lowercase().contains("authentication required")
}

fn advertises_auth_method(methods: &[Value], id: &str) -> bool {
    methods
        .iter()
        .any(|method| method.get("id").and_then(Value::as_str) == Some(id))
}

async fn timed_request(
    client: &AcpClient,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    match timeout {
        Some(limit) => tokio::time::timeout(limit, client.request(method, params))
            .await
            .map_err(|_| format!("{method} timed out"))?,
        None => client.request(method, params).await,
    }
}

/// spec 287: an Antigravity session call that fails auth-required gets one
/// `authenticate { methodId: "oauth-personal" }` and one retry, when the
/// agent advertised that method. Every other backend/error passes through.
async fn request_with_auth_retry(
    client: &AcpClient,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let error = match timed_request(client, method, params.clone(), timeout).await {
        Err(error) if client.backend_id == "antigravity" && is_auth_required(&error) => error,
        other => return other,
    };
    let advertised = client
        .auth_methods
        .read()
        .map(|methods| advertises_auth_method(&methods, ANTIGRAVITY_AUTH_METHOD))
        .unwrap_or(false);
    if !advertised {
        return Err(format!("{error}. {ANTIGRAVITY_AUTH_HINT}"));
    }
    log::info!("antigravity {method}: auth required; authenticating via {ANTIGRAVITY_AUTH_METHOD}");
    match tokio::time::timeout(
        AUTHENTICATE_TIMEOUT,
        client.request(
            "authenticate",
            json!({ "methodId": ANTIGRAVITY_AUTH_METHOD }),
        ),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(auth_error)) => return Err(format!("{auth_error}. {ANTIGRAVITY_AUTH_HINT}")),
        Err(_) => {
            return Err(format!(
                "authenticate timed out after {}s. {ANTIGRAVITY_AUTH_HINT}",
                AUTHENTICATE_TIMEOUT.as_secs()
            ))
        }
    }
    timed_request(client, method, params, timeout)
        .await
        .map_err(|retry_error| {
            if is_auth_required(&retry_error) {
                format!("{retry_error}. {ANTIGRAVITY_AUTH_HINT}")
            } else {
                retry_error
            }
        })
}

fn startup_hint(backend_id: &str, stderr: &str) -> String {
    let s = stderr.to_lowercase();
    if backend_id == "cursor" {
        if s.contains("secitemcopymatching failed") {
            return "Cursor credential lookup failed. Run `cursor-agent login` in a terminal, or set `CURSOR_API_KEY` before launching Krypton.".to_string();
        }
        if s.contains("not authenticated")
            || s.contains("authentication required")
            || s.contains("please log in")
            || s.contains("please login")
            || s.contains("api key")
            || s.contains("unauthorized")
        {
            return "Run `cursor-agent login`, or export `CURSOR_API_KEY` in your login shell."
                .to_string();
        }
        if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
            return "Install Cursor Agent CLI: `curl https://cursor.com/install -fsS | bash`."
                .to_string();
        }
        if stderr.is_empty() {
            return "Cursor Agent did not return an initialize response and no stderr was captured. First-run auth or install input is a likely cause; try `cursor-agent login` in a terminal, then retry.".to_string();
        }
    }
    if backend_id == "omp" {
        if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
            return "Install OMP from https://omp.sh, then restart Krypton so the login-shell PATH cache includes `omp`.".to_string();
        }
        if s.contains("unknown command acp")
            || s.contains("unknown command: acp")
            || s.contains("unknown subcommand acp")
            || s.contains("unknown subcommand: acp")
            || s.contains("unrecognized subcommand acp")
            || s.contains("unrecognized command acp")
            || s.contains("invalid command acp")
        {
            return "Your OMP CLI predates native ACP mode. Run `omp --version` (known-good baseline: `omp/15.4.1`) and update OMP.".to_string();
        }
        if s.contains("not authenticated")
            || s.contains("please log in")
            || s.contains("please login")
            || s.contains("authentication required")
            || s.contains("unauthorized")
        {
            return "Run `omp` once in a terminal to complete auth, or export a provider API key such as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` before launching Krypton.".to_string();
        }
        if s.contains("invalid api key") || s.contains("bad token") || s.contains("api key") {
            return "OMP reports an API key problem. Re-check your provider key in the login shell used to launch Krypton.".to_string();
        }
        if stderr.is_empty() {
            return "OMP did not return an initialize response and no stderr was captured. First-run auth-broker/OAuth or install input is a likely cause; run `omp` once in a terminal, then retry.".to_string();
        }
    }
    if backend_id == "grok" {
        if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
            return "Install Grok Build CLI: `curl -fsSL https://x.ai/cli/install.sh | bash`, then restart Krypton so the login-shell PATH cache includes `grok`.".to_string();
        }
        if s.contains("unknown command")
            || s.contains("unrecognized subcommand")
            || s.contains("unknown subcommand")
            || s.contains("invalid command")
        {
            return "Your Grok CLI predates ACP mode (`grok agent stdio`). Update via `curl -fsSL https://x.ai/cli/install.sh | bash`.".to_string();
        }
        if s.contains("not authenticated")
            || s.contains("please log in")
            || s.contains("please login")
            || s.contains("authentication required")
            || s.contains("unauthorized")
        {
            return "Run `grok` once in a terminal to complete browser login, or export `XAI_API_KEY` in the login shell used to launch Krypton.".to_string();
        }
        if s.contains("invalid api key")
            || s.contains("bad token")
            || s.contains("api key")
            || s.contains("xai_api_key")
            || s.contains("api_key")
        {
            return "Grok reports an API key problem. Re-check `XAI_API_KEY` in the login shell used to launch Krypton.".to_string();
        }
        if stderr.is_empty() {
            return "Grok did not return an initialize response and no stderr was captured. First-run browser login or install input is a likely cause; run `grok` once in a terminal, then retry.".to_string();
        }
    }
    if backend_id == "copilot" {
        if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
            return "Install GitHub Copilot CLI: `npm install -g @github/copilot` (Node.js 22+), then restart Krypton so the login-shell PATH cache includes `copilot`.".to_string();
        }
        // Only treat this as an outdated CLI when stderr is an actual flag
        // diagnostic — a bare `--acp` substring would also match any error that
        // merely echoes the invocation, masking the real auth/token failure
        // below. The unknown/unrecognized phrasing covers both `--acp` and
        // `--stdio` rejection on an old build.
        if s.contains("unknown option")
            || s.contains("unknown argument")
            || s.contains("unrecognized option")
            || s.contains("unrecognized argument")
            || s.contains("unexpected argument")
            || s.contains("invalid option")
        {
            return "Your Copilot CLI predates ACP mode (`copilot --acp --stdio`). Update via `npm install -g @github/copilot`.".to_string();
        }
        if s.contains("not authenticated")
            || s.contains("please log in")
            || s.contains("please login")
            || s.contains("authentication required")
            || s.contains("unauthorized")
            || s.contains("/login")
        {
            return "Run `copilot` then `/login` once in a terminal to complete GitHub auth, or export `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` (fine-grained PAT with the Copilot Requests permission) in the login shell used to launch Krypton.".to_string();
        }
        if s.contains("invalid api key")
            || s.contains("bad token")
            || s.contains("api key")
            || s.contains("forbidden")
        {
            return "Copilot reports a token problem. Re-check `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` (needs the Copilot Requests permission) in the login shell used to launch Krypton.".to_string();
        }
        if stderr.is_empty() {
            return "Copilot did not return an initialize response and no stderr was captured. First-run `/login` or install input is a likely cause; run `copilot` once in a terminal, then retry.".to_string();
        }
    }
    if backend_id == "cline" {
        // Before the generic `/login`/`not authenticated` branch below — that
        // one names `claude /login`, which is wrong advice for a Cline lane.
        if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
            return "Install the Cline CLI: `npm i -g cline`, then restart Krypton so the login-shell PATH cache includes `cline`.".to_string();
        }
        if s.contains("unknown option")
            || s.contains("unrecognized option")
            || s.contains("unrecognized argument")
            || s.contains("unexpected argument")
            || s.contains("invalid option")
        {
            return "Your Cline CLI predates ACP mode (`cline --acp`). Update via `npm i -g cline`.".to_string();
        }
        if s.contains("not authenticated")
            || s.contains("please log in")
            || s.contains("please login")
            || s.contains("authentication required")
            || s.contains("unauthorized")
            || s.contains("/login")
        {
            return "Run `cline auth` once in a terminal to authenticate, then retry.".to_string();
        }
        if s.contains("invalid api key") || s.contains("bad token") || s.contains("api key") {
            return "Cline reports an API/token problem. Re-run `cline auth`, or re-check your provider key in the login shell used to launch Krypton.".to_string();
        }
        if stderr.is_empty() {
            return "Cline did not return an initialize response and no stderr was captured. First-run `cline auth` or install input is a likely cause; run `cline auth` in a terminal, then retry.".to_string();
        }
    }
    if backend_id == "antigravity" {
        if s.contains("authentication required") || s.contains("sign in") || s.contains("oauth") {
            return ANTIGRAVITY_AUTH_HINT.to_string();
        }
        if s.contains("localharness") || s.contains("no such file") || s.contains("enoent") {
            return "The Antigravity install looks incomplete. Quit Krypton, delete the `acp-agents/antigravity` folder in Krypton's app cache, and relaunch to reinstall.".to_string();
        }
        if stderr.is_empty() {
            return "Antigravity's ACP server did not answer initialize and no stderr was captured; retry, or check the `acp-agents/antigravity` install in Krypton's app cache.".to_string();
        }
    }
    if backend_id == "fx" {
        // Before the generic fallbacks below — they name `claude /login` and
        // the claude-agent-acp npm package, both wrong advice for fx.
        if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
            return "Install fx: `curl -fsSL https://fx.sh/setup.sh | bash` (installs to `~/.local/bin`), then restart Krypton so the login-shell PATH cache includes `fx`.".to_string();
        }
        if s.contains("unknown subcommand") {
            return "Your fx predates ACP mode (`fx acp`). Run `fx upgrade`.".to_string();
        }
        if stderr.is_empty() {
            // Not signed in: fx fails `initialize` with its own reason (which
            // precedes this hint) and writes nothing to stderr.
            return "fx wrote no diagnostics. Run `fx doctor` in a terminal to check sign-in (`fx login`) and setup, then retry.".to_string();
        }
    }
    if s.contains("/login") || s.contains("not authenticated") {
        return "Run `claude /login` in a terminal, then retry.".to_string();
    }
    if backend_id == "opencode" && (s.contains("api key") || s.contains("auth")) {
        return "Run `opencode auth login` in a terminal or configure OpenCode credentials, then retry.".to_string();
    }
    if s.contains("npm err") || s.contains("enoent") {
        return "Check network or install the adapter manually: `npm i -g @agentclientprotocol/claude-agent-acp`.".to_string();
    }
    if stderr.is_empty() {
        format!("Adapter `{backend_id}` failed to start.")
    } else {
        stderr_tail(stderr, 2048)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advertise_read_text_file, advertises_auth_method, binary_read_error, client_capabilities,
        disconnect_detail, effective_spawn_model, elicitation_reply, fs_path_in_scope,
        grok_ask_user_ext_response, grok_ask_user_skip, grok_session_dir_for_cwd, is_auth_required,
        is_under_grok_session_dir, parse_effort_state, parse_session_model_state, parse_task_tail,
        percent_encode_path, remembered_effort, remembered_model, resolve_backend,
        session_effort_state, sniff_binary_kind, startup_hint, steering_supported,
        turn_marker_event, with_request_id, EffortOption, FsAccess, ModelControl,
    };
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    #[test]
    fn task_tail_reads_the_exit_marker_only_as_the_last_line() {
        // Running: no marker yet — the last output line is what the row shows.
        assert_eq!(
            parse_task_tail("[INFO] Building TLI Entity 1.0.0\n[INFO] Tests run: 523\n"),
            (None, "[INFO] Tests run: 523".to_string())
        );
        // Finished: marker consumed, the line above it is the output shown.
        assert_eq!(
            parse_task_tail("MVN_EXIT=0\n\n[exited with code 0]\n"),
            (Some(0), "MVN_EXIT=0".to_string())
        );
        assert_eq!(
            parse_task_tail("boom\n[exited with code 137]"),
            (Some(137), "boom".to_string())
        );
        // A build that prints the same text mid-log is still running.
        assert_eq!(
            parse_task_tail("[exited with code 0]\nstill compiling\n"),
            (None, "still compiling".to_string())
        );
        // Marker alone (no output before it) leaves an empty line, not a panic.
        assert_eq!(
            parse_task_tail("[exited with code 2]\n"),
            (Some(2), String::new())
        );
        assert_eq!(parse_task_tail("   \n\n"), (None, String::new()));
        // Not the marker: a signal notice or any other bracket line stays output.
        assert_eq!(
            parse_task_tail("[killed by SIGTERM]\n"),
            (None, "[killed by SIGTERM]".to_string())
        );
    }

    #[test]
    fn elicitation_reply_keeps_valid_actions_and_cancels_malformed() {
        assert_eq!(
            elicitation_reply(json!({ "action": "accept", "content": { "value": "2. Review" } })),
            json!({ "action": "accept", "content": { "value": "2. Review" } })
        );
        // accept without an object content still yields a schema-valid reply.
        assert_eq!(
            elicitation_reply(json!({ "action": "accept", "content": "oops" })),
            json!({ "action": "accept", "content": {} })
        );
        assert_eq!(
            elicitation_reply(json!({ "action": "decline", "content": { "value": 1 } })),
            json!({ "action": "decline" })
        );
        assert_eq!(
            elicitation_reply(json!({ "type": "accepted" })),
            json!({ "action": "cancel" })
        );
    }

    #[test]
    fn grok_ask_user_ext_response_retags_type_to_outcome() {
        let accepted = grok_ask_user_ext_response(json!({
            "type": "accepted",
            "answers": [{ "question": "Q", "selected_labels": ["A"] }],
            "partial_answers": null
        }));
        assert_eq!(
            accepted,
            json!({
                "outcome": "accepted",
                "answers": [{ "question": "Q", "selected_labels": ["A"] }],
                "partial_answers": null
            })
        );
        assert_eq!(
            grok_ask_user_ext_response(json!({ "type": "skip_interview" })),
            json!({ "outcome": "skip_interview" })
        );
        assert_eq!(
            grok_ask_user_ext_response(json!({
                "outcome": "accepted",
                "type": "accepted",
                "answers": [],
                "partial_answers": null
            })),
            json!({
                "outcome": "accepted",
                "answers": [],
                "partial_answers": null
            })
        );
        assert_eq!(grok_ask_user_skip(), json!({ "outcome": "skip_interview" }));
    }

    #[test]
    fn percent_encode_path_matches_grok_session_dir_encoding() {
        assert_eq!(
            percent_encode_path("/Users/wk/Source/xenon"),
            "%2FUsers%2Fwk%2FSource%2Fxenon"
        );
        assert_eq!(
            percent_encode_path("/Users/wk/Source/krypton"),
            "%2FUsers%2Fwk%2FSource%2Fkrypton"
        );
        // Unreserved characters stay literal.
        assert_eq!(percent_encode_path("abc-._~XYZ"), "abc-._~XYZ");
    }

    #[test]
    fn grok_session_dir_for_cwd_strips_trailing_slash() {
        let a = grok_session_dir_for_cwd("/Users/wk/Source/xenon").expect("dir");
        let b = grok_session_dir_for_cwd("/Users/wk/Source/xenon/").expect("dir");
        assert_eq!(a, b);
        assert!(a.ends_with("%2FUsers%2Fwk%2FSource%2Fxenon"));
        assert!(a.to_string_lossy().contains(".grok/sessions/"));
    }

    #[test]
    fn is_under_grok_session_dir_allows_plan_md() {
        let cwd = "/Users/wk/Source/xenon";
        let session = grok_session_dir_for_cwd(cwd).expect("session");
        let plan = session.join("019ff626-1b21-70f2-8483-94797a859cee/plan.md");
        assert!(is_under_grok_session_dir(cwd, &plan));
        // Sibling project sessions must not match.
        let other = grok_session_dir_for_cwd("/Users/wk/Source/krypton")
            .expect("other")
            .join("x/plan.md");
        assert!(!is_under_grok_session_dir(cwd, &other));
        // Project root files are not session scratch (they pass via project-root rule).
        assert!(!is_under_grok_session_dir(
            cwd,
            &PathBuf::from("/Users/wk/Source/xenon/src/main.rs")
        ));
    }

    #[test]
    fn fs_path_in_scope_grok_and_omp_escape_but_other_lanes_do_not() {
        let cwd = "/Users/wk/Source/xenon";
        let root = Path::new(cwd);
        let in_project = PathBuf::from("/Users/wk/Source/xenon/src/main.rs");
        let sibling = PathBuf::from("/Users/wk/Source/krypton/docs/0212-xenon-resource-server.md");
        let skill = PathBuf::from("/Users/wk/.agents/skills/karpathy-guidelines/SKILL.md");
        let session = grok_session_dir_for_cwd(cwd)
            .expect("session")
            .join("019ff626-1b21-70f2-8483-94797a859cee/plan.md");

        assert!(fs_path_in_scope(
            root,
            cwd,
            &in_project,
            FsAccess::Read,
            "grok"
        ));
        assert!(fs_path_in_scope(
            root,
            cwd,
            &in_project,
            FsAccess::Write,
            "grok"
        ));
        assert!(fs_path_in_scope(
            root,
            cwd,
            &session,
            FsAccess::Read,
            "grok"
        ));
        assert!(fs_path_in_scope(
            root,
            cwd,
            &session,
            FsAccess::Write,
            "grok"
        ));

        // Live failure: xenon-rooted Grok reading/writing the krypton spec / skills.
        // Writes must pass the scope check so the review card can fire.
        assert!(fs_path_in_scope(
            root,
            cwd,
            &sibling,
            FsAccess::Read,
            "grok"
        ));
        assert!(fs_path_in_scope(root, cwd, &skill, FsAccess::Read, "grok"));
        assert!(fs_path_in_scope(
            root,
            cwd,
            &sibling,
            FsAccess::Write,
            "grok"
        ));
        assert!(fs_path_in_scope(root, cwd, &skill, FsAccess::Write, "grok"));

        // Live failure: OMP `edit` of `/tmp/i186/sim.py` died before the review card.
        let tmp_scratch = PathBuf::from("/tmp/i186/sim.py");
        assert!(fs_path_in_scope(
            root,
            cwd,
            &tmp_scratch,
            FsAccess::Write,
            "omp"
        ));
        assert!(fs_path_in_scope(
            root,
            cwd,
            &sibling,
            FsAccess::Write,
            "omp"
        ));

        // Other lanes keep Spec 89 scoping (Claude-1 review).
        assert!(!fs_path_in_scope(
            root,
            cwd,
            &sibling,
            FsAccess::Read,
            "claude"
        ));
        assert!(!fs_path_in_scope(
            root,
            cwd,
            &sibling,
            FsAccess::Write,
            "claude"
        ));
        assert!(!fs_path_in_scope(
            root,
            cwd,
            &skill,
            FsAccess::Read,
            "codex"
        ));
        assert!(fs_path_in_scope(
            root,
            cwd,
            &in_project,
            FsAccess::Read,
            "claude"
        ));
    }

    #[test]
    fn removed_backend_is_not_resolvable() {
        assert!(resolve_backend("mimo").is_none());
        assert!(resolve_backend("claude").is_some());
    }

    #[test]
    fn configured_model_preserves_explicit_values_and_ignores_empty_values() {
        assert_eq!(effective_spawn_model(None), None);
        assert_eq!(effective_spawn_model(Some(String::new())), None);
        assert_eq!(
            effective_spawn_model(Some("opus".to_string())).as_deref(),
            Some("opus")
        );
    }

    #[test]
    fn advertise_read_text_file_is_off_for_grok_and_omp() {
        assert!(!advertise_read_text_file("grok"));
        assert!(!advertise_read_text_file("omp"));
        for id in ["claude", "codex", "copilot", "droid", "opencode"] {
            assert!(advertise_read_text_file(id), "{id}");
        }
    }

    #[test]
    fn client_capabilities_declare_terminal_output_without_client_terminals() {
        for id in ["claude", "codex", "grok", "omp"] {
            let caps = client_capabilities(id);
            assert_eq!(caps["_meta"]["terminal_output"], json!(true), "{id}");
            assert_eq!(caps["terminal"], json!(false), "{id}");
            assert_eq!(caps["elicitation"], json!({ "form": {} }), "{id}");
            assert_eq!(
                caps["fs"]["readTextFile"],
                json!(advertise_read_text_file(id)),
                "{id}"
            );
        }
    }

    #[test]
    fn sniff_binary_kind_prefers_magic_then_extension() {
        assert_eq!(
            sniff_binary_kind("x.bin", b"\x89PNG\r\n\x1a\n"),
            "image/png"
        );
        assert_eq!(
            sniff_binary_kind("x.bin", b"\xFF\xD8\xFF\xE0"),
            "image/jpeg"
        );
        assert_eq!(sniff_binary_kind("x.bin", b"GIF89a...."), "image/gif");
        let mut webp = [0u8; 12];
        webp[..4].copy_from_slice(b"RIFF");
        webp[8..].copy_from_slice(b"WEBP");
        assert_eq!(sniff_binary_kind("x.bin", &webp), "image/webp");
        assert_eq!(sniff_binary_kind("x.bin", b"%PDF-1.4"), "application/pdf");
        assert_eq!(sniff_binary_kind("x.bin", b"PK\x03\x04"), "application/zip");
        assert_eq!(
            sniff_binary_kind("x.bin", b"\0asm\x01\x00\x00\x00"),
            "application/wasm"
        );
        assert_eq!(sniff_binary_kind("shot.png", &[0, 1, 2, 3]), "image/png");
        assert_eq!(sniff_binary_kind("x.bin", &[0, 1, 2, 3]), "binary");
    }

    #[test]
    fn binary_read_error_names_kind_and_size() {
        let dir = std::env::temp_dir().join(format!("krypton-acp-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shot.png");
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&[0u8; 24]);
        std::fs::write(&path, &bytes).unwrap();
        let msg = binary_read_error(path.to_str().unwrap());
        assert!(msg.contains("image/png"), "{msg}");
        assert!(msg.contains(&format!("{} bytes", bytes.len())), "{msg}");
        assert!(msg.contains("text-only"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disconnect_detail_surfaces_stderr_tail() {
        let detail = disconnect_detail("codex", "thread 'main' panicked at 'boom'\n");
        assert!(detail.starts_with("codex subprocess exited — "));
        assert!(detail.contains("panicked at 'boom'"));
    }

    #[test]
    fn disconnect_detail_falls_back_when_no_stderr() {
        let detail = disconnect_detail("codex", "   \n  ");
        assert_eq!(
            detail,
            "codex subprocess exited before replying (no stderr captured)"
        );
    }

    #[test]
    fn cursor_startup_hint_prefers_keychain_error_over_auth_hint() {
        let hint = startup_hint(
            "cursor",
            "ERROR: SecItemCopyMatching failed -50; please login again",
        );

        assert!(hint.contains("Cursor credential lookup failed"));
    }

    #[test]
    fn cursor_startup_hint_reports_missing_cli() {
        let hint = startup_hint("cursor", "No such file or directory (os error 2)");

        assert!(hint.contains("Install Cursor Agent CLI"));
    }

    #[test]
    fn cursor_startup_hint_reports_auth_when_explicit() {
        let hint = startup_hint("cursor", "not authenticated: missing api key");

        assert!(hint.contains("cursor-agent login"));
    }

    #[test]
    fn cursor_startup_hint_does_not_treat_bare_login_word_as_auth() {
        let stderr = "debug: login state cache refreshed";
        let hint = startup_hint("cursor", stderr);

        assert_eq!(hint, stderr);
    }

    #[test]
    fn cursor_startup_hint_empty_stderr_is_non_diagnostic() {
        let hint = startup_hint("cursor", "");

        assert!(hint.contains("no stderr was captured"));
        assert!(hint.contains("likely cause"));
    }

    #[test]
    fn omp_startup_hint_reports_missing_cli() {
        let hint = startup_hint("omp", "No such file or directory (os error 2)");

        assert!(hint.contains("Install OMP"));
        assert!(hint.contains("omp.sh"));
    }

    #[test]
    fn omp_startup_hint_reports_unknown_acp_subcommand() {
        let hint = startup_hint("omp", "error: unknown command acp");

        assert!(hint.contains("predates native ACP mode"));
        assert!(hint.contains("omp/15.4.1"));
    }

    #[test]
    fn omp_startup_hint_reports_auth_when_explicit() {
        let hint = startup_hint("omp", "Error: not authenticated: please log in");

        assert!(hint.contains("Run `omp` once"));
        assert!(hint.contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn omp_startup_hint_reports_api_key_problem_before_generic_auth() {
        let hint = startup_hint("omp", "Error: invalid api key");

        assert!(hint.contains("OMP reports an API key problem"));
        assert!(!hint.contains("claude /login"));
    }

    #[test]
    fn omp_startup_hint_empty_stderr_is_non_diagnostic() {
        let hint = startup_hint("omp", "");

        assert!(hint.contains("no stderr was captured"));
        assert!(hint.contains("auth-broker/OAuth"));
    }

    #[test]
    fn omp_startup_hint_does_not_leak_to_other_backends() {
        let hint = startup_hint("claude", "omp: unknown command acp");

        assert!(!hint.contains("OMP CLI predates native ACP mode"));
    }

    #[test]
    fn grok_spawn_passes_trust_before_agent_stdio() {
        // `grok agent --trust` is rejected; the flag is global and must precede
        // the `agent` subcommand. Without it, untrusted folders silently start
        // zero repo-local MCP servers (tli-migration: empty search_tool catalog).
        let grok = resolve_backend("grok").expect("grok backend");
        assert_eq!(grok.command, "grok");
        assert_eq!(grok.args, ["--trust", "agent", "stdio"]);
    }

    #[test]
    fn grok_startup_hint_reports_missing_cli() {
        let hint = startup_hint("grok", "No such file or directory (os error 2)");

        assert!(hint.contains("Install Grok Build CLI"));
        assert!(hint.contains("x.ai/cli/install.sh"));
    }

    #[test]
    fn grok_startup_hint_reports_unknown_acp_subcommand() {
        let hint = startup_hint("grok", "error: unrecognized subcommand 'agent'");

        assert!(hint.contains("predates ACP mode"));
        assert!(hint.contains("grok agent stdio"));
    }

    #[test]
    fn grok_startup_hint_reports_auth_when_explicit() {
        let hint = startup_hint("grok", "Error: not authenticated: please log in");

        assert!(hint.contains("Run `grok` once"));
        assert!(hint.contains("XAI_API_KEY"));
    }

    #[test]
    fn grok_startup_hint_reports_api_key_problem_for_env_var_form() {
        // stderr that names the env var (lowercased to `xai_api_key`) must hit
        // the API-key branch, not fall through to raw stderr.
        let hint = startup_hint("grok", "Error: XAI_API_KEY is required");

        assert!(hint.contains("Grok reports an API key problem"));
        assert!(!hint.contains("claude /login"));
    }

    #[test]
    fn grok_startup_hint_empty_stderr_is_non_diagnostic() {
        let hint = startup_hint("grok", "");

        assert!(hint.contains("no stderr was captured"));
        assert!(hint.contains("browser login"));
    }

    #[test]
    fn grok_startup_hint_does_not_leak_to_other_backends() {
        let hint = startup_hint("claude", "grok: unrecognized subcommand 'agent'");

        assert!(!hint.contains("Grok CLI predates ACP mode"));
    }

    #[test]
    fn config_option_model_selector_drives_model_state() {
        // OpenCode v2 session/new: no `models`, a `configOptions` model select.
        let response = json!({
            "sessionId": "ses_1",
            "configOptions": [
                { "id": "mode", "category": "mode", "type": "select", "currentValue": "build",
                  "options": [{ "value": "build", "name": "Build" }] },
                { "id": "model", "category": "model", "type": "select",
                  "currentValue": "opencode/exo-free",
                  "options": [
                      { "value": "openai/gpt-5.5", "name": "openai/GPT-5.5" },
                      { "group": "free", "name": "Free", "options": [
                          { "value": "opencode/exo-free", "name": "Exo", "description": "free" }
                      ] }
                  ] }
            ]
        });
        let state = parse_session_model_state(&response);

        assert_eq!(
            state.control,
            Some(ModelControl::ConfigOption("model".into()))
        );
        assert_eq!(state.current.as_deref(), Some("opencode/exo-free"));
        let ids: Vec<&str> = state
            .available
            .iter()
            .map(|m| m.model_id.as_str())
            .collect();
        assert_eq!(ids, ["openai/gpt-5.5", "opencode/exo-free"]);
        assert_eq!(state.available[1].description.as_deref(), Some("free"));
        let (method, params) = state.control.unwrap().request("ses_1", "openai/gpt-5.5");
        assert_eq!(method, "session/set_config_option");
        assert_eq!(
            params,
            json!({ "sessionId": "ses_1", "configId": "model", "value": "openai/gpt-5.5" })
        );
    }

    #[test]
    fn models_object_takes_precedence_over_config_options() {
        let response = json!({
            "models": { "currentModelId": "default", "availableModels": [
                { "modelId": "default", "name": "Default" }
            ] },
            "configOptions": [
                { "id": "model", "category": "model", "type": "select", "currentValue": "x",
                  "options": [{ "value": "x", "name": "X" }] }
            ]
        });
        let state = parse_session_model_state(&response);

        assert_eq!(state.control, Some(ModelControl::SetModel));
        assert_eq!(state.current.as_deref(), Some("default"));
        assert_eq!(state.available.len(), 1);
    }

    // spec 388: claude-agent-acp 0.106.0 session/new (probed 2026-11-11):
    // no `models` object, a `model` select and an `effort` thought_level select.
    fn claude_config_options() -> Value {
        json!({
            "sessionId": "s",
            "configOptions": [
                { "id": "mode", "category": "mode", "type": "select", "currentValue": "auto",
                  "options": [{ "value": "auto", "name": "Auto" }] },
                { "id": "model", "category": "model", "type": "select", "currentValue": "default",
                  "options": [{ "value": "default", "name": "Default" },
                              { "value": "opus", "name": "Opus" },
                              { "value": "haiku", "name": "Haiku" }] },
                { "id": "effort", "category": "thought_level", "type": "select",
                  "currentValue": "xhigh",
                  "options": [{ "value": "default", "name": "Default" },
                              { "value": "low", "name": "Low" },
                              { "value": "high", "name": "High" },
                              { "value": "xhigh", "name": "Extra high" },
                              { "value": "max", "name": "Max" }] },
                { "id": "fast", "category": "model_config", "type": "select", "currentValue": "off",
                  "options": [{ "value": "on", "name": "On" }, { "value": "off", "name": "Off" }] }
            ]
        })
    }

    #[test]
    fn effort_is_found_by_category_not_by_id() {
        let state = parse_effort_state(claude_config_options().get("configOptions")).unwrap();
        assert_eq!(state.config_id, "effort");
        assert_eq!(state.current.as_deref(), Some("xhigh"));
        assert_eq!(
            state
                .options
                .iter()
                .map(|o| o.value.as_str())
                .collect::<Vec<_>>(),
            ["default", "low", "high", "xhigh", "max"]
        );
        assert_eq!(state.options[3].name, "Extra high");

        // omp 18.18.8 names it `thinking`, with `off`/`auto` values.
        let omp = json!([{ "id": "thinking", "category": "thought_level", "type": "select",
            "currentValue": "auto",
            "options": [{ "value": "off" }, { "group": "g", "name": "G",
                          "options": [{ "value": "auto", "name": "Auto" }] }] }]);
        let state = parse_effort_state(Some(&omp)).unwrap();
        assert_eq!(state.config_id, "thinking");
        assert_eq!(
            state.options[0],
            EffortOption {
                value: "off".into(),
                name: "off".into()
            }
        );
        assert_eq!(state.options[1].value, "auto");
    }

    #[test]
    fn effort_is_offered_only_on_config_option_model_lanes() {
        let claude = claude_config_options();
        let models = parse_session_model_state(&claude);
        assert!(session_effort_state(&claude, models.control.as_ref()).is_some());

        // codex-acp 1.13.0: a `models` object (ids carry the effort) wins, so
        // its `reasoning_effort` select is not offered as a separate strip.
        let codex = json!({
            "models": { "currentModelId": "gpt-6-sol[xhigh]", "availableModels": [
                { "modelId": "gpt-6-sol[xhigh]", "name": "6 Sol (xhigh)" }] },
            "configOptions": [
                { "id": "model", "category": "model", "type": "select", "currentValue": "gpt-6-sol",
                  "options": [{ "value": "gpt-6-sol", "name": "6 Sol" }] },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select",
                  "currentValue": "xhigh", "options": [{ "value": "xhigh", "name": "xhigh" }] }
            ]
        });
        let models = parse_session_model_state(&codex);
        assert_eq!(models.control, Some(ModelControl::SetModel));
        assert!(session_effort_state(&codex, models.control.as_ref()).is_none());

        // cline 3.0.74: no thought_level select at all.
        let cline = json!({ "configOptions": [
            { "id": "model", "category": "model", "type": "select", "currentValue": "m",
              "options": [{ "value": "m", "name": "M" }] }] });
        let models = parse_session_model_state(&cline);
        assert!(session_effort_state(&cline, models.control.as_ref()).is_none());
    }

    #[test]
    fn remembered_model_applies_only_when_advertised() {
        let mut memory = crate::acp_lane_models::LaneModelMemory::default();
        let state = parse_session_model_state(&claude_config_options());
        assert_eq!(remembered_model(&memory, "claude", &state), None);

        memory.model.insert("claude".into(), "haiku".into());
        assert_eq!(
            remembered_model(&memory, "claude", &state).as_deref(),
            Some("haiku")
        );
        assert_eq!(remembered_model(&memory, "omp", &state), None);

        memory.model.insert("claude".into(), "retired-model".into());
        assert_eq!(remembered_model(&memory, "claude", &state), None);
    }

    #[test]
    fn remembered_effort_skips_absent_unoffered_and_current_values() {
        let effort = parse_effort_state(claude_config_options().get("configOptions"));
        let mut memory = crate::acp_lane_models::LaneModelMemory::default();
        assert_eq!(remembered_effort(&memory, "claude", effort.as_ref()), None);

        memory.effort.insert("claude".into(), "max".into());
        assert_eq!(
            remembered_effort(&memory, "claude", effort.as_ref()).as_deref(),
            Some("max")
        );
        // Already current: nothing to send.
        memory.effort.insert("claude".into(), "xhigh".into());
        assert_eq!(remembered_effort(&memory, "claude", effort.as_ref()), None);
        // Not offered (another adapter's vocabulary): ignored.
        memory.effort.insert("claude".into(), "ultra".into());
        assert_eq!(remembered_effort(&memory, "claude", effort.as_ref()), None);
        // No effort control on this lane.
        memory.effort.insert("claude".into(), "max".into());
        assert_eq!(remembered_effort(&memory, "claude", None), None);
    }

    #[test]
    fn no_model_state_advertised_yields_no_control() {
        let state = parse_session_model_state(&json!({
            "sessionId": "s",
            "models": {},
            "configOptions": [{ "id": "mode", "category": "mode", "type": "select",
                                "currentValue": "a", "options": [] }]
        }));

        assert_eq!(state.control, None);
        assert!(state.available.is_empty());
        assert_eq!(state.current, None);
    }

    #[test]
    fn fx_model_selector_skips_provider_select() {
        // fx 0.0.16 session/new: `provider` precedes `model` under category
        // "model", and a `fast` select follows it (spec 359).
        let response = json!({
            "sessionId": "s",
            "configOptions": [
                { "id": "provider", "category": "model", "type": "select", "currentValue": "codex",
                  "options": [{ "value": "gateway", "name": "Vercel AI Gateway" },
                              { "value": "codex", "name": "Codex subscription" }] },
                { "id": "model", "category": "model", "type": "select", "currentValue": "gpt-6.1-sol",
                  "options": [{ "value": "gpt-6.1-sol", "name": "gpt-6.1-sol" },
                              { "value": "gpt-6-luna", "name": "gpt-6-luna" }] },
                { "id": "mode", "category": "mode", "type": "select", "currentValue": "auto",
                  "options": [] },
                { "id": "fast", "category": "model", "type": "select", "currentValue": "false",
                  "options": [{ "value": "false", "name": "Off" }, { "value": "true", "name": "On" }] }
            ]
        });
        let state = parse_session_model_state(&response);

        assert_eq!(
            state.control,
            Some(ModelControl::ConfigOption("model".into()))
        );
        assert_eq!(state.current.as_deref(), Some("gpt-6.1-sol"));
        let ids: Vec<&str> = state
            .available
            .iter()
            .map(|m| m.model_id.as_str())
            .collect();
        assert_eq!(ids, ["gpt-6.1-sol", "gpt-6-luna"]);
    }

    #[test]
    fn config_model_selector_without_model_id_keeps_agent_order() {
        let state = parse_session_model_state(&json!({
            "configOptions": [
                { "id": "llm", "category": "model", "type": "select", "currentValue": "x",
                  "options": [{ "value": "x", "name": "X" }] },
                { "id": "tier", "category": "model", "type": "select", "currentValue": "t",
                  "options": [{ "value": "t", "name": "T" }] }
            ]
        }));

        assert_eq!(
            state.control,
            Some(ModelControl::ConfigOption("llm".into()))
        );
        assert_eq!(state.current.as_deref(), Some("x"));
    }

    #[test]
    fn copilot_startup_hint_reports_missing_cli() {
        let hint = startup_hint("copilot", "No such file or directory (os error 2)");

        assert!(hint.contains("Install GitHub Copilot CLI"));
        assert!(hint.contains("npm install -g @github/copilot"));
    }

    #[test]
    fn copilot_startup_hint_reports_unknown_acp_flag() {
        let hint = startup_hint("copilot", "error: unknown option '--acp'");

        assert!(hint.contains("predates ACP mode"));
        assert!(hint.contains("copilot --acp --stdio"));
    }

    #[test]
    fn copilot_startup_hint_reports_auth_when_explicit() {
        let hint = startup_hint("copilot", "Error: not authenticated, run /login");

        assert!(hint.contains("Run `copilot` then `/login`"));
        assert!(hint.contains("GITHUB_TOKEN"));
    }

    #[test]
    fn copilot_startup_hint_empty_stderr_is_non_diagnostic() {
        let hint = startup_hint("copilot", "");

        assert!(hint.contains("no stderr was captured"));
        assert!(hint.contains("/login"));
    }

    #[test]
    fn copilot_startup_hint_does_not_leak_to_other_backends() {
        let hint = startup_hint("claude", "copilot: unknown option '--acp'");

        assert!(!hint.contains("Copilot CLI predates ACP mode"));
    }

    #[test]
    fn cline_startup_hint_reports_missing_cli() {
        let hint = startup_hint("cline", "No such file or directory (os error 2)");

        assert!(hint.contains("Install the Cline CLI"));
        assert!(hint.contains("npm i -g cline"));
    }

    #[test]
    fn cline_startup_hint_reports_unknown_acp_flag() {
        let hint = startup_hint("cline", "error: unknown option '--acp'");

        assert!(hint.contains("predates ACP mode"));
        assert!(hint.contains("cline --acp"));
    }

    #[test]
    fn cline_startup_hint_reports_auth_when_explicit() {
        let hint = startup_hint("cline", "Error: not authenticated, run cline auth");

        assert!(hint.contains("cline auth"));
    }

    #[test]
    fn cline_startup_hint_empty_stderr_is_non_diagnostic() {
        let hint = startup_hint("cline", "");

        assert!(hint.contains("no stderr was captured"));
        assert!(hint.contains("cline auth"));
    }

    #[test]
    fn cline_startup_hint_does_not_leak_to_other_backends() {
        let hint = startup_hint("claude", "cline: unknown option '--acp'");

        assert!(!hint.contains("Cline CLI predates ACP mode"));
    }

    #[test]
    fn fx_startup_hint_reports_missing_cli() {
        let hint = startup_hint("fx", "No such file or directory (os error 2)");

        assert!(hint.contains("Install fx"));
        assert!(hint.contains("fx.sh/setup.sh"));
        assert!(!hint.contains("claude-agent-acp"));
    }

    #[test]
    fn fx_startup_hint_reports_missing_acp_subcommand() {
        let hint = startup_hint("fx", "fx: unknown subcommand: acp");

        assert!(hint.contains("predates ACP mode"));
        assert!(hint.contains("fx upgrade"));
    }

    #[test]
    fn fx_startup_hint_empty_stderr_points_at_doctor() {
        let hint = startup_hint("fx", "");

        assert!(hint.contains("fx doctor"));
        assert!(hint.contains("fx login"));
    }

    #[test]
    fn fx_startup_hint_does_not_leak_to_other_backends() {
        let hint = startup_hint("claude", "fx: unknown subcommand: acp");

        assert!(!hint.contains("fx upgrade"));
    }

    #[test]
    fn junie_backend_is_not_available() {
        assert!(resolve_backend("junie").is_none());
        let backends = super::acp_list_backends().expect("backend list");
        assert!(!backends.iter().any(|backend| backend.id == "junie"));
        assert!(resolve_backend("cline").is_some());
    }

    #[test]
    fn sanitize_overlay_path_component_replaces_spaces() {
        assert_eq!(super::sanitize_overlay_path_component("lane a"), "lane_a");
    }

    #[test]
    fn cline_overlay_path_sanitizes_lane_label() {
        let dir = super::cline_overlay_lane_dir("h1", "Cline-1").expect("dir");
        let s = dir.to_string_lossy();
        assert!(
            s.contains("runtime/cline/h1/Cline-1") || s.contains("runtime\\cline\\h1\\Cline-1")
        );
        let settings = dir.join("cline_mcp_settings.json");
        assert!(
            settings
                .to_string_lossy()
                .ends_with("Cline-1/cline_mcp_settings.json")
                || settings
                    .to_string_lossy()
                    .ends_with("Cline-1\\cline_mcp_settings.json")
        );
    }

    #[test]
    fn turn_marker_event_carries_the_steering_outcome() {
        let steer = turn_marker_event(
            "steer",
            7,
            &json!({ "id": 7, "result": { "outcome": "startedNewTurn" } }),
        );
        assert_eq!(
            steer,
            json!({ "type": "turn_marker", "kind": "steer", "requestId": 7, "outcome": "startedNewTurn" })
        );
        let failed =
            turn_marker_event("steer", 8, &json!({ "id": 8, "error": { "code": -32601 } }));
        assert_eq!(failed["outcome"], Value::Null);
        let prompt = turn_marker_event(
            "prompt",
            9,
            &json!({ "id": 9, "result": { "stopReason": "end_turn" } }),
        );
        assert_eq!(prompt["kind"], "prompt");
        assert_eq!(prompt["outcome"], Value::Null);
    }

    #[test]
    fn with_request_id_tags_object_results_only() {
        assert_eq!(
            with_request_id(json!({ "stopReason": "end_turn" }), 3),
            json!({ "stopReason": "end_turn", "_kryptonRequestId": 3 })
        );
        assert_eq!(with_request_id(Value::Null, 3), Value::Null);
    }

    #[test]
    fn steering_supported_reads_top_level_meta_only() {
        assert!(steering_supported(&json!({
            "agentCapabilities": {},
            "_meta": { "steering": { "supported": true } },
        })));
        // Inside agentCapabilities is not the extension contract.
        assert!(!steering_supported(&json!({
            "agentCapabilities": { "_meta": { "steering": { "supported": true } } },
        })));
        assert!(!steering_supported(&json!({ "_meta": { "steering": {} } })));
        assert!(!steering_supported(&json!({})));
    }

    #[test]
    fn auth_required_needs_code_and_message() {
        // Shape request_with_id produced for a live Antigravity 1.3.0 server
        // (`data.message` abridged).
        assert!(is_auth_required(
            r#"session/new failed: {"code":-32000,"data":{"message":"No authentication method selected. Either call the `authenticate` method"},"message":"Authentication required"}"#
        ));
        // Krypton itself answers fs errors with -32000; never treat those as auth.
        assert!(!is_auth_required(
            r#"session/new failed: {"code":-32000,"message":"write: permission denied"}"#
        ));
        assert!(!is_auth_required(
            r#"session/new failed: {"code":-32603,"message":"Authentication required"}"#
        ));
        assert!(!is_auth_required("session/new timed out"));
    }

    #[test]
    fn auth_retry_only_for_advertised_method_id() {
        let methods = vec![
            json!({ "id": "oauth-business", "name": "Business" }),
            json!({ "id": "oauth-personal", "name": "Personal" }),
        ];
        assert!(advertises_auth_method(&methods, "oauth-personal"));
        assert!(!advertises_auth_method(
            &[
                json!({ "id": "gemini-api-key" }),
                json!({ "name": "oauth-personal" })
            ],
            "oauth-personal"
        ));
        assert!(!advertises_auth_method(&[], "oauth-personal"));
    }
}

#[cfg(test)]
mod instance_tests {
    use super::*;

    fn owner(role: AcpInstanceRole, label: &str) -> AcpInstanceOwner {
        AcpInstanceOwner {
            role,
            label: label.to_string(),
            harness_id: Some(format!("harness-{label}")),
            lane_id: None,
        }
    }

    fn client(registry: &AcpRegistry, role: AcpInstanceRole, remote: bool) -> Arc<AcpClient> {
        Arc::new(AcpClient::new(
            registry.allocate_session(),
            "fixture".to_string(),
            "Fixture".to_string(),
            Arc::new(AcpWire::new()),
            remote,
            owner(role, "fixture"),
        ))
    }

    #[cfg(unix)]
    async fn local(registry: &AcpRegistry, role: AcpInstanceRole, script: &str) -> Arc<AcpClient> {
        let client = client(registry, role, false);
        let mut child = Command::new("/bin/sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        // The fixture announces readiness after installing any signal handler.
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        stdout.read_line(&mut ready).await.unwrap();
        assert_eq!(ready, "ready\n");
        let pid = child.id().unwrap();
        client.child_pid.store(pid, Ordering::Relaxed);
        *client.process_identity.write().unwrap() =
            crate::process_metrics::ProcessIdentity::capture(pid);
        *client.cwd.write().unwrap() = Some("/fixture/project".to_string());
        let stdin = child.stdin.take().unwrap();
        *client.transport.lock().await = Some(AcpTransport::Local { stdin, child });
        registry.insert(client.krypton_session, client.clone());
        client
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn inventory_counts_real_transports_and_promotes_probe_without_respawn() {
        let registry = Arc::new(AcpRegistry::new());
        let unstarted = client(&registry, AcpInstanceRole::Assist, false);
        assert!(registry.list_instances().await.unwrap().is_empty());
        drop(unstarted);
        let mut clients = Vec::new();
        for role in [
            AcpInstanceRole::HarnessLane,
            AcpInstanceRole::SessionProbe,
            AcpInstanceRole::Assist,
            AcpInstanceRole::RailsJudge,
            AcpInstanceRole::InlineAi,
        ] {
            clients.push(local(&registry, role, "printf 'ready\\n'; cat >/dev/null").await);
        }
        let before = registry.list_instances().await.unwrap();
        assert_eq!(before.len(), 5);
        let probe = &clients[1];
        let pid = probe.child_pid.load(Ordering::Relaxed);
        let mut promoted = owner(AcpInstanceRole::HarnessLane, "another-project");
        promoted.lane_id = Some("lane-promoted".to_string());
        registry
            .set_owner(probe.krypton_session, promoted.clone())
            .unwrap();
        set_client_session_id(probe, "conversation-one");
        set_client_session_id(probe, "conversation-two");
        let after = registry.list_instances().await.unwrap();
        assert_eq!(after.len(), 5);
        let row = after
            .iter()
            .find(|row| row.session == probe.krypton_session)
            .unwrap();
        assert_eq!(row.owner, promoted);
        assert_eq!(row.pid, Some(pid));
        assert_eq!(row.acp_session_id.as_deref(), Some("conversation-two"));
        assert!(registry.set_owner(u64::MAX, promoted).is_err());
        dispose_all(&registry).await;
        assert!(registry.list_instances().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn inventory_request_and_all_human_wait_maps_drive_distinct_activity() {
        let registry = AcpRegistry::new();
        let client = client(&registry, AcpInstanceRole::Assist, false);
        let mut initialize = client.begin_request("initialize", &json!({}));
        assert_eq!(
            client.snapshot().await.lifecycle,
            AcpInstanceLifecycle::Initializing
        );
        assert_eq!(
            client.snapshot().await.activity,
            AcpInstanceActivity::Running
        );
        initialize.finish(&Ok(json!({})));
        drop(initialize);
        assert_eq!(
            client.snapshot().await.lifecycle,
            AcpInstanceLifecycle::Ready
        );
        let mut prompt = client.begin_request("session/prompt", &json!({}));
        let (permission, _) = oneshot::channel();
        client.perm_pending.lock().await.insert(1, permission);
        assert_eq!(
            client.snapshot().await.activity,
            AcpInstanceActivity::Waiting
        );
        client.perm_pending.lock().await.clear();
        assert_eq!(
            client.snapshot().await.activity,
            AcpInstanceActivity::Running
        );
        let (question, _) = oneshot::channel();
        client.ask_pending.lock().await.insert(2, question);
        assert_eq!(
            client.snapshot().await.activity,
            AcpInstanceActivity::Waiting
        );
        client.ask_pending.lock().await.clear();
        let (elicitation, _) = oneshot::channel();
        client.elicit_pending.lock().await.insert(3, elicitation);
        assert_eq!(
            client.snapshot().await.activity,
            AcpInstanceActivity::Waiting
        );
        client.elicit_pending.lock().await.clear();
        let (reply, _) = oneshot::channel();
        client.fs_write_pending.lock().await.insert(
            4,
            FsWriteCtx {
                reply,
                path: "/fixture/file".to_string(),
                new_content: "private".to_string(),
            },
        );
        assert_eq!(
            client.snapshot().await.activity,
            AcpInstanceActivity::Waiting
        );
        client.fs_write_pending.lock().await.clear();
        prompt.finish(&Ok(json!({ "stopReason": "cancelled" })));
        drop(prompt);
        let idle = client.snapshot().await;
        assert_eq!(idle.activity, AcpInstanceActivity::Idle);
        assert_eq!(idle.lifecycle, AcpInstanceLifecycle::Ready);
        assert!(!idle.has_error);
        let mut failed = client.begin_request("session/load", &json!({}));
        failed.finish(&Err("restore rejected".to_string()));
        drop(failed);
        let error = client.snapshot().await;
        assert_eq!(error.lifecycle, AcpInstanceLifecycle::Initializing);
        assert_eq!(error.activity, AcpInstanceActivity::Idle);
        assert!(error.has_error);
    }

    #[tokio::test]
    async fn inventory_model_alias_timeout_and_reported_confirmation_stay_distinct() {
        let registry = AcpRegistry::new();
        let client = client(&registry, AcpInstanceRole::HarnessLane, false);
        let models = parse_session_model_state(&json!({ "models": {
            "currentModelId": "old", "availableModels": [
                { "modelId": "old", "name": "Old" },
                { "modelId": "canonical", "name": "Canonical" },
            ],
        }}));
        client.observe_models(&models);
        let mut canonical =
            client.begin_request("session/set_model", &json!({ "modelId": "canonical" }));
        canonical.finish(&Ok(json!({})));
        drop(canonical);
        assert_eq!(
            client.snapshot().await.confirmed_model_id.as_deref(),
            Some("canonical")
        );
        let mut alias = client.begin_request("session/set_model", &json!({ "modelId": "alias" }));
        alias.finish(&Ok(json!({})));
        drop(alias);
        let uncertain = client.snapshot().await;
        assert_eq!(uncertain.requested_model_id.as_deref(), Some("alias"));
        assert!(uncertain.confirmed_model_id.is_none());
        assert!(uncertain.model_uncertain);
        let timed_out =
            client.begin_request("session/set_model", &json!({ "modelId": "canonical" }));
        drop(timed_out);
        assert!(client.snapshot().await.model_uncertain);
        client.observe_models(&models);
        assert!(!client.snapshot().await.model_uncertain);
        let mut alias = client.begin_request("session/set_model", &json!({ "modelId": "alias" }));
        client.observe_models(&models); // Agent report wins over a requested alias.
        alias.finish(&Ok(json!({})));
        drop(alias);
        assert_eq!(
            client.snapshot().await.confirmed_model_id.as_deref(),
            Some("old")
        );
        let mut failed = client.begin_request("session/set_model", &json!({ "modelId": "bad" }));
        failed.finish(&Err("unsupported model".to_string()));
        drop(failed);
        let rejected = client.snapshot().await;
        assert_eq!(rejected.confirmed_model_id.as_deref(), Some("old"));
        assert!(!rejected.model_uncertain);
        assert!(rejected.has_error);
    }

    #[tokio::test]
    async fn inventory_older_model_reply_cannot_confirm_newer_request() {
        let registry = AcpRegistry::new();
        let client = client(&registry, AcpInstanceRole::HarnessLane, false);
        client.observe_models(&parse_session_model_state(&json!({ "models": {
            "currentModelId": "one",
            "availableModels": [{ "modelId": "one", "name": "One" }, { "modelId": "two", "name": "Two" }],
        }})));
        let mut older = client.begin_request("session/set_model", &json!({ "modelId": "one" }));
        let newer = client.begin_request("session/set_model", &json!({ "modelId": "two" }));
        drop(newer); // Newer request timed out; an older success cannot settle it.
        older.finish(&Ok(json!({})));
        drop(older);
        let row = client.snapshot().await;
        assert_eq!(row.requested_model_id.as_deref(), Some("two"));
        assert!(row.confirmed_model_id.is_none());
        assert!(row.model_uncertain);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn inventory_stdout_disconnect_does_not_invent_local_process_exit() {
        let registry = Arc::new(AcpRegistry::new());
        let client = local(
            &registry,
            AcpInstanceRole::InlineAi,
            "printf 'ready\\n'; exec 1>&-; cat >/dev/null",
        )
        .await;
        client.observe_disconnect(false);
        let row = client.snapshot().await;
        assert_eq!(row.lifecycle, AcpInstanceLifecycle::Disconnected);
        assert_eq!(row.liveness, AcpInstanceLiveness::Alive);
        registry.dispose(client.krypton_session).await;
        assert!(registry.list_instances().await.unwrap().is_empty());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn inventory_concurrent_disposal_keeps_stopping_row_and_survives_caller_abort() {
        let registry = Arc::new(AcpRegistry::new());
        let client = local(
            &registry,
            AcpInstanceRole::HarnessLane,
            "trap 'sleep 0.15; exit 0' TERM; printf 'ready\\n'; while :; do sleep 1; done",
        )
        .await;
        let session = client.krypton_session;
        let first_registry = registry.clone();
        let first = tokio::spawn(async move { first_registry.dispose(session).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !client.disposed.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let stopping = registry.list_instances().await.unwrap();
        assert_eq!(stopping.len(), 1);
        assert_eq!(stopping[0].lifecycle, AcpInstanceLifecycle::Terminating);
        assert!(stopping[0].pid.is_some());
        first.abort();
        let _ = first.await;
        tokio::join!(registry.dispose(session), registry.dispose(session));
        assert!(registry.list_instances().await.unwrap().is_empty());
        assert!(*client.teardown_complete.borrow());
        registry.dispose(session).await;
    }

    #[tokio::test]
    async fn inventory_retains_unknown_remote_epoch_across_disposal_and_reconnect() {
        let registry = Arc::new(AcpRegistry::new());
        let old = client(&registry, AcpInstanceRole::SessionProbe, true);
        let observation = Arc::new(crate::remote_harness::RemoteAgentObservation::default());
        *old.remote_observation.write().unwrap() = Some(observation.clone());
        {
            let mut state = old.instance.write().unwrap();
            state.execution.runtime_id = Some("runtime-old".to_string());
            state.execution.host = Some("remote.example".to_string());
        }
        registry.insert(old.krypton_session, old.clone());
        old.observe_disconnect(false);
        registry.dispose(old.krypton_session).await;
        let retained = registry.list_instances().await.unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].liveness, AcpInstanceLiveness::Unknown);
        assert_eq!(
            retained[0].execution.runtime_id.as_deref(),
            Some("runtime-old")
        );
        assert_eq!(
            retained[0].execution.host.as_deref(),
            Some("remote.example")
        );
        assert!(retained[0].pid.is_none());
        assert!(registry.snapshot_pids().is_empty());
        let replacement = client(&registry, AcpInstanceRole::HarnessLane, true);
        registry.insert(replacement.krypton_session, replacement.clone());
        let reconnected = registry.list_instances().await.unwrap();
        assert_eq!(reconnected.len(), 2);
        assert_ne!(reconnected[0].session, reconnected[1].session);
        observation.observe(&RemoteAgentEvent::Exit(None)); // Signal exits are still confirmed.
        let confirmed = registry.list_instances().await.unwrap();
        assert_eq!(confirmed.len(), 1);
        assert_eq!(confirmed[0].session, replacement.krypton_session);
        registry.dispose(replacement.krypton_session).await;
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn inventory_cancelled_request_releases_activity_and_pending_reply() {
        let registry = Arc::new(AcpRegistry::new());
        let client = local(
            &registry,
            AcpInstanceRole::Assist,
            "printf 'ready\\n'; cat >/dev/null",
        )
        .await;
        let requesting = client.clone();
        let request =
            tokio::spawn(async move { requesting.request("initialize", json!({})).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while client.pending.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let running = client.snapshot().await;
        assert_eq!(running.activity, AcpInstanceActivity::Running);
        assert_eq!(running.liveness, AcpInstanceLiveness::Alive);
        request.abort();
        let _ = request.await;
        let cancelled = client.snapshot().await;
        assert_eq!(cancelled.activity, AcpInstanceActivity::Idle);
        assert_eq!(cancelled.liveness, AcpInstanceLiveness::Alive);
        assert!(cancelled.has_error);
        assert!(client.pending.lock().unwrap().is_empty());
        registry.dispose(client.krypton_session).await;
    }
}
