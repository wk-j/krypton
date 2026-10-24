//! Harness E2E browser explorer (spec 0329).
//!
//! A read-only page on the loopback server for one project's e2e cases and
//! runs. Logs and adapter evidence are content, so the page sits in the
//! capability-token tier (specs 0198/0288): one 128-bit token per canonical
//! project root, reused until Krypton exits, as the Hurl web client does
//! (spec 0227). An unknown token gets a bare `404`.
//!
//! Every route reads; none runs, cancels or writes. Data comes from `e2e.rs`:
//! `status` is the same `gather` as `#e2e status`, and ext runs are read from
//! its history cache.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::e2e::{self, E2eActiveLaunch, E2eState, E2eStatus};
use crate::hook_server::{html_response, secured_json_response};

const E2E_HTML: &str = include_str!("../../src/acp/artifact-e2e.html");

/// Capability tokens for the explorer, one per canonical project root.
#[derive(Default)]
pub struct E2eWebSessions {
    by_root: Mutex<HashMap<PathBuf, String>>,
    by_token: Mutex<HashMap<String, PathBuf>>,
}

impl E2eWebSessions {
    /// The token for `root`, minted on first use and reused until exit.
    pub fn issue(&self, root: &str) -> Result<String, String> {
        let canonical = Path::new(root)
            .canonicalize()
            .map_err(|e| format!("project root {root}: {e}"))?;
        if !canonical.is_dir() {
            return Err(format!("project root {root} is not a directory"));
        }
        let mut by_root = self.by_root.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(token) = by_root.get(&canonical) {
            return Ok(token.clone());
        }
        let token = crate::termctrl_monitor::capability_token();
        self.by_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token.clone(), canonical.clone());
        by_root.insert(canonical, token.clone());
        Ok(token)
    }

    fn root(&self, token: &str) -> Option<PathBuf> {
        self.by_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .cloned()
    }
}

#[derive(Clone)]
struct WebState {
    sessions: Arc<E2eWebSessions>,
    e2e: Arc<E2eState>,
}

