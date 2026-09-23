//! Project-local requirement and decision timeline (spec 253).
//!
//! The frontend supplies a harness id, never a filesystem path. `HookServer`
//! resolves the registered project root and this module confines every record to
//! `.krypton/timeline/`. Confirmed records are append-only Markdown files;
//! automatic agent proposals remain pending until a human confirms or dismisses.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::hook_server::HookServer;
use crate::typesafe::{TimelineTopicSemanticRequest, TimelineTopicSemanticResult, TypeSafeState};

const SCHEMA_VERSION: u8 = 1;
const MAX_EVENTS: usize = 2_000;
const MAX_EVENT_BYTES: u64 = 32 * 1024;
const MAX_TOPIC_CHARS: usize = 120;
const MAX_SUMMARY_CHARS: usize = 500;
const MAX_ACTOR_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 4 * 1024;
const MAX_SOURCE_CHARS: usize = 2 * 1024;
const MAX_EVIDENCE_CHARS: usize = 1_000;
const MAX_SEMANTIC_SUMMARY_CHARS: usize = 240;
const MAX_PENDING_SUGGESTIONS: usize = 100;
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
// The write still happens — a human authorized it — but a chronology dated
// months from the source it cites is almost always a mistake.
const MAX_FUTURE_SKEW_HOURS: i64 = 24;
static TIMELINE_MUTATION_LOCK: Mutex<()> = Mutex::new(());

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSuggestionRequest {
    pub topic_title: String,
    pub summary: String,
    pub made_by: String,
    pub evidence_excerpt: String,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub impact: String,
    #[serde(default)]
    pub source_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct TimelineDirectRecordRequest {
    #[serde(default)]
    pub topic_id: Option<String>,
    pub topic_title: String,
    pub summary: String,
    pub made_by: String,
    pub instruction_excerpt: String,
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
    PromotedPending,
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
    /// spec 262: non-fatal notices the lane must relay (e.g. an `occurred_at`
    /// far in the future). The event is written regardless: the human
    /// authorized it, so the system reports rather than refuses.
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
#[serde(rename_all = "camelCase")]
pub struct TimelineSuggestionListResponse {
    pub suggestions: Vec<TimelineSuggestion>,
    pub diagnostics: Vec<TimelineDiagnostic>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSuggestionSettings {
    pub automatic_suggestions: bool,
}

impl Default for TimelineSuggestionSettings {
    fn default() -> Self {
        Self {
            automatic_suggestions: true,
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

fn dismissed_root(project_dir: &Path) -> PathBuf {
    project_dir
        .join(".krypton")
        .join("timeline")
        .join("dismissed")
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
    let project = canonical_project(project_dir)?;
    let root = event_root(&project);
    if !root.exists() {
        return Ok(None);
    }
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("failed to resolve timeline directory: {error}"))?;
    if !canonical.starts_with(&project) {
        return Err("timeline directory resolves outside the project".to_string());
    }
    Ok(Some((project, canonical)))
}

fn writable_event_root(project_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let project = canonical_project(project_dir)?;
    let requested = event_root(&project);
    fs::create_dir_all(&requested)
        .map_err(|error| format!("failed to create timeline directory: {error}"))?;
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("failed to resolve timeline directory: {error}"))?;
    if !canonical.starts_with(&project) {
        return Err("timeline directory resolves outside the project".to_string());
    }
    Ok((project, canonical))
}

fn existing_confined_root(
    project_dir: &Path,
    requested: PathBuf,
    label: &str,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let project = canonical_project(project_dir)?;
    if !requested.exists() {
        return Ok(None);
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("failed to resolve {label} directory: {error}"))?;
    if !canonical.starts_with(&project) {
        return Err(format!("{label} directory resolves outside the project"));
    }
    Ok(Some((project, canonical)))
}

fn writable_confined_root(
    project_dir: &Path,
    requested: PathBuf,
    label: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let project = canonical_project(project_dir)?;
    fs::create_dir_all(&requested)
        .map_err(|error| format!("failed to create {label} directory: {error}"))?;
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("failed to resolve {label} directory: {error}"))?;
    if !canonical.starts_with(&project) {
        return Err(format!("{label} directory resolves outside the project"));
    }
    Ok((project, canonical))
}

fn relative_path(project: &Path, path: &Path) -> String {
    path.strip_prefix(project)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn validate_single_line(name: &str, value: &str, max: usize) -> Result<String, String> {
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

fn validate_optional_single_line(
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

fn validate_topic_id(value: &str) -> Result<String, String> {
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

fn validate_event_id(value: &str) -> Result<String, String> {
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
        evidence_excerpt,
        instruction_excerpt,
        suggestion_id,
        rationale,
        impact,
        path: relative_path(project, path),
        superseded: false,
    })
}

fn validate_body_with_limit(name: &str, value: &str, max: usize) -> Result<String, String> {
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

pub(crate) fn scan_suggestions_project(
    project_dir: &Path,
) -> Result<TimelineSuggestionListResponse, String> {
    let Some((project, root)) =
        existing_confined_root(project_dir, pending_root(project_dir), "timeline pending")?
    else {
        return Ok(TimelineSuggestionListResponse::default());
    };
    let mut response = TimelineSuggestionListResponse::default();
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("failed to list timeline suggestions: {error}"))?;
    for entry in entries.take(MAX_PENDING_SUGGESTIONS + 1) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                response.diagnostics.push(TimelineDiagnostic {
                    path: ".krypton/timeline/pending".to_string(),
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
                    error: format!("failed to inspect suggestion: {error}"),
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
                    error: format!("failed to inspect suggestion: {error}"),
                });
                continue;
            }
        };
        if metadata.len() > MAX_EVENT_BYTES {
            response.diagnostics.push(TimelineDiagnostic {
                path: display_path,
                error: format!("suggestion exceeds {MAX_EVENT_BYTES} bytes"),
            });
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(source) => match parse_suggestion(&project, &path, &source) {
                Ok(suggestion) => response.suggestions.push(suggestion),
                Err(error) => response.diagnostics.push(TimelineDiagnostic {
                    path: display_path,
                    error,
                }),
            },
            Err(error) => response.diagnostics.push(TimelineDiagnostic {
                path: display_path,
                error: format!("failed to read suggestion: {error}"),
            }),
        }
    }
    response.suggestions.sort_by(|left, right| {
        left.suggested_at
            .cmp(&right.suggested_at)
            .then(left.id.cmp(&right.id))
    });
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
// spec 263: topic merge. Human-only repair for topics that were already split
// before spec 262 closed the discovery gap. Agents never get this path: the
// persistence contract is that confirmed history is only appended to.
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
    /// spec 263: present when a lane performed the merge on an explicit human
    /// instruction. Absent for the `#timeline merge` keyboard path, where the
    /// human typed it themselves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_by_lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undone_at: Option<String>,
}

/// spec 263: who authorized a merge. `#timeline merge` passes `None`; a lane
/// calling `timeline_merge` must supply the human's exact authorizing words,
/// which are stored in the undo manifest.
#[derive(Debug, Clone)]
pub struct TimelineMergeAuthorization {
    pub lane_label: String,
    pub instruction_excerpt: String,
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
    let mut restored = 0;
    for file in files {
        let source = fs::read_to_string(backup_dir.join(file))
            .map_err(|error| format!("failed to read timeline backup {file}: {error}"))?;
        fs::write(events_root.join(file), source)
            .map_err(|error| format!("failed to restore timeline event {file}: {error}"))?;
        restored += 1;
    }
    Ok(restored)
}

fn write_manifest(path: &Path, manifest: &TimelineMergeManifest) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("failed to encode timeline merge manifest: {error}"))?;
    fs::write(path, encoded)
        .map_err(|error| format!("failed to write timeline merge manifest: {error}"))
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
    let authorization = authorization
        .map(
            |authorization| -> Result<TimelineMergeAuthorization, String> {
                Ok(TimelineMergeAuthorization {
                    lane_label: validate_single_line(
                        "recorderLane",
                        &authorization.lane_label,
                        MAX_ACTOR_CHARS,
                    )?,
                    instruction_excerpt: validate_body_with_limit(
                        "instructionExcerpt",
                        &authorization.instruction_excerpt,
                        MAX_EVIDENCE_CHARS,
                    )
                    .and_then(|value| {
                        if value.is_empty() {
                            Err("instructionExcerpt is required".to_string())
                        } else {
                            Ok(value)
                        }
                    })?,
                })
            },
        )
        .transpose()?;
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
    let backup_dir = backup_root(&project).join(&merge_id);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("failed to create timeline backup directory: {error}"))?;
    for file in &files {
        let source = fs::read_to_string(events_root.join(file))
            .map_err(|error| format!("failed to read timeline event {file}: {error}"))?;
        fs::write(backup_dir.join(file), source)
            .map_err(|error| format!("failed to back up timeline event {file}: {error}"))?;
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
        instruction_excerpt: authorization
            .as_ref()
            .map(|authorization| authorization.instruction_excerpt.clone()),
        undone_at: None,
    };
    let manifest_path = backup_dir.join("manifest.json");
    write_manifest(&manifest_path, &manifest)?;
    for file in &files {
        let path = events_root.join(file);
        let rewritten = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read timeline event {file}: {error}"))
            .and_then(|source| rewrite_topic_id(&source, &into_topic_id))
            .and_then(|rewritten| {
                fs::write(&path, rewritten)
                    .map_err(|error| format!("failed to rewrite timeline event {file}: {error}"))
            });
        if let Err(error) = rewritten {
            // Put every file back before reporting: a half-merged topic is worse
            // than no merge at all.
            let restored = restore_backup(&events_root, &backup_dir, &files);
            manifest.undone_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
            let _ = write_manifest(&manifest_path, &manifest);
            return Err(match restored {
                Ok(_) => format!("{error}; the merge was rolled back and nothing changed"),
                Err(restore_error) => format!(
                    "{error}; automatic rollback also failed ({restore_error}) — run `#timeline merge undo` or restore from .krypton/timeline/backups/{merge_id}"
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
) -> Result<TimelineMergeUndoResult, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    let project = canonical_project(project_dir)?;
    let root = backup_root(&project);
    if !root.exists() {
        return Err("there is no timeline merge to undo".to_string());
    }
    let entries =
        fs::read_dir(&root).map_err(|error| format!("failed to list timeline backups: {error}"))?;
    let mut newest: Option<(TimelineMergeManifest, PathBuf)> = None;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("manifest.json");
        let Ok(source) = fs::read_to_string(&manifest_path) else {
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
    write_manifest(&backup_dir.join("manifest.json"), &manifest)?;
    Ok(TimelineMergeUndoResult {
        merge_id: manifest.merge_id,
        from_topic_id: manifest.from_topic_id,
        into_topic_id: manifest.into_topic_id,
        restored_events: restored,
    })
}

/// spec 262: a non-fatal notice when a recorded occurrence time sits far in the
/// future. Reported, never enforced — the human authorized the write.
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

fn random_hex() -> Result<String, String> {
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
    instruction_excerpt: Option<&str>,
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
    }
    frontmatter.push("---".to_string());
    let mut sections = vec![frontmatter.join("\n"), format!("# {}", request.summary)];
    if let Some(suggestion) = suggestion {
        sections.push(format!("## Evidence\n{}", suggestion.evidence_excerpt));
    }
    if let Some(instruction_excerpt) = instruction_excerpt {
        sections.push(format!("## Authorizing instruction\n{instruction_excerpt}"));
    }
    sections.push(format!("## Rationale\n{}", request.rationale));
    sections.push(format!("## Impact\n{}", request.impact));
    Ok(format!("{}\n", sections.join("\n\n")))
}

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

pub(crate) fn record_project(
    project_dir: &Path,
    request: TimelineRecordRequest,
) -> Result<TimelineEvent, String> {
    record_project_with_provenance(project_dir, request, "Local user", None)
}

fn record_project_with_provenance(
    project_dir: &Path,
    request: TimelineRecordRequest,
    recorded_by: &str,
    instruction_excerpt: Option<&str>,
) -> Result<TimelineEvent, String> {
    let request = validate_record_request(project_dir, request)?;
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
            &request,
            recorded_by,
            None,
            instruction_excerpt,
        )?;
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(markdown.as_bytes())
                    .map_err(|error| format!("failed to write timeline event: {error}"))?;
                file.sync_all()
                    .map_err(|error| format!("failed to flush timeline event: {error}"))?;
                return parse_event(&project, &path, &markdown);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("failed to create timeline event: {error}")),
        }
    }
    Err("failed to allocate a unique timeline event id".to_string())
}

