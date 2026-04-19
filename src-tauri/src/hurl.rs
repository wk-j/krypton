// Krypton — Hurl runner backend.
// Short-lived child processes (not PTYs), streaming line-batched events to
// the frontend keyed by a monotonic run_id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const CACHE_VERSION: u32 = 1;
const OUTPUT_CAP_BYTES: usize = 1_000_000;
const COALESCE_MS: u64 = 16;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct HurlFile {
    pub path: String,
    pub rel_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HurlListing {
    pub hurl_files: Vec<HurlFile>,
    pub env_files: Vec<HurlFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HurlRunArgs {
    pub file: String,
    pub cwd: String,
    #[serde(default)]
    pub verbose: bool,
    #[serde(default)]
    pub very_verbose: bool,
    #[serde(default)]
    pub variables_file: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HurlCachedRun {
    pub version: u32,
    pub file_path: String,
    pub file_mtime_ms: u64,
    pub started_at: u64,
    pub finished_at: u64,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub verbose: bool,
    pub very_verbose: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HurlSidebarState {
    pub version: u32,
    pub cwd: String,
    pub expanded: Vec<String>,
    pub selected_rel_path: Option<String>,
    pub view_mode: String,
    pub verbose: bool,
    pub very_verbose: bool,
    pub active_env_file: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Serialize)]
struct HurlOutputEvent {
    run_id: u64,
    stream: &'static str,
    chunk: String,
}

#[derive(Clone, Serialize)]
struct HurlFinishedEvent {
    run_id: u64,
    exit_code: i32,
    duration_ms: u64,
}

// ─── State ──────────────────────────────────────────────────────────

#[derive(Default)]
pub struct HurlState {
    next_run_id: AtomicU64,
    children: Mutex<HashMap<u64, Child>>,
    binary_path: OnceLock<Option<PathBuf>>,
}

// ─── Binary resolution ─────────────────────────────────────────────

fn resolve_hurl_binary(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }

    // Try current process PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = Path::new(dir).join("hurl");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // macOS GUI fallback: ask a login shell.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", "which hurl"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let val = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if val.is_empty() {
        None
    } else {
        let pb = PathBuf::from(val);
        if pb.is_file() {
            Some(pb)
        } else {
            None
        }
    }
}

fn get_binary(
    state: &HurlState,
    config: &Arc<std::sync::RwLock<crate::config::KryptonConfig>>,
) -> Result<PathBuf, String> {
    let resolved = state.binary_path.get_or_init(|| {
        let override_path = config
            .read()
            .ok()
            .and_then(|cfg| cfg.hurl.binary_path.clone())
            .filter(|s| !s.is_empty());
        resolve_hurl_binary(override_path.as_deref())
    });
    resolved
        .clone()
        .ok_or_else(|| "hurl binary not found — install from https://hurl.dev".to_string())
}

// ─── Cache paths ────────────────────────────────────────────────────

fn sha256_hex(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    let digest = h.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hurl_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    Ok(base.join("hurl"))
}

fn cache_file_for(app: &AppHandle, file_path: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(file_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| file_path.to_string());
    let hex = sha256_hex(&canonical);
    Ok(hurl_cache_root(app)?.join(format!("{hex}.json")))
}

fn sidebar_state_file_for(app: &AppHandle, cwd: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| cwd.to_string());
    let hex = sha256_hex(&canonical);
    Ok(hurl_cache_root(app)?
        .join("state")
        .join(format!("{hex}.json")))
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir cache: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("write cache tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename cache: {e}"))?;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate_output(mut stdout: String, mut stderr: String) -> (String, String) {
    let marker = "\n... [truncated]";
    let total = stdout.len() + stderr.len();
    if total <= OUTPUT_CAP_BYTES {
        return (stdout, stderr);
    }
    let mut overflow = total - OUTPUT_CAP_BYTES + marker.len();
    if overflow >= stderr.len() {
        overflow -= stderr.len();
        stderr.clear();
        if overflow > 0 && overflow < stdout.len() {
            let cut = safe_char_boundary(&stdout, stdout.len() - overflow);
            stdout.truncate(cut);
            stdout.push_str(marker);
        }
    } else {
        let cut = safe_char_boundary(&stderr, stderr.len() - overflow);
        stderr.truncate(cut);
        stderr.push_str(marker);
    }
    (stdout, stderr)
}

