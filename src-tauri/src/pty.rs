use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter};

// ─── Process Detection Types ──────────────────────────────────────

/// Information about the foreground process of a PTY session.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cmdline: Vec<String>,
}

/// Java process resource statistics from `jstat` and `ps`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct JavaStats {
    /// JVM heap used in MB (Eden + Survivor + Old used)
    pub heap_used_mb: f64,
    /// JVM heap max capacity in MB (Eden + Survivor + Old capacity)
    pub heap_max_mb: f64,
    /// Heap usage percentage
    pub heap_percent: f64,
    /// Total GC event count (YGC + FGC)
    pub gc_count: u64,
    /// Total GC time in seconds (GCT)
    pub gc_time_secs: f64,
    /// OS-level CPU usage percentage
    pub cpu_percent: f64,
    /// OS-level resident set size in MB
    pub rss_mb: f64,
    /// Process PID
    pub pid: u32,
    /// Extracted main class or JAR name
    pub main_class: String,
}

// ─── OSC 9;4 Progress Bar Parser ───────────────────────────────────

/// Payload emitted as a `pty-progress` Tauri event.
#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    session_id: u32,
    /// 0=remove, 1=normal, 2=error, 3=indeterminate, 4=paused
    state: u8,
    /// 0-100, meaningful for state 1/2/4
    progress: u8,
}

/// Inline state machine for detecting `ESC ] 9 ; 4 ; <st> [; <pr>] ST` sequences
/// within raw PTY output. Does NOT consume or strip bytes from the stream.
///
/// ST (String Terminator) is either BEL (0x07) or ESC \ (0x1B 0x5C).
enum OscParseState {
    /// Default — scanning for ESC (0x1B)
    Normal,
    /// Saw ESC (0x1B)
    Esc,
    /// Saw ESC ] (OSC start)
    OscStart,
    /// Saw ESC ] 9
    Osc9,
    /// Saw ESC ] 9 ;
    Osc9Semi,
    /// Saw ESC ] 9 ; 4
    Osc94,
    /// Saw ESC ] 9 ; 4 ;
    Osc94Semi,
    /// Collecting the state digit and optional ;progress until ST
    CollectArgs,
    /// Saw ESC inside CollectArgs (potential ESC \ terminator)
    CollectEsc,
}

/// Persistent parser context for one PTY session's reader thread.
struct OscProgressParser {
    state: OscParseState,
    /// Accumulated argument bytes (e.g. "1;75" or "3")
    arg_buf: Vec<u8>,
}

impl OscProgressParser {
    fn new() -> Self {
        Self {
            state: OscParseState::Normal,
            arg_buf: Vec::with_capacity(16),
        }
    }

    /// Reset to default scanning state.
    fn reset(&mut self) {
        self.state = OscParseState::Normal;
        self.arg_buf.clear();
    }

