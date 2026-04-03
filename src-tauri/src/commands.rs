use crate::config::KryptonConfig;
use crate::hook_server::HookServer;
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

/// Read a file's contents as a UTF-8 string.
/// Used by the AI agent tool to inspect source files.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read_file: {e}"))
}

/// Write a string to a file, creating parent directories if needed.
/// Used by the AI agent tool to write or overwrite source files.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("write_file mkdir: {e}"))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("write_file: {e}"))
}

/// Read a single environment variable.
/// First checks the process environment, then falls back to spawning a login
/// shell to resolve it — this is necessary on macOS where GUI apps launched
/// from Finder/Spotlight don't inherit the user's shell profile.
#[tauri::command]
pub fn get_env_var(name: String) -> Option<String> {
    if let Ok(val) = std::env::var(&name) {
        return Some(val);
    }

    // Fallback: ask the user's default shell for the variable.
    // Validate name contains only safe characters to prevent shell injection.
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // Use printenv which works regardless of shell syntax (fish vs bash/zsh)
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", &format!("printenv {}", name)])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    let val = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if val.is_empty() {
        None
    } else {
        Some(val)
    }
}

/// Return the user's configured shell program and args from krypton.toml.
/// Falls back to $SHELL (then /bin/sh) if config is unavailable.
#[tauri::command]
pub fn get_default_shell(
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
) -> Result<(String, Vec<String>), String> {
    let cfg = config.read().map_err(|e| format!("Config lock poisoned: {e}"))?;
    Ok((cfg.shell.program.clone(), cfg.shell.args.clone()))
}

/// Run a short-lived command and return its combined stdout+stderr.
/// Used by dashboard overlays to gather data (e.g., git status) without
/// creating a PTY session. Capped at 10 MB output limit.
/// Runs on a blocking thread pool to avoid stalling the Tauri IPC dispatcher.
/// Returns an error string on non-zero exit or spawn failure.
#[tauri::command]
pub async fn run_command(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_command_blocking(&program, &args, cwd.as_deref())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Synchronous command execution (runs on blocking thread pool).
fn run_command_blocking(
    program: &str,
    args: &[String],
    cwd: Option<&str>,
) -> Result<String, String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run '{}': {}", program, e))?;

    let total_len = output.stdout.len() + output.stderr.len();
    if total_len > 10 * 1024 * 1024 {
        return Err("Command output exceeded 10 MB limit".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Combine stdout and stderr
    let mut combined = stdout.into_owned();
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }

    if output.status.success() {
        Ok(combined)
    } else {
        let code = output.status.code().map_or("signal".to_string(), |c| c.to_string());
        if combined.is_empty() {
            Err(format!("exit code {code}"))
        } else {
            Err(combined)
        }
    }
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

/// Report the current working directory of a remote SSH session.
/// Called by the frontend when it receives an OSC 7 escape sequence
/// from a terminal. The hostname parameter (extracted from the OSC 7
/// URI) is used to distinguish local vs remote CWD updates — only
/// remote hostnames are stored.
#[tauri::command]
pub fn set_ssh_remote_cwd(
    ssh_manager: State<'_, Arc<SshManager>>,
    session_id: u32,
    cwd: String,
    hostname: String,
) {
    ssh_manager.set_remote_cwd(session_id, cwd, &hostname);
}

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
/// If `remote_cwd` is provided (from frontend CWD probing or OSC 7
/// tracking), the cloned session starts in that remote directory.
/// Returns the new PTY session ID.
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

    // Use provided remote_cwd (from frontend probe), or look up the
    // last-known CWD tracked via OSC 7.
    let cwd = remote_cwd.or_else(|| ssh_manager.get_remote_cwd(session_id));

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

// ─── Claude Code Hook Server ───────────────────────────────────────

/// Get the port the hook server is listening on (0 if not started).
#[tauri::command]
pub fn get_hook_server_port(hook_server: State<'_, Arc<HookServer>>) -> u16 {
    hook_server.get_port()
}

/// Copy the Claude Code hook configuration snippet to the system clipboard
/// and return it. Users paste this into their ~/.claude/settings.json.
#[tauri::command]
pub fn get_hook_server_config_snippet(hook_server: State<'_, Arc<HookServer>>) -> Result<String, String> {
    let port = hook_server.get_port();
    if port == 0 {
        return Err("Hook server is not running".to_string());
    }

    let snippet = serde_json::json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": ".*",
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}/hook"),
                    "timeout": 5
                }]
            }],
            "PostToolUse": [{
                "matcher": ".*",
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}/hook"),
                    "timeout": 5
                }]
            }],
            "Notification": [{
                "matcher": ".*",
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}/hook"),
                    "timeout": 5
                }]
            }],
            "SessionStart": [{
                "matcher": ".*",
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}/hook"),
                    "timeout": 5
                }]
            }],
            "Stop": [{
                "matcher": ".*",
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}/hook"),
                    "timeout": 5
                }]
            }]
        }
    });

    let text = serde_json::to_string_pretty(&snippet)
        .map_err(|e| format!("Failed to serialize: {e}"))?;

    // Copy to system clipboard via pbcopy (macOS)
    if let Ok(mut child) = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
    {
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(text.as_bytes());
        }
        let _ = child.wait();
        log::info!("Claude hook config copied to clipboard (port {port})");
    } else {
        log::warn!("pbcopy not available, returning snippet without clipboard copy");
    }

    Ok(text)
}

// ─── File Manager ─────────────────────────────────────────────────

/// A single entry from a directory listing.
#[derive(serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: u64,
    pub permissions: String,
    pub symlink_target: Option<String>,
}

/// List the contents of a directory, returning structured file entries.
/// Directories are sorted first, then files, both alphabetically.
#[tauri::command]
pub fn list_directory(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::UNIX_EPOCH;

    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(dir).map_err(|e| format!("list_directory: {e}"))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files unless show_hidden is true
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let entry_path = entry.path();
        let path_str = entry_path.to_string_lossy().to_string();

        // Use symlink_metadata to detect symlinks without following them
        let lmeta = match fs::symlink_metadata(&entry_path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let is_symlink = lmeta.file_type().is_symlink();

        // Follow symlink for size/is_dir, fall back to symlink metadata if broken
        let meta = if is_symlink {
            fs::metadata(&entry_path).unwrap_or_else(|_| lmeta.clone())
        } else {
            lmeta.clone()
        };

        let is_dir = meta.is_dir();
        let size = meta.len();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let mode = lmeta.permissions().mode();
        let permissions = format_unix_permissions(mode);

        let symlink_target = if is_symlink {
            fs::read_link(&entry_path)
                .ok()
                .map(|t| t.to_string_lossy().to_string())
        } else {
            None
        };

        entries.push(FileEntry {
            name,
            path: path_str,
            is_dir,
            is_symlink,
            size,
            modified,
            permissions,
            symlink_target,
        });
    }

    // Sort: directories first, then alphabetically (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Format a Unix mode_t as a rwx permission string.
fn format_unix_permissions(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    let flags = [
        (0o400, 'r'), (0o200, 'w'), (0o100, 'x'),
        (0o040, 'r'), (0o020, 'w'), (0o010, 'x'),
        (0o004, 'r'), (0o002, 'w'), (0o001, 'x'),
    ];
    for (bit, ch) in flags {
        s.push(if mode & bit != 0 { ch } else { '-' });
    }
    s
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
