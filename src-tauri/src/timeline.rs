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

const SCHEMA_VERSION: u8 = 1;
const MAX_EVENTS: usize = 2_000;
const MAX_EVENT_BYTES: u64 = 32 * 1024;
const MAX_TOPIC_CHARS: usize = 120;
const MAX_SUMMARY_CHARS: usize = 500;
const MAX_ACTOR_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 4 * 1024;
const MAX_SOURCE_CHARS: usize = 2 * 1024;
const MAX_EVIDENCE_CHARS: usize = 1_000;
const MAX_PENDING_SUGGESTIONS: usize = 100;
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
    if value
        .lines()
        .any(|line| matches!(line.trim(), "## Evidence" | "## Rationale" | "## Impact"))
    {
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
    let evidence_excerpt = {
        let evidence = body_section(&body, "Evidence", Some("Rationale"));
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
    suggestion: Option<&TimelineSuggestion>,
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
        format!("recorded_by: {}", yaml_string("Local user")?),
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
    let evidence = suggestion
        .map(|suggestion| format!("\n## Evidence\n{}\n", suggestion.evidence_excerpt))
        .unwrap_or_default();
    Ok(format!(
        "{}\n# {}\n{}\n## Rationale\n{}\n\n## Impact\n{}\n",
        frontmatter.join("\n"),
        request.summary,
        evidence,
        request.rationale,
        request.impact,
    ))
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
        let markdown = render_event_markdown(&id, &recorded_at, &request, None)?;
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
    let markdown =
        render_event_markdown(&suggestion_id, &recorded_at, &request, Some(&suggestion))?;
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
