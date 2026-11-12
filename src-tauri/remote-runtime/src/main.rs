use krypton_remote_protocol::{
    diff_stat, shell::shell_outcome, RemoteMethod, RemoteWorkspace, RuntimeError, RuntimeFrame,
    CAPABILITY_WORKSPACE_DIFF_STAT, CAPABILITY_WORKSPACE_SHELL, MAX_FRAME_BYTES, PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{
    self, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter, Lines,
    Stdin, Stdout,
};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, OnceCell};

type SharedWriter = Arc<Mutex<BufWriter<Stdout>>>;
/// Running `WorkspaceShell` commands by the app's shell id: the pid that leads
/// each one's process group.
type Shells = Arc<Mutex<HashMap<String, Option<u32>>>>;

/// Login-shell environment applied to every agent adapter (spec 247). The
/// runtime itself starts from `ssh host exec …`, a non-login command whose
/// environment is sshd's default — on macOS `PATH=/usr/bin:/bin:/usr/sbin:/sbin`
/// — so adapters installed through Homebrew, nvm and the like (`npx`,
/// `codex-acp`) would not resolve.
static LOGIN_ENV: OnceCell<HashMap<String, String>> = OnceCell::const_new();
const LOGIN_ENV_TIMEOUT: Duration = Duration::from_secs(10);

