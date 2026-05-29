// Krypton — Claude Code Hook Server
// Lightweight HTTP server that receives Claude Code hook events and forwards
// them as Tauri events to the frontend.

use axum::{
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path as StdPath, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::sync::oneshot;

use crate::util::emit::EmitExt;

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
    last_error: std::sync::Mutex<Option<String>>,
    memories: std::sync::Mutex<HashMap<String, HarnessMemoryStore>>,
    mcp_stats: std::sync::Mutex<HashMap<String, HashMap<String, McpLaneStats>>>,
    next_harness_id: AtomicU64,
    /// In-flight bus requests awaiting a frontend reply (peer_send, peer_list).
    /// Keyed by requestId. Sender is consumed on reply.
    pending_bus_replies: std::sync::Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl Default for HookServer {
    fn default() -> Self {
        Self {
            port: std::sync::Mutex::new(0),
            shutdown_tx: std::sync::Mutex::new(None),
            last_error: std::sync::Mutex::new(None),
            memories: std::sync::Mutex::new(HashMap::new()),
            mcp_stats: std::sync::Mutex::new(HashMap::new()),
            next_harness_id: AtomicU64::new(1),
            pending_bus_replies: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl HookServer {
    pub fn new() -> Self {
        Self {
            port: std::sync::Mutex::new(0),
            shutdown_tx: std::sync::Mutex::new(None),
            last_error: std::sync::Mutex::new(None),
            memories: std::sync::Mutex::new(HashMap::new()),
            mcp_stats: std::sync::Mutex::new(HashMap::new()),
            next_harness_id: AtomicU64::new(1),
            pending_bus_replies: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Register a oneshot for a bus request awaiting a frontend reply.
    fn register_bus_reply(&self, request_id: String) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let mut map = self
            .pending_bus_replies
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.insert(request_id, tx);
        rx
    }

    /// Drop a registered oneshot without firing it (e.g., on timeout).
    fn drop_bus_reply(&self, request_id: &str) {
        let mut map = self
            .pending_bus_replies
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.remove(request_id);
    }

    /// Complete a pending bus request with a frontend-supplied value.
    /// Called by the `acp_bus_reply` Tauri command.
    pub fn complete_bus_reply(&self, request_id: &str, value: Value) -> bool {
        let sender = {
            let mut map = self
                .pending_bus_replies
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.remove(request_id)
        };
        match sender {
            Some(tx) => tx.send(value).is_ok(),
            None => false,
        }
    }

    pub fn get_port(&self) -> u16 {
        *self.port.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn unavailable_reason(&self) -> String {
        self.last_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(|| "Krypton hook server is not running".to_string())
    }

    fn set_error(&self, error: String) {
        if let Ok(mut last_error) = self.last_error.lock() {
            *last_error = Some(error);
        }
    }

    fn clear_error(&self) {
        if let Ok(mut last_error) = self.last_error.lock() {
            *last_error = None;
        }
    }

    pub fn create_harness_memory(&self, project_dir: Option<String>) -> String {
        let seq = self.next_harness_id.fetch_add(1, Ordering::Relaxed);
        let harness_id = format!("hm-{seq}");

        let persistence_path = project_dir
            .as_ref()
            .and_then(|dir| get_persistence_path(dir));
        let mut lanes = HashMap::new();

        if let Some(ref path) = persistence_path {
            if path.exists() {
                match std::fs::read_to_string(path) {
                    Ok(content) => match serde_json::from_str::<PersistedMemory>(&content) {
                        Ok(persisted) => {
                            if persisted.version == 1 {
                                lanes = persisted.lanes;
                                log::info!(
                                    "Loaded persisted memory for project: {}",
                                    persisted.project_dir
                                );
                            } else {
                                log::warn!("Unsupported memory version: {}", persisted.version);
                            }
                        }
                        Err(e) => {
                            log::warn!(
                                "Failed to parse persisted memory at {}: {e}",
                                path.display()
                            );
                            let broken_path =
                                path.with_extension(format!("json.broken-{}", now_ms()));
                            let _ = std::fs::rename(path, broken_path);
                        }
                    },
                    Err(e) => {
                        log::warn!("Failed to read persisted memory at {}: {e}", path.display());
                    }
                }
            }
        }

        let store = HarnessMemoryStore {
            lanes,
            persistence_path,
            project_dir,
            save_pending: Arc::new(AtomicBool::new(false)),
        };

        let mut memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
        memories.insert(harness_id.clone(), store);
        harness_id
    }

    fn schedule_save(self: &Arc<Self>, harness_id: &str) {
        let memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
        let store = match memories.get(harness_id) {
            Some(s) => s,
            None => return,
        };

        if store.persistence_path.is_none() {
            return;
        }

        if store.save_pending.swap(true, Ordering::SeqCst) {
            // Already a save pending
            return;
        }

        let persistence_path = store.persistence_path.clone().unwrap();
        let project_dir = store.project_dir.clone().unwrap_or_default();
        let save_pending = store.save_pending.clone();
        let harness_id = harness_id.to_string();
        let self_clone = self.clone();

        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            save_pending.store(false, Ordering::SeqCst);

            // Snapshot lanes under lock AFTER the sleep to get the latest state
            let lanes = {
                let memories = self_clone
                    .memories
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                match memories.get(&harness_id) {
                    Some(store) => store.lanes.clone(),
                    None => return,
                }
            };

            let persisted = PersistedMemory {
                version: 1,
                project_dir,
                saved_at: now_ms(),
                lanes,
            };

            let tmp_path = persistence_path.with_extension("json.tmp");
            match serde_json::to_string_pretty(&persisted) {
                Ok(json) => {
                    if let Err(e) = std::fs::write(&tmp_path, json) {
                        log::warn!("Failed to write memory tmp file: {e}");
                        return;
                    }
                    if let Err(e) = std::fs::rename(&tmp_path, &persistence_path) {
                        log::warn!("Failed to rename memory file: {e}");
                    }
                }
                Err(e) => {
                    log::warn!("Failed to serialize memory: {e}");
                }
            }
        });
    }

    pub fn clear_harness_memory_lane(
        self: &Arc<Self>,
        harness_id: &str,
        lane: &str,
    ) -> Result<(), String> {
        let mut memories = self
            .memories
            .lock()
            .map_err(|e| format!("memory lock poisoned: {e}"))?;
        let store = memories
            .get_mut(harness_id)
            .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;

        store.lanes.remove(lane);
        drop(memories);
        self.schedule_save(harness_id);
        Ok(())
    }

    pub fn list_harness_memory(&self, harness_id: &str) -> Result<Vec<HarnessMemoryEntry>, String> {
        let memories = self
            .memories
            .lock()
            .map_err(|e| format!("memory lock poisoned: {e}"))?;
        let store = memories
            .get(harness_id)
            .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
        let mut entries: Vec<HarnessMemoryEntry> = store
            .lanes
            .iter()
            .map(|(lane, doc)| HarnessMemoryEntry {
                lane: lane.clone(),
                summary: doc.summary.clone(),
                detail: doc.detail.clone(),
                updated_at: doc.updated_at,
            })
            .collect();
        entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(entries)
    }

    pub fn dispose_harness_memory(&self, harness_id: &str) {
        let mut memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
        memories.remove(harness_id);
        let mut stats = self.mcp_stats.lock().unwrap_or_else(|e| e.into_inner());
        stats.remove(harness_id);
    }

    pub fn list_harness_mcp_stats(&self, harness_id: &str) -> Vec<McpLaneStatsEntry> {
        let stats = self.mcp_stats.lock().unwrap_or_else(|e| e.into_inner());
        stats
            .get(harness_id)
            .map(|lanes| {
                let mut out: Vec<McpLaneStatsEntry> = lanes
                    .iter()
                    .map(|(label, s)| McpLaneStatsEntry {
                        lane_label: label.clone(),
                        initialize_count: s.initialize_count,
                        tools_list_count: s.tools_list_count,
                        tools_call_count: s.tools_call_count,
                        last_method: s.last_method.clone(),
                        last_seen_at: s.last_seen_at,
                    })
                    .collect();
                out.sort_by(|a, b| a.lane_label.cmp(&b.lane_label));
                out
            })
            .unwrap_or_default()
    }

    fn record_mcp_request(&self, harness_id: &str, lane_label: &str, method: &str) {
        let mut stats = self.mcp_stats.lock().unwrap_or_else(|e| e.into_inner());
        let lanes = stats.entry(harness_id.to_string()).or_default();
        let entry = lanes.entry(lane_label.to_string()).or_default();
        match method {
            "initialize" => entry.initialize_count += 1,
            "tools/list" => entry.tools_list_count += 1,
            "tools/call" => entry.tools_call_count += 1,
            _ => {}
        }
        entry.last_method = Some(method.to_string());
        entry.last_seen_at = now_ms();
    }
}

#[derive(Debug, Default, Clone)]
struct McpLaneStats {
    initialize_count: u64,
    tools_list_count: u64,
    tools_call_count: u64,
    last_method: Option<String>,
    last_seen_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLaneStatsEntry {
    pub lane_label: String,
    pub initialize_count: u64,
    pub tools_list_count: u64,
    pub tools_call_count: u64,
    pub last_method: Option<String>,
    pub last_seen_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessMemoryEntry {
    pub lane: String,
    pub summary: String,
    pub detail: String,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMemory {
    version: u32,
    project_dir: String,
    saved_at: u64,
    lanes: HashMap<String, LaneMemoryDoc>,
}

#[derive(Debug, Default)]
struct HarnessMemoryStore {
    /// Key: lane label. One document per lane that has set memory.
    lanes: HashMap<String, LaneMemoryDoc>,
    persistence_path: Option<PathBuf>,
    project_dir: Option<String>,
    save_pending: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaneMemoryDoc {
    summary: String,
    detail: String,
    updated_at: u64,
}

const MEMORY_SUMMARY_MAX: usize = 300;
const MEMORY_DETAIL_MAX: usize = 8000;

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

    state.app_handle.emit_or_log("claude-hook", &event);

    StatusCode::OK
}

/// GET /mcp/harness/:harness_id/lane/:lane_label — Streamable HTTP SSE channel.
///
/// The MCP "Streamable HTTP" transport opens this stream to receive
/// server-initiated messages. We never push events from here (the server is
/// pure request/response), so the stream stays idle and only emits SSE
/// keepalive comments. Junie's Kotlin MCP SDK treats a 405 here as a hard
/// transport failure even though the spec permits it, so we serve a valid
/// (but empty) stream instead.
///
/// We emit one SSE comment immediately so Junie's client sees bytes before
/// its initial-response timer fires (verified: a 15s-only keepalive lets
/// Junie time out at ~3–5s with zero bytes received). After the first
/// comment, a 5s keepalive keeps the connection warm.
async fn handle_harness_memory_mcp_sse(
    Path((_harness_id, _lane_label)): Path<(String, String)>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let initial = stream::once(async { Ok::<_, Infallible>(Event::default().comment("ready")) });
    let s = initial.chain(stream::pending::<Result<Event, Infallible>>());
    Sse::new(s).keep_alive(KeepAlive::new().interval(Duration::from_secs(5)))
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
        state
            .hook_server
            .record_mcp_request(&harness_id, &lane_label, "notifications/initialized");
        state.app_handle.emit_or_log(
            "acp-harness-mcp-touched",
            json!({ "harnessId": harness_id, "laneLabel": lane_label }),
        );
        return StatusCode::ACCEPTED.into_response();
    }

    if !method.is_empty() {
        state
            .hook_server
            .record_mcp_request(&harness_id, &lane_label, method);
        state.app_handle.emit_or_log(
            "acp-harness-mcp-touched",
            json!({ "harnessId": harness_id, "laneLabel": lane_label }),
        );
    }

    let result = match method {
        "initialize" => {
            // Echo back the client's protocolVersion when we recognize it; the
            // Kotlin MCP SDK that Junie ships throws `Server's protocol
            // version is not supported: <ours>` if we unconditionally return
            // a newer version than what the client requested. Falling back to
            // the request version (or our default if absent/unknown) keeps
            // every existing client working — our handler only implements
            // `tools/list` + `tools/call`, both unchanged across these spec
            // versions.
            const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
                &["2025-06-18", "2025-03-26", "2024-11-05"];
            const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
            let requested = request
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str());
            let negotiated = requested
                .filter(|v| SUPPORTED_PROTOCOL_VERSIONS.contains(v))
                .unwrap_or(DEFAULT_PROTOCOL_VERSION);
            Ok(json!({
                "protocolVersion": negotiated,
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "krypton-harness-bus",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }))
        }
        "tools/list" => Ok(json!({ "tools": bus_tool_descriptors() })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            handle_bus_tool_call(&state, &harness_id, &lane_label, params).await
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

async fn handle_bus_tool_call(
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
        "memory_set" => memory_set(&state.hook_server, harness_id, lane_label, arguments),
        "memory_get" => memory_get(&state.hook_server, harness_id, arguments),
        "memory_list" => memory_list(&state.hook_server, harness_id),
        "peer_send" => peer_send(state, harness_id, lane_label, arguments).await,
        "peer_list" => peer_list(state, harness_id).await,
        "review_request" => review_request(state, harness_id, lane_label, arguments).await,
        "review_reply" => review_reply(state, harness_id, lane_label, arguments).await,
        "directive_list" => directive_list(),
        "directive_preview" => directive_preview(arguments),
        "directive_apply" => directive_apply(state, harness_id, lane_label, arguments).await,
        "directive_remove" => directive_remove(state, harness_id, lane_label, arguments).await,
        other => Err(format!("Unknown bus tool: {other}")),
    };

    let is_error = outcome.is_err();
    if !is_error && name == "memory_set" {
        state.app_handle.emit_or_log(
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

/// Timeout for the frontend round-trip on bus tools (peer_send, peer_list).
/// Generous because the frontend may be mid-render or animating.
const BUS_REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2500);

/// peer_send — emit an `acp-inter-lane-message` Tauri event and await the
/// frontend coordinator's delivery outcome. The frontend is the authority on
/// lane registry / inbox state.
async fn peer_send(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    let to_lane = required_string(&arguments, "to_lane")?;
    let message = required_string(&arguments, "message")?;
    let done = arguments
        .get("done")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if to_lane.trim().is_empty() {
        return Err("to_lane must be non-empty".to_string());
    }
    if message.trim().is_empty() {
        return Err("message must be non-empty".to_string());
    }
    let envelope_id = format!("env-{}-{}", now_ms(), rand_suffix());
    let envelope = json!({
        "id": envelope_id,
        "fromLaneId": from_lane,
        "toLaneId": to_lane,
        "message": message,
        "done": done,
        "sentAt": now_ms(),
        "harnessId": harness_id,
        "requestId": envelope_id,
    });
    let rx = state.hook_server.register_bus_reply(envelope_id.clone());
    state
        .app_handle
        .emit_or_log("acp-inter-lane-message", envelope);
    let reply = match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            // Sender dropped (e.g., frontend listener missing) — treat as failure.
            return Err("peer_send: frontend coordinator did not respond".to_string());
        }
        Err(_) => {
            state.hook_server.drop_bus_reply(&envelope_id);
            return Err("peer_send: frontend reply timed out".to_string());
        }
    };
    if reply
        .get("delivered")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        Ok(reply)
    } else {
        let reason = reply
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("delivery_failed");
        let message = if reason == "peer_in_flight" {
            "peer_send failed: one outstanding message per target lane; wait for their reply before sending again"
                .to_string()
        } else {
            format!("peer_send failed: {reason}")
        };
        Err(message)
    }
}

/// peer_list — request the frontend's live lane summary list and return it.
async fn peer_list(state: &HookServerState, harness_id: &str) -> Result<Value, String> {
    let request_id = format!("plist-{}-{}", now_ms(), rand_suffix());
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state.app_handle.emit_or_log(
        "acp-peer-list-requested",
        json!({ "harnessId": harness_id, "requestId": request_id }),
    );
    match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("peer_list: frontend coordinator did not respond".to_string()),
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            Err("peer_list: frontend reply timed out".to_string())
        }
    }
}

/// review_request — ask the frontend coordinator to assemble the packet
/// (lane cwd + transcript signals + git state) and deliver to the recipient's
/// inbox. The frontend listener collects git state via the
/// `acp_collect_review_git_state` Tauri command — Rust here does not touch
/// git, so the agent never needs to know or pass `cwd`.
async fn review_request(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    let to_lane = required_string(&arguments, "to_lane")?;
    if to_lane.trim().is_empty() {
        return Err("to_lane must be non-empty".to_string());
    }
    let note = arguments
        .get("note")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let packet_id = format!("rev-{}-{}", now_ms(), rand_suffix());
    let payload = json!({
        "packetId": packet_id,
        "fromLaneId": from_lane,
        "toLaneId": to_lane,
        "note": note,
        "sentAt": now_ms(),
        "harnessId": harness_id,
        "requestId": packet_id,
    });
    let rx = state.hook_server.register_bus_reply(packet_id.clone());
    state
        .app_handle
        .emit_or_log("acp-review-requested", payload);
    let reply = match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            return Err("review_request: frontend coordinator did not respond".to_string());
        }
        Err(_) => {
            state.hook_server.drop_bus_reply(&packet_id);
            return Err("review_request: frontend reply timed out".to_string());
        }
    };
    if reply
        .get("delivered")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        Ok(reply)
    } else {
        let reason = reply
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("delivery_failed");
        Err(format!("review_request failed: {reason}"))
    }
}

/// review_reply — forward a reviewer's findings to the frontend coordinator
/// for best-effort cleanup + delivery to the requester's inbox.
async fn review_reply(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    let packet_id = required_string(&arguments, "packet_id")?;
    let summary = arguments
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let findings = arguments
        .get("findings")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let request_id = format!("revreply-{}-{}", now_ms(), rand_suffix());
    let payload = json!({
        "packetId": packet_id,
        "fromLaneId": from_lane,
        "summary": summary,
        "findings": findings,
        "harnessId": harness_id,
        "requestId": request_id,
        "sentAt": now_ms(),
    });
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state
        .app_handle
        .emit_or_log("acp-review-reply-requested", payload);
    match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => {
            if value
                .get("delivered")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                Ok(value)
            } else {
                let reason = value
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("delivery_failed");
                Err(format!("review_reply failed: {reason}"))
            }
        }
        Ok(Err(_)) => Err("review_reply: frontend coordinator did not respond".to_string()),
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            Err("review_reply: frontend reply timed out".to_string())
        }
    }
}

