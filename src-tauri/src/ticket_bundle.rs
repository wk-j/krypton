//! Project-local ticket bundles (spec 238).
//!
//! Rust owns every filesystem boundary. The frontend supplies a harness id and
//! a one-segment ticket id; the project root always comes from `HookServer`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::hook_server::HookServer;

const SCHEMA_VERSION: u8 = 1;
const MAX_RESOURCE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_EXCERPT_CHARS: usize = 320;
const MAX_PROGRESS_CHARS: usize = 500;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalTicketStatus {
    Todo,
    InProgress,
    Blocked,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTicketReference {
    pub issue_key: String,
    pub issue_url: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    pub fetched_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketMetadata {
    pub schema_version: u8,
    pub id: String,
    pub title: String,
    pub status: LocalTicketStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub context_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_progress_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_progress_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github: Option<GithubTicketReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketResource {
    pub name: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketAnalysisSummary {
    pub relative_path: String,
    pub markdown_count: usize,
    pub attachment_count: usize,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketBundleSummary {
    #[serde(flatten)]
    pub metadata: TicketMetadata,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_excerpt: Option<String>,
    pub resource_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis: Option<TicketAnalysisSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketBundleDetail {
    #[serde(flatten)]
    pub summary: TicketBundleSummary,
    pub context_markdown: String,
    pub resources: Vec<TicketResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketWorkerBinding {
    pub ticket_id: String,
    pub lane_id: String,
    pub lane_display_name: String,
    pub assigned_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn ticket_root(project_dir: &Path) -> PathBuf {
    project_dir.join(".krypton").join("tickets")
}

fn validate_ticket_id(ticket_id: &str) -> Result<(), String> {
    if ticket_id.is_empty()
        || ticket_id.len() > 80
        || !ticket_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-')
    {
        return Err("ticket_id must contain only ASCII letters, numbers, and hyphens".to_string());
    }
    Ok(())
}

fn bundle_dir(project_dir: &Path, ticket_id: &str) -> Result<PathBuf, String> {
    validate_ticket_id(ticket_id)?;
    Ok(ticket_root(project_dir).join(ticket_id))
}

fn atomic_write_json(path: &Path, value: &TicketMetadata) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "ticket metadata path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create ticket directory: {error}"))?;
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".ticket-{}-{sequence}.json.tmp", now_ms()));
    let body = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize ticket metadata: {error}"))?;
    fs::write(&tmp, format!("{body}\n"))
        .map_err(|error| format!("failed to write ticket metadata: {error}"))?;
    fs::rename(&tmp, path)
        .map_err(|error| format!("failed to replace ticket metadata: {error}"))?;
    Ok(())
}

fn read_metadata(dir: &Path) -> Result<TicketMetadata, String> {
    let path = dir.join("ticket.json");
    let body = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let metadata: TicketMetadata = serde_json::from_str(&body)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
    validate_ticket_id(&metadata.id)?;
    if metadata.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported ticket schema version {}",
            metadata.schema_version
        ));
    }
    Ok(metadata)
}

fn context_excerpt(markdown: &str) -> Option<String> {
    let candidate = markdown
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))?;
    let collapsed = candidate.split_whitespace().collect::<Vec<_>>().join(" ");
    let excerpt: String = collapsed.chars().take(MAX_EXCERPT_CHARS).collect();
    (!excerpt.is_empty()).then_some(excerpt)
}

fn scan_resources(dir: &Path, ticket_id: &str) -> Result<Vec<TicketResource>, String> {
    let resources_dir = dir.join("resources");
    if !resources_dir.exists() {
        return Ok(Vec::new());
    }
    let mut resources = Vec::new();
    let entries = fs::read_dir(&resources_dir)
        .map_err(|error| format!("failed to read ticket resources: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read ticket resource: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect ticket resource: {error}"))?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to stat ticket resource: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        resources.push(TicketResource {
            relative_path: format!(".krypton/tickets/{ticket_id}/resources/{name}"),
            name,
            size_bytes: metadata.len(),
            modified_at: modified_ms(&metadata),
        });
    }
    resources.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(resources)
}

fn safe_repo_parts(repo: &str) -> Option<(&str, &str)> {
    let (owner, name) = repo.split_once('/')?;
    let valid = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.'))
    };
    (valid(owner) && valid(name) && !name.contains('/')).then_some((owner, name))
}

