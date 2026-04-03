mod commands;
mod config;
pub mod hook_server;
mod pty;
mod session;
pub mod music;
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
        .manage(pty_manager)
        .manage(krypton_config.clone())
        .manage(theme_engine.clone())
        .manage(sound_engine)
        .manage(ssh_manager)
        .manage(hook_server.clone())
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
            commands::read_file,
            commands::write_file,
            commands::get_env_var,
            commands::run_command,
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
            commands::get_hook_server_port,
            commands::get_hook_server_config_snippet,
            session::session_create,
            session::session_append,
            session::session_load,
            session::session_continue_recent,
            session::session_list,
        ])
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Size the window to cover the entire screen including menu bar and dock
            // (macOS fullscreen mode breaks transparency, so we manually set position/size)
            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            if let Ok(Some(monitor)) = window.current_monitor() {
                let pos = monitor.position();
                let size = monitor.size();
                let _ = window.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition::new(pos.x, pos.y),
                ));
                let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                    size.width,
                    size.height,
                )));
            }
            let _ = window.set_always_on_top(true);
            let _ = window.set_always_on_top(false);

            // Initialize sound engine with resource path and config
            {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .expect("failed to resolve resource directory");
                let sound_config = krypton_config
                    .read()
                    .ok()
                    .map(|cfg| cfg.sound.clone());
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
                let music_engine = music::MusicEngine::new(
                    app.handle().clone(),
                    &music_config,
                );
                app.manage::<music::MusicEngineState>(std::sync::Mutex::new(music_engine));
            }

            // Start filesystem watcher for config + theme hot-reload
            let app_handle = app.handle().clone();
            let config_for_watcher = krypton_config.clone();
            let theme_for_watcher = theme_engine.clone();
            std::thread::spawn(move || {
                start_config_watcher(app_handle, config_for_watcher, theme_for_watcher);
            });

            // Start Claude Code hook server if enabled
            {
                let hooks_enabled = krypton_config
                    .read()
                    .map(|cfg| cfg.hooks.enabled)
                    .unwrap_or(true);
                let hooks_port = krypton_config
                    .read()
                    .map(|cfg| cfg.hooks.port)
                    .unwrap_or(0);
                if hooks_enabled {
                    hook_server::start(
                        app.handle().clone(),
                        hook_server.clone(),
                        hooks_port,
                    );
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Watch ~/.config/krypton/ for changes and emit theme-changed / config-changed events.
fn start_config_watcher(
    app_handle: tauri::AppHandle,
    config: Arc<RwLock<config::KryptonConfig>>,
    theme_engine: Arc<theme::ThemeEngine>,
) {
    use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let config_dir = match config::config_dir() {
        Some(d) => d,
        None => {
            log::warn!("Cannot determine config directory; file watcher not started");
            return;
        }
    };

    // Ensure the themes directory exists so we can watch it
    let themes_dir = config_dir.join("themes");
    if !themes_dir.exists() {
        let _ = std::fs::create_dir_all(&themes_dir);
    }

    let (tx, rx) = mpsc::channel();

    let mut watcher: RecommendedWatcher =
        match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                log::error!("Failed to create filesystem watcher: {e}");
                return;
            }
        };

    if let Err(e) = watcher.watch(&config_dir, RecursiveMode::Recursive) {
        log::error!("Failed to watch {}: {e}", config_dir.display());
        return;
    }

    log::info!("Watching {} for config/theme changes", config_dir.display());

    // Debounce: wait 300ms after the last event before reloading
    let debounce = Duration::from_millis(300);
    let mut last_event: Option<Instant> = None;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(event) => {
                // Only react to modify/create events on .toml files
                let dominated = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
                let is_toml = event
                    .paths
                    .iter()
                    .any(|p| p.extension().is_some_and(|ext| ext == "toml"));
                if dominated && is_toml {
                    last_event = Some(Instant::now());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Check if we should reload (debounced)
                if let Some(t) = last_event {
                    if t.elapsed() >= debounce {
                        last_event = None;
                        reload_and_emit(&app_handle, &config, &theme_engine);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Reload config from disk and emit events to the frontend.
fn reload_and_emit(
    app_handle: &tauri::AppHandle,
    config: &Arc<RwLock<config::KryptonConfig>>,
    theme_engine: &Arc<theme::ThemeEngine>,
) {
    let new_config = config::load_config_no_flush();

    let theme = match theme_engine.resolve(&new_config.theme.name) {
        Ok(mut t) => {
            theme_engine.apply_config_overrides(&mut t, &new_config.theme.colors);
            t
        }
        Err(e) => {
            log::error!("Failed to resolve theme on reload: {e}");
            return;
        }
    };

    // Update the shared config
    {
        match config.write() {
            Ok(mut cfg) => *cfg = new_config,
            Err(e) => {
                log::error!("Config lock poisoned on reload: {e}");
                return;
            }
        }
    }

    // Emit events to frontend
    if let Err(e) = app_handle.emit("theme-changed", &theme) {
        log::error!("Failed to emit theme-changed: {e}");
    }

    match config.read() {
        Ok(cfg) => {
            // Apply sound config to Rust engine directly (no IPC round-trip)
            let sound_state = app_handle.state::<sound::SoundEngineState>();
            if let Ok(mut engine) = sound_state.lock() {
                engine.apply_config(cfg.sound.clone());
            }

            if let Err(e) = app_handle.emit("config-changed", &*cfg) {
                log::error!("Failed to emit config-changed: {e}");
            }
        }
        Err(e) => log::error!("Config lock poisoned: {e}"),
    }

    log::info!("Config/theme hot-reloaded");
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
