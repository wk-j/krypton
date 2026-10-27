//! Inline AI remote checks (spec 336).
//!
//! In an SSH pane, `Cmd+K`'s agent runs on the Mac. `inline_remote_open`
//! connects a separate, non-PTY SSH channel to the pane's host and issues a
//! capability token; the agent's MCP server `krypton_inline` (served by the
//! hook server at `/mcp/inline`) exposes one tool, `host_exec`, which runs a
//! command on that host only when the spec 318 read-only classifier accepts
//! it. `inline_remote_close` revokes the token and kills its running checks;
//! an owned master is left to `ControlPersist` so the next `Cmd+K` reuses it.

use crate::pty::PtyManager;
use crate::ssh::{SshConnectionInfo, SshManager};
use crate::ssh_channel::{self, SshTarget};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::watch;

pub const SERVER_NAME: &str = "krypton_inline";
pub const CAPABILITY_HEADER: &str = "x-krypton-inline-capability";
const TOOL_NAME: &str = "host_exec";
const DEFAULT_TIMEOUT_SECS: u64 = 15;
const MAX_TIMEOUT_SECS: u64 = 30;
const PROBE_TIMEOUT_SECS: u64 = 20;
const MAX_RUNNING_PER_TOKEN: usize = 2;
/// Each output stream keeps its first and last `KEEP_BYTES`.
const KEEP_BYTES: usize = 8 * 1024;
const PROBE_SCRIPT: &str = "basename \"${SHELL:-sh}\"\n(hostname -s 2>/dev/null || hostname)\n";
const INVALID_TOKEN: &str = "inline remote capability is invalid or revoked";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineRemoteInfo {
    /// 32-byte random hex; the `x-krypton-inline-capability` header value.
    pub token: String,
    /// `<ssh -G user>@<probed hostname -s>`.
    pub display: String,
    /// The probed `hostname -s`.
    pub host: String,
    /// Basename of the remote `$SHELL`.
    pub shell: Option<String>,
    /// The OSC 7 cwd, only when its host matches the probed host.
    pub cwd: Option<String>,
}

/// One open channel, addressed by its token.
struct InlineRemote {
    target: SshTarget,
    socket: PathBuf,
    borrowed: bool,
    control_persist: u64,
    display: String,
    cwd: Option<String>,
    running: AtomicUsize,
    /// Set to `true` on close; running checks are killed when it changes.
    closed: watch::Sender<bool>,
}

impl InlineRemote {
    fn new(
        target: SshTarget,
        socket: PathBuf,
        borrowed: bool,
        control_persist: u64,
        display: String,
        cwd: Option<String>,
    ) -> Self {
        Self {
            target,
            socket,
            borrowed,
            control_persist,
            display,
            cwd,
            running: AtomicUsize::new(0),
            closed: watch::channel(false).0,
        }
    }
}

/// A running-check slot; released on drop.
struct RunningSlot(Arc<InlineRemote>);

impl RunningSlot {
    fn acquire(entry: &Arc<InlineRemote>) -> Option<Self> {
        entry
            .running
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |running| {
                (running < MAX_RUNNING_PER_TOKEN).then_some(running + 1)
            })
            .ok()
            .map(|_| Self(entry.clone()))
    }
}

