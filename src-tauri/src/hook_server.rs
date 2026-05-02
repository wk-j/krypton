// Krypton — Claude Code Hook Server
// Lightweight HTTP server that receives Claude Code hook events and forwards
// them as Tauri events to the frontend.

use axum::{
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// Hook event received from Claude Code via HTTP POST.
/// Common fields are explicit; event-specific fields live in `extra`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeHookEvent {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub hook_event_name: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,

    // Common optional fields
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub model: Option<String>,

    // Tool events (PreToolUse, PostToolUse, PermissionRequest, PostToolUseFailure)
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_input: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_response: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_use_id: Option<String>,

    // Notification fields
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub notification_type: Option<String>,

    // Stop / SubagentStop fields
    #[serde(default)]
    pub last_assistant_message: Option<String>,
    #[serde(default)]
    pub stop_hook_active: Option<bool>,

    // SubagentStart / SubagentStop fields
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub agent_transcript_path: Option<String>,

    // PostToolUseFailure / StopFailure fields
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_details: Option<String>,
    #[serde(default)]
    pub is_interrupt: Option<bool>,

    // InstructionsLoaded fields
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub memory_type: Option<String>,
    #[serde(default)]
    pub load_reason: Option<String>,

    // UserPromptSubmit fields
    #[serde(default)]
    pub prompt: Option<String>,

    // TaskCompleted / TeammateIdle fields
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub task_subject: Option<String>,
    #[serde(default)]
    pub task_description: Option<String>,
    #[serde(default)]
    pub teammate_name: Option<String>,
    #[serde(default)]
    pub team_name: Option<String>,

    // ConfigChange fields
    #[serde(default)]
    pub config_source: Option<String>,

    // WorktreeCreate / WorktreeRemove fields
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,

    // PreCompact / PostCompact fields
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub custom_instructions: Option<String>,
    #[serde(default)]
    pub compact_summary: Option<String>,

    // Elicitation / ElicitationResult fields
    #[serde(default)]
    pub mcp_server_name: Option<String>,
    #[serde(default)]
    pub elicitation_id: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub content: Option<serde_json::Value>,
    #[serde(default)]
    pub requested_schema: Option<serde_json::Value>,

    // SessionEnd fields
    #[serde(default)]
    pub reason: Option<String>,

    // Catch-all for any other fields
    #[serde(flatten)]
    pub extra: Option<serde_json::Value>,
}

/// Shared state for the axum handler.
struct HookServerState {
    app_handle: AppHandle,
    hook_server: Arc<HookServer>,
}

/// Handle for the running hook server (managed by Tauri).
pub struct HookServer {
    pub port: std::sync::Mutex<u16>,
    pub shutdown_tx: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    memories: std::sync::Mutex<HashMap<String, HarnessMemoryStore>>,
    next_harness_id: AtomicU64,
}

impl Default for HookServer {
    fn default() -> Self {
        Self {
            port: std::sync::Mutex::new(0),
            shutdown_tx: std::sync::Mutex::new(None),
            memories: std::sync::Mutex::new(HashMap::new()),
            next_harness_id: AtomicU64::new(1),
        }
    }
}

impl HookServer {
    pub fn new() -> Self {
        Self {
            port: std::sync::Mutex::new(0),
            shutdown_tx: std::sync::Mutex::new(None),
            memories: std::sync::Mutex::new(HashMap::new()),
            next_harness_id: AtomicU64::new(1),
        }
    }