/// Output kept per `WorkspaceShell` command (spec 247). The app waits for that
/// reply with no deadline, so it must always fit one frame: at 4 MiB the
/// worst-case JSON encoding (6 bytes per byte, `\u00XX`) is 24 MiB, under
/// `MAX_FRAME_BYTES`. A reply that did not fit would be dropped unsent.
const SHELL_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
/// SIGTERM to SIGKILL for a killed shell, the same grace `terminate_pid` gives.
const KILL_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug)]
struct RemoteAgent {
    stdin: ChildStdin,
    pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSpawnParams {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentWriteParams {
    agent_id: u64,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdParams {
    agent_id: u64,
}

#[derive(Debug, Deserialize)]
struct PathParams {
    path: String,
}

#[derive(Debug, Deserialize)]
struct WriteParams {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct RemoveParams {
    path: String,
    #[serde(default)]
    recursive: bool,
}

#[derive(Debug, Deserialize)]
struct RunParams {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
}

#[derive(Debug, Deserialize)]
struct CwdParams {
    cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellParams {
    shell_id: String,
    command: String,
    cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellIdParams {
    shell_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayParams {
    backend: String,
    harness_id: String,
    lane_label: Option<String>,
    file_name: Option<String>,
    content: Option<String>,
}

#[tokio::main]
async fn main() {
    match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [command] if command == "version" => match version_line() {
            Ok(line) => {
                println!("{line}");
                return;
            }
            Err(error) => {
                eprintln!("krypton-remote: {error}");
                std::process::exit(1);
            }
        },
        [command, transport] if command == "serve" && transport == "--stdio" => {}
        _ => {
            eprintln!("usage: krypton-remote <version|serve --stdio>");
            std::process::exit(2);
        }
    }
    if let Err(error) = serve().await {
        eprintln!("krypton-remote: {error}");
        std::process::exit(1);
    }
}

/// The bootstrap probe line (spec 247). The SHA-256 of this executable lets
/// the app replace a cached helper whose bytes differ from the one it ships,
/// even when protocol and package version are unchanged.
fn version_line() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("locate executable: {e}"))?;
    let mut file = std::fs::File::open(&exe).map_err(|e| format!("open {}: {e}", exe.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("read {}: {e}", exe.display()))?;
    let mut line = format!(
        "protocol={PROTOCOL_VERSION} version={} sha256=",
        env!("CARGO_PKG_VERSION")
    );
    for byte in hasher.finalize() {
        let _ = write!(line, "{byte:02x}");
    }
    Ok(line)
}

async fn serve() -> Result<(), String> {
    let mut lines = BufReader::new(io::stdin()).lines();
    let writer = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let hello = read_frame(&mut lines)
        .await?
        .ok_or_else(|| "stdin closed before hello".to_string())?;
    let RuntimeFrame::Hello {
        protocol,
        workspace,
        ..
    } = hello
    else {
        return Err("first frame must be hello".to_string());
    };
    if protocol != PROTOCOL_VERSION {
        return Err(format!(
            "protocol mismatch: local={protocol}, remote={PROTOCOL_VERSION}"
        ));
    }
    let root = tokio::fs::canonicalize(&workspace.path)
        .await
        .map_err(|e| format!("invalid workspace {}: {e}", workspace.path))?;
    if !root.is_dir() {
        return Err(format!("workspace is not a directory: {}", root.display()));
    }
    let runtime_nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("runtime clock: {e}"))?
        .as_nanos();
    let runtime_root = std::env::temp_dir().join(format!(
        "krypton-remote-{}-{runtime_nonce}",
        std::process::id()
    ));
    tokio::fs::create_dir_all(&runtime_root)
        .await
        .map_err(|e| format!("create runtime directory: {e}"))?;
    #[cfg(unix)]
    tokio::fs::set_permissions(
        &runtime_root,
        <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o700),
    )
    .await
    .map_err(|e| format!("secure runtime directory: {e}"))?;
    write_frame(
        &writer,
        &RuntimeFrame::Hello {
            protocol: PROTOCOL_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            workspace: RemoteWorkspace {
                path: root.to_string_lossy().to_string(),
            },
            capabilities: vec![
                "agent_stdio".to_string(),
                "runtime_overlays".to_string(),
                "workspace_fs".to_string(),
                "workspace_run".to_string(),
                CAPABILITY_WORKSPACE_DIFF_STAT.to_string(),
                CAPABILITY_WORKSPACE_SHELL.to_string(),
            ],
        },
    )
    .await?;

    let agents: Arc<Mutex<HashMap<u64, RemoteAgent>>> = Arc::new(Mutex::new(HashMap::new()));
    let shells: Shells = Arc::new(Mutex::new(HashMap::new()));
    let mut next_agent_id = 1_u64;
    while let Some(frame) = read_frame(&mut lines).await? {
        let RuntimeFrame::Request { id, method, params } = frame else {
            return Err("expected request frame".to_string());
        };
        if method == RemoteMethod::RuntimeShutdown {
            write_response(&writer, id, Ok(json!({}))).await?;
            tokio::join!(terminate_all(&agents), terminate_shells(&shells));
            let _ = tokio::fs::remove_dir_all(&runtime_root).await;
            return Ok(());
        }
        if method == RemoteMethod::WorkspaceDiffStat {
            // Polled every few seconds per window showing this Harness (spec
            // 220): answer it off the request loop, so a slow repo never holds
            // up agent input queued behind it.
            let writer = writer.clone();
            let root = root.clone();
            tokio::spawn(async move {
                let outcome = workspace_diff_stat(params, &root).await;
                let _ = write_response(&writer, id, outcome).await;
            });
            continue;
        }
        if method == RemoteMethod::WorkspaceShell {
            // A typed `!` command runs as long as it runs (spec 247). It is
            // spawned and registered here, so a kill sent after it always finds
            // it, and awaited off the loop, so agent input never queues behind it.
            match spawn_shell(params, &root, &shells).await {
                Ok((shell_id, child)) => {
                    let writer = writer.clone();
                    let shells = shells.clone();
                    tokio::spawn(async move {
                        let outcome = finish_shell(child, shell_id, &shells).await;
                        let _ = write_response(&writer, id, outcome).await;
                    });
                }
                Err(error) => write_response(&writer, id, Err(error)).await?,
            }
            continue;
        }
        if method == RemoteMethod::WorkspaceShellKill {
            let outcome = kill_shell(params, &shells).await;
            write_response(&writer, id, outcome).await?;
            continue;
        }
        let outcome = handle_request(
            method,
            params,
            &root,
            &runtime_root,
            &agents,
            &writer,
            &mut next_agent_id,
        )
        .await;
        write_response(&writer, id, outcome).await?;
    }
    tokio::join!(terminate_all(&agents), terminate_shells(&shells));
    let _ = tokio::fs::remove_dir_all(&runtime_root).await;
    Ok(())
}

async fn handle_request(
    method: RemoteMethod,
    params: Value,
    root: &Path,
    runtime_root: &Path,
    agents: &Arc<Mutex<HashMap<u64, RemoteAgent>>>,
    writer: &SharedWriter,
    next_agent_id: &mut u64,
) -> Result<Value, RuntimeError> {
    match method {
        RemoteMethod::RuntimeShutdown
        | RemoteMethod::WorkspaceDiffStat
        | RemoteMethod::WorkspaceShell
        | RemoteMethod::WorkspaceShellKill => {
            unreachable!("handled by serve loop")
        }
        RemoteMethod::AgentSpawn => {
            let params: AgentSpawnParams = parse_params(params)?;
            let cwd = resolve_scoped(root, &params.cwd).await?;
            let mut command = Command::new(&params.command);
            command
                .args(&params.args)
                .envs(login_env().await)
                .envs(&params.env)
                .current_dir(cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(unix)]
            command.process_group(0);
            let mut child = command.spawn().map_err(|e| {
                RuntimeError::new("agent_spawn_failed", format!("{}: {e}", params.command))
            })?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| RuntimeError::new("agent_spawn_failed", "child stdin missing"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| RuntimeError::new("agent_spawn_failed", "child stdout missing"))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| RuntimeError::new("agent_spawn_failed", "child stderr missing"))?;
            let agent_id = *next_agent_id;
            *next_agent_id += 1;
            agents.lock().await.insert(
                agent_id,
                RemoteAgent {
                    stdin,
                    pid: child.id(),
                },
            );
            spawn_output_reader(agent_id, "agent_stdout", stdout, writer.clone());
            spawn_output_reader(agent_id, "agent_stderr", stderr, writer.clone());
            let exit_writer = writer.clone();
            let exit_agents = agents.clone();
            tokio::spawn(async move {
                let status = child.wait().await;
                exit_agents.lock().await.remove(&agent_id);
                let payload = match status {
                    Ok(status) => json!({
                        "agentId": agent_id,
                        "code": status.code(),
                        "success": status.success(),
                    }),
                    Err(error) => json!({
                        "agentId": agent_id,
                        "code": null,
                        "success": false,
                        "error": error.to_string(),
                    }),
                };
                let _ = write_frame(
                    &exit_writer,
                    &RuntimeFrame::Event {
                        topic: "agent_exit".to_string(),
                        payload,
                    },
                )
                .await;
            });
            Ok(json!({ "agentId": agent_id }))
        }
        RemoteMethod::AgentWrite => {
            let params: AgentWriteParams = parse_params(params)?;
            let mut guard = agents.lock().await;
            let agent = guard.get_mut(&params.agent_id).ok_or_else(|| {
                RuntimeError::new(
                    "unknown_agent",
                    format!("unknown agent {}", params.agent_id),
                )
            })?;
            agent
                .stdin
                .write_all(params.data.as_bytes())
                .await
                .map_err(io_error("agent_write_failed"))?;
            agent
                .stdin
                .flush()
                .await
                .map_err(io_error("agent_write_failed"))?;
            Ok(json!({}))
        }
        RemoteMethod::AgentTerminate => {
            let params: AgentIdParams = parse_params(params)?;
            let agent = agents.lock().await.remove(&params.agent_id);
            if let Some(agent) = agent {
                terminate_pid(agent.pid).await;
            }
            Ok(json!({}))
        }
        RemoteMethod::RuntimeOverlayWrite => {
            let params: OverlayParams = parse_params(params)?;
            let path = overlay_path(runtime_root, &params, true)?;
            let content = params.content.ok_or_else(|| {
                RuntimeError::new("invalid_params", "overlay write requires content")
            })?;
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(io_error("mkdir_failed"))?;
            }
            tokio::fs::write(&path, content)
                .await
                .map_err(io_error("write_failed"))?;
            #[cfg(unix)]
            tokio::fs::set_permissions(
                &path,
                <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o600),
            )
            .await
            .map_err(io_error("chmod_failed"))?;
            Ok(json!({
                "path": path.to_string_lossy(),
                "dir": path.parent().map(|value| value.to_string_lossy()),
            }))
        }
        RemoteMethod::RuntimeOverlayRemove => {
            let params: OverlayParams = parse_params(params)?;
            let path = overlay_path(runtime_root, &params, false)?;
            match tokio::fs::remove_dir_all(path).await {
                Ok(()) => Ok(json!({})),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
                Err(error) => Err(io_error("remove_failed")(error)),
            }
        }
        RemoteMethod::WorkspaceCanonicalize => {
            let params: PathParams = parse_params(params)?;
            let path = resolve_scoped(root, &params.path).await?;
            Ok(json!({ "path": path.to_string_lossy() }))
        }
        RemoteMethod::WorkspaceRead => {
            let params: PathParams = parse_params(params)?;
            let path = resolve_scoped(root, &params.path).await?;
            match tokio::fs::read_to_string(path).await {
                Ok(content) => Ok(json!({ "exists": true, "content": content })),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(json!({ "exists": false, "content": "" }))
                }
                Err(error) => Err(RuntimeError::new("read_failed", error.to_string())),
            }
        }
        RemoteMethod::WorkspaceWrite => {
            let params: WriteParams = parse_params(params)?;
            let path = resolve_scoped(root, &params.path).await?;
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(io_error("mkdir_failed"))?;
            }
            tokio::fs::write(path, params.content)
                .await
                .map_err(io_error("write_failed"))?;
            Ok(json!({}))
        }
        RemoteMethod::WorkspaceRemove => {
            let params: RemoveParams = parse_params(params)?;
            let path = resolve_scoped(root, &params.path).await?;
            let metadata = match tokio::fs::metadata(&path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(json!({}));
                }
                Err(error) => return Err(io_error("stat_failed")(error)),
            };
            if metadata.is_dir() {
                if !params.recursive {
                    return Err(RuntimeError::new(
                        "recursive_required",
                        "directory removal requires recursive=true",
                    ));
                }
                tokio::fs::remove_dir_all(path)
                    .await
                    .map_err(io_error("remove_failed"))?;
            } else {
                tokio::fs::remove_file(path)
                    .await
                    .map_err(io_error("remove_failed"))?;
            }
            Ok(json!({}))
        }
        RemoteMethod::WorkspaceStat => {
            let params: PathParams = parse_params(params)?;
            let path = resolve_scoped(root, &params.path).await?;
            match tokio::fs::metadata(path).await {
                Ok(meta) => Ok(json!({
                    "exists": true,
                    "isFile": meta.is_file(),
                    "isDir": meta.is_dir(),
                    "len": meta.len(),
                })),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(json!({ "exists": false }))
                }
                Err(error) => Err(RuntimeError::new("stat_failed", error.to_string())),
            }
        }
        RemoteMethod::WorkspaceReadDir => {
            let params: PathParams = parse_params(params)?;
            let path = resolve_scoped(root, &params.path).await?;
            let mut entries = tokio::fs::read_dir(path)
                .await
                .map_err(io_error("read_dir_failed"))?;
            let mut out = Vec::new();
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(io_error("read_dir_failed"))?
            {
                let ty = entry.file_type().await.map_err(io_error("stat_failed"))?;
                out.push(json!({
                    "name": entry.file_name().to_string_lossy(),
                    "path": entry.path().to_string_lossy(),
                    "isFile": ty.is_file(),
                    "isDir": ty.is_dir(),
                }));
            }
            Ok(json!({ "entries": out }))
        }
        RemoteMethod::WorkspaceRun => {
            let params: RunParams = parse_params(params)?;
            validate_run(&params)?;
            let output = Command::new(&params.program)
                .args(&params.args)
                .current_dir(resolve_scoped(root, &params.cwd).await?)
                .output()
                .await
                .map_err(io_error("run_failed"))?;
            Ok(json!({
                "success": output.status.success(),
                "code": output.status.code(),
                "stdout": String::from_utf8_lossy(&output.stdout),
                "stderr": String::from_utf8_lossy(&output.stderr),
            }))
        }
    }
}

