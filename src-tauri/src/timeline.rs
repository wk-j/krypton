//! Project-local requirement and decision timeline (spec 253).
//!
//! The frontend supplies a harness id, never a filesystem path. `HookServer`
//! resolves the registered project root and this module confines every record to
//! `.krypton/timeline/`. Events are append-only Markdown; legacy pending
//! candidates are resolved by agents with durable, evidence-preserving receipts.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::hook_server::HookServer;

const SCHEMA_VERSION: u8 = 1;
const MAX_EVENTS: usize = 2_000;
const MAX_EVENT_BYTES: u64 = 32 * 1024;
const MAX_TOPIC_CHARS: usize = 120;
const MAX_SUMMARY_CHARS: usize = 500;
const MAX_ACTOR_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 4 * 1024;
const MAX_SOURCE_CHARS: usize = 2 * 1024;
const MAX_EVIDENCE_CHARS: usize = 1_000;
// spec 262: bounds for the agent-facing read path. A lane pays for every token
// it reads, so topic listings stay short by default and carry a `truncated`
// flag instead of a pagination cursor.
const DEFAULT_TOPIC_LIST_LIMIT: usize = 20;
const MAX_TOPIC_LIST_LIMIT: usize = 50;
const MAX_TOPIC_QUERY_CHARS: usize = 120;
const MAX_TOPIC_PREVIEW_CHARS: usize = 200;
const MAX_RECORD_ACK_TOPICS: usize = 10;
// spec 263: how many topics an ambiguous merge selector lists back.
const MAX_MERGE_CANDIDATES: usize = 5;
// spec 262: `occurred_at` further ahead than this is reported back to the lane.
// The write still happens; a chronology dated months from its cited source is
// almost always a mistake worth reporting to the lane.
const MAX_FUTURE_SKEW_HOURS: i64 = 24;
pub(crate) static TIMELINE_MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineKind {
    Event,
    Requirement,
    Decision,
    Implementation,
    Note,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineRelation {
    Supersedes,
    Refines,
    Implements,
    Supports,
    CausedBy,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRecordRequest {
    pub topic_id: String,
    pub topic_title: String,
    pub summary: String,
    pub occurred_at: String,
    pub made_by: String,
    pub rationale: String,
    pub impact: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub relation: Option<TimelineRelation>,
    #[serde(default)]
    pub related_event: Option<String>,
    pub recorder_lane: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineEvidenceKind {
    UserStatement,
    ObservedOutcome,
    AgentDecision,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TimelineDirectRecordRequest {
    #[serde(default)]
    pub topic_id: Option<String>,
    pub topic_title: String,
    pub summary: String,
    pub made_by: String,
    pub evidence_kind: TimelineEvidenceKind,
    pub evidence_excerpt: String,
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub impact: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub relation: Option<TimelineRelation>,
    #[serde(default)]
    pub related_event: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineDirectRecordDisposition {
    Created,
    Existing,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDirectRecordResult {
    pub event: TimelineEvent,
    pub disposition: TimelineDirectRecordDisposition,
    /// spec 262: true when this call is the first event under its resolved
    /// topic. The MCP ack uses it to warn a lane that skipped `timeline_list`
    /// that it just opened a second chronology for one subject.
    pub new_topic: bool,
    /// spec 262: advisory only — the topics that already existed when a new
    /// topic was created. Nothing is merged or re-parented on this path.
    pub existing_topics: Vec<TimelineTopicRef>,
    /// Non-fatal notices such as an occurrence time far in the future.
    pub warnings: Vec<String>,
}

/// spec 262: compact per-topic digest returned by the read-only `timeline_list`
/// MCP tool. `topic_id` leads because that — not the human title — is the value
/// a lane must copy back into `timeline_record`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TimelineTopicDigest {
    pub topic_id: String,
    pub topic_title: String,
    pub event_count: usize,
    pub first_occurred_at: String,
    pub last_occurred_at: String,
    pub latest_summary: String,
}

/// spec 262: the lighter shape used inside a `timeline_record` ack, where the
/// lane only needs enough to recognize a subject it already has a topic for.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TimelineTopicRef {
    pub topic_id: String,
    pub topic_title: String,
    pub event_count: usize,
    pub last_occurred_at: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct TimelineTopicListing {
    pub topics: Vec<TimelineTopicDigest>,
    /// Topics matching the request, before `limit` truncation.
    pub total_topics: usize,
    /// Topics stored in total, so an empty filtered result is distinguishable
    /// from an empty timeline without a second call.
    pub total_topics_all: usize,
    pub truncated: bool,
}

/// spec 262: one line of a topic's chronology. Deliberately narrower than
/// [`TimelineEvent`] — audit fields stay in the browser, not in lane context.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TimelineTopicEvent {
    pub event_id: String,
    pub occurred_at: String,
    pub summary: String,
    pub made_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    pub superseded: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TimelineTopicEventListing {
    pub topic_id: String,
    pub topic_title: String,
    pub events: Vec<TimelineTopicEvent>,
    pub total_events: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSuggestion {
    pub schema: u8,
    pub id: String,
    pub topic_title: String,
    pub summary: String,
    pub made_by: String,
    pub occurred_at: String,
    pub evidence_excerpt: String,
    pub rationale: String,
    pub impact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    pub suggested_at: String,
    pub suggested_by_lane: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct TimelinePendingListing {
    pub candidates: Vec<TimelineSuggestion>,
    pub remaining_pending: usize,
    pub diagnostics: Vec<TimelineDiagnostic>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelinePendingOutcome {
    Record,
    Duplicate,
    Discard,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TimelinePendingResolveRequest {
    pub pending_id: String,
    pub outcome: TimelinePendingOutcome,
    pub rationale: String,
    pub record: Option<TimelineDirectRecordRequest>,
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TimelinePendingResolveResult {
    pub pending_id: String,
    pub outcome: TimelinePendingOutcome,
    pub event_id: Option<String>,
    pub resolution_path: String,
    pub remaining_pending: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<TimelineEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct TimelinePendingReceipt {
    schema: u8,
    pending_id: String,
    outcome: TimelinePendingOutcome,
    event_id: Option<String>,
    rationale: String,
    resolved_by_lane: String,
    resolved_at: String,
    original_candidate: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSettings {
    pub automatic_recording: bool,
}

impl Default for TimelineSettings {
    fn default() -> Self {
        Self {
            automatic_recording: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub schema: u8,
    pub id: String,
    pub topic_id: String,
    pub topic_title: String,
    pub kind: TimelineKind,
    pub summary: String,
    pub occurred_at: String,
    pub made_by: String,
    pub recorded_at: String,
    pub recorded_by: String,
    pub recorder_lane: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relation: Option<TimelineRelation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_by_lane: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_kind: Option<TimelineEvidenceKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instruction_excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion_id: Option<String>,
    pub rationale: String,
    pub impact: String,
    pub path: String,
    pub superseded: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDiagnostic {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineListResponse {
    pub events: Vec<TimelineEvent>,
    pub diagnostics: Vec<TimelineDiagnostic>,
}

fn event_root(project_dir: &Path) -> PathBuf {
    project_dir.join(".krypton").join("timeline").join("events")
}

fn pending_root(project_dir: &Path) -> PathBuf {
    project_dir
        .join(".krypton")
        .join("timeline")
        .join("pending")
}

fn resolution_root(project_dir: &Path) -> PathBuf {
    project_dir
        .join(".krypton")
        .join("timeline")
        .join("resolutions")
}

fn settings_path(project_dir: &Path) -> PathBuf {
    project_dir
        .join(".krypton")
        .join("timeline")
        .join("settings.json")
}

fn canonical_project(project_dir: &Path) -> Result<PathBuf, String> {
    project_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve project directory: {error}"))
}

fn existing_event_root(project_dir: &Path) -> Result<Option<(PathBuf, PathBuf)>, String> {
    existing_confined_root(project_dir, event_root(project_dir), "timeline events")
}

fn writable_event_root(project_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    writable_confined_root(project_dir, event_root(project_dir), "timeline events")
}

fn confined_directory(
    project_dir: &Path,
    requested: &Path,
    label: &str,
    create: bool,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let project = canonical_project(project_dir)?;
    let suffix = requested
        .strip_prefix(project_dir)
        .or_else(|_| requested.strip_prefix(&project))
        .map_err(|_| format!("{label} directory is outside the project"))?;
    let mut path = project.clone();
    for component in suffix.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(format!("{label} directory has an invalid path"));
        };
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(format!(
                    "{label} directory must not contain symlinks or non-directories"
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                fs::create_dir(&path)
                    .map_err(|error| format!("failed to create {label} directory: {error}"))?;
            }
            Err(error) => return Err(format!("failed to inspect {label} directory: {error}")),
        }
    }
    Ok(Some((project, path)))
}

pub(crate) fn existing_confined_root(
    project_dir: &Path,
    requested: PathBuf,
    label: &str,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    confined_directory(project_dir, &requested, label, false)
}

pub(crate) fn writable_confined_root(
    project_dir: &Path,
    requested: PathBuf,
    label: &str,
) -> Result<(PathBuf, PathBuf), String> {
    confined_directory(project_dir, &requested, label, true)?
        .ok_or_else(|| format!("failed to create {label} directory"))
}

fn read_regular_file(path: &Path, max_bytes: u64, label: &str) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} must be a regular file, not a symlink"));
    }
    if metadata.len() > max_bytes {
        return Err(format!("{label} exceeds {max_bytes} bytes"));
    }
    fs::read_to_string(path).map_err(|error| format!("failed to read {label}: {error}"))
}

/// POSIX supports flushing directory entries after publication/removal. Windows
/// cannot open directories with File::open; file contents are still flushed
/// before atomic publication, without claiming a portable directory-fsync API.
fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Stage and flush bytes before publishing them. Immutable files use a hard
/// link so a collision can never overwrite an event or terminal receipt.
fn atomic_write(path: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    #[cfg(test)]
    tests::storage_failure(path, "publish")?;
    let root = path
        .parent()
        .ok_or_else(|| "missing storage directory".to_string())?;
    let temp = root.join(format!(".timeline-{}.tmp", random_hex()?));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| format!("failed to create timeline staging file: {error}"))?;
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .and_then(|_| {
            if replace {
                fs::rename(&temp, path)
            } else {
                fs::hard_link(&temp, path)
            }
        });
    let cleanup = fs::remove_file(&temp);
    result.map_err(|error| format!("failed to publish timeline file: {error}"))?;
    if !replace {
        cleanup
            .map_err(|error| format!("timeline file saved but staging cleanup failed: {error}"))?;
    }
    sync_directory(root)
        .map_err(|error| format!("timeline file saved but directory flush failed: {error}"))
}

pub(crate) fn relative_path(project: &Path, path: &Path) -> String {
    path.strip_prefix(project)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn validate_single_line(name: &str, value: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{name} is required"));
    }
    if value.chars().count() > max {
        return Err(format!("{name} must be at most {max} Unicode characters"));
    }
    if value.contains(['\r', '\n']) {
        return Err(format!("{name} must be a single line"));
    }
    Ok(value.to_string())
}

pub(crate) fn validate_optional_single_line(
    name: &str,
    value: Option<String>,
    max: usize,
) -> Result<Option<String>, String> {
    match value.map(|value| value.trim().to_string()) {
        Some(value) if value.is_empty() => Ok(None),
        Some(value) => validate_single_line(name, &value, max).map(Some),
        None => Ok(None),
    }
}

fn validate_body(name: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.chars().count() > MAX_BODY_CHARS {
        return Err(format!(
            "{name} must be at most {MAX_BODY_CHARS} Unicode characters"
        ));
    }
    if value.lines().any(|line| {
        matches!(
            line.trim(),
            "## Evidence" | "## Authorizing instruction" | "## Rationale" | "## Impact"
        )
    }) {
        return Err(format!(
            "{name} cannot contain the reserved timeline section headings"
        ));
    }
    Ok(value.to_string())
}

pub(crate) fn validate_topic_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if !value.starts_with("topic-")
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("topicId must start with topic- and contain lowercase ASCII letters, numbers, or hyphens".to_string());
    }
    Ok(value.to_string())
}

pub(crate) fn validate_event_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if !value.starts_with("tl-")
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("relatedEvent is not a valid timeline event id".to_string());
    }
    Ok(value.to_string())
}

fn yaml_string(value: &str) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("failed to encode timeline field: {error}"))
}

fn kind_name(kind: TimelineKind) -> &'static str {
    match kind {
        TimelineKind::Event => "event",
        TimelineKind::Requirement => "requirement",
        TimelineKind::Decision => "decision",
        TimelineKind::Implementation => "implementation",
        TimelineKind::Note => "note",
    }
}

fn relation_name(relation: TimelineRelation) -> &'static str {
    match relation {
        TimelineRelation::Supersedes => "supersedes",
        TimelineRelation::Refines => "refines",
        TimelineRelation::Implements => "implements",
        TimelineRelation::Supports => "supports",
        TimelineRelation::CausedBy => "caused_by",
    }
}

fn parse_kind(value: &str) -> Result<TimelineKind, String> {
    match value {
        "event" => Ok(TimelineKind::Event),
        "requirement" => Ok(TimelineKind::Requirement),
        "decision" => Ok(TimelineKind::Decision),
        "implementation" => Ok(TimelineKind::Implementation),
        "note" => Ok(TimelineKind::Note),
        _ => Err(format!("unsupported timeline kind {value}")),
    }
}

fn parse_relation(value: &str) -> Result<TimelineRelation, String> {
    match value {
        "supersedes" => Ok(TimelineRelation::Supersedes),
        "refines" => Ok(TimelineRelation::Refines),
        "implements" => Ok(TimelineRelation::Implements),
        "supports" => Ok(TimelineRelation::Supports),
        "caused_by" => Ok(TimelineRelation::CausedBy),
        _ => Err(format!("unsupported timeline relation {value}")),
    }
}

fn parse_yaml_string(fields: &HashMap<String, String>, name: &str) -> Result<String, String> {
    let value = fields
        .get(name)
        .ok_or_else(|| format!("missing frontmatter field {name}"))?;
    serde_json::from_str::<String>(value)
        .map_err(|error| format!("invalid quoted string for {name}: {error}"))
}

fn parse_optional_yaml_string(
    fields: &HashMap<String, String>,
    name: &str,
) -> Result<Option<String>, String> {
    fields
        .get(name)
        .map(|value| {
            serde_json::from_str::<String>(value)
                .map_err(|error| format!("invalid quoted string for {name}: {error}"))
        })
        .transpose()
}

fn body_section(body: &str, heading: &str, next_heading: Option<&str>) -> String {
    let marker = format!("## {heading}\n");
    let Some(start) = body.find(&marker) else {
        return String::new();
    };
    let rest = &body[start + marker.len()..];
    let end = next_heading
        .and_then(|next| rest.find(&format!("\n## {next}\n")))
        .unwrap_or(rest.len());
    rest[..end].trim().to_string()
}

fn parse_event(project: &Path, path: &Path, source: &str) -> Result<TimelineEvent, String> {
    let normalized = source.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next() != Some("---") {
        return Err("missing opening frontmatter delimiter".to_string());
    }
    let mut fields = HashMap::new();
    let mut body_lines = Vec::new();
    let mut in_body = false;
    for line in lines {
        if !in_body && line == "---" {
            in_body = true;
            continue;
        }
        if in_body {
            body_lines.push(line);
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| format!("invalid frontmatter line {line:?}"))?;
        fields.insert(name.trim().to_string(), value.trim().to_string());
    }
    if !in_body {
        return Err("missing closing frontmatter delimiter".to_string());
    }
    if fields.get("schema").map(String::as_str) != Some("1") {
        return Err("unsupported or missing timeline schema".to_string());
    }
    let id = parse_yaml_string(&fields, "id")?;
    let file_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if file_id != id {
        return Err("timeline id does not match its file name".to_string());
    }
    validate_event_id(&id)?;
    let topic_id = validate_topic_id(&parse_yaml_string(&fields, "topic_id")?)?;
    let topic_title = validate_single_line(
        "topicTitle",
        &parse_yaml_string(&fields, "topic_title")?,
        MAX_TOPIC_CHARS,
    )?;
    let kind = parse_kind(&parse_yaml_string(&fields, "kind")?)?;
    let occurred_at = parse_yaml_string(&fields, "occurred_at")?;
    DateTime::parse_from_rfc3339(&occurred_at)
        .map_err(|error| format!("invalid occurred_at: {error}"))?;
    let made_by = validate_single_line(
        "madeBy",
        &parse_yaml_string(&fields, "made_by")?,
        MAX_ACTOR_CHARS,
    )?;
    let recorded_at = parse_yaml_string(&fields, "recorded_at")?;
    DateTime::parse_from_rfc3339(&recorded_at)
        .map_err(|error| format!("invalid recorded_at: {error}"))?;
    let recorded_by = validate_single_line(
        "recordedBy",
        &parse_yaml_string(&fields, "recorded_by")?,
        MAX_ACTOR_CHARS,
    )?;
    let recorder_lane = validate_single_line(
        "recorderLane",
        &parse_yaml_string(&fields, "recorder_lane")?,
        MAX_ACTOR_CHARS,
    )?;
    let source_ref = validate_optional_single_line(
        "sourceRef",
        parse_optional_yaml_string(&fields, "source_ref")?,
        MAX_SOURCE_CHARS,
    )?;
    let relation = parse_optional_yaml_string(&fields, "relation")?
        .map(|value| parse_relation(&value))
        .transpose()?;
    let related_event = parse_optional_yaml_string(&fields, "related_event")?
        .map(|value| validate_event_id(&value))
        .transpose()?;
    if relation.is_some() != related_event.is_some() {
        return Err("relation and related_event must appear together".to_string());
    }
    let suggested_by_lane = validate_optional_single_line(
        "suggestedByLane",
        parse_optional_yaml_string(&fields, "suggested_by_lane")?,
        MAX_ACTOR_CHARS,
    )?;
    let suggestion_id = parse_optional_yaml_string(&fields, "suggestion_id")?
        .map(|value| validate_event_id(&value))
        .transpose()?;
    let evidence_kind = parse_optional_yaml_string(&fields, "evidence_kind")?
        .map(|value| {
            serde_json::from_value::<TimelineEvidenceKind>(serde_json::Value::String(value))
                .map_err(|error| format!("invalid evidence_kind: {error}"))
        })
        .transpose()?;
    let body = body_lines.join("\n");
    let summary = body
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .ok_or_else(|| "missing event summary heading".to_string())?;
    let summary = validate_single_line("summary", summary, MAX_SUMMARY_CHARS)?;
    let instruction_excerpt = {
        let instruction = body_section(&body, "Authorizing instruction", Some("Rationale"));
        if instruction.is_empty() {
            None
        } else {
            Some(validate_body_with_limit(
                "instructionExcerpt",
                &instruction,
                MAX_EVIDENCE_CHARS,
            )?)
        }
    };
    let evidence_excerpt = {
        let next = instruction_excerpt
            .as_ref()
            .map(|_| "Authorizing instruction")
            .unwrap_or("Rationale");
        let evidence = body_section(&body, "Evidence", Some(next));
        if evidence.is_empty() {
            None
        } else {
            Some(validate_body_with_limit(
                "evidenceExcerpt",
                &evidence,
                MAX_EVIDENCE_CHARS,
            )?)
        }
    };
    let rationale = validate_body(
        "rationale",
        &body_section(&body, "Rationale", Some("Impact")),
    )?;
    let impact = validate_body("impact", &body_section(&body, "Impact", None))?;
    Ok(TimelineEvent {
        schema: SCHEMA_VERSION,
        id,
        topic_id,
        topic_title,
        kind,
        summary,
        occurred_at,
        made_by,
        recorded_at,
        recorded_by,
        recorder_lane,
        source_ref,
        relation,
        related_event,
        suggested_by_lane,
        evidence_kind,
        evidence_excerpt,
        instruction_excerpt,
        suggestion_id,
        rationale,
        impact,
        path: relative_path(project, path),
        superseded: false,
    })
}

pub(crate) fn validate_body_with_limit(
    name: &str,
    value: &str,
    max: usize,
) -> Result<String, String> {
    let value = validate_body(name, value)?;
    if value.chars().count() > max {
        return Err(format!("{name} must be at most {max} Unicode characters"));
    }
    Ok(value)
}

fn parse_suggestion(
    project: &Path,
    path: &Path,
    source: &str,
) -> Result<TimelineSuggestion, String> {
    let normalized = source.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next() != Some("---") {
        return Err("missing opening frontmatter delimiter".to_string());
    }
    let mut fields = HashMap::new();
    let mut body_lines = Vec::new();
    let mut in_body = false;
    for line in lines {
        if !in_body && line == "---" {
            in_body = true;
            continue;
        }
        if in_body {
            body_lines.push(line);
        } else if !line.trim().is_empty() {
            let (name, value) = line
                .split_once(':')
                .ok_or_else(|| format!("invalid frontmatter line {line:?}"))?;
            fields.insert(name.trim().to_string(), value.trim().to_string());
        }
    }
    if !in_body {
        return Err("missing closing frontmatter delimiter".to_string());
    }
    if fields.get("schema").map(String::as_str) != Some("1") {
        return Err("unsupported or missing timeline schema".to_string());
    }
    if parse_yaml_string(&fields, "status")? != "pending" {
        return Err("timeline suggestion status is not pending".to_string());
    }
    let id = validate_event_id(&parse_yaml_string(&fields, "id")?)?;
    if path.file_stem().and_then(|value| value.to_str()) != Some(id.as_str()) {
        return Err("timeline suggestion id does not match its file name".to_string());
    }
    let topic_title = validate_single_line(
        "topicTitle",
        &parse_yaml_string(&fields, "topic_title")?,
        MAX_TOPIC_CHARS,
    )?;
    let occurred_at = parse_yaml_string(&fields, "occurred_at")?;
    DateTime::parse_from_rfc3339(&occurred_at)
        .map_err(|error| format!("invalid occurred_at: {error}"))?;
    let made_by = validate_single_line(
        "madeBy",
        &parse_yaml_string(&fields, "made_by")?,
        MAX_ACTOR_CHARS,
    )?;
    let suggested_at = parse_yaml_string(&fields, "suggested_at")?;
    DateTime::parse_from_rfc3339(&suggested_at)
        .map_err(|error| format!("invalid suggested_at: {error}"))?;
    let suggested_by_lane = validate_single_line(
        "suggestedByLane",
        &parse_yaml_string(&fields, "suggested_by_lane")?,
        MAX_ACTOR_CHARS,
    )?;
    let source_ref = validate_optional_single_line(
        "sourceRef",
        parse_optional_yaml_string(&fields, "source_ref")?,
        MAX_SOURCE_CHARS,
    )?;
    let body = body_lines.join("\n");
    let summary = body
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .ok_or_else(|| "missing suggestion summary heading".to_string())?;
    let summary = validate_single_line("summary", summary, MAX_SUMMARY_CHARS)?;
    let evidence_excerpt = validate_body_with_limit(
        "evidenceExcerpt",
        &body_section(&body, "Evidence", Some("Rationale")),
        MAX_EVIDENCE_CHARS,
    )?;
    if evidence_excerpt.is_empty() {
        return Err("evidenceExcerpt is required".to_string());
    }
    let rationale = validate_body(
        "rationale",
        &body_section(&body, "Rationale", Some("Impact")),
    )?;
    let impact = validate_body("impact", &body_section(&body, "Impact", None))?;
    Ok(TimelineSuggestion {
        schema: SCHEMA_VERSION,
        id,
        topic_title,
        summary,
        made_by,
        occurred_at,
        evidence_excerpt,
        rationale,
        impact,
        source_ref,
        suggested_at,
        suggested_by_lane,
        path: relative_path(project, path),
    })
}

pub(crate) fn pending_count_project(project_dir: &Path) -> Result<usize, String> {
    let Some((_, root)) =
        existing_confined_root(project_dir, pending_root(project_dir), "timeline pending")?
    else {
        return Ok(0);
    };
    let mut count = 0;
    for entry in
        fs::read_dir(root).map_err(|error| format!("failed to list timeline pending: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to read pending directory entry: {error}"))?;
        if entry.path().extension().and_then(|value| value.to_str()) == Some("md") {
            count += 1;
        }
    }
    Ok(count)
}

pub(crate) fn list_pending_project(
    project_dir: &Path,
    limit: usize,
) -> Result<TimelinePendingListing, String> {
    let limit = if limit == 0 { 5 } else { limit.min(20) };
    let Some((project, root)) =
        existing_confined_root(project_dir, pending_root(project_dir), "timeline pending")?
    else {
        return Ok(TimelinePendingListing::default());
    };
    let mut response = TimelinePendingListing::default();
    for entry in
        fs::read_dir(&root).map_err(|error| format!("failed to list timeline pending: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to read pending directory entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        response.remaining_pending += 1;
        match read_regular_file(&path, MAX_EVENT_BYTES, "timeline candidate")
            .and_then(|source| parse_suggestion(&project, &path, &source))
        {
            Ok(candidate) => {
                response.candidates.push(candidate);
                response.candidates.sort_by(|left, right| {
                    left.suggested_at
                        .cmp(&right.suggested_at)
                        .then(left.id.cmp(&right.id))
                });
                response.candidates.truncate(limit);
            }
            Err(error) if response.diagnostics.len() < limit => {
                response.diagnostics.push(TimelineDiagnostic {
                    path: relative_path(&project, &path),
                    error,
                });
            }
            Err(_) => {}
        }
    }
    response
        .diagnostics
        .sort_by(|left, right| left.path.cmp(&right.path));
    response.truncated =
        response.remaining_pending > response.candidates.len() + response.diagnostics.len();
    Ok(response)
}

pub(crate) fn scan_project(project_dir: &Path) -> Result<TimelineListResponse, String> {
    let Some((project, root)) = existing_event_root(project_dir)? else {
        return Ok(TimelineListResponse::default());
    };
    let mut response = TimelineListResponse::default();
    let entries =
        fs::read_dir(&root).map_err(|error| format!("failed to list timeline events: {error}"))?;
    for entry in entries.take(MAX_EVENTS) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                response.diagnostics.push(TimelineDiagnostic {
                    path: ".krypton/timeline/events".to_string(),
                    error: format!("failed to read directory entry: {error}"),
                });
                continue;
            }
        };
        let path = entry.path();
        let display_path = relative_path(&project, &path);
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                response.diagnostics.push(TimelineDiagnostic {
                    path: display_path,
                    error: format!("failed to inspect event: {error}"),
                });
                continue;
            }
        };
        if !file_type.is_file()
            || file_type.is_symlink()
            || path.extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                response.diagnostics.push(TimelineDiagnostic {
                    path: display_path,
                    error: format!("failed to inspect event: {error}"),
                });
                continue;
            }
        };
        if metadata.len() > MAX_EVENT_BYTES {
            response.diagnostics.push(TimelineDiagnostic {
                path: display_path,
                error: format!("event exceeds {MAX_EVENT_BYTES} bytes"),
            });
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(source) => match parse_event(&project, &path, &source) {
                Ok(event) => response.events.push(event),
                Err(error) => response.diagnostics.push(TimelineDiagnostic {
                    path: display_path,
                    error,
                }),
            },
            Err(error) => response.diagnostics.push(TimelineDiagnostic {
                path: display_path,
                error: format!("failed to read event: {error}"),
            }),
        }
    }
    let event_ids: HashSet<String> = response
        .events
        .iter()
        .map(|event| event.id.clone())
        .collect();
    for event in &response.events {
        if let Some(related) = &event.related_event {
            if !event_ids.contains(related) {
                response.diagnostics.push(TimelineDiagnostic {
                    path: event.path.clone(),
                    error: format!("related timeline event does not exist: {related}"),
                });
            }
        }
    }
    let superseded: HashSet<String> = response
        .events
        .iter()
        .filter(|event| event.relation == Some(TimelineRelation::Supersedes))
        .filter_map(|event| event.related_event.clone())
        .filter(|related| event_ids.contains(related))
        .collect();
    for event in &mut response.events {
        event.superseded = superseded.contains(&event.id);
    }
    response.events.sort_by(|left, right| {
        left.occurred_at
            .cmp(&right.occurred_at)
            .then(left.recorded_at.cmp(&right.recorded_at))
            .then(left.id.cmp(&right.id))
    });
    Ok(response)
}

