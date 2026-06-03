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
use std::collections::{HashMap, HashSet};
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
        let store = HarnessMemoryStore {
            lanes,
            persistence_path,
            project_dir,
            save_pending: Arc::new(AtomicBool::new(false)),
        };

        let live_harness_ids: HashSet<String> = {
            let mut memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
            memories.insert(harness_id.clone(), store);
            memories.keys().cloned().collect()
        };

        // Spec 133: register the artifact store and stale-sweep crash leftovers
        // (harness dirs absent from the live registry) for this project.
        self.init_harness_artifacts(&harness_id, artifact_project_dir, &live_harness_ids);
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
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
        Ok(entries)
    }

    pub fn dispose_harness_memory(&self, harness_id: &str) {
        // Spec 133: sweep this harness's artifact scratch dir on normal close.
        self.dispose_harness_artifacts(harness_id);
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

    /// Register an artifact store for a harness and stale-sweep crash leftovers.
    /// The sweep removes any `harnessId` subdir under this project's artifact
    /// root that is NOT in the live registry — never the live set (so a second
    /// harness tab sharing the project keeps its artifacts), and only crash
    /// leftovers from prior app runs are reclaimed.
    fn init_harness_artifacts(
        &self,
        harness_id: &str,
        project_dir: Option<String>,
        live_harness_ids: &HashSet<String>,
    ) {
        if let Some(ref dir) = project_dir {
            if let Some(root) = artifacts_root(dir) {
                sweep_stale_artifacts(&root, live_harness_ids);
            }
        }
        let mut artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
        artifacts.insert(
            harness_id.to_string(),
            HarnessArtifactStore {
                project_dir,
                entries: HashMap::new(),
            },
        );
    }

    /// Remove a harness's artifact store and delete its scratch dir.
    fn dispose_harness_artifacts(&self, harness_id: &str) {
        let store = {
            let mut artifacts = self.artifacts.lock().unwrap_or_else(|e| e.into_inner());
            artifacts.remove(harness_id)
        };
        if let Some(store) = store {
            if let Some(ref dir) = store.project_dir {
                if let Some(root) = artifacts_root(dir) {
                    let harness_dir = root.join(harness_id);
                    if harness_dir.exists() {
                        let _ = std::fs::remove_dir_all(&harness_dir);
                    }
                }
            }
        }
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

        // spec 134 — seed a styled scaffold so the lane edits (not authors from
        // scratch) and output has a consistent baseline. Atomic temp+rename so a
        // failed/interrupted write never leaves a truncated scaffold, and fail
        // closed (no pending entry / no issued path) if it cannot be written.
        let html = ARTIFACT_SCAFFOLD.replace("{{title}}", &html_escape(title));
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
            },
        );

        Ok(json!({
            "id": artifact_id,
            "path": path_str,
            "tail": tail,
            "state": "pending",
            "title": title,
            "content_marker": ARTIFACT_CONTENT_MARKER,
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

    /// `artifact_cancel` — `pending` only: drop the entry and best-effort delete
    /// the pending file. Errors `already_registered` on a live id.
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
        let path = entry.path.clone();
        store.entries.remove(id);
        drop(artifacts);
        // Best-effort: the file may not exist yet (new → cancel without write).
        let _ = std::fs::remove_file(&path);
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
        let mut paths = Vec::new();
        for id in &pending_ids {
            if let Some(entry) = store.entries.remove(id) {
                paths.push(entry.path);
            }
        }
        drop(artifacts);
        for path in paths {
            let _ = std::fs::remove_file(&path);
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
/// HTML with the Krypton cyberpunk default theme + light/auto toggle; the lane
/// edits the `<main data-artifact-content>` placeholder to fill content.
const ARTIFACT_SCAFFOLD: &str = include_str!("../resources/artifact-scaffold.html");
/// Stable anchor the lane orients its first edit on (returned by `artifact_new`).
const ARTIFACT_CONTENT_MARKER: &str = "main[data-artifact-content]";

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
}

#[derive(Debug, Default)]
struct HarnessArtifactStore {
    /// Lane working dir / scratch base. None ⇒ artifacts unavailable here.
    project_dir: Option<String>,
    /// Key: artifact id.
    entries: HashMap<String, ArtifactEntry>,
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
        "attention_flag" => attention_flag(state, harness_id, lane_label, arguments).await,
        "attention_resolve" => attention_resolve(state, harness_id, lane_label, arguments).await,
        "artifact_new" => artifact_tool_new(state, harness_id, lane_label, arguments),
        "artifact_register" => artifact_tool_register(state, harness_id, lane_label, arguments),
        "artifact_cancel" => artifact_tool_cancel(state, harness_id, lane_label, arguments),
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

/// attention_flag — a lane self-reports a decision needing human judgement
/// (spec 128/130). Validates the presence floor (traded_off non-empty,
/// uncertainty non-blank), then round-trips like `review_request`: the frontend
/// coordinator assembles the ReviewPacket blast-radius, inserts the JudgementItem
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

/// Clamp a one-line headline to at most `max` Unicode code points, appending an
/// ellipsis when it had to be clipped. Counting by code points (not bytes)
/// matches `MEMORY_SUMMARY_MAX` and stays correct for multi-byte scripts such as
/// Thai. `memory_set` uses this to truncate an over-long `summary` instead of
/// rejecting it: models cannot reliably self-count characters, so the old
/// instructive rejection just produced retry loops. The body lives in `detail`;
/// `summary` is only the scannable headline shown by `memory_list`.
fn clamp_headline(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut clamped: String = s.chars().take(max.saturating_sub(1)).collect();
    clamped.push('\u{2026}');
    clamped
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
                "triage_equipped": d.triage_equipped,
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

/// Resolve the directive payload for a `directive_apply` upsert from whatever
/// shape the calling MCP client managed to serialize.
///
/// Claude/Codex lanes send the documented nested `directive` object. The Cursor
/// IDE MCP wrapper, however, mangles nested objects and enum values for
/// HTTP-backed servers (krypton#2): the arguments arrive either empty or as
/// malformed JSON, while flat scalar parameters (as used by every other harness
/// tool) go through reliably. To stay robust across clients we accept, in order:
///   1. `directive` as a proper object (preferred),
///   2. `directive` as a JSON string (clients that stringify nested objects),
///   3. flat top-level fields (`id`, `title`, ... — the Cursor-safe shape).
fn upsert_directive_value(arguments: &Value) -> Result<Value, String> {
    match arguments.get("directive") {
        Some(Value::Object(_)) => Ok(arguments
            .get("directive")
            .cloned()
            .expect("directive object present")),
        Some(Value::String(s)) => {
            let parsed = serde_json::from_str::<Value>(s).map_err(|e| {
                format!("directive_apply: `directive` was a string but not valid JSON: {e}")
            })?;
            if !parsed.is_object() {
                return Err(
                    "directive_apply: `directive` string must encode a JSON object \
                     with directive fields (id, title, ...)"
                        .to_string(),
                );
            }
            Ok(parsed)
        }
        Some(other) if !other.is_null() => Err(
            "directive_apply: `directive` must be an object or omitted in favour of flat \
                 fields (id, title, ...)"
                .to_string(),
        ),
        // No usable `directive` — assemble one from flat top-level fields.
        _ => {
            const FLAT_FIELDS: &[&str] = &[
                "id",
                "title",
                "icon",
                "description",
                "backend",
                "task",
                "system_prompt",
                "enabled",
                "triage_equipped",
            ];
            let mut obj = serde_json::Map::new();
            for key in FLAT_FIELDS {
                if let Some(v) = arguments.get(*key) {
                    if !v.is_null() {
                        obj.insert((*key).to_string(), v.clone());
                    }
                }
            }
            if obj.is_empty() {
                return Err(
                    "directive_apply: upsert requires a `directive` object or flat \
                            directive fields (id, title, description, ...)"
                        .to_string(),
                );
            }
            Ok(Value::Object(obj))
        }
    }
}

/// Merge a supplied (possibly partial) upsert payload over the existing
/// directive so an update can never silently wipe fields the caller omitted.
///
/// `HarnessDirective` carries `#[serde(default)]` (acp_harness_config.rs), so
/// deserializing a partial payload on its own resets every omitted field to its
/// default — `system_prompt` to `""`, `enabled` to `true`, etc. (krypton#2).
/// A Cursor-safe flat call like `{ action: "upsert", id: "x", enabled: false }`
/// would therefore erase `title`/`description`/`backend`/`task`/`system_prompt`.
/// On UPDATE we instead layer the supplied keys over a full serialization of the
/// existing directive; only the keys the caller actually sent change. Creates
/// have no existing entry to protect and pass through unmerged.
fn merge_directive_over_existing(
    existing: &crate::acp_harness_config::HarnessDirective,
    supplied: &Value,
) -> Result<Value, String> {
    let mut base = serde_json::to_value(existing)
        .map_err(|e| format!("directive_apply: failed to serialize existing directive: {e}"))?;
    let base_obj = base.as_object_mut().ok_or_else(|| {
        "directive_apply: existing directive did not serialize to an object".to_string()
    })?;
    if let Some(obj) = supplied.as_object() {
        for (key, value) in obj {
            base_obj.insert(key.clone(), value.clone());
        }
    }
    Ok(base)
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
            let supplied = upsert_directive_value(&arguments)?;
            // Pre-validate against the snapshot the user is about to be shown,
            // so the approval card only renders a valid proposal. The post-
            // approval re-validation below re-runs against the latest on-disk
            // state in case the file changed during the approval wait.
            let preview_cfg = dir::load()?;
            // krypton#2: on UPDATE, layer the supplied (possibly partial) fields
            // over the existing directive so an omitted field can't reset to its
            // serde default. The merge is computed here, pre-approval, so the
            // approval card and the eventual write reflect exactly the same
            // proposal the user sees.
            let supplied_id = supplied.get("id").and_then(|v| v.as_str()).map(str::trim);
            let prior = supplied_id
                .and_then(|id| preview_cfg.directives.iter().find(|d| d.id == id).cloned());
            let directive_val = match &prior {
                Some(existing) => merge_directive_over_existing(existing, &supplied)?,
                None => supplied,
            };
            let directive: dir::HarnessDirective = serde_json::from_value(directive_val)
                .map_err(|e| format!("directive_apply: invalid directive: {e}"))?;
            dir::validate_directive(&directive, &preview_cfg.directives)?;
            let is_update = prior.is_some();
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

fn bus_tool_descriptors() -> Value {
    let mut tools = json!([
        {
            "name": "memory_set",
            "description": "Overwrite your lane's single memory document. You have one document; this replaces its full contents (not append). Treat it as a living README other agents in this tab will read. 'summary' is a SHORT one-line headline; put all real content in 'detail'. Empty strings clear it.",
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
            "description": "Create/update (upsert), delete, or assign a directive. Use only when the user asks you to manage directives. `upsert` and `delete` mutate persistent config and require user approval; `assign` binds a directive to a lane at runtime (same-lane assignment is auto-approved; cross-lane always requires approval). Returns the approval outcome. After calling for a change that needs approval, expect the result to reflect the user's decision. Prefer `directive_remove` when deleting a single directive. For `upsert`, pass the directive fields as FLAT top-level parameters: id, title, icon, description, backend, task, system_prompt, enabled, triage_equipped. This flat shape is the reliable path across every MCP client. `triage_equipped` is legacy metadata in spec 130: attention_flag is now default-on for every harness-memory-capable lane, so the field no longer controls tool visibility. When UPDATING an existing directive you may send only the fields you want to change — omitted fields keep their current values (the harness merges over the stored directive). When CREATING a new directive, send at least id (and normally title + system_prompt). A nested `directive` object (or a JSON-string of one) is still accepted for backward compatibility, but the flat form is preferred — some MCP clients mangle nested objects on the wire.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "description": "One of: upsert, delete, assign." },
                    "directive": {
                        "type": ["object", "string"],
                        "description": "LEGACY/compat fallback for upsert: the directive as a nested object, or a JSON string encoding that same object. Prefer the flat top-level fields below — some MCP clients mangle nested objects on the wire. Fields: id (lowercase kebab-case), title, icon, description, backend (empty = all), task, system_prompt, enabled, triage_equipped.",
                        "properties": {
                            "id": { "type": "string" },
                            "title": { "type": "string" },
                            "icon": { "type": "string" },
                            "description": { "type": "string" },
                            "backend": { "type": "string" },
                            "task": { "type": "string" },
                            "system_prompt": { "type": "string" },
                            "enabled": { "type": "boolean" },
                            "triage_equipped": { "type": "boolean", "description": "Legacy metadata retained for compatibility. Since spec 130, attention_flag is default-on for every harness-memory-capable lane and this field no longer controls tool visibility." }
                        }
                    },
                    "id": { "type": "string", "description": "Flat-form upsert (preferred): directive id (lowercase kebab-case). Identifies which directive to create or update; on update, fields you omit are preserved." },
                    "title": { "type": "string", "description": "Flat-form upsert: directive title." },
                    "icon": { "type": "string", "description": "Flat-form upsert: directive icon glyph." },
                    "description": { "type": "string", "description": "Flat-form upsert: directive description." },
                    "backend": { "type": "string", "description": "Flat-form upsert: target backend id (empty = all)." },
                    "task": { "type": "string", "description": "Flat-form upsert: free-form task key." },
                    "system_prompt": { "type": "string", "description": "Flat-form upsert: reusable system-style prompt block." },
                    "enabled": { "type": "boolean", "description": "Flat-form upsert: whether the directive is enabled." },
                    "triage_equipped": { "type": "boolean", "description": "Flat-form upsert: legacy attention-triage metadata; no longer controls tool visibility." },
                    "directive_id": { "type": "string", "description": "Required for delete and assign." },
                    "lane": { "type": "string", "description": "Assign target lane display name; omitted = your own lane." },
                    "scope": { "type": "string", "description": "Assign scope, one of: next_turn, lane. Omitted = lane." },
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
        },
        {
            "name": "artifact_new",
            "description": "Create an HTML artifact the user opens in their browser, for views that beat prose: side-by-side comparisons, diagrams, annotated diffs, parameterized previews, dashboards. Use ONLY when the user asks for a visual/interactive artifact, or your active directive explicitly tells you to produce HTML artifacts for this task. Do NOT default to HTML for ordinary prose, plans, or answers, and do NOT volunteer unsolicited dashboards — those stay in your turn text. Returns `{ id, path, content_marker }`. The path points to a file that ALREADY EXISTS — a ready-made HTML scaffold with Krypton's default cyberpunk styling and a light/auto toggle. Use your EDIT/patch tool (NOT a Write that recreates the file, and NOT a shell heredoc — both lose the styling or leak HTML into the transcript) to replace the placeholder inside `<main data-artifact-content>` with your content; keep the `<style id=\"krypton-artifact-base\">` block and the toggle. Write plain semantic HTML (headings, tables, `<pre><code>`, `<section class=\"ka-card\">`) — it is styled automatically; to override a default, add your own `<style>` AFTER the base block. Then call artifact_register { id }. The artifact is a live file: keep editing it to iterate. Opening is always user-triggered; never auto-opens.",
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

/// Remove harness subdirs under `root` that are NOT in the live registry —
/// crash leftovers from prior app runs. Never touches the live set or the
/// `.gitignore`.
fn sweep_stale_artifacts(root: &StdPath, live_harness_ids: &HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("hm-") && !live_harness_ids.contains(name.as_ref()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp_harness_config as dir;

    // krypton#2: directive_apply upsert must accept the directive payload from
    // every MCP client shape, not just the nested object Claude/Codex send.

    #[test]
    fn upsert_accepts_nested_object() {
        let args = json!({
            "action": "upsert",
            "reason": "test",
            "directive": { "id": "a", "title": "A", "system_prompt": "p" }
        });
        let val = upsert_directive_value(&args).expect("nested object");
        assert_eq!(val["id"], "a");
        let d: dir::HarnessDirective = serde_json::from_value(val).expect("deserialize");
        assert_eq!(d.id, "a");
        // Custom Default keeps `enabled` true when omitted.
        assert!(d.enabled);
    }

    #[test]
    fn upsert_accepts_flat_fields() {
        // The Cursor-safe shape: scalar fields at the top level, no nesting.
        let args = json!({
            "action": "upsert",
            "reason": "test",
            "id": "analyze-issue-cursor",
            "title": "Analyze Issue (Cursor)",
            "icon": "🔬",
            "description": "desc",
            "backend": "cursor",
            "task": "analyze-issue",
            "system_prompt": "do the thing",
            "enabled": true,
            "triage_equipped": true
        });
        let val = upsert_directive_value(&args).expect("flat fields");
        let d: dir::HarnessDirective = serde_json::from_value(val).expect("deserialize");
        assert_eq!(d.id, "analyze-issue-cursor");
        assert_eq!(d.backend, "cursor");
        assert!(d.triage_equipped);
        assert!(d.enabled);
    }

    #[test]
    fn upsert_accepts_stringified_directive() {
        // Clients that stringify nested objects still parse if the JSON is valid.
        let args = json!({
            "action": "upsert",
            "reason": "test",
            "directive": "{\"id\":\"b\",\"title\":\"B\"}"
        });
        let val = upsert_directive_value(&args).expect("stringified object");
        let d: dir::HarnessDirective = serde_json::from_value(val).expect("deserialize");
        assert_eq!(d.id, "b");
    }

    #[test]
    fn upsert_rejects_empty_payload() {
        let args = json!({ "action": "upsert", "reason": "test" });
        assert!(upsert_directive_value(&args).is_err());
    }

    #[test]
    fn upsert_rejects_invalid_directive_string() {
        let args = json!({
            "action": "upsert",
            "reason": "test",
            "directive": "{not valid json}"
        });
        assert!(upsert_directive_value(&args).is_err());
    }

    #[test]
    fn upsert_rejects_non_object_directive_string() {
        // Valid JSON but not an object (krypton#2: clearer diagnostics for the
        // stringified-directive shape rather than a generic deserialize error).
        let args = json!({
            "action": "upsert",
            "reason": "test",
            "directive": "\"just a string\""
        });
        assert!(upsert_directive_value(&args).is_err());
    }

    fn existing_directive() -> dir::HarnessDirective {
        dir::HarnessDirective {
            id: "analyze-issue-cursor".to_string(),
            title: "Analyze Issue (Cursor)".to_string(),
            icon: "🔬".to_string(),
            description: "long-standing description".to_string(),
            backend: "cursor".to_string(),
            task: "analyze-issue".to_string(),
            system_prompt: "the carefully written prompt".to_string(),
            enabled: true,
            triage_equipped: false,
        }
    }

    #[test]
    fn merge_preserves_omitted_fields_on_update() {
        // krypton#2 footgun guard: a Cursor-safe partial flat update that only
        // flips `triage_equipped` must NOT wipe title/description/system_prompt.
        let existing = existing_directive();
        let supplied = json!({ "id": "analyze-issue-cursor", "triage_equipped": true });
        let merged = merge_directive_over_existing(&existing, &supplied).expect("merge");
        let d: dir::HarnessDirective = serde_json::from_value(merged).expect("deserialize");
        assert!(d.triage_equipped, "the supplied field is applied");
        assert_eq!(
            d.system_prompt, "the carefully written prompt",
            "omitted field preserved"
        );
        assert_eq!(d.title, "Analyze Issue (Cursor)");
        assert_eq!(d.description, "long-standing description");
        assert_eq!(d.backend, "cursor");
        assert_eq!(d.task, "analyze-issue");
        assert!(d.enabled);
    }

    #[test]
    fn merge_overrides_supplied_fields() {
        let existing = existing_directive();
        let supplied = json!({
            "id": "analyze-issue-cursor",
            "title": "Renamed",
            "enabled": false
        });
        let merged = merge_directive_over_existing(&existing, &supplied).expect("merge");
        let d: dir::HarnessDirective = serde_json::from_value(merged).expect("deserialize");
        assert_eq!(d.title, "Renamed", "supplied field overrides existing");
        assert!(!d.enabled, "supplied false overrides existing true");
        assert_eq!(
            d.system_prompt, "the carefully written prompt",
            "untouched field preserved"
        );
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

        server.init_harness_artifacts("hm-1", Some(project.clone()), &HashSet::new());

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
    fn artifact_cancel_drops_pending_file() {
        let server = HookServer::new();
        let tmp = std::env::temp_dir().join(format!("krypton-art-{}", rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        server.init_harness_artifacts(
            "hm-2",
            Some(tmp.to_string_lossy().to_string()),
            &HashSet::new(),
        );
        let issued = server.artifact_new("hm-2", "Claude-1", "scratch").unwrap();
        let id = issued["id"].as_str().unwrap().to_string();
        let path = PathBuf::from(issued["path"].as_str().unwrap());
        std::fs::write(&path, "<html></html>").unwrap();
        server.artifact_cancel("hm-2", "Claude-1", &id).unwrap();
        assert!(!path.exists(), "cancel should delete the pending file");
        // register-after-cancel errors.
        assert!(server.artifact_register("hm-2", "Claude-1", &id).is_err());
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
        server.init_harness_artifacts(
            "hm-1",
            Some(tmp.to_string_lossy().to_string()),
            &HashSet::new(),
        );
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

    #[test]
    fn sweep_removes_only_dead_harness_dirs() {
        let tmp = std::env::temp_dir().join(format!("krypton-art-{}", rand_suffix()));
        let root = tmp.join(".krypton/artifacts");
        std::fs::create_dir_all(root.join("hm-1")).unwrap();
        std::fs::create_dir_all(root.join("hm-2")).unwrap();
        std::fs::write(root.join(".gitignore"), "*\n!.gitignore\n").unwrap();
        let mut live = HashSet::new();
        live.insert("hm-2".to_string());
        sweep_stale_artifacts(&root, &live);
        assert!(!root.join("hm-1").exists(), "stale hm-1 must be swept");
        assert!(root.join("hm-2").exists(), "live hm-2 must survive");
        assert!(root.join(".gitignore").exists(), ".gitignore must survive");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // memory_set no longer rejects an over-long `summary` — it clips it to a
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