fn normalized_dedup_key(topic_title: &str, summary: &str) -> String {
    [topic_title, summary]
        .into_iter()
        .map(|value| {
            value
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalized_text(value: &str) -> String {
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
    request.instruction_excerpt = validate_body_with_limit(
        "instructionExcerpt",
        &request.instruction_excerpt,
        MAX_EVIDENCE_CHARS,
    )?;
    if request.instruction_excerpt.is_empty() {
        return Err("instructionExcerpt is required".to_string());
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
        && event.instruction_excerpt.as_deref().is_some_and(|value| {
            normalized_text(value) == normalized_text(&request.instruction_excerpt)
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
    let pending = scan_suggestions_project(project_dir)?
        .suggestions
        .into_iter()
        .find(|suggestion| {
            normalized_dedup_key(&suggestion.topic_title, &suggestion.summary)
                == normalized_dedup_key(&request.topic_title, &request.summary)
        });
    let occurred_at = request
        .occurred_at
        .clone()
        .or_else(|| {
            pending
                .as_ref()
                .map(|suggestion| suggestion.occurred_at.clone())
        })
        .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
    let record_request = TimelineRecordRequest {
        topic_id,
        topic_title: request.topic_title.clone(),
        summary: request.summary.clone(),
        occurred_at,
        made_by: request.made_by.clone(),
        rationale: request.rationale.clone(),
        impact: request.impact.clone(),
        source_ref: request.source_ref.clone(),
        relation: request.relation,
        related_event: request.related_event.clone(),
        recorder_lane: lane_label,
    };
    let instruction_excerpt = request.instruction_excerpt.as_str();
    let event = if let Some(suggestion) = pending.as_ref() {
        confirm_suggestion_project_locked(
            project_dir,
            &suggestion.id,
            record_request,
            "Agent via explicit user instruction",
            Some(instruction_excerpt),
        )?
    } else {
        record_project_with_provenance(
            project_dir,
            record_request,
            "Agent via explicit user instruction",
            Some(instruction_excerpt),
        )?
    };
    let warnings = future_occurrence_warning(&event.occurred_at, now)
        .into_iter()
        .collect();
    Ok(TimelineDirectRecordResult {
        event,
        disposition: if pending.is_some() {
            TimelineDirectRecordDisposition::PromotedPending
        } else {
            TimelineDirectRecordDisposition::Created
        },
        new_topic,
        existing_topics,
        warnings,
    })
}

fn render_suggestion_markdown(suggestion: &TimelineSuggestion) -> Result<String, String> {
    let mut frontmatter = vec![
        "---".to_string(),
        format!("schema: {SCHEMA_VERSION}"),
        format!("id: {}", yaml_string(&suggestion.id)?),
        format!("status: {}", yaml_string("pending")?),
        format!("topic_title: {}", yaml_string(&suggestion.topic_title)?),
        format!("occurred_at: {}", yaml_string(&suggestion.occurred_at)?),
        format!("made_by: {}", yaml_string(&suggestion.made_by)?),
        format!("suggested_at: {}", yaml_string(&suggestion.suggested_at)?),
        format!(
            "suggested_by_lane: {}",
            yaml_string(&suggestion.suggested_by_lane)?
        ),
    ];
    if let Some(source_ref) = &suggestion.source_ref {
        frontmatter.push(format!("source_ref: {}", yaml_string(source_ref)?));
    }
    frontmatter.push("---".to_string());
    Ok(format!(
        "{}\n# {}\n\n## Evidence\n{}\n\n## Rationale\n{}\n\n## Impact\n{}\n",
        frontmatter.join("\n"),
        suggestion.summary,
        suggestion.evidence_excerpt,
        suggestion.rationale,
        suggestion.impact,
    ))
}

pub(crate) fn suggestion_settings_project(
    project_dir: &Path,
) -> Result<TimelineSuggestionSettings, String> {
    let project = canonical_project(project_dir)?;
    let path = settings_path(&project);
    if !path.exists() {
        return Ok(TimelineSuggestionSettings::default());
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("failed to inspect timeline settings: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("timeline settings must be a regular file".to_string());
    }
    if metadata.len() > 16 * 1024 {
        return Err("timeline settings file is too large".to_string());
    }
    let source = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read timeline settings: {error}"))?;
    #[derive(Deserialize)]
    struct StoredSettings {
        schema: u8,
        #[serde(rename = "automaticSuggestions")]
        automatic_suggestions: bool,
    }
    let stored: StoredSettings = serde_json::from_str(&source)
        .map_err(|error| format!("invalid timeline settings: {error}"))?;
    if stored.schema != SCHEMA_VERSION {
        return Err("unsupported timeline settings schema".to_string());
    }
    Ok(TimelineSuggestionSettings {
        automatic_suggestions: stored.automatic_suggestions,
    })
}

pub(crate) fn set_suggestion_enabled_project(
    project_dir: &Path,
    enabled: bool,
) -> Result<TimelineSuggestionSettings, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    let project = canonical_project(project_dir)?;
    let timeline_root = project.join(".krypton").join("timeline");
    fs::create_dir_all(&timeline_root)
        .map_err(|error| format!("failed to create timeline directory: {error}"))?;
    let canonical = timeline_root
        .canonicalize()
        .map_err(|error| format!("failed to resolve timeline directory: {error}"))?;
    if !canonical.starts_with(&project) {
        return Err("timeline directory resolves outside the project".to_string());
    }
    let settings = TimelineSuggestionSettings {
        automatic_suggestions: enabled,
    };
    let target = settings_path(&project);
    let temp = canonical.join(format!("settings-{}.tmp", random_hex()?));
    let payload = serde_json::to_vec_pretty(&serde_json::json!({
        "schema": SCHEMA_VERSION,
        "automaticSuggestions": enabled,
    }))
    .map_err(|error| format!("failed to encode timeline settings: {error}"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| format!("failed to create timeline settings: {error}"))?;
    if let Err(error) = file.write_all(&payload).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(format!("failed to write timeline settings: {error}"));
    }
    if let Err(error) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(format!("failed to replace timeline settings: {error}"));
    }
    Ok(settings)
}

pub(crate) fn suggest_project(
    project_dir: &Path,
    lane_label: &str,
    mut request: TimelineSuggestionRequest,
) -> Result<(TimelineSuggestion, usize), String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    if !suggestion_settings_project(project_dir)?.automatic_suggestions {
        return Err("automatic timeline suggestions are disabled for this project".to_string());
    }
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
    let lane_label = validate_single_line("suggestedByLane", lane_label, MAX_ACTOR_CHARS)?;
    let existing = scan_suggestions_project(project_dir)?;
    let key = normalized_dedup_key(&request.topic_title, &request.summary);
    if let Some(suggestion) = existing.suggestions.iter().find(|suggestion| {
        normalized_dedup_key(&suggestion.topic_title, &suggestion.summary) == key
    }) {
        return Ok((suggestion.clone(), existing.suggestions.len()));
    }
    let pending_count = existing.suggestions.len();
    if pending_count >= MAX_PENDING_SUGGESTIONS {
        return Err(
            "timeline pending limit reached; review or dismiss existing suggestions".to_string(),
        );
    }
    let (project, root) =
        writable_confined_root(project_dir, pending_root(project_dir), "timeline pending")?;
    for _ in 0..10 {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let id = format!(
            "tl-{}-{}",
            Utc::now().format("%Y%m%dT%H%M%SZ"),
            random_hex()?
        );
        let path = root.join(format!("{id}.md"));
        let suggestion = TimelineSuggestion {
            schema: SCHEMA_VERSION,
            id,
            topic_title: request.topic_title.clone(),
            summary: request.summary.clone(),
            made_by: request.made_by.clone(),
            occurred_at: now.clone(),
            evidence_excerpt: request.evidence_excerpt.clone(),
            rationale: request.rationale.clone(),
            impact: request.impact.clone(),
            source_ref: request.source_ref.clone(),
            suggested_at: now,
            suggested_by_lane: lane_label.clone(),
            path: relative_path(&project, &path),
        };
        let markdown = render_suggestion_markdown(&suggestion)?;
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(markdown.as_bytes())
                    .map_err(|error| format!("failed to write timeline suggestion: {error}"))?;
                file.sync_all()
                    .map_err(|error| format!("failed to flush timeline suggestion: {error}"))?;
                return Ok((
                    parse_suggestion(&project, &path, &markdown)?,
                    pending_count + 1,
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("failed to create timeline suggestion: {error}")),
        }
    }
    Err("failed to allocate a unique timeline suggestion id".to_string())
}

fn pending_suggestion_by_id(
    project_dir: &Path,
    suggestion_id: &str,
) -> Result<TimelineSuggestion, String> {
    let suggestion_id = validate_event_id(suggestion_id)?;
    scan_suggestions_project(project_dir)?
        .suggestions
        .into_iter()
        .find(|suggestion| suggestion.id == suggestion_id)
        .ok_or_else(|| format!("timeline suggestion does not exist: {suggestion_id}"))
}

pub(crate) fn confirm_suggestion_project(
    project_dir: &Path,
    suggestion_id: &str,
    request: TimelineRecordRequest,
) -> Result<TimelineEvent, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    confirm_suggestion_project_locked(project_dir, suggestion_id, request, "Local user", None)
}

fn confirm_suggestion_project_locked(
    project_dir: &Path,
    suggestion_id: &str,
    request: TimelineRecordRequest,
    recorded_by: &str,
    instruction_excerpt: Option<&str>,
) -> Result<TimelineEvent, String> {
    let suggestion_id = validate_event_id(suggestion_id)?;
    if let Some(event) = scan_project(project_dir)?
        .events
        .into_iter()
        .find(|event| event.suggestion_id.as_deref() == Some(suggestion_id.as_str()))
    {
        if let Some((_, pending)) =
            existing_confined_root(project_dir, pending_root(project_dir), "timeline pending")?
        {
            let _ = fs::remove_file(pending.join(format!("{suggestion_id}.md")));
        }
        return Ok(event);
    }
    let suggestion = pending_suggestion_by_id(project_dir, &suggestion_id)?;
    let request = validate_record_request(project_dir, request)?;
    let (project, root) = writable_event_root(project_dir)?;
    let path = root.join(format!("{suggestion_id}.md"));
    let recorded_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let markdown = render_event_markdown(
        &suggestion_id,
        &recorded_at,
        &request,
        recorded_by,
        Some(&suggestion),
        instruction_excerpt,
    )?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(markdown.as_bytes())
                .map_err(|error| format!("failed to write timeline event: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("failed to flush timeline event: {error}"))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let source = fs::read_to_string(&path).map_err(|read_error| {
                format!("failed to read existing timeline event: {read_error}")
            })?;
            let event = parse_event(&project, &path, &source)?;
            if event.suggestion_id.as_deref() != Some(suggestion_id.as_str()) {
                return Err(format!(
                    "timeline event id is already used by another record: {suggestion_id}"
                ));
            }
        }
        Err(error) => return Err(format!("failed to create timeline event: {error}")),
    }
    let event = parse_event(
        &project,
        &path,
        &fs::read_to_string(&path)
            .map_err(|error| format!("failed to read confirmed timeline event: {error}"))?,
    )?;
    if let Some((_, pending)) =
        existing_confined_root(project_dir, pending_root(project_dir), "timeline pending")?
    {
        let pending_path = pending.join(format!("{suggestion_id}.md"));
        match fs::remove_file(&pending_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("event saved but pending cleanup failed: {error}")),
        }
    }
    Ok(event)
}