    pub fn get_port(&self) -> u16 {
        *self.port.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn create_harness_memory(&self) -> String {
        let seq = self.next_harness_id.fetch_add(1, Ordering::Relaxed);
        let harness_id = format!("hm-{seq}");
        let mut memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
        memories.insert(harness_id.clone(), HarnessMemoryStore::default());
        harness_id
    }

    pub fn list_harness_memory(&self, harness_id: &str) -> Result<Vec<HarnessMemoryEntry>, String> {
        let memories = self
            .memories
            .lock()
            .map_err(|e| format!("memory lock poisoned: {e}"))?;
        let store = memories
            .get(harness_id)
            .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
        Ok(store.entries.clone())
    }

    pub fn dispose_harness_memory(&self, harness_id: &str) {
        let mut memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
        memories.remove(harness_id);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessMemoryEntry {
    pub id: String,
    pub summary: String,
    pub detail: String,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Default)]
struct HarnessMemoryStore {
    entries: Vec<HarnessMemoryEntry>,
    next_entry_id: u64,
}

const HARNESS_MEMORY_CAP: usize = 100;
const MEMORY_SUMMARY_MAX: usize = 300;
const MEMORY_DETAIL_MAX: usize = 8000;
const MEMORY_SEARCH_DEFAULT_LIMIT: usize = 10;
const MEMORY_SEARCH_MAX_LIMIT: usize = 20;

/// POST /hook — receive a Claude Code hook event.
async fn handle_hook(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Json(event): Json<ClaudeHookEvent>,
) -> StatusCode {
    log::info!(
        "Claude hook received: {} (tool={:?})",
        event.hook_event_name,
        event.tool_name
    );

    if let Err(e) = state.app_handle.emit("claude-hook", &event) {
        log::error!("Failed to emit claude-hook event: {e}");
    }

    StatusCode::OK
}

/// POST /mcp/harness/:harness_id/lane/:lane_label — ACP harness memory MCP.
async fn handle_harness_memory_mcp(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path((harness_id, lane_label)): Path<(String, String)>,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(|v| v.as_str()).unwrap_or("");

    if id.is_none() && method == "notifications/initialized" {
        return StatusCode::ACCEPTED.into_response();
    }

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "krypton-harness-memory",
                "version": env!("CARGO_PKG_VERSION"),
            },
        })),
        "tools/list" => Ok(json!({ "tools": memory_tool_descriptors() })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            handle_memory_tool_call(&state, &harness_id, &lane_label, params)
        }
        "" => Err(json!({ "code": -32600, "message": "Missing method" })),
        other => Err(json!({ "code": -32601, "message": format!("Method not found: {other}") })),
    };

    match (id, result) {
        (Some(id), Ok(result)) => {
            Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
        }
        (Some(id), Err(error)) => {
            Json(json!({ "jsonrpc": "2.0", "id": id, "error": error })).into_response()
        }
        (None, Ok(_)) => StatusCode::ACCEPTED.into_response(),
        (None, Err(error)) => Json(json!({ "jsonrpc": "2.0", "error": error })).into_response(),
    }
}

fn handle_memory_tool_call(
    state: &HookServerState,
    harness_id: &str,
    lane_label: &str,
    params: Value,
) -> Result<Value, Value> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| json!({ "code": -32602, "message": "tools/call missing params.name" }))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let outcome = match name {
        "memory_create" => memory_create(&state.hook_server, harness_id, lane_label, arguments),
        "memory_update" => memory_update(&state.hook_server, harness_id, lane_label, arguments),
        "memory_delete" => memory_delete(&state.hook_server, harness_id, arguments),
        "memory_search" => memory_search(&state.hook_server, harness_id, arguments),
        "memory_get" => memory_get(&state.hook_server, harness_id, arguments),
        other => Err(format!("Unknown memory tool: {other}")),
    };

    let is_error = outcome.is_err();
    if !is_error && matches!(name, "memory_create" | "memory_update" | "memory_delete") {
        let _ = state.app_handle.emit(
            "acp-harness-memory-changed",
            json!({ "harnessId": harness_id }),
        );
    }
    let text = match outcome {
        Ok(value) => serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
        Err(message) => message,
    };
    Ok(json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    }))
}

fn memory_create(
    hook_server: &HookServer,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let summary = required_string(&arguments, "summary")?;
    let detail = required_string(&arguments, "detail")?;
    validate_memory_text(&summary, MEMORY_SUMMARY_MAX, "summary")?;
    validate_memory_text(&detail, MEMORY_DETAIL_MAX, "detail")?;
    let normalized_summary = normalize_ws(&summary);
    let now = now_ms();

    let mut memories = hook_server
        .memories
        .lock()
        .map_err(|e| format!("memory lock poisoned: {e}"))?;
    let store = memories
        .get_mut(harness_id)
        .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
    if store
        .entries
        .iter()
        .any(|entry| normalize_ws(&entry.summary).eq_ignore_ascii_case(&normalized_summary))
    {
        return Err("memory summary already exists".to_string());
    }
    store.next_entry_id += 1;
    let entry = HarnessMemoryEntry {
        id: format!("M{}", store.next_entry_id),
        summary: normalized_summary,
        detail: detail.trim().to_string(),
        created_by: lane_label.to_string(),
        updated_by: lane_label.to_string(),
        created_at: now,
        updated_at: now,
    };
    store.entries.push(entry.clone());
    while store.entries.len() > HARNESS_MEMORY_CAP {
        if let Some((index, _)) = store
            .entries
            .iter()
            .enumerate()
            .min_by_key(|(_, entry)| entry.updated_at)
        {
            store.entries.remove(index);
        } else {
            break;
        }
    }
    Ok(json!({ "entry": entry }))
}

