// Krypton — ACP (Agent Client Protocol) backend.
//
// Spawns an external agent subprocess (e.g. `npx @agentclientprotocol/claude-agent-acp`,
// `gemini --experimental-acp`) and speaks newline-delimited JSON-RPC 2.0 over its
// stdio. One AcpClient per Krypton-side session. The Rust side acts as the JSON-RPC
// client *and* must handle inbound requests (fs/read_text_file, fs/write_text_file,
// session/request_permission) initiated by the agent.
//
// See docs/69-acp-agent-support.md for the design.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, State};

use crate::util::emit::EmitExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const OPENCODE_DEFAULT_MODEL: &str = "zai-coding-plan/glm-5.1";
const MIMO_DEFAULT_MODEL: &str = "mimo/mimo-auto";

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
                args: vec![
                    "-y".to_string(),
                    "@agentclientprotocol/claude-agent-acp".to_string(),
                ],
                display_name: "Claude".to_string(),
            },
        ),
        (
            "gemini",
            AcpBackend {
                command: "gemini".to_string(),
                args: vec!["--experimental-acp".to_string()],
                display_name: "Gemini".to_string(),
            },
        ),
        (
            "codex",
            AcpBackend {
                command: "codex-acp".to_string(),
                args: vec![],
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
            "junie",
            AcpBackend {
                command: "junie".to_string(),
                args: vec!["--acp".to_string(), "true".to_string()],
                display_name: "Junie".to_string(),
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
                args: vec!["agent".to_string(), "stdio".to_string()],
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
                // block (none added) and docs/150-acp-copilot-lane.md.
                args: vec!["--acp".to_string(), "--stdio".to_string()],
                display_name: "Copilot".to_string(),
            },
        ),
        (
            "mimo",
            AcpBackend {
                command: "mimo".to_string(),
                // MiMo-Code (Xiaomi's OpenCode fork, `npm i -g @mimo-ai/cli`)
                // keeps OpenCode's `acp` subcommand and ACP module. Unlike the
                // `opencode` lane it takes the generic model path: its session/new
                // advertises `models { currentModelId, availableModels }`, so
                // Krypton selects the anonymous free `mimo/mimo-auto` model via
                // `session/set_model` unless the user configured another model.
                args: vec!["acp".to_string()],
                display_name: "MiMo".to_string(),
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
                // `cline auth`/config (chip-only). See docs/159-acp-cline-lane.md.
                args: vec!["--acp".to_string()],
                display_name: "Cline".to_string(),
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
}

/// One agent-advertised model entry, mapped from the ACP `session/new`
/// `models.availableModels[]` (camelCase) into snake_case for the frontend
/// (spec 127). The picker offers exactly these — never a hand-maintained list.
#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
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
}

/// Richer result of `apply_session_model` (spec 127): the spawn path needs to
/// know not just whether the apply failed, but which canonical id was applied so
/// `acp_session_new` can correct the stale pre-switch `currentModelId` marker.
struct ModelApplyResult {
    failed: bool,
    /// The id that was successfully applied AND is an exact advertised id. `None`
    /// when nothing was applied, the apply failed, or the configured value was a
    /// non-canonical alias (then we leave the marker unverified rather than guess).
    applied_model_id: Option<String>,
}

/// Parse the ACP `session/new` (or resume/load) `models` value into the
/// frontend-facing `(available_models, current_model_id)` pair. Tolerates a
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

fn effective_spawn_model(backend_id: &str, configured_model: Option<String>) -> Option<String> {
    configured_model
        .filter(|model| !model.is_empty())
        .or_else(|| (backend_id == "mimo").then(|| MIMO_DEFAULT_MODEL.to_string()))
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

struct AcpClient {
    krypton_session: u64,
    backend_id: String,
    #[allow(dead_code)]
    display_name: String,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    perm_pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// fs/write_text_file requests parked while waiting for user accept/reject.
    fs_write_pending: Mutex<HashMap<u64, FsWriteCtx>>,
    next_id: AtomicU64,
    /// Set after `initialize` completes. Notification before this point is rare.
    agent_capabilities: RwLock<Option<Value>>,
    /// Filled by `session/new` response.
    acp_session_id: RwLock<Option<String>>,
    /// Rolling stderr capture (max 64KB) — surfaced on startup failure.
    stderr_buf: Mutex<String>,
    /// Reason a request's reply never arrived: set when the subprocess
    /// disconnects mid-flight so `request()` can report the real cause
    /// (a stderr tail when captured) instead of a bare "closed before reply".
    disconnect_reason: RwLock<Option<String>>,
    /// Holds the child handle so we can SIGTERM/SIGKILL it; None after dispose.
    child: Mutex<Option<Child>>,
    /// PID of the spawned adapter, set right after `cmd.spawn()`. 0 = unset
    /// (pre-spawn or post-dispose). Read by the metrics sampler to walk the
    /// adapter's process tree without taking the `child` mutex.
    child_pid: AtomicU32,
    /// Working directory the child was spawned in — also reported as project root
    /// in `session/new`. Falls back to the host process cwd when None.
    cwd: RwLock<Option<String>>,
    /// MCP servers passed through to `session/new`.
    mcp_servers: RwLock<Vec<Value>>,
    /// Model id chosen by the user via `acp_harness.lane_models` config — used
    /// after `session/new` for backends that accept a model selection over ACP
    /// (currently OpenCode). For backends that take a CLI flag (Gemini), the
    /// override is applied to spawn args before the client is created.
    model_override: RwLock<Option<String>>,
    /// Latch: once true, no more events fire.
    disposed: std::sync::atomic::AtomicBool,
}

impl AcpClient {
    fn new(krypton_session: u64, backend_id: String, display_name: String) -> Self {
        Self {
            krypton_session,
            backend_id,
            display_name,
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            perm_pending: Mutex::new(HashMap::new()),
            fs_write_pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            agent_capabilities: RwLock::new(None),
            acp_session_id: RwLock::new(None),
            stderr_buf: Mutex::new(String::new()),
            disconnect_reason: RwLock::new(None),
            child: Mutex::new(None),
            child_pid: AtomicU32::new(0),
            cwd: RwLock::new(None),
            mcp_servers: RwLock::new(Vec::new()),
            model_override: RwLock::new(None),
            disposed: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn next_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Send a JSON-RPC request (with id) and await the response.
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_request_id();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_line(&payload).await?;
        match rx.await {
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
        }
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
        text.push('\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "ACP stdin closed".to_string())?;
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| format!("write: {e}"))?;
        stdin.flush().await.map_err(|e| format!("flush: {e}"))?;
        Ok(())
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
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        log::debug!(
                            "[acp:{}] dropping non-JSON line ({e}): {trimmed}",
                            client.krypton_session
                        );
                        continue;
                    }
                };
                dispatch_message(&client, &app, value).await;
            }
            Err(e) => {
                log::warn!("[acp:{}] read error: {e}", client.krypton_session);
                break;
            }
        }
    }
    finalize_disconnect(&client, &app).await;
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
        let mut pending = client.pending.lock().await;
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

