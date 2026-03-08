use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter};

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
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = handle.emit("pty-exit", sid);
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
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
}

/// Read the current working directory of a process by PID.
#[cfg(target_os = "macos")]
fn read_process_cwd(pid: u32) -> Option<String> {
    use std::process::Command;
    // On macOS, use lsof to get the cwd of the process
    let output = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // lsof output: lines starting with 'n' contain the path
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