fn safe_char_boundary(s: &str, mut idx: usize) -> usize {
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

// ─── Commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn list_hurl_files(cwd: String) -> Result<HurlListing, String> {
    use ignore::WalkBuilder;

    let root = Path::new(&cwd);
    if !root.is_dir() {
        return Err(format!("Not a directory: {cwd}"));
    }

    const MAX: usize = 10_000;
    let mut hurl = Vec::new();
    let mut envs = Vec::new();

    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let Some(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            continue;
        }

        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Skip dotfiles like .env / .env.local
        if file_name.starts_with('.') {
            continue;
        }

        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| file_name.clone());

        let hf = HurlFile {
            path: path.to_string_lossy().to_string(),
            rel_path: rel,
            name: file_name,
        };

        if ext.eq_ignore_ascii_case("hurl") {
            hurl.push(hf);
            if hurl.len() + envs.len() >= MAX {
                break;
            }
        } else if ext.eq_ignore_ascii_case("env") {
            envs.push(hf);
            if hurl.len() + envs.len() >= MAX {
                break;
            }
        }
    }

    hurl.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    envs.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    Ok(HurlListing {
        hurl_files: hurl,
        env_files: envs,
    })
}

#[tauri::command]
pub async fn hurl_run(
    app: AppHandle,
    state: State<'_, Arc<HurlState>>,
    config: State<'_, Arc<std::sync::RwLock<crate::config::KryptonConfig>>>,
    args: HurlRunArgs,
) -> Result<u64, String> {
    let binary = get_binary(&state, &config)?;

    let mut cmd = Command::new(&binary);
    cmd.arg("--color").arg("--pretty").arg("--include");
    if args.very_verbose {
        cmd.arg("--very-verbose");
    } else if args.verbose {
        cmd.arg("--verbose");
    }
    if let Some(vf) = args.variables_file.as_ref() {
        if !vf.is_empty() {
            cmd.arg("--variables-file").arg(vf);
        }
    }
    for extra in &args.extra_args {
        cmd.arg(extra);
    }
    cmd.arg(&args.file);
    cmd.current_dir(&args.cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn hurl: {e}"))?;

    let run_id = state.next_run_id.fetch_add(1, Ordering::SeqCst);
    let started_at = now_ms();
    let start_instant = Instant::now();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut map = state.children.lock().await;
        map.insert(run_id, child);
    }

    // Spawn reader tasks
    if let Some(out) = stdout {
        let app_c = app.clone();
        tokio::spawn(stream_reader(app_c, run_id, "stdout", out));
    }
    if let Some(err) = stderr {
        let app_c = app.clone();
        tokio::spawn(stream_reader(app_c, run_id, "stderr", err));
    }

    // Wait for exit
    let app_for_wait = app.clone();
    let state_arc: Arc<HurlState> = Arc::clone(state.inner());
    let args_for_wait = args.clone();
    tokio::spawn(async move {
        let exit_code = {
            let mut map = state_arc.children.lock().await;
            match map.remove(&run_id) {
                Some(mut child) => match child.wait().await {
                    Ok(status) => status.code().unwrap_or(-1),
                    Err(_) => -1,
                },
                None => -1,
            }
        };
        let duration_ms = start_instant.elapsed().as_millis() as u64;

        // Note: frontend owns the accumulated output; Rust writes a cache
        // snapshot using a fresh read of process streams? We don't have
        // them here. Instead, the frontend calls hurl_save_cache below
        // with its captured output. We only emit the finished event.
        let _ = app_for_wait.emit(
            "hurl-finished",
            HurlFinishedEvent {
                run_id,
                exit_code,
                duration_ms,
            },
        );

        let _ = started_at;
        let _ = args_for_wait;
    });

    Ok(run_id)
}