/// The window rail's diff stat for a workspace cwd (specs 220, 247): the same
/// `diff_stat::working_diff_stat` the app runs for a local project, so a remote
/// Harness reports the counts a local one would.
async fn workspace_diff_stat(params: Value, root: &Path) -> Result<Value, RuntimeError> {
    let params: CwdParams = parse_params(params)?;
    let cwd = resolve_scoped(root, &params.cwd).await?;
    let stat =
        tokio::task::spawn_blocking(move || diff_stat::working_diff_stat(&cwd.to_string_lossy()))
            .await
            .map_err(|e| RuntimeError::new("diff_stat_failed", e.to_string()))?
            .map_err(|e| RuntimeError::new("diff_stat_failed", e))?;
    serde_json::to_value(stat).map_err(|e| RuntimeError::new("diff_stat_failed", e.to_string()))
}

/// Spawn a typed `!` command (spec 247): `/bin/sh -c` in a workspace cwd with
/// the login-shell environment, in its own process group, and with no stdin —
/// the runtime's stdin is the protocol stream. It is registered under the
/// app's shell id before this returns to the request loop.
async fn spawn_shell(
    params: Value,
    root: &Path,
    shells: &Shells,
) -> Result<(String, Child), RuntimeError> {
    let params: ShellParams = parse_params(params)?;
    let cwd = resolve_scoped(root, &params.cwd).await?;
    let env = login_env().await;
    let mut registry = shells.lock().await;
    if registry.contains_key(&params.shell_id) {
        return Err(RuntimeError::new(
            "duplicate_shell",
            format!("shell {} is already running", params.shell_id),
        ));
    }
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(&params.command)
        .envs(env)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|e| RuntimeError::new("shell_spawn_failed", e.to_string()))?;
    registry.insert(params.shell_id.clone(), child.id());
    Ok((params.shell_id, child))
}

