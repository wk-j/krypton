// Krypton — Xenon publisher (spec 212).
//
// Collects the resources the ACP Harness has produced on this machine and
// pushes them to a Xenon server with the three-step content-addressed protocol
// (manifest → missing blobs → commit).
//
// Publishing is deliberately explicit. `.krypton/` is gitignored working
// knowledge that can contain source, absolute paths, and secrets, so sending it
// to a server is *publishing*, not syncing — `#push` is a user action, and a
// secret pre-scan blocks a resource rather than leaking it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::XenonConfig;
use crate::git;

const KEYRING_SERVICE: &str = "com.krypton.xenon";
const REQUEST_TIMEOUT_SECS: u64 = 60;
/// spec 213: the link probe runs on a timer behind a status segment, so it must
/// fail fast. A push may legitimately take a minute; "is the link up?" may not.
const PROBE_TIMEOUT_SECS: u64 = 5;
/// Matches the server's default; a larger file is reported as failed rather
/// than attempted.
const MAX_BLOB_BYTES: u64 = 64 * 1024 * 1024;
const QUEUE_FILE: &str = "xenon-queue.json";

pub const KINDS: [&str; 6] = [
    "artifact",
    "review",
    "analysis",
    "doc",
    "attention",
    "daily",
];

// ------------------------------------------------------------------- types

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceManifest {
    pub kind: String,
    pub slug: String,
    pub title: String,
    pub origin: serde_json::Value,
    pub meta: serde_json::Value,
    pub files: Vec<FileEntry>,
}

/// One resource ready to push: the manifest plus where each file's bytes live.
#[derive(Debug, Clone)]
pub struct LocalResource {
    pub manifest: ResourceManifest,
    /// Bundle-relative path → absolute path on disk. Empty for `attention`.
    pub sources: BTreeMap<String, PathBuf>,
    /// Bytes held in memory instead of on disk (a redacted artifact, or an
    /// attention record synthesised by the frontend).
    pub inline: BTreeMap<String, Vec<u8>>,
}

#[derive(Debug, Deserialize)]
struct ManifestAck {
    resource_id: String,
    revision_id: Option<String>,
    #[serde(default)]
    missing: Vec<String>,
    #[serde(default)]
    unchanged: bool,
    #[serde(default)]
    url: String,
}

#[derive(Debug, Deserialize)]
struct CommitAck {
    #[serde(default)]
    url: String,
}

#[derive(Debug, Deserialize)]
struct ServerError {
    #[serde(default)]
    error: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum PushOutcome {
    Pushed { url: String, uploaded: usize },
    Unchanged { url: String },
    Blocked { reason: String },
    Failed { reason: String, retryable: bool },
}

#[derive(Debug, Clone, Serialize)]
pub struct PushItem {
    pub kind: String,
    pub slug: String,
    pub title: String,
    #[serde(flatten)]
    pub outcome: PushOutcome,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PushReport {
    pub pushed: usize,
    pub unchanged: usize,
    pub blocked: usize,
    pub failed: usize,
    pub queued: usize,
    pub items: Vec<PushItem>,
    pub base_url: String,
    pub project: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XenonStatus {
    pub enabled: bool,
    pub configured: bool,
    pub base_url: String,
    pub project: String,
    pub token: &'static str,
    pub queued: usize,
    pub auto_push: Vec<String>,
}

/// spec 213: what one authenticated probe learned about the link. Deliberately
/// a closed four-state set rather than free text — the footer segment has room
/// for a colour and a word, and a fixed set is what a human can learn to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    /// The server answered an authenticated request.
    Linked,
    /// The server could not be reached, or could not answer (5xx).
    Offline,
    /// The server is up and rejected our credential — or we have none.
    Unauthorized,
    /// Xenon is switched off or unconfigured. Not a fault; the segment hides.
    Off,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReport {
    pub state: LinkState,
    pub base_url: String,
    pub project: String,
    /// Human-readable cause for a non-linked state; `None` when linked.
    pub detail: Option<String>,
    pub latency_ms: Option<u64>,
    /// Unix seconds; when the probe ran.
    pub checked_at: i64,
}

// ------------------------------------------------------------------ secrets

/// Patterns that must never leave the machine inside a published bundle.
///
/// This is a guard rail, not a guarantee — it catches the credential shapes that
/// actually show up in agent transcripts and config dumps. `--force` exists
/// because a human who has looked at the hit is a better judge than a regex.
fn scan_for_secrets(text: &str) -> Option<String> {
    for (number, line) in text.lines().enumerate() {
        let lower = line.to_ascii_lowercase();
        let hit = if line.contains("AKIA")
            && line.chars().filter(|c| c.is_ascii_uppercase()).count() >= 16
        {
            Some("an AWS access key id")
        } else if lower.contains("-----begin") && lower.contains("private key") {
            Some("a private key block")
        } else if has_prefixed_secret(line, &["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], 36) {
            Some("a GitHub token")
        } else if has_prefixed_secret(line, &["xen_"], 20) {
            Some("a Xenon API token")
        } else if has_prefixed_secret(line, &["sk-ant-", "sk-"], 24) {
            Some("an API key")
        } else if assigned_long_opaque_value(&lower, line) {
            Some("a credential assignment")
        } else {
            None
        };
        if let Some(what) = hit {
            return Some(format!("line {}: looks like {what}", number + 1));
        }
    }
    None
}

fn has_prefixed_secret(line: &str, prefixes: &[&str], min_len: usize) -> bool {
    for prefix in prefixes {
        let mut rest = line;
        while let Some(at) = rest.find(prefix) {
            let tail = &rest[at + prefix.len()..];
            let run = tail
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .count();
            if prefix.len() + run >= min_len {
                return true;
            }
            rest = &rest[at + prefix.len()..];
        }
    }
    false
}

/// `token = "…"` / `api_key: …` with a long opaque value. Placeholders and
/// obvious redactions are ignored so a spec that documents a config key does
/// not trip the scan.
fn assigned_long_opaque_value(lower: &str, raw: &str) -> bool {
    const NAMES: [&str; 6] = [
        "token",
        "secret",
        "password",
        "api_key",
        "apikey",
        "access_key",
    ];
    if !NAMES.iter().any(|n| lower.contains(n)) {
        return false;
    }
    let Some(separator) = raw.find(['=', ':']) else {
        return false;
    };
    let value = raw[separator + 1..]
        .trim()
        .trim_matches(['"', '\'', ','])
        .trim();
    if value.len() < 24 {
        return false;
    }
    let placeholder = value.contains("...")
        || value.contains('<')
        || value.contains("xxx")
        || value.contains("XXX")
        || value.contains("your-")
        || value.contains("REDACTED")
        || value.contains("{{");
    if placeholder {
        return false;
    }
    // Opaque = no whitespace and a healthy mix of characters, which is what
    // distinguishes a real credential from a sentence about one.
    !value.contains(char::is_whitespace)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./+=".contains(c))
        && value.chars().any(|c| c.is_ascii_digit())
}

/// Artifacts bake a loopback feedback capability into their HTML. It is inert
/// off-box, but it is still a capability string, so it never gets published.
pub fn redact_artifact_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find("window.__KRYPTON_FEEDBACK__") {
        let line_start = rest[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let line_end = rest[at..].find('\n').map(|i| at + i).unwrap_or(rest.len());
        out.push_str(&rest[..line_start]);
        out.push_str("  window.__KRYPTON_FEEDBACK__ = null; // redacted before publishing\n");
        rest = &rest[(line_end + 1).min(rest.len())..];
    }
    out.push_str(rest);
    out
}

// ------------------------------------------------------------------- config

pub fn keyring_entry(base_url: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, base_url)
        .map_err(|e| format!("open operating-system credential vault: {e}"))
}

pub fn load_token(base_url: &str) -> Result<Option<String>, String> {
    match keyring_entry(base_url)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("read Xenon credential: {e}")),
    }
}

/// spec 213: process-lifetime token cache for the *probe* path only, keyed by
/// `base_url`. `load_token` opens an OS credential-vault entry on every call; a
/// 60-second probe would do that ~60×/hour to learn a value that changes about
/// once a year. The push path deliberately keeps using the uncached
/// `load_token`, so a publish never acts on a stale credential.
static TOKEN_CACHE: std::sync::RwLock<Option<(String, String)>> = std::sync::RwLock::new(None);

fn load_token_cached(base_url: &str) -> Result<Option<String>, String> {
    if let Ok(cache) = TOKEN_CACHE.read() {
        if let Some((url, token)) = cache.as_ref() {
            if url == base_url {
                return Ok(Some(token.clone()));
            }
        }
    }
    let token = load_token(base_url)?;
    if let Some(token) = &token {
        if let Ok(mut cache) = TOKEN_CACHE.write() {
            *cache = Some((base_url.to_string(), token.clone()));
        }
    }
    Ok(token)
}

/// Drop the cached probe token. Called after the vault is written, so a freshly
/// stored token is used by the very next probe instead of a minute later.
pub fn clear_token_cache() {
    if let Ok(mut cache) = TOKEN_CACHE.write() {
        *cache = None;
    }
}

pub fn store_token(base_url: &str, token: &str) -> Result<(), String> {
    clear_token_cache();
    let entry = keyring_entry(base_url)?;
    if token.trim().is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("clear Xenon credential: {e}")),
        };
    }
    entry
        .set_password(token.trim())
        .map_err(|e| format!("store Xenon credential: {e}"))
}

