//! Spec 400 — bug trail: a pre-fix diagnosis drawn on a 0355 system map.
//!
//! During Analyze the lane writes `trail.toml` into the analysis bundle
//! (`.krypton/analyses/<owner>/<repo>/<n>/`): ordered steps pinned to map nodes,
//! each with evidence pointers. Nothing in that file can claim a verdict.
//! Krypton recomputes every `cite` / `commit` / `observed` check on read; only
//! repro runs, which cannot be recomputed, are stored (`trail-runs/`), and a
//! repro runs only after the user trusts the repro set (`<config>/trail-trust.toml`).
//! `trail-state.json` records HEAD and the dirty set when Analyze starts and at
//! every `trail_check`, so code edited during analysis shows on the page.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use toml::{Table, Value};

use crate::child_process::{kill_group, login_command, read_capped, Signal};
use crate::e2e::{is_relative_clean, load_map, E2eMap};
use crate::git::{is_commit_id, run_git};

const ANALYSES_REL: &str = ".krypton/analyses";
const GUIDE_NAME: &str = "TRAIL.md";
pub(crate) const TRAIL_FILE: &str = "trail.toml";
pub(crate) const STATE_FILE: &str = "trail-state.json";
pub(crate) const RUNS_DIR: &str = "trail-runs";
const TRUST_FILE: &str = "trail-trust.toml";

const MAX_BYTES: u64 = 128 * 1024;
const MAX_STEPS: usize = 60;
const MAX_EVIDENCE: usize = 8;
const MAX_REPRO: usize = 10;
const MAX_TEXT: usize = 600;
const MAX_TITLE: usize = 200;
const MAX_QUOTE: usize = 200;
const MAX_SPAN: usize = 200;
const MAX_OPTIONS: usize = 6;
const MAX_OPTION: usize = 200;
const MAX_ARGV: usize = 64;
const MAX_ARG: usize = 4096;
const CITE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_S: u64 = 300;
const MIN_TIMEOUT_S: u64 = 5;
const MAX_TIMEOUT_S: u64 = 1800;
const OUTPUT_CAP: usize = 2 * 1024 * 1024;
const KILL_DELAY: Duration = Duration::from_secs(5);
const RUN_RETENTION: usize = 50;

const KINDS: [&str; 6] = [
    "symptom",
    "ruled-out",
    "suspect",
    "root-cause",
    "decision",
    "plan",
];
const TYPES: [&str; 6] = ["cite", "commit", "observed", "repro", "inferred", "ref"];

/// The format guide `trail_begin` writes to `.krypton/analyses/TRAIL.md`.
pub(crate) const TRAIL_MD: &str = include_str!("trail-guide.md");

// ─── Issue / bundle ─────────────────────────────────────────────────

/// `owner/repo#n`, validated so it can name a bundle folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IssueRef {
    pub owner: String,
    pub repo: String,
    pub number: String,
}

impl IssueRef {
    pub(crate) fn key(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repo, self.number)
    }

    fn bundle_rel(&self) -> String {
        format!(
            "{ANALYSES_REL}/{}/{}/{}",
            self.owner, self.repo, self.number
        )
    }

    fn bundle(&self, root: &Path) -> PathBuf {
        root.join(self.bundle_rel())
    }
}

fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Parse `owner/repo#n` (also accepts `owner/repo/n`).
pub(crate) fn parse_issue_key(key: &str) -> Result<IssueRef, String> {
    let key = key.trim();
    let (path, number) = key
        .rsplit_once('#')
        .or_else(|| key.rsplit_once('/'))
        .ok_or_else(|| format!("expected owner/repo#n, got \"{key}\""))?;
    let (owner, repo) = path
        .split_once('/')
        .ok_or_else(|| format!("expected owner/repo#n, got \"{key}\""))?;
    if !is_name(owner)
        || !is_name(repo)
        || number.is_empty()
        || number.len() > 12
        || !number.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(format!("expected owner/repo#n, got \"{key}\""));
    }
    Ok(IssueRef {
        owner: owner.to_string(),
        repo: repo.to_string(),
        number: number.to_string(),
    })
}

// ─── trail.toml ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
struct Trail {
    issue: String,
    title: Option<String>,
    map: String,
    commit: String,
    repro: Vec<Repro>,
    steps: Vec<Step>,
}

#[derive(Debug, Clone, PartialEq)]
struct Repro {
    id: String,
    argv: Vec<String>,
    expect: String,
    timeout_s: u64,
    what: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Step {
    at: String,
    kind: String,
    note: String,
    question: Option<String>,
    options: Vec<String>,
    answer: Option<String>,
    evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, PartialEq)]
struct Evidence {
    kind: String,
    fields: BTreeMap<String, String>,
}

#[derive(Debug, Default)]
struct Parsed {
    trail: Trail,
    errors: Vec<String>,
    warnings: Vec<String>,
}

impl Parsed {
    fn err(&mut self, path: &str, msg: impl std::fmt::Display) {
        self.errors.push(format!("{path}: {msg}"));
    }

    fn warn(&mut self, path: &str, msg: impl std::fmt::Display) {
        self.warnings.push(format!("{path}: {msg}"));
    }

    fn unknown_keys(&mut self, table: &Table, allowed: &[&str], path: &str) {
        for key in table.keys() {
            if !allowed.contains(&key.as_str()) {
                if path.is_empty() {
                    self.warnings.push(format!("unknown key \"{key}\""));
                } else {
                    self.warn(path, format!("unknown key \"{key}\""));
                }
            }
        }
    }

    /// A string value. `trim` drops surrounding whitespace (not for quotes).
    fn text(
        &mut self,
        table: &Table,
        key: &str,
        path: &str,
        required: bool,
        max: usize,
        trim: bool,
    ) -> Option<String> {
        let at = join(path, key);
        match table.get(key) {
            None => {
                if required {
                    self.err(&at, "required");
                }
                None
            }
            Some(Value::String(s)) => {
                let value = if trim { s.trim() } else { s.as_str() };
                if value.trim().is_empty() {
                    if required {
                        self.err(&at, "must not be empty");
                    }
                    return None;
                }
                if value.chars().count() > max {
                    self.err(&at, format!("longer than {max} characters"));
                    return None;
                }
                Some(value.to_string())
            }
            Some(_) => {
                self.err(&at, "must be a string");
                None
            }
        }
    }

