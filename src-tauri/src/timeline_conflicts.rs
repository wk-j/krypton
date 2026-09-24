//! Timeline decision trace and conflict review (spec 266).
//!
//! Confirmed timeline events stay untouched. `supersedes` links project into
//! chains; pairs that may conflict live in append-only sidecar files under
//! `.krypton/timeline/conflicts/`, always keyed by event ID so topic renames
//! and merges never orphan them. A proposal only says "look at this pair"; the
//! human review is the only thing that records a verdict, and the newest review
//! of a pair is its current state.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::hook_server::HookServer;
use crate::timeline::{
    existing_confined_root, normalized_text, project_dir, random_hex, relative_path, scan_project,
    validate_event_id, validate_optional_single_line, writable_confined_root, TimelineDiagnostic,
    TimelineEvent, TimelineListResponse, TimelineRelation, TIMELINE_MUTATION_LOCK,
};
use crate::typesafe::{
    TimelineConflictCandidate, TimelineConflictOutcome, TimelineConflictSide,
    TimelineTopicFallbackReason, TypeSafeState,
};

const SIDECAR_SCHEMA: u8 = 1;
const MAX_SIDECAR_BYTES: u64 = 16 * 1024;
const MAX_PROPOSALS: usize = 500;
const MAX_REVIEWS: usize = 2_000;
const MAX_SCANS: usize = 200;
const MAX_RATIONALE_CHARS: usize = 1_000;
const MAX_SOURCE_CHARS: usize = 2 * 1024;
const MAX_SCAN_PAIRS: usize = 40;
const MAX_SCAN_SUMMARY_CHARS: usize = 240;
const MAX_SCAN_TOPIC_CHARS: usize = 120;
const MIN_KEYWORD_CHARS: usize = 3;
/// Reviews come from the local app user, never from a payload field.
const LOCAL_REVIEWER: &str = "Local user";
const TYPESAFE_BASIS: &str =
    "TypeSafe คัดกรองจากข้อความสรุปเท่านั้น ไม่ใช่หลักฐาน — เปิดต้นทางทั้งสองรายการเพื่อตรวจเอง";