pub fn normalize_base_url(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// Project slug: `<owner>.<repo>` from the git remote when there is one, else a
/// path-derived fallback. A single path segment, because the server addresses
/// projects with one.
pub fn derive_project(cwd: &Path, configured: &str) -> String {
    let configured = configured.trim();
    if !configured.is_empty() {
        return sanitize_segment(configured);
    }
    if let Some(remote) = git::run_git(cwd, &["remote", "get-url", "origin"]) {
        if let Some(slug) = slug_from_remote(remote.trim()) {
            return slug;
        }
    }
    let name = cwd
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let digest = sha256_hex(cwd.to_string_lossy().as_bytes());
    sanitize_segment(&format!("local.{name}-{}", &digest[..8]))
}

fn slug_from_remote(remote: &str) -> Option<String> {
    let trimmed = remote.trim_end_matches('/').trim_end_matches(".git");
    // Handles both `git@host:owner/repo` and `https://host/owner/repo`.
    let tail = trimmed.rsplit_once(':').map(|(_, t)| t).unwrap_or(trimmed);
    let parts: Vec<&str> = tail.rsplit('/').take(2).collect();
    if parts.len() < 2 {
        return None;
    }
    let (repo, owner) = (parts[0], parts[1]);
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(sanitize_segment(&format!("{owner}.{repo}")))
}

fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.chars().take(128).collect()
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn content_type_for(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    let kind = if lower.ends_with(".md") {
        "text/markdown; charset=utf-8"
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".txt") || lower.ends_with(".log") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    };
    kind.to_string()
}

// --------------------------------------------------------------- collection

/// Walks `.krypton/` (and, for `doc`, the repo's markdown) and builds one
/// `LocalResource` per publishable thing.
/// `daily_dir` is resolved by the caller because it comes from
/// `[daily_note].output_dir`, which may point outside the project entirely (a
/// real Obsidian vault) — config access lives with the command, not here.
pub fn collect(
    cwd: &Path,
    kind: &str,
    slug_filter: Option<&str>,
    daily_dir: &Path,
) -> Result<Vec<LocalResource>, String> {
    let mut found = match kind {
        "review" => collect_bundles(cwd, "reviews", "review", 1)?,
        "analysis" => collect_bundles(cwd, "analyses", "analysis", 3)?,
        "artifact" => collect_artifacts(cwd)?,
        "doc" => collect_docs(cwd)?,
        "daily" => collect_daily(cwd, daily_dir)?,
        "attention" => Vec::new(), // supplied by the frontend, never read from disk
        other => return Err(format!("unknown resource kind: {other}")),
    };
    if let Some(want) = slug_filter {
        found.retain(|r| r.manifest.slug == want);
        // Naming a day that has no note is a typo or an un-rendered day, not an
        // empty push. Say so instead of reporting a successful no-op.
        if kind == "daily" && found.is_empty() {
            return Err(format!(
                "no daily note for {want}; render it first with `#daily {want}`"
            ));
        }
    }
    Ok(found)
}

