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
