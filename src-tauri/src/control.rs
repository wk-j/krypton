use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::AppHandle;
use tokio::sync::{broadcast, oneshot};
use tower_http::cors::CorsLayer;

use crate::util::emit::EmitExt;

/// Capacity of the per-server broadcast channel that fans harness events out to
/// SSE subscribers. A subscriber that falls this far behind receives a `gap`
/// event and should re-snapshot via `lane.transcript`. See doc 175.
const EVENT_CHANNEL_CAP: usize = 1024;

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

/// A live harness event pushed by the TypeScript frontend (the state authority,
/// per ADR-0007) for fan-out to SSE subscribers. Rust never derives these — it
/// only forwards what the owning view already holds. See doc 175.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlStreamEvent {
    pub harness_id: String,
    #[serde(default)]
    pub lane: Option<String>,
    pub kind: String,
    /// Monotonic per-server sequence, assigned on publish (any inbound value is
    /// overwritten) so a reconnecting client can detect gaps.
    #[serde(default)]
    pub seq: u64,
    pub payload: Value,
}

/// What actually travels over the broadcast channel: the pre-serialized event
/// JSON plus the routing fields the SSE handler filters on.
#[derive(Clone)]
struct StreamFrame {
    harness_id: String,
    lane: Option<String>,
    kind: String,
    data: String,
}

pub struct ControlServer {
    token: Mutex<String>,
    pending: Mutex<HashMap<String, oneshot::Sender<ControlReply>>>,
    descriptor_path: Mutex<Option<PathBuf>>,
    events: broadcast::Sender<StreamFrame>,
    /// Next sequence to assign. A `Mutex` (not an atomic) so seq assignment and
    /// the broadcast send happen under one lock — otherwise concurrent publishes
    /// could push seq N+1 onto the channel before seq N and clients relying on
    /// seq for gap/order detection would see false reordering (doc 175 review).
    seq: Mutex<u64>,
}

impl Default for ControlServer {
    fn default() -> Self {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAP);
        Self {
            token: Mutex::new(String::new()),
            pending: Mutex::new(HashMap::new()),
            descriptor_path: Mutex::new(None),
            events,
            seq: Mutex::new(0),
        }
    }
}

impl ControlServer {
    /// Fan a frontend-published harness event out to all SSE subscribers. The
    /// caller's `seq` is overwritten with the authoritative per-server counter.
    /// Best-effort: silently drops when there are no subscribers.
    pub fn publish(&self, mut event: ControlStreamEvent) {
        // Hold the seq lock across serialize + send so subscribers observe seq
        // strictly in send order under concurrent publishes (doc 175 review).
        let mut seq = self.seq.lock().unwrap_or_else(|e| e.into_inner());
        event.seq = *seq;
        let data = match serde_json::to_string(&event) {
            Ok(data) => data,
            Err(e) => {
                // seq is not consumed on failure — no gap, the value is reused.
                log::warn!("control publish: serialize failed: {e}");
                return;
            }
        };
        *seq += 1;
        let _ = self.events.send(StreamFrame {
            harness_id: event.harness_id,
            lane: event.lane,
            kind: event.kind,
            data,
        });
    }

    /// Constant-time-ish bearer match for the SSE `?token=` query param, which
    /// `EventSource` needs because it cannot set an `Authorization` header.
    fn token_matches(&self, candidate: Option<&str>) -> bool {
        let Some(candidate) = candidate else {
            return false;
        };
        let expected = self.token.lock().unwrap_or_else(|e| e.into_inner());
        !expected.is_empty() && candidate == expected.as_str()
    }

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
                "peer.list",
                "attention.list",
                "attention.resolve",
                "artifact.list",
                "lane.status",
                "lane.commands",
                "lane.metrics",
                "lane.models",
                "directive.list",
                "review.outcomes",
                "diff.review-targets",
                "diff.review-priority",
                "diff.review-send"
            ],
            "streaming": {
                "sse": "/control/v1/events"
            }
        }))),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventQuery {
    /// Bearer token for `EventSource`, which cannot set request headers.
    token: Option<String>,
    /// Optional filters: only forward events for this harness / lane.
    harness: Option<String>,
    lane: Option<String>,
}

