use crate::config::KryptonConfig;
use crate::pty::PtyManager;
use crate::ssh::SshManager;
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

/// Find all Java server processes from a PTY session ID.
/// Searches the entire process tree from the session's shell PID downward.
/// Returns all java processes with listening ports (not just the first).
#[tauri::command]
pub fn find_java_server_for_session(
    pty_manager: State<'_, Arc<PtyManager>>,
    session_id: u32,
) -> Vec<crate::pty::JavaServerInfo> {
    let Some(shell_pid) = pty_manager.get_shell_pid(session_id) else {
        return Vec::new();
    };
    crate::pty::find_java_servers_pid(shell_pid)
}

/// Run a short-lived command and return its stdout.
/// Used by dashboard overlays to gather data (e.g., git status) without
/// creating a PTY session. Capped at 10 MB output limit.
#[tauri::command]
pub fn run_command(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args);
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    // Capture stdout, discard stderr
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run '{}': {}", program, e))?;

    // Check we didn't exceed a reasonable output size (10 MB)
    if output.stdout.len() > 10 * 1024 * 1024 {
        return Err("Command output exceeded 10 MB limit".to_string());
    }

    String::from_utf8(output.stdout).map_err(|e| format!("Command output is not valid UTF-8: {e}"))
}

/// Execute a read-only SQL query against a SQLite database and return rows as JSON.
/// Used by dashboard overlays to read from local databases (e.g., OpenCode).
/// Opens the database in read-only mode; rejects write statements.
/// Runs on a blocking thread pool to avoid stalling the Tauri IPC dispatcher.
#[tauri::command]
pub async fn query_sqlite(
    db_path: String,
    query: String,
    params: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        query_sqlite_blocking(&db_path, &query, &params)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Synchronous SQLite query implementation (runs on blocking thread pool).
fn query_sqlite_blocking(
    db_path: &str,
    query: &str,
    params: &[serde_json::Value],
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    use rusqlite::types::Value as SqlValue;
    use rusqlite::{Connection, OpenFlags};
    use std::path::Path;

    // Validate database file exists
    if !Path::new(db_path).exists() {
        return Err(format!("Database not found: {db_path}"));
    }

    // Reject write statements (defense in depth — also opened read-only)
    let trimmed = query.trim_start().to_uppercase();
    for forbidden in &[
        "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE",
    ] {
        if trimmed.starts_with(forbidden) {
            return Err(format!("Write statements are not allowed: {forbidden}..."));
        }
    }

    // Open in read-only mode with busy timeout
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open database: {e}"))?;

    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("Failed to set busy timeout: {e}"))?;

    // Prepare and execute
    let mut stmt = conn
        .prepare(query)
        .map_err(|e| format!("SQL prepare error: {e}"))?;

    // Bind parameters
    let sql_params: Vec<SqlValue> = params
        .iter()
        .map(|v| match v {
            serde_json::Value::Null => SqlValue::Null,
            serde_json::Value::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    SqlValue::Integer(i)
                } else if let Some(f) = n.as_f64() {
                    SqlValue::Real(f)
                } else {
                    SqlValue::Null
                }
            }
            serde_json::Value::String(s) => SqlValue::Text(s.clone()),
            _ => SqlValue::Text(v.to_string()),
        })
        .collect();

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = sql_params
        .iter()
        .map(|v| v as &dyn rusqlite::types::ToSql)
        .collect();

    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            let mut map = serde_json::Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let val: SqlValue = row.get(i)?;
                let json_val = match val {
                    SqlValue::Null => serde_json::Value::Null,
                    SqlValue::Integer(n) => serde_json::Value::Number(n.into()),
                    SqlValue::Real(f) => serde_json::Value::Number(
                        serde_json::Number::from_f64(f).unwrap_or_else(|| 0.into()),
                    ),
                    SqlValue::Text(s) => serde_json::Value::String(s),
                    SqlValue::Blob(b) => {
                        serde_json::Value::String(format!("<blob {} bytes>", b.len()))
                    }
                };
                map.insert(name.clone(), json_val);
            }
            Ok(map)
        })
        .map_err(|e| format!("SQL query error: {e}"))?;

    // Collect up to 1000 rows
    let mut result = Vec::new();
    for row in rows {
        let row = row.map_err(|e| format!("Row read error: {e}"))?;
        result.push(row);
        if result.len() >= 1000 {
            break;
        }
    }

    Ok(result)
}

// ─── SSH Session Multiplexing ──────────────────────────────────────

/// Detect an SSH session in the focused terminal's process tree.
/// Returns connection metadata (user, host, port) if an active SSH
/// process is found, or None if the terminal isn't running SSH.
#[tauri::command]
pub fn detect_ssh_session(
    pty_manager: State<'_, Arc<PtyManager>>,
    ssh_manager: State<'_, Arc<SshManager>>,
    session_id: u32,
) -> Option<crate::ssh::SshConnectionInfo> {
    ssh_manager.detect(session_id, &pty_manager)
}

/// Clone an SSH session by spawning a new PTY with an ssh command
/// that reuses the existing connection via ControlMaster multiplexing.
/// If `remote_cwd` is provided (or auto-detected), the cloned session
/// starts in that remote directory. Returns the new PTY session ID.
#[tauri::command]
pub fn clone_ssh_session(
    app_handle: AppHandle,
    pty_manager: State<'_, Arc<PtyManager>>,
    ssh_manager: State<'_, Arc<SshManager>>,
    session_id: u32,
    cols: u16,
    rows: u16,
    remote_cwd: Option<String>,
) -> Result<u32, String> {
    let info = ssh_manager
        .detect(session_id, &pty_manager)
        .ok_or_else(|| "No SSH session detected in this terminal".to_string())?;

    // Use provided remote_cwd, or try to auto-detect via the control socket
    let cwd = remote_cwd.or_else(|| ssh_manager.get_remote_cwd(&info));

    let (program, args) = ssh_manager.build_clone_command(&info, cwd.as_deref());

    log::info!(
        "Cloning SSH session {} -> {}@{}:{} cwd={:?} via ControlMaster",
        session_id,
        info.user,
        info.host,
        info.port,
        cwd,
    );

    pty_manager.spawn(&app_handle, cols, rows, None, &program, &args)
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
