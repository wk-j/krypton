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
use std::collections::{BTreeMap, HashMap, HashSet};
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
            feedback_tokens: std::sync::Mutex::new(HashMap::new()),
            telemetry: std::sync::Mutex::new(HashMap::new()),
            command_manifest: std::sync::Mutex::new(None),
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
            feedback_tokens: std::sync::Mutex::new(HashMap::new()),
            telemetry: std::sync::Mutex::new(HashMap::new()),
            command_manifest: std::sync::Mutex::new(None),
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

        {
            let mut memories = self.memories.lock().unwrap_or_else(|e| e.into_inner());
            memories.insert(harness_id.clone(), store);
        }

        // Spec 133: register the in-memory artifact store. On-disk files persist
        // as append-only history across harness close and app restarts.
        self.init_harness_artifacts(&harness_id, artifact_project_dir);
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

    /// Render the docs browser index as a two-pane file browser: a folder-only
    /// tree in the sidebar and the selected folder's contents (subfolders + `.md`
    /// files) as items on the right. `sel_harness`/`sel_dir` come from the query
    /// (`None`/empty = first harness, repo root).
    fn docs_index_page(&self, sel_harness: Option<&str>, sel_dir: Option<&str>) -> Response {
        let dirs = self.docs_project_dirs();
        if dirs.is_empty() {
            let content = "<p class=\"welcome\">No harness working directory is available.</p>";
            return render_docs_page("Docs", Some(""), content);
        }

        let trees: Vec<(String, String, DocsTreeNode)> = dirs
            .into_iter()
            .map(|(id, path)| {
                let node = build_docs_tree(StdPath::new(&path));
                (id, path, node)
            })
            .collect();

        // Resolve the active harness (fall back to the first) and folder.
        let selected_harness = sel_harness
            .filter(|h| trees.iter().any(|(id, _, _)| id == h))
            .map(str::to_string)
            .unwrap_or_else(|| trees[0].0.clone());
        let selected_dir = sel_dir
            .map(|d| {
                d.split('/')
                    .filter(|c| !c.is_empty() && *c != "." && *c != "..")
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();

        let nav = render_folder_nav(&trees, &selected_harness, &selected_dir);

        let active = trees.iter().find(|(id, _, _)| id == &selected_harness);
        let content = match active.and_then(|(_, _, root)| node_at(root, &selected_dir)) {
            Some(node) => render_folder_listing(&selected_harness, &selected_dir, node),
            None => "<p class=\"welcome\">Folder not found.</p>".to_string(),
        };

        let title = if selected_dir.is_empty() {
            format!("Docs · {selected_harness}")
        } else {
            format!("Docs · {selected_harness} / {selected_dir}")
        };
        render_docs_page(&title, Some(&nav), &content)
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

#[derive(Debug, Default)]
struct DocsTreeNode {
    dirs: BTreeMap<String, DocsTreeNode>,
    files: Vec<DocFile>,
}

#[derive(Debug)]
struct DocFile {
    name: String,
    modified: Option<SystemTime>,
}

#[derive(Debug, Deserialize)]
struct DocQuery {
    harness: String,
    path: String,
}

#[derive(Debug, Default, Deserialize)]
struct DocsQuery {
    harness: Option<String>,
    dir: Option<String>,
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
const COMMANDS_HTML: &str = include_str!("../../src/acp/artifact-commands.html");
const TOOLS_HTML: &str = include_str!("../../src/acp/artifact-tools.html");

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
    state
        .hook_server
        .docs_index_page(query.harness.as_deref(), query.dir.as_deref())
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
    // Single-file view opens in its own tab as a clean reader — no tree sidebar.
    render_docs_page(&rel, None, &content)
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

/// Walk `project_dir` (respecting `.gitignore`, skipping `.git/`) and build a
/// nested tree of every `*.md` file found under it.
fn build_docs_tree(project_dir: &StdPath) -> DocsTreeNode {
    let mut root = DocsTreeNode::default();
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
        let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
        insert_docs_tree_path(&mut root, rel, modified);
    }
    root
}

/// Descend the in-memory tree to the node addressed by a `/`-joined folder path
/// (`""` = root). Returns `None` if any component is missing.
fn node_at<'a>(root: &'a DocsTreeNode, dir: &str) -> Option<&'a DocsTreeNode> {
    let mut node = root;
    for component in dir.split('/').filter(|c| !c.is_empty()) {
        node = node.dirs.get(component)?;
    }
    Some(node)
}

/// Sidebar: folders only, all harnesses grouped, each folder a link that selects
/// it (`/docs?harness=&dir=`). The active folder gets `is-active`.
fn render_folder_nav(
    trees: &[(String, String, DocsTreeNode)],
    selected_harness: &str,
    selected_dir: &str,
) -> String {
    fn render_dirs(
        out: &mut String,
        harness_id: &str,
        node: &DocsTreeNode,
        prefix: &mut Vec<String>,
        selected_harness: &str,
        selected_dir: &str,
    ) {
        for (dir, child) in &node.dirs {
            prefix.push(dir.clone());
            let rel = prefix.join("/");
            let active = harness_id == selected_harness && rel == selected_dir;
            out.push_str("<li class=\"tree-dir\"><details open><summary><a");
            if active {
                out.push_str(" class=\"is-active\"");
            }
            out.push_str(" href=\"/docs?harness=");
            out.push_str(&url_encode(harness_id));
            out.push_str("&amp;dir=");
            out.push_str(&url_encode(&rel));
            out.push_str("\">");
            out.push_str(&html_escape(dir));
            out.push_str("</a></summary><ul class=\"tree\">");
            render_dirs(
                out,
                harness_id,
                child,
                prefix,
                selected_harness,
                selected_dir,
            );
            out.push_str("</ul></details></li>");
            prefix.pop();
        }
    }

    let mut out = String::from("<ul class=\"tree\">");
    for (harness_id, project_dir, root) in trees {
        let root_active = harness_id == selected_harness && selected_dir.is_empty();
        out.push_str("<li class=\"tree-group\"><a class=\"tree-group__label");
        if root_active {
            out.push_str(" is-active");
        }
        out.push_str("\" href=\"/docs?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("\">");
        out.push_str(&html_escape(&format!("{harness_id} · {project_dir}")));
        out.push_str("</a><ul class=\"tree\">");
        let mut prefix = Vec::new();
        render_dirs(
            &mut out,
            harness_id,
            root,
            &mut prefix,
            selected_harness,
            selected_dir,
        );
        out.push_str("</ul></li>");
    }
    out.push_str("</ul>");
    out
}

/// Right pane: the selected folder's immediate contents — subfolders (navigate
/// in-page) then `.md` files (open in a new reader tab) — with breadcrumbs.
fn render_folder_listing(harness_id: &str, dir: &str, node: &DocsTreeNode) -> String {
    let mut out = String::from("<nav class=\"crumbs\">");
    let root_only = dir.is_empty();
    out.push_str("<a href=\"/docs?harness=");
    out.push_str(&url_encode(harness_id));
    out.push_str("\">");
    out.push_str(&html_escape(harness_id));
    out.push_str("</a>");
    let mut acc: Vec<String> = Vec::new();
    for segment in dir.split('/').filter(|c| !c.is_empty()) {
        acc.push(segment.to_string());
        out.push_str("<span class=\"crumbs__sep\">/</span><a href=\"/docs?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("&amp;dir=");
        out.push_str(&url_encode(&acc.join("/")));
        out.push_str("\">");
        out.push_str(&html_escape(segment));
        out.push_str("</a>");
    }
    out.push_str("</nav>");

    if node.dirs.is_empty() && node.files.is_empty() {
        out.push_str("<p class=\"welcome\">Empty folder — no markdown here.</p>");
        return out;
    }

    out.push_str("<ul class=\"browser\">");
    if !root_only {
        let parent = {
            let mut parts: Vec<&str> = dir.split('/').filter(|c| !c.is_empty()).collect();
            parts.pop();
            parts.join("/")
        };
        out.push_str("<li class=\"browser__item browser__item--up\"><a href=\"/docs?harness=");
        out.push_str(&url_encode(harness_id));
        if !parent.is_empty() {
            out.push_str("&amp;dir=");
            out.push_str(&url_encode(&parent));
        }
        out.push_str("\"><span class=\"browser__icon\">↑</span><span class=\"browser__name\">..</span></a></li>");
    }
    for dir_name in node.dirs.keys() {
        let rel = if root_only {
            dir_name.clone()
        } else {
            format!("{dir}/{dir_name}")
        };
        out.push_str("<li class=\"browser__item browser__item--dir\"><a href=\"/docs?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("&amp;dir=");
        out.push_str(&url_encode(&rel));
        out.push_str("\"><span class=\"browser__icon\">▸</span><span class=\"browser__name\">");
        out.push_str(&html_escape(dir_name));
        out.push_str("</span></a></li>");
    }
    let mut files: Vec<&DocFile> = node.files.iter().collect();
    files.sort_by(|a, b| a.name.cmp(&b.name));
    for file in files {
        let rel = if root_only {
            file.name.clone()
        } else {
            format!("{dir}/{}", file.name)
        };
        out.push_str("<li class=\"browser__item browser__item--file\"><a target=\"_blank\" rel=\"noopener\" href=\"/doc?harness=");
        out.push_str(&url_encode(harness_id));
        out.push_str("&amp;path=");
        out.push_str(&url_encode(&rel));
        out.push_str("\"><span class=\"browser__icon\">◆</span><span class=\"browser__name\">");
        out.push_str(&html_escape(&file.name));
        out.push_str("</span>");
        if let Some((ms, label)) = file.modified.and_then(format_doc_mtime) {
            out.push_str("<time class=\"browser__date\" data-ts=\"");
            out.push_str(&ms.to_string());
            out.push_str("\">");
            out.push_str(&html_escape(&label));
            out.push_str("</time>");
        }
        out.push_str("</a></li>");
    }
    out.push_str("</ul>");
    out
}

fn insert_docs_tree_path(root: &mut DocsTreeNode, rel: &StdPath, modified: Option<SystemTime>) {
    let mut node = root;
    let mut components = rel.components().peekable();
    while let Some(component) = components.next() {
        let label = component.as_os_str().to_string_lossy().to_string();
        if components.peek().is_none() {
            node.files.push(DocFile {
                name: label,
                modified,
            });
        } else {
            node = node.dirs.entry(label).or_default();
        }
    }
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
fn civil_from_days(z: i64) -> (i64, u32, u32) {
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

fn render_docs_page(title: &str, tree: Option<&str>, content: &str) -> Response {
    let escaped_title = html_escape(title);
    // `None` = single-file reader: drop the sidebar entirely so content is full width.
    let nav = match tree {
        Some(tree) => format!("<nav class=\"tree-pane\">{tree}</nav>"),
        None => String::new(),
    };
    let html = DOCS_HTML
        .replace("<!--DOCS_TITLE-->", &escaped_title)
        .replace("<nav class=\"tree-pane\"><!--DOCS_TREE--></nav>", &nav)
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
    let arena = Arena::new();
    let options = docs_options();
    let root = parse_document(&arena, source, &options);
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

fn validate_doc_path(cwd: &StdPath, rel: &str, exts: &[&str]) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("path_invalid: empty path".to_string());
    }
    let rel_path = StdPath::new(rel);
    if rel_path.is_absolute() {
        return Err("path_invalid: absolute path rejected".to_string());
    }
    let cwd_canon = cwd
        .canonicalize()
        .map_err(|e| format!("not_found: cwd unavailable ({e})"))?;
    let candidate = cwd.join(rel_path);
    let candidate_canon = candidate
        .canonicalize()
        .map_err(|e| format!("not_found: file unavailable ({e})"))?;
    candidate_canon
        .strip_prefix(&cwd_canon)
        .map_err(|_| "path_invalid: outside cwd".to_string())?;
    let ext = candidate_canon
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "path_invalid: missing extension".to_string())?;
    if !exts.iter().any(|allowed| *allowed == ext) {
        return Err("path_invalid: extension rejected".to_string());
    }
    let meta = std::fs::metadata(&candidate_canon)
        .map_err(|e| format!("not_found: metadata failed ({e})"))?;
    if !meta.is_file() {
        return Err("path_invalid: not a regular file".to_string());
    }
    Ok(candidate_canon)
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
                .route("/dashboard", get(handle_dashboard))
                .route("/telemetry", get(handle_telemetry))
                .route("/gallery", get(handle_gallery))
                .route("/artifacts", get(handle_artifacts))
                .route("/commands", get(handle_commands))
                .route("/commands.json", get(handle_commands_json))
                .route("/tools", get(handle_tools))
                .route("/tools.json", get(handle_tools_json))
                .route("/docs", get(handle_docs))
                .route("/doc", get(handle_doc))
                .route("/doc-asset", get(handle_doc_asset))
                .route("/analyses", get(handle_analyses))
                .route("/analysis", get(handle_analysis))
                .route("/analysis-asset", get(handle_analysis_asset))
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
            .route("/docs", get(ok))
            .route("/doc", get(ok))
            .route("/doc-asset", get(ok))
            .route("/analyses", get(ok))
            .route("/analysis", get(ok))
            .route("/analysis-asset", get(ok))
            .route("/doc-state", get(ok))
            .route("/doc-feedback", post(ok))
            .route("/doc-artifact", post(ok))
            .route("/artifact/{token}", get(ok))
            .route("/artifact/state/{token}", get(ok))
            .route("/artifact/feedback/{token}", post(ok));
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
}
