pub mod acp;
mod commands;
mod config;
pub mod hook_server;
pub mod hurl;
pub mod music;
pub mod pencil;
mod pty;
mod quick_search;
mod session;
pub mod sound;
pub mod ssh;
pub mod theme;

use std::sync::{Arc, Mutex, RwLock};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_manager = Arc::new(pty::PtyManager::new());
    let pty_manager_for_poller = pty_manager.clone();

    // Load configuration from disk (creates default file if missing)
    let krypton_config = Arc::new(RwLock::new(config::load_config()));

    // Initialize theme engine (loads built-in themes)
    let theme_engine = Arc::new(theme::ThemeEngine::new());

    // Initialize sound engine
    let sound_engine: sound::SoundEngineState = Mutex::new(sound::SoundEngine::new());

    // Initialize hurl runner state
    let hurl_state = Arc::new(hurl::HurlState::default());

    // Initialize hook server state
    let hook_server = Arc::new(hook_server::HookServer::new());

    // Initialize SSH manager
    let ssh_socket_dir = config::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("ssh-sockets");
    let ssh_persist = krypton_config
        .read()
        .map(|cfg| cfg.ssh.control_persist)
        .unwrap_or(600);
    let ssh_manager = Arc::new(ssh::SshManager::new(ssh_socket_dir, ssh_persist));
    // Clean up stale sockets from previous runs
    ssh_manager.cleanup_sockets();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app: &tauri::AppHandle, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Code, ShortcutState};
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    match shortcut.key {
                        Code::KeyK => {
                            let _ = app.emit("prompt-dialog-requested", ());
                        }
                        Code::KeyS => {
                            let _ = app.emit("capture-requested", ());
                        }
                        Code::Digit0 => {
                            // Panic recenter: recover an invisible/offscreen window.
                            if let Some(w) = app.get_webview_window("main") {
                                recover_window(&w);
                            }
                        }
                        _ => {}
                    }
                })
                .build(),
        )
        .manage(pty_manager)
        .manage(krypton_config.clone())
        .manage(theme_engine.clone())
        .manage(sound_engine)
        .manage(ssh_manager)
        .manage(hook_server.clone())
        .manage(hurl_state)
        .manage(quick_search::QuickSearchState::new())
        .manage(Arc::new(acp::AcpRegistry::new()))
        // MusicEngine is initialized in .setup() because it needs app_handle
        .invoke_handler(tauri::generate_handler![
            commands::spawn_pty,
            commands::get_pty_cwd,
            commands::write_to_pty,
            commands::resize_pty,
            commands::get_config,
            commands::get_theme,
            commands::list_themes,
            commands::reload_config,
            commands::open_url,
            commands::get_foreground_process,
            commands::get_java_stats,
            commands::find_java_pid,
            commands::find_java_server,
            commands::find_java_server_for_session,
            commands::find_java_server_by_cwd,
            commands::list_directory,
            commands::search_files,
            commands::stat_files,
            commands::read_file,
            commands::write_file,
            commands::create_harness_memory,
            commands::clear_harness_memory_lane,
            commands::get_app_cwd,
            commands::list_harness_memory,
            commands::dispose_harness_memory,
            commands::list_harness_mcp_stats,
            commands::save_temp_image,
            commands::capture_screen,
            commands::get_env_var,
            commands::run_command,
            commands::run_shell,
            commands::kill_shell,
            commands::get_default_shell,
            commands::query_sqlite,
            commands::set_ssh_remote_cwd,
            commands::detect_ssh_session,
            commands::clone_ssh_session,
            sound::sound_play,
            sound::sound_play_keypress,
            sound::sound_apply_config,
            sound::sound_load_pack,
            sound::sound_get_packs,
            music::music_load_dir,
            music::music_load_file,
            music::music_play,
            music::music_pause,
            music::music_stop,
            music::music_next,
            music::music_previous,
            music::music_play_index,
            music::music_seek,
            music::music_set_volume,
            music::music_toggle_repeat,
            music::music_toggle_shuffle,
            music::music_get_state,
            commands::set_agent_active,
            commands::get_hook_server_port,
            commands::get_hook_server_config_snippet,
            session::session_create,
            session::session_append,
            session::session_load,
            session::session_continue_recent,
            session::session_list,
            hurl::list_hurl_files,
            hurl::hurl_read_env_file,
            hurl::hurl_run,
            hurl::hurl_cancel,
            hurl::hurl_save_cache,
            hurl::hurl_load_cached,
            hurl::hurl_clear_cache,
            hurl::hurl_load_sidebar_state,
            hurl::hurl_save_sidebar_state,
            quick_search::quick_search_warm_root,
            quick_search::quick_search_query,
            quick_search::quick_grep_query,
            quick_search::quick_search_record_pick,
            acp::acp_list_backends,
            acp::acp_spawn,
            acp::acp_initialize,
            acp::acp_prompt,
            acp::acp_cancel,
            acp::acp_permission_response,
            acp::acp_dispose,
            pencil::read_pencil_file,
            pencil::write_pencil_file,
            pencil::scan_pencil_dir,
        ])
        .setup(move |app| {
            // File logging is enabled in release too, so invisible-window and
            // similar post-mortem bugs are diagnosable from ~/Library/Logs/Krypton/.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            // Size the window to cover the entire screen including menu bar and dock
            // (macOS fullscreen mode breaks transparency, so we manually set position/size)
            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            apply_fullscreen_geometry(&window);
            let _ = window.set_always_on_top(true);
            let _ = window.set_always_on_top(false);

            // Register global shortcuts:
            //   Ctrl+Shift+K = prompt dialog
            //   Ctrl+Shift+S = screen capture
            //   Ctrl+Shift+0 = panic recenter (recover invisible/offscreen window)
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                app.handle()
                    .global_shortcut()
                    .register(Shortcut::new(
                        Some(Modifiers::CONTROL | Modifiers::SHIFT),
                        Code::KeyK,
                    ))
                    .unwrap_or_else(|e| log::warn!("Failed to register Ctrl+Shift+K: {e}"));
                app.handle()
                    .global_shortcut()
                    .register(Shortcut::new(
                        Some(Modifiers::CONTROL | Modifiers::SHIFT),
                        Code::KeyS,
                    ))
                    .unwrap_or_else(|e| log::warn!("Failed to register Ctrl+Shift+S: {e}"));
                // Panic-recenter shortcut. Quad-modifier (Cmd+Ctrl+Shift+0) is
                // used because the user's own global-shortcut tooling owns the
                // simpler Ctrl+Shift+0 combo.
                match app.handle().global_shortcut().register(Shortcut::new(
                    Some(Modifiers::META | Modifiers::CONTROL | Modifiers::SHIFT),
                    Code::Digit0,
                )) {
                    Ok(()) => log::info!("registered panic recenter: Cmd+Ctrl+Shift+0"),
                    Err(e) => log::warn!("Failed to register Cmd+Ctrl+Shift+0: {e}"),
                }
            }

            // Initialize sound engine with resource path and config
            {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .expect("failed to resolve resource directory");
                let sound_config = krypton_config.read().ok().map(|cfg| cfg.sound.clone());
                let sound_state = app.state::<sound::SoundEngineState>();
                let mut engine = sound_state
                    .lock()
                    .expect("sound engine lock poisoned at init");
                engine.init(resource_dir);
                if let Some(cfg) = sound_config {
                    engine.apply_config(cfg);
                }
            }

            // Initialize music engine
            {
                let music_config = krypton_config
                    .read()
                    .ok()
                    .map(|cfg| cfg.music.clone())
                    .unwrap_or_default();
                let music_engine = music::MusicEngine::new(app.handle().clone(), &music_config);
                app.manage::<music::MusicEngineState>(std::sync::Mutex::new(music_engine));
            }

            // Start Claude Code hook server if enabled
            {
                let hooks_enabled = krypton_config
                    .read()
                    .map(|cfg| cfg.hooks.enabled)
                    .unwrap_or(true);
                let hooks_port = krypton_config.read().map(|cfg| cfg.hooks.port).unwrap_or(0);
                if hooks_enabled {
                    hook_server::start(app.handle().clone(), hook_server.clone(), hooks_port);
                }
            }

            // Start process detection poller for context-aware extensions
            let poller_handle = app.handle().clone();
            let poller_config = krypton_config.clone();
            let poller_pty = pty_manager_for_poller;
            std::thread::spawn(move || {
                start_process_poller(poller_handle, poller_config, poller_pty);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let Some(webview) = window.app_handle().get_webview_window("main") else {
                return;
            };
            match event {
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    log::info!("scale factor changed; reapplying fullscreen geometry");
                    apply_fullscreen_geometry(&webview);
                }
                tauri::WindowEvent::Focused(true) => {
                    if window_is_offscreen(&webview) {
                        log::warn!("window detected offscreen on focus; recentering");
                        apply_fullscreen_geometry(&webview);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Apply fullscreen geometry to the main window, covering the current monitor.
///
/// Falls back from current → primary → first-available monitor, and finally to
/// a hardcoded 1440×900 default if no monitor is resolvable. Without the
/// fallback chain, `current_monitor()` returning `None` would leave the window
/// at its default (possibly zero-sized) rect, which is invisible on a
/// transparent, decorationless window.
fn apply_fullscreen_geometry(window: &tauri::WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| {
            window
                .available_monitors()
                .ok()
                .and_then(|v| v.into_iter().next())
        });

    if let Some(m) = monitor {
        let pos = m.position();
        let size = m.size();
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            pos.x, pos.y,
        )));
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            size.width,
            size.height,
        )));
        log::info!(
            "applied fullscreen geometry: pos=({},{}) size={}x{}",
            pos.x,
            pos.y,
            size.width,
            size.height
        );
    } else {
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            0, 0,
        )));
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(1440, 900)));
        log::warn!("no monitor resolvable; applied fallback 1440x900 at (0,0)");
    }
}

