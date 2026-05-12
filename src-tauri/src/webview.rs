//! In-app webview windows (Krypton M3 — feature 102).
//!
//! Hosts Tauri v2 child webviews attached to the main window. Each webview
//! is identified by a u32 id surfaced to the frontend, with the underlying
//! Tauri label derived as `krypton-webview-{id}` so commands fired from
//! inside an injected bridge script can be traced back to a specific
//! Krypton pane.
//!
//! Z-order on macOS/Windows places child webviews above all host DOM —
//! callers are expected to hide() webviews whenever their owning pane is
//! not visible (workspace switch, overlay, hidden tab).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl};

use crate::util::emit::EmitExt;

const LABEL_PREFIX: &str = "krypton-webview-";

pub struct WebviewRegistry {
    next_id: AtomicU32,
    entries: Mutex<HashMap<u32, WebviewEntry>>,
}

struct WebviewEntry {
    webview: Webview,
}

impl WebviewRegistry {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for WebviewRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
struct LoadingPayload {
    id: u32,
    started: bool,
}

#[derive(Clone, Serialize)]
struct NavigatedPayload {
    id: u32,
    url: String,
}

#[derive(Clone, Serialize)]
struct TitlePayload {
    id: u32,
    title: String,
}

#[derive(Clone, Serialize)]
struct ChordPayload {
    id: u32,
    key: String,
    mods: u32,
}

#[derive(Clone, Serialize)]
struct ActionPayload {
    id: u32,
    kind: String,
    url: Option<String>,
    target: Option<String>,
}

fn id_from_label(label: &str) -> Option<u32> {
    label
        .strip_prefix(LABEL_PREFIX)
        .and_then(|s| s.parse().ok())
}

fn bridge_script(id: u32) -> String {
    // Source kept in webview_bridge.js so the ~300 lines of JS stay readable
    // without `{{}}` escaping. We swap a literal placeholder for the runtime
    // id; using replace() keeps any other `{` / `}` in the script untouched.
    const SCRIPT: &str = include_str!("webview_bridge.js");
    SCRIPT.replace("__KRYPTON_ID__", &id.to_string())
}

#[tauri::command]
pub async fn spawn_webview(
    app: AppHandle,
    state: State<'_, Arc<WebviewRegistry>>,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<u32, String> {
    let parsed: Url = url.parse().map_err(|e| format!("invalid URL: {e}"))?;
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let label = format!("{LABEL_PREFIX}{id}");

    let app_for_nav = app.clone();
    let app_for_load = app.clone();

    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        .initialization_script(bridge_script(id))
        .on_navigation(move |target| {
            app_for_nav.emit_or_log(
                "webview-navigated",
                NavigatedPayload {
                    id,
                    url: target.to_string(),
                },
            );
            true
        })
        .on_page_load(move |_wv, payload| {
            let started = matches!(payload.event(), PageLoadEvent::Started);
            app_for_load.emit_or_log("webview-loading", LoadingPayload { id, started });
        });

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let webview = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("add_child failed: {e}"))?;

    state
        .entries
        .lock()
        .map_err(|_| "registry poisoned".to_string())?
        .insert(id, WebviewEntry { webview });

    log::info!("spawned webview {id} → {url}");
    Ok(id)
}

