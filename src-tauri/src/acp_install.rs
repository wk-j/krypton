// Krypton — managed install of ACP Registry agent servers (spec 287).
//
// Antigravity ships its ACP server only as a per-platform zip in the ACP
// Registry, and the `.par` must run from its install directory (it finds
// `localharness_external` next to its real path at `session/new`). Krypton
// downloads the zip into the app cache, records the target's `cmd`/`args` in
// `<root>/current.json`, and spawns that command by absolute path.
//
// Invariants:
// - `current.json` is only ever replaced by atomic rename, so the spawn fast
//   path reads it without the install lock and never waits on a download.
// - A version directory is deleted only by the first resolve of this process,
//   before any lane of this process can be running it.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Whole-archive budget: ~111 MB must finish on a slow link.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Refuse archives beyond this; the current one is ~111 MB.
const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
const REFRESH_INTERVAL_SECS: u64 = 60 * 60;
const MANIFEST: &str = "current.json";
const MANIFEST_TMP: &str = "current.json.tmp";
const TMP_PREFIX: &str = ".tmp-";

pub struct ManagedAgent {
    registry_id: &'static str,
    dir_name: &'static str,
    /// Archives must start with this (https + host allowlist): the registry
    /// publishes no sha256 for this agent.
    archive_url_prefix: &'static str,
    install_lock: Mutex<()>,
    /// Set once this process has swept stale version dirs.
    swept: AtomicBool,
}

pub static ANTIGRAVITY: ManagedAgent = ManagedAgent {
    registry_id: "antigravity-acp",
    dir_name: "antigravity",
    archive_url_prefix: "https://dl.google.com/agy-extensions/",
    install_lock: Mutex::const_new(()),
    swept: AtomicBool::new(false),
};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstallManifest {
    version: String,
    cmd: String,
    args: Vec<String>,
    checked_at_unix: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct RegistryTarget {
    version: String,
    archive: String,
    cmd: String,
    args: Vec<String>,
}

/// Absolute command + args for `agent`. Installs on first use; once installed,
/// returns immediately and refreshes in the background at most hourly.
pub async fn resolve(
    app: &AppHandle,
    agent: &'static ManagedAgent,
) -> Result<(PathBuf, Vec<String>), String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("resolve app cache directory: {e}"))?
        .join("acp-agents")
        .join(agent.dir_name);

    if !agent.swept.load(Ordering::Acquire) {
        let _guard = agent.install_lock.lock().await;
        if !agent.swept.swap(true, Ordering::AcqRel) {
            sweep(&root).await;
        }
    }

    if let Some((command, manifest)) = installed(&root).await {
        if refresh_due(&manifest) {
            let refresh_root = root.clone();
            tokio::spawn(async move {
                if let Err(error) = refresh(agent, &refresh_root).await {
                    log::warn!("{} refresh failed: {error}", agent.registry_id);
                }
            });
        }
        return Ok((command, manifest.args));
    }

    let _guard = agent.install_lock.lock().await;
    // A concurrent first install may have finished while we waited.
    if let Some((command, manifest)) = installed(&root).await {
        return Ok((command, manifest.args));
    }
    let target = fetch_target(agent).await?;
    let manifest = install(&root, target).await?;
    let command = command_path(&root, &manifest)?;
    Ok((command, manifest.args))
}

async fn refresh(agent: &'static ManagedAgent, root: &Path) -> Result<(), String> {
    let _guard = agent.install_lock.lock().await;
    let Some((_, current)) = installed(root).await else {
        return Ok(());
    };
    // Another lane's refresh may have run while this one waited.
    if !refresh_due(&current) {
        return Ok(());
    }
    let target = fetch_target(agent).await?;
    if target.version == current.version {
        return write_manifest(
            root,
            &InstallManifest {
                checked_at_unix: now_unix(),
                ..current
            },
        )
        .await;
    }
    let manifest = install(root, target).await?;
    log::info!(
        "{} {} installed; used from the next spawn",
        agent.registry_id,
        manifest.version
    );
    Ok(())
}

async fn installed(root: &Path) -> Option<(PathBuf, InstallManifest)> {
    let raw = tokio::fs::read(root.join(MANIFEST)).await.ok()?;
    let manifest: InstallManifest = serde_json::from_slice(&raw).ok()?;
    let command = command_path(root, &manifest).ok()?;
    tokio::fs::metadata(&command)
        .await
        .ok()
        .filter(|meta| meta.is_file())?;
    Some((command, manifest))
}

fn command_path(root: &Path, manifest: &InstallManifest) -> Result<PathBuf, String> {
    validate_version(&manifest.version)?;
    let relative = relative_cmd(&manifest.cmd)?;
    Ok(root.join(&manifest.version).join(relative))
}

