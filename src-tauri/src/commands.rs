use crate::config::KryptonConfig;
use crate::pty::PtyManager;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_pty(
    app_handle: AppHandle,
    pty_manager: State<'_, Arc<PtyManager>>,
    config: State<'_, Arc<KryptonConfig>>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
) -> Result<u32, String> {
    // Use provided shell/args, fall back to config, fall back to $SHELL
    let program = shell
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| config.shell.program.clone());
    let args = shell_args.unwrap_or_else(|| config.shell.args.clone());
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
pub fn get_config(config: State<'_, Arc<KryptonConfig>>) -> KryptonConfig {
    (**config).clone()
}
