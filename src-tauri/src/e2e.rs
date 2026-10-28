//! Harness E2E commands (spec 0328).
//!
//! A project declares an e2e adapter in `<root>/.krypton/e2e/project.toml`.
//! Krypton validates the adapter's output (Adapter Contract v1), launches
//! runs itself (process group, login env, stdin null), records every launch
//! in an append-only ledger (`launches.jsonl`) and joins the ledger with the
//! adapter-written Result files and the optional adapter `history`.
//!
//! Pure logic (validation, ledger join, dedupe, param merge, path
//! confinement, launch id allocation) lives in plain functions; the Tauri
//! commands at the bottom are thin wrappers.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::child_process::{kill_group, login_command, read_capped, Signal};

type Obj = Map<String, Value>;

const LIST_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_KILL_DELAY: Duration = Duration::from_secs(5);
const LOG_CAP: usize = 5 * 1024 * 1024;
const STDOUT_CAP: usize = 32 * 1024 * 1024;
const STDERR_CAP: usize = 1024 * 1024;
const LOG_RETENTION: usize = 100;
const STDERR_TAIL_LINES: usize = 20;

const VERDICTS: [&str; 4] = ["PASS", "FAIL", "ERROR", "BLOCKED"];
const CHECK_STATUSES: [&str; 5] = ["pass", "fail", "skip", "blocked", "info"];

// ─── Paths ──────────────────────────────────────────────────────────

fn e2e_dir(root: &Path) -> PathBuf {
    root.join(".krypton").join("e2e")
}

fn runs_dir(root: &Path) -> PathBuf {
    e2e_dir(root).join("runs")
}

fn ledger_path(root: &Path) -> PathBuf {
    e2e_dir(root).join("launches.jsonl")
}

fn manifest_path(root: &Path) -> PathBuf {
    e2e_dir(root).join("project.toml")
}

/// Root-relative display path of a file inside a run dir.
fn run_rel(dir_name: &str, file: &str) -> String {
    format!(".krypton/e2e/runs/{dir_name}/{file}")
}

fn root_path(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("project root {root}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("project root {root} is not a directory"));
    }
    Ok(canonical)
}

/// Resolve `path` (root-relative or absolute) and require it to canonicalize
/// under `<root>/.krypton/e2e/`.
pub(crate) fn confine_result_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let resolved = joined
        .canonicalize()
        .map_err(|e| format!("result_path {path}: {e}"))?;
    let base = e2e_dir(root)
        .canonicalize()
        .map_err(|e| format!(".krypton/e2e: {e}"))?;
    if !resolved.starts_with(&base) {
        return Err(format!(
            "result_path {path}: must be under {}",
            base.display()
        ));
    }
    Ok(resolved)
}

fn sanitize_component(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn ext_dir_name(case_id: &str, run_id: &str) -> String {
    format!(
        "ext-{}-{}",
        sanitize_component(case_id),
        sanitize_component(run_id)
    )
}

// ─── Manifest ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Manifest {
    pub name: String,
    pub adapter: Vec<String>,
    pub history: bool,
    pub issue_label: Option<String>,
    pub create_prompt: Option<String>,
    pub report_prompt: Option<String>,
}

/// Parse `project.toml` v1. Ok carries the manifest plus warnings (unknown
/// keys); Err carries every validation error.
pub(crate) fn parse_manifest(text: &str) -> Result<(Manifest, Vec<String>), Vec<String>> {
    let table: toml::Table = toml::from_str(text).map_err(|e| vec![format!("{e}")])?;
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    match table.get("version") {
        Some(toml::Value::Integer(1)) => {}
        _ => errors.push("version: must be 1".to_string()),
    }
    let name = match table.get("name") {
        Some(toml::Value::String(s)) if !s.trim().is_empty() => s.clone(),
        _ => {
            errors.push("name: must be a non-empty string".to_string());
            String::new()
        }
    };
    let mut adapter = Vec::new();
    match table.get("adapter") {
        Some(toml::Value::Array(items)) if !items.is_empty() => {
            for (i, item) in items.iter().enumerate() {
                match item {
                    toml::Value::String(s) if !s.is_empty() => adapter.push(s.clone()),
                    _ => errors.push(format!("adapter[{i}]: must be a non-empty string")),
                }
            }
        }
        _ => errors.push("adapter: must be a non-empty array of non-empty strings".to_string()),
    }
    let history = match table.get("history") {
        None => false,
        Some(toml::Value::Boolean(b)) => *b,
        Some(_) => {
            errors.push("history: must be a boolean".to_string());
            false
        }
    };
    let mut optional = |key: &str| -> Option<String> {
        match table.get(key) {
            None => None,
            Some(toml::Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
            Some(_) => {
                errors.push(format!("{key}: must be a non-empty string"));
                None
            }
        }
    };
    let issue_label = optional("issue_label");
    let create_prompt = optional("create_prompt");
    let report_prompt = optional("report_prompt");

    const KNOWN: [&str; 7] = [
        "version",
        "name",
        "adapter",
        "history",
        "issue_label",
        "create_prompt",
        "report_prompt",
    ];
    for key in table.keys() {
        if !KNOWN.contains(&key.as_str()) {
            warnings.push(format!("unknown key \"{key}\""));
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }
    Ok((
        Manifest {
            name,
            adapter,
            history,
            issue_label,
            create_prompt,
            report_prompt,
        },
        warnings,
    ))
}

fn load_manifest(root: &Path) -> Result<Manifest, String> {
    let path = manifest_path(root);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("project.toml: {} ({e})", path.display()))?;
    parse_manifest(&text)
        .map(|(manifest, _)| manifest)
        .map_err(|errors| prefix_errors("project.toml", &errors).join("; "))
}

fn prefix_errors(prefix: &str, errors: &[String]) -> Vec<String> {
    errors.iter().map(|e| format!("{prefix}: {e}")).collect()
}

// ─── Validation helpers ─────────────────────────────────────────────

fn required_str(obj: &Obj, key: &str, path: &str, errors: &mut Vec<String>) -> Option<String> {
    match obj.get(key) {
        None | Some(Value::Null) => {
            errors.push(format!("{path}{key}: required"));
            None
        }
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(_) => {
            errors.push(format!("{path}{key}: must be a non-empty string"));
            None
        }
    }
}

fn optional_str(obj: &Obj, key: &str, path: &str, errors: &mut Vec<String>) -> Option<String> {
    match obj.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            errors.push(format!("{path}{key}: must be a string"));
            None
        }
    }
}

fn check_version(obj: &Obj, path: &str, errors: &mut Vec<String>) {
    if obj.get("version").and_then(Value::as_u64) != Some(1) {
        errors.push(format!("{path}version: must be 1"));
    }
}

fn is_relative_clean(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !Path::new(path).is_absolute()
        && !path.split(['/', '\\']).any(|part| part == "..")
}

fn optional_object<'a>(
    obj: &'a Obj,
    key: &str,
    path: &str,
    errors: &mut Vec<String>,
) -> Option<&'a Obj> {
    match obj.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::Object(o)) => Some(o),
        Some(_) => {
            errors.push(format!("{path}{key}: must be an object"));
            None
        }
    }
}

// ─── Case list ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Case {
    pub id: String,
    pub title: String,
    pub code: Option<String>,
    pub issue: Option<u64>,
    pub params: Obj,
    pub fresh: BTreeMap<String, String>,
    pub files: Vec<String>,
}

/// Validate adapter `list` stdout: `{"version":1,"cases":[Case]}`.
pub(crate) fn validate_case_list(value: &Value) -> Result<Vec<Case>, Vec<String>> {
    let Some(obj) = value.as_object() else {
        return Err(vec!["$: must be an object".to_string()]);
    };
    let mut errors = Vec::new();
    check_version(obj, "", &mut errors);
    let Some(items) = obj.get("cases").and_then(Value::as_array) else {
        errors.push("cases: must be an array".to_string());
        return Err(errors);
    };
    let mut seen = HashSet::new();
    let mut cases = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let p = format!("cases[{i}].");
        let Some(o) = item.as_object() else {
            errors.push(format!("cases[{i}]: must be an object"));
            continue;
        };
        let before = errors.len();
        let id = required_str(o, "id", &p, &mut errors);
        if let Some(id) = &id {
            if id.starts_with('-') {
                errors.push(format!("{p}id: \"{id}\" must not start with '-'"));
            } else if !seen.insert(id.clone()) {
                errors.push(format!("{p}id: duplicate \"{id}\""));
            }
        }
        let title = required_str(o, "title", &p, &mut errors);
        let code = optional_str(o, "code", &p, &mut errors);
        let issue = match o.get("issue") {
            None | Some(Value::Null) => None,
            Some(v) => match v.as_u64().filter(|n| *n > 0) {
                Some(n) => Some(n),
                None => {
                    errors.push(format!("{p}issue: {v} is not a positive integer"));
                    None
                }
            },
        };
        let mut params = Obj::new();
        if let Some(map) = optional_object(o, "params", &p, &mut errors) {
            for (k, v) in map {
                if v.is_string() || v.is_number() {
                    params.insert(k.clone(), v.clone());
                } else {
                    errors.push(format!("{p}params.{k}: must be a string or number"));
                }
            }
        }
        let mut fresh = BTreeMap::new();
        if let Some(map) = optional_object(o, "fresh", &p, &mut errors) {
            for (k, v) in map {
                match v {
                    Value::String(s) => {
                        fresh.insert(k.clone(), s.clone());
                    }
                    _ => errors.push(format!("{p}fresh.{k}: must be a string")),
                }
            }
        }
        let mut files = Vec::new();
        match o.get("files") {
            None | Some(Value::Null) => {}
            Some(Value::Array(list)) => {
                for (j, f) in list.iter().enumerate() {
                    match f.as_str() {
                        Some(s) if is_relative_clean(s) => files.push(s.to_string()),
                        Some(s) => errors.push(format!(
                            "{p}files[{j}]: \"{s}\" must be a relative path without \"..\""
                        )),
                        None => errors.push(format!("{p}files[{j}]: must be a string")),
                    }
                }
            }
            Some(_) => errors.push(format!("{p}files: must be an array")),
        }
        if errors.len() == before {
            if let (Some(id), Some(title)) = (id, title) {
                cases.push(Case {
                    id,
                    title,
                    code,
                    issue,
                    params,
                    fresh,
                    files,
                });
            }
        }
    }
    if errors.is_empty() {
        Ok(cases)
    } else {
        Err(errors)
    }
}

// ─── Result ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Check {
    pub group: Option<String>,
    pub label: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunResult {
    pub case_id: String,
    pub run_id: String,
    pub verdict: String,
    pub started_at: String,
    pub finished_at: String,
    pub versions: BTreeMap<String, String>,
    pub params: Option<Obj>,
    pub checks: Vec<Check>,
    pub message: Option<String>,
}

fn timestamp(obj: &Obj, key: &str, path: &str, errors: &mut Vec<String>) -> String {
    match required_str(obj, key, path, errors) {
        Some(s) if DateTime::parse_from_rfc3339(&s).is_ok() => s,
        Some(s) => {
            errors.push(format!("{path}{key}: \"{s}\" is not an RFC3339 timestamp"));
            String::new()
        }
        None => String::new(),
    }
}