    /// Feed a chunk of bytes through the parser. Returns a `ProgressPayload`
    /// each time a complete `OSC 9;4` sequence is detected.
    fn feed(&mut self, data: &[u8]) -> Vec<ProgressPayload> {
        let mut results = Vec::new();

        for &byte in data {
            match self.state {
                OscParseState::Normal => {
                    if byte == 0x1B {
                        self.state = OscParseState::Esc;
                    }
                }
                OscParseState::Esc => {
                    if byte == b']' {
                        self.state = OscParseState::OscStart;
                    } else {
                        self.reset();
                        // Re-check: the unexpected byte itself might be ESC
                        if byte == 0x1B {
                            self.state = OscParseState::Esc;
                        }
                    }
                }
                OscParseState::OscStart => {
                    if byte == b'9' {
                        self.state = OscParseState::Osc9;
                    } else {
                        self.reset();
                        if byte == 0x1B {
                            self.state = OscParseState::Esc;
                        }
                    }
                }
                OscParseState::Osc9 => {
                    if byte == b';' {
                        self.state = OscParseState::Osc9Semi;
                    } else {
                        self.reset();
                        if byte == 0x1B {
                            self.state = OscParseState::Esc;
                        }
                    }
                }
                OscParseState::Osc9Semi => {
                    if byte == b'4' {
                        self.state = OscParseState::Osc94;
                    } else {
                        self.reset();
                        if byte == 0x1B {
                            self.state = OscParseState::Esc;
                        }
                    }
                }
                OscParseState::Osc94 => {
                    if byte == b';' {
                        self.state = OscParseState::Osc94Semi;
                        self.arg_buf.clear();
                    } else if byte == 0x07 {
                        // BEL terminates with no args — treat as state=0 (remove)
                        results.push(ProgressPayload {
                            session_id: 0, // filled in by caller
                            state: 0,
                            progress: 0,
                        });
                        self.reset();
                    } else if byte == 0x1B {
                        self.state = OscParseState::CollectEsc;
                        // Might be ESC \ to terminate with no args
                        self.arg_buf.clear();
                    } else {
                        self.reset();
                    }
                }
                OscParseState::Osc94Semi => {
                    if byte == 0x07 {
                        // BEL terminates — parse args
                        if let Some(payload) = self.parse_args() {
                            results.push(payload);
                        }
                        self.reset();
                    } else if byte == 0x1B {
                        self.state = OscParseState::CollectEsc;
                    } else if self.arg_buf.len() < 16 {
                        self.arg_buf.push(byte);
                        self.state = OscParseState::CollectArgs;
                    } else {
                        // Arg buffer overflow — malformed
                        self.reset();
                    }
                }
                OscParseState::CollectArgs => {
                    if byte == 0x07 {
                        // BEL terminates
                        if let Some(payload) = self.parse_args() {
                            results.push(payload);
                        }
                        self.reset();
                    } else if byte == 0x1B {
                        self.state = OscParseState::CollectEsc;
                    } else if self.arg_buf.len() < 16 {
                        self.arg_buf.push(byte);
                    } else {
                        self.reset();
                    }
                }
                OscParseState::CollectEsc => {
                    if byte == b'\\' {
                        // ESC \ terminates
                        if let Some(payload) = self.parse_args() {
                            results.push(payload);
                        }
                        self.reset();
                    } else {
                        // Not a valid ST — abort this sequence
                        self.reset();
                        if byte == 0x1B {
                            self.state = OscParseState::Esc;
                        }
                    }
                }
            }
        }

        results
    }

    /// Parse the collected arg_buf as `<state>[;<progress>]`.
    /// Returns None if malformed.
    fn parse_args(&self) -> Option<ProgressPayload> {
        let s = std::str::from_utf8(&self.arg_buf).ok()?;

        let mut parts = s.splitn(2, ';');
        let state_str = parts.next()?;
        let state: u8 = state_str.parse().ok()?;

        // State must be 0-4
        if state > 4 {
            return None;
        }

        let progress: u8 = if let Some(pr_str) = parts.next() {
            let raw: u16 = pr_str.parse().ok()?;
            raw.min(100) as u8
        } else {
            0
        };

        Some(ProgressPayload {
            session_id: 0, // filled in by caller
            state,
            progress,
        })
    }
}

/// Holds a PTY master handle for writing and resizing.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child_pid: Option<u32>,
}