/// Await a spawned shell and answer `{ ok, output }`. Whatever the command
/// itself did — exit status, signal, output over the cap — is `ok: false`, not
/// a protocol error, and reads exactly as a local `!shell` row would.
async fn finish_shell(
    mut child: Child,
    shell_id: String,
    shells: &Shells,
) -> Result<Value, RuntimeError> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (stdout, stderr, status) =
        tokio::join!(read_capped(stdout), read_capped(stderr), child.wait());
    shells.lock().await.remove(&shell_id);
    let status = status.map_err(io_error("shell_wait_failed"))?;
    let (ok, output) = if stdout.len() + stderr.len() > SHELL_OUTPUT_LIMIT {
        (
            false,
            format!(
                "Shell output exceeded {} MiB limit",
                SHELL_OUTPUT_LIMIT / (1024 * 1024)
            ),
        )
    } else {
        match shell_outcome(&status, &stdout, &stderr) {
            Ok(output) => (true, output),
            Err(output) => (false, output),
        }
    };
    Ok(json!({ "ok": ok, "output": output }))
}

/// Read a pipe to EOF, keeping one byte past `SHELL_OUTPUT_LIMIT` at most —
/// enough to know the limit was crossed — and discarding the rest, so the
/// command never blocks on a full pipe. A read error ends the stream.
async fn read_capped<R: AsyncRead + Unpin>(reader: Option<R>) -> Vec<u8> {
    let mut kept = Vec::new();
    let Some(mut reader) = reader else {
        return kept;
    };
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return kept,
            Ok(read) => {
                let room = (SHELL_OUTPUT_LIMIT + 1).saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..read.min(room)]);
            }
        }
    }
}

