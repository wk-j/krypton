//! App-owned SSH targets for local ACP Harness lanes (spec 311).

use crate::util::emit::EmitExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{oneshot, watch};

const SCHEMA_VERSION: u32 = 1;
const OUTPUT_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerProfile {
    pub id: String,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_cwd: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct ProfileFile {
    schema_version: u32,
    computers: Vec<StoredProfile>,
}

#[derive(Deserialize, Serialize)]
struct StoredProfile {
    id: String,
    host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_cwd: Option<String>,
}

impl From<StoredProfile> for ComputerProfile {
    fn from(value: StoredProfile) -> Self {
        Self {
            id: value.id,
            host: value.host,
            user: value.user,
            port: value.port,
            default_cwd: value.default_cwd,
        }
    }
}

impl From<&ComputerProfile> for StoredProfile {
    fn from(value: &ComputerProfile) -> Self {
        Self {
            id: value.id.clone(),
            host: value.host.clone(),
            user: value.user.clone(),
            port: value.port,
            default_cwd: value.default_cwd.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Configured,
    Connecting,
    Connected,
    Disconnected,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatus {
    pub profile: ComputerProfile,
    pub state: ConnectionState,
    pub resolved_target: Option<String>,
    pub active_commands: usize,
    pub last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerList {
    pub revision: String,
    pub computers: Vec<ComputerStatus>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerExecRequest {
    pub computer_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerExecResult {
    pub computer_id: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub outcome: &'static str,
}

struct Entry {
    status: ComputerStatus,
    child: Option<Child>,
    socket: Option<PathBuf>,
    cancel: Option<watch::Sender<bool>>,
}

struct Inner {
    entries: HashMap<String, Entry>,
    revision: String,
    load_error: Option<String>,
}

#[derive(Clone)]
struct LaneBinding {
    harness_id: String,
    lane_label: String,
    spawn_epoch: u64,
    session: Option<u64>,
    cancel: watch::Sender<bool>,
}

struct Approval {
    capability: String,
    reply: oneshot::Sender<bool>,
}

pub struct ConnectedComputerManager {
    path: PathBuf,
    socket_dir: PathBuf,
    inner: Mutex<Inner>,
    capabilities: Mutex<HashMap<String, LaneBinding>>,
    approvals: Mutex<HashMap<String, Approval>>,
    app: Mutex<Option<AppHandle>>,
    stopped: AtomicBool,
}

impl Default for ConnectedComputerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectedComputerManager {
    pub fn new() -> Self {
        let config_dir =
            crate::config::config_dir().unwrap_or_else(|| std::env::temp_dir().join("krypton"));
        Self::new_at(
            config_dir.join("connected-computers.toml"),
            config_dir.join("ssh-sockets").join("connected-computers"),
        )
    }

    fn new_at(path: PathBuf, socket_dir: PathBuf) -> Self {
        let (entries, revision, load_error) = match read_profiles(&path) {
            Ok((profiles, revision)) => (
                profiles
                    .into_iter()
                    .map(|profile| {
                        let id = profile.id.clone();
                        (
                            id,
                            Entry {
                                status: ComputerStatus {
                                    profile,
                                    state: ConnectionState::Configured,
                                    resolved_target: None,
                                    active_commands: 0,
                                    last_error: None,
                                },
                                child: None,
                                socket: None,
                                cancel: None,
                            },
                        )
                    })
                    .collect(),
                revision,
                None,
            ),
            Err(error) => (HashMap::new(), String::new(), Some(error)),
        };
        Self {
            path,
            socket_dir,
            inner: Mutex::new(Inner {
                entries,
                revision,
                load_error,
            }),
            capabilities: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            app: Mutex::new(None),
            stopped: AtomicBool::new(false),
        }
    }

    pub fn bind_app(self: &Arc<Self>, app: AppHandle) {
        *self.app.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let Some(manager) = weak.upgrade() else { break };
            if manager.stopped.load(Ordering::Relaxed) {
                break;
            }
            manager.poll_exited_children();
        });
    }

    fn poll_exited_children(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        for entry in inner.entries.values_mut() {
            if entry.status.state != ConnectionState::Connected {
                continue;
            }
            let exited = match entry.child.as_mut() {
                Some(child) => !matches!(child.try_wait(), Ok(None)),
                None => true,
            };
            if !exited {
                continue;
            }
            entry.status.state = ConnectionState::Disconnected;
            entry.status.last_error = Some("SSH connection closed".to_string());
            if let Some(mut child) = entry.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            if let Some(socket) = entry.socket.take() {
                let _ = fs::remove_file(socket);
            }
            if let Some(cancel) = entry.cancel.take() {
                let _ = cancel.send(true);
            }
            changed = true;
        }
        drop(inner);
        if changed {
            self.emit_status();
        }
    }

    fn emit_status(&self) {
        if let Some(app) = self.app.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            app.emit_or_log("computer-status-changed", ());
        }
    }

    pub fn list(&self) -> Result<ComputerList, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(error) = &inner.load_error {
            return Err(error.clone());
        }
        let mut changed = false;
        for entry in inner.entries.values_mut() {
            if entry.status.state == ConnectionState::Connected {
                let alive = entry
                    .child
                    .as_mut()
                    .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
                    && entry
                        .socket
                        .as_ref()
                        .is_some_and(|socket| check_master(&entry.status.profile, socket));
                if !alive {
                    changed = true;
                    entry.status.state = ConnectionState::Disconnected;
                    entry.status.last_error = Some("SSH connection closed".to_string());
                    if let Some(mut child) = entry.child.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    if let Some(socket) = entry.socket.take() {
                        let _ = fs::remove_file(socket);
                    }
                    if let Some(cancel) = entry.cancel.take() {
                        let _ = cancel.send(true);
                    }
                }
            }
        }
        let mut computers: Vec<_> = inner
            .entries
            .values()
            .map(|entry| entry.status.clone())
            .collect();
        computers.sort_by(|a, b| a.profile.id.cmp(&b.profile.id));
        let list = ComputerList {
            revision: inner.revision.clone(),
            computers,
        };
        drop(inner);
        if changed {
            self.emit_status();
        }
        Ok(list)
    }

    pub fn save(
        &self,
        profile: ComputerProfile,
        expected_revision: &str,
    ) -> Result<ComputerList, String> {
        validate_profile(&profile)?;
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        check_revision(&self.path, &inner.revision, expected_revision)?;
        if inner.load_error.is_some() {
            return Err("Reload the invalid profile file before saving".to_string());
        }
        if inner.entries.get(&profile.id).is_some_and(|entry| {
            entry.status.state == ConnectionState::Connected
                || entry.status.state == ConnectionState::Connecting
                || entry.status.active_commands > 0
        }) {
            return Err("Disconnect this computer before editing it".to_string());
        }
        let id = profile.id.clone();
        let old = inner.entries.insert(
            id.clone(),
            Entry {
                status: ComputerStatus {
                    profile,
                    state: ConnectionState::Configured,
                    resolved_target: None,
                    active_commands: 0,
                    last_error: None,
                },
                child: None,
                socket: None,
                cancel: None,
            },
        );
        if let Err(error) = persist(&self.path, &mut inner) {
            if let Some(old) = old {
                inner.entries.insert(old.status.profile.id.clone(), old);
            } else {
                inner.entries.remove(&id);
            }
            return Err(error);
        }
        drop(inner);
        self.emit_status();
        self.list()
    }

    pub fn delete(&self, id: &str, expected_revision: &str) -> Result<ComputerList, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        check_revision(&self.path, &inner.revision, expected_revision)?;
        if inner.entries.get(id).is_some_and(|entry| {
            entry.status.state == ConnectionState::Connected
                || entry.status.state == ConnectionState::Connecting
                || entry.status.active_commands > 0
        }) {
            return Err("Disconnect this computer before removing it".to_string());
        }
        let removed = inner
            .entries
            .remove(id)
            .ok_or_else(|| format!("Unknown computer: {id}"))?;
        if let Err(error) = persist(&self.path, &mut inner) {
            inner.entries.insert(id.to_string(), removed);
            return Err(error);
        }
        drop(inner);
        self.emit_status();
        self.list()
    }

    pub fn reload(&self) -> Result<ComputerList, String> {
        let (profiles, revision) = read_profiles(&self.path)?;
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.entries.values().any(|entry| {
            entry.status.state == ConnectionState::Connected
                || entry.status.state == ConnectionState::Connecting
                || entry.status.active_commands > 0
        }) {
            return Err(
                "Disconnect all computers before reloading an externally changed profile file"
                    .to_string(),
            );
        }
        inner.entries = profiles
            .into_iter()
            .map(|profile| {
                let id = profile.id.clone();
                (
                    id,
                    Entry {
                        status: ComputerStatus {
                            profile,
                            state: ConnectionState::Configured,
                            resolved_target: None,
                            active_commands: 0,
                            last_error: None,
                        },
                        child: None,
                        socket: None,
                        cancel: None,
                    },
                )
            })
            .collect();
        inner.revision = revision;
        inner.load_error = None;
        drop(inner);
        self.emit_status();
        self.list()
    }

    pub fn connect(&self, id: &str) -> Result<ComputerList, String> {
        self.list()?;
        let profile = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let entry = inner
                .entries
                .get_mut(id)
                .ok_or_else(|| format!("Unknown computer: {id}"))?;
            if entry.status.state == ConnectionState::Connected {
                return Err("Already connected".to_string());
            }
            if entry.status.state == ConnectionState::Connecting {
                return Err("Connection already in progress".to_string());
            }
            if entry.status.active_commands > 0 {
                return Err("Wait for canceled commands to finish before reconnecting".to_string());
            }
            entry.status.state = ConnectionState::Connecting;
            entry.status.last_error = None;
            entry.status.profile.clone()
        };
        self.emit_status();
        let result = self.open_master(&profile);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = inner
            .entries
            .get_mut(id)
            .ok_or_else(|| format!("Unknown computer: {id}"))?;
        match result {
            Ok((child, socket, target)) => {
                let (cancel, _) = watch::channel(false);
                entry.child = Some(child);
                entry.socket = Some(socket);
                entry.cancel = Some(cancel);
                entry.status.resolved_target = Some(target);
                entry.status.state = ConnectionState::Connected;
            }
            Err(error) => {
                entry.status.state = ConnectionState::Disconnected;
                entry.status.last_error = Some(error.clone());
                drop(inner);
                self.emit_status();
                return Err(error);
            }
        }
        drop(inner);
        self.emit_status();
        self.list()
    }

    fn open_master(&self, profile: &ComputerProfile) -> Result<(Child, PathBuf, String), String> {
        fs::create_dir_all(&self.socket_dir).map_err(|e| format!("SSH socket directory: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.socket_dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("SSH socket permissions: {e}"))?;
        }
        let socket = self
            .socket_dir
            .join(format!("{}.sock", &revision(profile.id.as_bytes())[..16]));
        let _ = fs::remove_file(&socket);
        let target = resolve_target(profile)?;
        let mut cmd = StdCommand::new("ssh");
        cmd.arg("-M")
            .arg("-N")
            .arg("-T")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=10")
            .arg("-o")
            .arg("ControlMaster=yes")
            .arg("-o")
            .arg(format!("ControlPath={}", socket.display()))
            .args(profile_overrides(profile))
            .arg(&profile.host)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Start SSH: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if check_master(profile, &socket) {
                return Ok((child, socket, target));
            }
            if child
                .try_wait()
                .map_err(|e| format!("SSH status: {e}"))?
                .is_some()
            {
                let diagnostic = child
                    .wait_with_output()
                    .ok()
                    .map(|output| {
                        String::from_utf8_lossy(&output.stderr)
                            .trim()
                            .chars()
                            .take(2048)
                            .collect::<String>()
                    })
                    .unwrap_or_default();
                let _ = fs::remove_file(&socket);
                return Err(format!("SSH connection failed for {target}: {diagnostic}. Check authentication and host-key trust"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let diagnostic = child
            .wait_with_output()
            .ok()
            .map(|output| {
                String::from_utf8_lossy(&output.stderr)
                    .trim()
                    .chars()
                    .take(2048)
                    .collect::<String>()
            })
            .unwrap_or_default();
        let _ = fs::remove_file(&socket);
        Err(format!(
            "SSH connection timed out for {target}: {diagnostic}"
        ))
    }

    pub fn disconnect(&self, id: &str) -> Result<ComputerList, String> {
        let (profile, socket, mut child) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let entry = inner
                .entries
                .get_mut(id)
                .ok_or_else(|| format!("Unknown computer: {id}"))?;
            if entry.status.state == ConnectionState::Connecting {
                return Err("Wait for the connection attempt to finish".to_string());
            }
            entry.status.state = ConnectionState::Disconnected;
            if let Some(cancel) = entry.cancel.take() {
                let _ = cancel.send(true);
            }
            (
                entry.status.profile.clone(),
                entry.socket.take(),
                entry.child.take(),
            )
        };
        if let Some(socket) = socket {
            let _ = StdCommand::new("ssh")
                .arg("-S")
                .arg(&socket)
                .arg("-O")
                .arg("exit")
                .args(profile_overrides(&profile))
                .arg(&profile.host)
                .output();
            let _ = fs::remove_file(socket);
        }
        if let Some(ref mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.emit_status();
        self.list()
    }

    pub fn issue_capability(
        &self,
        harness_id: String,
        lane_label: String,
        spawn_epoch: u64,
    ) -> Result<String, String> {
        if harness_id.is_empty() || lane_label.is_empty() {
            return Err("Missing lane identity".to_string());
        }
        let token = random_hex()?;
        let (cancel, _) = watch::channel(false);
        let mut caps = self.capabilities.lock().unwrap_or_else(|e| e.into_inner());
        caps.retain(|_, binding| {
            if binding.harness_id == harness_id && binding.lane_label == lane_label {
                let _ = binding.cancel.send(true);
                false
            } else {
                true
            }
        });
        caps.insert(
            token.clone(),
            LaneBinding {
                harness_id,
                lane_label,
                spawn_epoch,
                session: None,
                cancel,
            },
        );
        Ok(token)
    }

    pub fn bind_session(&self, token: &str, session: u64) -> Result<(), String> {
        let mut caps = self.capabilities.lock().unwrap_or_else(|e| e.into_inner());
        let binding = caps
            .get_mut(token)
            .ok_or_else(|| "Computer lane capability was revoked".to_string())?;
        binding.session = Some(session);
        Ok(())
    }

    pub fn revoke_session(&self, session: u64) {
        let revoked: Vec<String> = {
            let mut caps = self.capabilities.lock().unwrap_or_else(|e| e.into_inner());
            let tokens = caps
                .iter()
                .filter(|(_, binding)| binding.session == Some(session))
                .map(|(token, _)| token.clone())
                .collect::<Vec<_>>();
            for token in &tokens {
                if let Some(binding) = caps.remove(token) {
                    let _ = binding.cancel.send(true);
                }
            }
            tokens
        };
        self.reject_approvals(&revoked);
    }

    pub fn revoke_harness(&self, harness_id: &str) {
        let revoked: Vec<String> = {
            let mut caps = self.capabilities.lock().unwrap_or_else(|e| e.into_inner());
            let tokens = caps
                .iter()
                .filter(|(_, binding)| binding.harness_id == harness_id)
                .map(|(token, _)| token.clone())
                .collect::<Vec<_>>();
            for token in &tokens {
                if let Some(binding) = caps.remove(token) {
                    let _ = binding.cancel.send(true);
                }
            }
            tokens
        };
        self.reject_approvals(&revoked);
    }

    fn reject_approvals(&self, tokens: &[String]) {
        let mut approvals = self.approvals.lock().unwrap_or_else(|e| e.into_inner());
        let ids = approvals
            .iter()
            .filter(|(_, pending)| tokens.contains(&pending.capability))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(pending) = approvals.remove(&id) {
                let _ = pending.reply.send(false);
            }
            self.emit_approval_closed(&id);
        }
    }

    pub fn valid_capability(
        &self,
        token: &str,
        harness_id: Option<&str>,
        lane_label: Option<&str>,
    ) -> bool {
        self.capabilities
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .is_some_and(|binding| {
                binding.session.is_some()
                    && harness_id.map_or(true, |value| value == binding.harness_id)
                    && lane_label.map_or(true, |value| value == binding.lane_label)
            })
    }

    fn binding(&self, token: &str) -> Result<LaneBinding, String> {
        self.capabilities
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .filter(|binding| binding.session.is_some())
            .cloned()
            .ok_or_else(|| "Computer lane capability is invalid or expired".to_string())
    }

    pub fn decide(&self, request_id: &str, accept: bool) -> Result<(), String> {
        let pending = self
            .approvals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id)
            .ok_or_else(|| "Command request expired".to_string())?;
        let _ = pending.reply.send(accept);
        Ok(())
    }

    fn emit_approval_closed(&self, request_id: &str) {
        if let Some(app) = self.app.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            app.emit_or_log(
                "computer-command-approval-closed",
                serde_json::json!({ "requestId": request_id }),
            );
        }
    }

    pub async fn exec(
        &self,
        token: &str,
        request: ComputerExecRequest,
    ) -> Result<ComputerExecResult, String> {
        let binding = self.binding(token)?;
        let mut lane_cancel_rx = binding.cancel.subscribe();
        self.list()?;
        if request.command.is_empty() || request.command.len() > 16 * 1024 {
            return Err("Command must be 1–16384 bytes".to_string());
        }
        if request.command.contains('\0') {
            return Err("Command contains NUL".to_string());
        }
        let timeout = request.timeout_seconds.unwrap_or(120);
        if !(1..=600).contains(&timeout) {
            return Err("timeoutSeconds must be 1–600".to_string());
        }
        let (profile, target) = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let entry = inner
                .entries
                .get(&request.computer_id)
                .ok_or_else(|| "Unknown computer".to_string())?;
            if entry.status.state != ConnectionState::Connected {
                return Err("Computer is disconnected".to_string());
            }
            (
                entry.status.profile.clone(),
                entry
                    .status
                    .resolved_target
                    .clone()
                    .unwrap_or_else(|| entry.status.profile.host.clone()),
            )
        };
        let cwd = request.cwd.clone().or_else(|| profile.default_cwd.clone());
        if cwd
            .as_deref()
            .is_some_and(|path| !Path::new(path).is_absolute() || path.contains('\0'))
        {
            return Err("cwd must be an absolute remote path".to_string());
        }
        let request_id = random_hex()?;
        let (tx, rx) = oneshot::channel();
        self.approvals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                request_id.clone(),
                Approval {
                    capability: token.to_string(),
                    reply: tx,
                },
            );
        let app = self
            .app
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| "Krypton UI is unavailable".to_string())?;
        app.emit_or_log(
            "computer-command-approval",
            serde_json::json!({
                "requestId": request_id, "harnessId": binding.harness_id,
                "laneLabel": binding.lane_label, "spawnEpoch": binding.spawn_epoch,
                "computerId": request.computer_id, "target": target,
                "command": request.command, "cwd": cwd,
            }),
        );
        let approved = match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(value)) => value,
            _ => false,
        };
        self.approvals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&request_id);
        self.emit_approval_closed(&request_id);
        if !approved {
            return Err("Remote command declined or approval expired".to_string());
        }
        self.binding(token)?;
        let (socket, mut disconnect_rx) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let total = inner
                .entries
                .values()
                .map(|entry| entry.status.active_commands)
                .sum::<usize>();
            let entry = inner
                .entries
                .get_mut(&request.computer_id)
                .ok_or_else(|| "Unknown computer".to_string())?;
            if entry.status.state != ConnectionState::Connected {
                return Err("Computer disconnected while awaiting approval".to_string());
            }
            if total >= 4 || entry.status.active_commands >= 2 {
                return Err("Remote command capacity is busy".to_string());
            }
            let socket = entry
                .socket
                .clone()
                .ok_or_else(|| "SSH socket is unavailable".to_string())?;
            if !check_master(&profile, &socket) {
                entry.status.state = ConnectionState::Disconnected;
                entry.status.last_error = Some("SSH connection closed".to_string());
                if let Some(cancel) = entry.cancel.take() {
                    let _ = cancel.send(true);
                }
                if let Some(mut child) = entry.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                entry.socket.take();
                let _ = fs::remove_file(&socket);
                drop(inner);
                self.emit_status();
                return Err("SSH connection closed while awaiting approval".to_string());
            }
            let receiver = entry
                .cancel
                .as_ref()
                .ok_or_else(|| "Connection cancellation is unavailable".to_string())?
                .subscribe();
            entry.status.active_commands += 1;
            (socket, receiver)
        };
        self.emit_status();
        let result = self
            .run_command(
                &profile,
                &socket,
                &request,
                cwd.as_deref(),
                timeout,
                &mut disconnect_rx,
                &mut lane_cancel_rx,
            )
            .await;
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = inner.entries.get_mut(&request.computer_id) {
                entry.status.active_commands = entry.status.active_commands.saturating_sub(1);
            }
        }
        self.emit_status();
        result
    }

    #[allow(clippy::too_many_arguments)] // Transport inputs and two independent cancellation signals.
    async fn run_command(
        &self,
        profile: &ComputerProfile,
        socket: &Path,
        request: &ComputerExecRequest,
        cwd: Option<&str>,
        timeout: u64,
        disconnect_rx: &mut watch::Receiver<bool>,
        lane_cancel_rx: &mut watch::Receiver<bool>,
    ) -> Result<ComputerExecResult, String> {
        let mut cmd = Command::new("ssh");
        cmd.arg("-S")
            .arg(socket)
            .arg("-T")
            .arg("-o")
            .arg("BatchMode=yes")
            .args(profile_overrides(profile))
            .arg(&profile.host)
            .arg("sh")
            .arg("-s")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("Start SSH command: {e}"))?;
        let mut script = String::new();
        if let Some(cwd) = cwd {
            script.push_str("cd '");
            script.push_str(&cwd.replace('\'', "'\\''"));
            script.push_str("' || exit 1\n");
        }
        script.push_str(&request.command);
        script.push('\n');
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "SSH stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "SSH stderr unavailable".to_string())?;
        let mut stdout_task = tokio::spawn(drain_bounded(stdout));
        let mut stderr_task = tokio::spawn(drain_bounded(stderr));
        let deadline = tokio::time::sleep(Duration::from_secs(timeout));
        tokio::pin!(deadline);
        if let Some(mut stdin) = child.stdin.take() {
            let sent = tokio::select! {
                result = stdin.write_all(script.as_bytes()) => result.is_ok(),
                _ = &mut deadline => false,
                _ = disconnect_rx.changed() => false,
                _ = lane_cancel_rx.changed() => false,
            };
            if !sent {
                let _ = child.kill().await;
                stdout_task.abort();
                stderr_task.abort();
                return Err(
                    "Remote command outcome unknown while sending input or connection closed"
                        .to_string(),
                );
            }
        }
        let (exit_code, outcome) = tokio::select! {
            status = child.wait() => {
                let code = status.map_err(|e| format!("SSH command status: {e}"))?.code();
                let outcome = if code == Some(255) && !check_master(profile, socket) { "unknown" } else { "completed" };
                (code, outcome)
            },
            _ = &mut deadline => { let _ = child.kill().await; (None, "unknown") },
            _ = disconnect_rx.changed() => { let _ = child.kill().await; (None, "unknown") },
            _ = lane_cancel_rx.changed() => { let _ = child.kill().await; (None, "unknown") },
        };
        let (out_bytes, out_truncated) =
            match tokio::time::timeout(Duration::from_secs(2), &mut stdout_task).await {
                Ok(result) => result
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?,
                Err(_) => {
                    stdout_task.abort();
                    (Vec::new(), true)
                }
            };
        let (err_bytes, err_truncated) =
            match tokio::time::timeout(Duration::from_secs(2), &mut stderr_task).await {
                Ok(result) => result
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?,
                Err(_) => {
                    stderr_task.abort();
                    (Vec::new(), true)
                }
            };
        let result = ComputerExecResult {
            computer_id: request.computer_id.clone(),
            exit_code,
            stdout: String::from_utf8_lossy(&out_bytes).into_owned(),
            stderr: String::from_utf8_lossy(&err_bytes).into_owned(),
            truncated: out_truncated || err_truncated,
            outcome,
        };
        if outcome == "unknown" {
            return Err(format!("Remote command outcome unknown after timeout, lane cancellation, or disconnect: {}", serde_json::to_string(&result).unwrap_or_default()));
        }
        Ok(result)
    }

    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        let ids = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.disconnect(&id);
        }
        let mut caps = self.capabilities.lock().unwrap_or_else(|e| e.into_inner());
        for binding in caps.values() {
            let _ = binding.cancel.send(true);
        }
        caps.clear();
        drop(caps);
        let pending = self
            .approvals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .collect::<Vec<_>>();
        for (request_id, approval) in pending {
            let _ = approval.reply.send(false);
            self.emit_approval_closed(&request_id);
        }
    }
}

