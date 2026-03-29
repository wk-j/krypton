// Krypton — AI Agent Session Persistence (pi-mono compatible JSONL format)
//
// Sessions are stored as append-only JSONL files at:
//   ~/.config/krypton/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl
//
// Each line is a JSON object with a "type" discriminator. The first line is
// always a session header. Subsequent lines are message entries, compaction
// entries, etc. — matching the format used by @mariozechner/pi-agent-core.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Returned to the frontend after creating or opening a session.
#[derive(Clone, Serialize, Deserialize)]
pub struct SessionHandle {
    pub session_id: String,
    pub file_path: String,
}

/// Summary info for listing sessions.
#[derive(Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub file_path: String,
    pub timestamp: String,
    pub entry_count: usize,
}

// ─── Helpers ──────────────────────────────────────────────────────────

/// Encode a CWD into a safe directory name, matching pi-mono convention:
///   /Users/wk/Source/krypton  →  --Users-wk-Source-krypton--
fn encode_cwd(cwd: &str) -> String {
    let stripped = cwd
        .trim_start_matches('/')
        .trim_start_matches('\\');
    let safe: String = stripped
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' => '-',
            _ => c,
        })
        .collect();
    format!("--{safe}--")
}

/// Root directory for all session files.
fn sessions_root() -> Result<PathBuf, String> {
    let config_dir = crate::config::config_dir()
        .ok_or_else(|| "Cannot determine config directory".to_string())?;
    Ok(config_dir.join("sessions"))
}

/// Session directory for a specific CWD.
fn session_dir_for(cwd: &str) -> Result<PathBuf, String> {
    Ok(sessions_root()?.join(encode_cwd(cwd)))
}

/// Generate an ISO-8601 timestamp safe for filenames.
fn file_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // Format as UTC: YYYY-MM-DDTHH-MM-SS-mmmZ
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (s, m, h, day, mon, year) = {
        // Simple UTC breakdown (no chrono dependency)
        let days = secs / 86400;
        let time = secs % 86400;
        let h = time / 3600;
        let m = (time % 3600) / 60;
        let s = time % 60;

        // Days since epoch to Y-M-D (simplified Gregorian)
        let mut y: i64 = 1970;
        let mut remaining = days as i64;
        loop {
            let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                366
            } else {
                365
            };
            if remaining < days_in_year {
                break;
            }
            remaining -= days_in_year;
            y += 1;
        }
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        let month_days = [
            31,
            if leap { 29 } else { 28 },
            31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
        ];
        let mut mon = 1u32;
        for &md in &month_days {
            if remaining < md {
                break;
            }
            remaining -= md;
            mon += 1;
        }
        let day = remaining + 1;
        (s, m, h, day, mon, y)
    };
    format!(
        "{year:04}-{mon:02}-{day:02}T{h:02}-{m:02}-{s:02}-{millis:03}Z"
    )
}

/// Generate a UUID v4 (simple random, no external crate).
fn uuid_v4() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut bytes = [0u8; 16];
    // Use RandomState as a source of entropy (not crypto-grade, but fine for IDs)
    for chunk in bytes.chunks_mut(8) {
        let s = RandomState::new();
        let mut hasher = s.build_hasher();
        hasher.write_u64(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64);
        let val = hasher.finish();
        for (i, b) in val.to_le_bytes().iter().enumerate() {
            if i < chunk.len() {
                chunk[i] = *b;
            }
        }
    }
    // Set version (4) and variant bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

// ─── Tauri Commands ───────────────────────────────────────────────────

/// Create a new session JSONL file with a header line.
#[tauri::command]
pub fn session_create(cwd: String) -> Result<SessionHandle, String> {
    let dir = session_dir_for(&cwd)?;
    fs::create_dir_all(&dir).map_err(|e| format!("session_create mkdir: {e}"))?;

    let session_id = uuid_v4();
    let ts = file_timestamp();
    let filename = format!("{ts}_{session_id}.jsonl");
    let file_path = dir.join(&filename);

    // Write header line
    let header = serde_json::json!({
        "type": "session",
        "version": 3,
        "id": session_id,
        "timestamp": ts,
        "cwd": cwd,
    });

    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&file_path)
        .map_err(|e| format!("session_create open: {e}"))?;

    writeln!(f, "{}", serde_json::to_string(&header).unwrap())
        .map_err(|e| format!("session_create write: {e}"))?;

    Ok(SessionHandle {
        session_id,
        file_path: file_path.to_string_lossy().into_owned(),
    })
}

/// Append a single JSON entry (one line) to an existing session file.
#[tauri::command]
pub fn session_append(file_path: String, entry: serde_json::Value) -> Result<(), String> {
    let mut f = OpenOptions::new()
        .create(false)
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("session_append open: {e}"))?;

    writeln!(f, "{}", serde_json::to_string(&entry).unwrap())
        .map_err(|e| format!("session_append write: {e}"))?;

    Ok(())
}

/// Load all entries from a session JSONL file.
/// Malformed lines are skipped with a warning.
#[tauri::command]
pub fn session_load(file_path: String) -> Result<Vec<serde_json::Value>, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Ok(vec![]);
    }

    let f = fs::File::open(path).map_err(|e| format!("session_load open: {e}"))?;
    let reader = BufReader::new(f);
    let mut entries = Vec::new();

    for (i, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| format!("session_load read line {i}: {e}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(val) => entries.push(val),
            Err(e) => {
                log::warn!("session_load: skipping malformed line {i}: {e}");
            }
        }
    }

    Ok(entries)
}

/// Find the most recent session for a given CWD. Returns None if no sessions exist.
#[tauri::command]
pub fn session_continue_recent(cwd: String) -> Result<Option<SessionHandle>, String> {
    let dir = session_dir_for(&cwd)?;
    if !dir.exists() {
        return Ok(None);
    }

    let mut jsonl_files: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("session_continue_recent readdir: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "jsonl"))
        .collect();

    // Sort by filename (contains timestamp) — last is most recent
    jsonl_files.sort();

    let Some(latest) = jsonl_files.last() else {
        return Ok(None);
    };

    // Extract session_id from header
    let f = fs::File::open(latest).map_err(|e| format!("session_continue_recent open: {e}"))?;
    let mut reader = BufReader::new(f);
    let mut first_line = String::new();
    reader
        .read_line(&mut first_line)
        .map_err(|e| format!("session_continue_recent read: {e}"))?;

    let header: serde_json::Value = serde_json::from_str(first_line.trim())
        .map_err(|e| format!("session_continue_recent parse header: {e}"))?;

    let session_id = header
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(Some(SessionHandle {
        session_id,
        file_path: latest.to_string_lossy().into_owned(),
    }))
}

/// List all sessions for a CWD, sorted by timestamp (newest first).
#[tauri::command]
pub fn session_list(cwd: String) -> Result<Vec<SessionInfo>, String> {
    let dir = session_dir_for(&cwd)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut jsonl_files: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("session_list readdir: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "jsonl"))
        .collect();

    jsonl_files.sort();
    jsonl_files.reverse(); // newest first

    let mut sessions = Vec::new();
    for path in jsonl_files {
        let f = match fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(f);
        let mut entry_count = 0usize;
        let mut session_id = String::new();
        let mut timestamp = String::new();

        for (i, line) in reader.lines().enumerate() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if i == 0 {
                if let Ok(header) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    session_id = header
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    timestamp = header
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            } else {
                entry_count += 1;
            }
        }

        sessions.push(SessionInfo {
            session_id,
            file_path: path.to_string_lossy().into_owned(),
            timestamp,
            entry_count,
        });
    }

    Ok(sessions)
}