/// Bundle kinds are directories at a fixed depth under `.krypton/<root>/`:
/// reviews are one level deep (`<date>-<slug>/`), analyses three
/// (`<owner>/<repo>/<number>/`).
fn collect_bundles(
    cwd: &Path,
    root: &str,
    kind: &str,
    depth: usize,
) -> Result<Vec<LocalResource>, String> {
    let base = cwd.join(".krypton").join(root);
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for dir in bundle_dirs(&base, depth) {
        let Ok(rel) = dir.strip_prefix(&base) else {
            continue;
        };
        let slug = rel.to_string_lossy().replace('\\', "/");
        if slug.is_empty() {
            continue;
        }

        let mut sources = BTreeMap::new();
        collect_files_under(&dir, &dir, &mut sources);
        if sources.is_empty() {
            continue;
        }

        let title = bundle_title(&sources).unwrap_or_else(|| slug.clone());
        out.push(LocalResource {
            manifest: ResourceManifest {
                kind: kind.to_string(),
                slug,
                title,
                origin: origin_value(cwd),
                meta: serde_json::json!({ "source": format!(".krypton/{root}") }),
                files: Vec::new(),
            },
            sources,
            inline: BTreeMap::new(),
        });
    }
    Ok(out)
}

fn bundle_dirs(base: &Path, depth: usize) -> Vec<PathBuf> {
    let mut level = vec![base.to_path_buf()];
    for _ in 0..depth {
        let mut next = Vec::new();
        for dir in level {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                // `.krypton/` is gitignored, so a plain read_dir is correct
                // here — an ignore-aware walker would filter the whole tree out.
                if path.is_dir() && !is_hidden(&path) {
                    next.push(path);
                }
            }
        }
        level = next;
    }
    level.sort();
    level
}

fn collect_files_under(root: &Path, dir: &Path, out: &mut BTreeMap<String, PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_hidden(&path) {
            continue;
        }
        if path.is_dir() {
            collect_files_under(root, &path, out);
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.insert(rel.to_string_lossy().replace('\\', "/"), path.clone());
            }
        }
    }
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

/// Prefers the bundle's own frontmatter/heading over the directory name.
fn bundle_title(sources: &BTreeMap<String, PathBuf>) -> Option<String> {
    let preferred = ["review.md", "root-cause.md"];
    let first_md = sources.keys().find(|k| k.ends_with(".md")).cloned();
    let pick = preferred
        .iter()
        .find(|name| sources.contains_key(**name))
        .map(|n| n.to_string())
        .or(first_md)?;
    let text = std::fs::read_to_string(sources.get(&pick)?).ok()?;
    title_from_markdown(&text)
}

pub fn title_from_markdown(text: &str) -> Option<String> {
    let mut in_frontmatter = false;
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if index == 0 && trimmed == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("title:") {
                let value = rest.trim().trim_matches(['"', '\'']).trim();
                if !value.is_empty() {
                    return Some(value.chars().take(300).collect());
                }
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let value = rest.trim();
            if !value.is_empty() {
                return Some(value.chars().take(300).collect());
            }
        }
    }
    None
}

/// Artifacts are single HTML files at `.krypton/artifacts/<harness>/<lane>/<id>.html`.
/// The slug keeps that shape so the same artifact from the same lane updates in
/// place rather than accumulating duplicates.
fn collect_artifacts(cwd: &Path) -> Result<Vec<LocalResource>, String> {
    let base = cwd.join(".krypton").join("artifacts");
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = BTreeMap::new();
    collect_files_under(&base, &base, &mut files);

    let mut out = Vec::new();
    for (rel, path) in files {
        if !rel.ends_with(".html") {
            continue;
        }
        let Ok(html) = std::fs::read_to_string(&path) else {
            continue;
        };
        let redacted = redact_artifact_html(&html);
        let title = artifact_title(&redacted).unwrap_or_else(|| rel.clone());
        let lane = rel.split('/').nth(1).unwrap_or("").to_string();

        let mut inline = BTreeMap::new();
        inline.insert("artifact.html".to_string(), redacted.into_bytes());

        out.push(LocalResource {
            manifest: ResourceManifest {
                kind: "artifact".to_string(),
                slug: rel.trim_end_matches(".html").to_string(),
                title,
                origin: origin_value(cwd),
                meta: serde_json::json!({ "lane": lane }),
                files: Vec::new(),
            },
            sources: BTreeMap::new(),
            inline,
        });
    }
    Ok(out)
}

fn artifact_title(html: &str) -> Option<String> {
    let start = html.find("<title>")? + "<title>".len();
    let end = html[start..].find("</title>")? + start;
    let raw = html[start..end].trim();
    let decoded = raw
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    (!decoded.is_empty()).then(|| decoded.chars().take(300).collect())
}

/// Repo markdown under `docs/`. Unlike the other kinds these are tracked in
/// git, so publishing them is a hosting convenience rather than durability.
fn collect_docs(cwd: &Path) -> Result<Vec<LocalResource>, String> {
    let base = cwd.join("docs");
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = BTreeMap::new();
    collect_files_under(&base, &base, &mut files);

    let mut out = Vec::new();
    for (rel, path) in files {
        if !rel.ends_with(".md") {
            continue;
        }
        let title = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| title_from_markdown(&text))
            .unwrap_or_else(|| rel.clone());
        let mut sources = BTreeMap::new();
        sources.insert(rel.clone(), path);
        out.push(LocalResource {
            manifest: ResourceManifest {
                kind: "doc".to_string(),
                slug: format!("docs/{rel}"),
                title,
                origin: origin_value(cwd),
                meta: serde_json::json!({ "source": "docs" }),
                files: Vec::new(),
            },
            sources,
            inline: BTreeMap::new(),
        });
    }
    Ok(out)
}