impl Drop for RunningSlot {
    fn drop(&mut self) {
        self.0.running.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A `tools/call` result body.
#[derive(Debug, Clone, PartialEq)]
struct ToolText {
    text: String,
    is_error: bool,
}

impl ToolText {
    fn ok(text: String) -> Self {
        Self {
            text,
            is_error: false,
        }
    }

    fn error(text: String) -> Self {
        Self {
            text,
            is_error: true,
        }
    }

    fn into_value(self) -> Value {
        json!({ "content": [{ "type": "text", "text": self.text }], "isError": self.is_error })
    }
}

#[derive(Default)]
pub struct InlineRemoteManager {
    entries: Mutex<HashMap<String, Arc<InlineRemote>>>,
}

impl InlineRemoteManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve the pane's target, choose a master, probe the host and issue
    /// a token. Errors are short and shown verbatim.
    pub async fn open(
        &self,
        info: SshConnectionInfo,
        control_persist: u64,
        osc7_host: Option<&str>,
        osc7_cwd: Option<&str>,
    ) -> Result<InlineRemoteInfo, String> {
        let mut target = ssh_channel::focused_target(&info)?;
        ssh_channel::apply_ssh_config(&mut target).await?;
        let (socket, borrowed) =
            ssh_channel::select_control_socket(&target, &owned_socket_name(&target)).await?;
        let (shell, host) = probe(&target, &socket, borrowed, control_persist).await?;
        let display = format!("{}@{}", target.user, host);
        let cwd = osc7_cwd_for_host(osc7_host, osc7_cwd, &host);
        let token = self.register(InlineRemote::new(
            target,
            socket,
            borrowed,
            control_persist,
            display.clone(),
            cwd.clone(),
        ))?;
        Ok(InlineRemoteInfo {
            token,
            display,
            host,
            shell,
            cwd,
        })
    }

    fn register(&self, entry: InlineRemote) -> Result<String, String> {
        let token = crate::connected_computers::random_hex()?;
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token.clone(), Arc::new(entry));
        Ok(token)
    }

    fn entry(&self, token: &str) -> Option<Arc<InlineRemote>> {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .cloned()
    }

    /// Revoke `token` and kill its running checks.
    pub fn close(&self, token: &str) {
        let entry = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token);
        if let Some(entry) = entry {
            entry.closed.send_replace(true);
        }
    }

    /// MCP `tools/list`: `host_exec` for a live token, nothing otherwise.
    pub fn tools_list(&self, token: Option<&str>) -> Value {
        let tools = match token.and_then(|token| self.entry(token)) {
            Some(entry) => vec![host_exec_descriptor(&entry.display, entry.cwd.as_deref())],
            None => Vec::new(),
        };
        json!({ "tools": tools })
    }

    /// MCP `tools/call`. An invalid token or unknown tool is a JSON-RPC
    /// error; refusals and failures are `isError` results.
    pub async fn tools_call(&self, token: Option<&str>, params: Value) -> Result<Value, Value> {
        let name = params.get("name").and_then(Value::as_str).ok_or_else(
            || json!({ "code": -32602, "message": "tools/call missing params.name" }),
        )?;
        let token = token.unwrap_or("");
        if self.entry(token).is_none() {
            return Err(json!({ "code": -32600, "message": INVALID_TOKEN }));
        }
        if name != TOOL_NAME {
            return Err(json!({ "code": -32602, "message": format!("Unknown tool: {name}") }));
        }
        let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
        let Some(command) = arguments.get("command").and_then(Value::as_str) else {
            return Ok(
                ToolText::error("host_exec needs a `command` string".to_string()).into_value(),
            );
        };
        let timeout = arguments.get("timeoutSeconds").and_then(Value::as_u64);
        self.exec_with(token, command, timeout, run_over_ssh)
            .await
            .map(ToolText::into_value)
            .map_err(|message| json!({ "code": -32600, "message": message }))
    }

    /// The `host_exec` gate: token, classifier, concurrency. `run` spawns
    /// the check and is reached only when every gate passes.
    async fn exec_with<F, Fut>(
        &self,
        token: &str,
        command: &str,
        timeout_seconds: Option<u64>,
        run: F,
    ) -> Result<ToolText, String>
    where
        F: FnOnce(Arc<InlineRemote>, String, Duration, watch::Receiver<bool>) -> Fut,
        Fut: Future<Output = ToolText>,
    {
        let entry = self.entry(token).ok_or_else(|| INVALID_TOKEN.to_string())?;
        let Some(script) =
            crate::computer_read_only::read_only_script(command, entry.cwd.as_deref())
        else {
            return Ok(ToolText::error(format!(
                "Not run: only Krypton's read-only commands run on {} (no git, globs, redirects, \
                 $VAR, ~, cd). Put that step in your answer for the user to run.",
                entry.display
            )));
        };
        let Some(_slot) = RunningSlot::acquire(&entry) else {
            return Ok(ToolText::error(format!(
                "busy: {MAX_RUNNING_PER_TOKEN} checks are already running on {}; wait for one \
                 to finish",
                entry.display
            )));
        };
        let closed = entry.closed.subscribe();
        if *closed.borrow() {
            return Err(INVALID_TOKEN.to_string());
        }
        let script = match entry.cwd.as_deref() {
            Some(cwd) => format!("cd '{}' || exit 1\n{script}\n", cwd.replace('\'', "'\\''")),
            None => format!("{script}\n"),
        };
        let timeout = Duration::from_secs(
            timeout_seconds
                .unwrap_or(DEFAULT_TIMEOUT_SECS)
                .clamp(1, MAX_TIMEOUT_SECS),
        );
        Ok(run(entry, script, timeout, closed).await)
    }
}