/// Validate one Result object. `path` prefixes error locations (e.g. `runs[3].`).
pub(crate) fn validate_result(value: &Value, path: &str) -> Result<RunResult, Vec<String>> {
    let Some(obj) = value.as_object() else {
        let at = path.trim_end_matches('.');
        let at = if at.is_empty() { "$" } else { at };
        return Err(vec![format!("{at}: must be an object")]);
    };
    let mut errors = Vec::new();
    check_version(obj, path, &mut errors);
    let case_id = required_str(obj, "caseId", path, &mut errors).unwrap_or_default();
    let run_id = required_str(obj, "runId", path, &mut errors).unwrap_or_default();
    let verdict = match required_str(obj, "verdict", path, &mut errors) {
        Some(v) if VERDICTS.contains(&v.as_str()) => v,
        Some(v) => {
            errors.push(format!(
                "{path}verdict: \"{v}\" is not one of {}",
                VERDICTS.join("|")
            ));
            String::new()
        }
        None => String::new(),
    };
    let started_at = timestamp(obj, "startedAt", path, &mut errors);
    let finished_at = timestamp(obj, "finishedAt", path, &mut errors);
    optional_str(obj, "env", path, &mut errors);
    let message = optional_str(obj, "message", path, &mut errors);
    let mut versions = BTreeMap::new();
    if let Some(map) = optional_object(obj, "versions", path, &mut errors) {
        for (k, v) in map {
            match v {
                Value::String(s) => {
                    versions.insert(k.clone(), s.clone());
                }
                _ => errors.push(format!("{path}versions.{k}: must be a string")),
            }
        }
    }
    let params = optional_object(obj, "params", path, &mut errors).cloned();
    if let Some(map) = &params {
        for (k, v) in map {
            if !(v.is_string() || v.is_number() || v.is_boolean()) {
                errors.push(format!(
                    "{path}params.{k}: must be a string, number or boolean"
                ));
            }
        }
    }
    let mut checks = Vec::new();
    match obj.get("checks") {
        Some(Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                let p = format!("{path}checks[{i}].");
                let Some(o) = item.as_object() else {
                    errors.push(format!("{path}checks[{i}]: must be an object"));
                    continue;
                };
                let group = optional_str(o, "group", &p, &mut errors);
                let detail = optional_str(o, "detail", &p, &mut errors);
                let label = required_str(o, "label", &p, &mut errors);
                let status = match required_str(o, "status", &p, &mut errors) {
                    Some(s) if CHECK_STATUSES.contains(&s.as_str()) => Some(s),
                    Some(s) => {
                        errors.push(format!(
                            "{p}status: \"{s}\" is not one of {}",
                            CHECK_STATUSES.join("|")
                        ));
                        None
                    }
                    None => None,
                };
                if let (Some(label), Some(status)) = (label, status) {
                    checks.push(Check {
                        group,
                        label,
                        status,
                        detail,
                    });
                }
            }
        }
        _ => errors.push(format!("{path}checks: must be an array")),
    }
    match obj.get("artifacts") {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                let p = format!("{path}artifacts[{i}].");
                match item.as_object() {
                    Some(o) => {
                        required_str(o, "label", &p, &mut errors);
                        required_str(o, "path", &p, &mut errors);
                    }
                    None => errors.push(format!("{path}artifacts[{i}]: must be an object")),
                }
            }
        }
        Some(_) => errors.push(format!("{path}artifacts: must be an array")),
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(RunResult {
        case_id,
        run_id,
        verdict,
        started_at,
        finished_at,
        versions,
        params,
        checks,
        message,
    })
}

/// Validate adapter `history` stdout. Returns the valid runs (with their raw
/// JSON) and one error per invalid item; a malformed envelope is one error.
pub(crate) fn validate_history(value: &Value) -> (Vec<(RunResult, Value)>, Vec<String>) {
    let Some(obj) = value.as_object() else {
        return (Vec::new(), vec!["$: must be an object".to_string()]);
    };
    let mut errors = Vec::new();
    check_version(obj, "", &mut errors);
    let Some(items) = obj.get("runs").and_then(Value::as_array) else {
        errors.push("runs: must be an array".to_string());
        return (Vec::new(), errors);
    };
    let mut runs = Vec::new();
    for (i, item) in items.iter().enumerate() {
        match validate_result(item, &format!("runs[{i}].")) {
            Ok(result) => runs.push((result, item.clone())),
            Err(item_errors) => errors.push(item_errors.join("; ")),
        }
    }
    (runs, errors)
}