    /// An array of tables under `key`, capped at `max` (the rest is an error).
    fn tables<'t>(
        &mut self,
        root: &'t Table,
        key: &str,
        max: usize,
        path: &str,
    ) -> Vec<(String, &'t Table)> {
        let at = join(path, key);
        let Some(value) = root.get(key) else {
            return Vec::new();
        };
        let Value::Array(items) = value else {
            self.err(&at, "must be an array of tables");
            return Vec::new();
        };
        if items.len() > max {
            self.err(&at, format!("more than {max} entries"));
        }
        let mut out = Vec::new();
        for (i, item) in items.iter().take(max).enumerate() {
            let item_path = format!("{at}[{i}]");
            match item {
                Value::Table(t) => out.push((item_path, t)),
                _ => self.err(&item_path, "must be a table"),
            }
        }
        out
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn is_repro_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 40
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `a` or `a-b`, 1-based, b ≥ a, at most `MAX_SPAN` lines.
fn parse_lines(s: &str) -> Result<(usize, usize), String> {
    let bad = || "expected \"a\" or \"a-b\" (1-based line numbers)".to_string();
    let (a, b) = match s.split_once('-') {
        Some((a, b)) => (a.trim(), b.trim()),
        None => (s.trim(), s.trim()),
    };
    let a: usize = a.parse().map_err(|_| bad())?;
    let b: usize = b.parse().map_err(|_| bad())?;
    if a == 0 || b < a {
        return Err(bad());
    }
    if b - a + 1 > MAX_SPAN {
        return Err(format!("spans more than {MAX_SPAN} lines"));
    }
    Ok((a, b))
}

fn one_line_toml_error(text: &str, e: &toml::de::Error) -> String {
    let message = e.message().replace('\n', " ");
    match e.span() {
        Some(span) => {
            let line = text[..span.start.min(text.len())].matches('\n').count() + 1;
            format!("toml: {} (line {line})", message.trim())
        }
        None => format!("toml: {}", message.trim()),
    }
}

/// Parse and validate `trail.toml`. Invalid steps and evidence are dropped
/// with an error naming their path; the rest stays usable for the page.
fn parse_trail(text: &str) -> Parsed {
    let mut p = Parsed::default();
    let root: Table = match text.parse::<Table>() {
        Ok(t) => t,
        Err(e) => {
            p.errors.push(one_line_toml_error(text, &e));
            return p;
        }
    };
    p.unknown_keys(
        &root,
        &[
            "version", "issue", "title", "map", "commit", "repro", "step",
        ],
        "",
    );
    match root.get("version") {
        Some(Value::Integer(1)) => {}
        Some(Value::Integer(v)) => p.err("version", format!("unsupported version {v}")),
        Some(_) => p.err("version", "must be the integer 1"),
        None => p.err("version", "required"),
    }
    p.trail.issue = p
        .text(&root, "issue", "", true, 200, true)
        .unwrap_or_default();
    p.trail.title = p.text(&root, "title", "", false, MAX_TITLE, true);
    if let Some(map) = p.text(&root, "map", "", true, 512, true) {
        if is_relative_clean(&map) {
            p.trail.map = map;
        } else {
            p.err("map", "must be a repo-relative path without \"..\"");
        }
    }
    if let Some(commit) = p.text(&root, "commit", "", true, 40, true) {
        if is_commit_id(&commit) {
            p.trail.commit = commit;
        } else {
            p.err("commit", "expected a 4–40 character hex commit id");
        }
    }

    let mut ids: HashSet<String> = HashSet::new();
    for (path, table) in p.tables(&root, "repro", MAX_REPRO, "") {
        p.unknown_keys(table, &["id", "argv", "expect", "timeout_s", "what"], &path);
        let id = p.text(table, "id", &path, true, 40, true);
        let id = match id {
            Some(id) if !is_repro_id(&id) => {
                p.err(&join(&path, "id"), "expected ^[a-z0-9][a-z0-9-]{0,39}$");
                None
            }
            Some(id) if ids.contains(&id) => {
                p.err(&join(&path, "id"), format!("duplicate \"{id}\""));
                None
            }
            other => other,
        };
        let argv = match table.get("argv") {
            None => {
                p.err(&join(&path, "argv"), "required");
                None
            }
            Some(Value::Array(items)) => {
                let strings: Option<Vec<String>> = items
                    .iter()
                    .map(|v| match v {
                        Value::String(s) if !s.is_empty() && s.len() <= MAX_ARG => Some(s.clone()),
                        _ => None,
                    })
                    .collect();
                match strings {
                    Some(argv) if !argv.is_empty() && argv.len() <= MAX_ARGV => Some(argv),
                    _ => {
                        p.err(
                            &join(&path, "argv"),
                            format!("must be 1–{MAX_ARGV} non-empty strings"),
                        );
                        None
                    }
                }
            }
            Some(_) => {
                p.err(&join(&path, "argv"), "must be an array of strings");
                None
            }
        };
        let expect = match p.text(table, "expect", &path, false, 8, true).as_deref() {
            None | Some("fail") => "fail".to_string(),
            Some("pass") => "pass".to_string(),
            Some(other) => {
                p.err(
                    &join(&path, "expect"),
                    format!("expected \"fail\" or \"pass\", got \"{other}\""),
                );
                "fail".to_string()
            }
        };
        let timeout_s = match table.get("timeout_s") {
            None => DEFAULT_TIMEOUT_S,
            Some(Value::Integer(n))
                if (MIN_TIMEOUT_S as i64..=MAX_TIMEOUT_S as i64).contains(n) =>
            {
                *n as u64
            }
            Some(_) => {
                p.err(
                    &join(&path, "timeout_s"),
                    format!("must be an integer {MIN_TIMEOUT_S}..{MAX_TIMEOUT_S}"),
                );
                DEFAULT_TIMEOUT_S
            }
        };
        let what = p.text(table, "what", &path, true, MAX_TEXT, true);
        if let (Some(id), Some(argv), Some(what)) = (id, argv, what) {
            ids.insert(id.clone());
            p.trail.repro.push(Repro {
                id,
                argv,
                expect,
                timeout_s,
                what,
            });
        }
    }

    let steps = p.tables(&root, "step", MAX_STEPS, "");
    if steps.is_empty() && !p.errors.iter().any(|e| e.starts_with("step")) {
        p.warnings.push("step: no steps yet".to_string());
    }
    for (path, table) in steps {
        p.unknown_keys(
            table,
            &[
                "at", "kind", "note", "question", "options", "answer", "evidence",
            ],
            &path,
        );
        let at = p.text(table, "at", &path, true, 48, true);
        let kind = match p.text(table, "kind", &path, true, 16, true) {
            Some(k) if KINDS.contains(&k.as_str()) => Some(k),
            Some(k) => {
                p.err(
                    &join(&path, "kind"),
                    format!("unknown kind \"{k}\" (expected {})", KINDS.join(" | ")),
                );
                None
            }
            None => None,
        };
        let is_decision = kind.as_deref() == Some("decision");
        let note = p.text(table, "note", &path, !is_decision, MAX_TEXT, true);
        let question = p.text(table, "question", &path, is_decision, MAX_TEXT, true);
        let answer = p.text(table, "answer", &path, false, MAX_TEXT, true);
        let mut options = Vec::new();
        match table.get("options") {
            None => {}
            Some(Value::Array(items))
                if items.len() <= MAX_OPTIONS
                    && items.iter().all(|v| {
                        matches!(v, Value::String(s) if !s.trim().is_empty() && s.chars().count() <= MAX_OPTION)
                    }) =>
            {
                options = items
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .collect();
            }
            Some(_) => p.err(
                &join(&path, "options"),
                format!("must be at most {MAX_OPTIONS} strings of ≤ {MAX_OPTION} characters"),
            ),
        }
        if !is_decision && kind.is_some() {
            for key in ["question", "options", "answer"] {
                if table.contains_key(key) {
                    p.warn(&join(&path, key), "only a decision step uses it");
                }
            }
        }
        let mut evidence = Vec::new();
        for (ev_path, ev) in p.tables(table, "evidence", MAX_EVIDENCE, &path) {
            if let Some(e) = parse_evidence(&mut p, ev, &ev_path, &ids) {
                evidence.push(e);
            }
        }
        if let (Some(at), Some(kind)) = (at, kind) {
            p.trail.steps.push(Step {
                at,
                kind,
                note: note.unwrap_or_default(),
                question: if is_decision { question } else { None },
                options: if is_decision { options } else { Vec::new() },
                answer: if is_decision { answer } else { None },
                evidence,
            });
        }
    }
    p
}

fn parse_evidence(
    p: &mut Parsed,
    table: &Table,
    path: &str,
    repro_ids: &HashSet<String>,
) -> Option<Evidence> {
    let kind = match p.text(table, "type", path, true, 16, true) {
        Some(k) if TYPES.contains(&k.as_str()) => k,
        Some(k) => {
            p.err(
                &join(path, "type"),
                format!("unknown type \"{k}\" (expected {})", TYPES.join(" | ")),
            );
            return None;
        }
        None => return None,
    };
    let mut fields = BTreeMap::new();
    let mut ok = true;
    let mut want = |p: &mut Parsed, key: &str, required: bool, max: usize, trim: bool| match p
        .text(table, key, path, required, max, trim)
    {
        Some(v) => {
            fields.insert(key.to_string(), v);
        }
        None if required => ok = false,
        None => {}
    };
    let allowed: &[&str] = match kind.as_str() {
        "cite" => {
            want(p, "file", true, 512, true);
            want(p, "lines", true, 32, true);
            want(p, "quote", true, MAX_QUOTE, false);
            &["type", "file", "lines", "quote"]
        }
        "commit" => {
            want(p, "sha", true, 40, true);
            &["type", "sha"]
        }
        "observed" => {
            want(p, "file", true, 512, true);
            want(p, "what", true, MAX_TEXT, true);
            &["type", "file", "what"]
        }
        "repro" => {
            want(p, "id", true, 40, true);
            &["type", "id"]
        }
        "inferred" => {
            want(p, "what", true, MAX_TEXT, true);
            want(p, "source", false, MAX_TEXT, true);
            &["type", "what", "source"]
        }
        _ => {
            want(p, "what", true, MAX_TEXT, true);
            want(p, "url", false, 2048, true);
            &["type", "what", "url"]
        }
    };
    p.unknown_keys(table, allowed, path);
    if !ok {
        return None;
    }
    let field = |k: &str| fields.get(k).map(String::as_str).unwrap_or("");
    let problem: Option<(&str, String)> = match kind.as_str() {
        "cite" if !is_relative_clean(field("file")) => Some((
            "file",
            "must be a repo-relative path without \"..\"".to_string(),
        )),
        "cite" => parse_lines(field("lines")).err().map(|e| ("lines", e)),
        "commit" if !is_commit_id(field("sha")) => {
            Some(("sha", "expected a 4–40 character hex commit id".to_string()))
        }
        "observed" if !is_relative_clean(field("file")) => Some((
            "file",
            "must be a bundle-relative path without \"..\"".to_string(),
        )),
        "repro" if !repro_ids.contains(field("id")) => {
            Some(("id", format!("no [[repro]] with id \"{}\"", field("id"))))
        }
        "ref"
            if fields.contains_key("url")
                && !(field("url").starts_with("https://")
                    || field("url").starts_with("http://")) =>
        {
            Some(("url", "must start with http:// or https://".to_string()))
        }
        _ => None,
    };
    if let Some((key, msg)) = problem {
        p.err(&join(path, key), msg);
        return None;
    }
    Some(Evidence { kind, fields })
}

// ─── State snapshots ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailSnapshot {
    pub head: Option<String>,
    pub dirty: Vec<String>,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailCheckSnapshot {
    #[serde(flatten)]
    pub snapshot: TrailSnapshot,
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailState {
    pub start: Option<TrailSnapshot>,
    pub check: Option<TrailCheckSnapshot>,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn head_of(root: &Path) -> Option<String> {
    run_git(root, &["rev-parse", "--verify", "HEAD"]).map(|s| s.trim().to_string())
}

/// Paths `git status` reports as changed or untracked, outside `.krypton/`.
fn dirty_paths(root: &Path) -> Vec<String> {
    let Some(out) = run_git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ) else {
        return Vec::new();
    };
    let mut paths = BTreeSet::new();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let (code, path) = record.split_at(3);
        if code.starts_with('R') || code.starts_with('C') {
            records.next(); // the original path of a rename / copy
        }
        if path != ".krypton" && !path.starts_with(".krypton/") {
            paths.insert(path.to_string());
        }
    }
    paths.into_iter().collect()
}

fn take_snapshot(root: &Path) -> TrailSnapshot {
    TrailSnapshot {
        head: head_of(root),
        dirty: dirty_paths(root),
        at: now_ms(),
    }
}

/// What changed between the Analyze start and now: `HEAD moved` plus the
/// paths dirty now that were clean at the start.
fn changed_since(start: &TrailSnapshot, now: &TrailSnapshot) -> Vec<String> {
    let mut changed = Vec::new();
    if start.head != now.head {
        changed.push("HEAD moved".to_string());
    }
    let before: HashSet<&String> = start.dirty.iter().collect();
    changed.extend(now.dirty.iter().filter(|p| !before.contains(p)).cloned());
    changed
}

fn read_state(bundle: &Path) -> TrailState {
    std::fs::read_to_string(bundle.join(STATE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

// ─── Trust ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustStore {
    #[serde(default)]
    entry: Vec<TrustEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TrustEntry {
    root: String,
    issue: String,
    sha256: String,
}

fn trust_store_path() -> Option<PathBuf> {
    crate::config::config_dir().map(|d| d.join(TRUST_FILE))
}

fn read_trust_store(path: &Path) -> TrustStore {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| toml::from_str(&text).ok())
        .unwrap_or_default()
}

fn root_key(root: &Path) -> String {
    root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// sha256 of the canonical JSON of the repro set (`what` is a description
/// and stays out, so rewording it keeps the trust).
fn repro_sha(repro: &[Repro]) -> String {
    let canon: Vec<Json> = repro
        .iter()
        .map(|r| json!({ "id": r.id, "argv": r.argv, "expect": r.expect, "timeoutS": r.timeout_s }))
        .collect();
    let bytes = serde_json::to_vec(&canon).unwrap_or_default();
    Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn trust_state(trust_path: Option<&Path>, root: &Path, issue: &str, sha: &str) -> &'static str {
    let Some(path) = trust_path else {
        return "untrusted";
    };
    let key = root_key(root);
    match read_trust_store(path)
        .entry
        .iter()
        .find(|e| e.root == key && e.issue == issue)
    {
        None => "untrusted",
        Some(e) if e.sha256 == sha => "trusted",
        Some(_) => "changed",
    }
}

fn write_trust(trust_path: &Path, root: &Path, issue: &str, sha: &str) -> Result<(), String> {
    let mut store = read_trust_store(trust_path);
    let key = root_key(root);
    store.entry.retain(|e| !(e.root == key && e.issue == issue));
    store.entry.push(TrustEntry {
        root: key,
        issue: issue.to_string(),
        sha256: sha.to_string(),
    });
    if let Some(dir) = trust_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = toml::to_string(&store).map_err(|e| e.to_string())?;
    std::fs::write(trust_path, text).map_err(|e| format!("{}: {e}", trust_path.display()))
}

// ─── Repro runs ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailRun {
    pub run_id: String,
    pub id: String,
    pub argv: Vec<String>,
    pub commit: Option<String>,
    pub tree_clean: bool,
    /// pass | fail | timeout | error
    pub outcome: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub output_tail: String,
}

/// `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$`, as Rails run ids.
fn valid_run_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 21
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..15].iter().all(u8::is_ascii_digit)
        && b[15] == b'Z'
        && b[16] == b'-'
        && b[17..]
            .iter()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

fn mint_run_id(dir: &Path) -> String {
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let seed = Utc::now().timestamp_subsec_nanos() ^ std::process::id();
    for n in 0..0x1_0000u32 {
        let id = format!("{stamp}-{:04x}", (seed.wrapping_add(n)) & 0xffff);
        if !dir.join(format!("{id}.json")).exists() {
            return id;
        }
    }
    format!("{stamp}-ffff")
}

/// Every stored run of the bundle, oldest first.
fn read_runs(bundle: &Path) -> Vec<TrailRun> {
    let Ok(entries) = std::fs::read_dir(bundle.join(RUNS_DIR)) else {
        return Vec::new();
    };
    let mut runs: Vec<TrailRun> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.strip_suffix(".json").is_some_and(valid_run_id))
        .filter_map(|name| {
            std::fs::read_to_string(bundle.join(RUNS_DIR).join(&name))
                .ok()
                .and_then(|text| serde_json::from_str::<TrailRun>(&text).ok())
        })
        .collect();
    runs.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    runs
}

fn latest_runs(runs: Vec<TrailRun>) -> HashMap<String, TrailRun> {
    let mut latest = HashMap::new();
    for run in runs {
        latest.insert(run.id.clone(), run);
    }
    latest
}

fn prune_runs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.strip_suffix(".json").is_some_and(valid_run_id))
        .collect();
    if names.len() <= RUN_RETENTION {
        return;
    }
    names.sort();
    for name in &names[..names.len() - RUN_RETENTION] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// Run `argv` in `root` through the Rails launcher (login env, own process