/// Returns true if the window's rect does not intersect any available monitor.
fn window_is_offscreen(window: &tauri::WebviewWindow) -> bool {
    let Ok(pos) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    if monitors.is_empty() {
        return false;
    }

    let wx = pos.x;
    let wy = pos.y;
    let ww = size.width as i32;
    let wh = size.height as i32;

    for m in monitors {
        let mp = m.position();
        let ms = m.size();
        let mw = ms.width as i32;
        let mh = ms.height as i32;
        let overlap_x = wx < mp.x + mw && mp.x < wx + ww;
        let overlap_y = wy < mp.y + mh && mp.y < wy + wh;
        if overlap_x && overlap_y {
            return false;
        }
    }
    true
}

/// Bring the window back to a visible, focused state. Invoked by the
/// Ctrl+Shift+0 "panic recenter" global shortcut — the user-facing escape
/// hatch when the window becomes invisible or stranded on a disconnected
/// monitor.
fn recover_window(window: &tauri::WebviewWindow) {
    log::info!("panic recenter: recovering window visibility");
    // Force a hide/show cycle: when WKWebView loses its surface layer after
    // sleep/wake, the window rect can still be valid (so window_is_offscreen
    // returns false) yet nothing renders. Hide+show forces the compositor to
    // reattach a surface. The always_on_top flicker mirrors the macOS focus
    // workaround used at startup.
    let _ = window.hide();
    let _ = window.show();
    let _ = window.unminimize();
    apply_fullscreen_geometry(window);
    let _ = window.set_always_on_top(true);
    let _ = window.set_always_on_top(false);
    let _ = window.set_focus();
}

