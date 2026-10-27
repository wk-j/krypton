//! Non-PTY SSH channel to a host (specs 247, 336).
//!
//! Shared by Remote Harness and Inline AI remote checks: resolve a focused
//! pane's SSH target (identity validation, `-i`/`-J` only, `ssh -G`), borrow
//! the pane's ControlMaster after `ssh -O check` or own one under
//! `<config dir>/ssh-sockets/`, and build the `ssh` command that rides it.

use crate::ssh::SshConnectionInfo;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

pub const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 15;

/// Where and how to reach an SSH host.
#[derive(Debug, Clone)]
pub struct SshTarget {
    /// The destination argument passed to every `ssh` call.
    pub destination: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub connect_timeout_seconds: u64,
    /// Only `-i`/`-J` pairs from the pane's own `ssh` argv.
    pub extra_args: Vec<String>,
    /// A master socket to borrow when `ssh -O check` passes.
    pub requested_socket: Option<PathBuf>,
}

/// The target for a pane's detected `ssh` process, before `ssh -G`.
pub fn focused_target(info: &SshConnectionInfo) -> Result<SshTarget, String> {
    validate_ssh_identity(&info.user, &info.host)?;
    Ok(SshTarget {
        destination: format!("{}@{}", info.user, info.host),
        user: info.user.clone(),
        host: info.host.clone(),
        port: info.port,
        connect_timeout_seconds: DEFAULT_CONNECT_TIMEOUT_SECS,
        extra_args: safe_extra_args(info),
        requested_socket: info.active_control_socket.clone().map(expand_home),
    })
}

/// Apply `ssh -G`: the effective user, hostname and port, and its
/// `controlpath` as the socket to borrow when the pane named none. Returns
/// the full config so callers can inspect other options.
pub async fn apply_ssh_config(target: &mut SshTarget) -> Result<HashMap<String, String>, String> {
    let ssh_config = resolve_ssh_config(target).await?;
    if let Some(user) = ssh_config.get("user").filter(|value| !value.is_empty()) {
        target.user = user.clone();
    }
    if let Some(host) = ssh_config.get("hostname").filter(|value| !value.is_empty()) {
        target.host = host.clone();
    }
    if let Some(port) = ssh_config
        .get("port")
        .and_then(|value| value.parse::<u16>().ok())
    {
        target.port = port;
    }
    if target.requested_socket.is_none() {
        target.requested_socket = ssh_config
            .get("controlpath")
            .filter(|value| value.as_str() != "none" && !value.contains('%'))
            .map(|value| expand_home(value.clone()));
    }
    Ok(ssh_config)
}

async fn resolve_ssh_config(target: &SshTarget) -> Result<HashMap<String, String>, String> {
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

/// Borrow `target.requested_socket` when its master answers `-O check`;
/// otherwise own `<config dir>/ssh-sockets/<owned_name>` (directory 0700).
/// Returns the socket and whether it is borrowed.
pub async fn select_control_socket(
    target: &SshTarget,
    owned_name: &str,
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
    Ok((base.join(owned_name), false))
}

pub async fn check_master(target: &SshTarget, socket: &Path) -> bool {
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

/// `ssh` with the channel options and target args; the caller appends the
/// destination and remote command. A borrowed master is used as a client
/// only (`ControlMaster=no`); an owned one is created on demand (`auto`).
pub fn configured_ssh_command(
    target: &SshTarget,
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

pub fn append_target_args(command: &mut Command, target: &SshTarget) {
    if target.port != 22 {
        command.arg("-p").arg(target.port.to_string());
    }
    command.args(&target.extra_args);
}

pub fn expand_home(path: String) -> PathBuf {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn focused_ssh_identity_rejects_option_like_user() {
        assert!(validate_ssh_identity("-oProxyCommand", "host").is_err());
        assert!(validate_ssh_identity("alice", "2001:db8::1").is_ok());
    }
}