// ─── Sidecar files (snake_case on disk) ──────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineConflictOrigin {
    Manual,
    Typesafe,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineConflictVerdict {
    Confirmed,
    Dismissed,
    InsufficientEvidence,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposalFile {
    schema: u8,
    pair_id: String,
    event_a: String,
    event_b: String,
    origin: TimelineConflictOrigin,
    suggested_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    probability: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_hash: Option<String>,
    basis: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewFile {
    schema: u8,
    id: String,
    pair_id: String,
    verdict: TimelineConflictVerdict,
    rationale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resolution_event_id: Option<String>,
    reviewed_at: String,
    reviewed_by: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineScanRunState {
    Completed,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanCheck {
    pair_id: String,
    input_hash: String,
    outcome: TimelineConflictOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanFile {
    schema: u8,
    id: String,
    model: String,
    completed_at: String,
    state: TimelineScanRunState,
    checked_pairs: u32,
    skipped_pairs: u32,
    proposed_pairs: u32,
    inconclusive_pairs: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    checked: Vec<ScanCheck>,
}

// ─── Read model (camelCase over IPC and /timeline.json) ──────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineChainLink {
    pub from: String,
    pub to: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineChain {
    pub topic_id: String,
    pub event_ids: Vec<String>,
    pub links: Vec<TimelineChainLink>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineConflictState {
    Unreviewed,
    Confirmed,
    Dismissed,
    InsufficientEvidence,
    Resolved,
    Historical,
}

impl TimelineConflictState {
    fn needs_review(self) -> bool {
        matches!(self, Self::Unreviewed | Self::InsufficientEvidence)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConflictReview {
    pub id: String,
    pub verdict: TimelineConflictVerdict,
    pub rationale: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_event_id: Option<String>,
    pub reviewed_by: String,
    pub reviewed_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConflictPair {
    pub pair_id: String,
    pub event_a: String,
    pub event_b: String,
    pub state: TimelineConflictState,
    pub origin: TimelineConflictOrigin,
    pub basis: String,
    pub suggested_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probability: Option<f64>,
    pub reviews: Vec<TimelineConflictReview>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineScanState {
    NeverRun,
    Completed,
    Partial,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineScanSummary {
    pub enabled: bool,
    pub state: TimelineScanState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_completed_at: Option<String>,
    pub checked_pairs: u32,
    pub skipped_pairs: u32,
    pub inconclusive_pairs: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Counts are project-wide and count each pair once; a cross-topic pair
/// appears in both topics' filtered views but not twice here.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConflictCounts {
    pub needs_review: u32,
    pub confirmed: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTraceResponse {
    #[serde(flatten)]
    pub listing: TimelineListResponse,
    pub chains: Vec<TimelineChain>,
    pub conflict_pairs: Vec<TimelineConflictPair>,
    pub conflict_counts: TimelineConflictCounts,
    pub scan: TimelineScanSummary,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConflictScan {
    pub state: TimelineScanRunState,
    pub checked_pairs: u32,
    pub skipped_pairs: u32,
    pub proposed_pairs: u32,
    pub inconclusive_pairs: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

// ─── Paths and file IO ───────────────────────────────────────────────

fn conflicts_root(project_dir: &Path) -> PathBuf {
    project_dir
        .join(".krypton")
        .join("timeline")
        .join("conflicts")
}

fn proposals_dir(project_dir: &Path) -> PathBuf {
    conflicts_root(project_dir).join("proposals")
}

fn reviews_dir(project_dir: &Path) -> PathBuf {
    conflicts_root(project_dir).join("reviews")
}

fn scans_dir(project_dir: &Path) -> PathBuf {
    conflicts_root(project_dir).join("scans")
}

/// Canonical, order-independent pair ID so the same two events can never be
/// proposed twice under different names.
pub(crate) fn canonical_pair(event_a: &str, event_b: &str) -> (String, String, String) {
    let (a, b) = if event_a <= event_b {
        (event_a, event_b)
    } else {
        (event_b, event_a)
    };
    (a.to_string(), b.to_string(), format!("{a}--{b}"))
}

fn validate_pair_id(value: &str) -> Result<(String, String, String), String> {
    let value = value.trim();
    let Some((a, b)) = value.split_once("--") else {
        return Err("pairId is not a valid timeline conflict pair id".to_string());
    };
    let a = validate_event_id(a).map_err(|_| "pairId contains an invalid event id")?;
    let b = validate_event_id(b).map_err(|_| "pairId contains an invalid event id")?;
    let canonical = canonical_pair(&a, &b);
    if a == b || canonical.2 != value {
        return Err("pairId is not canonical".to_string());
    }
    Ok(canonical)
}

fn validate_sidecar_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn validate_rationale(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("rationale is required".to_string());
    }
    if value.chars().count() > MAX_RATIONALE_CHARS {
        return Err(format!(
            "rationale must be at most {MAX_RATIONALE_CHARS} Unicode characters"
        ));
    }
    if value.contains('\0') {
        return Err("rationale contains an invalid character".to_string());
    }
    Ok(value.to_string())
}

/// Bounded read of one sidecar directory: regular `.json` files only, each
/// capped in size, every failure surfaced as a diagnostic.
fn read_sidecars<T: DeserializeOwned>(
    project_dir: &Path,
    requested: PathBuf,
    label: &str,
    cap: usize,
    diagnostics: &mut Vec<TimelineDiagnostic>,
) -> Vec<(T, String, String)> {
    let (project, root) = match existing_confined_root(project_dir, requested, label) {
        Ok(Some(roots)) => roots,
        Ok(None) => return Vec::new(),
        Err(error) => {
            diagnostics.push(TimelineDiagnostic {
                path: ".krypton/timeline/conflicts".to_string(),
                error,
            });
            return Vec::new();
        }
    };
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) => {
            diagnostics.push(TimelineDiagnostic {
                path: relative_path(&project, &root),
                error: format!("failed to list {label} files: {error}"),
            });
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= cap {
            diagnostics.push(TimelineDiagnostic {
                path: relative_path(&project, &root),
                error: format!("more than {cap} {label} files; the rest were not read"),
            });
            break;
        }
        let path = entry.path();
        let display = relative_path(&project, &path);
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file()
            || file_type.is_symlink()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let Some(stem) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        match entry.metadata() {
            Ok(metadata) if metadata.len() > MAX_SIDECAR_BYTES => {
                diagnostics.push(TimelineDiagnostic {
                    path: display,
                    error: format!("{label} file exceeds {MAX_SIDECAR_BYTES} bytes"),
                });
                continue;
            }
            Ok(_) => {}
            Err(error) => {
                diagnostics.push(TimelineDiagnostic {
                    path: display,
                    error: format!("failed to inspect {label} file: {error}"),
                });
                continue;
            }
        }
        match fs::read(&path)
            .map_err(|error| format!("failed to read {label} file: {error}"))
            .and_then(|bytes| {
                serde_json::from_slice::<T>(&bytes)
                    .map_err(|error| format!("malformed {label} file: {error}"))
            }) {
            Ok(value) => out.push((value, stem, display)),
            Err(error) => diagnostics.push(TimelineDiagnostic {
                path: display,
                error,
            }),
        }
    }
    out
}

fn write_new_json<T: Serialize>(path: &Path, value: &T) -> Result<bool, String> {
    let body = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to encode timeline conflict file: {error}"))?;
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(&body)
                .and_then(|()| file.write_all(b"\n"))
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("failed to write timeline conflict file: {error}"))?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!("failed to create timeline conflict file: {error}")),
    }
}

fn now_millis() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_sidecar_id(prefix: &str) -> Result<String, String> {
    Ok(format!(
        "{prefix}{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%3fZ"),
        random_hex()?
    ))
}

// ─── Trace projection ────────────────────────────────────────────────

struct Components {
    /// event id -> component index, only for events that have a link.
    of: HashMap<String, usize>,
    cyclic: HashSet<usize>,
}

fn find(parent: &mut [usize], mut node: usize) -> usize {
    while parent[node] != node {
        parent[node] = parent[parent[node]];
        node = parent[node];
    }
    node
}

/// Project `supersedes` links into chains. Branches stay visible as extra
/// links; a directed cycle is a diagnostic and that part is not summarised.
fn build_chains(
    events: &[TimelineEvent],
    diagnostics: &mut Vec<TimelineDiagnostic>,
) -> (Vec<TimelineChain>, Components) {
    let index: HashMap<&str, usize> = events
        .iter()
        .enumerate()
        .map(|(position, event)| (event.id.as_str(), position))
        .collect();
    let mut links = Vec::new();
    for (position, event) in events.iter().enumerate() {
        if event.relation != Some(TimelineRelation::Supersedes) {
            continue;
        }
        if let Some(target) = event.related_event.as_deref().and_then(|id| index.get(id)) {
            if *target != position {
                links.push((position, *target));
            }
        }
    }
    let mut parent: Vec<usize> = (0..events.len()).collect();
    for (from, to) in &links {
        let (left, right) = (find(&mut parent, *from), find(&mut parent, *to));
        if left != right {
            parent[left] = right;
        }
    }
    let mut roots: Vec<usize> = Vec::new();
    let mut root_slot: HashMap<usize, usize> = HashMap::new();
    let mut of = HashMap::new();
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut component_links: Vec<Vec<(usize, usize)>> = Vec::new();
    for (from, to) in &links {
        let root = find(&mut parent, *from);
        let slot = *root_slot.entry(root).or_insert_with(|| {
            roots.push(root);
            members.push(Vec::new());
            component_links.push(Vec::new());
            roots.len() - 1
        });
        component_links[slot].push((*from, *to));
    }
    for (position, event) in events.iter().enumerate() {
        let root = find(&mut parent, position);
        if let Some(slot) = root_slot.get(&root) {
            members[*slot].push(position);
            of.insert(event.id.clone(), *slot);
        }
    }
    let mut cyclic = HashSet::new();
    let mut chains = Vec::new();
    for (slot, member_positions) in members.iter().enumerate() {
        if has_cycle(member_positions, &component_links[slot]) {
            cyclic.insert(slot);
            let first = &events[member_positions[0]];
            diagnostics.push(TimelineDiagnostic {
                path: first.path.clone(),
                error: "supersedes links form a cycle; this chain is not summarised".to_string(),
            });
            continue;
        }
        // `scan_project` already sorts events chronologically.
        let latest = &events[*member_positions.iter().max().unwrap_or(&0)];
        chains.push(TimelineChain {
            topic_id: latest.topic_id.clone(),
            event_ids: member_positions
                .iter()
                .map(|position| events[*position].id.clone())
                .collect(),
            links: component_links[slot]
                .iter()
                .map(|(from, to)| TimelineChainLink {
                    from: events[*from].id.clone(),
                    to: events[*to].id.clone(),
                    kind: "supersedes",
                })
                .collect(),
        });
    }
    (chains, Components { of, cyclic })
}

fn has_cycle(members: &[usize], links: &[(usize, usize)]) -> bool {
    let mut outgoing: HashMap<usize, Vec<usize>> = HashMap::new();
    for (from, to) in links {
        outgoing.entry(*from).or_default().push(*to);
    }
    // 0 = unvisited, 1 = on stack, 2 = done
    let mut state: HashMap<usize, u8> = HashMap::new();
    for start in members {
        if state.get(start).copied().unwrap_or(0) != 0 {
            continue;
        }
        let mut stack = vec![(*start, 0_usize)];
        state.insert(*start, 1);
        while let Some((node, next)) = stack.pop() {
            let children = outgoing.get(&node).map(Vec::as_slice).unwrap_or(&[]);
            if let Some(child) = children.get(next) {
                stack.push((node, next + 1));
                match state.get(child).copied().unwrap_or(0) {
                    1 => return true,
                    0 => {
                        state.insert(*child, 1);
                        stack.push((*child, 0));
                    }
                    _ => {}
                }
            } else {
                state.insert(node, 2);
            }
        }
    }
    false
}

fn same_chain(components: &Components, left: &str, right: &str) -> bool {
    matches!(
        (components.of.get(left), components.of.get(right)),
        (Some(a), Some(b)) if a == b
    )
}

fn in_cycle(components: &Components, id: &str) -> bool {
    components
        .of
        .get(id)
        .is_some_and(|slot| components.cyclic.contains(slot))
}

struct LoadedSidecars {
    proposals: Vec<ProposalFile>,
    reviews: HashMap<String, Vec<ReviewFile>>,
    scans: Vec<ScanFile>,
}

fn load_sidecars(
    project_dir: &Path,
    event_ids: &HashSet<&str>,
    diagnostics: &mut Vec<TimelineDiagnostic>,
) -> LoadedSidecars {
    let mut proposals = Vec::new();
    let mut proposal_ids = HashSet::new();
    for (proposal, stem, display) in read_sidecars::<ProposalFile>(
        project_dir,
        proposals_dir(project_dir),
        "conflict proposal",
        MAX_PROPOSALS,
        diagnostics,
    ) {
        let valid = proposal.schema == SIDECAR_SCHEMA
            && stem == proposal.pair_id
            && validate_pair_id(&proposal.pair_id)
                .is_ok_and(|(a, b, _)| a == proposal.event_a && b == proposal.event_b);
        if !valid {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict proposal has an invalid schema or pair id".to_string(),
            });
            continue;
        }
        if !event_ids.contains(proposal.event_a.as_str())
            || !event_ids.contains(proposal.event_b.as_str())
        {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict proposal refers to a timeline event that does not exist"
                    .to_string(),
            });
            continue;
        }
        proposal_ids.insert(proposal.pair_id.clone());
        proposals.push(proposal);
    }
    proposals.sort_by(|left, right| left.pair_id.cmp(&right.pair_id));

    let mut reviews: HashMap<String, Vec<ReviewFile>> = HashMap::new();
    for (review, stem, display) in read_sidecars::<ReviewFile>(
        project_dir,
        reviews_dir(project_dir),
        "conflict review",
        MAX_REVIEWS,
        diagnostics,
    ) {
        if review.schema != SIDECAR_SCHEMA
            || stem != review.id
            || !validate_sidecar_id(&review.id, "cr-")
        {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict review has an invalid schema or id".to_string(),
            });
            continue;
        }
        if !proposal_ids.contains(&review.pair_id) {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict review refers to a pair without a proposal".to_string(),
            });
            continue;
        }
        reviews
            .entry(review.pair_id.clone())
            .or_default()
            .push(review);
    }
    for list in reviews.values_mut() {
        list.sort_by(|left, right| {
            left.reviewed_at
                .cmp(&right.reviewed_at)
                .then(left.id.cmp(&right.id))
        });
    }

    let mut scans = Vec::new();
    for (scan, stem, display) in read_sidecars::<ScanFile>(
        project_dir,
        scans_dir(project_dir),
        "conflict scan",
        MAX_SCANS,
        diagnostics,
    ) {
        if scan.schema != SIDECAR_SCHEMA || stem != scan.id || !validate_sidecar_id(&scan.id, "cs-")
        {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict scan has an invalid schema or id".to_string(),
            });
            continue;
        }
        scans.push(scan);
    }
    scans.sort_by(|left, right| {
        left.completed_at
            .cmp(&right.completed_at)
            .then(left.id.cmp(&right.id))
    });
    LoadedSidecars {
        proposals,
        reviews,
        scans,
    }
}

