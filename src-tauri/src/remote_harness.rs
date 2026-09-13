use crate::config::{KryptonConfig, RemoteHarnessProfile};
use crate::pty::PtyManager;
use crate::ssh::{SshConnectionInfo, SshManager};
use crate::util::emit::EmitExt;
use futures_util::StreamExt;
use krypton_remote_protocol::{
    RemoteMethod, RemoteWorkspace, RuntimeFrame, MAX_FRAME_BYTES, PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 15;
const REMOTE_RUNTIME_DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const MAX_REMOTE_RUNTIME_BYTES: usize = 64 * 1024 * 1024;
const REMOTE_RUNTIME_RELEASE_REPOSITORY: &str = "wk-j/krypton";
static REMOTE_RUNTIME_TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemoteHarnessLaunch {
    Profile {
        profile: String,
    },
    FocusedSsh {
        #[serde(rename = "terminalSessionId")]
        terminal_session_id: u32,
        #[serde(rename = "projectDir")]
        project_dir: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedSshCandidate {
    pub terminal_session_id: u32,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub project_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHarnessChoices {
    pub focused_ssh: Option<FocusedSshCandidate>,
    pub profiles: Vec<RemoteHarnessProfile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHarnessWorkspace {
    pub runtime_id: String,
    pub source: String,
    pub profile: Option<String>,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub borrowed_master: bool,
}

#[derive(Debug, Clone)]
struct ResolvedTarget {
    source: String,
    profile: Option<String>,
    destination: String,
    user: String,
    host: String,
    port: u16,
    project_dir: String,
    connect_timeout_seconds: u64,
    extra_args: Vec<String>,
    requested_socket: Option<PathBuf>,
}

#[derive(Debug)]
pub enum RemoteAgentEvent {
    Stdout(String),
    Stderr(String),
    Exit(Option<i32>),
}

pub struct RemoteAgentHandle {
    pub transport: RemoteAgentTransport,
    pub events: mpsc::UnboundedReceiver<RemoteAgentEvent>,
}

#[derive(Clone)]
pub struct RemoteAgentTransport {
    runtime: Arc<RemoteRuntimeClient>,
    agent_id: u64,
}

impl RemoteAgentTransport {
    pub async fn write(&self, data: String) -> Result<(), String> {
        self.runtime
            .request(
                RemoteMethod::AgentWrite,
                json!({ "agentId": self.agent_id, "data": data }),
            )
            .await
            .map(|_| ())
    }

    pub async fn terminate(&self) -> Result<(), String> {
        self.runtime
            .request(
                RemoteMethod::AgentTerminate,
                json!({ "agentId": self.agent_id }),
            )
            .await
            .map(|_| ())
    }
}

#[derive(Debug, Clone)]
struct ReverseForward {
    local_port: u16,
    remote_port: u16,
}

pub struct RemoteRuntimeClient {
    id: String,
    target: ResolvedTarget,
    workspace: RwLock<RemoteWorkspace>,
    control_socket: PathBuf,
    borrowed_master: bool,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    agents: Mutex<HashMap<u64, mpsc::UnboundedSender<RemoteAgentEvent>>>,
    orphan_agent_events: Mutex<HashMap<u64, Vec<RemoteAgentEvent>>>,
    reverse_forward: Mutex<Option<ReverseForward>>,
    stderr: Mutex<String>,
    next_request_id: AtomicU64,
    disconnected: AtomicBool,
    app: AppHandle,
}

impl RemoteRuntimeClient {
    pub async fn request(&self, method: RemoteMethod, params: Value) -> Result<Value, String> {
        if self.disconnected.load(Ordering::Relaxed) {
            return Err("remote Harness is disconnected".to_string());
        }
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let frame = RuntimeFrame::Request { id, method, params };
        if let Err(error) = self.write_frame(&frame).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("remote runtime closed before reply".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("remote runtime request timed out".to_string())
            }
        }
    }

    pub async fn spawn_agent(
        self: &Arc<Self>,
        command: String,
        args: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
    ) -> Result<RemoteAgentHandle, String> {
        let response = self
            .request(
                RemoteMethod::AgentSpawn,
                json!({
                    "command": command,
                    "args": args,
                    "cwd": cwd,
                    "env": env,
                }),
            )
            .await?;
        let agent_id = response
            .get("agentId")
            .and_then(Value::as_u64)
            .ok_or_else(|| "agent_spawn response missing agentId".to_string())?;
        let (tx, rx) = mpsc::unbounded_channel();
        self.agents.lock().await.insert(agent_id, tx.clone());
        if let Some(events) = self.orphan_agent_events.lock().await.remove(&agent_id) {
            for event in events {
                let _ = tx.send(event);
            }
        }
        Ok(RemoteAgentHandle {
            transport: RemoteAgentTransport {
                runtime: self.clone(),
                agent_id,
            },
            events: rx,
        })
    }

    pub async fn read_text(&self, path: &str) -> Result<Option<String>, String> {
        let value = self
            .request(RemoteMethod::WorkspaceRead, json!({ "path": path }))
            .await?;
        if !value
            .get("exists")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(None);
        }
        value
            .get("content")
            .and_then(Value::as_str)
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| "workspace_read response missing content".to_string())
    }

    pub async fn write_text(&self, path: &str, content: &str) -> Result<(), String> {
        self.request(
            RemoteMethod::WorkspaceWrite,
            json!({ "path": path, "content": content }),
        )
        .await
        .map(|_| ())
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String, String> {
        let value = self
            .request(RemoteMethod::WorkspaceCanonicalize, json!({ "path": path }))
            .await?;
        value
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "workspace_canonicalize response missing path".to_string())
    }

    async fn write_frame(&self, frame: &RuntimeFrame) -> Result<(), String> {
        let mut line = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
        if line.len() > MAX_FRAME_BYTES {
            return Err(format!("remote frame exceeds {MAX_FRAME_BYTES} bytes"));
        }
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| "remote runtime stdin closed".to_string())?;
        stdin
            .write_all(&line)
            .await
            .map_err(|e| format!("remote runtime write failed: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("remote runtime flush failed: {e}"))
    }

    fn emit_state(&self, state: &str, message: Option<&str>) {
        self.app.emit_or_log(
            &format!("remote-harness-event-{}", self.id),
            json!({ "state": state, "message": message }),
        );
    }

    async fn dispatch_agent_event(&self, agent_id: u64, event: RemoteAgentEvent) {
        if let Some(tx) = self.agents.lock().await.get(&agent_id).cloned() {
            let _ = tx.send(event);
        } else {
            self.orphan_agent_events
                .lock()
                .await
                .entry(agent_id)
                .or_default()
                .push(event);
        }
    }

    async fn finalize_disconnect(&self, reason: String) {
        if self.disconnected.swap(true, Ordering::Relaxed) {
            return;
        }
        *self.stdin.lock().await = None;
        for (_, tx) in self.pending.lock().await.drain() {
            let _ = tx.send(Err(reason.clone()));
        }
        for (_, tx) in self.agents.lock().await.drain() {
            let _ = tx.send(RemoteAgentEvent::Exit(None));
        }
        self.emit_state("disconnected", Some(&reason));
    }

    async fn append_stderr(&self, chunk: &str) {
        let mut stderr = self.stderr.lock().await;
        stderr.push_str(chunk);
        stderr.push('\n');
        if stderr.len() > 64 * 1024 {
            let mut keep_from = stderr.len() - 64 * 1024;
            while !stderr.is_char_boundary(keep_from) {
                keep_from += 1;
            }
            *stderr = stderr[keep_from..].to_string();
        }
    }

    async fn open_reverse_forward(&self, local_port: u16) -> Result<u16, String> {
        if let Some(forward) = self.reverse_forward.lock().await.as_ref() {
            if forward.local_port == local_port {
                return Ok(forward.remote_port);
            }
            return Err("remote Harness already owns a different reverse forward".to_string());
        }
        let spec = format!("127.0.0.1:0:127.0.0.1:{local_port}");
        let output = self.control_command("forward", &["-R", &spec]).await?;
        let remote_port = output
            .split_whitespace()
            .find_map(|part| part.parse::<u16>().ok())
            .ok_or_else(|| format!("ssh did not report allocated reverse port: {output}"))?;
        *self.reverse_forward.lock().await = Some(ReverseForward {
            local_port,
            remote_port,
        });
        Ok(remote_port)
    }

    async fn cancel_reverse_forward(&self) {
        let Some(forward) = self.reverse_forward.lock().await.take() else {
            return;
        };
        let spec = format!(
            "127.0.0.1:{}:127.0.0.1:{}",
            forward.remote_port, forward.local_port
        );
        let _ = self.control_command("cancel", &["-R", &spec]).await;
    }

    async fn control_command(&self, operation: &str, tail: &[&str]) -> Result<String, String> {
        let mut command = Command::new("ssh");
        command
            .arg("-S")
            .arg(&self.control_socket)
            .arg("-O")
            .arg(operation);
        append_target_args(&mut command, &self.target);
        command.args(tail).arg(&self.target.destination);
        let output = command
            .output()
            .await
            .map_err(|e| format!("ssh -O {operation} failed to run: {e}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(format!(
                "ssh -O {operation} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    async fn shutdown(&self) {
        self.cancel_reverse_forward().await;
        if !self.disconnected.load(Ordering::Relaxed) {
            let _ = self.request(RemoteMethod::RuntimeShutdown, json!({})).await;
        }
        *self.stdin.lock().await = None;
        let mut child = self.child.lock().await;
        if let Some(mut child) = child.take() {
            if tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .is_err()
            {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        if !self.borrowed_master {
            let _ = self.control_command("exit", &[]).await;
        }
        self.disconnected.store(true, Ordering::Relaxed);
        self.emit_state("closing", None);
    }
}

pub struct RemoteHarnessRegistry {
    next_id: AtomicU64,
    clients: RwLock<HashMap<String, Arc<RemoteRuntimeClient>>>,
}

impl RemoteHarnessRegistry {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            clients: RwLock::new(HashMap::new()),
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<RemoteRuntimeClient>> {
        self.clients.read().ok()?.get(id).cloned()
    }

    fn insert(&self, id: String, client: Arc<RemoteRuntimeClient>) {
        if let Ok(mut clients) = self.clients.write() {
            clients.insert(id, client);
        }
    }

    fn remove(&self, id: &str) -> Option<Arc<RemoteRuntimeClient>> {
        self.clients.write().ok()?.remove(id)
    }

    fn allocate_id(&self) -> String {
        format!("rh-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    pub async fn dispose_all(&self) {
        let clients = match self.clients.write() {
            Ok(mut clients) => clients
                .drain()
                .map(|(_, client)| client)
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for client in clients {
            client.shutdown().await;
        }
    }
}

impl Default for RemoteHarnessRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub fn remote_harness_choices(
    terminal_session_id: Option<u32>,
    pty_manager: State<'_, Arc<PtyManager>>,
    ssh_manager: State<'_, Arc<SshManager>>,
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
) -> RemoteHarnessChoices {
    let focused_ssh = terminal_session_id.and_then(|session_id| {
        let info = ssh_manager.detect(session_id, &pty_manager)?;
        Some(FocusedSshCandidate {
            terminal_session_id: session_id,
            user: info.user,
            host: info.host,
            port: info.port,
            project_dir: ssh_manager.get_remote_cwd(session_id),
        })
    });
    let profiles = config
        .read()
        .map(|config| config.acp_harness.remote_profiles.clone())
        .unwrap_or_default();
    RemoteHarnessChoices {
        focused_ssh,
        profiles,
    }
}

#[tauri::command]
pub async fn remote_harness_connect(
    launch: RemoteHarnessLaunch,
    app: AppHandle,
    pty_manager: State<'_, Arc<PtyManager>>,
    ssh_manager: State<'_, Arc<SshManager>>,
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
    registry: State<'_, Arc<RemoteHarnessRegistry>>,
) -> Result<RemoteHarnessWorkspace, String> {
    let target = resolve_target(launch, &pty_manager, &ssh_manager, &config).await?;
    let runtime_id = registry.allocate_id();
    start_remote_runtime(
        target,
        runtime_id,
        app,
        ssh_manager.control_persist(),
        &registry,
    )
    .await
}

fn configured_ssh_command(
    target: &ResolvedTarget,
    control_socket: &Path,
    borrowed_master: bool,
    control_persist: u64,
) -> Command {
    let mut command = Command::new("ssh");
    command
        .arg("-T")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg(format!("ConnectTimeout={}", target.connect_timeout_seconds))
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=2")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg(if borrowed_master {
            "ControlMaster=no".to_string()
        } else {
            "ControlMaster=auto".to_string()
        })
        .arg("-o")
        .arg(format!("ControlPath={}", control_socket.display()))
        .arg("-o")
        .arg(format!("ControlPersist={control_persist}"));
    append_target_args(&mut command, target);
    command
}

fn normalize_remote_platform(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os.trim(), arch.trim()) {
        ("Darwin", "arm64" | "aarch64") => Ok("aarch64-apple-darwin"),
        ("Darwin", "x86_64" | "amd64") => Ok("x86_64-apple-darwin"),
        ("Linux", "arm64" | "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        ("Linux", "x86_64" | "amd64") => Ok("x86_64-unknown-linux-gnu"),
        _ => Err(format!(
            "unsupported remote platform: {} {}; supported targets are macOS/Linux on arm64 or x86_64",
            os.trim(),
            arch.trim()
        )),
    }
}

fn local_runtime_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        _ => None,
    }
}

fn remote_runtime_relative_path() -> String {
    format!(
        ".cache/krypton/remote/{}/krypton-remote",
        env!("CARGO_PKG_VERSION")
    )
}

fn expected_remote_runtime_version() -> String {
    format!(
        "protocol={PROTOCOL_VERSION} version={}",
        env!("CARGO_PKG_VERSION")
    )
}

fn remote_runtime_install_command() -> String {
    let relative_path = remote_runtime_relative_path();
    format!(
        "umask 077; dir=\"$HOME/{parent}\"; mkdir -p \"$dir\" && tmp=\"$dir/.upload-$$\" && trap 'rm -f \"$tmp\"' EXIT HUP INT TERM && cat > \"$tmp\" && chmod 700 \"$tmp\" && mv -f \"$tmp\" \"$dir/krypton-remote\" && trap - EXIT",
        parent = Path::new(&relative_path)
            .parent()
            .expect("fixed remote runtime path has a parent")
            .display()
    )
}

fn remote_runtime_release_url(target: &str) -> String {
    format!(
        "https://github.com/{REMOTE_RUNTIME_RELEASE_REPOSITORY}/releases/download/v{version}/krypton-remote-{target}",
        version = env!("CARGO_PKG_VERSION")
    )
}

async fn run_remote_command(
    target: &ResolvedTarget,
    control_socket: &Path,
    borrowed_master: bool,
    control_persist: u64,
    remote_command: &str,
) -> Result<std::process::Output, String> {
    let mut command =
        configured_ssh_command(target, control_socket, borrowed_master, control_persist);
    command
        .arg(&target.destination)
        .arg(remote_command)
        .kill_on_drop(true);
    tokio::time::timeout(
        Duration::from_secs(target.connect_timeout_seconds.saturating_add(15)),
        command.output(),
    )
    .await
    .map_err(|_| "SSH command timed out".to_string())?
    .map_err(|e| format!("failed to run ssh: {e}"))
}

async fn probe_remote_runtime(
    target: &ResolvedTarget,
    control_socket: &Path,
    borrowed_master: bool,
    control_persist: u64,
) -> Result<bool, String> {
    let relative_path = remote_runtime_relative_path();
    let command =
        format!("runtime=\"$HOME/{relative_path}\"; [ -x \"$runtime\" ] && \"$runtime\" version");
    let output = run_remote_command(
        target,
        control_socket,
        borrowed_master,
        control_persist,
        &command,
    )
    .await?;
    Ok(output.status.success()
        && String::from_utf8_lossy(&output.stdout).trim() == expected_remote_runtime_version())
}

async fn detect_remote_platform(
    target: &ResolvedTarget,
    control_socket: &Path,
    borrowed_master: bool,
    control_persist: u64,
) -> Result<&'static str, String> {
    let output = run_remote_command(
        target,
        control_socket,
        borrowed_master,
        control_persist,
        "uname -s; uname -m",
    )
    .await?;
    if !output.status.success() {
        return Err(format!(
            "failed to detect remote platform: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let os = lines
        .next()
        .ok_or_else(|| "remote uname did not report an operating system".to_string())?;
    let arch = lines
        .next()
        .ok_or_else(|| "remote uname did not report an architecture".to_string())?;
    normalize_remote_platform(os, arch)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn parse_sha256(contents: &str) -> Result<String, String> {
    let checksum = contents
        .split_whitespace()
        .next()
        .ok_or_else(|| "remote runtime checksum file is empty".to_string())?;
    if checksum.len() != 64
        || !checksum
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("remote runtime checksum is not lowercase SHA-256".to_string());
    }
    Ok(checksum.to_string())
}

fn verify_remote_runtime(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "remote runtime SHA-256 mismatch: expected {expected}, got {actual}"
        ))
    }
}

async fn download_bounded(url: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(REMOTE_RUNTIME_DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("create remote runtime download client: {e}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download {url}: {e}"))?;
    if response
        .content_length()
        .map(|length| length > max_bytes as u64)
        .unwrap_or(false)
    {
        return Err(format!("download exceeds {max_bytes} bytes: {url}"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download {url}: {e}"))?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("download exceeds {max_bytes} bytes: {url}"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_runtime_candidate(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect {}: {error}", path.display())),
    };
    if metadata.len() > MAX_REMOTE_RUNTIME_BYTES as u64 {
        return Err(format!(
            "remote runtime resource exceeds {MAX_REMOTE_RUNTIME_BYTES} bytes: {}",
            path.display()
        ));
    }
    tokio::fs::read(path)
        .await
        .map(Some)
        .map_err(|e| format!("read {}: {e}", path.display()))
}

async fn cache_downloaded_runtime(
    binary_path: &Path,
    checksum_path: &Path,
    bytes: &[u8],
    checksum: &str,
) -> Result<(), String> {
    let parent = binary_path
        .parent()
        .ok_or_else(|| "remote runtime cache path has no parent".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("create remote runtime cache {}: {e}", parent.display()))?;
    let temp_path = parent.join(format!(
        ".krypton-remote-{}-{}.tmp",
        std::process::id(),
        REMOTE_RUNTIME_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    tokio::fs::write(&temp_path, bytes)
        .await
        .map_err(|e| format!("write remote runtime cache {}: {e}", temp_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|e| format!("secure remote runtime cache {}: {e}", temp_path.display()))?;
    }
    if tokio::fs::try_exists(binary_path).await.unwrap_or(false) {
        tokio::fs::remove_file(binary_path).await.map_err(|e| {
            format!(
                "replace remote runtime cache {}: {e}",
                binary_path.display()
            )
        })?;
    }
    tokio::fs::rename(&temp_path, binary_path)
        .await
        .map_err(|e| {
            format!(
                "install remote runtime cache {}: {e}",
                binary_path.display()
            )
        })?;
    tokio::fs::write(checksum_path, format!("{checksum}\n"))
        .await
        .map_err(|e| format!("write remote runtime checksum cache: {e}"))
}

async fn resolve_local_runtime(app: &AppHandle, target: &str) -> Result<Vec<u8>, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir
            .join("remote-binaries")
            .join(target)
            .join("krypton-remote");
        if let Some(bytes) = read_runtime_candidate(&bundled).await? {
            return Ok(bytes);
        }
    }

    if local_runtime_target() == Some(target) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for profile in ["release", "debug"] {
            let candidate = manifest_dir
                .join("target")
                .join(profile)
                .join("krypton-remote");
            if let Some(bytes) = read_runtime_candidate(&candidate).await? {
                return Ok(bytes);
            }
        }
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("resolve app cache directory: {e}"))?
        .join("remote-runtime")
        .join(env!("CARGO_PKG_VERSION"))
        .join(target);
    let binary_path = cache_dir.join("krypton-remote");
    let checksum_path = cache_dir.join("krypton-remote.sha256");
    if let (Some(bytes), Ok(checksum_text)) = (
        read_runtime_candidate(&binary_path).await?,
        tokio::fs::read_to_string(&checksum_path).await,
    ) {
        if let Ok(checksum) = parse_sha256(&checksum_text) {
            if verify_remote_runtime(&bytes, &checksum).is_ok() {
                return Ok(bytes);
            }
        }
    }

    let binary_url = remote_runtime_release_url(target);
    let checksum_url = format!("{binary_url}.sha256");
    let checksum_bytes = download_bounded(&checksum_url, 4096).await?;
    let checksum_text = std::str::from_utf8(&checksum_bytes)
        .map_err(|_| "remote runtime checksum is not UTF-8".to_string())?;
    let checksum = parse_sha256(checksum_text)?;
    let bytes = download_bounded(&binary_url, MAX_REMOTE_RUNTIME_BYTES).await?;
    verify_remote_runtime(&bytes, &checksum)?;
    if let Err(error) =
        cache_downloaded_runtime(&binary_path, &checksum_path, &bytes, &checksum).await
    {
        log::warn!("Could not cache downloaded remote runtime: {error}");
    }
    Ok(bytes)
}

async fn upload_remote_runtime(
    target: &ResolvedTarget,
    control_socket: &Path,
    borrowed_master: bool,
    control_persist: u64,
    bytes: &[u8],
) -> Result<(), String> {
    let remote_command = remote_runtime_install_command();
    let mut command =
        configured_ssh_command(target, control_socket, borrowed_master, control_persist);
    command
        .arg(&target.destination)
        .arg(remote_command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start remote runtime upload: {e}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "SSH upload stdin missing".to_string())?;
    let result = tokio::time::timeout(
        Duration::from_secs(REMOTE_RUNTIME_DOWNLOAD_TIMEOUT_SECS),
        async {
            stdin
                .write_all(bytes)
                .await
                .map_err(|e| format!("upload remote runtime: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("finish remote runtime upload: {e}"))?;
            drop(stdin);
            let output = child
                .wait_with_output()
                .await
                .map_err(|e| format!("wait for remote runtime upload: {e}"))?;
            if output.status.success() {
                Ok(())
            } else {
                Err(format!(
                    "remote runtime upload failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        },
    )
    .await;
    result.map_err(|_| "remote runtime upload timed out".to_string())?
}

async fn ensure_remote_runtime(
    app: &AppHandle,
    target: &ResolvedTarget,
    control_socket: &Path,
    borrowed_master: bool,
    control_persist: u64,
) -> Result<String, String> {
    if probe_remote_runtime(target, control_socket, borrowed_master, control_persist).await? {
        return Ok(remote_runtime_relative_path());
    }
    let platform =
        detect_remote_platform(target, control_socket, borrowed_master, control_persist).await?;
    let bytes = resolve_local_runtime(app, platform).await?;
    upload_remote_runtime(
        target,
        control_socket,
        borrowed_master,
        control_persist,
        &bytes,
    )
    .await?;
    if !probe_remote_runtime(target, control_socket, borrowed_master, control_persist).await? {
        return Err("uploaded remote runtime did not pass its version probe".to_string());
    }
    Ok(remote_runtime_relative_path())
}

async fn close_owned_master(target: &ResolvedTarget, control_socket: &Path) {
    let mut command = Command::new("ssh");
    command.arg("-S").arg(control_socket).arg("-O").arg("exit");
    append_target_args(&mut command, target);
    let _ = command
        .arg(&target.destination)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

async fn start_remote_runtime(
    target: ResolvedTarget,
    runtime_id: String,
    app: AppHandle,
    control_persist: u64,
    registry: &RemoteHarnessRegistry,
) -> Result<RemoteHarnessWorkspace, String> {
    let (control_socket, borrowed_master) = select_control_socket(&target, &runtime_id).await?;
    let remote_runtime = match ensure_remote_runtime(
        &app,
        &target,
        &control_socket,
        borrowed_master,
        control_persist,
    )
    .await
    {
        Ok(path) => path,
        Err(error) => {
            if !borrowed_master {
                close_owned_master(&target, &control_socket).await;
            }
            return Err(error);
        }
    };
    let mut command =
        configured_ssh_command(&target, &control_socket, borrowed_master, control_persist);
    command
        .arg(&target.destination)
        .arg(format!("exec \"$HOME/{remote_runtime}\" serve --stdio"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if !borrowed_master {
                close_owned_master(&target, &control_socket).await;
            }
            return Err(format!("failed to run ssh: {error}"));
        }
    };
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ssh stdin missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ssh stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ssh stderr missing".to_string())?;
    let requested_workspace = RemoteWorkspace {
        path: target.project_dir.clone(),
    };
    let client = Arc::new(RemoteRuntimeClient {
        id: runtime_id.clone(),
        target: target.clone(),
        workspace: RwLock::new(requested_workspace.clone()),
        control_socket,
        borrowed_master,
        stdin: Mutex::new(Some(stdin)),
        child: Mutex::new(Some(child)),
        pending: Mutex::new(HashMap::new()),
        agents: Mutex::new(HashMap::new()),
        orphan_agent_events: Mutex::new(HashMap::new()),
        reverse_forward: Mutex::new(None),
        stderr: Mutex::new(String::new()),
        next_request_id: AtomicU64::new(1),
        disconnected: AtomicBool::new(false),
        app,
    });
    let (hello_tx, hello_rx) = oneshot::channel();
    tokio::spawn(run_runtime_reader(client.clone(), stdout, hello_tx));
    tokio::spawn(run_runtime_stderr(client.clone(), stderr));
    if let Err(error) = client
        .write_frame(&RuntimeFrame::Hello {
            protocol: PROTOCOL_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            workspace: requested_workspace,
            capabilities: Vec::new(),
        })
        .await
    {
        client.disconnected.store(true, Ordering::Relaxed);
        client.shutdown().await;
        return Err(error);
    }
    let hello_result = tokio::time::timeout(
        Duration::from_secs(target.connect_timeout_seconds),
        hello_rx,
    )
    .await;
    let hello = match hello_result {
        Ok(Ok(Ok(workspace))) => workspace,
        Ok(Ok(Err(error))) => {
            client.disconnected.store(true, Ordering::Relaxed);
            client.shutdown().await;
            return Err(error);
        }
        Ok(Err(_)) => {
            client.disconnected.store(true, Ordering::Relaxed);
            client.shutdown().await;
            return Err("remote runtime closed before hello after bootstrap".to_string());
        }
        Err(_) => {
            client.disconnected.store(true, Ordering::Relaxed);
            client.shutdown().await;
            return Err("remote runtime hello timed out after bootstrap".to_string());
        }
    };
    if let Ok(mut workspace) = client.workspace.write() {
        *workspace = hello.clone();
    }
    registry.insert(runtime_id.clone(), client.clone());
    client.emit_state("connected", None);
    Ok(RemoteHarnessWorkspace {
        runtime_id,
        source: target.source,
        profile: target.profile,
        user: target.user,
        host: target.host,
        port: target.port,
        path: hello.path,
        borrowed_master,
    })
}

#[tauri::command]
pub async fn remote_harness_reconnect(
    runtime_id: String,
    app: AppHandle,
    ssh_manager: State<'_, Arc<SshManager>>,
    registry: State<'_, Arc<RemoteHarnessRegistry>>,
) -> Result<RemoteHarnessWorkspace, String> {
    let previous = registry
        .remove(&runtime_id)
        .ok_or_else(|| format!("unknown remote Harness: {runtime_id}"))?;
    let target = previous.target.clone();
    previous.shutdown().await;
    let result = start_remote_runtime(
        target,
        runtime_id.clone(),
        app,
        ssh_manager.control_persist(),
        &registry,
    )
    .await;
    if result.is_err() {
        registry.insert(runtime_id, previous);
    }
    result
}

#[tauri::command]
pub async fn remote_harness_forward_memory(
    runtime_id: String,
    local_port: u16,
    registry: State<'_, Arc<RemoteHarnessRegistry>>,
) -> Result<u16, String> {
    let client = registry
        .get(&runtime_id)
        .ok_or_else(|| format!("unknown remote Harness: {runtime_id}"))?;
    client.open_reverse_forward(local_port).await
}

#[tauri::command]
pub async fn remote_harness_request(
    runtime_id: String,
    method: String,
    params: Value,
    registry: State<'_, Arc<RemoteHarnessRegistry>>,
) -> Result<Value, String> {
    let method = parse_workspace_method(&method)?;
    let client = registry
        .get(&runtime_id)
        .ok_or_else(|| format!("unknown remote Harness: {runtime_id}"))?;
    client.request(method, params).await
}

#[tauri::command]
pub async fn remote_harness_disconnect(
    runtime_id: String,
    registry: State<'_, Arc<RemoteHarnessRegistry>>,
) -> Result<(), String> {
    if let Some(client) = registry.remove(&runtime_id) {
        client.shutdown().await;
    }
    Ok(())
}

async fn resolve_target(
    launch: RemoteHarnessLaunch,
    pty_manager: &PtyManager,
    ssh_manager: &SshManager,
    config: &RwLock<KryptonConfig>,
) -> Result<ResolvedTarget, String> {
    let mut target = match launch {
        RemoteHarnessLaunch::Profile { profile } => {
            let matches = config
                .read()
                .map(|config| {
                    config
                        .acp_harness
                        .remote_profiles
                        .iter()
                        .filter(|candidate| candidate.name == profile)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let profile_config = match matches.as_slice() {
                [profile_config] => profile_config.clone(),
                [] => return Err(format!("unknown remote profile: {profile}")),
                _ => return Err(format!("duplicate remote profile name: {profile}")),
            };
            validate_profile(&profile_config)?;
            ResolvedTarget {
                source: "profile".to_string(),
                profile: Some(profile_config.name),
                destination: profile_config.host.clone(),
                user: String::new(),
                host: profile_config.host,
                port: 22,
                project_dir: profile_config.project_dir,
                connect_timeout_seconds: profile_config.connect_timeout_seconds.max(1),
                extra_args: Vec::new(),
                requested_socket: None,
            }
        }
        RemoteHarnessLaunch::FocusedSsh {
            terminal_session_id,
            project_dir,
        } => {
            let info = ssh_manager
                .detect(terminal_session_id, pty_manager)
                .ok_or_else(|| "focused terminal is not an active SSH session".to_string())?;
            validate_ssh_identity(&info.user, &info.host)?;
            let project_dir = project_dir
                .filter(|path| !path.trim().is_empty())
                .or_else(|| ssh_manager.get_remote_cwd(terminal_session_id))
                .ok_or_else(|| {
                    "remote project path is required (OSC 7 did not report a CWD)".to_string()
                })?;
            let extra_args = safe_extra_args(&info);
            ResolvedTarget {
                source: "focused_ssh".to_string(),
                profile: None,
                destination: format!("{}@{}", info.user, info.host),
                user: info.user,
                host: info.host,
                port: info.port,
                project_dir,
                connect_timeout_seconds: DEFAULT_CONNECT_TIMEOUT_SECS,
                extra_args,
                requested_socket: info.active_control_socket.map(expand_home),
            }
        }
    };
    if !Path::new(&target.project_dir).is_absolute() {
        return Err("remote project_dir must be absolute".to_string());
    }
    let ssh_config = resolve_ssh_config(&target).await?;
    target.user = ssh_config
        .get("user")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or(target.user);
    target.host = ssh_config
        .get("hostname")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or(target.host);
    target.port = ssh_config
        .get("port")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(target.port);
    if target.requested_socket.is_none() {
        target.requested_socket = ssh_config
            .get("controlpath")
            .filter(|value| value.as_str() != "none" && !value.contains('%'))
            .map(|value| expand_home(value.clone()));
    }
    if ssh_config
        .get("forwardagent")
        .map(|value| value == "yes")
        .unwrap_or(false)
    {
        log::warn!(
            "Remote Harness target {} has ForwardAgent enabled in SSH config",
            target.destination
        );
    }
    Ok(target)
}

async fn resolve_ssh_config(target: &ResolvedTarget) -> Result<HashMap<String, String>, String> {
    let mut command = Command::new("ssh");
    command.arg("-G");
    append_target_args(&mut command, target);
    let output = command
        .arg(&target.destination)
        .output()
        .await
        .map_err(|e| format!("ssh -G failed to run: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ssh -G failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(key, value)| (key.to_string(), value.trim().to_string()))
        .collect())
}

fn validate_profile(profile: &RemoteHarnessProfile) -> Result<(), String> {
    let valid_name = !profile.name.trim().is_empty();
    let valid_host = !profile.host.starts_with('-')
        && !profile.host.is_empty()
        && profile
            .host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if !valid_name {
        return Err("remote profile name must not be empty".to_string());
    }
    if !valid_host {
        return Err(format!("invalid SSH host alias: {}", profile.host));
    }
    if !Path::new(&profile.project_dir).is_absolute() {
        return Err(format!(
            "remote profile {} project_dir must be absolute",
            profile.name
        ));
    }
    Ok(())
}

fn validate_ssh_identity(user: &str, host: &str) -> Result<(), String> {
    let user_valid = !user.is_empty()
        && !user.starts_with('-')
        && user
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    let host_valid = !host.is_empty()
        && !host.starts_with('-')
        && host.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ':' | '[' | ']')
        });
    if !user_valid || !host_valid {
        return Err("focused SSH target contains an unsafe user or host".to_string());
    }
    Ok(())
}

fn safe_extra_args(info: &SshConnectionInfo) -> Vec<String> {
    let mut out = Vec::new();
    let mut args = info.extra_args.iter();
    while let Some(flag) = args.next() {
        let Some(value) = args.next() else {
            break;
        };
        if matches!(flag.as_str(), "-i" | "-J") {
            out.push(flag.clone());
            out.push(value.clone());
        }
    }
    out
}

fn append_target_args(command: &mut Command, target: &ResolvedTarget) {
    if target.port != 22 {
        command.arg("-p").arg(target.port.to_string());
    }
    command.args(&target.extra_args);
}

async fn select_control_socket(
    target: &ResolvedTarget,
    runtime_id: &str,
) -> Result<(PathBuf, bool), String> {
    if let Some(socket) = target.requested_socket.as_ref() {
        if check_master(target, socket).await {
            return Ok((socket.clone(), true));
        }
    }
    let base = crate::config::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("ssh-sockets");
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("create SSH socket directory {}: {e}", base.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("secure SSH socket directory {}: {e}", base.display()))?;
    }
    let mut hasher = DefaultHasher::new();
    target.destination.hash(&mut hasher);
    target.port.hash(&mut hasher);
    runtime_id.hash(&mut hasher);
    Ok((base.join(format!("remote-{:016x}", hasher.finish())), false))
}

async fn check_master(target: &ResolvedTarget, socket: &Path) -> bool {
    let mut command = Command::new("ssh");
    command.arg("-S").arg(socket).arg("-O").arg("check");
    append_target_args(&mut command, target);
    command
        .arg(&target.destination)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

fn expand_home(path: String) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

async fn run_runtime_reader<R>(
    client: Arc<RemoteRuntimeClient>,
    reader: R,
    hello: oneshot::Sender<Result<RemoteWorkspace, String>>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    let mut hello = Some(hello);
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                if let Some(hello) = hello.take() {
                    let _ = hello.send(Err(format!("remote runtime read failed: {error}")));
                }
                break;
            }
        };
        if line.len() > MAX_FRAME_BYTES {
            if let Some(hello) = hello.take() {
                let _ = hello.send(Err(format!("remote frame exceeds {MAX_FRAME_BYTES} bytes")));
            }
            break;
        }
        let frame = match serde_json::from_str::<RuntimeFrame>(&line) {
            Ok(frame) => frame,
            Err(error) => {
                if let Some(hello) = hello.take() {
                    let _ = hello.send(Err(format!("invalid remote frame: {error}")));
                }
                break;
            }
        };
        match frame {
            RuntimeFrame::Hello {
                protocol,
                workspace,
                ..
            } => {
                let result = if protocol == PROTOCOL_VERSION {
                    Ok(workspace)
                } else {
                    Err(format!(
                        "remote protocol mismatch: expected {PROTOCOL_VERSION}, got {protocol}"
                    ))
                };
                if let Some(hello) = hello.take() {
                    let _ = hello.send(result);
                }
            }
            RuntimeFrame::Response { id, result, error } => {
                if let Some(tx) = client.pending.lock().await.remove(&id) {
                    let response = match error {
                        Some(error) => Err(format!("{}: {}", error.code, error.message)),
                        None => Ok(result.unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(response);
                }
            }
            RuntimeFrame::Event { topic, payload } => {
                let agent_id = payload.get("agentId").and_then(Value::as_u64);
                match (topic.as_str(), agent_id) {
                    ("agent_stdout", Some(agent_id)) => {
                        if let Some(line) = payload.get("line").and_then(Value::as_str) {
                            client
                                .dispatch_agent_event(
                                    agent_id,
                                    RemoteAgentEvent::Stdout(line.to_string()),
                                )
                                .await;
                        }
                    }
                    ("agent_stderr", Some(agent_id)) => {
                        if let Some(line) = payload.get("line").and_then(Value::as_str) {
                            client
                                .dispatch_agent_event(
                                    agent_id,
                                    RemoteAgentEvent::Stderr(line.to_string()),
                                )
                                .await;
                        }
                    }
                    ("agent_exit", Some(agent_id)) => {
                        client
                            .dispatch_agent_event(
                                agent_id,
                                RemoteAgentEvent::Exit(
                                    payload
                                        .get("code")
                                        .and_then(Value::as_i64)
                                        .map(|v| v as i32),
                                ),
                            )
                            .await;
                    }
                    _ => {}
                }
            }
            RuntimeFrame::Request { .. } => break,
        }
    }
    if let Some(hello) = hello.take() {
        let stderr = client.stderr.lock().await.trim().to_string();
        let detail = if stderr.is_empty() {
            "remote runtime closed before hello".to_string()
        } else {
            format!("remote runtime closed before hello: {stderr}")
        };
        let _ = hello.send(Err(detail));
    }
    let stderr = client.stderr.lock().await.trim().to_string();
    let reason = if stderr.is_empty() {
        "SSH/runtime stream closed".to_string()
    } else {
        format!("SSH/runtime stream closed: {stderr}")
    };
    client.finalize_disconnect(reason).await;
}

async fn run_runtime_stderr<R>(client: Arc<RemoteRuntimeClient>, reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        client.append_stderr(&line).await;
    }
}

fn parse_workspace_method(method: &str) -> Result<RemoteMethod, String> {
    match method {
        "canonicalize" => Ok(RemoteMethod::WorkspaceCanonicalize),
        "overlay_write" => Ok(RemoteMethod::RuntimeOverlayWrite),
        "overlay_remove" => Ok(RemoteMethod::RuntimeOverlayRemove),
        "read" => Ok(RemoteMethod::WorkspaceRead),
        "write" => Ok(RemoteMethod::WorkspaceWrite),
        "remove" => Ok(RemoteMethod::WorkspaceRemove),
        "stat" => Ok(RemoteMethod::WorkspaceStat),
        "read_dir" => Ok(RemoteMethod::WorkspaceReadDir),
        "run" => Ok(RemoteMethod::WorkspaceRun),
        _ => Err(format!("unsupported remote workspace method: {method}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_platform_normalization_is_allowlisted() {
        assert_eq!(
            normalize_remote_platform("Darwin\n", "arm64\n").unwrap(),
            "aarch64-apple-darwin"
        );
        assert_eq!(
            normalize_remote_platform("Linux", "amd64").unwrap(),
            "x86_64-unknown-linux-gnu"
        );
        assert!(normalize_remote_platform("FreeBSD", "x86_64").is_err());
        assert!(normalize_remote_platform("Linux", "riscv64").is_err());
    }

    #[test]
    fn release_asset_and_cache_paths_are_versioned() {
        assert_eq!(
            remote_runtime_relative_path(),
            format!(
                ".cache/krypton/remote/{}/krypton-remote",
                env!("CARGO_PKG_VERSION")
            )
        );
        assert_eq!(
            remote_runtime_release_url("aarch64-apple-darwin"),
            format!(
                "https://github.com/wk-j/krypton/releases/download/v{}/krypton-remote-aarch64-apple-darwin",
                env!("CARGO_PKG_VERSION")
            )
        );
    }

    #[test]
    fn checksum_parser_and_verifier_reject_bad_assets() {
        let bytes = b"krypton-remote";
        let checksum = sha256_hex(bytes);
        assert_eq!(
            parse_sha256(&format!("{checksum}  asset\n")).unwrap(),
            checksum
        );
        assert!(verify_remote_runtime(bytes, &checksum).is_ok());
        assert!(parse_sha256("ABC").is_err());
        assert!(verify_remote_runtime(b"tampered", &checksum).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn install_command_writes_versioned_executable_atomically() {
        use std::os::unix::fs::PermissionsExt;

        let home = std::env::temp_dir().join(format!(
            "krypton-bootstrap-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::create_dir_all(&home).await.unwrap();
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(remote_runtime_install_command())
            .env("HOME", &home)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"test-runtime").await.unwrap();
        stdin.shutdown().await.unwrap();
        drop(stdin);
        assert!(child.wait().await.unwrap().success());

        let installed = home.join(remote_runtime_relative_path());
        assert_eq!(tokio::fs::read(&installed).await.unwrap(), b"test-runtime");
        assert_eq!(
            tokio::fs::metadata(&installed)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        tokio::fs::remove_dir_all(home).await.unwrap();
    }

    #[test]
    fn profile_validation_rejects_option_like_host() {
        let profile = RemoteHarnessProfile {
            name: "bad".into(),
            host: "-oProxyCommand=bad".into(),
            project_dir: "/srv/repo".into(),
            connect_timeout_seconds: 15,
        };
        assert!(validate_profile(&profile).is_err());
    }

    #[test]
    fn safe_extra_args_keep_only_identity_and_jump_host() {
        let info = SshConnectionInfo {
            user: "alice".into(),
            host: "buildbox".into(),
            port: 22,
            control_socket: None,
            active_control_socket: None,
            extra_args: vec![
                "-i".into(),
                "/tmp/key".into(),
                "-o".into(),
                "ForwardAgent=yes".into(),
                "-J".into(),
                "jump".into(),
            ],
        };
        assert_eq!(safe_extra_args(&info), vec!["-i", "/tmp/key", "-J", "jump"]);
    }

    #[test]
    fn workspace_method_allowlist_is_narrow() {
        assert_eq!(
            parse_workspace_method("read").unwrap(),
            RemoteMethod::WorkspaceRead
        );
        assert!(parse_workspace_method("agent_spawn").is_err());
    }

    #[test]
    fn focused_ssh_identity_rejects_option_like_user() {
        assert!(validate_ssh_identity("-oProxyCommand", "host").is_err());
        assert!(validate_ssh_identity("alice", "2001:db8::1").is_ok());
    }
}
