// Krypton — Loopback app (spec 341).
//
// Every browser page the hook server serves is one document of a single Vite
// application (`src/loopback/`). Rust builds the document; the page's script and
// the one shared stylesheet come from `/app/assets/`. Release builds read them
// from the embedded `frontendDist` (`dist/app/`); debug builds redirect the
// script to the Vite dev server, which also injects the CSS the modules import.
//
// The session capability lets the shell link the four token-gated surfaces
// (Terminal Control, ACP wire, Hurl, E2E). Krypton opens a page through
// `/app/session/<token>?next=<path>`; the landing stores the token in the
// origin's localStorage and the shell trades it for capability URLs at
// `/app/api/<token>/capabilities`. ADR 0026 records the trade-off.

use axum::{
    body::Body,
    extract::{Path, Query, State as AxumState},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::sync::Arc;

use crate::hook_server::{
    constant_time_token_eq, frontend_dist_asset, html_response, secured_json_response,
    HookServerState,
};

/// Vite's dev server. `localhost`, not 127.0.0.1: Vite binds `localhost`, which
/// can be IPv6-only (`[::1]:1420`); the browser tries both addresses (spec 330).
const VITE_DEV_ORIGIN: &str = "http://localhost:1420";

/// `<html data-scheme>`: status walls are fixed dark, readers follow the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scheme {
    Dark,
    Auto,
}

impl Scheme {
    fn as_str(self) -> &'static str {
        match self {
            Scheme::Dark => "dark",
            Scheme::Auto => "auto",
        }
    }
}

/// One loopback document.
pub(crate) struct AppPage<'a> {
    /// `src/loopback/entries/<entry>.ts` → `/app/assets/<entry>.js`.
    pub entry: &'a str,
    /// Plain text; escaped here. Rendered as `<title> · Krypton`.
    pub title: &'a str,
    pub lang: &'a str,
    pub scheme: Scheme,
    /// Rust-rendered `<main>` content (the readers). `None` → a boot line the
    /// entry replaces on mount.
    pub body: Option<String>,
    /// A page-specific Content-Security-Policy (the GenUI gallery keeps its own).
    pub csp: Option<&'a str>,
}

impl<'a> AppPage<'a> {
    pub(crate) fn new(entry: &'a str, title: &'a str, scheme: Scheme) -> Self {
        Self {
            entry,
            title,
            lang: "en",
            scheme,
            body: None,
            csp: None,
        }
    }

    pub(crate) fn with_body(mut self, body: String) -> Self {
        self.body = Some(body);
        self
    }

    pub(crate) fn with_lang(mut self, lang: &'a str) -> Self {
        self.lang = lang;
        self
    }

    pub(crate) fn with_csp(mut self, csp: &'a str) -> Self {
        self.csp = Some(csp);
        self
    }
}