// ─── Output types ───────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct E2eCounts {
    pub pass: u32,
    pub fail: u32,
    pub skip: u32,
    pub blocked: u32,
    pub info: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eFailedCheck {
    pub group: Option<String>,
    pub label: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eGitInfo {
    pub sha: String,
    pub branch: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eRunInfo {
    pub case_id: String,
    /// The case's short code (`Case.code`); set only on the run `#e2e run`/`rerun` just made.
    pub code: Option<String>,
    pub run_id: String,
    pub origin: String,
    pub launch_id: Option<String>,
    pub verdict: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub counts: E2eCounts,
    pub failed: Vec<E2eFailedCheck>,
    pub versions: BTreeMap<String, String>,
    pub params: Option<BTreeMap<String, String>>,
    pub git: Option<E2eGitInfo>,
    pub case_hash: Option<String>,
    pub exit_code: Option<i32>,
    pub result_path: Option<String>,
    pub log_path: Option<String>,
    pub message: Option<String>,
    pub argv: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eCaseInfo {
    pub id: String,
    pub title: String,
    pub code: Option<String>,
    pub issue: Option<u64>,
    pub params: Obj,
    pub fresh: BTreeMap<String, String>,
    pub files: Vec<String>,
    pub case_hash: Option<String>,
    pub uncommitted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eManifestInfo {
    pub name: String,
    pub history: bool,
    pub issue_label: Option<String>,
    pub create_prompt: Option<String>,
    pub report_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eIssueInfo {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub reported_run_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eActiveLaunch {
    pub launch_id: String,
    pub case_id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eStatus {
    pub initialized: bool,
    pub manifest: Option<E2eManifestInfo>,
    pub errors: Vec<String>,
    pub cases: Vec<E2eCaseInfo>,
    pub runs: Vec<E2eRunInfo>,
    pub issues: Option<Vec<E2eIssueInfo>>,
    pub issues_error: Option<String>,
    pub active_launch: Option<E2eActiveLaunch>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eFoundRun {
    pub case_id: String,
    pub run_id: String,
    pub issue: Option<u64>,
    pub result_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct E2eAdapterCheck {
    pub ok: bool,
    pub name: String,
    pub cases: usize,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

fn summarize_checks(checks: &[Check]) -> (E2eCounts, Vec<E2eFailedCheck>) {
    let mut counts = E2eCounts::default();
    let mut failed = Vec::new();
    for check in checks {
        match check.status.as_str() {
            "pass" => counts.pass += 1,
            "fail" => counts.fail += 1,
            "skip" => counts.skip += 1,
            "blocked" => counts.blocked += 1,
            _ => counts.info += 1,
        }
        if matches!(check.status.as_str(), "fail" | "blocked") {
            failed.push(E2eFailedCheck {
                group: check.group.clone(),
                label: check.label.clone(),
                status: check.status.clone(),
                detail: check.detail.clone(),
            });
        }
    }
    (counts, failed)
}

fn stringify_params(params: &Obj) -> BTreeMap<String, String> {
    params
        .iter()
        .map(|(k, v)| {
            let text = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            (k.clone(), text)
        })
        .collect()
}

// ─── Ledger ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartLine {
    pub launch_id: String,
    pub started_at: String,
    pub case_id: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    #[serde(default)]
    pub git: Option<E2eGitInfo>,
    #[serde(default)]
    pub case_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinishLine {
    pub launch_id: String,
    pub finished_at: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum LedgerLine {
    Start(Box<StartLine>),
    Finish(FinishLine),
}

/// Parse `launches.jsonl`; malformed lines are skipped with a warning.
pub(crate) fn parse_ledger(text: &str) -> Vec<LedgerLine> {
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .filter_map(|(i, line)| match serde_json::from_str::<LedgerLine>(line) {
            Ok(entry) => Some(entry),
            Err(e) => {
                log::warn!("e2e ledger line {} skipped: {e}", i + 1);
                None
            }
        })
        .collect()
}

fn read_ledger(root: &Path) -> Vec<LedgerLine> {
    std::fs::read_to_string(ledger_path(root))
        .map(|text| parse_ledger(&text))
        .unwrap_or_default()
}

/// One `O_APPEND` write per line.
fn append_ledger(root: &Path, line: &LedgerLine) -> Result<(), String> {
    let mut text = serde_json::to_string(line).map_err(|e| e.to_string())?;
    text.push('\n');
    let path = ledger_path(root);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Join one ledger `start` with its `finish` and `runs/<launchId>/result.json`.
pub(crate) fn launch_run_info(
    root: &Path,
    start: &StartLine,
    finish: Option<&FinishLine>,
) -> E2eRunInfo {
    let run_dir = runs_dir(root).join(&start.launch_id);
    let result_file = run_dir.join("result.json");
    let result_text = std::fs::read_to_string(&result_file).ok();
    let parsed: Option<Result<RunResult, Vec<String>>> = result_text.map(|text| {
        serde_json::from_str::<Value>(&text)
            .map_err(|e| vec![format!("result.json: {e}")])
            .and_then(|value| validate_result(&value, ""))
    });

    let cancelled = finish.map(|f| f.cancelled).unwrap_or(false);
    let (mut verdict, mut message) = match &parsed {
        None => ("NO RESULT".to_string(), None),
        Some(Err(errors)) => ("INVALID RESULT".to_string(), Some(errors.join("; "))),
        Some(Ok(result)) => (result.verdict.clone(), result.message.clone()),
    };
    if finish.is_none() {
        verdict = "INTERRUPTED".to_string();
    } else if cancelled {
        verdict = "CANCELLED".to_string();
        message = Some("cancelled".to_string());
    }
    let (counts, failed, versions, run_id) = match &parsed {
        Some(Ok(result)) => {
            let (counts, failed) = summarize_checks(&result.checks);
            (
                counts,
                failed,
                result.versions.clone(),
                result.run_id.clone(),
            )
        }
        _ => (
            E2eCounts::default(),
            Vec::new(),
            BTreeMap::new(),
            start.launch_id.clone(),
        ),
    };
    E2eRunInfo {
        case_id: start.case_id.clone(),
        code: None,
        run_id,
        origin: "krypton".to_string(),
        launch_id: Some(start.launch_id.clone()),
        verdict,
        started_at: Some(start.started_at.clone()),
        finished_at: finish.map(|f| f.finished_at.clone()),
        counts,
        failed,
        versions,
        params: Some(start.params.clone()),
        git: start.git.clone(),
        case_hash: start.case_hash.clone(),
        exit_code: finish.and_then(|f| f.exit_code),
        result_path: result_file
            .is_file()
            .then(|| run_rel(&start.launch_id, "result.json")),
        log_path: run_dir
            .join("log")
            .is_file()
            .then(|| run_rel(&start.launch_id, "log")),
        message,
        argv: Some(start.argv.clone()),
    }
}

/// Every Krypton launch in the ledger. The active launch (start without
/// finish) is reported via `activeLaunch`, not as a run.
pub(crate) fn krypton_runs(
    root: &Path,
    ledger: &[LedgerLine],
    active_launch: Option<&str>,
) -> Vec<E2eRunInfo> {
    let finishes: HashMap<&str, &FinishLine> = ledger
        .iter()
        .filter_map(|line| match line {
            LedgerLine::Finish(f) => Some((f.launch_id.as_str(), f)),
            LedgerLine::Start(_) => None,
        })
        .collect();
    ledger
        .iter()
        .filter_map(|line| match line {
            LedgerLine::Start(start) => {
                let finish = finishes.get(start.launch_id.as_str()).copied();
                if finish.is_none() && active_launch == Some(start.launch_id.as_str()) {
                    return None;
                }
                Some(launch_run_info(root, start, finish))
            }
            LedgerLine::Finish(_) => None,
        })
        .collect()
}

pub(crate) fn ext_run_info(root: &Path, result: &RunResult) -> E2eRunInfo {
    let (counts, failed) = summarize_checks(&result.checks);
    let dir = ext_dir_name(&result.case_id, &result.run_id);
    E2eRunInfo {
        case_id: result.case_id.clone(),
        code: None,
        run_id: result.run_id.clone(),
        origin: "ext".to_string(),
        launch_id: None,
        verdict: result.verdict.clone(),
        started_at: Some(result.started_at.clone()),
        finished_at: Some(result.finished_at.clone()),
        counts,
        failed,
        versions: result.versions.clone(),
        params: result.params.as_ref().map(stringify_params),
        git: None,
        case_hash: None,
        exit_code: None,
        result_path: runs_dir(root)
            .join(&dir)
            .join("result.json")
            .is_file()
            .then(|| run_rel(&dir, "result.json")),
        log_path: None,
        message: result.message.clone(),
        argv: None,
    }
}

fn time_key(value: &Option<String>) -> Option<i64> {
    value
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
}

/// Krypton runs ∪ history runs, deduped by (caseId, runId) preferring the
/// Krypton record, sorted newest first (startedAt, then launchId/runId).
pub(crate) fn merge_runs(krypton: Vec<E2eRunInfo>, ext: Vec<E2eRunInfo>) -> Vec<E2eRunInfo> {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut runs = Vec::with_capacity(krypton.len() + ext.len());
    for run in krypton.into_iter().chain(ext) {
        if seen.insert((run.case_id.clone(), run.run_id.clone())) {
            runs.push(run);
        }
    }
    runs.sort_by(|a, b| {
        let ka = (
            time_key(&a.started_at),
            a.launch_id.as_ref().unwrap_or(&a.run_id),
        );
        let kb = (
            time_key(&b.started_at),
            b.launch_id.as_ref().unwrap_or(&b.run_id),
        );
        kb.cmp(&ka)
    });
    runs
}

/// Known runIds that occur in any of the comment bodies (run order kept).
pub(crate) fn reported_run_ids(bodies: &[String], run_ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in run_ids {
        if id.is_empty() || out.contains(id) {
            continue;
        }
        if bodies.iter().any(|body| body.contains(id.as_str())) {
            out.push(id.clone());
        }
    }
    out
}

// ─── Params, argv, launch ids ───────────────────────────────────────

/// `fresh` starts from case.fresh, then explicit params overlay (explicit wins).
pub(crate) fn merge_params(
    case: &Case,
    explicit: &BTreeMap<String, String>,
    fresh: bool,
) -> BTreeMap<String, String> {
    let mut merged = if fresh {
        case.fresh.clone()
    } else {
        BTreeMap::new()
    };
    for (k, v) in explicit {
        merged.insert(k.clone(), v.clone());
    }
    merged
}

/// `<adapter…> run <caseId> --param k=v…` with params sorted by key.
pub(crate) fn build_run_argv(
    adapter: &[String],
    case_id: &str,
    params: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut argv = adapter.to_vec();
    argv.push("run".to_string());
    argv.push(case_id.to_string());
    for (k, v) in params {
        argv.push("--param".to_string());
        argv.push(format!("{k}={v}"));
    }
    argv
}

/// UTC `%Y%m%dT%H%M%SZ`; if `runs/<id>` exists append `-2`, `-3`, ….
pub(crate) fn allocate_launch_id(runs_dir: &Path, now: DateTime<Utc>) -> String {
    let base = now.format("%Y%m%dT%H%M%SZ").to_string();
    if !runs_dir.join(&base).exists() {
        return base;
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{base}-{n}");
        if !runs_dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

fn now_rfc3339() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Delete `log` of every run dir except the newest `keep` (by name; launch ids
/// sort chronologically). `ext-*` dirs are history materializations.
fn prune_logs(runs_dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(runs_dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| !name.starts_with("ext-"))
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    for name in names.iter().skip(keep) {
        let log = runs_dir.join(name).join("log");
        if log.is_file() {
            if let Err(e) = std::fs::remove_file(&log) {
                log::warn!("e2e: failed to prune {}: {e}", log.display());
            }
        }
    }
}

// ─── Case hash + git ────────────────────────────────────────────────

fn collect_files(root: &Path, rel: &str, out: &mut Vec<String>) {
    let path = root.join(rel);
    let Ok(meta) = std::fs::metadata(&path) else {
        return;
    };
    if meta.is_file() {
        out.push(rel.to_string());
    } else if meta.is_dir() {
        let Ok(entries) = std::fs::read_dir(&path) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            if entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
                continue;
            }
            if let Ok(name) = entry.file_name().into_string() {
                collect_files(root, &format!("{}/{name}", rel.trim_end_matches('/')), out);
            }
        }
    }
}

/// sha256 hex over `files` (recursive, sorted rel paths + bytes); None when
/// the case lists no files.
pub(crate) fn case_hash(root: &Path, files: &[String]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let mut all = Vec::new();
    for f in files {
        collect_files(root, f, &mut all);
    }
    all.sort();
    all.dedup();
    let mut hasher = Sha256::new();
    for rel in &all {
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        hasher.update(std::fs::read(root.join(rel)).unwrap_or_default());
        hasher.update([0u8]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// Paths from `git status --porcelain` (v1) output.
fn porcelain_paths(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| line.len() > 3)
        .map(|line| {
            let path = &line[3..];
            let path = path.rsplit(" -> ").next().unwrap_or(path);
            path.trim_matches('"').to_string()
        })
        .collect()
}

fn files_dirty(files: &[String], dirty: &[String]) -> bool {
    files.iter().any(|f| {
        let f = f.trim_end_matches('/');
        dirty.iter().any(|p| {
            let p = p.trim_end_matches('/');
            p == f || p.starts_with(&format!("{f}/")) || f.starts_with(&format!("{p}/"))
        })
    })
}

async fn git_output(root: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).to_string())
}

async fn git_info(root: &Path) -> Option<E2eGitInfo> {
    let sha = git_output(root, &["rev-parse", "HEAD"]).await?;
    let branch = git_output(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .unwrap_or_default();
    let status = git_output(root, &["status", "--porcelain"])
        .await
        .unwrap_or_default();
    Some(E2eGitInfo {
        sha: sha.trim().to_string(),
        branch: branch.trim().to_string(),
        dirty: !status.trim().is_empty(),
    })
}

/// One `git status --porcelain -- <files>` over every case's files.
async fn case_infos(root: &Path, cases: &[Case]) -> Vec<E2eCaseInfo> {
    let all_files: Vec<&str> = cases
        .iter()
        .flat_map(|c| c.files.iter().map(String::as_str))
        .collect();
    let dirty = if all_files.is_empty() {
        Vec::new()
    } else {
        let mut args = vec!["status", "--porcelain", "--untracked-files=all", "--"];
        args.extend(all_files);
        git_output(root, &args)
            .await
            .map(|text| porcelain_paths(&text))
            .unwrap_or_default()
    };
    cases
        .iter()
        .map(|c| E2eCaseInfo {
            id: c.id.clone(),
            title: c.title.clone(),
            code: c.code.clone(),
            issue: c.issue,
            params: c.params.clone(),
            fresh: c.fresh.clone(),
            files: c.files.clone(),
            case_hash: case_hash(root, &c.files),
            uncommitted: files_dirty(&c.files, &dirty),
        })
        .collect()
}

// ─── Processes ──────────────────────────────────────────────────────

fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

struct CaptureFail {
    message: String,
    stderr: String,
}

/// Run `<argv…>` to completion capturing stdout (32 MB cap) with a timeout
/// that SIGKILLs the process group.
async fn run_capture(
    root: &Path,
    argv: &[String],
    sub: &str,
    timeout: Duration,
) -> Result<String, CaptureFail> {
    let fail = |message: String| CaptureFail {
        message,
        stderr: String::new(),
    };
    let mut cmd = login_command(root, argv).map_err(fail)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| fail(format!("{sub}: failed to spawn {}: {e}", argv[0])))?;
    let pgid = child.id().map(|p| p as i32);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let work = async {
        tokio::join!(
            read_capped(stdout, STDOUT_CAP),
            read_capped(stderr, STDERR_CAP),
            child.wait()
        )
    };
    let outcome = tokio::time::timeout(timeout, work).await;
    let (out, err, status) = match outcome {
        Ok(done) => done,
        Err(_) => {
            kill_group(pgid, Signal::Kill);
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(fail(format!(
                "{sub} timed out after {}s",
                timeout.as_secs()
            )));
        }
    };
    let stderr = String::from_utf8_lossy(&err).to_string();
    let status = status.map_err(|e| fail(format!("{sub}: {e}")))?;
    if !status.success() {
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        let tail = tail_lines(&stderr, STDERR_TAIL_LINES);
        let message = if tail.trim().is_empty() {
            format!("{sub} exited with {code}")
        } else {
            format!("{sub} exited with {code}:\n{tail}")
        };
        return Err(CaptureFail { message, stderr });
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

fn subcommand_argv(manifest: &Manifest, sub: &str) -> Vec<String> {
    let mut argv = manifest.adapter.clone();
    argv.push(sub.to_string());
    argv
}

async fn adapter_json(root: &Path, manifest: &Manifest, sub: &str) -> Result<Value, String> {
    let stdout = run_capture(root, &subcommand_argv(manifest, sub), sub, LIST_TIMEOUT)
        .await
        .map_err(|f| f.message)?;
    serde_json::from_str(&stdout).map_err(|e| format!("{sub}: stdout is not JSON: {e}"))
}

async fn list_cases(root: &Path, manifest: &Manifest) -> Result<Vec<Case>, String> {
    let value = adapter_json(root, manifest, "list").await?;
    validate_case_list(&value).map_err(|errors| prefix_errors("list", &errors).join("; "))
}

// ─── State + launches ───────────────────────────────────────────────

struct Active {
    launch_id: String,
    case_id: String,
    started_at: String,
    pgid: Option<i32>,
    cancelled: bool,
}

/// Validated `history` Results of one root, keyed by `(caseId, runId)`.
type HistoryCache = HashMap<(String, String), Value>;

#[derive(Default)]
pub struct E2eState {
    active: Mutex<HashMap<PathBuf, Active>>,
    /// Spec 0329: the last `history` Results per root, replaced by every
    /// `gather`. The browser explorer reads ext runs from here, so it never
    /// re-spawns `history` or writes `runs/ext-*` the way `find_run` does.
    history: Mutex<HashMap<PathBuf, HistoryCache>>,
}

impl E2eState {
    fn lock(&self) -> MutexGuard<'_, HashMap<PathBuf, Active>> {
        self.active.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn active_launch(&self, root: &Path) -> Option<E2eActiveLaunch> {
        self.lock().get(root).map(|a| E2eActiveLaunch {
            launch_id: a.launch_id.clone(),
            case_id: a.case_id.clone(),
            started_at: a.started_at.clone(),
        })
    }

    fn history_lock(&self) -> MutexGuard<'_, HashMap<PathBuf, HistoryCache>> {
        self.history.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Removes the root's active entry when the launch ends (or its future drops).
struct ActiveGuard<'a> {
    state: &'a E2eState,
    root: PathBuf,
    launch_id: String,
}

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        let mut active = self.state.lock();
        if active
            .get(&self.root)
            .is_some_and(|a| a.launch_id == self.launch_id)
        {
            active.remove(&self.root);
        }
    }
}

struct LogSink {
    file: Option<std::fs::File>,
    written: usize,
    truncated: bool,
}

impl LogSink {
    fn write(&mut self, data: &[u8]) {
        if self.truncated {
            return;
        }
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let room = LOG_CAP - self.written;
        let result = if data.len() <= room {
            self.written += data.len();
            file.write_all(data)
        } else {
            self.written = LOG_CAP;
            self.truncated = true;
            file.write_all(&data[..room])
                .and_then(|_| file.write_all(b"\n[truncated]\n"))
        };
        if let Err(e) = result {
            log::warn!("e2e: log write failed: {e}");
            self.file = None;
        }
    }
}

async fn pump<R: AsyncRead + Unpin>(reader: Option<R>, sink: &Mutex<LogSink>) {
    let Some(mut reader) = reader else {
        return;
    };
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => sink
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .write(&buf[..n]),
        }
    }
}

/// Launch `argv` for `case_id` on `root`, record it in the ledger, stream its
/// output into the run log and resolve once it exits. The future owns the
/// Child; the `active` map holds only ids, so cancel never waits on it.
pub(crate) async fn run_launch(
    state: &E2eState,
    root: &Path,
    case_id: &str,
    argv: Vec<String>,
    params: BTreeMap<String, String>,
    case_hash: Option<String>,
) -> Result<E2eRunInfo, String> {
    if argv.is_empty() {
        return Err("adapter argv is empty".to_string());
    }
    let runs = runs_dir(root);
    std::fs::create_dir_all(&runs).map_err(|e| format!("{}: {e}", runs.display()))?;
    let started_at = now_rfc3339();
    let launch_id = {
        let mut active = state.lock();
        if active.contains_key(root) {
            return Err("busy".to_string());
        }
        let launch_id = allocate_launch_id(&runs, Utc::now());
        let dir = runs.join(&launch_id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        active.insert(
            root.to_path_buf(),
            Active {
                launch_id: launch_id.clone(),
                case_id: case_id.to_string(),
                started_at: started_at.clone(),
                pgid: None,
                cancelled: false,
            },
        );
        launch_id
    };
    let guard = ActiveGuard {
        state,
        root: root.to_path_buf(),
        launch_id: launch_id.clone(),
    };
    prune_logs(&runs, LOG_RETENTION);

    let start = StartLine {
        launch_id: launch_id.clone(),
        started_at,
        case_id: case_id.to_string(),
        argv: argv.clone(),
        params,
        git: git_info(root).await,
        case_hash,
    };
    append_ledger(root, &LedgerLine::Start(Box::new(start.clone())))?;

    let run_dir = runs.join(&launch_id);
    let log_file = std::fs::File::create(run_dir.join("log"))
        .map_err(|e| log::warn!("e2e: cannot create log: {e}"))
        .ok();
    let sink = Mutex::new(LogSink {
        file: log_file,
        written: 0,
        truncated: false,
    });

    let spawned = login_command(root, &argv).and_then(|mut cmd| {
        cmd.env("KRYPTON_E2E_RESULT", run_dir.join("result.json"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.spawn()
            .map_err(|e| format!("failed to spawn {}: {e}", argv[0]))
    });
    let mut spawn_error = None;
    let exit_code = match spawned {
        Err(e) => {
            sink.lock()
                .unwrap_or_else(|p| p.into_inner())
                .write(format!("{e}\n").as_bytes());
            spawn_error = Some(e);
            None
        }
        Ok(mut child) => {
            let pgid = child.id().map(|p| p as i32);
            let cancel_now = {
                let mut active = state.lock();
                match active.get_mut(root) {
                    Some(entry) if entry.launch_id == launch_id => {
                        entry.pgid = pgid;
                        entry.cancelled
                    }
                    _ => false,
                }
            };
            if cancel_now {
                kill_group(pgid, Signal::Term);
            }
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let (_, _, status) =
                tokio::join!(pump(stdout, &sink), pump(stderr, &sink), child.wait());
            status.ok().and_then(|s| s.code())
        }
    };
    drop(sink);

    let cancelled = state
        .lock()
        .get(root)
        .is_some_and(|a| a.launch_id == launch_id && a.cancelled);
    let finish = FinishLine {
        launch_id,
        finished_at: now_rfc3339(),
        exit_code,
        cancelled,
    };
    let appended = append_ledger(root, &LedgerLine::Finish(finish.clone()));
    drop(guard);
    appended?;
    if let Some(e) = spawn_error {
        return Err(e);
    }
    Ok(launch_run_info(root, &start, Some(&finish)))
}

/// Mark the root's active launch cancelled and SIGTERM its group; a detached
/// task SIGKILLs the group after 5 s if the same launch is still active.
pub(crate) fn cancel_launch(state: &Arc<E2eState>, root: &Path) -> bool {
    let (launch_id, pgid) = {
        let mut active = state.lock();
        let Some(entry) = active.get_mut(root) else {
            return false;
        };
        entry.cancelled = true;
        (entry.launch_id.clone(), entry.pgid)
    };
    kill_group(pgid, Signal::Term);
    let state = Arc::clone(state);
    let root = root.to_path_buf();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CANCEL_KILL_DELAY).await;
        let pgid = state
            .lock()
            .get(&root)
            .filter(|a| a.launch_id == launch_id)
            .and_then(|a| a.pgid);
        kill_group(pgid, Signal::Kill);
    });
    true
}

/// App-exit drain: SIGTERM every active launch's process group.
pub fn shutdown(state: &E2eState) {
    for active in state.lock().values() {
        kill_group(active.pgid, Signal::Term);
    }
}

// ─── Status gathering ───────────────────────────────────────────────

struct Gathered {
    status: E2eStatus,
    cases: Vec<Case>,
    ext_raw: HistoryCache,
}

async fn gather(state: &E2eState, root: &Path, include_issues: bool) -> Gathered {
    let active_launch = state.active_launch(root);
    let ledger = read_ledger(root);
    let krypton = krypton_runs(
        root,
        &ledger,
        active_launch.as_ref().map(|a| a.launch_id.as_str()),
    );
    let mut status = E2eStatus {
        initialized: false,
        manifest: None,
        errors: Vec::new(),
        cases: Vec::new(),
        runs: Vec::new(),
        issues: None,
        issues_error: None,
        active_launch,
    };
    let mut gathered_cases = Vec::new();
    let mut ext_raw = HashMap::new();

    let path = manifest_path(root);
    if !path.exists() {
        status.runs = merge_runs(krypton, Vec::new());
        return Gathered {
            status,
            cases: gathered_cases,
            ext_raw,
        };
    }
    status.initialized = true;
    let manifest = match std::fs::read_to_string(&path) {
        Err(e) => {
            status.errors.push(format!("project.toml: {e}"));
            None
        }
        Ok(text) => match parse_manifest(&text) {
            Ok((manifest, warnings)) => {
                for w in warnings {
                    log::warn!("e2e {}: project.toml: {w}", root.display());
                }
                Some(manifest)
            }
            Err(errors) => {
                status.errors.extend(prefix_errors("project.toml", &errors));
                None
            }
        },
    };
    let Some(manifest) = manifest else {
        status.runs = merge_runs(krypton, Vec::new());
        return Gathered {
            status,
            cases: gathered_cases,
            ext_raw,
        };
    };
    status.manifest = Some(E2eManifestInfo {
        name: manifest.name.clone(),
        history: manifest.history,
        issue_label: manifest.issue_label.clone(),
        create_prompt: manifest.create_prompt.clone(),
        report_prompt: manifest.report_prompt.clone(),
    });

    match list_cases(root, &manifest).await {
        Ok(cases) => {
            status.cases = case_infos(root, &cases).await;
            gathered_cases = cases;
        }
        Err(e) => status.errors.push(e),
    }

    let mut ext = Vec::new();
    if manifest.history {
        match adapter_json(root, &manifest, "history").await {
            Ok(value) => {
                let (runs, errors) = validate_history(&value);
                status.errors.extend(prefix_errors("history", &errors));
                for (result, raw) in runs {
                    ext.push(ext_run_info(root, &result));
                    ext_raw.insert((result.case_id, result.run_id), raw);
                }
            }
            Err(e) => status.errors.push(e),
        }
    }
    status.runs = merge_runs(krypton, ext);
    state
        .history_lock()
        .insert(root.to_path_buf(), ext_raw.clone());

    if include_issues {
        if let Some(label) = &manifest.issue_label {
            let run_ids: Vec<String> = status.runs.iter().map(|r| r.run_id.clone()).collect();
            match fetch_issues(root, label, &run_ids).await {
                Ok(issues) => status.issues = Some(issues),
                Err(e) => status.issues_error = Some(e),
            }
        }
    }
    Gathered {
        status,
        cases: gathered_cases,
        ext_raw,
    }
}

async fn fetch_issues(
    root: &Path,
    label: &str,
    run_ids: &[String],
) -> Result<Vec<E2eIssueInfo>, String> {
    let argv: Vec<String> = [
        "gh",
        "issue",
        "list",
        "--label",
        label,
        "--state",
        "all",
        "--limit",
        "200",
        "--json",
        "number,title,state,url,comments",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let stdout = run_capture(root, &argv, "gh", LIST_TIMEOUT)
        .await
        .map_err(|f| {
            f.stderr
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(str::to_string)
                .unwrap_or(f.message)
        })?;
    let value: Value =
        serde_json::from_str(&stdout).map_err(|e| format!("gh: output is not JSON: {e}"))?;
    let items = value
        .as_array()
        .ok_or_else(|| "gh: expected a JSON array".to_string())?;
    Ok(items
        .iter()
        .filter_map(|item| {
            let bodies: Vec<String> = item
                .get("comments")
                .and_then(Value::as_array)
                .map(|comments| {
                    comments
                        .iter()
                        .filter_map(|c| c.get("body").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let text = |key: &str| {
                item.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            Some(E2eIssueInfo {
                number: item.get("number").and_then(Value::as_u64)?,
                title: text("title"),
                url: text("url"),
                state: text("state"),
                reported_run_ids: reported_run_ids(&bodies, run_ids),
            })
        })
        .collect())
}

// ─── Command bodies ─────────────────────────────────────────────────

pub(crate) fn write_guides(root: &Path) -> Result<Option<String>, String> {
    let dir = e2e_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for (name, text) in [("CONTRACT.md", CONTRACT_MD), ("BOOTSTRAP.md", BOOTSTRAP_MD)] {
        let path = dir.join(name);
        std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    match std::fs::read_to_string(manifest_path(root)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("project.toml: {e}")),
    }
}

pub(crate) async fn run_case(
    state: &E2eState,
    root: &Path,
    case_id: &str,
    params: &BTreeMap<String, String>,
    fresh: bool,
) -> Result<E2eRunInfo, String> {
    if state.lock().contains_key(root) {
        return Err("busy".to_string());
    }
    let manifest = load_manifest(root)?;
    let cases = list_cases(root, &manifest).await?;
    let case = cases.iter().find(|c| c.id == case_id).ok_or_else(|| {
        let known: Vec<&str> = cases.iter().map(|c| c.id.as_str()).collect();
        format!("unknown case \"{case_id}\"; known: {}", known.join(", "))
    })?;
    let merged = merge_params(case, params, fresh);
    let argv = build_run_argv(&manifest.adapter, case_id, &merged);
    let hash = case_hash(root, &case.files);
    run_launch(state, root, case_id, argv, merged, hash)
        .await
        .map(|info| E2eRunInfo {
            code: case.code.clone(),
            ..info
        })
}

pub(crate) async fn rerun_last(state: &E2eState, root: &Path) -> Result<E2eRunInfo, String> {
    let start = read_ledger(root)
        .into_iter()
        .rev()
        .find_map(|line| match line {
            LedgerLine::Start(start) => Some(start),
            LedgerLine::Finish(_) => None,
        })
        .ok_or_else(|| "no previous launch".to_string())?;
    if state.lock().contains_key(root) {
        return Err("busy".to_string());
    }
    // Best effort: the hash and code need the case's `list` entry.
    let case = match load_manifest(root) {
        Ok(manifest) => list_cases(root, &manifest)
            .await
            .ok()
            .and_then(|cases| cases.into_iter().find(|c| c.id == start.case_id)),
        Err(_) => None,
    };
    let hash = case.as_ref().and_then(|c| case_hash(root, &c.files));
    run_launch(
        state,
        root,
        &start.case_id,
        start.argv.clone(),
        start.params.clone(),
        hash,
    )
    .await
    .map(|info| E2eRunInfo {
        code: case.and_then(|c| c.code),
        ..info
    })
}

pub(crate) async fn find_run(
    state: &E2eState,
    root: &Path,
    target: &str,
) -> Result<E2eFoundRun, String> {
    let gathered = gather(state, root, false).await;
    let runs = &gathered.status.runs;
    let run = runs
        .iter()
        .find(|r| r.run_id == target || r.launch_id.as_deref() == Some(target))
        .or_else(|| {
            runs.iter()
                .find(|r| r.case_id == target && matches!(r.verdict.as_str(), "PASS" | "FAIL"))
        })
        .ok_or_else(|| format!("no run matches \"{target}\""))?;
    let result_path = match run.origin.as_str() {
        "krypton" => run
            .result_path
            .clone()
            .ok_or_else(|| format!("run {} has no result file", run.run_id))?,
        _ => {
            let raw = gathered
                .ext_raw
                .get(&(run.case_id.clone(), run.run_id.clone()))
                .ok_or_else(|| format!("run {} has no result", run.run_id))?;
            let dir_name = ext_dir_name(&run.case_id, &run.run_id);
            let dir = runs_dir(root).join(&dir_name);
            std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            let text = serde_json::to_string_pretty(raw).map_err(|e| e.to_string())?;
            let file = dir.join("result.json");
            std::fs::write(&file, text).map_err(|e| format!("{}: {e}", file.display()))?;
            run_rel(&dir_name, "result.json")
        }
    };
    Ok(E2eFoundRun {
        case_id: run.case_id.clone(),
        run_id: run.run_id.clone(),
        issue: gathered
            .cases
            .iter()
            .find(|c| c.id == run.case_id)
            .and_then(|c| c.issue),
        result_path,
    })
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

fn adapter_resolves(root: &Path, program: &str) -> bool {
    if program.contains('/') {
        let path = Path::new(program);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        };
        return path.is_file();
    }
    crate::pty::cached_login_path()
        .split(':')
        .filter(|dir| !dir.is_empty())
        .any(|dir| is_executable(&Path::new(dir).join(program)))
}

/// MCP `e2e_adapter_check` body.
pub(crate) async fn adapter_check(root: &Path, result_path: Option<&str>) -> E2eAdapterCheck {
    let mut report = E2eAdapterCheck {
        ok: false,
        name: String::new(),
        cases: 0,
        errors: Vec::new(),
        warnings: Vec::new(),
    };
    let text = match std::fs::read_to_string(manifest_path(root)) {
        Ok(text) => text,
        Err(e) => {
            report
                .errors
                .push(format!("project.toml: .krypton/e2e/project.toml: {e}"));
            return report;
        }
    };
    let manifest = match parse_manifest(&text) {
        Ok((manifest, warnings)) => {
            report
                .warnings
                .extend(prefix_errors("project.toml", &warnings));
            manifest
        }
        Err(errors) => {
            report.errors.extend(prefix_errors("project.toml", &errors));
            return report;
        }
    };
    report.name = manifest.name.clone();
    if !adapter_resolves(root, &manifest.adapter[0]) {
        report.errors.push(format!(
            "adapter[0]: \"{}\" not found (relative paths resolve from the project root; bare names on the login PATH)",
            manifest.adapter[0]
        ));
    }
    let cases = match list_cases(root, &manifest).await {
        Ok(cases) => {
            report.cases = cases.len();
            if cases.is_empty() {
                report.warnings.push("list: no cases".to_string());
            }
            Some(cases)
        }
        Err(e) => {
            report.errors.push(e);
            None
        }
    };
    if let Some(path) = result_path {
        match confine_result_path(root, path) {
            Err(e) => report.errors.push(e),
            Ok(file) => {
                let parsed = std::fs::read_to_string(&file)
                    .map_err(|e| vec![format!("{e}")])
                    .and_then(|text| {
                        serde_json::from_str::<Value>(&text).map_err(|e| vec![format!("{e}")])
                    })
                    .and_then(|value| validate_result(&value, ""));
                match parsed {
                    Err(errors) => report.errors.extend(prefix_errors("result", &errors)),
                    Ok(result) => {
                        if let Some(cases) = &cases {
                            if !cases.iter().any(|c| c.id == result.case_id) {
                                report.errors.push(format!(
                                    "result: caseId \"{}\" is not a listed case",
                                    result.case_id
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    if manifest.history {
        match adapter_json(root, &manifest, "history").await {
            Ok(value) => {
                let (_, errors) = validate_history(&value);
                report.errors.extend(prefix_errors("history", &errors));
            }
            Err(e) => report.errors.push(e),
        }
    }
    report.ok = report.errors.is_empty();
    report
}

// ─── Browser explorer (spec 0329) ───────────────────────────────────

/// Adapter artifacts are served up to this size, like `/review-asset`.
const ARTIFACT_MAX_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eArtifactInfo {
    pub label: String,
    pub path: String,
    pub size: Option<u64>,
    /// Why the file cannot be served: missing, outside the project, too large.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eRunDetail {
    pub info: E2eRunInfo,
    /// The full validated Result; `None` for INTERRUPTED, NO RESULT and INVALID RESULT.
    pub result: Option<Value>,
    /// A Krypton log exists for this launch.
    pub log: bool,
    pub artifacts: Vec<E2eArtifactInfo>,
}

/// The same `gather` as `#e2e status`; it also refills the history cache.
pub(crate) async fn status(state: &E2eState, root: &Path, include_issues: bool) -> E2eStatus {
    gather(state, root, include_issues).await.status
}

/// One run with its full Result. A Krypton run comes from the ledger and
/// `runs/<launchId>/result.json` (matched by runId or launchId), an ext run
/// from the history cache; the Krypton record wins, as in `merge_runs`.
/// `not_found:` errors mean no such run.
pub(crate) fn run_detail(
    state: &E2eState,
    root: &Path,
    case_id: &str,
    run_id: &str,
) -> Result<E2eRunDetail, String> {
    let ledger = read_ledger(root);
    let finishes: HashMap<&str, &FinishLine> = ledger
        .iter()
        .filter_map(|line| match line {
            LedgerLine::Finish(f) => Some((f.launch_id.as_str(), f)),
            LedgerLine::Start(_) => None,
        })
        .collect();
    for line in &ledger {
        let LedgerLine::Start(start) = line else {
            continue;
        };
        if start.case_id != case_id {
            continue;
        }
        let info = launch_run_info(root, start, finishes.get(start.launch_id.as_str()).copied());
        if info.run_id != run_id && start.launch_id != run_id {
            continue;
        }
        let run_dir = runs_dir(root).join(&start.launch_id);
        let result = std::fs::read_to_string(run_dir.join("result.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(|value| validate_result(value, "").is_ok());
        return Ok(E2eRunDetail {
            info,
            artifacts: artifact_infos(root, result.as_ref()),
            log: run_dir.join("log").is_file(),
            result,
        });
    }
    let raw = state
        .history_lock()
        .get(root)
        .and_then(|cache| {
            cache
                .get(&(case_id.to_string(), run_id.to_string()))
                .cloned()
        })
        .ok_or_else(|| format!("not_found: no run {run_id} of case {case_id}"))?;
    let parsed = validate_result(&raw, "").map_err(|errors| errors.join("; "))?;
    Ok(E2eRunDetail {
        info: ext_run_info(root, &parsed),
        artifacts: artifact_infos(root, Some(&raw)),
        log: false,
        result: Some(raw),
    })
}

/// A validated Result's `artifacts`, each resolved now so the page can mark
/// the ones it cannot open. Indexes match the Result's array.
fn artifact_infos(root: &Path, result: Option<&Value>) -> Vec<E2eArtifactInfo> {
    let Some(items) = result
        .and_then(|r| r.get("artifacts"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| {
            let text = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or_default();
            let path = text("path").to_string();
            let (size, problem) = match resolve_artifact(root, &path) {
                Ok((_, size)) => (Some(size), None),
                Err(e) => (
                    None,
                    Some(
                        e.split_once(": ")
                            .map_or(e.clone(), |(_, why)| why.to_string()),
                    ),
                ),
            };
            E2eArtifactInfo {
                label: text("label").to_string(),
                path,
                size,
                problem,
            }
        })
        .collect()
}

/// Confine an adapter artifact (repo-relative per Contract v1) to the
/// canonical root: no absolute path or `..`, no symlink escape, a regular
/// file of at most 25 MiB. Errors are `bad_path:`, `not_found:` or `too_large:`.
pub(crate) fn resolve_artifact(root: &Path, path: &str) -> Result<(PathBuf, u64), String> {
    if !is_relative_clean(path) {
        return Err("bad_path: not a repo-relative path".to_string());
    }
    let base = root
        .canonicalize()
        .map_err(|e| format!("not_found: project root: {e}"))?;
    let resolved = base
        .join(path)
        .canonicalize()
        .map_err(|_| "not_found: missing".to_string())?;
    if !resolved.starts_with(&base) {
        return Err("bad_path: outside the project".to_string());
    }
    let meta = std::fs::metadata(&resolved).map_err(|_| "not_found: missing".to_string())?;
    if !meta.is_file() {
        return Err("not_found: not a file".to_string());
    }
    if meta.len() > ARTIFACT_MAX_BYTES {
        return Err(format!(
            "too_large: {} MiB, over the 25 MiB cap",
            meta.len() / (1024 * 1024)
        ));
    }
    Ok((resolved, meta.len()))
}

/// The bytes of artifact `index` of one run, with its resolved path.
pub(crate) fn run_artifact(
    state: &E2eState,
    root: &Path,
    case_id: &str,
    run_id: &str,
    index: usize,
) -> Result<(PathBuf, Vec<u8>), String> {
    let detail = run_detail(state, root, case_id, run_id)?;
    let artifact = detail
        .artifacts
        .get(index)
        .ok_or_else(|| format!("not_found: run {run_id} has no artifact {index}"))?;
    let (path, _) = resolve_artifact(root, &artifact.path)?;
    let bytes = std::fs::read(&path).map_err(|_| "not_found: missing".to_string())?;
    Ok((path, bytes))
}

/// The Krypton log of a launch the ledger lists. The path is built from the
/// ledger's id, which must be a plain file-name component.
pub(crate) fn launch_log(root: &Path, launch_id: &str) -> Result<Vec<u8>, String> {
    let plain = !launch_id.is_empty()
        && !launch_id.starts_with('.')
        && sanitize_component(launch_id) == launch_id;
    let listed = plain
        && read_ledger(root)
            .iter()
            .any(|line| matches!(line, LedgerLine::Start(s) if s.launch_id == launch_id));
    if !listed {
        return Err(format!("not_found: no launch {launch_id}"));
    }
    std::fs::read(runs_dir(root).join(launch_id).join("log"))
        .map_err(|_| format!("not_found: launch {launch_id} has no log"))
}

// ─── Tauri commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn e2e_write_guides(root: String) -> Result<Option<String>, String> {
    write_guides(&root_path(&root)?)
}

#[tauri::command]
pub async fn e2e_status(
    state: tauri::State<'_, Arc<E2eState>>,
    root: String,
    include_issues: Option<bool>,
) -> Result<E2eStatus, String> {
    let root = root_path(&root)?;
    Ok(status(&state, &root, include_issues.unwrap_or(false)).await)
}

#[tauri::command]
pub async fn e2e_run(
    state: tauri::State<'_, Arc<E2eState>>,
    root: String,
    case_id: String,
    params: Option<BTreeMap<String, String>>,
    fresh: Option<bool>,
) -> Result<E2eRunInfo, String> {
    let root = root_path(&root)?;
    run_case(
        &state,
        &root,
        &case_id,
        &params.unwrap_or_default(),
        fresh.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn e2e_rerun(
    state: tauri::State<'_, Arc<E2eState>>,
    root: String,
) -> Result<E2eRunInfo, String> {
    rerun_last(&state, &root_path(&root)?).await
}

#[tauri::command]
pub fn e2e_cancel(state: tauri::State<'_, Arc<E2eState>>, root: String) -> Result<bool, String> {
    Ok(cancel_launch(state.inner(), &root_path(&root)?))
}

#[tauri::command]
pub async fn e2e_find_run(
    state: tauri::State<'_, Arc<E2eState>>,
    root: String,
    target: String,
) -> Result<E2eFoundRun, String> {
    find_run(&state, &root_path(&root)?, &target).await
}

// ─── Guide texts ────────────────────────────────────────────────────

pub(crate) const CONTRACT_MD: &str = r##"# Krypton E2E Adapter Contract v1

> Written by Krypton on every `#e2e init`. Do not edit — it is overwritten.
> Krypton's validator is the source of truth; `e2e_adapter_check` runs it.

Krypton runs and tracks this project's end-to-end tests from the ACP Harness
(`#e2e status`, `#e2e run`, `#e2e rerun`, `#e2e cancel`, `#e2e report`). It does
not know your test stack. It talks to one **adapter** — a command you provide —
through three subcommands and one normalized **Result** JSON per run.

## Files in `.krypton/e2e/`

| File | Written by |
|---|---|
| `CONTRACT.md`, `BOOTSTRAP.md` | Krypton (every `#e2e init`) |
| `PLAN.md` | the lane (Bootstrap mode only); Krypton never reads it |
| `project.toml` | the lane or the user |
| adapter files (optional; the adapter may live elsewhere in the repo) | the lane or the user |
| `launches.jsonl`, `runs/<launchId>/result.json`, `runs/<launchId>/log` | Krypton |

## Manifest: `.krypton/e2e/project.toml`

```toml
version = 1                                     # required, must be 1
name = "my-app e2e"                             # required, non-empty
adapter = ["node", ".krypton/e2e/adapter.mjs"]  # required argv prefix, run with cwd = repo root
history = true                                  # optional (default false): adapter implements `history`
issue_label = "type: Automate E2E"              # optional: GitHub label of e2e issues (status marks)
create_prompt = "Write the e2e case for {issue_url} following e2e/README.md."        # optional: `#e2e case <issue>`
report_prompt = "Post run {run_id} ({result_path}) as a comment on {issue_url}; the comment must contain {run_id}."  # optional: `#e2e report`
```

- `adapter` is a non-empty array of non-empty strings. `adapter[0]` is either a
  path containing `/` (relative to the repo root, or absolute) or a bare program
  name found on the user's login-shell `PATH`.
- Placeholders: `create_prompt` → `{issue}`, `{issue_url}`; `report_prompt` →
  `{issue}`, `{issue_url}`, `{run_id}`, `{result_path}`.
- Unknown keys are warnings, not errors.

## Subcommands

Krypton spawns `<adapter…> <subcommand> …` with the repo root as cwd, the
user's login-shell environment, **stdin closed** (no TTY — nothing may prompt),
and its own process group (cancel kills the whole group).

| Subcommand | Output | Rule |
|---|---|---|
| `<adapter…> list` | stdout: `{"version":1,"cases":[Case]}` | exit 0 within 60 s |
| `<adapter…> run <caseId> [--param k=v]…` | log on stdout/stderr; write the Result JSON to the file named by `$KRYPTON_E2E_RESULT` before exiting | exit code is informational |
| `<adapter…> history` | stdout: `{"version":1,"runs":[Result]}` — runs made outside Krypton | only when `history = true`; exit 0 within 60 s |

- `list` and `history` print **only** the JSON on stdout (diagnostics go to
  stderr). Non-zero exit or > 60 s is an error; Krypton shows the last 20
  stderr lines.
- `run` receives each parameter as a separate `--param` `key=value` pair,
  sorted by key. It must accept any parameter the case declares in `params` or
  `fresh`.
- `$KRYPTON_E2E_RESULT` is an absolute path. Create its parent directory if it
  does not exist. A run that writes no Result shows as `NO RESULT`; an invalid
  one as `INVALID RESULT`.
- Krypton captures stdout+stderr of `run` into `runs/<launchId>/log` (5 MB cap).

## Case (one entry of `list`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Krypton e2e case list v1",
  "type": "object",
  "required": ["version", "cases"],
  "properties": {
    "version": { "const": 1 },
    "cases": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "title"],
        "properties": {
          "id": { "type": "string", "minLength": 1, "pattern": "^[^-]", "description": "unique across the list; must not start with '-'" },
          "title": { "type": "string", "minLength": 1 },
          "code": { "type": "string", "description": "short human code, e.g. a test-plan id" },
          "issue": { "type": "integer", "minimum": 1, "description": "GitHub issue number this case covers" },
          "params": { "type": "object", "additionalProperties": { "type": ["string", "number"] }, "description": "declared parameters and their defaults" },
          "fresh": { "type": "object", "additionalProperties": { "type": "string" }, "description": "params that request single-use data, used by `#e2e run --fresh`" },
          "files": { "type": "array", "items": { "type": "string", "description": "repo-relative path (file or directory); no absolute paths, no '..'" } }
        }
      }
    }
  }
}
```

- `files` lists the case's own source (e.g. `["e2e/cases/1331"]`). Krypton
  hashes them to mark a case `edited` since its last PASS and `uncommitted`
  when git shows changes.
- `fresh`: `#e2e run <case> --fresh` starts from the case's `fresh` map, then
  explicit `k=v` arguments override it. Use it for single-use data, e.g.
  `{"tempRpNo": "new"}` meaning "create a new record instead of reusing one".

## Result (written by `run`, items of `history`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Krypton e2e Result v1",
  "type": "object",
  "required": ["version", "caseId", "runId", "verdict", "startedAt", "finishedAt", "checks"],
  "properties": {
    "version": { "const": 1 },
    "caseId": { "type": "string", "minLength": 1 },
    "runId": { "type": "string", "minLength": 1, "description": "the adapter's own id, unique per case and stable" },
    "verdict": { "enum": ["PASS", "FAIL", "ERROR", "BLOCKED"] },
    "startedAt": { "type": "string", "format": "date-time", "description": "RFC 3339" },
    "finishedAt": { "type": "string", "format": "date-time", "description": "RFC 3339" },
    "env": { "type": "string", "description": "target environment name" },
    "versions": { "type": "object", "additionalProperties": { "type": "string" }, "description": "component → version under test" },
    "params": { "type": "object", "additionalProperties": { "type": ["string", "number", "boolean"] } },
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["label", "status"],
        "properties": {
          "group": { "type": "string" },
          "label": { "type": "string", "minLength": 1 },
          "status": { "enum": ["pass", "fail", "skip", "blocked", "info"] },
          "detail": { "type": "string" }
        }
      }
    },
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["label", "path"],
        "properties": { "label": { "type": "string", "minLength": 1 }, "path": { "type": "string", "minLength": 1 } }
      }
    },
    "message": { "type": "string" }
  }
}
```

## Rules

- **Paths** (`files`, `artifacts[].path`) are relative to the repo root.
- **runId** is the adapter's own id, unique per case and stable: the same run
  reported by `run` and later by `history` must carry the same `runId`, because
  Krypton dedupes by `(caseId, runId)`. A timestamp like `20261023T082053Z` works.
- **Verdicts.** `PASS` every expected result held. `FAIL` the app was exercised
  and at least one expected result did not hold. `BLOCKED` a precondition failed
  (environment down, missing data or secret) and the app was never exercised —
  never report that as `FAIL`. `ERROR` the harness itself broke.
- **Checks.** One check per expected result, in order; `group` is the section
  or phase. `detail` says what was observed. `info` is for notes, not assertions.
- **Secrets** come from environment variables; never write their values into
  the Result, the log or the repo.
- Nothing may wait for input: stdin is closed. SSH must use keys/agent
  (`BatchMode=yes`).

## Smoke procedure (end of `#e2e init`)

1. Run the first case through the adapter exactly as Krypton would:

   ```sh
   KRYPTON_E2E_RESULT=.krypton/e2e/smoke-result.json <adapter…> run <first case id>
   ```

2. Call the MCP tool `e2e_adapter_check` with
   `{"result_path": ".krypton/e2e/smoke-result.json"}`.
3. Fix every reported error and repeat until it returns `"ok": true`.

Any verdict is acceptable for the smoke run: `BLOCKED` because the environment
is down still proves the wiring.
"##;

pub(crate) const BOOTSTRAP_MD: &str = r##"# Krypton E2E Initialize — Adopt or Bootstrap

> Written by Krypton on every `#e2e init`. Do not edit — it is overwritten.
> Read `CONTRACT.md` in this directory first: it defines the manifest, the
> adapter subcommands and the Result format.

## 1. Survey the repo

Read the README, package and build files, test folders, CI config,
`.claude/skills`, `docs/`, and AGENTS.md / CLAUDE.md.

## 2. Decide the mode

- **Adopt** — the repo already runs e2e or integration tests against a running
  app. Write `.krypton/e2e/project.toml` and an adapter in `.krypton/e2e/` that
  wraps the existing runner (`list` enumerates its cases, `run` invokes it and
  converts its report into a Result, `history` converts the reports it already
  keeps). Do **not** change project code. Then go to step 5.
- **Bootstrap** — nothing runs the app end to end. Build an e2e setup from zero
  in two phases: plan (step 3), then build after the user approves (step 4).

## 3. Bootstrap phase A — `PLAN.md`

Write `.krypton/e2e/PLAN.md` with these seven sections, each answered from what
the repo shows (say so when you are guessing):

1. **What to test.** App kind (web UI, HTTP API, multi-service flow, CLI) and
   the first case: an issue, or the main happy path.
2. **Target environment.** A start command or an existing URL/host, and how the
   runner checks that it is up. A missing or unreachable environment gives
   `BLOCKED`, never `FAIL`.
3. **Stack, with the reason.** Defaults unless the repo points elsewhere:
   - web UI → Playwright Test;
   - HTTP API → the repo's own test runner, or Hurl when it has none;
   - multi-service flow → a script harness in the repo's language with
     prepare / execute / verify steps;
   - CLI → a script harness.
4. **Layout**, and how a case maps to an issue (case id, `issue`, `files`).
5. **Test data and secrets.** Which data is single-use and its `fresh` params.
   Secrets by environment variable **name** only — never values.
6. **Dependencies.** Project-local packages only (devDependencies etc.).
   Machine-wide tools (browsers, runtimes, CLIs) are listed as manual steps for
   the user; never install them yourself.
7. **Manifest.** Proposed `issue_label`, `create_prompt`, `report_prompt`.

Then **stop**. End your turn by asking the user to review and approve the plan
(they may edit `PLAN.md` first). Write no other files in phase A.

## 4. Bootstrap phase B — build (after the user approves)

- Put the code in the repo (for example `e2e/`) and leave it **uncommitted**.
  Follow the repo's AGENTS.md / CLAUDE.md conventions and language.
- The runner implements `list`, `run` and `history` natively, so
  `project.toml`'s `adapter` points straight at it, and it still runs by hand
  from a terminal.
- Preconditions (environment up, data and secrets present) are checked first;
  any failure gives `BLOCKED`.
- One check per expected result. Keep the raw evidence of every run (responses,
  screenshots, logs) in a per-run folder and list it in `artifacts`.
- Write a README for the e2e folder with a **"Run"** section and an **"Adding a
  case"** section; `create_prompt` points at that README.
- Implement the first case from the plan.
- Never install machine-wide tools; list them as manual steps.

## 5. Finish (both modes)

1. Write `.krypton/e2e/project.toml` (see `CONTRACT.md`).
2. Run the smoke procedure from `CONTRACT.md`:
   `KRYPTON_E2E_RESULT=.krypton/e2e/smoke-result.json <adapter…> run <first case>`.
3. Call `e2e_adapter_check {"result_path": ".krypton/e2e/smoke-result.json"}`
   and fix errors until it returns ok. Any verdict (even `BLOCKED`) is fine.
4. Report what you built and how to run it.

**Never commit** — not in Adopt, not in Bootstrap. The user reviews and commits.
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Instant;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let unique = format!(
                "krypton-e2e-{name}-{}-{}-{}",
                std::process::id(),
                Utc::now().timestamp_nanos_opt().unwrap_or_default(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(path.join(".krypton/e2e/runs")).unwrap();
            TempDir(path.canonicalize().unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn errs<T: std::fmt::Debug>(r: Result<T, Vec<String>>) -> Vec<String> {
        r.expect_err("expected validation errors")
    }

    fn has(errors: &[String], needle: &str) -> bool {
        errors.iter().any(|e| e == needle)
    }

    // ── manifest ──

    #[test]
    fn e2e_manifest_valid_with_warning() {
        let (m, warnings) = parse_manifest(
            "version = 1\nname = \"x\"\nadapter = [\"node\", \"a.mjs\"]\nhistory = true\nissue_label = \"e2e\"\nextra = 1\n",
        )
        .unwrap();
        assert_eq!(m.name, "x");
        assert_eq!(m.adapter, vec!["node", "a.mjs"]);
        assert!(m.history);
        assert_eq!(m.issue_label.as_deref(), Some("e2e"));
        assert_eq!(warnings, vec!["unknown key \"extra\""]);
    }

    #[test]
    fn e2e_manifest_rules() {
        let e = errs(parse_manifest(
            "version = 2\nname = \"\"\nadapter = []\nhistory = \"yes\"\nissue_label = \"\"\ncreate_prompt = 3\nreport_prompt = \" \"\n",
        ));
        for needle in [
            "version: must be 1",
            "name: must be a non-empty string",
            "adapter: must be a non-empty array of non-empty strings",
            "history: must be a boolean",
            "issue_label: must be a non-empty string",
            "create_prompt: must be a non-empty string",
            "report_prompt: must be a non-empty string",
        ] {
            assert!(has(&e, needle), "missing {needle}: {e:?}");
        }
        let e = errs(parse_manifest(
            "version = 1\nname = \"x\"\nadapter = [\"node\", \"\"]\n",
        ));
        assert_eq!(e, vec!["adapter[1]: must be a non-empty string"]);
        assert_eq!(errs(parse_manifest("not toml = = ")).len(), 1);
    }

    // ── case list ──

    #[test]
    fn e2e_case_list_valid() {
        let cases = validate_case_list(&json!({"version":1,"cases":[
            {"id":"1331","title":"t","code":"C1","issue":1331,"params":{"a":"x","b":2},"fresh":{"a":"new"},"files":["e2e/cases/1331"]}
        ]}))
        .unwrap();
        assert_eq!(cases[0].issue, Some(1331));
        assert_eq!(cases[0].fresh.get("a").map(String::as_str), Some("new"));
        assert_eq!(cases[0].files, vec!["e2e/cases/1331"]);
    }

    #[test]
    fn e2e_case_list_rules() {
        let e = errs(validate_case_list(&json!({"version":2,"cases":[
            {"id":"1331","title":"a"},
            {"id":"x","title":"b"},
            {"id":"1331","title":"c"},
            {"id":"-x","title":"d"},
            {"id":"y","title":"","issue":0},
            {"id":"z","title":"e","issue":"7","params":{"p":true},"fresh":{"f":1}},
            {"id":"w","title":"f","files":["/abs","../up","ok/../x", 3]},
            {"title":"g"},
            5
        ]})));
        for needle in [
            "version: must be 1",
            "cases[2].id: duplicate \"1331\"",
            "cases[3].id: \"-x\" must not start with '-'",
            "cases[4].title: must be a non-empty string",
            "cases[4].issue: 0 is not a positive integer",
            "cases[5].issue: \"7\" is not a positive integer",
            "cases[5].params.p: must be a string or number",
            "cases[5].fresh.f: must be a string",
            "cases[6].files[0]: \"/abs\" must be a relative path without \"..\"",
            "cases[6].files[1]: \"../up\" must be a relative path without \"..\"",
            "cases[6].files[2]: \"ok/../x\" must be a relative path without \"..\"",
            "cases[6].files[3]: must be a string",
            "cases[7].id: required",
            "cases[8]: must be an object",
        ] {
            assert!(has(&e, needle), "missing {needle}: {e:?}");
        }
        assert_eq!(
            errs(validate_case_list(&json!({"version":1}))),
            vec!["cases: must be an array"]
        );
        assert_eq!(
            errs(validate_case_list(&json!([]))),
            vec!["$: must be an object"]
        );
    }

    // ── result ──

    fn good_result() -> Value {
        json!({
            "version":1,"caseId":"1331","runId":"r1","verdict":"FAIL",
            "startedAt":"2026-10-23T08:17:09Z","finishedAt":"2026-10-23T08:20:37+07:00",
            "env":"dev","versions":{"api":"v3"},"params":{"a":"x","n":1,"b":true},
            "checks":[
                {"group":"g","label":"one","status":"pass"},
                {"label":"two","status":"fail","detail":"boom"},
                {"label":"three","status":"blocked"},
                {"label":"four","status":"info"}
            ],
            "artifacts":[{"label":"report","path":"e2e/r.md"}],
            "message":"m"
        })
    }

    #[test]
    fn e2e_result_valid() {
        let r = validate_result(&good_result(), "").unwrap();
        assert_eq!(r.run_id, "r1");
        assert_eq!(r.checks.len(), 4);
        let (counts, failed) = summarize_checks(&r.checks);
        assert_eq!(
            (counts.pass, counts.fail, counts.blocked, counts.info),
            (1, 1, 1, 1)
        );
        assert_eq!(failed.len(), 2);
        assert_eq!(failed[0].detail.as_deref(), Some("boom"));
    }

    #[test]
    fn e2e_result_rules() {
        let mut v = good_result();
        v["version"] = json!(0);
        v.as_object_mut().unwrap().remove("runId");
        v["verdict"] = json!("OK");
        v["startedAt"] = json!("yesterday");
        v["versions"] = json!({"api": 3});
        v["params"] = json!({"o": {}});
        v["checks"] = json!([
            {"label":"a","status":"pass"},
            {"label":"","status":"pass"},
            {"label":"c","status":"pass"},
            {"label":"d","status":"pass"},
            {"label":"e","status":"ok"},
            "x"
        ]);
        v["artifacts"] = json!([{"label":"a"}]);
        let e = errs(validate_result(&v, ""));
        for needle in [
            "version: must be 1",
            "runId: required",
            "verdict: \"OK\" is not one of PASS|FAIL|ERROR|BLOCKED",
            "startedAt: \"yesterday\" is not an RFC3339 timestamp",
            "versions.api: must be a string",
            "params.o: must be a string, number or boolean",
            "checks[1].label: must be a non-empty string",
            "checks[4].status: \"ok\" is not one of pass|fail|skip|blocked|info",
            "checks[5]: must be an object",
            "artifacts[0].path: required",
        ] {
            assert!(has(&e, needle), "missing {needle}: {e:?}");
        }
        let mut v = good_result();
        v["runId"] = json!("");
        v.as_object_mut().unwrap().remove("checks");
        let e = errs(validate_result(&v, "runs[3]."));
        assert!(
            has(&e, "runs[3].runId: must be a non-empty string"),
            "{e:?}"
        );
        assert!(has(&e, "runs[3].checks: must be an array"), "{e:?}");
    }

    #[test]
    fn e2e_history_one_error_per_invalid_item() {
        let mut bad = good_result();
        bad["verdict"] = json!("X");
        let (runs, errors) = validate_history(&json!({"version":1,"runs":[good_result(), bad]}));
        assert_eq!(runs.len(), 1);
        assert_eq!(
            errors,
            vec!["runs[1].verdict: \"X\" is not one of PASS|FAIL|ERROR|BLOCKED"]
        );
    }

    // ── ledger join ──

    fn start(id: &str, case: &str, at: &str) -> LedgerLine {
        LedgerLine::Start(Box::new(StartLine {
            launch_id: id.into(),
            started_at: at.into(),
            case_id: case.into(),
            argv: vec!["a".into(), "run".into(), case.into()],
            params: BTreeMap::new(),
            git: None,
            case_hash: None,
        }))
    }

    fn finish(id: &str, cancelled: bool) -> LedgerLine {
        LedgerLine::Finish(FinishLine {
            launch_id: id.into(),
            finished_at: "2026-10-23T09:00:00Z".into(),
            exit_code: Some(0),
            cancelled,
        })
    }

    fn write_result(root: &Path, launch: &str, text: &str) {
        let dir = runs_dir(root).join(launch);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("result.json"), text).unwrap();
    }

    #[test]
    fn e2e_ledger_parse_skips_malformed() {
        let text = format!(
            "{}\nnot json\n{{\"kind\":\"other\"}}\n{}\n",
            serde_json::to_string(&start("L1", "c", "2026-10-23T08:00:00Z")).unwrap(),
            serde_json::to_string(&finish("L1", false)).unwrap()
        );
        let lines = parse_ledger(&text);
        assert_eq!(lines.len(), 2);
        assert!(text.starts_with("{\"kind\":\"start\",\"launchId\":\"L1\""));
    }

    #[test]
    fn e2e_ledger_join_verdicts() {
        let tmp = TempDir::new("join");
        let root = &tmp.0;
        let mut pass = good_result();
        pass["verdict"] = json!("PASS");
        pass["runId"] = json!("adapter-5");
        write_result(root, "L1", &pass.to_string());
        write_result(root, "L3", "{\"version\":1}");
        write_result(root, "L4", &pass.to_string());
        let ledger = vec![
            start("L1", "c", "2026-10-23T08:01:00Z"),
            finish("L1", false),
            start("L2", "c", "2026-10-23T08:02:00Z"),
            finish("L2", false),
            start("L3", "c", "2026-10-23T08:03:00Z"),
            finish("L3", false),
            start("L4", "c", "2026-10-23T08:04:00Z"),
            finish("L4", true),
            start("L5", "c", "2026-10-23T08:05:00Z"),
            start("L6", "c", "2026-10-23T08:06:00Z"),
        ];
        let runs = krypton_runs(root, &ledger, Some("L6"));
        let by = |id: &str| runs.iter().find(|r| r.launch_id.as_deref() == Some(id));
        let l1 = by("L1").unwrap();
        assert_eq!(l1.verdict, "PASS");
        assert_eq!(l1.run_id, "adapter-5");
        assert_eq!(
            l1.result_path.as_deref(),
            Some(".krypton/e2e/runs/L1/result.json")
        );
        assert_eq!(l1.exit_code, Some(0));
        let l2 = by("L2").unwrap();
        assert_eq!(l2.verdict, "NO RESULT");
        assert_eq!(l2.run_id, "L2");
        let l3 = by("L3").unwrap();
        assert_eq!(l3.verdict, "INVALID RESULT");
        assert!(l3.message.as_deref().unwrap().contains("caseId: required"));
        let l4 = by("L4").unwrap();
        assert_eq!(l4.verdict, "CANCELLED");
        assert_eq!(l4.message.as_deref(), Some("cancelled"));
        assert_eq!(by("L5").unwrap().verdict, "INTERRUPTED");
        assert!(by("L6").is_none(), "active launch is not a run");
        // Not active anymore → INTERRUPTED.
        let runs = krypton_runs(root, &ledger, None);
        assert_eq!(
            runs.iter()
                .find(|r| r.launch_id.as_deref() == Some("L6"))
                .unwrap()
                .verdict,
            "INTERRUPTED"
        );
    }

    #[test]
    fn e2e_merge_dedupes_preferring_krypton_and_sorts() {
        let tmp = TempDir::new("merge");
        let root = &tmp.0;
        let mut pass = good_result();
        pass["runId"] = json!("r1");
        write_result(root, "L1", &pass.to_string());
        let krypton = krypton_runs(
            root,
            &[
                start("L1", "1331", "2026-10-23T08:00:00Z"),
                finish("L1", false),
            ],
            None,
        );
        let mut older = validate_result(&good_result(), "").unwrap();
        older.run_id = "r0".into();
        older.started_at = "2026-10-22T08:00:00Z".into();
        let dup = validate_result(&good_result(), "").unwrap();
        let mut other_case = dup.clone();
        other_case.case_id = "9".into();
        let ext = vec![
            ext_run_info(root, &older),
            ext_run_info(root, &dup),
            ext_run_info(root, &dup),
            ext_run_info(root, &other_case),
        ];
        let runs = merge_runs(krypton, ext);
        assert_eq!(runs.len(), 3);
        let r1: Vec<&E2eRunInfo> = runs
            .iter()
            .filter(|r| r.case_id == "1331" && r.run_id == "r1")
            .collect();
        assert_eq!(r1.len(), 1);
        assert_eq!(r1[0].origin, "krypton");
        assert_eq!(runs.last().unwrap().run_id, "r0", "oldest last");
    }

    #[test]
    fn e2e_reported_run_ids_matching() {
        let bodies = vec![
            "<!-- e2e:1331 --> run 20261023T082053Z PASS".to_string(),
            "nothing".to_string(),
        ];
        let ids = vec![
            "20261023T082053Z".to_string(),
            "20261022T000000Z".to_string(),
            String::new(),
            "20261023T082053Z".to_string(),
        ];
        assert_eq!(reported_run_ids(&bodies, &ids), vec!["20261023T082053Z"]);
        assert!(reported_run_ids(&[], &ids).is_empty());
    }

    #[test]
    fn e2e_result_path_confinement() {
        let tmp = TempDir::new("confine");
        let root = &tmp.0;
        std::fs::write(e2e_dir(root).join("smoke.json"), "{}").unwrap();
        std::fs::write(root.join("outside.json"), "{}").unwrap();
        assert!(confine_result_path(root, ".krypton/e2e/smoke.json").is_ok());
        let abs = e2e_dir(root).join("smoke.json");
        assert!(confine_result_path(root, abs.to_str().unwrap()).is_ok());
        assert!(confine_result_path(root, ".krypton/e2e/../../outside.json")
            .unwrap_err()
            .contains("must be under"));
        assert!(confine_result_path(root, "outside.json")
            .unwrap_err()
            .contains("must be under"));
        assert!(confine_result_path(root, ".krypton/e2e/missing.json").is_err());
    }

    #[test]
    fn e2e_param_precedence_and_argv_order() {
        let case = Case {
            id: "c".into(),
            title: "t".into(),
            code: None,
            issue: None,
            params: Obj::new(),
            fresh: BTreeMap::from([("b".into(), "new".into()), ("z".into(), "new".into())]),
            files: Vec::new(),
        };
        let explicit = BTreeMap::from([
            ("b".to_string(), "mine".to_string()),
            ("a".into(), "1".into()),
        ]);
        let merged = merge_params(&case, &explicit, true);
        assert_eq!(merged.get("b").map(String::as_str), Some("mine"));
        assert_eq!(merged.get("z").map(String::as_str), Some("new"));
        assert_eq!(merge_params(&case, &explicit, false).len(), 2);
        let argv = build_run_argv(&["node".into(), "a.mjs".into()], "c", &merged);
        assert_eq!(
            argv,
            vec![
                "node", "a.mjs", "run", "c", "--param", "a=1", "--param", "b=mine", "--param",
                "z=new"
            ]
        );
    }

    #[test]
    fn e2e_launch_id_collision_suffix() {
        let tmp = TempDir::new("launchid");
        let runs = runs_dir(&tmp.0);
        let now = DateTime::parse_from_rfc3339("2026-10-23T08:17:09Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(allocate_launch_id(&runs, now), "20261023T081709Z");
        std::fs::create_dir_all(runs.join("20261023T081709Z")).unwrap();
        assert_eq!(allocate_launch_id(&runs, now), "20261023T081709Z-2");
        std::fs::create_dir_all(runs.join("20261023T081709Z-2")).unwrap();
        assert_eq!(allocate_launch_id(&runs, now), "20261023T081709Z-3");
    }

    #[test]
    fn e2e_prune_logs_keeps_newest() {
        let tmp = TempDir::new("prune");
        let runs = runs_dir(&tmp.0);
        for name in ["A1", "A2", "A3", "ext-c-r"] {
            std::fs::create_dir_all(runs.join(name)).unwrap();
            std::fs::write(runs.join(name).join("log"), "x").unwrap();
            std::fs::write(runs.join(name).join("result.json"), "{}").unwrap();
        }
        prune_logs(&runs, 2);
        assert!(!runs.join("A1/log").exists());
        assert!(runs.join("A1/result.json").exists());
        assert!(runs.join("A2/log").exists() && runs.join("A3/log").exists());
        assert!(runs.join("ext-c-r/log").exists());
    }

    #[test]
    fn e2e_porcelain_dirty_matching() {
        let dirty = porcelain_paths(" M e2e/cases/1331/case.mjs\n?? e2e/new.txt\nR  a -> e2e/b\n");
        assert!(files_dirty(&["e2e/cases/1331".into()], &dirty));
        assert!(files_dirty(&["e2e/b".into()], &dirty));
        assert!(!files_dirty(&["e2e/cases/1328".into()], &dirty));
    }

    #[test]
    fn e2e_case_hash_changes_with_content() {
        let tmp = TempDir::new("hash");
        let root = &tmp.0;
        std::fs::create_dir_all(root.join("cases/1")).unwrap();
        std::fs::write(root.join("cases/1/a.txt"), "one").unwrap();
        let files = vec!["cases/1".to_string()];
        let h1 = case_hash(root, &files).unwrap();
        assert_eq!(h1.len(), 64);
        std::fs::write(root.join("cases/1/a.txt"), "two").unwrap();
        assert_ne!(case_hash(root, &files).unwrap(), h1);
        assert!(case_hash(root, &[]).is_none());
    }

    #[test]
    fn e2e_write_guides_returns_manifest() {
        let tmp = TempDir::new("guides");
        assert_eq!(write_guides(&tmp.0).unwrap(), None);
        assert!(e2e_dir(&tmp.0).join("CONTRACT.md").is_file());
        assert!(e2e_dir(&tmp.0).join("BOOTSTRAP.md").is_file());
        std::fs::write(manifest_path(&tmp.0), "version = 1\n").unwrap();
        assert_eq!(
            write_guides(&tmp.0).unwrap().as_deref(),
            Some("version = 1\n")
        );
    }

    // ── real process ──

    const ADAPTER_SH: &str = r#"#!/bin/sh
case "$1" in
  list)
    echo '{"version":1,"cases":[{"id":"ok","title":"Ok","fresh":{"tok":"new"},"files":["case.txt"]},{"id":"slow","title":"Slow"}]}'
    ;;
  history)
    echo '{"version":1,"runs":[]}'
    ;;
  run)
    echo "running $*"
    echo "to stderr" >&2
    if [ "$2" = "slow" ]; then sleep 30; fi
    cat > "$KRYPTON_E2E_RESULT" <<EOF
{"version":1,"caseId":"$2","runId":"r-$2","verdict":"PASS","startedAt":"2026-10-23T08:17:09Z","finishedAt":"2026-10-23T08:20:37Z","checks":[{"label":"a","status":"pass"},{"label":"b","status":"info"}]}
EOF
    ;;
  *) exit 3 ;;
esac
"#;

    fn setup_project(name: &str) -> TempDir {
        let tmp = TempDir::new(name);
        let dir = e2e_dir(&tmp.0);
        std::fs::write(dir.join("adapter.sh"), ADAPTER_SH).unwrap();
        std::fs::write(
            dir.join("project.toml"),
            "version = 1\nname = \"t\"\nadapter = [\"sh\", \".krypton/e2e/adapter.sh\"]\nhistory = true\n",
        )
        .unwrap();
        std::fs::write(tmp.0.join("case.txt"), "case").unwrap();
        tmp
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_real_adapter_run_cancel_busy() {
        let tmp = setup_project("run");
        let root = tmp.0.clone();
        let state = Arc::new(E2eState::default());

        // PASS run with --fresh.
        let info = run_case(&state, &root, "ok", &BTreeMap::new(), true)
            .await
            .unwrap();
        assert_eq!(info.verdict, "PASS");
        assert_eq!(info.run_id, "r-ok");
        assert_eq!(info.origin, "krypton");
        assert_eq!((info.counts.pass, info.counts.info), (1, 1));
        assert_eq!(
            info.argv.as_deref().unwrap(),
            [
                "sh",
                ".krypton/e2e/adapter.sh",
                "run",
                "ok",
                "--param",
                "tok=new"
            ]
        );
        assert!(info.case_hash.is_some());
        assert_eq!(info.exit_code, Some(0));
        let launch = info.launch_id.clone().unwrap();
        let ledger = std::fs::read_to_string(ledger_path(&root)).unwrap();
        let lines: Vec<&str> = ledger.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"kind\":\"start\""));
        assert!(lines[1].contains("\"kind\":\"finish\""));
        let log = std::fs::read_to_string(runs_dir(&root).join(&launch).join("log")).unwrap();
        assert!(log.contains("running run ok --param tok=new"), "{log}");
        assert!(log.contains("to stderr"));

        let err = run_case(&state, &root, "nope", &BTreeMap::new(), false)
            .await
            .unwrap_err();
        assert_eq!(err, "unknown case \"nope\"; known: ok, slow");

        // Slow run, then busy + cancel.
        let bg_state = Arc::clone(&state);
        let bg_root = root.clone();
        let slow = tokio::spawn(async move {
            run_case(&bg_state, &bg_root, "slow", &BTreeMap::new(), false).await
        });
        let begun = Instant::now();
        loop {
            let has_pgid = state.lock().get(&root).is_some_and(|a| a.pgid.is_some());
            if has_pgid {
                break;
            }
            assert!(
                begun.elapsed() < Duration::from_secs(20),
                "slow run never started"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            run_case(&state, &root, "ok", &BTreeMap::new(), false).await,
            Err("busy".to_string())
        );
        let status = gather(&state, &root, false).await.status;
        assert_eq!(status.active_launch.as_ref().unwrap().case_id, "slow");
        assert_eq!(status.cases.len(), 2);

        let t = Instant::now();
        assert!(cancel_launch(&state, &root));
        assert!(
            t.elapsed() < Duration::from_millis(500),
            "cancel must not wait"
        );
        let done = tokio::time::timeout(Duration::from_secs(15), slow)
            .await
            .expect("cancelled run should end quickly")
            .unwrap()
            .unwrap();
        assert_eq!(done.verdict, "CANCELLED");
        assert!(state.lock().is_empty());
        assert!(!cancel_launch(&state, &root));

        // Status + find_run + rerun.
        let status = gather(&state, &root, false).await.status;
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert_eq!(status.runs.len(), 2);
        let found = find_run(&state, &root, "ok").await.unwrap();
        assert_eq!(found.run_id, "r-ok");
        assert_eq!(found.result_path, run_rel(&launch, "result.json"));
        // Rerun replays the newest start (the slow case); cancel it right away.
        let bg_state = Arc::clone(&state);
        let bg_root = root.clone();
        let rerun = tokio::spawn(async move { rerun_last(&bg_state, &bg_root).await });
        let begun = Instant::now();
        while !state.lock().get(&root).is_some_and(|a| a.pgid.is_some()) {
            assert!(
                begun.elapsed() < Duration::from_secs(20),
                "rerun never started"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(cancel_launch(&state, &root));
        let replay = tokio::time::timeout(Duration::from_secs(15), rerun)
            .await
            .expect("rerun should end quickly")
            .unwrap()
            .unwrap();
        assert_eq!(replay.case_id, "slow");
        assert_eq!(replay.argv, done.argv);
        assert_eq!(replay.verdict, "CANCELLED");

        let check = adapter_check(&root, Some(&run_rel(&launch, "result.json"))).await;
        assert!(check.ok, "{:?}", check.errors);
        assert_eq!(check.cases, 2);
    }

    // ── browser explorer (spec 0329) ──

    fn result_with_artifacts(case: &str, run: &str, artifacts: Value) -> String {
        json!({
            "version":1,"caseId":case,"runId":run,"verdict":"PASS",
            "startedAt":"2026-10-23T08:17:09Z","finishedAt":"2026-10-23T08:18:00Z",
            "checks":[{"label":"a","status":"pass"},{"group":"g","label":"b","status":"pass","detail":"ok"}],
            "artifacts": artifacts
        })
        .to_string()
    }

    #[test]
    fn e2e_run_detail_returns_the_full_result_and_resolves_artifacts() {
        let tmp = TempDir::new("detail");
        let root = &tmp.0;
        std::fs::create_dir_all(root.join("evidence")).unwrap();
        std::fs::write(root.join("evidence/a.json"), "{}").unwrap();
        for line in [
            start("L1", "c", "2026-10-23T08:00:00Z"),
            finish("L1", false),
            start("L2", "c", "2026-10-23T08:10:00Z"),
            finish("L2", false),
        ] {
            append_ledger(root, &line).unwrap();
        }
        let artifacts = json!([
            {"label":"a","path":"evidence/a.json"},
            {"label":"gone","path":"evidence/missing.json"},
            {"label":"escape","path":"../outside.txt"}
        ]);
        write_result(root, "L1", &result_with_artifacts("c", "r1", artifacts));
        std::fs::write(runs_dir(root).join("L1").join("log"), "hello log").unwrap();
        let state = E2eState::default();

        let detail = run_detail(&state, root, "c", "r1").unwrap();
        assert_eq!(
            (detail.info.verdict.as_str(), detail.info.origin.as_str()),
            ("PASS", "krypton")
        );
        assert_eq!(
            detail.result.as_ref().unwrap()["checks"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(detail.log);
        let problems: Vec<Option<&str>> = detail
            .artifacts
            .iter()
            .map(|a| a.problem.as_deref())
            .collect();
        assert_eq!(
            problems,
            [None, Some("missing"), Some("not a repo-relative path")]
        );
        assert_eq!(detail.artifacts[0].size, Some(2));
        // The launch id finds the same run.
        assert_eq!(
            run_detail(&state, root, "c", "L1").unwrap().info.run_id,
            "r1"
        );

        // A launch without a Result: no result, no artifacts, no log.
        let empty = run_detail(&state, root, "c", "L2").unwrap();
        assert_eq!(empty.info.verdict, "NO RESULT");
        assert!(empty.result.is_none() && empty.artifacts.is_empty() && !empty.log);

        assert_eq!(run_artifact(&state, root, "c", "r1", 0).unwrap().1, b"{}");
        for (case, run, index) in [("c", "r1", 1), ("c", "r1", 9), ("other", "r1", 0)] {
            let err = run_artifact(&state, root, case, run, index).unwrap_err();
            assert!(err.starts_with("not_found:"), "{case}/{run}/{index}: {err}");
        }
    }

    #[test]
    fn e2e_resolve_artifact_stays_inside_the_project() {
        let tmp = TempDir::new("artifact");
        let outside = TempDir::new("artifact-outside");
        let root = &tmp.0;
        std::fs::write(root.join("ok.txt"), "ok").unwrap();
        std::fs::write(outside.0.join("secret.txt"), "s").unwrap();
        std::fs::create_dir_all(root.join("dir")).unwrap();
        assert_eq!(resolve_artifact(root, "ok.txt").unwrap().1, 2);
        let absolute = outside.0.join("secret.txt");
        for (path, prefix) in [
            (absolute.to_str().unwrap(), "bad_path:"),
            ("../x.txt", "bad_path:"),
            ("dir", "not_found:"),
            ("nope.txt", "not_found:"),
        ] {
            let err = resolve_artifact(root, path).unwrap_err();
            assert!(err.starts_with(prefix), "{path}: {err}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&absolute, root.join("link.txt")).unwrap();
            assert_eq!(
                resolve_artifact(root, "link.txt").unwrap_err(),
                "bad_path: outside the project"
            );
        }
        let big = std::fs::File::create(root.join("big.bin")).unwrap();
        big.set_len(ARTIFACT_MAX_BYTES + 1).unwrap();
        assert!(resolve_artifact(root, "big.bin")
            .unwrap_err()
            .starts_with("too_large:"));
        std::fs::File::create(root.join("edge.bin"))
            .unwrap()
            .set_len(ARTIFACT_MAX_BYTES)
            .unwrap();
        assert_eq!(
            resolve_artifact(root, "edge.bin").unwrap().1,
            ARTIFACT_MAX_BYTES
        );
    }

    #[test]
    fn e2e_launch_log_serves_only_ledger_launches() {
        let tmp = TempDir::new("log");
        let root = &tmp.0;
        append_ledger(
            root,
            &start("20261023T080000Z", "c", "2026-10-23T08:00:00Z"),
        )
        .unwrap();
        for (dir, text) in [("20261023T080000Z", "out"), ("unlisted", "x")] {
            std::fs::create_dir_all(runs_dir(root).join(dir)).unwrap();
            std::fs::write(runs_dir(root).join(dir).join("log"), text).unwrap();
        }
        assert_eq!(launch_log(root, "20261023T080000Z").unwrap(), b"out");
        for id in ["unlisted", "../e2e", "", ".."] {
            let err = launch_log(root, id).unwrap_err();
            assert!(err.starts_with("not_found:"), "{id}: {err}");
        }
    }

    const HISTORY_ADAPTER_SH: &str = r#"#!/bin/sh
case "$1" in
  list) echo '{"version":1,"cases":[{"id":"h","title":"H"}]}' ;;
  history) echo '{"version":1,"runs":[{"version":1,"caseId":"h","runId":"x1","verdict":"FAIL","startedAt":"2026-10-23T08:17:09Z","finishedAt":"2026-10-23T08:18:00Z","checks":[{"label":"a","status":"fail","detail":"boom"}],"artifacts":[{"label":"r","path":"report.txt"}]}]}' ;;
  *) exit 3 ;;
esac
"#;

    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_status_fills_the_history_cache_for_run_detail() {
        let tmp = TempDir::new("history-cache");
        let root = tmp.0.clone();
        let dir = e2e_dir(&root);
        std::fs::write(dir.join("adapter.sh"), HISTORY_ADAPTER_SH).unwrap();
        std::fs::write(
            dir.join("project.toml"),
            "version = 1\nname = \"h\"\nadapter = [\"sh\", \".krypton/e2e/adapter.sh\"]\nhistory = true\n",
        )
        .unwrap();
        std::fs::write(root.join("report.txt"), "report").unwrap();
        let state = E2eState::default();

        // Before any status call the ext run is unknown.
        assert!(run_detail(&state, &root, "h", "x1")
            .unwrap_err()
            .starts_with("not_found:"));
        let status = status(&state, &root, false).await;
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert_eq!(status.runs.len(), 1);

        let detail = run_detail(&state, &root, "h", "x1").unwrap();
        assert_eq!(
            (detail.info.origin.as_str(), detail.info.verdict.as_str()),
            ("ext", "FAIL")
        );
        assert_eq!(
            detail.result.as_ref().unwrap()["checks"][0]["detail"],
            "boom"
        );
        assert!(!detail.log);
        assert_eq!(
            run_artifact(&state, &root, "h", "x1", 0).unwrap().1,
            b"report"
        );
        // Reading an ext run never writes `runs/ext-*` (unlike `find_run`).
        assert!(!runs_dir(&root).join(ext_dir_name("h", "x1")).exists());
    }
}