/// spec 262: clamp a caller-supplied listing bound into the advertised range.
/// `0` means "unspecified" and falls back to the default.
fn topic_list_limit(limit: usize) -> usize {
    if limit == 0 {
        DEFAULT_TOPIC_LIST_LIMIT
    } else {
        limit.min(MAX_TOPIC_LIST_LIMIT)
    }
}

fn topic_query(query: Option<&str>) -> Result<Option<String>, String> {
    let Some(query) = query else {
        return Ok(None);
    };
    if query.chars().count() > MAX_TOPIC_QUERY_CHARS {
        return Err(format!(
            "query must be {MAX_TOPIC_QUERY_CHARS} characters or fewer"
        ));
    }
    let normalized = normalized_text(query);
    Ok(if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    })
}

fn preview_text(value: &str) -> String {
    if value.chars().count() <= MAX_TOPIC_PREVIEW_CHARS {
        return value.to_string();
    }
    let mut preview: String = value.chars().take(MAX_TOPIC_PREVIEW_CHARS).collect();
    preview.push('…');
    preview
}

fn event_matches_query(event: &TimelineEvent, needle: &str) -> bool {
    normalized_text(&event.topic_title).contains(needle)
        || normalized_text(&event.summary).contains(needle)
}

/// spec 262: fold the single `scan_project` pass into one digest per topic.
/// Events arrive ordered by `(occurred_at, recorded_at, id)`, so the last event
/// seen for a topic is its newest: that one supplies the display title and
/// preview. Topics come back newest-activity first.
fn fold_topic_digests(events: &[TimelineEvent], needle: Option<&str>) -> Vec<TimelineTopicDigest> {
    let mut order: Vec<String> = Vec::new();
    let mut digests: HashMap<String, TimelineTopicDigest> = HashMap::new();
    let mut matched: HashSet<String> = HashSet::new();
    for event in events {
        let digest = digests.entry(event.topic_id.clone()).or_insert_with(|| {
            order.push(event.topic_id.clone());
            TimelineTopicDigest {
                topic_id: event.topic_id.clone(),
                topic_title: String::new(),
                event_count: 0,
                first_occurred_at: event.occurred_at.clone(),
                last_occurred_at: String::new(),
                latest_summary: String::new(),
            }
        });
        digest.event_count += 1;
        digest.topic_title.clone_from(&event.topic_title);
        digest.last_occurred_at.clone_from(&event.occurred_at);
        digest.latest_summary = preview_text(&event.summary);
        if needle.is_some_and(|needle| event_matches_query(event, needle)) {
            matched.insert(event.topic_id.clone());
        }
    }
    let mut topics: Vec<TimelineTopicDigest> = order
        .into_iter()
        .filter(|topic_id| needle.is_none() || matched.contains(topic_id))
        .filter_map(|topic_id| digests.remove(&topic_id))
        .collect();
    topics.sort_by(|left, right| {
        right
            .last_occurred_at
            .cmp(&left.last_occurred_at)
            .then(left.topic_id.cmp(&right.topic_id))
    });
    topics
}