async fn drain_bounded<R: AsyncRead + Unpin>(mut reader: R) -> std::io::Result<(Vec<u8>, bool)> {
    let mut kept = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        let room = OUTPUT_LIMIT.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..n.min(room)]);
        if n > room {
            truncated = true;
        }
    }
    Ok((kept, truncated))
}

fn profile_overrides(profile: &ComputerProfile) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(user) = &profile.user {
        args.extend(["-l".to_string(), user.clone()]);
    }
    if let Some(port) = profile.port {
        args.extend(["-p".to_string(), port.to_string()]);
    }
    args
}

fn resolve_target(profile: &ComputerProfile) -> Result<String, String> {
    let output = StdCommand::new("ssh")
        .arg("-G")
        .args(profile_overrides(profile))
        .arg(&profile.host)
        .output()
        .map_err(|e| format!("Resolve SSH target: {e}"))?;
    if !output.status.success() {
        return Err(format!("Cannot resolve SSH target {}", profile.host));
    }
    let body = String::from_utf8_lossy(&output.stdout);
    let field = |key: &str| {
        body.lines()
            .find_map(|line| line.strip_prefix(key).map(str::trim).map(str::to_string))
    };
    let host = field("hostname ").ok_or_else(|| "ssh -G did not return hostname".to_string())?;
    let user = field("user ").ok_or_else(|| "ssh -G did not return user".to_string())?;
    let port = field("port ").ok_or_else(|| "ssh -G did not return port".to_string())?;
    Ok(format!("{user}@{host}:{port}"))
}