/// spec 225: one day, one resource, one file.
///
/// A day used to publish as a pair — `note.md` derived from records and an
/// optional `brief.md` reading of it — which put a file switcher in front of
/// every reader before any content. There is now a single document per day, so
/// the source is keyed `daily.md` and the reader lands on prose.
fn collect_daily(cwd: &Path, daily_dir: &Path) -> Result<Vec<LocalResource>, String> {
    if !daily_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for date in crate::journal::note_dates_in(daily_dir) {
        // Legacy shape only: spec 223 stepped a generated copy aside when the
        // human owned `<date>.md`. Nothing writes it now, but days already on
        // disk still carry it, and the machine's copy stays the published one.
        let generated = daily_dir.join(format!("{date}.generated.md"));
        let plain = daily_dir.join(format!("{date}.md"));
        let hand_edited = generated.is_file() && plain.is_file();
        let daily = if generated.is_file() {
            generated
        } else {
            plain
        };
        if !daily.is_file() {
            continue;
        }

        let text = std::fs::read_to_string(&daily).unwrap_or_default();
        let title = title_from_markdown(&text).unwrap_or_else(|| date.clone());
        // Who wrote it is stated by the file itself; a day with no marker was
        // written by hand and must not be labelled as ours.
        let author = generated_marker(&text).unwrap_or("human");

        let mut sources = BTreeMap::new();
        sources.insert("daily.md".to_string(), daily);

        out.push(LocalResource {
            manifest: ResourceManifest {
                kind: "daily".to_string(),
                slug: date.clone(),
                title,
                origin: origin_value(cwd),
                meta: serde_json::json!({
                    "source": daily_dir.to_string_lossy(),
                    "date": date,
                    "handEdited": hand_edited,
                    "author": author,
                }),
                files: Vec::new(),
            },
            sources,
            inline: BTreeMap::new(),
        });
    }
    Ok(out)
}

/// The value of `generated:` in a leading frontmatter block, if there is one.
fn generated_marker(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    rest[..end]
        .lines()
        .find_map(|l| l.strip_prefix("generated:"))
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// Attention flags live only in the frontend's `AttentionTriageStore`, so the
/// items arrive as JSON rather than being read from disk. Each becomes a
/// fileless resource whose whole payload is `meta`.
pub fn attention_resources(
    cwd: &Path,
    items: Vec<serde_json::Value>,
) -> Result<Vec<LocalResource>, String> {
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            return Err("attention item is missing an id".to_string());
        };
        let title = item
            .get("question")
            .and_then(|v| v.as_str())
            .filter(|q| !q.trim().is_empty())
            .map(|q| q.chars().take(300).collect::<String>())
            .unwrap_or_else(|| id.to_string());

        out.push(LocalResource {
            manifest: ResourceManifest {
                kind: "attention".to_string(),
                slug: id.to_string(),
                title,
                origin: origin_value(cwd),
                meta: item,
                files: Vec::new(),
            },
            sources: BTreeMap::new(),
            inline: BTreeMap::new(),
        });
    }
    Ok(out)
}

fn origin_value(cwd: &Path) -> serde_json::Value {
    serde_json::json!({
        "hostname": hostname::get().ok().and_then(|h| h.into_string().ok()),
        "project_dir": cwd.to_string_lossy(),
        "krypton_version": env!("CARGO_PKG_VERSION"),
    })
}

// ------------------------------------------------------------------- probe

/// Cache for `derive_project`, keyed by `(cwd, configured override)`. Deriving
/// the slug shells out to `git remote get-url`; on a 60-second timer that is a
/// subprocess a minute to learn a value that only changes when the remote does.
/// Same reasoning as [`TOKEN_CACHE`].
static PROJECT_CACHE: std::sync::RwLock<Option<(PathBuf, String, String)>> =
    std::sync::RwLock::new(None);

fn derive_project_cached(cwd: &Path, configured: &str) -> String {
    if let Ok(cache) = PROJECT_CACHE.read() {
        if let Some((cached_cwd, cached_cfg, project)) = cache.as_ref() {
            if cached_cwd == cwd && cached_cfg == configured {
                return project.clone();
            }
        }
    }
    let project = derive_project(cwd, configured);
    if let Ok(mut cache) = PROJECT_CACHE.write() {
        *cache = Some((cwd.to_path_buf(), configured.to_string(), project.clone()));
    }
    project
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// spec 213: one authenticated `GET /v1/projects`, mapped to a link state.
///
/// The server's `/healthz` cannot see the bearer token, so a probe against it
/// would report green while a revoked credential silently blocked every push.
/// The authenticated route answers both questions with one request: the server
/// returns 401 for a credential that is present and bad rather than degrading
/// to an anonymous request, while a server that is down fails at the transport
/// layer before any status exists.
///
/// Never returns an error: an unconfigured backend is [`LinkState::Off`], not a
/// failure, and a probe that cannot run is itself the answer.
pub async fn probe(config: &XenonConfig, cwd: &Path) -> LinkReport {
    let base_url = normalize_base_url(&config.base_url);
    let project = derive_project_cached(cwd, config.project.trim());
    let report = |state: LinkState, detail: Option<String>, latency_ms: Option<u64>| LinkReport {
        state,
        base_url: base_url.clone(),
        project: project.clone(),
        detail,
        latency_ms,
        checked_at: unix_now(),
    };

    if !config.enabled || base_url.is_empty() {
        return report(LinkState::Off, None, None);
    }

    // No stored credential is reported without issuing a request: "never set
    // up" and "rejected" both block every push, but they have different fixes.
    let token = match load_token_cached(&base_url) {
        Ok(Some(token)) => token,
        Ok(None) => {
            return report(
                LinkState::Unauthorized,
                Some("no token stored".to_string()),
                None,
            )
        }
        Err(e) => return report(LinkState::Unauthorized, Some(e), None),
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(PROBE_TIMEOUT_SECS))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            return report(
                LinkState::Offline,
                Some(format!("build http client: {e}")),
                None,
            )
        }
    };

    let started = std::time::Instant::now();
    let response = client
        .get(format!("{base_url}/v1/projects"))
        .bearer_auth(&token)
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis() as u64;

    match response {
        Err(e) => {
            let detail = if e.is_timeout() {
                format!("no answer within {PROBE_TIMEOUT_SECS}s")
            } else {
                format!("unreachable: {e}")
            };
            report(LinkState::Offline, Some(detail), Some(latency_ms))
        }
        Ok(response) if response.status().is_success() => {
            report(LinkState::Linked, None, Some(latency_ms))
        }
        Ok(response) => {
            let status = response.status();
            let detail = response
                .json::<ServerError>()
                .await
                .ok()
                .map(|e| {
                    if e.message.is_empty() {
                        e.error
                    } else {
                        e.message
                    }
                })
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| status.to_string());
            // A server that answers 5xx is up but cannot be published over,
            // which is the same practical state as unreachable.
            let state = if status.as_u16() == 401 || status.as_u16() == 403 {
                LinkState::Unauthorized
            } else {
                LinkState::Offline
            };
            report(state, Some(detail), Some(latency_ms))
        }
    }
}

