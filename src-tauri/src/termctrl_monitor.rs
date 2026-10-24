//! Read-only adapter for the external `termctrl` CLI (specs 198 and 330).
//!
//! The loopback WebUI uses this module for session inventory, visible-screen
//! snapshots, and the retained raw output behind the Log view. It intentionally
//! exposes no input or lifecycle operations.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

const SCHEMA_VERSION: u8 = 1;
const OUTPUT_LIMIT: usize = 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
/// Spec 330: the raw ring is 16 MiB by default; leave room for a larger
/// `--max-bytes` without letting one read hold unbounded memory.
const LOG_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
/// A full 16 MiB ring measured 289–294 ms on termctrl 1.2.1.
const LOG_TIMEOUT: Duration = Duration::from_secs(5);
/// Longest anchor the page may send: the last bytes it holds.
pub const LOG_ANCHOR_MAX: usize = 64;
/// The one log error the page shows verbatim, because the user can act on it.
pub const LOG_TOO_LARGE: &str = "session log exceeds 32 MiB";
const START_ERROR: &str = "failed to start termctrl";

/// Output cap and deadline for one CLI invocation.
#[derive(Debug, Clone, Copy)]
struct Budget {
    limit: usize,
    timeout: Duration,
}

const CLI_BUDGET: Budget = Budget {
    limit: OUTPUT_LIMIT,
    timeout: COMMAND_TIMEOUT,
};
const LOG_BUDGET: Budget = Budget {
    limit: LOG_OUTPUT_LIMIT,
    timeout: LOG_TIMEOUT,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TermctrlSessionState {
    Running,
    Exited,
    Stale,
    Incompatible,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TermctrlSessionSummary {
    pub name: String,
    pub state: TermctrlSessionState,
    pub command: Vec<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub recording: bool,
    pub logs_truncated: bool,
    pub idle_for_ms: Option<u64>,
    pub has_visible_content: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TermctrlSessionList {
    pub schema_version: u8,
    pub available: bool,
    pub terminal_control_version: Option<String>,
    pub fetched_at: u64,
    pub sessions: Vec<TermctrlSessionSummary>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TermctrlScreen {
    pub schema_version: u8,
    pub name: String,
    pub text: String,
    pub fetched_at: u64,
}

/// Spec 330: where the page's copy of the log ends — the ring length it last
/// saw and the bytes just before that point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermctrlLogCursor {
    pub length: usize,
    pub anchor: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TermctrlLogMode {
    /// `bytes` continue the page's copy.
    Append,
    /// `bytes` are the whole ring; the page starts over.
    Reset,
}

impl TermctrlLogMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Append => "append",
            Self::Reset => "reset",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermctrlLogChunk {
    pub mode: TermctrlLogMode,
    /// Ring length at this read: the page's next cursor length.
    pub length: usize,
    /// termctrl dropped the ring's oldest bytes at least once.
    pub truncated: bool,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
struct ResolvedBinary {
    path: PathBuf,
    version: String,
    runtime_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSessionEntry {
    name: String,
    status: Option<RawStatus>,
    error: Option<String>,
    unavailable: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawStatus {
    state: String,
    cols: u16,
    rows: u16,
    idle_for_ms: Option<u64>,
    has_visible_content: bool,
    recording: bool,
    #[serde(default)]
    logs_truncated: bool,
    launch: RawLaunch,
}

/// `status NAME --json`, reduced to the one field the Log view needs. Older
/// termctrl without it reads as "never truncated".
#[derive(Debug, Deserialize)]
struct RawLogStatus {
    #[serde(default)]
    logs_truncated: bool,
}

#[derive(Debug, Deserialize)]
struct RawLaunch {
    command: Vec<String>,
    cwd: PathBuf,
}

#[derive(Debug)]
struct BoundedOutput {
    stdout: Vec<u8>,
}

/// Process-lifetime capability plus cached successful CLI discovery.
pub struct TermctrlMonitor {
    token: String,
    resolved: Mutex<Option<ResolvedBinary>>,
}

impl Default for TermctrlMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl TermctrlMonitor {
    pub fn new() -> Self {
        Self {
            token: capability_token(),
            resolved: Mutex::new(None),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn url(&self, port: u16) -> Result<String, String> {
        if port == 0 {
            return Err(crate::hook_server::SERVER_UNAVAILABLE.to_string());
        }
        Ok(format!("http://127.0.0.1:{port}/termctrl/{}", self.token))
    }

    pub async fn list_sessions(&self) -> TermctrlSessionList {
        let fetched_at = now_ms();
        let resolved = match self.resolved_binary().await {
            Ok(value) => value,
            Err(error) => {
                return TermctrlSessionList {
                    schema_version: SCHEMA_VERSION,
                    available: false,
                    terminal_control_version: None,
                    fetched_at,
                    sessions: Vec::new(),
                    error: Some(error),
                };
            }
        };

        let args = vec!["list".to_string(), "--json".to_string()];
        let output = match self.run_cli(&resolved, &args, CLI_BUDGET).await {
            Ok(value) => value,
            Err(error) => {
                return TermctrlSessionList {
                    schema_version: SCHEMA_VERSION,
                    available: true,
                    terminal_control_version: Some(resolved.version),
                    fetched_at,
                    sessions: Vec::new(),
                    error: Some(error),
                };
            }
        };

        match parse_session_list(&output.stdout) {
            Ok(sessions) => TermctrlSessionList {
                schema_version: SCHEMA_VERSION,
                available: true,
                terminal_control_version: Some(resolved.version),
                fetched_at,
                sessions,
                error: None,
            },
            Err(error) => TermctrlSessionList {
                schema_version: SCHEMA_VERSION,
                available: true,
                terminal_control_version: Some(resolved.version),
                fetched_at,
                sessions: Vec::new(),
                error: Some(error),
            },
        }
    }

    pub async fn screen(&self, name: &str) -> Result<TermctrlScreen, String> {
        if !valid_session_name(name) {
            return Err("invalid session name".to_string());
        }
        let resolved = self.resolved_binary().await?;
        let output = self
            .run_cli(&resolved, &screen_args(name), CLI_BUDGET)
            .await?;
        Ok(TermctrlScreen {
            schema_version: SCHEMA_VERSION,
            name: name.to_string(),
            text: decode_screen(output.stdout),
            fetched_at: now_ms(),
        })
    }

    /// Spec 330: the session's retained raw PTY output, or only the part after
    /// `cursor`. Krypton keeps nothing between calls; the page owns the cursor.
    pub async fn log(
        &self,
        name: &str,
        cursor: Option<&TermctrlLogCursor>,
    ) -> Result<TermctrlLogChunk, String> {
        if !valid_session_name(name) {
            return Err("invalid session name".to_string());
        }
        let resolved = self.resolved_binary().await?;
        let output = self
            .run_cli(&resolved, &log_args(name), LOG_BUDGET)
            .await
            .map_err(|error| {
                if error == overflow_error(LOG_OUTPUT_LIMIT) {
                    LOG_TOO_LARGE.to_string()
                } else {
                    error
                }
            })?;
        // Read after the bytes: `logs_truncated` only ever turns on, so
        // "not truncated" here also held when the ring was copied above.
        let status = self
            .run_cli(&resolved, &status_args(name), CLI_BUDGET)
            .await?;
        let truncated = parse_logs_truncated(&status.stdout)?;
        let mut bytes = output.stdout;
        let length = bytes.len();
        let (mode, start) = log_delta(&bytes, truncated, cursor);
        bytes.drain(..start);
        Ok(TermctrlLogChunk {
            mode,
            length,
            truncated,
            bytes,
        })
    }

    /// Runs one CLI command with the cached binary. A spawn failure forgets the
    /// cache so a moved or reinstalled binary is found again on the next poll.
    async fn run_cli(
        &self,
        resolved: &ResolvedBinary,
        args: &[String],
        budget: Budget,
    ) -> Result<BoundedOutput, String> {
        let result = run_bounded(resolved, args, budget).await;
        if matches!(&result, Err(error) if error == START_ERROR) {
            self.invalidate_resolution();
        }
        result
    }

    async fn resolved_binary(&self) -> Result<ResolvedBinary, String> {
        if let Some(cached) = self
            .resolved
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            return Ok(cached);
        }

        let path = tokio::task::spawn_blocking(resolve_termctrl_binary)
            .await
            .map_err(|_| "termctrl discovery failed".to_string())?
            .ok_or_else(|| {
                "termctrl not found; install it with `cargo install terminal-control`".to_string()
            })?;
        let runtime_dir = std::env::var("TERMCTRL_RUNTIME_DIR").ok().or_else(|| {
            crate::pty::cached_login_env()
                .get("TERMCTRL_RUNTIME_DIR")
                .cloned()
        });
        let unresolved = ResolvedBinary {
            path,
            version: String::new(),
            runtime_dir,
        };
        let version_args = vec!["--version".to_string()];
        let output = run_bounded(&unresolved, &version_args, CLI_BUDGET).await?;
        let version_output = String::from_utf8(output.stdout)
            .map_err(|_| "termctrl returned a non-UTF-8 version".to_string())?
            .to_string();
        let version = parse_version_label(&version_output)
            .ok_or_else(|| "termctrl returned an invalid version".to_string())?;
        let resolved = ResolvedBinary {
            version,
            ..unresolved
        };
        *self
            .resolved
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(resolved.clone());
        Ok(resolved)
    }

    fn invalidate_resolution(&self) {
        *self
            .resolved
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }
}

pub fn valid_session_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn screen_args(name: &str) -> Vec<String> {
    vec!["show".to_string(), name.to_string()]
}

fn log_args(name: &str) -> Vec<String> {
    vec!["logs".to_string(), name.to_string(), "--ansi".to_string()]
}

fn status_args(name: &str) -> Vec<String> {
    vec!["status".to_string(), name.to_string(), "--json".to_string()]
}

fn parse_logs_truncated(bytes: &[u8]) -> Result<bool, String> {
    serde_json::from_slice::<RawLogStatus>(bytes)
        .map(|status| status.logs_truncated)
        .map_err(|_| "termctrl returned incompatible status JSON".to_string())
}

/// Parses the page's `length` and hex `anchor` query values. Anything
/// malformed is `None`, which makes the read a Reset.
pub fn parse_log_cursor(length: Option<&str>, anchor: Option<&str>) -> Option<TermctrlLogCursor> {
    let length = length?.parse::<usize>().ok()?;
    let anchor = anchor?;
    if anchor.is_empty()
        || anchor.len() % 2 != 0
        || anchor.len() > LOG_ANCHOR_MAX * 2
        || !anchor.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    let anchor = (0..anchor.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&anchor[at..at + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    Some(TermctrlLogCursor { length, anchor })
}

/// Where the page's copy ends inside `buffer`: Append from that offset, or
/// Reset from 0 when it cannot be placed exactly.
///
/// While termctrl has never dropped bytes the ring only grows, so the copy
/// ends at `cursor.length` or the session was replaced. After a drop the
/// offsets have shifted by an unknown amount, so the anchor must occur
/// exactly once; a repeated anchor could place the copy on the wrong line.
fn log_delta(
    buffer: &[u8],
    truncated: bool,
    cursor: Option<&TermctrlLogCursor>,
) -> (TermctrlLogMode, usize) {
    let reset = (TermctrlLogMode::Reset, 0);
    let Some(cursor) = cursor.filter(|cursor| !cursor.anchor.is_empty()) else {
        return reset;
    };
    let anchor = cursor.anchor.as_slice();
    if !truncated {
        let end = cursor.length;
        let placed = end >= anchor.len()
            && end <= buffer.len()
            && &buffer[end - anchor.len()..end] == anchor;
        return if placed {
            (TermctrlLogMode::Append, end)
        } else {
            reset
        };
    }
    let mut found = buffer
        .windows(anchor.len())
        .enumerate()
        .filter(|(_, window)| *window == anchor)
        .map(|(at, _)| at);
    match (found.next(), found.next()) {
        (Some(at), None) => (TermctrlLogMode::Append, at + anchor.len()),
        _ => reset,
    }
}

fn overflow_error(limit: usize) -> String {
    format!("termctrl output exceeded {} MiB", limit / (1024 * 1024))
}

fn parse_version_label(output: &str) -> Option<String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(
        trimmed
            .strip_prefix("termctrl ")
            .unwrap_or(trimmed)
            .trim()
            .to_string(),
    )
}

fn decode_screen(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

fn parse_session_list(bytes: &[u8]) -> Result<Vec<TermctrlSessionSummary>, String> {
    // Defense in depth for direct parser callers; the subprocess reader also
    // enforces this cap before returning bytes.
    if bytes.len() > OUTPUT_LIMIT {
        return Err(overflow_error(OUTPUT_LIMIT));
    }
    let raw: Vec<RawSessionEntry> = serde_json::from_slice(bytes)
        .map_err(|_| "termctrl returned incompatible session JSON".to_string())?;
    Ok(raw.into_iter().map(normalize_session).collect())
}

fn normalize_session(raw: RawSessionEntry) -> TermctrlSessionSummary {
    if let Some(status) = raw.status {
        let state = match status.state.as_str() {
            "running" => TermctrlSessionState::Running,
            "exited" => TermctrlSessionState::Exited,
            _ => TermctrlSessionState::Unknown,
        };
        return TermctrlSessionSummary {
            name: raw.name,
            state,
            command: status.launch.command,
            cwd: Some(status.launch.cwd.to_string_lossy().to_string()),
            cols: Some(status.cols),
            rows: Some(status.rows),
            recording: status.recording,
            logs_truncated: status.logs_truncated,
            idle_for_ms: status.idle_for_ms,
            has_visible_content: status.has_visible_content,
            error: raw.error.map(|error| sanitize_message(&error)),
        };
    }

    let state = match raw.unavailable.as_deref() {
        Some("stale") => TermctrlSessionState::Stale,
        Some("incompatible_protocol") => TermctrlSessionState::Incompatible,
        _ => TermctrlSessionState::Unknown,
    };
    TermctrlSessionSummary {
        name: raw.name,
        state,
        command: Vec::new(),
        cwd: None,
        cols: None,
        rows: None,
        recording: false,
        logs_truncated: false,
        idle_for_ms: None,
        has_visible_content: false,
        error: raw.error.map(|error| sanitize_message(&error)),
    }
}

fn sanitize_message(message: &str) -> String {
    let compact = message.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(240).collect()
}

fn resolve_termctrl_binary() -> Option<PathBuf> {
    let override_value = std::env::var("TERMCTRL_BINARY").ok();
    let process_path = std::env::var_os("PATH");
    let login_path = crate::pty::cached_login_env().get("PATH").cloned();
    let home = dirs::home_dir();
    resolve_binary_from(
        override_value.as_deref(),
        process_path.as_deref(),
        login_path.as_deref(),
        home.as_deref(),
    )
}

fn resolve_binary_from(
    override_value: Option<&str>,
    process_path: Option<&std::ffi::OsStr>,
    login_path: Option<&str>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(value) = override_value.filter(|value| !value.is_empty()) {
        let override_path = PathBuf::from(value);
        if override_path.is_absolute() {
            return is_executable(&override_path).then_some(override_path);
        }
        if override_path.components().count() == 1 {
            add_path_candidates(&mut candidates, process_path, value);
            add_path_candidates(&mut candidates, login_path.map(std::ffi::OsStr::new), value);
            return candidates
                .into_iter()
                .find(|candidate| is_executable(candidate));
        }
        return None;
    }
    add_path_candidates(&mut candidates, process_path, "termctrl");
    add_path_candidates(
        &mut candidates,
        login_path.map(std::ffi::OsStr::new),
        "termctrl",
    );
    if let Some(home) = home {
        candidates.push(home.join(".cargo/bin/termctrl"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/termctrl"));
    candidates.push(PathBuf::from("/usr/local/bin/termctrl"));

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .find(|candidate| seen.insert(candidate.clone()) && is_executable(candidate))
}

fn add_path_candidates(
    candidates: &mut Vec<PathBuf>,
    path_value: Option<&std::ffi::OsStr>,
    binary: &str,
) {
    if let Some(path_value) = path_value {
        candidates.extend(std::env::split_paths(path_value).map(|dir| dir.join(binary)));
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

async fn run_bounded(
    binary: &ResolvedBinary,
    args: &[String],
    budget: Budget,
) -> Result<BoundedOutput, String> {
    let mut command = Command::new(&binary.path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(runtime_dir) = &binary.runtime_dir {
        command.env("TERMCTRL_RUNTIME_DIR", runtime_dir);
    }
    let mut child = command.spawn().map_err(|_| START_ERROR.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to read termctrl output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to read termctrl diagnostics".to_string())?;
    let total = Arc::new(AtomicUsize::new(0));
    let overflowed = Arc::new(AtomicBool::new(false));
    let stdout_task = tokio::spawn(read_bounded_stream(
        stdout,
        Arc::clone(&total),
        Arc::clone(&overflowed),
        budget.limit,
    ));
    let stderr_task = tokio::spawn(read_bounded_stream(
        stderr,
        Arc::clone(&total),
        Arc::clone(&overflowed),
        budget.limit,
    ));

    let status = match tokio::time::timeout(budget.timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => return Err("failed while waiting for termctrl".to_string()),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err("termctrl command timed out".to_string());
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|_| "failed to collect termctrl output".to_string())?
        .map_err(|_| "failed to read termctrl output".to_string())?;
    stderr_task
        .await
        .map_err(|_| "failed to collect termctrl diagnostics".to_string())?
        .map_err(|_| "failed to read termctrl diagnostics".to_string())?;
    if overflowed.load(Ordering::Relaxed) {
        return Err(overflow_error(budget.limit));
    }
    if !status.success() {
        return Err(format!(
            "termctrl command failed{}",
            status
                .code()
                .map(|code| format!(" with status {code}"))
                .unwrap_or_default()
        ));
    }
    Ok(BoundedOutput { stdout })
}

async fn read_bounded_stream<R: AsyncRead + Unpin>(
    mut reader: R,
    total: Arc<AtomicUsize>,
    overflowed: Arc<AtomicBool>,
    limit: usize,
) -> std::io::Result<Vec<u8>> {
    let mut collected = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let before = total.fetch_add(read, Ordering::Relaxed);
        if before >= limit {
            overflowed.store(true, Ordering::Relaxed);
            continue;
        }
        let keep = read.min(limit - before);
        collected.extend_from_slice(&chunk[..keep]);
        if keep < read {
            overflowed.store(true, Ordering::Relaxed);
        }
    }
    Ok(collected)
}

pub(crate) fn capability_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let mut hasher = Sha256::new();
        hasher.update(nanos.to_le_bytes());
        hasher.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
        bytes.copy_from_slice(&hasher.finalize()[..16]);
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_normalizes_cli_session_list() {
        let json = br#"[
          {
            "name": "remote",
            "status": {
              "state": "running",
              "exit": null,
              "cols": 120,
              "rows": 40,
              "cell_width": 9,
              "cell_height": 18,
              "idle_for_ms": 25,
              "has_visible_content": true,
              "recording": false,
              "logs_truncated": false,
              "launch": {
                "command": ["ssh", "root@example.test"],
                "cwd": "/tmp",
                "record": null,
                "cols": 120,
                "rows": 40,
                "cell_width": 9,
                "cell_height": 18,
                "max_bytes": 16777216,
                "opentui_host": false,
                "color": "auto"
              }
            },
            "error": null,
            "unavailable": null,
            "future_field": true
          },
          {
            "name": "old",
            "status": null,
            "error": "socket is stale",
            "unavailable": "stale"
          }
        ]"#;
        let sessions = parse_session_list(json).expect("fixture parses");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].state, TermctrlSessionState::Running);
        assert_eq!(sessions[0].command, ["ssh", "root@example.test"]);
        assert_eq!(sessions[0].cols, Some(120));
        assert_eq!(sessions[1].state, TermctrlSessionState::Stale);
        assert_eq!(sessions[1].error.as_deref(), Some("socket is stale"));
    }

    #[test]
    fn rejects_incompatible_top_level_json() {
        assert!(parse_session_list(br#"{"sessions":[]}"#).is_err());
        assert!(parse_session_list(b"not json").is_err());
    }

    #[test]
    fn validates_names_before_cli_execution() {
        for name in ["remote", "build.log", "agent_2", "ssh-prod"] {
            assert!(valid_session_name(name));
        }
        for name in [
            "",
            "-r",
            "--help",
            "../remote",
            "a/b",
            "remote%2Fbad",
            "name space",
            "ไทย",
        ] {
            assert!(!valid_session_name(name));
        }
        assert_eq!(screen_args("remote"), ["show", "remote"]);
    }

    #[test]
    fn version_parser_accepts_standard_and_renamed_binaries() {
        assert_eq!(
            parse_version_label("termctrl 0.4.1\n"),
            Some("0.4.1".to_string())
        );
        assert_eq!(
            parse_version_label("terminal-control 0.4.1\n"),
            Some("terminal-control 0.4.1".to_string())
        );
        assert_eq!(parse_version_label("  \n"), None);
    }

    #[test]
    fn screen_decode_replaces_invalid_utf8() {
        assert_eq!(decode_screen(vec![b'a', 0xff, b'b']), "a�b");
    }

    #[test]
    #[cfg(unix)]
    fn resolver_honors_an_executable_override() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("krypton-termctrl-{}", now_ms()));
        std::fs::create_dir_all(&dir).expect("create fixture dir");
        let binary = dir.join("termctrl-test");
        std::fs::write(&binary, "#!/bin/sh\nexit 0\n").expect("write fixture binary");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make fixture executable");
        let found = resolve_binary_from(binary.to_str(), None, None, None);
        assert_eq!(found.as_deref(), Some(binary.as_path()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolver_rejects_relative_multi_component_override() {
        let found = resolve_binary_from(Some("./bin/termctrl"), None, None, None);
        assert!(found.is_none());
    }

    #[test]
    fn parser_keeps_a_defensive_output_cap() {
        let oversized = vec![b' '; OUTPUT_LIMIT + 1];
        assert_eq!(
            parse_session_list(&oversized).unwrap_err(),
            "termctrl output exceeded 1 MiB"
        );
    }

    #[tokio::test]
    async fn bounded_reader_flags_combined_overflow() {
        use tokio::io::AsyncWriteExt;

        let (mut writer, reader) = tokio::io::duplex(8192);
        let write = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; OUTPUT_LIMIT + 1])
                .await
                .expect("write fixture");
        });
        let total = Arc::new(AtomicUsize::new(0));
        let overflowed = Arc::new(AtomicBool::new(false));
        let collected = read_bounded_stream(
            reader,
            Arc::clone(&total),
            Arc::clone(&overflowed),
            OUTPUT_LIMIT,
        )
        .await
        .expect("read fixture");
        write.await.expect("writer joins");
        assert_eq!(collected.len(), OUTPUT_LIMIT);
        assert!(overflowed.load(Ordering::Relaxed));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn bounded_runner_reports_non_zero_exit_without_stderr_contents() {
        let binary = ResolvedBinary {
            path: PathBuf::from("/bin/sh"),
            version: "test".to_string(),
            runtime_dir: None,
        };
        let args = vec![
            "-c".to_string(),
            "printf sensitive-value >&2; exit 7".to_string(),
        ];
        let error = run_bounded(&binary, &args, CLI_BUDGET)
            .await
            .expect_err("command fails");
        assert!(error.contains("status 7"));
        assert!(!error.contains("sensitive-value"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn bounded_runner_times_out_and_kills_the_child() {
        let binary = ResolvedBinary {
            path: PathBuf::from("/bin/sh"),
            version: "test".to_string(),
            runtime_dir: None,
        };
        let args = vec!["-c".to_string(), "sleep 1".to_string()];
        let budget = Budget {
            limit: OUTPUT_LIMIT,
            timeout: Duration::from_millis(25),
        };
        let error = run_bounded(&binary, &args, budget)
            .await
            .expect_err("command times out");
        assert_eq!(error, "termctrl command timed out");
    }

    #[tokio::test]
    async fn spawn_failure_invalidates_the_cached_binary() {
        let monitor = TermctrlMonitor {
            token: "test".to_string(),
            resolved: Mutex::new(Some(ResolvedBinary {
                path: PathBuf::from("/definitely/missing/termctrl"),
                version: "test".to_string(),
                runtime_dir: None,
            })),
        };
        assert!(monitor.screen("remote").await.is_err());
        assert!(monitor.resolved.lock().unwrap().is_none());
    }

    fn cursor(length: usize, anchor: &[u8]) -> TermctrlLogCursor {
        TermctrlLogCursor {
            length,
            anchor: anchor.to_vec(),
        }
    }

    #[test]
    fn log_delta_resets_without_a_cursor() {
        assert_eq!(log_delta(b"abc", false, None), (TermctrlLogMode::Reset, 0));
        assert_eq!(
            log_delta(b"abc", true, Some(&cursor(3, b""))),
            (TermctrlLogMode::Reset, 0)
        );
    }

    #[test]
    fn log_delta_appends_after_the_copy_while_the_ring_only_grew() {
        let buffer = b"line 1\nline 2\nline 1\nline 2\n";
        // The anchor repeats, but an unwrapped ring places the copy by length.
        assert_eq!(
            log_delta(buffer, false, Some(&cursor(14, b"line 2\n"))),
            (TermctrlLogMode::Append, 14)
        );
        assert_eq!(
            log_delta(buffer, false, Some(&cursor(buffer.len(), b"line 2\n"))),
            (TermctrlLogMode::Append, buffer.len())
        );
    }

    #[test]
    fn log_delta_resets_when_an_unwrapped_ring_no_longer_holds_the_copy() {
        // A restarted session: same length, different bytes.
        assert_eq!(
            log_delta(b"fresh!", false, Some(&cursor(6, b"old!"))),
            (TermctrlLogMode::Reset, 0)
        );
        // The page claims more than termctrl holds.
        assert_eq!(
            log_delta(b"abc", false, Some(&cursor(9, b"c"))),
            (TermctrlLogMode::Reset, 0)
        );
    }

    #[test]
    fn log_delta_finds_a_unique_anchor_after_the_ring_dropped_bytes() {
        // The page held "...[a]cdef"; termctrl dropped the first bytes and appended "gh".
        assert_eq!(
            log_delta(b"cdefgh", true, Some(&cursor(6, b"ef"))),
            (TermctrlLogMode::Append, 4)
        );
    }

    #[test]
    fn log_delta_resets_on_a_missing_or_repeated_anchor_after_a_drop() {
        assert_eq!(
            log_delta(b"efxxef", true, Some(&cursor(6, b"ef"))),
            (TermctrlLogMode::Reset, 0)
        );
        assert_eq!(
            log_delta(b"ghij", true, Some(&cursor(6, b"ef"))),
            (TermctrlLogMode::Reset, 0)
        );
    }

    #[test]
    fn log_cursor_parser_accepts_only_bounded_hex() {
        assert_eq!(
            parse_log_cursor(Some("42"), Some("0a7F")),
            Some(cursor(42, &[0x0a, 0x7f]))
        );
        let longest = "ab".repeat(LOG_ANCHOR_MAX);
        assert!(parse_log_cursor(Some("1"), Some(&longest)).is_some());
        let too_long = "ab".repeat(LOG_ANCHOR_MAX + 1);
        for (length, anchor) in [
            (None, Some("0a")),
            (Some("-1"), Some("0a")),
            (Some("x"), Some("0a")),
            (Some("1"), None),
            (Some("1"), Some("")),
            (Some("1"), Some("abc")),
            (Some("1"), Some("+f")),
            (Some("1"), Some("zz")),
            (Some("1"), Some("ไท")),
            (Some("1"), Some(too_long.as_str())),
        ] {
            assert_eq!(
                parse_log_cursor(length, anchor),
                None,
                "{length:?} {anchor:?}"
            );
        }
    }

    #[test]
    fn log_status_parser_treats_a_missing_flag_as_never_truncated() {
        assert!(parse_logs_truncated(br#"{"state":"running","logs_truncated":true}"#).unwrap());
        assert!(!parse_logs_truncated(br#"{"state":"running"}"#).unwrap());
        assert!(parse_logs_truncated(br#"{"logs_truncated":"yes"}"#).is_err());
        assert!(parse_logs_truncated(b"not json").is_err());
    }
}
