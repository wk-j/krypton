//! Rails verifier backend (spec 337).
//!
//! A project declares its rails in `<root>/.krypton/rails.toml`: rule sources
//! (markdown files whose `## Rails` sections hold the bullets), an optional
//! glossary and `[[check]]` commands. This module parses the manifest and the
//! sources, gates the commands behind a per-user trust store
//! (`~/.config/krypton/rails-trust.toml`, keyed by the manifest's sha256),
//! runs one check at a time per root, and stores the run records the frontend
//! builds (`.krypton/rails/runs/<runId>.json`). The run record shape is owned
//! by `src/acp/rails/types.ts`; Rust only validates its `runId`.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::child_process::{kill_group, login_command, Signal};

const MANIFEST_REL: &str = ".krypton/rails.toml";
const RAILS_DIR_REL: &str = ".krypton/rails";
const RUNS_REL: &str = ".krypton/rails/runs";
const TRUST_FILE: &str = "rails-trust.toml";
const DEFAULT_TIMEOUT_S: u64 = 300;
const MIN_TIMEOUT_S: u64 = 5;
const MAX_TIMEOUT_S: u64 = 1800;
/// Check output kept in memory: a rolling window over the newest bytes, so
/// the child never blocks on a full pipe and the tail is the real end.
const OUTPUT_CAP: usize = 2 * 1024 * 1024;
/// Bytes past the cap before the window is compacted (amortizes the shift).
const OUTPUT_SLACK: usize = 256 * 1024;
const TAIL_LINES: usize = 80;
const TAIL_BYTES: usize = 8 * 1024;
const KILL_DELAY: Duration = Duration::from_secs(5);
const RUN_RETENTION: usize = 200;
const HISTORY_MAX: u32 = 200;

// ─── Wire types (mirrored by src/acp/rails/types.ts) ───────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    Trusted,
    Untrusted,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailsCheckDecl {
    pub name: String,
    pub argv: Vec<String>,
    pub timeout_s: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailsRule {
    pub id: String,
    pub source: String,
    pub applies_to: Vec<String>,
    pub check: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryEntry {
    pub id: String,
    pub term: String,
    pub definition: String,
    pub avoid: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailsSnapshot {
    pub present: bool,
    pub manifest_path: String,
    pub trust: Trust,
    pub checks: Vec<RailsCheckDecl>,
    pub rules: Vec<RailsRule>,
    pub glossary: Vec<GlossaryEntry>,
    pub uncovered_sources: Vec<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckOutcome {
    Pass,
    Fail,
    Timeout,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailsCheckResult {
    pub name: String,
    pub outcome: CheckOutcome,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub output_tail: String,
}

// ─── Manifest ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
struct Manifest {
    /// Normalized root-relative paths (`/`-joined, `""` = the root itself).
    sources: Vec<String>,
    glossary: Option<String>,
    checks: Vec<RailsCheckDecl>,
}

/// Lexically normalize a manifest path: root-relative, no `..`, not absolute.
fn normalize_rel(raw: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in Path::new(raw).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => match part.to_str() {
                Some(s) => parts.push(s),
                None => return Err(format!("\"{raw}\" is not valid UTF-8")),
            },
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("\"{raw}\" must stay inside the project root"));
            }
        }
    }
    Ok(parts.join("/"))
}

fn valid_check_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Parse `rails.toml` v1. Ok carries the manifest plus warnings (unknown
/// keys); Err carries every validation error.
fn parse_manifest(text: &str) -> Result<(Manifest, Vec<String>), Vec<String>> {
    let table: toml::Table = toml::from_str(text).map_err(|e| vec![format!("{e}")])?;
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    match table.get("version") {
        Some(toml::Value::Integer(1)) => {}
        _ => errors.push("version: must be 1".to_string()),
    }

    let mut sources = Vec::new();
    match table.get("sources") {
        Some(toml::Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                match item {
                    toml::Value::String(s) if !s.trim().is_empty() => match normalize_rel(s) {
                        Ok(rel) if !sources.contains(&rel) => sources.push(rel),
                        Ok(_) => {}
                        Err(e) => errors.push(format!("sources[{i}]: {e}")),
                    },
                    _ => errors.push(format!("sources[{i}]: must be a non-empty string")),
                }
            }
        }
        _ => errors.push("sources: must be an array of paths".to_string()),
    }

    let glossary = match table.get("glossary") {
        None => None,
        Some(toml::Value::String(s)) if !s.trim().is_empty() => match normalize_rel(s) {
            Ok(rel) if !rel.is_empty() => Some(rel),
            Ok(_) => {
                errors.push("glossary: must name a file".to_string());
                None
            }
            Err(e) => {
                errors.push(format!("glossary: {e}"));
                None
            }
        },
        Some(_) => {
            errors.push("glossary: must be a non-empty string".to_string());
            None
        }
    };

    let mut checks: Vec<RailsCheckDecl> = Vec::new();
    match table.get("check") {
        None => {}
        Some(toml::Value::Array(items)) => {
            for (i, item) in items.iter().enumerate() {
                let toml::Value::Table(entry) = item else {
                    errors.push(format!("check[{i}]: must be a table ([[check]])"));
                    continue;
                };
                if let Some(decl) = parse_check(i, entry, &mut errors, &mut warnings) {
                    if checks.iter().any(|c| c.name == decl.name) {
                        errors.push(format!("check[{i}].name: duplicate \"{}\"", decl.name));
                    } else {
                        checks.push(decl);
                    }
                }
            }
        }
        Some(_) => errors.push("check: must be an array of tables ([[check]])".to_string()),
    }

    const KNOWN: [&str; 4] = ["version", "sources", "glossary", "check"];
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
            sources,
            glossary,
            checks,
        },
        warnings,
    ))
}

fn parse_check(
    i: usize,
    entry: &toml::Table,
    errors: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Option<RailsCheckDecl> {
    let before = errors.len();
    let name = match entry.get("name") {
        Some(toml::Value::String(s)) if valid_check_name(s) => s.clone(),
        _ => {
            errors.push(format!(
                "check[{i}].name: must be a non-empty name of letters, digits, '.', '_' or '-'"
            ));
            String::new()
        }
    };
    let mut argv = Vec::new();
    match entry.get("argv") {
        Some(toml::Value::Array(items)) if !items.is_empty() => {
            for (j, item) in items.iter().enumerate() {
                match item {
                    toml::Value::String(s) if !s.is_empty() => argv.push(s.clone()),
                    _ => errors.push(format!("check[{i}].argv[{j}]: must be a non-empty string")),
                }
            }
        }
        _ => errors.push(format!(
            "check[{i}].argv: must be a non-empty array of non-empty strings"
        )),
    }
    let timeout_s = match entry.get("timeout_s") {
        None => DEFAULT_TIMEOUT_S,
        Some(toml::Value::Integer(n))
            if (MIN_TIMEOUT_S as i64..=MAX_TIMEOUT_S as i64).contains(n) =>
        {
            *n as u64
        }
        Some(_) => {
            errors.push(format!(
                "check[{i}].timeout_s: must be an integer in {MIN_TIMEOUT_S}..{MAX_TIMEOUT_S}"
            ));
            DEFAULT_TIMEOUT_S
        }
    };
    const KNOWN: [&str; 3] = ["name", "argv", "timeout_s"];
    for key in entry.keys() {
        if !KNOWN.contains(&key.as_str()) {
            warnings.push(format!("check[{i}]: unknown key \"{key}\""));
        }
    }
    (errors.len() == before).then_some(RailsCheckDecl {
        name,
        argv,
        timeout_s,
    })
}

// ─── Rule sources ───────────────────────────────────────────────────

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

/// Require `path` (which exists) to resolve inside `root` after symlinks.
fn confine(root: &Path, path: &Path, label: &str) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|e| format!("{label}: {e}"))?;
    if !resolved.starts_with(root) {
        return Err(format!("{label}: resolves outside the project root"));
    }
    Ok(resolved)
}