fn pair_state(
    proposal: &ProposalFile,
    reviews: &[ReviewFile],
    by_id: &HashMap<&str, &TimelineEvent>,
    components: &Components,
) -> TimelineConflictState {
    let superseded = |id: &str| by_id.get(id).is_some_and(|event| event.superseded);
    if superseded(&proposal.event_a)
        || superseded(&proposal.event_b)
        || same_chain(components, &proposal.event_a, &proposal.event_b)
    {
        return TimelineConflictState::Historical;
    }
    match reviews.last().map(|review| review.verdict) {
        None => TimelineConflictState::Unreviewed,
        Some(TimelineConflictVerdict::Confirmed) => TimelineConflictState::Confirmed,
        Some(TimelineConflictVerdict::Dismissed) => TimelineConflictState::Dismissed,
        Some(TimelineConflictVerdict::InsufficientEvidence) => {
            TimelineConflictState::InsufficientEvidence
        }
        Some(TimelineConflictVerdict::Resolved) => TimelineConflictState::Resolved,
    }
}

fn scan_summary(scans: &[ScanFile], enabled: bool) -> TimelineScanSummary {
    match scans.last() {
        None => TimelineScanSummary {
            enabled,
            state: TimelineScanState::NeverRun,
            last_completed_at: None,
            checked_pairs: 0,
            skipped_pairs: 0,
            inconclusive_pairs: 0,
            reason: None,
        },
        Some(scan) => TimelineScanSummary {
            enabled,
            state: match scan.state {
                TimelineScanRunState::Completed => TimelineScanState::Completed,
                TimelineScanRunState::Partial => TimelineScanState::Partial,
            },
            last_completed_at: Some(scan.completed_at.clone()),
            checked_pairs: scan.checked_pairs,
            skipped_pairs: scan.skipped_pairs,
            inconclusive_pairs: scan.inconclusive_pairs,
            reason: scan.reason.clone(),
        },
    }
}