/// SIGTERM a running shell's process group and answer at once. SIGKILL
/// follows `KILL_GRACE` later if the same shell is still registered.
async fn kill_shell(params: Value, shells: &Shells) -> Result<Value, RuntimeError> {
    let params: ShellIdParams = parse_params(params)?;
    let pid = shells
        .lock()
        .await
        .get(&params.shell_id)
        .copied()
        .ok_or_else(|| {
            RuntimeError::new(
                "unknown_shell",
                format!("no shell with id {}", params.shell_id),
            )
        })?;
    #[cfg(unix)]
    signal_group(pid, libc::SIGTERM);
    let shells = shells.clone();
    tokio::spawn(async move {
        tokio::time::sleep(KILL_GRACE).await;
        if shells.lock().await.get(&params.shell_id) == Some(&pid) {
            #[cfg(unix)]
            signal_group(pid, libc::SIGKILL);
        }
    });
    Ok(json!({}))
}

#[cfg(unix)]
fn signal_group(pid: Option<u32>, signal: libc::c_int) {
    if let Some(pid) = pid {
        // SAFETY: kill(2) takes plain integers and touches no memory.
        unsafe {
            libc::kill(-(pid as i32), signal);
        }
    }
}

fn overlay_path(
    runtime_root: &Path,
    params: &OverlayParams,
    require_file: bool,
) -> Result<PathBuf, RuntimeError> {
    if params.backend != "cline" {
        return Err(RuntimeError::new(
            "invalid_overlay",
            "unsupported overlay backend",
        ));
    }
    let mut path = runtime_root
        .join(safe_path_part(&params.backend))
        .join(safe_path_part(&params.harness_id));
    if let Some(lane) = params.lane_label.as_deref() {
        path.push(safe_path_part(lane));
    }
    if require_file {
        let file_name = params.file_name.as_deref().ok_or_else(|| {
            RuntimeError::new("invalid_params", "overlay write requires fileName")
        })?;
        if file_name != "cline_mcp_settings.json" {
            return Err(RuntimeError::new(
                "invalid_overlay",
                "unsupported overlay file",
            ));
        }
        path.push(file_name);
    }
    Ok(path)
}