/// Expand the manifest's sources into `(rel path, absolute path)` files:
/// a file stays itself, a directory contributes its `*.md` (non-recursive,
/// sorted by name). A missing source is a warning; an escape is an error.
fn resolve_sources(
    root: &Path,
    sources: &[String],
    warnings: &mut Vec<String>,
) -> Result<Vec<(String, PathBuf)>, String> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let push = |rel: String, path: PathBuf, files: &mut Vec<(String, PathBuf)>| {
        if !files.iter().any(|(r, _)| *r == rel) {
            files.push((rel, path));
        }
    };
    for source in sources {
        let label = format!(
            "sources: \"{}\"",
            if source.is_empty() { "." } else { source }
        );
        let joined = root.join(source);
        if !joined.exists() {
            warnings.push(format!("{label} not found"));
            continue;
        }
        let resolved = confine(root, &joined, &label)?;
        if !resolved.is_dir() {
            push(source.clone(), resolved, &mut files);
            continue;
        }
        let entries = std::fs::read_dir(&resolved).map_err(|e| format!("{label}: {e}"))?;
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| {
                Path::new(name)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            })
            .collect();
        names.sort();
        for name in names {
            let rel = join_rel(source, &name);
            let path = confine(root, &joined.join(&name), &format!("sources: \"{rel}\""))?;
            if path.is_file() {
                push(rel, path, &mut files);
            }
        }
    }
    Ok(files)
}

/// `#`-count of an ATX heading line (`## Rails` → 2), or None.
fn heading_level(line: &str) -> Option<usize> {
    let level = line.bytes().take_while(|b| *b == b'#').count();
    let rest = &line[level..];
    ((1..=6).contains(&level) && (rest.is_empty() || rest.starts_with([' ', '\t'])))
        .then_some(level)
}

fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

/// The contents of every backticked span in `text`.
fn backticked(text: &str) -> Vec<String> {
    text.split('`')
        .skip(1)
        .step_by(2)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Split a trailing `` `check:<name>` `` marker off a bullet.
fn split_check_marker(text: &str) -> (String, Option<String>) {
    let text = text.trim_end();
    if let Some(body) = text.strip_suffix('`') {
        if let Some(open) = body.rfind('`') {
            if let Some(name) = body[open + 1..].strip_prefix("check:") {
                let name = name.trim();
                if !name.is_empty() && !name.contains(char::is_whitespace) {
                    return (body[..open].trim_end().to_string(), Some(name.to_string()));
                }
            }
        }
    }
    (text.to_string(), None)
}

/// Collects the bullets of one `## Rails` section.
#[derive(Default)]
struct SectionScan {
    applies_to: Vec<String>,
    bullets: Vec<String>,
    current: Option<String>,
    after_blank: bool,
}

impl SectionScan {
    fn close_bullet(&mut self) {
        if let Some(text) = self.current.take() {
            let text = text.trim().to_string();
            if !text.is_empty() {
                self.bullets.push(text);
            }
        }
    }

    fn line(&mut self, line: &str, rel: &str, warnings: &mut Vec<String>) {
        if line.trim().is_empty() {
            self.after_blank = true;
            return;
        }
        let after_blank = std::mem::replace(&mut self.after_blank, false);
        if let Some(rest) = line.strip_prefix("Applies to:") {
            self.close_bullet();
            let globs = backticked(rest);
            if globs.is_empty() {
                warnings.push(format!("{rel}: \"Applies to:\" lists no backticked globs"));
            }
            self.applies_to.extend(globs);
            return;
        }
        if let Some(rest) = line.strip_prefix("- ") {
            self.close_bullet();
            self.current = Some(rest.trim().to_string());
            return;
        }
        let indented = line.starts_with([' ', '\t']);
        match self.current.as_mut() {
            Some(current) if !after_blank || indented => {
                current.push(' ');
                current.push_str(line.trim());
            }
            _ => self.close_bullet(),
        }
    }
}

/// The rules of one source file, or None when it has no `## Rails` section.
/// Bullets inside code fences never count.
fn extract_rules(
    rel: &str,
    text: &str,
    known_checks: &HashSet<&str>,
    warnings: &mut Vec<String>,
) -> Option<Vec<RailsRule>> {
    let mut found = false;
    let mut in_fence = false;
    let mut section: Option<SectionScan> = None;
    let mut rules = Vec::new();
    let finish = |scan: SectionScan, rules: &mut Vec<RailsRule>, warnings: &mut Vec<String>| {
        for bullet in scan.bullets {
            let id = format!("{rel}#{}", rules.len() + 1);
            let (text, marker) = split_check_marker(&bullet);
            let check = match marker {
                Some(name) if known_checks.contains(name.as_str()) => Some(name),
                Some(name) => {
                    warnings.push(format!("{id}: unknown check \"{name}\""));
                    None
                }
                None => None,
            };
            rules.push(RailsRule {
                id,
                source: rel.to_string(),
                applies_to: scan.applies_to.clone(),
                check,
                text,
            });
        }
    };
    for line in text.lines() {
        if is_fence(line) {
            in_fence = !in_fence;
            if let Some(scan) = section.as_mut() {
                scan.close_bullet();
            }
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(level) = heading_level(line) {
            if level <= 2 {
                if let Some(mut scan) = section.take() {
                    scan.close_bullet();
                    finish(scan, &mut rules, warnings);
                }
                if level == 2 && line[2..].trim() == "Rails" {
                    found = true;
                    section = Some(SectionScan::default());
                }
            } else if let Some(scan) = section.as_mut() {
                scan.close_bullet();
            }
            continue;
        }
        if let Some(scan) = section.as_mut() {
            scan.line(line, rel, warnings);
        }
    }
    if let Some(mut scan) = section.take() {
        scan.close_bullet();
        finish(scan, &mut rules, warnings);
    }
    found.then_some(rules)
}

/// `**Term**: rest` → `(Term, rest)`. A parenthetical tag between the term and
/// the colon is allowed, as `CONTEXT.md` writes it: `**Lesson** (spec 298): …`.
fn term_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("**")?;
    let end = rest.find("**")?;
    let term = rest[..end].trim();
    let after = rest[end + 2..].trim_start();
    let after = match after.strip_prefix('(') {
        Some(tagged) => tagged.split_once(')')?.1.trim_start(),
        None => after,
    };
    let def = after.strip_prefix(':')?;
    (!term.is_empty()).then_some((term, def))
}

/// `_Avoid_:` items: comma-separated outside parentheses; parenthetical
/// explanations are dropped so each item is the word or phrase itself.
fn split_avoid(text: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut push = |current: &mut String| {
        let item = current.split_whitespace().collect::<Vec<_>>().join(" ");
        if !item.is_empty() {
            items.push(item);
        }
        current.clear();
    };
    for c in text.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => push(&mut current),
            _ if depth == 0 => current.push(c),
            _ => {}
        }
    }
    push(&mut current);
    items
}

struct TermScan {
    term: String,
    definition: String,
    avoid: Vec<String>,
    closed: bool,
}

