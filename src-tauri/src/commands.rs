use crate::pty::PtyManager;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn spawn_pty(
    app_handle: AppHandle,
    pty_manager: State<'_, Arc<PtyManager>>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<u32, String> {
    pty_manager.spawn(&app_handle, cols, rows, cwd)
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