fn safe_path_part(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn validate_run(params: &RunParams) -> Result<(), RuntimeError> {
    let allowed = match params.program.as_str() {
        "git" => {
            let safe_global_args = !params.args.iter().any(|arg| {
                arg == "-C"
                    || arg.starts_with("--git-dir")
                    || arg.starts_with("--work-tree")
                    || arg.starts_with("--output")
                    || arg == "--ext-diff"
            });
            let read_only_subcommand = match params.args.as_slice() {
                [branch, flag] if branch == "branch" && flag == "--show-current" => true,
                [command, ..] => matches!(
                    command.as_str(),
                    "rev-parse" | "diff" | "status" | "ls-files"
                ),
                [] => false,
            };
            safe_global_args && read_only_subcommand
        }
        "gh" => matches!(
            params.args.as_slice(),
            [first, second, ..]
                if first == "issue" && matches!(second.as_str(), "view" | "list")
        ),
        "cursor-agent" => matches!(
            params.args.as_slice(),
            [first, second, name]
                if first == "mcp"
                    && second == "enable"
                    && !name.is_empty()
                    && !name.starts_with('-')
        ),
        "printenv" => matches!(
            params.args.as_slice(),
            [name]
                if name
                    .chars()
                    .enumerate()
                    .all(|(index, ch)| ch == '_' || ch.is_ascii_alphanumeric() && (index > 0 || !ch.is_ascii_digit()))
        ),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(RuntimeError::new(
            "program_not_allowed",
            format!("{} arguments are not allowed", params.program),
        ))
    }
}

fn spawn_output_reader<R>(agent_id: u64, topic: &'static str, reader: R, writer: SharedWriter)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let frame = RuntimeFrame::Event {
                        topic: topic.to_string(),
                        payload: json!({ "agentId": agent_id, "line": line }),
                    };
                    if write_frame(&writer, &frame).await.is_err() {
                        return;
                    }
                }
                Ok(None) => return,
                Err(error) => {
                    let _ = write_frame(
                        &writer,
                        &RuntimeFrame::Event {
                            topic: topic.to_string(),
                            payload: json!({
                                "agentId": agent_id,
                                "line": format!("stream read failed: {error}"),
                            }),
                        },
                    )
                    .await;
                    return;
                }
            }
        }
    });
}

/// Snapshot `$SHELL -l -c '/usr/bin/env -0'` once, the remote counterpart of
/// the app's local `pty::cached_login_env`. Failure or timeout yields an empty
/// map, leaving the runtime's own environment in place.
async fn login_env() -> &'static HashMap<String, String> {
    LOGIN_ENV
        .get_or_init(|| async {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let mut command = Command::new(shell);
            // stdin is the framed protocol channel; the probe shell must not read it.
            command
                .args(["-l", "-c", "/usr/bin/env -0"])
                .stdin(Stdio::null())
                .kill_on_drop(true);
            match tokio::time::timeout(LOGIN_ENV_TIMEOUT, command.output()).await {
                Ok(Ok(output)) => parse_env_block(&output.stdout),
                _ => HashMap::new(),
            }
        })
        .await
}

/// Parse NUL-separated `env -0` output, dropping variables that describe the
/// probe shell rather than the adapter it is captured for.
fn parse_env_block(bytes: &[u8]) -> HashMap<String, String> {
    bytes
        .split(|&byte| byte == 0)
        .filter_map(|entry| std::str::from_utf8(entry).ok()?.split_once('='))
        .filter(|(key, _)| {
            !matches!(
                *key,
                "" | "TERM" | "COLORTERM" | "PWD" | "OLDPWD" | "SHLVL" | "_"
            )
        })
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

async fn read_frame(lines: &mut Lines<BufReader<Stdin>>) -> Result<Option<RuntimeFrame>, String> {
    let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if line.len() > MAX_FRAME_BYTES {
        return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
    }
    serde_json::from_str(&line)
        .map(Some)
        .map_err(|e| format!("invalid frame: {e}"))
}

async fn write_frame(writer: &SharedWriter, frame: &RuntimeFrame) -> Result<(), String> {
    let mut line = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
    if line.len() > MAX_FRAME_BYTES {
        return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
    }
    line.push(b'\n');
    let mut guard = writer.lock().await;
    guard.write_all(&line).await.map_err(|e| e.to_string())?;
    guard.flush().await.map_err(|e| e.to_string())
}

async fn write_response(
    writer: &SharedWriter,
    id: u64,
    outcome: Result<Value, RuntimeError>,
) -> Result<(), String> {
    let (result, error) = match outcome {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    write_frame(writer, &RuntimeFrame::Response { id, result, error }).await
}

fn parse_params<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, RuntimeError> {
    serde_json::from_value(value).map_err(|e| RuntimeError::new("invalid_params", e.to_string()))
}

fn require_absolute(path: &str) -> Result<PathBuf, RuntimeError> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(RuntimeError::new(
            "invalid_path",
            "remote path must be absolute",
        ))
    }
}