// -------------------------------------------------------------------- push

pub struct Publisher {
    client: reqwest::Client,
    base_url: String,
    token: String,
    project: String,
    force: bool,
}

impl Publisher {
    pub fn new(config: &XenonConfig, cwd: &Path, force: bool) -> Result<Self, String> {
        if !config.enabled {
            return Err("Xenon is disabled — set [xenon].enabled = true".to_string());
        }
        let base_url = normalize_base_url(&config.base_url);
        if base_url.is_empty() {
            return Err("Xenon is not configured — set [xenon].base_url".to_string());
        }
        let Some(token) = load_token(&base_url)? else {
            return Err(format!(
                "no Xenon token stored for {base_url} — mint one at {base_url}/settings/tokens"
            ));
        };
        Self::with_token(
            &base_url,
            &token,
            &derive_project(cwd, &config.project),
            force,
        )
    }

    /// Construct without touching the OS credential vault. Used by the live
    /// wire-compatibility test, which must not prompt for keychain access.
    pub fn with_token(
        base_url: &str,
        token: &str,
        project: &str,
        force: bool,
    ) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("build http client: {e}"))?;

        Ok(Self {
            client,
            base_url: normalize_base_url(base_url),
            token: token.to_string(),
            project: project.to_string(),
            force,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn project(&self) -> &str {
        &self.project
    }

    pub async fn push_resource(&self, mut resource: LocalResource) -> PushItem {
        let (kind, slug, title) = (
            resource.manifest.kind.clone(),
            resource.manifest.slug.clone(),
            resource.manifest.title.clone(),
        );
        let outcome = match self.push_inner(&mut resource).await {
            Ok(outcome) => outcome,
            Err(failure) => failure,
        };
        PushItem {
            kind,
            slug,
            title,
            outcome,
        }
    }

    async fn push_inner(&self, resource: &mut LocalResource) -> Result<PushOutcome, PushOutcome> {
        // 1. Read every body and hash it, scanning text as we go. Nothing
        //    leaves the machine until the whole resource is cleared.
        let mut bodies: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for (rel, path) in &resource.sources {
            let bytes = std::fs::read(path).map_err(|e| PushOutcome::Failed {
                reason: format!("read {}: {e}", path.display()),
                retryable: false,
            })?;
            bodies.insert(rel.clone(), bytes);
        }
        for (rel, bytes) in &resource.inline {
            bodies.insert(rel.clone(), bytes.clone());
        }

        let mut files = Vec::new();
        for (rel, bytes) in &bodies {
            if bytes.len() as u64 > MAX_BLOB_BYTES {
                return Err(PushOutcome::Failed {
                    reason: format!("{rel} is larger than the {MAX_BLOB_BYTES} byte limit"),
                    retryable: false,
                });
            }
            if !self.force {
                if let Ok(text) = std::str::from_utf8(bytes) {
                    if let Some(hit) = scan_for_secrets(text) {
                        return Ok(PushOutcome::Blocked {
                            reason: format!("{rel} {hit} — review it, then re-run with --force"),
                        });
                    }
                }
            }
            files.push(FileEntry {
                path: rel.clone(),
                sha256: sha256_hex(bytes),
                size: bytes.len() as u64,
                content_type: content_type_for(rel),
            });
        }
        resource.manifest.files = files;

        // `meta` is the whole payload for a fileless kind — an attention flag
        // carries its question, rationale, and trade-offs there and has no files
        // at all, so the loop above scans nothing. Without this, the one kind
        // that is pushed automatically would be the one kind never checked.
        if !self.force && !resource.manifest.meta.is_null() {
            let meta_text = resource.manifest.meta.to_string();
            if let Some(hit) = scan_for_secrets(&meta_text) {
                return Ok(PushOutcome::Blocked {
                    reason: format!("meta {hit} — review it, then re-run with --force"),
                });
            }
        }

        // 2. Manifest — the server replies with only the digests it lacks.
        let ack: ManifestAck = self
            .post_json(
                &format!("/v1/projects/{}/resources", self.project),
                &resource.manifest,
            )
            .await?;
        if ack.unchanged {
            return Ok(PushOutcome::Unchanged {
                url: self.absolute(&ack.url),
            });
        }
        let Some(revision_id) = ack.revision_id else {
            return Err(PushOutcome::Failed {
                reason: "server opened no revision".to_string(),
                retryable: true,
            });
        };

        // 3. Upload only what is missing.
        let mut uploaded = 0usize;
        for digest in &ack.missing {
            let Some((_, bytes)) = bodies.iter().find(|(rel, _)| {
                resource
                    .manifest
                    .files
                    .iter()
                    .any(|f| &f.path == *rel && &f.sha256 == digest)
            }) else {
                return Err(PushOutcome::Failed {
                    reason: format!("server asked for an unknown digest {digest}"),
                    retryable: false,
                });
            };
            self.put_blob(digest, bytes).await?;
            uploaded += 1;
        }

        // 4. Seal.
        let commit: CommitAck = self
            .post_json(
                &format!("/v1/revisions/{revision_id}/commit"),
                &serde_json::json!({}),
            )
            .await?;
        let url = if commit.url.is_empty() {
            ack.resource_id.clone()
        } else {
            commit.url
        };
        Ok(PushOutcome::Pushed {
            url: self.absolute(&url),
            uploaded,
        })
    }

    async fn post_json<B: Serialize, T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, PushOutcome> {
        let response = self
            .client
            .post(format!("{}{path}", self.base_url))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(|e| PushOutcome::Failed {
                reason: format!("connect: {e}"),
                retryable: true,
            })?;
        self.decode(response).await
    }

    async fn put_blob(&self, digest: &str, bytes: &[u8]) -> Result<(), PushOutcome> {
        let response = self
            .client
            .put(format!("{}/v1/blobs/{digest}", self.base_url))
            .bearer_auth(&self.token)
            .header("content-type", "application/octet-stream")
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| PushOutcome::Failed {
                reason: format!("upload {digest}: {e}"),
                retryable: true,
            })?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(self.error_outcome(response).await)
    }

    async fn decode<T: for<'de> Deserialize<'de>>(
        &self,
        response: reqwest::Response,
    ) -> Result<T, PushOutcome> {
        if !response.status().is_success() {
            return Err(self.error_outcome(response).await);
        }
        response.json::<T>().await.map_err(|e| PushOutcome::Failed {
            reason: format!("unreadable server response: {e}"),
            retryable: false,
        })
    }

    async fn error_outcome(&self, response: reqwest::Response) -> PushOutcome {
        let status = response.status();
        let parsed = response.json::<ServerError>().await.ok();
        let detail = parsed
            .map(|e| {
                if e.message.is_empty() {
                    e.error
                } else {
                    e.message
                }
            })
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| status.to_string());

        // An auth failure is never retryable: queuing it would retry a bad
        // credential forever instead of telling the human to fix it.
        let retryable = !matches!(status.as_u16(), 400..=499);
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return PushOutcome::Failed {
                reason: format!(
                    "{detail} — check your token at {}/settings/tokens",
                    self.base_url
                ),
                retryable: false,
            };
        }
        PushOutcome::Failed {
            reason: detail,
            retryable,
        }
    }

    fn absolute(&self, path: &str) -> String {
        if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{path}", self.base_url)
        }
    }
}