/// spec 262: read-only topic discovery for a lane that is about to record.
/// Without this a fresh session cannot learn a `topic_id` it did not create
/// itself, and exact-title reuse never fires across languages.
pub(crate) fn list_topics_project(
    project_dir: &Path,
    query: Option<&str>,
    limit: usize,
) -> Result<TimelineTopicListing, String> {
    let needle = topic_query(query)?;
    let limit = topic_list_limit(limit);
    let listing = scan_project(project_dir)?;
    let total_topics_all = fold_topic_digests(&listing.events, None).len();
    let mut topics = fold_topic_digests(&listing.events, needle.as_deref());
    let total_topics = topics.len();
    topics.truncate(limit);
    Ok(TimelineTopicListing {
        topics,
        total_topics,
        total_topics_all,
        truncated: total_topics > limit,
    })
}

/// spec 262: read one topic's chronology, newest first, without handing the
/// lane the full audit record of every event.
pub(crate) fn list_topic_events_project(
    project_dir: &Path,
    topic_id: &str,
    query: Option<&str>,
    limit: usize,
) -> Result<TimelineTopicEventListing, String> {
    let needle = topic_query(query)?;
    let limit = topic_list_limit(limit);
    let topic_id = validate_topic_id(topic_id)?;
    let listing = scan_project(project_dir)?;
    let topic_events: Vec<&TimelineEvent> = listing
        .events
        .iter()
        .filter(|event| event.topic_id == topic_id)
        .collect();
    let Some(newest) = topic_events.last() else {
        return Err(format!(
            "timeline topic does not exist: {topic_id}; call timeline_list without topicId to see every topic"
        ));
    };
    let topic_title = newest.topic_title.clone();
    let mut events: Vec<TimelineTopicEvent> = topic_events
        .into_iter()
        .rev()
        .filter(|event| match needle.as_deref() {
            Some(needle) => event_matches_query(event, needle),
            None => true,
        })
        .map(|event| TimelineTopicEvent {
            event_id: event.id.clone(),
            occurred_at: event.occurred_at.clone(),
            summary: event.summary.clone(),
            made_by: event.made_by.clone(),
            source_ref: event.source_ref.clone(),
            superseded: event.superseded,
        })
        .collect();
    let total_events = events.len();
    events.truncate(limit);
    Ok(TimelineTopicEventListing {
        topic_id,
        topic_title,
        events,
        total_events,
        truncated: total_events > limit,
    })
}

// ---------------------------------------------------------------------------
// Topic regrouping changes only topic_id, with byte-exact backups and lane audit.
// ---------------------------------------------------------------------------

fn backup_root(project: &Path) -> PathBuf {
    project.join(".krypton").join("timeline").join("backups")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimelineMergeManifest {
    pub schema: u8,
    pub merge_id: String,
    pub from_topic_id: String,
    pub into_topic_id: String,
    pub merged_at: String,
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_by_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone_by_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_rationale: Option<String>,
}

/// Acting lane and its reason for a grouping repair.
#[derive(Debug, Clone)]
pub struct TimelineMergeAuthorization {
    pub lane_label: String,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMergeResult {
    pub merge_id: String,
    pub from_topic_id: String,
    pub from_topic_title: String,
    pub into_topic_id: String,
    pub into_topic_title: String,
    pub moved_events: usize,
    pub backup_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMergeUndoResult {
    pub merge_id: String,
    pub from_topic_id: String,
    pub into_topic_id: String,
    pub restored_events: usize,
}

/// Accept either an exact `topic-…` ID or a unique case-insensitive substring of
/// a topic title. The browser shows titles, so requiring an ID would mean
/// reading frontmatter by hand.
fn resolve_topic_selector(
    field: &str,
    selector: &str,
    events: &[TimelineEvent],
) -> Result<(String, String), String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(format!("{field} topic is required"));
    }
    let digests = fold_topic_digests(events, None);
    if let Some(digest) = digests
        .iter()
        .find(|digest| digest.topic_id == selector.to_lowercase())
    {
        return Ok((digest.topic_id.clone(), digest.topic_title.clone()));
    }
    let needle = normalized_text(selector);
    let matches: Vec<&TimelineTopicDigest> = digests
        .iter()
        .filter(|digest| {
            normalized_text(&digest.topic_title).contains(&needle)
                || digest.topic_id.contains(&needle)
        })
        .collect();
    match matches.len() {
        0 => Err(format!("no timeline topic matches {field} {selector:?}")),
        1 => Ok((matches[0].topic_id.clone(), matches[0].topic_title.clone())),
        _ => {
            let candidates: Vec<String> = matches
                .iter()
                .take(MAX_MERGE_CANDIDATES)
                .map(|digest| format!("{} ({})", digest.topic_id, digest.topic_title))
                .collect();
            Err(format!(
                "{field} topic {selector:?} matches {} topics: {}",
                matches.len(),
                candidates.join(", ")
            ))
        }
    }
}

/// Replace only the frontmatter `topic_id` line. Everything else — including
/// body text, ordering, and line endings — is preserved byte-for-byte so the
/// rewritten file still parses and still reads as the same record.
fn rewrite_topic_id(source: &str, topic_id: &str) -> Result<String, String> {
    let value = yaml_string(topic_id)?;
    let mut out = String::with_capacity(source.len() + value.len());
    let mut in_frontmatter = false;
    let mut closed = false;
    let mut replaced = false;
    for (index, line) in source.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let trimmed = line.trim_end_matches('\r');
        if index == 0 {
            if trimmed != "---" {
                return Err("missing opening frontmatter delimiter".to_string());
            }
            in_frontmatter = true;
            out.push_str(line);
            continue;
        }
        if in_frontmatter && trimmed == "---" {
            in_frontmatter = false;
            closed = true;
            out.push_str(line);
            continue;
        }
        if in_frontmatter
            && !replaced
            && trimmed
                .split_once(':')
                .is_some_and(|(name, _)| name.trim() == "topic_id")
        {
            replaced = true;
            out.push_str("topic_id: ");
            out.push_str(&value);
            if line.ends_with('\r') {
                out.push('\r');
            }
            continue;
        }
        out.push_str(line);
    }
    if !closed {
        return Err("missing closing frontmatter delimiter".to_string());
    }
    if !replaced {
        return Err("timeline event has no topic_id field".to_string());
    }
    Ok(out)
}

fn restore_backup(
    events_root: &Path,
    backup_dir: &Path,
    files: &[String],
) -> Result<usize, String> {
    let mut snapshots = Vec::with_capacity(files.len());
    for file in files {
        let id = file
            .strip_suffix(".md")
            .ok_or_else(|| "invalid timeline backup filename".to_string())?;
        if validate_event_id(id)? != id {
            return Err("invalid timeline backup filename".to_string());
        }
        let source = read_regular_file(&backup_dir.join(file), MAX_EVENT_BYTES, "timeline backup")?;
        let destination = events_root.join(file);
        if fs::symlink_metadata(&destination).is_ok() {
            read_regular_file(&destination, MAX_EVENT_BYTES, "timeline event")?;
        }
        snapshots.push((destination, source));
    }
    let restored = snapshots.len();
    for (path, source) in snapshots {
        atomic_write(&path, source.as_bytes(), true)?;
    }
    Ok(restored)
}

fn write_manifest(path: &Path, manifest: &TimelineMergeManifest) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("failed to encode timeline merge manifest: {error}"))?;
    atomic_write(path, encoded.as_bytes(), true)
}

fn validate_merge_authorization(
    authorization: Option<TimelineMergeAuthorization>,
) -> Result<Option<TimelineMergeAuthorization>, String> {
    authorization
        .map(|authorization| {
            let rationale = validate_body("rationale", &authorization.rationale)?;
            if rationale.is_empty() {
                return Err("rationale is required".to_string());
            }
            Ok(TimelineMergeAuthorization {
                lane_label: validate_single_line(
                    "recorderLane",
                    &authorization.lane_label,
                    MAX_ACTOR_CHARS,
                )?,
                rationale,
            })
        })
        .transpose()
}

/// Move every event of one topic into another. `.krypton/` is gitignored, so the
/// backup written here is the only recovery path — it is taken, and the undo
/// manifest written, before the first rewrite.
pub(crate) fn merge_topics_project(
    project_dir: &Path,
    from_selector: &str,
    into_selector: &str,
    authorization: Option<TimelineMergeAuthorization>,
) -> Result<TimelineMergeResult, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    let authorization = validate_merge_authorization(authorization)?;
    let listing = scan_project(project_dir)?;
    if listing.events.is_empty() {
        return Err("the project timeline has no events yet".to_string());
    }
    let (from_topic_id, from_topic_title) =
        resolve_topic_selector("source", from_selector, &listing.events)?;
    let (into_topic_id, into_topic_title) =
        resolve_topic_selector("target", into_selector, &listing.events)?;
    if from_topic_id == into_topic_id {
        return Err(format!(
            "source and target resolve to the same topic: {from_topic_id}"
        ));
    }
    let files: Vec<String> = listing
        .events
        .iter()
        .filter(|event| event.topic_id == from_topic_id)
        .map(|event| format!("{}.md", event.id))
        .collect();
    if files.is_empty() {
        return Err(format!("topic {from_topic_id} has no events to move"));
    }
    let (project, events_root) = writable_event_root(project_dir)?;
    let merge_id = format!(
        "mrg-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        random_hex()?
    );
    let (_, backup_dir) = writable_confined_root(
        &project,
        backup_root(&project).join(&merge_id),
        "timeline backup",
    )?;
    for file in &files {
        let source = read_regular_file(&events_root.join(file), MAX_EVENT_BYTES, "timeline event")?;
        atomic_write(&backup_dir.join(file), source.as_bytes(), false)?;
    }
    let mut manifest = TimelineMergeManifest {
        schema: SCHEMA_VERSION,
        merge_id: merge_id.clone(),
        from_topic_id: from_topic_id.clone(),
        into_topic_id: into_topic_id.clone(),
        merged_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        files: files.clone(),
        merged_by_lane: authorization
            .as_ref()
            .map(|authorization| authorization.lane_label.clone()),
        instruction_excerpt: None,
        rationale: authorization
            .as_ref()
            .map(|authorization| authorization.rationale.clone()),
        undone_at: None,
        undone_by_lane: None,
        undo_rationale: None,
    };
    let manifest_path = backup_dir.join("manifest.json");
    write_manifest(&manifest_path, &manifest)?;
    for file in &files {
        let path = events_root.join(file);
        let rewritten = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read timeline event {file}: {error}"))
            .and_then(|source| rewrite_topic_id(&source, &into_topic_id))
            .and_then(|rewritten| atomic_write(&path, rewritten.as_bytes(), true));
        if let Err(error) = rewritten {
            // Put every file back before reporting: a half-merged topic is worse
            // than no merge at all.
            let restored = restore_backup(&events_root, &backup_dir, &files);
            manifest.undone_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
            let _ = write_manifest(&manifest_path, &manifest);
            return Err(match restored {
                Ok(_) => format!("{error}; the merge was rolled back and nothing changed"),
                Err(restore_error) => format!(
                    "{error}; automatic rollback also failed ({restore_error}) — use timeline_merge undo or restore from .krypton/timeline/backups/{merge_id}"
                ),
            });
        }
    }
    Ok(TimelineMergeResult {
        merge_id,
        from_topic_id,
        from_topic_title,
        into_topic_id,
        into_topic_title,
        moved_events: files.len(),
        backup_path: relative_path(&project, &backup_dir),
    })
}

/// Restore the most recent merge that has not been undone yet.
pub(crate) fn undo_last_merge_project(
    project_dir: &Path,
    authorization: Option<TimelineMergeAuthorization>,
) -> Result<TimelineMergeUndoResult, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    let authorization = validate_merge_authorization(authorization)?;
    let project = canonical_project(project_dir)?;
    let Some((_, root)) =
        existing_confined_root(&project, backup_root(&project), "timeline backups")?
    else {
        return Err("there is no timeline merge to undo".to_string());
    };
    let entries =
        fs::read_dir(&root).map_err(|error| format!("failed to list timeline backups: {error}"))?;
    let mut newest: Option<(TimelineMergeManifest, PathBuf)> = None;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let dir = entry.path();
        if !entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        {
            continue;
        }
        let manifest_path = dir.join("manifest.json");
        let Ok(source) = read_regular_file(&manifest_path, 256 * 1024, "timeline merge manifest")
        else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<TimelineMergeManifest>(&source) else {
            continue;
        };
        if manifest.undone_at.is_some() {
            continue;
        }
        let is_newer = match newest.as_ref() {
            Some((current, _)) => manifest.merged_at > current.merged_at,
            None => true,
        };
        if is_newer {
            newest = Some((manifest, dir));
        }
    }
    let Some((mut manifest, backup_dir)) = newest else {
        return Err("there is no timeline merge to undo".to_string());
    };
    let (_, events_root) = writable_event_root(project_dir)?;
    let restored = restore_backup(&events_root, &backup_dir, &manifest.files)?;
    manifest.undone_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
    manifest.undone_by_lane = authorization.as_ref().map(|value| value.lane_label.clone());
    manifest.undo_rationale = authorization.as_ref().map(|value| value.rationale.clone());
    write_manifest(&backup_dir.join("manifest.json"), &manifest)?;
    Ok(TimelineMergeUndoResult {
        merge_id: manifest.merge_id,
        from_topic_id: manifest.from_topic_id,
        into_topic_id: manifest.into_topic_id,
        restored_events: restored,
    })
}

/// Advisory notice when a recorded occurrence sits far in the future.
fn future_occurrence_warning(occurred_at: &str, now: DateTime<Utc>) -> Option<String> {
    let parsed = DateTime::parse_from_rfc3339(occurred_at).ok()?;
    let ahead = parsed.with_timezone(&Utc) - now;
    if ahead.num_hours() <= MAX_FUTURE_SKEW_HOURS {
        return None;
    }
    let days = ahead.num_days().max(1);
    Some(format!(
        "occurredAt is {days} day(s) in the future relative to the recording time; check it against the source you cited"
    ))
}