/// `**Term**:` entries (CONTEXT-FORMAT). The definition runs from the term
/// line until a blank line, an `_Avoid_:` line, a heading or the next term.
fn extract_glossary(rel: &str, text: &str, warnings: &mut Vec<String>) -> Vec<GlossaryEntry> {
    let mut entries: Vec<GlossaryEntry> = Vec::new();
    let mut current: Option<TermScan> = None;
    let mut in_fence = false;
    let mut finish = |scan: Option<TermScan>, entries: &mut Vec<GlossaryEntry>| {
        let Some(scan) = scan else {
            return;
        };
        let id = format!("{rel}#{}", scan.term);
        if entries.iter().any(|e| e.id == id) {
            warnings.push(format!("{id}: duplicate glossary term"));
            return;
        }
        entries.push(GlossaryEntry {
            id,
            term: scan.term,
            definition: scan.definition,
            avoid: scan.avoid,
        });
    };
    for line in text.lines() {
        if is_fence(line) {
            in_fence = !in_fence;
            finish(current.take(), &mut entries);
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some((term, rest)) = term_line(line) {
            finish(current.take(), &mut entries);
            current = Some(TermScan {
                term: term.to_string(),
                definition: rest.trim().to_string(),
                avoid: Vec::new(),
                closed: false,
            });
            continue;
        }
        if heading_level(line).is_some() {
            finish(current.take(), &mut entries);
            continue;
        }
        let Some(scan) = current.as_mut() else {
            continue;
        };
        if let Some(rest) = line.trim_start().strip_prefix("_Avoid_:") {
            scan.avoid.extend(split_avoid(rest));
            scan.closed = true;
        } else if line.trim().is_empty() {
            if !scan.definition.is_empty() {
                scan.closed = true;
            }
        } else if !scan.closed {
            if !scan.definition.is_empty() {
                scan.definition.push(' ');
            }
            scan.definition.push_str(line.trim());
        }
    }
    finish(current.take(), &mut entries);
    entries
}

// ─── Trust store ────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustStore {
    #[serde(default)]
    project: Vec<TrustEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TrustEntry {
    root: String,
    sha256: String,
}

fn trust_store_path() -> Option<PathBuf> {
    crate::config::config_dir().map(|d| d.join(TRUST_FILE))
}

fn read_trust_store(path: &Path) -> Result<TrustStore, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(TrustStore::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn root_key(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn trust_state(trust_path: Option<&Path>, root: &Path, sha: &str) -> Trust {
    let Some(path) = trust_path else {
        return Trust::Untrusted;
    };
    let store = match read_trust_store(path) {
        Ok(store) => store,
        Err(e) => {
            log::warn!("rails: unreadable trust store: {e}");
            return Trust::Untrusted;
        }
    };
    let key = root_key(root);
    match store.project.iter().find(|p| p.root == key) {
        None => Trust::Untrusted,
        Some(entry) if entry.sha256 == sha => Trust::Trusted,
        Some(_) => Trust::Changed,
    }
}

// ─── Snapshot ───────────────────────────────────────────────────────

struct Loaded {
    snapshot: RailsSnapshot,
    /// sha256 of the manifest bytes the snapshot was built from.
    sha: Option<String>,
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_REL)
}

/// Read and validate everything `rails_load` reports. `root` is canonical.
fn load(root: &Path, trust_path: Option<&Path>) -> Loaded {
    let path = manifest_path(root);
    let mut snapshot = RailsSnapshot {
        present: false,
        manifest_path: path.to_string_lossy().into_owned(),
        trust: Trust::Untrusted,
        checks: Vec::new(),
        rules: Vec::new(),
        glossary: Vec::new(),
        uncovered_sources: Vec::new(),
        warnings: Vec::new(),
        error: None,
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Loaded {
                snapshot,
                sha: None,
            };
        }
        Err(e) => {
            snapshot.present = true;
            snapshot.error = Some(format!("rails.toml: {e}"));
            return Loaded {
                snapshot,
                sha: None,
            };
        }
    };
    snapshot.present = true;
    let sha = sha256_hex(&bytes);
    snapshot.trust = trust_state(trust_path, root, &sha);
    if let Err(e) = fill(root, &bytes, &mut snapshot) {
        snapshot.error = Some(e);
    }
    Loaded {
        snapshot,
        sha: Some(sha),
    }
}

fn fill(root: &Path, bytes: &[u8], snapshot: &mut RailsSnapshot) -> Result<(), String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "rails.toml: not valid UTF-8".to_string())?;
    let (manifest, warnings) = parse_manifest(text).map_err(|errors| {
        errors
            .iter()
            .map(|e| format!("rails.toml: {e}"))
            .collect::<Vec<_>>()
            .join("; ")
    })?;
    snapshot.warnings = warnings
        .into_iter()
        .map(|w| format!("rails.toml: {w}"))
        .collect();
    snapshot.checks = manifest.checks.clone();
    let warnings = &mut snapshot.warnings;
    let files = resolve_sources(root, &manifest.sources, warnings)?;
    let glossary_file = match &manifest.glossary {
        Some(rel) => {
            let joined = root.join(rel);
            if joined.exists() {
                Some((
                    rel.clone(),
                    confine(root, &joined, &format!("glossary: \"{rel}\""))?,
                ))
            } else {
                warnings.push(format!("glossary: \"{rel}\" not found"));
                None
            }
        }
        None => None,
    };

    let known: HashSet<&str> = manifest.checks.iter().map(|c| c.name.as_str()).collect();
    for (rel, path) in &files {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) => {
                warnings.push(format!("{rel}: {e}"));
                continue;
            }
        };
        match extract_rules(rel, &text, &known, warnings) {
            Some(rules) => snapshot.rules.extend(rules),
            None => snapshot.uncovered_sources.push(rel.clone()),
        }
    }
    if let Some((rel, path)) = glossary_file {
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                snapshot.glossary = extract_glossary(&rel, &text, warnings);
                if snapshot.glossary.is_empty() {
                    warnings.push(format!("glossary: \"{rel}\" has no **Term**: entries"));
                }
            }
            Err(e) => warnings.push(format!("glossary: \"{rel}\": {e}")),
        }
    }
    Ok(())
}

fn trust_manifest(root: &Path, trust_path: &Path) -> Result<RailsSnapshot, String> {
    let loaded = load(root, Some(trust_path));
    let mut snapshot = loaded.snapshot;
    if !snapshot.present {
        return Err(format!("no {MANIFEST_REL} in {}", root.display()));
    }
    if let Some(e) = snapshot.error {
        return Err(e);
    }
    let sha = loaded
        .sha
        .ok_or_else(|| "rails.toml: unreadable".to_string())?;
    let mut store = read_trust_store(trust_path)?;
    let key = root_key(root);
    match store.project.iter_mut().find(|p| p.root == key) {
        Some(entry) => entry.sha256 = sha,
        None => store.project.push(TrustEntry {
            root: key,
            sha256: sha,
        }),
    }
    if let Some(dir) = trust_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = toml::to_string(&store).map_err(|e| format!("rails-trust.toml: {e}"))?;
    crate::hook_server::write_file_atomic(trust_path, &text)
        .map_err(|e| format!("{}: {e}", trust_path.display()))?;
    snapshot.trust = Trust::Trusted;
    Ok(snapshot)
}

// ─── Check runner ───────────────────────────────────────────────────

struct Active {
    token: u64,
    pgid: Option<i32>,
    cancelled: bool,
}

/// Per-root single flight for `rails_run_check`, plus the running group's
/// pgid so `rails_cancel` and app exit can signal it.
#[derive(Default)]
pub struct RailsState {
    active: Mutex<HashMap<PathBuf, Active>>,
    next_token: AtomicU64,
}

impl RailsState {
    fn lock(&self) -> MutexGuard<'_, HashMap<PathBuf, Active>> {
        self.active.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Holds a root's check slot; released on drop, whatever the exit path.
struct Flight<'a> {
    state: &'a RailsState,
    root: PathBuf,
    token: u64,
}