fn check_master(profile: &ComputerProfile, socket: &Path) -> bool {
    StdCommand::new("ssh")
        .arg("-S")
        .arg(socket)
        .arg("-O")
        .arg("check")
        .args(profile_overrides(profile))
        .arg(&profile.host)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn validate_profile(profile: &ComputerProfile) -> Result<(), String> {
    let id = profile.id.as_bytes();
    if id.is_empty()
        || !id[0].is_ascii_lowercase()
        || !id.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
    {
        return Err("ID must match [a-z][a-z0-9_-]*".to_string());
    }
    if profile.host.is_empty()
        || profile.host.starts_with('-')
        || profile
            .host
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("Host must be an SSH alias or hostname without whitespace".to_string());
    }
    if profile.user.as_deref().is_some_and(|user| {
        user.is_empty()
            || user.starts_with('-')
            || user.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    }) {
        return Err("Invalid SSH user".to_string());
    }
    if profile.port == Some(0) {
        return Err("Port must be 1–65535".to_string());
    }
    if profile
        .default_cwd
        .as_deref()
        .is_some_and(|cwd| !Path::new(cwd).is_absolute() || cwd.contains('\0'))
    {
        return Err("Default directory must be an absolute path".to_string());
    }
    Ok(())
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn disk_revision(path: &Path) -> Result<String, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(revision(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(revision(&[])),
        Err(error) => Err(format!("Read connected computers: {error}")),
    }
}

fn read_profiles(path: &Path) -> Result<(Vec<ComputerProfile>, String), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), revision(&[])))
        }
        Err(error) => return Err(format!("Read connected computers: {error}")),
    };
    let parsed: ProfileFile =
        toml::from_str(&String::from_utf8(bytes.clone()).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Parse connected-computers.toml: {e}"))?;
    if parsed.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "Unsupported connected computers schema {}",
            parsed.schema_version
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let profiles: Vec<ComputerProfile> = parsed.computers.into_iter().map(Into::into).collect();
    for profile in &profiles {
        validate_profile(profile)?;
        if !seen.insert(&profile.id) {
            return Err(format!("Duplicate computer ID: {}", profile.id));
        }
    }
    Ok((profiles, revision(&bytes)))
}