fn scan_analysis(
    project_dir: &Path,
    github: Option<&GithubTicketReference>,
) -> Option<TicketAnalysisSummary> {
    let github = github?;
    let (owner, repo) = safe_repo_parts(&github.repo)?;
    let relative_path = format!(".krypton/analyses/{owner}/{repo}/{}/", github.number);
    let path = project_dir
        .join(".krypton")
        .join("analyses")
        .join(owner)
        .join(repo)
        .join(github.number.to_string());
    if !path.is_dir() {
        return None;
    }
    let mut markdown_count = 0;
    let mut attachment_count = 0;
    let mut updated_at = 0;
    let entries = fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        if !matches!(
            entry.file_type(),
            Ok(file_type) if file_type.is_file() && !file_type.is_symlink()
        ) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        updated_at = updated_at.max(modified_ms(&metadata));
        if entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("md"))
        {
            markdown_count += 1;
        } else {
            attachment_count += 1;
        }
    }
    Some(TicketAnalysisSummary {
        relative_path,
        markdown_count,
        attachment_count,
        updated_at,
    })
}

fn load_bundle(project_dir: &Path, ticket_id: &str) -> Result<Option<TicketBundleDetail>, String> {
    let dir = bundle_dir(project_dir, ticket_id)?;
    if !dir.exists() {
        return Ok(None);
    }
    let metadata = read_metadata(&dir)?;
    if metadata.id != ticket_id {
        return Err("ticket directory does not match metadata id".to_string());
    }
    let context_path = dir.join("ticket.md");
    let context_markdown = fs::read_to_string(&context_path)
        .map_err(|error| format!("failed to read {}: {error}", context_path.display()))?;
    let resources = scan_resources(&dir, ticket_id)?;
    let analysis = scan_analysis(project_dir, metadata.github.as_ref());
    Ok(Some(TicketBundleDetail {
        summary: TicketBundleSummary {
            relative_path: format!(".krypton/tickets/{ticket_id}/"),
            context_excerpt: context_excerpt(&context_markdown),
            resource_count: resources.len(),
            analysis,
            metadata,
        },
        context_markdown,
        resources,
    }))
}

fn project_dir(
    hook_server: &tauri::State<'_, Arc<HookServer>>,
    harness_id: &str,
) -> Result<PathBuf, String> {
    hook_server
        .project_dir_for_harness(harness_id)
        .ok_or_else(|| format!("no project directory is registered for harness {harness_id}"))
}

fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for value in title.chars().flat_map(char::to_lowercase) {
        if value.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() && slug.len() < 48 {
                slug.push('-');
            }
            pending_dash = false;
            if slug.len() < 48 {
                slug.push(value);
            }
        } else if !slug.is_empty() {
            pending_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "ticket".to_string()
    } else {
        slug
    }
}

fn current_date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn next_ticket_id(root: &Path, title: &str) -> String {
    let base = format!("{}-{}", current_date(), slugify(title));
    if !root.join(&base).exists() {
        return base;
    }
    for suffix in 2..=9_999 {
        let candidate = format!("{base}-{suffix}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", now_ms())
}

pub(crate) fn update_ticket_status_for_project(
    project_dir: &Path,
    ticket_id: &str,
    status: LocalTicketStatus,
    summary: Option<String>,
) -> Result<TicketBundleDetail, String> {
    let dir = bundle_dir(project_dir, ticket_id)?;
    let mut metadata = read_metadata(&dir)?;
    let summary = summary
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if summary
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_PROGRESS_CHARS)
    {
        return Err(format!(
            "summary must be at most {MAX_PROGRESS_CHARS} Unicode characters"
        ));
    }
    metadata.status = status;
    metadata.updated_at = now_ms();
    if let Some(summary) = summary {
        metadata.last_progress_summary = Some(summary);
        metadata.last_progress_at = Some(metadata.updated_at);
    }
    atomic_write_json(&dir.join("ticket.json"), &metadata)?;
    load_bundle(project_dir, ticket_id)?
        .ok_or_else(|| "ticket disappeared after update".to_string())
}