pub(crate) fn dismiss_suggestion_project(
    project_dir: &Path,
    suggestion_id: &str,
) -> Result<TimelineSuggestion, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline mutation lock is unavailable".to_string())?;
    let suggestion = pending_suggestion_by_id(project_dir, suggestion_id)?;
    let (_, pending) =
        existing_confined_root(project_dir, pending_root(project_dir), "timeline pending")?
            .ok_or_else(|| "timeline pending directory does not exist".to_string())?;
    let (_, dismissed) = writable_confined_root(
        project_dir,
        dismissed_root(project_dir),
        "timeline dismissed",
    )?;
    let source = pending.join(format!("{}.md", suggestion.id));
    let target = dismissed.join(format!("{}.md", suggestion.id));
    if target.exists() {
        return Err(format!(
            "timeline suggestion was already dismissed: {}",
            suggestion.id
        ));
    }
    match fs::rename(&source, &target) {
        Ok(()) => Ok(suggestion),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "timeline suggestion was already dismissed: {}",
            suggestion.id
        )),
        Err(error) => Err(format!("failed to dismiss timeline suggestion: {error}")),
    }
}

fn project_dir(
    hook_server: &tauri::State<'_, Arc<HookServer>>,
    harness_id: &str,
) -> Result<PathBuf, String> {
    hook_server
        .project_dir_for_harness(harness_id)
        .ok_or_else(|| format!("no project directory is registered for harness {harness_id}"))
}