/// collect_git_state — run a series of git commands in the lane's cwd and assemble
/// a JSON payload matching the frontend's ReviewGitState shape. Never panics; on
/// any failure returns `{ hasGitRepo: false, ... empty }`.
pub fn collect_git_state_public(cwd: Option<&str>) -> Value {
    collect_git_state(cwd)
}

/// Truncate a `&str` to at most `max_bytes` bytes without slicing a UTF-8
/// multibyte character. Returns the longest valid prefix.
fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn collect_git_state(cwd: Option<&str>) -> Value {
    use std::process::Command;

    const TOTAL_PATCH_CAP: usize = 40_960;
    const PER_FILE_HUNK_CAP: usize = 8_192;
    const UNTRACKED_HEAD_LINES: usize = 40;
    const UNTRACKED_HEAD_BYTES: usize = 4_096;

    let cwd_path = match cwd {
        Some(c) if !c.is_empty() => StdPath::new(c).to_path_buf(),
        _ => {
            return empty_git_state(String::new());
        }
    };

    let run = |args: &[&str]| -> Option<String> {
        let out = Command::new("git")
            .args(args)
            .current_dir(&cwd_path)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8(out.stdout).ok()
    };

    let repo_root = match run(&["rev-parse", "--show-toplevel"]) {
        Some(s) => s.trim().to_string(),
        None => return empty_git_state(cwd_path.to_string_lossy().to_string()),
    };

    // Use --no-pager + --no-ext-diff + --no-textconv to avoid user diff machinery
    // (external diff drivers, textconv filters, pagers) stalling the collector.
    let porcelain = run(&["status", "--porcelain=v1"]).unwrap_or_default();
    let head_sha = run(&["rev-parse", "HEAD"]).unwrap_or_default();
    let staged_raw = run(&[
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--cached",
        "--name-only",
    ])
    .unwrap_or_default();
    let unstaged_raw =
        run(&["--no-pager", "diff", "--no-ext-diff", "--name-only"]).unwrap_or_default();
    let numstat_raw =
        run(&["--no-pager", "diff", "--no-ext-diff", "HEAD", "--numstat"]).unwrap_or_default();

    let staged_set: std::collections::HashSet<String> = staged_raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let unstaged_set: std::collections::HashSet<String> = unstaged_raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let partial_staging = staged_set.intersection(&unstaged_set).next().is_some();

    let mut tracked_paths: Vec<(String, char)> = Vec::new();
    let mut untracked_paths: Vec<String> = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        let raw_path = line[3..].trim().to_string();
        // Rename entries come through as "OLD -> NEW"; we only diff against the new path.
        let path = if let Some(idx) = raw_path.find(" -> ") {
            raw_path[idx + 4..].to_string()
        } else {
            raw_path
        };
        if xy == "??" {
            untracked_paths.push(path);
        } else {
            let status = match xy.trim() {
                "M" | "MM" | "AM" | "RM" => 'M',
                "A" => 'A',
                "D" => 'D',
                "R" | "RD" => 'R',
                _ => 'M',
            };
            tracked_paths.push((path, status));
        }
    }

    // numstat: "added\tremoved\tpath"
    let mut numstat: std::collections::HashMap<String, (u64, u64)> =
        std::collections::HashMap::new();
    for line in numstat_raw.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let added = parts[0].parse::<u64>().unwrap_or(0);
        let removed = parts[1].parse::<u64>().unwrap_or(0);
        numstat.insert(parts[2].to_string(), (added, removed));
    }

    let mut diffstat: Vec<Value> = Vec::new();
    for (path, status) in &tracked_paths {
        let (added, removed) = numstat.get(path).cloned().unwrap_or((0, 0));
        diffstat.push(json!({
            "path": path,
            "status": status.to_string(),
            "added": added,
            "removed": removed,
        }));
    }
    for path in &untracked_paths {
        diffstat.push(json!({
            "path": path,
            "status": "?",
            "added": 0,
            "removed": 0,
        }));
    }

    let mut total_size: usize = 0;
    let mut hunks: Vec<Value> = Vec::new();
    // Sort tracked by best-effort churn (added+removed) desc — bigger churn first.
    let mut tracked_sorted = tracked_paths.clone();
    tracked_sorted.sort_by(|a, b| {
        let (aa, ar) = numstat.get(&a.0).cloned().unwrap_or((0, 0));
        let (ba, br) = numstat.get(&b.0).cloned().unwrap_or((0, 0));
        (ba + br).cmp(&(aa + ar))
    });
    for (path, status) in &tracked_sorted {
        if total_size >= TOTAL_PATCH_CAP {
            hunks.push(json!({
                "path": path,
                "status": status.to_string(),
                "hunk": "",
                "truncated": true,
            }));
            continue;
        }
        let raw = run(&[
            "--no-pager",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
            path,
        ])
        .unwrap_or_default();
        let (body, truncated) = if raw.len() > PER_FILE_HUNK_CAP {
            (safe_truncate(&raw, PER_FILE_HUNK_CAP).to_string(), true)
        } else {
            (raw, false)
        };
        total_size = total_size.saturating_add(body.len());
        hunks.push(json!({
            "path": path,
            "status": status.to_string(),
            "hunk": body,
            "truncated": truncated,
        }));
    }

    let mut untracked_excerpts: Vec<Value> = Vec::new();
    for path in &untracked_paths {
        if total_size >= TOTAL_PATCH_CAP {
            break;
        }
        let full = StdPath::new(&repo_root).join(path);
        let head = match std::fs::read(&full) {
            Ok(bytes) => {
                if bytes.iter().take(2048).any(|b| *b == 0) {
                    "<binary>".to_string()
                } else {
                    let slice = if bytes.len() > UNTRACKED_HEAD_BYTES {
                        &bytes[..UNTRACKED_HEAD_BYTES]
                    } else {
                        &bytes[..]
                    };
                    let text = String::from_utf8_lossy(slice);
                    text.lines()
                        .take(UNTRACKED_HEAD_LINES)
                        .collect::<Vec<_>>()
                        .join("\n")
                }
            }
            Err(_) => "<unreadable>".to_string(),
        };
        total_size = total_size.saturating_add(head.len());
        untracked_excerpts.push(json!({ "path": path, "head": head }));
    }

    let fingerprint_input = {
        let mut paths_meta: Vec<String> = Vec::new();
        for (path, _) in &tracked_paths {
            let full = StdPath::new(&repo_root).join(path);
            let meta = std::fs::metadata(&full).ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            paths_meta.push(format!("{}|{}|{}", path, size, mtime));
        }
        for path in &untracked_paths {
            let full = StdPath::new(&repo_root).join(path);
            let meta = std::fs::metadata(&full).ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            paths_meta.push(format!("{}|{}|{}", path, size, mtime));
        }
        paths_meta.sort();
        format!(
            "{}\n{}\n{}",
            head_sha.trim(),
            porcelain.trim(),
            paths_meta.join("\n")
        )
    };
    let mut hasher = Sha256::new();
    hasher.update(fingerprint_input.as_bytes());
    let fingerprint = format!("{:x}", hasher.finalize());

    json!({
        "hasGitRepo": true,
        "repoRoot": repo_root,
        "hasStagedChanges": !staged_set.is_empty(),
        "hasUnstagedChanges": !unstaged_set.is_empty(),
        "partialStagingDetected": partial_staging,
        "worktreeFingerprint": fingerprint,
        "diffstat": diffstat,
        "patchHunks": hunks,
        "untrackedExcerpts": untracked_excerpts,
    })
}

