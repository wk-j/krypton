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

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionInfo {
    pub session_id: String,
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
            Err(_) => Err(format!("{method}: subprocess closed before reply")),
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
                | "agent_thought_chunk"
                | "tool_call"
                | "tool_call_update"
                | "plan"
                | "usage_update"
                | "available_commands_update"
                | "current_mode_update" => {
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
pub async fn acp_spawn(
    backend_id: String,
    cwd: Option<String>,
    mcp_servers: Option<Vec<Value>>,
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

    // Resolve configured active model for this backend (empty string = unset).
    let configured_model: Option<String> = config
        .read()
        .ok()
        .and_then(|cfg| cfg.acp_harness.lane_models.get(&backend_id).cloned())
        .map(|m| m.active)
        .filter(|s| !s.is_empty());

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

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn {} {}: {e}",
            backend.command,
            backend.args.join(" ")
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

    let init = tokio::time::timeout(
        Duration::from_secs(30),
        client.request("initialize", init_params),
    )
    .await
    .map_err(|_| {
        format!(
            "ACP initialize timed out after 30s. {}",
            startup_hint(&client.backend_id, "")
        )
    })??;

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
    let session_cwd = client.cwd.read().ok().and_then(|g| g.clone()).or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    });
    let mcp_servers = client
        .mcp_servers
        .read()
        .map(|g| g.clone())
        .unwrap_or_default();

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
    if let Ok(mut g) = client.acp_session_id.write() {
        *g = Some(acp_session_id.clone());
    }

    if client.backend_id == "opencode" {
        set_opencode_default_model(&client, &acp_session_id).await?;
    }

    Ok(AgentSessionInfo {
        session_id: acp_session_id,
    })
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

// ─── Helpers ───────────────────────────────────────────────────────

fn startup_hint(backend_id: &str, stderr: &str) -> String {
    let s = stderr.to_lowercase();
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
        let tail: String = stderr
            .chars()
            .rev()
            .take(2048)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        tail
    }
}