#[tauri::command]
pub fn acp_list_ticket_bundles(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<Vec<TicketBundleSummary>, String> {
    let project_dir = project_dir(&hook_server, &harness_id)?;
    let root = ticket_root(&project_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut tickets = Vec::new();
    let entries =
        fs::read_dir(&root).map_err(|error| format!("failed to list local tickets: {error}"))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                log::warn!("Failed to read local ticket entry: {error}");
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                log::warn!("Failed to stat local ticket entry: {error}");
                continue;
            }
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let ticket_id = entry.file_name().to_string_lossy().to_string();
        match load_bundle(&project_dir, &ticket_id) {
            Ok(Some(detail)) => tickets.push(detail.summary),
            Ok(None) => {}
            Err(error) => log::warn!("Skipping malformed local ticket {ticket_id}: {error}"),
        }
    }
    tickets.sort_by_key(|ticket| std::cmp::Reverse(ticket.metadata.updated_at));
    Ok(tickets)
}

#[tauri::command]
pub fn acp_create_ticket_bundle(
    harness_id: String,
    title: String,
    github: Option<GithubTicketReference>,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TicketBundleDetail, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("ticket title is required".to_string());
    }
    let project_dir = project_dir(&hook_server, &harness_id)?;
    let root = ticket_root(&project_dir);
    fs::create_dir_all(&root)
        .map_err(|error| format!("failed to create local ticket root: {error}"))?;
    let ticket_id = next_ticket_id(&root, title);
    let dir = root.join(&ticket_id);
    fs::create_dir(&dir).map_err(|error| format!("failed to create local ticket: {error}"))?;
    fs::create_dir(dir.join("resources"))
        .map_err(|error| format!("failed to create ticket resources: {error}"))?;
    let timestamp = now_ms();
    let metadata = TicketMetadata {
        schema_version: SCHEMA_VERSION,
        id: ticket_id.clone(),
        title: title.to_string(),
        status: LocalTicketStatus::Todo,
        created_at: timestamp,
        updated_at: timestamp,
        context_revision: 1,
        last_progress_summary: None,
        last_progress_at: None,
        github,
    };
    atomic_write_json(&dir.join("ticket.json"), &metadata)?;
    fs::write(dir.join("ticket.md"), format!("# {title}\n\n"))
        .map_err(|error| format!("failed to create ticket context: {error}"))?;
    load_bundle(&project_dir, &ticket_id)?
        .ok_or_else(|| "ticket disappeared after creation".to_string())
}

#[tauri::command]
pub fn acp_load_ticket_bundle(
    harness_id: String,
    ticket_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<Option<TicketBundleDetail>, String> {
    load_bundle(&project_dir(&hook_server, &harness_id)?, &ticket_id)
}

#[tauri::command]
pub fn acp_append_ticket_note(
    harness_id: String,
    ticket_id: String,
    markdown: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TicketBundleDetail, String> {
    let markdown = markdown.trim();
    if markdown.is_empty() {
        return Err("ticket note is required".to_string());
    }
    let project_dir = project_dir(&hook_server, &harness_id)?;
    let dir = bundle_dir(&project_dir, &ticket_id)?;
    let mut metadata = read_metadata(&dir)?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(dir.join("ticket.md"))
        .map_err(|error| format!("failed to open ticket context: {error}"))?;
    writeln!(file, "\n{markdown}")
        .map_err(|error| format!("failed to append ticket context: {error}"))?;
    metadata.context_revision = metadata.context_revision.saturating_add(1);
    metadata.updated_at = now_ms();
    atomic_write_json(&dir.join("ticket.json"), &metadata)?;
    load_bundle(&project_dir, &ticket_id)?
        .ok_or_else(|| "ticket disappeared after note".to_string())
}

fn safe_resource_name(source: &Path) -> Result<String, String> {
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "resource path must end with a valid UTF-8 file name".to_string())?;
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("resource file name is invalid".to_string());
    }
    Ok(name.to_string())
}