/// Manages all active PTY sessions, keyed by session ID.
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
        }
    }

    /// Spawn a new PTY session with a given shell, args, and optional working directory.
    /// Returns the session ID.
    pub fn spawn(
        &self,
        app_handle: &AppHandle,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: &str,
        args: &[String],
    ) -> Result<u32, String> {
        let pty_system = native_pty_system();

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let mut cmd = CommandBuilder::new(shell);
        for arg in args {
            cmd.arg(arg);
        }

        // Set working directory if provided
        if let Some(ref dir) = cwd {
            let path = std::path::Path::new(dir);
            if path.is_dir() {
                cmd.cwd(path);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {e}"))?;

        // Get the child PID
        let child_pid = child.process_id();

        // We no longer need the slave side
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

        // Assign session ID
        let session_id = {
            let mut id = self.next_id.lock().map_err(|e| e.to_string())?;
            let current = *id;
            *id += 1;
            current
        };

        // Store the session
        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(
                session_id,
                PtySession {
                    writer,
                    master: pair.master,
                    child_pid,
                },
            );
        }

        // Spawn a background reader thread that emits output events
        let handle = app_handle.clone();
        let sid = session_id;
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut osc_parser = OscProgressParser::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = handle.emit("pty-exit", sid);
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();

                        // Scan for OSC 9;4 progress sequences before forwarding
                        let progress_events = osc_parser.feed(&data);
                        for mut payload in progress_events {
                            payload.session_id = sid;
                            let _ = handle.emit("pty-progress", payload);
                        }

                        let _ = handle.emit("pty-output", (sid, data));
                    }
                    Err(e) => {
                        log::error!("PTY read error for session {sid}: {e}");
                        let _ = handle.emit("pty-exit", sid);
                        break;
                    }
                }
            }
        });

        log::info!("Spawned PTY session {session_id} with shell: {shell} {args:?}, cwd: {cwd:?}");
        Ok(session_id)
    }

    /// Get the current working directory of a PTY session's shell process.
    pub fn get_cwd(&self, session_id: u32) -> Result<Option<String>, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;

        match session.child_pid {
            Some(pid) => Ok(read_process_cwd(pid)),
            None => Ok(None),
        }
    }

    /// Write data to a PTY session.
    pub fn write(&self, session_id: u32, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;
        session
            .writer
            .write_all(data)
            .map_err(|e| format!("Write failed: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Flush failed: {e}"))?;
        Ok(())
    }

    /// Resize a PTY session.
    pub fn resize(&self, session_id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {e}"))?;
        Ok(())
    }

    /// Get all active session IDs.
    pub fn active_session_ids(&self) -> Vec<u32> {
        match self.sessions.lock() {
            Ok(sessions) => sessions.keys().copied().collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Get the foreground process of a PTY session.
    ///
    /// Uses `tcgetpgrp()` on the PTY master fd to find the foreground process
    /// group, then resolves the group leader's process name and command line.
    ///
    /// When the group leader is a shell interpreter (sh, bash, etc.), we walk
    /// the process tree to find the deepest non-shell descendant — this handles
    /// wrapper scripts like `mvn`, `gradle`, or custom `./start.sh` scripts
    /// that ultimately run a real application (e.g., `java`).
    #[cfg(unix)]
    pub fn get_foreground_process(&self, session_id: u32) -> Option<ProcessInfo> {
        let sessions = self.sessions.lock().ok()?;
        let session = sessions.get(&session_id)?;

        // Get the master fd and query the foreground process group
        let fd = session.master.as_raw_fd()?;
        let pgrp = unsafe { libc::tcgetpgrp(fd) };
        if pgrp <= 0 {
            return None;
        }
        let pid = pgrp as u32;

        // If the foreground process IS the shell (same as child_pid), return None
        // to indicate "shell idle" — no interesting foreground process.
        if session.child_pid == Some(pid) {
            return None;
        }

        // Use sysinfo to read process name natively
        let mut sys = System::new();
        sys.refresh_processes(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
            true,
        );
        let proc_info = sys.process(sysinfo::Pid::from_u32(pid))?;
        let name = proc_info.name().to_string_lossy().to_string();

        // If the group leader is a shell interpreter, look deeper into its
        // process tree for the real application process.
        if is_shell_interpreter(&name) {
            if let Some(descendant) = find_deepest_non_shell_descendant(pid) {
                return Some(descendant);
            }
        }

        // Get cmdline — sysinfo cmd() may be empty on macOS, fall back to CLI
        let cmdline: Vec<String> = {
            let cmd: Vec<String> = proc_info
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect();
            if cmd.is_empty() {
                read_cmdline_cli(pid).unwrap_or_default()
            } else {
                cmd
            }
        };
        Some(ProcessInfo { pid, name, cmdline })
    }

    #[cfg(not(unix))]
    pub fn get_foreground_process(&self, _session_id: u32) -> Option<ProcessInfo> {
        None
    }

    /// Get the shell's child PID for a session (used to search the full process tree).
    pub fn get_shell_pid(&self, session_id: u32) -> Option<u32> {
        let sessions = self.sessions.lock().ok()?;
        let session = sessions.get(&session_id)?;
        session.child_pid
    }
}

// ─── Native Process Inspection (sysinfo + netstat2) ──────────────

use sysinfo::System;

/// Names of common shell interpreters.
const SHELL_NAMES: &[&str] = &["sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh"];

fn is_shell_interpreter(name: &str) -> bool {
    SHELL_NAMES.contains(&name)
}

/// Get cmdline from a sysinfo Process, falling back to CLI on macOS.
fn get_proc_cmdline(proc_info: &sysinfo::Process, pid: u32) -> Vec<String> {
    let cmd: Vec<String> = proc_info
        .cmd()
        .iter()
        .map(|s| s.to_string_lossy().to_string())
        .collect();
    if cmd.is_empty() {
        read_cmdline_cli(pid).unwrap_or_default()
    } else {
        cmd
    }
}

/// Walk the process tree from `pid` downward using sysinfo, returning
/// the deepest non-shell descendant.
fn find_deepest_non_shell_descendant(pid: u32) -> Option<ProcessInfo> {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    find_deepest_leaf_native(&sys, sysinfo::Pid::from_u32(pid), 0, 10)
}

fn find_deepest_leaf_native(
    sys: &System,
    pid: sysinfo::Pid,
    depth: u32,
    max_depth: u32,
) -> Option<ProcessInfo> {
    if depth >= max_depth {
        return None;
    }

    let children: Vec<sysinfo::Pid> = sys
        .processes()
        .values()
        .filter(|p| p.parent() == Some(pid))
        .map(|p| p.pid())
        .collect();

    if children.is_empty() {
        let proc = sys.process(pid)?;
        let name = proc.name().to_string_lossy().to_string();
        if is_shell_interpreter(&name) {
            return None;
        }
        let cmdline = get_proc_cmdline(proc, pid.as_u32());
        return Some(ProcessInfo {
            pid: pid.as_u32(),
            name,
            cmdline,
        });
    }

    let mut best: Option<ProcessInfo> = None;
    for child_pid in &children {
        if let Some(descendant) = find_deepest_leaf_native(sys, *child_pid, depth + 1, max_depth) {
            best = Some(descendant);
        }
    }

    if best.is_some() {
        return best;
    }

    let proc = sys.process(pid)?;
    let name = proc.name().to_string_lossy().to_string();
    if !is_shell_interpreter(&name) {
        let cmdline = get_proc_cmdline(proc, pid.as_u32());
        return Some(ProcessInfo {
            pid: pid.as_u32(),
            name,
            cmdline,
        });
    }

    None
}

// ─── Java Stats ──────────────────────────────────────────────────

/// Collect JVM + OS resource stats for a Java process.
///
/// JVM metrics: `jstat -gc <pid>` (no native alternative — JVM-specific tool).
/// OS metrics: native via sysinfo.
pub fn get_java_stats(pid: u32) -> Result<JavaStats, String> {
    let mut sys = System::new();
    let spid = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[spid]), true);

    // Two refreshes needed for cpu_usage() to be non-zero
    std::thread::sleep(std::time::Duration::from_millis(200));
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[spid]), true);

    let proc = sys.process(spid);

    // Get main class — sysinfo cmd() may be empty on macOS, fall back to CLI
    let main_class = proc
        .and_then(|p| {
            let cmd: Vec<String> = p
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect();
            if cmd.is_empty() {
                None
            } else {
                Some(extract_java_main_class(&cmd))
            }
        })
        .unwrap_or_else(|| {
            read_cmdline_cli(pid)
                .map(|args| extract_java_main_class(&args))
                .unwrap_or_else(|| "java".to_string())
        });

    let cpu_percent = proc.map(|p| p.cpu_usage() as f64).unwrap_or(0.0);
    let rss_mb = proc
        .map(|p| p.memory() as f64 / (1024.0 * 1024.0))
        .unwrap_or(0.0);

    // jstat -gc <pid> — no native Rust equivalent, must shell out
    let jstat_output = std::process::Command::new("jstat")
        .args(["-gc", &pid.to_string()])
        .output()
        .map_err(|e| format!("jstat not available: {e}"))?;

    if !jstat_output.status.success() {
        return Err(format!(
            "jstat failed: {}",
            String::from_utf8_lossy(&jstat_output.stderr).trim()
        ));
    }

    let jstat_str = String::from_utf8_lossy(&jstat_output.stdout);
    let (heap_used_mb, heap_max_mb, gc_count, gc_time_secs) = parse_jstat_gc(&jstat_str)?;

    let heap_percent = if heap_max_mb > 0.0 {
        (heap_used_mb / heap_max_mb) * 100.0
    } else {
        0.0
    };

    Ok(JavaStats {
        heap_used_mb,
        heap_max_mb,
        heap_percent,
        gc_count,
        gc_time_secs,
        cpu_percent,
        rss_mb,
        pid,
        main_class,
    })
}