struct TraceContext {
    response: TimelineTraceResponse,
    components: Components,
    scans: Vec<ScanFile>,
}

fn build_trace_context(project_dir: &Path, scan_enabled: bool) -> Result<TraceContext, String> {
    let mut listing = scan_project(project_dir)?;
    let (chains, components) = build_chains(&listing.events, &mut listing.diagnostics);
    let event_ids: HashSet<&str> = listing
        .events
        .iter()
        .map(|event| event.id.as_str())
        .collect();
    let mut diagnostics = Vec::new();
    let sidecars = load_sidecars(project_dir, &event_ids, &mut diagnostics);
    let by_id: HashMap<&str, &TimelineEvent> = listing
        .events
        .iter()
        .map(|event| (event.id.as_str(), event))
        .collect();
    let mut counts = TimelineConflictCounts::default();
    let mut pairs = Vec::new();
    for proposal in &sidecars.proposals {
        if in_cycle(&components, &proposal.event_a) || in_cycle(&components, &proposal.event_b) {
            continue;
        }
        let reviews = sidecars
            .reviews
            .get(&proposal.pair_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let state = pair_state(proposal, reviews, &by_id, &components);
        if state.needs_review() {
            counts.needs_review += 1;
        } else if state == TimelineConflictState::Confirmed {
            counts.confirmed += 1;
        }
        pairs.push(TimelineConflictPair {
            pair_id: proposal.pair_id.clone(),
            event_a: proposal.event_a.clone(),
            event_b: proposal.event_b.clone(),
            state,
            origin: proposal.origin,
            basis: proposal.basis.clone(),
            suggested_at: proposal.suggested_at.clone(),
            model: proposal.model.clone(),
            probability: proposal.probability,
            reviews: reviews
                .iter()
                .map(|review| TimelineConflictReview {
                    id: review.id.clone(),
                    verdict: review.verdict,
                    rationale: review.rationale.clone(),
                    source_ref: review.source_ref.clone(),
                    resolution_event_id: review.resolution_event_id.clone(),
                    reviewed_by: review.reviewed_by.clone(),
                    reviewed_at: review.reviewed_at.clone(),
                })
                .collect(),
        });
    }
    listing.diagnostics.extend(diagnostics);
    let scan = scan_summary(&sidecars.scans, scan_enabled);
    Ok(TraceContext {
        response: TimelineTraceResponse {
            listing,
            chains,
            conflict_pairs: pairs,
            conflict_counts: counts,
            scan,
        },
        components,
        scans: sidecars.scans,
    })
}

pub(crate) fn trace_project(
    project_dir: &Path,
    scan_enabled: bool,
) -> Result<TimelineTraceResponse, String> {
    build_trace_context(project_dir, scan_enabled).map(|context| context.response)
}

// ─── Writes ──────────────────────────────────────────────────────────

fn find_pair(
    project_dir: &Path,
    pair_id: &str,
    scan_enabled: bool,
) -> Result<TimelineConflictPair, String> {
    trace_project(project_dir, scan_enabled)?
        .conflict_pairs
        .into_iter()
        .find(|pair| pair.pair_id == pair_id)
        .ok_or_else(|| format!("timeline conflict pair is not available: {pair_id}"))
}

pub(crate) fn propose_project(
    project_dir: &Path,
    event_a: &str,
    event_b: &str,
    rationale: &str,
) -> Result<TimelineConflictPair, String> {
    let event_a = validate_event_id(event_a).map_err(|_| "eventA is not a valid event id")?;
    let event_b = validate_event_id(event_b).map_err(|_| "eventB is not a valid event id")?;
    if event_a == event_b {
        return Err("a conflict pair needs two different events".to_string());
    }
    let rationale = validate_rationale(rationale)?;
    let (event_a, event_b, pair_id) = canonical_pair(&event_a, &event_b);
    {
        let _guard = TIMELINE_MUTATION_LOCK
            .lock()
            .map_err(|_| "timeline lock is unavailable".to_string())?;
        let listing = scan_project(project_dir)?;
        for id in [&event_a, &event_b] {
            if !listing.events.iter().any(|event| &event.id == id) {
                return Err(format!(
                    "timeline event does not exist in this project: {id}"
                ));
            }
        }
        let (_, root) =
            writable_confined_root(project_dir, proposals_dir(project_dir), "conflict proposal")?;
        let proposal = ProposalFile {
            schema: SIDECAR_SCHEMA,
            pair_id: pair_id.clone(),
            event_a,
            event_b,
            origin: TimelineConflictOrigin::Manual,
            suggested_at: now_millis(),
            model: None,
            probability: None,
            input_hash: None,
            basis: rationale,
        };
        if !write_new_json(&root.join(format!("{pair_id}.json")), &proposal)? {
            return Err(format!("this pair was already proposed: {pair_id}"));
        }
    }
    find_pair(project_dir, &pair_id, false)
}

pub(crate) fn review_project(
    project_dir: &Path,
    pair_id: &str,
    verdict: TimelineConflictVerdict,
    rationale: &str,
    source_ref: Option<String>,
    resolution_event_id: Option<String>,
) -> Result<TimelineConflictPair, String> {
    let (_, _, pair_id) = validate_pair_id(pair_id)?;
    let rationale = validate_rationale(rationale)?;
    let source_ref = validate_optional_single_line("sourceRef", source_ref, MAX_SOURCE_CHARS)?;
    let resolution_event_id = match resolution_event_id.map(|id| id.trim().to_string()) {
        Some(id) if !id.is_empty() => {
            Some(validate_event_id(&id).map_err(|_| "resolutionEventId is not a valid event id")?)
        }
        _ => None,
    };
    if verdict == TimelineConflictVerdict::Resolved
        && source_ref.is_none()
        && resolution_event_id.is_none()
    {
        return Err(
            "resolved needs the event that ended the conflict or a source reference".to_string(),
        );
    }
    {
        let _guard = TIMELINE_MUTATION_LOCK
            .lock()
            .map_err(|_| "timeline lock is unavailable".to_string())?;
        let context = build_trace_context(project_dir, false)?;
        if !context
            .response
            .conflict_pairs
            .iter()
            .any(|pair| pair.pair_id == pair_id)
        {
            return Err(format!("no proposal exists for this pair: {pair_id}"));
        }
        if let Some(id) = &resolution_event_id {
            if !context
                .response
                .listing
                .events
                .iter()
                .any(|event| &event.id == id)
            {
                return Err(format!(
                    "timeline event does not exist in this project: {id}"
                ));
            }
        }
        let (_, root) =
            writable_confined_root(project_dir, reviews_dir(project_dir), "conflict review")?;
        let mut written = false;
        for _ in 0..10 {
            let review = ReviewFile {
                schema: SIDECAR_SCHEMA,
                id: new_sidecar_id("cr-")?,
                pair_id: pair_id.clone(),
                verdict,
                rationale: rationale.clone(),
                source_ref: source_ref.clone(),
                resolution_event_id: resolution_event_id.clone(),
                reviewed_at: now_millis(),
                reviewed_by: LOCAL_REVIEWER.to_string(),
            };
            if write_new_json(&root.join(format!("{}.json", review.id)), &review)? {
                written = true;
                break;
            }
        }
        if !written {
            return Err("failed to allocate a unique conflict review id".to_string());
        }
    }
    find_pair(project_dir, &pair_id, false)
}

// ─── Scan shortlist ──────────────────────────────────────────────────

fn keywords(event: &TimelineEvent) -> HashSet<String> {
    format!("{} {}", event.topic_title, event.summary)
        .to_lowercase()
        .split(|ch: char| ch.is_whitespace() || ch.is_ascii_punctuation())
        .filter(|token| token.chars().count() >= MIN_KEYWORD_CHARS)
        .map(str::to_string)
        .collect()
}

fn truncate(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn scan_side(event: &TimelineEvent) -> TimelineConflictSide {
    TimelineConflictSide {
        id: event.id.clone(),
        topic: truncate(&event.topic_title, MAX_SCAN_TOPIC_CHARS),
        summary: truncate(&event.summary, MAX_SCAN_SUMMARY_CHARS),
    }
}

fn input_hash(candidate: &TimelineConflictCandidate) -> String {
    let mut hasher = Sha256::new();
    for side in [&candidate.a, &candidate.b] {
        for part in [&side.id, &side.topic, &side.summary] {
            hasher.update(part.as_bytes());
            hasher.update([0]);
        }
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Deterministic shortlist: same-topic pairs first, then cross-topic pairs that
/// share a `source_ref`, then cross-topic pairs that share a keyword; newest
/// first inside each group, pair ID as the tie-break. Cross-topic pairs with
/// neither signal are never considered, which the UI discloses.
fn shortlist(context: &TraceContext) -> Vec<TimelineConflictCandidate> {
    let events: Vec<&TimelineEvent> = context
        .response
        .listing
        .events
        .iter()
        .filter(|event| !event.superseded && !in_cycle(&context.components, &event.id))
        .collect();
    let proposed: HashSet<&str> = context
        .response
        .conflict_pairs
        .iter()
        .map(|pair| pair.pair_id.as_str())
        .collect();
    let already_checked: HashSet<(&str, &str)> = context
        .scans
        .iter()
        .flat_map(|scan| scan.checked.iter())
        .map(|check| (check.pair_id.as_str(), check.input_hash.as_str()))
        .collect();
    let tokens: Vec<HashSet<String>> = events.iter().map(|event| keywords(event)).collect();
    let mut ranked: Vec<(u8, String, TimelineConflictCandidate)> = Vec::new();
    for left in 0..events.len() {
        for right in left + 1..events.len() {
            let (a, b) = (events[left], events[right]);
            let group = if a.topic_id == b.topic_id {
                0
            } else if a.source_ref.is_some() && a.source_ref == b.source_ref {
                1
            } else if !tokens[left].is_disjoint(&tokens[right]) {
                2
            } else {
                continue;
            };
            if same_chain(&context.components, &a.id, &b.id)
                || (normalized_text(&a.summary) == normalized_text(&b.summary)
                    && a.source_ref == b.source_ref)
            {
                continue;
            }
            let (first, second) = if a.id <= b.id { (a, b) } else { (b, a) };
            let (_, _, pair_id) = canonical_pair(&first.id, &second.id);
            if proposed.contains(pair_id.as_str()) {
                continue;
            }
            let candidate = TimelineConflictCandidate {
                pair_id,
                a: scan_side(first),
                b: scan_side(second),
            };
            if already_checked
                .contains(&(candidate.pair_id.as_str(), input_hash(&candidate).as_str()))
            {
                continue;
            }
            let newest = a.occurred_at.clone().max(b.occurred_at.clone());
            ranked.push((group, newest, candidate));
        }
    }
    ranked.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(right.1.cmp(&left.1))
            .then(left.2.pair_id.cmp(&right.2.pair_id))
    });
    ranked
        .into_iter()
        .map(|(_, _, candidate)| candidate)
        .collect()
}

fn failure_reason(reason: TimelineTopicFallbackReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unavailable".to_string())
}

/// Persist one scan: proposals for pairs that passed the gate plus a scan
/// record of every checked pair, so a reload never changes what "scanned"
/// meant and unchanged pairs are not re-sent next time.
fn persist_scan(
    project_dir: &Path,
    candidates: &[TimelineConflictCandidate],
    skipped_beyond_limit: usize,
    classification: &crate::typesafe::TimelineConflictClassification,
) -> Result<TimelineConflictScan, String> {
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline lock is unavailable".to_string())?;
    let by_pair: HashMap<&str, &TimelineConflictCandidate> = candidates
        .iter()
        .map(|candidate| (candidate.pair_id.as_str(), candidate))
        .collect();
    let completed_at = now_millis();
    let mut checked = Vec::new();
    let mut proposed = 0_u32;
    let mut inconclusive = 0_u32;
    for judgement in &classification.judgements {
        let Some(candidate) = by_pair.get(judgement.pair_id.as_str()) else {
            continue;
        };
        let hash = input_hash(candidate);
        match judgement.outcome {
            TimelineConflictOutcome::PossibleConflict => {
                let (_, root) = writable_confined_root(
                    project_dir,
                    proposals_dir(project_dir),
                    "conflict proposal",
                )?;
                let proposal = ProposalFile {
                    schema: SIDECAR_SCHEMA,
                    pair_id: candidate.pair_id.clone(),
                    event_a: candidate.a.id.clone(),
                    event_b: candidate.b.id.clone(),
                    origin: TimelineConflictOrigin::Typesafe,
                    suggested_at: completed_at.clone(),
                    model: Some(classification.model.clone()),
                    probability: judgement.probability,
                    input_hash: Some(hash.clone()),
                    basis: TYPESAFE_BASIS.to_string(),
                };
                if write_new_json(&root.join(format!("{}.json", candidate.pair_id)), &proposal)? {
                    proposed += 1;
                }
            }
            TimelineConflictOutcome::Inconclusive
            | TimelineConflictOutcome::InsufficientEvidence => inconclusive += 1,
            _ => {}
        }
        // Invalid answers are not recorded as checked, so the pair is retried.
        if judgement.outcome != TimelineConflictOutcome::InvalidResponse {
            checked.push(ScanCheck {
                pair_id: candidate.pair_id.clone(),
                input_hash: hash,
                outcome: judgement.outcome,
            });
        }
    }
    let unchecked = candidates.len().saturating_sub(checked.len());
    let skipped = (skipped_beyond_limit + unchecked) as u32;
    let state = if skipped == 0 && classification.failure.is_none() {
        TimelineScanRunState::Completed
    } else {
        TimelineScanRunState::Partial
    };
    let reason = classification
        .failure
        .map(failure_reason)
        .or_else(|| (skipped_beyond_limit > 0).then(|| format!("limit_{MAX_SCAN_PAIRS}_pairs")));
    let (project, root) =
        writable_confined_root(project_dir, scans_dir(project_dir), "conflict scan")?;
    let scan = ScanFile {
        schema: SIDECAR_SCHEMA,
        id: new_sidecar_id("cs-")?,
        model: classification.model.clone(),
        completed_at,
        state,
        checked_pairs: checked.len() as u32,
        skipped_pairs: skipped,
        proposed_pairs: proposed,
        inconclusive_pairs: inconclusive,
        reason: reason.clone(),
        checked,
    };
    let path = root.join(format!("{}.json", scan.id));
    if !write_new_json(&path, &scan)? {
        return Err("failed to allocate a unique conflict scan id".to_string());
    }
    Ok(TimelineConflictScan {
        state,
        checked_pairs: scan.checked_pairs,
        skipped_pairs: scan.skipped_pairs,
        proposed_pairs: proposed,
        inconclusive_pairs: inconclusive,
        reason,
        path: Some(relative_path(&project, &path)),
    })
}

// ─── Tauri commands (app only — deliberately not MCP tools) ─────────

fn scan_enabled(
    config: &tauri::State<'_, Arc<std::sync::RwLock<crate::config::KryptonConfig>>>,
) -> bool {
    config
        .read()
        .map(|config| config.typesafe.timeline_conflict_scan_enabled())
        .unwrap_or(false)
}

#[tauri::command]
pub fn timeline_conflict_list(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
    config: tauri::State<'_, Arc<std::sync::RwLock<crate::config::KryptonConfig>>>,
) -> Result<TimelineTraceResponse, String> {
    trace_project(
        &project_dir(&hook_server, &harness_id)?,
        scan_enabled(&config),
    )
}

#[tauri::command]
pub fn timeline_conflict_propose(
    harness_id: String,
    event_a: String,
    event_b: String,
    rationale: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineConflictPair, String> {
    propose_project(
        &project_dir(&hook_server, &harness_id)?,
        &event_a,
        &event_b,
        &rationale,
    )
}

#[tauri::command]
pub fn timeline_conflict_review(
    harness_id: String,
    pair_id: String,
    verdict: TimelineConflictVerdict,
    rationale: String,
    source_ref: Option<String>,
    resolution_event_id: Option<String>,
    hook_server: tauri::State<'_, Arc<HookServer>>,
) -> Result<TimelineConflictPair, String> {
    review_project(
        &project_dir(&hook_server, &harness_id)?,
        &pair_id,
        verdict,
        &rationale,
        source_ref,
        resolution_event_id,
    )
}

#[tauri::command]
pub async fn timeline_conflict_scan(
    harness_id: String,
    hook_server: tauri::State<'_, Arc<HookServer>>,
    config: tauri::State<'_, Arc<std::sync::RwLock<crate::config::KryptonConfig>>>,
    typesafe: tauri::State<'_, Arc<TypeSafeState>>,
) -> Result<TimelineConflictScan, String> {
    let project = project_dir(&hook_server, &harness_id)?;
    let typesafe_config = config
        .read()
        .map_err(|_| "config lock is unavailable".to_string())?
        .typesafe
        .clone();
    if !typesafe_config.timeline_conflict_scan_enabled() {
        return Err(
            "conflict scan is off: set [typesafe] enabled = true and [typesafe.timeline_conflicts] mode = \"suggest\""
                .to_string(),
        );
    }
    let context = build_trace_context(&project, true)?;
    let mut candidates = shortlist(&context);
    let beyond_limit = candidates.len().saturating_sub(MAX_SCAN_PAIRS);
    candidates.truncate(MAX_SCAN_PAIRS);
    let classification = typesafe
        .classify_timeline_conflicts(typesafe_config, candidates.clone())
        .await?;
    persist_scan(&project, &candidates, beyond_limit, &classification)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{record_project, TimelineRecordRequest};
    use crate::typesafe::{TimelineConflictClassification, TimelineConflictJudgement};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("krypton-timeline-conflict-{label}-{nonce}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record(
        dir: &Path,
        topic: &str,
        summary: &str,
        occurred_at: &str,
        supersedes: Option<&str>,
    ) -> TimelineEvent {
        record_project(
            dir,
            TimelineRecordRequest {
                topic_id: format!("topic-{topic}"),
                topic_title: topic.to_string(),
                summary: summary.to_string(),
                occurred_at: occurred_at.to_string(),
                made_by: "Release lead".to_string(),
                rationale: String::new(),
                impact: String::new(),
                source_ref: None,
                relation: supersedes.map(|_| TimelineRelation::Supersedes),
                related_event: supersedes.map(str::to_string),
                recorder_lane: "Claude-1".to_string(),
            },
        )
        .unwrap()
    }

    #[test]
    fn a_b_a_with_supersedes_is_one_history_chain() {
        let dir = TestDir::new("aba");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:00:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T10:00:00Z",
            Some(&a.id),
        );
        let c = record(
            &dir.0,
            "backup",
            "remove backup connection again",
            "2026-09-22T10:00:00Z",
            Some(&b.id),
        );
        let trace = trace_project(&dir.0, false).unwrap();
        assert_eq!(trace.chains.len(), 1);
        assert_eq!(
            trace.chains[0].event_ids,
            vec![a.id.clone(), b.id.clone(), c.id.clone()]
        );
        assert_eq!(trace.chains[0].links.len(), 2);
        assert_eq!(trace.conflict_counts, TimelineConflictCounts::default());
        assert_eq!(trace.scan.state, TimelineScanState::NeverRun);
    }

    #[test]
    fn branches_keep_every_link() {
        let dir = TestDir::new("branch");
        let a = record(&dir.0, "api", "use REST", "2026-09-20T10:00:00Z", None);
        record(
            &dir.0,
            "api",
            "use gRPC",
            "2026-09-21T10:00:00Z",
            Some(&a.id),
        );
        record(
            &dir.0,
            "api",
            "use GraphQL",
            "2026-09-21T11:00:00Z",
            Some(&a.id),
        );
        let trace = trace_project(&dir.0, false).unwrap();
        assert_eq!(trace.chains.len(), 1);
        assert_eq!(trace.chains[0].event_ids.len(), 3);
        assert_eq!(trace.chains[0].links.len(), 2);
    }

    #[test]
    fn cycle_is_a_diagnostic_and_not_summarised() {
        let dir = TestDir::new("cycle");
        let a = record(&dir.0, "loop", "first", "2026-09-20T10:00:00Z", None);
        let b = record(
            &dir.0,
            "loop",
            "second",
            "2026-09-21T10:00:00Z",
            Some(&a.id),
        );
        // Point `a` back at `b` by editing the file (records are append-only in
        // the app; this simulates a hand-edited or corrupted pair).
        let path = dir.0.join(&a.path);
        let source = fs::read_to_string(&path).unwrap();
        let patched = source.replacen(
            "---\n",
            &format!(
                "---\nrelation: \"supersedes\"\nrelated_event: \"{}\"\n",
                b.id
            ),
            1,
        );
        fs::write(&path, patched).unwrap();
        let trace = trace_project(&dir.0, false).unwrap();
        assert!(trace.chains.is_empty());
        assert!(trace
            .listing
            .diagnostics
            .iter()
            .any(|item| item.error.contains("cycle")));
    }

    #[test]
    fn manual_proposal_is_canonical_and_idempotent() {
        let dir = TestDir::new("propose");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        let pair = propose_project(&dir.0, &b.id, &a.id, "same subject, opposite call").unwrap();
        let (first, second) = if a.id < b.id {
            (&a.id, &b.id)
        } else {
            (&b.id, &a.id)
        };
        assert_eq!(pair.pair_id, format!("{first}--{second}"));
        assert_eq!(pair.state, TimelineConflictState::Unreviewed);
        assert_eq!(pair.origin, TimelineConflictOrigin::Manual);
        let again = propose_project(&dir.0, &a.id, &b.id, "again").unwrap_err();
        assert!(again.contains("already proposed"));
        assert!(propose_project(&dir.0, &a.id, &a.id, "self").is_err());
        assert!(propose_project(&dir.0, &a.id, "tl-missing", "gone").is_err());
        let trace = trace_project(&dir.0, false).unwrap();
        assert_eq!(trace.conflict_counts.needs_review, 1);
    }

    #[test]
    fn reviews_are_append_only_and_latest_wins() {
        let dir = TestDir::new("review");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        let pair = propose_project(&dir.0, &a.id, &b.id, "opposite call").unwrap();
        let confirmed = review_project(
            &dir.0,
            &pair.pair_id,
            TimelineConflictVerdict::Confirmed,
            "both still stand",
            None,
            None,
        )
        .unwrap();
        assert_eq!(confirmed.state, TimelineConflictState::Confirmed);
        assert_eq!(confirmed.reviews[0].reviewed_by, "Local user");
        assert!(review_project(
            &dir.0,
            &pair.pair_id,
            TimelineConflictVerdict::Resolved,
            "fixed",
            None,
            None
        )
        .unwrap_err()
        .contains("resolved needs"));
        let resolved = review_project(
            &dir.0,
            &pair.pair_id,
            TimelineConflictVerdict::Resolved,
            "release lead decided",
            Some("PLAN-03".to_string()),
            None,
        )
        .unwrap();
        assert_eq!(resolved.state, TimelineConflictState::Resolved);
        assert_eq!(resolved.reviews.len(), 2);
        assert_eq!(fs::read_dir(reviews_dir(&dir.0)).unwrap().count(), 2);
        assert!(review_project(
            &dir.0,
            &format!("{}--tl-zzz", a.id),
            TimelineConflictVerdict::Dismissed,
            "no proposal",
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn later_supersedes_turns_pair_historical() {
        let dir = TestDir::new("historical");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        let pair = propose_project(&dir.0, &a.id, &b.id, "opposite call").unwrap();
        review_project(
            &dir.0,
            &pair.pair_id,
            TimelineConflictVerdict::Confirmed,
            "yes",
            None,
            None,
        )
        .unwrap();
        record(
            &dir.0,
            "backup",
            "keep backup connection, final",
            "2026-09-22T09:00:00Z",
            Some(&a.id),
        );
        let trace = trace_project(&dir.0, false).unwrap();
        let pair = &trace.conflict_pairs[0];
        assert_eq!(pair.state, TimelineConflictState::Historical);
        assert_eq!(pair.reviews.len(), 1);
        assert_eq!(trace.conflict_counts.confirmed, 0);
    }

    #[test]
    fn cross_topic_pair_survives_topic_rename() {
        let dir = TestDir::new("cross-topic");
        let a = record(
            &dir.0,
            "database",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "release",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        let pair = propose_project(&dir.0, &a.id, &b.id, "cross topic").unwrap();
        crate::timeline::merge_topics_project(&dir.0, &a.topic_id, &b.topic_id, None).unwrap();
        let trace = trace_project(&dir.0, false).unwrap();
        assert_eq!(trace.conflict_pairs.len(), 1);
        assert_eq!(trace.conflict_pairs[0].pair_id, pair.pair_id);
        assert_eq!(trace.conflict_counts.needs_review, 1);
    }

    #[test]
    fn malformed_and_orphan_sidecars_are_diagnostics() {
        let dir = TestDir::new("malformed");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let root = proposals_dir(&dir.0);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("garbage.json"), "{not json").unwrap();
        let (x, y, orphan) = canonical_pair(&a.id, "tl-20260101T000000Z-aaaaaa");
        fs::write(
            root.join(format!("{orphan}.json")),
            serde_json::to_vec(&ProposalFile {
                schema: 1,
                pair_id: orphan.clone(),
                event_a: x,
                event_b: y,
                origin: TimelineConflictOrigin::Manual,
                suggested_at: now_millis(),
                model: None,
                probability: None,
                input_hash: None,
                basis: "orphan".to_string(),
            })
            .unwrap(),
        )
        .unwrap();
        let trace = trace_project(&dir.0, false).unwrap();
        assert!(trace.conflict_pairs.is_empty());
        assert_eq!(trace.listing.diagnostics.len(), 2);
    }

    #[test]
    fn shortlist_orders_groups_and_skips_linked_duplicate_and_proposed_pairs() {
        let dir = TestDir::new("shortlist");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        let c = record(
            &dir.0,
            "release",
            "connection pool size stays at 10",
            "2026-09-22T09:00:00Z",
            None,
        );
        let d = record(
            &dir.0,
            "release",
            "ship on Friday",
            "2026-09-23T09:00:00Z",
            None,
        );
        record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-23T10:00:00Z",
            Some(&b.id),
        );
        let context = build_trace_context(&dir.0, true).unwrap();
        let ids: Vec<String> = shortlist(&context).into_iter().map(|c| c.pair_id).collect();
        // b is superseded; the duplicate replacement is linked to b.
        assert!(!ids.iter().any(|id| id.contains(&b.id)));
        let same_topic = canonical_pair(&c.id, &d.id).2;
        let cross_keyword = canonical_pair(&a.id, &c.id).2;
        let same_idx = ids.iter().position(|id| *id == same_topic).unwrap();
        let cross_idx = ids.iter().position(|id| *id == cross_keyword).unwrap();
        assert!(same_idx < cross_idx);

        propose_project(&dir.0, &c.id, &d.id, "manual").unwrap();
        let context = build_trace_context(&dir.0, true).unwrap();
        assert!(!shortlist(&context).iter().any(|c| c.pair_id == same_topic));
    }

    #[test]
    fn scan_records_checked_pairs_and_marks_partial_on_failure() {
        let dir = TestDir::new("scan");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        record(
            &dir.0,
            "backup",
            "backup connection timeout 5s",
            "2026-09-22T10:00:00Z",
            None,
        );
        let context = build_trace_context(&dir.0, true).unwrap();
        let candidates = shortlist(&context);
        assert_eq!(candidates.len(), 3);
        let conflict_pair = canonical_pair(&a.id, &b.id).2;
        let classification = TimelineConflictClassification {
            model: "jev-test".to_string(),
            judgements: vec![TimelineConflictJudgement {
                pair_id: conflict_pair.clone(),
                outcome: TimelineConflictOutcome::PossibleConflict,
                probability: Some(0.9),
            }],
            failure: Some(TimelineTopicFallbackReason::Timeout),
        };
        let scan = persist_scan(&dir.0, &candidates, 0, &classification).unwrap();
        assert_eq!(scan.state, TimelineScanRunState::Partial);
        assert_eq!(scan.checked_pairs, 1);
        assert_eq!(scan.skipped_pairs, 2);
        assert_eq!(scan.proposed_pairs, 1);
        assert_eq!(scan.reason.as_deref(), Some("timeout"));

        let trace = trace_project(&dir.0, true).unwrap();
        assert_eq!(trace.scan.state, TimelineScanState::Partial);
        assert_eq!(
            trace.conflict_pairs[0].origin,
            TimelineConflictOrigin::Typesafe
        );
        assert_eq!(trace.conflict_pairs[0].pair_id, conflict_pair);
        // The proposed pair is not re-sent; the two unchecked pairs are.
        let context = build_trace_context(&dir.0, true).unwrap();
        assert_eq!(shortlist(&context).len(), 2);
    }

    #[test]
    fn pair_ids_reject_non_canonical_input() {
        assert!(validate_pair_id("tl-b--tl-a").is_err());
        assert!(validate_pair_id("tl-a--tl-a").is_err());
        assert!(validate_pair_id("nope").is_err());
        assert!(validate_pair_id("tl-a--tl-b").is_ok());
    }
}