fn empty_git_state(cwd: String) -> Value {
    json!({
        "hasGitRepo": false,
        "repoRoot": cwd,
        "hasStagedChanges": false,
        "hasUnstagedChanges": false,
        "partialStagingDetected": false,
        "worktreeFingerprint": "<no-git>",
        "diffstat": [],
        "patchHunks": [],
        "untrackedExcerpts": [],
    })
}

fn rand_suffix() -> String {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos)
}

// ─── Directive management (spec 124) ───────────────────────────────────────
//
// `directive_list` / `directive_preview` are read-only and answered directly
// from `acp-harness.toml`. `directive_apply` blocks on a frontend round-trip:
// the frontend renders an approval card (for persistent or cross-lane changes)
// or auto-approves a same-lane assignment, then replies. Persistent
// `upsert`/`delete` are written by Rust only after the user approves;
// `assign` mutates frontend runtime lane state, so Rust forwards and relays
// the frontend's outcome verbatim.

/// Generous timeout for a directive round-trip. Unlike `peer_send` (a
/// programmatic frontend delivery), an `upsert`/`delete`/cross-lane `assign`
/// waits on a human approval decision, so the MCP call may hold for minutes.
const DIRECTIVE_REPLY_TIMEOUT: Duration = Duration::from_secs(300);

