// Krypton — Pencil window backend.
// Read/write `.excalidraw` JSON files atomically and scan a configured
// directory for the picker. See docs/71-pencil-window.md.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tokio::fs;

#[derive(Debug, Serialize)]
pub struct PencilEntry {
    pub path: String,
    pub modified_ms: u64,
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(stripped) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    PathBuf::from(p)
}

#[tauri::command]
pub async fn read_pencil_file(path: String) -> Result<String, String> {
    let p = expand_tilde(&path);
    fs::read_to_string(&p)
        .await
        .map_err(|e| format!("read failed: {e}"))
}

#[tauri::command]
pub async fn write_pencil_file(path: String, contents: String) -> Result<(), String> {
    // Validate the payload is JSON with type == "excalidraw" before touching disk.
    let parsed: serde_json::Value =
        serde_json::from_str(&contents).map_err(|e| format!("invalid JSON: {e}"))?;
    let type_field = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if type_field != "excalidraw" {
        return Err(format!(
            "expected type \"excalidraw\", got {:?}",
            type_field
        ));
    }

    let target = expand_tilde(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir failed: {e}"))?;
        }
    }

    // Atomic write: write sibling temp file, fsync, then rename.
    let tmp = target.with_extension("excalidraw.tmp");
    fs::write(&tmp, contents.as_bytes())
        .await
        .map_err(|e| format!("write tmp failed: {e}"))?;
    fs::rename(&tmp, &target)
        .await
        .map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn scan_pencil_dir(dir: String) -> Result<Vec<PencilEntry>, String> {
    let root = expand_tilde(&dir);
    if !root.exists() {
        return Err(format!("directory does not exist: {}", root.display()));
    }
    let mut out = Vec::new();
    walk(&root, &mut out).map_err(|e| format!("scan failed: {e}"))?;
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<PencilEntry>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_dir() {
            // Skip hidden directories (e.g., .git) to avoid noisy scans.
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }
            walk(&entry.path(), out)?;
        } else if ft.is_file() {
            let path = entry.path();
            // Match exact ".excalidraw" extension only — exclude
            // ".excalidraw.svg" / ".excalidraw.png" sister formats.
            if path.extension().and_then(|e| e.to_str()) != Some("excalidraw") {
                continue;
            }
            let modified_ms = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(PencilEntry {
                path: path.to_string_lossy().into_owned(),
                modified_ms,
            });
        }
    }
    Ok(())
}