fn escape(s: &str) -> String {
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

/// The document text. Split from the response so tests can read it.
pub(crate) fn app_page_html(page: &AppPage<'_>) -> String {
    debug_assert!(valid_entry_name(page.entry), "bad entry {}", page.entry);
    // Debug: Vite injects the CSS each module imports, so a <link> would load a
    // second copy. Release: one merged stylesheet (`build.cssCodeSplit: false`).
    let stylesheet = if cfg!(debug_assertions) {
        ""
    } else {
        "<link rel=\"stylesheet\" href=\"/app/assets/app.css\">"
    };
    let main = match &page.body {
        Some(body) => body.clone(),
        None => {
            "<p class=\"lb-boot\">Loading… (debug builds need the Vite dev server on :1420)</p>"
                .to_string()
        }
    };
    format!(
        "<!doctype html>\n<html lang=\"{lang}\" data-scheme=\"{scheme}\" data-surface=\"{entry}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"color-scheme\" content=\"{color_scheme}\">\n<link rel=\"icon\" href=\"data:,\">\n<title>{title} · Krypton</title>\n{stylesheet}\n<script type=\"module\" src=\"/app/assets/{entry}.js\"></script>\n</head>\n<body>\n<header id=\"lb-shell\" class=\"lb-shell\"></header>\n<main id=\"lb-main\" class=\"lb-main\">{main}</main>\n</body>\n</html>\n",
        lang = escape(page.lang),
        scheme = page.scheme.as_str(),
        entry = page.entry,
        color_scheme = match page.scheme {
            Scheme::Dark => "dark",
            Scheme::Auto => "light dark",
        },
        title = escape(page.title),
    )
}

pub(crate) fn app_page_response(page: AppPage<'_>) -> Response {
    let html = app_page_html(&page);
    let mut response = html_response(html);
    if let Some(csp) = page.csp {
        if let Ok(value) = header::HeaderValue::from_str(csp) {
            response
                .headers_mut()
                .insert(header::CONTENT_SECURITY_POLICY, value);
        }
    }
    response
}

fn valid_entry_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_asset_segment(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `app.css`, `<entry>.js` and `chunks/<name>.js` — never a path that leaves
/// `dist/app/`.
pub(crate) fn valid_asset_name(name: &str) -> bool {
    match name.split_once('/') {
        None => valid_asset_segment(name),
        Some(("chunks", rest)) => valid_asset_segment(rest),
        Some(_) => false,
    }
}

/// GET /app/assets/{*name}
pub(crate) async fn handle_app_asset(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(name): Path<String>,
) -> Response {
    if !valid_asset_name(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if cfg!(debug_assertions) {
        // Only entry scripts are requested in debug; their imports resolve
        // against the Vite origin the redirect lands on.
        let Some(entry) = name.strip_suffix(".js").filter(|e| valid_entry_name(e)) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        return Response::builder()
            .status(StatusCode::TEMPORARY_REDIRECT)
            .header(
                header::LOCATION,
                format!("{VITE_DEV_ORIGIN}/src/loopback/entries/{entry}.ts"),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    frontend_dist_asset(state.app_handle(), &format!("app/{name}"))
}

/// GET / — the Home page.
pub(crate) async fn handle_home() -> Response {
    app_page_response(AppPage::new("home", "Home", Scheme::Dark))
}

// ─── Session capability ──────────────────────────────────────────────

/// Process-lifetime capability that lets the shell link token-gated surfaces.
pub struct LoopbackSession {
    token: String,
}

impl Default for LoopbackSession {
    fn default() -> Self {
        Self::new()
    }
}

impl LoopbackSession {
    pub fn new() -> Self {
        Self {
            token: crate::termctrl_monitor::capability_token(),
        }
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }

    pub(crate) fn matches(&self, candidate: &str) -> bool {
        constant_time_token_eq(candidate, &self.token)
    }
}

/// A same-origin path for `next`: absolute path, no authority, no scheme, no
/// backslash, no control characters. Rejects everything an open redirect
/// needs (`//host`, `/\host`, `https:…`).
pub(crate) fn valid_next_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains('\\')
        && !path.chars().any(|c| c.is_control())
        && path.len() <= 4096
}

/// Percent-encode `value` for a query parameter (RFC 3986 unreserved + `/`).
fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The URL Krypton opens: the session landing that forwards to `path`.
pub(crate) fn session_url(port: u16, token: &str, path: &str) -> Result<String, String> {
    if port == 0 {
        return Err("hook server not ready".to_string());
    }
    if !valid_next_path(path) {
        return Err(format!("not a loopback path: {path}"));
    }
    Ok(format!(
        "http://127.0.0.1:{port}/app/session/{token}?next={}",
        encode_query_value(path)
    ))
}

#[derive(Deserialize)]
pub(crate) struct SessionQuery {
    next: Option<String>,
}

/// What `/app/session/{token}` answers before it serves anything: `404` for a
/// token that is not this process's session — checked first, so a probe learns
/// nothing about `next` — then `400` for a `next` that is not a same-origin path.
pub(crate) fn session_landing_gate(
    session: &LoopbackSession,
    token: &str,
    next: &str,
) -> Result<(), StatusCode> {
    if !session.matches(token) {
        return Err(StatusCode::NOT_FOUND);
    }
    if !valid_next_path(next) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}

/// GET /app/session/{token}?next=<path> — store the capability, then forward.
pub(crate) async fn handle_session(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
    Query(query): Query<SessionQuery>,
) -> Response {
    let next = query.next.unwrap_or_else(|| "/".to_string());
    if let Err(status) = session_landing_gate(state.hook_server().loopback_session(), &token, &next)
    {
        return status.into_response();
    }
    app_page_response(AppPage::new("session", "Opening", Scheme::Dark))
}

/// GET /app/api/directory — projects with live harnesses, tokenless.
pub(crate) async fn handle_directory(
    AxumState(state): AxumState<Arc<HookServerState>>,
) -> Response {
    secured_json_response(StatusCode::OK, state.hook_server().loopback_directory())
}

/// GET /app/api/{token}/capabilities — capability URLs for the shell.
pub(crate) async fn handle_capabilities(
    AxumState(state): AxumState<Arc<HookServerState>>,
    Path(token): Path<String>,
) -> Response {
    let hook_server = state.hook_server();
    if !hook_server.loopback_session().matches(&token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    secured_json_response(StatusCode::OK, hook_server.loopback_capabilities())
}

/// Numeric order for `hm-<n>` ids (string order puts `hm-10` before `hm-2`).
pub(crate) fn harness_id_order(a: &str, b: &str) -> std::cmp::Ordering {
    fn seq(id: &str) -> Option<u64> {
        id.strip_prefix("hm-").and_then(|n| n.parse().ok())
    }
    match (seq(a), seq(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        _ => a.cmp(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_path_must_stay_on_this_origin() {
        assert!(valid_next_path("/"));
        assert!(valid_next_path("/docs?harness=hm-2"));
        assert!(valid_next_path("/termctrl/abc#x"));
        for bad in [
            "",
            "docs",
            "//evil.example",
            "/\\evil.example",
            "https://evil.example",
            "/a\nb",
        ] {
            assert!(!valid_next_path(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn session_url_encodes_the_target_and_refuses_foreign_paths() {
        let url = session_url(8765, "tok", "/docs?harness=hm-2&path=a b").unwrap();
        assert_eq!(
            url,
            "http://127.0.0.1:8765/app/session/tok?next=/docs%3Fharness%3Dhm-2%26path%3Da%20b"
        );
        assert!(session_url(8765, "tok", "//evil").is_err());
        assert!(session_url(0, "tok", "/").is_err());
    }

    #[test]
    fn asset_names_stay_inside_the_app_bundle() {
        assert!(valid_asset_name("app.css"));
        assert!(valid_asset_name("home.js"));
        assert!(valid_asset_name("chunks/kit-1a2B.js"));
        for bad in [
            "",
            "..",
            "chunks/..",
            "chunks/",
            "other/x.js",
            "chunks/a/b.js",
            "a%2Fb",
        ] {
            assert!(!valid_asset_name(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn session_compare_checks_the_whole_token() {
        let session = LoopbackSession::new();
        let token = session.token().to_string();
        assert!(session.matches(&token));
        assert!(!session.matches(&token[..token.len() - 1]));
        assert!(!session.matches(""));
        let mut flipped = token.clone().into_bytes();
        flipped[0] = if flipped[0] == b'a' { b'b' } else { b'a' };
        assert!(!session.matches(std::str::from_utf8(&flipped).unwrap()));
    }

    #[test]
    fn session_landing_refuses_a_foreign_token_before_reading_next() {
        let session = LoopbackSession::new();
        let token = session.token().to_string();
        let other = LoopbackSession::new();
        assert_eq!(
            session_landing_gate(&session, other.token(), "/docs"),
            Err(StatusCode::NOT_FOUND)
        );
        // A wrong token never reveals whether `next` would have been accepted.
        assert_eq!(
            session_landing_gate(&session, other.token(), "//evil.example"),
            Err(StatusCode::NOT_FOUND)
        );
        for bad in [
            "//evil.example",
            "/\\evil.example",
            "https://evil.example",
            "docs",
        ] {
            assert_eq!(
                session_landing_gate(&session, &token, bad),
                Err(StatusCode::BAD_REQUEST),
                "{bad:?} must be refused"
            );
        }
        assert_eq!(
            session_landing_gate(&session, &token, "/docs?harness=hm-2#a"),
            Ok(())
        );
    }

    #[test]
    fn page_document_escapes_the_title_and_names_its_entry() {
        let html = app_page_html(
            &AppPage::new("docs", "<x>", Scheme::Auto).with_body("<p>body</p>".into()),
        );
        assert!(html.contains("<title>&lt;x&gt; · Krypton</title>"));
        assert!(html.contains("data-scheme=\"auto\""));
        assert!(html.contains("src=\"/app/assets/docs.js\""));
        assert!(html.contains("<main id=\"lb-main\" class=\"lb-main\"><p>body</p></main>"));
        let boot = app_page_html(&AppPage::new("home", "Home", Scheme::Dark));
        assert!(boot.contains("class=\"lb-boot\""));
    }

    #[test]
    fn harness_ids_sort_numerically() {
        let mut ids = vec!["hm-10", "hm-2", "hm-1"];
        ids.sort_by(|a, b| harness_id_order(a, b));
        assert_eq!(ids, ["hm-1", "hm-2", "hm-10"]);
    }
}
