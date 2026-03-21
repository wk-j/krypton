// Krypton — Claude Code Hook Server
// Lightweight HTTP server that receives Claude Code hook events and forwards
// them as Tauri events to the frontend.

use axum::{extract::State as AxumState, http::StatusCode, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
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
}

/// Handle for the running hook server (managed by Tauri).
pub struct HookServer {
    pub port: std::sync::Mutex<u16>,
    pub shutdown_tx: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl Default for HookServer {
    fn default() -> Self {
        Self {
            port: std::sync::Mutex::new(0),
            shutdown_tx: std::sync::Mutex::new(None),
        }
    }
}

impl HookServer {
    pub fn new() -> Self {
        Self {
            port: std::sync::Mutex::new(0),
            shutdown_tx: std::sync::Mutex::new(None),
        }
    }

    pub fn get_port(&self) -> u16 {
        *self.port.lock().unwrap_or_else(|e| e.into_inner())
    }
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

    if let Err(e) = state.app_handle.emit("claude-hook", &event) {
        log::error!("Failed to emit claude-hook event: {e}");
    }

    StatusCode::OK
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
            });

            let app = Router::new()
                .route("/hook", post(handle_hook))
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
