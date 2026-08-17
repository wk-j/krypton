// Krypton — Claude Code Hook Server
// Lightweight HTTP server that receives Claude Code hook events and forwards
// them as Tauri events to the frontend.

use axum::{
    body::Body,
    extract::{Path, Query, State as AxumState},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use comrak::{
    format_html,
    nodes::{AstNode, NodeValue},
    parse_document, Arena, Options,
};
use futures_util::{stream, StreamExt};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path as StdPath, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::sync::oneshot;

use crate::hurl::{
    cancel_run, confine_under_cwd, list_hurl_files, load_cached_run, load_sidebar_state,
    save_sidebar_state, start_run, HurlEvent, HurlRunArgs, HurlSidebarState, HurlState,
    HurlWebSession, HurlWebSessions,
};
use crate::review_excerpt::{rv_anchor, validate_doc_path, RvExcerpt, RvSkip, RvSrcCtx};
use crate::termctrl_monitor::{TermctrlMonitor, TermctrlSessionList};
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
    hurl: Arc<HurlState>,
    config: Arc<std::sync::RwLock<crate::config::KryptonConfig>>,
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
    /// Legacy triage-equipped labels, keyed by harness id → set of lane labels.
    /// Spec 130 makes attention tools default-on for harness-memory-capable
    /// lanes; this remains only for command/backward compatibility.
    triage_equipped: std::sync::Mutex<HashMap<String, HashSet<String>>>,
    /// Spec 133: HTML artifact registry, keyed by harness id. One store per
    /// harness tab; entries keyed by artifact id.
    artifacts: std::sync::Mutex<HashMap<String, HarnessArtifactStore>>,
    /// Monotonic artifact id sequence (resets per app run — artifact paths are
    /// swept on close and the random suffix keeps them unguessable).
    next_artifact_seq: AtomicU64,
    /// Spec 211: Review Board registry, keyed by harness id. Only the CARD lives
    /// here; the bundle on disk outlives the entry, the lane, and the app, and is
    /// rediscovered by walking `.krypton/reviews/` (no session state).
    reviews: std::sync::Mutex<HashMap<String, HarnessReviewStore>>,
    /// Monotonic review id sequence (per app run — the durable id is the slug).
    next_review_seq: AtomicU64,
    /// Spec 149: per-artifact feedback tokens, keyed by the unguessable token
    /// baked into the served artifact URL. The token is the sole capability for
    /// `GET /artifact/<token>` + `POST /artifact/feedback/<token>`. `revoked`
    /// is set (not removed) on lane close/`#new` so a later request reports
    /// `410 revoked` rather than an ambiguous `404`.
    feedback_tokens: std::sync::Mutex<HashMap<String, FeedbackToken>>,
    /// Spec 168: harness-wide telemetry snapshots for the lane-monitor dashboard.
    /// Keyed by harness id; value is `(version, opaque snapshot JSON)`. Last-writer-wins
    /// with a monotonic version guard in `store_telemetry`.
    telemetry: std::sync::Mutex<HashMap<String, (u64, Value)>>,
    /// Spec 185: built-in `#` command manifest for the `/commands` reference
    /// page. Compile-time frontend data, identical across harnesses — a single
    /// global slot, last write wins (harmless by construction).
    command_manifest: std::sync::Mutex<Option<Value>>,
    /// Spec 198: read-only Terminal Control adapter and process-lifetime page token.
    termctrl_monitor: TermctrlMonitor,
    /// Spec 227: capability tokens bound to a cwd for the Hurl web client.
    hurl_sessions: Arc<HurlWebSessions>,
}

/// Spec 149: registry record for an artifact feedback token. Maps the
/// browser-held capability back to the owning harness/lane/artifact so the
/// HTTP handlers can resolve the file + route the bus round-trip.
#[derive(Debug, Clone)]
struct FeedbackToken {
    harness_id: String,
    /// Owning lane label at issue time. The frontend resolves label → live lane;
    /// kept here so the emitted event carries it (not a dynamic display lookup).
    lane_label: String,
    artifact_id: String,
    /// Forward-only: a revoked token never un-revokes (lane close/`#new`).
    revoked: bool,
}

/// Outcome of resolving a feedback token at request time (spec 149).
enum FeedbackLookup {
    /// No such token → `404` (no existence leak).
    Unknown,
    /// Token revoked or its artifact swept → `410`.
    Revoked,
    Found(FeedbackServeInfo),
}

/// The data the artifact HTTP handlers need once a token resolves.
struct FeedbackServeInfo {
    harness_id: String,
    lane_label: String,
    artifact_id: String,
    title: String,
    path: PathBuf,
    /// The harness scratch root, for re-running `validate_artifact_file`.
    root: PathBuf,
    registered: bool,
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
            triage_equipped: std::sync::Mutex::new(HashMap::new()),
            artifacts: std::sync::Mutex::new(HashMap::new()),
            next_artifact_seq: AtomicU64::new(1),
            reviews: std::sync::Mutex::new(HashMap::new()),
            next_review_seq: AtomicU64::new(1),
            feedback_tokens: std::sync::Mutex::new(HashMap::new()),
            telemetry: std::sync::Mutex::new(HashMap::new()),
            command_manifest: std::sync::Mutex::new(None),
            termctrl_monitor: TermctrlMonitor::new(),
            hurl_sessions: Arc::new(HurlWebSessions::default()),
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
            triage_equipped: std::sync::Mutex::new(HashMap::new()),
            artifacts: std::sync::Mutex::new(HashMap::new()),
            next_artifact_seq: AtomicU64::new(1),
            reviews: std::sync::Mutex::new(HashMap::new()),
            next_review_seq: AtomicU64::new(1),
            feedback_tokens: std::sync::Mutex::new(HashMap::new()),
            telemetry: std::sync::Mutex::new(HashMap::new()),
            command_manifest: std::sync::Mutex::new(None),
            termctrl_monitor: TermctrlMonitor::new(),
            hurl_sessions: Arc::new(HurlWebSessions::default()),
        }
    }

    /// Legacy setter for whether a lane is triage-equipped.
    pub fn set_lane_triage_equipped(&self, harness_id: &str, lane_label: &str, equipped: bool) {
        let mut map = self
            .triage_equipped
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let lanes = map.entry(harness_id.to_string()).or_default();
        if equipped {
            lanes.insert(lane_label.to_string());
        } else {
            lanes.remove(lane_label);
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

    pub fn termctrl_monitor_url(&self) -> Result<String, String> {
        self.termctrl_monitor.url(self.get_port())
    }

    pub fn hurl_web_url(&self, cwd: &str) -> Result<String, String> {
        let port = self.get_port();
        if port == 0 {
            return Err("Krypton hook server is not running".to_string());
        }
        let session = self.hurl_sessions.issue(cwd)?;
        Ok(format!("http://127.0.0.1:{port}/hurl/{}", session.token))
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

        let artifact_project_dir = project_dir.clone();
        let review_project_dir = project_dir.clone();
        let store = HarnessMemoryStore {
            lanes,
            persistence_path,
            project_dir,
            save_pending: Arc::new(AtomicBool::new(false)),
        };

        {
            let mut memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
            memories.insert(harness_id.clone(), store);
        }

        // Spec 133: register the in-memory artifact store. On-disk files persist
        // as append-only history across harness close and app restarts.
        self.init_harness_artifacts(&harness_id, artifact_project_dir);
        // Spec 211: register the review card store. Bundles on disk are durable
        // records rediscovered by a directory walk, so nothing is rehydrated here.
        self.init_harness_reviews(&harness_id, review_project_dir);
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

    /// spec 178: persist a harness's issue↔lane bindings to disk, atomically
    /// (tmp-file + rename), in a `*.issue-bindings.json` sibling of the handoff
    /// memory file. The `bindings` value is stored verbatim — the frontend owns
    /// its shape. No-op (Ok) when the harness has no project dir / persistence
    /// path. The frontend re-persists on every binding mutation.
    pub fn save_issue_bindings(&self, harness_id: &str, bindings: Value) -> Result<(), String> {
        let project_dir = {
            let memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
            match memories.get(harness_id) {
                Some(store) => store.project_dir.clone(),
                None => return Ok(()),
            }
        };
        let project_dir = match project_dir {
            Some(dir) => dir,
            None => return Ok(()),
        };
        let path = match get_issue_bindings_path(&project_dir) {
            Some(path) => path,
            None => return Ok(()),
        };

        let persisted = json!({
            "version": 1,
            "harnessId": harness_id,
            "savedAt": now_ms(),
            "bindings": bindings,
        });
        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|e| format!("failed to serialize issue bindings: {e}"))?;
        let tmp_path = path.with_extension("issue-bindings.json.tmp");
        std::fs::write(&tmp_path, json)
            .map_err(|e| format!("failed to write issue-bindings tmp file: {e}"))?;
        std::fs::rename(&tmp_path, &path)
            .map_err(|e| format!("failed to rename issue-bindings file: {e}"))?;
        Ok(())
    }

    /// spec 178: load a harness's persisted issue bindings from disk. Returns the
    /// stored `bindings` array verbatim, or an empty vec if the file is missing or
    /// unparseable (a parse failure is logged, not surfaced, mirroring the memory
    /// loader).
    pub fn load_issue_bindings(&self, harness_id: &str) -> Result<Vec<Value>, String> {
        let project_dir = {
            let memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
            match memories.get(harness_id) {
                Some(store) => store.project_dir.clone(),
                None => return Ok(vec![]),
            }
        };
        let project_dir = match project_dir {
            Some(dir) => dir,
            None => return Ok(vec![]),
        };
        let path = match get_issue_bindings_path(&project_dir) {
            Some(path) => path,
            None => return Ok(vec![]),
        };
        if !path.exists() {
            return Ok(vec![]);
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(e) => {
                log::warn!("Failed to read issue bindings at {}: {e}", path.display());
                return Ok(vec![]);
            }
        };
        match serde_json::from_str::<Value>(&content) {
            Ok(parsed) => Ok(parsed
                .get("bindings")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()),
            Err(e) => {
                log::warn!("Failed to parse issue bindings at {}: {e}", path.display());
                Ok(vec![])
            }
        }
    }

    /// spec 194: persist the harness's shared working ticket, atomically
    /// (tmp-file + rename), in a `*.active-ticket.json` sibling of the handoff
    /// memory file. A `null` ticket clears it. Stored verbatim — the frontend
    /// owns its shape. No-op (Ok) when the harness has no persistence path.
    pub fn save_active_ticket(&self, harness_id: &str, ticket: Value) -> Result<(), String> {
        let project_dir = {
            let memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
            match memories.get(harness_id) {
                Some(store) => store.project_dir.clone(),
                None => return Ok(()),
            }
        };
        let project_dir = match project_dir {
            Some(dir) => dir,
            None => return Ok(()),
        };
        let path = match get_active_ticket_path(&project_dir) {
            Some(path) => path,
            None => return Ok(()),
        };

        let persisted = json!({
            "version": 1,
            "harnessId": harness_id,
            "savedAt": now_ms(),
            "ticket": ticket,
        });
        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|e| format!("failed to serialize active ticket: {e}"))?;
        let tmp_path = path.with_extension("active-ticket.json.tmp");
        std::fs::write(&tmp_path, json)
            .map_err(|e| format!("failed to write active-ticket tmp file: {e}"))?;
        std::fs::rename(&tmp_path, &path)
            .map_err(|e| format!("failed to rename active-ticket file: {e}"))?;
        Ok(())
    }

    /// spec 194: load the harness's persisted working ticket. Returns the stored
    /// `ticket` value verbatim, or `Null` when the file is missing/unparseable
    /// (a parse failure is logged, not surfaced, mirroring the bindings loader).
    pub fn load_active_ticket(&self, harness_id: &str) -> Result<Value, String> {
        let project_dir = {
            let memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
            match memories.get(harness_id) {
                Some(store) => store.project_dir.clone(),
                None => return Ok(Value::Null),
            }
        };
        let project_dir = match project_dir {
            Some(dir) => dir,
            None => return Ok(Value::Null),
        };
        let path = match get_active_ticket_path(&project_dir) {
            Some(path) => path,
            None => return Ok(Value::Null),
        };
        if !path.exists() {
            return Ok(Value::Null);
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(e) => {
                log::warn!("Failed to read active ticket at {}: {e}", path.display());
                return Ok(Value::Null);
            }
        };
        match serde_json::from_str::<Value>(&content) {
            Ok(parsed) => Ok(parsed.get("ticket").cloned().unwrap_or(Value::Null)),
            Err(e) => {
                log::warn!("Failed to parse active ticket at {}: {e}", path.display());
                Ok(Value::Null)
            }
        }
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
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
        Ok(entries)
    }

    pub fn dispose_harness_memory(&self, harness_id: &str) {
        // Spec 133: drop this harness from the in-memory artifact registry on
        // normal close. On-disk artifact files are preserved (append-only history).
        self.dispose_harness_artifacts(harness_id);
        // Spec 211: same for reviews — the card registry is session state, the
        // bundle on disk is the record and is never swept.
        self.reviews
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(harness_id);
        let mut memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
        memories.remove(harness_id);
        let mut stats = self.mcp_stats.lock().unwrap_or_else(|e| e.into_inner());
        stats.remove(harness_id);
        // spec 128: drop the harness's triage-equip set too (no stale state in a
        // long-running app, even though harness ids are monotonic).
        let mut triage = self
            .triage_equipped
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        triage.remove(harness_id);
    }

    // ─── Artifact store (spec 133) ──────────────────────────────────────────

    /// Register an in-memory artifact store for a harness and **rehydrate it from
    /// disk** (spec 173): every `*/<lane>/<id>.html` under the project's
    /// `.krypton/artifacts/` is rebuilt into an entry — regardless of which
    /// `harnessId` subdir it physically lives under — and **re-homed under this
    /// live harness** so its feedback token routes to a currently-live lane
    /// exactly like a same-session artifact. The on-disk files are the source of
    /// truth (append-only history); this rebuilds the gallery + feedback registry
    /// that an app restart would otherwise leave empty.
    fn init_harness_artifacts(&self, harness_id: &str, project_dir: Option<String>) {
        let (entries, tokens, max_seq) = project_dir
            .as_deref()
            .and_then(artifacts_root)
            .map(|root| rehydrate_artifacts_from_disk(harness_id, &root))
            .unwrap_or_default();

        {
            let mut artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
            artifacts.insert(
                harness_id.to_string(),
                HarnessArtifactStore {
                    project_dir,
                    entries,
                },
            );
        }
        if !tokens.is_empty() {
            let mut map = self
                .feedback_tokens
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            for (token, record) in tokens {
                map.insert(token, record);
            }
        }
        // Keep freshly-allocated ids past the rehydrated seqs. The random suffix
        // already guarantees unique full ids across runs; this just keeps the
        // numbering monotone within this session.
        if max_seq > 0 {
            let cur = self.next_artifact_seq.load(Ordering::Relaxed);
            if max_seq >= cur {
                self.next_artifact_seq.store(max_seq + 1, Ordering::Relaxed);
            }
        }
    }

    /// spec 173: every artifact entry for one harness, shaped like the
    /// `acp-harness-artifact` `registered` event, so the frontend can replay
    /// rehydrated entries into its mirror after attaching its listener. Events
    /// emitted during `register_harness` (when rehydration runs) are lost — the
    /// frontend listener isn't attached yet — so it pulls instead. Sorted by lane
    /// then id for a stable replay order.
    pub fn list_harness_artifacts(&self, harness_id: &str) -> Vec<Value> {
        let artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = artifacts.get(harness_id) else {
            return Vec::new();
        };
        let mut rows: Vec<&ArtifactEntry> = store.entries.values().collect();
        rows.sort_by(|a, b| {
            a.lane_label
                .cmp(&b.lane_label)
                .then_with(|| a.id.cmp(&b.id))
        });
        rows.into_iter()
            .map(|e| {
                let state = if e.state == ArtifactState::RegisteredLive {
                    "registered"
                } else {
                    "pending"
                };
                json!({
                    "harnessId": harness_id,
                    "laneLabel": e.lane_label,
                    "id": e.id,
                    "path": e.path.to_string_lossy(),
                    "tail": e.tail,
                    "title": e.title,
                    "size": e.size,
                    "hash": e.hash,
                    "state": state,
                    "registered": true,
                    "feedbackToken": e.feedback_token,
                })
            })
            .collect()
    }

    // ─── Review store (spec 211) ────────────────────────────────────────────

    /// Register an in-memory review store for a harness. Deliberately does NOT
    /// rehydrate cards from disk the way artifacts do (spec 173): a review is
    /// reopened through the picker, which walks `.krypton/reviews/` directly, so
    /// replaying every past bundle as a transcript card would be noise.
    fn init_harness_reviews(&self, harness_id: &str, project_dir: Option<String>) {
        let mut reviews = self.reviews.lock().unwrap_or_else(|e| e.into_inner());
        reviews.insert(
            harness_id.to_string(),
            HarnessReviewStore {
                project_dir,
                entries: HashMap::new(),
            },
        );
    }

    /// `review_new` — allocate an id, create a durable bundle directory keyed by
    /// date + title slug, seed an empty `review.md`, and record a `pending` entry.
    /// Returns `{ id, slug, dir, path, tail }`. Fails closed if the directory or
    /// its `.gitignore` cannot be created — a path we cannot keep out of the
    /// user's git status must never be handed out.
    fn review_new(
        &self,
        harness_id: &str,
        lane_label: &str,
        title: &str,
        subject: Option<&str>,
    ) -> Result<Value, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("title must be non-empty".to_string());
        }
        if title.chars().count() > REVIEW_TITLE_MAX {
            return Err(format!(
                "title is {} chars but must be \u{2264}{REVIEW_TITLE_MAX}",
                title.chars().count()
            ));
        }
        let subject = subject.map(str::trim).filter(|s| !s.is_empty());
        if let Some(s) = subject {
            if s.chars().count() > REVIEW_SUBJECT_MAX {
                return Err(format!(
                    "subject is {} chars but must be \u{2264}{REVIEW_SUBJECT_MAX}",
                    s.chars().count()
                ));
            }
        }

        let seq = self.next_review_seq.fetch_add(1, Ordering::Relaxed);
        let review_id = format!("rev-{seq}-{}", rand_suffix());

        let mut reviews = self.reviews.lock().unwrap_or_else(|e| e.into_inner());
        let store = reviews
            .get_mut(harness_id)
            .ok_or_else(|| format!("Unknown harness: {harness_id}"))?;
        let project_dir = store
            .project_dir
            .clone()
            .ok_or_else(|| "no project directory for reviews in this harness".to_string())?;

        let pending_for_lane = store
            .entries
            .values()
            .filter(|e| e.lane_label == lane_label && e.state == ReviewState::Pending)
            .count();
        if pending_for_lane >= REVIEW_PENDING_PER_LANE_MAX {
            return Err(format!(
                "pending_cap: at most {REVIEW_PENDING_PER_LANE_MAX} outstanding pending reviews per lane — register or cancel one first"
            ));
        }
        if store.entries.len() >= REVIEW_PER_SESSION_MAX {
            return Err(format!(
                "session_cap: at most {REVIEW_PER_SESSION_MAX} reviews per harness tab"
            ));
        }

        let root = reviews_root(&project_dir)
            .ok_or_else(|| "could not resolve review root".to_string())?;
        ensure_reviews_gitignore(&root)
            .map_err(|e| format!("could not prepare review root: {e}"))?;

        let (slug, dir) = allocate_review_dir(&root, title)
            .map_err(|e| format!("could not create review bundle dir: {e}"))?;
        let path = dir.join("review.md");
        let tail = format!(".krypton/reviews/{slug}/");

        // Seed the frontmatter stamp so the bundle is self-describing on disk
        // from the moment it exists — a lane that dies before writing anything
        // still leaves a readable, attributable directory.
        let stamp = format!(
            "---\ntitle: {}\nlane: {}\nsubject: {}\ncreated: {}\n---\n\n",
            yaml_scalar(title),
            yaml_scalar(lane_label),
            yaml_scalar(subject.unwrap_or("")),
            yaml_scalar(&now_rfc3339()),
        );
        write_file_atomic(&path, &stamp).map_err(|e| format!("could not seed review.md: {e}"))?;

        store.entries.insert(
            review_id.clone(),
            ReviewEntry {
                id: review_id.clone(),
                lane_label: lane_label.to_string(),
                title: title.to_string(),
                slug: slug.clone(),
                dir: dir.clone(),
                path: path.clone(),
                tail: tail.clone(),
                state: ReviewState::Pending,
                blocks: 0,
                steps: 0,
                findings: 0,
                decisions: 0,
            },
        );
        drop(reviews);

        Ok(json!({
            "id": review_id,
            "slug": slug,
            "dir": dir.to_string_lossy(),
            "path": path.to_string_lossy(),
            "tail": tail,
            "title": title,
            "state": "pending",
        }))
    }

    /// `review_register` — validate `review.md`, count its blocks, and transition
    /// `pending → registered_live`. A repeat call on a live id is an idempotent
    /// refresh (re-reads and re-counts), so a lane that keeps iterating can keep
    /// the card's counts honest.
    fn review_register(
        &self,
        harness_id: &str,
        lane_label: &str,
        id: &str,
    ) -> Result<Value, String> {
        let mut reviews = self.reviews.lock().unwrap_or_else(|e| e.into_inner());
        let store = reviews
            .get_mut(harness_id)
            .ok_or_else(|| format!("Unknown harness: {harness_id}"))?;
        let project_dir = store.project_dir.clone();
        let entry = store
            .entries
            .get_mut(id)
            // No path detail leaked for an id that is not the caller's.
            .filter(|e| e.lane_label == lane_label)
            .ok_or_else(|| "not_found: no such review id for this lane".to_string())?;

        let root = project_dir
            .as_deref()
            .and_then(reviews_root)
            .ok_or_else(|| "could not resolve review root".to_string())?;
        let source = validate_review_file(&root, &entry.path, &entry.slug, REVIEW_FILE_BYTES_MAX)?;
        let counts = count_review_blocks(&source);
        if counts.blocks == 0 {
            return Err(
                "empty: review.md has no content yet — write the document before registering"
                    .to_string(),
            );
        }

        let was_pending = entry.state == ReviewState::Pending;
        entry.state = ReviewState::RegisteredLive;
        entry.blocks = counts.blocks;
        entry.steps = counts.steps;
        entry.findings = counts.findings;
        entry.decisions = counts.decisions;
        let snapshot = entry.clone();
        drop(reviews);

        Ok(json!({
            "ok": true,
            "id": snapshot.id,
            "slug": snapshot.slug,
            "dir": snapshot.dir.to_string_lossy(),
            "path": snapshot.path.to_string_lossy(),
            "tail": snapshot.tail,
            "title": snapshot.title,
            "blocks": counts.blocks,
            "steps": counts.steps,
            "findings": counts.findings,
            "decisions": counts.decisions,
            // First register raises the card; a repeat is just a refresh.
            "registered": was_pending,
        }))
    }

    /// `review_cancel` — `pending` only: drop the registry entry, and remove the
    /// bundle directory when it holds nothing but the seeded stamp. A bundle the
    /// lane actually wrote into is left on disk; abandoning a draft must not
    /// delete work, and the `/reviews` index labels it `never composed`.
    fn review_cancel(&self, harness_id: &str, lane_label: &str, id: &str) -> Result<Value, String> {
        let mut reviews = self.reviews.lock().unwrap_or_else(|e| e.into_inner());
        let store = reviews
            .get_mut(harness_id)
            .ok_or_else(|| format!("Unknown harness: {harness_id}"))?;
        let entry = store
            .entries
            .get(id)
            .filter(|e| e.lane_label == lane_label)
            .ok_or_else(|| "not_found: no such review id for this lane".to_string())?;
        if entry.state == ReviewState::RegisteredLive {
            return Err(
                "already_registered: cannot cancel a registered review (the bundle is a record)"
                    .to_string(),
            );
        }
        let dir = entry.dir.clone();
        let path = entry.path.clone();
        store.entries.remove(id);
        drop(reviews);

        // Only reclaim a bundle that is still just the seeded stamp.
        let untouched = std::fs::read_to_string(&path)
            .map(|s| count_review_blocks(&s).blocks == 0)
            .unwrap_or(false);
        if untouched && bundle_has_only(&dir, "review.md") {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(&dir);
        }
        Ok(json!({ "ok": true, "id": id }))
    }

    /// Cancel every outstanding `pending` review for a lane (turn-end / lane
    /// teardown). Registered reviews are untouched — the card and the bundle both
    /// survive, because a review result is not a throwaway view.
    pub fn cancel_pending_reviews(&self, harness_id: &str, lane_label: &str) -> Vec<String> {
        let pending: Vec<String> = {
            let reviews = self.reviews.lock().unwrap_or_else(|e| e.into_inner());
            let Some(store) = reviews.get(harness_id) else {
                return Vec::new();
            };
            store
                .entries
                .values()
                .filter(|e| e.lane_label == lane_label && e.state == ReviewState::Pending)
                .map(|e| e.id.clone())
                .collect()
        };
        // Reuse the single-cancel path so the reclaim rule lives in one place.
        for id in &pending {
            let _ = self.review_cancel(harness_id, lane_label, id);
        }
        pending
    }

    /// Re-read `review.md` after an observed write and refresh the card's counts.
    pub fn refresh_review(
        &self,
        harness_id: &str,
        lane_label: &str,
        id: &str,
    ) -> Result<Value, String> {
        // Same validation as register's idempotent refresh path.
        self.review_register(harness_id, lane_label, id)
    }

    /// Every review bundle under a harness's project dir, newest first — a
    /// DIRECTORY WALK, not a registry read, which is exactly why a bundle from a
    /// previous session (or a previous app run) is still findable.
    pub fn list_review_bundles(&self, harness_id: &str) -> Vec<Value> {
        let project_dir = {
            let reviews = self.reviews.lock().unwrap_or_else(|e| e.into_inner());
            reviews.get(harness_id).and_then(|s| s.project_dir.clone())
        };
        let Some(project_dir) = project_dir else {
            return Vec::new();
        };
        discover_review_bundles(&project_dir)
            .into_iter()
            .map(|b| b.to_json())
            .collect()
    }

    /// Resolve a caller-supplied bundle directory to a canonical path that is
    /// genuinely a bundle under SOME live harness's `.krypton/reviews/`. This is
    /// the only gate on the two bundle-file commands, so it is deliberately strict:
    /// canonicalize (which also resolves symlinks), then require the parent to be
    /// a canonical review root. A path that merely looks right is rejected.
    fn resolve_review_dir(&self, dir: &str) -> Result<PathBuf, String> {
        if dir.is_empty() {
            return Err("path_invalid: empty bundle directory".to_string());
        }
        let canonical = StdPath::new(dir)
            .canonicalize()
            .map_err(|e| format!("not_found: bundle directory unavailable ({e})"))?;
        if !canonical.is_dir() {
            return Err("path_invalid: not a directory".to_string());
        }
        let roots: Vec<PathBuf> = {
            let reviews = self.reviews.lock().unwrap_or_else(|e| e.into_inner());
            reviews
                .values()
                .filter_map(|store| store.project_dir.as_deref())
                .filter_map(reviews_root)
                .filter_map(|root| root.canonicalize().ok())
                .collect()
        };
        // The bundle is exactly one level below a review root — never deeper, so
        // `assets/` (or anything else nested) can't be targeted as a bundle.
        let parent = canonical
            .parent()
            .ok_or_else(|| "path_invalid: bundle has no parent".to_string())?;
        if !roots.iter().any(|root| root == parent) {
            return Err("path_invalid: not a review bundle directory".to_string());
        }
        Ok(canonical)
    }

    /// spec 211: read one bundle's raw `review.md` + `response.md`. A missing
    /// `review.md` is NOT an error — a lane may have died before writing it, and
    /// the Board shows an empty state rather than failing to open.
    pub fn read_review_bundle(&self, dir: &str) -> Result<Value, String> {
        let canonical = self.resolve_review_dir(dir)?;
        let slug = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let review = std::fs::read_to_string(canonical.join("review.md")).unwrap_or_default();
        if review.len() as u64 > REVIEW_FILE_BYTES_MAX {
            return Err(format!(
                "size_cap: review.md is {} bytes but the limit is {REVIEW_FILE_BYTES_MAX}",
                review.len()
            ));
        }
        let response = std::fs::read_to_string(canonical.join("response.md")).ok();
        Ok(json!({
            "slug": slug,
            "dir": canonical.to_string_lossy(),
            "review": review,
            "response": response,
        }))
    }

    /// spec 211: move a bundle's `response.md` aside to `response.md.bak`. Called
    /// when the Board finds a frontmatter it cannot read at all: a bad hand-edit
    /// must never block the review, and must never be silently lost either. A
    /// missing file is a no-op, not an error.
    pub fn backup_review_response(&self, dir: &str) -> Result<Value, String> {
        let canonical = self.resolve_review_dir(dir)?;
        let path = canonical.join("response.md");
        if !path.exists() {
            return Ok(json!({ "ok": true, "backed_up": false }));
        }
        let backup = canonical.join("response.md.bak");
        std::fs::rename(&path, &backup).map_err(|e| format!("backup failed: {e}"))?;
        Ok(json!({ "ok": true, "backed_up": true, "path": backup.to_string_lossy() }))
    }

    /// spec 211: atomically write a bundle's `response.md`. Returns the resolved
    /// path so the caller can report it; the write is temp-file + rename, so an
    /// interrupted save never leaves a half-written response.
    pub fn write_review_response(&self, dir: &str, contents: &str) -> Result<Value, String> {
        let canonical = self.resolve_review_dir(dir)?;
        if contents.len() as u64 > REVIEW_FILE_BYTES_MAX {
            return Err(format!(
                "size_cap: response is {} bytes but the limit is {REVIEW_FILE_BYTES_MAX}",
                contents.len()
            ));
        }
        let path = canonical.join("response.md");
        write_file_atomic(&path, contents).map_err(|e| format!("write failed: {e}"))?;
        Ok(json!({ "ok": true, "path": path.to_string_lossy() }))
    }

    /// Drop a harness from the in-memory artifact registry. On-disk files are
    /// preserved (append-only history); feedback tokens and telemetry are cleared.
    fn dispose_harness_artifacts(&self, harness_id: &str) {
        {
            let mut artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
            artifacts.remove(harness_id);
        }
        // spec 149: delisted — drop every feedback token for this harness so the
        // map does not accumulate dead tokens across a session.
        self.feedback_tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, t| t.harness_id != harness_id);
        self.telemetry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(harness_id);
    }

    /// Spec 168: cache a harness telemetry snapshot. Drops stale publishes when
    /// `version` is less than or equal to the cached version (last-writer-wins).
    /// Returns `true` when stored, `false` when dropped as stale.
    pub fn store_telemetry(&self, harness_id: &str, version: u64, snapshot: Value) -> bool {
        let mut map = self.telemetry.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_version, _)) = map.get(harness_id) {
            if version <= *cached_version {
                return false;
            }
        }
        map.insert(harness_id.to_string(), (version, snapshot));
        true
    }

    /// Spec 168: read the cached telemetry snapshot for a harness, if any.
    pub fn telemetry_for_harness(&self, harness_id: &str) -> Option<(u64, Value)> {
        self.telemetry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(harness_id)
            .cloned()
    }

    /// Spec 168 pivot: fixed `/telemetry` exposes every live harness snapshot
    /// currently cached by the frontend publisher. Snapshots stay opaque to Rust.
    pub fn all_telemetry_snapshots(&self) -> Vec<Value> {
        let mut entries: Vec<(String, Value)> = self
            .telemetry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(harness_id, (_, snapshot))| (harness_id.clone(), snapshot.clone()))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries.into_iter().map(|(_, snapshot)| snapshot).collect()
    }

    /// Spec 185: cache the built-in `#` command manifest for `/commands.json`.
    /// Compile-time frontend data — no version guard needed (every harness of a
    /// given build pushes identical content).
    pub fn store_command_manifest(&self, manifest: Value) {
        *self
            .command_manifest
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(manifest);
    }

    /// Spec 185: read the cached command manifest, if any harness pushed one.
    pub fn command_manifest(&self) -> Option<Value> {
        self.command_manifest
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Read-only artifact gallery listing: every live harness store and its
    /// pending + registered artifacts. Within each harness, artifacts are ordered
    /// latest-creation-first for `/artifacts` (newest at the top of the gallery).
    /// The `art-<seq>-<hex>` seq is monotonic per session, so a descending seq sort
    /// is the creation order; ids aren't zero-padded, so we compare the parsed seq
    /// rather than the raw string (which would put `art-10` before `art-2`).
    pub fn list_all_artifacts_for_gallery(&self) -> Vec<Value> {
        let artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        let mut harness_ids: Vec<&String> = artifacts.keys().collect();
        harness_ids.sort();
        harness_ids
            .into_iter()
            .map(|harness_id| {
                let store = &artifacts[harness_id];
                let mut entries: Vec<&ArtifactEntry> = store.entries.values().collect();
                entries.sort_by(|a, b| {
                    let sa = parse_artifact_seq(&a.id).unwrap_or(0);
                    let sb = parse_artifact_seq(&b.id).unwrap_or(0);
                    sb.cmp(&sa).then_with(|| b.id.cmp(&a.id))
                });
                let artifact_rows: Vec<Value> = entries
                    .iter()
                    .map(|entry| {
                        let state = if entry.state == ArtifactState::RegisteredLive {
                            "live"
                        } else {
                            "pending"
                        };
                        json!({
                            "id": entry.id,
                            "laneLabel": entry.lane_label,
                            "title": entry.title,
                            "state": state,
                            "size": entry.size,
                            "hash": entry.hash,
                            "tail": entry.tail,
                            "token": entry.feedback_token,
                        })
                    })
                    .collect();
                json!({
                    "harnessId": harness_id,
                    "artifacts": artifact_rows,
                })
            })
            .collect()
    }

    fn docs_project_dirs(&self) -> Vec<(String, String)> {
        let artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries: Vec<(String, String)> = artifacts
            .iter()
            .filter_map(|(harness_id, store)| {
                store
                    .project_dir
                    .as_ref()
                    .map(|dir| (harness_id.clone(), dir.clone()))
            })
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    fn docs_project_dir(&self, harness_id: &str) -> Option<String> {
        self.artifacts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(harness_id)
            .and_then(|store| store.project_dir.clone())
    }

    /// Render the docs browser index as ONE flat, filterable list of every `.md`
    /// file under the selected harness's working dir — no folder tree, no
    /// drill-down (spec 171 rev 4: the hierarchy made navigation too slow).
    /// `sel_harness` comes from the query (`None` = first harness).
    fn docs_index_page(&self, sel_harness: Option<&str>) -> Response {
        let dirs = self.docs_project_dirs();
        if dirs.is_empty() {
            let content = "<p class=\"welcome\">No harness working directory is available.</p>";
            return render_docs_page("Docs", content);
        }

        let harnesses: Vec<(String, String, Vec<DocEntry>)> = dirs
            .into_iter()
            .map(|(id, path)| {
                let entries = collect_doc_files(StdPath::new(&path));
                (id, path, entries)
            })
            .collect();

        // Resolve the active harness (fall back to the first).
        let selected = sel_harness
            .filter(|h| harnesses.iter().any(|(id, _, _)| id == h))
            .map(str::to_string)
            .unwrap_or_else(|| harnesses[0].0.clone());
        let active = harnesses
            .iter()
            .find(|(id, _, _)| id == &selected)
            .unwrap_or(&harnesses[0]);
        let (harness_id, project_dir, entries) = active;

        let counts: Vec<(String, usize)> = harnesses
            .iter()
            .map(|(id, _, entries)| (id.clone(), entries.len()))
            .collect();
        let mut content = render_docs_harness_bar(&counts, harness_id, "/docs");
        content.push_str(&render_docs_list(harness_id, entries));

        let title = format!("{harness_id} · {project_dir} · {} files", entries.len());
        render_docs_page(&title, &content)
    }

    /// The `/journal` index (specs 223, 225): every written day for the
    /// selected harness's project, newest day first.
    ///
    /// Deliberately thin — it is an index only. Rows link into `/doc`, so a day
    /// inherits that reader's markdown rendering, live reload, inline feedback,
    /// and artifact export without this surface reimplementing any of it.
    fn journal_index_page(&self, sel_harness: Option<&str>) -> Response {
        let dirs = self.docs_project_dirs();
        if dirs.is_empty() {
            let content = "<p class=\"welcome\">No harness working directory is available.</p>";
            return render_docs_page("Daily notes", content);
        }

        let harnesses: Vec<(String, String, Vec<JournalNote>)> = dirs
            .into_iter()
            .map(|(id, path)| {
                let notes = collect_journal_notes(StdPath::new(&path));
                (id, path, notes)
            })
            .collect();

        let selected = sel_harness
            .filter(|h| harnesses.iter().any(|(id, _, _)| id == h))
            .map(str::to_string)
            .unwrap_or_else(|| harnesses[0].0.clone());
        let active = harnesses
            .iter()
            .find(|(id, _, _)| id == &selected)
            .unwrap_or(&harnesses[0]);
        let (harness_id, project_dir, notes) = active;

        let counts: Vec<(String, usize)> = harnesses
            .iter()
            .map(|(id, _, notes)| (id.clone(), notes.len()))
            .collect();
        let mut content = render_docs_harness_bar(&counts, harness_id, "/journal");
        content.push_str(&render_journal_list(harness_id, notes));

        let title = format!("{harness_id} · {project_dir} · {} days", notes.len());
        render_docs_page(&title, &content)
    }

    fn render_doc_content(&self, harness_id: &str, rel: &str) -> Result<(String, String), String> {
        let project_dir = self
            .docs_project_dir(harness_id)
            .ok_or_else(|| "not_found: unknown harness".to_string())?;
        let normalized_rel =
            normalize_relative_link(StdPath::new(""), rel).unwrap_or_else(|| rel.to_string());
        let cwd = StdPath::new(&project_dir);
        let path = validate_doc_path(cwd, &normalized_rel, &["md"])?;
        let source =
            std::fs::read_to_string(&path).map_err(|e| format!("not_found: read failed ({e})"))?;
        Ok((
            render_markdown_doc(&source, harness_id, &normalized_rel, "/doc-asset"),
            normalized_rel,
        ))
    }

    /// Discover analysis bundles for every harness: `(harness_id, project_dir,
    /// bundles)`. One filesystem walk per harness; callers reuse this for both the
    /// index/bundle content AND the sidebar so `/analysis` walks the tree once.
    fn discover_analyses_per_harness(&self) -> Vec<(String, String, Vec<AnalysisBundle>)> {
        self.docs_project_dirs()
            .into_iter()
            .map(|(id, path)| {
                let bundles = discover_analysis_bundles(&path);
                (id, path, bundles)
            })
            .collect()
    }

    /// Render the `/analyses` index: every harness's analysis bundles in the
    /// sidebar, the selected harness's bundles as rows on the right. `sel_harness`
    /// defaults to the first harness that actually has bundles.
    fn analyses_index_page(&self, sel_harness: Option<&str>) -> Response {
        let per = self.discover_analyses_per_harness();
        if per.is_empty() {
            return render_analyses_page(
                "Issue analyses",
                Some(""),
                "<p class=\"welcome\">No harness working directory is available.</p>",
            );
        }
        let selected = sel_harness
            .filter(|h| per.iter().any(|(id, _, b)| id == h && !b.is_empty()))
            .map(str::to_string)
            .or_else(|| {
                per.iter()
                    .find(|(_, _, b)| !b.is_empty())
                    .map(|(id, _, _)| id.clone())
            });
        let nav = render_analyses_nav(&per, selected.as_deref().unwrap_or(""), "");
        let content = match &selected {
            Some(harness_id) => {
                let bundles = per
                    .iter()
                    .find(|(id, _, _)| id == harness_id)
                    .map(|(_, _, b)| b.as_slice())
                    .unwrap_or(&[]);
                render_analyses_index(harness_id, bundles)
            }
            None => "<p class=\"welcome\">ยังไม่มีบทวิเคราะห์ issue — รัน #analyze-github-issue ในเลนเพื่อสร้างบทวิเคราะห์</p>".to_string(),
        };
        let title = match &selected {
            Some(harness_id) => format!("Issue analyses · {harness_id}"),
            None => "Issue analyses".to_string(),
        };
        render_analyses_page(&title, Some(&nav), &content)
    }

    /// Discover review bundles for every harness: `(harness_id, project_dir,
    /// bundles)`. One filesystem walk per harness; callers reuse this for both the
    /// index/bundle content AND the sidebar so `/review` walks the tree once.
    fn discover_reviews_per_harness(&self) -> Vec<(String, String, Vec<ReviewBundleInfo>)> {
        self.docs_project_dirs()
            .into_iter()
            .map(|(id, path)| {
                let bundles = discover_review_bundles(&path);
                (id, path, bundles)
            })
            .collect()
    }

    /// Render the `/reviews` index: every harness's bundles in the sidebar, the
    /// selected harness's bundles as rows on the right. `sel_harness` defaults to
    /// the first harness that actually has bundles.
    fn reviews_index_page(&self, sel_harness: Option<&str>) -> Response {
        let per = self.discover_reviews_per_harness();
        if per.is_empty() {
            return render_reviews_page(
                "Review Boards",
                Some(""),
                "<p class=\"welcome\">No harness working directory is available.</p>",
            );
        }
        let selected = sel_harness
            .filter(|h| per.iter().any(|(id, _, b)| id == h && !b.is_empty()))
            .map(str::to_string)
            .or_else(|| {
                per.iter()
                    .find(|(_, _, b)| !b.is_empty())
                    .map(|(id, _, _)| id.clone())
            });
        let nav = render_reviews_nav(&per, selected.as_deref().unwrap_or(""), "");
        let content = match &selected {
            Some(harness_id) => {
                let bundles = per
                    .iter()
                    .find(|(id, _, _)| id == harness_id)
                    .map(|(_, _, b)| b.as_slice())
                    .unwrap_or(&[]);
                render_reviews_index(harness_id, bundles)
            }
            None => "<p class=\"welcome\">ยังไม่มี Review Board — ขอให้เลนอธิบายโค้ดหรือรัน #review เพื่อให้เลนเขียนขึ้นมา</p>".to_string(),
        };
        let title = match &selected {
            Some(harness_id) => format!("Review Boards · {harness_id}"),
            None => "Review Boards".to_string(),
        };
        render_reviews_page(&title, Some(&nav), &content)
    }

    /// `artifact_new` — allocate an id, issue a destination path inside the
    /// project, ensure the scratch dirs + `.gitignore` exist, and record a
    /// `pending` entry. Returns `{ id, path }`. Fails closed if the gitignore
    /// or directory cannot be created (no path leaked into git status).
    fn artifact_new(
        &self,
        harness_id: &str,
        lane_label: &str,
        title: &str,
    ) -> Result<Value, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("title must be non-empty".to_string());
        }
        if title.chars().count() > ARTIFACT_TITLE_MAX {
            return Err(format!(
                "title is {} chars but must be \u{2264}{ARTIFACT_TITLE_MAX}",
                title.chars().count()
            ));
        }

        let seq = self.next_artifact_seq.fetch_add(1, Ordering::Relaxed);
        let artifact_id = format!("art-{seq}-{}", rand_suffix());
        let lane_dir_name = sanitize_path_component(lane_label);

        let mut artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        let store = artifacts
            .get_mut(harness_id)
            .ok_or_else(|| format!("Unknown harness: {harness_id}"))?;
        let project_dir = store
            .project_dir
            .clone()
            .ok_or_else(|| "no project directory for artifacts in this harness".to_string())?;

        // Caps: outstanding pending per lane, and total per session.
        let pending_for_lane = store
            .entries
            .values()
            .filter(|e| e.lane_label == lane_label && e.state == ArtifactState::Pending)
            .count();
        if pending_for_lane >= ARTIFACT_PENDING_PER_LANE_MAX {
            return Err(format!(
                "pending_cap: at most {ARTIFACT_PENDING_PER_LANE_MAX} outstanding pending artifacts per lane — register or cancel one first"
            ));
        }
        if store.entries.len() >= ARTIFACT_PER_SESSION_MAX {
            return Err(format!(
                "session_cap: at most {ARTIFACT_PER_SESSION_MAX} artifacts per harness tab"
            ));
        }

        let root = artifacts_root(&project_dir)
            .ok_or_else(|| "could not resolve artifact scratch root".to_string())?;
        let lane_dir = root.join(harness_id).join(&lane_dir_name);
        // Fail closed: a path we cannot back with a gitignore must never be
        // handed out, or it would pollute the user's git status.
        ensure_artifacts_gitignore(&root)
            .map_err(|e| format!("could not prepare artifact scratch dir: {e}"))?;
        std::fs::create_dir_all(&lane_dir)
            .map_err(|e| format!("could not create artifact lane dir: {e}"))?;

        let path = lane_dir.join(format!("{artifact_id}.html"));
        let tail = format!(".krypton/artifacts/{harness_id}/{lane_dir_name}/{artifact_id}.html");
        let path_str = path.to_string_lossy().to_string();

        // spec 149 — bake the feedback channel into the scaffold at issue time:
        // an unguessable per-artifact token (the sole capability for the served
        // URL + feedback endpoint) and the loopback base URL the page POSTs to.
        // The server is already listening when a lane can call artifact_new, so
        // the port is known here.
        let feedback_token = feedback_token();
        let feedback_base_url = format!("http://127.0.0.1:{}", self.get_port());

        // spec 134 — seed a styled scaffold so the lane edits (not authors from
        // scratch) and output has a consistent baseline. Atomic temp+rename so a
        // failed/interrupted write never leaves a truncated scaffold, and fail
        // closed (no pending entry / no issued path) if it cannot be written.
        let html = ARTIFACT_SCAFFOLD
            .replace("{{title}}", &html_escape(title))
            .replace("{{feedbackToken}}", &feedback_token)
            .replace("{{feedbackBaseUrl}}", &feedback_base_url);
        write_artifact_scaffold(&path, &html)
            .map_err(|e| format!("could not seed artifact scaffold: {e}"))?;

        store.entries.insert(
            artifact_id.clone(),
            ArtifactEntry {
                id: artifact_id.clone(),
                lane_label: lane_label.to_string(),
                title: title.to_string(),
                path,
                tail: tail.clone(),
                state: ArtifactState::Pending,
                size: 0,
                hash: String::new(),
                feedback_token: feedback_token.clone(),
            },
        );
        drop(artifacts);
        self.feedback_tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                feedback_token.clone(),
                FeedbackToken {
                    harness_id: harness_id.to_string(),
                    lane_label: lane_label.to_string(),
                    artifact_id: artifact_id.clone(),
                    revoked: false,
                },
            );

        Ok(json!({
            "id": artifact_id,
            "path": path_str,
            "tail": tail,
            "state": "pending",
            "title": title,
            "content_marker": ARTIFACT_CONTENT_MARKER,
            "feedbackToken": feedback_token,
        }))
    }

    /// `artifact_register` — first call validates the issued file and
    /// transitions `pending → registered_live`; a repeat call on a live id is an
    /// idempotent metadata refresh (re-stat/re-hash).
    fn artifact_register(
        &self,
        harness_id: &str,
        lane_label: &str,
        id: &str,
    ) -> Result<Value, String> {
        let mut artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        let store = artifacts
            .get_mut(harness_id)
            .ok_or_else(|| format!("Unknown harness: {harness_id}"))?;
        let project_dir = store.project_dir.clone();
        let entry = store
            .entries
            .get_mut(id)
            // No path detail leaked for an id that is not the caller's.
            .filter(|e| e.lane_label == lane_label)
            .ok_or_else(|| "not_found: no such artifact id for this lane".to_string())?;

        let root = project_dir
            .as_deref()
            .and_then(artifacts_root)
            .ok_or_else(|| "could not resolve artifact scratch root".to_string())?;
        let (size, hash) =
            validate_artifact_file(&root, &entry.path, &entry.id, ARTIFACT_FILE_BYTES_MAX)?;
        let was_pending = entry.state == ArtifactState::Pending;
        entry.state = ArtifactState::RegisteredLive;
        entry.size = size;
        entry.hash = hash.clone();
        let snapshot = entry.clone();
        drop(artifacts);

        Ok(json!({
            "ok": true,
            "id": snapshot.id,
            "size": size,
            "hash": hash,
            "title": snapshot.title,
            "path": snapshot.path.to_string_lossy(),
            "tail": snapshot.tail,
            // First register raises the card; a repeat is just a refresh.
            "registered": was_pending,
        }))
    }

    /// `artifact_cancel` — `pending` only: drop the registry entry and its
    /// feedback token. The on-disk file is preserved. Errors `already_registered`
    /// on a live id.
    fn artifact_cancel(
        &self,
        harness_id: &str,
        lane_label: &str,
        id: &str,
    ) -> Result<Value, String> {
        let mut artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        let store = artifacts
            .get_mut(harness_id)
            .ok_or_else(|| format!("Unknown harness: {harness_id}"))?;
        let entry = store
            .entries
            .get(id)
            .filter(|e| e.lane_label == lane_label)
            .ok_or_else(|| "not_found: no such artifact id for this lane".to_string())?;
        if entry.state == ArtifactState::RegisteredLive {
            return Err(
                "already_registered: cannot cancel a live artifact (no retire in v1)".to_string(),
            );
        }
        let token = entry.feedback_token.clone();
        store.entries.remove(id);
        drop(artifacts);
        // spec 149: drop the cancelled artifact's feedback token.
        self.feedback_tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&token);
        Ok(json!({ "ok": true, "id": id }))
    }

    /// Cancel every outstanding `pending` artifact for a lane (turn-end / lane
    /// teardown). Returns the cancelled ids. Live artifacts are untouched.
    pub fn cancel_pending_artifacts(&self, harness_id: &str, lane_label: &str) -> Vec<String> {
        let mut artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = artifacts.get_mut(harness_id) else {
            return Vec::new();
        };
        let pending_ids: Vec<String> = store
            .entries
            .values()
            .filter(|e| e.lane_label == lane_label && e.state == ArtifactState::Pending)
            .map(|e| e.id.clone())
            .collect();
        let mut tokens = Vec::new();
        for id in &pending_ids {
            if let Some(entry) = store.entries.remove(id) {
                tokens.push(entry.feedback_token);
            }
        }
        drop(artifacts);
        // spec 149: drop the cancelled artifacts' feedback tokens.
        {
            let mut map = self
                .feedback_tokens
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            for token in &tokens {
                map.remove(token);
            }
        }
        pending_ids
    }

    /// Re-stat/re-hash a live artifact after an observed write/edit. Returns the
    /// refreshed `{ id, size, hash, ... }` for the frontend card, or an error if
    /// the file now violates the size cap / path rules (card goes unavailable).
    pub fn refresh_artifact(
        &self,
        harness_id: &str,
        lane_label: &str,
        id: &str,
    ) -> Result<Value, String> {
        // Same validation as register's idempotent refresh path.
        self.artifact_register(harness_id, lane_label, id)
    }

    /// Spec 149: forward-only revoke of every feedback token issued to a lane
    /// (lane close / `#new`). Subsequent `GET`/`state`/`feedback` for those
    /// tokens report `410 revoked`. `#restart` does NOT call this — the
    /// respawned session keeps the channel. Returns the number revoked.
    pub fn revoke_feedback_tokens_for_lane(&self, harness_id: &str, lane_label: &str) -> usize {
        let mut tokens = self
            .feedback_tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut count = 0;
        for entry in tokens.values_mut() {
            if entry.harness_id == harness_id && entry.lane_label == lane_label && !entry.revoked {
                entry.revoked = true;
                count += 1;
            }
        }
        count
    }

    /// Resolve a feedback token to the served artifact's location + metadata.
    /// Returns the lookup outcome; a token whose artifact entry has since been
    /// swept is reported as `Revoked` (the artifact is no longer live).
    fn lookup_feedback_token(&self, token: &str) -> FeedbackLookup {
        let (harness_id, lane_label, artifact_id) = {
            let tokens = self
                .feedback_tokens
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match tokens.get(token) {
                None => return FeedbackLookup::Unknown,
                Some(t) if t.revoked => return FeedbackLookup::Revoked,
                Some(t) => (
                    t.harness_id.clone(),
                    t.lane_label.clone(),
                    t.artifact_id.clone(),
                ),
            }
        };
        let artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = artifacts.get(&harness_id) else {
            return FeedbackLookup::Revoked;
        };
        let Some(entry) = store.entries.get(&artifact_id) else {
            // Entry swept (harness closed) while the token map still holds it.
            return FeedbackLookup::Revoked;
        };
        let Some(root) = store.project_dir.as_deref().and_then(artifacts_root) else {
            return FeedbackLookup::Revoked;
        };
        FeedbackLookup::Found(FeedbackServeInfo {
            harness_id,
            lane_label,
            artifact_id,
            title: entry.title.clone(),
            path: entry.path.clone(),
            root,
            registered: entry.state == ArtifactState::RegisteredLive,
        })
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

// ─── HTML artifacts (spec 133) ──────────────────────────────────────────────

/// Max characters for an artifact title (card label only).
const ARTIFACT_TITLE_MAX: usize = 200;
/// spec 160: max review-priority ranges a single mark_review_priority call may
/// carry. A reading-order hint, not a per-line audit — cap keeps the frontend
/// round-trip bounded against a pathological flood of one-line ranges.
const MAX_REVIEW_PRIORITY_RANGES: usize = 500;
/// spec 146: max structured findings a single review_outcome call may carry.
/// Mirrors the review-priority range cap to keep the frontend bus payload bounded.
const MAX_REVIEW_FINDINGS: usize = MAX_REVIEW_PRIORITY_RANGES;
/// Max bytes for an artifact file, enforced on every write/edit and at
/// register/open. A live edit past this makes the card unavailable rather than
/// silently opening.
const ARTIFACT_FILE_BYTES_MAX: u64 = 4 * 1024 * 1024;
/// Max live + pending artifacts per harness tab.
const ARTIFACT_PER_SESSION_MAX: usize = 64;
/// Max outstanding `pending` artifacts per lane. Pending entries authorize a
/// write, so they are bounded and short-lived.
const ARTIFACT_PENDING_PER_LANE_MAX: usize = 4;
/// Styled starter scaffold seeded at `artifact_new` (spec 134). Self-contained
/// HTML with the Binance dark default theme + light/auto toggle; the lane
/// edits the `<main data-artifact-content>` placeholder to fill content.
const ARTIFACT_SCAFFOLD: &str = include_str!("../resources/artifact-scaffold.html");
/// Stable anchor the lane orients its first edit on (returned by `artifact_new`).
const ARTIFACT_CONTENT_MARKER: &str = "main[data-artifact-content]";

// ─── Artifact inline feedback (spec 149) ────────────────────────────────────
/// Max comments accepted in a single feedback batch POST. Over → `413`.
const FEEDBACK_COMMENTS_MAX: usize = 50;
/// Max chars for a single comment `body`. Over → `413`.
const FEEDBACK_BODY_MAX: usize = 4000;
/// Max chars for a comment's selected-text `quote`. Over → `413`.
const FEEDBACK_QUOTE_MAX: usize = 2000;
/// Max chars for a comment anchor's `outerHTML` snapshot. Over → `413`.
const FEEDBACK_OUTERHTML_MAX: usize = 8000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactState {
    Pending,
    RegisteredLive,
}

#[derive(Debug, Clone)]
struct ArtifactEntry {
    id: String,
    lane_label: String,
    title: String,
    /// Absolute issued path to `<id>.html`.
    path: PathBuf,
    /// Project-relative tail `.krypton/artifacts/<harnessId>/<laneLabel>/<id>.html`
    /// — the unique suffix the frontend matches write targets against.
    tail: String,
    state: ArtifactState,
    size: u64,
    hash: String,
    /// Spec 149: unguessable per-artifact feedback token, baked into the served
    /// scaffold and the registry. Empty only for entries created before this
    /// field existed (none at runtime — always set at `artifact_new`).
    feedback_token: String,
}

#[derive(Debug, Default)]
struct HarnessArtifactStore {
    /// Lane working dir / scratch base. None ⇒ artifacts unavailable here.
    project_dir: Option<String>,
    /// Key: artifact id.
    entries: HashMap<String, ArtifactEntry>,
}

// ─── Review Board (spec 211) ────────────────────────────────────────────────
// Path-handoff exactly like an artifact (spec 133), but the destination is a
// DURABLE bundle directory keyed by date + title slug rather than a swept,
// session-keyed file: `hm-1/Claude-1` is meaningless a week later, and a review
// result is a record. Bundles are never swept; the registry entry is the only
// thing torn down when a lane closes.

/// Max characters for a review title (card label + slug source).
const REVIEW_TITLE_MAX: usize = 200;
/// Max characters for the `subject` stamp (what is under review).
const REVIEW_SUBJECT_MAX: usize = 500;
/// Max bytes for `review.md`, enforced at register and on every refresh.
const REVIEW_FILE_BYTES_MAX: u64 = 4 * 1024 * 1024;
/// Max live + pending reviews per harness tab.
const REVIEW_PER_SESSION_MAX: usize = 64;
/// Max outstanding `pending` reviews per lane. A pending entry authorizes writes
/// into a bundle directory, so they stay bounded and short-lived.
const REVIEW_PENDING_PER_LANE_MAX: usize = 2;
/// Max slug length, so a long title cannot produce an unwieldy directory name.
const REVIEW_SLUG_MAX: usize = 60;
/// Max same-day collision suffixes tried before giving up (`-2` … `-50`).
const REVIEW_SLUG_COLLISION_MAX: u32 = 50;
/// Max bytes `/review-asset` will stream for one attached image (25 MiB).
const REVIEW_ASSET_MAX_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewState {
    Pending,
    RegisteredLive,
}

#[derive(Debug, Clone)]
struct ReviewEntry {
    id: String,
    lane_label: String,
    title: String,
    /// Bundle directory name — the durable id, e.g. `2026-08-07-peering-guard`.
    slug: String,
    /// Absolute bundle directory.
    dir: PathBuf,
    /// Absolute issued path to `<dir>/review.md`.
    path: PathBuf,
    /// Project-relative tail `.krypton/reviews/<slug>/` — the PREFIX the frontend
    /// matches write targets against. Unlike an artifact (one file), write
    /// auto-approval covers the whole bundle so the lane may add `assets/`.
    tail: String,
    state: ReviewState,
    /// Block/step/finding/decision counts from the last register, for the card.
    blocks: usize,
    steps: usize,
    findings: usize,
    decisions: usize,
}

#[derive(Debug, Default)]
struct HarnessReviewStore {
    /// Lane working dir. None ⇒ reviews unavailable here.
    project_dir: Option<String>,
    /// Key: review id.
    entries: HashMap<String, ReviewEntry>,
}

/// One markdown file in a harness's working dir, addressed by its full
/// `/`-joined path relative to the project root (spec 171 rev 4: the docs index
/// is a flat list, so a file carries its whole path, not just a leaf name).
#[derive(Debug)]
struct DocEntry {
    rel: String,
    modified: Option<SystemTime>,
}

#[derive(Debug, Deserialize)]
struct DocQuery {
    harness: String,
    path: String,
}

/// Query for the docs index (`/docs`). `harness` selects which harness's files
/// fill the list (defaults to the first). Unknown params are ignored by serde,
/// so stale rev-3 `&dir=` bookmarks still resolve to the flat list.
#[derive(Debug, Default, Deserialize)]
struct DocsQuery {
    harness: Option<String>,
}

/// Query for the analyses index (`/analyses`). `harness` selects which harness's
/// bundles fill the right pane (defaults to the first with bundles).
#[derive(Debug, Default, Deserialize)]
struct AnalysesQuery {
    harness: Option<String>,
}

/// Query for one issue's analysis bundle (`/analysis`). `issue` is the
/// `owner/repo/number` path (slash-joined, NOT `owner/repo#number`). `harness` is
/// optional (like `/docs`): when omitted, the handler picks the harness that owns
/// the issue, else the first harness with bundles — so a bare
/// `/analysis?issue=…` bookmark still resolves. `file` selects which `.md` in the
/// bundle to render (by filename); omitted or unknown falls back to the first
/// file in bundle order (root-cause.md when present), so old bookmarks resolve.
#[derive(Debug, Deserialize)]
struct AnalysisQuery {
    harness: Option<String>,
    issue: String,
    file: Option<String>,
}

/// Query for the Review Board archive index (`/reviews`). `harness` selects which
/// harness's bundles fill the right pane (defaults to the first with bundles).
#[derive(Debug, Default, Deserialize)]
struct ReviewsQuery {
    harness: Option<String>,
}

/// Query for one review bundle (`/review`). `slug` is the bundle directory name —
/// the durable id. `harness` is optional (like `/docs`): when omitted, the handler
/// picks the harness that owns the slug, else the first harness with bundles, so a
/// bare `/review?slug=…` bookmark still resolves. `file` is `review` (default) or
/// `response`; anything else falls back to `review`.
#[derive(Debug, Deserialize)]
struct ReviewQuery {
    harness: Option<String>,
    slug: String,
    file: Option<String>,
}

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

/// GET /artifact/:token — serve the registered artifact's HTML (spec 149).
/// Replaces the old `file://` open: the OS browser loads this URL so the page
/// is same-origin with the feedback endpoint. The token in the path is the sole
/// capability. Re-runs the full spec-133 `validate_artifact_file` policy on
/// every serve (symlink/hardlink/component/size checks) to bound the TOCTOU
/// window, and serves with `no-store` so a refresh re-checks the registry and
/// the token never persists in cache/history. GET-only; non-reflective errors.
async fn handle_artifact_get(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
) -> Response {
    let info = match state.hook_server.lookup_feedback_token(&token) {
        FeedbackLookup::Unknown => return StatusCode::NOT_FOUND.into_response(),
        FeedbackLookup::Revoked => return StatusCode::GONE.into_response(),
        FeedbackLookup::Found(info) => info,
    };
    // Validate-then-read: confirms the path policy and that the file fits the
    // cap before we read it. Validation already reads+hashes; read again here so
    // the bytes match the validated metadata closely (TOCTOU is bounded, not
    // eliminated — accepted in the spec's risk notes).
    if validate_artifact_file(
        &info.root,
        &info.path,
        &info.artifact_id,
        ARTIFACT_FILE_BYTES_MAX,
    )
    .is_err()
    {
        return StatusCode::GONE.into_response();
    }
    let body = match std::fs::read(&info.path) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::GONE.into_response(),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// GET /artifact/state/:token — the scaffold's live-reload poll (spec 149).
/// Returns the artifact file's current hash + whether it is still registered;
/// the page reloads when the hash changes. Re-hashes on each poll so it
/// reflects the latest lane edit (the registry hash only updates on register).
async fn handle_artifact_state(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
) -> Response {
    let info = match state.hook_server.lookup_feedback_token(&token) {
        FeedbackLookup::Unknown => return StatusCode::NOT_FOUND.into_response(),
        // Distinct from GET: the overlay disables submission on `registered:false`
        // rather than treating a swept artifact as a hard error.
        FeedbackLookup::Revoked => {
            return Json(json!({ "hash": "", "registered": false })).into_response()
        }
        FeedbackLookup::Found(info) => info,
    };
    let hash = match validate_artifact_file(
        &info.root,
        &info.path,
        &info.artifact_id,
        ARTIFACT_FILE_BYTES_MAX,
    ) {
        Ok((_, hash)) => hash,
        Err(_) => String::new(),
    };
    let mut resp = Json(json!({ "hash": hash, "registered": info.registered && !hash.is_empty() }))
        .into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    resp
}

const DASHBOARD_HTML: &str = include_str!("../../src/acp/artifact-dashboard.html");
const GALLERY_HTML: &str = include_str!("../../src/acp/artifact-gallery.html");
const DOCS_HTML: &str = include_str!("../../src/acp/artifact-docs.html");
const ANALYSES_HTML: &str = include_str!("../../src/acp/artifact-analyses.html");
/// spec 211: the read-only Review Board archive shell (Binance-dark, cloned from
/// the analyses shell). The Board itself is in-app; this page only browses.
const REVIEWS_HTML: &str = include_str!("../../src/acp/artifact-reviews.html");
const COMMANDS_HTML: &str = include_str!("../../src/acp/artifact-commands.html");
const TOOLS_HTML: &str = include_str!("../../src/acp/artifact-tools.html");
const TERMCTRL_HTML: &str = include_str!("../../src/acp/artifact-termctrl.html");
const HURL_HTML: &str = include_str!("../../src/acp/artifact-hurl.html");

fn secured_json_response<T: Serialize>(status: StatusCode, payload: T) -> Response {
    let mut response = (status, Json(payload)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("no-referrer"),
    );
    response
}

fn termctrl_token_matches(state: &HookServerState, token: &str) -> bool {
    constant_time_token_eq(token, state.hook_server.termctrl_monitor.token())
}

fn constant_time_token_eq(candidate: &str, expected: &str) -> bool {
    if candidate.len() != expected.len() {
        return false;
    }
    candidate
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

/// GET /termctrl/{token}: read-only Terminal Control session monitor.
async fn handle_termctrl_page(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
) -> Response {
    if !termctrl_token_matches(&state, &token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    html_response(TERMCTRL_HTML)
}

/// GET /termctrl/api/{token}/sessions: normalized session inventory.
async fn handle_termctrl_sessions(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
) -> Response {
    if !termctrl_token_matches(&state, &token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let payload: TermctrlSessionList = state.hook_server.termctrl_monitor.list_sessions().await;
    secured_json_response(StatusCode::OK, payload)
}

/// GET /termctrl/api/{token}/screen/{name}: visible text for one session.
async fn handle_termctrl_screen(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path((token, name)): Path<(String, String)>,
) -> Response {
    if !termctrl_token_matches(&state, &token)
        || !crate::termctrl_monitor::valid_session_name(&name)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    match state.hook_server.termctrl_monitor.screen(&name).await {
        Ok(payload) => secured_json_response(StatusCode::OK, payload),
        Err(_) => secured_json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "session screen unavailable" }),
        ),
    }
}

fn hurl_session(state: &HookServerState, token: &str) -> Option<HurlWebSession> {
    state.hook_server.hurl_sessions.get(token)
}

#[derive(Deserialize)]
struct HurlPathQuery {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HurlWebRunBody {
    path: String,
    #[serde(default)]
    verbose: bool,
    #[serde(default)]
    very_verbose: bool,
    variables_file: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HurlWebCancelBody {
    run_id: u64,
}

/// GET /hurl/{token} — Hurl web client page (spec 227).
async fn handle_hurl_page(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
) -> Response {
    if hurl_session(&state, &token).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    html_response(HURL_HTML)
}

/// GET /hurl/api/{token}/listing
async fn handle_hurl_listing(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
) -> Response {
    let Some(session) = hurl_session(&state, &token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !std::path::Path::new(&session.cwd).is_dir() {
        return secured_json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "available": false,
                "error": "cwd no longer exists",
                "cwd": session.cwd,
                "hurl_files": [],
                "env_files": [],
            }),
        );
    }
    let listing = match list_hurl_files(session.cwd.clone()) {
        Ok(l) => l,
        Err(error) => {
            return secured_json_response(
                StatusCode::BAD_REQUEST,
                json!({
                    "available": false,
                    "error": error,
                    "cwd": session.cwd,
                    "hurl_files": [],
                    "env_files": [],
                }),
            );
        }
    };
    let available = state.hurl.binary_available(&state.config);
    secured_json_response(
        StatusCode::OK,
        json!({
            "available": available,
            "error": if available {
                Value::Null
            } else {
                Value::String("hurl binary not found — install from https://hurl.dev".into())
            },
            "cwd": session.cwd,
            "hurl_files": listing.hurl_files,
            "env_files": listing.env_files,
        }),
    )
}

/// GET /hurl/api/{token}/source?path=
async fn handle_hurl_source(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
    Query(query): Query<HurlPathQuery>,
) -> Response {
    let Some(session) = hurl_session(&state, &token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = match confine_under_cwd(&session.cwd, &query.path, "hurl") {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match String::from_utf8(bytes) {
        Ok(source) => secured_json_response(StatusCode::OK, json!({ "source": source })),
        Err(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response(),
    }
}

/// GET /hurl/api/{token}/env?path=
async fn handle_hurl_env(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
    Query(query): Query<HurlPathQuery>,
) -> Response {
    let Some(session) = hurl_session(&state, &token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = match confine_under_cwd(&session.cwd, &query.path, "env") {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match crate::hurl::hurl_read_env_file(path.to_string_lossy().to_string()) {
        Ok(map) => secured_json_response(StatusCode::OK, map),
        Err(error) => secured_json_response(StatusCode::BAD_REQUEST, json!({ "error": error })),
    }
}

/// GET /hurl/api/{token}/cache?path=
async fn handle_hurl_cache(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
    Query(query): Query<HurlPathQuery>,
) -> Response {
    let Some(session) = hurl_session(&state, &token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = match confine_under_cwd(&session.cwd, &query.path, "hurl") {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match load_cached_run(&state.app_handle, &path.to_string_lossy()) {
        Ok(entry) => secured_json_response(StatusCode::OK, entry),
        Err(error) => secured_json_response(StatusCode::BAD_REQUEST, json!({ "error": error })),
    }
}

/// POST /hurl/api/{token}/run
async fn handle_hurl_run(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
    Json(body): Json<HurlWebRunBody>,
) -> Response {
    let Some(session) = hurl_session(&state, &token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let file = match confine_under_cwd(&session.cwd, &body.path, "hurl") {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let variables_file = match body.variables_file.as_deref() {
        None | Some("") => None,
        Some(vf) => match confine_under_cwd(&session.cwd, vf, "env") {
            Ok(p) => Some(p.to_string_lossy().to_string()),
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        },
    };
    if let Some(old) = state.hook_server.hurl_sessions.take_active(&token) {
        cancel_run(&state.hurl, old).await;
    }
    let args = HurlRunArgs {
        file: file.to_string_lossy().to_string(),
        cwd: session.cwd,
        verbose: body.verbose,
        very_verbose: body.very_verbose,
        variables_file,
        extra_args: Vec::new(),
    };
    match start_run(
        state.app_handle.clone(),
        state.hurl.clone(),
        state.config.clone(),
        args,
    )
    .await
    {
        Ok(run_id) => {
            state.hook_server.hurl_sessions.set_active(&token, run_id);
            secured_json_response(StatusCode::OK, json!({ "runId": run_id }))
        }
        Err(error) => secured_json_response(StatusCode::BAD_REQUEST, json!({ "error": error })),
    }
}

/// GET /hurl/api/{token}/events/{runId}
async fn handle_hurl_events(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path((token, run_id)): Path<(String, u64)>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    if hurl_session(&state, &token).is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    let rx = state.hurl.subscribe();
    let stream = async_stream_from_hurl(rx, run_id);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(5))))
}

fn async_stream_from_hurl(
    rx: tokio::sync::broadcast::Receiver<HurlEvent>,
    run_id: u64,
) -> impl futures_util::Stream<Item = Result<Event, Infallible>> {
    futures_util::stream::unfold(Some(rx), move |state| async move {
        let mut rx = state?;
        loop {
            match rx.recv().await {
                Ok(HurlEvent::Output {
                    run_id: id,
                    stream,
                    chunk,
                }) if id == run_id => {
                    let data = serde_json::to_string(&json!({
                        "stream": stream,
                        "chunk": chunk,
                    }))
                    .unwrap_or_else(|_| "{}".into());
                    let ev = Event::default().event("output").data(data);
                    return Some((Ok(ev), Some(rx)));
                }
                Ok(HurlEvent::Finished {
                    run_id: id,
                    exit_code,
                    duration_ms,
                    truncated,
                    stdout,
                    stderr,
                }) if id == run_id => {
                    let data = serde_json::to_string(&json!({
                        "exitCode": exit_code,
                        "durationMs": duration_ms,
                        "truncated": truncated,
                        "stdout": stdout,
                        "stderr": stderr,
                    }))
                    .unwrap_or_else(|_| "{}".into());
                    let ev = Event::default().event("finished").data(data);
                    return Some((Ok(ev), None));
                }
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

/// POST /hurl/api/{token}/cancel
async fn handle_hurl_cancel(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
    Json(body): Json<HurlWebCancelBody>,
) -> Response {
    if hurl_session(&state, &token).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    cancel_run(&state.hurl, body.run_id).await;
    StatusCode::NO_CONTENT.into_response()
}

/// GET /hurl/api/{token}/state
async fn handle_hurl_state_get(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
) -> Response {
    let Some(session) = hurl_session(&state, &token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match load_sidebar_state(&state.app_handle, &session.cwd) {
        Ok(entry) => secured_json_response(StatusCode::OK, entry),
        Err(error) => secured_json_response(StatusCode::BAD_REQUEST, json!({ "error": error })),
    }
}

/// PUT /hurl/api/{token}/state
async fn handle_hurl_state_put(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
    Json(mut body): Json<HurlSidebarState>,
) -> Response {
    let Some(session) = hurl_session(&state, &token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    body.cwd = session.cwd;
    match save_sidebar_state(&state.app_handle, body) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => secured_json_response(StatusCode::BAD_REQUEST, json!({ "error": error })),
    }
}

/// GET /dashboard — fixed external-browser lane monitor page (spec 168 pivot).
async fn handle_dashboard() -> Response {
    html_response(DASHBOARD_HTML)
}

/// GET /telemetry — read-only snapshots for all live harness dashboards.
async fn handle_telemetry(AxumState(state): AxumState<Arc<HookServerState>>) -> Response {
    let mut resp = Json(json!({
        "harnesses": state.hook_server.all_telemetry_snapshots(),
    }))
    .into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    resp
}

/// GET /gallery — fixed external-browser artifact gallery page.
async fn handle_gallery() -> Response {
    html_response(GALLERY_HTML)
}

/// GET /commands — fixed external-browser built-in `#` command reference (spec 185).
async fn handle_commands() -> Response {
    html_response(COMMANDS_HTML)
}

/// GET /commands.json — the command manifest the frontend pushed at register.
/// `{ "commands": [] }` until a harness registers.
async fn handle_commands_json(AxumState(state): AxumState<Arc<HookServerState>>) -> Response {
    let manifest = state
        .hook_server
        .command_manifest()
        .unwrap_or_else(|| Value::Array(vec![]));
    let mut resp = Json(json!({ "commands": manifest })).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    resp
}

/// GET /tools — fixed external-browser built-in MCP tool reference (spec 186).
async fn handle_tools() -> Response {
    html_response(TOOLS_HTML)
}

/// spec 186: reference-page category per built-in MCP tool. Page-only — the
/// field is injected into `/tools.json` and never into the MCP `tools/list`
/// response, which strict clients (Junie's Kotlin SDK) parse by shape.
fn tool_category(name: &str) -> &'static str {
    match name {
        "handoff_set" | "handoff_get" | "handoff_list" => "memory",
        "peer_send" | "peer_list" => "peering",
        "artifact_new" | "artifact_register" | "artifact_cancel" => "artifacts",
        "attention_flag" | "attention_resolve" => "attention",
        "review_outcome" | "mark_review_priority" => "review",
        // spec 211: the Review Board is an authored surface, grouped with the
        // other path-handoff surfaces rather than with the `review_outcome`
        // bookkeeping tools it shares a name prefix with.
        "review_new" | "review_register" | "review_cancel" => "artifacts",
        "issue_progress" => "issues",
        _ => "other", // forward-compat: an unmapped tool still renders
    }
}

/// The /tools.json payload: the live `tools/list` descriptors plus a page-only
/// `category` per entry. Compile-time data: no store, no harness required.
fn tools_json_payload() -> Value {
    let mut tools = bus_tool_descriptors();
    if let Value::Array(ref mut arr) = tools {
        for tool in arr.iter_mut() {
            let category = tool
                .get("name")
                .and_then(|n| n.as_str())
                .map(tool_category)
                .unwrap_or("other");
            if let Value::Object(ref mut map) = tool {
                map.insert("category".to_string(), Value::String(category.to_string()));
            }
        }
    }
    json!({ "tools": tools })
}

/// GET /tools.json (spec 186).
async fn handle_tools_json() -> Response {
    let mut resp = Json(tools_json_payload()).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    resp
}

/// GET /artifacts — read-only artifact listings for all live harness stores.
async fn handle_artifacts(AxumState(state): AxumState<Arc<HookServerState>>) -> Response {
    let mut resp = Json(json!({
        "harnesses": state.hook_server.list_all_artifacts_for_gallery(),
    }))
    .into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    resp
}

/// GET /docs — fixed external-browser docs browser index.
async fn handle_docs(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocsQuery>,
) -> Response {
    state.hook_server.docs_index_page(query.harness.as_deref())
}

/// GET /journal[?harness=<id>] — index of rendered daily notes (spec 223).
async fn handle_journal(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocsQuery>,
) -> Response {
    state
        .hook_server
        .journal_index_page(query.harness.as_deref())
}

/// GET /doc?harness=<id>&path=<rel> — render one repo markdown file.
async fn handle_doc(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocQuery>,
) -> Response {
    let (content, rel) = match state
        .hook_server
        .render_doc_content(&query.harness, &query.path)
    {
        Ok(result) => result,
        Err(error) if error.starts_with("not_found:") => {
            return StatusCode::NOT_FOUND.into_response()
        }
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    // Single-file view opens in its own tab as a clean reader.
    render_docs_page(&rel, &content)
}

/// GET /doc-asset?harness=<id>&path=<rel> — serve a whitelisted repo image.
async fn handle_doc_asset(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocQuery>,
) -> Response {
    let project_dir = match state.hook_server.docs_project_dir(&query.harness) {
        Some(dir) => dir,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let path = match validate_doc_path(
        StdPath::new(&project_dir),
        &query.path,
        &["png", "jpg", "jpeg", "gif", "svg", "webp"],
    ) {
        Ok(path) => path,
        Err(error) if error.starts_with("not_found:") => {
            return StatusCode::NOT_FOUND.into_response()
        }
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let mime = doc_asset_mime(&path);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// GET /analyses?harness=<id> — the Issue Analysis Viewer index (spec 192).
async fn handle_analyses(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<AnalysesQuery>,
) -> Response {
    state
        .hook_server
        .analyses_index_page(query.harness.as_deref())
}

/// GET /analysis?harness=<id>&issue=<owner/repo/number> — one issue's bundle.
/// `harness` is optional: without it we pick the harness that owns the issue,
/// else the first harness with bundles (a bare `?issue=…` bookmark resolves).
/// One filesystem walk feeds both the bundle content and the sidebar.
async fn handle_analysis(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<AnalysisQuery>,
) -> Response {
    let per = state.hook_server.discover_analyses_per_harness();
    // Resolve the harness: an explicit (existing) one, else the harness that owns
    // this issue, else the first harness that has any bundle.
    let harness_id = query
        .harness
        .as_deref()
        .filter(|h| per.iter().any(|(id, _, _)| id == h))
        .map(str::to_string)
        .or_else(|| {
            per.iter()
                .find(|(_, _, b)| b.iter().any(|x| bundle_matches_issue(x, &query.issue)))
                .map(|(id, _, _)| id.clone())
        })
        .or_else(|| {
            per.iter()
                .find(|(_, _, b)| !b.is_empty())
                .map(|(id, _, _)| id.clone())
        });
    let Some(harness_id) = harness_id else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some((_, project_dir, bundles)) = per.iter().find(|(id, _, _)| id == &harness_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(bundle) = bundles
        .iter()
        .find(|b| bundle_matches_issue(b, &query.issue))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Resolve which `.md` to render: the requested filename when it exists in
    // the bundle, else the first file in bundle order (root-cause.md first).
    let sel_file = query
        .file
        .as_deref()
        .and_then(|f| {
            bundle
                .md_files
                .iter()
                .find(|rel| rel.rsplit('/').next() == Some(f))
        })
        .or_else(|| bundle.md_files.first())
        .cloned();
    let content = render_analysis_bundle(project_dir, &harness_id, bundle, sel_file.as_deref());
    let issue_ref = format!("{}/{}/{}", bundle.owner, bundle.repo, bundle.number);
    let nav = render_analyses_nav(&per, &harness_id, &issue_ref);
    render_analyses_page(&bundle.issue_key, Some(&nav), &content)
}

/// GET /analysis-asset?harness=<id>&path=<rel> — serve a whitelisted image from
/// an analysis bundle. Same traversal/symlink/extension guard + headers as
/// `/doc-asset`, but additionally scoped to `.krypton/analyses/` (this route
/// only ever serves bundle resources) and byte-capped.
async fn handle_analysis_asset(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocQuery>,
) -> Response {
    let project_dir = match state.hook_server.docs_project_dir(&query.harness) {
        Some(dir) => dir,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let path = match validate_doc_path(
        StdPath::new(&project_dir),
        &query.path,
        &["png", "jpg", "jpeg", "gif", "svg", "webp"],
    ) {
        Ok(path) => path,
        Err(error) if error.starts_with("not_found:") => {
            return StatusCode::NOT_FOUND.into_response()
        }
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    // Scope this route to the analyses bundle root — it must never serve an
    // arbitrary project image the way `/doc-asset` may. `path` is already
    // canonical (validate_doc_path); compare against the canonical analyses root.
    let Some(analyses_root) = analyses_root(&project_dir).and_then(|r| r.canonicalize().ok())
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !path.starts_with(&analyses_root) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Cap the served size so a huge downloaded resource can't spike memory.
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > ANALYSIS_ASSET_MAX_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let mime = doc_asset_mime(&path);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Max bytes `/analysis-asset` will stream for one downloaded resource (25 MiB).
const ANALYSIS_ASSET_MAX_BYTES: u64 = 25 * 1024 * 1024;

/// GET /reviews?harness=<id> — the Review Board archive index (spec 211).
/// READ-ONLY by design: it shows you what exists and what you left hanging, and
/// you open it in the app with `Leader Shift+R`. There is deliberately no
/// browser→app channel and no answering here.
async fn handle_reviews(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<ReviewsQuery>,
) -> Response {
    state
        .hook_server
        .reviews_index_page(query.harness.as_deref())
}

/// GET /review?harness=<id>&slug=<slug>[&file=review|response] — one bundle.
/// `harness` is optional: without it we pick the harness that owns the slug, else
/// the first harness with bundles. One filesystem walk feeds both the bundle page
/// and the sidebar.
async fn handle_review(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<ReviewQuery>,
) -> Response {
    let per = state.hook_server.discover_reviews_per_harness();
    let harness_id = query
        .harness
        .as_deref()
        .filter(|h| per.iter().any(|(id, _, _)| id == h))
        .map(str::to_string)
        .or_else(|| {
            per.iter()
                .find(|(_, _, b)| b.iter().any(|x| x.slug == query.slug))
                .map(|(id, _, _)| id.clone())
        })
        .or_else(|| {
            per.iter()
                .find(|(_, _, b)| !b.is_empty())
                .map(|(id, _, _)| id.clone())
        });
    let Some(harness_id) = harness_id else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some((_, _, bundles)) = per.iter().find(|(id, _, _)| id == &harness_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(bundle) = bundles.iter().find(|b| b.slug == query.slug) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // `file` is matched against a two-entry whitelist, never joined into a path.
    let sel_file = match query.file.as_deref() {
        Some("response") if bundle.responded_at.is_some() => "response",
        _ => "review",
    };
    let project_dir = per
        .iter()
        .find(|(id, _, _)| id == &harness_id)
        .map(|(_, dir, _)| dir.clone())
        .unwrap_or_default();
    let content = render_review_bundle(&harness_id, &project_dir, bundle, sel_file);
    let nav = render_reviews_nav(&per, &harness_id, &bundle.slug);
    render_reviews_page(&bundle.title, Some(&nav), &content)
}

/// GET /review-asset?harness=<id>&path=<rel> — serve a whitelisted image from a
/// review bundle. Same traversal/symlink/extension guard + headers as
/// `/analysis-asset`, additionally scoped to `.krypton/reviews/` and byte-capped.
async fn handle_review_asset(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocQuery>,
) -> Response {
    let project_dir = match state.hook_server.docs_project_dir(&query.harness) {
        Some(dir) => dir,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let path = match validate_doc_path(
        StdPath::new(&project_dir),
        &query.path,
        &["png", "jpg", "jpeg", "gif", "svg", "webp"],
    ) {
        Ok(path) => path,
        Err(error) if error.starts_with("not_found:") => {
            return StatusCode::NOT_FOUND.into_response()
        }
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    // Scope this route to the review root — it must never serve an arbitrary
    // project image the way `/doc-asset` may. `path` is already canonical.
    let Some(root) = reviews_root(&project_dir).and_then(|r| r.canonicalize().ok()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !path.starts_with(&root) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > REVIEW_ASSET_MAX_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let mime = doc_asset_mime(&path);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// GET /doc-state?harness=<id>&path=<rel> — current sha256 of a repo `.md`, so
/// the docs-browser feedback overlay can live-reload the page when a lane edits
/// the source file (spec 172). Tokenless, keyed by harness+path like `/doc`.
/// 404 on unknown harness / failed path validation / unreadable file.
async fn handle_doc_state(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocQuery>,
) -> Response {
    let project_dir = match state.hook_server.docs_project_dir(&query.harness) {
        Some(dir) => dir,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let normalized = normalize_relative_link(StdPath::new(""), &query.path)
        .unwrap_or_else(|| query.path.clone());
    let path = match validate_doc_path(StdPath::new(&project_dir), &normalized, &["md"]) {
        Ok(path) => path,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let Some(hash) = doc_file_hash(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut resp = Json(json!({ "hash": hash })).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    resp
}

/// POST /doc-feedback?harness=<id>&path=<rel> — the browser submits a comment
/// batch on a rendered doc (spec 172). Tokenless: keyed by harness+path, the same
/// addressing the read uses (ADR-0010, amended — the surface gains a write
/// channel). A doc has no owning lane, so the frontend routes the batch to the
/// harness's ACTIVE lane. Validates path + caps, then runs the synchronous bus
/// round-trip (fresh request id → emit `acp-docs-feedback-received` → await the
/// frontend's accept). A 200 means the batch entered the lane's feedback queue,
/// NOT that the lane acted on it. On bus timeout the browser may retry the same
/// `batchId` (the frontend de-dupes).
async fn handle_doc_feedback(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocQuery>,
    Json(body): Json<Value>,
) -> Response {
    let project_dir = match state.hook_server.docs_project_dir(&query.harness) {
        Some(dir) => dir,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let normalized = normalize_relative_link(StdPath::new(""), &query.path)
        .unwrap_or_else(|| query.path.clone());
    // Same containment boundary as `/doc`: a feedback POST can only target a real
    // `.md` file under the harness <cwd> (traversal/symlink/wrong-ext → 404/400).
    if validate_doc_path(StdPath::new(&project_dir), &normalized, &["md"]).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }

    let batch_id = body.get("batchId").and_then(|v| v.as_str()).unwrap_or("");
    if batch_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "missing batchId").into_response();
    }
    let Some(comments) = body.get("comments").and_then(|v| v.as_array()) else {
        return (StatusCode::BAD_REQUEST, "missing comments").into_response();
    };
    if comments.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty comments").into_response();
    }
    if comments.len() > FEEDBACK_COMMENTS_MAX {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    // Validate the required shape BEFORE the bus round-trip so a malformed comment
    // can't poison the batchId (queued + de-duped, then thrown in the composer).
    for c in comments {
        let body_ok = c
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !body_ok {
            return (StatusCode::BAD_REQUEST, "comment missing non-empty body").into_response();
        }
    }
    // Cap the untrusted text fields server-side before they reach a composed prompt.
    for c in comments {
        let over = |key: &str, max: usize| {
            c.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.chars().count() > max)
                .unwrap_or(false)
        };
        if over("body", FEEDBACK_BODY_MAX) || over("quote", FEEDBACK_QUOTE_MAX) {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
    }

    let request_id = format!("df-{}-{}", now_ms(), rand_suffix());
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state.app_handle.emit_or_log(
        "acp-docs-feedback-received",
        json!({
            "harnessId": query.harness,
            "docPath": normalized,
            "batchId": batch_id,
            "comments": comments,
            "requestId": request_id,
        }),
    );
    let reply = match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "retry" })),
            )
                .into_response();
        }
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "retry" })),
            )
                .into_response();
        }
    };
    if reply
        .get("accepted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Json(json!({ "status": "accepted" })).into_response();
    }
    (
        StatusCode::CONFLICT,
        Json(json!({ "status": "no-live-lane" })),
    )
        .into_response()
}

/// POST /doc-artifact?harness=<id>&path=<rel> — the docs browser asks the
/// harness's active lane to create a normal lane-authored HTML artifact from a
/// source markdown file (spec 174). The browser owns the default title; Rust
/// validates path/title and uses the same synchronous bus round-trip as docs
/// feedback. A 200 means the request entered the active lane's queue, NOT that
/// the artifact has been created yet.
async fn handle_doc_artifact(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Query(query): Query<DocQuery>,
    Json(body): Json<Value>,
) -> Response {
    let project_dir = match state.hook_server.docs_project_dir(&query.harness) {
        Some(dir) => dir,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let request = match validate_doc_artifact_request(&project_dir, &query.path, &body) {
        Ok(request) => request,
        Err(DocArtifactRequestError::NotFound) => return StatusCode::NOT_FOUND.into_response(),
        Err(DocArtifactRequestError::BadRequest(message)) => {
            return (StatusCode::BAD_REQUEST, message).into_response()
        }
        Err(DocArtifactRequestError::PayloadTooLarge) => {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response()
        }
    };

    let request_id = format!("da-{}-{}", now_ms(), rand_suffix());
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state.app_handle.emit_or_log(
        "acp-docs-artifact-requested",
        json!({
            "harnessId": query.harness,
            "docPath": request.normalized_path,
            "batchId": request.batch_id,
            "title": request.title,
            "requestId": request_id,
        }),
    );
    let reply = match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "retry" })),
            )
                .into_response();
        }
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "retry" })),
            )
                .into_response();
        }
    };
    doc_artifact_reply_response(&reply)
}

/// POST /artifact/feedback/:token — the browser submits a comment batch (spec
/// 149). Validates the token + caps, then runs the synchronous bus round-trip
/// (fresh request id → emit `acp-artifact-feedback-received` → await the
/// frontend's accept). A 200 means the batch entered the lane's feedback queue,
/// NOT that the lane acted on it. On bus timeout the browser may retry the same
/// `batchId` (the frontend de-dupes), so the failure is non-success, not a
/// silent drop.
async fn handle_artifact_feedback(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let info = match state.hook_server.lookup_feedback_token(&token) {
        FeedbackLookup::Unknown => return StatusCode::NOT_FOUND.into_response(),
        FeedbackLookup::Revoked => return StatusCode::GONE.into_response(),
        FeedbackLookup::Found(info) => info,
    };
    let batch_id = body.get("batchId").and_then(|v| v.as_str()).unwrap_or("");
    if batch_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "missing batchId").into_response();
    }
    let comments = body.get("comments").and_then(|v| v.as_array());
    let Some(comments) = comments else {
        return (StatusCode::BAD_REQUEST, "missing comments").into_response();
    };
    if comments.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty comments").into_response();
    }
    if comments.len() > FEEDBACK_COMMENTS_MAX {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    // Validate the required runtime shape BEFORE the bus round-trip. A malformed
    // comment (no string `body`, no `anchor` object) that passed only the cap
    // checks would later throw in the frontend prompt composer — after the batch
    // was queued, cleared, and its batchId marked seen — silently losing the
    // feedback and permanently de-duping every retry. Reject up front (400, no
    // emit) so the batchId is never poisoned.
    for c in comments {
        let body_ok = c
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !body_ok {
            return (StatusCode::BAD_REQUEST, "comment missing non-empty body").into_response();
        }
        if !c.get("anchor").map(|a| a.is_object()).unwrap_or(false) {
            return (StatusCode::BAD_REQUEST, "comment missing anchor object").into_response();
        }
    }
    // Cap untrusted field lengths server-side (defense-in-depth alongside the
    // scaffold's own caps) before the content ever reaches a composed prompt.
    for c in comments {
        let over = |key: &str, max: usize| {
            c.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.chars().count() > max)
                .unwrap_or(false)
        };
        if over("body", FEEDBACK_BODY_MAX)
            || over("quote", FEEDBACK_QUOTE_MAX)
            || c.get("anchor")
                .map(|a| {
                    a.get("outerHTML")
                        .and_then(|v| v.as_str())
                        .map(|s| s.chars().count() > FEEDBACK_OUTERHTML_MAX)
                        .unwrap_or(false)
                })
                .unwrap_or(false)
        {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
    }

    let request_id = format!("fb-{}-{}", now_ms(), rand_suffix());
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state.app_handle.emit_or_log(
        "acp-artifact-feedback-received",
        json!({
            "harnessId": info.harness_id,
            "laneLabel": info.lane_label,
            "artifactId": info.artifact_id,
            "artifactTitle": info.title,
            "batchId": batch_id,
            "comments": comments,
            "requestId": request_id,
        }),
    );
    let reply = match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            // Listener dropped without replying — retryable.
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "retry" })),
            )
                .into_response();
        }
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "retry" })),
            )
                .into_response();
        }
    };
    let accepted = reply
        .get("accepted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if accepted {
        return Json(json!({ "status": "accepted" })).into_response();
    }
    match reply.get("reason").and_then(|v| v.as_str()) {
        Some("revoked") => StatusCode::GONE.into_response(),
        _ => (
            StatusCode::CONFLICT,
            Json(json!({ "status": "no-live-lane" })),
        )
            .into_response(),
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
        "handoff_set" => handoff_set(&state.hook_server, harness_id, lane_label, arguments),
        "handoff_get" => handoff_get(&state.hook_server, harness_id, arguments),
        "handoff_list" => handoff_list(&state.hook_server, harness_id),
        "peer_send" => peer_send(state, harness_id, lane_label, arguments).await,
        "peer_list" => peer_list(state, harness_id).await,
        // spec 161: the four directive_* tools were removed to reclaim ~1,224
        // tokens/turn. Authoring is now the `#directive` harness command (the
        // agent edits acp-harness.toml with its own file tools); assignment stays
        // on the keyboard picker. Answer any stray cached call with guidance.
        "directive_list" | "directive_preview" | "directive_apply" | "directive_remove" => Err(
            "directive tools were removed (spec 161). To author a directive, the user runs the \
             `#directive <intent>` harness command, which lets you edit \
             ~/.config/krypton/acp-harness.toml with your normal file tools. To assign one, the \
             user opens the directive picker (Cmd+P → .)."
                .to_string(),
        ),
        "attention_flag" => attention_flag(state, harness_id, lane_label, arguments).await,
        "attention_resolve" => attention_resolve(state, harness_id, lane_label, arguments).await,
        "review_outcome" => review_outcome(state, harness_id, lane_label, arguments).await,
        "mark_review_priority" => {
            mark_review_priority(state, harness_id, lane_label, arguments).await
        }
        "artifact_new" => artifact_tool_new(state, harness_id, lane_label, arguments),
        "artifact_register" => artifact_tool_register(state, harness_id, lane_label, arguments),
        "artifact_cancel" => artifact_tool_cancel(state, harness_id, lane_label, arguments),
        "review_new" => review_tool_new(state, harness_id, lane_label, arguments),
        "review_register" => review_tool_register(state, harness_id, lane_label, arguments),
        "review_cancel" => review_tool_cancel(state, harness_id, lane_label, arguments),
        "issue_progress" => issue_progress(state, harness_id, lane_label, arguments).await,
        other => Err(format!("Unknown bus tool: {other}")),
    };

    let is_error = outcome.is_err();
    if !is_error && name == "handoff_set" {
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

#[derive(Debug, PartialEq, Eq)]
struct DocArtifactRequest {
    normalized_path: String,
    batch_id: String,
    title: String,
}

#[derive(Debug, PartialEq, Eq)]
enum DocArtifactRequestError {
    NotFound,
    BadRequest(&'static str),
    PayloadTooLarge,
}

fn validate_doc_artifact_request(
    project_dir: &str,
    raw_path: &str,
    body: &Value,
) -> Result<DocArtifactRequest, DocArtifactRequestError> {
    let normalized =
        normalize_relative_link(StdPath::new(""), raw_path).unwrap_or_else(|| raw_path.to_string());
    if validate_doc_path(StdPath::new(project_dir), &normalized, &["md"]).is_err() {
        return Err(DocArtifactRequestError::NotFound);
    }

    let batch_id = body.get("batchId").and_then(|v| v.as_str()).unwrap_or("");
    if batch_id.trim().is_empty() {
        return Err(DocArtifactRequestError::BadRequest("missing batchId"));
    }
    let title = body.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let title = title.trim();
    if title.is_empty() {
        return Err(DocArtifactRequestError::BadRequest("missing title"));
    }
    if title.chars().count() > ARTIFACT_TITLE_MAX {
        return Err(DocArtifactRequestError::PayloadTooLarge);
    }

    Ok(DocArtifactRequest {
        normalized_path: normalized,
        batch_id: batch_id.to_string(),
        title: title.to_string(),
    })
}

fn doc_artifact_reply_response(reply: &Value) -> Response {
    if reply
        .get("accepted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Json(json!({ "status": "accepted" })).into_response();
    }
    (
        StatusCode::CONFLICT,
        Json(json!({ "status": "no-live-lane" })),
    )
        .into_response()
}

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
    let auto_accept = arguments
        .get("auto_accept")
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
        "autoAccept": auto_accept,
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

/// attention_flag — a lane self-reports a decision needing human judgement
/// (spec 128/130). Validates the presence floor (traded_off non-empty,
/// uncertainty non-blank), then round-trips to the frontend: the coordinator
/// assembles the git blast-radius (diffstat), inserts the JudgementItem
/// into the demand queue, and replies with `{ item_id }`. Non-blocking — the lane
/// keeps working after it sees the id.
async fn attention_flag(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    let question = required_string(&arguments, "question")?;
    let chosen = required_string(&arguments, "chosen")?;
    let rationale = required_string(&arguments, "rationale")?;
    let uncertainty = required_string(&arguments, "uncertainty")?;
    let reversibility = required_string(&arguments, "reversibility")?;
    // traded_off: a non-empty array of non-blank strings.
    let traded_off: Vec<String> = arguments
        .get("traded_off")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if question.trim().is_empty() {
        return Err("question must be non-empty".to_string());
    }
    if chosen.trim().is_empty() {
        return Err("chosen must be non-empty".to_string());
    }
    // Presence floor (NOT a quality guard — see spec 128): the fields must exist,
    // forcing the agent to articulate what it gave up and what it is unsure of.
    if traded_off.is_empty() {
        return Err(
            "traded_off must be a non-empty array: list the options you rejected and why"
                .to_string(),
        );
    }
    if uncertainty.trim().is_empty() {
        return Err(
            "uncertainty must be non-blank: state what you are unsure of / what would change your mind"
                .to_string(),
        );
    }
    if !matches!(
        reversibility.as_str(),
        "reversible" | "costly" | "irreversible"
    ) {
        return Err("reversibility must be one of reversible | costly | irreversible".to_string());
    }

    let item_id = format!("jdg-{}-{}", now_ms(), rand_suffix());
    let payload = json!({
        "itemId": item_id,
        "fromLaneId": from_lane,
        "question": question,
        "chosen": chosen,
        "rationale": rationale,
        "tradedOff": traded_off,
        "uncertainty": uncertainty,
        "reversibility": reversibility,
        "sentAt": now_ms(),
        "harnessId": harness_id,
        "requestId": item_id,
    });
    let rx = state.hook_server.register_bus_reply(item_id.clone());
    state.app_handle.emit_or_log("acp-attention-flag", payload);
    let reply = match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            return Err("attention_flag: frontend coordinator did not respond".to_string());
        }
        Err(_) => {
            state.hook_server.drop_bus_reply(&item_id);
            return Err("attention_flag: frontend reply timed out".to_string());
        }
    };
    if reply
        .get("inserted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        Ok(json!({ "item_id": item_id }))
    } else {
        let reason = reply
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("flag_failed");
        Err(format!("attention_flag failed: {reason}"))
    }
}

/// attention_resolve — the lane self-resolves a previously-flagged item (demote
/// to the silent pile, never delete). A no-op if the item is already terminal
/// (the human's approve/redirect wins).
async fn attention_resolve(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    let item_id = required_string(&arguments, "item_id")?;
    if item_id.trim().is_empty() {
        return Err("item_id must be non-empty".to_string());
    }
    let note = arguments
        .get("note")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let request_id = format!("jres-{}-{}", now_ms(), rand_suffix());
    let payload = json!({
        "itemId": item_id,
        "fromLaneId": from_lane,
        "note": note,
        "harnessId": harness_id,
        "requestId": request_id,
        "sentAt": now_ms(),
    });
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state
        .app_handle
        .emit_or_log("acp-attention-resolve", payload);
    match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => {
            if value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                Ok(json!({ "ok": true }))
            } else {
                let reason = value
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("resolve_failed");
                Err(format!("attention_resolve failed: {reason}"))
            }
        }
        Ok(Err(_)) => Err("attention_resolve: frontend coordinator did not respond".to_string()),
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            Err("attention_resolve: frontend reply timed out".to_string())
        }
    }
}

/// review_outcome — the authoring (convening) lane self-reports a summary of a
/// completed #review round (spec 146). Summary-only: raw blocker/warning counts,
/// a reviewer count, and a subject label — no diff size, no transcript anchor,
/// no score. Round-trips to the frontend, which records the row in the review
/// quality matrix (in-memory, session-only) and replies `{ recorded }`.
async fn review_outcome(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    let subject_label = required_string(&arguments, "subject_label")?;
    if subject_label.trim().is_empty() {
        return Err("subject_label must be non-empty".to_string());
    }
    // Counts must be valid non-negative integers. A *missing* blocker/warning
    // means a clean round (0), but a *present-but-malformed* value (negative,
    // fractional, junk string) is rejected rather than coerced — coercing a
    // failed call into 0 would record a falsely-clean round and corrupt the only
    // observation data (spec 146 / design-review blocker). reviewer_count is
    // required and must be ≥ 1 (a review with no reviewers is meaningless).
    let blockers = parse_count_field(&arguments, "blockers")?.unwrap_or(0);
    let warnings = parse_count_field(&arguments, "warnings")?.unwrap_or(0);
    let reviewer_count = parse_count_field(&arguments, "reviewer_count")?.ok_or_else(|| {
        "reviewer_count is required (how many reviewers you fanned out to)".to_string()
    })?;
    if reviewer_count < 1 {
        return Err("reviewer_count must be at least 1".to_string());
    }
    let findings = parse_review_findings(&arguments)?;

    let request_id = format!("rvo-{}-{}", now_ms(), rand_suffix());
    let payload = build_review_outcome_payload(ReviewOutcomePayloadInput {
        from_lane,
        blockers,
        warnings,
        reviewer_count,
        subject_label: &subject_label,
        harness_id,
        request_id: &request_id,
        findings,
    });
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state.app_handle.emit_or_log("acp-review-outcome", payload);
    match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => {
            if value
                .get("recorded")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                Ok(json!({ "recorded": true }))
            } else {
                let reason = value
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("record_failed");
                Err(format!("review_outcome failed: {reason}"))
            }
        }
        Ok(Err(_)) => Err("review_outcome: frontend coordinator did not respond".to_string()),
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            Err("review_outcome: frontend reply timed out".to_string())
        }
    }
}

struct ReviewOutcomePayloadInput<'a> {
    from_lane: &'a str,
    blockers: u64,
    warnings: u64,
    reviewer_count: u64,
    subject_label: &'a str,
    harness_id: &'a str,
    request_id: &'a str,
    findings: Option<Vec<Value>>,
}

fn build_review_outcome_payload(input: ReviewOutcomePayloadInput<'_>) -> Value {
    let mut payload = json!({
        "fromLaneId": input.from_lane,
        "blockers": input.blockers,
        "warnings": input.warnings,
        "reviewerCount": input.reviewer_count,
        "subjectLabel": input.subject_label,
        "harnessId": input.harness_id,
        "requestId": input.request_id,
        "sentAt": now_ms(),
    });
    if let Some(findings) = input.findings {
        payload["findings"] = json!(findings);
    }
    payload
}

fn parse_review_findings(arguments: &Value) -> Result<Option<Vec<Value>>, String> {
    let Some(raw) = arguments.get("findings") else {
        return Ok(None);
    };
    let findings = raw
        .as_array()
        .ok_or_else(|| "findings must be an array when present".to_string())?;
    if findings.len() > MAX_REVIEW_FINDINGS {
        return Err(format!(
            "too many findings ({}); cap is {MAX_REVIEW_FINDINGS}",
            findings.len()
        ));
    }
    let mut parsed: Vec<Value> = Vec::with_capacity(findings.len());
    for (i, item) in findings.iter().enumerate() {
        let object = item
            .as_object()
            .ok_or_else(|| format!("findings[{i}] must be an object"))?;
        let file = object
            .get("file")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("findings[{i}].file must be a non-empty string"))?;
        let note = object
            .get("note")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("findings[{i}].note must be a non-empty string"))?;
        if note.contains('\n') || note.contains('\r') {
            return Err(format!("findings[{i}].note must be one line"));
        }
        let severity = object
            .get("severity")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("findings[{i}].severity is required"))?;
        if !matches!(severity, "blocking" | "non-blocking" | "suggestion") {
            return Err(format!(
                "findings[{i}].severity must be one of blocking | non-blocking | suggestion"
            ));
        }
        let mut finding = json!({
            "file": file,
            "severity": severity,
            "note": note,
        });
        if let Some(line) = object.get("line") {
            finding["line"] = json!(review_finding_line_value(line)
                .ok_or_else(|| format!("findings[{i}].line must be an integer >= 1"))?);
        }
        parsed.push(finding);
    }
    Ok(Some(parsed))
}

fn review_finding_line_value(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return (n >= 1).then_some(n);
    }
    if let Some(f) = value.as_f64() {
        if f >= 1.0 && f.fract() == 0.0 {
            return Some(f as u64);
        }
    }
    None
}

/// mark_review_priority — the authoring lane self-reports a per-change review
/// priority over the working diff it just produced (spec 160). It reports only
/// the non-default ranges (`high` / `routine`), anchored on the NEW side (the
/// lines it wrote). The latest call replaces the lane's prior report. Round-trips
/// to the frontend, which stores the report (keyed by the authoring lane) for the
/// Diff Window to pull on open / refresh, and replies `{ recorded }`. The Window
/// only ever folds or marks — never hides, never reorders — so a stale or wrong
/// range degrades to `normal`, never a missed change (ADR-0009).
async fn mark_review_priority(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    let raw = arguments
        .get("ranges")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            "ranges is required (an array of {file, lineStart, lineEnd, level})".to_string()
        })?;
    // Cap the payload — a report is a reading-order hint, not a per-line audit.
    // A pathological lane that flags thousands of one-line ranges should not be
    // able to balloon a frontend round-trip.
    if raw.len() > MAX_REVIEW_PRIORITY_RANGES {
        return Err(format!(
            "too many ranges ({}); cap is {MAX_REVIEW_PRIORITY_RANGES}",
            raw.len()
        ));
    }
    let mut ranges: Vec<Value> = Vec::with_capacity(raw.len());
    for (i, item) in raw.iter().enumerate() {
        let file = item
            .get("file")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("ranges[{i}].file must be a non-empty string"))?;
        let line_start = count_value(item.get("lineStart").unwrap_or(&Value::Null))
            .filter(|n| *n >= 1)
            .ok_or_else(|| format!("ranges[{i}].lineStart must be a positive integer"))?;
        let line_end = count_value(item.get("lineEnd").unwrap_or(&Value::Null))
            .filter(|n| *n >= 1)
            .ok_or_else(|| format!("ranges[{i}].lineEnd must be a positive integer"))?;
        if line_end < line_start {
            return Err(format!("ranges[{i}].lineEnd must be >= lineStart"));
        }
        let level = item.get("level").and_then(|v| v.as_str()).unwrap_or("");
        if level != "high" && level != "routine" {
            return Err(format!(
                "ranges[{i}].level must be 'high' or 'routine' (omit a range to leave it 'normal')"
            ));
        }
        let mut range = json!({
            "file": file,
            "lineStart": line_start,
            "lineEnd": line_end,
            "level": level,
        });
        if let Some(reason) = item
            .get("reason")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if reason.chars().count() > 240 {
                return Err(format!(
                    "ranges[{i}].reason must be 240 characters or fewer"
                ));
            }
            range["reason"] = json!(reason);
        }
        ranges.push(range);
    }

    let request_id = format!("rvp-{}-{}", now_ms(), rand_suffix());
    let payload = json!({
        "fromLaneId": from_lane,
        "ranges": ranges,
        "harnessId": harness_id,
        "requestId": request_id,
        "sentAt": now_ms(),
    });
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state.app_handle.emit_or_log("acp-review-priority", payload);
    match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => {
            if value
                .get("recorded")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                Ok(json!({ "recorded": true, "ranges": ranges.len() }))
            } else {
                let reason = value
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("record_failed");
                Err(format!("mark_review_priority failed: {reason}"))
            }
        }
        Ok(Err(_)) => Err("mark_review_priority: frontend coordinator did not respond".to_string()),
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            Err("mark_review_priority: frontend reply timed out".to_string())
        }
    }
}

/// issue_progress — the lane self-reports progress on the GitHub issue it is fixing
/// (spec 178). Mirrors the attention bus round-trip: it registers a pending reply,
/// emits `acp-issue-report` to the frontend (which maps the report onto the lane's
/// issue binding and refreshes the live status card), and awaits the frontend's
/// `{ ok, reason? }` ack with the shared bus timeout.
async fn issue_progress(
    state: &HookServerState,
    harness_id: &str,
    from_lane: &str,
    arguments: Value,
) -> Result<Value, String> {
    // The lane must say WHICH issue it is reporting on — the frontend resolves the
    // binding by this key, not by guessing the lane's most-recent dispatch (which
    // breaks when one lane is fixing more than one issue).
    let issue_key = required_string(&arguments, "issue_key")?;
    let issue_key = issue_key.trim().to_string();
    if issue_key.is_empty() {
        return Err(
            "issue_key is required (the owner/repo#123 of the issue you are fixing)".to_string(),
        );
    }
    let phase = required_string(&arguments, "phase")?;
    let phase = phase.trim().to_string();
    if !matches!(
        phase.as_str(),
        "investigating" | "fixing" | "testing" | "review" | "pr_opened" | "done" | "blocked"
    ) {
        return Err(
            "phase must be one of investigating | fixing | testing | review | pr_opened | done | blocked"
                .to_string(),
        );
    }
    let summary = arguments
        .get("summary")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let pr_url = arguments
        .get("pr_url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let request_id = format!("isr-{}-{}", now_ms(), rand_suffix());
    let mut payload = json!({
        "fromLaneId": from_lane,
        "issueKey": issue_key,
        "phase": phase,
        "harnessId": harness_id,
        "requestId": request_id,
        "sentAt": now_ms(),
    });
    if let Some(ref summary) = summary {
        payload["summary"] = json!(summary);
    }
    if let Some(ref pr_url) = pr_url {
        payload["prUrl"] = json!(pr_url);
    }
    let rx = state.hook_server.register_bus_reply(request_id.clone());
    state.app_handle.emit_or_log("acp-issue-report", payload);
    match tokio::time::timeout(BUS_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => {
            if value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                Ok(json!({ "ok": true }))
            } else {
                let reason = value
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("issue_progress_failed");
                Err(reason.to_string())
            }
        }
        Ok(Err(_)) => Err("issue_progress: frontend coordinator did not respond".to_string()),
        Err(_) => {
            state.hook_server.drop_bus_reply(&request_id);
            Err("issue_progress: frontend reply timed out".to_string())
        }
    }
}

/// Parse a count field that distinguishes *absent* (Ok(None) → caller defaults)
/// from *present-but-invalid* (Err → reject, never coerce to 0). A present value
/// must be a non-negative integer: a JSON unsigned int, an integer-valued float
/// (e.g. `2.0`), or a numeric string. Negative, fractional, or junk values error.
fn parse_count_field(arguments: &Value, key: &str) -> Result<Option<u64>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => count_value(v)
            .map(Some)
            .ok_or_else(|| format!("{key} must be a non-negative integer")),
    }
}

/// Interpret a JSON value as a non-negative integer count, or None if it is not
/// one (negative, fractional, or unparseable). Accepts unsigned ints,
/// integer-valued non-negative floats, and numeric strings.
fn count_value(v: &Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    if let Some(f) = v.as_f64() {
        if f >= 0.0 && f.fract() == 0.0 {
            return Some(f as u64);
        }
    }
    v.as_str().and_then(|s| s.trim().parse::<u64>().ok())
}

/// collect_git_state — run a few git commands in the lane's cwd and assemble a
/// JSON payload matching the frontend's `ReviewGitState` shape (spec 145, shared
/// by `#review` and attention triage). Never panics; on any failure returns
/// `{ hasGitRepo: false, ... empty }`.
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

/// Clamp a one-line headline to at most `max` Unicode code points, appending an
/// ellipsis when it had to be clipped. Counting by code points (not bytes)
/// matches `MEMORY_SUMMARY_MAX` and stays correct for multi-byte scripts such as
/// Thai. `handoff_set` uses this to truncate an over-long `summary` instead of
/// rejecting it: models cannot reliably self-count characters, so the old
/// instructive rejection just produced retry loops. The body lives in `detail`;
/// `summary` is only the scannable headline shown by `handoff_list`.
fn clamp_headline(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut clamped: String = s.chars().take(max.saturating_sub(1)).collect();
    clamped.push('\u{2026}');
    clamped
}

fn collect_git_state(cwd: Option<&str>) -> Value {
    // Bounds the payload (not process memory): the unified diff is capped, and
    // each untracked file contributes only a head excerpt.
    const REVIEW_DIFF_CAP: usize = 40_960;
    const DIFF_TRUNCATION_MARKER: &str = "\n…[diff truncated at payload cap]…\n";
    const UNTRACKED_HEAD_LINES: usize = 40;
    const UNTRACKED_HEAD_BYTES: usize = 4_096;
    const UNTRACKED_TOTAL_CAP: usize = 40_960;

    let cwd_path = match cwd {
        Some(c) if !c.is_empty() => StdPath::new(c).to_path_buf(),
        _ => {
            return empty_git_state(String::new());
        }
    };

    // Shared git primitives (spec 155) — same invocation/root/binary handling
    // as the Diff Window's `collect_working_diff`.
    let run = |args: &[&str]| -> Option<String> { crate::git::run_git(&cwd_path, args) };

    let repo_root = match crate::git::repo_root(&cwd_path) {
        Some(s) => s,
        None => return empty_git_state(cwd_path.to_string_lossy().to_string()),
    };

    // Unborn HEAD: a fresh repo with no commits. `rev-parse --is-inside-work-tree`
    // (and --show-toplevel) succeed, but `git diff HEAD` fails — so callers must
    // know to diff against the empty tree / report "no committed baseline".
    let is_unborn_head = run(&["rev-parse", "--verify", "HEAD"]).is_none();

    let porcelain = run(&["status", "--porcelain=v1"]).unwrap_or_default();

    // Diff base: HEAD for a normal repo; the empty-tree object when HEAD is
    // unborn. `git diff <base>` (one tree-ish) compares the WORKING tree against
    // that base, so it captures BOTH staged and unstaged edits — a
    // `git add`-then-edit file (porcelain `AM`) keeps its unstaged changes, which
    // a `--cached` diff would silently drop. The empty tree is DERIVED via
    // `git hash-object -t tree /dev/null` so it is correct for both SHA-1 and
    // SHA-256 repos; the SHA-1 constant is only a fallback (e.g. no `/dev/null`).
    // Keep --no-pager + --no-ext-diff + --no-textconv to avoid user diff machinery
    // (external drivers, textconv filters, pagers) stalling us.
    let base: String = if is_unborn_head {
        run(&["hash-object", "-t", "tree", "/dev/null"])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string())
    } else {
        "HEAD".to_string()
    };
    let numstat_raw =
        run(&["--no-pager", "diff", "--no-ext-diff", &base, "--numstat"]).unwrap_or_default();
    // A non-zero `git diff` is a real error, NOT "no changes" — and with
    // --no-ext-diff an external diff driver can't be the cause. Surface a sentinel
    // rather than coercing failure into an empty diff (which a populated diffstat
    // would then contradict). `run` returns None only on that genuine failure.
    let diff_raw = match run(&[
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        &base,
    ]) {
        Some(d) => d,
        None => "<git diff failed>".to_string(),
    };

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

    // Payload-cap the unified diff on a UTF-8 boundary, with the marker INSIDE
    // the cap so the whole `diff` string stays ≤ REVIEW_DIFF_CAP.
    let diff = if diff_raw.len() > REVIEW_DIFF_CAP {
        let budget = REVIEW_DIFF_CAP.saturating_sub(DIFF_TRUNCATION_MARKER.len());
        format!(
            "{}{}",
            safe_truncate(&diff_raw, budget),
            DIFF_TRUNCATION_MARKER
        )
    } else {
        diff_raw
    };

    let mut untracked_total: usize = 0;
    let mut untracked: Vec<Value> = Vec::new();
    for path in &untracked_paths {
        if untracked_total >= UNTRACKED_TOTAL_CAP {
            break;
        }
        let full = StdPath::new(&repo_root).join(path);
        // Read only the head bytes — never buffer an entire (possibly huge)
        // untracked file when we only show a 4 KB excerpt.
        let head = match std::fs::File::open(&full) {
            Ok(file) => {
                use std::io::Read;
                let mut bytes = Vec::new();
                match file
                    .take(UNTRACKED_HEAD_BYTES as u64)
                    .read_to_end(&mut bytes)
                {
                    Ok(_) => {
                        if crate::git::looks_binary(&bytes) {
                            "<binary>".to_string()
                        } else {
                            String::from_utf8_lossy(&bytes)
                                .lines()
                                .take(UNTRACKED_HEAD_LINES)
                                .collect::<Vec<_>>()
                                .join("\n")
                        }
                    }
                    Err(_) => "<unreadable>".to_string(),
                }
            }
            Err(_) => "<unreadable>".to_string(),
        };
        // Strict cap: stop before the returned payload would exceed the cap (each
        // head is ≤ UNTRACKED_HEAD_BYTES, so the first excerpt always fits).
        if !untracked.is_empty() && untracked_total.saturating_add(head.len()) > UNTRACKED_TOTAL_CAP
        {
            break;
        }
        untracked_total = untracked_total.saturating_add(head.len());
        untracked.push(json!({ "path": path, "head": head }));
    }

    json!({
        "hasGitRepo": true,
        "repoRoot": repo_root,
        "isUnbornHead": is_unborn_head,
        "diffstat": diffstat,
        "diff": diff,
        "untracked": untracked,
    })
}

fn empty_git_state(cwd: String) -> Value {
    json!({
        "hasGitRepo": false,
        "repoRoot": cwd,
        "isUnbornHead": false,
        "diffstat": [],
        "diff": "",
        "untracked": [],
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

/// Spec 149: an unguessable 128-bit feedback token, hex-encoded (path-safe).
/// This is the SOLE capability for the served artifact + its feedback endpoint,
/// so it uses the OS CSPRNG (not the time-based `rand_suffix`). On the
/// vanishingly rare CSPRNG failure, fall back to hashing time + a process
/// counter so a token is still issued (degraded entropy, never panics).
fn feedback_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut hasher = Sha256::new();
        hasher.update(nanos.to_le_bytes());
        hasher.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
        bytes.copy_from_slice(&hasher.finalize()[..16]);
    }
    let mut out = String::with_capacity(32);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn handoff_set(
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
    // `summary` is only a scannable headline — clip it server-side rather than
    // reject (models can't reliably self-count code points, especially in Thai).
    // `detail` carries the body, so an over-long body is a real mistake: reject.
    if !summary_empty && detail.chars().count() > MEMORY_DETAIL_MAX {
        return Err(format!("detail exceeds {MEMORY_DETAIL_MAX} characters"));
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
        summary: clamp_headline(summary.trim(), MEMORY_SUMMARY_MAX),
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

fn handoff_get(
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

fn handoff_list(hook_server: &Arc<HookServer>, harness_id: &str) -> Result<Value, String> {
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

/// spec 133 — `artifact_new`: allocate + issue path, emit a `pending` event so
/// the frontend opens the issued-path write auto-approval.
fn artifact_tool_new(
    state: &HookServerState,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let title = required_string(&arguments, "title")?;
    let value = state
        .hook_server
        .artifact_new(harness_id, lane_label, &title)?;
    state.app_handle.emit_or_log(
        "acp-harness-artifact",
        json!({
            "harnessId": harness_id,
            "laneLabel": lane_label,
            "id": value.get("id"),
            "path": value.get("path"),
            "tail": value.get("tail"),
            "title": value.get("title"),
            "state": "pending",
            "feedbackToken": value.get("feedbackToken"),
        }),
    );
    Ok(value)
}

/// spec 133 — `artifact_register`: validate + record size/hash, emit a
/// `registered` event (first call raises the card; a repeat refreshes it).
fn artifact_tool_register(
    state: &HookServerState,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let id = required_string(&arguments, "id")?;
    let value = state
        .hook_server
        .artifact_register(harness_id, lane_label, &id)?;
    state.app_handle.emit_or_log(
        "acp-harness-artifact",
        json!({
            "harnessId": harness_id,
            "laneLabel": lane_label,
            "id": value.get("id"),
            "path": value.get("path"),
            "tail": value.get("tail"),
            "title": value.get("title"),
            "size": value.get("size"),
            "hash": value.get("hash"),
            "state": "registered",
            "registered": value.get("registered"),
        }),
    );
    Ok(value)
}

/// spec 133 — `artifact_cancel`: drop a pending entry, emit a `cancelled` event
/// so the frontend closes the write grant.
fn artifact_tool_cancel(
    state: &HookServerState,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let id = required_string(&arguments, "id")?;
    let value = state
        .hook_server
        .artifact_cancel(harness_id, lane_label, &id)?;
    state.app_handle.emit_or_log(
        "acp-harness-artifact",
        json!({
            "harnessId": harness_id,
            "laneLabel": lane_label,
            "id": id,
            "state": "cancelled",
        }),
    );
    Ok(value)
}

/// spec 211 — `review_new`: allocate the durable bundle, emit a `pending` event
/// so the frontend opens issued-path write auto-approval over the whole bundle.
fn review_tool_new(
    state: &HookServerState,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let title = required_string(&arguments, "title")?;
    let subject = arguments
        .get("subject")
        .and_then(Value::as_str)
        .map(str::to_string);
    let value = state
        .hook_server
        .review_new(harness_id, lane_label, &title, subject.as_deref())?;
    state.app_handle.emit_or_log(
        "acp-harness-review",
        json!({
            "harnessId": harness_id,
            "laneLabel": lane_label,
            "id": value.get("id"),
            "slug": value.get("slug"),
            "dir": value.get("dir"),
            "path": value.get("path"),
            "tail": value.get("tail"),
            "title": value.get("title"),
            "state": "pending",
        }),
    );
    Ok(value)
}

/// spec 211 — `review_register`: validate + count blocks, emit a `registered`
/// event (first call raises the card; a repeat refreshes its counts).
fn review_tool_register(
    state: &HookServerState,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let id = required_string(&arguments, "id")?;
    let value = state
        .hook_server
        .review_register(harness_id, lane_label, &id)?;
    state.app_handle.emit_or_log(
        "acp-harness-review",
        json!({
            "harnessId": harness_id,
            "laneLabel": lane_label,
            "id": value.get("id"),
            "slug": value.get("slug"),
            "dir": value.get("dir"),
            "path": value.get("path"),
            "tail": value.get("tail"),
            "title": value.get("title"),
            "blocks": value.get("blocks"),
            "steps": value.get("steps"),
            "findings": value.get("findings"),
            "decisions": value.get("decisions"),
            "state": "registered",
            "registered": value.get("registered"),
        }),
    );
    Ok(value)
}

/// spec 211 — `review_cancel`: drop a pending entry, emit a `cancelled` event so
/// the frontend closes the write grant.
fn review_tool_cancel(
    state: &HookServerState,
    harness_id: &str,
    lane_label: &str,
    arguments: Value,
) -> Result<Value, String> {
    let id = required_string(&arguments, "id")?;
    let value = state
        .hook_server
        .review_cancel(harness_id, lane_label, &id)?;
    state.app_handle.emit_or_log(
        "acp-harness-review",
        json!({
            "harnessId": harness_id,
            "laneLabel": lane_label,
            "id": id,
            "state": "cancelled",
        }),
    );
    Ok(value)
}

fn bus_tool_descriptors() -> Value {
    let mut tools = json!([
        {
            "name": "handoff_set",
            "description": "Write your lane's single handoff document — the resume point a FUTURE session (or another lane picking up your work) reads to continue. Call it ONLY when the user asks you to hand off (typically the #handoff command) — never on your own initiative mid-task; your working state lives in your context, not here. You have one document; this overwrites its full contents (not append). Record what's done, current state, next steps, and open questions, and reference files/commits by path rather than pasting their contents (a path stays verifiable against the live repo; a pasted copy goes stale). 'summary' is a SHORT one-line headline; put all real content in 'detail'. Empty strings clear it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "One short headline only (a single sentence). Do NOT put the body here — anything past ~300 characters is clipped to a headline (never rejected). Use 'detail' for everything substantial."
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
            "name": "handoff_get",
            "description": "Read a lane's handoff document by lane label to resume its work (typically via the #resume command). Returns null if that lane has no handoff. You can read any lane's handoff but only write your own. Treat the contents as a possibly-stale snapshot: verify its claims against the live repo before acting on them.",
            "inputSchema": {
                "type": "object",
                "properties": { "lane": { "type": "string" } },
                "required": ["lane"]
            }
        },
        {
            "name": "handoff_list",
            "description": "List the lanes in this tab that have a saved handoff document, with each one's summary headline. Use it to find which lane's handoff to read back with handoff_get.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "peer_send",
            "description": "Send one message to another lane (peer review / consult). The target may be a sibling lane in this harness OR a lane in another open harness view — possibly working in a DIFFERENT repository (call peer_list first to see each peer's `cwd`). Addressing is the bare `displayName` either way (names are globally unique). A message can therefore cross a project trust boundary: do not assume a foreign peer shares your files or your confidentiality expectations — it operates in its own working directory and cannot see yours. Async — recipient processes it on its next idle turn. At most one outstanding message per target lane: wait for their reply (or cancel via #cancel) before peer_send to the same target again; a second send returns peer_in_flight. After calling this tool, end your turn; the reply (if any) arrives as a new user message. The original initiator of a pair owns the lifecycle: only the initiator may set `done:true` (as a closing ack after the reply, or as a one-shot fire-and-forget on the very first send). When replying to a peer who messaged you first, omit `done` — the harness will silently coerce it to false. Use only when the user explicitly asks you to ask, consult, or peer with another lane — never proactively.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to_lane": { "type": "string", "description": "Target lane display name (e.g., 'Claude-2'). Use the `displayName` shown by peer_list — works for both local and cross-harness peers." },
                    "message": { "type": "string" },
                    "done": { "type": "boolean", "default": false, "description": "Closes the conversation: recipient processes the message but will NOT reply. Reserved for the original initiator of the pair — either as a closing ack after receiving their reply, or as a one-shot fire-and-forget on the first send. Repliers must omit this field; the harness coerces replier-side `done:true` to false." },
                    "auto_accept": { "type": "boolean", "default": false, "description": "Let the recipient run the turn this message triggers autonomously: it auto-accepts every permission request EXCEPT high-risk/destructive commands (rm, dd, force-push, network/script/unparseable, …), which still prompt the human. The grant is visible (a `peer-auto` chip + a transcript line naming you) and lasts only that one turn. Honored ONLY for sibling lanes in this harness view AND only on a request/initiation send — a cross-harness peer's auto_accept is ignored (reported back in the result) and a reply-side auto_accept does not arm anything. Use only when the user authorized the delegated work to run without supervision." }
                },
                "required": ["to_lane", "message"]
            }
        },
        {
            "name": "peer_list",
            "description": "List live peer lanes. Returns `{ lanes, count }` where each lane has `laneId`, `displayName`, `backendId`, `status`, `modelName`, `inboxDepth`, and `activeDirective` (the lane-scope directive binding: `{ id, title, task, description, enabled }` or null). The list spans this harness AND every other open harness view: each entry also carries `local` (true for a sibling in this harness, false for a cross-harness peer) and `cwd` (that lane's working directory). A foreign peer may be in a DIFFERENT repository — read `cwd` to pick the right peer and to know which project a message would leave for. Use `activeDirective` to pick the lane whose role fits the job (e.g., a lane bound to a 'review' directive for review work). Pass `displayName` to peer_send as `to_lane` for local and foreign peers alike. Re-query rather than caching — lanes come and go.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "artifact_new",
            "description": "Create an HTML artifact the user opens in their browser, for views that beat prose: side-by-side comparisons, diagrams, annotated diffs, parameterized previews, dashboards. Use ONLY when the user asks for a visual/interactive artifact, or your active directive explicitly tells you to produce HTML artifacts for this task. Do NOT default to HTML for ordinary prose, plans, or answers, and do NOT volunteer unsolicited dashboards — those stay in your turn text. Returns `{ id, path, content_marker }`. The path points to a file that ALREADY EXISTS — a ready-made HTML scaffold with the default Binance dark styling and a light/auto toggle. Use your EDIT/patch tool (NOT a Write that recreates the file, and NOT a shell heredoc — both lose the styling or leak HTML into the transcript) to replace the placeholder inside `<main data-artifact-content>` with your content; keep the `<style id=\"krypton-artifact-base\">` block and the toggle. Write plain semantic HTML (headings, tables, `<pre><code>`, `<section class=\"ka-card\">`) — it is styled automatically; to override a default, add your own `<style>` AFTER the base block. NEVER use left accent borders (`border-left` rails) to color-code cards/callouts/steps — use a full border, a background tint, or heading/icon color instead; the scaffold strips left-only borders at runtime, so a rail will not render anyway. Then call artifact_register { id }. The artifact is a live file: keep editing it to iterate. Opening is always user-triggered; never auto-opens.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "maxLength": ARTIFACT_TITLE_MAX, "description": "Short title shown on the artifact card." }
                },
                "required": ["title"]
            }
        },
        {
            "name": "artifact_register",
            "description": "Register the HTML artifact you wrote at the path returned by artifact_new, raising its card in the transcript. Call this AFTER your file-write tool has finished writing the file. Returns `{ ok, id, size, hash }`. Idempotent on an already-registered id (re-stats and re-hashes to refresh the card after a live edit) — but you normally do not need to call it again, since the harness re-stats on every edit it observes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The artifact id returned by artifact_new." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "artifact_cancel",
            "description": "Abandon a still-pending artifact you created with artifact_new but decided not to register. Best-effort deletes the issued file and closes its write grant. Errors if the artifact was already registered (there is no retire in v1).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The artifact id returned by artifact_new." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "review_new",
            "description": "Compose a Review Board — a keyboard-navigable review DOCUMENT the user reads in the app, for EXPLAINING CODE to them: what a change does, how the pieces fit, what to read first. Returns `{ id, slug, dir, path }`; `path` is a `review.md` that ALREADY EXISTS (seeded with a frontmatter stamp) inside a durable bundle directory — EDIT it with your normal edit tool, then call review_register { id }. The document is ordinary Markdown plus typed fenced blocks: ```review:walkthrough (title + a `steps:` list of `- at: path:line` / `say: why it matters` — the reading order, and the spine of a good Board), ```review:finding (severity blocking|non-blocking|suggestion, title, optional file/line; prose after the fence explains it), ```review:decision (question + an `options:` list, optional 1-based `recommended:`), ```review:metrics (flat `label: value` rows), ```review:chart (kind bar|line|sparkline, optional title, `data:` map of label → number), ```review:svg (a static diagram), and a plain ```diff fence. EVERY Board must have an explanation spine: prose on what this is and how it works, plus a walkthrough when the subject spans more than one file. A Board that is only a findings list is a regression to plain turn text. Findings and decisions are OPTIONAL additions — zero findings is a perfectly good review ('here is what this code does, and it is sound'). Use it when the user asks you to explain, walk through, or review something, or to synthesize a #review. Do NOT compose one unsolicited, at every turn end, or after every edit — unwanted Boards are reviewer fatigue and clutter on disk. Write assets into `<dir>/assets/` if you need images. LANGUAGE: write everything the human reads — prose, `say:` text, finding titles and the prose under them, decision questions and options, metric and chart labels — in NATURAL THAI, the way a Thai engineer actually writes, NOT a word-for-word rendering of an English sentence (if a Thai phrase only makes sense next to the English it came from, it is the wrong phrase). Do NOT translate technical terms: API and type names, tool names, flags, file paths, identifiers, and established jargon (race, guard, fan-out, diff, permission, …) stay in English inside the Thai sentence. The machine-parsed parts stay English too, or the document mis-parses: the fence names (`review:walkthrough`, `review:finding`, …), the field keys (`title:`, `severity:`, `steps:`, `at:`, `say:`, `question:`, `options:`, `recommended:`, `kind:`, `data:`), and the severity values `blocking` / `non-blocking` / `suggestion`. The `title` argument is the ONE exception: keep it short and in English, because it becomes the bundle's directory name on disk.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "maxLength": REVIEW_TITLE_MAX, "description": "Short title shown on the card; also slugified into the bundle directory name." },
                    "subject": { "type": "string", "maxLength": REVIEW_SUBJECT_MAX, "description": "What is under review — a diff summary, a doc path, or the code you are explaining. Recorded in the bundle so it is self-describing later." }
                },
                "required": ["title"]
            }
        },
        {
            "name": "review_register",
            "description": "Register the Review Board you wrote at the path returned by review_new, raising its card in the transcript so the user can open it. Call this AFTER your file-write tool has finished. Returns `{ ok, id, slug, blocks, steps, findings, decisions }`. Idempotent on an already-registered id (re-reads and re-counts to refresh the card after you iterate on the document) — but you normally do not need to call it again, since the harness re-reads on every edit it observes. Errors if review.md is still empty.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The review id returned by review_new." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "review_cancel",
            "description": "Abandon a still-pending Review Board you created with review_new but decided not to register, and close its write grant. The bundle directory is removed only when you never wrote anything into it — a bundle holding real content is kept, because a review result is a record. Errors if the review was already registered.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The review id returned by review_new." }
                },
                "required": ["id"]
            }
        }
    ]);

    // spec 130: attention triage tools are default-on for every lane that gets
    // this harness-memory MCP server. Payload validation and frontend insertion
    // remain the meaningful guards.
    if let Value::Array(ref mut arr) = tools {
        for descriptor in attention_tool_descriptors() {
            arr.push(descriptor);
        }
    }
    tools
}

/// spec 128: descriptors for `attention_flag` / `attention_resolve`. Spec 134
/// reframed the `attention_flag` description: positive, recognizable fork
/// triggers lead, with a symmetric calibration ("letting a genuine fork pass
/// unflagged is as costly as over-flagging") replacing the old prohibition-heavy
/// "worse than not flagging" guard, which had driven the tool to near-zero use
/// (the ADR-0001 cognitive-surrender risk materializing). The "skip the 80%, one
/// per turn, never to cover yourself" guard is retained as a single calibrating
/// clause rather than the dominant theme.
fn attention_tool_descriptors() -> Vec<Value> {
    vec![
        json!({
            "name": "attention_flag",
            "description": "At the end of a turn where you hit a real fork, surface ONE decision the human would want to weigh in on — then keep working. This is non-blocking: you already proceeded with your best guess (`chosen`), and the flag lands in a ranked queue the human triages on their own schedule; it never pauses you or waits for a reply. You hit a real fork when: you picked among two or more genuinely viable approaches the user could reasonably decide differently on; you resolved a consequential ambiguity in their intent — one that changes the user-visible outcome, architecture, or workflow — by guessing; or you did something costly or hard to undo. Calibrate in both directions: both a silent genuine fork and a trivia flag degrade the queue, so flag the consequential forks but skip the routine, reversible, machine-verifiable 80% (passing tests, obvious refactors, trivially-undoable edits). Flag at most one per turn, and never flag just to cover yourself. `traded_off` (what you rejected and why) and `uncertainty` (what would change your mind) are mandatory and must be substantive. Returns `{ item_id }` so you can attention_resolve it if you later settle the question yourself.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The specific decision that needs human judgement, as a question." },
                    "chosen": { "type": "string", "description": "The best-guess option you already took and are proceeding with (non-blocking)." },
                    "rationale": { "type": "string", "description": "Why you chose that option." },
                    "traded_off": {
                        "type": "array",
                        "items": { "type": "string" },
                        "minItems": 1,
                        "description": "MANDATORY, non-empty. The options you rejected and why. Empty or hollow ('nothing significant') defeats the purpose."
                    },
                    "uncertainty": { "type": "string", "description": "MANDATORY, non-blank. What you are unsure of, and what evidence or instruction would change your mind." },
                    "reversibility": { "enum": ["reversible", "costly", "irreversible"], "description": "How hard the chosen path is to undo. Drives queue ranking — irreversible first." }
                },
                "required": ["question", "chosen", "rationale", "traded_off", "uncertainty", "reversibility"]
            }
        }),
        json!({
            "name": "attention_resolve",
            "description": "Self-resolve a judgement item you previously raised with attention_flag — use this when YOU later settle the question (e.g. the answer became obvious, or you reversed the decision yourself). It demotes the item out of the human's review queue into the silent pile; it is never deleted. No-op if the human already discharged it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "item_id": { "type": "string", "description": "The id returned by the earlier attention_flag call." },
                    "note": { "type": "string", "description": "Optional short note on how you resolved it." }
                },
                "required": ["item_id"]
            }
        }),
        json!({
            "name": "review_outcome",
            "description": "After you synthesize a #review round you convened (you fanned the subject out to reviewer lanes and aggregated their Blockers/Warnings), record a one-row summary of the outcome against your own work. This feeds the review quality matrix — a session-only, per-lane history the human inspects to observe whether a lane keeps producing problems across successive reviews. It is an OBSERVATION, NOT A SCORE: it stores only the raw counts, never a grade or ranking. Call it exactly once per review round, only for a real review you actually convened; never fabricate one. Counts are the combined totals across all reviewers. Optionally include findings for richer per-concern detail: each finding has file (repo-relative path), optional line (integer >= 1), severity (blocking | non-blocking | suggestion), and note (one-line concern).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "blockers": { "type": "integer", "minimum": 0, "description": "Total blockers reported across all reviewers this round (0 if none)." },
                    "warnings": { "type": "integer", "minimum": 0, "description": "Total warnings reported across all reviewers this round (0 if none)." },
                    "reviewer_count": { "type": "integer", "minimum": 1, "description": "How many reviewers you fanned the review out to." },
                    "subject_label": { "type": "string", "description": "Short tag for what was reviewed — a diff summary or the doc path." },
                    "findings": {
                        "type": "array",
                        "maxItems": MAX_REVIEW_FINDINGS,
                        "description": "Optional structured concerns from the review. Omit to preserve the legacy count-only outcome.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": { "type": "string", "description": "Repo-relative path for the concern; must be non-empty." },
                                "line": { "type": "integer", "minimum": 1, "description": "Optional 1-based line number for the concern." },
                                "severity": { "enum": ["blocking", "non-blocking", "suggestion"], "description": "Finding severity, separate from the 2-way blocker/warning counts." },
                                "note": { "type": "string", "description": "One-line human-readable concern; must be non-empty." }
                            },
                            "required": ["file", "severity", "note"]
                        }
                    }
                },
                "required": ["reviewer_count", "subject_label"]
            }
        }),
        json!({
            "name": "mark_review_priority",
            "description": "At the end of a turn in which you edited files, tell the human's Diff Window how to spend their reading attention on the diff you just produced. Report ONLY the non-default ranges: `high` for the core logic / interface / risk the user would want to read first, `routine` for mechanical churn (generated code, renames, import shuffles, formatting). Include a brief optional `reason` when it helps the human understand why a range was marked. Everything you DON'T report stays `normal` and renders in full — so a small, honest report is correct; do not annotate the whole diff. The Window only FOLDS `routine` hunks (always one keystroke from full) and MARKS + navigates to `high` ones — it never hides or reorders anything, so an over-broad `routine` label only costs the human reading time, never a missed change. Anchor each range on the NEW side (the post-change line numbers you just wrote). The latest call REPLACES your previous report for this working diff. Default-on; call it at most once per turn, only when you actually changed files. Silence is fine — it yields today's full, untriaged diff.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ranges": {
                        "type": "array",
                        "description": "The non-default priority ranges over the diff. Omit a region entirely to leave it 'normal'.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": { "type": "string", "description": "Repo-relative post-change path (the file's new name)." },
                                "lineStart": { "type": "integer", "minimum": 1, "description": "First new-side line of the range (inclusive)." },
                                "lineEnd": { "type": "integer", "minimum": 1, "description": "Last new-side line of the range (inclusive); >= lineStart." },
                                "level": { "enum": ["high", "routine"], "description": "'high' = read first; 'routine' = mechanical, fold by default. 'normal' is the unreported default." },
                                "reason": { "type": "string", "maxLength": 240, "description": "Optional short human-readable explanation for this priority range, shown in the Diff Window." }
                            },
                            "required": ["file", "lineStart", "lineEnd", "level"]
                        }
                    }
                },
                "required": ["ranges"]
            }
        }),
        json!({
            "name": "issue_progress",
            "description": "Report progress on the GitHub issue this lane is fixing. Updates the live status card shown on the issue page and in Krypton. Call it when your phase changes (e.g. you start fixing, open a PR, or finish). Always pass issue_key — the owner/repo#123 from your fix prompt — so the report lands on the right issue.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue_key": { "type": "string", "description": "Canonical id of the issue you are fixing, as owner/repo#123 — copy it verbatim from your fix prompt." },
                    "phase": { "enum": ["investigating", "fixing", "testing", "review", "pr_opened", "done", "blocked"], "description": "The current phase of the fix: investigating | fixing | testing | review | pr_opened | done | blocked." },
                    "summary": { "type": "string", "description": "Optional one-line, human-readable note on the current state." },
                    "pr_url": { "type": "string", "description": "Optional URL of the pull request you opened for this issue." }
                },
                "required": ["issue_key", "phase"]
            }
        }),
    ]
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

/// Sibling of [`get_persistence_path`] holding spec 178 issue↔lane bindings.
/// Lives in the same `acp-harness-memory` directory but in a `*.issue-bindings.json`
/// file, kept separate from the handoff-only `PersistedMemory` store.
fn get_issue_bindings_path(project_dir: &str) -> Option<PathBuf> {
    let base = get_persistence_path(project_dir)?;
    Some(base.with_extension("issue-bindings.json"))
}

/// spec 194: sibling of [`get_issue_bindings_path`] holding the harness's shared
/// working ticket (`ActiveWorkTicket`) in a `*.active-ticket.json` file.
fn get_active_ticket_path(project_dir: &str) -> Option<PathBuf> {
    let base = get_persistence_path(project_dir)?;
    Some(base.with_extension("active-ticket.json"))
}

/// spec 178: persist a harness's issue↔lane bindings to disk. The frontend
/// (state authority, ADR-0007) calls this on every binding mutation; the
/// `bindings` array is stored verbatim.
#[tauri::command]
pub fn acp_save_issue_bindings(
    harness_id: String,
    bindings: Value,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<(), String> {
    hook_server.save_issue_bindings(&harness_id, bindings)
}

/// spec 178: rehydrate a harness's persisted issue↔lane bindings from disk on
/// `register_harness`. Returns the stored bindings array (empty if none).
#[tauri::command]
pub fn acp_load_issue_bindings(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<Vec<Value>, String> {
    hook_server.load_issue_bindings(&harness_id)
}

/// spec 194: persist the harness's shared working ticket (`null` clears it).
/// The frontend (state authority, ADR-0007) calls this on every ticket mutation.
#[tauri::command]
pub fn acp_save_active_ticket(
    harness_id: String,
    ticket: Value,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<(), String> {
    hook_server.save_active_ticket(&harness_id, ticket)
}

/// spec 194: rehydrate the harness's persisted working ticket on
/// `register_harness`. Returns `Null` when none is stored.
#[tauri::command]
pub fn acp_load_active_ticket(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<Value, String> {
    hook_server.load_active_ticket(&harness_id)
}

/// spec 185: cache the built-in `#` command manifest for the `/commands`
/// reference page. The frontend pushes it once per harness register; the
/// content is compile-time data, so last write wins.
#[tauri::command]
pub fn acp_store_command_manifest(
    manifest: Value,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<(), String> {
    hook_server.store_command_manifest(manifest);
    Ok(())
}

// ─── Artifact path policy (spec 133) ────────────────────────────────────────

/// The artifact scratch root for a project: `<project>/.krypton/artifacts`.
/// Not canonicalized — the project dir itself may legitimately be a symlink
/// (e.g. `/tmp` on macOS); per-component symlink rejection happens in
/// [`validate_artifact_file`].
fn artifacts_root(project_dir: &str) -> Option<PathBuf> {
    let base = StdPath::new(project_dir);
    if base.as_os_str().is_empty() {
        return None;
    }
    Some(base.join(".krypton").join("artifacts"))
}

/// Full HTML text+attribute escape for the only interpolated scaffold value (the
/// title, which appears in `<title>` and the header). Escapes `'` too so the
/// helper stays safe if the token ever moves into an attribute (spec 134).
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Inverse of [`html_escape`] for the five entities it emits — used to recover a
/// rehydrated artifact's original `<title>` text (spec 173).
fn html_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// spec 173: extract the seq `<n>` from an `art-<n>-<hex>` artifact id stem, or
/// `None` if it isn't that shape (so stray files / the `.gitignore` are ignored
/// during rehydration).
fn parse_artifact_seq(id: &str) -> Option<u64> {
    let rest = id.strip_prefix("art-")?;
    let (seq, suffix) = rest.split_once('-')?;
    if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    seq.parse::<u64>().ok()
}

/// spec 173: pull the `<title>…</title>` text back out of a served artifact file
/// (it was html-escaped at `artifact_new`; unescape it for display).
fn parse_artifact_title(html: &str) -> Option<String> {
    let start = html.find("<title>")? + "<title>".len();
    let end = html[start..].find("</title>")? + start;
    let raw = html[start..end].trim();
    if raw.is_empty() {
        return None;
    }
    Some(html_unescape(raw))
}

/// spec 173: parse the baked feedback token out of
/// `window.__KRYPTON_FEEDBACK__ = { token: "…", url: … }`. The token is the
/// artifact's sole capability and MUST come from the file — the served page
/// POSTs with it — so it is never re-minted. `None` for an unreplaced
/// placeholder (`{{…}}`) or a malformed scaffold.
fn parse_feedback_token(html: &str) -> Option<String> {
    let anchor = html.find("__KRYPTON_FEEDBACK__")?;
    let after_key = html[anchor..].find("token:")? + anchor + "token:".len();
    let rest = html[after_key..].trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    let token = &rest[..end];
    if token.is_empty() || token.starts_with("{{") {
        return None;
    }
    Some(token.to_string())
}

/// spec 173: rebuild artifact entries from every `*/<lane>/<id>.html` under the
/// project's artifacts root. The on-disk harnessId subdir is ignored — each file
/// is re-homed under `live_harness_id` so its feedback token routes to a
/// currently-live lane exactly like a same-session artifact. Title + token are
/// parsed back out of the file; size/hash are recomputed. Returns the entry map
/// (keyed by id), the `(token, FeedbackToken)` pairs, and the max seq seen (to
/// keep new-id numbering monotone).
fn rehydrate_artifacts_from_disk(
    live_harness_id: &str,
    root: &StdPath,
) -> (
    HashMap<String, ArtifactEntry>,
    Vec<(String, FeedbackToken)>,
    u64,
) {
    let mut entries: HashMap<String, ArtifactEntry> = HashMap::new();
    let mut tokens: Vec<(String, FeedbackToken)> = Vec::new();
    let mut max_seq = 0u64;

    let Ok(harness_dirs) = std::fs::read_dir(root) else {
        return (entries, tokens, max_seq);
    };
    for harness_dir in harness_dirs.flatten() {
        let harness_path = harness_dir.path();
        if !harness_path.is_dir() {
            continue;
        }
        let harness_dir_name = harness_dir.file_name().to_string_lossy().to_string();
        let Ok(lane_dirs) = std::fs::read_dir(&harness_path) else {
            continue;
        };
        for lane_dir in lane_dirs.flatten() {
            let lane_path = lane_dir.path();
            if !lane_path.is_dir() {
                continue;
            }
            let lane_label = lane_dir.file_name().to_string_lossy().to_string();
            let Ok(files) = std::fs::read_dir(&lane_path) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("html") {
                    continue;
                }
                let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Some(seq) = parse_artifact_seq(id) else {
                    continue; // not an art-<n>-<hex> file — ignore strays
                };
                let Ok(bytes) = std::fs::read(&path) else {
                    continue;
                };
                let html = String::from_utf8_lossy(&bytes);
                let Some(token) = parse_feedback_token(&html) else {
                    log::debug!("rehydrate: skipping {} (no feedback token)", path.display());
                    continue;
                };
                let title = parse_artifact_title(&html).unwrap_or_else(|| id.to_string());
                let size = bytes.len() as u64;
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                let hash = format!("{:x}", hasher.finalize());
                let tail = format!(".krypton/artifacts/{harness_dir_name}/{lane_label}/{id}.html");
                let id = id.to_string();

                entries.insert(
                    id.clone(),
                    ArtifactEntry {
                        id: id.clone(),
                        lane_label: lane_label.clone(),
                        title,
                        path,
                        tail,
                        state: ArtifactState::RegisteredLive,
                        size,
                        hash,
                        feedback_token: token.clone(),
                    },
                );
                tokens.push((
                    token,
                    FeedbackToken {
                        harness_id: live_harness_id.to_string(),
                        lane_label: lane_label.clone(),
                        artifact_id: id,
                        revoked: false,
                    },
                ));
                max_seq = max_seq.max(seq);
            }
        }
    }
    (entries, tokens, max_seq)
}

fn docs_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    // Capture a leading `---`-delimited YAML block as a FrontMatter node so it is
    // NOT mis-parsed as a thematic break + setext heading. `format_html` emits
    // nothing for it; we extract and render it ourselves (render_front_matter).
    options.extension.front_matter_delimiter = Some("---".to_string());
    // Spec 171 rev 2: raw HTML embedded in a repo's markdown is rendered as live
    // HTML (the user explicitly opted out of the rev-1 escaping). This reverses
    // ADR-0010's sanitize-at-the-boundary stance — see that ADR for the accepted
    // XSS exposure over the token-free loopback surface.
    options.render.r#unsafe = true;
    options.render.escape = false;
    options
}

/// Walk `project_dir` (respecting `.gitignore`, skipping `.git/`) and collect
/// every `*.md` file under it as a FLAT list of project-relative paths,
/// **most-recently-modified first** — the flat index exists to surface what just
/// changed, and the filter box (not the ordering) is how a known file is found.
/// Files whose mtime is unreadable sort last; ties break by path so the order is
/// still deterministic.
fn collect_doc_files(project_dir: &StdPath) -> Vec<DocEntry> {
    let mut entries: Vec<DocEntry> = Vec::new();
    for entry in WalkBuilder::new(project_dir)
        .standard_filters(true)
        .build()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let is_markdown = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
        if !is_markdown {
            continue;
        }
        let Ok(rel) = path.strip_prefix(project_dir) else {
            continue;
        };
        let rel = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if rel.is_empty() {
            continue;
        }
        entries.push(DocEntry {
            rel,
            modified: entry.metadata().ok().and_then(|m| m.modified().ok()),
        });
    }
    entries.sort_by(|a, b| {
        // Newest first; missing mtimes (Reverse(None) sorts after Reverse(Some))
        // fall to the bottom rather than pretending to be the oldest file.
        Reverse(a.modified)
            .cmp(&Reverse(b.modified))
            .then_with(|| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()))
            .then_with(|| a.rel.cmp(&b.rel))
    });
    entries
}

/// Split a project-relative doc path into `(dir_prefix_with_trailing_slash,
/// file_name)`. The prefix renders muted so the flat list still reads as
/// "where + what" without any nesting. Root files get an empty prefix.
fn split_doc_rel(rel: &str) -> (&str, &str) {
    match rel.rfind('/') {
        Some(idx) => (&rel[..=idx], &rel[idx + 1..]),
        None => ("", rel),
    }
}

/// Header of the index: one pill per harness whose working dir has docs, the
/// active one highlighted. Rendered only when more than one harness is
/// available — with a single lane the flat list needs no chrome above it.
fn render_docs_harness_bar(
    harnesses: &[(String, usize)],
    selected_harness: &str,
    route: &str,
) -> String {
    if harnesses.len() < 2 {
        return String::new();
    }
    let mut out = String::from("<nav class=\"harness-bar\">");
    for (harness_id, count) in harnesses {
        out.push_str("<a class=\"harness-bar__pill");
        if harness_id == selected_harness {
            out.push_str(" is-active");
        }
        out.push_str("\" href=\"");
        out.push_str(route);
        out.push_str("?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("\">");
        out.push_str(&html_escape(harness_id));
        out.push_str("<span class=\"harness-bar__count\">");
        out.push_str(&count.to_string());
        out.push_str("</span></a>");
    }
    out.push_str("</nav>");
    out
}

/// One written day on disk (specs 223, 225).
///
/// `date` is the file stem, which IS the day — the file is named after the local
/// day it covers, so nothing has to be parsed out of the contents to sort or
/// label the index.
struct JournalNote {
    date: String,
    /// Project-relative path, always under `.krypton/journal/`.
    rel: String,
    /// True for a legacy `<date>.generated.md` sibling — the copy spec 223
    /// wrote when a hand-edited day already held the canonical name. Nothing
    /// produces one now, but days already on disk still carry it.
    generated_copy: bool,
    modified: Option<std::time::SystemTime>,
}

/// Collect rendered daily notes for one project, newest day first.
///
/// A plain `read_dir` rather than the `WalkBuilder` `collect_doc_files` uses:
/// `.krypton/` is both dot-prefixed and gitignored, so the standard filters
/// would drop every note — the same two filters that (correctly) keep the whole
/// directory out of the `/docs` index. This walk is scoped to one flat
/// directory we own, so opting out of them costs nothing.
fn collect_journal_notes(project_dir: &StdPath) -> Vec<JournalNote> {
    let dir = project_dir.join(".krypton").join("journal");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut notes: Vec<JournalNote> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".md") else {
            continue;
        };
        let (date, generated_copy) = match stem.strip_suffix(".generated") {
            Some(base) => (base.to_string(), true),
            None => (stem.to_string(), false),
        };
        notes.push(JournalNote {
            rel: format!(".krypton/journal/{name}"),
            date,
            generated_copy,
            modified: entry.metadata().ok().and_then(|m| m.modified().ok()),
        });
    }
    // Newest day first. The stem is `YYYY-MM-DD`, so a string sort IS a date
    // sort — no parsing, and a stray non-dated `.md` simply sorts to the end
    // instead of poisoning the order.
    notes.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then_with(|| a.generated_copy.cmp(&b.generated_copy))
    });
    notes
}

/// The `/journal` index: one row per written day, newest first, each opening the
/// EXISTING `/doc` reader. No new reader exists for days — they are ordinary
/// markdown under the project, and `/doc` already validates and renders any
/// `.md` under a harness working directory.
fn render_journal_list(harness_id: &str, notes: &[JournalNote]) -> String {
    if notes.is_empty() {
        return "<p class=\"welcome\">No daily notes yet. Run <code>#daily</code> in a lane, or press <code>Leader J</code>, to render one for today.</p>"
            .to_string();
    }

    let mut out = String::from("<div class=\"docs-filter\"><input class=\"docs-filter__input\" id=\"docs-filter\" type=\"search\" placeholder=\"filter days — type to narrow, ↑↓ to move, enter to open\" autocomplete=\"off\" autocorrect=\"off\" spellcheck=\"false\" autofocus><span class=\"docs-filter__count\" id=\"docs-count\">");
    out.push_str(&notes.len().to_string());
    out.push_str(" days</span></div>");

    out.push_str("<ul class=\"browser\" id=\"docs-list\">");
    for note in notes {
        out.push_str("<li class=\"browser__item browser__item--file\" data-path=\"");
        out.push_str(&html_escape(&note.date.to_lowercase()));
        out.push_str("\"><a target=\"_blank\" rel=\"noopener\" href=\"/doc?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("&amp;path=");
        out.push_str(&url_encode(&note.rel));
        out.push_str("\"><span class=\"browser__icon\">◆</span><span class=\"browser__name\">");
        out.push_str(&html_escape(&note.date));
        if note.generated_copy {
            // The canonical name is a note the human edited; say which file this
            // row actually opens rather than showing two identical-looking days.
            out.push_str("<span class=\"browser__dir\"> · generated copy</span>");
        }
        out.push_str("</span>");
        if let Some((ms, label)) = note.modified.and_then(format_doc_mtime) {
            out.push_str("<time class=\"browser__date\" data-ts=\"");
            out.push_str(&ms.to_string());
            out.push_str("\">");
            out.push_str(&html_escape(&label));
            out.push_str("</time>");
        }
        out.push_str("</a></li>");
    }
    out.push_str("</ul>");
    out.push_str(
        "<p class=\"browser__empty\" id=\"docs-empty\" hidden>No day matches that filter.</p>",
    );
    out
}

/// The index itself: a filter box plus EVERY `.md` file in the harness working
/// dir as one flat list of full relative paths (each opens `/doc` in a new tab).
/// `data-path` carries the lowercased path the page script filters on; the
/// server does no filtering, so the list stays a single cacheless render.
fn render_docs_list(harness_id: &str, entries: &[DocEntry]) -> String {
    if entries.is_empty() {
        return "<p class=\"welcome\">No markdown files under this working directory.</p>"
            .to_string();
    }

    let mut out = String::from("<div class=\"docs-filter\"><input class=\"docs-filter__input\" id=\"docs-filter\" type=\"search\" placeholder=\"filter paths — type to narrow, ↑↓ to move, enter to open\" autocomplete=\"off\" autocorrect=\"off\" spellcheck=\"false\" autofocus><span class=\"docs-filter__count\" id=\"docs-count\">");
    out.push_str(&entries.len().to_string());
    out.push_str(" files</span></div>");

    out.push_str("<ul class=\"browser\" id=\"docs-list\">");
    for entry in entries {
        let (dir, name) = split_doc_rel(&entry.rel);
        out.push_str("<li class=\"browser__item browser__item--file\" data-path=\"");
        out.push_str(&html_escape(&entry.rel.to_lowercase()));
        out.push_str("\"><a target=\"_blank\" rel=\"noopener\" href=\"/doc?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("&amp;path=");
        out.push_str(&url_encode(&entry.rel));
        out.push_str("\"><span class=\"browser__icon\">◆</span><span class=\"browser__name\">");
        if !dir.is_empty() {
            out.push_str("<span class=\"browser__dir\">");
            out.push_str(&html_escape(dir));
            out.push_str("</span>");
        }
        out.push_str(&html_escape(name));
        out.push_str("</span>");
        if let Some((ms, label)) = entry.modified.and_then(format_doc_mtime) {
            out.push_str("<time class=\"browser__date\" data-ts=\"");
            out.push_str(&ms.to_string());
            out.push_str("\">");
            out.push_str(&html_escape(&label));
            out.push_str("</time>");
        }
        out.push_str("</a></li>");
    }
    out.push_str("</ul>");
    out.push_str(
        "<p class=\"browser__empty\" id=\"docs-empty\" hidden>No path matches that filter.</p>",
    );
    out
}

/// Format a file mtime for the docs browser. Returns `(epoch_ms, utc_label)`:
/// the millis feed a tiny client script that localises the label, and the UTC
/// `YYYY-MM-DD HH:MM` text is the no-JS fallback. Pure (no chrono dependency).
fn format_doc_mtime(modified: SystemTime) -> Option<(i64, String)> {
    let dur = modified.duration_since(UNIX_EPOCH).ok()?;
    let secs = dur.as_secs() as i64;
    let ms = dur.as_millis() as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    Some((
        ms,
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}"),
    ))
}

/// Days since the Unix epoch → `(year, month, day)`, proleptic Gregorian, UTC
/// (Howard Hinnant's `civil_from_days`).
///
/// `pub(crate)` so the usage log (spec 214) can name its day files with the
/// same calendar this module already uses, rather than carrying a second copy.
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (year + i64::from(month <= 2), month, day)
}

// ─── Issue Analysis Viewer (spec 192) ───────────────────────────────────────

/// The analysis-bundle root for a project: `<project>/.krypton/analyses`. Sibling
/// of `artifacts_root`. Gitignored working knowledge — the docs walker skips it,
/// so this surface reads it directly.
fn analyses_root(project_dir: &str) -> Option<PathBuf> {
    let base = StdPath::new(project_dir);
    if base.as_os_str().is_empty() {
        return None;
    }
    Some(base.join(".krypton").join("analyses"))
}

/// A non-`.md` file in an analysis bundle (a downloaded issue resource).
#[derive(Debug)]
struct AnalysisAsset {
    rel: String, // project-relative path
    size: u64,   // bytes, for the attachment strip label
}

/// One issue's analysis bundle discovered on disk under
/// `.krypton/analyses/<owner>/<repo>/<number>/`.
#[derive(Debug)]
struct AnalysisBundle {
    issue_key: String, // "owner/repo#123", for display + GitHub link
    owner: String,
    repo: String,
    number: String,
    md_files: Vec<String>, // project-relative paths, ordered (root-cause, fix-plan, rest)
    assets: Vec<AnalysisAsset>, // non-.md files (downloaded resources)
    modified: Option<SystemTime>,
}

/// Order within a bundle: `root-cause.md`, then `fix-plan.md`, then the rest.
fn analysis_md_rank(name: &str) -> u8 {
    match name.to_ascii_lowercase().as_str() {
        "root-cause.md" => 0,
        "fix-plan.md" => 1,
        _ => 2,
    }
}

/// Numeric key for ordering issues newest-first; non-numeric folder names sort last.
fn issue_number_sort_key(number: &str) -> u64 {
    number.parse::<u64>().unwrap_or(0)
}

/// Walk `<project>/.krypton/analyses/<owner>/<repo>/<number>/` (unfiltered — the
/// dir is gitignored, so `build_docs_tree` never sees it) and return one bundle
/// per numbered leaf holding at least one file. Only exact 3-level leaves are
/// treated as bundles. Ordered repo asc, then issue number desc (newest first).
fn discover_analysis_bundles(project_dir: &str) -> Vec<AnalysisBundle> {
    let Some(root) = analyses_root(project_dir) else {
        return Vec::new();
    };
    let mut bundles: Vec<AnalysisBundle> = Vec::new();
    let Ok(owners) = std::fs::read_dir(&root) else {
        return bundles;
    };
    for owner_entry in owners.filter_map(Result::ok) {
        if !owner_entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let owner = owner_entry.file_name().to_string_lossy().to_string();
        let Ok(repos) = std::fs::read_dir(owner_entry.path()) else {
            continue;
        };
        for repo_entry in repos.filter_map(Result::ok) {
            if !repo_entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let repo = repo_entry.file_name().to_string_lossy().to_string();
            let Ok(numbers) = std::fs::read_dir(repo_entry.path()) else {
                continue;
            };
            for num_entry in numbers.filter_map(Result::ok) {
                if !num_entry.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let number = num_entry.file_name().to_string_lossy().to_string();
                let Ok(files) = std::fs::read_dir(num_entry.path()) else {
                    continue;
                };
                let mut md_named: Vec<String> = Vec::new();
                let mut assets: Vec<AnalysisAsset> = Vec::new();
                let mut modified: Option<SystemTime> = None;
                for file in files.filter_map(Result::ok) {
                    if !file.file_type().is_ok_and(|t| t.is_file()) {
                        continue;
                    }
                    let name = file.file_name().to_string_lossy().to_string();
                    let meta = file.metadata().ok();
                    if let Some(mt) = meta.as_ref().and_then(|m| m.modified().ok()) {
                        modified = Some(modified.map_or(mt, |cur| cur.max(mt)));
                    }
                    let is_md = StdPath::new(&name)
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
                    if is_md {
                        md_named.push(name);
                    } else {
                        assets.push(AnalysisAsset {
                            rel: format!(".krypton/analyses/{owner}/{repo}/{number}/{name}"),
                            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        });
                    }
                }
                if md_named.is_empty() && assets.is_empty() {
                    continue;
                }
                md_named
                    .sort_by(|a, b| analysis_md_rank(a).cmp(&analysis_md_rank(b)).then(a.cmp(b)));
                let md_files = md_named
                    .into_iter()
                    .map(|name| format!(".krypton/analyses/{owner}/{repo}/{number}/{name}"))
                    .collect();
                assets.sort_by(|a, b| a.rel.cmp(&b.rel));
                bundles.push(AnalysisBundle {
                    issue_key: format!("{owner}/{repo}#{number}"),
                    owner: owner.clone(),
                    repo: repo.clone(),
                    number,
                    md_files,
                    assets,
                    modified,
                });
            }
        }
    }
    bundles.sort_by(|a, b| {
        a.owner
            .cmp(&b.owner)
            .then_with(|| a.repo.cmp(&b.repo))
            .then_with(|| issue_number_sort_key(&b.number).cmp(&issue_number_sort_key(&a.number)))
            // Deterministic tiebreak for non-numeric folder names (both key to 0).
            .then_with(|| a.number.cmp(&b.number))
    });
    bundles
}

fn render_analyses_page(title: &str, tree: Option<&str>, content: &str) -> Response {
    let escaped_title = html_escape(title);
    let nav = match tree {
        Some(tree) => format!("<nav class=\"tree-pane\">{tree}</nav>"),
        None => String::new(),
    };
    let html = ANALYSES_HTML
        .replace("<!--ANALYSES_TITLE-->", &escaped_title)
        .replace("<nav class=\"tree-pane\"><!--ANALYSES_TREE--></nav>", &nav)
        .replace(
            "<article class=\"doc\"><!--ANALYSES_CONTENT--></article>",
            &format!("<article class=\"doc\">{content}</article>"),
        );
    html_response(html)
}

/// Sidebar: every harness with bundles, grouped by `owner/repo`, each issue a
/// link to `/analysis`. The current issue (bundle page) gets `is-active`.
fn render_analyses_nav(
    per: &[(String, String, Vec<AnalysisBundle>)],
    sel_harness: &str,
    sel_issue: &str,
) -> String {
    let multi = per.iter().filter(|(_, _, b)| !b.is_empty()).count() > 1;
    let mut out = String::from("<ul class=\"tree\">");
    for (harness_id, _project_dir, bundles) in per {
        if bundles.is_empty() {
            continue;
        }
        let mut cur_repo = String::new();
        for bundle in bundles {
            let repo_full = format!("{}/{}", bundle.owner, bundle.repo);
            if repo_full != cur_repo {
                if !cur_repo.is_empty() {
                    out.push_str("</ul></li>");
                }
                cur_repo = repo_full.clone();
                let label = if multi {
                    format!("{harness_id} · {repo_full}")
                } else {
                    repo_full.clone()
                };
                out.push_str("<li class=\"tree-group\"><div class=\"tree-group__label\">");
                out.push_str(&html_escape(&label));
                out.push_str("</div><ul class=\"tree\">");
            }
            let issue_ref = format!("{}/{}/{}", bundle.owner, bundle.repo, bundle.number);
            let active = harness_id == sel_harness && issue_ref == sel_issue;
            out.push_str("<li class=\"tree-file\"><a");
            if active {
                out.push_str(" class=\"is-active\"");
            }
            out.push_str(" href=\"/analysis?harness=");
            out.push_str(&url_encode(harness_id));
            out.push_str("&amp;issue=");
            out.push_str(&url_encode(&issue_ref));
            out.push_str("\">#");
            out.push_str(&html_escape(&bundle.number));
            out.push_str(" <span class=\"tree-file__count\">");
            out.push_str(&html_escape(&analysis_count_label(bundle.md_files.len())));
            out.push_str("</span></a></li>");
        }
        if !cur_repo.is_empty() {
            out.push_str("</ul></li>");
        }
    }
    out.push_str("</ul>");
    out
}

/// Right pane of `/analyses`: one selected harness's bundles as rows grouped by
/// repo, each linking to its `/analysis` page with a GitHub deep link.
fn render_analyses_index(harness_id: &str, bundles: &[AnalysisBundle]) -> String {
    if bundles.is_empty() {
        return "<p class=\"welcome\">ยังไม่มีบทวิเคราะห์ issue สำหรับเลนนี้ — รัน #analyze-github-issue ในเลนเพื่อสร้างบทวิเคราะห์</p>".to_string();
    }
    let mut out = String::from("<ul class=\"analyses-index\">");
    let mut cur_repo = String::new();
    for bundle in bundles {
        let repo_full = format!("{}/{}", bundle.owner, bundle.repo);
        if repo_full != cur_repo {
            cur_repo = repo_full.clone();
            out.push_str("<li class=\"ai-group\">");
            out.push_str(&html_escape(&repo_full));
            out.push_str("</li>");
        }
        let issue_ref = format!("{}/{}/{}", bundle.owner, bundle.repo, bundle.number);
        out.push_str("<li class=\"ai-row\"><a class=\"ai-row__main\" href=\"/analysis?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("&amp;issue=");
        out.push_str(&url_encode(&issue_ref));
        out.push_str("\"><span class=\"ai-row__key\">");
        out.push_str(&html_escape(&bundle.issue_key));
        out.push_str("</span><span class=\"ai-row__meta\">");
        out.push_str(&html_escape(&analysis_count_label(bundle.md_files.len())));
        if !bundle.assets.is_empty() {
            out.push_str(&format!(" · {} ไฟล์แนบ", bundle.assets.len()));
        }
        if let Some((ms, label)) = bundle.modified.and_then(format_doc_mtime) {
            out.push_str(" · <time class=\"ai-date\" data-ts=\"");
            out.push_str(&ms.to_string());
            out.push_str("\">");
            out.push_str(&html_escape(&label));
            out.push_str("</time>");
        }
        out.push_str(
            "</span></a><a class=\"ai-gh\" target=\"_blank\" rel=\"noopener noreferrer\" href=\"",
        );
        out.push_str(&html_escape(&format!(
            "https://github.com/{}/{}/issues/{}",
            bundle.owner, bundle.repo, bundle.number
        )));
        out.push_str("\">เปิดใน GitHub ↗</a></li>");
    }
    out.push_str("</ul>");
    out
}

fn analysis_count_label(n: usize) -> String {
    format!("{n} การวิเคราะห์")
}

/// Does this bundle correspond to the `owner/repo/number` slug from the query?
fn bundle_matches_issue(bundle: &AnalysisBundle, issue_ref: &str) -> bool {
    format!("{}/{}/{}", bundle.owner, bundle.repo, bundle.number) == issue_ref
}

/// Human-readable byte size for the attachment strip (B / KB / MB).
fn human_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{} KB", bytes.div_ceil(KB))
    } else {
        format!("{bytes} B")
    }
}

/// Build one issue's bundle page: a file strip listing every `.md` in the bundle
/// (shown when there is more than one), the selected file rendered below it, then
/// an attachment strip (images inline, other files as name + size). `sel_file` is
/// the project-relative path of the `.md` to render — the caller resolves it from
/// the `file` query param (`None` only when the bundle has no `.md` at all).
/// `bundle` is already discovered; `project_dir` is its harness's working dir
/// (the selected `.md` is re-validated with `validate_doc_path`).
fn render_analysis_bundle(
    project_dir: &str,
    harness_id: &str,
    bundle: &AnalysisBundle,
    sel_file: Option<&str>,
) -> String {
    let cwd = StdPath::new(project_dir);
    let mut content = String::new();
    if bundle.md_files.len() > 1 {
        let issue_ref = format!("{}/{}/{}", bundle.owner, bundle.repo, bundle.number);
        content.push_str("<nav class=\"file-strip\">");
        for rel in &bundle.md_files {
            let name = rel.rsplit('/').next().unwrap_or(rel);
            content.push_str("<a");
            if Some(rel.as_str()) == sel_file {
                content.push_str(" class=\"is-active\"");
            }
            content.push_str(" href=\"/analysis?harness=");
            content.push_str(&url_encode(harness_id));
            content.push_str("&amp;issue=");
            content.push_str(&url_encode(&issue_ref));
            content.push_str("&amp;file=");
            content.push_str(&url_encode(name));
            content.push_str("\">");
            content.push_str(&html_escape(name));
            content.push_str("</a>");
        }
        content.push_str("</nav>");
    }
    let mut rendered_doc = false;
    if let Some(rel) = sel_file {
        if let Ok(path) = validate_doc_path(cwd, rel, &["md"]) {
            if let Ok(source) = std::fs::read_to_string(&path) {
                let name = rel.rsplit('/').next().unwrap_or(rel);
                content.push_str(
                    "<section class=\"analysis-file\"><div class=\"analysis-file__name\">",
                );
                content.push_str(&html_escape(name));
                content.push_str("</div>");
                content.push_str(&render_markdown_doc(
                    &source,
                    harness_id,
                    rel,
                    "/analysis-asset",
                ));
                content.push_str("</section>");
                rendered_doc = true;
            }
        }
    }
    if !rendered_doc {
        content.push_str("<p class=\"welcome\">ยังไม่มีไฟล์วิเคราะห์ในโฟลเดอร์นี้ — มีเฉพาะไฟล์แนบ</p>");
    }
    if !bundle.assets.is_empty() {
        content.push_str(
            "<section class=\"attachments\"><h3>ไฟล์แนบจาก issue</h3><div class=\"attachments__grid\">",
        );
        for asset in &bundle.assets {
            let name = asset.rel.rsplit('/').next().unwrap_or(&asset.rel);
            let is_img = StdPath::new(name)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .is_some_and(|e| {
                    matches!(e.as_str(), "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp")
                });
            if is_img {
                content.push_str(
                    "<figure class=\"att\"><img loading=\"lazy\" src=\"/analysis-asset?harness=",
                );
                content.push_str(&url_encode(harness_id));
                content.push_str("&amp;path=");
                content.push_str(&url_encode(&asset.rel));
                content.push_str("\" alt=\"");
                content.push_str(&html_escape(name));
                content.push_str("\"><figcaption>");
                content.push_str(&html_escape(name));
                content.push_str("</figcaption></figure>");
            } else {
                content.push_str("<div class=\"att att--file\"><span class=\"att__name\">◆ ");
                content.push_str(&html_escape(name));
                content.push_str(" · ");
                content.push_str(&html_escape(&human_size(asset.size)));
                content.push_str("</span></div>");
            }
        }
        content.push_str("</div></section>");
    }
    content
}

// ─── Review Board bundles (spec 211) ────────────────────────────────────────
// Durable, subject-keyed bundles under `.krypton/reviews/<date>-<slug>/`, the
// same convention as spec 191's analysis bundles and for the same reason: a
// directory walk finds them after a restart, where a session registry cannot.

/// The review-bundle root for a project: `<project>/.krypton/reviews`. Sibling of
/// `artifacts_root` / `analyses_root`. Gitignored working knowledge — the docs
/// walker skips it, so the `/reviews` surface reads it directly.
fn reviews_root(project_dir: &str) -> Option<PathBuf> {
    let base = StdPath::new(project_dir);
    if base.as_os_str().is_empty() {
        return None;
    }
    Some(base.join(".krypton").join("reviews"))
}

/// `*`-ignore the review root the same way the artifact root is handled, so a
/// bundle never shows up in the user's `git status`.
fn ensure_reviews_gitignore(root: &StdPath) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, "*\n!.gitignore\n")?;
    }
    Ok(())
}

/// Write a file atomically (temp + rename) so an interrupted write never leaves a
/// truncated document. Shared by the seeded `review.md` and `response.md`.
fn write_file_atomic(path: &StdPath, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    if let Err(e) = std::fs::write(&tmp, contents) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Quote a value for the seeded YAML frontmatter. JSON string escaping, for the
/// same reason the frontend uses it: a title containing `:` or a newline must not
/// be able to break the block it lives in.
fn yaml_scalar(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`. Pure (no chrono dependency),
/// built on the same `civil_from_days` the docs mtime formatter uses.
fn now_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let tod = secs.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Today's UTC date as `YYYY-MM-DD` — the sortable prefix of a bundle slug.
fn today_ymd() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Slugify a review title into a directory-safe, human-meaningful component:
/// lowercase, ASCII alphanumerics kept, everything else collapsed to a single
/// `-`. Non-ASCII titles legitimately reduce to nothing, so the caller falls
/// back to `review` rather than producing an empty path component.
fn review_slug(title: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
            if out.len() >= REVIEW_SLUG_MAX {
                break;
            }
        } else {
            pending_dash = true;
        }
    }
    if out.is_empty() {
        "review".to_string()
    } else {
        out
    }
}

/// Create `<root>/<today>-<slug>/`, appending `-2`, `-3`… on a same-day title
/// collision. Uses `create_dir` (not `create_dir_all`) on the leaf so the
/// collision check is the filesystem's own atomic create, not a racy `exists()`.
fn allocate_review_dir(root: &StdPath, title: &str) -> std::io::Result<(String, PathBuf)> {
    let base = format!("{}-{}", today_ymd(), review_slug(title));
    for attempt in 0..=REVIEW_SLUG_COLLISION_MAX {
        let slug = if attempt == 0 {
            base.clone()
        } else {
            format!("{base}-{}", attempt + 1)
        };
        let dir = root.join(&slug);
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok((slug, dir)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("more than {REVIEW_SLUG_COLLISION_MAX} bundles share this title today"),
    ))
}

/// Does this bundle directory contain only the one named file? Used to decide
/// whether a cancelled draft can be reclaimed without deleting real work.
fn bundle_has_only(dir: &StdPath, name: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.filter_map(Result::ok) {
        if entry.file_name().to_string_lossy() != name {
            return false;
        }
    }
    true
}

/// Validate the issued `review.md` at register/refresh time and return its text.
/// Rejects symlinks in any path component, hardlinks, non-regular files, a wrong
/// basename, a path outside the review root, and files over the byte cap. A
/// policy filter (not kernel-enforced confinement), mirroring
/// `validate_artifact_file` — it closes the lane-swaps-the-file surface.
fn validate_review_file(
    root: &StdPath,
    path: &StdPath,
    slug: &str,
    cap: u64,
) -> Result<String, String> {
    if path.file_name().and_then(|f| f.to_str()) != Some("review.md") {
        return Err("path_mismatch: basename is not review.md".to_string());
    }
    // Component (not string-prefix) containment: the issued path is
    // `<root>/<slug>/review.md`, exactly two components below the root.
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "path_mismatch: outside the review root".to_string())?;
    let comps: Vec<_> = rel.components().collect();
    if comps.len() != 2 || comps[0].as_os_str() != slug {
        return Err("path_mismatch: unexpected bundle depth".to_string());
    }

    // Reject a symlink in ANY component: .krypton, reviews, the slug, the file.
    let mut chain: Vec<PathBuf> = Vec::new();
    if let Some(krypton_dir) = root.parent() {
        chain.push(krypton_dir.to_path_buf());
    }
    chain.push(root.to_path_buf());
    let mut cur = root.to_path_buf();
    for comp in &comps {
        cur = cur.join(comp.as_os_str());
        chain.push(cur.clone());
    }
    for component in &chain {
        if let Ok(meta) = std::fs::symlink_metadata(component) {
            if meta.file_type().is_symlink() {
                return Err("symlink_rejected: review path contains a symlink".to_string());
            }
        }
    }

    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("not_found: review.md is not present ({e})"))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Err("symlink_rejected: review.md is a symlink".to_string());
    }
    if !file_type.is_file() {
        return Err("not_regular_file: review.md is not a regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Err("hardlink_rejected: review.md has multiple hard links".to_string());
        }
    }
    let size = meta.len();
    if size > cap {
        return Err(format!(
            "size_cap: review.md is {size} bytes but the limit is {cap}"
        ));
    }
    std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))
}

/// Block counts the card and the `/reviews` index report.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ReviewCounts {
    blocks: usize,
    steps: usize,
    findings: usize,
    decisions: usize,
}

/// Count a review document's blocks without a Markdown parser. Deliberately
/// approximate and cheap: this feeds a card label and an index row, and the
/// authoritative parse happens in the frontend. Fence-aware so a `review:finding`
/// mentioned inside a prose paragraph is not counted, and so a nested fence
/// inside a typed block cannot open a phantom one.
fn count_review_blocks(source: &str) -> ReviewCounts {
    let mut counts = ReviewCounts::default();
    // Skip the leading frontmatter stamp: it is metadata, not a block.
    let body = strip_front_matter(source);
    let mut open_fence: Option<String> = None;
    let mut in_walkthrough = false;
    let mut prose_run = false;

    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(fence) = open_fence.clone() {
            // Inside a fence: only the matching closer ends it.
            if trimmed.starts_with(&fence) && trimmed.trim_end().chars().all(|c| c == '`') {
                open_fence = None;
                in_walkthrough = false;
            } else if in_walkthrough && trimmed.starts_with("- at:") {
                counts.steps += 1;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            let ticks: String = trimmed.chars().take_while(|c| *c == '`').collect();
            let info = trimmed[ticks.len()..].trim().to_ascii_lowercase();
            let kind = info.split_whitespace().next().unwrap_or("");
            open_fence = Some(ticks);
            prose_run = false;
            counts.blocks += 1;
            match kind {
                "review:walkthrough" => in_walkthrough = true,
                "review:finding" => counts.findings += 1,
                "review:decision" => counts.decisions += 1,
                _ => {}
            }
            continue;
        }
        // A run of non-blank lines outside a fence is one prose block.
        if trimmed.is_empty() {
            prose_run = false;
        } else if !prose_run {
            prose_run = true;
            counts.blocks += 1;
        }
    }
    counts
}

/// Drop a leading `---`-delimited frontmatter block, if present.
fn strip_front_matter(source: &str) -> &str {
    let rest = match source.strip_prefix("---\n") {
        Some(rest) => rest,
        None => return source,
    };
    match rest.find("\n---") {
        Some(idx) => {
            let after = &rest[idx + 4..];
            after.strip_prefix('\n').unwrap_or(after)
        }
        None => source,
    }
}

/// A non-markdown file attached to a review bundle (an image the lane added).
#[derive(Debug)]
struct ReviewAsset {
    rel: String, // project-relative path
    size: u64,   // bytes, for the attachment strip label
}

/// One review bundle discovered on disk under `.krypton/reviews/<slug>/`.
#[derive(Debug)]
struct ReviewBundleInfo {
    slug: String,
    dir: PathBuf,
    title: String,
    lane_name: String,
    created_at: i64,
    /// Present when `response.md` exists — the human has answered something.
    responded_at: Option<i64>,
    /// Present when `response.md` records a `sent_at` — delivered to the lane.
    sent_at: Option<i64>,
    counts: ReviewCounts,
    /// False when the lane called `review_new` and died before writing anything.
    composed: bool,
    assets: Vec<ReviewAsset>,
    modified: Option<SystemTime>,
}

impl ReviewBundleInfo {
    /// What the human triages across reviews: findings and decisions with nothing
    /// recorded against them. Answers live in `response.md`, so a bundle with no
    /// response has everything unanswered. Advisory only — never a score.
    fn unanswered(&self) -> usize {
        let answerable = self.counts.findings + self.counts.decisions;
        let answered = self
            .responded_at
            .map(|_| count_response_answers(&self.dir))
            .unwrap_or(0);
        answerable.saturating_sub(answered)
    }

    /// The `ReviewBundle` shape the frontend picker consumes.
    fn to_json(&self) -> Value {
        let unanswered = self.unanswered();
        json!({
            "slug": self.slug,
            "dir": self.dir.to_string_lossy(),
            "title": self.title,
            "laneName": self.lane_name,
            "createdAt": self.created_at,
            "respondedAt": self.responded_at,
            "sentAt": self.sent_at,
            "composed": self.composed,
            "counts": {
                "blocks": self.counts.blocks,
                "steps": self.counts.steps,
                "findings": self.counts.findings,
                "decisions": self.counts.decisions,
                "unanswered": unanswered,
            },
        })
    }

    /// Index-row status, derived from `response.md` (spec 211 Browser surface).
    /// A bundle with nothing to answer is `reference` — an explanation to come
    /// back to, not a task — rather than being given a completion status.
    fn status_label(&self) -> &'static str {
        if !self.composed {
            return "never composed";
        }
        if self.counts.findings + self.counts.decisions == 0 {
            return "reference";
        }
        match (self.responded_at, self.sent_at) {
            (_, Some(_)) => "sent",
            (Some(_), None) => "answered, not sent",
            (None, _) => "never opened",
        }
    }
}

/// Count the answers recorded in a bundle's `response.md`. A line count over the
/// frontmatter's `- block:` entries — cheap, and only ever used for an advisory
/// "N unanswered" readout, never for correctness.
fn count_response_answers(dir: &StdPath) -> usize {
    let Ok(source) = std::fs::read_to_string(dir.join("response.md")) else {
        return 0;
    };
    let front = strip_front_matter_block(&source);
    let mut section = "";
    let mut answers = 0;
    for line in front.lines() {
        let trimmed = line.trim();
        if !line.starts_with(' ') && !line.starts_with('\t') && trimmed.ends_with(':') {
            section = match trimmed.trim_end_matches(':') {
                "findings" => "findings",
                "decisions" => "decisions",
                _ => "",
            };
            continue;
        }
        if !section.is_empty() && trimmed.starts_with("- block:") {
            answers += 1;
        }
    }
    answers
}

/// The TEXT of a leading frontmatter block (without its `---` fences), or "".
fn strip_front_matter_block(source: &str) -> &str {
    let Some(rest) = source.strip_prefix("---\n") else {
        return "";
    };
    match rest.find("\n---") {
        Some(idx) => &rest[..idx],
        None => "",
    }
}

/// Read one flat `key: value` out of a frontmatter block, JSON-unquoting it.
fn front_matter_value(source: &str, key: &str) -> Option<String> {
    let front = strip_front_matter_block(source);
    for line in front.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if !k.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        let raw = v.trim();
        let decoded = if raw.starts_with('"') {
            serde_json::from_str::<String>(raw)
                .unwrap_or_else(|_| raw.trim_matches('"').to_string())
        } else {
            raw.to_string()
        };
        return if decoded.is_empty() {
            None
        } else {
            Some(decoded)
        };
    }
    None
}

/// Walk `<project>/.krypton/reviews/<slug>/` (unfiltered — the dir is gitignored,
/// so `build_docs_tree` never sees it) and return one bundle per directory,
/// NEWEST FIRST. The slug's `YYYY-MM-DD` prefix makes a reverse lexical sort
/// chronological, with the directory name as a deterministic tiebreak.
fn discover_review_bundles(project_dir: &str) -> Vec<ReviewBundleInfo> {
    let Some(root) = reviews_root(project_dir) else {
        return Vec::new();
    };
    let mut bundles: Vec<ReviewBundleInfo> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return bundles;
    };
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().to_string();
        if slug.starts_with('.') {
            continue;
        }
        let dir = entry.path();
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };

        let mut assets: Vec<ReviewAsset> = Vec::new();
        let mut modified: Option<SystemTime> = None;
        let mut has_review = false;
        let mut has_response = false;
        for file in files.filter_map(Result::ok) {
            let name = file.file_name().to_string_lossy().to_string();
            let meta = file.metadata().ok();
            if let Some(mt) = meta.as_ref().and_then(|m| m.modified().ok()) {
                modified = Some(modified.map_or(mt, |cur| cur.max(mt)));
            }
            if meta.as_ref().is_some_and(|m| m.is_dir()) {
                // `assets/` — one level deep, images only.
                if name == "assets" {
                    collect_review_assets(&file.path(), &slug, &mut assets);
                }
                continue;
            }
            match name.as_str() {
                "review.md" => has_review = true,
                "response.md" => has_response = true,
                _ => {}
            }
        }

        let source = if has_review {
            std::fs::read_to_string(dir.join("review.md")).unwrap_or_default()
        } else {
            String::new()
        };
        let counts = count_review_blocks(&source);
        let response_source = if has_response {
            std::fs::read_to_string(dir.join("response.md")).unwrap_or_default()
        } else {
            String::new()
        };

        assets.sort_by(|a, b| a.rel.cmp(&b.rel));
        bundles.push(ReviewBundleInfo {
            title: front_matter_value(&source, "title").unwrap_or_else(|| slug.clone()),
            lane_name: front_matter_value(&source, "lane").unwrap_or_else(|| "—".to_string()),
            created_at: front_matter_value(&source, "created")
                .and_then(|s| parse_rfc3339_ms(&s))
                .or_else(|| slug_date_ms(&slug))
                .unwrap_or(0),
            responded_at: front_matter_value(&response_source, "responded_at")
                .and_then(|s| parse_rfc3339_ms(&s)),
            sent_at: front_matter_value(&response_source, "sent_at")
                .and_then(|s| parse_rfc3339_ms(&s)),
            composed: counts.blocks > 0,
            slug,
            dir,
            counts,
            assets,
            modified,
        });
    }
    // Newest first; the date prefix makes reverse-lexical chronological.
    bundles.sort_by(|a, b| b.slug.cmp(&a.slug));
    bundles
}

/// Collect image files from a bundle's `assets/` directory (one level, no
/// recursion — a review attaches diagrams, not a tree).
fn collect_review_assets(dir: &StdPath, slug: &str, out: &mut Vec<ReviewAsset>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let is_img = StdPath::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .is_some_and(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp"));
        if !is_img {
            continue;
        }
        out.push(ReviewAsset {
            rel: format!(".krypton/reviews/{slug}/assets/{name}"),
            size: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
}

/// Parse `YYYY-MM-DDTHH:MM:SSZ` (and the `+07:00` offset form the frontend
/// writes) to epoch millis. Tolerant: a date-only value is midnight UTC, and an
/// unparseable value is `None` so the caller can fall back to the slug's date.
fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let mut secs = days_from_civil(year, month, day) * 86_400;
    if bytes.len() >= 19 {
        let hour: i64 = value.get(11..13)?.parse().ok()?;
        let minute: i64 = value.get(14..16)?.parse().ok()?;
        let second: i64 = value.get(17..19)?.parse().ok()?;
        secs += hour * 3600 + minute * 60 + second;
        // Trailing `+HH:MM` / `-HH:MM` offset — subtract to reach UTC.
        if bytes.len() >= 25 {
            let sign = match bytes[19] {
                b'+' => -1,
                b'-' => 1,
                _ => 0,
            };
            if sign != 0 {
                let oh: i64 = value.get(20..22).and_then(|s| s.parse().ok()).unwrap_or(0);
                let om: i64 = value.get(23..25).and_then(|s| s.parse().ok()).unwrap_or(0);
                secs += sign * (oh * 3600 + om * 60);
            }
        }
    }
    Some(secs * 1000)
}

/// The `YYYY-MM-DD` prefix of a bundle slug, as epoch millis. The fallback when a
/// bundle has no `created:` stamp (a hand-made or hand-edited directory).
fn slug_date_ms(slug: &str) -> Option<i64> {
    parse_rfc3339_ms(slug.get(0..10)?)
}

/// `(year, month, day)` → days since the Unix epoch, proleptic Gregorian, UTC
/// (Howard Hinnant's `days_from_civil` — the inverse of `civil_from_days`).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // [0, 11], March-based
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Render the `/reviews` shell: title, sidebar, content. Same `<!--SLOT-->`
/// substitution as the analyses shell — the wrapping element is replaced along
/// with its comment, so the wrapper is re-emitted with the content inside.
fn render_reviews_page(title: &str, tree: Option<&str>, content: &str) -> Response {
    html_response(reviews_page_html(title, tree, content))
}

/// The slot substitution, split out from the `Response` wrapper so a test can pin
/// all three markers without reading an async body. This pattern fails SILENTLY
/// when a marker drifts between the HTML file and the string here — the page still
/// renders 200, just with an empty body — so it is worth a test.
fn reviews_page_html(title: &str, tree: Option<&str>, content: &str) -> String {
    let escaped_title = html_escape(title);
    let nav = match tree {
        Some(tree) => format!("<nav class=\"tree-pane\">{tree}</nav>"),
        None => String::new(),
    };
    REVIEWS_HTML
        .replace("<!--REVIEWS_TITLE-->", &escaped_title)
        .replace("<nav class=\"tree-pane\"><!--REVIEWS_TREE--></nav>", &nav)
        .replace(
            "<article class=\"doc\"><!--REVIEWS_CONTENT--></article>",
            &format!("<article class=\"doc\">{content}</article>"),
        )
}

/// Sidebar: every harness with bundles, newest first, each a link to `/review`.
/// The current bundle gets `is-active`.
fn render_reviews_nav(
    per: &[(String, String, Vec<ReviewBundleInfo>)],
    sel_harness: &str,
    sel_slug: &str,
) -> String {
    let multi = per.iter().filter(|(_, _, b)| !b.is_empty()).count() > 1;
    let mut out = String::from("<ul class=\"tree\">");
    for (harness_id, _project_dir, bundles) in per {
        if bundles.is_empty() {
            continue;
        }
        out.push_str("<li class=\"tree-group\"><div class=\"tree-group__label\">");
        out.push_str(&html_escape(&if multi {
            format!("{harness_id} · {} reviews", bundles.len())
        } else {
            format!("{} reviews", bundles.len())
        }));
        out.push_str("</div><ul class=\"tree\">");
        for bundle in bundles {
            let active = harness_id == sel_harness && bundle.slug == sel_slug;
            out.push_str("<li class=\"tree-file\"><a");
            if active {
                out.push_str(" class=\"is-active\"");
            }
            out.push_str(" href=\"/review?harness=");
            out.push_str(&url_encode(harness_id));
            out.push_str("&amp;slug=");
            out.push_str(&url_encode(&bundle.slug));
            out.push_str("\">");
            out.push_str(&html_escape(&bundle.title));
            out.push_str("<span class=\"tree-file__count\">");
            out.push_str(&html_escape(&review_meta_label(bundle)));
            out.push_str("</span></a></li>");
        }
        out.push_str("</ul></li>");
    }
    out.push_str("</ul>");
    out
}

/// The one-line meta a bundle carries in the sidebar and index. Walkthrough step
/// count sits next to the block count because on a comprehension Board it is the
/// better measure of "how much is here to read".
fn review_meta_label(bundle: &ReviewBundleInfo) -> String {
    let c = &bundle.counts;
    let mut parts = vec![format!("{} blocks", c.blocks)];
    if c.steps > 0 {
        parts.push(format!("{} steps", c.steps));
    }
    if c.findings > 0 {
        parts.push(format!("{} findings", c.findings));
    }
    if c.decisions > 0 {
        parts.push(format!("{} decisions", c.decisions));
    }
    parts.join(" · ")
}

/// CSS modifier for a bundle's status chip.
fn review_status_class(label: &str) -> &'static str {
    match label {
        "sent" => "rv-status--sent",
        "answered, not sent" => "rv-status--answered",
        "reference" => "rv-status--reference",
        "never composed" => "rv-status--uncomposed",
        _ => "rv-status--unopened",
    }
}

/// Right pane of `/reviews`: one row per bundle, newest first. Answers the two
/// questions the in-app Board cannot, because it only ever shows one review:
/// "which reviews did I leave hanging" and "has anyone explained this before?".
fn render_reviews_index(harness_id: &str, bundles: &[ReviewBundleInfo]) -> String {
    if bundles.is_empty() {
        return "<p class=\"welcome\">ยังไม่มี Review Board สำหรับเลนนี้ — ขอให้เลนอธิบายโค้ดหรือรัน #review</p>"
            .to_string();
    }
    let mut out = String::from("<ul class=\"reviews-index\">");
    for bundle in bundles {
        out.push_str("<li class=\"rv-row\"><a class=\"rv-row__main\" href=\"/review?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("&amp;slug=");
        out.push_str(&url_encode(&bundle.slug));
        out.push_str("\"><span class=\"rv-row__title\">");
        out.push_str(&html_escape(&bundle.title));
        out.push_str("</span><span class=\"rv-row__meta\">");
        out.push_str(&html_escape(&bundle.lane_name));
        out.push_str(" · ");
        out.push_str(&html_escape(&review_meta_label(bundle)));
        if !bundle.assets.is_empty() {
            out.push_str(&format!(" · {} ไฟล์แนบ", bundle.assets.len()));
        }
        if let Some((ms, label)) = bundle.modified.and_then(format_doc_mtime) {
            out.push_str(" · <time class=\"rv-date\" data-ts=\"");
            out.push_str(&ms.to_string());
            out.push_str("\">");
            out.push_str(&html_escape(&label));
            out.push_str("</time>");
        }
        out.push_str("</span></a><span class=\"rv-row__side\"><span class=\"rv-status ");
        let status = bundle.status_label();
        out.push_str(review_status_class(status));
        out.push_str("\">");
        out.push_str(&html_escape(status));
        out.push_str("</span>");
        // Never a score or a grade (ADR-0004) — just how much is left to answer.
        let unanswered = bundle.unanswered();
        if unanswered > 0 {
            out.push_str("<span class=\"rv-row__unanswered\">");
            out.push_str(&format!("{unanswered} to answer"));
            out.push_str("</span>");
        }
        out.push_str("</span></li>");
    }
    out.push_str("</ul>");
    out
}

/// Build one bundle's page: a two-entry file strip (`review` · `response`), the
/// selected document, then the asset strip. `sel_file` is `"review"` or
/// `"response"`.
fn render_review_bundle(
    harness_id: &str,
    project_dir: &str,
    bundle: &ReviewBundleInfo,
    sel_file: &str,
) -> String {
    let mut content = String::new();
    let has_response = bundle.responded_at.is_some();

    // spec 217 — both files live on ONE page, so the strip scrolls rather than
    // navigating. `file=` still selects which entry is marked, so existing links
    // (and the index rows) keep meaning what they meant.
    content.push_str("<nav class=\"file-strip\">");
    for (name, anchor, present) in [
        ("review", "rv-review", true),
        ("response", "rv-answers", has_response),
    ] {
        if !present {
            continue;
        }
        content.push_str("<a");
        if name == sel_file {
            content.push_str(" class=\"is-active\"");
        }
        content.push_str(" href=\"#");
        content.push_str(anchor);
        content.push_str("\">");
        content.push_str(name);
        content.push_str(".md</a>");
    }
    content.push_str("</nav>");

    let source = std::fs::read_to_string(bundle.dir.join("review.md")).unwrap_or_default();
    if source.trim().is_empty() {
        content.push_str(
            "<p class=\"welcome\">เลนสร้างโฟลเดอร์ไว้แต่ยังไม่ได้เขียนเอกสาร — ยังไม่มีอะไรให้อ่าน</p>",
        );
    } else {
        content.push_str(
            "<section class=\"review-file\" id=\"rv-review\"><div class=\"review-file__name\">",
        );
        content.push_str(&html_escape(&format!(
            ".krypton/reviews/{}/review.md",
            bundle.slug
        )));
        content.push_str("</div>");
        let rel = format!(".krypton/reviews/{}/review.md", bundle.slug);
        let rendered = render_markdown_doc(&source, harness_id, &rel, "/review-asset");
        let mut ctx = Some(RvSrcCtx::new(project_dir, bundle.created_at));
        let blocks = render_review_blocks(&rendered, &mut ctx);
        content.push_str(&blocks);
        if ctx.as_ref().is_some_and(|c| c.overflowed) {
            content.push_str(
                "<p class=\"rv-notice\">มีจุดอ้างอิงเกินจำนวนที่ดึงโค้ดมาแสดงได้ต่อหน้า จุดที่เหลือแสดงเป็นข้อความอย่างเดียว</p>",
            );
        }
        content.push_str("</section>");
    }

    if has_response {
        let response = std::fs::read_to_string(bundle.dir.join("response.md")).unwrap_or_default();
        if !response.trim().is_empty() {
            content.push_str(
                "<section class=\"review-file\" id=\"rv-answers\"><div class=\"review-file__name\">",
            );
            content.push_str(&html_escape(&format!(
                ".krypton/reviews/{}/response.md",
                bundle.slug
            )));
            content.push_str("</div>");
            let rel = format!(".krypton/reviews/{}/response.md", bundle.slug);
            // No excerpt context: the answers reference blocks, not code, and one
            // page's excerpt budget belongs to the review itself.
            let rendered = render_markdown_doc(&response, harness_id, &rel, "/review-asset");
            content.push_str(&render_review_blocks(&rendered, &mut None));
            content.push_str("</section>");
        }
    }

    if !bundle.assets.is_empty() {
        content.push_str(
            "<section class=\"attachments\"><h3>ไฟล์แนบในรีวิว</h3><div class=\"attachments__grid\">",
        );
        for asset in &bundle.assets {
            let name = asset.rel.rsplit('/').next().unwrap_or(&asset.rel);
            content.push_str(
                "<figure class=\"att\"><img loading=\"lazy\" src=\"/review-asset?harness=",
            );
            content.push_str(&url_encode(harness_id));
            content.push_str("&amp;path=");
            content.push_str(&url_encode(&asset.rel));
            content.push_str("\" alt=\"");
            content.push_str(&html_escape(name));
            content.push_str("\"><figcaption>");
            content.push_str(&html_escape(name));
            content.push_str(" · ");
            content.push_str(&html_escape(&human_size(asset.size)));
            content.push_str("</figcaption></figure>");
        }
        content.push_str("</div></section>");
    }
    content
}

// ─── Typed-block post-pass over comrak output ───────────────────────────────
// comrak emits a `review:finding` fence as `<pre><code class="language-review:
// finding">…</code></pre>`, so this walks the rendered HTML and rewrites the
// known fences into simple semantic markup. An unknown fence is left as a plain
// code block, exactly as in the Board.

/// Rewrite every recognized `<pre><code class="language-review:…">` block (and
/// plain `language-diff`) in comrak output into semantic HTML. String-level
/// because comrak's output for a code block is a fixed, predictable shape; the
/// body is HTML-escaped text, which is un-escaped once here and re-escaped by the
/// per-kind renderers.
fn render_review_blocks(html: &str, ctx: &mut Option<RvSrcCtx>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    // comrak always emits the info string as a `language-` class on <code>.
    const OPEN: &str = "<pre><code class=\"language-";
    while let Some(start) = rest.find(OPEN) {
        let (before, from_open) = rest.split_at(start);
        out.push_str(before);
        let after_open = &from_open[OPEN.len()..];
        let Some(quote) = after_open.find('"') else {
            out.push_str(from_open);
            return out;
        };
        let lang = after_open[..quote].to_ascii_lowercase();
        let Some(body_start) = after_open[quote..].find('>').map(|i| quote + i + 1) else {
            out.push_str(from_open);
            return out;
        };
        let Some(body_end) = after_open[body_start..]
            .find("</code></pre>")
            .map(|i| body_start + i)
        else {
            out.push_str(from_open);
            return out;
        };
        let body = html_unescape(&after_open[body_start..body_end]);
        let kind = lang.split_whitespace().next().unwrap_or("");
        match render_review_block(kind, &body, ctx) {
            Some(rendered) => out.push_str(&rendered),
            // Unknown fence: keep comrak's plain code block verbatim.
            None => out.push_str(&from_open[..OPEN.len() + body_end + "</code></pre>".len()]),
        }
        rest = &after_open[body_end + "</code></pre>".len()..];
    }
    out.push_str(rest);
    out
}

/// Dispatch one fence body to its renderer. `None` ⇒ not a review block.
fn render_review_block(kind: &str, body: &str, ctx: &mut Option<RvSrcCtx>) -> Option<String> {
    match kind {
        "review:walkthrough" => Some(render_rv_walkthrough(body, ctx)),
        "review:finding" => Some(render_rv_finding(body, ctx)),
        "review:decision" => Some(render_rv_decision(body)),
        "review:metrics" => Some(render_rv_metrics(body)),
        "review:chart" => Some(render_rv_chart(body)),
        "review:svg" => Some(render_rv_svg(body)),
        "diff" => Some(render_rv_diff(body)),
        // Forward-compatible: a newer lane's block renders as a labelled code
        // block rather than disappearing.
        other if other.starts_with("review:") => Some(format!(
            "<p class=\"rv-unknown\">{}</p><pre><code>{}</code></pre>",
            html_escape(other),
            html_escape(body)
        )),
        _ => None,
    }
}

/// Read a typed block body as flat `key: value` plus `key:`-headed indented
/// groups. Deliberately the same shape (and the same limits) as the frontend
/// parser: this page is an archive, so it reads what the lane most reliably
/// writes and shows the rest as-is rather than failing.
fn rv_scalar(body: &str, key: &str) -> Option<String> {
    for line in body.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if !k.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        let value = v.trim().trim_matches('"').trim_matches('\'').to_string();
        return if value.is_empty() { None } else { Some(value) };
    }
    None
}

/// The lines under a bare `key:`, trimmed. Empty when the key is absent or
/// carries an inline value.
///
/// A member line is either indented or a `- ` list item at column zero — both are
/// valid YAML and lanes write both, commonly mixing them (`- at:` flush left with
/// an indented `say:` under it). Anything else at column zero starts the next key
/// and ends the group.
fn rv_group(body: &str, key: &str) -> Vec<String> {
    let mut collecting = false;
    let mut out: Vec<String> = Vec::new();
    for line in body.lines() {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let trimmed = line.trim();
        if collecting {
            if trimmed.is_empty() {
                continue;
            }
            if !indented && !trimmed.starts_with('-') {
                break;
            }
            out.push(trimmed.to_string());
            continue;
        }
        if indented {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(key) && v.trim().is_empty() {
                collecting = true;
            }
        }
    }
    out
}

/// Strip one layer of surrounding quotes from a scalar an agent wrote.
fn rv_unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

// Source excerpts (spec 217) — extraction lives in `review_excerpt`. This
// file only turns a resolved window into archive HTML.

/// Resolve an anchor through the context and render it, or render nothing.
fn render_rv_source(at: &str, ctx: &mut Option<RvSrcCtx>) -> String {
    let Some(ctx) = ctx.as_mut() else {
        return String::new();
    };
    let Some(anchor) = rv_anchor(at) else {
        return String::new();
    };
    match ctx.excerpt(&anchor) {
        Ok(excerpt) => render_rv_excerpt(&excerpt),
        // Silent: the anchor may name a file in another repo, a generated path, or
        // something the repo does not track. A reason row on every such step would
        // be noise, and the explanation text is still worth reading.
        Err(RvSkip::Rejected) | Err(RvSkip::Budget) => String::new(),
        Err(RvSkip::Missing) => rv_src_notice(at.trim(), "ไฟล์นี้ไม่มีแล้ว"),
        Err(RvSkip::Drifted { lines }) => rv_src_notice(
            at.trim(),
            &format!("บรรทัดนี้เลยท้ายไฟล์ — ตอนนี้ไฟล์มี {lines} บรรทัด"),
        ),
    }
}

/// A head row on its own: the anchor plus why there are no lines under it.
fn rv_src_notice(label: &str, reason: &str) -> String {
    format!(
        "<div class=\"rv-src rv-src--drifted\"><div class=\"rv-src__head\"><span>{}</span><span class=\"rv-src__chip\">{}</span></div></div>",
        html_escape(label),
        html_escape(reason)
    )
}

/// The excerpt itself: a head row, then line-numbered source with the anchored
/// row tinted (a background tint, never a left rail).
fn render_rv_excerpt(excerpt: &RvExcerpt) -> String {
    let mut out = String::from("<div class=\"rv-src");
    if excerpt.stale {
        out.push_str(" rv-src--stale");
    }
    out.push_str("\"><div class=\"rv-src__head\"><span>");
    out.push_str(&html_escape(&excerpt.label));
    out.push_str("</span>");
    if excerpt.stale {
        out.push_str("<span class=\"rv-src__chip\">ไฟล์เปลี่ยนหลังรีวิวนี้</span>");
    }
    out.push_str("</div><div class=\"rv-src__body\">");
    for (i, line) in excerpt.lines.iter().enumerate() {
        let number = excerpt.first_line + i;
        out.push_str(if excerpt.anchor_line == Some(number) {
            "<div class=\"rv-src__line rv-src__line--anchor\"><span class=\"rv-src__ln\">"
        } else {
            "<div class=\"rv-src__line\"><span class=\"rv-src__ln\">"
        });
        out.push_str(&number.to_string());
        out.push_str("</span><span>");
        out.push_str(&html_escape(line));
        out.push_str("</span></div>");
    }
    out.push_str("</div>");
    if excerpt.omitted > 0 {
        out.push_str("<div class=\"rv-src__more\">อีก ");
        out.push_str(&excerpt.omitted.to_string());
        out.push_str(" บรรทัด</div>");
    }
    out.push_str("</div>");
    out
}

/// Walkthrough → an ordered list with a monospace anchor per step, and the code
/// that anchor points at underneath it (spec 217).
fn render_rv_walkthrough(body: &str, ctx: &mut Option<RvSrcCtx>) -> String {
    let mut out = String::new();
    if let Some(title) = rv_scalar(body, "title") {
        out.push_str("<div class=\"rv-steps__title\">");
        out.push_str(&html_escape(&rv_unquote(&title)));
        out.push_str("</div>");
    }
    // Collected first, because a step's excerpt renders AFTER its `say:` while the
    // anchor is read from the line before it.
    struct Step {
        at: Option<String>,
        says: Vec<String>,
    }
    let mut steps: Vec<Step> = Vec::new();
    for line in rv_group(body, "steps") {
        if let Some(at) = line
            .strip_prefix("- at:")
            .or_else(|| line.strip_prefix("-at:"))
        {
            steps.push(Step {
                at: Some(rv_unquote(at)),
                says: Vec::new(),
            });
        } else if let Some(say) = line.strip_prefix("say:") {
            match steps.last_mut() {
                Some(step) => step.says.push(rv_unquote(say)),
                None => steps.push(Step {
                    at: None,
                    says: vec![rv_unquote(say)],
                }),
            }
        } else if let Some(bare) = line.strip_prefix("- ") {
            // A bare scalar step (no `at:`/`say:` split) still renders.
            steps.push(Step {
                at: None,
                says: vec![rv_unquote(bare)],
            });
        }
    }

    out.push_str("<ol class=\"rv-steps\">");
    for step in &steps {
        out.push_str("<li>");
        if let Some(at) = &step.at {
            out.push_str("<span class=\"rv-step__at\">");
            out.push_str(&html_escape(at));
            out.push_str("</span>");
        }
        for say in &step.says {
            out.push_str("<span class=\"rv-step__say\">");
            out.push_str(&html_escape(say));
            out.push_str("</span>");
        }
        if let Some(at) = &step.at {
            out.push_str(&render_rv_source(at, ctx));
        }
        out.push_str("</li>");
    }
    out.push_str("</ol>");
    out
}

/// Finding → a bordered card with the severity in the heading colour. Never a
/// left accent rail, and never a pass/fail badge.
fn render_rv_finding(body: &str, ctx: &mut Option<RvSrcCtx>) -> String {
    let severity = rv_scalar(body, "severity")
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "non-blocking".to_string());
    let (tone, chip) = match severity.as_str() {
        "blocking" => ("blocking", "BLOCK"),
        "suggestion" => ("sugg", "SUGG"),
        _ => ("warn", "WARN"),
    };
    let title = rv_scalar(body, "title").unwrap_or_else(|| "(untitled finding)".to_string());
    let anchor = match (rv_scalar(body, "file"), rv_scalar(body, "line")) {
        (Some(file), Some(line)) => Some(format!("{file}:{line}")),
        (Some(file), None) => Some(file),
        _ => None,
    };
    let mut out = format!(
        "<div class=\"rv-finding rv-finding--{tone}\"><div class=\"rv-finding__head\"><span class=\"rv-finding__sev\">{chip}</span><span class=\"rv-finding__title\">{}</span>",
        html_escape(&rv_unquote(&title))
    );
    let mut source = String::new();
    if let Some(anchor) = anchor {
        let anchor = rv_unquote(&anchor);
        out.push_str("<span class=\"rv-finding__at\">");
        out.push_str(&html_escape(&anchor));
        out.push_str("</span>");
        // spec 217 — the code the finding is about, so the reader never has to
        // open an editor to know what `:835` says.
        source = render_rv_source(&anchor, ctx);
    }
    out.push_str("</div>");
    out.push_str(&source);
    out.push_str("</div>");
    out
}

/// Decision → the question plus an ordered options list, the recommendation
/// marked. The archive shows the LANE's recommendation; the human's choice lives
/// in `response.md`.
fn render_rv_decision(body: &str) -> String {
    let question = rv_scalar(body, "question").unwrap_or_else(|| "(no question)".to_string());
    let recommended: usize = rv_scalar(body, "recommended")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let mut out = format!(
        "<p class=\"rv-decision__question\">{}</p><ol class=\"rv-options\">",
        html_escape(&rv_unquote(&question))
    );
    let mut n = 0usize;
    for line in rv_group(body, "options") {
        let Some(text) = line.strip_prefix("- ") else {
            continue;
        };
        n += 1;
        out.push_str(if n == recommended {
            "<li class=\"is-chosen\">"
        } else {
            "<li>"
        });
        out.push_str(&html_escape(&rv_unquote(text)));
        if n == recommended {
            out.push_str("<span class=\"rv-option__rec\">rec</span>");
        }
        out.push_str("</li>");
    }
    out.push_str("</ol>");
    out
}

/// Metrics → a definition row strip.
fn render_rv_metrics(body: &str) -> String {
    let mut out = String::from("<dl class=\"rv-metrics\">");
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let (label, value) = match line.split_once(':') {
            Some((k, v)) => (k.trim(), rv_unquote(v)),
            None => (line.trim(), String::new()),
        };
        out.push_str("<dt>");
        out.push_str(&html_escape(label));
        out.push_str("</dt><dd>");
        out.push_str(&html_escape(&value));
        out.push_str("</dd>");
    }
    out.push_str("</dl>");
    out
}

/// Chart → label/value rows with proportional CSS bar widths. Deliberately does
/// NOT reuse the frontend's SVG geometry: two presentations of the same data, no
/// shared geometry code to drift. `line`/`sparkline` render the same way (the
/// archive shows the values, not the shape).
fn render_rv_chart(body: &str) -> String {
    let mut rows: Vec<(String, f64)> = Vec::new();
    let mut pending_label: Option<String> = None;
    for line in rv_group(body, "data") {
        // Either `label: 152` (map form) or `- label: acp/` + `value: 152`.
        if let Some(rest) = line.strip_prefix("- ") {
            if let Some((k, v)) = rest.split_once(':') {
                if k.trim().eq_ignore_ascii_case("label") {
                    pending_label = Some(rv_unquote(v));
                    continue;
                }
                if let Ok(n) = rv_unquote(v).parse::<f64>() {
                    rows.push((rv_unquote(k), n));
                }
            }
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if k.trim().eq_ignore_ascii_case("value") {
            if let (Some(label), Ok(n)) = (pending_label.take(), rv_unquote(v).parse::<f64>()) {
                rows.push((label, n));
            }
            continue;
        }
        if let Ok(n) = rv_unquote(v).parse::<f64>() {
            rows.push((rv_unquote(k), n));
        }
    }

    let mut out = String::from("<div class=\"rv-chart\">");
    if let Some(title) = rv_scalar(body, "title") {
        out.push_str("<div class=\"rv-chart__title\">");
        out.push_str(&html_escape(&rv_unquote(&title)));
        out.push_str("</div>");
    }
    // Scale against a zero-anchored max, so a bar's width is proportional to its
    // value rather than to its distance from the smallest (the truncated-axis
    // anti-pattern). Magnitudes only — a negative value reads by its label.
    let max = rows.iter().fold(0f64, |m, (_, v)| m.max(v.abs()));
    for (label, value) in &rows {
        let pct = if max > 0.0 {
            (value.abs() / max * 100.0).clamp(1.0, 100.0)
        } else {
            1.0
        };
        out.push_str("<div class=\"rv-chart__row\"><span class=\"rv-chart__label\">");
        out.push_str(&html_escape(label));
        out.push_str(
            "</span><span class=\"rv-chart__track\"><span class=\"rv-chart__bar\" style=\"width:",
        );
        out.push_str(&format!("{pct:.1}"));
        out.push_str("%\"></span></span><span class=\"rv-chart__value\">");
        out.push_str(&html_escape(&format_rv_number(*value)));
        out.push_str("</span></div>");
    }
    if rows.is_empty() {
        out.push_str("<pre><code>");
        out.push_str(&html_escape(body));
        out.push_str("</code></pre>");
    }
    out.push_str("</div>");
    out
}

/// Integers stay integral; fractions keep one decimal.
fn format_rv_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value:.1}")
    }
}

/// SVG → sanitized passthrough. Allowlist-only, and structurally simpler than the
/// frontend's DOM-based sanitizer because there is no DOM here: anything holding
/// a `<script`, a `<foreignObject`, an `on*=` handler, or an external `url(` is
/// refused WHOLE rather than partially cleaned. A refused diagram degrades to its
/// source text, which is still informative in an archive.
fn render_rv_svg(body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    let unsafe_svg = !lower.trim_start().starts_with("<svg")
        || compact.contains("<script")
        || compact.contains("<foreignobject")
        || compact.contains("<iframe")
        || compact.contains("javascript:")
        || compact.contains("data:text/html")
        || compact.contains("xlink:href")
        // NB: the handler scan runs on the UN-compacted text. Stripping
        // whitespace would glue `onload` onto the preceding tag name and defeat
        // the attribute-boundary check, while the substring checks above WANT
        // the compaction (it closes `java\tscript:`-style splits).
        || has_event_handler_attribute(&lower)
        || compact.contains("url(http")
        || compact.contains("url(//");
    if unsafe_svg {
        return format!(
            "<p class=\"rv-unknown\">svg not rendered (failed the archive's safety check)</p><pre><code>{}</code></pre>",
            html_escape(body)
        );
    }
    format!("<div class=\"rv-svg\">{body}</div>")
}

/// Does this LOWERCASED (not compacted) markup contain an `on…=` event-handler
/// attribute? Hand-rolled rather than pulling in a regex crate for one check.
/// Whitespace must be intact: an attribute name always begins at a whitespace or
/// `<`/`/`/quote boundary, and HTML forbids whitespace inside the name itself, so
/// a run like `on load=` is two attributes rather than a handler. Errs toward
/// refusing — a false positive degrades the diagram to its escaped source.
fn has_event_handler_attribute(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut i = 0;
    while let Some(found) = lower[i..].find("on") {
        let at = i + found;
        let boundary_ok = at == 0
            || matches!(
                bytes[at - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'<' | b'/' | b'"' | b'\'' | b'-'
            );
        if boundary_ok {
            // `on` + one or more name chars, optional whitespace, then `=`.
            let mut j = at + 2;
            while j < bytes.len() && (bytes[j].is_ascii_alphabetic() || bytes[j] == b'-') {
                j += 1;
            }
            if j > at + 2 {
                let mut k = j;
                while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                    k += 1;
                }
                if k < bytes.len() && bytes[k] == b'=' {
                    return true;
                }
            }
        }
        i = at + 2;
    }
    false
}

/// Diff → prefix-coloured lines. A plain `<pre>` rather than diff2html: the
/// archive shows the change, the app shows it navigably.
fn render_rv_diff(body: &str) -> String {
    let mut out = String::from("<pre class=\"rv-diff\">");
    for line in body.lines() {
        let class = if line.starts_with("@@") {
            "rv-diff__hunk"
        } else if line.starts_with('+') {
            "rv-diff__add"
        } else if line.starts_with('-') {
            "rv-diff__del"
        } else {
            ""
        };
        if class.is_empty() {
            out.push_str("<span>");
        } else {
            out.push_str(&format!("<span class=\"{class}\">"));
        }
        // A blank line still needs to occupy a row.
        if line.is_empty() {
            out.push_str("&nbsp;");
        } else {
            out.push_str(&html_escape(line));
        }
        out.push_str("</span>");
    }
    out.push_str("</pre>");
    out
}

/// Render the docs shell. Both surfaces are single-pane: the index is a flat
/// list (spec 171 rev 4) and `/doc` is a clean reader, so there is no sidebar.
fn render_docs_page(title: &str, content: &str) -> Response {
    let escaped_title = html_escape(title);
    let html = DOCS_HTML
        .replace("<!--DOCS_TITLE-->", &escaped_title)
        .replace(
            "<article class=\"doc\"><!--DOCS_CONTENT--></article>",
            &format!("<article class=\"doc\">{content}</article>"),
        );
    html_response(html)
}

fn html_response(html: impl Into<Body>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        .body(html.into())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Render one markdown file to HTML. `asset_route` is the loopback route inline
/// images are rewritten to (`/doc-asset` for the docs browser, `/analysis-asset`
/// for the Issue Analysis Viewer) so each surface's images ride its own route +
/// policy. Relative `.md` links always resolve to `/doc` (a validated reader for
/// any repo `.md`, gitignore-agnostic).
fn render_markdown_doc(source: &str, harness_id: &str, rel: &str, asset_route: &str) -> String {
    // Analysis docs (and similar) often put a "front matter" key/value block in a
    // leading blockquote after the H1. Comrak joins soft-broken blockquote lines
    // into one paragraph, so the fields mash into a single run-on line. Separate
    // those lines first so each field stays on its own row (and still renders as
    // markdown — links, code, bold). YAML `---` front matter is unchanged below.
    let source = separate_metadata_blockquote_lines(source);
    let arena = Arena::new();
    let options = docs_options();
    let root = parse_document(&arena, &source, &options);
    rewrite_doc_links(root, harness_id, rel, asset_route);
    let mut html = String::new();
    // Front matter renders first, as a readable key/value metadata card, ahead of
    // the document body (comrak itself emits nothing for the FrontMatter node).
    if let Some(front_matter) = extract_front_matter(root) {
        html.push_str(&render_front_matter(&front_matter));
    }
    if format_html(root, &options, &mut html).is_err() {
        return String::new();
    }
    html
}

/// A blockquote line is `>` or `> rest` (CommonMark allows 0–3 leading spaces).
fn is_blockquote_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed == ">" || trimmed.starts_with("> ") || trimmed.starts_with(">\t")
}

/// Strip the leading `>` marker (and the optional following space) from a
/// blockquote line, returning the inner text.
fn blockquote_inner(line: &str) -> &str {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('>') {
        if let Some(rest) = rest.strip_prefix(' ') {
            rest
        } else if let Some(rest) = rest.strip_prefix('\t') {
            rest
        } else {
            rest
        }
    } else {
        line
    }
}

/// True when a blockquote-inner line looks like a metadata field
/// (`Key: value` or `**Key:** value`), not free-form prose.
fn is_metadata_field_line(inner: &str) -> bool {
    let t = inner.trim();
    if t.is_empty() {
        return false;
    }
    // `**Key:** value` — bold key, common in analysis docs.
    if t.starts_with("**") {
        if let Some(end) = t.find(":**") {
            // key body between ** and :**
            return end > 2;
        }
    }
    // Bare `Key: value` — key is a single token (no spaces), not a URL scheme.
    if let Some((key, value)) = t.split_once(':') {
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            return false;
        }
        // Reject URL schemes (`https:`) and multi-word prose labels.
        if key.chars().any(|c| c.is_whitespace()) {
            return false;
        }
        if key.eq_ignore_ascii_case("http")
            || key.eq_ignore_ascii_case("https")
            || key.eq_ignore_ascii_case("mailto")
            || key.eq_ignore_ascii_case("ftp")
        {
            return false;
        }
        // Keep keys short — a 80-char "key" is almost certainly prose.
        return key.chars().count() <= 40;
    }
    false
}

/// Within each run of consecutive blockquote lines, if every non-empty line is a
/// `Key: value` metadata field, insert a blank `>` between them so comrak emits
/// one `<p>` per field instead of a single mashed paragraph.
fn separate_metadata_blockquote_lines(source: &str) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len().saturating_mul(2));
    let mut i = 0;
    while i < lines.len() {
        if !is_blockquote_line(lines[i]) {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        // Collect a maximal run of blockquote lines (blank lines end a CommonMark
        // blockquote, so they are not included in the run).
        let start = i;
        while i < lines.len() && is_blockquote_line(lines[i]) {
            i += 1;
        }
        let run = &lines[start..i];
        let fields: Vec<&str> = run
            .iter()
            .map(|l| blockquote_inner(l))
            .filter(|inner| !inner.trim().is_empty())
            .collect();
        let all_meta = fields.len() >= 2 && fields.iter().all(|f| is_metadata_field_line(f));
        if all_meta {
            for (idx, line) in run.iter().enumerate() {
                let inner = blockquote_inner(line);
                if inner.trim().is_empty() {
                    // Preserve an author-supplied blank `>` as a separator.
                    out.push((*line).to_string());
                    continue;
                }
                if idx > 0 {
                    // Separate from the previous field so each becomes its own <p>.
                    out.push(">".to_string());
                }
                out.push((*line).to_string());
            }
        } else {
            for line in run {
                out.push((*line).to_string());
            }
        }
    }
    // Preserve a trailing newline when the source had one, so re-parse is stable.
    let mut joined = out.join("\n");
    if source.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// Pull the raw text of the leading FrontMatter node (delimiters included), if
/// the document opened with one. comrak guarantees at most one, at the top.
fn extract_front_matter<'a>(root: &'a AstNode<'a>) -> Option<String> {
    root.descendants().find_map(|node| {
        if let NodeValue::FrontMatter(raw) = &node.data.borrow().value {
            Some(raw.clone())
        } else {
            None
        }
    })
}

/// Render captured YAML front matter as a flat key/value metadata card. The
/// common case in this repo is flat `key: value` scalars; non-scalar or
/// delimiter-less lines fall back to a full-width row so nothing is dropped.
fn render_front_matter(raw: &str) -> String {
    let mut rows = String::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        // Skip the `---` fences and blank lines.
        if trimmed.is_empty() || trimmed.chars().all(|c| c == '-') {
            continue;
        }
        match trimmed.split_once(':') {
            Some((key, value)) if !key.trim().is_empty() => {
                rows.push_str(&format!(
                    "<dt>{}</dt><dd>{}</dd>",
                    html_escape(key.trim()),
                    html_escape(value.trim())
                ));
            }
            _ => {
                rows.push_str(&format!("<dt></dt><dd>{}</dd>", html_escape(trimmed)));
            }
        }
    }
    if rows.is_empty() {
        return String::new();
    }
    format!("<dl class=\"frontmatter\">{rows}</dl>")
}

fn rewrite_doc_links<'a>(root: &'a AstNode<'a>, harness_id: &str, rel: &str, asset_route: &str) {
    let base = StdPath::new(rel)
        .parent()
        .unwrap_or_else(|| StdPath::new(""));
    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        match &mut data.value {
            NodeValue::Link(link) => {
                if let Some(target) = rewrite_markdown_link(&link.url, harness_id, base) {
                    link.url = target;
                }
            }
            NodeValue::Image(image) => {
                if let Some(target) =
                    rewrite_doc_asset_link(&image.url, harness_id, base, asset_route)
                {
                    image.url = target;
                }
            }
            _ => {}
        }
    }
}

fn rewrite_markdown_link(url: &str, harness_id: &str, base: &StdPath) -> Option<String> {
    if is_external_or_anchor(url) {
        return None;
    }
    let (path_part, suffix) = split_link_suffix(url);
    let has_md_ext = StdPath::new(path_part)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    if !has_md_ext {
        return None;
    }
    let resolved = normalize_relative_link(base, path_part)?;
    Some(format!(
        "/doc?harness={}&path={}{}",
        url_encode(harness_id),
        url_encode(&resolved),
        suffix
    ))
}

fn rewrite_doc_asset_link(
    url: &str,
    harness_id: &str,
    base: &StdPath,
    asset_route: &str,
) -> Option<String> {
    if is_external_or_anchor(url) {
        return None;
    }
    let (path_part, suffix) = split_link_suffix(url);
    let ext = StdPath::new(path_part)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())?;
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp"
    ) {
        return None;
    }
    let resolved = normalize_relative_link(base, path_part)?;
    Some(format!(
        "{asset_route}?harness={}&path={}{}",
        url_encode(harness_id),
        url_encode(&resolved),
        suffix
    ))
}

fn is_external_or_anchor(url: &str) -> bool {
    url.starts_with('#')
        || url.starts_with('/')
        || url.contains("://")
        || url.starts_with("mailto:")
        || url.starts_with("tel:")
}

fn split_link_suffix(url: &str) -> (&str, &str) {
    let split_at = url
        .char_indices()
        .find_map(|(idx, c)| (c == '#' || c == '?').then_some(idx))
        .unwrap_or(url.len());
    url.split_at(split_at)
}

fn normalize_relative_link(base: &StdPath, link: &str) -> Option<String> {
    let path = base.join(link);
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop()?;
            }
            std::path::Component::Normal(part) => {
                parts.push(part.to_string_lossy().to_string());
            }
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn url_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn doc_asset_mime(path: &StdPath) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

/// sha256-hex of a doc file's bytes, for the spec-172 live-reload poll. `None` if
/// the file can't be read. The path must already be `validate_doc_path`-checked.
fn doc_file_hash(path: &StdPath) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("{:x}", hasher.finalize()))
}

/// Write the seeded scaffold atomically: write to `<path>.tmp` then rename onto
/// `<path>`, so an interrupted write never leaves a truncated file. Best-effort
/// removes the tmp file on any failure (spec 134).
fn write_artifact_scaffold(path: &StdPath, html: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("html.tmp");
    if let Err(e) = std::fs::write(&tmp, html) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Make a lane label safe to use as a single path component. Every non
/// `[A-Za-z0-9_-]` char becomes `_`, so `.`/`..`/`/` cannot survive — the only
/// degenerate output is the empty string, which falls back to `lane`.
fn sanitize_path_component(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        "lane".to_string()
    } else {
        out
    }
}

/// Create the scratch root and a self-ignoring `.gitignore` (`*`, keep
/// `!.gitignore`) if absent. Never overwrites a user's file. Scoped to
/// `.krypton/artifacts`, never `.krypton` (which may hold tracked agent config).
fn ensure_artifacts_gitignore(root: &StdPath) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, "*\n!.gitignore\n")?;
    }
    Ok(())
}

/// Validate the issued artifact file at register/refresh time and return
/// `(size, sha256-hex)`. Rejects symlinks in any path component, hardlinks,
/// non-regular files, wrong basename, paths outside the scratch root, and files
/// over the byte cap. This is a policy filter, not kernel-enforced confinement
/// (see spec 133 Security) — it closes the lane-swaps-the-file surface.
fn validate_artifact_file(
    root: &StdPath,
    path: &StdPath,
    artifact_id: &str,
    cap: u64,
) -> Result<(u64, String), String> {
    let want_name = format!("{artifact_id}.html");
    if path.file_name().and_then(|f| f.to_str()) != Some(want_name.as_str()) {
        return Err("path_mismatch: basename is not <artifactId>.html".to_string());
    }
    // Component (not string-prefix) containment: `…/artifacts2` is not under
    // `…/artifacts`. The issued path is `<root>/<harnessId>/<laneId>/<file>`.
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "path_mismatch: outside the scratch root".to_string())?;
    let comps: Vec<_> = rel.components().collect();
    if comps.len() != 3 {
        return Err("path_mismatch: unexpected directory depth".to_string());
    }

    // Reject a symlink in ANY component: .krypton, artifacts, harnessId,
    // laneId, and the file itself.
    let mut chain: Vec<PathBuf> = Vec::new();
    if let Some(krypton_dir) = root.parent() {
        chain.push(krypton_dir.to_path_buf());
    }
    chain.push(root.to_path_buf());
    let mut cur = root.to_path_buf();
    for comp in &comps {
        cur = cur.join(comp.as_os_str());
        chain.push(cur.clone());
    }
    for component in &chain {
        if let Ok(meta) = std::fs::symlink_metadata(component) {
            if meta.file_type().is_symlink() {
                return Err("symlink_rejected: artifact path contains a symlink".to_string());
            }
        }
    }

    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("not_found: artifact file is not present ({e})"))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Err("symlink_rejected: artifact file is a symlink".to_string());
    }
    if !file_type.is_file() {
        return Err("not_regular_file: artifact path is not a regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Err("hardlink_rejected: artifact file has multiple hard links".to_string());
        }
    }
    let size = meta.len();
    if size > cap {
        return Err(format!(
            "size_cap: artifact is {size} bytes but the limit is {cap}"
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = format!("{:x}", hasher.finalize());
    Ok((size, hash))
}

/// Start the HTTP hook server on a dedicated tokio runtime.
/// Binds to 127.0.0.1 on the configured port (0 = auto-assign).
/// Returns the actual port the server bound to.
pub fn start(
    app_handle: AppHandle,
    hook_server: Arc<HookServer>,
    configured_port: u16,
    hurl: Arc<HurlState>,
    config: Arc<std::sync::RwLock<crate::config::KryptonConfig>>,
) {
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
                hurl: hurl.clone(),
                config: config.clone(),
            });

            let app = Router::new()
                .route("/hook", post(handle_hook))
                .route(
                    "/mcp/harness/{harness_id}/lane/{lane_label}",
                    get(handle_harness_memory_mcp_sse).post(handle_harness_memory_mcp),
                )
                .route("/dashboard", get(handle_dashboard))
                .route("/telemetry", get(handle_telemetry))
                .route("/gallery", get(handle_gallery))
                .route("/artifacts", get(handle_artifacts))
                .route("/commands", get(handle_commands))
                .route("/commands.json", get(handle_commands_json))
                .route("/tools", get(handle_tools))
                .route("/tools.json", get(handle_tools_json))
                .route("/termctrl/{token}", get(handle_termctrl_page))
                .route(
                    "/termctrl/api/{token}/sessions",
                    get(handle_termctrl_sessions),
                )
                .route(
                    "/termctrl/api/{token}/screen/{name}",
                    get(handle_termctrl_screen),
                )
                .route("/hurl/{token}", get(handle_hurl_page))
                .route("/hurl/api/{token}/listing", get(handle_hurl_listing))
                .route("/hurl/api/{token}/source", get(handle_hurl_source))
                .route("/hurl/api/{token}/env", get(handle_hurl_env))
                .route("/hurl/api/{token}/cache", get(handle_hurl_cache))
                .route("/hurl/api/{token}/run", post(handle_hurl_run))
                .route("/hurl/api/{token}/events/{run_id}", get(handle_hurl_events))
                .route("/hurl/api/{token}/cancel", post(handle_hurl_cancel))
                .route(
                    "/hurl/api/{token}/state",
                    get(handle_hurl_state_get).put(handle_hurl_state_put),
                )
                .route("/docs", get(handle_docs))
                .route("/journal", get(handle_journal))
                .route("/doc", get(handle_doc))
                .route("/doc-asset", get(handle_doc_asset))
                .route("/analyses", get(handle_analyses))
                .route("/analysis", get(handle_analysis))
                .route("/analysis-asset", get(handle_analysis_asset))
                // spec 211 — the Review Board archive. Read-only: it browses the
                // durable `.krypton/reviews/` bundles, while answering a review
                // stays in the keyboard-driven in-app Board.
                .route("/reviews", get(handle_reviews))
                .route("/review", get(handle_review))
                .route("/review-asset", get(handle_review_asset))
                // spec 172 — docs-browser inline feedback. Tokenless (keyed by
                // harness+path, the same addressing the read uses); the POST
                // injects a turn into the harness's active lane, and `/doc-state`
                // backs the page's live-reload poll. Same-origin with `/doc`.
                .route("/doc-state", get(handle_doc_state))
                .route("/doc-feedback", post(handle_doc_feedback))
                .route("/doc-artifact", post(handle_doc_artifact))
                // spec 149 — artifact inline feedback. Served over loopback HTTP
                // so the OS-browser page is same-origin with the feedback POST
                // (no CORS, no `Origin: null`). The token in the path is the sole
                // capability. Distinct segment counts → no route conflict.
                .route("/artifact/{token}", get(handle_artifact_get))
                .route("/artifact/state/{token}", get(handle_artifact_state))
                .route("/artifact/feedback/{token}", post(handle_artifact_feedback))
                .with_state(shared);

            let addr = SocketAddr::from(([127, 0, 0, 1], configured_port));
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    let fallback = SocketAddr::from(([127, 0, 0, 1], 0));
                    log::warn!(
                        "Failed to bind hook server on {addr}: {e}; falling back to an ephemeral port"
                    );
                    match tokio::net::TcpListener::bind(fallback).await {
                        Ok(l) => l,
                        Err(fallback_error) => {
                            let error = format!(
                                "Failed to bind hook server on {addr} and fallback {fallback}: {fallback_error}"
                            );
                            hook_server.set_error(error.clone());
                            log::error!("{error}");
                            return;
                        }
                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    // spec 146: review_outcome count parsing accepts ints, integer-valued
    // floats, and numeric strings; absent → None; present-but-invalid → Err
    // (never silently coerced to 0, which would record a falsely-clean round).
    #[test]
    fn parse_count_field_distinguishes_absent_valid_and_invalid() {
        let args = json!({
            "blockers": 3,
            "warnings": "2",
            "reviewer_count": 2.0,
            "null_field": null,
            "junk": "nope",
            "neg": -1,
            "frac": 1.5
        });
        // absent / null → None (caller defaults, e.g. 0 blockers = clean round)
        assert_eq!(parse_count_field(&args, "missing").unwrap(), None);
        assert_eq!(parse_count_field(&args, "null_field").unwrap(), None);
        // valid forms → Some(n)
        assert_eq!(parse_count_field(&args, "blockers").unwrap(), Some(3));
        assert_eq!(parse_count_field(&args, "warnings").unwrap(), Some(2));
        assert_eq!(parse_count_field(&args, "reviewer_count").unwrap(), Some(2));
        // present-but-invalid → Err (NOT coerced to 0)
        assert!(parse_count_field(&args, "junk").is_err());
        assert!(parse_count_field(&args, "neg").is_err());
        assert!(parse_count_field(&args, "frac").is_err());
    }

    #[test]
    fn review_outcome_payload_omits_findings_when_absent() {
        let args = json!({
            "blockers": 0,
            "warnings": 0,
            "reviewer_count": 1,
            "subject_label": "clean diff"
        });
        let findings = parse_review_findings(&args).unwrap();
        assert!(findings.is_none());

        let payload = build_review_outcome_payload(ReviewOutcomePayloadInput {
            from_lane: "Claude-1",
            blockers: 0,
            warnings: 0,
            reviewer_count: 1,
            subject_label: "clean diff",
            harness_id: "hm-1",
            request_id: "rvo-test",
            findings,
        });
        assert!(payload.get("findings").is_none());
        assert_eq!(payload["blockers"], json!(0));
        assert_eq!(payload["warnings"], json!(0));
        assert_eq!(payload["reviewerCount"], json!(1));
        assert_eq!(payload["subjectLabel"], json!("clean diff"));
    }

    #[test]
    fn review_outcome_payload_emits_valid_findings() {
        let args = json!({
            "findings": [
                {
                    "file": " src-tauri/src/hook_server.rs ",
                    "line": 42,
                    "severity": "blocking",
                    "note": "Rejects legacy callers"
                },
                {
                    "file": "src/main.ts",
                    "severity": "suggestion",
                    "note": "Clarify empty state"
                }
            ]
        });
        let findings = parse_review_findings(&args).unwrap();
        let payload = build_review_outcome_payload(ReviewOutcomePayloadInput {
            from_lane: "Claude-1",
            blockers: 1,
            warnings: 2,
            reviewer_count: 3,
            subject_label: "review matrix",
            harness_id: "hm-1",
            request_id: "rvo-test",
            findings,
        });

        assert_eq!(
            payload["findings"],
            json!([
                {
                    "file": "src-tauri/src/hook_server.rs",
                    "line": 42,
                    "severity": "blocking",
                    "note": "Rejects legacy callers"
                },
                {
                    "file": "src/main.ts",
                    "severity": "suggestion",
                    "note": "Clarify empty state"
                }
            ])
        );
    }

    #[test]
    fn review_outcome_findings_reject_invalid_severity_and_empty_file() {
        let invalid_severity = json!({
            "findings": [{
                "file": "src/main.ts",
                "severity": "warning",
                "note": "Uses legacy severity"
            }]
        });
        let err = parse_review_findings(&invalid_severity).unwrap_err();
        assert!(err.contains("severity must be one of"));

        let empty_file = json!({
            "findings": [{
                "file": " ",
                "severity": "non-blocking",
                "note": "Missing path"
            }]
        });
        let err = parse_review_findings(&empty_file).unwrap_err();
        assert!(err.contains("file must be a non-empty string"));
    }

    #[test]
    fn review_outcome_findings_reject_over_cap() {
        let findings: Vec<Value> = (0..=MAX_REVIEW_FINDINGS)
            .map(|i| {
                json!({
                    "file": format!("src/file-{i}.ts"),
                    "severity": "suggestion",
                    "note": "Bounded finding"
                })
            })
            .collect();
        let args = json!({ "findings": findings });
        let err = parse_review_findings(&args).unwrap_err();
        assert!(err.contains("too many findings"));
        assert!(err.contains(&format!("cap is {MAX_REVIEW_FINDINGS}")));
    }

    #[test]
    fn review_outcome_findings_accept_exact_cap() {
        let findings: Vec<Value> = (0..MAX_REVIEW_FINDINGS)
            .map(|i| {
                json!({
                    "file": format!("src/file-{i}.ts"),
                    "severity": "suggestion",
                    "note": "Bounded finding"
                })
            })
            .collect();
        let args = json!({ "findings": findings });
        let parsed = parse_review_findings(&args).unwrap().unwrap();
        assert_eq!(parsed.len(), MAX_REVIEW_FINDINGS);
    }

    #[test]
    fn bus_tools_include_attention_by_default() {
        let tools = bus_tool_descriptors();
        let names: Vec<&str> = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.get("name").and_then(|name| name.as_str()))
            .collect();
        assert!(
            names.contains(&"attention_flag"),
            "attention_flag should be advertised without per-lane opt-in"
        );
        assert!(
            names.contains(&"attention_resolve"),
            "attention_resolve should be advertised without per-lane opt-in"
        );
    }

    // ─── Artifacts (spec 133) ───────────────────────────────────────────────

    #[test]
    fn bus_tools_include_artifacts() {
        let tools = bus_tool_descriptors();
        let names: Vec<&str> = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.get("name").and_then(|name| name.as_str()))
            .collect();
        for tool in ["artifact_new", "artifact_register", "artifact_cancel"] {
            assert!(names.contains(&tool), "{tool} should be advertised");
        }
    }

    // ─── Diff review priority (spec 160) ────────────────────────────────────

    #[test]
    fn bus_tools_include_mark_review_priority() {
        let tools = bus_tool_descriptors();
        let tool = tools
            .as_array()
            .expect("tools array")
            .iter()
            .find(|t| t.get("name").and_then(|n| n.as_str()) == Some("mark_review_priority"))
            .expect("mark_review_priority should be advertised default-on");
        // The level enum must offer only the two non-default levels — 'normal' is
        // the unreported default and must never be a reportable value (ADR-0009).
        let level_enum = tool
            .pointer("/inputSchema/properties/ranges/items/properties/level/enum")
            .and_then(|v| v.as_array())
            .expect("level enum");
        let levels: Vec<&str> = level_enum.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(levels, vec!["high", "routine"]);
        let reason = tool
            .pointer("/inputSchema/properties/ranges/items/properties/reason")
            .and_then(|v| v.as_object())
            .expect("reason schema");
        assert_eq!(reason.get("type").and_then(|v| v.as_str()), Some("string"));
        assert_eq!(reason.get("maxLength").and_then(|v| v.as_u64()), Some(240));
    }

    #[test]
    fn sanitize_path_component_strips_unsafe() {
        assert_eq!(sanitize_path_component("Claude-1"), "Claude-1");
        assert_eq!(sanitize_path_component("a/b/../c"), "a_b____c");
        // `.` and `..` cannot survive (dots → `_`), so traversal is impossible.
        assert_eq!(sanitize_path_component(".."), "__");
        assert_eq!(sanitize_path_component("../etc"), "___etc");
        assert_eq!(sanitize_path_component(""), "lane");
    }

    /// new → write → register → refresh lifecycle against a real temp project.
    #[test]
    fn artifact_lifecycle_new_write_register() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-art-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        let project = tmp.to_string_lossy().to_string();

        server.init_harness_artifacts("hm-1", Some(project.clone()));

        // new issues a path + creates the gitignore + seeds a styled scaffold.
        let issued = server
            .artifact_new("hm-1", "Claude-1", "Side-by-side")
            .unwrap();
        let id = issued["id"].as_str().unwrap().to_string();
        let path = PathBuf::from(issued["path"].as_str().unwrap());
        assert!(path.ends_with(format!("{id}.html")));
        assert!(tmp.join(".krypton/artifacts/.gitignore").exists());
        assert_eq!(
            issued["content_marker"],
            serde_json::json!("main[data-artifact-content]")
        );

        // spec 134 — the scaffold is seeded at new: file exists, carries the
        // style marker, and the title is HTML-escaped into it.
        let seeded = std::fs::read_to_string(&path).unwrap();
        assert!(
            seeded.contains("krypton-artifact-base"),
            "scaffold style missing"
        );
        assert!(
            seeded.contains("data-artifact-content"),
            "content placeholder missing"
        );
        assert!(seeded.contains("Side-by-side"), "title not interpolated");

        // spec 134 — registering the untouched scaffold is allowed (placeholder
        // artifact); register does NOT require the placeholder be replaced. This
        // first register raises the card (registered=true) on the seeded file.
        let reg = server.artifact_register("hm-1", "Claude-1", &id).unwrap();
        assert_eq!(reg["ok"], serde_json::json!(true));
        assert_eq!(reg["registered"], serde_json::json!(true));
        assert!(reg["size"].as_u64().unwrap() > 0, "scaffold has bytes");
        assert_eq!(reg["hash"].as_str().unwrap().len(), 64);

        // the lane then edits the file; a repeat register is an idempotent
        // refresh (registered=false) that picks up the new size/hash.
        std::fs::write(&path, "<!doctype html><h1>hello</h1>").unwrap();
        let refreshed = server.refresh_artifact("hm-1", "Claude-1", &id).unwrap();
        assert_eq!(refreshed["registered"], serde_json::json!(false));
        assert_eq!(refreshed["size"].as_u64().unwrap(), 29);

        // cancel on a live id errors already_registered.
        let err = server.artifact_cancel("hm-1", "Claude-1", &id).unwrap_err();
        assert!(err.contains("already_registered"), "got: {err}");

        // a different lane cannot register/see the id (not_found, no leak).
        let other = server
            .artifact_register("hm-1", "Codex-1", &id)
            .unwrap_err();
        assert!(other.contains("not_found"), "got: {other}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cancel_preserves_pending_artifact_file() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-art-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-2", Some(tmp.to_string_lossy().to_string()));
        let issued = server.artifact_new("hm-2", "Claude-1", "scratch").unwrap();
        let id = issued["id"].as_str().unwrap().to_string();
        let path = PathBuf::from(issued["path"].as_str().unwrap());
        std::fs::write(&path, "<html></html>").unwrap();
        server.artifact_cancel("hm-2", "Claude-1", &id).unwrap();
        assert!(path.exists(), "cancel must preserve the on-disk file");
        let listing = server.list_all_artifacts_for_gallery();
        assert_eq!(listing.len(), 1);
        assert!(
            listing[0]["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .all(|a| a["id"].as_str() != Some(id.as_str())),
            "cancelled artifact must be delisted from gallery"
        );
        // register-after-cancel errors.
        assert!(server.artifact_register("hm-2", "Claude-1", &id).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn artifact_feedback_token_lifecycle() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-fb-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-9", Some(tmp.to_string_lossy().to_string()));
        let issued = server.artifact_new("hm-9", "Claude-1", "Pricing").unwrap();
        let id = issued["id"].as_str().unwrap().to_string();
        let token = issued["feedbackToken"].as_str().unwrap().to_string();
        assert_eq!(token.len(), 32, "128-bit hex token");
        let path = PathBuf::from(issued["path"].as_str().unwrap());

        // spec 149 — the token + base URL are baked into the served scaffold
        // (placeholders substituted, exactly like {{title}}).
        let seeded = std::fs::read_to_string(&path).unwrap();
        assert!(seeded.contains(&token), "token not baked into scaffold");
        assert!(
            !seeded.contains("{{feedbackToken}}"),
            "feedbackToken placeholder left unsubstituted"
        );
        assert!(
            seeded.contains("http://127.0.0.1:"),
            "feedback base url missing"
        );

        // pending artifact resolves; not yet registered.
        match server.lookup_feedback_token(&token) {
            FeedbackLookup::Found(info) => {
                assert_eq!(info.artifact_id, id);
                assert_eq!(info.lane_label, "Claude-1");
                assert!(!info.registered);
            }
            _ => panic!("token should resolve while pending"),
        }

        // register flips registered=true.
        server.artifact_register("hm-9", "Claude-1", &id).unwrap();
        match server.lookup_feedback_token(&token) {
            FeedbackLookup::Found(info) => assert!(info.registered),
            _ => panic!("token should resolve after register"),
        }

        // an unknown token is Unknown (→ 404, no existence leak).
        assert!(matches!(
            server.lookup_feedback_token("deadbeef00000000"),
            FeedbackLookup::Unknown
        ));

        // revoke (lane close / #new) is forward-only → Revoked (→ 410).
        assert_eq!(
            server.revoke_feedback_tokens_for_lane("hm-9", "Claude-1"),
            1
        );
        assert!(matches!(
            server.lookup_feedback_token(&token),
            FeedbackLookup::Revoked
        ));
        // idempotent: a second revoke finds nothing new to revoke.
        assert_eq!(
            server.revoke_feedback_tokens_for_lane("hm-9", "Claude-1"),
            0
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn artifact_routes_do_not_conflict() {
        // axum/matchit panics at `.route()` time on a path conflict. The three
        // spec-149 artifact routes share the `/artifact/...` prefix with the MCP
        // route's neighbour space; build the same router with trivial handlers to
        // prove the patterns register together without a conflict panic.
        async fn ok() -> &'static str {
            "ok"
        }
        let _app: Router = Router::new()
            .route("/hook", post(ok))
            .route(
                "/mcp/harness/{harness_id}/lane/{lane_label}",
                get(ok).post(ok),
            )
            .route("/dashboard", get(ok))
            .route("/telemetry", get(ok))
            .route("/gallery", get(ok))
            .route("/artifacts", get(ok))
            .route("/commands", get(ok))
            .route("/commands.json", get(ok))
            .route("/tools", get(ok))
            .route("/tools.json", get(ok))
            .route("/termctrl/{token}", get(ok))
            .route("/termctrl/api/{token}/sessions", get(ok))
            .route("/termctrl/api/{token}/screen/{name}", get(ok))
            .route("/hurl/{token}", get(ok))
            .route("/hurl/api/{token}/listing", get(ok))
            .route("/hurl/api/{token}/source", get(ok))
            .route("/hurl/api/{token}/env", get(ok))
            .route("/hurl/api/{token}/cache", get(ok))
            .route("/hurl/api/{token}/run", post(ok))
            .route("/hurl/api/{token}/events/{run_id}", get(ok))
            .route("/hurl/api/{token}/cancel", post(ok))
            .route("/hurl/api/{token}/state", get(ok).put(ok))
            .route("/docs", get(ok))
            .route("/journal", get(ok))
            .route("/doc", get(ok))
            .route("/doc-asset", get(ok))
            .route("/analyses", get(ok))
            .route("/analysis", get(ok))
            .route("/analysis-asset", get(ok))
            .route("/reviews", get(ok))
            .route("/review", get(ok))
            .route("/review-asset", get(ok))
            .route("/doc-state", get(ok))
            .route("/doc-feedback", post(ok))
            .route("/doc-artifact", post(ok))
            .route("/artifact/{token}", get(ok))
            .route("/artifact/state/{token}", get(ok))
            .route("/artifact/feedback/{token}", post(ok));
    }

    #[test]
    fn termctrl_monitor_url_is_capability_gated() {
        let server = HookServer::new();
        *server.port.lock().unwrap() = 64732;
        let url = server.termctrl_monitor_url().expect("monitor URL");
        assert!(url.starts_with("http://127.0.0.1:64732/termctrl/"));
        let token = url.rsplit('/').next().unwrap();
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(token, server.termctrl_monitor.token());
    }

    #[test]
    fn hurl_web_url_is_capability_gated() {
        let server = HookServer::new();
        *server.port.lock().unwrap() = 64732;
        let tmp = std::env::temp_dir().join(format!(
            "krypton-hurl-web-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let url = server
            .hurl_web_url(tmp.to_str().unwrap())
            .expect("hurl URL");
        assert!(url.starts_with("http://127.0.0.1:64732/hurl/"));
        let token = url.rsplit('/').next().unwrap();
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let again = server.hurl_web_url(tmp.to_str().unwrap()).unwrap();
        assert_eq!(url, again);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn termctrl_capability_comparison_checks_the_full_token() {
        assert!(constant_time_token_eq(
            "0123456789abcdef",
            "0123456789abcdef"
        ));
        assert!(!constant_time_token_eq(
            "0123456789abcdee",
            "0123456789abcdef"
        ));
        assert!(!constant_time_token_eq("short", "0123456789abcdef"));
    }

    #[test]
    fn termctrl_json_responses_disable_storage_and_sniffing() {
        let response = secured_json_response(StatusCode::OK, json!({ "ok": true }));
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
    }

    // spec 185: /commands.json serves exactly what the frontend last pushed.
    #[test]
    fn command_manifest_round_trip() {
        let server = HookServer::new();
        assert!(server.command_manifest().is_none());
        server.store_command_manifest(json!([{ "name": "polly" }]));
        assert_eq!(
            server.command_manifest(),
            Some(json!([{ "name": "polly" }]))
        );
        // Compile-time data: last write wins, no version guard.
        server.store_command_manifest(json!([{ "name": "debby" }]));
        assert_eq!(
            server.command_manifest(),
            Some(json!([{ "name": "debby" }]))
        );
    }

    // spec 186: /tools.json renders straight from the descriptors, so the only
    // thing that can drift is the page-only category map — pin it here, on the
    // actual served payload.
    #[test]
    fn tools_json_categories_cover_every_descriptor() {
        let payload = tools_json_payload();
        let arr = payload
            .get("tools")
            .and_then(Value::as_array)
            .expect("tools array");
        assert!(!arr.is_empty());
        for tool in arr {
            let name = tool
                .get("name")
                .and_then(|v| v.as_str())
                .expect("tool name");
            let category = tool
                .get("category")
                .and_then(|v| v.as_str())
                .expect("injected category");
            assert_ne!(
                category, "other",
                "tool `{name}` has no category mapping — add it to tool_category()"
            );
            let desc = tool
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            assert!(!desc.is_empty(), "tool `{name}` has an empty description");
            assert!(
                tool.get("inputSchema").is_some_and(Value::is_object),
                "tool `{name}` is missing an inputSchema object"
            );
        }
        // The MCP-facing descriptors themselves stay category-free.
        let mcp = bus_tool_descriptors();
        for tool in mcp.as_array().expect("descriptor array") {
            assert!(
                tool.get("category").is_none(),
                "category leaked into the MCP tools/list descriptors"
            );
        }
    }

    /// Spec 171 rev 4: the index is flat and **newest first**. Every `.md` under
    /// the cwd — however deep — comes back as one list ordered by mtime
    /// descending, and the rendered rows address files by their full relative
    /// path with no folder-drilldown links.
    #[test]
    fn collect_doc_files_is_flat_and_newest_first() {
        let tmp_raw = std::env::temp_dir().join(format!("krypton-docs-flat-{}", rand_suffix()));
        std::fs::create_dir_all(tmp_raw.join("docs").join("adr")).unwrap();
        let tmp = tmp_raw.canonicalize().unwrap();
        // Written oldest → newest, but deliberately in an order that alphabetical
        // sorting would NOT produce, so the assertion can only pass on mtime.
        let plan = [
            ("docs/02-req.md", 1_000u64),
            ("README.md", 3_000),
            ("docs/adr/0001-peer.md", 2_000),
        ];
        for (rel, offset) in plan {
            let path = tmp.join(rel);
            std::fs::write(&path, "# doc").unwrap();
            let file = std::fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000 + offset))
                .unwrap();
        }
        std::fs::write(tmp.join("docs").join("notes.txt"), "skip me").unwrap();

        let entries = collect_doc_files(&tmp);
        let rels: Vec<&str> = entries.iter().map(|e| e.rel.as_str()).collect();
        assert_eq!(
            rels,
            vec!["README.md", "docs/adr/0001-peer.md", "docs/02-req.md"],
            "flat list must be ordered most-recently-modified first"
        );

        let html = render_docs_list("hm-1", &entries);
        assert!(html.contains("id=\"docs-filter\""), "filter box missing");
        assert!(
            html.contains("data-path=\"docs/adr/0001-peer.md\""),
            "{html}"
        );
        assert!(
            html.contains("path=docs%2Fadr%2F0001-peer.md"),
            "deep file must link by full path: {html}"
        );
        assert!(
            html.contains("<span class=\"browser__dir\">docs/adr/</span>0001-peer.md"),
            "path prefix must render muted: {html}"
        );
        assert!(
            !html.contains("&amp;dir="),
            "no folder drilldown links: {html}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// spec 223: the journal index must see files the `/docs` index cannot.
    /// `.krypton/` is both dot-prefixed and gitignored, so `collect_doc_files`
    /// correctly drops every note — this walk deliberately does not.
    #[test]
    fn collect_journal_notes_lists_days_the_docs_index_hides() {
        let tmp_raw = std::env::temp_dir().join(format!("krypton-journal-{}", rand_suffix()));
        let journal = tmp_raw.join(".krypton").join("journal");
        std::fs::create_dir_all(&journal).unwrap();
        let tmp = tmp_raw.canonicalize().unwrap();
        std::fs::write(tmp_raw.join(".gitignore"), ".krypton/\n").unwrap();

        for name in [
            "2026-08-13.md",
            "2026-08-15.md",
            "2026-08-15.generated.md",
            "2026-08-14.md",
        ] {
            std::fs::write(journal.join(name), "---\ngenerated: krypton-journal\n---\n").unwrap();
        }
        // Neither the raw capture log nor a stray non-note file is a "day".
        std::fs::write(journal.join("2026-08-15.jsonl"), "{}").unwrap();

        assert!(
            collect_doc_files(&tmp).is_empty(),
            "the docs index must keep ignoring .krypton/"
        );

        let notes = collect_journal_notes(&tmp);
        let rows: Vec<(&str, bool)> = notes
            .iter()
            .map(|n| (n.date.as_str(), n.generated_copy))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("2026-08-15", false),
                ("2026-08-15", true),
                ("2026-08-14", false),
                ("2026-08-13", false),
            ],
            "newest day first, canonical note before its generated copy"
        );

        let html = render_journal_list("hm-1", &notes);
        assert!(html.contains("id=\"docs-filter\""), "filter box missing");
        assert!(
            html.contains("path=.krypton%2Fjournal%2F2026-08-15.generated.md"),
            "the generated copy must link to its own file: {html}"
        );
        assert!(
            html.contains("generated copy"),
            "a generated copy must be labelled, not shown as a duplicate day: {html}"
        );
        assert!(
            html.contains("/doc?harness=hm-1"),
            "rows open the existing reader, not a new one: {html}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_journal_notes_on_a_project_without_a_journal_is_empty() {
        let tmp_raw = std::env::temp_dir().join(format!("krypton-journal-none-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp_raw).unwrap();
        let tmp = tmp_raw.canonicalize().unwrap();
        assert!(collect_journal_notes(&tmp).is_empty());
        // The empty state has to say how to make one, not just report nothing.
        let html = render_journal_list("hm-1", &[]);
        assert!(html.contains("#daily"), "{html}");
        assert!(html.contains("Leader J"), "{html}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn format_doc_mtime_renders_utc_label() {
        // 2026-06-19 13:45:00 UTC.
        let secs = 1_781_876_700u64;
        let t = UNIX_EPOCH + Duration::from_secs(secs);
        let (ms, label) = format_doc_mtime(t).unwrap();
        assert_eq!(ms, (secs as i64) * 1000);
        assert_eq!(label, "2026-06-19 13:45");
        // epoch and a leap-day boundary.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn validate_doc_path_accepts_markdown_under_cwd() {
        let tmp_raw = std::env::temp_dir().join(format!("krypton-docs-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp_raw).unwrap();
        let tmp = tmp_raw.canonicalize().unwrap();
        let docs = tmp.join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let file = docs.join("guide.md");
        std::fs::write(&file, "# Guide").unwrap();
        let resolved = validate_doc_path(&tmp, "docs/guide.md", &["md"]).unwrap();
        assert_eq!(resolved, file.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_doc_path_rejects_parent_traversal() {
        let tmp = std::env::temp_dir().join(format!("krypton-docs-{}", rand_suffix()));
        let outside = tmp.with_extension("outside.md");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(&outside, "# Secret").unwrap();
        let rel = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        let err = validate_doc_path(&tmp, &rel, &["md"]).unwrap_err();
        assert!(err.contains("outside cwd"), "got: {err}");
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn validate_doc_path_rejects_absolute_path() {
        let tmp = std::env::temp_dir().join(format!("krypton-docs-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("guide.md");
        std::fs::write(&file, "# Guide").unwrap();
        let err = validate_doc_path(&tmp, &file.to_string_lossy(), &["md"]).unwrap_err();
        assert!(err.contains("absolute path"), "got: {err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_doc_path_rejects_symlink_escape() {
        let tmp = std::env::temp_dir().join(format!("krypton-docs-{}", rand_suffix()));
        let outside = tmp.with_extension("secret.md");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(&outside, "# Secret").unwrap();
        #[cfg(unix)]
        {
            let link = tmp.join("linked.md");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            let err = validate_doc_path(&tmp, "linked.md", &["md"]).unwrap_err();
            assert!(err.contains("outside cwd"), "got: {err}");
        }
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn validate_doc_path_rejects_wrong_extension() {
        let tmp = std::env::temp_dir().join(format!("krypton-docs-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("note.txt"), "nope").unwrap();
        let err = validate_doc_path(&tmp, "note.txt", &["md"]).unwrap_err();
        assert!(err.contains("extension rejected"), "got: {err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_doc_artifact_request_accepts_and_normalizes_markdown() {
        let tmp_raw = std::env::temp_dir().join(format!("krypton-doc-art-{}", rand_suffix()));
        std::fs::create_dir_all(tmp_raw.join("docs")).unwrap();
        std::fs::write(tmp_raw.join("docs").join("guide.md"), "# Guide").unwrap();
        let tmp = tmp_raw.canonicalize().unwrap();
        let request = validate_doc_artifact_request(
            &tmp.to_string_lossy(),
            "docs/./guide.md",
            &json!({ "batchId": "da-1", "title": "  Docs artifact · guide.md  " }),
        )
        .unwrap();

        assert_eq!(request.normalized_path, "docs/guide.md");
        assert_eq!(request.batch_id, "da-1");
        assert_eq!(request.title, "Docs artifact · guide.md");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_doc_artifact_request_rejects_bad_body_or_path() {
        let tmp_raw = std::env::temp_dir().join(format!("krypton-doc-art-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp_raw).unwrap();
        std::fs::write(tmp_raw.join("guide.md"), "# Guide").unwrap();
        let tmp = tmp_raw.canonicalize().unwrap();
        let root = tmp.to_string_lossy();

        assert_eq!(
            validate_doc_artifact_request(&root, "guide.md", &json!({ "title": "t" })).unwrap_err(),
            DocArtifactRequestError::BadRequest("missing batchId")
        );
        assert_eq!(
            validate_doc_artifact_request(&root, "guide.md", &json!({ "batchId": "da-1" }))
                .unwrap_err(),
            DocArtifactRequestError::BadRequest("missing title")
        );
        assert_eq!(
            validate_doc_artifact_request(
                &root,
                "guide.md",
                &json!({ "batchId": "da-1", "title": "x".repeat(ARTIFACT_TITLE_MAX + 1) }),
            )
            .unwrap_err(),
            DocArtifactRequestError::PayloadTooLarge
        );
        assert_eq!(
            validate_doc_artifact_request(
                &root,
                "missing.md",
                &json!({ "batchId": "da-1", "title": "t" }),
            )
            .unwrap_err(),
            DocArtifactRequestError::NotFound
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn doc_artifact_reply_response_maps_acceptance() {
        assert_eq!(
            doc_artifact_reply_response(&json!({ "accepted": true })).status(),
            StatusCode::OK
        );
        assert_eq!(
            doc_artifact_reply_response(&json!({ "accepted": false, "reason": "no_live_lane" }))
                .status(),
            StatusCode::CONFLICT
        );
    }

    #[test]
    fn render_markdown_doc_renders_raw_html() {
        // Spec 171 rev 2 (ADR-0010 reversed): raw HTML in repo markdown renders
        // as live HTML rather than being escaped to visible text.
        let html = render_markdown_doc(
            "<div class=\"x\">live</div>",
            "hm-1",
            "README.md",
            "/doc-asset",
        );
        assert!(
            html.contains("<div class=\"x\">live</div>"),
            "raw HTML should render live, not escaped: {html}"
        );
    }

    #[test]
    fn render_markdown_doc_renders_front_matter_as_card() {
        let source = "---\nstatus: Implemented\ndate: 2026-05-02\n---\n\n# Title\n\nBody text.";
        let html = render_markdown_doc(source, "hm-1", "docs/76-spec.md", "/doc-asset");
        // Front matter becomes a readable key/value card, not a stray <hr>/heading.
        assert!(
            html.contains("<dl class=\"frontmatter\">"),
            "front matter should render as a metadata card: {html}"
        );
        assert!(
            html.contains("<dt>status</dt><dd>Implemented</dd>"),
            "scalar key/value should render: {html}"
        );
        assert!(
            !html.contains("<hr"),
            "delimiters must not survive as a thematic break: {html}"
        );
        // Body still renders after the card.
        assert!(
            html.contains("<h1>Title</h1>"),
            "body should follow: {html}"
        );
    }

    #[test]
    fn render_markdown_doc_keeps_metadata_blockquote_fields_on_separate_lines() {
        // Analysis docs put informal "front matter" in a leading blockquote —
        // one `Key: value` per `>` line. Without a pre-pass, comrak joins those
        // soft-broken lines into a single paragraph and the fields mash together.
        let source = "\
# tli-dim-custom-ui#525 — title with `/`

> GitHub: https://github.com/bcircle/tli-dim-custom-ui/issues/525
> **ประเภท:** Bug (`area: Manage Document Type`) — หน้า SC0500
> **โมดูล:** `tli-api` (`POST /anysite-ui/new/createDocType`)
> **ตัวอย่างที่ทดสอบ:** Custom Type `สำเนาใบมรณบัตรบิดา /มารดา (07007)`

---

## Body
";
        let html = render_markdown_doc(source, "hm-1", "docs/cr/525.md", "/doc-asset");
        assert!(
            html.contains("<blockquote>"),
            "metadata block should stay a blockquote: {html}"
        );
        // Each field is its own <p>, not one run-on paragraph.
        let bq_start = html.find("<blockquote>").expect("blockquote");
        let bq_end = html.find("</blockquote>").expect("blockquote end");
        let bq = &html[bq_start..bq_end];
        let p_count = bq.matches("<p>").count();
        assert!(
            p_count >= 4,
            "expected one <p> per metadata field (≥4), got {p_count}: {bq}"
        );
        // Soft-join regression: GitHub URL and ประเภท must not share a <p>.
        assert!(
            !bq.contains("issues/525</a> <strong>ประเภท:</strong>")
                && !bq.contains("issues/525</a> **ประเภท:**"),
            "fields must not be soft-joined into one paragraph: {bq}"
        );
        assert!(
            bq.contains("<strong>ประเภท:</strong>"),
            "bold keys still render: {bq}"
        );
        assert!(
            bq.contains("<code>tli-api</code>"),
            "inline code in values still renders: {bq}"
        );
    }

    #[test]
    fn separate_metadata_blockquote_leaves_prose_quotes_alone() {
        // A multi-line prose blockquote must NOT gain blank separators — that
        // would turn one paragraph into many.
        let source = "> This is a long quotation that the author\n> wrapped across two soft-broken lines on purpose.\n";
        let out = separate_metadata_blockquote_lines(source);
        assert_eq!(
            out.lines().filter(|l| *l == ">").count(),
            0,
            "prose quotes must not gain separator lines: {out:?}"
        );
    }

    #[test]
    fn telemetry_store_version_guard() {
        let server = HookServer::new();
        let snap1 = json!({ "lanes": [] });
        let snap2 = json!({ "lanes": [{ "id": "a" }] });
        assert!(server.store_telemetry("hm-1", 1, snap1.clone()));
        assert_eq!(
            server.telemetry_for_harness("hm-1"),
            Some((1, snap1.clone()))
        );
        // equal version → drop
        assert!(!server.store_telemetry("hm-1", 1, snap2.clone()));
        assert_eq!(
            server.telemetry_for_harness("hm-1"),
            Some((1, snap1.clone()))
        );
        // stale version → drop
        assert!(!server.store_telemetry("hm-1", 0, snap2.clone()));
        assert_eq!(server.telemetry_for_harness("hm-1"), Some((1, snap1)));
        // newer version → store
        assert!(server.store_telemetry("hm-1", 2, snap2.clone()));
        assert_eq!(server.telemetry_for_harness("hm-1"), Some((2, snap2)));
    }

    #[test]
    fn dispose_harness_artifacts_clears_telemetry() {
        let server = HookServer::new();
        server.store_telemetry("hm-7", 1, json!({}));
        server.dispose_harness_artifacts("hm-7");
        assert_eq!(server.telemetry_for_harness("hm-7"), None);
    }

    #[test]
    fn dispose_preserves_artifact_files_on_close() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-dispose-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-close", Some(tmp.to_string_lossy().to_string()));
        let issued = server
            .artifact_new("hm-close", "Claude-1", "Persist me")
            .unwrap();
        let id = issued["id"].as_str().unwrap().to_string();
        let path = PathBuf::from(issued["path"].as_str().unwrap());
        let token = issued["feedbackToken"].as_str().unwrap().to_string();
        server
            .artifact_register("hm-close", "Claude-1", &id)
            .unwrap();

        let before = server.list_all_artifacts_for_gallery();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0]["artifacts"].as_array().unwrap().len(), 1);

        server.dispose_harness_artifacts("hm-close");

        assert!(
            path.exists(),
            "dispose must preserve the on-disk artifact file"
        );
        assert!(server.list_all_artifacts_for_gallery().is_empty());
        assert!(matches!(
            server.lookup_feedback_token(&token),
            FeedbackLookup::Unknown
        ));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rehydrate_reloads_artifacts_from_disk_across_restart() {
        // spec 173: a first "session" registers an artifact; a second HookServer
        // (the restart) re-homed under a DIFFERENT harness id must re-list it from
        // disk and re-arm its feedback token, routed to the live harness.
        let tmp = std::env::temp_dir().join(format!("krypton-rehydrate-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        let project = tmp.to_string_lossy().to_string();

        let s1 = HookServer::new();
        s1.init_harness_artifacts("hm-1", Some(project.clone()));
        let issued = s1.artifact_new("hm-1", "Claude-1", "Recover me").unwrap();
        let id = issued["id"].as_str().unwrap().to_string();
        let token = issued["feedbackToken"].as_str().unwrap().to_string();
        s1.artifact_register("hm-1", "Claude-1", &id).unwrap();

        // Restart: brand-new registry, re-homed under a different harness id.
        let s2 = HookServer::new();
        s2.init_harness_artifacts("hm-99", Some(project.clone()));

        // Re-listed in the gallery under the live harness.
        let gallery = s2.list_all_artifacts_for_gallery();
        assert_eq!(gallery.len(), 1);
        assert_eq!(gallery[0]["harnessId"], "hm-99");
        let rows = gallery[0]["artifacts"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], id);
        assert_eq!(rows[0]["title"], "Recover me");
        assert_eq!(rows[0]["state"], "live");

        // The baked token (parsed from the file, not re-minted) resolves and is
        // re-homed to the live harness so feedback routes to its lanes.
        match s2.lookup_feedback_token(&token) {
            FeedbackLookup::Found(info) => {
                assert_eq!(info.harness_id, "hm-99");
                assert_eq!(info.lane_label, "Claude-1");
                assert_eq!(info.artifact_id, id);
            }
            _ => panic!("expected the rehydrated token to resolve to Found"),
        }

        // The frontend replay endpoint surfaces the same row, registered.
        let replay = s2.list_harness_artifacts("hm-99");
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0]["id"], id);
        assert_eq!(replay[0]["state"], "registered");
        assert_eq!(replay[0]["feedbackToken"], token);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_helpers_recover_title_and_token() {
        let html = "<head><title>Hello &amp; &lt;World&gt;</title></head>\
            <script>window.__KRYPTON_FEEDBACK__ = { token: \"abc123\", url: \"x\" };</script>";
        assert_eq!(
            parse_artifact_title(html).as_deref(),
            Some("Hello & <World>")
        );
        assert_eq!(parse_feedback_token(html).as_deref(), Some("abc123"));
        // Unreplaced placeholder → no token.
        assert_eq!(
            parse_feedback_token("__KRYPTON_FEEDBACK__ token: \"{{feedbackToken}}\""),
            None
        );
        // Seq parsing rejects strays.
        assert_eq!(parse_artifact_seq("art-7-deadbeef"), Some(7));
        assert_eq!(parse_artifact_seq("notanart"), None);
        assert_eq!(parse_artifact_seq("art-7-xyz"), None);
    }

    fn telemetry_contract_response(server: &HookServer) -> Response {
        let mut resp = Json(json!({
            "harnesses": server.all_telemetry_snapshots(),
        }))
        .into_response();
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        resp
    }

    async fn telemetry_response(server: &HookServer) -> (StatusCode, Option<String>, Value) {
        let resp = telemetry_contract_response(server);
        let status = resp.status();
        let cache_control = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("response body should read");
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("response body should be JSON")
        };
        (status, cache_control, body)
    }

    #[tokio::test]
    async fn telemetry_returns_empty_harnesses_without_snapshots() {
        let server = Arc::new(HookServer::new());
        let (status, cache_control, body) = telemetry_response(&server).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cache_control.as_deref(), Some("no-store"));
        assert_eq!(body, json!({ "harnesses": [] }));
    }

    #[tokio::test]
    async fn telemetry_returns_all_opaque_snapshots_and_no_store() {
        let server = Arc::new(HookServer::new());
        let snapshot_a = json!({ "harnessId": "hm-a", "lanes": [{ "id": "a" }] });
        let snapshot_b = json!({ "harnessId": "hm-b", "extra": ["opaque", 3] });
        assert!(server.store_telemetry("hm-b", 7, snapshot_b.clone()));
        assert!(server.store_telemetry("hm-a", 3, snapshot_a.clone()));

        let (status, cache_control, body) = telemetry_response(&server).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cache_control.as_deref(), Some("no-store"));
        assert_eq!(
            body,
            json!({
                "harnesses": [snapshot_a, snapshot_b],
            })
        );
    }

    #[test]
    fn gallery_lists_pending_and_live_across_two_harnesses() {
        let server = HookServer::new();
        let tmp_a = std::env::temp_dir().join(format!("krypton-gal-a-{}", rand_suffix()));
        let tmp_b = std::env::temp_dir().join(format!("krypton-gal-b-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp_a).unwrap();
        std::fs::create_dir_all(&tmp_b).unwrap();
        server.init_harness_artifacts("hm-b", Some(tmp_b.to_string_lossy().to_string()));
        server.init_harness_artifacts("hm-a", Some(tmp_a.to_string_lossy().to_string()));

        let pending = server
            .artifact_new("hm-a", "Cursor-1", "Pending view")
            .unwrap();
        let pending_id = pending["id"].as_str().unwrap().to_string();
        let pending_token = pending["feedbackToken"].as_str().unwrap().to_string();
        let pending_tail = format!(".krypton/artifacts/hm-a/Cursor-1/{pending_id}.html");

        let live = server
            .artifact_new("hm-b", "OpenCode-1", "Live dashboard")
            .unwrap();
        let live_id = live["id"].as_str().unwrap().to_string();
        let live_token = live["feedbackToken"].as_str().unwrap().to_string();
        let live_tail = format!(".krypton/artifacts/hm-b/OpenCode-1/{live_id}.html");
        let reg = server
            .artifact_register("hm-b", "OpenCode-1", &live_id)
            .unwrap();
        let live_size = reg["size"].as_u64().unwrap();
        let live_hash = reg["hash"].as_str().unwrap().to_string();

        let listing = server.list_all_artifacts_for_gallery();
        assert_eq!(listing.len(), 2);
        assert_eq!(listing[0]["harnessId"], json!("hm-a"));
        assert_eq!(listing[1]["harnessId"], json!("hm-b"));

        let hm_a = &listing[0]["artifacts"];
        assert_eq!(hm_a.as_array().unwrap().len(), 1);
        assert_eq!(
            hm_a[0],
            json!({
                "id": pending_id,
                "laneLabel": "Cursor-1",
                "title": "Pending view",
                "state": "pending",
                "size": 0,
                "hash": "",
                "tail": pending_tail,
                "token": pending_token,
            })
        );

        let hm_b = &listing[1]["artifacts"];
        assert_eq!(hm_b.as_array().unwrap().len(), 1);
        assert_eq!(hm_b[0]["state"], json!("live"));
        assert_eq!(hm_b[0]["size"], json!(live_size));
        assert_eq!(hm_b[0]["hash"], json!(live_hash));
        assert_eq!(hm_b[0]["laneLabel"], json!("OpenCode-1"));
        assert_eq!(hm_b[0]["title"], json!("Live dashboard"));
        assert_eq!(hm_b[0]["tail"], json!(live_tail));
        assert_eq!(hm_b[0]["token"], json!(live_token));

        let _ = std::fs::remove_dir_all(&tmp_a);
        let _ = std::fs::remove_dir_all(&tmp_b);
    }

    #[test]
    fn gallery_includes_empty_live_harness() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-gal-empty-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-empty", Some(tmp.to_string_lossy().to_string()));

        let listing = server.list_all_artifacts_for_gallery();
        assert_eq!(
            listing,
            vec![json!({
                "harnessId": "hm-empty",
                "artifacts": [],
            })]
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn gallery_orders_artifacts_latest_creation_first() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-gal-sort-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-sort", Some(tmp.to_string_lossy().to_string()));

        // Create enough artifacts to cross the 10-boundary so the parsed-seq sort is
        // exercised against the unpadded-id trap: lexically "art-10"/"art-11" sort
        // BEFORE "art-2" (a raw-string compare would mis-order them), but by creation
        // order seq 10/11 are newer than seq 2 and must come first.
        let mut ids: Vec<String> = Vec::new();
        for n in 1..=11 {
            // Alternate lane labels so the result can't accidentally satisfy the old
            // laneLabel-then-id ordering.
            let lane = if n % 2 == 0 { "Alpha" } else { "Zeta" };
            let art = server
                .artifact_new("hm-sort", lane, &format!("View {n}"))
                .unwrap();
            let id = art["id"].as_str().unwrap().to_string();
            // Register each (the scaffold file already exists) so it leaves the
            // pending state — otherwise the per-lane pending cap (4) rejects the run.
            server.artifact_register("hm-sort", lane, &id).unwrap();
            ids.push(id);
        }

        let listing = server.list_all_artifacts_for_gallery();
        assert_eq!(listing.len(), 1);
        assert_eq!(listing[0]["harnessId"], json!("hm-sort"));
        let arts = listing[0]["artifacts"].as_array().unwrap();
        assert_eq!(arts.len(), 11);

        // Full order is strict latest-creation-first (seq 11 → 1), regardless of lane.
        let listed: Vec<&str> = arts.iter().map(|a| a["id"].as_str().unwrap()).collect();
        let expected: Vec<&str> = ids.iter().rev().map(|s| s.as_str()).collect();
        assert_eq!(listed, expected);

        // Regression guard: the highest seq (art-11) must sort before art-2, which a
        // raw-string descending sort would get backwards ("art-2" > "art-11" lexically).
        let pos = |id: &str| listed.iter().position(|x| *x == id).unwrap();
        assert!(pos(&ids[10]) < pos(&ids[1]), "art-11 must precede art-2");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn gallery_omits_cancelled_artifact() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-gal-cancel-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-cancel", Some(tmp.to_string_lossy().to_string()));

        let keep = server
            .artifact_new("hm-cancel", "Claude-1", "Keep me")
            .unwrap();
        let keep_id = keep["id"].as_str().unwrap().to_string();

        let doomed = server
            .artifact_new("hm-cancel", "Codex-1", "Cancel me")
            .unwrap();
        let doomed_id = doomed["id"].as_str().unwrap().to_string();

        let before = server.list_all_artifacts_for_gallery();
        assert_eq!(before.len(), 1);
        let ids_before: Vec<&str> = before[0]["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["id"].as_str().unwrap())
            .collect();
        assert!(ids_before.contains(&keep_id.as_str()));
        assert!(ids_before.contains(&doomed_id.as_str()));

        server
            .artifact_cancel("hm-cancel", "Codex-1", &doomed_id)
            .unwrap();

        let after = server.list_all_artifacts_for_gallery();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0]["harnessId"], json!("hm-cancel"));
        let arts = after[0]["artifacts"].as_array().unwrap();
        assert_eq!(arts.len(), 1);
        assert_eq!(arts[0]["id"], json!(keep_id));
        assert!(
            !arts
                .iter()
                .any(|a| a["id"].as_str() == Some(doomed_id.as_str())),
            "cancelled artifact must not appear in gallery listing"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn artifacts_contract_response(server: &HookServer) -> Response {
        let mut resp = Json(json!({
            "harnesses": server.list_all_artifacts_for_gallery(),
        }))
        .into_response();
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        resp
    }

    async fn artifacts_response(server: &HookServer) -> (StatusCode, Option<String>, Value) {
        let resp = artifacts_contract_response(server);
        let status = resp.status();
        let cache_control = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("response body should read");
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("response body should be JSON")
        };
        (status, cache_control, body)
    }

    #[tokio::test]
    async fn gallery_and_artifacts_routes_return_expected_shapes() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-gal-route-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-route", Some(tmp.to_string_lossy().to_string()));
        let issued = server
            .artifact_new("hm-route", "Claude-1", "Route test")
            .unwrap();
        let artifact_id = issued["id"].as_str().unwrap().to_string();
        let token = issued["feedbackToken"].as_str().unwrap().to_string();

        let resp = handle_gallery().await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            resp.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );

        let (status, cache_control, body) = artifacts_response(&server).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cache_control.as_deref(), Some("no-store"));
        assert_eq!(body["harnesses"].as_array().unwrap().len(), 1);
        assert_eq!(body["harnesses"][0]["harnessId"], json!("hm-route"));
        assert_eq!(
            body["harnesses"][0]["artifacts"][0]["id"],
            json!(artifact_id)
        );
        assert_eq!(
            body["harnesses"][0]["artifacts"][0]["state"],
            json!("pending")
        );
        assert_eq!(body["harnesses"][0]["artifacts"][0]["token"], json!(token));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn artifact_cancel_drops_feedback_token() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-fb-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-10", Some(tmp.to_string_lossy().to_string()));
        let issued = server.artifact_new("hm-10", "Claude-1", "scratch").unwrap();
        let id = issued["id"].as_str().unwrap().to_string();
        let token = issued["feedbackToken"].as_str().unwrap().to_string();
        server.artifact_cancel("hm-10", "Claude-1", &id).unwrap();
        // cancel removes the token entirely → Unknown (the artifact never existed
        // for a fresh viewer), not Revoked.
        assert!(matches!(
            server.lookup_feedback_token(&token),
            FeedbackLookup::Unknown
        ));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn artifact_validate_rejects_symlink() {
        let tmp = std::env::temp_dir().join(format!("krypton-art-{}", rand_suffix()));
        let root = tmp.join(".krypton/artifacts");
        let lane_dir = root.join("hm-1").join("Claude-1");
        std::fs::create_dir_all(&lane_dir).unwrap();
        let target = tmp.join("secret.html");
        std::fs::write(&target, "<html>secret</html>").unwrap();
        let link = lane_dir.join("art-1-deadbeef.html");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let res =
                validate_artifact_file(&root, &link, "art-1-deadbeef", ARTIFACT_FILE_BYTES_MAX);
            assert!(res.is_err(), "symlinked artifact file must be rejected");
            assert!(res.unwrap_err().contains("symlink"));
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn artifact_validate_enforces_size_cap() {
        let tmp = std::env::temp_dir().join(format!("krypton-art-{}", rand_suffix()));
        let root = tmp.join(".krypton/artifacts");
        let lane_dir = root.join("hm-1").join("Claude-1");
        std::fs::create_dir_all(&lane_dir).unwrap();
        let file = lane_dir.join("art-9-cafef00d.html");
        std::fs::write(&file, "<html></html>").unwrap();
        let res = validate_artifact_file(&root, &file, "art-9-cafef00d", 4);
        assert!(res.is_err(), "over-cap file must be rejected");
        assert!(res.unwrap_err().contains("size_cap"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn artifact_new_enforces_pending_cap() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-art-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts("hm-1", Some(tmp.to_string_lossy().to_string()));
        for _ in 0..ARTIFACT_PENDING_PER_LANE_MAX {
            server.artifact_new("hm-1", "Claude-1", "t").unwrap();
        }
        // One more pending for the same lane must be rejected.
        let err = server.artifact_new("hm-1", "Claude-1", "t").unwrap_err();
        assert!(err.contains("pending_cap"), "got: {err}");
        // A different lane is unaffected by Claude-1's pending count.
        assert!(server.artifact_new("hm-1", "Codex-1", "t").is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // handoff_set no longer rejects an over-long `summary` — it clips it to a
    // headline server-side, so the model never hits a retry loop trying (and
    // failing) to self-count code points.
    #[test]
    fn clamp_headline_passes_short_unchanged() {
        let s = "#727 RE-AUDIT DONE";
        assert_eq!(clamp_headline(s, MEMORY_SUMMARY_MAX), s);
        // Exactly at the cap is kept verbatim (no ellipsis).
        let at_cap: String = "x".repeat(MEMORY_SUMMARY_MAX);
        assert_eq!(clamp_headline(&at_cap, MEMORY_SUMMARY_MAX), at_cap);
    }

    #[test]
    fn clamp_headline_clips_oversize_to_cap_with_ellipsis() {
        let over: String = "a".repeat(MEMORY_SUMMARY_MAX + 200);
        let clamped = clamp_headline(&over, MEMORY_SUMMARY_MAX);
        assert_eq!(clamped.chars().count(), MEMORY_SUMMARY_MAX);
        assert!(
            clamped.ends_with('\u{2026}'),
            "clipped headline marks itself"
        );
    }

    #[test]
    fn clamp_headline_counts_code_points_not_bytes() {
        // Thai counts as one code point each but several UTF-8 bytes — the cap
        // is code points (`chars().count()`), and the result stays valid UTF-8.
        let thai: String = "ก".repeat(MEMORY_SUMMARY_MAX + 50);
        let clamped = clamp_headline(&thai, MEMORY_SUMMARY_MAX);
        assert_eq!(clamped.chars().count(), MEMORY_SUMMARY_MAX);
        assert!(clamped.ends_with('\u{2026}'));
        // Byte length far exceeds the code-point cap — proof we clipped by chars.
        assert!(clamped.len() > MEMORY_SUMMARY_MAX);
    }
}

// spec 145 — focused tests for the shared git-state collector. They run real
// `git` in a throwaway repo to lock the edge cases the rewrite is meant to fix:
// non-git dirs, tracked diff + diffstat, untracked excerpts, unborn HEAD (incl.
// the `AM` staged-then-edited case), and the UTF-8 payload cap.
#[cfg(test)]
mod git_state_tests {
    use super::*;
    use crate::review_excerpt::RvAnchor;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn temp_repo() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("krypton-git-{}-{n}", rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        dir
    }

    fn collect(dir: &Path) -> Value {
        collect_git_state(Some(dir.to_str().unwrap()))
    }

    #[test]
    fn no_cwd_and_non_git_dir_report_no_repo() {
        assert_eq!(collect_git_state(None)["hasGitRepo"], json!(false));
        let dir = std::env::temp_dir().join(format!("krypton-nogit-{}", rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let v = collect(&dir);
        assert_eq!(v["hasGitRepo"], json!(false));
        assert_eq!(v["isUnbornHead"], json!(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tracked_modification_yields_diffstat_and_diff() {
        let dir = temp_repo();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-qm", "init"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();

        let v = collect(&dir);
        assert_eq!(v["hasGitRepo"], json!(true));
        assert_eq!(v["isUnbornHead"], json!(false));
        let diffstat = v["diffstat"].as_array().unwrap();
        assert_eq!(diffstat.len(), 1);
        assert_eq!(diffstat[0]["path"], json!("a.txt"));
        assert_eq!(diffstat[0]["status"], json!("M"));
        assert!(v["diff"].as_str().unwrap().contains("+three"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn untracked_file_appears_as_excerpt_and_diffstat_entry() {
        let dir = temp_repo();
        std::fs::write(dir.join("seed"), "x").unwrap();
        git(&dir, &["add", "seed"]);
        git(&dir, &["commit", "-qm", "seed"]);
        std::fs::write(dir.join("new.txt"), "fresh content\n").unwrap();

        let v = collect(&dir);
        let untracked = v["untracked"].as_array().unwrap();
        assert_eq!(untracked.len(), 1);
        assert_eq!(untracked[0]["path"], json!("new.txt"));
        assert!(untracked[0]["head"]
            .as_str()
            .unwrap()
            .contains("fresh content"));
        let diffstat = v["diffstat"].as_array().unwrap();
        assert!(diffstat
            .iter()
            .any(|e| e["path"] == json!("new.txt") && e["status"] == json!("?")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unborn_head_captures_staged_then_modified_file() {
        // B2: a file added then edited (`AM`) keeps its unstaged content because
        // the collector diffs the working tree against the empty tree, not --cached.
        let dir = temp_repo();
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        std::fs::write(dir.join("a.txt"), "staged\nthen-unstaged\n").unwrap();

        let v = collect(&dir);
        assert_eq!(v["hasGitRepo"], json!(true));
        assert_eq!(v["isUnbornHead"], json!(true));
        let diff = v["diff"].as_str().unwrap();
        assert!(diff.contains("+staged"), "diff missing staged line: {diff}");
        assert!(
            diff.contains("+then-unstaged"),
            "unborn-HEAD diff dropped the unstaged edit: {diff}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn large_diff_is_capped_on_a_utf8_boundary_with_marker_inside_cap() {
        const CAP: usize = 40_960;
        let dir = temp_repo();
        std::fs::write(dir.join("a.txt"), "seed\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-qm", "init"]);
        // A multibyte body well over the cap to exercise the UTF-8-safe truncation.
        let big: String = "กข\n".repeat(40_000);
        std::fs::write(dir.join("a.txt"), big).unwrap();

        let v = collect(&dir);
        let diff = v["diff"].as_str().unwrap();
        assert!(diff.len() <= CAP, "diff {} exceeds cap {CAP}", diff.len());
        assert!(diff.contains("truncated"), "truncation marker missing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── Issue Analysis Viewer (spec 192) ───────────────────────────────────

    /// Build `<tmp>/.krypton/analyses/<owner>/<repo>/<number>/<file>` = `body`.
    fn seed_analysis_file(
        root: &StdPath,
        owner: &str,
        repo: &str,
        number: &str,
        file: &str,
        body: &str,
    ) {
        let dir = root
            .join(".krypton")
            .join("analyses")
            .join(owner)
            .join(repo)
            .join(number);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), body).unwrap();
    }

    #[test]
    fn discover_analysis_bundles_orders_and_classifies() {
        // Distinct per-test infix: rand_suffix() is only sub-second nanos (no
        // counter), so same-prefix tests could otherwise collide under parallelism.
        let tmp = std::env::temp_dir().join(format!("krypton-analyses-disc-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        // Issue 12: three md files (out-of-order names) + an image asset.
        seed_analysis_file(&tmp, "acme", "widget", "12", "notes.md", "n");
        seed_analysis_file(&tmp, "acme", "widget", "12", "fix-plan.md", "f");
        seed_analysis_file(&tmp, "acme", "widget", "12", "root-cause.md", "r");
        seed_analysis_file(&tmp, "acme", "widget", "12", "shot.png", "img");
        // Issue 9: one md file.
        seed_analysis_file(&tmp, "acme", "widget", "9", "root-cause.md", "r");
        // Empty leaf (no files) must be skipped.
        std::fs::create_dir_all(tmp.join(".krypton/analyses/acme/widget/1")).unwrap();

        let bundles = discover_analysis_bundles(&tmp.to_string_lossy());
        assert_eq!(bundles.len(), 2, "empty leaf skipped, two real bundles");
        // Newest issue number first.
        assert_eq!(bundles[0].number, "12");
        assert_eq!(bundles[1].number, "9");
        assert_eq!(bundles[0].issue_key, "acme/widget#12");
        // md order: root-cause, fix-plan, then the rest alphabetically.
        let names: Vec<&str> = bundles[0]
            .md_files
            .iter()
            .map(|p| p.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(names, vec!["root-cause.md", "fix-plan.md", "notes.md"]);
        // The image is an asset, not an md file.
        assert_eq!(bundles[0].assets.len(), 1);
        assert!(bundles[0].assets[0].rel.ends_with("shot.png"));
        assert_eq!(bundles[0].assets[0].size, 3, "\"img\" is 3 bytes");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn render_analyses_index_and_nav_link_to_analysis() {
        let tmp = std::env::temp_dir().join(format!("krypton-analyses-idx-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        seed_analysis_file(&tmp, "acme", "widget", "12", "root-cause.md", "r");
        let bundles = discover_analysis_bundles(&tmp.to_string_lossy());

        let index = render_analyses_index("hm-1", &bundles);
        assert!(
            index.contains("acme/widget#12"),
            "index shows the issue key: {index}"
        );
        assert!(
            index.contains("/analysis?harness=hm-1&amp;issue=acme%2Fwidget%2F12"),
            "index row links to the bundle page: {index}"
        );
        assert!(
            index.contains("https://github.com/acme/widget/issues/12"),
            "index row has a GitHub deep link: {index}"
        );

        let per = vec![(
            "hm-1".to_string(),
            tmp.to_string_lossy().to_string(),
            bundles,
        )];
        let nav = render_analyses_nav(&per, "hm-1", "acme/widget/12");
        assert!(nav.contains("acme/widget"), "sidebar groups by repo: {nav}");
        assert!(
            nav.contains("class=\"is-active\""),
            "current issue is highlighted: {nav}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn render_analyses_page_substitutes_placeholders() {
        let page = render_analyses_page(
            "Issue analyses · hm-1",
            Some("<ul class=\"tree\"></ul>"),
            "<p>hi</p>",
        );
        let body = String::from_utf8(
            axum::body::to_bytes(page.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(body.contains("<title>Issue analyses · hm-1</title>"));
        assert!(body.contains("<p>hi</p>"));
        assert!(
            body.contains("<ul class=\"tree\">"),
            "tree injected: {body}"
        );
        // The real placeholder tokens are fully replaced (the bare words survive
        // in the shell's explanatory comment, exactly as the docs shell does).
        assert!(!body.contains("<!--ANALYSES_CONTENT-->"));
        assert!(!body.contains("<!--ANALYSES_TREE-->"));
        assert!(!body.contains("<!--ANALYSES_TITLE-->"));
    }

    #[test]
    fn render_analysis_bundle_renders_md_and_sized_attachments() {
        let tmp = std::env::temp_dir().join(format!("krypton-analyses-bundle-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        seed_analysis_file(
            &tmp,
            "acme",
            "widget",
            "12",
            "root-cause.md",
            "# หัวข้อ\n\nเนื้อหา",
        );
        seed_analysis_file(&tmp, "acme", "widget", "12", "shot.png", "img");
        seed_analysis_file(
            &tmp,
            "acme",
            "widget",
            "12",
            "console.log",
            "x".repeat(2048).as_str(),
        );
        let bundles = discover_analysis_bundles(&tmp.to_string_lossy());
        let html = render_analysis_bundle(
            &tmp.to_string_lossy(),
            "hm-1",
            &bundles[0],
            bundles[0].md_files.first().map(String::as_str),
        );

        assert!(html.contains("root-cause.md"), "md filename header: {html}");
        assert!(
            !html.contains("file-strip"),
            "single-file bundle has no file strip: {html}"
        );
        assert!(html.contains("หัวข้อ"), "rendered md body: {html}");
        // Image attachment rides the analysis-asset route.
        assert!(
            html.contains("src=\"/analysis-asset?harness=hm-1&amp;path="),
            "image uses /analysis-asset: {html}"
        );
        // Non-image attachment shows name + human size (spec §UI).
        assert!(html.contains("console.log"), "non-image name shown: {html}");
        assert!(html.contains("2 KB"), "non-image size shown: {html}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn render_analysis_bundle_renders_one_selected_file_with_strip() {
        let tmp = std::env::temp_dir().join(format!("krypton-analyses-sel-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        seed_analysis_file(&tmp, "acme", "widget", "12", "root-cause.md", "สาเหตุ");
        seed_analysis_file(&tmp, "acme", "widget", "12", "fix-plan.md", "แผนแก้");
        seed_analysis_file(&tmp, "acme", "widget", "12", "notes.md", "โน้ต");
        let bundles = discover_analysis_bundles(&tmp.to_string_lossy());
        let dir = tmp.to_string_lossy();

        // Default selection (first in bundle order) renders root-cause only.
        let html = render_analysis_bundle(
            &dir,
            "hm-1",
            &bundles[0],
            bundles[0].md_files.first().map(String::as_str),
        );
        assert!(html.contains("สาเหตุ"), "selected file rendered: {html}");
        assert!(
            !html.contains("แผนแก้") && !html.contains("โน้ต"),
            "other files are not rendered: {html}"
        );
        // The strip lists every file with a file= link; the selected one is active.
        assert!(
            html.contains("file-strip"),
            "multi-file strip shown: {html}"
        );
        assert!(
            html.contains("&amp;file=fix-plan.md") && html.contains("&amp;file=notes.md"),
            "strip links carry the file param: {html}"
        );
        let active = html
            .split("<a class=\"is-active\"")
            .nth(1)
            .expect("one active strip entry");
        assert!(
            active.contains("file=root-cause.md"),
            "default selection is the first file: {html}"
        );

        // Selecting another file renders that file instead.
        let sel = bundles[0]
            .md_files
            .iter()
            .find(|rel| rel.ends_with("notes.md"))
            .unwrap();
        let html = render_analysis_bundle(&dir, "hm-1", &bundles[0], Some(sel));
        assert!(html.contains("โน้ต"), "notes.md rendered: {html}");
        assert!(!html.contains("สาเหตุ"), "root-cause not rendered: {html}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn analysis_markdown_inline_image_uses_analysis_asset_route() {
        // An image embedded in analysis markdown must route to /analysis-asset,
        // not the docs browser's /doc-asset (spec 192; the two routes differ in
        // scope + policy).
        let html = render_markdown_doc(
            "![cap](shot.png)",
            "hm-1",
            "root-cause.md",
            "/analysis-asset",
        );
        assert!(
            html.contains("/analysis-asset?"),
            "inline image route: {html}"
        );
        assert!(
            !html.contains("/doc-asset?"),
            "must not use /doc-asset: {html}"
        );
    }

    #[test]
    fn human_size_formats_units() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2 KB");
        assert_eq!(human_size(3 * 1024 * 1024), "3.0 MB");
    }

    // ─── Review Board (spec 211) ────────────────────────────────────────────

    /// A temp project dir with a review store registered. `rand_suffix()` is
    /// sub-second nanos only, so each test needs its own infix to avoid
    /// collisions under parallel runs.
    fn review_server(infix: &str) -> (HookServer, PathBuf, String) {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-rev-{infix}-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        let project = tmp.to_string_lossy().to_string();
        server.init_harness_reviews("hm-1", Some(project.clone()));
        (server, tmp, project)
    }

    /// A minimal but realistic review document: prose spine + one of each block.
    const SAMPLE_REVIEW_BODY: &str = "\
The change moves the per-target guard after the await.

```review:metrics
files: 6 changed, +214 / -38
new deps: none
```

```review:walkthrough
title: read it in this order
steps:
  - at: src/acp/inter-lane.ts:812
    say: the guard map
  - at: src/acp/lane-inbox.ts:96
    say: where the envelope lands
```

```review:finding
severity: blocking
file: src/acp/inter-lane.ts
line: 835
title: guard is set after the await
```
A second peer_send can enter between the check and the set.

```review:decision
question: per-target or global guard?
options:
  - per-target (today)
  - global
recommended: 2
```
";

    #[test]
    fn review_slug_is_directory_safe_and_readable() {
        assert_eq!(
            review_slug("Peering guard rewrite"),
            "peering-guard-rewrite"
        );
        // Punctuation collapses to a single dash; no leading/trailing dash.
        assert_eq!(review_slug("  ../etc/passwd  "), "etc-passwd");
        assert_eq!(review_slug("a//b::c"), "a-b-c");
        assert_eq!(
            review_slug("Spec 211 — Review Board!"),
            "spec-211-review-board"
        );
        // A title that reduces to nothing must not yield an empty path component.
        assert_eq!(review_slug("——"), "review");
        assert_eq!(review_slug("รีวิว"), "review");
        assert!(review_slug(&"x".repeat(200)).len() <= REVIEW_SLUG_MAX);
        // No path separators can survive, whatever the title.
        for title in ["../..", "a/b", "a\\b", "a\0b"] {
            let slug = review_slug(title);
            assert!(!slug.contains('/') && !slug.contains('\\') && !slug.contains('.'));
        }
    }

    #[test]
    fn review_lifecycle_new_write_register() {
        let (server, tmp, _project) = review_server("life");

        let issued = server
            .review_new(
                "hm-1",
                "Claude-1",
                "Peering guard rewrite",
                Some("the working diff"),
            )
            .unwrap();
        let id = issued["id"].as_str().unwrap().to_string();
        let slug = issued["slug"].as_str().unwrap().to_string();
        let dir = PathBuf::from(issued["dir"].as_str().unwrap());
        let path = PathBuf::from(issued["path"].as_str().unwrap());

        assert!(slug.ends_with("-peering-guard-rewrite"), "slug: {slug}");
        assert!(path.ends_with("review.md"));
        assert!(tmp.join(".krypton/reviews/.gitignore").exists());
        assert_eq!(issued["tail"], json!(format!(".krypton/reviews/{slug}/")));

        // The seeded stamp makes the bundle self-describing from the moment it
        // exists — a lane that dies now still leaves an attributable directory.
        let seeded = std::fs::read_to_string(&path).unwrap();
        assert!(seeded.starts_with("---\n"), "no frontmatter: {seeded}");
        assert!(seeded.contains("Peering guard rewrite"));
        assert!(seeded.contains("Claude-1"));
        assert!(seeded.contains("the working diff"));

        // Registering an unwritten review is refused: there is nothing to read.
        assert!(server
            .review_register("hm-1", "Claude-1", &id)
            .unwrap_err()
            .starts_with("empty:"));

        std::fs::write(&path, format!("{seeded}{SAMPLE_REVIEW_BODY}")).unwrap();
        let reg = server.review_register("hm-1", "Claude-1", &id).unwrap();
        assert_eq!(reg["ok"], json!(true));
        assert_eq!(
            reg["registered"],
            json!(true),
            "first register raises the card"
        );
        assert_eq!(reg["steps"], json!(2));
        assert_eq!(reg["findings"], json!(1));
        assert_eq!(reg["decisions"], json!(1));
        assert!(reg["blocks"].as_u64().unwrap() >= 6);

        // A repeat is an idempotent refresh that re-counts.
        std::fs::write(
            &path,
            format!("{seeded}{SAMPLE_REVIEW_BODY}\n```review:finding\ntitle: second\n```\n"),
        )
        .unwrap();
        let refreshed = server.refresh_review("hm-1", "Claude-1", &id).unwrap();
        assert_eq!(refreshed["registered"], json!(false));
        assert_eq!(refreshed["findings"], json!(2));

        // A registered review can never be cancelled — the bundle is a record.
        assert!(server
            .review_cancel("hm-1", "Claude-1", &id)
            .unwrap_err()
            .starts_with("already_registered:"));
        assert!(dir.exists());
    }

    #[test]
    fn review_new_suffixes_a_same_day_title_collision() {
        let (server, _tmp, _project) = review_server("collide");
        let a = server
            .review_new("hm-1", "Claude-1", "same title", None)
            .unwrap();
        let b = server
            .review_new("hm-1", "Claude-1", "same title", None)
            .unwrap();
        let c = server
            .review_new("hm-1", "Claude-2", "same title", None)
            .unwrap();
        let slugs: Vec<&str> = [&a, &b, &c]
            .iter()
            .map(|v| v["slug"].as_str().unwrap())
            .collect();
        assert_eq!(slugs[1], format!("{}-2", slugs[0]));
        assert_eq!(slugs[2], format!("{}-3", slugs[0]));
        // Two lanes composing concurrently get separate bundles by construction.
        for slug in &slugs {
            assert!(PathBuf::from(a["dir"].as_str().unwrap())
                .parent()
                .unwrap()
                .join(slug)
                .is_dir());
        }
    }

    #[test]
    fn review_cancel_reclaims_only_an_untouched_bundle() {
        let (server, _tmp, _project) = review_server("cancel");

        // An untouched draft is reclaimed.
        let empty = server
            .review_new("hm-1", "Claude-1", "abandoned", None)
            .unwrap();
        let empty_dir = PathBuf::from(empty["dir"].as_str().unwrap());
        server
            .review_cancel("hm-1", "Claude-1", empty["id"].as_str().unwrap())
            .unwrap();
        assert!(!empty_dir.exists(), "untouched bundle should be reclaimed");

        // A bundle the lane actually wrote into is KEPT: abandoning a draft must
        // never delete work.
        let written = server
            .review_new("hm-1", "Claude-1", "half written", None)
            .unwrap();
        let written_dir = PathBuf::from(written["dir"].as_str().unwrap());
        let written_path = PathBuf::from(written["path"].as_str().unwrap());
        let stamp = std::fs::read_to_string(&written_path).unwrap();
        std::fs::write(&written_path, format!("{stamp}Some real analysis.\n")).unwrap();
        server
            .review_cancel("hm-1", "Claude-1", written["id"].as_str().unwrap())
            .unwrap();
        assert!(written_dir.exists(), "written bundle must survive cancel");
        assert!(std::fs::read_to_string(&written_path)
            .unwrap()
            .contains("Some real analysis"));
    }

    #[test]
    fn review_new_enforces_pending_cap_per_lane() {
        let (server, _tmp, _project) = review_server("cap");
        for i in 0..REVIEW_PENDING_PER_LANE_MAX {
            server
                .review_new("hm-1", "Claude-1", &format!("draft {i}"), None)
                .unwrap();
        }
        assert!(server
            .review_new("hm-1", "Claude-1", "one too many", None)
            .unwrap_err()
            .starts_with("pending_cap:"));
        // The cap is per lane, not per harness.
        assert!(server
            .review_new("hm-1", "Claude-2", "other lane", None)
            .is_ok());
    }

    #[test]
    fn review_register_rejects_another_lanes_id_without_leaking_the_path() {
        let (server, _tmp, _project) = review_server("owner");
        let issued = server.review_new("hm-1", "Claude-1", "mine", None).unwrap();
        let id = issued["id"].as_str().unwrap();
        let err = server.review_register("hm-1", "Codex-2", id).unwrap_err();
        assert!(err.starts_with("not_found:"), "{err}");
        assert!(!err.contains(".krypton"), "path leaked: {err}");
    }

    #[test]
    fn review_validate_rejects_a_symlinked_bundle() {
        let (server, tmp, _project) = review_server("symlink");
        let issued = server
            .review_new("hm-1", "Claude-1", "linked", None)
            .unwrap();
        let id = issued["id"].as_str().unwrap();
        let path = PathBuf::from(issued["path"].as_str().unwrap());
        let slug = issued["slug"].as_str().unwrap();

        // Swap review.md for a symlink pointing outside the bundle.
        let outside = tmp.join("outside.md");
        std::fs::write(&outside, "# not mine\n\nreal content here\n").unwrap();
        std::fs::remove_file(&path).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &path).unwrap();

        let err = server.review_register("hm-1", "Claude-1", id).unwrap_err();
        assert!(err.starts_with("symlink_rejected:"), "{err}");

        // And a symlinked BUNDLE DIRECTORY is refused too.
        let root = reviews_root(&tmp.to_string_lossy()).unwrap();
        assert!(validate_review_file(
            &root,
            &root.join(slug).join("review.md"),
            slug,
            REVIEW_FILE_BYTES_MAX
        )
        .is_err());
    }

    #[test]
    fn review_validate_enforces_the_size_cap() {
        let (server, _tmp, _project) = review_server("size");
        let issued = server.review_new("hm-1", "Claude-1", "big", None).unwrap();
        let path = PathBuf::from(issued["path"].as_str().unwrap());
        std::fs::write(&path, "x".repeat(64)).unwrap();
        let root = reviews_root(
            &PathBuf::from(issued["dir"].as_str().unwrap())
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_string_lossy(),
        )
        .unwrap();
        let err =
            validate_review_file(&root, &path, issued["slug"].as_str().unwrap(), 10).unwrap_err();
        assert!(err.starts_with("size_cap:"), "{err}");
    }

    #[test]
    fn count_review_blocks_is_fence_aware() {
        let counts = count_review_blocks(SAMPLE_REVIEW_BODY);
        assert_eq!(counts.steps, 2);
        assert_eq!(counts.findings, 1);
        assert_eq!(counts.decisions, 1);

        // A fence NAME mentioned in prose must not be counted as a block.
        let prose = "Call it with a ```review:finding fence.\n";
        assert_eq!(count_review_blocks(prose).findings, 0);

        // The frontmatter stamp is metadata, not a block.
        assert_eq!(count_review_blocks("---\ntitle: x\n---\n").blocks, 0);

        // A nested fence inside a typed block cannot open a phantom one, and a
        // `- at:` outside a walkthrough is not a step.
        let nested = "````review:finding\ntitle: outer\n```review:decision\nquestion: no\n```\n````\n- at: a.ts:1\n";
        let c = count_review_blocks(nested);
        assert_eq!(c.findings, 1);
        assert_eq!(c.decisions, 0);
        assert_eq!(c.steps, 0);
    }

    #[test]
    fn discover_review_bundles_orders_newest_first_and_reads_status() {
        let (_server, tmp, project) = review_server("discover");
        let root = tmp.join(".krypton/reviews");

        let seed = |slug: &str, body: &str, response: Option<&str>| {
            let dir = root.join(slug);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("review.md"), body).unwrap();
            if let Some(response) = response {
                std::fs::write(dir.join("response.md"), response).unwrap();
            }
            dir
        };

        let stamp = |title: &str, lane: &str| {
            format!("---\ntitle: {title}\nlane: {lane}\ncreated: 2026-08-05T10:00:00Z\n---\n\n")
        };

        seed(
            "2026-07-30-older",
            &format!("{}{SAMPLE_REVIEW_BODY}", stamp("older review", "Codex-1")),
            None,
        );
        seed(
            "2026-08-07-newest",
            &format!("{}{SAMPLE_REVIEW_BODY}", stamp("newest review", "Claude-1")),
            Some("---\nreview: x\nresponded_at: \"2026-08-07T14:00:00Z\"\nsent_at: \"2026-08-07T15:00:00Z\"\nfindings:\n  - block: b1\n    state: accepted\ndecisions:\n  - block: b2\n    chosen: 1\n---\n"),
        );
        seed(
            "2026-08-05-reference",
            // No findings, no decisions — the comprehension case.
            &format!(
                "{}Just an explanation.\n",
                stamp("reference review", "Claude-2")
            ),
            None,
        );
        // A bundle the lane created and never wrote into.
        seed(
            "2026-08-06-uncomposed",
            "---\ntitle: never written\n---\n",
            None,
        );

        let bundles = discover_review_bundles(&project);
        assert_eq!(
            bundles.iter().map(|b| b.slug.as_str()).collect::<Vec<_>>(),
            vec![
                "2026-08-07-newest",
                "2026-08-06-uncomposed",
                "2026-08-05-reference",
                "2026-07-30-older",
            ],
            "newest first"
        );

        let newest = &bundles[0];
        assert_eq!(newest.title, "newest review");
        assert_eq!(newest.lane_name, "Claude-1");
        assert_eq!(newest.status_label(), "sent");
        // Both answerable blocks were answered.
        assert_eq!(newest.unanswered(), 0);

        assert_eq!(bundles[1].status_label(), "never composed");
        assert!(!bundles[1].composed);

        // Nothing to answer ⇒ `reference`, not a completion status.
        assert_eq!(bundles[2].status_label(), "reference");
        assert_eq!(bundles[2].unanswered(), 0);

        // Composed, answerable, never opened.
        assert_eq!(bundles[3].status_label(), "never opened");
        assert_eq!(bundles[3].unanswered(), 2);
    }

    #[test]
    fn review_bundle_page_renders_typed_blocks_semantically() {
        let (_server, tmp, project) = review_server("render");
        let dir = tmp.join(".krypton/reviews/2026-08-07-guard");
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(
            dir.join("review.md"),
            format!(
                "---\ntitle: guard rewrite\nlane: Claude-1\n---\n\n{SAMPLE_REVIEW_BODY}\n```review:chart\nkind: bar\ntitle: lines changed\ndata:\n  acp/: 152\n  diff-view: 41\n```\n\n```diff\n@@ -1 +1 @@\n-old\n+new\n```\n"
            ),
        )
        .unwrap();
        std::fs::write(dir.join("assets").join("diagram.png"), b"fake").unwrap();

        let bundles = discover_review_bundles(&project);
        let bundle = bundles
            .iter()
            .find(|b| b.slug == "2026-08-07-guard")
            .unwrap();
        let html = render_review_bundle("hm-1", &project, bundle, "review");

        // Walkthrough → an ordered list with monospace anchors (plain text: no
        // jump target exists outside the app).
        assert!(html.contains("<ol class=\"rv-steps\">"), "{html}");
        assert!(html.contains("src/acp/inter-lane.ts:812"));
        // Finding → a bordered card with the severity in the heading colour.
        assert!(html.contains("rv-finding--blocking"));
        assert!(html.contains(">BLOCK<"));
        assert!(html.contains("src/acp/inter-lane.ts:835"));
        // Decision → an ordered list with the recommendation marked.
        assert!(html.contains("<ol class=\"rv-options\">"));
        assert!(html.contains("class=\"is-chosen\""));
        // Metrics → a definition strip.
        assert!(html.contains("<dl class=\"rv-metrics\">"));
        // Chart → proportional CSS bars, not the frontend's SVG geometry.
        assert!(html.contains("rv-chart__bar"));
        assert!(
            html.contains("width:100.0%"),
            "largest bar is full width: {html}"
        );
        assert!(!html.contains("<svg"), "no SVG geometry in the archive");
        // Diff → prefix-coloured lines.
        assert!(html.contains("rv-diff__add"));
        assert!(html.contains("rv-diff__del"));
        // The frontmatter renders as the shared metadata card.
        assert!(html.contains("dl class=\"frontmatter\""));
        // Asset strip uses this surface's own route.
        assert!(html.contains("/review-asset?"));
        assert!(!html.contains("/doc-asset?"));
        // No left accent rails anywhere (house rule).
        assert!(!html.contains("border-left"), "left rail leaked: {html}");
    }

    #[test]
    fn rv_anchor_reads_path_line_and_range() {
        assert_eq!(
            rv_anchor("src/acp/inter-lane.ts"),
            Some(RvAnchor {
                rel: "src/acp/inter-lane.ts".into(),
                start: None,
                end: None
            })
        );
        assert_eq!(
            rv_anchor("`./src/x.rs:835`"),
            Some(RvAnchor {
                rel: "src/x.rs".into(),
                start: Some(835),
                end: None
            })
        );
        assert_eq!(
            rv_anchor("src/x.rs:812-840"),
            Some(RvAnchor {
                rel: "src/x.rs".into(),
                start: Some(812),
                end: Some(840)
            })
        );
        // Prose is never treated as a path, and a trailing colon that is not a
        // line span leaves the whole string as the path (which then fails the
        // extension guard rather than reading something unexpected).
        assert_eq!(rv_anchor("the guard map, roughly"), None);
        assert_eq!(rv_anchor(""), None);
        assert_eq!(rv_anchor("src/x.rs:head"), None);
    }

    /// Seed a project with one source file and a review that anchors into it.
    fn excerpt_fixture(infix: &str, review_body: &str) -> (HookServer, PathBuf, String, String) {
        let (server, tmp, project) = review_server(infix);
        let src = tmp.join("src/acp");
        std::fs::create_dir_all(&src).unwrap();
        let lines: Vec<String> = (1..=100).map(|n| format!("const line{n} = {n};")).collect();
        std::fs::write(src.join("inter-lane.ts"), lines.join("\n")).unwrap();

        let dir = tmp.join(".krypton/reviews/2026-08-07-excerpt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("review.md"),
            format!("---\ntitle: excerpt\nlane: Claude-1\ncreated: 2020-01-01T00:00:00Z\n---\n\n{review_body}\n"),
        )
        .unwrap();
        let bundles = discover_review_bundles(&project);
        let bundle = bundles
            .iter()
            .find(|b| b.slug == "2026-08-07-excerpt")
            .unwrap();
        let html = render_review_bundle("hm-1", &project, bundle, "review");
        (server, tmp, project, html)
    }

    #[test]
    fn review_excerpt_renders_source_under_an_anchor() {
        let (_s, tmp, _p, html) = excerpt_fixture(
            "src",
            "```review:walkthrough\nsteps:\n  - at: src/acp/inter-lane.ts:12\n    say: the guard map\n```\n\n```review:finding\nseverity: blocking\nfile: src/acp/inter-lane.ts\nline: 40\ntitle: guard is set after the await\n```\n",
        );

        // Both the step and the finding carry their code.
        assert_eq!(html.matches("rv-src__head").count(), 2, "{html}");
        // ±6 lines of context around line 12, with the anchored row tinted.
        assert!(html.contains("src/acp/inter-lane.ts:6-18"), "{html}");
        assert!(html.contains("rv-src__line--anchor"));
        assert!(html.contains("const line12 = 12;"));
        assert!(html.contains("const line6 = 6;"));
        assert!(!html.contains("const line5 = 5;"));
        // The gutter carries real line numbers.
        assert!(html.contains("<span class=\"rv-src__ln\">12</span>"));
        // The file was written after the review's `created` stamp.
        assert!(html.contains("rv-src--stale"));
        // House rule: no left accent rails anywhere on this page.
        assert!(!html.contains("border-left"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn review_walkthrough_reads_flush_left_list_items() {
        // The shape lanes actually write: `- at:` at column zero with an indented
        // `say:` under it. Both are valid YAML, and requiring the indent used to
        // drop every anchor on this page.
        let (_s, tmp, _p, html) = excerpt_fixture(
            "flush",
            "```review:walkthrough\ntitle: read it in this order\nsteps:\n- at: src/acp/inter-lane.ts:12\n  say: the guard map\n- at: src/acp/inter-lane.ts:40\n  say: the send path\n```\n",
        );
        assert!(html.contains("src/acp/inter-lane.ts:12"), "{html}");
        assert!(html.contains("src/acp/inter-lane.ts:40"), "{html}");
        assert!(html.contains("the guard map"));
        assert_eq!(html.matches("rv-src__head").count(), 2, "{html}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn review_excerpt_clamps_a_long_range() {
        let (_s, tmp, _p, html) = excerpt_fixture(
            "range",
            "```review:walkthrough\nsteps:\n  - at: src/acp/inter-lane.ts:1-100\n    say: the whole file\n```\n",
        );
        assert!(html.contains("src/acp/inter-lane.ts:1-40"), "{html}");
        assert!(html.contains("อีก 60 บรรทัด"), "{html}");
        assert!(!html.contains("const line41 = 41;"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn review_excerpt_reports_a_drifted_anchor() {
        let (_s, tmp, _p, html) = excerpt_fixture(
            "drift",
            "```review:finding\nseverity: suggestion\nfile: src/acp/inter-lane.ts\nline: 4200\ntitle: gone\n```\n",
        );
        assert!(html.contains("rv-src--drifted"), "{html}");
        assert!(html.contains("100 บรรทัด"), "{html}");
        assert!(!html.contains("rv-src__line"), "no lines are guessed at");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn review_excerpt_refuses_paths_the_repo_does_not_track() {
        let (_server, tmp, project) = review_server("guard");
        std::fs::write(tmp.join(".gitignore"), "secret/\n*.env\n").unwrap();
        std::fs::create_dir_all(tmp.join("secret")).unwrap();
        std::fs::write(tmp.join("secret/keys.ts"), "export const KEY = 'sk-live';").unwrap();
        std::fs::write(tmp.join("prod.env"), "TOKEN=hunter2").unwrap();
        std::fs::write(tmp.join("notes.bin"), "binary-ish").unwrap();
        // A real file one level above the project root.
        std::fs::write(tmp.join("../outside-krypton-test.ts"), "const x = 1;").ok();

        let dir = tmp.join(".krypton/reviews/2026-08-07-guard");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("review.md"),
            "---\ntitle: guard\nlane: Claude-1\n---\n\n```review:walkthrough\nsteps:\n  - at: secret/keys.ts:1\n    say: gitignored\n  - at: prod.env:1\n    say: gitignored by pattern\n  - at: notes.bin:1\n    say: extension not allowed\n  - at: ../outside-krypton-test.ts:1\n    say: outside the project\n  - at: .krypton/reviews/2026-08-07-guard/review.md:1\n    say: the review bundle itself\n```\n",
        )
        .unwrap();

        let bundles = discover_review_bundles(&project);
        let bundle = bundles.iter().find(|b| b.slug.ends_with("guard")).unwrap();
        let html = render_review_bundle("hm-1", &project, bundle, "review");

        assert!(
            !html.contains("rv-src__head"),
            "no excerpt was rendered: {html}"
        );
        assert!(!html.contains("sk-live"));
        assert!(!html.contains("hunter2"));
        // The steps themselves still read normally.
        assert!(html.contains("gitignored"));
        assert!(html.contains("outside the project"));
        let _ = std::fs::remove_file(tmp.join("../outside-krypton-test.ts"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn review_bundle_page_carries_review_and_response_together() {
        let (_server, tmp, project) = review_server("onepage");
        let dir = tmp.join(".krypton/reviews/2026-08-07-both");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("review.md"),
            "---\ntitle: both\nlane: Claude-1\n---\n\nthe explanation.\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("response.md"),
            "---\nresponded_at: 2026-08-08T14:22:10Z\nnote: ship it\n---\n\n## Answers\n- accepted\n",
        )
        .unwrap();

        let bundles = discover_review_bundles(&project);
        let bundle = bundles.iter().find(|b| b.slug.ends_with("both")).unwrap();
        let html = render_review_bundle("hm-1", &project, bundle, "review");

        // One page, two sections — the strip scrolls instead of navigating.
        assert!(html.contains("id=\"rv-review\""), "{html}");
        assert!(html.contains("id=\"rv-answers\""), "{html}");
        assert!(html.contains("href=\"#rv-answers\""));
        assert!(
            !html.contains("&amp;file="),
            "no cross-page file links left"
        );
        assert!(html.contains("the explanation."));
        assert!(html.contains("Answers"));
        assert!(html.contains("ship it"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn review_blocks_leave_unknown_fences_as_code() {
        // An ordinary code fence is untouched.
        let ts = render_review_blocks(
            "<pre><code class=\"language-ts\">const a = 1;</code></pre>",
            &mut None,
        );
        assert_eq!(
            ts,
            "<pre><code class=\"language-ts\">const a = 1;</code></pre>"
        );

        // A future `review:*` kind renders as a labelled code block rather than
        // disappearing.
        let unknown = render_review_blocks(
            "<pre><code class=\"language-review:hologram\">x</code></pre>",
            &mut None,
        );
        assert!(unknown.contains("rv-unknown"));
        assert!(unknown.contains("review:hologram"));
        assert!(unknown.contains("<pre><code>x</code></pre>"));

        // Surrounding prose survives, and a fence with no class is left alone.
        let mixed = render_review_blocks(
            "<p>before</p><pre><code class=\"language-review:metrics\">a: 1</code></pre><p>after</p>",
            &mut None,
        );
        assert!(mixed.starts_with("<p>before</p>"));
        assert!(mixed.ends_with("<p>after</p>"));
        assert!(mixed.contains("rv-metrics"));
    }

    #[test]
    fn review_svg_block_refuses_active_content() {
        for hostile in [
            "<svg><script>alert(1)</script></svg>",
            "<svg><foreignObject><body onload=\"x\"></body></foreignObject></svg>",
            "<svg onload=\"alert(1)\"><rect/></svg>",
            "<svg onload = \"alert(1)\"><rect/></svg>",
            "<svg\n  onload=\"alert(1)\"><rect/></svg>",
            "<svg><rect onclick='x'/></svg>",
            "<svg><animate onbegin=\"alert(1)\"/></svg>",
            "<svg><image xlink:href=\"https://evil.test/x.png\"/></svg>",
            "<svg><rect fill=\"url(https://evil.test/g)\"/></svg>",
            "<svg><a href=\"javascript:alert(1)\">x</a></svg>",
            "<div>not an svg at all</div>",
        ] {
            let html = render_rv_svg(hostile);
            assert!(
                html.contains("not rendered"),
                "should have been refused: {hostile}"
            );
            // Refused markup is shown as ESCAPED source, never live.
            assert!(!html.contains("<script"), "live script leaked: {html}");
            assert!(html.contains("&lt;") || !hostile.contains('<'));
        }

        // A plain static diagram passes through.
        let ok =
            render_rv_svg("<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>");
        assert!(ok.starts_with("<div class=\"rv-svg\">"), "{ok}");
        assert!(ok.contains("<rect"));
    }

    #[test]
    fn review_bundle_file_commands_guard_the_path() {
        let (server, tmp, _project) = review_server("guard");
        let issued = server
            .review_new("hm-1", "Claude-1", "guarded", None)
            .unwrap();
        let dir = issued["dir"].as_str().unwrap().to_string();

        // A real bundle round-trips.
        let written = server
            .write_review_response(&dir, "---\nreview: x\n---\n\nbody\n")
            .unwrap();
        assert_eq!(written["ok"], json!(true));
        let read = server.read_review_bundle(&dir).unwrap();
        assert_eq!(read["slug"], json!(issued["slug"].as_str().unwrap()));
        assert!(read["review"].as_str().unwrap().contains("guarded"));
        assert!(read["response"].as_str().unwrap().contains("body"));

        // Anything that is not a bundle directory one level under a review root
        // is refused — the project root, the review root itself, `assets/`, and
        // an unrelated directory.
        std::fs::create_dir_all(PathBuf::from(&dir).join("assets")).unwrap();
        for bad in [
            tmp.to_string_lossy().to_string(),
            tmp.join(".krypton/reviews").to_string_lossy().to_string(),
            PathBuf::from(&dir)
                .join("assets")
                .to_string_lossy()
                .to_string(),
            std::env::temp_dir().to_string_lossy().to_string(),
            String::new(),
        ] {
            assert!(
                server.read_review_bundle(&bad).is_err(),
                "should have refused {bad}"
            );
            assert!(server.write_review_response(&bad, "x").is_err());
        }
    }

    #[test]
    fn parse_rfc3339_ms_round_trips_and_tolerates_offsets() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-02"), Some(86_400_000));
        // The `created:` stamp the backend writes must read back as itself.
        let stamped = now_rfc3339();
        assert!(parse_rfc3339_ms(&stamped).is_some(), "{stamped}");
        // `+07:00` (what the frontend may write) resolves to the same instant.
        assert_eq!(
            parse_rfc3339_ms("2026-08-07T21:22:10+07:00"),
            parse_rfc3339_ms("2026-08-07T14:22:10Z")
        );
        assert_eq!(parse_rfc3339_ms("not a date"), None);
        assert_eq!(parse_rfc3339_ms(""), None);
    }

    #[test]
    fn days_from_civil_inverts_civil_from_days() {
        for days in [-25_000i64, -1, 0, 1, 19_000, 20_674, 50_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m as i64, d as i64), days, "days={days}");
        }
    }

    /// The `include_str!` + `str::replace` shell pattern fails SILENTLY when a
    /// marker drifts between the HTML file and the Rust replace string: the page
    /// still renders 200, just with an empty body. Pin all three markers.
    #[test]
    fn reviews_shell_slots_are_substituted() {
        let body = reviews_page_html("My Title", Some("<ul class=\"tree\">NAV</ul>"), "BODY");

        // No marker may survive into the served page.
        for marker in [
            "<!--REVIEWS_TITLE-->",
            "<!--REVIEWS_TREE-->",
            "<!--REVIEWS_CONTENT-->",
        ] {
            assert!(!body.contains(marker), "unsubstituted {marker}");
        }
        // Title lands in BOTH slots (`str::replace` is global): <title> + header.
        assert_eq!(body.matches("My Title").count(), 2, "title slots: {body}");
        // The wrappers survive with the content inside them.
        assert!(body.contains("<nav class=\"tree-pane\"><ul class=\"tree\">NAV</ul></nav>"));
        assert!(body.contains("<article class=\"doc\">BODY</article>"));
        // And the shell itself is intact.
        assert!(body.contains("Review Boards"));
        assert!(
            body.contains("krv:"),
            "sidebar scroll key must be review-scoped"
        );
    }

    #[test]
    fn bus_tools_include_the_review_board_trio() {
        let tools = bus_tool_descriptors();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        for name in ["review_new", "review_register", "review_cancel"] {
            assert!(names.contains(&name), "missing {name}");
        }
        // The tool description is the whole discoverability mechanism, so it must
        // carry the never-unsolicited guard and the explanation-spine requirement.
        let new_tool = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "review_new")
            .unwrap();
        let description = new_tool["description"].as_str().unwrap();
        assert!(description.contains("Do NOT compose one unsolicited"));
        assert!(description.contains("explanation spine"));
        assert!(description.contains("review:walkthrough"));
        // The Board is read by a Thai human, parsed by an English grammar, and
        // filed under a directory named from the title — all three must be stated.
        assert!(description.contains("NATURAL THAI"));
        assert!(description.contains("Do NOT translate technical terms"));
        assert!(description.contains("`blocking` / `non-blocking` / `suggestion`"));
        assert!(description.contains("becomes the bundle's directory name"));
    }
}