/// Server-Sent Events stream of live harness events (doc 175). One-way; commands
/// still flow over `POST /operations`. Auth accepts either the bearer header or
/// `?token=`. Emits a `ready` event on connect, the published harness events as
/// named SSE events, a `gap` event if a slow client lags, and a 15s heartbeat.
async fn events(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> Response {
    if !state.server.authenticated(&headers) && !state.server.token_matches(query.token.as_deref())
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ControlReply::error(
                "authentication_failed",
                "invalid bearer token",
                false,
            )),
        )
            .into_response();
    }

    let rx = state.server.events.subscribe();
    let ready = futures_util::stream::once(async {
        Ok::<_, Infallible>(SseEvent::default().event("ready").data("{}"))
    });
    let live = futures_util::stream::unfold(
        (rx, query.harness, query.lane),
        |(mut rx, harness, lane)| async move {
            loop {
                match rx.recv().await {
                    Ok(frame) => {
                        if harness.as_deref().is_some_and(|h| frame.harness_id != h) {
                            continue;
                        }
                        if lane
                            .as_deref()
                            .is_some_and(|l| frame.lane.as_deref() != Some(l))
                        {
                            continue;
                        }
                        let event = SseEvent::default().event(frame.kind).data(frame.data);
                        return Some((Ok::<_, Infallible>(event), (rx, harness, lane)));
                    }
                    Err(broadcast::error::RecvError::Lagged(dropped)) => {
                        let event = SseEvent::default()
                            .event("gap")
                            .data(format!("{{\"dropped\":{dropped}}}"));
                        return Some((Ok(event), (rx, harness, lane)));
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );

    Sse::new(ready.chain(live))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
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

pub fn start(
    app: AppHandle,
    server: Arc<ControlServer>,
    configured_port: u16,
    cors_origins: Vec<String>,
) {
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
            let mut router = Router::new()
                .route("/control/v1/capabilities", get(capabilities))
                .route("/control/v1/operations", post(operation))
                .route("/control/v1/events", get(events))
                .with_state(state);
            // Opt-in, exact-origin CORS so a browser app can call the API
            // directly (doc 175). Empty = proxy-only (the secure default).
            if let Some(cors) = build_cors(&cors_origins) {
                router = router.layer(cors);
            }
            // Fixed loopback port so external clients (e.g. a browser extension)
            // have a stable URL; fall back to an OS-assigned port on conflict so
            // a port clash never silently disables the control server (doc 176).
            let configured = format!("127.0.0.1:{configured_port}");
            let listener = match tokio::net::TcpListener::bind(&configured).await {
                Ok(listener) => listener,
                Err(e) => {
                    log::warn!(
                        "failed to bind ACP control server on {configured}: {e}; \
                         falling back to an ephemeral port"
                    );
                    match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                        Ok(listener) => listener,
                        Err(fallback_error) => {
                            log::error!(
                                "failed to bind ACP control server on {configured} \
                                 and ephemeral fallback: {fallback_error}"
                            );
                            return;
                        }
                    }
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

/// Build an exact-origin CORS layer, or `None` when no origins are configured
/// (proxy-only mode). Never permits `*`; unparseable origins are dropped with a
/// warning. See doc 175.
fn build_cors(origins: &[String]) -> Option<CorsLayer> {
    let parsed: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|origin| {
            if !is_exact_origin(origin) {
                log::warn!(
                    "control CORS: refusing non-exact origin {origin:?} — \
                     use scheme://host[:port], never \"*\" or \"null\""
                );
                return None;
            }
            match origin.parse::<HeaderValue>() {
                Ok(value) => Some(value),
                Err(e) => {
                    log::warn!("control CORS: ignoring invalid origin {origin:?}: {e}");
                    None
                }
            }
        })
        .collect();
    if parsed.is_empty() {
        return None;
    }
    Some(
        CorsLayer::new()
            .allow_origin(parsed)
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
    )
}

/// An exact origin is `http://` or `https://` followed by a host — never the
/// `*` wildcard, `null`, or any value containing `*`. The control API's CORS
/// contract is exact-origin-only (doc 175 review).
fn is_exact_origin(origin: &str) -> bool {
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"));
    matches!(rest, Some(host) if !host.is_empty() && !origin.contains('*'))
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

    #[test]
    fn cors_is_none_without_origins() {
        assert!(build_cors(&[]).is_none());
        // Invalid origins are dropped; an all-invalid list yields no layer.
        assert!(build_cors(&["not a header value\n".to_string()]).is_none());
        assert!(build_cors(&["http://localhost:5173".to_string()]).is_some());
    }

    #[test]
    fn cors_rejects_wildcard_and_non_origins() {
        // Exact-origin contract: "*", "null", bare hosts, and *-containing
        // values never build a layer (doc 175 review blocker).
        assert!(build_cors(&["*".to_string()]).is_none());
        assert!(build_cors(&["null".to_string()]).is_none());
        assert!(build_cors(&["example.com".to_string()]).is_none());
        assert!(build_cors(&["https://*.example.com".to_string()]).is_none());
        assert!(is_exact_origin("http://localhost:5173"));
        assert!(is_exact_origin("https://app.example.com"));
        assert!(!is_exact_origin("https://"));
    }

    #[test]
    fn publish_assigns_monotonic_seq() {
        let server = ControlServer::default();
        let mut rx = server.events.subscribe();
        for _ in 0..3 {
            server.publish(ControlStreamEvent {
                harness_id: "h1".to_string(),
                lane: Some("Claude-4".to_string()),
                kind: "status".to_string(),
                seq: 999, // caller value must be overwritten
                payload: json!({ "next": "busy" }),
            });
        }
        let seqs: Vec<u64> = (0..3)
            .map(|_| {
                let frame = rx.try_recv().expect("frame");
                let value: Value = serde_json::from_str(&frame.data).unwrap();
                value["seq"].as_u64().unwrap()
            })
            .collect();
        assert_eq!(seqs, vec![0, 1, 2]);
    }

    #[test]
    fn token_match_rejects_empty_and_mismatch() {
        let server = ControlServer::default();
        // Empty token (server not started) never matches, even an empty candidate.
        assert!(!server.token_matches(Some("")));
        assert!(!server.token_matches(None));
        *server.token.lock().unwrap() = "secret".to_string();
        assert!(server.token_matches(Some("secret")));
        assert!(!server.token_matches(Some("nope")));
        assert!(!server.token_matches(None));
    }
}
