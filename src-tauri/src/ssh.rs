// Krypton — SSH Session Multiplexing
// Detects active SSH connections in PTY sessions and enables cloning
// via OpenSSH ControlMaster multiplexing.

use crate::pty::PtyManager;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Metadata about a detected SSH connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnectionInfo {
    pub user: String,
    pub host: String,
    pub port: u16,
    /// Path to the ControlMaster socket managed by Krypton.
    pub control_socket: Option<String>,
    /// Additional SSH args to preserve (e.g., -i, -J).
    pub extra_args: Vec<String>,
}

/// Manages SSH connection detection and control socket lifecycle.
pub struct SshManager {
    /// Directory for control sockets: ~/.config/krypton/ssh-sockets/
    socket_dir: PathBuf,
    /// Cached connection info per PTY session ID.
    connections: Mutex<HashMap<u32, SshConnectionInfo>>,
    /// Seconds to keep a ControlMaster alive after the last client disconnects.
    control_persist: u64,
}

impl SshManager {
    pub fn new(socket_dir: PathBuf, control_persist: u64) -> Self {
        // Ensure socket directory exists with restrictive permissions
        if !socket_dir.exists() {
            let _ = std::fs::create_dir_all(&socket_dir);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(0o700));
            }
        }

        Self {
            socket_dir,
            connections: Mutex::new(HashMap::new()),
            control_persist,
        }
    }

    /// Detect an active SSH connection in the given PTY session.
    ///
    /// Walks the process tree from the PTY's foreground process upward
    /// to find an `ssh` process, then parses its command-line arguments
    /// to extract user, host, port, and any extra flags.
    pub fn detect(&self, session_id: u32, pty_manager: &PtyManager) -> Option<SshConnectionInfo> {
        // Check cache first
        if let Ok(conns) = self.connections.lock() {
            if let Some(info) = conns.get(&session_id) {
                return Some(info.clone());
            }
        }

        // Find the SSH process in the PTY's process tree
        let ssh_cmdline = self.find_ssh_process(session_id, pty_manager)?;

        // Parse the SSH command line
        let mut info = parse_ssh_args(&ssh_cmdline)?;

        // Assign a control socket path
        let socket_name = format!("{}@{}:{}", info.user, info.host, info.port);
        let socket_path = self.socket_dir.join(&socket_name);
        info.control_socket = Some(socket_path.to_string_lossy().to_string());

        // Cache it
        if let Ok(mut conns) = self.connections.lock() {
            conns.insert(session_id, info.clone());
        }

        Some(info)
    }

    /// Build the ssh command to clone a session using ControlMaster multiplexing.
    pub fn build_clone_command(&self, info: &SshConnectionInfo) -> (String, Vec<String>) {
        let socket_path = info
            .control_socket
            .as_deref()
            .unwrap_or("/tmp/krypton-ssh-%r@%h:%p");

        let mut args = vec![
            "-o".to_string(),
            format!("ControlPath={socket_path}"),
            "-o".to_string(),
            "ControlMaster=auto".to_string(),
            "-o".to_string(),
            format!("ControlPersist={}", self.control_persist),
        ];

        // Add port if non-default
        if info.port != 22 {
            args.push("-p".to_string());
            args.push(info.port.to_string());
        }

        // Add extra args (e.g., -i keyfile, -J jumphost)
        args.extend(info.extra_args.clone());

        // Destination
        args.push(format!("{}@{}", info.user, info.host));

        ("ssh".to_string(), args)
    }

    /// Clear cached connection info for a session (e.g., on PTY exit).
    pub fn remove_session(&self, session_id: u32) {
        if let Ok(mut conns) = self.connections.lock() {
            conns.remove(&session_id);
        }
    }

    /// Clean up stale control sockets on startup or shutdown.
    pub fn cleanup_sockets(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.socket_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                // Check if the socket is still active
                if path.exists() {
                    let check = std::process::Command::new("ssh")
                        .args(["-O", "check", "-S"])
                        .arg(&path)
                        .arg("dummy") // required positional arg, not actually used
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();

                    match check {
                        Ok(status) if !status.success() => {
                            // Socket is stale, remove it
                            let _ = std::fs::remove_file(&path);
                            log::info!("Cleaned up stale SSH socket: {}", path.display());
                        }
                        Err(_) => {
                            // ssh command failed entirely, socket is definitely stale
                            let _ = std::fs::remove_file(&path);
                        }
                        _ => {} // Socket is alive, leave it
                    }
                }
            }
        }
    }

    /// Walk the process tree for a PTY session to find an ssh process.
    /// Returns the full command line of the ssh process if found.
    #[cfg(unix)]
    fn find_ssh_process(&self, session_id: u32, pty_manager: &PtyManager) -> Option<Vec<String>> {
        use sysinfo::System;

        let shell_pid = pty_manager.get_shell_pid(session_id)?;

        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        // Walk down from the shell looking for an ssh process
        self.find_ssh_in_tree(&sys, sysinfo::Pid::from_u32(shell_pid), 0, 10)
    }

    #[cfg(not(unix))]
    fn find_ssh_process(&self, _session_id: u32, _pty_manager: &PtyManager) -> Option<Vec<String>> {
        None
    }

    #[cfg(unix)]
    fn find_ssh_in_tree(
        &self,
        sys: &sysinfo::System,
        pid: sysinfo::Pid,
        depth: u32,
        max_depth: u32,
    ) -> Option<Vec<String>> {
        if depth >= max_depth {
            return None;
        }

        // Check this process
        if let Some(proc) = sys.process(pid) {
            let name = proc.name().to_string_lossy().to_string();
            if name == "ssh" {
                // Get the full command line
                let cmdline: Vec<String> = proc
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().to_string())
                    .collect();
                if cmdline.is_empty() {
                    // macOS fallback: use ps
                    return read_cmdline_ps(pid.as_u32());
                }
                return Some(cmdline);
            }
        }

        // Check children
        let children: Vec<sysinfo::Pid> = sys
            .processes()
            .values()
            .filter(|p| p.parent() == Some(pid))
            .map(|p| p.pid())
            .collect();

        for child_pid in children {
            if let Some(result) = self.find_ssh_in_tree(sys, child_pid, depth + 1, max_depth) {
                return Some(result);
            }
        }

        None
    }
}