/// Parse `jstat -gc` output.
fn parse_jstat_gc(output: &str) -> Result<(f64, f64, u64, f64), String> {
    let lines: Vec<&str> = output.lines().collect();
    if lines.len() < 2 {
        return Err("jstat output too short".to_string());
    }

    let values: Vec<f64> = lines[1]
        .split_whitespace()
        .filter_map(|s| s.parse::<f64>().ok())
        .collect();

    if values.len() < 17 {
        return Err(format!(
            "jstat -gc: expected 17+ columns, got {}",
            values.len()
        ));
    }

    let s0c = values[0];
    let s1c = values[1];
    let s0u = values[2];
    let s1u = values[3];
    let ec = values[4];
    let eu = values[5];
    let oc = values[6];
    let ou = values[7];

    let used_kb = s0u + s1u + eu + ou;
    let max_kb = s0c + s1c + ec + oc;
    let ygc = values[12] as u64;
    let fgc = values[14] as u64;
    let gct = values[16];

    Ok((used_kb / 1024.0, max_kb / 1024.0, ygc + fgc, gct))
}

/// Extract the main class or JAR name from a Java command line.
fn extract_java_main_class(cmdline: &[String]) -> String {
    for (i, arg) in cmdline.iter().enumerate() {
        if arg == "-jar" {
            if let Some(jar) = cmdline.get(i + 1) {
                return jar.rsplit('/').next().unwrap_or(jar).to_string();
            }
        }
    }
    for arg in cmdline.iter().rev() {
        if !arg.starts_with('-') && !arg.ends_with("java") && !arg.ends_with("java.exe") {
            return arg.rsplit('.').next().unwrap_or(arg).to_string();
        }
    }
    "java".to_string()
}