pub(crate) fn random_hex() -> Result<String, String> {
    let mut bytes = [0_u8; 3];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("failed to generate timeline event id: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn render_event_markdown(
    id: &str,
    recorded_at: &str,
    request: &TimelineRecordRequest,
    recorded_by: &str,
    suggestion: Option<&TimelineSuggestion>,
    evidence: Option<(TimelineEvidenceKind, &str)>,
    resolution_rationale: Option<&str>,
) -> Result<String, String> {
    let mut frontmatter = vec![
        "---".to_string(),
        format!("schema: {SCHEMA_VERSION}"),
        format!("id: {}", yaml_string(id)?),
        format!("topic_id: {}", yaml_string(&request.topic_id)?),
        format!("topic_title: {}", yaml_string(&request.topic_title)?),
        format!("kind: {}", yaml_string(kind_name(TimelineKind::Event))?),
        format!("occurred_at: {}", yaml_string(&request.occurred_at)?),
        format!("made_by: {}", yaml_string(&request.made_by)?),
        format!("recorded_at: {}", yaml_string(recorded_at)?),
        format!("recorded_by: {}", yaml_string(recorded_by)?),
        format!("recorder_lane: {}", yaml_string(&request.recorder_lane)?),
    ];
    if let Some(source_ref) = &request.source_ref {
        frontmatter.push(format!("source_ref: {}", yaml_string(source_ref)?));
    }
    if let (Some(relation), Some(related_event)) = (request.relation, &request.related_event) {
        frontmatter.push(format!(
            "relation: {}",
            yaml_string(relation_name(relation))?
        ));
        frontmatter.push(format!("related_event: {}", yaml_string(related_event)?));
    }
    if let Some(suggestion) = suggestion {
        frontmatter.push(format!(
            "suggested_by_lane: {}",
            yaml_string(&suggestion.suggested_by_lane)?
        ));
        frontmatter.push(format!("suggestion_id: {}", yaml_string(&suggestion.id)?));
        frontmatter.push(format!(
            "suggested_at: {}",
            yaml_string(&suggestion.suggested_at)?
        ));
    }
    if let Some((kind, _)) = evidence {
        frontmatter.push(format!(
            "evidence_kind: {}",
            serde_json::to_string(&kind)
                .map_err(|error| format!("failed to encode evidence kind: {error}"))?
        ));
    }
    if let Some(rationale) = resolution_rationale {
        frontmatter.push(format!("resolution_rationale: {}", yaml_string(rationale)?));
    }
    frontmatter.push("---".to_string());
    let mut sections = vec![frontmatter.join("\n"), format!("# {}", request.summary)];
    if let Some((_, excerpt)) = evidence {
        sections.push(format!("## Evidence\n{excerpt}"));
    }
    sections.push(format!("## Rationale\n{}", request.rationale));
    sections.push(format!("## Impact\n{}", request.impact));
    Ok(format!("{}\n", sections.join("\n\n")))
}

#[cfg(test)]
fn validate_record_request(
    project_dir: &Path,
    mut request: TimelineRecordRequest,
) -> Result<TimelineRecordRequest, String> {
    request.topic_id = validate_topic_id(&request.topic_id)?;
    request.topic_title =
        validate_single_line("topicTitle", &request.topic_title, MAX_TOPIC_CHARS)?;
    request.summary = validate_single_line("summary", &request.summary, MAX_SUMMARY_CHARS)?;
    request.made_by = validate_single_line("madeBy", &request.made_by, MAX_ACTOR_CHARS)?;
    request.recorder_lane =
        validate_single_line("recorderLane", &request.recorder_lane, MAX_ACTOR_CHARS)?;
    request.rationale = validate_body("rationale", &request.rationale)?;
    request.impact = validate_body("impact", &request.impact)?;
    request.source_ref =
        validate_optional_single_line("sourceRef", request.source_ref, MAX_SOURCE_CHARS)?;
    DateTime::parse_from_rfc3339(&request.occurred_at)
        .map_err(|error| format!("occurredAt must be RFC 3339: {error}"))?;
    if request.relation.is_some() != request.related_event.is_some() {
        return Err("relation and relatedEvent must be supplied together".to_string());
    }
    if let Some(related) = request.related_event.take() {
        request.related_event = Some(validate_event_id(&related)?);
    }
    let existing = scan_project(project_dir)?;
    if let Some(related) = &request.related_event {
        if !existing.events.iter().any(|event| &event.id == related) {
            return Err(format!("related timeline event does not exist: {related}"));
        }
    }
    Ok(request)
}

/// Test-only legacy fixture writer shared by native history consumers.
#[cfg(test)]
pub(crate) fn record_project(
    project_dir: &Path,
    request: TimelineRecordRequest,
) -> Result<TimelineEvent, String> {
    let request = validate_record_request(project_dir, request)?;
    write_new_event(project_dir, &request, "Local user", None)
}

fn write_new_event(
    project_dir: &Path,
    request: &TimelineRecordRequest,
    recorded_by: &str,
    evidence: Option<(TimelineEvidenceKind, &str)>,
) -> Result<TimelineEvent, String> {
    let (project, root) = writable_event_root(project_dir)?;
    let recorded_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    for _ in 0..10 {
        let id = format!(
            "tl-{}-{}",
            Utc::now().format("%Y%m%dT%H%M%SZ"),
            random_hex()?
        );
        let path = root.join(format!("{id}.md"));
        let markdown = render_event_markdown(
            &id,
            &recorded_at,
            request,
            recorded_by,
            None,
            evidence,
            None,
        )?;
        if fs::symlink_metadata(&path).is_ok() {
            continue;
        }
        if markdown.len() as u64 > MAX_EVENT_BYTES {
            return Err(format!("timeline event exceeds {MAX_EVENT_BYTES} bytes"));
        }
        let event = parse_event(&project, &path, &markdown)?;
        atomic_write(&path, markdown.as_bytes(), false)?;
        return Ok(event);
    }
    Err("failed to allocate a unique timeline event id".to_string())
}

pub(crate) fn normalized_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn topic_title_id(title: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() && slug.chars().count() < 56 {
                slug.push('-');
            }
            pending_dash = false;
            if slug.chars().count() < 56 {
                slug.push(ch);
            }
        } else if !slug.is_empty() {
            pending_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if !slug.is_empty() {
        return format!("topic-{slug}");
    }
    format!("topic-{:08x}", title_hash(title))
}

fn title_hash(title: &str) -> u32 {
    title.chars().fold(0x811c9dc5_u32, |hash, ch| {
        (hash ^ ch as u32).wrapping_mul(0x01000193)
    })
}

fn direct_topic_id(title: &str, events: &[TimelineEvent]) -> String {
    let normalized = normalized_text(title);
    if let Some(existing) = events
        .iter()
        .rev()
        .find(|event| normalized_text(&event.topic_title) == normalized)
    {
        return existing.topic_id.clone();
    }
    let base = topic_title_id(title);
    if !events.iter().any(|event| event.topic_id == base) {
        return base;
    }
    let hashed = format!("{base}-{:06x}", title_hash(title) >> 8);
    if !events.iter().any(|event| event.topic_id == hashed) {
        return hashed;
    }
    for suffix in 2..=999 {
        let candidate = format!("{hashed}-{suffix}");
        if !events.iter().any(|event| event.topic_id == candidate) {
            return candidate;
        }
    }
    hashed
}

fn resolve_direct_topic_id(
    requested_topic_id: Option<&str>,
    topic_title: &str,
    events: &[TimelineEvent],
) -> Result<String, String> {
    let Some(topic_id) = requested_topic_id else {
        return Ok(direct_topic_id(topic_title, events));
    };
    if events.iter().any(|event| event.topic_id == topic_id) {
        Ok(topic_id.to_string())
    } else {
        Err(format!(
            "timeline topic does not exist: {topic_id}; omit topicId to create a new topic or use an existing timeline topic id"
        ))
    }
}

fn validate_direct_request(
    mut request: TimelineDirectRecordRequest,
) -> Result<TimelineDirectRecordRequest, String> {
    request.topic_id = request
        .topic_id
        .take()
        .map(|value| validate_topic_id(&value))
        .transpose()?;
    request.topic_title =
        validate_single_line("topicTitle", &request.topic_title, MAX_TOPIC_CHARS)?;
    request.summary = validate_single_line("summary", &request.summary, MAX_SUMMARY_CHARS)?;
    request.made_by = validate_single_line("madeBy", &request.made_by, MAX_ACTOR_CHARS)?;
    request.evidence_excerpt = validate_body_with_limit(
        "evidenceExcerpt",
        &request.evidence_excerpt,
        MAX_EVIDENCE_CHARS,
    )?;
    if request.evidence_excerpt.is_empty() {
        return Err("evidenceExcerpt is required".to_string());
    }
    request.rationale = validate_body("rationale", &request.rationale)?;
    request.impact = validate_body("impact", &request.impact)?;
    request.source_ref =
        validate_optional_single_line("sourceRef", request.source_ref, MAX_SOURCE_CHARS)?;
    request.occurred_at = match request.occurred_at {
        Some(value) if value.trim().is_empty() => None,
        Some(value) => {
            DateTime::parse_from_rfc3339(value.trim())
                .map_err(|error| format!("occurredAt must be RFC 3339: {error}"))?;
            Some(value.trim().to_string())
        }
        None => None,
    };
    if request.relation.is_some() != request.related_event.is_some() {
        return Err("relation and relatedEvent must be supplied together".to_string());
    }
    if let Some(related) = request.related_event.take() {
        request.related_event = Some(validate_event_id(&related)?);
    }
    Ok(request)
}

fn direct_event_matches(
    event: &TimelineEvent,
    topic_id: &str,
    request: &TimelineDirectRecordRequest,
) -> bool {
    event.topic_id == topic_id
        && normalized_text(&event.summary) == normalized_text(&request.summary)
        && event.evidence_kind == Some(request.evidence_kind)
        && event.evidence_excerpt.as_deref().is_some_and(|value| {
            normalized_text(value) == normalized_text(&request.evidence_excerpt)
        })
        && event.source_ref.as_deref().map(normalized_text)
            == request.source_ref.as_deref().map(normalized_text)
}

pub(crate) fn record_direct_project(
    project_dir: &Path,
    lane_label: &str,
    request: TimelineDirectRecordRequest,
) -> Result<TimelineDirectRecordResult, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    let request = validate_direct_request(request)?;
    let lane_label = validate_single_line("recorderLane", lane_label, MAX_ACTOR_CHARS)?;
    if !settings_project_locked(project_dir)?.automatic_recording {
        return Err("automatic timeline recording is disabled for this project".to_string());
    }
    if let Some(related) = &request.related_event {
        event_detail_project(project_dir, related)?;
    }
    let listing = scan_project(project_dir)?;
    let topic_id = resolve_direct_topic_id(
        request.topic_id.as_deref(),
        &request.topic_title,
        &listing.events,
    )?;
    // spec 262: a topic nobody has written to yet means the lane is opening a
    // second chronology for a subject that may already have one. The ack says
    // so and names the alternatives; nothing is merged here.
    let new_topic = !listing
        .events
        .iter()
        .any(|event| event.topic_id == topic_id);
    let existing_topics = if new_topic {
        fold_topic_digests(&listing.events, None)
            .into_iter()
            .take(MAX_RECORD_ACK_TOPICS)
            .map(|digest| TimelineTopicRef {
                topic_id: digest.topic_id,
                topic_title: digest.topic_title,
                event_count: digest.event_count,
                last_occurred_at: digest.last_occurred_at,
            })
            .collect()
    } else {
        Vec::new()
    };
    let now = Utc::now();
    if let Some(event) = listing
        .events
        .iter()
        .find(|event| direct_event_matches(event, &topic_id, &request))
    {
        let warnings = future_occurrence_warning(&event.occurred_at, now)
            .into_iter()
            .collect();
        return Ok(TimelineDirectRecordResult {
            event: event.clone(),
            disposition: TimelineDirectRecordDisposition::Existing,
            new_topic: false,
            existing_topics: Vec::new(),
            warnings,
        });
    }
    let record_request = direct_record_request(
        &request,
        topic_id,
        &lane_label,
        request
            .occurred_at
            .clone()
            .unwrap_or_else(|| now.to_rfc3339_opts(SecondsFormat::Secs, true)),
    );
    let event = write_new_event(
        project_dir,
        &record_request,
        "Agent",
        Some((request.evidence_kind, &request.evidence_excerpt)),
    )?;
    let warnings = future_occurrence_warning(&event.occurred_at, now)
        .into_iter()
        .collect();
    Ok(TimelineDirectRecordResult {
        event,
        disposition: TimelineDirectRecordDisposition::Created,
        new_topic,
        existing_topics,
        warnings,
    })
}

fn direct_record_request(
    request: &TimelineDirectRecordRequest,
    topic_id: String,
    lane_label: &str,
    occurred_at: String,
) -> TimelineRecordRequest {
    TimelineRecordRequest {
        topic_id,
        topic_title: request.topic_title.clone(),
        summary: request.summary.clone(),
        occurred_at,
        made_by: if request.evidence_kind == TimelineEvidenceKind::AgentDecision {
            lane_label.to_string()
        } else {
            request.made_by.clone()
        },
        rationale: request.rationale.clone(),
        impact: request.impact.clone(),
        source_ref: request.source_ref.clone(),
        relation: request.relation,
        related_event: request.related_event.clone(),
        recorder_lane: lane_label.to_string(),
    }
}

pub(crate) fn settings_project(project_dir: &Path) -> Result<TimelineSettings, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    settings_project_locked(project_dir)
}

fn settings_project_locked(project_dir: &Path) -> Result<TimelineSettings, String> {
    let project = canonical_project(project_dir)?;
    let Some((_, root)) = existing_confined_root(
        &project,
        project.join(".krypton").join("timeline"),
        "timeline",
    )?
    else {
        return Ok(TimelineSettings::default());
    };
    let path = root.join("settings.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TimelineSettings::default());
        }
        Err(error) => return Err(format!("failed to inspect timeline settings: {error}")),
        Ok(_) => {}
    }
    let source = read_regular_file(&path, 16 * 1024, "timeline settings")?;
    let stored: serde_json::Value = serde_json::from_str(&source)
        .map_err(|error| format!("invalid timeline settings: {error}"))?;
    let (key, migrate) = match stored.get("schema").and_then(serde_json::Value::as_u64) {
        Some(1) => ("automaticSuggestions", true),
        Some(2) => ("automaticRecording", false),
        _ => return Err("unsupported timeline settings schema".to_string()),
    };
    let enabled = stored
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| format!("invalid timeline settings: {key} must be a boolean"))?;
    if migrate {
        write_settings_locked(&project, enabled)?;
    }
    Ok(TimelineSettings {
        automatic_recording: enabled,
    })
}

fn write_settings_locked(project_dir: &Path, enabled: bool) -> Result<TimelineSettings, String> {
    let payload = serde_json::to_vec_pretty(&serde_json::json!({
        "schema": 2,
        "automaticRecording": enabled,
    }))
    .map_err(|error| format!("failed to encode timeline settings: {error}"))?;
    let (project, _) = writable_confined_root(
        project_dir,
        project_dir.join(".krypton").join("timeline"),
        "timeline",
    )?;
    atomic_write(&settings_path(&project), &payload, true)?;
    Ok(TimelineSettings {
        automatic_recording: enabled,
    })
}

pub(crate) fn set_enabled_project(
    project_dir: &Path,
    enabled: bool,
) -> Result<TimelineSettings, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    settings_project_locked(project_dir)?;
    write_settings_locked(project_dir, enabled)
}

pub(crate) fn event_detail_project(
    project_dir: &Path,
    event_id: &str,
) -> Result<TimelineEvent, String> {
    let event_id = validate_event_id(event_id)?;
    let (project, root) = existing_event_root(project_dir)?
        .ok_or_else(|| format!("timeline event does not exist: {event_id}"))?;
    let path = root.join(format!("{event_id}.md"));
    let source = read_regular_file(&path, MAX_EVENT_BYTES, "timeline event")?;
    let mut event = parse_event(&project, &path, &source)?;
    event.superseded = event_is_superseded(&project, &root, &event_id)?;
    Ok(event)
}