fn available_resource_path(resources_dir: &Path, name: &str) -> PathBuf {
    let requested = resources_dir.join(name);
    if is_unoccupied_path(&requested) {
        return requested;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("resource");
    let extension = path.extension().and_then(|value| value.to_str());
    for suffix in 2..=9_999 {
        let candidate = match extension {
            Some(extension) => format!("{stem}-{suffix}.{extension}"),
            None => format!("{stem}-{suffix}"),
        };
        let destination = resources_dir.join(candidate);
        if is_unoccupied_path(&destination) {
            return destination;
        }
    }
    resources_dir.join(format!("{stem}-{}", now_ms()))
}

fn is_unoccupied_path(path: &Path) -> bool {
    matches!(
        fs::symlink_metadata(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound
    )
}

fn expand_home(raw: &str) -> Result<PathBuf, String> {
    if raw == "~" || raw.starts_with("~/") || raw.starts_with("~\\") {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| "cannot expand ~: home directory is unknown".to_string())?;
        if raw == "~" {
            return Ok(PathBuf::from(home));
        }
        return Ok(PathBuf::from(home).join(&raw[2..]));
    }
    Ok(PathBuf::from(raw))
}

pub(crate) fn resolve_resource_source(
    project_dir: &Path,
    source_path: &str,
) -> Result<PathBuf, String> {
    let raw = source_path.trim();
    if raw.is_empty() {
        return Err("resource path is required".to_string());
    }
    let expanded = expand_home(raw)?;
    if expanded.is_absolute() {
        Ok(expanded)
    } else {
        Ok(project_dir.join(expanded))
    }
}

fn reject_symlink_chain(root: &Path, path: &Path) -> Result<(), String> {
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "ticket resource path escaped the project directory".to_string())?;
    let mut cur = root.to_path_buf();
    for comp in rel.components() {
        cur.push(comp);
        if let Ok(meta) = fs::symlink_metadata(&cur) {
            if meta.file_type().is_symlink() {
                return Err("ticket resource path contains a symlink".to_string());
            }
        }
    }
    Ok(())
}

fn copy_resource(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = fs::File::open(source)
        .map_err(|error| format!("failed to open ticket resource: {error}"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("failed to create ticket resource: {error}"))?;
    io::copy(&mut input, &mut output)
        .map_err(|error| format!("failed to copy ticket resource: {error}"))?;
    Ok(())
}

fn make_resource_inert(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644))
            .map_err(|error| format!("failed to make ticket resource inert: {error}"))?;
    }
    Ok(())
}

pub(crate) fn add_ticket_resource_for_project(
    project_dir: &Path,
    ticket_id: &str,
    source_path: &str,
) -> Result<TicketBundleDetail, String> {
    let dir = bundle_dir(project_dir, ticket_id)?;
    let mut ticket = read_metadata(&dir)?;
    let source = resolve_resource_source(project_dir, source_path)?;
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| format!("failed to stat resource: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("resource must be a regular file, not a directory or symlink".to_string());
    }
    if metadata.len() > MAX_RESOURCE_BYTES {
        return Err(format!(
            "resource exceeds the {MAX_RESOURCE_BYTES} byte limit"
        ));
    }
    let name = safe_resource_name(&source)?;
    let resources_dir = dir.join("resources");
    reject_symlink_chain(project_dir, &resources_dir)?;
    fs::create_dir_all(&resources_dir)
        .map_err(|error| format!("failed to create ticket resources: {error}"))?;
    let destination = available_resource_path(&resources_dir, &name);
    reject_symlink_chain(project_dir, &destination)?;
    copy_resource(&source, &destination)?;
    make_resource_inert(&destination)?;
    ticket.context_revision = ticket.context_revision.saturating_add(1);
    ticket.updated_at = now_ms();
    atomic_write_json(&dir.join("ticket.json"), &ticket)?;
    load_bundle(project_dir, ticket_id)?
        .ok_or_else(|| "ticket disappeared after resource copy".to_string())
}