/// The explorer's routes, with their own state; merged into the loopback router.
pub fn router(sessions: Arc<E2eWebSessions>, e2e: Arc<E2eState>) -> Router {
    Router::new()
        .route("/e2e/{token}", get(page))
        .route("/e2e/api/{token}/status", get(status))
        .route("/e2e/api/{token}/active", get(active))
        .route("/e2e/api/{token}/run", get(run))
        .route("/e2e/api/{token}/log", get(log))
        .route("/e2e/api/{token}/artifact", get(artifact))
        .with_state(WebState { sessions, e2e })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusPayload {
    project_name: String,
    #[serde(flatten)]
    status: E2eStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivePayload {
    active_launch: Option<E2eActiveLaunch>,
}

#[derive(Deserialize)]
struct RunQuery {
    case: String,
    run: String,
}

#[derive(Deserialize)]
struct LogQuery {
    launch: String,
}

#[derive(Deserialize)]
struct ArtifactQuery {
    case: String,
    run: String,
    index: usize,
}

async fn page(State(state): State<WebState>, UrlPath(token): UrlPath<String>) -> Response {
    match state.sessions.root(&token) {
        Some(_) => html_response(E2E_HTML),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn status(State(state): State<WebState>, UrlPath(token): UrlPath<String>) -> Response {
    let Some(root) = state.sessions.root(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let project_name = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let status = e2e::status(&state.e2e, &root, true).await;
    secured_json_response(
        StatusCode::OK,
        StatusPayload {
            project_name,
            status,
        },
    )
}

async fn active(State(state): State<WebState>, UrlPath(token): UrlPath<String>) -> Response {
    let Some(root) = state.sessions.root(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let active_launch = state.e2e.active_launch(&root);
    secured_json_response(StatusCode::OK, ActivePayload { active_launch })
}

async fn run(
    State(state): State<WebState>,
    UrlPath(token): UrlPath<String>,
    Query(query): Query<RunQuery>,
) -> Response {
    let Some(root) = state.sessions.root(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match e2e::run_detail(&state.e2e, &root, &query.case, &query.run) {
        Ok(detail) => secured_json_response(StatusCode::OK, detail),
        Err(error) => error_response(&error),
    }
}

async fn log(
    State(state): State<WebState>,
    UrlPath(token): UrlPath<String>,
    Query(query): Query<LogQuery>,
) -> Response {
    let Some(root) = state.sessions.root(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match e2e::launch_log(&root, &query.launch) {
        Ok(bytes) => content_response(bytes, "text/plain; charset=utf-8", None),
        Err(error) => error_response(&error),
    }
}

async fn artifact(
    State(state): State<WebState>,
    UrlPath(token): UrlPath<String>,
    Query(query): Query<ArtifactQuery>,
) -> Response {
    let Some(root) = state.sessions.root(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match e2e::run_artifact(&state.e2e, &root, &query.case, &query.run, query.index) {
        Ok((path, bytes)) => {
            let (content_type, download) = artifact_type(&path);
            let name = download.then(|| download_name(&path));
            content_response(bytes, content_type, name.as_deref())
        }
        Err(error) => error_response(&error),
    }
}

/// `(content type, served as a download)`. Script-capable formats (HTML, SVG)
/// are plain text, so project-authored script never runs on loopback.
fn artifact_type(path: &Path) -> (&'static str, bool) {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => ("image/png", false),
        "jpg" | "jpeg" => ("image/jpeg", false),
        "gif" => ("image/gif", false),
        "webp" => ("image/webp", false),
        "json" | "txt" | "log" | "md" | "csv" | "xml" | "yaml" | "yml" | "html" | "htm" | "svg" => {
            ("text/plain; charset=utf-8", false)
        }
        _ => ("application/octet-stream", true),
    }
}

/// The file name for `Content-Disposition`, reduced to safe characters.
fn download_name(path: &Path) -> String {
    let name: String = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty() {
        "artifact".to_string()
    } else {
        name
    }
}

/// Raw content: never cached, never sniffed, never scripted.
fn content_response(bytes: Vec<u8>, content_type: &str, download: Option<&str>) -> Response {
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(content_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    if let Some(name) = download {
        if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
            headers.insert(header::CONTENT_DISPOSITION, value);
        }
    }
    response
}

/// `not_found:` → 404, `too_large:` → 413, anything else → 400.
fn error_response(error: &str) -> Response {
    let status = if error.starts_with("not_found:") {
        StatusCode::NOT_FOUND
    } else if error.starts_with("too_large:") {
        StatusCode::PAYLOAD_TOO_LARGE
    } else {
        StatusCode::BAD_REQUEST
    };
    secured_json_response(status, json!({ "error": error }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct Project(PathBuf);

    impl Project {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "krypton-e2e-web-{name}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(path.join(".krypton/e2e/runs/L1")).unwrap();
            Project(path.canonicalize().unwrap())
        }
    }

    impl Drop for Project {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// One finished Krypton launch `L1` of case `c` with a log and two artifacts.
    fn seed(root: &Path) {
        let ledger = [
            json!({"kind":"start","launchId":"L1","startedAt":"2026-10-23T08:00:00Z","caseId":"c","argv":["a","run","c"]}),
            json!({"kind":"finish","launchId":"L1","finishedAt":"2026-10-23T08:01:00Z","exitCode":0,"cancelled":false}),
        ];
        let text: String = ledger.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(root.join(".krypton/e2e/launches.jsonl"), text).unwrap();
        let result = json!({
            "version":1,"caseId":"c","runId":"r1","verdict":"PASS",
            "startedAt":"2026-10-23T08:00:00Z","finishedAt":"2026-10-23T08:01:00Z",
            "checks":[{"label":"a","status":"pass"}],
            "artifacts":[{"label":"page","path":"evidence/page.html"},{"label":"blob","path":"evidence/blob.bin"}]
        });
        let run_dir = root.join(".krypton/e2e/runs/L1");
        std::fs::write(run_dir.join("result.json"), result.to_string()).unwrap();
        std::fs::write(run_dir.join("log"), "log line").unwrap();
        std::fs::create_dir_all(root.join("evidence")).unwrap();
        std::fs::write(root.join("evidence/page.html"), "<script>alert(1)</script>").unwrap();
        std::fs::write(root.join("evidence/blob.bin"), [0u8, 1, 2]).unwrap();
    }

    /// Serve the explorer on an ephemeral loopback port.
    async fn serve(sessions: Arc<E2eWebSessions>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = router(sessions, Arc::new(E2eState::default()));
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{addr}")
    }

    #[test]
    fn e2e_web_token_is_per_root_and_stable() {
        let a = Project::new("token-a");
        let b = Project::new("token-b");
        let sessions = E2eWebSessions::default();
        let first = sessions.issue(a.0.to_str().unwrap()).unwrap();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        // A non-canonical spelling of the same root reuses the token.
        let dotted = a.0.join(".krypton").join("..");
        assert_eq!(sessions.issue(dotted.to_str().unwrap()).unwrap(), first);
        assert_ne!(sessions.issue(b.0.to_str().unwrap()).unwrap(), first);
        assert_eq!(sessions.root(&first), Some(a.0.clone()));
        assert!(sessions.issue("/nonexistent/krypton-e2e-web").is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_web_routes_are_capability_gated_and_read_only() {
        let project = Project::new("routes");
        seed(&project.0);
        let sessions = Arc::new(E2eWebSessions::default());
        let token = sessions.issue(project.0.to_str().unwrap()).unwrap();
        let base = serve(Arc::clone(&sessions)).await;
        let client = reqwest::Client::new();
        let get = |path: String| client.get(format!("{base}{path}")).send();

        // An unknown token is a bare 404 on every route.
        let forged = "0".repeat(32);
        for path in [
            format!("/e2e/{forged}"),
            format!("/e2e/api/{forged}/status"),
            format!("/e2e/api/{forged}/active"),
            format!("/e2e/api/{forged}/run?case=c&run=r1"),
            format!("/e2e/api/{forged}/log?launch=L1"),
            format!("/e2e/api/{forged}/artifact?case=c&run=r1&index=0"),
        ] {
            let response = get(path.clone()).await.unwrap();
            assert_eq!(response.status(), 404, "{path}");
            assert!(response.bytes().await.unwrap().is_empty(), "{path}");
        }

        let page = get(format!("/e2e/{token}")).await.unwrap();
        assert_eq!(page.status(), 200);
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");

        let status: serde_json::Value = get(format!("/e2e/api/{token}/status"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["initialized"], false);
        assert_eq!(status["runs"][0]["runId"], "r1");
        assert!(status["projectName"]
            .as_str()
            .unwrap()
            .starts_with("krypton-e2e-web-routes"));
        let active: serde_json::Value = get(format!("/e2e/api/{token}/active"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(active, json!({ "activeLaunch": null }));

        let run: serde_json::Value = get(format!("/e2e/api/{token}/run?case=c&run=r1"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(run["result"]["checks"][0]["label"], "a");
        assert_eq!(run["log"], true);
        assert_eq!(
            get(format!("/e2e/api/{token}/run?case=c&run=nope"))
                .await
                .unwrap()
                .status(),
            404
        );

        let log = get(format!("/e2e/api/{token}/log?launch=L1"))
            .await
            .unwrap();
        assert_eq!(log.headers()[header::CONTENT_SECURITY_POLICY], "sandbox");
        assert_eq!(log.text().await.unwrap(), "log line");
        assert_eq!(
            get(format!("/e2e/api/{token}/log?launch=.."))
                .await
                .unwrap()
                .status(),
            404
        );

        // HTML evidence is text with a sandbox CSP; unknown types download.
        let html = get(format!("/e2e/api/{token}/artifact?case=c&run=r1&index=0"))
            .await
            .unwrap();
        assert_eq!(
            html.headers()[header::CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        assert_eq!(html.headers()[header::CONTENT_SECURITY_POLICY], "sandbox");
        assert_eq!(html.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let blob = get(format!("/e2e/api/{token}/artifact?case=c&run=r1&index=1"))
            .await
            .unwrap();
        assert_eq!(
            blob.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename=\"blob.bin\""
        );
        assert_eq!(blob.bytes().await.unwrap().as_ref(), [0u8, 1, 2]);

        // No route accepts a write.
        let post = client
            .post(format!("{base}/e2e/api/{token}/status"))
            .send()
            .await
            .unwrap();
        assert_eq!(post.status(), 405);
    }
}