#[tauri::command]
pub fn timeline_list(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineListResponse, String> {
    scan_project(&project_dir(&hook_server, &harness_id)?)
}

#[tauri::command]
pub fn timeline_record(
    harness_id: String,
    request: TimelineRecordRequest,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineEvent, String> {
    record_project(&project_dir(&hook_server, &harness_id)?, request)
}

/// spec 263: human-only repair for topics that were split before spec 262.
/// Deliberately a Tauri command and not an MCP tool.
#[tauri::command]
pub fn timeline_merge_topics(
    harness_id: String,
    from: String,
    into: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineMergeResult, String> {
    merge_topics_project(&project_dir(&hook_server, &harness_id)?, &from, &into, None)
}

#[tauri::command]
pub fn timeline_merge_undo(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineMergeUndoResult, String> {
    undo_last_merge_project(&project_dir(&hook_server, &harness_id)?)
}

#[tauri::command]
pub fn timeline_suggestion_list(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineSuggestionListResponse, String> {
    scan_suggestions_project(&project_dir(&hook_server, &harness_id)?)
}

#[tauri::command]
pub fn timeline_suggestion_confirm(
    harness_id: String,
    suggestion_id: String,
    request: TimelineRecordRequest,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineEvent, String> {
    confirm_suggestion_project(
        &project_dir(&hook_server, &harness_id)?,
        &suggestion_id,
        request,
    )
}

#[tauri::command]
pub fn timeline_suggestion_dismiss(
    harness_id: String,
    suggestion_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineSuggestion, String> {
    dismiss_suggestion_project(&project_dir(&hook_server, &harness_id)?, &suggestion_id)
}

#[tauri::command]
pub fn timeline_suggestion_settings(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineSuggestionSettings, String> {
    suggestion_settings_project(&project_dir(&hook_server, &harness_id)?)
}

#[tauri::command]
pub fn timeline_suggestion_set_enabled(
    harness_id: String,
    enabled: bool,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineSuggestionSettings, String> {
    set_suggestion_enabled_project(&project_dir(&hook_server, &harness_id)?, enabled)
}

fn validate_semantic_candidates(
    events: &[TimelineEvent],
    request: &TimelineTopicSemanticRequest,
) -> Result<(), String> {
    for candidate in &request.candidates {
        let topic_events: Vec<&TimelineEvent> = events
            .iter()
            .filter(|event| event.topic_id == candidate.topic_id)
            .collect();
        if topic_events.is_empty()
            || !topic_events.iter().any(|event| {
                event.topic_title == candidate.title && event.occurred_at == candidate.occurred_at
            })
        {
            return Err(format!(
                "TypeSafe timeline topic candidate is stale or unknown: {}",
                candidate.topic_id
            ));
        }
        let summaries: HashSet<String> = topic_events
            .iter()
            .map(|event| {
                event
                    .summary
                    .trim()
                    .chars()
                    .take(MAX_SEMANTIC_SUMMARY_CHARS)
                    .collect()
            })
            .collect();
        if candidate
            .recent_summaries
            .iter()
            .any(|summary| !summaries.contains(summary))
        {
            return Err(format!(
                "TypeSafe timeline topic candidate summary is not project-backed: {}",
                candidate.topic_id
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn timeline_topic_suggest(
    harness_id: String,
    request: TimelineTopicSemanticRequest,
    hook_server: tauri::State<'_, Arc<HookServer>>,
    config: tauri::State<'_, Arc<std::sync::RwLock<crate::config::KryptonConfig>>>,
    typesafe: tauri::State<'_, Arc<TypeSafeState>>,
) -> Result<TimelineTopicSemanticResult, String> {
    // Resolve the harness before any credential or network work. Timeline
    // semantic suggestions are local-project UI, never a generic proxy.
    let project = project_dir(&hook_server, &harness_id)?;
    let listing = scan_project(&project)?;
    validate_semantic_candidates(&listing.events, &request)?;
    let typesafe_config = config
        .read()
        .map_err(|_| "config lock is unavailable".to_string())?
        .typesafe
        .clone();
    typesafe
        .suggest_timeline_topic(typesafe_config, request)
        .await
}

#[tauri::command]
pub fn timeline_topic_suggest_cancel(
    request_id: String,
    typesafe: tauri::State<'_, Arc<TypeSafeState>>,
) -> bool {
    typesafe.cancel(&request_id)
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
            source_ref: Some("docs/253-project-decision-requirement-timeline.md".to_string()),
            relation: None,
            related_event: None,
            recorder_lane: "Codex-1".to_string(),
        }
    }

    fn suggestion_request() -> TimelineSuggestionRequest {
        TimelineSuggestionRequest {
            topic_title: "Upload validation".to_string(),
            summary: "Metadata transfer is required".to_string(),
            made_by: "Product owner".to_string(),
            evidence_excerpt: "We require metadata transfer before completion.".to_string(),
            rationale: "The consumer needs metadata.".to_string(),
            impact: "Revise completion handling.".to_string(),
            source_ref: Some("conversation:turn-4".to_string()),
        }
    }

    fn direct_request() -> TimelineDirectRecordRequest {
        TimelineDirectRecordRequest {
            topic_id: None,
            topic_title: "Upload validation".to_string(),
            summary: "Metadata transfer is required".to_string(),
            made_by: "Current user".to_string(),
            instruction_excerpt: "Record this decision in the timeline.".to_string(),
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
    fn suggestion_round_trip_deduplicates_and_defaults_enabled() {
        let dir = TestDir::new("suggestion-round-trip");
        assert!(
            suggestion_settings_project(&dir.0)
                .unwrap()
                .automatic_suggestions
        );
        let (saved, count) = suggest_project(&dir.0, "Codex-1", suggestion_request()).unwrap();
        assert_eq!(count, 1);
        assert!(saved.path.starts_with(".krypton/timeline/pending/tl-"));
        let (duplicate, duplicate_count) = suggest_project(
            &dir.0,
            "Claude-1",
            TimelineSuggestionRequest {
                topic_title: "  UPLOAD   VALIDATION ".to_string(),
                summary: "METADATA transfer is required".to_string(),
                ..suggestion_request()
            },
        )
        .unwrap();
        assert_eq!(duplicate.id, saved.id);
        assert_eq!(duplicate.suggested_by_lane, "Codex-1");
        assert_eq!(duplicate_count, 1);
        assert_eq!(
            scan_suggestions_project(&dir.0).unwrap().suggestions,
            vec![saved]
        );
    }

    #[test]
    fn direct_record_writes_authorizing_instruction_and_is_idempotent() {
        let dir = TestDir::new("direct-record");
        let created = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        assert_eq!(
            created.disposition,
            TimelineDirectRecordDisposition::Created
        );
        assert_eq!(
            created.event.recorded_by,
            "Agent via explicit user instruction"
        );
        assert_eq!(created.event.recorder_lane, "Codex-2");
        assert_eq!(created.event.topic_id, "topic-upload-validation");
        assert_eq!(
            created.event.instruction_excerpt.as_deref(),
            Some("Record this decision in the timeline.")
        );
        let body = fs::read_to_string(dir.0.join(&created.event.path)).unwrap();
        assert!(body.contains("## Authorizing instruction\nRecord this decision in the timeline."));

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
        // the write still happened: a human authorized it
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
                instruction_excerpt: "รวมสองหัวข้อนี้เข้าด้วยกัน".to_string(),
            }),
        )
        .unwrap();
        assert_eq!(merged.from_topic_id, split.event.topic_id);
        assert_eq!(merged.into_topic_id, keeper.event.topic_id);
        assert_eq!(merged.moved_events, 1);
        assert!(merged
            .backup_path
            .starts_with(".krypton/timeline/backups/mrg-"));
        // an agent-performed merge is traceable: the manifest keeps the lane and
        // the human's authorizing words
        let manifest: TimelineMergeManifest = serde_json::from_str(
            &fs::read_to_string(dir.0.join(&merged.backup_path).join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.merged_by_lane.as_deref(), Some("Claude-2"));
        assert_eq!(
            manifest.instruction_excerpt.as_deref(),
            Some("รวมสองหัวข้อนี้เข้าด้วยกัน")
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

        let undone = undo_last_merge_project(&dir.0).unwrap();
        assert_eq!(undone.merge_id, merged.merge_id);
        assert_eq!(undone.restored_events, 1);
        assert_eq!(
            fs::read_to_string(dir.0.join(&split.event.path)).unwrap(),
            before
        );
        // one merge cannot be undone twice
        assert!(undo_last_merge_project(&dir.0)
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
    fn direct_record_promotes_matching_pending_without_review() {
        let dir = TestDir::new("direct-promote");
        let (suggestion, _) = suggest_project(&dir.0, "Codex-1", suggestion_request()).unwrap();
        set_suggestion_enabled_project(&dir.0, false).unwrap();

        let promoted = record_direct_project(&dir.0, "Codex-2", direct_request()).unwrap();
        assert_eq!(
            promoted.disposition,
            TimelineDirectRecordDisposition::PromotedPending
        );
        assert_eq!(promoted.event.id, suggestion.id);
        assert_eq!(promoted.event.suggested_by_lane.as_deref(), Some("Codex-1"));
        assert_eq!(
            promoted.event.evidence_excerpt.as_deref(),
            Some("We require metadata transfer before completion.")
        );
        assert_eq!(
            promoted.event.instruction_excerpt.as_deref(),
            Some("Record this decision in the timeline.")
        );
        assert!(scan_suggestions_project(&dir.0)
            .unwrap()
            .suggestions
            .is_empty());
    }

    #[test]
    fn disabled_setting_rejects_new_suggestions_without_clearing_pending() {
        let dir = TestDir::new("suggestion-disabled");
        suggest_project(&dir.0, "Codex-1", suggestion_request()).unwrap();
        let settings = set_suggestion_enabled_project(&dir.0, false).unwrap();
        assert!(!settings.automatic_suggestions);
        assert!(
            !suggestion_settings_project(&dir.0)
                .unwrap()
                .automatic_suggestions
        );
        assert!(suggest_project(&dir.0, "Codex-1", suggestion_request())
            .unwrap_err()
            .contains("disabled"));
        assert_eq!(
            scan_suggestions_project(&dir.0).unwrap().suggestions.len(),
            1
        );
    }

    #[test]
    fn confirmation_promotes_reserved_id_and_preserves_provenance() {
        let dir = TestDir::new("suggestion-confirm");
        let (suggestion, _) = suggest_project(&dir.0, "Codex-1", suggestion_request()).unwrap();
        let event = confirm_suggestion_project(&dir.0, &suggestion.id, request()).unwrap();
        assert_eq!(event.id, suggestion.id);
        assert_eq!(event.suggestion_id.as_deref(), Some(suggestion.id.as_str()));
        assert_eq!(event.suggested_by_lane.as_deref(), Some("Codex-1"));
        assert_eq!(
            event.evidence_excerpt.as_deref(),
            Some("We require metadata transfer before completion.")
        );
        assert!(scan_suggestions_project(&dir.0)
            .unwrap()
            .suggestions
            .is_empty());
        let retried = confirm_suggestion_project(&dir.0, &suggestion.id, request()).unwrap();
        assert_eq!(retried.id, event.id);
        assert_eq!(scan_project(&dir.0).unwrap().events.len(), 1);
    }

    #[test]
    fn semantic_candidates_must_come_from_the_registered_project_timeline() {
        let dir = TestDir::new("semantic-candidates");
        let event = record_project(&dir.0, request()).unwrap();
        let mut semantic = TimelineTopicSemanticRequest {
            request_id: "timeline-1".to_string(),
            draft: crate::typesafe::TimelineTopicDraft {
                title: "ตรวจ metadata ก่อน upload".to_string(),
                summary: "ตรวจข้อมูลก่อนส่งเอกสาร".to_string(),
            },
            candidates: vec![crate::typesafe::TimelineTopicCandidate {
                topic_id: event.topic_id.clone(),
                title: event.topic_title.clone(),
                occurred_at: event.occurred_at.clone(),
                recent_summaries: vec![event.summary.clone()],
                lexical_score: 20,
            }],
        };
        assert!(validate_semantic_candidates(&[event.clone()], &semantic).is_ok());
        semantic.candidates[0].recent_summaries = vec!["untrusted transcript text".to_string()];
        assert!(validate_semantic_candidates(&[event], &semantic)
            .unwrap_err()
            .contains("not project-backed"));
    }

    #[test]
    fn dismissal_archives_without_creating_an_event() {
        let dir = TestDir::new("suggestion-dismiss");
        let (suggestion, _) = suggest_project(&dir.0, "Codex-1", suggestion_request()).unwrap();
        let dismissed = dismiss_suggestion_project(&dir.0, &suggestion.id).unwrap();
        assert_eq!(dismissed.id, suggestion.id);
        assert!(dismissed_root(&dir.0)
            .join(format!("{}.md", suggestion.id))
            .is_file());
        assert!(scan_suggestions_project(&dir.0)
            .unwrap()
            .suggestions
            .is_empty());
        assert!(scan_project(&dir.0).unwrap().events.is_empty());
    }
}