/// Supersession is derived, not event content. Inspect only headers of other
/// files; load a second event body only when it actually claims this relation.
fn event_is_superseded(project: &Path, root: &Path, event_id: &str) -> Result<bool, String> {
    let entries =
        fs::read_dir(root).map_err(|error| format!("failed to list timeline events: {error}"))?;
    for entry in entries.take(MAX_EVENTS).flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md")
            || !entry
                .file_type()
                .is_ok_and(|kind| kind.is_file() && !kind.is_symlink())
            || !entry
                .metadata()
                .is_ok_and(|metadata| metadata.len() <= MAX_EVENT_BYTES)
        {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        let mut reader = std::io::BufReader::new(file).take(MAX_EVENT_BYTES);
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.trim_end() != "---" {
            continue;
        }
        let mut supersedes = false;
        let mut related = false;
        let mut closed = false;
        loop {
            line.clear();
            if !reader.read_line(&mut line).is_ok_and(|count| count > 0) {
                break;
            }
            if line.trim_end() == "---" {
                closed = true;
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                match name.trim() {
                    "relation" => {
                        supersedes = serde_json::from_str::<String>(value.trim())
                            .is_ok_and(|value| value == "supersedes")
                    }
                    "related_event" => {
                        related = serde_json::from_str::<String>(value.trim())
                            .is_ok_and(|value| value == event_id)
                    }
                    _ => {}
                }
            }
        }
        if closed
            && supersedes
            && related
            && read_regular_file(&path, MAX_EVENT_BYTES, "timeline event")
                .and_then(|source| parse_event(project, &path, &source))
                .is_ok()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn receipt_result(
    project: &Path,
    receipt: &TimelinePendingReceipt,
) -> Result<TimelinePendingResolveResult, String> {
    if receipt.schema != 1 {
        return Err("unsupported timeline resolution schema".to_string());
    }
    validate_event_id(&receipt.pending_id)?;
    validate_single_line("resolvedByLane", &receipt.resolved_by_lane, MAX_ACTOR_CHARS)?;
    if validate_body("rationale", &receipt.rationale)?.is_empty() {
        return Err("resolution rationale is required".to_string());
    }
    DateTime::parse_from_rfc3339(&receipt.resolved_at)
        .map_err(|error| format!("invalid resolution time: {error}"))?;
    parse_suggestion(
        project,
        &pending_root(project).join(format!("{}.md", receipt.pending_id)),
        &receipt.original_candidate,
    )?;
    let event = match (receipt.outcome, receipt.event_id.as_deref()) {
        (TimelinePendingOutcome::Discard, None) => None,
        (TimelinePendingOutcome::Record | TimelinePendingOutcome::Duplicate, Some(id)) => {
            let event = event_detail_project(project, id)?;
            if receipt.outcome == TimelinePendingOutcome::Record
                && (event.id != receipt.pending_id
                    || event.suggestion_id.as_deref() != Some(receipt.pending_id.as_str()))
            {
                return Err("resolution event does not match its pending candidate".to_string());
            }
            Some(event)
        }
        _ => return Err("resolution outcome and event id do not agree".to_string()),
    };
    // A committed receipt is the terminal winner. Only its original candidate
    // may be removed; an externally replaced file is kept for diagnosis.
    if let Some((_, pending)) =
        existing_confined_root(project, pending_root(project), "timeline pending")?
    {
        let path = pending.join(format!("{}.md", receipt.pending_id));
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "resolution saved but pending cleanup failed: {error}"
                ))
            }
            Ok(_) => {
                let source =
                    read_regular_file(&path, MAX_EVENT_BYTES, "resolved timeline candidate")?;
                if source != receipt.original_candidate {
                    return Err("resolution saved but pending candidate changed; original receipt preserved".to_string());
                }
                #[cfg(test)]
                tests::storage_failure(&path, "cleanup")?;
                fs::remove_file(&path).map_err(|error| {
                    format!("resolution saved but pending cleanup failed: {error}")
                })?;
                sync_directory(&pending).map_err(|error| {
                    format!("resolution saved but pending directory flush failed: {error}")
                })?;
            }
        }
    }
    Ok(TimelinePendingResolveResult {
        pending_id: receipt.pending_id.clone(),
        outcome: receipt.outcome,
        event_id: receipt.event_id.clone(),
        resolution_path: relative_path(
            project,
            &resolution_root(project).join(format!("{}.json", receipt.pending_id)),
        ),
        remaining_pending: pending_count_project(project)?,
        event,
    })
}

pub(crate) fn resolve_pending_project(
    project_dir: &Path,
    lane_label: &str,
    request: TimelinePendingResolveRequest,
) -> Result<TimelinePendingResolveResult, String> {
    let pending_id = validate_event_id(&request.pending_id)?;
    let lane_label = validate_single_line("recorderLane", lane_label, MAX_ACTOR_CHARS)?;
    let rationale = validate_body("rationale", &request.rationale)?;
    if rationale.is_empty() {
        return Err("rationale is required".to_string());
    }
    match (request.outcome, request.record.is_some(), request.event_id.is_some()) {
        (TimelinePendingOutcome::Record, true, false)
        | (TimelinePendingOutcome::Duplicate, false, true)
        | (TimelinePendingOutcome::Discard, false, false) => {}
        _ => return Err("record requires only record; duplicate requires only event_id; discard accepts neither".to_string()),
    }
    if let Some(id) = &request.event_id {
        validate_event_id(id)?;
    }
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    let project = canonical_project(project_dir)?;
    if let Some((_, root)) =
        existing_confined_root(&project, resolution_root(&project), "timeline resolutions")?
    {
        let path = root.join(format!("{pending_id}.json"));
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to inspect timeline resolution: {error}")),
            Ok(_) => {
                let source = read_regular_file(&path, 128 * 1024, "timeline resolution")?;
                let receipt: TimelinePendingReceipt = serde_json::from_str(&source)
                    .map_err(|error| format!("invalid timeline resolution: {error}"))?;
                if receipt.pending_id != pending_id {
                    return Err("timeline resolution id does not match its file name".to_string());
                }
                return receipt_result(&project, &receipt);
            }
        }
    }
    let (_, pending) =
        existing_confined_root(&project, pending_root(&project), "timeline pending")?
            .ok_or_else(|| format!("timeline pending candidate does not exist: {pending_id}"))?;
    let pending_path = pending.join(format!("{pending_id}.md"));
    let original_candidate =
        read_regular_file(&pending_path, MAX_EVENT_BYTES, "timeline candidate")?;
    let candidate = parse_suggestion(&project, &pending_path, &original_candidate)?;
    let mut receipt = TimelinePendingReceipt {
        schema: 1,
        pending_id: pending_id.clone(),
        outcome: request.outcome,
        event_id: request.event_id.clone(),
        rationale,
        resolved_by_lane: lane_label.clone(),
        resolved_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        original_candidate,
    };
    let event_path = event_root(&project).join(format!("{pending_id}.md"));
    let mut saved_event = None;
    if let Some((_, events)) = existing_event_root(&project)? {
        let path = events.join(format!("{pending_id}.md"));
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "failed to inspect reserved timeline event: {error}"
                ))
            }
            Ok(_) => {
                let source = read_regular_file(&path, MAX_EVENT_BYTES, "reserved timeline event")?;
                let event = parse_event(&project, &path, &source)?;
                if event.suggestion_id.as_deref() == Some(pending_id.as_str()) {
                    // The event is already durable, even if its receipt write
                    // failed. Preserve the first lane's decision on any retry.
                    receipt.outcome = TimelinePendingOutcome::Record;
                    receipt.event_id = Some(event.id.clone());
                    receipt.resolved_by_lane = event.recorder_lane.clone();
                    receipt.resolved_at = event.recorded_at.clone();
                    if let Some(value) = source
                        .lines()
                        .skip(1)
                        .take_while(|line| *line != "---")
                        .find_map(|line| line.strip_prefix("resolution_rationale: "))
                    {
                        receipt.rationale = serde_json::from_str(value).map_err(|error| {
                            format!("invalid saved resolution rationale: {error}")
                        })?;
                    }
                    saved_event = Some(event);
                } else if receipt.outcome == TimelinePendingOutcome::Record {
                    return Err(format!(
                        "timeline event id is already used by another record: {pending_id}"
                    ));
                }
            }
        }
    }
    let mut markdown = None;
    if saved_event.is_none() {
        match receipt.outcome {
            TimelinePendingOutcome::Record => {
                let record = request
                    .record
                    .ok_or_else(|| "record outcome requires record data".to_string())?;
                let record = validate_direct_request(record)?;
                if let Some(related) = &record.related_event {
                    event_detail_project(&project, related)?;
                }
                let listing = scan_project(&project)?;
                let topic_id = resolve_direct_topic_id(
                    record.topic_id.as_deref(),
                    &record.topic_title,
                    &listing.events,
                )?;
                let record_request = direct_record_request(
                    &record,
                    topic_id,
                    &lane_label,
                    candidate.occurred_at.clone(),
                );
                let source = render_event_markdown(
                    &pending_id,
                    &receipt.resolved_at,
                    &record_request,
                    "Agent",
                    Some(&candidate),
                    Some((record.evidence_kind, &record.evidence_excerpt)),
                    Some(&receipt.rationale),
                )?;
                if source.len() as u64 > MAX_EVENT_BYTES {
                    return Err(format!("timeline event exceeds {MAX_EVENT_BYTES} bytes"));
                }
                parse_event(&project, &event_path, &source)?;
                markdown = Some(source);
                receipt.event_id = Some(pending_id.clone());
            }
            TimelinePendingOutcome::Duplicate => {
                let event_id = receipt
                    .event_id
                    .as_deref()
                    .ok_or_else(|| "duplicate outcome requires an event id".to_string())?;
                event_detail_project(&project, event_id)?;
            }
            TimelinePendingOutcome::Discard => {}
        }
    }
    receipt.rationale = validate_body("rationale", &receipt.rationale)?;
    if receipt.rationale.is_empty() {
        return Err("resolution rationale is required".to_string());
    }
    // Everything fallible to validate/serialize is prepared before publication.
    let encoded = serde_json::to_vec_pretty(&receipt)
        .map_err(|error| format!("failed to encode timeline resolution: {error}"))?;
    if encoded.len() > 128 * 1024 {
        return Err("timeline resolution is too large".to_string());
    }
    let (_, resolutions) =
        writable_confined_root(&project, resolution_root(&project), "timeline resolutions")?;
    if let Some(source) = markdown {
        writable_event_root(&project)?;
        atomic_write(&event_path, source.as_bytes(), false)?;
    }
    atomic_write(
        &resolutions.join(format!("{pending_id}.json")),
        &encoded,
        false,
    )?;
    receipt_result(&project, &receipt)
}

pub(crate) fn project_dir(
    hook_server: &tauri::State<'_, Arc<HookServer>>,
    harness_id: &str,
) -> Result<PathBuf, String> {
    hook_server
        .project_dir_for_harness(harness_id)
        .ok_or_else(|| format!("no project directory is registered for harness {harness_id}"))
}