// ─── Java Server Discovery (native) ─────────────────────────────

/// Information about a Java server process with a listening port.
#[derive(Debug, Clone, serde::Serialize)]
pub struct JavaServerInfo {
    pub pid: u32,
    pub port: u16,
    pub main_class: String,
    pub cmdline: Vec<String>,
}

/// Find a descendant process with a given name using sysinfo.
pub fn find_child_process_by_name(parent_pid: u32, target_name: &str) -> Option<u32> {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    find_child_by_name_recursive(&sys, sysinfo::Pid::from_u32(parent_pid), target_name)
}

fn find_child_by_name_recursive(sys: &System, parent: sysinfo::Pid, target: &str) -> Option<u32> {
    let children: Vec<sysinfo::Pid> = sys
        .processes()
        .values()
        .filter(|p| p.parent() == Some(parent))
        .map(|p| p.pid())
        .collect();

    for &child in &children {
        if let Some(proc) = sys.process(child) {
            if proc.name().to_string_lossy() == target {
                return Some(child.as_u32());
            }
        }
    }
    for &child in &children {
        if let Some(found) = find_child_by_name_recursive(sys, child, target) {
            return Some(found);
        }
    }
    None
}

/// Find a Java server from a process tree root.
pub fn find_java_server_pid(root_pid: u32) -> Option<JavaServerInfo> {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut java_pids = Vec::new();
    collect_java_pids_native(
        &sys,
        sysinfo::Pid::from_u32(root_pid),
        &mut java_pids,
        0,
        10,
    );

    let listening = get_listening_ports();
    find_server_among(&sys, &java_pids, &listening)
}

/// Find all Java processes whose CWD is under the terminal's CWD,
/// then return the one with a TCP listening port.
///
/// Uses sysinfo for process enumeration, but falls back to CLI (lsof)
/// for CWD lookup on macOS where sysinfo can't read cwd without entitlements.
pub fn find_java_server_by_cwd(cwd: &str) -> Option<JavaServerInfo> {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    // Find all java processes
    let java_pids: Vec<sysinfo::Pid> = sys
        .processes()
        .values()
        .filter(|p| p.name().to_string_lossy() == "java")
        .map(|p| p.pid())
        .collect();

    // Filter by CWD match — use sysinfo cwd first, fall back to lsof
    let matching: Vec<sysinfo::Pid> = java_pids
        .into_iter()
        .filter(|&pid| {
            // Try sysinfo cwd first
            let proc_cwd = sys
                .process(pid)
                .and_then(|p| p.cwd())
                .map(|c| c.to_string_lossy().to_string());

            // Fall back to lsof-based cwd if sysinfo returns None (macOS sandbox)
            let proc_cwd = proc_cwd.or_else(|| read_process_cwd(pid.as_u32()));

            proc_cwd
                .as_deref()
                .map(|java_cwd| java_cwd.starts_with(cwd) || cwd.starts_with(java_cwd))
                .unwrap_or(false)
        })
        .collect();

    let listening = get_listening_ports();
    find_server_among(&sys, &matching, &listening)
}