#[tauri::command]
pub fn navigate_webview(
    state: State<'_, Arc<WebviewRegistry>>,
    id: u32,
    url: String,
) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e| format!("invalid URL: {e}"))?;
    let entries = state
        .entries
        .lock()
        .map_err(|_| "registry poisoned".to_string())?;
    let entry = entries
        .get(&id)
        .ok_or_else(|| "webview not found".to_string())?;
    entry.webview.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_webview(
    state: State<'_, Arc<WebviewRegistry>>,
    id: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let entries = state
        .entries
        .lock()
        .map_err(|_| "registry poisoned".to_string())?;
    let entry = entries
        .get(&id)
        .ok_or_else(|| "webview not found".to_string())?;
    entry
        .webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    entry
        .webview
        .set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_webview_visible(
    state: State<'_, Arc<WebviewRegistry>>,
    id: u32,
    visible: bool,
) -> Result<(), String> {
    let entries = state
        .entries
        .lock()
        .map_err(|_| "registry poisoned".to_string())?;
    let entry = entries
        .get(&id)
        .ok_or_else(|| "webview not found".to_string())?;
    if visible {
        entry.webview.show().map_err(|e| e.to_string())
    } else {
        entry.webview.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn focus_webview(state: State<'_, Arc<WebviewRegistry>>, id: u32) -> Result<(), String> {
    let entries = state
        .entries
        .lock()
        .map_err(|_| "registry poisoned".to_string())?;
    let entry = entries
        .get(&id)
        .ok_or_else(|| "webview not found".to_string())?;
    entry.webview.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_webview(state: State<'_, Arc<WebviewRegistry>>, id: u32) -> Result<(), String> {
    let entry = {
        let mut entries = state
            .entries
            .lock()
            .map_err(|_| "registry poisoned".to_string())?;
        entries.remove(&id)
    };
    if let Some(entry) = entry {
        entry.webview.close().map_err(|e| e.to_string())?;
        log::info!("closed webview {id}");
    }
    Ok(())
}

#[tauri::command]
pub fn webview_back(state: State<'_, Arc<WebviewRegistry>>, id: u32) -> Result<(), String> {
    eval_on(&state, id, "history.back()")
}

#[tauri::command]
pub fn webview_forward(state: State<'_, Arc<WebviewRegistry>>, id: u32) -> Result<(), String> {
    eval_on(&state, id, "history.forward()")
}

#[tauri::command]
pub fn webview_reload(state: State<'_, Arc<WebviewRegistry>>, id: u32) -> Result<(), String> {
    eval_on(&state, id, "location.reload()")
}

fn eval_on(state: &State<'_, Arc<WebviewRegistry>>, id: u32, js: &str) -> Result<(), String> {
    let entries = state
        .entries
        .lock()
        .map_err(|_| "registry poisoned".to_string())?;
    let entry = entries
        .get(&id)
        .ok_or_else(|| "webview not found".to_string())?;
    entry.webview.eval(js).map_err(|e| e.to_string())
}

/// Invoked by the bridge script from inside a child webview. Yanks focus
/// back to the host window then re-emits the chord into the input router.
#[tauri::command]
pub fn forward_chord(
    app: AppHandle,
    webview: Webview,
    id: u32,
    key: String,
    mods: u32,
) -> Result<(), String> {
    // Trust the bridge-supplied id but fall back to label parsing if the
    // injected script ever races against close/respawn.
    let resolved_id = id_from_label(webview.label()).unwrap_or(id);
    if let Some(main) = app.get_webview_window("main") {
        if let Err(e) = main.set_focus() {
            log::warn!("forward_chord: set_focus failed: {e}");
        }
    }
    app.emit_or_log(
        "chord-from-webview",
        ChordPayload {
            id: resolved_id,
            key,
            mods,
        },
    );
    Ok(())
}

/// Invoked by the bridge script's Vimium-lite layer when a hint action needs
/// host involvement (e.g. open the chosen link in a new pane). The host
/// listens for `webview-action` and routes by `kind`.
#[tauri::command]
pub fn forward_action(
    app: AppHandle,
    webview: Webview,
    id: u32,
    kind: String,
    url: Option<String>,
    target: Option<String>,
) -> Result<(), String> {
    let resolved_id = id_from_label(webview.label()).unwrap_or(id);
    app.emit_or_log(
        "webview-action",
        ActionPayload {
            id: resolved_id,
            kind,
            url,
            target,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn forward_title(
    app: AppHandle,
    webview: Webview,
    id: u32,
    title: String,
) -> Result<(), String> {
    let resolved_id = id_from_label(webview.label()).unwrap_or(id);
    app.emit_or_log(
        "webview-title",
        TitlePayload {
            id: resolved_id,
            title,
        },
    );
    Ok(())
}