impl<'a> Flight<'a> {
    fn acquire(state: &'a RailsState, root: &Path) -> Result<Self, String> {
        let mut active = state.lock();
        if active.contains_key(root) {
            return Err("busy".to_string());
        }
        let token = state.next_token.fetch_add(1, Ordering::Relaxed);
        active.insert(
            root.to_path_buf(),
            Active {
                token,
                pgid: None,
                cancelled: false,
            },
        );
        Ok(Self {
            state,
            root: root.to_path_buf(),
            token,
        })
    }

    /// Record the spawned group; true when a cancel arrived before it.
    fn set_pgid(&self, pgid: Option<i32>) -> bool {
        match self.state.lock().get_mut(&self.root) {
            Some(entry) if entry.token == self.token => {
                entry.pgid = pgid;
                entry.cancelled
            }
            _ => false,
        }
    }

    fn cancelled(&self) -> bool {
        self.state
            .lock()
            .get(&self.root)
            .is_some_and(|a| a.token == self.token && a.cancelled)
    }
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        let mut active = self.state.lock();
        if active
            .get(&self.root)
            .is_some_and(|a| a.token == self.token)
        {
            active.remove(&self.root);
        }
    }
}

struct Spawned {
    child: tokio::process::Child,
    /// stdout and stderr, merged in write order.
    output: Box<dyn AsyncRead + Unpin + Send>,
}

/// Spawn with stdout and stderr on one pipe so the tail interleaves them as
/// the check wrote them.
#[cfg(unix)]
fn spawn_merged(root: &Path, argv: &[String]) -> Result<Spawned, String> {
    let mut cmd = login_command(root, argv)?;
    let (sender, receiver) = tokio::net::unix::pipe::pipe().map_err(|e| format!("pipe: {e}"))?;
    let write_end = sender
        .into_blocking_fd()
        .map_err(|e| format!("pipe: {e}"))?;
    let write_end_2 = write_end.try_clone().map_err(|e| format!("pipe: {e}"))?;
    cmd.stdout(Stdio::from(write_end))
        .stderr(Stdio::from(write_end_2));
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", argv[0]))?;
    // The command owns the parent's copies of the write end; dropping it
    // lets EOF arrive once the check's process group closes the pipe.
    drop(cmd);
    Ok(Spawned {
        child,
        output: Box::new(receiver),
    })
}

/// Without a shared pipe, stdout is read before stderr.
#[cfg(not(unix))]
fn spawn_merged(root: &Path, argv: &[String]) -> Result<Spawned, String> {
    let mut cmd = login_command(root, argv)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", argv[0]))?;
    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr = child.stderr.take().ok_or("no stderr pipe")?;
    Ok(Spawned {
        child,
        output: Box::new(stdout.chain(stderr)),
    })
}

fn push_rolling(buf: &mut Vec<u8>, chunk: &[u8]) {
    buf.extend_from_slice(chunk);
    if buf.len() > OUTPUT_CAP + OUTPUT_SLACK {
        buf.drain(..buf.len() - OUTPUT_CAP);
    }
}

/// The last ≤ `TAIL_LINES` lines of `bytes`, at most `TAIL_BYTES` long.
fn output_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_end_matches(['\n', '\r']);
    let start = text
        .rmatch_indices('\n')
        .nth(TAIL_LINES - 1)
        .map_or(0, |(i, _)| i + 1);
    let mut tail = text[start..].replace("\r\n", "\n");
    if tail.len() > TAIL_BYTES {
        let mut cut = tail.len() - TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
    tail
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

enum Ending {
    Exited(std::io::Result<std::process::ExitStatus>),
    TimedOut,
}

/// Run one check to completion. After the leader exits, leftover members of
/// its group get SIGTERM and `kill_delay` to release the pipe, then SIGKILL.
/// On timeout the group gets SIGTERM, then SIGKILL after `kill_delay`.
async fn execute(
    flight: &Flight<'_>,
    root: &Path,
    decl: &RailsCheckDecl,
    timeout: Duration,
    kill_delay: Duration,
) -> RailsCheckResult {
    let started = Instant::now();
    let result = |outcome, exit_code, output_tail| RailsCheckResult {
        name: decl.name.clone(),
        outcome,
        exit_code,
        duration_ms: elapsed_ms(started),
        output_tail,
    };
    let Spawned {
        mut child,
        mut output,
    } = match spawn_merged(root, &decl.argv) {
        Ok(spawned) => spawned,
        Err(e) => return result(CheckOutcome::Error, None, e),
    };
    let pgid = child.id().and_then(|p| i32::try_from(p).ok());
    if flight.set_pgid(pgid) {
        kill_group(pgid, Signal::Term);
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut status = None;
    let mut eof = false;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let ending = loop {
        if eof {
            if let Some(status) = status.take() {
                break Ending::Exited(status);
            }
        }
        tokio::select! {
            read = output.read(&mut chunk), if !eof => match read {
                Ok(0) | Err(_) => eof = true,
                Ok(n) => push_rolling(&mut buf, &chunk[..n]),
            },
            exited = child.wait(), if status.is_none() => {
                status = Some(exited);
                if !eof {
                    // Background jobs of the check still hold the pipe.
                    kill_group(pgid, Signal::Term);
                    let grace = tokio::time::Instant::now() + kill_delay;
                    if grace < deadline.deadline() {
                        deadline.as_mut().reset(grace);
                    }
                }
            },
            () = &mut deadline => match status.take() {
                Some(status) => {
                    kill_group(pgid, Signal::Kill);
                    break Ending::Exited(status);
                }
                None => break Ending::TimedOut,
            },
        }
    };

    match ending {
        Ending::TimedOut => {
            kill_group(pgid, Signal::Term);
            let _ = tokio::time::timeout(kill_delay, child.wait()).await;
            kill_group(pgid, Signal::Kill);
            let _ = child.start_kill();
            let _ = child.wait().await;
            let mut tail = output_tail(&buf);
            if !tail.is_empty() {
                tail.push('\n');
            }
            tail.push_str(&format!("timed out after {}s", timeout.as_secs()));
            result(CheckOutcome::Timeout, None, output_tail(tail.as_bytes()))
        }
        Ending::Exited(Err(e)) => result(CheckOutcome::Error, None, format!("wait: {e}")),
        Ending::Exited(Ok(status)) => {
            let outcome = if status.success() {
                CheckOutcome::Pass
            } else {
                CheckOutcome::Fail
            };
            result(outcome, status.code(), output_tail(&buf))
        }
    }
}

async fn run_check(
    state: &RailsState,
    root: &Path,
    trust_path: Option<&Path>,
    name: &str,
) -> Result<RailsCheckResult, String> {
    let loaded = load(root, trust_path);
    let snapshot = loaded.snapshot;
    if !snapshot.present {
        return Err(format!("no {MANIFEST_REL} in {}", root.display()));
    }
    if let Some(e) = snapshot.error {
        return Err(e);
    }
    if snapshot.trust != Trust::Trusted {
        return Err("untrusted".to_string());
    }
    let decl = snapshot
        .checks
        .into_iter()
        .find(|c| c.name == name)
        .ok_or_else(|| format!("unknown check: {name}"))?;
    let flight = Flight::acquire(state, root)?;
    let timeout = Duration::from_secs(decl.timeout_s);
    let result = execute(&flight, root, &decl, timeout, KILL_DELAY).await;
    if flight.cancelled() {
        return Err("cancelled".to_string());
    }
    Ok(result)
}

/// SIGTERM the root's running check group; a detached task SIGKILLs it after
/// `kill_delay` if the same check still runs. No-op when nothing runs.
fn cancel(state: &Arc<RailsState>, root: &Path, kill_delay: Duration) {
    let (token, pgid) = {
        let mut active = state.lock();
        let Some(entry) = active.get_mut(root) else {
            return;
        };
        entry.cancelled = true;
        (entry.token, entry.pgid)
    };
    kill_group(pgid, Signal::Term);
    let state = Arc::clone(state);
    let root = root.to_path_buf();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(kill_delay).await;
        let pgid = state
            .lock()
            .get(&root)
            .filter(|a| a.token == token)
            .and_then(|a| a.pgid);
        kill_group(pgid, Signal::Kill);
    });
}

