use crate::config::KryptonConfig;
use crate::pty::PtyManager;
use crate::theme::{FullTheme, ThemeEngine};
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_pty(
    app_handle: AppHandle,
    pty_manager: State<'_, Arc<PtyManager>>,
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
) -> Result<u32, String> {
    let cfg = config
        .read()
        .map_err(|e| format!("Config lock poisoned: {e}"))?;
    // Use provided shell/args, fall back to config, fall back to $SHELL
    let program = shell
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cfg.shell.program.clone());
    let args = shell_args.unwrap_or_else(|| cfg.shell.args.clone());
    pty_manager.spawn(&app_handle, cols, rows, cwd, &program, &args)
}

#[tauri::command]
pub fn get_pty_cwd(
    pty_manager: State<'_, Arc<PtyManager>>,
    session_id: u32,
) -> Result<Option<String>, String> {
    pty_manager.get_cwd(session_id)
}

#[tauri::command]
pub fn write_to_pty(
    pty_manager: State<'_, Arc<PtyManager>>,
    session_id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    pty_manager.write(session_id, &data)
}

#[tauri::command]
pub fn resize_pty(
    pty_manager: State<'_, Arc<PtyManager>>,
    session_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty_manager.resize(session_id, cols, rows)
}

#[tauri::command]
pub fn get_config(config: State<'_, Arc<RwLock<KryptonConfig>>>) -> Result<KryptonConfig, String> {
    let cfg = config
        .read()
        .map_err(|e| format!("Config lock poisoned: {e}"))?;
    Ok((*cfg).clone())
}

/// Resolve the active theme: load the theme specified by config.theme.name,
/// then apply any [theme.colors] overrides from config.
#[tauri::command]
pub fn get_theme(
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
    theme_engine: State<'_, Arc<ThemeEngine>>,
) -> Result<FullTheme, String> {
    let cfg = config
        .read()
        .map_err(|e| format!("Config lock poisoned: {e}"))?;
    let mut theme = theme_engine.resolve(&cfg.theme.name)?;
    theme_engine.apply_config_overrides(&mut theme, &cfg.theme.colors);
    Ok(theme)
}

/// List all available theme names (built-in + custom).
#[tauri::command]
pub fn list_themes(theme_engine: State<'_, Arc<ThemeEngine>>) -> Vec<String> {
    theme_engine.list_names()
}

/// Reload config from disk and emit a theme-changed event if the theme changed.
#[tauri::command]
pub fn reload_config(
    app_handle: AppHandle,
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
    theme_engine: State<'_, Arc<ThemeEngine>>,
) -> Result<(), String> {
    let new_config = crate::config::load_config();
    let mut theme = theme_engine.resolve(&new_config.theme.name)?;
    theme_engine.apply_config_overrides(&mut theme, &new_config.theme.colors);

    // Update the shared config
    {
        let mut cfg = config
            .write()
            .map_err(|e| format!("Config lock poisoned: {e}"))?;
        *cfg = new_config;
    }

    // Emit theme-changed event to frontend
    app_handle
        .emit("theme-changed", &theme)
        .map_err(|e| format!("Failed to emit theme-changed event: {e}"))?;

    // Emit config-changed event for non-theme settings
    let cfg = config
        .read()
        .map_err(|e| format!("Config lock poisoned: {e}"))?;
    app_handle
        .emit("config-changed", &*cfg)
        .map_err(|e| format!("Failed to emit config-changed event: {e}"))?;

    log::info!("Config reloaded, theme-changed event emitted");
    Ok(())
}

/// Open a URL or file path using the system default handler.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("Failed to open '{url}': {e}"))
}

/// Get the foreground process of a PTY session.
#[tauri::command]
pub fn get_foreground_process(
    pty_manager: State<'_, Arc<PtyManager>>,
    session_id: u32,
) -> Option<crate::pty::ProcessInfo> {
    pty_manager.get_foreground_process(session_id)
}

/// Get JVM + OS resource stats for a Java process.
#[tauri::command]
pub fn get_java_stats(pid: u32) -> Result<crate::pty::JavaStats, String> {
    crate::pty::get_java_stats(pid)
}

/// Find a descendant process named "java" under a given parent PID.
/// Useful when Java is launched via mvn, gradle, or a wrapper script.
#[tauri::command]
pub fn find_java_pid(parent_pid: u32) -> Option<u32> {
    crate::pty::find_child_process_by_name(parent_pid, "java")
}

/// Find the Java server process (the one with a TCP listening port)
/// among descendants of a given PID. Returns PID, port, and main class.
#[tauri::command]
pub fn find_java_server(root_pid: u32) -> Option<crate::pty::JavaServerInfo> {
    crate::pty::find_java_server_pid(root_pid)
}

/// Find the Java server process from a PTY session ID.
/// Searches the entire process tree from the session's shell PID downward.
#[tauri::command]
pub fn find_java_server_for_session(
    pty_manager: State<'_, Arc<PtyManager>>,
    session_id: u32,
) -> Option<crate::pty::JavaServerInfo> {
    let shell_pid = pty_manager.get_shell_pid(session_id)?;
    crate::pty::find_java_server_pid(shell_pid)
}

/// Find the Java server process by matching the terminal's CWD.
/// Finds all java processes system-wide whose CWD equals the terminal's,
/// then returns the one with a TCP listening port.
#[tauri::command]
pub fn find_java_server_by_cwd(
    pty_manager: State<'_, Arc<PtyManager>>,
    session_id: u32,
) -> Option<crate::pty::JavaServerInfo> {
    let cwd = pty_manager.get_cwd(session_id).ok()??;
    crate::pty::find_java_server_by_cwd(&cwd)
}