/// group). Returns (outcome, exit code, duration, output tail).
async fn run_argv(
    root: &Path,
    argv: &[String],
    timeout: Duration,
) -> (String, Option<i32>, u64, String) {
    let started = Instant::now();
    let ms = |s: Instant| u64::try_from(s.elapsed().as_millis()).unwrap_or(u64::MAX);
    let mut cmd = match login_command(root, argv) {
        Ok(cmd) => cmd,
        Err(e) => return ("error".to_string(), None, ms(started), e),
    };
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return (
                "error".to_string(),
                None,
                ms(started),
                format!("failed to spawn {}: {e}", argv[0]),
            )
        }
    };
    let pgid = child.id().and_then(|p| i32::try_from(p).ok());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let work = async {
        let (out, err) = tokio::join!(
            read_capped(stdout, OUTPUT_CAP),
            read_capped(stderr, OUTPUT_CAP)
        );
        let status = child.wait().await;
        (out, err, status)
    };
    match tokio::time::timeout(timeout, work).await {
        Ok((out, err, status)) => {
            let mut bytes = out;
            if !err.is_empty() {
                if !bytes.is_empty() && !bytes.ends_with(b"\n") {
                    bytes.push(b'\n');
                }
                bytes.extend_from_slice(&err);
            }
            let tail = crate::rails::output_tail(&bytes);
            match status {
                Ok(status) => {
                    let outcome = if status.success() { "pass" } else { "fail" };
                    (outcome.to_string(), status.code(), ms(started), tail)
                }
                Err(e) => ("error".to_string(), None, ms(started), format!("wait: {e}")),
            }
        }
        Err(_) => {
            kill_group(pgid, Signal::Term);
            let _ = tokio::time::timeout(KILL_DELAY, child.wait()).await;
            kill_group(pgid, Signal::Kill);
            let _ = child.start_kill();
            let _ = child.wait().await;
            (
                "timeout".to_string(),
                None,
                ms(started),
                format!("timed out after {}s", timeout.as_secs()),
            )
        }
    }
}