/// `ssh … <destination> sh -s` over the entry's master; the script goes on
/// stdin, so the remote login shell never parses it.
fn sh_command(target: &SshTarget, socket: &Path, borrowed: bool, control_persist: u64) -> Command {
    let mut command =
        ssh_channel::configured_ssh_command(target, socket, borrowed, control_persist);
    command.arg(&target.destination).arg("sh").arg("-s");
    command
}

fn owned_socket_name(target: &SshTarget) -> String {
    let mut hasher = Sha256::new();
    hasher.update(target.destination.as_bytes());
    hasher.update([0]);
    hasher.update(target.port.to_be_bytes());
    let digest = hasher.finalize();
    let short: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("inline-{short}.sock")
}

/// Run the probe script; returns (remote shell basename, `hostname -s`).
async fn probe(
    target: &SshTarget,
    socket: &Path,
    borrowed: bool,
    control_persist: u64,
) -> Result<(Option<String>, String), String> {
    let mut command = sh_command(target, socket, borrowed, control_persist);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let run = async {
        let mut child = command
            .spawn()
            .map_err(|e| format!("ssh to {} failed to start: {e}", target.destination))?;
        if let Some(mut stdin) = child.stdin.take() {
            // A failed write shows up as ssh's own error below.
            let _ = stdin.write_all(PROBE_SCRIPT.as_bytes()).await;
        }
        child
            .wait_with_output()
            .await
            .map_err(|e| format!("ssh to {} failed: {e}", target.destination))
    };
    let output = tokio::time::timeout(Duration::from_secs(PROBE_TIMEOUT_SECS), run)
        .await
        .map_err(|_| {
            format!(
                "ssh to {} timed out after {PROBE_TIMEOUT_SECS} s",
                target.destination
            )
        })??;
    if !output.status.success() {
        let reason = ssh_failure_reason(&String::from_utf8_lossy(&output.stderr), target)
            .unwrap_or_else(|| match output.status.code() {
                Some(code) => format!("exit {code}"),
                None => "killed".to_string(),
            });
        return Err(format!("ssh to {} failed: {reason}", target.destination));
    }
    parse_probe(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        format!(
            "ssh to {} failed: the host did not report its hostname",
            target.destination
        )
    })
}

/// The probe's last two non-empty lines: shell basename, then hostname.
/// Earlier lines are noise from the login shell's rc files.
fn parse_probe(stdout: &str) -> Option<(Option<String>, String)> {
    let lines: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let [.., shell, host] = lines.as_slice() else {
        return None;
    };
    Some((Some((*shell).to_string()), (*host).to_string()))
}

/// ssh's last stderr line, without the `user@host: ` prefix it puts on
/// authentication errors.
fn ssh_failure_reason(stderr: &str, target: &SshTarget) -> Option<String> {
    let line = stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())?;
    let resolved = format!("{}@{}", target.user, target.host);
    let line = [target.destination.as_str(), resolved.as_str()]
        .iter()
        .find_map(|prefix| {
            line.strip_prefix(prefix)
                .and_then(|rest| rest.strip_prefix(": "))
        })
        .unwrap_or(line);
    Some(line.to_string())
}

