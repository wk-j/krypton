use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Resolve the app's resource directory, including dev builds under a custom
/// Cargo target directory.
///
/// Tauri treats the executable's directory as the resource directory only when
/// a parent folder is literally named `target`, so a dev build under
/// `CARGO_TARGET_DIR=~/.cargo-target` fails with `UnknownPath` even though
/// tauri-build copied the resources beside the executable. Fall back to that
/// directory when it is a Cargo output directory — the same `.cargo-lock` test
/// Tauri applies. A bundled app never has `.cargo-lock` beside its executable.
pub fn resource_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.path().resource_dir().or_else(|err| {
        std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(cargo_output_dir)
            .ok_or(err)
    })
}

fn cargo_output_dir(exe: &Path) -> Option<PathBuf> {
    exe.parent()
        .filter(|dir| dir.join(".cargo-lock").exists())
        .map(Path::to_path_buf)
}
