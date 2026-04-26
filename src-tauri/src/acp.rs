// Krypton — ACP (Agent Client Protocol) backend.
//
// Spawns an external agent subprocess (e.g. `npx @agentclientprotocol/claude-agent-acp`,
// `gemini --experimental-acp`) and speaks newline-delimited JSON-RPC 2.0 over its
// stdio. One AcpClient per Krypton-side session. The Rust side acts as the JSON-RPC
// client *and* must handle inbound requests (fs/read_text_file, fs/write_text_file,
// session/request_permission) initiated by the agent.
//
// See docs/69-acp-agent-support.md for the design.

use crate::config::KryptonConfig;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

// ─── Cached PATH ───────────────────────────────────────────────────

static CACHED_LOGIN_PATH: OnceLock<String> = OnceLock::new();

/// Resolve PATH from a login shell (so Homebrew `gemini`, nvm `npx`, etc. are
/// visible to GUI launches). Cached for the life of the process.
fn cached_login_path() -> String {
    CACHED_LOGIN_PATH
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let output = std::process::Command::new(&shell)
                .args(["-l", "-c", "printenv PATH"])
                .output();
            match output {
                Ok(out) => {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if s.is_empty() {
                        std::env::var("PATH").unwrap_or_default()
                    } else {
                        s
                    }
                }
                Err(_) => std::env::var("PATH").unwrap_or_default(),
            }
        })
        .clone()
}

/// Resolve `$VAR` references in env values via the login shell. Plain values pass through.
fn resolve_env_value(raw: &str) -> String {
    if let Some(name) = raw.strip_prefix('$') {
        if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            if let Ok(v) = std::env::var(name) {
                return v;
            }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            if let Ok(out) = std::process::Command::new(&shell)
                .args(["-l", "-c", &format!("printenv {name}")])
                .output()
            {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
            return String::new();
        }
    }
    raw.to_string()
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

// ─── AcpClient ─────────────────────────────────────────────────────

struct AcpClient {
    krypton_session: u64,
    backend_id: String,
    #[allow(dead_code)]
    display_name: String,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    perm_pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    /// Set after `initialize` completes. Notification before this point is rare.
    agent_capabilities: RwLock<Option<Value>>,
    /// Filled by `session/new` response.
    acp_session_id: RwLock<Option<String>>,
    /// Rolling stderr capture (max 64KB) — surfaced on startup failure.
    stderr_buf: Mutex<String>,
    /// Holds the child handle so we can SIGTERM/SIGKILL it; None after dispose.
    child: Mutex<Option<Child>>,
    /// Working directory the child was spawned in — also reported as project root
    /// in `session/new`. Falls back to the host process cwd when None.
    cwd: RwLock<Option<String>>,
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
            next_id: AtomicU64::new(1),
            agent_capabilities: RwLock::new(None),
            acp_session_id: RwLock::new(None),
            stderr_buf: Mutex::new(String::new()),
            child: Mutex::new(None),
            cwd: RwLock::new(None),
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
        let _ = app.emit(&self.event_name(), payload);
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
        let id = value
            .get("id")
            .and_then(|v| v.as_u64())
            .unwrap_or(u64::MAX);
        let mut pending = client.pending.lock().await;
        if let Some(tx) = pending.remove(&id) {
            let _ = tx.send(value);
        } else {
            log::debug!("[acp:{}] response for unknown id {id}", client.krypton_session);
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
            let result = std::fs::read_to_string(&path)
                .map(|content| json!({ "content": content }))
                .map_err(|e| json!({ "code": -32000, "message": format!("fs/read_text_file: {e}") }));
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
            let result: Result<Value, Value> = (|| {
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| json!({"code": -32000, "message": format!("mkdir: {e}")}))?;
                }
                std::fs::write(&path, content)
                    .map_err(|e| json!({"code": -32000, "message": format!("write: {e}")}))?;
                Ok(json!({}))
            })();
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
                log::debug!("[acp:{}] stderr: {}", client.krypton_session, line.trim_end());
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
}

impl Default for AcpRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Tauri commands ────────────────────────────────────────────────

#[tauri::command]
pub fn acp_list_backends(
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
) -> Result<Vec<AcpBackendDescriptor>, String> {
    let cfg = config.read().map_err(|e| format!("config lock: {e}"))?;
    let mut out: Vec<AcpBackendDescriptor> = cfg
        .acp
        .iter()
        .map(|(id, b)| AcpBackendDescriptor {
            id: id.clone(),
            display_name: if b.display_name.is_empty() {
                id.clone()
            } else {
                b.display_name.clone()
            },
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
    app: AppHandle,
    registry: State<'_, Arc<AcpRegistry>>,
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
) -> Result<u64, String> {
    let backend = {
        let cfg = config.read().map_err(|e| format!("config lock: {e}"))?;
        cfg.acp
            .get(&backend_id)
            .cloned()
            .ok_or_else(|| format!("Unknown ACP backend: {backend_id}"))?
    };

    let display_name = if backend.display_name.is_empty() {
        backend_id.clone()
    } else {
        backend.display_name.clone()
    };

    let mut cmd = Command::new(&backend.command);
    cmd.args(&backend.args)
        .env("PATH", cached_login_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(d) = cwd.as_ref() {
        cmd.current_dir(d);
    }
    for (k, v) in &backend.env {
        cmd.env(k, resolve_env_value(v));
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {} {}: {e}", backend.command, backend.args.join(" ")))?;

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
    if let Ok(mut g) = client.cwd.write() {
        *g = cwd.clone();
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
) -> Result<AgentInfo, String> {
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

    // Project root for session/new: the cwd we spawned the child with, falling
    // back to the host process cwd. Without this, the agent treats `/` as the
    // project root and reads/writes happen at filesystem root.
    let session_cwd = client
        .cwd
        .read()
        .ok()
        .and_then(|g| g.clone())
        .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string()));

    let new_session = tokio::time::timeout(
        Duration::from_secs(30),
        client.request(
            "session/new",
            json!({
                "cwd": session_cwd,
                "mcpServers": [],
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

    Ok(AgentInfo {
        agent_protocol_version: proto,
        auth_methods,
        agent_capabilities: capabilities,
        session_id: acp_session_id,
    })
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
pub async fn acp_cancel(
    session: u64,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
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
pub async fn acp_dispose(
    session: u64,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String> {
    let Some(client) = registry.remove(session) else {
        return Ok(());
    };
    client.disposed.store(true, Ordering::Relaxed);
    // Drop stdin to signal EOF.
    {
        let mut g = client.stdin.lock().await;
        *g = None;
    }
    // Try graceful exit, then SIGKILL.
    let mut child_guard = client.child.lock().await;
    if let Some(mut child) = child_guard.take() {
        #[cfg(unix)]
        {
            if let Some(pid) = child.id() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
        }
        let wait_result =
            tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        if wait_result.is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
    Ok(())
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
    if s.contains("npm err") || s.contains("enoent") {
        return "Check network or install the adapter manually: `npm i -g @agentclientprotocol/claude-agent-acp`.".to_string();
    }
    if stderr.is_empty() {
        format!("Adapter `{backend_id}` failed to start.")
    } else {
        let tail: String = stderr.chars().rev().take(2048).collect::<Vec<_>>().into_iter().rev().collect();
        tail
    }
}
