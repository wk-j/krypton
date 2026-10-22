//! Krypton — ACP backend update check.
//!
//! Probes locally installed ACP backends (Grok, OMP) for available updates.
//! Claude/Codex are not probed: they spawn via `npx -y <adapter>@latest`.
//!
//! See docs/0322-acp-backend-update-check.md for the design.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const OMP_NPM_LATEST_URL: &str = "https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/latest";

#[derive(Debug, Clone, Serialize)]
pub struct BackendUpdate {
    pub backend_id: String,
    pub display_name: String,
    pub installed: String,
    pub latest: String,
    pub update_command: String,
}

#[tauri::command]
pub async fn acp_backend_updates() -> Result<Vec<BackendUpdate>, String> {
    let (grok, omp) = tokio::join!(probe_grok(), probe_omp());
    let mut out = Vec::new();
    for (name, result) in [("grok", grok), ("omp", omp)] {
        match result {
            Ok(Some(update)) => out.push(update),
            Ok(None) => {}
            Err(e) => log::warn!("acp_updates: {name} probe failed: {e}"),
        }
    }
    Ok(out)
}

/// Run `program args...` with the login env; returns stdout (lossy UTF-8), or
/// `None` when `program` is not installed — not a probe failure worth a warning.
async fn run_capture(program: &str, args: &[&str]) -> Result<Option<String>, String> {
    let fut = tokio::process::Command::new(program)
        .args(args)
        .envs(crate::pty::cached_login_env().iter())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(PROBE_TIMEOUT, fut)
        .await
        .map_err(|_| format!("`{program}` timed out"))?
    {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed to run `{program}`: {e}")),
    };
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

async fn probe_grok() -> Result<Option<BackendUpdate>, String> {
    let Some(stdout) = run_capture("grok", &["update", "--check", "--json"]).await? else {
        return Ok(None);
    };
    let (installed, latest, available) = parse_grok_check(&stdout)?;
    if !available {
        return Ok(None);
    }
    Ok(Some(BackendUpdate {
        backend_id: "grok".to_string(),
        display_name: "Grok".to_string(),
        installed,
        latest,
        update_command: "grok update".to_string(),
    }))
}

async fn probe_omp() -> Result<Option<BackendUpdate>, String> {
    let Some(stdout) = run_capture("omp", &["--version"]).await? else {
        return Ok(None);
    };
    let installed = parse_omp_version(&stdout)
        .ok_or_else(|| "unrecognized `omp --version` output".to_string())?;
    let latest = fetch_omp_latest().await?;
    if !valid_version(&latest) || !is_newer(&latest, &installed) {
        return Ok(None);
    }
    Ok(Some(BackendUpdate {
        backend_id: "omp".to_string(),
        display_name: "OMP".to_string(),
        installed,
        latest,
        update_command: "omp update".to_string(),
    }))
}

async fn fetch_omp_latest() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(HTTP_TIMEOUT)
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let body: serde_json::Value = client
        .get(OMP_NPM_LATEST_URL)
        .send()
        .await
        .map_err(|e| format!("npm registry request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("npm registry status: {e}"))?
        .json()
        .await
        .map_err(|e| format!("npm registry json: {e}"))?;
    body.get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "npm registry response missing `version`".to_string())
}

/// Parse `grok update --check --json` output into
/// `(currentVersion, latestVersion, updateAvailable)`. `updateAvailable` is
/// only true when both versions are well-formed.
fn parse_grok_check(stdout: &str) -> Result<(String, String, bool), String> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("unparseable grok check output: {e}"))?;
    let current = v
        .get("currentVersion")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "grok check missing `currentVersion`".to_string())?
        .to_string();
    let latest = v
        .get("latestVersion")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "grok check missing `latestVersion`".to_string())?
        .to_string();
    let available = v.get("updateAvailable").and_then(|x| x.as_bool()) == Some(true)
        && valid_version(&current)
        && valid_version(&latest);
    Ok((current, latest, available))
}

/// `omp/18.12.6\n` → `Some("18.12.6")`.
fn parse_omp_version(stdout: &str) -> Option<String> {
    let rest = stdout.trim().strip_prefix("omp/")?;
    let version = rest.trim();
    if valid_version(version) {
        Some(version.to_string())
    } else {
        None
    }
}

fn valid_version(v: &str) -> bool {
    (1..=64).contains(&v.len())
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
}

/// Split a version into (numeric core, has prerelease). `None` if any core
/// segment is not a number.
fn parse_core(v: &str) -> Option<(Vec<u64>, bool)> {
    let no_build = v.split('+').next().unwrap_or(v);
    let (core, pre) = match no_build.split_once('-') {
        Some((c, p)) => (c, !p.is_empty()),
        None => (no_build, false),
    };
    let nums = core
        .split('.')
        .map(|s| s.parse::<u64>().ok())
        .collect::<Option<Vec<u64>>>()?;
    Some((nums, pre))
}

fn is_newer(latest: &str, installed: &str) -> bool {
    let (Some((l, l_pre)), Some((i, i_pre))) = (parse_core(latest), parse_core(installed)) else {
        return false;
    };
    let len = l.len().max(i.len());
    for idx in 0..len {
        let a = l.get(idx).copied().unwrap_or(0);
        let b = i.get(idx).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    i_pre && !l_pre
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_update_available() {
        let out = r#"{"currentVersion":"1.13.0","latestVersion":"2.2.2","updateAvailable":true}"#;
        let (c, l, a) = parse_grok_check(out).unwrap();
        assert_eq!(c, "1.13.0");
        assert_eq!(l, "2.2.2");
        assert!(a);
    }

    #[test]
    fn grok_no_update() {
        let out = r#"{"currentVersion":"2.2.2","latestVersion":"2.2.2","updateAvailable":false}"#;
        assert!(!parse_grok_check(out).unwrap().2);
    }

    #[test]
    fn grok_garbage_is_err() {
        assert!(parse_grok_check("not json").is_err());
    }

    #[test]
    fn grok_invalid_version_rejected() {
        let out = r#"{"currentVersion":"1.0;rm","latestVersion":"2.0.0","updateAvailable":true}"#;
        assert!(!parse_grok_check(out).unwrap().2);
    }

    #[test]
    fn omp_version_parse() {
        assert_eq!(
            parse_omp_version("omp/18.12.6\n").as_deref(),
            Some("18.12.6")
        );
        assert_eq!(parse_omp_version("18.12.6\n"), None);
    }

    #[test]
    fn is_newer_cases() {
        assert!(is_newer("2.2.2", "1.13.0"));
        assert!(!is_newer("1.13.0", "1.13.0"));
        assert!(is_newer("18.12.10", "18.12.9"));
        assert!(!is_newer("1.0", "1.0.0"));
        assert!(is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer("1.0.0-beta.2", "1.0.0"));
        assert!(!is_newer("x.y", "1.0.0"));
    }

    #[test]
    fn valid_version_rejects_bad() {
        assert!(!valid_version("1.0;rm"));
        assert!(!valid_version("$(x)"));
        assert!(!valid_version(""));
        assert!(!valid_version(&"1".repeat(65)));
        assert!(valid_version("1.0.0-beta.1+build"));
    }
}