fn running() -> &'static Mutex<HashSet<PathBuf>> {
    static RUNNING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Holds a bundle's single-flight slot until dropped.
struct Flight(PathBuf);

impl Flight {
    fn acquire(bundle: &Path) -> Result<Self, String> {
        let mut set = running().lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(bundle.to_path_buf()) {
            return Err("a repro of this trail is already running".to_string());
        }
        Ok(Flight(bundle.to_path_buf()))
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        running()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

// ─── Evidence checks ────────────────────────────────────────────────

enum Blob {
    Lines(Vec<String>),
    Missing,
    Unavailable(String),
}

/// Git access for one payload: the resolved commit and a blob cache.
struct GitView<'a> {
    root: &'a Path,
    is_repo: bool,
    label: String,
    full: Option<String>,
    blobs: HashMap<String, Blob>,
}

impl<'a> GitView<'a> {
    fn new(root: &'a Path, commit: &str) -> Self {
        let is_repo = run_git(root, &["rev-parse", "--git-dir"]).is_some();
        let full = if is_repo && !commit.is_empty() {
            run_git(
                root,
                &["rev-parse", "--verify", &format!("{commit}^{{commit}}")],
            )
            .map(|s| s.trim().to_string())
        } else {
            None
        };
        GitView {
            root,
            is_repo,
            label: commit.chars().take(8).collect(),
            full,
            blobs: HashMap::new(),
        }
    }

    fn unavailable(&self) -> Option<String> {
        if !self.is_repo {
            Some("not a git repository".to_string())
        } else if self.full.is_none() {
            Some(format!("commit {} not found", self.label))
        } else {
            None
        }
    }

    fn blob(&mut self, file: &str) -> &Blob {
        if !self.blobs.contains_key(file) {
            let blob = self.load_blob(file);
            self.blobs.insert(file.to_string(), blob);
        }
        &self.blobs[file]
    }

    fn load_blob(&self, file: &str) -> Blob {
        let Some(full) = self.full.as_deref() else {
            return Blob::Unavailable("commit not found".to_string());
        };
        let object = format!("{full}:{file}");
        let Some(size) = run_git(self.root, &["cat-file", "-s", &object]) else {
            return Blob::Missing;
        };
        if size.trim().parse::<u64>().unwrap_or(u64::MAX) > CITE_MAX_BYTES {
            return Blob::Unavailable("file larger than 2 MiB".to_string());
        }
        match run_git(self.root, &["cat-file", "blob", &object]) {
            Some(text) => Blob::Lines(
                text.lines()
                    .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
                    .collect(),
            ),
            None => Blob::Unavailable("not UTF-8 text".to_string()),
        }
    }

    fn cite(&mut self, file: &str, lines: &str, quote: &str) -> (&'static str, Option<String>) {
        if let Some(why) = self.unavailable() {
            return ("unavailable", Some(why));
        }
        let Ok((a, b)) = parse_lines(lines) else {
            return ("mismatch", Some("invalid line range".to_string()));
        };
        let label = self.label.clone();
        match self.blob(file) {
            Blob::Missing => ("missing", Some(format!("{file} is not in commit {label}"))),
            Blob::Unavailable(why) => ("unavailable", Some(why.clone())),
            Blob::Lines(all) => {
                if b > all.len() {
                    return (
                        "mismatch",
                        Some(format!("{file} has {} lines at {label}", all.len())),
                    );
                }
                if all[a - 1..b].join("\n").contains(quote) {
                    return ("ok", None);
                }
                let whole = all.join("\n");
                match whole.find(quote) {
                    Some(at) => {
                        let line = whole[..at].matches('\n').count() + 1;
                        (
                            "mismatch",
                            Some(format!("quote is at line {line}, not {lines}")),
                        )
                    }
                    None => ("mismatch", Some(format!("quote not found in {file}"))),
                }
            }
        }
    }

    fn commit(&self, sha: &str) -> (&'static str, Option<String>) {
        if !self.is_repo {
            return ("unavailable", Some("not a git repository".to_string()));
        }
        match run_git(self.root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]) {
            Some(_) => ("ok", None),
            None => ("unknown", Some(format!("no commit {sha}"))),
        }
    }
}

fn check_observed(bundle: &Path, rel: &str) -> (&'static str, Option<String>) {
    let Ok(base) = bundle.canonicalize() else {
        return ("missing", Some("bundle not found".to_string()));
    };
    let Ok(file) = base.join(rel).canonicalize() else {
        return ("missing", Some(format!("{rel} not found in the bundle")));
    };
    if file.strip_prefix(&base).is_err() {
        return ("missing", Some(format!("{rel} is outside the bundle")));
    }
    if !file.is_file() {
        return ("missing", Some(format!("{rel} is not a regular file")));
    }
    ("ok", None)
}

/// Repro evidence status from the latest run and the trust state.
fn repro_status(
    run: Option<&TrailRun>,
    repro: &Repro,
    full_commit: Option<&str>,
    trust: &str,
) -> (&'static str, Option<String>) {
    let Some(run) = run else {
        return if trust == "trusted" {
            ("not-run", None)
        } else {
            (
                "untrusted",
                Some("#trail trust, then #trail run".to_string()),
            )
        };
    };
    if run.commit.as_deref() != full_commit || full_commit.is_none() {
        let on: String = run
            .commit
            .as_deref()
            .unwrap_or("?")
            .chars()
            .take(8)
            .collect();
        return ("stale", Some(format!("last run {} on {on}", run.run_id)));
    }
    match run.outcome.as_str() {
        "timeout" | "error" => (
            "not-run",
            Some(format!("last run {} ended {}", run.run_id, run.outcome)),
        ),
        outcome if !run.tree_clean => (
            "stale",
            Some(format!("last run {} {outcome} on a dirty tree", run.run_id)),
        ),
        outcome if outcome == repro.expect => (
            "reproduced",
            Some(format!("run {} {outcome} as expected", run.run_id)),
        ),
        outcome => (
            "unexpected",
            Some(format!(
                "run {} {outcome}, expected {}",
                run.run_id, repro.expect
            )),
        ),
    }
}