fn directive_list() -> Result<Value, String> {
    let cfg = crate::acp_harness_config::load()?;
    let directives: Vec<Value> = cfg
        .directives
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "title": d.title,
                "icon": d.icon,
                "description": d.description,
                "backend": d.backend,
                "task": d.task,
                "enabled": d.enabled,
            })
        })
        .collect();
    Ok(json!({ "directives": directives }))
}

fn directive_preview(arguments: Value) -> Result<Value, String> {
    let directive_id = required_string(&arguments, "directive_id")?;
    let directive_id = directive_id.trim();
    let cfg = crate::acp_harness_config::load()?;
    let directive = cfg
        .directives
        .iter()
        .find(|d| d.id == directive_id)
        .ok_or_else(|| format!("no directive '{directive_id}'"))?;
    let text = directive.system_prompt.clone();
    // No tokenizer in Rust; report a rough estimate (≈ chars / 4).
    let estimated_tokens = (text.chars().count() as u64).div_ceil(4);
    Ok(json!({
        "text": text,
        "estimated_tokens": estimated_tokens,
    }))
}

/// Emit a directive-apply request to the frontend and await its reply. The
/// frontend is the authority on runtime lane state and on whether the user
/// approved a persistent or cross-lane change.
async fn directive_round_trip(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    mut payload: Value,
) -> Result<Value, String> {
    let request_id = format!("dir-{}-{}", now_ms(), rand_suffix());
    if let Value::Object(ref mut map) = payload {
        map.insert("requestId".into(), json!(request_id));
        map.insert("harnessId".into(), json!(harness_id));
        map.insert("fromLaneId".into(), json!(from_lane));
        map.insert("sentAt".into(), json!(now_ms()));
    }
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state
        .app_handle
        .emit_or_log("acp-directive-apply-requested", payload);
    match tokio::time::timeout(DIRECTIVE_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("directive_apply: frontend coordinator did not respond".to_string()),
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            Err("directive_apply: frontend reply timed out".to_string())
        }
    }
}