#[tauri::command]
pub fn timeline_settings(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineSettings, String> {
    settings_project(&project_dir(&hook_server, &harness_id)?)
}

#[tauri::command]
pub fn timeline_set_enabled(
    harness_id: String,
    enabled: bool,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineSettings, String> {
    set_enabled_project(&project_dir(&hook_server, &harness_id)?, enabled)
}

#[tauri::command]
pub fn timeline_pending_count(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<usize, String> {
    pending_count_project(&project_dir(&hook_server, &harness_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("krypton-timeline-{label}-{nonce}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request() -> TimelineRecordRequest {
        TimelineRecordRequest {
            topic_id: "topic-upload-validation".to_string(),
            topic_title: "Upload validation".to_string(),
            summary: "Metadata transfer is required".to_string(),
            occurred_at: "2026-09-18T08:20:00Z".to_string(),
            made_by: "Product owner".to_string(),
            rationale: "The consumer needs metadata.".to_string(),
            impact: "Revise completion handling.".to_string(),
            source_ref: Some("docs/0253-project-decision-requirement-timeline.md".to_string()),
            relation: None,
            related_event: None,
            recorder_lane: "Codex-1".to_string(),
        }
    }

    fn seed_pending(project: &Path, index: usize) -> (TimelineSuggestion, String) {
        let id = format!("tl-20260918T082000Z-{index:06}");
        let root = pending_root(project);
        fs::create_dir_all(&root).unwrap();
        let path = root.join(format!("{id}.md"));
        let source = format!(
            "---\nschema: 1\nid: \"{id}\"\nstatus: \"pending\"\ntopic_title: \"Upload validation\"\noccurred_at: \"2026-09-18T08:20:00Z\"\nmade_by: \"Product owner\"\nsuggested_at: \"2026-09-18T08:{index:02}:00Z\"\nsuggested_by_lane: \"Codex-1\"\nsource_ref: \"conversation:turn-4\"\n---\n# Metadata transfer is required\n\n## Evidence\nWe require metadata transfer before completion.\n\n## Rationale\nThe consumer needs metadata.\n\n## Impact\nRevise completion handling.\n"
        );
        fs::write(&path, &source).unwrap();
        (parse_suggestion(project, &path, &source).unwrap(), source)
    }

    fn resolution(
        candidate: &TimelineSuggestion,
        outcome: TimelinePendingOutcome,
    ) -> TimelinePendingResolveRequest {
        TimelinePendingResolveRequest {
            pending_id: candidate.id.clone(),
            outcome,
            rationale: "ตรวจหลักฐานและประวัติที่เกี่ยวข้องแล้ว".to_string(),
            record: (outcome == TimelinePendingOutcome::Record).then(direct_request),
            event_id: None,
        }
    }

    thread_local! {
        static STORAGE_FAILURE: std::cell::RefCell<Option<(PathBuf, &'static str)>> =
            const { std::cell::RefCell::new(None) };
    }

    fn fail_once(path: PathBuf, operation: &'static str) {
        let path = path
            .parent()
            .unwrap()
            .canonicalize()
            .unwrap()
            .join(path.file_name().unwrap());
        STORAGE_FAILURE.with(|failure| *failure.borrow_mut() = Some((path, operation)));
    }

    pub(super) fn storage_failure(path: &Path, operation: &str) -> Result<(), String> {
        STORAGE_FAILURE.with(|failure| {
            let mut failure = failure.borrow_mut();
            if failure
                .as_ref()
                .is_some_and(|(target, phase)| target == path && *phase == operation)
            {
                failure.take();
                Err(format!("injected timeline {operation} failure"))
            } else {
                Ok(())
            }
        })
    }

    fn direct_request() -> TimelineDirectRecordRequest {
        TimelineDirectRecordRequest {
            topic_id: None,
            topic_title: "Upload validation".to_string(),
            summary: "Metadata transfer is required".to_string(),
            made_by: "Product owner".to_string(),
            evidence_kind: TimelineEvidenceKind::UserStatement,
            evidence_excerpt: "We require metadata transfer before completion.".to_string(),
            occurred_at: Some("2026-09-18T08:20:00Z".to_string()),
            rationale: "The consumer needs metadata.".to_string(),
            impact: "Revise completion handling.".to_string(),
            source_ref: Some("conversation:turn-5".to_string()),
            relation: None,
            related_event: None,
        }
    }

    #[test]
    fn record_and_scan_round_trip_local_markdown() {
        let dir = TestDir::new("round-trip");
        let saved = record_project(&dir.0, request()).unwrap();
        assert!(saved.path.starts_with(".krypton/timeline/events/tl-"));
        assert_eq!(saved.recorded_by, "Local user");
        let body = fs::read_to_string(dir.0.join(&saved.path)).unwrap();
        assert_eq!(saved.kind, TimelineKind::Event);
        assert!(body.contains("kind: \"event\""));
        assert!(body.contains("recorded_by: \"Local user\""));
        assert!(body.contains("# Metadata transfer is required"));

        let listing = scan_project(&dir.0).unwrap();
        assert_eq!(listing.diagnostics, Vec::<TimelineDiagnostic>::new());
        assert_eq!(listing.events, vec![saved]);
    }

    #[test]
    fn scans_typed_records_created_before_kind_was_hidden() {
        let dir = TestDir::new("legacy-kind");
        let saved = record_project(&dir.0, request()).unwrap();
        let path = dir.0.join(&saved.path);
        let source = fs::read_to_string(&path).unwrap();
        fs::write(
            &path,
            source.replace("kind: \"event\"", "kind: \"decision\""),
        )
        .unwrap();

        let listing = scan_project(&dir.0).unwrap();
        assert_eq!(listing.diagnostics, Vec::<TimelineDiagnostic>::new());
        assert_eq!(listing.events.len(), 1);
        assert_eq!(listing.events[0].kind, TimelineKind::Decision);
    }

    #[test]
    fn supersession_is_derived_without_mutating_old_record() {
        let dir = TestDir::new("supersedes");
        let first = record_project(&dir.0, request()).unwrap();
        let first_body = fs::read_to_string(dir.0.join(&first.path)).unwrap();
        let mut replacement = request();
        replacement.summary = "Metadata and checksum are required".to_string();
        replacement.relation = Some(TimelineRelation::Supersedes);
        replacement.related_event = Some(first.id.clone());
        record_project(&dir.0, replacement).unwrap();

        let listing = scan_project(&dir.0).unwrap();
        assert_eq!(listing.events.len(), 2);
        assert!(
            listing
                .events
                .iter()
                .find(|event| event.id == first.id)
                .unwrap()
                .superseded
        );
        assert_eq!(
            fs::read_to_string(dir.0.join(&first.path)).unwrap(),
            first_body
        );
    }

    #[test]
    fn rejects_missing_related_event_and_unpaired_relation() {
        let dir = TestDir::new("relations");
        let mut missing = request();
        missing.relation = Some(TimelineRelation::Refines);
        assert!(record_project(&dir.0, missing)
            .unwrap_err()
            .contains("supplied together"));

        let mut unknown = request();
        unknown.relation = Some(TimelineRelation::Refines);
        unknown.related_event = Some("tl-20260918T000000Z-abcdef".to_string());
        assert!(record_project(&dir.0, unknown)
            .unwrap_err()
            .contains("does not exist"));
    }

    #[test]
    fn malformed_files_are_diagnostics_not_events() {
        let dir = TestDir::new("malformed");
        let root = event_root(&dir.0);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("tl-bad.md"), "not frontmatter").unwrap();
        let listing = scan_project(&dir.0).unwrap();
        assert!(listing.events.is_empty());
        assert_eq!(listing.diagnostics.len(), 1);
        assert!(listing.diagnostics[0].error.contains("frontmatter"));
    }

    #[test]
    fn missing_hand_edited_relation_is_reported() {
        let dir = TestDir::new("missing-relation");
        let saved = record_project(&dir.0, request()).unwrap();
        let path = dir.0.join(&saved.path);
        let source = fs::read_to_string(&path).unwrap();
        let changed = source.replace(
            "recorder_lane: \"Codex-1\"",
            "recorder_lane: \"Codex-1\"\nrelation: \"refines\"\nrelated_event: \"tl-20260918T000000Z-abcdef\"",
        );
        fs::write(path, changed).unwrap();
        let listing = scan_project(&dir.0).unwrap();
        assert_eq!(listing.events.len(), 1);
        assert_eq!(listing.diagnostics.len(), 1);
        assert!(listing.diagnostics[0].error.contains("does not exist"));
    }

    #[test]
    fn validates_fields_before_writing() {
        let dir = TestDir::new("validation");
        let mut invalid = request();
        invalid.made_by = "\n".to_string();
        assert_eq!(
            record_project(&dir.0, invalid).unwrap_err(),
            "madeBy is required"
        );
        assert!(!event_root(&dir.0).exists());

        let mut reserved_heading = request();
        reserved_heading.rationale = "Context\n## Impact\nInjected section".to_string();
        assert!(record_project(&dir.0, reserved_heading)
            .unwrap_err()
            .contains("reserved timeline section headings"));
    }

    #[test]
    fn direct_record_preserves_evidence_and_agent_provenance_and_retries() {
        let dir = TestDir::new("direct-record");
        let created = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        assert_eq!(
            created.disposition,
            TimelineDirectRecordDisposition::Created
        );
        assert_eq!(created.event.recorded_by, "Agent");
        assert_eq!(created.event.recorder_lane, "Codex-2");
        assert_eq!(created.event.topic_id, "topic-upload-validation");
        assert_eq!(
            created.event.evidence_kind,
            Some(TimelineEvidenceKind::UserStatement)
        );
        assert_eq!(
            created.event.evidence_excerpt.as_deref(),
            Some(direct_request().evidence_excerpt.as_str())
        );
        assert!(created.event.instruction_excerpt.is_none());
        assert_eq!(
            event_detail_project(&dir.0, &created.event.id).unwrap(),
            created.event
        );

        let retried = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        assert_eq!(
            retried.disposition,
            TimelineDirectRecordDisposition::Existing
        );
        assert_eq!(retried.event.id, created.event.id);
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 1);
    }

    #[test]
    fn direct_record_reuses_explicit_topic_id_across_title_changes() {
        let dir = TestDir::new("direct-topic-id");
        let first = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();

        let mut second_request = direct_request();
        second_request.topic_id = Some(first.event.topic_id.clone());
        second_request.topic_title = "Upload metadata requirement refined".to_string();
        second_request.summary = "Metadata is checked before completion".to_string();
        second_request.occurred_at = Some("2026-09-19T08:20:00Z".to_string());
        second_request.source_ref = Some("conversation:turn-6".to_string());
        let second = record_direct_project(&dir.0, "Claude-1", second_request.clone()).unwrap();

        assert_eq!(second.disposition, TimelineDirectRecordDisposition::Created);
        assert_eq!(second.event.topic_id, first.event.topic_id);
        assert_eq!(
            second.event.topic_title,
            "Upload metadata requirement refined"
        );
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 2);

        second_request.topic_title = "Another wording for the same topic".to_string();
        let retried = record_direct_project(&dir.0, "Claude-1", second_request).unwrap();
        assert_eq!(
            retried.disposition,
            TimelineDirectRecordDisposition::Existing
        );
        assert_eq!(retried.event.id, second.event.id);
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 2);
    }

    #[test]
    fn direct_record_rejects_unknown_explicit_topic_id_without_writing() {
        let dir = TestDir::new("direct-unknown-topic-id");
        let mut request = direct_request();
        request.topic_id = Some("topic-missing".to_string());

        let error = record_direct_project(&dir.0, "Codex-2", request).unwrap_err();
        assert!(error.contains("timeline topic does not exist: topic-missing"));
        assert!(scan_project(&dir.0).unwrap().events.is_empty());
    }

    #[test]
    fn topic_listing_groups_by_id_and_reports_bounds() {
        let dir = TestDir::new("topic-listing");
        let first = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();

        let mut follow_up = direct_request();
        follow_up.topic_id = Some(first.event.topic_id.clone());
        follow_up.topic_title = "Upload validation refined".to_string();
        follow_up.summary = "Metadata is checked before completion".to_string();
        follow_up.occurred_at = Some("2026-09-19T08:20:00Z".to_string());
        record_direct_project(&dir.0, "Claude-1", follow_up).unwrap();

        let mut other = direct_request();
        other.topic_title = "Session resume".to_string();
        other.summary = "Lanes resume from the stored session id".to_string();
        other.occurred_at = Some("2026-09-20T08:20:00Z".to_string());
        let other = record_direct_project(&dir.0, "Claude-1", other).unwrap();

        let listing = list_topics_project(&dir.0, None, 0).unwrap();
        assert_eq!(listing.total_topics, 2);
        assert_eq!(listing.total_topics_all, 2);
        assert!(!listing.truncated);
        // newest activity first, regardless of creation order
        assert_eq!(listing.topics[0].topic_id, other.event.topic_id);
        assert_eq!(listing.topics[1].topic_id, first.event.topic_id);
        // the newest event supplies the display title and preview
        assert_eq!(listing.topics[1].topic_title, "Upload validation refined");
        assert_eq!(
            listing.topics[1].latest_summary,
            "Metadata is checked before completion"
        );
        assert_eq!(listing.topics[1].event_count, 2);
        assert_eq!(listing.topics[1].first_occurred_at, "2026-09-18T08:20:00Z");
        assert_eq!(listing.topics[1].last_occurred_at, "2026-09-19T08:20:00Z");

        let bounded = list_topics_project(&dir.0, None, 1).unwrap();
        assert_eq!(bounded.topics.len(), 1);
        assert_eq!(bounded.total_topics, 2);
        assert!(bounded.truncated);

        // a query may match an older event's summary and still return the topic
        let filtered = list_topics_project(&dir.0, Some("  METADATA transfer "), 0).unwrap();
        assert_eq!(filtered.total_topics, 1);
        assert_eq!(filtered.topics[0].topic_id, first.event.topic_id);

        let missed = list_topics_project(&dir.0, Some("nothing matches this"), 0).unwrap();
        assert!(missed.topics.is_empty());
        assert_eq!(missed.total_topics, 0);
        // an empty result is still distinguishable from an empty timeline
        assert_eq!(missed.total_topics_all, 2);

        assert!(list_topics_project(&dir.0, Some(&"x".repeat(121)), 0)
            .unwrap_err()
            .contains("query must be"));
    }

    #[test]
    fn topic_event_listing_reads_newest_first_and_rejects_unknown_topic() {
        let dir = TestDir::new("topic-events");
        let first = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        let mut follow_up = direct_request();
        follow_up.topic_id = Some(first.event.topic_id.clone());
        follow_up.topic_title = "Upload validation refined".to_string();
        follow_up.summary = "Metadata is checked before completion".to_string();
        follow_up.occurred_at = Some("2026-09-19T08:20:00Z".to_string());
        let second = record_direct_project(&dir.0, "Claude-1", follow_up).unwrap();

        let listing = list_topic_events_project(&dir.0, &first.event.topic_id, None, 0).unwrap();
        assert_eq!(listing.topic_id, first.event.topic_id);
        assert_eq!(listing.topic_title, "Upload validation refined");
        assert_eq!(listing.total_events, 2);
        assert!(!listing.truncated);
        assert_eq!(listing.events[0].event_id, second.event.id);
        assert_eq!(listing.events[1].event_id, first.event.id);
        assert_eq!(
            listing.events[1].source_ref.as_deref(),
            Some("conversation:turn-5")
        );

        let bounded = list_topic_events_project(&dir.0, &first.event.topic_id, None, 1).unwrap();
        assert_eq!(bounded.events.len(), 1);
        assert_eq!(bounded.total_events, 2);
        assert!(bounded.truncated);

        let error = list_topic_events_project(&dir.0, "topic-missing", None, 0).unwrap_err();
        assert!(error.contains("timeline topic does not exist: topic-missing"));
    }

    #[test]
    fn direct_record_reports_new_topic_with_existing_alternatives() {
        let dir = TestDir::new("direct-new-topic");
        let first = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        assert!(first.new_topic);
        // nothing else existed yet, so there is no alternative to name
        assert!(first.existing_topics.is_empty());

        let mut unrelated = direct_request();
        unrelated.topic_title = "การตรวจสอบ metadata ตอน upload".to_string();
        unrelated.summary = "บันทึกเรื่องเดิมด้วยชื่อคนละภาษา".to_string();
        unrelated.occurred_at = Some("2026-09-19T08:20:00Z".to_string());
        let split = record_direct_project(&dir.0, "Claude-1", unrelated).unwrap();
        assert!(split.new_topic);
        assert_ne!(split.event.topic_id, first.event.topic_id);
        assert_eq!(split.existing_topics.len(), 1);
        assert_eq!(split.existing_topics[0].topic_id, first.event.topic_id);
        assert_eq!(split.existing_topics[0].event_count, 1);

        let mut reused = direct_request();
        reused.topic_id = Some(first.event.topic_id.clone());
        reused.summary = "Metadata is checked before completion".to_string();
        reused.occurred_at = Some("2026-09-20T08:20:00Z".to_string());
        let reused = record_direct_project(&dir.0, "Claude-1", reused).unwrap();
        assert!(!reused.new_topic);
        assert!(reused.existing_topics.is_empty());
    }

    #[test]
    fn direct_record_warns_without_refusing_a_future_occurrence() {
        let dir = TestDir::new("direct-future-date");
        let recorded = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        assert!(recorded.warnings.is_empty());

        let mut ahead = direct_request();
        ahead.topic_id = Some(recorded.event.topic_id.clone());
        ahead.summary = "Event dated far past the commit it cites".to_string();
        ahead.occurred_at = Some("2099-01-01T00:00:00Z".to_string());
        let ahead = record_direct_project(&dir.0, "Codex-2", ahead).unwrap();
        assert_eq!(ahead.disposition, TimelineDirectRecordDisposition::Created);
        assert_eq!(ahead.warnings.len(), 1);
        assert!(ahead.warnings[0].contains("in the future"));
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 2);
    }

    #[test]
    fn merging_a_topic_moves_events_and_leaves_every_other_field_intact() {
        let dir = TestDir::new("topic-merge");
        let keeper = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();

        let mut split = direct_request();
        split.topic_title = "การตรวจสอบ metadata ตอน upload".to_string();
        split.summary = "เรื่องเดียวกันแต่ถูกบันทึกเป็นอีก topic".to_string();
        split.occurred_at = Some("2026-09-19T08:20:00Z".to_string());
        let split = record_direct_project(&dir.0, "Claude-1", split).unwrap();
        let before = fs::read_to_string(dir.0.join(&split.event.path)).unwrap();

        let merged = merge_topics_project(
            &dir.0,
            "การตรวจสอบ metadata",
            &keeper.event.topic_id,
            Some(TimelineMergeAuthorization {
                lane_label: "Claude-2".to_string(),
                rationale: "สองหัวข้อนี้ติดตามข้อกำหนดเดียวกัน".to_string(),
            }),
        )
        .unwrap();
        assert_eq!(merged.from_topic_id, split.event.topic_id);
        assert_eq!(merged.into_topic_id, keeper.event.topic_id);
        assert_eq!(merged.moved_events, 1);
        assert!(merged
            .backup_path
            .starts_with(".krypton/timeline/backups/mrg-"));
        // The audit records the acting lane and its grouping rationale.
        let manifest: TimelineMergeManifest = serde_json::from_str(
            &fs::read_to_string(dir.0.join(&merged.backup_path).join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.merged_by_lane.as_deref(), Some("Claude-2"));
        assert_eq!(
            manifest.rationale.as_deref(),
            Some("สองหัวข้อนี้ติดตามข้อกำหนดเดียวกัน")
        );
        assert_eq!(manifest.files.len(), 1);

        let events = scan_project(&dir.0).unwrap().events;
        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .all(|event| event.topic_id == keeper.event.topic_id));
        let moved = events
            .iter()
            .find(|event| event.id == split.event.id)
            .expect("moved event");
        // only the grouping key changed
        assert_eq!(moved.topic_title, "การตรวจสอบ metadata ตอน upload");
        assert_eq!(moved.summary, split.event.summary);
        assert_eq!(moved.recorder_lane, "Claude-1");
        assert_eq!(moved.occurred_at, "2026-09-19T08:20:00Z");
        let after = fs::read_to_string(dir.0.join(&split.event.path)).unwrap();
        assert_eq!(
            after.replace(&keeper.event.topic_id, "TOPIC"),
            before.replace(&split.event.topic_id, "TOPIC")
        );

        let undone = undo_last_merge_project(
            &dir.0,
            Some(TimelineMergeAuthorization {
                lane_label: "Codex-3".to_string(),
                rationale: "แยกบริบทเดิมเพื่อรักษาลำดับเหตุการณ์".to_string(),
            }),
        )
        .unwrap();
        assert_eq!(undone.merge_id, merged.merge_id);
        assert_eq!(undone.restored_events, 1);
        assert_eq!(
            fs::read_to_string(dir.0.join(&split.event.path)).unwrap(),
            before
        );
        let manifest: TimelineMergeManifest = serde_json::from_str(
            &fs::read_to_string(dir.0.join(&merged.backup_path).join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.undone_by_lane.as_deref(), Some("Codex-3"));
        assert_eq!(
            manifest.undo_rationale.as_deref(),
            Some("แยกบริบทเดิมเพื่อรักษาลำดับเหตุการณ์")
        );
        // one merge cannot be undone twice
        assert!(undo_last_merge_project(&dir.0, None)
            .unwrap_err()
            .contains("no timeline merge to undo"));
    }

    #[test]
    fn merge_refuses_ambiguous_unknown_and_self_targets_without_writing() {
        let dir = TestDir::new("topic-merge-refusals");
        assert!(merge_topics_project(&dir.0, "a", "b", None)
            .unwrap_err()
            .contains("no events yet"));

        let first = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        let mut second = direct_request();
        second.topic_title = "Upload validation follow-up".to_string();
        second.summary = "A second topic that shares the same words".to_string();
        second.occurred_at = Some("2026-09-19T08:20:00Z".to_string());
        record_direct_project(&dir.0, "Claude-1", second).unwrap();

        let ambiguous =
            merge_topics_project(&dir.0, "upload", &first.event.topic_id, None).unwrap_err();
        assert!(ambiguous.contains("matches 2 topics"));
        assert!(ambiguous.contains(&first.event.topic_id));

        assert!(
            merge_topics_project(&dir.0, "nothing here", &first.event.topic_id, None)
                .unwrap_err()
                .contains("no timeline topic matches")
        );
        assert!(
            merge_topics_project(&dir.0, &first.event.topic_id, &first.event.topic_id, None)
                .unwrap_err()
                .contains("same topic")
        );

        // every refusal happened before any write
        assert!(!dir.0.join(".krypton/timeline/backups").exists());
        let events = scan_project(&dir.0).unwrap().events;
        assert_eq!(events.len(), 2);
        assert_ne!(events[0].topic_id, events[1].topic_id);
    }

    #[test]
    fn topic_id_rewrite_preserves_body_and_rejects_malformed_records() {
        let source = "---\nschema: 1\ntopic_id: \"topic-old\"\ntopic_title: \"Keep\"\n---\n\n## Impact\ntopic_id: not frontmatter\n";
        let rewritten = rewrite_topic_id(source, "topic-new").unwrap();
        assert!(rewritten.contains("topic_id: \"topic-new\""));
        // the body line that merely looks like frontmatter is untouched
        assert!(rewritten.ends_with("## Impact\ntopic_id: not frontmatter\n"));
        assert_eq!(rewritten.matches("topic-new").count(), 1);

        assert!(rewrite_topic_id("no frontmatter here", "topic-new")
            .unwrap_err()
            .contains("missing opening frontmatter"));
        assert!(rewrite_topic_id(
            "---\nschema: 1\ntopic_title: \"Keep\"\n---\n\nBody\n",
            "topic-new"
        )
        .unwrap_err()
        .contains("no topic_id field"));
    }

    #[test]
    fn evidence_kinds_distinguish_records_and_agent_decisions_use_lane_actor() {
        let dir = TestDir::new("evidence-kinds");
        for kind in [
            TimelineEvidenceKind::UserStatement,
            TimelineEvidenceKind::ObservedOutcome,
            TimelineEvidenceKind::AgentDecision,
        ] {
            let mut request = direct_request();
            request.evidence_kind = kind;
            let result = record_direct_project(&dir.0, "Claude-4", request.clone()).unwrap();
            assert_eq!(result.event.evidence_kind, Some(kind));
            assert_eq!(result.event.recorded_by, "Agent");
            assert_eq!(
                result.event.made_by,
                if kind == TimelineEvidenceKind::AgentDecision {
                    "Claude-4"
                } else {
                    "Product owner"
                }
            );
            let detail = event_detail_project(&dir.0, &result.event.id).unwrap();
            assert_eq!(detail.rationale, request.rationale);
            assert_eq!(detail.impact, request.impact);
            assert_eq!(
                detail.evidence_excerpt.as_deref(),
                Some(request.evidence_excerpt.as_str())
            );
            assert_eq!(
                serde_json::to_value(&detail).unwrap()["evidenceKind"],
                serde_json::to_value(kind).unwrap()
            );
            assert_eq!(
                record_direct_project(&dir.0, "Claude-4", request)
                    .unwrap()
                    .event
                    .id,
                result.event.id
            );
        }
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 3);
    }

    #[test]
    fn direct_record_request_rejects_retired_fields_and_requires_evidence() {
        let valid = serde_json::json!({
            "topic_title": "Upload validation", "summary": "Metadata is required",
            "made_by": "Product owner", "evidence_kind": "user_statement",
            "evidence_excerpt": "We require metadata."
        });
        assert!(serde_json::from_value::<TimelineDirectRecordRequest>(valid.clone()).is_ok());
        let mut retired = valid.clone();
        retired["instruction_excerpt"] = serde_json::json!("Record this.");
        assert!(serde_json::from_value::<TimelineDirectRecordRequest>(retired).is_err());
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove("evidence_kind");
        assert!(serde_json::from_value::<TimelineDirectRecordRequest>(missing).is_err());
        let mut invalid = valid;
        invalid["evidence_kind"] = serde_json::json!("human_approval");
        assert!(serde_json::from_value::<TimelineDirectRecordRequest>(invalid).is_err());
        let dir = TestDir::new("empty-evidence");
        let mut request = direct_request();
        request.evidence_excerpt = " ".to_string();
        assert!(record_direct_project(&dir.0, "Codex-2", request).is_err());
        assert!(!event_root(&dir.0).exists());
    }

    #[test]
    fn old_event_provenance_and_authorizing_instruction_remain_readable_without_rewrite() {
        let dir = TestDir::new("legacy-provenance");
        let legacy = record_project(&dir.0, request()).unwrap();
        let path = dir.0.join(&legacy.path);
        let source = fs::read_to_string(&path).unwrap()
            .replace("recorded_by: \"Local user\"", "recorded_by: \"Agent via explicit user instruction\"")
            .replace("## Rationale", "## Evidence\nOriginal quotation.\n\n## Authorizing instruction\nRecord the requirement.\n\n## Rationale");
        fs::write(&path, &source).unwrap();
        let detail = event_detail_project(&dir.0, &legacy.id).unwrap();
        assert_eq!(detail.schema, 1);
        assert_eq!(detail.evidence_kind, None);
        assert_eq!(
            detail.evidence_excerpt.as_deref(),
            Some("Original quotation.")
        );
        assert_eq!(
            detail.instruction_excerpt.as_deref(),
            Some("Record the requirement.")
        );
        assert_eq!(detail.recorded_by, "Agent via explicit user instruction");
        assert_eq!(fs::read_to_string(path).unwrap(), source);
    }

    #[test]
    fn pending_reads_are_oldest_first_bounded_and_count_malformed_files() {
        let dir = TestDir::new("bounded-pending");
        assert_eq!(pending_count_project(&dir.0).unwrap(), 0);
        assert_eq!(
            list_pending_project(&dir.0, 0).unwrap(),
            TimelinePendingListing::default()
        );
        for index in (0..25).rev() {
            seed_pending(&dir.0, index);
        }
        let root = pending_root(&dir.0);
        fs::write(root.join("tl-malformed.md"), "invalid candidate").unwrap();
        fs::write(
            root.join("tl-oversized.md"),
            "x".repeat(MAX_EVENT_BYTES as usize + 1),
        )
        .unwrap();
        fs::create_dir(root.join("tl-directory.md")).unwrap();
        fs::write(root.join("ignored.tmp"), "not a candidate").unwrap();
        assert_eq!(pending_count_project(&dir.0).unwrap(), 28);
        let default = list_pending_project(&dir.0, 0).unwrap();
        assert_eq!(default.candidates.len(), 5);
        assert_eq!(default.remaining_pending, 28);
        assert_eq!(default.diagnostics.len(), 3);
        assert!(default.truncated);
        assert!(default.candidates[0].id.ends_with("000000"));
        assert!(default.candidates[4].id.ends_with("000004"));
        let max = list_pending_project(&dir.0, usize::MAX).unwrap();
        assert_eq!(max.candidates.len(), 20);
        assert!(max.truncated);
        let payload = serde_json::to_value(default).unwrap();
        assert_eq!(payload["remaining_pending"], 28);
        assert_eq!(payload["candidates"][0]["suggestedByLane"], "Codex-1");
    }

    #[test]
    fn normal_record_does_not_promote_even_a_matching_legacy_candidate() {
        let dir = TestDir::new("no-implicit-promotion");
        let (candidate, original) = seed_pending(&dir.0, 0);
        let result = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        assert_ne!(result.event.id, candidate.id);
        assert_eq!(result.event.suggestion_id, None);
        assert_eq!(pending_count_project(&dir.0).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(dir.0.join(candidate.path)).unwrap(),
            original
        );
        assert!(!resolution_root(&dir.0).exists());
    }

    #[test]
    fn settings_migrate_both_values_without_changing_event_schema_or_pending() {
        for enabled in [false, true] {
            let dir = TestDir::new("settings-migration");
            assert!(settings_project(&dir.0).unwrap().automatic_recording);
            let (candidate, _) = seed_pending(&dir.0, 0);
            let path = settings_path(&dir.0);
            fs::write(
                &path,
                format!("{{\"schema\":1,\"automaticSuggestions\":{enabled}}}"),
            )
            .unwrap();
            assert_eq!(
                settings_project(&dir.0).unwrap().automatic_recording,
                enabled
            );
            let migrated: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
            assert_eq!(migrated["schema"], 2);
            assert_eq!(migrated["automaticRecording"], enabled);
            assert!(migrated.get("automaticSuggestions").is_none());
            assert_eq!(
                serde_json::to_value(settings_project(&dir.0).unwrap()).unwrap()
                    ["automaticRecording"],
                enabled
            );
            assert_eq!(
                set_enabled_project(&dir.0, false)
                    .unwrap()
                    .automatic_recording,
                false
            );
            assert!(record_direct_project(&dir.0, "Codex-2", direct_request())
                .unwrap_err()
                .contains("disabled"));
            assert_eq!(pending_count_project(&dir.0).unwrap(), 1);
            let promoted = resolve_pending_project(
                &dir.0,
                "Codex-2",
                resolution(&candidate, TimelinePendingOutcome::Record),
            )
            .unwrap();
            assert_eq!(promoted.event.unwrap().schema, 1);
            assert_eq!(promoted.remaining_pending, 0);
            assert!(
                set_enabled_project(&dir.0, true)
                    .unwrap()
                    .automatic_recording
            );
        }
    }

    #[test]
    fn record_resolution_uses_reserved_id_and_preserves_verbatim_candidate_and_first_lane() {
        let dir = TestDir::new("resolve-record");
        let (candidate, source) = seed_pending(&dir.0, 0);
        let source = source.replace('\n', "\r\n");
        fs::write(dir.0.join(&candidate.path), &source).unwrap();
        let mut request = resolution(&candidate, TimelinePendingOutcome::Record);
        request.record.as_mut().unwrap().occurred_at = Some("2026-10-20T00:00:00Z".to_string());
        let result = resolve_pending_project(&dir.0, "Claude-2", request).unwrap();
        let event = result.event.as_ref().unwrap();
        assert_eq!(event.id, candidate.id);
        assert_eq!(event.suggestion_id.as_deref(), Some(candidate.id.as_str()));
        assert_eq!(event.suggested_by_lane.as_deref(), Some("Codex-1"));
        assert_eq!(event.occurred_at, candidate.occurred_at);
        assert_eq!(event.recorded_by, "Agent");
        assert_eq!(event.recorder_lane, "Claude-2");
        assert_eq!(result.remaining_pending, 0);
        let receipt_source = fs::read_to_string(dir.0.join(&result.resolution_path)).unwrap();
        let receipt: TimelinePendingReceipt = serde_json::from_str(&receipt_source).unwrap();
        assert_eq!(receipt.schema, 1);
        assert_eq!(receipt.original_candidate, source);
        assert_eq!(receipt.resolved_by_lane, "Claude-2");
        assert_eq!(receipt.event_id.as_deref(), Some(candidate.id.as_str()));
        let repeated = resolve_pending_project(
            &dir.0,
            "Codex-9",
            resolution(&candidate, TimelinePendingOutcome::Discard),
        )
        .unwrap();
        assert_eq!(repeated, result);
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 1);
        assert_eq!(
            fs::read_to_string(dir.0.join(&result.resolution_path)).unwrap(),
            receipt_source
        );
    }

    #[test]
    fn duplicate_and_discard_resolutions_keep_receipts_without_new_events() {
        let dir = TestDir::new("resolve-terminal");
        let canonical = record_direct_project(&dir.0, "Codex-2", direct_request())
            .unwrap()
            .event;
        let (duplicate, duplicate_source) = seed_pending(&dir.0, 0);
        let (unsupported, unsupported_source) = seed_pending(&dir.0, 1);
        let mut request = resolution(&duplicate, TimelinePendingOutcome::Duplicate);
        request.event_id = Some(canonical.id.clone());
        let result = resolve_pending_project(&dir.0, "Claude-2", request).unwrap();
        assert_eq!(result.event_id.as_deref(), Some(canonical.id.as_str()));
        assert_eq!(result.event, Some(canonical));
        assert_eq!(result.remaining_pending, 1);
        let receipt: TimelinePendingReceipt =
            serde_json::from_str(&fs::read_to_string(dir.0.join(result.resolution_path)).unwrap())
                .unwrap();
        assert_eq!(receipt.original_candidate, duplicate_source);
        let discarded = resolve_pending_project(
            &dir.0,
            "Claude-2",
            resolution(&unsupported, TimelinePendingOutcome::Discard),
        )
        .unwrap();
        assert_eq!(discarded.event_id, None);
        assert_eq!(discarded.event, None);
        assert_eq!(discarded.remaining_pending, 0);
        let receipt: TimelinePendingReceipt = serde_json::from_str(
            &fs::read_to_string(dir.0.join(&discarded.resolution_path)).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt.original_candidate, unsupported_source);
        assert_eq!(receipt.outcome, TimelinePendingOutcome::Discard);
        assert_eq!(
            resolve_pending_project(
                &dir.0,
                "Codex-3",
                resolution(&unsupported, TimelinePendingOutcome::Record)
            )
            .unwrap(),
            discarded
        );
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 1);
    }

    #[test]
    fn older_candidate_can_be_recorded_then_superseded_without_rewriting_it() {
        let dir = TestDir::new("legacy-superseded");
        let (candidate, _) = seed_pending(&dir.0, 0);
        let old = resolve_pending_project(
            &dir.0,
            "Codex-2",
            resolution(&candidate, TimelinePendingOutcome::Record),
        )
        .unwrap()
        .event
        .unwrap();
        let bytes = fs::read(dir.0.join(&old.path)).unwrap();
        let mut newer = direct_request();
        newer.topic_id = Some(old.topic_id.clone());
        newer.summary = "ตรวจ metadata และ checksum ก่อนจบงาน".to_string();
        newer.evidence_excerpt = "Metadata and checksum are now required.".to_string();
        newer.relation = Some(TimelineRelation::Supersedes);
        newer.related_event = Some(old.id.clone());
        record_direct_project(&dir.0, "Claude-2", newer).unwrap();
        assert!(
            scan_project(&dir.0)
                .unwrap()
                .events
                .iter()
                .find(|event| event.id == old.id)
                .unwrap()
                .superseded
        );
        assert!(event_detail_project(&dir.0, &old.id).unwrap().superseded);
        assert_eq!(fs::read(dir.0.join(old.path)).unwrap(), bytes);
    }

    #[test]
    fn resolver_validates_shape_ids_and_references_before_any_terminal_write() {
        let dir = TestDir::new("resolve-validation");
        let (candidate, original) = seed_pending(&dir.0, 0);
        let mut mixed = resolution(&candidate, TimelinePendingOutcome::Record);
        mixed.event_id = Some("tl-missing".to_string());
        assert!(resolve_pending_project(&dir.0, "Codex-2", mixed).is_err());
        let mut unknown = resolution(&candidate, TimelinePendingOutcome::Duplicate);
        unknown.event_id = Some("tl-missing".to_string());
        assert!(resolve_pending_project(&dir.0, "Codex-2", unknown).is_err());
        let mut invalid = resolution(&candidate, TimelinePendingOutcome::Discard);
        invalid.pending_id = "../tl-outside".to_string();
        assert!(resolve_pending_project(&dir.0, "Codex-2", invalid).is_err());
        let mut unknown_topic = resolution(&candidate, TimelinePendingOutcome::Record);
        unknown_topic.record.as_mut().unwrap().topic_id = Some("topic-missing".to_string());
        assert!(resolve_pending_project(&dir.0, "Codex-2", unknown_topic).is_err());
        let mut unknown_relation = resolution(&candidate, TimelinePendingOutcome::Record);
        let record = unknown_relation.record.as_mut().unwrap();
        record.relation = Some(TimelineRelation::Supersedes);
        record.related_event = Some("tl-missing".to_string());
        assert!(resolve_pending_project(&dir.0, "Codex-2", unknown_relation).is_err());
        assert_eq!(
            fs::read_to_string(dir.0.join(&candidate.path)).unwrap(),
            original
        );
        assert!(!resolution_root(&dir.0).exists());
        assert!(!event_root(&dir.0).exists());
        fs::write(dir.0.join(&candidate.path), "malformed").unwrap();
        assert!(resolve_pending_project(
            &dir.0,
            "Codex-2",
            resolution(&candidate, TimelinePendingOutcome::Discard)
        )
        .is_err());
        assert_eq!(pending_count_project(&dir.0).unwrap(), 1);
        assert_eq!(
            list_pending_project(&dir.0, 0).unwrap().diagnostics.len(),
            1
        );
    }

    #[test]
    fn resolver_refuses_reserved_id_collision_and_keeps_both_originals() {
        let dir = TestDir::new("reserved-collision");
        let (candidate, original) = seed_pending(&dir.0, 0);
        let unrelated = record_direct_project(&dir.0, "Claude-1", direct_request())
            .unwrap()
            .event;
        let bytes = fs::read_to_string(dir.0.join(unrelated.path))
            .unwrap()
            .replace(&unrelated.id, &candidate.id);
        let path = event_root(&dir.0).join(format!("{}.md", candidate.id));
        fs::write(&path, &bytes).unwrap();
        let error = resolve_pending_project(
            &dir.0,
            "Codex-2",
            resolution(&candidate, TimelinePendingOutcome::Record),
        )
        .unwrap_err();
        assert!(error.contains("already used"));
        assert_eq!(fs::read_to_string(path).unwrap(), bytes);
        assert_eq!(
            fs::read_to_string(dir.0.join(candidate.path)).unwrap(),
            original
        );
        assert!(!resolution_root(&dir.0).exists());
    }

    #[test]
    fn event_write_failure_leaves_candidate_and_no_terminal_receipt() {
        let dir = TestDir::new("event-write-failure");
        let (candidate, original) = seed_pending(&dir.0, 0);
        fs::create_dir_all(event_root(&dir.0)).unwrap();
        let path = event_root(&dir.0).join(format!("{}.md", candidate.id));
        fail_once(path.clone(), "publish");
        assert!(resolve_pending_project(
            &dir.0,
            "Codex-2",
            resolution(&candidate, TimelinePendingOutcome::Record)
        )
        .is_err());
        assert!(!path.exists());
        assert!(!resolution_root(&dir.0)
            .join(format!("{}.json", candidate.id))
            .exists());
        assert_eq!(
            fs::read_to_string(dir.0.join(candidate.path.clone())).unwrap(),
            original
        );
        assert_eq!(
            resolve_pending_project(
                &dir.0,
                "Codex-2",
                resolution(&candidate, TimelinePendingOutcome::Record)
            )
            .unwrap()
            .remaining_pending,
            0
        );
    }

    #[test]
    fn saved_event_without_receipt_recovers_first_winner_even_after_competing_outcome() {
        let dir = TestDir::new("receipt-write-failure");
        let (candidate, original) = seed_pending(&dir.0, 0);
        fs::create_dir_all(resolution_root(&dir.0)).unwrap();
        let receipt_path = resolution_root(&dir.0).join(format!("{}.json", candidate.id));
        fail_once(receipt_path.clone(), "publish");
        let first = resolution(&candidate, TimelinePendingOutcome::Record);
        let first_rationale = first.rationale.clone();
        assert!(resolve_pending_project(&dir.0, "Claude-2", first).is_err());
        let saved = event_detail_project(&dir.0, &candidate.id).unwrap();
        let event_bytes = fs::read(dir.0.join(&saved.path)).unwrap();
        assert!(!receipt_path.exists());
        assert_eq!(
            fs::read_to_string(dir.0.join(&candidate.path)).unwrap(),
            original
        );
        let mut competing = resolution(&candidate, TimelinePendingOutcome::Discard);
        competing.rationale = "เหตุผลจาก lane ที่มาทีหลัง".to_string();
        let recovered = resolve_pending_project(&dir.0, "Codex-9", competing).unwrap();
        assert_eq!(recovered.outcome, TimelinePendingOutcome::Record);
        assert_eq!(recovered.event.as_ref().unwrap().id, saved.id);
        assert_eq!(recovered.remaining_pending, 0);
        let receipt: TimelinePendingReceipt =
            serde_json::from_str(&fs::read_to_string(receipt_path).unwrap()).unwrap();
        assert_eq!(receipt.resolved_by_lane, "Claude-2");
        assert_eq!(receipt.rationale, first_rationale);
        assert_eq!(receipt.resolved_at, saved.recorded_at);
        assert_eq!(receipt.original_candidate, original);
        assert_eq!(fs::read(dir.0.join(saved.path)).unwrap(), event_bytes);
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 1);
    }

    #[test]
    fn cleanup_failure_and_stale_pending_retry_do_not_lose_terminal_receipt() {
        let dir = TestDir::new("cleanup-failure");
        let (candidate, original) = seed_pending(&dir.0, 0);
        fail_once(dir.0.join(&candidate.path), "cleanup");
        assert!(resolve_pending_project(
            &dir.0,
            "Claude-2",
            resolution(&candidate, TimelinePendingOutcome::Discard)
        )
        .is_err());
        let receipt_path = resolution_root(&dir.0).join(format!("{}.json", candidate.id));
        let receipt_bytes = fs::read(&receipt_path).unwrap();
        assert_eq!(
            fs::read_to_string(dir.0.join(&candidate.path)).unwrap(),
            original
        );
        let recovered = resolve_pending_project(
            &dir.0,
            "Codex-9",
            resolution(&candidate, TimelinePendingOutcome::Record),
        )
        .unwrap();
        assert_eq!(recovered.outcome, TimelinePendingOutcome::Discard);
        assert_eq!(recovered.remaining_pending, 0);
        assert!(scan_project(&dir.0).unwrap().events.is_empty());
        fs::write(dir.0.join(&candidate.path), &original).unwrap();
        assert_eq!(
            resolve_pending_project(
                &dir.0,
                "Codex-9",
                resolution(&candidate, TimelinePendingOutcome::Discard)
            )
            .unwrap(),
            recovered
        );
        assert_eq!(fs::read(receipt_path).unwrap(), receipt_bytes);
    }

    #[test]
    fn competing_lanes_observe_one_terminal_resolution() {
        let dir = TestDir::new("concurrent-resolution");
        let (candidate, original) = seed_pending(&dir.0, 0);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = [
            TimelinePendingOutcome::Record,
            TimelinePendingOutcome::Discard,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, outcome)| {
            let project = dir.0.clone();
            let candidate = candidate.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                resolve_pending_project(
                    &project,
                    &format!("Codex-{index}"),
                    resolution(&candidate, outcome),
                )
                .unwrap()
            })
        })
        .collect();
        barrier.wait();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results[0], results[1]);
        assert_eq!(results[0].remaining_pending, 0);
        assert_eq!(
            scan_project(&dir.0).unwrap().events.len(),
            usize::from(results[0].outcome == TimelinePendingOutcome::Record)
        );
        let receipt: TimelinePendingReceipt = serde_json::from_str(
            &fs::read_to_string(dir.0.join(&results[0].resolution_path)).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt.original_candidate, original);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_diagnostics_and_cannot_redirect_event_or_resolution_writes() {
        use std::os::unix::fs::symlink;
        let dir = TestDir::new("symlinks");
        let outside = TestDir::new("symlink-target");
        let (candidate, original) = seed_pending(&dir.0, 0);
        let target = outside.0.join("candidate.md");
        fs::write(&target, &original).unwrap();
        let path = dir.0.join(&candidate.path);
        fs::remove_file(&path).unwrap();
        symlink(&target, &path).unwrap();
        assert_eq!(pending_count_project(&dir.0).unwrap(), 1);
        assert_eq!(
            list_pending_project(&dir.0, 0).unwrap().diagnostics.len(),
            1
        );
        assert!(resolve_pending_project(
            &dir.0,
            "Codex-2",
            resolution(&candidate, TimelinePendingOutcome::Discard)
        )
        .is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), original);
        fs::remove_file(&path).unwrap();
        fs::write(&path, &original).unwrap();
        symlink(&outside.0, event_root(&dir.0)).unwrap();
        assert!(record_direct_project(&dir.0, "Codex-2", direct_request()).is_err());
        assert!(resolve_pending_project(
            &dir.0,
            "Codex-2",
            resolution(&candidate, TimelinePendingOutcome::Record)
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(!outside.0.join(format!("{}.md", candidate.id)).exists());
    }

    #[test]
    fn undo_reads_legacy_manifest_and_records_new_lane_rationale() {
        let dir = TestDir::new("legacy-manifest");
        let keeper = record_direct_project(&dir.0, "Codex-2", direct_request())
            .unwrap()
            .event;
        let mut split = direct_request();
        split.topic_title = "Separate upload chronology".to_string();
        split.summary = "A separate entry".to_string();
        let split = record_direct_project(&dir.0, "Claude-2", split)
            .unwrap()
            .event;
        let before = fs::read(dir.0.join(&split.path)).unwrap();
        let merged = merge_topics_project(&dir.0, &split.topic_id, &keeper.topic_id, None).unwrap();
        let path = dir.0.join(merged.backup_path).join("manifest.json");
        let mut legacy: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        legacy["instruction_excerpt"] = serde_json::json!("Keep the original authorization.");
        for field in ["rationale", "undone_by_lane", "undo_rationale"] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        undo_last_merge_project(
            &dir.0,
            Some(TimelineMergeAuthorization {
                lane_label: "Codex-3".to_string(),
                rationale: "คืนกลุ่มเดิมตามหลักฐาน".to_string(),
            }),
        )
        .unwrap();
        let manifest: TimelineMergeManifest =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            manifest.instruction_excerpt.as_deref(),
            Some("Keep the original authorization.")
        );
        assert_eq!(manifest.undone_by_lane.as_deref(), Some("Codex-3"));
        assert_eq!(
            manifest.undo_rationale.as_deref(),
            Some("คืนกลุ่มเดิมตามหลักฐาน")
        );
        assert_eq!(fs::read(dir.0.join(split.path)).unwrap(), before);
    }

    #[test]
    fn failed_settings_migration_preserves_old_false_until_retry() {
        let dir = TestDir::new("settings-failure");
        seed_pending(&dir.0, 0);
        let path = settings_path(&dir.0);
        let original = "{\"schema\":1,\"automaticSuggestions\":false}";
        fs::write(&path, original).unwrap();
        fail_once(path.clone(), "publish");
        assert!(settings_project(&dir.0).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(!settings_project(&dir.0).unwrap().automatic_recording);
        assert_eq!(pending_count_project(&dir.0).unwrap(), 1);
    }

    #[test]
    fn retry_keeps_externally_replaced_pending_file_and_original_receipt() {
        let dir = TestDir::new("replaced-pending");
        let (candidate, original) = seed_pending(&dir.0, 0);
        let result = resolve_pending_project(
            &dir.0,
            "Claude-2",
            resolution(&candidate, TimelinePendingOutcome::Discard),
        )
        .unwrap();
        let receipt_path = dir.0.join(&result.resolution_path);
        let receipt_bytes = fs::read(&receipt_path).unwrap();
        let changed = original.replace(
            "Metadata transfer is required",
            "A different candidate with the same id",
        );
        fs::write(dir.0.join(&candidate.path), &changed).unwrap();
        assert!(resolve_pending_project(
            &dir.0,
            "Codex-3",
            resolution(&candidate, TimelinePendingOutcome::Discard)
        )
        .unwrap_err()
        .contains("changed"));
        assert_eq!(
            fs::read_to_string(dir.0.join(&candidate.path)).unwrap(),
            changed
        );
        assert_eq!(pending_count_project(&dir.0).unwrap(), 1);
        assert_eq!(fs::read(receipt_path).unwrap(), receipt_bytes);
    }

    #[test]
    fn unknown_direct_relations_and_event_detail_paths_are_rejected_before_recording() {
        let dir = TestDir::new("direct-related-validation");
        let mut unpaired = direct_request();
        unpaired.relation = Some(TimelineRelation::Refines);
        assert!(record_direct_project(&dir.0, "Codex-2", unpaired).is_err());
        let mut unknown = direct_request();
        unknown.relation = Some(TimelineRelation::Refines);
        unknown.related_event = Some("tl-missing".to_string());
        assert!(record_direct_project(&dir.0, "Codex-2", unknown).is_err());
        assert!(event_detail_project(&dir.0, "../tl-outside").is_err());
        assert!(!event_root(&dir.0).exists());
    }

    #[cfg(unix)]
    #[test]
    fn resolver_refuses_symlinked_receipts_without_cleaning_candidate() {
        use std::os::unix::fs::symlink;
        let dir = TestDir::new("symlinked-receipt");
        let outside = TestDir::new("receipt-target");
        let (candidate, original) = seed_pending(&dir.0, 0);
        fs::create_dir_all(resolution_root(&dir.0)).unwrap();
        let target = outside.0.join("receipt.json");
        fs::write(&target, "{}").unwrap();
        symlink(
            &target,
            resolution_root(&dir.0).join(format!("{}.json", candidate.id)),
        )
        .unwrap();
        assert!(resolve_pending_project(
            &dir.0,
            "Codex-2",
            resolution(&candidate, TimelinePendingOutcome::Discard)
        )
        .is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "{}");
        assert_eq!(
            fs::read_to_string(dir.0.join(candidate.path)).unwrap(),
            original
        );
        assert_eq!(pending_count_project(&dir.0).unwrap(), 1);
    }
}