async fn canonicalize_allow_missing(path: &str) -> std::io::Result<PathBuf> {
    let absolute = require_absolute(path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e.message))?;
    let mut probe = absolute.clone();
    let mut suffix = Vec::new();
    loop {
        match tokio::fs::canonicalize(&probe).await {
            Ok(mut canonical) => {
                for part in suffix.iter().rev() {
                    canonical.push(part);
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = probe.file_name().map(|name| name.to_os_string()) else {
                    return Err(error);
                };
                suffix.push(name);
                let Some(parent) = probe.parent() else {
                    return Err(error);
                };
                probe = parent.to_path_buf();
            }
            Err(error) => return Err(error),
        }
    }
}

async fn resolve_scoped(root: &Path, path: &str) -> Result<PathBuf, RuntimeError> {
    let resolved = canonicalize_allow_missing(path)
        .await
        .map_err(io_error("canonicalize_failed"))?;
    if resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err(RuntimeError::new(
            "path_outside_workspace",
            format!("path is outside workspace: {path}"),
        ))
    }
}

fn io_error(code: &'static str) -> impl FnOnce(std::io::Error) -> RuntimeError {
    move |error| RuntimeError::new(code, error.to_string())
}

async fn terminate_all(agents: &Arc<Mutex<HashMap<u64, RemoteAgent>>>) {
    let drained = agents
        .lock()
        .await
        .drain()
        .map(|(_, agent)| agent)
        .collect::<Vec<_>>();
    for agent in drained {
        terminate_pid(agent.pid).await;
    }
}

async fn terminate_shells(shells: &Shells) {
    let drained = shells
        .lock()
        .await
        .drain()
        .map(|(_, pid)| pid)
        .collect::<Vec<_>>();
    for pid in drained {
        terminate_pid(pid).await;
    }
}

