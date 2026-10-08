//! Krypton — Harness live voice (`#live`, spec 280).
//!
//! The webview owns the WebRTC media (mic, peer connection, playback). This
//! module owns the two steps that need the Codex OAuth token:
//!   - Signaling: POST the SDP offer to the Codex realtime calls endpoint and
//!     return the SDP answer plus the `rtc_*` call id from `Location`.
//!   - Sideband: a WebSocket to `wss://api.openai.com/v1/live/<callId>` that
//!     carries every client message and forwards each server text frame to the
//!     webview as `live-voice-event`.
//!
//! One call exists app-wide. A new `live_voice_signal` supersedes the previous
//! call (webview reloads) and bumps the generation; every other command checks
//! the generation, so a stale frontend can never touch a newer session.
//!
//! The access token is read from `<codex_home>/auth.json` (Codex CLI owns
//! refresh; this module never refreshes or writes it). It never crosses IPC
//! and is never logged. Error strings are static sentinels or a bounded,
//! whitespace-collapsed response body.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, LOCATION, USER_AGENT,
};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::util::emit::EmitExt;

const SIGNAL_URL: &str =
    "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const SIDEBAND_URL_BASE: &str = "wss://api.openai.com/v1/live/";
const REALTIME_MODEL: &str = "gpt-live-1-codex";
const CLIENT_VERSION: &str = "0.144.1";
const ORIGINATOR: &str = "Codex Desktop";
const OPENAI_ALPHA: &str = "quicksilver=v2";

const SIGNAL_TIMEOUT: Duration = Duration::from_secs(15);
const SIDEBAND_ATTEMPTS: u32 = 5;
const SIDEBAND_BACKOFF_BASE_MS: u64 = 200;
const SIDEBAND_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a torn-down sideband task may spend sending its close frame
/// before it is aborted.
const SIDEBAND_SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const ERROR_BODY_MAX_CHARS: usize = 300;

const EVENT_FRAME: &str = "live-voice-event";
const EVENT_CLOSED: &str = "live-voice-closed";

const ERR_NOT_CONNECTED: &str = "codex-not-connected";
const ERR_TOKEN_EXPIRED: &str = "codex-token-expired";
const ERR_AUTH_REJECTED: &str = "codex-auth-rejected";
const ERR_SIGNALING_NETWORK: &str = "signaling-network";
const ERR_SIGNALING_EMPTY_ANSWER: &str = "signaling-empty-answer";
const ERR_SIGNALING_NO_CALL_ID: &str = "signaling-no-call-id";
const ERR_STALE_GENERATION: &str = "stale-generation";
const ERR_SIDEBAND_NOT_OPEN: &str = "sideband-not-open";
const ERR_SIDEBAND_ALREADY_OPEN: &str = "sideband-already-open";
const ERR_SIDEBAND_FAILED: &str = "sideband-failed";

const HEADER_OPENAI_ALPHA: &str = "openai-alpha";
const HEADER_X_SESSION_ID: &str = "x-session-id";
const HEADER_ORIGINATOR: &str = "originator";
const HEADER_VERSION: &str = "version";
const HEADER_SESSION_ID: &str = "session-id";
const HEADER_THREAD_ID: &str = "thread-id";
const HEADER_ACCOUNT_ID: &str = "chatgpt-account-id";

type SidebandSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Codex credentials from `auth.json`. Deliberately not `Debug`/`Serialize`:
/// the token only ever leaves as an `Authorization` header.
struct CodexAccess {
    access_token: String,
    account_id: Option<String>,
}

/// Per-call identifiers sent as headers on both signaling and sideband.
struct CallIds {
    /// `x-session-id`.
    request_session_id: String,
    /// `session-id` and `thread-id`.
    session_id: String,
}

impl CallIds {
    fn new() -> Self {
        Self {
            request_session_id: uuid_v4(),
            session_id: uuid_v4(),
        }
    }
}

enum Sideband {
    Idle,
    Connecting,
    Open {
        tx: mpsc::UnboundedSender<String>,
        task: JoinHandle<()>,
    },
}

struct LiveCall {
    generation: u64,
    access: CodexAccess,
    ids: CallIds,
    call_id: String,
    sideband: Sideband,
}