#[tauri::command]
pub fn acp_add_ticket_resource(
    harness_id: String,
    ticket_id: String,
    source_path: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TicketBundleDetail, String> {
    add_ticket_resource_for_project(
        &project_dir(&hook_server, &harness_id)?,
        &ticket_id,
        &source_path,
    )
}

#[tauri::command]
pub fn acp_update_ticket_status(
    harness_id: String,
    ticket_id: String,
    status: LocalTicketStatus,
    summary: Option<String>,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TicketBundleDetail, String> {
    update_ticket_status_for_project(
        &project_dir(&hook_server, &harness_id)?,
        &ticket_id,
        status,
        summary,
    )
}

#[tauri::command]
pub fn acp_update_ticket_github(
    harness_id: String,
    ticket_id: String,
    github: Option<GithubTicketReference>,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TicketBundleDetail, String> {
    let project_dir = project_dir(&hook_server, &harness_id)?;
    let dir = bundle_dir(&project_dir, &ticket_id)?;
    let mut metadata = read_metadata(&dir)?;
    let placeholder_title = metadata
        .github
        .as_ref()
        .is_some_and(|reference| metadata.title == reference.issue_key);
    if placeholder_title {
        if let Some(reference) = github.as_ref() {
            let title = reference.title.trim();
            if !title.is_empty() {
                metadata.title = title.to_string();
            }
        }
    }
    metadata.github = github;
    metadata.updated_at = now_ms();
    atomic_write_json(&dir.join("ticket.json"), &metadata)?;
    load_bundle(&project_dir, &ticket_id)?
        .ok_or_else(|| "ticket disappeared after GitHub update".to_string())
}

#[tauri::command]
pub fn acp_set_ticket_worker(
    harness_id: String,
    binding: Option<TicketWorkerBinding>,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<(), String> {
    if let Some(ref binding) = binding {
        let project_dir = project_dir(&hook_server, &harness_id)?;
        if load_bundle(&project_dir, &binding.ticket_id)?.is_none() {
            return Err(format!("unknown local ticket {}", binding.ticket_id));
        }
        if binding.lane_id.trim().is_empty() || binding.lane_display_name.trim().is_empty() {
            return Err("ticket worker lane is required".to_string());
        }
    }
    hook_server.set_ticket_worker(&harness_id, binding);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("krypton-ticket-{label}-{}", now_ms()));
        fs::create_dir_all(&path).expect("create temp project");
        path
    }

    fn seed_bundle(project: &Path, title: &str) -> String {
        let root = ticket_root(project);
        fs::create_dir_all(&root).expect("create ticket root");
        let id = next_ticket_id(&root, title);
        let dir = root.join(&id);
        fs::create_dir_all(dir.join("resources")).expect("create bundle");
        let timestamp = now_ms();
        atomic_write_json(
            &dir.join("ticket.json"),
            &TicketMetadata {
                schema_version: SCHEMA_VERSION,
                id: id.clone(),
                title: title.to_string(),
                status: LocalTicketStatus::Todo,
                created_at: timestamp,
                updated_at: timestamp,
                context_revision: 1,
                last_progress_summary: None,
                last_progress_at: None,
                github: None,
            },
        )
        .expect("write metadata");
        fs::write(
            dir.join("ticket.md"),
            format!("# {title}\n\nContext line\n"),
        )
        .expect("write context");
        id
    }

    #[test]
    fn slug_collision_gets_numeric_suffix() {
        let project = temp_project("slug");
        let first = seed_bundle(&project, "Auth Timeout");
        let second = next_ticket_id(&ticket_root(&project), "Auth Timeout");
        assert_eq!(second, format!("{first}-2"));
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn bundle_loads_context_and_resources() {
        let project = temp_project("load");
        let id = seed_bundle(&project, "Read me");
        fs::write(
            ticket_root(&project).join(&id).join("resources/a.txt"),
            b"a",
        )
        .expect("write resource");
        let bundle = load_bundle(&project, &id)
            .expect("load bundle")
            .expect("bundle exists");
        assert_eq!(bundle.summary.resource_count, 1);
        assert_eq!(
            bundle.summary.context_excerpt.as_deref(),
            Some("Context line")
        );
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn analysis_is_derived_from_github_reference() {
        let project = temp_project("analysis");
        let path = project.join(".krypton/analyses/acme/demo/42");
        fs::create_dir_all(&path).expect("create analysis");
        fs::write(path.join("analysis.md"), "# Analysis").expect("write analysis");
        fs::write(path.join("trace.txt"), "trace").expect("write attachment");
        let summary = scan_analysis(
            &project,
            Some(&GithubTicketReference {
                issue_key: "acme/demo#42".to_string(),
                issue_url: "https://github.com/acme/demo/issues/42".to_string(),
                repo: "acme/demo".to_string(),
                number: 42,
                title: "Issue".to_string(),
                state: Some("open".to_string()),
                labels: None,
                fetched_at: now_ms(),
                source_updated_at: None,
            }),
        )
        .expect("analysis summary");
        assert_eq!(summary.markdown_count, 1);
        assert_eq!(summary.attachment_count, 1);
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn traversal_ticket_ids_are_rejected() {
        assert!(validate_ticket_id("../outside").is_err());
        assert!(validate_ticket_id("ticket/child").is_err());
        assert!(validate_ticket_id("valid-ticket-42").is_ok());
    }

    #[test]
    fn progress_summary_is_unicode_bounded() {
        let project = temp_project("progress-limit");
        let id = seed_bundle(&project, "Progress limit");
        let too_long = "ก".repeat(MAX_PROGRESS_CHARS + 1);
        assert!(update_ticket_status_for_project(
            &project,
            &id,
            LocalTicketStatus::Blocked,
            Some(too_long),
        )
        .is_err());
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn resource_collision_uses_suffix() {
        let project = temp_project("resource-suffix");
        let resources = project.join("resources");
        fs::create_dir_all(&resources).expect("create resources");
        fs::write(resources.join("trace.txt"), "first").expect("write first");
        assert_eq!(
            available_resource_path(&resources, "trace.txt"),
            resources.join("trace-2.txt")
        );
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[cfg(unix)]
    #[test]
    fn resource_symlinks_are_hidden_and_reserve_their_names() {
        use std::os::unix::fs::symlink;

        let project = temp_project("resource-symlink");
        let id = seed_bundle(&project, "Symlink guard");
        let resources = ticket_root(&project).join(&id).join("resources");
        symlink(project.join("missing-target"), resources.join("trace.txt"))
            .expect("create broken symlink");
        assert_eq!(
            available_resource_path(&resources, "trace.txt"),
            resources.join("trace-2.txt")
        );
        let bundle = load_bundle(&project, &id)
            .expect("load bundle")
            .expect("bundle exists");
        assert!(bundle.resources.is_empty());
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[cfg(unix)]
    #[test]
    fn resource_is_made_non_executable() {
        use std::os::unix::fs::PermissionsExt;

        let project = temp_project("resource-mode");
        let script = project.join("repro.sh");
        fs::write(&script, "#!/bin/sh\n").expect("write script");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("set executable");
        make_resource_inert(&script).expect("make inert");
        let mode = fs::metadata(&script)
            .expect("stat script")
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0);
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[test]
    fn resource_source_joins_project_and_expands_home() {
        let project = PathBuf::from("/tmp/krypton-project");
        assert_eq!(
            resolve_resource_source(&project, "src/foo.txt").expect("relative"),
            project.join("src/foo.txt")
        );
        assert_eq!(
            resolve_resource_source(&project, "/abs/shot.png").expect("absolute"),
            PathBuf::from("/abs/shot.png")
        );
        let home = std::env::var_os("HOME").expect("HOME");
        assert_eq!(
            resolve_resource_source(&project, "~/Desktop/log.txt").expect("home"),
            PathBuf::from(home).join("Desktop/log.txt")
        );
        assert!(resolve_resource_source(&project, "   ").is_err());
    }

    #[test]
    fn relative_resource_copies_from_project_dir() {
        let project = temp_project("relative-add");
        let id = seed_bundle(&project, "Relative add");
        let source = project.join("notes/trace.txt");
        fs::create_dir_all(source.parent().expect("parent")).expect("create notes");
        fs::write(&source, "copied").expect("write source");
        let bundle = add_ticket_resource_for_project(&project, &id, "notes/trace.txt")
            .expect("copy relative resource");
        assert_eq!(bundle.summary.resource_count, 1);
        assert_eq!(bundle.resources[0].name, "trace.txt");
        let copied = ticket_root(&project).join(&id).join("resources/trace.txt");
        assert_eq!(fs::read_to_string(copied).expect("read copy"), "copied");
        fs::remove_dir_all(project).expect("remove temp project");
    }

    #[cfg(unix)]
    #[test]
    fn destination_resource_dir_symlink_is_rejected() {
        use std::os::unix::fs::symlink;

        let project = temp_project("dest-symlink");
        let id = seed_bundle(&project, "Dest symlink");
        let resources = ticket_root(&project).join(&id).join("resources");
        fs::remove_dir(&resources).expect("remove resources dir");
        let outside = project.join("outside");
        fs::create_dir_all(&outside).expect("create outside");
        symlink(&outside, &resources).expect("symlink resources");
        let source = project.join("shot.png");
        fs::write(&source, b"png").expect("write source");
        let error = add_ticket_resource_for_project(&project, &id, "shot.png")
            .expect_err("symlink destination rejected");
        assert!(error.contains("symlink"), "{error}");
        assert!(fs::read_dir(&outside).expect("outside").next().is_none());
        fs::remove_dir_all(project).expect("remove temp project");
    }
}