fn memory_update(
    hook_server: &HookServer,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let id = required_string(&arguments, "id")?;
    let summary = optional_string(&arguments, "summary")?;
    let detail = optional_string(&arguments, "detail")?;
    if summary.is_none() && detail.is_none() {
        return Err("memory_update requires summary or detail".to_string());
    }
    if let Some(summary) = summary.as_ref() {
        validate_memory_text(summary, MEMORY_SUMMARY_MAX, "summary")?;
    }
    if let Some(detail) = detail.as_ref() {
        validate_memory_text(detail, MEMORY_DETAIL_MAX, "detail")?;
    }

    let mut memories = hook_server
        .memories
        .lock()
        .map_err(|e| format!("memory lock poisoned: {e}"))?;
    let store = memories
        .get_mut(harness_id)
        .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
    let entry_index = store
        .entries
        .iter()
        .position(|entry| entry.id.eq_ignore_ascii_case(&id))
        .ok_or_else(|| format!("Memory not found: {id}"))?;
    if let Some(summary) = summary.as_ref() {
        let normalized = normalize_ws(summary);
        if store.entries.iter().enumerate().any(|(index, entry)| {
            index != entry_index && normalize_ws(&entry.summary).eq_ignore_ascii_case(&normalized)
        }) {
            return Err("memory summary already exists".to_string());
        }
        store.entries[entry_index].summary = normalized;
    }
    if let Some(detail) = detail {
        store.entries[entry_index].detail = detail.trim().to_string();
    }
    store.entries[entry_index].updated_by = lane_label.to_string();
    store.entries[entry_index].updated_at = now_ms();
    let entry = store.entries[entry_index].clone();
    Ok(json!({ "entry": entry }))
}

fn memory_delete(
    hook_server: &HookServer,
    harness_id: &str,
    arguments: Value,
) -> Result<Value, String> {
    let id = required_string(&arguments, "id")?;
    let mut memories = hook_server
        .memories
        .lock()
        .map_err(|e| format!("memory lock poisoned: {e}"))?;
    let store = memories
        .get_mut(harness_id)
        .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
    let index = store
        .entries
        .iter()
        .position(|entry| entry.id.eq_ignore_ascii_case(&id))
        .ok_or_else(|| format!("Memory not found: {id}"))?;
    let removed = store.entries.remove(index);
    Ok(json!({ "deleted": removed.id }))
}

fn memory_search(
    hook_server: &HookServer,
    harness_id: &str,
    arguments: Value,
) -> Result<Value, String> {
    let query = normalize_ws(&required_string(&arguments, "query")?).to_lowercase();
    if query.is_empty() {
        return Err("query is required".to_string());
    }
    let limit = arguments
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(MEMORY_SEARCH_DEFAULT_LIMIT)
        .clamp(1, MEMORY_SEARCH_MAX_LIMIT);
    let memories = hook_server
        .memories
        .lock()
        .map_err(|e| format!("memory lock poisoned: {e}"))?;
    let store = memories
        .get(harness_id)
        .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
    let mut matches: Vec<(u8, &HarnessMemoryEntry)> = store
        .entries
        .iter()
        .filter_map(|entry| {
            let summary = entry.summary.to_lowercase();
            let detail = entry.detail.to_lowercase();
            if summary.contains(&query) {
                Some((0, entry))
            } else if detail.contains(&query) {
                Some((1, entry))
            } else {
                None
            }
        })
        .collect();
    matches.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.updated_at.cmp(&a.1.updated_at))
    });
    let entries: Vec<Value> = matches
        .into_iter()
        .take(limit)
        .map(|(_, entry)| {
            json!({
                "id": entry.id,
                "summary": entry.summary,
                "updatedBy": entry.updated_by,
                "updatedAt": entry.updated_at,
            })
        })
        .collect();
    Ok(json!({ "entries": entries }))
}