/// App-exit drain: SIGTERM every running check group.
pub fn shutdown(state: &RailsState) {
    for active in state.lock().values() {
        kill_group(active.pgid, Signal::Term);
    }
}

// ─── Run ledger ─────────────────────────────────────────────────────

/// `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$`
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

fn runs_dir(root: &Path) -> PathBuf {
    root.join(RUNS_REL)
}

/// Run file names (`<runId>.json`), newest first.
fn run_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.strip_suffix(".json").is_some_and(valid_run_id))
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    names
}

fn record_run(root: &Path, run: &Value) -> Result<PathBuf, String> {
    let run_id = run
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| "run.runId: required string".to_string())?;
    if !valid_run_id(run_id) {
        return Err(format!(
            "run.runId: \"{run_id}\" does not match YYYYMMDDTHHMMSSZ-xxxx"
        ));
    }
    // Run records are local tracking state: keep them out of `git status` and
    // out of the working diff the next run judges.
    let rails_dir = root.join(RAILS_DIR_REL);
    crate::hook_server::ensure_ignored_dir(&rails_dir)
        .map_err(|e| format!("{}: {e}", rails_dir.display()))?;
    let dir = runs_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("{run_id}.json"));
    let text = serde_json::to_string_pretty(run).map_err(|e| format!("run: {e}"))?;
    crate::hook_server::write_file_atomic(&path, &text)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    for stale in run_files(&dir).iter().skip(RUN_RETENTION) {
        if let Err(e) = std::fs::remove_file(dir.join(stale)) {
            log::warn!("rails: cannot prune {stale}: {e}");
        }
    }
    Ok(path)
}

fn history(root: &Path, limit: u32) -> Vec<Value> {
    let limit = limit.clamp(1, HISTORY_MAX) as usize;
    let dir = runs_dir(root);
    run_files(&dir)
        .iter()
        .filter_map(|name| {
            let text = std::fs::read_to_string(dir.join(name)).ok()?;
            serde_json::from_str::<Value>(&text)
                .ok()
                .filter(Value::is_object)
        })
        .take(limit)
        .collect()
}

// ─── Tauri commands ─────────────────────────────────────────────────

fn root_path(root: &str) -> Result<PathBuf, String> {
    let canonical = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("project root {root}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("project root {root} is not a directory"));
    }
    Ok(canonical)
}

#[tauri::command]
pub fn rails_load(root: String) -> Result<RailsSnapshot, String> {
    let root = root_path(&root)?;
    Ok(load(&root, trust_store_path().as_deref()).snapshot)
}

#[tauri::command]
pub fn rails_trust(root: String) -> Result<RailsSnapshot, String> {
    let root = root_path(&root)?;
    let trust_path = trust_store_path().ok_or_else(|| "no home directory".to_string())?;
    trust_manifest(&root, &trust_path)
}

#[tauri::command]
pub async fn rails_run_check(
    state: tauri::State<'_, Arc<RailsState>>,
    root: String,
    name: String,
) -> Result<RailsCheckResult, String> {
    let root = root_path(&root)?;
    run_check(state.inner(), &root, trust_store_path().as_deref(), &name).await
}

#[tauri::command]
pub fn rails_cancel(state: tauri::State<'_, Arc<RailsState>>, root: String) -> Result<(), String> {
    cancel(state.inner(), &root_path(&root)?, KILL_DELAY);
    Ok(())
}