/// The OSC 7 cwd when its host is the probed host (short names, any case)
/// and the path is absolute.
fn osc7_cwd_for_host(
    osc7_host: Option<&str>,
    osc7_cwd: Option<&str>,
    probed_host: &str,
) -> Option<String> {
    let short = |host: &str| host.trim().split('.').next().unwrap_or("").to_string();
    let host = short(osc7_host?);
    let cwd = osc7_cwd?;
    (!host.is_empty() && host.eq_ignore_ascii_case(&short(probed_host)) && cwd.starts_with('/'))
        .then(|| cwd.to_string())
}

fn host_exec_descriptor(display: &str, cwd: Option<&str>) -> Value {
    let location = cwd.unwrap_or("$HOME (cwd unknown)");
    json!({
        "name": TOOL_NAME,
        "description": format!(
            "Run one read-only command on {display}, the SSH host of the user's terminal pane, \
             and get its exit code, stdout and stderr. It runs in {location} on {display}. Only \
             Krypton's read-only list runs there: no git, globs, redirects, $VAR, ~ or cd; \
             anything else is refused and not run. One command per call; | && || ; are allowed. \
             Your own Bash tool runs on the user's Mac, not on {display}."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The read-only command to run on the host."
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_TIMEOUT_SECS,
                    "description": format!("Stop the command after this many seconds (default {DEFAULT_TIMEOUT_SECS}).")
                }
            },
            "required": ["command"]
        },
        "_meta": { "anthropic/alwaysLoad": true }
    })
}

/// The real `host_exec` runner: `sh -s` over the entry's channel.
async fn run_over_ssh(
    entry: Arc<InlineRemote>,
    script: String,
    timeout: Duration,
    mut closed: watch::Receiver<bool>,
) -> ToolText {
    let mut command = sh_command(
        &entry.target,
        &entry.socket,
        entry.borrowed,
        entry.control_persist,
    );
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ToolText::error(format!("ssh to {} failed to start: {error}", entry.display))
        }
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return ToolText::error("ssh output pipes unavailable".to_string());
    };
    let mut stdout_task = tokio::spawn(drain_head_tail(stdout));
    let mut stderr_task = tokio::spawn(drain_head_tail(stderr));
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    enum End {
        Exited(Option<i32>),
        Failed(String),
        TimedOut,
        Closed,
    }
    let mut end = None;
    if let Some(mut stdin) = child.stdin.take() {
        // A write error means ssh already gave up; its exit status says why.
        tokio::select! {
            _ = async { stdin.write_all(script.as_bytes()).await?; stdin.shutdown().await } => {}
            _ = &mut deadline => end = Some(End::TimedOut),
            _ = closed.changed() => end = Some(End::Closed),
        }
    }
    let end = match end {
        Some(end) => end,
        None => tokio::select! {
            status = child.wait() => match status {
                Ok(status) => End::Exited(status.code()),
                Err(error) => End::Failed(error.to_string()),
            },
            _ = &mut deadline => End::TimedOut,
            _ = closed.changed() => End::Closed,
        },
    };
    if matches!(end, End::TimedOut | End::Closed) {
        let _ = child.kill().await;
    }
    let stdout = collect_stream(&mut stdout_task).await;
    let stderr = collect_stream(&mut stderr_task).await;
    match end {
        // 255 is ssh's own failure status (connection, authentication); a
        // command's own non-zero exit is a result the model needs, not an error.
        End::Exited(Some(255)) => ToolText::error(format_output(Some(255), &stdout, &stderr)),
        End::Exited(code) => ToolText::ok(format_output(code, &stdout, &stderr)),
        End::Failed(error) => ToolText::error(format!("ssh to {} failed: {error}", entry.display)),
        End::TimedOut => ToolText::error(format!(
            "Stopped after {} s (timeout) on {}.\n{}",
            timeout.as_secs(),
            entry.display,
            format_output(None, &stdout, &stderr)
        )),
        End::Closed => ToolText::error("Stopped: the Inline AI conversation closed.".to_string()),
    }
}