/// Read process command line via `ps` (macOS fallback).
fn read_cmdline_ps(pid: u32) -> Option<Vec<String>> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "args="])
        .output()
        .ok()?;
    let args_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if args_str.is_empty() {
        return None;
    }
    Some(shell_words_split(&args_str))
}

/// Simple shell word splitting that handles basic quoting.
fn shell_words_split(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut escape_next = false;

    for ch in s.chars() {
        if escape_next {
            current.push(ch);
            escape_next = false;
            continue;
        }
        match ch {
            '\\' if !in_single_quote => escape_next = true,
            '\'' if !in_double_quote => in_single_quote = !in_single_quote,
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            ' ' | '\t' if !in_single_quote && !in_double_quote => {
                if !current.is_empty() {
                    result.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

/// Parse SSH command-line arguments to extract connection details.
///
/// Handles these forms:
/// - `ssh user@host`
/// - `ssh -l user host`
/// - `ssh -p port user@host`
/// - `ssh -i keyfile user@host`
/// - `ssh -J jumphost user@host`
/// - `ssh -o Option=value user@host`
fn parse_ssh_args(args: &[String]) -> Option<SshConnectionInfo> {
    if args.is_empty() {
        return None;
    }

    let mut user: Option<String> = None;
    let mut host: Option<String> = None;
    let mut port: u16 = 22;
    let mut extra_args: Vec<String> = Vec::new();

    // Skip the "ssh" binary name
    let start = if args[0].ends_with("ssh") || args[0] == "ssh" {
        1
    } else {
        0
    };

    let mut i = start;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-p" => {
                // Port
                if let Some(p) = args.get(i + 1) {
                    port = p.parse().unwrap_or(22);
                    i += 2;
                    continue;
                }
            }
            "-l" => {
                // Login name
                if let Some(u) = args.get(i + 1) {
                    user = Some(u.clone());
                    i += 2;
                    continue;
                }
            }
            "-i" => {
                // Identity file — preserve for clone
                if let Some(keyfile) = args.get(i + 1) {
                    extra_args.push("-i".to_string());
                    extra_args.push(keyfile.clone());
                    i += 2;
                    continue;
                }
            }
            "-J" => {
                // Jump host — preserve for clone
                if let Some(jump) = args.get(i + 1) {
                    extra_args.push("-J".to_string());
                    extra_args.push(jump.clone());
                    i += 2;
                    continue;
                }
            }
            "-o" => {
                // Options — skip ControlMaster/ControlPath/ControlPersist (we manage those),
                // but preserve everything else
                if let Some(opt) = args.get(i + 1) {
                    let opt_lower = opt.to_lowercase();
                    if !opt_lower.starts_with("controlmaster=")
                        && !opt_lower.starts_with("controlpath=")
                        && !opt_lower.starts_with("controlpersist=")
                    {
                        extra_args.push("-o".to_string());
                        extra_args.push(opt.clone());
                    }
                    i += 2;
                    continue;
                }
            }
            "-S" => {
                // Control socket — skip, we manage our own
                i += 2;
                continue;
            }
            _ if arg.starts_with('-') => {
                // Other flags — check if they take an argument
                // Single-char flags that take no argument
                let no_arg_flags = [
                    "-4", "-6", "-A", "-a", "-C", "-f", "-G", "-g", "-K", "-k", "-M", "-N", "-n",
                    "-q", "-s", "-T", "-t", "-V", "-v", "-X", "-x", "-Y", "-y",
                ];
                if no_arg_flags.contains(&arg.as_str()) || arg.len() > 2 {
                    // Multi-char flags or no-arg flags: skip
                    i += 1;
                    continue;
                }
                // Single-char flags that take an argument
                let arg_flags = [
                    "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-L", "-m", "-O", "-R", "-W", "-w",
                ];
                if arg_flags.contains(&arg.as_str()) {
                    i += 2; // skip flag + its argument
                    continue;
                }
                i += 1;
                continue;
            }
            _ => {
                // Positional argument — this should be the destination
                if host.is_none() {
                    if arg.contains('@') {
                        let parts: Vec<&str> = arg.splitn(2, '@').collect();
                        if parts.len() == 2 {
                            user = Some(parts[0].to_string());
                            host = Some(parts[1].to_string());
                        }
                    } else {
                        host = Some(arg.clone());
                    }
                }
                // Anything after destination is the remote command — stop parsing
                break;
            }
        }
        i += 1;
    }

    let host = host?;
    let user = user.unwrap_or_else(|| {
        std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "root".to_string())
    });

    Some(SshConnectionInfo {
        user,
        host,
        port,
        control_socket: None,
        extra_args,
    })
}

// ─── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_user_at_host() {
        let args = vec!["ssh".into(), "alice@example.com".into()];
        let info = parse_ssh_args(&args).unwrap();
        assert_eq!(info.user, "alice");
        assert_eq!(info.host, "example.com");
        assert_eq!(info.port, 22);
        assert!(info.extra_args.is_empty());
    }

    #[test]
    fn test_parse_with_port() {
        let args = vec![
            "ssh".into(),
            "-p".into(),
            "2222".into(),
            "bob@server.io".into(),
        ];
        let info = parse_ssh_args(&args).unwrap();
        assert_eq!(info.user, "bob");
        assert_eq!(info.host, "server.io");
        assert_eq!(info.port, 2222);
    }

    #[test]
    fn test_parse_with_login_flag() {
        let args = vec![
            "ssh".into(),
            "-l".into(),
            "charlie".into(),
            "10.0.0.1".into(),
        ];
        let info = parse_ssh_args(&args).unwrap();
        assert_eq!(info.user, "charlie");
        assert_eq!(info.host, "10.0.0.1");
    }

    #[test]
    fn test_parse_with_identity_and_jump() {
        let args = vec![
            "ssh".into(),
            "-i".into(),
            "~/.ssh/mykey".into(),
            "-J".into(),
            "jump.host".into(),
            "deploy@prod.server".into(),
        ];
        let info = parse_ssh_args(&args).unwrap();
        assert_eq!(info.user, "deploy");
        assert_eq!(info.host, "prod.server");
        assert_eq!(
            info.extra_args,
            vec!["-i", "~/.ssh/mykey", "-J", "jump.host"]
        );
    }

    #[test]
    fn test_parse_strips_control_options() {
        let args = vec![
            "ssh".into(),
            "-o".into(),
            "ControlMaster=auto".into(),
            "-o".into(),
            "ControlPath=/tmp/sock".into(),
            "-o".into(),
            "ServerAliveInterval=60".into(),
            "user@host".into(),
        ];
        let info = parse_ssh_args(&args).unwrap();
        assert_eq!(info.extra_args, vec!["-o", "ServerAliveInterval=60"]);
    }

    #[test]
    fn test_parse_no_host_returns_none() {
        let args = vec!["ssh".into(), "-v".into()];
        assert!(parse_ssh_args(&args).is_none());
    }

    #[test]
    fn test_build_clone_command() {
        let socket_dir = PathBuf::from("/tmp/test-sockets");
        let mgr = SshManager {
            socket_dir,
            connections: Mutex::new(HashMap::new()),
            control_persist: 600,
        };

        let info = SshConnectionInfo {
            user: "alice".into(),
            host: "example.com".into(),
            port: 22,
            control_socket: Some("/tmp/test-sockets/alice@example.com:22".into()),
            extra_args: vec![],
        };

        let (prog, args) = mgr.build_clone_command(&info);
        assert_eq!(prog, "ssh");
        assert!(args.contains(&"ControlMaster=auto".to_string()));
        assert!(args.contains(&"alice@example.com".to_string()));
        // No -p flag for default port 22
        assert!(!args.contains(&"-p".to_string()));
    }

    #[test]
    fn test_build_clone_command_nondefault_port() {
        let socket_dir = PathBuf::from("/tmp/test-sockets");
        let mgr = SshManager {
            socket_dir,
            connections: Mutex::new(HashMap::new()),
            control_persist: 600,
        };

        let info = SshConnectionInfo {
            user: "bob".into(),
            host: "server.io".into(),
            port: 2222,
            control_socket: Some("/tmp/test-sockets/bob@server.io:2222".into()),
            extra_args: vec!["-i".into(), "~/.ssh/key".into()],
        };

        let (prog, args) = mgr.build_clone_command(&info);
        assert_eq!(prog, "ssh");
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"2222".to_string()));
        assert!(args.contains(&"-i".to_string()));
    }

    #[test]
    fn test_shell_words_split() {
        let input = r#"ssh -i "my key.pem" user@host"#;
        let result = shell_words_split(input);
        assert_eq!(result, vec!["ssh", "-i", "my key.pem", "user@host"]);
    }
}