// ─── Payload ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailMapEntry {
    pub path: String,
    pub map: Option<E2eMap>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailEvidenceView {
    #[serde(rename = "type")]
    pub kind: String,
    pub fields: BTreeMap<String, String>,
    pub status: String,
    pub detail: Option<String>,
    pub output_tail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailStepView {
    pub at: String,
    pub kind: String,
    pub note: String,
    pub question: Option<String>,
    pub options: Vec<String>,
    pub answer: Option<String>,
    pub evidence: Vec<TrailEvidenceView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailReproView {
    pub id: String,
    pub argv: Vec<String>,
    pub expect: String,
    pub what: String,
    pub timeout_s: u64,
    pub trust: String,
    pub last_run: Option<TrailRun>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailPayload {
    pub issue: String,
    pub title: Option<String>,
    pub commit: String,
    pub bundle: String,
    pub map: TrailMapEntry,
    pub steps: Vec<TrailStepView>,
    pub repro: Vec<TrailReproView>,
    pub state: TrailState,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

fn read_trail_text(bundle: &Path) -> Option<Result<String, String>> {
    let path = bundle.join(TRAIL_FILE);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() {
        return Some(Err(format!("{TRAIL_FILE} is not a regular file")));
    }
    if meta.len() > MAX_BYTES {
        return Some(Err(format!("{TRAIL_FILE} is larger than 128 KiB")));
    }
    Some(std::fs::read_to_string(&path).map_err(|e| format!("{TRAIL_FILE}: {e}")))
}

/// `/trail.json`: the payload against the user's trust store.
pub(crate) fn page_payload(root: &Path, issue: &IssueRef) -> Option<TrailPayload> {
    trail_payload(root, issue, trust_store_path().as_deref())
}

/// `/trail.json` without `issue`: every trail of a project, newest issue
/// first, each a full payload so the page derives status with the issue
/// view's own rules.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailIndex {
    pub project_id: String,
    pub project_name: String,
    pub trails: Vec<TrailPayload>,
}

pub(crate) fn index_payload(
    root: &Path,
    project_id: String,
    project_name: String,
    issues: &[IssueRef],
) -> TrailIndex {
    let trust = trust_store_path();
    let mut trails: Vec<TrailPayload> = issues
        .iter()
        .filter_map(|issue| trail_payload(root, issue, trust.as_deref()))
        .collect();
    trails.sort_by(|a, b| {
        let num = |p: &TrailPayload| {
            p.issue
                .rsplit_once('#')
                .and_then(|(_, n)| n.parse::<u64>().ok())
                .unwrap_or(0)
        };
        num(b).cmp(&num(a)).then(a.issue.cmp(&b.issue))
    });
    TrailIndex {
        project_id,
        project_name,
        trails,
    }
}

/// The page payload, every check recomputed. `None` when there is no trail.
pub(crate) fn trail_payload(
    root: &Path,
    issue: &IssueRef,
    trust_path: Option<&Path>,
) -> Option<TrailPayload> {
    let bundle = issue.bundle(root);
    let text = read_trail_text(&bundle)?;
    let mut parsed = match text {
        Ok(text) => parse_trail(&text),
        Err(e) => Parsed {
            errors: vec![e],
            ..Parsed::default()
        },
    };
    let trail = std::mem::take(&mut parsed.trail);
    let mut errors = parsed.errors;
    let warnings = parsed.warnings;
    if !trail.issue.is_empty() && parse_issue_key(&trail.issue).ok().as_ref() != Some(issue) {
        errors.push(format!(
            "issue: \"{}\" does not match the bundle ({})",
            trail.issue,
            issue.key()
        ));
    }

    let map = if trail.map.is_empty() {
        TrailMapEntry {
            path: String::new(),
            map: None,
            errors: vec!["no map".to_string()],
            warnings: Vec::new(),
        }
    } else {
        match load_map(root, &trail.map) {
            Ok((map, warnings)) => TrailMapEntry {
                path: trail.map.clone(),
                map: Some(map),
                errors: Vec::new(),
                warnings,
            },
            Err(errors) => TrailMapEntry {
                path: trail.map.clone(),
                map: None,
                errors,
                warnings: Vec::new(),
            },
        }
    };

    let mut git = GitView::new(root, &trail.commit);
    if !trail.commit.is_empty() {
        if let Some(why) = git.unavailable() {
            errors.push(format!("commit: {why}"));
        }
    }
    let sha = repro_sha(&trail.repro);
    let trust = if trail.repro.is_empty() {
        "trusted"
    } else {
        trust_state(trust_path, root, &issue.key(), &sha)
    };
    let latest = latest_runs(read_runs(&bundle));
    let repro_by_id: HashMap<&str, &Repro> =
        trail.repro.iter().map(|r| (r.id.as_str(), r)).collect();

    let steps = trail
        .steps
        .iter()
        .map(|step| TrailStepView {
            at: step.at.clone(),
            kind: step.kind.clone(),
            note: step.note.clone(),
            question: step.question.clone(),
            options: step.options.clone(),
            answer: step.answer.clone(),
            evidence: step
                .evidence
                .iter()
                .map(|ev| {
                    let f = |k: &str| ev.fields.get(k).map(String::as_str).unwrap_or("");
                    let mut output_tail = None;
                    let (status, detail) = match ev.kind.as_str() {
                        "cite" => git.cite(f("file"), f("lines"), f("quote")),
                        "commit" => git.commit(f("sha")),
                        "observed" => check_observed(&bundle, f("file")),
                        "repro" => match repro_by_id.get(f("id")) {
                            Some(repro) => {
                                let run = latest.get(f("id"));
                                output_tail = run.map(|r| r.output_tail.clone());
                                repro_status(run, repro, git.full.as_deref(), trust)
                            }
                            None => ("unavailable", Some("unknown repro".to_string())),
                        },
                        _ => ("unchecked", None),
                    };
                    TrailEvidenceView {
                        kind: ev.kind.clone(),
                        fields: ev.fields.clone(),
                        status: status.to_string(),
                        detail,
                        output_tail,
                    }
                })
                .collect(),
        })
        .collect();

    let repro = trail
        .repro
        .iter()
        .map(|r| TrailReproView {
            id: r.id.clone(),
            argv: r.argv.clone(),
            expect: r.expect.clone(),
            what: r.what.clone(),
            timeout_s: r.timeout_s,
            trust: trust.to_string(),
            last_run: latest.get(&r.id).cloned(),
        })
        .collect();

    Some(TrailPayload {
        issue: issue.key(),
        title: trail.title,
        commit: trail.commit,
        bundle: issue.bundle_rel(),
        map,
        steps,
        repro,
        state: read_state(&bundle),
        errors,
        warnings,
    })
}

// ─── Lane tool: trail_check ─────────────────────────────────────────

/// MCP `trail_check`: validate the trail, report every evidence check, and
/// record the `check` snapshot (what changed since Analyze started).
pub(crate) fn trail_check(root: &Path, issue_key: &str) -> Result<Json, String> {
    let issue = parse_issue_key(issue_key)?;
    let bundle = issue.bundle(root);
    let payload = trail_payload(root, &issue, trust_store_path().as_deref())
        .ok_or_else(|| format!("no {TRAIL_FILE} in {}", issue.bundle_rel()))?;
    let mut state = read_state(&bundle);
    let now = take_snapshot(root);
    let mut warnings = payload.warnings.clone();
    let changed = match &state.start {
        Some(start) => changed_since(start, &now),
        None => {
            warnings.push(
                "no start snapshot: Analyze was not started from the harness, so edits during analysis cannot be detected"
                    .to_string(),
            );
            Vec::new()
        }
    };
    state.check = Some(TrailCheckSnapshot {
        snapshot: now,
        changed: changed.clone(),
    });
    write_json(&bundle.join(STATE_FILE), &state)?;

    let nodes: HashSet<&str> = payload
        .map
        .map
        .as_ref()
        .map(|m| m.nodes.iter().map(|n| n.id.as_str()).collect())
        .unwrap_or_default();
    let failing = ["mismatch", "missing", "unknown", "unavailable"];
    let mut ok = payload.errors.is_empty() && payload.map.errors.is_empty() && changed.is_empty();
    let steps: Vec<Json> = payload
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let evidence: Vec<Json> = s
                .evidence
                .iter()
                .map(|e| {
                    if failing.contains(&e.status.as_str()) {
                        ok = false;
                    }
                    json!({ "type": e.kind, "status": e.status, "detail": e.detail })
                })
                .collect();
            json!({
                "index": i + 1,
                "at": s.at,
                "kind": s.kind,
                "onMap": nodes.contains(s.at.as_str()),
                "evidence": evidence,
            })
        })
        .collect();
    Ok(json!({
        "ok": ok,
        "errors": payload.errors,
        "warnings": warnings,
        "map": { "path": payload.map.path, "errors": payload.map.errors, "warnings": payload.map.warnings },
        "steps": steps,
        "changedDuringAnalysis": changed,
    }))
}

// ─── Commands ───────────────────────────────────────────────────────

fn project_root(project_dir: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_dir);
    if project_dir.trim().is_empty() || !root.is_dir() {
        return Err(format!("not a project folder: {project_dir}"));
    }
    Ok(root)
}