async fn collect_stream(task: &mut tokio::task::JoinHandle<HeadTail>) -> HeadTail {
    match tokio::time::timeout(Duration::from_secs(2), &mut *task).await {
        Ok(Ok(kept)) => kept,
        _ => {
            task.abort();
            HeadTail::default()
        }
    }
}

async fn drain_head_tail<R: AsyncRead + Unpin>(mut reader: R) -> HeadTail {
    let mut kept = HeadTail::default();
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => kept.push(&buffer[..read]),
        }
    }
    kept
}

/// The first and last `KEEP_BYTES` of a stream plus its total length.
#[derive(Debug, Default)]
struct HeadTail {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
}

impl HeadTail {
    fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len();
        let take = (KEEP_BYTES - self.head.len()).min(bytes.len());
        self.head.extend_from_slice(&bytes[..take]);
        let rest = &bytes[take..];
        if rest.len() >= KEEP_BYTES {
            self.tail.clear();
            self.tail.extend(&rest[rest.len() - KEEP_BYTES..]);
        } else {
            self.tail.extend(rest);
            let excess = self.tail.len().saturating_sub(KEEP_BYTES);
            self.tail.drain(..excess);
        }
    }

    fn is_empty(&self) -> bool {
        self.total == 0
    }

    /// Lossy UTF-8, with `… <N> bytes cut …` where the middle was dropped.
    fn render(&self) -> String {
        let cut = self.total - self.head.len() - self.tail.len();
        if cut == 0 {
            let mut all = self.head.clone();
            all.extend(&self.tail);
            return String::from_utf8_lossy(&all).into_owned();
        }
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        format!(
            "{}\n… {cut} bytes cut …\n{}",
            String::from_utf8_lossy(&self.head),
            String::from_utf8_lossy(&tail)
        )
    }
}

fn format_output(code: Option<i32>, stdout: &HeadTail, stderr: &HeadTail) -> String {
    let mut text = match code {
        Some(code) => format!("exit {code}\n"),
        None => "exit unknown\n".to_string(),
    };
    text.push_str("--- stdout ---\n");
    push_stream(&mut text, stdout);
    if !stderr.is_empty() {
        text.push_str("--- stderr ---\n");
        push_stream(&mut text, stderr);
    }
    text
}

fn push_stream(text: &mut String, stream: &HeadTail) {
    text.push_str(&stream.render());
    if !text.ends_with('\n') {
        text.push('\n');
    }
}

#[tauri::command]
pub async fn inline_remote_open(
    session_id: u32,
    osc7_host: Option<String>,
    osc7_cwd: Option<String>,
    pty_manager: State<'_, Arc<PtyManager>>,
    ssh_manager: State<'_, Arc<SshManager>>,
    manager: State<'_, Arc<InlineRemoteManager>>,
) -> Result<InlineRemoteInfo, String> {
    let info = ssh_manager
        .detect(session_id, &pty_manager)
        .ok_or_else(|| "no ssh process in this pane".to_string())?;
    manager
        .open(
            info,
            ssh_manager.control_persist(),
            osc7_host.as_deref(),
            osc7_cwd.as_deref(),
        )
        .await
}