#[tauri::command]
pub fn rails_record_run(root: String, run: Value) -> Result<String, String> {
    let path = record_run(&root_path(&root)?, &run)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn rails_history(root: String, limit: u32) -> Result<Vec<Value>, String> {
    Ok(history(&root_path(&root)?, limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicU32;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let unique = format!(
                "krypton-rails-{name}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path.canonicalize().unwrap())
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        /// The trust store lives beside the project, never in ~/.config.
        fn trust_path(&self) -> PathBuf {
            self.0.join("config/rails-trust.toml")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn manifest_errors(text: &str) -> Vec<String> {
        parse_manifest(text).expect_err("expected validation errors")
    }

    // ── Manifest ──

    #[test]
    fn manifest_valid_with_defaults() {
        let (m, warnings) = parse_manifest(
            "version = 1\nsources = [\"docs/adr/\", \"./AGENTS.md\", \"docs/adr\"]\n\
             glossary = \"CONTEXT.md\"\n\n\
             [[check]]\nname = \"arch-tests\"\nargv = [\"npx\", \"vitest\", \"run\"]\n\n\
             [[check]]\nname = \"typecheck\"\nargv = [\"npx\", \"tsc\"]\ntimeout_s = 600\n",
        )
        .unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(m.sources, ["docs/adr", "AGENTS.md"]);
        assert_eq!(m.glossary.as_deref(), Some("CONTEXT.md"));
        assert_eq!(
            m.checks,
            [
                RailsCheckDecl {
                    name: "arch-tests".into(),
                    argv: vec!["npx".into(), "vitest".into(), "run".into()],
                    timeout_s: 300,
                },
                RailsCheckDecl {
                    name: "typecheck".into(),
                    argv: vec!["npx".into(), "tsc".into()],
                    timeout_s: 600,
                },
            ]
        );
    }

    #[test]
    fn manifest_unknown_keys_are_warnings() {
        let (m, warnings) = parse_manifest(
            "version = 1\nsources = []\nextra = true\n\n\
             [[check]]\nname = \"t\"\nargv = [\"true\"]\nenv = \"x\"\n",
        )
        .unwrap();
        assert_eq!(m.checks.len(), 1);
        assert_eq!(
            warnings,
            ["check[0]: unknown key \"env\"", "unknown key \"extra\""]
        );
    }

    #[test]
    fn manifest_version_must_be_one() {
        assert!(manifest_errors("sources = []\n").contains(&"version: must be 1".to_string()));
        assert!(manifest_errors("version = 2\nsources = []\n")
            .contains(&"version: must be 1".to_string()));
        assert!(!manifest_errors("version = \"x").is_empty());
    }

    #[test]
    fn manifest_check_validation() {
        let errors = manifest_errors(
            "version = 1\nsources = []\n\
             [[check]]\nname = \"a\"\nargv = [\"true\"]\n\
             [[check]]\nname = \"a\"\nargv = [\"false\"]\n\
             [[check]]\nname = \"b\"\nargv = []\n\
             [[check]]\nname = \"c d\"\nargv = [\"x\"]\n\
             [[check]]\nname = \"e\"\nargv = [\"x\"]\ntimeout_s = 4\n\
             [[check]]\nname = \"f\"\nargv = [\"x\"]\ntimeout_s = 1801\n",
        );
        assert_eq!(
            errors,
            [
                "check[1].name: duplicate \"a\"",
                "check[2].argv: must be a non-empty array of non-empty strings",
                "check[3].name: must be a non-empty name of letters, digits, '.', '_' or '-'",
                "check[4].timeout_s: must be an integer in 5..1800",
                "check[5].timeout_s: must be an integer in 5..1800",
            ]
        );
        assert!(parse_manifest(
            "version = 1\nsources = []\n[[check]]\nname = \"g\"\nargv = [\"x\"]\ntimeout_s = 1800\n"
        )
        .is_ok());
        assert_eq!(
            manifest_errors("version = 1\nsources = []\n[check]\nname = \"a\"\n"),
            ["check: must be an array of tables ([[check]])"]
        );
    }

    #[test]
    fn manifest_paths_must_stay_inside_root() {
        let errors = manifest_errors(
            "version = 1\nsources = [\"../other\", \"/etc\", \"docs/../../x\"]\n\
             glossary = \"../CONTEXT.md\"\n",
        );
        assert_eq!(
            errors,
            [
                "sources[0]: \"../other\" must stay inside the project root",
                "sources[1]: \"/etc\" must stay inside the project root",
                "sources[2]: \"docs/../../x\" must stay inside the project root",
                "glossary: \"../CONTEXT.md\" must stay inside the project root",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_source_outside_root_is_an_error() {
        let outside = TempDir::new("outside");
        outside.write("ADR.md", "## Rails\n\n- x\n");
        let tmp = TempDir::new("symlink");
        std::os::unix::fs::symlink(&outside.0, tmp.0.join("linked")).unwrap();
        tmp.write(MANIFEST_REL, "version = 1\nsources = [\"linked\"]\n");
        let snap = load(&tmp.0, Some(&tmp.trust_path())).snapshot;
        assert_eq!(
            snap.error.as_deref(),
            Some("sources: \"linked\": resolves outside the project root")
        );
    }

    // ── Rules and glossary ──

    fn rules_of(text: &str, checks: &[&str]) -> (Option<Vec<RailsRule>>, Vec<String>) {
        let known: HashSet<&str> = checks.iter().copied().collect();
        let mut warnings = Vec::new();
        let rules = extract_rules("docs/adr/0008-x.md", text, &known, &mut warnings);
        (rules, warnings)
    }

    #[test]
    fn rules_section_applies_to_continuation_and_marker() {
        let text = "# ADR 8\n\n## Decision\n\n- not a rail\n\n## Rails\n\n\
                    Applies to: `src/acp/**`, `src/ui/**`\n\n\
                    - A sealed row never repaints;\n  late state goes through `update()`.\n\
                    - No stylesheet uses `backdrop-filter: blur()`. `check:arch-tests`\n\
                    continued lazily\n\n\
                    Prose after a blank line is not part of a bullet.\n\
                    - Uses `check:nope`\n  - nested detail\n\
                    ```\n- fenced, ignored\n```\n\
                    - Last one\n\n## Consequences\n\n- not a rail either\n";
        let (rules, warnings) = rules_of(text, &["arch-tests"]);
        let rules = rules.expect("has a Rails section");
        let globs = vec!["src/acp/**".to_string(), "src/ui/**".to_string()];
        assert_eq!(
            rules,
            [
                RailsRule {
                    id: "docs/adr/0008-x.md#1".into(),
                    source: "docs/adr/0008-x.md".into(),
                    applies_to: globs.clone(),
                    check: None,
                    text: "A sealed row never repaints; late state goes through `update()`."
                        .into(),
                },
                RailsRule {
                    id: "docs/adr/0008-x.md#2".into(),
                    source: "docs/adr/0008-x.md".into(),
                    applies_to: globs.clone(),
                    check: None,
                    text: "No stylesheet uses `backdrop-filter: blur()`. `check:arch-tests` continued lazily".into(),
                },
                RailsRule {
                    id: "docs/adr/0008-x.md#3".into(),
                    source: "docs/adr/0008-x.md".into(),
                    applies_to: globs.clone(),
                    check: None,
                    text: "Uses `check:nope` - nested detail".into(),
                },
                RailsRule {
                    id: "docs/adr/0008-x.md#4".into(),
                    source: "docs/adr/0008-x.md".into(),
                    applies_to: globs,
                    check: None,
                    text: "Last one".into(),
                },
            ]
        );
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn rules_check_marker_known_and_unknown() {
        let text = "## Rails\n\n- No blur. `check:arch-tests`\n- Typed. `check:missing`\n- Plain\n";
        let (rules, warnings) = rules_of(text, &["arch-tests"]);
        let rules = rules.unwrap();
        assert_eq!(rules[0].text, "No blur.");
        assert_eq!(rules[0].check.as_deref(), Some("arch-tests"));
        assert_eq!(rules[1].text, "Typed.");
        assert_eq!(rules[1].check, None);
        assert_eq!(rules[2].check, None);
        assert!(rules.iter().all(|r| r.applies_to.is_empty()));
        assert_eq!(
            warnings,
            ["docs/adr/0008-x.md#2: unknown check \"missing\""]
        );
    }

    #[test]
    fn rules_absent_section_and_fenced_heading() {
        let (rules, _) = rules_of("# T\n\n```\n## Rails\n- fake\n```\n", &[]);
        assert_eq!(rules, None);
        let (rules, warnings) = rules_of("## Rails\n\nApplies to: src/**\n", &[]);
        assert_eq!(rules, Some(Vec::new()));
        assert_eq!(
            warnings,
            ["docs/adr/0008-x.md: \"Applies to:\" lists no backticked globs"]
        );
    }

    #[test]
    fn glossary_entries() {
        let text = "# Krypton\n\n## Language\n\n\
                    **Workspace**:\nA virtual desktop —\na full-screen arrangement.\n\
                    _Avoid_: desktop, screen\n\n\
                    **Window**:\nA DOM terminal.\n\
                    _Avoid_: pane (a pane is a split, inside a window), tab\n\
                    Trailing prose is not the definition.\n\n\
                    **Lane**: One ACP session.\n\n\
                    More text after a blank line.\n\n\
                    **Window**:\nDuplicate.\n";
        let mut warnings = Vec::new();
        let entries = extract_glossary("CONTEXT.md", text, &mut warnings);
        assert_eq!(
            entries,
            [
                GlossaryEntry {
                    id: "CONTEXT.md#Workspace".into(),
                    term: "Workspace".into(),
                    definition: "A virtual desktop — a full-screen arrangement.".into(),
                    avoid: vec!["desktop".into(), "screen".into()],
                },
                GlossaryEntry {
                    id: "CONTEXT.md#Window".into(),
                    term: "Window".into(),
                    definition: "A DOM terminal.".into(),
                    avoid: vec!["pane".into(), "tab".into()],
                },
                GlossaryEntry {
                    id: "CONTEXT.md#Lane".into(),
                    term: "Lane".into(),
                    definition: "One ACP session.".into(),
                    avoid: Vec::new(),
                },
            ]
        );
        assert_eq!(warnings, ["CONTEXT.md#Window: duplicate glossary term"]);
    }

    #[test]
    fn glossary_term_with_parenthetical_tag() {
        let text = "**Lesson** (spec 298):\nA rule a lane writes.\n_Avoid_: memory\n\n\
                    **Manual equip** (spec 129, legacy): Old opt-in.\n\n\
                    **Not a term** (no colon)\nprose\n";
        let mut warnings = Vec::new();
        let entries = extract_glossary("CONTEXT.md", text, &mut warnings);
        let terms: Vec<(&str, &str, &[String])> = entries
            .iter()
            .map(|e| (e.term.as_str(), e.definition.as_str(), e.avoid.as_slice()))
            .collect();
        assert_eq!(
            terms,
            [
                (
                    "Lesson",
                    "A rule a lane writes.",
                    &["memory".to_string()][..]
                ),
                ("Manual equip", "Old opt-in.", &[][..]),
            ]
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn load_missing_manifest_is_not_an_error() {
        let tmp = TempDir::new("missing");
        let snap = load(&tmp.0, Some(&tmp.trust_path())).snapshot;
        assert!(!snap.present);
        assert_eq!(snap.error, None);
        assert_eq!(snap.trust, Trust::Untrusted);
        assert_eq!(
            snap.manifest_path,
            tmp.0.join(".krypton/rails.toml").to_string_lossy()
        );
    }

    #[test]
    fn load_sources_uncovered_and_glossary() {
        let tmp = TempDir::new("load");
        tmp.write(
            MANIFEST_REL,
            "version = 1\nsources = [\"docs/adr\", \"AGENTS.md\", \"gone.md\"]\n\
             glossary = \"CONTEXT.md\"\nmystery = 1\n\n\
             [[check]]\nname = \"arch\"\nargv = [\"true\"]\n",
        );
        tmp.write("docs/adr/0002-b.md", "## Rails\n\n- Second. `check:arch`\n");
        tmp.write("docs/adr/0001-a.md", "## Rails\n\n- First\n");
        tmp.write("docs/adr/0003-none.md", "# No rails here\n");
        tmp.write("docs/adr/notes.txt", "## Rails\n\n- ignored\n");
        tmp.write("docs/adr/nested/0009.md", "## Rails\n\n- not recursive\n");
        tmp.write("AGENTS.md", "# Agents\n\n## Rails\n\n- Never commit\n");
        tmp.write("CONTEXT.md", "**Lane**:\nOne session.\n_Avoid_: agent\n");
        let snap = load(&tmp.0, Some(&tmp.trust_path())).snapshot;
        assert_eq!(snap.error, None);
        assert!(snap.present);
        let ids: Vec<&str> = snap.rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "docs/adr/0001-a.md#1",
                "docs/adr/0002-b.md#1",
                "AGENTS.md#1"
            ]
        );
        assert_eq!(snap.rules[1].check.as_deref(), Some("arch"));
        assert_eq!(snap.uncovered_sources, ["docs/adr/0003-none.md"]);
        assert_eq!(snap.glossary.len(), 1);
        assert_eq!(snap.glossary[0].id, "CONTEXT.md#Lane");
        assert_eq!(snap.checks.len(), 1);
        assert_eq!(
            snap.warnings,
            [
                "rails.toml: unknown key \"mystery\"",
                "sources: \"gone.md\" not found"
            ]
        );

        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["trust"], json!("untrusted"));
        assert_eq!(json["checks"][0]["timeoutS"], json!(300));
        assert_eq!(json["rules"][0]["appliesTo"], json!([]));
        assert_eq!(json["rules"][0]["check"], json!(null));
        assert_eq!(json["uncoveredSources"], json!(["docs/adr/0003-none.md"]));
        assert_eq!(json["error"], json!(null));
        assert!(json["manifestPath"].is_string());
    }

    #[test]
    fn load_reports_manifest_errors() {
        let tmp = TempDir::new("bad");
        tmp.write(MANIFEST_REL, "version = 3\nsources = [\"../x\"]\n");
        let snap = load(&tmp.0, Some(&tmp.trust_path())).snapshot;
        assert!(snap.present);
        assert_eq!(
            snap.error.as_deref(),
            Some(
                "rails.toml: version: must be 1; \
                 rails.toml: sources[0]: \"../x\" must stay inside the project root"
            )
        );
    }

    // ── Trust ──

    #[test]
    fn trust_untrusted_then_trusted_then_changed() {
        let tmp = TempDir::new("trust");
        let trust_path = tmp.trust_path();
        assert!(trust_manifest(&tmp.0, &trust_path)
            .unwrap_err()
            .starts_with("no .krypton/rails.toml"));

        tmp.write(MANIFEST_REL, "version = 1\nsources = []\n");
        assert_eq!(
            load(&tmp.0, Some(&trust_path)).snapshot.trust,
            Trust::Untrusted
        );
        assert_eq!(load(&tmp.0, None).snapshot.trust, Trust::Untrusted);

        let snap = trust_manifest(&tmp.0, &trust_path).unwrap();
        assert_eq!(snap.trust, Trust::Trusted);
        assert_eq!(
            load(&tmp.0, Some(&trust_path)).snapshot.trust,
            Trust::Trusted
        );
        let stored = std::fs::read_to_string(&trust_path).unwrap();
        assert!(stored.contains("[[project]]"), "{stored}");
        assert!(stored.contains(&sha256_hex(b"version = 1\nsources = []\n")));

        tmp.write(
            MANIFEST_REL,
            "version = 1\nsources = []\n[[check]]\nname = \"x\"\nargv = [\"rm\"]\n",
        );
        assert_eq!(
            load(&tmp.0, Some(&trust_path)).snapshot.trust,
            Trust::Changed
        );

        // Re-trusting replaces the root's entry instead of appending.
        trust_manifest(&tmp.0, &trust_path).unwrap();
        let store = read_trust_store(&trust_path).unwrap();
        assert_eq!(store.project.len(), 1);
        assert_eq!(
            load(&tmp.0, Some(&trust_path)).snapshot.trust,
            Trust::Trusted
        );

        tmp.write(MANIFEST_REL, "version = 2\n");
        assert!(trust_manifest(&tmp.0, &trust_path)
            .unwrap_err()
            .contains("version: must be 1"));
    }

    // ── Check runner ──

    fn sh(name: &str, script: &str) -> String {
        format!("[[check]]\nname = \"{name}\"\nargv = [\"sh\", \"-c\", {script:?}]\n")
    }

    fn trusted_project(name: &str, checks: &str) -> TempDir {
        let tmp = TempDir::new(name);
        tmp.write(
            MANIFEST_REL,
            &format!("version = 1\nsources = []\n{checks}"),
        );
        trust_manifest(&tmp.0, &tmp.trust_path()).unwrap();
        tmp
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn run_check_pass_fail_error_and_gates() {
        let tmp = trusted_project(
            "run",
            &format!(
                "{}{}[[check]]\nname = \"missing\"\nargv = [\"krypton-no-such-binary-337\"]\n",
                sh("ok", "echo out; echo err >&2; pwd"),
                sh("bad", "echo broken; exit 3"),
            ),
        );
        let state = RailsState::default();
        let trust = tmp.trust_path();

        let ok = run_check(&state, &tmp.0, Some(&trust), "ok").await.unwrap();
        assert_eq!(ok.name, "ok");
        assert_eq!(ok.outcome, CheckOutcome::Pass);
        assert_eq!(ok.exit_code, Some(0));
        assert_eq!(
            ok.output_tail,
            format!("out\nerr\n{}", tmp.0.display()),
            "stdout and stderr merged in order, cwd = root"
        );

        let bad = run_check(&state, &tmp.0, Some(&trust), "bad")
            .await
            .unwrap();
        assert_eq!(bad.outcome, CheckOutcome::Fail);
        assert_eq!(bad.exit_code, Some(3));
        assert_eq!(bad.output_tail, "broken");

        let missing = run_check(&state, &tmp.0, Some(&trust), "missing")
            .await
            .unwrap();
        assert_eq!(missing.outcome, CheckOutcome::Error);
        assert_eq!(missing.exit_code, None);
        assert!(
            missing.output_tail.contains("krypton-no-such-binary-337"),
            "{}",
            missing.output_tail
        );

        assert_eq!(
            run_check(&state, &tmp.0, Some(&trust), "nope")
                .await
                .unwrap_err(),
            "unknown check: nope"
        );

        // Busy while another check holds the root.
        let held = Flight::acquire(&state, &tmp.0).unwrap();
        assert_eq!(
            run_check(&state, &tmp.0, Some(&trust), "ok")
                .await
                .unwrap_err(),
            "busy"
        );
        drop(held);
        assert!(run_check(&state, &tmp.0, Some(&trust), "ok").await.is_ok());

        // An edited manifest is no longer trusted.
        tmp.write(
            MANIFEST_REL,
            &format!("version = 1\nsources = []\n{}", sh("ok", "true")),
        );
        assert_eq!(
            run_check(&state, &tmp.0, Some(&trust), "ok")
                .await
                .unwrap_err(),
            "untrusted"
        );
        assert_eq!(
            run_check(&state, &tmp.0, None, "ok").await.unwrap_err(),
            "untrusted"
        );
    }

    fn decl(script: &str) -> RailsCheckDecl {
        RailsCheckDecl {
            name: "t".into(),
            argv: vec!["sh".into(), "-c".into(), script.into()],
            timeout_s: 5,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn execute_times_out_and_kills_the_group() {
        let tmp = TempDir::new("timeout");
        let state = RailsState::default();
        let flight = Flight::acquire(&state, &tmp.0).unwrap();
        let begun = Instant::now();
        let result = execute(
            &flight,
            &tmp.0,
            &decl("echo started; sleep 30"),
            Duration::from_millis(400),
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(result.outcome, CheckOutcome::Timeout);
        assert_eq!(result.exit_code, None);
        assert_eq!(result.output_tail, "started\ntimed out after 0s");
        assert!(begun.elapsed() < Duration::from_secs(5));

        // A child ignoring SIGTERM is SIGKILLed after the delay.
        let begun = Instant::now();
        let result = execute(
            &flight,
            &tmp.0,
            &decl("trap '' TERM; while :; do sleep 1; done"),
            Duration::from_millis(300),
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(result.outcome, CheckOutcome::Timeout);
        assert!(begun.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn execute_does_not_wait_for_background_jobs() {
        let tmp = TempDir::new("background");
        let state = RailsState::default();
        let flight = Flight::acquire(&state, &tmp.0).unwrap();
        let begun = Instant::now();
        let result = execute(
            &flight,
            &tmp.0,
            &decl("sleep 30 & echo done"),
            Duration::from_secs(20),
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(result.outcome, CheckOutcome::Pass);
        assert_eq!(result.output_tail, "done");
        assert!(begun.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_stops_the_running_check() {
        let tmp = trusted_project("cancel", &sh("slow", "sleep 30"));
        let state = Arc::new(RailsState::default());
        let trust = tmp.trust_path();

        // Nothing runs: a no-op.
        cancel(&state, &tmp.0, Duration::from_millis(200));

        let bg_state = Arc::clone(&state);
        let bg_root = tmp.0.clone();
        let bg_trust = trust.clone();
        let run =
            tokio::spawn(
                async move { run_check(&bg_state, &bg_root, Some(&bg_trust), "slow").await },
            );
        let begun = Instant::now();
        while !state.lock().get(&tmp.0).is_some_and(|a| a.pgid.is_some()) {
            assert!(
                begun.elapsed() < Duration::from_secs(10),
                "check never started"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel(&state, &tmp.0, Duration::from_millis(200));
        assert_eq!(run.await.unwrap().unwrap_err(), "cancelled");
        assert!(begun.elapsed() < Duration::from_secs(10));
        assert!(state.lock().is_empty(), "slot released");
    }

    #[test]
    fn output_tail_keeps_last_lines_within_bytes() {
        let many: String = (1..=200).map(|i| format!("line {i}\r\n")).collect();
        let tail = output_tail(many.as_bytes());
        let lines: Vec<&str> = tail.lines().collect();
        assert_eq!(lines.len(), TAIL_LINES);
        assert_eq!(lines[0], "line 121");
        assert_eq!(lines[79], "line 200");
        assert!(!tail.contains('\r'));

        let wide = format!("{}\nend", "é".repeat(10_000));
        let tail = output_tail(wide.as_bytes());
        assert!(tail.len() <= TAIL_BYTES);
        assert!(tail.ends_with("é\nend"));

        let mut buf = Vec::new();
        for _ in 0..400 {
            push_rolling(&mut buf, &[b'x'; 8192]);
        }
        push_rolling(&mut buf, b"\nlast");
        assert!(buf.len() <= OUTPUT_CAP + OUTPUT_SLACK);
        assert_eq!(output_tail(&buf).lines().last(), Some("last"));
    }

    // ── Run ledger ──

    fn run_id(n: usize) -> String {
        format!("20261027T{:06}Z-{:04x}", n / 10, n % 10)
    }

    #[test]
    fn run_id_validation() {
        assert!(valid_run_id("20261027T140203Z-0a9f"));
        for bad in [
            "20261027T140203Z-0A9F",
            "20261027T140203Z-0a9",
            "20261027T140203-0a9f",
            "2026102T140203Z-0a9f",
            "20261027T140203Z-0a9fz",
            "../../etc/passwd",
        ] {
            assert!(!valid_run_id(bad), "{bad}");
        }
    }

    #[test]
    fn record_run_ignores_the_rails_dir_in_git() {
        let tmp = TempDir::new("gitignore");
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp.0)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8(out.stdout).unwrap()
        };
        git(&["init", "-q"]);
        record_run(&tmp.0, &json!({"runId": "20261027T140000Z-0001"})).unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.0.join(".krypton/rails/.gitignore")).unwrap(),
            "*\n!.gitignore\n"
        );
        // Only the ignore file itself stays visible (so it can be committed).
        assert_eq!(
            git(&["status", "--porcelain=v1", "--untracked-files=all"]),
            "?? .krypton/rails/.gitignore\n",
            "run records never reach git status"
        );

        // A project's own .gitignore is kept.
        std::fs::write(tmp.0.join(".krypton/rails/.gitignore"), "runs/\n").unwrap();
        record_run(&tmp.0, &json!({"runId": "20261027T150000Z-0002"})).unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.0.join(".krypton/rails/.gitignore")).unwrap(),
            "runs/\n"
        );
    }

    #[test]
    fn record_and_history() {
        let tmp = TempDir::new("ledger");
        assert!(history(&tmp.0, 20).is_empty(), "no runs dir yet");
        assert_eq!(
            record_run(&tmp.0, &json!({"verdict": "clean"})).unwrap_err(),
            "run.runId: required string"
        );
        assert!(record_run(&tmp.0, &json!({"runId": "../x"}))
            .unwrap_err()
            .contains("does not match"));
        assert!(record_run(&tmp.0, &json!(["not", "an", "object"])).is_err());

        let older = json!({"runId": "20261027T140000Z-0001", "verdict": "clean"});
        let newer = json!({"runId": "20261027T150000Z-0002", "verdict": "findings"});
        let path = record_run(&tmp.0, &newer).unwrap();
        record_run(&tmp.0, &older).unwrap();
        assert!(path.is_absolute());
        assert_eq!(
            path,
            tmp.0.join(".krypton/rails/runs/20261027T150000Z-0002.json")
        );
        let dir = runs_dir(&tmp.0);
        std::fs::write(dir.join("20261027T160000Z-0003.json"), "{ corrupt").unwrap();
        std::fs::write(dir.join("20261027T170000Z-0004.json"), "[1]").unwrap();
        std::fs::write(dir.join("notes.json"), "{}").unwrap();

        assert_eq!(history(&tmp.0, 20), [newer.clone(), older.clone()]);
        assert_eq!(history(&tmp.0, 1), vec![newer.clone()]);
        assert_eq!(history(&tmp.0, 0), [newer], "limit clamps to at least 1");
    }

    #[test]
    fn record_prunes_to_newest_200() {
        let tmp = TempDir::new("prune");
        for n in 0..205 {
            record_run(&tmp.0, &json!({"runId": run_id(n), "n": n})).unwrap();
        }
        let dir = runs_dir(&tmp.0);
        let names = run_files(&dir);
        assert_eq!(names.len(), RUN_RETENTION);
        assert_eq!(names[0], format!("{}.json", run_id(204)));
        assert_eq!(names[199], format!("{}.json", run_id(5)));
        assert!(!dir.join(format!("{}.json", run_id(4))).exists());
        let all = history(&tmp.0, 500);
        assert_eq!(all.len(), 200);
        assert_eq!(all[0]["n"], json!(204));
    }
}