/// Analyze is starting: write the format guide and the start snapshot.
/// Re-analysis replaces `start` and clears `check`; repro runs are kept.
#[tauri::command]
pub fn trail_begin(project_dir: String, issue_key: String) -> Result<(), String> {
    let root = project_root(&project_dir)?;
    let issue = parse_issue_key(&issue_key)?;
    let bundle = issue.bundle(&root);
    std::fs::create_dir_all(&bundle).map_err(|e| format!("{}: {e}", bundle.display()))?;
    let guide = root.join(ANALYSES_REL).join(GUIDE_NAME);
    std::fs::write(&guide, TRAIL_MD).map_err(|e| format!("{}: {e}", guide.display()))?;
    let state = TrailState {
        start: Some(take_snapshot(&root)),
        check: None,
    };
    write_json(&bundle.join(STATE_FILE), &state)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrailTrust {
    pub trusted: usize,
    pub argv: Vec<Vec<String>>,
}

fn load_valid_trail(root: &Path, issue: &IssueRef) -> Result<Trail, String> {
    let bundle = issue.bundle(root);
    let text = read_trail_text(&bundle)
        .ok_or_else(|| format!("no {TRAIL_FILE} in {}", issue.bundle_rel()))??;
    let parsed = parse_trail(&text);
    if let Some(e) = parsed.errors.iter().find(|e| e.starts_with("repro")) {
        return Err(format!("{TRAIL_FILE}: {e}"));
    }
    if parsed.trail.commit.is_empty() {
        return Err(format!("{TRAIL_FILE}: commit is missing or invalid"));
    }
    Ok(parsed.trail)
}

fn trust_with(trust_path: &Path, root: &Path, issue: &IssueRef) -> Result<TrailTrust, String> {
    let trail = load_valid_trail(root, issue)?;
    if trail.repro.is_empty() {
        return Err(format!("no [[repro]] in {TRAIL_FILE}"));
    }
    write_trust(trust_path, root, &issue.key(), &repro_sha(&trail.repro))?;
    Ok(TrailTrust {
        trusted: trail.repro.len(),
        argv: trail.repro.iter().map(|r| r.argv.clone()).collect(),
    })
}

/// `#trail trust`: trust the trail's current repro set.
#[tauri::command]
pub fn trail_trust(project_dir: String, issue_key: String) -> Result<TrailTrust, String> {
    let root = project_root(&project_dir)?;
    let issue = parse_issue_key(&issue_key)?;
    let path = trust_store_path().ok_or("no config directory")?;
    trust_with(&path, &root, &issue)
}

async fn run_with(
    trust_path: Option<&Path>,
    root: &Path,
    issue: &IssueRef,
    id: Option<&str>,
) -> Result<Vec<TrailRun>, String> {
    let trail = load_valid_trail(root, issue)?;
    let chosen: Vec<&Repro> = match id {
        Some(id) => vec![trail
            .repro
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| format!("no [[repro]] with id \"{id}\""))?],
        None => trail.repro.iter().collect(),
    };
    if chosen.is_empty() {
        return Err(format!("no [[repro]] in {TRAIL_FILE}"));
    }
    match trust_state(trust_path, root, &issue.key(), &repro_sha(&trail.repro)) {
        "trusted" => {}
        "changed" => return Err("repro set changed since trusted — #trail trust again".into()),
        _ => return Err("untrusted — #trail trust first".into()),
    }
    let full = run_git(
        root,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", trail.commit),
        ],
    )
    .map(|s| s.trim().to_string())
    .ok_or_else(|| format!("commit {} not found", trail.commit))?;
    let head = head_of(root).unwrap_or_default();
    if head != full {
        return Err(format!(
            "HEAD moved: repro runs on the analysed commit only (HEAD {}, trail {})",
            head.chars().take(8).collect::<String>(),
            trail.commit
        ));
    }
    let dirty = dirty_paths(root);
    if !dirty.is_empty() {
        let shown: Vec<&str> = dirty.iter().take(5).map(String::as_str).collect();
        return Err(format!(
            "working tree has changes outside .krypton/: {}{}",
            shown.join(", "),
            if dirty.len() > 5 { ", …" } else { "" }
        ));
    }
    let bundle = issue.bundle(root);
    let _flight = Flight::acquire(&bundle)?;
    let dir = bundle.join(RUNS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut runs = Vec::new();
    for repro in chosen {
        let (outcome, exit_code, duration_ms, output_tail) =
            run_argv(root, &repro.argv, Duration::from_secs(repro.timeout_s)).await;
        let run = TrailRun {
            run_id: mint_run_id(&dir),
            id: repro.id.clone(),
            argv: repro.argv.clone(),
            commit: Some(full.clone()),
            tree_clean: dirty_paths(root).is_empty(),
            outcome,
            exit_code,
            duration_ms,
            output_tail,
        };
        write_json(&dir.join(format!("{}.json", run.run_id)), &run)?;
        runs.push(run);
    }
    prune_runs(&dir);
    Ok(runs)
}