/// Among a set of java PIDs, find the one with a listening port.
fn find_server_among(
    sys: &System,
    pids: &[sysinfo::Pid],
    listening: &std::collections::HashMap<u32, u16>,
) -> Option<JavaServerInfo> {
    for &pid in pids {
        if let Some(&port) = listening.get(&pid.as_u32()) {
            // Get cmdline — try sysinfo first, fall back to CLI
            let cmdline = sys
                .process(pid)
                .map(|p| {
                    let cmd: Vec<String> = p
                        .cmd()
                        .iter()
                        .map(|s| s.to_string_lossy().to_string())
                        .collect();
                    cmd
                })
                .filter(|cmd| !cmd.is_empty())
                .or_else(|| read_cmdline_cli(pid.as_u32()))
                .unwrap_or_default();

            let main_class = extract_java_main_class(&cmdline);
            return Some(JavaServerInfo {
                pid: pid.as_u32(),
                port,
                main_class,
                cmdline,
            });
        }
    }
    None
}

/// Collect all java PIDs under a root using sysinfo.
fn collect_java_pids_native(
    sys: &System,
    pid: sysinfo::Pid,
    result: &mut Vec<sysinfo::Pid>,
    depth: u32,
    max_depth: u32,
) {
    if depth >= max_depth {
        return;
    }
    if let Some(proc) = sys.process(pid) {
        if proc.name().to_string_lossy() == "java" {
            result.push(pid);
        }
    }
    let children: Vec<sysinfo::Pid> = sys
        .processes()
        .values()
        .filter(|p| p.parent() == Some(pid))
        .map(|p| p.pid())
        .collect();
    for child in children {
        collect_java_pids_native(sys, child, result, depth + 1, max_depth);
    }
}

/// Get a map of PID -> listening TCP port for all processes.
/// Uses `lsof` on macOS (netstat2 can't see other processes' sockets).
/// Uses netstat2 on Linux where it works without restrictions.
fn get_listening_ports() -> std::collections::HashMap<u32, u16> {
    #[cfg(target_os = "linux")]
    {
        get_listening_ports_native()
    }
    #[cfg(not(target_os = "linux"))]
    {
        get_listening_ports_lsof()
    }
}

/// Native port detection via netstat2 (works on Linux).
#[cfg(target_os = "linux")]
fn get_listening_ports_native() -> std::collections::HashMap<u32, u16> {
    use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo};

    let mut result = std::collections::HashMap::new();
    let af = AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6;
    let proto = ProtocolFlags::TCP;

    if let Ok(sockets) = get_sockets_info(af, proto) {
        for socket in sockets {
            if let ProtocolSocketInfo::Tcp(tcp) = socket.protocol_socket_info {
                if tcp.state == netstat2::TcpState::Listen {
                    for pid in &socket.associated_pids {
                        result.entry(*pid).or_insert(tcp.local_port);
                    }
                }
            }
        }
    }
    result
}

/// Fallback: lsof-based port detection (macOS).
#[cfg(not(target_os = "linux"))]
fn get_listening_ports_lsof() -> std::collections::HashMap<u32, u16> {
    let mut result = std::collections::HashMap::new();
    let output = match std::process::Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pn"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return result,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current_pid: Option<u32> = None;

    // lsof -F pn output format:
    //   p<pid>       (process ID)
    //   n<name>      (socket name like "*:9090" or "[::]:8080")
    for line in stdout.lines() {
        if let Some(pid_str) = line.strip_prefix('p') {
            current_pid = pid_str.parse().ok();
        } else if let Some(name) = line.strip_prefix('n') {
            if let Some(pid) = current_pid {
                // Extract port from name like "*:9090" or "[::1]:8080"
                if let Some(port_str) = name.rsplit(':').next() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        result.entry(pid).or_insert(port);
                    }
                }
            }
        }
    }
    result
}

// ─── CLI Fallbacks for macOS (sysinfo can't read cmd/cwd without entitlements) ──

/// Read process command line via CLI (ps). Fallback for macOS.
fn read_cmdline_cli(pid: u32) -> Option<Vec<String>> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "args="])
        .output()
        .ok()?;
    let args_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if args_str.is_empty() {
        return None;
    }
    Some(args_str.split_whitespace().map(String::from).collect())
}

// ─── CWD Helper (used by get_pty_cwd, kept for backward compat) ──

/// Read the current working directory of a process by PID.
/// Used by PtyManager::get_cwd for the shell process.
#[cfg(target_os = "macos")]
fn read_process_cwd(pid: u32) -> Option<String> {
    // sysinfo provides cwd natively, but for the shell's child_pid
    // we use it via PtyManager::get_cwd → this function.
    // On macOS, sysinfo's cwd support requires the process to be refreshed,
    // so we use lsof as a reliable fallback for one-off lookups.
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix('n') {
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn read_process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_process_cwd(_pid: u32) -> Option<String> {
    None
}