fn memory_get(
    hook_server: &HookServer,
    harness_id: &str,
    arguments: Value,
) -> Result<Value, String> {
    let id = required_string(&arguments, "id")?;
    let memories = hook_server
        .memories
        .lock()
        .map_err(|e| format!("memory lock poisoned: {e}"))?;
    let store = memories
        .get(harness_id)
        .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
    let entry = store
        .entries
        .iter()
        .find(|entry| entry.id.eq_ignore_ascii_case(&id))
        .ok_or_else(|| format!("Memory not found: {id}"))?;
    Ok(json!({ "entry": entry }))
}

fn memory_tool_descriptors() -> Value {
    json!([
        {
            "name": "memory_create",
            "description": "Create one tab-local Krypton harness memory. Use a short summary and full detail.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": { "type": "string", "maxLength": MEMORY_SUMMARY_MAX },
                    "detail": { "type": "string", "maxLength": MEMORY_DETAIL_MAX }
                },
                "required": ["summary", "detail"]
            }
        },
        {
            "name": "memory_update",
            "description": "Update an existing Krypton harness memory by id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "summary": { "type": "string", "maxLength": MEMORY_SUMMARY_MAX },
                    "detail": { "type": "string", "maxLength": MEMORY_DETAIL_MAX }
                },
                "required": ["id"]
            }
        },
        {
            "name": "memory_delete",
            "description": "Delete an existing Krypton harness memory by id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "memory_search",
            "description": "Search memory summaries and details. Results contain summaries only; call memory_get for full detail.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "number", "minimum": 1, "maximum": MEMORY_SEARCH_MAX_LIMIT }
                },
                "required": ["query"]
            }
        },
        {
            "name": "memory_get",
            "description": "Fetch one full memory detail by id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        }
    ])
}

fn required_string(arguments: &Value, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .ok_or_else(|| format!("{key} is required"))
}

fn optional_string(arguments: &Value, key: &str) -> Result<Option<String>, String> {
    match arguments.get(key) {
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} must be a string")),
        None => Ok(None),
    }
}

fn validate_memory_text(value: &str, max_chars: usize, field: &str) -> Result<(), String> {
    let len = value.chars().count();
    if len == 0 {
        return Err(format!("{field} is required"));
    }
    if len > max_chars {
        return Err(format!("{field} exceeds {max_chars} characters"));
    }
    Ok(())
}

fn normalize_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Start the HTTP hook server on a dedicated tokio runtime.
/// Binds to 127.0.0.1 on the configured port (0 = auto-assign).
/// Returns the actual port the server bound to.
pub fn start(app_handle: AppHandle, hook_server: Arc<HookServer>, configured_port: u16) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("Failed to create tokio runtime for hook server: {e}");
                return;
            }
        };

        rt.block_on(async move {
            let shared = Arc::new(HookServerState {
                app_handle: app_handle.clone(),
                hook_server: hook_server.clone(),
            });

            let app = Router::new()
                .route("/hook", post(handle_hook))
                .route(
                    "/mcp/harness/{harness_id}/lane/{lane_label}",
                    post(handle_harness_memory_mcp),
                )
                .with_state(shared);

            let addr = SocketAddr::from(([127, 0, 0, 1], configured_port));
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    log::error!("Failed to bind hook server on {addr}: {e}");
                    return;
                }
            };

            let actual_port = match listener.local_addr() {
                Ok(a) => a.port(),
                Err(e) => {
                    log::error!("Failed to get local address: {e}");
                    return;
                }
            };

            // Store the actual port
            if let Ok(mut p) = hook_server.port.lock() {
                *p = actual_port;
            }

            log::info!("Claude Code hook server listening on 127.0.0.1:{actual_port}");

            // Emit server-ready event so frontend knows the port
            let _ = app_handle.emit("claude-hook-server-ready", actual_port);

            // Set up graceful shutdown
            let (tx, rx) = oneshot::channel::<()>();
            if let Ok(mut stx) = hook_server.shutdown_tx.lock() {
                *stx = Some(tx);
            }

            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .unwrap_or_else(|e| {
                    log::error!("Hook server error: {e}");
                });
        });
    });
}