/// Reject fs/* requests that escape the lane's project root. When `cwd` is unset
/// (rare — fallback session), we pass through without enforcement.
async fn validate_fs_path(client: &Arc<AcpClient>, raw_path: &str) -> Result<(), Value> {
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
    let root = match std::fs::canonicalize(&cwd) {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    let candidate = std::path::PathBuf::from(raw_path);
    let abs = if candidate.is_absolute() {
        candidate
    } else {
        root.join(&candidate)
    };
    // Canonicalize the deepest existing ancestor to resolve symlinks / normalize.
    let mut probe = abs.clone();
    let resolved = loop {
        match std::fs::canonicalize(&probe) {
            Ok(p) => {
                let suffix = abs.strip_prefix(&probe).unwrap_or(std::path::Path::new(""));
                break p.join(suffix);
            }
            Err(_) => match probe.parent() {
                Some(parent) => probe = parent.to_path_buf(),
                None => break abs.clone(),
            },
        }
    };
    if !resolved.starts_with(&root) {
        return Err(json!({
            "code": -32602,
            "message": format!("Path outside project root: {}", raw_path),
        }));
    }
    Ok(())
}

/// Context held while a fs/write_text_file request waits for the user's decision.
struct FsWriteCtx {
    reply: oneshot::Sender<Result<Value, Value>>,
    path: String,
    new_content: String,
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

async fn handle_inbound_request(
    client: Arc<AcpClient>,
    app: AppHandle,
    id: Value,
    method: String,
    params: Value,
) {
    match method.as_str() {
        "fs/read_text_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Err(err) = validate_fs_path(&client, &path).await {
                let msg = err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("path scope")
                    .to_string();
                emit_fs_activity(&client, &app, "read", &path, false, Some(&msg));
                let _ = client.reply(id, Err(err)).await;
                return;
            }
            let result = match std::fs::read_to_string(&path) {
                Ok(content) => {
                    emit_fs_activity(&client, &app, "read", &path, true, None);
                    Ok(json!({ "content": content }))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    log::debug!("[acp] fs/read_text_file: {path} not found, returning empty");
                    // NotFound returns empty content per existing behavior; surface
                    // it as a successful read so users still see the access attempt.
                    emit_fs_activity(&client, &app, "read", &path, true, None);
                    Ok(json!({ "content": "" }))
                }
                Err(e) => {
                    let msg = format!("{e}");
                    emit_fs_activity(&client, &app, "read", &path, false, Some(&msg));
                    Err(json!({ "code": -32000, "message": format!("fs/read_text_file: {e}") }))
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
            // Path scoping (Spec 89 Phase C): reject paths outside the lane's project root.
            if let Err(err) = validate_fs_path(&client, &path).await {
                let msg = err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("path scope")
                    .to_string();
                emit_fs_activity(&client, &app, "write", &path, false, Some(&msg));
                let _ = client.reply(id, Err(err)).await;
                return;
            }
            // Compute oldText against current disk content for the diff preview.
            let old_text = std::fs::read_to_string(&path).unwrap_or_default();
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
        "session/request_permission" => {
            // Bridge to the frontend.
            let request_id = id.as_u64().unwrap_or(0);
            let (tx, rx) = oneshot::channel();
            {
                let mut perm = client.perm_pending.lock().await;
                perm.insert(request_id, tx);
            }
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
    match method {
        "session/update" => {
            let update_kind = params
                .get("update")
                .and_then(|u| u.get("sessionUpdate"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let update = params.get("update").cloned().unwrap_or(Value::Null);
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
        let mut pending = client.pending.lock().await;
        pending.clear();
    }
    {
        let mut perm = client.perm_pending.lock().await;
        perm.clear();
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

pub struct AcpRegistry {
    next_session: AtomicU64,
    clients: RwLock<HashMap<u64, Arc<AcpClient>>>,
}

impl AcpRegistry {
    pub fn new() -> Self {
        Self {
            next_session: AtomicU64::new(1),
            clients: RwLock::new(HashMap::new()),
        }
    }

    fn allocate_session(&self) -> u64 {
        self.next_session.fetch_add(1, Ordering::Relaxed)
    }

    fn get(&self, session: u64) -> Option<Arc<AcpClient>> {
        self.clients.read().ok()?.get(&session).cloned()
    }

    fn insert(&self, session: u64, client: Arc<AcpClient>) {
        if let Ok(mut map) = self.clients.write() {
            map.insert(session, client);
        }
    }

    fn remove(&self, session: u64) -> Option<Arc<AcpClient>> {
        self.clients.write().ok()?.remove(&session)
    }

    /// Snapshot of (session, child_pid) pairs for live lanes with a known PID.
    /// Used by the metrics sampler — does not hold the registry lock across
    /// sysinfo work.
    fn snapshot_pids(&self) -> Vec<(u64, u32)> {
        let Ok(map) = self.clients.read() else {
            return Vec::new();
        };
        map.iter()
            .filter_map(|(session, client)| {
                let pid = client.child_pid.load(Ordering::Relaxed);
                if pid == 0 {
                    None
                } else {
                    Some((*session, pid))
                }
            })
            .collect()
    }

    /// Drain all sessions and return them. Used on app shutdown to ensure
    /// every spawned adapter (and its MCP grandchildren via process-group
    /// signal) is torn down rather than reparented to launchd.
    fn drain(&self) -> Vec<(u64, Arc<AcpClient>)> {
        match self.clients.write() {
            Ok(mut map) => map.drain().collect(),
            Err(_) => Vec::new(),
        }
    }
}

impl Default for AcpRegistry {
    fn default() -> Self {
        Self::new()
    }
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
    mcp_servers: Option<Vec<Value>>,
    junie_mcp_location: Option<String>,
    cline_mcp_settings_path: Option<String>,
    app: AppHandle,
    registry: State<'_, Arc<AcpRegistry>>,
    config: State<'_, Arc<RwLock<crate::config::KryptonConfig>>>,
) -> Result<u64, String> {
    let mut backend =
        resolve_backend(&backend_id).ok_or_else(|| format!("Unknown ACP backend: {backend_id}"))?;

    let display_name = if backend.display_name.is_empty() {
        backend_id.clone()
    } else {
        backend.display_name.clone()
    };

    // Resolve configured active model for this backend. MiMo defaults to its
    // anonymous free channel; an explicit lane model still takes precedence.
    let configured_model = effective_spawn_model(
        &backend_id,
        config
            .read()
            .ok()
            .and_then(|cfg| cfg.acp_harness.lane_models.get(&backend_id).cloned())
            .map(|m| m.active),
    );

    // Backends that take the model via CLI flag — apply before spawn.
    if let Some(ref model) = configured_model {
        if backend_id == "gemini" {
            backend.args.push("--model".to_string());
            backend.args.push(model.clone());
        } else if backend_id == "droid" {
            backend.args.push("-m".to_string());
            backend.args.push(model.clone());
        }
    }

    if backend_id == "junie" {
        if let Some(loc) = junie_mcp_location.filter(|s| !s.is_empty()) {
            backend.args.push("--mcp-location".to_string());
            backend.args.push(loc);
        }
    }

    let mut cmd = Command::new(&backend.command);
    cmd.args(&backend.args)
        .envs(crate::pty::cached_login_env().iter())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Put the adapter into its own process group so we can signal the entire
    // tree (adapter + grandchild MCP servers) at once on dispose. Without this
    // the MCP servers it spawns get reparented to launchd if the adapter dies
    // ungracefully, leaving zombies. See acp_dispose.
    #[cfg(unix)]
    cmd.process_group(0);
    if let Some(d) = cwd.as_ref() {
        cmd.current_dir(d);
    }
    // Cline reads MCP servers from `cline_mcp_settings.json`, not ACP
    // `session/new` (no `mcpCapabilities` advertised). Point it at the per-lane
    // overlay so the harness-memory server lands; global `~/.cline` auth is left
    // intact (we override only the MCP settings file path, not the data dir).
    if backend_id == "cline" {
        if let Some(p) = cline_mcp_settings_path.filter(|s| !s.is_empty()) {
            cmd.env("CLINE_MCP_SETTINGS_PATH", p);
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

    let session = registry.allocate_session();
    let client = Arc::new(AcpClient::new(session, backend_id.clone(), display_name));
    if let Some(pid) = child.id() {
        client.child_pid.store(pid, Ordering::Relaxed);
    }
    if let Ok(mut g) = client.cwd.write() {
        *g = cwd.clone();
    }
    if let Ok(mut g) = client.mcp_servers.write() {
        *g = mcp_servers.unwrap_or_default();
    }
    if let Ok(mut g) = client.model_override.write() {
        *g = configured_model.clone();
    }
    {
        let mut g = client.stdin.lock().await;
        *g = Some(stdin);
    }
    {
        let mut g = client.child.lock().await;
        *g = Some(child);
    }
    registry.insert(session, client.clone());

    // Reader + stderr tasks.
    let reader_client = client.clone();
    let reader_app = app.clone();
    tokio::spawn(async move {
        let buf = BufReader::new(stdout);
        run_reader(reader_client, reader_app, buf).await;
    });
    let stderr_client = client.clone();
    tokio::spawn(async move {
        let buf = BufReader::new(stderr);
        run_stderr_capture(stderr_client, buf).await;
    });

    Ok(session)
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
        "clientCapabilities": {
            "fs": { "readTextFile": true, "writeTextFile": true },
            "terminal": false,
        },
        "clientInfo": { "name": "krypton", "version": env!("CARGO_PKG_VERSION") },
    });

    let init = match tokio::time::timeout(
        Duration::from_secs(30),
        client.request("initialize", init_params),
    )
    .await
    {
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
                "ACP initialize timed out after 30s. {}",
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

    if let Ok(mut g) = client.agent_capabilities.write() {
        *g = Some(capabilities.clone());
    }

    Ok(AgentInitInfo {
        agent_protocol_version: proto,
        auth_methods,
        agent_capabilities: capabilities,
    })
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

    let new_session = tokio::time::timeout(
        Duration::from_secs(30),
        client.request(
            "session/new",
            json!({
                "cwd": session_cwd,
                "mcpServers": mcp_servers,
            }),
        ),
    )
    .await
    .map_err(|_| "session/new timed out".to_string())??;

    let acp_session_id = new_session
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "session/new: missing sessionId".to_string())?
        .to_string();
    set_client_session_id(&client, &acp_session_id);

    // Surface the agent-advertised model list to the frontend (spec 127). The
    // capability gate inside apply_session_model still reads the raw value; this
    // is the frontend-facing projection.
    let (available_models, advertised_current) = parse_session_models(new_session.get("models"));

    // Apply the configured model AFTER session/new (never as a session/new field),
    // awaited inline so the switch completes before the frontend can send the first
    // prompt. OpenCode keeps its dedicated path; ACP-native backends that advertise
    // model state get a non-fatal `session/set_model`.
    let apply = apply_session_model(
        &client,
        &acp_session_id,
        &available_models,
        new_session.get("models"),
    )
    .await?;

    // `currentModelId` from session/new is captured BEFORE the spawn-time apply, so
    // prefer the applied canonical id when we have one (spec 127, Codex-1 #1).
    let current_model_id = apply.applied_model_id.or(advertised_current);

    Ok(AgentSessionInfo {
        session_id: acp_session_id,
        model_apply_failed: apply.failed,
        available_models,
        current_model_id,
    })
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
    set_client_session_id(&client, &session_id);
    let session_cwd = client_session_cwd(&client);
    let mcp_servers = client_mcp_servers(&client);
    let response = client
        .request(
            method,
            json!({
                "sessionId": &session_id,
                "cwd": session_cwd,
                "mcpServers": mcp_servers,
            }),
        )
        .await?;
    // Resumed/loaded sessions keep whatever model they were saved with — v1 does
    // not force them to the current config, so no apply is attempted here. But we
    // DO surface any advertised model list/current id so the picker works on
    // restored lanes too (spec 127, Codex-1 #2). When the backend omits `models`,
    // available_models is empty and the picker stays disabled for that lane.
    let (available_models, current_model_id) = parse_session_models(response.get("models"));
    Ok(AgentSessionInfo {
        session_id,
        model_apply_failed: false,
        available_models,
        current_model_id,
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
    match tokio::time::timeout(
        Duration::from_secs(10),
        client.request(
            "session/set_model",
            json!({ "sessionId": acp_session_id, "modelId": &model_id }),
        ),
    )
    .await
    {
        Ok(Ok(_)) => Ok(SetModelOutcome::Ok),
        Ok(Err(e)) => Err(format!("session/set_model failed: {e}")),
        Err(_) => {
            log::warn!(
                "acp_set_lane_model modelId={model_id} timed out for backend {}",
                client.backend_id
            );
            Ok(SetModelOutcome::TimedOutUncertain)
        }
    }
}

/// Apply the lane's configured model after `session/new`. Returns
/// `Ok(model_apply_failed)`: `true` only when a model was requested, the agent
/// advertised model state, and the `session/set_model` request errored/timed out.
///
/// OpenCode keeps its dedicated `set_config_option`-first path (FATAL via `?`),
/// evaluated BEFORE the capability gate so it is never skipped for lacking a
/// `models` object. ACP-native backends that advertise a valid session model
/// state get a generic, non-fatal `session/set_model` — a misspelled or
/// unsupported model id must not stop the lane starting.
async fn apply_session_model(
    client: &AcpClient,
    acp_session_id: &str,
    available_models: &[ModelInfo],
    models: Option<&Value>,
) -> Result<ModelApplyResult, String> {
    let no_op = ModelApplyResult {
        failed: false,
        applied_model_id: None,
    };
    if client.backend_id == "opencode" {
        set_opencode_default_model(client, acp_session_id).await?;
        return Ok(no_op);
    }
    // Capability gate: a valid session model state must be present. Check the
    // object shape (an `availableModels` array or a `currentModelId` string), not
    // merely the key, so a backend echoing an empty/garbage `models` value does
    // not trigger a doomed request. An empty `availableModels: []` array still
    // counts as capability-present — the shape is the signal, not the contents.
    let advertises_models = models
        .and_then(|v| v.as_object())
        .map(|m| {
            m.get("availableModels")
                .map(|a| a.is_array())
                .unwrap_or(false)
                || m.get("currentModelId")
                    .map(|c| c.is_string())
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    if !advertises_models {
        return Ok(no_op);
    }
    let Some(model) = client.model_override.read().ok().and_then(|g| g.clone()) else {
        return Ok(no_op); // no spawn model requested — agent default is used
    };
    // Sent verbatim (so aliases like `opus`/`sonnet` resolve adapter-side); any
    // failure is logged with the backend id + requested model and is non-fatal.
    let res = tokio::time::timeout(
        Duration::from_secs(10),
        client.request(
            "session/set_model",
            json!({ "sessionId": acp_session_id, "modelId": &model }),
        ),
    )
    .await;
    match res {
        Ok(Ok(_)) => {
            // Spec 127: only report a confirmed current id when the configured
            // value is an EXACT advertised id (canonical). Aliases resolve
            // adapter-side to an id we can't know here, so leave it unverified
            // rather than asserting the pre-switch default or a guess.
            let applied_model_id = available_models
                .iter()
                .any(|m| m.model_id == model)
                .then(|| model.clone());
            Ok(ModelApplyResult {
                failed: false,
                applied_model_id,
            })
        }
        Ok(Err(e)) => {
            log::warn!(
                "session/set_model modelId={model} failed for backend {}: {e}",
                client.backend_id
            );
            Ok(ModelApplyResult {
                failed: true,
                applied_model_id: None,
            })
        }
        Err(_) => {
            log::warn!(
                "session/set_model modelId={model} timed out for backend {}",
                client.backend_id
            );
            Ok(ModelApplyResult {
                failed: true,
                applied_model_id: None,
            })
        }
    }
}

async fn set_opencode_default_model(
    client: &AcpClient,
    acp_session_id: &str,
) -> Result<(), String> {
    let model = client
        .model_override
        .read()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| OPENCODE_DEFAULT_MODEL.to_string());

    let config_result = tokio::time::timeout(
        Duration::from_secs(10),
        client.request(
            "session/set_config_option",
            json!({
                "sessionId": acp_session_id,
                "configId": "model",
                "value": &model,
            }),
        ),
    )
    .await
    .map_err(|_| "session/set_config_option timed out".to_string())?;

    match config_result {
        Ok(_) => Ok(()),
        Err(config_err) => {
            let model_result = tokio::time::timeout(
                Duration::from_secs(10),
                client.request(
                    "session/set_model",
                    json!({
                        "sessionId": acp_session_id,
                        "modelId": &model,
                    }),
                ),
            )
            .await
            .map_err(|_| "session/set_model timed out".to_string())?;

            model_result.map(|_| ()).map_err(|model_err| {
                format!(
                    "failed to select OpenCode model {model}: {config_err}; fallback {model_err}"
                )
            })
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
    let result = client
        .request(
            "session/prompt",
            json!({ "sessionId": acp_session_id, "prompt": blocks }),
        )
        .await?;
    Ok(result)
}

#[tauri::command]
pub async fn acp_cancel(session: u64, registry: State<'_, Arc<AcpRegistry>>) -> Result<(), String> {
    let client = registry
        .get(session)
        .ok_or_else(|| format!("Unknown ACP session: {session}"))?;
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
        if let Some(parent) = std::path::Path::new(&ctx.path).parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                let _ = ctx.reply.send(Err(
                    json!({ "code": -32000, "message": format!("mkdir: {e}") }),
                ));
                return Ok(());
            }
        }
        match std::fs::write(&ctx.path, &ctx.new_content) {
            Ok(_) => Ok(json!({})),
            Err(e) => Err(json!({ "code": -32000, "message": format!("write: {e}") })),
        }
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
) -> Result<(), String> {
    let Some(client) = registry.remove(session) else {
        return Ok(());
    };
    dispose_client(&client).await;
    Ok(())
}

/// Drain every registered session and tear each one down. Used on app exit
/// so adapters (and their MCP grandchildren via the process-group signal)
/// don't get reparented to launchd.
pub async fn dispose_all(registry: &AcpRegistry) {
    let drained = registry.drain();
    for (_session, client) in drained {
        dispose_client(&client).await;
    }
}

/// Tear down an `AcpClient`: signal its process group (adapter + MCP
/// grandchildren) with SIGTERM, then SIGKILL on timeout. Used by both the
/// per-session `acp_dispose` command and the app-shutdown drain.
async fn dispose_client(client: &AcpClient) {
    client.disposed.store(true, Ordering::Relaxed);
    client.child_pid.store(0, Ordering::Relaxed);
    // Drop stdin to signal EOF.
    {
        let mut g = client.stdin.lock().await;
        *g = None;
    }
    let mut child_guard = client.child.lock().await;
    if let Some(mut child) = child_guard.take() {
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
        if wait_result.is_err() {
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
    }
}

// ─── Lane resource metrics ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AcpLaneMetrics {
    pub session: u64,
    pub root_pid: u32,
    pub root_alive: bool,
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
    let roots: Vec<u32> = pairs.iter().map(|(_, pid)| *pid).collect();
    let trees = sampler.collect(&roots);
    Ok(pairs
        .into_iter()
        .zip(trees)
        .map(|((session, _), t)| AcpLaneMetrics {
            session,
            root_pid: t.root_pid,
            root_alive: t.root_alive,
            total_cpu_percent: t.total_cpu_percent,
            total_rss_mb: t.total_rss_mb,
            proc_count: t.proc_count,
            processes: t.processes,
        })
        .collect())
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

// ─── Junie native MCP overlay (ACP session/new mcpServers is a no-op) ──

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

fn junie_overlay_lane_dir(
    harness_id: &str,
    lane_label: &str,
) -> Result<std::path::PathBuf, String> {
    let base = crate::config::config_dir()
        .ok_or_else(|| "Could not determine config directory".to_string())?;
    Ok(base
        .join("runtime")
        .join("junie")
        .join(sanitize_overlay_path_component(harness_id))
        .join(sanitize_overlay_path_component(lane_label)))
}

/// Write `mcp.json` for Junie `--mcp-location` (overlay root returned).
///
/// Junie's `--mcp-location <folder>` reads `<folder>/mcp.json` directly; it
/// does not treat the folder like a project root looking for nested
/// `.junie/mcp/mcp.json`. Verified against Junie build 1668.54 on 2026-05-26.
#[tauri::command]
pub fn write_junie_mcp_overlay(
    harness_id: String,
    lane_label: String,
    content: String,
) -> Result<String, String> {
    let dir = junie_overlay_lane_dir(&harness_id, &lane_label)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("mcp.json");
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_junie_mcp_overlay(harness_id: String, lane_label: String) -> Result<(), String> {
    let dir = junie_overlay_lane_dir(&harness_id, &lane_label)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Remove stale overlays for a harness (crash recovery) before new lanes spawn.
#[tauri::command]
pub fn gc_junie_mcp_overlays(harness_id: String) -> Result<(), String> {
    let Some(base) = crate::config::config_dir() else {
        return Ok(());
    };
    let dir = base
        .join("runtime")
        .join("junie")
        .join(sanitize_overlay_path_component(&harness_id));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
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
    if backend_id == "junie" {
        if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
            return "Install Junie CLI: `curl -fsSL https://junie.jetbrains.com/install.sh | bash`."
                .to_string();
        }
        if s.contains("unknown option --acp")
            || s.contains("invalid value for --acp")
            || s.contains("unrecognized argument")
        {
            return "Your Junie CLI predates ACP mode. Run `junie --version` (known-good baseline: build 1668.54) and update via the install script.".to_string();
        }
        if s.contains("not authenticated")
            || s.contains("please log in")
            || s.contains("please login")
            || s.contains("authentication required")
            || s.contains("unauthorized")
        {
            return "Run `junie` once in a terminal to log in with your JetBrains Account, pass `--auth <token>` for headless setups, or export `JUNIE_API_KEY` / a provider key (e.g. `ANTHROPIC_API_KEY`) in your login shell.".to_string();
        }
        if s.contains("invalid api key") || s.contains("bad token") || s.contains("api key") {
            return "Junie reports an API key problem. Re-check `JUNIE_API_KEY`, `--auth <token>`, or your BYOK provider key in the login shell.".to_string();
        }
        if s.contains("subscription")
            || s.contains("quota")
            || s.contains("rate limit")
            || s.contains("billing")
        {
            return "Junie reports a subscription/quota issue. Check your JetBrains account or BYOK provider status.".to_string();
        }
        if s.contains("~/.junie") || s.contains(".junie/config.json") {
            return "Junie failed to load its config (likely `~/.junie/config.json` or `<project>/.junie/config.json`). Inspect the file or remove it to fall back to defaults.".to_string();
        }
        if stderr.is_empty() {
            return "Junie did not return an initialize response and no stderr was captured. First-run JetBrains login or install input is a likely cause; run `junie` in a terminal once, then retry.".to_string();
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
    if backend_id == "mimo" {
        // Before the generic `/login`/`not authenticated` branch below — that
        // one names `claude /login`, which is wrong advice for a MiMo lane.
        if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
            return "Install MiMo-Code: `npm install -g @mimo-ai/cli`, then restart Krypton so the login-shell PATH cache includes `mimo`.".to_string();
        }
        if s.contains("api key")
            || s.contains("auth")
            || s.contains("provider")
            || s.contains("/login")
        {
            return "Run `mimo` once in a terminal to complete its first-launch provider setup (MiMo Auto / Xiaomi OAuth / custom provider), then retry.".to_string();
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
    if s.contains("/login") || s.contains("not authenticated") {
        return "Run `claude /login` in a terminal, then retry.".to_string();
    }
    if s.contains("gemini auth") || s.contains("please authenticate") {
        return "Run `gemini auth login` in a terminal, then retry.".to_string();
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
    use super::{disconnect_detail, effective_spawn_model, startup_hint};

    #[test]
    fn mimo_defaults_to_anonymous_free_model() {
        assert_eq!(
            effective_spawn_model("mimo", None).as_deref(),
            Some("mimo/mimo-auto")
        );
        assert_eq!(
            effective_spawn_model("mimo", Some(String::new())).as_deref(),
            Some("mimo/mimo-auto")
        );
    }

    #[test]
    fn configured_mimo_model_overrides_free_default() {
        assert_eq!(
            effective_spawn_model("mimo", Some("mimo/mimo-v2.5".to_string())).as_deref(),
            Some("mimo/mimo-v2.5")
        );
        assert_eq!(effective_spawn_model("claude", None), None);
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
    fn junie_startup_hint_reports_missing_cli() {
        let hint = startup_hint("junie", "junie: command not found");

        assert!(hint.contains("Install Junie CLI"));
        assert!(hint.contains("junie.jetbrains.com/install.sh"));
    }

    #[test]
    fn junie_startup_hint_reports_unknown_acp_flag() {
        let hint = startup_hint("junie", "error: unknown option --acp");

        assert!(hint.contains("predates ACP mode"));
        assert!(hint.contains("1668.54"));
    }

    #[test]
    fn junie_startup_hint_reports_invalid_acp_value() {
        // Local repro from `junie --acp --help` — older CLIs that accept the
        // flag but reject the boolean payload still need the version-update
        // hint, not the auth fallback.
        let hint = startup_hint("junie", "Error: invalid value for --acp: expected boolean");

        assert!(hint.contains("predates ACP mode"));
    }

    #[test]
    fn junie_startup_hint_reports_auth_when_explicit() {
        let hint = startup_hint("junie", "Error: not authenticated to JetBrains account");

        assert!(hint.contains("log in with your JetBrains Account"));
        assert!(hint.contains("JUNIE_API_KEY"));
    }

    #[test]
    fn junie_startup_hint_does_not_treat_bare_login_word_as_auth() {
        let stderr = "debug: login state cache refreshed";
        let hint = startup_hint("junie", stderr);

        assert_eq!(hint, stderr);
    }

    #[test]
    fn junie_startup_hint_reports_subscription_quota() {
        let hint = startup_hint("junie", "ERROR: subscription quota exhausted");

        assert!(hint.contains("subscription/quota issue"));
    }

    #[test]
    fn junie_startup_hint_reports_api_key_problem() {
        let hint = startup_hint("junie", "Error: invalid api key (status 401)");

        assert!(hint.contains("API key problem"));
        assert!(hint.contains("JUNIE_API_KEY"));
    }

    #[test]
    fn junie_startup_hint_does_not_match_bare_forbidden_as_quota() {
        // Cursor-1 review nit: HTTP 403 / "forbidden" alone is not a quota
        // signal. With the matcher narrowed, an unrelated 403 stderr should
        // fall through to the empty-stderr-tail return path instead of
        // mis-hinting users to check their JetBrains subscription.
        let stderr = "Network error: 403 Forbidden from internal proxy";
        let hint = startup_hint("junie", stderr);

        assert!(!hint.contains("subscription/quota issue"));
    }

    #[test]
    fn junie_startup_hint_reports_config_corruption() {
        let hint = startup_hint(
            "junie",
            "Error reading ~/.junie/config.json: invalid JSON at line 4",
        );

        assert!(hint.contains("failed to load its config"));
    }

    #[test]
    fn junie_startup_hint_empty_stderr_is_non_diagnostic() {
        let hint = startup_hint("junie", "");

        assert!(hint.contains("no stderr was captured"));
        assert!(hint.contains("likely cause"));
    }

    #[test]
    fn junie_startup_hint_does_not_leak_to_other_backends() {
        // Junie-specific substring in another backend's stderr must not match
        // the Junie block — backend_id gates the whole arm.
        let hint = startup_hint("claude", "could not read ~/.junie/config.json");

        // Falls through to the generic Claude/auth hint instead of Junie's
        // config-corruption row.
        assert!(!hint.contains("Junie failed to load its config"));
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
    fn mimo_startup_hint_reports_missing_cli() {
        let hint = startup_hint("mimo", "No such file or directory (os error 2)");

        assert!(hint.contains("Install MiMo-Code"));
        assert!(hint.contains("npm install -g @mimo-ai/cli"));
    }

    #[test]
    fn mimo_startup_hint_reports_first_launch_setup_for_auth() {
        // Must hit the mimo branch, not the generic `claude /login` hint.
        let hint = startup_hint("mimo", "Error: not authenticated, please /login");

        assert!(hint.contains("Run `mimo` once"));
        assert!(!hint.contains("claude /login"));
    }

    #[test]
    fn mimo_startup_hint_does_not_leak_to_other_backends() {
        let hint = startup_hint("opencode", "provider auth failed");

        assert!(!hint.contains("MiMo"));
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
    fn junie_overlay_path_sanitizes_lane_label() {
        let dir = super::junie_overlay_lane_dir("h1", "Junie-1").expect("dir");
        let s = dir.to_string_lossy();
        assert!(
            s.contains("runtime/junie/h1/Junie-1") || s.contains("runtime\\junie\\h1\\Junie-1")
        );
        let mcp_json = dir.join("mcp.json");
        assert!(
            mcp_json.to_string_lossy().ends_with("Junie-1/mcp.json")
                || mcp_json.to_string_lossy().ends_with("Junie-1\\mcp.json")
        );
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
}