async fn terminate_pid(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "krypton-remote-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[tokio::test]
    async fn scoped_paths_accept_missing_children_inside_workspace() {
        let root = temp_root("inside");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let root = tokio::fs::canonicalize(root).await.unwrap();
        let resolved = resolve_scoped(&root, root.join("new/file.txt").to_str().unwrap())
            .await
            .unwrap();
        assert!(resolved.starts_with(&root));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn scoped_paths_reject_absolute_paths_outside_workspace() {
        let root = temp_root("outside");
        let outside = temp_root("sentinel");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::create_dir_all(&outside).await.unwrap();
        let root = tokio::fs::canonicalize(root).await.unwrap();
        let error = resolve_scoped(&root, outside.to_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(error.code, "path_outside_workspace");
        tokio::fs::remove_dir_all(root).await.unwrap();
        tokio::fs::remove_dir_all(outside).await.unwrap();
    }

    #[test]
    fn run_allowlist_is_read_only_and_rejects_git_path_overrides() {
        let allowed = RunParams {
            program: "git".into(),
            args: vec!["diff".into(), "HEAD".into()],
            cwd: "/workspace".into(),
        };
        assert!(validate_run(&allowed).is_ok());
        let escaped = RunParams {
            program: "git".into(),
            args: vec!["-C".into(), "/etc".into(), "status".into()],
            cwd: "/workspace".into(),
        };
        assert_eq!(
            validate_run(&escaped).unwrap_err().code,
            "program_not_allowed"
        );
        let destructive = RunParams {
            program: "git".into(),
            args: vec!["branch".into(), "-D".into(), "main".into()],
            cwd: "/workspace".into(),
        };
        assert_eq!(
            validate_run(&destructive).unwrap_err().code,
            "program_not_allowed"
        );
    }

    #[test]
    fn overlay_paths_are_scoped_and_sanitized() {
        let root = PathBuf::from("/tmp/krypton-runtime");
        let params = OverlayParams {
            backend: "cline".into(),
            harness_id: "hm/1".into(),
            lane_label: Some("Cline ../1".into()),
            file_name: Some("cline_mcp_settings.json".into()),
            content: Some("{}".into()),
        };
        let path = overlay_path(&root, &params, true).unwrap();
        assert!(path.starts_with(&root));
        assert_eq!(
            path.file_name().and_then(|value| value.to_str()),
            Some("cline_mcp_settings.json")
        );

        let removed = OverlayParams {
            backend: "junie".into(),
            harness_id: "h1".into(),
            lane_label: Some("removed-1".into()),
            file_name: Some("mcp.json".into()),
            content: Some("{}".into()),
        };
        for require_file in [true, false] {
            assert_eq!(
                overlay_path(&root, &removed, require_file)
                    .unwrap_err()
                    .code,
                "invalid_overlay"
            );
        }

        let mut invalid = params;
        invalid.file_name = Some("mcp.json".into());
        assert_eq!(
            overlay_path(&root, &invalid, true).unwrap_err().code,
            "invalid_overlay"
        );
        invalid.file_name = Some("../../secret".into());
        assert_eq!(
            overlay_path(&root, &invalid, true).unwrap_err().code,
            "invalid_overlay"
        );
    }

    async fn workspace(label: &str) -> PathBuf {
        let root = temp_root(label);
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::canonicalize(root).await.unwrap()
    }

    fn shell_params(id: &str, command: &str, cwd: &Path) -> Value {
        json!({ "shellId": id, "command": command, "cwd": cwd.to_str().unwrap() })
    }

    async fn run_shell(root: &Path, shells: &Shells, id: &str, command: &str) -> Value {
        let (shell_id, child) = spawn_shell(shell_params(id, command, root), root, shells)
            .await
            .unwrap();
        finish_shell(child, shell_id, shells).await.unwrap()
    }

    #[tokio::test]
    async fn shell_starts_in_the_workspace_and_never_reads_the_protocol_stream() {
        let root = workspace("shell-cwd").await;
        let shells: Shells = Arc::default();
        // `cat` with no file reads stdin: it must see EOF at once, not the
        // runtime's request frames.
        let reply = tokio::time::timeout(
            Duration::from_secs(10),
            run_shell(&root, &shells, "a", "pwd; cat"),
        )
        .await
        .expect("the shell inherited the protocol stdin");
        assert_eq!(
            reply,
            json!({ "ok": true, "output": format!("{}\n", root.display()) })
        );
        assert!(shells.lock().await.is_empty());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn shell_ids_are_unique_and_the_start_dir_stays_in_the_workspace() {
        let root = workspace("shell-scope").await;
        let outside = workspace("shell-outside").await;
        let shells: Shells = Arc::default();
        let escaped = spawn_shell(shell_params("a", "true", &outside), &root, &shells)
            .await
            .unwrap_err();
        assert_eq!(escaped.code, "path_outside_workspace");

        let (shell_id, child) = spawn_shell(shell_params("a", "sleep 5", &root), &root, &shells)
            .await
            .unwrap();
        let duplicate = spawn_shell(shell_params("a", "true", &root), &root, &shells)
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, "duplicate_shell");
        kill_shell(json!({ "shellId": "a" }), &shells)
            .await
            .unwrap();
        finish_shell(child, shell_id, &shells).await.unwrap();
        assert_eq!(
            kill_shell(json!({ "shellId": "a" }), &shells)
                .await
                .unwrap_err()
                .code,
            "unknown_shell"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
        tokio::fs::remove_dir_all(outside).await.unwrap();
    }

    #[tokio::test]
    async fn shell_output_up_to_the_limit_fits_one_frame_and_beyond_it_is_refused() {
        let root = workspace("shell-cap").await;
        let shells: Shells = Arc::default();
        // NUL encodes as `\u0000`, the worst case: six bytes per output byte.
        let at_limit = run_shell(
            &root,
            &shells,
            "a",
            &format!("head -c {SHELL_OUTPUT_LIMIT} /dev/zero"),
        )
        .await;
        assert_eq!(at_limit["ok"], json!(true));
        assert_eq!(
            at_limit["output"].as_str().unwrap().len(),
            SHELL_OUTPUT_LIMIT
        );
        let frame = RuntimeFrame::Response {
            id: 1,
            result: Some(at_limit),
            error: None,
        };
        assert!(serde_json::to_vec(&frame).unwrap().len() <= MAX_FRAME_BYTES);

        let over = run_shell(
            &root,
            &shells,
            "b",
            &format!("head -c {SHELL_OUTPUT_LIMIT} /dev/zero; echo x >&2"),
        )
        .await;
        assert_eq!(
            over,
            json!({ "ok": false, "output": "Shell output exceeded 4 MiB limit" })
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn killing_a_shell_ends_its_whole_process_group() {
        let root = workspace("shell-kill").await;
        let shells: Shells = Arc::default();
        let (shell_id, child) =
            spawn_shell(shell_params("a", "sleep 30 & wait", &root), &root, &shells)
                .await
                .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        kill_shell(json!({ "shellId": "a" }), &shells)
            .await
            .unwrap();
        // The background `sleep` holds stdout open, so the reply comes before
        // the SIGKILL grace only if SIGTERM reached the whole group.
        let reply = tokio::time::timeout(
            Duration::from_secs(1),
            finish_shell(child, shell_id, &shells),
        )
        .await
        .expect("a process in the group outlived SIGTERM")
        .unwrap();
        assert_eq!(
            reply,
            json!({ "ok": false, "output": "terminated (SIGTERM)" })
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
