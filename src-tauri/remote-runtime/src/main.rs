use krypton_remote_protocol::{
    RemoteMethod, RemoteWorkspace, RuntimeError, RuntimeFrame, MAX_FRAME_BYTES, PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter, Lines, Stdin, Stdout};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex;

type SharedWriter = Arc<Mutex<BufWriter<Stdout>>>;

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
        [command] if command == "version" => {
            println!("{}", version_line());
            return;
        }
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

fn version_line() -> String {
    format!(
        "protocol={PROTOCOL_VERSION} version={}",
        env!("CARGO_PKG_VERSION")
    )
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
            ],
        },
    )
    .await?;

    let agents: Arc<Mutex<HashMap<u64, RemoteAgent>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut next_agent_id = 1_u64;
    while let Some(frame) = read_frame(&mut lines).await? {
        let RuntimeFrame::Request { id, method, params } = frame else {
            return Err("expected request frame".to_string());
        };
        if method == RemoteMethod::RuntimeShutdown {
            write_response(&writer, id, Ok(json!({}))).await?;
            terminate_all(&agents).await;
            let _ = tokio::fs::remove_dir_all(&runtime_root).await;
            return Ok(());
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
    terminate_all(&agents).await;
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
        RemoteMethod::RuntimeShutdown => unreachable!("handled by serve loop"),
        RemoteMethod::AgentSpawn => {
            let params: AgentSpawnParams = parse_params(params)?;
            let cwd = resolve_scoped(root, &params.cwd).await?;
            let mut command = Command::new(&params.command);
            command
                .args(&params.args)
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

fn overlay_path(
    runtime_root: &Path,
    params: &OverlayParams,
    require_file: bool,
) -> Result<PathBuf, RuntimeError> {
    if !matches!(params.backend.as_str(), "cline" | "junie") {
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
        if !matches!(file_name, "mcp.json" | "cline_mcp_settings.json") {
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

    #[test]
    fn version_probe_reports_protocol_and_package_version() {
        assert_eq!(
            version_line(),
            format!(
                "protocol={PROTOCOL_VERSION} version={}",
                env!("CARGO_PKG_VERSION")
            )
        );
    }

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

        let mut invalid = params;
        invalid.file_name = Some("../../secret".into());
        assert_eq!(
            overlay_path(&root, &invalid, true).unwrap_err().code,
            "invalid_overlay"
        );
    }
}