#[tauri::command]
pub fn inline_remote_close(token: String, manager: State<'_, Arc<InlineRemoteManager>>) {
    manager.close(&token);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn target() -> SshTarget {
        SshTarget {
            destination: "deploy@web".into(),
            user: "deploy".into(),
            host: "web-01.example.com".into(),
            port: 2222,
            connect_timeout_seconds: 15,
            extra_args: vec!["-i".into(), "/tmp/key".into()],
            requested_socket: None,
        }
    }

    fn open_entry(manager: &InlineRemoteManager, cwd: Option<&str>) -> String {
        manager
            .register(InlineRemote::new(
                target(),
                PathBuf::from("/tmp/inline.sock"),
                false,
                600,
                "deploy@web-01".into(),
                cwd.map(str::to_string),
            ))
            .unwrap()
    }

    /// A runner that records whether it was reached.
    fn recording(
        spawned: &AtomicBool,
    ) -> impl FnOnce(
        Arc<InlineRemote>,
        String,
        Duration,
        watch::Receiver<bool>,
    ) -> std::future::Ready<ToolText>
           + '_ {
        move |_, script, _, _| {
            spawned.store(true, Ordering::SeqCst);
            std::future::ready(ToolText::ok(script))
        }
    }

    fn argv(command: &Command) -> Vec<String> {
        command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[tokio::test]
    async fn token_lifecycle_refuses_unknown_and_revoked_tokens() {
        let manager = InlineRemoteManager::new();
        let spawned = AtomicBool::new(false);
        assert!(manager
            .exec_with("nope", "ls /", None, recording(&spawned))
            .await
            .is_err());
        assert!(!spawned.load(Ordering::SeqCst));

        let token = open_entry(&manager, Some("/srv/app"));
        assert_eq!(token.len(), 64);
        let ran = manager
            .exec_with(&token, "ls /", Some(99), recording(&spawned))
            .await
            .unwrap();
        assert!(spawned.load(Ordering::SeqCst));
        assert_eq!(
            ran,
            ToolText::ok("cd '/srv/app' || exit 1\n'ls' '/'\n".into())
        );

        manager.close(&token);
        let spawned = AtomicBool::new(false);
        assert!(manager
            .exec_with(&token, "ls /", None, recording(&spawned))
            .await
            .is_err());
        assert!(!spawned.load(Ordering::SeqCst));
        assert_eq!(manager.tools_list(Some(&token)), json!({ "tools": [] }));
        let call = manager
            .tools_call(
                Some(&token),
                json!({ "name": "host_exec", "arguments": { "command": "ls /" } }),
            )
            .await;
        assert!(call.is_err());
    }

    #[tokio::test]
    async fn classifier_refusal_is_an_error_result_and_spawns_nothing() {
        let manager = InlineRemoteManager::new();
        let token = open_entry(&manager, None);
        for command in [
            "git status",
            "cat *.log",
            "ls > /tmp/x",
            "echo $HOME",
            "cd /srv",
        ] {
            let spawned = AtomicBool::new(false);
            let result = manager
                .exec_with(&token, command, None, recording(&spawned))
                .await
                .unwrap();
            assert!(result.is_error, "{command}");
            assert!(result
                .text
                .starts_with("Not run: only Krypton's read-only commands run on deploy@web-01"));
            assert!(!spawned.load(Ordering::SeqCst), "{command}");
        }
    }

    #[tokio::test]
    async fn third_concurrent_check_is_busy() {
        let manager = InlineRemoteManager::new();
        let token = open_entry(&manager, None);
        let entry = manager.entry(&token).unwrap();
        let _a = RunningSlot::acquire(&entry).unwrap();
        let _b = RunningSlot::acquire(&entry).unwrap();
        let spawned = AtomicBool::new(false);
        let result = manager
            .exec_with(&token, "uptime", None, recording(&spawned))
            .await
            .unwrap();
        assert!(result.is_error);
        assert!(result.text.starts_with("busy"));
        assert!(!spawned.load(Ordering::SeqCst));
    }

    #[test]
    fn output_keeps_head_and_tail_with_a_cut_note() {
        let data: Vec<u8> = (0..20_000u32).map(|i| b'a' + (i % 26) as u8).collect();
        let mut kept = HeadTail::default();
        for chunk in data.chunks(1000) {
            kept.push(chunk);
        }
        let rendered = kept.render();
        let head = String::from_utf8(data[..KEEP_BYTES].to_vec()).unwrap();
        let tail = String::from_utf8(data[data.len() - KEEP_BYTES..].to_vec()).unwrap();
        assert_eq!(
            rendered,
            format!("{head}\n… {} bytes cut …\n{tail}", 20_000 - 2 * KEEP_BYTES)
        );

        let mut small = HeadTail::default();
        small.push("héllo\n".as_bytes());
        let empty = HeadTail::default();
        assert_eq!(
            format_output(Some(1), &small, &empty),
            "exit 1\n--- stdout ---\nhéllo\n"
        );
        assert_eq!(
            format_output(None, &empty, &small),
            "exit unknown\n--- stdout ---\n--- stderr ---\nhéllo\n"
        );
    }

    #[test]
    fn osc7_cwd_is_used_only_on_a_host_match() {
        let host = Some("WEB-01.example.com");
        assert_eq!(
            osc7_cwd_for_host(host, Some("/srv/app"), "web-01"),
            Some("/srv/app".to_string())
        );
        assert_eq!(osc7_cwd_for_host(host, Some("srv/app"), "web-01"), None);
        assert_eq!(
            osc7_cwd_for_host(Some("db-01"), Some("/srv"), "web-01"),
            None
        );
        assert_eq!(osc7_cwd_for_host(Some(""), Some("/srv"), "web-01"), None);
        assert_eq!(osc7_cwd_for_host(None, Some("/srv"), "web-01"), None);
    }

    #[test]
    fn ssh_argv_for_borrowed_and_owned_masters() {
        let socket = Path::new("/tmp/inline.sock");
        let common = |control_master: &'static str| {
            vec![
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=15",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=2",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                control_master,
                "-o",
                "ControlPath=/tmp/inline.sock",
                "-o",
                "ControlPersist=600",
                "-p",
                "2222",
                "-i",
                "/tmp/key",
                "deploy@web",
                "sh",
                "-s",
            ]
        };
        assert_eq!(
            argv(&sh_command(&target(), socket, true, 600)),
            common("ControlMaster=no")
        );
        assert_eq!(
            argv(&sh_command(&target(), socket, false, 600)),
            common("ControlMaster=auto")
        );
        let name = owned_socket_name(&target());
        assert!(name.starts_with("inline-") && name.ends_with(".sock"));
        assert_eq!(name.len(), "inline-".len() + 16 + ".sock".len());
    }

    #[test]
    fn tools_list_describes_host_exec_for_a_live_token_only() {
        let manager = InlineRemoteManager::new();
        assert_eq!(manager.tools_list(None), json!({ "tools": [] }));
        assert_eq!(manager.tools_list(Some("bogus")), json!({ "tools": [] }));
        let token = open_entry(&manager, None);
        let list = manager.tools_list(Some(&token));
        let tools = list["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        let tool = &tools[0];
        assert_eq!(tool["name"], "host_exec");
        assert_eq!(tool["_meta"]["anthropic/alwaysLoad"], true);
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert_eq!(tool["inputSchema"]["required"], json!(["command"]));
        assert_eq!(
            tool["inputSchema"]["properties"]["command"]["type"],
            "string"
        );
        let timeout = &tool["inputSchema"]["properties"]["timeoutSeconds"];
        assert_eq!(timeout["type"], "integer");
        assert_eq!(timeout["minimum"], 1);
        assert_eq!(timeout["maximum"], 30);
        let description = tool["description"].as_str().unwrap();
        assert!(description.contains("deploy@web-01"));
        assert!(description.contains("$HOME (cwd unknown)"));
        assert!(description.contains("no git, globs, redirects, $VAR, ~ or cd"));
        assert!(description.contains("| && || ;"));
    }

    #[test]
    fn probe_and_failure_parsing() {
        assert_eq!(
            parse_probe("motd noise\nfish\nweb-01\n"),
            Some((Some("fish".into()), "web-01".into()))
        );
        assert_eq!(parse_probe("web-01\n"), None);
        let target = target();
        assert_eq!(
            ssh_failure_reason(
                "Warning: x\ndeploy@web: Permission denied (publickey,password).\n",
                &target
            )
            .as_deref(),
            Some("Permission denied (publickey,password).")
        );
        assert_eq!(
            ssh_failure_reason("Host key verification failed.\n", &target).as_deref(),
            Some("Host key verification failed.")
        );
        assert_eq!(ssh_failure_reason("\n", &target), None);
    }
}