fn reply_approved(reply: &Value) -> bool {
    reply
        .get("approved")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Delete a reusable directive from `acp-harness.toml`. Shared by
/// `directive_apply({ action: "delete" })` and the dedicated `directive_remove`
/// tool.
async fn directive_delete(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    directive_id: &str,
    reason: String,
) -> Result<Value, String> {
    use crate::acp_harness_config as dir;

    let directive_id = directive_id.trim().to_string();
    // Pre-check against the snapshot the user is about to be shown so we don't
    // surface an approval card for a missing directive.
    {
        let preview_cfg = dir::load()?;
        if !preview_cfg.directives.iter().any(|d| d.id == directive_id) {
            return Err(format!("no directive '{directive_id}'"));
        }
    }
    let reply = directive_round_trip(
        state,
        harness_id,
        from_lane,
        json!({
            "action": "delete",
            "directive_id": directive_id,
            "reason": reason,
        }),
    )
    .await?;
    if reply_approved(&reply) {
        // Reload after approval so concurrent edits during the wait are not
        // clobbered. `delete_directive` returns false if the directive was
        // already removed externally — that's fine; we still save the latest
        // config.
        let mut cfg = dir::load()?;
        let deleted = dir::delete_directive(&mut cfg, &directive_id);
        dir::save(&cfg)?;
        state.app_handle.emit_or_log(
            "acp-harness-directives-changed",
            json!({ "harnessId": harness_id }),
        );
        Ok(json!({ "action": "delete", "approval": "approved", "deleted": deleted }))
    } else {
        Ok(json!({ "action": "delete", "approval": "rejected", "deleted": false }))
    }
}

async fn directive_remove(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    let directive_id = required_string(&arguments, "directive_id")?;
    let reason = arguments
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    directive_delete(state, harness_id, from_lane, &directive_id, reason).await
}

async fn directive_apply(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    use crate::acp_harness_config as dir;

    let action = required_string(&arguments, "action")?;
    let reason = arguments
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    match action.as_str() {
        "upsert" => {
            let directive_val = arguments
                .get("directive")
                .cloned()
                .ok_or_else(|| "directive_apply: upsert requires `directive`".to_string())?;
            let directive: dir::HarnessDirective = serde_json::from_value(directive_val)
                .map_err(|e| format!("directive_apply: invalid directive: {e}"))?;
            // Pre-validate against the snapshot the user is about to be shown,
            // so the approval card only renders a valid proposal. The post-
            // approval re-validation below re-runs against the latest on-disk
            // state in case the file changed during the approval wait.
            let preview_cfg = dir::load()?;
            dir::validate_directive(&directive, &preview_cfg.directives)?;
            let is_update = preview_cfg
                .directives
                .iter()
                .any(|d| d.id == directive.id.trim());
            let prior = preview_cfg
                .directives
                .iter()
                .find(|d| d.id == directive.id.trim())
                .cloned();
            drop(preview_cfg);
            let reply = directive_round_trip(
                state,
                harness_id,
                from_lane,
                json!({
                    "action": "upsert",
                    "directive": directive,
                    "prior": prior,
                    "isUpdate": is_update,
                    "reason": reason,
                }),
            )
            .await?;
            if reply_approved(&reply) {
                // Approval can wait up to DIRECTIVE_REPLY_TIMEOUT (5 min); the
                // file may have been edited externally or by another approved
                // mutation in that window. Reload + re-validate against the
                // latest on-disk state so we never write back stale config.
                let mut cfg = dir::load()?;
                dir::validate_directive(&directive, &cfg.directives)?;
                let stored = dir::upsert_directive(&mut cfg, directive)?;
                dir::save(&cfg)?;
                state.app_handle.emit_or_log(
                    "acp-harness-directives-changed",
                    json!({ "harnessId": harness_id }),
                );
                Ok(json!({ "action": "upsert", "approval": "approved", "directive": stored }))
            } else {
                Ok(json!({ "action": "upsert", "approval": "rejected" }))
            }
        }
        "delete" => {
            let directive_id = required_string(&arguments, "directive_id")?;
            directive_delete(state, harness_id, from_lane, &directive_id, reason).await
        }
        "assign" => {
            // Frontend owns runtime lane state; it validates compatibility,
            // applies the binding, and reports the final outcome.
            let directive_id = arguments.get("directive_id").and_then(|v| v.as_str());
            let lane = arguments.get("lane").and_then(|v| v.as_str());
            let scope = arguments
                .get("scope")
                .and_then(|v| v.as_str())
                .unwrap_or("lane");
            let reply = directive_round_trip(
                state,
                harness_id,
                from_lane,
                json!({
                    "action": "assign",
                    "directive_id": directive_id,
                    "lane": lane,
                    "scope": scope,
                    "reason": reason,
                }),
            )
            .await?;
            Ok(reply)
        }
        other => Err(format!("directive_apply: unknown action '{other}'")),
    }
}

fn memory_set(
    hook_server: &Arc<HookServer>,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let summary = required_string(&arguments, "summary")?;
    let detail = required_string(&arguments, "detail")?;
    let summary_empty = summary.trim().is_empty();
    let detail_empty = detail.trim().is_empty();
    if summary_empty != detail_empty {
        return Err(
            "mixed_empty: summary and detail must both be non-empty, or both empty to clear"
                .to_string(),
        );
    }
    if !summary_empty {
        if summary.chars().count() > MEMORY_SUMMARY_MAX {
            return Err(format!(
                "summary is {} chars but must be \u{2264}{MEMORY_SUMMARY_MAX}: keep it to one short headline and move the body into 'detail' (allows {MEMORY_DETAIL_MAX} chars)",
                summary.chars().count()
            ));
        }
        if detail.chars().count() > MEMORY_DETAIL_MAX {
            return Err(format!("detail exceeds {MEMORY_DETAIL_MAX} characters"));
        }
    }

    let mut memories = hook_server
        .memories
        .lock()
        .map_err(|e| format!("memory lock poisoned: {e}"))?;
    let store = memories
        .get_mut(harness_id)
        .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;

    if summary_empty {
        store.lanes.remove(lane_label);
        drop(memories);
        hook_server.schedule_save(harness_id);
        return Ok(json!({ "lane": lane_label, "cleared": true }));
    }

    let doc = LaneMemoryDoc {
        summary: summary.trim().to_string(),
        detail: detail.trim().to_string(),
        updated_at: now_ms(),
    };
    store.lanes.insert(lane_label.to_string(), doc.clone());
    drop(memories);
    hook_server.schedule_save(harness_id);
    Ok(json!({
        "entry": {
            "lane": lane_label,
            "summary": doc.summary,
            "detail": doc.detail,
            "updatedAt": doc.updated_at,
        }
    }))
}

fn memory_get(
    hook_server: &Arc<HookServer>,
    harness_id: &str,
    arguments: Value,
) -> Result<Value, String> {
    let lane = required_string(&arguments, "lane")?;
    let memories = hook_server
        .memories
        .lock()
        .map_err(|e| format!("memory lock poisoned: {e}"))?;
    let store = memories
        .get(harness_id)
        .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
    match store.lanes.get(&lane) {
        Some(doc) => Ok(json!({
            "entry": {
                "lane": lane,
                "summary": doc.summary,
                "detail": doc.detail,
                "updatedAt": doc.updated_at,
            }
        })),
        None => Ok(json!({ "entry": null })),
    }
}

fn memory_list(hook_server: &Arc<HookServer>, harness_id: &str) -> Result<Value, String> {
    let memories = hook_server
        .memories
        .lock()
        .map_err(|e| format!("memory lock poisoned: {e}"))?;
    let store = memories
        .get(harness_id)
        .ok_or_else(|| format!("Unknown harness memory: {harness_id}"))?;
    let mut entries: Vec<Value> = store
        .lanes
        .iter()
        .map(|(lane, doc)| {
            json!({
                "lane": lane,
                "summary": doc.summary,
                "updatedAt": doc.updated_at,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.get("updatedAt")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .cmp(&a.get("updatedAt").and_then(|v| v.as_u64()).unwrap_or(0))
    });
    Ok(json!({ "entries": entries }))
}

fn bus_tool_descriptors() -> Value {
    json!([
        {
            "name": "memory_set",
            "description": "Overwrite your lane's single memory document. You have one document; this replaces its full contents (not append). Treat it as a living README other agents in this tab will read. 'summary' is a SHORT one-line headline; put all real content in 'detail'. Empty strings clear it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "maxLength": MEMORY_SUMMARY_MAX,
                        "description": "One short headline only (a single sentence). Do NOT put the body here — it is rejected past the length limit. Use 'detail' for everything substantial."
                    },
                    "detail": {
                        "type": "string",
                        "maxLength": MEMORY_DETAIL_MAX,
                        "description": "The full memory body. This is the long field — put all substantive content here."
                    }
                },
                "required": ["summary", "detail"]
            }
        },
        {
            "name": "memory_get",
            "description": "Read any lane's full memory document by lane label. Returns null if that lane has no memory. You can read any lane but only write your own.",
            "inputSchema": {
                "type": "object",
                "properties": { "lane": { "type": "string" } },
                "required": ["lane"]
            }
        },
        {
            "name": "memory_list",
            "description": "List all lanes in this tab and their memory summaries. Use this to discover what other agents are doing.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "peer_send",
            "description": "Send one message to another lane in this harness (peer review / consult). Async — recipient processes it on its next idle turn. At most one outstanding message per target lane: wait for their reply (or cancel via #cancel) before peer_send to the same target again; a second send returns peer_in_flight. After calling this tool, end your turn; the reply (if any) arrives as a new user message. The original initiator of a pair owns the lifecycle: only the initiator may set `done:true` (as a closing ack after the reply, or as a one-shot fire-and-forget on the very first send). When replying to a peer who messaged you first, omit `done` — the harness will silently coerce it to false. Use only when the user explicitly asks you to ask, consult, or peer with another lane — never proactively.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to_lane": { "type": "string", "description": "Target lane display name (e.g., 'Claude-2')." },
                    "message": { "type": "string" },
                    "done": { "type": "boolean", "default": false, "description": "Closes the conversation: recipient processes the message but will NOT reply. Reserved for the original initiator of the pair — either as a closing ack after receiving their reply, or as a one-shot fire-and-forget on the first send. Repliers must omit this field; the harness coerces replier-side `done:true` to false." }
                },
                "required": ["to_lane", "message"]
            }
        },
        {
            "name": "peer_list",
            "description": "List live sibling lanes in this harness. Returns `{ lanes, count }` where each lane has `laneId`, `displayName`, `backendId`, `status`, `modelName`, `inboxDepth`, and `activeDirective` (the lane-scope directive binding: `{ id, title, task, description, enabled }` or null). Use `activeDirective` to pick the lane whose role fits the job (e.g., a lane bound to a 'review' directive for review work). Address lanes by `displayName` when calling peer_send.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "review_request",
            "description": "Ask another lane to review your recent work. The harness assembles a packet (intent + git diff + commands + tool summary) from your lane state. The reviewer should reply with review_reply. After calling this tool, end your turn; the reply arrives as a transcript card. Use only when the user explicitly asks for a review — never proactively.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to_lane": { "type": "string", "description": "Reviewer lane display name (e.g., 'Codex-1')." },
                    "note": { "type": "string", "description": "Optional one-line hint to the reviewer (focus area, known concerns)." }
                },
                "required": ["to_lane"]
            }
        },
        {
            "name": "review_reply",
            "description": "Reply to a review packet. Use summary plus optional findings. For actionable findings, include file + line + severity (block|warn|nit) + concern; malformed findings are omitted instead of blocking delivery. Use empty or omitted findings for a clean review.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "packet_id": { "type": "string" },
                    "summary": { "type": "string" },
                    "findings": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": { "type": "string" },
                                "line": { "type": "integer", "minimum": 1 },
                                "severity": { "enum": ["block", "warn", "nit"] },
                                "concern": { "type": "string", "maxLength": 200 },
                                "suggested_check": { "type": "string" }
                            }
                        }
                    }
                },
                "required": ["packet_id"]
            }
        },
        {
            "name": "directive_list",
            "description": "List the reusable directives configured for this harness (id, title, icon, description, backend, task, enabled). A directive is a backend/task-scoped system-style prompt the user can assign to a lane. Read-only.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "directive_preview",
            "description": "Preview the exact prompt block a directive injects, plus a rough token estimate. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "directive_id": { "type": "string" },
                    "sample_user_text": { "type": "string", "description": "Optional; reserved for future contextual previews." }
                },
                "required": ["directive_id"]
            }
        },
        {
            "name": "directive_apply",
            "description": "Create/update (upsert), delete, or assign a directive. Use only when the user asks you to manage directives. `upsert` and `delete` mutate persistent config and require user approval; `assign` binds a directive to a lane at runtime (same-lane assignment is auto-approved, cross-lane requires approval). Returns the approval outcome. After calling for a change that needs approval, expect the result to reflect the user's decision. Prefer `directive_remove` when deleting a single directive.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "enum": ["upsert", "delete", "assign"] },
                    "directive": {
                        "type": "object",
                        "description": "Required for upsert. Fields: id (lowercase kebab-case), title, icon, description, backend (empty = all), task, system_prompt, enabled.",
                        "properties": {
                            "id": { "type": "string" },
                            "title": { "type": "string" },
                            "icon": { "type": "string" },
                            "description": { "type": "string" },
                            "backend": { "type": "string" },
                            "task": { "type": "string" },
                            "system_prompt": { "type": "string" },
                            "enabled": { "type": "boolean" }
                        }
                    },
                    "directive_id": { "type": "string", "description": "Required for delete and assign." },
                    "lane": { "type": "string", "description": "Assign target lane display name; omitted = your own lane." },
                    "scope": { "enum": ["next_turn", "lane"], "description": "Assign scope; omitted = lane." },
                    "reason": { "type": "string", "description": "Short reason shown to the user on the approval card." }
                },
                "required": ["action", "reason"]
            }
        },
        {
            "name": "directive_remove",
            "description": "Remove a reusable directive from acp-harness.toml. Use only when the user asks you to delete/remove a directive. Requires user approval before the config is changed. Returns `{ action: \"delete\", approval, deleted }`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "directive_id": { "type": "string" },
                    "reason": { "type": "string", "description": "Short reason shown to the user on the approval card." }
                },
                "required": ["directive_id", "reason"]
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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn get_persistence_path(project_dir: &str) -> Option<PathBuf> {
    let canonical = StdPath::new(project_dir)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(project_dir));
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let hash_prefix = &hash[..16];

    let config_dir = dirs::home_dir()?.join(".config").join("krypton");
    let memory_dir = config_dir.join("acp-harness-memory");
    if !memory_dir.exists() {
        let _ = std::fs::create_dir_all(&memory_dir);
    }
    Some(memory_dir.join(format!("{}.json", hash_prefix)))
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
                let error = format!("Failed to create tokio runtime for hook server: {e}");
                hook_server.set_error(error.clone());
                log::error!("{error}");
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
                    get(handle_harness_memory_mcp_sse).post(handle_harness_memory_mcp),
                )
                .with_state(shared);

            let addr = SocketAddr::from(([127, 0, 0, 1], configured_port));
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    let error = format!("Failed to bind hook server on {addr}: {e}");
                    hook_server.set_error(error.clone());
                    log::error!("{error}");
                    return;
                }
            };

            let actual_port = match listener.local_addr() {
                Ok(a) => a.port(),
                Err(e) => {
                    let error = format!("Failed to get local address for hook server: {e}");
                    hook_server.set_error(error.clone());
                    log::error!("{error}");
                    return;
                }
            };

            // Store the actual port
            if let Ok(mut p) = hook_server.port.lock() {
                *p = actual_port;
            }
            hook_server.clear_error();

            log::info!("Claude Code hook server listening on 127.0.0.1:{actual_port}");

            // Emit server-ready event so frontend knows the port
            app_handle.emit_or_log("claude-hook-server-ready", actual_port);

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
                    let error = format!("Hook server error: {e}");
                    hook_server.set_error(error.clone());
                    if let Ok(mut p) = hook_server.port.lock() {
                        *p = 0;
                    }
                    log::error!("{error}");
                });
        });
    });
}