async fn stream_reader<R>(app: AppHandle, run_id: u64, stream: &'static str, reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = BufReader::new(reader).lines();
    let mut pending = String::new();
    let mut last_flush = Instant::now();

    loop {
        let deadline = last_flush + Duration::from_millis(COALESCE_MS);
        let sleep = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline));
        tokio::pin!(sleep);

        tokio::select! {
            line = buf.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        pending.push_str(&l);
                        pending.push('\n');
                    }
                    Ok(None) => {
                        if !pending.is_empty() {
                            let _ = app.emit("hurl-output", HurlOutputEvent {
                                run_id, stream, chunk: std::mem::take(&mut pending),
                            });
                        }
                        break;
                    }
                    Err(_) => break,
                }
            }
            _ = &mut sleep => {
                if !pending.is_empty() {
                    let _ = app.emit("hurl-output", HurlOutputEvent {
                        run_id, stream, chunk: std::mem::take(&mut pending),
                    });
                }
                last_flush = Instant::now();
            }
        }
    }
}

#[tauri::command]
pub async fn hurl_cancel(state: State<'_, Arc<HurlState>>, run_id: u64) -> Result<(), String> {
    let mut map = state.children.lock().await;
    if let Some(child) = map.get_mut(&run_id) {
        let _ = child.start_kill();
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct HurlSaveCacheArgs {
    pub file_path: String,
    pub started_at: u64,
    pub finished_at: u64,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub verbose: bool,
    pub very_verbose: bool,
}

#[tauri::command]
pub fn hurl_save_cache(app: AppHandle, args: HurlSaveCacheArgs) -> Result<(), String> {
    let (stdout, stderr) = truncate_output(args.stdout, args.stderr);
    let mtime = file_mtime_ms(Path::new(&args.file_path));
    let entry = HurlCachedRun {
        version: CACHE_VERSION,
        file_path: args.file_path.clone(),
        file_mtime_ms: mtime,
        started_at: args.started_at,
        finished_at: args.finished_at,
        exit_code: args.exit_code,
        duration_ms: args.duration_ms,
        stdout,
        stderr,
        verbose: args.verbose,
        very_verbose: args.very_verbose,
    };
    let path = cache_file_for(&app, &args.file_path)?;
    let json = serde_json::to_string(&entry).map_err(|e| format!("serialize cache: {e}"))?;
    atomic_write(&path, &json)
}

#[tauri::command]
pub fn hurl_load_cached(
    app: AppHandle,
    file_path: String,
) -> Result<Option<HurlCachedRun>, String> {
    let path = cache_file_for(&app, &file_path)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    match serde_json::from_str::<HurlCachedRun>(&contents) {
        Ok(entry) => Ok(Some(entry)),
        Err(e) => {
            log::warn!("Corrupt hurl cache {}: {e}", path.display());
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn hurl_clear_cache(app: AppHandle, file_path: Option<String>) -> Result<(), String> {
    match file_path {
        Some(fp) => {
            let path = cache_file_for(&app, &fp)?;
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| format!("remove cache: {e}"))?;
            }
            Ok(())
        }
        None => {
            let root = hurl_cache_root(&app)?;
            if root.exists() {
                std::fs::remove_dir_all(&root).map_err(|e| format!("clear cache: {e}"))?;
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub fn hurl_load_sidebar_state(
    app: AppHandle,
    cwd: String,
) -> Result<Option<HurlSidebarState>, String> {
    let path = sidebar_state_file_for(&app, &cwd)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    match serde_json::from_str::<HurlSidebarState>(&contents) {
        Ok(s) => Ok(Some(s)),
        Err(e) => {
            log::warn!("Corrupt hurl sidebar state {}: {e}", path.display());
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn hurl_save_sidebar_state(app: AppHandle, state: HurlSidebarState) -> Result<(), String> {
    let path = sidebar_state_file_for(&app, &state.cwd)?;
    let json = serde_json::to_string(&state).map_err(|e| format!("serialize state: {e}"))?;
    atomic_write(&path, &json)
}