impl LiveCall {
    /// Silent teardown (close or supersede): no `live-voice-closed` is emitted.
    /// Dropping the sender makes the task send a close frame and exit; the
    /// task is aborted if it has not finished within the grace period.
    fn teardown(self) {
        if let Sideband::Open { tx, task } = self.sideband {
            drop(tx);
            reap_sideband_task(task);
        }
    }
}

fn reap_sideband_task(mut task: JoinHandle<()>) {
    tokio::spawn(async move {
        if tokio::time::timeout(SIDEBAND_SHUTDOWN_GRACE, &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
    });
}

/// The single app-wide live voice call.
#[derive(Default)]
pub struct LiveVoiceState {
    inner: Mutex<Option<LiveCall>>,
    generation: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSignal {
    generation: u64,
    answer_sdp: String,
    call_id: String,
}

#[derive(Serialize, Clone)]
struct LiveVoiceFrame {
    generation: u64,
    payload: String,
}

#[derive(Serialize, Clone)]
struct LiveVoiceClosed {
    generation: u64,
    error: Option<String>,
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for chunk in bytes.chunks_mut(8) {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u128(nanos);
            chunk.copy_from_slice(&hasher.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `exp` claim of a JWT, decoded without verification.
fn jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    let exp = claims.get("exp")?;
    exp.as_i64().or_else(|| exp.as_f64().map(|f| f as i64))
}

fn access_from_auth_json(raw: &str, now: i64) -> Result<CodexAccess, String> {
    let (access_token, account_id) = crate::usage::parse_codex_backend_credentials(raw)
        .ok_or_else(|| ERR_NOT_CONNECTED.to_string())?;
    let exp = jwt_exp(&access_token).ok_or_else(|| ERR_NOT_CONNECTED.to_string())?;
    if exp <= now {
        return Err(ERR_TOKEN_EXPIRED.to_string());
    }
    Ok(CodexAccess {
        access_token,
        account_id: account_id.filter(|id| !id.is_empty()),
    })
}

async fn load_access() -> Result<CodexAccess, String> {
    let path = crate::usage::codex_home_dir()
        .ok_or_else(|| ERR_NOT_CONNECTED.to_string())?
        .join("auth.json");
    let raw = tokio::fs::read_to_string(path)
        .await
        .map_err(|_| ERR_NOT_CONNECTED.to_string())?;
    access_from_auth_json(&raw, now_secs())
}

/// Headers shared by signaling and the sideband. No `x-oai-attestation`.
fn live_headers(access: &CodexAccess, ids: &CallIds) -> Result<HeaderMap, String> {
    fn value(raw: &str) -> Result<HeaderValue, String> {
        HeaderValue::from_str(raw).map_err(|_| ERR_NOT_CONNECTED.to_string())
    }
    let mut headers = HeaderMap::new();
    let mut auth = value(&format!("Bearer {}", access.access_token))?;
    auth.set_sensitive(true);
    headers.insert(AUTHORIZATION, auth);
    headers.insert(HEADER_OPENAI_ALPHA, HeaderValue::from_static(OPENAI_ALPHA));
    headers.insert(
        USER_AGENT,
        value(&format!("{ORIGINATOR}/{CLIENT_VERSION}"))?,
    );
    headers.insert(HEADER_X_SESSION_ID, value(&ids.request_session_id)?);
    headers.insert(HEADER_ORIGINATOR, HeaderValue::from_static(ORIGINATOR));
    headers.insert(HEADER_VERSION, HeaderValue::from_static(CLIENT_VERSION));
    headers.insert(HEADER_SESSION_ID, value(&ids.session_id)?);
    headers.insert(HEADER_THREAD_ID, value(&ids.session_id)?);
    if let Some(account_id) = &access.account_id {
        headers.insert(HEADER_ACCOUNT_ID, value(account_id)?);
    }
    Ok(headers)
}

fn is_call_id(segment: &str) -> bool {
    segment.strip_prefix("rtc_").is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

/// Call id (`rtc_*`) from a `Location` header, absolute or relative.
fn call_id_from_location(location: &str) -> Option<String> {
    let path = location.split(['?', '#']).next()?;
    path.split('/')
        .rev()
        .find(|segment| is_call_id(segment))
        .map(String::from)
}

fn sideband_url(call_id: &str) -> String {
    format!("{SIDEBAND_URL_BASE}{call_id}")
}

/// Whitespace-collapsed, trimmed, at most `ERROR_BODY_MAX_CHARS` chars.
fn bounded_error_body(body: &str) -> String {
    body.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(ERROR_BODY_MAX_CHARS)
        .collect()
}

/// `None` only for a normal (1000) close; a close frame without a status code
/// reports RFC 6455's 1005 ("no status received").
fn closed_error(code: Option<CloseCode>) -> Option<String> {
    let code = code.unwrap_or(CloseCode::Status);
    if code == CloseCode::Normal {
        return None;
    }
    Some(format!("sideband-closed:{}", u16::from(code)))
}

fn signal_body(offer_sdp: &str, instructions: &str, voice: &str) -> Value {
    json!({
        "sdp": offer_sdp,
        "session": {
            "model": REALTIME_MODEL,
            "instructions": instructions,
            "audio": { "output": { "voice": voice } },
            "delegation": { "type": "client" },
        },
    })
}

// ─── Network ────────────────────────────────────────────────────────────────

/// POST the offer; returns `(answer_sdp, call_id)`.
async fn post_offer(
    access: &CodexAccess,
    ids: &CallIds,
    offer_sdp: &str,
    instructions: &str,
    voice: &str,
) -> Result<(String, String), String> {
    let mut headers = live_headers(access, ids)?;
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let client = reqwest::Client::builder()
        .timeout(SIGNAL_TIMEOUT)
        .build()
        .map_err(|_| ERR_SIGNALING_NETWORK.to_string())?;
    let response = client
        .post(SIGNAL_URL)
        .headers(headers)
        .body(signal_body(offer_sdp, instructions, voice).to_string())
        .send()
        .await
        .map_err(|e| {
            log::warn!("live voice signaling request failed: {e}");
            ERR_SIGNALING_NETWORK.to_string()
        })?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        log::warn!("live voice signaling rejected credentials: {status}");
        return Err(ERR_AUTH_REJECTED.to_string());
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body = bounded_error_body(&body);
        log::warn!("live voice signaling failed: {status}");
        return Err(format!("signaling-failed:{}:{body}", status.as_u16()));
    }

    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let answer_sdp = response.text().await.map_err(|e| {
        log::warn!("live voice signaling body read failed: {e}");
        ERR_SIGNALING_NETWORK.to_string()
    })?;
    if answer_sdp.trim().is_empty() {
        return Err(ERR_SIGNALING_EMPTY_ANSWER.to_string());
    }
    let call_id = location
        .as_deref()
        .and_then(call_id_from_location)
        .ok_or_else(|| ERR_SIGNALING_NO_CALL_ID.to_string())?;
    Ok((answer_sdp, call_id))
}

async fn connect_sideband(
    access: &CodexAccess,
    ids: &CallIds,
    call_id: &str,
) -> Result<SidebandSocket, String> {
    let url = sideband_url(call_id);
    let headers = live_headers(access, ids)?;
    for attempt in 0..SIDEBAND_ATTEMPTS {
        if attempt > 0 {
            let backoff = SIDEBAND_BACKOFF_BASE_MS << (attempt - 1);
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }
        let mut request = url.as_str().into_client_request().map_err(|e| {
            log::warn!("live voice sideband request invalid: {e}");
            ERR_SIDEBAND_FAILED.to_string()
        })?;
        request.headers_mut().extend(headers.clone());
        match tokio::time::timeout(
            SIDEBAND_CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async(request),
        )
        .await
        {
            Ok(Ok((socket, _))) => return Ok(socket),
            Ok(Err(e)) => log::warn!(
                "live voice sideband attempt {}/{SIDEBAND_ATTEMPTS} failed: {e}",
                attempt + 1
            ),
            Err(_) => log::warn!(
                "live voice sideband attempt {}/{SIDEBAND_ATTEMPTS} timed out",
                attempt + 1
            ),
        }
    }
    Err(ERR_SIDEBAND_FAILED.to_string())
}

/// Pumps one sideband: server text frames → `live-voice-event`, `rx` → socket.
/// `rx` closing means a silent teardown; any other end emits
/// `live-voice-closed` unless the call was torn down meanwhile.
async fn run_sideband(
    app: AppHandle,
    generation: u64,
    mut socket: SidebandSocket,
    mut rx: mpsc::UnboundedReceiver<String>,
) {
    let error = loop {
        tokio::select! {
            outbound = rx.recv() => match outbound {
                Some(text) => {
                    if let Err(e) = socket.send(Message::Text(text.into())).await {
                        log::warn!("live voice sideband send failed: {e}");
                        break Some(ERR_SIDEBAND_FAILED.to_string());
                    }
                }
                None => {
                    let _ = socket.close(None).await;
                    return;
                }
            },
            inbound = socket.next() => match inbound {
                Some(Ok(Message::Text(text))) => app.emit_or_log(
                    EVENT_FRAME,
                    LiveVoiceFrame { generation, payload: text.to_string() },
                ),
                Some(Ok(Message::Close(frame))) => {
                    break closed_error(frame.map(|f| f.code));
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    log::warn!("live voice sideband failed: {e}");
                    break Some(ERR_SIDEBAND_FAILED.to_string());
                }
                None => break Some(ERR_SIDEBAND_FAILED.to_string()),
            },
        }
    };

    // Emit under the state lock so a concurrent close/supersede either wins
    // (no event) or observes the sideband already idle.
    let state = app.state::<LiveVoiceState>();
    let mut guard = state.inner.lock().await;
    if let Some(call) = guard.as_mut() {
        if call.generation == generation && matches!(call.sideband, Sideband::Open { .. }) {
            call.sideband = Sideband::Idle;
            log::info!("live voice sideband ended (generation {generation}): {error:?}");
            app.emit_or_log(EVENT_CLOSED, LiveVoiceClosed { generation, error });
        }
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Supersedes any existing call, then signals a new one.
#[tauri::command]
pub async fn live_voice_signal(
    state: State<'_, LiveVoiceState>,
    offer_sdp: String,
    instructions: String,
    voice: String,
) -> Result<LiveSignal, String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(previous) = state.inner.lock().await.take() {
        log::info!(
            "live voice call superseded (generation {} -> {generation})",
            previous.generation
        );
        previous.teardown();
    }

    let access = load_access().await?;
    let ids = CallIds::new();
    let (answer_sdp, call_id) =
        post_offer(&access, &ids, &offer_sdp, &instructions, &voice).await?;

    let mut guard = state.inner.lock().await;
    if state.generation.load(Ordering::SeqCst) != generation {
        return Err(ERR_STALE_GENERATION.to_string());
    }
    if let Some(previous) = guard.take() {
        previous.teardown();
    }
    log::info!("live voice call signaled (generation {generation}, {call_id})");
    *guard = Some(LiveCall {
        generation,
        access,
        ids,
        call_id: call_id.clone(),
        sideband: Sideband::Idle,
    });
    Ok(LiveSignal {
        generation,
        answer_sdp,
        call_id,
    })
}

#[tauri::command]
pub async fn live_voice_open_sideband(
    state: State<'_, LiveVoiceState>,
    app: AppHandle,
    generation: u64,
) -> Result<(), String> {
    let (access, ids, call_id) = {
        let mut guard = state.inner.lock().await;
        let call = guard
            .as_mut()
            .filter(|call| call.generation == generation)
            .ok_or_else(|| ERR_STALE_GENERATION.to_string())?;
        if !matches!(call.sideband, Sideband::Idle) {
            return Err(ERR_SIDEBAND_ALREADY_OPEN.to_string());
        }
        call.sideband = Sideband::Connecting;
        (
            CodexAccess {
                access_token: call.access.access_token.clone(),
                account_id: call.access.account_id.clone(),
            },
            CallIds {
                request_session_id: call.ids.request_session_id.clone(),
                session_id: call.ids.session_id.clone(),
            },
            call.call_id.clone(),
        )
    };

    let connected = connect_sideband(&access, &ids, &call_id).await;

    let mut guard = state.inner.lock().await;
    let Some(call) = guard.as_mut().filter(|call| call.generation == generation) else {
        if let Ok(mut socket) = connected {
            tokio::spawn(async move {
                let _ = socket.close(None).await;
            });
        }
        return Err(ERR_STALE_GENERATION.to_string());
    };
    let socket = match connected {
        Ok(socket) => socket,
        Err(error) => {
            call.sideband = Sideband::Idle;
            return Err(error);
        }
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run_sideband(app, generation, socket, rx));
    call.sideband = Sideband::Open { tx, task };
    log::info!("live voice sideband open (generation {generation})");
    Ok(())
}

#[tauri::command]
pub async fn live_voice_send(
    state: State<'_, LiveVoiceState>,
    generation: u64,
    message: String,
) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let call = guard
        .as_ref()
        .filter(|call| call.generation == generation)
        .ok_or_else(|| ERR_STALE_GENERATION.to_string())?;
    match &call.sideband {
        Sideband::Open { tx, .. } => tx
            .send(message)
            .map_err(|_| ERR_SIDEBAND_NOT_OPEN.to_string()),
        _ => Err(ERR_SIDEBAND_NOT_OPEN.to_string()),
    }
}

/// Idempotent: a mismatched or absent call is a no-op.
#[tauri::command]
pub async fn live_voice_close(
    state: State<'_, LiveVoiceState>,
    generation: u64,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if guard
        .as_ref()
        .is_some_and(|call| call.generation == generation)
    {
        if let Some(call) = guard.take() {
            log::info!("live voice call closed (generation {generation})");
            call.teardown();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt_with(claims: &str) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.sig",
            engine.encode(r#"{"alg":"none"}"#),
            engine.encode(claims)
        )
    }

    fn auth_json(token: &str, account_id: Option<&str>) -> String {
        let mut tokens = json!({ "access_token": token });
        if let Some(id) = account_id {
            tokens["account_id"] = json!(id);
        }
        json!({ "tokens": tokens }).to_string()
    }

    fn access(account_id: Option<&str>) -> CodexAccess {
        CodexAccess {
            access_token: "tok".to_string(),
            account_id: account_id.map(String::from),
        }
    }

    fn ids() -> CallIds {
        CallIds {
            request_session_id: "req-id".to_string(),
            session_id: "sess-id".to_string(),
        }
    }

    #[test]
    fn call_id_from_absolute_url() {
        assert_eq!(
            call_id_from_location(
                "https://chatgpt.com/backend-api/codex/realtime/calls/rtc_AbC-1_2"
            )
            .as_deref(),
            Some("rtc_AbC-1_2")
        );
    }

    #[test]
    fn call_id_from_relative_path() {
        assert_eq!(
            call_id_from_location("/v1/realtime/calls/rtc_xyz").as_deref(),
            Some("rtc_xyz")
        );
        assert_eq!(
            call_id_from_location("rtc_bare").as_deref(),
            Some("rtc_bare")
        );
    }

    #[test]
    fn call_id_strips_query_and_trailing_segments() {
        assert_eq!(
            call_id_from_location("/calls/rtc_q1?foo=rtc_nope&x=1").as_deref(),
            Some("rtc_q1")
        );
        assert_eq!(
            call_id_from_location("/calls/rtc_q2/sdp").as_deref(),
            Some("rtc_q2")
        );
    }

    #[test]
    fn call_id_missing() {
        assert_eq!(call_id_from_location(""), None);
        assert_eq!(call_id_from_location("/v1/realtime/calls/"), None);
        assert_eq!(call_id_from_location("/calls/rtc_"), None);
        assert_eq!(call_id_from_location("/calls/rtc_bad.id"), None);
        assert_eq!(call_id_from_location("/calls/xrtc_abc"), None);
    }

    #[test]
    fn headers_contain_all_keys_without_attestation() {
        let headers = live_headers(&access(Some("acct-1")), &ids()).expect("headers");
        assert_eq!(headers.get("authorization").unwrap(), "Bearer tok");
        assert!(headers.get("authorization").unwrap().is_sensitive());
        assert_eq!(headers.get("openai-alpha").unwrap(), "quicksilver=v2");
        assert_eq!(headers.get("user-agent").unwrap(), "Codex Desktop/0.144.1");
        assert_eq!(headers.get("x-session-id").unwrap(), "req-id");
        assert_eq!(headers.get("originator").unwrap(), "Codex Desktop");
        assert_eq!(headers.get("version").unwrap(), "0.144.1");
        assert_eq!(headers.get("session-id").unwrap(), "sess-id");
        assert_eq!(headers.get("thread-id").unwrap(), "sess-id");
        assert_eq!(headers.get("chatgpt-account-id").unwrap(), "acct-1");
        assert!(headers.get("x-oai-attestation").is_none());
        assert!(headers.get("accept").is_none());
        assert!(headers.get("content-type").is_none());
        assert_eq!(headers.len(), 9);
    }

    #[test]
    fn headers_omit_missing_account_id() {
        let headers = live_headers(&access(None), &ids()).expect("headers");
        assert!(headers.get("chatgpt-account-id").is_none());
        assert_eq!(headers.len(), 8);
    }

    #[test]
    fn headers_reject_invalid_token() {
        let bad = CodexAccess {
            access_token: "tok\nevil".to_string(),
            account_id: None,
        };
        assert_eq!(
            live_headers(&bad, &ids()).err().as_deref(),
            Some(ERR_NOT_CONNECTED)
        );
    }

    #[test]
    fn jwt_exp_decodes_valid_and_rejects_garbage() {
        assert_eq!(
            jwt_exp(&jwt_with(r#"{"exp":1700000000}"#)),
            Some(1_700_000_000)
        );
        assert_eq!(jwt_exp("not-a-jwt"), None);
        assert_eq!(jwt_exp("a.!!!.c"), None);
        assert_eq!(jwt_exp(&jwt_with(r#"{"sub":"x"}"#)), None);
    }

    #[test]
    fn access_valid_token() {
        let token = jwt_with(r#"{"exp":2000}"#);
        let access = access_from_auth_json(&auth_json(&token, Some("acct")), 1000).expect("valid");
        assert_eq!(access.access_token, token);
        assert_eq!(access.account_id.as_deref(), Some("acct"));
    }

    #[test]
    fn access_expired_token() {
        let token = jwt_with(r#"{"exp":1000}"#);
        assert_eq!(
            access_from_auth_json(&auth_json(&token, None), 1000)
                .err()
                .as_deref(),
            Some(ERR_TOKEN_EXPIRED)
        );
    }

    #[test]
    fn access_garbage_is_not_connected() {
        for raw in ["".to_string(), "{}".to_string(), auth_json("garbage", None)] {
            assert_eq!(
                access_from_auth_json(&raw, 1000).err().as_deref(),
                Some(ERR_NOT_CONNECTED)
            );
        }
    }

    #[test]
    fn sideband_url_appends_call_id() {
        assert_eq!(
            sideband_url("rtc_abc"),
            "wss://api.openai.com/v1/live/rtc_abc"
        );
        assert!(sideband_url("rtc_abc").into_client_request().is_ok());
    }

    #[test]
    fn error_body_is_collapsed_and_bounded() {
        assert_eq!(bounded_error_body("  a \n\t b  c \r\n"), "a b c");
        assert_eq!(bounded_error_body(""), "");
        let long = "é".repeat(1000);
        assert_eq!(bounded_error_body(&long).chars().count(), 300);
    }

    #[test]
    fn close_codes_map_to_errors() {
        assert_eq!(closed_error(Some(CloseCode::Normal)), None);
        assert_eq!(closed_error(None).as_deref(), Some("sideband-closed:1005"));
        assert_eq!(
            closed_error(Some(CloseCode::Away)).as_deref(),
            Some("sideband-closed:1001")
        );
    }

    #[test]
    fn signal_body_shape() {
        let body = signal_body("v=0", "be brief", "sol");
        assert_eq!(body["sdp"], "v=0");
        assert_eq!(body["session"]["model"], "gpt-live-1-codex");
        assert_eq!(body["session"]["instructions"], "be brief");
        assert_eq!(body["session"]["audio"]["output"]["voice"], "sol");
        assert_eq!(body["session"]["delegation"]["type"], "client");
    }

    #[test]
    fn uuid_v4_format() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(id, uuid_v4());
    }
}