/// `#trail run [<id>]`: run trusted repros on the analysed commit.
#[tauri::command]
pub async fn trail_run_repro(
    project_dir: String,
    issue_key: String,
    id: Option<String>,
) -> Result<Vec<TrailRun>, String> {
    let root = project_root(&project_dir)?;
    let issue = parse_issue_key(&issue_key)?;
    run_with(trust_store_path().as_deref(), &root, &issue, id.as_deref()).await
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let unique = format!(
                "krypton-trail-{name}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path.canonicalize().unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    const MAP: &str = r#"version = 1
[[node]]
id = "user"
label = "user"
shape = "actor"
[[node]]
id = "api"
label = "api"
[[node]]
id = "store"
label = "store"
shape = "store"
[[edge]]
from = "user"
to = "api"
[[edge]]
from = "api"
to = "store"
"#;

    /// A repo with `src/app.txt` committed, the map, and the bundle folder.
    fn repo(name: &str) -> (TempDir, String) {
        let dir = TempDir::new(name);
        let root = &dir.0;
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "t@example.com"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/app.txt"), "one\ntwo = policy\nthree\n").unwrap();
        std::fs::create_dir_all(root.join("e2e/maps")).unwrap();
        std::fs::write(root.join("e2e/maps/sys.toml"), MAP).unwrap();
        std::fs::write(root.join(".gitignore"), ".krypton/\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "init"]);
        let head = git(root, &["rev-parse", "HEAD"]);
        std::fs::create_dir_all(root.join(".krypton/analyses/o/r/7")).unwrap();
        (dir, head)
    }

    fn issue() -> IssueRef {
        parse_issue_key("o/r#7").unwrap()
    }

    fn write_trail(root: &Path, body: &str) {
        std::fs::write(root.join(".krypton/analyses/o/r/7").join(TRAIL_FILE), body).unwrap();
    }

    fn header(commit: &str) -> String {
        format!(
            "version = 1\nissue = \"o/r#7\"\nmap = \"e2e/maps/sys.toml\"\ncommit = \"{commit}\"\n"
        )
    }

    #[test]
    fn issue_keys_parse_and_reject() {
        let i = parse_issue_key("bcircle/tli-api-service#1364").unwrap();
        assert_eq!(
            i.bundle_rel(),
            ".krypton/analyses/bcircle/tli-api-service/1364"
        );
        assert_eq!(parse_issue_key("o/r/7").unwrap(), issue());
        for bad in ["o#1", "o/r#x", "../r#1", "o/r#", "o/..#1"] {
            assert!(parse_issue_key(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parse_validates_kinds_evidence_and_limits() {
        let text = format!(
            "{}\ncolour = 1\n[[repro]]\nid = \"r1\"\nargv = [\"false\"]\nwhat = \"x\"\n\
             [[step]]\nat = \"api\"\nkind = \"root-cause\"\nnote = \"n\"\n\
             [[step.evidence]]\ntype = \"cite\"\nfile = \"src/app.txt\"\nlines = \"2\"\nquote = \"policy\"\n\
             [[step.evidence]]\ntype = \"repro\"\nid = \"nope\"\n\
             [[step]]\nat = \"api\"\nkind = \"guess\"\nnote = \"n\"\n\
             [[step]]\nat = \"store\"\nkind = \"decision\"\nquestion = \"q?\"\noptions = [\"a\", \"b\"]\n\
             [[step]]\nat = \"api\"\nkind = \"plan\"\nnote = \"n\"\nanswer = \"x\"\n\
             [[step.evidence]]\ntype = \"cite\"\nfile = \"src/app.txt\"\nlines = \"3-1\"\nquote = \"q\"\n",
            header("abcd")
        );
        let p = parse_trail(&text);
        assert!(
            p.warnings.contains(&"unknown key \"colour\"".to_string()),
            "{:?}",
            p.warnings
        );
        assert!(p
            .errors
            .contains(&"step[0].evidence[1].id: no [[repro]] with id \"nope\"".to_string()));
        assert!(p
            .errors
            .iter()
            .any(|e| e.starts_with("step[1].kind: unknown kind \"guess\"")));
        assert!(p
            .errors
            .iter()
            .any(|e| e.starts_with("step[3].evidence[0].lines:")));
        assert!(p
            .warnings
            .contains(&"step[3].answer: only a decision step uses it".to_string()));
        assert_eq!(p.trail.steps.len(), 3);
        assert_eq!(p.trail.steps[0].evidence.len(), 1);
        assert_eq!(p.trail.steps[1].question.as_deref(), Some("q?"));
        assert_eq!(p.trail.steps[1].options, vec!["a", "b"]);
        assert_eq!(p.trail.repro[0].expect, "fail");
        assert_eq!(p.trail.repro[0].timeout_s, DEFAULT_TIMEOUT_S);

        let bad = parse_trail("version = 2\nissue = \"o/r#7\"\nmap = \"../m\"\ncommit = \"xyz\"\n");
        assert!(bad
            .errors
            .contains(&"version: unsupported version 2".to_string()));
        assert!(bad.errors.iter().any(|e| e.starts_with("map:")));
        assert!(bad.errors.iter().any(|e| e.starts_with("commit:")));
        assert!(parse_trail("version = = 1").errors[0].starts_with("toml:"));
    }

    #[test]
    fn cite_commit_and_observed_checks() {
        let (dir, head) = repo("checks");
        let root = &dir.0;
        std::fs::write(root.join(".krypton/analyses/o/r/7/db.csv"), "x").unwrap();
        let body = format!(
            "{}[[step]]\nat = \"api\"\nkind = \"root-cause\"\nnote = \"n\"\n\
             [[step.evidence]]\ntype = \"cite\"\nfile = \"src/app.txt\"\nlines = \"2\"\nquote = \"policy\"\n\
             [[step.evidence]]\ntype = \"cite\"\nfile = \"src/app.txt\"\nlines = \"1\"\nquote = \"policy\"\n\
             [[step.evidence]]\ntype = \"cite\"\nfile = \"src/none.txt\"\nlines = \"1\"\nquote = \"x\"\n\
             [[step.evidence]]\ntype = \"cite\"\nfile = \"src/app.txt\"\nlines = \"9\"\nquote = \"x\"\n\
             [[step.evidence]]\ntype = \"commit\"\nsha = \"{}\"\n\
             [[step.evidence]]\ntype = \"commit\"\nsha = \"deadbeef\"\n\
             [[step.evidence]]\ntype = \"observed\"\nfile = \"db.csv\"\nwhat = \"rows\"\n\
             [[step.evidence]]\ntype = \"observed\"\nfile = \"gone.csv\"\nwhat = \"rows\"\n",
            header(&head[..8]),
            &head[..10]
        );
        write_trail(root, &body);
        // An edit after the analysed commit must not change a cite.
        std::fs::write(root.join("src/app.txt"), "changed\n").unwrap();
        let payload = trail_payload(root, &issue(), None).unwrap();
        assert!(payload.errors.is_empty(), "{:?}", payload.errors);
        assert!(payload.map.map.is_some());
        let got: Vec<(&str, Option<&str>)> = payload.steps[0]
            .evidence
            .iter()
            .map(|e| (e.status.as_str(), e.detail.as_deref()))
            .collect();
        assert_eq!(got[0], ("ok", None));
        assert_eq!(got[1], ("mismatch", Some("quote is at line 2, not 1")));
        assert_eq!(got[2].0, "missing");
        assert_eq!(got[3].0, "mismatch");
        assert_eq!(got[4], ("ok", None));
        assert_eq!(got[5].0, "unknown");
        assert_eq!(got[6], ("ok", None));
        assert_eq!(got[7].0, "missing");
    }

    #[test]
    fn unknown_commit_and_non_git_are_unavailable() {
        let (dir, _) = repo("unavailable");
        let body = format!(
            "{}[[step]]\nat = \"api\"\nkind = \"suspect\"\nnote = \"n\"\n\
             [[step.evidence]]\ntype = \"cite\"\nfile = \"src/app.txt\"\nlines = \"2\"\nquote = \"policy\"\n",
            header("0123abcd")
        );
        write_trail(&dir.0, &body);
        let payload = trail_payload(&dir.0, &issue(), None).unwrap();
        assert!(payload
            .errors
            .iter()
            .any(|e| e.contains("commit 0123abcd not found")));
        assert_eq!(payload.steps[0].evidence[0].status, "unavailable");

        let plain = TempDir::new("plain");
        std::fs::create_dir_all(plain.0.join(".krypton/analyses/o/r/7")).unwrap();
        write_trail(&plain.0, &body);
        let payload = trail_payload(&plain.0, &issue(), None).unwrap();
        assert_eq!(
            payload.steps[0].evidence[0].detail.as_deref(),
            Some("not a git repository")
        );
        assert!(payload.map.map.is_none());
    }

    #[test]
    fn issue_mismatch_and_missing_trail() {
        let (dir, head) = repo("mismatch");
        assert!(trail_payload(&dir.0, &issue(), None).is_none());
        write_trail(&dir.0, &header(&head[..8]).replace("o/r#7", "o/r#8"));
        let payload = trail_payload(&dir.0, &issue(), None).unwrap();
        assert!(payload
            .errors
            .iter()
            .any(|e| e.contains("does not match the bundle")));
        assert!(payload.warnings.contains(&"step: no steps yet".to_string()));
    }

    #[test]
    fn snapshots_detect_edits_during_analysis() {
        let (dir, head) = repo("snapshot");
        let root = &dir.0;
        trail_begin(root.to_string_lossy().into_owned(), "o/r#7".into()).unwrap();
        assert!(root.join(".krypton/analyses/TRAIL.md").is_file());
        write_trail(root, &header(&head[..8]));
        let clean = trail_check(root, "o/r#7").unwrap();
        assert_eq!(clean["changedDuringAnalysis"], json!([]));
        std::fs::write(root.join("src/app.txt"), "edited\n").unwrap();
        std::fs::write(root.join("src/new.txt"), "new\n").unwrap();
        let dirty = trail_check(root, "o/r#7").unwrap();
        assert_eq!(
            dirty["changedDuringAnalysis"],
            json!(["src/app.txt", "src/new.txt"])
        );
        assert_eq!(dirty["ok"], json!(false));
        let state = read_state(&root.join(".krypton/analyses/o/r/7"));
        assert_eq!(
            state.check.unwrap().changed,
            vec!["src/app.txt", "src/new.txt"]
        );
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "fix"]);
        let moved = trail_check(root, "o/r#7").unwrap();
        assert_eq!(moved["changedDuringAnalysis"][0], json!("HEAD moved"));
    }

    #[test]
    fn trust_untrusted_trusted_changed() {
        let (dir, head) = repo("trust");
        let root = &dir.0;
        let trust = root.join(".krypton/trust.toml");
        let repro = "[[repro]]\nid = \"r1\"\nargv = [\"false\"]\nwhat = \"x\"\n";
        write_trail(root, &format!("{}{repro}", header(&head[..8])));
        let t = load_valid_trail(root, &issue()).unwrap();
        let sha = repro_sha(&t.repro);
        assert_eq!(trust_state(Some(&trust), root, "o/r#7", &sha), "untrusted");
        let trusted = trust_with(&trust, root, &issue()).unwrap();
        assert_eq!(trusted.argv, vec![vec!["false".to_string()]]);
        assert_eq!(trust_state(Some(&trust), root, "o/r#7", &sha), "trusted");
        // Rewording `what` keeps the trust; changing argv does not.
        write_trail(
            root,
            &format!("{}{}", header(&head[..8]), repro.replace("\"x\"", "\"y\"")),
        );
        let t = load_valid_trail(root, &issue()).unwrap();
        assert_eq!(
            trust_state(Some(&trust), root, "o/r#7", &repro_sha(&t.repro)),
            "trusted"
        );
        write_trail(
            root,
            &format!("{}{}", header(&head[..8]), repro.replace("false", "true")),
        );
        let t = load_valid_trail(root, &issue()).unwrap();
        assert_eq!(
            trust_state(Some(&trust), root, "o/r#7", &repro_sha(&t.repro)),
            "changed"
        );
    }

    #[tokio::test]
    async fn repro_runs_refuse_then_record_outcomes() {
        let (dir, head) = repo("runs");
        let root = &dir.0;
        let trust = root.join(".krypton/trust.toml");
        let body = format!(
            "{}[[repro]]\nid = \"bug\"\nargv = [\"sh\", \"-c\", \"echo boom; exit 3\"]\nwhat = \"x\"\n\
             [[repro]]\nid = \"ok\"\nargv = [\"true\"]\nwhat = \"x\"\n\
             [[step]]\nat = \"api\"\nkind = \"root-cause\"\nnote = \"n\"\n\
             [[step.evidence]]\ntype = \"repro\"\nid = \"bug\"\n\
             [[step]]\nat = \"store\"\nkind = \"suspect\"\nnote = \"n\"\n\
             [[step.evidence]]\ntype = \"repro\"\nid = \"ok\"\n",
            header(&head[..8])
        );
        write_trail(root, &body);
        let err = run_with(Some(&trust), root, &issue(), None)
            .await
            .unwrap_err();
        assert!(err.starts_with("untrusted"), "{err}");
        let payload = trail_payload(root, &issue(), Some(&trust)).unwrap();
        assert_eq!(payload.steps[0].evidence[0].status, "untrusted");

        trust_with(&trust, root, &issue()).unwrap();
        std::fs::write(root.join("src/app.txt"), "dirty\n").unwrap();
        let err = run_with(Some(&trust), root, &issue(), None)
            .await
            .unwrap_err();
        assert!(
            err.contains("working tree has changes outside .krypton/: src/app.txt"),
            "{err}"
        );
        git(root, &["checkout", "--", "src/app.txt"]);

        let runs = run_with(Some(&trust), root, &issue(), None).await.unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].outcome, "fail");
        assert_eq!(runs[0].exit_code, Some(3));
        assert!(runs[0].output_tail.contains("boom"));
        assert_eq!(runs[1].outcome, "pass");
        let payload = trail_payload(root, &issue(), Some(&trust)).unwrap();
        assert_eq!(payload.steps[0].evidence[0].status, "reproduced");
        assert!(payload.steps[0].evidence[0]
            .output_tail
            .as_deref()
            .unwrap()
            .contains("boom"));
        assert_eq!(payload.steps[1].evidence[0].status, "unexpected");

        std::fs::write(root.join("src/app.txt"), "fixed\n").unwrap();
        git(root, &["commit", "-q", "-am", "fix"]);
        let err = run_with(Some(&trust), root, &issue(), Some("bug"))
            .await
            .unwrap_err();
        assert!(err.starts_with("HEAD moved"), "{err}");
    }

    #[test]
    fn repro_status_rules() {
        let repro = Repro {
            id: "r".into(),
            argv: vec!["x".into()],
            expect: "fail".into(),
            timeout_s: 5,
            what: "w".into(),
        };
        let run = |commit: &str, outcome: &str, clean: bool| TrailRun {
            run_id: "20261114T000000Z-0001".into(),
            id: "r".into(),
            argv: vec![],
            commit: Some(commit.into()),
            tree_clean: clean,
            outcome: outcome.into(),
            exit_code: None,
            duration_ms: 0,
            output_tail: String::new(),
        };
        assert_eq!(
            repro_status(None, &repro, Some("c"), "trusted").0,
            "not-run"
        );
        assert_eq!(
            repro_status(None, &repro, Some("c"), "changed").0,
            "untrusted"
        );
        assert_eq!(
            repro_status(Some(&run("c", "fail", true)), &repro, Some("c"), "trusted").0,
            "reproduced"
        );
        assert_eq!(
            repro_status(Some(&run("c", "pass", true)), &repro, Some("c"), "trusted").0,
            "unexpected"
        );
        assert_eq!(
            repro_status(
                Some(&run("c", "timeout", true)),
                &repro,
                Some("c"),
                "trusted"
            )
            .0,
            "not-run"
        );
        assert_eq!(
            repro_status(Some(&run("d", "fail", true)), &repro, Some("c"), "trusted").0,
            "stale"
        );
        assert_eq!(
            repro_status(Some(&run("c", "fail", false)), &repro, Some("c"), "trusted").0,
            "stale"
        );
    }

    #[test]
    fn dirty_paths_skip_krypton_and_follow_renames() {
        let (dir, _) = repo("dirty");
        let root = &dir.0;
        std::fs::write(root.join(".krypton/analyses/o/r/7/x.md"), "x").unwrap();
        assert!(dirty_paths(root).is_empty());
        git(root, &["mv", "src/app.txt", "src/moved.txt"]);
        assert_eq!(dirty_paths(root), vec!["src/moved.txt"]);
    }

    #[test]
    fn index_lists_trails_newest_issue_first() {
        let (dir, head) = repo("index");
        let root = &dir.0;
        write_trail(root, &header(&head[..8]));
        std::fs::create_dir_all(root.join(".krypton/analyses/o/r/12")).unwrap();
        std::fs::write(
            root.join(".krypton/analyses/o/r/12").join(TRAIL_FILE),
            header(&head[..8]).replace("o/r#7", "o/r#12"),
        )
        .unwrap();
        let issues = vec![
            issue(),
            parse_issue_key("o/r#12").unwrap(),
            parse_issue_key("o/r#99").unwrap(),
        ];
        let index = index_payload(root, "p".into(), "proj".into(), &issues);
        let keys: Vec<&str> = index.trails.iter().map(|t| t.issue.as_str()).collect();
        assert_eq!(
            keys,
            vec!["o/r#12", "o/r#7"],
            "#99 has no trail and is skipped"
        );
        assert_eq!(index.project_name, "proj");
    }
}
