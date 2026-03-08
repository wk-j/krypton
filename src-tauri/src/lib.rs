mod commands;
mod config;
mod pty;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_manager = Arc::new(pty::PtyManager::new());

    // Load configuration from disk (creates default file if missing)
    let krypton_config = Arc::new(config::load_config());

    tauri::Builder::default()
        .manage(pty_manager)
        .manage(krypton_config)
        .invoke_handler(tauri::generate_handler![
            commands::spawn_pty,
            commands::get_pty_cwd,
            commands::write_to_pty,
            commands::resize_pty,
            commands::get_config,
        ])
        .setup(|app| {
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