fn refresh_due(manifest: &InstallManifest) -> bool {
    now_unix().saturating_sub(manifest.checked_at_unix) >= REFRESH_INTERVAL_SECS
}

/// First resolve of the process: keep only `current.json`'s version.
async fn sweep(root: &Path) {
    let keep = installed(root).await.map(|(_, manifest)| manifest.version);
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == MANIFEST || keep.as_deref() == Some(name.as_str()) {
            continue;
        }
        let path = entry.path();
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        let removed = if is_dir {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        };
        match removed {
            Ok(()) => log::info!("acp_install: removed stale {}", path.display()),
            Err(error) => log::warn!("acp_install: could not remove {}: {error}", path.display()),
        }
    }
}

async fn fetch_target(agent: &ManagedAgent) -> Result<RegistryTarget, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REGISTRY_TIMEOUT)
        .build()
        .map_err(|e| format!("build http client: {e}"))?;
    let registry: Value = client
        .get(REGISTRY_URL)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("fetch ACP registry: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse ACP registry: {e}"))?;
    select_target(
        &registry,
        agent.registry_id,
        &platform_key(),
        agent.archive_url_prefix,
    )
}

fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// Pick and validate this platform's binary target from the registry JSON.
fn select_target(
    registry: &Value,
    registry_id: &str,
    platform: &str,
    archive_url_prefix: &str,
) -> Result<RegistryTarget, String> {
    let entry = registry
        .get("agents")
        .and_then(Value::as_array)
        .and_then(|agents| {
            agents
                .iter()
                .find(|agent| agent.get("id").and_then(Value::as_str) == Some(registry_id))
        })
        .ok_or_else(|| format!("ACP registry has no `{registry_id}` entry"))?;
    let version = entry
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{registry_id}` has no version"))?
        .to_string();
    validate_version(&version)?;
    let targets = entry
        .get("distribution")
        .and_then(|d| d.get("binary"))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("`{registry_id}` has no binary distribution"))?;
    let target = targets.get(platform).ok_or_else(|| {
        let available: Vec<&str> = targets.keys().map(String::as_str).collect();
        format!(
            "`{registry_id}` has no build for {platform} (available: {})",
            available.join(", ")
        )
    })?;
    let archive = target
        .get("archive")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{registry_id}` {platform}: missing archive"))?
        .to_string();
    if !archive.starts_with(archive_url_prefix) {
        return Err(format!(
            "`{registry_id}` archive {archive} is outside {archive_url_prefix}; refusing to install"
        ));
    }
    let cmd = target
        .get("cmd")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{registry_id}` {platform}: missing cmd"))?
        .to_string();
    relative_cmd(&cmd)?;
    let args = match target.get("args") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("`{registry_id}` {platform}: non-string arg"))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(format!("`{registry_id}` {platform}: args is not a list")),
    };
    Ok(RegistryTarget {
        version,
        archive,
        cmd,
        args,
    })
}

/// The version names a directory under the install root.
fn validate_version(version: &str) -> Result<(), String> {
    let ok = !version.is_empty()
        && !version.starts_with('.')
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid agent version `{version}`"))
    }
}

/// `./agy_acp_server.par` → `agy_acp_server.par`; rejects anything that could
/// leave the version directory.
fn relative_cmd(cmd: &str) -> Result<PathBuf, String> {
    let relative = cmd
        .strip_prefix("./")
        .ok_or_else(|| format!("agent cmd `{cmd}` must start with ./"))?;
    let path = PathBuf::from(relative);
    if relative.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!(
            "agent cmd `{cmd}` must stay inside its install dir"
        ));
    }
    Ok(path)
}

async fn install(root: &Path, target: RegistryTarget) -> Result<InstallManifest, String> {
    let relative = relative_cmd(&target.cmd)?;
    let tmp = root.join(format!("{TMP_PREFIX}{}", target.version));
    remove_dir_if_present(&tmp).await?;
    tokio::fs::create_dir_all(&tmp)
        .await
        .map_err(|e| format!("create {}: {e}", tmp.display()))?;

    let archive = tmp.join("archive.zip");
    download_to_file(&target.archive, &archive).await?;
    let pkg = tmp.join("pkg");
    let (archive_path, pkg_path) = (archive.clone(), pkg.clone());
    tokio::task::spawn_blocking(move || extract_zip(&archive_path, &pkg_path))
        .await
        .map_err(|e| format!("extract task: {e}"))??;
    if !pkg.join(&relative).is_file() {
        return Err(format!("archive has no {}", target.cmd));
    }

    let dest = root.join(&target.version);
    // Only reached when `dest/<cmd>` is missing (else `installed` would have
    // returned it), so no lane can be running from a partial `dest`.
    remove_dir_if_present(&dest).await?;
    tokio::fs::rename(&pkg, &dest)
        .await
        .map_err(|e| format!("move install into {}: {e}", dest.display()))?;
    remove_dir_if_present(&tmp).await?;

    let manifest = InstallManifest {
        version: target.version,
        cmd: target.cmd,
        args: target.args,
        checked_at_unix: now_unix(),
    };
    write_manifest(root, &manifest).await?;
    Ok(manifest)
}

async fn download_to_file(url: &str, path: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(ARCHIVE_TIMEOUT)
        .build()
        .map_err(|e| format!("build http client: {e}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("download {url}: {e}"))?;
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|e| format!("create {}: {e}", path.display()))?;
    let mut written: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download {url}: {e}"))?;
        written = written.saturating_add(chunk.len() as u64);
        if written > MAX_ARCHIVE_BYTES {
            return Err(format!(
                "download {url}: larger than {MAX_ARCHIVE_BYTES} bytes"
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// `ZipArchive::extract` rejects entries outside `dest` and restores unix
/// mode bits, so the `.par` stays executable.
fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file =
        std::fs::File::open(archive).map_err(|e| format!("open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read archive: {e}"))?;
    zip.extract(dest)
        .map_err(|e| format!("extract archive: {e}"))
}

async fn write_manifest(root: &Path, manifest: &InstallManifest) -> Result<(), String> {
    let body =
        serde_json::to_vec_pretty(manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    let tmp = root.join(MANIFEST_TMP);
    tokio::fs::write(&tmp, body)
        .await
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    tokio::fs::rename(&tmp, root.join(MANIFEST))
        .await
        .map_err(|e| format!("replace {MANIFEST}: {e}"))
}

async fn remove_dir_if_present(path: &Path) -> Result<(), String> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove {}: {error}", path.display())),
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{relative_cmd, select_target, validate_version};
    use serde_json::json;

    const PREFIX: &str = "https://dl.google.com/agy-extensions/";

    fn registry(target: serde_json::Value, version: &str) -> serde_json::Value {
        json!({ "agents": [
            { "id": "other", "version": "9", "distribution": { "binary": {} } },
            {
                "id": "antigravity-acp",
                "version": version,
                "distribution": { "binary": {
                    "darwin-aarch64": target,
                    "linux-x86_64": { "archive": "https://dl.google.com/agy-extensions/l.zip", "cmd": "./a" },
                } },
            },
        ] })
    }

    #[test]
    fn selects_platform_target_with_args() {
        let reg = registry(
            json!({ "archive": "https://dl.google.com/agy-extensions/m.zip", "cmd": "./agy_acp_server.par", "args": ["--uid="] }),
            "1.3.0",
        );
        let target = select_target(&reg, "antigravity-acp", "darwin-aarch64", PREFIX).unwrap();
        assert_eq!(target.version, "1.3.0");
        assert_eq!(target.cmd, "./agy_acp_server.par");
        assert_eq!(target.args, vec!["--uid=".to_string()]);
    }

    #[test]
    fn missing_platform_lists_available_keys() {
        let reg = registry(
            json!({ "archive": "https://dl.google.com/agy-extensions/m.zip", "cmd": "./a" }),
            "1.3.0",
        );
        let error = select_target(&reg, "antigravity-acp", "freebsd-x86_64", PREFIX).unwrap_err();
        assert!(
            error.contains("darwin-aarch64") && error.contains("linux-x86_64"),
            "{error}"
        );
    }

    #[test]
    fn rejects_archive_outside_allowlist() {
        for archive in [
            "http://dl.google.com/agy-extensions/m.zip",
            "https://dl.google.com.evil.example/agy-extensions/m.zip",
            "https://example.com/agy-extensions/m.zip",
        ] {
            let reg = registry(json!({ "archive": archive, "cmd": "./a" }), "1.3.0");
            assert!(select_target(&reg, "antigravity-acp", "darwin-aarch64", PREFIX).is_err());
        }
    }

    #[test]
    fn rejects_version_that_escapes_install_root() {
        for version in ["..", "../x", ".hidden", "1.0/evil", ""] {
            assert!(validate_version(version).is_err(), "{version}");
        }
        assert!(validate_version("1.3.0+build_7-rc").is_ok());
    }

    #[test]
    fn rejects_cmd_outside_install_dir() {
        for cmd in ["agy", "./", "./../agy", "./bin/../../agy", "/usr/bin/agy"] {
            assert!(relative_cmd(cmd).is_err(), "{cmd}");
        }
        assert_eq!(
            relative_cmd("./bin/agy").unwrap(),
            std::path::PathBuf::from("bin/agy")
        );
    }
}
