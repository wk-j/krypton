use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::AppHandle;
use tokio::sync::oneshot;

use crate::util::emit::EmitExt;

pub const API_VERSION: &str = "1.0";
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub pid: u32,
    pub url: String,
    pub api_version: String,
    pub app_version: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub operation_id: String,
    pub operation: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEvent {
    pub request_id: String,
    pub operation_id: String,
    pub operation: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlReply {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

impl ControlReply {
    pub fn ok(result: Value) -> Self {
        Self {
            result: Some(result),
            error: None,
        }
    }

    pub fn error(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            result: None,
            error: Some(ControlError {
                code: code.to_string(),
                message: message.into(),
                retryable,
            }),
        }
    }
}

#[derive(Default)]
pub struct ControlServer {
    token: Mutex<String>,
    pending: Mutex<HashMap<String, oneshot::Sender<ControlReply>>>,
    descriptor_path: Mutex<Option<PathBuf>>,
}

impl ControlServer {
    pub fn complete(&self, request_id: &str, reply: ControlReply) -> bool {
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id);
        sender.is_some_and(|tx| tx.send(reply).is_ok())
    }

    fn register(&self, request_id: String) -> oneshot::Receiver<ControlReply> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id, tx);
        rx
    }

    fn drop_pending(&self, request_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id);
    }

    fn authenticated(&self, headers: &HeaderMap) -> bool {
        let expected = self.token.lock().unwrap_or_else(|e| e.into_inner());
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v == format!("Bearer {expected}"))
    }

    pub fn remove_descriptor(&self) {
        let path = self
            .descriptor_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(path) = path {
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "failed to remove control descriptor {}: {e}",
                        path.display()
                    );
                }
            }
        }
    }
}

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    server: Arc<ControlServer>,
}

async fn capabilities(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !state.server.authenticated(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ControlReply::error(
                "authentication_failed",
                "invalid bearer token",
                false,
            )),
        );
    }
    (
        StatusCode::OK,
        Json(ControlReply::ok(json!({
            "apiVersion": API_VERSION,
            "operations": [
                "harness.list",
                "harness.create",
                "lane.list",
                "lane.spawn",
                "lane.close",
                "lane.restart",
                "lane.new",
                "lane.model",
                "lane.directive",
                "lane.goal",
                "lane.permission_mode",
                "lane.send",
                "lane.cancel",
                "lane.transcript",
                "permission.list",
                "permission.resolve",
                "memory.list",
                "memory.get",
                "memory.clear",
                "peer.list"
            ]
        }))),
    )
}

async fn operation(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(request): Json<ControlRequest>,
) -> impl IntoResponse {
    if !state.server.authenticated(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ControlReply::error(
                "authentication_failed",
                "invalid bearer token",
                false,
            )),
        );
    }
    if request.operation_id.trim().is_empty() || request.operation.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ControlReply::error(
                "invalid_request",
                "operationId and operation are required",
                false,
            )),
        );
    }
    let request_id = random_hex(16);
    let rx = state.server.register(request_id.clone());
    state.app.emit_or_log(
        "acp-control-request",
        ControlEvent {
            request_id: request_id.clone(),
            operation_id: request.operation_id,
            operation: request.operation,
            params: request.params,
        },
    );
    match tokio::time::timeout(CONTROL_TIMEOUT, rx).await {
        Ok(Ok(reply)) => (StatusCode::OK, Json(reply)),
        _ => {
            state.server.drop_pending(&request_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(ControlReply::error(
                    "timeout",
                    "frontend did not answer the control request",
                    true,
                )),
            )
        }
    }
}

pub fn descriptor_path() -> Result<PathBuf, String> {
    crate::config::config_dir()
        .map(|p| p.join("runtime").join("controller.json"))
        .ok_or_else(|| "could not determine config directory".to_string())
}

pub fn start(app: AppHandle, server: Arc<ControlServer>) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("failed to create control-server runtime: {e}");
                return;
            }
        };
        rt.block_on(async move {
            let token = random_hex(32);
            *server.token.lock().unwrap_or_else(|e| e.into_inner()) = token.clone();
            let state = Arc::new(ServerState {
                app: app.clone(),
                server: server.clone(),
            });
            let router = Router::new()
                .route("/control/v1/capabilities", get(capabilities))
                .route("/control/v1/operations", post(operation))
                .with_state(state);
            let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                Ok(listener) => listener,
                Err(e) => {
                    log::error!("failed to bind ACP control server: {e}");
                    return;
                }
            };
            let port = match listener.local_addr() {
                Ok(addr) => addr.port(),
                Err(e) => {
                    log::error!("failed to read ACP control server address: {e}");
                    return;
                }
            };
            let descriptor = RuntimeDescriptor {
                pid: std::process::id(),
                url: format!("http://127.0.0.1:{port}/control/v1"),
                api_version: API_VERSION.to_string(),
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                token,
            };
            match write_descriptor(&descriptor) {
                Ok(path) => {
                    *server
                        .descriptor_path
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = Some(path);
                }
                Err(e) => {
                    log::error!("failed to publish ACP control descriptor: {e}");
                    return;
                }
            }
            log::info!("ACP control server listening on 127.0.0.1:{port}");
            if let Err(e) = axum::serve(listener, router).await {
                log::error!("ACP control server failed: {e}");
            }
            server.remove_descriptor();
        });
    });
}

fn write_descriptor(descriptor: &RuntimeDescriptor) -> Result<PathBuf, String> {
    let path = descriptor_path()?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if let Ok(existing) = serde_json::from_str::<RuntimeDescriptor>(&existing) {
            if existing.pid != descriptor.pid && pid_is_live(existing.pid) {
                return Err(format!(
                    "another Krypton process ({}) owns {}",
                    existing.pid,
                    path.display()
                ));
            }
        }
    }
    let dir = path
        .parent()
        .ok_or_else(|| "control descriptor has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let temp = dir.join(format!(".controller-{}.tmp", std::process::id()));
    let body = serde_json::to_vec_pretty(descriptor).map_err(|e| e.to_string())?;
    std::fs::write(&temp, body).map_err(|e| format!("write {}: {e}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod {}: {e}", temp.display()))?;
    }
    std::fs::rename(&temp, &path)
        .map_err(|e| format!("rename {} to {}: {e}", temp.display(), path.display()))?;
    Ok(path)
}

#[cfg(unix)]
pub fn pid_is_live(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn pid_is_live(_pid: u32) -> bool {
    true
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0_u8; bytes];
    if getrandom::getrandom(&mut buf).is_err() {
        let seed = format!("{}-{:?}", std::process::id(), std::time::SystemTime::now());
        return hex_bytes(seed.as_bytes());
    }
    hex_bytes(&buf)
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_shapes_are_stable() {
        let ok = serde_json::to_value(ControlReply::ok(json!({"ok": true}))).unwrap();
        assert_eq!(ok["result"]["ok"], true);
        assert!(ok.get("error").is_none());

        let err = serde_json::to_value(ControlReply::error("conflict", "changed", false)).unwrap();
        assert_eq!(err["error"]["code"], "conflict");
        assert!(err.get("result").is_none());
    }

    #[test]
    fn current_pid_is_live() {
        assert!(pid_is_live(std::process::id()));
        assert!(!pid_is_live(0));
    }
}