// ------------------------------------------------------------- retry queue

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QueueEntry {
    pub kind: String,
    pub slug: String,
    pub reason: String,
    pub queued_at: i64,
}

pub fn queue_path(cwd: &Path) -> PathBuf {
    cwd.join(".krypton").join(QUEUE_FILE)
}

pub fn read_queue(cwd: &Path) -> Vec<QueueEntry> {
    std::fs::read_to_string(queue_path(cwd))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<QueueEntry>>(&raw).ok())
        .unwrap_or_default()
}

pub fn write_queue(cwd: &Path, entries: &[QueueEntry]) -> Result<(), String> {
    let path = queue_path(cwd);
    if entries.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("clear xenon queue: {e}")),
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create .krypton: {e}"))?;
    }
    let body = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write xenon queue: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_urls_become_single_segment_project_slugs() {
        assert_eq!(
            slug_from_remote("https://github.com/wk-j/xenon.git").unwrap(),
            "wk-j.xenon"
        );
        assert_eq!(
            slug_from_remote("git@github.com:wk-j/krypton.git").unwrap(),
            "wk-j.krypton"
        );
        assert_eq!(
            slug_from_remote("https://github.com/wk-j/krypton/").unwrap(),
            "wk-j.krypton"
        );
        // A slug must never span two path segments — the server routes on one.
        assert!(!slug_from_remote("https://github.com/wk-j/krypton")
            .unwrap()
            .contains('/'));
    }

    #[test]
    fn configured_project_overrides_the_remote_and_is_sanitized() {
        let cwd = std::env::temp_dir();
        assert_eq!(derive_project(&cwd, "my/project"), "my-project");
        assert_eq!(derive_project(&cwd, "  spaced name "), "spaced-name");
    }

    #[test]
    fn path_fallback_is_stable_and_slash_free() {
        let cwd = PathBuf::from("/Users/wk/Source/krypton");
        let a = derive_project(&cwd, "");
        let b = derive_project(&cwd, "");
        assert_eq!(a, b, "the fallback must be stable across runs");
        assert!(!a.contains('/'));
    }

    #[test]
    fn secret_scan_catches_real_credential_shapes() {
        assert!(scan_for_secrets("token = ghp_abcdefghijklmnopqrstuvwxyz0123456789").is_some());
        assert!(scan_for_secrets("ANTHROPIC_KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa").is_some());
        assert!(scan_for_secrets("-----BEGIN RSA PRIVATE KEY-----").is_some());
        assert!(scan_for_secrets("aws: AKIAIOSFODNN7EXAMPLE1").is_some());
        assert!(scan_for_secrets("bearer xen_aaaaaaaaaaaa_bbbbbbbbbbbb").is_some());
        assert!(
            scan_for_secrets("api_key = a1b2c3d4e5f6g7h8i9j0k1l2m3n4").is_some(),
            "a long opaque assignment to a credential-shaped name should trip"
        );
    }

    /// An attention flag has no files, so the per-file scan sees nothing. Its
    /// whole payload is `meta`, and it is the one kind that publishes without
    /// the human asking — so it is the last place a credential should slip out.
    #[tokio::test]
    async fn an_attention_flag_with_a_credential_in_its_text_is_blocked() {
        let publisher = Publisher::with_token("http://127.0.0.1:1", "t", "p", false).unwrap();
        let resources = attention_resources(
            Path::new("/tmp"),
            vec![serde_json::json!({
                "id": "jdg-1",
                "question": "ควรเก็บ token ไว้ที่ไหน",
                "rationale": "ใช้ค่านี้ ghp_abcdefghijklmnopqrstuvwxyz0123456789 ไปก่อน",
            })],
        )
        .unwrap();
        let item = publisher
            .push_resource(resources.into_iter().next().unwrap())
            .await;
        match item.outcome {
            PushOutcome::Blocked { reason } => assert!(reason.contains("meta"), "{reason}"),
            other => panic!("a credential in meta must block the push, got {other:?}"),
        }
    }

    /// The scan must not fire on ordinary decision text, or the auto-push would
    /// block constantly and be turned off.
    #[tokio::test]
    async fn an_ordinary_attention_flag_is_not_blocked() {
        let publisher = Publisher::with_token("http://127.0.0.1:1", "t", "p", false).unwrap();
        let resources = attention_resources(
            Path::new("/tmp"),
            vec![serde_json::json!({
                "id": "jdg-2",
                "question": "ควรใช้ framework ฝั่งหน้าเว็บไหม",
                "chosen": "ไม่ใช้ เขียน JavaScript ธรรมดา",
                "reversibility": "reversible",
            })],
        )
        .unwrap();
        let item = publisher
            .push_resource(resources.into_iter().next().unwrap())
            .await;
        // No server is listening, so it must reach the network and fail there —
        // proving the scan let it through rather than blocking it.
        match item.outcome {
            PushOutcome::Failed { .. } => {}
            other => panic!("ordinary text must not be blocked, got {other:?}"),
        }
    }

    /// spec 213: a switched-off backend is not a fault. The probe must say so
    /// without a request and without a credential-vault read, because the
    /// footer hides the segment entirely in this state.
    #[tokio::test]
    async fn a_disabled_or_unconfigured_backend_probes_as_off() {
        let disabled = XenonConfig {
            enabled: false,
            base_url: "http://127.0.0.1:1".to_string(),
            ..Default::default()
        };
        assert_eq!(
            probe(&disabled, Path::new("/tmp")).await.state,
            LinkState::Off
        );

        let no_url = XenonConfig {
            enabled: true,
            base_url: String::new(),
            ..Default::default()
        };
        assert_eq!(
            probe(&no_url, Path::new("/tmp")).await.state,
            LinkState::Off
        );
    }

    /// A server that cannot be reached is `Offline`, and the probe reads its
    /// token from the process cache — seeding it here is what keeps this test
    /// from prompting for keychain access.
    #[tokio::test]
    async fn an_unreachable_server_probes_as_offline() {
        let base_url = "http://127.0.0.1:1";
        *TOKEN_CACHE.write().unwrap() = Some((base_url.to_string(), "t".to_string()));
        let config = XenonConfig {
            enabled: true,
            base_url: base_url.to_string(),
            project: "probe-test".to_string(),
            ..Default::default()
        };

        let report = probe(&config, Path::new("/tmp")).await;

        assert_eq!(report.state, LinkState::Offline);
        assert_eq!(report.project, "probe-test");
        assert!(report.detail.is_some(), "a fault state must carry a cause");
        clear_token_cache();
    }

    #[test]
    fn secret_scan_does_not_trip_on_documentation() {
        // Specs and READMEs talk about tokens constantly; a false positive here
        // would block every doc push and train the user to always --force.
        assert!(scan_for_secrets("The bearer token is never stored in TOML.").is_none());
        assert!(scan_for_secrets("token = \"<your-token-here>\"").is_none());
        assert!(scan_for_secrets("api_key = \"...\"").is_none());
        assert!(scan_for_secrets("password: REDACTED").is_none());
        assert!(scan_for_secrets("token: {{feedbackToken}}").is_none());
        assert!(scan_for_secrets("| `XENON_SESSION_SECRET` | required, 32 chars |").is_none());
        assert!(scan_for_secrets("Set the secret to a random value before booting.").is_none());
    }

    #[test]
    fn artifact_feedback_capability_is_redacted() {
        let html = "<html>\n<script>\n  window.__KRYPTON_FEEDBACK__ = { token: \"abc123\", url: \"http://127.0.0.1:9\" };\n</script>\n<main>hi</main>\n</html>";
        let redacted = redact_artifact_html(html);
        assert!(
            !redacted.contains("abc123"),
            "the capability token must not survive: {redacted}"
        );
        assert!(!redacted.contains("127.0.0.1"));
        assert!(
            redacted.contains("<main>hi</main>"),
            "content must be preserved"
        );
        assert!(redacted.contains("__KRYPTON_FEEDBACK__ = null"));
    }

    #[test]
    fn redaction_is_a_no_op_for_artifacts_without_a_token() {
        let html = "<html><main>plain</main></html>";
        assert_eq!(redact_artifact_html(html), html);
    }

    #[test]
    fn titles_come_from_frontmatter_then_heading() {
        assert_eq!(
            title_from_markdown(
                "---\ntitle: Peering guard rewrite\nlane: Claude-2\n---\n# ignored\n"
            ),
            Some("Peering guard rewrite".to_string())
        );
        assert_eq!(
            title_from_markdown("# สาเหตุของ issue #12\n\nbody\n"),
            Some("สาเหตุของ issue #12".to_string())
        );
        assert_eq!(title_from_markdown("no title here\n"), None);
    }

    #[test]
    fn artifact_title_is_read_and_unescaped() {
        assert_eq!(
            artifact_title("<html><head><title>Diff &amp; review</title></head></html>"),
            Some("Diff & review".to_string())
        );
        assert_eq!(artifact_title("<html><head></head></html>"), None);
    }

    #[test]
    fn content_types_cover_the_kinds_we_publish() {
        assert!(content_type_for("review.md").starts_with("text/markdown"));
        assert!(content_type_for("art-10.html").starts_with("text/html"));
        assert_eq!(content_type_for("assets/diagram.png"), "image/png");
        assert_eq!(content_type_for("mystery.bin"), "application/octet-stream");
    }

    #[test]
    fn base_url_normalisation_strips_trailing_slashes() {
        assert_eq!(
            normalize_base_url(" https://x.example.com/ "),
            "https://x.example.com"
        );
        assert_eq!(normalize_base_url(""), "");
    }

    #[test]
    fn queue_round_trips_and_clears() {
        let dir = std::env::temp_dir().join(format!("krypton-xenon-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".krypton")).unwrap();

        assert!(read_queue(&dir).is_empty());
        let entries = vec![QueueEntry {
            kind: "review".into(),
            slug: "2026-08-07-x".into(),
            reason: "connect: timed out".into(),
            queued_at: 1,
        }];
        write_queue(&dir, &entries).unwrap();
        assert_eq!(read_queue(&dir).len(), 1);
        write_queue(&dir, &[]).unwrap();
        assert!(
            read_queue(&dir).is_empty(),
            "an empty queue removes the file"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// spec 225: a day is one resource holding one file, so a reader lands on
    /// prose instead of a file switcher.
    #[test]
    fn daily_collection_publishes_one_file_per_day() {
        let dir = std::env::temp_dir().join(format!("krypton-xenon-daily-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let journal = dir.join(".krypton/journal");
        std::fs::create_dir_all(&journal).unwrap();

        std::fs::write(
            journal.join("2026-08-15.md"),
            "---\ngenerated: lane-narration\n---\n\n# เสาร์ 15 สิงหาคม 2026\n\nbody\n",
        )
        .unwrap();
        // A leftover brief from spec 224 is not a day of its own any more.
        std::fs::write(journal.join("2026-08-15.brief.md"), "narration\n").unwrap();
        // A day someone wrote by hand still publishes, but is not credited to us.
        std::fs::write(journal.join("2026-08-14.md"), "# 2026-08-14\n").unwrap();
        // Neither the capture log nor a stray file is a day.
        std::fs::write(journal.join("2026-08-15.jsonl"), "{}").unwrap();
        std::fs::write(journal.join("notes.md"), "not a date\n").unwrap();

        let found = collect(&dir, "daily", None, &journal).unwrap();
        assert_eq!(found.len(), 2, "two days, newest first");
        assert_eq!(found[0].manifest.slug, "2026-08-15");
        assert_eq!(found[0].manifest.title, "เสาร์ 15 สิงหาคม 2026");
        assert_eq!(found[0].sources.len(), 1, "one file per day");
        assert!(found[0].sources.contains_key("daily.md"));
        assert!(!found[0].sources.contains_key("brief.md"));
        assert_eq!(found[0].manifest.meta["author"], "lane-narration");

        assert_eq!(found[1].manifest.slug, "2026-08-14");
        assert_eq!(found[1].manifest.meta["author"], "human");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Legacy shape: spec 223 stepped a generated copy aside from a hand-edited
    /// day. Nothing writes it now, but days already on disk still carry it.
    #[test]
    fn daily_collection_prefers_a_legacy_generated_copy_and_says_so() {
        let dir = std::env::temp_dir().join(format!("krypton-xenon-daily2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let journal = dir.join("journal");
        std::fs::create_dir_all(&journal).unwrap();
        std::fs::write(journal.join("2026-08-15.md"), "# hand written\n").unwrap();
        std::fs::write(
            journal.join("2026-08-15.generated.md"),
            "---\ngenerated: krypton-journal\n---\n\n# regenerated\n",
        )
        .unwrap();

        let found = collect(&dir, "daily", None, &journal).unwrap();
        assert_eq!(found.len(), 1, "both files are the same day");
        assert_eq!(found[0].manifest.title, "regenerated");
        assert_eq!(found[0].manifest.meta["handEdited"], true);
        assert!(found[0].sources["daily.md"].ends_with("2026-08-15.generated.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A leftover `<date>.brief.md` from spec 224 names no day on its own — it
    /// must not resurrect a day that has no document.
    #[test]
    fn daily_collection_ignores_an_orphan_legacy_brief() {
        let dir = std::env::temp_dir().join(format!("krypton-xenon-daily3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let journal = dir.join("journal");
        std::fs::create_dir_all(&journal).unwrap();
        std::fs::write(journal.join("2026-08-15.brief.md"), "narration only\n").unwrap();

        assert!(collect(&dir, "daily", None, &journal).unwrap().is_empty());

        // Naming a day that was never rendered is an error, not a silent no-op.
        let err = collect(&dir, "daily", Some("2026-08-15"), &journal).unwrap_err();
        assert!(err.contains("no daily note for 2026-08-15"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An unconfigured or absent journal directory is not an error.
    #[test]
    fn daily_collection_on_a_project_without_notes_is_empty() {
        let dir = std::env::temp_dir().join(format!("krypton-xenon-daily4-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(collect(&dir, "daily", None, &dir.join("nope"))
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_collection_finds_reviews_at_depth_one() {
        let dir =
            std::env::temp_dir().join(format!("krypton-xenon-bundles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bundle = dir.join(".krypton/reviews/2026-08-07-peering-guard");
        std::fs::create_dir_all(bundle.join("assets")).unwrap();
        std::fs::write(
            bundle.join("review.md"),
            "---\ntitle: Peering guard\n---\nbody\n",
        )
        .unwrap();
        std::fs::write(bundle.join("response.md"), "answers\n").unwrap();
        std::fs::write(bundle.join("assets/x.png"), [0u8, 1, 2]).unwrap();

        let found = collect(&dir, "review", None, &dir).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].manifest.slug, "2026-08-07-peering-guard");
        assert_eq!(found[0].manifest.title, "Peering guard");
        assert_eq!(found[0].sources.len(), 3, "nested assets are included");
        assert!(found[0].sources.contains_key("assets/x.png"));

        // A slug filter narrows to one bundle, and a miss yields nothing.
        assert_eq!(
            collect(&dir, "review", Some("2026-08-07-peering-guard"), &dir)
                .unwrap()
                .len(),
            1
        );
        assert!(collect(&dir, "review", Some("nope"), &dir)
            .unwrap()
            .is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn analysis_bundles_are_three_levels_deep() {
        let dir =
            std::env::temp_dir().join(format!("krypton-xenon-analysis-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bundle = dir.join(".krypton/analyses/wk-j/krypton/12");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("root-cause.md"), "# root cause\n").unwrap();

        let found = collect(&dir, "analysis", None, &dir).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].manifest.slug, "wk-j/krypton/12");
        assert_eq!(found[0].manifest.title, "root cause");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_directories_collect_to_nothing_rather_than_erroring() {
        let dir = std::env::temp_dir().join("krypton-xenon-absent");
        let _ = std::fs::remove_dir_all(&dir);
        for kind in KINDS {
            assert!(
                collect(&dir, kind, None, &dir).unwrap().is_empty(),
                "{kind} should be empty"
            );
        }
        assert!(collect(&dir, "nonsense", None, &dir).is_err());
    }
}