fn check_revision(path: &Path, current: &str, expected: &str) -> Result<(), String> {
    if current != expected || disk_revision(path)? != current {
        return Err("Profile file changed; reload before saving".to_string());
    }
    Ok(())
}

fn persist(path: &Path, inner: &mut Inner) -> Result<(), String> {
    let mut computers: Vec<_> = inner
        .entries
        .values()
        .map(|entry| StoredProfile::from(&entry.status.profile))
        .collect();
    computers.sort_by(|a, b| a.id.cmp(&b.id));
    let body = toml::to_string_pretty(&ProfileFile {
        schema_version: SCHEMA_VERSION,
        computers,
    })
    .map_err(|e| format!("Serialize connected computers: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid profile path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Create config directory: {e}"))?;
    let temp = parent.join(format!(".connected-computers-{}.tmp", random_hex()?));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|e| format!("Create profile temp file: {e}"))?;
        file.write_all(body.as_bytes())
            .map_err(|e| format!("Write profiles: {e}"))?;
        file.sync_all().map_err(|e| format!("Sync profiles: {e}"))?;
        fs::rename(&temp, path).map_err(|e| format!("Replace profiles: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    inner.revision = revision(body.as_bytes());
    Ok(())
}

fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("Generate computer capability: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[tauri::command]
pub fn computer_list(
    manager: State<'_, Arc<ConnectedComputerManager>>,
) -> Result<ComputerList, String> {
    manager.list()
}

#[tauri::command]
pub fn computer_profile_save(
    profile: ComputerProfile,
    expected_revision: String,
    manager: State<'_, Arc<ConnectedComputerManager>>,
) -> Result<ComputerList, String> {
    manager.save(profile, &expected_revision)
}

#[tauri::command]
pub fn computer_profile_delete(
    id: String,
    expected_revision: String,
    manager: State<'_, Arc<ConnectedComputerManager>>,
) -> Result<ComputerList, String> {
    manager.delete(&id, &expected_revision)
}

#[tauri::command]
pub fn computer_reload(
    manager: State<'_, Arc<ConnectedComputerManager>>,
) -> Result<ComputerList, String> {
    manager.reload()
}

#[tauri::command]
pub async fn computer_connect(
    id: String,
    manager: State<'_, Arc<ConnectedComputerManager>>,
) -> Result<ComputerList, String> {
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || manager.connect(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn computer_disconnect(
    id: String,
    manager: State<'_, Arc<ConnectedComputerManager>>,
) -> Result<ComputerList, String> {
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || manager.disconnect(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn computer_lane_register(
    harness_id: String,
    lane_label: String,
    spawn_epoch: u64,
    manager: State<'_, Arc<ConnectedComputerManager>>,
) -> Result<String, String> {
    manager.issue_capability(harness_id, lane_label, spawn_epoch)
}

#[tauri::command]
pub fn computer_approval_decide(
    request_id: String,
    accept: bool,
    manager: State<'_, Arc<ConnectedComputerManager>>,
) -> Result<(), String> {
    manager.decide(&request_id, accept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_round_trip_and_stale_revision() {
        let base = std::env::temp_dir().join(format!(
            "connected-computers-test-{}",
            random_hex().unwrap()
        ));
        let manager =
            ConnectedComputerManager::new_at(base.join("profiles.toml"), base.join("sockets"));
        let first = manager.list().unwrap();
        let saved = manager
            .save(
                ComputerProfile {
                    id: "buildbox".into(),
                    host: "buildbox".into(),
                    user: None,
                    port: None,
                    default_cwd: Some("/srv/builds".into()),
                },
                &first.revision,
            )
            .unwrap();
        assert_eq!(saved.computers.len(), 1);
        let body = fs::read_to_string(base.join("profiles.toml")).unwrap();
        assert!(body.contains("default_cwd = \"/srv/builds\""));
        assert!(!body.contains("defaultCwd"));
        assert!(manager
            .save(
                ComputerProfile {
                    id: "staging".into(),
                    host: "staging".into(),
                    user: None,
                    port: None,
                    default_cwd: None,
                },
                &first.revision
            )
            .is_err());
        assert_eq!(
            ConnectedComputerManager::new_at(base.join("profiles.toml"), base.join("sockets"))
                .list()
                .unwrap()
                .computers
                .len(),
            1
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn invalid_host_and_directory_are_rejected() {
        let mut profile = ComputerProfile {
            id: "box".into(),
            host: "-ProxyCommand=evil".into(),
            user: None,
            port: None,
            default_cwd: None,
        };
        assert!(validate_profile(&profile).is_err());
        profile.host = "buildbox".into();
        profile.default_cwd = Some("relative".into());
        assert!(validate_profile(&profile).is_err());
    }

    #[test]
    fn capability_requires_bound_lane_and_revokes_on_session_end() {
        let base = std::env::temp_dir().join(format!(
            "connected-computers-test-{}",
            random_hex().unwrap()
        ));
        let manager =
            ConnectedComputerManager::new_at(base.join("profiles.toml"), base.join("sockets"));
        let token = manager
            .issue_capability("h1".into(), "Pi-1".into(), 7)
            .unwrap();
        assert!(!manager.valid_capability(&token, Some("h1"), Some("Pi-1")));
        manager.bind_session(&token, 42).unwrap();
        assert!(manager.valid_capability(&token, Some("h1"), Some("Pi-1")));
        assert!(!manager.valid_capability(&token, Some("h2"), Some("Pi-1")));
        assert!(!manager.valid_capability(&token, Some("h1"), Some("Pi-2")));
        manager.revoke_session(42);
        assert!(!manager.valid_capability(&token, None, None));
    }

    #[tokio::test]
    async fn output_drain_is_bounded_while_consuming_to_eof() {
        let input = vec![b'x'; OUTPUT_LIMIT + 9];
        let (mut writer, reader) = tokio::io::duplex(input.len() + 1);
        writer.write_all(&input).await.unwrap();
        drop(writer);
        let (kept, truncated) = drain_bounded(reader).await.unwrap();
        assert_eq!(kept.len(), OUTPUT_LIMIT);
        assert!(truncated);
    }
}