// ─── Process Detection Poller ─────────────────────────────────────

/// Payload emitted as a `process-changed` Tauri event.
#[derive(Clone, serde::Serialize)]
struct ProcessChangedPayload {
    session_id: u32,
    process: Option<pty::ProcessInfo>,
    previous: Option<String>,
}

/// Poll all active PTY sessions for foreground process changes.
/// Emits `process-changed` events when a session's foreground process changes.
fn start_process_poller(
    app_handle: tauri::AppHandle,
    config: Arc<RwLock<config::KryptonConfig>>,
    pty_manager: Arc<pty::PtyManager>,
) {
    use std::collections::HashMap;
    use std::time::Duration;

    let mut last_known: HashMap<u32, Option<String>> = HashMap::new();

    loop {
        // Read current config for enabled state and poll interval
        let (enabled, poll_ms) = match config.read() {
            Ok(cfg) => (cfg.extensions.enabled, cfg.extensions.poll_interval_ms),
            Err(_) => (true, 500),
        };

        if !enabled {
            // Extensions disabled — sleep longer and clear state
            last_known.clear();
            std::thread::sleep(Duration::from_secs(2));
            continue;
        }

        // Get all active session IDs
        let session_ids = pty_manager.active_session_ids();

        // Clean up stale entries
        last_known.retain(|id, _| session_ids.contains(id));

        // Poll each session
        for &sid in &session_ids {
            let current = pty_manager.get_foreground_process(sid);
            let current_name = current.as_ref().map(|p| p.name.clone());

            let previous = last_known.get(&sid).cloned().flatten();

            // Only emit if the process name actually changed
            if current_name != last_known.get(&sid).cloned().flatten() {
                let payload = ProcessChangedPayload {
                    session_id: sid,
                    process: current,
                    previous: previous.clone(),
                };
                let _ = app_handle.emit("process-changed", &payload);
            }

            last_known.insert(sid, current_name);
        }

        std::thread::sleep(Duration::from_millis(poll_ms));
    }
}
